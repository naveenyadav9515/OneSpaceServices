/**
 * Guards the durability half of the sync design.
 *
 * The property under test is the one the whole architecture exists for: a
 * transaction is recorded even when every real-time mechanism fails. Pushes get
 * dropped, watches lapse, containers restart mid-run, Google rate-limits. None
 * of those may lose a transaction, because the reconciliation sweep re-reads the
 * retention window regardless and the ledger tells it what it has not seen.
 *
 * The engine is stubbed here — what matters is the queue and worker's decisions
 * around it, not the fetching, which `gmail-sync-quota.test.js` covers.
 */

const db = require('./setup');

jest.mock('../automation/engine', () => ({
  processUserEmails: jest.fn(),
}));

jest.mock('../automation/gmail/gmail-monitor', () => ({
  ...jest.requireActual('../automation/gmail/gmail-monitor'),
  createOAuth2Client: jest.fn(() => ({})),
  invalidateOAuth2Client: jest.fn(),
}));

const engine = require('../automation/engine');
const scheduler = require('../automation/gmail/sync-scheduler');
const { enqueueSync, leaseNextJob, completeJob, releaseJob } = require('../automation/gmail/sync-queue');
const GmailSyncJob = require('../models/GmailSyncJob');
const User = require('../models/User');

/** A clean engine result, overridable per test. */
const okStats = (overrides = {}) => ({
  ok: true, mode: 'incremental', remaining: 0, unexpectedNew: 0,
  processed: 0, created: 0, duplicates: 0, errors: 0,
  skipped: {}, fetchedEmails: [], ...overrides,
});

/** A failed engine result carrying a classified failure. */
const failStats = (failure) => ({
  ok: false, reason: failure.code, error: failure.message, failure,
  remaining: 0, processed: 0, created: 0, duplicates: 0, errors: 0,
  skipped: {}, fetchedEmails: [],
});

async function makeUser(overrides = {}) {
  return User.create({
    firstName: 'Test',
    lastName: 'User',
    email: `u${Math.random().toString(36).slice(2)}@example.com`,
    password: 'password123',
    gmailConnected: true,
    expenseAutomationEnabled: true,
    googleRefreshToken: 'encrypted-token',
    ...overrides,
  });
}

beforeAll(async () => { await db.connect(); });
afterEach(async () => { await db.clearDatabase(); jest.clearAllMocks(); });
afterAll(async () => { await db.closeDatabase(); });

describe('the queue coalesces work', () => {
  it('collapses a burst of pushes for one mailbox into a single job', async () => {
    // Gmail pushes for *any* inbox change. Before the queue, each one started a
    // competing scan of the same mailbox.
    const user = await makeUser();

    await Promise.all(Array.from({ length: 25 }, () => enqueueSync(user._id, { reason: 'push' })));

    expect(await GmailSyncJob.countDocuments({ user: user._id })).toBe(1);
  });

  it('lets a sweep upgrade a queued push, but not the reverse', async () => {
    // A sweep's full scan is the completeness guarantee. A push arriving
    // afterwards must not narrow it.
    const user = await makeUser();

    await enqueueSync(user._id, { full: false, reason: 'push' });
    await enqueueSync(user._id, { full: true, reason: 'sweep' });
    await enqueueSync(user._id, { full: false, reason: 'push' });

    const job = await GmailSyncJob.findOne({ user: user._id }).lean();
    expect(job.full).toBe(true);
  });

  it('takes the earliest due time of everything merged into it', async () => {
    const user = await makeUser();

    await enqueueSync(user._id, { delayMs: 10 * 60 * 1000, reason: 'sweep' });
    await enqueueSync(user._id, { delayMs: 0, reason: 'push' });

    const job = await GmailSyncJob.findOne({ user: user._id }).lean();
    expect(job.dueAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('the queue survives failure', () => {
  it('lets another worker reclaim a job abandoned mid-run', async () => {
    // What a container restart looks like: leased, then the process died.
    const user = await makeUser();
    await enqueueSync(user._id);

    const leased = await leaseNextJob();
    expect(leased).not.toBeNull();
    expect(await leaseNextJob()).toBeNull();

    await GmailSyncJob.updateOne(
      { _id: leased._id },
      { $set: { leasedAt: new Date(Date.now() - GmailSyncJob.LEASE_TTL_MS - 1000) } },
    );

    expect(await leaseNextJob()).not.toBeNull();
  });

  it('keeps a push that arrived while its own run was in flight', async () => {
    // The push may be announcing mail that landed after the query was issued.
    // Deleting the row on completion would discard the only record of it.
    const user = await makeUser();
    await enqueueSync(user._id);
    const leased = await leaseNextJob();

    await enqueueSync(user._id, { reason: 'push' });
    await completeJob(leased);

    const survivor = await GmailSyncJob.findOne({ user: user._id }).lean();
    expect(survivor).not.toBeNull();
    expect(survivor.leasedAt).toBeNull();
  });

  it('deletes the job when nothing new was requested during the run', async () => {
    const user = await makeUser();
    await enqueueSync(user._id);
    const leased = await leaseNextJob();

    await completeJob(leased);

    expect(await GmailSyncJob.countDocuments({ user: user._id })).toBe(0);
  });

  it('gives up on a job that keeps failing rather than retrying forever', async () => {
    const user = await makeUser();
    await enqueueSync(user._id);

    for (let i = 0; i < GmailSyncJob.MAX_ATTEMPTS; i++) {
      const job = await leaseNextJob();
      if (!job) break;
      await releaseJob(job, { error: 'boom' });
      await GmailSyncJob.updateOne({ _id: job._id }, { $set: { dueAt: new Date(0) } });
    }

    // Dropped — but not lost: the next sweep queues every connected account.
    expect(await GmailSyncJob.countDocuments({ user: user._id })).toBe(0);
  });

  it('does not spend the attempt budget on backlog slices', async () => {
    // A deferred slice is progress. Counting it as a failed attempt would drop
    // a long backlog halfway through draining it.
    const user = await makeUser();
    await enqueueSync(user._id);

    for (let i = 0; i < GmailSyncJob.MAX_ATTEMPTS + 3; i++) {
      const job = await leaseNextJob();
      expect(job).not.toBeNull();
      await releaseJob(job, { delayMs: 0 });
    }

    expect(await GmailSyncJob.countDocuments({ user: user._id })).toBe(1);
  });
});

describe('the worker', () => {
  it('drains a backlog by itself instead of waiting for a human', async () => {
    const user = await makeUser();
    await enqueueSync(user._id);

    engine.processUserEmails
      .mockResolvedValueOnce(okStats({ remaining: 40, created: 150 }))
      .mockResolvedValueOnce(okStats({ remaining: 0, created: 40 }));

    await scheduler.drainQueue();
    expect(await GmailSyncJob.countDocuments({ user: user._id })).toBe(1);

    await scheduler.drainQueue();
    expect(await GmailSyncJob.countDocuments({ user: user._id })).toBe(0);
    expect(engine.processUserEmails).toHaveBeenCalledTimes(2);
  });

  it('runs a swept job as a full scan and a pushed job as an incremental one', async () => {
    const swept = await makeUser();
    const pushed = await makeUser();
    engine.processUserEmails.mockResolvedValue(okStats());

    await enqueueSync(swept._id, { full: true, reason: 'sweep' });
    await scheduler.drainQueue();
    expect(engine.processUserEmails.mock.calls[0][1]).toMatchObject({ mode: 'full' });

    engine.processUserEmails.mockClear();
    await enqueueSync(pushed._id, { full: false, reason: 'push' });
    await scheduler.drainQueue();
    expect(engine.processUserEmails.mock.calls[0][1]).toMatchObject({ mode: 'incremental' });
  });

  it('parks a job for the length of a rate-limit cooldown instead of retrying into it', async () => {
    const user = await makeUser();
    await enqueueSync(user._id);

    engine.processUserEmails.mockResolvedValue(failStats({
      code: 'rate_limited',
      message: 'Google is rate-limiting requests right now.',
      fatal: false,
      retryable: true,
      retryAfterMs: 5 * 60 * 1000,
    }));

    await scheduler.drainQueue();

    const job = await GmailSyncJob.findOne({ user: user._id }).lean();
    expect(job.leasedAt).toBeNull();
    expect(job.dueAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60 * 1000);

    // And the cooldown deadline is on the user, so nothing else calls Google either.
    const fresh = await User.findById(user._id).lean();
    expect(fresh.gmailRetryAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses to run a job whose user is already cooling down', async () => {
    const user = await makeUser({ gmailRetryAfter: new Date(Date.now() + 3 * 60 * 1000) });
    await enqueueSync(user._id);

    await scheduler.drainQueue();

    expect(engine.processUserEmails).not.toHaveBeenCalled();
    const job = await GmailSyncJob.findOne({ user: user._id }).lean();
    expect(job.dueAt.getTime()).toBeGreaterThan(Date.now() + 2 * 60 * 1000);
  });

  it('disconnects only on a dead credential, and stops retrying it', async () => {
    const user = await makeUser();
    await enqueueSync(user._id);

    engine.processUserEmails.mockResolvedValue(failStats({
      code: 'auth_expired',
      message: 'Google access has expired or was revoked.',
      fatal: true,
      retryable: false,
      retryAfterMs: null,
    }));

    await scheduler.drainQueue();

    const fresh = await User.findById(user._id).lean();
    expect(fresh.gmailConnected).toBe(false);
    expect(await GmailSyncJob.countDocuments({ user: user._id })).toBe(0);
  });

  it('keeps a transient failure connected and queued', async () => {
    // A rate limit or a disabled API is not a revoked grant. Disconnecting on
    // those is what forced users into a reconnect loop.
    const user = await makeUser();
    await enqueueSync(user._id);

    engine.processUserEmails.mockResolvedValue(failStats({
      code: 'google_unavailable',
      message: 'Google returned a server error.',
      fatal: false,
      retryable: true,
      retryAfterMs: 30000,
    }));

    await scheduler.drainQueue();

    const fresh = await User.findById(user._id).lean();
    expect(fresh.gmailConnected).toBe(true);
    expect(await GmailSyncJob.countDocuments({ user: user._id })).toBe(1);
  });

  it('drops work for an account that was disconnected after queueing', async () => {
    const user = await makeUser({ gmailConnected: false });
    await enqueueSync(user._id);

    await scheduler.drainQueue();

    expect(engine.processUserEmails).not.toHaveBeenCalled();
    expect(await GmailSyncJob.countDocuments({ user: user._id })).toBe(0);
  });

  it('frees the job when the run throws, rather than stranding it', async () => {
    const user = await makeUser();
    await enqueueSync(user._id);
    engine.processUserEmails.mockRejectedValue(new Error('unexpected'));

    await scheduler.drainQueue();

    const job = await GmailSyncJob.findOne({ user: user._id }).lean();
    expect(job).not.toBeNull();
    expect(job.leasedAt).toBeNull();
  });

  it('runs no more than the configured number of mailboxes at once', async () => {
    const users = await Promise.all(Array.from({ length: 8 }, () => makeUser()));
    await Promise.all(users.map(u => enqueueSync(u._id)));
    engine.processUserEmails.mockResolvedValue(okStats());

    const ran = await scheduler.drainQueue();

    expect(ran).toBe(require('../config/index').gmailSync.workerConcurrency);
  });
});

describe('the reconciliation sweep', () => {
  it('queues a full scan for every connected account, push or no push', async () => {
    // This is the guarantee. It does not consult the watch, the watermark, or
    // whether a push ever arrived.
    const a = await makeUser();
    const b = await makeUser({ gmailLastPushAt: null });
    await makeUser({ expenseAutomationEnabled: false });
    await makeUser({ gmailConnected: false });

    const result = await scheduler.runSweep();

    expect(result.queued).toBe(2);
    const jobs = await GmailSyncJob.find({}).lean();
    expect(jobs).toHaveLength(2);
    expect(jobs.every(j => j.full)).toBe(true);
    expect(jobs.map(j => String(j.user)).sort())
      .toEqual([String(a._id), String(b._id)].sort());
  });

  it('recovers mail that arrived while the process was down', async () => {
    // No push was ever delivered — the container was not running to receive it.
    const user = await makeUser();
    engine.processUserEmails.mockResolvedValue(okStats({ mode: 'full', created: 2, unexpectedNew: 2 }));

    await scheduler.runSweep();
    await scheduler.drainQueue();

    expect(engine.processUserEmails).toHaveBeenCalledTimes(1);
    expect(engine.processUserEmails.mock.calls[0][1]).toMatchObject({ mode: 'full', reason: 'sweep' });
  });
});

describe('silent watch repair', () => {
  const dayAgo = () => new Date(Date.now() - 25 * 60 * 60 * 1000);

  it('re-registers a watch that has stopped delivering', async () => {
    const user = await makeUser({
      gmailLastSweepMissed: 3,
      gmailLastPushAt: dayAgo(),
    });

    const watchManager = require('../automation/gmail/gmail-watch-manager');
    const spy = jest.spyOn(watchManager, 'activateWatch').mockResolvedValue({});

    const repaired = await scheduler.repairSilentWatches();

    expect(repaired).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    const fresh = await User.findById(user._id).lean();
    expect(fresh.gmailWatchRepairedAt).not.toBeNull();
    spy.mockRestore();
  });

  it('leaves a healthy watch alone when the mailbox simply files mail elsewhere', async () => {
    // Missed mail with pushes still arriving means the watch works and just
    // cannot see those messages — re-registering it would change nothing.
    await makeUser({
      gmailLastSweepMissed: 3,
      gmailLastPushAt: new Date(Date.now() - 60 * 1000),
    });

    const watchManager = require('../automation/gmail/gmail-watch-manager');
    const spy = jest.spyOn(watchManager, 'activateWatch').mockResolvedValue({});

    expect(await scheduler.repairSilentWatches()).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not re-register more than once a day', async () => {
    await makeUser({
      gmailLastSweepMissed: 3,
      gmailLastPushAt: dayAgo(),
      gmailWatchRepairedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const watchManager = require('../automation/gmail/gmail-watch-manager');
    const spy = jest.spyOn(watchManager, 'activateWatch').mockResolvedValue({});

    expect(await scheduler.repairSilentWatches()).toBe(0);
    spy.mockRestore();
  });
});
