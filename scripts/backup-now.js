#!/usr/bin/env node

/**
 * Manual Backup Script - Otedama
 * Trigger immediate backup
 */

import { createMiningPoolManager } from '../lib/mining/pool-manager.js';
import { createLogger } from '../lib/core/logger.js';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';

const logger = createLogger('Backup');
const program = new Command();

program
  .name('backup-now')
  .description('Create immediate backup of Otedama mining pool')
  .version('1.0.0')
  .option('-i, --incremental', 'Create incremental backup')
  .option('-c, --compress', 'Enable compression', true)
  .option('-e, --encrypt', 'Enable encryption', true)
  .option('--cloud', 'Upload to cloud storage')
  .option('--list', 'List available backups');

async function backup() {
  const options = program.opts();
  
  console.log(chalk.blue.bold('\n📦 Otedama Backup System\n'));
  
  try {
    // Initialize pool manager (minimal)
    const poolManager = createMiningPoolManager({
      poolName: 'Otedama Mining Pool',
      enableAutomation: true,
      automation: {
        enableAutoBackup: true
      }
    });
    
    // Initialize only backup system
    await poolManager.storage.initialize();
    poolManager.automation = {};
    
    const { BackupRecovery } = await import('../lib/core/backup-recovery.js');
    poolManager.automation.backup = new BackupRecovery({
      compressionEnabled: options.compress,
      encryptionEnabled: options.encrypt,
      cloudStorage: options.cloud ? { provider: 's3' } : null
    });
    
    await poolManager.automation.backup.initialize();
    
    // List backups if requested
    if (options.list) {
      const backups = poolManager.automation.backup.backupHistory;
      
      if (backups.length === 0) {
        console.log(chalk.yellow('No backups found'));
        process.exit(0);
      }
      
      console.log(chalk.cyan('Available Backups:\n'));
      
      backups.forEach(backup => {
        const date = new Date(backup.timestamp);
        const size = (backup.size / 1024 / 1024).toFixed(2);
        const icon = backup.status === 'success' ? '✓' : '✗';
        const color = backup.status === 'success' ? 'green' : 'red';
        
        console.log(chalk[color](`${icon} ${backup.id}`));
        console.log(chalk.gray(`   Date: ${date.toLocaleString()}`));
        console.log(chalk.gray(`   Type: ${backup.type}`));
        console.log(chalk.gray(`   Size: ${size} MB`));
        console.log(chalk.gray(`   Duration: ${backup.duration}ms`));
        console.log();
      });
      
      process.exit(0);
    }
    
    // Create backup
    const spinner = ora('Creating backup...').start();
    
    // Track progress
    poolManager.automation.backup.on('backup:started', (backup) => {
      spinner.text = `Creating ${backup.type} backup ${backup.id}`;
    });
    
    const startTime = Date.now();
    
    const backup = await poolManager.automation.backup.performBackup({
      incremental: options.incremental
    });
    
    spinner.succeed(chalk.green('Backup completed successfully!'));
    
    // Show backup details
    console.log(chalk.blue('\nBackup Details:'));
    console.log(chalk.cyan(`  ID: ${backup.id}`));
    console.log(chalk.cyan(`  Type: ${backup.type}`));
    console.log(chalk.cyan(`  Size: ${(backup.size / 1024 / 1024).toFixed(2)} MB`));
    console.log(chalk.cyan(`  Duration: ${backup.duration}ms`));
    console.log(chalk.cyan(`  Compressed: ${backup.compressed ? 'Yes' : 'No'}`));
    console.log(chalk.cyan(`  Encrypted: ${backup.encrypted ? 'Yes' : 'No'}`));
    
    if (backup.cloudUrl) {
      console.log(chalk.cyan(`  Cloud URL: ${backup.cloudUrl}`));
    }
    
    // Show backed up items
    console.log(chalk.blue('\nBacked up items:'));
    backup.items.forEach(item => {
      const icon = item.status === 'success' ? '✓' : '✗';
      const color = item.status === 'success' ? 'green' : 'red';
      const size = item.size ? ` (${(item.size / 1024).toFixed(0)} KB)` : '';
      
      console.log(chalk[color](`  ${icon} ${item.path}${size}`));
    });
    
    console.log(chalk.green.bold('\n✅ Backup created successfully!'));
    
    // Restore command hint
    console.log(chalk.gray(`\nTo restore this backup, use:`));
    console.log(chalk.gray(`  npm run restore ${backup.id}`));
    
    process.exit(0);
    
  } catch (error) {
    console.error(chalk.red.bold('\n❌ Backup failed!'));
    console.error(chalk.red(error.message));
    
    if (error.stack && process.env.DEBUG) {
      console.error(chalk.gray(error.stack));
    }
    
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('unhandledRejection', (error) => {
  console.error(chalk.red('Unhandled error:'), error);
  process.exit(1);
});

// Parse arguments and run
program.parse();
backup();
