const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const insightsRoutes = require('../../src/routes/insights.routes');
const User = require('../../src/models/User');
const Category = require('../../src/models/Category');
const Expense = require('../../src/models/Expense');
const Income = require('../../src/models/Income');
const Budget = require('../../src/models/Budget');
const InsightSession = require('../../src/models/InsightSession');
const InsightFeedback = require('../../src/models/InsightFeedback');
const ForecastBacktest = require('../../src/models/ForecastBacktest');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/insights', insightsRoutes);
  return app;
}

async function seedInsightData(userId) {
  const expenseCategories = await Category.create([
    { userId, name: 'Food & Dining', type: 'expense', color: '#ef4444' },
    { userId, name: 'Transportation', type: 'expense', color: '#f59e0b' },
    { userId, name: 'Entertainment', type: 'expense', color: '#3b82f6' },
    { userId, name: 'Utilities', type: 'expense', color: '#8b5cf6' },
    { userId, name: 'Shopping', type: 'expense', color: '#14b8a6' },
  ]);
  const incomeCategory = await Category.create({
    userId,
    name: 'Salary',
    type: 'income',
    color: '#10b981',
  });

  const foodCategory = expenseCategories[0];
  const transportCategory = expenseCategories[1];
  const entertainmentCategory = expenseCategories[2];
  const utilitiesCategory = expenseCategories[3];
  const shoppingCategory = expenseCategories[4];

  const expenses = [];
  const income = [];
  const today = new Date();

  for (let offset = 0; offset < 75; offset += 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    const day = date.getDay();

    expenses.push({
      userId,
      categoryId: foodCategory._id,
      externalId: `expense-food-${offset}`,
      amount: day === 0 || day === 6 ? 5200 : 2800,
      description: day === 0 || day === 6 ? 'Weekend groceries and eating out' : 'Lunch and groceries',
      date,
      paymentMethod: 'card',
    });

    expenses.push({
      userId,
      categoryId: transportCategory._id,
      externalId: `expense-transport-${offset}`,
      amount: 1800 + (offset % 4) * 250,
      description: 'Transport fare',
      date,
      paymentMethod: 'bank_transfer',
    });

    if (day === 5 || day === 6) {
      expenses.push({
        userId,
        categoryId: entertainmentCategory._id,
        externalId: `expense-entertainment-${offset}`,
        amount: 6500,
        description: 'Cinema and hangout',
        date,
        paymentMethod: 'card',
      });
    }

    if (offset % 10 === 0) {
      expenses.push({
        userId,
        categoryId: utilitiesCategory._id,
        externalId: `expense-utilities-${offset}`,
        amount: 4200,
        description: 'Utility bill payment',
        date,
        paymentMethod: 'bank_transfer',
      });
    }

    if (offset % 9 === 0) {
      expenses.push({
        userId,
        categoryId: shoppingCategory._id,
        externalId: `expense-shopping-${offset}`,
        amount: 3600,
        description: 'Shopping run',
        date,
        paymentMethod: 'card',
      });
    }

    if (offset % 14 === 0) {
      income.push({
        userId,
        categoryId: incomeCategory._id,
        externalId: `income-salary-${offset}`,
        amount: 120000,
        source: 'Salary payment',
        description: 'Monthly salary',
        date,
      });
    }
  }

  expenses.push({
    userId,
    categoryId: entertainmentCategory._id,
    externalId: 'expense-anomaly-today',
    amount: 48000,
    description: 'Large electronics purchase',
    date: new Date(),
    paymentMethod: 'card',
  });

  await Expense.insertMany(expenses);
  await Income.insertMany(income);

  await Budget.create([
    {
      userId,
      category: 'Food & Dining',
      amount: 45000,
      period: 'monthly',
      isActive: true,
    },
    {
      userId,
      category: 'Transportation',
      amount: 22000,
      period: 'monthly',
      isActive: true,
    },
    {
      userId,
      category: 'Utilities',
      amount: 15000,
      period: 'monthly',
      isActive: true,
    },
  ]);
}

describe('Insights routes', () => {
  let app;
  let authHeader;
  let user;

  beforeEach(async () => {
    app = createApp();

    user = await User.create({
      name: 'Insight Tester',
      email: 'insight@example.com',
      password: 'SecurePass123!',
      isVerified: true,
      monthlyBudgetLimit: 150000,
      onboardingCompleted: true,
      onboardingStatus: 'completed',
    });

    authHeader = `Bearer ${jwt.sign({ userId: String(user._id), tokenVersion: user.tokenVersion || 0 }, process.env.JWT_SECRET)}`;
    await seedInsightData(user._id);
  });

  it('returns the intelligence hub payload', async () => {
    const response = await request(app)
      .get('/api/v1/insights/hub')
      .set('Authorization', authHeader)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.summary.headline).toBeTruthy();
    expect(response.body.data.healthScore.overallScore).toBeGreaterThan(0);
    expect(response.body.data.subScores).toHaveLength(5);
    expect(Array.isArray(response.body.data.evidence)).toBe(true);
    expect(response.body.data.forecast.projectedMonthEndBalance).toBeDefined();
    expect(response.body.data.visuals.mainUpdate.message).toBeTruthy();
    expect(Array.isArray(response.body.data.visuals.spendingBreakdown.categories)).toBe(true);
    expect(response.body.data.textView.mainUpdate.title).toBe('Main Money Update');
    expect(response.body.data.textView.askSefa.prompts.length).toBeGreaterThan(0);
    expect(response.body.data.visuals.spendingBreakdown.categories.some((entry) => entry.categoryName === 'Other')).toBe(true);
    expect(response.body.data.visuals.budgetUsage.every((entry) => typeof entry.color === 'string')).toBe(true);
  });

  it('returns the health score and forecast endpoints', async () => {
    const [healthResponse, forecastResponse] = await Promise.all([
      request(app)
        .get('/api/v1/insights/health-score')
        .set('Authorization', authHeader),
      request(app)
        .get('/api/v1/insights/forecast?days=7')
        .set('Authorization', authHeader),
    ]);

    expect(healthResponse.status).toBe(200);
    expect(healthResponse.body.data.subScores).toHaveLength(5);
    expect(forecastResponse.status).toBe(200);
    expect(forecastResponse.body.data.horizonDays).toBe(7);
    expect(forecastResponse.body.data.backtest).not.toBeNull();
  });

  it('answers grounded copilot questions and stores the session', async () => {
    const response = await request(app)
      .post('/api/v1/insights/chat')
      .set('Authorization', authHeader)
      .send({ question: 'Can I survive till month end?' })
      .expect(200);

    expect(response.body.data.answer).toContain('month end');
    expect(response.body.data.evidenceCards.length).toBeGreaterThan(0);
    expect(response.body.data.sessionId).toBeTruthy();

    const storedSession = await InsightSession.findById(response.body.data.sessionId);
    expect(storedSession).not.toBeNull();
    expect(storedSession.normalizedIntent).toBe('forecast_survival');
  });

  it('runs what-if analysis and records feedback', async () => {
    const chat = await request(app)
      .post('/api/v1/insights/chat')
      .set('Authorization', authHeader)
      .send({ question: 'How can I save N20000 this month?' })
      .expect(200);

    const scenario = await request(app)
      .post('/api/v1/insights/what-if')
      .set('Authorization', authHeader)
      .send({ categoryName: 'Food & Dining', reductionPercent: 15, days: 30 })
      .expect(200);

    expect(scenario.body.data.delta.projectedMonthEndBalance).not.toBe(0);

    const feedback = await request(app)
      .post('/api/v1/insights/feedback')
      .set('Authorization', authHeader)
      .send({
        sessionId: chat.body.data.sessionId,
        insightKey: 'copilot-response',
        insightType: 'copilot_chat',
        rating: 'helpful',
      })
      .expect(201);

    expect(feedback.body.success).toBe(true);

    const storedFeedback = await InsightFeedback.findOne({ sessionId: chat.body.data.sessionId });
    expect(storedFeedback).not.toBeNull();
  });

  it('creates forecast backtest records while generating hub data', async () => {
    await request(app)
      .get('/api/v1/insights/hub')
      .set('Authorization', authHeader)
      .expect(200);

    const backtest = await ForecastBacktest.findOne({ userId: user._id });
    expect(backtest).not.toBeNull();
    expect(backtest.horizonDays).toBe(30);
  });

  it('returns friendly visual and text fallbacks when the user has no transaction data', async () => {
    const emptyUser = await User.create({
      name: 'Fresh User',
      email: 'fresh-insight@example.com',
      password: 'SecurePass123!',
      isVerified: true,
      monthlyBudgetLimit: 50000,
      onboardingCompleted: true,
      onboardingStatus: 'completed',
    });
    const emptyAuthHeader = `Bearer ${jwt.sign({ userId: String(emptyUser._id), tokenVersion: emptyUser.tokenVersion || 0 }, process.env.JWT_SECRET)}`;

    const response = await request(app)
      .get('/api/v1/insights/hub')
      .set('Authorization', emptyAuthHeader)
      .expect(200);

    expect(response.body.data.visuals.spendingBreakdown.categories).toHaveLength(0);
    expect(response.body.data.visuals.spendingTrend.actualSeries).toEqual(expect.any(Array));
    expect(response.body.data.textView.whereMoneyGoes.lines[0]).toContain('No spending record');
    expect(response.body.data.textView.askSefa.prompts.length).toBeGreaterThan(0);
  });
});
