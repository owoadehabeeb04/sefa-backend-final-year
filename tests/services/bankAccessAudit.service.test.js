const mongoose = require('mongoose');
const BankConnection = require('../../src/models/BankConnection');
const BankAccessAuditLog = require('../../src/models/BankAccessAuditLog');
const {
  appendBankAccessAuditLog,
  validateBankAccessAuditChain,
} = require('../../src/services/bankAccessAudit.service');

describe('bankAccessAudit.service', () => {
  it('creates a valid hash chain for bank access events', async () => {
    const userId = new mongoose.Types.ObjectId();
    const connection = await BankConnection.create({
      userId,
      provider: 'mono',
      accountId: 'acc_audit_valid',
      institutionName: 'Audit Bank',
      authCode: 'code',
      accessToken: 'token',
    });

    await appendBankAccessAuditLog({
      userId,
      connectionId: connection._id,
      eventType: 'sync_queued',
      actorType: 'user',
    });

    await appendBankAccessAuditLog({
      userId,
      connectionId: connection._id,
      eventType: 'sync_started',
      actorType: 'system',
    });

    const result = await validateBankAccessAuditChain({
      userId,
      connectionId: connection._id,
    });

    expect(result.valid).toBe(true);
    expect(result.checkedEntries).toBe(2);
  });

  it('detects a deleted or tampered audit entry', async () => {
    const userId = new mongoose.Types.ObjectId();
    const connection = await BankConnection.create({
      userId,
      provider: 'mono',
      accountId: 'acc_audit_tamper',
      institutionName: 'Audit Bank',
      authCode: 'code',
      accessToken: 'token',
    });

    const first = await appendBankAccessAuditLog({
      userId,
      connectionId: connection._id,
      eventType: 'sync_queued',
      actorType: 'user',
    });

    const second = await appendBankAccessAuditLog({
      userId,
      connectionId: connection._id,
      eventType: 'sync_started',
      actorType: 'system',
    });

    const third = await appendBankAccessAuditLog({
      userId,
      connectionId: connection._id,
      eventType: 'sync_completed',
      actorType: 'system',
    });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();

    await BankAccessAuditLog.collection.deleteOne({ _id: second._id });

    const result = await validateBankAccessAuditChain({
      userId,
      connectionId: connection._id,
    });

    expect(result.valid).toBe(false);
  });
});
