const Expense = require('../models/Expense');
const Income = require('../models/Income');
const Budget = require('../models/Budget');
const Category = require('../models/Category');
const Groq = require('groq-sdk');
const moment = require('moment');

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

/**
 * Budget Recommendation Engine
 * Generates intelligent budget recommendations using AI and spending analysis
 */

/**
 * Generate comprehensive budget recommendations
 * @param {String} userId - User ID
 * @param {Object} options - Recommendation options
 * @returns {Promise<Object>} Budget recommendations
 */
async function generateBudgetRecommendations(userId, options = {}) {
  const { months = 3 } = options;

  // Get financial data
  const [spendingAnalysis, incomeAnalysis, currentBudgets, categorySpending] = await Promise.all([
    analyzeSpendingHistory(userId, months),
    analyzeIncomeHistory(userId, months),
    getCurrentBudgets(userId),
    getCategorySpendingAverages(userId, months)
  ]);

  // Generate recommendations
  const recommendations = {
    overall: await generateOverallBudgetRecommendation(spendingAnalysis, incomeAnalysis),
    categories: await generateCategoryBudgetRecommendations(categorySpending, incomeAnalysis),
    adjustments: generateBudgetAdjustments(currentBudgets, categorySpending),
    savingsGoal: calculateRecommendedSavings(incomeAnalysis, spendingAnalysis),
    aiAdvice: await generateAIBudgetAdvice(spendingAnalysis, incomeAnalysis, categorySpending)
  };

  return recommendations;
}

/**
 * Analyze spending history
 * @param {String} userId - User ID
 * @param {Number} months - Number of months to analyze
 * @returns {Promise<Object>} Spending analysis
 */
async function analyzeSpendingHistory(userId, months) {
  const startDate = moment().subtract(months, 'months').startOf('month').toDate();
  const endDate = moment().endOf('day').toDate();

  const monthlySpending = await Expense.aggregate([
    {
      $match: {
        userId: userId,
        date: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: {
          year: { $year: '$date' },
          month: { $month: '$date' }
        },
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    },
    {
      $sort: { '_id.year': 1, '_id.month': 1 }
    }
  ]);

  const amounts = monthlySpending.map(m => m.total);
  const average = amounts.length > 0 ? amounts.reduce((sum, amt) => sum + amt, 0) / amounts.length : 0;
  const max = amounts.length > 0 ? Math.max(...amounts) : 0;
  const min = amounts.length > 0 ? Math.min(...amounts) : 0;

  // Calculate variance
  const variance = amounts.length > 0
    ? amounts.reduce((sum, amt) => sum + Math.pow(amt - average, 2), 0) / amounts.length
    : 0;
  const stdDev = Math.sqrt(variance);

  return {
    monthlyAverage: Math.round(average),
    monthlyMax: Math.round(max),
    monthlyMin: Math.round(min),
    standardDeviation: Math.round(stdDev),
    volatility: average > 0 ? (stdDev / average) * 100 : 0,
    trend: calculateTrend(amounts),
    monthlyData: monthlySpending
  };
}

/**
 * Analyze income history
 * @param {String} userId - User ID
 * @param {Number} months - Number of months to analyze
 * @returns {Promise<Object>} Income analysis
 */
async function analyzeIncomeHistory(userId, months) {
  const startDate = moment().subtract(months, 'months').startOf('month').toDate();
  const endDate = moment().endOf('day').toDate();

  const monthlyIncome = await Income.aggregate([
    {
      $match: {
        userId: userId,
        date: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: {
          year: { $year: '$date' },
          month: { $month: '$date' }
        },
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    },
    {
      $sort: { '_id.year': 1, '_id.month': 1 }
    }
  ]);

  const amounts = monthlyIncome.map(m => m.total);
  const average = amounts.length > 0 ? amounts.reduce((sum, amt) => sum + amt, 0) / amounts.length : 0;
  const min = amounts.length > 0 ? Math.min(...amounts) : 0;

  return {
    monthlyAverage: Math.round(average),
    monthlyMin: Math.round(min),
    trend: calculateTrend(amounts),
    isStable: calculateIncomeStability(amounts),
    monthlyData: monthlyIncome
  };
}

/**
 * Get current user budgets
 * @param {String} userId - User ID
 * @returns {Promise<Array>} Current budgets
 */
async function getCurrentBudgets(userId) {
  return await Budget.find({ userId, isActive: true })
    .populate('categoryId')
    .select('categoryId limit period spent');
}

/**
 * Get category spending averages
 * @param {String} userId - User ID
 * @param {Number} months - Number of months
 * @returns {Promise<Array>} Category averages
 */
async function getCategorySpendingAverages(userId, months) {
  const startDate = moment().subtract(months, 'months').startOf('month').toDate();
  const endDate = moment().endOf('day').toDate();

  const categoryData = await Expense.aggregate([
    {
      $match: {
        userId: userId,
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
        totalAmount: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    },
    {
      $sort: { totalAmount: -1 }
    }
  ]);

  return categoryData.map(cat => ({
    categoryId: cat._id,
    categoryName: cat.categoryName || 'Uncategorized',
    monthlyAverage: Math.round(cat.totalAmount / months),
    totalSpent: cat.totalAmount,
    transactionCount: cat.count
  }));
}

/**
 * Generate overall budget recommendation
 * @param {Object} spending - Spending analysis
 * @param {Object} income - Income analysis
 * @returns {Promise<Object>} Overall recommendation
 */
async function generateOverallBudgetRecommendation(spending, income) {
  const recommendedBudget = calculateRecommendedBudget(spending, income);
  const savingsRate = income.monthlyAverage > 0
    ? ((income.monthlyAverage - spending.monthlyAverage) / income.monthlyAverage) * 100
    : 0;

  let healthStatus = 'needs improvement';
  if (savingsRate >= 20) healthStatus = 'excellent';
  else if (savingsRate >= 10) healthStatus = 'good';
  else if (savingsRate >= 0) healthStatus = 'fair';

  return {
    recommendedMonthlyBudget: recommendedBudget,
    currentAverageSpending: spending.monthlyAverage,
    averageIncome: income.monthlyAverage,
    recommendedSavingsRate: 20, // Industry standard
    currentSavingsRate: Math.round(savingsRate),
    healthStatus,
    message: getBudgetHealthMessage(healthStatus, savingsRate)
  };
}

/**
 * Generate category-specific budget recommendations
 * @param {Array} categorySpending - Category spending data
 * @param {Object} income - Income analysis
 * @returns {Promise<Array>} Category recommendations
 */
async function generateCategoryBudgetRecommendations(categorySpending, income) {
  const totalSpending = categorySpending.reduce((sum, cat) => sum + cat.monthlyAverage, 0);

  // Recommended allocation percentages (50/30/20 rule variations)
  const recommendedAllocations = {
    'Food & Dining': 15,
    'Transportation': 10,
    'Rent': 30,
    'Housing & Rent': 30,
    'Utilities': 10,
    'Entertainment': 5,
    'Shopping': 10,
    'Healthcare': 5,
    'Education': 10,
    'Personal Care': 5,
    'Savings': 20,
    'Other': 10
  };

  return categorySpending.map(cat => {
    const recommendedPercentage = recommendedAllocations[cat.categoryName] || 10;
    const recommendedAmount = Math.round((income.monthlyAverage * recommendedPercentage) / 100);
    const currentPercentage = income.monthlyAverage > 0
      ? (cat.monthlyAverage / income.monthlyAverage) * 100
      : 0;

    let status = 'ok';
    if (currentPercentage > recommendedPercentage * 1.5) status = 'over';
    else if (currentPercentage < recommendedPercentage * 0.5) status = 'under';

    return {
      categoryId: cat.categoryId,
      categoryName: cat.categoryName,
      currentMonthlyAverage: cat.monthlyAverage,
      recommendedBudget: recommendedAmount,
      recommendedPercentage,
      currentPercentage: Math.round(currentPercentage),
      status,
      adjustment: recommendedAmount - cat.monthlyAverage,
      message: getCategoryRecommendationMessage(cat.categoryName, status, currentPercentage, recommendedPercentage)
    };
  });
}

/**
 * Generate budget adjustments for existing budgets
 * @param {Array} currentBudgets - Current user budgets
 * @param {Array} categorySpending - Category spending data
 * @returns {Array} Adjustment recommendations
 */
function generateBudgetAdjustments(currentBudgets, categorySpending) {
  const adjustments = [];

  currentBudgets.forEach(budget => {
    const categoryId = budget.categoryId?._id?.toString();
    const spending = categorySpending.find(cat => cat.categoryId?.toString() === categoryId);

    if (spending) {
      const utilizationRate = budget.limit > 0 ? (spending.monthlyAverage / budget.limit) * 100 : 0;

      let recommendation = 'maintain';
      let newLimit = budget.limit;
      let reason = 'Current budget is appropriate';

      if (utilizationRate > 90) {
        recommendation = 'increase';
        newLimit = Math.round(spending.monthlyAverage * 1.2); // 20% buffer
        reason = 'You consistently exceed or nearly reach this budget';
      } else if (utilizationRate < 50) {
        recommendation = 'decrease';
        newLimit = Math.round(spending.monthlyAverage * 1.3); // 30% buffer
        reason = 'You have significant unused budget in this category';
      }

      adjustments.push({
        categoryId: budget.categoryId._id,
        categoryName: budget.categoryId.name,
        currentLimit: budget.limit,
        currentSpending: spending.monthlyAverage,
        utilizationRate: Math.round(utilizationRate),
        recommendation,
        suggestedLimit: newLimit,
        reason
      });
    }
  });

  return adjustments;
}

/**
 * Calculate recommended savings amount
 * @param {Object} income - Income analysis
 * @param {Object} spending - Spending analysis
 * @returns {Object} Savings recommendation
 */
function calculateRecommendedSavings(income, spending) {
  const idealSavingsRate = 0.20; // 20% of income
  const aggressiveSavingsRate = 0.30; // 30% of income
  const conservativeSavingsRate = 0.10; // 10% of income

  const currentSavings = Math.max(0, income.monthlyAverage - spending.monthlyAverage);
  const idealSavings = income.monthlyAverage * idealSavingsRate;
  const aggressiveSavings = income.monthlyAverage * aggressiveSavingsRate;
  const conservativeSavings = income.monthlyAverage * conservativeSavingsRate;

  return {
    currentMonthlySavings: Math.round(currentSavings),
    recommended: Math.round(idealSavings),
    aggressive: Math.round(aggressiveSavings),
    conservative: Math.round(conservativeSavings),
    gap: Math.round(idealSavings - currentSavings),
    message: currentSavings >= idealSavings
      ? 'Great job! You\'re meeting the recommended savings rate.'
      : `Try to save an additional ₦${Math.round(idealSavings - currentSavings).toLocaleString()} per month to reach the 20% savings goal.`
  };
}

/**
 * Generate AI-powered budget advice
 * @param {Object} spending - Spending analysis
 * @param {Object} income - Income analysis
 * @param {Array} categorySpending - Category spending data
 * @returns {Promise<String>} AI advice
 */
async function generateAIBudgetAdvice(spending, income, categorySpending) {
  try {
    const topCategories = categorySpending.slice(0, 5).map(cat =>
      `${cat.categoryName}: ₦${cat.monthlyAverage.toLocaleString()}`
    ).join(', ');

    const savingsRate = income.monthlyAverage > 0
      ? ((income.monthlyAverage - spending.monthlyAverage) / income.monthlyAverage) * 100
      : 0;

    const prompt = `You are a Nigerian financial advisor. Provide practical budget advice based on this financial data:

Monthly Income: ₦${income.monthlyAverage.toLocaleString()}
Monthly Expenses: ₦${spending.monthlyAverage.toLocaleString()}
Savings Rate: ${Math.round(savingsRate)}%
Spending Volatility: ${spending.volatility.toFixed(0)}% (${spending.volatility > 30 ? 'high' : 'low'})

Top Spending Categories:
${topCategories}

Provide brief, actionable advice (3-4 sentences) on:
1. Budget allocation
2. Spending priorities
3. Savings strategy

Use simple words. Be encouraging and practical. Use Nigerian context (Naira, local expenses).`;

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are a practical Nigerian financial advisor. Give clear, actionable budget advice using simple language.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      model: GROQ_MODEL,
      temperature: 0.7,
      max_tokens: 200
    });

    return completion.choices[0]?.message?.content?.trim() || getFallbackBudgetAdvice(savingsRate);

  } catch (error) {
    console.error('AI Budget Advice Error:', error);
    return getFallbackBudgetAdvice(
      income.monthlyAverage > 0
        ? ((income.monthlyAverage - spending.monthlyAverage) / income.monthlyAverage) * 100
        : 0
    );
  }
}

/**
 * Calculate recommended budget based on spending patterns
 * @param {Object} spending - Spending analysis
 * @param {Object} income - Income analysis
 * @returns {Number} Recommended budget
 */
function calculateRecommendedBudget(spending, income) {
  // If income is stable, recommend 80% of average income
  // If income is volatile, use conservative 70%
  const percentage = income.isStable ? 0.80 : 0.70;
  
  // Also consider spending volatility
  const buffer = spending.volatility > 30 ? 1.1 : 1.0; // 10% buffer for volatile spending
  
  const baseRecommendation = income.monthlyAverage * percentage;
  const adjustedForVolatility = Math.min(baseRecommendation, spending.monthlyAverage * buffer);
  
  return Math.round(adjustedForVolatility);
}

/**
 * Calculate income stability
 * @param {Array} amounts - Monthly income amounts
 * @returns {Boolean} True if income is stable
 */
function calculateIncomeStability(amounts) {
  if (amounts.length < 2) return true;

  const average = amounts.reduce((sum, amt) => sum + amt, 0) / amounts.length;
  const variance = amounts.reduce((sum, amt) => sum + Math.pow(amt - average, 2), 0) / amounts.length;
  const coefficientOfVariation = average > 0 ? (Math.sqrt(variance) / average) : 0;

  // Income is stable if coefficient of variation is less than 15%
  return coefficientOfVariation < 0.15;
}

/**
 * Calculate trend from array of values
 * @param {Array} values - Array of numeric values
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
 * Get budget health message
 * @param {String} status - Health status
 * @param {Number} savingsRate - Current savings rate
 * @returns {String} Health message
 */
function getBudgetHealthMessage(status, savingsRate) {
  const messages = {
    'excellent': `Excellent financial health! You're saving ${Math.round(savingsRate)}% of your income.`,
    'good': `Good financial discipline. Keep up the savings momentum.`,
    'fair': `Room for improvement. Try to increase your savings rate to at least 10%.`,
    'needs improvement': `Consider reviewing your expenses to improve your savings rate.`
  };

  return messages[status] || 'Keep tracking your expenses to improve financial health.';
}

/**
 * Get category recommendation message
 * @param {String} categoryName - Category name
 * @param {String} status - Status (over/under/ok)
 * @param {Number} current - Current percentage
 * @param {Number} recommended - Recommended percentage
 * @returns {String} Recommendation message
 */
function getCategoryRecommendationMessage(categoryName, status, current, recommended) {
  if (status === 'over') {
    return `You're spending ${Math.round(current - recommended)}% more than recommended on ${categoryName}. Consider reducing expenses in this category.`;
  } else if (status === 'under') {
    return `Your ${categoryName} spending is below typical levels. This is good if intentional.`;
  }
  return `Your ${categoryName} budget is well-balanced.`;
}

/**
 * Get fallback budget advice when AI is unavailable
 * @param {Number} savingsRate - Current savings rate
 * @returns {String} Fallback advice
 */
function getFallbackBudgetAdvice(savingsRate) {
  if (savingsRate >= 20) {
    return "Great job on your savings! Consider investing excess funds for long-term growth. Keep tracking your expenses to maintain this healthy financial position.";
  } else if (savingsRate >= 10) {
    return "You're saving a decent amount. Try to increase your savings rate to 20% by reviewing your discretionary spending. Focus on your top 3 expense categories.";
  } else if (savingsRate >= 0) {
    return "Your savings rate could be improved. Review your spending categories and identify areas to cut back. Start with small changes like reducing entertainment or food expenses.";
  } else {
    return "You're spending more than you earn. This is unsustainable. Immediately review all expenses and cut non-essential items. Consider finding additional income sources.";
  }
}

module.exports = {
  generateBudgetRecommendations,
  generateOverallBudgetRecommendation,
  generateCategoryBudgetRecommendations,
  generateBudgetAdjustments,
  calculateRecommendedSavings,
  generateAIBudgetAdvice
};
