const Groq = require('groq-sdk');

// Initialize Groq client
const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

/**
 * Generate a financial insight using Groq AI
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
    if (!groq || process.env.NODE_ENV === 'test') {
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

    // Build context-aware prompt
    const prompt = `You are a friendly financial advisor. Give ONE short tip in 15 words or less. Use SIMPLE words only — no big grammar. The people using this app are ordinary people, not experts. Write like you're chatting with a friend.

Financial Summary for ${period}:
- Income: ₦${totalIncome.toLocaleString()}
- Expenses: ₦${totalExpenses.toLocaleString()}
- Balance: ₦${balance.toLocaleString()}
- Spending Rate: ${spendingRate}% of income
- Top Spending: ${categorySummary || 'None yet'}
- Expense Change from Last Period: ${expenseChange > 0 ? '+' : ''}${expenseChange}%
- Income Change from Last Period: ${incomeChange > 0 ? '+' : ''}${incomeChange}%

Rules:
1. Use only simple, everyday words. No difficult or formal language.
2. Be encouraging and positive, never judgmental
3. Use ONLY ONE emoji maximum (at the end)
4. Must be 15 words or less
5. If spending is high, say it in simple terms and give one easy tip
6. If no transactions exist, tell them to start adding their money in and out

Good examples (simple language):
- "You're within budget this week 👍"
- "Transport cost went up — try carpooling?"
- "You saved more than last month. Well done 🎉"
- "You spent a lot on food — try cooking at home more"
- "You can save ₦25,000 this month if you keep this up 💪"
- "Start adding your income and expenses to see where money goes"

Provide ONLY the insight, nothing else:`;

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You give very short financial tips. Use only simple words. No big grammar or hard words. Write for ordinary people.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      model: 'llama-3.3-70b-versatile', // Groq's best model
      temperature: 0.7,
      max_tokens: 50,
      top_p: 1,
      stream: false
    });

    const insight = completion.choices[0]?.message?.content?.trim();

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
    if (!groq || process.env.NODE_ENV === 'test') {
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

    const currency = '₦';
    const spendingRate = totalIncome > 0 ? ((totalExpenses / totalIncome) * 100).toFixed(0) : 0;
    const categoryLines = topCategories.slice(0, 5).map(c => `${c.name}: ${currency}${(c.total || 0).toLocaleString()} (${(c.percentage || 0)}%)`).join('\n');
    const dailyLines = dailySpending.length
      ? dailySpending
          .sort((a, b) => (b.total || 0) - (a.total || 0))
          .slice(0, 5)
          .map(d => `${d.date}: ${currency}${(d.total || 0).toLocaleString()}`)
          .join('\n')
      : 'No daily breakdown yet.';

    // Compare spending to the PERIOD budget (scaled), not monthly — so the AI says "budget for this period" correctly
    const limitForPeriod = periodBudgetLimit != null && periodBudgetLimit > 0 ? periodBudgetLimit : monthlyBudgetLimit;
    const budgetContext = limitForPeriod != null && limitForPeriod > 0
      ? `Budget for THIS period: ${currency}${Number(limitForPeriod).toLocaleString()}${!isCurrentMonth && monthlyBudgetLimit != null ? ` (from your ${currency}${Number(monthlyBudgetLimit).toLocaleString()}/month)` : ''}. Spent in this period: ${currency}${totalExpenses.toLocaleString()}. ${totalExpenses > limitForPeriod ? 'Over budget for this period.' : 'Within budget for this period.'}`
      : 'No budget set.';

    const prompt = `You are a friendly finance coach. Write a short review in 3-4 paragraphs. Use SIMPLE words only — no big grammar. The people using this app are ordinary people, not experts. Write like you're talking to a friend. No difficult words, no formal language.

Financial data for ${period}:
- Income: ${currency}${totalIncome.toLocaleString()}
- Expenses: ${currency}${totalExpenses.toLocaleString()}
- Balance: ${currency}${balance.toLocaleString()}
- Spending rate: ${spendingRate}% of income
- ${budgetContext}

Top spending categories:
${categoryLines || 'None yet'}

Heaviest spending days (date and total):
${dailyLines}

Previous period expenses: ${currency}${lastPeriodExpenses.toLocaleString()}.
${isCurrentMonth ? '\nIMPORTANT: This period is the CURRENT month (still ongoing). Use PRESENT tense only: say "you are having", "you\'re on track", "you\'re spending" — do NOT use past tense like "you had" or "you spent".' : ''}

Structure your response (use simple words only):
1) First paragraph: In one or two short sentences, say how they did (e.g. you did well, you're over budget, you saved well). Be kind and honest. ${isCurrentMonth ? 'Use present tense: "you are having a tough month" not "you had a tough month".' : ''}
2) Second paragraph: If some days had high spending, say which days and give one simple tip (e.g. "You spent a lot on Jan 15 and Jan 22. Try to spread big spends across more days."). If not, say something short about where they spent most.
3) Third paragraph: If they have a budget, compare spending to the BUDGET FOR THIS PERIOD (not monthly). Say clearly: on track, almost at limit, or over for this period, and by how much. If no budget, tell them to set one in Settings.
4) Then give 2 to 4 action items as a BULLET LIST. Use a dash (-) or bullet (•) before each item. Keep each item one short line. Examples:
   - Eat out less next week.
   - Set a limit for transport.
   - Check your subscriptions.

Use Nigerian Naira (₦). Use a mix of short paragraphs and a bullet list for the action items. Simple words only. No markdown except the bullet list.`;

    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: 'You are a helpful finance coach. Use only simple, everyday words. No big grammar or hard words. Write for ordinary people. Use short paragraphs and a bullet list (with - or •) for action items.' },
        { role: 'user', content: prompt }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.6,
      max_tokens: 500,
      top_p: 1,
      stream: false
    });

    const text = completion.choices[0]?.message?.content?.trim();
    if (text) return text;
    return getDetailedFallbackInsight(userData);
  } catch (error) {
    console.error('AI detailed insight error:', error);
    return getDetailedFallbackInsight(userData);
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
 * Validate Groq API key
 * @returns {Boolean} True if API key is configured
 */
function isConfigured() {
  return !!process.env.GROQ_API_KEY;
}

module.exports = {
  generateFinancialInsight,
  generateDetailedFinancialInsight,
  getFallbackInsight,
  getDetailedFallbackInsight: getDetailedFallbackInsight,
  isConfigured
};
