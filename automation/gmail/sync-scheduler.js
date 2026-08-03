/**
 * Gmail sync worker and reconciliation sweep.
 *
 * Two background loops:
 *
 *   The worker drains the job queue. Every sync — push-triggered, swept, or a
 *   backlog slice — runs here rather than inside an HTTP request, so a container
 *   restart loses at most the current attempt and never the trigger.
 *
 *   The sweep queues a full-window scan for every connected user on a fixed
 *   interval. This is the completeness guarantee: it runs whether or not a push
 *   arrived, whether or not the watch is alive, and whether or not the mailbox
 *   files bank alerts out of the INBOX the watch subscribes to. On a healthy
 *   account it finds nothing and costs one `messages.list` — 5 quota units — plus
 *   one indexed lookup.
 *
 * Both are disabled by DISABLE_GMAIL_SYNC_WORKER, which a developer machine
 * pointed at the production database MUST set: otherwise it leases production
 * jobs and syncs real users' mailboxes from a laptop.
 */

const config = require('../../config/index');
const User = require('../../models/User');
const engine = require('../engine');
const { leaseNextJob, completeJob, releaseJob, enqueueSync } = require('./sync-queue');
const {
  recordGmailError,
  recordGmailSyncSuccess,
  failureFromStats,
  getGmailCooldownRemainingMs,
} = require('../../utils/gmail-state.util');
const { invalidateOAuth2Client } = require('./gmail-monitor');

/** Fields the engine needs that the schema hides by default. */
const SECRET_FIELDS = '+googleRefreshToken +gmailAccessToken';

/** Re-check delay when another process holds the lock for a user. */
const LOCK_CONTENTION_RETRY_MS = 15 * 1000;

let workerTimer = null;
let sweepTimer = null;
let startupSweepTimer = null;
/** Guards against a slow tick overlapping the next one. */
let workerBusy = false;

/**
 * Runs one queued job to completion and decides what happens to the row.
 *
 * Every branch either deletes the job or re-queues it with a delay — a job must
 * never be left leased, or it sits idle until the lease TTL expires.
 *
 * @param {object} job leased job row
 * @returns {Promise<void>}
 */
async function runJob(job) {
  const user = await User.findById(job.user).select(SECRET_FIELDS);

  // The account was disconnected or deleted after the job was queued. There is
  // nothing to sync and no point retrying.
  if (!user || !user.gmailConnected || !user.googleRefreshToken) {
    console.log(`[GmailWorker] Dropping job for ${job.user} — Gmail is no longer connected.`);
    await completeJob(job);
    return;
  }

  // Google asked us to stay away and the deadline has not passed. Park the job
  // until it has rather than spending an attempt to be refused again.
  const cooldownMs = getGmailCooldownRemainingMs(user);
  if (cooldownMs > 0) {
    await releaseJob(job, { delayMs: cooldownMs + 1000 });
    return;
  }

  const stats = await engine.processUserEmails(user, {
    mode: job.full ? 'full' : 'incremental',
    reason: job.reason || 'queued',
  });

  if (stats.ok) {
    await recordGmailSyncSuccess(user._id);

    // The run hit its per-run fetch cap. This is progress, not failure: re-queue
    // at once so the backlog drains by itself instead of waiting for a push or
    // for someone to press Refresh.
    if (stats.remaining > 0) {
      console.log(`[GmailWorker] ${stats.remaining} message(s) left for ${user.email} — re-queuing immediately.`);
      await releaseJob(job, { delayMs: 0 });
      return;
    }

    await completeJob(job);
    return;
  }

  const failure = failureFromStats(stats);

  // Another process is mid-sync for this user. Not an error — just come back.
  if (failure.code === 'sync_in_progress') {
    await releaseJob(job, { delayMs: LOCK_CONTENTION_RETRY_MS });
    return;
  }

  await recordGmailError(user._id, failure);

  // Only a genuinely dead credential justifies tearing down the connection.
  // Rate limits, a disabled Gmail API and network blips are transient.
  if (failure.fatal) {
    invalidateOAuth2Client(user._id);
    await User.findByIdAndUpdate(user._id, { gmailConnected: false, expenseAutomationEnabled: false });
    console.warn(`[GmailWorker] Google credentials rejected for ${user.email} (${failure.code}). Marked disconnected.`);
    await completeJob(job);
    return;
  }

  console.error(`[GmailWorker] Sync failed for ${user.email} (${failure.code}): ${failure.message}`);
  await releaseJob(job, {
    // `recordGmailError` has already stored the cooldown deadline; matching it
    // here keeps the job from waking early only to be parked again.
    delayMs: failure.retryAfterMs > 0 ? failure.retryAfterMs + 1000 : null,
    error: `${failure.code}: ${failure.message}`,
  });
}

/**
 * One worker tick: lease up to the concurrency limit and run them together.
 * @returns {Promise<number>} how many jobs ran
 */
async function drainQueue() {
  const jobs = [];
  for (let i = 0; i < config.gmailSync.workerConcurrency; i++) {
    const job = await leaseNextJob();
    if (!job) break;
    jobs.push(job);
  }

  if (jobs.length === 0) return 0;

  await Promise.all(jobs.map(async (job) => {
    try {
      await runJob(job);
    } catch (err) {
      // An unexpected throw must still free the row, or it stays leased until
      // the TTL expires and the user's mail waits with it.
      console.error(`[GmailWorker] Job for user ${job.user} threw:`, err.message);
      await releaseJob(job, { error: err.message }).catch(() => {});
    }
  }));

  return jobs.length;
}

/**
 * A watch is treated as broken once this long has passed with no push at all.
 *
 * Long enough that a genuinely quiet mailbox is not mistaken for a dead
 * subscription — Gmail pushes on *any* inbox change, so a day of total silence
 * on an account that demonstrably received bank mail is not plausible.
 */
const WATCH_SILENCE_MS = 24 * 60 * 60 * 1000;

/** Google asks for at most about one `users.watch` per mailbox per day. */
const WATCH_REPAIR_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Re-registers watches that have stopped delivering.
 *
 * The signal is the conjunction of two facts, and both are needed. The previous
 * sweep having to pick up mail itself (`gmailLastSweepMissed`) says real-time
 * delivery is not working. No push having arrived for a day says the reason is
 * the subscription rather than the mailbox — a user who files bank alerts
 * straight out of the INBOX also shows missed mail, but their watch is fine and
 * still pushes for everything else, and re-registering it would achieve nothing.
 *
 * @returns {Promise<number>} how many watches were re-registered
 */
async function repairSilentWatches() {
  const now = Date.now();

  const candidates = await User.find({
    gmailConnected: true,
    expenseAutomationEnabled: true,
    gmailLastSweepMissed: { $gt: 0 },
    $and: [
      { $or: [{ gmailLastPushAt: null }, { gmailLastPushAt: { $lt: new Date(now - WATCH_SILENCE_MS) } }] },
      { $or: [
        { gmailWatchRepairedAt: null },
        { gmailWatchRepairedAt: { $lt: new Date(now - WATCH_REPAIR_INTERVAL_MS) } },
      ] },
    ],
  }).select('+googleRefreshToken +gmailAccessToken');

  // Required here rather than at module load: the watch manager pulls in the
  // whole Gmail transport, and the webhook path must stay light.
  const watchManager = require('./gmail-watch-manager');

  let repaired = 0;
  for (const user of candidates) {
    if (!user.googleRefreshToken) continue;
    try {
      await watchManager.activateWatch(user);
      await User.findByIdAndUpdate(user._id, { gmailWatchRepairedAt: new Date() });
      repaired++;
      console.warn(`[GmailSweep] Re-registered a silent Gmail watch for ${user.email}.`);
    } catch (err) {
      console.error(`[GmailSweep] Could not repair the watch for ${user.email}: ${err.message}`);
    }
  }

  return repaired;
}

/**
 * Queues a full-window scan for every user with automation enabled.
 *
 * Due times are spread across the first minutes of the interval so a large
 * account list does not arrive as one burst — the worker's concurrency limit
 * would serialise it anyway, but staggering keeps the queue readable and the
 * database load flat.
 *
 * @returns {Promise<{queued: number, repaired: number}>}
 */
async function runSweep() {
  const users = await User.find({
    gmailConnected: true,
    expenseAutomationEnabled: true,
  }).select('_id').lean();

  if (users.length === 0) {
    console.log('[GmailSweep] No connected accounts to reconcile.');
    return { queued: 0, repaired: 0 };
  }

  const spreadMs = Math.min(5 * 60 * 1000, users.length * 250);

  for (const [i, user] of users.entries()) {
    await enqueueSync(user._id, {
      full: true,
      reason: 'sweep',
      delayMs: users.length > 1 ? Math.round((i / users.length) * spreadMs) : 0,
    });
  }

  // Acts on what the *previous* sweep recorded, since this one's results do not
  // exist until the jobs queued above have run. One interval of lag is fine for
  // a condition measured in days.
  const repaired = await repairSilentWatches().catch(err => {
    console.error('[GmailSweep] Watch repair pass failed:', err.message);
    return 0;
  });

  console.log(`[GmailSweep] Queued a full reconciliation scan for ${users.length} account(s)${repaired ? `, repaired ${repaired} watch(es)` : ''}.`);
  return { queued: users.length, repaired };
}

/**
 * Starts both loops. Safe to call once at boot; a second call is ignored.
 * @returns {boolean} whether the loops were started
 */
function start() {
  if (process.env.DISABLE_GMAIL_SYNC_WORKER === 'true') {
    console.warn('⛔ Gmail sync worker and sweep DISABLED for this process (DISABLE_GMAIL_SYNC_WORKER=true)');
    return false;
  }
  if (workerTimer) return true;

  const { workerPollMs, sweepIntervalMinutes, startupSweepDelayMs } = config.gmailSync;

  workerTimer = setInterval(async () => {
    if (workerBusy) return;
    workerBusy = true;
    try {
      await drainQueue();
    } catch (err) {
      console.error('[GmailWorker] Tick failed:', err.message);
    } finally {
      workerBusy = false;
    }
  }, workerPollMs);
  // Do not hold the event loop open on shutdown.
  if (workerTimer.unref) workerTimer.unref();

  const sweepMs = sweepIntervalMinutes * 60 * 1000;
  sweepTimer = setInterval(() => {
    runSweep().catch(err => console.error('[GmailSweep] Sweep failed:', err.message));
  }, sweepMs);
  if (sweepTimer.unref) sweepTimer.unref();

  // A sweep on startup covers the window the process was down for, which is the
  // gap a push-only design can never close.
  startupSweepTimer = setTimeout(() => {
    runSweep().catch(err => console.error('[GmailSweep] Startup sweep failed:', err.message));
  }, startupSweepDelayMs);
  if (startupSweepTimer.unref) startupSweepTimer.unref();

  console.log(`⚙️  Gmail sync worker started (poll ${workerPollMs}ms, concurrency ${config.gmailSync.workerConcurrency})`);
  console.log(`🧾 Gmail reconciliation sweep every ${sweepIntervalMinutes} minutes (retention window: ${config.gmailSync.lookbackDays} days)`);
  return true;
}

/** Stops both loops. Used by tests and graceful shutdown. */
function stop() {
  if (workerTimer) clearInterval(workerTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  if (startupSweepTimer) clearTimeout(startupSweepTimer);
  workerTimer = sweepTimer = startupSweepTimer = null;
}

module.exports = {
  start,
  stop,
  runSweep,
  repairSilentWatches,
  drainQueue,
  runJob,
};
