#!/usr/bin/env node
// Backup manager CLI tool
import { getBackupManager } from '../src/backup/backup-manager';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  const command = process.argv[2];
  const backupManager = getBackupManager();
  
  try {
    switch (command) {
      case 'list':
        console.log('Listing available backups...\n');
        const backups = await backupManager.listBackups();
        
        if (backups.length === 0) {
          console.log('No backups found.');
          break;
        }
        
        backups.forEach((backup, index) => {
          const date = new Date(backup.timestamp).toLocaleString();
          console.log(`${index + 1}. Backup from ${date}`);
          console.log(`   Miners: ${backup.poolStats.totalMiners} (${backup.poolStats.activeMiners} active)`);
          console.log(`   Shares: ${backup.poolStats.totalShares}`);
          console.log(`   Blocks: ${backup.poolStats.totalBlocks}`);
          console.log(`   Files: ${backup.files.join(', ')}`);
          console.log(`   Compressed: ${backup.compressed}\n`);
        });
        break;
        
      case 'restore':
        const backupName = process.argv[3];
        if (!backupName) {
          console.error('Please specify backup name to restore');
          console.log('Usage: npm run backup:restore backup-<timestamp>');
          process.exit(1);
        }
        
        console.log(`Restoring backup: ${backupName}`);
        console.log('WARNING: This will overwrite current data!');
        console.log('Make sure the pool is stopped before continuing.');
        
        // Simple confirmation
        console.log('\nPress Ctrl+C to cancel or Enter to continue...');
        await new Promise(resolve => {
          process.stdin.once('data', resolve);
        });
        
        await backupManager.restoreBackup(backupName);
        console.log('Restore completed successfully!');
        break;
        
      case 'backup':
        console.log('Performing manual backup...');
        const backupPath = await backupManager.backup();
        console.log(`Backup completed: ${backupPath}`);
        break;
        
      case 'stats':
        const stats = await backupManager.getStats();
        console.log('Backup Statistics:');
        console.log(`  Enabled: ${stats.enabled}`);
        console.log(`  Total backups: ${stats.totalBackups}`);
        console.log(`  Total size: ${(stats.totalSize / 1024 / 1024).toFixed(2)} MB`);
        if (stats.lastBackup) {
          console.log(`  Last backup: ${stats.lastBackup.toLocaleString()}`);
        }
        if (stats.nextBackup) {
          console.log(`  Next backup: ${stats.nextBackup.toLocaleString()}`);
        }
        break;
        
      default:
        console.log('Otedama Pool Backup Manager\n');
        console.log('Commands:');
        console.log('  npm run backup:list              - List all available backups');
        console.log('  npm run backup:restore <name>    - Restore a specific backup');
        console.log('  npm run backup:backup            - Create a manual backup');
        console.log('  npm run backup:stats             - Show backup statistics');
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
  
  process.exit(0);
}

main();
