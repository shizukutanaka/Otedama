#!/usr/bin/env node
/**
 * Execute Project Cleanup for Otedama
 * Run the cleanup-project.js script
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('Executing Otedama project cleanup...\n');

// Run the cleanup script
const cleanup = spawn('node', [path.join(__dirname, 'cleanup-project.js')], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit'
});

cleanup.on('error', (error) => {
  console.error('Failed to start cleanup:', error);
  process.exit(1);
});

cleanup.on('exit', (code) => {
  if (code === 0) {
    console.log('\n✓ Cleanup completed successfully!');
  } else {
    console.error(`\n✗ Cleanup failed with code ${code}`);
  }
  process.exit(code);
});
