/**
 * Gmail Watch Manager — Manages Gmail push notification subscriptions.
 *
 * Handles:
 * - Activating Gmail Watch (Pub/Sub push notifications) for individual users
 * - Renewing watches for all eligible users (scheduled job)
 * - Tracking watch expiry in the User model
 *
 * Gmail Watch expires every 7 days — we renew every 6 days for safety.
 */

const { google } = require('googleapis');
const User = require('../../models/User');
const config = require('../../config/index');
const { createOAuth2Client, invalidateOAuth2Client, withGoogleRetry } = require('./gmail-monitor');
const { classifyGoogleError } = require('../../utils/google-error.util');
const { recordGmailError } = require('../../utils/gmail-state.util');
const quota = require('./gmail-quota');

/**
 * Activates Gmail Watch (push notifications) for a single user.
 *
 * Shares the cached OAuth2 client with the sync path. Building a private one
 * here forced a separate refresh-token redemption for every watch call, on top
 * of the one each sync already made — and `updateAutomationSettings` calls this
 * on every settings save, so the token endpoint saw a burst per user action.
 * @param {object} user - User document with googleRefreshToken
 * @returns {Promise<object>} Gmail Watch response (contains historyId and expiration)
 */
async function activateWatch(user) {
  const oauth2Client = createOAuth2Client(user);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // `users.watch` costs 100 quota units — twenty times a message fetch — so it
  // goes through the same per-user governor as everything else. A renewal sweep
  // that ignored it could exhaust a user's budget before their sync began.
  const response = await quota.spend(user._id, quota.COST.watch, () => withGoogleRetry(
    () => gmail.users.watch({
      userId: 'me',
      requestBody: {
        labelIds: ['INBOX'],
        labelFilterAction: 'include',
        topicName: `projects/${config.app.gcpProjectId}/topics/${config.app.pubsubTopic}`,
      },
    }),
    `users.watch for ${user.email}`,
  ));

  // Update the user's watch expiry and history ID
  if (response.data) {
    const updateData = {};
    if (response.data.expiration) {
      updateData.gmailWatchExpiry = new Date(parseInt(response.data.expiration));
    }
    if (response.data.historyId) {
      updateData.gmailHistoryId = response.data.historyId;
    }
    if (Object.keys(updateData).length > 0) {
      await User.findByIdAndUpdate(user._id, updateData);
    }
  }

  return response.data;
}

/**
 * Renew a watch only once it is within this window of expiring.
 *
 * Google's watch lasts 7 days and the API is explicit that `users.watch` should
 * not be called more than about once a day per mailbox. The renewal sweep runs
 * on every process start, and this service restarts often (Render's free tier
 * sleeps it — that is what the keep-alive ping in utils/keep-alive.js exists to fight), so
 * an unconditional sweep meant one `users.watch` per connected user per restart.
 * That is a quota cost with no benefit: the existing watch was still valid.
 *
 * Two days leaves room for several missed restarts before a watch lapses.
 */
const RENEWAL_THRESHOLD_MS = 2 * 24 * 60 * 60 * 1000;

/** Gap between users in a sweep, so a large account list is not a burst. */
const RENEWAL_STAGGER_MS = 250;

/** @param {number} ms @returns {Promise<void>} */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Renews Gmail Watch for users whose subscription is close to lapsing.
 * Eligible = gmailConnected + expenseAutomationEnabled + has refresh token.
 *
 * @param {{force?: boolean}} [options] `force` re-registers every eligible user
 *   regardless of expiry — for when the Pub/Sub topic itself has changed.
 * @returns {Promise<{renewed: number, failed: number, skipped: number, notDue: number}>}
 */
async function renewAllWatches({ force = false } = {}) {
  const stats = { renewed: 0, failed: 0, skipped: 0, notDue: 0 };

  const query = {
    gmailConnected: true,
    expenseAutomationEnabled: true,
  };

  // Let the database do the filtering — loading every connected user to discard
  // most of them scales badly and reads worse.
  if (!force) {
    query.$or = [
      { gmailWatchExpiry: null },
      { gmailWatchExpiry: { $exists: false } },
      { gmailWatchExpiry: { $lte: new Date(Date.now() + RENEWAL_THRESHOLD_MS) } },
    ];
  }

  const dueCount = await User.countDocuments(query);
  const totalCount = await User.countDocuments({ gmailConnected: true, expenseAutomationEnabled: true });
  stats.notDue = totalCount - dueCount;

  if (dueCount === 0) {
    console.log(`[GmailWatch] No watches due for renewal (${totalCount} active, all current).`);
    return stats;
  }

  const users = await User.find(query).select('+googleRefreshToken +gmailAccessToken');

  for (const [i, user] of users.entries()) {
    if (!user.googleRefreshToken) {
      stats.skipped++;
      continue;
    }

    if (i > 0) await sleep(RENEWAL_STAGGER_MS);

    try {
      await activateWatch(user);
      stats.renewed++;
      console.log(`[GmailWatch] Renewed watch for ${user.email}`);
    } catch (err) {
      stats.failed++;

      // `err.code` is not a status — Gaxios sets it to strings like 'ENOTFOUND'
      // — so the old `err.code === 401` test both missed real 401s and could not
      // tell a dead token from a rate limit. Classify properly and disconnect
      // only on `fatal`.
      const failure = classifyGoogleError(err);
      console.error(`[GmailWatch] Failed to renew watch for ${user.email} (${failure.code}):`, failure.raw);

      if (failure.fatal) {
        invalidateOAuth2Client(user._id);
        await User.findByIdAndUpdate(user._id, {
          gmailConnected: false,
          expenseAutomationEnabled: false,
        });
        console.warn(`[GmailWatch] Disabled automation for ${user.email} — ${failure.code}.`);
      }

      // Google is refusing on quota grounds; renewing the rest of the users now
      // just deepens it. Stop and let the next scheduled run pick them up.
      if (failure.code === 'rate_limited') {
        // Record the cooldown too. Without this the sync path had no idea the
        // watch call had just been refused and would hit Google seconds later,
        // spending the same exhausted budget — the renewal sweep was the one
        // place that recognised a 429 and then kept the fact to itself.
        await recordGmailError(user._id, failure);
        console.warn('[GmailWatch] Stopping renewal sweep — Google is rate-limiting.');
        break;
      }
    }
  }

  console.log(`[GmailWatch] Renewal complete: ${stats.renewed} renewed, ${stats.failed} failed, ${stats.skipped} skipped, ${stats.notDue} still current`);
  return stats;
}

/**
 * Registers a watch only if this user does not already have a current one.
 *
 * For callers that run on a user action rather than a schedule — saving the
 * automation settings, for instance, which a user can do repeatedly. Calling
 * `activateWatch` unconditionally there spent a `users.watch` per click to
 * re-register a subscription that was already live.
 *
 * @param {object} user - User document with googleRefreshToken
 * @returns {Promise<boolean>} true when a watch was actually registered
 */
async function ensureWatch(user) {
  const expiry = user.gmailWatchExpiry ? new Date(user.gmailWatchExpiry).getTime() : 0;
  if (expiry && expiry > Date.now() + RENEWAL_THRESHOLD_MS) return false;

  await activateWatch(user);
  return true;
}

module.exports = {
  activateWatch,
  ensureWatch,
  renewAllWatches,
  RENEWAL_THRESHOLD_MS,
};
