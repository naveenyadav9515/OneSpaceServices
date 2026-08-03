/**
 * Guards the Gmail quota fixes.
 *
 * The bug these cover: every sync re-downloaded every message in the lookback
 * window, and nothing serialised concurrent syncs or backed off after a 429. A
 * healthy account therefore rate-limited itself and the UI blamed Google.
 *
 * The Gmail transport is stubbed so the assertions are about *how many* calls
 * the engine makes, which is the thing that broke.
 */

const db = require('./setup');

jest.mock('../automation/gmail/gmail-monitor', () => {
  const actual = jest.requireActual('../automation/gmail/gmail-monitor');
  return {
    ...actual,
    createOAuth2Client: jest.fn(() => ({})),
    fetchEmailList: jest.fn(),
    fetchEmailContent: jest.fn(),
  };
});

const monitor = require('../automation/gmail/gmail-monitor');
const engine = require('../automation/engine');
const config = require('../config/index');
const User = require('../models/User');
const GmailSyncedMessage = require('../models/GmailSyncedMessage');
const PendingTransaction = require('../models/PendingTransaction');
const GmailSyncJob = require('../models/GmailSyncJob');
const { classifyGoogleError } = require('../utils/google-error.util');

/**
 * A debit alert the Axis parser recognises.
 * The body carries no date, so the parser falls back to Gmail's `internalDate` —
 * which keeps every fixture inside the sync window no matter when the suite runs.
 */
const debitAlert = (id, amount) => ({
  subject: `Debit alert! INR ${amount} debited`,
  from: 'Axis Bank <alerts@axis.bank.in>',
  body: `INR ${amount} has been debited from A/c no. XX1234 at STARBUCKS.`,
  metadata: { id, internalDate: String(Date.now()) },
});

/** Mail from the same sender that will never become a transaction. */
const promo = (id) => ({
  subject: 'Your monthly account statement is ready',
  from: 'Axis Bank <alerts@axis.bank.in>',
  body: 'Please find your statement attached.',
  metadata: { id, internalDate: String(Date.now()) },
});

/** Wires the stubbed transport to return `messages` and serve their content. */
function serveMailbox(messages) {
  monitor.fetchEmailList.mockResolvedValue(messages.map(m => ({ id: m.metadata.id })));
  monitor.fetchEmailContent.mockImplementation(async (_gmail, id) => {
    const found = messages.find(m => m.metadata.id === id);
    if (!found) throw new Error(`unexpected fetch for ${id}`);
    return found;
  });
}

/** Message IDs the engine actually downloaded, in call order. */
const fetchedIds = () => monitor.fetchEmailContent.mock.calls.map(([, id]) => id);

/** The query string the engine handed to `messages.list` on its last run. */
const lastQuery = () => monitor.fetchEmailList.mock.calls.at(-1)?.[1];

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

describe('Gmail quota consumption', () => {
  it('downloads each message once, no matter how many times sync runs', async () => {
    const user = await makeUser();
    serveMailbox([debitAlert('m1', 500), promo('m2'), debitAlert('m3', 250)]);

    const first = await engine.processUserEmails(user);
    expect(first.ok).toBe(true);
    expect(first.created).toBe(2);
    expect(monitor.fetchEmailContent).toHaveBeenCalledTimes(3);

    // The mailbox is unchanged. The old engine re-fetched all three, every time.
    monitor.fetchEmailContent.mockClear();
    const second = await engine.processUserEmails(user);

    expect(monitor.fetchEmailContent).not.toHaveBeenCalled();
    expect(second.ok).toBe(true);
    expect(second.created).toBe(0);
    expect(second.skipped.alreadySynced).toBe(3);
  });

  it('still downloads genuinely new mail after a previous sync', async () => {
    const user = await makeUser();
    serveMailbox([debitAlert('m1', 500)]);
    await engine.processUserEmails(user);

    monitor.fetchEmailContent.mockClear();
    serveMailbox([debitAlert('m1', 500), debitAlert('m2', 900)]);
    const result = await engine.processUserEmails(user);

    expect(monitor.fetchEmailContent).toHaveBeenCalledTimes(1);
    expect(fetchedIds()).toEqual(['m2']);
    expect(result.created).toBe(1);
  });

  it('remembers messages that produced nothing, so they are not re-fetched', async () => {
    // These are the expensive ones: they leave no PendingTransaction, so before
    // the ledger existed they were downloaded in full on every single sync.
    const user = await makeUser();
    serveMailbox([promo('p1'), promo('p2')]);

    await engine.processUserEmails(user);
    expect(await PendingTransaction.countDocuments({ user: user._id })).toBe(0);
    expect(await GmailSyncedMessage.countDocuments({ user: user._id })).toBe(2);

    monitor.fetchEmailContent.mockClear();
    await engine.processUserEmails(user);
    expect(monitor.fetchEmailContent).not.toHaveBeenCalled();
  });

  it('rebuilds skip state from existing transactions, without a ledger entry', async () => {
    // Covers the first sync after deploy: the ledger is empty but the mail was
    // already recorded, and re-downloading all of it is what triggers the 429.
    const user = await makeUser();
    await PendingTransaction.create({
      user: user._id, amount: 500, merchant: 'STARBUCKS',
      gmailMessageId: 'm1', source: 'gmail_auto', date: new Date(),
    });
    serveMailbox([debitAlert('m1', 500)]);

    const result = await engine.processUserEmails(user);

    expect(monitor.fetchEmailContent).not.toHaveBeenCalled();
    expect(result.skipped.alreadySynced).toBe(1);
  });

  it('records the ledger even when the sync aborts mid-walk', async () => {
    const user = await makeUser();
    monitor.fetchEmailList.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
    monitor.fetchEmailContent
      .mockResolvedValueOnce(debitAlert('m1', 500))
      .mockRejectedValueOnce(Object.assign(new Error('Too many requests'), {
        response: { status: 429, data: { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } } },
      }));

    const result = await engine.processUserEmails(user);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('rate_limited');
    // m1 was paid for before the abort — losing that costs a re-download on the
    // retry, against the very quota that just ran out.
    const ledger = await GmailSyncedMessage.find({ user: user._id }).lean();
    expect(ledger.map(d => d.messageId)).toEqual(['m1']);
  });
});

describe('sync window', () => {
  it('looks back exactly the configured number of days', () => {
    const cutoff = monitor.getSyncCutoffDate();
    const days = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);

    expect(config.gmailSync.lookbackDays).toBe(7);
    expect(days).toBeCloseTo(7, 2);
  });

  it('is the same width every day of the month', () => {
    // The previous rule took the earlier of "start of last month in IST" and a
    // configured lookback, so the window silently swung between ~30 and ~62 days
    // depending on the date. A flat window cannot do that.
    const widths = [
      new Date('2026-08-01T04:00:00Z'),
      new Date('2026-08-31T23:00:00Z'),
      new Date('2027-01-01T00:30:00Z'),
    ].map(now => {
      jest.useFakeTimers().setSystemTime(now);
      const width = (Date.now() - monitor.getSyncCutoffDate().getTime()) / 86400000;
      jest.useRealTimers();
      return Math.round(width);
    });

    expect(widths).toEqual([7, 7, 7]);
  });
});

describe('query modes', () => {
  it('scans the whole window on a full run', async () => {
    const user = await makeUser();
    serveMailbox([]);

    await engine.processUserEmails(user, { mode: 'full' });

    // Day-granular on purpose: this is the query the completeness guarantee
    // rests on, so it uses only syntax already proven in production.
    expect(lastQuery()).toMatch(/^after:\d{4}\/\d{2}\/\d{2} from:alerts@axis\.bank\.in$/);
  });

  it('scans only since the watermark on an incremental run', async () => {
    const watermark = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const user = await makeUser({ gmailSyncWatermark: watermark });
    serveMailbox([]);

    await engine.processUserEmails(user, { mode: 'incremental' });

    const seconds = Number(lastQuery().match(/^after:(\d+) /)[1]);
    expect(seconds).toBe(Math.floor(watermark.getTime() / 1000));
  });

  it('widens to a full scan when there is no watermark to start from', async () => {
    // A first sync has nothing to be incremental about. Guessing a start point
    // would open a gap; widening cannot.
    const user = await makeUser({ gmailSyncWatermark: null });
    serveMailbox([]);

    const result = await engine.processUserEmails(user, { mode: 'incremental' });

    expect(result.mode).toBe('full');
    expect(lastQuery()).toMatch(/^after:\d{4}\/\d{2}\/\d{2} /);
  });

  it('never reaches back past the retention window', async () => {
    // A watermark older than the cutoff would otherwise widen the incremental
    // query beyond the window the product actually supports.
    const user = await makeUser({ gmailSyncWatermark: new Date(Date.now() - 90 * 86400000) });
    serveMailbox([]);

    await engine.processUserEmails(user, { mode: 'incremental' });

    const seconds = Number(lastQuery().match(/^after:(\d+) /)[1]);
    const cutoffSeconds = Math.floor(monitor.getSyncCutoffDate().getTime() / 1000);
    expect(seconds).toBeGreaterThanOrEqual(cutoffSeconds - 2);
  });
});

describe('watermark', () => {
  it('advances behind the run start, not to it', async () => {
    // Gmail filters on when Google received the mail, not on when we heard about
    // it. A watermark set to "now" drops anything whose delivery lagged.
    const user = await makeUser();
    serveMailbox([debitAlert('m1', 500)]);

    const before = Date.now();
    await engine.processUserEmails(user, { mode: 'full' });

    const { gmailSyncWatermark } = await User.findById(user._id).lean();
    const overlapMs = config.gmailSync.overlapMinutes * 60 * 1000;

    expect(gmailSyncWatermark).not.toBeNull();
    expect(gmailSyncWatermark.getTime()).toBeLessThanOrEqual(before - overlapMs + 1000);
    expect(gmailSyncWatermark.getTime()).toBeGreaterThan(before - overlapMs - 60000);
  });

  it('does not advance past messages the run deferred', async () => {
    // Deferred messages are not in the ledger yet. Moving the watermark past
    // them would put them behind every future incremental query.
    const many = Array.from({ length: 5 }, (_, i) => debitAlert(`m${i}`, 100 + i));
    const user = await makeUser();
    serveMailbox(many);

    const realCap = config.gmailSync.maxFetchesPerRun;
    config.gmailSync.maxFetchesPerRun = 2;
    let result;
    try {
      result = await engine.processUserEmails(user, { mode: 'full' });
    } finally {
      config.gmailSync.maxFetchesPerRun = realCap;
    }

    expect(result.remaining).toBe(3);
    const { gmailSyncWatermark } = await User.findById(user._id).lean();
    expect(gmailSyncWatermark).toBeNull();
  });

  it('does not advance when a message errored', async () => {
    const user = await makeUser();
    monitor.fetchEmailList.mockResolvedValue([{ id: 'm1' }]);
    // A non-Google failure: counted as an error, but not grounds to abort.
    monitor.fetchEmailContent.mockRejectedValue(new Error('malformed payload'));

    const result = await engine.processUserEmails(user, { mode: 'full' });

    expect(result.errors).toBe(1);
    const { gmailSyncWatermark } = await User.findById(user._id).lean();
    expect(gmailSyncWatermark).toBeNull();
  });
});

describe('miss detection', () => {
  /**
   * Re-reads the user the way every real caller does — the worker, the sync
   * endpoint and the connect flow all load a fresh document per run, so the
   * watermark written by the previous sync is visible to the next one.
   */
  const reload = (user) => User.findById(user._id).select('+googleRefreshToken');

  it('stays silent on a first sync, which cannot have missed anything', async () => {
    const user = await makeUser();
    serveMailbox([debitAlert('m1', 500), debitAlert('m2', 900)]);

    const first = await engine.processUserEmails(user, { mode: 'full', reason: 'sweep' });

    expect(first.created).toBe(2);
    expect(first.unexpectedNew).toBe(0);
  });

  it('reports zero when the push path has kept up', async () => {
    const user = await makeUser();
    serveMailbox([debitAlert('m1', 500)]);
    await engine.processUserEmails(user, { mode: 'full' });

    // Second sweep: same mailbox, everything already resolved.
    const sweep = await engine.processUserEmails(await reload(user), { mode: 'full', reason: 'sweep' });

    expect(sweep.unexpectedNew).toBe(0);
    const fresh = await User.findById(user._id).lean();
    expect(fresh.gmailLastSweepMissed).toBe(0);
    expect(fresh.gmailLastSweepAt).not.toBeNull();
  });

  it('counts what the sweep had to pick up itself', async () => {
    // Stands in for a dropped push, a lapsed watch, or downtime: mail arrived
    // and nothing real-time recorded it.
    const user = await makeUser();
    serveMailbox([debitAlert('m1', 500)]);
    await engine.processUserEmails(user, { mode: 'full' });

    serveMailbox([debitAlert('m1', 500), debitAlert('m2', 900)]);
    const sweep = await engine.processUserEmails(await reload(user), { mode: 'full', reason: 'sweep' });

    expect(sweep.unexpectedNew).toBe(1);
    expect(sweep.created).toBe(1);
    const fresh = await User.findById(user._id).lean();
    expect(fresh.gmailLastSweepMissed).toBe(1);
  });
});

describe('concurrency and backoff', () => {
  it('joins concurrent syncs for one user instead of racing them', async () => {
    const user = await makeUser();
    serveMailbox([debitAlert('m1', 500), debitAlert('m2', 700)]);

    const [a, b, c] = await Promise.all([
      engine.processUserEmails(user),
      engine.processUserEmails(user),
      engine.processUserEmails(user),
    ]);

    // One sync's worth of Gmail calls, not three.
    expect(monitor.fetchEmailList).toHaveBeenCalledTimes(1);
    expect(monitor.fetchEmailContent).toHaveBeenCalledTimes(2);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.created).toBe(2);
  });

  it('does not satisfy a full scan with an incremental run already in flight', async () => {
    // Joining would hand the sweep an incremental result and silently downgrade
    // the one mechanism that guarantees nothing is missed.
    const user = await makeUser({ gmailSyncWatermark: new Date(Date.now() - 3600000) });
    serveMailbox([]);

    const incremental = engine.processUserEmails(user, { mode: 'incremental' });
    const full = engine.processUserEmails(user, { mode: 'full' });
    const [a, b] = await Promise.all([incremental, full]);

    expect(a).not.toBe(b);
    expect(a.mode).toBe('incremental');
    expect(b.mode).toBe('full');
    expect(monitor.fetchEmailList).toHaveBeenCalledTimes(2);
  });

  it('still joins a narrower request onto a full run in flight', async () => {
    const user = await makeUser({ gmailSyncWatermark: new Date(Date.now() - 3600000) });
    serveMailbox([]);

    const [a, b] = await Promise.all([
      engine.processUserEmails(user, { mode: 'full' }),
      engine.processUserEmails(user, { mode: 'incremental' }),
    ]);

    expect(a).toBe(b);
    expect(monitor.fetchEmailList).toHaveBeenCalledTimes(1);
  });

  it('refuses to call Google while a cooldown is active', async () => {
    const user = await makeUser({ gmailRetryAfter: new Date(Date.now() + 4 * 60 * 1000) });
    serveMailbox([debitAlert('m1', 500)]);

    const result = await engine.processUserEmails(user);

    expect(monitor.fetchEmailList).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('rate_limited');
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('syncs normally once the cooldown has passed', async () => {
    const user = await makeUser({ gmailRetryAfter: new Date(Date.now() - 1000) });
    serveMailbox([debitAlert('m1', 500)]);

    const result = await engine.processUserEmails(user);

    expect(result.ok).toBe(true);
    expect(result.created).toBe(1);
  });
});

describe('end to end: nothing real-time is load-bearing', () => {
  // Exercises the real seam — sweep → queue → worker → engine → database — with
  // only the Gmail transport stubbed. These are the failures the whole design
  // exists to absorb, so they are asserted against the transaction actually
  // landing, not against an intermediate stat.
  const scheduler = require('../automation/gmail/sync-scheduler');

  /** Runs the worker until the queue is empty, so a deferred slice still drains. */
  async function drainFully(maxTicks = 10) {
    for (let i = 0; i < maxTicks; i++) {
      if (await scheduler.drainQueue() === 0) return;
    }
  }

  it('records a transaction whose push was never delivered', async () => {
    const user = await makeUser({ gmailSyncWatermark: new Date(Date.now() - 3600000) });

    // The alert arrives. No push follows — dropped, or the watch had lapsed, or
    // the container was asleep. Nothing calls the engine.
    serveMailbox([debitAlert('m1', 1250)]);
    expect(await PendingTransaction.countDocuments({ user: user._id })).toBe(0);

    // The sweep runs on its own schedule and does not consult any of that.
    await scheduler.runSweep();
    await drainFully();

    const [txn] = await PendingTransaction.find({ user: user._id }).lean();
    expect(txn).toBeDefined();
    expect(txn.amount).toBe(1250);
    expect(txn.gmailMessageId).toBe('m1');
  });

  it('drains a backlog larger than one run without anyone pressing a button', async () => {
    const alerts = Array.from({ length: 7 }, (_, i) => debitAlert(`m${i}`, 100 + i));
    const user = await makeUser();
    serveMailbox(alerts);

    const realCap = config.gmailSync.maxFetchesPerRun;
    config.gmailSync.maxFetchesPerRun = 2;
    try {
      await scheduler.runSweep();
      await drainFully();
    } finally {
      config.gmailSync.maxFetchesPerRun = realCap;
    }

    expect(await PendingTransaction.countDocuments({ user: user._id })).toBe(7);
    expect(await GmailSyncJob.countDocuments({ user: user._id })).toBe(0);
  });

  it('does not double-record a transaction the push path already captured', async () => {
    // The sweep re-lists everything the incremental run just handled. The ledger
    // is what makes that overlap free — and idempotent.
    const user = await makeUser({ gmailSyncWatermark: new Date(Date.now() - 3600000) });
    serveMailbox([debitAlert('m1', 640)]);

    await engine.processUserEmails(user, { mode: 'incremental', reason: 'push' });
    monitor.fetchEmailContent.mockClear();

    await scheduler.runSweep();
    await drainFully();

    expect(monitor.fetchEmailContent).not.toHaveBeenCalled();
    expect(await PendingTransaction.countDocuments({ user: user._id })).toBe(1);
  });

  it('picks the account back up after a rate limit expires', async () => {
    const user = await makeUser({ gmailRetryAfter: new Date(Date.now() + 60 * 1000) });
    serveMailbox([debitAlert('m1', 300)]);

    await scheduler.runSweep();
    await drainFully(2);

    // Parked, not lost: no Gmail call, and the job is still queued.
    expect(monitor.fetchEmailList).not.toHaveBeenCalled();
    expect(await GmailSyncJob.countDocuments({ user: user._id })).toBe(1);

    // Cooldown lapses and the queued job becomes due again.
    await User.findByIdAndUpdate(user._id, { gmailRetryAfter: new Date(Date.now() - 1000) });
    await GmailSyncJob.updateOne({ user: user._id }, { $set: { dueAt: new Date(0) } });
    await drainFully();

    expect(await PendingTransaction.countDocuments({ user: user._id })).toBe(1);
  });
});

describe('rate-limit classification', () => {
  it('reads Retry-After from a fetch Headers instance', () => {
    const failure = classifyGoogleError({
      message: 'Too many requests',
      response: { status: 429, headers: new Headers({ 'retry-after': '120' }), data: {} },
    });
    expect(failure.code).toBe('rate_limited');
    expect(failure.retryAfterMs).toBe(120000);
  });

  it('reads Retry-After from a plain header object', () => {
    const failure = classifyGoogleError({
      message: 'Too many requests',
      response: { status: 429, headers: { 'retry-after': '90' }, data: {} },
    });
    expect(failure.retryAfterMs).toBe(90000);
  });

  it('reads the deadline Gmail embeds in the message when it sends no header', () => {
    // Gmail's real per-user 429 sends no Retry-After header at all — the
    // deadline is only in the text. Observed verbatim in production.
    const until = new Date(Date.now() + 14 * 60 * 1000).toISOString();
    const failure = classifyGoogleError({
      message: `User-rate limit exceeded.  Retry after ${until}`,
      response: {
        status: 429,
        data: { error: { code: 429, message: `User-rate limit exceeded.  Retry after ${until}`,
          errors: [{ reason: 'rateLimitExceeded' }] } },
      },
    });

    expect(failure.code).toBe('rate_limited');
    // Within a second of the stated deadline, not the 5-minute default guess.
    expect(failure.retryAfterMs).toBeGreaterThan(13.9 * 60 * 1000);
    expect(failure.retryAfterMs).toBeLessThan(14.1 * 60 * 1000);
  });

  it('ignores an embedded deadline that has already passed', () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const failure = classifyGoogleError({
      message: `User-rate limit exceeded.  Retry after ${past}`,
      response: { status: 429, data: {} },
    });

    // Falls through to the default rather than returning a negative wait.
    expect(failure.retryAfterMs).toBe(5 * 60 * 1000);
  });

  it('prefers the Retry-After header over a deadline in the message', () => {
    const far = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const failure = classifyGoogleError({
      message: `Rate limited. Retry after ${far}`,
      response: { status: 429, headers: { 'retry-after': '45' }, data: {} },
    });

    expect(failure.retryAfterMs).toBe(45000);
  });

  it('falls back to a default cooldown when Google sends no hint', () => {
    const failure = classifyGoogleError({
      message: 'User Rate Limit Exceeded',
      response: { status: 403, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } },
    });
    expect(failure.code).toBe('rate_limited');
    expect(failure.retryAfterMs).toBe(5 * 60 * 1000);
  });

  it('leaves non-rate-limit failures without a cooldown', () => {
    const failure = classifyGoogleError({
      message: 'Invalid Credentials',
      response: { status: 401, data: { error: { status: 'UNAUTHENTICATED' } } },
    });
    expect(failure.code).toBe('auth_expired');
    expect(failure.retryAfterMs).toBeNull();
  });
});
