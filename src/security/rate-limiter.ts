/**
 * Rate limiting and DDoS protection
 * Following principles: simple, effective, minimal overhead
 */

import { EventEmitter } from 'events';
import { RateLimitError } from '../errors/pool-errors';

export interface RateLimitConfig {
  // Connection limits
  maxConnectionsPerIp: number;
  connectionWindowMs: number;
  
  // Share submission limits
  maxSharesPerMinute: number;
  maxSharesPerHour: number;
  
  // Invalid share limits
  maxInvalidSharesPerHour: number;
  banDurationMs: number;
  
  // API limits
  maxApiRequestsPerMinute: number;
  
  // Whitelist
  whitelistedIps?: string[];
}

interface RateLimitEntry {
  count: number;
  firstRequest: number;
  lastRequest: number;
  invalidShares: number;
  banned: boolean;
  banExpiry?: number;
}

export class RateLimiter extends EventEmitter {
  private connections = new Map<string, RateLimitEntry>();
  private shares = new Map<string, RateLimitEntry>();
  private apiRequests = new Map<string, RateLimitEntry>();
  private globalBans = new Set<string>();
  private cleanupTimer?: NodeJS.Timeout;

  constructor(private config: RateLimitConfig) {
    super();
    this.startCleanupTimer();
  }

  // Connection rate limiting
  checkConnection(ip: string): boolean {
    if (this.isWhitelisted(ip)) return true;
    if (this.isBanned(ip)) return false;

    const now = Date.now();
    let entry = this.connections.get(ip);

    if (!entry) {
      entry = this.createEntry(now);
      this.connections.set(ip, entry);
      return true;
    }

    // Reset if outside window
    if (now - entry.firstRequest > this.config.connectionWindowMs) {
      entry.count = 1;
      entry.firstRequest = now;
      entry.lastRequest = now;
      return true;
    }

    entry.count++;
    entry.lastRequest = now;

    if (entry.count > this.config.maxConnectionsPerIp) {
      this.banIp(ip, 'Too many connections');
      return false;
    }

    return true;
  }

  // Share submission rate limiting
  checkShareSubmission(minerId: string, ip: string, isValid: boolean): boolean {
    if (this.isWhitelisted(ip)) return true;
    if (this.isBanned(ip)) return false;

    const now = Date.now();
    let entry = this.shares.get(minerId) || this.shares.get(ip);

    if (!entry) {
      entry = this.createEntry(now);
      this.shares.set(minerId, entry);
      this.shares.set(ip, entry);
      return true;
    }

    // Check ban expiry
    if (entry.banned && entry.banExpiry && now > entry.banExpiry) {
      entry.banned = false;
      entry.banExpiry = undefined;
      entry.invalidShares = 0;
    }

    if (entry.banned) {
      throw new RateLimitError(
        'Temporarily banned due to excessive invalid shares',
        this.config.maxInvalidSharesPerHour,
        3600,
        Math.floor((entry.banExpiry! - now) / 1000)
      );
    }

    // Track invalid shares
    if (!isValid) {
      entry.invalidShares++;
      
      // Check invalid share limit (per hour)
      const hourAgo = now - 3600000;
      if (entry.firstRequest > hourAgo && entry.invalidShares > this.config.maxInvalidSharesPerHour) {
        entry.banned = true;
        entry.banExpiry = now + this.config.banDurationMs;
        
        this.emit('minerBanned', {
          minerId,
          ip,
          reason: 'Excessive invalid shares',
          duration: this.config.banDurationMs
        });
        
        return false;
      }
    }

    // Check per-minute limit
    const minuteAgo = now - 60000;
    if (entry.firstRequest > minuteAgo) {
      const sharesInLastMinute = this.countSharesSince(entry, minuteAgo);
      if (sharesInLastMinute >= this.config.maxSharesPerMinute) {
        throw new RateLimitError(
          'Share submission rate limit exceeded',
          this.config.maxSharesPerMinute,
          60,
          60 - Math.floor((now - entry.firstRequest) / 1000)
        );
      }
    }

    // Check per-hour limit
    const hourAgo = now - 3600000;
    if (entry.firstRequest > hourAgo) {
      const sharesInLastHour = this.countSharesSince(entry, hourAgo);
      if (sharesInLastHour >= this.config.maxSharesPerHour) {
        throw new RateLimitError(
          'Hourly share limit exceeded',
          this.config.maxSharesPerHour,
          3600,
          3600 - Math.floor((now - entry.firstRequest) / 1000)
        );
      }
    }

    entry.count++;
    entry.lastRequest = now;
    
    return true;
  }

  // API rate limiting
  checkApiRequest(ip: string, endpoint: string): boolean {
    if (this.isWhitelisted(ip)) return true;
    if (this.isBanned(ip)) return false;

    const now = Date.now();
    const key = `${ip}:${endpoint}`;
    let entry = this.apiRequests.get(key);

    if (!entry) {
      entry = this.createEntry(now);
      this.apiRequests.set(key, entry);
      return true;
    }

    // Reset if outside window (1 minute)
    const minuteAgo = now - 60000;
    if (entry.firstRequest < minuteAgo) {
      entry.count = 1;
      entry.firstRequest = now;
      entry.lastRequest = now;
      return true;
    }

    entry.count++;
    entry.lastRequest = now;

    if (entry.count > this.config.maxApiRequestsPerMinute) {
      throw new RateLimitError(
        'API rate limit exceeded',
        this.config.maxApiRequestsPerMinute,
        60,
        60 - Math.floor((now - entry.firstRequest) / 1000)
      );
    }

    return true;
  }

  // Ban management
  banIp(ip: string, reason: string, duration?: number): void {
    const banDuration = duration || this.config.banDurationMs;
    this.globalBans.add(ip);
    
    setTimeout(() => {
      this.globalBans.delete(ip);
    }, banDuration);

    this.emit('ipBanned', { ip, reason, duration: banDuration });
  }

  unbanIp(ip: string): void {
    this.globalBans.delete(ip);
    
    // Clear any miner-specific bans
    for (const [key, entry] of this.shares) {
      if (key === ip || key.includes(ip)) {
        entry.banned = false;
        entry.banExpiry = undefined;
      }
    }

    this.emit('ipUnbanned', { ip });
  }

  isBanned(ip: string): boolean {
    return this.globalBans.has(ip);
  }

  private isWhitelisted(ip: string): boolean {
    if (!this.config.whitelistedIps) return false;
    return this.config.whitelistedIps.includes(ip);
  }

  private createEntry(now: number): RateLimitEntry {
    return {
      count: 1,
      firstRequest: now,
      lastRequest: now,
      invalidShares: 0,
      banned: false
    };
  }

  private countSharesSince(entry: RateLimitEntry, since: number): number {
    // Simplified count - in production, you'd track individual timestamps
    if (entry.firstRequest < since) {
      // Estimate based on rate
      const duration = entry.lastRequest - entry.firstRequest;
      const rate = entry.count / duration;
      const recentDuration = entry.lastRequest - since;
      return Math.floor(rate * recentDuration);
    }
    return entry.count;
  }

  // Cleanup old entries
  private cleanup(): void {
    const now = Date.now();
    const maxAge = 3600000; // 1 hour

    // Clean connections
    for (const [ip, entry] of this.connections) {
      if (now - entry.lastRequest > maxAge) {
        this.connections.delete(ip);
      }
    }

    // Clean shares
    for (const [key, entry] of this.shares) {
      if (now - entry.lastRequest > maxAge && !entry.banned) {
        this.shares.delete(key);
      }
    }

    // Clean API requests
    for (const [key, entry] of this.apiRequests) {
      if (now - entry.lastRequest > maxAge) {
        this.apiRequests.delete(key);
      }
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 300000); // Every 5 minutes
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  getStats() {
    return {
      connections: this.connections.size,
      shares: this.shares.size,
      apiRequests: this.apiRequests.size,
      bannedIps: this.globalBans.size
    };
  }

  // Get detailed stats for monitoring
  getDetailedStats() {
    const now = Date.now();
    const stats = {
      connections: {
        total: this.connections.size,
        recent: 0,
        topIps: [] as Array<{ ip: string; count: number }>
      },
      shares: {
        total: this.shares.size,
        banned: 0,
        topMiners: [] as Array<{ id: string; count: number; invalid: number }>
      },
      bans: {
        total: this.globalBans.size,
        ips: Array.from(this.globalBans)
      }
    };

    // Count recent connections
    for (const [ip, entry] of this.connections) {
      if (now - entry.lastRequest < 300000) { // Last 5 minutes
        stats.connections.recent++;
      }
    }

    // Get top IPs by connection count
    const ipCounts = Array.from(this.connections.entries())
      .map(([ip, entry]) => ({ ip, count: entry.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    stats.connections.topIps = ipCounts;

    // Count banned miners
    for (const [id, entry] of this.shares) {
      if (entry.banned) {
        stats.shares.banned++;
      }
    }

    // Get top miners by share count
    const minerCounts = Array.from(this.shares.entries())
      .filter(([id]) => !id.includes('.')) // Filter out IPs
      .map(([id, entry]) => ({ 
        id, 
        count: entry.count, 
        invalid: entry.invalidShares 
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    stats.shares.topMiners = minerCounts;

    return stats;
  }
}

// Default configurations for different pool sizes
export const RateLimitProfiles = {
  small: {
    maxConnectionsPerIp: 5,
    connectionWindowMs: 60000,
    maxSharesPerMinute: 60,
    maxSharesPerHour: 3000,
    maxInvalidSharesPerHour: 50,
    banDurationMs: 3600000, // 1 hour
    maxApiRequestsPerMinute: 60
  },
  medium: {
    maxConnectionsPerIp: 10,
    connectionWindowMs: 60000,
    maxSharesPerMinute: 120,
    maxSharesPerHour: 6000,
    maxInvalidSharesPerHour: 100,
    banDurationMs: 1800000, // 30 minutes
    maxApiRequestsPerMinute: 120
  },
  large: {
    maxConnectionsPerIp: 20,
    connectionWindowMs: 60000,
    maxSharesPerMinute: 300,
    maxSharesPerHour: 15000,
    maxInvalidSharesPerHour: 200,
    banDurationMs: 900000, // 15 minutes
    maxApiRequestsPerMinute: 300
  }
};
