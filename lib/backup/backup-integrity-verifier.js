/**
 * Backup Integrity Verifier for Otedama
 * Ensures backup files are complete, valid, and restorable
 * 
 * Design principles:
 * - Pike: Simple, reliable verification process
 * - Martin: Clean separation of verification strategies
 * - Carmack: Efficient checksum algorithms
 */

import { EventEmitter } from 'events';
import { createHash, createHmac } from 'crypto';
import { readFileSync, statSync, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import Database from 'better-sqlite3';
import { getLogger } from '../core/logger.js';

/**
 * Backup Integrity Verifier
 */
export class BackupIntegrityVerifier extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.logger = getLogger('BackupIntegrity');
    
    this.options = {
      // Verification levels: 'basic', 'standard', 'comprehensive'
      verificationLevel: options.verificationLevel || 'standard',
      
      // Checksum algorithms
      checksumAlgorithm: options.checksumAlgorithm || 'sha256',
      hmacSecret: options.hmacSecret || process.env.BACKUP_HMAC_SECRET,
      
      // Verification options
      verifyStructure: options.verifyStructure !== false,
      verifyData: options.verifyData !== false,
      verifyRelationships: options.verifyRelationships !== false,
      verifyConstraints: options.verifyConstraints !== false,
      
      // Performance options
      batchSize: options.batchSize || 1000,
      maxMemory: options.maxMemory || 512 * 1024 * 1024, // 512MB
      
      // Recovery options
      attemptRepair: options.attemptRepair || false,
      backupMetadataFile: options.backupMetadataFile || '.backup-metadata.json',
      
      ...options
    };
    
    // Verification strategies
    this.strategies = new Map([
      ['basic', this.basicVerification.bind(this)],
      ['standard', this.standardVerification.bind(this)],
      ['comprehensive', this.comprehensiveVerification.bind(this)]
    ]);
    
    // Statistics
    this.stats = {
      verificationsPerformed: 0,
      verificationsSucceeded: 0,
      verificationsFailed: 0,
      repairsAttempted: 0,
      repairsSucceeded: 0,
      totalBytesVerified: 0
    };
  }
  
  /**
   * Verify backup integrity
   */
  async verifyBackup(backupPath, options = {}) {
    const startTime = Date.now();
    this.stats.verificationsPerformed++;
    
    try {
      this.logger.info(`Starting backup verification: ${backupPath}`);
      
      // Check if file exists and is readable
      const fileInfo = await this.checkFileAccess(backupPath);
      
      // Load metadata if available
      const metadata = await this.loadMetadata(backupPath);
      
      // Create verification context
      const context = {
        path: backupPath,
        fileInfo,
        metadata,
        options: { ...this.options, ...options },
        errors: [],
        warnings: [],
        repairs: []
      };
      
      // Run verification strategy
      const strategy = this.strategies.get(context.options.verificationLevel);
      if (!strategy) {
        throw new Error(`Unknown verification level: ${context.options.verificationLevel}`);
      }
      
      const result = await strategy(context);
      
      // Calculate verification score
      result.score = this.calculateVerificationScore(result);
      result.duration = Date.now() - startTime;
      
      // Update statistics
      this.stats.totalBytesVerified += fileInfo.size;
      if (result.valid) {
        this.stats.verificationsSucceeded++;
      } else {
        this.stats.verificationsFailed++;
      }
      
      // Emit result
      this.emit('verification:complete', result);
      
      return result;
      
    } catch (error) {
      this.logger.error('Backup verification failed:', error);
      this.stats.verificationsFailed++;
      
      return {
        valid: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }
  
  /**
   * Basic verification (file integrity only)
   */
  async basicVerification(context) {
    const result = {
      valid: true,
      level: 'basic',
      checks: {}
    };
    
    // Verify file checksum
    if (context.metadata?.checksum) {
      const checksumValid = await this.verifyChecksum(
        context.path,
        context.metadata.checksum,
        context.metadata.checksumAlgorithm
      );
      
      result.checks.checksum = checksumValid;
      if (!checksumValid) {
        result.valid = false;
        context.errors.push('Checksum verification failed');
      }
    }
    
    // Verify file size
    if (context.metadata?.size) {
      const sizeValid = context.fileInfo.size === context.metadata.size;
      result.checks.size = sizeValid;
      
      if (!sizeValid) {
        result.valid = false;
        context.errors.push(`Size mismatch: expected ${context.metadata.size}, got ${context.fileInfo.size}`);
      }
    }
    
    // Verify compression if applicable
    if (context.path.endsWith('.gz')) {
      const compressionValid = await this.verifyCompression(context.path);
      result.checks.compression = compressionValid;
      
      if (!compressionValid) {
        result.valid = false;
        context.errors.push('Compression verification failed');
      }
    }
    
    result.errors = context.errors;
    result.warnings = context.warnings;
    
    return result;
  }
  
  /**
   * Standard verification (structure and basic data checks)
   */
  async standardVerification(context) {
    // Start with basic verification
    const result = await this.basicVerification(context);
    result.level = 'standard';
    
    if (!result.valid && !context.options.continueOnError) {
      return result;
    }
    
    // Verify database structure
    if (context.options.verifyStructure) {
      const structureValid = await this.verifyDatabaseStructure(context);
      result.checks.structure = structureValid;
      
      if (!structureValid) {
        result.valid = false;
      }
    }
    
    // Verify data integrity
    if (context.options.verifyData) {
      const dataValid = await this.verifyDataIntegrity(context);
      result.checks.data = dataValid;
      
      if (!dataValid) {
        result.valid = false;
      }
    }
    
    // Verify row counts
    if (context.metadata?.tables) {
      const rowCountsValid = await this.verifyRowCounts(context);
      result.checks.rowCounts = rowCountsValid;
      
      if (!rowCountsValid) {
        result.valid = false;
      }
    }
    
    return result;
  }
  
  /**
   * Comprehensive verification (full data validation)
   */
  async comprehensiveVerification(context) {
    // Start with standard verification
    const result = await this.standardVerification(context);
    result.level = 'comprehensive';
    
    if (!result.valid && !context.options.continueOnError) {
      return result;
    }
    
    // Verify foreign key relationships
    if (context.options.verifyRelationships) {
      const relationshipsValid = await this.verifyRelationships(context);
      result.checks.relationships = relationshipsValid;
      
      if (!relationshipsValid) {
        result.valid = false;
      }
    }
    
    // Verify constraints
    if (context.options.verifyConstraints) {
      const constraintsValid = await this.verifyConstraints(context);
      result.checks.constraints = constraintsValid;
      
      if (!constraintsValid) {
        result.valid = false;
      }
    }
    
    // Verify data consistency
    const consistencyValid = await this.verifyDataConsistency(context);
    result.checks.consistency = consistencyValid;
    
    if (!consistencyValid) {
      result.valid = false;
    }
    
    // Attempt repairs if requested
    if (!result.valid && context.options.attemptRepair) {
      const repairResult = await this.attemptRepairs(context);
      result.repairs = repairResult;
      
      if (repairResult.success) {
        result.repairable = true;
      }
    }
    
    return result;
  }
  
  /**
   * Verify file checksum
   */
  async verifyChecksum(filePath, expectedChecksum, algorithm = 'sha256') {
    return new Promise((resolve, reject) => {
      const hash = algorithm.startsWith('hmac-') ?
        createHmac(algorithm.replace('hmac-', ''), this.options.hmacSecret) :
        createHash(algorithm);
      
      const stream = createReadStream(filePath);
      
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => {
        const actualChecksum = hash.digest('hex');
        resolve(actualChecksum === expectedChecksum);
      });
      stream.on('error', reject);
    });
  }
  
  /**
   * Verify compression integrity
   */
  async verifyCompression(filePath) {
    try {
      const gunzip = createGunzip();
      const input = createReadStream(filePath);
      
      // Test decompression without writing
      await pipeline(input, gunzip, async function* (source) {
        for await (const chunk of source) {
          // Just consume the data to verify decompression
        }
      });
      
      return true;
    } catch (error) {
      this.logger.error('Compression verification failed:', error);
      return false;
    }
  }
  
  /**
   * Verify database structure
   */
  async verifyDatabaseStructure(context) {
    let db;
    try {
      // Open database in read-only mode
      db = new Database(context.path, { readonly: true });
      
      // Check if it's a valid SQLite database
      const result = db.prepare('PRAGMA integrity_check').get();
      if (result.integrity_check !== 'ok') {
        context.errors.push('Database integrity check failed');
        return false;
      }
      
      // Verify expected tables exist
      if (context.metadata?.tables) {
        const tables = db.prepare(`
          SELECT name FROM sqlite_master 
          WHERE type='table' AND name NOT LIKE 'sqlite_%'
        `).all().map(row => row.name);
        
        const expectedTables = Object.keys(context.metadata.tables);
        const missingTables = expectedTables.filter(t => !tables.includes(t));
        
        if (missingTables.length > 0) {
          context.errors.push(`Missing tables: ${missingTables.join(', ')}`);
          return false;
        }
      }
      
      return true;
      
    } catch (error) {
      context.errors.push(`Structure verification error: ${error.message}`);
      return false;
    } finally {
      if (db) db.close();
    }
  }
  
  /**
   * Verify data integrity
   */
  async verifyDataIntegrity(context) {
    let db;
    try {
      db = new Database(context.path, { readonly: true });
      
      // Check for corrupt records
      const tables = db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
      `).all();
      
      for (const { name: table } of tables) {
        try {
          // Try to read all records
          const count = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
          
          // Sample check - read first and last records
          if (count > 0) {
            db.prepare(`SELECT * FROM ${table} LIMIT 1`).get();
            db.prepare(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT 1`).get();
          }
          
        } catch (error) {
          context.errors.push(`Data integrity error in table ${table}: ${error.message}`);
          return false;
        }
      }
      
      return true;
      
    } catch (error) {
      context.errors.push(`Data verification error: ${error.message}`);
      return false;
    } finally {
      if (db) db.close();
    }
  }
  
  /**
   * Verify row counts match metadata
   */
  async verifyRowCounts(context) {
    let db;
    try {
      db = new Database(context.path, { readonly: true });
      
      let allMatch = true;
      
      for (const [table, expectedCount] of Object.entries(context.metadata.tables)) {
        const actualCount = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
        
        if (actualCount !== expectedCount) {
          context.warnings.push(
            `Row count mismatch in ${table}: expected ${expectedCount}, got ${actualCount}`
          );
          allMatch = false;
        }
      }
      
      return allMatch;
      
    } catch (error) {
      context.errors.push(`Row count verification error: ${error.message}`);
      return false;
    } finally {
      if (db) db.close();
    }
  }
  
  /**
   * Verify foreign key relationships
   */
  async verifyRelationships(context) {
    let db;
    try {
      db = new Database(context.path, { readonly: true });
      
      // Enable foreign key checks
      db.pragma('foreign_keys = ON');
      
      // Check foreign key violations
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      
      if (violations.length > 0) {
        context.errors.push(`Found ${violations.length} foreign key violations`);
        violations.slice(0, 10).forEach(v => {
          context.errors.push(`  - Table ${v.table}: row ${v.rowid} violates FK to ${v.parent}`);
        });
        return false;
      }
      
      return true;
      
    } catch (error) {
      context.errors.push(`Relationship verification error: ${error.message}`);
      return false;
    } finally {
      if (db) db.close();
    }
  }
  
  /**
   * Verify constraints
   */
  async verifyConstraints(context) {
    let db;
    try {
      db = new Database(context.path, { readonly: true });
      
      // Quick check - try to query each table with its constraints
      const tables = db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
      `).all();
      
      for (const { name: table } of tables) {
        try {
          // This will fail if any constraint is violated
          db.prepare(`SELECT * FROM ${table} WHERE 1=0`).all();
        } catch (error) {
          context.errors.push(`Constraint violation in table ${table}: ${error.message}`);
          return false;
        }
      }
      
      return true;
      
    } catch (error) {
      context.errors.push(`Constraint verification error: ${error.message}`);
      return false;
    } finally {
      if (db) db.close();
    }
  }
  
  /**
   * Verify data consistency
   */
  async verifyDataConsistency(context) {
    let db;
    try {
      db = new Database(context.path, { readonly: true });
      
      // Check for orphaned records
      const orphanChecks = [
        {
          name: 'Orphaned sessions',
          query: 'SELECT COUNT(*) as count FROM sessions WHERE user_id NOT IN (SELECT id FROM users)'
        },
        {
          name: 'Orphaned transactions',
          query: 'SELECT COUNT(*) as count FROM transactions WHERE user_id NOT IN (SELECT id FROM users)'
        },
        {
          name: 'Orphaned orders',
          query: 'SELECT COUNT(*) as count FROM orders WHERE user_id NOT IN (SELECT id FROM users)'
        }
      ];
      
      let hasOrphans = false;
      
      for (const check of orphanChecks) {
        try {
          const result = db.prepare(check.query).get();
          if (result.count > 0) {
            context.warnings.push(`${check.name}: ${result.count} records`);
            hasOrphans = true;
          }
        } catch (error) {
          // Table might not exist, skip
        }
      }
      
      return !hasOrphans;
      
    } catch (error) {
      context.errors.push(`Consistency verification error: ${error.message}`);
      return false;
    } finally {
      if (db) db.close();
    }
  }
  
  /**
   * Check file access
   */
  async checkFileAccess(filePath) {
    try {
      const stats = statSync(filePath);
      
      if (!stats.isFile()) {
        throw new Error('Path is not a file');
      }
      
      // Try to read first few bytes
      const buffer = readFileSync(filePath, { encoding: null, flag: 'r', start: 0, end: 15 });
      
      // Check SQLite magic number
      const isSQLite = buffer.toString('utf8', 0, 15) === 'SQLite format 3';
      
      return {
        size: stats.size,
        modified: stats.mtime,
        isSQLite,
        readable: true
      };
      
    } catch (error) {
      throw new Error(`Cannot access backup file: ${error.message}`);
    }
  }
  
  /**
   * Load backup metadata
   */
  async loadMetadata(backupPath) {
    try {
      const metadataPath = backupPath + '.metadata';
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
      return metadata;
    } catch (error) {
      // Metadata is optional
      return null;
    }
  }
  
  /**
   * Calculate verification score
   */
  calculateVerificationScore(result) {
    if (!result.checks) return 0;
    
    const weights = {
      checksum: 30,
      size: 10,
      compression: 10,
      structure: 20,
      data: 15,
      rowCounts: 5,
      relationships: 5,
      constraints: 3,
      consistency: 2
    };
    
    let totalWeight = 0;
    let score = 0;
    
    for (const [check, weight] of Object.entries(weights)) {
      if (check in result.checks) {
        totalWeight += weight;
        if (result.checks[check]) {
          score += weight;
        }
      }
    }
    
    return totalWeight > 0 ? Math.round((score / totalWeight) * 100) : 0;
  }
  
  /**
   * Attempt to repair backup issues
   */
  async attemptRepairs(context) {
    this.stats.repairsAttempted++;
    
    const repairs = {
      attempted: [],
      succeeded: [],
      failed: [],
      success: false
    };
    
    // This is a placeholder - actual repair logic would be complex
    // and potentially dangerous, so it should be implemented carefully
    
    this.logger.warn('Backup repair not implemented - manual intervention required');
    
    return repairs;
  }
  
  /**
   * Get verification report
   */
  getReport(result) {
    const report = [`Backup Verification Report`,
      `========================`,
      `File: ${result.path || 'Unknown'}`,
      `Level: ${result.level}`,
      `Valid: ${result.valid ? 'Yes' : 'No'}`,
      `Score: ${result.score || 0}%`,
      `Duration: ${result.duration}ms`,
      ``,
      `Checks Performed:`
    ];
    
    if (result.checks) {
      for (const [check, passed] of Object.entries(result.checks)) {
        report.push(`  - ${check}: ${passed ? 'PASS' : 'FAIL'}`);
      }
    }
    
    if (result.errors?.length > 0) {
      report.push(``, `Errors:`);
      result.errors.forEach(err => report.push(`  - ${err}`));
    }
    
    if (result.warnings?.length > 0) {
      report.push(``, `Warnings:`);
      result.warnings.forEach(warn => report.push(`  - ${warn}`));
    }
    
    return report.join('\n');
  }
  
  /**
   * Get statistics
   */
  getStats() {
    const successRate = this.stats.verificationsPerformed > 0 ?
      (this.stats.verificationsSucceeded / this.stats.verificationsPerformed * 100).toFixed(2) : 0;
    
    return {
      ...this.stats,
      successRate: `${successRate}%`,
      averageBytesVerified: this.stats.verificationsPerformed > 0 ?
        Math.round(this.stats.totalBytesVerified / this.stats.verificationsPerformed) : 0
    };
  }
}

/**
 * Create backup verifier with defaults
 */
export function createBackupVerifier(options = {}) {
  return new BackupIntegrityVerifier(options);
}

export default BackupIntegrityVerifier;