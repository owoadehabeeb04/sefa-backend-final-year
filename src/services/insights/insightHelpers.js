const mongoose = require('mongoose');
const moment = require('moment');
const Expense = require('../../models/Expense');
const Income = require('../../models/Income');
const Budget = require('../../models/Budget');
const User = require('../../models/User');

const roundCurrency = (value) => Math.round(Number(value || 0));

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const percentage = (value, total) => {
  if (!total) return 0;
  return (Number(value || 0) / Number(total || 0)) * 100;
};

const average = (values = []) => {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
};

const sum = (values = []) => values.reduce((total, value) => total + Number(value || 0), 0);

const standardDeviation = (values = []) => {
  if (values.length < 2) return 0;
  const mean = average(values);
  const variance = average(values.map((value) => Math.pow(value - mean, 2)));
  return Math.sqrt(variance);
};

const toObjectId = (value) => {
  if (!value) return value;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (mongoose.Types.ObjectId.isValid(value)) {
    return new mongoose.Types.ObjectId(String(value));
  }
  return value;
};

const createDateRange = ({ months, days, startDate, endDate } = {}) => {
  const end = endDate ? moment(endDate).endOf('day') : moment().endOf('day');
  let start = startDate ? moment(startDate).startOf('day') : null;

  if (!start && Number.isFinite(months)) {
    start = moment(end).subtract(months, 'months').startOf('day');
  }

  if (!start && Number.isFinite(days)) {
    start = moment(end).subtract(days - 1, 'days').startOf('day');
  }

  if (!start) {
    start = moment(end).subtract(89, 'days').startOf('day');
  }

  return {
    startDate: start.toDate(),
    endDate: end.toDate(),
  };
};

async function listNormalizedTransactions(userId, options = {}) {
  const { startDate, endDate, includeTransfers = false } = options;
  const normalizedUserId = toObjectId(userId);

  const dateQuery = {};
  if (startDate) dateQuery.$gte = new Date(startDate);
  if (endDate) dateQuery.$lte = new Date(endDate);

  const query = {
    userId: normalizedUserId,
    ...(Object.keys(dateQuery).length ? { date: dateQuery } : {}),
    ...(includeTransfers ? {} : { isTransfer: { $ne: true } }),
  };

  const [expenses, income] = await Promise.all([
    Expense.find(query)
      .populate('categoryId', 'name type color icon')
      .select('amount description date categoryId isTransfer source createdAt')
      .lean(),
    Income.find(query)
      .populate('categoryId', 'name type color icon')
      .select('amount description source date categoryId isTransfer createdAt')
      .lean(),
  ]);

  const mappedExpenses = expenses.map((expense) => ({
    id: String(expense._id),
    kind: 'expense',
    direction: 'debit',
    amount: Number(expense.amount || 0),
    description: expense.description || expense.categoryId?.name || 'Expense',
    date: new Date(expense.date),
    categoryId: expense.categoryId?._id ? String(expense.categoryId._id) : null,
    categoryName: expense.categoryId?.name || 'Uncategorized Expense',
    categoryColor: expense.categoryId?.color || null,
    categoryIcon: expense.categoryId?.icon || null,
    isTransfer: Boolean(expense.isTransfer),
    sourceLabel: expense.description || expense.categoryId?.name || 'Expense',
    createdAt: expense.createdAt ? new Date(expense.createdAt) : new Date(expense.date),
  }));

  const mappedIncome = income.map((entry) => ({
    id: String(entry._id),
    kind: 'income',
    direction: 'credit',
    amount: Number(entry.amount || 0),
    description: entry.description || entry.source || entry.categoryId?.name || 'Income',
    date: new Date(entry.date),
    categoryId: entry.categoryId?._id ? String(entry.categoryId._id) : null,
    categoryName: entry.categoryId?.name || entry.source || 'Uncategorized Income',
    categoryColor: entry.categoryId?.color || null,
    categoryIcon: entry.categoryId?.icon || null,
    isTransfer: Boolean(entry.isTransfer),
    sourceLabel: entry.source || entry.description || entry.categoryId?.name || 'Income',
    createdAt: entry.createdAt ? new Date(entry.createdAt) : new Date(entry.date),
  }));

  return [...mappedExpenses, ...mappedIncome].sort((left, right) => right.date - left.date);
}

async function getBudgetRecords(userId) {
  return Budget.find({ userId: toObjectId(userId), isActive: true })
    .select('category amount period startDate endDate warningThreshold criticalThreshold')
    .lean();
}

async function getUserProfile(userId) {
  return User.findById(toObjectId(userId))
    .select('name currency monthlyBudgetLimit financialProfile')
    .lean();
}

const normalizeCategoryName = (value) => String(value || '').trim().toLowerCase();

function buildCategorySummary(transactions = []) {
  const categories = new Map();

  transactions
    .filter((transaction) => transaction.kind === 'expense')
    .forEach((transaction) => {
      const key = normalizeCategoryName(transaction.categoryName) || 'uncategorized';
      const current = categories.get(key) || {
        categoryName: transaction.categoryName || 'Uncategorized Expense',
        total: 0,
        count: 0,
        lastDate: transaction.date,
      };

      current.total += Number(transaction.amount || 0);
      current.count += 1;
      if (!current.lastDate || transaction.date > current.lastDate) {
        current.lastDate = transaction.date;
      }

      categories.set(key, current);
    });

  return Array.from(categories.values()).sort((left, right) => right.total - left.total);
}

function buildDailySeries(transactions = [], startDate, endDate) {
  const start = moment(startDate).startOf('day');
  const end = moment(endDate).startOf('day');
  const buckets = new Map();

  transactions.forEach((transaction) => {
    const key = moment(transaction.date).format('YYYY-MM-DD');
    const bucket = buckets.get(key) || {
      date: key,
      income: 0,
      expenses: 0,
    };

    if (transaction.kind === 'income') bucket.income += Number(transaction.amount || 0);
    if (transaction.kind === 'expense') bucket.expenses += Number(transaction.amount || 0);
    buckets.set(key, bucket);
  });

  const series = [];
  const cursor = moment(start);
  while (cursor.isSameOrBefore(end, 'day')) {
    const key = cursor.format('YYYY-MM-DD');
    const bucket = buckets.get(key) || {
      date: key,
      income: 0,
      expenses: 0,
    };

    series.push({
      date: key,
      income: roundCurrency(bucket.income),
      expenses: roundCurrency(bucket.expenses),
      net: roundCurrency(bucket.income - bucket.expenses),
    });

    cursor.add(1, 'day');
  }

  return series;
}

function splitTransactionsByWindow(transactions = [], startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);

  return transactions.filter((transaction) => {
    const date = new Date(transaction.date);
    return date >= start && date <= end;
  });
}

module.exports = {
  average,
  buildCategorySummary,
  buildDailySeries,
  clamp,
  createDateRange,
  getBudgetRecords,
  getUserProfile,
  listNormalizedTransactions,
  normalizeCategoryName,
  percentage,
  roundCurrency,
  splitTransactionsByWindow,
  standardDeviation,
  sum,
  toObjectId,
};
