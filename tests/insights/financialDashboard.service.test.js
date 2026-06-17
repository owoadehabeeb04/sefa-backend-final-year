const financialDashboard = require('../../src/services/insights/financialDashboard.service');
const insightAiSummary = require('../../src/services/insights/insightAiSummary.service');

const { calculateDashboard, resolvePeriod } = financialDashboard;

const period = resolvePeriod({ periodKey: '2026-06' });

const tx = (kind, amount, categoryName, description, extra = {}) => ({
  kind,
  amount,
  categoryName,
  description,
  date: new Date('2026-06-10'),
  categoryId: extra.categoryId || null,
  categoryColor: extra.categoryColor || null,
});

const baseTransactions = [
  tx('income', 200000, 'Salary', 'June salary'),
  tx('expense', 40000, 'Food & Dining', 'Groceries', { categoryId: 'food' }),
  tx('expense', 30000, 'Food & Dining', 'Groceries', { categoryId: 'food' }),
  tx('expense', 25000, 'Transport', 'Fuel', { categoryId: 'transport' }),
  tx('expense', 5000, 'Utilities', 'Electricity', { categoryId: 'utils' }),
];

describe('financialDashboard.calculateDashboard - overview', () => {
  it('computes income, expenses, balance, spending rate and savings potential', () => {
    const d = calculateDashboard({ transactions: baseTransactions, budgets: [], period });

    expect(d.totalIncome).toBe(200000);
    expect(d.totalExpenses).toBe(100000);
    expect(d.balance).toBe(100000);
    expect(d.spendingRate).toBe(0.5); // 100000 / 200000
    expect(d.savingsPotential).toBeGreaterThanOrEqual(0);
    expect(d.hasData).toBe(true);
  });

  it('returns a no-data shape when there are no transactions', () => {
    const d = calculateDashboard({ transactions: [], budgets: [], period });
    expect(d.hasData).toBe(false);
    expect(d.totalIncome).toBe(0);
    expect(d.totalExpenses).toBe(0);
    expect(d.categoryBreakdown).toEqual([]);
    expect(d.pieChart).toEqual([]);
    expect(d.savingsOpportunities).toEqual([]);
    expect(d.previousPeriod).toBeNull();
  });
});

describe('financialDashboard - category breakdown', () => {
  it('aggregates categories with totals, percentage, count and average', () => {
    const d = calculateDashboard({ transactions: baseTransactions, budgets: [], period });
    const food = d.categoryBreakdown.find((c) => c.categoryName === 'Food & Dining');

    expect(food.totalSpent).toBe(70000);
    expect(food.transactionCount).toBe(2);
    expect(food.averageTransaction).toBe(35000);
    expect(food.percentage).toBe(70); // 70000 / 100000
    expect(d.categoryBreakdown[0].categoryName).toBe('Food & Dining'); // sorted by spend
  });

  it('produces pie chart slices that reference categories and formatted amounts', () => {
    const d = calculateDashboard({ transactions: baseTransactions, budgets: [], period });
    expect(d.pieChart.length).toBeGreaterThan(0);
    const slice = d.pieChart[0];
    expect(slice).toHaveProperty('label');
    expect(slice).toHaveProperty('value');
    expect(slice).toHaveProperty('percentage');
    expect(slice).toHaveProperty('formattedAmount');
    expect(slice.formattedAmount).toContain('N');
  });
});

describe('financialDashboard - spending drivers', () => {
  it('identifies top spending, highest single expense and recurring indicators', () => {
    const d = calculateDashboard({ transactions: baseTransactions, budgets: [], period });
    const drivers = d.spendingDrivers;

    expect(drivers.topSpendingCategory.categoryName).toBe('Food & Dining');
    expect(drivers.highestSingleExpense.amount).toBe(40000);
    expect(drivers.recurringIndicators.length).toBeGreaterThan(0); // "Groceries" x2
  });

  it('only reports fastest-growing category when previous period data exists', () => {
    const previous = [tx('expense', 10000, 'Transport', 'Fuel', { categoryId: 'transport' })];
    const withPrev = calculateDashboard({
      transactions: baseTransactions,
      previousTransactions: previous,
      budgets: [],
      period,
    });
    expect(withPrev.spendingDrivers.fastestGrowingCategory).not.toBeNull();
    expect(withPrev.spendingDrivers.fastestGrowingCategory.categoryName).toBe('Transport');

    const noPrev = calculateDashboard({ transactions: baseTransactions, budgets: [], period });
    expect(noPrev.spendingDrivers.fastestGrowingCategory).toBeNull();
  });
});

describe('financialDashboard - budget health', () => {
  it('classifies categories as within / close / over budget', () => {
    const budgets = [
      { category: 'Food & Dining', amount: 50000, warningThreshold: 80, criticalThreshold: 100 }, // 70k spent -> over
      { category: 'Transport', amount: 30000, warningThreshold: 80, criticalThreshold: 100 }, // 25k -> close (83%)
      { category: 'Utilities', amount: 50000, warningThreshold: 80, criticalThreshold: 100 }, // 5k -> within
    ];
    const d = calculateDashboard({ transactions: baseTransactions, budgets, period });
    const byName = Object.fromEntries(d.budgetHealth.categories.map((c) => [c.categoryName, c.status]));

    expect(byName['Food & Dining']).toBe('over_budget');
    expect(byName['Transport']).toBe('close_to_limit');
    expect(byName['Utilities']).toBe('within_budget');
    expect(d.budgetHealth.hasBudgets).toBe(true);
  });

  it('marks budget health as having no budgets when none are set', () => {
    const d = calculateDashboard({ transactions: baseTransactions, budgets: [], period });
    expect(d.budgetHealth.hasBudgets).toBe(false);
    expect(d.budgetHealth.monthly.totalBudget).toBe(0);
  });
});

describe('financialDashboard - savings opportunities', () => {
  it('generates reason-backed opportunities with confidence levels for over-budget categories', () => {
    const budgets = [{ category: 'Food & Dining', amount: 50000, warningThreshold: 80, criticalThreshold: 100 }];
    const d = calculateDashboard({ transactions: baseTransactions, budgets, period });

    expect(d.savingsOpportunities.length).toBeGreaterThan(0);
    const budgetOpp = d.savingsOpportunities.find((o) => o.type === 'budget');
    expect(budgetOpp).toBeDefined();
    expect(budgetOpp.confidence).toBe('high');
    expect(budgetOpp.reason).toBeTruthy();
    expect(budgetOpp.estimatedSavings).toBeGreaterThan(0);
  });
});

describe('financialDashboard - previous period comparison', () => {
  it('includes a comparison block only when previous transactions exist', () => {
    const previous = [tx('expense', 60000, 'Food & Dining', 'Groceries', { categoryId: 'food' })];
    const d = calculateDashboard({
      transactions: baseTransactions,
      previousTransactions: previous,
      budgets: [],
      period,
    });
    expect(d.previousPeriod).not.toBeNull();
    expect(d.previousPeriod.totalExpenses).toBe(60000);
    expect(d.previousPeriod.expensesChange).toBe(40000); // 100000 - 60000
  });
});

describe('insightAiSummary - grounded input formatting', () => {
  it('builds AI input using only calculated numbers', () => {
    const d = calculateDashboard({ transactions: baseTransactions, budgets: [], period });
    const input = insightAiSummary.buildAiInput({ ...d, period: d.periodLabel, snapshot: d });

    expect(input.totalIncome).toBe(200000);
    expect(input.totalExpenses).toBe(100000);
    expect(input.balance).toBe(100000);
    expect(input.categoryBreakdown.length).toBeLessThanOrEqual(5);
    expect(input.spendingDrivers.topSpendingCategory.categoryName).toBe('Food & Dining');
  });

  it('produces a deterministic fallback summary that never invents data', () => {
    const d = calculateDashboard({ transactions: baseTransactions, budgets: [], period });
    const input = insightAiSummary.buildAiInput({ ...d, period: d.periodLabel, snapshot: d });
    const summary = insightAiSummary.buildFallbackSummary(input);

    expect(summary.shortSummary).toBeTruthy();
    expect(summary.detailedExplanation).toContain('N100,000');
    expect(Array.isArray(summary.actions)).toBe(true);
    expect(summary.model).toBe('fallback');
  });

  it('handles the no-data case with a helpful empty summary', () => {
    const d = calculateDashboard({ transactions: [], budgets: [], period });
    const input = insightAiSummary.buildAiInput({ ...d, period: d.periodLabel, snapshot: d });
    const summary = insightAiSummary.buildFallbackSummary(input);

    expect(summary.shortSummary).toMatch(/no transactions/i);
    expect(summary.actions.length).toBeGreaterThan(0);
  });

  it('generateSummary falls back to deterministic output when LLM is disabled (test env)', async () => {
    const d = calculateDashboard({ transactions: baseTransactions, budgets: [], period });
    const summary = await insightAiSummary.generateSummary({ ...d, period: d.periodLabel, snapshot: d });
    expect(summary.model).toBe('fallback');
    expect(summary.shortSummary).toBeTruthy();
  });
});
