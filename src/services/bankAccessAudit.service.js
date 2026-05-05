const { hash } = require('../utils/encryption');
const BankAccessAuditLog = require('../models/BankAccessAuditLog');

const stableSerialize = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value ?? null);
};

const toObjectIdString = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toString === 'function') return value.toString();
  return String(value);
};

const buildEntryHash = (payload) => {
  return hash(
    stableSerialize({
      userId: payload.userId,
      connectionId: payload.connectionId,
      eventType: payload.eventType,
      actorType: payload.actorType,
      timestamp: payload.timestamp,
      requestMeta: payload.requestMeta || {},
      metadata: payload.metadata || {},
      chainIndex: payload.chainIndex,
      previousHash: payload.previousHash || null,
    }),
  );
};

const appendBankAccessAuditLog = async ({
  userId,
  connectionId = null,
  eventType,
  actorType = 'system',
  requestMeta = {},
  metadata = {},
}) => {
  const normalizedUserId = toObjectIdString(userId);
  const normalizedConnectionId = toObjectIdString(connectionId);
  const lastEntry = await BankAccessAuditLog.findOne({
    userId: normalizedUserId,
    connectionId: normalizedConnectionId,
  })
    .sort({ chainIndex: -1 })
    .lean();

  const chainIndex = lastEntry ? lastEntry.chainIndex + 1 : 0;
  const timestamp = new Date();
  const previousHash = lastEntry?.entryHash || null;

  const entryHash = buildEntryHash({
    userId: normalizedUserId,
    connectionId: normalizedConnectionId,
    eventType,
    actorType,
    timestamp: timestamp.toISOString(),
    requestMeta,
    metadata,
    chainIndex,
    previousHash,
  });

  return BankAccessAuditLog.create({
    userId: normalizedUserId,
    connectionId: normalizedConnectionId,
    eventType,
    actorType,
    timestamp,
    requestMeta,
    metadata,
    chainIndex,
    previousHash,
    entryHash,
  });
};

const serializeAuditEvent = (entry) => ({
  id: String(entry._id),
  eventType: entry.eventType,
  actorType: entry.actorType,
  timestamp: entry.timestamp,
  chainIndex: entry.chainIndex,
  requestMeta: entry.requestMeta || {},
  metadata: entry.metadata || {},
});

const getRecentBankAccessAuditEvents = async ({ userId, connectionId, limit = 6 }) => {
  const query = {
    userId,
    connectionId,
  };

  const entries = await BankAccessAuditLog.find(query)
    .sort({ chainIndex: -1 })
    .limit(limit)
    .lean();

  return entries.map(serializeAuditEvent);
};

const validateBankAccessAuditChain = async ({ userId, connectionId }) => {
  const entries = await BankAccessAuditLog.find({
    userId,
    connectionId,
  })
    .sort({ chainIndex: 1 })
    .lean();

  let previousHash = null;

  for (const entry of entries) {
    const expectedHash = buildEntryHash({
      userId: toObjectIdString(entry.userId),
      connectionId: toObjectIdString(entry.connectionId),
      eventType: entry.eventType,
      actorType: entry.actorType,
      timestamp: new Date(entry.timestamp).toISOString(),
      requestMeta: entry.requestMeta || {},
      metadata: entry.metadata || {},
      chainIndex: entry.chainIndex,
      previousHash,
    });

    if (entry.previousHash !== previousHash || entry.entryHash !== expectedHash) {
      return {
        valid: false,
        checkedEntries: entries.length,
        checkedAt: new Date(),
        failedAtChainIndex: entry.chainIndex,
      };
    }

    previousHash = entry.entryHash;
  }

  return {
    valid: true,
    checkedEntries: entries.length,
    checkedAt: new Date(),
  };
};

module.exports = {
  appendBankAccessAuditLog,
  getRecentBankAccessAuditEvents,
  validateBankAccessAuditChain,
  serializeAuditEvent,
};
