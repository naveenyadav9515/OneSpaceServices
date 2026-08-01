/**
 * Webhooks Controller — Handles incoming Pub/Sub push notifications for Gmail.
 *
 * This controller is now a thin delegate. All email processing logic has been
 * moved to the Automation Engine (automation/engine.js).
 */

const User = require('../models/User');
const config = require('../config/index');
const engine = require('../automation/engine');
const { recordGmailError, recordGmailSyncSuccess, failureFromStats, getGmailCooldownRemainingMs } = require('../utils/gmail-state.util');
const { invalidateOAuth2Client } = require('../automation/gmail/gmail-monitor');

/**
 * @desc    Handle incoming Google Cloud Pub/Sub Push Notifications for Gmail
 * @route   POST /api/webhooks/gmail
 */
const handleGmailPushNotification = async (req, res, next) => {
  try {
    // ── 1. Verify Pub/Sub token ──
    if (
      config.app.pubsubVerificationToken &&
      req.get('x-onespace-webhook-token') !== config.app.pubsubVerificationToken &&
      req.query.token !== config.app.pubsubVerificationToken
    ) {
      return res.status(401).send('Unauthorized');
    }

    // ── 2. Validate message format ──
    if (!req.body || !req.body.message || !req.body.message.data) {
      return res.status(400).send('Invalid Pub/Sub message format');
    }

    // ── 3. Decode Pub/Sub message ──
    const messageData = Buffer.from(req.body.message.data, 'base64').toString('utf-8');
    const parsedData = JSON.parse(messageData);
    const emailAddress = parsedData.emailAddress;

    if (!emailAddress) {
      return res.status(400).send('Missing email address');
    }

    // ── 4. Find eligible user ──
    // Match on the authorised mailbox first; fall back to the login email for
    // accounts connected before `gmailAddress` was recorded.
    const user = await User.findOne({
      gmailConnected: true,
      expenseAutomationEnabled: true,
      $or: [
        { gmailAddress: emailAddress.toLowerCase() },
        { gmailAddress: null, email: emailAddress.toLowerCase() },
      ],
    }).select('+googleRefreshToken');

    if (!user || !user.googleRefreshToken) {
      console.log(`[Webhook] No eligible user for mailbox ${emailAddress}. Ignoring.`);
      return res.status(200).send('Ignored');
    }

    // ── 5. Respect an active cooldown ──
    //
    // Gmail pushes a notification for *any* inbox change, so a busy mailbox
    // reaches this line dozens of times an hour. Running a sync for each of them
    // while Google is already refusing on quota grounds is what keeps the block
    // alive. Bail out here — cheaply, before the engine loads anything.
    const cooldownMs = getGmailCooldownRemainingMs(user);
    if (cooldownMs > 0) {
      console.warn(`[Webhook] Ignoring push for ${user.email} — Google cooldown has ${Math.ceil(cooldownMs / 1000)}s left.`);
      return res.status(200).send('Cooling down');
    }

    // ── 6. Delegate to Automation Engine ──
    const stats = await engine.processUserEmails(user);

    if (!stats.ok) {
      const failure = failureFromStats(stats);
      await recordGmailError(user._id, failure);

      // Same rule as the manual sync: only a dead credential may disconnect.
      if (failure.fatal) {
        invalidateOAuth2Client(user._id);
        await User.findByIdAndUpdate(user._id, { gmailConnected: false, expenseAutomationEnabled: false });
        console.warn(`[Webhook] Google credentials rejected for ${user.email} (${failure.code}). Marked disconnected.`);
      } else {
        console.error(`[Webhook] Sync failed for ${user.email} (${failure.code}): ${failure.message}`);
      }
    } else {
      await recordGmailSyncSuccess(user._id);
    }

    // Always 200 — a non-2xx makes Pub/Sub redeliver, and none of these
    // conditions are fixed by retrying.
    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook Error:', error);
    res.status(500).send('Internal Server Error');
  }
};

module.exports = {
  handleGmailPushNotification,
};
