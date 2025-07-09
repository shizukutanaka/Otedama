// DDoS Protection - Rate limiting and connection management (Pike style simplicity)
import * as net from 'net';
import { DDoSProtectionConfig, ShareThrottlerConfig, SynFloodConfig } from '../config/security';
import { RateLimiter } from './rate-limiter';

export class DDoSProtection {
  // IP-based rate limiting using token bucket algorithm
  private rateLimiter: RateLimiter;
  private blockedIPs = new Set<string>();
  private whitelistedIPs = new Set<string>();
  
  // Connection limits
  private connections = new Map<string, number>();
  private totalConnections = 0;
  
  // Violation tracking
  private violations = new Map<string, number>();
  
  // Configuration
  private readonly config: DDoSProtectionConfig;
  
  // Cleanup interval
  private cleanupInterval: NodeJS.Timeout;
  
  constructor(config: DDoSProtectionConfig) {
    this.config = config;
    
    // Initialize whitelist
    config.whitelistedIPs.forEach(ip => this.whitelistedIPs.add(ip));
    
    // Initialize rate limiter with token bucket configuration
    this.rateLimiter = new RateLimiter({
      tokensPerInterval: config.maxRequestsPerMinute,
      interval: 60000, // 1 minute in milliseconds
      bucketSize: config.maxRequestBurst
    });
    
    // Cleanup old entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }
  
  // Check if connection should be allowed
  canConnect(socket: net.Socket): boolean {
    const ip = socket.remoteAddress || '';
    
    // Always allow whitelisted IPs
    if (this.whitelistedIPs.has(ip)) {
      return true;
    }
    
    // Check if IP is blocked
    if (this.blockedIPs.has(ip)) {
      return false;
    }
    
    // Check total connections
    if (this.totalConnections >= this.config.maxTotalConnections) {
      console.warn(`Total connection limit reached: ${this.totalConnections}`);
      return false;
    }
    
    // Check per-IP connections
    const ipConnections = this.connections.get(ip) || 0;
    if (ipConnections >= this.config.maxConnectionsPerIP) {
      console.warn(`Connection limit for ${ip}: ${ipConnections}`);
      this.recordViolation(ip);
      return false;
    }
    
    return true;
  }
  
  // Track new connection
  addConnection(socket: net.Socket): void {
    const ip = socket.remoteAddress || '';
    
    this.totalConnections++;
    this.connections.set(ip, (this.connections.get(ip) || 0) + 1);
    
    // Remove connection when closed
    socket.once('close', () => {
      this.removeConnection(ip);
    });
  }
  
  // Remove connection
  private removeConnection(ip: string): void {
    this.totalConnections--;
    
    const count = this.connections.get(ip) || 0;
    if (count <= 1) {
      this.connections.delete(ip);
    } else {
      this.connections.set(ip, count - 1);
    }
  }
  
  // Rate limiting for requests using token bucket algorithm
  checkRateLimit(ip: string): boolean {
    // Always allow whitelisted IPs
    if (this.whitelistedIPs.has(ip)) {
      return true;
    }
    
    // Check if IP is blocked
    if (this.blockedIPs.has(ip)) {
      return false;
    }
    
    // Use token bucket algorithm for rate limiting
    const allowed = this.rateLimiter.isAllowed(ip);
    
    if (!allowed) {
      console.warn(`Rate limit exceeded for ${ip}`);
      this.recordViolation(ip);
    }
    
    return allowed;
  }
  
  // Record a violation and potentially block the IP
  private recordViolation(ip: string): void {
    // Don't record violations for whitelisted IPs
    if (this.whitelistedIPs.has(ip)) {
      return;
    }
    
    const violations = (this.violations.get(ip) || 0) + 1;
    this.violations.set(ip, violations);
    
    console.warn(`Security violation from ${ip} (${violations}/${this.config.autoBlockThreshold})`);
    
    // Auto-block if threshold exceeded
    if (violations >= this.config.autoBlockThreshold) {
      this.blockIP(ip);
    }
  }
  
  // Block an IP
  blockIP(ip: string): void {
    // Don't block whitelisted IPs
    if (this.whitelistedIPs.has(ip)) {
      return;
    }
    
    this.blockedIPs.add(ip);
    console.log(`Blocked IP: ${ip}`);
    
    // Auto-unblock after duration
    setTimeout(() => {
      this.blockedIPs.delete(ip);
      this.violations.delete(ip); // Reset violations
      console.log(`Unblocked IP: ${ip}`);
    }, this.config.blockDuration);
  }
  
  // Manual unblock
  unblockIP(ip: string): void {
    this.blockedIPs.delete(ip);
  }
  
  // Get blocked IPs
  getBlockedIPs(): string[] {
    return Array.from(this.blockedIPs);
  }
  
  // Cleanup old entries
  private cleanup(): void {
    // Cleanup is now handled by the RateLimiter class
    // Just perform any additional cleanup if needed
  }
  
  // Get statistics
  getStats(): {
    totalConnections: number;
    uniqueIPs: number;
    blockedIPs: number;
    whitelistedIPs: number;
    rateLimiterStats: { totalEntities: number };
    topIPs: Array<{ ip: string; connections: number }>;
  } {
    const topIPs = Array.from(this.connections.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([ip, connections]) => ({ ip, connections }));
    
    return {
      totalConnections: this.totalConnections,
      uniqueIPs: this.connections.size,
      blockedIPs: this.blockedIPs.size,
      whitelistedIPs: this.whitelistedIPs.size,
      rateLimiterStats: this.rateLimiter.getStats(),
      topIPs
    };
  }
  
  // Shutdown
  shutdown(): void {
    clearInterval(this.cleanupInterval);
    this.rateLimiter.shutdown();
  }
  
  // Add IP to whitelist
  addToWhitelist(ip: string): void {
    this.whitelistedIPs.add(ip);
    this.blockedIPs.delete(ip); // Remove from blocklist if present
    this.violations.delete(ip);  // Reset violations
  }
  
  // Remove IP from whitelist
  removeFromWhitelist(ip: string): void {
    this.whitelistedIPs.delete(ip);
  }
}

// Share validation throttling
export class ShareThrottler {
  private minerRateLimiters = new Map<string, RateLimiter>();
  private penalizedMiners = new Map<string, number>(); // Miner ID -> penalty end time
  private readonly config: ShareThrottlerConfig;
  private cleanupInterval: NodeJS.Timeout;
  
  constructor(config: ShareThrottlerConfig) {
    this.config = config;
    
    // Cleanup old entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }
  
  canSubmitShare(minerId: string): boolean {
    const now = Date.now();
    
    // Check if miner is currently penalized
    const penaltyEndTime = this.penalizedMiners.get(minerId);
    if (penaltyEndTime && now < penaltyEndTime) {
      return false;
    }
    
    // Get or create rate limiter for this miner
    let rateLimiter = this.minerRateLimiters.get(minerId);
    if (!rateLimiter) {
      rateLimiter = new RateLimiter({
        tokensPerInterval: this.config.maxSharesPerSecond,
        interval: 1000, // 1 second in milliseconds
        bucketSize: this.config.burstSize
      });
      this.minerRateLimiters.set(minerId, rateLimiter);
    }
    
    // Check if share submission is allowed
    const allowed = rateLimiter.isAllowed(minerId);
    
    // If not allowed, apply penalty
    if (!allowed) {
      this.penalizeMiner(minerId);
    }
    
    return allowed;
  }
  
  // Apply penalty to a miner for exceeding rate limits
  private penalizeMiner(minerId: string): void {
    const penaltyEndTime = Date.now() + this.config.penaltyDuration;
    this.penalizedMiners.set(minerId, penaltyEndTime);
    console.warn(`Miner ${minerId} penalized for exceeding share submission rate until ${new Date(penaltyEndTime).toISOString()}`);
  }
  
  // Cleanup old entries
  cleanup(): void {
    const now = Date.now();
    
    // Remove expired penalties
    for (const [minerId, endTime] of this.penalizedMiners.entries()) {
      if (now >= endTime) {
        this.penalizedMiners.delete(minerId);
        console.log(`Penalty for miner ${minerId} has expired`);
      }
    }
    
    // Limit the number of rate limiters to prevent memory leaks
    if (this.minerRateLimiters.size > 10000) {
      // If we have too many rate limiters, remove some
      const keys = Array.from(this.minerRateLimiters.keys());
      for (let i = 0; i < keys.length / 2; i++) {
        const minerId = keys[i];
        const rateLimiter = this.minerRateLimiters.get(minerId);
        if (rateLimiter) {
          rateLimiter.shutdown();
        }
        this.minerRateLimiters.delete(minerId);
      }
    }
  }
  
  // Get statistics
  getStats(): {
    activeMiners: number;
    penalizedMiners: number;
  } {
    return {
      activeMiners: this.minerRateLimiters.size,
      penalizedMiners: this.penalizedMiners.size
    };
  }
  
  // Shutdown
  shutdown(): void {
    clearInterval(this.cleanupInterval);
    for (const rateLimiter of this.minerRateLimiters.values()) {
      rateLimiter.shutdown();
    }
  }
}

// TCP SYN flood protection using SYN cookies (simplified)
export class SynFloodProtection {
  private synAttempts = new Map<string, { count: number, lastAttempt: number }>();
  private readonly config: SynFloodConfig;
  private readonly cleanupInterval: NodeJS.Timeout;
  
  constructor(config: SynFloodConfig) {
    this.config = config;
    
    // Cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // Cleanup every minute
  }
  
  checkSyn(ip: string): boolean {
    const now = Date.now();
    const entry = this.synAttempts.get(ip) || { count: 0, lastAttempt: now };
    
    // Reset count if timeout has passed
    if (now - entry.lastAttempt > this.config.synTimeout) {
      entry.count = 0;
    }
    
    if (entry.count >= this.config.maxSynPerIP) {
      console.warn(`SYN flood detected from ${ip}`);
      return false;
    }
    
    entry.count++;
    entry.lastAttempt = now;
    this.synAttempts.set(ip, entry);
    return true;
  }
  
  completeSyn(ip: string): void {
    const entry = this.synAttempts.get(ip);
    if (entry && entry.count > 0) {
      entry.count--;
      this.synAttempts.set(ip, entry);
    }
  }
  
  private cleanup(): void {
    const now = Date.now();
    const expireTime = now - this.config.synTimeout;
    
    // Remove entries that haven't been used recently
    for (const [ip, entry] of this.synAttempts.entries()) {
      if (entry.lastAttempt < expireTime) {
        this.synAttempts.delete(ip);
      }
    }
  }
  
  // Get statistics
  getStats(): {
    trackedIPs: number;
    potentialAttacks: number;
  } {
    const now = Date.now();
    let potentialAttacks = 0;
    
    for (const entry of this.synAttempts.values()) {
      if (entry.count >= this.config.maxSynPerIP / 2 && now - entry.lastAttempt < 10000) {
        potentialAttacks++;
      }
    }
    
    return {
      trackedIPs: this.synAttempts.size,
      potentialAttacks
    };
  }
  
  // Shutdown
  shutdown(): void {
    clearInterval(this.cleanupInterval);
  }
}
