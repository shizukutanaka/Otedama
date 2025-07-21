/**
 * Optimized Migration Manager for Otedama
 * Resolves ES Module compatibility issues and improves performance
 */

import Database from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename, extname } from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';

/**
 * Enhanced Migration Manager with ES Module compatibility
 */
export class OptimizedMigrationManager {
  constructor(dbPath, migrationsDir = './migrations') {
    this.dbPath = dbPath;
    this.migrationsDir = migrationsDir;
    this.db = null;
    this.migrationCache = new Map();
    this.lockTimeout = 30000; // 30 seconds
  }
  
  /**
   * Initialize migration system with enhanced error handling
   */
  async initialize() {
    try {
      this.db = new Database(this.dbPath, {
        verbose: process.env.NODE_ENV === 'development' ? console.log : null
      });
      
      // Set optimized pragmas
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('cache_size = -64000'); // 64MB cache
      this.db.pragma('temp_store = MEMORY');
      this.db.pragma('mmap_size = 268435456'); // 256MB mmap
      
      // Create migrations table with enhanced schema
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          version TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at INTEGER NOT NULL,
          execution_time INTEGER NOT NULL,
          status TEXT DEFAULT 'success',
          error TEXT,
          rollback_checksum TEXT,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `);
      
      // Create optimized indexes
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_migrations_version ON migrations(version)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_migrations_status ON migrations(status)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_migrations_applied_at ON migrations(applied_at)`);
      
      // Create migration lock table with timeout support
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS migration_lock (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          locked INTEGER DEFAULT 0,
          locked_at INTEGER,
          locked_by TEXT,
          timeout_at INTEGER,
          process_id INTEGER
        )
      `);
      
      // Initialize lock row
      this.db.exec(`INSERT OR IGNORE INTO migration_lock (id) VALUES (1)`);
      
      console.log('✅ Migration system initialized successfully');
      
    } catch (error) {
      console.error('❌ Failed to initialize migration system:', error);
      throw new Error(`Migration initialization failed: ${error.message}`);
    }
  }
  
  /**
   * Enhanced lock mechanism with timeout and process tracking
   */
  async acquireLock() {
    const processId = process.pid;
    const lockId = `${process.pid}-${Date.now()}`;
    const timeoutAt = Date.now() + this.lockTimeout;
    
    const maxAttempts = 30;
    let attempts = 0;
    
    while (attempts < maxAttempts) {
      try {
        // Check for expired locks
        const now = Date.now();
        this.db.prepare(`
          UPDATE migration_lock 
          SET locked = 0, locked_at = NULL, locked_by = NULL, timeout_at = NULL, process_id = NULL
          WHERE locked = 1 AND timeout_at < ?
        `).run(now);
        
        // Try to acquire lock
        const result = this.db.prepare(`
          UPDATE migration_lock 
          SET locked = 1, locked_at = ?, locked_by = ?, timeout_at = ?, process_id = ?
          WHERE locked = 0
        `).run(now, lockId, timeoutAt, processId);
        
        if (result.changes > 0) {
          console.log(`🔒 Migration lock acquired by process ${processId}`);
          return;
        }
        
        // Check who has the lock
        const lockInfo = this.db.prepare(`
          SELECT locked_by, locked_at, timeout_at, process_id 
          FROM migration_lock 
          WHERE locked = 1
        `).get();
        
        if (lockInfo) {
          console.log(`⏳ Waiting for migration lock (held by ${lockInfo.locked_by}, PID: ${lockInfo.process_id})`);
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
        
      } catch (error) {
        console.error('❌ Error acquiring migration lock:', error);
        throw error;
      }
    }
    
    throw new Error('Failed to acquire migration lock after maximum attempts');
  }
  
  /**
   * Release migration lock
   */
  async releaseLock() {
    try {
      const result = this.db.prepare(`
        UPDATE migration_lock 
        SET locked = 0, locked_at = NULL, locked_by = NULL, timeout_at = NULL, process_id = NULL
        WHERE process_id = ?
      `).run(process.pid);
      
      if (result.changes > 0) {
        console.log(`🔓 Migration lock released by process ${process.pid}`);
      }
    } catch (error) {
      console.error('❌ Error releasing migration lock:', error);
    }
  }
  
  /**
   * Enhanced migration loading with ES Module support
   */
  async loadMigration(version) {
    // Check cache first
    if (this.migrationCache.has(version)) {
      return this.migrationCache.get(version);
    }
    
    const migrationFiles = readdirSync(this.migrationsDir)
      .filter(file => file.startsWith(version))
      .sort();
    
    if (migrationFiles.length === 0) {
      throw new Error(`Migration file not found for version: ${version}`);
    }
    
    const migrationFile = migrationFiles[0];
    const migrationPath = join(this.migrationsDir, migrationFile);
    const ext = extname(migrationFile);
    
    try {
      let migrationModule;
      
      if (ext === '.js' || ext === '.mjs') {
        // ES Module import
        const fileUrl = pathToFileURL(migrationPath).href;
        migrationModule = await import(fileUrl + '?t=' + Date.now()); // Cache busting
      } else if (ext === '.cjs') {
        // CommonJS require
        delete require.cache[require.resolve(migrationPath)]; // Clear cache
        migrationModule = require(migrationPath);
      } else {
        throw new Error(`Unsupported migration file extension: ${ext}`);
      }
      
      // Validate migration structure
      if (!migrationModule.up || typeof migrationModule.up !== 'function') {
        throw new Error(`Migration ${version} missing 'up' function`);
      }
      
      // Calculate checksums
      const content = readFileSync(migrationPath, 'utf8');
      const checksum = createHash('sha256').update(content).digest('hex');
      
      const migration = {
        version,
        name: migrationModule.name || basename(migrationFile, ext),
        up: migrationModule.up,
        down: migrationModule.down,
        checksum,
        rollbackChecksum: migrationModule.down ? 
          createHash('sha256').update(migrationModule.down.toString()).digest('hex') : null
      };
      
      // Cache the migration
      this.migrationCache.set(version, migration);
      
      return migration;
      
    } catch (error) {
      console.error(`❌ Failed to load migration ${version}:`, error);
      throw new Error(`Failed to load migration ${version}: ${error.message}`);
    }
  }
  
  /**
   * Get pending migrations with validation
   */
  async getPendingMigrations() {
    const appliedMigrations = this.db.prepare(`
      SELECT version, checksum FROM migrations 
      WHERE status = 'success' 
      ORDER BY version
    `).all();
    
    const appliedVersions = new Set(appliedMigrations.map(m => m.version));
    
    // Get all migration files
    const migrationFiles = readdirSync(this.migrationsDir)
      .filter(file => /^\d{4}-\d{2}-\d{2}-\d{6}/.test(file))
      .sort();
    
    const pending = [];
    
    for (const file of migrationFiles) {
      const version = file.split('-').slice(0, 4).join('-');
      
      if (!appliedVersions.has(version)) {
        try {
          const migration = await this.loadMigration(version);
          pending.push(migration);
        } catch (error) {
          console.error(`❌ Failed to load pending migration ${version}:`, error);
          throw error;
        }
      }
    }
    
    return pending;
  }
  
  /**
   * Enhanced migration execution with better error handling
   */
  async migrate() {
    await this.initialize();
    
    console.log('🚀 Starting database migration...');
    
    try {
      // Acquire lock
      await this.acquireLock();
      
      // Get current version
      const currentVersion = this.getCurrentVersion();
      console.log(`📊 Current database version: ${currentVersion || 'none'}`);
      
      // Get pending migrations
      const pendingMigrations = await this.getPendingMigrations();
      
      if (pendingMigrations.length === 0) {
        console.log('✅ Database is up to date');
        return { migrated: 0, current: currentVersion };
      }
      
      console.log(`📋 Found ${pendingMigrations.length} pending migration(s)`);
      
      let migrated = 0;
      
      // Execute migrations in transaction groups
      for (const migration of pendingMigrations) {
        console.log(`\n🔄 Applying migration: ${migration.version} - ${migration.name}`);
        
        const start = Date.now();
        
        try {
          // Create a savepoint for this migration
          const savepoint = `migration_${migration.version.replace(/-/g, '_')}`;
          
          const runMigration = this.db.transaction(() => {
            // Create savepoint
            this.db.exec(`SAVEPOINT ${savepoint}`);
            
            try {
              // Execute migration
              migration.up(this.db);
              
              // Record successful migration
              this.db.prepare(`
                INSERT INTO migrations (
                  version, name, checksum, applied_at, execution_time, 
                  status, rollback_checksum
                ) VALUES (?, ?, ?, ?, ?, 'success', ?)
              `).run(
                migration.version,
                migration.name,
                migration.checksum,
                Date.now(),
                Date.now() - start,
                migration.rollbackChecksum
              );
              
              // Release savepoint
              this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
              
            } catch (error) {
              // Rollback to savepoint
              this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
              throw error;
            }
          });
          
          runMigration();
          
          const duration = Date.now() - start;
          console.log(`✅ Migration ${migration.version} completed successfully (${duration}ms)`);
          migrated++;
          
        } catch (error) {
          console.error(`❌ Migration ${migration.version} failed:`, error);
          
          // Record failed migration
          try {
            this.db.prepare(`
              INSERT INTO migrations (
                version, name, checksum, applied_at, execution_time, 
                status, error
              ) VALUES (?, ?, ?, ?, ?, 'failed', ?)
            `).run(
              migration.version,
              migration.name,
              migration.checksum,
              Date.now(),
              Date.now() - start,
              error.message
            );
          } catch (recordError) {
            console.error('❌ Failed to record migration failure:', recordError);
          }
          
          throw new Error(`Migration ${migration.version} failed: ${error.message}`);
        }
      }
      
      const newVersion = this.getCurrentVersion();
      console.log(`\n🎉 Migration complete! New version: ${newVersion}`);
      console.log(`📊 Applied ${migrated} migration(s)`);
      
      return { migrated, current: newVersion };
      
    } finally {
      // Always release lock and close database
      await this.releaseLock();
      if (this.db) {
        this.db.close();
      }
    }
  }
  
  /**
   * Get current database version
   */
  getCurrentVersion() {
    try {
      const result = this.db.prepare(`
        SELECT version FROM migrations 
        WHERE status = 'success' 
        ORDER BY version DESC 
        LIMIT 1
      `).get();
      
      return result ? result.version : null;
    } catch (error) {
      console.error('❌ Error getting current version:', error);
      return null;
    }
  }
  
  /**
   * Get migration history
   */
  getMigrationHistory() {
    return this.db.prepare(`
      SELECT version, name, status, applied_at, execution_time, error
      FROM migrations 
      ORDER BY applied_at DESC
    `).all();
  }
  
  /**
   * Validate migration integrity
   */
  async validateMigrations() {
    console.log('🔍 Validating migration integrity...');
    
    const appliedMigrations = this.db.prepare(`
      SELECT version, checksum FROM migrations 
      WHERE status = 'success'
    `).all();
    
    const issues = [];
    
    for (const applied of appliedMigrations) {
      try {
        const migration = await this.loadMigration(applied.version);
        
        if (migration.checksum !== applied.checksum) {
          issues.push({
            version: applied.version,
            issue: 'checksum_mismatch',
            expected: applied.checksum,
            actual: migration.checksum
          });
        }
      } catch (error) {
        issues.push({
          version: applied.version,
          issue: 'file_missing',
          error: error.message
        });
      }
    }
    
    if (issues.length > 0) {
      console.error('❌ Migration integrity issues found:', issues);
      return { valid: false, issues };
    }
    
    console.log('✅ All migrations are valid');
    return { valid: true, issues: [] };
  }
  
  /**
   * Cleanup failed migrations
   */
  cleanupFailedMigrations() {
    const result = this.db.prepare(`
      DELETE FROM migrations WHERE status = 'failed'
    `).run();
    
    console.log(`🧹 Cleaned up ${result.changes} failed migration(s)`);
    return result.changes;
  }
}

// Export singleton instance
export const optimizedMigrationManager = new OptimizedMigrationManager('./data/otedama.db');

// Export class for custom instances
export default OptimizedMigrationManager;
