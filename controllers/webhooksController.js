/**
 * Webhooks Controller — Handles incoming Pub/Sub push notifications for Gmail.
 *
 * This controller is now a thin delegate. All email processing logic has been
 * moved to the Automation Engine (automation/engine.js).
 */

const User = require('../models/User');
const config = require('../config/index');
const engine = require('../automation/engine');

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

    // ── 5. Delegate to Automation Engine ──
    const stats = await engine.processUserEmails(user);

    if (stats.authExpired) {
      await User.findByIdAndUpdate(user._id, { gmailConnected: false, expenseAutomationEnabled: false });
      console.warn(`[Webhook] Google credentials rejected for ${user.email}. Marked disconnected.`);
    } else if (!stats.ok) {
      console.error(`[Webhook] Sync failed for ${user.email}: ${stats.error}`);
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
