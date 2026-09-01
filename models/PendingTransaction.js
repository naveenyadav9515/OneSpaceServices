const mongoose = require('mongoose');

const pendingTransactionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  amount: {
    type: Number,
    required: [true, 'Please provide an amount'],
  },
  title: {
    type: String,
    trim: true,
    default: '',
  },
  merchant: {
    type: String,
    required: [true, 'Please provide a merchant or reason'],
    trim: true,
  },
  category: {
    type: String,
    trim: true,
    default: 'Other',
  },
  paymentMethod: {
    type: String,
    trim: true,
    default: 'UPI',
  },
  date: {
    type: Date,
    default: Date.now,
  },
  notes: {
    type: String,
    default: '',
  },
  tags: {
    type: [String],
    default: [],
  },
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Rejected'],
    default: 'Pending',
  },

  // ── Gmail Deduplication Fields ──

  /**
   * Gmail's immutable message ID. This is the PRIMARY deduplication key.
   * Each bank transaction email has a unique msg.id in Gmail.
   * Before creating a PendingTransaction, we check if this gmailMessageId
   * already exists. If it does, we skip — guaranteed no duplicates.
   */
  gmailMessageId: {
    type: String,
    default: null,
    index: true,
  },

  /**
   * Source of the transaction record.
   * 'gmail_auto' = parsed from Gmail bank email
   * 'manual'     = manually entered by user
   * 'simulated'  = created by the simulator endpoint
   */
  source: {
    type: String,
    enum: ['gmail_auto', 'manual', 'simulated'],
    default: 'manual',
  },

  // ── Bank & Parsing Metadata ──

  /** Bank that sent the alert (e.g., 'Axis', 'HDFC') */
  bank: {
    type: String,
    default: 'Unknown',
  },

  /** Transaction type extracted from email */
  transactionType: {
    type: String,
    enum: ['Debit', 'Credit'],
    default: 'Debit',
  },

  /** Whether the email was successfully parsed */
  parsedSuccessfully: {
    type: Boolean,
    default: true,
  },

  /** Original email subject line for debugging */
  rawSubject: {
    type: String,
    default: '',
  }
}, {
  timestamps: true,
});

/**
 * Compound unique index: one Gmail message can only create one pending transaction per user.
 * This is the DATABASE-LEVEL guarantee against duplicates.
 *
 * The partial filter restricts uniqueness to documents where gmailMessageId is a
 * string, so manual entries (which leave it null) are unaffected.
 *
 * Note: `sparse` must NOT be combined with `partialFilterExpression` — MongoDB
 * rejects that combination outright — and `$ne` is not a supported operator
 * inside a partial filter. Either mistake makes the index fail to build, which
 * silently removes the uniqueness guarantee this comment promises.
 */
pendingTransactionSchema.index(
  { user: 1, gmailMessageId: 1 },
  { unique: true, partialFilterExpression: { gmailMessageId: { $type: 'string' } } }
);

/** Supports the pending-list query: find({ user, status }).sort({ date: -1 }) */
pendingTransactionSchema.index({ user: 1, status: 1, date: -1 });

/**
 * Supports the same-minute duplicate check the sync runs for every parsed
 * transaction: find({ user, amount, merchant, date: { $gte, $lte } }).
 *
 * The index above leads with `status`, which that query does not constrain, so
 * it cannot be used for this shape.
 */
pendingTransactionSchema.index({ user: 1, amount: 1, merchant: 1, date: 1 });

module.exports = mongoose.model('PendingTransaction', pendingTransactionSchema);
