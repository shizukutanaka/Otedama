/**
 * API Rate Limiter - API Usage Limiting System
 * 
 * Design Philosophy:
 * - Carmack: Efficient algorithm, minimal memory usage
 * - Martin: Clear rate limiting policies, configurable rules
 * - Pike: Simple configuration, predictable behavior
 */

import { EventEmitter } from 'events';
import { Logger } from '../logging/logger';

export interface RateLimit {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Maximum requests per window
  keyGenerator?: (req: any) => string; // Custom key generator
  skipIf?: (req: any) => boolean; // Skip rate limiting condition
  onLimitReached?: (req: any, rateLimitInfo: RateLimitInfo) => void;
}

export interface RateLimitRule {
  id: string;
  name: string;
  path: string; // Path pattern (supports wildcards)
  method?: string; // HTTP method (optional)
  rateLimit: RateLimit;
  enabled: boolean;
  priority: number; // Higher priority rules are checked first
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetTime: Date;
  windowStart: Date;
  key: string;
}

export interface RateLimitEntry {
  count: number;
  windowStart: number;
  firstRequest: number;
  lastRequest: number;
}

export interface RateLimitStats {
  totalRequests: number;
  blockedRequests: number;
  uniqueKeys: number;
  topKeys: Array<{ key: string; requests: number; blocked: number }>;
  ruleStats: Array<{ ruleId: string; applied: number; blocked: number }>;
}

export class APIRateLimiter extends EventEmitter {
  private entries: Map<string, RateLimitEntry> = new Map();
  private rules: Map<string, RateLimitRule> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private stats = {
    totalRequests: 0,
    blockedRequests: 0,
    ruleApplications: new Map<string, { applied: number; blocked: number }>()
  };

  constructor(
    private logger: Logger,
    private config = {
      cleanupIntervalMs: 60000, // 1 minute
      maxEntries: 100000, // Maximum number of rate limit entries to keep in memory
      defaultWindowMs: 60000, // 1 minute
      defaultMaxRequests: 100
    }
  ) {
    super();
    this.initializeDefaultRules();
    this.startCleanup();
  }

  public async start(): Promise<void> {
    this.logger.info('Starting API Rate Limiter...');
    this.logger.info('API Rate Limiter started');
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping API Rate Limiter...');
    
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.logger.info('API Rate Limiter stopped');
  }

  public addRule(rule: RateLimitRule): void {
    this.rules.set(rule.id, rule);
    this.stats.ruleApplications.set(rule.id, { applied: 0, blocked: 0 });
    this.logger.info(`Added rate limit rule: ${rule.name} (${rule.path})`);
  }

  public removeRule(ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      this.rules.delete(ruleId);
      this.stats.ruleApplications.delete(ruleId);
      this.logger.info(`Removed rate limit rule: ${rule.name}`);
    }
  }

  public updateRule(rule: RateLimitRule): void {
    this.rules.set(rule.id, rule);
    if (!this.stats.ruleApplications.has(rule.id)) {
      this.stats.ruleApplications.set(rule.id, { applied: 0, blocked: 0 });
    }
    this.logger.info(`Updated rate limit rule: ${rule.name}`);
  }

  public checkRateLimit(req: any): { allowed: boolean; rateLimitInfo: RateLimitInfo; rule?: RateLimitRule } {
    this.stats.totalRequests++;

    // Find matching rule
    const rule = this.findMatchingRule(req);
    if (!rule) {
      // No rule matches, allow the request
      return {
        allowed: true,
        rateLimitInfo: {
          limit: Infinity,
          remaining: Infinity,
          resetTime: new Date(Date.now() + this.config.defaultWindowMs),
          windowStart: new Date(),
          key: 'no-limit'
        }
      };
    }

    // Check if rule should be skipped
    if (rule.rateLimit.skipIf && rule.rateLimit.skipIf(req)) {
      return {
        allowed: true,
        rateLimitInfo: {
          limit: rule.rateLimit.maxRequests,
          remaining: rule.rateLimit.maxRequests,
          resetTime: new Date(Date.now() + rule.rateLimit.windowMs),
          windowStart: new Date(),
          key: 'skipped'
        },
        rule
      };
    }

    // Generate key for rate limiting
    const key = this.generateKey(req, rule);
    const now = Date.now();
    const windowStart = Math.floor(now / rule.rateLimit.windowMs) * rule.rateLimit.windowMs;

    // Get or create entry
    let entry = this.entries.get(key);
    if (!entry || entry.windowStart !== windowStart) {
      entry = {
        count: 0,
        windowStart,
        firstRequest: now,
        lastRequest: now
      };
      this.entries.set(key, entry);
    }

    // Update entry
    entry.count++;
    entry.lastRequest = now;

    // Update rule stats
    const ruleStats = this.stats.ruleApplications.get(rule.id)!;
    ruleStats.applied++;

    // Check if limit exceeded
    const allowed = entry.count <= rule.rateLimit.maxRequests;
    if (!allowed) {
      this.stats.blockedRequests++;
      ruleStats.blocked++;

      // Trigger callback if provided
      if (rule.rateLimit.onLimitReached) {
        const rateLimitInfo: RateLimitInfo = {
          limit: rule.rateLimit.maxRequests,
          remaining: 0,
          resetTime: new Date(windowStart + rule.rateLimit.windowMs),
          windowStart: new Date(windowStart),
          key
        };
        rule.rateLimit.onLimitReached(req, rateLimitInfo);
      }

      this.emit('rateLimitExceeded', {
        rule,
        key,
        count: entry.count,
        request: this.getRequestInfo(req)
      });

      this.logger.warn(`Rate limit exceeded for rule ${rule.name}`, {
        key,
        count: entry.count,
        limit: rule.rateLimit.maxRequests,
        path: req.path || req.url
      });
    }

    const rateLimitInfo: RateLimitInfo = {
      limit: rule.rateLimit.maxRequests,
      remaining: Math.max(0, rule.rateLimit.maxRequests - entry.count),
      resetTime: new Date(windowStart + rule.rateLimit.windowMs),
      windowStart: new Date(windowStart),
      key
    };

    return { allowed, rateLimitInfo, rule };
  }

  public getRateLimitHeaders(rateLimitInfo: RateLimitInfo): Record<string, string> {
    return {
      'X-RateLimit-Limit': rateLimitInfo.limit.toString(),
      'X-RateLimit-Remaining': rateLimitInfo.remaining.toString(),
      'X-RateLimit-Reset': Math.floor(rateLimitInfo.resetTime.getTime() / 1000).toString(),
      'X-RateLimit-Reset-Time': rateLimitInfo.resetTime.toISOString()
    };
  }

  public createMiddleware() {
    return (req: any, res: any, next: any) => {
      const result = this.checkRateLimit(req);
      
      // Add headers
      const headers = this.getRateLimitHeaders(result.rateLimitInfo);
      Object.entries(headers).forEach(([key, value]) => {
        res.setHeader(key, value);
      });

      if (!result.allowed) {
        res.status(429).json({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded',
          retryAfter: Math.ceil((result.rateLimitInfo.resetTime.getTime() - Date.now()) / 1000)
        });
        return;
      }

      next();
    };
  }

  public getStats(): RateLimitStats {
    const keyStats = new Map<string, { requests: number; blocked: number }>();
    
    // Calculate key statistics
    for (const [key, entry] of this.entries.entries()) {
      const existing = keyStats.get(key) || { requests: 0, blocked: 0 };
      existing.requests += entry.count;
      keyStats.set(key, existing);
    }

    const topKeys = Array.from(keyStats.entries())
      .map(([key, stats]) => ({ key, ...stats }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 10);

    const ruleStats = Array.from(this.stats.ruleApplications.entries())
      .map(([ruleId, stats]) => ({ ruleId, ...stats }));

    return {
      totalRequests: this.stats.totalRequests,
      blockedRequests: this.stats.blockedRequests,
      uniqueKeys: this.entries.size,
      topKeys,
      ruleStats
    };
  }

  public resetStats(): void {
    this.stats.totalRequests = 0;
    this.stats.blockedRequests = 0;
    this.stats.ruleApplications.clear();
    
    // Reinitialize rule stats
    for (const ruleId of this.rules.keys()) {
      this.stats.ruleApplications.set(ruleId, { applied: 0, blocked: 0 });
    }

    this.logger.info('Rate limiter stats reset');
  }

  public clearKey(key: string): boolean {
    const deleted = this.entries.delete(key);
    if (deleted) {
      this.logger.info(`Cleared rate limit for key: ${key}`);
    }
    return deleted;
  }

  public getRules(): RateLimitRule[] {
    return Array.from(this.rules.values()).sort((a, b) => b.priority - a.priority);
  }

  private findMatchingRule(req: any): RateLimitRule | null {
    const path = req.path || req.url || '';
    const method = req.method || 'GET';

    // Sort rules by priority (highest first)
    const sortedRules = Array.from(this.rules.values())
      .filter(rule => rule.enabled)
      .sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      // Check method match
      if (rule.method && rule.method.toLowerCase() !== method.toLowerCase()) {
        continue;
      }

      // Check path match (supports wildcards)
      if (this.pathMatches(path, rule.path)) {
        return rule;
      }
    }

    return null;
  }

  private pathMatches(requestPath: string, rulePath: string): boolean {
    // Convert wildcard pattern to regex
    const pattern = rulePath
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    
    const regex = new RegExp(`^${pattern}$`, 'i');
    return regex.test(requestPath);
  }

  private generateKey(req: any, rule: RateLimitRule): string {
    if (rule.rateLimit.keyGenerator) {
      return rule.rateLimit.keyGenerator(req);
    }

    // Default key generation: IP + User Agent hash
    const ip = this.getClientIP(req);
    const userAgent = req.headers?.['user-agent'] || '';
    const userAgentHash = this.simpleHash(userAgent);
    
    return `${rule.id}:${ip}:${userAgentHash}`;
  }

  private getClientIP(req: any): string {
    return req.ip || 
           req.connection?.remoteAddress || 
           req.socket?.remoteAddress ||
           req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
           '0.0.0.0';
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
  }

  private getRequestInfo(req: any): any {
    return {
      path: req.path || req.url,
      method: req.method,
      ip: this.getClientIP(req),
      userAgent: req.headers?.['user-agent'],
      timestamp: new Date().toISOString()
    };
  }



  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupIntervalMs);
  }

  private cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.entries.entries()) {
      // Remove entries that are outside any possible window
      const maxWindowMs = Math.max(0, ...Array.from(this.rules.values()).map(r => r.rateLimit.windowMs));
      if (now - entry.lastRequest > maxWindowMs) {
        this.entries.delete(key);
        removed++;
      }
    }

    // If still too many entries, remove oldest ones
    if (this.entries.size > this.config.maxEntries) {
      const sortedEntries = Array.from(this.entries.entries())
        .sort(([, a], [, b]) => a.lastRequest - b.lastRequest);

      const toRemove = this.entries.size - this.config.maxEntries;
      for (let i = 0; i < toRemove; i++) {
        const entryToRemove = sortedEntries[i];
        if (entryToRemove) {
          this.entries.delete(entryToRemove[0]);
          removed++;
        }
      }
    }

    if (removed > 0) {
      this.logger.debug(`Cleaned up ${removed} rate limit entries`);
    }
  }

  private initializeDefaultRules(): void {
    const defaultRules: RateLimitRule[] = [
      {
        id: 'api-general',
        name: 'General API Rate Limit',
        path: '/api/*',
        rateLimit: {
          windowMs: 60000, // 1 minute
          maxRequests: 100
        },
        enabled: true,
        priority: 1
      },
      {
        id: 'graphql-general',
        name: 'GraphQL Rate Limit',
        path: '/graphql',
        method: 'POST',
        rateLimit: {
          windowMs: 60000, // 1 minute
          maxRequests: 50
        },
        enabled: true,
        priority: 2
      },
      {
        id: 'auth-strict',
        name: 'Authentication Rate Limit',
        path: '/api/auth/*',
        rateLimit: {
          windowMs: 900000, // 15 minutes
          maxRequests: 5
        },
        enabled: true,
        priority: 10
      },
      {
        id: 'mining-data',
        name: 'Mining Data Rate Limit',
        path: '/api/mining/*',
        rateLimit: {
          windowMs: 30000, // 30 seconds
          maxRequests: 200
        },
        enabled: true,
        priority: 3
      }
    ];

    defaultRules.forEach(rule => this.addRule(rule));
    this.logger.info(`Initialized ${defaultRules.length} default rate limit rules`);
  }
}