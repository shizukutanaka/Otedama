/**
 * Two-Factor Authentication Service
 * Implements TOTP-based 2FA with backup codes
 */

const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const crypto = require('crypto');
const { createLogger } = require('../core/logger');

const logger = createLogger('two-factor-service');

class TwoFactorService {
  constructor(options = {}) {
    this.appName = options.appName || 'Otedama Pool';
    this.backupCodeCount = options.backupCodeCount || 10;
    this.backupCodeLength = options.backupCodeLength || 8;
    this.windowSize = options.windowSize || 2; // Allow 2 time windows for clock skew
    this.secretLength = options.secretLength || 32;
  }

  /**
   * Generate a new 2FA secret for a user
   * @param {string} userIdentifier - User email or username
   * @returns {Promise<Object>} Secret data including QR code
   */
  async generateSecret(userIdentifier) {
    try {
      // Generate secret
      const secret = speakeasy.generateSecret({
        name: `${this.appName} (${userIdentifier})`,
        length: this.secretLength,
        issuer: this.appName
      });

      // Generate backup codes
      const backupCodes = this.generateBackupCodes();

      // Generate QR code
      const qrCodeDataUrl = await QRCode.toDataURL(secret.otpauth_url);

      logger.info(`Generated 2FA secret for user: ${userIdentifier}`);

      return {
        secret: secret.base32,
        qrCode: qrCodeDataUrl,
        backupCodes: backupCodes,
        manualEntryKey: secret.base32,
        otpauthUrl: secret.otpauth_url
      };
    } catch (error) {
      logger.error('Error generating 2FA secret:', error);
      throw new Error('Failed to generate 2FA secret');
    }
  }

  /**
   * Verify a TOTP token
   * @param {string} token - The 6-digit token
   * @param {string} secret - The user's secret
   * @returns {boolean} Whether the token is valid
   */
  verifyToken(token, secret) {
    try {
      return speakeasy.totp.verify({
        secret: secret,
        encoding: 'base32',
        token: token,
        window: this.windowSize
      });
    } catch (error) {
      logger.error('Error verifying token:', error);
      return false;
    }
  }

  /**
   * Generate backup codes
   * @returns {Array<string>} Array of backup codes
   */
  generateBackupCodes() {
    const codes = [];
    for (let i = 0; i < this.backupCodeCount; i++) {
      const code = crypto.randomBytes(this.backupCodeLength / 2)
        .toString('hex')
        .toUpperCase();
      codes.push(code);
    }
    return codes;
  }

  /**
   * Hash a backup code for storage
   * @param {string} code - The backup code
   * @returns {string} Hashed code
   */
  hashBackupCode(code) {
    return crypto.createHash('sha256')
      .update(code.toUpperCase())
      .digest('hex');
  }

  /**
   * Verify a backup code
   * @param {string} code - The provided backup code
   * @param {Array<string>} hashedCodes - Array of hashed backup codes
   * @returns {Object} Verification result
   */
  verifyBackupCode(code, hashedCodes) {
    const hashedInput = this.hashBackupCode(code);
    const index = hashedCodes.indexOf(hashedInput);
    
    if (index !== -1) {
      return {
        valid: true,
        index: index,
        hash: hashedInput
      };
    }
    
    return {
      valid: false,
      index: -1,
      hash: null
    };
  }

  /**
   * Generate a recovery token for account recovery
   * @param {string} userId - User ID
   * @returns {string} Recovery token
   */
  generateRecoveryToken(userId) {
    const payload = {
      userId,
      purpose: '2fa-recovery',
      timestamp: Date.now(),
      nonce: crypto.randomBytes(16).toString('hex')
    };
    
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  /**
   * Validate a recovery token
   * @param {string} token - Recovery token
   * @param {number} maxAge - Maximum age in milliseconds (default: 1 hour)
   * @returns {Object|null} Decoded payload or null if invalid
   */
  validateRecoveryToken(token, maxAge = 3600000) {
    try {
      const payload = JSON.parse(Buffer.from(token, 'base64url').toString());
      
      if (payload.purpose !== '2fa-recovery') {
        return null;
      }
      
      if (Date.now() - payload.timestamp > maxAge) {
        return null;
      }
      
      return payload;
    } catch (error) {
      logger.error('Error validating recovery token:', error);
      return null;
    }
  }

  /**
   * Generate emergency access code (for admin use)
   * @param {string} userId - User ID
   * @param {string} adminId - Admin ID authorizing the access
   * @returns {Object} Emergency access details
   */
  generateEmergencyAccess(userId, adminId) {
    const code = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();
    
    return {
      code,
      userId,
      adminId,
      timestamp,
      expiresAt: timestamp + 300000, // 5 minutes
      hash: crypto.createHash('sha256')
        .update(`${code}:${userId}:${timestamp}`)
        .digest('hex')
    };
  }

  /**
   * Get current TOTP token (for testing/debugging)
   * @param {string} secret - The secret
   * @returns {string} Current token
   */
  getCurrentToken(secret) {
    return speakeasy.totp({
      secret: secret,
      encoding: 'base32'
    });
  }

  /**
   * Check if 2FA is properly configured for a user
   * @param {Object} userConfig - User's 2FA configuration
   * @returns {Object} Configuration status
   */
  checkConfiguration(userConfig) {
    const status = {
      enabled: false,
      secretSet: false,
      backupCodesRemaining: 0,
      lastUsed: null,
      requiresSetup: true
    };

    if (!userConfig) {
      return status;
    }

    status.enabled = userConfig.enabled || false;
    status.secretSet = !!userConfig.secret;
    status.backupCodesRemaining = userConfig.backupCodes ? 
      userConfig.backupCodes.filter(code => !code.used).length : 0;
    status.lastUsed = userConfig.lastUsed || null;
    status.requiresSetup = !status.secretSet || status.backupCodesRemaining === 0;

    return status;
  }

  /**
   * Generate setup instructions for different authenticator apps
   * @param {string} secret - The secret key
   * @returns {Object} Setup instructions
   */
  getSetupInstructions(secret) {
    return {
      googleAuthenticator: {
        steps: [
          'Open Google Authenticator app',
          'Tap the + button',
          'Select "Scan a QR code" or "Enter a setup key"',
          `If entering manually, use key: ${secret}`
        ]
      },
      authy: {
        steps: [
          'Open Authy app',
          'Tap "Add Account"',
          'Scan the QR code or enter the key manually',
          `Manual key: ${secret}`
        ]
      },
      microsoft: {
        steps: [
          'Open Microsoft Authenticator app',
          'Tap "Add account"',
          'Select "Other account"',
          'Scan the QR code or enter the key',
          `Manual key: ${secret}`
        ]
      }
    };
  }
}

module.exports = TwoFactorService;