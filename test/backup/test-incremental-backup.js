/**
 * Test script for incremental backup functionality
 * Demonstrates the new incremental backup system
 */

import { UnifiedBackupManager } from '../../lib/backup/unified-backup-manager.js';
import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';

// Test configuration
const testDir = './test-backup-data';
const dbPath = join(testDir, 'test.db');

// Clean up and create test directory
rmSync(testDir, { recursive: true, force: true });
mkdirSync(testDir, { recursive: true });

// Create test database
const db = new Database(dbPath);

// Initialize schema
db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    amount REAL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Insert initial data
const insertUser = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
const insertTransaction = db.prepare('INSERT INTO transactions (user_id, amount, description) VALUES (?, ?, ?)');

for (let i = 1; i <= 100; i++) {
  const user = insertUser.run(`User ${i}`, `user${i}@example.com`);
  
  // Add some transactions
  for (let j = 1; j <= 5; j++) {
    insertTransaction.run(user.lastInsertRowid, Math.random() * 1000, `Transaction ${j}`);
  }
}

db.close();

// Initialize backup manager with incremental support
const backupManager = new UnifiedBackupManager(dbPath, {
  backupDir: join(testDir, 'backups'),
  strategy: 'incremental',
  incremental: {
    enabled: true,
    fullBackupInterval: 7,
    maxIncrementals: 5,
    trackingInterval: 500,
    compression: true
  },
  compression: {
    enabled: true,
    level: 6
  },
  verify: {
    enabled: true
  }
});

// Test incremental backup functionality
async function testIncrementalBackup() {
  console.log('Starting incremental backup test...\n');
  
  try {
    // Initialize backup system
    await backupManager.initialize();
    console.log('✓ Backup system initialized');
    
    // Create initial full backup
    console.log('\n1. Creating initial full backup...');
    const fullBackup = await backupManager.createBackup('manual', {
      description: 'Initial full backup for testing'
    });
    console.log(`✓ Full backup created: ${fullBackup.id}`);
    console.log(`  Size: ${(fullBackup.size / 1024).toFixed(2)} KB`);
    console.log(`  Duration: ${fullBackup.duration}ms`);
    
    // Make some changes to the database
    console.log('\n2. Making database changes...');
    const db2 = new Database(dbPath);
    
    // Update some users
    db2.prepare('UPDATE users SET name = ? WHERE id <= ?').run('Updated User', 10);
    
    // Add new users
    for (let i = 101; i <= 110; i++) {
      insertUser.bind(db2).run(`New User ${i}`, `newuser${i}@example.com`);
    }
    
    // Delete some transactions
    db2.prepare('DELETE FROM transactions WHERE id % 10 = 0').run();
    
    db2.close();
    console.log('✓ Database changes completed');
    
    // Wait for change tracking
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Create incremental backup
    console.log('\n3. Creating incremental backup...');
    const incBackup1 = await backupManager.createBackup('manual', {
      description: 'First incremental backup'
    });
    
    if (incBackup1) {
      console.log(`✓ Incremental backup created: ${incBackup1.id}`);
      console.log(`  Type: ${incBackup1.metadata.incrementalType}`);
      console.log(`  Changed pages: ${incBackup1.metadata.incrementalInfo?.changedPages || 'N/A'}`);
      console.log(`  Size: ${(incBackup1.size / 1024).toFixed(2)} KB`);
      console.log(`  Duration: ${incBackup1.duration}ms`);
    } else {
      console.log('✓ No changes detected, incremental backup skipped');
    }
    
    // Make more changes
    console.log('\n4. Making more database changes...');
    const db3 = new Database(dbPath);
    
    // Bulk insert
    const bulkInsert = db3.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
    const insertMany = db3.transaction((users) => {
      for (const user of users) {
        bulkInsert.run(user.name, user.email);
      }
    });
    
    const newUsers = [];
    for (let i = 111; i <= 200; i++) {
      newUsers.push({ name: `Bulk User ${i}`, email: `bulk${i}@example.com` });
    }
    insertMany(newUsers);
    
    db3.close();
    console.log('✓ Bulk changes completed');
    
    // Create another incremental backup
    console.log('\n5. Creating second incremental backup...');
    const incBackup2 = await backupManager.createBackup('manual', {
      description: 'Second incremental backup after bulk insert'
    });
    
    if (incBackup2) {
      console.log(`✓ Incremental backup created: ${incBackup2.id}`);
      console.log(`  Changed pages: ${incBackup2.metadata.incrementalInfo?.changedPages || 'N/A'}`);
      console.log(`  Size: ${(incBackup2.size / 1024).toFixed(2)} KB`);
    }
    
    // Get backup statistics
    console.log('\n6. Backup Statistics:');
    const stats = backupManager.getStats();
    console.log(`✓ Total backups: ${stats.metrics.totalBackups}`);
    console.log(`✓ Success rate: ${stats.metrics.successRate}`);
    console.log(`✓ Average duration: ${stats.metrics.averageDuration}`);
    
    if (stats.incremental) {
      console.log('\nIncremental Backup Chain:');
      console.log(`✓ Full backup: ${stats.incremental.lastFullBackup?.id || 'None'}`);
      console.log(`✓ Incremental count: ${stats.incremental.incrementalCount}`);
      console.log(`✓ Total incremental size: ${(stats.incremental.metrics.totalIncrementalSize / 1024).toFixed(2)} KB`);
      console.log(`✓ Change rate: ${stats.incremental.metrics.changeRate}`);
    }
    
    // Test restore from incremental
    console.log('\n7. Testing restore from incremental backup...');
    const restorePath = join(testDir, 'restored.db');
    
    if (incBackup2) {
      await backupManager.restoreBackup(incBackup2.id, {
        targetPath: restorePath,
        createRestorePoint: false
      });
      
      // Verify restored database
      const restoredDb = new Database(restorePath, { readonly: true });
      const userCount = restoredDb.prepare('SELECT COUNT(*) as count FROM users').get();
      const txCount = restoredDb.prepare('SELECT COUNT(*) as count FROM transactions').get();
      restoredDb.close();
      
      console.log(`✓ Database restored successfully`);
      console.log(`  Users: ${userCount.count}`);
      console.log(`  Transactions: ${txCount.count}`);
    }
    
    // Create multiple incrementals to test chain limit
    console.log('\n8. Testing incremental chain limit...');
    for (let i = 3; i <= 7; i++) {
      const db4 = new Database(dbPath);
      db4.prepare(`UPDATE users SET name = ? WHERE id = ?`).run(`Chain Test ${i}`, i);
      db4.close();
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const backup = await backupManager.createBackup('manual', {
        description: `Incremental ${i}`
      });
      
      if (backup) {
        console.log(`✓ Backup ${i}: ${backup.metadata.incrementalType} (${backup.id})`);
      }
    }
    
    // Final statistics
    console.log('\n9. Final Statistics:');
    const finalStats = backupManager.getStats();
    console.log(`✓ Total backups: ${finalStats.metrics.totalBackups}`);
    console.log(`✓ Recent backups:`);
    finalStats.recentBackups.forEach(b => {
      console.log(`  - ${b.type} at ${b.time}: ${(b.size / 1024).toFixed(2)} KB (${b.status})`);
    });
    
    // Shutdown
    await backupManager.shutdown();
    console.log('\n✓ Backup system shut down successfully');
    
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

// Run the test
testIncrementalBackup().then(() => {
  console.log('\n✅ All tests completed successfully!');
  process.exit(0);
}).catch(error => {
  console.error('Test error:', error);
  process.exit(1);
});