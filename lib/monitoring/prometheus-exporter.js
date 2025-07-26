/**
 * Prometheus Metrics Exporter - Otedama
 * Exposes mining pool metrics in Prometheus format
 * 
 * Design Principles:
 * - Carmack: Minimal overhead, efficient collection
 * - Martin: Clean metric organization
 * - Pike: Simple exposition format
 */

import { createServer } from 'http';
import { Registry, Counter, Gauge, Histogram, Summary } from 'prom-client';
import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('PrometheusExporter');

/**
 * Metric types for mining pool
 */
const METRIC_TYPES = {
  // Pool metrics
  POOL_HASHRATE: 'otedama_pool_hashrate_hashes_per_second',
  POOL_MINERS: 'otedama_pool_miners_total',
  POOL_WORKERS: 'otedama_pool_workers_total',
  POOL_DIFFICULTY: 'otedama_pool_difficulty',
  
  // Share metrics
  SHARES_SUBMITTED: 'otedama_shares_submitted_total',
  SHARES_ACCEPTED: 'otedama_shares_accepted_total',
  SHARES_REJECTED: 'otedama_shares_rejected_total',
  SHARE_PROCESSING_TIME: 'otedama_share_processing_duration_seconds',
  
  // Block metrics
  BLOCKS_FOUND: 'otedama_blocks_found_total',
  BLOCK_EFFORT: 'otedama_block_effort_percentage',
  BLOCK_REWARD: 'otedama_block_reward_amount',
  
  // Payment metrics
  PAYMENTS_SENT: 'otedama_payments_sent_total',
  PAYMENT_AMOUNT: 'otedama_payment_amount_total',
  PAYMENT_PENDING: 'otedama_payment_pending_total',
  PAYMENT_FAILED: 'otedama_payment_failed_total',
  
  // Connection metrics
  CONNECTIONS_ACTIVE: 'otedama_connections_active',
  CONNECTIONS_TOTAL: 'otedama_connections_total',
  CONNECTION_DURATION: 'otedama_connection_duration_seconds',
  
  // Performance metrics
  CPU_USAGE: 'otedama_cpu_usage_percentage',
  MEMORY_USAGE: 'otedama_memory_usage_bytes',
  WORKER_THREADS: 'otedama_worker_threads_active',
  
  // Network metrics
  NETWORK_LATENCY: 'otedama_network_latency_milliseconds',
  STRATUM_MESSAGES: 'otedama_stratum_messages_total',
  P2P_PEERS: 'otedama_p2p_peers_connected',
  
  // Security metrics
  AUTH_ATTEMPTS: 'otedama_auth_attempts_total',
  AUTH_FAILURES: 'otedama_auth_failures_total',
  DDOS_BLOCKED: 'otedama_ddos_blocked_total',
  
  // Cache metrics
  CACHE_HITS: 'otedama_cache_hits_total',
  CACHE_MISSES: 'otedama_cache_misses_total',
  CACHE_SIZE: 'otedama_cache_size_bytes'
};

/**
 * Prometheus Metrics Exporter
 */
export class PrometheusExporter extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      port: config.port || 9090,
      host: config.host || '0.0.0.0',
      path: config.path || '/metrics',
      defaultLabels: config.defaultLabels || {},
      collectDefaultMetrics: config.collectDefaultMetrics !== false,
      prefix: config.prefix || 'otedama_',
      ...config
    };
    
    // Initialize registry
    this.registry = new Registry();
    
    // Set default labels
    this.registry.setDefaultLabels({
      pool: this.config.poolName || 'otedama',
      ...this.config.defaultLabels
    });
    
    // Initialize metrics
    this.metrics = {};
    this.initializeMetrics();
    
    // HTTP server
    this.server = null;
    this.running = false;
    
    // Component references
    this.components = new Map();
    
    this.logger = logger;
  }
  
  /**
   * Initialize metrics
   */
  initializeMetrics() {
    // Pool metrics
    this.metrics.poolHashrate = new Gauge({
      name: METRIC_TYPES.POOL_HASHRATE,
      help: 'Current pool hashrate in hashes per second',
      labelNames: ['algorithm'],
      registers: [this.registry]
    });
    
    this.metrics.poolMiners = new Gauge({
      name: METRIC_TYPES.POOL_MINERS,
      help: 'Total number of connected miners',
      registers: [this.registry]
    });
    
    this.metrics.poolWorkers = new Gauge({
      name: METRIC_TYPES.POOL_WORKERS,
      help: 'Total number of active workers',
      labelNames: ['type'],
      registers: [this.registry]
    });
    
    this.metrics.poolDifficulty = new Gauge({
      name: METRIC_TYPES.POOL_DIFFICULTY,
      help: 'Current pool difficulty',
      labelNames: ['algorithm'],
      registers: [this.registry]
    });
    
    // Share metrics
    this.metrics.sharesSubmitted = new Counter({
      name: METRIC_TYPES.SHARES_SUBMITTED,
      help: 'Total number of shares submitted',
      labelNames: ['miner', 'worker'],
      registers: [this.registry]
    });
    
    this.metrics.sharesAccepted = new Counter({
      name: METRIC_TYPES.SHARES_ACCEPTED,
      help: 'Total number of shares accepted',
      labelNames: ['difficulty_range'],
      registers: [this.registry]
    });
    
    this.metrics.sharesRejected = new Counter({
      name: METRIC_TYPES.SHARES_REJECTED,
      help: 'Total number of shares rejected',
      labelNames: ['reason'],
      registers: [this.registry]
    });
    
    this.metrics.shareProcessingTime = new Histogram({
      name: METRIC_TYPES.SHARE_PROCESSING_TIME,
      help: 'Time taken to process shares',
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      registers: [this.registry]
    });
    
    // Block metrics
    this.metrics.blocksFound = new Counter({
      name: METRIC_TYPES.BLOCKS_FOUND,
      help: 'Total number of blocks found',
      labelNames: ['height', 'miner'],
      registers: [this.registry]
    });
    
    this.metrics.blockEffort = new Gauge({
      name: METRIC_TYPES.BLOCK_EFFORT,
      help: 'Current round effort percentage',
      registers: [this.registry]
    });
    
    this.metrics.blockReward = new Counter({
      name: METRIC_TYPES.BLOCK_REWARD,
      help: 'Total block rewards earned',
      labelNames: ['currency'],
      registers: [this.registry]
    });
    
    // Payment metrics
    this.metrics.paymentsSent = new Counter({
      name: METRIC_TYPES.PAYMENTS_SENT,
      help: 'Total number of payments sent',
      labelNames: ['currency', 'scheme'],
      registers: [this.registry]
    });
    
    this.metrics.paymentAmount = new Counter({
      name: METRIC_TYPES.PAYMENT_AMOUNT,
      help: 'Total amount paid out',
      labelNames: ['currency'],
      registers: [this.registry]
    });
    
    this.metrics.paymentPending = new Gauge({
      name: METRIC_TYPES.PAYMENT_PENDING,
      help: 'Number of pending payments',
      registers: [this.registry]
    });
    
    this.metrics.paymentFailed = new Counter({
      name: METRIC_TYPES.PAYMENT_FAILED,
      help: 'Total number of failed payments',
      labelNames: ['reason'],
      registers: [this.registry]
    });
    
    // Connection metrics
    this.metrics.connectionsActive = new Gauge({
      name: METRIC_TYPES.CONNECTIONS_ACTIVE,
      help: 'Number of active connections',
      labelNames: ['type'],
      registers: [this.registry]
    });
    
    this.metrics.connectionsTotal = new Counter({
      name: METRIC_TYPES.CONNECTIONS_TOTAL,
      help: 'Total number of connections',
      labelNames: ['type'],
      registers: [this.registry]
    });
    
    this.metrics.connectionDuration = new Summary({
      name: METRIC_TYPES.CONNECTION_DURATION,
      help: 'Connection duration in seconds',
      percentiles: [0.5, 0.9, 0.99],
      registers: [this.registry]
    });
    
    // Performance metrics
    this.metrics.cpuUsage = new Gauge({
      name: METRIC_TYPES.CPU_USAGE,
      help: 'CPU usage percentage',
      labelNames: ['core'],
      registers: [this.registry]
    });
    
    this.metrics.memoryUsage = new Gauge({
      name: METRIC_TYPES.MEMORY_USAGE,
      help: 'Memory usage in bytes',
      labelNames: ['type'],
      registers: [this.registry]
    });
    
    this.metrics.workerThreads = new Gauge({
      name: METRIC_TYPES.WORKER_THREADS,
      help: 'Number of active worker threads',
      registers: [this.registry]
    });
    
    // Network metrics
    this.metrics.networkLatency = new Summary({
      name: METRIC_TYPES.NETWORK_LATENCY,
      help: 'Network latency in milliseconds',
      percentiles: [0.5, 0.9, 0.99],
      labelNames: ['peer'],
      registers: [this.registry]
    });
    
    this.metrics.stratumMessages = new Counter({
      name: METRIC_TYPES.STRATUM_MESSAGES,
      help: 'Total Stratum messages',
      labelNames: ['type', 'direction'],
      registers: [this.registry]
    });
    
    this.metrics.p2pPeers = new Gauge({
      name: METRIC_TYPES.P2P_PEERS,
      help: 'Number of connected P2P peers',
      registers: [this.registry]
    });
    
    // Security metrics
    this.metrics.authAttempts = new Counter({
      name: METRIC_TYPES.AUTH_ATTEMPTS,
      help: 'Total authentication attempts',
      labelNames: ['method'],
      registers: [this.registry]
    });
    
    this.metrics.authFailures = new Counter({
      name: METRIC_TYPES.AUTH_FAILURES,
      help: 'Total authentication failures',
      labelNames: ['reason'],
      registers: [this.registry]
    });
    
    this.metrics.ddosBlocked = new Counter({
      name: METRIC_TYPES.DDOS_BLOCKED,
      help: 'Total DDoS attempts blocked',
      labelNames: ['type'],
      registers: [this.registry]
    });
    
    // Cache metrics
    this.metrics.cacheHits = new Counter({
      name: METRIC_TYPES.CACHE_HITS,
      help: 'Total cache hits',
      labelNames: ['cache'],
      registers: [this.registry]
    });
    
    this.metrics.cacheMisses = new Counter({
      name: METRIC_TYPES.CACHE_MISSES,
      help: 'Total cache misses',
      labelNames: ['cache'],
      registers: [this.registry]
    });
    
    this.metrics.cacheSize = new Gauge({
      name: METRIC_TYPES.CACHE_SIZE,
      help: 'Cache size in bytes',
      labelNames: ['cache'],
      registers: [this.registry]
    });
    
    // Collect default Node.js metrics
    if (this.config.collectDefaultMetrics) {
      const collectDefaultMetrics = this.registry.constructor.collectDefaultMetrics;
      collectDefaultMetrics({ register: this.registry });
    }
  }
  
  /**
   * Start metrics server
   */
  async start() {
    if (this.running) return;
    
    this.server = createServer((req, res) => {
      if (req.url === this.config.path) {
        this.handleMetricsRequest(req, res);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    
    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, this.config.host, () => {
        this.running = true;
        this.logger.info('Prometheus exporter started', {
          port: this.config.port,
          host: this.config.host,
          endpoint: `http://${this.config.host}:${this.config.port}${this.config.path}`
        });
        resolve();
      });
      
      this.server.on('error', reject);
    });
  }
  
  /**
   * Stop metrics server
   */
  async stop() {
    if (!this.running) return;
    
    return new Promise((resolve) => {
      this.server.close(() => {
        this.running = false;
        this.logger.info('Prometheus exporter stopped');
        resolve();
      });
    });
  }
  
  /**
   * Handle metrics request
   */
  async handleMetricsRequest(req, res) {
    try {
      // Update dynamic metrics before serving
      await this.updateDynamicMetrics();
      
      // Get metrics
      const metrics = await this.registry.metrics();
      
      res.writeHead(200, { 'Content-Type': this.registry.contentType });
      res.end(metrics);
      
    } catch (error) {
      this.logger.error('Error serving metrics:', error);
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  }
  
  /**
   * Register component for metric collection
   */
  registerComponent(name, component) {
    this.components.set(name, component);
    
    // Setup event listeners based on component type
    switch (name) {
      case 'pool':
        this.setupPoolListeners(component);
        break;
        
      case 'paymentProcessor':
        this.setupPaymentListeners(component);
        break;
        
      case 'shareCache':
        this.setupCacheListeners(component);
        break;
        
      case 'ddosProtection':
        this.setupSecurityListeners(component);
        break;
    }
    
    this.logger.info(`Registered component for metrics: ${name}`);
  }
  
  /**
   * Setup pool event listeners
   */
  setupPoolListeners(pool) {
    // Miner events
    pool.on('miner:connected', () => {
      this.metrics.connectionsTotal.inc({ type: 'miner' });
    });
    
    pool.on('miner:disconnected', ({ duration }) => {
      if (duration) {
        this.metrics.connectionDuration.observe(duration / 1000);
      }
    });
    
    // Share events
    pool.on('share:accepted', ({ difficulty }) => {
      this.metrics.sharesAccepted.inc({ 
        difficulty_range: this.getDifficultyRange(difficulty) 
      });
    });
    
    pool.on('share:rejected', ({ reason }) => {
      this.metrics.sharesRejected.inc({ reason });
    });
    
    // Block events
    pool.on('block:found', ({ height, minerId, reward }) => {
      this.metrics.blocksFound.inc({ height: height.toString(), miner: minerId });
      this.metrics.blockReward.inc({ currency: 'BTC' }, reward);
    });
  }
  
  /**
   * Setup payment event listeners
   */
  setupPaymentListeners(paymentProcessor) {
    paymentProcessor.on('payment:sent', ({ amount }) => {
      this.metrics.paymentsSent.inc({ 
        currency: 'BTC', 
        scheme: paymentProcessor.config.scheme 
      });
      this.metrics.paymentAmount.inc({ currency: 'BTC' }, amount);
    });
    
    paymentProcessor.on('payment:failed', ({ reason }) => {
      this.metrics.paymentFailed.inc({ reason });
    });
  }
  
  /**
   * Setup cache event listeners
   */
  setupCacheListeners(cache) {
    cache.on('cache:hit', ({ cache: cacheName }) => {
      this.metrics.cacheHits.inc({ cache: cacheName });
    });
    
    cache.on('cache:miss', ({ cache: cacheName }) => {
      this.metrics.cacheMisses.inc({ cache: cacheName });
    });
  }
  
  /**
   * Setup security event listeners
   */
  setupSecurityListeners(ddosProtection) {
    ddosProtection.on('auth:attempt', ({ method }) => {
      this.metrics.authAttempts.inc({ method });
    });
    
    ddosProtection.on('auth:failure', ({ reason }) => {
      this.metrics.authFailures.inc({ reason });
    });
    
    ddosProtection.on('ddos:blocked', ({ type }) => {
      this.metrics.ddosBlocked.inc({ type });
    });
  }
  
  /**
   * Update dynamic metrics
   */
  async updateDynamicMetrics() {
    // Update pool metrics
    const pool = this.components.get('pool');
    if (pool) {
      const stats = pool.getStats();
      this.metrics.poolHashrate.set({ algorithm: pool.config.algorithm }, stats.hashrate);
      this.metrics.poolMiners.set(stats.minerCount);
      this.metrics.poolDifficulty.set({ algorithm: pool.config.algorithm }, pool.config.difficulty);
    }
    
    // Update payment metrics
    const paymentProcessor = this.components.get('paymentProcessor');
    if (paymentProcessor) {
      const stats = paymentProcessor.getStats();
      this.metrics.paymentPending.set(stats.pendingPayments);
    }
    
    // Update performance metrics
    const usage = process.cpuUsage();
    const cpuPercent = (usage.user + usage.system) / 1000000 * 100;
    this.metrics.cpuUsage.set({ core: 'total' }, cpuPercent);
    
    const memUsage = process.memoryUsage();
    this.metrics.memoryUsage.set({ type: 'rss' }, memUsage.rss);
    this.metrics.memoryUsage.set({ type: 'heap' }, memUsage.heapUsed);
    
    // Update connection metrics
    const connectionPool = this.components.get('connectionPool');
    if (connectionPool) {
      this.metrics.connectionsActive.set({ type: 'stratum' }, connectionPool.activeConnections);
    }
    
    // Update cache metrics
    const shareCache = this.components.get('shareCache');
    if (shareCache) {
      const stats = shareCache.getStats();
      this.metrics.cacheSize.set({ cache: 'shares' }, stats.shares.size);
    }
  }
  
  /**
   * Get difficulty range label
   */
  getDifficultyRange(difficulty) {
    if (difficulty < 1000) return '0-1k';
    if (difficulty < 10000) return '1k-10k';
    if (difficulty < 100000) return '10k-100k';
    if (difficulty < 1000000) return '100k-1M';
    return '1M+';
  }
  
  /**
   * Custom metric methods
   */
  
  recordShareProcessing(duration) {
    this.metrics.shareProcessingTime.observe(duration);
  }
  
  recordNetworkLatency(peer, latency) {
    this.metrics.networkLatency.observe({ peer }, latency);
  }
  
  incrementStratumMessage(type, direction) {
    this.metrics.stratumMessages.inc({ type, direction });
  }
  
  updateWorkerThreads(count) {
    this.metrics.workerThreads.set(count);
  }
  
  updateP2PPeers(count) {
    this.metrics.p2pPeers.set(count);
  }
  
  updateBlockEffort(effort) {
    this.metrics.blockEffort.set(effort);
  }
  
  /**
   * Get metrics snapshot
   */
  async getMetricsSnapshot() {
    await this.updateDynamicMetrics();
    return await this.registry.getMetricsAsJSON();
  }
}

export default PrometheusExporter;