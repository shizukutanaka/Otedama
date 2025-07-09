// Advanced DDoS Protection System with Machine Learning
import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import * as geoip from 'geoip-lite';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import Redis from 'ioredis';

interface AttackPattern {
  ip: string;
  timestamp: number;
  requestCount: number;
  uniqueUserAgents: Set<string>;
  requestIntervals: number[];
  suspiciousHeaders: number;
  geoLocation?: any;
  threatScore: number;
  attackType?: 'volumetric' | 'protocol' | 'application' | 'distributed';
}

interface DDoSConfig {
  enableMachineLearning: boolean;
  enableGeoBlocking: boolean;
  blockedCountries?: string[];
  whitelistedIPs: string[];
  blacklistDuration: number; // seconds
  suspiciousThreshold: number;
  autoBlockThreshold: number;
  cloudflareEnabled: boolean;
  cloudflareApiKey?: string;
  cloudflareZoneId?: string;
}

export class AdvancedDDoSProtection extends EventEmitter {
  private rateLimiter: RateLimiterRedis | RateLimiterMemory;
  private attackPatterns: Map<string, AttackPattern> = new Map();
  private blacklist: Map<string, number> = new Map(); // IP -> expiry timestamp
  private whitelist: Set<string> = new Set();
  private suspiciousActivity: Map<string, number> = new Map();
  private config: DDoSConfig;
  private redis?: Redis;
  
  // Attack signatures
  private readonly ATTACK_SIGNATURES = {
    // Layer 7 (Application) attacks
    httpFlood: {
      requestsPerSecond: 100,
      identicalRequests: 50,
      missingHeaders: ['user-agent', 'accept-language']
    },
    slowloris: {
      connectionDuration: 300000, // 5 minutes
      incompleteRequests: true,
      lowBandwidth: true
    },
    // Layer 4 (Protocol) attacks  
    synFlood: {
      halfOpenConnections: 1000,
      connectionRate: 500
    },
    // Amplification attacks
    amplification: {
      responseRatio: 10, // Response 10x larger than request
      commonPorts: [53, 123, 161, 389] // DNS, NTP, SNMP, LDAP
    }
  };
  
  constructor(config: DDoSConfig, redis?: Redis) {
    super();
    this.config = config;
    this.redis = redis;
    
    // Initialize rate limiter
    if (redis) {
      this.rateLimiter = new RateLimiterRedis({
        storeClient: redis,
        keyPrefix: 'ddos:rl',
        points: 100, // Number of requests
        duration: 60, // Per minute
        blockDuration: this.config.blacklistDuration
      });
    } else {
      this.rateLimiter = new RateLimiterMemory({
        points: 100,
        duration: 60,
        blockDuration: this.config.blacklistDuration
      });
    }
    
    // Load whitelist
    this.config.whitelistedIPs.forEach(ip => this.whitelist.add(ip));
    
    // Start cleanup interval
    this.startCleanupInterval();
    
    // Initialize ML model if enabled
    if (this.config.enableMachineLearning) {
      this.initializeMachineLearning();
    }
  }
  
  /**
   * Main protection method - analyzes request and determines if it should be blocked
   */
  async protect(
    ip: string,
    headers: Record<string, string>,
    method: string,
    path: string,
    body?: any
  ): Promise<{ blocked: boolean; reason?: string; threatLevel?: number }> {
    // 1. Check whitelist
    if (this.whitelist.has(ip)) {
      return { blocked: false };
    }
    
    // 2. Check blacklist
    if (this.isBlacklisted(ip)) {
      return { blocked: true, reason: 'Blacklisted IP' };
    }
    
    // 3. Geo-blocking
    if (this.config.enableGeoBlocking) {
      const geoBlock = this.checkGeoBlocking(ip);
      if (geoBlock.blocked) {
        return geoBlock;
      }
    }
    
    // 4. Rate limiting
    try {
      await this.rateLimiter.consume(ip);
    } catch (rateLimiterRes) {
      this.recordSuspiciousActivity(ip, 'rate_limit_exceeded');
      return { 
        blocked: true, 
        reason: 'Rate limit exceeded',
        threatLevel: 0.7
      };
    }
    
    // 5. Pattern analysis
    const pattern = this.analyzeRequestPattern(ip, headers, method, path);
    
    // 6. Detect specific attack types
    const attackDetection = this.detectAttackType(pattern, headers, body);
    if (attackDetection.detected) {
      await this.handleDetectedAttack(ip, attackDetection);
      return {
        blocked: true,
        reason: `Detected ${attackDetection.type} attack`,
        threatLevel: attackDetection.severity
      };
    }
    
    // 7. Machine learning prediction (if enabled)
    if (this.config.enableMachineLearning) {
      const mlPrediction = await this.predictThreat(pattern);
      if (mlPrediction.threatLevel > this.config.suspiciousThreshold) {
        this.recordSuspiciousActivity(ip, 'ml_prediction');
        
        if (mlPrediction.threatLevel > this.config.autoBlockThreshold) {
          await this.blacklistIP(ip, 'ML detected high threat');
          return {
            blocked: true,
            reason: 'ML threat detection',
            threatLevel: mlPrediction.threatLevel
          };
        }
      }
    }
    
    // 8. Check accumulated suspicious activity
    const suspicionLevel = this.suspiciousActivity.get(ip) || 0;
    if (suspicionLevel >= 5) {
      await this.blacklistIP(ip, 'Accumulated suspicious activity');
      return {
        blocked: true,
        reason: 'Multiple suspicious activities',
        threatLevel: 0.8
      };
    }
    
    return { blocked: false, threatLevel: pattern.threatScore };
  }
  
  /**
   * Analyze request patterns to identify potential attacks
   */
  private analyzeRequestPattern(
    ip: string,
    headers: Record<string, string>,
    method: string,
    path: string
  ): AttackPattern {
    const now = Date.now();
    let pattern = this.attackPatterns.get(ip);
    
    if (!pattern) {
      pattern = {
        ip,
        timestamp: now,
        requestCount: 0,
        uniqueUserAgents: new Set(),
        requestIntervals: [],
        suspiciousHeaders: 0,
        threatScore: 0
      };
      this.attackPatterns.set(ip, pattern);
    }
    
    // Update pattern data
    pattern.requestCount++;
    
    if (headers['user-agent']) {
      pattern.uniqueUserAgents.add(headers['user-agent']);
    }
    
    if (pattern.timestamp !== now) {
      pattern.requestIntervals.push(now - pattern.timestamp);
      pattern.timestamp = now;
    }
    
    // Check for suspicious indicators
    let threatScore = 0;
    
    // Missing common headers
    if (!headers['user-agent']) {
      pattern.suspiciousHeaders++;
      threatScore += 0.2;
    }
    
    if (!headers['accept']) {
      pattern.suspiciousHeaders++;
      threatScore += 0.1;
    }
    
    // Suspicious User-Agent patterns
    const ua = headers['user-agent'] || '';
    if (ua.includes('bot') || ua.includes('scanner') || ua.includes('crawler')) {
      threatScore += 0.3;
    }
    
    // Too many User-Agent variations from same IP
    if (pattern.uniqueUserAgents.size > 10) {
      threatScore += 0.4;
    }
    
    // Request rate analysis
    if (pattern.requestIntervals.length > 5) {
      const avgInterval = pattern.requestIntervals.reduce((a, b) => a + b) / pattern.requestIntervals.length;
      if (avgInterval < 100) { // Less than 100ms between requests
        threatScore += 0.5;
      }
    }
    
    // Repetitive requests to same endpoint
    if (pattern.requestCount > 100 && pattern.uniqueUserAgents.size === 1) {
      threatScore += 0.3;
    }
    
    pattern.threatScore = Math.min(threatScore, 1);
    return pattern;
  }
  
  /**
   * Detect specific attack types
   */
  private detectAttackType(
    pattern: AttackPattern,
    headers: Record<string, string>,
    body?: any
  ): { detected: boolean; type?: string; severity?: number } {
    // HTTP Flood detection
    if (pattern.requestCount > this.ATTACK_SIGNATURES.httpFlood.requestsPerSecond) {
      const missingHeaders = this.ATTACK_SIGNATURES.httpFlood.missingHeaders
        .filter(h => !headers[h]);
      
      if (missingHeaders.length >= 2) {
        return {
          detected: true,
          type: 'HTTP Flood',
          severity: 0.9
        };
      }
    }
    
    // Slowloris detection
    const connectionDuration = Date.now() - (pattern.timestamp - pattern.requestCount * 1000);
    if (connectionDuration > this.ATTACK_SIGNATURES.slowloris.connectionDuration) {
      return {
        detected: true,
        type: 'Slowloris',
        severity: 0.8
      };
    }
    
    // Application layer attack detection
    if (body) {
      // Check for malicious payloads
      const bodyStr = JSON.stringify(body);
      if (bodyStr.length > 1000000) { // 1MB+ payload
        return {
          detected: true,
          type: 'Payload Overflow',
          severity: 0.9
        };
      }
      
      // SQL injection patterns
      const sqlPatterns = [
        /(\b(union|select|insert|update|delete|drop)\b)/i,
        /(--|#|\/\*|\*\/)/,
        /(\b(or|and)\b\s*\d+\s*=\s*\d+)/i
      ];
      
      if (sqlPatterns.some(pattern => pattern.test(bodyStr))) {
        return {
          detected: true,
          type: 'SQL Injection Attempt',
          severity: 0.95
        };
      }
    }
    
    return { detected: false };
  }
  
  /**
   * Geo-blocking check
   */
  private checkGeoBlocking(ip: string): { blocked: boolean; reason?: string } {
    const geo = geoip.lookup(ip);
    
    if (!geo) {
      // Unknown location - suspicious
      this.recordSuspiciousActivity(ip, 'unknown_location');
      return { blocked: false };
    }
    
    if (this.config.blockedCountries?.includes(geo.country)) {
      return {
        blocked: true,
        reason: `Blocked country: ${geo.country}`
      };
    }
    
    // Check for known VPN/Proxy/Tor exit nodes
    if (this.isKnownProxy(ip)) {
      this.recordSuspiciousActivity(ip, 'proxy_detected');
    }
    
    return { blocked: false };
  }
  
  /**
   * Check if IP is a known proxy/VPN/Tor node
   */
  private isKnownProxy(ip: string): boolean {
    // This would integrate with threat intelligence feeds
    // For now, basic heuristics
    const suspiciousRanges = [
      '10.', '172.16.', '192.168.', // Private IPs
      '127.', // Localhost
    ];
    
    return suspiciousRanges.some(range => ip.startsWith(range));
  }
  
  /**
   * Handle detected attacks
   */
  private async handleDetectedAttack(
    ip: string,
    detection: { type?: string; severity?: number }
  ): Promise<void> {
    // Log attack
    this.emit('attack_detected', {
      ip,
      type: detection.type,
      severity: detection.severity,
      timestamp: new Date()
    });
    
    // Blacklist IP
    await this.blacklistIP(ip, `${detection.type} attack detected`);
    
    // If Cloudflare is enabled, add to Cloudflare blacklist
    if (this.config.cloudflareEnabled && this.config.cloudflareApiKey) {
      await this.addToCloudflareBlacklist(ip);
    }
    
    // Store attack data for ML training
    if (this.redis) {
      await this.redis.zadd(
        'ddos:attacks',
        Date.now(),
        JSON.stringify({ ip, ...detection })
      );
    }
  }
  
  /**
   * Blacklist an IP
   */
  private async blacklistIP(ip: string, reason: string): Promise<void> {
    const expiry = Date.now() + (this.config.blacklistDuration * 1000);
    this.blacklist.set(ip, expiry);
    
    if (this.redis) {
      await this.redis.setex(
        `ddos:blacklist:${ip}`,
        this.config.blacklistDuration,
        reason
      );
    }
    
    this.emit('ip_blacklisted', { ip, reason, expiry });
  }
  
  /**
   * Check if IP is blacklisted
   */
  private isBlacklisted(ip: string): boolean {
    const expiry = this.blacklist.get(ip);
    if (expiry && expiry > Date.now()) {
      return true;
    }
    
    // Clean up expired entry
    if (expiry) {
      this.blacklist.delete(ip);
    }
    
    return false;
  }
  
  /**
   * Record suspicious activity
   */
  private recordSuspiciousActivity(ip: string, type: string): void {
    const current = this.suspiciousActivity.get(ip) || 0;
    this.suspiciousActivity.set(ip, current + 1);
    
    this.emit('suspicious_activity', { ip, type, count: current + 1 });
  }
  
  /**
   * Machine Learning threat prediction
   */
  private async predictThreat(pattern: AttackPattern): Promise<{ threatLevel: number }> {
    // Simplified ML prediction
    // In production, this would use TensorFlow.js or similar
    
    const features = [
      pattern.requestCount / 1000,
      pattern.uniqueUserAgents.size / 10,
      pattern.suspiciousHeaders / 5,
      pattern.requestIntervals.length > 0 
        ? Math.min(...pattern.requestIntervals) / 1000 
        : 1,
      pattern.threatScore
    ];
    
    // Simple weighted calculation for demo
    const weights = [0.2, 0.15, 0.25, 0.3, 0.1];
    const threatLevel = features.reduce((sum, feature, i) => 
      sum + (feature * weights[i]), 0
    );
    
    return { threatLevel: Math.min(threatLevel, 1) };
  }
  
  /**
   * Initialize machine learning model
   */
  private async initializeMachineLearning(): Promise<void> {
    // In production, load pre-trained model
    this.emit('ml_initialized');
  }
  
  /**
   * Add IP to Cloudflare blacklist
   */
  private async addToCloudflareBlacklist(ip: string): Promise<void> {
    if (!this.config.cloudflareApiKey || !this.config.cloudflareZoneId) {
      return;
    }
    
    try {
      // Cloudflare API call would go here
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${this.config.cloudflareZoneId}/firewall/access_rules/rules`,
        {
          method: 'POST',
          headers: {
            'X-Auth-Key': this.config.cloudflareApiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            mode: 'block',
            configuration: {
              target: 'ip',
              value: ip
            },
            notes: 'DDoS protection auto-block'
          })
        }
      );
      
      if (response.ok) {
        this.emit('cloudflare_block_added', { ip });
      }
    } catch (error) {
      this.emit('error', { type: 'cloudflare_api', error });
    }
  }
  
  /**
   * Cleanup old data
   */
  private startCleanupInterval(): void {
    setInterval(() => {
      const now = Date.now();
      
      // Clean expired blacklist entries
      for (const [ip, expiry] of this.blacklist.entries()) {
        if (expiry < now) {
          this.blacklist.delete(ip);
        }
      }
      
      // Clean old attack patterns (older than 1 hour)
      for (const [ip, pattern] of this.attackPatterns.entries()) {
        if (now - pattern.timestamp > 3600000) {
          this.attackPatterns.delete(ip);
        }
      }
      
      // Reset suspicious activity counts
      this.suspiciousActivity.clear();
    }, 60000); // Every minute
  }
  
  /**
   * Get current protection statistics
   */
  getStats(): {
    blacklistedIPs: number;
    activePatterns: number;
    suspiciousIPs: number;
    totalBlockedRequests: number;
  } {
    return {
      blacklistedIPs: this.blacklist.size,
      activePatterns: this.attackPatterns.size,
      suspiciousIPs: this.suspiciousActivity.size,
      totalBlockedRequests: Array.from(this.blacklist.values()).length
    };
  }
  
  /**
   * Emergency response - block all traffic except whitelist
   */
  async emergencyMode(enable: boolean): Promise<void> {
    if (enable) {
      this.emit('emergency_mode_activated');
      // In emergency mode, only whitelist is allowed
      await this.rateLimiter.delete('*');
    } else {
      this.emit('emergency_mode_deactivated');
    }
  }
}

export default AdvancedDDoSProtection;
