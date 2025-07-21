/**
 * Enhanced Main Entry Point for Otedama
 * Launches the enhanced application with all advanced features
 */

import { EnhancedOtedamaApplication } from './lib/core/enhanced-application.js';
import { getErrorHandler, ErrorCategory } from './lib/error-handler.js';

// Configuration
const config = {
  // Server configuration
  port: process.env.API_PORT || 3333,
  wsPort: process.env.WS_PORT || 3334,
  dbPath: process.env.DB_PATH || './otedama.db',
  
  // Cache configuration
  cacheL1MaxSize: 1000,
  cacheL2MaxSize: 10000,
  cacheL3MaxSize: 100000,
  
  // Security configuration
  maxRequests: 100,
  rateLimitWindow: 60000,
  ddosProtection: true,
  bruteForceProtection: true,
  
  // I18n configuration
  defaultLanguage: 'en',
  autoDetectLanguage: true,
  
  // WebSocket configuration
  maxConnections: 1000,
  heartbeatInterval: 30000,
  connectionTimeout: 10000,
  
  // P2P configuration
  partitionDetectionThreshold: 0.3,
  recoveryTimeout: 30000,
  healthCheckInterval: 10000
};

async function main() {
  const errorHandler = getErrorHandler();
  
  try {
    console.log('🚀 Starting Enhanced Otedama Platform...');
    console.log('=====================================');
    
    // Create and initialize application
    const app = new EnhancedOtedamaApplication(config);
    
    // Setup event listeners
    app.on('initialized', () => {
      console.log('✅ Application initialized successfully');
    });
    
    app.on('started', () => {
      console.log('🎉 Enhanced Otedama Platform is now running!');
      console.log('');
      console.log('📊 Features Available:');
      console.log('  • Advanced Multi-tier Caching System');
      console.log('  • Enhanced Security with DDoS Protection');
      console.log('  • 50-Language Internationalization');
      console.log('  • WebSocket Connection Stability');
      console.log('  • P2P Network Resilience');
      console.log('  • Real-time Price Feeds');
      console.log('  • Mining Pool Management');
      console.log('  • Decentralized Exchange (DEX)');
      console.log('  • DeFi Protocol Integration');
      console.log('');
      console.log('🌐 Access Points:');
      console.log(`  • Web API: http://localhost:${config.port}`);
      console.log(`  • WebSocket: ws://localhost:${config.wsPort}`);
      console.log('');
      console.log('📚 API Endpoints:');
      console.log(`  • Health: http://localhost:${config.port}/api/health`);
      console.log(`  • Status: http://localhost:${config.port}/api/status`);
      console.log(`  • Prices: http://localhost:${config.port}/api/prices`);
      console.log(`  • Mining: http://localhost:${config.port}/api/mining/status`);
      console.log(`  • Languages: http://localhost:${config.port}/api/languages`);
      console.log('');
    });
    
    app.on('securityAlert', (alert) => {
      console.warn('🚨 SECURITY ALERT:', alert);
    });
    
    app.on('networkStateChanged', (state) => {
      console.log(`🌐 Network state changed: ${state}`);
    });
    
    app.on('languageChanged', (language) => {
      console.log(`🌍 Language changed to: ${language}`);
    });
    
    app.on('cacheMetrics', (metrics) => {
      if (metrics.hitRatio.total < 0.8) {
        console.log(`📊 Cache hit ratio: ${(metrics.hitRatio.total * 100).toFixed(1)}%`);
      }
    });
    
    // Graceful shutdown handling
    const gracefulShutdown = async (signal) => {
      console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
      
      try {
        await app.stop();
        console.log('✅ Shutdown completed successfully');
        process.exit(0);
      } catch (error) {
        console.error('❌ Error during shutdown:', error.message);
        process.exit(1);
      }
    };
    
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    
    // Start the application
    await app.start();
    
  } catch (error) {
    errorHandler.handleError(error, {
      context: 'main_startup',
      category: ErrorCategory.SYSTEM
    });
    
    console.error('❌ Failed to start Enhanced Otedama Platform:', error.message);
    process.exit(1);
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the application
main().catch((error) => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});
