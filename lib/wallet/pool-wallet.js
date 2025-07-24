/**
 * Pool Wallet Manager
 * Handles pool's hot wallet operations
 */

const bitcoinjs = require('bitcoinjs-lib');
const crypto = require('crypto');
const { createLogger } = require('../core/logger');
const fs = require('fs').promises;
const path = require('path');

const logger = createLogger('pool-wallet');

class PoolWallet {
  constructor(options = {}) {
    this.options = {
      network: options.network || bitcoinjs.networks.bitcoin,
      walletPath: options.walletPath || './data/wallet.json',
      encryptionKey: options.encryptionKey,
      rpcClient: options.rpcClient,
      ...options
    };
    
    this.keyPair = null;
    this.address = null;
    this.balance = 0;
    this.utxos = [];
  }
  
  /**
   * Initialize wallet
   */
  async initialize() {
    try {
      // Try to load existing wallet
      const loaded = await this.loadWallet();
      
      if (!loaded) {
        // Generate new wallet
        await this.generateWallet();
      }
      
      // Get balance
      await this.updateBalance();
      
      logger.info(`Pool wallet initialized: ${this.address}`);
      
      return true;
    } catch (error) {
      logger.error('Failed to initialize wallet:', error);
      throw error;
    }
  }
  
  /**
   * Generate new wallet
   */
  async generateWallet() {
    // Generate new key pair
    this.keyPair = bitcoinjs.ECPair.makeRandom({ network: this.options.network });
    
    // Generate address
    const { address } = bitcoinjs.payments.p2wpkh({
      pubkey: this.keyPair.publicKey,
      network: this.options.network
    });
    
    this.address = address;
    
    // Save wallet
    await this.saveWallet();
    
    logger.info(`Generated new pool wallet: ${this.address}`);
  }
  
  /**
   * Load wallet from file
   */
  async loadWallet() {
    try {
      const walletData = await fs.readFile(this.options.walletPath, 'utf8');
      const encrypted = JSON.parse(walletData);
      
      // Decrypt wallet data
      const decrypted = this.decrypt(encrypted.data, this.options.encryptionKey);
      const wallet = JSON.parse(decrypted);
      
      // Restore key pair
      this.keyPair = bitcoinjs.ECPair.fromWIF(wallet.wif, this.options.network);
      this.address = wallet.address;
      
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }
  
  /**
   * Save wallet to file
   */
  async saveWallet() {
    const walletData = {
      address: this.address,
      wif: this.keyPair.toWIF(),
      network: this.options.network === bitcoinjs.networks.bitcoin ? 'mainnet' : 'testnet',
      created: new Date().toISOString()
    };
    
    // Encrypt wallet data
    const encrypted = this.encrypt(JSON.stringify(walletData), this.options.encryptionKey);
    
    // Ensure directory exists
    const dir = path.dirname(this.options.walletPath);
    await fs.mkdir(dir, { recursive: true });
    
    // Save to file
    await fs.writeFile(this.options.walletPath, JSON.stringify({
      version: 1,
      data: encrypted
    }, null, 2));
  }
  
  /**
   * Get wallet balance
   */
  async getBalance() {
    return this.balance;
  }
  
  /**
   * Update balance from blockchain
   */
  async updateBalance() {
    if (!this.options.rpcClient) {
      logger.warn('No RPC client configured, cannot update balance');
      return;
    }
    
    try {
      // Get UTXOs for address
      const utxos = await this.getUTXOs();
      
      // Calculate balance
      this.balance = utxos.reduce((sum, utxo) => sum + utxo.value, 0) / 1e8; // satoshis to BTC
      this.utxos = utxos;
      
      logger.debug(`Wallet balance updated: ${this.balance} BTC`);
      
    } catch (error) {
      logger.error('Failed to update balance:', error);
    }
  }
  
  /**
   * Get UTXOs for address
   */
  async getUTXOs() {
    // In production, this would query the blockchain
    // For now, return mock data
    return [];
  }
  
  /**
   * Create transaction
   */
  async createTransaction(outputs, feeRate = 10) {
    try {
      const psbt = new bitcoinjs.Psbt({ network: this.options.network });
      
      // Add inputs
      let inputValue = 0;
      for (const utxo of this.utxos) {
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          witnessUtxo: {
            script: bitcoinjs.payments.p2wpkh({
              pubkey: this.keyPair.publicKey,
              network: this.options.network
            }).output,
            value: utxo.value
          }
        });
        
        inputValue += utxo.value;
        
        // Check if we have enough inputs
        const outputValue = outputs.reduce((sum, out) => sum + out.value, 0);
        const estimatedFee = this.estimateFee(psbt.inputCount, outputs.length, feeRate);
        
        if (inputValue >= outputValue + estimatedFee) {
          break;
        }
      }
      
      // Add outputs
      for (const output of outputs) {
        psbt.addOutput({
          address: output.address,
          value: output.value
        });
      }
      
      // Add change output if needed
      const outputValue = outputs.reduce((sum, out) => sum + out.value, 0);
      const fee = this.estimateFee(psbt.inputCount, outputs.length + 1, feeRate);
      const change = inputValue - outputValue - fee;
      
      if (change > 546) { // dust threshold
        psbt.addOutput({
          address: this.address,
          value: change
        });
      }
      
      // Sign inputs
      for (let i = 0; i < psbt.inputCount; i++) {
        psbt.signInput(i, this.keyPair);
      }
      
      // Finalize and extract transaction
      psbt.finalizeAllInputs();
      const tx = psbt.extractTransaction();
      
      return tx;
      
    } catch (error) {
      logger.error('Failed to create transaction:', error);
      throw error;
    }
  }
  
  /**
   * Broadcast transaction
   */
  async broadcastTransaction(transaction) {
    if (!this.options.rpcClient) {
      throw new Error('No RPC client configured');
    }
    
    try {
      const txHex = transaction.toHex();
      const txid = await this.options.rpcClient.call('sendrawtransaction', [txHex]);
      
      logger.info(`Transaction broadcast: ${txid}`);
      
      // Update balance
      await this.updateBalance();
      
      return txid;
      
    } catch (error) {
      logger.error('Failed to broadcast transaction:', error);
      throw error;
    }
  }
  
  /**
   * Estimate transaction fee
   */
  estimateFee(numInputs, numOutputs, feeRate) {
    // Estimate transaction size
    // P2WPKH: 10 + (68 * inputs) + (31 * outputs)
    const size = 10 + (68 * numInputs) + (31 * numOutputs);
    return Math.ceil(size * feeRate);
  }
  
  /**
   * Estimate fee rate from network
   */
  async estimateFeeRate(blocks = 6) {
    if (!this.options.rpcClient) {
      return 10; // default 10 sat/byte
    }
    
    try {
      const estimate = await this.options.rpcClient.call('estimatesmartfee', [blocks]);
      
      if (estimate.feerate) {
        // Convert BTC/KB to sat/byte
        return Math.ceil(estimate.feerate * 100000);
      }
      
      return 10;
      
    } catch (error) {
      logger.warn('Failed to estimate fee rate:', error);
      return 10;
    }
  }
  
  /**
   * Encrypt data
   */
  encrypt(data, key) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv);
    
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return iv.toString('hex') + ':' + encrypted;
  }
  
  /**
   * Decrypt data
   */
  decrypt(data, key) {
    const parts = data.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
  
  /**
   * Get wallet info
   */
  getInfo() {
    return {
      address: this.address,
      balance: this.balance,
      utxos: this.utxos.length,
      network: this.options.network === bitcoinjs.networks.bitcoin ? 'mainnet' : 'testnet'
    };
  }
}

module.exports = PoolWallet;