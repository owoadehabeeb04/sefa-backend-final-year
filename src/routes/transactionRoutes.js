const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const transactionController = require('../controllers/transactionController');

// All routes require authentication
router.use(authenticate);

/**
 * @route   GET /api/v1/transactions
 * @desc    Get all transactions (expenses and income) with pagination and filters
 * @access  Private
 */
router.get('/', transactionController.getTransactions);

/**
 * @route   GET /api/v1/transactions/:id
 * @desc    Get a single transaction by ID
 * @access  Private
 */
router.get('/:id', transactionController.getTransaction);

/**
 * @route   PUT /api/v1/transactions/:id
 * @desc    Update a transaction
 * @access  Private
 */
router.put('/:id', transactionController.updateTransaction);

/**
 * @route   DELETE /api/v1/transactions/:id
 * @desc    Delete a transaction
 * @access  Private
 */
router.delete('/:id', transactionController.deleteTransaction);

module.exports = router;
