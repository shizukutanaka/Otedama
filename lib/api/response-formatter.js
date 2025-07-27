/**
 * API Response Formatter - Otedama
 * Consistent API response formatting with improved structure
 * 
 * Design principles:
 * - Consistent response structure
 * - Clear error messages
 * - Helpful metadata
 * - Type safety
 */

import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('ResponseFormatter');

/**
 * Standard API response structure
 */
export class ApiResponse {
  constructor(data = null, meta = {}) {
    this.success = true;
    this.data = data;
    this.meta = {
      timestamp: new Date().toISOString(),
      version: '1.0',
      ...meta
    };
    this.errors = null;
  }
  
  static success(data, meta = {}) {
    return new ApiResponse(data, meta);
  }
  
  static error(errors, meta = {}) {
    const response = new ApiResponse(null, meta);
    response.success = false;
    response.errors = Array.isArray(errors) ? errors : [errors];
    return response;
  }
  
  static paginated(data, pagination) {
    return new ApiResponse(data, {
      pagination: {
        page: pagination.page,
        pageSize: pagination.pageSize,
        totalItems: pagination.totalItems,
        totalPages: Math.ceil(pagination.totalItems / pagination.pageSize),
        hasNext: pagination.page < Math.ceil(pagination.totalItems / pagination.pageSize),
        hasPrevious: pagination.page > 1
      }
    });
  }
}

/**
 * Error response structure
 */
export class ApiError {
  constructor(code, message, field = null, details = null) {
    this.code = code;
    this.message = message;
    this.field = field;
    this.details = details;
  }
  
  static validation(field, message, details = null) {
    return new ApiError('VALIDATION_ERROR', message, field, details);
  }
  
  static notFound(resource, id = null) {
    return new ApiError(
      'NOT_FOUND',
      `${resource} not found${id ? ` with id: ${id}` : ''}`,
      null,
      { resource, id }
    );
  }
  
  static unauthorized(message = 'Unauthorized access') {
    return new ApiError('UNAUTHORIZED', message);
  }
  
  static forbidden(message = 'Access forbidden') {
    return new ApiError('FORBIDDEN', message);
  }
  
  static rateLimit(limit, window, retry) {
    return new ApiError(
      'RATE_LIMIT_EXCEEDED',
      `Rate limit exceeded. Limit: ${limit} requests per ${window}`,
      null,
      { limit, window, retryAfter: retry }
    );
  }
  
  static internal(message = 'Internal server error', details = null) {
    return new ApiError('INTERNAL_ERROR', message, null, details);
  }
}

/**
 * Response formatter middleware
 */
export class ResponseFormatter {
  /**
   * Format mining pool statistics
   */
  static formatPoolStats(stats) {
    return ApiResponse.success({
      pool: {
        hashrate: {
          current: stats.hashrate,
          average24h: stats.avgHashrate24h,
          unit: 'H/s'
        },
        miners: {
          active: stats.activeMiners,
          total: stats.totalMiners,
          workers: stats.totalWorkers
        },
        shares: {
          valid: stats.validShares,
          invalid: stats.invalidShares,
          efficiency: ((stats.validShares / (stats.validShares + stats.invalidShares)) * 100).toFixed(2) + '%'
        },
        blocks: {
          found: stats.blocksFound,
          pending: stats.blocksPending,
          confirmed: stats.blocksConfirmed,
          orphaned: stats.blocksOrphaned
        },
        payments: {
          total: stats.totalPayments,
          pending: stats.pendingPayments,
          lastPayout: stats.lastPayoutTime
        }
      },
      network: {
        difficulty: stats.networkDifficulty,
        blockHeight: stats.blockHeight,
        blockReward: stats.blockReward,
        nextDifficultyAdjustment: stats.nextDifficultyAdjustment
      }
    }, {
      cached: stats.cached || false,
      cacheExpiry: stats.cacheExpiry || null
    });
  }
  
  /**
   * Format miner statistics
   */
  static formatMinerStats(miner, detailed = false) {
    const base = {
      address: miner.address,
      hashrate: {
        current: miner.hashrate,
        average: miner.avgHashrate,
        reported: miner.reportedHashrate
      },
      shares: {
        valid: miner.validShares,
        invalid: miner.invalidShares,
        stale: miner.staleShares,
        efficiency: ((miner.validShares / (miner.validShares + miner.invalidShares)) * 100).toFixed(2) + '%'
      },
      balance: {
        confirmed: miner.confirmedBalance,
        pending: miner.pendingBalance,
        paid: miner.totalPaid
      },
      lastSeen: miner.lastShareTime,
      status: miner.isActive ? 'active' : 'inactive'
    };
    
    if (detailed) {
      base.workers = miner.workers.map(worker => ({
        name: worker.name,
        hashrate: worker.hashrate,
        shares: {
          valid: worker.validShares,
          invalid: worker.invalidShares
        },
        lastSeen: worker.lastShareTime,
        status: worker.isActive ? 'active' : 'inactive'
      }));
      
      base.payments = miner.payments.map(payment => ({
        id: payment.id,
        amount: payment.amount,
        txHash: payment.txHash,
        timestamp: payment.timestamp,
        status: payment.status
      }));
      
      base.performance = {
        last24h: miner.performance24h,
        last7d: miner.performance7d,
        last30d: miner.performance30d
      };
    }
    
    return ApiResponse.success(base);
  }
  
  /**
   * Format block information
   */
  static formatBlock(block) {
    return {
      height: block.height,
      hash: block.hash,
      timestamp: block.timestamp,
      difficulty: block.difficulty,
      reward: {
        base: block.reward,
        fees: block.fees,
        total: block.reward + block.fees
      },
      miner: block.miner,
      confirmations: block.confirmations,
      status: block.status,
      shares: block.shares,
      effort: block.effort ? block.effort.toFixed(2) + '%' : null
    };
  }
  
  /**
   * Format share submission response
   */
  static formatShareResponse(result) {
    if (result.accepted) {
      return ApiResponse.success({
        accepted: true,
        difficulty: result.difficulty,
        share: {
          id: result.shareId,
          jobId: result.jobId,
          nonce: result.nonce,
          hash: result.hash
        }
      }, {
        worker: result.worker,
        timestamp: new Date().toISOString()
      });
    } else {
      return ApiResponse.error(
        ApiError.validation('share', result.reason || 'Share rejected', {
          difficulty: result.difficulty,
          jobId: result.jobId
        })
      );
    }
  }
  
  /**
   * Format payment information
   */
  static formatPayment(payment) {
    return {
      id: payment.id,
      address: payment.address,
      amount: payment.amount,
      fee: payment.fee,
      netAmount: payment.amount - payment.fee,
      currency: payment.currency || 'BTC',
      txHash: payment.txHash,
      confirmations: payment.confirmations,
      timestamp: payment.timestamp,
      status: payment.status,
      type: payment.type || 'automatic'
    };
  }
  
  /**
   * Format health check response
   */
  static formatHealthCheck(health) {
    return ApiResponse.success({
      status: health.isHealthy ? 'healthy' : 'unhealthy',
      uptime: health.uptime,
      version: health.version,
      services: Object.entries(health.services).map(([name, service]) => ({
        name,
        status: service.healthy ? 'healthy' : 'unhealthy',
        message: service.message,
        lastCheck: service.lastCheck,
        responseTime: service.responseTime
      })),
      metrics: {
        cpu: health.metrics.cpu,
        memory: health.metrics.memory,
        disk: health.metrics.disk,
        connections: health.metrics.connections
      }
    }, {
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'production'
    });
  }
  
  /**
   * Express middleware for consistent responses
   */
  static middleware() {
    return (req, res, next) => {
      // Success response helper
      res.success = (data, meta = {}) => {
        const response = ApiResponse.success(data, meta);
        res.json(response);
      };
      
      // Error response helper
      res.error = (errors, status = 400) => {
        const response = ApiResponse.error(errors);
        res.status(status).json(response);
      };
      
      // Paginated response helper
      res.paginated = (data, pagination) => {
        const response = ApiResponse.paginated(data, pagination);
        res.json(response);
      };
      
      // Common error responses
      res.notFound = (resource, id) => {
        res.error(ApiError.notFound(resource, id), 404);
      };
      
      res.unauthorized = (message) => {
        res.error(ApiError.unauthorized(message), 401);
      };
      
      res.forbidden = (message) => {
        res.error(ApiError.forbidden(message), 403);
      };
      
      res.validationError = (errors) => {
        const apiErrors = errors.map(err => 
          ApiError.validation(err.field, err.message, err.details)
        );
        res.error(apiErrors, 422);
      };
      
      res.rateLimit = (limit, window, retryAfter) => {
        res.error(ApiError.rateLimit(limit, window, retryAfter), 429);
      };
      
      res.serverError = (message, details) => {
        logger.error('Server error:', { message, details });
        res.error(ApiError.internal(message, details), 500);
      };
      
      next();
    };
  }
}

/**
 * WebSocket response formatter
 */
export class WebSocketFormatter {
  /**
   * Format WebSocket message
   */
  static message(type, data, id = null) {
    return JSON.stringify({
      id: id || Date.now().toString(),
      type,
      data,
      timestamp: new Date().toISOString()
    });
  }
  
  /**
   * Format mining job
   */
  static miningJob(job) {
    return this.message('mining.job', {
      jobId: job.id,
      prevHash: job.prevHash,
      coinbase1: job.coinbase1,
      coinbase2: job.coinbase2,
      merkleBranch: job.merkleBranch,
      version: job.version,
      nBits: job.nBits,
      nTime: job.nTime,
      cleanJobs: job.cleanJobs,
      target: job.target,
      height: job.height
    });
  }
  
  /**
   * Format difficulty update
   */
  static difficultyUpdate(difficulty) {
    return this.message('mining.set_difficulty', {
      difficulty,
      target: this.difficultyToTarget(difficulty)
    });
  }
  
  /**
   * Format share result
   */
  static shareResult(shareId, accepted, reason = null) {
    return this.message('mining.submit', {
      id: shareId,
      result: accepted,
      error: accepted ? null : [20, reason || 'Share rejected', null]
    }, shareId);
  }
  
  /**
   * Convert difficulty to target
   */
  static difficultyToTarget(difficulty) {
    // Simplified target calculation
    const max = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
    const target = max / BigInt(Math.floor(difficulty));
    return '0x' + target.toString(16).padStart(64, '0');
  }
}

/**
 * Data transformers
 */
export const transformers = {
  /**
   * Transform hashrate to human readable format
   */
  hashrate(value) {
    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];
    let unitIndex = 0;
    let rate = value;
    
    while (rate >= 1000 && unitIndex < units.length - 1) {
      rate /= 1000;
      unitIndex++;
    }
    
    return {
      value: rate,
      unit: units[unitIndex],
      formatted: `${rate.toFixed(2)} ${units[unitIndex]}`
    };
  },
  
  /**
   * Transform timestamp to various formats
   */
  timestamp(value) {
    const date = new Date(value);
    return {
      iso: date.toISOString(),
      unix: Math.floor(date.getTime() / 1000),
      relative: this.relativeTime(date),
      formatted: date.toLocaleString()
    };
  },
  
  /**
   * Get relative time string
   */
  relativeTime(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    
    const intervals = {
      year: 31536000,
      month: 2592000,
      week: 604800,
      day: 86400,
      hour: 3600,
      minute: 60
    };
    
    for (const [unit, secondsInUnit] of Object.entries(intervals)) {
      const interval = Math.floor(seconds / secondsInUnit);
      if (interval >= 1) {
        return `${interval} ${unit}${interval > 1 ? 's' : ''} ago`;
      }
    }
    
    return 'just now';
  },
  
  /**
   * Transform currency amount
   */
  currency(amount, decimals = 8) {
    return {
      value: amount,
      formatted: amount.toFixed(decimals),
      btc: amount,
      satoshi: Math.floor(amount * 100000000)
    };
  }
};

export default ResponseFormatter;