const mongoose = require('mongoose');

const Category = require('../../src/models/Category');
const {
  getOrCreateUncategorizedCategory,
  suggestCategoryForRow,
} = require('../../src/services/statementCategory.service');

describe('statementCategory.service', () => {
  const userId = new mongoose.Types.ObjectId();

  beforeEach(async () => {
    await Category.create([
      { userId, name: 'Food & Dining', type: 'expense', source: 'system' },
      { userId, name: 'Salary', type: 'income', source: 'system' },
    ]);
  });

  it('matches known keywords to an existing category', async () => {
    const suggestion = await suggestCategoryForRow({
      userId,
      classification: 'expense',
      description: 'Foodco meal payment',
      transactionType: 'Transfer',
    });

    expect(String(suggestion.categoryId)).toBeTruthy();
    expect(suggestion.suggestedCategoryName).toBe('Food & Dining');
    expect(suggestion.usedFallback).toBe(false);
  });

  it('creates uncategorized fallback categories per type when needed', async () => {
    const uncategorizedIncome = await getOrCreateUncategorizedCategory(userId, 'income');
    const uncategorizedExpense = await getOrCreateUncategorizedCategory(userId, 'expense');

    expect(uncategorizedIncome.name).toBe('Uncategorized Income');
    expect(uncategorizedExpense.name).toBe('Uncategorized Expense');

    const categories = await Category.find({ userId, name: /Uncategorized/ });
    expect(categories).toHaveLength(2);
  });
});
