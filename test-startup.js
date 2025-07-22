#!/usr/bin/env node

/**
 * Test basic startup without starting the server
 */

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.NODE_ENV = 'test';
process.env.API_PORT = '0'; // Use port 0 to avoid port conflicts

console.log('=== Testing Application Startup ===\n');

try {
  // Import main application
  console.log('1. Loading application modules...');
  const { default: main } = await import('./index.js');
  
  console.log('✓ Main module loaded successfully');
  
  // Check essential imports
  console.log('\n2. Checking essential imports...');
  const { getLogger } = await import('./lib/core/logger.js');
  const { DatabaseManager } = await import('./lib/core/database-manager.js');
  const { UnifiedSecurityMiddleware } = await import('./lib/security/unified-security-middleware.js');
  
  console.log('✓ Core modules loaded successfully');
  
  // Test logger
  console.log('\n3. Testing logger...');
  const logger = getLogger();
  logger.info('Logger test successful');
  
  // Test fee system
  console.log('\n4. Testing fee system...');
  const { secureFeeConfig } = await import('./lib/security/fee-protection.js');
  const testFee = secureFeeConfig.calculateBTCFee(100000);
  console.log('✓ Fee calculation test:', testFee.feeBTC, 'BTC');
  
  // Test automation
  console.log('\n5. Testing automation system...');
  const { AutomationOrchestrator } = await import('./lib/automation/automation-orchestrator.js');
  console.log('✓ Automation system loaded');
  
  console.log('\n=== All basic tests passed ===');
  console.log('The application can be started with: node index.js');
  
} catch (error) {
  console.error('\n❌ Error during startup test:');
  console.error(error);
  process.exit(1);
}

// Exit cleanly
setTimeout(() => process.exit(0), 1000);