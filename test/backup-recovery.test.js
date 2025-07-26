/**
 * Backup and Recovery Tests - Otedama
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { BackupRecovery } from '../lib/core/backup-recovery.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

describe('BackupRecovery', () => {
  let backupRecovery;
  const testBackupDir = './test-backups';
  
  beforeEach(async () => {
    // Clean test directory
    try {
      await fs.rm(testBackupDir, { recursive: true, force: true });
    } catch (e) {}
    
    backupRecovery = new BackupRecovery({
      backupDir: testBackupDir,
      interval: 0, // Disable auto backup for tests
      compression: true,
      encryption: false
    });
  });
  
  afterEach(async () => {
    backupRecovery.stop();
    // Clean up
    try {
      await fs.rm(testBackupDir, { recursive: true, force: true });
    } catch (e) {}
  });
  
  describe('Basic Operations', () => {
    it('should initialize backup system', async () => {
      await backupRecovery.start();
      
      const stats = backupRecovery.getStats();
      expect(stats.totalBackups).toBe(0);
      expect(stats.backupsCompleted).toBe(0);
    });
    
    it('should register and backup sources', async () => {
      const testSource = {
        async getState() {
          return {
            data: 'test data',
            timestamp: Date.now()
          };
        },
        async setState(state) {
          this.restoredState = state;
        }
      };
      
      backupRecovery.registerSource('test', testSource);
      await backupRecovery.start();
      
      const backup = await backupRecovery.performBackup();
      
      expect(backup).toBeDefined();
      expect(backup.type).toBe('full');
      expect(backup.sources).toContain('test');
      expect(backup.size).toBeGreaterThan(0);
    });
  });
  
  describe('Backup Strategies', () => {
    let testSource;
    
    beforeEach(async () => {
      testSource = {
        state: { counter: 0, items: [] },
        async getState() {
          return this.state;
        },
        async setState(state) {
          this.state = state;
        }
      };
      
      backupRecovery.registerSource('test', testSource);
      await backupRecovery.start();
    });
    
    it('should create full backup', async () => {
      testSource.state = { counter: 5, items: ['a', 'b', 'c'] };
      
      const backup = await backupRecovery.performBackup({
        strategy: 'full'
      });
      
      expect(backup.type).toBe('full');
      expect(backup.parentId).toBeNull();
    });
    
    it('should create incremental backup', async () => {
      // First full backup
      testSource.state = { counter: 1, items: ['a'] };
      const fullBackup = await backupRecovery.performBackup({
        strategy: 'full'
      });
      
      // Modify state
      testSource.state = { counter: 2, items: ['a', 'b'] };
      
      // Incremental backup
      const incrBackup = await backupRecovery.performBackup({
        strategy: 'incremental'
      });
      
      expect(incrBackup.type).toBe('incremental');
      expect(incrBackup.parentId).toBe(fullBackup.id);
    });
    
    it('should skip incremental backup if no changes', async () => {
      // Full backup
      await backupRecovery.performBackup({ strategy: 'full' });
      
      // No changes, try incremental
      const result = await backupRecovery.performBackup({
        strategy: 'incremental'
      });
      
      expect(result).toBeNull();
    });
  });
  
  describe('Restore Operations', () => {
    let testSource;
    
    beforeEach(async () => {
      testSource = {
        state: null,
        async getState() {
          return this.state;
        },
        async setState(state) {
          this.state = state;
        }
      };
      
      backupRecovery.registerSource('test', testSource);
      await backupRecovery.start();
    });
    
    it('should restore from full backup', async () => {
      const originalState = {
        counter: 42,
        items: ['x', 'y', 'z'],
        metadata: { version: 1 }
      };
      
      testSource.state = originalState;
      await backupRecovery.performBackup({ strategy: 'full' });
      
      // Clear state
      testSource.state = null;
      
      // Restore
      await backupRecovery.restore({ mode: 'latest' });
      
      expect(testSource.state).toEqual(originalState);
    });
    
    it('should restore from incremental chain', async () => {
      // Full backup
      testSource.state = { counter: 1, items: ['a'] };
      await backupRecovery.performBackup({ strategy: 'full' });
      
      // First incremental
      testSource.state = { counter: 2, items: ['a', 'b'] };
      await backupRecovery.performBackup({ strategy: 'incremental' });
      
      // Second incremental
      testSource.state = { counter: 3, items: ['a', 'b', 'c'] };
      const finalBackup = await backupRecovery.performBackup({ 
        strategy: 'incremental' 
      });
      
      // Clear and restore
      testSource.state = null;
      await backupRecovery.restore({ mode: 'latest' });
      
      expect(testSource.state).toEqual({
        counter: 3,
        items: ['a', 'b', 'c']
      });
    });
    
    it('should restore to point in time', async () => {
      // Multiple backups
      testSource.state = { version: 1 };
      const backup1 = await backupRecovery.performBackup({ strategy: 'full' });
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      testSource.state = { version: 2 };
      const backup2 = await backupRecovery.performBackup({ strategy: 'full' });
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      testSource.state = { version: 3 };
      await backupRecovery.performBackup({ strategy: 'full' });
      
      // Restore to middle backup
      testSource.state = null;
      await backupRecovery.restore({
        mode: 'point_in_time',
        timestamp: backup2.timestamp + 50
      });
      
      expect(testSource.state.version).toBe(2);
    });
  });
  
  describe('Compression and Encryption', () => {
    it('should compress backups', async () => {
      const largeData = {
        data: 'x'.repeat(10000),
        array: new Array(1000).fill('test')
      };
      
      const testSource = {
        async getState() { return largeData; },
        async setState(state) {}
      };
      
      backupRecovery.registerSource('test', testSource);
      await backupRecovery.start();
      
      const backup = await backupRecovery.performBackup();
      
      // Compressed size should be smaller than uncompressed
      const uncompressedSize = JSON.stringify(largeData).length;
      expect(backup.size).toBeLessThan(uncompressedSize);
    });
    
    it('should encrypt and decrypt backups', async () => {
      const encryptionKey = crypto.randomBytes(32);
      
      const encryptedBackup = new BackupRecovery({
        backupDir: testBackupDir,
        interval: 0,
        compression: false,
        encryption: true,
        encryptionKey
      });
      
      const testData = { secret: 'confidential data' };
      const testSource = {
        state: testData,
        async getState() { return this.state; },
        async setState(state) { this.state = state; }
      };
      
      encryptedBackup.registerSource('test', testSource);
      await encryptedBackup.start();
      
      const backup = await encryptedBackup.performBackup();
      
      // Verify file is encrypted (not readable as JSON)
      const filepath = path.join(testBackupDir, backup.filename);
      const fileContent = await fs.readFile(filepath);
      
      expect(() => JSON.parse(fileContent)).toThrow();
      
      // But should restore correctly
      testSource.state = null;
      await encryptedBackup.restore({ mode: 'latest' });
      
      expect(testSource.state).toEqual(testData);
    });
  });
  
  describe('Backup Management', () => {
    it('should list backups with filters', async () => {
      const testSource = {
        counter: 0,
        async getState() { 
          return { counter: this.counter++ };
        },
        async setState(state) {}
      };
      
      backupRecovery.registerSource('test', testSource);
      await backupRecovery.start();
      
      // Create multiple backups
      await backupRecovery.performBackup({ strategy: 'full' });
      await backupRecovery.performBackup({ strategy: 'incremental' });
      await backupRecovery.performBackup({ strategy: 'full' });
      
      const allBackups = backupRecovery.listBackups();
      expect(allBackups.length).toBe(3);
      
      const fullBackups = backupRecovery.listBackups({ type: 'full' });
      expect(fullBackups.length).toBe(2);
      
      const limitedBackups = backupRecovery.listBackups({ limit: 2 });
      expect(limitedBackups.length).toBe(2);
    });
    
    it('should clean old backups', async () => {
      const shortRetention = new BackupRecovery({
        backupDir: testBackupDir,
        interval: 0,
        retention: 100, // 100ms retention for testing
        compression: false
      });
      
      const testSource = {
        async getState() { return { time: Date.now() }; },
        async setState(state) {}
      };
      
      shortRetention.registerSource('test', testSource);
      await shortRetention.start();
      
      // Create old backup
      const oldBackup = await shortRetention.performBackup({ 
        strategy: 'incremental' 
      });
      
      // Wait for retention period
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Create new backup (triggers cleanup)
      await shortRetention.performBackup({ strategy: 'full' });
      
      // Old incremental should be deleted (but full backups kept)
      const backups = shortRetention.listBackups();
      expect(backups.find(b => b.id === oldBackup.id)).toBeUndefined();
    });
  });
  
  describe('Error Handling', () => {
    it('should handle backup failures gracefully', async () => {
      const faultySource = {
        async getState() {
          throw new Error('Source failure');
        },
        async setState(state) {}
      };
      
      backupRecovery.registerSource('faulty', faultySource);
      await backupRecovery.start();
      
      await expect(backupRecovery.performBackup()).rejects.toThrow('Source failure');
      
      const stats = backupRecovery.getStats();
      expect(stats.backupsFailed).toBe(1);
    });
    
    it('should handle restore failures gracefully', async () => {
      const testSource = {
        async getState() { return { data: 'test' }; },
        async setState(state) {
          throw new Error('Restore failure');
        }
      };
      
      backupRecovery.registerSource('test', testSource);
      await backupRecovery.start();
      
      await backupRecovery.performBackup();
      
      await expect(backupRecovery.restore({ mode: 'latest' }))
        .rejects.toThrow('Restore failure');
      
      const stats = backupRecovery.getStats();
      expect(stats.recoveriesFailed).toBe(1);
    });
    
    it('should verify backup integrity', async () => {
      const testSource = {
        async getState() { return { verified: true }; },
        async setState(state) {}
      };
      
      backupRecovery.registerSource('test', testSource);
      await backupRecovery.start();
      
      const backup = await backupRecovery.performBackup();
      
      // Corrupt the backup file
      const filepath = path.join(testBackupDir, backup.filename);
      const data = await fs.readFile(filepath);
      data[0] = data[0] ^ 0xFF; // Flip bits
      await fs.writeFile(filepath, data);
      
      // Restore should fail due to checksum mismatch
      const verifyingBackup = new BackupRecovery({
        backupDir: testBackupDir,
        interval: 0,
        verifyOnRestore: true
      });
      
      verifyingBackup.registerSource('test', testSource);
      await verifyingBackup.start();
      await verifyingBackup.loadBackupHistory();
      
      await expect(verifyingBackup.restore({ mode: 'latest' }))
        .rejects.toThrow('checksum mismatch');
    });
  });
  
  describe('Performance', () => {
    it('should handle large state efficiently', async () => {
      const largeState = {
        miners: new Array(10000).fill(null).map((_, i) => ({
          id: `miner${i}`,
          hashrate: Math.random() * 1e12,
          shares: Math.floor(Math.random() * 1000)
        })),
        blocks: new Array(1000).fill(null).map((_, i) => ({
          height: i,
          hash: crypto.randomBytes(32).toString('hex'),
          timestamp: Date.now() - i * 600000
        }))
      };
      
      const testSource = {
        async getState() { return largeState; },
        async setState(state) { this.restored = state; }
      };
      
      backupRecovery.registerSource('large', testSource);
      await backupRecovery.start();
      
      const startBackup = Date.now();
      const backup = await backupRecovery.performBackup();
      const backupTime = Date.now() - startBackup;
      
      expect(backupTime).toBeLessThan(5000); // Should complete within 5 seconds
      expect(backup.size).toBeGreaterThan(0);
      
      const startRestore = Date.now();
      await backupRecovery.restore({ mode: 'latest' });
      const restoreTime = Date.now() - startRestore;
      
      expect(restoreTime).toBeLessThan(5000); // Should complete within 5 seconds
      expect(testSource.restored.miners.length).toBe(10000);
      expect(testSource.restored.blocks.length).toBe(1000);
    });
  });
});