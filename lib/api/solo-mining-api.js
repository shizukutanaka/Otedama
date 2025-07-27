/**
 * Solo Mining API Extension
 * Adds solo mining endpoints to the API server
 * 
 * Features:
 * - Mode selection endpoints
 * - Solo statistics
 * - Real-time mode switching
 * - Fee information
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('SoloMiningAPI');

/**
 * Solo Mining API Endpoints
 */
export const SOLO_API_ENDPOINTS = {
  // Solo mining specific
  SOLO_STATUS: '/api/v1/solo/status',
  SOLO_INFO: '/api/v1/solo/info',
  SOLO_STATS: '/api/v1/solo/stats',
  SOLO_BLOCKS: '/api/v1/solo/blocks',
  
  // Mode management
  MODE_STATUS: '/api/v1/mining/mode',
  MODE_SWITCH: '/api/v1/mining/mode/switch',
  MODE_OPTIONS: '/api/v1/mining/mode/options',
  
  // Miner solo stats
  MINER_SOLO_STATS: '/api/v1/miners/:id/solo',
  MINER_MODE: '/api/v1/miners/:id/mode',
  
  // Fee information
  FEE_INFO: '/api/v1/fees',
  FEE_COMPARISON: '/api/v1/fees/comparison'
};

/**
 * Solo Mining API Extension
 */
export class SoloMiningAPI extends EventEmitter {
  constructor(apiServer, poolManager) {
    super();
    
    this.api = apiServer;
    this.pool = poolManager;
    this.soloPool = poolManager.soloPoolIntegration;
    this.soloManager = poolManager.soloMiningManager;
    
    // Register endpoints
    this.registerEndpoints();
    
    // Setup WebSocket handlers
    this.setupWebSocketHandlers();
  }
  
  /**
   * Register API endpoints
   */
  registerEndpoints() {
    // Solo status
    this.api.registerEndpoint('GET', SOLO_API_ENDPOINTS.SOLO_STATUS, 
      this.handleSoloStatus.bind(this));
    
    // Solo info
    this.api.registerEndpoint('GET', SOLO_API_ENDPOINTS.SOLO_INFO, 
      this.handleSoloInfo.bind(this));
    
    // Solo statistics
    this.api.registerEndpoint('GET', SOLO_API_ENDPOINTS.SOLO_STATS, 
      this.handleSoloStats.bind(this));
    
    // Solo blocks
    this.api.registerEndpoint('GET', SOLO_API_ENDPOINTS.SOLO_BLOCKS, 
      this.handleSoloBlocks.bind(this));
    
    // Mode status
    this.api.registerEndpoint('GET', SOLO_API_ENDPOINTS.MODE_STATUS, 
      this.handleModeStatus.bind(this));
    
    // Mode switch
    this.api.registerEndpoint('POST', SOLO_API_ENDPOINTS.MODE_SWITCH, 
      this.handleModeSwitch.bind(this));
    
    // Mode options
    this.api.registerEndpoint('GET', SOLO_API_ENDPOINTS.MODE_OPTIONS, 
      this.handleModeOptions.bind(this));
    
    // Miner solo stats
    this.api.registerEndpoint('GET', SOLO_API_ENDPOINTS.MINER_SOLO_STATS, 
      this.handleMinerSoloStats.bind(this));
    
    // Miner mode
    this.api.registerEndpoint('GET', SOLO_API_ENDPOINTS.MINER_MODE, 
      this.handleMinerMode.bind(this));
    
    // Fee info
    this.api.registerEndpoint('GET', SOLO_API_ENDPOINTS.FEE_INFO, 
      this.handleFeeInfo.bind(this));
    
    // Fee comparison
    this.api.registerEndpoint('GET', SOLO_API_ENDPOINTS.FEE_COMPARISON, 
      this.handleFeeComparison.bind(this));
  }
  
  /**
   * Setup WebSocket handlers
   */
  setupWebSocketHandlers() {
    // Listen for solo block events
    if (this.soloPool) {
      this.soloPool.on('solo:block:found', (block) => {
        this.api.broadcast('solo_block_found', block);
      });
      
      this.soloPool.on('mode:switched', (data) => {
        this.api.broadcast('mode_switched', data);
      });
    }
    
    if (this.soloManager) {
      this.soloManager.on('block:found', (block) => {
        this.api.broadcast('solo_direct_block', block);
      });
    }
  }
  
  /**
   * Handle solo status request
   */
  async handleSoloStatus(req, res) {
    try {
      const soloEnabled = this.pool.config.enableSoloMining || false;
      const soloStats = this.soloPool ? this.soloPool.getPoolStats() : null;
      const directStats = this.soloManager ? this.soloManager.getStats() : null;
      
      res.json({
        enabled: soloEnabled,
        fee: '0.5%', // Industry's lowest!
        poolStats: soloStats,
        directMiningStats: directStats,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('Solo status error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle solo info request
   */
  async handleSoloInfo(req, res) {
    try {
      res.json({
        soloMining: {
          enabled: this.pool.config.enableSoloMining,
          fee: '0.5%',
          minPayout: 0,
          instantPayouts: true,
          separatePort: this.pool.config.soloMining.separateStratumPort || 3334
        },
        poolMining: {
          fee: '1%',
          minPayout: this.pool.config.minimumPayment || 0.001,
          paymentScheme: this.pool.config.paymentScheme || 'PPLNS'
        },
        features: {
          modeSwitching: true,
          realtimeStats: true,
          mobileApp: true,
          autoPayouts: true
        },
        instructions: {
          solo: 'Connect with password "solo" or "x,solo"',
          pool: 'Connect with any password or "x,pool"',
          switching: 'Use mining.switch_mode stratum method'
        }
      });
    } catch (error) {
      logger.error('Solo info error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle solo statistics
   */
  async handleSoloStats(req, res) {
    try {
      const stats = {
        pool: this.soloPool ? {
          totalMiners: this.soloPool.stats.soloMiners,
          hashrate: this.soloPool.stats.soloHashrate,
          blocksFound: this.soloPool.stats.soloBlocks
        } : null,
        direct: this.soloManager ? {
          hashrate: this.soloManager.stats.hashrate,
          blocksFound: this.soloManager.stats.blocksFound,
          sharesProcessed: this.soloManager.stats.sharesProcessed,
          estimatedTimeToBlock: this.soloManager.stats.estimatedTimeToBlock
        } : null,
        timestamp: Date.now()
      };
      
      res.json(stats);
    } catch (error) {
      logger.error('Solo stats error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle solo blocks
   */
  async handleSoloBlocks(req, res) {
    try {
      // This would query from database in production
      const blocks = [];
      
      res.json({
        blocks,
        total: blocks.length,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('Solo blocks error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle mode status
   */
  async handleModeStatus(req, res) {
    try {
      const minerId = req.auth?.userId || req.query.minerId;
      if (!minerId) {
        return res.status(400).json({ error: 'Miner ID required' });
      }
      
      const minerStats = this.soloPool ? 
        this.soloPool.getMinerStats(minerId) : null;
      
      res.json({
        minerId,
        currentMode: minerStats?.mode || 'unknown',
        stats: minerStats,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('Mode status error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle mode switch
   */
  async handleModeSwitch(req, res) {
    try {
      const minerId = req.auth?.userId || req.body.minerId;
      const newMode = req.body.mode;
      
      if (!minerId || !newMode) {
        return res.status(400).json({ error: 'Miner ID and mode required' });
      }
      
      if (newMode !== 'solo' && newMode !== 'pool') {
        return res.status(400).json({ error: 'Invalid mode. Use "solo" or "pool"' });
      }
      
      this.soloPool.switchMode(minerId, newMode);
      
      res.json({
        success: true,
        minerId,
        newMode,
        fee: newMode === 'solo' ? '0.5%' : '1%',
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('Mode switch error:', error);
      res.status(500).json({ error: error.message });
    }
  }
  
  /**
   * Handle mode options
   */
  async handleModeOptions(req, res) {
    try {
      res.json({
        modes: [
          {
            id: 'pool',
            name: 'Pool Mining',
            description: 'Mine with others, share rewards',
            fee: '1%',
            minPayout: this.pool.config.minimumPayment || 0.001,
            paymentScheme: this.pool.config.paymentScheme || 'PPLNS',
            advantages: [
              'Steady income',
              'Lower variance',
              'Suitable for small miners'
            ]
          },
          {
            id: 'solo',
            name: 'Solo Mining',
            description: 'Mine alone, keep full block reward',
            fee: '0.5%', // Industry's lowest!
            minPayout: 0,
            paymentScheme: 'Full block reward',
            advantages: [
              'Ultra-low 0.5% fee',
              'Full block reward (minus fee)',
              'Instant payouts',
              'No sharing with others'
            ]
          }
        ],
        switchingEnabled: true,
        currentMode: req.query.minerId ? 'pool' : null // Would check actual mode
      });
    } catch (error) {
      logger.error('Mode options error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle miner solo stats
   */
  async handleMinerSoloStats(req, res) {
    try {
      const minerId = req.params.id;
      const minerStats = this.soloPool ? 
        this.soloPool.getMinerStats(minerId) : null;
      
      if (!minerStats || !minerStats.soloStats) {
        return res.status(404).json({ error: 'Miner not found or not in solo mode' });
      }
      
      res.json({
        minerId,
        soloStats: minerStats.soloStats,
        currentMode: minerStats.mode,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('Miner solo stats error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle miner mode
   */
  async handleMinerMode(req, res) {
    try {
      const minerId = req.params.id;
      const minerStats = this.soloPool ? 
        this.soloPool.getMinerStats(minerId) : null;
      
      if (!minerStats) {
        return res.status(404).json({ error: 'Miner not found' });
      }
      
      res.json({
        minerId,
        mode: minerStats.mode,
        canSwitch: true,
        fee: minerStats.mode === 'solo' ? '0.5%' : '1%',
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('Miner mode error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle fee info
   */
  async handleFeeInfo(req, res) {
    try {
      res.json({
        current: {
          solo: '0.5%',
          pool: '1%'
        },
        description: {
          solo: 'Ultra-low fee for solo mining - Industry\'s lowest!',
          pool: 'Standard pool fee with PPLNS rewards'
        },
        comparison: 'Our 0.5% solo fee is the lowest in the industry!',
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('Fee info error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle fee comparison
   */
  async handleFeeComparison(req, res) {
    try {
      res.json({
        otedama: {
          solo: '0.5%',
          pool: '1%',
          highlight: 'LOWEST SOLO FEE'
        },
        competitors: [
          { name: 'Luxor', solo: '0.7%', pool: '0.7%' },
          { name: 'BTC.com', solo: '1.0%', pool: '1.0%' },
          { name: 'Solo.CKPool', solo: '1-2%', pool: 'N/A' },
          { name: 'F2Pool', solo: '2.5%', pool: '2.5%' },
          { name: 'AntPool', solo: 'Variable', pool: 'Variable' }
        ],
        savings: {
          vsLuxor: '28.6% cheaper',
          vsBTCcom: '50% cheaper',
          vsCKPool: '50-75% cheaper',
          vsF2Pool: '80% cheaper'
        },
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('Fee comparison error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

export default SoloMiningAPI;