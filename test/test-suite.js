#!/usr/bin/env node

/**
 * Otedama Test Suite
 * Comprehensive test runner for all components
 */

import { TestRunner } from './test-runner.js';
import * as algorithmTests from './algorithms.test.js';
import * as ammTests from './amm.test.js';
import * as cacheTests from './cache.test.js';
import * as dexTests from './dex.test.js';
import * as miningPoolTests from './mining-pool.test.js';
import * as performanceTests from './performance.test.js';
import * as securityTests from './security.test.js';

// Test configuration
const config = {
  verbose: process.argv.includes('--verbose'),
  bail: process.argv.includes('--bail'),
  filter: process.argv.find(arg => arg.startsWith('--filter='))?.split('=')[1],
  report: process.argv.includes('--report'),
  parallel: !process.argv.includes('--serial')
};

// ASCII art logo
console.log(`
╔═══════════════════════════════════════╗
║        Otedama Test Suite             ║
║   Professional Mining Pool & DEX      ║
╚═══════════════════════════════════════╝
`);

async function runTests() {
  const runner = new TestRunner(config);
  const startTime = Date.now();
  
  console.log('🚀 Starting test suite...\n');
  
  // Register test suites
  const testSuites = [
    { name: 'Algorithms', module: algorithmTests },
    { name: 'AMM', module: ammTests },
    { name: 'Cache', module: cacheTests },
    { name: 'DEX Engine', module: dexTests },
    { name: 'Mining Pool', module: miningPoolTests },
    { name: 'Performance', module: performanceTests },
    { name: 'Security', module: securityTests }
  ];
  
  // Run each test suite
  const results = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    suites: []
  };
  
  for (const suite of testSuites) {
    if (config.filter && !suite.name.toLowerCase().includes(config.filter.toLowerCase())) {
      continue;
    }
    
    console.log(`\n📦 Running ${suite.name} tests...`);
    console.log('─'.repeat(40));
    
    try {
      const suiteResults = await suite.module.run(results);
      
      results.suites.push({
        name: suite.name,
        results: suiteResults
      });
      
    } catch (error) {
      console.error(`❌ Error in ${suite.name} suite:`, error.message);
      if (config.bail) {
        process.exit(1);
      }
    }
  }
  
  // Calculate totals
  results.total = runner.results.tests.length;
  results.passed = runner.results.tests.filter(t => t.status === 'passed').length;
  results.failed = runner.results.tests.filter(t => t.status === 'failed').length;
  results.skipped = runner.results.tests.filter(t => t.status === 'skipped').length;
  
  const duration = Date.now() - startTime;
  
  // Print summary
  console.log('\n' + '═'.repeat(50));
  console.log('📊 TEST SUMMARY');
  console.log('═'.repeat(50));
  
  console.log(`\n✅ Passed:  ${results.passed}`);
  console.log(`❌ Failed:  ${results.failed}`);
  console.log(`⏭️  Skipped: ${results.skipped}`);
  console.log(`📋 Total:   ${results.total}`);
  console.log(`⏱️  Time:    ${(duration / 1000).toFixed(2)}s`);
  
  // Success rate
  const successRate = results.total > 0 
    ? ((results.passed / results.total) * 100).toFixed(1)
    : 0;
  
  console.log(`\n📈 Success Rate: ${successRate}%`);
  
  // Performance metrics
  if (config.verbose) {
    console.log('\n📊 Performance Metrics:');
    console.log('─'.repeat(30));
    
    const avgTestTime = results.total > 0 
      ? (duration / results.total).toFixed(2)
      : 0;
    
    console.log(`Average test time: ${avgTestTime}ms`);
    
    // Find slowest tests
    const slowTests = runner.results.tests
      .filter(t => t.duration)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 5);
    
    if (slowTests.length > 0) {
      console.log('\n🐌 Slowest tests:');
      slowTests.forEach(test => {
        console.log(`  ${test.name}: ${test.duration}ms`);
      });
    }
  }
  
  // Generate report if requested
  if (config.report) {
    generateReport(results, duration);
  }
  
  // Exit with appropriate code
  process.exit(results.failed > 0 ? 1 : 0);
}

/**
 * Generate detailed test report
 */
function generateReport(results, duration) {
  const report = {
    timestamp: new Date().toISOString(),
    duration,
    summary: {
      total: results.total,
      passed: results.passed,
      failed: results.failed,
      skipped: results.skipped,
      successRate: results.total > 0 
        ? ((results.passed / results.total) * 100).toFixed(1) + '%'
        : '0%'
    },
    suites: results.suites,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: require('os').cpus().length,
      memory: Math.round(require('os').totalmem() / 1024 / 1024 / 1024) + 'GB'
    }
  };
  
  const reportPath = `test-report-${Date.now()}.json`;
  require('fs').writeFileSync(reportPath, JSON.stringify(report, null, 2));
  
  console.log(`\n📄 Report saved to: ${reportPath}`);
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('\n💥 Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('\n💥 Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Run tests
runTests().catch(error => {
  console.error('\n💥 Test suite failed:', error);
  process.exit(1);
});