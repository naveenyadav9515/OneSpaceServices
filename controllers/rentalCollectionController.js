const RentalCollection = require('../models/RentalCollection');
const AppError = require('../utils/AppError');
const logger = require('../config/logger');

/**
 * GET /api/rental-collections
 * Returns all rental collection entries for the authenticated user, newest first.
 */
exports.getRentalCollections = async (req, res, next) => {
  try {
    const collections = await RentalCollection.find({ user: req.user.id })
      .sort({ date: -1 })
      .lean();

    res.status(200).json({
      status: 'success',
      results: collections.length,
      data: { collections },
    });
  } catch (err) {
    logger.error('getRentalCollections error', { error: err.message, userId: req.user?.id });
    next(err);
  }
};

/**
 * POST /api/rental-collections
 * Logs a new rental payment for a specific tenant.
 * Body: { tenant, amount, date?, notes? }
 */
exports.createRentalCollection = async (req, res, next) => {
  try {
    const { tenant, amount, date, notes } = req.body;

    if (!tenant || !amount) {
      return next(AppError.badRequest('Tenant and amount are required.'));
    }

    const entry = await RentalCollection.create({
      user: req.user.id,
      tenant: String(tenant).trim(),
      amount: Number(amount),
      date: date && !isNaN(new Date(date).getTime()) ? new Date(date) : new Date(),
      notes: notes ? String(notes).trim() : '',
    });

    logger.info('Rental collection logged', {
      userId: req.user.id,
      entryId: entry._id,
      tenant,
      amount,
    });

    res.status(201).json({
      status: 'success',
      data: { collection: entry },
    });
  } catch (err) {
    logger.error('createRentalCollection error', { error: err.message, userId: req.user?.id });
    next(err);
  }
};

/**
 * DELETE /api/rental-collections/:id
 * Deletes a rental collection entry owned by the authenticated user.
 */
exports.deleteRentalCollection = async (req, res, next) => {
  try {
    const entry = await RentalCollection.findOneAndDelete({
      _id: req.params.id,
      user: req.user.id,
    });

    if (!entry) {
      return next(AppError.notFound('Rental collection entry not found.'));
    }

    logger.info('Rental collection deleted', { userId: req.user.id, entryId: req.params.id });

    res.status(204).json({ status: 'success', data: null });
  } catch (err) {
    logger.error('deleteRentalCollection error', { error: err.message, userId: req.user?.id });
    next(err);
  }
};
