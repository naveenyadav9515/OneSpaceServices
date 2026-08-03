/**
 * Webhooks Controller — Handles incoming Pub/Sub push notifications for Gmail.
 *
 * This handler does not sync. It validates the notification, resolves the
 * mailbox, and queues the work.
 *
 * Running the sync inline made the trigger exactly as durable as the HTTP
 * request carrying it: a container restart mid-sync — routine on Render — lost
 * the notification, and Gmail never re-sends one. It also meant a burst of
 * pushes for one busy mailbox started a burst of competing scans, and that a
 * slow sync held the request open while Pub/Sub waited on an ack.
 *
 * Queuing instead makes the notification durable, collapses a burst into one
 * run, and returns in milliseconds.
 */

const User = require('../models/User');
const config = require('../config/index');
const { enqueueSync } = require('../automation/gmail/sync-queue');
const { recordGmailPush, getGmailCooldownRemainingMs } = require('../utils/gmail-state.util');

/**
 * @desc    Handle incoming Google Cloud Pub/Sub Push Notifications for Gmail
 * @route   POST /api/webhooks/gmail
 */
const handleGmailPushNotification = async (req, res) => {
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
    }).select('_id email gmailRetryAfter').lean();

    if (!user) {
      console.log(`[Webhook] No eligible user for mailbox ${emailAddress}. Ignoring.`);
      return res.status(200).send('Ignored');
    }

    // Proof that the watch is alive. Read back by the sweep, which otherwise
    // cannot tell a mailbox with no new mail from one whose watch has quietly
    // stopped delivering.
    await recordGmailPush(user._id);

    // ── 5. Respect an active cooldown ──
    //
    // Gmail pushes a notification for *any* inbox change, so a busy mailbox
    // reaches this line dozens of times an hour. Queuing each of them while
    // Google is already refusing on quota grounds just builds a backlog that
    // will be refused too. The next sweep picks this mailbox up regardless, so
    // dropping the notification costs latency, never a transaction.
    const cooldownMs = getGmailCooldownRemainingMs(user);
    if (cooldownMs > 0) {
      console.warn(`[Webhook] Ignoring push for ${user.email} — Google cooldown has ${Math.ceil(cooldownMs / 1000)}s left.`);
      return res.status(200).send('Cooling down');
    }

    // ── 6. Queue the sync ──
    //
    // Incremental: this is a notification that something arrived, and the
    // watermark already covers everything before it. The periodic sweep is what
    // re-reads the full window.
    await enqueueSync(user._id, { full: false, reason: 'push' });

    // Always 200 — a non-2xx makes Pub/Sub redeliver, and the job is durable now,
    // so redelivery would only duplicate work that is already guaranteed to run.
    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook Error:', error);
    res.status(500).send('Internal Server Error');
  }
};

module.exports = {
  handleGmailPushNotification,
};
