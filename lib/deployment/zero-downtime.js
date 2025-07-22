/**
 * Zero-Downtime Deployment System for Otedama
 * Blue-green deployment with automatic rollback
 * 
 * Design principles:
 * - Carmack: Fast deployment with minimal overhead
 * - Martin: Clean deployment architecture
 * - Pike: Simple deployment process
 */

import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { createServer } from 'http';
import httpProxy from 'http-proxy';
import { getLogger } from '../core/logger.js';
import { HealthChecker } from '../health/health-checker.js';

const logger = getLogger('ZeroDowntime');

/**
 * Deployment strategies
 */
export const DeploymentStrategy = {
  BLUE_GREEN: 'blue_green',
  CANARY: 'canary',
  ROLLING: 'rolling',
  RECREATE: 'recreate'
};

/**
 * Deployment states
 */
export const DeploymentState = {
  IDLE: 'idle',
  PREPARING: 'preparing',
  DEPLOYING: 'deploying',
  TESTING: 'testing',
  SWITCHING: 'switching',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  ROLLING_BACK: 'rolling_back',
  FAILED: 'failed'
};

/**
 * Service instance
 */
class ServiceInstance {
  constructor(id, config) {
    this.id = id;
    this.config = config;
    this.process = null;
    this.port = config.port;
    this.healthUrl = `http://localhost:${this.port}${config.healthPath || '/health'}`;
    this.startTime = null;
    this.healthy = false;
    this.metrics = {
      requests: 0,
      errors: 0,
      responseTime: []
    };
  }
  
  async start() {
    return new Promise((resolve, reject) => {
      logger.info(`Starting service instance ${this.id} on port ${this.port}`);
      
      this.process = spawn(this.config.command, this.config.args || [], {
        env: {
          ...process.env,
          ...this.config.env,
          PORT: this.port,
          INSTANCE_ID: this.id
        },
        cwd: this.config.cwd || process.cwd()
      });
      
      this.startTime = Date.now();
      
      this.process.stdout.on('data', (data) => {
        logger.debug(`[${this.id}] ${data}`);
      });
      
      this.process.stderr.on('data', (data) => {
        logger.error(`[${this.id}] ${data}`);
      });
      
      this.process.on('error', (error) => {
        reject(error);
      });
      
      this.process.on('exit', (code) => {
        logger.info(`Service instance ${this.id} exited with code ${code}`);
        this.healthy = false;
      });
      
      // Wait for process to be ready
      setTimeout(() => resolve(), 2000);
    });
  }
  
  async stop() {
    if (!this.process) return;
    
    logger.info(`Stopping service instance ${this.id}`);
    
    return new Promise((resolve) => {
      this.process.on('exit', () => resolve());
      this.process.kill('SIGTERM');
      
      // Force kill after timeout
      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
        }
      }, 30000);
    });
  }
  
  async checkHealth() {
    try {
      const response = await fetch(this.healthUrl);
      this.healthy = response.ok;
      return this.healthy;
    } catch (error) {
      this.healthy = false;
      return false;
    }
  }
}

/**
 * Zero-downtime deployment system
 */
export class ZeroDowntimeDeployment extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Load balancer configuration
      loadBalancerPort: options.loadBalancerPort || 80,
      
      // Service configuration
      serviceConfig: options.serviceConfig || {
        command: 'node',
        args: ['./server.js'],
        healthPath: '/health',
        ports: {
          blue: 3001,
          green: 3002
        }
      },
      
      // Deployment strategy
      strategy: options.strategy || DeploymentStrategy.BLUE_GREEN,
      
      // Health check configuration
      healthCheck: {
        interval: options.healthCheck?.interval || 5000,
        timeout: options.healthCheck?.timeout || 30000,
        retries: options.healthCheck?.retries || 3,
        successThreshold: options.healthCheck?.successThreshold || 3
      },
      
      // Canary deployment settings
      canary: {
        percentage: options.canary?.percentage || 10,
        duration: options.canary?.duration || 300000, // 5 minutes
        errorThreshold: options.canary?.errorThreshold || 5
      },
      
      // Rolling deployment settings
      rolling: {
        batchSize: options.rolling?.batchSize || 1,
        pauseBetweenBatches: options.rolling?.pauseBetweenBatches || 30000
      },
      
      // Verification
      verification: {
        enabled: options.verification?.enabled !== false,
        duration: options.verification?.duration || 60000,
        tests: options.verification?.tests || []
      },
      
      // Rollback
      rollback: {
        automatic: options.rollback?.automatic !== false,
        errorThreshold: options.rollback?.errorThreshold || 10,
        responseTimeThreshold: options.rollback?.responseTimeThreshold || 5000
      },
      
      ...options
    };
    
    // State
    this.state = DeploymentState.IDLE;
    this.currentEnvironment = 'blue';
    this.instances = new Map();
    this.proxy = null;
    this.loadBalancer = null;
    this.healthChecker = null;
    
    // Metrics
    this.metrics = {
      deployments: 0,
      successful: 0,
      failed: 0,
      rollbacks: 0,
      averageDeploymentTime: 0
    };
  }
  
  /**
   * Initialize deployment system
   */
  async initialize() {
    logger.info('Initializing zero-downtime deployment system');
    
    // Create health checker
    this.healthChecker = new HealthChecker({
      interval: this.options.healthCheck.interval
    });
    
    // Create proxy
    this.proxy = httpProxy.createProxyServer({
      changeOrigin: true,
      ws: true
    });
    
    this.proxy.on('error', (err, req, res) => {
      logger.error('Proxy error:', err);
      res.writeHead(502);
      res.end('Bad Gateway');
    });
    
    // Create load balancer
    await this._createLoadBalancer();
    
    // Start initial environment
    await this._startEnvironment(this.currentEnvironment);
    
    this.emit('initialized');
  }
  
  /**
   * Deploy new version
   */
  async deploy(version, config = {}) {
    if (this.state !== DeploymentState.IDLE) {
      throw new Error(`Cannot deploy while in state: ${this.state}`);
    }
    
    const deploymentId = `deploy-${Date.now()}`;
    const startTime = Date.now();
    
    logger.info(`Starting deployment ${deploymentId} with version ${version}`);
    
    this.state = DeploymentState.PREPARING;
    this.emit('deployment:started', { deploymentId, version });
    
    try {
      // Execute deployment based on strategy
      switch (this.options.strategy) {
        case DeploymentStrategy.BLUE_GREEN:
          await this._deployBlueGreen(version, config);
          break;
          
        case DeploymentStrategy.CANARY:
          await this._deployCanary(version, config);
          break;
          
        case DeploymentStrategy.ROLLING:
          await this._deployRolling(version, config);
          break;
          
        case DeploymentStrategy.RECREATE:
          await this._deployRecreate(version, config);
          break;
          
        default:
          throw new Error(`Unknown deployment strategy: ${this.options.strategy}`);
      }
      
      // Update metrics
      const deploymentTime = Date.now() - startTime;
      this.metrics.deployments++;
      this.metrics.successful++;
      this.metrics.averageDeploymentTime = 
        (this.metrics.averageDeploymentTime * (this.metrics.deployments - 1) + deploymentTime) / 
        this.metrics.deployments;
      
      this.state = DeploymentState.COMPLETED;
      
      this.emit('deployment:completed', {
        deploymentId,
        version,
        duration: deploymentTime
      });
      
      logger.info(`Deployment ${deploymentId} completed successfully`);
      
    } catch (error) {
      this.state = DeploymentState.FAILED;
      this.metrics.failed++;
      
      logger.error(`Deployment ${deploymentId} failed:`, error);
      
      this.emit('deployment:failed', {
        deploymentId,
        version,
        error: error.message
      });
      
      // Automatic rollback
      if (this.options.rollback.automatic) {
        await this.rollback();
      }
      
      throw error;
    } finally {
      this.state = DeploymentState.IDLE;
    }
  }
  
  /**
   * Blue-Green deployment
   */
  async _deployBlueGreen(version, config) {
    const targetEnvironment = this.currentEnvironment === 'blue' ? 'green' : 'blue';
    
    logger.info(`Deploying to ${targetEnvironment} environment`);
    
    // Stop old target environment if exists
    await this._stopEnvironment(targetEnvironment);
    
    // Start new environment
    this.state = DeploymentState.DEPLOYING;
    await this._startEnvironment(targetEnvironment, {
      ...config,
      version
    });
    
    // Health check
    this.state = DeploymentState.TESTING;
    await this._waitForHealthy(targetEnvironment);
    
    // Run verification tests
    if (this.options.verification.enabled) {
      this.state = DeploymentState.VERIFYING;
      await this._runVerificationTests(targetEnvironment);
    }
    
    // Switch traffic
    this.state = DeploymentState.SWITCHING;
    await this._switchTraffic(targetEnvironment);
    
    // Monitor new environment
    await this._monitorEnvironment(targetEnvironment);
    
    // Stop old environment
    await this._stopEnvironment(this.currentEnvironment);
    
    // Update current environment
    this.currentEnvironment = targetEnvironment;
  }
  
  /**
   * Canary deployment
   */
  async _deployCanary(version, config) {
    const canaryId = 'canary';
    
    logger.info(`Starting canary deployment with ${this.options.canary.percentage}% traffic`);
    
    // Start canary instance
    this.state = DeploymentState.DEPLOYING;
    const canaryInstance = await this._startInstance(canaryId, {
      ...config,
      version,
      port: this.options.serviceConfig.ports.canary || 3003
    });
    
    // Health check
    this.state = DeploymentState.TESTING;
    await this._waitForHealthyInstance(canaryInstance);
    
    // Route percentage of traffic to canary
    this.state = DeploymentState.SWITCHING;
    await this._enableCanaryRouting(canaryInstance);
    
    // Monitor canary
    this.state = DeploymentState.VERIFYING;
    const canarySuccess = await this._monitorCanary(canaryInstance);
    
    if (canarySuccess) {
      // Promote canary to production
      logger.info('Canary successful, promoting to production');
      await this._promoteCanary(version, config);
    } else {
      // Remove canary
      logger.info('Canary failed, removing');
      await this._removeCanary(canaryInstance);
      throw new Error('Canary deployment failed');
    }
  }
  
  /**
   * Rolling deployment
   */
  async _deployRolling(version, config) {
    const instances = Array.from(this.instances.values());
    const batches = this._createBatches(instances, this.options.rolling.batchSize);
    
    logger.info(`Starting rolling deployment with ${batches.length} batches`);
    
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      
      logger.info(`Deploying batch ${i + 1}/${batches.length}`);
      
      // Deploy batch
      for (const instance of batch) {
        await this._updateInstance(instance, version, config);
      }
      
      // Wait between batches
      if (i < batches.length - 1) {
        await new Promise(resolve => 
          setTimeout(resolve, this.options.rolling.pauseBetweenBatches)
        );
      }
    }
  }
  
  /**
   * Recreate deployment
   */
  async _deployRecreate(version, config) {
    logger.info('Starting recreate deployment');
    
    // Stop all instances
    this.state = DeploymentState.DEPLOYING;
    await this._stopEnvironment(this.currentEnvironment);
    
    // Start new instances
    await this._startEnvironment(this.currentEnvironment, {
      ...config,
      version
    });
    
    // Health check
    this.state = DeploymentState.TESTING;
    await this._waitForHealthy(this.currentEnvironment);
  }
  
  /**
   * Rollback deployment
   */
  async rollback() {
    if (this.state === DeploymentState.ROLLING_BACK) {
      logger.warn('Rollback already in progress');
      return;
    }
    
    logger.info('Starting rollback');
    
    const previousState = this.state;
    this.state = DeploymentState.ROLLING_BACK;
    
    try {
      // Switch back to previous environment
      const previousEnvironment = this.currentEnvironment === 'blue' ? 'green' : 'blue';
      
      if (this._hasHealthyInstances(previousEnvironment)) {
        await this._switchTraffic(previousEnvironment);
        this.currentEnvironment = previousEnvironment;
        
        logger.info('Rollback completed successfully');
        this.metrics.rollbacks++;
        
        this.emit('rollback:completed');
      } else {
        throw new Error('No healthy instances to rollback to');
      }
      
    } catch (error) {
      logger.error('Rollback failed:', error);
      this.emit('rollback:failed', { error: error.message });
      throw error;
    } finally {
      this.state = DeploymentState.IDLE;
    }
  }
  
  /**
   * Create load balancer
   */
  async _createLoadBalancer() {
    this.loadBalancer = createServer((req, res) => {
      const target = this._selectTarget(req);
      
      if (!target) {
        res.writeHead(503);
        res.end('Service Unavailable');
        return;
      }
      
      // Update metrics
      target.metrics.requests++;
      const startTime = Date.now();
      
      res.on('finish', () => {
        target.metrics.responseTime.push(Date.now() - startTime);
        if (target.metrics.responseTime.length > 100) {
          target.metrics.responseTime.shift();
        }
      });
      
      // Proxy request
      this.proxy.web(req, res, {
        target: `http://localhost:${target.port}`
      });
    });
    
    // WebSocket support
    this.loadBalancer.on('upgrade', (req, socket, head) => {
      const target = this._selectTarget(req);
      
      if (!target) {
        socket.end();
        return;
      }
      
      this.proxy.ws(req, socket, head, {
        target: `ws://localhost:${target.port}`
      });
    });
    
    await new Promise((resolve) => {
      this.loadBalancer.listen(this.options.loadBalancerPort, () => {
        logger.info(`Load balancer listening on port ${this.options.loadBalancerPort}`);
        resolve();
      });
    });
  }
  
  /**
   * Select target instance
   */
  _selectTarget(req) {
    const healthyInstances = Array.from(this.instances.values())
      .filter(instance => instance.healthy);
    
    if (healthyInstances.length === 0) {
      return null;
    }
    
    // Canary routing
    if (this.canaryInstance && Math.random() * 100 < this.options.canary.percentage) {
      return this.canaryInstance;
    }
    
    // Round-robin selection
    const index = (this._requestCount || 0) % healthyInstances.length;
    this._requestCount = (this._requestCount || 0) + 1;
    
    return healthyInstances[index];
  }
  
  /**
   * Start environment
   */
  async _startEnvironment(environment, config = {}) {
    const port = this.options.serviceConfig.ports[environment];
    const instanceId = `${environment}-${Date.now()}`;
    
    const instance = await this._startInstance(instanceId, {
      ...this.options.serviceConfig,
      ...config,
      port,
      environment
    });
    
    return instance;
  }
  
  /**
   * Start instance
   */
  async _startInstance(id, config) {
    const instance = new ServiceInstance(id, config);
    
    await instance.start();
    this.instances.set(id, instance);
    
    this.emit('instance:started', {
      id,
      port: instance.port
    });
    
    return instance;
  }
  
  /**
   * Stop environment
   */
  async _stopEnvironment(environment) {
    const instancesToStop = Array.from(this.instances.entries())
      .filter(([id, instance]) => instance.config.environment === environment);
    
    for (const [id, instance] of instancesToStop) {
      await instance.stop();
      this.instances.delete(id);
      
      this.emit('instance:stopped', { id });
    }
  }
  
  /**
   * Wait for healthy
   */
  async _waitForHealthy(environment) {
    const instances = Array.from(this.instances.values())
      .filter(instance => instance.config.environment === environment);
    
    for (const instance of instances) {
      await this._waitForHealthyInstance(instance);
    }
  }
  
  /**
   * Wait for healthy instance
   */
  async _waitForHealthyInstance(instance) {
    const startTime = Date.now();
    let consecutiveHealthy = 0;
    
    while (Date.now() - startTime < this.options.healthCheck.timeout) {
      const healthy = await instance.checkHealth();
      
      if (healthy) {
        consecutiveHealthy++;
        
        if (consecutiveHealthy >= this.options.healthCheck.successThreshold) {
          logger.info(`Instance ${instance.id} is healthy`);
          return;
        }
      } else {
        consecutiveHealthy = 0;
      }
      
      await new Promise(resolve => 
        setTimeout(resolve, this.options.healthCheck.interval)
      );
    }
    
    throw new Error(`Instance ${instance.id} failed health check`);
  }
  
  /**
   * Run verification tests
   */
  async _runVerificationTests(environment) {
    logger.info(`Running verification tests for ${environment}`);
    
    for (const test of this.options.verification.tests) {
      try {
        await test(environment);
      } catch (error) {
        throw new Error(`Verification test failed: ${error.message}`);
      }
    }
    
    logger.info('All verification tests passed');
  }
  
  /**
   * Switch traffic
   */
  async _switchTraffic(targetEnvironment) {
    logger.info(`Switching traffic to ${targetEnvironment}`);
    
    // In real implementation, update load balancer rules
    // For this example, healthy instances are automatically selected
    
    this.emit('traffic:switched', { target: targetEnvironment });
  }
  
  /**
   * Monitor environment
   */
  async _monitorEnvironment(environment) {
    logger.info(`Monitoring ${environment} environment`);
    
    const startTime = Date.now();
    const instances = Array.from(this.instances.values())
      .filter(instance => instance.config.environment === environment);
    
    while (Date.now() - startTime < this.options.verification.duration) {
      let totalErrors = 0;
      let totalResponseTime = 0;
      let totalRequests = 0;
      
      for (const instance of instances) {
        totalErrors += instance.metrics.errors;
        totalRequests += instance.metrics.requests;
        
        if (instance.metrics.responseTime.length > 0) {
          const avgResponseTime = instance.metrics.responseTime.reduce((a, b) => a + b, 0) / 
                                  instance.metrics.responseTime.length;
          totalResponseTime += avgResponseTime;
        }
      }
      
      // Check error threshold
      const errorRate = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;
      if (errorRate > this.options.rollback.errorThreshold) {
        throw new Error(`Error rate ${errorRate}% exceeds threshold`);
      }
      
      // Check response time threshold
      const avgResponseTime = instances.length > 0 ? totalResponseTime / instances.length : 0;
      if (avgResponseTime > this.options.rollback.responseTimeThreshold) {
        throw new Error(`Response time ${avgResponseTime}ms exceeds threshold`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    logger.info('Environment monitoring completed successfully');
  }
  
  /**
   * Check if environment has healthy instances
   */
  _hasHealthyInstances(environment) {
    return Array.from(this.instances.values()).some(
      instance => instance.config.environment === environment && instance.healthy
    );
  }
  
  /**
   * Create batches for rolling deployment
   */
  _createBatches(items, batchSize) {
    const batches = [];
    
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    
    return batches;
  }
  
  /**
   * Update instance
   */
  async _updateInstance(oldInstance, version, config) {
    const newId = `${oldInstance.id}-new`;
    
    // Start new instance
    const newInstance = await this._startInstance(newId, {
      ...oldInstance.config,
      ...config,
      version
    });
    
    // Wait for healthy
    await this._waitForHealthyInstance(newInstance);
    
    // Stop old instance
    await oldInstance.stop();
    this.instances.delete(oldInstance.id);
  }
  
  /**
   * Canary routing
   */
  async _enableCanaryRouting(canaryInstance) {
    this.canaryInstance = canaryInstance;
    
    this.emit('canary:enabled', {
      id: canaryInstance.id,
      percentage: this.options.canary.percentage
    });
  }
  
  /**
   * Monitor canary
   */
  async _monitorCanary(canaryInstance) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < this.options.canary.duration) {
      const errorRate = canaryInstance.metrics.requests > 0 ?
        (canaryInstance.metrics.errors / canaryInstance.metrics.requests) * 100 : 0;
      
      if (errorRate > this.options.canary.errorThreshold) {
        logger.error(`Canary error rate ${errorRate}% exceeds threshold`);
        return false;
      }
      
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
    
    return true;
  }
  
  /**
   * Promote canary
   */
  async _promoteCanary(version, config) {
    // Deploy to all instances
    await this._deployBlueGreen(version, config);
    
    // Remove canary
    await this._removeCanary(this.canaryInstance);
  }
  
  /**
   * Remove canary
   */
  async _removeCanary(canaryInstance) {
    this.canaryInstance = null;
    
    await canaryInstance.stop();
    this.instances.delete(canaryInstance.id);
    
    this.emit('canary:removed', { id: canaryInstance.id });
  }
  
  /**
   * Get deployment status
   */
  getStatus() {
    return {
      state: this.state,
      currentEnvironment: this.currentEnvironment,
      instances: Array.from(this.instances.entries()).map(([id, instance]) => ({
        id,
        environment: instance.config.environment,
        port: instance.port,
        healthy: instance.healthy,
        uptime: Date.now() - instance.startTime,
        metrics: instance.metrics
      })),
      metrics: this.metrics
    };
  }
  
  /**
   * Shutdown deployment system
   */
  async shutdown() {
    logger.info('Shutting down deployment system');
    
    // Stop all instances
    for (const instance of this.instances.values()) {
      await instance.stop();
    }
    this.instances.clear();
    
    // Stop load balancer
    if (this.loadBalancer) {
      await new Promise(resolve => this.loadBalancer.close(resolve));
    }
    
    this.emit('shutdown');
  }
}

export default ZeroDowntimeDeployment;