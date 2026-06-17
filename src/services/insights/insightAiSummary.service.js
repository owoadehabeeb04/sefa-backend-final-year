const azureOpenAI = require('../llm/azureOpenAI.service');
const { formatNaira } = require('./financialDashboard.service');

/**
 * insightAiSummary.service
 *
 * The "AI explains" half of the system. It is given ONLY the numbers the backend
 * already calculated and asked to explain them in plain, friendly language. It
 * must never invent transactions, categories, balances, budgets, or trends.
 *
 * Grounding contract:
 *  - Input is a compact, structured snapshot of real calculated values.
 *  - A deterministic fallback summary is produced from the same numbers, so the
 *    feature still works when the LLM is unconfigured, disabled (tests), or errors.
 */

const SYSTEM_PROMPT = [
  'You are SEFA, a friendly money helper for everyday people in Nigeria. Currency is Naira (₦/N).',
  'You will receive a JSON object of financial figures that have ALREADY been calculated by the backend.',
  'Your job is ONLY to explain these exact numbers in simple, kind, non-judgmental language.',
  '',
  'Strict rules:',
  '- Never invent transactions, categories, balances, or budgets. Use only the numbers given.',
  '- Never say a budget was passed unless budgetHealth shows an "over_budget" item.',
  '- Never say a category increased or decreased unless previousPeriod or fastestGrowingCategory is present.',
  '- Use simple, everyday words. Short sentences. Be encouraging, not scary.',
  '- Do not use fear-based words. Do not shame the user.',
  '- Do NOT give investment, tax, loan, legal, or professional financial advice.',
  '- Briefly explain WHY each point is true using the supplied numbers.',
].join('\n');

const RESPONSE_INSTRUCTION = [
  'Return a JSON object with exactly these keys:',
  '{',
  '  "shortSummary": "1-2 friendly sentences summarizing the month",',
  '  "detailedExplanation": "3-5 sentences explaining where money went and budget position, grounded in the numbers",',
  '  "actions": ["2 to 4 short practical suggestions, each one sentence"]',
  '}',
  'Keep it warm and simple. No markdown. No advice outside everyday budgeting.',
].join('\n');

/**
 * Reduce a full dashboard payload to the compact, grounded input the AI sees.
 * This is the exact contract the prompt depends on — keep it stable and tested.
 */
function buildAiInput(dashboard) {
  const snapshot = dashboard.snapshot || dashboard;
  const drivers = dashboard.spendingDrivers || {};
  const budgetHealth = dashboard.budgetHealth || {};

  return {
    period: dashboard.period || dashboard.periodLabel || '',
    hasData: dashboard.hasData !== false,
    totalIncome: snapshot.totalIncome || 0,
    totalExpenses: snapshot.totalExpenses || 0,
    balance: snapshot.balance || 0,
    spendingRate: snapshot.spendingRate || 0,
    budgetUsage: snapshot.budgetUsage || 0,
    savingsPotential: snapshot.savingsPotential || 0,
    previousPeriod: snapshot.previousPeriod || null,
    categoryBreakdown: (dashboard.categoryBreakdown || [])
      .slice(0, 5)
      .map((row) => ({
        categoryName: row.categoryName,
        totalSpent: row.totalSpent,
        percentage: row.percentage,
      })),
    spendingDrivers: {
      topSpendingCategory: drivers.topSpendingCategory || null,
      highestSingleExpense: drivers.highestSingleExpense
        ? {
            amount: drivers.highestSingleExpense.amount,
            categoryName: drivers.highestSingleExpense.categoryName,
          }
        : null,
      fastestGrowingCategory: drivers.fastestGrowingCategory || null,
      categoriesOverBudget: (drivers.categoriesOverBudget || []).map((c) => c.categoryName),
    },
    savingsOpportunities: (dashboard.savingsOpportunities || [])
      .slice(0, 3)
      .map((opportunity) => ({
        title: opportunity.title,
        estimatedSavings: opportunity.estimatedSavings,
        confidence: opportunity.confidence,
      })),
    budgetHealth: {
      hasBudgets: budgetHealth.hasBudgets || false,
      monthly: budgetHealth.monthly || null,
      counts: budgetHealth.counts || null,
    },
  };
}

/**
 * Deterministic, grounded summary built purely from the calculated numbers.
 * Used as a fallback and as the base text streamed when the LLM is unavailable.
 */
function buildFallbackSummary(input) {
  if (!input.hasData) {
    return {
      shortSummary: 'No transactions yet for this period.',
      detailedExplanation:
        'Add a few transactions or import a statement and SEFA will show where your money goes, your budget position, and ways to save.',
      actions: ['Add your income and expenses for this month.', 'Or import a bank statement to get started.'],
      model: 'fallback',
    };
  }

  const top = input.spendingDrivers.topSpendingCategory;
  const overCount = input.budgetHealth.counts?.over_budget || 0;
  const lines = [];

  lines.push(
    `This period you earned ${formatNaira(input.totalIncome)} and spent ${formatNaira(input.totalExpenses)}, leaving ${formatNaira(
      input.balance
    )}.`
  );

  if (top) {
    lines.push(
      `${top.categoryName} took the largest share at ${top.percentage}% (${formatNaira(top.totalSpent)}).`
    );
  }

  if (input.budgetHealth.hasBudgets) {
    lines.push(
      overCount > 0
        ? `${overCount} ${overCount === 1 ? 'category is' : 'categories are'} over budget right now.`
        : 'You are within budget across your categories so far.'
    );
  }

  if (input.savingsPotential > 0) {
    lines.push(`SEFA spotted about ${formatNaira(input.savingsPotential)} you could save.`);
  }

  const actions = [];
  if (top) actions.push(`Keep an eye on ${top.categoryName} — small cuts there add up.`);
  if (overCount > 0) actions.push('Slow down spending in the categories over budget.');
  if (input.savingsOpportunities[0]) {
    actions.push(`Try this: ${input.savingsOpportunities[0].title}.`);
  }
  if (!actions.length) actions.push('Keep recording your transactions so insights get sharper.');

  return {
    shortSummary:
      input.balance >= 0
        ? `You spent ${formatNaira(input.totalExpenses)} and kept ${formatNaira(input.balance)} this period.`
        : `You spent more than you earned this period by ${formatNaira(Math.abs(input.balance))}.`,
    detailedExplanation: lines.join(' '),
    actions: actions.slice(0, 4),
    model: 'fallback',
  };
}

/**
 * Generate a grounded AI summary (buffered). Falls back to the deterministic
 * summary when the LLM is unavailable or returns an unusable response.
 */
async function generateSummary(dashboard) {
  const input = buildAiInput(dashboard);
  const fallback = buildFallbackSummary(input);

  if (!azureOpenAI.isConfigured()) {
    return fallback;
  }

  try {
    const result = await azureOpenAI.completeJson({
      feature: 'insight-summary',
      system: SYSTEM_PROMPT,
      prompt: `${RESPONSE_INSTRUCTION}\n\nFinancial figures (already calculated, do not change them):\n${JSON.stringify(
        input
      )}`,
      maxTokens: 600,
      temperature: 0.3,
    });

    const json = result?.json;
    if (json && (json.shortSummary || json.detailedExplanation)) {
      return {
        shortSummary: String(json.shortSummary || fallback.shortSummary).trim(),
        detailedExplanation: String(json.detailedExplanation || fallback.detailedExplanation).trim(),
        actions: Array.isArray(json.actions) && json.actions.length
          ? json.actions.slice(0, 4).map((a) => String(a).trim()).filter(Boolean)
          : fallback.actions,
        model: 'azure-openai',
      };
    }
  } catch (_error) {
    // Fall through to deterministic summary.
  }

  return fallback;
}

/**
 * Stream a grounded AI summary as plain-text deltas via `onDelta({ delta, fullText, isFinal })`.
 * When the LLM is unavailable, the deterministic summary text is streamed in
 * small chunks so the mobile "Layer 4" experience stays consistent.
 *
 * Returns the final structured summary object (for persistence).
 */
async function streamSummary(dashboard, onDelta) {
  const input = buildAiInput(dashboard);
  const fallback = buildFallbackSummary(input);

  const emitFallback = async () => {
    const text = `${fallback.shortSummary}\n\n${fallback.detailedExplanation}`;
    const words = text.split(' ');
    let acc = '';
    for (let i = 0; i < words.length; i += 4) {
      const chunk = words.slice(i, i + 4).join(' ') + ' ';
      acc += chunk;
      if (onDelta) await onDelta({ delta: chunk, fullText: acc.trim(), isFinal: false });
    }
    if (onDelta) await onDelta({ delta: '', fullText: acc.trim(), isFinal: true });
    return fallback;
  };

  if (!azureOpenAI.isConfigured()) {
    return emitFallback();
  }

  try {
    const streamResult = await azureOpenAI.streamText({
      feature: 'insight-summary-stream',
      system: SYSTEM_PROMPT,
      prompt: [
        'Explain these already-calculated financial figures in 4-6 warm, simple sentences.',
        'Cover: income vs spending and balance, the biggest spending area, budget position (only if budgets exist), and one or two ways to save.',
        'Plain text only. No markdown. No advice outside everyday budgeting.',
        '',
        `Figures (do not change them):\n${JSON.stringify(input)}`,
      ].join('\n'),
      maxTokens: 500,
      temperature: 0.3,
      onDelta,
    });

    if (streamResult && streamResult.text) {
      // Derive a short summary + actions from the deterministic builder so the
      // stored object stays well-structured even though we streamed free text.
      return {
        shortSummary: fallback.shortSummary,
        detailedExplanation: streamResult.text.trim(),
        actions: fallback.actions,
        model: 'azure-openai',
      };
    }
  } catch (_error) {
    // Fall through to deterministic stream.
  }

  return emitFallback();
}

module.exports = {
  buildAiInput,
  buildFallbackSummary,
  generateSummary,
  streamSummary,
  SYSTEM_PROMPT,
};
