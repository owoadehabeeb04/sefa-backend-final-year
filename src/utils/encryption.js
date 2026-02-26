const crypto = require('crypto');

/**
 * Encryption utility for sensitive data (e.g., bank tokens)
 * Uses AES-256-CBC encryption
 */

// Get encryption configuration from environment
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ALGORITHM = process.env.ENCRYPTION_ALGORITHM || 'aes-256-cbc';
const IV_LENGTH = 16; // AES block size

/**
 * Validates that encryption key is properly configured
 * @throws {Error} If encryption key is missing or invalid
 */
const validateEncryptionKey = () => {
  if (!ENCRYPTION_KEY) {
    throw new Error(
      'ENCRYPTION_KEY is not set in environment variables. ' +
      'Generate one with: openssl rand -hex 32'
    );
  }

  // Ensure key is the right length for AES-256 (32 bytes = 64 hex characters)
  if (ENCRYPTION_KEY.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY must be 64 characters (32 bytes in hex). ' +
      'Current length: ' + ENCRYPTION_KEY.length
    );
  }
};

/**
 * Encrypts text using AES-256-CBC
 * @param {string} text - Plain text to encrypt
 * @returns {string} Encrypted text in format: iv:encryptedData
 * @throws {Error} If encryption fails or text is invalid
 */
const encrypt = (text) => {
  if (!text) {
    throw new Error('Text to encrypt cannot be empty');
  }

  validateEncryptionKey();

  try {
    // Generate random initialization vector
    const iv = crypto.randomBytes(IV_LENGTH);

    // Convert hex key to buffer
    const key = Buffer.from(ENCRYPTION_KEY, 'hex');

    // Create cipher
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    // Encrypt the text
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Return IV and encrypted data separated by ':'
    // This allows us to decrypt later using the same IV
    return iv.toString('hex') + ':' + encrypted;
  } catch (error) {
    throw new Error('Encryption failed: ' + error.message);
  }
};

/**
 * Decrypts text encrypted with encrypt()
 * @param {string} encryptedText - Encrypted text in format: iv:encryptedData
 * @returns {string} Decrypted plain text
 * @throws {Error} If decryption fails or format is invalid
 */
const decrypt = (encryptedText) => {
  if (!encryptedText) {
    throw new Error('Encrypted text cannot be empty');
  }

  validateEncryptionKey();

  try {
    // Split IV and encrypted data
    const parts = encryptedText.split(':');
    if (parts.length !== 2) {
      throw new Error('Invalid encrypted text format. Expected: iv:encryptedData');
    }

    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];

    // Convert hex key to buffer
    const key = Buffer.from(ENCRYPTION_KEY, 'hex');

    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

    // Decrypt the text
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    throw new Error('Decryption failed: ' + error.message);
  }
};

/**
 * Generates a secure encryption key
 * This is a utility function for initial setup
 * @returns {string} 64-character hex string (32 bytes)
 */
const generateEncryptionKey = () => {
  return crypto.randomBytes(32).toString('hex');
};

/**
 * Hashes sensitive data for comparison without storing original
 * Useful for webhook signatures, API keys verification
 * @param {string} text - Text to hash
 * @returns {string} SHA256 hash in hex format
 */
const hash = (text) => {
  if (!text) {
    throw new Error('Text to hash cannot be empty');
  }

  return crypto
    .createHash('sha256')
    .update(text)
    .digest('hex');
};

/**
 * Verifies HMAC signature (for webhook validation)
 * @param {string} data - Data that was signed
 * @param {string} signature - Signature to verify
 * @param {string} secret - Secret key used for signing
 * @returns {boolean} True if signature is valid
 */
const verifySignature = (data, signature, secret) => {
  if (!data || !signature || !secret) {
    return false;
  }

  try {
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(data)
      .digest('hex');

    // Use timing-safe comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch (error) {
    return false;
  }
};

module.exports = {
  encrypt,
  decrypt,
  generateEncryptionKey,
  hash,
  verifySignature
};
