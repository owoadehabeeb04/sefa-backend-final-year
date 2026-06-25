const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate, requireVerifiedEmail } = require('../middleware/auth');
const {
  authLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  refreshTokenLimiter,
} = require('../middleware/rateLimit.middleware');
const {
  validateRegister,
  validateLogin,
  validateUpdateProfile,
  validateForgotPassword,
  validateResetPassword,
  validateChangePassword,
  validateLogout,
  validateRefreshToken,
  validateVerifyEmail,
  validateVerifyPasswordResetOTP,
  validateResendOTP,
  validateResendPasswordResetOTP,
} = require('../middleware/validators');

/**
 * @swagger
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         name:
 *           type: string
 *         email:
 *           type: string
 *         currency:
 *           type: string
 *         isVerified:
 *           type: boolean
 *         onboardingCompleted:
 *           type: boolean
 *         preferences:
 *           type: object
 *           properties:
 *             notifications:
 *               type: boolean
 *             theme:
 *               type: string
 *               enum: [light, dark]
 *             language:
 *               type: string
 *     AuthResponse:
 *       type: object
 *       properties:
 *         user:
 *           $ref: '#/components/schemas/User'
 *         token:
 *           type: string
 *         refreshToken:
 *           type: string
 *   securitySchemes:
 *     bearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 */

/**
 * @swagger
 * /api/v1/auth/register:
 *   post:
 *     summary: Register a new user (sends OTP for email verification)
 *     description: Creates a new user account and sends an OTP to the provided email. User must verify email before accessing the app.
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *               - password
 *             properties:
 *               name:
 *                 type: string
 *                 example: John Doe
 *               email:
 *                 type: string
 *                 example: john@example.com
 *               password:
 *                 type: string
 *                 example: SecurePass123!
 *               currency:
 *                 type: string
 *                 example: NGN
 *     responses:
 *       201:
 *         description: User registered successfully. OTP sent to email.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                     expiresIn:
 *                       type: string
 *                       description: OTP validity period
 *                 message:
 *                   type: string
 *       409:
 *         description: User already exists
 *       422:
 *         description: Validation error
 */
router.post('/register', authLimiter, validateRegister, authController.register);

/**
 * @swagger
 * /api/v1/auth/login:
 *   post:
 *     summary: Login user (checks email verification status)
 *     description: Authenticates user and returns tokens. If user is not verified, requiresVerification flag is set to true.
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 example: john@example.com
 *               password:
 *                 type: string
 *                 example: SecurePass123!
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                     token:
 *                       type: string
 *                     refreshToken:
 *                       type: string
 *                     requiresVerification:
 *                       type: boolean
 *                       description: true if user needs to verify email
 *                 message:
 *                   type: string
 *       401:
 *         description: Invalid credentials
 *       422:
 *         description: Validation error
 */
router.post('/login', authLimiter, validateLogin, authController.login);

/**
 * @swagger
 * /api/v1/auth/me:
 *   get:
 *     summary: Get current user profile
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized
 */
router.get('/me', authenticate, authController.getCurrentUser);

/**
 * @swagger
 * /api/v1/auth/profile:
 *   put:
 *     summary: Update user profile
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 example: John Updated
 *               currency:
 *                 type: string
 *                 example: USD
 *               preferences:
 *                 type: object
 *                 properties:
 *                   notifications:
 *                     type: boolean
 *                   theme:
 *                     type: string
 *                     enum: [light, dark]
 *                   language:
 *                     type: string
 *     responses:
 *       200:
 *         description: Profile updated successfully
 *       401:
 *         description: Unauthorized
 *       422:
 *         description: Validation error
 */
router.put('/profile', authenticate, requireVerifiedEmail, validateUpdateProfile, authController.updateProfile);

/**
 * @swagger
 * /api/v1/auth/forgot-password:
 *   post:
 *     summary: Request OTP for password reset
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 example: john@example.com
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     message:
 *                       type: string
 *                 message:
 *                   type: string
 *       422:
 *         description: Validation error
 */
router.post('/forgot-password', otpRequestLimiter, validateForgotPassword, authController.forgotPassword);

router.post(
  '/verify-password-reset-otp',
  otpVerifyLimiter,
  validateVerifyPasswordResetOTP,
  authController.verifyPasswordResetOTP
);

/**
 * @swagger
 * /api/v1/auth/reset-password:
 *   post:
 *     summary: Reset password with OTP
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - otp
 *               - newPassword
 *             properties:
 *               email:
 *                 type: string
 *                 example: john@example.com
 *               otp:
 *                 type: string
 *                 example: "123456"
 *               newPassword:
 *                 type: string
 *                 example: NewSecurePass123!
 *     responses:
 *       200:
 *         description: Password reset successfully
 *       400:
 *         description: Invalid or expired OTP
 *       422:
 *         description: Validation error
 */
router.post('/reset-password', otpVerifyLimiter, validateResetPassword, authController.resetPassword);

/**
 * @swagger
 * /api/v1/auth/change-password:
 *   post:
 *     summary: Change password for the authenticated user (no OTP)
 *     description: Verifies the current password and sets a new one. Returns fresh tokens so the current device stays signed in while other sessions are invalidated.
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - currentPassword
 *               - newPassword
 *             properties:
 *               currentPassword:
 *                 type: string
 *                 example: OldSecurePass123!
 *               newPassword:
 *                 type: string
 *                 example: NewSecurePass123!
 *     responses:
 *       200:
 *         description: Password changed successfully
 *       400:
 *         description: New password must differ from the current password
 *       401:
 *         description: Current password is incorrect / unauthorized
 *       422:
 *         description: Validation error
 */
router.post(
  '/change-password',
  authenticate,
  requireVerifiedEmail,
  validateChangePassword,
  authController.changePassword
);

/**
 * @swagger
 * /api/v1/auth/logout:
 *   post:
 *     summary: Logout user
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logout successful
 *       401:
 *         description: Unauthorized
 */
router.post('/logout', authenticate, validateLogout, authController.logout);

/**
 * @swagger
 * /api/v1/auth/verify-email:
 *   post:
 *     summary: Verify email with OTP
 *     description: Verifies user email using the OTP sent during registration. Marks user as verified and returns new tokens.
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - otp
 *             properties:
 *               email:
 *                 type: string
 *                 example: john@example.com
 *               otp:
 *                 type: string
 *                 example: "123456"
 *                 description: 6-digit OTP code
 *     responses:
 *       200:
 *         description: Email verified successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                     token:
 *                       type: string
 *                     refreshToken:
 *                       type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid or expired OTP
 *       404:
 *         description: User not found
 *       422:
 *         description: Validation error
 */
router.post('/verify-email', otpVerifyLimiter, validateVerifyEmail, authController.verifyEmail);

/**
 * @swagger
 * /api/v1/auth/resend-otp:
 *   post:
 *     summary: Resend OTP for email verification
 *     description: Resends a new OTP to the user's email for verification. Only works if user is not already verified.
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 example: john@example.com
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     message:
 *                       type: string
 *                     expiresIn:
 *                       type: string
 *                       description: OTP validity period
 *                 message:
 *                   type: string
 *       422:
 *         description: Validation error
 */
router.post('/resend-otp', otpRequestLimiter, validateResendOTP, authController.resendOTP);

router.post(
  '/resend-password-reset-otp',
  otpRequestLimiter,
  validateResendPasswordResetOTP,
  authController.resendPasswordResetOTP
);

/**
 * @swagger
 * /api/v1/auth/refresh-token:
 *   post:
 *     summary: Refresh access token
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Token refreshed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     token:
 *                       type: string
 *                 message:
 *                   type: string
 *       401:
 *         description: Invalid or expired refresh token
 */
router.post('/refresh-token', refreshTokenLimiter, validateRefreshToken, authController.refreshToken);

module.exports = router;
