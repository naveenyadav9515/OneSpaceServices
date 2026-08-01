const mongoose = require('mongoose');

/**
 * Ledger of Gmail message IDs this user's sync has already looked at.
 *
 * Without it, every sync re-downloaded every message in the lookback window.
 * `messages.get` costs 5 Gmail quota units, so a mailbox with 300 bank alerts in
 * the window burned 1,500 units per sync — on every Pub/Sub push, of which Gmail
 * sends one for *any* inbox change, not just bank mail. That is how a healthy
 * account walks into a 429.
 *
 * PendingTransaction.gmailMessageId only records messages that produced a
 * transaction. The expensive ones are the messages that produce nothing —
 * promos, OTPs, credit alerts from the same sender — because they leave no trace
 * and so were fetched again, in full, forever. This collection records the
 * outcome for *every* message the engine has resolved, so each one costs its
 * 5 units exactly once.
 */

/**
 * How long an entry is kept.
 *
 * MUST stay comfortably above the widest sync window (the previous-month floor,
 * or GMAIL_SYNC_LOOKBACK_DAYS if that reaches further back). If an entry expires
 * while its message is still inside the window, that message gets re-fetched —
 * correct, just wasteful.
 */
const LEDGER_TTL_DAYS = 180;

const gmailSyncedMessageSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  /** Gmail's immutable message ID. */
  messageId: {
    type: String,
    required: true,
  },

  /**
   * What the engine decided, verbatim from the sync debug entry
   * (e.g. 'skipped: subject not a debit alert'). Diagnostic only — nothing
   * branches on it. Kept because "why was this email ignored?" is otherwise
   * unanswerable once the sync log has rotated.
   */
  outcome: {
    type: String,
    default: '',
  },

  /** Drives the TTL index below. */
  syncedAt: {
    type: Date,
    default: Date.now,
    expires: `${LEDGER_TTL_DAYS}d`,
  },
}, { timestamps: false });

/**
 * One row per (user, message). Unique so a concurrent sync racing the same
 * message cannot double-insert; writers use unordered bulk inserts and ignore
 * the resulting duplicate-key errors.
 */
gmailSyncedMessageSchema.index({ user: 1, messageId: 1 }, { unique: true });

module.exports = mongoose.model('GmailSyncedMessage', gmailSyncedMessageSchema);
module.exports.LEDGER_TTL_DAYS = LEDGER_TTL_DAYS;
