// src/cost/cost-analysis-optimizer.ts
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';

export interface CostMetric {
  service: string;
  resource: string;
  region: string;
  cost: number;
  currency: string;
  period: 'hour' | 'day' | 'month';
  timestamp: Date;
  tags?: Record<string, string>;
}

export interface ResourceUsage {
  resourceId: string;
  resourceType: 'compute' | 'storage' | 'network' | 'database';
  utilization: number; // 0-100%
  cost: number;
  recommendedAction?: 'scale_down' | 'scale_up' | 'terminate' | 'optimize';
  potentialSavings?: number;
}

export interface CostReport {
  totalCost: number;
  breakdown: {
    compute: number;
    storage: number;
    network: number;
    database: number;
    other: number;
  };
  trend: 'increasing' | 'decreasing' | 'stable';
  recommendations: OptimizationRecommendation[];
  period: {
    start: Date;
    end: Date;
  };
}

export interface OptimizationRecommendation {
  id: string;
  type: 'resize' | 'terminate' | 'schedule' | 'storage_class' | 'reserved_instance';
  priority: 'high' | 'medium' | 'low';
  resource: string;
  description: string;
  potentialSavings: number;
  riskLevel: 'low' | 'medium' | 'high';
  effort: 'low' | 'medium' | 'high';
  implementation: {
    steps: string[];
    estimatedTime: string;
    automation?: string;
  };
}

export interface BudgetAlert {
  id: string;
  budgetName: string;
  threshold: number;
  currentSpend: number;
  percentage: number;
  severity: 'warning' | 'critical';
  message: string;
  timestamp: Date;
}

export class CostAnalysisOptimizer {
  private logger: Logger;
  private cache: RedisCache;
  private metrics: CostMetric[] = [];
  private budgets: Map<string, { limit: number; alerts: number[] }> = new Map();
  private optimizationRules: OptimizationRule[] = [];

  constructor(logger: Logger, cache: RedisCache) {
    this.logger = logger;
    this.cache = cache;
    this.initializeOptimizationRules();
  }

  // Cost Tracking
  public async recordCost(metric: CostMetric): Promise<void> {
    this.metrics.push(metric);
    
    // Store in cache for quick access
    const key = `cost:${metric.service}:${metric.resource}:${metric.timestamp.toISOString()}`;
    await this.cache.set(key, JSON.stringify(metric), 86400 * 30); // 30 days

    // Update running totals
    await this.updateCostTotals(metric);
    
    this.logger.debug(`Cost recorded: ${metric.service}/${metric.resource} - $${metric.cost}`);
  }

  public async getCostReport(
    startDate: Date,
    endDate: Date,
    groupBy: 'service' | 'region' | 'resource' = 'service'
  ): Promise<CostReport> {
    const costs = await this.getCostsInPeriod(startDate, endDate);
    const breakdown = this.calculateCostBreakdown(costs);
    const trend = this.calculateCostTrend(costs);
    const recommendations = await this.generateRecommendations();

    return {
      totalCost: costs.reduce((sum, cost) => sum + cost.cost, 0),
      breakdown,
      trend,
      recommendations,
      period: { start: startDate, end: endDate }
    };
  }

  // Resource Analysis
  public async analyzeResourceUtilization(): Promise<ResourceUsage[]> {
    const resources = await this.getResourceMetrics();
    const usage: ResourceUsage[] = [];

    for (const resource of resources) {
      const utilization = await this.calculateUtilization(resource.id);
      const cost = await this.getResourceCost(resource.id);
      
      const recommendation = this.getOptimizationRecommendation(
        resource,
        utilization,
        cost
      );

      usage.push({
        resourceId: resource.id,
        resourceType: resource.type,
        utilization,
        cost,
        recommendedAction: recommendation.action,
        potentialSavings: recommendation.savings
      });
    }

    return usage;
  }

  // Recommendations
  public async generateRecommendations(): Promise<OptimizationRecommendation[]> {
    const recommendations: OptimizationRecommendation[] = [];
    const resources = await this.analyzeResourceUtilization();

    for (const resource of resources) {
      const rule = this.findApplicableRule(resource);
      if (rule) {
        const recommendation = await rule.generate(resource);
        recommendations.push(recommendation);
      }
    }

    // Sort by potential savings
    return recommendations.sort((a, b) => b.potentialSavings - a.potentialSavings);
  }

  // Budget Management
  public setBudget(name: string, limit: number, alertThresholds: number[] = [80, 90]): void {
    this.budgets.set(name, { limit, alerts: alertThresholds });
    this.logger.info(`Budget set: ${name} - $${limit}`);
  }

  public async checkBudgetAlerts(): Promise<BudgetAlert[]> {
    const alerts: BudgetAlert[] = [];
    const currentMonth = new Date();
    currentMonth.setDate(1);
    currentMonth.setHours(0, 0, 0, 0);

    for (const [budgetName, budget] of this.budgets.entries()) {
      const monthlySpend = await this.getMonthlySpend(currentMonth, budgetName);
      
      for (const threshold of budget.alerts) {
        const percentage = (monthlySpend / budget.limit) * 100;
        
        if (percentage >= threshold) {
          alerts.push({
            id: `alert_${budgetName}_${threshold}_${Date.now()}`,
            budgetName,
            threshold,
            currentSpend: monthlySpend,
            percentage,
            severity: threshold >= 90 ? 'critical' : 'warning',
            message: `Budget '${budgetName}' is at ${percentage.toFixed(1)}% (${monthlySpend}/${budget.limit})`,
            timestamp: new Date()
          });
        }
      }
    }

    return alerts;
  }

  // Cost Forecasting
  public async forecastCosts(days: number = 30): Promise<{ daily: number[]; total: number }> {
    const historicalData = await this.getHistoricalCosts(days * 2); // Use 2x for trend analysis
    const trend = this.calculateTrendLine(historicalData);
    
    const daily: number[] = [];
    let total = 0;

    for (let i = 0; i < days; i++) {
      const dailyCost = this.projectDailyCost(trend, i);
      daily.push(dailyCost);
      total += dailyCost;
    }

    return { daily, total };
  }

  // Optimization Actions
  public async implementRecommendation(recommendationId: string): Promise<boolean> {
    try {
      const recommendation = await this.getRecommendation(recommendationId);
      
      if (!recommendation) {
        throw new Error(`Recommendation ${recommendationId} not found`);
      }

      switch (recommendation.type) {
        case 'resize':
          return await this.resizeResource(recommendation);
        case 'terminate':
          return await this.terminateResource(recommendation);
        case 'schedule':
          return await this.scheduleResource(recommendation);
        case 'storage_class':
          return await this.changeStorageClass(recommendation);
        case 'reserved_instance':
          return await this.purchaseReservedInstance(recommendation);
        default:
          throw new Error(`Unknown recommendation type: ${recommendation.type}`);
      }
    } catch (error) {
      this.logger.error(`Failed to implement recommendation ${recommendationId}:`, error);
      return false;
    }
  }

  // Private helper methods
  private async updateCostTotals(metric: CostMetric): Promise<void> {
    const key = `cost_total:${metric.period}`;
    const current = await this.cache.get(key);
    const total = current ? parseFloat(current) : 0;
    
    await this.cache.set(key, (total + metric.cost).toString(), 86400);
  }

  private async getCostsInPeriod(start: Date, end: Date): Promise<CostMetric[]> {
    // In a real implementation, this would query a database
    return this.metrics.filter(
      metric => metric.timestamp >= start && metric.timestamp <= end
    );
  }

  private calculateCostBreakdown(costs: CostMetric[]): CostReport['breakdown'] {
    const breakdown = {
      compute: 0,
      storage: 0,
      network: 0,
      database: 0,
      other: 0
    };

    costs.forEach(cost => {
      switch (cost.service.toLowerCase()) {
        case 'ec2':
        case 'compute':
          breakdown.compute += cost.cost;
          break;
        case 's3':
        case 'storage':
          breakdown.storage += cost.cost;
          break;
        case 'cloudfront':
        case 'network':
          breakdown.network += cost.cost;
          break;
        case 'rds':
        case 'database':
          breakdown.database += cost.cost;
          break;
        default:
          breakdown.other += cost.cost;
      }
    });

    return breakdown;
  }

  private calculateCostTrend(costs: CostMetric[]): 'increasing' | 'decreasing' | 'stable' {
    if (costs.length < 2) return 'stable';

    const recent = costs.slice(-7); // Last 7 days
    const previous = costs.slice(-14, -7); // Previous 7 days

    const recentAvg = recent.reduce((sum, c) => sum + c.cost, 0) / recent.length;
    const previousAvg = previous.reduce((sum, c) => sum + c.cost, 0) / previous.length;

    const change = (recentAvg - previousAvg) / previousAvg;

    if (change > 0.05) return 'increasing';
    if (change < -0.05) return 'decreasing';
    return 'stable';
  }

  private async getResourceMetrics(): Promise<Array<{ id: string; type: ResourceUsage['resourceType'] }>> {
    // Simplified - would integrate with cloud provider APIs
    return [
      { id: 'i-1234567890abcdef0', type: 'compute' },
      { id: 'vol-0123456789abcdef0', type: 'storage' },
      { id: 'db-instance-1', type: 'database' }
    ];
  }

  private async calculateUtilization(resourceId: string): Promise<number> {
    // Would query monitoring metrics
    return Math.random() * 100; // Simplified
  }

  private async getResourceCost(resourceId: string): Promise<number> {
    // Would query cost allocation data
    return Math.random() * 100; // Simplified
  }

  private getOptimizationRecommendation(
    resource: any,
    utilization: number,
    cost: number
  ): { action?: ResourceUsage['recommendedAction']; savings: number } {
    if (utilization < 20) {
      return { action: 'scale_down', savings: cost * 0.3 };
    }
    if (utilization > 80) {
      return { action: 'scale_up', savings: 0 };
    }
    if (utilization < 5) {
      return { action: 'terminate', savings: cost * 0.9 };
    }
    return { savings: 0 };
  }

  private initializeOptimizationRules(): void {
    this.optimizationRules = [
      new UnderutilizedResourceRule(),
      new OverProvisionedInstanceRule(),
      new UnusedResourceRule(),
      new StorageOptimizationRule(),
      new ReservedInstanceRule()
    ];
  }

  private findApplicableRule(resource: ResourceUsage): OptimizationRule | null {
    return this.optimizationRules.find(rule => rule.applies(resource)) || null;
  }

  private async getMonthlySpend(month: Date, budgetName?: string): Promise<number> {
    const endOfMonth = new Date(month);
    endOfMonth.setMonth(endOfMonth.getMonth() + 1);
    
    const costs = await this.getCostsInPeriod(month, endOfMonth);
    return costs.reduce((sum, cost) => sum + cost.cost, 0);
  }

  private async getHistoricalCosts(days: number): Promise<number[]> {
    const costs: number[] = [];
    const today = new Date();
    
    for (let i = days; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      
      const dailyCosts = await this.getCostsInPeriod(date, new Date(date.getTime() + 86400000));
      costs.push(dailyCosts.reduce((sum, cost) => sum + cost.cost, 0));
    }
    
    return costs;
  }

  private calculateTrendLine(data: number[]): { slope: number; intercept: number } {
    const n = data.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = data;
    
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
    const sumXX = x.reduce((acc, xi) => acc + xi * xi, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    return { slope, intercept };
  }

  private projectDailyCost(trend: { slope: number; intercept: number }, dayOffset: number): number {
    return Math.max(0, trend.intercept + trend.slope * dayOffset);
  }

  private async getRecommendation(id: string): Promise<OptimizationRecommendation | null> {
    const cached = await this.cache.get(`recommendation:${id}`);
    return cached ? JSON.parse(cached) : null;
  }

  // Optimization action implementations (simplified)
  private async resizeResource(recommendation: OptimizationRecommendation): Promise<boolean> {
    this.logger.info(`Resizing resource: ${recommendation.resource}`);
    // Would call cloud provider API
    return true;
  }

  private async terminateResource(recommendation: OptimizationRecommendation): Promise<boolean> {
    this.logger.info(`Terminating resource: ${recommendation.resource}`);
    // Would call cloud provider API
    return true;
  }

  private async scheduleResource(recommendation: OptimizationRecommendation): Promise<boolean> {
    this.logger.info(`Scheduling resource: ${recommendation.resource}`);
    // Would set up scheduled start/stop
    return true;
  }

  private async changeStorageClass(recommendation: OptimizationRecommendation): Promise<boolean> {
    this.logger.info(`Changing storage class: ${recommendation.resource}`);
    // Would call storage API
    return true;
  }

  private async purchaseReservedInstance(recommendation: OptimizationRecommendation): Promise<boolean> {
    this.logger.info(`Purchasing reserved instance: ${recommendation.resource}`);
    // Would call cloud provider API
    return true;
  }
}

// Optimization Rules
abstract class OptimizationRule {
  abstract applies(resource: ResourceUsage): boolean;
  abstract generate(resource: ResourceUsage): Promise<OptimizationRecommendation>;
}

class UnderutilizedResourceRule extends OptimizationRule {
  applies(resource: ResourceUsage): boolean {
    return resource.utilization < 20;
  }

  async generate(resource: ResourceUsage): Promise<OptimizationRecommendation> {
    return {
      id: `underutilized_${resource.resourceId}`,
      type: 'resize',
      priority: 'medium',
      resource: resource.resourceId,
      description: `Resource is underutilized (${resource.utilization}%). Consider downsizing.`,
      potentialSavings: resource.cost * 0.3,
      riskLevel: 'low',
      effort: 'low',
      implementation: {
        steps: [
          'Monitor resource usage for 7 days',
          'Create smaller instance',
          'Migrate workload',
          'Terminate old instance'
        ],
        estimatedTime: '2 hours',
        automation: 'auto-scaling-group'
      }
    };
  }
}

class OverProvisionedInstanceRule extends OptimizationRule {
  applies(resource: ResourceUsage): boolean {
    return resource.resourceType === 'compute' && resource.utilization < 40;
  }

  async generate(resource: ResourceUsage): Promise<OptimizationRecommendation> {
    return {
      id: `overprovisioned_${resource.resourceId}`,
      type: 'resize',
      priority: 'high',
      resource: resource.resourceId,
      description: 'Instance appears overprovisioned. Consider smaller instance type.',
      potentialSavings: resource.cost * 0.4,
      riskLevel: 'low',
      effort: 'medium',
      implementation: {
        steps: [
          'Stop instance',
          'Change instance type',
          'Start instance',
          'Verify performance'
        ],
        estimatedTime: '30 minutes'
      }
    };
  }
}

class UnusedResourceRule extends OptimizationRule {
  applies(resource: ResourceUsage): boolean {
    return resource.utilization < 5;
  }

  async generate(resource: ResourceUsage): Promise<OptimizationRecommendation> {
    return {
      id: `unused_${resource.resourceId}`,
      type: 'terminate',
      priority: 'high',
      resource: resource.resourceId,
      description: 'Resource appears unused. Consider termination.',
      potentialSavings: resource.cost * 0.95,
      riskLevel: 'medium',
      effort: 'low',
      implementation: {
        steps: [
          'Verify resource is unused',
          'Create backup if needed',
          'Terminate resource'
        ],
        estimatedTime: '15 minutes'
      }
    };
  }
}

class StorageOptimizationRule extends OptimizationRule {
  applies(resource: ResourceUsage): boolean {
    return resource.resourceType === 'storage';
  }

  async generate(resource: ResourceUsage): Promise<OptimizationRecommendation> {
    return {
      id: `storage_${resource.resourceId}`,
      type: 'storage_class',
      priority: 'low',
      resource: resource.resourceId,
      description: 'Consider moving to cheaper storage class for infrequently accessed data.',
      potentialSavings: resource.cost * 0.2,
      riskLevel: 'low',
      effort: 'low',
      implementation: {
        steps: [
          'Analyze access patterns',
          'Set up lifecycle policy',
          'Monitor transition'
        ],
        estimatedTime: '1 hour'
      }
    };
  }
}

class ReservedInstanceRule extends OptimizationRule {
  applies(resource: ResourceUsage): boolean {
    return resource.resourceType === 'compute' && resource.utilization > 70;
  }

  async generate(resource: ResourceUsage): Promise<OptimizationRecommendation> {
    return {
      id: `reserved_${resource.resourceId}`,
      type: 'reserved_instance',
      priority: 'medium',
      resource: resource.resourceId,
      description: 'High utilization. Consider reserved instance for long-term savings.',
      potentialSavings: resource.cost * 0.3 * 12, // Annual savings
      riskLevel: 'low',
      effort: 'low',
      implementation: {
        steps: [
          'Verify consistent usage pattern',
          'Purchase reserved instance',
          'Apply to existing instance'
        ],
        estimatedTime: '30 minutes'
      }
    };
  }
}