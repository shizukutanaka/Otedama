#!/usr/bin/env node

/**
 * System Consolidation Script - Otedama
 * Consolidates duplicate monitoring and security systems
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// Monitoring system consolidation
const monitoringConsolidation = {
  keep: 'lib/monitoring/unified-monitoring-system.js',
  remove: [
    'lib/monitoring/advanced-monitoring.js',
    'lib/monitoring/enterprise-monitor.js',
    'lib/monitoring/enterprise-monitoring-system.js',
    'lib/monitoring/monitoring-optimizer.js',
    'lib/monitoring/monitoring-system.js',
    'lib/monitoring/national-monitoring.js',
    'lib/monitoring/unified-monitoring-manager.js'
  ]
};

// Security system consolidation  
const securityConsolidation = {
  keep: 'lib/security/unified-security-system.js',
  remove: [
    'lib/security/advanced-security-audit.js',
    'lib/security/comprehensive-audit-system.js',
    'lib/security/enhanced-auth-system.js',
    'lib/security/security-compliance-framework.js',
    'lib/security/security-integration.js',
    'lib/security/security-manager.js',
    'lib/security/unified-audit-manager.js'
  ]
};

// Mining system consolidation
const miningConsolidation = {
  keep: 'lib/mining/enhanced-p2p-mining-pool.js',
  remove: [
    'lib/mining/instrumented-mining-pool.js',
    'lib/mining/optimized-mining-engine.js',
    'lib/core/advanced-mining-engine.js',
    'lib/core/ultimate-mining-system.js',
    'lib/core/p2p-mining-pool.js'
  ]
};

// Storage system consolidation
const storageConsolidation = {
  keep: 'lib/storage/unified-storage-manager.js',
  remove: [
    'lib/storage/storage-manager.js',
    'lib/storage/cached-storage.js'
  ]
};

async function consolidateSystem(consolidation, systemName) {
  console.log(`\n📦 Consolidating ${systemName} systems...`);
  
  // Check if main file exists
  try {
    await fs.access(path.join(projectRoot, consolidation.keep));
    console.log(`  ✓ Keeping: ${consolidation.keep}`);
  } catch (error) {
    console.log(`  ✗ Main file not found: ${consolidation.keep}`);
    return;
  }
  
  // Remove duplicate files
  for (const file of consolidation.remove) {
    const filePath = path.join(projectRoot, file);
    try {
      await fs.access(filePath);
      await fs.unlink(filePath);
      console.log(`  ✓ Removed: ${file}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`  ✗ Error removing ${file}: ${error.message}`);
      }
    }
  }
}

async function updateImports() {
  console.log('\n📝 Updating imports...');
  
  const replacements = [
    // Monitoring
    { from: /from ['"].*\/monitoring-system\.js['"]/, to: "from './unified-monitoring-system.js'" },
    { from: /from ['"].*\/advanced-monitoring\.js['"]/, to: "from './unified-monitoring-system.js'" },
    { from: /from ['"].*\/enterprise-monitoring-system\.js['"]/, to: "from './unified-monitoring-system.js'" },
    
    // Security
    { from: /from ['"].*\/security-manager\.js['"]/, to: "from './unified-security-system.js'" },
    { from: /from ['"].*\/comprehensive-audit-system\.js['"]/, to: "from './unified-security-system.js'" },
    
    // Mining
    { from: /from ['"].*\/p2p-mining-pool\.js['"]/, to: "from '../mining/enhanced-p2p-mining-pool.js'" },
    { from: /from ['"].*\/advanced-mining-engine\.js['"]/, to: "from '../mining/enhanced-p2p-mining-pool.js'" },
    
    // Storage
    { from: /from ['"].*\/storage-manager\.js['"]/, to: "from './unified-storage-manager.js'" }
  ];
  
  // Update index files
  const indexFiles = [
    'lib/monitoring/index.js',
    'lib/security/index.js',
    'lib/storage/index.js',
    'lib/core/index.js'
  ];
  
  for (const indexFile of indexFiles) {
    const filePath = path.join(projectRoot, indexFile);
    try {
      let content = await fs.readFile(filePath, 'utf8');
      let modified = false;
      
      for (const { from, to } of replacements) {
        const newContent = content.replace(from, to);
        if (newContent !== content) {
          content = newContent;
          modified = true;
        }
      }
      
      if (modified) {
        await fs.writeFile(filePath, content, 'utf8');
        console.log(`  ✓ Updated: ${indexFile}`);
      }
    } catch (error) {
      console.log(`  - Skipped: ${indexFile} (${error.code})`);
    }
  }
}

async function cleanupEmptyDirectories() {
  console.log('\n🧹 Cleaning up empty directories...');
  
  const checkAndRemoveEmpty = async (dirPath) => {
    try {
      const entries = await fs.readdir(dirPath);
      if (entries.length === 0) {
        await fs.rmdir(dirPath);
        console.log(`  ✓ Removed empty directory: ${dirPath}`);
        return true;
      }
      
      // Check subdirectories
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry);
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
          await checkAndRemoveEmpty(fullPath);
        }
      }
      
      // Re-check after subdirectory cleanup
      const remainingEntries = await fs.readdir(dirPath);
      if (remainingEntries.length === 0) {
        await fs.rmdir(dirPath);
        console.log(`  ✓ Removed empty directory: ${dirPath}`);
        return true;
      }
    } catch (error) {
      // Ignore errors
    }
    return false;
  };
  
  await checkAndRemoveEmpty(path.join(projectRoot, 'lib'));
}

async function main() {
  console.log('====================================');
  console.log('Otedama System Consolidation');
  console.log('====================================');
  
  try {
    // Consolidate systems
    await consolidateSystem(monitoringConsolidation, 'Monitoring');
    await consolidateSystem(securityConsolidation, 'Security');
    await consolidateSystem(miningConsolidation, 'Mining');
    await consolidateSystem(storageConsolidation, 'Storage');
    
    // Update imports
    await updateImports();
    
    // Cleanup
    await cleanupEmptyDirectories();
    
    console.log('\n====================================');
    console.log('✅ Consolidation completed successfully!');
    console.log('====================================');
    
    console.log('\n📌 Main systems:');
    console.log('  - Monitoring: lib/monitoring/unified-monitoring-system.js');
    console.log('  - Security: lib/security/unified-security-system.js');
    console.log('  - Mining: lib/mining/enhanced-p2p-mining-pool.js');
    console.log('  - Storage: lib/storage/unified-storage-manager.js');
    console.log('  - Backup: lib/core/backup-recovery.js');
    
  } catch (error) {
    console.error('\n❌ Consolidation failed:', error.message);
    process.exit(1);
  }
}

// Run consolidation
main().catch(console.error);