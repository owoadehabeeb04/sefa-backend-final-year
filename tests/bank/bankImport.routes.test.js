jest.mock('../../src/config/queue', () => ({
  addImportJob: jest.fn().mockResolvedValue({ id: 'queue-import-1' }),
  getJobStatus: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../src/middleware/upload.middleware', () => ({
  handleFileUpload: [
    (req, _res, next) => {
      const mongoose = require('mongoose');
      req.fileId = new mongoose.Types.ObjectId();
      req.body = {
        bankHint: req.headers['x-bank-hint'] || null,
        accountNumberHint: req.headers['x-account-number-hint'] || null,
      };
      req.fileMetadata = {
        originalName: 'statement.csv',
        mimeType: 'text/csv',
        size: 1024,
      };
      next();
    },
  ],
}));

jest.mock('../../src/middleware/webhookAuth.middleware', () => ({
  verifyMonoWebhook: (_req, _res, next) => next(),
  logWebhookEvent: (_req, _res, next) => next(),
  handleWebhookEvent: (_req, _res, next) => next(),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const Category = require('../../src/models/Category');
const Expense = require('../../src/models/Expense');
const ImportedTransactionMap = require('../../src/models/ImportedTransactionMap');
const ImportJob = require('../../src/models/ImportJob');
const User = require('../../src/models/User');
const bankRoutes = require('../../src/routes/bankRoutes');

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/bank', bankRoutes);
  return app;
};

describe('bank import routes', () => {
  let app;
  let user;
  let authHeader;
  let expenseCategory;

  beforeEach(async () => {
    app = createApp();
    user = await User.create({
      name: 'Import Tester',
      email: 'importer@example.com',
      password: 'SecurePass123!',
      onboardingCompleted: true,
      isVerified: true,
    });
    authHeader = `Bearer ${jwt.sign({ userId: String(user._id) }, process.env.JWT_SECRET)}`;
    expenseCategory = await Category.create({
      userId: user._id,
      name: 'Food & Dining',
      type: 'expense',
      color: '#ef4444',
    });
  });

  it('creates an import job immediately and supports history, details, and undo', async () => {
    const uploadResponse = await request(app)
      .post('/api/bank/upload')
      .set('Authorization', authHeader)
      .set('x-bank-hint', 'OPay')
      .set('x-account-number-hint', '9287')
      .expect(202);

    expect(uploadResponse.body.success).toBe(true);
    expect(uploadResponse.body.data.importJobId).toBeTruthy();
    expect(uploadResponse.body.data.queueJobId).toBe('queue-import-1');
    expect(uploadResponse.body.data.status).toBe('queued');

    const importJobId = uploadResponse.body.data.importJobId;
    const storedJob = await ImportJob.findById(importJobId);

    expect(storedJob).not.toBeNull();
    expect(storedJob.status).toBe('queued');
    expect(storedJob.queueJobId).toBe('queue-import-1');
    expect(storedJob.bankHint).toBe('OPay');
    expect(storedJob.accountNumberHint).toBe('9287');

    const historyResponse = await request(app)
      .get('/api/bank/imports')
      .set('Authorization', authHeader)
      .expect(200);

    expect(historyResponse.body.data).toHaveLength(1);
    expect(historyResponse.body.data[0]._id).toBe(importJobId);

    const detailResponse = await request(app)
      .get(`/api/bank/import/${importJobId}`)
      .set('Authorization', authHeader)
      .expect(200);

    expect(detailResponse.body.data._id).toBe(importJobId);
    expect(detailResponse.body.data.status).toBe('queued');

    const legacyQueueResponse = await request(app)
      .get('/api/bank/import/queue-import-1')
      .set('Authorization', authHeader)
      .expect(200);

    expect(legacyQueueResponse.body.data._id).toBe(importJobId);

    const expense = await Expense.create({
      userId: user._id,
      categoryId: expenseCategory._id,
      amount: 2500,
      description: 'Imported expense',
      date: new Date('2026-03-01T09:00:00.000Z'),
      paymentMethod: 'bank_transfer',
      isImported: true,
      importJobId,
      externalId: 'statement:test-expense',
    });

    await ImportedTransactionMap.create({
      importJobId,
      userId: user._id,
      sourceType: 'import_job',
      sourceRefId: importJobId,
      expenseId: expense._id,
      externalId: 'test-expense',
      rawData: { description: 'Imported expense' },
    });

    storedJob.status = 'completed';
    storedJob.stage = 'completed';
    storedJob.importedCount = 1;
    storedJob.progress = 100;
    await storedJob.save();

    const undoResponse = await request(app)
      .post(`/api/bank/import/${importJobId}/undo`)
      .set('Authorization', authHeader)
      .expect(200);

    expect(undoResponse.body.success).toBe(true);
    expect(await Expense.countDocuments({ userId: user._id })).toBe(0);

    const refreshedJob = await ImportJob.findById(importJobId);
    expect(refreshedJob.status).toBe('undone');
    expect(refreshedJob.isUndone).toBe(true);
  });
});
