/**
 * Simple DDoS Protection - Lightweight Connection Protection
 * Design: John Carmack (Fast) + Rob Pike (Simple)
 */

import { createComponentLogger } from '../logging/simple-logger';

interface ConnectionInfo {
  count: number;
  firstSeen: number;
  lastSeen: number;
  blocked: boolean;
  blockExpiry: number;
}

interface DDoSConfig {
  maxConnectionsPerIP: number;
  timeWindowMs: number;
  blockDurationMs: number;
  maxNewConnectionsPerSecond: number;
  suspiciousThreshold: number;
}

class SimpleDDoSProtection {
  private connections: Map<string, ConnectionInfo> = new Map();
  private recentConnections: Array<{ ip: string; timestamp: number }> = [];
  private logger = createComponentLogger('DDoSProtection');
  
  constructor(private config: DDoSConfig) {
    this.startCleanupTask();
  }
  
  // Check if connection should be allowed
  checkConnection(ip: string): { allowed: boolean; reason?: string } {
    const now = Date.now();
    
    // Clean expired blocks
    this.cleanupExpiredBlocks(now);
    
    // Get or create connection info
    let info = this.connections.get(ip);
    if (!info) {
      info = {
        count: 0,
        firstSeen: now,
        lastSeen: now,
        blocked: false,
        blockExpiry: 0
      };
      this.connections.set(ip, info);
    }
    
    // Check if currently blocked
    if (info.blocked && now < info.blockExpiry) {
      return { 
        allowed: false, 
        reason: `IP blocked until ${new Date(info.blockExpiry).toISOString()}` 
      };
    }
    
    // Remove block if expired
    if (info.blocked && now >= info.blockExpiry) {
      info.blocked = false;
      info.blockExpiry = 0;
      info.count = 0;
      info.firstSeen = now;
      this.logger.info('IP unblocked', { ip });
    }
    
    // Check connection rate
    if (!this.checkConnectionRate(ip, now)) {
      this.blockIP(ip, now, 'High connection rate');
      return { allowed: false, reason: 'Connection rate exceeded' };
    }
    
    // Check concurrent connections
    if (!this.checkConcurrentConnections(ip, now, info)) {
      this.blockIP(ip, now, 'Too many concurrent connections');
      return { allowed: false, reason: 'Too many connections' };
    }
    
    // Update connection info
    info.count++;
    info.lastSeen = now;
    
    // Track recent connections for rate limiting
    this.recentConnections.push({ ip, timestamp: now });
    
    return { allowed: true };
  }
  
  private checkConnectionRate(ip: string, now: number): boolean {
    // Clean old entries (keep only last second)
    this.recentConnections = this.recentConnections.filter(
      conn => now - conn.timestamp < 1000
    );
    
    // Count connections from this IP in the last second
    const recentFromIP = this.recentConnections.filter(conn => conn.ip === ip).length;
    
    return recentFromIP < this.config.maxNewConnectionsPerSecond;
  }
  
  private checkConcurrentConnections(ip: string, now: number, info: ConnectionInfo): boolean {
    // Reset count if outside time window
    if (now - info.firstSeen > this.config.timeWindowMs) {
      info.count = 0;
      info.firstSeen = now;
    }
    
    return info.count < this.config.maxConnectionsPerIP;
  }
  
  private blockIP(ip: string, now: number, reason: string): void {
    const info = this.connections.get(ip)!;
    info.blocked = true;
    info.blockExpiry = now + this.config.blockDurationMs;
    
    this.logger.warn('IP blocked', { 
      ip, 
      reason, 
      duration: this.config.blockDurationMs / 1000 + 's',
      expiry: new Date(info.blockExpiry).toISOString()
    });
  }
  
  private cleanupExpiredBlocks(now: number): void {
    for (const [ip, info] of this.connections.entries()) {
      if (info.blocked && now >= info.blockExpiry) {
        info.blocked = false;
        info.blockExpiry = 0;
        info.count = 0;
        info.firstSeen = now;
      }
    }
  }
  
  // Called when connection is closed
  onConnectionClosed(ip: string): void {
    const info = this.connections.get(ip);
    if (info && info.count > 0) {
      info.count--;
    }
  }
  
  // Manual IP blocking
  blockIPManually(ip: string, durationMs?: number): void {
    const now = Date.now();
    const duration = durationMs || this.config.blockDurationMs;
    
    let info = this.connections.get(ip);
    if (!info) {
      info = {
        count: 0,
        firstSeen: now,
        lastSeen: now,
        blocked: false,
        blockExpiry: 0
      };
      this.connections.set(ip, info);
    }
    
    info.blocked = true;
    info.blockExpiry = now + duration;
    
    this.logger.warn('IP manually blocked', { 
      ip, 
      duration: duration / 1000 + 's' 
    });
  }
  
  // Unblock IP manually
  unblockIP(ip: string): boolean {
    const info = this.connections.get(ip);
    if (info && info.blocked) {
      info.blocked = false;
      info.blockExpiry = 0;
      info.count = 0;
      info.firstSeen = Date.now();
      
      this.logger.info('IP manually unblocked', { ip });
      return true;
    }
    return false;
  }
  
  // Check if IP is blocked
  isBlocked(ip: string): boolean {
    const info = this.connections.get(ip);
    return info ? info.blocked && Date.now() < info.blockExpiry : false;
  }
  
  // Get IP status
  getIPStatus(ip: string): any {
    const info = this.connections.get(ip);
    if (!info) {
      return { status: 'unknown' };
    }
    
    const now = Date.now();
    return {
      status: info.blocked && now < info.blockExpiry ? 'blocked' : 'allowed',
      connections: info.count,
      firstSeen: new Date(info.firstSeen).toISOString(),
      lastSeen: new Date(info.lastSeen).toISOString(),
      blockExpiry: info.blocked ? new Date(info.blockExpiry).toISOString() : null
    };
  }
  
  // Get statistics
  getStats(): any {
    const now = Date.now();
    let totalConnections = 0;
    let blockedIPs = 0;
    let activeConnections = 0;
    
    for (const info of this.connections.values()) {
      totalConnections += info.count;
      if (info.blocked && now < info.blockExpiry) {
        blockedIPs++;
      }
      if (now - info.lastSeen < this.config.timeWindowMs) {
        activeConnections++;
      }
    }
    
    return {
      totalIPs: this.connections.size,
      blockedIPs,
      activeConnections,
      totalConnections,
      recentConnectionsPerSecond: this.recentConnections.length,
      config: this.config
    };
  }
  
  // Get blocked IPs list
  getBlockedIPs(): Array<{ ip: string; expiry: string; reason?: string }> {
    const now = Date.now();
    const blocked: Array<{ ip: string; expiry: string; reason?: string }> = [];
    
    for (const [ip, info] of this.connections.entries()) {
      if (info.blocked && now < info.blockExpiry) {
        blocked.push({
          ip,
          expiry: new Date(info.blockExpiry).toISOString()
        });
      }
    }
    
    return blocked;
  }
  
  // Cleanup task
  private startCleanupTask(): void {
    setInterval(() => {
      this.cleanup();
    }, 60000); // Every minute
  }
  
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    
    // Remove old connection entries
    for (const [ip, info] of this.connections.entries()) {
      if (!info.blocked && 
          info.count === 0 && 
          now - info.lastSeen > this.config.timeWindowMs * 2) {
        this.connections.delete(ip);
        cleaned++;
      }
    }
    
    // Clean old recent connections
    this.recentConnections = this.recentConnections.filter(
      conn => now - conn.timestamp < 5000 // Keep last 5 seconds
    );
    
    if (cleaned > 0) {
      this.logger.debug('Cleaned up old connection entries', { count: cleaned });
    }
  }
}

// Default configuration
export const defaultDDoSConfig: DDoSConfig = {
  maxConnectionsPerIP: 10,        // Max concurrent connections per IP
  timeWindowMs: 60000,            // 1 minute window
  blockDurationMs: 300000,        // 5 minute block
  maxNewConnectionsPerSecond: 5,  // Max new connections per second per IP
  suspiciousThreshold: 50         // Threshold for suspicious activity
};

// Factory function
export function createDDoSProtection(config?: Partial<DDoSConfig>): SimpleDDoSProtection {
  const finalConfig = { ...defaultDDoSConfig, ...config };
  return new SimpleDDoSProtection(finalConfig);
}

export { SimpleDDoSProtection, DDoSConfig, ConnectionInfo };
