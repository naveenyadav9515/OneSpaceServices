const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  amount: {
    type: Number,
    required: [true, 'Please provide an amount'],
    min: [0, 'Amount cannot be negative'],
  },
  title: {
    type: String,
    trim: true,
    default: '',
  },
  category: {
    type: String,
    required: [true, 'Please provide a category'],
    trim: true,
    default: 'Other',
  },
  merchant: {
    type: String,
    required: [true, 'Please provide a merchant or reason'],
    trim: true,
  },
  tags: {
    type: [String],
    default: [],
  },
  notes: {
    type: String,
    trim: true,
    default: '',
  },
  date: {
    type: Date,
    default: Date.now,
  },
  paymentMethod: {
    type: String,
    trim: true,
    default: 'UPI',
  },
  gmailMessageId: {
    type: String,
    default: null,
    index: true,
  },
  source: {
    type: String,
    enum: ['gmail_auto', 'manual', 'simulated'],
    default: 'manual',
    index: true,
  },
  isManuallyEdited: {
    type: Boolean,
    default: false,
  },
  lastEditedAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

expenseSchema.pre('save', function (next) {
  if (this.gmailMessageId && (!this.source || this.source === 'manual')) {
    this.source = 'gmail_auto';
  }
  if (typeof next === 'function') {
    next();
  }
});


/**
 * One Gmail message can only ever become one expense per user.
 *
 * This previously read `{ unique: true, sparse: true, partialFilterExpression:
 * { gmailMessageId: { $ne: null } } }`, which is invalid twice over: MongoDB
 * rejects `sparse` combined with `partialFilterExpression`, and `$ne` is not a
 * supported operator inside a partial filter. The index therefore never built,
 * and the uniqueness this guards was not being enforced at all — approving the
 * same pending transaction twice, or two clients racing the same approval,
 * silently produced duplicate expenses.
 *
 * `$type: 'string'` is the form that actually works, and it leaves manual
 * entries (gmailMessageId null) out of the constraint. Same as the equivalent
 * index on PendingTransaction — see the note there.
 */
expenseSchema.index(
  { user: 1, gmailMessageId: 1 },
  { unique: true, partialFilterExpression: { gmailMessageId: { $type: 'string' } } }
);

/** Supports the summary aggregations: find({ user, date: { $gte, $lte } }) */
expenseSchema.index({ user: 1, date: -1 });

/**
 * Supports the same-minute duplicate check the sync runs for every parsed
 * transaction: find({ user, amount, merchant, date: { $gte, $lte } }).
 *
 * `{ user, date }` above only half-covers that shape, leaving the merchant and
 * amount to be filtered in memory over every expense the user logged that day.
 */
expenseSchema.index({ user: 1, amount: 1, merchant: 1, date: 1 });

module.exports = mongoose.model('Expense', expenseSchema);
