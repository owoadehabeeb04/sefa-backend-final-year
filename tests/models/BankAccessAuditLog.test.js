const mongoose = require('mongoose');
const BankAccessAuditLog = require('../../src/models/BankAccessAuditLog');

describe('BankAccessAuditLog Model', () => {
  it('creates a valid append-only audit entry', async () => {
    const entry = await BankAccessAuditLog.create({
      userId: new mongoose.Types.ObjectId(),
      connectionId: new mongoose.Types.ObjectId(),
      eventType: 'connect_completed',
      actorType: 'user',
      timestamp: new Date(),
      chainIndex: 0,
      previousHash: null,
      entryHash: 'hash-1',
    });

    expect(entry._id).toBeDefined();
    expect(entry.eventType).toBe('connect_completed');
    expect(entry.chainIndex).toBe(0);
  });
});
