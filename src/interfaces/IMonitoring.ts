// Monitoring and analytics interface definitions
// Providing comprehensive visibility into pool operations

export interface IMonitoringConfig {
  enableMetrics: boolean;
  enableAlerts: boolean;
  enableDashboard: boolean;
  metricsPort: number;
  dashboardPort: number;
  retentionDays: number;
  alertChannels: IAlertChannel[];
  customMetrics?: ICustomMetric[];
}

// Metrics collection interfaces
export interface IMetricsCollector {
  initialize(config: IMonitoringConfig): Promise<void>;
  recordGauge(name: string, value: number, labels?: Record<string, string>): void;
  recordCounter(name: string, value?: number, labels?: Record<string, string>): void;
  recordHistogram(name: string, value: number, labels?: Record<string, string>): void;
  recordSummary(name: string, value: number, labels?: Record<string, string>): void;
  getMetric(name: string): IMetric | undefined;
  getAllMetrics(): IMetric[];
  exportMetrics(format: 'prometheus' | 'json' | 'statsd'): string;
  reset(): void;
}

export interface IMetric {
  name: string;
  type: 'gauge' | 'counter' | 'histogram' | 'summary';
  help?: string;
  value?: number;
  values?: Array<{ labels: Record<string, string>; value: number }>;
  histogram?: {
    buckets: Array<{ le: number; count: number }>;
    sum: number;
    count: number;
  };
  summary?: {
    quantiles: Array<{ quantile: number; value: number }>;
    sum: number;
    count: number;
  };
  timestamp: number;
}

export interface ICustomMetric {
  name: string;
  type: 'gauge' | 'counter' | 'histogram' | 'summary';
  help: string;
  labels?: string[];
  buckets?: number[];
  quantiles?: number[];
  maxAge?: number;
  ageBuckets?: number;
}

// Alert management interfaces
export interface IAlertManager {
  initialize(channels: IAlertChannel[]): Promise<void>;
  defineAlert(alert: IAlertDefinition): void;
  checkAlerts(): Promise<void>;
  sendAlert(alert: IAlert): Promise<void>;
  acknowledgeAlert(alertId: string, userId: string, notes?: string): Promise<void>;
  resolveAlert(alertId: string, resolution?: string): Promise<void>;
  getActiveAlerts(): IAlert[];
  getAlertHistory(query?: IAlertQuery): Promise<IAlert[]>;
  testChannel(channelId: string): Promise<boolean>;
}

export interface IAlertChannel {
  id: string;
  type: 'email' | 'webhook' | 'discord' | 'telegram' | 'slack' | 'pagerduty';
  name: string;
  config: Record<string, any>;
  enabled: boolean;
  severities?: Array<'info' | 'warning' | 'error' | 'critical'>;
}

export interface IAlertDefinition {
  id: string;
  name: string;
  description: string;
  condition: {
    metric: string;
    operator: 'gt' | 'lt' | 'eq' | 'ne' | 'gte' | 'lte';
    threshold: number;
    duration?: number;
    aggregation?: 'avg' | 'sum' | 'min' | 'max' | 'count';
  };
  severity: 'info' | 'warning' | 'error' | 'critical';
  channels: string[];
  cooldown?: number;
  enabled: boolean;
  metadata?: Record<string, any>;
}

export interface IAlert {
  id: string;
  definitionId: string;
  name: string;
  description: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  status: 'active' | 'acknowledged' | 'resolved';
  triggeredAt: Date;
  acknowledgedAt?: Date;
  resolvedAt?: Date;
  acknowledgedBy?: string;
  value: number;
  threshold: number;
  metadata?: Record<string, any>;
  notes?: string;
  resolution?: string;
}

export interface IAlertQuery {
  status?: 'active' | 'acknowledged' | 'resolved';
  severity?: 'info' | 'warning' | 'error' | 'critical';
  startDate?: Date;
  endDate?: Date;
  definitionId?: string;
  limit?: number;
  offset?: number;
}

// Dashboard interfaces
export interface IDashboard {
  initialize(config: IDashboardConfig): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  addWidget(widget: IWidget): void;
  removeWidget(widgetId: string): void;
  updateWidget(widgetId: string, updates: Partial<IWidget>): void;
  getLayout(): IDashboardLayout;
  setLayout(layout: IDashboardLayout): void;
  exportDashboard(): IDashboardExport;
  importDashboard(data: IDashboardExport): void;
}

export interface IDashboardConfig {
  port: number;
  refreshInterval: number;
  theme?: 'light' | 'dark' | 'auto';
  authentication?: boolean;
  customCSS?: string;
  logo?: string;
  title?: string;
}

export interface IWidget {
  id: string;
  type: 'chart' | 'stat' | 'table' | 'log' | 'map' | 'custom';
  title: string;
  dataSource: {
    type: 'metric' | 'query' | 'api' | 'static';
    source: string;
    refresh?: number;
    transform?: string;
  };
  visualization: {
    chartType?: 'line' | 'bar' | 'pie' | 'gauge' | 'heatmap';
    columns?: string[];
    aggregation?: string;
    groupBy?: string;
    options?: Record<string, any>;
  };
  position: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
}

export interface IDashboardLayout {
  widgets: IWidget[];
  gridCols: number;
  gridRows: number;
  breakpoints?: Record<string, number>;
}

export interface IDashboardExport {
  version: string;
  name: string;
  description?: string;
  layout: IDashboardLayout;
  theme?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Performance monitoring interfaces
export interface IPerformanceMonitor {
  startTransaction(name: string, tags?: Record<string, string>): ITransaction;
  measureOperation<T>(name: string, operation: () => Promise<T>): Promise<T>;
  recordLatency(operation: string, latency: number): void;
  recordThroughput(operation: string, count: number): void;
  recordError(operation: string, error: Error): void;
  getPerformanceReport(): IPerformanceReport;
  getBottlenecks(): IBottleneck[];
  getSuggestions(): IPerformanceSuggestion[];
}

export interface ITransaction {
  id: string;
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  tags: Record<string, string>;
  spans: ISpan[];
  status: 'running' | 'completed' | 'failed';
  
  startSpan(name: string): ISpan;
  finish(): void;
  setTag(key: string, value: string): void;
  setStatus(status: 'ok' | 'error'): void;
}

export interface ISpan {
  id: string;
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  tags: Record<string, string>;
  
  finish(): void;
  setTag(key: string, value: string): void;
}

export interface IPerformanceReport {
  period: IPeriod;
  summary: {
    avgResponseTime: number;
    p50ResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
    throughput: number;
    errorRate: number;
    availability: number;
  };
  operations: Array<{
    name: string;
    count: number;
    avgDuration: number;
    minDuration: number;
    maxDuration: number;
    errorCount: number;
    errorRate: number;
  }>;
  slowestOperations: Array<{
    name: string;
    duration: number;
    timestamp: Date;
    tags?: Record<string, string>;
  }>;
  errors: Array<{
    operation: string;
    error: string;
    count: number;
    lastOccurred: Date;
  }>;
}

export interface IBottleneck {
  component: string;
  metric: string;
  currentValue: number;
  threshold: number;
  impact: 'low' | 'medium' | 'high';
  description: string;
  suggestions: string[];
}

export interface IPerformanceSuggestion {
  category: 'database' | 'network' | 'cpu' | 'memory' | 'disk' | 'code';
  priority: 'low' | 'medium' | 'high';
  title: string;
  description: string;
  estimatedImprovement: string;
  implementation: string;
  effort: 'low' | 'medium' | 'high';
}

// Analytics interfaces
export interface IAnalyticsService {
  trackEvent(event: IAnalyticsEvent): Promise<void>;
  trackPageView(page: string, userId?: string): Promise<void>;
  trackTiming(category: string, variable: string, time: number): Promise<void>;
  trackException(error: Error, fatal?: boolean): Promise<void>;
  setUserProperty(userId: string, property: string, value: any): Promise<void>;
  getEventStats(query: IEventQuery): Promise<IEventStats>;
  getUserStats(query: IUserQuery): Promise<IUserStats>;
  getConversionFunnel(steps: string[]): Promise<IFunnelStats>;
  getCohortAnalysis(cohortDef: ICohortDefinition): Promise<ICohortStats>;
}

export interface IAnalyticsEvent {
  category: string;
  action: string;
  label?: string;
  value?: number;
  userId?: string;
  sessionId?: string;
  properties?: Record<string, any>;
  timestamp?: Date;
}

export interface IEventQuery {
  category?: string;
  action?: string;
  startDate?: Date;
  endDate?: Date;
  userId?: string;
  limit?: number;
  groupBy?: string[];
}

export interface IEventStats {
  totalEvents: number;
  uniqueUsers: number;
  eventsPerUser: number;
  topEvents: Array<{ event: string; count: number }>;
  timeline: Array<{ date: Date; count: number }>;
}

export interface IUserQuery {
  startDate?: Date;
  endDate?: Date;
  cohort?: string;
  properties?: Record<string, any>;
}

export interface IUserStats {
  totalUsers: number;
  activeUsers: number;
  newUsers: number;
  retention: {
    day1: number;
    day7: number;
    day30: number;
  };
  engagement: {
    avgSessionDuration: number;
    avgPageViews: number;
    bounceRate: number;
  };
}

export interface IFunnelStats {
  steps: Array<{
    name: string;
    users: number;
    conversionRate: number;
    dropoff: number;
  }>;
  overallConversion: number;
  avgTimeToConvert: number;
}

export interface ICohortDefinition {
  name: string;
  startDate: Date;
  endDate: Date;
  criteria: Record<string, any>;
}

export interface ICohortStats {
  cohort: string;
  size: number;
  retention: Array<{
    period: number;
    retained: number;
    percentage: number;
  }>;
  ltv: number;
  avgEngagement: number;
}

// Health check interfaces
export interface IHealthCheckService {
  addCheck(check: IHealthCheck): void;
  removeCheck(name: string): void;
  runChecks(): Promise<IHealthStatus>;
  getStatus(): IHealthStatus;
  getHistory(minutes?: number): IHealthHistory[];
  setThresholds(thresholds: IHealthThresholds): void;
}

export interface IHealthCheck {
  name: string;
  description?: string;
  check: () => Promise<IHealthCheckResult>;
  critical?: boolean;
  timeout?: number;
  interval?: number;
}

export interface IHealthCheckResult {
  healthy: boolean;
  message?: string;
  details?: Record<string, any>;
  duration?: number;
}

export interface IHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: Date;
  checks: Array<{
    name: string;
    status: 'pass' | 'warn' | 'fail';
    message?: string;
    duration: number;
    lastCheck: Date;
  }>;
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    unhealthy: number;
  };
}

export interface IHealthHistory {
  timestamp: Date;
  status: 'healthy' | 'degraded' | 'unhealthy';
  failedChecks: string[];
}

export interface IHealthThresholds {
  degradedThreshold: number;
  unhealthyThreshold: number;
  checkTimeout: number;
  historyRetention: number;
}
