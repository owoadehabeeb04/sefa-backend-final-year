const moment = require('moment');
const anomalyDetectionService = require('../anomalyDetection.service');
const budgetRecommendationService = require('../budgetRecommendation.service');
const savingsSuggestionService = require('../savingsSuggestion.service');
const spendingPatternService = require('../spendingPatternAnalyzer.service');
const InsightFeedback = require('../../models/InsightFeedback');
const forecastService = require('./forecast.service');
const behaviorProfileService = require('./behaviorProfile.service');
const healthScoreService = require('./healthScore.service');
const {
  clamp,
  createDateRange,
  buildDailySeries,
  listNormalizedTransactions,
  normalizeCategoryName,
  roundCurrency,
  sum,
} = require('./insightHelpers');

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

function formatNaira(value) {
  return `N${roundCurrency(value).toLocaleString('en-NG')}`;
}

function hashText(value = '') {
  return String(value)
    .split('')
    .reduce((total, character) => total + character.charCodeAt(0), 0);
}

function resolveCategoryColor(categoryName, providedColor) {
  if (/^#[0-9a-f]{6}$/i.test(String(providedColor || '').trim())) {
    return providedColor;
  }

  return CATEGORY_COLOR_PALETTE[hashText(categoryName) % CATEGORY_COLOR_PALETTE.length];
}

function resolveBudgetStatus(spent, budgetAmount, fallbackStatus) {
  if (fallbackStatus) return fallbackStatus;
  if (!budgetAmount) return spent > 0 ? 'monitor' : 'healthy';

  const ratio = spent / Math.max(Number(budgetAmount || 0), 1);
  if (ratio >= 1) return 'over';
  if (ratio >= 0.85) return 'watch';
  return 'healthy';
}

function buildExpenseCategoryRows(expenseTransactions = [], forecastCategories = []) {
  const forecastMap = new Map(
    (forecastCategories || []).map((entry) => [normalizeCategoryName(entry.categoryName), entry])
  );
  const rows = new Map();

  expenseTransactions.forEach((transaction) => {
    const key = normalizeCategoryName(transaction.categoryName) || 'uncategorized-expense';
    const forecastCategory = forecastMap.get(key);
    const current = rows.get(key) || {
      categoryName: transaction.categoryName || 'Uncategorized Expense',
      amount: 0,
      count: 0,
      color: resolveCategoryColor(transaction.categoryName, transaction.categoryColor),
      budgetAmount: forecastCategory?.budgetAmount || null,
      status: forecastCategory?.status || null,
    };

    current.amount += Number(transaction.amount || 0);
    current.count += 1;

    rows.set(key, current);
  });

  return Array.from(rows.values())
    .map((entry) => ({
      categoryName: entry.categoryName,
      amount: roundCurrency(entry.amount),
      count: entry.count,
      color: entry.color,
      budgetAmount: entry.budgetAmount !== null ? roundCurrency(entry.budgetAmount) : null,
      percentUsed: entry.budgetAmount
        ? Number(((entry.amount / Math.max(entry.budgetAmount, 1)) * 100).toFixed(0))
        : null,
      status: resolveBudgetStatus(entry.amount, entry.budgetAmount, entry.status),
    }))
    .sort((left, right) => right.amount - left.amount);
}

function collapseSpendingCategories(rows = [], totalCurrentMonthSpending = 0, limit = 4) {
  if (!rows.length) return [];

  const topRows = rows.slice(0, limit).map((row) => ({
    categoryName: row.categoryName,
    amount: row.amount,
    percentage: Number(((row.amount / Math.max(totalCurrentMonthSpending, 1)) * 100).toFixed(2)),
    color: row.color,
    budgetAmount: row.budgetAmount,
    status: row.status,
  }));

  const remaining = rows.slice(limit);
  if (!remaining.length) {
    return topRows;
  }

  const otherAmount = roundCurrency(sum(remaining.map((entry) => entry.amount)));
  topRows.push({
    categoryName: 'Other',
    amount: otherAmount,
    percentage: Number(((otherAmount / Math.max(totalCurrentMonthSpending, 1)) * 100).toFixed(2)),
    color: '#94a3b8',
    budgetAmount: null,
    status: 'monitor',
  });

  return topRows;
}

function buildLineSeries(series = [], valueKey) {
  const total = series.length;

  return series.map((entry, index) => ({
    x: index + 1,
    y: roundCurrency(entry[valueKey] || 0),
    amount: roundCurrency(entry[valueKey] || 0),
    date: entry.date,
    label: moment(entry.date).format('D'),
    tickLabel: (
      index === 0
      || index === total - 1
      || index === Math.floor((total - 1) / 2)
      || (total > 10 && index % 5 === 0)
    )
      ? moment(entry.date).format('D')
      : '',
  }));
}

function buildForecastContinuationSeries(forecast = {}, actualCount = 0) {
  const monthEnd = moment().endOf('month');

  return (forecast.dailyForecast || [])
    .filter((entry) => moment(entry.date).isSameOrBefore(monthEnd, 'day'))
    .map((entry, index, list) => ({
      x: actualCount + index + 1,
      y: roundCurrency(entry.projectedExpenses || 0),
      amount: roundCurrency(entry.projectedExpenses || 0),
      date: entry.date,
      label: moment(entry.date).format('D'),
      tickLabel: (
        index === list.length - 1
        || index === Math.floor((list.length - 1) / 2)
      )
        ? moment(entry.date).format('D')
        : '',
    }));
}

function getTrendDirection(actualSeries = []) {
  if (actualSeries.length < 4) return 'steady';

  const midpoint = Math.floor(actualSeries.length / 2);
  const firstHalf = actualSeries.slice(0, midpoint);
  const secondHalf = actualSeries.slice(midpoint);
  const firstAverage = sum(firstHalf.map((entry) => entry.amount)) / Math.max(firstHalf.length, 1);
  const secondAverage = sum(secondHalf.map((entry) => entry.amount)) / Math.max(secondHalf.length, 1);

  if (secondAverage > firstAverage * 1.1) return 'rising';
  if (secondAverage < firstAverage * 0.9) return 'falling';
  return 'steady';
}

function buildVisuals({
  summary,
  forecast,
  recommendations,
  anomalies,
  spendingPatterns,
  spendingBreakdown,
  actualSeries,
  forecastSeries,
  budgetUsage,
}) {
  const sparkline = actualSeries.slice(-7);
  const incomeVsExpense = (spendingPatterns?.monthlyComparison || [])
    .slice(0, 6)
    .reverse()
    .map((entry) => ({
      label: moment(entry.month, 'MMMM YYYY').format('MMM'),
      fullLabel: entry.month,
      income: roundCurrency(entry.income),
      expenses: roundCurrency(entry.expenses),
      balance: roundCurrency(entry.balance),
    }));

  return {
    mainUpdate: {
      message: summary.headline,
      supportingText: summary.keyTakeaway,
      projectedMonthEndBalance: forecast.projectedMonthEndBalance,
      actionText: recommendations.nextBestAction,
      sparkline,
      status: forecast.projectedMonthEndBalance < 0
        ? 'at_risk'
        : forecast.overspendingProbability >= 0.6
          ? 'watch'
          : 'healthy',
    },
    spendingBreakdown,
    spendingTrend: {
      actualSeries,
      forecastSeries,
      direction: getTrendDirection(actualSeries),
    },
    incomeVsExpense: {
      periods: incomeVsExpense,
    },
    budgetUsage,
    savingsActions: recommendations.savingsActions.slice(0, 4).map((action) => ({
      ...action,
      impact: roundCurrency(action.impact),
    })),
    thingsToCheck: anomalies.alerts.slice(0, 3),
  };
}

function buildTextSection(title, lines = [], action, extra = {}) {
  return {
    title,
    lines: lines.filter(Boolean).slice(0, 4),
    action,
    ...extra,
  };
}

function buildTextView({
  forecast,
  recommendations,
  anomalies,
  spendingBreakdown,
  spendingTrend,
  suggestedQuestions,
}) {
  const topCategory = spendingBreakdown.categories[0];
  const secondCategory = spendingBreakdown.categories[1];
  const topRiskCategory = forecast.likelyBudgetBreachCategories[0] || forecast.categoryForecasts[0];
  const alertLines = anomalies.alerts.slice(0, 3).map((alert) => alert.title);

  const trendLine = spendingTrend.direction === 'rising'
    ? 'Spending is moving up as the month is going.'
    : spendingTrend.direction === 'falling'
      ? 'Spending is calming down a bit this month.'
      : 'Spending looks steady this month.';

  return {
    mainUpdate: buildTextSection(
      'Main Money Update',
      [
        forecast.projectedMonthEndBalance < 0
          ? 'At this rate, month end may be hard.'
          : 'You can likely reach month end.',
        forecast.projectedMonthEndBalance < 0
          ? `If spending stays like this, you may be short by ${formatNaira(Math.abs(forecast.projectedMonthEndBalance))} before month end.`
          : `If spending stays like this, you may still have about ${formatNaira(forecast.projectedMonthEndBalance)} by month end.`,
        topRiskCategory
          ? `${topRiskCategory.categoryName} is the main place to watch now.`
          : 'No one spending area is standing out too much right now.',
      ],
      topRiskCategory
        ? `Try to reduce ${topRiskCategory.categoryName} this week.`
        : recommendations.nextBestAction
    ),
    thingsToCheck: buildTextSection(
      'Things To Check',
      alertLines.length
        ? alertLines
        : ['No serious problem is showing right now.', 'Your recent spending looks normal.'],
      anomalies.alerts[0]?.recommendedAction || 'Keep checking your recent transactions.'
    ),
    whereMoneyGoes: buildTextSection(
      'Where Your Money Is Going',
      topCategory
        ? [
            `${topCategory.categoryName} is taking the biggest part of your money this month.`,
            `You have spent about ${formatNaira(topCategory.amount)} on ${topCategory.categoryName}.`,
            secondCategory
              ? `${secondCategory.categoryName} is next with about ${formatNaira(secondCategory.amount)}.`
              : null,
          ]
        : [
            'No spending record is showing for this month yet.',
            'Add your expenses so SEFA can explain where the money is going.',
          ],
      topCategory
        ? `Start with ${topCategory.categoryName} if you want to save more.`
        : 'Add a few expense records first.'
    ),
    thisMonthTrend: buildTextSection(
      'This Month Trend',
      [
        trendLine,
        `Expected month end balance is ${formatNaira(forecast.projectedMonthEndBalance)}.`,
        forecast.overspendingProbability >= 0.6
          ? 'Chance of overspending is high if you keep this pace.'
          : topRiskCategory
            ? `${topRiskCategory.categoryName} may pass budget soon.`
            : 'No big warning sign is showing right now.',
      ],
      topRiskCategory
        ? `Slow down ${topRiskCategory.categoryName} before month end.`
        : 'Keep extra spending low this week.'
    ),
    waysToSave: buildTextSection(
      'Ways To Save This Week',
      recommendations.savingsActions.length
        ? recommendations.savingsActions.slice(0, 3).map((action) =>
            `${action.title} can save about ${formatNaira(action.impact)} this month.`
          )
        : [
            'No clear saving step is showing yet.',
            'Add more records so SEFA can find better ways to save.',
          ],
      recommendations.savingsActions.length
        ? 'Pick one or two of these this week.'
        : 'Keep adding your records.'
    ),
    askSefa: buildTextSection(
      'Ask SEFA',
      [
        'Ask simple questions about month end, spending, or how to save.',
        'Tap a quick question below or type your own question.',
      ],
      'Ask one question and use the answer this week.',
      { prompts: suggestedQuestions.slice(0, 4) }
    ),
  };
}

function mapAnomalyRiskTag(anomaly) {
  if (anomaly.type === 'potential_duplicate') return 'possible_error';
  if (anomaly.severity === 'critical' || anomaly.severity === 'high') return 'possible_fraud';
  return 'likely_genuine';
}

function buildEvidenceCard({
  id,
  title,
  type,
  insight,
  why,
  dataWindow,
  confidence,
  metrics,
  recommendedAction,
}) {
  return {
    id,
    title,
    type,
    insight,
    why,
    dataWindow,
    confidence: Number((confidence || 0.7).toFixed(2)),
    metrics,
    recommendedAction,
  };
}

function buildRecommendationPayload({ budgetRecommendations, savingsSuggestions, forecast, behavior, anomalies }) {
  const budgetActions = (budgetRecommendations?.categories || [])
    .filter((entry) => entry.status === 'over' || entry.adjustment < 0)
    .slice(0, 4)
    .map((entry, index) => ({
      id: `budget-action-${index + 1}`,
      title: `Reduce ${entry.categoryName}`,
      action: entry.message,
      impact: roundCurrency(Math.abs(entry.adjustment || 0)),
      confidence: 0.78,
    }));

  const savingsActions = [
    ...(savingsSuggestions?.quickWins || []).map((entry, index) => ({
      id: `savings-quick-win-${index + 1}`,
      title: entry.title,
      action: entry.action,
      impact: roundCurrency(entry.potentialSavings || 0),
      confidence: 0.8,
    })),
    ...((savingsSuggestions?.opportunities?.categories || []).slice(0, 3).map((entry, index) => ({
      id: `savings-category-${index + 1}`,
      title: `Trim ${entry.category}`,
      action: entry.tips?.[0] || 'Check this area and reduce the amount.',
      impact: roundCurrency(entry.potentialMonthlySavings || 0),
      confidence: 0.76,
    }))),
  ].slice(0, 6);

  const weeklyNudges = [
    behavior?.nudges?.[0],
    anomalies?.recommendations?.[0]?.action,
    forecast?.likelyBudgetBreachCategories?.[0]
      ? `Watch ${forecast.likelyBudgetBreachCategories[0].categoryName}. It may pass budget soon.`
      : 'No big risk area is showing now. Just keep spending steady.',
  ].filter(Boolean);

  const nextBestAction = savingsActions[0]?.action
    || budgetActions[0]?.action
    || weeklyNudges[0]
    || 'Keep adding your money records so the advice gets better.';

  return {
    budgetActions,
    savingsActions,
    weeklyNudges,
    nextBestAction,
  };
}

async function buildInsightsHub(userId, options = {}) {
  const months = Number(options.months) || 3;
  const forecastDays = Number(options.days) === 7 ? 7 : 30;
  const { startDate, endDate } = createDateRange({ months });

  const [
    transactions,
    spendingPatterns,
    anomalies,
    budgetRecommendations,
    savingsSuggestions,
    forecast,
    behaviorPatterns,
  ] = await Promise.all([
    listNormalizedTransactions(userId, { startDate, endDate, includeTransfers: false }),
    spendingPatternService.analyzeSpendingPatterns(userId, { months }),
    anomalyDetectionService.detectAnomalies(userId, { lookbackDays: 30, threshold: 3 }),
    budgetRecommendationService.generateBudgetRecommendations(userId, { months }),
    savingsSuggestionService.generateSavingsSuggestions(userId, { months }),
    forecastService.generateForecast(userId, { days: forecastDays }),
    behaviorProfileService.analyzeBehaviorPatterns(userId, { months }),
  ]);

  const healthScore = await healthScoreService.generateHealthScore(userId, {
    days: 90,
    anomalies,
    forecast,
    behavior: behaviorPatterns,
  });

  const totalIncome = roundCurrency(sum(
    transactions.filter((transaction) => transaction.kind === 'income').map((transaction) => transaction.amount)
  ));
  const totalExpenses = roundCurrency(sum(
    transactions.filter((transaction) => transaction.kind === 'expense').map((transaction) => transaction.amount)
  ));
  const recommendations = buildRecommendationPayload({
    budgetRecommendations,
    savingsSuggestions,
    forecast,
    behavior: behaviorPatterns,
    anomalies,
  });

  const topAnomaly = anomalies.anomalies[0];
  const topSavingsAction = recommendations.savingsActions[0];
  const topBudgetRisk = forecast.likelyBudgetBreachCategories[0];
  const todayMoment = moment().startOf('day');
  const monthStart = todayMoment.clone().startOf('month');
  const monthToDateTransactions = transactions.filter((transaction) =>
    moment(transaction.date).isSameOrAfter(monthStart, 'day')
  );
  const monthExpenseRows = buildExpenseCategoryRows(
    monthToDateTransactions.filter((transaction) => transaction.kind === 'expense'),
    forecast.categoryForecasts
  );
  const spendingBreakdown = {
    totalCurrentMonthSpending: forecast.currentMonth.expenses,
    categories: collapseSpendingCategories(monthExpenseRows, forecast.currentMonth.expenses),
  };
  const budgetUsage = monthExpenseRows
    .filter((entry) => entry.budgetAmount !== null)
    .sort((left, right) => {
      const leftValue = left.percentUsed !== null ? left.percentUsed : left.amount;
      const rightValue = right.percentUsed !== null ? right.percentUsed : right.amount;
      return rightValue - leftValue;
    })
    .slice(0, 4)
    .map((entry) => ({
      categoryName: entry.categoryName,
      spent: entry.amount,
      budgetAmount: entry.budgetAmount,
      percentUsed: entry.percentUsed || 0,
      status: entry.status,
      color: entry.color,
    }));
  const actualSeries = buildLineSeries(
    buildDailySeries(monthToDateTransactions, monthStart.toDate(), todayMoment.toDate()),
    'expenses'
  );
  const forecastSeries = buildForecastContinuationSeries(forecast, actualSeries.length);

  const evidence = [
    buildEvidenceCard({
      id: 'health-score',
      title: 'Money score',
      type: 'health_score',
      insight: `${healthScore.overallScore}/100 and things are ${healthScore.trend}.`,
      why: healthScore.summary,
      dataWindow: 'Last 90 days',
      confidence: healthScore.confidence,
      metrics: {
        overallScore: healthScore.overallScore,
        trend: healthScore.trend,
      },
      recommendedAction: recommendations.nextBestAction,
    }),
    buildEvidenceCard({
      id: 'forecast',
      title: 'Month end check',
      type: 'forecast',
      insight: forecast.headline,
      why: `If you continue like this, month end balance may be around ₦${forecast.projectedMonthEndBalance.toLocaleString()}. Risk of overspending is about ${(forecast.overspendingProbability * 100).toFixed(0)}%.`,
      dataWindow: `${forecast.horizonDays} days plus this month`,
      confidence: forecast.confidence,
      metrics: {
        projectedIncome: forecast.projectedIncome,
        projectedExpenses: forecast.projectedExpenses,
        projectedMonthEndBalance: forecast.projectedMonthEndBalance,
      },
      recommendedAction: topBudgetRisk
        ? `Try to cut ${topBudgetRisk.categoryName} a bit.`
        : recommendations.nextBestAction,
    }),
    buildEvidenceCard({
      id: 'behavior',
      title: 'Spending style',
      type: 'behavior',
      insight: `${behaviorPatterns.persona.title}: ${behaviorPatterns.persona.reason}`,
      why: behaviorPatterns.weekendVsWeekday.summary,
      dataWindow: `Last ${months} months`,
      confidence: behaviorPatterns.confidence,
      metrics: {
        persona: behaviorPatterns.persona.label,
        weekendRatio: behaviorPatterns.weekendVsWeekday.ratio,
        recurringLeakage: behaviorPatterns.recurringLeakage.monthlyLeakage,
      },
      recommendedAction: behaviorPatterns.nudges[0],
    }),
    buildEvidenceCard({
      id: 'anomaly',
      title: 'Risk check',
      type: 'risk',
      insight: topAnomaly
        ? topAnomaly.message
        : 'No serious strange spending is showing now.',
      why: topAnomaly
        ? `We marked this because it does not look like your normal spending.`
        : 'Your recent spending looks normal.',
      dataWindow: 'Last 30 days',
      confidence: topAnomaly ? 0.72 : 0.86,
      metrics: {
        critical: anomalies.summary.critical,
        high: anomalies.summary.high,
        totalAnomalies: anomalies.summary.totalAnomalies,
      },
      recommendedAction: topAnomaly
        ? anomalies.recommendations[0]?.action || 'Check the flagged transaction.'
        : 'Keep checking your transactions.',
    }),
    buildEvidenceCard({
      id: 'savings',
      title: 'Best way to save',
      type: 'recommendation',
      insight: topSavingsAction
        ? `${topSavingsAction.title} can save about ₦${topSavingsAction.impact.toLocaleString()} in one month.`
        : 'No big saving chance is showing right now.',
      why: savingsSuggestions.aiAdvice || budgetRecommendations.aiAdvice || 'This advice came from the places where your money goes often.',
      dataWindow: `Last ${months} months`,
      confidence: topSavingsAction?.confidence || 0.67,
      metrics: {
        totalPotentialSavings: savingsSuggestions.summary?.totalMonthlyPotential || 0,
        opportunityCount: savingsSuggestions.summary?.opportunityCount || 0,
      },
      recommendedAction: topSavingsAction?.action || recommendations.nextBestAction,
    }),
  ];

  const overallConfidence = Number(
    (
      evidence.reduce((total, entry) => total + Number(entry.confidence || 0), 0) / Math.max(evidence.length, 1)
    ).toFixed(2)
  );

  const summaryStatus = healthScore.overallScore >= 80
    ? 'healthy'
    : healthScore.overallScore >= 60
      ? 'watch'
      : 'at_risk';

  const summary = {
    headline: forecast.projectedMonthEndBalance < 0
      ? 'At this rate, month end may be hard unless spending comes down.'
      : `${behaviorPatterns.persona.title}. Your money looks ${summaryStatus === 'healthy' ? 'okay' : 'up and down'} for now.`,
    narrative: healthScore.summary,
    keyTakeaway: topBudgetRisk
      ? `${topBudgetRisk.categoryName} is the main place you need to watch now.`
      : recommendations.nextBestAction,
    nextBestAction: recommendations.nextBestAction,
  };
  const mappedAlerts = anomalies.anomalies.slice(0, 8).map((anomaly, index) => ({
    id: `anomaly-${index + 1}`,
    type: anomaly.type,
    title: anomaly.message,
    severity: anomaly.severity,
    confidence: anomaly.severity === 'critical' ? 0.86 : anomaly.severity === 'high' ? 0.78 : 0.66,
    why: anomaly.details,
    riskTag: mapAnomalyRiskTag(anomaly),
    recommendedAction: anomalies.recommendations[0]?.action || 'Check the flagged transaction.',
  }));
  const visuals = buildVisuals({
    summary,
    forecast,
    recommendations,
    anomalies: {
      alerts: mappedAlerts,
    },
    spendingPatterns,
    spendingBreakdown,
    actualSeries,
    forecastSeries,
    budgetUsage,
  });
  const textView = buildTextView({
    forecast,
    recommendations,
    anomalies: {
      alerts: visuals.thingsToCheck,
    },
    spendingBreakdown,
    spendingTrend: visuals.spendingTrend,
    suggestedQuestions: [
      'Can I still reach month end?',
      'Where is my money going most?',
      'Which transaction looks strange?',
      'How can I save N20,000 this month?',
    ],
  });

  return {
    generatedAt: new Date().toISOString(),
    summary,
    healthScore,
    subScores: healthScore.subScores,
    forecast,
    anomalies: {
      summary: anomalies.summary,
      alerts: mappedAlerts,
      recommendations: anomalies.recommendations,
    },
    behaviorPatterns,
    recommendations,
    visuals,
    textView,
    confidence: overallConfidence,
    evidence,
    suggestedQuestions: [
      'Can I still reach month end?',
      'Where is my money going most?',
      'Which transaction looks strange?',
      'How can I save N20,000 this month?',
    ],
    researchMetrics: {
      forecastMAE: forecast.backtest?.maeExpense || 0,
      forecastMAPE: forecast.backtest?.mapeExpense || 0,
      anomalyCount: anomalies.summary.totalAnomalies,
      estimatedMonthlySavings: savingsSuggestions.summary?.totalMonthlyPotential || 0,
      totalIncome,
      totalExpenses,
    },
  };
}

function normalizeScenarioAdjustments(payload = {}) {
  if (Array.isArray(payload.adjustments) && payload.adjustments.length) {
    return payload.adjustments;
  }

  const adjustments = [];

  if (payload.categoryName && Number.isFinite(Number(payload.reductionPercent))) {
    adjustments.push({
      type: 'category_reduction',
      categoryName: payload.categoryName,
      percent: Number(payload.reductionPercent),
    });
  }

  if (Number.isFinite(Number(payload.incomeChangePercent))) {
    adjustments.push({
      type: 'income_change',
      percent: Number(payload.incomeChangePercent),
    });
  }

  return adjustments;
}

async function runWhatIfScenario(userId, payload = {}) {
  const forecastDays = Number(payload.days) === 7 ? 7 : 30;
  const baseline = payload.hub?.forecast || await forecastService.generateForecast(userId, { days: forecastDays });
  const adjustments = normalizeScenarioAdjustments(payload);

  let projectedExpenses = Number(baseline.projectedExpenses || 0);
  let projectedIncome = Number(baseline.projectedIncome || 0);
  let projectedMonthEndBalance = Number(baseline.projectedMonthEndBalance || 0);
  const assumptions = [];

  adjustments.forEach((adjustment) => {
    if (adjustment.type === 'category_reduction') {
      const category = baseline.categoryForecasts?.find((entry) =>
        String(entry.categoryName || '').toLowerCase() === String(adjustment.categoryName || '').toLowerCase()
      );

      const share = category && baseline.currentMonth?.expenses
        ? Number(category.currentSpend || 0) / Math.max(Number(baseline.currentMonth.expenses || 0), 1)
        : 0.15;
      const reduction = projectedExpenses * share * (Number(adjustment.percent || 0) / 100);
      projectedExpenses -= reduction;
      projectedMonthEndBalance += reduction;
      assumptions.push(`Reduce ${adjustment.categoryName} by ${adjustment.percent}%`);
    }

    if (adjustment.type === 'income_change') {
      const delta = projectedIncome * (Number(adjustment.percent || 0) / 100);
      projectedIncome += delta;
      projectedMonthEndBalance += delta;
      assumptions.push(`Change income by ${adjustment.percent}%`);
    }
  });

  const scenario = {
    projectedIncome: roundCurrency(projectedIncome),
    projectedExpenses: roundCurrency(projectedExpenses),
    projectedNetCashFlow: roundCurrency(projectedIncome - projectedExpenses),
    projectedMonthEndBalance: roundCurrency(projectedMonthEndBalance),
    assumptions,
  };

  return {
    baseline: {
      projectedIncome: baseline.projectedIncome,
      projectedExpenses: baseline.projectedExpenses,
      projectedMonthEndBalance: baseline.projectedMonthEndBalance,
    },
    scenario,
    delta: {
      projectedIncome: roundCurrency(scenario.projectedIncome - Number(baseline.projectedIncome || 0)),
      projectedExpenses: roundCurrency(scenario.projectedExpenses - Number(baseline.projectedExpenses || 0)),
      projectedMonthEndBalance: roundCurrency(
        scenario.projectedMonthEndBalance - Number(baseline.projectedMonthEndBalance || 0)
      ),
    },
    explanation: assumptions.length
      ? `We checked this change: ${assumptions.join(', ')}.`
      : 'No change was added, so this is the normal result.',
    confidence: Number(clamp(baseline.confidence || 0.7, 0.4, 0.92).toFixed(2)),
  };
}

async function submitInsightFeedback(userId, payload = {}) {
  const feedback = await InsightFeedback.create({
    userId,
    sessionId: payload.sessionId || null,
    insightKey: payload.insightKey,
    insightType: payload.insightType,
    rating: payload.rating,
    comment: payload.comment,
    metadata: payload.metadata || {},
  });

  return feedback.toObject();
}

module.exports = {
  buildInsightsHub,
  runWhatIfScenario,
  submitInsightFeedback,
};
