jest.mock('../../src/config/queue', () => ({
  addSyncJob: jest.fn().mockResolvedValue({ id: 'sync-job-1' }),
  addNotificationJob: jest.fn().mockResolvedValue({ id: 'notification-job-1' }),
  syncQueue: {
    getJob: jest.fn().mockResolvedValue({
      remove: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../src/services/mono.service', () => ({
  getTransactions: jest.fn(),
}));

const mongoose = require('mongoose');
const BankConnection = require('../../src/models/BankConnection');
const Expense = require('../../src/models/Expense');
const BankAccessAuditLog = require('../../src/models/BankAccessAuditLog');
const ImportedTransactionMap = require('../../src/models/ImportedTransactionMap');
const Income = require('../../src/models/Income');
const monoService = require('../../src/services/mono.service');
const SyncLog = require('../../src/models/SyncLog');
const syncScheduler = require('../../src/services/syncScheduler.service');

describe('syncScheduler.service', () => {
  const userId = new mongoose.Types.ObjectId();

  const createConnection = async (overrides = {}) =>
    BankConnection.create({
      userId,
      provider: 'mono',
      accountId: `acc_${Math.random().toString(36).slice(2, 10)}`,
      institutionName: 'Test Bank',
      authCode: 'auth-code',
      accessToken: 'access-token',
      ...overrides,
    });

  it('queues only one active sync log per connection', async () => {
    const connection = await createConnection();

    const first = await syncScheduler.queueConnectionSync(connection, userId, {
      syncType: 'manual',
      triggeredBy: 'user',
      forceSync: true,
    });

    const second = await syncScheduler.queueConnectionSync(connection._id, userId, {
      syncType: 'manual',
      triggeredBy: 'user',
      forceSync: true,
    });

    const syncLogs = await SyncLog.find({ connectionId: connection._id });
    const refreshedConnection = await BankConnection.findById(connection._id);

    expect(first.existing).toBe(false);
    expect(second.existing).toBe(true);
    expect(syncLogs).toHaveLength(1);
    expect(String(second.syncLogId)).toBe(String(first.syncLogId));
    expect(refreshedConnection.syncStatus).toBe('queued');
    expect(String(refreshedConnection.currentSyncLogId)).toBe(String(first.syncLogId));
  });

  it('marks active webhook re-triggers as pending re-sync instead of creating duplicates', async () => {
    const connection = await createConnection();
    const initial = await syncScheduler.queueConnectionSync(connection, userId, {
      syncType: 'manual',
      triggeredBy: 'user',
      forceSync: true,
    });

    await SyncLog.findByIdAndUpdate(initial.syncLogId, { status: 'syncing' });
    await BankConnection.findByIdAndUpdate(connection._id, {
      syncStatus: 'syncing',
      currentSyncLogId: initial.syncLogId,
    });

    const webhookRequest = await syncScheduler.queueConnectionSync(connection._id, userId, {
      syncType: 'webhook',
      triggeredBy: 'webhook',
      forceSync: true,
    });

    const syncLogs = await SyncLog.find({ connectionId: connection._id });
    const refreshedConnection = await BankConnection.findById(connection._id);

    expect(webhookRequest.existing).toBe(true);
    expect(syncLogs).toHaveLength(1);
    expect(refreshedConnection.pendingResync).toBe(true);
  });

  it('runs sync ingestion and treats reruns as duplicates', async () => {
    const connection = await createConnection();
    const firstQueue = await syncScheduler.queueConnectionSync(connection, userId, {
      syncType: 'manual',
      triggeredBy: 'user',
      forceSync: true,
    });

    monoService.getTransactions.mockResolvedValue([
      {
        _id: 'mono-txn-1',
        date: new Date('2026-03-01T09:00:00.000Z'),
        amount: 5000,
        type: 'debit',
        narration: 'POS PURCHASE SHOPRITE',
      },
      {
        _id: 'mono-txn-2',
        date: new Date('2026-03-02T09:00:00.000Z'),
        amount: 120000,
        type: 'credit',
        narration: 'Salary payment',
      },
    ]);

    const firstRun = await syncScheduler.runQueuedSync({
      id: 'sync-job-1',
      data: {
        connectionId: String(connection._id),
        userId: String(userId),
        syncLogId: String(firstQueue.syncLogId),
        isInitialSync: false,
      },
    });

    expect(firstRun.status).toBe('completed');
    expect(await Expense.countDocuments({ userId })).toBe(1);
    expect(await Income.countDocuments({ userId })).toBe(1);
    expect(await ImportedTransactionMap.countDocuments({
      userId,
      sourceType: 'bank_connection',
      sourceRefId: connection._id,
    })).toBe(2);

    const secondQueue = await syncScheduler.queueConnectionSync(connection._id, userId, {
      syncType: 'manual',
      triggeredBy: 'user',
      forceSync: true,
    });

    const secondRun = await syncScheduler.runQueuedSync({
      id: 'sync-job-2',
      data: {
        connectionId: String(connection._id),
        userId: String(userId),
        syncLogId: String(secondQueue.syncLogId),
        isInitialSync: false,
      },
    });

    expect(secondRun.importedCount).toBe(0);
    expect(secondRun.duplicateCount).toBe(2);
    expect(await SyncLog.countDocuments({ connectionId: connection._id })).toBe(2);
    const auditEvents = await BankAccessAuditLog.find({ connectionId: connection._id }).sort({ chainIndex: 1 });
    expect(auditEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['sync_queued', 'sync_started', 'sync_completed'])
    );
  });
});
