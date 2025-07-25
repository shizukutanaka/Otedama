#!/usr/bin/env node
/**
 * Cleanup Script for Otedama
 * Removes duplicate and unnecessary files
 * 
 * Design:
 * - Carmack: Fast and efficient cleanup
 * - Martin: Clean project structure
 * - Pike: Simple maintenance tool
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// Files to remove
const filesToRemove = [
  // Backup files
  'lib/api/batch-endpoints.js.bak',
  'lib/api/social-endpoints.js.bak',
  
  // Duplicate blockchain integration
  'lib/storage/blockchain/blockchain-integration.js',
  
  // Non-core API endpoints
  'lib/api/social-endpoints.js',
  'lib/api/ml-endpoints.js',
  'lib/api/bot-endpoints.js',
  
  // Duplicate batch processing
  'lib/api/batch-endpoints.js',
  'lib/api/batch-operations.js',
  'lib/api/batch-processor.js',
  
  // Old versioning files (we'll use a simpler approach)
  'lib/api/version-adapter.js',
  'lib/api/versioned-routes.js',
  'lib/api/versioning.js',
  'lib/api/setup-versioned-api.js',
  
  // Documentation generators (keep simple)
  'lib/api/swagger-integration.js',
  'lib/api/openapi-generator.js',
  'lib/api/api-documentation-manager.js',
  
  // Duplicate storage files
  'lib/storage/decentralized-storage.js',
  'lib/storage/distributed-storage-integration.js'
];

// Directories to remove
const directoriesToRemove = [
  'lib/storage/blockchain'
];

/**
 * Remove files
 */
async function removeFiles() {
  console.log('Removing duplicate and unnecessary files...\n');
  
  for (const file of filesToRemove) {
    const filePath = path.join(projectRoot, file);
    
    try {
      await fs.access(filePath);
      await fs.unlink(filePath);
      console.log(`✓ Removed: ${file}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`✗ Error removing ${file}:`, error.message);
      }
    }
  }
}

/**
 * Remove directories
 */
async function removeDirectories() {
  console.log('\nRemoving unnecessary directories...\n');
  
  for (const dir of directoriesToRemove) {
    const dirPath = path.join(projectRoot, dir);
    
    try {
      await fs.access(dirPath);
      await fs.rm(dirPath, { recursive: true, force: true });
      console.log(`✓ Removed directory: ${dir}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`✗ Error removing ${dir}:`, error.message);
      }
    }
  }
}

/**
 * Update API index to use unified server
 */
async function updateAPIIndex() {
  console.log('\nUpdating API index...\n');
  
  const indexContent = `/**
 * API Module Index for Otedama
 * Exports unified API components
 */

export { APIServer as default } from './unified-api-server.js';
export { APIServer } from './unified-api-server.js';

// Legacy exports for compatibility
export { APIServer as PoolAPIServer } from './pool-api-server.js';
export { DashboardAPI } from './dashboard-api.js';
export { MinerAPI } from './miner-api.js';
export { RemoteManagementAPI } from './remote-management.js';
`;
  
  const indexPath = path.join(projectRoot, 'lib/api/index.js');
  
  try {
    await fs.writeFile(indexPath, indexContent, 'utf8');
    console.log('✓ Updated API index');
  } catch (error) {
    console.error('✗ Error updating API index:', error.message);
  }
}

/**
 * Main cleanup function
 */
async function cleanup() {
  console.log('====================================');
  console.log('Otedama Project Cleanup');
  console.log('====================================\n');
  
  try {
    await removeFiles();
    await removeDirectories();
    await updateAPIIndex();
    
    console.log('\n====================================');
    console.log('Cleanup completed successfully!');
    console.log('====================================');
    
  } catch (error) {
    console.error('\nCleanup failed:', error.message);
    process.exit(1);
  }
}

// Run cleanup
cleanup().catch(console.error);