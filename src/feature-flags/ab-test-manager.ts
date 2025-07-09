// src/feature-flags/ab-test-manager.ts
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';
import { FeatureFlagManager, EvaluationContext } from './feature-flag-manager';
import { EventEmitter } from 'events';
import crypto from 'crypto';

export interface ABTest {
  id: string;
  name: string;
  description: string;
  hypothesis: string;
  status: 'draft' | 'running' | 'paused' | 'completed' | 'cancelled';
  variants: ABVariant[];
  traffic: {
    allocation: number; // 0-100, percentage of users to include in test
    strategy: 'user_id' | 'session_id' | 'random';
  };
  metrics: {
    primary: ABMetric[];
    secondary: ABMetric[];
  };
  schedule: {
    startDate: Date;
    endDate?: Date;
    duration?: number; // days, if no end date
  };
  targeting: {
    conditions: TargetingCondition[];
    segments?: string[];
  };
  configuration: {
    confidenceLevel: number; // 0.9, 0.95, 0.99
    minSampleSize: number;
    maxDuration: number; // days
    earlyStop: boolean;
    multipleComparisons: boolean;
  };
  metadata: {
    createdAt: Date;
    updatedAt: Date;
    createdBy: string;
    tags: string[];
  };
}

export interface ABVariant {
  id: string;
  name: string;
  description: string;
  allocation: number; // 0-100, percentage within the test
  isControl: boolean;
  configuration: Record<string, any>; // Feature flag overrides
}

export interface ABMetric {
  name: string;
  type: 'conversion' | 'numerical' | 'count';
  description: string;
  goal: 'increase' | 'decrease' | 'target';
  targetValue?: number; // for target goals
}

export interface TargetingCondition {
  attribute: string;
  operator: 'equals' | 'not_equals' | 'in' | 'not_in' | 'greater_than' | 'less_than';
  value: any;
}

export interface ABTestResult {
  testId: string;
  variantResults: VariantResult[];
  overallResults: {
    status: 'inconclusive' | 'significant' | 'no_difference';
    confidence: number;
    pValue: number;
    effect: 'positive' | 'negative' | 'neutral';
    recommendation: 'implement_winner' | 'continue_test' | 'stop_test' | 'redesign';
  };
  startDate: Date;
  analysisDate: Date;
}

export interface VariantResult {
  variantId: string;
  variantName: string;
  participants: number;
  metrics: MetricResult[];
  isWinner: boolean;
  confidenceInterval: { lower: number; upper: number };
}

export interface MetricResult {
  metricName: string;
  value: number;
  standardError: number;
  confidenceInterval: { lower: number; upper: number };
  compared_to_control?: {
    lift: number; // percentage change
    pValue: number;
    significant: boolean;
  };
}

export interface ABTestEvent {
  testId: string;
  variantId: string;
  userId: string;
  eventType: string;
  eventName: string;
  value?: number;
  timestamp: Date;
  properties: Record<string, any>;
}

export interface ABTestParticipant {
  testId: string;
  userId: string;
  variantId: string;
  assignedAt: Date;
  context: EvaluationContext;
}

export class ABTestManager extends EventEmitter {
  private logger: Logger;
  private cache: RedisCache;
  private flagManager: FeatureFlagManager;
  private tests: Map<string, ABTest> = new Map();
  private participants: Map<string, Map<string, ABTestParticipant>> = new Map(); // testId -> userId -> participant
  private events: ABTestEvent[] = [];
  private timers: Map<string, NodeJS.Timeout> = new Map();

  constructor(flagManager: FeatureFlagManager, logger: Logger, cache: RedisCache) {
    super();
    this.flagManager = flagManager;
    this.logger = logger;
    this.cache = cache;
    
    this.startAnalysisScheduler();
    this.loadPersistedTests();
  }

  private async loadPersistedTests(): Promise<void> {
    try {
      const testKeys = await this.cache.keys('abtest:*');
      
      for (const key of testKeys) {
        const testData = await this.cache.get(key);
        if (testData) {
          const test = JSON.parse(testData) as ABTest;
          // Parse dates
          test.schedule.startDate = new Date(test.schedule.startDate);
          if (test.schedule.endDate) {
            test.schedule.endDate = new Date(test.schedule.endDate);
          }
          test.metadata.createdAt = new Date(test.metadata.createdAt);
          test.metadata.updatedAt = new Date(test.metadata.updatedAt);
          
          this.tests.set(test.id, test);
        }
      }

      this.logger.info(`Loaded ${this.tests.size} A/B tests from cache`);
    } catch (error) {
      this.logger.error('Failed to load persisted A/B tests:', error);
    }
  }

  private startAnalysisScheduler(): void {
    // Run analysis every hour for active tests
    const timer = setInterval(async () => {
      await this.runScheduledAnalysis();
    }, 3600000);

    this.timers.set('analysis-scheduler', timer);
  }

  // Test management
  public async createTest(test: Omit<ABTest, 'id' | 'metadata'>): Promise<ABTest> {
    const testId = this.generateTestId(test.name);
    
    // Validate test configuration
    this.validateTestConfiguration(test);
    
    const newTest: ABTest = {
      id: testId,
      metadata: {
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'system',
        tags: []
      },
      ...test
    };

    this.tests.set(testId, newTest);
    this.participants.set(testId, new Map());
    
    await this.persistTest(newTest);

    // Create corresponding feature flag if needed
    await this.createTestFeatureFlag(newTest);

    this.logger.info(`A/B test created: ${test.name}`, { testId });
    this.emit('test-created', newTest);

    return newTest;
  }

  public async updateTest(testId: string, updates: Partial<ABTest>): Promise<ABTest> {
    const test = this.tests.get(testId);
    if (!test) {
      throw new Error(`A/B test ${testId} not found`);
    }

    // Prevent updates to running tests that could affect results
    if (test.status === 'running' && this.isResultCriticalUpdate(updates)) {
      throw new Error('Cannot modify critical parameters of a running test');
    }

    const updatedTest = {
      ...test,
      ...updates,
      metadata: {
        ...test.metadata,
        updatedAt: new Date()
      }
    };

    this.tests.set(testId, updatedTest);
    await this.persistTest(updatedTest);

    this.logger.info(`A/B test updated: ${test.name}`, { testId });
    this.emit('test-updated', updatedTest);

    return updatedTest;
  }

  public async startTest(testId: string): Promise<void> {
    const test = this.tests.get(testId);
    if (!test) {
      throw new Error(`A/B test ${testId} not found`);
    }

    if (test.status !== 'draft') {
      throw new Error(`Cannot start test in ${test.status} status`);
    }

    test.status = 'running';
    test.schedule.startDate = new Date();
    test.metadata.updatedAt = new Date();

    await this.persistTest(test);

    // Schedule end date if duration is specified
    if (test.schedule.duration && !test.schedule.endDate) {
      test.schedule.endDate = new Date(Date.now() + test.schedule.duration * 24 * 60 * 60 * 1000);
    }

    this.logger.info(`A/B test started: ${test.name}`, { testId });
    this.emit('test-started', test);
  }

  public async stopTest(testId: string, reason: 'completed' | 'cancelled' = 'completed'): Promise<void> {
    const test = this.tests.get(testId);
    if (!test) {
      throw new Error(`A/B test ${testId} not found`);
    }

    test.status = reason;
    test.metadata.updatedAt = new Date();

    await this.persistTest(test);

    this.logger.info(`A/B test stopped: ${test.name}`, { testId, reason });
    this.emit('test-stopped', { test, reason });
  }

  // User assignment and evaluation
  public async assignUserToTest(
    testId: string,
    userId: string,
    context: EvaluationContext = {}
  ): Promise<{ assigned: boolean; variantId?: string }> {
    const test = this.tests.get(testId);
    if (!test || test.status !== 'running') {
      return { assigned: false };
    }

    // Check if user is already assigned
    const testParticipants = this.participants.get(testId)!;
    const existing = testParticipants.get(userId);
    if (existing) {
      return { assigned: true, variantId: existing.variantId };
    }

    // Check targeting conditions
    if (!this.matchesTargeting(test.targeting, context)) {
      return { assigned: false };
    }

    // Check traffic allocation
    if (!this.shouldIncludeInTest(test.traffic, userId)) {
      return { assigned: false };
    }

    // Assign to variant
    const variantId = this.selectVariant(test.variants, userId);
    
    const participant: ABTestParticipant = {
      testId,
      userId,
      variantId,
      assignedAt: new Date(),
      context
    };

    testParticipants.set(userId, participant);
    await this.persistParticipant(participant);

    this.logger.debug(`User assigned to A/B test`, { testId, userId, variantId });
    this.emit('user-assigned', participant);

    return { assigned: true, variantId };
  }

  public async getTestVariant(
    testId: string,
    userId: string,
    context: EvaluationContext = {}
  ): Promise<string | null> {
    const assignment = await this.assignUserToTest(testId, userId, context);
    return assignment.variantId || null;
  }

  public async evaluateTestFlags(
    testId: string,
    userId: string,
    context: EvaluationContext = {}
  ): Promise<Record<string, any>> {
    const variantId = await this.getTestVariant(testId, userId, context);
    if (!variantId) {
      return {};
    }

    const test = this.tests.get(testId);
    if (!test) {
      return {};
    }

    const variant = test.variants.find(v => v.id === variantId);
    if (!variant) {
      return {};
    }

    // Apply variant configuration as feature flag overrides
    const overrides: Record<string, any> = {};
    
    for (const [flagId, value] of Object.entries(variant.configuration)) {
      overrides[flagId] = value;
    }

    return overrides;
  }

  // Event tracking
  public async trackEvent(
    testId: string,
    userId: string,
    eventName: string,
    eventType: string = 'conversion',
    value?: number,
    properties: Record<string, any> = {}
  ): Promise<void> {
    const test = this.tests.get(testId);
    if (!test || test.status !== 'running') {
      return;
    }

    const testParticipants = this.participants.get(testId);
    const participant = testParticipants?.get(userId);
    if (!participant) {
      return; // User not in test
    }

    const event: ABTestEvent = {
      testId,
      variantId: participant.variantId,
      userId,
      eventType,
      eventName,
      value,
      timestamp: new Date(),
      properties
    };

    this.events.push(event);
    
    // Limit events to prevent memory issues
    if (this.events.length > 100000) {
      this.events = this.events.slice(-50000);
    }

    await this.persistEvent(event);
    
    this.emit('event-tracked', event);
  }

  // Analysis and results
  public async analyzeTest(testId: string): Promise<ABTestResult | null> {
    const test = this.tests.get(testId);
    if (!test) {
      return null;
    }

    const testEvents = this.events.filter(e => e.testId === testId);
    const testParticipants = this.participants.get(testId);
    
    if (!testParticipants || testParticipants.size < test.configuration.minSampleSize) {
      return null; // Insufficient data
    }

    const variantResults = await this.analyzeVariants(test, testEvents, testParticipants);
    const overallResults = await this.calculateOverallResults(test, variantResults);

    const result: ABTestResult = {
      testId,
      variantResults,
      overallResults,
      startDate: test.schedule.startDate,
      analysisDate: new Date()
    };

    this.emit('test-analyzed', result);
    return result;
  }

  private async analyzeVariants(
    test: ABTest,
    events: ABTestEvent[],
    participants: Map<string, ABTestParticipant>
  ): Promise<VariantResult[]> {
    const results: VariantResult[] = [];

    for (const variant of test.variants) {
      const variantParticipants = Array.from(participants.values())
        .filter(p => p.variantId === variant.id);
      
      const variantEvents = events.filter(e => e.variantId === variant.id);
      
      const metrics = await this.calculateVariantMetrics(
        test.metrics.primary.concat(test.metrics.secondary),
        variantEvents,
        variantParticipants
      );

      results.push({
        variantId: variant.id,
        variantName: variant.name,
        participants: variantParticipants.length,
        metrics,
        isWinner: false, // Will be determined in overall analysis
        confidenceInterval: { lower: 0, upper: 0 } // Will be calculated
      });
    }

    return results;
  }

  private async calculateVariantMetrics(
    metricDefinitions: ABMetric[],
    events: ABTestEvent[],
    participants: ABTestParticipant[]
  ): Promise<MetricResult[]> {
    const results: MetricResult[] = [];

    for (const metricDef of metricDefinitions) {
      const metricEvents = events.filter(e => e.eventName === metricDef.name);
      
      let value = 0;
      let standardError = 0;

      switch (metricDef.type) {
        case 'conversion':
          const conversions = new Set(metricEvents.map(e => e.userId)).size;
          value = (conversions / participants.length) * 100; // Conversion rate percentage
          standardError = Math.sqrt((value / 100) * (1 - value / 100) / participants.length) * 100;
          break;
          
        case 'numerical':
          const values = metricEvents.map(e => e.value || 0);
          value = values.reduce((sum, v) => sum + v, 0) / Math.max(participants.length, 1);
          const variance = values.reduce((sum, v) => sum + Math.pow(v - value, 2), 0) / Math.max(values.length - 1, 1);
          standardError = Math.sqrt(variance / participants.length);
          break;
          
        case 'count':
          value = metricEvents.length / Math.max(participants.length, 1);
          standardError = Math.sqrt(value / participants.length);
          break;
      }

      results.push({
        metricName: metricDef.name,
        value,
        standardError,
        confidenceInterval: this.calculateConfidenceInterval(value, standardError, 0.95)
      });
    }

    return results;
  }

  private async calculateOverallResults(
    test: ABTest,
    variantResults: VariantResult[]
  ): Promise<ABTestResult['overallResults']> {
    const controlVariant = variantResults.find(vr => 
      test.variants.find(v => v.id === vr.variantId)?.isControl
    );

    if (!controlVariant || variantResults.length < 2) {
      return {
        status: 'inconclusive',
        confidence: 0,
        pValue: 1,
        effect: 'neutral',
        recommendation: 'continue_test'
      };
    }

    // Find the best performing variant for primary metric
    const primaryMetric = test.metrics.primary[0];
    if (!primaryMetric) {
      return {
        status: 'inconclusive',
        confidence: 0,
        pValue: 1,
        effect: 'neutral',
        recommendation: 'continue_test'
      };
    }

    let bestVariant = controlVariant;
    let bestValue = controlVariant.metrics.find(m => m.metricName === primaryMetric.name)?.value || 0;

    for (const variant of variantResults) {
      const metricValue = variant.metrics.find(m => m.metricName === primaryMetric.name)?.value || 0;
      
      const isBetter = primaryMetric.goal === 'increase' ? metricValue > bestValue :
                     primaryMetric.goal === 'decrease' ? metricValue < bestValue :
                     Math.abs(metricValue - (primaryMetric.targetValue || 0)) < Math.abs(bestValue - (primaryMetric.targetValue || 0));

      if (isBetter) {
        bestVariant = variant;
        bestValue = metricValue;
      }
    }

    // Calculate statistical significance
    const controlMetric = controlVariant.metrics.find(m => m.metricName === primaryMetric.name);
    const testMetric = bestVariant.metrics.find(m => m.metricName === primaryMetric.name);

    if (!controlMetric || !testMetric) {
      return {
        status: 'inconclusive',
        confidence: 0,
        pValue: 1,
        effect: 'neutral',
        recommendation: 'continue_test'
      };
    }

    const { pValue, significant } = this.performTTest(
      controlMetric.value,
      controlMetric.standardError,
      controlVariant.participants,
      testMetric.value,
      testMetric.standardError,
      bestVariant.participants
    );

    const confidence = (1 - pValue) * 100;
    const effect = bestVariant === controlVariant ? 'neutral' :
                  testMetric.value > controlMetric.value ? 'positive' : 'negative';

    // Mark winner
    if (significant && bestVariant !== controlVariant) {
      bestVariant.isWinner = true;
    }

    let recommendation: ABTestResult['overallResults']['recommendation'] = 'continue_test';
    
    if (significant) {
      recommendation = bestVariant === controlVariant ? 'stop_test' : 'implement_winner';
    } else if (confidence < 20) {
      recommendation = 'redesign';
    }

    return {
      status: significant ? 'significant' : 'inconclusive',
      confidence,
      pValue,
      effect,
      recommendation
    };
  }

  // Statistical methods
  private performTTest(
    mean1: number, se1: number, n1: number,
    mean2: number, se2: number, n2: number
  ): { pValue: number; significant: boolean } {
    // Simplified t-test implementation
    const pooledSE = Math.sqrt((se1 * se1) + (se2 * se2));
    const tStat = Math.abs(mean1 - mean2) / pooledSE;
    const df = n1 + n2 - 2;
    
    // Simplified p-value calculation (would use proper t-distribution in production)
    const pValue = Math.max(0.001, 2 * (1 - this.normalCDF(tStat)));
    const significant = pValue < 0.05;

    return { pValue, significant };
  }

  private normalCDF(x: number): number {
    // Simplified normal distribution CDF
    return 0.5 * (1 + this.erf(x / Math.sqrt(2)));
  }

  private erf(x: number): number {
    // Simplified error function approximation
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;

    const sign = x >= 0 ? 1 : -1;
    x = Math.abs(x);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return sign * y;
  }

  private calculateConfidenceInterval(
    value: number, 
    standardError: number, 
    confidence: number
  ): { lower: number; upper: number } {
    const z = confidence === 0.95 ? 1.96 : confidence === 0.99 ? 2.58 : 1.645;
    const margin = z * standardError;
    
    return {
      lower: value - margin,
      upper: value + margin
    };
  }

  // Helper methods
  private validateTestConfiguration(test: any): void {
    if (!test.variants || test.variants.length < 2) {
      throw new Error('Test must have at least 2 variants');
    }

    const totalAllocation = test.variants.reduce((sum: number, v: any) => sum + v.allocation, 0);
    if (Math.abs(totalAllocation - 100) > 0.1) {
      throw new Error('Variant allocations must sum to 100%');
    }

    const controlVariants = test.variants.filter((v: any) => v.isControl);
    if (controlVariants.length !== 1) {
      throw new Error('Test must have exactly one control variant');
    }

    if (!test.metrics.primary || test.metrics.primary.length === 0) {
      throw new Error('Test must have at least one primary metric');
    }
  }

  private isResultCriticalUpdate(updates: Partial<ABTest>): boolean {
    return !!(updates.variants || updates.traffic || updates.targeting || updates.metrics);
  }

  private matchesTargeting(targeting: ABTest['targeting'], context: EvaluationContext): boolean {
    for (const condition of targeting.conditions) {
      const contextValue = this.getContextValue(condition.attribute, context);
      
      if (!this.evaluateCondition(condition, contextValue)) {
        return false;
      }
    }
    
    return true;
  }

  private getContextValue(attribute: string, context: EvaluationContext): any {
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

  private evaluateCondition(condition: TargetingCondition, value: any): boolean {
    switch (condition.operator) {
      case 'equals': return value === condition.value;
      case 'not_equals': return value !== condition.value;
      case 'in': return Array.isArray(condition.value) && condition.value.includes(value);
      case 'not_in': return Array.isArray(condition.value) && !condition.value.includes(value);
      case 'greater_than': return Number(value) > Number(condition.value);
      case 'less_than': return Number(value) < Number(condition.value);
      default: return false;
    }
  }

  private shouldIncludeInTest(traffic: ABTest['traffic'], userId: string): boolean {
    if (traffic.allocation >= 100) return true;
    if (traffic.allocation <= 0) return false;
    
    const hash = crypto.createHash('md5').update(userId).digest('hex');
    const hashValue = parseInt(hash.substr(0, 8), 16);
    const bucket = (hashValue % 100);
    
    return bucket < traffic.allocation;
  }

  private selectVariant(variants: ABVariant[], userId: string): string {
    const hash = crypto.createHash('md5').update(userId + '_variant').digest('hex');
    const hashValue = parseInt(hash.substr(0, 8), 16);
    const bucket = hashValue % 100;
    
    let cumulative = 0;
    for (const variant of variants) {
      cumulative += variant.allocation;
      if (bucket < cumulative) {
        return variant.id;
      }
    }
    
    return variants[0].id; // Fallback
  }

  private generateTestId(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now();
  }

  private async createTestFeatureFlag(test: ABTest): Promise<void> {
    // Create a feature flag that integrates with the A/B test
    try {
      await this.flagManager.createFlag({
        name: `ab_test_${test.id}`,
        description: `Feature flag for A/B test: ${test.name}`,
        type: 'variant',
        enabled: test.status === 'running',
        rules: [],
        variants: test.variants.map(variant => ({
          id: variant.id,
          name: variant.name,
          value: variant.configuration,
          weight: variant.allocation,
          description: variant.description
        })),
        rollout: {
          enabled: true,
          percentage: test.traffic.allocation,
          strategy: test.traffic.strategy as any
        }
      });
    } catch (error) {
      this.logger.warn(`Failed to create feature flag for A/B test ${test.id}:`, error);
    }
  }

  // Persistence
  private async persistTest(test: ABTest): Promise<void> {
    await this.cache.set(`abtest:${test.id}`, JSON.stringify(test), 86400 * 90); // 90 days
  }

  private async persistParticipant(participant: ABTestParticipant): Promise<void> {
    const key = `abtest:participant:${participant.testId}:${participant.userId}`;
    await this.cache.set(key, JSON.stringify(participant), 86400 * 90); // 90 days
  }

  private async persistEvent(event: ABTestEvent): Promise<void> {
    const key = `abtest:event:${event.testId}:${Date.now()}:${Math.random()}`;
    await this.cache.set(key, JSON.stringify(event), 86400 * 30); // 30 days
  }

  // Scheduled operations
  private async runScheduledAnalysis(): Promise<void> {
    for (const test of this.tests.values()) {
      if (test.status !== 'running') continue;

      try {
        const result = await this.analyzeTest(test.id);
        
        if (result) {
          // Check for automatic stopping conditions
          if (test.configuration.earlyStop && result.overallResults.status === 'significant') {
            await this.stopTest(test.id, 'completed');
            this.logger.info(`A/B test automatically stopped due to significant results`, {
              testId: test.id,
              confidence: result.overallResults.confidence
            });
          }
        }

        // Check for end date
        if (test.schedule.endDate && new Date() > test.schedule.endDate) {
          await this.stopTest(test.id, 'completed');
          this.logger.info(`A/B test automatically stopped due to end date`, {
            testId: test.id
          });
        }

      } catch (error) {
        this.logger.error(`Analysis failed for A/B test ${test.id}:`, error);
      }
    }
  }

  // Public API
  public getTest(testId: string): ABTest | undefined {
    return this.tests.get(testId);
  }

  public getAllTests(): ABTest[] {
    return Array.from(this.tests.values());
  }

  public getActiveTests(): ABTest[] {
    return Array.from(this.tests.values()).filter(test => test.status === 'running');
  }

  public async getTestsForUser(userId: string): Promise<Array<{ testId: string; variantId: string }>> {
    const userTests: Array<{ testId: string; variantId: string }> = [];
    
    for (const [testId, participants] of this.participants.entries()) {
      const participant = participants.get(userId);
      if (participant) {
        userTests.push({
          testId: participant.testId,
          variantId: participant.variantId
        });
      }
    }
    
    return userTests;
  }

  public getTestSummary(): {
    total: number;
    running: number;
    completed: number;
    participants: number;
    events: number;
  } {
    const tests = Array.from(this.tests.values());
    let totalParticipants = 0;
    
    for (const participants of this.participants.values()) {
      totalParticipants += participants.size;
    }

    return {
      total: tests.length,
      running: tests.filter(t => t.status === 'running').length,
      completed: tests.filter(t => t.status === 'completed').length,
      participants: totalParticipants,
      events: this.events.length
    };
  }

  public destroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    
    this.tests.clear();
    this.participants.clear();
    this.events = [];
    
    this.logger.info('A/B test manager destroyed');
  }
}
