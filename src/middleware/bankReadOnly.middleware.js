const {
  FORBIDDEN_ROUTE_MATCHERS,
  READ_ONLY_ACCESS_MODE,
  ALLOWED_OPERATIONS,
  FORBIDDEN_OPERATIONS,
} = require('../services/bankReadOnly.service');

const rejectMoneyMovementRouteIntent = (req, res, next) => {
  const path = String(req.path || '');
  const isForbiddenRoute = FORBIDDEN_ROUTE_MATCHERS.some((matcher) => matcher.test(path));

  if (!isForbiddenRoute) {
    return next();
  }

  return res.status(403).json({
    success: false,
    message: 'SEFA bank integration is read-only. Money movement operations are disabled.',
    data: {
      accessMode: READ_ONLY_ACCESS_MODE,
      allowedOperations: [...ALLOWED_OPERATIONS],
      forbiddenOperations: [...FORBIDDEN_OPERATIONS],
    },
    timestamp: new Date().toISOString(),
  });
};

module.exports = {
  rejectMoneyMovementRouteIntent,
};
