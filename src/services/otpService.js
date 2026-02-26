/**
 * OTP Service
 * Handles OTP generation, verification, and expiration
 */

// Default OTP for development/testing
const DEFAULT_OTP = '111111';
const OTP_EXPIRY_MINUTES = 10;

/**
 * Generate a new OTP
 * @param {Object} options - Options for OTP generation
 * @param {boolean} options.useDefault - Use default OTP (for development)
 * @returns {Object} OTP object with code and expiresAt
 */
const generateOTP = (options = {}) => {
  const { useDefault = process.env.NODE_ENV === 'development' } = options;

  let code;
  if (useDefault) {
    code = DEFAULT_OTP;
  } else {
    // Generate 6-digit random OTP
    code = Math.floor(100000 + Math.random() * 900000).toString();
  }

  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  return {
    code,
    expiresAt
  };
};

/**
 * Verify OTP
 * @param {string} providedOTP - OTP provided by user
 * @param {string} storedOTP - OTP stored in database
 * @param {Date} expiresAt - OTP expiration date
 * @returns {Object} Verification result
 */
const verifyOTP = (providedOTP, storedOTP, expiresAt) => {
  // Check if OTP exists
  if (!storedOTP || !providedOTP) {
    return {
      valid: false,
      message: 'OTP is required'
    };
  }

  // Check if OTP is expired
  if (expiresAt && new Date(expiresAt) < new Date()) {
    return {
      valid: false,
      message: 'OTP has expired'
    };
  }

  // Verify OTP code
  if (storedOTP !== providedOTP) {
    return {
      valid: false,
      message: 'Invalid OTP'
    };
  }

  return {
    valid: true,
    message: 'OTP verified successfully'
  };
};

/**
 * Check if OTP is expired
 * @param {Date} expiresAt - OTP expiration date
 * @returns {boolean} True if expired
 */
const isOTPExpired = (expiresAt) => {
  if (!expiresAt) return true;
  return new Date(expiresAt) < new Date();
};

/**
 * Get OTP expiry time in minutes
 * @returns {number} Expiry time in minutes
 */
const getOTPExpiryMinutes = () => {
  return OTP_EXPIRY_MINUTES;
};

/**
 * Format OTP for display (masked for security)
 * @param {string} otp - OTP code
 * @returns {string} Masked OTP (e.g., "11****")
 */
const maskOTP = (otp) => {
  if (!otp || otp.length < 4) return '******';
  return otp.substring(0, 2) + '****';
};

/**
 * Send OTP via email (placeholder for email service integration)
 * @param {string} email - Recipient email
 * @param {string} otp - OTP code
 * @param {string} purpose - Purpose of OTP (e.g., 'password-reset')
 * @returns {Promise<Object>} Send result
 */
const sendOTPEmail = async (email, otp, purpose = 'verification') => {
  // TODO: Integrate email service (SendGrid, Nodemailer, etc.)
  
  // For development, log OTP to console
  if (process.env.NODE_ENV === 'development') {
    console.log('\n=== OTP EMAIL (Development Mode) ===');
    console.log(`To: ${email}`);
    console.log(`Purpose: ${purpose}`);
    console.log(`OTP: ${otp}`);
    console.log(`Expires in: ${OTP_EXPIRY_MINUTES} minutes`);
    console.log('=====================================\n');
  }

  // Return success (in production, this would be actual email service response)
  return {
    success: true,
    message: 'OTP sent successfully',
    // In development, include OTP for testing
    ...(process.env.NODE_ENV === 'development' && { otp })
  };
};

/**
 * Send OTP via SMS (placeholder for SMS service integration)
 * @param {string} phoneNumber - Recipient phone number
 * @param {string} otp - OTP code
 * @param {string} purpose - Purpose of OTP
 * @returns {Promise<Object>} Send result
 */
const sendOTPSMS = async (phoneNumber, otp, purpose = 'verification') => {
  // TODO: Integrate SMS service (Twilio, AWS SNS, etc.)
  
  // For development, log OTP to console
  if (process.env.NODE_ENV === 'development') {
    console.log('\n=== OTP SMS (Development Mode) ===');
    console.log(`To: ${phoneNumber}`);
    console.log(`Purpose: ${purpose}`);
    console.log(`OTP: ${otp}`);
    console.log(`Expires in: ${OTP_EXPIRY_MINUTES} minutes`);
    console.log('==================================\n');
  }

  return {
    success: true,
    message: 'OTP sent successfully',
    ...(process.env.NODE_ENV === 'development' && { otp })
  };
};

module.exports = {
  generateOTP,
  verifyOTP,
  isOTPExpired,
  getOTPExpiryMinutes,
  maskOTP,
  sendOTPEmail,
  sendOTPSMS,
  DEFAULT_OTP,
  OTP_EXPIRY_MINUTES
};


