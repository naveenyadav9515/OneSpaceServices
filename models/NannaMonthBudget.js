const mongoose = require('mongoose');

/**
 * NannaMonthBudget — Stores a monthly budget limit per user for Nanna Expenses.
 * Completely isolated from the regular expense budget system.
 */
const nannaMonthBudgetSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    year: {
      type: Number,
      required: true,
    },
    month: {
      // 1-indexed (1=Jan, 12=Dec) for clarity in the DB
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },
    budget: {
      type: Number,
      required: true,
      min: [0, 'Budget cannot be negative'],
    },
  },
  {
    timestamps: true,
  }
);

// One budget per user per month
nannaMonthBudgetSchema.index({ user: 1, year: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('NannaMonthBudget', nannaMonthBudgetSchema);
