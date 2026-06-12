const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const mongoose = require('mongoose');

const User = require('../src/models/User');
const Category = require('../src/models/Category');
const Expense = require('../src/models/Expense');
const Income = require('../src/models/Income');
const Notification = require('../src/models/Notification');
const BankConnection = require('../src/models/BankConnection');
const StatementImport = require('../src/models/StatementImport');
const StatementImportRow = require('../src/models/StatementImportRow');
const AssistantChat = require('../src/models/AssistantChat');
const AssistantMessage = require('../src/models/AssistantMessage');

const DEMO_USER_EMAIL = 'chapter4.demo@sefa.app';
const DEMO_USER_PASSWORD = 'Password123!';
const DEMO_USER_NAME = 'Chapter Four Demo';

const IDS = {
  reviewingImport: new mongoose.Types.ObjectId('661000000000000000000101'),
  importedImport: new mongoose.Types.ObjectId('661000000000000000000102'),
  primaryChat: new mongoose.Types.ObjectId('661000000000000000000201'),
  archivedChat: new mongoose.Types.ObjectId('661000000000000000000202'),
  failedChat: new mongoose.Types.ObjectId('661000000000000000000203'),
};

const categorySpecs = [
  { key: 'food', name: 'Food & Dining', type: 'expense', icon: 'restaurant', color: '#16A34A', source: 'system' },
  { key: 'transport', name: 'Transport', type: 'expense', icon: 'car', color: '#2563EB', source: 'system' },
  { key: 'utilities', name: 'Utilities', type: 'expense', icon: 'flash', color: '#F59E0B', source: 'system' },
  { key: 'shopping', name: 'Shopping', type: 'expense', icon: 'cart', color: '#DB2777', source: 'system' },
  { key: 'rent', name: 'Rent', type: 'expense', icon: 'home', color: '#7C3AED', source: 'system' },
  { key: 'health', name: 'Health', type: 'expense', icon: 'medical', color: '#DC2626', source: 'user' },
  { key: 'salary', name: 'Salary', type: 'income', icon: 'cash', color: '#16A34A', source: 'system' },
  { key: 'freelance', name: 'Freelance', type: 'income', icon: 'briefcase', color: '#0891B2', source: 'user' },
  { key: 'gift', name: 'Gift', type: 'income', icon: 'gift', color: '#D97706', source: 'system' },
];

const daysAgo = (count) => {
  const now = new Date();
  now.setDate(now.getDate() - count);
  now.setHours(10, 15, 0, 0);
  return now;
};

const expensesSeed = (categoryIds) => [
  { categoryId: categoryIds.rent, amount: 120000, description: 'Monthly apartment rent', date: daysAgo(25), paymentMethod: 'bank_transfer', location: 'Yaba, Lagos' },
  { categoryId: categoryIds.food, amount: 8500, description: 'Groceries and fresh produce', date: daysAgo(6), paymentMethod: 'card', location: 'Shoprite' },
  { categoryId: categoryIds.transport, amount: 4200, description: 'Fuel top-up', date: daysAgo(5), paymentMethod: 'card', location: 'Mobil Station' },
  { categoryId: categoryIds.utilities, amount: 15000, description: 'Electricity token recharge', date: daysAgo(4), paymentMethod: 'bank_transfer', location: 'Ikeja Electric' },
  { categoryId: categoryIds.shopping, amount: 18500, description: 'Office chair and desk lamp', date: daysAgo(3), paymentMethod: 'card', location: 'Computer Village' },
  { categoryId: categoryIds.health, amount: 9200, description: 'Pharmacy and clinic visit', date: daysAgo(2), paymentMethod: 'cash', location: 'HealthPlus' },
  { categoryId: categoryIds.food, amount: 6400, description: 'Lunch meeting', date: daysAgo(2), paymentMethod: 'card', location: 'Lekki Phase 1' },
  { categoryId: categoryIds.transport, amount: 2500, description: 'Ride to client office', date: daysAgo(1), paymentMethod: 'mobile_money', location: 'Victoria Island' },
  { categoryId: categoryIds.food, amount: 3800, description: 'Breakfast and coffee', date: daysAgo(0), paymentMethod: 'cash', location: 'SEFA Cafe' },
];

const incomesSeed = (categoryIds) => [
  { categoryId: categoryIds.salary, amount: 320000, source: 'Monthly Salary', description: 'April salary payment', date: daysAgo(18), paymentMethod: 'bank_transfer' },
  { categoryId: categoryIds.freelance, amount: 85000, source: 'Freelance Design Project', description: 'Mobile app UI contract', date: daysAgo(7), paymentMethod: 'bank_transfer' },
  { categoryId: categoryIds.gift, amount: 30000, source: 'Family Support', description: 'Weekend support gift', date: daysAgo(1), paymentMethod: 'bank_transfer' },
];

const notificationsSeed = (userId, transactions) => [
  {
    userId,
    type: 'budget_warning',
    title: 'Budget watch: Food & Dining',
    message: 'You have used 78% of your monthly food budget.',
    icon: 'warning',
    urgency: 'daily',
    amount: 18700,
    category: 'Food & Dining',
    aiAdvice: 'Consider reducing restaurant spending this week to stay within your target.',
    isRead: false,
    deliveryStatus: 'delivered',
    isSent: true,
    sentAt: daysAgo(0),
  },
  {
    userId,
    type: 'spending_insight',
    title: 'Transport spending increased',
    message: 'Transport costs are higher than last week.',
    icon: 'money',
    urgency: 'weekly',
    amount: 6700,
    category: 'Transport',
    aiAdvice: 'Grouping errands into fewer trips could lower your transport costs.',
    isRead: true,
    readAt: daysAgo(1),
    deliveryStatus: 'delivered',
    isSent: true,
    sentAt: daysAgo(1),
  },
  {
    userId,
    type: 'transaction_alert',
    title: 'Large transaction recorded',
    message: 'Your rent payment was recorded successfully.',
    icon: 'success',
    urgency: 'instant',
    transactionId: transactions.expenses[0]._id,
    transactionType: 'expense',
    amount: 120000,
    category: 'Rent',
    isRead: false,
    deliveryStatus: 'delivered',
    isSent: true,
    sentAt: daysAgo(2),
  },
];

const createAssistantMessages = (userId) => {
  const primaryUserMessageId = new mongoose.Types.ObjectId('661000000000000000000211');
  const primaryAssistantMessageId = new mongoose.Types.ObjectId('661000000000000000000212');
  const archivedUserMessageId = new mongoose.Types.ObjectId('661000000000000000000221');
  const archivedAssistantMessageId = new mongoose.Types.ObjectId('661000000000000000000222');
  const failedUserMessageId = new mongoose.Types.ObjectId('661000000000000000000231');
  const failedAssistantMessageId = new mongoose.Types.ObjectId('661000000000000000000232');

  return {
    chats: [
      {
        _id: IDS.primaryChat,
        userId,
        title: 'How can I reduce my food spending?',
        titleSource: 'auto',
        status: 'idle',
        lastMessageAt: daysAgo(0),
        lastVisibleMessageId: primaryAssistantMessageId,
      },
      {
        _id: IDS.archivedChat,
        userId,
        title: 'Budgeting for rent and utilities',
        titleSource: 'manual',
        status: 'archived',
        archivedAt: daysAgo(12),
        lastMessageAt: daysAgo(14),
        lastVisibleMessageId: archivedAssistantMessageId,
      },
      {
        _id: IDS.failedChat,
        userId,
        title: 'Can you review my transport trend?',
        titleSource: 'auto',
        status: 'failed',
        lastMessageAt: daysAgo(3),
        lastVisibleMessageId: failedAssistantMessageId,
      },
    ],
    messages: [
      {
        _id: primaryUserMessageId,
        chatId: IDS.primaryChat,
        userId,
        role: 'user',
        content: 'My food spending feels too high this month. What should I do?',
        status: 'completed',
        completedAt: daysAgo(0),
      },
      {
        _id: primaryAssistantMessageId,
        chatId: IDS.primaryChat,
        userId,
        role: 'assistant',
        content: 'Your food spending is concentrated in groceries and lunch outings. Try setting a weekly food cap, preparing two meals at home, and limiting lunch outings to two days this week.',
        status: 'completed',
        completedAt: daysAgo(0),
        generatedFromMessageId: primaryUserMessageId,
      },
      {
        _id: archivedUserMessageId,
        chatId: IDS.archivedChat,
        userId,
        role: 'user',
        content: 'Help me split my monthly budget between rent, bills, and daily spending.',
        status: 'completed',
        completedAt: daysAgo(14),
      },
      {
        _id: archivedAssistantMessageId,
        chatId: IDS.archivedChat,
        userId,
        role: 'assistant',
        content: 'Start by fixing rent first, then utilities, then set weekly limits for transport and food. Keep a 10% buffer for surprises.',
        status: 'completed',
        completedAt: daysAgo(14),
        generatedFromMessageId: archivedUserMessageId,
      },
      {
        _id: failedUserMessageId,
        chatId: IDS.failedChat,
        userId,
        role: 'user',
        content: 'Can you review my transport trend?',
        status: 'completed',
        completedAt: daysAgo(3),
      },
      {
        _id: failedAssistantMessageId,
        chatId: IDS.failedChat,
        userId,
        role: 'assistant',
        content: '',
        status: 'failed',
        errorMessage: 'The response could not be completed. Retry when you are ready.',
        generatedFromMessageId: failedUserMessageId,
        updatedAt: daysAgo(3),
      },
    ],
  };
};

const reviewingRows = (userId, categoryIds) => [
  {
    statementImportId: IDS.reviewingImport,
    userId,
    transactionDate: daysAgo(11),
    rawDescription: 'POS PURCHASE - Fresh Mart',
    description: 'Fresh Mart groceries',
    counterParty: 'Fresh Mart',
    amount: 12500,
    debit: 12500,
    credit: 0,
    direction: 'debit',
    classification: 'expense',
    categoryId: categoryIds.food,
    suggestedCategoryName: 'Food & Dining',
    confidence: 0.94,
    status: 'ready',
    isDuplicate: false,
    validationErrors: [],
  },
  {
    statementImportId: IDS.reviewingImport,
    userId,
    transactionDate: daysAgo(10),
    rawDescription: 'BANK TRANSFER - RIDE SHARE',
    description: 'Ride-share payment',
    counterParty: 'Ride Share',
    amount: 3900,
    debit: 3900,
    credit: 0,
    direction: 'debit',
    classification: 'expense',
    categoryId: categoryIds.transport,
    suggestedCategoryName: 'Transport',
    confidence: 0.68,
    status: 'needs_review',
    isDuplicate: false,
    validationErrors: ['Review category before import'],
  },
  {
    statementImportId: IDS.reviewingImport,
    userId,
    transactionDate: daysAgo(9),
    rawDescription: 'SALARY PAYMENT - ACME LTD',
    description: 'Salary payment',
    counterParty: 'Acme Ltd',
    amount: 320000,
    debit: 0,
    credit: 320000,
    direction: 'credit',
    classification: 'income',
    categoryId: categoryIds.salary,
    suggestedCategoryName: 'Salary',
    confidence: 0.97,
    status: 'ready',
    isDuplicate: false,
    validationErrors: [],
  },
  {
    statementImportId: IDS.reviewingImport,
    userId,
    transactionDate: daysAgo(8),
    rawDescription: 'POS PURCHASE - SHOPRITE',
    description: 'Shoprite groceries',
    counterParty: 'Shoprite',
    amount: 8500,
    debit: 8500,
    credit: 0,
    direction: 'debit',
    classification: 'expense',
    categoryId: categoryIds.food,
    suggestedCategoryName: 'Food & Dining',
    confidence: 0.88,
    status: 'duplicate',
    isDuplicate: true,
    duplicateHash: 'demo-duplicate-hash-01',
    validationErrors: ['Possible duplicate of an existing transaction'],
  },
];

async function connectDatabase() {
  await mongoose.connect(process.env.MONGODB_URI);
}

async function upsertDemoUser() {
  let user = await User.findOne({ email: DEMO_USER_EMAIL }).select('+password');

  if (!user) {
    user = new User({
      name: DEMO_USER_NAME,
      email: DEMO_USER_EMAIL,
      password: DEMO_USER_PASSWORD,
    });
  } else {
    user.name = DEMO_USER_NAME;
    user.password = DEMO_USER_PASSWORD;
  }

  user.isVerified = true;
  user.onboardingCompleted = true;
  user.onboardingStatus = 'completed';
  user.currency = 'NGN';
  user.monthlyBudgetLimit = 450000;
  user.consent = {
    dataAnalysis: true,
    timestamp: new Date(),
  };
  user.financialProfile = {
    incomeType: 'salary',
    incomeFrequency: 'monthly',
    averageIncome: 380000,
    financialGoals: ['Build emergency savings', 'Control food budget'],
  };

  await user.save();
  return user;
}

async function clearUserCollections(userId) {
  await Promise.all([
    Category.deleteMany({ userId }),
    Expense.deleteMany({ userId }),
    Income.deleteMany({ userId }),
    Notification.deleteMany({ userId }),
    BankConnection.deleteMany({ userId }),
    StatementImport.deleteMany({ userId }),
    StatementImportRow.deleteMany({ userId }),
    AssistantMessage.deleteMany({ userId }),
    AssistantChat.deleteMany({ userId }),
  ]);
}

async function seedCategories(userId) {
  const docs = categorySpecs.map((category) => ({
    userId,
    name: category.name,
    type: category.type,
    icon: category.icon,
    color: category.color,
    source: category.source,
    isActive: true,
  }));

  const categories = await Category.insertMany(docs);
  return categories.reduce((acc, category) => {
    const key = categorySpecs.find((spec) => spec.name === category.name)?.key;
    if (key) acc[key] = category._id;
    return acc;
  }, {});
}

async function seedTransactions(userId, categoryIds) {
  const expenses = await Expense.insertMany(
    expensesSeed(categoryIds).map((expense) => ({
      ...expense,
      userId,
      synced: true,
    })),
  );

  const incomes = await Income.insertMany(
    incomesSeed(categoryIds).map((income) => ({
      ...income,
      userId,
      synced: true,
    })),
  );

  return { expenses, incomes };
}

async function seedNotifications(userId, transactions) {
  await Notification.insertMany(notificationsSeed(userId, transactions));
}

async function seedBankConnection(userId) {
  const connection = new BankConnection({
    userId,
    provider: 'mono',
    accountId: `demo-account-${userId}`,
    institutionName: 'GTBank',
    institutionCode: '058',
    accountNumber: '0123456789',
    accountName: 'Chapter Four Demo',
    accountType: 'savings',
    currency: 'NGN',
    balance: 248300,
    authCode: 'demo-auth-code',
    accessToken: 'demo-access-token',
    tokenExpiresAt: daysAgo(-30),
    lastSyncAt: daysAgo(0),
    lastSuccessfulSyncAt: daysAgo(0),
    nextSyncAt: daysAgo(-1),
    syncFrequency: 43200000,
    autoSync: true,
    syncStatus: 'completed',
    accessMode: 'read_only',
    allowedOperations: ['account_details', 'balance', 'transactions'],
    forbiddenOperations: ['transfer', 'withdrawal', 'bill_payment'],
    securityVerifiedAt: daysAgo(2),
    isActive: true,
    isPrimary: true,
  });

  await connection.save();
}

async function seedStatementImports(userId, categoryIds) {
  await StatementImport.create([
    {
      _id: IDS.reviewingImport,
      userId,
      fileName: 'gtbank-april-statement.pdf',
      fileType: 'application/pdf',
      fileSize: 184320,
      source: 'manual_upload',
      bankName: 'GTBank',
      statementPeriodStart: new Date('2026-04-01T00:00:00.000Z'),
      statementPeriodEnd: new Date('2026-04-30T23:59:59.000Z'),
      currency: 'NGN',
      status: 'reviewing',
      extractionMethod: 'deterministic-table-parser',
      extractionQualityScore: 0.91,
      totalRows: 4,
      readyRows: 2,
      needsReviewRows: 1,
      duplicateRows: 1,
      failedRows: 0,
      ignoredRows: 0,
      importedRows: 0,
    },
    {
      _id: IDS.importedImport,
      userId,
      fileName: 'march-payments.csv',
      fileType: 'text/csv',
      fileSize: 45210,
      source: 'manual_upload',
      bankName: 'Access Bank',
      statementPeriodStart: new Date('2026-03-01T00:00:00.000Z'),
      statementPeriodEnd: new Date('2026-03-31T23:59:59.000Z'),
      currency: 'NGN',
      status: 'imported',
      extractionMethod: 'csv-parser',
      extractionQualityScore: 0.98,
      totalRows: 12,
      readyRows: 0,
      needsReviewRows: 0,
      duplicateRows: 2,
      failedRows: 0,
      ignoredRows: 1,
      importedRows: 9,
    },
  ]);

  await StatementImportRow.insertMany(reviewingRows(userId, categoryIds));
}

async function seedAssistantChats(userId) {
  const assistantSeed = createAssistantMessages(userId);
  await AssistantChat.insertMany(assistantSeed.chats);
  await AssistantMessage.insertMany(assistantSeed.messages);
}

async function main() {
  try {
    await connectDatabase();
    const user = await upsertDemoUser();
    await clearUserCollections(user._id);

    const categoryIds = await seedCategories(user._id);
    const transactions = await seedTransactions(user._id, categoryIds);

    await Promise.all([
      seedNotifications(user._id, transactions),
      seedBankConnection(user._id),
      seedStatementImports(user._id, categoryIds),
      seedAssistantChats(user._id),
    ]);

    console.log('✅ Chapter 4 demo data ready');
    console.log(`Email: ${DEMO_USER_EMAIL}`);
    console.log(`Password: ${DEMO_USER_PASSWORD}`);
    console.log(`Assistant chat route: /assistant/${IDS.primaryChat.toString()}`);
    console.log(`Statement review route: /settings/statement-import/${IDS.reviewingImport.toString()}/rows`);
  } catch (error) {
    console.error('❌ Failed to seed Chapter 4 demo data');
    console.error(error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main();
