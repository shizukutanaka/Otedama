#!/usr/bin/env node

/**
 * Otedama - Enterprise-Grade P2P Mining Pool, DEX & DeFi Platform
 * 
 * Design Philosophy (Carmack/Martin/Pike):
 * - Direct and simple implementation
 * - No unnecessary abstractions
 * - Performance-first approach
 * - Clear error handling
 * - Minimal dependencies
 */

import { createServer } from 'http';
import { cpus, freemem, totalmem } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { lazyLoad, preloadCritical } from './lib/lazy-loader.js';
import { initializeErrorHandler, getErrorHandler, OtedamaError, ErrorCategory, safeExecute } from './lib/error-handler.js';
import { getErrorHandler as getStandardizedErrorHandler } from './lib/core/standardized-error-handler.js';
import { getPerformanceMonitor } from './lib/performance/monitor.js';
import { UnifiedSecurityMiddleware } from './lib/security/unified-security-middleware.js';
import { DatabaseManager } from './lib/core/database-manager.js';
import { AdvancedRateLimiter } from './lib/security/rate-limiter.js';
import { getLogger } from './lib/core/logger.js';
import { getMonitoring, inc, set, observe, time, recordHttpRequest, recordDbQuery, httpMiddleware, metricsEndpoint } from './lib/monitoring/index.js';
import { P2PController } from './lib/p2p/p2p-controller.js';
import { setupRealtimeServers } from './lib/websocket/index.js';
import { AuthenticationManager } from './lib/auth/authentication-manager.js';
import { createAuthRoutes } from './lib/auth/middleware.js';
import { ConfigValidator } from './lib/config/config-validator.js';
import { HealthCheck } from './lib/health/health-check.js';
import { MultiLayerCache, CacheStrategy, cacheMiddleware } from './lib/cache/index.js';
import { MemoryProfiler } from './lib/performance/memory-profiler.js';
import { BufferPool, ObjectPool } from './lib/performance/object-pool.js';
import express from 'express';
import { randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import { i18nMiddleware, apiI18nMiddleware, languageRoutes } from './lib/i18n/middleware.js';
import { AdminDashboardServer } from './lib/dashboard/admin-server.js';
import { UserWebServer } from './lib/web/user-server.js';

// Load environment variables
dotenv.config();

// ===== CORE CONSTANTS =====
const VERSION = 'Otedama'; // No version numbering as requested
const __dirname = dirname(fileURLToPath(import.meta.url));
const STARTUP_TIME = Date.now();

// Configuration with sensible defaults
const config = {
  // Network
  apiPort: parseInt(process.env.API_PORT) || 8080,
  wsPort: parseInt(process.env.WS_PORT) || 8081,
  dexWsPort: parseInt(process.env.DEX_WS_PORT) || 8082,
  p2pPort: parseInt(process.env.P2P_PORT) || 8333,
  p2pDiscoveryPort: parseInt(process.env.P2P_DISCOVERY_PORT) || 8334,
  
  // Database
  dbPath: process.env.DB_PATH || './otedama.db',
  dbReadPoolSize: parseInt(process.env.DB_READ_POOL_SIZE) || 5,
  dbWritePoolSize: parseInt(process.env.DB_WRITE_POOL_SIZE) || 2,
  
  // System
  logLevel: process.env.LOG_LEVEL || 'info',
  environment: process.env.NODE_ENV || 'production',
  maxWorkers: parseInt(process.env.MAX_WORKERS) || cpus().length,
  
  // Security
  corsOrigin: process.env.CORS_ORIGIN || '*',
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) || 60000,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX) || 100
  },
  
  // Performance
  cacheMaxSize: parseInt(process.env.CACHE_MAX_SIZE) || 100 * 1024 * 1024, // 100MB
  gcInterval: parseInt(process.env.GC_INTERVAL) || 1800000, // 30 minutes
  
  // Performance Optimization
  performance: {
    enableQueryCache: process.env.ENABLE_QUERY_CACHE !== 'false',
    enableMultiLayerCache: process.env.ENABLE_MULTI_LAYER_CACHE !== 'false',
    enableMemoryProfiler: process.env.ENABLE_MEMORY_PROFILER === 'true',
    enableObjectPools: process.env.ENABLE_OBJECT_POOLS !== 'false',
    enableCPUAffinity: process.env.ENABLE_CPU_AFFINITY !== 'false',
    reserveManagementCore: process.env.RESERVE_MANAGEMENT_CORE !== 'false',
    coreAllocation: process.env.CORE_ALLOCATION || 'balanced', // balanced, dedicated, numa-aware, cache-aware
    priorityBoost: process.env.PRIORITY_BOOST !== 'false',
    redis: {
      enabled: process.env.REDIS_ENABLED === 'true',
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD
    },
    metrics: {
      enabled: process.env.ENABLE_PROMETHEUS_METRICS !== 'false',
      port: parseInt(process.env.METRICS_PORT) || 9090,
      path: process.env.METRICS_PATH || '/metrics'
    }
  }
};

// ===== OPTIMIZED STARTUP =====
class OtedamaCore {
  constructor() {
    this.startTime = Date.now();
    this.logger = console; // Simple logger for now
    this.db = null;
    this.server = null;
    this.services = new Map();
    this.modules = new Map();
    this.performanceMonitor = null;
    this.dbOptimizer = null;
    this.p2pController = null;
    this.realtimeServers = null;
    this.authManager = null;
    this.monitoringManager = null;
    this.alertManager = null;
    this.healthCheck = null;
    
    // Initialize error handler early
    initializeErrorHandler({ logger: this.logger });
  }

  /**
   * Initialize core components with lazy loading
   */
  async initialize() {
    console.log(`Starting Otedama v${VERSION}...`);
    
    try {
      // Validate configuration first
      const validator = new ConfigValidator();
      const validation = validator.validate(process.env);
      
      if (!validation.valid) {
        console.error('Configuration validation failed:');
        validator.printReport();
        process.exit(1);
      }
      
      if (validation.warnings.length > 0) {
        validator.printReport();
      }
      
      // Update config with validated values
      Object.assign(config, validation.config);
      // Initialize error handler first
      this.errorHandler = initializeErrorHandler({
        logLevel: config.logLevel,
        maxRetries: 3,
        retryDelay: 1000
      });
      
      // Setup error event listeners
      this.errorHandler.on('unrecoverable', (error) => {
        console.error('Unrecoverable error:', error);
        this.shutdown();
      });
      
      this.errorHandler.on('admin-notification', (error) => {
        console.error('Admin notification required:', error);
      });
      
      // 1. Initialize database with basic schema (simplified approach)
      try {
        console.log('=== Initializing Database Schema ===');
        
        // Create basic database connection for schema initialization
        const tempDb = new Database(config.dbPath);
        
        // Create enterprise-grade schema with proper indexing
        tempDb.exec(`
          -- Users table with enhanced security
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL COLLATE NOCASE,
            email TEXT UNIQUE NOT NULL COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            btc_address TEXT UNIQUE,
            api_key TEXT UNIQUE,
            api_secret_hash TEXT,
            role TEXT DEFAULT 'user' CHECK(role IN ('user', 'admin', 'operator')),
            status TEXT DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'banned')),
            two_factor_enabled BOOLEAN DEFAULT 0,
            two_factor_secret TEXT,
            last_login DATETIME,
            failed_login_attempts INTEGER DEFAULT 0,
            locked_until DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          
          -- Mining sessions with performance tracking
          CREATE TABLE IF NOT EXISTS mining_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            worker_name TEXT NOT NULL,
            algorithm TEXT NOT NULL,
            start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            end_time DATETIME,
            hashrate REAL DEFAULT 0,
            average_hashrate REAL DEFAULT 0,
            shares_submitted INTEGER DEFAULT 0,
            shares_accepted INTEGER DEFAULT 0,
            shares_rejected INTEGER DEFAULT 0,
            shares_stale INTEGER DEFAULT 0,
            difficulty REAL DEFAULT 1,
            earnings REAL DEFAULT 0,
            pool_fee REAL DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
          
          -- Transactions with audit trail
          CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('deposit', 'withdrawal', 'trade', 'fee', 'reward', 'refund')),
            amount TEXT NOT NULL, -- Store as string for precision
            currency TEXT NOT NULL,
            btc_value TEXT, -- BTC equivalent at time of transaction
            fee TEXT DEFAULT '0',
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
            tx_hash TEXT UNIQUE,
            block_height INTEGER,
            confirmations INTEGER DEFAULT 0,
            metadata TEXT, -- JSON metadata
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
          
          -- Orders for DEX
          CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            pair TEXT NOT NULL,
            side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
            type TEXT NOT NULL CHECK(type IN ('market', 'limit', 'stop', 'stop_limit')),
            price TEXT,
            amount TEXT NOT NULL,
            filled TEXT DEFAULT '0',
            fee TEXT DEFAULT '0',
            status TEXT DEFAULT 'open' CHECK(status IN ('open', 'partial', 'filled', 'cancelled', 'expired')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
          
          -- Liquidity pools for DeFi
          CREATE TABLE IF NOT EXISTS liquidity_pools (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pair TEXT UNIQUE NOT NULL,
            token0 TEXT NOT NULL,
            token1 TEXT NOT NULL,
            reserve0 TEXT NOT NULL DEFAULT '0',
            reserve1 TEXT NOT NULL DEFAULT '0',
            total_supply TEXT NOT NULL DEFAULT '0',
            fee_rate REAL DEFAULT 0.003, -- 0.3%
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          
          -- Audit log for compliance
          CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT NOT NULL,
            resource TEXT NOT NULL,
            resource_id TEXT,
            ip_address TEXT,
            user_agent TEXT,
            metadata TEXT, -- JSON metadata
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
          );
          
          -- System metrics for monitoring
          CREATE TABLE IF NOT EXISTS system_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            metric_name TEXT NOT NULL,
            metric_value REAL NOT NULL,
            tags TEXT, -- JSON tags
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          
          -- Create indexes for performance
          CREATE INDEX IF NOT EXISTS idx_users_btc_address ON users(btc_address);
          CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key);
          CREATE INDEX IF NOT EXISTS idx_mining_sessions_user_time ON mining_sessions(user_id, start_time);
          CREATE INDEX IF NOT EXISTS idx_transactions_user_status ON transactions(user_id, status);
          CREATE INDEX IF NOT EXISTS idx_transactions_tx_hash ON transactions(tx_hash);
          CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status);
          CREATE INDEX IF NOT EXISTS idx_orders_pair_status ON orders(pair, status);
          CREATE INDEX IF NOT EXISTS idx_audit_log_user_time ON audit_log(user_id, created_at);
          CREATE INDEX IF NOT EXISTS idx_system_metrics_name_time ON system_metrics(metric_name, created_at);
        `);
        
        tempDb.close();
        console.log('✅ Database schema initialized successfully');
      } catch (error) {
        console.error('❌ Database schema initialization failed:', error.message);
        throw error;
      }

      // 2. Initialize enhanced database with connection pooling
      try {
        console.log('=== Initializing Database ===');
        // Create unified database manager with connection pooling and performance features
        this.dbManager = new DatabaseManager(config.dbPath, {
          poolSize: parseInt(process.env.DB_READ_POOL_SIZE) || 5,
          maxConnections: parseInt(process.env.DB_WRITE_POOL_SIZE) || 10,
          enableBackup: true,
          enableIntegrityCheck: true,
          enableBatching: true,
          backupDir: resolve(dirname(config.dbPath), 'backups'),
          // Performance optimizations
          enableQueryOptimizer: config.performance.enableQueryCache,
          enableQueryCache: config.performance.enableQueryCache,
          queryCacheSize: 1000,
          queryCacheTTL: 300000 // 5 minutes
        });
        
        // Initialize the database manager
        await this.dbManager.initialize();
        
        // Keep backward compatibility - expose simple query interface
        this.db = {
          prepare: (sql) => ({
            run: (...params) => this.dbManager.run(sql, params),
            get: (...params) => this.dbManager.get(sql, params),
            all: (...params) => this.dbManager.all(sql, params)
          }),
          exec: (sql) => this.dbManager.query(sql),
          close: () => this.dbManager.shutdown()
        };
        
        // Also expose dbOptimizer for compatibility
        this.dbOptimizer = this.dbManager;
        
        // Setup database event listeners
        this.dbManager.on('integrity:issues', (results) => {
          console.error('Database integrity issues detected:', results);
        });
        
        this.dbManager.on('integrity:repair', (results) => {
          console.log('Database repair completed:', results);
        });
        
        this.dbManager.on('backup:created', (event) => {
          console.log('Database backup created:', event.path);
        });
        
        console.log('✅ Database initialized successfully');
      
      // Initialize authentication and monitoring systems in parallel for better performance
      const [authManager, monitoringManager] = await Promise.all([
        (async () => {
          const auth = new AuthenticationManager(this.dbManager, {
            jwtSecret: process.env.JWT_SECRET || 'otedama-secret-' + Date.now(),
            twoFactorIssuer: 'Otedama'
          });
          await auth.initializeDatabase();
          return auth;
        })(),
        (async () => {
          const monitoring = getMonitoring({
            systemInterval: 5000,
            applicationInterval: 10000,
            enableAlerts: true,
            enableRealtime: true
          });
          await monitoring.initialize();
          return monitoring;
        })()
      ]);
      
      this.authManager = authManager;
      this.monitoringManager = monitoringManager;
      this.services.set('auth', this.authManager);
      this.services.set('monitoring', this.monitoringManager);
      console.log('✅ Authentication and monitoring systems initialized (parallel)');
      
      // Alert manager is now part of the consolidated monitoring
      this.alertManager = this.monitoringManager; // For backward compatibility
      /*
      const alertConfig = {
        enableRealTimeProcessing: true,
        maxEventsPerSecond: 500,
        alertSystemConfig: {
          enableSlack: process.env.SLACK_WEBHOOK_URL ? true : false,
          enableEmail: process.env.SMTP_HOST ? true : false,
          enableWebhook: process.env.ALERT_WEBHOOK_URL ? true : false
        }
      });
      await this.alertManager.start();
      this.services.set('alertManager', this.alertManager);
      console.log('✅ Real-time alert system initialized');
      
      // Initialize real-time analytics dashboard
      const { RealTimeAnalyticsDashboard } = await import('./lib/analytics/realtime-dashboard.js');
      this.analyticsDashboard = new RealTimeAnalyticsDashboard({
        updateInterval: 1000,
        wsPort: 8090,
        metricsRetention: 24 * 60 * 60 * 1000 // 24 hours
      };
      */
      // Alert functionality is now integrated into monitoring
      await this.analyticsDashboard.start();
      this.services.set('analyticsDashboard', this.analyticsDashboard);
      console.log('✅ Real-time analytics dashboard initialized');
      
      // Initialize data persistence
      try {
        console.log('Initializing data persistence...');
        this.persistenceManager = new DataPersistenceManager({
          dbPath: './data/persistence.db',
          backupPath: './data/backups',
          enableEncryption: config.environment === 'production',
          encryptionKey: process.env.PERSISTENCE_KEY || randomBytes(32).toString('hex'),
          autoSaveInterval: 5000,
          snapshotInterval: 300000,
          backupInterval: 3600000
        });
        
        await this.persistenceManager.initialize();
        this.services.set('persistenceManager', this.persistenceManager);
        
        // Setup persistence event handlers
        this.persistenceManager.on('data:saved', (event) => {
          this.logger.debug(`Data saved: ${event.userId}:${event.dataType}`);
        });
        
        this.persistenceManager.on('snapshot:created', (event) => {
          this.logger.info(`Snapshot created: ${event.size} bytes`);
        });
        
        this.persistenceManager.on('session:resumed', (event) => {
          this.logger.info(`Session resumed: ${event.sessionId}`);
        });
        
        console.log('✅ Data persistence initialized');
      } catch (error) {
        this.logger.warn('Data persistence initialization failed:', error);
        // Continue without persistence - data will be stored in memory only
      }
      
      } catch (error) {
        console.error('❌ Database initialization failed:', error.message);
        throw error;
      }
      
      // 2. Create HTTP server (critical)
      this.server = createServer((req, res) => this.handleRequest(req, res));
      
      // 3. Initialize independent services in parallel (Phase 2)
      console.log('🔄 Initializing core services in parallel...');
      await Promise.all([
        this.initializeP2P(),
        this.setupCoreServices(),
        this.setupPerformanceFeatures()
      ]);
      
      // 6. Initialize dashboard system (lazy)
      setTimeout(() => this.setupDashboard(), 2000);
      
      const startupTime = Date.now() - this.startTime;
      console.log(`Core initialized in ${startupTime}ms`);
      
    } catch (error) {
      console.error('Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Initialize P2P Controller with enhanced error recovery
   */
  async initializeP2P() {
    try {
      this.p2pController = new P2PController({
        environment: config.environment,
        node: {
          port: config.p2pPort,
          discoveryPort: config.p2pDiscoveryPort,
          // Enterprise-grade settings
          maxPeers: 1000,
          connectionTimeout: 30000,
          pingInterval: 30000,
          reconnectInterval: 5000
        },
        security: {
          encryptMessages: true,
          validatePeers: true,
          maxMessageSize: 10 * 1024 * 1024 // 10MB
        }
      });
      
      // Wait for P2P initialization with timeout
      await Promise.race([
        new Promise((resolve) => this.p2pController.once('initialized', resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('P2P initialization timeout')), 30000))
      ]);
      
      // Monitor P2P health
      this.p2pController.on('peer:connected', (peer) => {
        this.logger.info(`P2P peer connected: ${peer.id}`);
      });
      
      this.p2pController.on('peer:disconnected', (peer) => {
        this.logger.warn(`P2P peer disconnected: ${peer.id}`);
      });
      
      this.p2pController.on('error', (error) => {
        this.errorHandler.handleError(error, {
          service: 'p2p',
          category: ErrorCategory.NETWORK
        });
      });
      
      this.logger.info('P2P Controller initialized successfully');
      this.services.set('p2p', this.p2pController);
    } catch (error) {
      this.logger.error('P2P initialization failed:', error);
      // P2P is critical for distributed operation, but we can run standalone
      if (config.environment === 'production') {
        this.logger.warn('Running in standalone mode without P2P');
      }
    }
  }
  
  /**
   * Setup performance features
   */
  async setupPerformanceFeatures() {
    try {
      // Initialize multi-layer cache
      if (config.performance.enableMultiLayerCache) {
        console.log('Initializing multi-layer cache...');
        this.multiLayerCache = new MultiLayerCache({
          enableL1: true,
          enableL2: config.performance.redis.enabled,
          l1: {
            maxSize: 1000,
            maxMemory: 100 * 1024 * 1024, // 100MB
            ttl: 300
          },
          l2: config.performance.redis
        });
        await this.multiLayerCache.initialize();
        this.services.set('multiLayerCache', this.multiLayerCache);
        
        // Apply cache strategy
        this.cacheStrategy = new CacheStrategy(this.multiLayerCache);
        this.services.set('cacheStrategy', this.cacheStrategy);
      }
      
      // Initialize memory profiler
      if (config.performance.enableMemoryProfiler) {
        console.log('Initializing memory profiler...');
        this.memoryProfiler = new MemoryProfiler({
          enableSnapshots: true,
          enableLeakDetection: true,
          enableAllocationTracking: true,
          leakDetectionInterval: 300000 // 5 minutes
        });
        this.memoryProfiler.start();
        this.services.set('memoryProfiler', this.memoryProfiler);
        
        // Listen for memory leak alerts
        this.memoryProfiler.on('leak:detected', (data) => {
          this.logger.warn('Memory leak detected:', data);
        });
      }
      
      // Initialize memory optimizer
      if (config.performance.enableMemoryOptimizer !== false) {
        const { MemoryOptimizer } = await lazyLoad('./lib/performance/memory-optimizer.js');
        console.log('Initializing memory optimizer...');
        
        this.memoryOptimizer = new MemoryOptimizer({
          maxHeapSize: config.performance.maxMemory || Math.floor(os.totalmem() * 0.75),
          targetHeapUsage: 0.7,
          enableAutoGC: config.performance.enableAutoGC !== false,
          enableHeapCompaction: config.performance.enableHeapCompaction !== false
        });
        
        // Hook into cache and buffer events
        this.memoryOptimizer.on('cache:clear', (data) => {
          if (this.cache) {
            this.cache.flushAll();
            this.logger.info('Cache cleared due to memory pressure');
          }
        });
        
        this.memoryOptimizer.on('cache:prune', (data) => {
          if (this.cache) {
            this.cache.prune();
          }
        });
        
        this.memoryOptimizer.on('buffer:optimize', (data) => {
          if (this.objectPools) {
            Object.values(this.objectPools).forEach(pool => {
              if (pool.clear) pool.clear();
            });
          }
        });
        
        this.memoryOptimizer.on('memory:critical', (data) => {
          this.logger.error('Critical memory pressure:', data);
          // Could trigger emergency measures here
        });
        
        this.memoryOptimizer.start();
        this.services.set('memoryOptimizer', this.memoryOptimizer);
      }
      
      // Initialize CPU affinity manager
      if (config.performance.enableCPUAffinity !== false) {
        const { CPUAffinityManager } = await lazyLoad('./lib/performance/cpu-affinity.js');
        console.log('Initializing CPU affinity manager...');
        
        this.cpuAffinityManager = new CPUAffinityManager({
          enableAffinity: true,
          reserveManagementCore: config.performance.reserveManagementCore !== false,
          coreAllocation: config.performance.coreAllocation || 'balanced',
          priorityBoost: config.performance.priorityBoost !== false
        });
        
        const initialized = await this.cpuAffinityManager.initialize();
        
        if (initialized) {
          // Register main process
          this.cpuAffinityManager.registerProcess(process.pid, 'master');
          
          // Get and log recommendations
          const recommendations = this.cpuAffinityManager.getRecommendations();
          if (recommendations.length > 0) {
            console.log('CPU affinity recommendations:');
            recommendations.forEach(rec => {
              console.log(`  - [${rec.impact}] ${rec.type}: ${rec.message}`);
            });
          }
          
          this.services.set('cpuAffinityManager', this.cpuAffinityManager);
        }
      }
      
      // Initialize object pools
      if (config.performance.enableObjectPools) {
        console.log('Initializing object pools...');
        this.objectPools = {
          buffer1K: new BufferPool(1024, { maxSize: 100 }),
          buffer4K: new BufferPool(4096, { maxSize: 50 }),
          buffer16K: new BufferPool(16384, { maxSize: 20 }),
          shareData: new ObjectPool({
            factory: () => ({ miner: null, difficulty: 0, timestamp: 0 }),
            reset: (obj) => {
              obj.miner = null;
              obj.difficulty = 0;
              obj.timestamp = 0;
            },
            maxSize: 1000
          })
        };
        this.services.set('objectPools', this.objectPools);
      }
      
      // Prometheus metrics are now integrated into consolidated monitoring
      if (config.performance.metrics.enabled) {
        console.log('Prometheus metrics enabled in consolidated monitoring');
        // Metrics collection is already part of the monitoring system
        this.metricsCollector = this.monitoringManager; // For backward compatibility
        this.services.set('metricsCollector', this.monitoringManager);
        
        // Start metrics server
        if (config.performance.metrics.port) {
          const metricsApp = express();
          metricsApp.get(config.performance.metrics.path, metricsEndpoint());
          
          const metricsServer = metricsApp.listen(config.performance.metrics.port, () => {
            console.log(`Prometheus metrics available at http://localhost:${config.performance.metrics.port}${config.performance.metrics.path}`);
          });
          
          this.services.set('metricsServer', metricsServer);
        }
      }
      
      console.log('✅ Performance features initialized');
    } catch (error) {
      this.logger.warn('Performance features initialization failed:', error);
      // Continue without performance features
    }
  }

  /**
   * Setup core services with enterprise features
   */
  async setupCoreServices() {
    // Initialize production logger
    this.logger = getLogger('Core', {
      level: config.logLevel,
      file: config.environment === 'production' ? {
        filename: 'otedama.log',
        dirname: './logs',
        maxSize: 100 * 1024 * 1024, // 100MB
        maxFiles: 10,
        compress: true
      } : undefined
    });
    this.services.set('logger', this.logger);
    
    // Initialize high-performance cache
    try {
      const { MemoryCache } = await lazyLoad('./lib/memory-cache.js');
      this.cache = new MemoryCache({ 
        maxSize: config.cacheMaxSize,
        ttl: 300000, // 5 minutes default TTL
        checkPeriod: 60000, // Clean expired entries every minute
        useClones: false // Better performance without cloning
      });
      this.services.set('cache', this.cache);
    } catch (error) {
      this.logger.warn('Cache system unavailable, continuing without caching');
      // Simple in-memory cache fallback
      this.cache = new Map();
      this.cache.get = (key) => this.cache.get(key)?.value;
      this.cache.set = (key, value, ttl) => {
        this.cache.set(key, { value, expires: Date.now() + (ttl || 300000) });
      };
    }
    
    // Performance monitor
    this.performanceMonitor = getPerformanceMonitor({
      sampleInterval: 1000,
      alertThresholds: {
        cpuUsage: 80,
        memoryUsage: 85,
        responseTime: 1000,
        errorRate: 5
      }
    });
    this.services.set('performanceMonitor', this.performanceMonitor);
    
    // Listen for performance alerts
    this.performanceMonitor.on('alert', (alert) => {
      this.logger.warn('Performance alert:', alert);
    });
    
    // Initialize advanced rate limiter
    this.rateLimiter = new AdvancedRateLimiter({
      strategy: 'token_bucket',
      global: {
        requests: 10000,
        window: 60000,
        burst: 200
      },
      perIP: {
        requests: config.rateLimit.maxRequests,
        window: config.rateLimit.windowMs,
        burst: 20
      },
      endpoints: {
        '/api/auth/login': { requests: 5, window: 300000, burst: 5 },
        '/api/auth/register': { requests: 3, window: 3600000, burst: 3 },
        '/api/mining/submit': { requests: 100, window: 1000, burst: 50 },
        '/api/dex/order': { requests: 10, window: 1000, burst: 5 },
        '/api/prices': { requests: 60, window: 60000, burst: 10 }
      },
      penalties: {
        enabled: true,
        threshold: 0.8,
        multiplier: 2,
        duration: 300000
      }
    });
    this.services.set('rateLimiter', this.rateLimiter);
    
    // Listen for rate limit events
    this.rateLimiter.on('limited', (event) => {
      this.logger.warn('Rate limit exceeded', event);
      inc('rate_limit_exceeded_total', { type: event.type });
    });
    
    this.rateLimiter.on('violation', (event) => {
      this.logger.error('Rate limit violation', event);
      inc('rate_limit_violations_total', {});
    });
    
    // Unified security middleware with enhanced features
    this.securityMiddleware = new UnifiedSecurityMiddleware(this.dbManager, {
      // Enable all security features
      enableSessions: true,
      enableAPIKeys: true,
      enableCSRF: true,
      enableRateLimiting: false, // Using separate advanced rate limiter
      enableDDoSProtection: true,
      enableSecurityHeaders: true,
      useEnhancedHeaders: true, // Use enhanced security headers instead of basic Helmet
      
      // Session configuration
      session: {
        sessionTimeout: parseInt(process.env.SESSION_TIMEOUT) || 3600000,
        maxSessions: parseInt(process.env.MAX_SESSIONS_PER_USER) || 5,
        redis: config.performance.redis
      },
      
      // API Key configuration
      apiKey: {
        rotationEnabled: true,
        maxKeyAge: 7776000000 // 90 days
      },
      
      // CSRF configuration
      csrf: {
        strategy: 'double-submit',
        secret: process.env.CSRF_SECRET || randomBytes(32).toString('hex'),
        excludePaths: ['/api/webhook', '/api/public', '/health', '/metrics']
      },
      
      // Enhanced security headers configuration
      enhancedHeaders: {
        environment: config.environment,
        apiVersion: '1.0',
        allowedOrigins: [
          'https://otedama.io',
          'https://www.otedama.io',
          process.env.ALLOWED_ORIGIN
        ].filter(Boolean),
        reportUri: '/api/security/csp-report',
        domainName: process.env.DOMAIN_NAME || 'otedama.io',
        features: {
          cspNonce: true,
          crossOriginIsolation: config.environment === 'production',
          permissionsPolicy: true,
          apiHeaders: true,
          strictCsp: config.environment === 'production'
        }
      },
      
      // Fallback security headers (Helmet) - used when enhanced headers disabled
      helmet: {
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "wss:", "ws:", "https:"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"]
          }
        },
        hsts: {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: true
        }
      },
      
      // DDoS protection
      ddos: {
        maxRequestsPerIP: 1000,
        banDuration: 3600000 // 1 hour
      },
      
      // Request validation
      maxBodySize: '10mb',
      maxUrlLength: 2048,
      
      // Redis connection (shared with cache)
      redis: config.performance.redis
    });
    this.services.set('securityMiddleware', this.securityMiddleware);
    
    // Add CSP violation reporting endpoint
    app.post('/api/security/csp-report', express.json({ type: 'application/csp-report' }), (req, res) => {
      const report = req.body;
      this.logger.warn('CSP Violation Report:', {
        'blocked-uri': report['blocked-uri'],
        'document-uri': report['document-uri'],
        'violated-directive': report['violated-directive'],
        'original-policy': report['original-policy'],
        timestamp: new Date().toISOString()
      });
      
      // Log to audit trail
      try {
        this.dbManager.db.prepare(`
          INSERT INTO audit_log (
            user_id, action, resource, resource_id, 
            ip_address, user_agent, metadata, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
          null, // user_id - CSP violations may not have authenticated user
          'csp_violation',
          'security_policy',
          report['violated-directive'],
          req.ip || req.connection.remoteAddress,
          req.headers['user-agent'],
          JSON.stringify(report)
        );
      } catch (error) {
        this.logger.error('Failed to log CSP violation to audit trail:', error);
      }
      
      res.status(204).send(); // No content response for CSP reports
    });
    
    // Setup security event listeners  
    this.securityMiddleware.on('security:event', (event) => {
      this.logger.info('Security event:', event);
      
      // Record security metrics
      if (this.metricsCollector) {
        this.metricsCollector.recordSecurityEvent(event);
      }
    });
    
    // Initialize worker pool for CPU-intensive tasks
    try {
      const { WorkerPool } = await lazyLoad('./lib/worker-pool.js');
      this.workerPool = new WorkerPool({
        maxWorkers: config.maxWorkers,
        taskTimeout: 30000,
        recycleAfter: 100 // Recycle workers after 100 tasks
      });
      this.services.set('workerPool', this.workerPool);
    } catch (error) {
      this.logger.warn('Worker pool unavailable, CPU-intensive tasks will run on main thread');
    }
  }

  /**
   * Handle HTTP requests with lazy module loading
   */
  async handleRequest(req, res) {
    const timingId = this.performanceMonitor?.startTiming('request');
    
    // Debug logging
    console.log(`[DEBUG] Incoming request: ${req.method} ${req.url}`);
    
    try {
      // Apply i18n middleware based on path
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;
      
      // Apply i18n middleware
      if (path.startsWith('/api/')) {
        await new Promise((resolve, reject) => {
          apiI18nMiddleware(req, res, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } else {
        await new Promise((resolve, reject) => {
          i18nMiddleware(req, res, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
      
      // Apply unified security middleware
      if (this.securityMiddleware) {
        // The unified middleware handles everything in one pass
        const securityMiddleware = this.securityMiddleware.middleware();
        
        await new Promise((resolve, reject) => {
          securityMiddleware(req, res, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        }).catch((error) => {
          this.logger.error('Security middleware error:', error);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: 'Security check failed' }));
          }
          this.performanceMonitor?.endTiming(timingId, false);
          return;
        });
        
        // Check if request was blocked
        if (res.headersSent) {
          this.performanceMonitor?.endTiming(timingId, false);
          return;
        }
      }
      
      // Apply advanced rate limiting (separate from unified middleware)
      if (this.rateLimiter) {
        const rateLimitContext = {
          req,
          ip: req.security?.ip || req.socket.remoteAddress,
          endpoint: req.url.split('?')[0],
          userId: req.userId || req.user?.id,
          apiKey: req.apiKey?.id || req.headers['x-api-key']
        };
        
        const rateLimitResult = await this.rateLimiter.checkLimit(rateLimitContext);
        
        if (rateLimitResult.headers) {
          this.rateLimiter.applyHeaders(res, rateLimitResult.headers);
        }
        
        if (!rateLimitResult.allowed) {
          if (this.metricsCollector) {
            this.metricsCollector.recordSecurityEvent({
              event: 'rate_limited',
              data: rateLimitContext
            });
          }
          
          res.statusCode = 429;
          res.end(JSON.stringify({
            error: 'Too Many Requests',
            message: rateLimitResult.reason,
            retryAfter: rateLimitResult.retryAfter
          }));
          this.performanceMonitor?.endTiming(timingId, false);
          return;
        }
      }
      
      res.setHeader('Content-Type', 'application/json');
      
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;
      
      // Apply cache middleware for GET requests on API endpoints
      if (req.method === 'GET' && path.startsWith('/api/') && this.cacheStrategy) {
        const cacheKey = `http:${path}:${url.search}`;
        const cached = await this.multiLayerCache.get(cacheKey);
        
        if (cached) {
          res.setHeader('X-Cache', 'HIT');
          res.end(JSON.stringify(cached));
          
          // Record cache hit metric
          if (this.metricsCollector) {
            this.metricsCollector.recordCacheOperation('http', 'hit');
          }
          
          this.performanceMonitor?.endTiming(timingId, true);
          return;
        }
        
        // Store original end method to intercept response
        const originalEnd = res.end;
        res.end = (data) => {
          if (res.statusCode === 200 && data) {
            // Cache successful responses
            try {
              const parsed = JSON.parse(data);
              this.multiLayerCache.set(cacheKey, parsed, { ttl: 60 }); // 1 minute TTL
              res.setHeader('X-Cache', 'MISS');
              
              // Record cache miss metric
              if (this.metricsCollector) {
                this.metricsCollector.recordCacheOperation('http', 'miss');
              }
            } catch (e) {
              // Not JSON, don't cache
            }
          }
          originalEnd.call(res, data);
        };
      }
      
      // Route to appropriate handler
      if (path === '/health') {
        res.end(JSON.stringify({ 
          status: 'ok', 
          version: VERSION,
          uptime: process.uptime(),
          memory: process.memoryUsage()
        }));
      } else if (path === '/metrics') {
        // Prometheus metrics endpoint
        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        
        if (this.metricsCollector) {
          // Use new metrics collector
          const prometheusMetrics = await this.metricsCollector.register.metrics();
          res.end(prometheusMetrics);
        } else {
          // Fallback to monitoring system
          const prometheusMetrics = this.monitoringManager.exportPrometheus();
          res.end(prometheusMetrics);
        }
      } else if (path === '/api/stats') {
        // Performance stats endpoint
        res.end(JSON.stringify(this.performanceMonitor.getStats()));
      } else if (path === '/api/dashboard') {
        // Dashboard metrics endpoint
        await this.handleDashboardRequest(req, res);
      } else if (path === '/dashboard') {
        // Serve dashboard HTML
        await this.serveDashboard(req, res);
      } else if (path === '/health' || path.startsWith('/health/') || path === '/ready' || path === '/live') {
        // Health check endpoints
        await this.handleHealthRequest(req, res, path);
      } else if (path === '/api/security') {
        // Security report endpoint
        res.end(JSON.stringify(this.securityMiddleware.getSecurityReport()));
      } else if (path === '/api/backup/status') {
        // Backup status endpoint
        await this.handleBackupStatus(req, res);
      } else if (path === '/api/backup/list') {
        // List backups endpoint
        await this.handleBackupList(req, res);
      } else if (path === '/api/backup/trigger' && req.method === 'POST') {
        // Trigger manual backup
        await this.handleBackupTrigger(req, res);
      } else if (path === '/api/backup/schedule' && req.method === 'POST') {
        // Update backup schedule
        await this.handleBackupScheduleUpdate(req, res);
      } else if (path === '/api/monitoring') {
        // Monitoring stats endpoint
        const stats = await this.monitoringManager.getStats();
        res.end(JSON.stringify(stats));
      } else if (path === '/api/monitoring/metrics') {
        // Prometheus metrics endpoint
        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        const prometheusMetrics = this.monitoringManager.exportPrometheus();
        res.end(prometheusMetrics);
      } else if (path === '/api/alerts') {
        // Alert management endpoints
        await this.handleAlertEndpoints(req, res);
      } else if (path === '/api/language' && req.method === 'POST') {
        // Language change endpoint
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { locale } = JSON.parse(body);
            if (!locale || !['ja', 'en', 'zh'].includes(locale)) {
              return res.sendLocalizedError(400, 'errors.invalidInput');
            }
            res.setLocale(locale);
            res.sendLocalizedSuccess({ locale }, 'common.success');
          } catch (error) {
            res.sendLocalizedError(400, 'errors.invalidInput');
          }
        });
      } else if (path === '/api/language' && req.method === 'GET') {
        // Get current language and available languages
        res.end(JSON.stringify({
          current: req.locale,
          available: [
            { code: 'ja', name: '日本語' },
            { code: 'en', name: 'English' },
            { code: 'zh', name: '中文' }
          ]
        }));
      } else if (path.match(/^\/api\/translations\/(ja|en|zh)$/)) {
        // Get translations for specific locale
        const locale = path.split('/').pop();
        try {
          const I18nManager = (await import('./lib/i18n/index.js')).default;
          const i18n = new I18nManager();
          const translations = await i18n.loadLocale(locale);
          res.end(JSON.stringify(translations));
        } catch (error) {
          res.sendLocalizedError(500, 'errors.general');
        }
      } else if (path === '/performance') {
        // Serve performance dashboard
        const fs = await import('fs/promises');
        try {
          const dashboardPath = resolve(__dirname, 'public', 'performance-dashboard.html');
          const html = await fs.readFile(dashboardPath, 'utf-8');
          res.setHeader('Content-Type', 'text/html');
          res.end(html);
        } catch (error) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Dashboard not found' }));
        }
      } else if (path === '/analytics') {
        // Serve analytics dashboard
        const fs = await import('fs/promises');
        try {
          const dashboardPath = resolve(__dirname, 'public', 'analytics-dashboard.html');
          const html = await fs.readFile(dashboardPath, 'utf-8');
          res.setHeader('Content-Type', 'text/html');
          res.end(html);
        } catch (error) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Analytics dashboard not found' }));
        }
      } else if (path === '/bot-manager') {
        // Serve bot manager interface
        const fs = await import('fs/promises');
        try {
          const botManagerPath = resolve(__dirname, 'public', 'bot-manager.html');
          const html = await fs.readFile(botManagerPath, 'utf-8');
          res.setHeader('Content-Type', 'text/html');
          res.end(html);
        } catch (error) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Bot manager not found' }));
        }
      } else if (path === '/api/analytics/summary') {
        // Analytics summary endpoint
        if (this.analyticsDashboard) {
          const summary = this.analyticsDashboard.getAnalyticsSummary();
          res.end(JSON.stringify(summary));
        } else {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'Analytics service not available' }));
        }
      } else if (path === '/api/analytics/metrics' && method === 'GET') {
        // Export analytics metrics
        if (this.analyticsDashboard) {
          res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
          const metrics = this.analyticsDashboard.exportPrometheusMetrics();
          res.end(metrics);
        } else {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'Analytics service not available' }));
        }
      } else if (path.startsWith('/api/')) {
        await this.handleApiRequest(req, res, url);
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not Found' }));
      }
      
      // End timing for successful request
      this.performanceMonitor?.endTiming(timingId, true);
      
      // Record metrics
      const duration = Date.now() - (timingId || Date.now());
      
      // Use new metrics collector if available
      if (this.metricsCollector) {
        this.metricsCollector.recordHTTPRequest({
          method: req.method,
          route: path,
          statusCode: res.statusCode,
          duration: duration / 1000 // Convert to seconds
        });
      } else {
        // Fallback to monitoring system
        observe('http_request_duration_seconds', {
          method: req.method,
          route: path,
          status: res.statusCode.toString()
        }, duration / 1000);
        
        inc('http_requests_total', {
          method: req.method,
          route: path,
          status: res.statusCode.toString()
        });
      }
    } catch (error) {
      // Use standardized error handler
      const standardErrorHandler = getStandardizedErrorHandler();
      const processedError = await standardErrorHandler.handleError(error, {
        context: {
          method: req.method,
          path,
          userAgent: req.headers['user-agent'],
          ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
        }
      });
      
      const response = processedError.toHttpResponse();
      
      if (!res.headersSent) {
        res.statusCode = response.statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(response.body));
      }
      
      // End timing for failed request
      this.performanceMonitor?.endTiming(timingId, false);
      
      // Record error metrics
      inc('http_requests_total', {
        method: req.method,
        route: path,
        status: response.statusCode.toString()
      });
    }
  }

  /**
   * Handle API requests with comprehensive endpoint support
   */
  async handleApiRequest(req, res, url) {
    const path = url.pathname;
    const method = req.method;
    
    try {
      // Authentication endpoints
      if (path.startsWith('/api/auth/')) {
        await this.handleAuthRequest(req, res, path, method);
      }
      // Mining pool endpoints
      else if (path.startsWith('/api/mining/')) {
        const pool = await this.getMiningPool();
        await pool.handleRequest(req, res, url);
      }
      // DEX endpoints
      else if (path.startsWith('/api/dex/')) {
        const dex = await this.getDEXEngine();
        await dex.handleRequest(req, res, url);
      }
      // DeFi endpoints
      else if (path.startsWith('/api/defi/yield/')) {
        await this.handleYieldAggregatorEndpoint(req, res, path);
      }
      else if (path.startsWith('/api/defi/atomic/')) {
        await this.handleAtomicSwapEndpoint(req, res, path);
      }
      else if (path.startsWith('/api/defi/compound/')) {
        await this.handleAutoCompoundEndpoint(req, res, path);
      }
      else if (path.startsWith('/api/defi/leveraged-yield/')) {
        await this.handleLeveragedYieldEndpoint(req, res, path);
      }
      else if (path.startsWith('/api/defi/')) {
        await this.handleDeFiRequest(req, res, path);
      }
      // User endpoints
      else if (path.startsWith('/api/user/')) {
        await this.handleUserRequest(req, res, path);
      }
      // Admin endpoints
      else if (path.startsWith('/api/admin/')) {
        await this.handleAdminRequest(req, res, path);
      }
      // Backup endpoints
      else if (path.startsWith('/api/backup/')) {
        await this.handleBackupRequest(req, res, path);
      }
      // Batch endpoints - specific batch operations
      else if (path.startsWith('/api/batch/')) {
        await this.handleBatchEndpoint(req, res, path);
      }
      // ML endpoints
      else if (path.startsWith('/api/ml/')) {
        await this.handleMLEndpoint(req, res, path);
      }
      // Advanced DEX order endpoints
      else if (path.startsWith('/api/dex/advanced/')) {
        await this.handleAdvancedOrdersEndpoint(req, res, path);
      }
      // Concentrated liquidity endpoints
      else if (path.startsWith('/api/dex/liquidity/')) {
        await this.handleConcentratedLiquidityEndpoint(req, res, path);
      }
      // Derivatives endpoints
      else if (path.startsWith('/api/derivatives/perpetual/')) {
        await this.handlePerpetualFuturesEndpoint(req, res, path);
      }
      // NFT lending endpoints
      else if (path.startsWith('/api/nft/lending/')) {
        await this.handleNFTLendingEndpoint(req, res, path);
      }
      // Bot endpoints
      else if (path.startsWith('/api/bots/')) {
        await this.handleBotEndpoint(req, res, path);
      }
      // Notification endpoints
      else if (path.startsWith('/api/notifications/')) {
        await this.handleNotificationEndpoint(req, res, path);
      }
      // Social trading endpoints
      else if (path.startsWith('/api/social/')) {
        await this.handleSocialEndpoint(req, res, path);
      }
      // Persistence endpoints
      else if (path.startsWith('/api/persistence/')) {
        await this.handlePersistenceEndpoint(req, res, path);
      }
      // Stats endpoint
      else if (path === '/api/stats') {
        const stats = await this.getStats();
        res.end(JSON.stringify(stats));
      }
      // Price feed endpoint
      else if (path === '/api/prices') {
        await this.handlePricesRequest(req, res);
      }
      // System endpoints
      else if (path === '/api/system/info') {
        res.end(JSON.stringify({
          version: VERSION,
          environment: config.environment,
          uptime: process.uptime(),
          features: {
            mining: true,
            dex: true,
            defi: true,
            p2p: !!this.p2pController
          }
        }));
      }
      else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'API endpoint not found', path }));
      }
    } catch (error) {
      // Use standardized error handler
      const standardErrorHandler = getStandardizedErrorHandler();
      const processedError = await standardErrorHandler.handleError(error, {
        context: { path, method, service: 'api' }
      });

      const response = processedError.toHttpResponse();
      
      if (!res.headersSent) {
        res.statusCode = response.statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(response.body));
      }
    }
  }

  /**
   * Get mining pool instance (lazy loaded)
   */
  async getMiningPool() {
    if (!this.modules.has('miningPool')) {
      const { MiningPool } = await lazyLoad('./lib/mining-pool.js');
      const pool = new MiningPool(this.db, {
        logger: this.logger,
        cache: this.cache
      });
      this.modules.set('miningPool', pool);
      
      // Register with CPU affinity manager
      if (this.cpuAffinityManager) {
        this.cpuAffinityManager.registerProcess(process.pid, 'mining');
      }
      
      // Subscribe alert manager to mining pool events
      if (this.alertManager) {
        this.alertManager.subscribeToSystemEvents({ miningPool: pool });
      }
      
      // Connect analytics dashboard
      if (this.analyticsDashboard) {
        this.analyticsDashboard.connectServices({ miningPool: pool });
      }
    }
    return this.modules.get('miningPool');
  }

  /**
   * Get DEX engine instance (lazy loaded)
   */
  async getDEXEngine() {
    if (!this.modules.has('dexEngine')) {
      const { getDEX } = await lazyLoad('./lib/dex/index.js');
      const dex = getDEX({
        logger: this.logger,
        cache: this.cache
      });
      this.modules.set('dexEngine', dex);
      
      // Register with CPU affinity manager
      if (this.cpuAffinityManager) {
        this.cpuAffinityManager.registerProcess(process.pid, 'dex');
      }
      
      // Subscribe alert manager to DEX events
      if (this.alertManager) {
        this.alertManager.subscribeToSystemEvents({ dexEngine: dex });
      }
      
      // Connect analytics dashboard
      if (this.analyticsDashboard) {
        this.analyticsDashboard.connectServices({ dexEngine: dex });
      }
    }
    return this.modules.get('dexEngine');
  }

  /**
   * Parse request body helper
   */
  async parseRequestBody(req) {
    return new Promise((resolve, reject) => {
      if (req.headers['content-type']?.includes('application/json')) {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
          // Limit body size to prevent DoS
          if (body.length > 1048576) { // 1MB limit
            reject(new Error('Request body too large'));
          }
        });
        req.on('end', () => {
          try {
            resolve(JSON.parse(body || '{}'));
          } catch (error) {
            reject(new Error('Invalid JSON in request body'));
          }
        });
        req.on('error', reject);
      } else {
        resolve({});
      }
    });
  }

  /**
   * Handle authentication requests
   */
  async handleAuthRequest(req, res, path, method) {
    // Initialize auth routes if not already done
    if (!this.authRouter) {
      const { createAuthRoutes } = await import('./lib/routes/auth-routes.js');
      this.authRouter = createAuthRoutes(this.securityMiddleware, this.authManager);
    }
    
    // Create a mock Express-like request/response
    req.path = path;
    req.query = Object.fromEntries(new URL(req.url, `http://${req.headers.host}`).searchParams);
    req.params = {};
    
    // Parse body for POST/PUT requests
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const body = await this.parseRequestBody(req);
      req.body = body;
    }
    
    // Route auth requests through the auth router
    const mockNext = (error) => {
      if (error) {
        this.errorHandler.handleError(error, {
          service: 'auth',
          context: { path, method }
        });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error.message || 'Internal server error' }));
        }
      }
    };
    
    // Find matching route
    const route = path.replace('/api/auth', '');
    const fullPath = `/api${route}`;
    
    // Manually route to auth endpoints
    if (method === 'POST' && route === '/login') {
      return this.authRouter.handle(req, res, mockNext);
    } else if (method === 'POST' && route === '/logout') {
      return this.authRouter.handle(req, res, mockNext);
    } else if (method === 'GET' && route === '/session') {
      return this.authRouter.handle(req, res, mockNext);
    } else if (method === 'POST' && route === '/refresh') {
      return this.authRouter.handle(req, res, mockNext);
    } else if (method === 'GET' && route === '/csrf-token') {
      return this.authRouter.handle(req, res, mockNext);
    } else if (route.startsWith('/keys')) {
      return this.authRouter.handle(req, res, mockNext);
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Auth endpoint not found' }));
    }
  }
  
  /**
   * Handle DeFi requests
   */
  async handleDeFiRequest(req, res, path) {
    const method = req.method;
    
    if (path === '/api/defi/pools' && method === 'GET') {
      // Get liquidity pools
      try {
        const pools = this.db.prepare(
          'SELECT * FROM liquidity_pools ORDER BY total_supply DESC LIMIT 100'
        ).all();
        res.end(JSON.stringify({ pools }));
      } catch (error) {
        res.end(JSON.stringify({ pools: [], error: 'Failed to fetch pools' }));
      }
    } else if (path === '/api/defi/yield' && method === 'GET') {
      // Get yield farming opportunities
      res.end(JSON.stringify({ 
        farms: [],
        message: 'Yield farming coming soon' 
      }));
    } else if (path.startsWith('/api/defi/lending')) {
      // Handle lending requests
      await this.handleLendingRequest(req, res, path);
    } else if (path.startsWith('/api/defi/staking') || path.startsWith('/api/defi/governance') || path.startsWith('/api/defi/rewards')) {
      // Handle staking requests
      await this.handleStakingRequest(req, res, path);
    } else if (path.startsWith('/api/bridge')) {
      // Handle bridge requests
      await this.handleBridgeRequest(req, res, path);
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'DeFi endpoint not found' }));
    }
  }
  
  /**
   * Get Lending Manager instance (lazy loaded)
   */
  async getLendingManager() {
    if (!this.modules.has('lendingManager')) {
      const { LendingManager } = await lazyLoad('./lib/lending/index.js');
      const lendingManager = new LendingManager({
        logger: this.logger,
        db: this.db,
        cache: this.cache,
        priceOracle: this.services.get('priceFeed')
      });
      await lendingManager.start();
      this.modules.set('lendingManager', lendingManager);
      
      // Register with monitoring
      if (this.alertManager) {
        this.alertManager.subscribeToSystemEvents({ lendingManager });
      }
      
      // Connect analytics dashboard
      if (this.analyticsDashboard) {
        this.analyticsDashboard.connectServices({ 
          defiManager: lendingManager,
          performanceMonitor: this.performanceMonitor 
        });
      }
    }
    return this.modules.get('lendingManager');
  }

  /**
   * Handle lending requests
   */
  async handleLendingRequest(req, res, path) {
    const method = req.method;
    const body = method === 'POST' || method === 'PUT' ? await this.parseRequestBody(req) : null;
    
    try {
      const lendingManager = await this.getLendingManager();
      
      // Extract user ID from authentication (mock for now)
      const userId = req.headers.authorization ? 'user123' : null;
      if (!userId && !path.endsWith('/markets')) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }
      
      // Route lending endpoints
      if (path === '/api/defi/lending/markets' && method === 'GET') {
        const markets = lendingManager.getMarkets();
        res.end(JSON.stringify({ success: true, markets }));
        
      } else if (path === '/api/defi/lending/stats' && method === 'GET') {
        const stats = lendingManager.getProtocolStats();
        res.end(JSON.stringify({ success: true, stats }));
        
      } else if (path === '/api/defi/lending/deposit' && method === 'POST') {
        const { asset, amount } = body;
        const result = await lendingManager.deposit(userId, asset, amount);
        res.end(JSON.stringify({ success: true, result }));
        
      } else if (path === '/api/defi/lending/withdraw' && method === 'POST') {
        const { asset, amount } = body;
        const result = await lendingManager.withdraw(userId, asset, amount);
        res.end(JSON.stringify({ success: true, result }));
        
      } else if (path === '/api/defi/lending/borrow' && method === 'POST') {
        const result = await lendingManager.borrow({ userId, ...body });
        res.end(JSON.stringify({ success: true, result }));
        
      } else if (path === '/api/defi/lending/repay' && method === 'POST') {
        const { loanId, amount } = body;
        const result = await lendingManager.repay(userId, loanId, amount);
        res.end(JSON.stringify({ success: true, result }));
        
      } else if (path === '/api/defi/lending/position' && method === 'GET') {
        const position = await lendingManager.getUserPosition(userId);
        res.end(JSON.stringify({ success: true, position }));
        
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Lending endpoint not found' }));
      }
    } catch (error) {
      this.logger.error('Lending request error:', error);
      res.statusCode = error.statusCode || 500;
      res.end(JSON.stringify({ 
        success: false, 
        error: error.message || 'Internal server error' 
      }));
    }
  }

  /**
   * Get Staking Manager instance (lazy loaded)
   */
  async getStakingManager() {
    if (!this.modules.has('stakingManager')) {
      const { StakingManager } = await lazyLoad('./lib/staking/index.js');
      const stakingManager = new StakingManager({
        logger: this.logger,
        db: this.db,
        cache: this.cache,
        enableStaking: true,
        enableGovernance: true,
        enableRewards: true
      });
      await stakingManager.start();
      this.modules.set('stakingManager', stakingManager);
      
      // Register with monitoring
      if (this.alertManager) {
        this.alertManager.subscribeToSystemEvents({ stakingManager });
      }
      
      // Connect revenue sources
      this.connectRevenueToStaking(stakingManager);
    }
    return this.modules.get('stakingManager');
  }

  /**
   * Connect revenue sources to staking rewards
   */
  connectRevenueToStaking(stakingManager) {
    // Connect trading fees
    if (this.modules.has('dexEngine')) {
      const dex = this.modules.get('dexEngine');
      dex.on('fee-collected', (data) => {
        stakingManager.addRevenue('tradingFees', data.asset, data.amount);
      });
    }
    
    // Connect mining fees
    if (this.modules.has('miningPool')) {
      const pool = this.modules.get('miningPool');
      pool.on('fee-collected', (data) => {
        stakingManager.addRevenue('miningFees', data.asset, data.amount);
      });
    }
    
    // Connect lending fees
    if (this.modules.has('lendingManager')) {
      const lending = this.modules.get('lendingManager');
      lending.on('fee-collected', (data) => {
        stakingManager.addRevenue('lendingFees', data.asset, data.amount);
      });
    }
  }
  
  /**
   * Get Bridge Manager instance (lazy loaded)
   */
  async getBridgeManager() {
    if (!this.modules.has('bridgeManager')) {
      const { BridgeManager } = await lazyLoad('./lib/bridges/index.js');
      const bridgeManager = new BridgeManager({
        logger: this.logger,
        db: this.db,
        cache: this.cache,
        enableBridge: true,
        enableWrapper: true,
        enableValidators: true,
        validatorCount: 5,
        minValidatorSignatures: 3
      });
      await bridgeManager.start();
      this.modules.set('bridgeManager', bridgeManager);
      
      // Register with monitoring
      if (this.alertManager) {
        this.alertManager.addDataSource('bridge', bridgeManager);
      }
      
      // Connect bridge fees to staking rewards
      bridgeManager.on('bridge-completed', (data) => {
        if (this.modules.has('stakingManager')) {
          const stakingManager = this.modules.get('stakingManager');
          stakingManager.addRevenue('bridgeFees', data.asset, data.bridgeFee || 0);
        }
      });
    }
    return this.modules.get('bridgeManager');
  }
  
  /**
   * Handle bridge requests
   */
  async handleBridgeRequest(req, res, path) {
    const method = req.method;
    const body = method === 'POST' || method === 'PUT' ? await this.parseRequestBody(req) : null;
    
    try {
      const bridgeManager = await this.getBridgeManager();
      
      // Extract user ID from authentication (mock for now)
      const userId = req.headers.authorization ? 'user123' : null;
      
      // Public endpoints
      if (path === '/api/bridge/chains' && method === 'GET') {
        const chains = bridgeManager.bridgeCore ? bridgeManager.bridgeCore.getSupportedChains() : [];
        res.end(JSON.stringify({ success: true, chains }));
        
      } else if (path === '/api/bridge/routes' && method === 'GET') {
        const routes = bridgeManager.getSupportedRoutes();
        res.end(JSON.stringify({ success: true, ...routes }));
        
      } else if (path === '/api/bridge/stats' && method === 'GET') {
        const stats = bridgeManager.getStatistics();
        res.end(JSON.stringify({ success: true, stats }));
        
      } else if (path.match(/^\/api\/bridge\/status\/(.+)$/) && method === 'GET') {
        const bridgeId = path.match(/^\/api\/bridge\/status\/(.+)$/)[1];
        const status = bridgeManager.getBridgeStatus(bridgeId);
        res.end(JSON.stringify({ success: true, status }));
        
      } else if (!userId) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Authentication required' }));
        
      } else if (path === '/api/bridge/transfer' && method === 'POST') {
        const result = await bridgeManager.bridgeAssets({
          userId,
          ...body
        });
        res.end(JSON.stringify({ success: true, result }));
        
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Bridge endpoint not found' }));
      }
      
    } catch (error) {
      this.logger.error('Bridge request error:', error);
      res.statusCode = error.statusCode || 400;
      res.end(JSON.stringify({ 
        success: false, 
        error: error.message || 'Bridge operation failed' 
      }));
    }
  }

  /**
   * Handle staking requests
   */
  async handleStakingRequest(req, res, path) {
    const method = req.method;
    const body = method === 'POST' || method === 'PUT' ? await this.parseRequestBody(req) : null;
    
    try {
      const stakingManager = await this.getStakingManager();
      
      // Extract user ID from authentication (mock for now)
      const userId = req.headers.authorization ? 'user123' : null;
      
      // Public endpoints
      if (path === '/api/defi/staking/pools' && method === 'GET') {
        const pools = stakingManager.getStakingPools();
        res.end(JSON.stringify({ success: true, pools }));
        
      } else if (path === '/api/defi/staking/stats' && method === 'GET') {
        const stats = stakingManager.getStats();
        res.end(JSON.stringify({ success: true, stats }));
        
      } else if (path === '/api/defi/governance/proposals' && method === 'GET') {
        const proposals = stakingManager.getProposals();
        res.end(JSON.stringify({ success: true, proposals }));
        
      } else if (path.startsWith('/api/defi/governance/proposal/') && method === 'GET') {
        const proposalId = path.split('/').pop();
        const proposal = stakingManager.getProposal(proposalId);
        if (proposal) {
          res.end(JSON.stringify({ success: true, proposal }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Proposal not found' }));
        }
        
      } else {
        // Authenticated endpoints
        if (!userId) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'Authentication required' }));
          return;
        }
        
        if (path === '/api/defi/staking/stake' && method === 'POST') {
          const { poolId, amount, lockPeriod } = body;
          const result = await stakingManager.stake(userId, poolId, amount, lockPeriod);
          res.end(JSON.stringify({ success: true, result }));
          
        } else if (path === '/api/defi/staking/unstake' && method === 'POST') {
          const { stakeId, amount } = body;
          const result = await stakingManager.unstake(userId, stakeId, amount);
          res.end(JSON.stringify({ success: true, result }));
          
        } else if (path === '/api/defi/staking/claim' && method === 'POST') {
          const { stakeId } = body;
          const result = await stakingManager.claimStakingRewards(userId, stakeId);
          res.end(JSON.stringify({ success: true, result }));
          
        } else if (path === '/api/defi/staking/compound' && method === 'POST') {
          const { stakeId } = body;
          const result = await stakingManager.compound(userId, stakeId);
          res.end(JSON.stringify({ success: true, result }));
          
        } else if (path === '/api/defi/staking/position' && method === 'GET') {
          const position = await stakingManager.getUserPosition(userId);
          res.end(JSON.stringify({ success: true, position }));
          
        } else if (path === '/api/defi/governance/propose' && method === 'POST') {
          const result = await stakingManager.createProposal({
            proposerId: userId,
            ...body
          });
          res.end(JSON.stringify({ success: true, result }));
          
        } else if (path === '/api/defi/governance/vote' && method === 'POST') {
          const { proposalId, support, reason } = body;
          const result = await stakingManager.vote(userId, proposalId, support, reason);
          res.end(JSON.stringify({ success: true, result }));
          
        } else if (path === '/api/defi/rewards/claim' && method === 'POST') {
          const result = await stakingManager.claimRewards(userId);
          res.end(JSON.stringify({ success: true, result }));
          
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Staking endpoint not found' }));
        }
      }
    } catch (error) {
      this.logger.error('Staking request error:', error);
      res.statusCode = error.statusCode || 500;
      res.end(JSON.stringify({ 
        success: false, 
        error: error.message || 'Internal server error' 
      }));
    }
  }

  /**
   * Handle user requests
   */
  async handleUserRequest(req, res, path) {
    const method = req.method;
    
    if (path === '/api/user/profile' && method === 'GET') {
      // Check authentication
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }
      
      try {
        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, process.env.JWT_SECRET || this.authManager.config.jwtSecret);
        
        // Get user profile from database
        const user = await this.dbManager.get('users', { id: decoded.id });
        if (!user) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'User not found' }));
          return;
        }
        
        res.statusCode = 200;
        res.end(JSON.stringify({
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
          createdAt: user.created_at,
          lastLogin: user.last_login
        }));
      } catch (error) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Invalid token' }));
      }
    } else if (path === '/api/user/balance' && method === 'GET') {
      // Check authentication
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }
      
      try {
        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, process.env.JWT_SECRET || this.authManager.config.jwtSecret);
        
        // Get user balances from database
        const balances = await this.dbManager.query(
          'SELECT currency, available_balance, locked_balance FROM user_balances WHERE user_id = ?',
          [decoded.id]
        );
        
        const balanceMap = {};
        for (const balance of balances) {
          balanceMap[balance.currency] = {
            available: balance.available_balance,
            locked: balance.locked_balance,
            total: balance.available_balance + balance.locked_balance
          };
        }
        
        res.statusCode = 200;
        res.end(JSON.stringify({
          userId: decoded.id,
          balances: balanceMap
        }));
      } catch (error) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Invalid token' }));
      }
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'User endpoint not found' }));
    }
  }
  
  /**
   * Handle admin requests
   */
  async handleAdminRequest(req, res, path) {
    // TODO: Implement admin authentication middleware
    res.statusCode = 403;
    res.end(JSON.stringify({ error: 'Admin access required' }));
  }
  
  /**
   * Handle backup requests
   */
  async handleBackupRequest(req, res, path) {
    // Initialize backup routes if not already done
    if (!this.backupRouter) {
      const { createBackupRoutes } = await import('./lib/routes/backup-routes.js');
      const backupManager = this.services.get('backupManager');
      
      if (!backupManager) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'Backup service not available' }));
        return;
      }
      
      this.backupRouter = createBackupRoutes({ backupManager });
    }
    
    // Create mock Express request/response
    req.path = path.replace('/api/backup', '');
    req.query = Object.fromEntries(new URL(req.url, `http://${req.headers.host}`).searchParams);
    req.params = {};
    
    // Parse body for POST/PUT requests
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      req.body = await this.parseRequestBody(req);
    }
    
    // Extract params from path
    const pathParts = req.path.split('/').filter(p => p);
    if (pathParts.length >= 2) {
      // Handle routes like /restore/:backupId or /verify/:backupId
      if (['restore', 'verify', 'download'].includes(pathParts[0])) {
        req.params.backupId = pathParts[1];
        req.path = `/${pathParts[0]}/:backupId`;
      } else if (pathParts[0] === 'schedule' && pathParts[1]) {
        req.params.name = pathParts[1];
        req.path = '/schedule/:name';
      } else if (pathParts[1]) {
        req.params.backupId = pathParts[0];
        req.path = '/:backupId';
      }
    }
    
    // Route through backup router
    const mockNext = (error) => {
      if (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error.message || 'Internal server error' }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Backup endpoint not found' }));
      }
    };
    
    // Find matching route handler
    const handlers = this.backupRouter.stack;
    for (const layer of handlers) {
      if (layer.route && layer.route.path === req.path && layer.route.methods[req.method.toLowerCase()]) {
        return layer.handle(req, res, mockNext);
      }
    }
    
    mockNext();
  }
  
  /**
   * Handle batch API endpoints
   */
  async handleBatchEndpoint(req, res, path) {
    try {
      // Check authentication
      if (!req.user && !req.apiKey) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }
      
      const method = req.method;
      
      // Initialize batch endpoints if needed
      if (!this.batchEndpoints) {
        const batchRoutes = await import('./lib/api/batch-endpoints.js');
        this.batchEndpoints = batchRoutes.default;
        
        // Initialize batch processors
        const { OrderBatchProcessor, TransactionBatchProcessor, UserBatchProcessor } = await import('./lib/api/batch-processor.js');
        
        this.batchProcessors = {
          orders: new OrderBatchProcessor(this.modules.get('dexEngine'), { maxConcurrent: 10 }),
          transactions: new TransactionBatchProcessor(this.modules.get('transactionManager'), { maxConcurrent: 5 }),
          users: new UserBatchProcessor(this.modules.get('userManager'), { maxConcurrent: 20 })
        };
      }
      
      // Parse request body
      const body = await this.parseRequestBody(req);
      
      // Route batch endpoints
      if (path === '/api/batch/orders' && method === 'POST') {
        const result = await this.batchProcessors.orders.processOrders(body.orders, req.user?.id || req.apiKey);
        res.statusCode = 200;
        res.end(JSON.stringify(result));
        
      } else if (path === '/api/batch/transactions' && method === 'POST') {
        const result = await this.batchProcessors.transactions.processTransactions(body.transactions, req.user?.id || req.apiKey);
        res.statusCode = 200;
        res.end(JSON.stringify(result));
        
      } else if (path === '/api/batch/users' && method === 'POST') {
        // Admin only
        if (!req.user || req.user.role !== 'admin') {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'Admin access required' }));
          return;
        }
        const result = await this.batchProcessors.users.processUserOperation(body.operation, body.users, req.user.id);
        res.statusCode = 200;
        res.end(JSON.stringify(result));
        
      } else if (path === '/api/batch/trades' && method === 'POST') {
        // Use order processor for trades
        const result = await this.batchProcessors.orders.processOrders(
          body.trades.map(t => ({ ...t, type: t.type || 'market' })), 
          req.user?.id || req.apiKey
        );
        res.statusCode = 200;
        res.end(JSON.stringify(result));
        
      } else if (path === '/api/batch/withdrawals' && method === 'POST') {
        // Verify 2FA
        const twoFACode = req.headers['x-2fa-code'];
        if (!twoFACode) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: '2FA verification required' }));
          return;
        }
        
        const result = await this.batchProcessors.transactions.processTransactions(
          body.withdrawals.map(w => ({ ...w, type: 'withdrawal' })),
          req.user?.id || req.apiKey
        );
        res.statusCode = 200;
        res.end(JSON.stringify(result));
        
      } else if (path.startsWith('/api/batch/status/') && method === 'GET') {
        const batchId = path.split('/').pop();
        const status = await this.getBatchStatus(batchId, req.user?.id || req.apiKey);
        if (status) {
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, batch: status }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Batch operation not found' }));
        }
        
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Batch endpoint not found' }));
      }
      
    } catch (error) {
      this.logger.error('Batch endpoint error:', error);
      res.statusCode = error.statusCode || 500;
      res.end(JSON.stringify({ 
        error: error.message || 'Internal server error',
        code: error.code || 'INTERNAL_ERROR'
      }));
    }
  }
  
  /**
   * Get batch operation status
   */
  async getBatchStatus(batchId, userId) {
    // Check all processors for the batch
    for (const [name, processor] of Object.entries(this.batchProcessors || {})) {
      const status = processor.getBatchStatus(batchId);
      if (status) {
        return status;
      }
    }
    return null;
  }
  
  /**
   * Handle ML API endpoints
   */
  async handleMLEndpoint(req, res, path) {
    try {
      // Initialize ML service if needed
      if (!this.pricePredictor) {
        const { PricePredictor } = await import('./lib/ml/price-predictor.js');
        this.pricePredictor = new PricePredictor({
          modelType: 'ensemble',
          lookbackPeriod: 60,
          predictionHorizon: 15,
          updateInterval: 60000
        });
        
        // Connect to DEX for market data
        if (this.modules.has('dexEngine')) {
          const dex = this.modules.get('dexEngine');
          this.pricePredictor.getMarketData = async () => {
            const pairs = ['BTC/USDT', 'ETH/USDT', 'ETH/BTC'];
            const data = {};
            
            for (const pair of pairs) {
              const candles = dex.getCandles(pair, '1m', 100);
              data[pair] = candles.map(c => ({
                time: c.time,
                price: c.close,
                volume: c.volume
              }));
            }
            
            return data;
          };
        }
        
        await this.pricePredictor.start();
        this.services.set('pricePredictor', this.pricePredictor);
      }
      
      // Set predictor in app locals for endpoints
      req.app = { locals: { pricePredictor: this.pricePredictor } };
      
      // Import ML routes
      if (!this.mlRouter) {
        const mlRoutes = await import('./lib/api/ml-endpoints.js');
        this.mlRouter = mlRoutes.default;
      }
      
      // Create mock Express request/response
      req.path = path.replace('/api/ml', '');
      req.query = Object.fromEntries(new URL(req.url, `http://${req.headers.host}`).searchParams);
      req.params = {};
      
      // Parse body for POST/PUT requests
      if (req.method === 'POST' || req.method === 'PUT') {
        req.body = await this.parseRequestBody(req);
      }
      
      // Extract params from path
      const pathParts = req.path.split('/').filter(p => p);
      if (pathParts.length >= 2 && pathParts[0] === 'predictions') {
        req.params.pair = pathParts[1];
        req.path = '/predictions/:pair';
      }
      
      // Route through ML router
      const mockNext = (error) => {
        if (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error.message || 'Internal server error' }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'ML endpoint not found' }));
        }
      };
      
      // Find matching route handler
      const method = req.method.toLowerCase();
      const handlers = this.mlRouter.stack;
      
      for (const layer of handlers) {
        if (layer.route && layer.route.path === req.path && layer.route.methods[method]) {
          return layer.handle(req, res, mockNext);
        }
      }
      
      mockNext();
      
    } catch (error) {
      this.logger.error('ML endpoint error:', error);
      res.statusCode = 500;
      res.end(JSON.stringify({ 
        error: error.message || 'Internal server error',
        code: 'ML_ERROR'
      }));
    }
  }
  
  /**
   * Handle Advanced Orders API endpoints
   */
  async handleAdvancedOrdersEndpoint(req, res, path) {
    try {
      // Initialize advanced order manager if needed
      if (!this.advancedOrderManager) {
        const { AdvancedOrderManager } = await import('./lib/dex/advanced-orders.js');
        this.advancedOrderManager = new AdvancedOrderManager({
          minIcebergSize: 1000,
          ocoExpiryTime: 86400000,
          twapInterval: 60000
        });
        
        // Connect to DEX for order execution
        if (this.modules.has('dexEngine')) {
          const dex = this.modules.get('dexEngine');
          
          // Handle order submissions
          this.advancedOrderManager.on('order:submit', (order) => {
            dex.submitOrder(order);
          });
          
          // Handle order cancellations
          this.advancedOrderManager.on('order:cancel', ({ orderId, reason }) => {
            dex.cancelOrder(orderId, { reason });
          });
          
          // Forward fill events
          dex.on('order:filled', (fillData) => {
            this.advancedOrderManager.handleOrderFill(fillData);
          });
          
          // Forward price updates
          dex.on('price:update', ({ pair, price, type }) => {
            this.advancedOrderManager.handlePriceUpdate(pair, price, type);
          });
        }
        
        this.services.set('advancedOrderManager', this.advancedOrderManager);
      }
      
      const method = req.method;
      const body = method === 'POST' || method === 'PUT' ? await this.parseRequestBody(req) : null;
      const userId = req.headers.authorization ? 'user123' : null;
      
      if (!userId) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }
      
      // Route advanced order endpoints
      if (path === '/api/dex/advanced/iceberg' && method === 'POST') {
        const result = await this.advancedOrderManager.createIcebergOrder({ ...body, userId });
        res.end(JSON.stringify({ success: true, order: result }));
        
      } else if (path === '/api/dex/advanced/oco' && method === 'POST') {
        const result = await this.advancedOrderManager.createOCOOrder({ ...body, userId });
        res.end(JSON.stringify({ success: true, order: result }));
        
      } else if (path === '/api/dex/advanced/bracket' && method === 'POST') {
        const result = await this.advancedOrderManager.createBracketOrder({ ...body, userId });
        res.end(JSON.stringify({ success: true, order: result }));
        
      } else if (path === '/api/dex/advanced/stop' && method === 'POST') {
        const result = await this.advancedOrderManager.createStopOrder({ ...body, userId });
        res.end(JSON.stringify({ success: true, order: result }));
        
      } else if (path === '/api/dex/advanced/twap' && method === 'POST') {
        const result = await this.advancedOrderManager.createTWAPOrder({ ...body, userId });
        res.end(JSON.stringify({ success: true, order: result }));
        
      } else if (path === '/api/dex/advanced/stats' && method === 'GET') {
        const stats = this.advancedOrderManager.getStats();
        res.end(JSON.stringify({ success: true, stats }));
        
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Advanced order endpoint not found' }));
      }
      
    } catch (error) {
      this.logger.error('Advanced order endpoint error:', error);
      res.statusCode = error.statusCode || 500;
      res.end(JSON.stringify({ 
        error: error.message || 'Internal server error',
        code: 'ADVANCED_ORDER_ERROR'
      }));
    }
  }
  
  /**
   * Handle Concentrated Liquidity API endpoints
   */
  async handleConcentratedLiquidityEndpoint(req, res, path) {
    try {
      // Initialize concentrated liquidity pool if needed
      if (!this.concentratedLiquidityPool) {
        const { ConcentratedLiquidityPool } = await import('./lib/dex/concentrated-liquidity.js');
        this.concentratedLiquidityPool = new ConcentratedLiquidityPool({
          tickSpacing: 60,
          feeRate: 3000,
          initialPrice: 2n ** 96n * 50000n // ~$50,000 initial price
        });
        
        this.services.set('concentratedLiquidityPool', this.concentratedLiquidityPool);
      }
      
      const method = req.method;
      const body = method === 'POST' || method === 'PUT' ? await this.parseRequestBody(req) : null;
      const userId = req.headers.authorization ? 'user123' : null;
      
      if (!userId && !path.endsWith('/state')) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }
      
      // Route concentrated liquidity endpoints
      if (path === '/api/dex/liquidity/state' && method === 'GET') {
        const state = this.concentratedLiquidityPool.getPoolState();
        res.end(JSON.stringify({ success: true, state }));
        
      } else if (path === '/api/dex/liquidity/mint' && method === 'POST') {
        const result = await this.concentratedLiquidityPool.mintPosition({ ...body, userId });
        res.end(JSON.stringify({ success: true, position: result }));
        
      } else if (path === '/api/dex/liquidity/burn' && method === 'POST') {
        const result = await this.concentratedLiquidityPool.burnPosition({ ...body, userId });
        res.end(JSON.stringify({ success: true, result }));
        
      } else if (path === '/api/dex/liquidity/collect' && method === 'POST') {
        const result = await this.concentratedLiquidityPool.collectFees({ ...body, userId });
        res.end(JSON.stringify({ success: true, fees: result }));
        
      } else if (path === '/api/dex/liquidity/swap' && method === 'POST') {
        const result = await this.concentratedLiquidityPool.swap({ ...body, userId });
        res.end(JSON.stringify({ success: true, swap: result }));
        
      } else if (path === '/api/dex/liquidity/positions' && method === 'GET') {
        const positions = this.concentratedLiquidityPool.getUserPositions(userId);
        res.end(JSON.stringify({ success: true, positions }));
        
      } else if (path === '/api/dex/liquidity/stats' && method === 'GET') {
        const stats = this.concentratedLiquidityPool.getStats();
        res.end(JSON.stringify({ success: true, stats }));
        
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Liquidity endpoint not found' }));
      }
      
    } catch (error) {
      this.logger.error('Concentrated liquidity endpoint error:', error);
      res.statusCode = error.statusCode || 500;
      res.end(JSON.stringify({ 
        error: error.message || 'Internal server error',
        code: 'LIQUIDITY_ERROR'
      }));
    }
  }
  
  /**
   * Handle Yield Aggregator API endpoints
   */
  async handleYieldAggregatorEndpoint(req, res, path) {
    try {
      // Initialize yield aggregator if needed
      if (!this.yieldAggregator) {
        const { YieldAggregator } = await import('./lib/defi/yield-aggregator.js');
        this.yieldAggregator = new YieldAggregator({
          minYieldDifference: 0.005,
          rebalanceThreshold: 0.01,
          autoCompound: true
        });
        
        // Register protocol adapters (mock adapters for demo)
        const mockProtocols = ['Compound', 'Aave', 'Yearn', 'Curve'];
        for (const protocol of mockProtocols) {
          this.yieldAggregator.registerProtocol(protocol, {
            getYieldRate: async () => ({
              apy: 0.05 + Math.random() * 0.15, // 5-20% APY
              apr: 0.045 + Math.random() * 0.135,
              tvl: 1000000 + Math.random() * 9000000,
              fees: { deposit: 0, withdraw: 0.001, performance: 0.1 }
            }),
            deposit: async ({ userId, amount, asset }) => ({
              success: true,
              txHash: `0x${Math.random().toString(16).substr(2, 64)}`,
              amount
            }),
            withdraw: async ({ userId, amount, asset }) => ({
              success: true,
              amount: amount * 0.999, // 0.1% withdraw fee
              txHash: `0x${Math.random().toString(16).substr(2, 64)}`
            }),
            getBalance: async ({ userId }) => ({
              value: 10000 + Math.random() * 90000,
              asset: 'USDT'
            }),
            compound: async ({ userId }) => ({
              compounded: 100 + Math.random() * 900,
              gasUsed: 0.01
            }),
            getPendingYield: async ({ userId }) => ({
              amount: 50 + Math.random() * 450,
              asset: 'USDT'
            })
          });
        }
        
        // Create default strategies
        this.yieldAggregator.createStrategy({
          name: 'Conservative Yield',
          description: 'Low risk stable yield strategy',
          protocols: ['Compound', 'Aave'],
          allocation: { 'Compound': 0.6, 'Aave': 0.4 },
          riskLevel: 'low'
        });
        
        this.yieldAggregator.createStrategy({
          name: 'Balanced Yield',
          description: 'Balanced risk/reward strategy',
          protocols: ['Compound', 'Aave', 'Yearn'],
          allocation: { 'Compound': 0.3, 'Aave': 0.3, 'Yearn': 0.4 },
          riskLevel: 'medium'
        });
        
        this.yieldAggregator.createStrategy({
          name: 'Aggressive Yield',
          description: 'High risk high reward strategy',
          protocols: ['Yearn', 'Curve'],
          allocation: { 'Yearn': 0.6, 'Curve': 0.4 },
          riskLevel: 'high'
        });
        
        this.services.set('yieldAggregator', this.yieldAggregator);
      }
      
      const method = req.method;
      const body = method === 'POST' || method === 'PUT' ? await this.parseRequestBody(req) : null;
      const userId = req.headers.authorization ? 'user123' : null;
      
      if (!userId && !path.endsWith('/strategies') && !path.endsWith('/yields')) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }
      
      // Route yield aggregator endpoints
      if (path === '/api/defi/yield/strategies' && method === 'GET') {
        const strategies = Array.from(this.yieldAggregator.strategies.values());
        res.end(JSON.stringify({ success: true, strategies }));
        
      } else if (path === '/api/defi/yield/best' && method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const params = {
          asset: url.searchParams.get('asset') || 'USDT',
          amount: parseFloat(url.searchParams.get('amount')) || 10000,
          riskLevel: url.searchParams.get('riskLevel') || 'medium'
        };
        const yields = await this.yieldAggregator.getBestYields(params);
        res.end(JSON.stringify({ success: true, yields }));
        
      } else if (path === '/api/defi/yield/deposit' && method === 'POST') {
        const result = await this.yieldAggregator.deposit({ ...body, userId });
        res.end(JSON.stringify({ success: true, result }));
        
      } else if (path === '/api/defi/yield/withdraw' && method === 'POST') {
        const result = await this.yieldAggregator.withdraw({ ...body, userId });
        res.end(JSON.stringify({ success: true, result }));
        
      } else if (path === '/api/defi/yield/positions' && method === 'GET') {
        const positions = this.yieldAggregator.userPositions.get(userId) || [];
        res.end(JSON.stringify({ success: true, positions }));
        
      } else if (path === '/api/defi/yield/stats' && method === 'GET') {
        const stats = this.yieldAggregator.getStats();
        res.end(JSON.stringify({ success: true, stats }));
        
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Yield endpoint not found' }));
      }
      
    } catch (error) {
      this.logger.error('Yield aggregator endpoint error:', error);
      res.statusCode = error.statusCode || 500;
      res.end(JSON.stringify({ 
        error: error.message || 'Internal server error',
        code: 'YIELD_ERROR'
      }));
    }
  }
  
  /**
   * Handle Atomic Swap API endpoints
   */
  async handleAtomicSwapEndpoint(req, res, path) {
    try {
      // Initialize atomic swap manager if needed
      if (!this.atomicSwapManager) {
        const { AtomicSwapManager } = await import('./lib/defi/atomic-swaps.js');
        this.atomicSwapManager = new AtomicSwapManager({
          defaultLockTime: 3600000,
          swapFee: 0.003,
          supportedChains: ['ETH', 'BTC', 'BNB', 'MATIC']
        });
        
        // Register chain adapters (mock adapters for demo)
        const mockChainAdapter = {
          createHTLC: async ({ secretHash, recipient, lockTime, asset }) => 
            `0x${Math.random().toString(16).substr(2, 40)}`,
          lockFunds: async ({ htlcAddress, amount, asset }) => ({
            hash: `0x${Math.random().toString(16).substr(2, 64)}`,
            status: 'pending'
          }),
          redeemFunds: async ({ htlcAddress, secret }) => ({
            hash: `0x${Math.random().toString(16).substr(2, 64)}`,
            status: 'success'
          }),
          refundFunds: async ({ htlcAddress }) => ({
            hash: `0x${Math.random().toString(16).substr(2, 64)}`,
            status: 'success'
          }),
          getHTLCState: async (htlcAddress) => ({
            locked: true,
            redeemed: false,
            refunded: false,
            secret: null
          }),
          verifyTransaction: async (txHash) => ({
            confirmations: Math.floor(Math.random() * 20),
            status: 'confirmed'
          })
        };
        
        for (const chain of ['ETH', 'BTC', 'BNB', 'MATIC']) {
          this.atomicSwapManager.registerChainAdapter(chain, mockChainAdapter);
        }
        
        this.services.set('atomicSwapManager', this.atomicSwapManager);
      }
      
      const method = req.method;
      const body = method === 'POST' || method === 'PUT' ? await this.parseRequestBody(req) : null;
      const userId = req.headers.authorization ? 'user123' : null;
      
      if (!userId) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }
      
      // Route atomic swap endpoints
      if (path === '/api/defi/atomic/initiate' && method === 'POST') {
        const result = await this.atomicSwapManager.initiateSwap({ ...body, userId });
        res.end(JSON.stringify({ success: true, swap: result }));
        
      } else if (path === '/api/defi/atomic/accept' && method === 'POST') {
        const result = await this.atomicSwapManager.acceptSwap({ ...body, userId });
        res.end(JSON.stringify({ success: true, result }));
        
      } else if (path === '/api/defi/atomic/redeem' && method === 'POST') {
        const { swapId, secret, isInitiator } = body;
        await this.atomicSwapManager.redeemFunds(swapId, secret, isInitiator);
        res.end(JSON.stringify({ success: true, message: 'Funds redeemed' }));
        
      } else if (path === '/api/defi/atomic/refund' && method === 'POST') {
        const { swapId, isInitiator } = body;
        await this.atomicSwapManager.refundFunds(swapId, isInitiator);
        res.end(JSON.stringify({ success: true, message: 'Funds refunded' }));
        
      } else if (path === '/api/defi/atomic/extract-secret' && method === 'POST') {
        const { swapId } = body;
        const secret = await this.atomicSwapManager.extractSecret(swapId);
        res.end(JSON.stringify({ success: true, secret }));
        
      } else if (path.startsWith('/api/defi/atomic/status/') && method === 'GET') {
        const swapId = path.split('/').pop();
        const status = this.atomicSwapManager.getSwapStatus(swapId);
        res.end(JSON.stringify({ success: true, swap: status }));
        
      } else if (path === '/api/defi/atomic/swaps' && method === 'GET') {
        const swaps = this.atomicSwapManager.getUserSwaps(userId);
        res.end(JSON.stringify({ success: true, swaps }));
        
      } else if (path === '/api/defi/atomic/stats' && method === 'GET') {
        const stats = this.atomicSwapManager.getStats();
        res.end(JSON.stringify({ success: true, stats }));
        
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Atomic swap endpoint not found' }));
      }
      
    } catch (error) {
      this.logger.error('Atomic swap endpoint error:', error);
      res.statusCode = error.statusCode || 500;
      res.end(JSON.stringify({ 
        error: error.message || 'Internal server error',
        code: 'ATOMIC_SWAP_ERROR'
      }));
    }
  }
  
  /**
   * Handle Auto-Compound API endpoints
   */
  async handleAutoCompoundEndpoint(req, res, path) {
    try {
      // Initialize auto-compound manager if needed
      if (!this.autoCompoundManager) {
        const { AutoCompoundManager } = await import('./lib/defi/auto-compound.js');
        this.autoCompoundManager = new AutoCompoundManager({
          minCompoundValue: 10,
          defaultCompoundFrequency: 86400000, // 24 hours
          performanceFee: 0.1,
          managementFee: 0.02
        });
        
        // Register protocol adapters (mock adapters for demo)
        const mockProtocolAdapter = {
          deposit: async ({ asset, amount, userId }) => ({
            positionId: `POS${Date.now()}${Math.random().toString(36).substr(2, 9)}`,
            txHash: `0x${Math.random().toString(16).substr(2, 64)}`
          }),
          withdraw: async ({ positionId, amount }) => ({
            amount: amount * 0.99,
            txHash: `0x${Math.random().toString(16).substr(2, 64)}`
          }),
          compound: async ({ positionId }) => ({
            compoundedAmount: 50 + Math.random() * 450,
            txHash: `0x${Math.random().toString(16).substr(2, 64)}`
          }),
          getPendingRewards: async ({ positionId }) => ({
            amount: 10 + Math.random() * 90,
            asset: 'USDT'
          }),
          getPositionValue: async ({ positionId }) => 
            10000 + Math.random() * 5000,
          estimateCompoundGas: async () => 150000
        };
        
        for (const protocol of ['compound', 'aave', 'yearn', 'curve']) {
          this.autoCompoundManager.registerProtocolAdapter(protocol, mockProtocolAdapter);
        }
        
        // Register default strategies
        this.autoCompoundManager.registerStrategy({
          name: 'USDT Stable Yield',
          protocol: 'compound',
          asset: 'USDT',
          targetAPY: 0.08,
          riskLevel: 'low',
          minDeposit: 100
        });
        
        this.autoCompoundManager.registerStrategy({
          name: 'ETH Yield Optimizer',
          protocol: 'yearn',
          asset: 'ETH',
          targetAPY: 0.12,
          riskLevel: 'medium',
          minDeposit: 0.1
        });
        
        this.services.set('autoCompoundManager', this.autoCompoundManager);
      }
      
      const method = req.method;
      const body = method === 'POST' || method === 'PUT' ? await this.parseRequestBody(req) : null;
      const userId = req.headers.authorization ? 'user123' : null;
      
      if (!userId && !path.endsWith('/strategies') && !path.endsWith('/stats')) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }
      
      // Route auto-compound endpoints
      if (path === '/api/defi/compound/strategies' && method === 'GET') {
        const strategies = this.autoCompoundManager.getActiveStrategies();
        res.end(JSON.stringify({ success: true, strategies }));
        
      } else if (path === '/api/defi/compound/deposit' && method === 'POST') {
        const position = await this.autoCompoundManager.deposit({ ...body, userId });
        res.end(JSON.stringify({ success: true, position }));
        
      } else if (path === '/api/defi/compound/withdraw' && method === 'POST') {
        const result = await this.autoCompoundManager.withdraw({ ...body, userId });
        res.end(JSON.stringify({ success: true, ...result }));
        
      } else if (path === '/api/defi/compound/positions' && method === 'GET') {
        const positions = this.autoCompoundManager.getUserPositions(userId);
        res.end(JSON.stringify({ success: true, positions }));
        
      } else if (path.startsWith('/api/defi/compound/position/') && method === 'GET') {
        const positionId = path.split('/').pop();
        const position = this.autoCompoundManager.positions.get(positionId);
        res.end(JSON.stringify({ success: true, position }));
        
      } else if (path === '/api/defi/compound/toggle' && method === 'POST') {
        const { positionId, autoCompound } = body;
        const position = this.autoCompoundManager.positions.get(positionId);
        if (position && position.userId === userId) {
          position.autoCompound = autoCompound;
          res.end(JSON.stringify({ success: true, autoCompound }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Position not found' }));
        }
        
      } else if (path === '/api/defi/compound/stats' && method === 'GET') {
        const stats = this.autoCompoundManager.getStats();
        res.end(JSON.stringify({ success: true, stats }));
        
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Auto-compound endpoint not found' }));
      }
      
    } catch (error) {
      this.logger.error('Auto-compound endpoint error:', error);
      res.statusCode = error.statusCode || 500;
      res.end(JSON.stringify({ 
        error: error.message || 'Internal server error',
        code: 'AUTO_COMPOUND_ERROR'
      }));
    }
  }
  
  /**
   * Handle Leveraged Yield Farming API endpoints
   */
  async handleLeveragedYieldEndpoint(req, res, path) {
    try {
      // Initialize leveraged yield farming if needed
      if (!this.leveragedYieldFarming) {
        const { LeveragedYieldFarming } = await import('./lib/defi/leveraged-yield-farming.js');
        this.leveragedYieldFarming = new LeveragedYieldFarming({
          maxLeverage: 3,
          liquidationThreshold: 0.85,
          baseInterestRate: 0.05
        });
        
        // Create lending pools
        this.leveragedYieldFarming.createLendingPool('USDT');
        this.leveragedYieldFarming.createLendingPool('ETH');
        this.leveragedYieldFarming.createLendingPool('BTC');
        
        // Add liquidity to pools (mock)
        this.leveragedYieldFarming.lendingPools.get('USDT').totalSupplied = 1000000;
        this.leveragedYieldFarming.lendingPools.get('USDT').availableLiquidity = 800000;
        this.leveragedYieldFarming.lendingPools.get('ETH').totalSupplied = 500;
        this.leveragedYieldFarming.lendingPools.get('ETH').availableLiquidity = 400;
        
        // Register yield farms
        this.leveragedYieldFarming.registerFarm({
          farmId: 'usdt-stable-yield',
          name: 'USDT Stable Yield Farm',
          asset: 'USDT',
          rewardToken: 'FARM',
          baseAPY: 0.15, // 15% APY
          protocol: 'Compound'
        });
        
        this.leveragedYieldFarming.registerFarm({
          farmId: 'eth-yield-optimizer',
          name: 'ETH Yield Optimizer',
          asset: 'ETH',
          rewardToken: 'FARM',
          baseAPY: 0.25, // 25% APY
          protocol: 'Yearn'
        });
        
        // Register mock price oracles
        this.leveragedYieldFarming.registerPriceOracle('USDT', {
          getPrice: async () => ({ price: 1, timestamp: Date.now() })
        });
        this.leveragedYieldFarming.registerPriceOracle('ETH', {
          getPrice: async () => ({ price: 3000 + Math.random() * 200, timestamp: Date.now() })
        });
        
        this.services.set('leveragedYieldFarming', this.leveragedYieldFarming);
      }
      
      const method = req.method;
      const body = method === 'POST' || method === 'PUT' ? await this.parseRequestBody(req) : null;
      const userId = req.headers.authorization ? 'user123' : null;
      
      if (!userId && !path.endsWith('/farms') && !path.endsWith('/stats') && !path.endsWith('/pools')) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }
      
      // Route leveraged yield endpoints
      if (path === '/api/defi/leveraged-yield/farms' && method === 'GET') {
        const farms = this.leveragedYieldFarming.getActiveFarms();
        res.end(JSON.stringify({ success: true, farms }));
        
      } else if (path === '/api/defi/leveraged-yield/pools' && method === 'GET') {
        const pools = Array.from(this.leveragedYieldFarming.lendingPools.entries()).map(([asset, pool]) => ({
          asset,
          ...pool,
          utilizationRate: pool.totalSupplied > 0 ? pool.totalBorrowed / pool.totalSupplied : 0,
          borrowAPR: this.leveragedYieldFarming.calculateInterestRate(pool)
        }));
        res.end(JSON.stringify({ success: true, pools }));
        
      } else if (path === '/api/defi/leveraged-yield/open' && method === 'POST') {
        const position = await this.leveragedYieldFarming.openPosition({ ...body, userId });
        res.end(JSON.stringify({ success: true, position }));
        
      } else if (path === '/api/defi/leveraged-yield/close' && method === 'POST') {
        const { positionId } = body;
        const result = await this.leveragedYieldFarming.closePosition(userId, positionId);
        res.end(JSON.stringify({ success: true, ...result }));
        
      } else if (path === '/api/defi/leveraged-yield/adjust' && method === 'POST') {
        const { positionId, newLeverage } = body;
        const position = await this.leveragedYieldFarming.adjustLeverage(userId, positionId, newLeverage);
        res.end(JSON.stringify({ success: true, position }));
        
      } else if (path === '/api/defi/leveraged-yield/harvest' && method === 'POST') {
        const { positionId } = body;
        const position = this.leveragedYieldFarming.positions.get(positionId);
        if (position && position.userId === userId) {
          const result = await this.leveragedYieldFarming.harvestYield(position);
          res.end(JSON.stringify({ success: true, ...result, position }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Position not found' }));
        }
        
      } else if (path === '/api/defi/leveraged-yield/positions' && method === 'GET') {
        const positions = this.leveragedYieldFarming.getUserPositions(userId);
        res.end(JSON.stringify({ success: true, positions }));
        
      } else if (path.startsWith('/api/defi/leveraged-yield/position/') && method === 'GET') {
        const positionId = path.split('/').pop();
        const position = this.leveragedYieldFarming.positions.get(positionId);
        res.end(JSON.stringify({ success: true, position }));
        
      } else if (path === '/api/defi/leveraged-yield/stats' && method === 'GET') {
        const stats = this.leveragedYieldFarming.getStats();
        res.end(JSON.stringify({ success: true, stats }));
        
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Leveraged yield endpoint not found' }));
      }
      
    } catch (error) {
      this.logger.error('Leveraged yield endpoint error:', error);
      res.statusCode = error.statusCode || 500;
      res.end(JSON.stringify({ 
        error: error.message || 'Internal server error',
        code: 'LEVERAGED_YIELD_ERROR'
      }));
    }
  }
  
  /**
   * Handle Persistence API endpoints
   */
  async handlePersistenceEndpoint(req, res, path) {
    try {
      const method = req.method;
      const body = method === 'POST' || method === 'PUT' ? await this.parseRequestBody(req) : null;
      const userId = req.headers.authorization ? 'user123' : null;
      
      if (!userId && !path.endsWith('/status')) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }
      
      const persistenceManager = this.services.get('persistenceManager');
      if (!persistenceManager) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'Persistence service not available' }));
        return;
      }
      
      // Route persistence endpoints
      if (path === '/api/persistence/save' && method === 'POST') {
        const { dataType, data } = body;
        const result = await persistenceManager.saveUserData(userId, dataType, data);
        res.end(JSON.stringify({ success: true, ...result }));
        
      } else if (path === '/api/persistence/load' && method === 'POST') {
        const { dataType } = body;
        const data = await persistenceManager.loadUserData(userId, dataType);
        res.end(JSON.stringify({ success: true, data }));
        
      } else if (path === '/api/persistence/session/create' && method === 'POST') {
        const { connectionData } = body;
        const sessionId = await persistenceManager.createSession(userId, connectionData);
        res.end(JSON.stringify({ success: true, sessionId }));
        
      } else if (path === '/api/persistence/session/resume' && method === 'POST') {
        const { sessionId } = body;
        const session = await persistenceManager.resumeSession(sessionId);
        res.end(JSON.stringify({ success: true, session }));
        
      } else if (path === '/api/persistence/export' && method === 'GET') {
        const userData = await persistenceManager.exportUserData(userId);
        res.end(JSON.stringify({ success: true, userData }));
        
      } else if (path === '/api/persistence/import' && method === 'POST') {
        const { userData } = body;
        await persistenceManager.importUserData(userId, userData);
        res.end(JSON.stringify({ success: true }));
        
      } else if (path === '/api/persistence/snapshot' && method === 'POST') {
        await persistenceManager.createSnapshot();
        res.end(JSON.stringify({ success: true }));
        
      } else if (path === '/api/persistence/backup' && method === 'POST') {
        await persistenceManager.createBackup();
        res.end(JSON.stringify({ success: true }));
        
      } else if (path === '/api/persistence/status' && method === 'GET') {
        const stats = persistenceManager.getStats();
        res.end(JSON.stringify({ success: true, stats }));
        
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Persistence endpoint not found' }));
      }
      
    } catch (error) {
      this.logger.error('Persistence endpoint error:', error);
      res.statusCode = error.statusCode || 500;
      res.end(JSON.stringify({ 
        error: error.message || 'Internal server error',
        code: 'PERSISTENCE_ERROR'
      }));
    }
  }
  
  /**
   * Handle Perpetual Futures API endpoints
   */
  async handlePerpetualFuturesEndpoint(req, res, path) {
    try {
      // Initialize perpetual futures engine if needed
      if (!this.perpetualFuturesEngine) {
        const { PerpetualFuturesEngine } = await import('./lib/derivatives/perpetual-futures.js');
        this.perpetualFuturesEngine = new PerpetualFuturesEngine({
          maxLeverage: 100,
          defaultLeverage: 10,
          fundingInterval: 28800000 // 8 hours
        });
        
        // Create default markets
        this.perpetualFuturesEngine.createMarket({
          symbol: 'BTC-PERP',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          contractSize: 0.001,
          tickSize: 0.1
        });
        
        this.perpetualFuturesEngine.createMarket({
          symbol: 'ETH-PERP',
          baseAsset: 'ETH',
          quoteAsset: 'USDT',
          contractSize: 0.01,
          tickSize: 0.01
        });
        
        this.services.set('perpetualFuturesEngine', this.perpetualFuturesEngine);
      }
      
      const method = req.method;
      const body = method === 'POST' || method === 'PUT' ? await this.parseRequestBody(req) : null;
      const userId = req.headers.authorization ? 'user123' : null;
      
      if (!userId && !path.endsWith('/markets') && !path.endsWith('/stats')) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }
      
      // Add margin to user account for testing
      if (userId && !this.perpetualFuturesEngine.userMargins.has(userId)) {
        this.perpetualFuturesEngine.userMargins.set(userId, {
          total: 10000,
          available: 10000,
          locked: 0,
          unrealizedPnl: 0
        });
      }
      
      // Route perpetual futures endpoints
      if (path === '/api/derivatives/perpetual/markets' && method === 'GET') {
        const markets = Array.from(this.perpetualFuturesEngine.markets.keys()).map(symbol => 
          this.perpetualFuturesEngine.getMarketInfo(symbol)
        );
        res.end(JSON.stringify({ success: true, markets }));
        
      } else if (path === '/api/derivatives/perpetual/open' && method === 'POST') {
        const position = await this.perpetualFuturesEngine.openPosition({ ...body, userId });
        res.end(JSON.stringify({ success: true, position }));
        
      } else if (path === '/api/derivatives/perpetual/close' && method === 'POST') {
        const result = await this.perpetualFuturesEngine.closePosition({ ...body, userId });
        res.end(JSON.stringify({ success: true, ...result }));
        
      } else if (path === '/api/derivatives/perpetual/margin' && method === 'POST') {
        const { positionId, marginDelta } = body;
        const position = await this.perpetualFuturesEngine.adjustMargin(userId, positionId, marginDelta);
        res.end(JSON.stringify({ success: true, position }));
        
      } else if (path === '/api/derivatives/perpetual/positions' && method === 'GET') {
        const positions = this.perpetualFuturesEngine.getUserPositions(userId);
        res.end(JSON.stringify({ success: true, positions }));
        
      } else if (path.startsWith('/api/derivatives/perpetual/position/') && method === 'GET') {
        const positionId = path.split('/').pop();
        const position = this.perpetualFuturesEngine.getPosition(positionId);
        res.end(JSON.stringify({ success: true, position }));
        
      } else if (path === '/api/derivatives/perpetual/stats' && method === 'GET') {
        const stats = this.perpetualFuturesEngine.getStats();
        res.end(JSON.stringify({ success: true, stats }));
        
      } else if (path === '/api/derivatives/perpetual/funding' && method === 'GET') {
        const funding = {};
        for (const [symbol, rate] of this.perpetualFuturesEngine.fundingRates) {
          funding[symbol] = rate;
        }
        res.end(JSON.stringify({ success: true, funding }));
        
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Perpetual futures endpoint not found' }));
      }
      
    } catch (error) {
      this.logger.error('Perpetual futures endpoint error:', error);
      res.statusCode = error.statusCode || 500;
      res.end(JSON.stringify({ 
        error: error.message || 'Internal server error',
        code: 'PERPETUAL_ERROR'
      }));
    }
  }
  
  /**
   * Handle NFT Lending API endpoints
   */
  async handleNFTLendingEndpoint(req, res, path) {
    try {
      // Initialize NFT lending platform if needed
      if (!this.nftLendingPlatform) {
        const { NFTLendingPlatform } = await import('./lib/nft/nft-lending.js');
        this.nftLendingPlatform = new NFTLendingPlatform({
          maxLoanToValue: 0.5,
          baseInterestRate: 0.1,
          liquidationThreshold: 0.8
        });
        
        // Register mock oracle
        this.nftLendingPlatform.registerOracle('mock-oracle', {
          getPrice: async (nftId, collectionId) => ({
            value: 1000 + Math.random() * 9000, // $1k - $10k
            confidence: 0.9
          })
        });
        
        // Register sample collections
        const collections = [
          { id: 'cryptopunks', name: 'CryptoPunks', floorPrice: 50000, verified: true },
          { id: 'bayc', name: 'Bored Ape Yacht Club', floorPrice: 30000, verified: true },
          { id: 'azuki', name: 'Azuki', floorPrice: 10000, verified: true }
        ];
        
        for (const collection of collections) {
          this.nftLendingPlatform.registerCollection(collection.id, collection);
        }
        
        // Create default lending pool
        this.nftLendingPlatform.createLendingPool({
          name: 'Main NFT Pool',
          asset: 'USDT',
          minDeposit: 100,
          collections: ['cryptopunks', 'bayc', 'azuki']
        });
        
        this.services.set('nftLendingPlatform', this.nftLendingPlatform);
      }
      
      const method = req.method;
      const body = method === 'POST' || method === 'PUT' ? await this.parseRequestBody(req) : null;
      const userId = req.headers.authorization ? 'user123' : null;
      
      if (!userId && !path.endsWith('/pools') && !path.endsWith('/stats') && !path.endsWith('/auctions')) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }
      
      // Route NFT lending endpoints
      if (path === '/api/nft/lending/pools' && method === 'GET') {
        const pools = Array.from(this.nftLendingPlatform.lendingPools.values()).map(pool => 
          this.nftLendingPlatform.getPool(pool.id)
        );
        res.end(JSON.stringify({ success: true, pools }));
        
      } else if (path === '/api/nft/lending/deposit' && method === 'POST') {
        const result = await this.nftLendingPlatform.depositToPool({ ...body, userId });
        res.end(JSON.stringify({ success: true, ...result }));
        
      } else if (path === '/api/nft/lending/borrow' && method === 'POST') {
        const loan = await this.nftLendingPlatform.createLoan({ ...body, borrowerId: userId });
        res.end(JSON.stringify({ success: true, loan }));
        
      } else if (path === '/api/nft/lending/repay' && method === 'POST') {
        const result = await this.nftLendingPlatform.makePayment({ ...body, borrowerId: userId });
        res.end(JSON.stringify({ success: true, ...result }));
        
      } else if (path === '/api/nft/lending/loans' && method === 'GET') {
        const loans = this.nftLendingPlatform.getUserLoans(userId);
        res.end(JSON.stringify({ success: true, loans }));
        
      } else if (path.startsWith('/api/nft/lending/loan/') && method === 'GET') {
        const loanId = path.split('/').pop();
        const loan = this.nftLendingPlatform.getLoan(loanId);
        res.end(JSON.stringify({ success: true, loan }));
        
      } else if (path === '/api/nft/lending/auctions' && method === 'GET') {
        const auctions = this.nftLendingPlatform.getActiveAuctions();
        res.end(JSON.stringify({ success: true, auctions }));
        
      } else if (path === '/api/nft/lending/bid' && method === 'POST') {
        const auction = await this.nftLendingPlatform.placeBid({ ...body, bidderId: userId });
        res.end(JSON.stringify({ success: true, auction }));
        
      } else if (path === '/api/nft/lending/stats' && method === 'GET') {
        const stats = this.nftLendingPlatform.getStats();
        res.end(JSON.stringify({ success: true, stats }));
        
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'NFT lending endpoint not found' }));
      }
      
    } catch (error) {
      this.logger.error('NFT lending endpoint error:', error);
      res.statusCode = error.statusCode || 500;
      res.end(JSON.stringify({ 
        error: error.message || 'Internal server error',
        code: 'NFT_LENDING_ERROR'
      }));
    }
  }
  
  /**
   * Handle Bot API endpoints
   */
  async handleBotEndpoint(req, res, path) {
    try {
      // Initialize bot engine if needed
      if (!this.botEngine) {
        const { TradingBotEngine } = await import('./lib/trading/bot-engine.js');
        this.botEngine = new TradingBotEngine({
          maxBotsPerUser: 10,
          tickInterval: 1000,
          maxOrdersPerBot: 50
        });
        
        // Connect services
        this.botEngine.connectServices({
          dexEngine: this.modules.get('dexEngine'),
          pricePredictor: this.pricePredictor
        });
        
        this.services.set('botEngine', this.botEngine);
      }
      
      // Set bot engine in app locals for endpoints
      req.app = { locals: { botEngine: this.botEngine } };
      
      // Import bot routes
      if (!this.botRouter) {
        const botRoutes = await import('./lib/api/bot-endpoints.js');
        this.botRouter = botRoutes.default;
      }
      
      // Create mock Express request/response
      req.path = path.replace('/api/bots', '');
      req.query = Object.fromEntries(new URL(req.url, `http://${req.headers.host}`).searchParams);
      req.params = {};
      
      // Parse body for POST/PUT/DELETE requests
      if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        req.body = await this.parseRequestBody(req);
      }
      
      // Extract params from path
      const pathParts = req.path.split('/').filter(p => p);
      
      // Handle bot ID routes
      if (pathParts.length >= 1 && pathParts[0].match(/^[0-9a-f-]+$/i)) {
        req.params.botId = pathParts[0];
        
        if (pathParts.length === 1) {
          req.path = '/:botId';
        } else if (pathParts[1] === 'start') {
          req.path = '/:botId/start';
        } else if (pathParts[1] === 'stop') {
          req.path = '/:botId/stop';
        } else if (pathParts[1] === 'performance') {
          req.path = '/:botId/performance';
        } else if (pathParts[1] === 'orders') {
          req.path = '/:botId/orders';
        }
      }
      
      // Route through bot router
      const mockNext = (error) => {
        if (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error.message || 'Internal server error' }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Bot endpoint not found' }));
        }
      };
      
      // Find matching route handler
      const method = req.method.toLowerCase();
      const handlers = this.botRouter.stack;
      
      for (const layer of handlers) {
        if (layer.route && layer.route.path === req.path && layer.route.methods[method]) {
          return layer.handle(req, res, mockNext);
        }
      }
      
      mockNext();
      
    } catch (error) {
      this.logger.error('Bot endpoint error:', error);
      res.statusCode = 500;
      res.end(JSON.stringify({ 
        error: error.message || 'Internal server error',
        code: 'BOT_ERROR'
      }));
    }
  }
  
  /**
   * Handle notification endpoint requests
   */
  async handleNotificationEndpoint(req, res, path) {
    try {
      // Initialize push notification service if needed
      if (!this.pushService) {
        const { initializePushNotifications } = await import('./lib/core/push-notification-integration.js');
        this.pushService = await initializePushNotifications(
          { locals: {} }, // Mock app object
          {
            priceMonitor: null, // Would be price monitoring service
            dexEngine: this.modules.get('dexEngine'),
            miningPool: this.modules.get('miningPool'),
            botEngine: this.botEngine,
            authManager: this.authManager
          }
        );
        
        if (!this.pushService) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'Push notification service not available' }));
          return;
        }
        
        this.services.set('pushService', this.pushService);
      }
      
      // Set push service in app locals for endpoints
      req.app = { locals: { pushService: this.pushService } };
      
      // Import notification routes
      if (!this.notificationRouter) {
        const notificationRoutes = await import('./lib/api/notification-endpoints.js');
        this.notificationRouter = notificationRoutes.default;
      }
      
      // Create mock Express request/response
      req.path = path.replace('/api/notifications', '');
      req.query = Object.fromEntries(new URL(req.url, `http://${req.headers.host}`).searchParams);
      req.params = {};
      
      // Parse body for POST/PUT/DELETE requests
      if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        req.body = await this.parseRequestBody(req);
      }
      
      // Extract params from path
      const pathParts = req.path.split('/').filter(p => p);
      
      // Handle device ID routes
      if (pathParts.length === 2 && pathParts[0] === 'device') {
        req.params.deviceId = pathParts[1];
        req.path = '/device/:deviceId';
      }
      
      // Route through notification router
      const mockNext = (error) => {
        if (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error.message || 'Internal server error' }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Notification endpoint not found' }));
        }
      };
      
      // Find matching route handler
      const method = req.method.toLowerCase();
      const handlers = this.notificationRouter.stack;
      
      for (const layer of handlers) {
        if (layer.route && layer.route.path === req.path && layer.route.methods[method]) {
          return layer.handle(req, res, mockNext);
        }
      }
      
      mockNext();
      
    } catch (error) {
      this.logger.error('Notification endpoint error:', error);
      res.statusCode = 500;
      res.end(JSON.stringify({ 
        error: error.message || 'Internal server error',
        code: 'NOTIFICATION_ERROR'
      }));
    }
  }
  
  /**
   * Handle social trading endpoint requests
   */
  async handleSocialEndpoint(req, res, path) {
    try {
      // Initialize social services if needed
      if (!this.socialCore) {
        const { SocialTradingCore } = await import('./lib/social/social-trading-core.js');
        const { FeedManager } = await import('./lib/social/feed-manager.js');
        
        this.socialCore = new SocialTradingCore();
        this.feedManager = new FeedManager();
        
        this.services.set('socialCore', this.socialCore);
        this.services.set('feedManager', this.feedManager);
        
        // Connect to trading services
        if (this.modules.has('dexEngine')) {
          const dexEngine = this.modules.get('dexEngine');
          
          // Listen for trades to handle copy trading
          dexEngine.on('order:filled', async (order) => {
            if (order.userId) {
              await this.socialCore.handleLeaderTrade(order.userId, order);
              await this.socialCore.updateTraderStats(order.userId, {
                profit: order.profit || 0
              });
            }
          });
        }
      }
      
      // Set services in app locals for endpoints
      req.app = { 
        locals: { 
          socialCore: this.socialCore,
          feedManager: this.feedManager
        } 
      };
      
      // Import social routes
      if (!this.socialRouter) {
        const socialRoutes = await import('./lib/api/social-endpoints.js');
        this.socialRouter = socialRoutes.default;
      }
      
      // Create mock Express request/response
      req.path = path.replace('/api/social', '');
      req.query = Object.fromEntries(new URL(req.url, `http://${req.headers.host}`).searchParams);
      req.params = {};
      
      // Parse body for POST/PUT/DELETE requests
      if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        req.body = await this.parseRequestBody(req);
      }
      
      // Extract params from path
      const pathParts = req.path.split('/').filter(p => p);
      
      // Handle trader routes
      if (pathParts.length >= 2 && pathParts[0] === 'traders') {
        req.params.traderId = pathParts[1];
        
        if (pathParts.length === 2) {
          req.path = '/traders/:traderId';
        } else if (pathParts[2] === 'followers') {
          req.path = '/traders/:traderId/followers';
        }
      }
      // Handle follow/copy routes
      else if (pathParts.length === 2) {
        if (['follow', 'copy'].includes(pathParts[0])) {
          req.params.traderId = pathParts[1];
          req.path = `/${pathParts[0]}/:traderId`;
        } else if (pathParts[0] === 'posts') {
          req.params.postId = pathParts[1];
          req.path = '/posts/:postId';
          
          if (pathParts.length === 3) {
            req.path = `/posts/:postId/${pathParts[2]}`;
          }
        }
      }
      
      // Route through social router
      const mockNext = (error) => {
        if (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error.message || 'Internal server error' }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Social endpoint not found' }));
        }
      };
      
      // Find matching route handler
      const method = req.method.toLowerCase();
      const handlers = this.socialRouter.stack;
      
      for (const layer of handlers) {
        if (layer.route && layer.route.path === req.path && layer.route.methods[method]) {
          return layer.handle(req, res, mockNext);
        }
      }
      
      mockNext();
      
    } catch (error) {
      this.logger.error('Social endpoint error:', error);
      res.statusCode = 500;
      res.end(JSON.stringify({ 
        error: error.message || 'Internal server error',
        code: 'SOCIAL_ERROR'
      }));
    }
  }
  
  /**
   * Get stats with caching
   */
  async getStats() {
    const cached = this.cache?.get('stats');
    if (cached) return cached;
    
    const stats = {
      server: {
        version: VERSION,
        uptime: process.uptime(),
        startupTime: this.startTime
      },
      system: {
        cpus: cpus().length,
        totalMemory: totalmem(),
        freeMemory: freemem(),
        platform: process.platform,
        nodeVersion: process.version
      },
      performance: {
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        // Add metrics from new collectors if available
        ...(this.metricsCollector ? {
          httpMetrics: this.metricsCollector.getCurrentMetrics().http,
          cacheMetrics: this.metricsCollector.getCurrentMetrics().cache,
          databaseMetrics: this.metricsCollector.getCurrentMetrics().database
        } : {}),
        // Add memory profiler stats if available
        ...(this.memoryProfiler ? {
          memoryProfile: this.memoryProfiler.getCurrentUsage(),
          leakDetection: this.memoryProfiler.detectLeaks()
        } : {}),
        // Add cache stats if available
        ...(this.multiLayerCache ? {
          cacheStats: this.multiLayerCache.getStats()
        } : {})
      },
      database: {
        connected: !!this.db,
        poolStats: this.dbManager?.getStats()
      },
      services: {
        active: Array.from(this.services.keys()),
        p2p: {
          enabled: !!this.p2pController,
          peers: this.p2pController?.getPeerCount() || 0
        }
      }
    };
    
    // Add module-specific stats if loaded
    if (this.modules.has('miningPool')) {
      const pool = this.modules.get('miningPool');
      stats.mining = await pool.getStats();
    }
    
    if (this.modules.has('dexEngine')) {
      const dex = this.modules.get('dexEngine');
      stats.dex = await dex.getStats();
    }
    
    this.cache?.set('stats', stats, 5000); // Cache for 5 seconds
    return stats;
  }

  /**
   * Start the server
   */
  async start() {
    if (this.isRunning) return;
    
    try {
      await this.initialize();
      
      // Start HTTP server
      await new Promise((resolve, reject) => {
        this.server.on('error', reject);
        this.server.listen(config.apiPort, '0.0.0.0', () => {
          this.logger.info(`HTTP API server listening on port ${config.apiPort}`);
          resolve();
        });
      });
      
      // Setup WebSocket servers with P2P integration
      setTimeout(() => this.setupWebSocketServers(), 100);
      
      // Setup monitoring (lazy)
      setTimeout(() => this.setupMonitoring(), 500);
      
      // Setup scheduled tasks (lazy)
      setTimeout(() => this.setupScheduledTasks(), 1000);
      
      this.isRunning = true;
      
      const totalStartupTime = Date.now() - this.startTime;
      this.logger.info(`Otedama started in ${totalStartupTime}ms`);
      
      // Log memory usage
      const mem = process.memoryUsage();
      this.logger.info(`Memory usage: RSS=${Math.round(mem.rss / 1024 / 1024)}MB, Heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB`);
      
    } catch (error) {
      console.error('Failed to start:', error);
      process.exit(1);
    }
  }

  /**
   * Setup dashboard system
   */
  async setupDashboard() {
    try {
      const { RealtimeDashboard } = await lazyLoad('./lib/dashboard/realtime-dashboard.js');
      
      this.dashboard = new RealtimeDashboard({
        db: this.dbManager,
        cache: this.cache,
        wsManager: this.services.get('websocketManager')
      });
      
      await this.dashboard.start();
      this.services.set('dashboard', this.dashboard);
      
      this.logger.info('Dashboard system initialized');
      
      // Add dashboard alerts for critical events
      this.performanceMonitor?.on('alert', (alert) => {
        this.dashboard.addAlert(alert.level === 'critical' ? 'critical' : 'warning', 
          `Performance alert: ${alert.metric}`, alert);
      });
      
      this.errorHandler?.on('unrecoverable', (error) => {
        this.dashboard.addAlert('critical', 'Unrecoverable error detected', { error: error.message });
      });
      
    } catch (error) {
      this.logger.warn('Dashboard system failed to initialize:', error);
    }
  }
  
  /**
   * Handle dashboard API requests
   */
  async handleDashboardRequest(req, res) {
    if (!this.dashboard) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'Dashboard not available' }));
      return;
    }
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    const channels = url.searchParams.get('channels')?.split(',') || ['all'];
    
    const metrics = this.dashboard.getCurrentMetrics(channels);
    
    res.end(JSON.stringify({
      timestamp: Date.now(),
      metrics
    }));
  }
  
  /**
   * Serve dashboard HTML
   */
  async serveDashboard(req, res) {
    try {
      const fs = await import('fs/promises');
      const dashboardPath = resolve(__dirname, 'public', 'dashboard.html');
      const html = await fs.readFile(dashboardPath, 'utf-8');
      
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
    } catch (error) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Dashboard not found' }));
    }
  }

  /**
   * Setup WebSocket servers with P2P integration
   */
  async setupWebSocketServers() {
    await safeExecute(async () => {
      try {
        // Setup realtime servers with P2P integration
        this.realtimeServers = setupRealtimeServers(
          {
            miningPort: config.wsPort,
            dexPort: config.dexWsPort
          },
          this.p2pController?.workDistributor // Attach SmartWorkDistributor if P2P is enabled
        );
        
        // Setup data sync WebSocket server for persistence
        if (this.persistenceManager) {
          const { DataSyncServer } = await import('./lib/core/websocket-manager.js');
          this.dataSyncServer = new DataSyncServer({
            port: config.dataSyncWsPort || 8083,
            persistenceManager: this.persistenceManager,
            enableAuth: true,
            jwtSecret: config.jwtSecret
          });
          
          await this.dataSyncServer.start();
          this.logger.info('Data sync WebSocket server started', { port: config.dataSyncWsPort || 8083 });
          this.services.set('dataSyncServer', this.dataSyncServer);
        }
        
        // Wait for servers to be ready
        await new Promise((resolve) => setTimeout(resolve, 1000));
        
        this.services.set('realtimeServers', this.realtimeServers);
        this.logger.info(`WebSocket servers started - Mining: ${config.wsPort}, DEX: ${config.dexWsPort}`);
        
        // Register WebSocket service with CPU affinity
        if (this.cpuAffinityManager) {
          this.cpuAffinityManager.registerProcess(process.pid, 'websocket');
        }
        
        // Monitor WebSocket health
        setInterval(() => {
          const miningClients = this.realtimeServers?.miningServer?.clients?.size || 0;
          const dexClients = this.realtimeServers?.dexServer?.clients?.size || 0;
          
          if (this.performanceMonitor) {
            this.performanceMonitor.recordMetric('websocket.mining.clients', miningClients);
            this.performanceMonitor.recordMetric('websocket.dex.clients', dexClients);
          }
          
          // Record in new metrics collector too
          if (this.metricsCollector) {
            this.metricsCollector.recordWebSocketMetrics({
              miningClients,
              dexClients,
              totalClients: miningClients + dexClients
            });
          }
        }, 30000); // Every 30 seconds
        
        // Metrics WebSocket is now integrated into the monitoring system
        if (this.monitoringManager && this.realtimeServers?.miningServer) {
          // WebSocket metrics are handled by the consolidated monitoring
          // The monitoring system provides real-time updates via its subscribe method
          this.logger.info('Real-time metrics available through consolidated monitoring');
        }
        
      } catch (error) {
        this.logger.error('Failed to setup WebSocket servers:', error);
        
        // Fallback: create basic WebSocket server
        const { WebSocketServer } = await import('ws');
        const wss = new WebSocketServer({ 
          port: config.wsPort,
          perMessageDeflate: {
            zlibDeflateOptions: {
              level: 1 // Fastest compression
            },
            threshold: 1024 // Only compress messages > 1KB
          },
          maxPayload: 10 * 1024 * 1024, // 10MB
          clientTracking: true,
          backlog: 500 // Max pending connections
        });
        
        // Setup connection handling
        wss.on('connection', (ws, req) => {
          const clientId = crypto.randomUUID();
          const clientInfo = {
            id: clientId,
            ip: req.socket.remoteAddress,
            connectedAt: Date.now(),
            userAgent: req.headers['user-agent']
          };
          
          // Attach client info
          ws.clientInfo = clientInfo;
          
          // Setup heartbeat
          ws.isAlive = true;
          ws.on('pong', () => { ws.isAlive = true; });
          
          // Handle messages
          ws.on('message', async (message) => {
            await this.handleWebSocketMessage(ws, message);
          });
          
          // Handle errors
          ws.on('error', (error) => {
            this.logger.error(`WebSocket client error [${clientId}]:`, error);
          });
          
          // Handle close
          ws.on('close', (code, reason) => {
            this.logger.debug(`WebSocket client disconnected [${clientId}]:`, { code, reason });
          });
          
          // Send welcome message
          ws.send(JSON.stringify({
            type: 'welcome',
            version: VERSION,
            clientId,
            timestamp: Date.now()
          }));
        });
        
        // Setup heartbeat interval
        const heartbeatInterval = setInterval(() => {
          wss.clients.forEach((ws) => {
            if (ws.isAlive === false) {
              return ws.terminate();
            }
            ws.isAlive = false;
            ws.ping();
          });
        }, 30000); // 30 seconds
        
        // Store cleanup function
        wss.cleanupInterval = heartbeatInterval;
        
        this.services.set('websocket', wss);
        this.logger.info(`Fallback WebSocket server listening on port ${config.wsPort}`);
      }
    }, {
      service: 'websocket-setup',
      maxRetries: 3,
      fallback: () => {
        this.logger.warn('WebSocket servers unavailable, API-only mode');
      }
    });
  }

  /**
   * Handle WebSocket messages
   */
  async handleWebSocketMessage(ws, message) {
    const clientInfo = ws.clientInfo || { id: 'unknown' };
    
    await safeExecute(async () => {
      let data;
      try {
        data = JSON.parse(message.toString());
      } catch (error) {
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Invalid JSON',
          timestamp: Date.now()
        }));
        return;
      }
      
      // Validate message
      if (!data.type) {
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Missing message type',
          timestamp: Date.now()
        }));
        return;
      }
      
      // Route based on message type
      switch (data.type) {
        case 'ping':
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: Date.now()
          }));
          break;
          
        case 'subscribe':
          await this.handleSubscription(ws, data);
          break;
          
        case 'unsubscribe':
          await this.handleUnsubscription(ws, data);
          break;
          
        case 'mining':
          const pool = await this.getMiningPool();
          await pool.handleWebSocketMessage(ws, data);
          break;
          
        case 'dex':
          const dex = await this.getDEXEngine();
          await dex.handleWebSocketMessage(ws, data);
          break;
          
        case 'auth':
          await this.handleWebSocketAuth(ws, data);
          break;
          
        default:
          ws.send(JSON.stringify({
            type: 'error',
            error: `Unknown message type: ${data.type}`,
            timestamp: Date.now()
          }));
      }
    }, {
      service: 'websocket-message',
      context: clientInfo,
      fallback: () => {
        try {
          ws.send(JSON.stringify({ 
            type: 'error',
            error: 'Internal error processing message',
            timestamp: Date.now()
          }));
        } catch (error) {
          // Client might be disconnected
          this.logger.debug('Failed to send error to client:', error);
        }
      }
    });
  }
  
  /**
   * Handle WebSocket subscriptions
   */
  async handleSubscription(ws, data) {
    const { channels = [] } = data;
    
    if (!ws.subscriptions) {
      ws.subscriptions = new Set();
    }
    
    channels.forEach(channel => {
      ws.subscriptions.add(channel);
    });
    
    ws.send(JSON.stringify({
      type: 'subscribed',
      channels,
      timestamp: Date.now()
    }));
  }
  
  /**
   * Handle WebSocket unsubscriptions
   */
  async handleUnsubscription(ws, data) {
    const { channels = [] } = data;
    
    if (ws.subscriptions) {
      channels.forEach(channel => {
        ws.subscriptions.delete(channel);
      });
    }
    
    ws.send(JSON.stringify({
      type: 'unsubscribed',
      channels,
      timestamp: Date.now()
    }));
  }

  /**
   * Handle WebSocket authentication
   */
  async handleWebSocketAuth(ws, data) {
    const { token } = data;
    
    if (!token) {
      ws.send(JSON.stringify({
        type: 'auth_error',
        error: 'Token required',
        timestamp: Date.now()
      }));
      return;
    }
    
    try {
      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET || this.authManager.config.jwtSecret);
      
      // Store auth info on the WebSocket connection
      ws.isAuthenticated = true;
      ws.userId = decoded.id;
      ws.userRole = decoded.role;
      ws.authTime = Date.now();
      
      // Send success response
      ws.send(JSON.stringify({
        type: 'auth_success',
        userId: decoded.id,
        role: decoded.role,
        timestamp: Date.now()
      }));
      
      this.logger.info(`WebSocket authenticated for user ${decoded.id}`);
      
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'auth_error',
        error: error.message === 'jwt expired' ? 'Token expired' : 'Invalid token',
        timestamp: Date.now()
      }));
      
      // Optionally close connection on auth failure
      if (this.config.wsRequireAuth) {
        ws.close(1008, 'Authentication failed');
      }
    }
  }

  /**
   * Setup monitoring (lazy loaded)
   */
  async setupMonitoring() {
    // Monitoring is now started in initialize()
    // This method is kept for compatibility
    this.logger.info('Monitoring system already initialized');
  }

  /**
   * Setup scheduled tasks
   */
  async setupScheduledTasks() {
    // Setup automated backup scheduling
    await this.setupBackupScheduler();
    
    // Setup webhook system
    await this.setupWebhookSystem();
    
    // Cleanup old data every hour
    setInterval(() => this.cleanupOldData(), 3600000);
    
    // Update cache stats every minute
    setInterval(() => this.updateCacheStats(), 60000);
    
    // Garbage collection hint every 30 minutes
    setInterval(() => {
      if (global.gc) {
        global.gc();
        this.logger.debug('Manual garbage collection triggered');
      }
    }, 1800000);
  }

  /**
   * Cleanup old data with configurable retention
   */
  async cleanupOldData() {
    await safeExecute(async () => {
      const retention = {
        mining_sessions: 30, // 30 days
        transactions: 90,    // 90 days
        audit_log: 365,      // 1 year
        system_metrics: 7,   // 7 days
        orders: 30           // 30 days for completed orders
      };
      
      const results = {};
      
      // Cleanup each table with its retention policy
      for (const [table, days] of Object.entries(retention)) {
        try {
          const cutoff = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();
          let query;
          
          switch (table) {
            case 'mining_sessions':
              query = 'DELETE FROM mining_sessions WHERE end_time < ? AND end_time IS NOT NULL';
              break;
            case 'transactions':
              query = 'DELETE FROM transactions WHERE created_at < ? AND status IN (?, ?)';
              results[table] = this.db.prepare(query).run(cutoff, 'completed', 'failed').changes;
              break;
            case 'orders':
              query = 'DELETE FROM orders WHERE created_at < ? AND status IN (?, ?, ?)';
              results[table] = this.db.prepare(query).run(cutoff, 'filled', 'cancelled', 'expired').changes;
              break;
            default:
              query = `DELETE FROM ${table} WHERE created_at < ?`;
              results[table] = this.db.prepare(query).run(cutoff).changes;
          }
        } catch (error) {
          this.logger.debug(`Cleanup error for ${table}:`, error.message);
          results[table] = 0;
        }
      }
      
      // Vacuum database to reclaim space (only in production)
      if (config.environment === 'production') {
        try {
          this.db.exec('VACUUM');
          this.logger.info('Database vacuumed successfully');
        } catch (error) {
          this.logger.warn('Database vacuum failed:', error.message);
        }
      }
      
      // Log cleanup results
      const totalDeleted = Object.values(results).reduce((sum, count) => sum + count, 0);
      if (totalDeleted > 0) {
        this.logger.info('Data cleanup completed:', { ...results, total: totalDeleted });
      }
      
    }, {
      service: 'cleanup',
      category: ErrorCategory.DATABASE,
      maxRetries: 1,
      fallback: () => {
        this.logger.warn('Data cleanup failed, will retry in next cycle');
      }
    });
  }

  /**
   * Update cache statistics
   */
  updateCacheStats() {
    const stats = this.cache.getStats();
    this.logger.debug('Cache stats:', stats);
  }

  /**
   * Handle HTTP requests
   */
  async handleRequest(req, res) {
    const startTime = Date.now();
    
    try {
      // Apply security middleware
      const securityMiddleware = new SecurityMiddleware({
        cors: { enabled: true, origin: '*' },
        rateLimit: { enabled: true, max: 100, windowMs: 60000 }
      });
      
      if (!securityMiddleware.apply(req, res)) {
        return; // Request was blocked by security middleware
      }
      
      // Parse URL and method
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;
      const method = req.method;
      
      // Route handling
      if (method === 'GET' && path === '/api/prices') {
        await this.handlePricesRequest(req, res);
      } else if (method === 'GET' && path === '/api/health') {
        await this.handleHealthRequest(req, res);
      } else if (method === 'GET' && path === '/api/status') {
        await this.handleStatusRequest(req, res);
      } else if (method === 'GET' && path === '/') {
        await this.handleRootRequest(req, res);
      } else if ((method === 'GET' || method === 'POST') && path === '/graphql') {
        await this.handleGraphQLRequest(req, res);
      } else if (path.startsWith('/api/webhooks')) {
        await this.handleWebhookRequest(req, res, method, path);
      } else if (method === 'POST' && path === '/api/batch') {
        await this.handleBatchRequest(req, res);
      } else {
        // 404 Not Found
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Not Found', path }));
      }
      
      // Log request
      const duration = Date.now() - startTime;
      this.logger.info(`${method} ${path} - ${res.statusCode} (${duration}ms)`);
      
    } catch (error) {
      this.logger.error('Request handling error:', error);
      
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    }
  }
  
  /**
   * Handle /api/prices endpoint with caching and fallback
   */
  async handlePricesRequest(req, res) {
    try {
      // Check cache first
      const cached = this.cache?.get('prices');
      if (cached) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, max-age=30');
        res.setHeader('X-Cache', 'HIT');
        res.end(JSON.stringify({
          success: true,
          data: cached,
          cached: true,
          timestamp: Date.now()
        }));
        return;
      }
      
      // Load price feed service if not already loaded
      if (!this.services.has('priceFeed')) {
        const { PriceFeedService } = await import('./services/price-feed.js');
        const priceFeed = new PriceFeedService({
          logger: this.logger,
          cache: this.cache,
          timeout: 5000,
          retries: 3
        });
        this.services.set('priceFeed', priceFeed);
      }
      
      const priceFeed = this.services.get('priceFeed');
      const prices = await priceFeed.getPrices();
      
      // Cache the prices
      this.cache?.set('prices', prices, 30000); // 30 seconds
      
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=30');
      res.setHeader('X-Cache', 'MISS');
      res.end(JSON.stringify({
        success: true,
        data: prices,
        cached: false,
        timestamp: Date.now()
      }));
      
    } catch (error) {
      this.logger.error('Price feed error:', error);
      
      // Try to return stale cache if available
      const stale = this.cache?.get('prices', true); // Get even if expired
      if (stale) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, max-age=10');
        res.setHeader('X-Cache', 'STALE');
        res.end(JSON.stringify({
          success: true,
          data: stale,
          stale: true,
          timestamp: Date.now()
        }));
      } else {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          success: false,
          error: 'Price service temporarily unavailable',
          timestamp: Date.now()
        }));
      }
    }
  }
  
  /**
   * Handle health check endpoints
   */
  async handleHealthRequest(req, res, path) {
    try {
      // Initialize health check if not done
      if (!this.healthCheck) {
        this.healthCheck = new HealthCheck();
        
        // Register component checks
        this.healthCheck.registerComponentChecks({
          database: this.db,
          cache: this.services.get('cache'),
          p2p: this.p2pController,
          websocket: this.realtimeServers,
          mining: this.services.get('miningPool'),
          dex: this.services.get('dexEngine')
        });
      }
      
      // Route to specific health check
      if (path === '/health') {
        // Main health check
        const result = await this.healthCheck.checkHealth();
        
        // Set status code based on health
        if (result.status === 'unhealthy') {
          res.statusCode = 503;
        } else if (result.status === 'degraded') {
          res.statusCode = 200;
        } else {
          res.statusCode = 200;
        }
        
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
        
      } else if (path === '/health/database') {
        const result = await this.healthCheck.runCheck('database', 
          this.healthCheck.checks.get('database'));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
        
      } else if (path === '/health/cache') {
        const result = await this.healthCheck.runCheck('cache', 
          this.healthCheck.checks.get('cache'));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
        
      } else if (path === '/health/p2p') {
        const result = await this.healthCheck.runCheck('p2p', 
          this.healthCheck.checks.get('p2p'));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
        
      } else if (path === '/health/services') {
        // Check all services
        const services = {};
        for (const [name, check] of this.healthCheck.checks) {
          if (['database', 'cache', 'p2p'].includes(name)) continue;
          const result = await this.healthCheck.runCheck(name, check);
          services[name] = result;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ services }));
        
      } else if (path === '/ready') {
        // Readiness check - critical services only
        const criticalChecks = ['database', 'cache'];
        const results = {};
        let allHealthy = true;
        
        for (const checkName of criticalChecks) {
          const check = this.healthCheck.checks.get(checkName);
          if (check) {
            const result = await this.healthCheck.runCheck(checkName, check);
            results[checkName] = result;
            if (result.status !== 'pass') {
              allHealthy = false;
            }
          }
        }
        
        res.statusCode = allHealthy ? 200 : 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          ready: allHealthy,
          timestamp: new Date().toISOString(),
          checks: results
        }));
        
      } else if (path === '/live') {
        // Liveness check - simple response
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          alive: true,
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          pid: process.pid
        }));
        
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Health check endpoint not found' }));
      }
      
    } catch (error) {
      this.logger.error('Health check error:', error);
      
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        status: 'unhealthy',
        error: error.message,
        timestamp: Date.now()
      }));
    }
  }
  
  /**
   * Handle /api/status endpoint
   */
  async handleStatusRequest(req, res) {
    try {
      const status = {
        application: 'Otedama',
        version: VERSION,
        environment: process.env.NODE_ENV || 'development',
        uptime: Date.now() - this.startTime,
        database: {
          connected: !!this.db,
          optimizer: !!this.dbOptimizer
        },
        services: Array.from(this.services.keys()),
        performance: this.performanceMonitor ? this.performanceMonitor.getMetrics() : null,
        timestamp: Date.now()
      };
      
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(status));
      
    } catch (error) {
      this.logger.error('Status check error:', error);
      
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: error.message,
        timestamp: Date.now()
      }));
    }
  }
  
  /**
   * Handle root endpoint
   */
  async handleRootRequest(req, res) {
    const welcome = {
      message: 'Welcome to Otedama API',
      version: VERSION,
      endpoints: {
        prices: '/api/prices',
        health: '/api/health',
        status: '/api/status',
        graphql: '/graphql'
      },
      timestamp: Date.now()
    };
    
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(welcome));
  }

  /**
   * Handle GraphQL requests
   */
  async handleGraphQLRequest(req, res) {
    try {
      if (!this.graphqlHandler) {
        // Lazy load GraphQL handler
        const { graphqlHTTP } = await import('express-graphql');
        const { schema } = await import('./lib/api/graphql-schema.js');
        
        this.graphqlHandler = graphqlHTTP({
          schema,
          graphiql: process.env.NODE_ENV === 'development',
          context: {
            user: req.user,
            healthCheck: this.healthCheck,
            priceFeed: this.services.get('priceFeed'),
            miningPool: this.services.get('miningPool'),
            dexEngine: this.services.get('dexEngine'),
            authManager: this.authManager
          },
          customFormatErrorFn: (error) => {
            this.logger.error('GraphQL error:', error);
            return {
              message: error.message,
              locations: error.locations,
              path: error.path,
              extensions: {
                code: error.originalError?.code || 'INTERNAL_ERROR',
                timestamp: new Date().toISOString()
              }
            };
          }
        });
      }
      
      // GraphQL handler expects Express req/res, so we need to adapt
      await this.graphqlHandler(req, res);
    } catch (error) {
      this.logger.error('GraphQL handler error:', error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'GraphQL service unavailable' }));
    }
  }

  /**
   * Handle webhook API requests
   */
  async handleWebhookRequest(req, res, method, path) {
    try {
      if (!this.webhookManager) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'Webhook service not available' }));
        return;
      }

      // Check authentication
      if (!req.user && !req.apiKey) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }

      const webhookPath = path.replace('/api/webhooks', '');

      if (method === 'GET' && webhookPath === '') {
        // List webhooks
        const webhooks = await this.webhookManager.listWebhooks({
          userId: req.user?.id || req.apiKey?.userId
        });
        res.end(JSON.stringify({ webhooks }));
        
      } else if (method === 'POST' && webhookPath === '') {
        // Create webhook
        const body = await this.parseRequestBody(req);
        const webhook = await this.webhookManager.createWebhook({
          userId: req.user?.id || req.apiKey?.userId,
          url: body.url,
          events: body.events,
          secret: body.secret,
          active: body.active !== false
        });
        res.statusCode = 201;
        res.end(JSON.stringify({ webhook }));
        
      } else if (method === 'GET' && webhookPath.match(/^\/[\w-]+$/)) {
        // Get webhook by ID
        const webhookId = webhookPath.substring(1);
        const webhook = await this.webhookManager.getWebhook(webhookId);
        
        if (!webhook) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Webhook not found' }));
          return;
        }
        
        // Check ownership
        if (webhook.userId !== (req.user?.id || req.apiKey?.userId)) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'Access denied' }));
          return;
        }
        
        res.end(JSON.stringify({ webhook }));
        
      } else if (method === 'PUT' && webhookPath.match(/^\/[\w-]+$/)) {
        // Update webhook
        const webhookId = webhookPath.substring(1);
        const body = await this.parseRequestBody(req);
        
        const webhook = await this.webhookManager.updateWebhook(webhookId, {
          userId: req.user?.id || req.apiKey?.userId,
          ...body
        });
        
        if (!webhook) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Webhook not found' }));
          return;
        }
        
        res.end(JSON.stringify({ webhook }));
        
      } else if (method === 'DELETE' && webhookPath.match(/^\/[\w-]+$/)) {
        // Delete webhook
        const webhookId = webhookPath.substring(1);
        const deleted = await this.webhookManager.deleteWebhook(webhookId, {
          userId: req.user?.id || req.apiKey?.userId
        });
        
        if (!deleted) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Webhook not found' }));
          return;
        }
        
        res.statusCode = 204;
        res.end();
        
      } else if (method === 'POST' && webhookPath.match(/^\/[\w-]+\/test$/)) {
        // Test webhook
        const webhookId = webhookPath.match(/^\/([\w-]+)\/test$/)[1];
        const result = await this.webhookManager.testWebhook(webhookId, {
          userId: req.user?.id || req.apiKey?.userId
        });
        
        res.end(JSON.stringify({ result }));
        
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Webhook endpoint not found' }));
      }
      
    } catch (error) {
      this.logger.error('Webhook API error:', error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  /**
   * Handle batch API requests
   */
  async handleBatchRequest(req, res) {
    try {
      // Check authentication
      if (!req.user && !req.apiKey) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }

      // Parse request body
      const body = await this.parseRequestBody(req);

      // Initialize batch handler if needed
      if (!this.batchHandler) {
        const { BatchOperationHandler } = await import('./lib/api/batch-operations.js');
        this.batchHandler = new BatchOperationHandler({
          maxBatchSize: 100,
          maxParallel: 10,
          timeout: 30000,
          services: {
            priceFeed: this.services.get('priceFeed'),
            miningPool: this.services.get('miningPool'),
            dexEngine: this.services.get('dexEngine'),
            webhookManager: this.webhookManager
          }
        });
      }

      // Process batch
      const result = await this.batchHandler.processBatch(body.operations || body, {
        user: req.user,
        apiKey: req.apiKey
      });

      res.statusCode = 200;
      res.end(JSON.stringify(result));

    } catch (error) {
      this.logger.error('Batch operation error:', error);
      
      if (error.category === 'VALIDATION') {
        res.statusCode = 400;
        res.end(JSON.stringify({ 
          error: error.message,
          code: 'VALIDATION_ERROR'
        }));
      } else {
        res.statusCode = 500;
        res.end(JSON.stringify({ 
          error: 'Batch operation failed',
          code: 'INTERNAL_ERROR'
        }));
      }
    }
  }

  /**
   * Parse request body
   */
  async parseRequestBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Handle backup status request
   */
  async handleBackupStatus(req, res) {
    try {
      const backupManager = this.services.get('backupManager');
      
      if (!backupManager) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'Backup service not available' }));
        return;
      }
      
      const stats = backupManager.getStats();
      
      res.end(JSON.stringify({
        ...stats,
        timestamp: Date.now()
      }));
    } catch (error) {
      this.logger.error('Backup status error:', error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Failed to get backup status' }));
    }
  }

  /**
   * Handle backup list request
   */
  async handleBackupList(req, res) {
    try {
      const backupManager = this.services.get('backupManager');
      
      if (!backupManager) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'Backup service not available' }));
        return;
      }
      
      const url = new URL(req.url, `http://${req.headers.host}`);
      const options = {
        type: url.searchParams.get('type'),
        startDate: url.searchParams.get('startDate'),
        endDate: url.searchParams.get('endDate'),
        limit: parseInt(url.searchParams.get('limit')) || 20
      };
      
      const backups = backupManager.listBackups(options);
      
      res.end(JSON.stringify({
        backups,
        count: backups.length,
        timestamp: Date.now()
      }));
    } catch (error) {
      this.logger.error('Backup list error:', error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Failed to list backups' }));
    }
  }

  /**
   * Handle backup trigger request
   */
  async handleBackupTrigger(req, res) {
    try {
      const backupManager = this.services.get('backupManager');
      
      if (!backupManager) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'Backup service not available' }));
        return;
      }
      
      // Parse request body
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const metadata = body ? JSON.parse(body) : {};
          
          const result = await backupManager.forceBackup({
            ...metadata,
            triggeredBy: 'api',
            timestamp: new Date().toISOString()
          });
          
          res.end(JSON.stringify({
            success: true,
            message: 'Backup triggered successfully',
            result,
            timestamp: Date.now()
          }));
        } catch (error) {
          this.logger.error('Backup trigger error:', error);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error.message }));
        }
      });
    } catch (error) {
      this.logger.error('Backup trigger error:', error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Failed to trigger backup' }));
    }
  }

  /**
   * Handle backup schedule update request
   */
  /**
   * Handle alert management endpoints
   */
  async handleAlertEndpoints(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    
    if (req.method === 'GET' && path === '/api/alerts') {
      // Get alert rules
      const rules = this.alertManager.alertSystem.getRules();
      res.end(JSON.stringify({ rules }));
    } else if (req.method === 'GET' && path === '/api/alerts/active') {
      // Get active alerts
      const activeAlerts = this.alertManager.alertSystem.getActiveAlerts();
      res.end(JSON.stringify({ alerts: activeAlerts }));
    } else if (req.method === 'GET' && path === '/api/alerts/history') {
      // Get alert history
      const history = this.alertManager.alertSystem.getAlertHistory(100);
      res.end(JSON.stringify({ history }));
    } else if (req.method === 'GET' && path === '/api/alerts/metrics') {
      // Get real-time alert metrics
      const metrics = this.alertManager.getRealTimeMetrics();
      res.end(JSON.stringify(metrics));
    } else if (req.method === 'POST' && path === '/api/alerts/rules') {
      // Create custom alert rule
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const ruleConfig = JSON.parse(body);
          const ruleId = await this.alertManager.createCustomRule(ruleConfig);
          res.end(JSON.stringify({ success: true, ruleId }));
        } catch (error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: error.message }));
        }
      });
    } else if (req.method === 'DELETE' && path.startsWith('/api/alerts/rules/')) {
      // Delete alert rule
      const ruleId = path.split('/').pop();
      try {
        this.alertManager.alertSystem.removeRule(ruleId);
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Rule not found' }));
      }
    } else if (req.method === 'POST' && path === '/api/alerts/test') {
      // Trigger test alert
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const alertConfig = JSON.parse(body);
          const alertId = await this.alertManager.alertSystem.triggerManualAlert(alertConfig);
          res.end(JSON.stringify({ success: true, alertId }));
        } catch (error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: error.message }));
        }
      });
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Alert endpoint not found' }));
    }
  }

  async handleBackupScheduleUpdate(req, res) {
    try {
      const backupManager = this.services.get('backupManager');
      
      if (!backupManager) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'Backup service not available' }));
        return;
      }
      
      // Parse request body
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { name, schedule } = JSON.parse(body);
          
          if (!name || !schedule) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Missing required fields: name, schedule' }));
            return;
          }
          
          backupManager.updateSchedule(name, schedule);
          
          res.end(JSON.stringify({
            success: true,
            message: 'Schedule updated successfully',
            name,
            schedule,
            timestamp: Date.now()
          }));
        } catch (error) {
          this.logger.error('Schedule update error:', error);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error.message }));
        }
      });
    } catch (error) {
      this.logger.error('Schedule update error:', error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Failed to update schedule' }));
    }
  }

  /**
   * Setup automated backup scheduler
   */
  async setupBackupScheduler() {
    await safeExecute(async () => {
      const { UnifiedBackupManager, BackupStrategy } = await lazyLoad('./lib/backup/unified-backup-manager.js');
      
      // Initialize unified backup manager
      const backupManager = new UnifiedBackupManager(config.dbPath, {
        backupDir: resolve(__dirname, 'backups'),
        strategy: BackupStrategy.ADAPTIVE,
        enableScheduled: true,
        schedules: {
          hourly: '0 * * * *',
          daily: '0 2 * * *',
          weekly: '0 3 * * 0',
          monthly: '0 4 1 * *'
        },
        retention: {
          hourly: 24,
          daily: 7,
          weekly: 4,
          monthly: 12,
          manual: 10
        },
        adaptive: {
          minInterval: 60 * 60 * 1000,      // 1 hour
          maxInterval: 24 * 60 * 60 * 1000, // 24 hours
          activityThreshold: 1000,
          sizeThreshold: 100 * 1024 * 1024  // 100MB
        },
        resources: {
          maxCpuPercent: 50,
          maxMemoryMB: 500,
          pauseOnHighLoad: true
        }
      });
      
      await backupManager.initialize();
      this.services.set('backupManager', backupManager);
      
      // For compatibility, also set as backupScheduler
      this.services.set('backupScheduler', backupManager);
      
      // Listen for backup events
      backupManager.on('backup:completed', (event) => {
        this.logger.info('Backup completed:', event);
      });
      
      backupManager.on('backup:failed', (event) => {
        this.logger.error('Backup failed:', event);
      });
      
      this.logger.info('Automated backup scheduler initialized');
      
    }, {
      service: 'backup-scheduler-setup',
      fallback: () => {
        this.logger.warn('Backup scheduler failed to initialize, continuing without automated backups');
      }
    });
  }

  /**
   * Setup webhook system
   */
  async setupWebhookSystem() {
    await safeExecute(async () => {
      const { WebhookManager } = await lazyLoad('./lib/webhooks.js');
      
      this.webhookManager = new WebhookManager(this.db, {
        logger: this.logger,
        maxRetries: 3,
        retryDelay: 1000,
        timeout: 30000,
        maxConcurrent: 10
      });
      
      // Register webhook event handlers for various system events
      if (this.services.has('miningPool')) {
        const miningPool = this.services.get('miningPool');
        
        miningPool.on('block:found', (data) => {
          this.webhookManager.triggerWebhooks('block.found', data);
        });
        
        miningPool.on('share:accepted', (data) => {
          this.webhookManager.triggerWebhooks('share.accepted', data);
        });
        
        miningPool.on('payout:completed', (data) => {
          this.webhookManager.triggerWebhooks('payout.completed', data);
        });
      }
      
      if (this.services.has('dexEngine')) {
        const dexEngine = this.services.get('dexEngine');
        
        dexEngine.on('swap:executed', (data) => {
          this.webhookManager.triggerWebhooks('swap.executed', data);
        });
        
        dexEngine.on('liquidity:added', (data) => {
          this.webhookManager.triggerWebhooks('liquidity.added', data);
        });
      }
      
      // System events
      this.webhookManager.triggerWebhooks('system.started', {
        version: VERSION,
        environment: process.env.NODE_ENV,
        timestamp: new Date().toISOString()
      });
      
      this.services.set('webhookManager', this.webhookManager);
      this.logger.info('Webhook system initialized');
      
    }, {
      service: 'webhook-system',
      fallback: () => {
        this.logger.warn('Webhook system failed to initialize, continuing without webhooks');
      }
    });
  }

  /**
   * Start the application
   */
  async start() {
    try {
      // Run preflight checks
      await this.runPreflightChecks();
      
      // Initialize core components
      await this.initialize();
      
      // Start HTTP server
      this.server.listen(config.apiPort, '0.0.0.0', () => {
        console.log(`✅ Otedama HTTP server listening on http://0.0.0.0:${config.apiPort}`);
        console.log(`✅ Otedama v${VERSION} started successfully`);
        console.log(`Available endpoints:`);
        console.log(`  - GET /health - Health check`);
        console.log(`  - GET /ready - Readiness check`);
        console.log(`  - GET /live - Liveness check`);
        console.log(`  - GET /api/prices - Real-time cryptocurrency prices`);
        console.log(`  - GET /api/stats - Performance statistics`);
        console.log(`  - GET /api/status - Application status`);
        console.log(`  - GET/POST /graphql - GraphQL API${process.env.NODE_ENV === 'development' ? ' (GraphiQL enabled)' : ''}`);
        console.log(`  - GET / - Welcome message`);
        
        // Start periodic health checks
        if (this.healthCheck) {
          this.healthCheck.startPeriodicChecks();
        }
      });
      
      // Handle server errors
      this.server.on('error', (error) => {
        console.error('❌ Server error:', error);
        if (error.code === 'EADDRINUSE') {
          console.error(`Port ${config.apiPort} is already in use`);
          console.error(`Try using a different port by setting API_PORT environment variable`);
        } else if (error.code === 'EACCES') {
          console.error(`Permission denied for port ${config.apiPort}`);
          console.error(`Try using a port above 1024 or run with appropriate permissions`);
        }
        process.exit(1);
      });
      
      // Start Admin Dashboard Server
      try {
        this.adminDashboard = new AdminDashboardServer({
          port: parseInt(process.env.ADMIN_PORT) || 3001,
          host: process.env.ADMIN_HOST || 'localhost',
          services: this.services,
          enableAuth: process.env.NODE_ENV === 'production'
        });
        await this.adminDashboard.start();
        this.services.set('adminDashboard', this.adminDashboard);
        console.log(`✅ Admin Dashboard available at http://localhost:${this.adminDashboard.config.port}`);
      } catch (error) {
        console.warn('⚠️ Admin Dashboard could not be started:', error.message);
      }
      
      // Start User Web Interface
      try {
        this.userWebServer = new UserWebServer({
          port: parseInt(process.env.WEB_PORT) || 3000,
          host: process.env.WEB_HOST || 'localhost',
          services: this.services
        });
        await this.userWebServer.start();
        this.services.set('userWebServer', this.userWebServer);
        console.log(`✅ User Web Interface available at http://localhost:${this.userWebServer.config.port}`);
      } catch (error) {
        console.warn('⚠️ User Web Interface could not be started:', error.message);
      }
      
    } catch (error) {
      console.error('❌ Failed to start Otedama:', error);
      process.exit(1);
    }
  }

  /**
   * Run preflight checks before starting
   */
  async runPreflightChecks() {
    console.log('Running preflight checks...');
    
    // Check Node.js version
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.split('.')[0].substring(1));
    if (majorVersion < 18) {
      throw new Error(`Node.js version 18.0.0 or higher required. Current: ${nodeVersion}`);
    }
    
    // Check required directories
    const requiredDirs = ['./data', './logs', './backups'];
    const fs = await import('fs/promises');
    
    for (const dir of requiredDirs) {
      try {
        await fs.access(dir);
      } catch {
        console.log(`Creating directory: ${dir}`);
        await fs.mkdir(dir, { recursive: true });
      }
    }
    
    // Check port availability
    const net = await import('net');
    const checkPort = (port) => new Promise((resolve, reject) => {
      const tester = net.createServer()
        .once('error', err => {
          if (err.code === 'EADDRINUSE') {
            reject(new Error(`Port ${port} is already in use`));
          } else {
            reject(err);
          }
        })
        .once('listening', () => {
          tester.close(() => resolve());
        })
        .listen(port);
    });
    
    try {
      await checkPort(config.apiPort);
    } catch (error) {
      console.error(`❌ ${error.message}`);
      throw error;
    }
    
    console.log('✅ Preflight checks passed');
  }

  /**
   * Graceful shutdown with proper cleanup
   */
  async shutdown(exitCode = 0) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    
    this.logger.info('Initiating graceful shutdown...');
    const shutdownStart = Date.now();
    
    try {
      // 1. Stop accepting new connections
      if (this.server) {
        await new Promise((resolve) => {
          this.server.close(resolve);
        });
        this.logger.info('HTTP server stopped');
      }
      
      // 2. Stop Admin Dashboard
      const adminDashboard = this.services.get('adminDashboard');
      if (adminDashboard) {
        await adminDashboard.stop();
        this.logger.info('Admin Dashboard stopped');
      }
      
      // 3. Stop User Web Interface
      const userWebServer = this.services.get('userWebServer');
      if (userWebServer) {
        await userWebServer.stop();
        this.logger.info('User Web Interface stopped');
      }
      
      // 4. Close WebSocket servers
      const realtimeServers = this.services.get('realtimeServers');
      if (realtimeServers?.shutdown) {
        await realtimeServers.shutdown();
        this.logger.info('Realtime servers stopped');
      } else {
        const wss = this.services.get('websocket');
        if (wss) {
          // Clear heartbeat interval
          if (wss.cleanupInterval) {
            clearInterval(wss.cleanupInterval);
          }
          
          // Close all client connections gracefully
          const closePromises = [];
          wss.clients.forEach(ws => {
            closePromises.push(new Promise((resolve) => {
              ws.close(1001, 'Server shutting down');
              ws.once('close', resolve);
              // Force close after 5 seconds
              setTimeout(() => {
                ws.terminate();
                resolve();
              }, 5000);
            }));
          });
          await Promise.all(closePromises);
          
          // Close server
          await new Promise((resolve) => {
            wss.close(resolve);
          });
          this.logger.info('WebSocket server stopped');
        }
      }
      
      // 3. Shutdown P2P controller
      if (this.p2pController?.shutdown) {
        await this.p2pController.shutdown();
        this.logger.info('P2P controller stopped');
      }
      
      // 4. Stop monitoring
      if (this.monitoringManager) {
        this.monitoringManager.stop();
        this.logger.info('Monitoring stopped');
      }
      
      // 5. Stop alert manager
      if (this.alertManager) {
        await this.alertManager.stop();
        this.logger.info('Alert manager stopped');
      }
      
      // 5. Stop scheduled tasks
      const backupManager = this.services.get('backupManager');
      if (backupManager?.shutdown) {
        await backupManager.shutdown();
        this.logger.info('Backup manager stopped');
      }
      
      // 6. Shutdown worker pool
      const workerPool = this.services.get('workerPool');
      if (workerPool?.shutdown) {
        await workerPool.shutdown();
        this.logger.info('Worker pool stopped');
      }
      
      // 7. Stop health checks
      if (this.healthCheck) {
        this.healthCheck.stopPeriodicChecks();
        this.logger.info('Health checks stopped');
      }
      
      // 8. Stop dashboard
      if (this.dashboard) {
        this.dashboard.stop();
        this.logger.info('Dashboard stopped');
      }
      
      // 9. Stop performance features
      // Stop memory profiler
      if (this.memoryProfiler) {
        this.memoryProfiler.stop();
        const report = this.memoryProfiler.generateReport();
        this.logger.info('Memory profiler report:', report);
      }
      
      // Stop memory optimizer
      if (this.memoryOptimizer) {
        this.memoryOptimizer.stop();
        const stats = this.memoryOptimizer.getStats();
        this.logger.info('Memory optimizer stats:', stats);
      }
      
      // Stop metrics WebSocket
      const metricsWS = this.services.get('metricsWebSocket');
      if (metricsWS?.stop) {
        await metricsWS.stop();
        this.logger.info('Metrics WebSocket stopped');
      }
      
      // Stop metrics server
      const metricsServer = this.services.get('metricsServer');
      if (metricsServer) {
        await new Promise((resolve) => {
          metricsServer.close(resolve);
        });
        this.logger.info('Metrics server stopped');
      }
      
      // Cleanup multi-layer cache
      if (this.multiLayerCache) {
        await this.multiLayerCache.cleanup();
        this.logger.info('Multi-layer cache cleaned up');
      }
      
      // Clear object pools
      if (this.objectPools) {
        for (const [name, pool] of Object.entries(this.objectPools)) {
          pool.clear();
        }
        this.logger.info('Object pools cleared');
      }
      
      // Stop CPU affinity manager
      if (this.cpuAffinityManager) {
        const cpuStats = await this.cpuAffinityManager.getCPUStats();
        this.logger.info('CPU affinity stats:', cpuStats);
      }
      
      // 10. Cleanup modules
      for (const [name, module] of this.modules) {
        if (typeof module.shutdown === 'function') {
          try {
            await module.shutdown();
            this.logger.info(`Module ${name} stopped`);
          } catch (error) {
            this.logger.error(`Error shutting down module ${name}:`, error);
          }
        }
      }
      
      // 11. Final database cleanup and close
      if (this.dbManager) {
        await safeExecute(async () => {
          // Final metrics recording
          try {
            await this.dbManager.run(
              'INSERT INTO system_metrics (metric_name, metric_value, tags) VALUES (?, ?, ?)',
              ['shutdown', Date.now() - shutdownStart, JSON.stringify({ exitCode, reason: 'graceful' })]
            );
          } catch (error) {
            // Ignore errors during shutdown
          }
          
          // Shutdown database manager
          await this.dbManager.shutdown();
          this.logger.info('Database connections closed');
        }, {
          service: 'database-shutdown',
          maxRetries: 1
        });
      } else if (this.db) {
        // Fallback
        this.db.close();
      }
      
      const shutdownTime = Date.now() - shutdownStart;
      this.logger.info(`Shutdown completed in ${shutdownTime}ms`);
      
    } catch (error) {
      this.logger.error('Error during shutdown:', error);
    } finally {
      // Force exit after 10 seconds
      setTimeout(() => {
        this.logger.warn('Forcing exit after timeout');
        process.exit(exitCode);
      }, 10000).unref();
      
      // Normal exit
      process.exit(exitCode);
    }
  }
}

// ===== MAIN ENTRY POINT =====
const otedama = new OtedamaCore();

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught exception:', error);
  otedama.shutdown(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled rejection at:', promise, 'reason:', reason);
  otedama.shutdown(1);
});

// Graceful shutdown handlers
process.on('SIGINT', () => {
  console.log('\n[INFO] Received SIGINT, shutting down gracefully...');
  otedama.shutdown(0);
});

process.on('SIGTERM', () => {
  console.log('[INFO] Received SIGTERM, shutting down gracefully...');
  otedama.shutdown(0);
});

// Windows graceful shutdown
if (process.platform === 'win32') {
  import('readline').then(({ createInterface }) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.on('SIGINT', () => {
      process.emit('SIGINT');
    });
  });
}

// Start the application
(async () => {
  try {
    console.log(`\n===============================================`);
    console.log(`  Otedama - Enterprise P2P Mining Pool & DEX`);
    console.log(`  Environment: ${config.environment}`);
    console.log(`  Node.js: ${process.version}`);
    console.log(`  Platform: ${process.platform} ${process.arch}`);
    console.log(`===============================================\n`);
    
    await otedama.start();
    
    console.log(`\n✅ Otedama is running!`);
    console.log(`\n📍 Endpoints:`);
    console.log(`  - HTTP API: http://localhost:${config.apiPort}`);
    console.log(`  - Mining WS: ws://localhost:${config.wsPort}`);
    console.log(`  - DEX WS: ws://localhost:${config.dexWsPort}`);
    console.log(`  - P2P: localhost:${config.p2pPort}`);
    console.log(`\n📊 Monitoring:`);
    console.log(`  - Health: http://localhost:${config.apiPort}/health`);
    console.log(`  - Metrics: http://localhost:${config.apiPort}/metrics`);
    console.log(`  - Stats: http://localhost:${config.apiPort}/api/stats`);
    console.log(`  - Dashboard: http://localhost:${config.apiPort}/dashboard`);
    console.log(`\n💡 Press Ctrl+C to shutdown gracefully\n`);
    
  } catch (error) {
    console.error('\n❌ Failed to start Otedama:', error);
    console.error('\nPlease check:');
    console.error('  1. All required ports are available');
    console.error('  2. Database path is accessible');
    console.error('  3. Environment variables are set correctly');
    console.error('\nFor help, see: https://github.com/otedama/otedama\n');
    process.exit(1);
  }
})();