/**
 * Unified API Router for Otedama
 * Integrates Mining, DEX, and DeFi endpoints
 * 
 * Design principles:
 * - RESTful API design (Martin)
 * - High performance routing (Carmack)
 * - Simple and intuitive endpoints (Pike)
 */

const express = require('express');
const { createLogger } = require('../core/logger');
const { authenticateToken } = require('../auth/middleware');
const { rateLimiter } = require('../security/advanced-rate-limiter');

const logger = createLogger('UnifiedAPI');

/**
 * Create unified API router
 */
function createUnifiedRouter(components) {
  const router = express.Router();
  
  // Validate components
  if (!components || typeof components !== 'object') {
    throw new Error('Components object is required for unified router');
  }
  
  const { pool, dex, defi, monitor } = components;
  
  // Log component status
  logger.info('Initializing unified router with components:', {
    mining: !!pool,
    dex: !!dex,
    defi: !!defi,
    monitor: !!monitor
  });
  
  // Apply common middleware
  router.use(express.json({ limit: '10mb' }));
  router.use(express.urlencoded({ extended: true }));
  
  // Health check
  router.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      services: {
        mining: pool ? 'active' : 'inactive',
        dex: dex ? 'active' : 'inactive',
        defi: defi ? 'active' : 'inactive'
      },
      timestamp: Date.now()
    });
  });
  
  // ============ Mining Pool API ============
  
  // Get mining stats
  router.get('/mining/stats', async (req, res) => {
    try {
      if (!pool) {
        return res.status(503).json({ error: 'Mining pool not active' });
      }
      
      const stats = pool.getStats();
      res.json(stats);
    } catch (error) {
      logger.error('Mining stats error:', error);
      res.status(500).json({ error: 'Failed to get mining stats' });
    }
  });
  
  // Get miner info
  router.get('/mining/miner/:address', authenticateToken, async (req, res) => {
    try {
      if (!pool) {
        return res.status(503).json({ error: 'Mining pool not active' });
      }
      
      const { address } = req.params;
      const minerInfo = await pool.getMinerInfo(address);
      
      if (!minerInfo) {
        return res.status(404).json({ error: 'Miner not found' });
      }
      
      res.json(minerInfo);
    } catch (error) {
      logger.error('Miner info error:', error);
      res.status(500).json({ error: 'Failed to get miner info' });
    }
  });
  
  // Submit share
  router.post('/mining/submit', rateLimiter({ max: 100, windowMs: 60000 }), async (req, res) => {
    try {
      if (!pool) {
        return res.status(503).json({ error: 'Mining pool not active' });
      }
      
      const { minerId, jobId, nonce, hash } = req.body;
      const result = await pool.submitShare({ minerId, jobId, nonce, hash });
      
      res.json({
        accepted: result.accepted,
        difficulty: result.difficulty,
        reward: result.reward
      });
    } catch (error) {
      logger.error('Share submission error:', error);
      res.status(500).json({ error: 'Failed to submit share' });
    }
  });
  
  // ============ DEX API ============
  
  // Get order book
  router.get('/dex/orderbook/:symbol', async (req, res) => {
    try {
      if (!dex) {
        return res.status(503).json({ error: 'DEX not active' });
      }
      
      const { symbol } = req.params;
      const depth = parseInt(req.query.depth) || 20;
      
      const orderBook = await dex.getOrderBook(symbol, depth);
      res.json(orderBook);
    } catch (error) {
      logger.error('Order book error:', error);
      res.status(500).json({ error: 'Failed to get order book' });
    }
  });
  
  // Place order
  router.post('/dex/order', authenticateToken, rateLimiter({ max: 30, windowMs: 60000 }), async (req, res) => {
    try {
      if (!dex) {
        return res.status(503).json({ error: 'DEX not active' });
      }
      
      const orderParams = {
        ...req.body,
        userId: req.user.id
      };
      
      const result = await dex.placeOrder(orderParams);
      res.json(result);
    } catch (error) {
      logger.error('Place order error:', error);
      res.status(500).json({ error: 'Failed to place order' });
    }
  });
  
  // Cancel order
  router.delete('/dex/order/:orderId', authenticateToken, async (req, res) => {
    try {
      if (!dex) {
        return res.status(503).json({ error: 'DEX not active' });
      }
      
      const { orderId } = req.params;
      const result = await dex.cancelOrder(orderId, req.user.id);
      
      res.json(result);
    } catch (error) {
      logger.error('Cancel order error:', error);
      res.status(500).json({ error: 'Failed to cancel order' });
    }
  });
  
  // Get user orders
  router.get('/dex/orders', authenticateToken, async (req, res) => {
    try {
      if (!dex) {
        return res.status(503).json({ error: 'DEX not active' });
      }
      
      const orders = await dex.getUserActiveOrders(req.user.id);
      res.json({ orders });
    } catch (error) {
      logger.error('Get orders error:', error);
      res.status(500).json({ error: 'Failed to get orders' });
    }
  });
  
  // Get trading pairs
  router.get('/dex/pairs', async (req, res) => {
    try {
      if (!dex) {
        return res.status(503).json({ error: 'DEX not active' });
      }
      
      const pairs = Array.from(dex.tradingPairs.values());
      res.json({ pairs });
    } catch (error) {
      logger.error('Get pairs error:', error);
      res.status(500).json({ error: 'Failed to get trading pairs' });
    }
  });
  
  // Get 24h ticker
  router.get('/dex/ticker/:symbol', async (req, res) => {
    try {
      if (!dex) {
        return res.status(503).json({ error: 'DEX not active' });
      }
      
      const { symbol } = req.params;
      const pair = dex.tradingPairs.get(symbol);
      
      if (!pair) {
        return res.status(404).json({ error: 'Trading pair not found' });
      }
      
      const bestBidAsk = await dex.getBestBidAsk(symbol);
      
      res.json({
        symbol: pair.symbol,
        lastPrice: pair.lastPrice,
        volume24h: pair.volume24h,
        high24h: pair.high24h,
        low24h: pair.low24h,
        bid: bestBidAsk.bid?.price || 0,
        ask: bestBidAsk.ask?.price || 0,
        spread: bestBidAsk.spread || 0
      });
    } catch (error) {
      logger.error('Ticker error:', error);
      res.status(500).json({ error: 'Failed to get ticker' });
    }
  });
  
  // ============ DeFi API ============
  
  // Get DeFi overview
  router.get('/defi/overview', async (req, res) => {
    try {
      if (!defi) {
        return res.status(503).json({ error: 'DeFi not active' });
      }
      
      const metrics = defi.getMetrics();
      res.json(metrics);
    } catch (error) {
      logger.error('DeFi overview error:', error);
      res.status(500).json({ error: 'Failed to get DeFi overview' });
    }
  });
  
  // === Yield Farming ===
  
  // Get yield pools
  router.get('/defi/yield/pools', async (req, res) => {
    try {
      if (!defi?.yieldFarming) {
        return res.status(503).json({ error: 'Yield farming not active' });
      }
      
      const pools = defi.yieldFarming.getAllPools();
      res.json({ pools });
    } catch (error) {
      logger.error('Get yield pools error:', error);
      res.status(500).json({ error: 'Failed to get yield pools' });
    }
  });
  
  // Stake in yield pool
  router.post('/defi/yield/stake', authenticateToken, async (req, res) => {
    try {
      if (!defi?.yieldFarming) {
        return res.status(503).json({ error: 'Yield farming not active' });
      }
      
      const { poolId, amount, lockPeriod } = req.body;
      const position = await defi.yieldFarming.stake(req.user.id, poolId, amount, lockPeriod);
      
      res.json({ success: true, position });
    } catch (error) {
      logger.error('Stake error:', error);
      res.status(500).json({ error: 'Failed to stake' });
    }
  });
  
  // Unstake from yield pool
  router.post('/defi/yield/unstake', authenticateToken, async (req, res) => {
    try {
      if (!defi?.yieldFarming) {
        return res.status(503).json({ error: 'Yield farming not active' });
      }
      
      const { positionId, amount } = req.body;
      const result = await defi.yieldFarming.unstake(req.user.id, positionId, amount);
      
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('Unstake error:', error);
      res.status(500).json({ error: 'Failed to unstake' });
    }
  });
  
  // === Lending ===
  
  // Get lending pools
  router.get('/defi/lending/pools', async (req, res) => {
    try {
      if (!defi?.lending) {
        return res.status(503).json({ error: 'Lending not active' });
      }
      
      const pools = [];
      for (const [asset, pool] of defi.lending.lendingPools) {
        pools.push({
          asset,
          ...pool
        });
      }
      
      res.json({ pools });
    } catch (error) {
      logger.error('Get lending pools error:', error);
      res.status(500).json({ error: 'Failed to get lending pools' });
    }
  });
  
  // Deposit collateral
  router.post('/defi/lending/deposit', authenticateToken, async (req, res) => {
    try {
      if (!defi?.lending) {
        return res.status(503).json({ error: 'Lending not active' });
      }
      
      const { asset, amount } = req.body;
      const depositId = await defi.lending.depositCollateral(req.user.id, asset, amount);
      
      res.json({ success: true, depositId });
    } catch (error) {
      logger.error('Deposit collateral error:', error);
      res.status(500).json({ error: 'Failed to deposit collateral' });
    }
  });
  
  // Borrow
  router.post('/defi/lending/borrow', authenticateToken, async (req, res) => {
    try {
      if (!defi?.lending) {
        return res.status(503).json({ error: 'Lending not active' });
      }
      
      const { collateralAsset, collateralAmount, borrowAsset, borrowAmount } = req.body;
      const loanId = await defi.lending.borrow(
        req.user.id,
        collateralAsset,
        collateralAmount,
        borrowAsset,
        borrowAmount
      );
      
      res.json({ success: true, loanId });
    } catch (error) {
      logger.error('Borrow error:', error);
      res.status(500).json({ error: 'Failed to borrow' });
    }
  });
  
  // Repay loan
  router.post('/defi/lending/repay', authenticateToken, async (req, res) => {
    try {
      if (!defi?.lending) {
        return res.status(503).json({ error: 'Lending not active' });
      }
      
      const { loanId, amount } = req.body;
      const result = await defi.lending.repay(req.user.id, loanId, amount);
      
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('Repay error:', error);
      res.status(500).json({ error: 'Failed to repay loan' });
    }
  });
  
  // === Staking ===
  
  // Get validators
  router.get('/defi/staking/validators', async (req, res) => {
    try {
      if (!defi?.staking) {
        return res.status(503).json({ error: 'Staking not active' });
      }
      
      const validators = defi.staking.getValidators();
      res.json({ validators });
    } catch (error) {
      logger.error('Get validators error:', error);
      res.status(500).json({ error: 'Failed to get validators' });
    }
  });
  
  // Create validator
  router.post('/defi/staking/validator', authenticateToken, async (req, res) => {
    try {
      if (!defi?.staking) {
        return res.status(503).json({ error: 'Staking not active' });
      }
      
      const { selfStake, commission } = req.body;
      const validatorId = await defi.staking.createValidator(req.user.id, selfStake, commission);
      
      res.json({ success: true, validatorId });
    } catch (error) {
      logger.error('Create validator error:', error);
      res.status(500).json({ error: 'Failed to create validator' });
    }
  });
  
  // Delegate to validator
  router.post('/defi/staking/delegate', authenticateToken, async (req, res) => {
    try {
      if (!defi?.staking) {
        return res.status(503).json({ error: 'Staking not active' });
      }
      
      const { validatorId, amount } = req.body;
      const delegationId = await defi.staking.delegate(req.user.id, validatorId, amount);
      
      res.json({ success: true, delegationId });
    } catch (error) {
      logger.error('Delegate error:', error);
      res.status(500).json({ error: 'Failed to delegate' });
    }
  });
  
  // ============ Monitoring API ============
  
  // Get system metrics
  router.get('/monitor/metrics', authenticateToken, async (req, res) => {
    try {
      if (!monitor) {
        return res.status(503).json({ error: 'Monitoring not active' });
      }
      
      const metrics = monitor.getCurrentMetrics();
      res.json(metrics);
    } catch (error) {
      logger.error('Get metrics error:', error);
      res.status(500).json({ error: 'Failed to get metrics' });
    }
  });
  
  // Get performance report
  router.get('/monitor/report', authenticateToken, async (req, res) => {
    try {
      if (!monitor) {
        return res.status(503).json({ error: 'Monitoring not active' });
      }
      
      const type = req.query.type || 'daily';
      const report = await monitor.generateReport(type);
      res.json(report);
    } catch (error) {
      logger.error('Get report error:', error);
      res.status(500).json({ error: 'Failed to get report' });
    }
  });
  
  // WebSocket endpoint info
  router.get('/ws/info', (req, res) => {
    const wsProtocol = req.secure ? 'wss' : 'ws';
    const wsHost = req.get('host') || `${process.env.API_HOST || 'localhost'}:${process.env.WS_PORT || 8080}`;
    
    res.json({
      endpoints: {
        mining: `${wsProtocol}://${wsHost}/ws/mining`,
        dex: `${wsProtocol}://${wsHost}/ws/dex`,
        defi: `${wsProtocol}://${wsHost}/ws/defi`
      },
      events: {
        mining: ['share:accepted', 'block:found', 'miner:connected'],
        dex: ['order:placed', 'order:filled', 'trade', 'orderbook:update'],
        defi: ['position:opened', 'position:closed', 'reward:distributed']
      }
    });
  });
  
  return router;
}

module.exports = { createUnifiedRouter };