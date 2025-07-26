/**
 * Unified API Server - Otedama
 * Consolidated REST API server with mobile support and statistics
 * 
 * Design Principles:
 * - Carmack: Low-latency responses with efficient data structures
 * - Martin: Clean REST architecture with proper separation of concerns
 * - Pike: Simple but comprehensive API interface
 */

import { EventEmitter } from 'events';
import { createServer } from 'http';
import { createStructuredLogger } from '../core/structured-logger.js';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const logger = createStructuredLogger('UnifiedAPIServer');

/**
 * API endpoint definitions
 */
const API_ENDPOINTS = {
  // Authentication
  AUTH_LOGIN: '/api/v1/auth/login',
  AUTH_LOGOUT: '/api/v1/auth/logout',
  AUTH_REFRESH: '/api/v1/auth/refresh',
  
  // Status and health
  STATUS: '/api/v1/status',
  HEALTH: '/api/v1/health',
  METRICS: '/api/v1/metrics',
  
  // Mining operations
  MINERS: '/api/v1/miners',
  MINER_DETAIL: '/api/v1/miners/:id',
  MINER_STATS: '/api/v1/miners/:id/stats',
  MINER_HISTORY: '/api/v1/miners/:id/history',
  MINER_CONFIG: '/api/v1/miners/:id/config',
  
  // Pool management
  POOL_STATUS: '/api/v1/pool/status',
  POOL_STATS: '/api/v1/pool/stats',
  POOL_BLOCKS: '/api/v1/pool/blocks',
  POOL_WORKERS: '/api/v1/pool/workers',
  POOL_CONFIG: '/api/v1/pool/config',
  
  // Worker management
  WORKERS: '/api/v1/workers',
  WORKER_DETAIL: '/api/v1/workers/:id',
  WORKER_STATS: '/api/v1/workers/:id/stats',
  
  // Financial data
  EARNINGS: '/api/v1/earnings',
  PAYOUTS: '/api/v1/payouts',
  BALANCES: '/api/v1/balances',
  TRANSACTIONS: '/api/v1/transactions',
  
  // Notifications and alerts
  NOTIFICATIONS: '/api/v1/notifications',
  ALERTS: '/api/v1/alerts',
  ALERT_RULES: '/api/v1/alerts/rules',
  
  // Statistics
  STATS_POOL: '/api/v1/stats/pool',
  STATS_MINERS: '/api/v1/stats/miners',
  STATS_NETWORK: '/api/v1/stats/network',
  STATS_PERFORMANCE: '/api/v1/stats/performance',
  
  // Mobile specific
  MOBILE_DASHBOARD: '/api/v1/mobile/dashboard',
  MOBILE_QUICK_STATS: '/api/v1/mobile/quick-stats',
  MOBILE_PUSH_TOKEN: '/api/v1/mobile/push-token',
  
  // Admin operations
  ADMIN_USERS: '/api/v1/admin/users',
  ADMIN_SYSTEM: '/api/v1/admin/system',
  ADMIN_LOGS: '/api/v1/admin/logs'
};

/**
 * WebSocket event types
 */
const WS_EVENTS = {
  // Connection
  CONNECT: 'connection',
  DISCONNECT: 'disconnect',
  AUTHENTICATE: 'authenticate',
  
  // Real-time updates
  HASHRATE_UPDATE: 'hashrate_update',
  SHARE_SUBMITTED: 'share_submitted',
  BLOCK_FOUND: 'block_found',
  MINER_STATUS: 'miner_status',
  ALERT_TRIGGERED: 'alert_triggered',
  
  // Mobile specific
  MOBILE_UPDATE: 'mobile_update',
  PUSH_NOTIFICATION: 'push_notification'
};

/**
 * Authentication middleware
 */
class AuthMiddleware {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.refreshTokens = new Map();
  }
  
  /**
   * Generate JWT token
   */
  generateToken(userId, type = 'access') {
    const payload = {
      userId,
      type,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (type === 'access' ? 3600 : 86400) // 1h or 24h
    };
    
    return jwt.sign(payload, this.config.jwtSecret);
  }
  
  /**
   * Verify JWT token
   */
  verifyToken(token) {
    try {
      return jwt.verify(token, this.config.jwtSecret);
    } catch (error) {
      return null;
    }
  }
  
  /**
   * Authenticate request
   */
  authenticate(request) {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { authenticated: false, reason: 'missing_token' };
    }
    
    const token = authHeader.substring(7);
    const payload = this.verifyToken(token);
    
    if (!payload) {
      return { authenticated: false, reason: 'invalid_token' };
    }
    
    if (payload.type !== 'access') {
      return { authenticated: false, reason: 'invalid_token_type' };
    }
    
    return {
      authenticated: true,
      userId: payload.userId,
      payload
    };
  }
}

/**
 * Rate limiting middleware
 */
class RateLimiter {
  constructor(config) {
    this.config = config;
    this.requests = new Map();
  }
  
  /**
   * Check if request is allowed
   */
  checkLimit(clientId, endpoint) {
    const key = `${clientId}:${endpoint}`;
    const now = Date.now();
    const window = this.config.windowMs || 60000; // 1 minute
    const maxRequests = this.config.maxRequests || 100;
    
    if (!this.requests.has(key)) {
      this.requests.set(key, []);
    }
    
    const requests = this.requests.get(key);
    
    // Clean old requests
    const validRequests = requests.filter(time => now - time < window);
    this.requests.set(key, validRequests);
    
    if (validRequests.length >= maxRequests) {
      return { allowed: false, retryAfter: window };
    }
    
    validRequests.push(now);
    return { allowed: true };
  }
}

/**
 * Response cache
 */
class ResponseCache {
  constructor(config) {
    this.config = config;
    this.cache = new Map();
  }
  
  /**
   * Get cached response
   */
  get(key) {
    const cached = this.cache.get(key);
    if (!cached) return null;
    
    if (Date.now() - cached.timestamp > (this.config.ttl || 10000)) {
      this.cache.delete(key);
      return null;
    }
    
    return cached.data;
  }
  
  /**
   * Set cached response
   */
  set(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }
  
  /**
   * Invalidate cache
   */
  invalidate(pattern) {
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
      }
    }
  }
}

/**
 * Unified API Server
 */
export class UnifiedAPIServer extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Server settings
      port: config.port || 8080,
      host: config.host || '0.0.0.0',
      
      // Authentication
      jwtSecret: config.jwtSecret || 'otedama-secret-change-in-production',
      authRequired: config.authRequired !== false,
      
      // Rate limiting
      rateLimitEnabled: config.rateLimitEnabled !== false,
      rateLimitWindow: config.rateLimitWindow || 60000,
      rateLimitMax: config.rateLimitMax || 100,
      
      // Caching
      cacheEnabled: config.cacheEnabled !== false,
      cacheTTL: config.cacheTTL || 10000,
      
      // WebSocket
      websocketEnabled: config.websocketEnabled !== false,
      websocketPort: config.websocketPort || 8081,
      
      // Mobile support
      mobileEnabled: config.mobileEnabled !== false,
      pushNotificationsEnabled: config.pushNotificationsEnabled !== false,
      
      // CORS
      corsEnabled: config.corsEnabled !== false,
      corsOrigins: config.corsOrigins || ['*'],
      
      // SSL/TLS
      httpsEnabled: config.httpsEnabled || false,
      sslKey: config.sslKey,
      sslCert: config.sslCert,
      
      ...config
    };
    
    // Components
    this.auth = new AuthMiddleware(this.config);
    this.rateLimiter = new RateLimiter({
      windowMs: this.config.rateLimitWindow,
      maxRequests: this.config.rateLimitMax
    });
    this.cache = new ResponseCache({
      ttl: this.config.cacheTTL
    });
    
    // Server instances
    this.httpServer = null;
    this.wsServer = null;
    
    // State
    this.running = false;
    this.connectedClients = new Map();
    this.mobileClients = new Map();
    
    // Dependencies (injected)
    this.poolManager = null;
    this.monitoringManager = null;
    this.securitySystem = null;
    this.storageManager = null;
    
    // Statistics
    this.stats = {
      requestsHandled: 0,
      wsConnections: 0,
      authAttempts: 0,
      rateLimitViolations: 0,
      cacheHits: 0,
      cacheMisses: 0
    };
    
    this.logger = logger;
  }
  
  /**
   * Initialize API server
   */
  async initialize() {
    // Create HTTP server
    this.httpServer = createServer();
    
    // Setup request handling
    this.httpServer.on('request', (req, res) => {
      this.handleRequest(req, res);
    });
    
    // Setup WebSocket server
    if (this.config.websocketEnabled) {
      this.wsServer = new WebSocketServer({
        port: this.config.websocketPort
      });
      
      this.wsServer.on('connection', (ws, req) => {
        this.handleWebSocketConnection(ws, req);
      });
    }
    
    this.logger.info('Unified API server initialized', {
      httpPort: this.config.port,
      websocketPort: this.config.websocketPort,
      authRequired: this.config.authRequired
    });
  }
  
  /**
   * Start API server
   */
  async start() {
    if (this.running) return;
    
    return new Promise((resolve, reject) => {
      this.httpServer.listen(this.config.port, this.config.host, (error) => {
        if (error) {
          reject(error);
          return;
        }
        
        this.running = true;
        this.logger.info('API server started', {
          port: this.config.port,
          host: this.config.host
        });
        
        resolve();
      });
    });
  }
  
  /**
   * Handle HTTP request
   */
  async handleRequest(req, res) {
    this.stats.requestsHandled++;
    
    // Set CORS headers
    if (this.config.corsEnabled) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    
    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    try {
      // Parse URL
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;
      const query = Object.fromEntries(url.searchParams);
      
      // Rate limiting
      if (this.config.rateLimitEnabled) {
        const clientId = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const rateLimit = this.rateLimiter.checkLimit(clientId, path);
        
        if (!rateLimit.allowed) {
          this.stats.rateLimitViolations++;
          res.writeHead(429, { 'Retry-After': Math.ceil(rateLimit.retryAfter / 1000) });
          res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
          return;
        }
      }
      
      // Authentication
      let authResult = { authenticated: !this.config.authRequired };
      if (this.config.authRequired && !this.isPublicEndpoint(path)) {
        authResult = this.auth.authenticate(req);
        this.stats.authAttempts++;
        
        if (!authResult.authenticated) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'Authentication required' }));
          return;
        }
      }
      
      // Check cache
      const cacheKey = `${path}:${JSON.stringify(query)}`;
      let cachedResponse = null;
      
      if (this.config.cacheEnabled && req.method === 'GET') {
        cachedResponse = this.cache.get(cacheKey);
        if (cachedResponse) {
          this.stats.cacheHits++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cachedResponse));
          return;
        }
        this.stats.cacheMisses++;
      }
      
      // Route request
      const response = await this.routeRequest(req.method, path, query, authResult);
      
      // Cache response
      if (this.config.cacheEnabled && req.method === 'GET' && response.cacheable !== false) {
        this.cache.set(cacheKey, response.data);
      }
      
      // Send response
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.data));
      
    } catch (error) {
      this.logger.error('Request handling error', {
        url: req.url,
        method: req.method,
        error: error.message
      });
      
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
  
  /**
   * Route API request
   */
  async routeRequest(method, path, query, auth) {
    // Health endpoints
    if (path === API_ENDPOINTS.HEALTH) {
      return this.handleHealthCheck();
    }
    
    if (path === API_ENDPOINTS.STATUS) {
      return this.handleStatusCheck();
    }
    
    if (path === API_ENDPOINTS.METRICS) {
      return this.handleMetrics();
    }
    
    // Authentication endpoints
    if (path === API_ENDPOINTS.AUTH_LOGIN && method === 'POST') {
      return this.handleLogin(query);
    }
    
    if (path === API_ENDPOINTS.AUTH_LOGOUT && method === 'POST') {
      return this.handleLogout(auth);
    }
    
    // Mining endpoints
    if (path === API_ENDPOINTS.MINERS) {
      return this.handleMiners(method, query, auth);
    }
    
    if (path.startsWith('/api/v1/miners/')) {
      return this.handleMinerDetail(method, path, query, auth);
    }
    
    // Pool endpoints
    if (path === API_ENDPOINTS.POOL_STATUS) {
      return this.handlePoolStatus();
    }
    
    if (path === API_ENDPOINTS.POOL_STATS) {
      return this.handlePoolStats(query);
    }
    
    // Statistics endpoints
    if (path.startsWith('/api/v1/stats/')) {
      return this.handleStatistics(path, query, auth);
    }
    
    // Mobile endpoints
    if (path.startsWith('/api/v1/mobile/')) {
      return this.handleMobileRequest(path, method, query, auth);
    }
    
    // Default: 404
    return {
      status: 404,
      data: { error: 'Endpoint not found' }
    };
  }
  
  /**
   * Handle health check
   */
  async handleHealthCheck() {
    return {
      status: 200,
      data: {
        status: 'healthy',
        timestamp: Date.now(),
        uptime: process.uptime(),
        version: '1.0.0'
      },
      cacheable: false
    };
  }
  
  /**
   * Handle status check
   */
  async handleStatusCheck() {
    const poolStatus = this.poolManager ? await this.poolManager.getStatus() : null;
    
    return {
      status: 200,
      data: {
        server: {
          running: this.running,
          uptime: process.uptime(),
          connections: this.connectedClients.size
        },
        pool: poolStatus,
        stats: this.stats
      }
    };
  }
  
  /**
   * Handle metrics
   */
  async handleMetrics() {
    const metrics = this.monitoringManager 
      ? await this.monitoringManager.exportMetrics()
      : {};
    
    return {
      status: 200,
      data: metrics
    };
  }
  
  /**
   * Handle miner requests
   */
  async handleMiners(method, query, auth) {
    if (!this.poolManager) {
      return {
        status: 503,
        data: { error: 'Pool manager not available' }
      };
    }
    
    switch (method) {
      case 'GET':
        const miners = await this.poolManager.getMiners(query);
        return {
          status: 200,
          data: miners
        };
        
      default:
        return {
          status: 405,
          data: { error: 'Method not allowed' }
        };
    }
  }
  
  /**
   * Handle mobile requests
   */
  async handleMobileRequest(path, method, query, auth) {
    if (path === API_ENDPOINTS.MOBILE_DASHBOARD) {
      return this.handleMobileDashboard(auth);
    }
    
    if (path === API_ENDPOINTS.MOBILE_QUICK_STATS) {
      return this.handleMobileQuickStats(auth);
    }
    
    return {
      status: 404,
      data: { error: 'Mobile endpoint not found' }
    };
  }
  
  /**
   * Handle mobile dashboard
   */
  async handleMobileDashboard(auth) {
    const dashboard = {
      timestamp: Date.now(),
      user: auth.userId,
      summary: {
        hashrate: 0,
        workers: 0,
        earnings: 0,
        efficiency: 0
      },
      alerts: [],
      recentBlocks: []
    };
    
    return {
      status: 200,
      data: dashboard
    };
  }
  
  /**
   * Handle WebSocket connection
   */
  handleWebSocketConnection(ws, req) {
    const clientId = crypto.randomBytes(16).toString('hex');
    
    this.connectedClients.set(clientId, {
      ws,
      authenticated: false,
      userId: null,
      subscriptions: new Set()
    });
    
    this.stats.wsConnections++;
    
    ws.on('message', (data) => {
      this.handleWebSocketMessage(clientId, data);
    });
    
    ws.on('close', () => {
      this.connectedClients.delete(clientId);
    });
    
    // Send welcome message
    ws.send(JSON.stringify({
      type: 'connected',
      clientId,
      timestamp: Date.now()
    }));
  }
  
  /**
   * Handle WebSocket message
   */
  handleWebSocketMessage(clientId, data) {
    try {
      const message = JSON.parse(data);
      const client = this.connectedClients.get(clientId);
      
      if (!client) return;
      
      switch (message.type) {
        case WS_EVENTS.AUTHENTICATE:
          this.handleWebSocketAuth(clientId, message.token);
          break;
          
        case 'subscribe':
          client.subscriptions.add(message.channel);
          break;
          
        case 'unsubscribe':
          client.subscriptions.delete(message.channel);
          break;
      }
      
    } catch (error) {
      this.logger.error('WebSocket message error', {
        clientId,
        error: error.message
      });
    }
  }
  
  /**
   * Broadcast to WebSocket clients
   */
  broadcast(event, data, channel = null) {
    const message = JSON.stringify({
      type: event,
      data,
      timestamp: Date.now()
    });
    
    for (const [clientId, client] of this.connectedClients) {
      if (client.ws.readyState === 1) { // OPEN
        if (!channel || client.subscriptions.has(channel)) {
          client.ws.send(message);
        }
      }
    }
  }
  
  /**
   * Check if endpoint is public
   */
  isPublicEndpoint(path) {
    const publicEndpoints = [
      API_ENDPOINTS.HEALTH,
      API_ENDPOINTS.STATUS,
      API_ENDPOINTS.AUTH_LOGIN,
      API_ENDPOINTS.POOL_STATUS
    ];
    
    return publicEndpoints.includes(path);
  }
  
  /**
   * Set dependencies
   */
  setDependencies(deps) {
    this.poolManager = deps.poolManager;
    this.monitoringManager = deps.monitoringManager;
    this.securitySystem = deps.securitySystem;
    this.storageManager = deps.storageManager;
  }
  
  /**
   * Get server statistics
   */
  getStats() {
    return {
      ...this.stats,
      connectedClients: this.connectedClients.size,
      running: this.running
    };
  }
  
  /**
   * Shutdown server
   */
  async shutdown() {
    if (!this.running) return;
    
    // Close WebSocket connections
    for (const [clientId, client] of this.connectedClients) {
      client.ws.close();
    }
    
    // Close servers
    if (this.wsServer) {
      this.wsServer.close();
    }
    
    if (this.httpServer) {
      this.httpServer.close();
    }
    
    this.running = false;
    this.logger.info('API server shutdown');
  }
}

// Export constants
export {
  API_ENDPOINTS,
  WS_EVENTS
};

export default UnifiedAPIServer;

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
// Note: cors, helmet, and compression would need to be implemented or imported
// For now, we'll use basic implementations
import { createStructuredLogger } from '../core/structured-logger.js';
import { SecuritySystem } from '../security/national-security.js';
import { PerformanceMonitor } from '../monitoring/performance-monitor.js';
import { AuthManager } from '../security/auth-manager.js';
import { validators, sanitizeInput, preventSQLInjection } from '../security/input-validator.js';

const logger = createStructuredLogger('APIServer');

/**
 * API route handlers
 */
class APIHandlers {
  constructor(pool, storage, blockchain, payments) {
    this.pool = pool;
    this.storage = storage;
    this.blockchain = blockchain;
    this.payments = payments;
  }
  
  // Pool statistics
  async getPoolStats(req, res) {
    try {
      const stats = await this.pool.getPoolInfo();
      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('Failed to get pool stats', error);
      res.status(500).json({ 
        success: false, 
        error: 'Internal server error' 
      });
    }
  }
  
  // Miner information
  async getMinerInfo(req, res) {
    try {
      const { address } = req.params;
      
      const minerInfo = await this.pool.getMinerInfo(address);
      if (!minerInfo) {
        return res.status(404).json({ 
          success: false, 
          error: 'Miner not found' 
        });
      }
      
      res.json({
        success: true,
        data: minerInfo
      });
    } catch (error) {
      logger.error('Failed to get miner info', error);
      res.status(500).json({ 
        success: false, 
        error: 'Internal server error' 
      });
    }
  }
  
  // Payment history
  async getPaymentHistory(req, res) {
    try {
      const { address } = req.params;
      const { limit = 100, offset = 0 } = req.query;
      
      const history = await this.payments.getPaymentHistory(
        address, 
        parseInt(limit)
      );
      
      res.json({
        success: true,
        data: history
      });
    } catch (error) {
      logger.error('Failed to get payment history', error);
      res.status(500).json({ 
        success: false, 
        error: 'Internal server error' 
      });
    }
  }
  
  // Submit share (usually via Stratum)
  async submitShare(req, res) {
    try {
      const { jobId, nonce, hash, worker, address } = req.body;
      
      const result = await this.pool.submitShare({
        jobId,
        nonce,
        hash,
        worker,
        address
      });
      
      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('Failed to submit share', error);
      res.status(400).json({ 
        success: false, 
        error: error.message 
      });
    }
  }
  
  // Admin: Update pool fee
  async updatePoolFee(req, res) {
    try {
      const { fee } = req.body;
      
      if (fee < 0 || fee > 0.1) { // Max 10% fee
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid fee value' 
        });
      }
      
      await this.pool.updateConfig({ poolFee: fee });
      
      res.json({
        success: true,
        data: { fee }
      });
    } catch (error) {
      logger.error('Failed to update pool fee', error);
      res.status(500).json({ 
        success: false, 
        error: 'Internal server error' 
      });
    }
  }
  
  // Admin: Trigger manual payout
  async triggerPayout(req, res) {
    try {
      const { minAmount = 0.01, addresses = [] } = req.body;
      
      await this.payments.triggerPayment(
        addresses.length > 0 ? addresses : null
      );
      
      res.json({
        success: true,
        data: { 
          message: 'Payout triggered',
          addresses: addresses.length || 'all eligible'
        }
      });
    } catch (error) {
      logger.error('Failed to trigger payout', error);
      res.status(500).json({ 
        success: false, 
        error: 'Internal server error' 
      });
    }
  }
  
  // Health check
  async healthCheck(req, res) {
    try {
      const health = await this.pool.getHealthStatus();
      
      res.status(health.healthy ? 200 : 503).json({
        success: health.healthy,
        data: health
      });
    } catch (error) {
      res.status(503).json({ 
        success: false, 
        error: 'Service unavailable' 
      });
    }
  }
}

/**
 * WebSocket handlers
 */
class WebSocketHandlers {
  constructor(pool, payments) {
    this.pool = pool;
    this.payments = payments;
    this.clients = new Map();
    this.subscriptions = new Map();
  }
  
  handleConnection(ws, req) {
    const clientId = crypto.randomUUID();
    
    this.clients.set(clientId, {
      ws,
      authenticated: false,
      subscriptions: new Set()
    });
    
    ws.on('message', (data) => this.handleMessage(clientId, data));
    ws.on('close', () => this.handleDisconnect(clientId));
    ws.on('error', (error) => {
      logger.error('WebSocket error', { clientId, error: error.message });
    });
    
    // Send welcome message
    this.send(clientId, {
      type: 'welcome',
      data: { clientId }
    });
  }
  
  async handleMessage(clientId, data) {
    try {
      const message = JSON.parse(data);
      const client = this.clients.get(clientId);
      
      if (!client) return;
      
      switch (message.type) {
        case 'auth':
          await this.handleAuth(clientId, message.apiKey);
          break;
          
        case 'subscribe':
          await this.handleSubscribe(clientId, message.channel, message.params);
          break;
          
        case 'unsubscribe':
          await this.handleUnsubscribe(clientId, message.channel);
          break;
          
        default:
          this.send(clientId, {
            type: 'error',
            error: 'Unknown message type'
          });
      }
    } catch (error) {
      this.send(clientId, {
        type: 'error',
        error: 'Invalid message format'
      });
    }
  }
  
  async handleAuth(clientId, apiKey) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    // Validate API key
    const valid = await this.validateApiKey(apiKey);
    
    if (valid) {
      client.authenticated = true;
      this.send(clientId, {
        type: 'auth',
        data: { authenticated: true }
      });
    } else {
      this.send(clientId, {
        type: 'auth',
        data: { authenticated: false },
        error: 'Invalid API key'
      });
    }
  }
  
  async handleSubscribe(clientId, channel, params = {}) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    // Check authentication for some channels
    if (channel.startsWith('miner:') && !client.authenticated) {
      this.send(clientId, {
        type: 'error',
        error: 'Authentication required'
      });
      return;
    }
    
    client.subscriptions.add(channel);
    
    // Track subscription
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
    }
    this.subscriptions.get(channel).add(clientId);
    
    // Setup event listeners
    switch (channel) {
      case 'pool_stats':
        // Pool stats are broadcast periodically
        break;
        
      case 'blocks':
        // New blocks are broadcast to all subscribers
        break;
        
      default:
        if (channel.startsWith('miner:')) {
          // Miner-specific updates
          const address = channel.split(':')[1];
          // Setup miner tracking
        }
    }
    
    this.send(clientId, {
      type: 'subscribed',
      data: { channel }
    });
  }
  
  handleUnsubscribe(clientId, channel) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    client.subscriptions.delete(channel);
    
    const channelSubs = this.subscriptions.get(channel);
    if (channelSubs) {
      channelSubs.delete(clientId);
      if (channelSubs.size === 0) {
        this.subscriptions.delete(channel);
      }
    }
    
    this.send(clientId, {
      type: 'unsubscribed',
      data: { channel }
    });
  }
  
  handleDisconnect(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    // Remove from all subscriptions
    for (const channel of client.subscriptions) {
      const channelSubs = this.subscriptions.get(channel);
      if (channelSubs) {
        channelSubs.delete(clientId);
        if (channelSubs.size === 0) {
          this.subscriptions.delete(channel);
        }
      }
    }
    
    this.clients.delete(clientId);
  }
  
  send(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client || client.ws.readyState !== 1) return;
    
    try {
      client.ws.send(JSON.stringify(data));
    } catch (error) {
      logger.error('Failed to send WebSocket message', { clientId, error });
    }
  }
  
  broadcast(channel, data) {
    const subscribers = this.subscriptions.get(channel);
    if (!subscribers) return;
    
    for (const clientId of subscribers) {
      this.send(clientId, {
        type: channel,
        data
      });
    }
  }
  
  async validateApiKey(apiKey) {
    // TODO: Implement actual API key validation
    return apiKey && apiKey.length === 32;
  }
}

/**
 * Unified API Server
 */
export class APIServer {
  constructor(config = {}) {
    this.config = {
      port: config.port || 8080,
      wsPort: config.wsPort || 8081,
      corsOrigins: config.corsOrigins || '*',
      enableAuth: config.enableAuth !== false,
      enableMetrics: config.enableMetrics !== false,
      ...config
    };
    
    // Express app
    this.app = express();
    this.server = createServer(this.app);
    
    // Components
    this.security = new SecuritySystem();
    this.auth = new AuthManager(config);
    this.performance = new PerformanceMonitor();
    
    this.logger = createStructuredLogger('APIServer');
  }
  
  /**
   * Initialize API server
   */
  async initialize(pool, storage, blockchain, payments) {
    // Create handlers
    this.handlers = new APIHandlers(pool, storage, blockchain, payments);
    this.wsHandlers = new WebSocketHandlers(pool, payments);
    
    // Setup middleware
    this.setupMiddleware();
    
    // Setup routes
    this.setupRoutes();
    
    // Setup WebSocket server
    this.setupWebSocket();
    
    // Setup event listeners
    this.setupEventListeners(pool, payments);
    
    this.logger.info('API server initialized');
  }
  
  /**
   * Setup middleware
   */
  setupMiddleware() {
    // Basic security headers
    this.app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      next();
    });
    
    // Basic CORS
    this.app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', this.config.corsOrigins || '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      
      next();
    });
    
    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    
    // Request sanitization
    this.app.use(sanitizeInput);
    this.app.use(preventSQLInjection);
    
    // Security middleware
    this.app.use(this.security.middleware());
    
    // Performance monitoring
    if (this.config.enableMetrics) {
      this.app.use(this.performance.middleware());
    }
    
    // Request logging
    this.app.use((req, res, next) => {
      logger.info('API request', {
        method: req.method,
        path: req.path,
        ip: req.ip
      });
      next();
    });
  }
  
  /**
   * Setup routes
   */
  setupRoutes() {
    const router = express.Router();
    
    // Public endpoints
    router.get('/stats', (req, res) => this.handlers.getPoolStats(req, res));
    router.get('/miner/:address', validators.walletAddress, (req, res) => this.handlers.getMinerInfo(req, res));
    router.get('/miner/:address/payments', validators.walletAddress, (req, res) => this.handlers.getPaymentHistory(req, res));
    router.get('/health', (req, res) => this.handlers.healthCheck(req, res));
    
    // Authenticated endpoints
    router.post('/share/submit', 
      this.auth.authenticate(),
      validators.shareSubmission,
      (req, res) => this.handlers.submitShare(req, res)
    );
    
    // Admin endpoints
    router.post('/admin/pool/fee',
      this.auth.authenticate('admin'),
      validators.amount,
      (req, res) => this.handlers.updatePoolFee(req, res)
    );
    
    router.post('/admin/payout/trigger',
      this.auth.authenticate('admin'),
      (req, res) => this.handlers.triggerPayout(req, res)
    );
    
    // Metrics endpoint
    if (this.config.enableMetrics) {
      router.get('/metrics', (req, res) => {
        const metrics = this.performance.getPrometheusMetrics();
        res.set('Content-Type', metrics.contentType);
        res.send(metrics.metrics);
      });
    }
    
    // Mount router
    this.app.use('/api', router);
    
    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        success: false,
        error: 'Not found'
      });
    });
    
    // Error handler
    this.app.use((err, req, res, next) => {
      logger.error('API error', err);
      
      res.status(err.status || 500).json({
        success: false,
        error: err.message || 'Internal server error'
      });
    });
  }
  
  /**
   * Setup WebSocket server
   */
  setupWebSocket() {
    this.wss = new WebSocketServer({ 
      server: this.server,
      path: '/ws'
    });
    
    this.wss.on('connection', (ws, req) => {
      this.wsHandlers.handleConnection(ws, req);
    });
  }
  
  /**
   * Setup event listeners
   */
  setupEventListeners(pool, payments) {
    // Pool events
    pool.on('stats:updated', (stats) => {
      this.wsHandlers.broadcast('pool_stats', stats);
    });
    
    pool.on('block:found', (block) => {
      this.wsHandlers.broadcast('blocks', {
        type: 'found',
        block
      });
    });
    
    pool.on('miner:connected', (miner) => {
      this.wsHandlers.broadcast(`miner:${miner.address}`, {
        type: 'connected',
        miner
      });
    });
    
    // Payment events
    payments.on('payment:sent', (payment) => {
      this.wsHandlers.broadcast(`miner:${payment.address}`, {
        type: 'payment',
        payment
      });
    });
  }
  
  /**
   * Start API server
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, (err) => {
        if (err) {
          reject(err);
          return;
        }
        
        this.logger.info('API server started', {
          port: this.config.port,
          ws: true
        });
        
        resolve();
      });
    });
  }
  
  /**
   * Stop API server
   */
  async stop() {
    return new Promise((resolve) => {
      // Close WebSocket connections
      for (const [clientId, client] of this.wsHandlers.clients) {
        client.ws.close();
      }
      
      // Close server
      this.server.close(() => {
        this.logger.info('API server stopped');
        resolve();
      });
    });
  }
}

export default APIServer;