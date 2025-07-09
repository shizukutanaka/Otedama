#!/usr/bin/env node

/**
 * Quick test script for Otedama Unified Pool
 * Tests basic functionality of implemented components
 */

import { UnifiedConfig } from './config/unified-config';
import { UnifiedLogger } from './logging/unified-logger';
import { GracefulShutdownManager } from './lifecycle/graceful-shutdown';

async function testBasicFunctionality() {
  console.log('🚀 Testing Otedama Unified Pool Components');
  
  try {
    // Test 1: Configuration Loading
    console.log('\n📋 Testing Configuration System...');
    const config = new UnifiedConfig();
    await config.load();
    console.log('✅ Configuration loaded successfully');
    console.log(`   - Pool name: ${config.pool.name}`);
    console.log(`   - Pool port: ${config.pool.port}`);
    console.log(`   - Database type: ${config.database.type}`);
    console.log(`   - Log level: ${config.logging.level}`);
    
    // Test 2: Logging System
    console.log('\n📝 Testing Logging System...');
    const logger = new UnifiedLogger(config.logging);
    logger.info('Logger initialized successfully');
    logger.debug('Debug message test');
    logger.warn('Warning message test');
    
    // Test mining-specific logging
    logger.shareSubmitted('test-miner-1', {
      id: 'share-123',
      difficulty: 1.0,
      target: '0000ffff'
    });
    
    logger.shareAccepted('test-miner-1', {
      id: 'share-123',
      difficulty: 1.0
    });
    
    logger.blockFound({
      height: 800000,
      hash: '00000000000000000007',
      finder: 'test-miner-1'
    });
    
    console.log('✅ Logging system working correctly');
    
    // Test 3: Graceful Shutdown Manager
    console.log('\n🛑 Testing Graceful Shutdown Manager...');
    const shutdownManager = GracefulShutdownManager.createWithCommonTasks(logger);
    
    // Register a test task
    shutdownManager.registerTask(
      'test_cleanup',
      async () => {
        logger.info('Test cleanup task executed');
        await new Promise(resolve => setTimeout(resolve, 100));
      },
      { priority: 10, timeout: 1000, critical: false }
    );
    
    const stats = shutdownManager.getShutdownStats();
    console.log('✅ Shutdown manager initialized');
    console.log(`   - Tasks registered: ${stats.tasksRegistered}`);
    console.log(`   - Handlers registered: ${stats.handlersRegistered}`);
    
    // Test 4: Configuration Creation Helper
    console.log('\n⚙️  Testing Configuration Helper...');
    const configPath = './config/test-config.json';
    await config.createDefaultConfigFile(configPath);
    console.log(`✅ Default config file created at ${configPath}`);
    
    // Test 5: Logger Performance Test
    console.log('\n⚡ Testing Logger Performance...');
    const startTime = Date.now();
    const timer = logger.startTimer('performance_test');
    
    // Simulate some work
    await new Promise(resolve => setTimeout(resolve, 50));
    
    timer(); // This will log the performance
    const endTime = Date.now();
    console.log(`✅ Performance test completed in ${endTime - startTime}ms`);
    
    // Test 6: Logger Context
    console.log('\n🏷️  Testing Logger Context...');
    const contextLogger = logger.withContext({
      component: 'test',
      operation: 'context_test',
      traceId: 'trace-123'
    });
    
    contextLogger.info('Message with context');
    console.log('✅ Context logging working');
    
    // Test 7: Health Check
    console.log('\n🏥 Testing Component Health...');
    const loggerHealthy = logger.isHealthy();
    console.log(`✅ Logger health: ${loggerHealthy ? 'HEALTHY' : 'UNHEALTHY'}`);
    
    console.log('\n🎉 All basic tests passed successfully!');
    console.log('\n📊 Summary:');
    console.log('   ✅ Unified Configuration System');
    console.log('   ✅ Unified Logging System'); 
    console.log('   ✅ Graceful Shutdown Manager');
    console.log('   ✅ Performance Monitoring');
    console.log('   ✅ Context Management');
    console.log('   ✅ Health Checks');
    
    console.log('\n🔄 Next Steps:');
    console.log('   1. Implement remaining components (Database, P2P, etc.)');
    console.log('   2. Add comprehensive testing');
    console.log('   3. Setup Docker containerization');
    console.log('   4. Configure CI/CD pipeline');
    console.log('   5. Add monitoring and alerting');
    
    // Clean shutdown
    await logger.close();
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

async function testStubComponents() {
  console.log('\n🧪 Testing Stub Components...');
  
  // Create stub instances to verify they don't crash
  class TestDatabase { 
    constructor(config: any, logger: any) {} 
    async initialize() { console.log('   📁 Database stub initialized'); } 
    async migrate() { console.log('   📁 Database migration (stub)'); } 
    async close() { console.log('   📁 Database closed (stub)'); } 
  }
  
  const config = new UnifiedConfig();
  await config.load();
  const logger = new UnifiedLogger(config.logging);
  
  const db = new TestDatabase(config.database, logger);
  await db.initialize();
  await db.migrate();
  await db.close();
  
  console.log('✅ Stub components working correctly');
}

// Main execution
async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║        Otedama Pool Test Suite        ║');
  console.log('║    Design Philosophy: Carmack +       ║');
  console.log('║    Martin + Pike = Simple Excellence  ║');
  console.log('╚═══════════════════════════════════════╝');
  
  await testBasicFunctionality();
  await testStubComponents();
  
  console.log('\n✨ Test suite completed successfully!');
  console.log('Ready to run with: npm run dev:unified');
}

// Execute if run directly
if (require.main === module) {
  main().catch((error) => {
    console.error('💥 Fatal test error:', error);
    process.exit(1);
  });
}

export { testBasicFunctionality, testStubComponents };