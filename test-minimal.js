#!/usr/bin/env node

/**
 * Minimal test to check basic functionality
 */

import Database from 'better-sqlite3';
import express from 'express';

console.log('=== Minimal Startup Test ===\n');

try {
  // Test 1: Express
  console.log('1. Testing Express...');
  const app = express();
  console.log('✓ Express loaded successfully');
  
  // Test 2: SQLite
  console.log('\n2. Testing SQLite...');
  const db = new Database(':memory:');
  const stmt = db.prepare('SELECT 1 + 1 as result');
  const result = stmt.get();
  console.log('✓ SQLite working:', result);
  db.close();
  
  // Test 3: Basic imports
  console.log('\n3. Testing basic imports...');
  const { getLogger } = await import('./lib/core/logger.js');
  const logger = getLogger();
  console.log('✓ Logger loaded');
  
  console.log('\n=== Basic components working ===');
  
} catch (error) {
  console.error('\n❌ Error:', error.message);
  console.error(error);
}

process.exit(0);