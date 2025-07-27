/**
 * Bulk Conversion Optimizer
 * Aggregates small conversions into larger batches for better rates
 * 
 * Features:
 * - Automatic batching of similar conversions
 * - Rate optimization through volume
 * - Smart timing for conversions
 * - Minimum batch thresholds
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('BulkConversionOptimizer');

/**
 * Conversion states
 */
export const ConversionState = {
  PENDING: 'pending',
  BATCHED: 'batched',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

/**
 * Bulk Conversion Optimizer
 */
export class BulkConversionOptimizer extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Batching configuration
      batchingEnabled: config.batchingEnabled !== false,
      minBatchSize: config.minBatchSize || {
        BTC: 0.01,      // 0.01 BTC minimum
        ETH: 0.1,       // 0.1 ETH minimum
        LTC: 1,         // 1 LTC minimum
        BCH: 0.5,       // 0.5 BCH minimum
        default: 50     // $50 USD equivalent
      },
      
      // Timing configuration
      maxWaitTime: config.maxWaitTime || 3600000, // 1 hour max wait
      checkInterval: config.checkInterval || 60000, // Check every minute
      
      // Rate optimization
      volumeDiscounts: config.volumeDiscounts || [
        { minVolume: 1000, discount: 0.0005 },    // 0.05% discount > $1k
        { minVolume: 5000, discount: 0.001 },     // 0.1% discount > $5k
        { minVolume: 10000, discount: 0.0015 },   // 0.15% discount > $10k
        { minVolume: 50000, discount: 0.002 }     // 0.2% discount > $50k
      ],
      
      // Processing configuration
      maxBatchSize: config.maxBatchSize || 100,  // Max conversions per batch
      priorityThreshold: config.priorityThreshold || 0.9, // 90% of min batch
      
      // Service preferences
      preferredServices: config.preferredServices || [
        'simpleswap',    // Best for bulk
        'changenow',     // Good rates
        'coinpayments'   // Bulk support
      ]
    };
    
    // State management
    this.pendingConversions = new Map();
    this.batchQueue = new Map();
    this.processingBatches = new Set();
    
    // Timers
    this.checkTimer = null;
    this.batchTimers = new Map();
    
    // Statistics
    this.stats = {
      totalBatches: 0,
      totalConversions: 0,
      totalVolume: 0,
      totalSaved: 0,
      averageBatchSize: 0,
      largestBatch: 0
    };
  }
  
  /**
   * Start the optimizer
   */
  start() {
    if (this.checkTimer) {
      logger.warn('Optimizer already running');
      return;
    }
    
    logger.info('Starting bulk conversion optimizer...');
    
    // Start periodic checks
    this.checkTimer = setInterval(() => {
      this.checkBatches();
    }, this.config.checkInterval);
    
    this.emit('started');
  }
  
  /**
   * Stop the optimizer
   */
  stop() {
    logger.info('Stopping bulk conversion optimizer...');
    
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    
    // Clear all batch timers
    for (const timer of this.batchTimers.values()) {
      clearTimeout(timer);
    }
    this.batchTimers.clear();
    
    this.emit('stopped');
  }
  
  /**
   * Add conversion to optimizer
   */
  async addConversion(conversion) {
    if (!this.config.batchingEnabled) {
      // Batching disabled, process immediately
      return await this.processImmediate(conversion);
    }
    
    const { fromCoin, toCoin, amount, address, userId, priority = false } = conversion;
    const pairKey = `${fromCoin}:${toCoin}`;
    const conversionId = this.generateId();
    
    // Create conversion record
    const record = {
      id: conversionId,
      fromCoin,
      toCoin,
      amount,
      address,
      userId,
      priority,
      state: ConversionState.PENDING,
      timestamp: Date.now(),
      pairKey
    };
    
    // Add to pending
    this.pendingConversions.set(conversionId, record);
    
    // Check if should process immediately
    if (priority || this.shouldProcessImmediate(record)) {
      return await this.processImmediate(record);
    }
    
    // Add to batch queue
    this.addToBatch(record);
    
    logger.info(`Added conversion ${conversionId} to batch queue`, {
      pair: pairKey,
      amount,
      userId
    });
    
    return {
      id: conversionId,
      status: 'queued',
      estimatedProcessingTime: this.getEstimatedProcessingTime(pairKey)
    };
  }
  
  /**
   * Add conversion to batch
   */
  addToBatch(conversion) {
    const { pairKey } = conversion;
    
    if (!this.batchQueue.has(pairKey)) {
      this.batchQueue.set(pairKey, {
        conversions: [],
        totalAmount: 0,
        oldestTimestamp: Date.now(),
        estimatedValue: 0
      });
      
      // Set max wait timer for this batch
      const timer = setTimeout(() => {
        this.processBatch(pairKey, 'timeout');
      }, this.config.maxWaitTime);
      
      this.batchTimers.set(pairKey, timer);
    }
    
    const batch = this.batchQueue.get(pairKey);
    batch.conversions.push(conversion);
    batch.totalAmount += conversion.amount;
    
    // Update conversion state
    conversion.state = ConversionState.BATCHED;
    
    // Check if batch should be processed
    this.checkBatchReady(pairKey);
  }
  
  /**
   * Check if batch is ready for processing
   */
  checkBatchReady(pairKey) {
    const batch = this.batchQueue.get(pairKey);
    if (!batch) return;
    
    const [fromCoin] = pairKey.split(':');
    const minBatchSize = this.config.minBatchSize[fromCoin] || this.config.minBatchSize.default;
    
    // Check if batch meets minimum size
    if (batch.totalAmount >= minBatchSize) {
      this.processBatch(pairKey, 'size_met');
      return;
    }
    
    // Check if batch is near threshold and has waited some time
    const waitTime = Date.now() - batch.oldestTimestamp;
    const sizeRatio = batch.totalAmount / minBatchSize;
    
    if (sizeRatio >= this.config.priorityThreshold && waitTime > 300000) { // 5 minutes
      this.processBatch(pairKey, 'priority_threshold');
      return;
    }
    
    // Check if batch is at max size
    if (batch.conversions.length >= this.config.maxBatchSize) {
      this.processBatch(pairKey, 'max_size');
    }
  }
  
  /**
   * Process batch
   */
  async processBatch(pairKey, reason) {
    const batch = this.batchQueue.get(pairKey);
    if (!batch || batch.conversions.length === 0) return;
    
    // Clear timer
    const timer = this.batchTimers.get(pairKey);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(pairKey);
    }
    
    // Remove from queue
    this.batchQueue.delete(pairKey);
    
    // Mark as processing
    const batchId = this.generateId();
    this.processingBatches.add(batchId);
    
    batch.conversions.forEach(conv => {
      conv.state = ConversionState.PROCESSING;
      conv.batchId = batchId;
    });
    
    logger.info(`Processing batch ${batchId}`, {
      pair: pairKey,
      count: batch.conversions.length,
      totalAmount: batch.totalAmount,
      reason
    });
    
    try {
      // Get optimal service and rate
      const result = await this.executeBatchConversion(batch, pairKey);
      
      // Update statistics
      this.updateStats(batch, result);
      
      // Mark conversions as completed
      batch.conversions.forEach(conv => {
        conv.state = ConversionState.COMPLETED;
        conv.result = result;
        this.pendingConversions.delete(conv.id);
      });
      
      // Emit completion event
      this.emit('batch:completed', {
        batchId,
        pairKey,
        conversions: batch.conversions.length,
        totalAmount: batch.totalAmount,
        savedAmount: result.savedAmount || 0
      });
      
    } catch (error) {
      logger.error(`Batch ${batchId} failed:`, error);
      
      // Mark conversions as failed
      batch.conversions.forEach(conv => {
        conv.state = ConversionState.FAILED;
        conv.error = error.message;
      });
      
      // Retry individual conversions
      for (const conv of batch.conversions) {
        await this.processImmediate(conv);
      }
      
    } finally {
      this.processingBatches.delete(batchId);
    }
  }
  
  /**
   * Execute batch conversion
   */
  async executeBatchConversion(batch, pairKey) {
    const [fromCoin, toCoin] = pairKey.split(':');
    const totalAmount = batch.totalAmount;
    
    // Calculate volume discount
    const estimatedValue = await this.estimateValue(fromCoin, totalAmount);
    const volumeDiscount = this.getVolumeDiscount(estimatedValue);
    
    // Find best service for bulk
    const service = await this.findBestBulkService(fromCoin, toCoin, totalAmount);
    
    logger.info(`Executing bulk conversion`, {
      service: service.name,
      fromCoin,
      toCoin,
      totalAmount,
      volumeDiscount: volumeDiscount * 100 + '%',
      estimatedValue
    });
    
    // Execute conversion
    const conversionResult = await service.executeBulkConversion({
      fromCoin,
      toCoin,
      amount: totalAmount,
      addresses: batch.conversions.map(c => ({
        address: c.address,
        amount: c.amount,
        userId: c.userId
      }))
    });
    
    // Calculate savings
    const standardFee = totalAmount * 0.002; // Standard 0.2% fee
    const actualFee = conversionResult.fee;
    const savedAmount = standardFee - actualFee + (totalAmount * volumeDiscount);
    
    return {
      ...conversionResult,
      volumeDiscount,
      savedAmount,
      service: service.name
    };
  }
  
  /**
   * Process conversion immediately
   */
  async processImmediate(conversion) {
    conversion.state = ConversionState.PROCESSING;
    
    try {
      // Execute single conversion
      const result = await this.executeSingleConversion(conversion);
      
      conversion.state = ConversionState.COMPLETED;
      conversion.result = result;
      
      this.pendingConversions.delete(conversion.id);
      
      return {
        id: conversion.id,
        status: 'completed',
        result
      };
      
    } catch (error) {
      conversion.state = ConversionState.FAILED;
      conversion.error = error.message;
      
      throw error;
    }
  }
  
  /**
   * Execute single conversion
   */
  async executeSingleConversion(conversion) {
    // This would integrate with the external service converter
    // For now, return mock result
    return {
      success: true,
      txId: 'mock_tx_' + conversion.id,
      amount: conversion.amount,
      fee: conversion.amount * 0.002
    };
  }
  
  /**
   * Check if should process immediately
   */
  shouldProcessImmediate(conversion) {
    const { fromCoin, amount } = conversion;
    const minBatchSize = this.config.minBatchSize[fromCoin] || this.config.minBatchSize.default;
    
    // Process immediately if:
    // 1. Amount is already above minimum batch size
    // 2. Batching is disabled for this coin
    // 3. Priority flag is set
    
    return amount >= minBatchSize * 2; // 2x minimum for immediate
  }
  
  /**
   * Get volume discount
   */
  getVolumeDiscount(value) {
    let discount = 0;
    
    for (const tier of this.config.volumeDiscounts) {
      if (value >= tier.minVolume) {
        discount = tier.discount;
      }
    }
    
    return discount;
  }
  
  /**
   * Estimate USD value
   */
  async estimateValue(coin, amount) {
    // This would get real-time prices
    // For now, use estimated values
    const prices = {
      BTC: 90000,
      ETH: 3000,
      LTC: 100,
      BCH: 300
    };
    
    return amount * (prices[coin] || 100);
  }
  
  /**
   * Find best service for bulk conversion
   */
  async findBestBulkService(fromCoin, toCoin, amount) {
    // This would integrate with the service failover manager
    // For now, return mock service
    return {
      name: 'simpleswap',
      executeBulkConversion: async (params) => ({
        success: true,
        fee: params.amount * 0.0015, // 0.15% for bulk
        transactions: params.addresses.map(a => ({
          address: a.address,
          amount: a.amount,
          txId: 'bulk_tx_' + Math.random().toString(36)
        }))
      })
    };
  }
  
  /**
   * Check all batches
   */
  checkBatches() {
    for (const [pairKey, batch] of this.batchQueue) {
      // Check age of oldest conversion
      const age = Date.now() - batch.oldestTimestamp;
      
      if (age > this.config.maxWaitTime * 0.8) {
        // Getting close to timeout, check if we should process
        this.checkBatchReady(pairKey);
      }
    }
  }
  
  /**
   * Get estimated processing time
   */
  getEstimatedProcessingTime(pairKey) {
    const batch = this.batchQueue.get(pairKey);
    if (!batch) return null;
    
    const [fromCoin] = pairKey.split(':');
    const minBatchSize = this.config.minBatchSize[fromCoin] || this.config.minBatchSize.default;
    const progress = batch.totalAmount / minBatchSize;
    
    if (progress >= 1) {
      return Date.now() + 60000; // Process in 1 minute
    }
    
    // Estimate based on historical data
    const remainingTime = Math.min(
      this.config.maxWaitTime - (Date.now() - batch.oldestTimestamp),
      (1 - progress) * 600000 // 10 minutes per 10% remaining
    );
    
    return Date.now() + remainingTime;
  }
  
  /**
   * Update statistics
   */
  updateStats(batch, result) {
    this.stats.totalBatches++;
    this.stats.totalConversions += batch.conversions.length;
    this.stats.totalVolume += batch.totalAmount;
    this.stats.totalSaved += result.savedAmount || 0;
    
    // Update average batch size
    this.stats.averageBatchSize = 
      (this.stats.averageBatchSize * (this.stats.totalBatches - 1) + batch.conversions.length) / 
      this.stats.totalBatches;
    
    // Update largest batch
    if (batch.conversions.length > this.stats.largestBatch) {
      this.stats.largestBatch = batch.conversions.length;
    }
  }
  
  /**
   * Get optimizer statistics
   */
  getStats() {
    const queuedConversions = Array.from(this.batchQueue.values())
      .reduce((sum, batch) => sum + batch.conversions.length, 0);
    
    return {
      ...this.stats,
      queuedConversions,
      activeBatches: this.batchQueue.size,
      processingBatches: this.processingBatches.size,
      pendingConversions: this.pendingConversions.size,
      averageSavings: this.stats.totalVolume > 0
        ? (this.stats.totalSaved / this.stats.totalVolume * 100).toFixed(2) + '%'
        : '0%'
    };
  }
  
  /**
   * Get batch status
   */
  getBatchStatus() {
    const status = {};
    
    for (const [pairKey, batch] of this.batchQueue) {
      const [fromCoin] = pairKey.split(':');
      const minBatchSize = this.config.minBatchSize[fromCoin] || this.config.minBatchSize.default;
      
      status[pairKey] = {
        conversions: batch.conversions.length,
        totalAmount: batch.totalAmount,
        progress: (batch.totalAmount / minBatchSize * 100).toFixed(1) + '%',
        oldestWaiting: Date.now() - batch.oldestTimestamp,
        estimatedProcessingTime: this.getEstimatedProcessingTime(pairKey)
      };
    }
    
    return status;
  }
  
  /**
   * Generate unique ID
   */
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}

export default BulkConversionOptimizer;