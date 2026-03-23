const moment = require('moment');
const {
  average,
  buildCategorySummary,
  createDateRange,
  listNormalizedTransactions,
  percentage,
  roundCurrency,
  splitTransactionsByWindow,
  sum,
} = require('./insightHelpers');

function detectRecurringExpenses(expenseTransactions = []) {
  const groups = new Map();

  expenseTransactions.forEach((transaction) => {
    const normalizedDescription = String(transaction.description || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^a-z0-9 ]/g, '')
      .trim()
      .slice(0, 32);

    if (!normalizedDescription) return;

    const key = `${normalizedDescription}-${Math.round(transaction.amount)}`;
    const list = groups.get(key) || [];
    list.push(transaction);
    groups.set(key, list);
  });

  return Array.from(groups.values())
    .filter((transactions) => transactions.length >= 2)
    .map((transactions) => {
      const sorted = [...transactions].sort((left, right) => left.date - right.date);
      const intervals = [];
      for (let index = 1; index < sorted.length; index += 1) {
        intervals.push(moment(sorted[index].date).diff(moment(sorted[index - 1].date), 'days'));
      }

      return {
        description: sorted[0].description,
        categoryName: sorted[0].categoryName,
        averageAmount: roundCurrency(average(sorted.map((transaction) => transaction.amount))),
        occurrences: sorted.length,
        averageInterval: roundCurrency(average(intervals)),
        lastDate: sorted[sorted.length - 1].date,
      };
    });
}

function detectRecurringLeakage(expenseTransactions = []) {
  const groups = new Map();

  expenseTransactions
    .filter((transaction) => Number(transaction.amount || 0) <= 6000)
    .forEach((transaction) => {
      const key = String(transaction.description || transaction.categoryName || 'misc')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 32);

      const bucket = groups.get(key) || [];
      bucket.push(transaction);
      groups.set(key, bucket);
    });

  return Array.from(groups.entries())
    .map(([key, transactions]) => ({
      key,
      description: transactions[0]?.description || transactions[0]?.categoryName || 'Small purchase',
      monthlyLeakage: roundCurrency(sum(transactions.map((transaction) => transaction.amount))),
      frequency: transactions.length,
      averageAmount: roundCurrency(average(transactions.map((transaction) => transaction.amount))),
      categoryName: transactions[0]?.categoryName || 'Other',
    }))
    .filter((entry) => entry.frequency >= 4 && entry.monthlyLeakage >= 3000)
    .sort((left, right) => right.monthlyLeakage - left.monthlyLeakage)
    .slice(0, 5);
}

function classifyPersona({ weekendRatio, postPaydayRatio, leakageCount, anomalyPressure }) {
  if (postPaydayRatio >= 1.35) {
    return {
      label: 'salary_cycle_spender',
      title: 'Payday spender',
      reason: 'You spend more money soon after income enters.',
      confidence: 0.78,
    };
  }

  if (weekendRatio >= 1.3) {
    return {
      label: 'weekend_spender',
      title: 'Weekend spender',
      reason: 'You spend more on weekends than weekdays.',
      confidence: 0.74,
    };
  }

  if (leakageCount >= 3 || anomalyPressure >= 0.5) {
    return {
      label: 'impulsive_spender',
      title: 'Quick spender',
      reason: 'Small small buying and sudden spikes are eating money.',
      confidence: 0.7,
    };
  }

  return {
    label: 'stable_planner',
    title: 'Steady spender',
    reason: 'Your spending looks balanced most of the time.',
    confidence: 0.72,
  };
}

async function analyzeBehaviorPatterns(userId, options = {}) {
  const { startDate, endDate } = createDateRange({ months: options.months || 3 });
  const transactions = await listNormalizedTransactions(userId, {
    startDate,
    endDate,
    includeTransfers: false,
  });

  const expenseTransactions = transactions.filter((transaction) => transaction.kind === 'expense');
  const incomeTransactions = transactions.filter((transaction) => transaction.kind === 'income');

  const weekendExpenses = expenseTransactions.filter((transaction) => {
    const day = moment(transaction.date).day();
    return day === 0 || day === 6;
  });
  const weekdayExpenses = expenseTransactions.filter((transaction) => {
    const day = moment(transaction.date).day();
    return day >= 1 && day <= 5;
  });

  const weekendAverage = average(weekendExpenses.map((transaction) => transaction.amount));
  const weekdayAverage = average(weekdayExpenses.map((transaction) => transaction.amount));
  const weekendRatio = weekdayAverage > 0 ? weekendAverage / weekdayAverage : 0;

  let postPaydaySpend = 0;
  let paydayWindows = 0;
  incomeTransactions.forEach((incomeTransaction) => {
    const windowEnd = moment(incomeTransaction.date).add(3, 'days').endOf('day').toDate();
    const spendInWindow = splitTransactionsByWindow(
      expenseTransactions,
      moment(incomeTransaction.date).startOf('day').toDate(),
      windowEnd
    );

    postPaydaySpend += sum(spendInWindow.map((transaction) => transaction.amount));
    paydayWindows += 1;
  });

  const averagePostPaydaySpend = paydayWindows > 0 ? postPaydaySpend / paydayWindows : 0;
  const averageBaselineSpend = average(expenseTransactions.map((transaction) => transaction.amount)) * 3;
  const postPaydayRatio = averageBaselineSpend > 0
    ? averagePostPaydaySpend / averageBaselineSpend
    : 0;

  const recurringExpenses = detectRecurringExpenses(expenseTransactions);
  const subscriptions = recurringExpenses
    .filter((entry) => entry.averageInterval >= 25 && entry.averageInterval <= 35)
    .slice(0, 5)
    .map((entry) => ({
      description: entry.description,
      monthlyAmount: entry.averageAmount,
      occurrences: entry.occurrences,
      summary: 'This looks like a monthly charge you should check.',
    }));

  const recurringLeakage = detectRecurringLeakage(expenseTransactions);
  const topCategories = buildCategorySummary(expenseTransactions);
  const totalExpense = sum(expenseTransactions.map((transaction) => transaction.amount));
  const highRiskCategories = topCategories.slice(0, 5).map((entry) => ({
    categoryName: entry.categoryName,
    total: roundCurrency(entry.total),
    shareOfSpend: Number(percentage(entry.total, totalExpense).toFixed(2)),
  }));

  const anomalyPressure = clamp((recurringLeakage.length * 0.12) + (weekendRatio > 1.3 ? 0.2 : 0), 0, 1);
  const persona = classifyPersona({
    weekendRatio,
    postPaydayRatio,
    leakageCount: recurringLeakage.length,
    anomalyPressure,
  });

  const nudges = [
    weekendRatio >= 1.2
      ? 'Set a simple weekend limit before Friday so fun spending does not touch important money.'
      : 'Your weekday and weekend spending look balanced. Keep it like that.',
    recurringLeakage.length
      ? `Cut one small repeated spend like ${recurringLeakage[0].description} and save easy money.`
      : 'No strong small small money leak is showing right now.',
    subscriptions.length
      ? `Check ${subscriptions[0].description} and other monthly charges before your next payday.`
      : 'No serious subscription problem is showing right now.',
  ];

  return {
    generatedAt: new Date().toISOString(),
    dataWindow: {
      startDate,
      endDate,
      months: options.months || 3,
    },
    persona,
    paydayPattern: {
      detected: postPaydayRatio >= 1.2,
      postPaydayRatio: Number(postPaydayRatio.toFixed(2)),
      averageThreeDaySpendAfterIncome: roundCurrency(averagePostPaydaySpend),
      summary: postPaydayRatio >= 1.2
        ? 'Spending goes up within three days after money enters.'
        : 'No strong payday rush is showing.',
    },
    weekendVsWeekday: {
      weekendAverage: roundCurrency(weekendAverage),
      weekdayAverage: roundCurrency(weekdayAverage),
      bias: weekendRatio >= 1.1 ? 'weekend_heavy' : weekendRatio <= 0.9 ? 'weekday_heavy' : 'balanced',
      ratio: Number(weekendRatio.toFixed(2)),
      summary: weekendRatio >= 1.2
        ? 'Weekend spending is clearly higher than weekday spending.'
        : 'Weekend and weekday spending look balanced.',
    },
    subscriptionCreep: {
      subscriptionCount: subscriptions.length,
      estimatedMonthlyTotal: roundCurrency(sum(subscriptions.map((entry) => entry.monthlyAmount))),
      items: subscriptions,
      summary: subscriptions.length
        ? 'You have monthly charges that need checking.'
        : 'No strong monthly charge problem is showing now.',
    },
    recurringLeakage: {
      monthlyLeakage: roundCurrency(sum(recurringLeakage.map((entry) => entry.monthlyLeakage))),
      items: recurringLeakage,
      summary: recurringLeakage.length
        ? 'Small repeated spending is joining together and reducing your money.'
        : 'No major small small leak is showing now.',
    },
    highRiskCategories,
    nudges,
    confidence: Number((expenseTransactions.length >= 20 ? 0.82 : 0.62).toFixed(2)),
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

module.exports = {
  analyzeBehaviorPatterns,
};
