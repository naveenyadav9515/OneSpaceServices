/**
 * Shared persistence for the "why did Gmail last fail" state.
 *
 * Lives here rather than in a controller because all three sync entry points —
 * the OAuth callback, the Pub/Sub webhook, and the manual Refresh button — must
 * record failures identically. When only one of them did, the settings panel
 * showed a stale reason from whichever path happened to write last.
 */

const User = require('../models/User');

/**
 * Records why Gmail last failed, so the settings panel can explain itself
 * instead of showing a bare "not connected".
 *
 * When the failure carries a cooldown (`retryAfterMs`), the deadline is stored
 * too — that is what stops the next Pub/Sub push, seconds later, from spending
 * another slice of an already-exhausted quota.
 * @param {string} userId
 * @param {{code: string, message: string, retryAfterMs?: number|null}|null} failure null clears the stored error
 * @returns {Promise<void>}
 */
async function recordGmailError(userId, failure) {
  try {
    const update = {
      gmailLastError: failure
        ? { code: failure.code, message: failure.message, at: new Date() }
        : { code: null, message: null, at: null },
    };

    if (failure?.retryAfterMs > 0) {
      update.gmailRetryAfter = new Date(Date.now() + failure.retryAfterMs);
    } else if (!failure) {
      update.gmailRetryAfter = null;
    }

    await User.findByIdAndUpdate(userId, update);
  } catch (err) {
    console.error('[GmailState] Could not record Gmail error state:', err.message);
  }
}

/**
 * How much longer we must leave Google alone for this user, in milliseconds.
 *
 * Reads the stored deadline off the user document the caller already loaded —
 * deliberately no extra query, since this runs on the hot path of every push.
 * @param {object} user
 * @returns {number} 0 when there is no active cooldown
 */
function getGmailCooldownRemainingMs(user) {
  const until = user?.gmailRetryAfter ? new Date(user.gmailRetryAfter).getTime() : 0;
  if (!until) return 0;
  return Math.max(0, until - Date.now());
}

/**
 * Marks a sync as having completed cleanly: stamps the time and clears any
 * previously recorded failure.
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function recordGmailSyncSuccess(userId) {
  try {
    await User.findByIdAndUpdate(userId, {
      gmailLastSyncAt: new Date(),
      gmailLastError: { code: null, message: null, at: null },
      gmailRetryAfter: null,
    });
  } catch (err) {
    console.error('[GmailState] Could not record Gmail sync success:', err.message);
  }
}

/**
 * Moves the incremental query's starting point forward.
 *
 * Only ever moves forward: a stale user document in some other code path must
 * not be able to drag it backwards, which would re-widen every subsequent
 * incremental run without anyone noticing.
 *
 * Best-effort. A failed write means the next incremental run scans from an older
 * point — more work, same result — so it must never fail a sync that otherwise
 * succeeded.
 * @param {string} userId
 * @param {Date} watermark
 * @returns {Promise<void>}
 */
async function advanceSyncWatermark(userId, watermark) {
  try {
    await User.updateOne(
      {
        _id: userId,
        $or: [
          { gmailSyncWatermark: null },
          { gmailSyncWatermark: { $exists: false } },
          { gmailSyncWatermark: { $lt: watermark } },
        ],
      },
      { $set: { gmailSyncWatermark: watermark } },
    );
  } catch (err) {
    console.warn(`[GmailState] Could not advance the sync watermark: ${err.message}`);
  }
}

/**
 * Records what the reconciliation sweep found.
 *
 * `missed` is the count of messages the sweep had to pick up itself because the
 * push path never delivered them. It is stored rather than only logged so the
 * health of real-time delivery is queryable per user, not buried in a log that
 * has already rotated by the time anyone asks.
 * @param {string} userId
 * @param {number} missed
 * @returns {Promise<void>}
 */
async function recordSweepOutcome(userId, missed) {
  try {
    await User.findByIdAndUpdate(userId, {
      gmailLastSweepAt: new Date(),
      gmailLastSweepMissed: missed || 0,
    });
  } catch (err) {
    console.warn(`[GmailState] Could not record the sweep outcome: ${err.message}`);
  }
}

/**
 * Stamps the arrival of a Gmail push notification.
 *
 * Read back by the sweep: a mailbox that receives mail but never a push has a
 * watch that has quietly stopped working, which is otherwise indistinguishable
 * from a quiet week.
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function recordGmailPush(userId) {
  try {
    await User.findByIdAndUpdate(userId, { gmailLastPushAt: new Date() });
  } catch (err) {
    console.warn(`[GmailState] Could not record the push timestamp: ${err.message}`);
  }
}

/**
 * How long a sync lock is honoured before another run may steal it.
 *
 * Must exceed the longest a healthy sync can take (the engine caps each run at
 * gmailSync.maxFetchesPerRun messages, so seconds) with a wide margin, and must be
 * short enough that a process killed mid-sync does not lock the user out for
 * long. Render restarts containers freely, so this case is routine, not rare.
 */
const SYNC_LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * Claims the sync lock for a user, if it is free or has gone stale.
 *
 * The find-and-update is a single atomic operation on purpose: reading the lock
 * and then writing it would leave a window where two processes both see it free.
 *
 * @param {string} userId
 * @returns {Promise<boolean>} true when this caller now holds the lock
 */
async function acquireSyncLock(userId) {
  const staleBefore = new Date(Date.now() - SYNC_LOCK_TTL_MS);

  const claimed = await User.findOneAndUpdate(
    {
      _id: userId,
      $or: [
        { gmailSyncLockedAt: null },
        { gmailSyncLockedAt: { $exists: false } },
        { gmailSyncLockedAt: { $lt: staleBefore } },
      ],
    },
    { $set: { gmailSyncLockedAt: new Date() } },
    { new: true },
  ).select('_id').lean();

  return Boolean(claimed);
}

/**
 * Releases the sync lock. Best-effort: if this fails the lock still expires on
 * its own after the TTL, so a sync can never be blocked forever.
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function releaseSyncLock(userId) {
  try {
    await User.findByIdAndUpdate(userId, { $set: { gmailSyncLockedAt: null } });
  } catch (err) {
    console.warn(`[GmailState] Could not release the sync lock (it expires in ${SYNC_LOCK_TTL_MS / 60000}m anyway): ${err.message}`);
  }
}

/**
 * Normalises an engine `stats` object into a failure classification.
 *
 * The engine sets `stats.failure` for every failure it classifies; this fallback
 * covers the pre-flight refusals (no refresh token, no parsers) and any older
 * caller that still reads the flat fields.
 * @param {object} stats engine stats
 * @returns {{code: string, message: string, fatal: boolean}}
 */
function failureFromStats(stats) {
  if (stats.failure) return stats.failure;
  return {
    code: stats.reason || 'gmail_error',
    message: stats.error || 'Gmail sync failed.',
    fatal: Boolean(stats.authExpired),
    retryAfterMs: null,
  };
}

module.exports = {
  SYNC_LOCK_TTL_MS,
  recordGmailError,
  recordGmailSyncSuccess,
  getGmailCooldownRemainingMs,
  acquireSyncLock,
  releaseSyncLock,
  advanceSyncWatermark,
  recordSweepOutcome,
  recordGmailPush,
  failureFromStats,
};
