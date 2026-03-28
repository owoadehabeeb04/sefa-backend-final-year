const jwt = require('jsonwebtoken');
const User = require('../models/User');
const otpService = require('../services/otpService');
const { successResponse, errorResponse } = require('../utils/response');

const buildUserPayload = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  currency: user.currency,
  preferences: user.preferences,
  isVerified: user.isVerified,
  onboardingCompleted: user.onboardingCompleted,
  onboardingStatus: user.onboardingStatus,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const generateToken = (user) => jwt.sign(
  { userId: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
);

const generateRefreshToken = (user) => jwt.sign(
  { userId: user._id.toString(), tokenVersion: user.tokenVersion || 0 },
  process.env.JWT_REFRESH_SECRET,
  { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
);

const issueAuthTokens = (user) => ({
  token: generateToken(user),
  refreshToken: generateRefreshToken(user),
});

const findUserByEmail = (email, includePassword = false) => {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const query = User.findOne({ email: normalizedEmail });

  return includePassword ? query.select('+password') : query;
};

const sendEmailNotFoundResponse = (res) => errorResponse(
  res,
  'We could not find an account for this email address.',
  404,
  { code: 'EMAIL_NOT_FOUND' }
);

const sendEmailVerificationStatusResponse = (res, message, statusCode = 403, code = 'EMAIL_NOT_VERIFIED') =>
  errorResponse(res, message, statusCode, { code });

const sendOtpVerification = async (user, purpose) => {
  const otp = user.generateOTP(purpose);
  await user.save();
  await otpService.sendOTPEmail(user.email, otp, purpose);
};

const persistOtpFailure = async (user, verificationResult) => {
  if (typeof verificationResult.attempts === 'number') {
    await user.save();
  }
};

const verifyUserOtp = async (user, otp, purpose) => {
  const verification = user.verifyOTP(otp, purpose);

  if (!verification.valid) {
    await persistOtpFailure(user, verification);
  }

  return verification;
};

const respondWithOtpError = (res, verification) => {
  const statusCode = verification.code === 'OTP_LOCKED' ? 429 : 400;
  return errorResponse(res, verification.message, statusCode, {
    code: verification.code,
    retryAfterSeconds: verification.retryAfterSeconds,
    remainingAttempts: verification.remainingAttempts,
  });
};

/**
 * @route   POST /api/v1/auth/register
 * @desc    Register a new user (sends OTP for email verification)
 * @access  Public
 */
exports.register = async (req, res) => {
  try {
    const { name, email, password, currency } = req.body;

    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      if (!existingUser.isVerified) {
        await User.findByIdAndDelete(existingUser._id);
      } else {
        return errorResponse(res, 'User with this email already exists', 409);
      }
    }

    const user = await User.create({
      name,
      email,
      password,
      currency: currency || 'NGN',
      isVerified: false,
      onboardingCompleted: false,
      onboardingStatus: 'started',
    });

    await sendOtpVerification(user, otpService.OTP_PURPOSES.EMAIL_VERIFICATION);

    return successResponse(
      res,
      {
        user: {
          id: user._id,
          email: user.email,
          isVerified: user.isVerified,
          onboardingCompleted: user.onboardingCompleted,
          onboardingStatus: user.onboardingStatus,
        },
        requiresVerification: true,
        expiresIn: `${otpService.getOTPExpiryMinutes()} minutes`,
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
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await findUserByEmail(email, true);

    if (!user) {
      return errorResponse(res, 'Invalid email or password', 401);
    }

    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return errorResponse(res, 'Invalid email or password', 401);
    }

    if (!user.isVerified) {
      return successResponse(
        res,
        {
          user: {
            id: user._id,
            name: user.name,
            email: user.email,
            currency: user.currency,
            isVerified: false,
            onboardingCompleted: user.onboardingCompleted,
            onboardingStatus: user.onboardingStatus,
            preferences: user.preferences,
          },
          requiresVerification: true,
        },
        'Login successful. Please verify your email to continue.'
      );
    }

    const { token, refreshToken } = issueAuthTokens(user);

    return successResponse(
      res,
      {
        user: buildUserPayload(user),
        token,
        refreshToken,
        requiresVerification: false,
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
exports.getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    return successResponse(res, { user: buildUserPayload(user) }, 'User retrieved successfully');
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
exports.updateProfile = async (req, res) => {
  try {
    const { name, currency, preferences } = req.body;
    const user = await User.findById(req.user.userId);

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    if (name) user.name = name;
    if (currency) user.currency = currency.toUpperCase();
    if (preferences) {
      user.preferences = {
        ...user.preferences,
        ...preferences,
      };
    }

    await user.save();

    return successResponse(
      res,
      { user: buildUserPayload(user) },
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
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await findUserByEmail(email);

    if (!user) {
      return sendEmailNotFoundResponse(res);
    }

    if (!user.isVerified) {
      return sendEmailVerificationStatusResponse(
        res,
        'Please verify your email before resetting your password.'
      );
    }

    const resendStatus = user.canResendOTP(otpService.OTP_PURPOSES.PASSWORD_RESET);
    if (!resendStatus.allowed) {
      return errorResponse(res, 'Please wait before requesting another code', 429, {
        code: 'OTP_RESEND_TOO_SOON',
        retryAfterSeconds: resendStatus.secondsRemaining,
      });
    }

    await sendOtpVerification(user, otpService.OTP_PURPOSES.PASSWORD_RESET);
    return successResponse(
      res,
      {
        message: 'OTP sent to your email',
        expiresIn: `${otpService.getOTPExpiryMinutes()} minutes`,
        resendAvailableInSeconds: otpService.OTP_RESEND_COOLDOWN_SECONDS,
      },
      'OTP sent successfully. Please check your email.'
    );
  } catch (error) {
    console.error('Forgot password error:', error);
    return errorResponse(res, 'Failed to send OTP', 500, error.message);
  }
};

/**
 * @route   POST /api/v1/auth/verify-password-reset-otp
 * @desc    Verify password reset OTP before accepting a new password
 * @access  Public
 */
exports.verifyPasswordResetOTP = async (req, res) => {
  try {
    const { email, otp } = req.body;
    const user = await findUserByEmail(email);

    if (!user) {
      return sendEmailNotFoundResponse(res);
    }

    if (!user.isVerified) {
      return sendEmailVerificationStatusResponse(
        res,
        'Please verify your email before using password reset.'
      );
    }

    const verification = await verifyUserOtp(user, otp, otpService.OTP_PURPOSES.PASSWORD_RESET);
    if (!verification.valid) {
      return respondWithOtpError(res, verification);
    }

    return successResponse(
      res,
      { canResetPassword: true },
      'OTP verified successfully'
    );
  } catch (error) {
    console.error('Verify password reset OTP error:', error);
    return errorResponse(res, 'Failed to verify OTP', 500, error.message);
  }
};

/**
 * @route   POST /api/v1/auth/reset-password
 * @desc    Reset password with OTP
 * @access  Public
 */
exports.resetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    const user = await findUserByEmail(email, true);

    if (!user) {
      return sendEmailNotFoundResponse(res);
    }

    if (!user.isVerified) {
      return sendEmailVerificationStatusResponse(
        res,
        'Please verify your email before resetting your password.'
      );
    }

    const verification = await verifyUserOtp(user, otp, otpService.OTP_PURPOSES.PASSWORD_RESET);
    if (!verification.valid) {
      return respondWithOtpError(res, verification);
    }

    user.password = newPassword;
    user.clearOTP(otpService.OTP_PURPOSES.PASSWORD_RESET);
    user.bumpTokenVersion();
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
 * @desc    Logout user from all sessions
 * @access  Private
 */
exports.logout = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const user = await User.findById(req.user.userId);

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    if (
      decoded.userId !== user._id.toString()
      || (decoded.tokenVersion || 0) !== (user.tokenVersion || 0)
    ) {
      return errorResponse(res, 'Invalid refresh token', 401);
    }

    user.bumpTokenVersion();
    await user.save();

    return successResponse(
      res,
      { message: 'Logged out successfully' },
      'Logout successful'
    );
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return errorResponse(res, 'Invalid refresh token', 401);
    }

    console.error('Logout error:', error);
    return errorResponse(res, 'Logout failed', 500, error.message);
  }
};

/**
 * @route   POST /api/v1/auth/verify-email
 * @desc    Verify email with OTP
 * @access  Public
 */
exports.verifyEmail = async (req, res) => {
  try {
    const { email, otp } = req.body;
    const user = await findUserByEmail(email);

    if (!user) {
      return sendEmailNotFoundResponse(res);
    }

    if (user.isVerified) {
      return successResponse(
        res,
        { user: buildUserPayload(user) },
        'Email is already verified'
      );
    }

    const verification = await verifyUserOtp(user, otp, otpService.OTP_PURPOSES.EMAIL_VERIFICATION);
    if (!verification.valid) {
      return respondWithOtpError(res, verification);
    }

    user.isVerified = true;
    user.clearOTP(otpService.OTP_PURPOSES.EMAIL_VERIFICATION);
    await user.save();

    const { token, refreshToken } = issueAuthTokens(user);

    return successResponse(
      res,
      {
        user: buildUserPayload(user),
        token,
        refreshToken,
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
exports.resendOTP = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await findUserByEmail(email);

    if (!user) {
      return sendEmailNotFoundResponse(res);
    }

    if (user.isVerified) {
      return sendEmailVerificationStatusResponse(
        res,
        'This email is already verified. Please sign in instead.',
        409,
        'EMAIL_ALREADY_VERIFIED'
      );
    }

    const resendStatus = user.canResendOTP(otpService.OTP_PURPOSES.EMAIL_VERIFICATION);
    if (!resendStatus.allowed) {
      return errorResponse(res, 'Please wait before requesting another code', 429, {
        code: 'OTP_RESEND_TOO_SOON',
        retryAfterSeconds: resendStatus.secondsRemaining,
      });
    }

    await sendOtpVerification(user, otpService.OTP_PURPOSES.EMAIL_VERIFICATION);

    return successResponse(
      res,
      {
        message: 'OTP sent to your email',
        expiresIn: `${otpService.getOTPExpiryMinutes()} minutes`,
        resendAvailableInSeconds: otpService.OTP_RESEND_COOLDOWN_SECONDS,
      },
      'OTP sent successfully. Please check your email.'
    );
  } catch (error) {
    console.error('Resend OTP error:', error);
    return errorResponse(res, 'Failed to resend OTP', 500, error.message);
  }
};

/**
 * @route   POST /api/v1/auth/resend-password-reset-otp
 * @desc    Resend OTP for password reset
 * @access  Public
 */
exports.resendPasswordResetOTP = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await findUserByEmail(email);

    if (!user) {
      return sendEmailNotFoundResponse(res);
    }

    if (!user.isVerified) {
      return sendEmailVerificationStatusResponse(
        res,
        'Please verify your email before requesting another reset code.'
      );
    }

    const resendStatus = user.canResendOTP(otpService.OTP_PURPOSES.PASSWORD_RESET);
    if (!resendStatus.allowed) {
      return errorResponse(res, 'Please wait before requesting another code', 429, {
        code: 'OTP_RESEND_TOO_SOON',
        retryAfterSeconds: resendStatus.secondsRemaining,
      });
    }

    await sendOtpVerification(user, otpService.OTP_PURPOSES.PASSWORD_RESET);
    return successResponse(
      res,
      {
        message: 'OTP sent to your email',
        expiresIn: `${otpService.getOTPExpiryMinutes()} minutes`,
        resendAvailableInSeconds: otpService.OTP_RESEND_COOLDOWN_SECONDS,
      },
      'OTP sent successfully. Please check your email.'
    );
  } catch (error) {
    console.error('Resend password reset OTP error:', error);
    return errorResponse(res, 'Failed to resend OTP', 500, error.message);
  }
};

/**
 * @route   POST /api/v1/auth/refresh-token
 * @desc    Refresh access token
 * @access  Public
 */
exports.refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return errorResponse(res, 'Refresh token is required', 400);
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.userId);

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    if ((decoded.tokenVersion || 0) !== (user.tokenVersion || 0)) {
      return errorResponse(res, 'Invalid or expired refresh token', 401);
    }

    const token = generateToken(user);

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
