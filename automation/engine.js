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

/**
 * Detects a Google credential failure (revoked consent, expired/rotated refresh
 * token, wrong client). These require the user to reconnect — retrying won't help.
 * @param {Error} err
 * @returns {boolean}
 */
function isAuthError(err) {
  if (!err) return false;
  const status = err.code || err.status || err.response?.status;
  if (status === 401 || status === 403) return true;
  const message = `${err.message || ''} ${err.response?.data?.error || ''}`;
  return /invalid_grant|invalid_credentials|unauthorized_client|Token has been expired or revoked|insufficient (?:permission|scope)/i.test(message);
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
        return stats;
      }

      const senderEmails = getAllSenderEmails();
      if (senderEmails.length === 0) {
        console.warn('[AutomationEngine] No bank parsers registered. Skipping.');
        stats.ok = false;
        stats.reason = 'no_parsers';
        stats.error = 'No bank parsers are registered on the server.';
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
          const entry = stats.fetchedEmails[stats.fetchedEmails.length - 1];
          if (entry && entry.id === msg.id) entry.outcome = `error: ${emailErr.message}`;
          console.error(`[AutomationEngine] Error processing email ${msg.id}:`, emailErr.message);
        }
      }

      this.emit('sync:complete', { user, stats });
      console.log(`[AutomationEngine] Sync complete for ${user.email}: ${stats.created} created, ${stats.duplicates} duplicates, ${stats.errors} errors`);

    } catch (err) {
      // A fatal error here means we reached NO emails — never report it as a
      // successful sync, or a revoked token looks identical to an empty inbox.
      stats.ok = false;
      stats.error = err.message;
      stats.authExpired = isAuthError(err);
      stats.reason = stats.authExpired ? 'auth_expired' : 'gmail_error';

      console.error(`[AutomationEngine] Fatal error for user ${user?.email}:`, err.message);
      this.emit('sync:error', { user, error: err, stats });
    }

    return stats;
  }
}

// Export a singleton instance
const engine = new AutomationEngine();
module.exports = engine;
