const User = require('../models/User');
const { successResponse, errorResponse } = require('../utils/response');

/**
 * GET /api/v1/dashboard/budget
 * Get current user's monthly budget limit
 */
exports.getBudget = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const user = await User.findById(userId).select('monthlyBudgetLimit currency');
    const limit = user?.monthlyBudgetLimit ?? null;
    const currency = user?.currency || 'NGN';

    return successResponse(
      res,
      { monthlyBudgetLimit: limit, currency },
      'Budget retrieved successfully'
    );
  } catch (error) {
    console.error('Get budget error:', error);
    return errorResponse(res, 'Failed to retrieve budget', 500, error.message);
  }
};

/**
 * PUT /api/v1/dashboard/budget
 * Set or update monthly budget limit
 */
exports.updateBudget = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    let { amount } = req.body;
    const num = amount === null || amount === undefined || amount === '' ? null : parseFloat(amount);

    if (num !== null && (isNaN(num) || num < 0)) {
      return errorResponse(res, 'Amount must be a non-negative number', 400);
    }
    if (num !== null && num > 50_000_000) {
      return errorResponse(res, 'Budget cannot exceed ₦50,000,000', 400);
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { monthlyBudgetLimit: num },
      { new: true }
    ).select('monthlyBudgetLimit currency');

    return successResponse(
      res,
      { monthlyBudgetLimit: user.monthlyBudgetLimit, currency: user.currency },
      user.monthlyBudgetLimit != null ? 'Budget updated successfully' : 'Budget cleared successfully'
    );
  } catch (error) {
    console.error('Update budget error:', error);
    return errorResponse(res, 'Failed to update budget', 500, error.message);
  }
};
