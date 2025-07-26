#!/usr/bin/env node
/**
 * Remove Duplicate Files Script
 * Identifies and removes duplicate/redundant files in Otedama
 */

import { unlink } from 'fs/promises';
import { createStructuredLogger } from '../lib/core/structured-logger.js';

const logger = createStructuredLogger('DuplicateRemover');

/**
 * List of duplicate files to remove
 * Keep the most comprehensive versions
 */
const DUPLICATE_FILES = [
  // Duplicate dashboard files - keep unified-dashboard.js
  'lib/monitoring/dashboard.js',
  'lib/monitoring/log-dashboard.js', 
  'lib/monitoring/mining-analytics-dashboard.js',
  'lib/monitoring/real-time-performance-dashboard.js',
  'lib/monitoring/dashboard-service.js',
  'lib/monitoring/realtime-dashboard.js',
  'lib/monitoring/dashboard-server.js',
  
  // Duplicate monitoring files - keep unified-monitoring-system.js
  'lib/monitoring/monitoring-system.js',
  'lib/monitoring/performance-monitor.js',
  'lib/monitoring/national-monitoring.js',
  'lib/monitoring/enterprise-monitor.js',
  'lib/monitoring/advanced-monitoring.js',
  
  // Duplicate security files - keep unified-security-system.js
  'lib/security/security-manager.js',
  'lib/security/enhanced-security-system.js',
  'lib/security/comprehensive-security-middleware.js',
  'lib/security/security-integration.js',
  'lib/security/enhanced-auth-system.js',
  
  // Duplicate storage files - keep unified-storage-manager.js
  'lib/storage/storage-manager.js',
  'lib/storage/decentralized-storage.js',
  'lib/storage/distributed-storage-integration.js',
  
  // Duplicate API files - keep unified-api-server.js
  'lib/api/pool-api-server.js',
  'lib/api/miner-api.js',
  'lib/api/dashboard-api.js',
  'lib/api/versioned-routes.js',
  'lib/api/version-adapter.js',
  'lib/api/setup-versioned-api.js',
  'lib/api/batch-endpoints.js',
  'lib/api/batch-operations.js',
  'lib/api/batch-processor.js',
  'lib/api/ml-endpoints.js',
  'lib/api/social-endpoints.js',
  'lib/api/bot-endpoints.js',
  
  // Duplicate mining files - keep enhanced mining components
  'lib/mining/simple-cpu-miner.js',
  'lib/mining/simple-gpu-miner.js',
  'lib/mining/optimized-mining-engine.js',
  
  // Duplicate algorithm files - keep algorithm-manager-v2.js and specific algorithms
  'lib/mining/algorithms/autolykos.js',
  'lib/mining/algorithms/blake2s.js',
  'lib/mining/algorithms/blake3.js',
  'lib/mining/algorithms/cryptonight.js',
  'lib/mining/algorithms/equihash.js',
  'lib/mining/algorithms/fishhash.js',
  'lib/mining/algorithms/kheavyhash.js',
  'lib/mining/algorithms/lyra2rev3.js',
  'lib/mining/algorithms/octopus.js',
  'lib/mining/algorithms/progpow.js',
  'lib/mining/algorithms/sha256-optimized.js',
  'lib/mining/algorithms/x11.js',
  'lib/mining/algorithms/x16r.js',
  
  // Duplicate network files
  'lib/network/network-manager.js',
  'lib/network/p2p-manager.js',
  
  // Duplicate core files - keep enhanced versions
  'lib/core/backup.js',
  'lib/core/error-recovery.js',
  
  // Duplicate documentation files (keeping essential ones)
  'API_DOCUMENTATION.md',
  'ARCHITECTURE.md',
  'CONTRIBUTING.md',
  'DEPLOYMENT.md',
  'FINAL_IMPLEMENTATION_REPORT.md',
  'FINAL_REPORT.md',
  'IMPLEMENTATION_SUMMARY.md',
  'IMPLEMENTATION_SUMMARY_v1.1.0.md',
  'IMPROVEMENTS.md',
  'IMPROVEMENTS_FINAL.md',
  'IMPROVEMENTS_SUMMARY.md',
  'PRODUCTION_READY.md',
  'PROJECT_STATE.md',
  'PROJECT_STATE_FINAL.md',
  'PROJECT_STATE_v1.1.0.md',
  'README.ja.md',
  'RELEASE_NOTES_v1.1.0.md',
  'SECURITY.md',
  'UI_IMPLEMENTATION.md',
  'ZKP_IMPLEMENTATION_REPORT.md',
  
  // Duplicate config files
  'config/enterprise.json',
  'config/miner-client-config.json', 
  'config/pool-manager-config.json',
  'config/security-enhanced.json',
  'config/templates/aws-production.json',
  'config/templates/azure-production.json',
  'config/templates/gcp-production.json',
  'config/templates/self-hosted-production.json',
  
  // Duplicate documentation files in docs/
  'docs/API_VERSIONING.md',
  'docs/ARCHITECTURE.md',
  'docs/AUTOMATION_GUIDE.md',
  'docs/DEPLOYMENT.md',
  'docs/GETTING_STARTED.md',
  'docs/MINER_GUIDE.md',
  'docs/MINING_POOL_SETUP.md',
  'docs/POOL_SETUP.md',
  'docs/QUICK_START.md',
  'docs/SECURITY.md',
  'docs/SECURITY_GUIDE.md',
  'docs/SOW.md',
  
  // Duplicate scripts
  'quick-start.bat',
  'quick-start.sh',
  'setup.bat',
  'setup.sh',
  'start-miner.bat',
  'start-miner.sh',
  'start-pool.bat',
  'start-pool.sh',
  'start-with-dex-defi.bat',
  'start-with-dex-defi.sh',
  'start-mining-pool.js' // This was in deleted files, removing from our tracking
];

/**
 * Remove duplicate files
 */
async function removeDuplicates() {
  logger.info('Starting duplicate file removal process');
  
  let removed = 0;
  let failed = 0;
  
  for (const filePath of DUPLICATE_FILES) {
    try {
      await unlink(filePath);
      logger.info(`Removed duplicate file: ${filePath}`);
      removed++;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn(`Failed to remove ${filePath}: ${error.message}`);
        failed++;
      }
      // Ignore ENOENT (file not found) errors
    }
  }
  
  logger.info('Duplicate removal completed', {
    removed,
    failed,
    total: DUPLICATE_FILES.length
  });
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  removeDuplicates().catch(error => {
    console.error('Failed to remove duplicates:', error);
    process.exit(1);
  });
}

export { removeDuplicates };