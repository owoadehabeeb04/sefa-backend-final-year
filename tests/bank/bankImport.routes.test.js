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
const { addImportJob } = require('../../src/config/queue');

const Category = require('../../src/models/Category');
const Expense = require('../../src/models/Expense');
const ImportDraftRow = require('../../src/models/ImportDraftRow');
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
    jest.clearAllMocks();
    addImportJob.mockResolvedValue({ id: 'queue-import-1' });

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

  it('supports bank selection and draft review before import confirmation', async () => {
    const bankSelectionJob = await ImportJob.create({
      userId: user._id,
      source: 'pdf_upload',
      status: 'needs_bank_selection',
      stage: 'needs_bank_selection',
      progress: 55,
      fileName: 'statement.pdf',
      fileType: 'application/pdf',
      bankSelection: {
        required: true,
        reason: 'low',
        requestedAt: new Date('2026-03-01T10:00:00.000Z'),
      },
      qualityFlags: ['bank_selection_required'],
    });

    addImportJob.mockResolvedValueOnce({ id: 'queue-import-2' });

    const selectBankResponse = await request(app)
      .post(`/api/bank/import/${bankSelectionJob._id}/select-bank`)
      .set('Authorization', authHeader)
      .send({ bankSlug: 'opay' })
      .expect(202);

    expect(selectBankResponse.body.success).toBe(true);
    expect(selectBankResponse.body.data.status).toBe('queued');
    expect(selectBankResponse.body.data.queueJobId).toBe('queue-import-2');
    expect(addImportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'prepare-draft',
        importJobId: String(bankSelectionJob._id),
      }),
    );

    const refreshedSelectionJob = await ImportJob.findById(bankSelectionJob._id);
    expect(refreshedSelectionJob.status).toBe('queued');
    expect(refreshedSelectionJob.bankSelection.selectedBankSlug).toBe('opay');

    const reviewJob = await ImportJob.create({
      userId: user._id,
      source: 'csv_upload',
      status: 'needs_review',
      stage: 'needs_review',
      progress: 68,
      fileName: 'statement.csv',
      fileType: 'text/csv',
      draftSummary: {
        totalRows: 1,
        includedRows: 1,
        excludedRows: 0,
        debitTotal: 2500,
        creditTotal: 0,
        lowConfidenceRows: 0,
        flaggedRows: 0,
      },
    });

    const draftRow = await ImportDraftRow.create({
      importJobId: reviewJob._id,
      userId: user._id,
      rowIndex: 0,
      originalRowIndex: 0,
      date: new Date('2026-03-01T09:00:00.000Z'),
      description: 'POS purchase',
      amount: 2500,
      direction: 'debit',
      balance: 5400,
      reference: 'TX-001',
      suggestedCategoryId: expenseCategory._id,
      suggestedCategoryName: expenseCategory.name,
      suggestedCategoryIcon: expenseCategory.icon || 'folder',
      suggestedCategoryColor: expenseCategory.color,
      confidence: 'medium',
      issueFlags: ['needs_review'],
      excluded: false,
      sourceText: 'POS purchase TX-001',
      mappingExternalId: 'statement:tx-001',
      scopedExternalId: 'statement:statement:tx-001',
      rawData: { description: 'POS purchase' },
    });

    const draftResponse = await request(app)
      .get(`/api/bank/import/${reviewJob._id}/draft`)
      .set('Authorization', authHeader)
      .expect(200);

    expect(draftResponse.body.success).toBe(true);
    expect(draftResponse.body.data.rows).toHaveLength(1);
    expect(draftResponse.body.data.summary.totalRows).toBe(1);

    const updateDraftResponse = await request(app)
      .patch(`/api/bank/import/${reviewJob._id}/draft/${draftRow._id}`)
      .set('Authorization', authHeader)
      .send({
        description: 'Lunch at work',
        amount: 3000,
        categoryId: String(expenseCategory._id),
      })
      .expect(200);

    expect(updateDraftResponse.body.success).toBe(true);
    expect(updateDraftResponse.body.data.row.description).toBe('Lunch at work');
    expect(updateDraftResponse.body.data.row.amount).toBe(3000);
    expect(updateDraftResponse.body.data.row.categoryId).toBe(String(expenseCategory._id));

    addImportJob.mockResolvedValueOnce({ id: 'queue-import-3' });

    const confirmResponse = await request(app)
      .post(`/api/bank/import/${reviewJob._id}/confirm`)
      .set('Authorization', authHeader)
      .expect(202);

    expect(confirmResponse.body.success).toBe(true);
    expect(confirmResponse.body.data.status).toBe('importing');
    expect(confirmResponse.body.data.queueJobId).toBe('queue-import-3');
    expect(addImportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'confirm-import',
        importJobId: String(reviewJob._id),
      }),
    );

    const refreshedReviewJob = await ImportJob.findById(reviewJob._id);
    expect(refreshedReviewJob.status).toBe('importing');
    expect(refreshedReviewJob.needsReview).toBe(false);
  });
});
