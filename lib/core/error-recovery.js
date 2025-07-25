/**
 * Error Recovery Manager - Otedama
 * Advanced error handling and recovery system
 * 
 * Features:
 * - Detailed error tracking
 * - Automatic retry mechanisms
 * - Error pattern analysis
 * - Recovery strategies
 * - Error notification prioritization
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('ErrorRecovery');

export class ErrorRecoveryManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 1000,
      exponentialBackoff: config.exponentialBackoff !== false,
      errorThreshold: config.errorThreshold || 10,
      errorWindow: config.errorWindow || 300000, // 5 minutes
      recoveryStrategies: config.recoveryStrategies || {}
    };
    
    // Error tracking
    this.errors = new Map();
    this.errorPatterns = new Map();
    this.recoveryStats = {
      total: 0,
      successful: 0,
      failed: 0
    };
    
    // Recovery strategies
    this.strategies = new Map([
      ['ECONNREFUSED', this.handleConnectionRefused.bind(this)],
      ['ETIMEDOUT', this.handleTimeout.bind(this)],
      ['ENOMEM', this.handleOutOfMemory.bind(this)],
      ['ENOSPC', this.handleDiskSpace.bind(this)],
      ['database_locked', this.handleDatabaseLocked.bind(this)],
      ['share_validation_failed', this.handleShareValidationError.bind(this)],
      ['payment_failed', this.handlePaymentError.bind(this)],
      ['rpc_error', this.handleRPCError.bind(this)]
    ]);
    
    // Merge custom strategies
    Object.entries(this.config.recoveryStrategies).forEach(([key, strategy]) => {
      this.strategies.set(key, strategy);
    });
  }
  
  /**
   * Handle error with recovery
   */
  async handleError(error, context = {}) {
    const errorKey = this.getErrorKey(error);
    const errorInfo = {
      error,
      context,
      timestamp: Date.now(),
      attempts: 0
    };
    
    // Track error
    this.trackError(errorKey, errorInfo);
    
    // Check if error threshold exceeded
    if (this.isErrorThresholdExceeded(errorKey)) {
      logger.error(`Error threshold exceeded for ${errorKey}`);
      this.emit('error:critical', { errorKey, count: this.getErrorCount(errorKey) });
      return { success: false, reason: 'threshold_exceeded' };
    }
    
    // Attempt recovery
    return await this.attemptRecovery(errorKey, errorInfo);
  }
  
  /**
   * Get error key for categorization
   */
  getErrorKey(error) {
    if (error.code) return error.code;
    if (error.type) return error.type;
    if (error.message) {
      // Extract patterns
      if (error.message.includes('ECONNREFUSED')) return 'ECONNREFUSED';
      if (error.message.includes('ETIMEDOUT')) return 'ETIMEDOUT';
      if (error.message.includes('database is locked')) return 'database_locked';
      if (error.message.includes('out of memory')) return 'ENOMEM';
      if (error.message.includes('no space')) return 'ENOSPC';
      if (error.message.includes('share')) return 'share_validation_failed';
      if (error.message.includes('payment')) return 'payment_failed';
      if (error.message.includes('RPC')) return 'rpc_error';
    }
    return 'unknown_error';
  }
  
  /**
   * Track error occurrence
   */
  trackError(errorKey, errorInfo) {
    if (!this.errors.has(errorKey)) {
      this.errors.set(errorKey, []);
    }
    
    const errors = this.errors.get(errorKey);
    errors.push(errorInfo);
    
    // Clean old errors
    const cutoff = Date.now() - this.config.errorWindow;
    this.errors.set(errorKey, errors.filter(e => e.timestamp > cutoff));
    
    // Analyze patterns
    this.analyzeErrorPattern(errorKey);
  }
  
  /**
   * Analyze error patterns
   */
  analyzeErrorPattern(errorKey) {
    const errors = this.errors.get(errorKey) || [];
    if (errors.length < 3) return;
    
    // Calculate error rate
    const timeSpan = errors[errors.length - 1].timestamp - errors[0].timestamp;
    const errorRate = errors.length / (timeSpan / 1000); // Errors per second
    
    // Detect patterns
    const pattern = {
      key: errorKey,
      count: errors.length,
      rate: errorRate,
      firstSeen: errors[0].timestamp,
      lastSeen: errors[errors.length - 1].timestamp
    };
    
    this.errorPatterns.set(errorKey, pattern);
    
    // Emit pattern detected
    if (errorRate > 1) {
      this.emit('error:pattern', pattern);
    }
  }
  
  /**
   * Check if error threshold exceeded
   */
  isErrorThresholdExceeded(errorKey) {
    const errors = this.errors.get(errorKey) || [];
    return errors.length >= this.config.errorThreshold;
  }
  
  /**
   * Get error count
   */
  getErrorCount(errorKey) {
    return (this.errors.get(errorKey) || []).length;
  }
  
  /**
   * Attempt recovery
   */
  async attemptRecovery(errorKey, errorInfo) {
    const strategy = this.strategies.get(errorKey) || this.defaultRecoveryStrategy.bind(this);
    
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      errorInfo.attempts = attempt;
      
      try {
        logger.info(`Attempting recovery for ${errorKey} (attempt ${attempt}/${this.config.maxRetries})`);
        
        const result = await strategy(errorInfo);
        
        if (result.success) {
          this.recoveryStats.successful++;
          logger.info(`Recovery successful for ${errorKey}`);
          this.emit('recovery:success', { errorKey, attempts: attempt });
          return result;
        }
        
      } catch (recoveryError) {
        logger.error(`Recovery attempt ${attempt} failed:`, recoveryError);
      }
      
      // Wait before retry
      if (attempt < this.config.maxRetries) {
        const delay = this.calculateRetryDelay(attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    this.recoveryStats.failed++;
    logger.error(`Recovery failed for ${errorKey} after ${this.config.maxRetries} attempts`);
    this.emit('recovery:failed', { errorKey, errorInfo });
    
    return { success: false, reason: 'max_retries_exceeded' };
  }
  
  /**
   * Calculate retry delay with exponential backoff
   */
  calculateRetryDelay(attempt) {
    if (!this.config.exponentialBackoff) {
      return this.config.retryDelay;
    }
    
    return Math.min(
      this.config.retryDelay * Math.pow(2, attempt - 1),
      60000 // Max 1 minute
    );
  }
  
  /**
   * Default recovery strategy
   */
  async defaultRecoveryStrategy(errorInfo) {
    logger.warn(`No specific recovery strategy for error, attempting generic recovery`);
    
    // Generic recovery actions
    if (errorInfo.context.restart) {
      await errorInfo.context.restart();
    }
    
    return { success: false, reason: 'no_strategy' };
  }
  
  /**
   * Handle connection refused errors
   */
  async handleConnectionRefused(errorInfo) {
    const { context } = errorInfo;
    
    // Check if service is running
    if (context.service) {
      logger.info(`Checking if ${context.service} is running...`);
      
      // Try to start service
      if (context.startService) {
        await context.startService();
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for startup
        return { success: true, action: 'service_started' };
      }
    }
    
    return { success: false, reason: 'service_unavailable' };
  }
  
  /**
   * Handle timeout errors
   */
  async handleTimeout(errorInfo) {
    const { context } = errorInfo;
    
    // Increase timeout
    if (context.increaseTimeout) {
      const newTimeout = context.timeout * 2;
      logger.info(`Increasing timeout to ${newTimeout}ms`);
      context.increaseTimeout(newTimeout);
      return { success: true, action: 'timeout_increased' };
    }
    
    return { success: false, reason: 'persistent_timeout' };
  }
  
  /**
   * Handle out of memory errors
   */
  async handleOutOfMemory(errorInfo) {
    logger.warn('Out of memory detected, attempting recovery...');
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      logger.info('Forced garbage collection');
    }
    
    // Clear caches
    if (errorInfo.context.clearCaches) {
      await errorInfo.context.clearCaches();
      logger.info('Cleared caches');
    }
    
    // Reduce memory usage
    if (errorInfo.context.reduceMemoryUsage) {
      await errorInfo.context.reduceMemoryUsage();
      return { success: true, action: 'memory_reduced' };
    }
    
    return { success: false, reason: 'memory_critical' };
  }
  
  /**
   * Handle disk space errors
   */
  async handleDiskSpace(errorInfo) {
    logger.error('Disk space error detected');
    
    // Clean temporary files
    if (errorInfo.context.cleanTempFiles) {
      await errorInfo.context.cleanTempFiles();
      logger.info('Cleaned temporary files');
    }
    
    // Rotate logs
    if (errorInfo.context.rotateLogs) {
      await errorInfo.context.rotateLogs();
      logger.info('Rotated logs');
    }
    
    // Clean old data
    if (errorInfo.context.cleanOldData) {
      await errorInfo.context.cleanOldData();
      return { success: true, action: 'disk_space_freed' };
    }
    
    this.emit('error:critical', { type: 'disk_space', errorInfo });
    return { success: false, reason: 'disk_full' };
  }
  
  /**
   * Handle database locked errors
   */
  async handleDatabaseLocked(errorInfo) {
    logger.info('Database locked, waiting...');
    
    // Wait and retry
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Check if still locked
    if (errorInfo.context.checkDatabase) {
      const isLocked = await errorInfo.context.checkDatabase();
      if (!isLocked) {
        return { success: true, action: 'database_unlocked' };
      }
    }
    
    // Force unlock if possible
    if (errorInfo.context.unlockDatabase) {
      await errorInfo.context.unlockDatabase();
      return { success: true, action: 'database_force_unlocked' };
    }
    
    return { success: false, reason: 'database_locked' };
  }
  
  /**
   * Handle share validation errors
   */
  async handleShareValidationError(errorInfo) {
    const { context } = errorInfo;
    
    // Restart validation workers
    if (context.restartValidators) {
      await context.restartValidators();
      return { success: true, action: 'validators_restarted' };
    }
    
    // Reduce validation load
    if (context.reduceValidationLoad) {
      await context.reduceValidationLoad();
      return { success: true, action: 'validation_load_reduced' };
    }
    
    return { success: false, reason: 'validation_failure' };
  }
  
  /**
   * Handle payment errors
   */
  async handlePaymentError(errorInfo) {
    const { context, error } = errorInfo;
    
    // Check blockchain connection
    if (context.checkBlockchain) {
      const isConnected = await context.checkBlockchain();
      if (!isConnected) {
        logger.error('Blockchain not connected');
        
        if (context.reconnectBlockchain) {
          await context.reconnectBlockchain();
          return { success: true, action: 'blockchain_reconnected' };
        }
      }
    }
    
    // Check wallet balance
    if (error.message.includes('insufficient funds')) {
      this.emit('error:critical', { type: 'insufficient_funds', errorInfo });
      return { success: false, reason: 'insufficient_funds' };
    }
    
    // Retry with lower fee
    if (context.retryWithLowerFee) {
      await context.retryWithLowerFee();
      return { success: true, action: 'retried_lower_fee' };
    }
    
    return { success: false, reason: 'payment_failed' };
  }
  
  /**
   * Handle RPC errors
   */
  async handleRPCError(errorInfo) {
    const { context } = errorInfo;
    
    // Reconnect RPC
    if (context.reconnectRPC) {
      await context.reconnectRPC();
      return { success: true, action: 'rpc_reconnected' };
    }
    
    // Switch to backup node
    if (context.switchToBackupNode) {
      await context.switchToBackupNode();
      return { success: true, action: 'switched_to_backup' };
    }
    
    return { success: false, reason: 'rpc_unavailable' };
  }
  
  /**
   * Get recovery statistics
   */
  getStats() {
    const stats = {
      ...this.recoveryStats,
      successRate: this.recoveryStats.total > 0 ? 
        (this.recoveryStats.successful / this.recoveryStats.total * 100).toFixed(2) + '%' : '0%',
      currentErrors: {},
      patterns: []
    };
    
    // Current error counts
    this.errors.forEach((errors, key) => {
      stats.currentErrors[key] = errors.length;
    });
    
    // Error patterns
    this.errorPatterns.forEach(pattern => {
      stats.patterns.push(pattern);
    });
    
    return stats;
  }
  
  /**
   * Clear error history
   */
  clearHistory() {
    this.errors.clear();
    this.errorPatterns.clear();
    logger.info('Error history cleared');
  }
}

export default ErrorRecoveryManager;
