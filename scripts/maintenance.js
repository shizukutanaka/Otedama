#!/usr/bin/env node

/**
 * Otedama Maintenance Script
 * Cleanup and optimization tasks
 * 
 * Usage:
 *   node scripts/maintenance.js [command]
 * 
 * Commands:
 *   clean-backups     Remove backup files (.bak)
 *   clean-shares      Clean old share data
 *   optimize-db       Optimize database
 *   clean-logs        Clean old log files
 *   full-cleanup      Run all cleanup tasks
 */

import { createLogger } from '../lib/core/logger.js';
import { Command } from 'commander';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const logger = createLogger('Maintenance');

const program = new Command();

program
  .name('maintenance')
  .description('Otedama maintenance and cleanup utilities')
  .version('1.0.0');

/**
 * Clean backup files
 */
program
  .command('clean-backups')
  .description('Remove all .bak backup files')
  .action(async () => {
    logger.info('Cleaning backup files...');
    
    const backupFiles = [
      'lib/api/batch-endpoints.js.bak',
      'lib/api/social-endpoints.js.bak',
      'lib/mining/_old_optimized-share-validator.js.bak',
      'lib/mining/_old_share-validation-worker.js.bak',
      'lib/mining/_old_share-validator-enhanced.js.bak',
      'lib/mining/_old_share-validator-optimized.js.bak',
      'lib/mining/_old_share-validator-simple.js.bak',
      'lib/mining/_old_unified-mining-pool.js.bak',
      'lib/mining/_old_zero-copy-share-validator.js.bak'
    ];
    
    let removed = 0;
    for (const file of backupFiles) {
      try {
        const fullPath = path.join(projectRoot, file);
        await fs.unlink(fullPath);
        logger.info(`Removed: ${file}`);
        removed++;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.error(`Failed to remove ${file}: ${error.message}`);
        }
      }
    }
    
    logger.info(`Removed ${removed} backup files`);
  });

/**
 * Clean old shares
 */
program
  .command('clean-shares')
  .description('Clean share data older than 7 days')
  .option('-d, --days <days>', 'Days to keep', parseInt, 7)
  .action(async (options) => {
    logger.info(`Cleaning shares older than ${options.days} days...`);
    
    try {
      const { createStorageManager } = await import('../lib/storage/index.js');
      const storage = createStorageManager({
        dataDir: './data',
        dbFile: 'otedama-pool.db'
      });
      
      await storage.initialize();
      
      const cutoffTime = Date.now() - (options.days * 24 * 60 * 60 * 1000);
      
      // Clean old shares
      const result = await storage.database.run(`
        DELETE FROM shares WHERE timestamp < ?
      `, cutoffTime);
      
      logger.info(`Removed ${result.changes} old shares`);
      
      // Clean orphaned payment_shares
      await storage.database.run(`
        DELETE FROM payment_shares 
        WHERE share_id NOT IN (SELECT id FROM shares)
      `);
      
      await storage.shutdown();
      
    } catch (error) {
      logger.error('Failed to clean shares:', error);
    }
  });

/**
 * Optimize database
 */
program
  .command('optimize-db')
  .description('Vacuum and analyze database')
  .action(async () => {
    logger.info('Optimizing database...');
    
    try {
      const { createStorageManager } = await import('../lib/storage/index.js');
      const storage = createStorageManager({
        dataDir: './data',
        dbFile: 'otedama-pool.db'
      });
      
      await storage.initialize();
      
      // Vacuum database
      await storage.database.run('VACUUM');
      logger.info('Database vacuumed');
      
      // Analyze tables
      await storage.database.run('ANALYZE');
      logger.info('Database analyzed');
      
      // Get database stats
      const stats = await storage.database.get(`
        SELECT 
          page_count * page_size as size,
          page_count,
          page_size
        FROM pragma_page_count(), pragma_page_size()
      `);
      
      logger.info(`Database size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      
      await storage.shutdown();
      
    } catch (error) {
      logger.error('Failed to optimize database:', error);
    }
  });

/**
 * Clean log files
 */
program
  .command('clean-logs')
  .description('Clean old log files')
  .option('-d, --days <days>', 'Days to keep', parseInt, 7)
  .action(async (options) => {
    logger.info(`Cleaning logs older than ${options.days} days...`);
    
    const logsDir = path.join(projectRoot, 'logs');
    
    try {
      const files = await fs.readdir(logsDir);
      const cutoffTime = Date.now() - (options.days * 24 * 60 * 60 * 1000);
      let removed = 0;
      
      for (const file of files) {
        if (file.endsWith('.log') && !file.includes('current')) {
          const filePath = path.join(logsDir, file);
          const stats = await fs.stat(filePath);
          
          if (stats.mtime.getTime() < cutoffTime) {
            await fs.unlink(filePath);
            logger.info(`Removed: ${file}`);
            removed++;
          }
        }
      }
      
      logger.info(`Removed ${removed} old log files`);
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.info('No logs directory found');
      } else {
        logger.error('Failed to clean logs:', error);
      }
    }
  });

/**
 * Full cleanup
 */
program
  .command('full-cleanup')
  .description('Run all cleanup tasks')
  .action(async () => {
    logger.info('Running full cleanup...');
    
    // Clean backups
    await program.parseAsync(['node', 'maintenance.js', 'clean-backups']);
    
    // Clean old shares
    await program.parseAsync(['node', 'maintenance.js', 'clean-shares']);
    
    // Clean logs
    await program.parseAsync(['node', 'maintenance.js', 'clean-logs']);
    
    // Optimize database
    await program.parseAsync(['node', 'maintenance.js', 'optimize-db']);
    
    logger.info('Full cleanup completed');
  });

/**
 * Remove duplicate files
 */
program
  .command('remove-duplicates')
  .description('Remove duplicate and unnecessary files')
  .action(async () => {
    logger.info('Removing duplicate files...');
    
    const duplicateFiles = [
      'lib/api/social-endpoints.js',
      'lib/api/ml-endpoints.js',
      'lib/api/bot-endpoints.js',
      'lib/api/notification-endpoints.js',
      'lib/api/swagger-integration.js',
      'lib/api/api-documentation-manager.js',
      'lib/api/openapi-generator.js',
      'lib/mining/asic-resistant-algorithm.js',
      'lib/mining/fault-tolerance-system.js',
      'lib/mining/gpu-acceleration.js',
      'lib/mining/gpu-optimizer.js',
      'lib/mining/hardware-interface.js',
      'lib/mining/hardware-optimization.js',
      'lib/mining/merge-mining.js',
      'lib/mining/merged-mining.js',
      'lib/mining/multi-chain-mining.js',
      'lib/mining/native-miner.js',
      'lib/mining/optimized-mining-engine.js',
      'lib/mining/secure-stratum-server.js',
      'lib/mining/simple-cpu-miner.js',
      'lib/mining/simple-gpu-miner.js',
      'lib/mining/smart-profit-switching.js'
    ];
    
    let removed = 0;
    for (const file of duplicateFiles) {
      try {
        const fullPath = path.join(projectRoot, file);
        await fs.unlink(fullPath);
        logger.info(`Removed: ${file}`);
        removed++;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.error(`Failed to remove ${file}: ${error.message}`);
        }
      }
    }
    
    // Remove empty directories
    const emptyDirs = [
      'lib/blockchain',
      'lib/wallet',
      'lib/standalone',
      'lib/wasm',
      'lib/workers',
      'lib/mining/ai',
      'lib/mining/difficulty',
      'lib/mining/memory',
      'lib/mining/monitoring'
    ];
    
    for (const dir of emptyDirs) {
      try {
        const fullPath = path.join(projectRoot, dir);
        await fs.rmdir(fullPath);
        logger.info(`Removed empty directory: ${dir}`);
        removed++;
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') {
          logger.error(`Failed to remove directory ${dir}: ${error.message}`);
        }
      }
    }
    
    logger.info(`Removed ${removed} duplicate files and directories`);
  });

// Parse arguments
program.parse();

// Show help if no command
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
