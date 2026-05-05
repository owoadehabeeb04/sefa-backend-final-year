const READ_ONLY_ACCESS_MODE = 'read_only';

const ALLOWED_OPERATIONS = Object.freeze([
  'read_account_details',
  'read_transactions',
  'disconnect',
]);

const FORBIDDEN_OPERATIONS = Object.freeze([
  'transfer',
  'withdraw',
  'payment_initiation',
  'beneficiary_management',
  'balance_modification',
]);

const INTERNAL_ALLOWED_OPERATIONS = new Set([
  'connect_account',
  'read_account_details',
  'read_transactions',
  'disconnect',
  'view_security_details',
  'receive_webhook',
  'account_refresh',
  'reauthorize_notice',
]);

const FORBIDDEN_ROUTE_MATCHERS = [
  /transfer/i,
  /withdraw/i,
  /payment/i,
  /beneficiar/i,
  /payout/i,
  /debit/i,
  /balance-modification/i,
  /mandate/i,
];

const assertReadOnlyBankOperation = (operation) => {
  if (!operation) {
    throw new Error('Bank operation is required');
  }

  if (FORBIDDEN_OPERATIONS.includes(operation)) {
    const error = new Error(`SEFA bank integration is read-only. "${operation}" is not permitted.`);
    error.code = 'BANK_READ_ONLY_OPERATION_BLOCKED';
    error.statusCode = 403;
    throw error;
  }

  if (!INTERNAL_ALLOWED_OPERATIONS.has(operation)) {
    const error = new Error(
      `Unknown bank operation "${operation}" is blocked until the read-only capability model is explicitly updated.`,
    );
    error.code = 'BANK_OPERATION_NOT_ALLOWED';
    error.statusCode = 403;
    throw error;
  }

  return true;
};

const getSecurityVerifiedAt = (connection) =>
  connection?.securityVerifiedAt ||
  connection?.connectedAt ||
  connection?.createdAt ||
  new Date();

const normalizeReadOnlyConnection = (connection) => {
  if (!connection) return null;

  const serialized =
    typeof connection.toObject === 'function'
      ? connection.toObject({ virtuals: true })
      : { ...connection };

  serialized.accessMode = READ_ONLY_ACCESS_MODE;
  serialized.allowedOperations = Array.isArray(serialized.allowedOperations) && serialized.allowedOperations.length
    ? serialized.allowedOperations
    : [...ALLOWED_OPERATIONS];
  serialized.forbiddenOperations = Array.isArray(serialized.forbiddenOperations) && serialized.forbiddenOperations.length
    ? serialized.forbiddenOperations
    : [...FORBIDDEN_OPERATIONS];
  serialized.securityVerifiedAt = getSecurityVerifiedAt(serialized);

  return serialized;
};

const applyReadOnlyContract = (connection, { touchSecurityVerifiedAt = false } = {}) => {
  if (!connection) return connection;

  connection.accessMode = READ_ONLY_ACCESS_MODE;
  connection.allowedOperations = [...ALLOWED_OPERATIONS];
  connection.forbiddenOperations = [...FORBIDDEN_OPERATIONS];

  if (touchSecurityVerifiedAt || !connection.securityVerifiedAt) {
    connection.securityVerifiedAt = new Date();
  }

  return connection;
};

const buildConnectionSecuritySummary = (connection, options = {}) => {
  const normalized = normalizeReadOnlyConnection(connection);
  const recentEvents = options.recentEvents || [];

  return {
    connectionId: String(normalized?._id || normalized?.id || options.connectionId || ''),
    institutionName: normalized?.institutionName || 'Unknown Bank',
    accountName: normalized?.accountName || '',
    accountNumber: normalized?.maskedAccountNumber || normalized?.accountNumber || 'N/A',
    provider: normalized?.provider || 'mono',
    accessMode: normalized?.accessMode || READ_ONLY_ACCESS_MODE,
    allowedOperations: normalized?.allowedOperations || [...ALLOWED_OPERATIONS],
    forbiddenOperations: normalized?.forbiddenOperations || [...FORBIDDEN_OPERATIONS],
    permissionSummary: 'Account details and transaction history only',
    securityVerifiedAt: normalized?.securityVerifiedAt || getSecurityVerifiedAt(normalized),
    lastSyncAt: normalized?.lastSyncAt || null,
    lastSuccessfulSyncAt: normalized?.lastSuccessfulSyncAt || null,
    credentialHandling: {
      rawBankCredentialsCollected: false,
      providerHostedAuthentication: true,
      encryptedTokenStorage: true,
    },
    webhookSecurity: {
      type: 'hmac_sha256_signature',
      enabled: Boolean(process.env.MONO_WEBHOOK_SECRET),
    },
    audit: {
      chainValid: options.chainValid ?? true,
      checkedEntries: options.checkedEntries ?? 0,
      checkedAt: options.checkedAt || new Date(),
    },
    recentEvents,
  };
};

module.exports = {
  READ_ONLY_ACCESS_MODE,
  ALLOWED_OPERATIONS,
  FORBIDDEN_OPERATIONS,
  FORBIDDEN_ROUTE_MATCHERS,
  assertReadOnlyBankOperation,
  normalizeReadOnlyConnection,
  applyReadOnlyContract,
  buildConnectionSecuritySummary,
};
