const NannaExpense = require('../models/NannaExpense');
const NannaMonthBudget = require('../models/NannaMonthBudget');
const AppError = require('../utils/AppError');
const logger = require('../config/logger');

/**
 * GET /api/nanna-expenses
 * Returns all Nanna expenses for the authenticated user, sorted newest-first.
 */
exports.getNannaExpenses = async (req, res, next) => {
  try {
    const expenses = await NannaExpense.find({ user: req.user.id })
      .sort({ date: -1 })
      .lean();

    res.status(200).json({
      status: 'success',
      results: expenses.length,
      data: { expenses },
    });
  } catch (err) {
    logger.error('getNannaExpenses error', { error: err.message, userId: req.user?.id });
    next(err);
  }
};

/**
 * POST /api/nanna-expenses
 * Creates a new Nanna expense entry.
 * Body: { amount, reason, date?, notes? }
 */
exports.createNannaExpense = async (req, res, next) => {
  try {
    const { amount, reason, date, notes } = req.body;

    if (!amount || !reason) {
      return next(AppError.badRequest('Amount and reason are required.'));
    }

    const expense = await NannaExpense.create({
      user: req.user.id,
      amount: Number(amount),
      reason: String(reason).trim(),
      date: date ? new Date(date) : new Date(),
      notes: notes ? String(notes).trim() : '',
    });

    logger.info('Nanna expense created', { userId: req.user.id, expenseId: expense._id, amount });

    res.status(201).json({
      status: 'success',
      data: { expense },
    });
  } catch (err) {
    logger.error('createNannaExpense error', { error: err.message, userId: req.user?.id });
    next(err);
  }
};

/**
 * PUT /api/nanna-expenses/:id
 * Updates an existing Nanna expense.
 * Body: { amount?, reason?, date?, notes? }
 */
exports.updateNannaExpense = async (req, res, next) => {
  try {
    const { amount, reason, date, notes } = req.body;

    const expense = await NannaExpense.findOne({
      _id: req.params.id,
      user: req.user.id,
    });

    if (!expense) {
      return next(AppError.notFound('Nanna expense not found.'));
    }

    if (amount !== undefined) expense.amount = Number(amount);
    if (reason !== undefined) expense.reason = String(reason).trim();
    if (date !== undefined) expense.date = new Date(date);
    if (notes !== undefined) expense.notes = String(notes).trim();

    await expense.save();

    res.status(200).json({
      status: 'success',
      data: { expense },
    });
  } catch (err) {
    logger.error('updateNannaExpense error', { error: err.message, userId: req.user?.id });
    next(err);
  }
};

/**
 * DELETE /api/nanna-expenses/:id
 * Deletes a Nanna expense owned by the authenticated user.
 */
exports.deleteNannaExpense = async (req, res, next) => {
  try {
    const expense = await NannaExpense.findOneAndDelete({
      _id: req.params.id,
      user: req.user.id,
    });

    if (!expense) {
      return next(AppError.notFound('Nanna expense not found.'));
    }

    logger.info('Nanna expense deleted', { userId: req.user.id, expenseId: req.params.id });

  res.status(204).json({ status: 'success', data: null });
  } catch (err) {
    logger.error('deleteNannaExpense error', { error: err.message, userId: req.user?.id });
    next(err);
  }
};

/**
 * GET /api/nanna-expenses/budgets
 * Returns all month budgets set by the authenticated user.
 * Response: { budgets: [{ year, month, budget }] }
 */
exports.getMonthBudgets = async (req, res, next) => {
  try {
    const budgets = await NannaMonthBudget.find({ user: req.user.id })
      .select('year month budget -_id')
      .lean();

    res.status(200).json({
      status: 'success',
      data: { budgets },
    });
  } catch (err) {
    logger.error('getMonthBudgets error', { error: err.message, userId: req.user?.id });
    next(err);
  }
};

/**
 * PUT /api/nanna-expenses/budgets/:year/:month
 * Creates or updates the budget for a specific year/month.
 * Body: { budget: Number }
 */
exports.upsertMonthBudget = async (req, res, next) => {
  try {
    const year = parseInt(req.params.year, 10);
    const month = parseInt(req.params.month, 10); // 1-indexed

    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
      return next(AppError.badRequest('Invalid year or month.'));
    }

    const budget = Number(req.body.budget);
    if (isNaN(budget) || budget < 0) {
      return next(AppError.badRequest('Budget must be a non-negative number.'));
    }

    const record = await NannaMonthBudget.findOneAndUpdate(
      { user: req.user.id, year, month },
      { budget },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    logger.info('Nanna month budget upserted', { userId: req.user.id, year, month, budget });

    res.status(200).json({
      status: 'success',
      data: { budget: { year: record.year, month: record.month, budget: record.budget } },
    });
  } catch (err) {
    logger.error('upsertMonthBudget error', { error: err.message, userId: req.user?.id });
    next(err);
  }
};
