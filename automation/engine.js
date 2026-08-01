/**
 * Automation Engine — Central orchestrator for the Automation Engine.
 *
 * Coordinates the full pipeline:
 *   Gmail Monitor → Parser Registry → Bank Parser → Expense Processor
 *
 * Provides a single entry point `processUserEmails(user)` that the webhook
 * handler, sync endpoint, and OAuth callback all use.
 *
 * Uses Node.js EventEmitter for decoupled event-driven architecture.
 * Future modules (Calendar, Reminders, etc.) can subscribe to events.
 */

const EventEmitter = require('events');
const { google } = require('googleapis');
const { createOAuth2Client, fetchEmailList, fetchEmailContent, buildQuery, getSyncCutoffDate } = require('./gmail/gmail-monitor');
const { getAllSenderEmails, getParserBySender } = require('./parsers/parser-registry');
const { isDuplicate, createPendingTransaction } = require('./processors/expense-processor');
const { classifyGoogleError } = require('../utils/google-error.util');

/**
 * Should a mid-walk failure stop the whole sync?
 *
 * Grinding through the remaining messages after Google has started refusing them
 * burns quota and produces `errors: 200` alongside `ok: true`, which every caller
 * reads as a successful sync. Stop instead, and report why.
 * @param {{fatal: boolean, retryable: boolean, code: string}} failure
 * @returns {boolean}
 */
function shouldAbortSync(failure) {
  return failure.fatal || !failure.retryable || failure.code === 'rate_limited';
}

class AutomationEngine extends EventEmitter {
  constructor() {
    super();
    // Prevent memory leak warnings for many listeners
    this.setMaxListeners(20);
  }

  /**
   * Main entry point — processes Gmail emails for a single user.
   *
   * This is the ONLY function that controllers should call.
   * It orchestrates: fetch emails → parse → deduplicate → create pending transactions.
   *
   * @param {object} user - User document with googleRefreshToken (already selected)
   * @returns {Promise<{processed: number, created: number, duplicates: number, errors: number}>}
   */
  async processUserEmails(user) {
    const stats = {
      ok: true,
      reason: null,
      error: null,
      /** Full classification of the failure, when there was one. @see classifyGoogleError */
      failure: null,
      authExpired: false,
      processed: 0,
      created: 0,
      duplicates: 0,
      errors: 0,
      skipped: { noParser: 0, notRelevant: 0, parseFailed: 0, beforeCutoff: 0 },
      fetchedEmails: [],
    };

    try {
      if (!user || !user.googleRefreshToken) {
        console.warn('[AutomationEngine] User missing or no refresh token. Skipping.');
        stats.ok = false;
        stats.reason = 'no_refresh_token';
        stats.error = 'Gmail account is not linked — no refresh token stored.';
        stats.failure = { code: 'no_refresh_token', message: stats.error, fatal: true, retryable: false };
        stats.authExpired = true;
        return stats;
      }

      const senderEmails = getAllSenderEmails();
      if (senderEmails.length === 0) {
        console.warn('[AutomationEngine] No bank parsers registered. Skipping.');
        stats.ok = false;
        stats.reason = 'no_parsers';
        stats.error = 'No bank parsers are registered on the server.';
        // A server-side configuration gap — never the user's credentials.
        stats.failure = { code: 'no_parsers', message: stats.error, fatal: false, retryable: false };
        return stats;
      }

      // ── 1. Setup Gmail API client ──
      const oauth2Client = createOAuth2Client(user);
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      // ── 2. Build query and fetch email list ──
      const cutoffDate = getSyncCutoffDate();
      const query = buildQuery(senderEmails, cutoffDate);
      console.log(`[AutomationEngine] Gmail query: "${query}" | Cutoff: ${cutoffDate.toISOString()}`);
      const messages = await fetchEmailList(gmail, query);

      console.log(`[AutomationEngine] Found ${messages.length} emails for user ${user.email}`);

      // ── 3. Process each email ──
      for (const msg of messages) {
        try {
          stats.processed++;

          // ── 3a. Fetch full email content ──
          const email = await fetchEmailContent(gmail, msg.id);
          console.log(`[AutomationEngine] Email ${msg.id}: subject="${email.subject}", from="${email.from}"`);
          
          const debugEntry = {
            id: msg.id,
            subject: email.subject,
            from: email.from,
            date: email.metadata?.internalDate ? new Date(parseInt(email.metadata.internalDate)) : null,
            outcome: 'processing',
          };
          stats.fetchedEmails.push(debugEntry);

          // ── 3b. Find the right parser by sender email ──
          // Extract raw email address from "From" header (e.g., "Axis Bank <alerts@axis.bank.in>")
          const senderMatch = email.from.match(/<([^>]+)>/);
          const senderEmail = senderMatch ? senderMatch[1] : email.from;
          const parser = getParserBySender(senderEmail);

          if (!parser) {
            stats.skipped.noParser++;
            debugEntry.outcome = 'skipped: no parser for sender';
            console.log(`[AutomationEngine] No parser found for sender: "${senderEmail}". Skipping.`);
            continue;
          }

          // ── 3c. Check if the email is relevant (e.g., is a debit alert) ──
          if (!parser.isRelevant(email.subject)) {
            stats.skipped.notRelevant++;
            debugEntry.outcome = 'skipped: subject not a debit alert';
            console.log(`[AutomationEngine] Email ${msg.id} not relevant (subject didn't match). Skipping.`);
            continue;
          }

          // ── 3d. Parse the email into a structured transaction ──
          const transaction = parser.parse(email.subject, email.body, email.metadata);
          if (!transaction) {
            stats.skipped.parseFailed++;
            debugEntry.outcome = 'skipped: no debit amount found';
            console.warn(`[AutomationEngine] Parser returned null for email ${msg.id}. Amount extraction failed.`);
            continue;
          }
          console.log(`[AutomationEngine] Parsed: amount=${transaction.amount}, merchant="${transaction.merchant}", date=${transaction.date}`);

          // Skip if parsed date falls before cutoff
          if (transaction.date < cutoffDate) {
            stats.skipped.beforeCutoff++;
            debugEntry.outcome = 'skipped: older than sync window';
            console.log(`[AutomationEngine] Email ${msg.id} date ${transaction.date} before cutoff ${cutoffDate.toISOString()}. Skipping.`);
            continue;
          }

          // ── 3e. Check for duplicates ──
          const duplicate = await isDuplicate(user._id, transaction);
          if (duplicate) {
            stats.duplicates++;
            debugEntry.outcome = 'duplicate — already recorded';
            console.log(`[AutomationEngine] Email ${msg.id} is a duplicate. Skipping.`);
            continue;
          }

          // ── 3f. Create pending transaction ──
          const pending = await createPendingTransaction(user._id, transaction);

          // A null result means the unique index rejected a concurrent insert.
          if (!pending) {
            stats.duplicates++;
            debugEntry.outcome = 'duplicate — already recorded';
            console.log(`[AutomationEngine] Email ${msg.id} lost a create race. Counted as duplicate.`);
            continue;
          }

          stats.created++;
          debugEntry.outcome = `created: ₹${transaction.amount} · ${transaction.merchant}`;
          console.log(`[AutomationEngine] ✅ Created pending transaction: ${pending._id} (₹${transaction.amount})`);

          // Emit event for future modules (push notifications, etc.)
          this.emit('transaction:created', { user, transaction: pending });

        } catch (emailErr) {
          stats.errors++;
          const failure = classifyGoogleError(emailErr);
          const entry = stats.fetchedEmails[stats.fetchedEmails.length - 1];
          if (entry && entry.id === msg.id) entry.outcome = `error: ${failure.message}`;
          console.error(`[AutomationEngine] Error processing email ${msg.id} (${failure.code}):`, failure.raw);

          // Google has started refusing us — stop rather than burn the rest of
          // the window on calls that will fail the same way.
          if (shouldAbortSync(failure)) {
            stats.ok = false;
            stats.failure = failure;
            stats.reason = failure.code;
            stats.error = failure.message;
            stats.authExpired = failure.fatal;
            console.error(`[AutomationEngine] Aborting sync for ${user.email} after ${stats.processed} emails — ${failure.code}.`);
            this.emit('sync:error', { user, error: emailErr, stats });
            return stats;
          }
        }
      }

      this.emit('sync:complete', { user, stats });
      console.log(`[AutomationEngine] Sync complete for ${user.email}: ${stats.created} created, ${stats.duplicates} duplicates, ${stats.errors} errors`);

    } catch (err) {
      // A fatal error here means we reached NO emails — never report it as a
      // successful sync, or a revoked token looks identical to an empty inbox.
      //
      // `classifyGoogleError` decides whether the credential is actually dead.
      // Treating every 401/403 as revoked consent — which this used to do —
      // disconnected healthy accounts on the first rate-limit or disabled-API
      // response, and the user was told only "Gmail is not connected".
      const failure = classifyGoogleError(err);
      stats.ok = false;
      stats.failure = failure;
      stats.reason = failure.code;
      stats.error = failure.message;
      stats.authExpired = failure.fatal;

      console.error(`[AutomationEngine] Sync failed for user ${user?.email} (${failure.code}):`, failure.raw);
      this.emit('sync:error', { user, error: err, stats });
    }

    return stats;
  }
}

// Export a singleton instance
const engine = new AutomationEngine();
module.exports = engine;
