/**
 * Miner Address Manager
 * Manages miner payment addresses and allows custom BTC address configuration
 */

const { EventEmitter } = require('events');
const { createLogger } = require('../core/logger');
const crypto = require('crypto');

const logger = createLogger('miner-address-manager');

class MinerAddressManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      addressValidation: options.addressValidation !== false,
      allowAddressChange: options.allowAddressChange !== false,
      addressChangeDelay: options.addressChangeDelay || 86400000, // 24 hours
      requireSignature: options.requireSignature || false,
      ...options
    };
    
    // Miner data storage
    this.miners = new Map(); // minerId -> minerData
    this.addressIndex = new Map(); // miningAddress -> minerId
    this.paymentIndex = new Map(); // paymentAddress -> [minerIds]
    
    // Statistics
    this.stats = {
      totalMiners: 0,
      customAddresses: 0,
      addressChanges: 0
    };
  }
  
  /**
   * Register a new miner with mining address
   */
  registerMiner(miningAddress, worker = 'default', paymentAddress = null) {
    // Validate addresses
    if (this.options.addressValidation) {
      if (!this.isValidBitcoinAddress(miningAddress)) {
        throw new Error('Invalid mining address format');
      }
      
      if (paymentAddress && !this.isValidBitcoinAddress(paymentAddress)) {
        throw new Error('Invalid payment address format');
      }
    }
    
    // Check if miner already exists
    let minerId = this.addressIndex.get(miningAddress);
    
    if (!minerId) {
      // Create new miner
      minerId = this.generateMinerId();
      const effectivePaymentAddress = paymentAddress || miningAddress;
      
      const minerData = {
        id: minerId,
        miningAddress,
        paymentAddress: effectivePaymentAddress,
        workers: new Set([worker]),
        registeredAt: Date.now(),
        lastSeen: Date.now(),
        addressHistory: [{
          address: effectivePaymentAddress,
          timestamp: Date.now(),
          type: 'initial'
        }],
        stats: {
          shares: 0,
          validShares: 0,
          blocks: 0,
          totalPaid: 0,
          pendingBalance: 0
        }
      };
      
      this.miners.set(minerId, minerData);
      this.addressIndex.set(miningAddress, minerId);
      
      // Update payment index
      this.updatePaymentIndex(effectivePaymentAddress, minerId, 'add');
      
      this.stats.totalMiners++;
      if (paymentAddress && paymentAddress !== miningAddress) {
        this.stats.customAddresses++;
      }
      
      logger.info(`New miner registered: ${miningAddress} -> ${effectivePaymentAddress}`);
      this.emit('miner-registered', minerData);
    } else {
      // Update existing miner
      const minerData = this.miners.get(minerId);
      minerData.workers.add(worker);
      minerData.lastSeen = Date.now();
      
      // Update payment address if provided
      if (paymentAddress && paymentAddress !== minerData.paymentAddress) {
        this.updatePaymentAddress(minerId, paymentAddress);
      }
    }
    
    return minerId;
  }
  
  /**
   * Update miner's payment address
   */
  updatePaymentAddress(minerId, newAddress, signature = null) {
    const miner = this.miners.get(minerId);
    if (!miner) {
      throw new Error('Miner not found');
    }
    
    // Validate new address
    if (this.options.addressValidation && !this.isValidBitcoinAddress(newAddress)) {
      throw new Error('Invalid Bitcoin address format');
    }
    
    // Check if address change is allowed
    if (!this.options.allowAddressChange) {
      throw new Error('Address changes are not allowed by pool policy');
    }
    
    // Check if same as current
    if (newAddress === miner.paymentAddress) {
      return true; // No change needed
    }
    
    // Check cooldown period
    const lastChange = miner.addressHistory[miner.addressHistory.length - 1];
    if (lastChange.type === 'change') {
      const timeSinceLastChange = Date.now() - lastChange.timestamp;
      if (timeSinceLastChange < this.options.addressChangeDelay) {
        const remainingTime = this.options.addressChangeDelay - timeSinceLastChange;
        const hours = Math.ceil(remainingTime / 3600000);
        throw new Error(`Address change on cooldown. Try again in ${hours} hours`);
      }
    }
    
    // Verify signature if required
    if (this.options.requireSignature && !this.verifyAddressChangeSignature(miner, newAddress, signature)) {
      throw new Error('Invalid signature for address change');
    }
    
    // Update indices
    this.updatePaymentIndex(miner.paymentAddress, minerId, 'remove');
    this.updatePaymentIndex(newAddress, minerId, 'add');
    
    // Record address change
    const oldAddress = miner.paymentAddress;
    miner.paymentAddress = newAddress;
    miner.addressHistory.push({
      address: newAddress,
      previousAddress: oldAddress,
      timestamp: Date.now(),
      type: 'change',
      signature
    });
    
    // Update stats
    if (newAddress !== miner.miningAddress && oldAddress === miner.miningAddress) {
      this.stats.customAddresses++;
    } else if (newAddress === miner.miningAddress && oldAddress !== miner.miningAddress) {
      this.stats.customAddresses--;
    }
    this.stats.addressChanges++;
    
    logger.info(`Payment address updated for miner ${minerId}: ${oldAddress} -> ${newAddress}`);
    
    this.emit('payment-address-changed', {
      minerId,
      miningAddress: miner.miningAddress,
      oldPaymentAddress: oldAddress,
      newPaymentAddress: newAddress,
      timestamp: Date.now()
    });
    
    return true;
  }
  
  /**
   * Get payment address for a miner
   */
  getPaymentAddress(minerId) {
    const miner = this.miners.get(minerId);
    return miner ? miner.paymentAddress : null;
  }
  
  /**
   * Get payment address by mining address
   */
  getPaymentAddressByMiningAddress(miningAddress) {
    const minerId = this.addressIndex.get(miningAddress);
    if (!minerId) return null;
    
    const miner = this.miners.get(minerId);
    return miner ? miner.paymentAddress : null;
  }
  
  /**
   * Get all miners using a specific payment address
   */
  getMinersByPaymentAddress(paymentAddress) {
    const minerIds = this.paymentIndex.get(paymentAddress) || [];
    return minerIds.map(id => this.miners.get(id)).filter(Boolean);
  }
  
  /**
   * Get miner info
   */
  getMinerInfo(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner) return null;
    
    return {
      id: miner.id,
      miningAddress: miner.miningAddress,
      paymentAddress: miner.paymentAddress,
      isCustomAddress: miner.paymentAddress !== miner.miningAddress,
      workers: Array.from(miner.workers),
      registeredAt: miner.registeredAt,
      lastSeen: miner.lastSeen,
      addressChanges: miner.addressHistory.filter(h => h.type === 'change').length,
      stats: { ...miner.stats }
    };
  }
  
  /**
   * Update miner statistics
   */
  updateMinerStats(minerId, updates) {
    const miner = this.miners.get(minerId);
    if (!miner) return;
    
    if (updates.shares !== undefined) miner.stats.shares += updates.shares;
    if (updates.validShares !== undefined) miner.stats.validShares += updates.validShares;
    if (updates.blocks !== undefined) miner.stats.blocks += updates.blocks;
    if (updates.paid !== undefined) miner.stats.totalPaid += updates.paid;
    if (updates.pendingBalance !== undefined) miner.stats.pendingBalance = updates.pendingBalance;
    
    miner.lastSeen = Date.now();
  }
  
  /**
   * Get payment summary (groups miners by payment address)
   */
  getPaymentSummary() {
    const summary = new Map();
    
    for (const [paymentAddress, minerIds] of this.paymentIndex) {
      let totalBalance = 0;
      let totalShares = 0;
      const miners = [];
      
      for (const minerId of minerIds) {
        const miner = this.miners.get(minerId);
        if (miner) {
          totalBalance += miner.stats.pendingBalance;
          totalShares += miner.stats.validShares;
          miners.push({
            id: minerId,
            miningAddress: miner.miningAddress,
            shares: miner.stats.validShares,
            balance: miner.stats.pendingBalance
          });
        }
      }
      
      summary.set(paymentAddress, {
        address: paymentAddress,
        totalBalance,
        totalShares,
        minerCount: miners.length,
        miners
      });
    }
    
    return Array.from(summary.values());
  }
  
  /**
   * Validate Bitcoin address format
   */
  isValidBitcoinAddress(address) {
    if (!address || typeof address !== 'string') return false;
    
    // P2PKH addresses (Legacy) - start with 1
    if (address.match(/^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/)) {
      return true;
    }
    
    // P2SH addresses (SegWit compatible) - start with 3
    if (address.match(/^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/)) {
      return true;
    }
    
    // Bech32 addresses (Native SegWit) - start with bc1
    if (address.match(/^bc1[a-z0-9]{39,59}$/)) {
      return true;
    }
    
    // Testnet addresses
    if (address.match(/^[mn2][a-km-zA-HJ-NP-Z1-9]{25,34}$/)) {
      return true;
    }
    
    // Testnet Bech32
    if (address.match(/^tb1[a-z0-9]{39,59}$/)) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Verify signature for address change (placeholder)
   */
  verifyAddressChangeSignature(miner, newAddress, signature) {
    // In a real implementation, this would verify that the signature
    // was created by signing a message with the private key of the
    // current payment address, proving ownership
    
    // For now, just check if signature is provided
    return !!signature;
  }
  
  /**
   * Update payment index
   */
  updatePaymentIndex(address, minerId, action) {
    if (action === 'add') {
      if (!this.paymentIndex.has(address)) {
        this.paymentIndex.set(address, []);
      }
      const miners = this.paymentIndex.get(address);
      if (!miners.includes(minerId)) {
        miners.push(minerId);
      }
    } else if (action === 'remove') {
      const miners = this.paymentIndex.get(address);
      if (miners) {
        const index = miners.indexOf(minerId);
        if (index !== -1) {
          miners.splice(index, 1);
        }
        if (miners.length === 0) {
          this.paymentIndex.delete(address);
        }
      }
    }
  }
  
  /**
   * Generate unique miner ID
   */
  generateMinerId() {
    return crypto.randomBytes(16).toString('hex');
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      uniquePaymentAddresses: this.paymentIndex.size,
      averageMinersPerAddress: this.stats.totalMiners / this.paymentIndex.size || 0
    };
  }
  
  /**
   * Export address mappings (for backup/audit)
   */
  exportAddressMappings() {
    const mappings = [];
    
    for (const [minerId, miner] of this.miners) {
      mappings.push({
        minerId,
        miningAddress: miner.miningAddress,
        paymentAddress: miner.paymentAddress,
        isCustom: miner.paymentAddress !== miner.miningAddress,
        registeredAt: miner.registeredAt,
        lastChange: miner.addressHistory[miner.addressHistory.length - 1].timestamp
      });
    }
    
    return mappings;
  }
}

module.exports = MinerAddressManager;