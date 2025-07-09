// src/capacity/capacity-planner.ts
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';

export interface ResourceMetric {
  timestamp: Date;
  resourceId: string;
  resourceType: 'cpu' | 'memory' | 'storage' | 'network' | 'gpu';
  value: number;
  unit: string;
  metadata: {
    region?: string;
    service?: string;
    tags?: Record<string, string>;
  };
}

export interface CapacityPrediction {
  resourceId: string;
  resourceType: string;
  currentUsage: number;
  predictedUsage: number[];
  timeframe: string;
  confidence: number;
  trend: 'increasing' | 'decreasing' | 'stable' | 'seasonal';
  recommendations: CapacityRecommendation[];
  metrics: {
    growthRate: number; // % per month
    seasonalityFactor: number;
    variance: number;
  };
}

export interface CapacityRecommendation {
  id: string;
  type: 'scale_up' | 'scale_down' | 'optimize' | 'migrate' | 'alert';
  priority: 'critical' | 'high' | 'medium' | 'low';
  resourceId: string;
  description: string;
  impact: string;
  estimatedCost: number;
  estimatedSavings: number;
  timeToImplement: string;
  riskLevel: 'low' | 'medium' | 'high';
  implementation: {
    steps: string[];
    automation?: string;
    rollbackPlan?: string;
  };
  validUntil: Date;
}

export interface CapacityPlan {
  id: string;
  name: string;
  description: string;
  timeframe: '1month' | '3months' | '6months' | '1year';
  resources: CapacityPlanResource[];
  budget: {
    current: number;
    projected: number;
    limit: number;
    currency: string;
  };
  assumptions: string[];
  risks: CapacityRisk[];
  createdAt: Date;
  updatedAt: Date;
  status: 'draft' | 'approved' | 'active' | 'completed';
}

export interface CapacityPlanResource {
  resourceType: string;
  currentCapacity: number;
  plannedCapacity: number;
  expectedUtilization: number;
  costProjection: number;
  timeline: CapacityMilestone[];
}

export interface CapacityMilestone {
  date: Date;
  capacity: number;
  description: string;
  dependencies: string[];
}

export interface CapacityRisk {
  id: string;
  description: string;
  probability: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  mitigation: string;
  owner: string;
}

export interface ScalingRule {
  id: string;
  name: string;
  resourcePattern: string;
  enabled: boolean;
  conditions: ScalingCondition[];
  actions: ScalingAction[];
  cooldown: number; // minutes
  metadata: {
    createdBy: string;
    lastTriggered?: Date;
    triggerCount: number;
  };
}

export interface ScalingCondition {
  metric: string;
  operator: '>' | '<' | '>=' | '<=' | '==';
  threshold: number;
  duration: number; // seconds
  aggregation: 'avg' | 'max' | 'min' | 'sum';
}

export interface ScalingAction {
  type: 'scale_up' | 'scale_down' | 'alert' | 'webhook';
  target: string;
  parameters: Record<string, any>;
}

export interface UsagePattern {
  name: string;
  description: string;
  pattern: 'daily' | 'weekly' | 'monthly' | 'seasonal' | 'event_driven';
  peaks: TimeRange[];
  baselineMultiplier: number;
  peakMultiplier: number;
  confidence: number;
}

export interface TimeRange {
  start: string; // HH:mm or day of week or month
  end: string;
  multiplier: number;
}

export class CapacityPlanner {
  private logger: Logger;
  private cache: RedisCache;
  private metrics: Map<string, ResourceMetric[]> = new Map();
  private predictions: Map<string, CapacityPrediction> = new Map();
  private plans: Map<string, CapacityPlan> = new Map();
  private scalingRules: Map<string, ScalingRule> = new Map();
  private usagePatterns: Map<string, UsagePattern> = new Map();
  private recommendations: Map<string, CapacityRecommendation> = new Map();

  constructor(logger: Logger, cache: RedisCache) {
    this.logger = logger;
    this.cache = cache;
    
    this.initializeDefaultPatterns();
    this.startPredictionEngine();
  }

  // Metric collection and storage
  public async recordMetric(metric: ResourceMetric): Promise<void> {
    const key = `${metric.resourceId}:${metric.resourceType}`;
    
    if (!this.metrics.has(key)) {
      this.metrics.set(key, []);
    }
    
    const resourceMetrics = this.metrics.get(key)!;
    resourceMetrics.push(metric);
    
    // Keep only last 30 days of metrics
    const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    this.metrics.set(key, resourceMetrics.filter(m => m.timestamp.getTime() > cutoff));
    
    // Store in cache for persistence
    await this.cache.set(
      `metric:${key}:${metric.timestamp.getTime()}`,
      JSON.stringify(metric),
      86400 * 30 // 30 days
    );

    this.logger.debug(`Metric recorded: ${key} = ${metric.value} ${metric.unit}`);
  }

  public async getMetrics(
    resourceId: string,
    resourceType: string,
    fromDate?: Date,
    toDate?: Date
  ): Promise<ResourceMetric[]> {
    const key = `${resourceId}:${resourceType}`;
    let metrics = this.metrics.get(key) || [];

    if (fromDate || toDate) {
      metrics = metrics.filter(m => {
        if (fromDate && m.timestamp < fromDate) return false;
        if (toDate && m.timestamp > toDate) return false;
        return true;
      });
    }

    return metrics.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  // Capacity prediction and forecasting
  public async generatePrediction(
    resourceId: string,
    resourceType: string,
    timeframeDays: number = 30
  ): Promise<CapacityPrediction> {
    const metrics = await this.getMetrics(resourceId, resourceType);
    
    if (metrics.length < 7) {
      throw new Error(`Insufficient data for prediction (need at least 7 data points, got ${metrics.length})`);
    }

    const analysis = this.analyzeMetrics(metrics);
    const forecast = this.forecastUsage(metrics, timeframeDays);
    const pattern = this.detectUsagePattern(metrics);
    const recommendations = await this.generateRecommendations(resourceId, analysis, forecast);

    const prediction: CapacityPrediction = {
      resourceId,
      resourceType,
      currentUsage: analysis.current,
      predictedUsage: forecast.values,
      timeframe: `${timeframeDays} days`,
      confidence: forecast.confidence,
      trend: analysis.trend,
      recommendations,
      metrics: {
        growthRate: analysis.growthRate,
        seasonalityFactor: pattern?.peakMultiplier || 1.0,
        variance: analysis.variance
      }
    };

    this.predictions.set(`${resourceId}:${resourceType}`, prediction);
    await this.persistPrediction(prediction);

    this.logger.info(`Prediction generated for ${resourceId}:${resourceType}`, {
      trend: prediction.trend,
      confidence: prediction.confidence,
      growthRate: prediction.metrics.growthRate
    });

    return prediction;
  }

  private analyzeMetrics(metrics: ResourceMetric[]): {
    current: number;
    trend: CapacityPrediction['trend'];
    growthRate: number;
    variance: number;
    min: number;
    max: number;
    average: number;
  } {
    const values = metrics.map(m => m.value);
    const timestamps = metrics.map(m => m.timestamp.getTime());
    
    const current = values[values.length - 1] || 0;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const average = values.reduce((sum, val) => sum + val, 0) / values.length;
    
    // Calculate variance
    const variance = values.reduce((sum, val) => sum + Math.pow(val - average, 2), 0) / values.length;
    
    // Linear regression for trend analysis
    const { slope } = this.calculateLinearRegression(timestamps, values);
    
    // Convert slope to monthly growth rate
    const monthlyMs = 30 * 24 * 60 * 60 * 1000;
    const growthRate = (slope * monthlyMs / average) * 100;
    
    // Determine trend
    let trend: CapacityPrediction['trend'];
    if (Math.abs(growthRate) < 5) {
      trend = 'stable';
    } else if (growthRate > 0) {
      // Check for seasonality
      trend = this.detectSeasonality(values) ? 'seasonal' : 'increasing';
    } else {
      trend = 'decreasing';
    }

    return {
      current,
      trend,
      growthRate,
      variance,
      min,
      max,
      average
    };
  }

  private forecastUsage(metrics: ResourceMetric[], days: number): {
    values: number[];
    confidence: number;
  } {
    const values = metrics.map(m => m.value);
    const timestamps = metrics.map(m => m.timestamp.getTime());
    
    const { slope, intercept } = this.calculateLinearRegression(timestamps, values);
    
    // Generate future predictions
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const predictions: number[] = [];
    
    for (let i = 1; i <= days; i++) {
      const futureTime = now + (i * dayMs);
      const predicted = slope * futureTime + intercept;
      predictions.push(Math.max(0, predicted)); // Ensure non-negative
    }
    
    // Calculate confidence based on variance and data points
    const residuals = values.map((val, i) => val - (slope * timestamps[i] + intercept));
    const mse = residuals.reduce((sum, r) => sum + r * r, 0) / residuals.length;
    const confidence = Math.max(0.1, Math.min(1.0, 1 - (mse / (values.reduce((sum, v) => sum + v, 0) / values.length))));
    
    return { values: predictions, confidence };
  }

  private calculateLinearRegression(x: number[], y: number[]): { slope: number; intercept: number } {
    const n = x.length;
    const sumX = x.reduce((sum, val) => sum + val, 0);
    const sumY = y.reduce((sum, val) => sum + val, 0);
    const sumXY = x.reduce((acc, val, i) => acc + val * y[i], 0);
    const sumXX = x.reduce((acc, val) => acc + val * val, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    return { slope, intercept };
  }

  private detectSeasonality(values: number[]): boolean {
    // Simple seasonality detection using autocorrelation
    if (values.length < 14) return false;
    
    const period = 7; // Weekly seasonality
    let correlation = 0;
    
    for (let i = 0; i < values.length - period; i++) {
      correlation += values[i] * values[i + period];
    }
    
    correlation /= (values.length - period);
    const variance = values.reduce((sum, val) => sum + val * val, 0) / values.length;
    
    return Math.abs(correlation) > (variance * 0.5);
  }

  private detectUsagePattern(metrics: ResourceMetric[]): UsagePattern | null {
    // Detect daily patterns
    const hourlyUsage = new Array(24).fill(0);
    const hourlyCounts = new Array(24).fill(0);
    
    metrics.forEach(metric => {
      const hour = metric.timestamp.getHours();
      hourlyUsage[hour] += metric.value;
      hourlyCounts[hour]++;
    });
    
    // Calculate average usage per hour
    const hourlyAverages = hourlyUsage.map((usage, hour) => 
      hourlyCounts[hour] > 0 ? usage / hourlyCounts[hour] : 0
    );
    
    const maxUsage = Math.max(...hourlyAverages);
    const minUsage = Math.min(...hourlyAverages);
    const avgUsage = hourlyAverages.reduce((sum, val) => sum + val, 0) / 24;
    
    // If there's significant variation, it's a daily pattern
    if ((maxUsage - minUsage) / avgUsage > 0.3) {
      const peaks: TimeRange[] = [];
      let inPeak = false;
      let peakStart = '';
      
      hourlyAverages.forEach((usage, hour) => {
        const isHigh = usage > avgUsage * 1.2;
        
        if (isHigh && !inPeak) {
          inPeak = true;
          peakStart = `${hour.toString().padStart(2, '0')}:00`;
        } else if (!isHigh && inPeak) {
          inPeak = false;
          peaks.push({
            start: peakStart,
            end: `${hour.toString().padStart(2, '0')}:00`,
            multiplier: maxUsage / avgUsage
          });
        }
      });
      
      return {
        name: 'daily_pattern',
        description: 'Daily usage pattern with peak hours',
        pattern: 'daily',
        peaks,
        baselineMultiplier: minUsage / avgUsage,
        peakMultiplier: maxUsage / avgUsage,
        confidence: 0.8
      };
    }
    
    return null;
  }

  // Recommendation generation
  private async generateRecommendations(
    resourceId: string,
    analysis: any,
    forecast: any
  ): Promise<CapacityRecommendation[]> {
    const recommendations: CapacityRecommendation[] = [];
    
    // High growth rate recommendation
    if (analysis.growthRate > 20) {
      recommendations.push({
        id: `scale-up-${resourceId}-${Date.now()}`,
        type: 'scale_up',
        priority: 'high',
        resourceId,
        description: `Resource showing high growth rate (${analysis.growthRate.toFixed(1)}% per month). Consider scaling up.`,
        impact: 'Prevent performance degradation and service outages',
        estimatedCost: analysis.current * 0.3, // Rough estimate
        estimatedSavings: 0,
        timeToImplement: '1-2 hours',
        riskLevel: 'low',
        implementation: {
          steps: [
            'Review current resource utilization trends',
            'Plan capacity increase',
            'Implement scaling during maintenance window',
            'Monitor post-scaling performance'
          ],
          automation: 'auto-scaling-group'
        },
        validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      });
    }
    
    // Low utilization recommendation
    if (analysis.average < analysis.max * 0.3) {
      recommendations.push({
        id: `optimize-${resourceId}-${Date.now()}`,
        type: 'optimize',
        priority: 'medium',
        resourceId,
        description: `Resource consistently underutilized (avg: ${analysis.average.toFixed(1)}, max: ${analysis.max.toFixed(1)}). Consider optimization.`,
        impact: 'Reduce costs while maintaining performance',
        estimatedCost: 0,
        estimatedSavings: analysis.current * 0.2,
        timeToImplement: '2-4 hours',
        riskLevel: 'medium',
        implementation: {
          steps: [
            'Analyze utilization patterns',
            'Identify optimization opportunities',
            'Test with reduced capacity',
            'Implement optimization'
          ]
        },
        validUntil: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      });
    }
    
    // Critical threshold alert
    const maxPredicted = Math.max(...forecast.values);
    if (maxPredicted > analysis.current * 1.5) {
      recommendations.push({
        id: `alert-${resourceId}-${Date.now()}`,
        type: 'alert',
        priority: 'critical',
        resourceId,
        description: `Predicted usage will exceed current capacity by 50% within forecast period.`,
        impact: 'Immediate action required to prevent service disruption',
        estimatedCost: 0,
        estimatedSavings: 0,
        timeToImplement: 'Immediate',
        riskLevel: 'high',
        implementation: {
          steps: [
            'Set up monitoring alerts',
            'Prepare emergency scaling procedures',
            'Schedule capacity review meeting'
          ]
        },
        validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000)
      });
    }
    
    return recommendations;
  }

  // Capacity planning
  public async createCapacityPlan(
    plan: Omit<CapacityPlan, 'id' | 'createdAt' | 'updatedAt' | 'status'>
  ): Promise<CapacityPlan> {
    const capacityPlan: CapacityPlan = {
      id: `plan-${Date.now()}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'draft',
      ...plan
    };
    
    this.plans.set(capacityPlan.id, capacityPlan);
    await this.persistPlan(capacityPlan);
    
    this.logger.info(`Capacity plan created: ${capacityPlan.name}`, {
      planId: capacityPlan.id,
      timeframe: capacityPlan.timeframe
    });
    
    return capacityPlan;
  }

  public async updateCapacityPlan(
    planId: string,
    updates: Partial<CapacityPlan>
  ): Promise<CapacityPlan> {
    const plan = this.plans.get(planId);
    if (!plan) {
      throw new Error(`Capacity plan ${planId} not found`);
    }
    
    Object.assign(plan, updates, { updatedAt: new Date() });
    await this.persistPlan(plan);
    
    return plan;
  }

  // Auto-scaling rules
  public addScalingRule(rule: ScalingRule): void {
    this.scalingRules.set(rule.id, rule);
    this.logger.info(`Scaling rule added: ${rule.name}`, { ruleId: rule.id });
  }

  public async evaluateScalingRules(metrics: Record<string, number>): Promise<void> {
    for (const [ruleId, rule] of this.scalingRules.entries()) {
      if (!rule.enabled) continue;
      
      try {
        const shouldTrigger = await this.evaluateScalingRule(rule, metrics);
        if (shouldTrigger) {
          await this.executeScalingActions(rule);
        }
      } catch (error) {
        this.logger.error(`Error evaluating scaling rule ${ruleId}:`, error);
      }
    }
  }

  private async evaluateScalingRule(rule: ScalingRule, metrics: Record<string, number>): Promise<boolean> {
    // Check cooldown period
    if (rule.metadata.lastTriggered) {
      const cooldownMs = rule.cooldown * 60 * 1000;
      if (Date.now() - rule.metadata.lastTriggered.getTime() < cooldownMs) {
        return false;
      }
    }
    
    // Evaluate all conditions
    for (const condition of rule.conditions) {
      const metricValue = metrics[condition.metric];
      if (metricValue === undefined) continue;
      
      const conditionMet = this.evaluateScalingCondition(condition, metricValue);
      if (!conditionMet) {
        return false;
      }
    }
    
    return rule.conditions.length > 0;
  }

  private evaluateScalingCondition(condition: ScalingCondition, value: number): boolean {
    switch (condition.operator) {
      case '>': return value > condition.threshold;
      case '<': return value < condition.threshold;
      case '>=': return value >= condition.threshold;
      case '<=': return value <= condition.threshold;
      case '==': return value === condition.threshold;
      default: return false;
    }
  }

  private async executeScalingActions(rule: ScalingRule): Promise<void> {
    rule.metadata.lastTriggered = new Date();
    rule.metadata.triggerCount++;
    
    for (const action of rule.actions) {
      await this.executeScalingAction(action, rule);
    }
    
    this.logger.info(`Scaling rule triggered: ${rule.name}`, {
      ruleId: rule.id,
      triggerCount: rule.metadata.triggerCount
    });
  }

  private async executeScalingAction(action: ScalingAction, rule: ScalingRule): Promise<void> {
    switch (action.type) {
      case 'scale_up':
      case 'scale_down':
        this.logger.info(`Scaling action: ${action.type} for ${action.target}`);
        // In production, integrate with cloud provider APIs
        break;
      case 'alert':
        this.logger.warn(`Scaling alert: ${rule.name} triggered`);
        break;
      case 'webhook':
        this.logger.info(`Webhook triggered: ${action.target}`);
        // In production, make HTTP POST to webhook
        break;
    }
  }

  // Utility methods
  private initializeDefaultPatterns(): void {
    // Business hours pattern
    this.usagePatterns.set('business_hours', {
      name: 'business_hours',
      description: 'Standard business hours usage pattern',
      pattern: 'daily',
      peaks: [
        { start: '09:00', end: '17:00', multiplier: 1.5 }
      ],
      baselineMultiplier: 0.3,
      peakMultiplier: 1.5,
      confidence: 0.9
    });
    
    // Weekend pattern
    this.usagePatterns.set('weekend_low', {
      name: 'weekend_low',
      description: 'Lower usage during weekends',
      pattern: 'weekly',
      peaks: [],
      baselineMultiplier: 0.5,
      peakMultiplier: 1.0,
      confidence: 0.8
    });
  }

  private startPredictionEngine(): void {
    // Run predictions every hour
    setInterval(async () => {
      await this.runPredictionEngine();
    }, 3600000);
    
    // Evaluate scaling rules every minute
    setInterval(async () => {
      const currentMetrics = await this.getCurrentMetrics();
      await this.evaluateScalingRules(currentMetrics);
    }, 60000);
  }

  private async runPredictionEngine(): Promise<void> {
    this.logger.info('Running capacity prediction engine...');
    
    const resourceKeys = Array.from(this.metrics.keys());
    
    for (const key of resourceKeys) {
      const [resourceId, resourceType] = key.split(':');
      
      try {
        await this.generatePrediction(resourceId, resourceType, 30);
      } catch (error) {
        this.logger.debug(`Prediction failed for ${key}:`, error);
      }
    }
  }

  private async getCurrentMetrics(): Promise<Record<string, number>> {
    // In production, this would query monitoring systems
    const metrics: Record<string, number> = {};
    
    for (const [key, resourceMetrics] of this.metrics.entries()) {
      if (resourceMetrics.length > 0) {
        const latest = resourceMetrics[resourceMetrics.length - 1];
        metrics[key] = latest.value;
      }
    }
    
    return metrics;
  }

  private async persistPrediction(prediction: CapacityPrediction): Promise<void> {
    const key = `prediction:${prediction.resourceId}:${prediction.resourceType}`;
    await this.cache.set(key, JSON.stringify(prediction), 86400 * 7); // 7 days
  }

  private async persistPlan(plan: CapacityPlan): Promise<void> {
    const key = `plan:${plan.id}`;
    await this.cache.set(key, JSON.stringify(plan), 86400 * 365); // 1 year
  }

  // Public API methods
  public async getCapacityReport(): Promise<{
    predictions: CapacityPrediction[];
    recommendations: CapacityRecommendation[];
    plans: CapacityPlan[];
    summary: {
      totalResources: number;
      criticalAlerts: number;
      optimizationOpportunities: number;
      projectedGrowth: number;
    };
  }> {
    const predictions = Array.from(this.predictions.values());
    const recommendations = Array.from(this.recommendations.values());
    const plans = Array.from(this.plans.values());
    
    const criticalAlerts = recommendations.filter(r => r.priority === 'critical').length;
    const optimizationOpportunities = recommendations.filter(r => r.type === 'optimize').length;
    const projectedGrowth = predictions.reduce((sum, p) => sum + p.metrics.growthRate, 0) / predictions.length || 0;
    
    return {
      predictions,
      recommendations,
      plans,
      summary: {
        totalResources: this.metrics.size,
        criticalAlerts,
        optimizationOpportunities,
        projectedGrowth
      }
    };
  }

  public async getResourceForecast(
    resourceId: string,
    resourceType: string,
    days: number = 30
  ): Promise<{ dates: string[]; values: number[]; confidence: number }> {
    const prediction = await this.generatePrediction(resourceId, resourceType, days);
    
    const dates: string[] = [];
    const now = new Date();
    
    for (let i = 1; i <= days; i++) {
      const date = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
      dates.push(date.toISOString().split('T')[0]);
    }
    
    return {
      dates,
      values: prediction.predictedUsage,
      confidence: prediction.confidence
    };
  }
}