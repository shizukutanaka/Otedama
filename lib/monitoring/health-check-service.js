const os = require('os');
const fs = require('fs').promises;
const { createLogger } = require('../core/logger');
const { EventEmitter } = require('events');

/**
 * Comprehensive Health Check Service
 * Monitors system health, dependencies, and performance
 */
class HealthCheckService extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      interval: config.interval || 30000, // 30 seconds
      timeout: config.timeout || 5000,    // 5 seconds per check
      retries: config.retries || 3,
      gracePeriod: config.gracePeriod || 60000, // 1 minute startup grace
      
      // Thresholds
      thresholds: {
        cpu: config.thresholds?.cpu || 0.8,
        memory: config.thresholds?.memory || 0.85,
        disk: config.thresholds?.disk || 0.9,
        responseTime: config.thresholds?.responseTime || 1000,
        errorRate: config.thresholds?.errorRate || 0.05,
        ...config.thresholds
      },
      
      // Checks to perform
      checks: {
        system: config.checks?.system !== false,
        database: config.checks?.database !== false,
        blockchain: config.checks?.blockchain !== false,
        cache: config.checks?.cache !== false,
        network: config.checks?.network !== false,
        dependencies: config.checks?.dependencies !== false,
        ...config.checks
      },
      
      // Dependencies to check
      dependencies: config.dependencies || {},
      
      ...config
    };
    
    this.logger = createLogger('health-check');
    this.status = 'initializing';
    this.startTime = Date.now();
    this.lastCheck = null;
    this.checkResults = new Map();
    this.checkHistory = [];
    this.isRunning = false;
    this.checkInterval = null;
    
    // Health score calculation weights
    this.weights = {
      system: 0.3,
      database: 0.2,
      blockchain: 0.2,
      cache: 0.1,
      network: 0.1,
      dependencies: 0.1
    };
  }
  
  /**
   * Start health check monitoring
   */
  async start() {
    if (this.isRunning) {
      return;
    }
    
    this.isRunning = true;
    this.status = 'starting';
    this.logger.info('Starting health check service');
    
    // Perform initial check
    await this.performHealthCheck();
    
    // Start periodic checks
    this.checkInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, this.config.interval);
    
    this.status = 'healthy';
    this.emit('started');
  }
  
  /**
   * Stop health check monitoring
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }
    
    this.isRunning = false;
    this.status = 'stopping';
    
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    this.status = 'stopped';
    this.emit('stopped');
    this.logger.info('Health check service stopped');
  }
  
  /**
   * Perform comprehensive health check
   */
  async performHealthCheck() {
    const startTime = Date.now();
    const results = {
      timestamp: new Date(),
      checks: {},
      status: 'healthy',
      score: 100,
      duration: 0,
      issues: [],
      warnings: []
    };
    
    try {
      // Run all checks in parallel with timeout
      const checkPromises = [];
      
      if (this.config.checks.system) {
        checkPromises.push(this.checkSystem().then(r => results.checks.system = r));
      }
      
      if (this.config.checks.database) {
        checkPromises.push(this.checkDatabase().then(r => results.checks.database = r));
      }
      
      if (this.config.checks.blockchain) {
        checkPromises.push(this.checkBlockchain().then(r => results.checks.blockchain = r));
      }
      
      if (this.config.checks.cache) {
        checkPromises.push(this.checkCache().then(r => results.checks.cache = r));
      }
      
      if (this.config.checks.network) {
        checkPromises.push(this.checkNetwork().then(r => results.checks.network = r));
      }
      
      if (this.config.checks.dependencies) {
        checkPromises.push(this.checkDependencies().then(r => results.checks.dependencies = r));
      }
      
      // Wait for all checks with timeout
      await Promise.race([
        Promise.all(checkPromises),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Health check timeout')), this.config.timeout)
        )
      ]);
      
      // Calculate overall health
      this.calculateOverallHealth(results);
      
    } catch (error) {
      this.logger.error('Health check failed:', error);
      results.status = 'unhealthy';
      results.score = 0;
      results.issues.push({
        severity: 'critical',
        component: 'health-check',
        message: error.message
      });
    }
    
    results.duration = Date.now() - startTime;
    
    // Store results
    this.lastCheck = results;
    this.addToHistory(results);
    
    // Update status
    this.updateStatus(results);
    
    // Emit events
    this.emit('check-complete', results);
    
    if (results.status !== 'healthy') {
      this.emit('unhealthy', results);
    }
    
    return results;
  }
  
  /**
   * Check system resources
   */
  async checkSystem() {
    const check = {
      status: 'healthy',
      metrics: {},
      issues: []
    };
    
    try {
      // CPU usage
      const cpuUsage = os.loadavg()[0] / os.cpus().length;
      check.metrics.cpu = {
        usage: cpuUsage,
        cores: os.cpus().length,
        loadAverage: os.loadavg()
      };
      
      if (cpuUsage > this.config.thresholds.cpu) {
        check.status = 'degraded';
        check.issues.push({
          type: 'cpu',
          severity: cpuUsage > 0.9 ? 'critical' : 'warning',
          message: `CPU usage is ${(cpuUsage * 100).toFixed(1)}%`
        });
      }
      
      // Memory usage
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memUsage = usedMem / totalMem;
      
      check.metrics.memory = {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        usage: memUsage,
        heapUsed: process.memoryUsage().heapUsed,
        heapTotal: process.memoryUsage().heapTotal
      };
      
      if (memUsage > this.config.thresholds.memory) {
        check.status = 'degraded';
        check.issues.push({
          type: 'memory',
          severity: memUsage > 0.95 ? 'critical' : 'warning',
          message: `Memory usage is ${(memUsage * 100).toFixed(1)}%`
        });
      }
      
      // Disk usage (for data directory)
      const diskUsage = await this.checkDiskUsage('./data');
      check.metrics.disk = diskUsage;
      
      if (diskUsage.usage > this.config.thresholds.disk) {
        check.status = 'degraded';
        check.issues.push({
          type: 'disk',
          severity: diskUsage.usage > 0.95 ? 'critical' : 'warning',
          message: `Disk usage is ${(diskUsage.usage * 100).toFixed(1)}%`
        });
      }
      
      // Process info
      check.metrics.process = {
        uptime: process.uptime(),
        pid: process.pid,
        version: process.version,
        platform: process.platform,
        arch: process.arch
      };
      
    } catch (error) {
      check.status = 'unhealthy';
      check.error = error.message;
      check.issues.push({
        type: 'system',
        severity: 'critical',
        message: `System check failed: ${error.message}`
      });
    }
    
    return check;
  }
  
  /**
   * Check database health
   */
  async checkDatabase() {
    const check = {
      status: 'healthy',
      metrics: {},
      issues: []
    };
    
    try {
      const startTime = Date.now();
      
      // Simulate database check (replace with actual database check)
      if (this.config.dependencies.database) {
        const db = this.config.dependencies.database;
        
        // Check connection
        const isConnected = await this.timeoutPromise(
          db.ping ? db.ping() : Promise.resolve(true),
          1000,
          'Database ping timeout'
        );
        
        check.metrics.connected = isConnected;
        check.metrics.responseTime = Date.now() - startTime;
        
        // Check pool stats if available
        if (db.getPoolStats) {
          const poolStats = await db.getPoolStats();
          check.metrics.pool = poolStats;
          
          if (poolStats.pending > poolStats.max * 0.8) {
            check.status = 'degraded';
            check.issues.push({
              type: 'database',
              severity: 'warning',
              message: 'Database connection pool near capacity'
            });
          }
        }
        
        // Check response time
        if (check.metrics.responseTime > this.config.thresholds.responseTime) {
          check.status = 'degraded';
          check.issues.push({
            type: 'database',
            severity: 'warning',
            message: `Database response time is ${check.metrics.responseTime}ms`
          });
        }
      }
      
    } catch (error) {
      check.status = 'unhealthy';
      check.error = error.message;
      check.issues.push({
        type: 'database',
        severity: 'critical',
        message: `Database check failed: ${error.message}`
      });
    }
    
    return check;
  }
  
  /**
   * Check blockchain connectivity
   */
  async checkBlockchain() {
    const check = {
      status: 'healthy',
      metrics: {},
      issues: []
    };
    
    try {
      if (this.config.dependencies.blockchain) {
        const blockchain = this.config.dependencies.blockchain;
        const startTime = Date.now();
        
        // Check connection
        const info = await this.timeoutPromise(
          blockchain.getInfo ? blockchain.getInfo() : Promise.resolve({}),
          3000,
          'Blockchain connection timeout'
        );
        
        check.metrics.connected = true;
        check.metrics.responseTime = Date.now() - startTime;
        check.metrics.blockHeight = info.blocks || 0;
        check.metrics.connections = info.connections || 0;
        
        // Check sync status
        if (info.initialblockdownload) {
          check.status = 'degraded';
          check.issues.push({
            type: 'blockchain',
            severity: 'warning',
            message: 'Blockchain is still syncing'
          });
        }
        
        // Check connections
        if (check.metrics.connections === 0) {
          check.status = 'unhealthy';
          check.issues.push({
            type: 'blockchain',
            severity: 'critical',
            message: 'No blockchain peer connections'
          });
        }
        
        // Check response time
        if (check.metrics.responseTime > this.config.thresholds.responseTime * 2) {
          check.status = 'degraded';
          check.issues.push({
            type: 'blockchain',
            severity: 'warning',
            message: `Blockchain response time is ${check.metrics.responseTime}ms`
          });
        }
      }
      
    } catch (error) {
      check.status = 'unhealthy';
      check.error = error.message;
      check.issues.push({
        type: 'blockchain',
        severity: 'critical',
        message: `Blockchain check failed: ${error.message}`
      });
    }
    
    return check;
  }
  
  /**
   * Check cache health
   */
  async checkCache() {
    const check = {
      status: 'healthy',
      metrics: {},
      issues: []
    };
    
    try {
      if (this.config.dependencies.cache) {
        const cache = this.config.dependencies.cache;
        const startTime = Date.now();
        
        // Test cache operations
        const testKey = 'health-check-test';
        const testValue = Date.now();
        
        // Set
        await this.timeoutPromise(
          cache.set(testKey, testValue),
          500,
          'Cache set timeout'
        );
        
        // Get
        const retrieved = await this.timeoutPromise(
          cache.get(testKey),
          500,
          'Cache get timeout'
        );
        
        check.metrics.operational = retrieved === testValue;
        check.metrics.responseTime = Date.now() - startTime;
        
        // Get cache stats if available
        if (cache.getStats) {
          const stats = await cache.getStats();
          check.metrics.stats = stats;
          
          // Check hit rate
          if (stats.hitRate < 0.5) {
            check.issues.push({
              type: 'cache',
              severity: 'info',
              message: `Cache hit rate is low: ${(stats.hitRate * 100).toFixed(1)}%`
            });
          }
          
          // Check memory usage
          if (stats.memoryUsage > this.config.thresholds.memory) {
            check.status = 'degraded';
            check.issues.push({
              type: 'cache',
              severity: 'warning',
              message: `Cache memory usage is high: ${(stats.memoryUsage * 100).toFixed(1)}%`
            });
          }
        }
        
        // Cleanup
        await cache.delete(testKey);
        
      }
      
    } catch (error) {
      check.status = 'unhealthy';
      check.error = error.message;
      check.issues.push({
        type: 'cache',
        severity: 'warning',
        message: `Cache check failed: ${error.message}`
      });
    }
    
    return check;
  }
  
  /**
   * Check network connectivity
   */
  async checkNetwork() {
    const check = {
      status: 'healthy',
      metrics: {},
      issues: []
    };
    
    try {
      // Check P2P network if available
      if (this.config.dependencies.p2p) {
        const p2p = this.config.dependencies.p2p;
        
        check.metrics.peers = p2p.getPeerCount ? p2p.getPeerCount() : 0;
        check.metrics.inbound = p2p.getInboundCount ? p2p.getInboundCount() : 0;
        check.metrics.outbound = p2p.getOutboundCount ? p2p.getOutboundCount() : 0;
        
        // Check peer count
        if (check.metrics.peers === 0) {
          check.status = 'degraded';
          check.issues.push({
            type: 'network',
            severity: 'warning',
            message: 'No P2P peer connections'
          });
        }
      }
      
      // Check stratum server if available
      if (this.config.dependencies.stratum) {
        const stratum = this.config.dependencies.stratum;
        
        check.metrics.miners = stratum.getMinerCount ? stratum.getMinerCount() : 0;
        check.metrics.hashrate = stratum.getPoolHashrate ? stratum.getPoolHashrate() : 0;
      }
      
      // Check network interfaces
      const interfaces = os.networkInterfaces();
      check.metrics.interfaces = Object.keys(interfaces).length;
      
      // Check for active network interface
      const hasActiveInterface = Object.values(interfaces).some(iface =>
        iface.some(addr => !addr.internal && addr.family === 'IPv4')
      );
      
      if (!hasActiveInterface) {
        check.status = 'unhealthy';
        check.issues.push({
          type: 'network',
          severity: 'critical',
          message: 'No active network interface found'
        });
      }
      
    } catch (error) {
      check.status = 'unhealthy';
      check.error = error.message;
      check.issues.push({
        type: 'network',
        severity: 'critical',
        message: `Network check failed: ${error.message}`
      });
    }
    
    return check;
  }
  
  /**
   * Check external dependencies
   */
  async checkDependencies() {
    const check = {
      status: 'healthy',
      metrics: {},
      issues: []
    };
    
    try {
      const dependencies = [];
      
      // Check each configured dependency
      for (const [name, dep] of Object.entries(this.config.dependencies)) {
        if (typeof dep.healthCheck === 'function') {
          const depCheck = {
            name,
            status: 'healthy',
            responseTime: 0
          };
          
          const startTime = Date.now();
          
          try {
            const result = await this.timeoutPromise(
              dep.healthCheck(),
              this.config.timeout,
              `${name} health check timeout`
            );
            
            depCheck.responseTime = Date.now() - startTime;
            depCheck.status = result.status || 'healthy';
            depCheck.details = result;
            
          } catch (error) {
            depCheck.status = 'unhealthy';
            depCheck.error = error.message;
            
            check.status = 'degraded';
            check.issues.push({
              type: 'dependency',
              severity: 'warning',
              message: `Dependency ${name} is unhealthy: ${error.message}`
            });
          }
          
          dependencies.push(depCheck);
        }
      }
      
      check.metrics.dependencies = dependencies;
      
      // Check if any critical dependencies are down
      const criticalDown = dependencies.filter(d => 
        d.status === 'unhealthy' && this.config.dependencies[d.name].critical
      );
      
      if (criticalDown.length > 0) {
        check.status = 'unhealthy';
        criticalDown.forEach(dep => {
          check.issues.push({
            type: 'dependency',
            severity: 'critical',
            message: `Critical dependency ${dep.name} is down`
          });
        });
      }
      
    } catch (error) {
      check.status = 'unhealthy';
      check.error = error.message;
      check.issues.push({
        type: 'dependencies',
        severity: 'critical',
        message: `Dependencies check failed: ${error.message}`
      });
    }
    
    return check;
  }
  
  /**
   * Check disk usage
   */
  async checkDiskUsage(path) {
    try {
      const stats = await fs.stat(path);
      
      // This is a simplified check - in production, use a proper disk usage library
      return {
        path,
        total: 100 * 1024 * 1024 * 1024, // 100GB dummy value
        used: 50 * 1024 * 1024 * 1024,   // 50GB dummy value
        free: 50 * 1024 * 1024 * 1024,   // 50GB dummy value
        usage: 0.5 // 50% usage
      };
      
    } catch (error) {
      return {
        path,
        error: error.message,
        usage: 0
      };
    }
  }
  
  /**
   * Calculate overall health score and status
   */
  calculateOverallHealth(results) {
    let totalScore = 0;
    let totalWeight = 0;
    const issues = [];
    const warnings = [];
    
    // Calculate weighted score
    for (const [component, check] of Object.entries(results.checks)) {
      const weight = this.weights[component] || 0.1;
      let componentScore = 100;
      
      if (check.status === 'degraded') {
        componentScore = 75;
      } else if (check.status === 'unhealthy') {
        componentScore = 0;
      }
      
      totalScore += componentScore * weight;
      totalWeight += weight;
      
      // Collect issues
      if (check.issues) {
        check.issues.forEach(issue => {
          if (issue.severity === 'critical') {
            issues.push({ component, ...issue });
          } else {
            warnings.push({ component, ...issue });
          }
        });
      }
    }
    
    // Normalize score
    results.score = totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;
    
    // Determine overall status
    if (results.score >= 90) {
      results.status = 'healthy';
    } else if (results.score >= 70) {
      results.status = 'degraded';
    } else {
      results.status = 'unhealthy';
    }
    
    // Add grace period for startup
    if (Date.now() - this.startTime < this.config.gracePeriod) {
      results.inGracePeriod = true;
      if (results.status === 'unhealthy') {
        results.status = 'degraded';
      }
    }
    
    results.issues = issues;
    results.warnings = warnings;
  }
  
  /**
   * Update service status based on check results
   */
  updateStatus(results) {
    const previousStatus = this.status;
    
    if (!this.isRunning) {
      this.status = 'stopped';
    } else if (results.status === 'healthy') {
      this.status = 'healthy';
    } else if (results.status === 'degraded') {
      this.status = 'degraded';
    } else {
      this.status = 'unhealthy';
    }
    
    // Emit status change event
    if (previousStatus !== this.status) {
      this.emit('status-changed', {
        previous: previousStatus,
        current: this.status,
        results
      });
      
      this.logger.info(`Health status changed: ${previousStatus} -> ${this.status}`);
    }
  }
  
  /**
   * Add check results to history
   */
  addToHistory(results) {
    this.checkHistory.push({
      timestamp: results.timestamp,
      status: results.status,
      score: results.score,
      duration: results.duration,
      issueCount: results.issues.length,
      warningCount: results.warnings.length
    });
    
    // Keep last 100 checks
    if (this.checkHistory.length > 100) {
      this.checkHistory = this.checkHistory.slice(-100);
    }
  }
  
  /**
   * Get current health status
   */
  getStatus() {
    if (!this.lastCheck) {
      return {
        status: this.status,
        message: 'No health check performed yet',
        timestamp: new Date(),
        uptime: Date.now() - this.startTime
      };
    }
    
    return {
      status: this.status,
      score: this.lastCheck.score,
      timestamp: this.lastCheck.timestamp,
      duration: this.lastCheck.duration,
      checks: this.lastCheck.checks,
      issues: this.lastCheck.issues,
      warnings: this.lastCheck.warnings,
      uptime: Date.now() - this.startTime,
      nextCheck: this.isRunning ? new Date(Date.now() + this.config.interval) : null
    };
  }
  
  /**
   * Get detailed health report
   */
  getDetailedReport() {
    const report = {
      service: 'Otedama Mining Pool',
      timestamp: new Date(),
      status: this.status,
      uptime: Date.now() - this.startTime,
      configuration: {
        checkInterval: this.config.interval,
        timeout: this.config.timeout,
        checks: this.config.checks,
        thresholds: this.config.thresholds
      },
      currentHealth: this.getStatus(),
      history: {
        checks: this.checkHistory.length,
        recentChecks: this.checkHistory.slice(-10),
        statistics: this.calculateStatistics()
      }
    };
    
    return report;
  }
  
  /**
   * Calculate health statistics
   */
  calculateStatistics() {
    if (this.checkHistory.length === 0) {
      return null;
    }
    
    const stats = {
      totalChecks: this.checkHistory.length,
      averageScore: 0,
      averageDuration: 0,
      healthyChecks: 0,
      degradedChecks: 0,
      unhealthyChecks: 0,
      availability: 0
    };
    
    let totalScore = 0;
    let totalDuration = 0;
    
    this.checkHistory.forEach(check => {
      totalScore += check.score;
      totalDuration += check.duration;
      
      if (check.status === 'healthy') stats.healthyChecks++;
      else if (check.status === 'degraded') stats.degradedChecks++;
      else stats.unhealthyChecks++;
    });
    
    stats.averageScore = Math.round(totalScore / this.checkHistory.length);
    stats.averageDuration = Math.round(totalDuration / this.checkHistory.length);
    stats.availability = ((stats.healthyChecks + stats.degradedChecks) / stats.totalChecks) * 100;
    
    return stats;
  }
  
  /**
   * Promise with timeout
   */
  async timeoutPromise(promise, timeout, errorMessage) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(errorMessage)), timeout)
      )
    ]);
  }
  
  /**
   * Express middleware for health endpoint
   */
  expressMiddleware() {
    return async (req, res) => {
      const status = this.getStatus();
      const httpStatus = status.status === 'healthy' ? 200 : 
                        status.status === 'degraded' ? 200 : 503;
      
      // Support different response formats
      const format = req.query.format || 'json';
      
      if (format === 'simple') {
        // Simple text response for load balancers
        res.status(httpStatus).send(status.status.toUpperCase());
      } else if (format === 'detailed') {
        // Detailed report
        res.status(httpStatus).json(this.getDetailedReport());
      } else {
        // Default JSON response
        res.status(httpStatus).json(status);
      }
    };
  }
}

module.exports = HealthCheckService;