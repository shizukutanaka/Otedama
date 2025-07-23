/**
 * Two-Factor Authentication Database Integration
 * Handles database operations for 2FA
 */

const Database = require('better-sqlite3');
const { createLogger } = require('../core/logger');

const logger = createLogger('two-factor-database');

class TwoFactorDatabase {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.initializeTables();
    this.prepareStatements();
  }

  initializeTables() {
    try {
      // Create 2FA configuration table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS two_factor_auth (
          user_id TEXT PRIMARY KEY,
          secret TEXT,
          enabled INTEGER DEFAULT 0,
          enabled_at INTEGER,
          disabled_at INTEGER,
          last_used INTEGER,
          created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
          updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
        )
      `);

      // Create backup codes table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS two_factor_backup_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          code_hash TEXT NOT NULL,
          used INTEGER DEFAULT 0,
          used_at INTEGER,
          created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
          FOREIGN KEY (user_id) REFERENCES two_factor_auth(user_id) ON DELETE CASCADE,
          UNIQUE(user_id, code_hash)
        )
      `);

      // Create trusted devices table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS two_factor_trusted_devices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          device_id TEXT NOT NULL,
          device_name TEXT,
          trusted_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
          expires_at INTEGER,
          last_used INTEGER,
          FOREIGN KEY (user_id) REFERENCES two_factor_auth(user_id) ON DELETE CASCADE,
          UNIQUE(user_id, device_id)
        )
      `);

      // Create 2FA activity log
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS two_factor_activity (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          activity_type TEXT NOT NULL,
          success INTEGER DEFAULT 1,
          method TEXT,
          ip_address TEXT,
          user_agent TEXT,
          metadata TEXT,
          created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
          FOREIGN KEY (user_id) REFERENCES two_factor_auth(user_id) ON DELETE CASCADE
        )
      `);

      // Create indexes
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_two_factor_backup_codes_user_id 
        ON two_factor_backup_codes(user_id);
        
        CREATE INDEX IF NOT EXISTS idx_two_factor_trusted_devices_user_id 
        ON two_factor_trusted_devices(user_id);
        
        CREATE INDEX IF NOT EXISTS idx_two_factor_activity_user_id 
        ON two_factor_activity(user_id);
        
        CREATE INDEX IF NOT EXISTS idx_two_factor_activity_created_at 
        ON two_factor_activity(created_at);
      `);

      logger.info('2FA database tables initialized');
    } catch (error) {
      logger.error('Error initializing 2FA tables:', error);
      throw error;
    }
  }

  prepareStatements() {
    // 2FA configuration statements
    this.statements = {
      // Get 2FA config
      getConfig: this.db.prepare(`
        SELECT * FROM two_factor_auth WHERE user_id = ?
      `),

      // Create or update 2FA config
      upsertConfig: this.db.prepare(`
        INSERT INTO two_factor_auth (user_id, secret, enabled, enabled_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          secret = excluded.secret,
          enabled = excluded.enabled,
          enabled_at = excluded.enabled_at,
          disabled_at = CASE 
            WHEN excluded.enabled = 0 THEN strftime('%s', 'now') * 1000
            ELSE disabled_at
          END,
          updated_at = strftime('%s', 'now') * 1000
      `),

      // Update last used
      updateLastUsed: this.db.prepare(`
        UPDATE two_factor_auth 
        SET last_used = strftime('%s', 'now') * 1000,
            updated_at = strftime('%s', 'now') * 1000
        WHERE user_id = ?
      `),

      // Backup codes
      insertBackupCode: this.db.prepare(`
        INSERT INTO two_factor_backup_codes (user_id, code_hash)
        VALUES (?, ?)
      `),

      getBackupCodes: this.db.prepare(`
        SELECT * FROM two_factor_backup_codes
        WHERE user_id = ? AND used = 0
      `),

      useBackupCode: this.db.prepare(`
        UPDATE two_factor_backup_codes
        SET used = 1, used_at = strftime('%s', 'now') * 1000
        WHERE user_id = ? AND code_hash = ? AND used = 0
      `),

      deleteBackupCodes: this.db.prepare(`
        DELETE FROM two_factor_backup_codes WHERE user_id = ?
      `),

      // Trusted devices
      addTrustedDevice: this.db.prepare(`
        INSERT INTO two_factor_trusted_devices (user_id, device_id, device_name, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, device_id) DO UPDATE SET
          trusted_at = strftime('%s', 'now') * 1000,
          expires_at = excluded.expires_at,
          last_used = strftime('%s', 'now') * 1000
      `),

      getTrustedDevice: this.db.prepare(`
        SELECT * FROM two_factor_trusted_devices
        WHERE user_id = ? AND device_id = ? AND expires_at > strftime('%s', 'now') * 1000
      `),

      removeTrustedDevice: this.db.prepare(`
        DELETE FROM two_factor_trusted_devices
        WHERE user_id = ? AND device_id = ?
      `),

      removeExpiredDevices: this.db.prepare(`
        DELETE FROM two_factor_trusted_devices
        WHERE expires_at <= strftime('%s', 'now') * 1000
      `),

      // Activity logging
      logActivity: this.db.prepare(`
        INSERT INTO two_factor_activity (user_id, activity_type, success, method, ip_address, user_agent, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),

      getRecentActivity: this.db.prepare(`
        SELECT * FROM two_factor_activity
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `),

      // Stats
      getUserStats: this.db.prepare(`
        SELECT 
          COUNT(CASE WHEN activity_type = 'verification' AND success = 1 THEN 1 END) as successful_verifications,
          COUNT(CASE WHEN activity_type = 'verification' AND success = 0 THEN 1 END) as failed_verifications,
          COUNT(DISTINCT device_id) as trusted_devices_count,
          (SELECT COUNT(*) FROM two_factor_backup_codes WHERE user_id = ? AND used = 0) as backup_codes_remaining
        FROM two_factor_activity
        WHERE user_id = ?
      `)
    };
  }

  // Configuration methods

  async getConfig(userId) {
    try {
      return this.statements.getConfig.get(userId);
    } catch (error) {
      logger.error('Error getting 2FA config:', error);
      throw error;
    }
  }

  async saveConfig(userId, secret, enabled = true) {
    try {
      const enabledAt = enabled ? Date.now() : null;
      this.statements.upsertConfig.run(userId, secret, enabled ? 1 : 0, enabledAt);
      logger.info(`2FA config saved for user ${userId}`);
    } catch (error) {
      logger.error('Error saving 2FA config:', error);
      throw error;
    }
  }

  async updateLastUsed(userId) {
    try {
      this.statements.updateLastUsed.run(userId);
    } catch (error) {
      logger.error('Error updating last used:', error);
      throw error;
    }
  }

  // Backup codes methods

  async saveBackupCodes(userId, codeHashes) {
    const transaction = this.db.transaction(() => {
      // Delete existing codes
      this.statements.deleteBackupCodes.run(userId);
      
      // Insert new codes
      for (const hash of codeHashes) {
        this.statements.insertBackupCode.run(userId, hash);
      }
    });

    try {
      transaction();
      logger.info(`Saved ${codeHashes.length} backup codes for user ${userId}`);
    } catch (error) {
      logger.error('Error saving backup codes:', error);
      throw error;
    }
  }

  async getBackupCodes(userId) {
    try {
      return this.statements.getBackupCodes.all(userId);
    } catch (error) {
      logger.error('Error getting backup codes:', error);
      throw error;
    }
  }

  async useBackupCode(userId, codeHash) {
    try {
      const result = this.statements.useBackupCode.run(userId, codeHash);
      return result.changes > 0;
    } catch (error) {
      logger.error('Error using backup code:', error);
      throw error;
    }
  }

  // Trusted devices methods

  async addTrustedDevice(userId, deviceId, deviceName, expiresAt) {
    try {
      this.statements.addTrustedDevice.run(userId, deviceId, deviceName, expiresAt);
      logger.info(`Added trusted device ${deviceId} for user ${userId}`);
    } catch (error) {
      logger.error('Error adding trusted device:', error);
      throw error;
    }
  }

  async isTrustedDevice(userId, deviceId) {
    try {
      const device = this.statements.getTrustedDevice.get(userId, deviceId);
      return !!device;
    } catch (error) {
      logger.error('Error checking trusted device:', error);
      throw error;
    }
  }

  async removeTrustedDevice(userId, deviceId) {
    try {
      this.statements.removeTrustedDevice.run(userId, deviceId);
      logger.info(`Removed trusted device ${deviceId} for user ${userId}`);
    } catch (error) {
      logger.error('Error removing trusted device:', error);
      throw error;
    }
  }

  async cleanupExpiredDevices() {
    try {
      const result = this.statements.removeExpiredDevices.run();
      if (result.changes > 0) {
        logger.info(`Cleaned up ${result.changes} expired trusted devices`);
      }
    } catch (error) {
      logger.error('Error cleaning up expired devices:', error);
      throw error;
    }
  }

  // Activity logging methods

  async logActivity(userId, activityType, success, method, ipAddress, userAgent, metadata = null) {
    try {
      const metadataStr = metadata ? JSON.stringify(metadata) : null;
      this.statements.logActivity.run(
        userId,
        activityType,
        success ? 1 : 0,
        method,
        ipAddress,
        userAgent,
        metadataStr
      );
    } catch (error) {
      logger.error('Error logging activity:', error);
      // Don't throw - logging shouldn't break the flow
    }
  }

  async getRecentActivity(userId, limit = 10) {
    try {
      return this.statements.getRecentActivity.all(userId, limit);
    } catch (error) {
      logger.error('Error getting recent activity:', error);
      throw error;
    }
  }

  async getUserStats(userId) {
    try {
      return this.statements.getUserStats.get(userId, userId);
    } catch (error) {
      logger.error('Error getting user stats:', error);
      throw error;
    }
  }

  // Utility methods

  close() {
    try {
      this.db.close();
      logger.info('2FA database connection closed');
    } catch (error) {
      logger.error('Error closing database:', error);
    }
  }

  // Transaction wrapper
  transaction(callback) {
    return this.db.transaction(callback)();
  }
}

module.exports = TwoFactorDatabase;