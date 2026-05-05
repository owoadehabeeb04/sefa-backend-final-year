const BankConnection = require('../../src/models/BankConnection');
const mongoose = require('mongoose');

describe('BankConnection Model', () => {
  const validUserId = new mongoose.Types.ObjectId();

  describe('Schema Validation', () => {
    it('should create a valid bank connection', async () => {
      const bankConnection = new BankConnection({
        userId: validUserId,
        provider: 'mono',
        accountId: 'acc_123456789',
        institutionName: 'Access Bank',
        institutionCode: '044',
        accountNumber: '0123456789',
        accountName: 'John Doe',
        accountType: 'savings',
        currency: 'NGN',
        balance: 50000,
        authCode: 'test-auth-code',
        accessToken: 'test-access-token'
      });

      const savedConnection = await bankConnection.save();

      expect(savedConnection._id).toBeDefined();
      expect(savedConnection.userId.toString()).toBe(validUserId.toString());
      expect(savedConnection.provider).toBe('mono');
      expect(savedConnection.institutionName).toBe('Access Bank');
      expect(savedConnection.isActive).toBe(true);
      expect(savedConnection.autoSync).toBe(true);
      expect(savedConnection.syncStatus).toBe('active');
      expect(savedConnection.accessMode).toBe('read_only');
      expect(savedConnection.allowedOperations).toContain('read_transactions');
      expect(savedConnection.forbiddenOperations).toContain('transfer');
      expect(savedConnection.securityVerifiedAt).toBeDefined();
    });

    it('should require userId', async () => {
      const bankConnection = new BankConnection({
        accountId: 'acc_123',
        institutionName: 'Test Bank',
        authCode: 'code',
        accessToken: 'token'
      });

      await expect(bankConnection.save()).rejects.toThrow();
    });

    it('should require unique accountId', async () => {
      const connection1 = new BankConnection({
        userId: validUserId,
        accountId: 'acc_duplicate',
        institutionName: 'Bank 1',
        authCode: 'code1',
        accessToken: 'token1'
      });

      await connection1.save();

      const connection2 = new BankConnection({
        userId: new mongoose.Types.ObjectId(),
        accountId: 'acc_duplicate',
        institutionName: 'Bank 2',
        authCode: 'code2',
        accessToken: 'token2'
      });

      await expect(connection2.save()).rejects.toThrow();
    });
  });

  describe('Encryption', () => {
    it('should encrypt authCode and accessToken before saving', async () => {
      const plainAuthCode = 'plain-auth-code';
      const plainAccessToken = 'plain-access-token';

      const bankConnection = new BankConnection({
        userId: validUserId,
        accountId: 'acc_encrypt_test',
        institutionName: 'Test Bank',
        authCode: plainAuthCode,
        accessToken: plainAccessToken
      });

      const saved = await bankConnection.save();

      // Should be encrypted (contains ':' separator)
      expect(saved.authCode).toContain(':');
      expect(saved.accessToken).toContain(':');
      expect(saved.authCode).not.toBe(plainAuthCode);
      expect(saved.accessToken).not.toBe(plainAccessToken);
    });

    it('should decrypt authCode using instance method', async () => {
      const plainAuthCode = 'test-auth-code-123';

      const bankConnection = new BankConnection({
        userId: validUserId,
        accountId: 'acc_decrypt_test',
        institutionName: 'Test Bank',
        authCode: plainAuthCode,
        accessToken: 'token'
      });

      const saved = await bankConnection.save();
      
      // Find with select to include encrypted fields
      const found = await BankConnection.findById(saved._id).select('+authCode +accessToken');

      const decrypted = found.getDecryptedAuthCode();
      expect(decrypted).toBe(plainAuthCode);
    });
  });

  describe('Instance Methods', () => {
    it('should check if token is expired', async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // Tomorrow
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // Yesterday

      const connection1 = new BankConnection({
        userId: validUserId,
        accountId: 'acc_future',
        institutionName: 'Bank',
        authCode: 'code',
        accessToken: 'token',
        tokenExpiresAt: futureDate
      });

      const connection2 = new BankConnection({
        userId: validUserId,
        accountId: 'acc_past',
        institutionName: 'Bank',
        authCode: 'code',
        accessToken: 'token',
        tokenExpiresAt: pastDate
      });

      expect(connection1.isTokenExpired()).toBe(false);
      expect(connection2.isTokenExpired()).toBe(true);
    });

    it('should calculate next sync time', async () => {
      const connection = new BankConnection({
        userId: validUserId,
        accountId: 'acc_sync',
        institutionName: 'Bank',
        authCode: 'code',
        accessToken: 'token',
        syncFrequency: 3600000 // 1 hour
      });

      const now = new Date();
      const nextSync = connection.calculateNextSync();
      const expectedTime = new Date(now.getTime() + 3600000);

      // Allow 1 second tolerance
      expect(Math.abs(nextSync - expectedTime)).toBeLessThan(1000);
    });
  });

  describe('Virtuals', () => {
    it('should return masked account number', async () => {
      const connection = new BankConnection({
        userId: validUserId,
        accountId: 'acc_mask',
        institutionName: 'Bank',
        accountNumber: '0123456789',
        authCode: 'code',
        accessToken: 'token'
      });

      await connection.save();

      expect(connection.maskedAccountNumber).toBe('******6789');
    });

    it('should handle short account numbers', async () => {
      const connection = new BankConnection({
        userId: validUserId,
        accountId: 'acc_short',
        institutionName: 'Bank',
        accountNumber: '123',
        authCode: 'code',
        accessToken: 'token'
      });

      await connection.save();

      expect(connection.maskedAccountNumber).toBe('123');
    });
  });

  describe('Static Methods', () => {
    it('should get primary account for user', async () => {
      await BankConnection.create({
        userId: validUserId,
        accountId: 'acc_1',
        institutionName: 'Bank 1',
        authCode: 'code',
        accessToken: 'token',
        isPrimary: false
      });

      await BankConnection.create({
        userId: validUserId,
        accountId: 'acc_2',
        institutionName: 'Bank 2',
        authCode: 'code',
        accessToken: 'token',
        isPrimary: true
      });

      const primary = await BankConnection.getPrimaryAccount(validUserId);

      expect(primary).toBeDefined();
      expect(primary.accountId).toBe('acc_2');
      expect(primary.isPrimary).toBe(true);
    });

    it('should get connections for sync', async () => {
      const now = new Date();
      const pastDate = new Date(now.getTime() - 1000);

      // Should be included
      await BankConnection.create({
        userId: validUserId,
        accountId: 'acc_sync_1',
        institutionName: 'Bank 1',
        authCode: 'code',
        accessToken: 'token',
        autoSync: true,
        syncStatus: 'active',
        nextSyncAt: pastDate
      });

      // Should be excluded (autoSync false)
      await BankConnection.create({
        userId: validUserId,
        accountId: 'acc_sync_2',
        institutionName: 'Bank 2',
        authCode: 'code',
        accessToken: 'token',
        autoSync: false,
        syncStatus: 'active',
        nextSyncAt: pastDate
      });

      const connections = await BankConnection.getConnectionsForSync();

      expect(connections).toHaveLength(1);
      expect(connections[0].accountId).toBe('acc_sync_1');
    });
  });
});
