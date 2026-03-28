const express = require('express');
const router = express.Router();
const {
  createBudget,
  getBudgets,
  getBudget,
  updateBudget,
  deleteBudget,
  getBudgetSummary,
  getBudgetAnalytics,
  getSpendingForecast,
  bulkCreateBudgets,
  renewBudget
} = require('../controllers/budget.controller');
const { protect, requireVerifiedEmail, requireOnboardingComplete } = require('../middleware/auth');
const { validateBudget } = require('../middleware/validateBudget');

// All routes require authentication
router.use(protect, requireVerifiedEmail, requireOnboardingComplete);

// Summary endpoint (must be before /:id routes)
router.get('/summary', getBudgetSummary);

// Bulk operations
router.post('/bulk', bulkCreateBudgets);

// Main CRUD routes
router.route('/')
  .get(getBudgets)
  .post(validateBudget, createBudget);

router.route('/:id')
  .get(getBudget)
  .put(validateBudget, updateBudget)
  .delete(deleteBudget);

// Analytics and forecast routes
router.get('/:id/analytics', getBudgetAnalytics);
router.get('/:id/forecast', getSpendingForecast);

// Renewal route
router.post('/:id/renew', renewBudget);

module.exports = router;
