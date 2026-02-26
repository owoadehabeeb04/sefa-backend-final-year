const axios = require('axios');

/**
 * Mono API Service
 * Documentation: https://docs.mono.co
 */

const MONO_BASE_URL = process.env.MONO_ENVIRONMENT === 'production'
  ? 'https://api.withmono.com'
  : 'https://api.withmono.com'; // Same URL for test and production

const MONO_SECRET_KEY = process.env.MONO_SECRET_KEY;

// Axios instance with default config
const monoClient = axios.create({
  baseURL: MONO_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
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
    const response = await monoClient.post('/account/auth', { code });
    return response.data.id; // Account ID
  } catch (error) {
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
    const response = await monoClient.get(`/accounts/${accountId}`);
    return response.data;
  } catch (error) {
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
    const { start, end, paginate, limit = 100 } = options;
    
    const params = {
      limit: Math.min(limit, 500) // Max 500 per Mono API
    };
    
    if (start) {
      params.start = start instanceof Date 
        ? start.toISOString().split('T')[0] 
        : start;
    }
    
    if (end) {
      params.end = end instanceof Date 
        ? end.toISOString().split('T')[0] 
        : end;
    }
    
    if (paginate) {
      params.paginate = paginate;
    }
    
    const response = await monoClient.get(`/accounts/${accountId}/transactions`, {
      params
    });
    
    return {
      transactions: response.data.data || [],
      meta: response.data.meta || {},
      paging: response.data.paging || {}
    };
  } catch (error) {
    throw new Error(`Failed to fetch transactions: ${error.response?.data?.message || error.message}`);
  }
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
  const isCredit = monoTransaction.type === 'credit';
  
  return {
    userId,
    amount: Math.abs(monoTransaction.amount),
    description: monoTransaction.narration || 'No description',
    date: new Date(monoTransaction.date),
    externalId: monoTransaction._id,
    paymentMethod: 'bank_transfer',
    source: isCredit ? (monoTransaction.narration || 'Bank Transfer') : undefined,
    type: isCredit ? 'income' : 'expense',
    rawData: monoTransaction
  };
};

module.exports = {
  exchangeToken,
  getAccountDetails,
  getAccountIdentity,
  getAccountStatement,
  fetchTransactions,
  fetchAllTransactions,
  getAccountIncome,
  reauthorizeAccount,
  unlinkAccount,
  syncAccount,
  getInstitutions,
  normalizeTransaction
};
