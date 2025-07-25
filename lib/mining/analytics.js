/**
 * Advanced Mining Analytics - Otedama
 * Real-time and historical mining analytics
 * 
 * Features:
 * - Real-time performance metrics
 * - Historical data analysis
 * - Predictive analytics
 * - Anomaly detection
 * - Efficiency optimization recommendations
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('MiningAnalytics');

export class MiningAnalytics extends EventEmitter {
  constructor(storage, config = {}) {
    super();
    
    this.storage = storage;
    this.config = {
      retentionDays: config.retentionDays || 30,
      analysisInterval: config.analysisInterval || 300000, // 5 minutes
      anomalyThreshold: config.anomalyThreshold || 3, // Standard deviations
      predictionWindow: config.predictionWindow || 86400000 // 24 hours
    };
    
    this.metrics = {
      realtime: new Map(),
      historical: new Map(),
      predictions: new Map()
    };
    
    this.analysisTimer = null;
  }
  
  /**
   * Initialize analytics
   */
  async initialize() {
    logger.info('Initializing mining analytics...');
    
    // Create analytics tables
    await this.createAnalyticsTables();
    
    // Load historical data
    await this.loadHistoricalData();
    
    // Start analysis timer
    this.analysisTimer = setInterval(() => {
      this.performAnalysis();
    }, this.config.analysisInterval);
    
    logger.info('Mining analytics initialized');
  }
  
  /**
   * Create analytics tables
   */
  async createAnalyticsTables() {
    // Hourly statistics
    await this.storage.database.run(`
      CREATE TABLE IF NOT EXISTS analytics_hourly (
        hour DATETIME PRIMARY KEY,
        miners INTEGER,
        hashrate REAL,
        shares_submitted INTEGER,
        shares_valid INTEGER,
        shares_invalid INTEGER,
        blocks_found INTEGER,
        total_earnings REAL,
        avg_share_time REAL,
        efficiency REAL
      )
    `);
    
    // Daily statistics
    await this.storage.database.run(`
      CREATE TABLE IF NOT EXISTS analytics_daily (
        date DATE PRIMARY KEY,
        avg_miners REAL,
        avg_hashrate REAL,
        total_shares INTEGER,
        total_blocks INTEGER,
        total_earnings REAL,
        best_hour INTEGER,
        worst_hour INTEGER,
        variance REAL
      )
    `);
    
    // Miner performance
    await this.storage.database.run(`
      CREATE TABLE IF NOT EXISTS miner_analytics (
        miner_id TEXT,
        date DATE,
        hashrate_avg REAL,
        hashrate_min REAL,
        hashrate_max REAL,
        shares INTEGER,
        efficiency REAL,
        uptime REAL,
        earnings REAL,
        PRIMARY KEY (miner_id, date)
      )
    `);
    
    // Anomalies
    await this.storage.database.run(`
      CREATE TABLE IF NOT EXISTS analytics_anomalies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME,
        type TEXT,
        severity TEXT,
        description TEXT,
        metrics TEXT
      )
    `);
  }
  
  /**
   * Record real-time metrics
   */
  async recordMetrics(metrics) {
    const timestamp = new Date();
    
    // Store in memory for real-time access
    this.metrics.realtime.set(timestamp.getTime(), {
      timestamp,
      miners: metrics.totalMiners,
      hashrate: metrics.totalHashrate,
      shares: metrics.totalShares,
      efficiency: metrics.efficiency
    });
    
    // Clean old realtime metrics (keep 1 hour)
    const oneHourAgo = Date.now() - 3600000;
    for (const [time, data] of this.metrics.realtime) {
      if (time < oneHourAgo) {
        this.metrics.realtime.delete(time);
      }
    }
  }
  
  /**
   * Perform analysis
   */
  async performAnalysis() {
    try {
      // Aggregate hourly data
      await this.aggregateHourlyData();
      
      // Detect anomalies
      await this.detectAnomalies();
      
      // Generate predictions
      await this.generatePredictions();
      
      // Calculate efficiency metrics
      await this.calculateEfficiency();
      
      // Emit analytics update
      this.emit('analytics:updated', this.getAnalytics());
      
    } catch (error) {
      logger.error('Analysis error:', error);
    }
  }
  
  /**
   * Aggregate hourly data
   */
  async aggregateHourlyData() {
    const now = new Date();
    const currentHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
    
    // Check if hour is already processed
    const existing = await this.storage.database.get(
      'SELECT hour FROM analytics_hourly WHERE hour = ?',
      currentHour.toISOString()
    );
    
    if (existing) return;
    
    // Get stats for the past hour
    const hourAgo = new Date(currentHour.getTime() - 3600000);
    
    const stats = await this.storage.database.get(`
      SELECT 
        COUNT(DISTINCT m.id) as miners,
        AVG(ms.hashrate) as avg_hashrate,
        SUM(ms.shares_valid) as shares_valid,
        SUM(ms.shares_invalid) as shares_invalid,
        COUNT(DISTINCT b.id) as blocks_found
      FROM miners m
      LEFT JOIN miner_stats ms ON m.id = ms.miner_id
      LEFT JOIN blocks b ON b.timestamp BETWEEN ? AND ?
      WHERE m.connected_at <= ?
    `, [hourAgo.getTime(), currentHour.getTime(), currentHour.getTime()]);
    
    // Calculate efficiency
    const efficiency = stats.shares_valid > 0 ? 
      stats.shares_valid / (stats.shares_valid + stats.shares_invalid) : 0;
    
    // Insert hourly stats
    await this.storage.database.run(`
      INSERT INTO analytics_hourly (
        hour, miners, hashrate, shares_submitted, shares_valid, 
        shares_invalid, blocks_found, efficiency
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      currentHour.toISOString(),
      stats.miners || 0,
      stats.avg_hashrate || 0,
      (stats.shares_valid || 0) + (stats.shares_invalid || 0),
      stats.shares_valid || 0,
      stats.shares_invalid || 0,
      stats.blocks_found || 0,
      efficiency
    ]);
  }
  
  /**
   * Detect anomalies
   */
  async detectAnomalies() {
    // Get recent metrics
    const recentMetrics = Array.from(this.metrics.realtime.values());
    if (recentMetrics.length < 10) return;
    
    // Calculate statistics
    const hashrateValues = recentMetrics.map(m => m.hashrate);
    const avgHashrate = hashrateValues.reduce((a, b) => a + b, 0) / hashrateValues.length;
    const stdDev = Math.sqrt(
      hashrateValues.reduce((sum, value) => sum + Math.pow(value - avgHashrate, 2), 0) / hashrateValues.length
    );
    
    // Check for anomalies
    const latestHashrate = hashrateValues[hashrateValues.length - 1];
    const deviation = Math.abs(latestHashrate - avgHashrate) / stdDev;
    
    if (deviation > this.config.anomalyThreshold) {
      const anomaly = {
        timestamp: new Date(),
        type: 'hashrate',
        severity: deviation > 5 ? 'critical' : 'warning',
        description: `Hashrate deviation: ${deviation.toFixed(2)} standard deviations`,
        metrics: {
          current: latestHashrate,
          average: avgHashrate,
          stdDev: stdDev
        }
      };
      
      await this.recordAnomaly(anomaly);
      this.emit('anomaly:detected', anomaly);
    }
    
    // Check for sudden miner drops
    const minerCounts = recentMetrics.map(m => m.miners);
    const latestMiners = minerCounts[minerCounts.length - 1];
    const avgMiners = minerCounts.reduce((a, b) => a + b, 0) / minerCounts.length;
    
    if (latestMiners < avgMiners * 0.5) {
      const anomaly = {
        timestamp: new Date(),
        type: 'miner_drop',
        severity: 'warning',
        description: `Miner count dropped by ${((1 - latestMiners/avgMiners) * 100).toFixed(1)}%`,
        metrics: {
          current: latestMiners,
          average: avgMiners
        }
      };
      
      await this.recordAnomaly(anomaly);
      this.emit('anomaly:detected', anomaly);
    }
  }
  
  /**
   * Record anomaly
   */
  async recordAnomaly(anomaly) {
    await this.storage.database.run(`
      INSERT INTO analytics_anomalies (timestamp, type, severity, description, metrics)
      VALUES (?, ?, ?, ?, ?)
    `, [
      anomaly.timestamp.toISOString(),
      anomaly.type,
      anomaly.severity,
      anomaly.description,
      JSON.stringify(anomaly.metrics)
    ]);
  }
  
  /**
   * Generate predictions
   */
  async generatePredictions() {
    // Get historical data
    const history = await this.storage.database.all(`
      SELECT hour, hashrate, miners, blocks_found
      FROM analytics_hourly
      WHERE hour >= datetime('now', '-7 days')
      ORDER BY hour
    `);
    
    if (history.length < 24) return; // Need at least 24 hours
    
    // Simple moving average prediction
    const recentHours = history.slice(-24);
    const avgHashrate = recentHours.reduce((sum, h) => sum + h.hashrate, 0) / recentHours.length;
    const avgMiners = recentHours.reduce((sum, h) => sum + h.miners, 0) / recentHours.length;
    
    // Calculate trend
    const firstHalf = recentHours.slice(0, 12);
    const secondHalf = recentHours.slice(12);
    const firstAvg = firstHalf.reduce((sum, h) => sum + h.hashrate, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((sum, h) => sum + h.hashrate, 0) / secondHalf.length;
    const trend = (secondAvg - firstAvg) / firstAvg;
    
    // Generate predictions for next 24 hours
    const predictions = [];
    for (let i = 1; i <= 24; i++) {
      predictions.push({
        hour: i,
        hashrate: avgHashrate * (1 + trend * i / 24),
        miners: Math.round(avgMiners),
        confidence: Math.max(0.5, 1 - (i / 48)) // Confidence decreases with time
      });
    }
    
    this.metrics.predictions.set('24h', predictions);
  }
  
  /**
   * Calculate efficiency metrics
   */
  async calculateEfficiency() {
    // Get miner efficiency stats
    const minerStats = await this.storage.database.all(`
      SELECT 
        m.id,
        m.address,
        ms.hashrate,
        ms.shares_valid,
        ms.shares_invalid,
        ms.shares_valid * 1.0 / NULLIF(ms.shares_valid + ms.shares_invalid, 0) as efficiency
      FROM miners m
      JOIN miner_stats ms ON m.id = ms.miner_id
      WHERE m.connected = 1
    `);
    
    // Find underperforming miners
    const avgEfficiency = minerStats.reduce((sum, m) => sum + (m.efficiency || 0), 0) / minerStats.length;
    
    const underperformers = minerStats.filter(m => 
      m.efficiency < avgEfficiency * 0.9 && m.shares_valid + m.shares_invalid > 100
    );
    
    if (underperformers.length > 0) {
      this.emit('efficiency:alert', {
        avgEfficiency,
        underperformers: underperformers.map(m => ({
          address: m.address,
          efficiency: m.efficiency,
          hashrate: m.hashrate
        }))
      });
    }
  }
  
  /**
   * Load historical data
   */
  async loadHistoricalData() {
    const history = await this.storage.database.all(`
      SELECT * FROM analytics_daily
      WHERE date >= date('now', '-${this.config.retentionDays} days')
      ORDER BY date
    `);
    
    history.forEach(day => {
      this.metrics.historical.set(day.date, day);
    });
  }
  
  /**
   * Get analytics summary
   */
  getAnalytics() {
    const realtime = Array.from(this.metrics.realtime.values());
    const latest = realtime[realtime.length - 1] || {};
    
    return {
      realtime: {
        hashrate: latest.hashrate || 0,
        miners: latest.miners || 0,
        efficiency: latest.efficiency || 0,
        trend: this.calculateTrend(realtime.map(m => m.hashrate))
      },
      predictions: this.metrics.predictions.get('24h') || [],
      historical: {
        daily: Array.from(this.metrics.historical.values()),
        weekly: this.getWeeklyStats(),
        monthly: this.getMonthlyStats()
      }
    };
  }
  
  /**
   * Calculate trend
   */
  calculateTrend(values) {
    if (values.length < 2) return 0;
    
    const firstHalf = values.slice(0, Math.floor(values.length / 2));
    const secondHalf = values.slice(Math.floor(values.length / 2));
    
    const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    
    return ((avgSecond - avgFirst) / avgFirst) * 100;
  }
  
  /**
   * Get weekly statistics
   */
  getWeeklyStats() {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    
    const weekData = Array.from(this.metrics.historical.values())
      .filter(d => new Date(d.date) >= weekAgo);
    
    if (weekData.length === 0) return null;
    
    return {
      avgHashrate: weekData.reduce((sum, d) => sum + d.avg_hashrate, 0) / weekData.length,
      totalBlocks: weekData.reduce((sum, d) => sum + d.total_blocks, 0),
      totalEarnings: weekData.reduce((sum, d) => sum + d.total_earnings, 0)
    };
  }
  
  /**
   * Get monthly statistics
   */
  getMonthlyStats() {
    const monthAgo = new Date();
    monthAgo.setMonth(monthAgo.getMonth() - 1);
    
    const monthData = Array.from(this.metrics.historical.values())
      .filter(d => new Date(d.date) >= monthAgo);
    
    if (monthData.length === 0) return null;
    
    return {
      avgHashrate: monthData.reduce((sum, d) => sum + d.avg_hashrate, 0) / monthData.length,
      totalBlocks: monthData.reduce((sum, d) => sum + d.total_blocks, 0),
      totalEarnings: monthData.reduce((sum, d) => sum + d.total_earnings, 0),
      bestDay: monthData.reduce((best, d) => 
        d.total_earnings > (best?.total_earnings || 0) ? d : best
      )
    };
  }
  
  /**
   * Get miner analytics
   */
  async getMinerAnalytics(minerId, days = 7) {
    const analytics = await this.storage.database.all(`
      SELECT * FROM miner_analytics
      WHERE miner_id = ? AND date >= date('now', '-${days} days')
      ORDER BY date
    `, minerId);
    
    return {
      daily: analytics,
      average: {
        hashrate: analytics.reduce((sum, d) => sum + d.hashrate_avg, 0) / analytics.length,
        efficiency: analytics.reduce((sum, d) => sum + d.efficiency, 0) / analytics.length,
        uptime: analytics.reduce((sum, d) => sum + d.uptime, 0) / analytics.length
      },
      trend: this.calculateTrend(analytics.map(d => d.hashrate_avg))
    };
  }
  
  /**
   * Shutdown analytics
   */
  async shutdown() {
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
    }
    
    logger.info('Mining analytics shutdown');
  }
}

export default MiningAnalytics;
