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
    const stats = { processed: 0, created: 0, duplicates: 0, errors: 0, fetchedEmails: [] };

    try {
      if (!user || !user.googleRefreshToken) {
        console.warn('[AutomationEngine] User missing or no refresh token. Skipping.');
        return stats;
      }

      const senderEmails = getAllSenderEmails();
      if (senderEmails.length === 0) {
        console.warn('[AutomationEngine] No bank parsers registered. Skipping.');
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
          
          stats.fetchedEmails.push({
            id: msg.id,
            subject: email.subject,
            from: email.from,
            date: email.metadata?.internalDate ? new Date(parseInt(email.metadata.internalDate)) : null
          });

          // ── 3b. Find the right parser by sender email ──
          // Extract raw email address from "From" header (e.g., "Axis Bank <alerts@axis.bank.in>")
          const senderMatch = email.from.match(/<([^>]+)>/);
          const senderEmail = senderMatch ? senderMatch[1] : email.from;
          const parser = getParserBySender(senderEmail);

          if (!parser) {
            // No parser for this sender — skip silently
            console.log(`[AutomationEngine] No parser found for sender: "${senderEmail}". Skipping.`);
            continue;
          }

          // ── 3c. Check if the email is relevant (e.g., is a debit alert) ──
          if (!parser.isRelevant(email.subject)) {
            console.log(`[AutomationEngine] Email ${msg.id} not relevant (subject didn't match). Skipping.`);
            continue;
          }

          // ── 3d. Parse the email into a structured transaction ──
          const transaction = parser.parse(email.subject, email.body, email.metadata);
          if (!transaction) {
            console.warn(`[AutomationEngine] Parser returned null for email ${msg.id}. Amount extraction failed.`);
            continue;
          }
          console.log(`[AutomationEngine] Parsed: amount=${transaction.amount}, merchant="${transaction.merchant}", date=${transaction.date}`);

          // Skip if parsed date falls before cutoff
          if (transaction.date < cutoffDate) {
            console.log(`[AutomationEngine] Email ${msg.id} date ${transaction.date} before cutoff ${cutoffDate.toISOString()}. Skipping.`);
            continue;
          }

          // ── 3e. Check for duplicates ──
          const duplicate = await isDuplicate(user._id, transaction);
          if (duplicate) {
            stats.duplicates++;
            console.log(`[AutomationEngine] Email ${msg.id} is a duplicate. Skipping.`);
            continue;
          }

          // ── 3f. Create pending transaction ──
          const pending = await createPendingTransaction(user._id, transaction);
          stats.created++;
          console.log(`[AutomationEngine] ✅ Created pending transaction: ${pending._id} (₹${transaction.amount})`);

          // Emit event for future modules (push notifications, etc.)
          this.emit('transaction:created', { user, transaction: pending });

        } catch (emailErr) {
          stats.errors++;
          console.error(`[AutomationEngine] Error processing email ${msg.id}:`, emailErr.message);
        }
      }

      this.emit('sync:complete', { user, stats });
      console.log(`[AutomationEngine] Sync complete for ${user.email}: ${stats.created} created, ${stats.duplicates} duplicates, ${stats.errors} errors`);

    } catch (err) {
      console.error(`[AutomationEngine] Fatal error for user ${user?.email}:`, err.message);
      this.emit('sync:error', { user, error: err });
    }

    return stats;
  }
}

// Export a singleton instance
const engine = new AutomationEngine();
module.exports = engine;
