const jwt = require('jsonwebtoken');
const { errorResponse } = require('../utils/response');

/**
 * JWT Authentication Middleware
 * Verifies JWT token and attaches user info to request
 */
const authenticate = async (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse(res, 'Authentication required. Please provide a valid token.', 401);
    }

    // Extract token
    const token = authHeader.substring(7);

    if (!token) {
      return errorResponse(res, 'Authentication required. Please provide a valid token.', 401);
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Attach user info to request
    req.user = {
      userId: decoded.userId,
      id: decoded.userId,
      _id: decoded.userId
    };

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return errorResponse(res, 'Invalid token', 401);
    }
    if (error.name === 'TokenExpiredError') {
      return errorResponse(res, 'Token expired. Please login again.', 401);
    }
    return errorResponse(res, 'Authentication failed', 401);
  }
};

// Alias: `protect` is used in some route files as synonym for `authenticate`
const protect = authenticate;

module.exports = { authenticate, protect };
