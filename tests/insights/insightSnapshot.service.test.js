const mongoose = require('mongoose');
const User = require('../../src/models/User');
const Category = require('../../src/models/Category');
const Expense = require('../../src/models/Expense');
const Income = require('../../src/models/Income');
const Budget = require('../../src/models/Budget');
const MonthlyInsightSnapshot = require('../../src/models/MonthlyInsightSnapshot');
const insightSnapshotService = require('../../src/services/insights/insightSnapshot.service');
const { resolvePeriod } = require('../../src/services/insights/financialDashboard.service');

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function seedUser() {
  const user = await User.create({
    name: 'Snapshot Tester',
    email: `snapshot-${Date.now()}@example.com`,
    password: 'Password123!',
    isVerified: true,
    onboardingCompleted: true,
  });

  const foodCat = await Category.create({ userId: user._id, name: 'Food & Dining', type: 'expense', color: '#ef4444' });
  const salaryCat = await Category.create({ userId: user._id, name: 'Salary', type: 'income', color: '#10b981' });

  const now = new Date();
  await Income.create({ userId: user._id, categoryId: salaryCat._id, amount: 150000, source: 'Salary', date: now });
  await Expense.create({ userId: user._id, categoryId: foodCat._id, amount: 40000, description: 'Groceries', date: now });

  return { user, foodCat };
}

describe('insightSnapshot.service - caching', () => {
  it('builds and persists a snapshot on first request', async () => {
    const { user } = await seedUser();
    const dashboard = await insightSnapshotService.getDashboard(user._id);

    expect(dashboard.snapshot.totalIncome).toBe(150000);
    expect(dashboard.snapshot.totalExpenses).toBe(40000);
    expect(dashboard.snapshot.balance).toBe(110000);
    expect(dashboard.hasData).toBe(true);
    expect(dashboard.fromCache).toBe(false);

    const stored = await MonthlyInsightSnapshot.findOne({ userId: user._id });
    expect(stored).not.toBeNull();
    expect(stored.stale).toBe(false);
  });

  it('serves the second request from cache', async () => {
    const { user } = await seedUser();
    await insightSnapshotService.getDashboard(user._id);
    const second = await insightSnapshotService.getDashboard(user._id);
    expect(second.fromCache).toBe(true);
  });

  it('recalculates when forceRefresh is set', async () => {
    const { user } = await seedUser();
    await insightSnapshotService.getDashboard(user._id);
    const refreshed = await insightSnapshotService.getDashboard(user._id, { forceRefresh: true });
    expect(refreshed.fromCache).toBe(false);
  });

  it('returns a no-data dashboard for a user with no transactions', async () => {
    const user = await User.create({
      name: 'Empty User',
      email: `empty-${Date.now()}@example.com`,
      password: 'Password123!',
      isVerified: true,
      onboardingCompleted: true,
    });
    const dashboard = await insightSnapshotService.getDashboard(user._id);
    expect(dashboard.hasData).toBe(false);
    expect(dashboard.snapshot.totalExpenses).toBe(0);
    expect(dashboard.categoryBreakdown).toEqual([]);
  });
});

describe('insightSnapshot.service - cache invalidation (staleness)', () => {
  it('marks the snapshot stale when a new expense is created', async () => {
    const { user, foodCat } = await seedUser();
    await insightSnapshotService.getDashboard(user._id); // warm cache

    let stored = await MonthlyInsightSnapshot.findOne({ userId: user._id });
    expect(stored.stale).toBe(false);

    // Creating an expense should trigger the invalidation plugin hook.
    await Expense.create({ userId: user._id, categoryId: foodCat._id, amount: 9999, description: 'Snack', date: new Date() });
    await flush();

    stored = await MonthlyInsightSnapshot.findOne({ userId: user._id });
    expect(stored.stale).toBe(true);
  });

  it('recomputes fresh numbers after staleness', async () => {
    const { user, foodCat } = await seedUser();
    await insightSnapshotService.getDashboard(user._id);

    await Expense.create({ userId: user._id, categoryId: foodCat._id, amount: 10000, description: 'More food', date: new Date() });
    await flush();

    const dashboard = await insightSnapshotService.getDashboard(user._id);
    expect(dashboard.fromCache).toBe(false);
    expect(dashboard.snapshot.totalExpenses).toBe(50000); // 40000 + 10000
  });

  it('invalidateUser marks snapshots stale directly', async () => {
    const { user } = await seedUser();
    await insightSnapshotService.getDashboard(user._id);

    await insightSnapshotService.invalidateUser(user._id);
    const stored = await MonthlyInsightSnapshot.findOne({ userId: user._id });
    expect(stored.stale).toBe(true);
  });

  it('persists an AI summary onto the snapshot without recomputing', async () => {
    const { user } = await seedUser();
    const period = resolvePeriod();
    await insightSnapshotService.getDashboard(user._id);

    await insightSnapshotService.saveAiSummary(user._id, period.periodKey, {
      shortSummary: 'Test summary',
      detailedExplanation: 'Detail',
      actions: ['Do this'],
      model: 'fallback',
    });

    const stored = await MonthlyInsightSnapshot.findOne({ userId: user._id, periodKey: period.periodKey });
    expect(stored.aiSummary.shortSummary).toBe('Test summary');
    // Snapshot stays fresh (only AI was written).
    expect(stored.stale).toBe(false);
  });
});
