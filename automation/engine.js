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
const {
  isDuplicate,
  createPendingTransaction,
  filterUnprocessedMessageIds,
  recordProcessedMessages,
} = require('./processors/expense-processor');
const { classifyGoogleError } = require('../utils/google-error.util');
const { getGmailCooldownRemainingMs, acquireSyncLock, releaseSyncLock } = require('../utils/gmail-state.util');

/**
 * Renders a cooldown as something a person can act on.
 * @param {number} ms
 * @returns {string} e.g. "about 4 minutes" / "under a minute"
 */
function describeWait(ms) {
  const minutes = Math.ceil(ms / 60000);
  if (minutes <= 1) return 'under a minute';
  return `about ${minutes} minutes`;
}

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

/**
 * Messages fetched concurrently.
 *
 * Gmail allows 250 quota units per user per second and `messages.get` costs 5,
 * so the hard ceiling is 50 in-flight. Five keeps the sync an order of magnitude
 * clear of it while still being ~5x faster than the sequential walk.
 */
const FETCH_CONCURRENCY = 5;

/**
 * Messages downloaded per sync run.
 *
 * Bounds how long a single request can take. Anything above the cap is left for
 * the next sync, which resumes cheaply because the ledger already records what
 * was done.
 */
const MAX_FETCHES_PER_SYNC = 150;

class AutomationEngine extends EventEmitter {
  constructor() {
    super();
    // Prevent memory leak warnings for many listeners
    this.setMaxListeners(20);

    /**
     * Syncs currently running, keyed by user id.
     *
     * Gmail sends a Pub/Sub push for *every* inbox change, and the Refresh button
     * can fire on top of them. Nothing serialised those, so several full syncs for
     * one mailbox ran concurrently, each issuing its own `messages.get` storm —
     * the surest way to cross Gmail's per-user 250 quota-units-per-second ceiling.
     *
     * A caller arriving while a sync is in flight now waits for that sync's result
     * rather than starting a competing one.
     * @type {Map<string, Promise<object>>}
     */
    this.inFlight = new Map();
  }

  /**
   * Main entry point — processes Gmail emails for a single user.
   *
   * This is the ONLY function that controllers should call. Concurrent calls for
   * the same user share one run; see `inFlight`.
   *
   * @param {object} user - User document with googleRefreshToken (already selected)
   * @returns {Promise<{processed: number, created: number, duplicates: number, errors: number}>}
   */
  async processUserEmails(user) {
    const key = String(user?._id || user?.id || '');
    if (!key) return this.runSync(user);

    const running = this.inFlight.get(key);
    if (running) {
      console.log(`[AutomationEngine] Sync already running for ${user.email} — joining it instead of starting a second.`);
      return running;
    }

    const run = this.runSync(user).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  /**
   * Resolves one Gmail message: fetch → parse → deduplicate → record.
   *
   * Mutates `stats` and appends to `ledgerEntries`. Runs concurrently with other
   * copies of itself, so it must not depend on ordering — in particular it holds
   * its own `debugEntry` rather than reaching for the last one pushed, which is
   * what the sequential version did and what parallelism would have broken.
   *
   * @param {{gmail: object, user: object, msg: {id: string}, cutoffDate: Date,
   *          stats: object, ledgerEntries: Array<{id: string, outcome: string}>}} ctx
   * @returns {Promise<object|null>} the failure that should stop the sync, or null
   */
  async processMessage({ gmail, user, msg, cutoffDate, stats, ledgerEntries }) {
    // Created before the fetch so a failed download still has somewhere to
    // report itself.
    const debugEntry = { id: msg.id, subject: '', from: '', date: null, outcome: 'processing' };
    stats.fetchedEmails.push(debugEntry);

    /**
     * Records this message's final verdict — for the sync report the UI shows,
     * and for the ledger so the message is never downloaded again. Every
     * terminal branch below must go through this.
     * @param {string} outcome
     */
    const resolve = (outcome) => {
      debugEntry.outcome = outcome;
      ledgerEntries.push({ id: msg.id, outcome });
    };

    try {
      stats.processed++;

      const email = await fetchEmailContent(gmail, msg.id);
      debugEntry.subject = email.subject;
      debugEntry.from = email.from;
      debugEntry.date = email.metadata?.internalDate ? new Date(parseInt(email.metadata.internalDate)) : null;
      console.log(`[AutomationEngine] Email ${msg.id}: subject="${email.subject}", from="${email.from}"`);

      // Find the right parser by sender email.
      // Extract raw address from the "From" header (e.g. "Axis Bank <alerts@axis.bank.in>").
      const senderMatch = email.from.match(/<([^>]+)>/);
      const senderEmail = senderMatch ? senderMatch[1] : email.from;
      const parser = getParserBySender(senderEmail);

      if (!parser) {
        stats.skipped.noParser++;
        resolve('skipped: no parser for sender');
        console.log(`[AutomationEngine] No parser found for sender: "${senderEmail}". Skipping.`);
        return null;
      }

      if (!parser.isRelevant(email.subject)) {
        stats.skipped.notRelevant++;
        resolve('skipped: subject not a debit alert');
        console.log(`[AutomationEngine] Email ${msg.id} not relevant (subject didn't match). Skipping.`);
        return null;
      }

      const transaction = parser.parse(email.subject, email.body, email.metadata);
      if (!transaction) {
        stats.skipped.parseFailed++;
        resolve('skipped: no debit amount found');
        console.warn(`[AutomationEngine] Parser returned null for email ${msg.id}. Amount extraction failed.`);
        return null;
      }
      console.log(`[AutomationEngine] Parsed: amount=${transaction.amount}, merchant="${transaction.merchant}", date=${transaction.date}`);

      if (transaction.date < cutoffDate) {
        stats.skipped.beforeCutoff++;
        resolve('skipped: older than sync window');
        console.log(`[AutomationEngine] Email ${msg.id} date ${transaction.date} before cutoff ${cutoffDate.toISOString()}. Skipping.`);
        return null;
      }

      if (await isDuplicate(user._id, transaction)) {
        stats.duplicates++;
        resolve('duplicate — already recorded');
        console.log(`[AutomationEngine] Email ${msg.id} is a duplicate. Skipping.`);
        return null;
      }

      const created = await createPendingTransaction(user._id, transaction);

      // A null result means the unique index rejected a concurrent insert.
      if (!created) {
        stats.duplicates++;
        resolve('duplicate — already recorded');
        console.log(`[AutomationEngine] Email ${msg.id} lost a create race. Counted as duplicate.`);
        return null;
      }

      stats.created++;
      resolve(`created: ₹${transaction.amount} · ${transaction.merchant}`);
      console.log(`[AutomationEngine] ✅ Created pending transaction: ${created._id} (₹${transaction.amount})`);

      // Emit event for future modules (push notifications, etc.)
      this.emit('transaction:created', { user, transaction: created });
      return null;

    } catch (emailErr) {
      stats.errors++;
      const failure = classifyGoogleError(emailErr);
      debugEntry.outcome = `error: ${failure.message}`;
      console.error(`[AutomationEngine] Error processing email ${msg.id} (${failure.code}):`, failure.raw);

      // Google has started refusing us — the caller stops rather than burn the
      // rest of the window on calls that will fail the same way.
      return shouldAbortSync(failure) ? failure : null;
    }
  }

  /**
   * Performs the sync itself: fetch emails → parse → deduplicate → create pending
   * transactions. Never call directly — go through `processUserEmails`.
   *
   * @param {object} user
   * @returns {Promise<object>} stats
   */
  async runSync(user) {
    const stats = {
      ok: true,
      reason: null,
      error: null,
      /** Full classification of the failure, when there was one. @see classifyGoogleError */
      failure: null,
      authExpired: false,
      /** How long the client should wait before offering to sync again. */
      retryAfterSeconds: null,
      /** New messages this run deliberately left for the next sync. */
      remaining: 0,
      processed: 0,
      created: 0,
      duplicates: 0,
      errors: 0,
      skipped: { noParser: 0, notRelevant: 0, parseFailed: 0, beforeCutoff: 0, alreadySynced: 0 },
      fetchedEmails: [],
    };

    /**
     * Verdicts to append to the message ledger once the walk finishes.
     *
     * Buffered rather than written per message so a 300-email sync costs one
     * bulk write instead of 300 round trips. Flushed on the abort path too —
     * dropping them would make the next sync re-download everything this one
     * already paid for.
     * @type {Array<{id: string, outcome: string}>}
     */
    const ledgerEntries = [];

    /** Whether this run holds the database sync lock, so `finally` knows to free it. */
    let holdsLock = false;

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

      // Google told us to back off and the deadline has not passed. Calling
      // anyway does not shorten the block — every rejected request still counts
      // against the quota that is already exhausted.
      const cooldownMs = getGmailCooldownRemainingMs(user);
      if (cooldownMs > 0) {
        stats.ok = false;
        stats.reason = 'rate_limited';
        stats.retryAfterSeconds = Math.ceil(cooldownMs / 1000);
        stats.error = `Google is still rate-limiting this account. Syncing resumes in ${describeWait(cooldownMs)}.`;
        stats.failure = {
          code: 'rate_limited',
          message: stats.error,
          fatal: false,
          retryable: true,
          // Null, not the remaining time: the deadline is already stored, and
          // re-deriving it here would push it further out on every attempt.
          retryAfterMs: null,
        };
        console.warn(`[AutomationEngine] Skipping sync for ${user.email} — cooling down for another ${Math.ceil(cooldownMs / 1000)}s.`);
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

      // The in-process guard above stops duplicate syncs within this Node
      // process. This one holds across processes: Render restarts containers
      // freely, and a redeploy mid-sync would otherwise leave the old and new
      // instance scanning the same mailbox at once.
      holdsLock = await acquireSyncLock(user._id);
      if (!holdsLock) {
        stats.ok = false;
        stats.reason = 'sync_in_progress';
        stats.error = 'A sync for this account is already running. Its results will appear shortly.';
        stats.failure = { code: 'sync_in_progress', message: stats.error, fatal: false, retryable: true, retryAfterMs: null };
        console.log(`[AutomationEngine] Another process holds the sync lock for ${user.email}. Standing down.`);
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

      // ── 2b. Drop everything we have already resolved, BEFORE downloading it ──
      //
      // `messages.get` costs 5 quota units each. Deduplicating only after the
      // download meant re-paying for the entire window on every single sync, so
      // an untouched mailbox cost exactly as much as a busy one. This is the
      // single biggest source of the 429s.
      const messageIds = messages.map(m => m.id);
      const unprocessedIds = new Set(await filterUnprocessedMessageIds(user._id, messageIds));
      stats.skipped.alreadySynced = messageIds.length - unprocessedIds.size;

      // ── 3. Decide how much to take on in this run ──
      //
      // A first connect can face thousands of messages. Fetching all of them
      // inline made `POST /expenses/sync` run for minutes, long enough for the
      // browser or Render's gateway to give up — the work continued, but the
      // user saw a failed sync and pressed Refresh again, stacking another one.
      //
      // Taking a fixed slice keeps every request short. Nothing is lost: the
      // ledger records what this run resolved, so the next sync resumes at the
      // remainder instead of starting over.
      const pending = messages.filter(m => unprocessedIds.has(m.id));
      const batch = pending.slice(0, MAX_FETCHES_PER_SYNC);
      stats.remaining = pending.length - batch.length;

      console.log(`[AutomationEngine] ${messages.length} emails for ${user.email} — ${pending.length} new (fetching ${batch.length}, ${stats.remaining} deferred), ${stats.skipped.alreadySynced} already synced`);

      // ── 4. Fetch and process, a few at a time ──
      //
      // Sequential fetching made a 200-message sync take minutes of round trips.
      // Unbounded parallelism is the opposite failure: Gmail allows 250 quota
      // units per user per second and `messages.get` costs 5, so firing them all
      // at once is a self-inflicted 429. A small fixed pool is quick and stays
      // an order of magnitude under the ceiling.
      const queue = [...batch];
      /** Set by whichever worker hits a failure that must stop the whole sync. */
      let abort = null;

      const worker = async () => {
        while (queue.length > 0 && !abort) {
          const msg = queue.shift();
          const failure = await this.processMessage({ gmail, user, msg, cutoffDate, stats, ledgerEntries });
          if (failure && !abort) abort = { failure, msg };
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, worker)
      );

      if (abort) {
        const { failure } = abort;
        stats.ok = false;
        stats.failure = failure;
        stats.reason = failure.code;
        stats.error = failure.message;
        stats.authExpired = failure.fatal;
        if (failure.retryAfterMs) stats.retryAfterSeconds = Math.ceil(failure.retryAfterMs / 1000);
        console.error(`[AutomationEngine] Aborted sync for ${user.email} after ${stats.processed} emails — ${failure.code}.`);
        this.emit('sync:error', { user, stats });
        return stats;
      }

      this.emit('sync:complete', { user, stats });
      console.log(`[AutomationEngine] Sync complete for ${user.email}: ${stats.created} created, ${stats.duplicates} duplicates, ${stats.errors} errors, ${stats.remaining} deferred`);

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
      if (failure.retryAfterMs) stats.retryAfterSeconds = Math.ceil(failure.retryAfterMs / 1000);

      console.error(`[AutomationEngine] Sync failed for user ${user?.email} (${failure.code}):`, failure.raw);
      this.emit('sync:error', { user, error: err, stats });
    } finally {
      // Flush on every exit, including the abort path. Discarding these because
      // the sync ended badly would make the next attempt re-download — and re-pay
      // for — every message this one already resolved, which is exactly the
      // behaviour that turns one rate-limit into a loop of them.
      await recordProcessedMessages(user?._id, ledgerEntries);
      if (holdsLock) await releaseSyncLock(user._id);
    }

    return stats;
  }
}

// Export a singleton instance
const engine = new AutomationEngine();
module.exports = engine;
