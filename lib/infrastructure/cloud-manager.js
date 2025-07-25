/**
 * Cloud Infrastructure Management for Otedama
 * Auto-scaling and multi-region deployment
 * 
 * Design:
 * - Carmack: Efficient resource utilization
 * - Martin: Clean infrastructure abstractions
 * - Pike: Simple but powerful cloud management
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { PerformanceMonitor } from '../monitoring/performance-monitor.js';

// Infrastructure constants
const REGIONS = {
  'us-east-1': { name: 'US East (Virginia)', primary: true },
  'us-west-2': { name: 'US West (Oregon)' },
  'eu-west-1': { name: 'EU (Ireland)' },
  'ap-northeast-1': { name: 'Asia Pacific (Tokyo)' },
  'ap-southeast-1': { name: 'Asia Pacific (Singapore)' }
};

const INSTANCE_TYPES = {
  SMALL: { cpu: 2, memory: 4, network: 'moderate' },
  MEDIUM: { cpu: 4, memory: 8, network: 'high' },
  LARGE: { cpu: 8, memory: 16, network: 'high' },
  XLARGE: { cpu: 16, memory: 32, network: 'very-high' },
  COMPUTE_OPTIMIZED: { cpu: 32, memory: 64, network: 'very-high' }
};

/**
 * Auto-scaling manager
 */
class AutoScaler {
  constructor(options = {}) {
    this.options = {
      minInstances: options.minInstances || 2,
      maxInstances: options.maxInstances || 100,
      targetCPU: options.targetCPU || 70,
      targetMemory: options.targetMemory || 80,
      scaleUpThreshold: options.scaleUpThreshold || 5, // minutes
      scaleDownThreshold: options.scaleDownThreshold || 10,
      cooldownPeriod: options.cooldownPeriod || 300000, // 5 minutes
      ...options
    };
    
    this.instances = new Map();
    this.metrics = new Map();
    this.lastScaleAction = 0;
    
    this.logger = createStructuredLogger('AutoScaler');
  }
  
  /**
   * Update instance metrics
   */
  updateMetrics(instanceId, metrics) {
    this.metrics.set(instanceId, {
      ...metrics,
      timestamp: Date.now()
    });
  }
  
  /**
   * Calculate scaling decision
   */
  calculateScaling() {
    const now = Date.now();
    
    // Check cooldown period
    if (now - this.lastScaleAction < this.options.cooldownPeriod) {
      return { action: 'NONE', reason: 'cooldown' };
    }
    
    // Calculate average metrics
    const activeInstances = Array.from(this.instances.values())
      .filter(i => i.status === 'RUNNING');
    
    if (activeInstances.length === 0) {
      return { action: 'SCALE_UP', count: this.options.minInstances };
    }
    
    let totalCPU = 0;
    let totalMemory = 0;
    let metricCount = 0;
    
    for (const instance of activeInstances) {
      const metrics = this.metrics.get(instance.id);
      if (metrics && now - metrics.timestamp < 300000) { // 5 minutes
        totalCPU += metrics.cpu;
        totalMemory += metrics.memory;
        metricCount++;
      }
    }
    
    if (metricCount === 0) {
      return { action: 'NONE', reason: 'no_metrics' };
    }
    
    const avgCPU = totalCPU / metricCount;
    const avgMemory = totalMemory / metricCount;
    
    // Scale up conditions
    if (avgCPU > this.options.targetCPU || avgMemory > this.options.targetMemory) {
      const currentCount = activeInstances.length;
      
      if (currentCount < this.options.maxInstances) {
        // Calculate how many instances to add
        const cpuScale = avgCPU / this.options.targetCPU;
        const memScale = avgMemory / this.options.targetMemory;
        const scaleFactor = Math.max(cpuScale, memScale);
        
        const targetCount = Math.ceil(currentCount * scaleFactor);
        const toAdd = Math.min(
          targetCount - currentCount,
          this.options.maxInstances - currentCount
        );
        
        return {
          action: 'SCALE_UP',
          count: toAdd,
          reason: `CPU: ${avgCPU.toFixed(1)}%, Memory: ${avgMemory.toFixed(1)}%`
        };
      }
    }
    
    // Scale down conditions
    if (avgCPU < this.options.targetCPU * 0.5 && 
        avgMemory < this.options.targetMemory * 0.5) {
      const currentCount = activeInstances.length;
      
      if (currentCount > this.options.minInstances) {
        // Calculate how many instances to remove
        const toRemove = Math.floor(currentCount * 0.2); // Remove 20%
        const finalCount = Math.max(
          this.options.minInstances,
          currentCount - toRemove
        );
        
        return {
          action: 'SCALE_DOWN',
          count: currentCount - finalCount,
          reason: `CPU: ${avgCPU.toFixed(1)}%, Memory: ${avgMemory.toFixed(1)}%`
        };
      }
    }
    
    return { action: 'NONE', reason: 'within_targets' };
  }
  
  /**
   * Execute scaling action
   */
  async executeScaling(decision) {
    if (decision.action === 'NONE') return;
    
    this.lastScaleAction = Date.now();
    
    this.logger.info('Executing scaling action', decision);
    
    switch (decision.action) {
      case 'SCALE_UP':
        return await this.scaleUp(decision.count);
        
      case 'SCALE_DOWN':
        return await this.scaleDown(decision.count);
    }
  }
  
  /**
   * Scale up instances
   */
  async scaleUp(count) {
    const instances = [];
    
    for (let i = 0; i < count; i++) {
      const instance = {
        id: `i-${Date.now()}-${i}`,
        type: this.selectInstanceType(),
        status: 'LAUNCHING',
        launchedAt: Date.now()
      };
      
      this.instances.set(instance.id, instance);
      instances.push(instance);
    }
    
    return instances;
  }
  
  /**
   * Scale down instances
   */
  async scaleDown(count) {
    // Select instances to terminate (oldest first)
    const candidates = Array.from(this.instances.values())
      .filter(i => i.status === 'RUNNING')
      .sort((a, b) => a.launchedAt - b.launchedAt)
      .slice(0, count);
    
    for (const instance of candidates) {
      instance.status = 'TERMINATING';
    }
    
    return candidates.map(i => i.id);
  }
  
  /**
   * Select appropriate instance type
   */
  selectInstanceType() {
    const activeInstances = Array.from(this.instances.values())
      .filter(i => i.status === 'RUNNING');
    
    // Start with medium instances
    if (activeInstances.length === 0) {
      return 'MEDIUM';
    }
    
    // Check average load
    let totalLoad = 0;
    let count = 0;
    
    for (const instance of activeInstances) {
      const metrics = this.metrics.get(instance.id);
      if (metrics) {
        totalLoad += (metrics.cpu + metrics.memory) / 2;
        count++;
      }
    }
    
    const avgLoad = count > 0 ? totalLoad / count : 50;
    
    if (avgLoad > 80) return 'COMPUTE_OPTIMIZED';
    if (avgLoad > 60) return 'XLARGE';
    if (avgLoad > 40) return 'LARGE';
    if (avgLoad > 20) return 'MEDIUM';
    return 'SMALL';
  }
}

/**
 * Load balancer manager
 */
class LoadBalancer {
  constructor(options = {}) {
    this.options = {
      algorithm: options.algorithm || 'ROUND_ROBIN',
      healthCheckInterval: options.healthCheckInterval || 30000,
      healthCheckTimeout: options.healthCheckTimeout || 5000,
      unhealthyThreshold: options.unhealthyThreshold || 3,
      ...options
    };
    
    this.backends = new Map();
    this.healthChecks = new Map();
    this.currentIndex = 0;
    
    this.logger = createStructuredLogger('LoadBalancer');
  }
  
  /**
   * Add backend
   */
  addBackend(id, endpoint) {
    this.backends.set(id, {
      id,
      endpoint,
      healthy: true,
      weight: 1,
      connections: 0,
      requestCount: 0,
      errorCount: 0
    });
    
    this.healthChecks.set(id, {
      consecutiveFailures: 0,
      lastCheck: 0
    });
  }
  
  /**
   * Remove backend
   */
  removeBackend(id) {
    this.backends.delete(id);
    this.healthChecks.delete(id);
  }
  
  /**
   * Get next backend
   */
  getNextBackend() {
    const healthyBackends = Array.from(this.backends.values())
      .filter(b => b.healthy);
    
    if (healthyBackends.length === 0) {
      throw new Error('No healthy backends available');
    }
    
    switch (this.options.algorithm) {
      case 'ROUND_ROBIN':
        return this.roundRobin(healthyBackends);
        
      case 'LEAST_CONNECTIONS':
        return this.leastConnections(healthyBackends);
        
      case 'WEIGHTED':
        return this.weighted(healthyBackends);
        
      case 'IP_HASH':
        return this.ipHash(healthyBackends);
        
      default:
        return this.roundRobin(healthyBackends);
    }
  }
  
  /**
   * Round robin algorithm
   */
  roundRobin(backends) {
    const backend = backends[this.currentIndex % backends.length];
    this.currentIndex++;
    return backend;
  }
  
  /**
   * Least connections algorithm
   */
  leastConnections(backends) {
    return backends.reduce((min, backend) => 
      backend.connections < min.connections ? backend : min
    );
  }
  
  /**
   * Weighted round robin
   */
  weighted(backends) {
    const totalWeight = backends.reduce((sum, b) => sum + b.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const backend of backends) {
      random -= backend.weight;
      if (random <= 0) {
        return backend;
      }
    }
    
    return backends[0];
  }
  
  /**
   * IP hash algorithm
   */
  ipHash(backends, ip = '') {
    const hash = ip.split('').reduce((acc, char) => {
      return ((acc << 5) - acc) + char.charCodeAt(0);
    }, 0);
    
    return backends[Math.abs(hash) % backends.length];
  }
  
  /**
   * Health check
   */
  async performHealthCheck(backend) {
    try {
      const start = Date.now();
      
      // Simulate health check (in production, make actual HTTP request)
      const response = await this.checkEndpoint(backend.endpoint);
      
      const duration = Date.now() - start;
      
      if (response.status === 200 && duration < this.options.healthCheckTimeout) {
        // Healthy
        const health = this.healthChecks.get(backend.id);
        health.consecutiveFailures = 0;
        health.lastCheck = Date.now();
        
        if (!backend.healthy) {
          backend.healthy = true;
          this.logger.info('Backend recovered', { id: backend.id });
        }
      } else {
        throw new Error(`Health check failed: ${response.status}`);
      }
      
    } catch (error) {
      const health = this.healthChecks.get(backend.id);
      health.consecutiveFailures++;
      health.lastCheck = Date.now();
      
      if (health.consecutiveFailures >= this.options.unhealthyThreshold) {
        if (backend.healthy) {
          backend.healthy = false;
          this.logger.warn('Backend marked unhealthy', {
            id: backend.id,
            failures: health.consecutiveFailures
          });
        }
      }
    }
  }
  
  /**
   * Check endpoint (stub)
   */
  async checkEndpoint(endpoint) {
    // In production, make actual HTTP request
    return { status: 200 };
  }
}

/**
 * Infrastructure manager
 */
export class InfrastructureManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      provider: options.provider || 'AWS',
      regions: options.regions || ['us-east-1'],
      instanceType: options.instanceType || 'MEDIUM',
      enableAutoScaling: options.enableAutoScaling !== false,
      enableLoadBalancing: options.enableLoadBalancing !== false,
      ...options
    };
    
    // Components
    this.autoScaler = new AutoScaler(options.autoScaling);
    this.loadBalancer = new LoadBalancer(options.loadBalancing);
    this.performance = new PerformanceMonitor({
      prometheusPrefix: 'infrastructure'
    });
    
    // State
    this.regions = new Map();
    this.instances = new Map();
    this.deployments = new Map();
    
    this.logger = createStructuredLogger('InfrastructureManager');
    
    // Initialize regions
    this.initializeRegions();
  }
  
  /**
   * Initialize regions
   */
  initializeRegions() {
    for (const region of this.options.regions) {
      if (REGIONS[region]) {
        this.regions.set(region, {
          ...REGIONS[region],
          instances: new Set(),
          status: 'ACTIVE'
        });
      }
    }
  }
  
  /**
   * Deploy instance
   */
  async deployInstance(region, type = null) {
    const operationId = this.performance.startOperation('deploy_instance');
    
    try {
      const instanceType = type || this.options.instanceType;
      const specs = INSTANCE_TYPES[instanceType];
      
      if (!specs) {
        throw new Error(`Unknown instance type: ${instanceType}`);
      }
      
      const instance = {
        id: `i-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        region,
        type: instanceType,
        specs,
        status: 'LAUNCHING',
        privateIP: this.generatePrivateIP(),
        publicIP: this.generatePublicIP(),
        launchedAt: Date.now()
      };
      
      // Add to tracking
      this.instances.set(instance.id, instance);
      
      const regionData = this.regions.get(region);
      if (regionData) {
        regionData.instances.add(instance.id);
      }
      
      // Add to auto-scaler
      if (this.options.enableAutoScaling) {
        this.autoScaler.instances.set(instance.id, instance);
      }
      
      // Simulate launch time
      setTimeout(() => {
        instance.status = 'RUNNING';
        
        // Add to load balancer
        if (this.options.enableLoadBalancing) {
          this.loadBalancer.addBackend(
            instance.id,
            `http://${instance.privateIP}:8080`
          );
        }
        
        this.emit('instance:ready', instance);
      }, 30000); // 30 seconds
      
      this.performance.endOperation(operationId, { success: true });
      
      this.logger.info('Instance deployed', {
        id: instance.id,
        region,
        type: instanceType
      });
      
      return instance;
      
    } catch (error) {
      this.performance.endOperation(operationId, { 
        success: false, 
        error: error.message 
      });
      throw error;
    }
  }
  
  /**
   * Terminate instance
   */
  async terminateInstance(instanceId) {
    const instance = this.instances.get(instanceId);
    
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }
    
    instance.status = 'TERMINATING';
    
    // Remove from load balancer
    if (this.options.enableLoadBalancing) {
      this.loadBalancer.removeBackend(instanceId);
    }
    
    // Remove from region
    const regionData = this.regions.get(instance.region);
    if (regionData) {
      regionData.instances.delete(instanceId);
    }
    
    // Clean up after termination
    setTimeout(() => {
      this.instances.delete(instanceId);
      this.autoScaler.instances.delete(instanceId);
      
      this.emit('instance:terminated', { id: instanceId });
    }, 10000); // 10 seconds
    
    this.logger.info('Instance terminated', { id: instanceId });
  }
  
  /**
   * Deploy application
   */
  async deployApplication(config) {
    const deploymentId = `deploy-${Date.now()}`;
    
    const deployment = {
      id: deploymentId,
      name: config.name,
      version: config.version,
      instances: [],
      status: 'DEPLOYING',
      startedAt: Date.now()
    };
    
    this.deployments.set(deploymentId, deployment);
    
    try {
      // Deploy to each region
      for (const region of this.options.regions) {
        const regionInstances = await this.deployToRegion(
          region,
          config
        );
        
        deployment.instances.push(...regionInstances);
      }
      
      deployment.status = 'DEPLOYED';
      deployment.completedAt = Date.now();
      
      this.emit('deployment:completed', deployment);
      
      return deployment;
      
    } catch (error) {
      deployment.status = 'FAILED';
      deployment.error = error.message;
      
      this.emit('deployment:failed', deployment);
      throw error;
    }
  }
  
  /**
   * Deploy to specific region
   */
  async deployToRegion(region, config) {
    const instances = [];
    const count = config.instancesPerRegion || 2;
    
    for (let i = 0; i < count; i++) {
      const instance = await this.deployInstance(
        region,
        config.instanceType
      );
      
      instances.push(instance);
    }
    
    return instances;
  }
  
  /**
   * Monitor infrastructure
   */
  async monitorInfrastructure() {
    const report = {
      regions: {},
      instances: {
        total: this.instances.size,
        byStatus: {},
        byType: {}
      },
      loadBalancer: {
        backends: this.loadBalancer.backends.size,
        healthy: 0,
        unhealthy: 0
      }
    };
    
    // Count instances by status and type
    for (const instance of this.instances.values()) {
      report.instances.byStatus[instance.status] = 
        (report.instances.byStatus[instance.status] || 0) + 1;
      
      report.instances.byType[instance.type] = 
        (report.instances.byType[instance.type] || 0) + 1;
    }
    
    // Region statistics
    for (const [region, data] of this.regions) {
      report.regions[region] = {
        status: data.status,
        instances: data.instances.size
      };
    }
    
    // Load balancer statistics
    for (const backend of this.loadBalancer.backends.values()) {
      if (backend.healthy) {
        report.loadBalancer.healthy++;
      } else {
        report.loadBalancer.unhealthy++;
      }
    }
    
    // Auto-scaling decision
    if (this.options.enableAutoScaling) {
      const scalingDecision = this.autoScaler.calculateScaling();
      report.autoScaling = scalingDecision;
      
      // Execute scaling if needed
      if (scalingDecision.action !== 'NONE') {
        await this.autoScaler.executeScaling(scalingDecision);
      }
    }
    
    this.emit('infrastructure:report', report);
    
    return report;
  }
  
  /**
   * Update instance metrics
   */
  updateInstanceMetrics(instanceId, metrics) {
    if (this.options.enableAutoScaling) {
      this.autoScaler.updateMetrics(instanceId, metrics);
    }
    
    const instance = this.instances.get(instanceId);
    if (instance) {
      instance.metrics = metrics;
    }
  }
  
  /**
   * Failover to secondary region
   */
  async failover(fromRegion, toRegion) {
    this.logger.warn('Initiating failover', { from: fromRegion, to: toRegion });
    
    // Mark source region as failed
    const sourceRegion = this.regions.get(fromRegion);
    if (sourceRegion) {
      sourceRegion.status = 'FAILED';
    }
    
    // Get instances from failed region
    const failedInstances = Array.from(this.instances.values())
      .filter(i => i.region === fromRegion && i.status === 'RUNNING');
    
    // Deploy replacement instances in target region
    const replacements = [];
    
    for (const failed of failedInstances) {
      const replacement = await this.deployInstance(
        toRegion,
        failed.type
      );
      
      replacements.push(replacement);
      
      // Terminate failed instance
      await this.terminateInstance(failed.id);
    }
    
    this.emit('failover:completed', {
      from: fromRegion,
      to: toRegion,
      instances: replacements.length
    });
    
    return replacements;
  }
  
  /**
   * Generate private IP
   */
  generatePrivateIP() {
    return `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
  }
  
  /**
   * Generate public IP
   */
  generatePublicIP() {
    return `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
  }
  
  /**
   * Get infrastructure costs
   */
  calculateCosts() {
    const hourlyCosts = {
      SMALL: 0.02,
      MEDIUM: 0.04,
      LARGE: 0.08,
      XLARGE: 0.16,
      COMPUTE_OPTIMIZED: 0.32
    };
    
    let totalHourlyCost = 0;
    
    for (const instance of this.instances.values()) {
      if (instance.status === 'RUNNING') {
        totalHourlyCost += hourlyCosts[instance.type] || 0;
      }
    }
    
    return {
      hourly: totalHourlyCost,
      daily: totalHourlyCost * 24,
      monthly: totalHourlyCost * 24 * 30,
      instances: this.instances.size
    };
  }
  
  /**
   * Shutdown infrastructure
   */
  async shutdown() {
    this.logger.info('Shutting down infrastructure');
    
    // Terminate all instances
    const instances = Array.from(this.instances.keys());
    
    for (const instanceId of instances) {
      await this.terminateInstance(instanceId);
    }
    
    this.performance.stop();
    this.removeAllListeners();
  }
}

// Export components
export {
  AutoScaler,
  LoadBalancer,
  REGIONS,
  INSTANCE_TYPES
};

export default InfrastructureManager;