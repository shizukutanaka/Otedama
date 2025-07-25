/**
 * Auto-Scaling System for Otedama
 * Dynamic resource allocation for national scale
 * 
 * Design:
 * - Carmack: Predictive scaling with minimal overhead
 * - Martin: Clean scaling policies
 * - Pike: Simple but effective scaling
 */

import { EventEmitter } from 'events';
import cluster from 'cluster';
import os from 'os';
import { createStructuredLogger } from '../core/structured-logger.js';
import { getMonitoringSystem } from './national-monitoring.js';

// Scaling policies
export const ScalingPolicy = {
  CPU_BASED: 'cpu_based',
  MEMORY_BASED: 'memory_based',
  LOAD_BASED: 'load_based',
  CUSTOM: 'custom',
  SCHEDULED: 'scheduled'
};

// Scaling actions
export const ScalingAction = {
  SCALE_UP: 'scale_up',
  SCALE_DOWN: 'scale_down',
  MAINTAIN: 'maintain'
};

/**
 * Scaling rule definition
 */
class ScalingRule {
  constructor(name, options) {
    this.name = name;
    this.policy = options.policy || ScalingPolicy.CPU_BASED;
    this.scaleUpThreshold = options.scaleUpThreshold || 0.8;
    this.scaleDownThreshold = options.scaleDownThreshold || 0.3;
    this.cooldownPeriod = options.cooldownPeriod || 300000; // 5 minutes
    this.minInstances = options.minInstances || 1;
    this.maxInstances = options.maxInstances || os.cpus().length * 2;
    this.scaleIncrement = options.scaleIncrement || 1;
    this.evaluationPeriods = options.evaluationPeriods || 3;
    this.lastScaleTime = 0;
    this.evaluationHistory = [];
  }
  
  /**
   * Evaluate scaling rule
   */
  evaluate(metrics, currentInstances) {
    // Check cooldown
    if (Date.now() - this.lastScaleTime < this.cooldownPeriod) {
      return { action: ScalingAction.MAINTAIN, reason: 'cooldown' };
    }
    
    let metricValue;
    
    switch (this.policy) {
      case ScalingPolicy.CPU_BASED:
        metricValue = metrics.cpu;
        break;
      case ScalingPolicy.MEMORY_BASED:
        metricValue = metrics.memory;
        break;
      case ScalingPolicy.LOAD_BASED:
        metricValue = metrics.load;
        break;
      default:
        return { action: ScalingAction.MAINTAIN, reason: 'unknown_policy' };
    }
    
    // Add to evaluation history
    this.evaluationHistory.push({
      timestamp: Date.now(),
      value: metricValue
    });
    
    // Keep only recent evaluations
    const cutoff = Date.now() - 60000 * this.evaluationPeriods;
    this.evaluationHistory = this.evaluationHistory.filter(e => e.timestamp > cutoff);
    
    // Need enough data points
    if (this.evaluationHistory.length < this.evaluationPeriods) {
      return { action: ScalingAction.MAINTAIN, reason: 'insufficient_data' };
    }
    
    // Calculate average
    const avgValue = this.evaluationHistory.reduce((sum, e) => sum + e.value, 0) / 
                     this.evaluationHistory.length;
    
    // Determine action
    if (avgValue > this.scaleUpThreshold && currentInstances < this.maxInstances) {
      this.lastScaleTime = Date.now();
      return {
        action: ScalingAction.SCALE_UP,
        increment: Math.min(this.scaleIncrement, this.maxInstances - currentInstances),
        reason: `${this.policy} above ${this.scaleUpThreshold}`,
        metric: avgValue
      };
    }
    
    if (avgValue < this.scaleDownThreshold && currentInstances > this.minInstances) {
      this.lastScaleTime = Date.now();
      return {
        action: ScalingAction.SCALE_DOWN,
        increment: Math.min(this.scaleIncrement, currentInstances - this.minInstances),
        reason: `${this.policy} below ${this.scaleDownThreshold}`,
        metric: avgValue
      };
    }
    
    return { action: ScalingAction.MAINTAIN, reason: 'within_thresholds', metric: avgValue };
  }
}

/**
 * Auto-scaling system
 */
export class AutoScalingSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enabled: options.enabled !== false,
      evaluationInterval: options.evaluationInterval || 60000, // 1 minute
      maxWorkers: options.maxWorkers || os.cpus().length * 2,
      minWorkers: options.minWorkers || 1,
      targetUtilization: options.targetUtilization || 0.7,
      ...options
    };
    
    this.logger = createStructuredLogger('AutoScaling');
    this.monitoring = getMonitoringSystem();
    this.rules = new Map();
    this.workers = new Map();
    this.scaling = false;
    
    // Default rules
    this.setupDefaultRules();
  }
  
  /**
   * Setup default scaling rules
   */
  setupDefaultRules() {
    // CPU-based scaling
    this.addRule('cpu_rule', {
      policy: ScalingPolicy.CPU_BASED,
      scaleUpThreshold: 0.8,
      scaleDownThreshold: 0.3,
      cooldownPeriod: 300000,
      minInstances: this.options.minWorkers,
      maxInstances: this.options.maxWorkers
    });
    
    // Memory-based scaling
    this.addRule('memory_rule', {
      policy: ScalingPolicy.MEMORY_BASED,
      scaleUpThreshold: 0.85,
      scaleDownThreshold: 0.4,
      cooldownPeriod: 600000, // 10 minutes
      minInstances: this.options.minWorkers,
      maxInstances: this.options.maxWorkers
    });
  }
  
  /**
   * Start auto-scaling
   */
  start() {
    if (!this.options.enabled) {
      this.logger.info('Auto-scaling is disabled');
      return;
    }
    
    this.logger.info('Starting auto-scaling system');
    
    // Start evaluation loop
    this.evaluationInterval = setInterval(() => {
      this.evaluate();
    }, this.options.evaluationInterval);
    
    // Monitor worker events
    if (cluster.isMaster) {
      cluster.on('online', (worker) => {
        this.workers.set(worker.id, {
          id: worker.id,
          pid: worker.process.pid,
          startTime: Date.now()
        });
        
        this.emit('worker:started', worker.id);
      });
      
      cluster.on('exit', (worker, code, signal) => {
        this.workers.delete(worker.id);
        
        if (signal !== 'SIGTERM') {
          // Unexpected exit, restart
          this.logger.warn(`Worker ${worker.id} died unexpectedly, restarting...`);
          this.scaleUp(1);
        }
        
        this.emit('worker:stopped', worker.id);
      });
    }
  }
  
  /**
   * Add scaling rule
   */
  addRule(name, options) {
    const rule = new ScalingRule(name, options);
    this.rules.set(name, rule);
    this.logger.info(`Added scaling rule: ${name}`, options);
  }
  
  /**
   * Remove scaling rule
   */
  removeRule(name) {
    this.rules.delete(name);
    this.logger.info(`Removed scaling rule: ${name}`);
  }
  
  /**
   * Evaluate scaling rules
   */
  async evaluate() {
    if (this.scaling || !cluster.isMaster) return;
    
    try {
      // Get current metrics
      const metrics = await this.getCurrentMetrics();
      const currentWorkers = this.workers.size;
      
      this.logger.debug('Evaluating scaling rules', {
        currentWorkers,
        metrics
      });
      
      // Evaluate each rule
      const decisions = [];
      
      for (const [name, rule] of this.rules) {
        const decision = rule.evaluate(metrics, currentWorkers);
        decisions.push({
          rule: name,
          ...decision
        });
      }
      
      // Determine final action (most aggressive wins)
      let finalAction = ScalingAction.MAINTAIN;
      let totalIncrement = 0;
      
      for (const decision of decisions) {
        if (decision.action === ScalingAction.SCALE_UP) {
          finalAction = ScalingAction.SCALE_UP;
          totalIncrement = Math.max(totalIncrement, decision.increment || 1);
        } else if (decision.action === ScalingAction.SCALE_DOWN && 
                   finalAction !== ScalingAction.SCALE_UP) {
          finalAction = ScalingAction.SCALE_DOWN;
          totalIncrement = Math.max(totalIncrement, decision.increment || 1);
        }
      }
      
      // Execute scaling action
      if (finalAction !== ScalingAction.MAINTAIN) {
        await this.executeScaling(finalAction, totalIncrement, decisions);
      }
      
    } catch (error) {
      this.logger.error('Error evaluating scaling rules', error);
    }
  }
  
  /**
   * Get current metrics
   */
  async getCurrentMetrics() {
    const history = this.monitoring.getHistory(300000); // Last 5 minutes
    
    if (history.length === 0) {
      return {
        cpu: 0,
        memory: 0,
        load: 0
      };
    }
    
    // Calculate averages
    const totals = history.reduce((acc, snapshot) => {
      acc.cpu += snapshot.system.cpu;
      acc.memory += snapshot.system.memory;
      acc.count++;
      return acc;
    }, { cpu: 0, memory: 0, count: 0 });
    
    // Get system memory for percentage
    const totalMemory = os.totalmem();
    
    return {
      cpu: totals.cpu / totals.count / 100, // Convert to 0-1
      memory: totals.memory / totalMemory,
      load: this.workers.size / this.options.maxWorkers
    };
  }
  
  /**
   * Execute scaling action
   */
  async executeScaling(action, increment, decisions) {
    this.scaling = true;
    
    try {
      this.logger.info('Executing scaling action', {
        action,
        increment,
        currentWorkers: this.workers.size,
        decisions: decisions.map(d => ({
          rule: d.rule,
          action: d.action,
          reason: d.reason,
          metric: d.metric
        }))
      });
      
      this.emit('scaling:started', {
        action,
        increment,
        currentWorkers: this.workers.size
      });
      
      switch (action) {
        case ScalingAction.SCALE_UP:
          await this.scaleUp(increment);
          break;
          
        case ScalingAction.SCALE_DOWN:
          await this.scaleDown(increment);
          break;
      }
      
      this.emit('scaling:completed', {
        action,
        increment,
        newWorkers: this.workers.size
      });
      
    } catch (error) {
      this.logger.error('Error executing scaling action', error);
      this.emit('scaling:failed', { action, error });
    } finally {
      this.scaling = false;
    }
  }
  
  /**
   * Scale up workers
   */
  async scaleUp(count) {
    for (let i = 0; i < count; i++) {
      if (this.workers.size >= this.options.maxWorkers) {
        this.logger.warn('Maximum workers reached');
        break;
      }
      
      const worker = cluster.fork();
      this.logger.info(`Started new worker ${worker.id}`);
      
      // Wait for worker to be ready
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 10000); // 10 second timeout
        
        worker.once('online', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  }
  
  /**
   * Scale down workers
   */
  async scaleDown(count) {
    const workersArray = Array.from(this.workers.values())
      .sort((a, b) => b.startTime - a.startTime); // Newest first
    
    for (let i = 0; i < count && i < workersArray.length; i++) {
      if (this.workers.size <= this.options.minWorkers) {
        this.logger.warn('Minimum workers reached');
        break;
      }
      
      const worker = workersArray[i];
      const clusterWorker = cluster.workers[worker.id];
      
      if (clusterWorker) {
        this.logger.info(`Stopping worker ${worker.id}`);
        
        // Graceful shutdown
        clusterWorker.send({ cmd: 'shutdown' });
        
        // Force kill after timeout
        setTimeout(() => {
          if (!clusterWorker.isDead()) {
            clusterWorker.kill();
          }
        }, 30000); // 30 seconds
      }
    }
  }
  
  /**
   * Manual scale
   */
  async scale(targetWorkers) {
    const current = this.workers.size;
    
    if (targetWorkers > current) {
      await this.scaleUp(targetWorkers - current);
    } else if (targetWorkers < current) {
      await this.scaleDown(current - targetWorkers);
    }
  }
  
  /**
   * Get scaling status
   */
  getStatus() {
    const rules = Array.from(this.rules.entries()).map(([name, rule]) => ({
      name,
      policy: rule.policy,
      lastScaleTime: rule.lastScaleTime,
      evaluationHistory: rule.evaluationHistory.length
    }));
    
    return {
      enabled: this.options.enabled,
      currentWorkers: this.workers.size,
      minWorkers: this.options.minWorkers,
      maxWorkers: this.options.maxWorkers,
      scaling: this.scaling,
      rules,
      workers: Array.from(this.workers.values())
    };
  }
  
  /**
   * Stop auto-scaling
   */
  stop() {
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
    }
    
    this.logger.info('Auto-scaling system stopped');
  }
}

// Export singleton
let autoScalingInstance = null;

export function getAutoScalingSystem(options = {}) {
  if (!autoScalingInstance) {
    autoScalingInstance = new AutoScalingSystem(options);
  }
  return autoScalingInstance;
}

export default AutoScalingSystem;
