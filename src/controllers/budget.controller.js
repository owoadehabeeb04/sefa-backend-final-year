const Budget = require('../models/Budget');
const Expense = require('../models/Expense');
const { asyncHandler } = require('../middleware/asyncHandler');
const AppError = require('../utils/AppError');

/**
 * @desc    Create new budget
 * @route   POST /api/v1/budgets
 * @access  Private
 */
exports.createBudget = asyncHandler(async (req, res) => {
  const { category, amount, period, warningThreshold, criticalThreshold, rollover, notes } = req.body;

  // Check if budget already exists for this category and period
  const existingBudget = await Budget.findOne({
    userId: req.user._id,
    category,
    period: period || 'monthly',
    isActive: true
  });

  if (existingBudget) {
    throw new AppError(`Active budget already exists for ${category}`, 400);
  }

  const budget = await Budget.create({
    userId: req.user._id,
    category,
    amount,
    period: period || 'monthly',
    warningThreshold: warningThreshold || 80,
    criticalThreshold: criticalThreshold || 100,
    rollover: rollover || false,
    notes
  });

  // Get initial progress
  const progress = await budget.getProgress();

  res.status(201).json({
    success: true,
    message: 'Budget created successfully',
    data: {
      ...budget.toObject(),
      progress
    }
  });
});

/**
 * @desc    Get all budgets for user
 * @route   GET /api/v1/budgets
 * @access  Private
 */
exports.getBudgets = asyncHandler(async (req, res) => {
  const { active, period, category } = req.query;

  const filter = { userId: req.user._id };

  if (active !== undefined) {
    filter.isActive = active === 'true';
  }

  if (period) {
    filter.period = period;
  }

  if (category) {
    filter.category = category;
  }

  const budgets = await Budget.find(filter).sort({ category: 1 });

  // Get progress for each budget
  const budgetsWithProgress = await Promise.all(
    budgets.map(async (budget) => {
      const progress = await budget.getProgress();
      return {
        ...budget.toObject(),
        progress
      };
    })
  );

  res.status(200).json({
    success: true,
    count: budgetsWithProgress.length,
    data: budgetsWithProgress
  });
});

/**
 * @desc    Get single budget by ID
 * @route   GET /api/v1/budgets/:id
 * @access  Private
 */
exports.getBudget = asyncHandler(async (req, res) => {
  const budget = await Budget.findById(req.params.id);

  if (!budget) {
    throw new AppError('Budget not found', 404);
  }

  // Verify ownership
  if (budget.userId.toString() !== req.user._id.toString()) {
    throw new AppError('Not authorized to access this budget', 403);
  }

  const progress = await budget.getProgress();

  res.status(200).json({
    success: true,
    data: {
      ...budget.toObject(),
      progress
    }
  });
});

/**
 * @desc    Update budget
 * @route   PUT /api/v1/budgets/:id
 * @access  Private
 */
exports.updateBudget = asyncHandler(async (req, res) => {
  let budget = await Budget.findById(req.params.id);

  if (!budget) {
    throw new AppError('Budget not found', 404);
  }

  // Verify ownership
  if (budget.userId.toString() !== req.user._id.toString()) {
    throw new AppError('Not authorized to update this budget', 403);
  }

  const { amount, warningThreshold, criticalThreshold, rollover, notes, isActive } = req.body;

  // Track if amount changed significantly
  const oldAmount = budget.amount;

  // Update fields
  if (amount !== undefined) budget.amount = amount;
  if (warningThreshold !== undefined) budget.warningThreshold = warningThreshold;
  if (criticalThreshold !== undefined) budget.criticalThreshold = criticalThreshold;
  if (rollover !== undefined) budget.rollover = rollover;
  if (notes !== undefined) budget.notes = notes;
  if (isActive !== undefined) budget.isActive = isActive;

  // Reset notification flags if amount changed significantly (>10%)
  if (amount && oldAmount) {
    const amountChange = Math.abs((amount - oldAmount) / oldAmount);
    if (amountChange > 0.1) {
      budget.resetNotifications();
    }
  }

  await budget.save();

  const progress = await budget.getProgress();

  res.status(200).json({
    success: true,
    message: 'Budget updated successfully',
    data: {
      ...budget.toObject(),
      progress
    }
  });
});

/**
 * @desc    Delete budget
 * @route   DELETE /api/v1/budgets/:id
 * @access  Private
 */
exports.deleteBudget = asyncHandler(async (req, res) => {
  const budget = await Budget.findById(req.params.id);

  if (!budget) {
    throw new AppError('Budget not found', 404);
  }

  // Verify ownership
  if (budget.userId.toString() !== req.user._id.toString()) {
    throw new AppError('Not authorized to delete this budget', 403);
  }

  await budget.deleteOne();

  res.status(200).json({
    success: true,
    message: 'Budget deleted successfully',
    data: {}
  });
});

/**
 * @desc    Get budget summary/overview
 * @route   GET /api/v1/budgets/summary
 * @access  Private
 */
exports.getBudgetSummary = asyncHandler(async (req, res) => {
  const budgets = await Budget.find({
    userId: req.user._id,
    isActive: true
  });

  let totalBudgeted = 0;
  let totalSpent = 0;
  let totalRemaining = 0;
  let budgetsAtRisk = 0;
  let budgetsExceeded = 0;

  const budgetDetails = await Promise.all(
    budgets.map(async (budget) => {
      const progress = await budget.getProgress();
      
      totalBudgeted += budget.amount;
      totalSpent += progress.spent;
      totalRemaining += progress.remaining;

      if (progress.status === 'warning') budgetsAtRisk++;
      if (progress.status === 'exceeded') budgetsExceeded++;

      return {
        category: budget.category,
        budgeted: budget.amount,
        spent: progress.spent,
        remaining: progress.remaining,
        percentage: progress.percentage,
        status: progress.status
      };
    })
  );

  res.status(200).json({
    success: true,
    data: {
      summary: {
        totalBudgeted,
        totalSpent,
        totalRemaining,
        overallPercentage: totalBudgeted > 0 ? Math.round((totalSpent / totalBudgeted) * 100) : 0,
        budgetCount: budgets.length,
        budgetsAtRisk,
        budgetsExceeded
      },
      budgets: budgetDetails.sort((a, b) => b.percentage - a.percentage)
    }
  });
});

/**
 * @desc    Get budget analytics
 * @route   GET /api/v1/budgets/:id/analytics
 * @access  Private
 */
exports.getBudgetAnalytics = asyncHandler(async (req, res) => {
  const budget = await Budget.findById(req.params.id);

  if (!budget) {
    throw new AppError('Budget not found', 404);
  }

  // Verify ownership
  if (budget.userId.toString() !== req.user._id.toString()) {
    throw new AppError('Not authorized to access this budget', 403);
  }

  // Get daily spending breakdown
  const dailySpending = await Expense.aggregate([
    {
      $match: {
        userId: req.user._id,
        category: budget.category,
        date: { $gte: budget.startDate, $lte: budget.endDate }
      }
    },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  // Calculate daily average
  const progress = await budget.getProgress();
  const daysInPeriod = Math.ceil((budget.endDate - budget.startDate) / (1000 * 60 * 60 * 24));
  const daysElapsed = Math.ceil((new Date() - budget.startDate) / (1000 * 60 * 60 * 24));
  const daysRemaining = daysInPeriod - daysElapsed;
  
  const dailyAverage = daysElapsed > 0 ? progress.spent / daysElapsed : 0;
  const projectedSpending = dailyAverage * daysInPeriod;
  const recommendedDailySpend = daysRemaining > 0 ? progress.remaining / daysRemaining : 0;

  // Get transaction details
  const transactions = await Expense.find({
    userId: req.user._id,
    category: budget.category,
    date: { $gte: budget.startDate, $lte: budget.endDate }
  })
    .sort({ date: -1, amount: -1 })
    .limit(10)
    .select('date description amount');

  // Get largest expenses
  const largestExpenses = await Expense.find({
    userId: req.user._id,
    category: budget.category,
    date: { $gte: budget.startDate, $lte: budget.endDate }
  })
    .sort({ amount: -1 })
    .limit(5)
    .select('date description amount');

  res.status(200).json({
    success: true,
    data: {
      budget: {
        category: budget.category,
        amount: budget.amount,
        period: budget.period,
        startDate: budget.startDate,
        endDate: budget.endDate
      },
      progress,
      insights: {
        daysInPeriod,
        daysElapsed,
        daysRemaining,
        dailyAverage: Math.round(dailyAverage),
        projectedSpending: Math.round(projectedSpending),
        recommendedDailySpend: Math.round(recommendedDailySpend),
        onTrack: projectedSpending <= budget.amount,
        projectedOverage: projectedSpending > budget.amount 
          ? Math.round(projectedSpending - budget.amount) 
          : 0
      },
      dailySpending,
      recentTransactions: transactions,
      largestExpenses
    }
  });
});

/**
 * @desc    Get spending forecast
 * @route   GET /api/v1/budgets/:id/forecast
 * @access  Private
 */
exports.getSpendingForecast = asyncHandler(async (req, res) => {
  const budget = await Budget.findById(req.params.id);

  if (!budget) {
    throw new AppError('Budget not found', 404);
  }

  // Verify ownership
  if (budget.userId.toString() !== req.user._id.toString()) {
    throw new AppError('Not authorized to access this budget', 403);
  }

  // Get historical spending for the category (last 3 months)
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const historicalSpending = await Expense.aggregate([
    {
      $match: {
        userId: req.user._id,
        category: budget.category,
        date: { $gte: threeMonthsAgo }
      }
    },
    {
      $group: {
        _id: {
          year: { $year: '$date' },
          month: { $month: '$date' }
        },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
        average: { $avg: '$amount' }
      }
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } }
  ]);

  // Calculate trend
  const monthlyAverages = historicalSpending.map(h => h.total);
  const historicalAverage = monthlyAverages.length > 0
    ? monthlyAverages.reduce((a, b) => a + b, 0) / monthlyAverages.length
    : 0;

  // Calculate trend (simple linear regression)
  let trend = 'stable';
  if (monthlyAverages.length >= 2) {
    const recentAvg = (monthlyAverages[monthlyAverages.length - 1] + 
                      (monthlyAverages[monthlyAverages.length - 2] || 0)) / 
                      (monthlyAverages.length > 1 ? 2 : 1);
    const olderAvg = monthlyAverages.slice(0, -1).reduce((a, b) => a + b, 0) / 
                     Math.max(monthlyAverages.length - 1, 1);
    
    const change = ((recentAvg - olderAvg) / olderAvg) * 100;
    
    if (change > 10) trend = 'increasing';
    else if (change < -10) trend = 'decreasing';
  }

  // Current period progress
  const progress = await budget.getProgress();
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  const daysInPeriod = Math.max(1, Math.floor((budget.endDate - budget.startDate) / MS_PER_DAY) + 1);
  const daysElapsed = Math.max(1, Math.min(
    daysInPeriod,
    Math.floor((new Date() - budget.startDate) / MS_PER_DAY) + 1,
  ));
  const daysRemaining = Math.max(daysInPeriod - daysElapsed, 0);

  // Forecast based on current spending rate
  const currentDailyRate = daysElapsed > 0 ? progress.spent / daysElapsed : 0;
  const forecastedTotal = currentDailyRate * daysInPeriod;

  // Forecast based on historical average
  const historicalForecast = historicalAverage;

  // Weighted forecast (70% current rate, 30% historical)
  const weightedForecast = (forecastedTotal * 0.7) + (historicalForecast * 0.3);

  // Probability of exceeding budget
  const exceedProbability = weightedForecast > budget.amount
    ? Math.min(((weightedForecast - budget.amount) / budget.amount) * 100, 100)
    : 0;

  // Recommendations
  const recommendations = [];
  
  if (forecastedTotal > budget.amount) {
    const neededReduction = forecastedTotal - budget.amount;
    const dailyReductionNeeded = daysRemaining > 0 ? neededReduction / daysRemaining : 0;
    
    recommendations.push({
      type: 'reduce_spending',
      message: `Reduce daily spending by ₦${Math.round(dailyReductionNeeded)} to stay within budget`,
      priority: 'high'
    });
  }

  if (trend === 'increasing') {
    recommendations.push({
      type: 'increasing_trend',
      message: `Your ${budget.category} spending has been increasing. Consider reviewing expenses.`,
      priority: 'medium'
    });
  }

  if (progress.percentage > 50 && daysElapsed / daysInPeriod < 0.5) {
    recommendations.push({
      type: 'ahead_of_schedule',
      message: `You've spent ${Math.round(progress.percentage)}% of budget in ${Math.round((daysElapsed / daysInPeriod) * 100)}% of the period`,
      priority: 'high'
    });
  }

  res.status(200).json({
    success: true,
    data: {
      budget: {
        category: budget.category,
        amount: budget.amount,
        spent: progress.spent,
        remaining: progress.remaining
      },
      forecast: {
        current: Math.round(progress.spent),
        forecastedTotal: Math.round(forecastedTotal),
        historicalAverage: Math.round(historicalAverage),
        weightedForecast: Math.round(weightedForecast),
        exceedProbability: Math.round(exceedProbability),
        trend
      },
      timeline: {
        daysInPeriod,
        daysElapsed,
        daysRemaining,
        percentComplete: Math.round((daysElapsed / daysInPeriod) * 100)
      },
      rates: {
        currentDailyRate: Math.round(currentDailyRate),
        recommendedDailyRate: Math.round(daysRemaining > 0 ? progress.remaining / daysRemaining : 0),
        mustNotExceed: Math.round(daysRemaining > 0 ? (budget.amount - progress.spent) / daysRemaining : 0)
      },
      historical: historicalSpending.map(h => ({
        month: `${h._id.year}-${String(h._id.month).padStart(2, '0')}`,
        total: h.total,
        count: h.count,
        average: Math.round(h.average)
      })),
      recommendations
    }
  });
});

/**
 * @desc    Bulk create budgets from template
 * @route   POST /api/v1/budgets/bulk
 * @access  Private
 */
exports.bulkCreateBudgets = asyncHandler(async (req, res) => {
  const { budgets } = req.body;

  if (!Array.isArray(budgets) || budgets.length === 0) {
    throw new AppError('Please provide an array of budgets', 400);
  }

  const createdBudgets = [];
  const errors = [];

  for (const budgetData of budgets) {
    try {
      const budget = await Budget.createOrUpdate(
        req.user._id,
        budgetData.category,
        budgetData.amount,
        {
          period: budgetData.period || 'monthly',
          warningThreshold: budgetData.warningThreshold || 80,
          criticalThreshold: budgetData.criticalThreshold || 100,
          rollover: budgetData.rollover || false,
          notes: budgetData.notes
        }
      );

      const progress = await budget.getProgress();
      createdBudgets.push({ ...budget.toObject(), progress });
    } catch (error) {
      errors.push({
        category: budgetData.category,
        error: error.message
      });
    }
  }

  res.status(201).json({
    success: true,
    message: `Created/updated ${createdBudgets.length} budgets`,
    data: {
      created: createdBudgets,
      errors: errors.length > 0 ? errors : undefined
    }
  });
});

/**
 * @desc    Clone budget to next period
 * @route   POST /api/v1/budgets/:id/renew
 * @access  Private
 */
exports.renewBudget = asyncHandler(async (req, res) => {
  const budget = await Budget.findById(req.params.id);

  if (!budget) {
    throw new AppError('Budget not found', 404);
  }

  // Verify ownership
  if (budget.userId.toString() !== req.user._id.toString()) {
    throw new AppError('Not authorized to renew this budget', 403);
  }

  const newBudget = await budget.renewForNextPeriod();
  const progress = await newBudget.getProgress();

  res.status(201).json({
    success: true,
    message: 'Budget renewed for next period',
    data: {
      ...newBudget.toObject(),
      progress
    }
  });
});
