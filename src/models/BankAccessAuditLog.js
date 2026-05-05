const mongoose = require('mongoose');

const IMMUTABLE_OPERATIONS = ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete'];

const bankAccessAuditLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    connectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BankConnection',
      default: null,
      index: true,
    },
    eventType: {
      type: String,
      required: true,
      index: true,
      enum: [
        'connect_requested',
        'connect_completed',
        'connect_failed',
        'sync_queued',
        'sync_started',
        'sync_completed',
        'sync_failed',
        'sync_cancelled',
        'reauthorization_required',
        'account_updated',
        'disconnect_requested',
        'disconnect_completed',
        'disconnect_failed',
      ],
    },
    actorType: {
      type: String,
      enum: ['user', 'system', 'webhook'],
      default: 'system',
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    requestMeta: {
      ipAddress: String,
      userAgent: String,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    chainIndex: {
      type: Number,
      required: true,
      min: 0,
    },
    previousHash: {
      type: String,
      default: null,
    },
    entryHash: {
      type: String,
      required: true,
    },
  },
  {
    versionKey: false,
    timestamps: false,
  },
);

bankAccessAuditLogSchema.index({ userId: 1, connectionId: 1, chainIndex: 1 }, { unique: true });
bankAccessAuditLogSchema.index({ connectionId: 1, timestamp: -1 });

IMMUTABLE_OPERATIONS.forEach((operation) => {
  bankAccessAuditLogSchema.pre(operation, function immutableGuard(next) {
    next(new Error('Bank access audit logs are append-only and cannot be modified or deleted through the application.'));
  });
});

const BankAccessAuditLog = mongoose.model('BankAccessAuditLog', bankAccessAuditLogSchema);

module.exports = BankAccessAuditLog;
