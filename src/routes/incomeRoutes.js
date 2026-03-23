const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { validateIncome, validateIncomeUpdate } = require('../middleware/validators');
const incomeController = require('../controllers/incomeController');

// All routes require authentication
router.use(authenticate);

/**
 * @route   POST /api/v1/income
 * @desc    Create a new income entry
 * @access  Private
 */
router.post('/', validateIncome, incomeController.createIncome);

/**
 * @route   POST /api/v1/income/bulk
 * @desc    Bulk create income entries (for offline sync)
 * @access  Private
 */
router.post('/bulk', incomeController.bulkCreateIncome);

/**
 * @route   GET /api/v1/income
 * @desc    Get all income entries for authenticated user
 * @access  Private
 */
router.get('/', incomeController.getIncome);

/**
 * @route   GET /api/v1/income/:id
 * @desc    Get a single income entry by ID
 * @access  Private
 */
router.get('/:id', incomeController.getIncomeById);

/**
 * @route   PUT /api/v1/income/:id
 * @desc    Update an income entry
 * @access  Private
 */
router.put('/:id', validateIncomeUpdate, incomeController.updateIncome);

/**
 * @route   DELETE /api/v1/income/:id
 * @desc    Delete an income entry
 * @access  Private
 */
router.delete('/:id', incomeController.deleteIncome);

module.exports = router;
