/**
 * Backup Integration - Otedama
 * Integrates backup and recovery system with mining pool components
 * 
 * Design: Simple integration layer (Pike)
 */

import { BackupRecovery } from './core/backup-recovery.js';
import { createStructuredLogger } from './core/structured-logger.js';

const logger = createStructuredLogger('BackupIntegration');

/**
 * Initialize backup system with pool components
 */
export async function initializeBackupSystem(config = {}) {
  const backupRecovery = new BackupRecovery({
    backupDir: config.backupDir || './backups',
    strategy: config.strategy || 'incremental',
    interval: config.interval || 3600000, // 1 hour
    retention: config.retention || 7 * 24 * 3600000, // 7 days
    compression: config.compression !== false,
    encryption: config.encryption || false,
    encryptionKey: config.encryptionKey || null,
    verifyOnBackup: config.verifyOnBackup !== false,
    verifyOnRestore: config.verifyOnRestore !== false
  });
  
  return backupRecovery;
}

/**
 * Register pool components with backup system
 */
export function registerPoolComponents(backupRecovery, components) {
  const { pool, shareCache, metricsCollector, configManager, difficultyAdjuster } = components;
  
  // Register main pool
  if (pool) {
    backupRecovery.registerSource('pool', pool);
    logger.info('Registered pool for backup');
  }
  
  // Register share cache
  if (shareCache) {
    backupRecovery.registerSource('shareCache', {
      async getState() {
        const stats = shareCache.getStats();
        return {
          cacheData: shareCache.exportCache ? await shareCache.exportCache() : {},
          stats
        };
      },
      async setState(state) {
        if (state.cacheData && shareCache.importCache) {
          await shareCache.importCache(state.cacheData);
        }
      }
    });
    logger.info('Registered share cache for backup');
  }
  
  // Register metrics collector
  if (metricsCollector) {
    backupRecovery.registerSource('metrics', {
      async getState() {
        return {
          metrics: metricsCollector.metrics,
          counters: metricsCollector.counters,
          history: metricsCollector.exportHistory ? await metricsCollector.exportHistory() : {}
        };
      },
      async setState(state) {
        if (state.metrics) {
          Object.assign(metricsCollector.metrics, state.metrics);
        }
        if (state.counters) {
          Object.assign(metricsCollector.counters, state.counters);
        }
        if (state.history && metricsCollector.importHistory) {
          await metricsCollector.importHistory(state.history);
        }
      }
    });
    logger.info('Registered metrics collector for backup');
  }
  
  // Register config manager
  if (configManager) {
    backupRecovery.registerSource('config', {
      async getState() {
        return configManager.getAll();
      },
      async setState(state) {
        // Config is usually loaded from file, just verify
        logger.info('Config state available for recovery');
      }
    });
    logger.info('Registered config manager for backup');
  }
  
  // Register difficulty adjuster
  if (difficultyAdjuster) {
    backupRecovery.registerSource('difficulty', {
      async getState() {
        return {
          currentDifficulty: difficultyAdjuster.currentDifficulty,
          adjustmentHistory: difficultyAdjuster.adjustmentHistory,
          shareHistory: Array.from(difficultyAdjuster.shareHistory.entries()),
          blockHistory: difficultyAdjuster.blockHistory,
          stats: difficultyAdjuster.stats
        };
      },
      async setState(state) {
        if (state.currentDifficulty) {
          difficultyAdjuster.currentDifficulty = state.currentDifficulty;
        }
        if (state.adjustmentHistory) {
          difficultyAdjuster.adjustmentHistory = state.adjustmentHistory;
        }
        if (state.shareHistory) {
          difficultyAdjuster.shareHistory = new Map(state.shareHistory);
        }
        if (state.blockHistory) {
          difficultyAdjuster.blockHistory = state.blockHistory;
        }
        if (state.stats) {
          Object.assign(difficultyAdjuster.stats, state.stats);
        }
      }
    });
    logger.info('Registered difficulty adjuster for backup');
  }
}

/**
 * Create backup middleware for Express/HTTP servers
 */
export function createBackupMiddleware(backupRecovery) {
  return {
    // Trigger manual backup
    async backup(req, res) {
      try {
        const result = await backupRecovery.performBackup({
          strategy: req.body?.strategy
        });
        res.json({
          success: true,
          backup: result
        });
      } catch (error) {
        logger.error('Manual backup failed:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    },
    
    // Restore from backup
    async restore(req, res) {
      try {
        const result = await backupRecovery.restore({
          mode: req.body?.mode || 'latest',
          timestamp: req.body?.timestamp,
          backupId: req.body?.backupId,
          sources: req.body?.sources
        });
        res.json({
          success: true,
          restore: result
        });
      } catch (error) {
        logger.error('Restore failed:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    },
    
    // List backups
    async list(req, res) {
      try {
        const backups = backupRecovery.listBackups({
          type: req.query?.type,
          startDate: req.query?.startDate ? parseInt(req.query.startDate) : undefined,
          endDate: req.query?.endDate ? parseInt(req.query.endDate) : undefined,
          limit: req.query?.limit ? parseInt(req.query.limit) : 50
        });
        res.json({
          success: true,
          backups
        });
      } catch (error) {
        logger.error('List backups failed:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    },
    
    // Get backup stats
    async stats(req, res) {
      try {
        const stats = backupRecovery.getStats();
        res.json({
          success: true,
          stats
        });
      } catch (error) {
        logger.error('Get stats failed:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    }
  };
}

/**
 * Setup automatic backup on pool events
 */
export function setupAutoBackup(backupRecovery, pool) {
  // Backup on significant events
  pool.on('block:found', async () => {
    logger.info('Block found, triggering backup');
    try {
      await backupRecovery.performBackup({ strategy: 'incremental' });
    } catch (error) {
      logger.error('Auto-backup on block failed:', error);
    }
  });
  
  // Backup on shutdown
  pool.on('shutdown', async () => {
    logger.info('Pool shutting down, performing final backup');
    try {
      await backupRecovery.performBackup({ strategy: 'full' });
    } catch (error) {
      logger.error('Shutdown backup failed:', error);
    }
  });
}

export default {
  initializeBackupSystem,
  registerPoolComponents,
  createBackupMiddleware,
  setupAutoBackup
};