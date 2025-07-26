#!/usr/bin/env node
/**
 * National Deployment Example - Otedama
 * Shows how to deploy and manage a national-scale mining pool
 */

import { autoScaler, loadBalancer, distributedConfig } from '../lib/core/practical-scaling.js';
import nationalConfig from '../config/national-scale.js';
import { createStructuredLogger } from '../lib/core/structured-logger.js';

const logger = createStructuredLogger('NationalDeployment');

/**
 * National-scale mining pool deployment
 */
class NationalMiningPool {
  constructor(config) {
    this.config = config;
    this.regions = new Map();
    this.isRunning = false;
  }
  
  /**
   * Start national deployment
   */
  async start() {
    logger.info('Starting national-scale mining pool deployment');
    
    try {
      // 1. Initialize distributed configuration
      await this.initializeConfiguration();
      
      // 2. Set up load balancing
      await this.setupLoadBalancing();
      
      // 3. Deploy to multiple regions
      await this.deployMultiRegion();
      
      // 4. Start auto-scaling
      await this.startAutoScaling();
      
      // 5. Initialize monitoring
      await this.initializeMonitoring();
      
      this.isRunning = true;
      logger.info('National mining pool deployment completed successfully');
      
      // Start health monitoring
      this.startHealthMonitoring();
      
    } catch (error) {
      logger.error('Failed to start national deployment', error);
      throw error;
    }
  }
  
  /**
   * Initialize distributed configuration
   */
  async initializeConfiguration() {
    logger.info('Initializing distributed configuration');
    
    // Set global configuration
    distributedConfig.set('pool.name', this.config.pool.name);
    distributedConfig.set('pool.fee', this.config.pool.fee);
    distributedConfig.set('pool.algorithm', this.config.pool.algorithm);
    
    // Set scaling parameters
    distributedConfig.set('scaling.enabled', this.config.scaling.enabled);
    distributedConfig.set('scaling.maxInstances', this.config.scaling.maxInstances);
    
    // Listen for configuration changes
    distributedConfig.watch('scaling.maxInstances', (newValue) => {
      logger.info('Scaling configuration updated', { maxInstances: newValue });
      this.updateScalingLimits(newValue);
    });
    
    logger.info('Configuration initialized', {
      poolName: this.config.pool.name,
      regions: this.config.pool.regions.length,
      scalingEnabled: this.config.scaling.enabled
    });
  }
  
  /**
   * Set up load balancing
   */
  async setupLoadBalancing() {
    logger.info('Setting up load balancing');
    
    // For each region, we'll add servers to the load balancer
    for (const region of this.config.pool.regions) {
      const server = {
        id: `${region}-primary`,
        region,
        endpoint: `${region}.mining.otedama.com:3333`,
        capacity: this.config.pool.maxConnections,
        healthy: true
      };
      
      loadBalancer.addServer(server);
      
      logger.info('Added server to load balancer', {
        serverId: server.id,
        region: server.region,
        endpoint: server.endpoint
      });
    }
    
    // Start health checks
    setInterval(() => {
      this.performHealthChecks();
    }, this.config.loadBalancer.healthCheck.interval);
  }
  
  /**
   * Deploy to multiple regions
   */
  async deployMultiRegion() {
    logger.info('Deploying to multiple regions');
    
    const deploymentPromises = this.config.pool.regions.map(region => 
      this.deployToRegion(region)
    );
    
    const results = await Promise.allSettled(deploymentPromises);
    
    let successful = 0;
    let failed = 0;
    
    results.forEach((result, index) => {
      const region = this.config.pool.regions[index];
      
      if (result.status === 'fulfilled') {
        successful++;
        logger.info('Region deployment successful', { region });
      } else {
        failed++;
        logger.error('Region deployment failed', { 
          region, 
          error: result.reason 
        });
      }
    });
    
    logger.info('Multi-region deployment completed', {
      totalRegions: this.config.pool.regions.length,
      successful,
      failed
    });
    
    if (failed > 0 && successful === 0) {
      throw new Error('All region deployments failed');
    }
  }
  
  /**
   * Deploy to a specific region
   */
  async deployToRegion(region) {
    logger.info('Deploying to region', { region });
    
    try {
      // Simulate region deployment
      const regionConfig = {
        ...this.config,
        region,
        // Region-specific overrides
        pool: {
          ...this.config.pool,
          name: `${this.config.pool.name} - ${region.toUpperCase()}`
        }
      };
      
      // Create region instance
      const regionInstance = {
        region,
        config: regionConfig,
        status: 'deploying',
        startTime: Date.now(),
        servers: [],
        connections: 0,
        hashrate: 0
      };
      
      // Simulate deployment delay
      await this.delay(2000);
      
      // Create servers in the region
      const serverCount = Math.min(this.config.scaling.minInstances, 3);
      for (let i = 0; i < serverCount; i++) {
        const server = await this.createRegionServer(region, i);
        regionInstance.servers.push(server);
      }
      
      regionInstance.status = 'running';
      this.regions.set(region, regionInstance);
      
      logger.info('Region deployment completed', {
        region,
        servers: regionInstance.servers.length,
        deploymentTime: Date.now() - regionInstance.startTime
      });
      
      return regionInstance;
      
    } catch (error) {
      logger.error('Region deployment failed', { region, error });
      throw error;
    }
  }
  
  /**
   * Create a server in a specific region
   */
  async createRegionServer(region, index) {
    const server = {
      id: `${region}-server-${index}`,
      region,
      index,
      status: 'starting',
      endpoint: `${region}-${index}.mining.otedama.com:3333`,
      connections: 0,
      maxConnections: this.config.pool.maxConnections,
      cpuUsage: 0,
      memoryUsage: 0,
      startTime: Date.now()
    };
    
    // Simulate server startup
    await this.delay(1000);
    
    server.status = 'running';
    
    logger.info('Created region server', {
      serverId: server.id,
      region: server.region,
      endpoint: server.endpoint
    });
    
    return server;
  }
  
  /**
   * Start auto-scaling
   */
  async startAutoScaling() {
    logger.info('Starting auto-scaling');
    
    // Configure auto-scaler with national-scale settings
    const scalingConfig = {
      ...this.config.scaling,
      onScaleUp: (metrics) => this.handleScaleUp(metrics),
      onScaleDown: (metrics) => this.handleScaleDown(metrics)
    };
    
    // Start the auto-scaler
    autoScaler.start();
    
    logger.info('Auto-scaling started', {
      minWorkers: this.config.scaling.minWorkers,
      maxWorkers: this.config.scaling.maxWorkers,
      minInstances: this.config.scaling.minInstances,
      maxInstances: this.config.scaling.maxInstances
    });
  }
  
  /**
   * Handle scale up event
   */
  handleScaleUp(metrics) {
    logger.info('Scaling up due to high load', {
      cpuUsage: metrics.cpuUsage,
      memoryUsage: metrics.memoryUsage,
      connections: metrics.connections
    });
    
    // Find region with highest load
    let highestLoad = 0;
    let targetRegion = null;
    
    for (const [regionName, regionInstance] of this.regions) {
      const load = this.calculateRegionLoad(regionInstance);
      if (load > highestLoad) {
        highestLoad = load;
        targetRegion = regionName;
      }
    }
    
    if (targetRegion) {
      this.addServerToRegion(targetRegion);
    }
  }
  
  /**
   * Handle scale down event
   */
  handleScaleDown(metrics) {
    logger.info('Scaling down due to low load', {
      cpuUsage: metrics.cpuUsage,
      memoryUsage: metrics.memoryUsage,
      connections: metrics.connections
    });
    
    // Find region with lowest load and extra capacity
    let lowestLoad = Infinity;
    let targetRegion = null;
    
    for (const [regionName, regionInstance] of this.regions) {
      if (regionInstance.servers.length > 1) { // Keep at least 1 server
        const load = this.calculateRegionLoad(regionInstance);
        if (load < lowestLoad) {
          lowestLoad = load;
          targetRegion = regionName;
        }
      }
    }
    
    if (targetRegion) {
      this.removeServerFromRegion(targetRegion);
    }
  }
  
  /**
   * Add server to region
   */
  async addServerToRegion(region) {
    const regionInstance = this.regions.get(region);
    if (!regionInstance) {
      logger.warn('Cannot add server to unknown region', { region });
      return;
    }
    
    const serverIndex = regionInstance.servers.length;
    const newServer = await this.createRegionServer(region, serverIndex);
    
    regionInstance.servers.push(newServer);
    
    // Add to load balancer
    loadBalancer.addServer({
      id: newServer.id,
      region: newServer.region,
      endpoint: newServer.endpoint,
      capacity: newServer.maxConnections
    });
    
    logger.info('Added server to region', {
      region,
      serverId: newServer.id,
      totalServers: regionInstance.servers.length
    });
  }
  
  /**
   * Remove server from region
   */
  removeServerFromRegion(region) {
    const regionInstance = this.regions.get(region);
    if (!regionInstance || regionInstance.servers.length <= 1) {
      return;
    }
    
    // Remove least busy server
    const serverToRemove = regionInstance.servers.pop();
    
    // Remove from load balancer
    loadBalancer.removeServer(serverToRemove.id);
    
    logger.info('Removed server from region', {
      region,
      serverId: serverToRemove.id,
      remainingServers: regionInstance.servers.length
    });
  }
  
  /**
   * Initialize monitoring
   */
  async initializeMonitoring() {
    logger.info('Initializing monitoring');
    
    // Set up metrics collection
    setInterval(() => {
      this.collectMetrics();
    }, this.config.monitoring.metricsInterval);
    
    // Set up alerting
    if (this.config.monitoring.alerts.enabled) {
      this.setupAlerting();
    }
    
    logger.info('Monitoring initialized');
  }
  
  /**
   * Collect system metrics
   */
  collectMetrics() {
    const metrics = {
      timestamp: Date.now(),
      totalRegions: this.regions.size,
      totalServers: 0,
      totalConnections: 0,
      totalHashrate: 0,
      avgLatency: 0,
      overallHealth: 'healthy'
    };
    
    for (const regionInstance of this.regions.values()) {
      metrics.totalServers += regionInstance.servers.length;
      metrics.totalConnections += regionInstance.connections;
      metrics.totalHashrate += regionInstance.hashrate;
    }
    
    // Calculate average latency (simulated)
    metrics.avgLatency = Math.random() * 2 + 0.5; // 0.5-2.5ms
    
    // Log metrics
    logger.debug('System metrics', metrics);
    
    // Check thresholds for alerting
    this.checkAlertThresholds(metrics);
  }
  
  /**
   * Start health monitoring
   */
  startHealthMonitoring() {
    setInterval(() => {
      this.performHealthChecks();
      this.updateRegionStats();
    }, 30000); // Every 30 seconds
  }
  
  /**
   * Perform health checks on all servers
   */
  performHealthChecks() {
    for (const regionInstance of this.regions.values()) {
      for (const server of regionInstance.servers) {
        // Simulate health check
        const isHealthy = Math.random() > 0.05; // 95% success rate
        
        if (!isHealthy) {
          logger.warn('Server health check failed', {
            serverId: server.id,
            region: server.region
          });
          
          // Update load balancer
          loadBalancer.updateServerHealth(server.id, false);
        } else {
          loadBalancer.updateServerHealth(server.id, true);
        }
      }
    }
  }
  
  /**
   * Update region statistics
   */
  updateRegionStats() {
    for (const regionInstance of this.regions.values()) {
      // Simulate metrics
      regionInstance.connections = Math.floor(Math.random() * 100000);
      regionInstance.hashrate = Math.random() * 1000000000; // Random hashrate
      
      // Update server metrics
      for (const server of regionInstance.servers) {
        server.connections = Math.floor(Math.random() * 10000);
        server.cpuUsage = Math.random() * 100;
        server.memoryUsage = Math.random() * 100;
      }
    }
  }
  
  /**
   * Calculate region load
   */
  calculateRegionLoad(regionInstance) {
    if (regionInstance.servers.length === 0) return 0;
    
    let totalCpu = 0;
    let totalMemory = 0;
    
    for (const server of regionInstance.servers) {
      totalCpu += server.cpuUsage;
      totalMemory += server.memoryUsage;
    }
    
    const avgCpu = totalCpu / regionInstance.servers.length;
    const avgMemory = totalMemory / regionInstance.servers.length;
    
    return (avgCpu + avgMemory) / 2;
  }
  
  /**
   * Get deployment status
   */
  getStatus() {
    const status = {
      isRunning: this.isRunning,
      totalRegions: this.regions.size,
      regions: {},
      loadBalancer: loadBalancer.getStatus(),
      autoScaler: autoScaler.getStatus()
    };
    
    for (const [regionName, regionInstance] of this.regions) {
      status.regions[regionName] = {
        status: regionInstance.status,
        servers: regionInstance.servers.length,
        connections: regionInstance.connections,
        hashrate: regionInstance.hashrate,
        uptime: Date.now() - regionInstance.startTime
      };
    }
    
    return status;
  }
  
  /**
   * Utility functions
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  updateScalingLimits(maxInstances) {
    // Update scaling configuration
    this.config.scaling.maxInstances = maxInstances;
  }
  
  setupAlerting() {
    // Set up alerting system
    logger.info('Alerting system configured');
  }
  
  checkAlertThresholds(metrics) {
    // Check if any metrics exceed thresholds
    if (metrics.avgLatency > this.config.monitoring.alerts.thresholds.latency) {
      logger.warn('High latency detected', { latency: metrics.avgLatency });
    }
  }
}

// Example usage
async function runExample() {
  try {
    console.log('🌍 Starting National-Scale Mining Pool Deployment Example\n');
    
    const pool = new NationalMiningPool(nationalConfig);
    
    // Start deployment
    await pool.start();
    
    // Show status
    console.log('\n📊 Deployment Status:');
    console.log(JSON.stringify(pool.getStatus(), null, 2));
    
    // Monitor for a while
    console.log('\n📈 Monitoring deployment...');
    
    let monitoringCount = 0;
    const monitoringInterval = setInterval(() => {
      const status = pool.getStatus();
      console.log(`\n[${new Date().toISOString()}] Status Update:`);
      console.log(`- Regions: ${status.totalRegions}`);
      console.log(`- Total Servers: ${Object.values(status.regions).reduce((sum, r) => sum + r.servers, 0)}`);
      console.log(`- Load Balancer: ${status.loadBalancer.healthyServers}/${status.loadBalancer.totalServers} healthy`);
      console.log(`- Auto Scaler: ${status.autoScaler.workers} workers`);
      
      monitoringCount++;
      if (monitoringCount >= 5) { // Monitor for 5 updates then stop
        clearInterval(monitoringInterval);
        console.log('\n✅ Example completed successfully!');
        console.log('\nThis demonstrates how Otedama can scale to national levels with:');
        console.log('- Multi-region deployment');
        console.log('- Auto-scaling capabilities');
        console.log('- Load balancing');
        console.log('- Health monitoring');
        console.log('- Distributed configuration');
        process.exit(0);
      }
    }, 5000); // Update every 5 seconds
    
  } catch (error) {
    console.error('❌ Example failed:', error);
    process.exit(1);
  }
}

// Run the example if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runExample();
}

export default NationalMiningPool;