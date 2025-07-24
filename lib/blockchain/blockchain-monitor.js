/**
 * Blockchain Monitor
 * Monitors blockchain for new blocks and confirmations
 */

const EventEmitter = require('events');
const axios = require('axios');
const { createLogger } = require('../core/logger');

const logger = createLogger('blockchain-monitor');

class BlockchainMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      node: options.node || 'http://localhost:8332',
      coin: options.coin || 'BTC',
      network: options.network || 'mainnet',
      rpcUser: options.rpcUser || 'rpc',
      rpcPassword: options.rpcPassword || 'password',
      pollInterval: options.pollInterval || 10000, // 10 seconds
      confirmations: options.confirmations || 100,
      retryAttempts: options.retryAttempts || 3,
      retryDelay: options.retryDelay || 5000,
      ...options
    };
    
    this.rpcClient = null;
    this.currentHeight = 0;
    this.currentBlock = null;
    this.isConnected = false;
    this.pollTimer = null;
    this.pendingBlocks = new Map();
  }
  
  /**
   * Start monitoring
   */
  async start() {
    try {
      // Initialize RPC client
      this.initializeRpcClient();
      
      // Get current block
      await this.updateCurrentBlock();
      
      // Start polling
      this.startPolling();
      
      this.isConnected = true;
      this.emit('connected');
      
      logger.info(`Blockchain monitor started (${this.options.coin} ${this.options.network})`);
      
    } catch (error) {
      logger.error('Failed to start blockchain monitor:', error);
      this.emit('error', error);
      
      // Retry connection
      setTimeout(() => this.start(), this.options.retryDelay);
    }
  }
  
  /**
   * Stop monitoring
   */
  async stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    
    this.isConnected = false;
    this.emit('disconnected');
    
    logger.info('Blockchain monitor stopped');
  }
  
  /**
   * Initialize RPC client
   */
  initializeRpcClient() {
    const auth = Buffer.from(`${this.options.rpcUser}:${this.options.rpcPassword}`).toString('base64');
    
    this.rpcClient = {
      call: async (method, params = []) => {
        try {
          const response = await axios.post(this.options.node, {
            jsonrpc: '2.0',
            id: Date.now(),
            method,
            params
          }, {
            headers: {
              'Authorization': `Basic ${auth}`,
              'Content-Type': 'application/json'
            },
            timeout: 30000
          });
          
          if (response.data.error) {
            throw new Error(response.data.error.message);
          }
          
          return response.data.result;
        } catch (error) {
          if (error.response && error.response.status === 401) {
            throw new Error('RPC authentication failed');
          }
          throw error;
        }
      }
    };
  }
  
  /**
   * Start polling for new blocks
   */
  startPolling() {
    this.pollTimer = setInterval(async () => {
      try {
        await this.checkForNewBlocks();
        await this.checkPendingBlocks();
      } catch (error) {
        logger.error('Polling error:', error);
        
        // Check if disconnected
        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
          this.isConnected = false;
          this.emit('disconnected');
        }
      }
    }, this.options.pollInterval);
  }
  
  /**
   * Check for new blocks
   */
  async checkForNewBlocks() {
    const height = await this.rpcClient.call('getblockcount');
    
    if (height > this.currentHeight) {
      // Process new blocks
      for (let h = this.currentHeight + 1; h <= height; h++) {
        try {
          const blockHash = await this.rpcClient.call('getblockhash', [h]);
          const block = await this.rpcClient.call('getblock', [blockHash, 2]); // verbose=2
          
          const blockInfo = {
            height: h,
            hash: blockHash,
            previousHash: block.previousblockhash,
            timestamp: block.time,
            difficulty: block.difficulty,
            bits: parseInt(block.bits, 16),
            version: block.version,
            merkleRoot: block.merkleroot,
            transactions: block.tx || []
          };
          
          this.currentHeight = h;
          this.currentBlock = blockInfo;
          
          // Add to pending blocks for confirmation tracking
          this.pendingBlocks.set(h, blockInfo);
          
          logger.info(`New block: ${h} (${blockHash})`);
          this.emit('new-block', blockInfo);
          
        } catch (error) {
          logger.error(`Failed to get block ${h}:`, error);
        }
      }
    }
  }
  
  /**
   * Check pending blocks for confirmations
   */
  async checkPendingBlocks() {
    const currentHeight = await this.rpcClient.call('getblockcount');
    
    for (const [height, block] of this.pendingBlocks) {
      const confirmations = currentHeight - height + 1;
      
      if (confirmations >= this.options.confirmations) {
        // Block is confirmed
        this.pendingBlocks.delete(height);
        
        // Get block reward
        try {
          const blockData = await this.rpcClient.call('getblock', [block.hash, 2]);
          const coinbaseTx = blockData.tx[0];
          
          let reward = 0;
          if (coinbaseTx && coinbaseTx.vout) {
            reward = coinbaseTx.vout.reduce((sum, output) => sum + (output.value || 0), 0);
          }
          
          block.reward = reward;
          block.confirmations = confirmations;
          
          logger.info(`Block confirmed: ${height} (${confirmations} confirmations)`);
          this.emit('block-confirmed', block);
          
        } catch (error) {
          logger.error(`Failed to get block reward for ${height}:`, error);
        }
      }
    }
  }
  
  /**
   * Update current block info
   */
  async updateCurrentBlock() {
    try {
      this.currentHeight = await this.rpcClient.call('getblockcount');
      const blockHash = await this.rpcClient.call('getblockhash', [this.currentHeight]);
      const block = await this.rpcClient.call('getblock', [blockHash, 2]);
      
      this.currentBlock = {
        height: this.currentHeight,
        hash: blockHash,
        previousHash: block.previousblockhash,
        timestamp: block.time,
        difficulty: block.difficulty,
        bits: parseInt(block.bits, 16),
        version: block.version,
        merkleRoot: block.merkleroot
      };
      
      logger.info(`Current block: ${this.currentHeight} (${blockHash})`);
      
    } catch (error) {
      logger.error('Failed to get current block:', error);
      throw error;
    }
  }
  
  /**
   * Get block by height
   */
  async getBlock(height) {
    try {
      const blockHash = await this.rpcClient.call('getblockhash', [height]);
      const block = await this.rpcClient.call('getblock', [blockHash, 2]);
      
      return {
        height,
        hash: blockHash,
        previousHash: block.previousblockhash,
        timestamp: block.time,
        difficulty: block.difficulty,
        bits: parseInt(block.bits, 16),
        version: block.version,
        merkleRoot: block.merkleroot,
        transactions: block.tx || []
      };
      
    } catch (error) {
      logger.error(`Failed to get block ${height}:`, error);
      return null;
    }
  }
  
  /**
   * Get transaction
   */
  async getTransaction(txid) {
    try {
      const tx = await this.rpcClient.call('getrawtransaction', [txid, true]);
      return tx;
    } catch (error) {
      logger.error(`Failed to get transaction ${txid}:`, error);
      return null;
    }
  }
  
  /**
   * Submit block
   */
  async submitBlock(blockHex) {
    try {
      const result = await this.rpcClient.call('submitblock', [blockHex]);
      
      if (result === null) {
        logger.info('Block submitted successfully!');
        return true;
      } else {
        logger.error('Block submission failed:', result);
        return false;
      }
      
    } catch (error) {
      logger.error('Failed to submit block:', error);
      return false;
    }
  }
  
  /**
   * Get network info
   */
  async getNetworkInfo() {
    try {
      const info = await this.rpcClient.call('getnetworkinfo');
      const miningInfo = await this.rpcClient.call('getmininginfo');
      
      return {
        version: info.version,
        protocolVersion: info.protocolversion,
        connections: info.connections,
        difficulty: miningInfo.difficulty,
        hashrate: miningInfo.networkhashps,
        blocks: miningInfo.blocks
      };
      
    } catch (error) {
      logger.error('Failed to get network info:', error);
      return null;
    }
  }
  
  /**
   * Validate address
   */
  async validateAddress(address) {
    try {
      const result = await this.rpcClient.call('validateaddress', [address]);
      return result.isvalid;
    } catch (error) {
      logger.error('Failed to validate address:', error);
      return false;
    }
  }
  
  /**
   * Get current state
   */
  getState() {
    return {
      connected: this.isConnected,
      currentHeight: this.currentHeight,
      currentBlock: this.currentBlock,
      pendingBlocks: this.pendingBlocks.size,
      coin: this.options.coin,
      network: this.options.network
    };
  }
}

module.exports = BlockchainMonitor;