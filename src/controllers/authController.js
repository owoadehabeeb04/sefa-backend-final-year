const User = require('../models/User');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const { successResponse, errorResponse } = require('../utils/response');
const otpService = require('../services/otpService');

// Generate JWT Token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m'
  });
};

// Generate Refresh Token
const generateRefreshToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d'
  });
};

/**
 * @route   POST /api/v1/auth/register
 * @desc    Register a new user (sends OTP for email verification)
 * @access  Public
 */
exports.register = async (req, res, next) => {
  try {
    // Validation is now handled by middleware, so we can proceed directly
    const { name, email, password, currency } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      // If user exists but is NOT verified, delete the old unverified account and allow re-registration
      if (!existingUser.isVerified) {
        console.log(`Deleting unverified user account for ${email} to allow re-registration`);
        await User.findByIdAndDelete(existingUser._id);
      } else {
        // User is verified - cannot re-register
        return errorResponse(res, 'User with this email already exists', 409);
      }
    }

    // Create new user (NOT verified yet)
    const user = await User.create({
      name,
      email,
      password,
      currency: currency || 'NGN',
      isVerified: false,
      onboardingCompleted: false,
      onboardingStatus: 'started'
    });

    // Generate OTP for email verification
    const otp = user.generateOTP();
    await user.save();

    // Send OTP via email
    await otpService.sendOTPEmail(user.email, otp, 'email-verification');

    // Don't generate tokens yet - wait for verification
    // Return user data (without password or tokens)
    const userData = {
      id: user._id,
      email: user.email,
      isVerified: user.isVerified
    };

    return successResponse(
      res,
      {
        user: userData,
        requiresVerification: true,
        expiresIn: `${otpService.getOTPExpiryMinutes()} minutes`
      },
      'Registration successful. Please verify your email with the OTP sent.',
      201
    );
  } catch (error) {
    console.error('Register error:', error);
    return errorResponse(res, 'Registration failed', 500, error.message);
  }
};

/**
 * @route   POST /api/v1/auth/login
 * @desc    Login user (checks verification status)
 * @access  Public
 */
exports.login = async (req, res, next) => {
  try {
    // Validation is now handled by middleware
    const { email, password } = req.body;

    // Find user and include password for comparison
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      return errorResponse(res, 'Invalid email or password', 401);
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return errorResponse(res, 'Invalid email or password', 401);
    }

    // Check if user is verified
    if (!user.isVerified) {
      // Generate tokens anyway (for OTP verification flow)
      const token = generateToken(user._id);
      const refreshToken = generateRefreshToken(user._id);

      // Return user data with verification status
      const userData = {
        id: user._id,
        name: user.name,
        email: user.email,
        currency: user.currency,
        isVerified: false,
        onboardingCompleted: user.onboardingCompleted,
        preferences: user.preferences
      };

      return successResponse(
        res,
        {
          user: userData,
          token,
          refreshToken,
          requiresVerification: true
        },
        'Login successful. Please verify your email to continue.',
        200
      );
    }

    // User is verified - proceed with normal login
    const token = generateToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    // Return user data (without password)
    const userData = {
      id: user._id,
      name: user.name,
      email: user.email,
      currency: user.currency,
      isVerified: user.isVerified,
      onboardingCompleted: user.onboardingCompleted,
      preferences: user.preferences
    };

    return successResponse(
      res,
      {
        user: userData,
        token,
        refreshToken,
        requiresVerification: false
      },
      'Login successful'
    );
  } catch (error) {
    console.error('Login error:', error);
    return errorResponse(res, 'Login failed', 500, error.message);
  }
};

/**
 * @route   GET /api/v1/auth/me
 * @desc    Get current user
 * @access  Private
 */
exports.getCurrentUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    const userData = {
      id: user._id,
      name: user.name,
      email: user.email,
      currency: user.currency,
      preferences: user.preferences,
      isVerified: user.isVerified,
      onboardingCompleted: user.onboardingCompleted,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };

    return successResponse(res, { user: userData }, 'User retrieved successfully');
  } catch (error) {
    console.error('Get current user error:', error);
    return errorResponse(res, 'Failed to retrieve user', 500, error.message);
  }
};

/**
 * @route   PUT /api/v1/auth/profile
 * @desc    Update user profile
 * @access  Private
 */
exports.updateProfile = async (req, res, next) => {
  try {
    // Validation is now handled by middleware
    const { name, currency, preferences } = req.body;
    const userId = req.user.userId;

    // Build update object
    const updateData = {};
    if (name) updateData.name = name;
    if (currency) updateData.currency = currency.toUpperCase();
    if (preferences) {
      updateData.preferences = {
        ...updateData.preferences,
        ...preferences
      };
    }

    // Update user
    const user = await User.findByIdAndUpdate(
      userId,
      updateData,
      { new: true, runValidators: true }
    );

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    const userData = {
      id: user._id,
      name: user.name,
      email: user.email,
      currency: user.currency,
      preferences: user.preferences,
      isVerified: user.isVerified,
      onboardingCompleted: user.onboardingCompleted
    };

    return successResponse(
      res,
      { user: userData },
      'Profile updated successfully'
    );
  } catch (error) {
    console.error('Update profile error:', error);
    return errorResponse(res, 'Failed to update profile', 500, error.message);
  }
};

/**
 * @route   POST /api/v1/auth/forgot-password
 * @desc    Request OTP for password reset
 * @access  Public
 */
exports.forgotPassword = async (req, res, next) => {
  try {
    // Validation is now handled by middleware
    const { email } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      // Return error if user doesn't exist (better UX)
      return errorResponse(
        res,
        'No account found with this email address. Please check your email or sign up.',
        404
      );
    }

    // Check if user is verified
    if (!user.isVerified) {
      return errorResponse(
        res,
        'Please verify your email first. Check your inbox for the verification code.',
        403
      );
    }

    // Generate OTP using OTP service
    const otp = user.generateOTP();
    await user.save();

    // Send OTP via email using OTP service
    await otpService.sendOTPEmail(user.email, otp, 'password-reset');

    return successResponse(
      res,
      {
        message: 'OTP sent to your email',
        expiresIn: `${otpService.getOTPExpiryMinutes()} minutes`
      },
      'OTP sent successfully. Please check your email.'
    );
  } catch (error) {
    console.error('Forgot password error:', error);
    return errorResponse(res, 'Failed to send OTP', 500, error.message);
  }
};

/**
 * @route   POST /api/v1/auth/reset-password
 * @desc    Reset password with OTP
 * @access  Public
 */
exports.resetPassword = async (req, res, next) => {
  try {
    // Validation is now handled by middleware
    const { email, otp, newPassword } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return errorResponse(res, 'Invalid email or OTP', 400);
    }

    // Verify OTP using OTP service
    const otpVerification = user.verifyOTP(otp);
    if (!otpVerification.valid) {
      return errorResponse(res, otpVerification.message, 400);
    }

    // Update password
    user.password = newPassword;
    user.clearOTP();
    await user.save();

    return successResponse(
      res,
      { message: 'Password reset successfully' },
      'Password has been reset successfully'
    );
  } catch (error) {
    console.error('Reset password error:', error);
    return errorResponse(res, 'Failed to reset password', 500, error.message);
  }
};

/**
 * @route   POST /api/v1/auth/logout
 * @desc    Logout user (token invalidation handled on client)
 * @access  Private
 */
exports.logout = async (req, res, next) => {
  try {
    // Token invalidation is typically handled on the client side
    // In a more advanced setup, you could maintain a token blacklist
    return successResponse(
      res,
      { message: 'Logged out successfully' },
      'Logout successful'
    );
  } catch (error) {
    console.error('Logout error:', error);
    return errorResponse(res, 'Logout failed', 500, error.message);
  }
};

/**
 * @route   POST /api/v1/auth/verify-email
 * @desc    Verify email with OTP
 * @access  Public
 */
exports.verifyEmail = async (req, res, next) => {
  try {
    // Validation is handled by middleware
    const { email, otp } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    // Check if already verified
    if (user.isVerified) {
      return successResponse(
        res,
        { user: { id: user._id, isVerified: true } },
        'Email is already verified'
      );
    }

    // Verify OTP
    const otpVerification = user.verifyOTP(otp);
    if (!otpVerification.valid) {
      return errorResponse(res, otpVerification.message, 400);
    }

    // Mark user as verified
    user.isVerified = true;
    user.clearOTP();
    await user.save();

    // Generate new tokens (user is now verified)
    const token = generateToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    const userData = {
      id: user._id,
      name: user.name,
      email: user.email,
      currency: user.currency,
      isVerified: true,
      onboardingCompleted: user.onboardingCompleted,
      preferences: user.preferences
    };

    return successResponse(
      res,
      {
        user: userData,
        token,
        refreshToken
      },
      'Email verified successfully'
    );
  } catch (error) {
    console.error('Verify email error:', error);
    return errorResponse(res, 'Failed to verify email', 500, error.message);
  }
};

/**
 * @route   POST /api/v1/auth/resend-otp
 * @desc    Resend OTP for email verification
 * @access  Public
 */
exports.resendOTP = async (req, res, next) => {
  try {
    // Validation is handled by middleware
    const { email } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      // Don't reveal if user exists for security
      return successResponse(
        res,
        { message: 'If email exists, OTP has been sent' },
        'OTP sent successfully'
      );
    }

    // Check if already verified
    if (user.isVerified) {
      return successResponse(
        res,
        { message: 'Email is already verified' },
        'Email is already verified'
      );
    }

    // Generate new OTP
    const otp = user.generateOTP();
    await user.save();

    // Send OTP via email
    await otpService.sendOTPEmail(user.email, otp, 'email-verification');

    return successResponse(
      res,
      {
        message: 'OTP sent to your email',
        expiresIn: `${otpService.getOTPExpiryMinutes()} minutes`
      },
      'OTP sent successfully. Please check your email.'
    );
  } catch (error) {
    console.error('Resend OTP error:', error);
    return errorResponse(res, 'Failed to resend OTP', 500, error.message);
  }
};

/**
 * @route   POST /api/v1/auth/refresh-token
 * @desc    Refresh access token
 * @access  Public
 */
exports.refreshToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return errorResponse(res, 'Refresh token is required', 400);
    }

    // Verify refresh token
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    
    // Check if user still exists
    const user = await User.findById(decoded.userId);
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    // Generate new access token
    const token = generateToken(user._id);

    return successResponse(
      res,
      { token },
      'Token refreshed successfully'
    );
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return errorResponse(res, 'Invalid or expired refresh token', 401);
    }
    console.error('Refresh token error:', error);
    return errorResponse(res, 'Failed to refresh token', 500, error.message);
  }
};
