const Expense = require('../models/Expense');
const Income = require('../models/Income');
const Category = require('../models/Category');
const Groq = require('groq-sdk');
const moment = require('moment');

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

/**
 * Savings Suggestion Service
 * Provides personalized savings opportunities and recommendations
 */

/**
 * Generate comprehensive savings suggestions
 * @param {String} userId - User ID
 * @param {Object} options - Suggestion options
 * @returns {Promise<Object>} Savings suggestions
 */
async function generateSavingsSuggestions(userId, options = {}) {
  const { months = 3 } = options;

  const [
    categoryOpportunities,
    subscriptionSavings,
    habitualSpendingSavings,
    frequencySavings,
    substituteOpportunities,
    totalPotentialSavings
  ] = await Promise.all([
    findCategorySavingsOpportunities(userId, months),
    identifySubscriptionOptimization(userId, months),
    analyzeHabitualSpending(userId, months),
    findFrequencyReductionOpportunities(userId, months),
    suggestCostEffectiveSubstitutes(userId, months),
    calculateTotalSavingsPotential(userId, months)
  ]);

  const aiSavingsAdvice = await generateAISavingsAdvice(
    categoryOpportunities,
    totalPotentialSavings
  );

  return {
    summary: {
      totalMonthlyPotential: totalPotentialSavings,
      totalAnnualPotential: totalPotentialSavings * 12,
      opportunityCount: categoryOpportunities.length + subscriptionSavings.length + habitualSpendingSavings.length
    },
    opportunities: {
      categories: categoryOpportunities,
      subscriptions: subscriptionSavings,
      habits: habitualSpendingSavings,
      frequency: frequencySavings,
      substitutes: substituteOpportunities
    },
    aiAdvice: aiSavingsAdvice,
    quickWins: identifyQuickWins([
      ...categoryOpportunities,
      ...subscriptionSavings,
      ...habitualSpendingSavings
    ])
  };
}

/**
 * Find savings opportunities by category
 * @param {String} userId - User ID
 * @param {Number} months - Number of months to analyze
 * @returns {Promise<Array>} Category savings opportunities
 */
async function findCategorySavingsOpportunities(userId, months) {
  const startDate = moment().subtract(months, 'months').startOf('month').toDate();
  const endDate = moment().endOf('day').toDate();

  const categorySpending = await Expense.aggregate([
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

  const opportunities = [];

  // Suggested reduction percentages by category
  const savingsTargets = {
    'Food & Dining': { target: 20, difficulty: 'easy', tips: ['Cook at home more often', 'Pack lunch for work', 'Reduce restaurant visits'] },
    'Entertainment': { target: 30, difficulty: 'easy', tips: ['Find free activities', 'Use streaming instead of cinema', 'Limit outings'] },
    'Shopping': { target: 25, difficulty: 'medium', tips: ['Make shopping lists', 'Wait 24hrs before impulse buys', 'Buy on sale'] },
    'Transportation': { target: 15, difficulty: 'medium', tips: ['Use public transport', 'Carpool when possible', 'Combine errands'] },
    'Utilities': { target: 10, difficulty: 'hard', tips: ['Turn off unused lights', 'Use energy-efficient appliances', 'Monitor usage'] },
    'Personal Care': { target: 20, difficulty: 'easy', tips: ['DIY beauty treatments', 'Extend time between appointments', 'Find affordable alternatives'] }
  };

  categorySpending.forEach(cat => {
    const categoryName = cat.categoryName || 'Other';
    const target = savingsTargets[categoryName];

    if (target && cat.totalAmount > 0) {
      const monthlyAverage = cat.totalAmount / months;
      const potentialSavings = (monthlyAverage * target.target) / 100;

      if (potentialSavings >= 1000) { // Only suggest if potential savings >= ₦1000/month
        opportunities.push({
          category: categoryName,
          currentMonthlySpending: Math.round(monthlyAverage),
          suggestedReduction: target.target,
          potentialMonthlySavings: Math.round(potentialSavings),
          potentialAnnualSavings: Math.round(potentialSavings * 12),
          difficulty: target.difficulty,
          tips: target.tips,
          priority: calculatePriority(potentialSavings, target.difficulty)
        });
      }
    }
  });

  return opportunities.sort((a, b) => b.priority - a.priority);
}

/**
 * Identify subscription optimization opportunities
 * @param {String} userId - User ID
 * @param {Number} months - Number of months to analyze
 * @returns {Promise<Array>} Subscription savings
 */
async function identifySubscriptionOptimization(userId, months) {
  const startDate = moment().subtract(months, 'months').startOf('month').toDate();
  const endDate = moment().endOf('day').toDate();

  // Find recurring transactions (same amount, regular intervals)
  const expenses = await Expense.find({
    userId,
    date: { $gte: startDate, $lte: endDate }
  }).select('description amount date').sort('date');

  const recurringTransactions = new Map();

  expenses.forEach(expense => {
    const amountKey = Math.round(expense.amount);
    const descKey = expense.description.toLowerCase().substring(0, 20);
    const key = `${amountKey}-${descKey}`;

    if (!recurringTransactions.has(key)) {
      recurringTransactions.set(key, []);
    }
    recurringTransactions.get(key).push(expense);
  });

  const subscriptions = [];

  recurringTransactions.forEach((transactions, key) => {
    if (transactions.length >= 2) {
      // Check if transactions are roughly monthly
      const daysBetween = [];
      for (let i = 1; i < transactions.length; i++) {
        const days = moment(transactions[i].date).diff(moment(transactions[i - 1].date), 'days');
        daysBetween.push(days);
      }

      const avgDays = daysBetween.reduce((sum, days) => sum + days, 0) / daysBetween.length;

      // Consider it a subscription if average is between 28-35 days (monthly)
      if (avgDays >= 25 && avgDays <= 35) {
        const monthlyAmount = transactions[0].amount;
        
        subscriptions.push({
          description: transactions[0].description,
          monthlyAmount: Math.round(monthlyAmount),
          frequency: transactions.length,
          lastCharge: transactions[transactions.length - 1].date,
          suggestion: 'Review if still needed',
          potentialMonthlySavings: Math.round(monthlyAmount),
          tips: [
            'Check if you\'re still using this service',
            'Look for cheaper alternatives',
            'Consider annual plans for discounts'
          ]
        });
      }
    }
  });

  return subscriptions.sort((a, b) => b.monthlyAmount - a.monthlyAmount);
}

/**
 * Analyze habitual spending patterns
 * @param {String} userId - User ID
 * @param {Number} months - Number of months to analyze
 * @returns {Promise<Array>} Habitual spending opportunities
 */
async function analyzeHabitualSpending(userId, months) {
  const startDate = moment().subtract(months, 'months').startOf('month').toDate();
  const endDate = moment().endOf('day').toDate();

  const expenses = await Expense.find({
    userId,
    date: { $gte: startDate, $lte: endDate }
  }).populate('categoryId').select('description amount date categoryId');

  // Analyze by time patterns (e.g., daily coffee, weekly entertainment)
  const habits = [];

  // Daily habits (5+ times per week)
  const dailyExpenses = findFrequentExpenses(expenses, 'daily');
  dailyExpenses.forEach(habit => {
    if (habit.weeklyAverage >= 500) { // Significant weekly spending
      habits.push({
        type: 'daily',
        description: habit.description,
        category: habit.category,
        weeklyAverage: Math.round(habit.weeklyAverage),
        monthlyAverage: Math.round(habit.monthlyAverage),
        frequency: habit.frequency,
        suggestion: getHabitReductionSuggestion('daily', habit.category),
        potentialMonthlySavings: Math.round(habit.monthlyAverage * 0.3), // 30% reduction
        difficulty: 'medium'
      });
    }
  });

  // Weekly habits
  const weeklyExpenses = findFrequentExpenses(expenses, 'weekly');
  weeklyExpenses.forEach(habit => {
    if (habit.monthlyAverage >= 2000) {
      habits.push({
        type: 'weekly',
        description: habit.description,
        category: habit.category,
        monthlyAverage: Math.round(habit.monthlyAverage),
        frequency: habit.frequency,
        suggestion: getHabitReductionSuggestion('weekly', habit.category),
        potentialMonthlySavings: Math.round(habit.monthlyAverage * 0.25), // 25% reduction
        difficulty: 'easy'
      });
    }
  });

  return habits;
}

/**
 * Find frequency reduction opportunities
 * @param {String} userId - User ID
 * @param {Number} months - Number of months to analyze
 * @returns {Promise<Array>} Frequency reduction suggestions
 */
async function findFrequencyReductionOpportunities(userId, months) {
  const startDate = moment().subtract(months, 'months').startOf('month').toDate();
  const endDate = moment().endOf('day').toDate();

  const categoryFrequency = await Expense.aggregate([
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
        count: { $sum: 1 },
        avgAmount: { $avg: '$amount' }
      }
    }
  ]);

  const opportunities = [];
  const totalDays = months * 30;

  categoryFrequency.forEach(cat => {
    const categoryName = cat.categoryName || 'Other';
    const transactionsPerWeek = (cat.count / totalDays) * 7;

    if (transactionsPerWeek > 3 && ['Food & Dining', 'Entertainment', 'Shopping'].includes(categoryName)) {
      const currentMonthly = cat.totalAmount / months;
      const targetFrequency = Math.max(1, Math.floor(transactionsPerWeek * 0.7)); // Reduce by 30%
      const potentialSavings = (currentMonthly * 0.3);

      opportunities.push({
        category: categoryName,
        currentWeeklyFrequency: Math.round(transactionsPerWeek * 10) / 10,
        suggestedWeeklyFrequency: targetFrequency,
        currentMonthlySpending: Math.round(currentMonthly),
        potentialMonthlySavings: Math.round(potentialSavings),
        suggestion: `Reduce ${categoryName} spending from ${Math.round(transactionsPerWeek)} to ${targetFrequency} times per week`,
        tips: getFrequencyReductionTips(categoryName)
      });
    }
  });

  return opportunities;
}

/**
 * Suggest cost-effective substitutes
 * @param {String} userId - User ID
 * @param {Number} months - Number of months to analyze
 * @returns {Promise<Array>} Substitute suggestions
 */
async function suggestCostEffectiveSubstitutes(userId, months) {
  const startDate = moment().subtract(months, 'months').startOf('month').toDate();
  const endDate = moment().endOf('day').toDate();

  const expenses = await Expense.find({
    userId,
    date: { $gte: startDate, $lte: endDate }
  }).populate('categoryId');

  const substitutes = [];

  // Analyze expensive brands or services
  const foodExpenses = expenses.filter(e => e.categoryId?.name === 'Food & Dining' && e.amount > 3000);
  if (foodExpenses.length > 0) {
    const avgExpensive = foodExpenses.reduce((sum, e) => sum + e.amount, 0) / foodExpenses.length;
    substitutes.push({
      category: 'Food & Dining',
      currentChoice: 'Restaurant dining',
      substitute: 'Home cooking or meal prep',
      currentAverage: Math.round(avgExpensive),
      substituteEstimate: Math.round(avgExpensive * 0.4), // 60% savings
      potentialMonthlySavings: Math.round((avgExpensive - avgExpensive * 0.4) * (foodExpenses.length / months)),
      difficulty: 'medium'
    });
  }

  // Transport substitutes
  const transportExpenses = expenses.filter(e => e.categoryId?.name === 'Transportation');
  if (transportExpenses.length > 10) {
    const monthlyTransport = transportExpenses.reduce((sum, e) => sum + e.amount, 0) / months;
    if (monthlyTransport > 15000) {
      substitutes.push({
        category: 'Transportation',
        currentChoice: 'Ride-hailing services',
        substitute: 'Public transport + occasional rides',
        currentAverage: Math.round(monthlyTransport),
        substituteEstimate: Math.round(monthlyTransport * 0.5),
        potentialMonthlySavings: Math.round(monthlyTransport * 0.5),
        difficulty: 'easy'
      });
    }
  }

  return substitutes;
}

/**
 * Calculate total savings potential
 * @param {String} userId - User ID
 * @param {Number} months - Number of months to analyze
 * @returns {Promise<Number>} Total potential monthly savings
 */
async function calculateTotalSavingsPotential(userId, months) {
  const [categoryOpp, subscriptions, habits] = await Promise.all([
    findCategorySavingsOpportunities(userId, months),
    identifySubscriptionOptimization(userId, months),
    analyzeHabitualSpending(userId, months)
  ]);

  const categoryTotal = categoryOpp.reduce((sum, opp) => sum + opp.potentialMonthlySavings, 0);
  const subscriptionTotal = subscriptions.reduce((sum, sub) => sum + sub.potentialMonthlySavings, 0);
  const habitTotal = habits.reduce((sum, habit) => sum + habit.potentialMonthlySavings, 0);

  return Math.round(categoryTotal + subscriptionTotal + habitTotal);
}

/**
 * Generate AI-powered savings advice
 * @param {Array} opportunities - Savings opportunities
 * @param {Number} totalPotential - Total potential savings
 * @returns {Promise<String>} AI advice
 */
async function generateAISavingsAdvice(opportunities, totalPotential) {
  try {
    const topOpportunities = opportunities.slice(0, 3).map(opp =>
      `${opp.category}: Save ₦${opp.potentialMonthlySavings.toLocaleString()}/month by reducing ${opp.suggestedReduction}%`
    ).join(', ');

    const prompt = `You are a Nigerian financial advisor. Help a user save money based on their spending patterns.

Total Potential Savings: ₦${totalPotential.toLocaleString()}/month (₦${(totalPotential * 12).toLocaleString()}/year)

Top Savings Opportunities:
${topOpportunities || 'General spending reduction'}

Provide practical, actionable advice (3-4 sentences) on:
1. Which savings to prioritize
2. How to implement changes gradually
3. Motivation to stay consistent

Use simple words. Be encouraging. Use Nigerian context.`;

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are a practical Nigerian financial advisor. Give clear, actionable savings advice using simple language.'
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

    return completion.choices[0]?.message?.content?.trim() || getFallbackSavingsAdvice(totalPotential);

  } catch (error) {
    console.error('AI Savings Advice Error:', error);
    return getFallbackSavingsAdvice(totalPotential);
  }
}

/**
 * Find frequent expenses
 * @param {Array} expenses - All expenses
 * @param {String} frequency - 'daily' or 'weekly'
 * @returns {Array} Frequent expenses
 */
function findFrequentExpenses(expenses, frequency) {
  const grouped = {};

  expenses.forEach(expense => {
    const key = expense.description.toLowerCase().substring(0, 15);
    if (!grouped[key]) {
      grouped[key] = {
        description: expense.description,
        category: expense.categoryId?.name || 'Other',
        amounts: [],
        dates: []
      };
    }
    grouped[key].amounts.push(expense.amount);
    grouped[key].dates.push(expense.date);
  });

  const frequent = [];
  const minOccurrences = frequency === 'daily' ? 10 : 4;

  Object.values(grouped).forEach(group => {
    if (group.amounts.length >= minOccurrences) {
      const totalAmount = group.amounts.reduce((sum, amt) => sum + amt, 0);
      const avgAmount = totalAmount / group.amounts.length;
      
      const totalDays = moment(group.dates[group.dates.length - 1]).diff(moment(group.dates[0]), 'days') || 1;
      const totalWeeks = Math.max(1, Math.round(totalDays / 7));

      frequent.push({
        description: group.description,
        category: group.category,
        frequency: group.amounts.length,
        weeklyAverage: (totalAmount / totalWeeks),
        monthlyAverage: (totalAmount / totalWeeks) * 4.33 // average weeks per month
      });
    }
  });

  return frequent;
}

/**
 * Get habit reduction suggestion
 * @param {String} type - Habit type
 * @param {String} category - Category name
 * @returns {String} Suggestion
 */
function getHabitReductionSuggestion(type, category) {
  const suggestions = {
    'daily-Food & Dining': 'Prepare lunch at home 3 days a week instead of buying daily',
    'daily-Shopping': 'Create a shopping list and stick to it, buy once a week',
    'weekly-Entertainment': 'Alternate between paid and free activities',
    'weekly-Food & Dining': 'Reduce eating out to once a week'
  };

  return suggestions[`${type}-${category}`] || `Reduce frequency by 30%`;
}

/**
 * Get frequency reduction tips
 * @param {String} category - Category name
 * @returns {Array} Tips
 */
function getFrequencyReductionTips(category) {
  const tips = {
    'Food & Dining': ['Meal prep on Sundays', 'Pack lunch for work', 'Cook larger portions'],
    'Entertainment': ['Find free events', 'Host movie nights at home', 'Use free trials'],
    'Shopping': ['Wait 24 hours before buying', 'Use shopping lists', 'Buy in bulk']
  };

  return tips[category] || ['Plan ahead', 'Track before you spend', 'Set limits'];
}

/**
 * Calculate priority score
 * @param {Number} savings - Potential savings
 * @param {String} difficulty - Difficulty level
 * @returns {Number} Priority score
 */
function calculatePriority(savings, difficulty) {
  const difficultyMultiplier = {
    'easy': 1.5,
    'medium': 1.0,
    'hard': 0.5
  };

  return savings * (difficultyMultiplier[difficulty] || 1.0);
}

/**
 * Identify quick wins (easy, high-impact savings)
 * @param {Array} allOpportunities - All opportunities
 * @returns {Array} Quick wins
 */
function identifyQuickWins(allOpportunities) {
  return allOpportunities
    .filter(opp => 
      (opp.difficulty === 'easy' || opp.difficulty === 'medium') &&
      (opp.potentialMonthlySavings || opp.monthlyAmount) >= 2000
    )
    .slice(0, 3)
    .map(opp => ({
      title: opp.category || opp.description,
      action: opp.suggestion || opp.tips[0],
      potentialSavings: opp.potentialMonthlySavings || opp.monthlyAmount,
      difficulty: opp.difficulty
    }));
}

/**
 * Get fallback savings advice
 * @param {Number} totalPotential - Total potential savings
 * @returns {String} Fallback advice
 */
function getFallbackSavingsAdvice(totalPotential) {
  if (totalPotential >= 50000) {
    return "You have significant savings potential! Start with your top spending categories. Even small changes can add up to huge savings over time. Focus on reducing discretionary spending first.";
  } else if (totalPotential >= 20000) {
    return "You can save a decent amount by making smart choices. Review your food and entertainment spending first - these are often easiest to reduce. Set a monthly savings goal and track your progress.";
  } else if (totalPotential >= 5000) {
    return "Small savings add up over time. Start with easy wins like reducing eating out or finding cheaper alternatives. Every naira saved is a step toward financial freedom.";
  } else {
    return "Your spending is already quite efficient! Focus on increasing income or investing your current savings for growth. Keep tracking to maintain this discipline.";
  }
}

module.exports = {
  generateSavingsSuggestions,
  findCategorySavingsOpportunities,
  identifySubscriptionOptimization,
  analyzeHabitualSpending,
  calculateTotalSavingsPotential,
  generateAISavingsAdvice
};
