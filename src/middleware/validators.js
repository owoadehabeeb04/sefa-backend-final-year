const { body, validationResult } = require('express-validator');
const {
  AMOUNT_TOO_LARGE_MESSAGE,
  isSafeCurrencyAmount,
} = require('../utils/amountValidation');

// Middleware to handle validation errors
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      error: {
        message: 'Validation failed',
        details: errors.array()
      },
      timestamp: new Date().toISOString()
    });
  }
  next();
};

// Registration validation
exports.validateRegister = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2 and 50 characters'),
  
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email')
    .normalizeEmail(),
  
  body('password')
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),
  
  body('currency')
    .optional()
    .isLength({ min: 3, max: 3 })
    .withMessage('Currency must be a 3-letter code (e.g., NGN, USD)')
    .isUppercase()
    .withMessage('Currency must be uppercase'),
  
  handleValidationErrors
];

// Login validation
exports.validateLogin = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email')
    .normalizeEmail(),
  
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
  
  handleValidationErrors
];

// Update profile validation
exports.validateUpdateProfile = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2 and 50 characters'),
  
  body('currency')
    .optional()
    .isLength({ min: 3, max: 3 })
    .withMessage('Currency must be a 3-letter code (e.g., NGN, USD)')
    .isUppercase()
    .withMessage('Currency must be uppercase'),
  
  body('preferences.notifications')
    .optional()
    .isBoolean()
    .withMessage('Notifications preference must be a boolean'),
  
  body('preferences.theme')
    .optional()
    .isIn(['light', 'dark'])
    .withMessage('Theme must be either "light" or "dark"'),
  
  body('preferences.language')
    .optional()
    .isLength({ min: 2, max: 5 })
    .withMessage('Language must be a valid language code'),
  
  handleValidationErrors
];

// Forgot password validation
exports.validateForgotPassword = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email')
    .normalizeEmail(),
  
  handleValidationErrors
];

// Reset password validation
exports.validateResetPassword = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email')
    .normalizeEmail(),
  
  body('otp')
    .notEmpty()
    .withMessage('OTP is required')
    .isLength({ min: 6, max: 6 })
    .withMessage('OTP must be 6 digits')
    .isNumeric()
    .withMessage('OTP must be numeric'),
  
  body('newPassword')
    .notEmpty()
    .withMessage('New password is required')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),
  
  handleValidationErrors
];

// Refresh token validation
exports.validateRefreshToken = [
  body('refreshToken')
    .notEmpty()
    .withMessage('Refresh token is required'),
  
  handleValidationErrors
];

// Logout validation
exports.validateLogout = [
  body('refreshToken')
    .notEmpty()
    .withMessage('Refresh token is required'),

  handleValidationErrors
];

// Verify email validation
exports.validateVerifyEmail = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email')
    .normalizeEmail(),
  
  body('otp')
    .notEmpty()
    .withMessage('OTP is required')
    .isLength({ min: 6, max: 6 })
    .withMessage('OTP must be 6 digits')
    .isNumeric()
    .withMessage('OTP must be numeric'),
  
  handleValidationErrors
];

// Verify password reset OTP validation
exports.validateVerifyPasswordResetOTP = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email')
    .normalizeEmail(),

  body('otp')
    .notEmpty()
    .withMessage('OTP is required')
    .isLength({ min: 6, max: 6 })
    .withMessage('OTP must be 6 digits')
    .isNumeric()
    .withMessage('OTP must be numeric'),

  handleValidationErrors
];

// Resend OTP validation
exports.validateResendOTP = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email')
    .normalizeEmail(),
  
  handleValidationErrors
];

// Resend password reset OTP validation
exports.validateResendPasswordResetOTP = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email')
    .normalizeEmail(),

  handleValidationErrors
];

// Expense validation
exports.validateExpense = [
  body('categoryId')
    .notEmpty()
    .withMessage('Category ID is required')
    .isMongoId()
    .withMessage('Invalid category ID'),
  
  body('amount')
    .notEmpty()
    .withMessage('Amount is required')
    .isFloat({ min: 0.01 })
    .withMessage('Amount must be greater than 0'),
  
  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Description cannot exceed 500 characters'),
  
  body('date')
    .optional()
    .isISO8601()
    .withMessage('Invalid date format'),
  
  body('paymentMethod')
    .optional()
    .isIn(['cash', 'card', 'bank_transfer', 'mobile_money', 'other'])
    .withMessage('Invalid payment method'),
  
  body('location')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('Location cannot exceed 200 characters'),
  
  body('tags')
    .optional()
    .isArray()
    .withMessage('Tags must be an array'),
  
  handleValidationErrors
];

// Income validation
exports.validateIncome = [
  body('categoryId')
    .notEmpty()
    .withMessage('Category ID is required')
    .isMongoId()
    .withMessage('Invalid category ID'),
  
  body('amount')
    .notEmpty()
    .withMessage('Amount is required')
    .isFloat({ min: 0.01 })
    .withMessage('Amount must be greater than 0')
    .bail()
    .custom((value) => {
      if (!isSafeCurrencyAmount(Number(value))) {
        throw new Error(AMOUNT_TOO_LARGE_MESSAGE);
      }
      return true;
    }),
  
  body('source')
    .notEmpty()
    .withMessage('Income source is required')
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Source must be between 1 and 200 characters'),
  
  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Description cannot exceed 500 characters'),
  
  body('date')
    .optional()
    .isISO8601()
    .withMessage('Invalid date format'),
  
  body('paymentMethod')
    .optional()
    .isIn(['cash', 'card', 'bank_transfer', 'mobile_money', 'other'])
    .withMessage('Invalid payment method'),
  
  body('tags')
    .optional()
    .isArray()
    .withMessage('Tags must be an array'),
  
  handleValidationErrors
];

exports.validateIncomeUpdate = [
  body('categoryId')
    .optional()
    .isMongoId()
    .withMessage('Invalid category ID'),

  body('amount')
    .optional()
    .isFloat({ min: 0.01 })
    .withMessage('Amount must be greater than 0')
    .bail()
    .custom((value) => {
      if (!isSafeCurrencyAmount(Number(value))) {
        throw new Error(AMOUNT_TOO_LARGE_MESSAGE);
      }
      return true;
    }),

  body('source')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Source must be between 1 and 200 characters'),

  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Description cannot exceed 500 characters'),

  body('date')
    .optional()
    .isISO8601()
    .withMessage('Invalid date format'),

  body('paymentMethod')
    .optional()
    .isIn(['cash', 'card', 'bank_transfer', 'mobile_money', 'other'])
    .withMessage('Invalid payment method'),

  body('tags')
    .optional()
    .isArray()
    .withMessage('Tags must be an array'),

  handleValidationErrors
];
