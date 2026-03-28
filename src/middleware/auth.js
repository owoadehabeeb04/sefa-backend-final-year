const jwt = require('jsonwebtoken');
const { errorResponse } = require('../utils/response');
const User = require('../models/User');

const buildAuthError = (res, statusCode, message, details = null) =>
  errorResponse(res, message, statusCode, details);

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

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).select('tokenVersion isVerified onboardingCompleted onboardingStatus');

    if (!user) {
      return buildAuthError(res, 401, 'User not found');
    }

    const tokenVersion = typeof decoded.tokenVersion === 'number' ? decoded.tokenVersion : 0;
    if (tokenVersion !== (user.tokenVersion || 0)) {
      return buildAuthError(res, 401, 'Session expired. Please login again.');
    }

    // Attach user info to request
    req.user = {
      userId: decoded.userId,
      id: decoded.userId,
      _id: decoded.userId,
      tokenVersion,
    };
    req.authUser = user;

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

const requireVerifiedEmail = async (req, res, next) => {
  try {
    const user = req.authUser || await User.findById(req.user?.userId).select('isVerified onboardingCompleted onboardingStatus');

    if (!user) {
      return buildAuthError(res, 404, 'User not found');
    }

    req.authUser = user;

    if (!user.isVerified) {
      return buildAuthError(
        res,
        403,
        'Please verify your email to access this feature',
        {
          code: 'EMAIL_VERIFICATION_REQUIRED',
          requiresVerification: true,
          isVerified: false,
        }
      );
    }

    next();
  } catch (error) {
    return buildAuthError(res, 500, 'Failed to verify email status', error.message);
  }
};

const requireOnboardingComplete = async (req, res, next) => {
  try {
    const user = req.authUser || await User.findById(req.user?.userId).select('isVerified onboardingCompleted onboardingStatus');

    if (!user) {
      return buildAuthError(res, 404, 'User not found');
    }

    req.authUser = user;

    if (!user.onboardingCompleted) {
      return buildAuthError(
        res,
        403,
        'Please complete onboarding to access this feature',
        {
          code: 'ONBOARDING_REQUIRED',
          onboardingCompleted: false,
          onboardingStatus: user.onboardingStatus,
        }
      );
    }

    next();
  } catch (error) {
    return buildAuthError(res, 500, 'Failed to verify onboarding status', error.message);
  }
};

const requireOnboardingInProgress = async (req, res, next) => {
  try {
    const user = req.authUser || await User.findById(req.user?.userId).select('isVerified onboardingCompleted onboardingStatus');

    if (!user) {
      return buildAuthError(res, 404, 'User not found');
    }

    req.authUser = user;

    if (user.onboardingCompleted) {
      return buildAuthError(
        res,
        403,
        'Onboarding already completed',
        {
          code: 'ONBOARDING_ALREADY_COMPLETED',
          onboardingCompleted: true,
          onboardingStatus: user.onboardingStatus,
        }
      );
    }

    next();
  } catch (error) {
    return buildAuthError(res, 500, 'Failed to verify onboarding status', error.message);
  }
};

// Alias: `protect` is used in some route files as synonym for `authenticate`
const protect = authenticate;

module.exports = {
  authenticate,
  protect,
  requireVerifiedEmail,
  requireOnboardingComplete,
  requireOnboardingInProgress,
};
