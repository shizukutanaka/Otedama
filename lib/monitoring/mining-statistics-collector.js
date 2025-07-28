/**
 * Mining Statistics Collector for Otedama
 * Comprehensive statistics collection and analysis for mining operations
 * 
 * Design principles:
 * - Carmack: High-frequency data collection with minimal performance impact
 * - Martin: Clean separation of collection, aggregation, and reporting
 * - Pike: Simple but comprehensive statistics
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('MiningStatsCollector');

/**
 * Time window constants for statistics
 */
export const TimeWindow = {
  REALTIME: 'realtime',      // Last 5 minutes
  SHORT: 'short',            // Last hour
  MEDIUM: 'medium',          // Last 24 hours  
  LONG: 'long',              // Last 7 days
  HISTORICAL: 'historical'   // All time
};

/**
 * Mining performance metrics
 */
class MiningMetrics {
  constructor() {
    this.reset();
  }

  reset() {
    this.hashrate = 0;
    this.shares = {
      accepted: 0,
      rejected: 0,
      stale: 0,
      total: 0
    };
    this.difficulty = 0;
    this.blockHeight = 0;
    this.uptime = 0;
    this.efficiency = 0;
    this.powerConsumption = 0;
    this.temperature = 0;
    this.fanSpeed = 0;
    this.errors = 0;
    this.networkLatency = 0;
    this.timestamp = Date.now();
  }

  getAcceptanceRate() {
    return this.shares.total > 0 ? (this.shares.accepted / this.shares.total) * 100 : 0;
  }

  getStaleRate() {
    return this.shares.total > 0 ? (this.shares.stale / this.shares.total) * 100 : 0;
  }

  getEfficiency() {
    return this.powerConsumption > 0 ? this.hashrate / this.powerConsumption : 0;
  }
}

/**
 * Pool-wide statistics
 */
class PoolStatistics {
  constructor() {
    this.totalHashrate = 0;
    this.connectedMiners = 0;
    this.totalShares = 0;
    this.blocksFound = 0;
    this.lastBlockTime = 0;
    this.averageBlockTime = 600; // 10 minutes default
    this.networkDifficulty = 0;
    this.poolDifficulty = 0;
    this.luck = 100; // Percentage
    this.earnings = {
      total: 0,
      today: 0,
      pending: 0
    };
    this.timestamp = Date.now();
  }

  updateLuck(expectedShares, actualShares) {
    if (expectedShares > 0) {
      this.luck = (expectedShares / actualShares) * 100;
    }
  }
}

/**
 * Individual miner statistics
 */
class MinerStatistics {
  constructor(minerId) {
    this.minerId = minerId;
    this.isActive = false;
    this.connectedSince = Date.now();
    this.lastSeen = Date.now();
    this.hardware = {
      type: 'unknown', // cpu, gpu, asic
      model: 'unknown',
      cores: 0,
      memory: 0
    };
    this.performance = new MiningMetrics();
    this.historicalData = [];
    this.earnings = {
      total: 0,
      pending: 0,
      paid: 0
    };
  }

  updateActivity() {
    this.isActive = true;
    this.lastSeen = Date.now();
  }

  getUptimeSeconds() {
    return Math.floor((Date.now() - this.connectedSince) / 1000);
  }

  isOnline() {
    const timeout = 300000; // 5 minutes
    return Date.now() - this.lastSeen < timeout;
  }
}

/**
 * Statistics aggregator with time-based windows
 */
class StatisticsAggregator {
  constructor(windowSize = 3600000) { // 1 hour default
    this.windowSize = windowSize;
    this.dataPoints = [];
    this.maxDataPoints = Math.ceil(windowSize / 60000); // Store 1 minute intervals
  }

  addDataPoint(data) {
    const now = Date.now();
    this.dataPoints.push({
      timestamp: now,
      data: { ...data }
    });

    // Remove old data points
    const cutoff = now - this.windowSize;
    this.dataPoints = this.dataPoints.filter(point => point.timestamp > cutoff);
  }

  getAverage(field) {
    if (this.dataPoints.length === 0) return 0;
    
    const sum = this.dataPoints.reduce((acc, point) => {
      const value = this.getNestedValue(point.data, field);
      return acc + (value || 0);
    }, 0);
    
    return sum / this.dataPoints.length;
  }

  getSum(field) {
    return this.dataPoints.reduce((acc, point) => {
      const value = this.getNestedValue(point.data, field);
      return acc + (value || 0);
    }, 0);
  }

  getMax(field) {
    if (this.dataPoints.length === 0) return 0;
    
    return Math.max(...this.dataPoints.map(point => {
      const value = this.getNestedValue(point.data, field);
      return value || 0;
    }));
  }

  getMin(field) {
    if (this.dataPoints.length === 0) return 0;
    
    return Math.min(...this.dataPoints.map(point => {
      const value = this.getNestedValue(point.data, field);
      return value || 0;
    }));
  }

  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  getLatest() {
    return this.dataPoints.length > 0 ? this.dataPoints[this.dataPoints.length - 1].data : null;
  }

  getDataPointsCount() {
    return this.dataPoints.length;
  }
}

/**
 * Main mining statistics collector
 */
export class MiningStatisticsCollector extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.collectInterval = options.collectInterval || 60000; // 1 minute
    this.retentionPeriod = options.retentionPeriod || 7 * 24 * 60 * 60 * 1000; // 7 days
    this.enableDetailedLogging = options.enableDetailedLogging || false;
    
    // Storage
    this.miners = new Map();
    this.poolStats = new PoolStatistics();
    
    // Time-based aggregators
    this.aggregators = {
      [TimeWindow.REALTIME]: new StatisticsAggregator(5 * 60 * 1000), // 5 minutes
      [TimeWindow.SHORT]: new StatisticsAggregator(60 * 60 * 1000),   // 1 hour
      [TimeWindow.MEDIUM]: new StatisticsAggregator(24 * 60 * 60 * 1000), // 24 hours
      [TimeWindow.LONG]: new StatisticsAggregator(7 * 24 * 60 * 60 * 1000), // 7 days
    };
    
    // Collection state
    this.isCollecting = false;
    this.collectTimer = null;
    this.startTime = Date.now();
    
    // Performance counters
    this.collectionCount = 0;
    this.lastCollectionTime = 0;
    this.collectionErrors = 0;
  }

  /**
   * Start statistics collection
   */
  start() {
    if (this.isCollecting) return;
    
    this.isCollecting = true;
    this.startTime = Date.now();
    
    this.collectTimer = setInterval(() => {
      this.collectStatistics();
    }, this.collectInterval);
    
    // Initial collection
    setTimeout(() => this.collectStatistics(), 1000);
    
    logger.info('Mining statistics collector started', {
      collectInterval: this.collectInterval,
      retentionPeriod: this.retentionPeriod
    });
    
    this.emit('started');
  }

  /**
   * Stop statistics collection
   */
  stop() {
    if (!this.isCollecting) return;
    
    this.isCollecting = false;
    
    if (this.collectTimer) {
      clearInterval(this.collectTimer);
      this.collectTimer = null;
    }
    
    logger.info('Mining statistics collector stopped', {
      collectionsPerformed: this.collectionCount,
      errors: this.collectionErrors
    });
    
    this.emit('stopped');
  }

  /**
   * Register a new miner
   */
  registerMiner(minerId, minerInfo = {}) {
    const miner = new MinerStatistics(minerId);
    
    // Set hardware information if provided
    if (minerInfo.hardware) {
      Object.assign(miner.hardware, minerInfo.hardware);
    }
    
    this.miners.set(minerId, miner);
    
    logger.info('Miner registered', {
      minerId,
      hardware: miner.hardware
    });
    
    this.emit('minerRegistered', miner);
    return miner;
  }

  /**
   * Unregister a miner
   */
  unregisterMiner(minerId) {
    const miner = this.miners.get(minerId);
    if (miner) {
      this.miners.delete(minerId);
      
      logger.info('Miner unregistered', {
        minerId,
        uptime: miner.getUptimeSeconds(),
        totalShares: miner.performance.shares.total
      });
      
      this.emit('minerUnregistered', miner);
      return true;
    }
    return false;
  }

  /**
   * Update miner performance metrics
   */
  updateMinerMetrics(minerId, metrics) {
    const miner = this.miners.get(minerId);
    if (!miner) return false;
    
    miner.updateActivity();
    
    // Update performance metrics
    Object.assign(miner.performance, metrics);
    miner.performance.timestamp = Date.now();
    
    // Store historical data point
    miner.historicalData.push({
      timestamp: Date.now(),
      metrics: { ...metrics }
    });
    
    // Limit historical data to retention period
    const cutoff = Date.now() - this.retentionPeriod;
    miner.historicalData = miner.historicalData.filter(point => point.timestamp > cutoff);
    
    if (this.enableDetailedLogging) {
      logger.debug('Miner metrics updated', {
        minerId,
        hashrate: metrics.hashrate,
        shares: metrics.shares,
        efficiency: metrics.efficiency
      });
    }
    
    this.emit('minerMetricsUpdated', { minerId, metrics });
    return true;
  }

  /**
   * Update pool-wide statistics
   */
  updatePoolStats(stats) {
    Object.assign(this.poolStats, stats);
    this.poolStats.timestamp = Date.now();
    
    logger.debug('Pool statistics updated', {
      totalHashrate: stats.totalHashrate,
      connectedMiners: stats.connectedMiners,
      blocksFound: stats.blocksFound
    });
    
    this.emit('poolStatsUpdated', this.poolStats);
  }

  /**
   * Record a new share submission
   */
  recordShare(minerId, shareData) {
    const miner = this.miners.get(minerId);
    if (!miner) return false;
    
    miner.updateActivity();
    
    // Update share counts
    const shareType = shareData.accepted ? 'accepted' : 
                     shareData.stale ? 'stale' : 'rejected';
    
    miner.performance.shares[shareType]++;
    miner.performance.shares.total++;
    
    // Update pool totals
    this.poolStats.totalShares++;
    
    this.emit('shareRecorded', {
      minerId,
      shareType,
      difficulty: shareData.difficulty,
      timestamp: Date.now()
    });
    
    return true;
  }

  /**
   * Record a found block
   */
  recordBlock(minerId, blockData) {
    const miner = this.miners.get(minerId);
    if (miner) {
      miner.updateActivity();
    }
    
    this.poolStats.blocksFound++;
    this.poolStats.lastBlockTime = Date.now();
    
    // Update average block time
    if (this.poolStats.blocksFound > 1) {
      const timeSinceStart = Date.now() - this.startTime;
      this.poolStats.averageBlockTime = timeSinceStart / this.poolStats.blocksFound;
    }
    
    logger.info('Block found', {
      minerId,
      blockHeight: blockData.height,
      hash: blockData.hash,
      reward: blockData.reward
    });
    
    this.emit('blockFound', {
      minerId,
      blockData,
      timestamp: Date.now()
    });
  }

  /**
   * Collect and aggregate statistics
   */
  async collectStatistics() {
    const startTime = Date.now();
    
    try {
      // Collect pool-wide metrics
      const poolMetrics = this.calculatePoolMetrics();
      
      // Add to all time-based aggregators
      Object.values(this.aggregators).forEach(aggregator => {
        aggregator.addDataPoint(poolMetrics);
      });
      
      // Clean up inactive miners
      this.cleanupInactiveMiners();
      
      this.collectionCount++;
      this.lastCollectionTime = Date.now() - startTime;
      
      if (this.enableDetailedLogging) {
        logger.debug('Statistics collected', {
          poolHashrate: poolMetrics.totalHashrate,
          activeMiners: poolMetrics.activeMiners,
          collectionTime: this.lastCollectionTime
        });
      }
      
      this.emit('statisticsCollected', poolMetrics);
      
    } catch (error) {
      this.collectionErrors++;
      logger.error('Statistics collection failed', { error: error.message });
      this.emit('collectionError', error);
    }
  }

  /**
   * Calculate current pool metrics
   */
  calculatePoolMetrics() {
    const activeMiners = Array.from(this.miners.values()).filter(m => m.isOnline());
    
    const totalHashrate = activeMiners.reduce((sum, miner) => 
      sum + miner.performance.hashrate, 0);
    
    const totalShares = activeMiners.reduce((sum, miner) => 
      sum + miner.performance.shares.total, 0);
    
    const totalAcceptedShares = activeMiners.reduce((sum, miner) => 
      sum + miner.performance.shares.accepted, 0);
    
    const averageAcceptanceRate = totalShares > 0 ? 
      (totalAcceptedShares / totalShares) * 100 : 0;
    
    const totalPowerConsumption = activeMiners.reduce((sum, miner) => 
      sum + miner.performance.powerConsumption, 0);
    
    const overallEfficiency = totalPowerConsumption > 0 ? 
      totalHashrate / totalPowerConsumption : 0;
    
    return {
      timestamp: Date.now(),
      totalHashrate,
      activeMiners: activeMiners.length,
      totalMiners: this.miners.size,
      totalShares,
      acceptanceRate: averageAcceptanceRate,
      totalPowerConsumption,
      overallEfficiency,
      blocksFound: this.poolStats.blocksFound,
      averageBlockTime: this.poolStats.averageBlockTime,
      luck: this.poolStats.luck,
      uptime: Date.now() - this.startTime
    };
  }

  /**
   * Clean up miners that haven't been seen recently
   */
  cleanupInactiveMiners() {
    const inactiveTimeout = 30 * 60 * 1000; // 30 minutes
    const cutoff = Date.now() - inactiveTimeout;
    
    const toRemove = [];
    for (const [minerId, miner] of this.miners.entries()) {
      if (miner.lastSeen < cutoff) {
        toRemove.push(minerId);
      }
    }
    
    toRemove.forEach(minerId => {
      this.unregisterMiner(minerId);
    });
  }

  /**
   * Get statistics for a specific time window
   */
  getStatistics(timeWindow = TimeWindow.REALTIME) {
    const aggregator = this.aggregators[timeWindow];
    if (!aggregator) {
      throw new Error(`Invalid time window: ${timeWindow}`);
    }
    
    const latest = aggregator.getLatest();
    if (!latest) {
      return this.calculatePoolMetrics(); // Return current metrics if no historical data
    }
    
    return {
      current: latest,
      averages: {
        hashrate: aggregator.getAverage('totalHashrate'),
        activeMiners: aggregator.getAverage('activeMiners'),
        acceptanceRate: aggregator.getAverage('acceptanceRate'),
        efficiency: aggregator.getAverage('overallEfficiency')
      },
      peaks: {
        maxHashrate: aggregator.getMax('totalHashrate'),
        maxMiners: aggregator.getMax('activeMiners'),
        bestAcceptanceRate: aggregator.getMax('acceptanceRate')
      },
      dataPoints: aggregator.getDataPointsCount(),
      timeWindow
    };
  }

  /**
   * Get individual miner statistics
   */
  getMinerStatistics(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner) return null;
    
    return {
      minerId: miner.minerId,
      isActive: miner.isActive,
      isOnline: miner.isOnline(),
      uptimeSeconds: miner.getUptimeSeconds(),
      hardware: miner.hardware,
      performance: {
        ...miner.performance,
        acceptanceRate: miner.performance.getAcceptanceRate(),
        staleRate: miner.performance.getStaleRate(),
        efficiency: miner.performance.getEfficiency()
      },
      earnings: miner.earnings,
      historicalDataPoints: miner.historicalData.length
    };
  }

  /**
   * Get all miners statistics
   */
  getAllMinersStatistics() {
    const miners = [];
    for (const minerId of this.miners.keys()) {
      const stats = this.getMinerStatistics(minerId);
      if (stats) {
        miners.push(stats);
      }
    }
    return miners;
  }

  /**
   * Get collector health and performance metrics
   */
  getCollectorStats() {
    return {
      isCollecting: this.isCollecting,
      startTime: this.startTime,
      uptime: Date.now() - this.startTime,
      collectionCount: this.collectionCount,
      collectionErrors: this.collectionErrors,
      lastCollectionTime: this.lastCollectionTime,
      registeredMiners: this.miners.size,
      activeMiners: Array.from(this.miners.values()).filter(m => m.isOnline()).length,
      collectInterval: this.collectInterval,
      retentionPeriod: this.retentionPeriod
    };
  }

  /**
   * Export statistics to JSON
   */
  exportStatistics(timeWindow = TimeWindow.MEDIUM) {
    return {
      exportTime: new Date().toISOString(),
      timeWindow,
      poolStatistics: this.getStatistics(timeWindow),
      minerStatistics: this.getAllMinersStatistics(),
      collectorStats: this.getCollectorStats()
    };
  }
}

export default MiningStatisticsCollector;