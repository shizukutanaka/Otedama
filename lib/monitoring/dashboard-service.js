/**
 * Otedama Real-time Dashboard Service
 * High-performance WebSocket-based monitoring dashboard
 * 
 * Design principles:
 * - Carmack: Minimal latency, efficient data transfer
 * - Martin: Clean separation of concerns
 * - Pike: Simple but powerful implementation
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import { WebSocketServer } from 'ws';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger('DashboardService');

/**
 * Dashboard update types
 */
export const UpdateType = {
  POOL_STATS: 'pool_stats',
  MINER_UPDATE: 'miner_update',
  BLOCK_FOUND: 'block_found',
  PAYMENT_SENT: 'payment_sent',
  ALERT: 'alert',
  NETWORK_STATS: 'network_stats',
  PERFORMANCE_METRICS: 'performance_metrics'
};

/**
 * Real-time Dashboard Service
 */
export class DashboardService extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      port: config.port || 8081,
      wsPath: config.wsPath || '/ws',
      updateInterval: config.updateInterval || 1000,
      maxClients: config.maxClients || 1000,
      compression: config.compression !== false,
      authentication: config.authentication || false
    };
    
    // Express app
    this.app = express();
    this.server = null;
    this.wss = null;
    
    // Connected clients
    this.clients = new Map(); // id -> client info
    
    // Data cache for new connections
    this.dataCache = {
      poolStats: null,
      minerStats: new Map(),
      recentBlocks: [],
      recentPayments: [],
      networkStats: null,
      performanceMetrics: null
    };
    
    // Update timers
    this.updateTimer = null;
    
    // Statistics
    this.stats = {
      totalConnections: 0,
      activeConnections: 0,
      messagesSent: 0,
      bytesTransferred: 0
    };
  }
  
  /**
   * Initialize dashboard service
   */
  async initialize() {
    logger.info('Initializing dashboard service...');
    
    // Setup Express middleware
    this.setupMiddleware();
    
    // Setup routes
    this.setupRoutes();
    
    // Create HTTP server
    this.server = http.createServer(this.app);
    
    // Create WebSocket server
    this.wss = new WebSocketServer({
      server: this.server,
      path: this.config.wsPath,
      perMessageDeflate: this.config.compression ? {
        zlibDeflateOptions: {
          chunkSize: 1024,
          memLevel: 7,
          level: 3
        },
        zlibInflateOptions: {
          chunkSize: 10 * 1024
        },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        serverMaxWindowBits: 10,
        concurrencyLimit: 10,
        threshold: 1024
      } : false
    });
    
    // Setup WebSocket handlers
    this.setupWebSocketHandlers();
    
    // Start server
    await new Promise((resolve, reject) => {
      this.server.listen(this.config.port, (error) => {
        if (error) {
          reject(error);
        } else {
          logger.info(`Dashboard service listening on port ${this.config.port}`);
          resolve();
        }
      });
    });
    
    // Start update timer
    this.startUpdateTimer();
    
    logger.info('Dashboard service initialized');
  }
  
  /**
   * Setup Express middleware
   */
  setupMiddleware() {
    // JSON parsing
    this.app.use(express.json());
    
    // CORS
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      next();
    });
    
    // Static files
    const publicPath = path.join(__dirname, '../../../public');
    this.app.use(express.static(publicPath));
    
    // Compression
    if (this.config.compression) {
      // Add compression middleware if needed
    }
  }
  
  /**
   * Setup routes
   */
  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        uptime: process.uptime(),
        connections: this.stats.activeConnections
      });
    });
    
    // Dashboard stats
    this.app.get('/api/dashboard/stats', (req, res) => {
      res.json({
        poolStats: this.dataCache.poolStats,
        networkStats: this.dataCache.networkStats,
        performanceMetrics: this.dataCache.performanceMetrics,
        recentBlocks: this.dataCache.recentBlocks.slice(-10),
        recentPayments: this.dataCache.recentPayments.slice(-10)
      });
    });
    
    // Miner stats
    this.app.get('/api/dashboard/miners', (req, res) => {
      const miners = Array.from(this.dataCache.minerStats.values());
      res.json({
        count: miners.length,
        miners: miners.slice(0, 100) // Limit to top 100
      });
    });
    
    // Dashboard HTML
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '../../../public/dashboard.html'));
    });
  }
  
  /**
   * Setup WebSocket handlers
   */
  setupWebSocketHandlers() {
    this.wss.on('connection', (ws, req) => {
      const clientId = this.generateClientId();
      const clientIp = req.socket.remoteAddress;
      
      // Check max clients
      if (this.clients.size >= this.config.maxClients) {
        ws.close(1008, 'Max clients reached');
        return;
      }
      
      // Store client info
      const client = {
        id: clientId,
        ws,
        ip: clientIp,
        connectedAt: Date.now(),
        authenticated: !this.config.authentication,
        subscriptions: new Set(['all']),
        lastActivity: Date.now()
      };
      
      this.clients.set(clientId, client);
      this.stats.totalConnections++;
      this.stats.activeConnections++;
      
      logger.info(`Dashboard client connected: ${clientId} from ${clientIp}`);
      
      // Send initial data
      this.sendInitialData(client);
      
      // Handle messages
      ws.on('message', (data) => {
        this.handleClientMessage(client, data);
      });
      
      // Handle close
      ws.on('close', () => {
        this.clients.delete(clientId);
        this.stats.activeConnections--;
        logger.info(`Dashboard client disconnected: ${clientId}`);
      });
      
      // Handle errors
      ws.on('error', (error) => {
        logger.error(`WebSocket error for client ${clientId}:`, error);
      });
      
      // Send welcome message
      this.sendToClient(client, {
        type: 'welcome',
        clientId,
        timestamp: Date.now()
      });
    });
  }
  
  /**
   * Generate client ID
   */
  generateClientId() {
    return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Send initial data to client
   */
  sendInitialData(client) {
    // Send cached data
    if (this.dataCache.poolStats) {
      this.sendToClient(client, {
        type: UpdateType.POOL_STATS,
        data: this.dataCache.poolStats
      });
    }
    
    if (this.dataCache.networkStats) {
      this.sendToClient(client, {
        type: UpdateType.NETWORK_STATS,
        data: this.dataCache.networkStats
      });
    }
    
    if (this.dataCache.performanceMetrics) {
      this.sendToClient(client, {
        type: UpdateType.PERFORMANCE_METRICS,
        data: this.dataCache.performanceMetrics
      });
    }
    
    // Send recent blocks
    if (this.dataCache.recentBlocks.length > 0) {
      this.sendToClient(client, {
        type: 'recent_blocks',
        data: this.dataCache.recentBlocks.slice(-10)
      });
    }
    
    // Send recent payments
    if (this.dataCache.recentPayments.length > 0) {
      this.sendToClient(client, {
        type: 'recent_payments',
        data: this.dataCache.recentPayments.slice(-10)
      });
    }
  }
  
  /**
   * Handle client message
   */
  handleClientMessage(client, data) {
    try {
      const message = JSON.parse(data.toString());
      
      client.lastActivity = Date.now();
      
      switch (message.type) {
        case 'authenticate':
          this.handleAuthentication(client, message.token);
          break;
          
        case 'subscribe':
          this.handleSubscription(client, message.channels);
          break;
          
        case 'unsubscribe':
          this.handleUnsubscription(client, message.channels);
          break;
          
        case 'ping':
          this.sendToClient(client, { type: 'pong', timestamp: Date.now() });
          break;
          
        default:
          logger.warn(`Unknown message type from client ${client.id}: ${message.type}`);
      }
      
    } catch (error) {
      logger.error(`Error handling client message:`, error);
    }
  }
  
  /**
   * Handle authentication
   */
  handleAuthentication(client, token) {
    // Simple token validation (implement your own logic)
    if (this.config.authentication && token === this.config.authToken) {
      client.authenticated = true;
      this.sendToClient(client, {
        type: 'authenticated',
        success: true
      });
    } else {
      this.sendToClient(client, {
        type: 'authenticated',
        success: false
      });
    }
  }
  
  /**
   * Handle subscription
   */
  handleSubscription(client, channels) {
    if (!Array.isArray(channels)) channels = [channels];
    
    for (const channel of channels) {
      client.subscriptions.add(channel);
    }
    
    this.sendToClient(client, {
      type: 'subscribed',
      channels
    });
  }
  
  /**
   * Handle unsubscription
   */
  handleUnsubscription(client, channels) {
    if (!Array.isArray(channels)) channels = [channels];
    
    for (const channel of channels) {
      client.subscriptions.delete(channel);
    }
    
    this.sendToClient(client, {
      type: 'unsubscribed',
      channels
    });
  }
  
  /**
   * Send to client
   */
  sendToClient(client, message) {
    if (client.ws.readyState === 1) { // WebSocket.OPEN
      try {
        const data = JSON.stringify(message);
        client.ws.send(data);
        
        this.stats.messagesSent++;
        this.stats.bytesTransferred += Buffer.byteLength(data);
        
      } catch (error) {
        logger.error(`Error sending to client ${client.id}:`, error);
      }
    }
  }
  
  /**
   * Broadcast to all clients
   */
  broadcast(message, channel = 'all') {
    for (const client of this.clients.values()) {
      if (client.authenticated && client.subscriptions.has(channel)) {
        this.sendToClient(client, message);
      }
    }
  }
  
  /**
   * Update pool statistics
   */
  updatePoolStats(stats) {
    this.dataCache.poolStats = {
      ...stats,
      timestamp: Date.now()
    };
    
    this.broadcast({
      type: UpdateType.POOL_STATS,
      data: this.dataCache.poolStats
    });
  }
  
  /**
   * Update miner statistics
   */
  updateMinerStats(minerId, stats) {
    this.dataCache.minerStats.set(minerId, {
      ...stats,
      timestamp: Date.now()
    });
    
    this.broadcast({
      type: UpdateType.MINER_UPDATE,
      data: {
        minerId,
        stats
      }
    }, 'miners');
  }
  
  /**
   * Notify block found
   */
  notifyBlockFound(block) {
    const blockData = {
      ...block,
      timestamp: Date.now()
    };
    
    this.dataCache.recentBlocks.push(blockData);
    if (this.dataCache.recentBlocks.length > 100) {
      this.dataCache.recentBlocks.shift();
    }
    
    this.broadcast({
      type: UpdateType.BLOCK_FOUND,
      data: blockData
    });
  }
  
  /**
   * Notify payment sent
   */
  notifyPaymentSent(payment) {
    const paymentData = {
      ...payment,
      timestamp: Date.now()
    };
    
    this.dataCache.recentPayments.push(paymentData);
    if (this.dataCache.recentPayments.length > 100) {
      this.dataCache.recentPayments.shift();
    }
    
    this.broadcast({
      type: UpdateType.PAYMENT_SENT,
      data: paymentData
    });
  }
  
  /**
   * Send alert
   */
  sendAlert(alert) {
    this.broadcast({
      type: UpdateType.ALERT,
      data: {
        ...alert,
        timestamp: Date.now()
      }
    });
  }
  
  /**
   * Update network statistics
   */
  updateNetworkStats(stats) {
    this.dataCache.networkStats = {
      ...stats,
      timestamp: Date.now()
    };
    
    this.broadcast({
      type: UpdateType.NETWORK_STATS,
      data: this.dataCache.networkStats
    });
  }
  
  /**
   * Update performance metrics
   */
  updatePerformanceMetrics(metrics) {
    this.dataCache.performanceMetrics = {
      ...metrics,
      timestamp: Date.now()
    };
    
    this.broadcast({
      type: UpdateType.PERFORMANCE_METRICS,
      data: this.dataCache.performanceMetrics
    });
  }
  
  /**
   * Start update timer
   */
  startUpdateTimer() {
    this.updateTimer = setInterval(() => {
      // Clean up inactive clients
      const now = Date.now();
      for (const [clientId, client] of this.clients.entries()) {
        if (now - client.lastActivity > 300000) { // 5 minutes
          client.ws.close(1000, 'Inactive');
          this.clients.delete(clientId);
          this.stats.activeConnections--;
        }
      }
      
      // Emit stats
      this.emit('stats', {
        ...this.stats,
        cacheSize: this.dataCache.minerStats.size
      });
      
    }, this.config.updateInterval);
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      clients: Array.from(this.clients.values()).map(client => ({
        id: client.id,
        ip: client.ip,
        connectedAt: client.connectedAt,
        authenticated: client.authenticated,
        subscriptions: Array.from(client.subscriptions)
      }))
    };
  }
  
  /**
   * Shutdown service
   */
  async shutdown() {
    logger.info('Shutting down dashboard service...');
    
    // Stop update timer
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }
    
    // Close all connections
    for (const client of this.clients.values()) {
      client.ws.close(1001, 'Server shutting down');
    }
    
    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
    }
    
    // Close HTTP server
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
    }
    
    logger.info('Dashboard service shutdown complete');
  }
}

export default DashboardService;
