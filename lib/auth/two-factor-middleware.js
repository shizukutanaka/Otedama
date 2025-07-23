/**
 * Two-Factor Authentication Middleware
 * Handles 2FA verification in the request flow
 */

const jwt = require('jsonwebtoken');
const { createLogger } = require('../core/logger');
const TwoFactorService = require('./two-factor-service');

const logger = createLogger('two-factor-middleware');

class TwoFactorMiddleware {
  constructor(options = {}) {
    this.twoFactorService = new TwoFactorService(options);
    this.jwtSecret = options.jwtSecret || process.env.JWT_SECRET;
    this.sessionTimeout = options.sessionTimeout || 3600000; // 1 hour
    this.trustDeviceDuration = options.trustDeviceDuration || 2592000000; // 30 days
    this.maxAttempts = options.maxAttempts || 3;
    this.lockoutDuration = options.lockoutDuration || 900000; // 15 minutes
    
    // In-memory storage for demo (should use Redis in production)
    this.sessions = new Map();
    this.attempts = new Map();
    this.trustedDevices = new Map();
  }

  /**
   * Middleware to check if 2FA is required
   */
  requireTwoFactor() {
    return async (req, res, next) => {
      try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
          return res.status(401).json({
            error: 'Authentication required',
            code: 'AUTH_REQUIRED'
          });
        }

        // Verify JWT
        let decoded;
        try {
          decoded = jwt.verify(token, this.jwtSecret);
        } catch (error) {
          return res.status(401).json({
            error: 'Invalid token',
            code: 'INVALID_TOKEN'
          });
        }

        // Check if user has 2FA enabled
        const user = await this.getUserById(decoded.userId);
        
        if (!user.twoFactorEnabled) {
          req.user = user;
          return next();
        }

        // Check if 2FA session is valid
        const sessionKey = `${decoded.userId}:${decoded.sessionId}`;
        const session = this.sessions.get(sessionKey);
        
        if (!session || !session.twoFactorVerified) {
          return res.status(403).json({
            error: '2FA verification required',
            code: 'TWO_FACTOR_REQUIRED',
            sessionId: decoded.sessionId
          });
        }

        // Check session expiry
        if (Date.now() > session.expiresAt) {
          this.sessions.delete(sessionKey);
          return res.status(403).json({
            error: '2FA session expired',
            code: 'TWO_FACTOR_EXPIRED'
          });
        }

        req.user = user;
        req.twoFactorSession = session;
        next();
      } catch (error) {
        logger.error('2FA middleware error:', error);
        res.status(500).json({
          error: 'Internal server error',
          code: 'INTERNAL_ERROR'
        });
      }
    };
  }

  /**
   * Verify 2FA token endpoint handler
   */
  async verifyTwoFactor(req, res) {
    try {
      const { token, backupCode, trustDevice } = req.body;
      const { sessionId } = req.params;
      
      // Get user from JWT
      const authToken = req.headers.authorization?.split(' ')[1];
      const decoded = jwt.verify(authToken, this.jwtSecret);
      const user = await this.getUserById(decoded.userId);
      
      // Check lockout
      if (this.isLockedOut(user.id)) {
        return res.status(429).json({
          error: 'Too many failed attempts. Please try again later.',
          code: 'ACCOUNT_LOCKED'
        });
      }

      let verified = false;
      let usedBackupCode = null;

      // Verify TOTP token or backup code
      if (token) {
        verified = this.twoFactorService.verifyToken(token, user.twoFactorSecret);
      } else if (backupCode) {
        const result = this.twoFactorService.verifyBackupCode(
          backupCode,
          user.backupCodes || []
        );
        
        if (result.valid) {
          verified = true;
          usedBackupCode = result.index;
          
          // Mark backup code as used
          await this.markBackupCodeUsed(user.id, result.index);
        }
      }

      if (!verified) {
        this.recordFailedAttempt(user.id);
        
        const remainingAttempts = this.getRemainingAttempts(user.id);
        return res.status(401).json({
          error: 'Invalid verification code',
          code: 'INVALID_CODE',
          remainingAttempts
        });
      }

      // Create 2FA session
      const sessionKey = `${user.id}:${sessionId}`;
      const sessionData = {
        userId: user.id,
        sessionId,
        twoFactorVerified: true,
        verifiedAt: Date.now(),
        expiresAt: Date.now() + this.sessionTimeout,
        trustDevice: trustDevice || false,
        deviceId: req.headers['x-device-id']
      };
      
      this.sessions.set(sessionKey, sessionData);
      
      // Handle trusted device
      if (trustDevice && req.headers['x-device-id']) {
        this.trustedDevices.set(
          `${user.id}:${req.headers['x-device-id']}`,
          {
            trustedAt: Date.now(),
            expiresAt: Date.now() + this.trustDeviceDuration
          }
        );
      }

      // Clear failed attempts
      this.attempts.delete(user.id);

      // Log the verification
      logger.info(`2FA verified for user ${user.id}`, {
        method: token ? 'totp' : 'backup',
        trustDevice,
        sessionId
      });

      res.json({
        success: true,
        sessionId,
        expiresAt: sessionData.expiresAt,
        backupCodesRemaining: usedBackupCode !== null ? 
          user.backupCodes.filter(c => !c.used).length - 1 : 
          user.backupCodes?.filter(c => !c.used).length
      });
    } catch (error) {
      logger.error('2FA verification error:', error);
      res.status(500).json({
        error: 'Verification failed',
        code: 'VERIFICATION_FAILED'
      });
    }
  }

  /**
   * Setup 2FA endpoint handler
   */
  async setupTwoFactor(req, res) {
    try {
      const { userId } = req.user;
      
      // Generate secret and QR code
      const setupData = await this.twoFactorService.generateSecret(req.user.email);
      
      // Store temporarily (should expire)
      const setupKey = `setup:${userId}:${Date.now()}`;
      this.sessions.set(setupKey, {
        ...setupData,
        expiresAt: Date.now() + 600000 // 10 minutes
      });

      res.json({
        setupKey,
        qrCode: setupData.qrCode,
        manualEntryKey: setupData.manualEntryKey,
        backupCodes: setupData.backupCodes,
        instructions: this.twoFactorService.getSetupInstructions(setupData.manualEntryKey)
      });
    } catch (error) {
      logger.error('2FA setup error:', error);
      res.status(500).json({
        error: 'Setup failed',
        code: 'SETUP_FAILED'
      });
    }
  }

  /**
   * Confirm 2FA setup endpoint handler
   */
  async confirmTwoFactorSetup(req, res) {
    try {
      const { setupKey, token } = req.body;
      const { userId } = req.user;
      
      // Get setup data
      const setupData = this.sessions.get(setupKey);
      
      if (!setupData || setupData.expiresAt < Date.now()) {
        return res.status(400).json({
          error: 'Setup session expired',
          code: 'SETUP_EXPIRED'
        });
      }

      // Verify token
      const verified = this.twoFactorService.verifyToken(token, setupData.secret);
      
      if (!verified) {
        return res.status(400).json({
          error: 'Invalid verification code',
          code: 'INVALID_CODE'
        });
      }

      // Save 2FA configuration
      await this.saveTwoFactorConfig(userId, {
        secret: setupData.secret,
        backupCodes: setupData.backupCodes.map(code => ({
          hash: this.twoFactorService.hashBackupCode(code),
          used: false
        })),
        enabled: true,
        enabledAt: Date.now()
      });

      // Clean up setup session
      this.sessions.delete(setupKey);

      logger.info(`2FA enabled for user ${userId}`);

      res.json({
        success: true,
        message: '2FA has been successfully enabled'
      });
    } catch (error) {
      logger.error('2FA confirmation error:', error);
      res.status(500).json({
        error: 'Confirmation failed',
        code: 'CONFIRMATION_FAILED'
      });
    }
  }

  /**
   * Disable 2FA endpoint handler
   */
  async disableTwoFactor(req, res) {
    try {
      const { password, token } = req.body;
      const { userId } = req.user;
      
      // Verify password
      const passwordValid = await this.verifyPassword(userId, password);
      if (!passwordValid) {
        return res.status(401).json({
          error: 'Invalid password',
          code: 'INVALID_PASSWORD'
        });
      }

      // Verify 2FA token
      const user = await this.getUserById(userId);
      const verified = this.twoFactorService.verifyToken(token, user.twoFactorSecret);
      
      if (!verified) {
        return res.status(401).json({
          error: 'Invalid verification code',
          code: 'INVALID_CODE'
        });
      }

      // Disable 2FA
      await this.saveTwoFactorConfig(userId, {
        enabled: false,
        disabledAt: Date.now()
      });

      // Clear all sessions
      for (const [key, session] of this.sessions) {
        if (session.userId === userId) {
          this.sessions.delete(key);
        }
      }

      logger.info(`2FA disabled for user ${userId}`);

      res.json({
        success: true,
        message: '2FA has been disabled'
      });
    } catch (error) {
      logger.error('2FA disable error:', error);
      res.status(500).json({
        error: 'Failed to disable 2FA',
        code: 'DISABLE_FAILED'
      });
    }
  }

  // Helper methods

  isLockedOut(userId) {
    const attemptData = this.attempts.get(userId);
    if (!attemptData) return false;
    
    return attemptData.count >= this.maxAttempts && 
           Date.now() < attemptData.lockedUntil;
  }

  recordFailedAttempt(userId) {
    const attemptData = this.attempts.get(userId) || { count: 0 };
    attemptData.count++;
    attemptData.lastAttempt = Date.now();
    
    if (attemptData.count >= this.maxAttempts) {
      attemptData.lockedUntil = Date.now() + this.lockoutDuration;
    }
    
    this.attempts.set(userId, attemptData);
  }

  getRemainingAttempts(userId) {
    const attemptData = this.attempts.get(userId);
    if (!attemptData) return this.maxAttempts;
    return Math.max(0, this.maxAttempts - attemptData.count);
  }

  // These methods should be implemented with actual database operations
  async getUserById(userId) {
    // Placeholder - implement with actual database query
    return {
      id: userId,
      email: 'user@example.com',
      twoFactorEnabled: true,
      twoFactorSecret: 'secret',
      backupCodes: []
    };
  }

  async saveTwoFactorConfig(userId, config) {
    // Placeholder - implement with actual database update
    logger.info(`Saving 2FA config for user ${userId}`);
  }

  async markBackupCodeUsed(userId, codeIndex) {
    // Placeholder - implement with actual database update
    logger.info(`Marking backup code ${codeIndex} as used for user ${userId}`);
  }

  async verifyPassword(userId, password) {
    // Placeholder - implement with actual password verification
    return true;
  }
}

module.exports = TwoFactorMiddleware;