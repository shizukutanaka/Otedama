/**
 * Database Migration System for Otedama
 * Manages schema versioning and migrations
 */

import Database from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { getLogger } from './core/logger.js';

/**
 * Migration Manager
 */
export class MigrationManager {
  constructor(dbPath, migrationsDir = null) {
    this.dbPath = dbPath;
    this.migrationsDir = migrationsDir || join(process.cwd(), 'migrations');
    this.db = null;
    this.logger = getLogger('Migration');
  }
  
  /**
   * Initialize migration system
   */
  async initialize() {
    this.db = new Database(this.dbPath);
    
    // Create migrations table if not exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        execution_time INTEGER NOT NULL,
        status TEXT DEFAULT 'success',
        error TEXT
      )
    `);
    
    // Create indexes for migrations table
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_migrations_version ON migrations(version)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_migrations_applied_at ON migrations(applied_at)`);
    
    // Create migration lock table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migration_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        locked INTEGER DEFAULT 0,
        locked_at INTEGER,
        locked_by TEXT
      )
    `);
    
    // Insert lock row if not exists
    this.db.prepare('INSERT OR IGNORE INTO migration_lock (id) VALUES (1)').run();
  }
  
  /**
   * Run all pending migrations
   */
  async migrate() {
    this.logger.debug('Entering migrate()');
    await this.initialize();
    this.logger.debug('initialize() completed');
    
    this.logger.info('Starting database migration...');
    
    try {
      // Acquire lock
      this.logger.debug('Acquiring lock...');
      await this.acquireLock();
      this.logger.debug('Lock acquired');
      
      // Get current version
      this.logger.debug('Getting current version...');
      const currentVersion = this.getCurrentVersion();
      this.logger.debug(`Current version: ${currentVersion || 'none'}`);
      this.logger.info(`Current database version: ${currentVersion || 'none'}`);
      
      // Get pending migrations
      this.logger.debug('Getting pending migrations...');
      const pending = await this.getPendingMigrations(currentVersion);
      this.logger.debug(`Found ${pending.length} pending migrations`);
      
      if (pending.length === 0) {
        this.logger.info('Database is up to date');
        return { migrated: 0, current: currentVersion };
      }
      
      this.logger.info(`Found ${pending.length} pending migration(s)`);
      
      // Run migrations in transaction
      let migrated = 0;
      
      for (const migration of pending) {
        this.logger.info(`Applying migration: ${migration.version} - ${migration.name}`);
        
        const start = Date.now();
        
        try {
          this.logger.debug(`Starting transaction for ${migration.version}`);
          const runTransaction = this.db.transaction(() => {
            this.logger.debug(`Executing 'up' for ${migration.version}`);
            migration.up(this.db);
            this.logger.debug(`'up' for ${migration.version} completed`);
            
            this.logger.debug(`Recording success for ${migration.version}`);
            this.db.prepare(`
              INSERT INTO migrations (version, name, checksum, applied_at, execution_time, status)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(migration.version, migration.name, migration.checksum, Date.now(), Date.now() - start, 'success');
            this.logger.debug(`Success recorded for ${migration.version}`);
          });

          runTransaction();
          
          migrated++;
          this.logger.info(`Successfully applied migration: ${migration.version}`);
          
        } catch (error) {
          console.error(`[MIGRATE_DEBUG] FATAL: Failed to apply migration ${migration.version}:`, error);
          
          try {
            this.db.prepare(`
              INSERT INTO migrations (version, name, checksum, applied_at, execution_time, status, error)
              VALUES (?, ?, ?, ?, ?, 'failed', ?)
            `).run(migration.version, migration.name, migration.checksum, Date.now(), Date.now() - start, error.message);
          } catch (recordError) {
            console.error(`[MIGRATE_DEBUG] FATAL: Could not even record migration failure:`, recordError);
          }
          
          throw new Error(`Migration ${migration.version} failed: ${error.message}`);
        }
      }
      
      const newVersion = this.getCurrentVersion();
      this.logger.info(`Migration complete. New version: ${newVersion}`);
      
      return { migrated, current: newVersion };
      
    } finally {
      // Release lock
      await this.releaseLock();
      this.db.close();
    }
  }
  
  /**
   * Rollback to specific version
   */
  async rollback(targetVersion = null) {
    await this.initialize();
    
    this.logger.info('Starting database rollback...');
    
    try {
      // Acquire lock
      await this.acquireLock();
      
      // Get migrations to rollback
      const toRollback = this.getMigrationsToRollback(targetVersion);
      
      if (toRollback.length === 0) {
        this.logger.info('No migrations to rollback');
        return { rolledBack: 0 };
      }
      
      this.logger.info(`Rolling back ${toRollback.length} migration(s)`);
      
      let rolledBack = 0;
      
      for (const migration of toRollback) {
        this.logger.info(`Rolling back: ${migration.version} - ${migration.name}`);
        
        const start = Date.now();
        
        try {
          // Load migration file
          const migrationModule = await this.loadMigration(migration.version);
          
          if (!migrationModule.down) {
            throw new Error('Migration does not support rollback');
          }
          
          this.db.transaction(() => {
            // Run rollback
            migrationModule.down(this.db);
            
            // Remove migration record
            this.db.prepare('DELETE FROM migrations WHERE version = ?').run(migration.version);
          })();
          
          this.logger.info(`✓ Rollback ${migration.version} completed (${Date.now() - start}ms`);
          rolledBack++;
          
        } catch (error) {
          console.error(`✗ Rollback ${migration.version} failed: ${error.message}`);
          throw error;
        }
      }
      
      const newVersion = this.getCurrentVersion();
      this.logger.info(`Rollback complete. Current version: ${newVersion || 'none'}`);
      
      return { rolledBack, current: newVersion };
      
    } finally {
      // Release lock
      await this.releaseLock();
      this.db.close();
    }
  }
  
  /**
   * Get migration status
   */
  async status() {
    await this.initialize();
    
    try {
      const applied = this.db.prepare(`
        SELECT version, name, applied_at, execution_time, status
        FROM migrations
        ORDER BY applied_at DESC
      `).all();
      
      const pending = await this.getPendingMigrations();
      
      return {
        current: this.getCurrentVersion(),
        applied: applied.length,
        pending: pending.length,
        migrations: {
          applied,
          pending: pending.map(m => ({ version: m.version, name: m.name }))
        }
      };
      
    } finally {
      this.db.close();
    }
  }
  
  /**
   * Create a new migration
   */
  async create(name) {
    const version = this.generateVersion();
    const filename = `${version}_${name.toLowerCase().replace(/\s+/g, '_')}.js`;
    const filepath = join(this.migrationsDir, filename);
    
    const template = `/**
 * Migration: ${name}
 * Version: ${version}
 * Created: ${new Date().toISOString()}
 */

export const version = '${version}';
export const name = '${name}';

/**
 * Run the migration
 */
export function up(db) {
  // Add your migration code here
  // Example:
  // db.exec(\`
  //   CREATE TABLE new_table (
  //     id INTEGER PRIMARY KEY AUTOINCREMENT,
  //     name TEXT NOT NULL,
  //     created_at INTEGER NOT NULL
  //   )
  // \`);
}

/**
 * Rollback the migration
 */
export function down(db) {
  // Add your rollback code here
  // Example:
  // db.exec('DROP TABLE IF EXISTS new_table');
}
`;
    
    const { writeFileSync, mkdirSync } = await import('fs');
    
    // Ensure migrations directory exists
    mkdirSync(this.migrationsDir, { recursive: true });
    
    // Write migration file
    writeFileSync(filepath, template);
    
    this.logger.info(`Created migration: ${filepath}`);
    
    return { version, name, filepath };
  }
  
  /**
   * Get current database version
   */
  getCurrentVersion() {
    const result = this.db.prepare(`
      SELECT version FROM migrations
      WHERE status = 'success'
      ORDER BY version DESC
      LIMIT 1
    `).get();
    
    return result ? result.version : null;
  }
  
  /**
   * Get pending migrations
   */
  async getPendingMigrations(afterVersion = null) {
    const files = existsSync(this.migrationsDir) 
      ? readdirSync(this.migrationsDir).filter(f => f.endsWith('.js'))
      : [];
    
    const migrations = [];
    
    for (const file of files) {
      const version = file.split('_')[0];
      
      // Skip if already applied or before target version
      if (afterVersion && version <= afterVersion) continue;
      
      const applied = this.db.prepare('SELECT 1 FROM migrations WHERE version = ?').get(version);
      if (applied) continue;
      
      // Load migration
      const migration = await this.loadMigration(version);
      migrations.push({
        version,
        name: migration.name,
        checksum: this.calculateChecksum(file),
        up: migration.up,
        down: migration.down
      });
    }
    
    // Sort by version
    return migrations.sort((a, b) => a.version.localeCompare(b.version));
  }
  
  /**
   * Get migrations to rollback
   */
  getMigrationsToRollback(targetVersion) {
    let query = `
      SELECT version, name FROM migrations
      WHERE status = 'success'
    `;
    
    const params = [];
    
    if (targetVersion) {
      query += ' AND version > ?';
      params.push(targetVersion);
    }
    
    query += ' ORDER BY version DESC';
    
    return this.db.prepare(query).all(...params);
  }
  
  /**
   * Load migration module
   */
  async loadMigration(version) {
    const files = readdirSync(this.migrationsDir);
    
    // Prioritize .cjs files over .js files for better compatibility
    let file = files.find(f => f.startsWith(version + '_') && f.endsWith('.cjs'));
    if (!file) {
      file = files.find(f => f.startsWith(version + '_') && f.endsWith('.js'));
    }
    
    if (!file) {
      throw new Error(`Migration ${version} not found`);
    }
    
    const filepath = join(this.migrationsDir, file);
    
    // Use createRequire for .cjs files, dynamic import for .js files
    if (file.endsWith('.cjs')) {
      this.logger.debug(`Loading CommonJS migration: ${file}`);
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      
      // Clear require cache to ensure fresh load
      delete require.cache[require.resolve(filepath)];
      
      return require(filepath);
    } else {
      this.logger.debug(`Loading ES Module migration: ${file}`);
      try {
        const { pathToFileURL } = await import('url');
        const fileUrl = pathToFileURL(filepath).href;
        return await import(fileUrl);
      } catch (importError) {
        this.logger.debug(`Dynamic import failed: ${importError.message}`);
        throw importError;
      }
    }
  }
  
  /**
   * Generate version string (timestamp-based)
   */
  generateVersion() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    const second = String(now.getSeconds()).padStart(2, '0');
    
    return `${year}${month}${day}${hour}${minute}${second}`;
  }
  
  /**
   * Calculate file checksum
   */
  calculateChecksum(filename) {
    const filepath = join(this.migrationsDir, filename);
    const content = readFileSync(filepath, 'utf8');
    return createHash('sha256').update(content).digest('hex');
  }
  
  /**
   * Acquire migration lock
   */
  async acquireLock() {
    const maxAttempts = 10;
    const retryDelay = 1000;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = this.db.prepare(`
          UPDATE migration_lock
          SET locked = 1, locked_at = ?, locked_by = ?
          WHERE id = 1 AND locked = 0
        `).run(Date.now(), process.pid);
        
        if (result.changes > 0) {
          return true;
        }
        
        // Check if lock is stale (older than 5 minutes)
        const lock = this.db.prepare('SELECT * FROM migration_lock WHERE id = 1').get();
        if (lock.locked && Date.now() - lock.locked_at > 300000) {
          this.logger.warn('Clearing stale migration lock');
          this.db.prepare('UPDATE migration_lock SET locked = 0 WHERE id = 1').run();
          continue;
        }
        
        this.logger.info(`Migration lock is held by process ${lock.locked_by}, waiting...`);
        
      } catch (error) {
        console.error('Lock acquisition error:', error);
      }
      
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
    
    throw new Error('Failed to acquire migration lock');
  }
  
  /**
   * Release migration lock
   */
  async releaseLock() {
    this.db.prepare('UPDATE migration_lock SET locked = 0 WHERE id = 1').run();
  }
}

// Export singleton instance
export const migrationManager = new MigrationManager('./data/otedama.db');