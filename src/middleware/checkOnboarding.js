const User = require('../models/User');
const { errorResponse } = require('../utils/response');

/**
 * Middleware to check if user has completed onboarding
 * Restricts access to main app features until onboarding is done
 * Also checks if user email is verified
 */
const checkOnboardingCompleted = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    const user = await User.findById(userId);
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    // Check if user is verified
    if (!user.isVerified) {
      return errorResponse(
        res,
        'Please verify your email to access this feature',
        403,
        {
          isVerified: false,
          requiresVerification: true,
          message: 'Email verification required'
        }
      );
    }

    // Check if onboarding is completed
    if (!user.onboardingCompleted) {
      return errorResponse(
        res,
        'Please complete onboarding to access this feature',
        403,
        {
          onboardingCompleted: false,
          onboardingStatus: user.onboardingStatus,
          message: 'Onboarding required'
        }
      );
    }

    next();
  } catch (error) {
    console.error('Check onboarding error:', error);
    return errorResponse(res, 'Failed to verify onboarding status', 500, error.message);
  }
};

/**
 * Middleware to prevent access if onboarding is completed
 * Only allows access to onboarding endpoints during onboarding
 * Also checks if user email is verified
 */
const checkOnboardingNotCompleted = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    const user = await User.findById(userId);
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    // Check if user is verified (required for onboarding)
    if (!user.isVerified) {
      return errorResponse(
        res,
        'Please verify your email before completing onboarding',
        403,
        {
          isVerified: false,
          requiresVerification: true,
          message: 'Email verification required'
        }
      );
    }

    if (user.onboardingCompleted) {
      return errorResponse(
        res,
        'Onboarding already completed',
        400,
        {
          onboardingCompleted: true,
          message: 'You have already completed onboarding'
        }
      );
    }

    next();
  } catch (error) {
    console.error('Check onboarding not completed error:', error);
    return errorResponse(res, 'Failed to verify onboarding status', 500, error.message);
  }
};

module.exports = {
  checkOnboardingCompleted,
  checkOnboardingNotCompleted
};

