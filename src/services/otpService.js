/**
 * OTP Service
 * Handles OTP generation, verification, expiration, and email delivery
 */

const axios = require('axios');

const OTP_EXPIRY_MINUTES = 10;
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

const getBrevoConfig = () => {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME;
  const replyToEmail = process.env.BREVO_REPLY_TO_EMAIL;

  return {
    apiKey,
    senderEmail,
    senderName,
    replyToEmail,
  };
};

const assertBrevoConfigured = () => {
  const config = getBrevoConfig();
  const missing = [];

  if (!config.apiKey) missing.push('BREVO_API_KEY');
  if (!config.senderEmail) missing.push('BREVO_SENDER_EMAIL');
  if (!config.senderName) missing.push('BREVO_SENDER_NAME');

  if (missing.length > 0) {
    const error = new Error(`Missing Brevo configuration: ${missing.join(', ')}`);
    error.code = 'BREVO_CONFIG_MISSING';
    throw error;
  }

  return config;
};

const getOtpEmailTemplate = (otp, purpose) => {
  const purposeConfig = {
    'email-verification': {
      subject: 'Verify your email address',
      heading: 'Verify your email',
      intro: 'Use the code below to verify your SEFA account.',
    },
    'password-reset': {
      subject: 'Reset your password',
      heading: 'Reset your password',
      intro: 'Use the code below to reset your SEFA account password.',
    },
    verification: {
      subject: 'Your verification code',
      heading: 'Your verification code',
      intro: 'Use the code below to complete your request.',
    },
  };

  const template = purposeConfig[purpose] || purposeConfig.verification;

  return {
    subject: `SEFA - ${template.subject}`,
    htmlContent: `
      <div style="font-family: Arial, sans-serif; background-color: #f7f8fa; padding: 24px; color: #111827;">
        <div style="max-width: 560px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; padding: 32px; border: 1px solid #e5e7eb;">
          <p style="margin: 0 0 8px; font-size: 14px; font-weight: 700; color: #ef4444;">SEFA</p>
          <h1 style="margin: 0 0 16px; font-size: 24px; line-height: 1.3;">${template.heading}</h1>
          <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.6; color: #4b5563;">${template.intro}</p>
          <div style="margin: 0 0 24px; padding: 18px; background-color: #fff1f2; border: 1px solid #fecdd3; border-radius: 12px; text-align: center;">
            <p style="margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #9f1239;">One-time password</p>
            <p style="margin: 0; font-size: 32px; font-weight: 700; letter-spacing: 0.28em; color: #be123c;">${otp}</p>
          </div>
          <p style="margin: 0 0 8px; font-size: 14px; line-height: 1.6; color: #4b5563;">This code expires in ${OTP_EXPIRY_MINUTES} minutes.</p>
          <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #4b5563;">If you did not request this code, you can safely ignore this email.</p>
        </div>
      </div>
    `,
  };
};

/**
 * Generate a new OTP
 * @returns {Object} OTP object with code and expiresAt
 */
const generateOTP = () => {
  const code = Math.floor(100000 + Math.random() * 900000).toString();

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
 * Send OTP via email using Brevo transactional email API
 * @param {string} email - Recipient email
 * @param {string} otp - OTP code
 * @param {string} purpose - Purpose of OTP (e.g., 'password-reset')
 * @returns {Promise<Object>} Send result
 */
const sendOTPEmail = async (email, otp, purpose = 'verification') => {
  const config = assertBrevoConfigured();
  const template = getOtpEmailTemplate(otp, purpose);

  try {
    const response = await axios.post(
      BREVO_API_URL,
      {
        sender: {
          name: config.senderName,
          email: config.senderEmail,
        },
        to: [{ email }],
        ...(config.replyToEmail
          ? {
              replyTo: {
                email: config.replyToEmail,
                name: config.senderName,
              },
            }
          : {}),
        subject: template.subject,
        htmlContent: template.htmlContent,
      },
      {
        headers: {
          'api-key': config.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 15000,
      }
    );

    return {
      success: true,
      message: 'OTP sent successfully',
      provider: 'brevo',
      messageId: response.data?.messageId || null,
    };
  } catch (error) {
    const details = error.response?.data?.message || error.message || 'Unknown Brevo error';
    const sendError = new Error(`Failed to send OTP email via Brevo: ${details}`);
    sendError.code = error.response?.status || 'BREVO_SEND_FAILED';
    throw sendError;
  }
};

/**
 * Send OTP via SMS (placeholder for future SMS integration)
 * @param {string} phoneNumber - Recipient phone number
 * @param {string} otp - OTP code
 * @param {string} purpose - Purpose of OTP
 * @returns {Promise<Object>} Send result
 */
const sendOTPSMS = async (phoneNumber, otp, purpose = 'verification') => {
  // TODO: Integrate SMS service (Twilio, AWS SNS, etc.)

  return {
    success: true,
    message: 'OTP sent successfully',
    provider: 'sms-placeholder'
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
  OTP_EXPIRY_MINUTES,
  assertBrevoConfigured,
};
