import { createStructuredLogger } from '../core/structured-logger.js';
import { predictiveAnalytics } from './predictive-analytics.js';
import { agentManager } from '../agents/agent-manager.js';

const logger = createStructuredLogger('MLOptimization');

/**
 * Machine Learning Optimization Engine
 * Real-time optimization based on predictive analytics
 */
export class MLOptimizationEngine {
  constructor(options = {}) {
    this.optimizationInterval = options.optimizationInterval || 300000; // 5 minutes
    this.confidenceThreshold = options.confidenceThreshold || 0.7;
    
    this.optimizers = {
      resourceAllocation: new ResourceAllocationOptimizer(),
      minerDistribution: new MinerDistributionOptimizer(),
      feeAdjustment: new DynamicFeeOptimizer(),
      powerManagement: new PowerManagementOptimizer(),
      networkTopology: new NetworkTopologyOptimizer()
    };
    
    this.optimizationHistory = [];
    this.isOptimizing = false;
    this.optimizationTimer = null;
    
    this.setupOptimizers();
  }

  setupOptimizers() {
    // Configure each optimizer
    this.optimizers.resourceAllocation.configure({
      maxCPU: 0.85,
      maxMemory: 0.9,
      bufferSize: 0.1
    });
    
    this.optimizers.minerDistribution.configure({
      maxMinersPerNode: 1000,
      loadBalancingStrategy: 'weighted-round-robin'
    });
    
    this.optimizers.feeAdjustment.configure({
      minFee: 0.005,
      maxFee: 0.03,
      adjustmentStep: 0.001
    });
    
    this.optimizers.powerManagement.configure({
      peakHours: { start: 14, end: 22 },
      offPeakDiscount: 0.3
    });
    
    this.optimizers.networkTopology.configure({
      maxLatency: 100, // ms
      redundancyFactor: 2
    });
  }

  async startOptimization() {
    if (this.optimizationTimer) {
      logger.warn('ML optimization already running');
      return;
    }

    logger.info('Starting ML optimization engine');
    
    // Wait for predictive analytics to be ready
    await this.waitForPredictions();
    
    // Start optimization cycle
    this.optimizationTimer = setInterval(async () => {
      await this.runOptimizationCycle();
    }, this.optimizationInterval);
    
    // Run initial optimization
    await this.runOptimizationCycle();
  }

  stopOptimization() {
    if (this.optimizationTimer) {
      clearInterval(this.optimizationTimer);
      this.optimizationTimer = null;
    }
    
    logger.info('ML optimization stopped');
  }

  async waitForPredictions() {
    let attempts = 0;
    while (attempts < 10) {
      const analytics = predictiveAnalytics.getAnalytics();
      if (analytics.predictionsCount > 0) {
        logger.info('Predictions available, starting optimization');
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, 5000));
      attempts++;
    }
    
    logger.warn('Starting optimization without predictions');
  }

  async runOptimizationCycle() {
    if (this.isOptimizing) {
      logger.warn('Optimization cycle already in progress');
      return;
    }

    this.isOptimizing = true;
    logger.info('Running ML optimization cycle');
    
    try {
      const predictions = this.getPredictions();
      const currentState = await this.getCurrentSystemState();
      const optimizations = [];
      
      // Run each optimizer
      for (const [name, optimizer] of Object.entries(this.optimizers)) {
        try {
          const result = await optimizer.optimize(predictions, currentState);
          if (result && result.confidence >= this.confidenceThreshold) {
            optimizations.push({
              optimizer: name,
              ...result
            });
          }
        } catch (error) {
          logger.error(`Optimizer ${name} failed:`, error);
        }
      }
      
      // Apply optimizations
      await this.applyOptimizations(optimizations);
      
      // Record history
      this.recordOptimizationHistory(optimizations);
      
    } catch (error) {
      logger.error('Error during optimization cycle:', error);
    } finally {
      this.isOptimizing = false;
    }
  }

  getPredictions() {
    return {
      hashrate: predictiveAnalytics.getPrediction('hashrate'),
      difficulty: predictiveAnalytics.getPrediction('difficulty'),
      minerBehavior: predictiveAnalytics.getPrediction('minerBehavior'),
      systemLoad: predictiveAnalytics.getPrediction('systemLoad'),
      profitability: predictiveAnalytics.getPrediction('profitability')
    };
  }

  async getCurrentSystemState() {
    const agents = agentManager.getAllAgents();
    
    return {
      agentStatuses: agentManager.getAgentStatuses(),
      activeAgents: agents.filter(a => a.state === 'running').length,
      systemMetrics: this.getSystemMetrics(),
      timestamp: Date.now()
    };
  }

  async applyOptimizations(optimizations) {
    logger.info(`Applying ${optimizations.length} optimizations`);
    
    for (const optimization of optimizations) {
      try {
        await this.executeOptimization(optimization);
        logger.info(`Applied optimization: ${optimization.optimizer}`);
      } catch (error) {
        logger.error(`Failed to apply optimization ${optimization.optimizer}:`, error);
      }
    }
  }

  async executeOptimization(optimization) {
    switch (optimization.optimizer) {
      case 'resourceAllocation':
        await this.applyResourceAllocation(optimization);
        break;
      
      case 'minerDistribution':
        await this.applyMinerDistribution(optimization);
        break;
      
      case 'feeAdjustment':
        await this.applyFeeAdjustment(optimization);
        break;
      
      case 'powerManagement':
        await this.applyPowerManagement(optimization);
        break;
      
      case 'networkTopology':
        await this.applyNetworkTopology(optimization);
        break;
    }
  }

  async applyResourceAllocation(optimization) {
    // Send to scaling agent
    const scalingAgent = agentManager.getAgent('AutoScaler');
    if (scalingAgent) {
      await scalingAgent.receiveMessage({
        from: 'MLOptimizationEngine',
        action: 'adjustResources',
        data: optimization.actions
      });
    }
  }

  async applyMinerDistribution(optimization) {
    // Implement load balancing changes
    logger.info('Applying miner distribution optimization', optimization);
  }

  async applyFeeAdjustment(optimization) {
    // Implement dynamic fee adjustment
    logger.info('Adjusting pool fees', {
      currentFee: optimization.currentFee,
      newFee: optimization.recommendedFee
    });
  }

  async applyPowerManagement(optimization) {
    // Implement power optimization
    const performanceAgent = agentManager.getAgent('PerformanceOptimizer');
    if (performanceAgent) {
      await performanceAgent.receiveMessage({
        from: 'MLOptimizationEngine',
        action: 'optimizePower',
        data: optimization.powerSettings
      });
    }
  }

  async applyNetworkTopology(optimization) {
    // Implement network topology changes
    logger.info('Optimizing network topology', optimization);
  }

  recordOptimizationHistory(optimizations) {
    this.optimizationHistory.push({
      timestamp: Date.now(),
      optimizations,
      applied: optimizations.length
    });
    
    // Keep only last 100 entries
    if (this.optimizationHistory.length > 100) {
      this.optimizationHistory = this.optimizationHistory.slice(-100);
    }
  }

  getSystemMetrics() {
    // Placeholder for system metrics
    return {
      cpu: 0.5,
      memory: 0.6,
      network: 0.4,
      activeConnections: 150
    };
  }

  getOptimizationStats() {
    const recent = this.optimizationHistory.slice(-10);
    
    return {
      totalOptimizations: this.optimizationHistory.length,
      recentOptimizations: recent,
      averageOptimizationsPerCycle: recent.reduce((sum, h) => sum + h.applied, 0) / recent.length,
      isOptimizing: this.isOptimizing,
      optimizerStatus: Object.entries(this.optimizers).map(([name, opt]) => ({
        name,
        enabled: opt.enabled !== false,
        lastRun: opt.lastRun || null
      }))
    };
  }
}

/**
 * Resource Allocation Optimizer
 * Dynamically allocates computational resources
 */
class ResourceAllocationOptimizer {
  constructor() {
    this.params = {};
    this.lastAllocation = null;
  }

  configure(params) {
    this.params = params;
  }

  async optimize(predictions, currentState) {
    if (!predictions.systemLoad) return null;
    
    const peakLoad = predictions.systemLoad.peakLoad;
    const currentCPU = currentState.systemMetrics.cpu;
    const currentMemory = currentState.systemMetrics.memory;
    
    // Calculate required resources
    const requiredCPU = Math.min(this.params.maxCPU, peakLoad * 1.2);
    const requiredMemory = Math.min(this.params.maxMemory, peakLoad * 1.3);
    
    // Check if adjustment needed
    if (Math.abs(requiredCPU - currentCPU) < 0.1 && 
        Math.abs(requiredMemory - currentMemory) < 0.1) {
      return null;
    }
    
    const actions = {
      cpu: {
        current: currentCPU,
        target: requiredCPU,
        action: requiredCPU > currentCPU ? 'increase' : 'decrease'
      },
      memory: {
        current: currentMemory,
        target: requiredMemory,
        action: requiredMemory > currentMemory ? 'increase' : 'decrease'
      }
    };
    
    this.lastRun = Date.now();
    
    return {
      actions,
      impact: 'medium',
      confidence: predictions.systemLoad.confidence || 0.8,
      estimatedImprovement: this.calculateImprovement(actions)
    };
  }

  calculateImprovement(actions) {
    const cpuImprovement = Math.abs(actions.cpu.target - actions.cpu.current) * 0.3;
    const memoryImprovement = Math.abs(actions.memory.target - actions.memory.current) * 0.2;
    
    return cpuImprovement + memoryImprovement;
  }
}

/**
 * Miner Distribution Optimizer
 * Optimizes how miners are distributed across nodes
 */
class MinerDistributionOptimizer {
  constructor() {
    this.params = {};
    this.distribution = new Map();
  }

  configure(params) {
    this.params = params;
  }

  async optimize(predictions, currentState) {
    if (!predictions.minerBehavior) return null;
    
    const activeAgents = currentState.activeAgents;
    const churnRisk = predictions.minerBehavior.churnRisk;
    
    // Calculate optimal distribution
    const optimalDistribution = this.calculateOptimalDistribution(
      activeAgents,
      churnRisk,
      predictions.minerBehavior.activityPrediction
    );
    
    this.lastRun = Date.now();
    
    return {
      currentDistribution: this.getCurrentDistribution(),
      optimalDistribution,
      rebalanceNeeded: this.isRebalanceNeeded(optimalDistribution),
      confidence: predictions.minerBehavior.confidence || 0.7
    };
  }

  calculateOptimalDistribution(agentCount, churnRisk, activityPrediction) {
    // Simple distribution strategy
    const baseLoad = Math.floor(this.params.maxMinersPerNode * (1 - churnRisk));
    
    return {
      minersPerNode: baseLoad,
      reserveCapacity: Math.floor(baseLoad * 0.2),
      peakTimeAdjustment: activityPrediction.peak ? 1.3 : 1.0
    };
  }

  getCurrentDistribution() {
    // Placeholder
    return {
      minersPerNode: 800,
      utilizationRate: 0.8
    };
  }

  isRebalanceNeeded(optimalDistribution) {
    const current = this.getCurrentDistribution();
    return Math.abs(current.minersPerNode - optimalDistribution.minersPerNode) > 100;
  }
}

/**
 * Dynamic Fee Optimizer
 * Adjusts pool fees based on market conditions
 */
class DynamicFeeOptimizer {
  constructor() {
    this.params = {};
    this.currentFee = 0.01;
  }

  configure(params) {
    this.params = params;
  }

  async optimize(predictions, currentState) {
    if (!predictions.profitability) return null;
    
    const margin = predictions.profitability.margin;
    const breakEvenPrice = predictions.profitability.breakEvenPrice;
    const currentPrice = predictions.profitability.currentPrice;
    
    // Calculate optimal fee
    let recommendedFee = this.currentFee;
    
    if (margin < 0.1) {
      // Low margin, reduce fees to retain miners
      recommendedFee = Math.max(this.params.minFee, this.currentFee - this.params.adjustmentStep);
    } else if (margin > 0.3 && currentPrice > breakEvenPrice * 1.5) {
      // High margin, can increase fees slightly
      recommendedFee = Math.min(this.params.maxFee, this.currentFee + this.params.adjustmentStep);
    }
    
    if (Math.abs(recommendedFee - this.currentFee) < 0.0001) {
      return null;
    }
    
    this.lastRun = Date.now();
    
    return {
      currentFee: this.currentFee,
      recommendedFee,
      reason: this.getFeeAdjustmentReason(margin),
      expectedImpact: this.calculateFeeImpact(recommendedFee),
      confidence: predictions.profitability.confidence || 0.75
    };
  }

  getFeeAdjustmentReason(margin) {
    if (margin < 0.1) return 'low_profitability';
    if (margin > 0.3) return 'high_profitability';
    return 'market_conditions';
  }

  calculateFeeImpact(newFee) {
    const feeDiff = newFee - this.currentFee;
    return {
      revenueChange: feeDiff * 100, // Percentage
      minerRetention: feeDiff < 0 ? 'positive' : 'neutral'
    };
  }
}

/**
 * Power Management Optimizer
 * Optimizes power consumption based on costs and efficiency
 */
class PowerManagementOptimizer {
  constructor() {
    this.params = {};
    this.powerProfile = 'balanced';
  }

  configure(params) {
    this.params = params;
  }

  async optimize(predictions, currentState) {
    if (!predictions.systemLoad || !predictions.profitability) return null;
    
    const currentHour = new Date().getHours();
    const isPeakHours = currentHour >= this.params.peakHours.start && 
                       currentHour <= this.params.peakHours.end;
    
    const margin = predictions.profitability.margin;
    const expectedLoad = predictions.systemLoad.peakLoad;
    
    // Determine optimal power profile
    let recommendedProfile = 'balanced';
    const powerSettings = {};
    
    if (isPeakHours && margin < 0.15) {
      recommendedProfile = 'efficiency';
      powerSettings.cpuGovernor = 'powersave';
      powerSettings.gpuPowerLimit = 0.8;
    } else if (!isPeakHours && margin > 0.25) {
      recommendedProfile = 'performance';
      powerSettings.cpuGovernor = 'performance';
      powerSettings.gpuPowerLimit = 1.0;
    } else {
      powerSettings.cpuGovernor = 'ondemand';
      powerSettings.gpuPowerLimit = 0.9;
    }
    
    if (recommendedProfile === this.powerProfile) {
      return null;
    }
    
    this.lastRun = Date.now();
    
    return {
      currentProfile: this.powerProfile,
      recommendedProfile,
      powerSettings,
      estimatedSavings: this.calculatePowerSavings(recommendedProfile),
      confidence: 0.85
    };
  }

  calculatePowerSavings(profile) {
    const basePower = 3000; // kW
    const savings = {
      'efficiency': basePower * 0.2,
      'balanced': basePower * 0.1,
      'performance': 0
    };
    
    return savings[profile] || 0;
  }
}

/**
 * Network Topology Optimizer
 * Optimizes network connections and routing
 */
class NetworkTopologyOptimizer {
  constructor() {
    this.params = {};
    this.currentTopology = 'mesh';
  }

  configure(params) {
    this.params = params;
  }

  async optimize(predictions, currentState) {
    if (!predictions.minerBehavior) return null;
    
    const connectionCount = currentState.systemMetrics.activeConnections;
    const churnRisk = predictions.minerBehavior.churnRisk;
    
    // Simple topology optimization
    let recommendedTopology = this.currentTopology;
    const topologyChanges = [];
    
    if (connectionCount > 500 && churnRisk > 0.3) {
      recommendedTopology = 'hierarchical';
      topologyChanges.push({
        action: 'add_relay_nodes',
        count: Math.ceil(connectionCount / 200)
      });
    } else if (connectionCount < 100) {
      recommendedTopology = 'full_mesh';
      topologyChanges.push({
        action: 'increase_peer_connections',
        targetConnections: 50
      });
    }
    
    if (recommendedTopology === this.currentTopology && topologyChanges.length === 0) {
      return null;
    }
    
    this.lastRun = Date.now();
    
    return {
      currentTopology: this.currentTopology,
      recommendedTopology,
      changes: topologyChanges,
      expectedLatencyImprovement: this.calculateLatencyImprovement(recommendedTopology),
      confidence: 0.7
    };
  }

  calculateLatencyImprovement(topology) {
    const improvements = {
      'hierarchical': 0.2,
      'full_mesh': -0.1,
      'mesh': 0
    };
    
    return improvements[topology] || 0;
  }
}

// Export singleton instance
export const mlOptimizationEngine = new MLOptimizationEngine();