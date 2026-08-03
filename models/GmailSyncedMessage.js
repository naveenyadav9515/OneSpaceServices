const mongoose = require('mongoose');

/**
 * Ledger of Gmail message IDs this user's sync has already looked at.
 *
 * This is the load-bearing piece of the whole sync design. Because it records a
 * verdict for *every* message the engine resolves — including the ones that
 * produce nothing, like statements and promos from the same sender — repeated
 * scanning of the same window is nearly free. `messages.get` costs 5 quota units
 * and is issued only for IDs absent from here.
 *
 * That is what makes the rest of the architecture affordable: the reconciliation
 * sweep can re-read the entire retention window every couple of hours, and the
 * incremental query can overlap generously behind its watermark, precisely
 * because re-seeing a known message costs one indexed lookup instead of a
 * download.
 */

/**
 * How long an entry is kept.
 *
 * MUST stay comfortably above `gmailSync.lookbackDays` (7). An entry that
 * expires while its message is still inside the sweep window gets re-downloaded
 * — correct, just wasteful — so the margin here is deliberate slack, not a
 * tuning knob. Raise it before raising the lookback.
 */
const LEDGER_TTL_DAYS = 30;

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
