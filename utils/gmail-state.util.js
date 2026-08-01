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
 * @param {string} userId
 * @param {{code: string, message: string}|null} failure null clears the stored error
 * @returns {Promise<void>}
 */
async function recordGmailError(userId, failure) {
  try {
    await User.findByIdAndUpdate(userId, {
      gmailLastError: failure
        ? { code: failure.code, message: failure.message, at: new Date() }
        : { code: null, message: null, at: null },
    });
  } catch (err) {
    console.error('[GmailState] Could not record Gmail error state:', err.message);
  }
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
    });
  } catch (err) {
    console.error('[GmailState] Could not record Gmail sync success:', err.message);
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
  };
}

module.exports = {
  recordGmailError,
  recordGmailSyncSuccess,
  failureFromStats,
};
