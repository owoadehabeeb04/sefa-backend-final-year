const AppError = require('../utils/AppError');
const Category = require('../models/Category');

/**
 * Validate budget data
 */
exports.validateBudget = async (req, res, next) => {
  const { category, amount, period, warningThreshold, criticalThreshold } = req.body;

  try {
    // For updates, only validate provided fields
    const isUpdate = req.method === 'PUT';

    // Validate category (required for create)
    if (!isUpdate && !category) {
      throw new AppError('Category is required', 400);
    }

    if (category) {
      // Check if category exists in user's categories
      const categoryExists = await Category.findOne({
        userId: req.user._id,
        name: category
      });

      if (!categoryExists) {
        throw new AppError(`Category '${category}' not found. Please create it first.`, 400);
      }
    }

    // Validate amount (required for create)
    if (!isUpdate && amount === undefined) {
      throw new AppError('Budget amount is required', 400);
    }

    if (amount !== undefined) {
      if (typeof amount !== 'number' || amount <= 0) {
        throw new AppError('Budget amount must be a positive number', 400);
      }

      if (amount > 50000000) { // 50 million max
        throw new AppError('Budget amount is too large (max: ₦50,000,000)', 400);
      }
    }

    // Validate period
    if (period) {
      const validPeriods = ['monthly', 'weekly', 'custom'];
      if (!validPeriods.includes(period)) {
        throw new AppError(`Period must be one of: ${validPeriods.join(', ')}`, 400);
      }
    }

    // Validate thresholds
    if (warningThreshold !== undefined) {
      if (typeof warningThreshold !== 'number' || warningThreshold < 0 || warningThreshold > 100) {
        throw new AppError('Warning threshold must be between 0 and 100', 400);
      }
    }

    if (criticalThreshold !== undefined) {
      if (typeof criticalThreshold !== 'number' || criticalThreshold < 0 || criticalThreshold > 100) {
        throw new AppError('Critical threshold must be between 0 and 100', 400);
      }
    }

    // Validate warning < critical
    const warning = warningThreshold || req.body.warningThreshold || 80;
    const critical = criticalThreshold || req.body.criticalThreshold || 100;
    
    if (warning > critical) {
      throw new AppError('Warning threshold cannot be greater than critical threshold', 400);
    }

    // Validate notes length
    if (req.body.notes && req.body.notes.length > 500) {
      throw new AppError('Notes cannot exceed 500 characters', 400);
    }

    next();
  } catch (error) {
    next(error);
  }
};
