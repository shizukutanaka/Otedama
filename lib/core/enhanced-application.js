/**
 * Enhanced Application Core for Otedama
 * Integrates all advanced components with improved architecture
 */

import { EventEmitter } from 'events';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { register as metricsRegister, collectDefaultMetrics } from 'prom-client';
collectDefaultMetrics();
import { OtedamaError, ErrorCategory } from './error-handler-unified.js';
import { setupGlobalErrorBoundary } from './global-error-boundary.js';
import { getErrorRecoverySystem } from './error-recovery-system.js';

// Import enhanced components
import AdvancedCachingSystem from '../performance/advanced-caching-system.js';
import EnhancedSecurityMiddleware from '../security/enhanced-security-middleware.js';
import InternationalizationSystem, { i18nMiddleware } from '../i18n/internationalization-system.js';
import { EnhancedConnectionStability } from '../websocket/enhanced-connection-stability.js';
import { EnhancedNetworkResilience } from '../p2p/enhanced-network-resilience.js';

// Import existing components
import { PriceFeedService } from '../price-feed.js';
import { EnhancedDatabaseOptimizer } from '../database/enhanced-database-optimizer.js';

// Import essential systems only
import { feeAuditMonitor } from '../security/fee-audit-monitor.js';
import { secureFeeConfig, feeCalculator } from '../security/fee-protection.js';

// Import automation systems
import AutomationOrchestrator from '../automation/automation-orchestrator.js';
import automationRoutes from '../routes/automation-routes.js';

// Import agent system
import { agentManager } from '../agents/index.js';

// AI/ML systems removed - non-practical features

export class EnhancedOtedamaApplication extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      port: options.port || process.env.API_PORT || 3333,
      wsPort: options.wsPort || process.env.WS_PORT || 3334,
      dbPath: options.dbPath || process.env.DB_PATH || './otedama.db',
      
      // Component configurations
      cache: {
        l1MaxSize: options.cacheL1MaxSize || 1000,
        l2MaxSize: options.cacheL2MaxSize || 10000,
        l3MaxSize: options.cacheL3MaxSize || 100000,
        metricsEnabled: true
      },
      
      security: {
        maxRequests: options.maxRequests || 100,
        rateLimitWindow: options.rateLimitWindow || 60000,
        ddosProtection: true,
        bruteForceProtection: true
      },
      
      i18n: {
        defaultLanguage: options.defaultLanguage || 'en',
        autoDetectLanguage: true,
        cacheEnabled: true
      },
      
      websocket: {
        maxConnections: options.maxConnections || 1000,
        heartbeatInterval: options.heartbeatInterval || 30000,
        connectionTimeout: options.connectionTimeout || 10000
      },
      
      p2p: {
        partitionDetectionThreshold: options.partitionDetectionThreshold || 0.3,
        recoveryTimeout: options.recoveryTimeout || 30000,
        healthCheckInterval: options.healthCheckInterval || 10000
      },
      
      agents: {
        enabled: options.agentsEnabled !== false,
        config: {
          monitoring: {
            interval: options.monitoringInterval || 30000,
            cpuThreshold: options.cpuThreshold || 80,
            memoryThreshold: options.memoryThreshold || 85
          },
          health: {
            interval: options.healthCheckInterval || 60000
          },
          security: {
            interval: options.securityInterval || 45000
          },
          optimization: {
            interval: options.optimizationInterval || 120000
          },
          healing: {
            interval: options.healingInterval || 90000
          },
          scaling: {
            interval: options.scalingInterval || 180000,
            predictiveScaling: options.predictiveScaling !== false
          }
        }
      },
      
      // AI/ML configuration removed - non-practical features
      
      ...options
    };
    
    // Core components
    this.app = express();
    this.server = null;
    this.wsServer = null;
    
    // Enhanced components
    this.cache = null;
    this.security = null;
    this.i18n = null;
    this.wsStability = null;
    this.p2pResilience = null;
    
    // Existing components
    this.priceFeed = null;
    this.database = null;
    
    // Essential security systems
    this.feeProtection = secureFeeConfig;
    this.feeCalculator = feeCalculator;
    this.feeAuditMonitor = feeAuditMonitor;
    
    // Automation system
    this.automationOrchestrator = null;
    
    // Agent system
    this.agentManager = agentManager;
    
    // Application state
    this.isInitialized = false;
    this.isRunning = false;
    this.startTime = null;
    
    // Setup global error handling
    this.errorBoundary = setupGlobalErrorBoundary({
      exitOnUncaughtException: process.env.NODE_ENV === 'production',
      enableStackTrace: true,
      alertOnCritical: true
    });
    
    this.errorRecoverySystem = getErrorRecoverySystem({
      maxRetries: 3,
      enableAutoRecovery: true,
      enableCircuitBreaker: true
    });
    
    this.setupErrorHandling();
  }
  
  /**
   * Initialize all components with optimized dependency-based ordering
   */
  async initialize() {
    if (this.isInitialized) {
      throw new OtedamaError('Application already initialized', ErrorCategory.VALIDATION);
    }
    
    const startTime = Date.now();
    
    try {
      console.log('🚀 Initializing Enhanced Otedama Application (Optimized)...');
      
      // Phase 1: Initialize independent core components in parallel
      console.log('📦 Phase 1: Core Components (Parallel)');
      await Promise.all([
        this.initializeCache(),
        this.initializeSecurity(),
        this.initializeI18n(),
        this.initializeFeeProtection()
      ]);
      
      // Phase 2: Initialize database (required by many components)
      console.log('🗄️  Phase 2: Database Layer');
      await this.initializeDatabase();
      
      // Phase 3: Initialize network components in parallel (depend on database)
      console.log('🌐 Phase 3: Network Components (Parallel)');
      await Promise.all([
        this.initializeWebSocketStability(),
        this.initializeP2PResilience(),
        this.initializePriceFeed()
      ]);
      
      // Phase 4: Initialize automation systems
      console.log('🤖 Phase 4: Automation Systems');
      await this.initializeAutomation();
      
      // Phase 5: Initialize agent system
      console.log('🤖 Phase 5: Agent System');
      await this.initializeAgents();
      
      // Phase 6: Setup Express application
      console.log('🚀 Phase 6: Application Server');
      await this.setupExpressApp();
      
      // Phase 7: Setup network servers in parallel
      console.log('🔗 Phase 7: Network Servers (Parallel)');
      await Promise.all([
        this.setupWebSocketServer(),
        this.setupRoutes()
      ]);
      
      // Phase 8: Final integrations
      console.log('🔧 Phase 8: Component Integrations');
      await this.setupComponentIntegrations();
      
      const initTime = Date.now() - startTime;
      this.isInitialized = true;
      
      console.log(`✅ Application initialization completed in ${initTime}ms`);
      console.log('📊 Initialization Performance:');
      console.log(`   • Total Time: ${initTime}ms`);
      console.log(`   • Components: ${this.getInitializedComponentCount()}`);
      console.log(`   • Memory Usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
      
      this.emit('initialized', { initTime, components: this.getInitializedComponentCount() });
      
    } catch (error) {
      const initTime = Date.now() - startTime;
      console.error(`❌ Application initialization failed after ${initTime}ms`);
      
      this.errorHandler.handleError(error, {
        context: 'application_initialization',
        category: ErrorCategory.SYSTEM,
        metadata: { initTime, phase: this.getCurrentInitPhase() }
      });
      
      // Cleanup partially initialized components
      await this.cleanupPartialInitialization();
      
      throw error;
    }
  }
  
  /**
   * Initialize advanced caching system
   */
  async initializeCache() {
    console.log('📦 Initializing Advanced Caching System...');
    
    this.cache = new AdvancedCachingSystem(this.options.cache);
    
    // Setup cache event handlers
    this.cache.on('eviction', ({ level, key, reason }) => {
      this.emit('cacheEviction', { level, key, reason });
    });
    
    this.cache.on('hit', ({ level, key }) => {
      this.emit('cacheHit', { level, key });
    });
    
    console.log('✅ Caching system initialized');
  }
  
  /**
   * Initialize enhanced security middleware
   */
  async initializeSecurity() {
    console.log('🔒 Initializing Enhanced Security...');
    
    this.security = new EnhancedSecurityMiddleware(this.options.security);
    
    // Setup security event handlers
    this.security.on('threat-detected', (threat) => {
      this.emit('securityThreat', threat);
    });
    
    this.security.on('ddos-attack', (attack) => {
      this.emit('ddosDetected', attack);
    });
    
    console.log('✅ Security middleware initialized');
  }
  
  /**
   * Initialize internationalization system
   */
  async initializeI18n() {
    console.log('🌍 Initializing Internationalization...');
    
    this.i18n = new InternationalizationSystem(this.options.i18n);
    await this.i18n.initialize();
    
    console.log(`✅ i18n initialized with ${Object.keys(this.i18n.getAvailableLanguages()).length} languages`);
  }
  
  /**
   * Initialize database with optimizer
   */
  async initializeDatabase() {
    console.log('🗄️  Initializing Enhanced Database...');
    
    this.database = new EnhancedDatabaseOptimizer({
      path: this.options.dbPath,
      ...this.options.database
    });
    
    await this.database.initialize();
    
    console.log('✅ Database initialized and optimized');
  }
  
  /**
   * Initialize WebSocket stability system
   */
  async initializeWebSocketStability() {
    console.log('🔌 Initializing WebSocket Stability...');
    
    this.wsStability = new EnhancedConnectionStability(this.options.websocket);
    
    // Connect to database
    this.wsStability.setDatabase(this.database);
    
    console.log('✅ WebSocket stability system initialized');
  }
  
  /**
   * Initialize P2P network resilience
   */
  async initializeP2PResilience() {
    console.log('🌐 Initializing P2P Resilience...');
    
    this.p2pResilience = new EnhancedNetworkResilience(this.options.p2p);
    
    // Setup event handlers
    this.p2pResilience.on('network-partition', (partition) => {
      this.emit('networkPartition', partition);
    });
    
    this.p2pResilience.on('partition-recovered', (recovery) => {
      this.emit('partitionRecovered', recovery);
    });
    
    console.log('✅ P2P resilience system initialized');
  }
  
  /**
   * Initialize price feed service
   */
  async initializePriceFeed() {
    console.log('💰 Initializing Price Feed Service...');
    
    this.priceFeed = new PriceFeedService({
      database: this.database,
      cache: this.cache,
      ...this.options.priceFeed
    });
    
    await this.priceFeed.initialize();
    
    console.log('✅ Price feed service initialized');
  }
  
  /**
   * Initialize fee protection systems
   */
  async initializeFeeProtection() {
    console.log('💸 Initializing Fee Protection Systems...');
    
    // Fee audit monitor runs independently
    this.feeAuditMonitor.startContinuousAudit();
    
    console.log('✅ Fee protection systems initialized');
  }

  /**
   * Initialize automation orchestrator
   */
  async initializeAutomation() {
    console.log('🤖 Initializing Automation Orchestrator...');
    
    this.automationOrchestrator = new AutomationOrchestrator({
      userAutomation: this.options.automation?.userAutomation !== false,
      adminAutomation: this.options.automation?.adminAutomation !== false,
      predictiveMaintenance: this.options.automation?.predictiveMaintenance !== false,
      securityAutomation: this.options.automation?.securityAutomation !== false,
      enableCrossSystemOptimization: this.options.automation?.crossSystemOptimization !== false
    });

    // Setup automation event handlers
    this.automationOrchestrator.on('critical-alert-handled', (alert) => {
      this.emit('automationAlert', { type: 'critical', alert });
    });

    this.automationOrchestrator.on('security-threat-coordinated', (threatData) => {
      this.emit('securityThreatCoordinated', threatData);
    });

    this.automationOrchestrator.on('coordination-completed', (coordination) => {
      this.emit('automationCoordination', coordination);
    });

    this.automationOrchestrator.on('emergency-protocols-activated', (data) => {
      this.emit('emergencyProtocols', data);
      logger.error('Emergency automation protocols activated:', data);
    });

    console.log('✅ Automation Orchestrator initialized');
  }

  /**
   * Initialize agent system
   */
  async initializeAgents() {
    if (!this.options.agents.enabled) {
      console.log('🤖 Agent System disabled, skipping initialization');
      return;
    }

    console.log('🤖 Initializing Agent System...');
    
    try {
      // Configure agents based on options
      const agentConfigs = [];

      // Monitoring agent
      agentConfigs.push({
        type: 'monitoring',
        name: 'SystemMonitor',
        config: this.options.agents.config.monitoring
      });

      // Health check agent
      agentConfigs.push({
        type: 'health',
        name: 'HealthChecker',
        config: this.options.agents.config.health
      });

      // Security agent
      agentConfigs.push({
        type: 'security',
        name: 'SecurityGuard',
        config: this.options.agents.config.security
      });

      // Optimization agent
      agentConfigs.push({
        type: 'optimization',
        name: 'PerformanceOptimizer',
        config: this.options.agents.config.optimization
      });

      // Self-healing agent
      agentConfigs.push({
        type: 'healing',
        name: 'SelfHealer',
        config: this.options.agents.config.healing
      });

      // Scaling agent
      agentConfigs.push({
        type: 'scaling',
        name: 'AutoScaler',
        config: this.options.agents.config.scaling
      });

      // Initialize agent manager
      await this.agentManager.initialize({
        agents: agentConfigs
      });

      // Setup agent event listeners
      this.agentManager.on('alert', (alert) => {
        this.emit('agentAlert', alert);
        
        // Forward critical alerts to automation system
        if (alert.alert.severity === 'critical' && this.automationOrchestrator) {
          this.automationOrchestrator.handleCriticalAlert(alert);
        }
      });

      this.agentManager.on('agent:execute:error', (data) => {
        this.errorHandler.handleError(new Error(`Agent ${data.agent.name} execution failed`), {
          context: 'agent_execution',
          category: ErrorCategory.SYSTEM,
          metadata: data
        });
      });

      // Provide context to agents
      this.setupAgentContext();

      console.log(`✅ Agent System initialized with ${this.agentManager.agents.size} agents`);
      
    } catch (error) {
      console.error('❌ Failed to initialize Agent System:', error);
      // Non-critical error - continue without agents
      this.options.agents.enabled = false;
    }
  }

  /**
   * Setup context for agents to access system metrics
   */
  setupAgentContext() {
    // Provide system metrics to monitoring agent
    const monitoringAgent = this.agentManager.getAgent('SystemMonitor');
    if (monitoringAgent) {
      // Update metrics periodically
      setInterval(() => {
        monitoringAgent.setContext('databaseConnected', this.database?.isConnected() || false);
        monitoringAgent.setContext('activeConnections', this.wsServer?.clients?.size || 0);
        monitoringAgent.setContext('cacheHitRate', this.cache?.getMetrics()?.hitRate || 0);
      }, 5000);
    }

    // Provide health context
    const healthAgent = this.agentManager.getAgent('HealthChecker');
    if (healthAgent) {
      healthAgent.setContext('databaseConnected', this.database?.isConnected() || false);
      healthAgent.setContext('redisConnected', this.cache?.isConnected() || false);
    }

    // Provide security context
    const securityAgent = this.agentManager.getAgent('SecurityGuard');
    if (securityAgent && this.security) {
      this.security.on('auth-failure', (event) => {
        const authLogs = securityAgent.getContext('authLogs') || [];
        authLogs.push({
          ip: event.ip,
          success: false,
          timestamp: Date.now()
        });
        securityAgent.setContext('authLogs', authLogs.slice(-100));
      });
    }
  }
  
  /**
   * Setup Express application
   */
  async setupExpressApp() {
    console.log('⚙️  Setting up Express application...');
    
    // Apply security middleware
    this.app.use(this.security.getMiddleware());
    
    // Apply i18n middleware
    this.app.use(i18nMiddleware(this.i18n));
    
    // Basic middleware
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    
    // Health check endpoint
    this.app.get('/health', async (req, res) => {
      const health = await this.getHealthStatus();
      res.status(health.status === 'healthy' ? 200 : 503).json(health);
    });
    
    // Metrics endpoint
    this.app.get('/metrics', (req, res) => {
      res.set('Content-Type', metricsRegister.contentType);
      res.end(metricsRegister.metrics());
    });
    
    console.log('✅ Express application configured');
  }
  
  /**
   * Setup WebSocket server
   */
  async setupWebSocketServer() {
    console.log('🔌 Setting up WebSocket server...');
    
    const wsServer = createServer();
    
    this.wsServer = new WebSocketServer({ 
      server: wsServer,
      maxPayload: 10 * 1024 * 1024 // 10MB
    });
    
    // Apply WebSocket stability
    this.wsStability.enhanceWebSocketServer(this.wsServer);
    
    wsServer.listen(this.options.wsPort, () => {
      console.log(`✅ WebSocket server listening on port ${this.options.wsPort}`);
    });
  }
  
  /**
   * Setup application routes
   */
  async setupRoutes() {
    console.log('🛣️  Setting up routes...');
    
    // Mount automation routes
    this.app.use('/api/automation', automationRoutes(this.automationOrchestrator));
    
    // Add other routes...
    
    // Error handling
    this.app.use((err, req, res, next) => {
      this.errorHandler.handleError(err, {
        context: 'http_request',
        category: ErrorCategory.HTTP,
        metadata: {
          method: req.method,
          path: req.path,
          ip: req.ip
        }
      });
      
      const status = err.status || 500;
      res.status(status).json({
        error: err.message,
        status,
        timestamp: new Date().toISOString()
      });
    });
    
    console.log('✅ Routes configured');
  }
  
  /**
   * Setup component integrations
   */
  async setupComponentIntegrations() {
    console.log('🔧 Setting up component integrations...');
    
    // Connect P2P resilience to WebSocket stability
    if (this.p2pResilience && this.wsStability) {
      this.p2pResilience.on('node-status-change', (status) => {
        this.wsStability.updateNodeStatus(status);
      });
    }
    
    // Connect automation to other systems
    if (this.automationOrchestrator) {
      // Provide system access to automation
      this.automationOrchestrator.setCache(this.cache);
      this.automationOrchestrator.setDatabase(this.database);
      this.automationOrchestrator.setSecurity(this.security);
    }
    
    console.log('✅ Component integrations completed');
  }
  
  /**
   * Setup error handling
   */
  setupErrorHandling() {
    // Uncaught exception handler
    process.on('uncaughtException', (error) => {
      this.errorHandler.handleError(error, {
        context: 'uncaught_exception',
        category: ErrorCategory.CRITICAL,
        metadata: { fatal: true }
      });
      
      // Attempt graceful shutdown
      this.stop().finally(() => {
        process.exit(1);
      });
    });
    
    // Unhandled rejection handler
    process.on('unhandledRejection', (reason, promise) => {
      this.errorHandler.handleError(reason, {
        context: 'unhandled_rejection',
        category: ErrorCategory.CRITICAL,
        metadata: { promise }
      });
    });
  }
  
  /**
   * Get initialized component count
   */
  getInitializedComponentCount() {
    let count = 0;
    if (this.cache) count++;
    if (this.security) count++;
    if (this.i18n) count++;
    if (this.database) count++;
    if (this.wsStability) count++;
    if (this.p2pResilience) count++;
    if (this.priceFeed) count++;
    if (this.automationOrchestrator) count++;
    if (this.agentManager && this.options.agents.enabled) count += this.agentManager.agents.size;
    return count;
  }
  
  /**
   * Get current initialization phase
   */
  getCurrentInitPhase() {
    if (!this.cache) return 'Phase 1: Core Components';
    if (!this.database) return 'Phase 2: Database Layer';
    if (!this.wsStability) return 'Phase 3: Network Components';
    if (!this.automationOrchestrator) return 'Phase 4: Automation Systems';
    if (!this.agentManager) return 'Phase 5: Agent System';
    if (!this.app) return 'Phase 6: Application Server';
    if (!this.wsServer) return 'Phase 7: Network Servers';
    return 'Phase 8: Component Integrations';
  }
  
  /**
   * Cleanup partial initialization
   */
  async cleanupPartialInitialization() {
    console.log('🧹 Cleaning up partial initialization...');
    
    try {
      if (this.wsServer) this.wsServer.close();
      if (this.server) this.server.close();
      if (this.cache) this.cache.cleanup();
      if (this.security) this.security.cleanup();
      if (this.database) await this.database.close();
      if (this.priceFeed) await this.priceFeed.stop();
      if (this.agentManager) await this.agentManager.shutdown();
    } catch (cleanupError) {
      console.error('Error during cleanup:', cleanupError);
    }
  }
  
  /**
   * Start the application
   */
  async start() {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    if (this.isRunning) {
      throw new OtedamaError('Application already running', ErrorCategory.VALIDATION);
    }
    
    try {
      this.server = createServer(this.app);
      
      await new Promise((resolve, reject) => {
        this.server.listen(this.options.port, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      
      this.isRunning = true;
      this.startTime = Date.now();
      
      console.log(`🚀 Enhanced Otedama Application started successfully!`);
      console.log(`📡 HTTP Server: http://localhost:${this.options.port}`);
      console.log(`🔌 WebSocket Server: ws://localhost:${this.options.wsPort}`);
      console.log(`🌍 Languages: ${Object.keys(this.i18n.getAvailableLanguages()).length} supported`);
      
      // Start agent system if enabled
      if (this.options.agents.enabled && this.agentManager) {
        console.log(`🤖 Starting Agent System...`);
        await this.agentManager.startAll();
        console.log(`✅ ${this.agentManager.agents.size} agents are now active`);
      }
      
      this.emit('started');
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'application_start',
        category: ErrorCategory.SYSTEM
      });
      throw error;
    }
  }
  
  /**
   * Stop the application
   */
  async stop() {
    if (!this.isRunning) return;
    
    try {
      console.log('🛑 Stopping Enhanced Otedama Application...');
      
      // Close WebSocket server
      if (this.wsServer) {
        this.wsServer.close();
      }
      
      // Close HTTP server
      if (this.server) {
        await new Promise((resolve) => {
          this.server.close(resolve);
        });
      }
      
      // Stop agent system
      if (this.agentManager && this.options.agents.enabled) {
        console.log('🤖 Stopping Agent System...');
        await this.agentManager.stopAll();
      }
      
      // Cleanup components
      if (this.cache) this.cache.cleanup();
      if (this.security) this.security.cleanup();
      if (this.i18n) this.i18n.cleanup();
      if (this.wsStability) this.wsStability.cleanup();
      if (this.p2pResilience) this.p2pResilience.cleanup();
      
      this.isRunning = false;
      console.log('✅ Application stopped successfully');
      
      this.emit('stopped');
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'application_stop',
        category: ErrorCategory.SYSTEM
      });
      throw error;
    }
  }
  
  /**
   * Get health status
   */
  async getHealthStatus() {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: this.isRunning ? Date.now() - this.startTime : 0,
      components: {}
    };
    
    // Check component health
    try {
      health.components.cache = this.cache ? 'healthy' : 'not_initialized';
      health.components.database = this.database?.isConnected() ? 'healthy' : 'unhealthy';
      health.components.websocket = this.wsServer ? 'healthy' : 'not_initialized';
      health.components.security = this.security ? 'healthy' : 'not_initialized';
      health.components.agents = this.options.agents.enabled ? 
        `${this.agentManager?.agents?.size || 0} agents active` : 'disabled';
      
      // Overall health
      const unhealthyComponents = Object.values(health.components)
        .filter(status => status === 'unhealthy').length;
      
      if (unhealthyComponents > 0) {
        health.status = unhealthyComponents > 2 ? 'unhealthy' : 'degraded';
      }
      
    } catch (error) {
      health.status = 'unhealthy';
      health.error = error.message;
    }
    
    return health;
  }
  
  /**
   * Get application metrics
   */
  getMetrics() {
    return {
      uptime: this.isRunning ? Date.now() - this.startTime : 0,
      cache: this.cache?.getMetrics() || {},
      websocket: {
        connections: this.wsServer?.clients?.size || 0
      },
      agents: this.agentManager?.getAgentStatuses() || {},
      memory: process.memoryUsage(),
      cpu: process.cpuUsage()
    };
  }
}

// Export singleton instance
export const application = new EnhancedOtedamaApplication();