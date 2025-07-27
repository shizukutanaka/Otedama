/**
 * Stratum Server Solo Mining Extension
 * Adds solo mining mode support to stratum server
 * 
 * Features:
 * - Solo mode authorization
 * - Direct block reward handling
 * - Mode switching support
 * - Real-time statistics
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import crypto from 'crypto';

const logger = createLogger('StratumSoloExtension');

/**
 * Extended Stratum Methods for Solo Mining
 */
export const SOLO_STRATUM_METHODS = {
  ...{
    SUBSCRIBE: 'mining.subscribe',
    AUTHORIZE: 'mining.authorize',
    SUBMIT: 'mining.submit',
    NOTIFY: 'mining.notify',
    SET_DIFFICULTY: 'mining.set_difficulty'
  },
  // Solo-specific methods
  SET_MODE: 'mining.set_mode',
  GET_MODE: 'mining.get_mode',
  SOLO_INFO: 'mining.solo_info',
  SWITCH_MODE: 'mining.switch_mode'
};

/**
 * Stratum Solo Extension
 */
export class StratumSoloExtension extends EventEmitter {
  constructor(stratumServer, soloPoolIntegration) {
    super();
    
    this.stratum = stratumServer;
    this.soloPool = soloPoolIntegration;
    
    // Extended connection tracking
    this.connectionModes = new Map();
    
    // Setup method handlers
    this.setupHandlers();
  }
  
  /**
   * Setup method handlers
   */
  setupHandlers() {
    // Intercept authorize to handle mode selection
    this.stratum.on('client:authorize', this.handleAuthorize.bind(this));
    
    // Handle mode-specific methods
    this.stratum.on('client:message', this.handleMessage.bind(this));
    
    // Handle share submission
    this.stratum.on('client:submit', this.handleSubmit.bind(this));
  }
  
  /**
   * Handle authorization with mode selection
   */
  handleAuthorize(client, params, callback) {
    const [workerName, password] = params;
    
    // Parse mode from password field (common practice)
    // Format: "password,mode=solo" or "x,solo" or just "solo"
    let mode = 'pool'; // default
    let actualPassword = password;
    
    if (password) {
      const parts = password.split(',');
      for (const part of parts) {
        const trimmed = part.trim().toLowerCase();
        if (trimmed === 'solo' || trimmed === 'mode=solo') {
          mode = 'solo';
        } else if (trimmed === 'pool' || trimmed === 'mode=pool') {
          mode = 'pool';
        }
      }
      
      // Extract actual password if any
      actualPassword = parts.find(p => !p.includes('solo') && !p.includes('pool')) || 'x';
    }
    
    // Extract address from worker name (format: address.workername)
    const [address, workerSuffix] = workerName.split('.');
    
    // Register miner with selected mode
    const minerId = this.soloPool.registerMiner({
      id: client.id,
      address: address,
      worker: workerSuffix || 'default',
      difficulty: client.difficulty
    }, mode);
    
    // Store connection mode
    this.connectionModes.set(client.id, {
      minerId,
      mode,
      address,
      worker: workerSuffix
    });
    
    logger.info(`Miner authorized: ${address} in ${mode} mode`);
    
    // Send mode confirmation
    client.send({
      id: null,
      method: 'client.show_message',
      params: [`Mining mode: ${mode.toUpperCase()} (${mode === 'solo' ? '0.5%' : '1%'} fee)`]
    });
    
    callback(null, true);
  }
  
  /**
   * Handle custom messages
   */
  handleMessage(client, message) {
    const { method, params, id } = message;
    
    switch (method) {
      case SOLO_STRATUM_METHODS.SET_MODE:
        this.handleSetMode(client, params, id);
        break;
        
      case SOLO_STRATUM_METHODS.GET_MODE:
        this.handleGetMode(client, id);
        break;
        
      case SOLO_STRATUM_METHODS.SOLO_INFO:
        this.handleSoloInfo(client, id);
        break;
        
      case SOLO_STRATUM_METHODS.SWITCH_MODE:
        this.handleSwitchMode(client, params, id);
        break;
    }
  }
  
  /**
   * Handle mode switching
   */
  handleSetMode(client, params, id) {
    const [newMode] = params;
    const connectionInfo = this.connectionModes.get(client.id);
    
    if (!connectionInfo) {
      client.send({
        id,
        error: 'Not authorized'
      });
      return;
    }
    
    if (newMode !== 'solo' && newMode !== 'pool') {
      client.send({
        id,
        error: 'Invalid mode. Use "solo" or "pool"'
      });
      return;
    }
    
    try {
      this.soloPool.switchMode(connectionInfo.minerId, newMode);
      connectionInfo.mode = newMode;
      
      client.send({
        id,
        result: true,
        mode: newMode,
        fee: newMode === 'solo' ? '0.5%' : '1%'
      });
      
      // Notify mode change
      client.send({
        id: null,
        method: 'client.show_message',
        params: [`Switched to ${newMode.toUpperCase()} mode`]
      });
      
    } catch (error) {
      client.send({
        id,
        error: error.message
      });
    }
  }
  
  /**
   * Get current mining mode
   */
  handleGetMode(client, id) {
    const connectionInfo = this.connectionModes.get(client.id);
    
    if (!connectionInfo) {
      client.send({
        id,
        error: 'Not authorized'
      });
      return;
    }
    
    client.send({
      id,
      result: {
        mode: connectionInfo.mode,
        fee: connectionInfo.mode === 'solo' ? '0.5%' : '1%',
        address: connectionInfo.address
      }
    });
  }
  
  /**
   * Get solo mining information
   */
  handleSoloInfo(client, id) {
    const connectionInfo = this.connectionModes.get(client.id);
    
    if (!connectionInfo) {
      client.send({
        id,
        error: 'Not authorized'
      });
      return;
    }
    
    const minerStats = this.soloPool.getMinerStats(connectionInfo.minerId);
    const poolStats = this.soloPool.getPoolStats();
    
    client.send({
      id,
      result: {
        currentMode: connectionInfo.mode,
        minerStats: minerStats ? {
          shares: minerStats.shares,
          blocksFound: minerStats.blocksFound,
          earnings: minerStats.earnings,
          soloStats: minerStats.soloStats
        } : null,
        poolStats: {
          totalMiners: poolStats.totalMiners,
          soloMiners: poolStats.soloMiners,
          poolMiners: poolStats.poolMiners,
          soloBlocks: poolStats.soloBlocks,
          fees: poolStats.fees
        }
      }
    });
  }
  
  /**
   * Handle mode switching (alias for set_mode)
   */
  handleSwitchMode(client, params, id) {
    this.handleSetMode(client, params, id);
  }
  
  /**
   * Handle share submission
   */
  async handleSubmit(client, params, callback) {
    const connectionInfo = this.connectionModes.get(client.id);
    
    if (!connectionInfo) {
      callback('Not authorized');
      return;
    }
    
    const [workerName, jobId, extranonce2, ntime, nonce] = params;
    
    // Create share object
    const share = {
      jobId,
      extranonce2,
      ntime,
      nonce,
      difficulty: client.difficulty,
      submitTime: Date.now()
    };
    
    try {
      // Process share through solo pool integration
      const result = await this.soloPool.handleShare(connectionInfo.minerId, {
        ...share,
        meetsDifficulty: true, // This would be validated by the pool
        blockValue: 3.125 * 100000000, // Current block reward in satoshis
        hash: crypto.randomBytes(32).toString('hex'),
        height: 0 // Would come from actual block template
      });
      
      if (result.mode === 'solo' && result.reward > 0) {
        // Solo block found!
        client.send({
          id: null,
          method: 'client.show_message',
          params: [`SOLO BLOCK FOUND! Reward: ${result.reward / 100000000} BTC (after 0.5% fee)`]
        });
      }
      
      callback(null, true);
      
    } catch (error) {
      logger.error('Share submission error:', error);
      callback(error.message);
    }
  }
  
  /**
   * Broadcast to miners by mode
   */
  broadcastToMode(mode, method, params) {
    for (const [clientId, info] of this.connectionModes) {
      if (info.mode === mode) {
        const client = this.stratum.connections.get(clientId);
        if (client) {
          client.send({
            id: null,
            method,
            params
          });
        }
      }
    }
  }
  
  /**
   * Get statistics by mode
   */
  getStatsByMode() {
    const stats = {
      solo: { count: 0, hashrate: 0 },
      pool: { count: 0, hashrate: 0 }
    };
    
    for (const [clientId, info] of this.connectionModes) {
      const client = this.stratum.connections.get(clientId);
      if (client && client.stats) {
        stats[info.mode].count++;
        stats[info.mode].hashrate += client.stats.hashrate || 0;
      }
    }
    
    return stats;
  }
}

export default StratumSoloExtension;