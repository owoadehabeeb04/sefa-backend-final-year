/**
 * OTP Service
 * Handles OTP generation, verification, expiration, and email delivery.
 */

const axios = require('axios');
const crypto = require('crypto');

const OTP_EXPIRY_MINUTES = 10;
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const APP_COLORS = {
  primary: '#3629B7',
  primaryLight: '#9D91FF',
  primaryDark: '#241A89',
  primaryBackground: '#F5F4FF',
  lightBackground: '#FFFFFF',
  lightBackgroundSecondary: '#FAFAFA',
  lightText: '#000000',
  lightTextSecondary: '#424242',
  lightTextTertiary: '#757575',
  lightBorder: '#E0E0E0',
  darkBackground: '#000000',
  darkBackgroundSecondary: '#0A0A0A',
  darkSurface: '#120D5B',
  darkText: '#FFFFFF',
  darkTextSecondary: '#E0E0E0',
  darkTextTertiary: '#9E9E9E',
  darkBorder: '#424242',
};
const OTP_PURPOSES = {
  EMAIL_VERIFICATION: 'email-verification',
  PASSWORD_RESET: 'password-reset',
};

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

const buildOtpCardMarkup = (otp) => {
  return otp
    .split('')
    .map(
      (digit) => `
        <td class="otp-digit" style="width: 42px; height: 52px; border-radius: 12px; border: 1px solid ${APP_COLORS.primaryLight}; background-color: ${APP_COLORS.lightBackground}; text-align: center; font-size: 26px; font-weight: 700; color: ${APP_COLORS.lightText};">
          ${digit}
        </td>
      `
    )
    .join(`
      <td style="width: 6px;">&nbsp;</td>
    `);
};

const getOtpEmailTemplate = (otp, purpose) => {
  const purposeConfig = {
    [OTP_PURPOSES.EMAIL_VERIFICATION]: {
      subject: 'Verify your email address',
      eyebrow: 'Email verification',
      heading: 'Verify your email to continue',
      intro: 'Enter this one-time password in the SEFA app to confirm this email address and continue your signup or login.',
      footer: 'If this request was not made by you, you can safely ignore this message. Your email will remain unverified until you complete the code entry in SEFA.',
    },
    [OTP_PURPOSES.PASSWORD_RESET]: {
      subject: 'Reset your password',
      eyebrow: 'Password reset request',
      heading: 'Reset your password',
      intro: 'Enter this one-time password in the SEFA app to continue resetting your password.',
      footer: 'If you did not request a password reset, ignore this email and consider changing your password from a trusted device.',
    },
    verification: {
      subject: 'Your one-time password',
      eyebrow: 'Secure access',
      heading: 'Your one-time password',
      intro: 'Enter this code in the SEFA app to complete your request.',
      footer: 'If you did not start this request, you can safely ignore this message.',
    },
  };

  const template = purposeConfig[purpose] || purposeConfig.verification;
  const textContent = [
    `SEFA - ${template.subject}`,
    '',
    template.heading,
    template.intro,
    '',
    `Code: ${otp}`,
    `Expires in ${OTP_EXPIRY_MINUTES} minutes.`,
    '',
    template.footer,
  ].join('\n');

  return {
    subject: `SEFA - ${template.subject}`,
    textContent,
    htmlContent: `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta name="color-scheme" content="light dark" />
          <meta name="supported-color-schemes" content="light dark" />
          <style>
            :root {
              color-scheme: light dark;
              supported-color-schemes: light dark;
            }
            body, table, td, p, a {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            }
            @media (prefers-color-scheme: dark) {
              .page-bg {
                background-color: ${APP_COLORS.darkBackground} !important;
              }
              .card {
                background-color: ${APP_COLORS.darkBackgroundSecondary} !important;
                border-color: ${APP_COLORS.darkBorder} !important;
              }
              .brand-text,
              .heading {
                color: ${APP_COLORS.darkText} !important;
              }
              .eyebrow,
              .body-text {
                color: ${APP_COLORS.darkTextSecondary} !important;
              }
              .footer-text {
                color: ${APP_COLORS.darkTextTertiary} !important;
              }
              .otp-wrap {
                background-color: ${APP_COLORS.darkBackground} !important;
                border-color: ${APP_COLORS.darkBorder} !important;
              }
              .otp-digit {
                background-color: ${APP_COLORS.darkBackground} !important;
                border-color: ${APP_COLORS.primaryLight} !important;
                color: ${APP_COLORS.darkText} !important;
              }
              .divider {
                border-color: ${APP_COLORS.darkBorder} !important;
              }
            }
            [data-ogsc] .page-bg {
              background-color: ${APP_COLORS.darkBackground} !important;
            }
            [data-ogsc] .card {
              background-color: ${APP_COLORS.darkBackgroundSecondary} !important;
              border-color: ${APP_COLORS.darkBorder} !important;
            }
            [data-ogsc] .brand-text,
            [data-ogsc] .heading {
              color: ${APP_COLORS.darkText} !important;
            }
            [data-ogsc] .eyebrow,
            [data-ogsc] .body-text {
              color: ${APP_COLORS.darkTextSecondary} !important;
            }
            [data-ogsc] .footer-text {
              color: ${APP_COLORS.darkTextTertiary} !important;
            }
            [data-ogsc] .otp-wrap {
              background-color: ${APP_COLORS.darkBackground} !important;
              border-color: ${APP_COLORS.darkBorder} !important;
            }
            [data-ogsc] .otp-digit {
              background-color: ${APP_COLORS.darkBackground} !important;
              border-color: ${APP_COLORS.primaryLight} !important;
              color: ${APP_COLORS.darkText} !important;
            }
            [data-ogsc] .divider {
              border-color: ${APP_COLORS.darkBorder} !important;
            }
          </style>
        </head>
        <body class="page-bg" style="margin: 0; padding: 0; background-color: ${APP_COLORS.primaryBackground}; color: ${APP_COLORS.lightText}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="page-bg" style="background-color: ${APP_COLORS.primaryBackground}; padding: 24px 12px;">
            <tr>
              <td align="center">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="card" style="max-width: 520px; background-color: ${APP_COLORS.lightBackground}; border: 1px solid ${APP_COLORS.lightBorder}; border-radius: 20px; overflow: hidden;">
                  <tr>
                    <td style="height: 4px; background-color: ${APP_COLORS.primary}; font-size: 0; line-height: 0;">&nbsp;</td>
                  </tr>
                  <tr>
                    <td style="padding: 28px 28px 0;">
                      <p class="brand-text" style="margin: 0 0 18px; color: ${APP_COLORS.primary}; font-size: 14px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;">
                        SEFA
                      </p>
                      <p class="eyebrow" style="margin: 0 0 8px; color: ${APP_COLORS.lightTextTertiary}; font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;">
                        ${template.eyebrow}
                      </p>
                      <p class="heading" style="margin: 0 0 10px; color: ${APP_COLORS.lightText}; font-size: 26px; line-height: 1.3; font-weight: 700;">
                        ${template.heading}
                      </p>
                      <p class="body-text" style="margin: 0; color: ${APP_COLORS.lightTextSecondary}; font-size: 15px; line-height: 1.7;">
                        ${template.intro}
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 22px 28px 0;">
                      <div class="otp-wrap" style="padding: 18px; border-radius: 18px; border: 1px solid ${APP_COLORS.lightBorder}; background-color: ${APP_COLORS.primaryBackground};">
                        <table role="presentation" align="center" cellspacing="0" cellpadding="0" border="0">
                          <tr>
                            ${buildOtpCardMarkup(otp)}
                          </tr>
                        </table>
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 18px 28px 0;">
                      <p class="body-text" style="margin: 0; color: ${APP_COLORS.lightTextSecondary}; font-size: 14px; line-height: 1.7; text-align: center;">
                        This code expires in <strong>${OTP_EXPIRY_MINUTES} minutes</strong>.
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 18px 28px 0;">
                      <div class="divider" style="border-top: 1px solid ${APP_COLORS.lightBorder}; font-size: 0; line-height: 0;">&nbsp;</div>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 18px 28px 28px;">
                      <p class="body-text" style="margin: 0 0 10px; color: ${APP_COLORS.lightTextSecondary}; font-size: 13px; line-height: 1.7;">
                        ${template.footer}
                      </p>
                      <p class="footer-text" style="margin: 0; color: ${APP_COLORS.lightTextTertiary}; font-size: 12px; line-height: 1.6;">
                        Need help? Reply to this email and the SEFA team will assist you.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
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

const hashOTP = (otp) => {
  const hmac = crypto.createHmac('sha256', process.env.JWT_SECRET || 'sefa-otp-fallback-secret');
  hmac.update(String(otp));
  return hmac.digest('hex');
};

const createOTPRecord = (otp, purpose) => {
  const now = new Date();

  return {
    codeHash: hashOTP(otp),
    purpose,
    expiresAt: new Date(now.getTime() + OTP_EXPIRY_MINUTES * 60 * 1000),
    attempts: 0,
    lastSentAt: now,
    lockedUntil: null,
  };
};

const getSecondsUntil = (date) => {
  if (!date) {
    return 0;
  }

  return Math.max(0, Math.ceil((new Date(date).getTime() - Date.now()) / 1000));
};

const canResendOTP = (otpRecord) => {
  const secondsRemaining = getSecondsUntil(
    otpRecord?.lastSentAt
      ? new Date(new Date(otpRecord.lastSentAt).getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1000)
      : null
  );

  return {
    allowed: secondsRemaining === 0,
    secondsRemaining,
  };
};

/**
 * Verify OTP
 * @param {string} providedOTP - OTP provided by user
 * @param {Object} otpRecord - OTP record stored in the database
 * @param {string} purpose - Purpose the OTP should match
 * @returns {Object} Verification result
 */
const verifyOTP = (providedOTP, otpRecord, purpose) => {
  if (!otpRecord?.codeHash || !providedOTP) {
    return {
      valid: false,
      message: 'OTP is required',
      code: 'OTP_REQUIRED',
    };
  }

  if (purpose && otpRecord.purpose !== purpose) {
    return {
      valid: false,
      message: 'This code is not valid for this request',
      code: 'OTP_WRONG_PURPOSE',
    };
  }

  if (otpRecord.lockedUntil && new Date(otpRecord.lockedUntil) > new Date()) {
    return {
      valid: false,
      message: `Too many incorrect attempts. Request a new code in ${getSecondsUntil(otpRecord.lockedUntil)} seconds.`,
      code: 'OTP_LOCKED',
      retryAfterSeconds: getSecondsUntil(otpRecord.lockedUntil),
    };
  }

  if (otpRecord.expiresAt && new Date(otpRecord.expiresAt) < new Date()) {
    return {
      valid: false,
      message: 'OTP has expired',
      code: 'OTP_EXPIRED',
    };
  }

  const providedHash = hashOTP(providedOTP);
  const storedBuffer = Buffer.from(otpRecord.codeHash, 'hex');
  const providedBuffer = Buffer.from(providedHash, 'hex');

  if (
    storedBuffer.length !== providedBuffer.length
    || !crypto.timingSafeEqual(storedBuffer, providedBuffer)
  ) {
    const attempts = (otpRecord.attempts || 0) + 1;
    const remainingAttempts = Math.max(0, OTP_MAX_ATTEMPTS - attempts);
    const lockedUntil = attempts >= OTP_MAX_ATTEMPTS
      ? new Date(Date.now() + OTP_RESEND_COOLDOWN_SECONDS * 1000)
      : null;

    return {
      valid: false,
      message: lockedUntil
        ? `Too many incorrect attempts. Request a new code in ${OTP_RESEND_COOLDOWN_SECONDS} seconds.`
        : `Invalid OTP. ${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} remaining.`,
      code: lockedUntil ? 'OTP_LOCKED' : 'OTP_INVALID',
      attempts,
      lockedUntil,
      remainingAttempts,
      retryAfterSeconds: lockedUntil ? OTP_RESEND_COOLDOWN_SECONDS : undefined,
    };
  }

  return {
    valid: true,
    message: 'OTP verified successfully',
    code: 'OTP_VALID',
  };
};

/**
 * Check if OTP is expired
 * @param {Date} expiresAt - OTP expiration date
 * @returns {boolean} True if expired
 */
const isOTPExpired = (expiresAt) => !expiresAt || new Date(expiresAt) < new Date();

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
        textContent: template.textContent,
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
  hashOTP,
  createOTPRecord,
  canResendOTP,
  verifyOTP,
  isOTPExpired,
  getOTPExpiryMinutes,
  maskOTP,
  sendOTPEmail,
  sendOTPSMS,
  OTP_EXPIRY_MINUTES,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_MAX_ATTEMPTS,
  OTP_PURPOSES,
  assertBrevoConfigured,
};
