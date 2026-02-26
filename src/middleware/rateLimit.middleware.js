const rateLimit = require('express-rate-limit');

/**
 * Rate Limiting Middleware
 * Protects API endpoints from abuse
 */

/**
 * General API rate limiter
 * 100 requests per 15 minutes per IP
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  handler: (req, res) => {
    console.warn(`⚠️  Rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      message: 'Too many requests. Please try again later.',
      retryAfter: req.rateLimit.resetTime
    });
  }
});

/**
 * Strict rate limiter for auth routes
 * 5 requests per 15 minutes per IP
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    message: 'Too many authentication attempts, please try again later.'
  },
  skipSuccessfulRequests: true, // Don't count successful requests
  handler: (req, res) => {
    console.warn(`⚠️  Auth rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      message: 'Too many authentication attempts. Please try again after 15 minutes.',
      retryAfter: req.rateLimit.resetTime
    });
  }
});

/**
 * File upload rate limiter
 * 10 uploads per hour per IP
 */
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: {
    success: false,
    message: 'Too many file uploads, please try again later.'
  },
  handler: (req, res) => {
    console.warn(`⚠️  Upload rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      message: 'Too many file uploads. Please try again after 1 hour.',
      retryAfter: req.rateLimit.resetTime
    });
  }
});

/**
 * Webhook rate limiter
 * 1000 requests per 15 minutes (high limit for webhooks)
 */
const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: {
    success: false,
    message: 'Webhook rate limit exceeded'
  },
  skipFailedRequests: true, // Don't count failed requests
  handler: (req, res) => {
    console.warn(`⚠️  Webhook rate limit exceeded`);
    res.status(429).json({
      success: false,
      message: 'Webhook rate limit exceeded'
    });
  }
});

/**
 * Transaction creation rate limiter
 * 100 transactions per 15 minutes per user
 */
const transactionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  keyGenerator: (req) => {
    // Use user ID instead of IP for authenticated routes
    return req.user?.id || req.ip;
  },
  handler: (req, res) => {
    console.warn(`⚠️  Transaction rate limit exceeded for user: ${req.user?.id || req.ip}`);
    res.status(429).json({
      success: false,
      message: 'Too many transactions created. Please try again later.',
      retryAfter: req.rateLimit.resetTime
    });
  }
});

/**
 * Bank sync rate limiter
 * 3 manual syncs per hour per user
 */
const syncLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  keyGenerator: (req) => {
    return req.user?.id || req.ip;
  },
  handler: (req, res) => {
    console.warn(`⚠️  Sync rate limit exceeded for user: ${req.user?.id || req.ip}`);
    res.status(429).json({
      success: false,
      message: 'Too many sync requests. Maximum 3 per hour. Please wait or enable automatic sync.',
      retryAfter: req.rateLimit.resetTime
    });
  }
});

/**
 * Create custom rate limiter
 * @param {number} windowMs - Time window in milliseconds
 * @param {number} max - Maximum requests per window
 * @param {string} message - Error message
 * @returns {Function} Rate limiter middleware
 */
const createLimiter = (windowMs, max, message) => {
  return rateLimit({
    windowMs,
    max,
    message: {
      success: false,
      message
    },
    handler: (req, res) => {
      console.warn(`⚠️  Custom rate limit exceeded: ${message}`);
      res.status(429).json({
        success: false,
        message,
        retryAfter: req.rateLimit.resetTime
      });
    }
  });
};

module.exports = {
  apiLimiter,
  authLimiter,
  uploadLimiter,
  webhookLimiter,
  transactionLimiter,
  syncLimiter,
  createLimiter
};
