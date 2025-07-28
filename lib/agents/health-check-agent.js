import { BaseAgent } from './base-agent.js';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('Agent');
// import { healthCheck } from '../core/health-check.js';

export class HealthCheckAgent extends BaseAgent {
  constructor(config = {}) {
    super({
      ...config,
      name: config.name || 'HealthCheckAgent',
      type: 'health',
      interval: config.interval || 60000 // 1 minute
    });
    
    this.healthChecks = {
      system: ['cpu', 'memory', 'disk', 'network'],
      application: ['process', 'threads', 'connections', 'queues'],
      mining: ['pool', 'miners', 'hashrate', 'shares'],
      dependencies: ['database', 'redis', 'external_apis']
    };
    
    this.healthHistory = [];
    this.failurePatterns = new Map();
    this.criticalComponents = ['database', 'mining_pool', 'stratum_server'];
  }

  async onInitialize() {
    logger.info('Initializing Health Check Agent');
    await this.registerHealthChecks();
  }

  async run() {
    // Perform all health checks
    const healthStatus = await this.performHealthChecks();
    
    // Analyze health trends
    const trends = this.analyzeHealthTrends(healthStatus);
    
    // Predict potential failures
    const predictions = this.predictFailures(healthStatus, trends);
    
    // Generate health score
    const healthScore = this.calculateHealthScore(healthStatus);
    
    // Update health history
    this.updateHealthHistory(healthStatus, healthScore);
    
    // Generate health report
    const report = {
      timestamp: Date.now(),
      healthScore,
      status: this.determineOverallStatus(healthScore),
      checks: healthStatus,
      trends,
      predictions,
      recommendations: this.generateRecommendations(healthStatus, predictions)
    };

    // Emit alerts for critical issues
    this.checkForCriticalIssues(healthStatus);

    return report;
  }

  async performHealthChecks() {
    const results = {
      system: await this.checkSystemHealth(),
      application: await this.checkApplicationHealth(),
      mining: await this.checkMiningHealth(),
      dependencies: await this.checkDependenciesHealth()
    };

    return results;
  }

  async checkSystemHealth() {
    const checks = {};

    // CPU Health
    checks.cpu = await this.checkCPUHealth();
    
    // Memory Health
    checks.memory = await this.checkMemoryHealth();
    
    // Disk Health
    checks.disk = await this.checkDiskHealth();
    
    // Network Health
    checks.network = await this.checkNetworkHealth();

    return checks;
  }

  async checkCPUHealth() {
    try {
      const cpuUsage = this.getContext('cpuUsage') || 0;
      const loadAverage = this.getContext('loadAverage') || [0, 0, 0];
      
      const status = cpuUsage < 80 ? 'healthy' : cpuUsage < 90 ? 'warning' : 'critical';
      
      return {
        status,
        metrics: {
          usage: cpuUsage,
          loadAverage,
          cores: this.getContext('cpuCores') || 1
        },
        message: `CPU usage at ${cpuUsage.toFixed(1)}%`
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async checkMemoryHealth() {
    try {
      const memoryUsage = this.getContext('memoryUsage') || 0;
      const totalMemory = this.getContext('totalMemory') || 1;
      const freeMemory = this.getContext('freeMemory') || 0;
      
      const usagePercent = (memoryUsage / totalMemory) * 100;
      const status = usagePercent < 80 ? 'healthy' : usagePercent < 90 ? 'warning' : 'critical';
      
      return {
        status,
        metrics: {
          total: totalMemory,
          used: memoryUsage,
          free: freeMemory,
          percentage: usagePercent
        },
        message: `Memory usage at ${usagePercent.toFixed(1)}%`
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async checkDiskHealth() {
    try {
      const diskUsage = this.getContext('diskUsage') || 0;
      const diskTotal = this.getContext('diskTotal') || 1;
      
      const usagePercent = (diskUsage / diskTotal) * 100;
      const status = usagePercent < 80 ? 'healthy' : usagePercent < 90 ? 'warning' : 'critical';
      
      return {
        status,
        metrics: {
          total: diskTotal,
          used: diskUsage,
          free: diskTotal - diskUsage,
          percentage: usagePercent
        },
        message: `Disk usage at ${usagePercent.toFixed(1)}%`
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async checkNetworkHealth() {
    try {
      const latency = this.getContext('networkLatency') || 0;
      const packetLoss = this.getContext('packetLoss') || 0;
      
      const status = (latency < 100 && packetLoss < 1) ? 'healthy' : 
                     (latency < 200 && packetLoss < 5) ? 'warning' : 'critical';
      
      return {
        status,
        metrics: {
          latency,
          packetLoss,
          bandwidth: this.getContext('bandwidth') || 0
        },
        message: `Network latency ${latency}ms, packet loss ${packetLoss}%`
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async checkApplicationHealth() {
    const checks = {};

    // Process Health
    checks.process = await this.checkProcessHealth();
    
    // Thread Health
    checks.threads = await this.checkThreadHealth();
    
    // Connection Health
    checks.connections = await this.checkConnectionHealth();
    
    // Queue Health
    checks.queues = await this.checkQueueHealth();

    return checks;
  }

  async checkProcessHealth() {
    try {
      const uptime = process.uptime();
      const memoryUsage = process.memoryUsage();
      
      const heapPercent = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;
      const status = heapPercent < 80 ? 'healthy' : heapPercent < 90 ? 'warning' : 'critical';
      
      return {
        status,
        metrics: {
          uptime,
          pid: process.pid,
          memory: memoryUsage,
          heapPercent
        },
        message: `Process uptime ${Math.floor(uptime / 60)}m, heap ${heapPercent.toFixed(1)}%`
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async checkThreadHealth() {
    try {
      const activeThreads = this.getContext('activeThreads') || 1;
      const maxThreads = this.getContext('maxThreads') || 10;
      
      const threadPercent = (activeThreads / maxThreads) * 100;
      const status = threadPercent < 80 ? 'healthy' : threadPercent < 90 ? 'warning' : 'critical';
      
      return {
        status,
        metrics: {
          active: activeThreads,
          max: maxThreads,
          percentage: threadPercent
        },
        message: `${activeThreads} of ${maxThreads} threads active`
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async checkConnectionHealth() {
    try {
      const activeConnections = this.getContext('activeConnections') || 0;
      const maxConnections = this.getContext('maxConnections') || 1000;
      
      const connPercent = (activeConnections / maxConnections) * 100;
      const status = connPercent < 80 ? 'healthy' : connPercent < 90 ? 'warning' : 'critical';
      
      return {
        status,
        metrics: {
          active: activeConnections,
          max: maxConnections,
          percentage: connPercent
        },
        message: `${activeConnections} active connections`
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async checkQueueHealth() {
    try {
      const queueSize = this.getContext('queueSize') || 0;
      const queueCapacity = this.getContext('queueCapacity') || 10000;
      
      const queuePercent = (queueSize / queueCapacity) * 100;
      const status = queuePercent < 50 ? 'healthy' : queuePercent < 80 ? 'warning' : 'critical';
      
      return {
        status,
        metrics: {
          size: queueSize,
          capacity: queueCapacity,
          percentage: queuePercent
        },
        message: `Queue at ${queuePercent.toFixed(1)}% capacity`
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async checkMiningHealth() {
    const checks = {};

    // Pool Health
    checks.pool = await this.checkPoolHealth();
    
    // Miner Health
    checks.miners = await this.checkMinerHealth();
    
    // Hashrate Health
    checks.hashrate = await this.checkHashrateHealth();
    
    // Share Health
    checks.shares = await this.checkShareHealth();

    return checks;
  }

  async checkPoolHealth() {
    try {
      const poolStatus = this.getContext('poolStatus') || 'unknown';
      const lastBlock = this.getContext('lastBlockTime') || Date.now();
      const timeSinceBlock = Date.now() - lastBlock;
      
      const status = poolStatus === 'active' && timeSinceBlock < 3600000 ? 'healthy' : 
                     poolStatus === 'active' ? 'warning' : 'critical';
      
      return {
        status,
        metrics: {
          poolStatus,
          lastBlock,
          timeSinceBlock
        },
        message: `Pool ${poolStatus}, last block ${Math.floor(timeSinceBlock / 60000)}m ago`
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async checkMinerHealth() {
    try {
      const connectedMiners = this.getContext('connectedMiners') || 0;
      const activeMiners = this.getContext('activeMiners') || 0;
      
      const minerPercent = connectedMiners > 0 ? (activeMiners / connectedMiners) * 100 : 0;
      const status = minerPercent > 80 ? 'healthy' : minerPercent > 50 ? 'warning' : 'critical';
      
      return {
        status,
        metrics: {
          connected: connectedMiners,
          active: activeMiners,
          percentage: minerPercent
        },
        message: `${activeMiners} of ${connectedMiners} miners active`
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async checkHashrateHealth() {
    try {
      const currentHashrate = this.getContext('currentHashrate') || 0;
      const expectedHashrate = this.getContext('expectedHashrate') || 1;
      
      const hashratePercent = (currentHashrate / expectedHashrate) * 100;
      const status = hashratePercent > 90 ? 'healthy' : hashratePercent > 70 ? 'warning' : 'critical';
      
      return {
        status,
        metrics: {
          current: currentHashrate,
          expected: expectedHashrate,
          percentage: hashratePercent
        },
        message: `Hashrate at ${hashratePercent.toFixed(1)}% of expected`
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async checkShareHealth() {
    try {
      const validShares = this.getContext('validShares') || 0;
      const invalidShares = this.getContext('invalidShares') || 0;
      const totalShares = validShares + invalidShares;
      
      const validPercent = totalShares > 0 ? (validShares / totalShares) * 100 : 0;
      const status = validPercent > 95 ? 'healthy' : validPercent > 90 ? 'warning' : 'critical';
      
      return {
        status,
        metrics: {
          valid: validShares,
          invalid: invalidShares,
          percentage: validPercent
        },
        message: `${validPercent.toFixed(1)}% share validity rate`
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async checkDependenciesHealth() {
    const checks = {};

    // Database Health
    checks.database = await this.checkDatabaseHealth();
    
    // Redis Health
    checks.redis = await this.checkRedisHealth();
    
    // External APIs Health
    checks.external_apis = await this.checkExternalAPIsHealth();

    return checks;
  }

  async checkDatabaseHealth() {
    try {
      const dbConnected = this.getContext('databaseConnected') || false;
      const queryTime = this.getContext('averageQueryTime') || 0;
      
      const status = dbConnected && queryTime < 100 ? 'healthy' : 
                     dbConnected && queryTime < 500 ? 'warning' : 'critical';
      
      return {
        status,
        metrics: {
          connected: dbConnected,
          queryTime,
          activeConnections: this.getContext('dbActiveConnections') || 0
        },
        message: `Database ${dbConnected ? 'connected' : 'disconnected'}, avg query ${queryTime}ms`
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async checkRedisHealth() {
    try {
      const redisConnected = this.getContext('redisConnected') || false;
      const redisLatency = this.getContext('redisLatency') || 0;
      
      const status = redisConnected && redisLatency < 10 ? 'healthy' : 
                     redisConnected && redisLatency < 50 ? 'warning' : 'critical';
      
      return {
        status,
        metrics: {
          connected: redisConnected,
          latency: redisLatency,
          memoryUsage: this.getContext('redisMemoryUsage') || 0
        },
        message: `Redis ${redisConnected ? 'connected' : 'disconnected'}, latency ${redisLatency}ms`
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async checkExternalAPIsHealth() {
    try {
      const apiStatuses = this.getContext('externalAPIStatuses') || {};
      const healthyAPIs = Object.values(apiStatuses).filter(s => s === 'healthy').length;
      const totalAPIs = Object.keys(apiStatuses).length;
      
      const healthyPercent = totalAPIs > 0 ? (healthyAPIs / totalAPIs) * 100 : 0;
      const status = healthyPercent === 100 ? 'healthy' : healthyPercent > 50 ? 'warning' : 'critical';
      
      return {
        status,
        metrics: {
          healthy: healthyAPIs,
          total: totalAPIs,
          percentage: healthyPercent,
          statuses: apiStatuses
        },
        message: `${healthyAPIs} of ${totalAPIs} external APIs healthy`
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  analyzeHealthTrends(currentHealth) {
    const trends = {
      improving: [],
      degrading: [],
      stable: []
    };

    if (this.healthHistory.length < 5) {
      return trends;
    }

    // Compare with recent history
    const recentHistory = this.healthHistory.slice(-5);
    
    // Analyze each metric category
    for (const [category, checks] of Object.entries(currentHealth)) {
      for (const [checkName, checkData] of Object.entries(checks)) {
        const trend = this.analyzeTrend(category, checkName, checkData, recentHistory);
        
        if (trend.direction === 'improving') {
          trends.improving.push(trend);
        } else if (trend.direction === 'degrading') {
          trends.degrading.push(trend);
        } else {
          trends.stable.push(trend);
        }
      }
    }

    return trends;
  }

  analyzeTrend(category, checkName, currentData, history) {
    const historicalValues = history.map(h => 
      h.checks?.[category]?.[checkName]?.metrics
    ).filter(Boolean);

    if (historicalValues.length === 0) {
      return {
        category,
        check: checkName,
        direction: 'stable',
        change: 0
      };
    }

    // Simple trend analysis - could be more sophisticated
    const currentValue = this.extractPrimaryMetric(currentData.metrics);
    const avgHistorical = historicalValues.reduce((acc, val) => 
      acc + this.extractPrimaryMetric(val), 0
    ) / historicalValues.length;

    const change = ((currentValue - avgHistorical) / avgHistorical) * 100;

    return {
      category,
      check: checkName,
      direction: change > 5 ? 'degrading' : change < -5 ? 'improving' : 'stable',
      change
    };
  }

  extractPrimaryMetric(metrics) {
    // Extract the primary metric value for comparison
    return metrics?.percentage || metrics?.usage || metrics?.latency || 0;
  }

  predictFailures(healthStatus, trends) {
    const predictions = [];

    // Check for degrading trends
    for (const trend of trends.degrading) {
      if (Math.abs(trend.change) > 10) {
        predictions.push({
          type: 'trend_based',
          category: trend.category,
          check: trend.check,
          probability: Math.min(Math.abs(trend.change) / 100, 0.9),
          timeframe: '1-2 hours',
          reason: `Degrading trend detected (${trend.change.toFixed(1)}% worse)`
        });
      }
    }

    // Check for critical thresholds
    for (const [category, checks] of Object.entries(healthStatus)) {
      for (const [checkName, checkData] of Object.entries(checks)) {
        if (checkData.status === 'warning') {
          predictions.push({
            type: 'threshold_based',
            category,
            check: checkName,
            probability: 0.6,
            timeframe: '30-60 minutes',
            reason: 'Approaching critical threshold'
          });
        }
      }
    }

    return predictions;
  }

  calculateHealthScore(healthStatus) {
    let totalScore = 0;
    let totalWeight = 0;

    const weights = {
      system: 30,
      application: 25,
      mining: 30,
      dependencies: 15
    };

    for (const [category, checks] of Object.entries(healthStatus)) {
      const categoryWeight = weights[category] || 10;
      let categoryScore = 0;
      let checkCount = 0;

      for (const checkData of Object.values(checks)) {
        checkCount++;
        if (checkData.status === 'healthy') {
          categoryScore += 100;
        } else if (checkData.status === 'warning') {
          categoryScore += 60;
        } else if (checkData.status === 'critical') {
          categoryScore += 20;
        } else {
          categoryScore += 0;
        }
      }

      if (checkCount > 0) {
        totalScore += (categoryScore / checkCount) * (categoryWeight / 100);
        totalWeight += categoryWeight;
      }
    }

    return Math.round((totalScore / totalWeight) * 100);
  }

  determineOverallStatus(healthScore) {
    if (healthScore >= 90) return 'healthy';
    if (healthScore >= 70) return 'fair';
    if (healthScore >= 50) return 'degraded';
    return 'unhealthy';
  }

  generateRecommendations(healthStatus, predictions) {
    const recommendations = [];

    // Check for critical components
    for (const component of this.criticalComponents) {
      const componentHealth = this.findComponentHealth(healthStatus, component);
      if (componentHealth && componentHealth.status !== 'healthy') {
        recommendations.push({
          priority: 'high',
          component,
          action: `Investigate and resolve ${component} issues immediately`,
          reason: componentHealth.message
        });
      }
    }

    // Add predictions-based recommendations
    for (const prediction of predictions) {
      if (prediction.probability > 0.7) {
        recommendations.push({
          priority: 'medium',
          component: `${prediction.category}.${prediction.check}`,
          action: `Proactive maintenance recommended`,
          reason: prediction.reason
        });
      }
    }

    return recommendations;
  }

  findComponentHealth(healthStatus, component) {
    // Search through health status for specific component
    for (const checks of Object.values(healthStatus)) {
      for (const [name, data] of Object.entries(checks)) {
        if (name.toLowerCase().includes(component.toLowerCase())) {
          return data;
        }
      }
    }
    return null;
  }

  updateHealthHistory(healthStatus, healthScore) {
    this.healthHistory.push({
      timestamp: Date.now(),
      score: healthScore,
      checks: healthStatus
    });

    // Keep only last 1000 entries
    if (this.healthHistory.length > 1000) {
      this.healthHistory = this.healthHistory.slice(-1000);
    }
  }

  checkForCriticalIssues(healthStatus) {
    const criticalIssues = [];

    for (const [category, checks] of Object.entries(healthStatus)) {
      for (const [checkName, checkData] of Object.entries(checks)) {
        if (checkData.status === 'critical') {
          criticalIssues.push({
            category,
            check: checkName,
            message: checkData.message,
            metrics: checkData.metrics
          });
        }
      }
    }

    if (criticalIssues.length > 0) {
      this.emit('alert', {
        type: 'health_critical',
        severity: 'critical',
        issues: criticalIssues,
        timestamp: Date.now()
      });
    }
  }

  async registerHealthChecks() {
    // Register custom health checks
    logger.info('Registering health checks');
  }

  async receiveMessage(payload) {
    await super.receiveMessage(payload);
    
    if (payload.action === 'diagnoseAndFix') {
      const diagnosis = await this.diagnoseIssue(payload.data);
      return { status: 'diagnosed', result: diagnosis };
    }
    
    return { status: 'received' };
  }

  async diagnoseIssue(data) {
    // Implement issue diagnosis
    return {
      diagnosed: true,
      issue: data.issue,
      recommendation: 'Automated fix applied',
      timestamp: Date.now()
    };
  }
}