import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { CircuitBreaker } from './circuit-breaker.js';

/**
 * Auto Recovery System
 * システムの自動リカバリーと障害回復
 * 
 * Features:
 * - Automatic component restart on failure
 * - Circuit breaker for failing services
 * - Health checks and monitoring
 * - Graceful degradation
 * - Self-healing capabilities
 */
export class AutoRecovery extends EventEmitter {
  constructor(core) {
    super();
    this.core = core;
    this.logger = new Logger('AutoRecovery');
    
    // Component health tracking
    this.componentHealth = new Map();
    this.restartAttempts = new Map();
    this.failureHistory = new Map();
    
    // Circuit breakers for each component
    this.circuitBreakers = new Map();
    
    // Recovery configuration
    this.config = {
      healthCheckInterval: 30000, // 30 seconds
      maxRestartAttempts: 3,
      restartDelay: 5000, // 5 seconds
      cooldownPeriod: 300000, // 5 minutes
      failureThreshold: 5,
      recoveryStrategies: {
        mining: 'restart',
        stratum: 'restart',
        p2p: 'reconnect',
        dex: 'reset',
        api: 'restart',
        database: 'reconnect',
        payment: 'queue',
        fee: 'retry'
      }
    };
    
    // Recovery strategies
    this.strategies = new Map();
    this.initializeStrategies();
    
    // Start monitoring
    this.startHealthMonitoring();
    
    this.logger.info('Auto recovery system initialized');
  }

  /**
   * Initialize recovery strategies
   */
  initializeStrategies() {
    // Mining recovery
    this.strategies.set('mining', {
      name: 'Mining Engine Recovery',
      check: () => this.checkMiningHealth(),
      recover: () => this.recoverMining()
    });
    
    // Stratum recovery
    this.strategies.set('stratum', {
      name: 'Stratum Server Recovery',
      check: () => this.checkStratumHealth(),
      recover: () => this.recoverStratum()
    });
    
    // P2P network recovery
    this.strategies.set('p2p', {
      name: 'P2P Network Recovery',
      check: () => this.checkP2PHealth(),
      recover: () => this.recoverP2P()
    });
    
    // DEX recovery
    this.strategies.set('dex', {
      name: 'DEX System Recovery',
      check: () => this.checkDEXHealth(),
      recover: () => this.recoverDEX()
    });
    
    // Database recovery
    this.strategies.set('database', {
      name: 'Database Recovery',
      check: () => this.checkDatabaseHealth(),
      recover: () => this.recoverDatabase()
    });
    
    // Payment system recovery
    this.strategies.set('payment', {
      name: 'Payment System Recovery',
      check: () => this.checkPaymentHealth(),
      recover: () => this.recoverPaymentSystem()
    });
    
    // Fee collection recovery
    this.strategies.set('fee', {
      name: 'Fee Collection Recovery',
      check: () => this.checkFeeCollectionHealth(),
      recover: () => this.recoverFeeCollection()
    });
  }

  /**
   * Start health monitoring
   */
  startHealthMonitoring() {
    this.healthCheckTimer = setInterval(() => {
      this.performHealthChecks();
    }, this.config.healthCheckInterval);
    
    // Initial health check
    setTimeout(() => this.performHealthChecks(), 5000);
    
    this.logger.info('Health monitoring started');
  }

  /**
   * Perform health checks on all components
   */
  async performHealthChecks() {
    for (const [component, strategy] of this.strategies) {
      try {
        const health = await strategy.check();
        const previousHealth = this.componentHealth.get(component);
        
        this.componentHealth.set(component, health);
        
        if (!health.healthy && previousHealth?.healthy !== false) {
          // Component just became unhealthy
          this.logger.warn(`Component unhealthy: ${component} - ${health.reason}`);
          this.handleComponentFailure(component, health.reason);
        } else if (health.healthy && previousHealth?.healthy === false) {
          // Component recovered
          this.logger.info(`Component recovered: ${component}`);
          this.emit('component:recovered', { component, health });
        }
        
      } catch (error) {
        this.logger.error(`Health check failed for ${component}:`, error);
        this.handleComponentFailure(component, error.message);
      }
    }
    
    // Emit overall health status
    this.emit('health:check', this.getSystemHealth());
  }

  /**
   * Handle component failure
   */
  async handleComponentFailure(component, reason) {
    const failures = this.getFailureCount(component);
    this.recordFailure(component, reason);
    
    // Check circuit breaker
    if (!this.circuitBreakers.has(component)) {
      this.circuitBreakers.set(component, new CircuitBreaker({
        failureThreshold: this.config.failureThreshold,
        cooldownPeriod: this.config.cooldownPeriod
      }));
    }
    
    const circuitBreaker = this.circuitBreakers.get(component);
    
    try {
      await circuitBreaker.execute(async () => {
        // Check restart attempts
        const attempts = this.restartAttempts.get(component) || 0;
        
        if (attempts < this.config.maxRestartAttempts) {
          this.logger.info(`Attempting recovery for ${component} (attempt ${attempts + 1}/${this.config.maxRestartAttempts})`);
          
          // Wait before recovery
          await this.delay(this.config.restartDelay * (attempts + 1));
          
          // Execute recovery strategy
          const strategy = this.strategies.get(component);
          if (strategy) {
            await strategy.recover();
            this.restartAttempts.set(component, attempts + 1);
          }
        } else {
          this.logger.error(`Max recovery attempts reached for ${component} - manual intervention required`);
          this.emit('component:failed', { component, reason, attempts });
        }
      });
    } catch (error) {
      if (error.message === 'Circuit breaker is OPEN') {
        this.logger.error(`Circuit breaker OPEN for ${component} - waiting for cooldown`);
      } else {
        this.logger.error(`Recovery failed for ${component}:`, error);
      }
    }
  }

  /**
   * Component-specific health checks
   */
  async checkMiningHealth() {
    const mining = this.core.components.mining;
    if (!mining) {
      return { healthy: true, reason: 'Mining disabled' };
    }
    
    const stats = mining.getStats();
    const health = {
      healthy: true,
      hashrate: stats.hashrate,
      shares: stats.shares,
      errors: stats.errors
    };
    
    // Check for issues
    if (stats.errors > 100) {
      health.healthy = false;
      health.reason = 'High error rate';
    } else if (stats.hashrate === 0 && stats.running) {
      health.healthy = false;
      health.reason = 'Zero hashrate while running';
    }
    
    return health;
  }

  async checkStratumHealth() {
    const stratum = this.core.components.stratum;
    if (!stratum) {
      return { healthy: false, reason: 'Stratum not initialized' };
    }
    
    try {
      const connections = stratum.getConnectionCount();
      const listening = stratum.isListening();
      
      return {
        healthy: listening,
        connections,
        reason: listening ? null : 'Stratum server not listening'
      };
    } catch (error) {
      return { healthy: false, reason: error.message };
    }
  }

  async checkP2PHealth() {
    const p2p = this.core.components.p2p;
    if (!p2p) {
      return { healthy: false, reason: 'P2P not initialized' };
    }
    
    const peers = p2p.getPeerCount();
    const targetPeers = this.core.config.get('network.maxPeers') / 2;
    
    return {
      healthy: peers > 0 || !p2p.started,
      peers,
      reason: peers === 0 && p2p.started ? 'No peers connected' : null
    };
  }

  async checkDEXHealth() {
    const dex = this.core.components.dex;
    if (!dex) {
      return { healthy: false, reason: 'DEX not initialized' };
    }
    
    try {
      const stats = dex.getStats();
      const health = {
        healthy: true,
        pools: stats.v2.pools + stats.v3.pools,
        tvl: stats.v2.tvl + stats.v3.tvl
      };
      
      // Check for issues
      if (stats.v2.pools === 0 && stats.v3.pools === 0) {
        health.healthy = false;
        health.reason = 'No active pools';
      }
      
      return health;
    } catch (error) {
      return { healthy: false, reason: error.message };
    }
  }

  async checkDatabaseHealth() {
    const db = this.core.components.db;
    if (!db) {
      return { healthy: false, reason: 'Database not initialized' };
    }
    
    try {
      // Perform simple query to check connection
      const result = db.db.prepare('SELECT 1 as test').get();
      
      return {
        healthy: result?.test === 1,
        reason: result?.test !== 1 ? 'Database query failed' : null
      };
    } catch (error) {
      return { healthy: false, reason: error.message };
    }
  }

  async checkPaymentHealth() {
    const paymentManager = this.core.components.paymentManager;
    if (!paymentManager) {
      return { healthy: false, reason: 'Payment manager not initialized' };
    }
    
    try {
      const stats = paymentManager.getPaymentStats();
      const health = {
        healthy: true,
        queueLength: stats.queueLength,
        pendingBalances: stats.pendingBalances
      };
      
      // Check for issues
      if (stats.queueLength > 1000) {
        health.healthy = false;
        health.reason = 'Payment queue backlog';
      }
      
      return health;
    } catch (error) {
      return { healthy: false, reason: error.message };
    }
  }

  async checkFeeCollectionHealth() {
    const feeManager = this.core.components.feeManager;
    if (!feeManager) {
      return { healthy: false, reason: 'Fee manager not initialized' };
    }
    
    try {
      // Verify integrity
      const integrity = feeManager.verifyIntegrity();
      
      return {
        healthy: integrity,
        reason: integrity ? null : 'Fee system integrity violation'
      };
    } catch (error) {
      return { healthy: false, reason: error.message };
    }
  }

  /**
   * Component-specific recovery functions
   */
  async recoverMining() {
    this.logger.info('Recovering mining engine...');
    
    const mining = this.core.components.mining;
    if (!mining) return;
    
    try {
      // Stop mining
      await mining.stop();
      await this.delay(2000);
      
      // Restart with same configuration
      const config = this.core.config.get('mining');
      await mining.start({ difficulty: 1000000 });
      
      this.logger.info('Mining engine recovered');
      this.resetComponentStatus('mining');
    } catch (error) {
      this.logger.error('Mining recovery failed:', error);
      throw error;
    }
  }

  async recoverStratum() {
    this.logger.info('Recovering stratum server...');
    
    const stratum = this.core.components.stratum;
    if (!stratum) return;
    
    try {
      // Restart stratum server
      await stratum.stop();
      await this.delay(2000);
      await stratum.start();
      
      this.logger.info('Stratum server recovered');
      this.resetComponentStatus('stratum');
    } catch (error) {
      this.logger.error('Stratum recovery failed:', error);
      throw error;
    }
  }

  async recoverP2P() {
    this.logger.info('Recovering P2P network...');
    
    const p2p = this.core.components.p2p;
    if (!p2p) return;
    
    try {
      // Reconnect to peers
      await p2p.reconnect();
      
      // Bootstrap if no peers
      if (p2p.getPeerCount() === 0) {
        await p2p.bootstrap();
      }
      
      this.logger.info('P2P network recovered');
      this.resetComponentStatus('p2p');
    } catch (error) {
      this.logger.error('P2P recovery failed:', error);
      throw error;
    }
  }

  async recoverDEX() {
    this.logger.info('Recovering DEX system...');
    
    const dex = this.core.components.dex;
    if (!dex) return;
    
    try {
      // Reinitialize pools if needed
      const stats = dex.getStats();
      if (stats.v2.pools === 0 && stats.v3.pools === 0) {
        await this.core.initializeAutomatedDefaults();
      }
      
      this.logger.info('DEX system recovered');
      this.resetComponentStatus('dex');
    } catch (error) {
      this.logger.error('DEX recovery failed:', error);
      throw error;
    }
  }

  async recoverDatabase() {
    this.logger.info('Recovering database connection...');
    
    const db = this.core.components.db;
    if (!db) return;
    
    try {
      // Close and reopen database
      await db.close();
      await this.delay(1000);
      await db.initialize();
      
      this.logger.info('Database connection recovered');
      this.resetComponentStatus('database');
    } catch (error) {
      this.logger.error('Database recovery failed:', error);
      throw error;
    }
  }

  async recoverPaymentSystem() {
    this.logger.info('Recovering payment system...');
    
    const paymentManager = this.core.components.paymentManager;
    if (!paymentManager) return;
    
    try {
      // Process payment queue
      await paymentManager.processPaymentQueue();
      
      // Process automatic payouts
      await paymentManager.processAutomaticPayouts();
      
      this.logger.info('Payment system recovered');
      this.resetComponentStatus('payment');
    } catch (error) {
      this.logger.error('Payment system recovery failed:', error);
      throw error;
    }
  }

  async recoverFeeCollection() {
    this.logger.info('Recovering fee collection...');
    
    const feeManager = this.core.components.feeManager;
    if (!feeManager) return;
    
    try {
      // Force fee collection
      await feeManager.processOperatorFeeCollection();
      
      this.logger.info('Fee collection recovered');
      this.resetComponentStatus('fee');
    } catch (error) {
      this.logger.error('Fee collection recovery failed:', error);
      throw error;
    }
  }

  /**
   * Helper functions
   */
  recordFailure(component, reason) {
    if (!this.failureHistory.has(component)) {
      this.failureHistory.set(component, []);
    }
    
    const history = this.failureHistory.get(component);
    history.push({
      timestamp: Date.now(),
      reason
    });
    
    // Keep only last 100 failures
    if (history.length > 100) {
      history.shift();
    }
  }

  getFailureCount(component, timeWindow = 3600000) {
    const history = this.failureHistory.get(component) || [];
    const now = Date.now();
    
    return history.filter(failure => 
      now - failure.timestamp < timeWindow
    ).length;
  }

  resetComponentStatus(component) {
    this.restartAttempts.set(component, 0);
    this.componentHealth.set(component, { healthy: true });
    
    // Reset circuit breaker
    const circuitBreaker = this.circuitBreakers.get(component);
    if (circuitBreaker) {
      circuitBreaker.reset();
    }
  }

  getSystemHealth() {
    const components = {};
    let totalHealthy = 0;
    let totalComponents = 0;
    
    for (const [component, health] of this.componentHealth) {
      components[component] = health;
      totalComponents++;
      if (health.healthy) totalHealthy++;
    }
    
    return {
      healthy: totalHealthy === totalComponents,
      healthScore: totalComponents > 0 ? (totalHealthy / totalComponents) * 100 : 0,
      components,
      timestamp: Date.now()
    };
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Stop auto recovery
   */
  stop() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
    
    this.logger.info('Auto recovery system stopped');
  }
}
