/**
 * Cleanup Duplicate Files - Otedama v1.1.8
 * 重複ファイルクリーンアップスクリプト
 */

import fs from 'fs/promises';
import path from 'path';

console.log('🧹 Starting duplicate file cleanup...\n');

// Files to be deleted (obsolete/duplicate versions)
const filesToDelete = [
  // Duplicate executables (keep bin/ version)
  'otedama-miner.js',
  
  // Duplicate auto-deploy (keep scripts/ version)
  'lib/automation/auto-deploy.js',
  
  // Duplicate self-healing system (keep core/ version)  
  'lib/automation/self-healing-system.js',
  
  // Duplicate auto-scaling (keep monitoring/ version)
  'lib/core/auto-scaling.js',
  
  // Duplicate cache manager (keep optimization/ version)
  'lib/core/cache-manager.js',
  
  // Duplicate circuit breaker (keep core/ version)
  'lib/dex/circuit-breaker.js',
  
  // Duplicate health check (keep monitoring/ version)
  'lib/core/health-check.js',
  
  // Duplicate load balancer (keep network/ version)
  'lib/core/load-balancer.js',
  
  // Duplicate query optimizer (keep storage/ version)
  'lib/core/query-optimizer.js',
  
  // Duplicate rate limiter (keep security/ version - newer implementation)
  'lib/core/rate-limiter.js',
  
  // Duplicate cross-chain bridge (keep dex/ version)
  'lib/defi/cross-chain-bridge.js',
  
  // Duplicate mining compatibility (keep mining/ version)
  'lib/dex/compatibility.js',
  'lib/monitoring/compatibility.js',
  
  // Duplicate MEV protection (keep security/ version)
  'lib/dex/mev-protection.js',
  
  // Duplicate CPU mining worker (keep workers/ version)
  'lib/mining/cpu-mining-worker.js',
  
  // Duplicate mining worker (keep workers/ version)
  'lib/mining/mining-worker.js',
  
  // Duplicate stratum server (keep network/ version - newer)
  'lib/mining/stratum-server.js',
  
  // Duplicate stratum v2 server (keep network/ version)
  'lib/mining/stratum-v2/stratum-v2-server.js',
  
  // Duplicate performance test (keep scripts/ version)
  'lib/monitoring/performance-test.js',
  
  // Duplicate performance benchmark (keep scripts/ version)  
  'test/performance-benchmark.js',
  
  // Duplicate setup (keep root version)
  'test/setup.js',
  
  // Duplicate mining pool test (keep test/mining/ version)
  'test/mining-pool.test.js',
  
  // Obsolete dashboard files (superseded by unified-dashboard.js)
  'lib/monitoring/dashboard-server.js',
  'lib/monitoring/dashboard-service.js', 
  'lib/monitoring/dashboard-unified.js',
  'lib/monitoring/realtime-dashboard.js',
  'lib/monitoring/mining-analytics-dashboard.js',
  'lib/monitoring/real-time-performance-dashboard.js',
  
  // Obsolete security files (superseded by ultra-fast-security.js)
  'lib/security/advanced-attack-protection.js',
  'lib/security/advanced-ddos-protection.js',
  'lib/security/advanced-rate-limiter.js',
  'lib/security/ai-anomaly-detection.js',
  'lib/security/audit.js',
  'lib/security/core.js',
  'lib/security/enhanced-ddos-protection.js',
  'lib/security/manager.js',
  'lib/security/multi-factor-auth.js',
  'lib/security/rate-limit-unified.js',
  
  // Obsolete mining files (superseded by ultra-performance-optimizer.js)
  'lib/mining/advanced-share-validator.js',
  'lib/mining/advanced-stratum-server.js',
  'lib/mining/enhanced-asic-controller.js',
  'lib/mining/merged-mining-manager.js',
  'lib/mining/optimized-stratum-handler.js',
  'lib/mining/pool-stability-enhancements.js',
  'lib/mining/production-mining-engine.js',
  'lib/mining/profit-switching-algorithm.js',
  'lib/mining/profitability-calculator.js',
  'lib/mining/secure-stratum-server.js',
  'lib/mining/smart-profit-switcher.js',
  'lib/mining/smart-profit-switching.js',
  'lib/mining/stable-pool-integration.js',
  'lib/mining/ultra-fast-validator.js',
  'lib/mining/ultra-performance-pool.js',
  
  // Obsolete core files
  'lib/core/lightweight-logger.js'
];

// Track results
let deletedCount = 0;
let notFoundCount = 0;
let errorCount = 0;

console.log(`📋 Attempting to delete ${filesToDelete.length} duplicate/obsolete files...\n`);

// Delete files
for (const file of filesToDelete) {
  try {
    await fs.unlink(file);
    console.log(`✅ Deleted: ${file}`);
    deletedCount++;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`⚠️  Not found: ${file}`);
      notFoundCount++;
    } else {
      console.log(`❌ Error deleting ${file}: ${error.message}`);
      errorCount++;
    }
  }
}

console.log('\n📊 Cleanup Summary:');
console.log('='.repeat(30));
console.log(`✅ Files deleted: ${deletedCount}`);
console.log(`⚠️  Files not found: ${notFoundCount}`);
console.log(`❌ Errors: ${errorCount}`);
console.log(`📋 Total processed: ${filesToDelete.length}`);

if (deletedCount > 0) {
  console.log('\n🎉 Duplicate file cleanup completed successfully!');
  console.log('💡 Remember to:');
  console.log('   1. Update import statements if needed');
  console.log('   2. Run tests to verify functionality');
  console.log('   3. Commit changes to git');
} else {
  console.log('\n🤔 No files were deleted. They may have already been cleaned up.');
}

// Clean up temporary analysis file
try {
  await fs.unlink('analyze-duplicates-temp.js');
  console.log('\n🧹 Cleaned up temporary files');
} catch (error) {
  // Ignore if file doesn't exist
}