const Income = require('../models/Income');
const Category = require('../models/Category');
const { successResponse, errorResponse } = require('../utils/response');

/**
 * @swagger
 * tags:
 *   name: Income
 *   description: Income tracking and management
 */

/**
 * @swagger
 * /api/v1/income:
 *   post:
 *     summary: Create a new income entry
 *     tags: [Income]
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
 *               - source
 *               - date
 *             properties:
 *               categoryId:
 *                 type: string
 *                 description: ID of the income category
 *               amount:
 *                 type: number
 *                 minimum: 0.01
 *                 description: Income amount
 *               source:
 *                 type: string
 *                 maxLength: 200
 *                 description: Source of income (e.g., Salary, Freelance)
 *               description:
 *                 type: string
 *                 maxLength: 500
 *                 description: Optional description
 *               date:
 *                 type: string
 *                 format: date-time
 *                 description: Date of the income
 *               paymentMethod:
 *                 type: string
 *                 enum: [cash, card, bank_transfer, mobile_money, other]
 *                 default: bank_transfer
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *               localId:
 *                 type: string
 *                 description: Local ID for offline sync
 *     responses:
 *       201:
 *         description: Income created successfully
 *       400:
 *         description: Validation error
 *       404:
 *         description: Category not found
 */
exports.createIncome = async (req, res, next) => {
  try {
    const {
      categoryId,
      amount,
      source,
      description,
      date,
      paymentMethod,
      tags,
      localId
    } = req.body;
    const userId = req.user.userId;

    // Verify category exists and is an income category
    const category = await Category.findOne({
      _id: categoryId,
      userId,
      type: 'income',
      isActive: true
    });

    if (!category) {
      return errorResponse(res, 'Income category not found or inactive', 404);
    }

    // Check for duplicate localId (offline sync)
    if (localId) {
      const existingIncome = await Income.findOne({ userId, localId });
      if (existingIncome) {
        return errorResponse(res, 'Income with this localId already exists', 409);
      }
    }

    const income = await Income.create({
      userId,
      categoryId,
      amount,
      source,
      description,
      date: date || new Date(),
      paymentMethod: paymentMethod || 'bank_transfer',
      tags,
      localId,
      synced: true
    });

    // Populate category details
    await income.populate('categoryId', 'name icon color type');

    try {
      const { addNotificationJob } = require('../config/queue');
      await addNotificationJob({
        userId,
        type: 'transaction_alert',
        urgency: 'instant',
        data: {
          amount: income.amount,
          description: income.description || income.source || 'New income added',
          category: income.categoryId?.name || category.name,
          transactionType: 'income',
          transactionId: income._id.toString(),
          date: income.date
        }
      });
    } catch (notificationError) {
      console.warn('Failed to enqueue income notification:', notificationError.message);
    }

    return successResponse(
      res,
      { income },
      'Income created successfully',
      201
    );
  } catch (error) {
    console.error('Create income error:', error);
    return errorResponse(res, 'Failed to create income', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/income:
 *   get:
 *     summary: Get all income entries for the authenticated user
 *     tags: [Income]
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
 *         description: Filter income from this date
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter income until this date
 *       - in: query
 *         name: categoryId
 *         schema:
 *           type: string
 *         description: Filter by category ID
 *       - in: query
 *         name: minAmount
 *         schema:
 *           type: number
 *         description: Minimum income amount
 *       - in: query
 *         name: maxAmount
 *         schema:
 *           type: number
 *         description: Maximum income amount
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search in source and description
 *     responses:
 *       200:
 *         description: Income entries retrieved successfully
 */
exports.getIncome = async (req, res, next) => {
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
        { source: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Get income with pagination
    const income = await Income.find(query)
      .populate('categoryId', 'name icon color type')
      .sort({ date: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Get total count
    const total = await Income.countDocuments(query);

    return successResponse(
      res,
      {
        income,
        pagination: {
          total,
          page: parseInt(page),
          pages: Math.ceil(total / parseInt(limit)),
          limit: parseInt(limit)
        }
      },
      'Income entries retrieved successfully'
    );
  } catch (error) {
    console.error('Get income error:', error);
    return errorResponse(res, 'Failed to retrieve income', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/income/{id}:
 *   get:
 *     summary: Get a single income entry by ID
 *     tags: [Income]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Income ID
 *     responses:
 *       200:
 *         description: Income retrieved successfully
 *       404:
 *         description: Income not found
 */
exports.getIncomeById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const income = await Income.findOne({ _id: id, userId })
      .populate('categoryId', 'name icon color type');

    if (!income) {
      return errorResponse(res, 'Income not found', 404);
    }

    return successResponse(
      res,
      { income },
      'Income retrieved successfully'
    );
  } catch (error) {
    console.error('Get income by ID error:', error);
    return errorResponse(res, 'Failed to retrieve income', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/income/{id}:
 *   put:
 *     summary: Update an income entry
 *     tags: [Income]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Income ID
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
 *               source:
 *                 type: string
 *               description:
 *                 type: string
 *               date:
 *                 type: string
 *                 format: date-time
 *               paymentMethod:
 *                 type: string
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Income updated successfully
 *       404:
 *         description: Income not found
 */
exports.updateIncome = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    const updateData = req.body;

    // Find income
    const income = await Income.findOne({ _id: id, userId });
    if (!income) {
      return errorResponse(res, 'Income not found', 404);
    }

    // If updating category, verify it exists and is an income category
    if (updateData.categoryId) {
      const category = await Category.findOne({
        _id: updateData.categoryId,
        userId,
        type: 'income',
        isActive: true
      });

      if (!category) {
        return errorResponse(res, 'Income category not found or inactive', 404);
      }
    }

    // Update income
    Object.assign(income, updateData);
    await income.save();

    // Populate category details
    await income.populate('categoryId', 'name icon color type');

    return successResponse(
      res,
      { income },
      'Income updated successfully'
    );
  } catch (error) {
    console.error('Update income error:', error);
    return errorResponse(res, 'Failed to update income', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/income/{id}:
 *   delete:
 *     summary: Delete an income entry
 *     tags: [Income]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Income ID
 *     responses:
 *       200:
 *         description: Income deleted successfully
 *       404:
 *         description: Income not found
 */
exports.deleteIncome = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const income = await Income.findOne({ _id: id, userId });
    if (!income) {
      return errorResponse(res, 'Income not found', 404);
    }

    await income.deleteOne();

    return successResponse(
      res,
      { message: 'Income deleted successfully' },
      'Income deleted successfully'
    );
  } catch (error) {
    console.error('Delete income error:', error);
    return errorResponse(res, 'Failed to delete income', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/income/bulk:
 *   post:
 *     summary: Create multiple income entries (bulk insert for offline sync)
 *     tags: [Income]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - income
 *             properties:
 *               income:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required:
 *                     - categoryId
 *                     - amount
 *                     - source
 *                     - date
 *                   properties:
 *                     categoryId:
 *                       type: string
 *                     amount:
 *                       type: number
 *                     source:
 *                       type: string
 *                     description:
 *                       type: string
 *                     date:
 *                       type: string
 *                     localId:
 *                       type: string
 *     responses:
 *       201:
 *         description: Income entries created successfully
 *       400:
 *         description: Validation error
 */
exports.bulkCreateIncome = async (req, res, next) => {
  try {
    const { income } = req.body;
    const userId = req.user.userId;

    if (!Array.isArray(income) || income.length === 0) {
      return errorResponse(res, 'Income array is required', 400);
    }

    const createdIncome = [];
    const errors = [];

    for (let i = 0; i < income.length; i++) {
      try {
        const incomeData = { ...income[i], userId, synced: true };
        
        // Check for duplicate localId
        if (incomeData.localId) {
          const existing = await Income.findOne({ userId, localId: incomeData.localId });
          if (existing) {
            errors.push({ index: i, error: 'Duplicate localId', localId: incomeData.localId });
            continue;
          }
        }

        const incomeEntry = await Income.create(incomeData);
        await incomeEntry.populate('categoryId', 'name icon color type');
        createdIncome.push(incomeEntry);
      } catch (error) {
        errors.push({ index: i, error: error.message });
      }
    }

    return successResponse(
      res,
      {
        created: createdIncome,
        errors,
        summary: {
          total: income.length,
          success: createdIncome.length,
          failed: errors.length
        }
      },
      `Successfully created ${createdIncome.length} of ${income.length} income entries`,
      201
    );
  } catch (error) {
    console.error('Bulk create income error:', error);
    return errorResponse(res, 'Failed to create income', 500, error.message);
  }
};
