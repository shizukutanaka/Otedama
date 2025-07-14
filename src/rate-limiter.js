import { EventEmitter } from 'events';
import { Logger } from './logger.js';

/**
 * Rate Limiter
 * API、接続、トランザクションのレート制限
 * 
 * Features:
 * - Sliding window rate limiting
 * - Token bucket algorithm
 * - IP-based limiting
 * - User-based limiting
 * - Adaptive rate limiting
 * - DDoS protection
 */
export class RateLimiter extends EventEmitter {
  constructor(config = {}) {
    super();
    this.logger = new Logger('RateLimiter');
    
    // Default configuration
    this.config = {
      // API rate limits
      api: {
        windowMs: 60000, // 1 minute
        maxRequests: 1000,
        keyGenerator: (req) => req.ip || 'anonymous',
        skipSuccessfulRequests: false,
        skipFailedRequests: false
      },
      
      // Stratum connection limits
      stratum: {
        windowMs: 60000,
        maxConnections: 100,
        maxConnectionsPerIP: 10,
        banDuration: 3600000 // 1 hour
      },
      
      // DEX transaction limits
      dex: {
        windowMs: 60000,
        maxTransactions: 100,
        maxVolumePerWindow: BigInt(1000000000000), // 10000 tokens
        cooldownAfterLimit: 300000 // 5 minutes
      },
      
      // Mining share limits
      mining: {
        windowMs: 60000,
        maxSharesPerMiner: 10000,
        maxInvalidShares: 100,
        invalidShareBanThreshold: 0.5
      },
      
      // Payment limits
      payment: {
        windowMs: 3600000, // 1 hour
        maxPayoutsPerAddress: 10,
        minPayoutInterval: 3600000 // 1 hour
      },
      
      // Global limits
      global: {
        enableDDoSProtection: true,
        maxRequestsPerSecond: 1000,
        burstAllowance: 100,
        blockDuration: 3600000 // 1 hour
      },
      
      ...config
    };
    
    // Rate limit stores
    this.stores = {
      api: new Map(),
      stratum: new Map(),
      dex: new Map(),
      mining: new Map(),
      payment: new Map(),
      blocked: new Map()
    };
    
    // Token buckets for burst protection
    this.tokenBuckets = new Map();
    
    // Statistics
    this.stats = {
      limited: 0,
      passed: 0,
      blocked: 0,
      violations: new Map()
    };
    
    // Cleanup timers
    this.setupCleanupTimers();
    
    this.logger.info('Rate limiter initialized');
  }

  /**
   * Check API rate limit
   */
  checkAPILimit(req) {
    const key = this.config.api.keyGenerator(req);
    
    // Check if blocked
    if (this.isBlocked(key)) {
      return { allowed: false, reason: 'blocked' };
    }
    
    const now = Date.now();
    const window = this.config.api.windowMs;
    const limit = this.config.api.maxRequests;
    
    // Get or create rate limit entry
    if (!this.stores.api.has(key)) {
      this.stores.api.set(key, {
        requests: [],
        violations: 0
      });
    }
    
    const entry = this.stores.api.get(key);
    
    // Remove old requests outside window
    entry.requests = entry.requests.filter(timestamp => 
      now - timestamp < window
    );
    
    // Check limit
    if (entry.requests.length >= limit) {
      this.recordViolation('api', key);
      this.stats.limited++;
      
      return {
        allowed: false,
        reason: 'rate_limit',
        retryAfter: Math.ceil((entry.requests[0] + window - now) / 1000),
        limit,
        remaining: 0,
        reset: new Date(entry.requests[0] + window)
      };
    }
    
    // Add current request
    entry.requests.push(now);
    this.stats.passed++;
    
    return {
      allowed: true,
      limit,
      remaining: limit - entry.requests.length,
      reset: new Date(now + window)
    };
  }

  /**
   * Check stratum connection limit
   */
  checkStratumConnection(ip) {
    // Check if blocked
    if (this.isBlocked(ip)) {
      return { allowed: false, reason: 'blocked' };
    }
    
    const now = Date.now();
    const window = this.config.stratum.windowMs;
    const limit = this.config.stratum.maxConnectionsPerIP;
    
    // Get or create connection entry
    if (!this.stores.stratum.has(ip)) {
      this.stores.stratum.set(ip, {
        connections: [],
        activeConnections: 0,
        violations: 0
      });
    }
    
    const entry = this.stores.stratum.get(ip);
    
    // Remove old connections
    entry.connections = entry.connections.filter(timestamp => 
      now - timestamp < window
    );
    
    // Check limit
    if (entry.connections.length >= limit || entry.activeConnections >= limit) {
      this.recordViolation('stratum', ip);
      
      // Check for ban
      if (entry.violations >= 5) {
        this.blockIP(ip, this.config.stratum.banDuration);
      }
      
      return {
        allowed: false,
        reason: 'connection_limit',
        activeConnections: entry.activeConnections,
        limit
      };
    }
    
    // Add connection
    entry.connections.push(now);
    entry.activeConnections++;
    
    return {
      allowed: true,
      activeConnections: entry.activeConnections,
      limit
    };
  }

  /**
   * Release stratum connection
   */
  releaseStratumConnection(ip) {
    const entry = this.stores.stratum.get(ip);
    if (entry && entry.activeConnections > 0) {
      entry.activeConnections--;
    }
  }

  /**
   * Check DEX transaction limit
   */
  checkDEXTransaction(address, amount) {
    // Check if blocked
    if (this.isBlocked(address)) {
      return { allowed: false, reason: 'blocked' };
    }
    
    const now = Date.now();
    const window = this.config.dex.windowMs;
    const txLimit = this.config.dex.maxTransactions;
    const volumeLimit = this.config.dex.maxVolumePerWindow;
    
    // Get or create DEX entry
    if (!this.stores.dex.has(address)) {
      this.stores.dex.set(address, {
        transactions: [],
        volume: BigInt(0),
        lastReset: now,
        cooldown: 0
      });
    }
    
    const entry = this.stores.dex.get(address);
    
    // Check cooldown
    if (entry.cooldown > now) {
      return {
        allowed: false,
        reason: 'cooldown',
        cooldownRemaining: Math.ceil((entry.cooldown - now) / 1000)
      };
    }
    
    // Reset volume if window passed
    if (now - entry.lastReset > window) {
      entry.volume = BigInt(0);
      entry.transactions = [];
      entry.lastReset = now;
    }
    
    // Remove old transactions
    entry.transactions = entry.transactions.filter(tx => 
      now - tx.timestamp < window
    );
    
    // Check transaction limit
    if (entry.transactions.length >= txLimit) {
      entry.cooldown = now + this.config.dex.cooldownAfterLimit;
      this.recordViolation('dex', address);
      
      return {
        allowed: false,
        reason: 'transaction_limit',
        limit: txLimit,
        cooldown: this.config.dex.cooldownAfterLimit
      };
    }
    
    // Check volume limit
    const newVolume = entry.volume + BigInt(amount);
    if (newVolume > volumeLimit) {
      this.recordViolation('dex', address);
      
      return {
        allowed: false,
        reason: 'volume_limit',
        currentVolume: entry.volume.toString(),
        limit: volumeLimit.toString()
      };
    }
    
    // Add transaction
    entry.transactions.push({ timestamp: now, amount });
    entry.volume = newVolume;
    
    return {
      allowed: true,
      transactionsRemaining: txLimit - entry.transactions.length,
      volumeRemaining: (volumeLimit - entry.volume).toString()
    };
  }

  /**
   * Check mining share limit
   */
  checkMiningShare(minerId, isValid) {
    const now = Date.now();
    const window = this.config.mining.windowMs;
    const shareLimit = this.config.mining.maxSharesPerMiner;
    const invalidLimit = this.config.mining.maxInvalidShares;
    
    // Get or create mining entry
    if (!this.stores.mining.has(minerId)) {
      this.stores.mining.set(minerId, {
        shares: [],
        invalidShares: [],
        totalShares: 0,
        totalInvalid: 0
      });
    }
    
    const entry = this.stores.mining.get(minerId);
    
    // Remove old shares
    entry.shares = entry.shares.filter(timestamp => 
      now - timestamp < window
    );
    entry.invalidShares = entry.invalidShares.filter(timestamp => 
      now - timestamp < window
    );
    
    // Check share limit
    if (entry.shares.length >= shareLimit) {
      this.recordViolation('mining', minerId);
      
      return {
        allowed: false,
        reason: 'share_limit',
        limit: shareLimit
      };
    }
    
    // Check invalid share limit
    if (!isValid) {
      if (entry.invalidShares.length >= invalidLimit) {
        this.recordViolation('mining', minerId);
        
        // Check ban threshold
        const invalidRate = entry.invalidShares.length / Math.max(entry.shares.length, 1);
        if (invalidRate > this.config.mining.invalidShareBanThreshold) {
          this.blockIP(minerId, this.config.global.blockDuration);
          
          return {
            allowed: false,
            reason: 'invalid_share_ban',
            invalidRate
          };
        }
        
        return {
          allowed: false,
          reason: 'invalid_share_limit',
          limit: invalidLimit
        };
      }
      
      entry.invalidShares.push(now);
      entry.totalInvalid++;
    }
    
    // Add share
    entry.shares.push(now);
    entry.totalShares++;
    
    return {
      allowed: true,
      sharesSubmitted: entry.shares.length,
      invalidShares: entry.invalidShares.length
    };
  }

  /**
   * Check payment limit
   */
  checkPaymentLimit(address) {
    const now = Date.now();
    const window = this.config.payment.windowMs;
    const limit = this.config.payment.maxPayoutsPerAddress;
    const minInterval = this.config.payment.minPayoutInterval;
    
    // Get or create payment entry
    if (!this.stores.payment.has(address)) {
      this.stores.payment.set(address, {
        payouts: [],
        lastPayout: 0
      });
    }
    
    const entry = this.stores.payment.get(address);
    
    // Check minimum interval
    if (entry.lastPayout && now - entry.lastPayout < minInterval) {
      return {
        allowed: false,
        reason: 'payout_interval',
        nextPayout: new Date(entry.lastPayout + minInterval)
      };
    }
    
    // Remove old payouts
    entry.payouts = entry.payouts.filter(timestamp => 
      now - timestamp < window
    );
    
    // Check payout limit
    if (entry.payouts.length >= limit) {
      return {
        allowed: false,
        reason: 'payout_limit',
        limit,
        reset: new Date(entry.payouts[0] + window)
      };
    }
    
    // Record payout
    entry.payouts.push(now);
    entry.lastPayout = now;
    
    return {
      allowed: true,
      payoutsRemaining: limit - entry.payouts.length
    };
  }

  /**
   * Check global rate limit (DDoS protection)
   */
  checkGlobalLimit(key = 'global') {
    if (!this.config.global.enableDDoSProtection) {
      return { allowed: true };
    }
    
    const now = Date.now();
    const maxRPS = this.config.global.maxRequestsPerSecond;
    const burst = this.config.global.burstAllowance;
    
    // Get or create token bucket
    if (!this.tokenBuckets.has(key)) {
      this.tokenBuckets.set(key, {
        tokens: burst,
        lastRefill: now
      });
    }
    
    const bucket = this.tokenBuckets.get(key);
    
    // Refill tokens
    const timePassed = now - bucket.lastRefill;
    const tokensToAdd = (timePassed / 1000) * maxRPS;
    bucket.tokens = Math.min(burst, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
    
    // Check if tokens available
    if (bucket.tokens < 1) {
      this.stats.limited++;
      
      return {
        allowed: false,
        reason: 'global_limit',
        retryAfter: Math.ceil((1 - bucket.tokens) / maxRPS * 1000)
      };
    }
    
    // Consume token
    bucket.tokens--;
    
    return { allowed: true };
  }

  /**
   * Block an IP or address
   */
  blockIP(identifier, duration = null) {
    const blockDuration = duration || this.config.global.blockDuration;
    const unblockTime = Date.now() + blockDuration;
    
    this.stores.blocked.set(identifier, {
      blockedAt: Date.now(),
      unblockAt: unblockTime,
      reason: 'rate_limit_violation'
    });
    
    this.stats.blocked++;
    this.logger.warn(`Blocked ${identifier} until ${new Date(unblockTime)}`);
    
    this.emit('blocked', {
      identifier,
      duration: blockDuration,
      unblockAt: unblockTime
    });
  }

  /**
   * Check if identifier is blocked
   */
  isBlocked(identifier) {
    const blockInfo = this.stores.blocked.get(identifier);
    
    if (!blockInfo) return false;
    
    if (Date.now() > blockInfo.unblockAt) {
      this.stores.blocked.delete(identifier);
      return false;
    }
    
    return true;
  }

  /**
   * Unblock an identifier
   */
  unblock(identifier) {
    if (this.stores.blocked.has(identifier)) {
      this.stores.blocked.delete(identifier);
      this.logger.info(`Unblocked ${identifier}`);
      this.emit('unblocked', { identifier });
    }
  }

  /**
   * Record a violation
   */
  recordViolation(type, identifier) {
    const key = `${type}:${identifier}`;
    const violations = this.stats.violations.get(key) || 0;
    this.stats.violations.set(key, violations + 1);
    
    // Check for repeat offenders
    if (violations + 1 >= 10) {
      this.blockIP(identifier, this.config.global.blockDuration * 2); // Double ban time
    }
  }

  /**
   * Setup cleanup timers
   */
  setupCleanupTimers() {
    // Clean up old entries every 5 minutes
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 300000);
    
    // Clean up blocked list every hour
    this.blockCleanupTimer = setInterval(() => {
      this.cleanupBlocked();
    }, 3600000);
  }

  /**
   * Clean up old entries
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    // Clean each store
    for (const [storeName, store] of Object.entries(this.stores)) {
      if (storeName === 'blocked') continue;
      
      for (const [key, entry] of store) {
        let shouldDelete = false;
        
        // Check if entry is stale
        if (entry.requests && entry.requests.length === 0) {
          shouldDelete = true;
        } else if (entry.connections && entry.connections.length === 0 && entry.activeConnections === 0) {
          shouldDelete = true;
        } else if (entry.transactions && entry.transactions.length === 0) {
          shouldDelete = true;
        } else if (entry.shares && entry.shares.length === 0) {
          shouldDelete = true;
        } else if (entry.payouts && entry.payouts.length === 0) {
          shouldDelete = true;
        }
        
        if (shouldDelete) {
          store.delete(key);
          cleaned++;
        }
      }
    }
    
    if (cleaned > 0) {
      this.logger.debug(`Cleaned ${cleaned} stale rate limit entries`);
    }
  }

  /**
   * Clean up expired blocks
   */
  cleanupBlocked() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [identifier, blockInfo] of this.stores.blocked) {
      if (now > blockInfo.unblockAt) {
        this.stores.blocked.delete(identifier);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.logger.debug(`Removed ${cleaned} expired blocks`);
    }
  }

  /**
   * Get rate limiter statistics
   */
  getStats() {
    const totalViolations = Array.from(this.stats.violations.values())
      .reduce((sum, count) => sum + count, 0);
    
    return {
      passed: this.stats.passed,
      limited: this.stats.limited,
      blocked: this.stats.blocked,
      violations: totalViolations,
      currentlyBlocked: this.stores.blocked.size,
      stores: {
        api: this.stores.api.size,
        stratum: this.stores.stratum.size,
        dex: this.stores.dex.size,
        mining: this.stores.mining.size,
        payment: this.stores.payment.size
      }
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      limited: 0,
      passed: 0,
      blocked: 0,
      violations: new Map()
    };
  }

  /**
   * Stop rate limiter
   */
  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    if (this.blockCleanupTimer) {
      clearInterval(this.blockCleanupTimer);
    }
    
    this.logger.info('Rate limiter stopped');
  }
}
