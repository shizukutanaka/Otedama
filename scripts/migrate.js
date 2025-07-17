#!/usr/bin/env node

/**
 * Database Migration CLI for Otedama
 * Manages database schema versioning
 */

import { MigrationManager } from '../lib/migration.js';
import { resolve } from 'path';

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0] || 'up';
const options = {};

// Parse options
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].substring(2);
    const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
    options[key] = value;
  }
}

// Configuration
const dbPath = options.db || resolve('./data/otedama.db');
const migrationsDir = options.migrations || resolve('./migrations');

// Create migration manager
const migrationManager = new MigrationManager(dbPath, migrationsDir);

// Command handlers
async function up() {
  console.log('Running database migrations...\n');
  
  try {
    const result = await migrationManager.migrate();
    
    if (result.migrated === 0) {
      console.log('✅ No migrations to run');
    } else {
      console.log(`✅ Successfully ran ${result.migrated} migration(s)`);
    }
    
    console.log(`📌 Current version: ${result.current}`);
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

async function down() {
  const version = args[1];
  
  console.log('Rolling back database...\n');
  
  if (!options.force) {
    console.log('⚠️  WARNING: This will rollback migrations and may cause data loss!');
    console.log('Use --force to confirm rollback');
    process.exit(1);
  }
  
  try {
    const result = await migrationManager.rollback(version);
    
    if (result.rolledBack === 0) {
      console.log('✅ No migrations to rollback');
    } else {
      console.log(`✅ Successfully rolled back ${result.rolledBack} migration(s)`);
    }
    
    console.log(`📌 Current version: ${result.current || 'none'}`);
    
  } catch (error) {
    console.error('❌ Rollback failed:', error.message);
    process.exit(1);
  }
}

async function status() {
  console.log('Checking migration status...\n');
  
  try {
    const status = await migrationManager.status();
    
    console.log(`📌 Current version: ${status.current || 'none'}`);
    console.log(`✅ Applied migrations: ${status.applied}`);
    console.log(`⏳ Pending migrations: ${status.pending}`);
    
    if (status.migrations.applied.length > 0) {
      console.log('\nApplied migrations:');
      console.table(
        status.migrations.applied.map(m => ({
          version: m.version,
          name: m.name,
          applied: new Date(m.applied_at).toLocaleString(),
          duration: `${m.execution_time}ms`,
          status: m.status
        }))
      );
    }
    
    if (status.migrations.pending.length > 0) {
      console.log('\nPending migrations:');
      console.table(status.migrations.pending);
    }
    
  } catch (error) {
    console.error('❌ Status check failed:', error.message);
    process.exit(1);
  }
}

async function create() {
  const name = args.slice(1).join(' ') || 'new_migration';
  
  console.log('Creating new migration...\n');
  
  try {
    const result = await migrationManager.create(name);
    
    console.log('✅ Migration created successfully');
    console.log(`📁 File: ${result.filepath}`);
    console.log(`🏷️  Version: ${result.version}`);
    console.log(`📝 Name: ${result.name}`);
    console.log('\nEdit the migration file to add your schema changes.');
    
  } catch (error) {
    console.error('❌ Migration creation failed:', error.message);
    process.exit(1);
  }
}

async function validate() {
  console.log('Validating migrations...\n');
  
  try {
    await migrationManager.initialize();
    
    // Check for duplicate versions
    const { readdirSync } = await import('fs');
    const files = readdirSync(migrationsDir).filter(f => f.endsWith('.js'));
    const versions = files.map(f => f.split('_')[0]);
    const duplicates = versions.filter((v, i) => versions.indexOf(v) !== i);
    
    if (duplicates.length > 0) {
      console.error('❌ Duplicate migration versions found:', duplicates);
      process.exit(1);
    }
    
    // Validate each migration file
    let valid = 0;
    let invalid = 0;
    
    for (const file of files) {
      try {
        const filepath = resolve(migrationsDir, file);
        const migration = await import(filepath);
        
        if (!migration.version || !migration.name || !migration.up) {
          console.error(`❌ Invalid migration: ${file} - missing required exports`);
          invalid++;
        } else {
          valid++;
        }
      } catch (error) {
        console.error(`❌ Failed to load migration: ${file} - ${error.message}`);
        invalid++;
      }
    }
    
    console.log(`\n✅ Valid migrations: ${valid}`);
    if (invalid > 0) {
      console.log(`❌ Invalid migrations: ${invalid}`);
      process.exit(1);
    }
    
    console.log('\nAll migrations are valid!');
    
  } catch (error) {
    console.error('❌ Validation failed:', error.message);
    process.exit(1);
  }
}

// Help text
function showHelp() {
  console.log(`
Otedama Database Migration Tool

Usage: npm run db:migrate [command] [options]

Commands:
  up                  Run all pending migrations (default)
  down [version]      Rollback to specified version
  status              Show migration status
  create <name>       Create a new migration
  validate            Validate all migration files
  help                Show this help

Options:
  --db <path>         Database file path
  --migrations <dir>  Migrations directory
  --force             Force rollback without confirmation

Examples:
  npm run db:migrate                          # Run all pending migrations
  npm run db:migrate down 20250116120000     # Rollback to specific version
  npm run db:migrate down -- --force         # Rollback last migration
  npm run db:migrate status                   # Check migration status
  npm run db:migrate create add_user_table    # Create new migration
`);
}

// Main execution
async function main() {
  switch (command) {
    case 'up':
      await up();
      break;
    case 'down':
      await down();
      break;
    case 'status':
      await status();
      break;
    case 'create':
      await create();
      break;
    case 'validate':
      await validate();
      break;
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
    default:
      console.error(`❌ Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

// Run main function
main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});