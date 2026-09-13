const User = require('../models/User');
const RentalCollection = require('../models/RentalCollection');
const AppError = require('../utils/AppError');
const logger = require('../config/logger');

const DEFAULT_TENANTS = ['Mahesh', 'Sai', 'Geetha', 'Prasad', 'Rekha'];

/**
 * Helper to get or initialize a user's rental tenants.
 */
async function getUserTenants(userId) {
  const user = await User.findById(userId).select('rentalTenants');
  if (!user) return [];

  // If user has no rentalTenants configured yet, initialize from defaults + any distinct past records
  if (!user.rentalTenants || user.rentalTenants.length === 0) {
    let distinctTenants = [];
    try {
      distinctTenants = await RentalCollection.distinct('tenant', { user: userId });
    } catch (_) {}

    const initialNames = Array.from(new Set([...DEFAULT_TENANTS, ...(distinctTenants || [])]));
    user.rentalTenants = initialNames.map(name => ({
      name,
      isActive: true,
      createdAt: new Date(),
    }));
    await user.save();
  }

  return user.rentalTenants;
}

/**
 * GET /api/rental-collections/tenants
 * Returns all tenants for the authenticated user, including active status.
 */
exports.getTenants = async (req, res, next) => {
  try {
    const tenantsList = await getUserTenants(req.user.id);
    const activeTenants = tenantsList.filter(t => t.isActive).map(t => t.name);

    res.status(200).json({
      status: 'success',
      results: tenantsList.length,
      data: {
        tenants: tenantsList.map(t => ({
          name: t.name,
          isActive: t.isActive,
          createdAt: t.createdAt,
        })),
        activeTenants,
      },
    });
  } catch (err) {
    logger.error('getTenants error', { error: err.message, userId: req.user?.id });
    next(err);
  }
};

/**
 * POST /api/rental-collections/tenants
 * Adds a new tenant to the user's tenant list.
 */
exports.addTenant = async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return next(AppError.badRequest('Tenant name is required.'));
    }

    const trimmedName = name.trim();
    if (trimmedName.length > 50) {
      return next(AppError.badRequest('Tenant name must be 50 characters or less.'));
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return next(AppError.notFound('User not found.'));
    }

    if (!user.rentalTenants || user.rentalTenants.length === 0) {
      await getUserTenants(req.user.id);
    }

    // Refresh user's rentalTenants
    const freshUser = await User.findById(req.user.id);
    const existingIndex = freshUser.rentalTenants.findIndex(
      t => t.name.toLowerCase() === trimmedName.toLowerCase()
    );

    if (existingIndex !== -1) {
      // If already exists and disabled, re-enable it
      if (!freshUser.rentalTenants[existingIndex].isActive) {
        freshUser.rentalTenants[existingIndex].isActive = true;
        await freshUser.save();
        return res.status(200).json({
          status: 'success',
          message: `Tenant "${freshUser.rentalTenants[existingIndex].name}" re-enabled.`,
          data: {
            tenant: freshUser.rentalTenants[existingIndex],
            tenants: freshUser.rentalTenants,
            activeTenants: freshUser.rentalTenants.filter(t => t.isActive).map(t => t.name),
          },
        });
      }
      return next(AppError.badRequest(`Tenant "${trimmedName}" already exists.`));
    }

    const newTenant = {
      name: trimmedName,
      isActive: true,
      createdAt: new Date(),
    };
    freshUser.rentalTenants.push(newTenant);
    await freshUser.save();

    logger.info('Tenant added', { userId: req.user.id, tenant: trimmedName });

    res.status(201).json({
      status: 'success',
      data: {
        tenant: newTenant,
        tenants: freshUser.rentalTenants,
        activeTenants: freshUser.rentalTenants.filter(t => t.isActive).map(t => t.name),
      },
    });
  } catch (err) {
    logger.error('addTenant error', { error: err.message, userId: req.user?.id });
    next(err);
  }
};

/**
 * PATCH /api/rental-collections/tenants/:name/toggle
 * Toggles a tenant's active/disabled status.
 */
exports.toggleTenant = async (req, res, next) => {
  try {
    const { name } = req.params;
    if (!name) {
      return next(AppError.badRequest('Tenant name is required.'));
    }

    const decodedName = decodeURIComponent(name).trim();
    const user = await User.findById(req.user.id);
    if (!user) {
      return next(AppError.notFound('User not found.'));
    }

    if (!user.rentalTenants || user.rentalTenants.length === 0) {
      await getUserTenants(req.user.id);
    }

    const freshUser = await User.findById(req.user.id);
    const tenant = freshUser.rentalTenants.find(
      t => t.name.toLowerCase() === decodedName.toLowerCase()
    );

    if (!tenant) {
      return next(AppError.notFound(`Tenant "${decodedName}" not found.`));
    }

    if (req.body && typeof req.body.isActive === 'boolean') {
      tenant.isActive = req.body.isActive;
    } else {
      tenant.isActive = !tenant.isActive;
    }

    await freshUser.save();

    logger.info('Tenant status toggled', {
      userId: req.user.id,
      tenant: tenant.name,
      isActive: tenant.isActive,
    });

    res.status(200).json({
      status: 'success',
      data: {
        tenant,
        tenants: freshUser.rentalTenants,
        activeTenants: freshUser.rentalTenants.filter(t => t.isActive).map(t => t.name),
      },
    });
  } catch (err) {
    logger.error('toggleTenant error', { error: err.message, userId: req.user?.id });
    next(err);
  }
};

/**
 * DELETE /api/rental-collections/tenants/:name
 * Removes a tenant, or disables them if payment records exist.
 */
exports.deleteTenant = async (req, res, next) => {
  try {
    const { name } = req.params;
    const decodedName = decodeURIComponent(name).trim();

    const paymentsCount = await RentalCollection.countDocuments({
      user: req.user.id,
      tenant: decodedName,
    });

    const user = await User.findById(req.user.id);
    if (!user || !user.rentalTenants) {
      return next(AppError.notFound('Tenant not found.'));
    }

    const tenantIndex = user.rentalTenants.findIndex(
      t => t.name.toLowerCase() === decodedName.toLowerCase()
    );

    if (tenantIndex === -1) {
      return next(AppError.notFound(`Tenant "${decodedName}" not found.`));
    }

    if (paymentsCount > 0) {
      user.rentalTenants[tenantIndex].isActive = false;
      await user.save();
      return res.status(200).json({
        status: 'success',
        message: `Tenant has ${paymentsCount} payment records and was disabled instead of deleted.`,
        data: {
          tenant: user.rentalTenants[tenantIndex],
          tenants: user.rentalTenants,
          activeTenants: user.rentalTenants.filter(t => t.isActive).map(t => t.name),
        },
      });
    }

    user.rentalTenants.splice(tenantIndex, 1);
    await user.save();

    logger.info('Tenant deleted', { userId: req.user.id, tenant: decodedName });

    res.status(200).json({
      status: 'success',
      data: {
        tenants: user.rentalTenants,
        activeTenants: user.rentalTenants.filter(t => t.isActive).map(t => t.name),
      },
    });
  } catch (err) {
    logger.error('deleteTenant error', { error: err.message, userId: req.user?.id });
    next(err);
  }
};

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
