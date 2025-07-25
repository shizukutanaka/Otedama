/**
 * Blockchain Integration - Otedama
 * Connects to actual blockchain networks for real operations
 * 
 * Features:
 * - Multi-blockchain RPC support
 * - Transaction creation and broadcasting
 * - Block monitoring
 * - Address validation
 * - Fee estimation
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import axios from 'axios';
import bitcoinjs from 'bitcoinjs-lib';
import { ethers } from 'ethers';

const logger = createLogger('BlockchainIntegration');

/**
 * Supported blockchains
 */
export const Blockchain = {
  BITCOIN: 'bitcoin',
  LITECOIN: 'litecoin',
  ETHEREUM: 'ethereum',
  BITCOINCASH: 'bitcoincash',
  DASH: 'dash',
  MONERO: 'monero'
};

/**
 * Blockchain connector base class
 */
class BlockchainConnector extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.connected = false;
  }
  
  async connect() {
    throw new Error('Not implemented');
  }
  
  async getBlockHeight() {
    throw new Error('Not implemented');
  }
  
  async getBalance(address) {
    throw new Error('Not implemented');
  }
  
  async sendTransaction(toAddress, amount) {
    throw new Error('Not implemented');
  }
  
  async validateAddress(address) {
    throw new Error('Not implemented');
  }
  
  async estimateFee() {
    throw new Error('Not implemented');
  }
}

/**
 * Bitcoin connector
 */
export class BitcoinConnector extends BlockchainConnector {
  constructor(config) {
    super(config);
    this.network = config.testnet ? bitcoinjs.networks.testnet : bitcoinjs.networks.bitcoin;
    this.rpcUrl = config.rpcUrl || 'http://localhost:8332';
    this.rpcAuth = {
      username: config.rpcUser,
      password: config.rpcPassword
    };
  }
  
  async connect() {
    try {
      const response = await this.rpcCall('getblockchaininfo');
      this.connected = true;
      logger.info(`Connected to Bitcoin node at block height ${response.result.blocks}`);
      return true;
    } catch (error) {
      logger.error('Failed to connect to Bitcoin node:', error);
      throw error;
    }
  }
  
  async rpcCall(method, params = []) {
    const response = await axios.post(this.rpcUrl, {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params
    }, {
      auth: this.rpcAuth,
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (response.data.error) {
      throw new Error(response.data.error.message);
    }
    
    return response.data;
  }
  
  async getBlockHeight() {
    const response = await this.rpcCall('getblockcount');
    return response.result;
  }
  
  async getBalance(address) {
    // For Bitcoin, we need to use listunspent or importaddress
    try {
      await this.rpcCall('importaddress', [address, '', false]);
      const unspent = await this.rpcCall('listunspent', [1, 9999999, [address]]);
      
      const balance = unspent.result.reduce((sum, utxo) => sum + utxo.amount, 0);
      return balance;
    } catch (error) {
      logger.error('Error getting balance:', error);
      return 0;
    }
  }
  
  async createTransaction(toAddress, amount, changeAddress, utxos) {
    const psbt = new bitcoinjs.Psbt({ network: this.network });
    
    let inputAmount = 0;
    for (const utxo of utxos) {
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        sequence: 0xfffffffe,
        witnessUtxo: {
          script: Buffer.from(utxo.scriptPubKey, 'hex'),
          value: Math.floor(utxo.amount * 1e8)
        }
      });
      inputAmount += utxo.amount;
    }
    
    // Add output
    psbt.addOutput({
      address: toAddress,
      value: Math.floor(amount * 1e8)
    });
    
    // Calculate fee
    const fee = await this.estimateFee();
    const change = inputAmount - amount - fee;
    
    if (change > 0.00001) { // Dust threshold
      psbt.addOutput({
        address: changeAddress,
        value: Math.floor(change * 1e8)
      });
    }
    
    return psbt;
  }
  
  async sendTransaction(toAddress, amount, privateKey) {
    try {
      // Get UTXOs
      const keyPair = bitcoinjs.ECPair.fromWIF(privateKey, this.network);
      const { address } = bitcoinjs.payments.p2pkh({ 
        pubkey: keyPair.publicKey, 
        network: this.network 
      });
      
      const unspent = await this.rpcCall('listunspent', [1, 9999999, [address]]);
      
      if (unspent.result.length === 0) {
        throw new Error('No UTXOs available');
      }
      
      // Create transaction
      const psbt = await this.createTransaction(
        toAddress, 
        amount, 
        address, 
        unspent.result
      );
      
      // Sign inputs
      for (let i = 0; i < unspent.result.length; i++) {
        psbt.signInput(i, keyPair);
      }
      
      psbt.finalizeAllInputs();
      const tx = psbt.extractTransaction();
      const rawTx = tx.toHex();
      
      // Broadcast
      const response = await this.rpcCall('sendrawtransaction', [rawTx]);
      
      return {
        txid: response.result,
        fee: await this.estimateFee()
      };
      
    } catch (error) {
      logger.error('Transaction failed:', error);
      throw error;
    }
  }
  
  async validateAddress(address) {
    try {
      bitcoinjs.address.toOutputScript(address, this.network);
      return true;
    } catch {
      return false;
    }
  }
  
  async estimateFee(blocks = 6) {
    try {
      const response = await this.rpcCall('estimatesmartfee', [blocks]);
      return response.result.feerate || 0.00001; // Default to 1 sat/byte
    } catch {
      return 0.00001;
    }
  }
  
  async getBlockTemplate() {
    const response = await this.rpcCall('getblocktemplate', [{
      capabilities: ['coinbasetxn', 'workid', 'coinbase/append'],
      rules: ['segwit']
    }]);
    
    return response.result;
  }
  
  async submitBlock(blockHex) {
    const response = await this.rpcCall('submitblock', [blockHex]);
    return response.result === null; // null means success
  }
}

/**
 * Litecoin connector
 */
export class LitecoinConnector extends BitcoinConnector {
  constructor(config) {
    super(config);
    this.network = config.testnet ? 
      bitcoinjs.networks.testnet : 
      {
        messagePrefix: '\x19Litecoin Signed Message:\n',
        bech32: 'ltc',
        bip32: {
          public: 0x019da462,
          private: 0x019d9cfe
        },
        pubKeyHash: 0x30,
        scriptHash: 0x32,
        wif: 0xb0
      };
    this.rpcUrl = config.rpcUrl || 'http://localhost:9332';
  }
}

/**
 * Ethereum connector
 */
export class EthereumConnector extends BlockchainConnector {
  constructor(config) {
    super(config);
    this.rpcUrl = config.rpcUrl || 'http://localhost:8545';
    this.provider = new ethers.JsonRpcProvider(this.rpcUrl);
    this.chainId = config.chainId || 1;
  }
  
  async connect() {
    try {
      const blockNumber = await this.provider.getBlockNumber();
      this.connected = true;
      logger.info(`Connected to Ethereum node at block height ${blockNumber}`);
      return true;
    } catch (error) {
      logger.error('Failed to connect to Ethereum node:', error);
      throw error;
    }
  }
  
  async getBlockHeight() {
    return await this.provider.getBlockNumber();
  }
  
  async getBalance(address) {
    const balance = await this.provider.getBalance(address);
    return ethers.formatEther(balance);
  }
  
  async sendTransaction(toAddress, amount, privateKey) {
    try {
      const wallet = new ethers.Wallet(privateKey, this.provider);
      
      const tx = {
        to: toAddress,
        value: ethers.parseEther(amount.toString()),
        gasLimit: 21000
      };
      
      const response = await wallet.sendTransaction(tx);
      const receipt = await response.wait();
      
      return {
        txid: receipt.hash,
        fee: ethers.formatEther(receipt.gasUsed * receipt.gasPrice)
      };
      
    } catch (error) {
      logger.error('Ethereum transaction failed:', error);
      throw error;
    }
  }
  
  async validateAddress(address) {
    return ethers.isAddress(address);
  }
  
  async estimateFee() {
    const feeData = await this.provider.getFeeData();
    return ethers.formatEther(feeData.gasPrice * 21000n);
  }
}

/**
 * Blockchain Manager
 */
export class BlockchainManager extends EventEmitter {
  constructor() {
    super();
    this.connectors = new Map();
    this.initialized = false;
  }
  
  /**
   * Initialize blockchain connections
   */
  async initialize(config) {
    logger.info('Initializing blockchain connections...');
    
    // Bitcoin
    if (config.bitcoin) {
      const btc = new BitcoinConnector(config.bitcoin);
      await btc.connect();
      this.connectors.set(Blockchain.BITCOIN, btc);
    }
    
    // Litecoin
    if (config.litecoin) {
      const ltc = new LitecoinConnector(config.litecoin);
      await ltc.connect();
      this.connectors.set(Blockchain.LITECOIN, ltc);
    }
    
    // Ethereum
    if (config.ethereum) {
      const eth = new EthereumConnector(config.ethereum);
      await eth.connect();
      this.connectors.set(Blockchain.ETHEREUM, eth);
    }
    
    this.initialized = true;
    logger.info('Blockchain connections initialized');
  }
  
  /**
   * Get connector for blockchain
   */
  getConnector(blockchain) {
    const connector = this.connectors.get(blockchain);
    if (!connector) {
      throw new Error(`Blockchain ${blockchain} not configured`);
    }
    return connector;
  }
  
  /**
   * Detect blockchain from address format
   */
  async detectBlockchain(address) {
    if (address.startsWith('1') || address.startsWith('3') || address.startsWith('bc1')) {
      return Blockchain.BITCOIN;
    } else if (address.startsWith('L') || address.startsWith('M') || address.startsWith('ltc1')) {
      return Blockchain.LITECOIN;
    } else if (address.startsWith('0x') && address.length === 42) {
      return Blockchain.ETHEREUM;
    } else if (address.startsWith('D')) {
      return Blockchain.DASH;
    } else if (address.startsWith('4') && address.length === 95) {
      return Blockchain.MONERO;
    }
    
    // Try validation with each connector
    for (const [blockchain, connector] of this.connectors) {
      try {
        if (await connector.validateAddress(address)) {
          return blockchain;
        }
      } catch (error) {
        // Continue to next blockchain
      }
    }
    
    return null;
  }
  
  /**
   * Validate address for any supported blockchain
   */
  async validateAddress(address, blockchain = null) {
    if (blockchain) {
      const connector = this.getConnector(blockchain);
      return await connector.validateAddress(address);
    }
    
    // Try to detect blockchain from address format
    blockchain = await this.detectBlockchain(address);
    
    if (blockchain) {
      const connector = this.connectors.get(blockchain);
      if (connector) {
        return await connector.validateAddress(address);
      }
    }
    
    return false;
  }
  
  /**
   * Send payment
   */
  async sendPayment(blockchain, toAddress, amount, fromPrivateKey) {
    const connector = this.getConnector(blockchain);
    
    const result = await connector.sendTransaction(toAddress, amount, fromPrivateKey);
    
    logger.info(`Payment sent: ${amount} ${blockchain} to ${toAddress} (tx: ${result.txid})`);
    
    this.emit('payment:sent', {
      blockchain,
      toAddress,
      amount,
      txid: result.txid,
      fee: result.fee
    });
    
    return result;
  }
  
  /**
   * Get balance
   */
  async getBalance(blockchain, address) {
    const connector = this.getConnector(blockchain);
    return await connector.getBalance(address);
  }
  
  /**
   * Monitor new blocks
   */
  async startBlockMonitoring(blockchain, callback) {
    const connector = this.getConnector(blockchain);
    let lastHeight = await connector.getBlockHeight();
    
    const interval = setInterval(async () => {
      try {
        const currentHeight = await connector.getBlockHeight();
        
        if (currentHeight > lastHeight) {
          for (let height = lastHeight + 1; height <= currentHeight; height++) {
            callback(blockchain, height);
          }
          lastHeight = currentHeight;
        }
      } catch (error) {
        logger.error(`Block monitoring error for ${blockchain}:`, error);
      }
    }, 10000); // Check every 10 seconds
    
    return interval;
  }
}

/**
 * Create blockchain manager instance
 */
export function createBlockchainManager() {
  return new BlockchainManager();
}

export default {
  Blockchain,
  BlockchainManager,
  BitcoinConnector,
  LitecoinConnector,
  EthereumConnector,
  createBlockchainManager
};
