const crypto = require('crypto');

/**
 * Webhook Authentication Middleware
 * Verifies Mono webhook signatures
 * Documentation: https://docs.mono.co/docs/webhooks
 */

const MONO_WEBHOOK_SECRET = process.env.MONO_WEBHOOK_SECRET;

/**
 * Verify Mono webhook signature
 * Mono sends signature in x-mono-signature header
 */
const verifyMonoWebhook = (req, res, next) => {
  try {
    if (!MONO_WEBHOOK_SECRET) {
      console.error('❌ MONO_WEBHOOK_SECRET not configured');
      return res.status(500).json({
        success: false,
        message: 'Webhook secret not configured'
      });
    }
    
    const signature = req.headers['x-mono-signature'];
    
    if (!signature) {
      console.warn('⚠️  Webhook request missing signature header');
      return res.status(401).json({
        success: false,
        message: 'Missing webhook signature'
      });
    }
    
    const payload = req.rawBody instanceof Buffer
      ? req.rawBody
      : Buffer.from(JSON.stringify(req.body || {}));
    
    // Calculate expected signature
    const expectedSignature = crypto
      .createHmac('sha256', MONO_WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');
    
    // Compare signatures
    if (!secureCompare(signature, expectedSignature)) {
      console.warn('⚠️  Invalid webhook signature');
      return res.status(401).json({
        success: false,
        message: 'Invalid webhook signature'
      });
    }
    
    console.log('✅ Webhook signature verified');
    next();
  } catch (error) {
    console.error('❌ Webhook verification error:', error);
    return res.status(500).json({
      success: false,
      message: 'Webhook verification failed'
    });
  }
};

/**
 * Secure string comparison to prevent timing attacks
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} True if equal
 */
const secureCompare = (a, b) => {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (error) {
    // If lengths don't match, timingSafeEqual throws
    return false;
  }
};

/**
 * Validate webhook event type
 * @param {Array} allowedTypes - Allowed event types
 */
const validateEventType = (allowedTypes) => {
  return (req, res, next) => {
    const eventType = req.body.event;
    
    if (!eventType) {
      return res.status(400).json({
        success: false,
        message: 'Missing event type'
      });
    }
    
    if (!allowedTypes.includes(eventType)) {
      console.warn(`⚠️  Unsupported webhook event: ${eventType}`);
      return res.status(400).json({
        success: false,
        message: `Unsupported event type: ${eventType}`
      });
    }
    
    next();
  };
};

/**
 * Log webhook events
 */
const logWebhookEvent = (req, res, next) => {
  console.log('📨 Webhook received:', {
    event: req.body.event,
    timestamp: new Date().toISOString(),
    accountId: req.body.data?.account || 'unknown'
  });
  
  next();
};

/**
 * Supported Mono webhook events
 */
const MONO_EVENTS = {
  // Account events
  ACCOUNT_CONNECTED: 'mono.events.account_connected',
  ACCOUNT_REAUTHORIZED: 'mono.events.account_reauthorised',
  ACCOUNT_UPDATED: 'mono.events.account_updated',
  
  // Transaction events  
  TRANSACTION_SYNCED: 'mono.events.transaction_synced',
  
  // Auth events
  REAUTHORISATION_REQUIRED: 'mono.events.reauthorisation_required',
  
  // Account lifecycle
  ACCOUNT_LINKED: 'mono.events.account_linked',
  ACCOUNT_UNLINKED: 'mono.events.account_unlinked'
};

/**
 * Middleware to handle specific event types
 */
const handleAccountConnected = (req, res, next) => {
  if (req.body.event === MONO_EVENTS.ACCOUNT_CONNECTED) {
    req.webhookEvent = 'account_connected';
    req.accountId = req.body.data?.account;
  }
  next();
};

const handleTransactionSynced = (req, res, next) => {
  if (req.body.event === MONO_EVENTS.TRANSACTION_SYNCED) {
    req.webhookEvent = 'transaction_synced';
    req.accountId = req.body.data?.account;
  }
  next();
};

const handleReauthorizationRequired = (req, res, next) => {
  if (req.body.event === MONO_EVENTS.REAUTHORISATION_REQUIRED) {
    req.webhookEvent = 'reauthorization_required';
    req.accountId = req.body.data?.account;
  }
  next();
};

/**
 * Generic webhook handler
 */
const handleWebhookEvent = (req, res, next) => {
  const event = req.body.event;
  
  switch (event) {
    case MONO_EVENTS.ACCOUNT_CONNECTED:
      req.webhookEvent = 'account_connected';
      break;
    case MONO_EVENTS.ACCOUNT_REAUTHORIZED:
      req.webhookEvent = 'account_reauthorized';
      break;
    case MONO_EVENTS.ACCOUNT_UPDATED:
      req.webhookEvent = 'account_updated';
      break;
    case MONO_EVENTS.TRANSACTION_SYNCED:
      req.webhookEvent = 'transaction_synced';
      break;
    case MONO_EVENTS.REAUTHORISATION_REQUIRED:
      req.webhookEvent = 'reauthorization_required';
      break;
    case MONO_EVENTS.ACCOUNT_LINKED:
      req.webhookEvent = 'account_linked';
      break;
    case MONO_EVENTS.ACCOUNT_UNLINKED:
      req.webhookEvent = 'account_unlinked';
      break;
    default:
      req.webhookEvent = 'unknown';
  }
  
  req.accountId = req.body.data?.account;
  
  next();
};

module.exports = {
  verifyMonoWebhook,
  validateEventType,
  logWebhookEvent,
  handleAccountConnected,
  handleTransactionSynced,
  handleReauthorizationRequired,
  handleWebhookEvent,
  MONO_EVENTS
};
