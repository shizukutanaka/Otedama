// IP Whitelist management for access control
import * as fs from 'fs/promises';
import * as path from 'path';
import * as net from 'net';
import { createComponentLogger } from '../logging/logger';

export interface WhitelistEntry {
  ip: string;
  cidr?: string;
  description?: string;
  addedAt: number;
  addedBy?: string;
  expiresAt?: number;
  permissions?: string[];
}

export interface WhitelistConfig {
  enabled: boolean;
  filePath: string;
  allowPrivateNetworks: boolean;
  defaultPermissions: string[];
  maxEntries: number;
  autoReload: boolean;
  reloadInterval: number; // milliseconds
}

export class IPWhitelist {
  private entries: Map<string, WhitelistEntry> = new Map();
  private ipRanges: Array<{ start: bigint; end: bigint; entry: WhitelistEntry }> = [];
  private logger = createComponentLogger('IPWhitelist');
  private reloadInterval: NodeJS.Timer | null = null;
  private lastModified: number = 0;
  
  constructor(private config: WhitelistConfig) {
    if (config.autoReload) {
      this.startAutoReload();
    }
  }
  
  async initialize(): Promise<void> {
    await this.loadWhitelist();
    
    // Add default entries for private networks if enabled
    if (this.config.allowPrivateNetworks) {
      this.addPrivateNetworkRanges();
    }
  }
  
  private addPrivateNetworkRanges(): void {
    const privateRanges = [
      { cidr: '10.0.0.0/8', description: 'Private network class A' },
      { cidr: '172.16.0.0/12', description: 'Private network class B' },
      { cidr: '192.168.0.0/16', description: 'Private network class C' },
      { cidr: '127.0.0.0/8', description: 'Loopback' }
    ];
    
    for (const range of privateRanges) {
      const [ip] = range.cidr.split('/');
      this.addEntry({
        ip,
        cidr: range.cidr,
        description: range.description,
        addedAt: Date.now(),
        addedBy: 'system',
        permissions: this.config.defaultPermissions
      });
    }
  }
  
  async loadWhitelist(): Promise<void> {
    try {
      const data = await fs.readFile(this.config.filePath, 'utf-8');
      const lines = data.split('\n').filter(line => line.trim() && !line.startsWith('#'));
      
      this.entries.clear();
      this.ipRanges = [];
      
      for (const line of lines) {
        try {
          // Parse different formats
          const entry = this.parseLine(line);
          if (entry) {
            this.addEntry(entry);
          }
        } catch (error) {
          this.logger.warn('Failed to parse whitelist entry', error as Error, { line });
        }
      }
      
      const stat = await fs.stat(this.config.filePath);
      this.lastModified = stat.mtimeMs;
      
      this.logger.info('Whitelist loaded', {
        entries: this.entries.size,
        ranges: this.ipRanges.length
      });
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        // File doesn't exist, create it
        await this.saveWhitelist();
      } else {
        this.logger.error('Failed to load whitelist', error as Error);
      }
    }
  }
  
  private parseLine(line: string): WhitelistEntry | null {
    // Format: IP[/CIDR] [permissions] [#description]
    const parts = line.split(/\s+/);
    if (parts.length === 0) return null;
    
    const ipPart = parts[0];
    let ip: string;
    let cidr: string | undefined;
    
    if (ipPart.includes('/')) {
      [ip, cidr] = ipPart.split('/');
      cidr = ipPart; // Keep full CIDR notation
    } else {
      ip = ipPart;
    }
    
    // Validate IP
    if (!this.isValidIP(ip)) {
      return null;
    }
    
    const permissions = parts.slice(1).filter(p => !p.startsWith('#'));
    const descIndex = parts.findIndex(p => p.startsWith('#'));
    const description = descIndex >= 0 ? parts.slice(descIndex).join(' ').substring(1) : undefined;
    
    return {
      ip,
      cidr,
      description,
      addedAt: Date.now(),
      permissions: permissions.length > 0 ? permissions : this.config.defaultPermissions
    };
  }
  
  private isValidIP(ip: string): boolean {
    return net.isIPv4(ip) || net.isIPv6(ip);
  }
  
  addEntry(entry: WhitelistEntry): void {
    if (this.entries.size >= this.config.maxEntries) {
      throw new Error(`Maximum whitelist entries (${this.config.maxEntries}) reached`);
    }
    
    if (entry.cidr) {
      // Add CIDR range
      const range = this.parseCIDR(entry.cidr);
      if (range) {
        this.ipRanges.push({ ...range, entry });
        this.entries.set(entry.cidr, entry);
      }
    } else {
      // Add single IP
      this.entries.set(entry.ip, entry);
    }
  }
  
  private parseCIDR(cidr: string): { start: bigint; end: bigint } | null {
    const [ip, bits] = cidr.split('/');
    const prefixLength = parseInt(bits);
    
    if (!this.isValidIP(ip) || isNaN(prefixLength)) {
      return null;
    }
    
    if (net.isIPv4(ip)) {
      const ipNum = this.ipv4ToBigInt(ip);
      const mask = (BigInt(1) << BigInt(32 - prefixLength)) - BigInt(1);
      const start = ipNum & ~mask;
      const end = start | mask;
      return { start, end };
    } else {
      // IPv6 support would go here
      return null;
    }
  }
  
  private ipv4ToBigInt(ip: string): bigint {
    const parts = ip.split('.');
    return parts.reduce((acc, part, i) => {
      return acc | (BigInt(parseInt(part)) << BigInt((3 - i) * 8));
    }, BigInt(0));
  }
  
  isWhitelisted(ip: string): boolean {
    if (!this.config.enabled) {
      return true; // Whitelist disabled, allow all
    }
    
    // Check exact match
    if (this.entries.has(ip)) {
      const entry = this.entries.get(ip)!;
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        return false; // Expired
      }
      return true;
    }
    
    // Check CIDR ranges
    if (net.isIPv4(ip)) {
      const ipNum = this.ipv4ToBigInt(ip);
      for (const range of this.ipRanges) {
        if (ipNum >= range.start && ipNum <= range.end) {
          if (range.entry.expiresAt && Date.now() > range.entry.expiresAt) {
            continue; // Expired
          }
          return true;
        }
      }
    }
    
    return false;
  }
  
  getPermissions(ip: string): string[] {
    // Check exact match
    const entry = this.entries.get(ip);
    if (entry) {
      return entry.permissions || this.config.defaultPermissions;
    }
    
    // Check CIDR ranges
    if (net.isIPv4(ip)) {
      const ipNum = this.ipv4ToBigInt(ip);
      for (const range of this.ipRanges) {
        if (ipNum >= range.start && ipNum <= range.end) {
          return range.entry.permissions || this.config.defaultPermissions;
        }
      }
    }
    
    return [];
  }
  
  async add(ip: string, options?: {
    cidr?: boolean;
    description?: string;
    permissions?: string[];
    expiresIn?: number; // milliseconds
    addedBy?: string;
  }): Promise<void> {
    const entry: WhitelistEntry = {
      ip: options?.cidr ? ip.split('/')[0] : ip,
      cidr: options?.cidr ? ip : undefined,
      description: options?.description,
      addedAt: Date.now(),
      addedBy: options?.addedBy,
      permissions: options?.permissions || this.config.defaultPermissions
    };
    
    if (options?.expiresIn) {
      entry.expiresAt = Date.now() + options.expiresIn;
    }
    
    this.addEntry(entry);
    await this.saveWhitelist();
    
    this.logger.info('IP added to whitelist', {
      ip: entry.ip,
      cidr: entry.cidr,
      addedBy: entry.addedBy
    });
  }
  
  async remove(ip: string): Promise<boolean> {
    const removed = this.entries.delete(ip);
    
    // Also remove from ranges if it's a CIDR
    this.ipRanges = this.ipRanges.filter(range => 
      range.entry.ip !== ip && range.entry.cidr !== ip
    );
    
    if (removed) {
      await this.saveWhitelist();
      this.logger.info('IP removed from whitelist', { ip });
    }
    
    return removed;
  }
  
  async saveWhitelist(): Promise<void> {
    const lines: string[] = [
      '# IP Whitelist',
      '# Format: IP[/CIDR] [permissions...] [#description]',
      '# Generated at: ' + new Date().toISOString(),
      ''
    ];
    
    for (const [key, entry] of this.entries) {
      let line = entry.cidr || entry.ip;
      
      if (entry.permissions && entry.permissions.length > 0) {
        line += ' ' + entry.permissions.join(' ');
      }
      
      if (entry.description) {
        line += ' #' + entry.description;
      }
      
      lines.push(line);
    }
    
    await fs.mkdir(path.dirname(this.config.filePath), { recursive: true });
    await fs.writeFile(this.config.filePath, lines.join('\n'));
  }
  
  private startAutoReload(): void {
    this.reloadInterval = setInterval(async () => {
      try {
        const stat = await fs.stat(this.config.filePath);
        if (stat.mtimeMs > this.lastModified) {
          await this.loadWhitelist();
        }
      } catch (error) {
        // File might not exist yet
      }
    }, this.config.reloadInterval);
  }
  
  stop(): void {
    if (this.reloadInterval) {
      clearInterval(this.reloadInterval);
      this.reloadInterval = null;
    }
  }
  
  // Get all entries
  getEntries(): WhitelistEntry[] {
    return Array.from(this.entries.values());
  }
  
  // Clear expired entries
  async cleanupExpired(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.entries.delete(key);
        removed++;
      }
    }
    
    // Clean up expired ranges
    this.ipRanges = this.ipRanges.filter(range => {
      if (range.entry.expiresAt && now > range.entry.expiresAt) {
        removed++;
        return false;
      }
      return true;
    });
    
    if (removed > 0) {
      await this.saveWhitelist();
      this.logger.info('Cleaned up expired entries', { count: removed });
    }
    
    return removed;
  }
  
  // Export whitelist for backup
  async export(): Promise<string> {
    const data = {
      version: '1.0',
      exported: new Date().toISOString(),
      entries: this.getEntries()
    };
    
    return JSON.stringify(data, null, 2);
  }
  
  // Import whitelist from backup
  async import(data: string): Promise<void> {
    const parsed = JSON.parse(data);
    
    if (parsed.version !== '1.0') {
      throw new Error('Unsupported whitelist version');
    }
    
    this.entries.clear();
    this.ipRanges = [];
    
    for (const entry of parsed.entries) {
      this.addEntry(entry);
    }
    
    await this.saveWhitelist();
    
    this.logger.info('Whitelist imported', {
      entries: this.entries.size
    });
  }
}

// Default configuration
export const defaultWhitelistConfig: WhitelistConfig = {
  enabled: false,
  filePath: './data/whitelist.txt',
  allowPrivateNetworks: true,
  defaultPermissions: ['mining'],
  maxEntries: 10000,
  autoReload: true,
  reloadInterval: 60000 // 1 minute
};
