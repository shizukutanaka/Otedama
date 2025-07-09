import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';

interface AnomalyConfig {
  // Share submission anomalies
  shareRateThreshold: number; // shares per second
  shareRateWindow: number; // seconds
  invalidShareThreshold: number; // percentage
  
  // Connection anomalies
  connectionRateThreshold: number; // connections per minute
  connectionPerIPThreshold: number;
  geoLocationEnabled: boolean;
  
  // Hashrate anomalies
  hashrateVarianceThreshold: number; // percentage
  hashrateDropThreshold: number; // percentage
  
  // Pattern detection
  patternAnalysisEnabled: boolean;
  mlModelEnabled: boolean;
}

interface AnomalyEvent {
  type: 'share_flood' | 'invalid_shares' | 'connection_flood' | 'hashrate_anomaly' | 
        'suspicious_pattern' | 'geo_anomaly' | 'timing_attack' | 'resource_abuse';
  severity: 'low' | 'medium' | 'high' | 'critical';
  source: string;
  description: string;
  metadata: any;
  timestamp: number;
  confidence: number; // 0-1
}

export class AnomalyDetector extends EventEmitter {
  private config: AnomalyConfig;
  private logger = getLogger('AnomalyDetector');
  
  // Tracking data
  private minerStats = new Map<string, {
    shares: number[];
    invalidShares: number;
    totalShares: number;
    connections: number;
    lastSeen: number;
    hashrate: number[];
    suspicionScore: number;
  }>();
  
  private ipStats = new Map<string, {
    connections: number;
    miners: Set<string>;
    lastSeen: number;
    blocked: boolean;
  }>();
  
  private patterns = {
    shareTimings: new Map<string, number[]>(),
    noncePatterns: new Map<string, string[]>(),
    connectionPatterns: new Map<string, number[]>()
  };
  
  private anomalyHistory: AnomalyEvent[] = [];
  private mlModel: any = null;
  
  constructor(config: Partial<AnomalyConfig> = {}) {
    super();
    
    this.config = {
      shareRateThreshold: 100, // 100 shares/sec is suspicious
      shareRateWindow: 60,
      invalidShareThreshold: 5, // 5% invalid is suspicious
      connectionRateThreshold: 50, // 50 connections/min
      connectionPerIPThreshold: 10,
      geoLocationEnabled: true,
      hashrateVarianceThreshold: 50, // 50% variance
      hashrateDropThreshold: 80, // 80% drop
      patternAnalysisEnabled: true,
      mlModelEnabled: false,
      ...config
    };
    
    this.startAnalysis();
  }
  
  // Track miner activity
  public trackShare(minerId: string, valid: boolean, nonce: string, timestamp: number): void {
    const stats = this.getMinerStats(minerId);
    
    // Update share counts
    stats.totalShares++;
    if (!valid) stats.invalidShares++;
    
    // Track share rate
    stats.shares.push(timestamp);
    stats.shares = stats.shares.filter(t => t > timestamp - this.config.shareRateWindow * 1000);
    
    // Track nonce patterns
    if (this.config.patternAnalysisEnabled) {
      const patterns = this.patterns.noncePatterns.get(minerId) || [];
      patterns.push(nonce);
      if (patterns.length > 100) patterns.shift();
      this.patterns.noncePatterns.set(minerId, patterns);
    }
    
    stats.lastSeen = timestamp;
    
    // Check for anomalies
    this.checkShareAnomalies(minerId, stats);
  }
  
  public trackConnection(ip: string, minerId: string): void {
    const ipStat = this.ipStats.get(ip) || {
      connections: 0,
      miners: new Set(),
      lastSeen: Date.now(),
      blocked: false
    };
    
    ipStat.connections++;
    ipStat.miners.add(minerId);
    ipStat.lastSeen = Date.now();
    
    this.ipStats.set(ip, ipStat);
    
    // Check connection anomalies
    this.checkConnectionAnomalies(ip, ipStat);
  }
  
  public trackHashrate(minerId: string, hashrate: number): void {
    const stats = this.getMinerStats(minerId);
    
    stats.hashrate.push(hashrate);
    if (stats.hashrate.length > 60) stats.hashrate.shift(); // Keep last 60 samples
    
    // Check hashrate anomalies
    this.checkHashrateAnomalies(minerId, stats);
  }
  
  // Anomaly detection methods
  private checkShareAnomalies(minerId: string, stats: any): void {
    const now = Date.now();
    
    // Check share flooding
    const shareRate = stats.shares.length / this.config.shareRateWindow;
    if (shareRate > this.config.shareRateThreshold) {
      this.raiseAnomaly({
        type: 'share_flood',
        severity: shareRate > this.config.shareRateThreshold * 2 ? 'high' : 'medium',
        source: minerId,
        description: `Abnormal share submission rate: ${shareRate.toFixed(2)} shares/sec`,
        metadata: { shareRate, threshold: this.config.shareRateThreshold },
        timestamp: now,
        confidence: Math.min(shareRate / (this.config.shareRateThreshold * 3), 1)
      });
    }
    
    // Check invalid share ratio
    const invalidRatio = stats.totalShares > 0 ? 
      (stats.invalidShares / stats.totalShares) * 100 : 0;
      
    if (invalidRatio > this.config.invalidShareThreshold && stats.totalShares > 100) {
      this.raiseAnomaly({
        type: 'invalid_shares',
        severity: invalidRatio > 20 ? 'high' : 'medium',
        source: minerId,
        description: `High invalid share ratio: ${invalidRatio.toFixed(2)}%`,
        metadata: { invalidRatio, totalShares: stats.totalShares },
        timestamp: now,
        confidence: Math.min(invalidRatio / 50, 1)
      });
    }
    
    // Pattern analysis
    if (this.config.patternAnalysisEnabled) {
      this.analyzePatterns(minerId);
    }
  }
  
  private checkConnectionAnomalies(ip: string, ipStat: any): void {
    // Check connections per IP
    if (ipStat.miners.size > this.config.connectionPerIPThreshold) {
      this.raiseAnomaly({
        type: 'connection_flood',
        severity: ipStat.miners.size > this.config.connectionPerIPThreshold * 2 ? 'critical' : 'high',
        source: ip,
        description: `Too many miners from single IP: ${ipStat.miners.size}`,
        metadata: { minerCount: ipStat.miners.size, miners: Array.from(ipStat.miners) },
        timestamp: Date.now(),
        confidence: 0.9
      });
    }
    
    // Check rapid connections
    const recentConnections = this.getRecentConnectionCount();
    if (recentConnections > this.config.connectionRateThreshold) {
      this.raiseAnomaly({
        type: 'connection_flood',
        severity: 'high',
        source: 'global',
        description: `Connection flood detected: ${recentConnections} connections/min`,
        metadata: { rate: recentConnections },
        timestamp: Date.now(),
        confidence: 0.8
      });
    }
  }
  
  private checkHashrateAnomalies(minerId: string, stats: any): void {
    if (stats.hashrate.length < 5) return; // Need enough samples
    
    const recent = stats.hashrate.slice(-5);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = Math.sqrt(recent.reduce((sum, h) => sum + Math.pow(h - avg, 2), 0) / recent.length);
    const variancePercent = (variance / avg) * 100;
    
    // Check variance
    if (variancePercent > this.config.hashrateVarianceThreshold) {
      this.raiseAnomaly({
        type: 'hashrate_anomaly',
        severity: 'medium',
        source: minerId,
        description: `Unstable hashrate detected: ${variancePercent.toFixed(2)}% variance`,
        metadata: { variance: variancePercent, average: avg },
        timestamp: Date.now(),
        confidence: Math.min(variancePercent / 100, 1)
      });
    }
    
    // Check sudden drops
    const latest = stats.hashrate[stats.hashrate.length - 1];
    const previous = stats.hashrate[stats.hashrate.length - 2];
    if (previous > 0) {
      const dropPercent = ((previous - latest) / previous) * 100;
      if (dropPercent > this.config.hashrateDropThreshold) {
        this.raiseAnomaly({
          type: 'hashrate_anomaly',
          severity: 'high',
          source: minerId,
          description: `Sudden hashrate drop: ${dropPercent.toFixed(2)}%`,
          metadata: { previous, current: latest, drop: dropPercent },
          timestamp: Date.now(),
          confidence: 0.95
        });
      }
    }
  }
  
  private analyzePatterns(minerId: string): void {
    const nonces = this.patterns.noncePatterns.get(minerId) || [];
    if (nonces.length < 10) return;
    
    // Check for repeated nonces (replay attack)
    const nonceSet = new Set(nonces);
    if (nonceSet.size < nonces.length * 0.9) {
      this.raiseAnomaly({
        type: 'suspicious_pattern',
        severity: 'high',
        source: minerId,
        description: 'Repeated nonce pattern detected - possible replay attack',
        metadata: { uniqueNonces: nonceSet.size, totalNonces: nonces.length },
        timestamp: Date.now(),
        confidence: 0.85
      });
    }
    
    // Check for timing patterns
    const timings = this.patterns.shareTimings.get(minerId) || [];
    if (timings.length > 10) {
      const intervals = [];
      for (let i = 1; i < timings.length; i++) {
        intervals.push(timings[i] - timings[i-1]);
      }
      
      // Check if intervals are too regular (bot behavior)
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const intervalVariance = Math.sqrt(
        intervals.reduce((sum, i) => sum + Math.pow(i - avgInterval, 2), 0) / intervals.length
      );
      
      if (intervalVariance < avgInterval * 0.1) { // Less than 10% variance
        this.raiseAnomaly({
          type: 'timing_attack',
          severity: 'medium',
          source: minerId,
          description: 'Suspiciously regular share submission timing',
          metadata: { averageInterval: avgInterval, variance: intervalVariance },
          timestamp: Date.now(),
          confidence: 0.7
        });
      }
    }
  }
  
  private raiseAnomaly(event: AnomalyEvent): void {
    // Deduplicate similar recent anomalies
    const recentSimilar = this.anomalyHistory.find(a => 
      a.type === event.type && 
      a.source === event.source && 
      Date.now() - a.timestamp < 300000 // 5 minutes
    );
    
    if (recentSimilar) {
      // Update confidence if higher
      if (event.confidence > recentSimilar.confidence) {
        recentSimilar.confidence = event.confidence;
      }
      return;
    }
    
    // Store anomaly
    this.anomalyHistory.push(event);
    if (this.anomalyHistory.length > 1000) {
      this.anomalyHistory.shift();
    }
    
    // Update suspicion score
    const stats = this.minerStats.get(event.source);
    if (stats) {
      stats.suspicionScore = Math.min(
        (stats.suspicionScore || 0) + event.confidence * 0.1,
        1
      );
    }
    
    // Emit event
    this.emit('anomaly', event);
    
    // Log based on severity
    switch (event.severity) {
      case 'critical':
        this.logger.error('CRITICAL ANOMALY', event);
        break;
      case 'high':
        this.logger.warn('High severity anomaly', event);
        break;
      case 'medium':
        this.logger.info('Medium severity anomaly', event);
        break;
      default:
        this.logger.debug('Low severity anomaly', event);
    }
    
    // Auto-block for critical anomalies
    if (event.severity === 'critical' && event.confidence > 0.9) {
      this.emit('block_request', event.source);
    }
  }
  
  // Machine Learning integration
  public async enableMLDetection(): Promise<void> {
    try {
      // This would load a pre-trained model
      // For now, we'll use rule-based detection
      this.config.mlModelEnabled = true;
      this.logger.info('ML-based anomaly detection enabled');
    } catch (error) {
      this.logger.error('Failed to enable ML detection', error);
    }
  }
  
  // Utility methods
  private getMinerStats(minerId: string): any {
    if (!this.minerStats.has(minerId)) {
      this.minerStats.set(minerId, {
        shares: [],
        invalidShares: 0,
        totalShares: 0,
        connections: 0,
        lastSeen: Date.now(),
        hashrate: [],
        suspicionScore: 0
      });
    }
    return this.minerStats.get(minerId);
  }
  
  private getRecentConnectionCount(): number {
    const now = Date.now();
    let count = 0;
    
    this.ipStats.forEach(stat => {
      if (now - stat.lastSeen < 60000) { // Last minute
        count += stat.connections;
      }
    });
    
    return count;
  }
  
  // Analysis loop
  private startAnalysis(): void {
    // Periodic cleanup
    setInterval(() => {
      const now = Date.now();
      
      // Clean old miner stats
      this.minerStats.forEach((stats, minerId) => {
        if (now - stats.lastSeen > 3600000) { // 1 hour
          this.minerStats.delete(minerId);
        }
      });
      
      // Clean old IP stats
      this.ipStats.forEach((stat, ip) => {
        if (now - stat.lastSeen > 3600000) {
          this.ipStats.delete(ip);
        }
      });
      
      // Clean old anomaly history
      this.anomalyHistory = this.anomalyHistory.filter(a => 
        now - a.timestamp < 86400000 // 24 hours
      );
    }, 300000); // Every 5 minutes
    
    // Periodic analysis
    setInterval(() => {
      this.performGlobalAnalysis();
    }, 60000); // Every minute
  }
  
  private performGlobalAnalysis(): void {
    // Detect coordinated attacks
    const suspiciousMiners = Array.from(this.minerStats.entries())
      .filter(([_, stats]) => stats.suspicionScore > 0.5)
      .map(([minerId, stats]) => ({ minerId, score: stats.suspicionScore }));
    
    if (suspiciousMiners.length > 10) {
      this.raiseAnomaly({
        type: 'suspicious_pattern',
        severity: 'critical',
        source: 'global',
        description: `Coordinated attack suspected: ${suspiciousMiners.length} suspicious miners`,
        metadata: { miners: suspiciousMiners },
        timestamp: Date.now(),
        confidence: Math.min(suspiciousMiners.length / 20, 1)
      });
    }
  }
  
  // Public API
  public getSuspicionScore(minerId: string): number {
    const stats = this.minerStats.get(minerId);
    return stats ? stats.suspicionScore : 0;
  }
  
  public getAnomalyHistory(minerId?: string): AnomalyEvent[] {
    if (minerId) {
      return this.anomalyHistory.filter(a => a.source === minerId);
    }
    return [...this.anomalyHistory];
  }
  
  public getStats(): any {
    return {
      totalMiners: this.minerStats.size,
      suspiciousMiners: Array.from(this.minerStats.values())
        .filter(s => s.suspicionScore > 0.5).length,
      totalAnomalies: this.anomalyHistory.length,
      recentAnomalies: this.anomalyHistory.filter(a => 
        Date.now() - a.timestamp < 3600000
      ).length,
      blockedIPs: Array.from(this.ipStats.values())
        .filter(s => s.blocked).length
    };
  }
}

export default AnomalyDetector;
