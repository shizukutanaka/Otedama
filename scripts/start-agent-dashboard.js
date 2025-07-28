#!/usr/bin/env node

import { agentDashboard } from '../lib/monitoring/agent-dashboard.js';
import { agentManager } from '../lib/agents/agent-manager.js';
import { logger } from '../lib/core/logger.js';
import { config } from '../config/config.js';

/**
 * Standalone Agent Dashboard Launcher
 * Starts the real-time monitoring dashboard for the agent system
 */

async function startDashboard() {
  try {
    logger.info('🚀 Starting Agent Dashboard...');
    
    // Initialize agent manager if not already initialized
    if (!agentManager.initialized) {
      logger.info('Initializing agent manager...');
      await agentManager.initialize(config.agents || {});
      await agentManager.startAll();
    }
    
    // Start the dashboard server
    await agentDashboard.start();
    
    logger.info('✅ Agent Dashboard is running!');
    logger.info(`📊 Dashboard URL: http://localhost:${agentDashboard.port}`);
    logger.info('Press Ctrl+C to stop');
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('📊 Shutting down Agent Dashboard...');
      
      await agentDashboard.stop();
      await agentManager.shutdown();
      
      logger.info('✅ Dashboard shutdown complete');
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      logger.info('📊 Received SIGTERM, shutting down Agent Dashboard...');
      
      await agentDashboard.stop();
      await agentManager.shutdown();
      
      logger.info('✅ Dashboard shutdown complete');
      process.exit(0);
    });
    
  } catch (error) {
    logger.error('❌ Failed to start Agent Dashboard:', error);
    process.exit(1);
  }
}

// Start if running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startDashboard();
}

export { startDashboard };