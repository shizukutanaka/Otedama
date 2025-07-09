// Metrics HTTP server for Prometheus scraping
import * as http from 'http';
import { createComponentLogger } from '../logging/logger';
import { MetricsRegistry, getDefaultRegistry } from './metrics';

export interface MetricsServerConfig {
  port: number;
  path: string;
  host: string;
}

export class MetricsServer {
  private logger = createComponentLogger('MetricsServer');
  private server: http.Server | null = null;
  private config: MetricsServerConfig;
  private registry: MetricsRegistry;
  
  constructor(
    config: Partial<MetricsServerConfig> = {},
    registry?: MetricsRegistry
  ) {
    this.config = {
      port: 9090,
      path: '/metrics',
      host: '0.0.0.0',
      ...config
    };
    
    this.registry = registry || getDefaultRegistry();
  }
  
  // Start metrics server
  async start(): Promise<void> {
    if (this.server) {
      throw new Error('Metrics server already running');
    }
    
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
    
    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        this.logger.info(`Metrics server listening on http://${this.config.host}:${this.config.port}${this.config.path}`);
        resolve();
      });
      
      this.server!.on('error', (error) => {
        this.logger.error('Metrics server error', error);
        reject(error);
      });
    });
  }
  
  // Stop metrics server
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    
    return new Promise((resolve) => {
      this.server!.close(() => {
        this.logger.info('Metrics server stopped');
        this.server = null;
        resolve();
      });
    });
  }
  
  // Handle HTTP request
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Only handle GET requests to metrics path
    if (req.method !== 'GET' || req.url !== this.config.path) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    
    try {
      // Collect metrics
      const metrics = this.registry.collect();
      
      // Send response
      res.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4',
        'Content-Length': Buffer.byteLength(metrics)
      });
      
      res.end(metrics);
    } catch (error) {
      this.logger.error('Failed to collect metrics', error as Error);
      
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }
  
  // Get server URL
  getUrl(): string {
    return `http://${this.config.host}:${this.config.port}${this.config.path}`;
  }
  
  // Check if server is running
  isRunning(): boolean {
    return this.server !== null;
  }
}

// System metrics collector
export class SystemMetricsCollector {
  private logger = createComponentLogger('SystemMetrics');
  private interval: NodeJS.Timeout | null = null;
  private startTime = Date.now();
  
  constructor(
    private registry: MetricsRegistry,
    private intervalMs: number = 15000 // 15 seconds
  ) {}
  
  // Start collecting system metrics
  start(): void {
    if (this.interval) {
      return;
    }
    
    // Initial collection
    this.collect();
    
    // Start periodic collection
    this.interval = setInterval(() => {
      this.collect();
    }, this.intervalMs);
    
    this.logger.info('Started system metrics collection');
  }
  
  // Stop collecting
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      this.logger.info('Stopped system metrics collection');
    }
  }
  
  // Collect system metrics
  private collect(): void {
    try {
      // CPU usage
      const cpuUsage = process.cpuUsage();
      const cpuPercent = ((cpuUsage.user + cpuUsage.system) / 1000000) / (process.uptime() * 1000) * 100;
      
      const cpuGauge = this.registry.get('pool_cpu_usage_percent') as any;
      if (cpuGauge) {
        cpuGauge.set(cpuPercent);
      }
      
      // Memory usage
      const memUsage = process.memoryUsage();
      const memGauge = this.registry.get('pool_memory_usage_bytes') as any;
      if (memGauge) {
        memGauge.set(memUsage.heapUsed, { type: 'heap_used' });
        memGauge.set(memUsage.heapTotal, { type: 'heap_total' });
        memGauge.set(memUsage.rss, { type: 'rss' });
        memGauge.set(memUsage.external, { type: 'external' });
      }
      
      // Uptime
      const uptimeCounter = this.registry.get('pool_uptime_seconds') as any;
      if (uptimeCounter) {
        uptimeCounter.inc({}, process.uptime());
      }
    } catch (error) {
      this.logger.error('Failed to collect system metrics', error as Error);
    }
  }
}

// Metrics middleware for tracking HTTP requests
export function createMetricsMiddleware(registry?: MetricsRegistry) {
  const reg = registry || getDefaultRegistry();
  
  // Create metrics if not exists
  let requestCounter = reg.get('http_requests_total') as any;
  if (!requestCounter) {
    requestCounter = new (require('./metrics').Counter)(
      'http_requests_total',
      'Total number of HTTP requests',
      ['method', 'path', 'status']
    );
    reg.register(requestCounter);
  }
  
  let requestDuration = reg.get('http_request_duration_seconds') as any;
  if (!requestDuration) {
    requestDuration = new (require('./metrics').Histogram)(
      'http_request_duration_seconds',
      'HTTP request duration in seconds',
      [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      ['method', 'path', 'status']
    );
    reg.register(requestDuration);
  }
  
  return (req: any, res: any, next: any) => {
    const start = Date.now();
    const path = req.path || req.url;
    
    // Override res.end to capture metrics
    const originalEnd = res.end;
    res.end = function(...args: any[]) {
      const duration = (Date.now() - start) / 1000;
      const labels = {
        method: req.method,
        path: path,
        status: res.statusCode.toString()
      };
      
      requestCounter.inc(labels);
      requestDuration.observe(duration, labels);
      
      originalEnd.apply(res, args);
    };
    
    next();
  };
}

// Pool metrics updater
export class PoolMetricsUpdater {
  private logger = createComponentLogger('PoolMetrics');
  
  constructor(
    private registry: MetricsRegistry,
    private pool: any // Pool instance
  ) {}
  
  // Update share metrics
  updateShareMetrics(share: any, isValid: boolean): void {
    const sharesTotal = this.registry.get('pool_shares_total') as any;
    if (sharesTotal) {
      sharesTotal.inc({
        miner: share.minerId,
        difficulty: share.difficulty.toString(),
        valid: isValid.toString()
      });
    }
    
    if (isValid) {
      const sharesValid = this.registry.get('pool_shares_valid_total') as any;
      if (sharesValid) {
        sharesValid.inc({
          miner: share.minerId,
          difficulty: share.difficulty.toString()
        });
      }
    } else {
      const sharesInvalid = this.registry.get('pool_shares_invalid_total') as any;
      if (sharesInvalid) {
        sharesInvalid.inc({
          miner: share.minerId,
          reason: share.invalidReason || 'unknown'
        });
      }
    }
  }
  
  // Update miner metrics
  updateMinerMetrics(stats: any): void {
    const minersActive = this.registry.get('pool_miners_active') as any;
    if (minersActive) {
      minersActive.set(stats.activeMiners);
    }
    
    const minersTotal = this.registry.get('pool_miners_total') as any;
    if (minersTotal) {
      minersTotal.set(stats.totalMiners);
    }
  }
  
  // Update hashrate metrics
  updateHashrateMetrics(poolHashrate: number, minerHashrates: Map<string, number>): void {
    const hashrate = this.registry.get('pool_hashrate_hps') as any;
    if (hashrate) {
      hashrate.set(poolHashrate);
    }
    
    const minerHashrate = this.registry.get('pool_miner_hashrate_hps') as any;
    if (minerHashrate) {
      for (const [miner, rate] of minerHashrates) {
        minerHashrate.set(rate, { miner });
      }
    }
  }
  
  // Update connection metrics
  updateConnectionMetrics(connections: number): void {
    const connectionsGauge = this.registry.get('pool_connections_active') as any;
    if (connectionsGauge) {
      connectionsGauge.set(connections);
    }
  }
  
  // Record connection duration
  recordConnectionDuration(durationSeconds: number): void {
    const connectionsDuration = this.registry.get('pool_connection_duration_seconds') as any;
    if (connectionsDuration) {
      connectionsDuration.observe(durationSeconds);
    }
  }
  
  // Update block metrics
  updateBlockMetrics(found: boolean, orphaned: boolean = false): void {
    if (found) {
      const blocksFound = this.registry.get('pool_blocks_found_total') as any;
      if (blocksFound) {
        blocksFound.inc();
      }
    }
    
    if (orphaned) {
      const blocksOrphaned = this.registry.get('pool_blocks_orphaned_total') as any;
      if (blocksOrphaned) {
        blocksOrphaned.inc();
      }
    }
  }
}

// Export convenience function to start metrics server with defaults
export async function startMetricsServer(
  port: number = 9090,
  registry?: MetricsRegistry
): Promise<MetricsServer> {
  const server = new MetricsServer({ port }, registry);
  await server.start();
  
  // Start system metrics collection
  const systemCollector = new SystemMetricsCollector(registry || getDefaultRegistry());
  systemCollector.start();
  
  return server;
}
