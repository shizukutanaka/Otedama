// Zero Downtime Deployment System with Blue-Green and Rolling Updates
import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as net from 'net';
import { createHash } from 'crypto';
import http from 'http';

interface DeploymentConfig {
  strategy: 'blue-green' | 'rolling' | 'canary';
  healthCheckUrl: string;
  healthCheckInterval: number;
  healthCheckTimeout: number;
  warmupTime: number;
  rollbackOnFailure: boolean;
  maxDeploymentTime: number;
  bluePort: number;
  greenPort: number;
  loadBalancerPort: number;
  instanceCount: number;
  canaryPercentage?: number;
}

interface Instance {
  id: string;
  process?: ChildProcess;
  port: number;
  status: 'starting' | 'warming' | 'healthy' | 'unhealthy' | 'stopped';
  startTime: number;
  version: string;
  healthCheckFailures: number;
}

interface DeploymentState {
  id: string;
  status: 'preparing' | 'deploying' | 'validating' | 'completed' | 'failed' | 'rolling-back';
  strategy: string;
  startTime: number;
  currentVersion: string;
  newVersion: string;
  instances: Instance[];
  metrics: DeploymentMetrics;
}

interface DeploymentMetrics {
  totalRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  errorRate: number;
}

export class ZeroDowntimeDeployment extends EventEmitter {
  private config: DeploymentConfig;
  private activeInstances: Map<string, Instance> = new Map();
  private deploymentState?: DeploymentState;
  private loadBalancer?: http.Server;
  private healthCheckTimers: Map<string, NodeJS.Timer> = new Map();
  private currentVersion: string = '';
  private isDeploying: boolean = false;
  
  constructor(config: DeploymentConfig) {
    super();
    this.config = config;
  }
  
  /**
   * Initialize the deployment system
   */
  async initialize(currentVersion: string): Promise<void> {
    this.currentVersion = currentVersion;
    
    // Start load balancer
    await this.startLoadBalancer();
    
    // Start initial instances
    await this.startInitialInstances();
    
    this.emit('initialized', { version: currentVersion });
  }
  
  /**
   * Deploy new version with zero downtime
   */
  async deploy(newVersion: string, deploymentPath: string): Promise<DeploymentState> {
    if (this.isDeploying) {
      throw new Error('Deployment already in progress');
    }
    
    this.isDeploying = true;
    
    // Create deployment state
    this.deploymentState = {
      id: this.generateDeploymentId(),
      status: 'preparing',
      strategy: this.config.strategy,
      startTime: Date.now(),
      currentVersion: this.currentVersion,
      newVersion,
      instances: [],
      metrics: {
        totalRequests: 0,
        failedRequests: 0,
        averageResponseTime: 0,
        errorRate: 0
      }
    };
    
    this.emit('deployment_started', this.deploymentState);
    
    try {
      // Validate new version
      await this.validateDeployment(deploymentPath);
      
      // Execute deployment based on strategy
      switch (this.config.strategy) {
        case 'blue-green':
          await this.deployBlueGreen(newVersion, deploymentPath);
          break;
        case 'rolling':
          await this.deployRolling(newVersion, deploymentPath);
          break;
        case 'canary':
          await this.deployCanary(newVersion, deploymentPath);
          break;
      }
      
      // Validate deployment
      this.deploymentState.status = 'validating';
      await this.validatePostDeployment();
      
      // Complete deployment
      this.deploymentState.status = 'completed';
      this.currentVersion = newVersion;
      
      this.emit('deployment_completed', this.deploymentState);
    } catch (error) {
      this.deploymentState.status = 'failed';
      
      if (this.config.rollbackOnFailure) {
        await this.rollback();
      }
      
      this.emit('deployment_failed', { state: this.deploymentState, error });
      throw error;
    } finally {
      this.isDeploying = false;
    }
    
    return this.deploymentState;
  }
  
  /**
   * Blue-Green deployment strategy
   */
  private async deployBlueGreen(version: string, deploymentPath: string): Promise<void> {
    this.deploymentState!.status = 'deploying';
    
    // Determine which is current (blue or green)
    const currentPort = this.config.bluePort;
    const newPort = this.config.greenPort;
    
    // Start new instances on green
    const newInstances: Instance[] = [];
    for (let i = 0; i < this.config.instanceCount; i++) {
      const instance = await this.startInstance(version, deploymentPath, newPort + i);
      newInstances.push(instance);
      this.deploymentState!.instances.push(instance);
    }
    
    // Warm up new instances
    await this.warmupInstances(newInstances);
    
    // Health check all new instances
    const healthy = await this.healthCheckInstances(newInstances);
    if (!healthy) {
      throw new Error('New instances failed health check');
    }
    
    // Switch load balancer to new instances
    await this.switchLoadBalancer(newInstances);
    
    // Wait for traffic to stabilize
    await this.wait(5000);
    
    // Monitor new instances
    const stable = await this.monitorStability(newInstances, 30000); // 30 seconds
    if (!stable) {
      throw new Error('New instances unstable');
    }
    
    // Stop old instances
    const oldInstances = Array.from(this.activeInstances.values())
      .filter(i => i.version !== version);
    
    await this.stopInstances(oldInstances);
  }
  
  /**
   * Rolling deployment strategy
   */
  private async deployRolling(version: string, deploymentPath: string): Promise<void> {
    this.deploymentState!.status = 'deploying';
    
    const instances = Array.from(this.activeInstances.values());
    const batchSize = Math.ceil(instances.length / 3); // Deploy in 3 batches
    
    for (let i = 0; i < instances.length; i += batchSize) {
      const batch = instances.slice(i, i + batchSize);
      
      // Deploy batch
      for (const oldInstance of batch) {
        // Start new instance
        const newInstance = await this.startInstance(
          version,
          deploymentPath,
          oldInstance.port
        );
        
        this.deploymentState!.instances.push(newInstance);
        
        // Warm up
        await this.warmupInstances([newInstance]);
        
        // Health check
        const healthy = await this.healthCheckInstances([newInstance]);
        if (!healthy) {
          throw new Error(`Instance ${newInstance.id} failed health check`);
        }
        
        // Add to load balancer
        await this.addToLoadBalancer(newInstance);
        
        // Remove old instance from load balancer
        await this.removeFromLoadBalancer(oldInstance);
        
        // Wait for connections to drain
        await this.wait(5000);
        
        // Stop old instance
        await this.stopInstances([oldInstance]);
      }
      
      // Monitor stability after each batch
      const stable = await this.monitorStability(
        this.deploymentState!.instances.filter(i => i.status === 'healthy'),
        10000
      );
      
      if (!stable) {
        throw new Error('Deployment unstable after batch');
      }
    }
  }
  
  /**
   * Canary deployment strategy
   */
  private async deployCanary(version: string, deploymentPath: string): Promise<void> {
    this.deploymentState!.status = 'deploying';
    
    const totalInstances = this.activeInstances.size;
    const canaryCount = Math.max(1, Math.floor(totalInstances * (this.config.canaryPercentage || 10) / 100));
    
    // Deploy canary instances
    const canaryInstances: Instance[] = [];
    for (let i = 0; i < canaryCount; i++) {
      const port = this.config.bluePort + totalInstances + i;
      const instance = await this.startInstance(version, deploymentPath, port);
      canaryInstances.push(instance);
      this.deploymentState!.instances.push(instance);
    }
    
    // Warm up canaries
    await this.warmupInstances(canaryInstances);
    
    // Health check canaries
    const healthy = await this.healthCheckInstances(canaryInstances);
    if (!healthy) {
      throw new Error('Canary instances failed health check');
    }
    
    // Add canaries to load balancer with limited traffic
    for (const canary of canaryInstances) {
      await this.addToLoadBalancer(canary, this.config.canaryPercentage);
    }
    
    // Monitor canary performance
    const canaryMetrics = await this.monitorCanaries(canaryInstances, 60000); // 1 minute
    
    // Compare with baseline
    if (!this.isCanaryHealthy(canaryMetrics)) {
      throw new Error('Canary deployment failed metrics validation');
    }
    
    // Gradually increase traffic to canaries
    for (let percentage = 20; percentage <= 100; percentage += 20) {
      for (const canary of canaryInstances) {
        await this.updateLoadBalancerWeight(canary, percentage);
      }
      
      await this.wait(30000); // Wait 30 seconds
      
      const metrics = await this.monitorCanaries(canaryInstances, 10000);
      if (!this.isCanaryHealthy(metrics)) {
        throw new Error(`Canary failed at ${percentage}% traffic`);
      }
    }
    
    // Full deployment
    await this.deployRolling(version, deploymentPath);
  }
  
  /**
   * Start a new instance
   */
  private async startInstance(version: string, deploymentPath: string, port: number): Promise<Instance> {
    const id = `${version}-${port}-${Date.now()}`;
    
    const instance: Instance = {
      id,
      port,
      status: 'starting',
      startTime: Date.now(),
      version,
      healthCheckFailures: 0
    };
    
    // Start process
    const env = {
      ...process.env,
      PORT: port.toString(),
      INSTANCE_ID: id,
      VERSION: version
    };
    
    instance.process = spawn('node', [path.join(deploymentPath, 'main.js')], {
      env,
      cwd: deploymentPath,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    // Log output
    instance.process.stdout?.on('data', (data) => {
      this.emit('instance_log', { instanceId: id, level: 'info', message: data.toString() });
    });
    
    instance.process.stderr?.on('data', (data) => {
      this.emit('instance_log', { instanceId: id, level: 'error', message: data.toString() });
    });
    
    instance.process.on('exit', (code) => {
      instance.status = 'stopped';
      this.emit('instance_stopped', { instanceId: id, code });
    });
    
    this.activeInstances.set(id, instance);
    
    // Start health checks
    this.startHealthChecks(instance);
    
    return instance;
  }
  
  /**
   * Warm up instances
   */
  private async warmupInstances(instances: Instance[]): Promise<void> {
    this.emit('warmup_started', { count: instances.length });
    
    for (const instance of instances) {
      instance.status = 'warming';
    }
    
    // Wait for warmup period
    await this.wait(this.config.warmupTime);
    
    // Send test requests
    const warmupPromises = instances.map(async (instance) => {
      for (let i = 0; i < 10; i++) {
        try {
          await this.sendRequest(instance.port, '/health');
        } catch {
          // Ignore warmup errors
        }
        await this.wait(100);
      }
    });
    
    await Promise.all(warmupPromises);
    
    this.emit('warmup_completed');
  }
  
  /**
   * Health check instances
   */
  private async healthCheckInstances(instances: Instance[]): Promise<boolean> {
    const checks = await Promise.all(
      instances.map(instance => this.healthCheck(instance))
    );
    
    return checks.every(healthy => healthy);
  }
  
  /**
   * Perform health check on instance
   */
  private async healthCheck(instance: Instance): Promise<boolean> {
    try {
      const response = await this.sendRequest(
        instance.port,
        this.config.healthCheckUrl,
        this.config.healthCheckTimeout
      );
      
      if (response.statusCode === 200) {
        instance.status = 'healthy';
        instance.healthCheckFailures = 0;
        return true;
      }
    } catch (error) {
      instance.healthCheckFailures++;
      this.emit('health_check_failed', { instanceId: instance.id, error });
    }
    
    instance.status = 'unhealthy';
    return false;
  }
  
  /**
   * Start continuous health checks for instance
   */
  private startHealthChecks(instance: Instance): void {
    const timer = setInterval(async () => {
      if (instance.status === 'stopped') {
        clearInterval(timer);
        this.healthCheckTimers.delete(instance.id);
        return;
      }
      
      await this.healthCheck(instance);
      
      // Auto-restart if too many failures
      if (instance.healthCheckFailures > 5) {
        this.emit('instance_restart_required', { instanceId: instance.id });
      }
    }, this.config.healthCheckInterval);
    
    this.healthCheckTimers.set(instance.id, timer);
  }
  
  /**
   * Monitor deployment stability
   */
  private async monitorStability(instances: Instance[], duration: number): Promise<boolean> {
    const startTime = Date.now();
    const metrics: DeploymentMetrics = {
      totalRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      errorRate: 0
    };
    
    while (Date.now() - startTime < duration) {
      // Check instance health
      const healthyCount = instances.filter(i => i.status === 'healthy').length;
      if (healthyCount < instances.length * 0.9) {
        return false; // Less than 90% healthy
      }
      
      // Collect metrics
      const responses = await Promise.all(
        instances.map(async (instance) => {
          const start = Date.now();
          try {
            await this.sendRequest(instance.port, '/');
            return { success: true, time: Date.now() - start };
          } catch {
            return { success: false, time: 0 };
          }
        })
      );
      
      metrics.totalRequests += responses.length;
      metrics.failedRequests += responses.filter(r => !r.success).length;
      
      const successfulResponses = responses.filter(r => r.success);
      if (successfulResponses.length > 0) {
        const totalTime = successfulResponses.reduce((sum, r) => sum + r.time, 0);
        metrics.averageResponseTime = totalTime / successfulResponses.length;
      }
      
      metrics.errorRate = metrics.failedRequests / metrics.totalRequests;
      
      // Check error rate
      if (metrics.errorRate > 0.05) { // 5% error rate
        return false;
      }
      
      await this.wait(1000);
    }
    
    this.deploymentState!.metrics = metrics;
    return true;
  }
  
  /**
   * Monitor canary instances
   */
  private async monitorCanaries(instances: Instance[], duration: number): Promise<DeploymentMetrics> {
    // Similar to monitorStability but returns metrics
    const metrics = await this.collectMetrics(instances, duration);
    return metrics;
  }
  
  /**
   * Check if canary metrics are healthy
   */
  private isCanaryHealthy(metrics: DeploymentMetrics): boolean {
    // Compare with baseline metrics
    const baseline = this.getBaselineMetrics();
    
    // Allow 10% degradation
    if (metrics.errorRate > baseline.errorRate * 1.1) return false;
    if (metrics.averageResponseTime > baseline.averageResponseTime * 1.1) return false;
    
    return true;
  }
  
  /**
   * Rollback deployment
   */
  private async rollback(): Promise<void> {
    this.deploymentState!.status = 'rolling-back';
    this.emit('rollback_started', this.deploymentState);
    
    try {
      // Stop new instances
      const newInstances = this.deploymentState!.instances;
      await this.stopInstances(newInstances);
      
      // Restore old instances or start fresh ones with old version
      await this.startInitialInstances();
      
      this.emit('rollback_completed');
    } catch (error) {
      this.emit('rollback_failed', error);
      throw error;
    }
  }
  
  /**
   * Start load balancer
   */
  private async startLoadBalancer(): Promise<void> {
    const weights = new Map<string, number>();
    
    this.loadBalancer = http.createServer((req, res) => {
      // Simple weighted round-robin
      const instances = Array.from(this.activeInstances.values())
        .filter(i => i.status === 'healthy');
      
      if (instances.length === 0) {
        res.writeHead(503);
        res.end('No healthy instances');
        return;
      }
      
      // Select instance based on weights
      const instance = this.selectInstance(instances, weights);
      
      // Proxy request
      const proxyReq = http.request({
        hostname: 'localhost',
        port: instance.port,
        path: req.url,
        method: req.method,
        headers: req.headers
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      });
      
      proxyReq.on('error', (error) => {
        res.writeHead(502);
        res.end('Bad Gateway');
        this.emit('proxy_error', { instanceId: instance.id, error });
      });
      
      req.pipe(proxyReq);
    });
    
    await new Promise<void>((resolve) => {
      this.loadBalancer!.listen(this.config.loadBalancerPort, resolve);
    });
    
    this.emit('load_balancer_started', { port: this.config.loadBalancerPort });
  }
  
  /**
   * Select instance based on weights
   */
  private selectInstance(instances: Instance[], weights: Map<string, number>): Instance {
    // Simple weighted selection
    const weighted = instances.map(instance => ({
      instance,
      weight: weights.get(instance.id) || 100
    }));
    
    const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const { instance, weight } of weighted) {
      random -= weight;
      if (random <= 0) {
        return instance;
      }
    }
    
    return instances[0];
  }
  
  /**
   * Helper methods
   */
  
  private async wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  private generateDeploymentId(): string {
    return createHash('sha256')
      .update(`${Date.now()}-${Math.random()}`)
      .digest('hex')
      .substring(0, 12);
  }
  
  private async sendRequest(port: number, path: string, timeout?: number): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = http.get({
        hostname: 'localhost',
        port,
        path,
        timeout: timeout || 5000
      }, resolve);
      
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }
  
  private async validateDeployment(deploymentPath: string): Promise<void> {
    // Check deployment files exist
    const mainFile = path.join(deploymentPath, 'main.js');
    
    try {
      await fs.access(mainFile);
    } catch {
      throw new Error('Deployment files not found');
    }
  }
  
  private async validatePostDeployment(): Promise<void> {
    // Additional validation after deployment
    const healthy = this.deploymentState!.instances
      .filter(i => i.status === 'healthy').length;
    
    if (healthy < this.config.instanceCount * 0.9) {
      throw new Error('Not enough healthy instances after deployment');
    }
  }
  
  private async startInitialInstances(): Promise<void> {
    // Start initial instances implementation
    // This would start the configured number of instances
  }
  
  private async stopInstances(instances: Instance[]): Promise<void> {
    for (const instance of instances) {
      if (instance.process) {
        instance.process.kill();
      }
      
      const timer = this.healthCheckTimers.get(instance.id);
      if (timer) {
        clearInterval(timer);
        this.healthCheckTimers.delete(instance.id);
      }
      
      this.activeInstances.delete(instance.id);
    }
  }
  
  private async switchLoadBalancer(newInstances: Instance[]): Promise<void> {
    // Implementation for switching load balancer traffic
    this.emit('load_balancer_switched', { instances: newInstances.length });
  }
  
  private async addToLoadBalancer(instance: Instance, weight?: number): Promise<void> {
    // Add instance to load balancer
    this.emit('instance_added_to_lb', { instanceId: instance.id, weight });
  }
  
  private async removeFromLoadBalancer(instance: Instance): Promise<void> {
    // Remove instance from load balancer
    this.emit('instance_removed_from_lb', { instanceId: instance.id });
  }
  
  private async updateLoadBalancerWeight(instance: Instance, weight: number): Promise<void> {
    // Update instance weight in load balancer
    this.emit('instance_weight_updated', { instanceId: instance.id, weight });
  }
  
  private async collectMetrics(instances: Instance[], duration: number): Promise<DeploymentMetrics> {
    // Collect and return metrics
    return {
      totalRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      errorRate: 0
    };
  }
  
  private getBaselineMetrics(): DeploymentMetrics {
    // Get baseline metrics from current deployment
    return {
      totalRequests: 1000,
      failedRequests: 5,
      averageResponseTime: 50,
      errorRate: 0.005
    };
  }
}

export default ZeroDowntimeDeployment;
