const moment = require('moment');
const anomalyDetectionService = require('../anomalyDetection.service');
const forecastService = require('./forecast.service');
const behaviorProfileService = require('./behaviorProfile.service');
const {
  average,
  getUserProfile,
  listNormalizedTransactions,
  roundCurrency,
  splitTransactionsByWindow,
  standardDeviation,
  sum,
} = require('./insightHelpers');

function describeScore(score) {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 55) return 'fair';
  return 'needs_attention';
}

function buildWindowMetrics(transactions = []) {
  const income = transactions.filter((transaction) => transaction.kind === 'income');
  const expenses = transactions.filter((transaction) => transaction.kind === 'expense');
  const dailyExpenseMap = new Map();

  expenses.forEach((transaction) => {
    const key = moment(transaction.date).format('YYYY-MM-DD');
    dailyExpenseMap.set(key, (dailyExpenseMap.get(key) || 0) + Number(transaction.amount || 0));
  });

  const dailyExpenseValues = Array.from(dailyExpenseMap.values());

  return {
    incomeTotal: roundCurrency(sum(income.map((transaction) => transaction.amount))),
    expenseTotal: roundCurrency(sum(expenses.map((transaction) => transaction.amount))),
    expenseVolatility: average(dailyExpenseValues) > 0
      ? (standardDeviation(dailyExpenseValues) / average(dailyExpenseValues)) * 100
      : 0,
  };
}

function buildCashFlowScore(metrics, forecast) {
  const net = metrics.incomeTotal - metrics.expenseTotal;
  let score = 90;

  score -= Math.min(metrics.expenseVolatility, 45);
  if (net < 0) score -= 20;
  if ((forecast?.projectedMonthEndBalance || 0) < 0) score -= 15;

  return Math.max(20, Math.round(score));
}

function buildBudgetScore(userProfile, forecast, metrics) {
  const monthlyBudgetLimit = Number(userProfile?.monthlyBudgetLimit || 0);

  if (monthlyBudgetLimit > 0) {
    const projectedExpense = Number(forecast?.currentMonth?.expenses || 0)
      + Number(forecast?.projectedExpenses || 0);
    const utilization = projectedExpense / Math.max(monthlyBudgetLimit, 1);
    const score = 100 - Math.max(0, (utilization - 0.65) * 120);
    return Math.max(15, Math.round(score));
  }

  const savingsRate = metrics.incomeTotal > 0
    ? ((metrics.incomeTotal - metrics.expenseTotal) / metrics.incomeTotal) * 100
    : 0;

  return Math.max(20, Math.min(90, Math.round(55 + savingsRate)));
}

function buildSavingsScore(metrics, forecast) {
  if (!metrics.incomeTotal) return 35;

  const rate = ((metrics.incomeTotal - metrics.expenseTotal) / metrics.incomeTotal) * 100;
  let score = 55 + (rate * 2);

  if ((forecast?.projectedMonthEndBalance || 0) < 0) score -= 15;

  return Math.max(10, Math.min(100, Math.round(score)));
}

function buildAnomalyScore(anomalies) {
  const summary = anomalies?.summary || {};
  const score = 100
    - ((summary.critical || 0) * 25)
    - ((summary.high || 0) * 15)
    - ((summary.medium || 0) * 8)
    - ((summary.low || 0) * 4);

  return Math.max(10, Math.round(score));
}

function buildHabitScore(behavior) {
  let score = 85;

  if ((behavior?.weekendVsWeekday?.ratio || 0) >= 1.2) score -= 10;
  if ((behavior?.paydayPattern?.detected)) score -= 8;
  if ((behavior?.subscriptionCreep?.subscriptionCount || 0) >= 3) score -= 10;
  if ((behavior?.recurringLeakage?.monthlyLeakage || 0) >= 10000) score -= 15;
  if (behavior?.persona?.label === 'stable_planner') score += 5;

  return Math.max(20, Math.min(100, Math.round(score)));
}

function buildOverallScore(subScores) {
  const weightMap = {
    cash_flow_stability: 0.25,
    budget_discipline: 0.25,
    savings_capacity: 0.20,
    anomaly_risk: 0.15,
    habit_health: 0.15,
  };

  const weightedScore = subScores.reduce((total, item) => total + (item.score * weightMap[item.key]), 0);
  return Math.round(weightedScore);
}

function buildSummary(overallScore, trend) {
  if (overallScore >= 80) {
    return trend === 'declining'
      ? 'Your money is still okay, but small pressure is starting to show.'
      : 'Your money looks okay for now, and your spending is under control.';
  }

  if (overallScore >= 60) {
    return 'You are not in trouble, but one or two spending areas need quick control.';
  }

  return 'Your money needs quick attention now, so you do not run into trouble before month end.';
}

async function generateHealthScore(userId, options = {}) {
  const days = options.days || 90;
  const endDate = moment().endOf('day').toDate();
  const startDate = moment().subtract(days - 1, 'days').startOf('day').toDate();

  const [transactions, userProfile, anomalies, forecast, behavior] = await Promise.all([
    listNormalizedTransactions(userId, { startDate, endDate, includeTransfers: false }),
    getUserProfile(userId),
    options.anomalies
      ? Promise.resolve(options.anomalies)
      : anomalyDetectionService.detectAnomalies(userId, { lookbackDays: 30, threshold: 3 }),
    options.forecast
      ? Promise.resolve(options.forecast)
      : forecastService.generateForecast(userId, { days: 30 }),
    options.behavior
      ? Promise.resolve(options.behavior)
      : behaviorProfileService.analyzeBehaviorPatterns(userId, { months: 3 }),
  ]);

  const currentWindowStart = moment().subtract(29, 'days').startOf('day').toDate();
  const previousWindowStart = moment().subtract(59, 'days').startOf('day').toDate();
  const previousWindowEnd = moment().subtract(30, 'days').endOf('day').toDate();

  const currentMetrics = buildWindowMetrics(splitTransactionsByWindow(transactions, currentWindowStart, endDate));
  const previousMetrics = buildWindowMetrics(splitTransactionsByWindow(transactions, previousWindowStart, previousWindowEnd));

  const subScores = [
    {
      key: 'cash_flow_stability',
      label: 'Money flow',
      score: buildCashFlowScore(currentMetrics, forecast),
      reason: 'Checks if money is coming in and going out in a steady way.',
    },
    {
      key: 'budget_discipline',
      label: 'Budget use',
      score: buildBudgetScore(userProfile, forecast, currentMetrics),
      reason: 'Checks if your current spending can still stay inside budget.',
    },
    {
      key: 'savings_capacity',
      label: 'Saving room',
      score: buildSavingsScore(currentMetrics, forecast),
      reason: 'Shows if you still have room to save money this month.',
    },
    {
      key: 'anomaly_risk',
      label: 'Risk check',
      score: buildAnomalyScore(anomalies),
      reason: 'Looks for strange spending, duplicates, and risky moves.',
    },
    {
      key: 'habit_health',
      label: 'Spending habit',
      score: buildHabitScore(behavior),
      reason: 'Checks weekend spending, payday rush, subscriptions, and small small leaks.',
    },
  ].map((entry) => ({
    ...entry,
    status: describeScore(entry.score),
  }));

  const overallScore = buildOverallScore(subScores);
  const previousOverallScore = Math.round(
    (
      buildCashFlowScore(previousMetrics, { projectedMonthEndBalance: previousMetrics.incomeTotal - previousMetrics.expenseTotal }) * 0.25
      + buildBudgetScore(userProfile, null, previousMetrics) * 0.25
      + buildSavingsScore(previousMetrics, null) * 0.20
      + 80 * 0.15
      + 75 * 0.15
    )
  );
  const scoreDelta = overallScore - previousOverallScore;
  const trend = scoreDelta >= 4 ? 'improving' : scoreDelta <= -4 ? 'declining' : 'stable';

  return {
    generatedAt: new Date().toISOString(),
    overallScore,
    previousOverallScore,
    trend,
    summary: buildSummary(overallScore, trend),
    subScores,
    dataWindow: {
      startDate,
      endDate,
      comparisonStartDate: previousWindowStart,
      comparisonEndDate: previousWindowEnd,
    },
    confidence: Number((transactions.length >= 30 ? 0.84 : 0.65).toFixed(2)),
  };
}

module.exports = {
  generateHealthScore,
};
