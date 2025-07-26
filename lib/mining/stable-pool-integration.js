/**
 * Stable Pool Integration Example
 * Shows how to integrate stability enhancements into pool manager
 */

import { PoolStability } from './pool-stability-enhancements.js';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('StablePoolIntegration');

/**
 * Example integration for pool manager
 */
export function integrateStabilityEnhancements(poolManager) {
  // 1. Add circuit breaker for blockchain RPC calls
  const rpcCircuitBreaker = new PoolStability.CircuitBreaker({
    threshold: 3,
    timeout: 30000,
    resetTimeout: 60000
  });
  
  // Wrap RPC calls
  const originalGetBlockTemplate = poolManager.getBlockTemplate;
  poolManager.getBlockTemplate = async function(...args) {
    return await rpcCircuitBreaker.execute(
      async () => originalGetBlockTemplate.apply(this, args),
      async () => {
        logger.warn('Using cached block template due to RPC failure');
        return this.cachedBlockTemplate;
      }
    );
  };
  
  // 2. Replace connection pool with stable version
  if (poolManager.connectionPool) {
    const stablePool = new PoolStability.ConnectionPool({
      maxConnections: poolManager.config.maxConnections,
      healthCheckInterval: 30000
    });
    
    // Migrate existing connections
    for (const [id, conn] of poolManager.connectionPool.connections) {
      stablePool.addConnection(id, conn);
    }
    
    stablePool.start();
    poolManager.connectionPool = stablePool;
  }
  
  // 3. Add resilient share validation
  if (poolManager.shareValidator) {
    const resilientValidator = new PoolStability.ShareValidator(
      poolManager.shareValidator,
      {
        maxRetries: 3,
        retryDelay: 100,
        fallbackValidator: null // Could add simple fallback validator
      }
    );
    
    poolManager.shareValidator = resilientValidator;
  }
  
  // 4. Add health monitoring
  poolManager.on('health:check', (health) => {
    if (health.unhealthy > health.healthy * 0.5) {
      logger.error('More than 50% connections unhealthy, triggering recovery');
      poolManager.triggerRecovery();
    }
  });
  
  // 5. Add automatic recovery mechanisms
  poolManager.triggerRecovery = async function() {
    logger.info('Starting automatic recovery process');
    
    try {
      // Recover connections
      if (this.connectionPool && this.connectionPool.recoverUnhealthyConnections) {
        await this.connectionPool.recoverUnhealthyConnections();
      }
      
      // Reset circuit breakers
      rpcCircuitBreaker.state = 'HALF_OPEN';
      rpcCircuitBreaker.failures = 0;
      
      // Clear error caches
      if (this.shareValidator && this.shareValidator.validationErrors) {
        this.shareValidator.validationErrors.clear();
      }
      
      logger.info('Recovery process completed');
      
    } catch (error) {
      logger.error('Recovery process failed:', error);
    }
  };
  
  logger.info('Stability enhancements integrated into pool manager');
  
  return poolManager;
}

/**
 * Monitoring helper for stable pool
 */
export class StablePoolMonitor {
  constructor(poolManager) {
    this.poolManager = poolManager;
    this.metrics = {
      uptimePercent: 100,
      avgResponseTime: 0,
      errorRate: 0,
      recoveryCount: 0
    };
    
    this.startMonitoring();
  }
  
  startMonitoring() {
    // Monitor pool health every minute
    setInterval(() => {
      this.checkPoolHealth();
    }, 60000);
    
    // Monitor performance every 5 seconds
    setInterval(() => {
      this.checkPerformance();
    }, 5000);
  }
  
  checkPoolHealth() {
    const stats = this.poolManager.getStats();
    
    // Calculate uptime
    const healthyRatio = stats.connections.healthy / stats.connections.total;
    this.metrics.uptimePercent = healthyRatio * 100;
    
    // Check for issues
    if (this.metrics.uptimePercent < 90) {
      logger.warn(`Pool health degraded: ${this.metrics.uptimePercent.toFixed(1)}% uptime`);
    }
    
    // Error rate
    if (stats.shares) {
      this.metrics.errorRate = stats.shares.invalid / stats.shares.total;
    }
  }
  
  checkPerformance() {
    // Monitor response times
    const perfStats = this.poolManager.getPerformanceStats();
    if (perfStats && perfStats.avgResponseTime) {
      this.metrics.avgResponseTime = perfStats.avgResponseTime;
      
      if (this.metrics.avgResponseTime > 1000) {
        logger.warn(`High response time detected: ${this.metrics.avgResponseTime}ms`);
      }
    }
  }
  
  getMetrics() {
    return { ...this.metrics };
  }
}

export default {
  integrateStabilityEnhancements,
  StablePoolMonitor
};