/**
 * IP Whitelist/Blacklist System for Otedama
 * 
 * Design principles:
 * - Carmack: Fast IP lookup with O(1) performance
 * - Martin: Clean separation of concerns
 * - Pike: Simple but effective
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { isIPv4, isIPv6 } from 'net';

// IP list types
export const IPListType = {
  WHITELIST: 'whitelist',
  BLACKLIST: 'blacklist',
  GRAYLIST: 'graylist'
};

// IP entry sources
export const IPSource = {
  MANUAL: 'manual',
  AUTOMATIC: 'automatic',
  RATE_LIMIT: 'rate_limit',
  SECURITY_SCAN: 'security_scan',
  FRAUD_DETECTION: 'fraud_detection',
  GEO_BLOCKING: 'geo_blocking',
  API: 'api'
};

/**
 * CIDR utilities for IP range matching
 */
class CIDRMatcher {
  constructor(cidr) {
    const [ip, prefixLength] = cidr.split('/');
    this.ip = ip;
    this.prefixLength = parseInt(prefixLength) || (isIPv4(ip) ? 32 : 128);
    this.isIPv4 = isIPv4(ip);
    
    if (this.isIPv4) {
      this.mask = this.createIPv4Mask(this.prefixLength);
      this.network = this.ipToLong(ip) & this.mask;
    } else {
      // IPv6 handling
      this.parts = this.expandIPv6(ip);
      this.maskBits = this.prefixLength;
    }
  }

  createIPv4Mask(prefixLength) {
    return (-1 << (32 - prefixLength)) >>> 0;
  }

  ipToLong(ip) {
    const parts = ip.split('.');
    return parts.reduce((acc, part, i) => acc + (parseInt(part) << (8 * (3 - i))), 0) >>> 0;
  }

  expandIPv6(ip) {
    // Expand compressed IPv6 address
    let expanded = ip;
    
    // Handle :: compression
    if (expanded.includes('::')) {
      const parts = expanded.split('::');
      const left = parts[0].split(':').filter(p => p);
      const right = parts[1] ? parts[1].split(':').filter(p => p) : [];
      const missing = 8 - left.length - right.length;
      
      expanded = [
        ...left,
        ...Array(missing).fill('0000'),
        ...right
      ].join(':');
    }
    
    // Pad each part to 4 characters
    return expanded.split(':').map(part => part.padStart(4, '0'));
  }

  matches(ip) {
    if (isIPv4(ip) !== this.isIPv4) {
      return false;
    }
    
    if (this.isIPv4) {
      const ipLong = this.ipToLong(ip);
      return (ipLong & this.mask) === this.network;
    } else {
      const ipParts = this.expandIPv6(ip);
      let bitsToCheck = this.maskBits;
      
      for (let i = 0; i < 8 && bitsToCheck > 0; i++) {
        const bits = Math.min(16, bitsToCheck);
        const mask = (0xFFFF << (16 - bits)) & 0xFFFF;
        
        const ipPart = parseInt(ipParts[i], 16);
        const networkPart = parseInt(this.parts[i], 16);
        
        if ((ipPart & mask) !== (networkPart & mask)) {
          return false;
        }
        
        bitsToCheck -= bits;
      }
      
      return true;
    }
  }
}

/**
 * IP List Manager
 */
export class IPListManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      maxEntries: options.maxEntries || 100000,
      defaultExpiry: options.defaultExpiry || 86400000, // 24 hours
      cleanupInterval: options.cleanupInterval || 300000, // 5 minutes
      persistPath: options.persistPath,
      geoIPDatabase: options.geoIPDatabase,
      enableGeoBlocking: options.enableGeoBlocking || false,
      blockedCountries: options.blockedCountries || [],
      allowedCountries: options.allowedCountries || [],
      
      // Auto-blocking thresholds
      autoBlock: {
        enabled: options.autoBlock?.enabled || false,
        rateLimitViolations: options.autoBlock?.rateLimitViolations || 10,
        securityViolations: options.autoBlock?.securityViolations || 3,
        duration: options.autoBlock?.duration || 3600000 // 1 hour
      }
    };
    
    // IP storage with O(1) lookup
    this.lists = {
      [IPListType.WHITELIST]: new Map(),
      [IPListType.BLACKLIST]: new Map(),
      [IPListType.GRAYLIST]: new Map()
    };
    
    // CIDR ranges for efficient subnet matching
    this.cidrRanges = {
      [IPListType.WHITELIST]: [],
      [IPListType.BLACKLIST]: [],
      [IPListType.GRAYLIST]: []
    };
    
    // Statistics
    this.stats = {
      checks: 0,
      hits: 0,
      misses: 0,
      blocked: 0,
      allowed: 0,
      autoBlocked: 0
    };
    
    // Violation tracking for auto-blocking
    this.violations = new Map();
    
    // Start cleanup interval
    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.cleanupInterval);
    
    // Load persisted lists if configured
    if (this.config.persistPath) {
      this.loadLists().catch(err => this.emit('error', err));
    }
  }

  /**
   * Add IP to list
   */
  async addIP(ip, listType, options = {}) {
    if (!this.isValidIP(ip) && !this.isValidCIDR(ip)) {
      throw new Error(`Invalid IP or CIDR: ${ip}`);
    }
    
    const list = this.lists[listType];
    if (!list) {
      throw new Error(`Invalid list type: ${listType}`);
    }
    
    // Check max entries
    if (list.size >= this.config.maxEntries) {
      await this.cleanup(true); // Force cleanup
      
      if (list.size >= this.config.maxEntries) {
        throw new Error(`List ${listType} is full (max: ${this.config.maxEntries})`);
      }
    }
    
    const entry = {
      ip,
      type: listType,
      source: options.source || IPSource.MANUAL,
      reason: options.reason,
      createdAt: Date.now(),
      expiresAt: options.duration ? 
        Date.now() + options.duration : 
        (options.permanent ? null : Date.now() + this.config.defaultExpiry),
      metadata: options.metadata || {}
    };
    
    // Handle CIDR ranges
    if (ip.includes('/')) {
      const matcher = new CIDRMatcher(ip);
      this.cidrRanges[listType].push({
        ...entry,
        matcher
      });
    } else {
      // Regular IP
      list.set(ip, entry);
    }
    
    // Remove from other lists
    for (const [otherType, otherList] of Object.entries(this.lists)) {
      if (otherType !== listType) {
        otherList.delete(ip);
      }
    }
    
    // Persist if configured
    if (this.config.persistPath) {
      await this.saveLists();
    }
    
    this.emit('ip:added', entry);
    
    return entry;
  }

  /**
   * Remove IP from all lists
   */
  async removeIP(ip) {
    let removed = false;
    
    // Remove from regular lists
    for (const list of Object.values(this.lists)) {
      if (list.delete(ip)) {
        removed = true;
      }
    }
    
    // Remove from CIDR ranges
    for (const ranges of Object.values(this.cidrRanges)) {
      const index = ranges.findIndex(r => r.ip === ip);
      if (index !== -1) {
        ranges.splice(index, 1);
        removed = true;
      }
    }
    
    if (removed) {
      // Persist if configured
      if (this.config.persistPath) {
        await this.saveLists();
      }
      
      this.emit('ip:removed', { ip });
    }
    
    return removed;
  }

  /**
   * Check IP against lists
   */
  checkIP(ip) {
    this.stats.checks++;
    
    if (!this.isValidIP(ip)) {
      return {
        allowed: false,
        reason: 'Invalid IP',
        listType: null
      };
    }
    
    // Check whitelist first (highest priority)
    if (this.isInList(ip, IPListType.WHITELIST)) {
      this.stats.hits++;
      this.stats.allowed++;
      return {
        allowed: true,
        reason: 'Whitelisted',
        listType: IPListType.WHITELIST
      };
    }
    
    // Check blacklist
    if (this.isInList(ip, IPListType.BLACKLIST)) {
      this.stats.hits++;
      this.stats.blocked++;
      return {
        allowed: false,
        reason: 'Blacklisted',
        listType: IPListType.BLACKLIST
      };
    }
    
    // Check graylist (requires additional verification)
    if (this.isInList(ip, IPListType.GRAYLIST)) {
      this.stats.hits++;
      return {
        allowed: 'verify',
        reason: 'Graylisted - verification required',
        listType: IPListType.GRAYLIST
      };
    }
    
    // Check geo-blocking if enabled
    if (this.config.enableGeoBlocking) {
      const geoCheck = this.checkGeoBlocking(ip);
      if (!geoCheck.allowed) {
        this.stats.blocked++;
        return geoCheck;
      }
    }
    
    // Default allow
    this.stats.misses++;
    this.stats.allowed++;
    return {
      allowed: true,
      reason: 'Not listed',
      listType: null
    };
  }

  /**
   * Check if IP is in specific list
   */
  isInList(ip, listType) {
    // Check exact match
    const list = this.lists[listType];
    const entry = list.get(ip);
    
    if (entry) {
      // Check expiry
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        list.delete(ip);
        return false;
      }
      return true;
    }
    
    // Check CIDR ranges
    const ranges = this.cidrRanges[listType];
    for (const range of ranges) {
      // Check expiry
      if (range.expiresAt && Date.now() > range.expiresAt) {
        continue;
      }
      
      if (range.matcher.matches(ip)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Record violation for auto-blocking
   */
  recordViolation(ip, type, severity = 1) {
    if (!this.config.autoBlock.enabled) {
      return;
    }
    
    let violations = this.violations.get(ip);
    if (!violations) {
      violations = {
        count: 0,
        rateLimitViolations: 0,
        securityViolations: 0,
        firstViolation: Date.now(),
        lastViolation: Date.now()
      };
      this.violations.set(ip, violations);
    }
    
    violations.count += severity;
    violations.lastViolation = Date.now();
    
    if (type === 'rate_limit') {
      violations.rateLimitViolations += severity;
    } else if (type === 'security') {
      violations.securityViolations += severity;
    }
    
    // Check if should auto-block
    const shouldBlock = 
      violations.rateLimitViolations >= this.config.autoBlock.rateLimitViolations ||
      violations.securityViolations >= this.config.autoBlock.securityViolations;
    
    if (shouldBlock && !this.isInList(ip, IPListType.BLACKLIST)) {
      this.addIP(ip, IPListType.BLACKLIST, {
        source: IPSource.AUTOMATIC,
        reason: `Auto-blocked: ${violations.rateLimitViolations} rate limit violations, ${violations.securityViolations} security violations`,
        duration: this.config.autoBlock.duration
      }).then(() => {
        this.stats.autoBlocked++;
        this.emit('ip:auto-blocked', {
          ip,
          violations
        });
      }).catch(err => {
        this.emit('error', err);
      });
    }
  }

  /**
   * Check geo-blocking
   */
  checkGeoBlocking(ip) {
    // This would integrate with a GeoIP database
    // For now, return a placeholder
    return {
      allowed: true,
      reason: 'Geo-blocking not implemented',
      country: 'Unknown'
    };
  }

  /**
   * Validate IP address
   */
  isValidIP(ip) {
    return isIPv4(ip) || isIPv6(ip);
  }

  /**
   * Validate CIDR notation
   */
  isValidCIDR(cidr) {
    if (!cidr.includes('/')) {
      return false;
    }
    
    const [ip, prefix] = cidr.split('/');
    const prefixNum = parseInt(prefix);
    
    if (!this.isValidIP(ip)) {
      return false;
    }
    
    if (isIPv4(ip)) {
      return prefixNum >= 0 && prefixNum <= 32;
    } else {
      return prefixNum >= 0 && prefixNum <= 128;
    }
  }

  /**
   * Get list entries
   */
  getList(listType, options = {}) {
    const list = this.lists[listType];
    const ranges = this.cidrRanges[listType];
    
    if (!list) {
      throw new Error(`Invalid list type: ${listType}`);
    }
    
    const entries = [];
    
    // Add regular IPs
    for (const [ip, entry] of list) {
      if (!options.includeExpired && entry.expiresAt && Date.now() > entry.expiresAt) {
        continue;
      }
      entries.push(entry);
    }
    
    // Add CIDR ranges
    for (const range of ranges) {
      if (!options.includeExpired && range.expiresAt && Date.now() > range.expiresAt) {
        continue;
      }
      entries.push(range);
    }
    
    // Sort by creation time
    entries.sort((a, b) => b.createdAt - a.createdAt);
    
    // Apply pagination
    const page = options.page || 1;
    const limit = options.limit || 100;
    const start = (page - 1) * limit;
    const paginatedEntries = entries.slice(start, start + limit);
    
    return {
      entries: paginatedEntries,
      total: entries.length,
      page,
      limit,
      pages: Math.ceil(entries.length / limit)
    };
  }

  /**
   * Import IPs from file or array
   */
  async importIPs(source, listType, options = {}) {
    let ips = [];
    
    if (typeof source === 'string') {
      // Read from file
      const content = await fs.readFile(source, 'utf8');
      ips = content.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
    } else if (Array.isArray(source)) {
      ips = source;
    } else {
      throw new Error('Source must be file path or array');
    }
    
    const results = {
      success: 0,
      failed: 0,
      errors: []
    };
    
    for (const ip of ips) {
      try {
        await this.addIP(ip, listType, options);
        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push({ ip, error: error.message });
      }
    }
    
    this.emit('import:completed', results);
    return results;
  }

  /**
   * Export IPs to file
   */
  async exportIPs(listType, outputPath, options = {}) {
    const { entries } = this.getList(listType, { includeExpired: false });
    
    const lines = [];
    
    // Add header
    lines.push('# Otedama IP List Export');
    lines.push(`# Type: ${listType}`);
    lines.push(`# Date: ${new Date().toISOString()}`);
    lines.push(`# Total entries: ${entries.length}`);
    lines.push('');
    
    // Add entries
    for (const entry of entries) {
      if (options.includeMetadata) {
        lines.push(`# Source: ${entry.source}, Reason: ${entry.reason || 'N/A'}`);
        lines.push(`# Created: ${new Date(entry.createdAt).toISOString()}`);
        if (entry.expiresAt) {
          lines.push(`# Expires: ${new Date(entry.expiresAt).toISOString()}`);
        }
      }
      lines.push(entry.ip);
      lines.push('');
    }
    
    await fs.writeFile(outputPath, lines.join('\n'));
    
    this.emit('export:completed', {
      listType,
      outputPath,
      count: entries.length
    });
    
    return entries.length;
  }

  /**
   * Clean up expired entries
   */
  async cleanup(force = false) {
    const now = Date.now();
    let cleaned = 0;
    
    // Clean regular lists
    for (const list of Object.values(this.lists)) {
      for (const [ip, entry] of list) {
        if (entry.expiresAt && now > entry.expiresAt) {
          list.delete(ip);
          cleaned++;
        }
      }
    }
    
    // Clean CIDR ranges
    for (const ranges of Object.values(this.cidrRanges)) {
      const validRanges = ranges.filter(range => {
        if (range.expiresAt && now > range.expiresAt) {
          cleaned++;
          return false;
        }
        return true;
      });
      ranges.length = 0;
      ranges.push(...validRanges);
    }
    
    // Clean old violations
    const violationCutoff = now - 86400000; // 24 hours
    for (const [ip, violation] of this.violations) {
      if (violation.lastViolation < violationCutoff) {
        this.violations.delete(ip);
      }
    }
    
    if (cleaned > 0) {
      this.emit('cleanup:completed', { cleaned });
      
      // Persist if configured
      if (this.config.persistPath) {
        await this.saveLists();
      }
    }
    
    return cleaned;
  }

  /**
   * Get statistics
   */
  getStats() {
    const listStats = {};
    
    for (const [type, list] of Object.entries(this.lists)) {
      listStats[type] = {
        ips: list.size,
        ranges: this.cidrRanges[type].length,
        total: list.size + this.cidrRanges[type].length
      };
    }
    
    return {
      lists: listStats,
      performance: {
        ...this.stats,
        hitRate: this.stats.checks > 0 ? 
          (this.stats.hits / this.stats.checks * 100).toFixed(2) + '%' : '0%',
        blockRate: this.stats.checks > 0 ?
          (this.stats.blocked / this.stats.checks * 100).toFixed(2) + '%' : '0%'
      },
      violations: this.violations.size,
      autoBlocked: this.stats.autoBlocked,
      config: {
        maxEntries: this.config.maxEntries,
        autoBlockEnabled: this.config.autoBlock.enabled,
        geoBlockingEnabled: this.config.enableGeoBlocking
      }
    };
  }

  /**
   * Middleware for Express/Connect
   */
  middleware(options = {}) {
    return (req, res, next) => {
      const ip = this.extractIP(req);
      const check = this.checkIP(ip);
      
      req.ipCheck = check;
      
      if (check.allowed === false) {
        if (options.onBlocked) {
          return options.onBlocked(req, res, check);
        }
        
        res.statusCode = 403;
        res.end(JSON.stringify({
          error: 'Forbidden',
          message: check.reason,
          ip: options.exposeIP ? ip : undefined
        }));
        
        return;
      }
      
      if (check.allowed === 'verify' && options.onGraylisted) {
        return options.onGraylisted(req, res, next, check);
      }
      
      next();
    };
  }

  /**
   * Extract IP from request
   */
  extractIP(req) {
    // Check various headers for proxied requests
    const headers = [
      'x-forwarded-for',
      'x-real-ip',
      'x-client-ip',
      'cf-connecting-ip', // Cloudflare
      'fastly-client-ip', // Fastly
      'x-cluster-client-ip',
      'x-forwarded',
      'forwarded-for'
    ];
    
    for (const header of headers) {
      const value = req.headers[header];
      if (value) {
        // Handle comma-separated list
        const ips = value.split(',').map(ip => ip.trim());
        const validIP = ips.find(ip => this.isValidIP(ip));
        if (validIP) {
          return validIP;
        }
      }
    }
    
    // Fallback to socket address
    return req.connection?.remoteAddress || 
           req.socket?.remoteAddress || 
           req.ip;
  }

  /**
   * Load persisted lists
   */
  async loadLists() {
    try {
      const data = await fs.readFile(this.config.persistPath, 'utf8');
      const parsed = JSON.parse(data);
      
      // Clear current lists
      for (const list of Object.values(this.lists)) {
        list.clear();
      }
      for (const ranges of Object.values(this.cidrRanges)) {
        ranges.length = 0;
      }
      
      // Load entries
      for (const [listType, entries] of Object.entries(parsed.lists || {})) {
        for (const entry of entries) {
          if (entry.ip.includes('/')) {
            // CIDR range
            this.cidrRanges[listType].push({
              ...entry,
              matcher: new CIDRMatcher(entry.ip)
            });
          } else {
            // Regular IP
            this.lists[listType].set(entry.ip, entry);
          }
        }
      }
      
      // Load stats
      if (parsed.stats) {
        Object.assign(this.stats, parsed.stats);
      }
      
      this.emit('lists:loaded', {
        whitelist: this.lists[IPListType.WHITELIST].size,
        blacklist: this.lists[IPListType.BLACKLIST].size,
        graylist: this.lists[IPListType.GRAYLIST].size
      });
      
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * Save lists to persistent storage
   */
  async saveLists() {
    const data = {
      version: 1,
      timestamp: Date.now(),
      lists: {},
      stats: this.stats
    };
    
    // Save all lists
    for (const [listType, list] of Object.entries(this.lists)) {
      data.lists[listType] = [];
      
      // Add regular IPs
      for (const [ip, entry] of list) {
        data.lists[listType].push(entry);
      }
      
      // Add CIDR ranges (without matcher function)
      for (const range of this.cidrRanges[listType]) {
        const { matcher, ...rangeData } = range;
        data.lists[listType].push(rangeData);
      }
    }
    
    await fs.writeFile(this.config.persistPath, JSON.stringify(data, null, 2));
  }

  /**
   * Shutdown
   */
  shutdown() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    // Save final state if configured
    if (this.config.persistPath) {
      this.saveLists().catch(err => console.error('Failed to save lists:', err));
    }
    
    this.emit('shutdown');
  }
}

// Factory function
export function createIPListManager(options) {
  return new IPListManager(options);
}

// Default export
export default IPListManager;
