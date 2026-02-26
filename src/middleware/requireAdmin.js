/**
 * requireAdmin Middleware
 *
 * Guards scheduler and internal operations routes.
 * Uses a shared secret rather than a DB role field since
 * the User model has no isAdmin flag.
 *
 * Set  ADMIN_SECRET_KEY  in .env to enable strict checking.
 * In development (NODE_ENV !== 'production') the check is
 * bypassed so the routes stay accessible without extra setup.
 */
const { errorResponse } = require('../utils/response');

const requireAdmin = (req, res, next) => {
  // In non-production mode allow all authenticated users through
  if (process.env.NODE_ENV !== 'production') {
    return next();
  }

  const adminKey = process.env.ADMIN_SECRET_KEY;

  // If no admin key is configured, block access in production
  if (!adminKey) {
    return errorResponse(res, 'Admin access not configured', 403);
  }

  const provided = req.headers['x-admin-key'];
  if (!provided || provided !== adminKey) {
    return errorResponse(res, 'Admin access required', 403);
  }

  next();
};

module.exports = { requireAdmin };
