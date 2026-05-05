const axios = require('axios');
const { assertReadOnlyBankOperation } = require('./bankReadOnly.service');

/**
 * Mono API Service
 * Documentation: https://docs.mono.co
 */

const MONO_BASE_URL = process.env.MONO_ENVIRONMENT === 'production'
  ? 'https://api.withmono.com'
  : 'https://api.withmono.com'; // Same URL for test and production

const MONO_SECRET_KEY = process.env.MONO_SECRET_KEY;

const extractAccountIdFromAuthResponse = (payload) => {
  if (!payload || typeof payload !== 'object') return null;

  const candidates = [
    payload.id,
    payload.accountId,
    payload.account?._id,
    payload.account?.id,
    payload.data?.id,
    payload.data?.accountId,
    payload.data?.account?._id,
    payload.data?.account?.id,
    payload.response?.id,
    payload.response?.data?.id,
  ];

  const found = candidates.find((value) => typeof value === 'string' && value.trim().length > 0);
  return found ? found.trim() : null;
};

const unwrapMonoData = (payload) => {
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.data && typeof payload.data === 'object') return payload.data;
  return payload;
};

const normalizeAccountDetails = (payload) => {
  const root = unwrapMonoData(payload) || {};
  const accountNode = root.account || root;
  const institutionNode =
    root.institution ||
    root.institutionData ||
    root.bank ||
    accountNode.institution ||
    accountNode.bank ||
    root.meta?.institution ||
    {};
  const rawType = String(accountNode.type || accountNode.accountType || '').toLowerCase();

  const firstNonEmpty = (...values) => {
    for (const value of values) {
      if (value === null || value === undefined) continue;
      const str = String(value).trim();
      if (str) return str;
    }
    return '';
  };

  const normalizedAccountNumber = firstNonEmpty(
    accountNode.accountNumber,
    accountNode.account_number,
    accountNode.number,
    accountNode.nuban,
    accountNode.maskedAccountNumber,
    accountNode.masked_account_number,
    root.accountNumber,
    root.account_number,
    root.nuban,
    root.maskedAccountNumber,
    root.masked_account_number,
  );

  let normalizedAccountType = 'other';
  if (rawType.includes('saving')) normalizedAccountType = 'savings';
  else if (rawType.includes('current')) normalizedAccountType = 'current';
  else if (rawType.includes('domiciliary')) normalizedAccountType = 'domiciliary';

  return {
    ...root,
    account: {
      ...accountNode,
      name: accountNode.name || accountNode.accountName || accountNode.fullName || '',
      accountNumber: normalizedAccountNumber,
      type: normalizedAccountType,
      currency: String(accountNode.currency || 'NGN').toUpperCase(),
      balance: Number(accountNode.balance || 0),
    },
    institution: {
      ...institutionNode,
      name:
        institutionNode.name ||
        institutionNode.displayName ||
        institutionNode.display_name ||
        institutionNode.fullName ||
        root.institutionName ||
        root.bankName ||
        accountNode.bankName ||
        'Unknown Bank',
      bankCode:
        institutionNode.bankCode ||
        institutionNode.code ||
        institutionNode.id ||
        root.institutionCode ||
        root.bankCode ||
        '',
    },
  };
};

const normalizeTransactionShape = (tx) => {
  if (!tx || typeof tx !== 'object') return tx;
  const transactionId = tx._id || tx.id || tx.transactionId || tx.reference || null;
  return {
    ...tx,
    _id: transactionId,
    id: tx.id || transactionId,
    narration: tx.narration || tx.description || 'Bank transaction',
    type: tx.type || tx.transactionType,
    amount: Number(tx.amount || 0),
    date: tx.date || tx.createdAt || tx.postedAt,
  };
};

const formatMonoDate = (value) => {
  if (!value) return null;

  let date;
  if (value instanceof Date) {
    date = value;
  } else {
    const raw = String(value).trim();
    if (!raw) return null;

    if (/^\d{2}-\d{2}-\d{4}$/.test(raw)) {
      return raw;
    }

    const normalizedIsoLike = raw.includes('T') ? raw : raw.replace(/-/g, '/');
    date = new Date(normalizedIsoLike);
  }

  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear());
  return `${day}-${month}-${year}`;
};

// Axios instance with default config
const monoClient = axios.create({
  baseURL: MONO_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
    'accept': 'application/json',
    'mono-sec-key': MONO_SECRET_KEY
  },
  timeout: 30000 // 30 seconds
});

// Request interceptor for logging
monoClient.interceptors.request.use(
  (config) => {
    console.log(`🔵 Mono API Request: ${config.method.toUpperCase()} ${config.url}`);
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor for error handling
monoClient.interceptors.response.use(
  (response) => {
    console.log(`✅ Mono API Response: ${response.status} ${response.config.url}`);
    return response;
  },
  (error) => {
    if (error.response) {
      console.error(`❌ Mono API Error: ${error.response.status} ${error.response.data?.message || error.message}`);
    } else {
      console.error(`❌ Mono API Error: ${error.message}`);
    }
    return Promise.reject(error);
  }
);

/**
 * Exchange authorization code for account ID
 * @param {string} code - Authorization code from Mono Connect widget
 * @returns {Promise<string>} Account ID
 */
const exchangeToken = async (code) => {
  try {
    assertReadOnlyBankOperation('connect_account');
    const response = await monoClient.post('/v2/accounts/auth', { code });
    const accountId = extractAccountIdFromAuthResponse(response.data);
    if (accountId) return accountId;

    console.error('❌ Mono auth payload missing account ID:', {
      keys: Object.keys(response.data || {}),
      hasData: Boolean(response.data?.data),
      dataKeys: response.data?.data && typeof response.data.data === 'object'
        ? Object.keys(response.data.data)
        : [],
    });

    throw new Error('Mono auth succeeded but no account ID was returned');
  } catch (error) {
    if (error.response?.status === 404) {
      try {
        const fallbackResponse = await monoClient.post('/accounts/auth', { code });
        const fallbackAccountId = extractAccountIdFromAuthResponse(fallbackResponse.data);
        if (fallbackAccountId) return fallbackAccountId;

        throw new Error('Mono auth fallback succeeded but no account ID was returned');
      } catch (fallbackError) {
        throw new Error(
          `Failed to exchange token: ${fallbackError.response?.data?.message || fallbackError.message}`,
        );
      }
    }

    throw new Error(`Failed to exchange token: ${error.response?.data?.message || error.message}`);
  }
};

/**
 * Get account details
 * @param {string} accountId - Mono account ID
 * @returns {Promise<Object>} Account information
 */
const getAccountDetails = async (accountId) => {
  try {
    assertReadOnlyBankOperation('read_account_details');
    if (!accountId) {
      throw new Error('Missing Mono account ID from token exchange');
    }

    const response = await monoClient.get(`/accounts/${accountId}`);
    return normalizeAccountDetails(response.data);
  } catch (error) {
    if (error.response?.status === 404 && accountId) {
      try {
        const fallbackResponse = await monoClient.get(`/v2/accounts/${accountId}`);
        return normalizeAccountDetails(fallbackResponse.data);
      } catch (fallbackError) {
        throw new Error(
          `Failed to get account details: ${fallbackError.response?.data?.message || fallbackError.message}`,
        );
      }
    }

    throw new Error(`Failed to get account details: ${error.response?.data?.message || error.message}`);
  }
};

/**
 * Get account identity (user information)
 * @param {string} accountId - Mono account ID
 * @returns {Promise<Object>} User identity information
 */
const getAccountIdentity = async (accountId) => {
  try {
    assertReadOnlyBankOperation('read_account_details');
    const response = await monoClient.get(`/accounts/${accountId}/identity`);
    return response.data;
  } catch (error) {
    throw new Error(`Failed to get account identity: ${error.response?.data?.message || error.message}`);
  }
};

/**
 * Get account statement
 * @param {string} accountId - Mono account ID
 * @param {Object} options - Query options
 * @param {string} options.period - Period (e.g., 'last12months', 'last6months', 'last3months')
 * @param {string} options.output - Output format ('json' or 'pdf')
 * @returns {Promise<Object>} Statement data
 */
const getAccountStatement = async (accountId, options = {}) => {
  try {
    assertReadOnlyBankOperation('read_transactions');
    const { period = 'last3months', output = 'json' } = options;
    
    const response = await monoClient.get(`/accounts/${accountId}/statement`, {
      params: { period, output }
    });
    
    return response.data;
  } catch (error) {
    throw new Error(`Failed to get account statement: ${error.response?.data?.message || error.message}`);
  }
};

/**
 * Fetch transactions for an account
 * @param {string} accountId - Mono account ID
 * @param {Object} options - Query options
 * @param {Date} options.start - Start date
 * @param {Date} options.end - End date
 * @param {string} options.paginate - Pagination cursor
 * @param {number} options.limit - Number of transactions (max 500)
 * @returns {Promise<Object>} Transactions data
 */
const fetchTransactions = async (accountId, options = {}) => {
  try {
    assertReadOnlyBankOperation('read_transactions');
    const { start, end, paginate, limit = 100 } = options;
    
    const params = {
      limit: Math.min(limit, 500) // Max 500 per Mono API
    };
    
    if (start) {
      const formattedStart = formatMonoDate(start);
      if (formattedStart) {
        params.start = formattedStart;
      }
    }
    
    if (end) {
      const formattedEnd = formatMonoDate(end);
      if (formattedEnd) {
        params.end = formattedEnd;
      }
    }
    
    if (paginate) {
      params.paginate = paginate;
    }
    
    let response;
    try {
      response = await monoClient.get(`/accounts/${accountId}/transactions`, { params });
    } catch (primaryError) {
      if (primaryError.response?.status === 404) {
        response = await monoClient.get(`/v2/accounts/${accountId}/transactions`, { params });
      } else {
        throw primaryError;
      }
    }

    const body = response?.data || {};
    const dataNode = unwrapMonoData(body) || {};
    const rawTransactions = Array.isArray(body.data)
      ? body.data
      : Array.isArray(dataNode.transactions)
        ? dataNode.transactions
        : Array.isArray(dataNode.data)
          ? dataNode.data
          : [];
    const transactions = rawTransactions.map(normalizeTransactionShape).filter((tx) => tx?._id);

    return {
      transactions,
      meta: body.meta || dataNode.meta || {},
      paging: body.paging || dataNode.paging || body.pagination || dataNode.pagination || {},
    };
  } catch (error) {
    throw new Error(`Failed to fetch transactions: ${error.response?.data?.message || error.message}`);
  }
};

const getTransactions = async (accountId, options = {}) => {
  return fetchAllTransactions(accountId, options);
};

/**
 * Fetch all transactions with pagination
 * @param {string} accountId - Mono account ID
 * @param {Object} options - Query options
 * @returns {Promise<Array>} All transactions
 */
const fetchAllTransactions = async (accountId, options = {}) => {
  try {
    let allTransactions = [];
    let paginate = null;
    let hasMore = true;
    
    while (hasMore) {
      const result = await fetchTransactions(accountId, {
        ...options,
        paginate,
        limit: 500
      });
      
      allTransactions = allTransactions.concat(result.transactions);
      
      // Check if there are more pages
      if (result.paging?.next) {
        paginate = result.paging.next;
      } else {
        hasMore = false;
      }
      
      // Safety limit: max 10,000 transactions
      if (allTransactions.length >= 10000) {
        console.warn('⚠️  Reached maximum transaction limit (10,000)');
        hasMore = false;
      }
    }
    
    return allTransactions;
  } catch (error) {
    throw new Error(`Failed to fetch all transactions: ${error.message}`);
  }
};

/**
 * Get account income information
 * @param {string} accountId - Mono account ID
 * @returns {Promise<Object>} Income data
 */
const getAccountIncome = async (accountId) => {
  try {
    assertReadOnlyBankOperation('read_account_details');
    const response = await monoClient.get(`/accounts/${accountId}/income`);
    return response.data;
  } catch (error) {
    throw new Error(`Failed to get account income: ${error.response?.data?.message || error.message}`);
  }
};

/**
 * Reauthorize account (request new permissions)
 * @param {string} accountId - Mono account ID
 * @returns {Promise<Object>} Reauth token
 */
const reauthorizeAccount = async (accountId) => {
  try {
    assertReadOnlyBankOperation('reauthorize_notice');
    const response = await monoClient.post(`/accounts/${accountId}/reauthorise`);
    return response.data;
  } catch (error) {
    throw new Error(`Failed to reauthorize account: ${error.response?.data?.message || error.message}`);
  }
};

/**
 * Unlink account
 * @param {string} accountId - Mono account ID
 * @returns {Promise<Object>} Unlink confirmation
 */
const unlinkAccount = async (accountId) => {
  try {
    assertReadOnlyBankOperation('disconnect');
    const response = await monoClient.post(`/accounts/${accountId}/unlink`);
    return response.data;
  } catch (error) {
    throw new Error(`Failed to unlink account: ${error.response?.data?.message || error.message}`);
  }
};

/**
 * Sync account (trigger manual sync)
 * @param {string} accountId - Mono account ID
 * @returns {Promise<Object>} Sync result
 */
const syncAccount = async (accountId) => {
  try {
    assertReadOnlyBankOperation('read_transactions');
    const response = await monoClient.post(`/accounts/${accountId}/sync`);
    return response.data;
  } catch (error) {
    throw new Error(`Failed to sync account: ${error.response?.data?.message || error.message}`);
  }
};

/**
 * Get available institutions
 * @returns {Promise<Array>} List of supported banks
 */
const getInstitutions = async () => {
  try {
    assertReadOnlyBankOperation('read_account_details');
    const response = await monoClient.get('/coverage');
    return response.data.institutions || [];
  } catch (error) {
    throw new Error(`Failed to get institutions: ${error.response?.data?.message || error.message}`);
  }
};

/**
 * Normalize Mono transaction to our format
 * @param {Object} monoTransaction - Transaction from Mono API
 * @param {string} userId - User ID
 * @returns {Object} Normalized transaction
 */
const normalizeTransaction = (monoTransaction, userId) => {
  const normalizedInput = normalizeTransactionShape(monoTransaction);
  const isCredit = normalizedInput.type === 'credit';
  
  return {
    userId,
    amount: Math.abs(normalizedInput.amount),
    description: normalizedInput.narration || 'No description',
    date: new Date(normalizedInput.date),
    externalId: normalizedInput._id,
    paymentMethod: 'bank_transfer',
    source: isCredit ? (normalizedInput.narration || 'Bank Transfer') : undefined,
    type: isCredit ? 'income' : 'expense',
    rawData: normalizedInput
  };
};

module.exports = {
  exchangeToken,
  getAccountDetails,
  getAccountIdentity,
  getAccountStatement,
  fetchTransactions,
  fetchAllTransactions,
  getTransactions,
  getAccountIncome,
  reauthorizeAccount,
  unlinkAccount,
  syncAccount,
  getInstitutions,
  normalizeTransaction
};
