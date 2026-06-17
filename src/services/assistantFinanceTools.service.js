const mongoose = require('mongoose');

const Category = require('../models/Category');
const Expense = require('../models/Expense');
const Income = require('../models/Income');
const User = require('../models/User');

const DEFAULT_EXPENSE_ICON = 'folder';
const DEFAULT_INCOME_ICON = 'cash';
const DEFAULT_EXPENSE_COLOR = '#EF4444';
const DEFAULT_INCOME_COLOR = '#10B981';

const startOfDay = (date) => {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
};

const endOfDay = (date) => {
  const value = new Date(date);
  value.setHours(23, 59, 59, 999);
  return value;
};

const createDateRange = (period = 'month') => {
  const now = new Date();

  if (period === 'today') {
    return { startDate: startOfDay(now), endDate: endOfDay(now), label: 'today' };
  }

  if (period === 'week') {
    const start = startOfDay(now);
    start.setDate(now.getDate() - 6);
    return { startDate: start, endDate: endOfDay(now), label: 'the last 7 days' };
  }

  if (period === 'year') {
    return {
      startDate: new Date(now.getFullYear(), 0, 1),
      endDate: endOfDay(now),
      label: 'this year',
    };
  }

  return {
    startDate: new Date(now.getFullYear(), now.getMonth(), 1),
    endDate: endOfDay(now),
    label: 'this month',
  };
};

const formatCurrency = (amount) => `₦${Number(amount || 0).toLocaleString('en-NG')}`;

const normalizeName = (value = '') => String(value || '').trim().replace(/\s+/g, ' ');

const validateAmount = (amount) => {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('Amount must be greater than 0');
  }
  return numeric;
};

const validateDate = (date) => {
  const parsed = date ? new Date(date) : new Date();
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Date is invalid');
  }
  return parsed;
};

const getCategories = async (userId, type = null) => {
  const query = { userId, isActive: true };
  if (type) query.type = type;
  return Category.find(query).sort({ source: 1, name: 1 });
};

const findCategoryByName = async (userId, name, type) => {
  const safeName = normalizeName(name);
  if (!safeName) return null;

  return Category.findOne({
    userId,
    type,
    isActive: true,
    name: new RegExp(`^${safeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
  });
};

const getOrCreateCategory = async (userId, name, type) => {
  const safeName = normalizeName(name || (type === 'income' ? 'Income' : 'Other'));
  let category = await findCategoryByName(userId, safeName, type);
  if (category) return category;

  category = await Category.create({
    userId,
    name: safeName,
    type,
    icon: type === 'income' ? DEFAULT_INCOME_ICON : DEFAULT_EXPENSE_ICON,
    color: type === 'income' ? DEFAULT_INCOME_COLOR : DEFAULT_EXPENSE_COLOR,
    source: 'user',
    isActive: true,
  });

  return category;
};

const createCategory = async (userId, payload = {}) => {
  const name = normalizeName(payload.name);
  const type = payload.type;

  if (!name) throw new Error('Category name is required');
  if (!['income', 'expense'].includes(type)) {
    throw new Error('Category type must be income or expense');
  }

  const existing = await Category.findOne({
    userId,
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    type,
    isActive: true,
  });
  if (existing) {
    throw new Error(`${name} already exists as a ${type} category`);
  }

  return Category.create({
    userId,
    name,
    type,
    icon: payload.icon || (type === 'income' ? DEFAULT_INCOME_ICON : DEFAULT_EXPENSE_ICON),
    color: payload.color || (type === 'income' ? DEFAULT_INCOME_COLOR : DEFAULT_EXPENSE_COLOR),
    source: 'user',
    isActive: true,
  });
};

const createExpense = async (userId, payload = {}) => {
  const amount = validateAmount(payload.amount);
  const date = validateDate(payload.date);
  const category = await getOrCreateCategory(userId, payload.categoryName || payload.description, 'expense');

  const expense = await Expense.create({
    userId,
    categoryId: category._id,
    amount,
    description: normalizeName(payload.description || category.name),
    date,
    paymentMethod: payload.paymentMethod || 'cash',
    synced: true,
  });
  await expense.populate('categoryId', 'name icon color type');
  return expense;
};

const createIncome = async (userId, payload = {}) => {
  const amount = validateAmount(payload.amount);
  const date = validateDate(payload.date);
  const source = normalizeName(payload.source || payload.categoryName || payload.description);
  if (!source) throw new Error('Income source is required');
  const category = await getOrCreateCategory(userId, payload.categoryName || source, 'income');

  const income = await Income.create({
    userId,
    categoryId: category._id,
    amount,
    source,
    description: normalizeName(payload.description || source),
    date,
    paymentMethod: payload.paymentMethod || 'bank_transfer',
    synced: true,
  });
  await income.populate('categoryId', 'name icon color type');
  return income;
};

const getFinancialSummary = async (userId, period = 'month') => {
  const range = createDateRange(period);
  const [expenseTotal, incomeTotal] = await Promise.all([
    Expense.getTotalByDateRange(userId, range.startDate, range.endDate),
    Income.getTotalByDateRange(userId, range.startDate, range.endDate),
  ]);

  return {
    ...range,
    expenseTotal: Number(expenseTotal.total || 0),
    expenseCount: Number(expenseTotal.count || 0),
    incomeTotal: Number(incomeTotal.total || 0),
    incomeCount: Number(incomeTotal.count || 0),
    net: Number(incomeTotal.total || 0) - Number(expenseTotal.total || 0),
  };
};

const getCategorySpending = async (userId, categoryName, period = 'month') => {
  const range = createDateRange(period);
  const category = await findCategoryByName(userId, categoryName, 'expense');
  if (!category) {
    return {
      ...range,
      categoryName: normalizeName(categoryName),
      total: 0,
      count: 0,
      categoryFound: false,
    };
  }

  const result = await Expense.aggregate([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId),
        categoryId: category._id,
        date: { $gte: range.startDate, $lte: range.endDate },
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);

  return {
    ...range,
    categoryName: category.name,
    total: Number(result[0]?.total || 0),
    count: Number(result[0]?.count || 0),
    categoryFound: true,
  };
};

const getSpendingDrivers = async (userId, period = 'month') => {
  const range = createDateRange(period);
  const categories = await Expense.getByCategory(userId, range.startDate, range.endDate);
  const topCategories = categories.slice(0, 5).map((entry) => ({
    categoryName: entry.categoryName,
    amount: Number(entry.total || 0),
    count: Number(entry.count || 0),
  }));

  return {
    ...range,
    topCategories,
    total: topCategories.reduce((sum, entry) => sum + entry.amount, 0),
  };
};

const getBudgetHealth = async (userId, period = 'month') => {
  const user = await User.findById(userId).select('preferences monthlyBudgetLimit budget monthlyBudget');
  const summary = await getFinancialSummary(userId, period);
  const limit = Number(
    user?.preferences?.monthlyBudgetLimit
      || user?.monthlyBudgetLimit
      || user?.budget?.monthlyLimit
      || user?.monthlyBudget
      || 0,
  );

  return {
    ...summary,
    budgetLimit: limit > 0 ? limit : null,
    percentageUsed: limit > 0 ? Math.round((summary.expenseTotal / limit) * 100) : null,
    remaining: limit > 0 ? limit - summary.expenseTotal : null,
  };
};

module.exports = {
  createCategory,
  createExpense,
  createIncome,
  formatCurrency,
  getBudgetHealth,
  getCategories,
  getCategorySpending,
  getFinancialSummary,
  getSpendingDrivers,
};
