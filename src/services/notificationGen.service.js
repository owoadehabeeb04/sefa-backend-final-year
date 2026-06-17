const { completeText } = require('./llm/azureOpenAI.service');
const { buildNotificationAdvicePrompts } = require('./prompts/financePrompts');

/**
 * Notification Generation Service (Azure OpenAI)
 * Generates AI-powered financial advice for notifications
 */

/**
 * Generate AI advice for transaction alert
 * @param {Object} transaction - Transaction data
 * @param {Object} context - User spending context
 * @returns {Promise<string>} AI-generated advice
 */
const generateTransactionAdvice = async (transaction, context = {}) => {
  const { amount, description, category, type } = transaction;
  const {
    monthlySpending,
    monthlyIncome,
    categorySpending,
    budgetLimit,
    categoryBudgetLimit,
    categoryBudgetSpent,
    categoryBudgetRemaining,
    categoryBudgetPercentage,
    categoryBudgetStatus,
    totalMonthlyBudgetLimit,
    totalMonthlyBudgetSpent,
    totalMonthlyBudgetRemaining,
    totalMonthlyBudgetPercentage,
    totalMonthlyBudgetStatus
  } = context;
  
  const prompt = `You are a Nigerian financial advisor. A user just made a ${type} transaction.

Transaction:
- Amount: ₦${amount.toLocaleString()}
- Description: ${description}
- Category: ${category || 'Uncategorized'}

Context:
- Monthly spending so far: ₦${monthlySpending?.toLocaleString() || 'N/A'}
- Monthly income so far: ₦${monthlyIncome?.toLocaleString() || 'N/A'}
- Spending in this category: ₦${categorySpending?.toLocaleString() || 'N/A'}
- Monthly budget limit: ₦${budgetLimit?.toLocaleString() || 'N/A'}
- Category budget limit: ₦${categoryBudgetLimit?.toLocaleString() || 'N/A'}
- Category budget spent: ₦${categoryBudgetSpent?.toLocaleString() || 'N/A'}
- Category budget remaining: ₦${categoryBudgetRemaining?.toLocaleString() || 'N/A'}
- Category budget usage: ${categoryBudgetPercentage ?? 'N/A'}%
- Category budget status from DB: ${categoryBudgetStatus || 'no_budget'}
- Total monthly budget limit: ₦${totalMonthlyBudgetLimit?.toLocaleString() || 'N/A'}
- Total monthly budget spent: ₦${totalMonthlyBudgetSpent?.toLocaleString() || 'N/A'}
- Total monthly budget remaining: ₦${totalMonthlyBudgetRemaining?.toLocaleString() || 'N/A'}
- Total monthly budget usage: ${totalMonthlyBudgetPercentage ?? 'N/A'}%
- Total monthly budget status from DB: ${totalMonthlyBudgetStatus || 'no_budget'}

Rules:
- Use ONLY the DB context values above.
- If status is "ok" or "no_budget", do NOT claim the user exceeded budget.
- If status is "warning", advise caution and what to cut back on.
- If status is "exceeded", clearly state by how much based on provided numbers.
- Keep advice specific to this transaction and current month.

Provide a brief, practical financial tip (max 2 sentences) in Nigerian English. Be friendly and encouraging.`;

  return await callAzureNotificationAI('transaction_alert', { prompt, transaction, context }, { maxTokens: 100 });
};

/**
 * Generate AI advice for budget warning
 * @param {Object} budget - Budget data
 * @param {Object} spending - Spending data
 * @returns {Promise<string>} AI-generated advice
 */
const generateBudgetWarningAdvice = async (payload, context = {}) => {
  const budgetData = payload?.budget || payload || {};
  const verified = context?.verifiedBudget || {};

  const category = verified.category || budgetData.category || payload?.category || 'General';
  const limit = verified.limit ?? budgetData.limit ?? budgetData.amount ?? payload?.limit ?? 0;
  const spent = verified.spent ?? budgetData.spent ?? budgetData.amount ?? payload?.spent ?? 0;
  const percentage = verified.percentage ?? budgetData.percentage ?? payload?.percentage ?? 0;
  const remaining = verified.remaining ?? budgetData.remaining ?? payload?.remaining ?? Math.max(Number(limit || 0) - Number(spent || 0), 0);
  const overspent = verified.overspent ?? budgetData.overspent ?? payload?.overspent ?? Math.max(Number(spent || 0) - Number(limit || 0), 0);
  const status = verified.status || (Number(percentage) >= 100 ? 'exceeded' : Number(percentage) >= 80 ? 'warning' : 'ok');
  const period = budgetData.period || payload?.period || 'monthly';
  
  const prompt = `You are a Nigerian financial advisor. A user is approaching their budget limit.

Budget:
- Category: ${category}
- Limit: ₦${limit.toLocaleString()} (${period})
- Current spending from DB: ₦${spent.toLocaleString()} (${percentage}%)
- Remaining budget from DB: ₦${remaining.toLocaleString()}
- Overspent from DB: ₦${overspent.toLocaleString()}
- Budget status from DB: ${status}

Rules:
- Base advice ONLY on these DB values.
- If status is "warning", focus on preventing overspending this month.
- If status is "exceeded", include a realistic recovery action for the rest of the month.
- Do not say "exceeded" when status is not exceeded.

Provide practical advice to help them stay within budget (max 2 sentences). Be constructive, not judgmental.`;

  return await callAzureNotificationAI('budget_warning', { prompt, payload, context }, { maxTokens: 100 });
};

/**
 * Generate AI advice for weekly summary
 * @param {Object} summary - Weekly spending summary
 * @returns {Promise<string>} AI-generated advice
 */
const generateWeeklySummaryAdvice = async (summary) => {
  const { totalExpenses, totalIncome, topCategories, comparisonToLastWeek } = summary;
  
  const prompt = `You are a Nigerian financial advisor. Generate a weekly financial summary for a user.

This Week:
- Total expenses: ₦${totalExpenses.toLocaleString()}
- Total income: ₦${totalIncome.toLocaleString()}
- Net: ₦${(totalIncome - totalExpenses).toLocaleString()}
- Top spending categories: ${topCategories.map(c => `${c.name} (₦${c.amount.toLocaleString()})`).join(', ')}
- Compared to last week: ${comparisonToLastWeek}

Provide encouraging insights and actionable advice (max 3 sentences). Use Nigerian context.`;

  return await callAzureNotificationAI('weekly_summary', { prompt, summary }, { maxTokens: 150 });
};

/**
 * Generate AI advice for spending insight
 * @param {Object} insight - Spending insight data
 * @returns {Promise<string>} AI-generated advice
 */
const generateSpendingInsightAdvice = async (insight) => {
  const { pattern, category, amount, suggestion } = insight;
  
  const prompt = `You are a Nigerian financial advisor. Provide personalized advice based on a spending pattern.

Insight:
- Pattern: ${pattern}
- Category: ${category}
- Amount: ₦${amount.toLocaleString()}
- Observation: ${suggestion}

Give practical, culturally relevant advice (max 2 sentences). Be motivating.`;

  return await callAzureNotificationAI('spending_insight', { prompt, insight }, { maxTokens: 100 });
};

/**
 * Calculate risk score for notification
 * @param {string} type - Notification type
 * @param {Object} data - Notification data
 * @returns {number} Risk score (0-100)
 */
const calculateRiskScore = (type, data) => {
  switch (type) {
    case 'budget_warning':
      // Based on budget percentage
      return Math.min(data.percentage || 0, 100);
      
    case 'transaction_alert':
      // Based on transaction size relative to monthly average
      if (data.monthlyAverage && data.amount) {
        const ratio = (data.amount / data.monthlyAverage) * 100;
        return Math.min(ratio, 100);
      }
      return 30; // Default moderate risk
      
    case 'spending_insight':
      // Based on overspending severity
      if (data.overspendingPercentage) {
        return Math.min(data.overspendingPercentage, 100);
      }
      return 50;
      
    case 'goal_progress':
      // Inverse of progress (low progress = high risk)
      if (data.progressPercentage !== undefined) {
        return 100 - Math.min(data.progressPercentage, 100);
      }
      return 40;
      
    default:
      return 0; // No risk for informational notifications
  }
};

/**
 * Call Azure OpenAI
 * @param {string} prompt - Prompt text
 * @param {Object} options - API options
 * @returns {Promise<string>} AI response
 */
const callAzureNotificationAI = async (purpose, payload, options = {}) => {
  try {
    const promptConfig = buildNotificationAdvicePrompts({ purpose, payload });
    const response = await completeText({
      feature: `notification-${purpose}`,
      ...promptConfig,
      maxTokens: options.maxTokens || 100,
      temperature: 0.45,
    });

    const advice = response?.text?.trim();
    if (!advice) {
      throw new Error('Empty response from Azure OpenAI');
    }

    return advice;
  } catch (error) {
    console.error('❌ Azure OpenAI notification error:', error.message);
    return getFallbackAdvice();
  }
};

/**
 * Get fallback advice when AI is unavailable
 * @returns {string} Generic advice
 */
const getFallbackAdvice = () => {
  const fallbacks = [
    "Keep track of your spending to stay within budget.",
    "Small savings today can lead to big achievements tomorrow.",
    "Review your expenses regularly to identify areas for improvement.",
    "Set realistic financial goals and work towards them consistently.",
    "Consider creating a budget category for unexpected expenses."
  ];
  
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
};

/**
 * Generate notification title based on type
 * @param {string} type - Notification type
 * @param {Object} data - Notification data
 * @returns {string} Notification title
 */
const generateNotificationTitle = (type, data) => {
  switch (type) {
    case 'transaction_alert':
      return `New ${data.transactionType === 'expense' ? 'Expense' : 'Income'}: ₦${data.amount?.toLocaleString()}`;
      
    case 'budget_warning':
      return `Budget Alert: ${data.category} at ${data.percentage}%`;
      
    case 'weekly_summary':
      return 'Your Weekly Financial Summary';
      
    case 'spending_insight':
      return 'Spending Insight';
      
    case 'goal_progress':
      return `Goal Update: ${data.goalName}`;
      
    case 'import_complete':
      return 'Bank Import Complete';

    case 'import_ready':
      return 'Statement ready for review';

    default:
      return 'Financial Update';
  }
};

/**
 * Generate notification body based on type
 * @param {string} type - Notification type
 * @param {Object} data - Notification data
 * @returns {string} Notification body
 */
const generateNotificationBody = (type, data) => {
  switch (type) {
    case 'transaction_alert':
      return data.description || 'New transaction recorded';
      
    case 'budget_warning':
      return `You've used ₦${data.spent?.toLocaleString()} of ₦${data.limit?.toLocaleString()}`;
      
    case 'weekly_summary':
      return `Expenses: ₦${data.expenses?.toLocaleString()}, Income: ₦${data.income?.toLocaleString()}`;
      
    case 'spending_insight':
      return data.insight || 'Review your spending patterns';
      
    case 'goal_progress':
      return `${data.progressPercentage}% complete`;
      
    case 'import_complete':
      return `Imported ${data.importedRows ?? data.importedCount ?? 0} transactions from ${data.source || data.fileName || 'your statement'}`;

    case 'import_ready':
      return `We found ${data.totalRows} transaction${data.totalRows === 1 ? '' : 's'} in ${data.fileName || 'your statement'}. Tap to review and import.`;

    default:
      return 'Check your SEFA app for details';
  }
};

module.exports = {
  generateTransactionAdvice,
  generateBudgetWarningAdvice,
  generateWeeklySummaryAdvice,
  generateSpendingInsightAdvice,
  calculateRiskScore,
  generateNotificationTitle,
  generateNotificationBody,
  getFallbackAdvice
};
