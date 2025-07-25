/**
 * Enhanced Blockchain Integration for Otedama
 * Multi-chain support with advanced features
 * 
 * Design:
 * - Carmack: Efficient blockchain communication
 * - Martin: Clean abstraction for multiple chains
 * - Pike: Simple but powerful blockchain interface
 */

import { EventEmitter } from 'events';
import axios from 'axios';
import { createStructuredLogger } from '../core/structured-logger.js';
import { withRetry, CircuitBreaker } from '../core/error-handler-unified.js';
import { PerformanceMonitor } from '../monitoring/performance-monitor.js';

// Blockchain constants
const BLOCK_MATURITY = {
  bitcoin: 100,
  litecoin: 100,
  ethereum: 12,
  monero: 60
};

const CONFIRMATION_TARGETS = {
  bitcoin: 6,
  litecoin: 6,
  ethereum: 12,
  monero: 10
};

/**
 * Base blockchain client
 */
class BlockchainClient extends EventEmitter {
  constructor(config) {
    super();
    
    this.config = {
      url: config.url,
      user: config.user,
      password: config.password,
      timeout: config.timeout || 30000,
      maxRetries: config.maxRetries || 3,
      ...config
    };
    
    this.chain = config.chain || 'bitcoin';
    this.logger = createStructuredLogger(`BlockchainClient:${this.chain}`);
    
    // Circuit breaker for fault tolerance
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeout: 60000
    });
    
    // Performance monitoring
    this.performance = new PerformanceMonitor({
      prometheusPrefix: `blockchain_${this.chain}`
    });
    
    // Axios instance
    this.client = axios.create({
      baseURL: this.config.url,
      timeout: this.config.timeout,
      auth: {
        username: this.config.user,
        password: this.config.password
      },
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    // Request ID counter
    this.requestId = 0;
  }
  
  /**
   * Make RPC call
   */
  async rpcCall(method, params = []) {
    const id = ++this.requestId;
    const operationId = this.performance.startOperation('rpc_call', { method });
    
    try {
      const response = await this.circuitBreaker.call(async () => {
        return await withRetry(
          async () => {
            const result = await this.client.post('', {
              jsonrpc: '2.0',
              id,
              method,
              params
            });
            
            if (result.data.error) {
              throw new Error(result.data.error.message);
            }
            
            return result.data.result;
          },
          this.config.maxRetries
        );
      });
      
      this.performance.endOperation(operationId, { success: true });
      return response;
      
    } catch (error) {
      this.performance.endOperation(operationId, { success: false, error: error.message });
      this.logger.error('RPC call failed', { method, error: error.message });
      throw error;
    }
  }
  
  /**
   * Get blockchain info
   */
  async getInfo() {
    const info = await this.rpcCall('getblockchaininfo');
    return {
      chain: info.chain,
      blocks: info.blocks,
      headers: info.headers,
      difficulty: info.difficulty,
      medianTime: info.mediantime,
      verificationProgress: info.verificationprogress,
      pruned: info.pruned,
      warnings: info.warnings
    };
  }
  
  /**
   * Get network info
   */
  async getNetworkInfo() {
    const info = await this.rpcCall('getnetworkinfo');
    return {
      version: info.version,
      protocolVersion: info.protocolversion,
      connections: info.connections,
      networks: info.networks,
      relayFee: info.relayfee,
      warnings: info.warnings
    };
  }
  
  /**
   * Get mining info
   */
  async getMiningInfo() {
    const info = await this.rpcCall('getmininginfo');
    return {
      blocks: info.blocks,
      difficulty: info.difficulty,
      networkHashrate: info.networkhashps,
      pooledTx: info.pooledtx,
      chain: info.chain
    };
  }
  
  /**
   * Get block template for mining
   */
  async getBlockTemplate(capabilities = ['coinbasetxn', 'workid', 'coinbase/append']) {
    const template = await this.rpcCall('getblocktemplate', [{
      capabilities,
      rules: ['segwit']
    }]);
    
    return {
      version: template.version,
      previousBlockHash: template.previousblockhash,
      transactions: template.transactions,
      coinbaseValue: template.coinbasevalue,
      target: template.target,
      minTime: template.mintime,
      mutable: template.mutable,
      nonceRange: template.noncerange,
      sigopLimit: template.sigoplimit,
      sizeLimit: template.sizelimit,
      weightLimit: template.weightlimit,
      curTime: template.curtime,
      bits: template.bits,
      height: template.height,
      workId: template.workid
    };
  }
  
  /**
   * Submit block
   */
  async submitBlock(blockHex, workId = null) {
    try {
      const params = workId ? [blockHex, { workid: workId }] : [blockHex];
      const result = await this.rpcCall('submitblock', params);
      
      // null means success
      if (result === null) {
        this.emit('block:submitted', { success: true });
        return { success: true };
      }
      
      // Otherwise it's an error message
      this.emit('block:rejected', { reason: result });
      return { success: false, reason: result };
      
    } catch (error) {
      this.emit('block:error', { error: error.message });
      throw error;
    }
  }
  
  /**
   * Validate address
   */
  async validateAddress(address) {
    const result = await this.rpcCall('validateaddress', [address]);
    return {
      isValid: result.isvalid,
      isMine: result.ismine,
      isScript: result.isscript,
      isWitness: result.iswitness,
      witnessVersion: result.witness_version,
      witnessProgram: result.witness_program
    };
  }
  
  /**
   * Send transaction
   */
  async sendTransaction(txHex) {
    const txid = await this.rpcCall('sendrawtransaction', [txHex]);
    return { txid };
  }
  
  /**
   * Get transaction
   */
  async getTransaction(txid) {
    try {
      const tx = await this.rpcCall('getrawtransaction', [txid, true]);
      return {
        txid: tx.txid,
        hash: tx.hash,
        size: tx.size,
        vsize: tx.vsize,
        weight: tx.weight,
        version: tx.version,
        locktime: tx.locktime,
        vin: tx.vin,
        vout: tx.vout,
        confirmations: tx.confirmations,
        blockHash: tx.blockhash,
        blockTime: tx.blocktime,
        time: tx.time
      };
    } catch (error) {
      if (error.message.includes('No such mempool or blockchain transaction')) {
        return null;
      }
      throw error;
    }
  }
  
  /**
   * Get block by height
   */
  async getBlockByHeight(height) {
    const hash = await this.rpcCall('getblockhash', [height]);
    return await this.getBlock(hash);
  }
  
  /**
   * Get block by hash
   */
  async getBlock(hash) {
    const block = await this.rpcCall('getblock', [hash, 2]);
    return {
      hash: block.hash,
      confirmations: block.confirmations,
      height: block.height,
      version: block.version,
      versionHex: block.versionHex,
      merkleRoot: block.merkleroot,
      time: block.time,
      medianTime: block.mediantime,
      nonce: block.nonce,
      bits: block.bits,
      difficulty: block.difficulty,
      chainwork: block.chainwork,
      nTx: block.nTx,
      previousBlockHash: block.previousblockhash,
      nextBlockHash: block.nextblockhash,
      size: block.size,
      weight: block.weight,
      transactions: block.tx
    };
  }
  
  /**
   * Get balance
   */
  async getBalance(minConfirmations = 1) {
    const balance = await this.rpcCall('getbalance', ['*', minConfirmations]);
    return balance;
  }
  
  /**
   * List unspent outputs
   */
  async listUnspent(minConfirmations = 1, maxConfirmations = 9999999, addresses = []) {
    const unspent = await this.rpcCall('listunspent', [minConfirmations, maxConfirmations, addresses]);
    return unspent.map(utxo => ({
      txid: utxo.txid,
      vout: utxo.vout,
      address: utxo.address,
      scriptPubKey: utxo.scriptPubKey,
      amount: utxo.amount,
      confirmations: utxo.confirmations,
      spendable: utxo.spendable,
      solvable: utxo.solvable,
      safe: utxo.safe
    }));
  }
  
  /**
   * Create raw transaction
   */
  async createRawTransaction(inputs, outputs, locktime = 0) {
    const txHex = await this.rpcCall('createrawtransaction', [inputs, outputs, locktime]);
    return txHex;
  }
  
  /**
   * Sign raw transaction
   */
  async signRawTransaction(txHex, inputs = null, privateKeys = null) {
    const params = [txHex];
    if (inputs) params.push(inputs);
    if (privateKeys) params.push(privateKeys);
    
    const result = await this.rpcCall('signrawtransactionwithwallet', params);
    return {
      hex: result.hex,
      complete: result.complete,
      errors: result.errors
    };
  }
}

/**
 * Multi-chain manager
 */
export class MultiChainManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.chains = new Map();
    this.primaryChain = config.primaryChain || 'bitcoin';
    this.logger = createStructuredLogger('MultiChainManager');
    
    // Performance monitoring
    this.performance = new PerformanceMonitor({
      prometheusPrefix: 'blockchain'
    });
  }
  
  /**
   * Add blockchain
   */
  addChain(name, config) {
    if (this.chains.has(name)) {
      throw new Error(`Chain ${name} already exists`);
    }
    
    const client = new BlockchainClient({
      ...config,
      chain: name
    });
    
    // Forward events
    client.on('block:submitted', (data) => {
      this.emit('block:submitted', { chain: name, ...data });
    });
    
    client.on('block:rejected', (data) => {
      this.emit('block:rejected', { chain: name, ...data });
    });
    
    this.chains.set(name, client);
    this.logger.info('Added blockchain', { chain: name });
    
    return client;
  }
  
  /**
   * Get chain client
   */
  getChain(name = null) {
    name = name || this.primaryChain;
    const chain = this.chains.get(name);
    
    if (!chain) {
      throw new Error(`Chain ${name} not found`);
    }
    
    return chain;
  }
  
  /**
   * Get block template for specific chain
   */
  async getBlockTemplate(chain = null) {
    const client = this.getChain(chain);
    return await client.getBlockTemplate();
  }
  
  /**
   * Submit block to specific chain
   */
  async submitBlock(blockHex, chain = null, workId = null) {
    const client = this.getChain(chain);
    const result = await client.submitBlock(blockHex, workId);
    
    if (result.success) {
      this.performance.recordBlock(chain || this.primaryChain);
    }
    
    return result;
  }
  
  /**
   * Validate address on specific chain
   */
  async validateAddress(address, chain = null) {
    const client = this.getChain(chain);
    return await client.validateAddress(address);
  }
  
  /**
   * Create payment transaction
   */
  async createPaymentTransaction(payments, chain = null) {
    const client = this.getChain(chain);
    const operationId = this.performance.startOperation('create_payment_tx', { chain });
    
    try {
      // Get unspent outputs
      const unspent = await client.listUnspent();
      
      // Select inputs
      const inputs = [];
      let totalInput = 0;
      const totalOutput = Object.values(payments).reduce((sum, amount) => sum + amount, 0);
      
      for (const utxo of unspent) {
        if (totalInput >= totalOutput + 0.0001) break; // Include fee
        
        inputs.push({
          txid: utxo.txid,
          vout: utxo.vout
        });
        totalInput += utxo.amount;
      }
      
      if (totalInput < totalOutput) {
        throw new Error('Insufficient funds');
      }
      
      // Add change output if needed
      const change = totalInput - totalOutput - 0.0001; // Simple fee
      if (change > 0.00001) {
        const changeAddress = await client.rpcCall('getrawchangeaddress');
        payments[changeAddress] = change;
      }
      
      // Create transaction
      const txHex = await client.createRawTransaction(inputs, payments);
      
      // Sign transaction
      const signed = await client.signRawTransaction(txHex);
      
      if (!signed.complete) {
        throw new Error('Failed to sign transaction');
      }
      
      this.performance.endOperation(operationId, { success: true });
      
      return {
        hex: signed.hex,
        inputs: inputs.length,
        outputs: Object.keys(payments).length,
        fee: 0.0001
      };
      
    } catch (error) {
      this.performance.endOperation(operationId, { success: false, error: error.message });
      throw error;
    }
  }
  
  /**
   * Broadcast transaction
   */
  async broadcastTransaction(txHex, chain = null) {
    const client = this.getChain(chain);
    return await client.sendTransaction(txHex);
  }
  
  /**
   * Get chain statistics
   */
  async getChainStats(chain = null) {
    const client = this.getChain(chain);
    
    const [info, mining, network] = await Promise.all([
      client.getInfo(),
      client.getMiningInfo(),
      client.getNetworkInfo()
    ]);
    
    return {
      chain: chain || this.primaryChain,
      height: info.blocks,
      difficulty: info.difficulty,
      hashrate: mining.networkHashrate,
      connections: network.connections,
      version: network.version
    };
  }
  
  /**
   * Monitor all chains
   */
  async monitorChains() {
    const stats = [];
    
    for (const [name, client] of this.chains) {
      try {
        const chainStats = await this.getChainStats(name);
        stats.push(chainStats);
      } catch (error) {
        this.logger.error('Failed to get chain stats', { chain: name, error: error.message });
        stats.push({
          chain: name,
          error: error.message,
          healthy: false
        });
      }
    }
    
    this.emit('chains:stats', stats);
    return stats;
  }
  
  /**
   * Check transaction confirmations
   */
  async checkConfirmations(txid, chain = null) {
    const client = this.getChain(chain);
    const tx = await client.getTransaction(txid);
    
    if (!tx) {
      return {
        found: false,
        confirmations: 0
      };
    }
    
    const required = CONFIRMATION_TARGETS[chain || this.primaryChain] || 6;
    
    return {
      found: true,
      confirmations: tx.confirmations || 0,
      confirmed: tx.confirmations >= required,
      requiredConfirmations: required
    };
  }
  
  /**
   * Wait for confirmations
   */
  async waitForConfirmations(txid, chain = null, timeout = 3600000) {
    const startTime = Date.now();
    const checkInterval = 30000; // 30 seconds
    
    return new Promise((resolve, reject) => {
      const checkTx = async () => {
        try {
          const status = await this.checkConfirmations(txid, chain);
          
          if (status.confirmed) {
            resolve(status);
            return;
          }
          
          if (Date.now() - startTime > timeout) {
            reject(new Error('Timeout waiting for confirmations'));
            return;
          }
          
          setTimeout(checkTx, checkInterval);
          
        } catch (error) {
          reject(error);
        }
      };
      
      checkTx();
    });
  }
  
  /**
   * Get mature balance (for mining rewards)
   */
  async getMatureBalance(chain = null) {
    const chainName = chain || this.primaryChain;
    const client = this.getChain(chainName);
    const maturity = BLOCK_MATURITY[chainName] || 100;
    
    return await client.getBalance(maturity);
  }
  
  /**
   * Estimate fee
   */
  async estimateFee(blocks = 6, chain = null) {
    const client = this.getChain(chain);
    
    try {
      const feeRate = await client.rpcCall('estimatesmartfee', [blocks]);
      return {
        feeRate: feeRate.feerate,
        blocks: feeRate.blocks
      };
    } catch (error) {
      // Fallback to fixed fee
      return {
        feeRate: 0.00001,
        blocks: blocks,
        fallback: true
      };
    }
  }
  
  /**
   * Get performance metrics
   */
  getMetrics() {
    return this.performance.getReport();
  }
  
  /**
   * Shutdown all chains
   */
  async shutdown() {
    this.logger.info('Shutting down blockchain connections');
    
    for (const [name, client] of this.chains) {
      client.removeAllListeners();
    }
    
    this.chains.clear();
    this.performance.stop();
  }
}

// Export components
export {
  BlockchainClient,
  BLOCK_MATURITY,
  CONFIRMATION_TARGETS
};

export default MultiChainManager;