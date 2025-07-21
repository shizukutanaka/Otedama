/**
 * Database Migration Rollback Manager
 * 
 * Handles safe rollback of database migrations
 * Following clean code principles
 */

import { DatabaseManager } from '../core/database-manager.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class RollbackManager {
    constructor(options = {}) {
        this.db = options.db || new DatabaseManager();
        this.migrationsPath = options.migrationsPath || path.join(process.cwd(), 'migrations');
        this.backupPath = options.backupPath || path.join(process.cwd(), 'backups', 'migrations');
        this.dryRun = options.dryRun || false;
    }
    
    /**
     * Initialize rollback manager
     */
    async initialize() {
        await this.db.initialize();
        
        // Create backup directory
        await fs.mkdir(this.backupPath, { recursive: true });
        
        // Ensure migrations table exists
        await this.ensureMigrationsTable();
    }
    
    /**
     * Ensure migrations tracking table exists
     */
    async ensureMigrationsTable() {
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                version VARCHAR(255) NOT NULL UNIQUE,
                name VARCHAR(255) NOT NULL,
                executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                rollback_sql TEXT,
                checksum VARCHAR(64),
                execution_time INTEGER,
                rolled_back BOOLEAN DEFAULT 0,
                rolled_back_at DATETIME
            )
        `);
    }
    
    /**
     * Get migration history
     */
    async getMigrationHistory(limit = null) {
        let query = `
            SELECT * FROM schema_migrations 
            WHERE rolled_back = 0
            ORDER BY executed_at DESC
        `;
        
        if (limit) {
            query += ` LIMIT ${limit}`;
        }
        
        return await this.db.query(query);
    }
    
    /**
     * Rollback last migration
     */
    async rollbackLast() {
        const lastMigration = await this.getLastMigration();
        
        if (!lastMigration) {
            throw new Error('No migrations to rollback');
        }
        
        return await this.rollbackMigration(lastMigration.version);
    }
    
    /**
     * Rollback to specific version
     */
    async rollbackTo(targetVersion) {
        const migrations = await this.getMigrationHistory();
        const rollbackList = [];
        
        // Find all migrations after target version
        for (const migration of migrations) {
            if (migration.version === targetVersion) {
                break;
            }
            rollbackList.push(migration);
        }
        
        if (rollbackList.length === 0) {
            console.log('Already at target version');
            return;
        }
        
        console.log(`Rolling back ${rollbackList.length} migrations...`);
        
        // Rollback in reverse order
        for (const migration of rollbackList) {
            await this.rollbackMigration(migration.version);
        }
    }
    
    /**
     * Rollback specific migration
     */
    async rollbackMigration(version) {
        console.log(`Rolling back migration: ${version}`);
        
        // Get migration details
        const migration = await this.db.query(
            'SELECT * FROM schema_migrations WHERE version = ? AND rolled_back = 0',
            [version]
        );
        
        if (!migration || migration.length === 0) {
            throw new Error(`Migration ${version} not found or already rolled back`);
        }
        
        const migrationData = migration[0];
        
        // Create backup before rollback
        await this.createBackup(version);
        
        // Begin transaction
        const connection = await this.db.getConnection();
        await connection.beginTransaction();
        
        try {
            // Check for rollback SQL
            if (migrationData.rollback_sql) {
                // Execute stored rollback SQL
                if (!this.dryRun) {
                    const statements = migrationData.rollback_sql.split(';').filter(s => s.trim());
                    for (const statement of statements) {
                        await connection.query(statement);
                    }
                }
            } else {
                // Try to load rollback from file
                const rollbackSQL = await this.loadRollbackSQL(version);
                if (rollbackSQL) {
                    if (!this.dryRun) {
                        const statements = rollbackSQL.split(';').filter(s => s.trim());
                        for (const statement of statements) {
                            await connection.query(statement);
                        }
                    }
                } else {
                    throw new Error(`No rollback SQL found for migration ${version}`);
                }
            }
            
            // Mark migration as rolled back
            if (!this.dryRun) {
                await connection.query(
                    'UPDATE schema_migrations SET rolled_back = 1, rolled_back_at = ? WHERE version = ?',
                    [new Date(), version]
                );
            }
            
            await connection.commit();
            console.log(`Successfully rolled back migration: ${version}`);
            
        } catch (error) {
            await connection.rollback();
            console.error(`Failed to rollback migration ${version}:`, error);
            throw error;
        } finally {
            connection.release();
        }
    }
    
    /**
     * Load rollback SQL from migration file
     */
    async loadRollbackSQL(version) {
        // Try to find migration file
        const files = await fs.readdir(this.migrationsPath);
        const migrationFile = files.find(f => f.includes(version));
        
        if (!migrationFile) {
            return null;
        }
        
        const filePath = path.join(this.migrationsPath, migrationFile);
        
        try {
            // Import migration module
            const migration = await import(filePath);
            
            // Check for down/rollback method
            if (migration.down || migration.rollback) {
                const rollbackFn = migration.down || migration.rollback;
                
                // Capture SQL statements
                const statements = [];
                const mockDb = {
                    query: (sql) => statements.push(sql),
                    schema: {
                        dropTable: (table) => statements.push(`DROP TABLE IF EXISTS ${table}`),
                        dropColumn: (table, column) => statements.push(`ALTER TABLE ${table} DROP COLUMN ${column}`),
                        dropIndex: (table, index) => statements.push(`DROP INDEX IF EXISTS ${index}`)
                    }
                };
                
                await rollbackFn(mockDb);
                return statements.join(';\n');
            }
            
            return null;
        } catch (error) {
            console.error(`Failed to load rollback from file:`, error);
            return null;
        }
    }
    
    /**
     * Create backup before rollback
     */
    async createBackup(version) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(this.backupPath, `rollback_${version}_${timestamp}.sql`);
        
        console.log(`Creating backup: ${backupFile}`);
        
        // Export current schema
        const tables = await this.db.query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        );
        
        let backupSQL = '-- Backup before rollback\n';
        backupSQL += `-- Version: ${version}\n`;
        backupSQL += `-- Date: ${new Date().toISOString()}\n\n`;
        
        for (const table of tables) {
            // Get table schema
            const schema = await this.db.query(
                `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
                [table.name]
            );
            
            if (schema.length > 0) {
                backupSQL += `-- Table: ${table.name}\n`;
                backupSQL += schema[0].sql + ';\n\n';
            }
        }
        
        await fs.writeFile(backupFile, backupSQL);
    }
    
    /**
     * Get last migration
     */
    async getLastMigration() {
        const result = await this.db.query(
            'SELECT * FROM schema_migrations WHERE rolled_back = 0 ORDER BY executed_at DESC LIMIT 1'
        );
        
        return result[0] || null;
    }
    
    /**
     * List available rollbacks
     */
    async listRollbacks() {
        const migrations = await this.getMigrationHistory();
        
        console.log('\nAvailable rollbacks:');
        console.log('====================');
        
        if (migrations.length === 0) {
            console.log('No migrations to rollback');
            return;
        }
        
        for (const migration of migrations) {
            console.log(`${migration.version} - ${migration.name} (${migration.executed_at})`);
        }
    }
    
    /**
     * Verify rollback possibility
     */
    async canRollback(version) {
        const migration = await this.db.query(
            'SELECT * FROM schema_migrations WHERE version = ? AND rolled_back = 0',
            [version]
        );
        
        if (!migration || migration.length === 0) {
            return { canRollback: false, reason: 'Migration not found or already rolled back' };
        }
        
        const migrationData = migration[0];
        
        // Check for rollback SQL
        if (migrationData.rollback_sql) {
            return { canRollback: true, method: 'stored_sql' };
        }
        
        // Check for rollback file
        const rollbackSQL = await this.loadRollbackSQL(version);
        if (rollbackSQL) {
            return { canRollback: true, method: 'migration_file' };
        }
        
        return { canRollback: false, reason: 'No rollback method available' };
    }
    
    /**
     * Generate rollback SQL for migration
     */
    async generateRollbackSQL(version) {
        // This would analyze the migration and try to generate reverse operations
        // For now, return a template
        return `-- Rollback SQL for migration ${version}
-- TODO: Add rollback statements
-- Example:
-- DROP TABLE IF EXISTS new_table;
-- ALTER TABLE existing_table DROP COLUMN new_column;
`;
    }
}

/**
 * CLI interface for rollback
 */
export async function rollbackCLI(args) {
    const manager = new RollbackManager({
        dryRun: args.includes('--dry-run')
    });
    
    await manager.initialize();
    
    if (args.includes('--list')) {
        await manager.listRollbacks();
    } else if (args.includes('--last')) {
        await manager.rollbackLast();
    } else if (args.includes('--to')) {
        const versionIndex = args.indexOf('--to') + 1;
        if (versionIndex < args.length) {
            await manager.rollbackTo(args[versionIndex]);
        } else {
            console.error('Please specify target version with --to');
        }
    } else if (args.includes('--version')) {
        const versionIndex = args.indexOf('--version') + 1;
        if (versionIndex < args.length) {
            await manager.rollbackMigration(args[versionIndex]);
        } else {
            console.error('Please specify version to rollback');
        }
    } else {
        console.log('Database Migration Rollback Tool');
        console.log('================================');
        console.log('Usage:');
        console.log('  --list              List available rollbacks');
        console.log('  --last              Rollback last migration');
        console.log('  --to <version>      Rollback to specific version');
        console.log('  --version <version> Rollback specific migration');
        console.log('  --dry-run           Show what would be rolled back');
        console.log('');
        console.log('Examples:');
        console.log('  node rollback.js --list');
        console.log('  node rollback.js --last');
        console.log('  node rollback.js --to 20250116120000');
        console.log('  node rollback.js --version 20250120000000 --dry-run');
    }
    
    process.exit(0);
}

// Run CLI if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    rollbackCLI(process.argv.slice(2));
}

export default RollbackManager;