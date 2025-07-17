#!/usr/bin/env node

/**
 * Backup CLI for Otedama
 * Manual backup and restore operations
 */

import { BackupManager } from '../lib/backup.js';
import { resolve } from 'path';
import { readFileSync } from 'fs';

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];
const options = {};

// Parse options
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].substring(2);
    const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
    options[key] = value;
  }
}

// Load configuration
let config = {
  backupDir: resolve('./backups'),
  dataDir: resolve('./data'),
  dbPath: resolve('./data/otedama.db')
};

try {
  const configFile = readFileSync('./otedama.json', 'utf8');
  const otedamaConfig = JSON.parse(configFile);
  if (otedamaConfig.backup) {
    config = { ...config, ...otedamaConfig.backup };
  }
} catch (error) {
  console.log('Using default backup configuration');
}

// Override with command line options
if (options.backupDir) config.backupDir = resolve(options.backupDir);
if (options.dataDir) config.dataDir = resolve(options.dataDir);
if (options.dbPath) config.dbPath = resolve(options.dbPath);
if (options.retention) config.retention = parseInt(options.retention);
if (options.s3bucket) {
  config.s3 = {
    bucket: options.s3bucket,
    region: options.s3region || 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  };
}

// Create backup manager
const backupManager = new BackupManager(config);

// Command handlers
async function createBackup() {
  console.log('Creating backup...');
  console.log('Configuration:', {
    backupDir: config.backupDir,
    dataDir: config.dataDir,
    dbPath: config.dbPath,
    retention: config.retention + ' days',
    compression: config.compression !== false ? 'enabled' : 'disabled',
    s3: config.s3 ? 'configured' : 'not configured'
  });
  
  try {
    const result = await backupManager.createBackup(options.type || 'manual');
    console.log('\n✅ Backup completed successfully');
    console.log(`📁 Location: ${result.path}`);
    console.log(`🏷️  Name: ${result.name}`);
  } catch (error) {
    console.error('\n❌ Backup failed:', error.message);
    process.exit(1);
  }
}

async function restoreBackup() {
  const backupPath = args[1];
  
  if (!backupPath) {
    console.error('❌ Please specify backup path');
    console.error('Usage: npm run backup:restore <backup-path> [options]');
    process.exit(1);
  }
  
  console.log(`Restoring from backup: ${backupPath}`);
  console.log('\n⚠️  WARNING: This will overwrite existing data!');
  
  if (!options.force) {
    console.log('Use --force to confirm restoration');
    process.exit(1);
  }
  
  try {
    const result = await backupManager.restoreBackup(backupPath, {
      stopServices: options.stopServices
    });
    console.log('\n✅ Restore completed successfully');
    console.log('Backup metadata:', result.metadata);
  } catch (error) {
    console.error('\n❌ Restore failed:', error.message);
    process.exit(1);
  }
}

async function verifyBackup() {
  const backupPath = args[1];
  
  if (!backupPath) {
    console.error('❌ Please specify backup path');
    console.error('Usage: npm run backup:verify <backup-path>');
    process.exit(1);
  }
  
  console.log(`Verifying backup: ${backupPath}`);
  
  try {
    const metadata = await backupManager.verifyBackup(backupPath);
    console.log('\n✅ Backup verified successfully');
    console.log('Metadata:', metadata);
  } catch (error) {
    console.error('\n❌ Verification failed:', error.message);
    process.exit(1);
  }
}

async function listBackups() {
  const { readdir, stat } = await import('fs/promises');
  const { join } = await import('path');
  
  console.log(`Listing backups in: ${config.backupDir}`);
  
  try {
    const files = await readdir(config.backupDir);
    const backups = [];
    
    for (const file of files) {
      const filePath = join(config.backupDir, file);
      const stats = await stat(filePath);
      
      if (file.startsWith('otedama-backup-')) {
        backups.push({
          name: file,
          size: stats.size,
          created: stats.mtime,
          age: Math.floor((Date.now() - stats.mtime) / 86400000) + ' days'
        });
      }
    }
    
    if (backups.length === 0) {
      console.log('\nNo backups found');
      return;
    }
    
    console.log(`\nFound ${backups.length} backup(s):\n`);
    console.table(backups.sort((a, b) => b.created - a.created));
    
  } catch (error) {
    console.error('\n❌ Failed to list backups:', error.message);
    process.exit(1);
  }
}

async function cleanBackups() {
  console.log('Cleaning old backups...');
  console.log(`Retention period: ${config.retention} days`);
  
  try {
    await backupManager.cleanOldBackups();
    console.log('\n✅ Cleanup completed');
  } catch (error) {
    console.error('\n❌ Cleanup failed:', error.message);
    process.exit(1);
  }
}

// Help text
function showHelp() {
  console.log(`
Otedama Backup Tool

Usage: npm run backup:[command] [options]

Commands:
  create              Create a new backup
  restore <path>      Restore from a backup
  verify <path>       Verify backup integrity
  list                List all backups
  clean               Remove old backups

Options:
  --type <type>       Backup type (manual, scheduled, emergency)
  --backupDir <dir>   Backup directory path
  --dataDir <dir>     Data directory path
  --dbPath <path>     Database file path
  --retention <days>  Backup retention in days
  --s3bucket <name>   S3 bucket name for upload
  --s3region <region> S3 region (default: us-east-1)
  --force             Force restore without confirmation
  --stopServices      Stop services during restore

Environment variables:
  AWS_ACCESS_KEY_ID       AWS access key for S3 uploads
  AWS_SECRET_ACCESS_KEY   AWS secret key for S3 uploads

Examples:
  npm run backup:create
  npm run backup:create -- --type emergency --s3bucket my-backups
  npm run backup:restore ./backups/otedama-backup-manual-2025-01-16.tar.gz -- --force
  npm run backup:list
  npm run backup:clean -- --retention 3
`);
}

// Main execution
async function main() {
  switch (command) {
    case 'create':
      await createBackup();
      break;
    case 'restore':
      await restoreBackup();
      break;
    case 'verify':
      await verifyBackup();
      break;
    case 'list':
      await listBackups();
      break;
    case 'clean':
      await cleanBackups();
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      showHelp();
      break;
    default:
      console.error(`❌ Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

// Run main function
main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});