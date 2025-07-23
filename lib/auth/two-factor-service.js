/**
 * Two-Factor Authentication Service
 * Implements TOTP-based 2FA with backup codes
 */

const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const crypto = require('crypto');
const { BaseService } = require('../common/base-service');

class TwoFactorService extends BaseService {
  constructor(options = {}) {
    super('TwoFactorService', {
      appName: options.appName || 'Otedama Pool',
      backupCodeCount: options.backupCodeCount || 10,
      backupCodeLength: options.backupCodeLength || 8,
      windowSize: options.windowSize || 2, // Allow 2 time windows for clock skew
      secretLength: options.secretLength || 32,
      ...options
    });
    
    // Track 2FA statistics
    this.authStats = {
      secretsGenerated: 0,
      tokensVerified: 0,
      tokensFailed: 0,
      backupCodesUsed: 0
    };
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
        name: `${this.config.appName} (${userIdentifier})`,
        length: this.config.secretLength,
        issuer: this.config.appName
      });

      // Generate backup codes
      const backupCodes = this.generateBackupCodes();

      // Generate QR code
      const qrCodeDataUrl = await QRCode.toDataURL(secret.otpauth_url);

      this.logger.info(`Generated 2FA secret for user: ${userIdentifier}`);
      this.authStats.secretsGenerated++;
      this.recordSuccess();

      return {
        secret: secret.base32,
        qrCode: qrCodeDataUrl,
        backupCodes: backupCodes,
        manualEntryKey: secret.base32,
        otpauthUrl: secret.otpauth_url
      };
    } catch (error) {
      this.logger.error('Error generating 2FA secret:', error);
      this.recordFailure(error);
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
      const isValid = speakeasy.totp.verify({
        secret: secret,
        encoding: 'base32',
        token: token,
        window: this.config.windowSize
      });
      
      if (isValid) {
        this.authStats.tokensVerified++;
      } else {
        this.authStats.tokensFailed++;
      }
      
      return isValid;
    } catch (error) {
      this.logger.error('Error verifying token:', error);
      this.authStats.tokensFailed++;
      return false;
    }
  }

  /**
   * Generate backup codes
   * @returns {Array<string>} Array of backup codes
   */
  generateBackupCodes() {
    const codes = [];
    for (let i = 0; i < this.config.backupCodeCount; i++) {
      const code = crypto.randomBytes(this.config.backupCodeLength / 2)
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
   * @param {string} code - The backup code to verify
   * @param {Array<string>} hashedCodes - Array of hashed backup codes
   * @returns {number} Index of matching code, or -1 if not found
   */
  verifyBackupCode(code, hashedCodes) {
    const hashedInput = this.hashBackupCode(code);
    const index = hashedCodes.indexOf(hashedInput);
    
    if (index !== -1) {
      this.authStats.backupCodesUsed++;
    }
    
    return index;
  }

  /**
   * Generate recovery codes (alias for backup codes)
   * @returns {Array<string>} Array of recovery codes
   */
  generateRecoveryCodes() {
    return this.generateBackupCodes();
  }

  /**
   * Get current TOTP token for testing/debugging
   * @param {string} secret - The user's secret
   * @returns {string} Current token
   */
  getCurrentToken(secret) {
    return speakeasy.totp({
      secret: secret,
      encoding: 'base32'
    });
  }

  /**
   * Get remaining time for current token
   * @returns {number} Seconds until token expires
   */
  getTokenTimeRemaining() {
    return 30 - (Math.floor(Date.now() / 1000) % 30);
  }

  /**
   * Validate secret format
   * @param {string} secret - The secret to validate
   * @returns {boolean} Whether the secret is valid
   */
  isValidSecret(secret) {
    try {
      // Check if it's a valid base32 string
      const base32Regex = /^[A-Z2-7]+=*$/;
      return base32Regex.test(secret) && secret.length >= 16;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get service statistics
   */
  async getStats() {
    const baseStats = await super.getStats();
    
    return {
      ...baseStats,
      auth: {
        ...this.authStats,
        successRate: this.authStats.tokensVerified > 0 
          ? this.authStats.tokensVerified / (this.authStats.tokensVerified + this.authStats.tokensFailed)
          : 0
      }
    };
  }
}

module.exports = TwoFactorService;