const Expense = require('../models/Expense');
const Income = require('../models/Income');
const Category = require('../models/Category');
const mongoose = require('mongoose');
const moment = require('moment');

/**
 * Spending Pattern Analyzer Service
 * Analyzes user spending patterns, trends, and behaviors
 */

/**
 * Analyze spending patterns for a user
 * @param {String} userId - User ID
 * @param {Object} options - Analysis options
 * @param {Number} options.months - Number of months to analyze (default: 3)
 * @returns {Promise<Object>} Comprehensive spending pattern analysis
 */
async function analyzeSpendingPatterns(userId, options = {}) {
  const { months = 3 } = options;

  const startDate = moment().subtract(months, 'months').startOf('day').toDate();
  const endDate = moment().endOf('day').toDate();

  const [
    categoryTrends,
    temporalPatterns,
    spendingVelocity,
    categoryConcentration,
    monthlyComparison,
    weekdayPatterns,
    averageTransactionSize
  ] = await Promise.all([
    analyzeCategoryTrends(userId, startDate, endDate),
    analyzeTemporalPatterns(userId, startDate, endDate),
    analyzeSpendingVelocity(userId, startDate, endDate),
    analyzeCategoryConcentration(userId, startDate, endDate),
    analyzeMonthlyComparison(userId, months),
    analyzeWeekdayPatterns(userId, startDate, endDate),
    analyzeAverageTransactionSize(userId, startDate, endDate)
  ]);

  return {
    period: {
      startDate,
      endDate,
      months
    },
    categoryTrends,
    temporalPatterns,
    spendingVelocity,
    categoryConcentration,
    monthlyComparison,
    weekdayPatterns,
    averageTransactionSize,
    insights: generatePatternInsights({
      categoryTrends,
      temporalPatterns,
      spendingVelocity,
      categoryConcentration,
      monthlyComparison,
      weekdayPatterns
    })
  };
}

function normalizeUserId(userId) {
  if (mongoose.Types.ObjectId.isValid(userId)) {
    return new mongoose.Types.ObjectId(String(userId));
  }
  return userId;
}

/**
 * Analyze category spending trends
 * @param {String} userId - User ID
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Promise<Array>} Category trends
 */
async function analyzeCategoryTrends(userId, startDate, endDate) {
  const normalizedUserId = normalizeUserId(userId);
  const categorySpending = await Expense.aggregate([
    {
      $match: {
        userId: normalizedUserId,
        date: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $lookup: {
        from: 'categories',
        localField: 'categoryId',
        foreignField: '_id',
        as: 'category'
      }
    },
    {
      $unwind: {
        path: '$category',
        preserveNullAndEmptyArrays: true
      }
    },
    {
      $group: {
        _id: {
          categoryId: '$categoryId',
          categoryName: '$category.name',
          month: { $month: '$date' },
          year: { $year: '$date' }
        },
        totalAmount: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    },
    {
      $sort: { '_id.year': 1, '_id.month': 1 }
    }
  ]);

  // Group by category and calculate trend
  const categoryMap = {};
  
  categorySpending.forEach(item => {
    const categoryId = item._id.categoryId?.toString() || 'uncategorized';
    const categoryName = item._id.categoryName || 'Uncategorized';
    
    if (!categoryMap[categoryId]) {
      categoryMap[categoryId] = {
        categoryId,
        categoryName,
        monthlyData: []
      };
    }
    
    categoryMap[categoryId].monthlyData.push({
      month: item._id.month,
      year: item._id.year,
      amount: item.totalAmount,
      count: item.count
    });
  });

  // Calculate trend for each category
  const trends = Object.values(categoryMap).map(category => {
    const monthlyData = category.monthlyData;
    const trend = calculateTrend(monthlyData.map(m => m.amount));
    const averageAmount = monthlyData.reduce((sum, m) => sum + m.amount, 0) / monthlyData.length;
    
    return {
      categoryId: category.categoryId,
      categoryName: category.categoryName,
      trend, // 'increasing', 'decreasing', 'stable'
      averageMonthlyAmount: Math.round(averageAmount),
      totalAmount: monthlyData.reduce((sum, m) => sum + m.amount, 0),
      totalTransactions: monthlyData.reduce((sum, m) => sum + m.count, 0),
      monthlyData: monthlyData
    };
  });

  return trends.sort((a, b) => b.totalAmount - a.totalAmount);
}

/**
 * Analyze temporal spending patterns (time of day, day of week, etc.)
 * @param {String} userId - User ID
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Promise<Object>} Temporal patterns
 */
async function analyzeTemporalPatterns(userId, startDate, endDate) {
  const expenses = await Expense.find({
    userId,
    date: { $gte: startDate, $lte: endDate }
  }).select('date amount');

  const hourlySpending = new Array(24).fill(0);
  const dailySpending = new Array(7).fill(0); // 0 = Sunday
  const monthlySpending = {};

  expenses.forEach(expense => {
    const date = moment(expense.date);
    const hour = date.hour();
    const dayOfWeek = date.day();
    const monthKey = date.format('YYYY-MM');

    hourlySpending[hour] += expense.amount;
    dailySpending[dayOfWeek] += expense.amount;
    monthlySpending[monthKey] = (monthlySpending[monthKey] || 0) + expense.amount;
  });

  // Find peak spending times
  const peakHour = hourlySpending.indexOf(Math.max(...hourlySpending));
  const peakDay = dailySpending.indexOf(Math.max(...dailySpending));

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return {
    hourlyDistribution: hourlySpending.map((amount, hour) => ({
      hour,
      amount: Math.round(amount),
      percentage: expenses.length > 0 ? Math.round((amount / hourlySpending.reduce((a, b) => a + b, 0)) * 100) : 0
    })),
    dailyDistribution: dailySpending.map((amount, day) => ({
      day: dayNames[day],
      amount: Math.round(amount),
      percentage: expenses.length > 0 ? Math.round((amount / dailySpending.reduce((a, b) => a + b, 0)) * 100) : 0
    })),
    peakSpendingHour: peakHour,
    peakSpendingDay: dayNames[peakDay],
    monthlyTotals: Object.entries(monthlySpending).map(([month, amount]) => ({
      month,
      amount: Math.round(amount)
    }))
  };
}

/**
 * Analyze spending velocity (rate of spending)
 * @param {String} userId - User ID
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Promise<Object>} Spending velocity analysis
 */
async function analyzeSpendingVelocity(userId, startDate, endDate) {
  const expenses = await Expense.find({
    userId,
    date: { $gte: startDate, $lte: endDate }
  }).sort('date').select('date amount');

  if (expenses.length === 0) {
    return {
      dailyAverageSpend: 0,
      weeklyAverageSpend: 0,
      monthlyAverageSpend: 0,
      velocity: 'none'
    };
  }

  const totalAmount = expenses.reduce((sum, exp) => sum + exp.amount, 0);
  const totalDays = moment(endDate).diff(moment(startDate), 'days') + 1;
  const totalWeeks = Math.ceil(totalDays / 7);
  const totalMonths = moment(endDate).diff(moment(startDate), 'months', true);

  const dailyAverage = totalAmount / totalDays;
  const weeklyAverage = totalAmount / totalWeeks;
  const monthlyAverage = totalMonths > 0 ? totalAmount / totalMonths : totalAmount;

  // Calculate velocity trend (are they spending faster or slower over time?)
  const midPoint = Math.floor(expenses.length / 2);
  const firstHalfAvg = expenses.slice(0, midPoint).reduce((sum, exp) => sum + exp.amount, 0) / midPoint;
  const secondHalfAvg = expenses.slice(midPoint).reduce((sum, exp) => sum + exp.amount, 0) / (expenses.length - midPoint);

  let velocity = 'stable';
  if (secondHalfAvg > firstHalfAvg * 1.2) {
    velocity = 'accelerating';
  } else if (secondHalfAvg < firstHalfAvg * 0.8) {
    velocity = 'decelerating';
  }

  return {
    dailyAverageSpend: Math.round(dailyAverage),
    weeklyAverageSpend: Math.round(weeklyAverage),
    monthlyAverageSpend: Math.round(monthlyAverage),
    velocity,
    firstHalfAverage: Math.round(firstHalfAvg),
    secondHalfAverage: Math.round(secondHalfAvg)
  };
}

/**
 * Analyze category concentration (how concentrated spending is in few categories)
 * @param {String} userId - User ID
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Promise<Object>} Category concentration analysis
 */
async function analyzeCategoryConcentration(userId, startDate, endDate) {
  const normalizedUserId = normalizeUserId(userId);
  const categoryTotals = await Expense.aggregate([
    {
      $match: {
        userId: normalizedUserId,
        date: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $lookup: {
        from: 'categories',
        localField: 'categoryId',
        foreignField: '_id',
        as: 'category'
      }
    },
    {
      $unwind: {
        path: '$category',
        preserveNullAndEmptyArrays: true
      }
    },
    {
      $group: {
        _id: '$categoryId',
        categoryName: { $first: '$category.name' },
        totalAmount: { $sum: '$amount' }
      }
    },
    {
      $sort: { totalAmount: -1 }
    }
  ]);

  const totalSpending = categoryTotals.reduce((sum, cat) => sum + cat.totalAmount, 0);

  if (totalSpending === 0) {
    return {
      concentration: 'none',
      topCategoryPercentage: 0,
      top3CategoriesPercentage: 0,
      diversityScore: 0
    };
  }

  const topCategoryPercentage = categoryTotals.length > 0
    ? (categoryTotals[0].totalAmount / totalSpending) * 100
    : 0;

  const top3Total = categoryTotals.slice(0, 3).reduce((sum, cat) => sum + cat.totalAmount, 0);
  const top3Percentage = (top3Total / totalSpending) * 100;

  // Calculate diversity score (0-100, higher is more diverse)
  const diversityScore = categoryTotals.length > 0
    ? Math.min(100, (categoryTotals.length * 10) - topCategoryPercentage)
    : 0;

  let concentration = 'balanced';
  if (topCategoryPercentage > 50) {
    concentration = 'highly concentrated';
  } else if (topCategoryPercentage > 30) {
    concentration = 'moderately concentrated';
  }

  return {
    concentration,
    topCategoryPercentage: Math.round(topCategoryPercentage),
    top3CategoriesPercentage: Math.round(top3Percentage),
    diversityScore: Math.round(diversityScore),
    totalCategories: categoryTotals.length
  };
}

/**
 * Analyze monthly spending comparison
 * @param {String} userId - User ID
 * @param {Number} months - Number of months to compare
 * @returns {Promise<Object>} Monthly comparison
 */
async function analyzeMonthlyComparison(userId, months) {
  const normalizedUserId = normalizeUserId(userId);
  const comparisons = [];

  for (let i = 0; i < months; i++) {
    const monthStart = moment().subtract(i, 'months').startOf('month').toDate();
    const monthEnd = moment().subtract(i, 'months').endOf('month').toDate();

    const [expenses, income] = await Promise.all([
      Expense.aggregate([
        {
          $match: {
            userId: normalizedUserId,
            date: { $gte: monthStart, $lte: monthEnd }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        }
      ]),
      Income.aggregate([
        {
          $match: {
            userId: normalizedUserId,
            date: { $gte: monthStart, $lte: monthEnd }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    const expenseTotal = expenses.length > 0 ? expenses[0].total : 0;
    const expenseCount = expenses.length > 0 ? expenses[0].count : 0;
    const incomeTotal = income.length > 0 ? income[0].total : 0;
    const incomeCount = income.length > 0 ? income[0].count : 0;

    comparisons.push({
      month: moment().subtract(i, 'months').format('MMMM YYYY'),
      expenses: Math.round(expenseTotal),
      income: Math.round(incomeTotal),
      balance: Math.round(incomeTotal - expenseTotal),
      expenseCount,
      incomeCount,
      savingsRate: incomeTotal > 0 ? Math.round(((incomeTotal - expenseTotal) / incomeTotal) * 100) : 0
    });
  }

  return comparisons;
}

/**
 * Analyze weekday vs weekend spending patterns
 * @param {String} userId - User ID
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Promise<Object>} Weekday patterns
 */
async function analyzeWeekdayPatterns(userId, startDate, endDate) {
  const expenses = await Expense.find({
    userId,
    date: { $gte: startDate, $lte: endDate }
  }).select('date amount');

  let weekdayTotal = 0;
  let weekendTotal = 0;
  let weekdayCount = 0;
  let weekendCount = 0;

  expenses.forEach(expense => {
    const dayOfWeek = moment(expense.date).day();
    if (dayOfWeek === 0 || dayOfWeek === 6) { // Sunday or Saturday
      weekendTotal += expense.amount;
      weekendCount++;
    } else {
      weekdayTotal += expense.amount;
      weekdayCount++;
    }
  });

  return {
    weekdayTotal: Math.round(weekdayTotal),
    weekendTotal: Math.round(weekendTotal),
    weekdayAverage: weekdayCount > 0 ? Math.round(weekdayTotal / weekdayCount) : 0,
    weekendAverage: weekendCount > 0 ? Math.round(weekendTotal / weekendCount) : 0,
    weekdayCount,
    weekendCount,
    preference: weekendTotal > weekdayTotal ? 'weekend spender' : 'weekday spender'
  };
}

/**
 * Analyze average transaction size
 * @param {String} userId - User ID
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Promise<Object>} Transaction size analysis
 */
async function analyzeAverageTransactionSize(userId, startDate, endDate) {
  const expenses = await Expense.find({
    userId,
    date: { $gte: startDate, $lte: endDate }
  }).select('amount').sort('amount');

  if (expenses.length === 0) {
    return {
      average: 0,
      median: 0,
      smallest: 0,
      largest: 0
    };
  }

  const amounts = expenses.map(e => e.amount);
  const total = amounts.reduce((sum, amt) => sum + amt, 0);
  const average = total / amounts.length;
  const median = amounts[Math.floor(amounts.length / 2)];

  return {
    average: Math.round(average),
    median: Math.round(median),
    smallest: Math.round(amounts[0]),
    largest: Math.round(amounts[amounts.length - 1]),
    totalTransactions: expenses.length
  };
}

/**
 * Calculate trend from array of values
 * @param {Array} values - Array of values
 * @returns {String} Trend direction
 */
function calculateTrend(values) {
  if (values.length < 2) return 'stable';

  const firstHalf = values.slice(0, Math.floor(values.length / 2));
  const secondHalf = values.slice(Math.floor(values.length / 2));

  const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  if (secondAvg > firstAvg * 1.1) return 'increasing';
  if (secondAvg < firstAvg * 0.9) return 'decreasing';
  return 'stable';
}

/**
 * Generate actionable insights from patterns
 * @param {Object} patterns - All pattern data
 * @returns {Array} Array of insights
 */
function generatePatternInsights(patterns) {
  const insights = [];

  // Category trend insights
  if (patterns.categoryTrends && patterns.categoryTrends.length > 0) {
    const increasingCategories = patterns.categoryTrends.filter(c => c.trend === 'increasing');
    if (increasingCategories.length > 0) {
      insights.push({
        type: 'trend',
        severity: 'info',
        message: `Your ${increasingCategories[0].categoryName} spending has been increasing. Consider reviewing this category.`,
        category: increasingCategories[0].categoryName
      });
    }
  }

  // Spending velocity insights
  if (patterns.spendingVelocity) {
    if (patterns.spendingVelocity.velocity === 'accelerating') {
      insights.push({
        type: 'velocity',
        severity: 'warning',
        message: `Your spending rate is accelerating. You're spending ${Math.round((patterns.spendingVelocity.secondHalfAverage / patterns.spendingVelocity.firstHalfAverage - 1) * 100)}% more recently.`
      });
    }
  }

  // Concentration insights
  if (patterns.categoryConcentration) {
    if (patterns.categoryConcentration.concentration === 'highly concentrated') {
      insights.push({
        type: 'concentration',
        severity: 'info',
        message: `${patterns.categoryConcentration.topCategoryPercentage}% of your spending is in one category. Consider diversifying your budget.`
      });
    }
  }

  // Weekday pattern insights
  if (patterns.weekdayPatterns) {
    if (patterns.weekdayPatterns.weekendAverage > patterns.weekdayPatterns.weekdayAverage * 1.5) {
      insights.push({
        type: 'temporal',
        severity: 'info',
        message: `You spend significantly more on weekends. Weekend planning could help reduce expenses.`
      });
    }
  }

  return insights;
}

module.exports = {
  analyzeSpendingPatterns,
  analyzeCategoryTrends,
  analyzeTemporalPatterns,
  analyzeSpendingVelocity,
  analyzeCategoryConcentration,
  analyzeMonthlyComparison,
  analyzeWeekdayPatterns,
  analyzeAverageTransactionSize
};
