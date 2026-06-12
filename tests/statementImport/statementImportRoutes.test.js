const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');

const Category = require('../../src/models/Category');
const StatementImport = require('../../src/models/StatementImport');
const StatementImportRow = require('../../src/models/StatementImportRow');

jest.mock('../../src/middleware/auth', () => ({
  authenticate: (req, res, next) => {
    const header = req.headers['x-user-id'];
    if (!header) {
      return res.status(401).json({ success: false, error: { message: 'Authentication required' } });
    }
    req.user = { userId: header, id: header, _id: header };
    req.authUser = { isVerified: true, onboardingCompleted: true };
    return next();
  },
  requireVerifiedEmail: (_req, _res, next) => next(),
  requireOnboardingComplete: (_req, _res, next) => next(),
}));

jest.mock('../../src/config/queue', () => ({
  addStatementImportJob: jest.fn().mockResolvedValue({ id: 'job-1' }),
  addNotificationJob: jest.fn().mockResolvedValue({}),
}));

const statementImportRoutes = require('../../src/routes/statementImportRoutes');

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/statement-imports', statementImportRoutes);
  return app;
};

describe('statement import routes', () => {
  it('requires authentication', async () => {
    const response = await request(createApp()).get('/api/v1/statement-imports');
    expect(response.status).toBe(401);
  });

  it('rejects unsupported file types', async () => {
    const userId = new mongoose.Types.ObjectId();

    const response = await request(createApp())
      .post('/api/v1/statement-imports/upload')
      .set('x-user-id', String(userId))
      .attach('file', Buffer.from('not a pdf'), 'statement.txt');

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/pdf/i);
  });

  it('rejects statement image uploads', async () => {
    const userId = new mongoose.Types.ObjectId();

    const response = await request(createApp())
      .post('/api/v1/statement-imports/upload')
      .set('x-user-id', String(userId))
      .attach('file', Buffer.from('fake-image-content'), {
        filename: 'statement.jpg',
        contentType: 'image/jpeg',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/pdf/i);
  });

  it('rejects excel uploads', async () => {
    const userId = new mongoose.Types.ObjectId();

    const response = await request(createApp())
      .post('/api/v1/statement-imports/upload')
      .set('x-user-id', String(userId))
      .attach('file', Buffer.from('fake-excel-content'), {
        filename: 'statement.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/pdf/i);
  });

  it('rejects oversized files', async () => {
    const userId = new mongoose.Types.ObjectId();

    const response = await request(createApp())
      .post('/api/v1/statement-imports/upload')
      .set('x-user-id', String(userId))
      .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1, 'a'), 'large.pdf');

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/10 mb/i);
  });

  it('does not let one user view another user import', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const otherUserId = new mongoose.Types.ObjectId();
    const statementImport = await StatementImport.create({
      userId: ownerId,
      fileName: 'statement.pdf',
      fileType: 'application/pdf',
      fileSize: 2048,
      status: 'reviewing',
    });

    const response = await request(createApp())
      .get(`/api/v1/statement-imports/${statementImport._id}`)
      .set('x-user-id', String(otherUserId));

    expect(response.status).toBe(404);
  });

  it('imports only ready rows on confirm', async () => {
    const userId = new mongoose.Types.ObjectId();
    const [expenseCategory, incomeCategory] = await Category.create([
      { userId, name: 'Food & Dining', type: 'expense', source: 'system' },
      { userId, name: 'Salary', type: 'income', source: 'system' },
    ]);

    const statementImport = await StatementImport.create({
      userId,
      fileName: 'statement.pdf',
      fileType: 'application/pdf',
      fileSize: 2048,
      status: 'reviewing',
    });

    await StatementImportRow.create([
      {
        userId,
        statementImportId: statementImport._id,
        transactionDate: new Date('2026-04-01T09:00:00.000Z'),
        description: 'Foodco meal',
        rawDescription: 'Foodco meal',
        amount: 5000,
        debit: 5000,
        direction: 'debit',
        classification: 'expense',
        categoryId: expenseCategory._id,
        status: 'ready',
      },
      {
        userId,
        statementImportId: statementImport._id,
        transactionDate: new Date('2026-04-02T09:00:00.000Z'),
        description: 'Salary',
        rawDescription: 'Salary',
        amount: 100000,
        credit: 100000,
        direction: 'credit',
        classification: 'income',
        categoryId: incomeCategory._id,
        status: 'needs_review',
      },
    ]);

    const response = await request(createApp())
      .post(`/api/v1/statement-imports/${statementImport._id}/confirm`)
      .set('x-user-id', String(userId));

    expect(response.status).toBe(200);
    expect(response.body.data.summary.importedRows).toBe(1);
  });

  it('does not delete imported sessions', async () => {
    const userId = new mongoose.Types.ObjectId();
    const statementImport = await StatementImport.create({
      userId,
      fileName: 'statement.pdf',
      fileType: 'application/pdf',
      fileSize: 2048,
      status: 'imported',
    });

    const response = await request(createApp())
      .delete(`/api/v1/statement-imports/${statementImport._id}`)
      .set('x-user-id', String(userId));

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/cannot be deleted/i);
  });
});
