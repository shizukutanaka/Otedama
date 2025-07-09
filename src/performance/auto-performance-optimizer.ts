/**
 * Automatic Performance Optimization System
 * Real-time performance tuning and optimization
 * 
 * Features:
 * - Auto-tuning of pool parameters
 * - Dynamic resource allocation
 * - Real-time load balancing
 * - Memory optimization
 * - Network optimization
 * - Database query optimization
 * - Cache management
 * - Predictive scaling
 */

import { EventEmitter } from 'events';
import { createComponentLogger } from '../logging/logger';
import { AdvancedMonitoringSystem } from '../monitoring/advanced-monitoring';
import { AdvancedAIOptimizationSystem } from '../ai/advanced-ai-system';

const logger = createComponentLogger('PerformanceOptimizer');

interface PerformanceProfile {
  id: string;
  name: string;
  description: string;
  parameters: OptimizationParameters;
  conditions: OptimizationCondition[];
  priority: number;
  active: boolean;
}

interface OptimizationParameters {
  // Worker thread management
  workerThreads: {
    min: number;
    max: number;
    target: number;
    scalingFactor: number;
  };
  
  // Memory management
  memory: {
    heapSizeLimit: number;
    gcThreshold: number;
    cacheSize: number;
    bufferPoolSize: number;
  };
  
  // Network optimization
  network: {
    connectionPoolSize: number;
    keepAliveTimeout: number;
    socketTimeout: number;
    tcpNoDelay: boolean;
    tcpKeepAlive: boolean;
  };
  
  // Database optimization
  database: {
    connectionPoolSize: number;
    queryTimeout: number;
    batchSize: number;
    indexHints: string[];
  };
  
  // Cache configuration
  cache: {
    maxEntries: number;
    ttl: number;
    strategy: 'lru' | 'lfu' | 'fifo' | 'adaptive';
    compressionEnabled: boolean;
  };
  
  // Share processing
  shareProcessing: {
    batchSize: number;
    parallelWorkers: number;
    validationTimeout: number;
    queueSize: number;
  };
}

interface OptimizationCondition {
  metric: string;
  operator: '>' | '<' | '=' | '>=' | '<=';
  threshold: number;
  duration: number; // ms
}

interface PerformanceMetrics {
  timestamp: number;
  
  // System metrics
  cpuUsage: number;
  memoryUsage: number;
  gcPressure: number;
  
  // Application metrics
  throughput: number;
  latency: number;
  errorRate: number;
  queueLength: number;
  
  // Resource utilization
  workerUtilization: number;
  connectionUtilization: number;
  cacheHitRate: number;
  dbQueryTime: number;
}

interface OptimizationAction {
  type: 'parameter_change' | 'resource_scaling' | 'cache_tuning' | 'gc_tuning';
  parameter: string;
  oldValue: any;
  newValue: any;
  reason: string;
  expectedImprovement: number;
  timestamp: number;
}

interface OptimizationResult {
  success: boolean;
  actions: OptimizationAction[];
  performance: {
    before: PerformanceMetrics;
    after: PerformanceMetrics;
    improvement: number;
  };
  rollbackPlan?: () => Promise<void>;
}

export class AutoPerformanceOptimizer extends EventEmitter {
  private monitoring: AdvancedMonitoringSystem;
  private aiSystem: AdvancedAIOptimizationSystem;
  
  private profiles = new Map<string, PerformanceProfile>();
  private activeProfile?: PerformanceProfile;
  private currentParameters: OptimizationParameters;
  
  private metricsHistory: PerformanceMetrics[] = [];
  private optimizationHistory: OptimizationResult[] = [];
  
  private isOptimizing = false;
  private optimizationInterval: NodeJS.Timeout | null = null;
  
  // Performance tracking
  private performanceBaseline: PerformanceMetrics | null = null;
  private adaptiveLearning = true;
  
  // Resource managers
  private workerManager: WorkerManager;
  private memoryManager: MemoryManager;
  private networkManager: NetworkManager;
  private databaseManager: DatabaseManager;
  private cacheManager: CacheManager;

  constructor(
    monitoring: AdvancedMonitoringSystem,
    aiSystem: AdvancedAIOptimizationSystem
  ) {
    super();
    
    this.monitoring = monitoring;
    this.aiSystem = aiSystem;
    
    this.workerManager = new WorkerManager();
    this.memoryManager = new MemoryManager();
    this.networkManager = new NetworkManager();
    this.databaseManager = new DatabaseManager();
    this.cacheManager = new CacheManager();
    
    this.currentParameters = this.getDefaultParameters();
    this.initializeProfiles();
    
    logger.info('Auto Performance Optimizer initialized');
  }

  /**
   * Start automatic optimization
   */
  startOptimization(intervalMs: number = 60000): void {
    if (this.optimizationInterval) {
      this.stopOptimization();
    }

    this.optimizationInterval = setInterval(async () => {
      if (!this.isOptimizing) {
        await this.runOptimizationCycle();
      }
    }, intervalMs);

    // Establish performance baseline
    this.establishBaseline();

    logger.info('Automatic optimization started', { intervalMs });
    this.emit('optimization:started');
  }

  /**
   * Stop automatic optimization
   */
  stopOptimization(): void {
    if (this.optimizationInterval) {
      clearInterval(this.optimizationInterval);
      this.optimizationInterval = null;
    }

    logger.info('Automatic optimization stopped');
    this.emit('optimization:stopped');
  }

  /**
   * Run a single optimization cycle
   */
  async runOptimizationCycle(): Promise<OptimizationResult | null> {
    if (this.isOptimizing) {
      logger.warn('Optimization already in progress, skipping cycle');
      return null;
    }

    this.isOptimizing = true;
    logger.debug('Starting optimization cycle');

    try {
      // Collect current metrics
      const currentMetrics = await this.collectMetrics();
      this.metricsHistory.push(currentMetrics);

      // Limit history size
      if (this.metricsHistory.length > 1000) {
        this.metricsHistory = this.metricsHistory.slice(-500);
      }

      // Check if optimization is needed
      const needsOptimization = await this.assessOptimizationNeed(currentMetrics);
      if (!needsOptimization) {
        logger.debug('No optimization needed');
        return null;
      }

      // Generate optimization plan
      const optimizationPlan = await this.generateOptimizationPlan(currentMetrics);
      if (optimizationPlan.actions.length === 0) {
        logger.debug('No optimization actions planned');
        return null;
      }

      // Execute optimization
      const result = await this.executeOptimization(optimizationPlan, currentMetrics);
      
      this.optimizationHistory.push(result);
      
      // Limit optimization history
      if (this.optimizationHistory.length > 100) {
        this.optimizationHistory = this.optimizationHistory.slice(-50);
      }

      logger.info('Optimization cycle completed', {
        actionsExecuted: result.actions.length,
        improvement: result.performance.improvement
      });

      this.emit('optimization:completed', result);
      return result;

    } catch (error) {
      logger.error('Optimization cycle failed', error as Error);
      this.emit('optimization:error', error);
      return null;
    } finally {
      this.isOptimizing = false;
    }
  }

  /**
   * Force optimization with specific parameters
   */
  async forceOptimization(targetParameters: Partial<OptimizationParameters>): Promise<OptimizationResult> {
    const currentMetrics = await this.collectMetrics();
    
    const actions: OptimizationAction[] = [];
    for (const [key, value] of Object.entries(targetParameters)) {
      actions.push({
        type: 'parameter_change',
        parameter: key,
        oldValue: (this.currentParameters as any)[key],
        newValue: value,
        reason: 'Manual optimization',
        expectedImprovement: 0,
        timestamp: Date.now()
      });
    }

    return await this.executeOptimization({ actions }, currentMetrics);
  }

  /**
   * Apply performance profile
   */
  async applyProfile(profileId: string): Promise<boolean> {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      logger.error('Profile not found', { profileId });
      return false;
    }

    try {
      await this.forceOptimization(profile.parameters);
      this.activeProfile = profile;
      
      logger.info('Performance profile applied', { 
        profileId, 
        name: profile.name 
      });
      
      this.emit('profile:applied', profile);
      return true;
    } catch (error) {
      logger.error('Failed to apply profile', error as Error, { profileId });
      return false;
    }
  }

  /**
   * Create custom performance profile
   */
  createProfile(profile: Omit<PerformanceProfile, 'id'>): string {
    const id = `profile_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const fullProfile: PerformanceProfile = { id, ...profile };
    
    this.profiles.set(id, fullProfile);
    
    logger.info('Performance profile created', { id, name: profile.name });
    this.emit('profile:created', fullProfile);
    
    return id;
  }

  /**
   * Private implementation methods
   */
  private async collectMetrics(): Promise<PerformanceMetrics> {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    return {
      timestamp: Date.now(),
      
      // System metrics
      cpuUsage: (cpuUsage.user + cpuUsage.system) / 1000000, // Convert to seconds
      memoryUsage: memUsage.heapUsed,
      gcPressure: this.memoryManager.getGCPressure(),
      
      // Application metrics
      throughput: await this.calculateThroughput(),
      latency: await this.calculateAverageLatency(),
      errorRate: await this.calculateErrorRate(),
      queueLength: await this.getQueueLength(),
      
      // Resource utilization
      workerUtilization: this.workerManager.getUtilization(),
      connectionUtilization: this.networkManager.getConnectionUtilization(),
      cacheHitRate: this.cacheManager.getHitRate(),
      dbQueryTime: this.databaseManager.getAverageQueryTime()
    };
  }

  private async assessOptimizationNeed(metrics: PerformanceMetrics): Promise<boolean> {
    if (!this.performanceBaseline) {
      return false; // No baseline to compare against
    }

    // Check for performance degradation
    const performanceDelta = this.calculatePerformanceDelta(metrics, this.performanceBaseline);
    
    if (performanceDelta < -0.1) { // 10% degradation
      logger.debug('Performance degradation detected', { delta: performanceDelta });
      return true;
    }

    // Check resource utilization thresholds
    if (metrics.cpuUsage > 80 || 
        metrics.memoryUsage > this.currentParameters.memory.heapSizeLimit * 0.9 ||
        metrics.queueLength > this.currentParameters.shareProcessing.queueSize * 0.8) {
      logger.debug('Resource utilization threshold exceeded');
      return true;
    }

    // Check active profile conditions
    if (this.activeProfile) {
      for (const condition of this.activeProfile.conditions) {
        if (this.checkCondition(condition, metrics)) {
          logger.debug('Profile condition triggered', { condition });
          return true;
        }
      }
    }

    return false;
  }

  private async generateOptimizationPlan(metrics: PerformanceMetrics): Promise<{ actions: OptimizationAction[] }> {
    const actions: OptimizationAction[] = [];

    // Use AI to generate optimization recommendations
    try {
      const aiRecommendations = await this.aiSystem.generateOptimizationRecommendations(metrics);
      
      for (const recommendation of aiRecommendations) {
        const action = this.convertRecommendationToAction(recommendation);
        if (action) {
          actions.push(action);
        }
      }
    } catch (error) {
      logger.error('Failed to get AI recommendations', error as Error);
    }

    // Add rule-based optimizations
    actions.push(...this.generateRuleBasedOptimizations(metrics));

    // Sort actions by expected improvement
    actions.sort((a, b) => b.expectedImprovement - a.expectedImprovement);

    return { actions: actions.slice(0, 5) }; // Limit to top 5 actions
  }

  private generateRuleBasedOptimizations(metrics: PerformanceMetrics): OptimizationAction[] {
    const actions: OptimizationAction[] = [];

    // Worker thread optimization
    if (metrics.workerUtilization > 90) {
      const newWorkerCount = Math.min(
        this.currentParameters.workerThreads.max,
        this.currentParameters.workerThreads.target + 2
      );
      
      if (newWorkerCount > this.currentParameters.workerThreads.target) {
        actions.push({
          type: 'resource_scaling',
          parameter: 'workerThreads.target',
          oldValue: this.currentParameters.workerThreads.target,
          newValue: newWorkerCount,
          reason: 'High worker utilization',
          expectedImprovement: 15,
          timestamp: Date.now()
        });
      }
    }

    // Memory optimization
    if (metrics.gcPressure > 0.1) {
      const newGcThreshold = Math.max(
        this.currentParameters.memory.gcThreshold * 0.8,
        50 * 1024 * 1024 // Minimum 50MB
      );
      
      actions.push({
        type: 'gc_tuning',
        parameter: 'memory.gcThreshold',
        oldValue: this.currentParameters.memory.gcThreshold,
        newValue: newGcThreshold,
        reason: 'High GC pressure',
        expectedImprovement: 10,
        timestamp: Date.now()
      });
    }

    // Cache optimization
    if (metrics.cacheHitRate < 0.8) {
      const newCacheSize = Math.min(
        this.currentParameters.cache.maxEntries * 1.5,
        1000000 // Maximum 1M entries
      );
      
      actions.push({
        type: 'cache_tuning',
        parameter: 'cache.maxEntries',
        oldValue: this.currentParameters.cache.maxEntries,
        newValue: newCacheSize,
        reason: 'Low cache hit rate',
        expectedImprovement: 8,
        timestamp: Date.now()
      });
    }

    // Network optimization
    if (metrics.connectionUtilization > 85) {
      const newPoolSize = Math.min(
        this.currentParameters.network.connectionPoolSize * 1.2,
        1000
      );
      
      actions.push({
        type: 'parameter_change',
        parameter: 'network.connectionPoolSize',
        oldValue: this.currentParameters.network.connectionPoolSize,
        newValue: Math.floor(newPoolSize),
        reason: 'High connection utilization',
        expectedImprovement: 12,
        timestamp: Date.now()
      });
    }

    return actions;
  }

  private async executeOptimization(
    plan: { actions: OptimizationAction[] },
    beforeMetrics: PerformanceMetrics
  ): Promise<OptimizationResult> {
    const rollbackActions: (() => Promise<void>)[] = [];
    const executedActions: OptimizationAction[] = [];

    try {
      // Execute each optimization action
      for (const action of plan.actions) {
        const rollback = await this.executeAction(action);
        if (rollback) {
          rollbackActions.push(rollback);
          executedActions.push(action);
        }
      }

      // Wait for changes to take effect
      await this.sleep(5000);

      // Collect metrics after optimization
      const afterMetrics = await this.collectMetrics();
      
      // Calculate improvement
      const improvement = this.calculatePerformanceDelta(afterMetrics, beforeMetrics);

      const result: OptimizationResult = {
        success: true,
        actions: executedActions,
        performance: {
          before: beforeMetrics,
          after: afterMetrics,
          improvement
        },
        rollbackPlan: async () => {
          for (const rollback of rollbackActions.reverse()) {
            await rollback();
          }
        }
      };

      // If optimization made things worse, rollback
      if (improvement < -0.05) { // 5% degradation
        logger.warn('Optimization caused degradation, rolling back', { improvement });
        if (result.rollbackPlan) {
          await result.rollbackPlan();
        }
        result.success = false;
      }

      return result;

    } catch (error) {
      logger.error('Optimization execution failed, rolling back', error as Error);
      
      // Rollback on error
      for (const rollback of rollbackActions.reverse()) {
        try {
          await rollback();
        } catch (rollbackError) {
          logger.error('Rollback failed', rollbackError as Error);
        }
      }

      return {
        success: false,
        actions: executedActions,
        performance: {
          before: beforeMetrics,
          after: beforeMetrics,
          improvement: 0
        }
      };
    }
  }

  private async executeAction(action: OptimizationAction): Promise<(() => Promise<void>) | null> {
    logger.debug('Executing optimization action', action);

    switch (action.type) {
      case 'resource_scaling':
        return await this.executeResourceScaling(action);
      case 'parameter_change':
        return await this.executeParameterChange(action);
      case 'cache_tuning':
        return await this.executeCacheTuning(action);
      case 'gc_tuning':
        return await this.executeGCTuning(action);
      default:
        logger.warn('Unknown action type', { type: action.type });
        return null;
    }
  }

  private async executeResourceScaling(action: OptimizationAction): Promise<(() => Promise<void>) | null> {
    const oldValue = action.oldValue;
    
    switch (action.parameter) {
      case 'workerThreads.target':
        await this.workerManager.setWorkerCount(action.newValue);
        this.updateParameter('workerThreads.target', action.newValue);
        
        return async () => {
          await this.workerManager.setWorkerCount(oldValue);
          this.updateParameter('workerThreads.target', oldValue);
        };
      
      default:
        return null;
    }
  }

  private async executeParameterChange(action: OptimizationAction): Promise<(() => Promise<void>) | null> {
    const oldValue = action.oldValue;
    
    switch (action.parameter) {
      case 'network.connectionPoolSize':
        await this.networkManager.setConnectionPoolSize(action.newValue);
        this.updateParameter('network.connectionPoolSize', action.newValue);
        
        return async () => {
          await this.networkManager.setConnectionPoolSize(oldValue);
          this.updateParameter('network.connectionPoolSize', oldValue);
        };
      
      default:
        this.updateParameter(action.parameter, action.newValue);
        return async () => {
          this.updateParameter(action.parameter, oldValue);
        };
    }
  }

  private async executeCacheTuning(action: OptimizationAction): Promise<(() => Promise<void>) | null> {
    const oldValue = action.oldValue;
    
    switch (action.parameter) {
      case 'cache.maxEntries':
        await this.cacheManager.setMaxEntries(action.newValue);
        this.updateParameter('cache.maxEntries', action.newValue);
        
        return async () => {
          await this.cacheManager.setMaxEntries(oldValue);
          this.updateParameter('cache.maxEntries', oldValue);
        };
      
      default:
        return null;
    }
  }

  private async executeGCTuning(action: OptimizationAction): Promise<(() => Promise<void>) | null> {
    const oldValue = action.oldValue;
    
    switch (action.parameter) {
      case 'memory.gcThreshold':
        await this.memoryManager.setGCThreshold(action.newValue);
        this.updateParameter('memory.gcThreshold', action.newValue);
        
        return async () => {
          await this.memoryManager.setGCThreshold(oldValue);
          this.updateParameter('memory.gcThreshold', oldValue);
        };
      
      default:
        return null;
    }
  }

  private updateParameter(path: string, value: any): void {
    const parts = path.split('.');
    let current: any = this.currentParameters;
    
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current)) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    
    current[parts[parts.length - 1]] = value;
  }

  private convertRecommendationToAction(recommendation: any): OptimizationAction | null {
    // Convert AI recommendation to optimization action
    // This would be implemented based on the AI system's output format
    return null;
  }

  private calculatePerformanceDelta(current: PerformanceMetrics, baseline: PerformanceMetrics): number {
    // Weighted performance score calculation
    const weights = {
      throughput: 0.3,
      latency: -0.3, // Negative because lower is better
      errorRate: -0.2, // Negative because lower is better
      cpuUsage: -0.1, // Negative because lower is better
      memoryUsage: -0.1 // Negative because lower is better
    };

    let score = 0;
    
    if (baseline.throughput > 0) {
      score += weights.throughput * ((current.throughput - baseline.throughput) / baseline.throughput);
    }
    
    if (baseline.latency > 0) {
      score += weights.latency * ((current.latency - baseline.latency) / baseline.latency);
    }
    
    if (baseline.errorRate > 0) {
      score += weights.errorRate * ((current.errorRate - baseline.errorRate) / baseline.errorRate);
    }
    
    score += weights.cpuUsage * ((current.cpuUsage - baseline.cpuUsage) / Math.max(baseline.cpuUsage, 1));
    score += weights.memoryUsage * ((current.memoryUsage - baseline.memoryUsage) / Math.max(baseline.memoryUsage, 1));

    return score;
  }

  private checkCondition(condition: OptimizationCondition, metrics: PerformanceMetrics): boolean {
    const value = (metrics as any)[condition.metric];
    if (value === undefined) return false;

    switch (condition.operator) {
      case '>': return value > condition.threshold;
      case '<': return value < condition.threshold;
      case '=': return value === condition.threshold;
      case '>=': return value >= condition.threshold;
      case '<=': return value <= condition.threshold;
      default: return false;
    }
  }

  private async establishBaseline(): Promise<void> {
    // Wait a bit for system to stabilize
    await this.sleep(10000);
    
    this.performanceBaseline = await this.collectMetrics();
    logger.info('Performance baseline established', this.performanceBaseline);
  }

  private async calculateThroughput(): Promise<number> {
    // Calculate shares per second from monitoring system
    return 1000; // Placeholder
  }

  private async calculateAverageLatency(): Promise<number> {
    // Calculate average processing latency
    return 50; // Placeholder
  }

  private async calculateErrorRate(): Promise<number> {
    // Calculate error rate from monitoring system
    return 0.01; // Placeholder
  }

  private async getQueueLength(): Promise<number> {
    // Get current queue length
    return 100; // Placeholder
  }

  private getDefaultParameters(): OptimizationParameters {
    return {
      workerThreads: {
        min: 2,
        max: require('os').cpus().length * 2,
        target: require('os').cpus().length,
        scalingFactor: 1.5
      },
      memory: {
        heapSizeLimit: 1024 * 1024 * 1024, // 1GB
        gcThreshold: 100 * 1024 * 1024, // 100MB
        cacheSize: 256 * 1024 * 1024, // 256MB
        bufferPoolSize: 64 * 1024 * 1024 // 64MB
      },
      network: {
        connectionPoolSize: 100,
        keepAliveTimeout: 60000,
        socketTimeout: 30000,
        tcpNoDelay: true,
        tcpKeepAlive: true
      },
      database: {
        connectionPoolSize: 20,
        queryTimeout: 10000,
        batchSize: 1000,
        indexHints: []
      },
      cache: {
        maxEntries: 100000,
        ttl: 3600000, // 1 hour
        strategy: 'lru',
        compressionEnabled: true
      },
      shareProcessing: {
        batchSize: 100,
        parallelWorkers: 4,
        validationTimeout: 5000,
        queueSize: 10000
      }
    };
  }

  private initializeProfiles(): void {
    // High performance profile
    const highPerformanceProfile: PerformanceProfile = {
      id: 'high_performance',
      name: 'High Performance',
      description: 'Optimized for maximum throughput',
      parameters: {
        ...this.getDefaultParameters(),
        workerThreads: {
          min: 4,
          max: require('os').cpus().length * 4,
          target: require('os').cpus().length * 2,
          scalingFactor: 2.0
        },
        memory: {
          heapSizeLimit: 2048 * 1024 * 1024, // 2GB
          gcThreshold: 200 * 1024 * 1024, // 200MB
          cacheSize: 512 * 1024 * 1024, // 512MB
          bufferPoolSize: 128 * 1024 * 1024 // 128MB
        }
      },
      conditions: [
        { metric: 'throughput', operator: '>', threshold: 5000, duration: 60000 }
      ],
      priority: 1,
      active: false
    };

    // Low latency profile
    const lowLatencyProfile: PerformanceProfile = {
      id: 'low_latency',
      name: 'Low Latency',
      description: 'Optimized for minimal latency',
      parameters: {
        ...this.getDefaultParameters(),
        shareProcessing: {
          batchSize: 10,
          parallelWorkers: 8,
          validationTimeout: 1000,
          queueSize: 1000
        },
        cache: {
          maxEntries: 50000,
          ttl: 1800000, // 30 minutes
          strategy: 'lfu',
          compressionEnabled: false
        }
      },
      conditions: [
        { metric: 'latency', operator: '<', threshold: 10, duration: 30000 }
      ],
      priority: 2,
      active: false
    };

    // Energy efficient profile
    const energyEfficientProfile: PerformanceProfile = {
      id: 'energy_efficient',
      name: 'Energy Efficient',
      description: 'Optimized for low power consumption',
      parameters: {
        ...this.getDefaultParameters(),
        workerThreads: {
          min: 1,
          max: require('os').cpus().length,
          target: Math.max(1, Math.floor(require('os').cpus().length / 2)),
          scalingFactor: 1.2
        },
        memory: {
          heapSizeLimit: 512 * 1024 * 1024, // 512MB
          gcThreshold: 50 * 1024 * 1024, // 50MB
          cacheSize: 128 * 1024 * 1024, // 128MB
          bufferPoolSize: 32 * 1024 * 1024 // 32MB
        }
      },
      conditions: [
        { metric: 'cpuUsage', operator: '<', threshold: 50, duration: 120000 }
      ],
      priority: 3,
      active: false
    };

    this.profiles.set(highPerformanceProfile.id, highPerformanceProfile);
    this.profiles.set(lowLatencyProfile.id, lowLatencyProfile);
    this.profiles.set(energyEfficientProfile.id, energyEfficientProfile);

    logger.debug('Performance profiles initialized', {
      profiles: Array.from(this.profiles.keys())
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get optimization statistics
   */
  getOptimizationStats(): {
    active: boolean;
    currentProfile?: string;
    optimizationHistory: number;
    lastOptimization?: Date;
    currentParameters: OptimizationParameters;
    performance: {
      baseline?: PerformanceMetrics;
      current?: PerformanceMetrics;
      improvement?: number;
    };
  } {
    const lastOptimization = this.optimizationHistory.length > 0 ?
      new Date(this.optimizationHistory[this.optimizationHistory.length - 1].performance.after.timestamp) :
      undefined;

    const currentMetrics = this.metricsHistory.length > 0 ?
      this.metricsHistory[this.metricsHistory.length - 1] :
      undefined;

    const improvement = this.performanceBaseline && currentMetrics ?
      this.calculatePerformanceDelta(currentMetrics, this.performanceBaseline) :
      undefined;

    return {
      active: this.optimizationInterval !== null,
      currentProfile: this.activeProfile?.id,
      optimizationHistory: this.optimizationHistory.length,
      lastOptimization,
      currentParameters: this.currentParameters,
      performance: {
        baseline: this.performanceBaseline || undefined,
        current: currentMetrics,
        improvement
      }
    };
  }

  /**
   * Get available profiles
   */
  getProfiles(): PerformanceProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Shutdown optimizer
   */
  shutdown(): void {
    this.stopOptimization();
    this.removeAllListeners();
    logger.info('Auto Performance Optimizer shut down');
  }
}

// Resource manager classes
class WorkerManager {
  private currentWorkerCount = require('os').cpus().length;

  async setWorkerCount(count: number): Promise<void> {
    logger.debug('Adjusting worker count', { from: this.currentWorkerCount, to: count });
    this.currentWorkerCount = count;
    // Implementation would adjust actual worker threads
  }

  getUtilization(): number {
    // Calculate worker utilization
    return Math.random() * 100; // Placeholder
  }
}

class MemoryManager {
  private gcThreshold = 100 * 1024 * 1024; // 100MB

  async setGCThreshold(threshold: number): Promise<void> {
    logger.debug('Adjusting GC threshold', { from: this.gcThreshold, to: threshold });
    this.gcThreshold = threshold;
    // Implementation would adjust GC settings
  }

  getGCPressure(): number {
    // Calculate GC pressure
    return Math.random() * 0.2; // Placeholder
  }
}

class NetworkManager {
  private connectionPoolSize = 100;

  async setConnectionPoolSize(size: number): Promise<void> {
    logger.debug('Adjusting connection pool size', { from: this.connectionPoolSize, to: size });
    this.connectionPoolSize = size;
    // Implementation would adjust connection pool
  }

  getConnectionUtilization(): number {
    // Calculate connection utilization
    return Math.random() * 100; // Placeholder
  }
}

class DatabaseManager {
  getAverageQueryTime(): number {
    // Calculate average query time
    return Math.random() * 100; // Placeholder
  }
}

class CacheManager {
  private maxEntries = 100000;

  async setMaxEntries(entries: number): Promise<void> {
    logger.debug('Adjusting cache size', { from: this.maxEntries, to: entries });
    this.maxEntries = entries;
    // Implementation would adjust cache size
  }

  getHitRate(): number {
    // Calculate cache hit rate
    return 0.7 + Math.random() * 0.3; // Placeholder
  }
}

export default AutoPerformanceOptimizer;
