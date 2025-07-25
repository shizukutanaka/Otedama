/**
 * DDoS Protection - Otedama
 * Advanced DDoS protection following security best practices
 * 
 * Features:
 * - Connection rate limiting
 * - Bandwidth throttling
 * - Pattern-based detection
 * - Automatic IP banning
 * - Distributed attack mitigation
 */

import { createLogger } from '../core/logger.js';
import { LRUCache } from '../core/performance.js';
import crypto from 'crypto';
import { EventEmitter } from 'events';

const logger = createLogger('DDoSProtection');

/**
 * DDoS Protection System
 */
export class DDoSProtection extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration
    this.maxConnectionsPerIP = options.maxConnectionsPerIP || 5;
    this.maxRequestsPerMinute = options.maxRequestsPerMinute || 100;
    this.maxBandwidthPerIP = options.maxBandwidthPerIP || 10 * 1024 * 1024; // 10MB/min
    this.banDuration = options.banDuration || 3600000; // 1 hour
    this.suspicionThreshold = options.suspicionThreshold || 5;
    this.cleanupInterval = options.cleanupInterval || 60000; // 1 minute
    
    // Tracking structures
    this.connections = new Map(); // IP -> Set of connection IDs
    this.requests = new LRUCache(10000); // IP -> request timestamps
    this.bandwidth = new LRUCache(10000); // IP -> bytes transferred
    this.bans = new Map(); // IP -> ban expiry time
    this.suspicionScores = new Map(); // IP -> score
    
    // Pattern detection
    this.patterns = {
      // Rapid connection attempts
      rapidConnections: {
        threshold: 10,
        window: 1000, // 1 second
        score: 3
      },
      // High request rate
      highRequestRate: {
        threshold: 50,
        window: 10000, // 10 seconds
        score: 2
      },
      // Bandwidth abuse
      bandwidthAbuse: {
        threshold: 5 * 1024 * 1024, // 5MB
        window: 60000, // 1 minute
        score: 2
      },
      // Invalid protocol attempts
      invalidProtocol: {
        score: 5
      },
      // Known attack patterns
      knownPatterns: {
        score: 10
      }
    };
    
    // Statistics
    this.stats = {
      totalConnections: 0,
      blockedConnections: 0,
      totalRequests: 0,
      blockedRequests: 0,
      currentBans: 0,
      detectedAttacks: 0
    };
    
    // Start cleanup timer
    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupInterval);
  }
  
  /**
   * Check if connection is allowed
   */
  async checkConnection(ip, connectionId) {
    // Check if banned
    if (this.isBanned(ip)) {
      this.stats.blockedConnections++;
      return { allowed: false, reason: 'banned' };
    }
    
    // Get or create connection set for IP
    if (!this.connections.has(ip)) {
      this.connections.set(ip, new Set());
    }
    
    const ipConnections = this.connections.get(ip);
    
    // Check connection limit
    if (ipConnections.size >= this.maxConnectionsPerIP) {
      this.increaseSuspicion(ip, 'connection_limit');
      this.stats.blockedConnections++;
      return { allowed: false, reason: 'connection_limit' };
    }
    
    // Check rapid connection pattern
    const now = Date.now();
    const recentConnections = this.getRecentConnections(ip, now - this.patterns.rapidConnections.window);
    if (recentConnections >= this.patterns.rapidConnections.threshold) {
      this.increaseSuspicion(ip, 'rapid_connections', this.patterns.rapidConnections.score);
      this.detectAttack(ip, 'rapid_connections');
    }
    
    // Add connection
    ipConnections.add(connectionId);
    this.stats.totalConnections++;
    
    // Track connection time
    this.trackConnectionTime(ip, now);
    
    return { allowed: true };
  }
  
  /**
   * Remove connection
   */
  removeConnection(ip, connectionId) {
    const ipConnections = this.connections.get(ip);
    if (ipConnections) {
      ipConnections.delete(connectionId);
      if (ipConnections.size === 0) {
        this.connections.delete(ip);
      }
    }
  }
  
  /**
   * Check if request is allowed
   */
  async checkRequest(ip, bytes = 0) {
    // Check if banned
    if (this.isBanned(ip)) {
      this.stats.blockedRequests++;
      return { allowed: false, reason: 'banned' };
    }
    
    const now = Date.now();
    
    // Check request rate
    const requests = this.requests.get(ip) || [];
    const recentRequests = requests.filter(time => time > now - 60000);
    
    if (recentRequests.length >= this.maxRequestsPerMinute) {
      this.increaseSuspicion(ip, 'request_rate');
      this.stats.blockedRequests++;
      return { allowed: false, reason: 'rate_limit' };
    }
    
    // Check bandwidth
    if (bytes > 0) {
      const bandwidthData = this.bandwidth.get(ip) || { total: 0, window: now };
      
      // Reset window if expired
      if (now - bandwidthData.window > 60000) {
        bandwidthData.total = 0;
        bandwidthData.window = now;
      }
      
      bandwidthData.total += bytes;
      
      if (bandwidthData.total > this.maxBandwidthPerIP) {
        this.increaseSuspicion(ip, 'bandwidth_abuse', this.patterns.bandwidthAbuse.score);
        this.stats.blockedRequests++;
        return { allowed: false, reason: 'bandwidth_limit' };
      }
      
      this.bandwidth.set(ip, bandwidthData);
    }
    
    // Update request tracking
    recentRequests.push(now);
    this.requests.set(ip, recentRequests);
    this.stats.totalRequests++;
    
    return { allowed: true };
  }
  
  /**
   * Report invalid protocol
   */
  reportInvalidProtocol(ip) {
    this.increaseSuspicion(ip, 'invalid_protocol', this.patterns.invalidProtocol.score);
    this.detectAttack(ip, 'invalid_protocol');
  }
  
  /**
   * Report known attack pattern
   */
  reportAttackPattern(ip, pattern) {
    this.increaseSuspicion(ip, 'known_pattern', this.patterns.knownPatterns.score);
    this.detectAttack(ip, pattern);
  }
  
  /**
   * Increase suspicion score
   */
  increaseSuspicion(ip, reason, score = 1) {
    const currentScore = this.suspicionScores.get(ip) || 0;
    const newScore = currentScore + score;
    
    this.suspicionScores.set(ip, newScore);
    
    logger.warn(`Increased suspicion for ${ip}: ${reason} (score: ${newScore})`);
    
    // Auto-ban if threshold exceeded
    if (newScore >= this.suspicionThreshold) {
      this.ban(ip, 'suspicion_threshold');
    }
  }
  
  /**
   * Ban IP address
   */
  ban(ip, reason) {
    const expiryTime = Date.now() + this.banDuration;
    this.bans.set(ip, expiryTime);
    this.stats.currentBans++;
    
    // Remove all connections
    const ipConnections = this.connections.get(ip);
    if (ipConnections) {
      for (const connectionId of ipConnections) {
        this.emit('connection:terminate', { ip, connectionId, reason });
      }
      this.connections.delete(ip);
    }
    
    logger.warn(`Banned IP ${ip}: ${reason}`);
    this.emit('ip:banned', { ip, reason, expiryTime });
  }
  
  /**
   * Unban IP address
   */
  unban(ip) {
    if (this.bans.delete(ip)) {
      this.stats.currentBans--;
      this.suspicionScores.delete(ip);
      logger.info(`Unbanned IP ${ip}`);
      this.emit('ip:unbanned', { ip });
    }
  }
  
  /**
   * Check if IP is banned
   */
  isBanned(ip) {
    const banExpiry = this.bans.get(ip);
    if (!banExpiry) return false;
    
    if (Date.now() > banExpiry) {
      this.unban(ip);
      return false;
    }
    
    return true;
  }
  
  /**
   * Detect attack
   */
  detectAttack(ip, type) {
    this.stats.detectedAttacks++;
    logger.error(`Detected ${type} attack from ${ip}`);
    this.emit('attack:detected', { ip, type, timestamp: Date.now() });
  }
  
  /**
   * Track connection time
   */
  trackConnectionTime(ip, time) {
    if (!this.connectionTimes) {
      this.connectionTimes = new Map();
    }
    
    const times = this.connectionTimes.get(ip) || [];
    times.push(time);
    
    // Keep only recent times
    const cutoff = time - 60000; // 1 minute
    const recentTimes = times.filter(t => t > cutoff);
    
    if (recentTimes.length > 0) {
      this.connectionTimes.set(ip, recentTimes);
    } else {
      this.connectionTimes.delete(ip);
    }
  }
  
  /**
   * Get recent connections count
   */
  getRecentConnections(ip, since) {
    const times = this.connectionTimes?.get(ip) || [];
    return times.filter(t => t > since).length;
  }
  
  /**
   * Cleanup expired data
   */
  cleanup() {
    const now = Date.now();
    
    // Clean expired bans
    for (const [ip, expiry] of this.bans) {
      if (now > expiry) {
        this.unban(ip);
      }
    }
    
    // Clean old request data
    for (const [ip, requests] of this.requests.cache) {
      const recentRequests = requests.filter(time => time > now - 300000); // 5 minutes
      if (recentRequests.length === 0) {
        this.requests.delete(ip);
      } else {
        this.requests.set(ip, recentRequests);
      }
    }
    
    // Clean old suspicion scores
    for (const [ip, score] of this.suspicionScores) {
      if (!this.connections.has(ip) && !this.isBanned(ip)) {
        // Decay suspicion score
        const newScore = Math.max(0, score - 1);
        if (newScore === 0) {
          this.suspicionScores.delete(ip);
        } else {
          this.suspicionScores.set(ip, newScore);
        }
      }
    }
  }
  
  /**
   * Get protection statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeConnections: this.connections.size,
      suspiciousIPs: this.suspicionScores.size,
      connectionUtilization: (this.stats.totalConnections / this.maxConnectionsPerIP) * 100
    };
  }
  
  /**
   * Get banned IPs
   */
  getBannedIPs() {
    const banned = [];
    const now = Date.now();
    
    for (const [ip, expiry] of this.bans) {
      banned.push({
        ip,
        expiry,
        remainingTime: Math.max(0, expiry - now)
      });
    }
    
    return banned;
  }
  
  /**
   * Shutdown protection system
   */
  shutdown() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

/**
 * Create DDoS protection instance
 */
export function createDDoSProtection(options) {
  return new DDoSProtection(options);
}

export default {
  DDoSProtection,
  createDDoSProtection
};
