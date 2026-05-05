const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');
const BankConnection = require('../../src/models/BankConnection');
const { appendBankAccessAuditLog } = require('../../src/services/bankAccessAudit.service');

jest.mock('../../src/middleware/auth.middleware', () => ({
  authenticate: (req, _res, next) => {
    req.user = {
      userId: req.headers['x-user-id'],
      id: req.headers['x-user-id'],
      _id: req.headers['x-user-id'],
    };
    req.authUser = {
      isVerified: true,
      onboardingCompleted: true,
    };
    next();
  },
  requireVerifiedEmail: (_req, _res, next) => next(),
  requireOnboardingComplete: (_req, _res, next) => next(),
}));

jest.mock('../../src/middleware/webhookAuth.middleware', () => ({
  verifyMonoWebhook: (_req, _res, next) => next(),
  logWebhookEvent: (_req, _res, next) => next(),
  handleWebhookEvent: (_req, _res, next) => next(),
}));

jest.mock('../../src/services/mono.service', () => ({
  exchangeToken: jest.fn(),
  getAccountDetails: jest.fn(),
  unlinkAccount: jest.fn(),
}));

jest.mock('../../src/services/syncScheduler.service', () => ({
  queueConnectionSync: jest.fn(),
}));

const bankRoutes = require('../../src/routes/bankRoutes');

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/bank', bankRoutes);
  return app;
};

describe('bank read-only routes', () => {
  it('returns read-only capability data on bank connections', async () => {
    const userId = new mongoose.Types.ObjectId();
    await BankConnection.create({
      userId,
      provider: 'mono',
      accountId: 'acc_read_only_contract',
      institutionName: 'Safe Bank',
      accountNumber: '0123456789',
      authCode: 'code',
      accessToken: 'token',
    });

    const response = await request(createApp())
      .get('/api/v1/bank/connections')
      .set('x-user-id', String(userId));

    expect(response.status).toBe(200);
    expect(response.body.data[0].accessMode).toBe('read_only');
    expect(response.body.data[0].allowedOperations).toContain('read_transactions');
    expect(response.body.data[0].forbiddenOperations).toContain('transfer');
  });

  it('returns connection security summary and recent audit events', async () => {
    const userId = new mongoose.Types.ObjectId();
    const connection = await BankConnection.create({
      userId,
      provider: 'mono',
      accountId: 'acc_security_view',
      institutionName: 'Safe Bank',
      accountNumber: '0123456789',
      authCode: 'code',
      accessToken: 'token',
    });

    await appendBankAccessAuditLog({
      userId,
      connectionId: connection._id,
      eventType: 'connect_completed',
      actorType: 'user',
    });

    const response = await request(createApp())
      .get(`/api/v1/bank/connections/${connection._id}/security`)
      .set('x-user-id', String(userId));

    expect(response.status).toBe(200);
    expect(response.body.data.accessMode).toBe('read_only');
    expect(response.body.data.permissionSummary).toMatch(/transaction history only/i);
    expect(response.body.data.recentEvents).toHaveLength(1);
  });

  it('rejects future money-movement paths under /api/bank', async () => {
    const response = await request(createApp()).post('/api/v1/bank/transfers');

    expect(response.status).toBe(403);
    expect(response.body.message || response.body.error?.message).toMatch(/read-only/i);
  });
});
