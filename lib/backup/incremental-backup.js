/**
 * Incremental Backup System for Otedama
 * Tracks and backs up only changed data since last backup
 * 
 * Design principles:
 * - Carmack: Minimal overhead, efficient change tracking
 * - Martin: Clean separation of change tracking and backup logic
 * - Pike: Simple and reliable incremental strategy
 */

import { EventEmitter } from 'events';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'fs';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { pipeline } from 'stream/promises';
import { createGzip, createGunzip } from 'zlib';
import Database from 'better-sqlite3';
import { getLogger } from '../core/logger.js';

const logger = getLogger('IncrementalBackup');

// Page size for SQLite (default 4096 bytes)
const PAGE_SIZE = 4096;

export class IncrementalBackupManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      pageSize: options.pageSize || PAGE_SIZE,
      trackingInterval: options.trackingInterval || 1000, // Check for changes every second
      compression: options.compression !== false,
      checksumAlgorithm: options.checksumAlgorithm || 'sha256',
      maxIncrementals: options.maxIncrementals || 6,
      metadataDir: options.metadataDir || './backup-metadata',
      ...options
    };
    
    // Change tracking state
    this.changeTracker = new Map(); // Map of page number to checksum
    this.lastFullBackup = null;
    this.incrementalChain = [];
    this.isTracking = false;
    this.trackingTimer = null;
    
    // Database connections
    this.db = null;
    this.dbPath = null;
    
    // Metrics
    this.metrics = {
      pagesTracked: 0,
      pagesChanged: 0,
      incrementalBackups: 0,
      totalIncrementalSize: 0,
      avgChangeRate: 0
    };
  }
  
  /**
   * Initialize incremental backup tracking
   */
  async initialize(dbPath) {
    this.dbPath = dbPath;
    
    // Ensure metadata directory exists
    mkdirSync(this.options.metadataDir, { recursive: true });
    
    // Load existing metadata
    await this.loadMetadata();
    
    // Open database connection for tracking
    this.db = new Database(dbPath, { readonly: true });
    
    // Start change tracking
    this.startTracking();
    
    this.emit('initialized', {
      dbPath,
      lastFullBackup: this.lastFullBackup,
      incrementalCount: this.incrementalChain.length
    });
  }
  
  /**
   * Start tracking database changes
   */
  startTracking() {
    if (this.isTracking) return;
    
    this.isTracking = true;
    this.trackingTimer = setInterval(() => {
      this.checkForChanges().catch(error => {
        logger.error('Error checking for changes', error);
      });
    }, this.options.trackingInterval);
  }
  
  /**
   * Stop tracking changes
   */
  stopTracking() {
    if (this.trackingTimer) {
      clearInterval(this.trackingTimer);
      this.trackingTimer = null;
    }
    this.isTracking = false;
  }
  
  /**
   * Check for changed pages in the database
   */
  async checkForChanges() {
    try {
      // Get database file info
      const stats = await fs.stat(this.dbPath);
      const pageCount = Math.ceil(stats.size / this.options.pageSize);
      
      // Read and checksum each page
      const stream = createReadStream(this.dbPath, {
        highWaterMark: this.options.pageSize
      });
      
      let pageNumber = 0;
      const changedPages = new Set();
      
      for await (const chunk of stream) {
        const checksum = this.calculateChecksum(chunk);
        const previousChecksum = this.changeTracker.get(pageNumber);
        
        if (previousChecksum && previousChecksum !== checksum) {
          changedPages.add(pageNumber);
          this.metrics.pagesChanged++;
        }
        
        this.changeTracker.set(pageNumber, checksum);
        pageNumber++;
      }
      
      this.metrics.pagesTracked = pageCount;
      
      if (changedPages.size > 0) {
        this.emit('changes-detected', {
          changedPages: Array.from(changedPages),
          totalPages: pageCount,
          changeRate: (changedPages.size / pageCount) * 100
        });
      }
      
    } catch (error) {
      this.emit('tracking-error', error);
    }
  }
  
  /**
   * Create incremental backup
   */
  async createIncrementalBackup(backupPath, fullBackupInfo) {
    const startTime = Date.now();
    
    try {
      // Check if we need a new full backup
      if (!this.lastFullBackup || this.incrementalChain.length >= this.options.maxIncrementals) {
        throw new Error('Full backup required');
      }
      
      // Get changed pages since last backup
      const changedPages = await this.getChangedPages();
      
      if (changedPages.length === 0) {
        logger.info('No changes detected, skipping incremental backup');
        return null;
      }
      
      // Create incremental backup file
      const incrementalData = {
        version: 1,
        baseBackup: this.lastFullBackup.id,
        previousIncremental: this.incrementalChain[this.incrementalChain.length - 1]?.id || null,
        timestamp: Date.now(),
        pageSize: this.options.pageSize,
        changedPages: changedPages.length,
        pages: []
      };
      
      // Read changed pages
      const fileHandle = await fs.open(this.dbPath, 'r');
      
      try {
        for (const pageNumber of changedPages) {
          const buffer = Buffer.allocUnsafe(this.options.pageSize);
          const offset = pageNumber * this.options.pageSize;
          
          const { bytesRead } = await fileHandle.read(buffer, 0, this.options.pageSize, offset);
          
          incrementalData.pages.push({
            pageNumber,
            size: bytesRead,
            checksum: this.calculateChecksum(buffer.slice(0, bytesRead)),
            data: buffer.slice(0, bytesRead).toString('base64')
          });
        }
      } finally {
        await fileHandle.close();
      }
      
      // Write incremental backup
      const tempPath = backupPath + '.tmp';
      mkdirSync(dirname(tempPath), { recursive: true });
      
      if (this.options.compression) {
        // Compress incremental data
        const output = createWriteStream(tempPath);
        const gzip = createGzip({ level: 6 });
        
        await pipeline(
          async function* () {
            yield JSON.stringify(incrementalData);
          },
          gzip,
          output
        );
      } else {
        // Write uncompressed
        await fs.writeFile(tempPath, JSON.stringify(incrementalData));
      }
      
      // Move to final location
      await fs.rename(tempPath, backupPath);
      
      // Update metadata
      const backupInfo = {
        id: `inc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        path: backupPath,
        timestamp: incrementalData.timestamp,
        baseBackup: incrementalData.baseBackup,
        previousIncremental: incrementalData.previousIncremental,
        changedPages: incrementalData.changedPages,
        size: (await fs.stat(backupPath)).size,
        duration: Date.now() - startTime
      };
      
      this.incrementalChain.push(backupInfo);
      await this.saveMetadata();
      
      // Update metrics
      this.metrics.incrementalBackups++;
      this.metrics.totalIncrementalSize += backupInfo.size;
      
      this.emit('incremental-created', backupInfo);
      
      return backupInfo;
      
    } catch (error) {
      this.emit('incremental-error', error);
      throw error;
    }
  }
  
  /**
   * Restore from incremental backup chain
   */
  async restore(targetPath, fullBackupPath, incrementalPaths = []) {
    try {
      this.emit('restore-started', { targetPath, incrementals: incrementalPaths.length });
      
      // First, restore the full backup
      if (this.options.compression) {
        const input = createReadStream(fullBackupPath);
        const output = createWriteStream(targetPath);
        const gunzip = createGunzip();
        
        await pipeline(input, gunzip, output);
      } else {
        await fs.copyFile(fullBackupPath, targetPath);
      }
      
      // Apply incremental backups in order
      for (const incrementalPath of incrementalPaths) {
        await this.applyIncremental(targetPath, incrementalPath);
      }
      
      // Verify restored database
      const db = new Database(targetPath, { readonly: true });
      try {
        const result = db.prepare('PRAGMA integrity_check').get();
        if (result.integrity_check !== 'ok') {
          throw new Error('Restored database integrity check failed');
        }
      } finally {
        db.close();
      }
      
      this.emit('restore-completed', { targetPath });
      
    } catch (error) {
      this.emit('restore-error', error);
      throw error;
    }
  }
  
  /**
   * Apply incremental backup to database
   */
  async applyIncremental(dbPath, incrementalPath) {
    // Read incremental data
    let incrementalData;
    
    if (this.options.compression) {
      const input = createReadStream(incrementalPath);
      const gunzip = createGunzip();
      
      const chunks = [];
      gunzip.on('data', chunk => chunks.push(chunk));
      
      await pipeline(input, gunzip);
      incrementalData = JSON.parse(Buffer.concat(chunks).toString());
    } else {
      const content = await fs.readFile(incrementalPath, 'utf8');
      incrementalData = JSON.parse(content);
    }
    
    // Apply pages
    const fileHandle = await fs.open(dbPath, 'r+');
    
    try {
      for (const page of incrementalData.pages) {
        const pageData = Buffer.from(page.data, 'base64');
        const offset = page.pageNumber * this.options.pageSize;
        
        await fileHandle.write(pageData, 0, page.size, offset);
      }
    } finally {
      await fileHandle.close();
    }
    
    logger.info(`Applied incremental backup with ${incrementalData.changedPages} changed pages`);
  }
  
  /**
   * Get list of changed pages since last backup
   */
  async getChangedPages() {
    const changedPages = [];
    const currentChecksums = new Map();
    
    // Read current state
    const stream = createReadStream(this.dbPath, {
      highWaterMark: this.options.pageSize
    });
    
    let pageNumber = 0;
    
    for await (const chunk of stream) {
      const checksum = this.calculateChecksum(chunk);
      currentChecksums.set(pageNumber, checksum);
      
      // Compare with last known state
      const lastChecksum = this.changeTracker.get(pageNumber);
      if (!lastChecksum || lastChecksum !== checksum) {
        changedPages.push(pageNumber);
      }
      
      pageNumber++;
    }
    
    // Update tracker with current state
    this.changeTracker = currentChecksums;
    
    return changedPages;
  }
  
  /**
   * Calculate checksum for data
   */
  calculateChecksum(data) {
    return createHash(this.options.checksumAlgorithm)
      .update(data)
      .digest('hex');
  }
  
  /**
   * Reset incremental backup chain
   */
  async resetChain(fullBackupInfo) {
    this.lastFullBackup = fullBackupInfo;
    this.incrementalChain = [];
    this.changeTracker.clear();
    
    // Initialize change tracker with full backup state
    await this.checkForChanges();
    await this.saveMetadata();
    
    this.emit('chain-reset', { fullBackup: fullBackupInfo });
  }
  
  /**
   * Get incremental backup chain info
   */
  getChainInfo() {
    return {
      lastFullBackup: this.lastFullBackup,
      incrementalCount: this.incrementalChain.length,
      incrementals: this.incrementalChain.map(inc => ({
        id: inc.id,
        timestamp: new Date(inc.timestamp).toISOString(),
        changedPages: inc.changedPages,
        size: inc.size
      })),
      totalIncrementalSize: this.metrics.totalIncrementalSize,
      canCreateIncremental: this.lastFullBackup && 
                           this.incrementalChain.length < this.options.maxIncrementals
    };
  }
  
  /**
   * Load metadata from disk
   */
  async loadMetadata() {
    const metadataPath = join(this.options.metadataDir, 'incremental-metadata.json');
    
    try {
      if (existsSync(metadataPath)) {
        const data = await fs.readFile(metadataPath, 'utf8');
        const metadata = JSON.parse(data);
        
        this.lastFullBackup = metadata.lastFullBackup;
        this.incrementalChain = metadata.incrementalChain || [];
        this.metrics = metadata.metrics || this.metrics;
      }
    } catch (error) {
      logger.error('Failed to load incremental backup metadata', error);
    }
  }
  
  /**
   * Save metadata to disk
   */
  async saveMetadata() {
    const metadataPath = join(this.options.metadataDir, 'incremental-metadata.json');
    
    const metadata = {
      lastFullBackup: this.lastFullBackup,
      incrementalChain: this.incrementalChain,
      metrics: this.metrics,
      lastUpdated: Date.now()
    };
    
    try {
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    } catch (error) {
      logger.error('Failed to save incremental backup metadata', error);
    }
  }
  
  /**
   * Cleanup old incremental backups
   */
  async cleanup(keepLast = 2) {
    if (this.incrementalChain.length <= keepLast) return;
    
    const toDelete = this.incrementalChain.slice(0, -keepLast);
    
    for (const backup of toDelete) {
      try {
        if (existsSync(backup.path)) {
          await fs.unlink(backup.path);
        }
      } catch (error) {
        logger.error(`Failed to delete incremental backup ${backup.id}`, error);
      }
    }
    
    this.incrementalChain = this.incrementalChain.slice(-keepLast);
    await this.saveMetadata();
    
    this.emit('cleanup-completed', { deleted: toDelete.length });
  }
  
  /**
   * Get metrics
   */
  getMetrics() {
    const changeRate = this.metrics.pagesTracked > 0 
      ? (this.metrics.pagesChanged / this.metrics.pagesTracked) * 100 
      : 0;
    
    return {
      ...this.metrics,
      changeRate: changeRate.toFixed(2) + '%',
      avgIncrementalSize: this.metrics.incrementalBackups > 0
        ? Math.round(this.metrics.totalIncrementalSize / this.metrics.incrementalBackups)
        : 0
    };
  }
  
  /**
   * Shutdown incremental backup manager
   */
  async shutdown() {
    this.stopTracking();
    
    if (this.db) {
      this.db.close();
    }
    
    await this.saveMetadata();
    
    this.emit('shutdown');
  }
}

export default IncrementalBackupManager;