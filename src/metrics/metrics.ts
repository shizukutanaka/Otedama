// Metrics collection system (Pike-style simplicity with Prometheus compatibility)
import { createComponentLogger } from '../logging/logger';

export enum MetricType {
  COUNTER = 'counter',
  GAUGE = 'gauge',
  HISTOGRAM = 'histogram',
  SUMMARY = 'summary'
}

export interface MetricLabels {
  [key: string]: string;
}

export interface MetricValue {
  value: number;
  labels?: MetricLabels;
  timestamp?: number;
}

export interface MetricData {
  name: string;
  type: MetricType;
  help: string;
  values: MetricValue[];
}

export interface HistogramBucket {
  le: number;  // less than or equal
  count: number;
}

export interface HistogramData {
  buckets: HistogramBucket[];
  sum: number;
  count: number;
}

export interface SummaryQuantile {
  quantile: number;
  value: number;
}

export interface SummaryData {
  quantiles: SummaryQuantile[];
  sum: number;
  count: number;
}

// Base metric class
export abstract class Metric {
  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = []
  ) {
    // Validate metric name (Prometheus naming convention)
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) {
      throw new Error(`Invalid metric name: ${name}`);
    }
  }
  
  abstract get type(): MetricType;
  abstract collect(): MetricValue[];
  abstract reset(): void;
  
  // Format labels for Prometheus
  protected formatLabels(labels?: MetricLabels): string {
    if (!labels || Object.keys(labels).length === 0) {
      return '';
    }
    
    const pairs = Object.entries(labels)
      .map(([key, value]) => `${key}="${this.escapeLabel(value)}"`)
      .join(',');
    
    return `{${pairs}}`;
  }
  
  private escapeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
}

// Counter - monotonically increasing value
export class Counter extends Metric {
  private values = new Map<string, number>();
  
  get type(): MetricType {
    return MetricType.COUNTER;
  }
  
  inc(labels?: MetricLabels, value: number = 1): void {
    if (value < 0) {
      throw new Error('Counter can only increase');
    }
    
    const key = this.getKey(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }
  
  collect(): MetricValue[] {
    const results: MetricValue[] = [];
    
    for (const [key, value] of this.values) {
      const labels = this.parseKey(key);
      results.push({ value, labels });
    }
    
    return results;
  }
  
  reset(): void {
    this.values.clear();
  }
  
  private getKey(labels?: MetricLabels): string {
    if (!labels) return '';
    return JSON.stringify(labels);
  }
  
  private parseKey(key: string): MetricLabels | undefined {
    if (!key) return undefined;
    return JSON.parse(key);
  }
}

// Gauge - value that can go up or down
export class Gauge extends Metric {
  private values = new Map<string, number>();
  
  get type(): MetricType {
    return MetricType.GAUGE;
  }
  
  set(value: number, labels?: MetricLabels): void {
    const key = this.getKey(labels);
    this.values.set(key, value);
  }
  
  inc(labels?: MetricLabels, value: number = 1): void {
    const key = this.getKey(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }
  
  dec(labels?: MetricLabels, value: number = 1): void {
    this.inc(labels, -value);
  }
  
  collect(): MetricValue[] {
    const results: MetricValue[] = [];
    
    for (const [key, value] of this.values) {
      const labels = this.parseKey(key);
      results.push({ value, labels });
    }
    
    return results;
  }
  
  reset(): void {
    this.values.clear();
  }
  
  private getKey(labels?: MetricLabels): string {
    if (!labels) return '';
    return JSON.stringify(labels);
  }
  
  private parseKey(key: string): MetricLabels | undefined {
    if (!key) return undefined;
    return JSON.parse(key);
  }
}

// Histogram - track distributions
export class Histogram extends Metric {
  private buckets: number[];
  private data = new Map<string, HistogramData>();
  
  constructor(
    name: string,
    help: string,
    buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    labelNames: string[] = []
  ) {
    super(name, help, labelNames);
    this.buckets = [...buckets].sort((a, b) => a - b);
    
    // Add +Inf bucket
    if (this.buckets[this.buckets.length - 1] !== Infinity) {
      this.buckets.push(Infinity);
    }
  }
  
  get type(): MetricType {
    return MetricType.HISTOGRAM;
  }
  
  observe(value: number, labels?: MetricLabels): void {
    const key = this.getKey(labels);
    let data = this.data.get(key);
    
    if (!data) {
      data = {
        buckets: this.buckets.map(le => ({ le, count: 0 })),
        sum: 0,
        count: 0
      };
      this.data.set(key, data);
    }
    
    // Update buckets
    for (const bucket of data.buckets) {
      if (value <= bucket.le) {
        bucket.count++;
      }
    }
    
    // Update sum and count
    data.sum += value;
    data.count++;
  }
  
  collect(): MetricValue[] {
    const results: MetricValue[] = [];
    
    for (const [key, data] of this.data) {
      const labels = this.parseKey(key);
      
      // Emit bucket values
      for (const bucket of data.buckets) {
        results.push({
          value: bucket.count,
          labels: { ...labels, le: bucket.le.toString() }
        });
      }
      
      // Emit sum
      results.push({
        value: data.sum,
        labels: { ...labels, __name__: `${this.name}_sum` }
      });
      
      // Emit count
      results.push({
        value: data.count,
        labels: { ...labels, __name__: `${this.name}_count` }
      });
    }
    
    return results;
  }
  
  reset(): void {
    this.data.clear();
  }
  
  private getKey(labels?: MetricLabels): string {
    if (!labels) return '';
    return JSON.stringify(labels);
  }
  
  private parseKey(key: string): MetricLabels | undefined {
    if (!key) return undefined;
    return JSON.parse(key);
  }
}

// Timer - convenience wrapper around Histogram for timing
export class Timer {
  private startTime: number;
  
  constructor(private histogram: Histogram, private labels?: MetricLabels) {
    this.startTime = Date.now();
  }
  
  end(): number {
    const duration = (Date.now() - this.startTime) / 1000; // Convert to seconds
    this.histogram.observe(duration, this.labels);
    return duration;
  }
}

// Metrics registry
export class MetricsRegistry {
  private logger = createComponentLogger('MetricsRegistry');
  private metrics = new Map<string, Metric>();
  
  register(metric: Metric): void {
    if (this.metrics.has(metric.name)) {
      throw new Error(`Metric ${metric.name} already registered`);
    }
    
    this.metrics.set(metric.name, metric);
    this.logger.debug(`Registered metric: ${metric.name}`);
  }
  
  unregister(name: string): void {
    this.metrics.delete(name);
  }
  
  get(name: string): Metric | undefined {
    return this.metrics.get(name);
  }
  
  // Collect all metrics in Prometheus format
  collect(): string {
    const lines: string[] = [];
    
    for (const metric of this.metrics.values()) {
      // Add help text
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      
      // Add type
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      
      // Add values
      const values = metric.collect();
      for (const { value, labels } of values) {
        const metricName = labels?.__name__ || metric.name;
        const filteredLabels = { ...labels };
        delete filteredLabels.__name__;
        
        const labelStr = metric['formatLabels'](filteredLabels);
        lines.push(`${metricName}${labelStr} ${value}`);
      }
      
      lines.push(''); // Empty line between metrics
    }
    
    return lines.join('\n');
  }
  
  // Reset all metrics
  reset(): void {
    for (const metric of this.metrics.values()) {
      metric.reset();
    }
  }
  
  // Get all registered metrics
  getMetrics(): Metric[] {
    return Array.from(this.metrics.values());
  }
}

// Default metrics for mining pool
export function createDefaultMetrics(registry: MetricsRegistry): void {
  // Shares
  const sharesTotal = new Counter(
    'pool_shares_total',
    'Total number of shares submitted',
    ['miner', 'difficulty', 'valid']
  );
  registry.register(sharesTotal);
  
  const sharesValid = new Counter(
    'pool_shares_valid_total',
    'Total number of valid shares',
    ['miner', 'difficulty']
  );
  registry.register(sharesValid);
  
  const sharesInvalid = new Counter(
    'pool_shares_invalid_total',
    'Total number of invalid shares',
    ['miner', 'reason']
  );
  registry.register(sharesInvalid);
  
  // Blocks
  const blocksFound = new Counter(
    'pool_blocks_found_total',
    'Total number of blocks found'
  );
  registry.register(blocksFound);
  
  const blocksOrphaned = new Counter(
    'pool_blocks_orphaned_total',
    'Total number of orphaned blocks'
  );
  registry.register(blocksOrphaned);
  
  // Miners
  const minersActive = new Gauge(
    'pool_miners_active',
    'Number of active miners'
  );
  registry.register(minersActive);
  
  const minersTotal = new Gauge(
    'pool_miners_total',
    'Total number of registered miners'
  );
  registry.register(minersTotal);
  
  // Hashrate
  const hashrate = new Gauge(
    'pool_hashrate_hps',
    'Pool hashrate in hashes per second'
  );
  registry.register(hashrate);
  
  const minerHashrate = new Gauge(
    'pool_miner_hashrate_hps',
    'Miner hashrate in hashes per second',
    ['miner']
  );
  registry.register(minerHashrate);
  
  // Connections
  const connections = new Gauge(
    'pool_connections_active',
    'Number of active stratum connections'
  );
  registry.register(connections);
  
  const connectionsDuration = new Histogram(
    'pool_connection_duration_seconds',
    'Connection duration in seconds',
    [60, 300, 900, 1800, 3600, 7200, 14400, 28800, 57600, 86400]
  );
  registry.register(connectionsDuration);
  
  // Share processing time
  const shareProcessingTime = new Histogram(
    'pool_share_processing_seconds',
    'Time to process a share in seconds',
    [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]
  );
  registry.register(shareProcessingTime);
  
  // RPC calls
  const rpcCalls = new Counter(
    'pool_rpc_calls_total',
    'Total number of RPC calls',
    ['method', 'status']
  );
  registry.register(rpcCalls);
  
  const rpcDuration = new Histogram(
    'pool_rpc_duration_seconds',
    'RPC call duration in seconds',
    [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    ['method']
  );
  registry.register(rpcDuration);
  
  // Database operations
  const dbOperations = new Counter(
    'pool_db_operations_total',
    'Total number of database operations',
    ['operation', 'status']
  );
  registry.register(dbOperations);
  
  const dbDuration = new Histogram(
    'pool_db_duration_seconds',
    'Database operation duration in seconds',
    [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    ['operation']
  );
  registry.register(dbDuration);
  
  // Payouts
  const payoutsTotal = new Counter(
    'pool_payouts_total',
    'Total number of payouts',
    ['status']
  );
  registry.register(payoutsTotal);
  
  const payoutAmount = new Gauge(
    'pool_payout_amount_btc',
    'Payout amount in BTC',
    ['miner']
  );
  registry.register(payoutAmount);
  
  // System metrics
  const cpuUsage = new Gauge(
    'pool_cpu_usage_percent',
    'CPU usage percentage'
  );
  registry.register(cpuUsage);
  
  const memoryUsage = new Gauge(
    'pool_memory_usage_bytes',
    'Memory usage in bytes',
    ['type']
  );
  registry.register(memoryUsage);
  
  const uptime = new Counter(
    'pool_uptime_seconds',
    'Pool uptime in seconds'
  );
  registry.register(uptime);
}

// Singleton registry
let defaultRegistry: MetricsRegistry | null = null;

export function getDefaultRegistry(): MetricsRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new MetricsRegistry();
    createDefaultMetrics(defaultRegistry);
  }
  return defaultRegistry;
}

// Convenience functions
export function counter(name: string, help: string, labelNames?: string[]): Counter {
  const metric = new Counter(name, help, labelNames);
  getDefaultRegistry().register(metric);
  return metric;
}

export function gauge(name: string, help: string, labelNames?: string[]): Gauge {
  const metric = new Gauge(name, help, labelNames);
  getDefaultRegistry().register(metric);
  return metric;
}

export function histogram(name: string, help: string, buckets?: number[], labelNames?: string[]): Histogram {
  const metric = new Histogram(name, help, buckets, labelNames);
  getDefaultRegistry().register(metric);
  return metric;
}
