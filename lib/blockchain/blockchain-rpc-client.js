/**
 * Blockchain RPC Client for Otedama
 * Handles communication with various blockchain nodes
 * 
 * Design principles:
 * - Carmack: Minimal latency RPC calls
 * - Martin: Clean abstraction over blockchain specifics
 * - Pike: Simple and reliable interface
 */

import axios from 'axios';
import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('BlockchainRPCClient');

/**
 * Blockchain types with their specific configurations
 */
export const BlockchainType = {
  BITCOIN: 'bitcoin',
  LITECOIN: 'litecoin',
  ETHEREUM: 'ethereum',
  MONERO: 'monero',
  RAVENCOIN: 'ravencoin',
  ERGO: 'ergo',
  KASPA: 'kaspa',
  FLUX: 'flux',
  CONFLUX: 'conflux',
  BEAM: 'beam'
};

/**
 * RPC method mappings for different blockchains
 */
const RPC_METHODS = {
  [BlockchainType.BITCOIN]: {
    getBlockTemplate: 'getblocktemplate',
    submitBlock: 'submitblock',
    getBlockchainInfo: 'getblockchaininfo',
    getNetworkHashrate: 'getnetworkhashps',
    getBlockCount: 'getblockcount'
  },
  [BlockchainType.ETHEREUM]: {
    getWork: 'eth_getWork',
    submitWork: 'eth_submitWork',
    getBlockNumber: 'eth_blockNumber',
    getHashrate: 'eth_hashrate'
  },
  [BlockchainType.MONERO]: {
    getBlockTemplate: 'get_block_template',
    submitBlock: 'submit_block',
    getInfo: 'get_info',
    getLastBlockHeader: 'get_last_block_header'
  }
  // Add more blockchain-specific methods as needed
};

/**
 * Blockchain RPC Client
 */
export class BlockchainRPCClient extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Connection settings
      host: config.host || 'localhost',
      port: config.port || 8332,
      username: config.username || '',
      password: config.password || '',
      protocol: config.protocol || 'http',
      
      // Blockchain settings
      blockchain: config.blockchain || BlockchainType.BITCOIN,
      wallet: config.wallet || '',
      
      // Request settings
      timeout: config.timeout || 30000,
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 1000,
      
      // Template settings
      longPollTimeout: config.longPollTimeout || 60000,
      capabilities: config.capabilities || ['coinbasetxn', 'workid', 'coinbase/append'],
      
      ...config
    };
    
    // RPC client
    this.client = this.createClient();
    
    // State
    this.connected = false;
    this.lastBlockHeight = 0;
    this.longPollId = null;
    
    // Statistics
    this.stats = {
      requestsSent: 0,
      requestsSucceeded: 0,
      requestsFailed: 0,
      blocksSubmitted: 0,
      blocksAccepted: 0
    };
  }

  /**
   * Create axios client
   */
  createClient() {
    const auth = this.config.username ? {
      username: this.config.username,
      password: this.config.password
    } : undefined;
    
    return axios.create({
      baseURL: `${this.config.protocol}://${this.config.host}:${this.config.port}`,
      timeout: this.config.timeout,
      auth,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Connect and verify RPC connection
   */
  async connect() {
    try {
      const info = await this.getBlockchainInfo();
      this.connected = true;
      this.lastBlockHeight = info.blocks || info.height || 0;
      
      logger.info('Connected to blockchain RPC', {
        blockchain: this.config.blockchain,
        height: this.lastBlockHeight,
        network: info.chain || info.network || 'unknown'
      });
      
      this.emit('connected', info);
      return true;
      
    } catch (error) {
      this.connected = false;
      logger.error('Failed to connect to blockchain RPC', {
        error: error.message,
        host: this.config.host,
        port: this.config.port
      });
      
      this.emit('error', error);
      return false;
    }
  }

  /**
   * Make RPC request with retry logic
   */
  async request(method, params = []) {
    const requestId = Math.floor(Math.random() * 100000);
    
    const payload = {
      jsonrpc: '2.0',
      method,
      params,
      id: requestId
    };
    
    let lastError;
    
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        this.stats.requestsSent++;
        
        const response = await this.client.post('/', payload);
        
        if (response.data.error) {
          throw new Error(response.data.error.message || 'RPC error');
        }
        
        this.stats.requestsSucceeded++;
        return response.data.result;
        
      } catch (error) {
        lastError = error;
        this.stats.requestsFailed++;
        
        logger.debug('RPC request failed', {
          method,
          attempt,
          error: error.message
        });
        
        if (attempt < this.config.maxRetries) {
          await new Promise(resolve => 
            setTimeout(resolve, this.config.retryDelay * (attempt + 1))
          );
        }
      }
    }
    
    throw lastError;
  }

  /**
   * Get blockchain info
   */
  async getBlockchainInfo() {
    switch (this.config.blockchain) {
      case BlockchainType.BITCOIN:
      case BlockchainType.LITECOIN:
      case BlockchainType.RAVENCOIN:
        return await this.request('getblockchaininfo');
        
      case BlockchainType.ETHEREUM:
        const blockNumber = await this.request('eth_blockNumber');
        return {
          blocks: parseInt(blockNumber, 16),
          chain: 'ethereum'
        };
        
      case BlockchainType.MONERO:
        return await this.request('get_info');
        
      default:
        return await this.request('getinfo');
    }
  }

  /**
   * Get block template for mining
   */
  async getBlockTemplate() {
    let template;
    
    switch (this.config.blockchain) {
      case BlockchainType.BITCOIN:
      case BlockchainType.LITECOIN:
      case BlockchainType.RAVENCOIN:
        // Bitcoin-style getblocktemplate
        const btcParams = [{
          capabilities: this.config.capabilities,
          longpollid: this.longPollId
        }];
        
        template = await this.request('getblocktemplate', btcParams);
        
        // Update longpoll ID
        if (template.longpollid) {
          this.longPollId = template.longpollid;
        }
        
        break;
        
      case BlockchainType.ETHEREUM:
        // Ethereum getWork
        const work = await this.request('eth_getWork');
        
        // Convert to common template format
        template = {
          height: parseInt(work[3], 16),
          previousblockhash: work[0].slice(2),
          target: work[2].slice(2),
          coinbasevalue: 2000000000000000000, // 2 ETH
          bits: this.targetToBits(work[2]),
          transactions: []
        };
        
        break;
        
      case BlockchainType.MONERO:
        // Monero block template
        const xmrTemplate = await this.request('get_block_template', [{
          wallet_address: this.config.wallet,
          reserve_size: 8
        }]);
        
        template = {
          height: xmrTemplate.height,
          previousblockhash: xmrTemplate.prev_hash,
          difficulty: xmrTemplate.difficulty,
          coinbasevalue: xmrTemplate.expected_reward,
          bits: this.difficultyToBits(xmrTemplate.difficulty),
          transactions: []
        };
        
        break;
        
      default:
        throw new Error(`Unsupported blockchain: ${this.config.blockchain}`);
    }
    
    // Update height
    if (template.height > this.lastBlockHeight) {
      this.lastBlockHeight = template.height;
      this.emit('newBlock', { height: template.height });
    }
    
    return template;
  }

  /**
   * Submit mined block
   */
  async submitBlock(blockHex) {
    let result;
    
    this.stats.blocksSubmitted++;
    
    try {
      switch (this.config.blockchain) {
        case BlockchainType.BITCOIN:
        case BlockchainType.LITECOIN:
        case BlockchainType.RAVENCOIN:
          // Bitcoin-style submitblock
          result = await this.request('submitblock', [blockHex]);
          
          // null or empty string means success
          if (result === null || result === '') {
            this.stats.blocksAccepted++;
            return { accepted: true };
          } else {
            return { accepted: false, reason: result };
          }
          
        case BlockchainType.ETHEREUM:
          // Ethereum submitWork
          const [nonce, headerHash, mixHash] = blockHex.split(':');
          const success = await this.request('eth_submitWork', [nonce, headerHash, mixHash]);
          
          if (success) {
            this.stats.blocksAccepted++;
            return { accepted: true };
          } else {
            return { accepted: false, reason: 'Block rejected' };
          }
          
        case BlockchainType.MONERO:
          // Monero submit block
          result = await this.request('submit_block', [blockHex]);
          
          if (result.status === 'OK') {
            this.stats.blocksAccepted++;
            return { accepted: true };
          } else {
            return { accepted: false, reason: result.status };
          }
          
        default:
          throw new Error(`Unsupported blockchain: ${this.config.blockchain}`);
      }
      
    } catch (error) {
      logger.error('Failed to submit block', {
        blockchain: this.config.blockchain,
        error: error.message
      });
      
      return { accepted: false, reason: error.message };
    }
  }

  /**
   * Get network hashrate
   */
  async getNetworkHashrate() {
    switch (this.config.blockchain) {
      case BlockchainType.BITCOIN:
      case BlockchainType.LITECOIN:
        return await this.request('getnetworkhashps');
        
      case BlockchainType.ETHEREUM:
        const hashrate = await this.request('eth_hashrate');
        return parseInt(hashrate, 16);
        
      case BlockchainType.MONERO:
        const info = await this.request('get_info');
        return info.difficulty / info.target;
        
      default:
        return 0;
    }
  }

  /**
   * Get current block height
   */
  async getBlockCount() {
    switch (this.config.blockchain) {
      case BlockchainType.BITCOIN:
      case BlockchainType.LITECOIN:
      case BlockchainType.RAVENCOIN:
        return await this.request('getblockcount');
        
      case BlockchainType.ETHEREUM:
        const blockNumber = await this.request('eth_blockNumber');
        return parseInt(blockNumber, 16);
        
      case BlockchainType.MONERO:
        const info = await this.request('get_info');
        return info.height;
        
      default:
        return 0;
    }
  }

  /**
   * Validate address
   */
  async validateAddress(address) {
    switch (this.config.blockchain) {
      case BlockchainType.BITCOIN:
      case BlockchainType.LITECOIN:
      case BlockchainType.RAVENCOIN:
        const result = await this.request('validateaddress', [address]);
        return result.isvalid;
        
      case BlockchainType.ETHEREUM:
        // Basic ethereum address validation
        return /^0x[a-fA-F0-9]{40}$/.test(address);
        
      case BlockchainType.MONERO:
        // Monero address validation
        return address.length === 95 || address.length === 106;
        
      default:
        return false;
    }
  }

  /**
   * Convert target to bits
   */
  targetToBits(targetHex) {
    const target = BigInt('0x' + targetHex);
    let bits = 0;
    let coefficient = target;
    
    while (coefficient > 0x7fffffn) {
      coefficient >>= 8n;
      bits += 8;
    }
    
    return ((bits / 8 + 3) << 24) | Number(coefficient);
  }

  /**
   * Convert difficulty to bits
   */
  difficultyToBits(difficulty) {
    const maxTarget = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
    const target = maxTarget / BigInt(difficulty);
    return this.targetToBits(target.toString(16));
  }

  /**
   * Long poll for new blocks (Bitcoin-style)
   */
  async longPoll() {
    if (this.config.blockchain !== BlockchainType.BITCOIN && 
        this.config.blockchain !== BlockchainType.LITECOIN) {
      return;
    }
    
    while (this.connected) {
      try {
        const template = await this.getBlockTemplate();
        
        if (template.height > this.lastBlockHeight) {
          this.emit('longpoll:block', template);
        }
        
      } catch (error) {
        if (error.code === 'ECONNABORTED') {
          // Timeout is expected for long polling
          continue;
        }
        
        logger.error('Long poll error', { error: error.message });
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  /**
   * Get client statistics
   */
  getStats() {
    return {
      ...this.stats,
      connected: this.connected,
      lastBlockHeight: this.lastBlockHeight,
      blockchain: this.config.blockchain,
      host: this.config.host
    };
  }

  /**
   * Disconnect from RPC
   */
  disconnect() {
    this.connected = false;
    this.emit('disconnected');
    logger.info('Disconnected from blockchain RPC');
  }
}

export default BlockchainRPCClient;