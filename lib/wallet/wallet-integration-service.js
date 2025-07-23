const { BaseService } = require('../common/base-service');
const MultiCurrencyWallet = require('./multi-currency-wallet');
const QRCode = require('qrcode');

class WalletIntegrationService extends BaseService {
  constructor(options = {}) {
    super('WalletIntegrationService', {
      // Mining pool integration
      poolPaymentProcessor: options.poolPaymentProcessor,
      
      // Auto-conversion
      enableAutoConversion: options.enableAutoConversion !== false,
      targetCurrency: options.targetCurrency || 'USDT',
      conversionThreshold: options.conversionThreshold || 100, // $100
      
      // Security
      enable2FA: options.enable2FA !== false,
      withdrawalLimits: {
        daily: options.dailyLimit || 10000, // $10,000
        perTransaction: options.transactionLimit || 1000 // $1,000
      },
      
      // Notifications
      enableNotifications: options.enableNotifications !== false,
      notificationChannels: options.notificationChannels || ['email', 'webhook'],
      
      // Features
      enableMiningRewards: options.enableMiningRewards !== false,
      enableStaking: options.enableStaking !== false,
      enableDeFiIntegration: options.enableDeFiIntegration !== false,
      
      ...options
    });
    
    // Initialize wallet
    this.wallet = new MultiCurrencyWallet(options.walletConfig);
    
    // Service state
    this.minerWallets = new Map(); // Miner ID -> Wallet mapping
    this.pendingPayments = new Map();
    this.stakingPositions = new Map();
    this.conversionQueue = [];
    
    // Statistics (extending base metrics)
    this.walletStats = {
      totalPayouts: 0,
      totalVolume: 0,
      activeWallets: 0,
      stakingVolume: 0
    };
  }
  
  async onInitialize() {
    // Initialize wallet system
    await this.wallet.initialize();
    
    // Setup event handlers
    this.setupEventHandlers();
    
    // Start services using BaseService timers
    if (this.config.enableAutoConversion) {
      this.startTimer('autoConversion', () => this.processConversionQueue(), 60000); // Every minute
    }
    
    if (this.config.enableMiningRewards) {
      this.startTimer('rewardDistribution', () => this.distributeRewards(), 300000); // Every 5 minutes
    }
  }
  
  setupEventHandlers() {
    // Handle wallet events
    this.wallet.on('transactionSent', (tx) => {
      this.handleTransactionSent(tx);
    });
    
    this.wallet.on('balanceUpdated', (data) => {
      this.handleBalanceUpdate(data);
    });
    
    // Handle pool payment events
    if (this.config.poolPaymentProcessor) {
      this.config.poolPaymentProcessor.on('paymentReady', (payment) => {
        this.handlePoolPayment(payment);
      });
    }
  }
  
  // Miner Wallet Management
  
  async createMinerWallet(minerId, options = {}) {
    const {
      name = `Miner ${minerId}`,
      password,
      currencies = ['bitcoin', 'ethereum', 'binanceSmartChain']
    } = options;
    
    try {
      // Create multi-currency wallet for miner
      const walletData = await this.wallet.createWallet({
        name,
        password,
        currencies
      });
      
      // Store miner-wallet mapping
      this.minerWallets.set(minerId, {
        walletId: walletData.walletId,
        addresses: walletData.addresses,
        created: Date.now(),
        settings: {
          autoConvert: options.autoConvert !== false,
          targetCurrency: options.targetCurrency || this.config.targetCurrency,
          notificationEmail: options.email
        }
      });
      
      // Generate QR codes for addresses
      const qrCodes = {};
      for (const [currency, address] of Object.entries(walletData.addresses)) {
        qrCodes[currency] = await QRCode.toDataURL(address);
      }
      
      this.walletStats.activeWallets++;
      
      this.emit('minerWalletCreated', {
        minerId,
        walletId: walletData.walletId,
        addresses: walletData.addresses,
        qrCodes
      });
      
      return {
        ...walletData,
        qrCodes
      };
      
    } catch (error) {
      this.emit('error', { type: 'walletCreation', minerId, error });
      throw error;
    }
  }
  
  async importMinerWallet(minerId, importData) {
    const { mnemonic, privateKey, currency, password } = importData;
    
    try {
      const walletData = await this.wallet.importWallet({
        name: `Miner ${minerId} (Imported)`,
        mnemonic,
        privateKey,
        currency,
        password
      });
      
      this.minerWallets.set(minerId, {
        walletId: walletData.walletId,
        addresses: walletData.addresses,
        created: Date.now(),
        imported: true
      });
      
      this.walletStats.activeWallets++;
      
      return walletData;
      
    } catch (error) {
      this.emit('error', { type: 'walletImport', minerId, error });
      throw error;
    }
  }
  
  // Mining Rewards Distribution
  
  async handlePoolPayment(payment) {
    const { minerId, amount, currency, blockHeight, blockHash } = payment;
    
    const minerWallet = this.minerWallets.get(minerId);
    if (!minerWallet) {
      console.error(`No wallet found for miner ${minerId}`);
      return;
    }
    
    try {
      // Add to pending payments
      const paymentId = this.generatePaymentId();
      this.pendingPayments.set(paymentId, {
        minerId,
        walletId: minerWallet.walletId,
        amount,
        currency,
        blockHeight,
        blockHash,
        status: 'pending',
        created: Date.now()
      });
      
      // Process payment
      await this.processMinerPayment(paymentId);
      
    } catch (error) {
      this.emit('error', { type: 'poolPayment', payment, error });
    }
  }
  
  async processMinerPayment(paymentId) {
    const payment = this.pendingPayments.get(paymentId);
    if (!payment) return;
    
    try {
      // Update miner balance in wallet
      const minerWallet = this.minerWallets.get(payment.minerId);
      const walletAddress = minerWallet.addresses[payment.currency];
      
      if (!walletAddress) {
        throw new Error(`Miner wallet doesn't support ${payment.currency}`);
      }
      
      // Record the payment
      this.recordPayment({
        ...payment,
        address: walletAddress,
        status: 'completed'
      });
      
      // Update statistics
      this.walletStats.totalPayouts++;
      this.walletStats.totalVolume += this.convertToUSD(payment.amount, payment.currency);
      
      // Check for auto-conversion
      if (minerWallet.settings.autoConvert) {
        await this.queueForConversion(payment);
      }
      
      // Send notifications
      if (this.config.enableNotifications) {
        await this.sendPaymentNotification(payment);
      }
      
      // Remove from pending
      this.pendingPayments.delete(paymentId);
      
      this.emit('paymentProcessed', payment);
      
    } catch (error) {
      payment.status = 'failed';
      payment.error = error.message;
      this.emit('paymentFailed', payment);
    }
  }
  
  // Auto-conversion Service
  
  startAutoConversion() {
    this.conversionInterval = setInterval(() => {
      this.processConversionQueue();
    }, 60000); // Check every minute
  }
  
  async queueForConversion(payment) {
    const minerWallet = this.minerWallets.get(payment.minerId);
    const balance = await this.wallet.getBalance(
      `${minerWallet.walletId}_${payment.currency}`,
      payment.currency
    );
    
    const balanceUSD = this.convertToUSD(balance.confirmed, payment.currency);
    
    if (balanceUSD >= this.config.conversionThreshold) {
      this.conversionQueue.push({
        minerId: payment.minerId,
        walletId: minerWallet.walletId,
        fromCurrency: payment.currency,
        toCurrency: minerWallet.settings.targetCurrency,
        amount: balance.confirmed,
        estimatedUSD: balanceUSD
      });
    }
  }
  
  async processConversionQueue() {
    if (this.conversionQueue.length === 0) return;
    
    const conversions = [...this.conversionQueue];
    this.conversionQueue = [];
    
    for (const conversion of conversions) {
      try {
        await this.executeConversion(conversion);
      } catch (error) {
        console.error('Conversion failed:', error);
        // Re-queue for retry
        this.conversionQueue.push(conversion);
      }
    }
  }
  
  async executeConversion(conversion) {
    // This would integrate with a DEX or exchange API
    // For now, we'll simulate the conversion
    
    const { minerId, fromCurrency, toCurrency, amount } = conversion;
    
    // Calculate conversion rate
    const fromPrice = this.wallet.prices.get(fromCurrency)?.price || 0;
    const toPrice = this.wallet.prices.get(toCurrency)?.price || 1;
    const convertedAmount = (parseFloat(amount) * fromPrice) / toPrice;
    
    // Record conversion
    this.emit('conversionExecuted', {
      minerId,
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount: convertedAmount.toFixed(8),
      rate: fromPrice / toPrice
    });
    
    return convertedAmount;
  }
  
  // Staking Integration
  
  async stakeCurrency(minerId, currency, amount, duration) {
    const minerWallet = this.minerWallets.get(minerId);
    if (!minerWallet) {
      throw new Error('Miner wallet not found');
    }
    
    const stakingId = this.generateStakingId();
    const apr = this.getStakingAPR(currency, duration);
    
    const position = {
      id: stakingId,
      minerId,
      walletId: minerWallet.walletId,
      currency,
      amount,
      duration,
      apr,
      startTime: Date.now(),
      endTime: Date.now() + duration * 86400000, // duration in days
      status: 'active',
      rewards: 0
    };
    
    this.stakingPositions.set(stakingId, position);
    
    // Update staking volume
    this.walletStats.stakingVolume += this.convertToUSD(amount, currency);
    
    this.emit('stakingStarted', position);
    
    return position;
  }
  
  async calculateStakingRewards(stakingId) {
    const position = this.stakingPositions.get(stakingId);
    if (!position) return 0;
    
    const elapsed = Date.now() - position.startTime;
    const daysElapsed = elapsed / 86400000;
    const rewards = parseFloat(position.amount) * (position.apr / 100) * (daysElapsed / 365);
    
    return rewards.toFixed(8);
  }
  
  getStakingAPR(currency, duration) {
    // Simple APR calculation based on duration
    const baseAPR = {
      bitcoin: 3,
      ethereum: 5,
      binanceSmartChain: 8,
      polygon: 10
    };
    
    const durationMultiplier = {
      30: 1,    // 30 days
      90: 1.2,  // 90 days
      180: 1.5, // 180 days
      365: 2    // 365 days
    };
    
    return (baseAPR[currency] || 5) * (durationMultiplier[duration] || 1);
  }
  
  // Withdrawal Management
  
  async requestWithdrawal(minerId, options) {
    const {
      currency,
      amount,
      toAddress,
      password,
      twoFactorCode
    } = options;
    
    const minerWallet = this.minerWallets.get(minerId);
    if (!minerWallet) {
      throw new Error('Miner wallet not found');
    }
    
    // Validate 2FA if enabled
    if (this.config.enable2FA && !this.validate2FA(minerId, twoFactorCode)) {
      throw new Error('Invalid 2FA code');
    }
    
    // Check withdrawal limits
    const amountUSD = this.convertToUSD(amount, currency);
    if (amountUSD > this.config.withdrawalLimits.perTransaction) {
      throw new Error('Amount exceeds per-transaction limit');
    }
    
    const dailyTotal = await this.getDailyWithdrawalTotal(minerId);
    if (dailyTotal + amountUSD > this.config.withdrawalLimits.daily) {
      throw new Error('Amount exceeds daily withdrawal limit');
    }
    
    // Process withdrawal
    const transaction = await this.wallet.sendTransaction({
      fromWalletId: `${minerWallet.walletId}_${currency}`,
      toAddress,
      amount,
      currency,
      password
    });
    
    // Record withdrawal
    this.recordWithdrawal({
      minerId,
      ...transaction,
      amountUSD
    });
    
    // Send notification
    if (this.config.enableNotifications) {
      await this.sendWithdrawalNotification({
        minerId,
        amount,
        currency,
        toAddress,
        transactionHash: transaction.hash
      });
    }
    
    return transaction;
  }
  
  // Utility Methods
  
  convertToUSD(amount, currency) {
    const price = this.wallet.prices.get(currency)?.price || 0;
    return parseFloat(amount) * price;
  }
  
  async getDailyWithdrawalTotal(minerId) {
    // Get withdrawals from last 24 hours
    const since = Date.now() - 86400000;
    const withdrawals = await this.getWithdrawalHistory(minerId, { since });
    
    return withdrawals.reduce((total, w) => total + w.amountUSD, 0);
  }
  
  validate2FA(minerId, code) {
    // This would integrate with the 2FA service
    // For now, return true for demo
    return true;
  }
  
  async sendPaymentNotification(payment) {
    const notification = {
      type: 'mining_payment',
      minerId: payment.minerId,
      amount: payment.amount,
      currency: payment.currency,
      blockHeight: payment.blockHeight,
      timestamp: Date.now()
    };
    
    // Send via configured channels
    for (const channel of this.config.notificationChannels) {
      try {
        await this.sendNotification(channel, notification);
      } catch (error) {
        console.error(`Failed to send notification via ${channel}:`, error);
      }
    }
  }
  
  async sendWithdrawalNotification(withdrawal) {
    const notification = {
      type: 'withdrawal',
      minerId: withdrawal.minerId,
      amount: withdrawal.amount,
      currency: withdrawal.currency,
      toAddress: withdrawal.toAddress,
      transactionHash: withdrawal.transactionHash,
      timestamp: Date.now()
    };
    
    for (const channel of this.config.notificationChannels) {
      try {
        await this.sendNotification(channel, notification);
      } catch (error) {
        console.error(`Failed to send notification via ${channel}:`, error);
      }
    }
  }
  
  async sendNotification(channel, notification) {
    // Implementation would depend on channel type
    switch (channel) {
      case 'email':
        // Send email notification
        break;
      case 'webhook':
        // Send webhook notification
        break;
      case 'push':
        // Send push notification
        break;
    }
  }
  
  // Database helpers
  
  recordPayment(payment) {
    // This would save to database
    // For now, emit event
    this.emit('paymentRecorded', payment);
  }
  
  recordWithdrawal(withdrawal) {
    // This would save to database
    // For now, emit event
    this.emit('withdrawalRecorded', withdrawal);
  }
  
  async getWithdrawalHistory(minerId, options = {}) {
    // This would query from database
    // For now, return empty array
    return [];
  }
  
  // ID generators
  
  generatePaymentId() {
    return 'payment_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }
  
  generateStakingId() {
    return 'stake_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }
  
  // Public API
  
  getMinerWallet(minerId) {
    return this.minerWallets.get(minerId);
  }
  
  getMinerBalance(minerId) {
    const minerWallet = this.minerWallets.get(minerId);
    if (!minerWallet) return null;
    
    const balances = {};
    let totalUSD = 0;
    
    for (const currency of Object.keys(minerWallet.addresses)) {
      const balance = this.wallet.getBalance(minerWallet.walletId, currency);
      const balanceUSD = this.convertToUSD(balance.confirmed, currency);
      
      balances[currency] = {
        amount: balance.confirmed,
        usd: balanceUSD
      };
      
      totalUSD += balanceUSD;
    }
    
    return {
      balances,
      totalUSD
    };
  }
  
  getMinerTransactions(minerId, options = {}) {
    const minerWallet = this.minerWallets.get(minerId);
    if (!minerWallet) return [];
    
    return this.wallet.getTransactionHistory(minerWallet.walletId, options);
  }
  
  getMinerStakingPositions(minerId) {
    const positions = [];
    
    for (const [id, position] of this.stakingPositions) {
      if (position.minerId === minerId) {
        positions.push({
          ...position,
          currentRewards: this.calculateStakingRewards(id)
        });
      }
    }
    
    return positions;
  }
  
  async getStats() {
    const baseStats = await super.getStats();
    
    return {
      ...baseStats,
      wallet: {
        ...this.walletStats,
        pendingPayments: this.pendingPayments.size,
        conversionQueueSize: this.conversionQueue.length,
        activeStakingPositions: Array.from(this.stakingPositions.values())
          .filter(p => p.status === 'active').length
      }
    };
  }
  
  // Alias for backward compatibility
  getStatistics() {
    return this.getStats();
  }
  
  async onShutdown() {
    // Process remaining conversions
    if (this.conversionQueue.length > 0) {
      await this.processConversionQueue();
    }
    
    // Stop wallet
    if (this.wallet && this.wallet.stop) {
      await this.wallet.stop();
    }
  }
  
  // Alias for backward compatibility
  async stop() {
    return this.shutdown();
  }
}

module.exports = WalletIntegrationService;