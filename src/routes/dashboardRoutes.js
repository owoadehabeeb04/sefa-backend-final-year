const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const dashboardController = require('../controllers/dashboardController');
const budgetController = require('../controllers/budgetController');

// All routes require authentication
router.use(authenticate);

/**
 * @route   GET /api/v1/dashboard/budget
 * @desc    Get user's monthly budget limit
 * @access  Private
 */
router.get('/budget', budgetController.getBudget);

/**
 * @route   PUT /api/v1/dashboard/budget
 * @desc    Set or update monthly budget limit
 * @access  Private
 */
router.put('/budget', budgetController.updateBudget);

/**
 * @route   GET /api/v1/dashboard/summary
 * @desc    Get dashboard summary with AI insights
 * @access  Private
 */
router.get('/summary', dashboardController.getDashboardSummary);

/**
 * @route   GET /api/v1/dashboard/spending-trends
 * @desc    Get spending trends over time
 * @access  Private
 */
router.get('/spending-trends', dashboardController.getSpendingTrends);

/**
 * @route   GET /api/v1/dashboard/stats
 * @desc    Get overall financial statistics
 * @access  Private
 */
router.get('/stats', dashboardController.getStats);

module.exports = router;
