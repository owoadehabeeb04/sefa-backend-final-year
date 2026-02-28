const mongoose = require('mongoose');
const { encrypt, decrypt } = require('../utils/encryption');

const bankConnectionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required']
  },
  provider: {
    type: String,
    required: [true, 'Provider is required'],
    enum: ['mono'],
    default: 'mono'
  },
  accountId: {
    type: String,
    required: [true, 'Account ID is required'],
    unique: true
  },
  institutionName: {
    type: String,
    required: [true, 'Institution name is required'],
    trim: true
  },
  institutionCode: {
    type: String,
    trim: true
  },
  accountNumber: {
    type: String,
    trim: true
  },
  accountName: {
    type: String,
    trim: true
  },
  accountType: {
    type: String,
    enum: ['savings', 'current', 'domiciliary', 'other'],
    default: 'savings'
  },
  currency: {
    type: String,
    default: 'NGN',
    trim: true
  },
  balance: {
    type: Number,
    default: 0
  },

  // Sync management (encrypted tokens)
  authCode: {
    type: String,
    required: true,
    select: false // Don't include in queries by default
  },
  accessToken: {
    type: String,
    required: true,
    select: false
  },
  tokenExpiresAt: {
    type: Date
  },
  lastSyncAt: {
    type: Date
  },
  nextSyncAt: {
    type: Date
  },
  syncFrequency: {
    type: Number,
    default: 43200000 // 12 hours in milliseconds
  },
  autoSync: {
    type: Boolean,
    default: true
  },
  syncStatus: {
    type: String,
    enum: ['active', 'syncing', 'paused', 'error', 'disconnected', 'reauth_required'],
    default: 'active'
  },
  lastSyncError: {
    type: String
  },

  // Metadata
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  isPrimary: {
    type: Boolean,
    default: false
  },
  connectedAt: {
    type: Date,
    default: Date.now
  },
  disconnectedAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Compound indexes for efficient queries
bankConnectionSchema.index({ userId: 1, isActive: 1 });
bankConnectionSchema.index({ userId: 1, isPrimary: 1 });
bankConnectionSchema.index({ nextSyncAt: 1, autoSync: 1, syncStatus: 1 }); // For sync job

// Encrypt tokens before saving
bankConnectionSchema.pre('save', function(next) {
  try {
    // Only encrypt if fields are modified and not already encrypted
    if (this.isModified('authCode') && this.authCode && !this.authCode.includes(':')) {
      this.authCode = encrypt(this.authCode);
    }
    if (this.isModified('accessToken') && this.accessToken && !this.accessToken.includes(':')) {
      this.accessToken = encrypt(this.accessToken);
    }
    next();
  } catch (error) {
    next(error);
  }
});

// Instance method to get decrypted auth code
bankConnectionSchema.methods.getDecryptedAuthCode = function() {
  if (!this.authCode) return null;
  try {
    return decrypt(this.authCode);
  } catch (error) {
    console.error('Failed to decrypt auth code:', error);
    return null;
  }
};

// Instance method to get decrypted access token
bankConnectionSchema.methods.getDecryptedAccessToken = function() {
  if (!this.accessToken) return null;
  try {
    return decrypt(this.accessToken);
  } catch (error) {
    console.error('Failed to decrypt access token:', error);
    return null;
  }
};

// Instance method to check if token is expired
bankConnectionSchema.methods.isTokenExpired = function() {
  if (!this.tokenExpiresAt) return false;
  return new Date() > new Date(this.tokenExpiresAt);
};

// Instance method to calculate next sync time
bankConnectionSchema.methods.calculateNextSync = function() {
  const now = new Date();
  return new Date(now.getTime() + this.syncFrequency);
};

// Static method to get active connections for sync
bankConnectionSchema.statics.getConnectionsForSync = async function() {
  const now = new Date();
  return this.find({
    isActive: true,
    autoSync: true,
    syncStatus: { $in: ['active', 'error'] },
    $or: [
      { nextSyncAt: { $lte: now } },
      { nextSyncAt: null }
    ]
  }).select('+authCode +accessToken'); // Include encrypted fields
};

// Static method to get user's primary account
bankConnectionSchema.statics.getPrimaryAccount = async function(userId) {
  return this.findOne({
    userId,
    isActive: true,
    isPrimary: true
  });
};

// Virtual for masked account number (last 4 digits)
bankConnectionSchema.virtual('maskedAccountNumber').get(function() {
  if (!this.accountNumber) return 'N/A';
  const length = this.accountNumber.length;
  if (length <= 4) return this.accountNumber;
  return '*'.repeat(length - 4) + this.accountNumber.slice(-4);
});

bankConnectionSchema.virtual('syncInterval')
  .get(function() {
    const frequencyMs = this.syncFrequency || 43200000;
    return Math.max(1, Math.round(frequencyMs / (60 * 60 * 1000)));
  })
  .set(function(hours) {
    const parsed = Number(hours);
    if (!Number.isFinite(parsed)) return;
    this.syncFrequency = Math.max(1, parsed) * 60 * 60 * 1000;
  });

// Ensure virtuals are included in JSON
bankConnectionSchema.set('toJSON', { virtuals: true });
bankConnectionSchema.set('toObject', { virtuals: true });

const BankConnection = mongoose.model('BankConnection', bankConnectionSchema);

module.exports = BankConnection;
