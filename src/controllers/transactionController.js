const mongoose = require('mongoose');
const Expense = require('../models/Expense');
const Income = require('../models/Income');
const Category = require('../models/Category');
const { successResponse, errorResponse } = require('../utils/response');

/** Encode cursor for keyset pagination (date desc, createdAt desc) */
function encodeCursor(doc) {
  if (!doc || !doc.date || !doc.createdAt || !doc._id) return null;
  const payload = {
    date: new Date(doc.date).toISOString(),
    createdAt: new Date(doc.createdAt).toISOString(),
    id: doc._id.toString(),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/** Decode cursor; returns null if invalid */
function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    return {
      date: new Date(payload.date),
      createdAt: new Date(payload.createdAt),
      id: new mongoose.Types.ObjectId(payload.id),
    };
  } catch {
    return null;
  }
}

/**
 * @swagger
 * tags:
 *   name: Transactions
 *   description: Unified transaction management (expenses and income)
 */

/**
 * @swagger
 * /api/v1/transactions:
 *   get:
 *     summary: Get all transactions (expenses and income) with pagination and filters
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Opaque cursor for next page (from previous response nextCursor). Omit for first page.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 30
 *         description: Page size (1-100)
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [expense, income, all]
 *           default: all
 *         description: Filter by transaction type
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Start date (YYYY-MM-DD)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: End date (YYYY-MM-DD)
 *       - in: query
 *         name: categoryId
 *         schema:
 *           type: string
 *         description: Filter by category ID
 *       - in: query
 *         name: minAmount
 *         schema:
 *           type: number
 *         description: Minimum amount
 *       - in: query
 *         name: maxAmount
 *         schema:
 *           type: number
 *         description: Maximum amount
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search in description, location, or source
 *     responses:
 *       200:
 *         description: Transactions retrieved successfully
 */
exports.getTransactions = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const {
      cursor,
      limit = 30,
      startDate,
      endDate,
      categoryId,
      minAmount,
      maxAmount,
      search
    } = req.query;

    // Normalize type: only 'expense' and 'income' are specific; everything else is 'all'
    const rawType = req.query.type;
    const type = (rawType === 'expense' || rawType === 'income') ? rawType : 'all';

    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
    const cursorData = decodeCursor(cursor);

    // Build base query for both expenses and income (aggregation needs ObjectId; find() casts automatically)
    const userIdObj = mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : userId;
    const baseQuery = { userId: userIdObj };

    // Date range filter
    if (startDate || endDate) {
      baseQuery.date = {};
      if (startDate) {
        // Parse date string (YYYY-MM-DD or ISO format) and set to start of day in UTC
        // MongoDB stores dates in UTC, so we must compare in UTC to avoid timezone issues
        let start;
        if (startDate.includes('T')) {
            console.log('start date', startDate);
          // ISO format with time - parse and convert to UTC start of day
          start = new Date(startDate);
          start = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0));
        } else {
          // Date-only format (YYYY-MM-DD) - create UTC date directly
          const startParts = startDate.split('-');
          if (startParts.length === 3) {
            // Create UTC date: year, month (0-indexed), day, hour, minute, second, millisecond
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
        baseQuery.date.$gte = start;
      }
      if (endDate) {
        // Parse date string (YYYY-MM-DD or ISO format) and set to end of day in UTC
        let end;
        if (endDate.includes('T')) {
          // ISO format with time - parse and convert to UTC end of day
          end = new Date(endDate);
          end = new Date(Date.UTC(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999));
        } else {
          // Date-only format (YYYY-MM-DD) - create UTC date directly
          const endParts = endDate.split('-');
          if (endParts.length === 3) {
            // Create UTC date at end of day
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
        baseQuery.date.$lte = end;
      }
    }

    // Category filter (ensure ObjectId for aggregation)
    if (categoryId && mongoose.Types.ObjectId.isValid(categoryId)) {
      baseQuery.categoryId = new mongoose.Types.ObjectId(categoryId);
    }

    // Amount range filter
    if (minAmount || maxAmount) {
      baseQuery.amount = {};
      if (minAmount) baseQuery.amount.$gte = parseFloat(minAmount);
      if (maxAmount) baseQuery.amount.$lte = parseFloat(maxAmount);
    }

    const mapDoc = (doc) => ({
      _id: doc._id,
      id: doc._id,
      userId: doc.userId,
      categoryId: doc.categoryId,
      amount: doc.amount,
      description: doc.description,
      source: doc.source,
      date: doc.date,
      paymentMethod: doc.paymentMethod,
      location: doc.location,
      tags: doc.tags || [],
      isRecurring: doc.isRecurring || false,
      type: doc.type,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      category: doc.category,
    });

    // Build search conditions: text (description, location, source), category name, and amount (money)
    let searchOrExpense = [];
    let searchOrIncome = [];
    if (search && typeof search === 'string' && search.trim()) {
      const searchTerm = search.trim();
      const categoryIds = await Category.find({
        userId: userIdObj,
        name: { $regex: searchTerm, $options: 'i' }
      }).distinct('_id');
      const amountNum = parseFloat(searchTerm);
      const hasAmount = !isNaN(amountNum);

      searchOrExpense = [
        { description: { $regex: searchTerm, $options: 'i' } },
        { location: { $regex: searchTerm, $options: 'i' } },
        ...(categoryIds.length ? [{ categoryId: { $in: categoryIds } }] : []),
        ...(hasAmount ? [{ amount: amountNum }] : [])
      ];
      searchOrIncome = [
        { source: { $regex: searchTerm, $options: 'i' } },
        { description: { $regex: searchTerm, $options: 'i' } },
        ...(categoryIds.length ? [{ categoryId: { $in: categoryIds } }] : []),
        ...(hasAmount ? [{ amount: amountNum }] : [])
      ];
    }

    let transactions = [];
    let nextCursor = null;
    let hasMore = false;

    if (type === 'all') {
      const expenseQuery = { ...baseQuery };
      if (searchOrExpense.length) expenseQuery.$or = searchOrExpense;
      const incomeQuery = { ...baseQuery };
      if (searchOrIncome.length) incomeQuery.$or = searchOrIncome;

      const pipeline = [
        { $match: expenseQuery },
        { $addFields: { type: 'expense', source: null } },
        {
          $unionWith: {
            coll: 'incomes',
            pipeline: [
              { $match: incomeQuery },
              { $addFields: { type: 'income', location: null } }
            ]
          }
        },
      ];

      if (cursorData) {
        pipeline.push({
          $match: {
            $expr: {
              $or: [
                { $lt: ['$date', cursorData.date] },
                {
                  $and: [
                    { $eq: ['$date', cursorData.date] },
                    { $lt: ['$createdAt', cursorData.createdAt] }
                  ]
                },
                {
                  $and: [
                    { $eq: ['$date', cursorData.date] },
                    { $eq: ['$createdAt', cursorData.createdAt] },
                    { $lt: ['$_id', cursorData.id] }
                  ]
                }
              ]
            }
          }
        });
      }

      pipeline.push(
        { $sort: { date: -1, createdAt: -1 } },
        { $limit: limitNum + 1 },
        {
          $lookup: {
            from: 'categories',
            localField: 'categoryId',
            foreignField: '_id',
            as: 'categoryDoc'
          }
        },
        { $unwind: { path: '$categoryDoc', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            userId: 1,
            categoryId: 1,
            amount: 1,
            description: 1,
            source: 1,
            date: 1,
            paymentMethod: 1,
            location: 1,
            tags: 1,
            isRecurring: 1,
            type: 1,
            createdAt: 1,
            updatedAt: 1,
            category: {
              $cond: {
                if: { $ne: ['$categoryDoc._id', null] },
                then: {
                  _id: '$categoryDoc._id',
                  id: '$categoryDoc._id',
                  name: '$categoryDoc.name',
                  icon: '$categoryDoc.icon',
                  color: '$categoryDoc.color',
                  type: '$categoryDoc.type'
                },
                else: '$$REMOVE'
              }
            }
          }
        }
      );

      const items = await Expense.aggregate(pipeline);
      if (items.length > limitNum) {
        hasMore = true;
        const lastReturned = items[limitNum - 1];
        nextCursor = encodeCursor(lastReturned);
        transactions = items.slice(0, limitNum).map(mapDoc);
      } else {
        transactions = items.map(mapDoc);
      }
    } else {
      const cursorCondition = cursorData
        ? {
            $or: [
              { date: { $lt: cursorData.date } },
              {
                date: cursorData.date,
                createdAt: { $lt: cursorData.createdAt }
              },
              {
                date: cursorData.date,
                createdAt: cursorData.createdAt,
                _id: { $lt: cursorData.id }
              }
            ]
          }
        : null;

      if (type === 'expense') {
        const expenseQuery = { ...baseQuery };
        if (searchOrExpense.length) expenseQuery.$or = searchOrExpense;
        if (cursorCondition) {
          expenseQuery.$and = expenseQuery.$and || [];
          expenseQuery.$and.push(cursorCondition);
        }
        const list = await Expense.find(expenseQuery)
          .populate('categoryId', 'name icon color type')
          .sort({ date: -1, createdAt: -1 })
          .limit(limitNum + 1)
          .lean();
        if (list.length > limitNum) {
          hasMore = true;
          nextCursor = encodeCursor(list[limitNum - 1]);
          list.pop();
        }
        transactions = list.map((exp) => ({
          _id: exp._id,
          id: exp._id,
          userId: exp.userId,
          categoryId: exp.categoryId?._id || exp.categoryId,
          amount: exp.amount,
          description: exp.description,
          date: exp.date,
          isImported: Boolean(exp.isImported),
          statementTimeProvided: Boolean(exp.statementTimeProvided),
          paymentMethod: exp.paymentMethod,
          location: exp.location,
          tags: exp.tags || [],
          isRecurring: exp.isRecurring || false,
          type: 'expense',
          createdAt: exp.createdAt,
          updatedAt: exp.updatedAt,
          category: exp.categoryId?.name
            ? {
                _id: exp.categoryId._id,
                id: exp.categoryId._id,
                name: exp.categoryId.name,
                icon: exp.categoryId.icon,
                color: exp.categoryId.color,
                type: exp.categoryId.type
              }
            : undefined
        }));
      }

      if (type === 'income') {
        const incomeQuery = { ...baseQuery };
        if (searchOrIncome.length) incomeQuery.$or = searchOrIncome;
        if (cursorCondition) {
          incomeQuery.$and = incomeQuery.$and || [];
          incomeQuery.$and.push(cursorCondition);
        }
        const list = await Income.find(incomeQuery)
          .populate('categoryId', 'name icon color type')
          .sort({ date: -1, createdAt: -1 })
          .limit(limitNum + 1)
          .lean();
        if (list.length > limitNum) {
          hasMore = true;
          nextCursor = encodeCursor(list[limitNum - 1]);
          list.pop();
        }
        transactions = list.map((inc) => ({
          _id: inc._id,
          id: inc._id,
          userId: inc.userId,
          categoryId: inc.categoryId?._id || inc.categoryId,
          amount: inc.amount,
          source: inc.source,
          description: inc.description,
          date: inc.date,
          isImported: Boolean(inc.isImported),
          statementTimeProvided: Boolean(inc.statementTimeProvided),
          paymentMethod: inc.paymentMethod,
          tags: inc.tags || [],
          isRecurring: inc.isRecurring || false,
          type: 'income',
          createdAt: inc.createdAt,
          updatedAt: inc.updatedAt,
          category: inc.categoryId?.name
            ? {
                _id: inc.categoryId._id,
                id: inc.categoryId._id,
                name: inc.categoryId.name,
                icon: inc.categoryId.icon,
                color: inc.categoryId.color,
                type: inc.categoryId.type
              }
            : undefined
        }));
      }
    }

    console.log('transactions', transactions);
    return successResponse(
      res,
      {
        transactions,
        nextCursor,
        hasMore,
        pagination: {
          limit: limitNum,
          hasMore
        }
      },
      'Transactions retrieved successfully'
    );
  } catch (error) {
    console.error('Get transactions error:', error);
    return errorResponse(res, 'Failed to retrieve transactions', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/transactions/{id}:
 *   get:
 *     summary: Get a single transaction by ID
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Transaction ID
 *     responses:
 *       200:
 *         description: Transaction retrieved successfully
 *       404:
 *         description: Transaction not found
 */
exports.getTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // Try to find as expense first
    let transaction = await Expense.findOne({ _id: id, userId })
      .populate('categoryId', 'name icon color type');

    if (transaction) {
      const expenseData = {
        _id: transaction._id,
        id: transaction._id,
        userId: transaction.userId,
        categoryId: transaction.categoryId?._id || transaction.categoryId,
        amount: transaction.amount,
        description: transaction.description,
        date: transaction.date,
        isImported: Boolean(transaction.isImported),
        statementTimeProvided: Boolean(transaction.statementTimeProvided),
        paymentMethod: transaction.paymentMethod,
        location: transaction.location,
        tags: transaction.tags || [],
        receiptUrl: transaction.receiptUrl,
        isRecurring: transaction.isRecurring || false,
        recurringFrequency: transaction.recurringFrequency,
        recurringEndDate: transaction.recurringEndDate,
        type: 'expense',
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
        category: transaction.categoryId?.name ? {
          _id: transaction.categoryId._id,
          id: transaction.categoryId._id,
          name: transaction.categoryId.name,
          icon: transaction.categoryId.icon,
          color: transaction.categoryId.color,
          type: transaction.categoryId.type,
        } : undefined,
      };

      return successResponse(res, { transaction: expenseData }, 'Transaction retrieved successfully');
    }

    // Try to find as income
    transaction = await Income.findOne({ _id: id, userId })
      .populate('categoryId', 'name icon color type');

    if (transaction) {
      const incomeData = {
        _id: transaction._id,
        id: transaction._id,
        userId: transaction.userId,
        categoryId: transaction.categoryId?._id || transaction.categoryId,
        amount: transaction.amount,
        source: transaction.source,
        description: transaction.description,
        date: transaction.date,
        isImported: Boolean(transaction.isImported),
        statementTimeProvided: Boolean(transaction.statementTimeProvided),
        paymentMethod: transaction.paymentMethod,
        tags: transaction.tags || [],
        isRecurring: transaction.isRecurring || false,
        recurringFrequency: transaction.recurringFrequency,
        recurringEndDate: transaction.recurringEndDate,
        type: 'income',
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
        category: transaction.categoryId?.name ? {
          _id: transaction.categoryId._id,
          id: transaction.categoryId._id,
          name: transaction.categoryId.name,
          icon: transaction.categoryId.icon,
          color: transaction.categoryId.color,
          type: transaction.categoryId.type,
        } : undefined,
      };

      return successResponse(res, { transaction: incomeData }, 'Transaction retrieved successfully');
    }

    return errorResponse(res, 'Transaction not found', 404);
  } catch (error) {
    console.error('Get transaction error:', error);
    return errorResponse(res, 'Failed to retrieve transaction', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/transactions/{id}:
 *   put:
 *     summary: Update a transaction
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Transaction ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               amount:
 *                 type: number
 *               categoryId:
 *                 type: string
 *               description:
 *                 type: string
 *               date:
 *                 type: string
 *                 format: date-time
 *               paymentMethod:
 *                 type: string
 *               location:
 *                 type: string
 *               source:
 *                 type: string
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Transaction updated successfully
 *       404:
 *         description: Transaction not found
 */
exports.updateTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    const updateData = req.body;

    // Try to find and update as expense first
    let transaction = await Expense.findOne({ _id: id, userId });

    if (transaction) {
      // Verify category if provided
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
      Object.assign(transaction, updateData);
      await transaction.save();
      await transaction.populate('categoryId', 'name icon color type');

      const expenseData = {
        _id: transaction._id,
        id: transaction._id,
        userId: transaction.userId,
        categoryId: transaction.categoryId?._id || transaction.categoryId,
        amount: transaction.amount,
        description: transaction.description,
        date: transaction.date,
        paymentMethod: transaction.paymentMethod,
        location: transaction.location,
        tags: transaction.tags || [],
        receiptUrl: transaction.receiptUrl,
        isRecurring: transaction.isRecurring || false,
        recurringFrequency: transaction.recurringFrequency,
        recurringEndDate: transaction.recurringEndDate,
        type: 'expense',
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
        category: transaction.categoryId?.name ? {
          _id: transaction.categoryId._id,
          id: transaction.categoryId._id,
          name: transaction.categoryId.name,
          icon: transaction.categoryId.icon,
          color: transaction.categoryId.color,
          type: transaction.categoryId.type,
        } : undefined,
      };

      return successResponse(res, { transaction: expenseData }, 'Transaction updated successfully');
    }

    // Try to find and update as income
    transaction = await Income.findOne({ _id: id, userId });

    if (transaction) {
      // Verify category if provided
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
      Object.assign(transaction, updateData);
      await transaction.save();
      await transaction.populate('categoryId', 'name icon color type');

      const incomeData = {
        _id: transaction._id,
        id: transaction._id,
        userId: transaction.userId,
        categoryId: transaction.categoryId?._id || transaction.categoryId,
        amount: transaction.amount,
        source: transaction.source,
        description: transaction.description,
        date: transaction.date,
        paymentMethod: transaction.paymentMethod,
        tags: transaction.tags || [],
        isRecurring: transaction.isRecurring || false,
        recurringFrequency: transaction.recurringFrequency,
        recurringEndDate: transaction.recurringEndDate,
        type: 'income',
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
        category: transaction.categoryId?.name ? {
          _id: transaction.categoryId._id,
          id: transaction.categoryId._id,
          name: transaction.categoryId.name,
          icon: transaction.categoryId.icon,
          color: transaction.categoryId.color,
          type: transaction.categoryId.type,
        } : undefined,
      };

      return successResponse(res, { transaction: incomeData }, 'Transaction updated successfully');
    }

    return errorResponse(res, 'Transaction not found', 404);
  } catch (error) {
    console.error('Update transaction error:', error);
    return errorResponse(res, 'Failed to update transaction', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/transactions/{id}:
 *   delete:
 *     summary: Delete a transaction
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Transaction ID
 *     responses:
 *       200:
 *         description: Transaction deleted successfully
 *       404:
 *         description: Transaction not found
 */
exports.deleteTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // Try to delete as expense first
    const expense = await Expense.findOneAndDelete({ _id: id, userId });

    if (expense) {
      return successResponse(res, { transaction: { id: expense._id, type: 'expense' } }, 'Transaction deleted successfully');
    }

    // Try to delete as income
    const income = await Income.findOneAndDelete({ _id: id, userId });

    if (income) {
      return successResponse(res, { transaction: { id: income._id, type: 'income' } }, 'Transaction deleted successfully');
    }

    return errorResponse(res, 'Transaction not found', 404);
  } catch (error) {
    console.error('Delete transaction error:', error);
    return errorResponse(res, 'Failed to delete transaction', 500, error.message);
  }
};
