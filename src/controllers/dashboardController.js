const Expense = require('../models/Expense');
const Income = require('../models/Income');
const User = require('../models/User');
const aiService = require('../services/aiService');
const { successResponse, errorResponse } = require('../utils/response');
const { startOfMonth, endOfMonth, startOfWeek, endOfWeek, startOfDay, endOfDay, startOfYear, endOfYear, subMonths, subWeeks, subYears, differenceInDays, getDaysInMonth, isSameMonth } = require('date-fns');

/**
 * @swagger
 * tags:
 *   name: Dashboard
 *   description: Dashboard summary and analytics
 */

/**
 * @swagger
 * /api/v1/dashboard/summary:
 *   get:
 *     summary: Get dashboard summary with financial overview and AI insights
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Start date for the period (defaults to start of current month)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: End date for the period (defaults to end of current month)
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           enum: [today, week, month, year, custom]
 *           default: month
 *         description: Predefined period (overrides startDate/endDate)
 *     responses:
 *       200:
 *         description: Dashboard summary retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     period:
 *                       type: object
 *                       properties:
 *                         start:
 *                           type: string
 *                         end:
 *                           type: string
 *                         label:
 *                           type: string
 *                     summary:
 *                       type: object
 *                       properties:
 *                         totalIncome:
 *                           type: number
 *                         totalExpenses:
 *                           type: number
 *                         balance:
 *                           type: number
 *                         savings:
 *                           type: number
 *                     topCategories:
 *                       type: array
 *                     recentTransactions:
 *                       type: array
 *                     aiInsight:
 *                       type: string
 */
exports.getDashboardSummary = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { period = 'month' } = req.query;
    let { startDate, endDate } = req.query;

    // Determine date range based on period
    const now = new Date();
    let periodLabel = 'This Month';

    if (period === 'today') {
      startDate = startOfDay(now);
      endDate = endOfDay(now);
      periodLabel = 'Today';
    } else if (period === 'week') {
      startDate = startOfWeek(now, { weekStartsOn: 1 }); // Monday
      endDate = endOfWeek(now, { weekStartsOn: 1 });
      periodLabel = 'This Week';
    } else if (period === 'month') {
      startDate = startOfMonth(now);
      endDate = endOfMonth(now);
      periodLabel = 'This Month';
    } else if (period === 'year') {
      startDate = startOfYear(now);
      endDate = endOfYear(now);
      periodLabel = 'This Year';
    } else if (period === 'custom' && startDate && endDate) {
      startDate = new Date(startDate);
      endDate = new Date(endDate);
      periodLabel = 'Custom Range';
    } else {
      // Default to current month
      startDate = startOfMonth(now);
      endDate = endOfMonth(now);
      periodLabel = 'This Month';
    }

    // Get user currency and budget
    const user = await User.findById(userId).select('currency monthlyBudgetLimit');
    const currency = user?.currency || 'NGN';
    const monthlyBudgetLimit = user?.monthlyBudgetLimit ?? null;

    // Calculate previous period for comparison
    let prevStartDate, prevEndDate;
    if (period === 'week') {
      prevStartDate = startOfWeek(subWeeks(now, 1), { weekStartsOn: 1 });
      prevEndDate = endOfWeek(subWeeks(now, 1), { weekStartsOn: 1 });
    } else if (period === 'year') {
      prevStartDate = startOfYear(subYears(now, 1));
      prevEndDate = endOfYear(subYears(now, 1));
    } else {
      prevStartDate = startOfMonth(subMonths(now, 1));
      prevEndDate = endOfMonth(subMonths(now, 1));
    }

    // Fetch current period data
    const [incomeData, expenseData] = await Promise.all([
      Income.getTotalByDateRange(userId, startDate, endDate),
      Expense.getTotalByDateRange(userId, startDate, endDate)
    ]);

    // Fetch previous period data for comparison
    const [prevIncomeData, prevExpenseData] = await Promise.all([
      Income.getTotalByDateRange(userId, prevStartDate, prevEndDate),
      Expense.getTotalByDateRange(userId, prevStartDate, prevEndDate)
    ]);

    const totalIncome = incomeData.total || 0;
    const totalExpenses = expenseData.total || 0;
    const balance = totalIncome - totalExpenses;
    const savings = balance > 0 ? balance : 0;

    const prevTotalIncome = prevIncomeData.total || 0;
    const prevTotalExpenses = prevExpenseData.total || 0;

    // Get top expense categories and daily spending (for detailed AI)
    const [topExpenseCategories, dailySpending] = await Promise.all([
      Expense.getByCategory(userId, startDate, endDate),
      Expense.getByDay(userId, startDate, endDate)
    ]);
    
    // Calculate percentages
    const categoriesWithPercentage = topExpenseCategories.map(cat => ({
      id: cat._id,
      name: cat.categoryName,
      icon: cat.categoryIcon,
      color: cat.categoryColor,
      total: cat.total,
      count: cat.count,
      percentage: totalExpenses > 0 ? ((cat.total / totalExpenses) * 100).toFixed(1) : 0
    }));

    // Get recent transactions (last 5, mixed income & expenses)
    const [recentExpenses, recentIncome] = await Promise.all([
      Expense.find({ userId, date: { $gte: startDate, $lte: endDate } })
        .populate('categoryId', 'name icon color type')
        .sort({ date: -1, createdAt: -1 })
        .limit(3)
        .lean(),
      Income.find({ userId, date: { $gte: startDate, $lte: endDate } })
        .populate('categoryId', 'name icon color type')
        .sort({ date: -1, createdAt: -1 })
        .limit(2)
        .lean()
    ]);

    // Combine and sort transactions
    const allTransactions = [
      ...recentExpenses.map(exp => ({ ...exp, type: 'expense' })),
      ...recentIncome.map(inc => ({ ...inc, type: 'income' }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);

    // Format transactions for response
    const recentTransactions = allTransactions.map(txn => ({
      id: txn._id,
      type: txn.type,
      amount: txn.amount,
      category: txn.categoryId?.name || 'Unknown',
      icon: txn.categoryId?.icon,
      color: txn.categoryId?.color,
      description: txn.description || (txn.type === 'income' ? txn.source : ''),
      date: txn.date,
      createdAt: txn.createdAt
    }));

    // Build budget summary: scale monthly budget by exact period length (days)
    const periodDays = Math.max(1, differenceInDays(endDate, startDate) + 1);
    const isCurrentMonth = period === 'month';
    const budgetBaseDays = (period === 'month' || isSameMonth(startDate, endDate))
      ? getDaysInMonth(startDate)
      : 30;

    let budget = null;
    let thisMonthBudget = null;

    if (monthlyBudgetLimit != null && monthlyBudgetLimit > 0) {
      const periodLimit = Math.round(monthlyBudgetLimit * (periodDays / budgetBaseDays));
      const used = totalExpenses;
      const left = Math.max(0, periodLimit - used);
      const percentUsed = periodLimit > 0 ? ((used / periodLimit) * 100).toFixed(1) : 0;
      let status = 'on_track';
      if (used > periodLimit) status = 'over';
      else if (parseFloat(percentUsed) >= 80) status = 'approaching';
      budget = {
        limit: periodLimit,
        used,
        left,
        percentUsed: parseFloat(percentUsed),
        status,
        monthlyBudgetLimit,
        periodDays,
        periodLabel,
        isCurrentMonth
      };

      // Option C: when viewing another period, also return current month budget so they see "This month" strip
      if (!isCurrentMonth) {
        const thisMonthStart = startOfMonth(now);
        const thisMonthEnd = endOfMonth(now);
        const thisMonthData = await Expense.getTotalByDateRange(userId, thisMonthStart, thisMonthEnd);
        const thisUsed = thisMonthData.total || 0;
        const thisLeft = Math.max(0, monthlyBudgetLimit - thisUsed);
        const thisPercentUsed = ((thisUsed / monthlyBudgetLimit) * 100).toFixed(1);
        let thisStatus = 'on_track';
        if (thisUsed > monthlyBudgetLimit) thisStatus = 'over';
        else if (parseFloat(thisPercentUsed) >= 80) thisStatus = 'approaching';
        thisMonthBudget = {
          limit: monthlyBudgetLimit,
          used: thisUsed,
          left: thisLeft,
          percentUsed: parseFloat(thisPercentUsed),
          status: thisStatus
        };
      }
    }

    // Generate detailed AI insight (use period budget for comparison, not monthly)
    const periodBudgetLimit = budget?.limit ?? null;
    let aiInsight = null;
    if (aiService.isConfigured()) {
      try {
        aiInsight = await aiService.generateDetailedFinancialInsight({
          totalIncome,
          totalExpenses,
          balance,
          monthlyBudgetLimit,
          periodBudgetLimit,
          periodDays,
          isCurrentMonth,
          topCategories: categoriesWithPercentage.slice(0, 5),
          dailySpending,
          lastPeriodExpenses: prevTotalExpenses,
          period: periodLabel.toLowerCase()
        });
      } catch (error) {
        console.error('AI detailed insight failed:', error);
        aiInsight = aiService.getDetailedFallbackInsight({
          totalIncome,
          totalExpenses,
          balance,
          monthlyBudgetLimit,
          periodBudgetLimit,
          periodDays,
          isCurrentMonth,
          topCategories: categoriesWithPercentage,
          dailySpending,
          period: periodLabel.toLowerCase()
        });
      }
    } else {
      aiInsight = aiService.getDetailedFallbackInsight({
        totalIncome,
        totalExpenses,
        balance,
        monthlyBudgetLimit,
        periodBudgetLimit,
        periodDays,
        isCurrentMonth,
        topCategories: categoriesWithPercentage,
        dailySpending,
        period: periodLabel.toLowerCase()
      });
    }

    // Calculate spending trends
    const spendingRate = totalIncome > 0 ? ((totalExpenses / totalIncome) * 100).toFixed(1) : 0;
    const savingsRate = totalIncome > 0 ? ((savings / totalIncome) * 100).toFixed(1) : 0;

    return successResponse(
      res,
      {
        period: {
          start: startDate,
          end: endDate,
          label: periodLabel
        },
        summary: {
          totalIncome,
          totalExpenses,
          balance,
          savings,
          currency,
          spendingRate: parseFloat(spendingRate),
          savingsRate: parseFloat(savingsRate)
        },
        budget,
        thisMonthBudget,
        comparison: {
          incomeChange: prevTotalIncome > 0 
            ? (((totalIncome - prevTotalIncome) / prevTotalIncome) * 100).toFixed(1)
            : null,
          expenseChange: prevTotalExpenses > 0
            ? (((totalExpenses - prevTotalExpenses) / prevTotalExpenses) * 100).toFixed(1)
            : null
        },
        topCategories: categoriesWithPercentage.slice(0, 5),
        recentTransactions,
        aiInsight,
        counts: {
          totalTransactions: (incomeData.count || 0) + (expenseData.count || 0),
          incomeCount: incomeData.count || 0,
          expenseCount: expenseData.count || 0
        }
      },
      'Dashboard summary retrieved successfully'
    );
  } catch (error) {
    console.error('Get dashboard summary error:', error);
    return errorResponse(res, 'Failed to retrieve dashboard summary', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/dashboard/spending-trends:
 *   get:
 *     summary: Get spending trends by category over time
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: months
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 12
 *           default: 6
 *         description: Number of months to analyze
 *     responses:
 *       200:
 *         description: Spending trends retrieved successfully
 */
exports.getSpendingTrends = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { months = 6 } = req.query;

    const trends = [];
    const now = new Date();

    for (let i = parseInt(months) - 1; i >= 0; i--) {
      const monthDate = subMonths(now, i);
      const startDate = startOfMonth(monthDate);
      const endDate = endOfMonth(monthDate);

      const [incomeData, expenseData, categoryBreakdown] = await Promise.all([
        Income.getTotalByDateRange(userId, startDate, endDate),
        Expense.getTotalByDateRange(userId, startDate, endDate),
        Expense.getByCategory(userId, startDate, endDate)
      ]);

      trends.push({
        month: monthDate.toLocaleString('default', { month: 'short', year: 'numeric' }),
        income: incomeData.total || 0,
        expenses: expenseData.total || 0,
        balance: (incomeData.total || 0) - (expenseData.total || 0),
        categories: categoryBreakdown.slice(0, 5).map(cat => ({
          name: cat.categoryName,
          total: cat.total,
          count: cat.count
        }))
      });
    }

    return successResponse(
      res,
      { trends },
      'Spending trends retrieved successfully'
    );
  } catch (error) {
    console.error('Get spending trends error:', error);
    return errorResponse(res, 'Failed to retrieve spending trends', 500, error.message);
  }
};

/**
 * @swagger
 * /api/v1/dashboard/stats:
 *   get:
 *     summary: Get overall financial statistics
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Financial statistics retrieved successfully
 */
exports.getStats = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    // Get all-time stats
    const [
      totalIncomeResult,
      totalExpensesResult,
      categoryCount,
      firstTransaction
    ] = await Promise.all([
      Income.aggregate([
        { $match: { userId: new require('mongoose').Types.ObjectId(userId) } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]),
      Expense.aggregate([
        { $match: { userId: new require('mongoose').Types.ObjectId(userId) } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]),
      Expense.distinct('categoryId', { userId }),
      Expense.findOne({ userId }).sort({ date: 1 }).select('date')
    ]);

    const allTimeIncome = totalIncomeResult[0]?.total || 0;
    const allTimeExpenses = totalExpensesResult[0]?.total || 0;
    const allTimeBalance = allTimeIncome - allTimeExpenses;

    return successResponse(
      res,
      {
        allTime: {
          totalIncome: allTimeIncome,
          totalExpenses: allTimeExpenses,
          balance: allTimeBalance,
          incomeCount: totalIncomeResult[0]?.count || 0,
          expenseCount: totalExpensesResult[0]?.count || 0,
          activeCategoriesCount: categoryCount.length
        },
        tracking: {
          firstTransactionDate: firstTransaction?.date || null,
          trackingDays: firstTransaction 
            ? Math.floor((new Date() - new Date(firstTransaction.date)) / (1000 * 60 * 60 * 24))
            : 0
        }
      },
      'Financial statistics retrieved successfully'
    );
  } catch (error) {
    console.error('Get stats error:', error);
    return errorResponse(res, 'Failed to retrieve statistics', 500, error.message);
  }
};
