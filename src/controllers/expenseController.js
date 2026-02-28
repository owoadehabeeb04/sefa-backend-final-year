const Expense = require('../models/Expense');
const Category = require('../models/Category');
const { successResponse, errorResponse } = require('../utils/response');

/**
 * @swagger
 * tags:
 *   name: Expenses
 *   description: Expense tracking and management
 */

/**
 * @swagger
 * /api/v1/expenses:
 *   post:
 *     summary: Create a new expense
 *     tags: [Expenses]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - categoryId
 *               - amount
 *               - date
 *             properties:
 *               categoryId:
 *                 type: string
 *                 description: ID of the expense category
 *               amount:
 *                 type: number
 *                 minimum: 0.01
 *                 description: Expense amount
 *               description:
 *                 type: string
 *                 maxLength: 500
 *                 description: Optional description of the expense
 *               date:
 *                 type: string
 *                 format: date-time
 *                 description: Date of the expense
 *               paymentMethod:
 *                 type: string
 *                 enum: [cash, card, bank_transfer, mobile_money, other]
 *                 default: cash
 *               location:
 *                 type: string
 *                 maxLength: 200
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *               localId:
 *                 type: string
 *                 description: Local ID for offline sync
 *     responses:
 *       201:
 *         description: Expense created successfully
 *       400:
 *         description: Validation error
 *       404:
 *         description: Category not found
 */
exports.createExpense = async (req, res, next) => {
  try {
    const {
      categoryId,
      amount,
      description,
      date,
      paymentMethod,
      location,
      tags,
      localId
    } = req.body;
    const userId = req.user.userId;

    // Verify category exists and is an expense category
    const category = await Category.findOne({
      _id: categoryId,
      userId,
      type: 'expense',
      isActive: true
    });

    if (!category) {
      return errorResponse(res, 'Expense category not found or inactive', 404);
    }

    // Check for duplicate localId (offline sync)
    if (localId) {
      const existingExpense = await Expense.findOne({ userId, localId });
      if (existingExpense) {
        return errorResponse(res, 'Expense with this localId already exists', 409);
      }
    }

    const expense = await Expense.create({
      userId,
      categoryId,
      amount,
      description,
      date: date || new Date(),
      paymentMethod: paymentMethod || 'cash',
      location,
      tags,
      localId,
      synced: true
    });

    // Populate category details
    await expense.populate('categoryId', 'name icon color type');

    try {
      const { addNotificationJob } = require('../config/queue');
      await addNotificationJob({
        userId,
        type: 'transaction_alert',
        urgency: 'instant',
        data: {
          amount: expense.amount,
          description: expense.description || 'New expense added',
          category: expense.categoryId?.name || category.name,
          transactionType: 'expense',
          transactionId: expense._id.toString(),
          date: expense.date
        }
      });
    } catch (notificationError) {
      console.warn('Failed to enqueue expense notification:', notificationError.message);
    }

    return successResponse(
      res,
      { expense },
      'Expense created successfully',
      201
    );
  } catch (error) {
    console.error('Create expense error:', error);
    return errorResponse(res, 'Failed to create expense', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/expenses:
 *   get:
 *     summary: Get all expenses for the authenticated user
 *     tags: [Expenses]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of items per page
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter expenses from this date
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter expenses until this date
 *       - in: query
 *         name: categoryId
 *         schema:
 *           type: string
 *         description: Filter by category ID
 *       - in: query
 *         name: minAmount
 *         schema:
 *           type: number
 *         description: Minimum expense amount
 *       - in: query
 *         name: maxAmount
 *         schema:
 *           type: number
 *         description: Maximum expense amount
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search in description and location
 *     responses:
 *       200:
 *         description: Expenses retrieved successfully
 */
exports.getExpenses = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const {
      page = 1,
      limit = 20,
      startDate,
      endDate,
      categoryId,
      minAmount,
      maxAmount,
      search
    } = req.query;

    // Build query
    const query = { userId };

    // Date range filter
    if (startDate || endDate) {
      query.date = {};
      if (startDate) {
        // Parse date string (YYYY-MM-DD or ISO format) and set to start of day in UTC
        // MongoDB stores dates in UTC, so we must compare in UTC to avoid timezone issues
        let start;
        if (startDate.includes('T')) {
          start = new Date(startDate);
          start = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0));
        } else {
          const startParts = startDate.split('-');
          if (startParts.length === 3) {
            start = new Date(Date.UTC(
              parseInt(startParts[0]),
              parseInt(startParts[1]) - 1,
              parseInt(startParts[2]),
              0, 0, 0, 0
            ));
          } else {
            start = new Date(startDate);
            start = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0));
          }
        }
        query.date.$gte = start;
      }
      if (endDate) {
        // Parse date string (YYYY-MM-DD or ISO format) and set to end of day in UTC
        let end;
        if (endDate.includes('T')) {
          end = new Date(endDate);
          end = new Date(Date.UTC(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999));
        } else {
          const endParts = endDate.split('-');
          if (endParts.length === 3) {
            end = new Date(Date.UTC(
              parseInt(endParts[0]),
              parseInt(endParts[1]) - 1,
              parseInt(endParts[2]),
              23, 59, 59, 999
            ));
          } else {
            end = new Date(endDate);
            end = new Date(Date.UTC(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999));
          }
        }
        query.date.$lte = end;
      }
    }

    // Category filter
    if (categoryId) {
      query.categoryId = categoryId;
    }

    // Amount range filter
    if (minAmount || maxAmount) {
      query.amount = {};
      if (minAmount) query.amount.$gte = parseFloat(minAmount);
      if (maxAmount) query.amount.$lte = parseFloat(maxAmount);
    }

    // Search filter
    if (search) {
      query.$or = [
        { description: { $regex: search, $options: 'i' } },
        { location: { $regex: search, $options: 'i' } }
      ];
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Get expenses with pagination
    const expenses = await Expense.find(query)
      .populate('categoryId', 'name icon color type')
      .sort({ date: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Get total count
    const total = await Expense.countDocuments(query);

    return successResponse(
      res,
      {
        expenses,
        pagination: {
          total,
          page: parseInt(page),
          pages: Math.ceil(total / parseInt(limit)),
          limit: parseInt(limit)
        }
      },
      'Expenses retrieved successfully'
    );
  } catch (error) {
    console.error('Get expenses error:', error);
    return errorResponse(res, 'Failed to retrieve expenses', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/expenses/{id}:
 *   get:
 *     summary: Get a single expense by ID
 *     tags: [Expenses]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Expense ID
 *     responses:
 *       200:
 *         description: Expense retrieved successfully
 *       404:
 *         description: Expense not found
 */
exports.getExpense = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const expense = await Expense.findOne({ _id: id, userId })
      .populate('categoryId', 'name icon color type');

    if (!expense) {
      return errorResponse(res, 'Expense not found', 404);
    }

    return successResponse(
      res,
      { expense },
      'Expense retrieved successfully'
    );
  } catch (error) {
    console.error('Get expense error:', error);
    return errorResponse(res, 'Failed to retrieve expense', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/expenses/{id}:
 *   put:
 *     summary: Update an expense
 *     tags: [Expenses]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Expense ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               categoryId:
 *                 type: string
 *               amount:
 *                 type: number
 *               description:
 *                 type: string
 *               date:
 *                 type: string
 *                 format: date-time
 *               paymentMethod:
 *                 type: string
 *               location:
 *                 type: string
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Expense updated successfully
 *       404:
 *         description: Expense not found
 */
exports.updateExpense = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    const updateData = req.body;

    // Find expense
    const expense = await Expense.findOne({ _id: id, userId });
    if (!expense) {
      return errorResponse(res, 'Expense not found', 404);
    }

    // If updating category, verify it exists and is an expense category
    if (updateData.categoryId) {
      const category = await Category.findOne({
        _id: updateData.categoryId,
        userId,
        type: 'expense',
        isActive: true
      });

      if (!category) {
        return errorResponse(res, 'Expense category not found or inactive', 404);
      }
    }

    // Update expense
    Object.assign(expense, updateData);
    await expense.save();

    // Populate category details
    await expense.populate('categoryId', 'name icon color type');

    return successResponse(
      res,
      { expense },
      'Expense updated successfully'
    );
  } catch (error) {
    console.error('Update expense error:', error);
    return errorResponse(res, 'Failed to update expense', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/expenses/{id}:
 *   delete:
 *     summary: Delete an expense
 *     tags: [Expenses]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Expense ID
 *     responses:
 *       200:
 *         description: Expense deleted successfully
 *       404:
 *         description: Expense not found
 */
exports.deleteExpense = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const expense = await Expense.findOne({ _id: id, userId });
    if (!expense) {
      return errorResponse(res, 'Expense not found', 404);
    }

    await expense.deleteOne();

    return successResponse(
      res,
      { message: 'Expense deleted successfully' },
      'Expense deleted successfully'
    );
  } catch (error) {
    console.error('Delete expense error:', error);
    return errorResponse(res, 'Failed to delete expense', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/expenses/bulk:
 *   post:
 *     summary: Create multiple expenses (bulk insert for offline sync)
 *     tags: [Expenses]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - expenses
 *             properties:
 *               expenses:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required:
 *                     - categoryId
 *                     - amount
 *                     - date
 *                   properties:
 *                     categoryId:
 *                       type: string
 *                     amount:
 *                       type: number
 *                     description:
 *                       type: string
 *                     date:
 *                       type: string
 *                     localId:
 *                       type: string
 *     responses:
 *       201:
 *         description: Expenses created successfully
 *       400:
 *         description: Validation error
 */
exports.bulkCreateExpenses = async (req, res, next) => {
  try {
    const { expenses } = req.body;
    const userId = req.user.userId;

    if (!Array.isArray(expenses) || expenses.length === 0) {
      return errorResponse(res, 'Expenses array is required', 400);
    }

    const createdExpenses = [];
    const errors = [];

    for (let i = 0; i < expenses.length; i++) {
      try {
        const expenseData = { ...expenses[i], userId, synced: true };
        
        // Check for duplicate localId
        if (expenseData.localId) {
          const existing = await Expense.findOne({ userId, localId: expenseData.localId });
          if (existing) {
            errors.push({ index: i, error: 'Duplicate localId', localId: expenseData.localId });
            continue;
          }
        }

        const expense = await Expense.create(expenseData);
        await expense.populate('categoryId', 'name icon color type');
        createdExpenses.push(expense);
      } catch (error) {
        errors.push({ index: i, error: error.message });
      }
    }

    return successResponse(
      res,
      {
        created: createdExpenses,
        errors,
        summary: {
          total: expenses.length,
          success: createdExpenses.length,
          failed: errors.length
        }
      },
      `Successfully created ${createdExpenses.length} of ${expenses.length} expenses`,
      201
    );
  } catch (error) {
    console.error('Bulk create expenses error:', error);
    return errorResponse(res, 'Failed to create expenses', 500, error.message);
  }
};
