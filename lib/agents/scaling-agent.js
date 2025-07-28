import { BaseAgent } from './base-agent.js';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('Agent');
// import { autoScaler } from '../core/auto-scaling.js';

export class ScalingAgent extends BaseAgent {
  constructor(config = {}) {
    super({
      ...config,
      name: config.name || 'ScalingAgent',
      type: 'scaling',
      interval: config.interval || 180000 // 3 minutes
    });
    
    this.scalingPolicies = {
      cpu: {
        scaleUpThreshold: 80,
        scaleDownThreshold: 20,
        cooldownPeriod: 300000 // 5 minutes
      },
      memory: {
        scaleUpThreshold: 85,
        scaleDownThreshold: 30,
        cooldownPeriod: 300000
      },
      connections: {
        scaleUpThreshold: 90,
        scaleDownThreshold: 40,
        cooldownPeriod: 180000 // 3 minutes
      },
      miners: {
        minersPerWorker: 100,
        maxWorkersPerPool: 10,
        cooldownPeriod: 600000 // 10 minutes
      }
    };
    
    this.currentScale = {
      workers: 1,
      threads: 4,
      connections: 1000,
      pools: 1
    };
    
    this.scalingHistory = [];
    this.lastScalingAction = null;
    this.predictiveScaling = config.predictiveScaling !== false;
  }

  async onInitialize() {
    logger.info('Initializing Scaling Agent');
    await this.loadScalingConfig();
    await this.detectCurrentScale();
  }

  async run() {
    // Get current metrics
    const monitor = this.getDependency('monitor');
    const metrics = monitor ? monitor.getMetricsSummary().current : await this.getMetrics();
    
    // Analyze scaling needs
    const scalingAnalysis = this.analyzeScalingNeeds(metrics);
    
    // Predict future scaling needs
    const predictions = this.predictiveScaling ? 
      await this.predictScalingNeeds(metrics) : null;
    
    // Determine scaling actions
    const scalingActions = this.determineScalingActions(scalingAnalysis, predictions);
    
    // Execute scaling actions
    const results = await this.executeScaling(scalingActions);
    
    // Update scaling history
    this.updateScalingHistory(scalingActions, results);
    
    return {
      currentScale: this.currentScale,
      analysis: scalingAnalysis,
      predictions,
      actions: scalingActions,
      results,
      efficiency: this.calculateEfficiency(metrics)
    };
  }

  analyzeScalingNeeds(metrics) {
    const analysis = {
      cpu: this.analyzeCPUScaling(metrics),
      memory: this.analyzeMemoryScaling(metrics),
      connections: this.analyzeConnectionScaling(metrics),
      mining: this.analyzeMiningScaling(metrics),
      overall: 'stable'
    };

    // Determine overall scaling need
    const needs = [
      analysis.cpu.need,
      analysis.memory.need,
      analysis.connections.need,
      analysis.mining.need
    ];

    if (needs.includes('scale_up')) {
      analysis.overall = 'scale_up';
    } else if (needs.includes('scale_down') && !needs.includes('scale_up')) {
      analysis.overall = 'scale_down';
    }

    return analysis;
  }

  analyzeCPUScaling(metrics) {
    const cpuUsage = metrics.system?.cpu?.usage || 0;
    const policy = this.scalingPolicies.cpu;
    
    let need = 'none';
    let reason = '';
    
    if (cpuUsage > policy.scaleUpThreshold) {
      need = 'scale_up';
      reason = `CPU usage ${cpuUsage.toFixed(1)}% exceeds threshold`;
    } else if (cpuUsage < policy.scaleDownThreshold) {
      need = 'scale_down';
      reason = `CPU usage ${cpuUsage.toFixed(1)}% below threshold`;
    }
    
    return {
      usage: cpuUsage,
      need,
      reason,
      recommendation: this.getCPUScalingRecommendation(cpuUsage)
    };
  }

  analyzeMemoryScaling(metrics) {
    const memoryUsage = metrics.system?.memory?.percentage || 0;
    const policy = this.scalingPolicies.memory;
    
    let need = 'none';
    let reason = '';
    
    if (memoryUsage > policy.scaleUpThreshold) {
      need = 'scale_up';
      reason = `Memory usage ${memoryUsage.toFixed(1)}% exceeds threshold`;
    } else if (memoryUsage < policy.scaleDownThreshold) {
      need = 'scale_down';
      reason = `Memory usage ${memoryUsage.toFixed(1)}% below threshold`;
    }
    
    return {
      usage: memoryUsage,
      need,
      reason,
      recommendation: this.getMemoryScalingRecommendation(memoryUsage)
    };
  }

  analyzeConnectionScaling(metrics) {
    const activeConnections = metrics.network?.connections || 0;
    const maxConnections = this.currentScale.connections;
    const connectionUsage = (activeConnections / maxConnections) * 100;
    const policy = this.scalingPolicies.connections;
    
    let need = 'none';
    let reason = '';
    
    if (connectionUsage > policy.scaleUpThreshold) {
      need = 'scale_up';
      reason = `Connection usage ${connectionUsage.toFixed(1)}% exceeds threshold`;
    } else if (connectionUsage < policy.scaleDownThreshold) {
      need = 'scale_down';
      reason = `Connection usage ${connectionUsage.toFixed(1)}% below threshold`;
    }
    
    return {
      active: activeConnections,
      max: maxConnections,
      usage: connectionUsage,
      need,
      reason
    };
  }

  analyzeMiningScaling(metrics) {
    const connectedMiners = metrics.mining?.connectedMiners || 0;
    const currentWorkers = this.currentScale.workers;
    const policy = this.scalingPolicies.miners;
    const minersPerWorker = connectedMiners / currentWorkers;
    
    let need = 'none';
    let reason = '';
    
    if (minersPerWorker > policy.minersPerWorker) {
      need = 'scale_up';
      reason = `${minersPerWorker.toFixed(0)} miners per worker exceeds threshold`;
    } else if (minersPerWorker < policy.minersPerWorker * 0.3 && currentWorkers > 1) {
      need = 'scale_down';
      reason = `${minersPerWorker.toFixed(0)} miners per worker below efficiency threshold`;
    }
    
    return {
      miners: connectedMiners,
      workers: currentWorkers,
      minersPerWorker,
      need,
      reason
    };
  }

  async predictScalingNeeds(metrics) {
    const predictions = {
      timeframe: '30_minutes',
      cpu: await this.predictCPUUsage(metrics),
      memory: await this.predictMemoryUsage(metrics),
      connections: await this.predictConnections(metrics),
      miners: await this.predictMinerCount(metrics)
    };

    return predictions;
  }

  async predictCPUUsage(metrics) {
    // Simple linear prediction based on trend
    const history = this.getMetricHistory('cpu');
    if (history.length < 5) {
      return { predicted: metrics.system?.cpu?.usage || 0, confidence: 0.5 };
    }

    const trend = this.calculateTrend(history);
    const current = metrics.system?.cpu?.usage || 0;
    const predicted = Math.max(0, Math.min(100, current + (trend * 6))); // 30 min = 6 intervals
    
    return {
      current,
      predicted,
      trend,
      confidence: 0.7
    };
  }

  async predictMemoryUsage(metrics) {
    const history = this.getMetricHistory('memory');
    if (history.length < 5) {
      return { predicted: metrics.system?.memory?.percentage || 0, confidence: 0.5 };
    }

    const trend = this.calculateTrend(history);
    const current = metrics.system?.memory?.percentage || 0;
    const predicted = Math.max(0, Math.min(100, current + (trend * 6)));
    
    return {
      current,
      predicted,
      trend,
      confidence: 0.7
    };
  }

  async predictConnections(metrics) {
    const history = this.getMetricHistory('connections');
    if (history.length < 5) {
      return { predicted: metrics.network?.connections || 0, confidence: 0.5 };
    }

    const trend = this.calculateTrend(history);
    const current = metrics.network?.connections || 0;
    const predicted = Math.max(0, current + Math.floor(trend * 6));
    
    return {
      current,
      predicted,
      trend,
      confidence: 0.6
    };
  }

  async predictMinerCount(metrics) {
    const history = this.getMetricHistory('miners');
    if (history.length < 5) {
      return { predicted: metrics.mining?.connectedMiners || 0, confidence: 0.5 };
    }

    // Consider time of day patterns for miner predictions
    const hourOfDay = new Date().getHours();
    const dayPattern = this.getMinerDayPattern(hourOfDay);
    
    const trend = this.calculateTrend(history);
    const current = metrics.mining?.connectedMiners || 0;
    const predicted = Math.max(0, current + Math.floor(trend * 6 * dayPattern));
    
    return {
      current,
      predicted,
      trend,
      dayPattern,
      confidence: 0.8
    };
  }

  determineScalingActions(analysis, predictions) {
    const actions = [];

    // Check if we're in cooldown period
    if (this.isInCooldown()) {
      logger.info('Scaling agent in cooldown period');
      return actions;
    }

    // Immediate scaling needs
    if (analysis.overall === 'scale_up') {
      actions.push(...this.getScaleUpActions(analysis));
    } else if (analysis.overall === 'scale_down') {
      actions.push(...this.getScaleDownActions(analysis));
    }

    // Predictive scaling
    if (predictions && this.predictiveScaling) {
      actions.push(...this.getPredictiveActions(predictions));
    }

    return this.prioritizeActions(actions);
  }

  getScaleUpActions(analysis) {
    const actions = [];

    if (analysis.cpu.need === 'scale_up') {
      actions.push({
        type: 'scale_workers',
        direction: 'up',
        component: 'workers',
        amount: 1,
        reason: analysis.cpu.reason,
        priority: 'high'
      });
    }

    if (analysis.memory.need === 'scale_up') {
      actions.push({
        type: 'increase_memory',
        direction: 'up',
        component: 'memory',
        amount: '2GB',
        reason: analysis.memory.reason,
        priority: 'high'
      });
    }

    if (analysis.connections.need === 'scale_up') {
      actions.push({
        type: 'scale_connections',
        direction: 'up',
        component: 'connections',
        amount: 500,
        reason: analysis.connections.reason,
        priority: 'medium'
      });
    }

    if (analysis.mining.need === 'scale_up') {
      actions.push({
        type: 'scale_mining_workers',
        direction: 'up',
        component: 'mining_workers',
        amount: 1,
        reason: analysis.mining.reason,
        priority: 'high'
      });
    }

    return actions;
  }

  getScaleDownActions(analysis) {
    const actions = [];

    if (analysis.cpu.need === 'scale_down' && this.currentScale.workers > 1) {
      actions.push({
        type: 'scale_workers',
        direction: 'down',
        component: 'workers',
        amount: 1,
        reason: analysis.cpu.reason,
        priority: 'low'
      });
    }

    if (analysis.connections.need === 'scale_down' && this.currentScale.connections > 500) {
      actions.push({
        type: 'scale_connections',
        direction: 'down',
        component: 'connections',
        amount: 250,
        reason: analysis.connections.reason,
        priority: 'low'
      });
    }

    if (analysis.mining.need === 'scale_down' && this.currentScale.workers > 1) {
      actions.push({
        type: 'scale_mining_workers',
        direction: 'down',
        component: 'mining_workers',
        amount: 1,
        reason: analysis.mining.reason,
        priority: 'low'
      });
    }

    return actions;
  }

  getPredictiveActions(predictions) {
    const actions = [];

    // CPU prediction
    if (predictions.cpu.predicted > this.scalingPolicies.cpu.scaleUpThreshold) {
      actions.push({
        type: 'preemptive_scale',
        direction: 'up',
        component: 'workers',
        amount: 1,
        reason: `CPU predicted to reach ${predictions.cpu.predicted.toFixed(1)}%`,
        priority: 'medium',
        predictive: true
      });
    }

    // Memory prediction
    if (predictions.memory.predicted > this.scalingPolicies.memory.scaleUpThreshold) {
      actions.push({
        type: 'preemptive_scale',
        direction: 'up',
        component: 'memory',
        amount: '1GB',
        reason: `Memory predicted to reach ${predictions.memory.predicted.toFixed(1)}%`,
        priority: 'medium',
        predictive: true
      });
    }

    // Miner prediction
    if (predictions.miners.predicted > this.currentScale.workers * this.scalingPolicies.miners.minersPerWorker) {
      actions.push({
        type: 'preemptive_scale',
        direction: 'up',
        component: 'mining_workers',
        amount: 1,
        reason: `Miner count predicted to reach ${predictions.miners.predicted}`,
        priority: 'medium',
        predictive: true
      });
    }

    return actions;
  }

  prioritizeActions(actions) {
    // Sort by priority and remove duplicates
    const priorityOrder = { high: 3, medium: 2, low: 1 };
    
    return actions
      .sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority])
      .filter((action, index, self) => 
        index === self.findIndex(a => 
          a.type === action.type && a.component === action.component
        )
      );
  }

  async executeScaling(actions) {
    const results = [];

    for (const action of actions) {
      try {
        const result = await this.executeScalingAction(action);
        results.push({
          action,
          success: true,
          result,
          timestamp: Date.now()
        });
        
        // Update last scaling action
        this.lastScalingAction = {
          timestamp: Date.now(),
          action
        };
        
      } catch (error) {
        logger.error(`Scaling action failed:`, error);
        results.push({
          action,
          success: false,
          error: error.message,
          timestamp: Date.now()
        });
      }
    }

    return results;
  }

  async executeScalingAction(action) {
    logger.info(`Executing scaling action: ${action.type} ${action.direction}`, action);

    switch (action.type) {
      case 'scale_workers':
        return await this.scaleWorkers(action);
        
      case 'increase_memory':
        return await this.adjustMemory(action);
        
      case 'scale_connections':
        return await this.scaleConnections(action);
        
      case 'scale_mining_workers':
        return await this.scaleMiningWorkers(action);
        
      case 'preemptive_scale':
        return await this.executePreemptiveScale(action);
        
      default:
        throw new Error(`Unknown scaling action: ${action.type}`);
    }
  }

  async scaleWorkers(action) {
    const currentWorkers = this.currentScale.workers;
    const newWorkers = action.direction === 'up' ? 
      currentWorkers + action.amount : 
      Math.max(1, currentWorkers - action.amount);
    
    // This would interface with actual worker management
    this.emit('scale:workers', { from: currentWorkers, to: newWorkers });
    
    this.currentScale.workers = newWorkers;
    
    return {
      previousWorkers: currentWorkers,
      newWorkers,
      scaled: true
    };
  }

  async adjustMemory(action) {
    // This would interface with container/VM management
    this.emit('scale:memory', { amount: action.amount, direction: action.direction });
    
    return {
      memoryAdjusted: action.amount,
      direction: action.direction
    };
  }

  async scaleConnections(action) {
    const currentConnections = this.currentScale.connections;
    const newConnections = action.direction === 'up' ? 
      currentConnections + action.amount : 
      Math.max(100, currentConnections - action.amount);
    
    // This would interface with connection pool management
    this.emit('scale:connections', { from: currentConnections, to: newConnections });
    
    this.currentScale.connections = newConnections;
    
    return {
      previousConnections: currentConnections,
      newConnections,
      scaled: true
    };
  }

  async scaleMiningWorkers(action) {
    // This would interface with mining pool management
    const result = await this.scaleMiningPoolWorkers(action);
    
    return result;
  }

  async scaleMiningPoolWorkers(action) {
    const direction = action.direction;
    const amount = action.amount;
    
    // This would interface with actual mining pool
    this.emit('scale:mining', { direction, amount });
    
    return {
      miningWorkersScaled: true,
      direction,
      amount
    };
  }

  async executePreemptiveScale(action) {
    // Execute predictive scaling
    logger.info(`Executing predictive scaling for ${action.component}`);
    
    // Reuse existing scaling methods
    switch (action.component) {
      case 'workers':
        return await this.scaleWorkers(action);
      case 'memory':
        return await this.adjustMemory(action);
      case 'mining_workers':
        return await this.scaleMiningWorkers(action);
      default:
        return { predictiveAction: true, component: action.component };
    }
  }

  calculateEfficiency(metrics) {
    const cpuEfficiency = 100 - Math.abs(50 - (metrics.system?.cpu?.usage || 50));
    const memoryEfficiency = 100 - Math.abs(60 - (metrics.system?.memory?.percentage || 60));
    const connectionEfficiency = this.calculateConnectionEfficiency(metrics);
    
    const overallEfficiency = (cpuEfficiency + memoryEfficiency + connectionEfficiency) / 3;
    
    return {
      cpu: cpuEfficiency,
      memory: memoryEfficiency,
      connections: connectionEfficiency,
      overall: overallEfficiency
    };
  }

  calculateConnectionEfficiency(metrics) {
    const active = metrics.network?.connections || 0;
    const max = this.currentScale.connections;
    const usage = (active / max) * 100;
    
    // Optimal usage is between 40-70%
    if (usage >= 40 && usage <= 70) {
      return 100;
    } else if (usage < 40) {
      return usage * 2.5; // Scale up efficiency as usage increases to 40%
    } else {
      return 100 - ((usage - 70) * 1.5); // Decrease efficiency as usage goes above 70%
    }
  }

  isInCooldown() {
    if (!this.lastScalingAction) return false;
    
    const timeSinceLastAction = Date.now() - this.lastScalingAction.timestamp;
    const cooldownPeriod = Math.min(
      this.scalingPolicies.cpu.cooldownPeriod,
      this.scalingPolicies.memory.cooldownPeriod,
      this.scalingPolicies.connections.cooldownPeriod
    );
    
    return timeSinceLastAction < cooldownPeriod;
  }

  getCPUScalingRecommendation(usage) {
    if (usage > 90) return 'Immediate scaling required';
    if (usage > 80) return 'Consider scaling up soon';
    if (usage < 20) return 'Consider scaling down to save resources';
    return 'CPU usage is optimal';
  }

  getMemoryScalingRecommendation(usage) {
    if (usage > 90) return 'Critical memory pressure, scale immediately';
    if (usage > 85) return 'High memory usage, prepare to scale';
    if (usage < 30) return 'Low memory usage, consider scaling down';
    return 'Memory usage is balanced';
  }

  getMetricHistory(metric) {
    // Get historical data for trend analysis
    // This would interface with monitoring system
    return this.scalingHistory
      .filter(h => h.metrics && h.metrics[metric])
      .map(h => h.metrics[metric])
      .slice(-10);
  }

  calculateTrend(history) {
    if (history.length < 2) return 0;
    
    // Simple linear regression
    const n = history.length;
    const sumX = history.reduce((acc, _, i) => acc + i, 0);
    const sumY = history.reduce((acc, val) => acc + val, 0);
    const sumXY = history.reduce((acc, val, i) => acc + (i * val), 0);
    const sumX2 = history.reduce((acc, _, i) => acc + (i * i), 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    
    return slope;
  }

  getMinerDayPattern(hour) {
    // Typical mining patterns throughout the day
    // Higher activity during off-peak hours
    const patterns = {
      0: 1.2, 1: 1.3, 2: 1.3, 3: 1.2, 4: 1.1, 5: 1.0,
      6: 0.9, 7: 0.8, 8: 0.8, 9: 0.9, 10: 1.0, 11: 1.0,
      12: 1.0, 13: 1.0, 14: 0.9, 15: 0.9, 16: 0.9, 17: 1.0,
      18: 1.1, 19: 1.2, 20: 1.3, 21: 1.3, 22: 1.2, 23: 1.2
    };
    
    return patterns[hour] || 1.0;
  }

  updateScalingHistory(actions, results) {
    this.scalingHistory.push({
      timestamp: Date.now(),
      actions,
      results,
      currentScale: { ...this.currentScale },
      metrics: {
        cpu: this.getContext('cpuUsage'),
        memory: this.getContext('memoryUsage'),
        connections: this.getContext('activeConnections'),
        miners: this.getContext('connectedMiners')
      }
    });

    // Keep only last 200 entries
    if (this.scalingHistory.length > 200) {
      this.scalingHistory = this.scalingHistory.slice(-200);
    }
  }

  async loadScalingConfig() {
    // Load scaling configuration
    logger.info('Loading scaling configuration');
  }

  async detectCurrentScale() {
    // Detect current system scale
    this.currentScale = {
      workers: parseInt(process.env.WORKER_COUNT) || 1,
      threads: parseInt(process.env.THREAD_COUNT) || 4,
      connections: parseInt(process.env.MAX_CONNECTIONS) || 1000,
      pools: parseInt(process.env.POOL_COUNT) || 1
    };
    
    logger.info('Current scale detected:', this.currentScale);
  }

  async getMetrics() {
    // Fallback method to get metrics
    return {
      system: {
        cpu: { usage: 50 },
        memory: { percentage: 60 }
      },
      network: { connections: 100 },
      mining: { connectedMiners: 50 }
    };
  }

  async receiveMessage(payload) {
    await super.receiveMessage(payload);
    
    if (payload.action === 'scaleUp') {
      const result = await this.forceScaleUp(payload.data);
      return { status: 'scaled_up', result };
    }
    
    return { status: 'received' };
  }

  async forceScaleUp(data) {
    // Force immediate scale up
    const action = {
      type: 'scale_workers',
      direction: 'up',
      component: 'workers',
      amount: 1,
      reason: 'Forced scale up',
      priority: 'high'
    };
    
    const result = await this.executeScalingAction(action);
    return result;
  }
}