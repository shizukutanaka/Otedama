/**
 * Mining Pool API Server - Otedama
 * REST API for mining pool operations
 * 
 * Features:
 * - Pool statistics
 * - Miner information
 * - Payment history
 * - Real-time updates via WebSocket
 * - Admin endpoints
 */

import { createLogger } from '../core/logger.js';
import { createAPIServer, APIResponse, Validators } from '../api/index.js';

const logger = createLogger('MiningPoolAPI');

/**
 * Mining Pool API
 */
export class MiningPoolAPI {
  constructor(options = {}) {
    this.port = options.port || 8080;
    this.enableAuth = options.enableAuth || false;
    this.apiKey = options.apiKey || null;
    
    // API server instance
    this.apiServer = createAPIServer({
      port: this.port,
      enableAuth: this.enableAuth,
      apiKey: this.apiKey
    });
    
    // Pool reference
    this.pool = null;
  }
  
  /**
   * Start API server
   */
  async start(pool) {
    this.pool = pool;
    
    // Register routes
    this.registerRoutes();
    
    // Setup WebSocket handlers
    this.setupWebSocketHandlers();
    
    // Start server
    await this.apiServer.start();
    
    logger.info(`Mining pool API started on port ${this.port}`);
  }
  
  /**
   * Register API routes
   */
  registerRoutes() {
    // Pool statistics
    this.apiServer.route('GET', '/api/stats', async (req, res) => {
      const stats = this.pool.getStats();
      res.json(APIResponse.success(stats));
    });
    
    // Miner statistics
    this.apiServer.route('GET', '/api/miner/:address', async (req, res) => {
      const { address } = req.params;
      
      if (!Validators.isValidAddress(address)) {
        return res.status(400).json(
          APIResponse.error('Invalid address format', 'INVALID_ADDRESS')
        );
      }
      
      const miners = this.pool.minerManager.getMinersByAddress(address);
      const stats = miners.map(miner => this.pool.minerManager.getMinerStats(miner.id));
      
      res.json(APIResponse.success({
        address,
        workers: stats,
        totalHashrate: stats.reduce((sum, s) => sum + (s?.hashrate || 0), 0)
      }));
    });
    
    // Payment history
    this.apiServer.route('GET', '/api/payments/:address', async (req, res) => {
      const { address } = req.params;
      const { page = 1, pageSize = 50 } = req.query;
      
      if (!Validators.isValidAddress(address)) {
        return res.status(400).json(
          APIResponse.error('Invalid address format', 'INVALID_ADDRESS')
        );
      }
      
      const { page: p, pageSize: ps } = Validators.validatePagination(page, pageSize);
      
      const history = await this.pool.paymentProcessor.getPaymentHistory(address, ps);
      const total = history.length; // Would be from count query
      
      res.json(APIResponse.paginated(history, p, ps, total));
    });
    
    // Pending balance
    this.apiServer.route('GET', '/api/balance/:address', async (req, res) => {
      const { address } = req.params;
      
      if (!Validators.isValidAddress(address)) {
        return res.status(400).json(
          APIResponse.error('Invalid address format', 'INVALID_ADDRESS')
        );
      }
      
      const balances = this.pool.paymentProcessor.getPendingBalances();
      const balance = balances.find(b => b.address === address);
      
      res.json(APIResponse.success(balance || {
        address,
        amount: 0,
        minimumPayment: this.pool.config.minimumPayment
      }));
    });
    
    // Recent blocks
    this.apiServer.route('GET', '/api/blocks', async (req, res) => {
      const { limit = 10 } = req.query;
      const blocks = this.pool.storage.blockStore.getRecentBlocks(parseInt(limit));
      
      res.json(APIResponse.success(blocks));
    });
    
    // Top miners
    this.apiServer.route('GET', '/api/miners/top', async (req, res) => {
      const { limit = 10 } = req.query;
      const topMiners = this.pool.minerManager.getTopMiners(parseInt(limit));
      
      res.json(APIResponse.success(topMiners));
    });
    
    // Estimated earnings
    this.apiServer.route('GET', '/api/earnings/:address', async (req, res) => {
      const { address } = req.params;
      
      if (!Validators.isValidAddress(address)) {
        return res.status(400).json(
          APIResponse.error('Invalid address format', 'INVALID_ADDRESS')
        );
      }
      
      const earnings = await this.pool.paymentProcessor.getEstimatedEarnings(address);
      
      if (!earnings) {
        return res.status(404).json(
          APIResponse.error('Miner not found', 'NOT_FOUND')
        );
      }
      
      res.json(APIResponse.success(earnings));
    });
    
    // Pool configuration
    this.apiServer.route('GET', '/api/config', async (req, res) => {
      res.json(APIResponse.success({
        poolName: this.pool.config.poolName,
        algorithm: this.pool.config.algorithm,
        paymentScheme: this.pool.config.paymentScheme,
        minimumPayment: this.pool.config.minimumPayment,
        poolFee: this.pool.config.poolFee,
        ports: {
          stratum: this.pool.config.port,
          stratumV2: this.pool.config.port + 3,
          p2p: this.pool.config.p2pPort
        }
      }));
    });
    
    // Connection info
    this.apiServer.route('GET', '/api/connection', async (req, res) => {
      res.json(APIResponse.success({
        stratumUrl: `stratum+tcp://${req.hostname}:${this.pool.config.port}`,
        stratumV2Url: `stratum2+tcp://${req.hostname}:${this.pool.config.port + 3}`,
        exampleUser: 'YOUR_WALLET_ADDRESS.WORKER_NAME',
        examplePassword: 'x'
      }));
    });
    
    // Health check
    this.apiServer.route('GET', '/health', async (req, res) => {
      const poolStats = this.pool.getStats();
      const healthy = poolStats.connectedMiners > 0;
      
      res.status(healthy ? 200 : 503).json({
        status: healthy ? 'healthy' : 'unhealthy',
        timestamp: Date.now(),
        miners: poolStats.connectedMiners,
        hashrate: poolStats.hashrate
      });
    });
    
    // Admin endpoints (require auth)
    if (this.enableAuth) {
      // Ban miner
      this.apiServer.route('POST', '/api/admin/ban', async (req, res) => {
        const { address, reason } = req.body;
        
        if (!address || !Validators.isValidAddress(address)) {
          return res.status(400).json(
            APIResponse.error('Invalid address', 'INVALID_ADDRESS')
          );
        }
        
        this.pool.minerManager.banAddress(address, reason || 'Admin ban');
        
        res.json(APIResponse.success({
          message: 'Address banned successfully',
          address
        }));
      });
      
      // Unban miner
      this.apiServer.route('POST', '/api/admin/unban', async (req, res) => {
        const { address } = req.body;
        
        if (!address || !Validators.isValidAddress(address)) {
          return res.status(400).json(
            APIResponse.error('Invalid address', 'INVALID_ADDRESS')
          );
        }
        
        this.pool.minerManager.unbanAddress(address);
        
        res.json(APIResponse.success({
          message: 'Address unbanned successfully',
          address
        }));
      });
      
      // Force payment run
      this.apiServer.route('POST', '/api/admin/payments/process', async (req, res) => {
        try {
          const payments = await this.pool.paymentProcessor.processPayments();
          
          res.json(APIResponse.success({
            message: 'Payments processed successfully',
            count: payments.length,
            total: payments.reduce((sum, p) => sum + p.amount, 0)
          }));
        } catch (error) {
          res.status(500).json(
            APIResponse.error('Payment processing failed', 'PAYMENT_ERROR', error.message)
          );
        }
      });
    }
  }
  
  /**
   * Setup WebSocket handlers
   */
  setupWebSocketHandlers() {
    // Pool events
    this.pool.on('miner:connected', (data) => {
      this.apiServer.broadcast('miner:connected', data, 'miners');
    });
    
    this.pool.on('miner:disconnected', (data) => {
      this.apiServer.broadcast('miner:disconnected', data, 'miners');
    });
    
    this.pool.on('share:valid', (data) => {
      this.apiServer.broadcast('share:valid', data, 'shares');
    });
    
    this.pool.on('block:found', (data) => {
      this.apiServer.broadcast('block:found', data, 'blocks');
    });
    
    this.pool.on('payment:sent', (data) => {
      this.apiServer.broadcast('payment:sent', data, 'payments');
    });
    
    this.pool.on('stats:updated', (data) => {
      this.apiServer.broadcast('stats:updated', data, 'stats');
    });
    
    // WebSocket message handlers
    this.apiServer.on('ws:subscribe:miner', ({ client, data }) => {
      if (data.address && Validators.isValidAddress(data.address)) {
        client.minerAddress = data.address;
        this.sendMinerUpdate(client);
      }
    });
    
    // Periodic updates
    setInterval(() => {
      this.sendPeriodicUpdates();
    }, 5000); // Every 5 seconds
  }
  
  /**
   * Send miner update to specific client
   */
  sendMinerUpdate(client) {
    if (!client.minerAddress) return;
    
    const miners = this.pool.minerManager.getMinersByAddress(client.minerAddress);
    const stats = miners.map(miner => this.pool.minerManager.getMinerStats(miner.id));
    
    this.apiServer.sendToClient(client, 'miner:update', {
      address: client.minerAddress,
      workers: stats,
      totalHashrate: stats.reduce((sum, s) => sum + (s?.hashrate || 0), 0)
    });
  }
  
  /**
   * Send periodic updates
   */
  sendPeriodicUpdates() {
    // Send pool stats
    const stats = this.pool.getStats();
    this.apiServer.broadcast('stats:update', stats, 'stats');
    
    // Send miner updates to subscribed clients
    for (const client of this.apiServer.clients) {
      if (client.minerAddress) {
        this.sendMinerUpdate(client);
      }
    }
  }
  
  /**
   * Stop API server
   */
  async stop() {
    await this.apiServer.stop();
    logger.info('Mining pool API stopped');
  }
}

export default MiningPoolAPI;
