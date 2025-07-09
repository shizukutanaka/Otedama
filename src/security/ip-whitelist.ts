// IP whitelist and access control (Pike simplicity)
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logging/logger';

export interface IPAccessRule {
  ip: string; // IP address or CIDR notation
  type: 'allow' | 'deny';
  description?: string;
  created: Date;
  expires?: Date;
}

export interface AccessControlConfig {
  mode: 'whitelist' | 'blacklist' | 'mixed';
  defaultAction: 'allow' | 'deny';
  enableGeoBlocking?: boolean;
  allowedCountries?: string[];
  blockedCountries?: string[];
}

export class IPAccessControl {
  private rules = new Map<string, IPAccessRule>();
  private ipCache = new Map<string, boolean>(); // IP -> allowed
  private cacheExpiry = 300000; // 5 minutes
  
  constructor(
    private config: AccessControlConfig = {
      mode: 'mixed',
      defaultAction: 'allow'
    }
  ) {
    this.loadRules();
  }
  
  private loadRules(): void {
    // Load from file if exists
    const rulesFile = path.join(process.cwd(), 'ip-rules.json');
    if (fs.existsSync(rulesFile)) {
      try {
        const data = fs.readFileSync(rulesFile, 'utf8');
        const rules: IPAccessRule[] = JSON.parse(data);
        
        for (const rule of rules) {
          rule.created = new Date(rule.created);
          if (rule.expires) {
            rule.expires = new Date(rule.expires);
          }
          this.rules.set(rule.ip, rule);
        }
        
        logger.info('ip-access', `Loaded ${rules.length} IP rules`);
      } catch (error) {
        logger.error('ip-access', 'Failed to load IP rules', error as Error);
      }
    }
  }
  
  // Check if IP is allowed
  isAllowed(ip: string): boolean {
    // Check cache first
    const cached = this.ipCache.get(ip);
    if (cached !== undefined) {
      return cached;
    }
    
    const allowed = this.checkAccess(ip);
    
    // Cache result
    this.ipCache.set(ip, allowed);
    setTimeout(() => this.ipCache.delete(ip), this.cacheExpiry);
    
    return allowed;
  }
  
  private checkAccess(ip: string): boolean {
    // Remove expired rules
    this.cleanupExpiredRules();
    
    // Check exact IP match
    const exactRule = this.rules.get(ip);
    if (exactRule) {
      return exactRule.type === 'allow';
    }
    
    // Check CIDR ranges
    for (const [ruleIP, rule] of this.rules) {
      if (this.ipMatchesCIDR(ip, ruleIP)) {
        return rule.type === 'allow';
      }
    }
    
    // Apply default action based on mode
    switch (this.config.mode) {
      case 'whitelist':
        // Only allow explicitly whitelisted IPs
        return false;
        
      case 'blacklist':
        // Allow all except explicitly blacklisted
        return true;
        
      case 'mixed':
      default:
        // Use default action
        return this.config.defaultAction === 'allow';
    }
  }
  
  // Check if IP matches CIDR notation
  private ipMatchesCIDR(ip: string, cidr: string): boolean {
    if (!cidr.includes('/')) {
      return ip === cidr;
    }
    
    try {
      const [network, bits] = cidr.split('/');
      const mask = parseInt(bits);
      
      const ipBinary = this.ipToBinary(ip);
      const networkBinary = this.ipToBinary(network);
      
      return ipBinary.substring(0, mask) === networkBinary.substring(0, mask);
    } catch {
      return false;
    }
  }
  
  // Convert IP to binary string
  private ipToBinary(ip: string): string {
    return ip.split('.')
      .map(octet => parseInt(octet).toString(2).padStart(8, '0'))
      .join('');
  }
  
  // Add allow rule
  allow(ip: string, description?: string, expiresIn?: number): void {
    const rule: IPAccessRule = {
      ip,
      type: 'allow',
      description,
      created: new Date()
    };
    
    if (expiresIn) {
      rule.expires = new Date(Date.now() + expiresIn);
    }
    
    this.rules.set(ip, rule);
    this.ipCache.delete(ip); // Clear cache
    this.saveRules();
    
    logger.info('ip-access', `Added allow rule for ${ip}`);
  }
  
  // Add deny rule
  deny(ip: string, description?: string, expiresIn?: number): void {
    const rule: IPAccessRule = {
      ip,
      type: 'deny',
      description,
      created: new Date()
    };
    
    if (expiresIn) {
      rule.expires = new Date(Date.now() + expiresIn);
    }
    
    this.rules.set(ip, rule);
    this.ipCache.delete(ip); // Clear cache
    this.saveRules();
    
    logger.info('ip-access', `Added deny rule for ${ip}`);
  }
  
  // Remove rule
  removeRule(ip: string): void {
    this.rules.delete(ip);
    this.ipCache.delete(ip);
    this.saveRules();
    
    logger.info('ip-access', `Removed rule for ${ip}`);
  }
  
  // Get all rules
  getRules(): IPAccessRule[] {
    this.cleanupExpiredRules();
    return Array.from(this.rules.values());
  }
  
  // Clean up expired rules
  private cleanupExpiredRules(): void {
    const now = new Date();
    const toRemove: string[] = [];
    
    for (const [ip, rule] of this.rules) {
      if (rule.expires && rule.expires < now) {
        toRemove.push(ip);
      }
    }
    
    for (const ip of toRemove) {
      this.rules.delete(ip);
      logger.info('ip-access', `Removed expired rule for ${ip}`);
    }
    
    if (toRemove.length > 0) {
      this.saveRules();
    }
  }
  
  // Save rules to file
  private saveRules(): void {
    const rulesFile = path.join(process.cwd(), 'ip-rules.json');
    const rules = Array.from(this.rules.values());
    
    try {
      fs.writeFileSync(rulesFile, JSON.stringify(rules, null, 2));
    } catch (error) {
      logger.error('ip-access', 'Failed to save IP rules', error as Error);
    }
  }
  
  // Clear all rules
  clearRules(): void {
    this.rules.clear();
    this.ipCache.clear();
    this.saveRules();
    
    logger.info('ip-access', 'Cleared all IP rules');
  }
  
  // Import rules from array
  importRules(rules: IPAccessRule[]): void {
    for (const rule of rules) {
      rule.created = new Date(rule.created);
      if (rule.expires) {
        rule.expires = new Date(rule.expires);
      }
      this.rules.set(rule.ip, rule);
    }
    
    this.ipCache.clear();
    this.saveRules();
    
    logger.info('ip-access', `Imported ${rules.length} IP rules`);
  }
  
  // Export rules
  exportRules(): string {
    const rules = Array.from(this.rules.values());
    return JSON.stringify(rules, null, 2);
  }
}

// IP range utilities
export class IPRangeUtil {
  // Parse IP range (e.g., "192.168.1.1-192.168.1.10")
  static parseRange(range: string): string[] {
    const ips: string[] = [];
    
    if (range.includes('-')) {
      const [start, end] = range.split('-');
      const startParts = start.split('.').map(Number);
      const endParts = end.split('.').map(Number);
      
      // Simple implementation for last octet only
      if (startParts[0] === endParts[0] && 
          startParts[1] === endParts[1] && 
          startParts[2] === endParts[2]) {
        
        for (let i = startParts[3]; i <= endParts[3]; i++) {
          ips.push(`${startParts[0]}.${startParts[1]}.${startParts[2]}.${i}`);
        }
      }
    } else {
      ips.push(range);
    }
    
    return ips;
  }
  
  // Convert CIDR to IP range
  static cidrToRange(cidr: string): { start: string; end: string } {
    const [ip, bits] = cidr.split('/');
    const mask = parseInt(bits);
    
    const ipNum = this.ipToNumber(ip);
    const maskNum = (0xFFFFFFFF << (32 - mask)) >>> 0;
    
    const start = (ipNum & maskNum) >>> 0;
    const end = (start | ~maskNum) >>> 0;
    
    return {
      start: this.numberToIP(start),
      end: this.numberToIP(end)
    };
  }
  
  private static ipToNumber(ip: string): number {
    const parts = ip.split('.');
    return (parseInt(parts[0]) << 24) + 
           (parseInt(parts[1]) << 16) + 
           (parseInt(parts[2]) << 8) + 
           parseInt(parts[3]);
  }
  
  private static numberToIP(num: number): string {
    return [
      (num >>> 24) & 0xFF,
      (num >>> 16) & 0xFF,
      (num >>> 8) & 0xFF,
      num & 0xFF
    ].join('.');
  }
}

// Geo-blocking extension
export class GeoIPFilter {
  private countryCache = new Map<string, string>(); // IP -> country code
  
  constructor(
    private allowedCountries: string[] = [],
    private blockedCountries: string[] = []
  ) {}
  
  async isAllowed(ip: string): Promise<boolean> {
    const country = await this.getCountry(ip);
    
    if (!country) {
      // Unknown country - allow by default
      return true;
    }
    
    // Check blocked countries first
    if (this.blockedCountries.length > 0 && this.blockedCountries.includes(country)) {
      return false;
    }
    
    // Check allowed countries
    if (this.allowedCountries.length > 0) {
      return this.allowedCountries.includes(country);
    }
    
    return true;
  }
  
  private async getCountry(ip: string): Promise<string | null> {
    // Check cache
    const cached = this.countryCache.get(ip);
    if (cached) {
      return cached;
    }
    
    // In production, would use GeoIP database or API
    // For now, return null
    return null;
  }
  
  updateAllowedCountries(countries: string[]): void {
    this.allowedCountries = countries;
    this.countryCache.clear();
  }
  
  updateBlockedCountries(countries: string[]): void {
    this.blockedCountries = countries;
    this.countryCache.clear();
  }
}
