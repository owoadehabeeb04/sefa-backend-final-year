const schedulerService = require('../services/scheduler.service');
const { asyncHandler } = require('../middleware/asyncHandler');
const AppError = require('../utils/AppError');

/**
 * @desc    Get scheduler status
 * @route   GET /api/v1/scheduler/status
 * @access  Private (Admin only)
 */
exports.getSchedulerStatus = asyncHandler(async (req, res) => {
  const status = schedulerService.getStatus();
  
  res.status(200).json({
    success: true,
    data: status
  });
});

/**
 * @desc    Get scheduler schedule
 * @route   GET /api/v1/scheduler/schedule
 * @access  Private (Admin only)
 */
exports.getSchedule = asyncHandler(async (req, res) => {
  const schedule = schedulerService.getSchedule();
  
  res.status(200).json({
    success: true,
    data: schedule
  });
});

/**
 * @desc    Manually trigger a scheduled job
 * @route   POST /api/v1/scheduler/trigger/:jobName
 * @access  Private (Admin only)
 */
exports.triggerJob = asyncHandler(async (req, res) => {
  const { jobName } = req.params;
  
  const validJobs = [
    'daily-budget-check',
    'weekly-summary',
    'spending-insights',
    'reset-counters',
    'monthly-budget-reset'
  ];

  if (!validJobs.includes(jobName)) {
    throw new AppError('Invalid job name', 400);
  }

  const result = await schedulerService.triggerJob(jobName);
  
  res.status(200).json({
    success: true,
    message: `Job '${jobName}' executed successfully`,
    data: result
  });
});

/**
 * @desc    Start scheduler
 * @route   POST /api/v1/scheduler/start
 * @access  Private (Admin only)
 */
exports.startScheduler = asyncHandler(async (req, res) => {
  schedulerService.start();
  
  res.status(200).json({
    success: true,
    message: 'Scheduler started successfully'
  });
});

/**
 * @desc    Stop scheduler
 * @route   POST /api/v1/scheduler/stop
 * @access  Private (Admin only)
 */
exports.stopScheduler = asyncHandler(async (req, res) => {
  schedulerService.stop();
  
  res.status(200).json({
    success: true,
    message: 'Scheduler stopped successfully'
  });
});

/**
 * @desc    Test budget check (check for current user only)
 * @route   POST /api/v1/scheduler/test/budget-check
 * @access  Private
 */
exports.testBudgetCheck = asyncHandler(async (req, res) => {
  const Budget = require('../models/Budget');
  const Expense = require('../models/Expense');
  const { addNotificationJob } = require('../config/queue');

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  // Find user's active budgets
  const budgets = await Budget.find({
    userId: req.user._id,
    period: 'monthly',
    isActive: true
  });

  const results = [];

  for (const budget of budgets) {
    const spending = await Expense.aggregate([
      {
        $match: {
          userId: req.user._id,
          category: budget.category,
          date: { $gte: startOfMonth, $lte: endOfMonth }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' }
        }
      }
    ]);

    const totalSpent = spending[0]?.total || 0;
    const percentage = (totalSpent / budget.amount) * 100;
    const remaining = budget.amount - totalSpent;

    results.push({
      category: budget.category,
      budgetAmount: budget.amount,
      spent: totalSpent,
      remaining,
      percentage: Math.round(percentage),
      status: percentage >= 100 ? 'exceeded' : percentage >= 80 ? 'warning' : 'ok'
    });

    // Send test notification if needed
    if (percentage >= 80) {
      await addNotificationJob({
        userId: req.user._id.toString(),
        type: percentage >= 100 ? 'budget_exceeded' : 'budget_warning',
        data: {
          budget: {
            id: budget._id,
            category: budget.category,
            amount: budget.amount,
            spent: totalSpent,
            remaining: percentage < 100 ? remaining : undefined,
            overspent: percentage >= 100 ? totalSpent - budget.amount : undefined,
            percentage: Math.round(percentage)
          }
        },
        urgency: percentage >= 100 ? 'instant' : 'daily'
      });
    }
  }

  res.status(200).json({
    success: true,
    message: 'Budget check completed',
    data: {
      budgetCount: budgets.length,
      results
    }
  });
});

/**
 * @desc    Test weekly summary (generate for current user only)
 * @route   POST /api/v1/scheduler/test/weekly-summary
 * @access  Private
 */
exports.testWeeklySummary = asyncHandler(async (req, res) => {
  const Expense = require('../models/Expense');
  const Income = require('../models/Income');
  const { addNotificationJob } = require('../config/queue');

  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const expenses = await Expense.aggregate([
    {
      $match: {
        userId: req.user._id,
        date: { $gte: oneWeekAgo, $lte: now }
      }
    },
    {
      $group: {
        _id: '$category',
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    },
    { $sort: { total: -1 } }
  ]);

  const income = await Income.aggregate([
    {
      $match: {
        userId: req.user._id,
        date: { $gte: oneWeekAgo, $lte: now }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$amount' }
      }
    }
  ]);

  const totalExpenses = expenses.reduce((sum, cat) => sum + cat.total, 0);
  const totalIncome = income[0]?.total || 0;
  const netSavings = totalIncome - totalExpenses;
  const transactionCount = expenses.reduce((sum, cat) => sum + cat.count, 0);

  const topCategories = expenses.slice(0, 3).map(cat => ({
    category: cat._id,
    amount: cat.total,
    count: cat.count
  }));

  // Send test notification
  if (transactionCount > 0) {
    await addNotificationJob({
      userId: req.user._id.toString(),
      type: 'weekly_summary',
      data: {
        summary: {
          startDate: oneWeekAgo,
          endDate: now,
          totalExpenses,
          totalIncome,
          netSavings,
          transactionCount,
          topCategories,
          categoryBreakdown: expenses
        }
      },
      urgency: 'weekly'
    });
  }

  res.status(200).json({
    success: true,
    message: 'Weekly summary generated',
    data: {
      totalExpenses,
      totalIncome,
      netSavings,
      transactionCount,
      topCategories,
      categoryBreakdown: expenses
    }
  });
});

/**
 * @desc    Test spending insights (analyze for current user only)
 * @route   POST /api/v1/scheduler/test/spending-insights
 * @access  Private
 */
exports.testSpendingInsights = asyncHandler(async (req, res) => {
  const Expense = require('../models/Expense');
  const { addNotificationJob } = require('../config/queue');

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const currentMonthSpending = await Expense.aggregate([
    {
      $match: {
        userId: req.user._id,
        date: { $gte: thirtyDaysAgo, $lte: now }
      }
    },
    {
      $group: {
        _id: '$category',
        total: { $sum: '$amount' },
        count: { $sum: 1 },
        avgAmount: { $avg: '$amount' }
      }
    }
  ]);

  const previousMonthSpending = await Expense.aggregate([
    {
      $match: {
        userId: req.user._id,
        date: { $gte: sixtyDaysAgo, $lt: thirtyDaysAgo }
      }
    },
    {
      $group: {
        _id: '$category',
        total: { $sum: '$amount' }
      }
    }
  ]);

  const previousSpendingMap = new Map(
    previousMonthSpending.map(cat => [cat._id, cat.total])
  );

  const insights = [];

  for (const currentCat of currentMonthSpending) {
    const previousAmount = previousSpendingMap.get(currentCat._id) || 0;
    const increase = currentCat.total - previousAmount;
    const percentageChange = previousAmount > 0 
      ? ((increase / previousAmount) * 100) 
      : 100;

    if (percentageChange > 30 && increase > 5000) {
      insights.push({
        pattern: 'increased_spending',
        category: currentCat._id,
        currentAmount: currentCat.total,
        previousAmount,
        change: increase,
        percentageChange: Math.round(percentageChange)
      });

      await addNotificationJob({
        userId: req.user._id.toString(),
        type: 'spending_insight',
        data: {
          insight: {
            pattern: 'increased_spending',
            category: currentCat._id,
            currentAmount: currentCat.total,
            previousAmount,
            change: increase,
            percentageChange: Math.round(percentageChange),
            transactionCount: currentCat.count,
            avgTransactionAmount: Math.round(currentCat.avgAmount)
          }
        },
        urgency: 'daily'
      });
    }

    if (currentCat.count > 20 && currentCat.avgAmount < 2000) {
      insights.push({
        pattern: 'frequent_small_purchases',
        category: currentCat._id,
        transactionCount: currentCat.count,
        avgAmount: Math.round(currentCat.avgAmount)
      });

      await addNotificationJob({
        userId: req.user._id.toString(),
        type: 'spending_insight',
        data: {
          insight: {
            pattern: 'frequent_small_purchases',
            category: currentCat._id,
            transactionCount: currentCat.count,
            totalAmount: currentCat.total,
            avgAmount: Math.round(currentCat.avgAmount)
          }
        },
        urgency: 'daily'
      });
    }
  }

  res.status(200).json({
    success: true,
    message: 'Spending insights analyzed',
    data: {
      insightCount: insights.length,
      insights,
      currentMonthSpending,
      previousMonthSpending
    }
  });
});
