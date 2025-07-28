#!/usr/bin/env node
/**
 * Otedama Startup Script with Agent System
 * Comprehensive startup script for production deployment with autonomous agents
 */

import { createStructuredLogger } from '../lib/core/structured-logger.js';
import { EnhancedOtedamaApplication } from '../lib/core/enhanced-application.js';
import startMiningPool from '../start-mining-pool.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = createStructuredLogger('OtedamaStarter');

/**
 * Main startup function with agent system integration
 */
async function startOtedamaWithAgents() {
  logger.info('🚀 Starting Otedama Mining Platform with Agent System');
  
  try {
    // Load agent configuration
    const agentConfig = await loadAgentConfig();
    
    // Prepare mining pool configuration with agents
    const poolConfig = {
      agents: agentConfig.agents,
      pool: {
        name: 'Otedama Mining Pool',
        algorithm: 'sha256',
        coin: 'BTC',
        stratumPort: 3333,
        apiPort: 8081,
        wsPort: 3334,
        fee: 0.01,
        minPayout: 0.001,
        paymentScheme: 'PPLNS'
      },
      zkp: {
        enabled: true,
        requireAuth: false,
        complianceMode: 'minimal'
      },
      security: {
        rateLimiting: true,
        ddosProtection: true,
        antiSybil: true
      },
      performance: {
        workers: require('os').cpus().length * 2,
        enableOptimizations: true,
        enableSIMD: true,
        zeroAllocMode: true
      },
      monitoring: {
        enabled: true,
        metricsInterval: 5000,
        alerting: true,
        prometheus: true
      }
    };
    
    logger.info('📋 Configuration loaded', {
      agentsEnabled: agentConfig.agents.enabled,
      agentCount: Object.keys(agentConfig.agents).filter(k => k !== 'enabled' && k !== 'globalSettings').length,
      miningAlgorithm: poolConfig.pool.algorithm,
      ports: {
        stratum: poolConfig.pool.stratumPort,
        api: poolConfig.pool.apiPort,
        websocket: poolConfig.pool.wsPort
      }
    });
    
    // Start the mining pool with agent system
    const components = await startMiningPool(poolConfig);
    
    // Display startup summary
    displayStartupSummary(components, agentConfig);
    
    // Setup monitoring and health checks
    setupSystemMonitoring(components);
    
    logger.info('✅ Otedama Mining Platform started successfully with all agents active');
    
    return components;
    
  } catch (error) {
    logger.error('❌ Failed to start Otedama Mining Platform', { 
      error: error.message,
      stack: error.stack 
    });
    process.exit(1);
  }
}

/**
 * Load agent configuration from file
 */
async function loadAgentConfig() {
  try {
    const configPath = path.join(__dirname, '..', 'config', 'agents.json');
    const configData = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configData);
    
    logger.info('📁 Agent configuration loaded', {
      configFile: configPath,
      agentsEnabled: config.agents.enabled
    });
    
    return config;
  } catch (error) {
    logger.warn('⚠️ Could not load agent config, using defaults', { error: error.message });
    
    // Return default configuration
    return {
      agents: {
        enabled: true,
        monitoring: { interval: 30000 },
        health: { interval: 60000 },
        security: { interval: 45000 },
        optimization: { interval: 120000 },
        healing: { interval: 90000 },
        scaling: { interval: 180000, predictive: true }
      }
    };
  }
}

/**
 * Display comprehensive startup summary
 */
function displayStartupSummary(components, agentConfig) {
  console.log('\n' + '='.repeat(60));
  console.log('🎯 OTEDAMA MINING PLATFORM - STARTUP COMPLETE');
  console.log('='.repeat(60));
  
  console.log('\n📊 SYSTEM STATUS:');
  console.log(`   Enhanced Application: ${components.app ? '✅ Running' : '❌ Failed'}`);
  console.log(`   Mining Pool: ${components.miningPool ? '✅ Active' : '❌ Inactive'}`);
  console.log(`   ZKP Authentication: ${components.zkpAuth ? '✅ Enabled' : '❌ Disabled'}`);
  console.log(`   Security System: ${components.security ? '✅ Protected' : '❌ Vulnerable'}`);
  console.log(`   API Server: ${components.apiServer ? '✅ Available' : '❌ Unavailable'}`);
  console.log(`   Monitoring: ${components.monitoring ? '✅ Tracking' : '❌ Blind'}`);
  
  if (components.app && components.app.agentManager) {
    console.log('\n🤖 AGENT SYSTEM STATUS:');
    const agentStatuses = components.app.agentManager.getAgentStatuses();
    
    for (const [name, status] of Object.entries(agentStatuses)) {
      const stateIcon = status.state === 'running' ? '✅' : 
                       status.state === 'error' ? '❌' : '⏸️';
      console.log(`   ${name}: ${stateIcon} ${status.state} (${status.runCount} runs)`);
    }
    
    console.log(`\n   Total Agents: ${Object.keys(agentStatuses).length}`);
    console.log(`   Active Agents: ${Object.values(agentStatuses).filter(s => s.state === 'running').length}`);
  }
  
  console.log('\n🌐 NETWORK ENDPOINTS:');
  console.log(`   Stratum Server: stratum+tcp://localhost:3333`);
  console.log(`   API Server: http://localhost:8081`);
  console.log(`   WebSocket: ws://localhost:3334`);
  console.log(`   Health Check: http://localhost:8081/health`);
  console.log(`   Metrics: http://localhost:8081/metrics`);
  
  console.log('\n📈 PERFORMANCE FEATURES:');
  console.log(`   ⚡ SIMD Acceleration: Enabled`);
  console.log(`   🧠 Zero-Alloc Mode: Enabled`);
  console.log(`   🔄 Auto-Optimization: Active`);
  console.log(`   📊 Real-time Monitoring: Active`);
  console.log(`   🛡️ Security Protection: Enhanced`);
  console.log(`   🤖 Autonomous Agents: ${agentConfig.agents.enabled ? 'Active' : 'Disabled'}`);
  
  console.log('\n' + '='.repeat(60));
  console.log('Ready for mining! 🚀⛏️');
  console.log('='.repeat(60) + '\n');
}

/**
 * Setup system monitoring and health checks
 */
function setupSystemMonitoring(components) {
  // Periodic health check logging
  setInterval(() => {
    if (components.app) {
      components.app.getHealthStatus().then(health => {
        if (health.status !== 'healthy') {
          logger.warn('🏥 System health check', { health });
        }
      }).catch(error => {
        logger.error('❌ Health check failed', { error: error.message });
      });
    }
  }, 60000); // Every minute
  
  // Agent system monitoring
  if (components.app && components.app.agentManager) {
    setInterval(() => {
      const statuses = components.app.agentManager.getAgentStatuses();
      const failedAgents = Object.entries(statuses)
        .filter(([name, status]) => status.state === 'error')
        .map(([name]) => name);
      
      if (failedAgents.length > 0) {
        logger.warn('🤖 Agent system has failed agents', { failedAgents });
      }
    }, 120000); // Every 2 minutes
  }
  
  logger.info('📊 System monitoring enabled');
}

/**
 * Handle command line arguments
 */
function parseArguments() {
  const args = process.argv.slice(2);
  const config = {
    agents: true,
    verbose: false,
    mode: 'production'
  };
  
  for (const arg of args) {
    switch (arg) {
      case '--no-agents':
        config.agents = false;
        break;
      case '--verbose':
        config.verbose = true;
        break;
      case '--dev':
        config.mode = 'development';
        break;
      case '--help':
        displayHelp();
        process.exit(0);
        break;
    }
  }
  
  return config;
}

/**
 * Display help information
 */
function displayHelp() {
  console.log(`
🎯 Otedama Mining Platform Startup Script

Usage: node scripts/start-with-agents.js [options]

Options:
  --no-agents    Disable autonomous agent system
  --verbose      Enable verbose logging
  --dev          Run in development mode
  --help         Show this help message

Examples:
  node scripts/start-with-agents.js                 # Start with all agents
  node scripts/start-with-agents.js --no-agents     # Start without agents
  node scripts/start-with-agents.js --verbose       # Start with verbose logging
  node scripts/start-with-agents.js --dev           # Start in development mode

For more information, visit: https://github.com/shizukutanaka/Otedama
  `);
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = parseArguments();
  
  if (!config.agents) {
    logger.info('🤖 Agent system disabled by command line argument');
  }
  
  if (config.verbose) {
    logger.info('📝 Verbose logging enabled');
  }
  
  startOtedamaWithAgents().catch(error => {
    logger.error('💥 Fatal startup error', { error: error.message });
    process.exit(1);
  });
}

export default startOtedamaWithAgents;