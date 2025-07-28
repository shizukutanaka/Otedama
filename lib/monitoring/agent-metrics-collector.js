import { logger } from '../core/logger.js';
import { agentManager } from '../agents/agent-manager.js';
import { agentEventBus } from '../agents/event-bus.js';

/**
 * Advanced Agent Metrics Collector
 * Collects, processes, and stores detailed metrics from the agent system
 */
export class AgentMetricsCollector {
  constructor(options = {}) {
    this.collectInterval = options.collectInterval || 5000; // 5 seconds
    this.retentionPeriod = options.retentionPeriod || 86400000; // 24 hours
    this.maxDataPoints = options.maxDataPoints || 1000;
    
    this.metrics = {
      agents: new Map(),
      system: [],
      eventBus: [],
      coordination: []
    };
    
    this.isCollecting = false;
    this.collectionTimer = null;
    
    this.setupEventListeners();
  }

  setupEventListeners() {
    // Listen to agent execution events
    agentManager.on('agent:execute:start', (agent) => {
      this.recordAgentMetric(agent.name, 'execution_start', {
        timestamp: Date.now(),
        state: agent.state
      });
    });

    agentManager.on('agent:execute:success', (data) => {
      this.recordAgentMetric(data.agent.name, 'execution_success', {
        timestamp: Date.now(),
        executionTime: data.agent.lastExecutionTime,
        result: data.result
      });
    });

    agentManager.on('agent:execute:error', (data) => {
      this.recordAgentMetric(data.agent.name, 'execution_error', {
        timestamp: Date.now(),
        error: data.error.message,
        stackTrace: data.error.stack
      });
    });

    agentManager.on('alert', (alertData) => {
      this.recordSystemMetric('agent_alert', {
        timestamp: Date.now(),
        agent: alertData.agent,
        alert: alertData.alert
      });
    });

    // Listen to event bus metrics
    agentEventBus.on('message-processed', (data) => {
      this.recordEventBusMetric('message_processed', {
        timestamp: Date.now(),
        messageType: data.type,
        source: data.source,
        processingTime: data.processingTime
      });
    });
  }

  recordAgentMetric(agentName, metricType, data) {
    if (!this.metrics.agents.has(agentName)) {
      this.metrics.agents.set(agentName, {
        execution_start: [],
        execution_success: [],
        execution_error: [],
        performance: [],
        custom: []
      });
    }

    const agentMetrics = this.metrics.agents.get(agentName);
    
    if (!agentMetrics[metricType]) {
      agentMetrics[metricType] = [];
    }
    
    agentMetrics[metricType].push(data);
    
    // Keep only recent data
    this.trimMetricArray(agentMetrics[metricType]);
  }

  recordSystemMetric(metricType, data) {
    this.metrics.system.push({
      type: metricType,
      ...data
    });
    
    this.trimMetricArray(this.metrics.system);
  }

  recordEventBusMetric(metricType, data) {
    this.metrics.eventBus.push({
      type: metricType,
      ...data
    });
    
    this.trimMetricArray(this.metrics.eventBus);
  }

  trimMetricArray(array) {
    const now = Date.now();
    
    // Remove old entries based on retention period
    while (array.length > 0 && (now - array[0].timestamp) > this.retentionPeriod) {
      array.shift();
    }
    
    // Limit total number of data points
    if (array.length > this.maxDataPoints) {
      array.splice(0, array.length - this.maxDataPoints);
    }
  }

  startCollection() {
    if (this.isCollecting) {
      logger.warn('Metrics collection already started');
      return;
    }

    this.isCollecting = true;
    this.collectionTimer = setInterval(() => {
      this.collectSystemMetrics();
      this.collectAgentPerformanceMetrics();
      this.collectCoordinationMetrics();
    }, this.collectInterval);

    logger.info('Agent metrics collection started');
  }

  stopCollection() {
    if (!this.isCollecting) {
      return;
    }

    this.isCollecting = false;
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
      this.collectionTimer = null;
    }

    logger.info('Agent metrics collection stopped');
  }

  collectSystemMetrics() {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    this.recordSystemMetric('system_snapshot', {
      timestamp: Date.now(),
      memory: {
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        external: memUsage.external,
        rss: memUsage.rss
      },
      cpu: {
        user: cpuUsage.user,
        system: cpuUsage.system
      },
      uptime: process.uptime(),
      agentCount: agentManager.agents.size,
      eventBusStats: agentEventBus.getStats()
    });
  }

  collectAgentPerformanceMetrics() {
    for (const [name, agent] of agentManager.agents) {
      const metrics = {
        timestamp: Date.now(),
        state: agent.state,
        runCount: agent.runCount,
        successCount: agent.metrics.successCount,
        failureCount: agent.metrics.failureCount,
        averageExecutionTime: agent.metrics.averageExecutionTime,
        lastExecutionTime: agent.lastExecutionTime,
        errorCount: agent.errors.length,
        dependencyCount: Object.keys(agent.dependencies || {}).length
      };

      this.recordAgentMetric(name, 'performance', metrics);
    }
  }

  collectCoordinationMetrics() {
    const coordinationData = {
      timestamp: Date.now(),
      rulesCount: agentManager.coordinationRules.length,
      eventBusSubscriptions: agentEventBus.subscriptions.size,
      routingRules: agentEventBus.routingRules.size,
      messageQueueLength: agentEventBus.messageQueue.length
    };

    this.metrics.coordination.push(coordinationData);
    this.trimMetricArray(this.metrics.coordination);
  }

  getAgentMetrics(agentName, metricType = null, timeRange = null) {
    const agentMetrics = this.metrics.agents.get(agentName);
    if (!agentMetrics) {
      return null;
    }

    if (!metricType) {
      return agentMetrics;
    }

    let metrics = agentMetrics[metricType] || [];
    
    if (timeRange) {
      const now = Date.now();
      const startTime = now - timeRange;
      metrics = metrics.filter(m => m.timestamp >= startTime);
    }

    return metrics;
  }

  getSystemMetrics(metricType = null, timeRange = null) {
    let metrics = this.metrics.system;
    
    if (metricType) {
      metrics = metrics.filter(m => m.type === metricType);
    }
    
    if (timeRange) {
      const now = Date.now();
      const startTime = now - timeRange;
      metrics = metrics.filter(m => m.timestamp >= startTime);
    }

    return metrics;
  }

  getEventBusMetrics(timeRange = null) {
    let metrics = this.metrics.eventBus;
    
    if (timeRange) {
      const now = Date.now();
      const startTime = now - timeRange;
      metrics = metrics.filter(m => m.timestamp >= startTime);
    }

    return metrics;
  }

  getCoordinationMetrics(timeRange = null) {
    let metrics = this.metrics.coordination;
    
    if (timeRange) {
      const now = Date.now();
      const startTime = now - timeRange;
      metrics = metrics.filter(m => m.timestamp >= startTime);
    }

    return metrics;
  }

  generateReport(options = {}) {
    const timeRange = options.timeRange || 3600000; // 1 hour default
    const includeAgents = options.includeAgents !== false;
    const includeSystem = options.includeSystem !== false;
    const includeEventBus = options.includeEventBus !== false;
    
    const report = {
      generatedAt: Date.now(),
      timeRange,
      summary: this.generateSummary(timeRange)
    };

    if (includeAgents) {
      report.agents = this.generateAgentReport(timeRange);
    }

    if (includeSystem) {
      report.system = this.getSystemMetrics(null, timeRange);
    }

    if (includeEventBus) {
      report.eventBus = this.getEventBusMetrics(timeRange);
    }

    return report;
  }

  generateSummary(timeRange) {
    const systemMetrics = this.getSystemMetrics('system_snapshot', timeRange);
    const agentCount = agentManager.agents.size;
    
    let totalExecutions = 0;
    let totalSuccesses = 0;
    let totalFailures = 0;
    let totalAlerts = 0;

    for (const [name, agent] of agentManager.agents) {
      const agentMetrics = this.getAgentMetrics(name, 'performance', timeRange);
      if (agentMetrics.length > 0) {
        const latest = agentMetrics[agentMetrics.length - 1];
        totalExecutions += latest.runCount;
        totalSuccesses += latest.successCount;
        totalFailures += latest.failureCount;
      }
    }

    const alerts = this.getSystemMetrics('agent_alert', timeRange);
    totalAlerts = alerts.length;

    return {
      agentCount,
      totalExecutions,
      totalSuccesses,
      totalFailures,
      totalAlerts,
      successRate: totalExecutions > 0 ? (totalSuccesses / totalExecutions) * 100 : 0,
      systemMetricsCount: systemMetrics.length,
      averageMemoryUsage: this.calculateAverageMemoryUsage(systemMetrics)
    };
  }

  generateAgentReport(timeRange) {
    const agentReport = {};

    for (const [name, agent] of agentManager.agents) {
      const performanceMetrics = this.getAgentMetrics(name, 'performance', timeRange);
      const executions = this.getAgentMetrics(name, 'execution_success', timeRange);
      const errors = this.getAgentMetrics(name, 'execution_error', timeRange);

      agentReport[name] = {
        type: agent.type,
        currentState: agent.state,
        performanceHistory: performanceMetrics,
        recentExecutions: executions.slice(-10),
        recentErrors: errors.slice(-5),
        summary: {
          executionCount: executions.length,
          errorCount: errors.length,
          averageExecutionTime: this.calculateAverageExecutionTime(executions)
        }
      };
    }

    return agentReport;
  }

  calculateAverageMemoryUsage(systemMetrics) {
    if (systemMetrics.length === 0) return 0;
    
    const totalMemory = systemMetrics.reduce((sum, metric) => 
      sum + metric.memory.heapUsed, 0);
    
    return Math.round(totalMemory / systemMetrics.length);
  }

  calculateAverageExecutionTime(executions) {
    if (executions.length === 0) return 0;
    
    const totalTime = executions.reduce((sum, exec) => 
      sum + (exec.executionTime || 0), 0);
    
    return Math.round(totalTime / executions.length);
  }

  exportMetrics(format = 'json', options = {}) {
    const report = this.generateReport(options);
    
    switch (format.toLowerCase()) {
      case 'json':
        return JSON.stringify(report, null, 2);
      
      case 'csv':
        return this.convertToCSV(report);
      
      case 'summary':
        return this.formatSummary(report.summary);
      
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  convertToCSV(report) {
    const lines = ['timestamp,metric_type,agent_name,value'];
    
    // Add system metrics
    report.system.forEach(metric => {
      lines.push(`${metric.timestamp},system,system,${JSON.stringify(metric)}`);
    });
    
    // Add agent metrics
    Object.entries(report.agents).forEach(([agentName, agentData]) => {
      agentData.performanceHistory.forEach(perf => {
        lines.push(`${perf.timestamp},performance,${agentName},${JSON.stringify(perf)}`);
      });
    });
    
    return lines.join('\n');
  }

  formatSummary(summary) {
    return `
Agent System Summary
===================
Agent Count: ${summary.agentCount}
Total Executions: ${summary.totalExecutions}
Success Rate: ${summary.successRate.toFixed(2)}%
Total Alerts: ${summary.totalAlerts}
Average Memory Usage: ${(summary.averageMemoryUsage / 1024 / 1024).toFixed(2)} MB
    `.trim();
  }

  getStats() {
    return {
      totalAgentMetrics: Array.from(this.metrics.agents.values())
        .reduce((sum, agentMetrics) => {
          return sum + Object.values(agentMetrics)
            .reduce((agentSum, metricArray) => agentSum + metricArray.length, 0);
        }, 0),
      systemMetricsCount: this.metrics.system.length,
      eventBusMetricsCount: this.metrics.eventBus.length,
      coordinationMetricsCount: this.metrics.coordination.length,
      isCollecting: this.isCollecting,
      collectionInterval: this.collectInterval,
      retentionPeriod: this.retentionPeriod
    };
  }

  cleanup() {
    const now = Date.now();
    
    // Clean up old agent metrics
    for (const [agentName, agentMetrics] of this.metrics.agents) {
      Object.keys(agentMetrics).forEach(metricType => {
        this.trimMetricArray(agentMetrics[metricType]);
      });
    }
    
    // Clean up system metrics
    this.trimMetricArray(this.metrics.system);
    this.trimMetricArray(this.metrics.eventBus);
    this.trimMetricArray(this.metrics.coordination);
    
    logger.debug('Metrics cleanup completed');
  }
}

// Export singleton instance
export const agentMetricsCollector = new AgentMetricsCollector();