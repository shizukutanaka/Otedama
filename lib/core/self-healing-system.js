/**
 * Self-Healing System - Otedama
 * Automatic failure detection and recovery
 * 
 * Features:
 * - Circuit breaker pattern
 * - Health checks and monitoring
 * - Automatic restart and recovery
 * - Failure prediction
 * - Cascade failure prevention
 */

import { EventEmitter } from 'events';
import cluster from 'cluster';
import { createStructuredLogger } from './structured-logger.js';

const logger = createStructuredLogger('SelfHealing');

/**
 * Circuit breaker implementation
 */
export class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 2;
    this.timeout = options.timeout || 60000; // 1 minute
    this.resetTimeout = options.resetTimeout || 30000; // 30 seconds
    
    // State: CLOSED, OPEN, HALF_OPEN
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.nextAttempt = Date.now();
    
    // Statistics
    this.stats = {
      requests: 0,
      failures: 0,
      successes: 0,
      rejections: 0,
      timeouts: 0
    };
  }
  
  /**
   * Execute function with circuit breaker
   */
  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        this.stats.rejections++;
        throw new Error(`Circuit breaker is OPEN for ${this.name}`);
      }
      
      // Try half-open
      this.state = 'HALF_OPEN';
      logger.info(`Circuit breaker ${this.name} entering HALF_OPEN state`);
    }
    
    this.stats.requests++;
    
    try {
      // Execute with timeout
      const result = await this.executeWithTimeout(fn, this.timeout);
      
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }
  
  /**
   * Execute with timeout
   */
  async executeWithTimeout(fn, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stats.timeouts++;
        reject(new Error(`Operation timed out after ${timeout}ms`));
      }, timeout);
      
      fn().then(result => {
        clearTimeout(timer);
        resolve(result);
      }).catch(error => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
  
  /**
   * Handle success
   */
  onSuccess() {
    this.stats.successes++;
    this.failures = 0;
    
    if (this.state === 'HALF_OPEN') {
      this.successes++;
      
      if (this.successes >= this.successThreshold) {
        this.state = 'CLOSED';
        this.successes = 0;
        logger.info(`Circuit breaker ${this.name} is now CLOSED`);
      }
    }
  }
  
  /**
   * Handle failure
   */
  onFailure(error) {
    this.stats.failures++;
    this.failures++;
    this.successes = 0;
    
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.resetTimeout;
      logger.error(`Circuit breaker ${this.name} is now OPEN`, {
        error: error.message,
        failures: this.failures
      });
    }
  }
  
  /**
   * Get circuit state
   */
  getState() {
    return {
      state: this.state,
      failures: this.failures,
      nextAttempt: this.nextAttempt,
      stats: this.stats
    };
  }
  
  /**
   * Force reset
   */
  reset() {
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.nextAttempt = Date.now();
    logger.info(`Circuit breaker ${this.name} manually reset`);
  }
}

/**
 * Health check manager
 */
export class HealthCheckManager {
  constructor() {
    this.checks = new Map();
    this.results = new Map();
    this.interval = 5000; // 5 seconds
    this.timer = null;
  }
  
  /**
   * Register health check
   */
  register(name, check, options = {}) {
    this.checks.set(name, {
      fn: check,
      critical: options.critical || false,
      timeout: options.timeout || 5000,
      retries: options.retries || 3
    });
    
    this.results.set(name, {
      status: 'unknown',
      lastCheck: null,
      consecutiveFailures: 0,
      message: null
    });
  }
  
  /**
   * Start health checks
   */
  start() {
    if (this.timer) return;
    
    this.timer = setInterval(() => this.runChecks(), this.interval);
    this.runChecks(); // Run immediately
    
    logger.info('Health check manager started');
  }
  
  /**
   * Stop health checks
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    
    logger.info('Health check manager stopped');
  }
  
  /**
   * Run all health checks
   */
  async runChecks() {
    const promises = [];
    
    for (const [name, check] of this.checks) {
      promises.push(this.runCheck(name, check));
    }
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Run single health check
   */
  async runCheck(name, check) {
    const result = this.results.get(name);
    let attempts = 0;
    
    while (attempts < check.retries) {
      try {
        const startTime = Date.now();
        
        await this.executeWithTimeout(check.fn(), check.timeout);
        
        result.status = 'healthy';
        result.lastCheck = Date.now();
        result.consecutiveFailures = 0;
        result.message = null;
        result.responseTime = Date.now() - startTime;
        
        return;
      } catch (error) {
        attempts++;
        
        if (attempts < check.retries) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          result.status = 'unhealthy';
          result.lastCheck = Date.now();
          result.consecutiveFailures++;
          result.message = error.message;
          
          logger.warn(`Health check ${name} failed`, {
            error: error.message,
            attempts,
            consecutiveFailures: result.consecutiveFailures
          });
          
          if (check.critical && result.consecutiveFailures > 3) {
            logger.error(`Critical health check ${name} failing continuously`);
          }
        }
      }
    }
  }
  
  /**
   * Execute with timeout
   */
  async executeWithTimeout(promise, timeout) {
    return Promise.race([
      promise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Health check timeout')), timeout)
      )
    ]);
  }
  
  /**
   * Get health status
   */
  getStatus() {
    const status = {
      healthy: true,
      checks: {}
    };
    
    for (const [name, result] of this.results) {
      status.checks[name] = { ...result };
      
      if (result.status === 'unhealthy') {
        status.healthy = false;
      }
    }
    
    return status;
  }
}

/**
 * Process supervisor
 */
export class ProcessSupervisor extends EventEmitter {
  constructor() {
    super();
    
    this.processes = new Map();
    this.restartAttempts = new Map();
    this.maxRestarts = 5;
    this.restartWindow = 60000; // 1 minute
  }
  
  /**
   * Supervise process
   */
  supervise(name, startFn, options = {}) {
    const config = {
      startFn,
      autoRestart: options.autoRestart !== false,
      restartDelay: options.restartDelay || 1000,
      maxMemory: options.maxMemory || 512 * 1024 * 1024, // 512MB
      healthCheck: options.healthCheck
    };
    
    this.processes.set(name, {
      config,
      process: null,
      status: 'stopped',
      startTime: null,
      restarts: 0
    });
  }
  
  /**
   * Start process
   */
  async start(name) {
    const proc = this.processes.get(name);
    if (!proc || proc.status === 'running') return;
    
    try {
      proc.status = 'starting';
      proc.process = await proc.config.startFn();
      proc.status = 'running';
      proc.startTime = Date.now();
      
      // Monitor process
      this.monitorProcess(name);
      
      logger.info(`Process ${name} started successfully`);
      this.emit('process-started', name);
    } catch (error) {
      proc.status = 'failed';
      logger.error(`Failed to start process ${name}`, error);
      
      if (proc.config.autoRestart) {
        this.scheduleRestart(name);
      }
    }
  }
  
  /**
   * Monitor process health
   */
  monitorProcess(name) {
    const proc = this.processes.get(name);
    if (!proc) return;
    
    const monitor = setInterval(async () => {
      if (proc.status !== 'running') {
        clearInterval(monitor);
        return;
      }
      
      // Check if process is alive
      if (proc.process && proc.process.killed) {
        proc.status = 'crashed';
        clearInterval(monitor);
        this.handleCrash(name);
        return;
      }
      
      // Memory check
      if (proc.process && proc.process.memoryUsage) {
        const memory = proc.process.memoryUsage();
        if (memory.rss > proc.config.maxMemory) {
          logger.warn(`Process ${name} exceeding memory limit`, {
            current: memory.rss,
            limit: proc.config.maxMemory
          });
          
          this.restart(name, 'Memory limit exceeded');
          clearInterval(monitor);
          return;
        }
      }
      
      // Custom health check
      if (proc.config.healthCheck) {
        try {
          await proc.config.healthCheck();
        } catch (error) {
          logger.warn(`Process ${name} health check failed`, error);
          this.restart(name, 'Health check failed');
          clearInterval(monitor);
        }
      }
    }, 5000);
  }
  
  /**
   * Handle process crash
   */
  handleCrash(name) {
    const proc = this.processes.get(name);
    if (!proc) return;
    
    logger.error(`Process ${name} crashed`);
    this.emit('process-crashed', name);
    
    if (proc.config.autoRestart) {
      this.scheduleRestart(name);
    }
  }
  
  /**
   * Schedule restart
   */
  scheduleRestart(name) {
    const proc = this.processes.get(name);
    if (!proc) return;
    
    // Check restart limit
    const attempts = this.getRestartAttempts(name);
    if (attempts >= this.maxRestarts) {
      logger.error(`Process ${name} exceeded restart limit`, {
        attempts,
        maxRestarts: this.maxRestarts
      });
      proc.status = 'failed';
      this.emit('process-failed', name);
      return;
    }
    
    // Exponential backoff
    const delay = proc.config.restartDelay * Math.pow(2, attempts);
    
    logger.info(`Scheduling restart for ${name} in ${delay}ms`);
    
    setTimeout(() => {
      this.incrementRestartAttempts(name);
      this.start(name);
    }, delay);
  }
  
  /**
   * Get restart attempts
   */
  getRestartAttempts(name) {
    const attempts = this.restartAttempts.get(name) || [];
    const now = Date.now();
    
    // Filter recent attempts
    const recent = attempts.filter(time => now - time < this.restartWindow);
    this.restartAttempts.set(name, recent);
    
    return recent.length;
  }
  
  /**
   * Increment restart attempts
   */
  incrementRestartAttempts(name) {
    const attempts = this.restartAttempts.get(name) || [];
    attempts.push(Date.now());
    this.restartAttempts.set(name, attempts);
  }
  
  /**
   * Restart process
   */
  async restart(name, reason) {
    logger.info(`Restarting process ${name}`, { reason });
    
    await this.stop(name);
    await this.start(name);
  }
  
  /**
   * Stop process
   */
  async stop(name) {
    const proc = this.processes.get(name);
    if (!proc || proc.status === 'stopped') return;
    
    try {
      if (proc.process && proc.process.kill) {
        proc.process.kill('SIGTERM');
        
        // Wait for graceful shutdown
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        if (!proc.process.killed) {
          proc.process.kill('SIGKILL');
        }
      }
      
      proc.status = 'stopped';
      proc.process = null;
      
      logger.info(`Process ${name} stopped`);
      this.emit('process-stopped', name);
    } catch (error) {
      logger.error(`Error stopping process ${name}`, error);
    }
  }
  
  /**
   * Get process status
   */
  getStatus() {
    const status = {};
    
    for (const [name, proc] of this.processes) {
      status[name] = {
        status: proc.status,
        uptime: proc.startTime ? Date.now() - proc.startTime : 0,
        restarts: proc.restarts,
        memory: proc.process?.memoryUsage?.() || null
      };
    }
    
    return status;
  }
}

/**
 * Failure predictor using anomaly detection
 */
export class FailurePredictor {
  constructor(monitor) {
    this.monitor = monitor;
    this.patterns = new Map();
    this.predictions = [];
  }
  
  /**
   * Learn failure patterns
   */
  learnPattern(metrics, failure) {
    const pattern = {
      metrics: this.extractFeatures(metrics),
      failure,
      timestamp: Date.now()
    };
    
    if (!this.patterns.has(failure.type)) {
      this.patterns.set(failure.type, []);
    }
    
    this.patterns.get(failure.type).push(pattern);
  }
  
  /**
   * Extract features from metrics
   */
  extractFeatures(metrics) {
    return {
      cpuTrend: this.calculateTrend(metrics.cpu),
      memoryTrend: this.calculateTrend(metrics.memory),
      errorRate: metrics.errors / metrics.requests,
      latencySpike: metrics.latency.p95 / metrics.latency.mean,
      throughputDrop: this.calculateThroughputDrop(metrics)
    };
  }
  
  /**
   * Calculate metric trend
   */
  calculateTrend(values) {
    if (values.length < 2) return 0;
    
    const n = values.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumX2 += i * i;
    }
    
    return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  }
  
  /**
   * Calculate throughput drop
   */
  calculateThroughputDrop(metrics) {
    const baseline = metrics.throughput.slice(0, -10).reduce((a, b) => a + b) / (metrics.throughput.length - 10);
    const recent = metrics.throughput.slice(-10).reduce((a, b) => a + b) / 10;
    
    return baseline > 0 ? (baseline - recent) / baseline : 0;
  }
  
  /**
   * Predict failures
   */
  predict(currentMetrics) {
    const features = this.extractFeatures(currentMetrics);
    const predictions = [];
    
    for (const [failureType, patterns] of this.patterns) {
      const similarity = this.calculateSimilarity(features, patterns);
      
      if (similarity > 0.8) {
        predictions.push({
          type: failureType,
          probability: similarity,
          timeToFailure: this.estimateTimeToFailure(patterns),
          recommendation: this.getRecommendation(failureType)
        });
      }
    }
    
    this.predictions = predictions;
    return predictions;
  }
  
  /**
   * Calculate similarity to failure patterns
   */
  calculateSimilarity(features, patterns) {
    if (patterns.length === 0) return 0;
    
    let maxSimilarity = 0;
    
    for (const pattern of patterns) {
      let similarity = 0;
      let count = 0;
      
      for (const [key, value] of Object.entries(features)) {
        if (pattern.metrics[key] !== undefined) {
          const diff = Math.abs(value - pattern.metrics[key]);
          similarity += 1 - Math.min(diff, 1);
          count++;
        }
      }
      
      if (count > 0) {
        maxSimilarity = Math.max(maxSimilarity, similarity / count);
      }
    }
    
    return maxSimilarity;
  }
  
  /**
   * Estimate time to failure
   */
  estimateTimeToFailure(patterns) {
    // Simple average of historical times
    const times = patterns.map(p => p.failure.timeFromPattern || 60000);
    return times.reduce((a, b) => a + b) / times.length;
  }
  
  /**
   * Get failure prevention recommendation
   */
  getRecommendation(failureType) {
    const recommendations = {
      'memory_leak': 'Restart process to clear memory',
      'cpu_overload': 'Scale out or optimize CPU-intensive operations',
      'connection_exhaustion': 'Increase connection pool size or add connection limiting',
      'cascading_failure': 'Enable circuit breakers and add backpressure',
      'disk_full': 'Clear logs or expand disk space'
    };
    
    return recommendations[failureType] || 'Monitor closely and prepare for manual intervention';
  }
}

/**
 * Self-healing system coordinator
 */
export class SelfHealingSystem extends EventEmitter {
  constructor() {
    super();
    
    this.circuitBreakers = new Map();
    this.healthChecker = new HealthCheckManager();
    this.supervisor = new ProcessSupervisor();
    this.predictor = null;
    
    this.healing = false;
  }
  
  /**
   * Start self-healing system
   */
  start(monitor) {
    if (this.healing) return;
    
    this.healing = true;
    this.predictor = new FailurePredictor(monitor);
    
    // Start components
    this.healthChecker.start();
    
    // Setup event handlers
    this.setupEventHandlers();
    
    logger.info('Self-healing system started');
  }
  
  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    // Process events
    this.supervisor.on('process-crashed', (name) => {
      this.emit('healing-action', {
        type: 'process-restart',
        target: name,
        reason: 'Process crash detected'
      });
    });
    
    this.supervisor.on('process-failed', (name) => {
      this.emit('healing-failed', {
        type: 'process-restart',
        target: name,
        reason: 'Exceeded restart limit'
      });
    });
  }
  
  /**
   * Create circuit breaker
   */
  createCircuitBreaker(name, options) {
    const breaker = new CircuitBreaker(name, options);
    this.circuitBreakers.set(name, breaker);
    return breaker;
  }
  
  /**
   * Register health check
   */
  registerHealthCheck(name, check, options) {
    this.healthChecker.register(name, check, options);
  }
  
  /**
   * Supervise process
   */
  superviseProcess(name, startFn, options) {
    this.supervisor.supervise(name, startFn, options);
  }
  
  /**
   * Get system health
   */
  getHealth() {
    return {
      overall: this.calculateOverallHealth(),
      checks: this.healthChecker.getStatus(),
      processes: this.supervisor.getStatus(),
      circuitBreakers: this.getCircuitBreakerStatus(),
      predictions: this.predictor?.predictions || []
    };
  }
  
  /**
   * Calculate overall health
   */
  calculateOverallHealth() {
    const health = this.healthChecker.getStatus();
    const processes = this.supervisor.getStatus();
    
    let score = 100;
    
    // Deduct for unhealthy checks
    const unhealthyChecks = Object.values(health.checks)
      .filter(c => c.status === 'unhealthy').length;
    score -= unhealthyChecks * 10;
    
    // Deduct for failed processes
    const failedProcesses = Object.values(processes)
      .filter(p => p.status === 'failed').length;
    score -= failedProcesses * 20;
    
    // Deduct for open circuit breakers
    const openBreakers = Array.from(this.circuitBreakers.values())
      .filter(b => b.state === 'OPEN').length;
    score -= openBreakers * 15;
    
    return Math.max(0, score);
  }
  
  /**
   * Get circuit breaker status
   */
  getCircuitBreakerStatus() {
    const status = {};
    
    for (const [name, breaker] of this.circuitBreakers) {
      status[name] = breaker.getState();
    }
    
    return status;
  }
  
  /**
   * Stop self-healing system
   */
  stop() {
    this.healing = false;
    this.healthChecker.stop();
    
    logger.info('Self-healing system stopped');
  }
}

export default {
  SelfHealingSystem,
  CircuitBreaker,
  HealthCheckManager,
  ProcessSupervisor,
  FailurePredictor
};