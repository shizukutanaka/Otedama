/**
 * Database Migration System for Otedama
 * Manages schema versioning and migrations
 */

import Database from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';

/**
 * Migration Manager
 */
export class MigrationManager {
  constructor(dbPath, migrationsDir = './migrations') {
    this.dbPath = dbPath;
    this.migrationsDir = migrationsDir;
    this.db = null;
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
        error TEXT,
        INDEX idx_version (version),
        INDEX idx_applied_at (applied_at)
      )
    `);
    
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
    await this.initialize();
    
    console.log('Starting database migration...');
    
    try {
      // Acquire lock
      await this.acquireLock();
      
      // Get current version
      const currentVersion = this.getCurrentVersion();
      console.log(`Current database version: ${currentVersion || 'none'}`);
      
      // Get pending migrations
      const pending = await this.getPendingMigrations(currentVersion);
      
      if (pending.length === 0) {
        console.log('Database is up to date');
        return { migrated: 0, current: currentVersion };
      }
      
      console.log(`Found ${pending.length} pending migration(s)`);
      
      // Run migrations in transaction
      let migrated = 0;
      
      for (const migration of pending) {
        console.log(`\nApplying migration: ${migration.version} - ${migration.name}`);
        
        const start = Date.now();
        
        try {
          this.db.transaction(() => {
            // Run migration
            migration.up(this.db);
            
            // Record migration
            this.db.prepare(`
              INSERT INTO migrations (version, name, checksum, applied_at, execution_time, status)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(
              migration.version,
              migration.name,
              migration.checksum,
              Date.now(),
              Date.now() - start,
              'success'
            );
          })();
          
          console.log(`✓ Migration ${migration.version} applied successfully (${Date.now() - start}ms)`);
          migrated++;
          
        } catch (error) {
          console.error(`✗ Migration ${migration.version} failed: ${error.message}`);
          
          // Record failure
          this.db.prepare(`
            INSERT INTO migrations (version, name, checksum, applied_at, execution_time, status, error)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            migration.version,
            migration.name,
            migration.checksum,
            Date.now(),
            Date.now() - start,
            'failed',
            error.message
          );
          
          throw error;
        }
      }
      
      const newVersion = this.getCurrentVersion();
      console.log(`\nMigration complete. New version: ${newVersion}`);
      
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
    
    console.log('Starting database rollback...');
    
    try {
      // Acquire lock
      await this.acquireLock();
      
      // Get migrations to rollback
      const toRollback = this.getMigrationsToRollback(targetVersion);
      
      if (toRollback.length === 0) {
        console.log('No migrations to rollback');
        return { rolledBack: 0 };
      }
      
      console.log(`Rolling back ${toRollback.length} migration(s)`);
      
      let rolledBack = 0;
      
      for (const migration of toRollback) {
        console.log(`\nRolling back: ${migration.version} - ${migration.name}`);
        
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
          
          console.log(`✓ Rollback ${migration.version} completed (${Date.now() - start}ms)`);
          rolledBack++;
          
        } catch (error) {
          console.error(`✗ Rollback ${migration.version} failed: ${error.message}`);
          throw error;
        }
      }
      
      const newVersion = this.getCurrentVersion();
      console.log(`\nRollback complete. Current version: ${newVersion || 'none'}`);
      
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
    
    console.log(`Created migration: ${filepath}`);
    
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
    const file = files.find(f => f.startsWith(version + '_'));
    
    if (!file) {
      throw new Error(`Migration ${version} not found`);
    }
    
    const filepath = join(process.cwd(), this.migrationsDir, file);
    return await import(filepath);
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
          console.log('Clearing stale migration lock');
          this.db.prepare('UPDATE migration_lock SET locked = 0 WHERE id = 1').run();
          continue;
        }
        
        console.log(`Migration lock is held by process ${lock.locked_by}, waiting...`);
        
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