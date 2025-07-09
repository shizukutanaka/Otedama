/**
 * 軽量APIキー管理システム
 * 設計思想: Carmack (シンプル・高速), Martin (クリーン), Pike (明瞭・効率性)
 * 
 * 主要機能:
 * - セキュアなAPIキー生成
 * - 権限ベースのアクセス制御
 * - レート制限
 * - キーローテーション
 * - 使用統計
 * - キー無効化
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';

// === 型定義 ===
interface APIKeyData {
  id: string;
  name: string;
  keyHash: string;
  prefix: string;
  userId: string;
  permissions: Permission[];
  rateLimits: RateLimit[];
  metadata: Record<string, any>;
  status: 'active' | 'inactive' | 'revoked';
  createdAt: number;
  lastUsed?: number;
  expiresAt?: number;
  usageCount: number;
}

interface Permission {
  resource: string;
  actions: string[];
  constraints?: PermissionConstraint[];
}

interface PermissionConstraint {
  type: 'ip' | 'time' | 'rate' | 'custom';
  value: any;
}

interface RateLimit {
  window: number; // milliseconds
  maxRequests: number;
  scope: 'global' | 'per_endpoint' | 'per_resource';
}

interface APIKeyConfig {
  keyLength: number;
  prefixLength: number;
  hashAlgorithm: string;
  defaultRateLimit: RateLimit;
  maxKeysPerUser: number;
  defaultExpirationDays: number;
  allowedPermissions: string[];
}

interface UsageRecord {
  keyId: string;
  timestamp: number;
  endpoint: string;
  method: string;
  statusCode: number;
  responseTime: number;
  ip?: string;
  userAgent?: string;
  bytesTransferred?: number;
}

interface ValidationResult {
  valid: boolean;
  keyData?: APIKeyData;
  error?: string;
  rateLimitHit?: boolean;
}

// === APIキー生成器 ===
class APIKeyGenerator {
  private static readonly CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  
  static generate(length: number = 64, prefix: string = 'otd'): { key: string; hash: string; prefix: string } {
    // セキュアなランダムキー生成
    const randomBytes = crypto.randomBytes(Math.ceil(length * 3 / 4));
    let key = '';
    
    for (let i = 0; i < length; i++) {
      key += this.CHARSET.charAt(randomBytes[i % randomBytes.length] % this.CHARSET.length);
    }
    
    const fullKey = `${prefix}_${key}`;
    const hash = this.hashKey(fullKey);
    
    return {
      key: fullKey,
      hash,
      prefix
    };
  }
  
  static hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }
  
  static verifyKey(key: string, hash: string): boolean {
    return this.hashKey(key) === hash;
  }
  
  static extractPrefix(key: string): string {
    const parts = key.split('_');
    return parts.length > 1 ? parts[0] : '';
  }
}

// === 権限チェッカー ===
class PermissionChecker {
  static hasPermission(keyData: APIKeyData, resource: string, action: string): boolean {
    return keyData.permissions.some(permission => {
      const resourceMatch = this.matchesResource(permission.resource, resource);
      const actionMatch = permission.actions.includes('*') || permission.actions.includes(action);
      return resourceMatch && actionMatch;
    });
  }
  
  private static matchesResource(permissionResource: string, requestedResource: string): boolean {
    // ワイルドカード対応
    if (permissionResource === '*') return true;
    if (permissionResource.endsWith('*')) {
      const prefix = permissionResource.slice(0, -1);
      return requestedResource.startsWith(prefix);
    }
    return permissionResource === requestedResource;
  }
  
  static checkConstraints(keyData: APIKeyData, context: any): boolean {
    for (const permission of keyData.permissions) {
      if (!permission.constraints) continue;
      
      for (const constraint of permission.constraints) {
        if (!this.evaluateConstraint(constraint, context)) {
          return false;
        }
      }
    }
    return true;
  }
  
  private static evaluateConstraint(constraint: PermissionConstraint, context: any): boolean {
    switch (constraint.type) {
      case 'ip':
        return this.checkIPConstraint(constraint.value, context.ip);
      case 'time':
        return this.checkTimeConstraint(constraint.value, Date.now());
      case 'rate':
        return this.checkRateConstraint(constraint.value, context);
      default:
        return true;
    }
  }
  
  private static checkIPConstraint(allowedIPs: string[], requestIP: string): boolean {
    if (!requestIP) return false;
    return allowedIPs.some(ip => {
      if (ip.includes('/')) {
        // CIDR形式の場合（簡易実装）
        return this.isIPInCIDR(requestIP, ip);
      }
      return ip === requestIP;
    });
  }
  
  private static isIPInCIDR(ip: string, cidr: string): boolean {
    // 簡易CIDR実装（本格実装では専用ライブラリを推奨）
    const [network, bits] = cidr.split('/');
    const mask = parseInt(bits);
    // IPv4の簡易チェック
    return ip.startsWith(network.split('.').slice(0, Math.floor(mask / 8)).join('.'));
  }
  
  private static checkTimeConstraint(timeWindow: { start: number; end: number }, currentTime: number): boolean {
    return currentTime >= timeWindow.start && currentTime <= timeWindow.end;
  }
  
  private static checkRateConstraint(rateConfig: any, context: any): boolean {
    // レート制限の詳細チェック（実装は後述のRateLimiterに委譲）
    return true;
  }
}

// === レート制限器 ===
class APIRateLimiter {
  private usage = new Map<string, Array<{ timestamp: number; count: number }>>();
  
  checkLimit(keyId: string, rateLimit: RateLimit): boolean {
    const now = Date.now();
    const windowStart = now - rateLimit.window;
    
    // 古いレコードを削除
    const keyUsage = this.usage.get(keyId) || [];
    const recentUsage = keyUsage.filter(record => record.timestamp > windowStart);
    
    // 使用量を計算
    const totalRequests = recentUsage.reduce((sum, record) => sum + record.count, 0);
    
    if (totalRequests >= rateLimit.maxRequests) {
      return false;
    }
    
    // 新しい使用記録を追加
    recentUsage.push({ timestamp: now, count: 1 });
    this.usage.set(keyId, recentUsage);
    
    return true;
  }
  
  getRemainingRequests(keyId: string, rateLimit: RateLimit): number {
    const now = Date.now();
    const windowStart = now - rateLimit.window;
    
    const keyUsage = this.usage.get(keyId) || [];
    const recentUsage = keyUsage.filter(record => record.timestamp > windowStart);
    const totalRequests = recentUsage.reduce((sum, record) => sum + record.count, 0);
    
    return Math.max(0, rateLimit.maxRequests - totalRequests);
  }
  
  getResetTime(keyId: string, rateLimit: RateLimit): number {
    const keyUsage = this.usage.get(keyId) || [];
    if (keyUsage.length === 0) return 0;
    
    const oldestRequest = keyUsage[0];
    return oldestRequest.timestamp + rateLimit.window;
  }
  
  clear(): void {
    this.usage.clear();
  }
}

// === 使用統計収集器 ===
class UsageCollector {
  private records: UsageRecord[] = [];
  private maxRecords: number;
  
  constructor(maxRecords: number = 100000) {
    this.maxRecords = maxRecords;
  }
  
  record(usage: UsageRecord): void {
    this.records.push(usage);
    
    // 古いレコードを削除
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }
  
  getUsageStats(keyId: string, timeWindow?: number): any {
    const now = Date.now();
    const windowStart = timeWindow ? now - timeWindow : 0;
    
    const keyRecords = this.records.filter(record => 
      record.keyId === keyId && record.timestamp >= windowStart
    );
    
    if (keyRecords.length === 0) {
      return {
        totalRequests: 0,
        averageResponseTime: 0,
        errorRate: 0,
        bytesTransferred: 0
      };
    }
    
    const totalRequests = keyRecords.length;
    const errorCount = keyRecords.filter(record => record.statusCode >= 400).length;
    const totalResponseTime = keyRecords.reduce((sum, record) => sum + record.responseTime, 0);
    const totalBytes = keyRecords.reduce((sum, record) => sum + (record.bytesTransferred || 0), 0);
    
    return {
      totalRequests,
      errorCount,
      errorRate: (errorCount / totalRequests) * 100,
      averageResponseTime: totalResponseTime / totalRequests,
      bytesTransferred: totalBytes,
      uniqueEndpoints: new Set(keyRecords.map(r => r.endpoint)).size,
      timeRange: {
        start: Math.min(...keyRecords.map(r => r.timestamp)),
        end: Math.max(...keyRecords.map(r => r.timestamp))
      }
    };
  }
  
  getTopEndpoints(keyId: string, limit: number = 10): Array<{ endpoint: string; count: number }> {
    const keyRecords = this.records.filter(record => record.keyId === keyId);
    const endpointCounts = new Map<string, number>();
    
    for (const record of keyRecords) {
      const current = endpointCounts.get(record.endpoint) || 0;
      endpointCounts.set(record.endpoint, current + 1);
    }
    
    return Array.from(endpointCounts.entries())
      .map(([endpoint, count]) => ({ endpoint, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }
}

// === メインAPIキー管理クラス ===
class LightAPIKeyManager extends EventEmitter {
  private config: APIKeyConfig;
  private keys = new Map<string, APIKeyData>();
  private rateLimiter = new APIRateLimiter();
  private usageCollector = new UsageCollector();
  private logger: any;
  
  constructor(config: Partial<APIKeyConfig> = {}, logger?: any) {
    super();
    
    this.config = {
      keyLength: 64,
      prefixLength: 3,
      hashAlgorithm: 'sha256',
      defaultRateLimit: {
        window: 60 * 1000, // 1分
        maxRequests: 100,
        scope: 'global'
      },
      maxKeysPerUser: 10,
      defaultExpirationDays: 365,
      allowedPermissions: [
        'pool:read', 'pool:write',
        'miners:read', 'miners:write',
        'stats:read', 'blocks:read',
        'payouts:read', 'payouts:write'
      ],
      ...config
    };
    
    this.logger = logger || {
      info: (msg: string, data?: any) => console.log(`[API-KEY] ${msg}`, data || ''),
      error: (msg: string, err?: any) => console.error(`[API-KEY] ${msg}`, err || ''),
      warn: (msg: string, data?: any) => console.warn(`[API-KEY] ${msg}`, data || '')
    };
  }
  
  async createAPIKey(options: {
    userId: string;
    name: string;
    permissions: Permission[];
    rateLimits?: RateLimit[];
    expirationDays?: number;
    metadata?: Record<string, any>;
  }): Promise<{ key: string; keyData: APIKeyData }> {
    
    // ユーザーのキー数制限チェック
    const userKeys = Array.from(this.keys.values()).filter(k => k.userId === options.userId);
    if (userKeys.length >= this.config.maxKeysPerUser) {
      throw new Error(`User has reached maximum number of API keys (${this.config.maxKeysPerUser})`);
    }
    
    // 権限の妥当性チェック
    for (const permission of options.permissions) {
      for (const action of permission.actions) {
        if (action !== '*' && !this.config.allowedPermissions.some(p => p.includes(action))) {
          throw new Error(`Invalid permission action: ${action}`);
        }
      }
    }
    
    // キー生成
    const { key, hash, prefix } = APIKeyGenerator.generate(this.config.keyLength);
    const keyId = crypto.randomBytes(16).toString('hex');
    
    const expirationDays = options.expirationDays || this.config.defaultExpirationDays;
    const expiresAt = expirationDays > 0 
      ? Date.now() + (expirationDays * 24 * 60 * 60 * 1000)
      : undefined;
    
    const keyData: APIKeyData = {
      id: keyId,
      name: options.name,
      keyHash: hash,
      prefix,
      userId: options.userId,
      permissions: options.permissions,
      rateLimits: options.rateLimits || [this.config.defaultRateLimit],
      metadata: options.metadata || {},
      status: 'active',
      createdAt: Date.now(),
      expiresAt,
      usageCount: 0
    };
    
    this.keys.set(keyId, keyData);
    
    this.logger.info(`API key created for user ${options.userId}`, {
      keyId,
      name: options.name,
      permissions: options.permissions.length
    });
    
    this.emit('keyCreated', { keyId, userId: options.userId, name: options.name });
    
    return { key, keyData: this.sanitizeKeyData(keyData) };
  }
  
  async validateAPIKey(key: string, context: {
    resource?: string;
    action?: string;
    ip?: string;
    endpoint?: string;
  } = {}): Promise<ValidationResult> {
    
    try {
      // キーの形式チェック
      if (!key || !key.includes('_')) {
        return { valid: false, error: 'Invalid key format' };
      }
      
      // キーハッシュ化して検索
      const keyHash = APIKeyGenerator.hashKey(key);
      const keyData = Array.from(this.keys.values()).find(k => k.keyHash === keyHash);
      
      if (!keyData) {
        return { valid: false, error: 'Key not found' };
      }
      
      // ステータスチェック
      if (keyData.status !== 'active') {
        return { valid: false, error: `Key is ${keyData.status}` };
      }
      
      // 有効期限チェック
      if (keyData.expiresAt && Date.now() > keyData.expiresAt) {
        keyData.status = 'inactive';
        return { valid: false, error: 'Key expired' };
      }
      
      // 権限チェック
      if (context.resource && context.action) {
        if (!PermissionChecker.hasPermission(keyData, context.resource, context.action)) {
          return { valid: false, error: 'Insufficient permissions' };
        }
      }
      
      // 制約チェック
      if (!PermissionChecker.checkConstraints(keyData, context)) {
        return { valid: false, error: 'Constraint violation' };
      }
      
      // レート制限チェック
      for (const rateLimit of keyData.rateLimits) {
        if (!this.rateLimiter.checkLimit(keyData.id, rateLimit)) {
          return { valid: false, error: 'Rate limit exceeded', rateLimitHit: true };
        }
      }
      
      // 使用統計更新
      keyData.lastUsed = Date.now();
      keyData.usageCount++;
      
      this.emit('keyUsed', { keyId: keyData.id, userId: keyData.userId, context });
      
      return { valid: true, keyData: this.sanitizeKeyData(keyData) };
      
    } catch (error) {
      this.logger.error('Error validating API key', error);
      return { valid: false, error: 'Validation error' };
    }
  }
  
  recordUsage(keyId: string, usage: Omit<UsageRecord, 'keyId'>): void {
    this.usageCollector.record({
      keyId,
      ...usage
    });
  }
  
  revokeAPIKey(keyId: string, userId?: string): boolean {
    const keyData = this.keys.get(keyId);
    if (!keyData) return false;
    
    // ユーザー確認（セキュリティ）
    if (userId && keyData.userId !== userId) {
      return false;
    }
    
    keyData.status = 'revoked';
    
    this.logger.info(`API key revoked: ${keyId}`);
    this.emit('keyRevoked', { keyId, userId: keyData.userId });
    
    return true;
  }
  
  rotateAPIKey(keyId: string, userId?: string): { key: string; keyData: APIKeyData } | null {
    const oldKeyData = this.keys.get(keyId);
    if (!oldKeyData) return null;
    
    // ユーザー確認
    if (userId && oldKeyData.userId !== userId) {
      return null;
    }
    
    // 新しいキー生成
    const { key, hash } = APIKeyGenerator.generate(this.config.keyLength);
    
    // キーデータ更新
    oldKeyData.keyHash = hash;
    oldKeyData.usageCount = 0;
    oldKeyData.lastUsed = undefined;
    
    this.logger.info(`API key rotated: ${keyId}`);
    this.emit('keyRotated', { keyId, userId: oldKeyData.userId });
    
    return { key, keyData: this.sanitizeKeyData(oldKeyData) };
  }
  
  getUserKeys(userId: string): APIKeyData[] {
    return Array.from(this.keys.values())
      .filter(keyData => keyData.userId === userId)
      .map(keyData => this.sanitizeKeyData(keyData));
  }
  
  getKeyUsageStats(keyId: string, timeWindow?: number): any {
    return this.usageCollector.getUsageStats(keyId, timeWindow);
  }
  
  updateKeyMetadata(keyId: string, metadata: Record<string, any>, userId?: string): boolean {
    const keyData = this.keys.get(keyId);
    if (!keyData) return false;
    
    if (userId && keyData.userId !== userId) {
      return false;
    }
    
    keyData.metadata = { ...keyData.metadata, ...metadata };
    
    this.emit('keyUpdated', { keyId, userId: keyData.userId, changes: metadata });
    
    return true;
  }
  
  createMiddleware(options: { 
    extractKey?: (req: any) => string;
    onError?: (error: any, req: any, res: any) => void;
  } = {}) {
    return async (req: any, res: any, next: any) => {
      try {
        // APIキー抽出
        const apiKey = options.extractKey ? 
          options.extractKey(req) : 
          (req.headers['x-api-key'] || req.query.api_key);
        
        if (!apiKey) {
          return res.status(401).json({ error: 'API key required' });
        }
        
        // バリデーション
        const validation = await this.validateAPIKey(apiKey, {
          resource: req.route?.path,
          action: req.method.toLowerCase(),
          ip: req.ip || req.connection.remoteAddress,
          endpoint: req.path
        });
        
        if (!validation.valid) {
          const statusCode = validation.rateLimitHit ? 429 : 403;
          return res.status(statusCode).json({ error: validation.error });
        }
        
        // リクエストにキーデータを追加
        req.apiKey = validation.keyData;
        
        // レスポンス終了時に使用統計を記録
        const startTime = Date.now();
        const originalEnd = res.end;
        
        res.end = function(...args: any[]) {
          const responseTime = Date.now() - startTime;
          
          // 使用統計記録
          if (validation.keyData) {
            res.locals.apiKeyManager?.recordUsage(validation.keyData.id, {
              timestamp: startTime,
              endpoint: req.path,
              method: req.method,
              statusCode: res.statusCode,
              responseTime,
              ip: req.ip,
              userAgent: req.headers['user-agent']
            });
          }
          
          originalEnd.apply(res, args);
        };
        
        res.locals.apiKeyManager = this;
        next();
        
      } catch (error) {
        if (options.onError) {
          options.onError(error, req, res);
        } else {
          this.logger.error('API key middleware error', error);
          res.status(500).json({ error: 'Internal server error' });
        }
      }
    };
  }
  
  private sanitizeKeyData(keyData: APIKeyData): APIKeyData {
    // センシティブ情報を除外
    const sanitized = { ...keyData };
    delete (sanitized as any).keyHash;
    return sanitized;
  }
  
  cleanup(): void {
    // 期限切れキーを無効化
    const now = Date.now();
    let expiredCount = 0;
    
    for (const keyData of this.keys.values()) {
      if (keyData.expiresAt && now > keyData.expiresAt && keyData.status === 'active') {
        keyData.status = 'inactive';
        expiredCount++;
      }
    }
    
    if (expiredCount > 0) {
      this.logger.info(`Expired ${expiredCount} API keys`);
    }
    
    // 古いレート制限データをクリア
    this.rateLimiter.clear();
  }
  
  getStats() {
    const allKeys = Array.from(this.keys.values());
    const activeKeys = allKeys.filter(k => k.status === 'active');
    const expiredKeys = allKeys.filter(k => k.expiresAt && Date.now() > k.expiresAt);
    
    const userCounts = new Map<string, number>();
    for (const key of allKeys) {
      userCounts.set(key.userId, (userCounts.get(key.userId) || 0) + 1);
    }
    
    return {
      totalKeys: allKeys.length,
      activeKeys: activeKeys.length,
      inactiveKeys: allKeys.filter(k => k.status === 'inactive').length,
      revokedKeys: allKeys.filter(k => k.status === 'revoked').length,
      expiredKeys: expiredKeys.length,
      totalUsers: userCounts.size,
      averageKeysPerUser: allKeys.length / Math.max(userCounts.size, 1),
      mostActiveUser: Array.from(userCounts.entries())
        .sort((a, b) => b[1] - a[1])[0]?.[0],
      config: {
        maxKeysPerUser: this.config.maxKeysPerUser,
        defaultRateLimit: this.config.defaultRateLimit,
        allowedPermissions: this.config.allowedPermissions
      }
    };
  }
}

export {
  LightAPIKeyManager,
  APIKeyData,
  Permission,
  RateLimit,
  APIKeyConfig,
  ValidationResult,
  UsageRecord,
  APIKeyGenerator,
  PermissionChecker
};