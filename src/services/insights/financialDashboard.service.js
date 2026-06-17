const moment = require('moment');
const {
  createDateRange,
  getBudgetRecords,
  listNormalizedTransactions,
  normalizeCategoryName,
  roundCurrency,
  sum,
} = require('./insightHelpers');

/**
 * financialDashboard.service
 *
 * Pure backend calculators for the Insights dashboard. Every number shown in the
 * UI is produced here from real transaction + budget data. The AI layer only
 * explains these numbers — it never generates them.
 *
 * Design notes:
 *  - Uses lean queries (via insightHelpers.listNormalizedTransactions) scoped to
 *    the requested period only — never loads the user's whole history.
 *  - Transfers are excluded from analytics.
 *  - All currency values are whole-number Naira.
 */

const CATEGORY_COLOR_PALETTE = [
  '#ef4444',
  '#f59e0b',
  '#10b981',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
];
const OTHER_COLOR = '#94a3b8';

const DISCRETIONARY_HINTS = [
  'dining',
  'restaurant',
  'eat',
  'food',
  'entertainment',
  'shopping',
  'fun',
  'leisure',
  'subscription',
  'streaming',
  'games',
  'gaming',
  'fashion',
  'clothes',
  'snack',
  'coffee',
  'bar',
  'club',
  'takeout',
];

const hashText = (value = '') =>
  String(value)
    .split('')
    .reduce((total, character) => total + character.charCodeAt(0), 0);

const resolveCategoryColor = (categoryName, providedColor) => {
  if (/^#[0-9a-f]{6}$/i.test(String(providedColor || '').trim())) {
    return providedColor;
  }
  return CATEGORY_COLOR_PALETTE[hashText(categoryName) % CATEGORY_COLOR_PALETTE.length];
};

const formatNaira = (value) => `N${roundCurrency(value).toLocaleString('en-NG')}`;

const isDiscretionary = (categoryName) => {
  const key = normalizeCategoryName(categoryName);
  return DISCRETIONARY_HINTS.some((hint) => key.includes(hint));
};

/**
 * Resolve the canonical period (a single calendar month) for a snapshot.
 * @param {Object} [opts]
 * @param {string} [opts.periodKey] - "YYYY-MM"
 * @param {Date} [opts.reference] - any date inside the desired month
 */
function resolvePeriod(opts = {}) {
  const base = opts.periodKey
    ? moment(opts.periodKey, 'YYYY-MM')
    : opts.reference
      ? moment(opts.reference)
      : moment();

  const start = base.clone().startOf('month');
  const end = base.clone().endOf('month');

  return {
    periodKey: start.format('YYYY-MM'),
    periodLabel: start.format('MMMM YYYY'),
    periodStart: start.toDate(),
    periodEnd: end.toDate(),
    previousKey: start.clone().subtract(1, 'month').format('YYYY-MM'),
  };
}

function splitByKind(transactions = []) {
  const expenses = [];
  const income = [];
  transactions.forEach((transaction) => {
    if (transaction.kind === 'expense') expenses.push(transaction);
    else if (transaction.kind === 'income') income.push(transaction);
  });
  return { expenses, income };
}

/**
 * Group expense transactions into category rows with totals, counts, averages.
 */
function buildCategoryRows(expenses = []) {
  const rows = new Map();

  expenses.forEach((transaction) => {
    const key = normalizeCategoryName(transaction.categoryName) || 'uncategorized';
    const current = rows.get(key) || {
      categoryId: transaction.categoryId || null,
      categoryName: transaction.categoryName || 'Uncategorized',
      total: 0,
      count: 0,
      color: resolveCategoryColor(transaction.categoryName, transaction.categoryColor),
      amounts: [],
      lastDate: transaction.date,
    };

    current.total += Number(transaction.amount || 0);
    current.count += 1;
    current.amounts.push(Number(transaction.amount || 0));
    if (transaction.date > current.lastDate) current.lastDate = transaction.date;

    rows.set(key, current);
  });

  return Array.from(rows.values()).sort((left, right) => right.total - left.total);
}

/**
 * Category breakdown — name, total, %, count, average, color.
 */
function buildCategoryBreakdown(expenses = [], totalExpenses = 0) {
  return buildCategoryRows(expenses).map((row) => ({
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    totalSpent: roundCurrency(row.total),
    percentage: totalExpenses ? Number(((row.total / totalExpenses) * 100).toFixed(1)) : 0,
    transactionCount: row.count,
    averageTransaction: roundCurrency(row.total / Math.max(row.count, 1)),
    color: row.color,
  }));
}

/**
 * Pie chart data — collapses the long tail into a single "Other" slice.
 */
function buildPieChart(categoryBreakdown = [], totalExpenses = 0, limit = 6) {
  if (!categoryBreakdown.length) return [];

  const top = categoryBreakdown.slice(0, limit).map((row) => ({
    label: row.categoryName,
    value: row.totalSpent,
    percentage: row.percentage,
    categoryId: row.categoryId,
    color: row.color,
    formattedAmount: formatNaira(row.totalSpent),
  }));

  const remaining = categoryBreakdown.slice(limit);
  if (remaining.length) {
    const otherValue = roundCurrency(sum(remaining.map((row) => row.totalSpent)));
    top.push({
      label: 'Other',
      value: otherValue,
      percentage: totalExpenses ? Number(((otherValue / totalExpenses) * 100).toFixed(1)) : 0,
      categoryId: null,
      color: OTHER_COLOR,
      formattedAmount: formatNaira(otherValue),
    });
  }

  return top;
}

/**
 * Map active budgets (which key on a category *name* string) onto category rows.
 */
function indexBudgets(budgets = []) {
  const map = new Map();
  (budgets || []).forEach((budget) => {
    map.set(normalizeCategoryName(budget.category), {
      amount: Number(budget.amount || 0),
      warningThreshold: Number(budget.warningThreshold || 80),
      criticalThreshold: Number(budget.criticalThreshold || 100),
    });
  });
  return map;
}

function resolveBudgetStatus(percentUsed, hasBudget, warningThreshold = 80) {
  if (!hasBudget) return 'no_budget';
  if (percentUsed >= 100) return 'over_budget';
  if (percentUsed >= warningThreshold) return 'close_to_limit';
  return 'within_budget';
}

/**
 * Budget health — per-category position + an overall monthly position.
 */
function buildBudgetHealth({ categoryBreakdown, budgets, totalExpenses }) {
  const budgetMap = indexBudgets(budgets);

  const categories = categoryBreakdown.map((row) => {
    const budget = budgetMap.get(normalizeCategoryName(row.categoryName));
    const budgetAmount = budget ? budget.amount : 0;
    const percentUsed = budgetAmount
      ? Number(((row.totalSpent / Math.max(budgetAmount, 1)) * 100).toFixed(1))
      : 0;

    return {
      categoryName: row.categoryName,
      budgetAmount: roundCurrency(budgetAmount),
      spent: row.totalSpent,
      percentUsed,
      remaining: roundCurrency(Math.max(budgetAmount - row.totalSpent, 0)),
      status: resolveBudgetStatus(percentUsed, Boolean(budget), budget?.warningThreshold),
      color: row.color,
    };
  });

  // Categories that have a budget but no spend this month still belong in the
  // health view (within budget, 0% used).
  const seen = new Set(categories.map((entry) => normalizeCategoryName(entry.categoryName)));
  budgetMap.forEach((budget, key) => {
    if (seen.has(key)) return;
    categories.push({
      categoryName: key.replace(/\b\w/g, (c) => c.toUpperCase()),
      budgetAmount: roundCurrency(budget.amount),
      spent: 0,
      percentUsed: 0,
      remaining: roundCurrency(budget.amount),
      status: 'within_budget',
      color: OTHER_COLOR,
    });
  });

  const totalBudget = roundCurrency(sum(Array.from(budgetMap.values()).map((b) => b.amount)));
  const monthlyPercentUsed = totalBudget
    ? Number(((totalExpenses / Math.max(totalBudget, 1)) * 100).toFixed(1))
    : 0;

  const counts = {
    within_budget: 0,
    close_to_limit: 0,
    over_budget: 0,
    no_budget: 0,
  };
  categories.forEach((entry) => {
    counts[entry.status] = (counts[entry.status] || 0) + 1;
  });

  return {
    hasBudgets: budgetMap.size > 0,
    monthly: {
      totalBudget,
      totalSpent: totalExpenses,
      percentUsed: monthlyPercentUsed,
      remaining: roundCurrency(Math.max(totalBudget - totalExpenses, 0)),
      status: resolveBudgetStatus(monthlyPercentUsed, totalBudget > 0),
    },
    counts,
    categories: categories.sort((left, right) => right.percentUsed - left.percentUsed),
  };
}

/**
 * Spending Drivers — "what is taking the money".
 * Pure structural analysis. `previousRows` (last month's category rows) enable
 * growth detection; when absent, growth fields stay empty (never invented).
 */
function buildSpendingDrivers({ expenses, categoryBreakdown, budgetHealth, previousCategoryRows }) {
  const topSpendingCategory = categoryBreakdown[0] || null;

  const mostFrequentCategory = [...categoryBreakdown]
    .sort((left, right) => right.transactionCount - left.transactionCount)[0] || null;

  const highestSingleExpense = expenses.reduce((highest, transaction) => {
    if (!highest || transaction.amount > highest.amount) {
      return {
        amount: roundCurrency(transaction.amount),
        description: transaction.description,
        categoryName: transaction.categoryName,
        date: transaction.date,
      };
    }
    return highest;
  }, null);

  // Fastest growing category — only when previous-period data exists.
  let fastestGrowingCategory = null;
  if (Array.isArray(previousCategoryRows) && previousCategoryRows.length) {
    const prevMap = new Map(
      previousCategoryRows.map((row) => [normalizeCategoryName(row.categoryName), row.totalSpent])
    );
    categoryBreakdown.forEach((row) => {
      const prev = prevMap.get(normalizeCategoryName(row.categoryName));
      if (prev == null || prev <= 0) return;
      const changePercent = Number((((row.totalSpent - prev) / prev) * 100).toFixed(1));
      if (changePercent > 0 && (!fastestGrowingCategory || changePercent > fastestGrowingCategory.changePercent)) {
        fastestGrowingCategory = {
          categoryName: row.categoryName,
          previousSpent: roundCurrency(prev),
          currentSpent: row.totalSpent,
          changePercent,
        };
      }
    });
  }

  // Recurring expense indicators — same description appearing 2+ times.
  const descCounts = new Map();
  expenses.forEach((transaction) => {
    const key = normalizeCategoryName(transaction.description);
    if (!key) return;
    const entry = descCounts.get(key) || {
      description: transaction.description,
      categoryName: transaction.categoryName,
      count: 0,
      total: 0,
    };
    entry.count += 1;
    entry.total += Number(transaction.amount || 0);
    descCounts.set(key, entry);
  });
  const recurringIndicators = Array.from(descCounts.values())
    .filter((entry) => entry.count >= 2)
    .sort((left, right) => right.total - left.total)
    .slice(0, 5)
    .map((entry) => ({
      description: entry.description,
      categoryName: entry.categoryName,
      occurrences: entry.count,
      total: roundCurrency(entry.total),
    }));

  const categoriesCloseToBudget = (budgetHealth?.categories || [])
    .filter((entry) => entry.status === 'close_to_limit')
    .map((entry) => ({
      categoryName: entry.categoryName,
      percentUsed: entry.percentUsed,
      spent: entry.spent,
      budgetAmount: entry.budgetAmount,
    }));

  const categoriesOverBudget = (budgetHealth?.categories || [])
    .filter((entry) => entry.status === 'over_budget')
    .map((entry) => ({
      categoryName: entry.categoryName,
      percentUsed: entry.percentUsed,
      spent: entry.spent,
      budgetAmount: entry.budgetAmount,
    }));

  // Possible money leaks — recurring discretionary spend.
  const possibleMoneyLeaks = recurringIndicators
    .filter((entry) => isDiscretionary(entry.categoryName) || isDiscretionary(entry.description))
    .slice(0, 3)
    .map((entry) => ({
      description: entry.description,
      categoryName: entry.categoryName,
      occurrences: entry.occurrences,
      total: entry.total,
      reason: `Appears ${entry.occurrences} times this period and looks discretionary.`,
    }));

  return {
    topSpendingCategory: topSpendingCategory
      ? {
          categoryName: topSpendingCategory.categoryName,
          totalSpent: topSpendingCategory.totalSpent,
          percentage: topSpendingCategory.percentage,
        }
      : null,
    mostFrequentCategory: mostFrequentCategory
      ? {
          categoryName: mostFrequentCategory.categoryName,
          transactionCount: mostFrequentCategory.transactionCount,
          totalSpent: mostFrequentCategory.totalSpent,
        }
      : null,
    highestSingleExpense,
    fastestGrowingCategory,
    recurringIndicators,
    categoriesCloseToBudget,
    categoriesOverBudget,
    possibleMoneyLeaks,
  };
}

/**
 * Savings opportunities — realistic, reason-backed, with confidence levels.
 */
function buildSavingsOpportunities({ categoryBreakdown, budgetHealth, spendingDrivers, totalExpenses }) {
  const opportunities = [];

  // 1. High discretionary categories — suggest trimming a slice.
  categoryBreakdown
    .filter((row) => isDiscretionary(row.categoryName) && row.totalSpent > 0)
    .slice(0, 3)
    .forEach((row, index) => {
      const reductionRate = row.percentage >= 25 ? 0.2 : 0.15;
      const estimatedSavings = roundCurrency(row.totalSpent * reductionRate);
      if (estimatedSavings <= 0) return;
      opportunities.push({
        id: `discretionary-${index + 1}`,
        type: 'category',
        title: `Trim ${row.categoryName}`,
        categoryName: row.categoryName,
        estimatedSavings,
        confidence: row.percentage >= 20 ? 'high' : 'medium',
        reason: `${row.categoryName} is ${row.percentage}% of your spending this period. Cutting it by ${Math.round(
          reductionRate * 100
        )}% could free about ${formatNaira(estimatedSavings)}.`,
      });
    });

  // 2. Subscription / recurring review.
  (spendingDrivers?.possibleMoneyLeaks || []).forEach((leak, index) => {
    opportunities.push({
      id: `subscription-${index + 1}`,
      type: 'subscription',
      title: `Review "${leak.description}"`,
      categoryName: leak.categoryName,
      estimatedSavings: roundCurrency(leak.total / Math.max(leak.occurrences, 1)),
      confidence: 'medium',
      reason: `This repeated ${leak.occurrences} times (${formatNaira(
        leak.total
      )} total). Cancelling or reducing it could save the cost of one occurrence.`,
    });
  });

  // 3. Over-budget categories — bring back to budget.
  (budgetHealth?.categories || [])
    .filter((entry) => entry.status === 'over_budget')
    .slice(0, 3)
    .forEach((entry, index) => {
      const overspend = roundCurrency(entry.spent - entry.budgetAmount);
      if (overspend <= 0) return;
      opportunities.push({
        id: `budget-${index + 1}`,
        type: 'budget',
        title: `Bring ${entry.categoryName} back to budget`,
        categoryName: entry.categoryName,
        estimatedSavings: overspend,
        confidence: 'high',
        reason: `${entry.categoryName} is ${entry.percentUsed}% of its budget. Staying within budget saves about ${formatNaira(
          overspend
        )}.`,
      });
    });

  // De-duplicate by category+type, keep highest savings, cap to a sensible list.
  const deduped = [];
  const seen = new Set();
  opportunities
    .sort((left, right) => right.estimatedSavings - left.estimatedSavings)
    .forEach((opportunity) => {
      const key = `${opportunity.type}:${normalizeCategoryName(opportunity.categoryName || opportunity.title)}`;
      if (seen.has(key)) return;
      seen.add(key);
      deduped.push(opportunity);
    });

  const list = deduped.slice(0, 6);
  const totalEstimated = roundCurrency(sum(list.map((entry) => entry.estimatedSavings)));

  return {
    totalEstimatedSavings: totalEstimated,
    percentOfExpenses: totalExpenses ? Number(((totalEstimated / totalExpenses) * 100).toFixed(1)) : 0,
    opportunities: list,
  };
}

/**
 * Build the full financial snapshot (Layer 1 numbers) plus all analytics blocks.
 * Returns a plain object ready to be persisted as a snapshot and/or returned to
 * the client. Pure — no DB writes, no AI.
 *
 * @param {Object} input
 * @param {Array}  input.transactions       - current period transactions
 * @param {Array}  input.previousTransactions - previous period transactions (may be [])
 * @param {Array}  input.budgets            - active budget records
 * @param {Object} input.period             - resolvePeriod() output
 */
function calculateDashboard({ transactions, previousTransactions = [], budgets = [], period }) {
  const { expenses, income } = splitByKind(transactions);

  const totalIncome = roundCurrency(sum(income.map((t) => t.amount)));
  const totalExpenses = roundCurrency(sum(expenses.map((t) => t.amount)));
  const balance = roundCurrency(totalIncome - totalExpenses);
  const spendingRate = totalIncome > 0 ? Number((totalExpenses / totalIncome).toFixed(2)) : 0;

  const categoryBreakdown = buildCategoryBreakdown(expenses, totalExpenses);
  const pieChart = buildPieChart(categoryBreakdown, totalExpenses);

  const budgetHealth = buildBudgetHealth({ categoryBreakdown, budgets, totalExpenses });
  const budgetUsage = budgetHealth.monthly.percentUsed;

  const previousExpenses = splitByKind(previousTransactions).expenses;
  const previousCategoryRows = buildCategoryBreakdown(
    previousExpenses,
    roundCurrency(sum(previousExpenses.map((t) => t.amount)))
  );

  const spendingDrivers = buildSpendingDrivers({
    expenses,
    categoryBreakdown,
    budgetHealth,
    previousCategoryRows,
  });

  const savings = buildSavingsOpportunities({
    categoryBreakdown,
    budgetHealth,
    spendingDrivers,
    totalExpenses,
  });

  // Previous-period comparison block (null when no previous data).
  let previousPeriod = null;
  if (previousTransactions.length) {
    const prevSplit = splitByKind(previousTransactions);
    const prevIncome = roundCurrency(sum(prevSplit.income.map((t) => t.amount)));
    const prevExpenses = roundCurrency(sum(prevSplit.expenses.map((t) => t.amount)));
    previousPeriod = {
      periodKey: period.previousKey,
      periodLabel: moment(period.previousKey, 'YYYY-MM').format('MMMM YYYY'),
      totalIncome: prevIncome,
      totalExpenses: prevExpenses,
      balance: roundCurrency(prevIncome - prevExpenses),
      expensesChange: roundCurrency(totalExpenses - prevExpenses),
      expensesChangePercent: prevExpenses
        ? Number((((totalExpenses - prevExpenses) / prevExpenses) * 100).toFixed(1))
        : null,
    };
  }

  const hasData = transactions.length > 0;

  return {
    periodKey: period.periodKey,
    periodLabel: period.periodLabel,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    hasData,
    hasBudgets: budgetHealth.hasBudgets,

    // Financial snapshot
    totalIncome,
    totalExpenses,
    balance,
    spendingRate,
    budgetUsage,
    savingsPotential: savings.totalEstimatedSavings,
    previousPeriod,

    // Analytics
    categoryBreakdown,
    pieChart,
    spendingDrivers,
    savingsOpportunities: savings.opportunities,
    savingsSummary: {
      totalEstimatedSavings: savings.totalEstimatedSavings,
      percentOfExpenses: savings.percentOfExpenses,
    },
    budgetHealth,
  };
}

/**
 * Load the data for a period and run the calculators. This is the single entry
 * point used by the snapshot/cache service. Uses lean, period-scoped queries.
 */
async function buildDashboardForPeriod(userId, opts = {}) {
  const period = resolvePeriod(opts);
  const previous = resolvePeriod({ periodKey: period.previousKey });

  const [transactions, previousTransactions, budgets] = await Promise.all([
    listNormalizedTransactions(userId, {
      startDate: period.periodStart,
      endDate: period.periodEnd,
      includeTransfers: false,
    }),
    listNormalizedTransactions(userId, {
      startDate: previous.periodStart,
      endDate: previous.periodEnd,
      includeTransfers: false,
    }),
    getBudgetRecords(userId),
  ]);

  return calculateDashboard({ transactions, previousTransactions, budgets, period });
}

module.exports = {
  buildBudgetHealth,
  buildCategoryBreakdown,
  buildDashboardForPeriod,
  buildPieChart,
  buildSavingsOpportunities,
  buildSpendingDrivers,
  calculateDashboard,
  formatNaira,
  resolveCategoryColor,
  resolvePeriod,
  // exported for tests
  createDateRange,
};
