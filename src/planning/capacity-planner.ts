/**
 * Capacity Planner - Resource Prediction and Planning System
 * 
 * Design Philosophy:
 * - Carmack: Efficient prediction algorithms, minimal overhead
 * - Martin: Clear separation of data collection and analysis
 * - Pike: Simple trending, actionable insights
 */

import { EventEmitter } from 'events';
import { UnifiedLogger } from '../logging/unified-logger';
import { UnifiedMetrics } from '../metrics/unified-metrics';
import { UnifiedDatabase } from '../database/unified-database';

export interface ResourceMetric {
  timestamp: Date;
  cpu: number;
  memory: number;
  disk: number;
  network: number;
  miners: number;
  hashrate: number;
  shares: number;
}

export interface CapacityPrediction {
  resource: string;
  current: number;
  predicted: number;
  confidence: number;
  timeframe: string;
  recommendation: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
}

export interface ResourceThreshold {
  resource: string;
  warning: number;
  critical: number;
  unit: string;
}

export interface CapacityTrend {
  resource: string;
  direction: 'increasing' | 'decreasing' | 'stable';
  rate: number; // change per hour
  projectedCapacity: Date; // when resource will hit capacity
  confidence: number;
}

export interface ScalingRecommendation {
  resource: string;
  action: 'scale_up' | 'scale_down' | 'optimize' | 'monitor';
  priority: number;
  description: string;
  estimatedCost?: number;
  estimatedSavings?: number;
  timeline: string;
}

export class CapacityPlanner extends EventEmitter {
  private metrics: ResourceMetric[] = [];
  private thresholds: Map<string, ResourceThreshold> = new Map();
  private collectionInterval: NodeJS.Timeout | null = null;
  private analysisInterval: NodeJS.Timeout | null = null;
  private maxHistoryHours = 168; // 7 days
  private minDataPoints = 24; // Minimum data points for reliable prediction

  constructor(
    private metricsService: UnifiedMetrics,
    private database: UnifiedDatabase,
    private logger: UnifiedLogger,
    private config = {
      collectionIntervalMs: 60000, // 1 minute
      analysisIntervalMs: 600000, // 10 minutes
      predictionHorizonHours: 24,
      confidenceThreshold: 0.7
    }
  ) {
    super();
    this.initializeThresholds();
  }

  public async start(): Promise<void> {
    this.logger.info('Starting Capacity Planner...');
    
    // Load historical data
    await this.loadHistoricalData();
    
    // Start metric collection
    this.collectionInterval = setInterval(() => {
      this.collectMetrics();
    }, this.config.collectionIntervalMs);

    // Start analysis
    this.analysisInterval = setInterval(() => {
      this.performAnalysis();
    }, this.config.analysisIntervalMs);

    // Initial analysis
    await this.performAnalysis();

    this.logger.info('Capacity Planner started');
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping Capacity Planner...');
    
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
      this.collectionInterval = null;
    }

    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
      this.analysisInterval = null;
    }

    // Save current metrics
    await this.saveMetrics();

    this.logger.info('Capacity Planner stopped');
  }

  public getCapacityPredictions(): CapacityPrediction[] {
    if (this.metrics.length < this.minDataPoints) {
      return [];
    }

    const resources = ['cpu', 'memory', 'disk', 'miners', 'hashrate'];
    return resources.map(resource => this.predictResource(resource)).filter(Boolean) as CapacityPrediction[];
  }

  public getResourceTrends(): CapacityTrend[] {
    if (this.metrics.length < this.minDataPoints) {
      return [];
    }

    const resources = ['cpu', 'memory', 'disk', 'miners', 'hashrate'];
    return resources.map(resource => this.analyzeTrend(resource)).filter(Boolean) as CapacityTrend[];
  }

  public getScalingRecommendations(): ScalingRecommendation[] {
    const predictions = this.getCapacityPredictions();
    const trends = this.getResourceTrends();
    const recommendations: ScalingRecommendation[] = [];

    // CPU recommendations
    const cpuPrediction = predictions.find(p => p.resource === 'cpu');
    if (cpuPrediction) {
      if (cpuPrediction.predicted > 85 && cpuPrediction.confidence > this.config.confidenceThreshold) {
        recommendations.push({
          resource: 'cpu',
          action: 'scale_up',
          priority: cpuPrediction.urgency === 'critical' ? 1 : 2,
          description: 'Add more CPU cores or scale horizontally',
          timeline: 'immediate',
          estimatedCost: 500 // USD per month
        });
      }
    }

    // Memory recommendations
    const memoryPrediction = predictions.find(p => p.resource === 'memory');
    if (memoryPrediction) {
      if (memoryPrediction.predicted > 80 && memoryPrediction.confidence > this.config.confidenceThreshold) {
        recommendations.push({
          resource: 'memory',
          action: 'scale_up',
          priority: memoryPrediction.urgency === 'critical' ? 1 : 3,
          description: 'Increase memory allocation or optimize memory usage',
          timeline: 'within 24 hours',
          estimatedCost: 200
        });
      }
    }

    // Miner scaling recommendations
    const minerTrend = trends.find(t => t.resource === 'miners');
    if (minerTrend && minerTrend.direction === 'increasing' && minerTrend.rate > 10) {
      recommendations.push({
        resource: 'miners',
        action: 'scale_up',
        priority: 2,
        description: 'Prepare for increased miner load - scale stratum servers',
        timeline: 'within 48 hours',
        estimatedCost: 1000
      });
    }

    return recommendations.sort((a, b) => a.priority - b.priority);
  }

  public getCurrentUtilization(): Record<string, number> {
    if (this.metrics.length === 0) {
      return {};
    }

    const latest = this.metrics[this.metrics.length - 1];
    return {
      cpu: latest.cpu,
      memory: latest.memory,
      disk: latest.disk,
      network: latest.network,
      miners: latest.miners,
      hashrate: latest.hashrate,
      shares: latest.shares
    };
  }

  public getResourceHistory(resource: string, hours: number = 24): Array<{ timestamp: Date; value: number }> {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - hours);

    return this.metrics
      .filter(m => m.timestamp >= cutoff)
      .map(m => ({
        timestamp: m.timestamp,
        value: (m as any)[resource] || 0
      }));
  }

  public setResourceThreshold(resource: string, threshold: ResourceThreshold): void {
    this.thresholds.set(resource, threshold);
    this.logger.info(`Updated threshold for ${resource}`, threshold);
  }

  public getResourceThresholds(): Map<string, ResourceThreshold> {
    return new Map(this.thresholds);
  }

  private async collectMetrics(): Promise<void> {
    try {
      const metric: ResourceMetric = {
        timestamp: new Date(),
        cpu: await this.metricsService.getCPUUsage(),
        memory: await this.metricsService.getMemoryUsage(),
        disk: await this.getDiskUsage(),
        network: await this.getNetworkUsage(),
        miners: await this.metricsService.getActiveMinerCount(),
        hashrate: await this.metricsService.getPoolHashrate(),
        shares: await this.metricsService.getSharesPerMinute()
      };

      this.metrics.push(metric);

      // Maintain history limit
      const cutoff = new Date();
      cutoff.setHours(cutoff.getHours() - this.maxHistoryHours);
      this.metrics = this.metrics.filter(m => m.timestamp >= cutoff);

      // Check for threshold breaches
      this.checkThresholds(metric);

    } catch (error) {
      this.logger.error('Error collecting capacity metrics:', error);
    }
  }

  private predictResource(resource: string): CapacityPrediction | null {
    if (this.metrics.length < this.minDataPoints) {
      return null;
    }

    const values = this.metrics.map(m => (m as any)[resource] as number);
    const timestamps = this.metrics.map(m => m.timestamp.getTime());

    // Simple linear regression for trend prediction
    const trend = this.calculateLinearTrend(timestamps, values);
    if (!trend) {
      return null;
    }

    const futureTime = Date.now() + (this.config.predictionHorizonHours * 60 * 60 * 1000);
    const predicted = trend.slope * futureTime + trend.intercept;
    const current = values[values.length - 1];

    // Calculate confidence based on R-squared
    const confidence = Math.max(0, Math.min(1, trend.rSquared));

    // Determine urgency
    let urgency: CapacityPrediction['urgency'] = 'low';
    const threshold = this.thresholds.get(resource);
    if (threshold) {
      if (predicted >= threshold.critical) urgency = 'critical';
      else if (predicted >= threshold.warning) urgency = 'high';
      else if (predicted >= threshold.warning * 0.8) urgency = 'medium';
    }

    // Generate recommendation
    let recommendation = 'Monitor resource usage';
    if (urgency === 'critical') {
      recommendation = `Immediate action required - ${resource} will exceed critical threshold`;
    } else if (urgency === 'high') {
      recommendation = `Plan scaling for ${resource} within next 24 hours`;
    } else if (urgency === 'medium') {
      recommendation = `Consider optimizing ${resource} usage`;
    }

    return {
      resource,
      current,
      predicted: Math.max(0, predicted),
      confidence,
      timeframe: `${this.config.predictionHorizonHours} hours`,
      recommendation,
      urgency
    };
  }

  private analyzeTrend(resource: string): CapacityTrend | null {
    if (this.metrics.length < this.minDataPoints) {
      return null;
    }

    const values = this.metrics.map(m => (m as any)[resource] as number);
    const timestamps = this.metrics.map(m => m.timestamp.getTime());

    const trend = this.calculateLinearTrend(timestamps, values);
    if (!trend) {
      return null;
    }

    // Convert slope to hourly rate
    const hourlyRate = trend.slope * (60 * 60 * 1000);
    
    let direction: CapacityTrend['direction'] = 'stable';
    if (Math.abs(hourlyRate) > 0.1) {
      direction = hourlyRate > 0 ? 'increasing' : 'decreasing';
    }

    // Calculate when resource will hit capacity (if increasing)
    let projectedCapacity = new Date();
    projectedCapacity.setFullYear(projectedCapacity.getFullYear() + 10); // Default far future

    if (direction === 'increasing' && hourlyRate > 0) {
      const threshold = this.thresholds.get(resource);
      if (threshold) {
        const current = values[values.length - 1];
        const timeToCapacity = (threshold.critical - current) / hourlyRate;
        if (timeToCapacity > 0) {
          projectedCapacity = new Date(Date.now() + timeToCapacity * 60 * 60 * 1000);
        }
      }
    }

    return {
      resource,
      direction,
      rate: Math.abs(hourlyRate),
      projectedCapacity,
      confidence: trend.rSquared
    };
  }

  private calculateLinearTrend(x: number[], y: number[]): { slope: number; intercept: number; rSquared: number } | null {
    if (x.length !== y.length || x.length < 2) {
      return null;
    }

    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumYY = y.reduce((sum, yi) => sum + yi * yi, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    // Calculate R-squared
    const yMean = sumY / n;
    const ssRes = y.reduce((sum, yi, i) => {
      const predicted = slope * x[i] + intercept;
      return sum + Math.pow(yi - predicted, 2);
    }, 0);
    const ssTot = y.reduce((sum, yi) => sum + Math.pow(yi - yMean, 2), 0);
    const rSquared = ssTot === 0 ? 0 : 1 - (ssRes / ssTot);

    return { slope, intercept, rSquared };
  }

  private checkThresholds(metric: ResourceMetric): void {
    const resources = ['cpu', 'memory', 'disk', 'network'];
    
    resources.forEach(resource => {
      const threshold = this.thresholds.get(resource);
      if (!threshold) return;

      const value = (metric as any)[resource] as number;
      
      if (value >= threshold.critical) {
        this.emit('thresholdBreach', {
          resource,
          level: 'critical',
          value,
          threshold: threshold.critical,
          timestamp: metric.timestamp
        });
        this.logger.error(`Critical threshold breach: ${resource} at ${value}%`);
      } else if (value >= threshold.warning) {
        this.emit('thresholdBreach', {
          resource,
          level: 'warning',
          value,
          threshold: threshold.warning,
          timestamp: metric.timestamp
        });
        this.logger.warn(`Warning threshold breach: ${resource} at ${value}%`);
      }
    });
  }

  private async performAnalysis(): Promise<void> {
    try {
      const predictions = this.getCapacityPredictions();
      const trends = this.getResourceTrends();
      const recommendations = this.getScalingRecommendations();

      // Emit analysis results
      this.emit('analysisComplete', {
        timestamp: new Date(),
        predictions,
        trends,
        recommendations
      });

      // Log critical findings
      const criticalPredictions = predictions.filter(p => p.urgency === 'critical');
      if (criticalPredictions.length > 0) {
        this.logger.error('Critical capacity issues predicted:', criticalPredictions);
      }

      // Log high-priority recommendations
      const urgentRecommendations = recommendations.filter(r => r.priority <= 2);
      if (urgentRecommendations.length > 0) {
        this.logger.warn('Urgent scaling recommendations:', urgentRecommendations);
      }

    } catch (error) {
      this.logger.error('Error performing capacity analysis:', error);
    }
  }

  private async loadHistoricalData(): Promise<void> {
    try {
      // Load from database if available
      // This would be implemented based on the actual database schema
      this.logger.info('Loading historical capacity data...');
      
      // For now, initialize with empty metrics
      this.metrics = [];
      
    } catch (error) {
      this.logger.error('Error loading historical data:', error);
    }
  }

  private async saveMetrics(): Promise<void> {
    try {
      // Save metrics to database for persistence
      // This would be implemented based on the actual database schema
      this.logger.info(`Saving ${this.metrics.length} capacity metrics`);
      
    } catch (error) {
      this.logger.error('Error saving metrics:', error);
    }
  }

  private async getDiskUsage(): Promise<number> {
    // Implement disk usage calculation
    // For now, return a placeholder value
    return Math.random() * 100;
  }

  private async getNetworkUsage(): Promise<number> {
    // Implement network usage calculation
    // For now, return a placeholder value
    return Math.random() * 100;
  }

  private initializeThresholds(): void {
    const defaultThresholds: [string, ResourceThreshold][] = [
      ['cpu', { resource: 'cpu', warning: 70, critical: 90, unit: '%' }],
      ['memory', { resource: 'memory', warning: 75, critical: 90, unit: '%' }],
      ['disk', { resource: 'disk', warning: 80, critical: 95, unit: '%' }],
      ['network', { resource: 'network', warning: 70, critical: 90, unit: '%' }]
    ];

    defaultThresholds.forEach(([resource, threshold]) => {
      this.thresholds.set(resource, threshold);
    });

    this.logger.info('Initialized default resource thresholds');
  }
}