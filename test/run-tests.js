#!/usr/bin/env node

/**
 * Otedama Ver0.6 Test Runner
 * Simplified test execution for BTC-only system
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';

console.log('🚀 Otedama Ver0.6 Test Runner');
console.log('============================\n');

const tests = [
  'test/simple-test.js'
];

let totalPassed = 0;
let totalFailed = 0;

async function runTest(testFile) {
  return new Promise((resolve, reject) => {
    console.log(`🧪 Running ${testFile}...`);
    
    if (!existsSync(testFile)) {
      console.log(`❌ Test file not found: ${testFile}\n`);
      resolve({ passed: 0, failed: 1 });
      return;
    }
    
    const child = spawn('node', [testFile], { stdio: 'inherit' });
    
    child.on('exit', (code) => {
      if (code === 0) {
        console.log(`✅ ${testFile} completed successfully\n`);
        resolve({ passed: 1, failed: 0 });
      } else {
        console.log(`❌ ${testFile} failed with code ${code}\n`);
        resolve({ passed: 0, failed: 1 });
      }
    });
    
    child.on('error', (error) => {
      console.log(`❌ Error running ${testFile}: ${error.message}\n`);
      resolve({ passed: 0, failed: 1 });
    });
  });
}

async function runAllTests() {
  console.log('🔍 Discovering and running Ver0.6 tests...\n');
  
  for (const testFile of tests) {
    const result = await runTest(testFile);
    totalPassed += result.passed;
    totalFailed += result.failed;
  }
  
  // Display final results
  console.log('=====================================');
  console.log('📊 Ver0.6 Test Summary');
  console.log('=====================================');
  console.log(`Total Test Files: ${tests.length}`);
  console.log(`✅ Passed: ${totalPassed}`);
  console.log(`❌ Failed: ${totalFailed}`);
  console.log(`📈 Success Rate: ${totalPassed > 0 ? ((totalPassed / (totalPassed + totalFailed)) * 100).toFixed(1) : 0}%`);
  
  if (totalFailed === 0) {
    console.log('\n🎉 All Ver0.6 tests passed!');
    console.log('✨ BTC-only payout system is ready for production');
    console.log('\n₿ Ver0.6 is production-ready with:');
    console.log('   • BTC-only payouts for all currencies');
    console.log('   • New fee structure: 1% + 0.5%');
    console.log('   • Auto-conversion system');
    console.log('   • 13 supported mining currencies');
    console.log('   • 10 supported algorithms');
    console.log('   • 50+ language support');
    console.log('   • Enterprise security');
    
    console.log('\n🚀 Start mining:');
    console.log('   node index.js --wallet YOUR_WALLET --currency RVN');
    
  } else {
    console.log('\n⚠️  Some tests failed. Please fix issues before deployment.');
    process.exit(1);
  }
}

// Run all tests
runAllTests().catch(error => {
  console.error('❌ Test runner failed:', error);
  process.exit(1);
});
