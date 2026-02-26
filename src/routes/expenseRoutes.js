const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { validateExpense } = require('../middleware/validators');
const expenseController = require('../controllers/expenseController');

// All routes require authentication
router.use(authenticate);

/**
 * @route   POST /api/v1/expenses
 * @desc    Create a new expense
 * @access  Private
 */
router.post('/', validateExpense, expenseController.createExpense);

/**
 * @route   POST /api/v1/expenses/bulk
 * @desc    Bulk create expenses (for offline sync)
 * @access  Private
 */
router.post('/bulk', expenseController.bulkCreateExpenses);

/**
 * @route   GET /api/v1/expenses
 * @desc    Get all expenses for authenticated user
 * @access  Private
 */
router.get('/', expenseController.getExpenses);

/**
 * @route   GET /api/v1/expenses/:id
 * @desc    Get a single expense by ID
 * @access  Private
 */
router.get('/:id', expenseController.getExpense);

/**
 * @route   PUT /api/v1/expenses/:id
 * @desc    Update an expense
 * @access  Private
 */
router.put('/:id', expenseController.updateExpense);

/**
 * @route   DELETE /api/v1/expenses/:id
 * @desc    Delete an expense
 * @access  Private
 */
router.delete('/:id', expenseController.deleteExpense);

module.exports = router;
