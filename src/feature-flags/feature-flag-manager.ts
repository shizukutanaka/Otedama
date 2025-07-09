// src/feature-flags/feature-flag-manager.ts
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';
import { EventEmitter } from 'events';
import crypto from 'crypto';

export interface FeatureFlag {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  type: 'boolean' | 'percentage' | 'variant' | 'kill_switch';
  rules: FlagRule[];
  variants?: FlagVariant[];
  metadata: {
    createdAt: Date;
    updatedAt: Date;
    createdBy: string;
    environment: string;
    tags: string[];
  };
  rollout: RolloutConfig;
  dependencies?: string[]; // Other flags this depends on
  schedule?: ScheduleConfig;
}

export interface FlagRule {
  id: string;
  name: string;
  enabled: boolean;
  conditions: Condition[];
  rolloutPercentage: number; // 0-100
  variant?: string;
  priority: number; // Higher priority rules are evaluated first
}

export interface Condition {
  attribute: string;
  operator: 'equals' | 'not_equals' | 'in' | 'not_in' | 'greater_than' | 'less_than' | 'contains' | 'regex';
  value: any;
}

export interface FlagVariant {
  id: string;
  name: string;
  value: any;
  weight: number; // 0-100, all variants should sum to 100
  description?: string;
}

export interface RolloutConfig {
  enabled: boolean;
  percentage: number; // 0-100
  strategy: 'user_id' | 'session_id' | 'random' | 'gradual';
  gradualStep?: number; // Percentage increase per step
  gradualInterval?: number; // Minutes between steps
}

export interface ScheduleConfig {
  enabled: boolean;
  startTime?: Date;
  endTime?: Date;
  timezone: string;
  daysOfWeek?: number[]; // 0-6, where 0 is Sunday
  timeRange?: {
    start: string; // HH:mm format
    end: string;
  };
}

export interface EvaluationContext {
  userId?: string;
  sessionId?: string;
  email?: string;
  role?: string;
  plan?: string;
  country?: string;
  version?: string;
  userAgent?: string;
  ip?: string;
  environment?: string;
  customAttributes?: Record<string, any>;
}

export interface FlagEvaluation {
  flagId: string;
  enabled: boolean;
  variant?: string;
  value?: any;
  rule?: string;
  timestamp: number;
  context: EvaluationContext;
}

export interface FlagMetrics {
  flagId: string;
  totalEvaluations: number;
  enabledEvaluations: number;
  variantDistribution: Record<string, number>;
  uniqueUsers: number;
  lastEvaluated: Date;
  errorCount: number;
}

export interface ExperimentConfig {
  id: string;
  name: string;
  description: string;
  flagId: string;
  hypothesis: string;
  metrics: {
    primary: string[];
    secondary: string[];
  };
  audience: {
    percentage: number;
    conditions: Condition[];
  };
  duration: {
    startDate: Date;
    endDate: Date;
  };
  status: 'draft' | 'running' | 'completed' | 'cancelled';
}

export class FeatureFlagManager extends EventEmitter {
  private logger: Logger;
  private cache: RedisCache;
  private flags: Map<string, FeatureFlag> = new Map();
  private metrics: Map<string, FlagMetrics> = new Map();
  private experiments: Map<string, ExperimentConfig> = new Map();
  private evaluationCache: Map<string, FlagEvaluation> = new Map();
  private cacheExpiry: number = 300000; // 5 minutes
  private refreshInterval: NodeJS.Timeout | null = null;

  constructor(logger: Logger, cache: RedisCache) {
    super();
    this.logger = logger;
    this.cache = cache;
    
    this.startPeriodicRefresh();
    this.loadPersistedFlags();
  }

  private startPeriodicRefresh(): void {
    // Refresh flags from cache every minute
    this.refreshInterval = setInterval(async () => {
      await this.refreshFlags();
    }, 60000);
  }

  private async loadPersistedFlags(): Promise<void> {
    try {
      const flagKeys = await this.cache.keys('flag:*');
      
      for (const key of flagKeys) {
        const flagData = await this.cache.get(key);
        if (flagData) {
          const flag = JSON.parse(flagData) as FeatureFlag;
          // Parse dates
          flag.metadata.createdAt = new Date(flag.metadata.createdAt);
          flag.metadata.updatedAt = new Date(flag.metadata.updatedAt);
          if (flag.schedule?.startTime) {
            flag.schedule.startTime = new Date(flag.schedule.startTime);
          }
          if (flag.schedule?.endTime) {
            flag.schedule.endTime = new Date(flag.schedule.endTime);
          }
          
          this.flags.set(flag.id, flag);
        }
      }

      this.logger.info(`Loaded ${this.flags.size} feature flags from cache`);
    } catch (error) {
      this.logger.error('Failed to load persisted flags:', error);
    }
  }

  private async refreshFlags(): Promise<void> {
    try {
      await this.loadPersistedFlags();
      this.emit('flags-refreshed', this.flags.size);
    } catch (error) {
      this.logger.error('Failed to refresh flags:', error);
    }
  }

  // Flag management
  public async createFlag(flag: Omit<FeatureFlag, 'id' | 'metadata'>): Promise<FeatureFlag> {
    const flagId = this.generateFlagId(flag.name);
    
    const newFlag: FeatureFlag = {
      id: flagId,
      metadata: {
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'system',
        environment: 'production',
        tags: []
      },
      ...flag
    };

    this.flags.set(flagId, newFlag);
    await this.persistFlag(newFlag);

    this.logger.info(`Feature flag created: ${flag.name}`, { flagId });
    this.emit('flag-created', newFlag);

    return newFlag;
  }

  public async updateFlag(flagId: string, updates: Partial<FeatureFlag>): Promise<FeatureFlag> {
    const flag = this.flags.get(flagId);
    if (!flag) {
      throw new Error(`Feature flag ${flagId} not found`);
    }

    const updatedFlag = {
      ...flag,
      ...updates,
      metadata: {
        ...flag.metadata,
        updatedAt: new Date()
      }
    };

    this.flags.set(flagId, updatedFlag);
    await this.persistFlag(updatedFlag);

    // Clear evaluation cache for this flag
    this.clearFlagCache(flagId);

    this.logger.info(`Feature flag updated: ${flag.name}`, { flagId });
    this.emit('flag-updated', updatedFlag);

    return updatedFlag;
  }

  public async deleteFlag(flagId: string): Promise<void> {
    const flag = this.flags.get(flagId);
    if (!flag) {
      throw new Error(`Feature flag ${flagId} not found`);
    }

    this.flags.delete(flagId);
    await this.cache.del(`flag:${flagId}`);
    this.clearFlagCache(flagId);

    this.logger.info(`Feature flag deleted: ${flag.name}`, { flagId });
    this.emit('flag-deleted', { flagId, name: flag.name });
  }

  public getFlag(flagId: string): FeatureFlag | undefined {
    return this.flags.get(flagId);
  }

  public getAllFlags(): FeatureFlag[] {
    return Array.from(this.flags.values());
  }

  public getFlagsByTag(tag: string): FeatureFlag[] {
    return Array.from(this.flags.values()).filter(flag => 
      flag.metadata.tags.includes(tag)
    );
  }

  // Flag evaluation
  public async evaluateFlag(
    flagId: string, 
    context: EvaluationContext = {}
  ): Promise<FlagEvaluation> {
    const cacheKey = this.generateCacheKey(flagId, context);
    
    // Check cache first
    const cached = this.evaluationCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      await this.recordEvaluation(cached);
      return cached;
    }

    const flag = this.flags.get(flagId);
    if (!flag) {
      const defaultEvaluation: FlagEvaluation = {
        flagId,
        enabled: false,
        timestamp: Date.now(),
        context
      };
      
      await this.recordEvaluation(defaultEvaluation);
      return defaultEvaluation;
    }

    try {
      const evaluation = await this.performEvaluation(flag, context);
      
      // Cache the result
      this.evaluationCache.set(cacheKey, evaluation);
      
      // Clean old cache entries
      this.cleanEvaluationCache();
      
      await this.recordEvaluation(evaluation);
      this.emit('flag-evaluated', evaluation);
      
      return evaluation;
    } catch (error) {
      this.logger.error(`Flag evaluation error for ${flagId}:`, error);
      
      const errorEvaluation: FlagEvaluation = {
        flagId,
        enabled: false,
        timestamp: Date.now(),
        context
      };
      
      await this.recordEvaluation(errorEvaluation);
      return errorEvaluation;
    }
  }

  private async performEvaluation(
    flag: FeatureFlag, 
    context: EvaluationContext
  ): Promise<FlagEvaluation> {
    // Check if flag is globally disabled
    if (!flag.enabled) {
      return {
        flagId: flag.id,
        enabled: false,
        timestamp: Date.now(),
        context
      };
    }

    // Check schedule
    if (!this.isWithinSchedule(flag, context)) {
      return {
        flagId: flag.id,
        enabled: false,
        timestamp: Date.now(),
        context
      };
    }

    // Check dependencies
    if (flag.dependencies && flag.dependencies.length > 0) {
      for (const depFlagId of flag.dependencies) {
        const depEvaluation = await this.evaluateFlag(depFlagId, context);
        if (!depEvaluation.enabled) {
          return {
            flagId: flag.id,
            enabled: false,
            timestamp: Date.now(),
            context
          };
        }
      }
    }

    // Evaluate rules (sorted by priority)
    const sortedRules = [...flag.rules].sort((a, b) => b.priority - a.priority);
    
    for (const rule of sortedRules) {
      if (!rule.enabled) continue;
      
      if (this.evaluateConditions(rule.conditions, context)) {
        // Rule matches, check rollout
        if (this.shouldRollout(rule.rolloutPercentage, context)) {
          return {
            flagId: flag.id,
            enabled: true,
            variant: rule.variant,
            value: this.getVariantValue(flag, rule.variant),
            rule: rule.name,
            timestamp: Date.now(),
            context
          };
        }
      }
    }

    // No rules matched or rollout failed, check default rollout
    if (flag.rollout.enabled && this.shouldRollout(flag.rollout.percentage, context)) {
      const variant = this.selectVariant(flag, context);
      return {
        flagId: flag.id,
        enabled: true,
        variant: variant?.id,
        value: variant?.value,
        timestamp: Date.now(),
        context
      };
    }

    return {
      flagId: flag.id,
      enabled: false,
      timestamp: Date.now(),
      context
    };
  }

  private evaluateConditions(conditions: Condition[], context: EvaluationContext): boolean {
    return conditions.every(condition => this.evaluateCondition(condition, context));
  }

  private evaluateCondition(condition: Condition, context: EvaluationContext): boolean {
    const contextValue = this.getContextValue(condition.attribute, context);
    
    switch (condition.operator) {
      case 'equals':
        return contextValue === condition.value;
      case 'not_equals':
        return contextValue !== condition.value;
      case 'in':
        return Array.isArray(condition.value) && condition.value.includes(contextValue);
      case 'not_in':
        return Array.isArray(condition.value) && !condition.value.includes(contextValue);
      case 'greater_than':
        return Number(contextValue) > Number(condition.value);
      case 'less_than':
        return Number(contextValue) < Number(condition.value);
      case 'contains':
        return String(contextValue).includes(String(condition.value));
      case 'regex':
        const regex = new RegExp(condition.value);
        return regex.test(String(contextValue));
      default:
        return false;
    }
  }

  private getContextValue(attribute: string, context: EvaluationContext): any {
    // Support nested attributes with dot notation
    const parts = attribute.split('.');
    let value: any = context;
    
    for (const part of parts) {
      if (value && typeof value === 'object') {
        value = value[part];
      } else {
        return undefined;
      }
    }
    
    return value;
  }

  private shouldRollout(percentage: number, context: EvaluationContext): boolean {
    if (percentage >= 100) return true;
    if (percentage <= 0) return false;
    
    // Use deterministic hash for consistent rollout
    const identifier = context.userId || context.sessionId || 'anonymous';
    const hash = crypto.createHash('md5').update(identifier).digest('hex');
    const hashValue = parseInt(hash.substr(0, 8), 16);
    const rolloutValue = (hashValue % 100);
    
    return rolloutValue < percentage;
  }

  private selectVariant(flag: FeatureFlag, context: EvaluationContext): FlagVariant | undefined {
    if (!flag.variants || flag.variants.length === 0) {
      return undefined;
    }

    // Use weighted random selection based on user ID for consistency
    const identifier = context.userId || context.sessionId || 'anonymous';
    const hash = crypto.createHash('md5').update(identifier + flag.id).digest('hex');
    const hashValue = parseInt(hash.substr(0, 8), 16);
    const randomValue = hashValue % 100;

    let cumulativeWeight = 0;
    for (const variant of flag.variants) {
      cumulativeWeight += variant.weight;
      if (randomValue < cumulativeWeight) {
        return variant;
      }
    }

    // Fallback to first variant
    return flag.variants[0];
  }

  private getVariantValue(flag: FeatureFlag, variantId?: string): any {
    if (!variantId || !flag.variants) {
      return true;
    }

    const variant = flag.variants.find(v => v.id === variantId);
    return variant ? variant.value : true;
  }

  private isWithinSchedule(flag: FeatureFlag, context: EvaluationContext): boolean {
    if (!flag.schedule?.enabled) {
      return true;
    }

    const now = new Date();
    const schedule = flag.schedule;

    // Check date range
    if (schedule.startTime && now < schedule.startTime) {
      return false;
    }
    if (schedule.endTime && now > schedule.endTime) {
      return false;
    }

    // Check day of week
    if (schedule.daysOfWeek && schedule.daysOfWeek.length > 0) {
      const currentDay = now.getDay();
      if (!schedule.daysOfWeek.includes(currentDay)) {
        return false;
      }
    }

    // Check time range
    if (schedule.timeRange) {
      const currentTime = now.toTimeString().substr(0, 5); // HH:mm
      if (currentTime < schedule.timeRange.start || currentTime > schedule.timeRange.end) {
        return false;
      }
    }

    return true;
  }

  // Convenience methods
  public async isEnabled(flagId: string, context: EvaluationContext = {}): Promise<boolean> {
    const evaluation = await this.evaluateFlag(flagId, context);
    return evaluation.enabled;
  }

  public async getVariant(flagId: string, context: EvaluationContext = {}): Promise<string | undefined> {
    const evaluation = await this.evaluateFlag(flagId, context);
    return evaluation.variant;
  }

  public async getValue(flagId: string, context: EvaluationContext = {}, defaultValue: any = false): Promise<any> {
    const evaluation = await this.evaluateFlag(flagId, context);
    return evaluation.enabled ? (evaluation.value ?? true) : defaultValue;
  }

  // Metrics and monitoring
  private async recordEvaluation(evaluation: FlagEvaluation): Promise<void> {
    const metrics = this.metrics.get(evaluation.flagId) || {
      flagId: evaluation.flagId,
      totalEvaluations: 0,
      enabledEvaluations: 0,
      variantDistribution: {},
      uniqueUsers: 0,
      lastEvaluated: new Date(),
      errorCount: 0
    };

    metrics.totalEvaluations++;
    if (evaluation.enabled) {
      metrics.enabledEvaluations++;
    }
    
    if (evaluation.variant) {
      metrics.variantDistribution[evaluation.variant] = 
        (metrics.variantDistribution[evaluation.variant] || 0) + 1;
    }

    metrics.lastEvaluated = new Date();
    this.metrics.set(evaluation.flagId, metrics);

    // Persist metrics periodically
    if (metrics.totalEvaluations % 100 === 0) {
      await this.persistMetrics(evaluation.flagId, metrics);
    }
  }

  public getMetrics(flagId: string): FlagMetrics | undefined {
    return this.metrics.get(flagId);
  }

  public getAllMetrics(): Map<string, FlagMetrics> {
    return new Map(this.metrics);
  }

  // Experiment management
  public async createExperiment(experiment: ExperimentConfig): Promise<void> {
    this.experiments.set(experiment.id, experiment);
    await this.cache.set(`experiment:${experiment.id}`, JSON.stringify(experiment), 86400 * 30);
    
    this.logger.info(`Experiment created: ${experiment.name}`, { experimentId: experiment.id });
    this.emit('experiment-created', experiment);
  }

  public getExperiment(experimentId: string): ExperimentConfig | undefined {
    return this.experiments.get(experimentId);
  }

  // Utility methods
  private generateFlagId(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  }

  private generateCacheKey(flagId: string, context: EvaluationContext): string {
    const keyData = {
      flagId,
      userId: context.userId,
      sessionId: context.sessionId,
      environment: context.environment
    };
    
    return crypto.createHash('md5').update(JSON.stringify(keyData)).digest('hex');
  }

  private clearFlagCache(flagId: string): void {
    const keysToDelete: string[] = [];
    
    for (const [key, evaluation] of this.evaluationCache.entries()) {
      if (evaluation.flagId === flagId) {
        keysToDelete.push(key);
      }
    }
    
    keysToDelete.forEach(key => this.evaluationCache.delete(key));
  }

  private cleanEvaluationCache(): void {
    if (this.evaluationCache.size > 10000) {
      // Remove oldest 20% of entries
      const entries = Array.from(this.evaluationCache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      
      const toRemove = Math.floor(entries.length * 0.2);
      for (let i = 0; i < toRemove; i++) {
        this.evaluationCache.delete(entries[i][0]);
      }
    }
  }

  private async persistFlag(flag: FeatureFlag): Promise<void> {
    await this.cache.set(`flag:${flag.id}`, JSON.stringify(flag), 86400 * 7); // 7 days
  }

  private async persistMetrics(flagId: string, metrics: FlagMetrics): Promise<void> {
    await this.cache.set(`metrics:${flagId}`, JSON.stringify(metrics), 86400); // 1 day
  }

  // Bulk operations
  public async enableFlag(flagId: string): Promise<void> {
    await this.updateFlag(flagId, { enabled: true });
  }

  public async disableFlag(flagId: string): Promise<void> {
    await this.updateFlag(flagId, { enabled: false });
  }

  public async setRolloutPercentage(flagId: string, percentage: number): Promise<void> {
    const flag = this.getFlag(flagId);
    if (!flag) {
      throw new Error(`Feature flag ${flagId} not found`);
    }

    const updatedRollout = {
      ...flag.rollout,
      percentage: Math.max(0, Math.min(100, percentage))
    };

    await this.updateFlag(flagId, { rollout: updatedRollout });
  }

  // Admin interface helpers
  public getFlagSummary(): {
    total: number;
    enabled: number;
    disabled: number;
    scheduled: number;
    experiments: number;
  } {
    const flags = Array.from(this.flags.values());
    
    return {
      total: flags.length,
      enabled: flags.filter(f => f.enabled).length,
      disabled: flags.filter(f => !f.enabled).length,
      scheduled: flags.filter(f => f.schedule?.enabled).length,
      experiments: this.experiments.size
    };
  }

  public getRecentActivity(hours: number = 24): Array<{
    type: 'evaluation' | 'update' | 'create' | 'delete';
    flagId: string;
    flagName: string;
    timestamp: Date;
    details?: any;
  }> {
    // This would typically be stored in a database
    // For now, return empty array as placeholder
    return [];
  }

  public destroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    
    this.flags.clear();
    this.metrics.clear();
    this.experiments.clear();
    this.evaluationCache.clear();
    
    this.logger.info('Feature flag manager destroyed');
  }
}
