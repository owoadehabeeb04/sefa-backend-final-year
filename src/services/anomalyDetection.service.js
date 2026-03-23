const Expense = require('../models/Expense');
const Income = require('../models/Income');
const mongoose = require('mongoose');
const moment = require('moment');

/**
 * Anomaly Detection Service
 * Detects unusual spending patterns, outliers, and potential issues
 */

/**
 * Detect anomalies in user's financial activity
 * @param {String} userId - User ID
 * @param {Object} options - Detection options
 * @param {Number} options.lookbackDays - Days to analyze (default: 30)
 * @param {Number} options.threshold - Anomaly sensitivity (1-5, default: 3)
 * @returns {Promise<Object>} Detected anomalies
 */
async function detectAnomalies(userId, options = {}) {
  const { lookbackDays = 30, threshold = 3 } = options;

  const startDate = moment().subtract(lookbackDays, 'days').startOf('day').toDate();
  const endDate = moment().endOf('day').toDate();

  const [
    amountAnomalies,
    frequencyAnomalies,
    categoryAnomalies,
    timeAnomalies,
    duplicateTransactions
  ] = await Promise.all([
    detectAmountAnomalies(userId, startDate, endDate, threshold),
    detectFrequencyAnomalies(userId, startDate, endDate, threshold),
    detectCategoryAnomalies(userId, startDate, endDate, threshold),
    detectTimeAnomalies(userId, startDate, endDate),
    detectPotentialDuplicates(userId, startDate, endDate)
  ]);

  const allAnomalies = [
    ...amountAnomalies,
    ...frequencyAnomalies,
    ...categoryAnomalies,
    ...timeAnomalies,
    ...duplicateTransactions
  ];

  // Sort by severity and date
  allAnomalies.sort((a, b) => {
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    if (severityOrder[a.severity] !== severityOrder[b.severity]) {
      return severityOrder[a.severity] - severityOrder[b.severity];
    }
    return new Date(b.date) - new Date(a.date);
  });

  return {
    period: {
      startDate,
      endDate,
      days: lookbackDays
    },
    summary: {
      totalAnomalies: allAnomalies.length,
      critical: allAnomalies.filter(a => a.severity === 'critical').length,
      high: allAnomalies.filter(a => a.severity === 'high').length,
      medium: allAnomalies.filter(a => a.severity === 'medium').length,
      low: allAnomalies.filter(a => a.severity === 'low').length
    },
    anomalies: allAnomalies,
    recommendations: generateAnomalyRecommendations(allAnomalies)
  };
}

function normalizeUserId(userId) {
  if (mongoose.Types.ObjectId.isValid(userId)) {
    return new mongoose.Types.ObjectId(String(userId));
  }
  return userId;
}

/**
 * Detect amount-based anomalies (unusually large transactions)
 * @param {String} userId - User ID
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @param {Number} threshold - Sensitivity threshold
 * @returns {Promise<Array>} Amount anomalies
 */
async function detectAmountAnomalies(userId, startDate, endDate, threshold) {
  const expenses = await Expense.find({
    userId,
    date: { $gte: startDate, $lte: endDate }
  }).populate('categoryId').sort('-date');

  if (expenses.length < 5) {
    return []; // Not enough data
  }

  const amounts = expenses.map(e => e.amount);
  const mean = amounts.reduce((sum, amt) => sum + amt, 0) / amounts.length;
  const variance = amounts.reduce((sum, amt) => sum + Math.pow(amt - mean, 2), 0) / amounts.length;
  const stdDev = Math.sqrt(variance);

  const anomalies = [];

  // Adjust threshold multiplier based on sensitivity
  const multiplier = 6 - threshold; // threshold 1 = 5x stdDev, threshold 5 = 1x stdDev

  expenses.forEach(expense => {
    const zScore = Math.abs((expense.amount - mean) / stdDev);
    
    if (zScore > multiplier) {
      let severity = 'low';
      if (zScore > multiplier * 2) severity = 'critical';
      else if (zScore > multiplier * 1.5) severity = 'high';
      else if (zScore > multiplier * 1.2) severity = 'medium';

      anomalies.push({
        type: 'unusual_amount',
        severity,
        date: expense.date,
        transactionId: expense._id,
        description: expense.description,
        amount: expense.amount,
        category: expense.categoryId?.name || 'Uncategorized',
        message: `Unusually large transaction: ₦${expense.amount.toLocaleString()} (${Math.round((expense.amount / mean - 1) * 100)}% above average)`,
        details: {
          averageAmount: Math.round(mean),
          standardDeviation: Math.round(stdDev),
          zScore: zScore.toFixed(2),
          percentageAboveAverage: Math.round((expense.amount / mean - 1) * 100)
        }
      });
    }
  });

  return anomalies;
}

/**
 * Detect frequency-based anomalies (unusual spending frequency)
 * @param {String} userId - User ID
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @param {Number} threshold - Sensitivity threshold
 * @returns {Promise<Array>} Frequency anomalies
 */
async function detectFrequencyAnomalies(userId, startDate, endDate, threshold) {
  const expenses = await Expense.find({
    userId,
    date: { $gte: startDate, $lte: endDate }
  }).sort('date');

  if (expenses.length < 10) {
    return []; // Not enough data
  }

  // Group by day
  const dailyTransactions = {};
  expenses.forEach(expense => {
    const day = moment(expense.date).format('YYYY-MM-DD');
    dailyTransactions[day] = (dailyTransactions[day] || 0) + 1;
  });

  const dailyCounts = Object.values(dailyTransactions);
  const mean = dailyCounts.reduce((sum, count) => sum + count, 0) / dailyCounts.length;
  const stdDev = Math.sqrt(
    dailyCounts.reduce((sum, count) => sum + Math.pow(count - mean, 2), 0) / dailyCounts.length
  );

  const anomalies = [];
  const multiplier = 6 - threshold;

  Object.entries(dailyTransactions).forEach(([day, count]) => {
    const zScore = Math.abs((count - mean) / stdDev);
    
    if (zScore > multiplier && count > mean * 2) {
      let severity = 'low';
      if (count > mean * 4) severity = 'high';
      else if (count > mean * 3) severity = 'medium';

      anomalies.push({
        type: 'unusual_frequency',
        severity,
        date: new Date(day),
        message: `Unusually high number of transactions on ${moment(day).format('MMM D, YYYY')}: ${count} transactions`,
        details: {
          transactionCount: count,
          averageDaily: Math.round(mean),
          percentageAboveAverage: Math.round((count / mean - 1) * 100)
        }
      });
    }
  });

  return anomalies;
}

/**
 * Detect category-based anomalies (unusual spending in specific categories)
 * @param {String} userId - User ID
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @param {Number} threshold - Sensitivity threshold
 * @returns {Promise<Array>} Category anomalies
 */
async function detectCategoryAnomalies(userId, startDate, endDate, threshold) {
  const normalizedUserId = normalizeUserId(userId);
  // Compare recent category spending with historical averages
  const recentStart = moment().subtract(7, 'days').startOf('day').toDate();
  const historicalStart = moment().subtract(90, 'days').startOf('day').toDate();
  const historicalEnd = moment().subtract(7, 'days').endOf('day').toDate();

  const [recentSpending, historicalSpending] = await Promise.all([
    Expense.aggregate([
      {
        $match: {
          userId: normalizedUserId,
          date: { $gte: recentStart, $lte: endDate }
        }
      },
      {
        $group: {
          _id: '$categoryId',
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      }
    ]),
    Expense.aggregate([
      {
        $match: {
          userId: normalizedUserId,
          date: { $gte: historicalStart, $lte: historicalEnd }
        }
      },
      {
        $group: {
          _id: '$categoryId',
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      }
    ])
  ]);

  const anomalies = [];
  const multiplier = (6 - threshold) / 2; // More lenient for category anomalies

  const historicalMap = {};
  historicalSpending.forEach(item => {
    const categoryId = item._id?.toString() || 'uncategorized';
    historicalMap[categoryId] = {
      weeklyAverage: item.total / 12, // 90 days / 7 days = ~12 weeks
      count: item.count
    };
  });

  for (const recent of recentSpending) {
    const categoryId = recent._id?.toString() || 'uncategorized';
    const historical = historicalMap[categoryId];

    if (historical && recent.total > historical.weeklyAverage * (1 + multiplier)) {
      const category = await require('../models/Category').findById(recent._id);
      const percentageIncrease = Math.round((recent.total / historical.weeklyAverage - 1) * 100);

      let severity = 'low';
      if (percentageIncrease > 200) severity = 'high';
      else if (percentageIncrease > 100) severity = 'medium';

      anomalies.push({
        type: 'category_spike',
        severity,
        date: new Date(),
        category: category?.name || 'Uncategorized',
        message: `${category?.name || 'Uncategorized'} spending ${percentageIncrease}% higher than usual this week`,
        details: {
          recentAmount: Math.round(recent.total),
          historicalAverage: Math.round(historical.weeklyAverage),
          percentageIncrease
        }
      });
    }
  }

  return anomalies;
}

/**
 * Detect time-based anomalies (unusual transaction times)
 * @param {String} userId - User ID
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Promise<Array>} Time anomalies
 */
async function detectTimeAnomalies(userId, startDate, endDate) {
  const expenses = await Expense.find({
    userId,
    date: { $gte: startDate, $lte: endDate }
  }).select('date amount description');

  const anomalies = [];

  // Detect late-night transactions (10 PM - 4 AM)
  expenses.forEach(expense => {
    const hour = moment(expense.date).hour();
    
    if ((hour >= 22 || hour < 4) && expense.amount > 5000) {
      anomalies.push({
        type: 'unusual_time',
        severity: 'low',
        date: expense.date,
        transactionId: expense._id,
        description: expense.description,
        amount: expense.amount,
        message: `Late-night transaction: ₦${expense.amount.toLocaleString()} at ${moment(expense.date).format('h:mm A')}`,
        details: {
          hour,
          time: moment(expense.date).format('h:mm A')
        }
      });
    }
  });

  return anomalies;
}

/**
 * Detect potential duplicate transactions
 * @param {String} userId - User ID
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Promise<Array>} Potential duplicates
 */
async function detectPotentialDuplicates(userId, startDate, endDate) {
  const expenses = await Expense.find({
    userId,
    date: { $gte: startDate, $lte: endDate }
  }).sort('date');

  const anomalies = [];
  const seen = new Map();

  expenses.forEach(expense => {
    // Create a key based on amount and rounded date (within same hour)
    const hourKey = moment(expense.date).format('YYYY-MM-DD-HH');
    const key = `${expense.amount}-${hourKey}`;

    if (seen.has(key)) {
      const duplicate = seen.get(key);
      
      anomalies.push({
        type: 'potential_duplicate',
        severity: 'medium',
        date: expense.date,
        transactionId: expense._id,
        description: expense.description,
        amount: expense.amount,
        message: `Potential duplicate transaction: ₦${expense.amount.toLocaleString()} on ${moment(expense.date).format('MMM D, h:mm A')}`,
        details: {
          originalTransactionId: duplicate._id,
          originalDate: duplicate.date,
          timeBetween: moment(expense.date).diff(moment(duplicate.date), 'minutes') + ' minutes'
        }
      });
    } else {
      seen.set(key, expense);
    }
  });

  return anomalies;
}

/**
 * Detect sudden income drops or spikes
 * @param {String} userId - User ID
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Promise<Array>} Income anomalies
 */
async function detectIncomeAnomalies(userId, startDate, endDate) {
  const normalizedUserId = normalizeUserId(userId);
  const monthlyIncome = await Income.aggregate([
    {
      $match: {
        userId: normalizedUserId,
        date: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: {
          year: { $year: '$date' },
          month: { $month: '$date' }
        },
        total: { $sum: '$amount' }
      }
    },
    {
      $sort: { '_id.year': 1, '_id.month': 1 }
    }
  ]);

  if (monthlyIncome.length < 2) {
    return [];
  }

  const anomalies = [];
  const amounts = monthlyIncome.map(m => m.total);
  const mean = amounts.reduce((sum, amt) => sum + amt, 0) / amounts.length;

  for (let i = 1; i < monthlyIncome.length; i++) {
    const current = monthlyIncome[i];
    const previous = monthlyIncome[i - 1];
    const percentageChange = ((current.total - previous.total) / previous.total) * 100;

    if (Math.abs(percentageChange) > 50) {
      const severity = Math.abs(percentageChange) > 75 ? 'high' : 'medium';
      
      anomalies.push({
        type: 'income_fluctuation',
        severity,
        date: new Date(current._id.year, current._id.month - 1),
        message: `Income ${percentageChange > 0 ? 'increased' : 'decreased'} by ${Math.abs(Math.round(percentageChange))}%`,
        details: {
          currentAmount: Math.round(current.total),
          previousAmount: Math.round(previous.total),
          percentageChange: Math.round(percentageChange),
          average: Math.round(mean)
        }
      });
    }
  }

  return anomalies;
}

/**
 * Generate recommendations based on detected anomalies
 * @param {Array} anomalies - Detected anomalies
 * @returns {Array} Recommendations
 */
function generateAnomalyRecommendations(anomalies) {
  const recommendations = [];

  const criticalCount = anomalies.filter(a => a.severity === 'critical').length;
  const duplicateCount = anomalies.filter(a => a.type === 'potential_duplicate').length;
  const unusualAmounts = anomalies.filter(a => a.type === 'unusual_amount');
  const categorySpikes = anomalies.filter(a => a.type === 'category_spike');

  if (criticalCount > 0) {
    recommendations.push({
      priority: 'high',
      message: `Review ${criticalCount} critical anomaly/anomalies for potential errors or fraud`,
      action: 'Review all critical transactions immediately'
    });
  }

  if (duplicateCount > 0) {
    recommendations.push({
      priority: 'medium',
      message: `Check ${duplicateCount} potential duplicate transaction(s)`,
      action: 'Review and delete duplicate entries if confirmed'
    });
  }

  if (unusualAmounts.length > 2) {
    recommendations.push({
      priority: 'medium',
      message: `You have ${unusualAmounts.length} unusually large transactions`,
      action: 'Verify these transactions are correct and categorized properly'
    });
  }

  if (categorySpikes.length > 0) {
    const topSpike = categorySpikes[0];
    recommendations.push({
      priority: 'low',
      message: `${topSpike.category} spending is significantly higher than usual`,
      action: `Review ${topSpike.category} expenses and consider setting a budget limit`
    });
  }

  if (anomalies.length === 0) {
    recommendations.push({
      priority: 'info',
      message: 'No significant anomalies detected',
      action: 'Your spending patterns look normal'
    });
  }

  return recommendations;
}

/**
 * Get anomaly summary for dashboard
 * @param {String} userId - User ID
 * @returns {Promise<Object>} Anomaly summary
 */
async function getAnomalySummary(userId) {
  const anomalies = await detectAnomalies(userId, { lookbackDays: 7, threshold: 3 });

  return {
    hasAnomalies: anomalies.anomalies.length > 0,
    criticalCount: anomalies.summary.critical,
    totalCount: anomalies.summary.totalAnomalies,
    topAnomaly: anomalies.anomalies.length > 0 ? anomalies.anomalies[0] : null
  };
}

module.exports = {
  detectAnomalies,
  detectAmountAnomalies,
  detectFrequencyAnomalies,
  detectCategoryAnomalies,
  detectTimeAnomalies,
  detectPotentialDuplicates,
  detectIncomeAnomalies,
  getAnomalySummary
};
