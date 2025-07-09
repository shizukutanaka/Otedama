// Simple authentication system (Uncle Bob clean architecture + Pike simplicity)
import * as crypto from 'crypto';
import { Database } from '../database/database';

interface AuthCredentials {
  username: string;
  password: string;
  workerName?: string;
}

interface AuthResult {
  success: boolean;
  minerId?: string;
  message?: string;
}

export class AuthSystem {
  private db: Database;
  private authCache = new Map<string, { hash: string; address: string }>();
  private sessionTokens = new Map<string, string>(); // token -> minerId
  
  constructor(db: Database) {
    this.db = db;
    this.loadAuthData();
  }
  
  // Simple password hashing (use bcrypt in production)
  private hashPassword(password: string): string {
    return crypto.createHash('sha256').update(password).digest('hex');
  }
  
  // Generate session token
  private generateToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }
  
  // Load auth data from database
  private async loadAuthData(): Promise<void> {
    const miners = await this.db.getAllMiners();
    
    for (const miner of miners) {
      // In production, store hashed passwords separately
      // For now, use miner ID as username
      this.authCache.set(miner.id, {
        hash: this.hashPassword(miner.id), // Placeholder
        address: miner.address
      });
    }
  }
  
  // Authenticate miner
  async authenticate(credentials: AuthCredentials): Promise<AuthResult> {
    const { username, password, workerName } = credentials;
    
    // Validate input
    if (!username || !password) {
      return { success: false, message: 'Invalid credentials' };
    }
    
    // Check if user exists
    const authData = this.authCache.get(username);
    if (!authData) {
      // Auto-register new miners (configurable behavior)
      return this.registerNewMiner(username, password);
    }
    
    // Verify password
    const hash = this.hashPassword(password);
    if (hash !== authData.hash) {
      return { success: false, message: 'Invalid password' };
    }
    
    // Generate miner ID with worker name
    const minerId = workerName ? `${username}.${workerName}` : username;
    
    return { success: true, minerId };
  }
  
  // Register new miner
  private async registerNewMiner(username: string, password: string): Promise<AuthResult> {
    // Validate username
    if (!this.isValidUsername(username)) {
      return { success: false, message: 'Invalid username format' };
    }
    
    // Check if Bitcoin address
    if (this.isValidBitcoinAddress(username)) {
      // Use address as both username and payout address
      const hash = this.hashPassword(password);
      this.authCache.set(username, { hash, address: username });
      
      return { success: true, minerId: username };
    }
    
    return { success: false, message: 'Registration requires valid Bitcoin address' };
  }
  
  // Validate username format
  private isValidUsername(username: string): boolean {
    // Allow alphanumeric, dots, dashes, underscores
    return /^[a-zA-Z0-9._-]+$/.test(username) && username.length <= 64;
  }
  
  // Basic Bitcoin address validation
  private isValidBitcoinAddress(address: string): boolean {
    // Simplified check - real implementation would validate checksum
    // P2PKH addresses (start with 1)
    if (/^1[a-zA-Z0-9]{25,34}$/.test(address)) return true;
    
    // P2SH addresses (start with 3)
    if (/^3[a-zA-Z0-9]{25,34}$/.test(address)) return true;
    
    // Bech32 addresses (start with bc1)
    if (/^bc1[a-z0-9]{39,59}$/.test(address)) return true;
    
    return false;
  }
  
  // Create session token
  createSession(minerId: string): string {
    const token = this.generateToken();
    this.sessionTokens.set(token, minerId);
    
    // Token expires after 24 hours
    setTimeout(() => {
      this.sessionTokens.delete(token);
    }, 86400000);
    
    return token;
  }
  
  // Validate session token
  validateSession(token: string): string | null {
    return this.sessionTokens.get(token) || null;
  }
  
  // Revoke session
  revokeSession(token: string): void {
    this.sessionTokens.delete(token);
  }
  
  // Get miner's payout address
  getPayoutAddress(minerId: string): string | null {
    // Remove worker suffix if present
    const username = minerId.split('.')[0];
    const authData = this.authCache.get(username);
    return authData?.address || null;
  }
}

// API key management for external access
export class ApiKeyManager {
  private apiKeys = new Map<string, {
    minerId: string;
    permissions: string[];
    rateLimit: number;
    created: number;
  }>();
  
  // Generate API key
  generateApiKey(minerId: string, permissions: string[] = ['read']): string {
    const key = crypto.randomBytes(32).toString('hex');
    
    this.apiKeys.set(key, {
      minerId,
      permissions,
      rateLimit: 1000, // requests per hour
      created: Date.now()
    });
    
    return key;
  }
  
  // Validate API key
  validateApiKey(key: string): {
    valid: boolean;
    minerId?: string;
    permissions?: string[];
  } {
    const data = this.apiKeys.get(key);
    
    if (!data) {
      return { valid: false };
    }
    
    return {
      valid: true,
      minerId: data.minerId,
      permissions: data.permissions
    };
  }
  
  // Check permission
  hasPermission(key: string, permission: string): boolean {
    const data = this.apiKeys.get(key);
    return data ? data.permissions.includes(permission) : false;
  }
  
  // Revoke API key
  revokeApiKey(key: string): void {
    this.apiKeys.delete(key);
  }
}
