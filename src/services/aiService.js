const {
  completeJson,
  completeText,
  isConfigured: isAzureOpenAIConfigured,
} = require('./llm/azureOpenAI.service');
const {
  buildDetailedInsightPrompts,
  buildShortInsightPrompts,
  buildStatementStructurePrompts,
} = require('./prompts/financePrompts');

/**
 * Generate a financial insight using Azure OpenAI
 * @param {Object} userData - User's financial data
 * @param {Number} userData.totalIncome - Total income for the period
 * @param {Number} userData.totalExpenses - Total expenses for the period
 * @param {Number} userData.balance - Remaining balance
 * @param {Array} userData.topCategories - Top spending categories with amounts
 * @param {Number} userData.lastPeriodExpenses - Expenses from previous period
 * @param {Number} userData.lastPeriodIncome - Income from previous period
 * @param {String} userData.period - Current period (e.g., "this month", "this week")
 * @returns {Promise<String>} A concise financial insight
 */
async function generateFinancialInsight(userData) {
  try {
    if (process.env.NODE_ENV === 'test') {
      return getFallbackInsight(userData);
    }

    const {
      totalIncome = 0,
      totalExpenses = 0,
      balance = 0,
      topCategories = [],
      lastPeriodExpenses = 0,
      lastPeriodIncome = 0,
      period = 'this month'
    } = userData;

    // Calculate percentage changes
    const expenseChange = lastPeriodExpenses > 0 
      ? ((totalExpenses - lastPeriodExpenses) / lastPeriodExpenses * 100).toFixed(0)
      : 0;
    
    const incomeChange = lastPeriodIncome > 0
      ? ((totalIncome - lastPeriodIncome) / lastPeriodIncome * 100).toFixed(0)
      : 0;

    // Calculate budget status
    const spendingRate = totalIncome > 0 ? (totalExpenses / totalIncome * 100).toFixed(0) : 0;

    // Format top categories for prompt
    const categorySummary = topCategories
      .slice(0, 3)
      .map(cat => `${cat.name}: ₦${cat.total.toLocaleString()}`)
      .join(', ');

    const promptConfig = buildShortInsightPrompts({
      totalIncome,
      totalExpenses,
      balance,
      topCategories,
      lastPeriodExpenses,
      lastPeriodIncome,
      period,
      spendingRate,
      categorySummary,
      expenseChange,
      incomeChange,
    });

    const completion = await completeText({
      feature: 'dashboard-short-insight',
      ...promptConfig,
      maxTokens: 80,
      temperature: 0.5,
    });

    const insight = completion?.text?.trim();

    // Fallback insights if AI fails or returns empty
    if (!insight) {
      return getFallbackInsight(userData);
    }

    return insight;

  } catch (error) {
    console.error('AI Service Error:', error);
    // Return fallback insight on error
    return getFallbackInsight(userData);
  }
}

/**
 * Generate a detailed multi-paragraph financial insight (for dashboard and budget screen).
 * Includes: summary, high-spending days, category callouts, budget vs limit, action items.
 * @param {Object} userData - User's financial data
 * @param {Number} userData.totalIncome - Total income
 * @param {Number} userData.totalExpenses - Total expenses
 * @param {Number} userData.balance - Balance
 * @param {Number} userData.monthlyBudgetLimit - User's monthly budget (null if not set)
 * @param {Number} userData.periodBudgetLimit - Budget for THIS period (scaled from monthly; use this for comparison)
 * @param {Number} userData.periodDays - Length of period in days (optional)
 * @param {Boolean} userData.isCurrentMonth - Whether period is current month (optional)
 * @param {Array} userData.topCategories - Top categories with name, total, percentage
 * @param {Array} userData.dailySpending - [{ date, total }] sorted by date, for "high spending days"
 * @param {String} userData.period - e.g. "this month"
 * @param {Number} userData.lastPeriodExpenses - Previous period expenses
 * @returns {Promise<String>} Multi-paragraph detailed insight
 */
async function generateDetailedFinancialInsight(userData) {
  try {
    if (process.env.NODE_ENV === 'test') {
      return getDetailedFallbackInsight(userData);
    }

    const {
      totalIncome = 0,
      totalExpenses = 0,
      balance = 0,
      monthlyBudgetLimit = null,
      periodBudgetLimit = null,
      periodDays = null,
      isCurrentMonth = true,
      topCategories = [],
      dailySpending = [],
      period = 'this month',
      lastPeriodExpenses = 0
    } = userData;

    const promptConfig = buildDetailedInsightPrompts({
      totalIncome,
      totalExpenses,
      balance,
      monthlyBudgetLimit,
      periodBudgetLimit,
      isCurrentMonth,
      topCategories,
      dailySpending,
      period,
      lastPeriodExpenses,
    });

    const completion = await completeText({
      feature: 'dashboard-detailed-insight',
      ...promptConfig,
      maxTokens: 700,
      temperature: 0.45,
    });

    const text = completion?.text?.trim();
    if (text) return text;
    return getDetailedFallbackInsight(userData);
  } catch (error) {
    console.error('AI detailed insight error:', error);
    return getDetailedFallbackInsight(userData);
  }
}

const safeJsonParse = (value) => {
  try {
    return JSON.parse(value);
  } catch (_error) {
    const match = String(value || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_innerError) {
      return null;
    }
  }
};

async function detectStatementStructureWithAI({ text = '', tableRows = null, fileType = null } = {}) {
  try {
    if (process.env.NODE_ENV === 'test') {
      return null;
    }

    const promptConfig = buildStatementStructurePrompts({ text, tableRows, fileType });
    const completion = await completeJson({
      feature: 'statement-structure-detection',
      ...promptConfig,
      maxTokens: 1800,
      temperature: 0.1,
    });

    if (!completion?.text) return null;
    return completion.json || safeJsonParse(completion.text);
  } catch (error) {
    console.error('AI statement structure detection error:', error);
    return null;
  }
}

/**
 * Fallback for detailed insight when AI fails
 */
function getDetailedFallbackInsight(userData) {
  const {
    totalIncome = 0,
    totalExpenses = 0,
    balance = 0,
    monthlyBudgetLimit = null,
    periodBudgetLimit = null,
    isCurrentMonth = true,
    topCategories = [],
    period = 'this month'
  } = userData;

  const currency = '₦';
  const limitForPeriod = periodBudgetLimit != null && periodBudgetLimit > 0 ? periodBudgetLimit : monthlyBudgetLimit;
  let text = '';

  if (totalIncome === 0 && totalExpenses === 0) {
    text = `No transactions recorded for ${period} yet. Start logging your income and expenses to get a detailed review and personalized tips.\n\nSet a monthly budget in Settings to see how you're doing against your limit.`;
    return text;
  }

  const spendingRate = totalIncome > 0 ? (totalExpenses / totalIncome * 100) : 0;
  text += `For ${period}, you spent ${currency}${totalExpenses.toLocaleString()} against income of ${currency}${totalIncome.toLocaleString()}, with a balance of ${currency}${balance.toLocaleString()}. Spending rate is ${spendingRate.toFixed(0)}% of income. `;

  if (limitForPeriod != null && limitForPeriod > 0) {
    const over = totalExpenses - limitForPeriod;
    if (over > 0) text += `For this period your budget was ${currency}${limitForPeriod.toLocaleString()}. You're over by ${currency}${over.toLocaleString()}. `;
    else text += `For this period your budget was ${currency}${limitForPeriod.toLocaleString()}. You're within budget. `;
  } else {
    text += 'Set a monthly budget in Settings to track your limit. ';
  }

  if (topCategories.length) {
    text += `Top spending: ${topCategories.slice(0, 3).map(c => `${c.name} (${currency}${(c.total || 0).toLocaleString()})`).join(', ')}. `;
  }
  text += '\n\nWhat you can do:\n- Keep tracking daily\n- Review your categories every week\n- Set a budget in Settings if you haven\'t';
  return text;
}

/**
 * Generate fallback insights when AI service is unavailable
 * @param {Object} userData - User's financial data
 * @returns {String} A predefined insight based on user's data
 */
function getFallbackInsight(userData) {
  const {
    totalIncome = 0,
    totalExpenses = 0,
    balance = 0,
    topCategories = []
  } = userData;

  // No transactions yet
  if (totalIncome === 0 && totalExpenses === 0) {
    return "Start tracking your expenses to see spending patterns 📊";
  }

  // Calculate spending rate
  const spendingRate = totalIncome > 0 ? (totalExpenses / totalIncome * 100) : 0;

  // Great budget management
  if (spendingRate < 50 && balance > 0) {
    return "Excellent budget control! You're saving well 🎉";
  }

  // Good budget management
  if (spendingRate >= 50 && spendingRate < 80) {
    return "You're within budget this period 👍";
  }

  // High spending
  if (spendingRate >= 80 && spendingRate < 100) {
    return "Spending is high - review your expenses 💡";
  }

  // Overspending
  if (spendingRate >= 100) {
    return "Expenses exceed income - time to adjust budget ⚠️";
  }

  // Default
  return "Keep tracking to improve your financial health 💪";
}

/**
 * Validate Azure OpenAI config
 * @returns {Boolean} True if provider is configured
 */
function isConfigured() {
  return isAzureOpenAIConfigured();
}

module.exports = {
  detectStatementStructureWithAI,
  generateFinancialInsight,
  generateDetailedFinancialInsight,
  getFallbackInsight,
  getDetailedFallbackInsight: getDetailedFallbackInsight,
  isConfigured
};
