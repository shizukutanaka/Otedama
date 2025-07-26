#!/usr/bin/env node
/**
 * Comprehensive Duplicate File Cleanup for Otedama
 * Removes duplicate files and consolidates functionality
 * Following Pike's simplicity principle
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const duplicateGroups = [
  // Logger consolidation
  {
    keep: 'lib/core/structured-logger.js',
    remove: ['lib/core/lightweight-logger.js'],
    reason: 'structured-logger.js is the main logger implementation'
  },
  
  // Core consolidation
  {
    keep: 'lib/core/otedama-core.js',
    remove: ['lib/core/simplified-core.js'],
    reason: 'otedama-core.js is the main core implementation'
  },
  
  // Error handling consolidation
  {
    keep: 'lib/core/error-handler-unified.js',
    remove: ['lib/core/error-recovery.js'],
    reason: 'unified error handler includes recovery functionality'
  },
  
  // Backup consolidation
  {
    keep: 'lib/core/auto-backup.js',
    remove: ['lib/core/backup.js'],
    reason: 'auto-backup includes all backup functionality'
  },
  
  // Mining engine consolidation
  {
    keep: 'lib/mining/optimized-mining-engine.js',
    remove: [
      'lib/mining/simple-cpu-miner.js',
      'lib/mining/simple-gpu-miner.js'
    ],
    reason: 'optimized engine includes CPU/GPU mining'
  },
  
  // Monitoring consolidation
  {
    keep: 'lib/monitoring/unified-monitoring-system.js',
    remove: [
      'lib/monitoring/lightweight-dashboard.js',
      'lib/monitoring/performance-monitor.js',
      'lib/monitoring/metrics-aggregator.js'
    ],
    reason: 'unified monitoring includes all monitoring features'
  },
  
  // Security consolidation
  {
    keep: 'lib/security/unified-security-middleware.js',
    remove: [
      'lib/security/enhanced-security-system.js',
      'lib/security/comprehensive-security-middleware.js'
    ],
    reason: 'single unified security middleware'
  },
  
  // API consolidation
  {
    keep: 'lib/api/unified-api-server.js',
    remove: [
      'lib/api/pool-api-server.js',
      'lib/api/dashboard-api.js',
      'lib/api/miner-api.js'
    ],
    reason: 'unified API server handles all endpoints'
  },
  
  // Network consolidation
  {
    keep: 'lib/network/p2p-network-enhanced.js',
    remove: [
      'lib/network/p2p-manager.js',
      'lib/network/network-manager.js'
    ],
    reason: 'enhanced P2P network includes all network functionality'
  }
];

const unrealisticFiles = [
  'lib/security/quantum-resistant.js', // Keep basic quantum-resistant crypto but remove theoretical parts
  'lib/mining/quantum-mining-algorithm.js', // Remove if exists
];

async function getFileHash(filePath) {
  try {
    const content = await fs.readFile(filePath);
    return crypto.createHash('md5').update(content).digest('hex');
  } catch {
    return null;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function cleanupDuplicates() {
  console.log('🧹 Starting comprehensive duplicate cleanup...\n');
  
  let cleaned = 0;
  let errors = 0;
  
  for (const group of duplicateGroups) {
    console.log(`📁 Processing group: ${group.keep}`);
    console.log(`   Reason: ${group.reason}`);
    
    // Check if main file exists
    if (!await fileExists(group.keep)) {
      console.log(`   ⚠️  Main file doesn't exist: ${group.keep}`);
      continue;
    }
    
    // Remove duplicates
    for (const filePath of group.remove) {
      if (await fileExists(filePath)) {
        try {
          await fs.unlink(filePath);
          console.log(`   ✅ Removed: ${filePath}`);
          cleaned++;
        } catch (error) {
          console.log(`   ❌ Failed to remove: ${filePath} - ${error.message}`);
          errors++;
        }
      } else {
        console.log(`   ℹ️  Already missing: ${filePath}`);
      }
    }
    console.log('');
  }
  
  return { cleaned, errors };
}

async function removeUnrealisticFiles() {
  console.log('🚀 Removing unrealistic features...\n');
  
  let removed = 0;
  
  for (const filePath of unrealisticFiles) {
    if (await fileExists(filePath)) {
      try {
        // Instead of removing quantum-resistant.js, let's simplify it
        if (filePath === 'lib/security/quantum-resistant.js') {
          console.log(`   🔧 Simplifying: ${filePath}`);
          await simplifyQuantumResistant(filePath);
        } else {
          await fs.unlink(filePath);
          console.log(`   ✅ Removed: ${filePath}`);
          removed++;
        }
      } catch (error) {
        console.log(`   ❌ Failed to process: ${filePath} - ${error.message}`);
      }
    }
  }
  
  console.log('');
  return removed;
}

async function simplifyQuantumResistant(filePath) {
  // Keep only practical cryptographic functions, remove theoretical ones
  const simplifiedContent = `/**
 * Simplified Quantum-Resistant Security for Otedama
 * Practical cryptographic implementations only
 */

import { createHash, randomBytes } from 'crypto';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('QuantumResistant');

/**
 * Quantum-resistant hash function using SHA3
 */
export class QuantumResistantHash {
  constructor() {
    this.algorithm = 'sha3-512';
  }

  hash(data) {
    const hash = createHash('sha3-512');
    hash.update(data);
    return hash.digest();
  }

  merkleHash(leaves) {
    if (leaves.length === 0) return null;
    if (leaves.length === 1) return leaves[0];

    const pairs = [];
    for (let i = 0; i < leaves.length; i += 2) {
      if (i + 1 < leaves.length) {
        const combined = Buffer.concat([leaves[i], leaves[i + 1]]);
        pairs.push(this.hash(combined));
      } else {
        pairs.push(leaves[i]);
      }
    }

    return this.merkleHash(pairs);
  }
}

/**
 * Quantum-resistant key derivation
 */
export class QuantumResistantKDF {
  constructor() {
    this.iterations = 100000;
    this.saltLength = 32;
  }

  async deriveKey(password, salt = null) {
    if (!salt) {
      salt = randomBytes(this.saltLength);
    }

    let key = Buffer.from(password);
    
    for (let i = 0; i < this.iterations; i++) {
      const hash = createHash('sha3-512');
      hash.update(key);
      hash.update(salt);
      hash.update(Buffer.from(i.toString()));
      key = hash.digest();
    }

    return { key, salt };
  }

  randomBytes(length) {
    const systemRandom = randomBytes(length);
    const timeEntropy = Buffer.from(Date.now().toString());
    const processEntropy = Buffer.from(process.hrtime.bigint().toString());
    
    const hash = createHash('sha3-512');
    hash.update(systemRandom);
    hash.update(timeEntropy);
    hash.update(processEntropy);
    
    return hash.digest().slice(0, length);
  }
}

export const quantumHash = new QuantumResistantHash();
export const quantumKDF = new QuantumResistantKDF();

export default {
  QuantumResistantHash,
  QuantumResistantKDF,
  quantumHash,
  quantumKDF
};
`;

  await fs.writeFile(filePath, simplifiedContent, 'utf8');
}

async function validateProject() {
  console.log('🔍 Validating project structure...\n');
  
  const criticalFiles = [
    'index.js',
    'lib/core/structured-logger.js',
    'lib/core/otedama-core.js',
    'lib/zkp/enhanced-zkp-system.js',
    'package.json',
    'README.md'
  ];
  
  let valid = true;
  
  for (const file of criticalFiles) {
    if (!await fileExists(file)) {
      console.log(`   ❌ Missing critical file: ${file}`);
      valid = false;
    } else {
      console.log(`   ✅ ${file}`);
    }
  }
  
  console.log('');
  return valid;
}

async function main() {
  console.log('Otedama Project Cleanup');
  console.log('=======================\n');
  
  try {
    // Clean up duplicates
    const { cleaned, errors } = await cleanupDuplicates();
    
    // Remove unrealistic features
    const removed = await removeUnrealisticFiles();
    
    // Validate structure
    const valid = await validateProject();
    
    console.log('Cleanup Summary');
    console.log('===============');
    console.log(`✅ Files cleaned: ${cleaned}`);
    console.log(`🚀 Unrealistic features removed: ${removed}`);
    console.log(`❌ Errors: ${errors}`);
    console.log(`🔍 Project valid: ${valid ? 'Yes' : 'No'}`);
    
    if (valid) {
      console.log('\n🎉 Cleanup completed successfully!');
      console.log('Project is now simplified and follows Pike\'s principle of simplicity.');
    } else {
      console.log('\n⚠️  Project validation failed. Please check missing files.');
    }
    
  } catch (error) {
    console.error('❌ Cleanup failed:', error);
    process.exit(1);
  }
}

main().catch(console.error);