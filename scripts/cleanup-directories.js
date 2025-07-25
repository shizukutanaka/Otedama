#!/usr/bin/env node

/**
 * Cleanup Script - Remove duplicate directories
 * This script removes directories that have been consolidated
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Directories to keep (as per ARCHITECTURE.md)
const directoriesToKeep = [
  'lib/core',
  'lib/network',
  'lib/storage',
  'lib/mining',
  'lib/dex',
  'lib/security',
  'lib/monitoring',
  'lib/api',
  'lib/utils'
];

// Directories explicitly marked for removal
const directoriesToRemove = [
  'lib/standalone',   // Old CommonJS format
  'lib/wasm',        // Over-engineered WebAssembly plugin system
  'lib/workers',     // Redundant with core WorkerPool
  'lib/wallet',      // Not needed for mining pool
  'lib/blockchain'   // Moved to storage/blockchain
];

// Get all directories in lib and filter out the ones to keep
async function getDirectoriesToRemove() {
  const libPath = path.join(process.cwd(), 'lib');
  const entries = await fs.readdir(libPath, { withFileTypes: true });
  
  const directories = entries
    .filter(entry => entry.isDirectory())
    .map(entry => `lib/${entry.name}`)
    .filter(dir => !directoriesToKeep.includes(dir));
  
  // Also add specific files that should be removed
  const filesToRemove = [
    'lib/export.js',
    'lib/lazy-loader.js',
    'lib/plugins.js',
    'lib/retry-manager.js',
    'lib/stability-manager.js',
    'lib/transaction-manager.js',
    'lib/webhooks.js',
    'lib/worker-pool.js'
  ];
  
  // Add explicitly marked directories for removal
  const allToRemove = [...new Set([...directories, ...directoriesToRemove, ...filesToRemove])];
  
  return allToRemove;
}

async function removeDirectory(dirPath) {
  try {
    const fullPath = path.join(process.cwd(), dirPath);
    await fs.rm(fullPath, { recursive: true, force: true });
    console.log(`✓ Removed: ${dirPath}`);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`✗ Error removing ${dirPath}:`, error.message);
    } else {
      console.log(`- Already removed: ${dirPath}`);
    }
    return false;
  }
}

async function cleanup() {
  console.log('Starting directory cleanup...\n');
  
  // Get directories to remove dynamically
  const directoriesToRemove = await getDirectoriesToRemove();
  
  console.log(`Found ${directoriesToRemove.length} items to remove\n`);
  
  let removed = 0;
  let failed = 0;
  
  for (const dir of directoriesToRemove) {
    const success = await removeDirectory(dir);
    if (success) {
      removed++;
    } else {
      failed++;
    }
  }
  
  console.log('\nCleanup complete!');
  console.log(`Removed: ${removed} items`);
  console.log(`Failed/Already removed: ${failed} items`);
  console.log(`\nKept directories: ${directoriesToKeep.join(', ')}`);
}

// Run cleanup
cleanup().catch(console.error);
