#!/usr/bin/env node

/**
 * Verify Structure - Otedama
 * Verifies the project structure after consolidation
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Expected core modules
const expectedModules = [
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

// Expected files in each module
const moduleFiles = {
  'lib/core': ['index.js', 'logger.js', 'performance.js'],
  'lib/network': ['index.js', 'binary-protocol.js', 'p2p-manager.js'],
  'lib/storage': ['index.js'],
  'lib/mining': ['index.js', 'p2p-mining-pool.js', 'share-validator.js', 'miner-manager.js', 'payment-processor.js', 'mining-client.js', 'api-server.js'],
  'lib/dex': ['index.js'],
  'lib/security': ['index.js', 'ddos-protection.js'],
  'lib/monitoring': ['index.js'],
  'lib/api': ['index.js'],
  'lib/utils': ['index.js']
};

// Files that should not exist (old structure)
const unexpectedFiles = [
  'lib/networking',
  'lib/p2p',
  'lib/cache',
  'lib/database',
  'lib/persistence',
  'lib/microservices',
  'lib/blockchain',
  'lib/quantum',
  'lib/nft',
  'lib/lending',
  'lib/staking',
  'lib/wallet'
];

async function verifyStructure() {
  console.log('Verifying Otedama project structure...\n');
  
  let errors = 0;
  let warnings = 0;
  
  // Check expected modules exist
  console.log('Checking core modules:');
  for (const module of expectedModules) {
    const modulePath = path.join(process.cwd(), module);
    try {
      const stat = await fs.stat(modulePath);
      if (stat.isDirectory()) {
        console.log(`✓ ${module}`);
        
        // Check module files
        const expectedFiles = moduleFiles[module] || [];
        for (const file of expectedFiles) {
          const filePath = path.join(modulePath, file);
          try {
            await fs.stat(filePath);
            console.log(`  ✓ ${file}`);
          } catch (error) {
            console.error(`  ✗ Missing file: ${file}`);
            errors++;
          }
        }
      } else {
        console.error(`✗ ${module} is not a directory`);
        errors++;
      }
    } catch (error) {
      console.error(`✗ Missing module: ${module}`);
      errors++;
    }
  }
  
  // Check for unexpected directories
  console.log('\nChecking for old directories that should be removed:');
  for (const oldPath of unexpectedFiles) {
    const fullPath = path.join(process.cwd(), oldPath);
    try {
      await fs.stat(fullPath);
      console.warn(`⚠ Found old directory: ${oldPath} (should be removed)`);
      warnings++;
    } catch (error) {
      // Good, it doesn't exist
    }
  }
  
  // Check main files
  console.log('\nChecking main project files:');
  const mainFiles = [
    'package.json',
    'README.md',
    'start-mining-pool.js',
    'otedama-miner.js',
    'index.js'
  ];
  
  for (const file of mainFiles) {
    try {
      await fs.stat(file);
      console.log(`✓ ${file}`);
    } catch (error) {
      console.error(`✗ Missing file: ${file}`);
      errors++;
    }
  }
  
  // Summary
  console.log('\n========================================');
  console.log('Verification Summary:');
  console.log(`Errors: ${errors}`);
  console.log(`Warnings: ${warnings}`);
  
  if (errors === 0 && warnings === 0) {
    console.log('\n✅ Project structure is correct!');
  } else if (errors === 0) {
    console.log('\n⚠️  Project structure has warnings. Run cleanup script to fix.');
  } else {
    console.log('\n❌ Project structure has errors that need to be fixed.');
  }
  
  return errors === 0;
}

// Run verification
verifyStructure().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('Verification failed:', error);
  process.exit(1);
});
