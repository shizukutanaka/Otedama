/**
 * Database Migration System
 * Following Carmack/Martin/Pike principles:
 * - Simple and straightforward
 * - No over-engineering
 * - Clear and predictable behavior
 */

import * as fs from 'fs';
import * as path from 'path';
import { Database } from 'sqlite3';
import { promisify } from 'util';

interface Migration {
  id: number;
  name: string;
  timestamp: number;
  up: string;
  down: string;
}

interface MigrationRecord {
  id: number;
  name: string;
  applied_at: string;
}

export class MigrationManager {
  private db: Database;
  private migrationsPath: string;

  constructor(dbPath: string, migrationsPath: string) {
    this.db = new Database(dbPath);
    this.migrationsPath = migrationsPath;
  }

  /**
   * Initialize migration table
   */
  async init(): Promise<void> {
    const sql = `
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    
    await this.run(sql);
  }

  /**
   * Run pending migrations
   */
  async up(): Promise<void> {
    await this.init();
    
    const applied = await this.getAppliedMigrations();
    const migrations = await this.loadMigrations();
    const pending = migrations.filter(m => !applied.find(a => a.id === m.id));
    
    if (pending.length === 0) {
      console.log('✅ No pending migrations');
      return;
    }
    
    console.log(`🔄 Running ${pending.length} migrations...`);
    
    for (const migration of pending) {
      await this.runMigration(migration, 'up');
    }
    
    console.log('✅ All migrations completed');
  }

  /**
   * Rollback last migration
   */
  async down(): Promise<void> {
    await this.init();
    
    const applied = await this.getAppliedMigrations();
    if (applied.length === 0) {
      console.log('⚠️  No migrations to rollback');
      return;
    }
    
    const last = applied[applied.length - 1];
    const migrations = await this.loadMigrations();
    const migration = migrations.find(m => m.id === last.id);
    
    if (!migration) {
      throw new Error(`Migration ${last.id} not found`);
    }
    
    await this.runMigration(migration, 'down');
    console.log('✅ Rollback completed');
  }

  /**
   * Get status of migrations
   */
  async status(): Promise<void> {
    await this.init();
    
    const applied = await this.getAppliedMigrations();
    const migrations = await this.loadMigrations();
    
    console.log('\n📊 Migration Status:\n');
    console.log('ID\tStatus\t\tName');
    console.log('--\t------\t\t----');
    
    for (const migration of migrations) {
      const isApplied = applied.find(a => a.id === migration.id);
      const status = isApplied ? '✅ Applied' : '⏳ Pending';
      console.log(`${migration.id}\t${status}\t${migration.name}`);
    }
  }

  /**
   * Create a new migration
   */
  async create(name: string): Promise<void> {
    const timestamp = Date.now();
    const id = Math.floor(timestamp / 1000);
    const filename = `${id}_${name.replace(/\s+/g, '_').toLowerCase()}.sql`;
    const filepath = path.join(this.migrationsPath, filename);
    
    const template = `-- Migration: ${name}
-- Created: ${new Date().toISOString()}

-- UP
-- Add your migration SQL here


-- DOWN
-- Add your rollback SQL here

`;
    
    fs.writeFileSync(filepath, template);
    console.log(`✅ Created migration: ${filename}`);
  }

  /**
   * Run a specific migration
   */
  private async runMigration(migration: Migration, direction: 'up' | 'down'): Promise<void> {
    const sql = direction === 'up' ? migration.up : migration.down;
    
    console.log(`${direction === 'up' ? '⬆️' : '⬇️'} Running migration ${migration.id}: ${migration.name}`);
    
    await this.exec(sql);
    
    if (direction === 'up') {
      await this.run(
        'INSERT INTO migrations (id, name) VALUES (?, ?)',
        [migration.id, migration.name]
      );
    } else {
      await this.run(
        'DELETE FROM migrations WHERE id = ?',
        [migration.id]
      );
    }
  }

  /**
   * Load all migrations from disk
   */
  private async loadMigrations(): Promise<Migration[]> {
    if (!fs.existsSync(this.migrationsPath)) {
      fs.mkdirSync(this.migrationsPath, { recursive: true });
      return [];
    }
    
    const files = fs.readdirSync(this.migrationsPath)
      .filter(f => f.endsWith('.sql'))
      .sort();
    
    const migrations: Migration[] = [];
    
    for (const file of files) {
      const filepath = path.join(this.migrationsPath, file);
      const content = fs.readFileSync(filepath, 'utf8');
      
      // Parse migration file
      const match = file.match(/^(\d+)_(.+)\.sql$/);
      if (!match) continue;
      
      const id = parseInt(match[1], 10);
      const name = match[2].replace(/_/g, ' ');
      
      // Split UP and DOWN sections
      const sections = content.split(/--\s*DOWN/i);
      const upSection = sections[0].replace(/--\s*UP/i, '').trim();
      const downSection = (sections[1] || '').trim();
      
      migrations.push({
        id,
        name,
        timestamp: id * 1000,
        up: upSection,
        down: downSection
      });
    }
    
    return migrations;
  }

  /**
   * Get applied migrations
   */
  private async getAppliedMigrations(): Promise<MigrationRecord[]> {
    const sql = 'SELECT * FROM migrations ORDER BY id';
    return await this.all(sql);
  }

  /**
   * Database helper methods
   */
  private run(sql: string, params: any[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private all(sql: string, params: any[] = []): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  private exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.exec(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Close database connection
   */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

// CLI Interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../../data/pool.db');
  const migrationsPath = path.join(__dirname, '../../src/database/migrations');
  
  const manager = new MigrationManager(dbPath, migrationsPath);
  
  try {
    switch (command) {
      case 'up':
      case 'migrate':
        await manager.up();
        break;
      
      case 'down':
      case 'rollback':
        await manager.down();
        break;
      
      case 'status':
        await manager.status();
        break;
      
      case 'create':
        const name = args.slice(1).join(' ');
        if (!name) {
          console.error('❌ Please provide a migration name');
          process.exit(1);
        }
        await manager.create(name);
        break;
      
      default:
        console.log(`
Database Migration Tool

Usage:
  npm run db:migrate [command]

Commands:
  up, migrate     Run all pending migrations
  down, rollback  Rollback the last migration
  status          Show migration status
  create <name>   Create a new migration

Examples:
  npm run db:migrate up
  npm run db:migrate create "add user table"
  npm run db:migrate status
        `);
    }
  } catch (error) {
    console.error('❌ Migration error:', error);
    process.exit(1);
  } finally {
    await manager.close();
  }
}

if (require.main === module) {
  main();
}
