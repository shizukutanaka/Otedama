/**
 * Unified API Server for Otedama
 * Consolidated REST and WebSocket APIs
 * 
 * Design:
 * - Carmack: High-performance API handling
 * - Martin: Clean API architecture
 * - Pike: Simple but powerful API design
 */

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