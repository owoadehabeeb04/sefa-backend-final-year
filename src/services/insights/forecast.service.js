const moment = require('moment');
const ForecastBacktest = require('../../models/ForecastBacktest');
const {
  average,
  buildCategorySummary,
  clamp,
  getBudgetRecords,
  getUserProfile,
  listNormalizedTransactions,
  normalizeCategoryName,
  percentage,
  roundCurrency,
  splitTransactionsByWindow,
  sum,
  toObjectId,
} = require('./insightHelpers');

function buildProjectionContext(transactions = [], referenceDate = moment()) {
  const referenceMoment = moment(referenceDate).endOf('day');
  const history = transactions.filter((transaction) =>
    moment(transaction.date).isSameOrBefore(referenceMoment)
  );
  const historyStart = history.length
    ? moment(history[history.length - 1].date).startOf('day')
    : moment(referenceMoment).subtract(89, 'days').startOf('day');
  const historyDays = Math.max(referenceMoment.diff(historyStart, 'days') + 1, 1);

  const recentStart = moment(referenceMoment).subtract(29, 'days').startOf('day');
  const recentWindow = history.filter((transaction) =>
    moment(transaction.date).isSameOrAfter(recentStart)
  );

  const currentMonthStart = moment(referenceMoment).startOf('month');
  const currentMonthWindow = history.filter((transaction) =>
    moment(transaction.date).isSameOrAfter(currentMonthStart)
  );

  const totals = {
    expense: {
      overall: 0,
      recent: 0,
      currentMonth: 0,
      weekdayTotals: new Array(7).fill(0),
    },
    income: {
      overall: 0,
      recent: 0,
      currentMonth: 0,
      weekdayTotals: new Array(7).fill(0),
    },
  };

  history.forEach((transaction) => {
    totals[transaction.kind].overall += Number(transaction.amount || 0);
    totals[transaction.kind].weekdayTotals[moment(transaction.date).day()] += Number(transaction.amount || 0);
  });

  recentWindow.forEach((transaction) => {
    totals[transaction.kind].recent += Number(transaction.amount || 0);
  });

  currentMonthWindow.forEach((transaction) => {
    totals[transaction.kind].currentMonth += Number(transaction.amount || 0);
  });

  const recentDays = Math.max(referenceMoment.diff(recentStart, 'days') + 1, 1);
  const currentMonthDays = Math.max(referenceMoment.diff(currentMonthStart, 'days') + 1, 1);
  const weekdayOccurrences = new Array(7).fill(0);

  const cursor = moment(historyStart);
  while (cursor.isSameOrBefore(referenceMoment, 'day')) {
    weekdayOccurrences[cursor.day()] += 1;
    cursor.add(1, 'day');
  }

  return {
    referenceMoment,
    historyDays,
    recentDays,
    currentMonthDays,
    weekdayOccurrences,
    transactions: history,
    expense: {
      overallDailyAverage: totals.expense.overall / historyDays,
      recentDailyAverage: totals.expense.recent / recentDays,
      currentMonthDailyAverage: totals.expense.currentMonth / currentMonthDays,
      weekdayAverages: totals.expense.weekdayTotals.map((total, index) =>
        total / Math.max(weekdayOccurrences[index], 1)
      ),
    },
    income: {
      overallDailyAverage: totals.income.overall / historyDays,
      recentDailyAverage: totals.income.recent / recentDays,
      currentMonthDailyAverage: totals.income.currentMonth / currentMonthDays,
      weekdayAverages: totals.income.weekdayTotals.map((total, index) =>
        total / Math.max(weekdayOccurrences[index], 1)
      ),
    },
  };
}

function weightedAverage(pairs = []) {
  const validPairs = pairs.filter(([value, weight]) => Number.isFinite(value) && value > 0 && weight > 0);
  if (!validPairs.length) return 0;

  const totalWeight = sum(validPairs.map((pair) => pair[1]));
  return validPairs.reduce((total, [value, weight]) => total + (value * weight), 0) / totalWeight;
}

function projectAmountForDay(context, kind, dayMoment) {
  const weekday = dayMoment.day();
  const bucket = context[kind];
  const base = weightedAverage([
    [bucket.recentDailyAverage, 0.45],
    [bucket.weekdayAverages[weekday], 0.35],
    [bucket.currentMonthDailyAverage, 0.20],
  ]);

  if (base > 0) {
    return roundCurrency(base);
  }

  return roundCurrency(bucket.overallDailyAverage);
}

function projectRange(context, startDate, days) {
  const series = [];
  const cursor = moment(startDate).startOf('day');

  for (let index = 0; index < days; index += 1) {
    const expense = projectAmountForDay(context, 'expense', cursor);
    const income = projectAmountForDay(context, 'income', cursor);

    series.push({
      date: cursor.format('YYYY-MM-DD'),
      projectedIncome: income,
      projectedExpenses: expense,
      projectedNet: roundCurrency(income - expense),
    });

    cursor.add(1, 'day');
  }

  return series;
}

function buildCategoryForecasts(expenseTransactions, budgets, monthStart, todayMoment, monthEndMoment) {
  const daysElapsed = Math.max(todayMoment.diff(monthStart, 'days') + 1, 1);
  const daysRemaining = Math.max(monthEndMoment.diff(todayMoment, 'days'), 0);
  const budgetMap = new Map(
    budgets.map((budget) => [normalizeCategoryName(budget.category), budget])
  );

  const monthToDateSummary = buildCategorySummary(expenseTransactions);
  const categoryForecasts = monthToDateSummary.map((entry) => {
    const budget = budgetMap.get(normalizeCategoryName(entry.categoryName));
    const currentDailyAverage = entry.total / daysElapsed;
    const projectedSpend = roundCurrency(entry.total + (currentDailyAverage * daysRemaining));
    const breachRatio = budget?.amount
      ? projectedSpend / Math.max(Number(budget.amount), 1)
      : 0;

    return {
      categoryName: entry.categoryName,
      currentSpend: roundCurrency(entry.total),
      projectedSpend,
      budgetAmount: budget ? roundCurrency(budget.amount) : null,
      transactionCount: entry.count,
      breachProbability: budget
        ? Number(clamp((breachRatio - 0.8) / 0.4, 0.05, 0.98).toFixed(2))
        : null,
      status: budget
        ? breachRatio >= 1 ? 'breach_likely' : breachRatio >= 0.9 ? 'watch' : 'healthy'
        : projectedSpend > 0 ? 'monitor' : 'healthy',
    };
  });

  return {
    categoryForecasts,
    likelyBudgetBreachCategories: categoryForecasts
      .filter((entry) => entry.breachProbability !== null && entry.breachProbability >= 0.35)
      .sort((left, right) => (right.breachProbability || 0) - (left.breachProbability || 0))
      .slice(0, 5),
  };
}

async function buildBacktest(userId, horizonDays, transactions, evaluationMoment) {
  if (transactions.length < 10) return null;

  const actualStart = moment(evaluationMoment).subtract(horizonDays, 'days').startOf('day');
  const actualEnd = moment(evaluationMoment).subtract(1, 'day').endOf('day');

  const trainingTransactions = transactions.filter((transaction) =>
    moment(transaction.date).isBefore(actualStart)
  );

  const actualTransactions = splitTransactionsByWindow(
    transactions,
    actualStart.toDate(),
    actualEnd.toDate()
  );

  if (trainingTransactions.length < 5 || actualTransactions.length < 2) {
    return null;
  }

  const context = buildProjectionContext(trainingTransactions, actualStart.clone().subtract(1, 'day'));
  const projection = projectRange(context, actualStart.toDate(), horizonDays);
  const predictedExpenseTotal = roundCurrency(sum(projection.map((entry) => entry.projectedExpenses)));
  const predictedIncomeTotal = roundCurrency(sum(projection.map((entry) => entry.projectedIncome)));
  const actualExpenseTotal = roundCurrency(sum(
    actualTransactions.filter((transaction) => transaction.kind === 'expense').map((transaction) => transaction.amount)
  ));
  const actualIncomeTotal = roundCurrency(sum(
    actualTransactions.filter((transaction) => transaction.kind === 'income').map((transaction) => transaction.amount)
  ));

  const payload = {
    userId: toObjectId(userId),
    horizonDays,
    evaluationDate: moment(evaluationMoment).startOf('day').toDate(),
    trainingWindow: {
      startDate: trainingTransactions.length
        ? moment(trainingTransactions[trainingTransactions.length - 1].date).toDate()
        : actualStart.clone().subtract(90, 'days').toDate(),
      endDate: actualStart.clone().subtract(1, 'day').toDate(),
    },
    forecastWindow: {
      startDate: actualStart.toDate(),
      endDate: actualEnd.toDate(),
    },
    predictedExpenseTotal,
    actualExpenseTotal,
    predictedIncomeTotal,
    actualIncomeTotal,
    predictedNetBalance: roundCurrency(predictedIncomeTotal - predictedExpenseTotal),
    actualNetBalance: roundCurrency(actualIncomeTotal - actualExpenseTotal),
    maeExpense: roundCurrency(Math.abs(actualExpenseTotal - predictedExpenseTotal)),
    maeIncome: roundCurrency(Math.abs(actualIncomeTotal - predictedIncomeTotal)),
    mapeExpense: Number(
      actualExpenseTotal > 0
        ? (Math.abs(actualExpenseTotal - predictedExpenseTotal) / actualExpenseTotal * 100).toFixed(2)
        : '0'
    ),
    mapeIncome: Number(
      actualIncomeTotal > 0
        ? (Math.abs(actualIncomeTotal - predictedIncomeTotal) / actualIncomeTotal * 100).toFixed(2)
        : '0'
    ),
  };

  await ForecastBacktest.findOneAndUpdate(
    {
      userId: payload.userId,
      horizonDays,
      evaluationDate: payload.evaluationDate,
    },
    payload,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return payload;
}

function buildForecastNarrative(projectedMonthEndBalance, overspendingProbability, likelyBudgetBreachCategories) {
  if (projectedMonthEndBalance < 0) {
    return 'At this rate, money may finish before month end.';
  }

  if (overspendingProbability >= 0.6) {
    return 'Money is still there, but spending is getting risky this week.';
  }

  if (likelyBudgetBreachCategories.length > 0) {
    return `${likelyBudgetBreachCategories[0].categoryName} is the main place where money is going too much.`;
  }

  return 'Your money flow looks okay for now.';
}

async function generateForecast(userId, options = {}) {
  const horizonDays = Number(options.days) === 7 ? 7 : 30;
  const todayMoment = moment().startOf('day');
  const historyStart = todayMoment.clone().subtract(Math.max(horizonDays * 4, 120), 'days').startOf('day');
  const historyEnd = todayMoment.clone().endOf('day');

  const [transactions, budgets, userProfile] = await Promise.all([
    listNormalizedTransactions(userId, {
      startDate: historyStart.toDate(),
      endDate: historyEnd.toDate(),
      includeTransfers: false,
    }),
    getBudgetRecords(userId),
    getUserProfile(userId),
  ]);

  const context = buildProjectionContext(transactions, todayMoment);
  const horizonProjection = projectRange(context, todayMoment.clone().add(1, 'day').toDate(), horizonDays);
  const projectedIncome = roundCurrency(sum(horizonProjection.map((entry) => entry.projectedIncome)));
  const projectedExpenses = roundCurrency(sum(horizonProjection.map((entry) => entry.projectedExpenses)));

  const monthStart = todayMoment.clone().startOf('month');
  const monthEnd = todayMoment.clone().endOf('month');
  const monthToDateTransactions = splitTransactionsByWindow(
    transactions,
    monthStart.toDate(),
    todayMoment.clone().endOf('day').toDate()
  );
  const monthToDateIncome = roundCurrency(sum(
    monthToDateTransactions.filter((transaction) => transaction.kind === 'income').map((transaction) => transaction.amount)
  ));
  const monthToDateExpenses = roundCurrency(sum(
    monthToDateTransactions.filter((transaction) => transaction.kind === 'expense').map((transaction) => transaction.amount)
  ));

  const daysRemainingInMonth = Math.max(monthEnd.diff(todayMoment, 'days'), 0);
  const monthRemainderProjection = daysRemainingInMonth > 0
    ? projectRange(context, todayMoment.clone().add(1, 'day').toDate(), daysRemainingInMonth)
    : [];
  const projectedIncomeUntilMonthEnd = roundCurrency(sum(
    monthRemainderProjection.map((entry) => entry.projectedIncome)
  ));
  const projectedExpensesUntilMonthEnd = roundCurrency(sum(
    monthRemainderProjection.map((entry) => entry.projectedExpenses)
  ));
  const projectedMonthEndBalance = roundCurrency(
    (monthToDateIncome + projectedIncomeUntilMonthEnd) - (monthToDateExpenses + projectedExpensesUntilMonthEnd)
  );

  const monthlyBudgetLimit = Number(userProfile?.monthlyBudgetLimit || 0);
  const projectedMonthEndExpenses = roundCurrency(monthToDateExpenses + projectedExpensesUntilMonthEnd);
  const overspendingProbability = monthlyBudgetLimit > 0
    ? Number(clamp((projectedMonthEndExpenses / Math.max(monthlyBudgetLimit, 1) - 0.75) / 0.35, 0.05, 0.98).toFixed(2))
    : Number(clamp(projectedMonthEndBalance < 0 ? 0.7 : 0.2, 0.05, 0.9).toFixed(2));

  const {
    categoryForecasts,
    likelyBudgetBreachCategories,
  } = buildCategoryForecasts(
    monthToDateTransactions.filter((transaction) => transaction.kind === 'expense'),
    budgets,
    monthStart,
    todayMoment,
    monthEnd
  );

  const backtest = await buildBacktest(userId, horizonDays, transactions, todayMoment);
  const dataConfidence = transactions.length >= 40 ? 0.88 : transactions.length >= 20 ? 0.74 : 0.58;
  const backtestPenalty = backtest ? clamp((backtest.mapeExpense || 0) / 100, 0, 0.45) : 0.15;
  const confidence = Number(clamp(dataConfidence - (backtestPenalty * 0.5), 0.4, 0.92).toFixed(2));

  return {
    generatedAt: new Date().toISOString(),
    horizonDays,
    currentMonth: {
      income: monthToDateIncome,
      expenses: monthToDateExpenses,
      net: roundCurrency(monthToDateIncome - monthToDateExpenses),
      budgetLimit: monthlyBudgetLimit || null,
      spendingRate: monthlyBudgetLimit > 0
        ? Number(percentage(monthToDateExpenses, monthlyBudgetLimit).toFixed(2))
        : null,
    },
    projectedIncome,
    projectedExpenses,
    projectedNetCashFlow: roundCurrency(projectedIncome - projectedExpenses),
    projectedMonthEndIncome: roundCurrency(monthToDateIncome + projectedIncomeUntilMonthEnd),
    projectedMonthEndExpenses,
    projectedMonthEndBalance,
    overspendingProbability,
    likelyBudgetBreachCategories,
    categoryForecasts,
    dailyForecast: horizonProjection,
    backtest: backtest
      ? {
          horizonDays: backtest.horizonDays,
          maeExpense: backtest.maeExpense,
          maeIncome: backtest.maeIncome,
          mapeExpense: backtest.mapeExpense,
          mapeIncome: backtest.mapeIncome,
        }
      : null,
    headline: buildForecastNarrative(
      projectedMonthEndBalance,
      overspendingProbability,
      likelyBudgetBreachCategories
    ),
    confidence,
  };
}

module.exports = {
  generateForecast,
};
