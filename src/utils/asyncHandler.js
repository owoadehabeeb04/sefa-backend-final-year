/**
 * asyncHandler — wraps an async route handler and forwards errors to next()
 * Usage (default export): const asyncHandler = require('../utils/asyncHandler');
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
