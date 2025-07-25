/**
 * Mining Pool Web Dashboard & API Server
 * Real-time monitoring and management interface
 * 
 * Features:
 * - Real-time statistics
 * - Miner management
 * - Payment history
 * - ASIC monitoring
 * - WebSocket updates
 */

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { createLogger } from '../core/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = createLogger('PoolAPI');

export class PoolAPIServer {
  constructor(poolManager, config = {}) {
    this.poolManager = poolManager;
    this.config = {
      port: config.port || 8080,
      wsPort: config.wsPort || 8081,
      enableCORS: config.enableCORS !== false,
      corsOrigins: config.corsOrigins || '*',
      apiPrefix: config.apiPrefix || '/api',
      enableWebSocket: config.enableWebSocket !== false
    };
    
    // Express app
    this.app = express();
    this.server = createServer(this.app);
    
    // WebSocket
    this.io = null;
    if (this.config.enableWebSocket) {
      this.io = new SocketIOServer(this.server, {
        cors: {
          origin: this.config.corsOrigins,
          methods: ['GET', 'POST']
        }
      });
    }
    
    // Statistics cache
    this.statsCache = {
      pool: {},
      miners: new Map(),
      lastUpdate: 0
    };
    
    // Setup
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
  }
  
  /**
   * Setup middleware
   */
  setupMiddleware() {
    // JSON parsing
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    
    // CORS
    if (this.config.enableCORS) {
      this.app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', this.config.corsOrigins);
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        next();
      });
    }
    
    // Static files (dashboard)
    this.app.use(express.static(path.join(__dirname, '../../public')));
    
    // Request logging
    this.app.use((req, res, next) => {
      logger.debug(`${req.method} ${req.path}`);
      next();
    });
    
    // Error handling
    this.app.use((err, req, res, next) => {
      logger.error('API error:', err);
      res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV !== 'production' ? err.message : undefined
      });
    });
  }
  
  /**
   * Setup API routes
   */
  setupRoutes() {
    const api = express.Router();
    
    // Pool statistics
    api.get('/stats', (req, res) => {
      const stats = this.poolManager.getStats();
      res.json({
        success: true,
        data: {
          pool: {
            name: this.poolManager.config.poolName,
            algorithm: this.poolManager.config.algorithm,
            paymentScheme: this.poolManager.config.paymentScheme,
            poolFee: this.poolManager.config.poolFee,
            minimumPayment: this.poolManager.config.minimumPayment,
            mode: this.poolManager.config.poolMode
          },
          stats: {
            miners: stats.totalMiners,
            workers: stats.workers || 1,
            hashrate: stats.totalHashrate,
            shares: {
              total: stats.totalShares,
              valid: stats.validShares || stats.totalShares,
              invalid: stats.invalidShares || 0
            },
            blocks: {
              found: stats.blocksFound,
              effort: stats.poolEfficiency || 0
            },
            payments: {
              total: stats.totalPayments,
              sent: stats.payments?.paymentsSent || 0,
              pending: stats.payments?.pendingPayments || 0
            },
            uptime: stats.uptime
          }
        }
      });
    });
    
    // Current miners
    api.get('/miners', async (req, res) => {
      try {
        const miners = await this.poolManager.storage.database.all(`
          SELECT 
            m.id,
            m.address,
            m.worker,
            m.connected_at,
            ms.hashrate,
            ms.shares_valid,
            ms.shares_invalid,
            ms.last_share_at
          FROM miners m
          LEFT JOIN miner_stats ms ON m.id = ms.miner_id
          WHERE m.connected = 1
          ORDER BY ms.hashrate DESC
          LIMIT 100
        `);
        
        res.json({
          success: true,
          data: miners
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Miner details
    api.get('/miner/:address', async (req, res) => {
      try {
        const { address } = req.params;
        
        // Get miner info
        const miner = await this.poolManager.storage.database.get(`
          SELECT * FROM miners WHERE address = ?
        `, address);
        
        if (!miner) {
          return res.status(404).json({ success: false, error: 'Miner not found' });
        }
        
        // Get stats
        const stats = await this.poolManager.storage.database.get(`
          SELECT * FROM miner_stats WHERE miner_id = ?
        `, miner.id);
        
        // Get balance
        const balance = await this.poolManager.paymentProcessor.getMinerBalance(address);
        
        // Get recent shares
        const recentShares = await this.poolManager.storage.shareStore.getMinerShares(
          miner.id,
          Date.now() - 3600000, // Last hour
          Date.now()
        );
        
        res.json({
          success: true,
          data: {
            address,
            worker: miner.worker,
            connected: miner.connected,
            connectedAt: miner.connected_at,
            stats: {
              hashrate: stats?.hashrate || 0,
              sharesValid: stats?.shares_valid || 0,
              sharesInvalid: stats?.shares_invalid || 0,
              lastShareAt: stats?.last_share_at
            },
            balance: {
              pending: balance.pending,
              paid: stats?.total_paid || 0
            },
            recentShares: recentShares.length
          }
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Payment history
    api.get('/payments/:address?', async (req, res) => {
      try {
        const { address } = req.params;
        const { limit = 50, offset = 0 } = req.query;
        
        let query = `
          SELECT * FROM payments
          ${address ? 'WHERE address = ?' : ''}
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `;
        
        const params = address ? [address, limit, offset] : [limit, offset];
        const payments = await this.poolManager.storage.database.all(query, params);
        
        res.json({
          success: true,
          data: payments.map(p => ({
            ...p,
            metadata: p.metadata ? JSON.parse(p.metadata) : {}
          }))
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Blocks found
    api.get('/blocks', async (req, res) => {
      try {
        const { limit = 50, offset = 0 } = req.query;
        
        const blocks = await this.poolManager.storage.blockStore.getBlocks(limit, offset);
        
        res.json({
          success: true,
          data: blocks
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // ASIC devices
    api.get('/asics', (req, res) => {
      if (!this.poolManager.asicController) {
        return res.json({ success: true, data: [] });
      }
      
      const stats = this.poolManager.asicController.getStats();
      res.json({
        success: true,
        data: stats.devices
      });
    });
    
    // ASIC device details
    api.get('/asic/:id', (req, res) => {
      if (!this.poolManager.asicController) {
        return res.status(404).json({ success: false, error: 'ASIC controller not enabled' });
      }
      
      const device = this.poolManager.asicController.getDevice(req.params.id);
      if (!device) {
        return res.status(404).json({ success: false, error: 'Device not found' });
      }
      
      res.json({
        success: true,
        data: {
          id: device.id,
          ip: device.ip,
          model: device.model,
          vendor: device.vendor,
          status: device.status,
          stats: device.stats,
          config: {
            pool: device.config.pool,
            worker: device.config.worker,
            tempLimit: device.config.tempLimit
          }
        }
      });
    });
    
    // Configure ASIC
    api.post('/asic/:id/configure', async (req, res) => {
      if (!this.poolManager.asicController) {
        return res.status(404).json({ success: false, error: 'ASIC controller not enabled' });
      }
      
      const device = this.poolManager.asicController.getDevice(req.params.id);
      if (!device) {
        return res.status(404).json({ success: false, error: 'Device not found' });
      }
      
      try {
        const { pool, worker, password } = req.body;
        await device.configurePool(pool, worker, password);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // Health check
    api.get('/health', async (req, res) => {
      const health = await this.poolManager.healthCheckManager.checkAll();
      const healthy = Object.values(health).every(h => h.healthy);
      
      res.status(healthy ? 200 : 503).json({
        success: healthy,
        data: health
      });
    });
    
    // Mount API routes
    this.app.use(this.config.apiPrefix, api);
    
    // Catch-all for SPA
    this.app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, '../../public/index.html'));
    });
  }
  
  /**
   * Setup WebSocket
   */
  setupWebSocket() {
    if (!this.io) return;
    
    this.io.on('connection', (socket) => {
      logger.info(`WebSocket client connected: ${socket.id}`);
      
      // Send initial stats
      socket.emit('stats', this.poolManager.getStats());
      
      // Subscribe to updates
      socket.on('subscribe', (channel) => {
        socket.join(channel);
        logger.debug(`Client ${socket.id} subscribed to ${channel}`);
      });
      
      socket.on('unsubscribe', (channel) => {
        socket.leave(channel);
        logger.debug(`Client ${socket.id} unsubscribed from ${channel}`);
      });
      
      socket.on('disconnect', () => {
        logger.info(`WebSocket client disconnected: ${socket.id}`);
      });
    });
    
    // Setup pool event forwarding
    this.poolManager.on('stats:updated', (stats) => {
      this.io.emit('stats', stats);
    });
    
    this.poolManager.on('share:valid', (share) => {
      this.io.to('shares').emit('share:valid', share);
    });
    
    this.poolManager.on('block:found', (block) => {
      this.io.emit('block:found', block);
    });
    
    this.poolManager.on('miner:connected', (miner) => {
      this.io.to('miners').emit('miner:connected', miner);
    });
    
    this.poolManager.on('miner:disconnected', (miner) => {
      this.io.to('miners').emit('miner:disconnected', miner);
    });
    
    // Periodic stats broadcast
    setInterval(() => {
      this.io.emit('stats', this.poolManager.getStats());
    }, 5000);
  }
  
  /**
   * Start API server
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, (err) => {
        if (err) {
          reject(err);
        } else {
          logger.info(`API server listening on port ${this.config.port}`);
          logger.info(`Dashboard available at http://localhost:${this.config.port}`);
          if (this.io) {
            logger.info(`WebSocket server listening on port ${this.config.port}`);
          }
          resolve();
        }
      });
    });
  }
  
  /**
   * Stop API server
   */
  async stop() {
    return new Promise((resolve) => {
      if (this.io) {
        this.io.close();
      }
      
      this.server.close(() => {
        logger.info('API server stopped');
        resolve();
      });
    });
  }
}

export function createAPIServer(poolManager, config) {
  return new PoolAPIServer(poolManager, config);
}

export default PoolAPIServer;
