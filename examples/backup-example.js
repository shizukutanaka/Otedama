/**
 * Backup System Example - Otedama
 * Shows how to integrate backup and recovery with the mining pool
 */

import { P2PMiningPool } from '../lib/core/p2p-mining-pool.js';
import { ShareValidationCache } from '../lib/core/share-validation-cache.js';
import { MetricsCollector } from '../lib/monitoring/metrics-collector.js';
import { DifficultyAdjuster } from '../lib/algorithms/difficulty-adjuster.js';
import { configManager } from '../lib/core/config-manager.js';
import { 
  initializeBackupSystem, 
  registerPoolComponents,
  setupAutoBackup 
} from '../lib/backup-integration.js';
import { createStructuredLogger } from '../lib/core/structured-logger.js';

const logger = createStructuredLogger('BackupExample');

async function main() {
  try {
    // Initialize pool components
    const pool = new P2PMiningPool({
      name: 'Otedama Example Pool',
      algorithm: 'sha256',
      difficulty: 1024,
      stratumPort: 3333
    });
    
    const shareCache = new ShareValidationCache({
      maxSize: 50000,
      ttl: 300000
    });
    
    const metricsCollector = new MetricsCollector({
      collectInterval: 10000,
      maxHistory: 3600
    });
    
    const difficultyAdjuster = new DifficultyAdjuster({
      targetShareTime: 30,
      strategy: 'hybrid'
    });
    
    // Load configuration
    await configManager.load();
    
    // Initialize backup system
    const backupRecovery = await initializeBackupSystem({
      backupDir: './backups',
      strategy: 'incremental',
      interval: 3600000, // 1 hour
      retention: 7 * 24 * 3600000, // 7 days
      compression: true,
      encryption: false // Enable in production with proper key management
    });
    
    // Register components for backup
    registerPoolComponents(backupRecovery, {
      pool,
      shareCache,
      metricsCollector,
      configManager,
      difficultyAdjuster
    });
    
    // Setup automatic backup on pool events
    setupAutoBackup(backupRecovery, pool);
    
    // Start backup system
    await backupRecovery.start();
    logger.info('Backup system started');
    
    // Initialize pool
    await pool.initialize();
    logger.info('Mining pool initialized');
    
    // Example: Manual backup
    setTimeout(async () => {
      logger.info('Performing manual backup...');
      const backup = await backupRecovery.performBackup({
        strategy: 'full'
      });
      logger.info('Manual backup completed', backup);
    }, 5000);
    
    // Example: List backups
    setTimeout(async () => {
      const backups = backupRecovery.listBackups({ limit: 10 });
      logger.info('Available backups:', backups);
    }, 10000);
    
    // Example: Restore from latest backup
    setTimeout(async () => {
      logger.info('Testing restore from latest backup...');
      const result = await backupRecovery.restore({
        mode: 'latest'
      });
      logger.info('Restore completed', result);
    }, 15000);
    
    // Handle shutdown
    process.on('SIGINT', async () => {
      logger.info('Shutting down...');
      
      // Perform final backup
      await backupRecovery.performBackup({ strategy: 'full' });
      
      // Stop systems
      backupRecovery.stop();
      await pool.shutdown();
      
      process.exit(0);
    });
    
  } catch (error) {
    logger.error('Failed to start backup example:', error);
    process.exit(1);
  }
}

// Run example
main();