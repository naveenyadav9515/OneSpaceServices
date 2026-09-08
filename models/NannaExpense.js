const mongoose = require('mongoose');

/**
 * NannaExpense — Completely isolated schema for personal "Nanna Expenses".
 * This collection (`nanna_expenses`) is entirely separate from the regular
 * Expense tracker. No cross-references, no shared controllers, no impact on
 * budgets, categories, Gmail sync, or monthly summaries.
 */
const nannaExpenseSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: [true, 'Please provide an amount'],
      min: [0.01, 'Amount must be greater than 0'],
    },
    reason: {
      type: String,
      required: [true, 'Please provide a reason'],
      trim: true,
      maxlength: [200, 'Reason cannot exceed 200 characters'],
    },
    notes: {
      type: String,
      trim: true,
      default: '',
      maxlength: [500, 'Notes cannot exceed 500 characters'],
    },
    date: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/** Support fast per-user chronological listing */
nannaExpenseSchema.index({ user: 1, date: -1 });

module.exports = mongoose.model('NannaExpense', nannaExpenseSchema);
