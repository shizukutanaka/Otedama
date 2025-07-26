/**
 * Smart Resource Orchestrator - Otedama
 * Intelligent resource management and auto-scaling for national-scale operations
 * 
 * Design Principles:
 * - Carmack: Optimal resource utilization with predictive allocation
 * - Martin: Clean separation of resource domains and policies
 * - Pike: Simple rules for complex resource orchestration
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import crypto from 'crypto';

const logger = createStructuredLogger('SmartResourceOrchestrator');

/**
 * Resource types
 */
const RESOURCE_TYPES = {
  CPU: 'cpu',
  MEMORY: 'memory',
  STORAGE: 'storage',
  NETWORK: 'network',
  GPU: 'gpu',
  CONTAINER: 'container',
  SERVICE: 'service',
  DATABASE: 'database'
};

/**
 * Scaling policies
 */
const SCALING_POLICIES = {
  REACTIVE: 'reactive',
  PREDICTIVE: 'predictive',
  SCHEDULED: 'scheduled',
  HYBRID: 'hybrid'
};

/**
 * Resource states
 */
const RESOURCE_STATES = {
  AVAILABLE: 'available',
  ALLOCATED: 'allocated',
  OVERLOADED: 'overloaded',
  DEGRADED: 'degraded',
  FAILED: 'failed',
  MAINTENANCE: 'maintenance'
};

/**
 * Resource pool manager
 */
class ResourcePool {
  constructor(name, config = {}) {
    this.name = name;
    this.config = {
      type: config.type,
      minCapacity: config.minCapacity || 1,
      maxCapacity: config.maxCapacity || 100,
      targetUtilization: config.targetUtilization || 0.7,
      scaleUpThreshold: config.scaleUpThreshold || 0.8,
      scaleDownThreshold: config.scaleDownThreshold || 0.4,
      cooldownPeriod: config.cooldownPeriod || 300000, // 5 minutes
      ...config
    };
    
    this.resources = new Map();
    this.metrics = new Map();
    this.lastScalingAction = 0;
    this.scalingHistory = [];
  }
  
  /**
   * Add resource to pool
   */
  addResource(id, resource) {
    const resourceInfo = {
      id,
      type: this.config.type,
      capacity: resource.capacity || 1,
      allocated: 0,
      state: RESOURCE_STATES.AVAILABLE,
      health: 1.0,
      lastUsed: 0,
      metadata: resource.metadata || {},
      created: Date.now()
    };
    
    this.resources.set(id, resourceInfo);
    
    return resourceInfo;
  }
  
  /**
   * Remove resource from pool
   */
  removeResource(id) {
    const resource = this.resources.get(id);
    if (!resource) return false;
    
    // Only remove if not allocated
    if (resource.allocated === 0) {
      this.resources.delete(id);
      return true;
    }
    
    return false;
  }
  
  /**
   * Allocate resource
   */
  allocateResource(amount = 1, constraints = {}) {
    const availableResources = Array.from(this.resources.values())
      .filter(r => r.state === RESOURCE_STATES.AVAILABLE)
      .filter(r => r.capacity - r.allocated >= amount)
      .filter(r => this.meetsConstraints(r, constraints))
      .sort((a, b) => {
        // Prefer resources with better health and lower utilization
        const utilizationA = a.allocated / a.capacity;
        const utilizationB = b.allocated / b.capacity;
        return (utilizationA * (2 - a.health)) - (utilizationB * (2 - b.health));
      });
    
    if (availableResources.length === 0) {
      return null;
    }
    
    const resource = availableResources[0];
    resource.allocated += amount;
    resource.lastUsed = Date.now();
    
    if (resource.allocated >= resource.capacity) {
      resource.state = RESOURCE_STATES.ALLOCATED;
    }
    
    return {
      resourceId: resource.id,
      allocated: amount,
      remaining: resource.capacity - resource.allocated
    };
  }
  
  /**
   * Deallocate resource
   */
  deallocateResource(resourceId, amount = null) {
    const resource = this.resources.get(resourceId);
    if (!resource) return false;
    
    const deallocateAmount = amount || resource.allocated;
    resource.allocated = Math.max(0, resource.allocated - deallocateAmount);
    
    if (resource.allocated === 0) {
      resource.state = RESOURCE_STATES.AVAILABLE;
    }
    
    return true;
  }
  
  /**
   * Check if resource meets constraints
   */
  meetsConstraints(resource, constraints) {
    for (const [key, value] of Object.entries(constraints)) {
      if (resource.metadata[key] !== value) {
        return false;
      }
    }
    return true;
  }
  
  /**
   * Get pool utilization
   */
  getUtilization() {
    if (this.resources.size === 0) return 0;
    
    const totalCapacity = Array.from(this.resources.values())
      .reduce((sum, r) => sum + r.capacity, 0);
    
    const totalAllocated = Array.from(this.resources.values())
      .reduce((sum, r) => sum + r.allocated, 0);
    
    return totalAllocated / totalCapacity;
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    const resources = Array.from(this.resources.values());
    
    return {
      name: this.name,
      type: this.config.type,
      totalResources: resources.length,
      totalCapacity: resources.reduce((sum, r) => sum + r.capacity, 0),
      totalAllocated: resources.reduce((sum, r) => sum + r.allocated, 0),
      utilization: this.getUtilization(),
      availableResources: resources.filter(r => r.state === RESOURCE_STATES.AVAILABLE).length,
      averageHealth: resources.reduce((sum, r) => sum + r.health, 0) / resources.length || 0
    };
  }
  
  /**
   * Update resource health
   */
  updateResourceHealth(resourceId, health) {
    const resource = this.resources.get(resourceId);
    if (!resource) return false;
    
    resource.health = Math.max(0, Math.min(1, health));
    
    // Update state based on health
    if (resource.health < 0.3) {
      resource.state = RESOURCE_STATES.FAILED;
    } else if (resource.health < 0.6) {
      resource.state = RESOURCE_STATES.DEGRADED;
    } else if (resource.allocated === 0) {
      resource.state = RESOURCE_STATES.AVAILABLE;
    }
    
    return true;
  }
}

/**
 * Auto-scaler
 */
class AutoScaler {
  constructor(config = {}) {
    this.config = {
      policy: config.policy || SCALING_POLICIES.HYBRID,
      evaluationInterval: config.evaluationInterval || 60000, // 1 minute
      scaleUpCooldown: config.scaleUpCooldown || 300000, // 5 minutes
      scaleDownCooldown: config.scaleDownCooldown || 600000, // 10 minutes
      predictiveWindow: config.predictiveWindow || 900000, // 15 minutes
      ...config
    };
    
    this.scalingRules = new Map();
    this.predictions = new Map();
    this.running = false;
  }
  
  /**
   * Add scaling rule
   */
  addScalingRule(poolName, rule) {
    if (!this.scalingRules.has(poolName)) {
      this.scalingRules.set(poolName, []);
    }
    
    const scalingRule = {
      id: crypto.randomBytes(8).toString('hex'),
      name: rule.name,
      metric: rule.metric,
      threshold: rule.threshold,
      action: rule.action, // 'scale_up' or 'scale_down'
      amount: rule.amount || 1,
      cooldown: rule.cooldown || this.config.scaleUpCooldown,
      conditions: rule.conditions || {},
      created: Date.now()
    };
    
    this.scalingRules.get(poolName).push(scalingRule);
    
    return scalingRule;
  }
  
  /**
   * Start auto-scaling
   */
  start() {
    if (this.running) return;
    
    this.running = true;
    this.scalingLoop();
    
    logger.info('Auto-scaler started', {
      policy: this.config.policy,
      evaluationInterval: this.config.evaluationInterval
    });
  }
  
  /**
   * Main scaling loop
   */
  async scalingLoop() {
    while (this.running) {
      try {
        await this.evaluateScaling();
        await new Promise(resolve => setTimeout(resolve, this.config.evaluationInterval));
      } catch (error) {
        logger.error('Scaling evaluation error', { error: error.message });
      }
    }
  }
  
  /**
   * Evaluate scaling for all pools
   */
  async evaluateScaling() {
    for (const [poolName, rules] of this.scalingRules) {
      try {
        await this.evaluatePoolScaling(poolName, rules);
      } catch (error) {
        logger.error('Pool scaling evaluation failed', {
          pool: poolName,
          error: error.message
        });
      }
    }
  }
  
  /**
   * Evaluate scaling for specific pool
   */
  async evaluatePoolScaling(poolName, rules) {
    for (const rule of rules) {
      const shouldScale = await this.shouldScale(poolName, rule);
      
      if (shouldScale) {
        await this.executeScaling(poolName, rule);
      }
    }
  }
  
  /**
   * Determine if scaling should occur
   */
  async shouldScale(poolName, rule) {
    // Get current metrics
    const metrics = await this.getPoolMetrics(poolName);
    if (!metrics) return false;
    
    // Check threshold
    const metricValue = metrics[rule.metric];
    if (metricValue === undefined) return false;
    
    // Check scaling direction
    if (rule.action === 'scale_up' && metricValue < rule.threshold) return false;
    if (rule.action === 'scale_down' && metricValue > rule.threshold) return false;
    
    // Check cooldown
    const lastScaling = this.getLastScaling(poolName, rule.action);
    if (lastScaling && Date.now() - lastScaling < rule.cooldown) return false;
    
    // Check conditions
    if (!this.checkConditions(rule.conditions, metrics)) return false;
    
    // Check predictive factors if enabled
    if (this.config.policy === SCALING_POLICIES.PREDICTIVE || 
        this.config.policy === SCALING_POLICIES.HYBRID) {
      const prediction = this.predictions.get(poolName);
      if (prediction && !this.shouldScaleBasedOnPrediction(rule, prediction)) {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Execute scaling action
   */
  async executeScaling(poolName, rule) {
    this.emit('scaling:started', {
      pool: poolName,
      rule: rule.name,
      action: rule.action,
      amount: rule.amount
    });
    
    try {
      const result = await this.performScaling(poolName, rule.action, rule.amount);
      
      // Record scaling action
      this.recordScaling(poolName, rule, result);
      
      this.emit('scaling:completed', {
        pool: poolName,
        rule: rule.name,
        action: rule.action,
        result
      });
      
      logger.info('Scaling completed', {
        pool: poolName,
        action: rule.action,
        amount: rule.amount,
        success: result.success
      });
      
    } catch (error) {
      this.emit('scaling:failed', {
        pool: poolName,
        rule: rule.name,
        error: error.message
      });
      
      logger.error('Scaling failed', {
        pool: poolName,
        action: rule.action,
        error: error.message
      });
    }
  }
  
  /**
   * Perform actual scaling
   */
  async performScaling(poolName, action, amount) {
    // In production, would interface with container orchestrator or cloud provider
    logger.info('Performing scaling action', {
      pool: poolName,
      action,
      amount
    });
    
    // Simulate scaling operation
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    return {
      success: true,
      action,
      amount,
      timestamp: Date.now()
    };
  }
  
  /**
   * Get pool metrics
   */
  async getPoolMetrics(poolName) {
    // In production, would collect actual metrics
    // Simulating metrics for now
    return {
      utilization: Math.random(),
      requestRate: Math.random() * 1000,
      responseTime: Math.random() * 1000,
      errorRate: Math.random() * 0.1,
      queueLength: Math.floor(Math.random() * 100)
    };
  }
  
  /**
   * Check scaling conditions
   */
  checkConditions(conditions, metrics) {
    for (const [key, value] of Object.entries(conditions)) {
      if (metrics[key] !== value) {
        return false;
      }
    }
    return true;
  }
  
  /**
   * Get last scaling action timestamp
   */
  getLastScaling(poolName, action) {
    // In production, would track scaling history
    return null;
  }
  
  /**
   * Record scaling action
   */
  recordScaling(poolName, rule, result) {
    // In production, would store in database or metrics system
  }
  
  /**
   * Check if should scale based on prediction
   */
  shouldScaleBasedOnPrediction(rule, prediction) {
    // Simple prediction-based logic
    return prediction.confidence > 0.7;
  }
  
  /**
   * Stop auto-scaling
   */
  stop() {
    this.running = false;
    logger.info('Auto-scaler stopped');
  }
}

/**
 * Smart Resource Orchestrator
 */
export class SmartResourceOrchestrator extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Resource management
      defaultPoolSize: config.defaultPoolSize || 10,
      resourceHealthCheckInterval: config.resourceHealthCheckInterval || 60000,
      
      // Auto-scaling
      autoScalingEnabled: config.autoScalingEnabled !== false,
      scalingPolicy: config.scalingPolicy || SCALING_POLICIES.HYBRID,
      
      // Load balancing
      loadBalancingEnabled: config.loadBalancingEnabled !== false,
      loadBalancingAlgorithm: config.loadBalancingAlgorithm || 'weighted_round_robin',
      
      // Optimization
      optimizationEnabled: config.optimizationEnabled !== false,
      optimizationInterval: config.optimizationInterval || 3600000, // 1 hour
      
      // National scale settings
      multiRegionEnabled: config.multiRegionEnabled || false,
      replicationFactor: config.replicationFactor || 3,
      
      ...config
    };
    
    // Components
    this.pools = new Map();
    this.autoScaler = new AutoScaler({
      policy: this.config.scalingPolicy
    });
    
    // State
    this.running = false;
    this.allocations = new Map();
    this.loadBalancers = new Map();
    
    // Statistics
    this.stats = {
      totalAllocations: 0,
      totalDeallocations: 0,
      scalingActions: 0,
      optimizationRuns: 0,
      resourcesManaged: 0
    };
    
    this.logger = logger;
    
    // Setup event handlers
    this.setupEventHandlers();
  }
  
  /**
   * Initialize orchestrator
   */
  async initialize() {
    // Create default resource pools
    await this.createDefaultPools();
    
    this.logger.info('Smart resource orchestrator initialized', {
      pools: this.pools.size,
      autoScaling: this.config.autoScalingEnabled,
      multiRegion: this.config.multiRegionEnabled
    });
  }
  
  /**
   * Start orchestrator
   */
  start() {
    if (this.running) return;
    
    this.running = true;
    
    // Start auto-scaler
    if (this.config.autoScalingEnabled) {
      this.autoScaler.start();
    }
    
    // Start optimization
    if (this.config.optimizationEnabled) {
      this.startOptimization();
    }
    
    // Start health monitoring
    this.startHealthMonitoring();
    
    this.logger.info('Smart resource orchestrator started');
  }
  
  /**
   * Create default resource pools
   */
  async createDefaultPools() {
    // CPU pool
    const cpuPool = this.createPool('cpu_pool', {
      type: RESOURCE_TYPES.CPU,
      minCapacity: 4,
      maxCapacity: 100,
      targetUtilization: 0.7
    });
    
    // Memory pool
    const memoryPool = this.createPool('memory_pool', {
      type: RESOURCE_TYPES.MEMORY,
      minCapacity: 8, // GB
      maxCapacity: 1000,
      targetUtilization: 0.75
    });
    
    // GPU pool for mining
    const gpuPool = this.createPool('gpu_pool', {
      type: RESOURCE_TYPES.GPU,
      minCapacity: 2,
      maxCapacity: 50,
      targetUtilization: 0.9
    });
    
    // Service pool
    const servicePool = this.createPool('service_pool', {
      type: RESOURCE_TYPES.SERVICE,
      minCapacity: 3,
      maxCapacity: 100,
      targetUtilization: 0.8
    });
    
    // Add default resources to pools
    for (let i = 0; i < this.config.defaultPoolSize; i++) {
      cpuPool.addResource(`cpu_${i}`, { capacity: 4 });
      memoryPool.addResource(`mem_${i}`, { capacity: 16 });
      
      if (i < 4) { // Fewer GPUs
        gpuPool.addResource(`gpu_${i}`, { capacity: 1 });
      }
      
      servicePool.addResource(`service_${i}`, { capacity: 10 });
    }
    
    // Setup auto-scaling rules
    this.setupDefaultScalingRules();
  }
  
  /**
   * Create resource pool
   */
  createPool(name, config) {
    const pool = new ResourcePool(name, config);
    this.pools.set(name, pool);
    
    return pool;
  }
  
  /**
   * Setup default scaling rules
   */
  setupDefaultScalingRules() {
    // CPU scaling rules
    this.autoScaler.addScalingRule('cpu_pool', {
      name: 'cpu_scale_up',
      metric: 'utilization',
      threshold: 0.8,
      action: 'scale_up',
      amount: 2
    });
    
    this.autoScaler.addScalingRule('cpu_pool', {
      name: 'cpu_scale_down',
      metric: 'utilization',
      threshold: 0.3,
      action: 'scale_down',
      amount: 1,
      cooldown: 600000 // 10 minutes
    });
    
    // Memory scaling rules
    this.autoScaler.addScalingRule('memory_pool', {
      name: 'memory_scale_up',
      metric: 'utilization',
      threshold: 0.85,
      action: 'scale_up',
      amount: 4 // GB
    });
    
    // Service scaling rules
    this.autoScaler.addScalingRule('service_pool', {
      name: 'service_scale_up',
      metric: 'utilization',
      threshold: 0.75,
      action: 'scale_up',
      amount: 2
    });
  }
  
  /**
   * Allocate resources
   */
  async allocateResources(request) {
    const allocationId = crypto.randomBytes(16).toString('hex');
    
    const allocation = {
      id: allocationId,
      request,
      resources: new Map(),
      status: 'pending',
      createdAt: Date.now()
    };
    
    try {
      // Allocate each requested resource type
      for (const [resourceType, amount] of Object.entries(request.resources)) {
        const poolName = this.getPoolForResourceType(resourceType);
        const pool = this.pools.get(poolName);
        
        if (!pool) {
          throw new Error(`No pool available for resource type: ${resourceType}`);
        }
        
        const resourceAllocation = pool.allocateResource(amount, request.constraints || {});
        
        if (!resourceAllocation) {
          // Try to trigger scaling if auto-scaling is enabled
          if (this.config.autoScalingEnabled) {
            await this.triggerEmergencyScaling(poolName, amount);
            
            // Retry allocation
            const retryAllocation = pool.allocateResource(amount, request.constraints || {});
            if (retryAllocation) {
              allocation.resources.set(resourceType, retryAllocation);
            } else {
              throw new Error(`Insufficient ${resourceType} resources available`);
            }
          } else {
            throw new Error(`Insufficient ${resourceType} resources available`);
          }
        } else {
          allocation.resources.set(resourceType, resourceAllocation);
        }
      }
      
      allocation.status = 'allocated';
      allocation.allocatedAt = Date.now();
      
      this.allocations.set(allocationId, allocation);
      this.stats.totalAllocations++;
      
      this.emit('resource:allocated', allocation);
      
      return allocation;
      
    } catch (error) {
      allocation.status = 'failed';
      allocation.error = error.message;
      
      // Rollback partial allocations
      await this.rollbackAllocation(allocation);
      
      throw error;
    }
  }
  
  /**
   * Deallocate resources
   */
  async deallocateResources(allocationId) {
    const allocation = this.allocations.get(allocationId);
    if (!allocation) {
      throw new Error('Allocation not found');
    }
    
    try {
      // Deallocate each resource
      for (const [resourceType, resourceAllocation] of allocation.resources) {
        const poolName = this.getPoolForResourceType(resourceType);
        const pool = this.pools.get(poolName);
        
        if (pool) {
          pool.deallocateResource(resourceAllocation.resourceId, resourceAllocation.allocated);
        }
      }
      
      allocation.status = 'deallocated';
      allocation.deallocatedAt = Date.now();
      
      this.allocations.delete(allocationId);
      this.stats.totalDeallocations++;
      
      this.emit('resource:deallocated', allocation);
      
      return true;
      
    } catch (error) {
      this.logger.error('Deallocation failed', {
        allocationId,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Get pool for resource type
   */
  getPoolForResourceType(resourceType) {
    const poolMap = {
      [RESOURCE_TYPES.CPU]: 'cpu_pool',
      [RESOURCE_TYPES.MEMORY]: 'memory_pool',
      [RESOURCE_TYPES.GPU]: 'gpu_pool',
      [RESOURCE_TYPES.SERVICE]: 'service_pool'
    };
    
    return poolMap[resourceType] || `${resourceType}_pool`;
  }
  
  /**
   * Trigger emergency scaling
   */
  async triggerEmergencyScaling(poolName, requiredAmount) {
    logger.warn('Triggering emergency scaling', {
      pool: poolName,
      requiredAmount
    });
    
    await this.autoScaler.executeScaling(poolName, {
      action: 'scale_up',
      amount: Math.max(requiredAmount, 2)
    });
    
    this.stats.scalingActions++;
  }
  
  /**
   * Rollback allocation
   */
  async rollbackAllocation(allocation) {
    for (const [resourceType, resourceAllocation] of allocation.resources) {
      const poolName = this.getPoolForResourceType(resourceType);
      const pool = this.pools.get(poolName);
      
      if (pool) {
        pool.deallocateResource(resourceAllocation.resourceId, resourceAllocation.allocated);
      }
    }
  }
  
  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    this.autoScaler.on('scaling:completed', (event) => {
      this.stats.scalingActions++;
      this.emit('orchestrator:scaled', event);
    });
  }
  
  /**
   * Start optimization
   */
  startOptimization() {
    this.optimizationTimer = setInterval(() => {
      this.runOptimization();
    }, this.config.optimizationInterval);
  }
  
  /**
   * Run resource optimization
   */
  async runOptimization() {
    try {
      this.stats.optimizationRuns++;
      
      // Optimize each pool
      for (const [name, pool] of this.pools) {
        await this.optimizePool(name, pool);
      }
      
      this.emit('orchestrator:optimized', {
        timestamp: Date.now(),
        pools: this.pools.size
      });
      
    } catch (error) {
      this.logger.error('Optimization failed', { error: error.message });
    }
  }
  
  /**
   * Optimize specific pool
   */
  async optimizePool(name, pool) {
    const stats = pool.getStats();
    
    // Identify underutilized resources
    const underutilized = Array.from(pool.resources.values())
      .filter(r => r.allocated / r.capacity < 0.1 && r.state === RESOURCE_STATES.AVAILABLE);
    
    // Remove excess resources if safe to do so
    if (underutilized.length > pool.config.minCapacity) {
      const toRemove = underutilized.slice(0, underutilized.length - pool.config.minCapacity);
      
      for (const resource of toRemove) {
        if (pool.removeResource(resource.id)) {
          this.logger.info('Removed underutilized resource', {
            pool: name,
            resource: resource.id
          });
        }
      }
    }
  }
  
  /**
   * Start health monitoring
   */
  startHealthMonitoring() {
    this.healthTimer = setInterval(() => {
      this.checkResourceHealth();
    }, this.config.resourceHealthCheckInterval);
  }
  
  /**
   * Check resource health
   */
  async checkResourceHealth() {
    for (const [poolName, pool] of this.pools) {
      for (const [resourceId, resource] of pool.resources) {
        // Simulate health check
        const health = Math.random();
        pool.updateResourceHealth(resourceId, health);
        
        if (health < 0.3) {
          this.emit('resource:unhealthy', {
            pool: poolName,
            resource: resourceId,
            health
          });
        }
      }
    }
  }
  
  /**
   * Get orchestrator statistics
   */
  getStats() {
    const poolStats = {};
    for (const [name, pool] of this.pools) {
      poolStats[name] = pool.getStats();
    }
    
    return {
      ...this.stats,
      pools: poolStats,
      activeAllocations: this.allocations.size,
      running: this.running
    };
  }
  
  /**
   * Stop orchestrator
   */
  stop() {
    this.running = false;
    
    this.autoScaler.stop();
    
    if (this.optimizationTimer) {
      clearInterval(this.optimizationTimer);
    }
    
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
    }
    
    this.logger.info('Smart resource orchestrator stopped');
  }
}

// Export constants
export {
  RESOURCE_TYPES,
  SCALING_POLICIES,
  RESOURCE_STATES
};

export default SmartResourceOrchestrator;