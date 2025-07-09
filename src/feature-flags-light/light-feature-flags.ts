/**
 * 軽量機能フラグ（Feature Flags）システム
 * 設計思想: Carmack (シンプル・高速), Martin (クリーン), Pike (明瞭・効率性)
 * 
 * 主要機能:
 * - 動的機能切り替え
 * - ユーザーセグメント対応
 * - A/Bテスト機能
 * - 段階的ロールアウト
 * - 条件ベースの機能制御
 * - 設定の永続化
 * - リアルタイム更新
 */

import { EventEmitter } from 'events';

// === 型定義 ===
interface FeatureFlag {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  rolloutPercentage: number; // 0-100
  conditions: FlagCondition[];
  variants: FlagVariant[];
  metadata: Record<string, any>;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  tags: string[];
}

interface FlagCondition {
  type: 'user_id' | 'user_group' | 'ip_address' | 'time_range' | 'custom';
  operator: 'equals' | 'contains' | 'starts_with' | 'in' | 'not_in' | 'gt' | 'lt' | 'between';
  value: any;
  negate?: boolean;
}

interface FlagVariant {
  key: string;
  name: string;
  weight: number; // 0-100, total should equal 100
  payload?: any;
}

interface EvaluationContext {
  userId?: string;
  userGroup?: string;
  ipAddress?: string;
  timestamp?: number;
  custom?: Record<string, any>;
}

interface EvaluationResult {
  enabled: boolean;
  variant?: string;
  payload?: any;
  reason: string;
}

interface FlagConfig {
  defaultEnabled: boolean;
  enableCache: boolean;
  cacheSize: number;
  cacheTtl: number;
  enableMetrics: boolean;
  enableAuditLog: boolean;
  storageBackend: 'memory' | 'file' | 'database';
  storageConfig?: any;
}

interface FlagMetrics {
  evaluations: number;
  enabledCount: number;
  disabledCount: number;
  variantCounts: Record<string, number>;
  lastEvaluated: number;
}

interface AuditLogEntry {
  timestamp: number;
  action: 'created' | 'updated' | 'deleted' | 'evaluated';
  flagKey: string;
  userId?: string;
  oldValue?: any;
  newValue?: any;
  context?: EvaluationContext;
  result?: EvaluationResult;
}

// === 軽量キャッシュ実装 ===
class FlagCache {
  private cache = new Map<string, { result: EvaluationResult; timestamp: number }>();
  private maxSize: number;
  private ttl: number;

  constructor(maxSize: number = 10000, ttl: number = 60000) {
    this.maxSize = maxSize;
    this.ttl = ttl;
    
    // 定期清掃
    setInterval(() => this.cleanup(), this.ttl);
  }

  set(key: string, result: EvaluationResult): void {
    // LRU実装
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, { result, timestamp: Date.now() });
  }

  get(key: string): EvaluationResult | null {
    const item = this.cache.get(key);
    if (!item) return null;
    
    // TTLチェック
    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return item.result;
  }

  invalidate(flagKey: string): void {
    // 指定フラグに関連するキャッシュを削除
    for (const [key] of this.cache) {
      if (key.startsWith(`${flagKey}:`)) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, item] of this.cache) {
      if (now - item.timestamp > this.ttl) {
        this.cache.delete(key);
      }
    }
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttl: this.ttl
    };
  }
}

// === 条件評価器 ===
class ConditionEvaluator {
  static evaluate(condition: FlagCondition, context: EvaluationContext): boolean {
    let result = false;
    
    switch (condition.type) {
      case 'user_id':
        result = this.evaluateUserCondition(condition, context.userId);
        break;
      case 'user_group':
        result = this.evaluateUserGroupCondition(condition, context.userGroup);
        break;
      case 'ip_address':
        result = this.evaluateIPCondition(condition, context.ipAddress);
        break;
      case 'time_range':
        result = this.evaluateTimeCondition(condition, context.timestamp || Date.now());
        break;
      case 'custom':
        result = this.evaluateCustomCondition(condition, context.custom);
        break;
      default:
        result = false;
    }
    
    return condition.negate ? !result : result;
  }

  private static evaluateUserCondition(condition: FlagCondition, userId?: string): boolean {
    if (!userId) return false;
    
    switch (condition.operator) {
      case 'equals':
        return userId === condition.value;
      case 'contains':
        return userId.includes(condition.value);
      case 'starts_with':
        return userId.startsWith(condition.value);
      case 'in':
        return Array.isArray(condition.value) && condition.value.includes(userId);
      case 'not_in':
        return Array.isArray(condition.value) && !condition.value.includes(userId);
      default:
        return false;
    }
  }

  private static evaluateUserGroupCondition(condition: FlagCondition, userGroup?: string): boolean {
    if (!userGroup) return false;
    
    switch (condition.operator) {
      case 'equals':
        return userGroup === condition.value;
      case 'in':
        return Array.isArray(condition.value) && condition.value.includes(userGroup);
      case 'not_in':
        return Array.isArray(condition.value) && !condition.value.includes(userGroup);
      default:
        return false;
    }
  }

  private static evaluateIPCondition(condition: FlagCondition, ipAddress?: string): boolean {
    if (!ipAddress) return false;
    
    switch (condition.operator) {
      case 'equals':
        return ipAddress === condition.value;
      case 'starts_with':
        return ipAddress.startsWith(condition.value);
      case 'in':
        return Array.isArray(condition.value) && condition.value.some(cidr => 
          this.isIPInRange(ipAddress, cidr)
        );
      default:
        return false;
    }
  }

  private static evaluateTimeCondition(condition: FlagCondition, timestamp: number): boolean {
    switch (condition.operator) {
      case 'gt':
        return timestamp > condition.value;
      case 'lt':
        return timestamp < condition.value;
      case 'between':
        return Array.isArray(condition.value) && 
               timestamp >= condition.value[0] && 
               timestamp <= condition.value[1];
      default:
        return false;
    }
  }

  private static evaluateCustomCondition(condition: FlagCondition, customData?: Record<string, any>): boolean {
    if (!customData || !condition.value.field) return false;
    
    const fieldValue = customData[condition.value.field];
    const expectedValue = condition.value.value;
    
    switch (condition.operator) {
      case 'equals':
        return fieldValue === expectedValue;
      case 'gt':
        return fieldValue > expectedValue;
      case 'lt':
        return fieldValue < expectedValue;
      case 'in':
        return Array.isArray(expectedValue) && expectedValue.includes(fieldValue);
      default:
        return false;
    }
  }

  private static isIPInRange(ip: string, cidr: string): boolean {
    // 簡易CIDR実装
    if (!cidr.includes('/')) {
      return ip === cidr;
    }
    
    const [network, bits] = cidr.split('/');
    const mask = parseInt(bits);
    
    // IPv4の簡易チェック
    const ipParts = ip.split('.').map(Number);
    const networkParts = network.split('.').map(Number);
    
    const bytesToCheck = Math.floor(mask / 8);
    const remainingBits = mask % 8;
    
    // 完全なバイトをチェック
    for (let i = 0; i < bytesToCheck; i++) {
      if (ipParts[i] !== networkParts[i]) {
        return false;
      }
    }
    
    // 残りのビットをチェック
    if (remainingBits > 0 && bytesToCheck < 4) {
      const ipByte = ipParts[bytesToCheck];
      const networkByte = networkParts[bytesToCheck];
      const maskByte = (0xFF << (8 - remainingBits)) & 0xFF;
      
      return (ipByte & maskByte) === (networkByte & maskByte);
    }
    
    return true;
  }
}

// === バリアント選択器 ===
class VariantSelector {
  static selectVariant(variants: FlagVariant[], context: EvaluationContext): FlagVariant | null {
    if (variants.length === 0) return null;
    if (variants.length === 1) return variants[0];
    
    // ユーザーIDベースの安定したハッシュを使用
    const hashInput = context.userId || context.ipAddress || Math.random().toString();
    const hash = this.simpleHash(hashInput);
    const percentage = hash % 100;
    
    let cumulativeWeight = 0;
    for (const variant of variants) {
      cumulativeWeight += variant.weight;
      if (percentage < cumulativeWeight) {
        return variant;
      }
    }
    
    // フォールバック（重みの合計が100未満の場合）
    return variants[0];
  }

  private static simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 32bit intに変換
    }
    return Math.abs(hash);
  }
}

// === ストレージバックエンド ===
abstract class FlagStorage {
  abstract save(flags: Map<string, FeatureFlag>): Promise<void>;
  abstract load(): Promise<Map<string, FeatureFlag>>;
}

class MemoryStorage extends FlagStorage {
  private data = new Map<string, FeatureFlag>();

  async save(flags: Map<string, FeatureFlag>): Promise<void> {
    this.data = new Map(flags);
  }

  async load(): Promise<Map<string, FeatureFlag>> {
    return new Map(this.data);
  }
}

class FileStorage extends FlagStorage {
  private filePath: string;

  constructor(filePath: string = './flags.json') {
    super();
    this.filePath = filePath;
  }

  async save(flags: Map<string, FeatureFlag>): Promise<void> {
    const fs = require('fs').promises;
    const data = Object.fromEntries(flags);
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));
  }

  async load(): Promise<Map<string, FeatureFlag>> {
    try {
      const fs = require('fs').promises;
      const data = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(data);
      return new Map(Object.entries(parsed));
    } catch (error) {
      return new Map();
    }
  }
}

// === メイン機能フラグマネージャー ===
class LightFeatureFlags extends EventEmitter {
  private config: FlagConfig;
  private flags = new Map<string, FeatureFlag>();
  private metrics = new Map<string, FlagMetrics>();
  private auditLog: AuditLogEntry[] = [];
  private cache: FlagCache;
  private storage: FlagStorage;
  private logger: any;

  constructor(config: Partial<FlagConfig> = {}, logger?: any) {
    super();
    
    this.config = {
      defaultEnabled: false,
      enableCache: true,
      cacheSize: 10000,
      cacheTtl: 60000,
      enableMetrics: true,
      enableAuditLog: true,
      storageBackend: 'memory',
      ...config
    };

    this.cache = new FlagCache(this.config.cacheSize, this.config.cacheTtl);
    this.storage = this.createStorage();
    
    this.logger = logger || {
      info: (msg: string, data?: any) => console.log(`[FLAGS] ${msg}`, data || ''),
      error: (msg: string, err?: any) => console.error(`[FLAGS] ${msg}`, err || ''),
      warn: (msg: string, data?: any) => console.warn(`[FLAGS] ${msg}`, data || '')
    };
  }

  private createStorage(): FlagStorage {
    switch (this.config.storageBackend) {
      case 'file':
        return new FileStorage(this.config.storageConfig?.filePath);
      case 'memory':
      default:
        return new MemoryStorage();
    }
  }

  async initialize(): Promise<void> {
    try {
      const loadedFlags = await this.storage.load();
      this.flags = loadedFlags;
      
      this.logger.info('Feature flags initialized', {
        count: this.flags.size,
        backend: this.config.storageBackend
      });
      
      this.emit('initialized', { count: this.flags.size });
    } catch (error) {
      this.logger.error('Failed to initialize feature flags', error);
      throw error;
    }
  }

  createFlag(options: {
    key: string;
    name: string;
    description: string;
    enabled?: boolean;
    rolloutPercentage?: number;
    conditions?: FlagCondition[];
    variants?: FlagVariant[];
    metadata?: Record<string, any>;
    createdBy: string;
    tags?: string[];
  }): FeatureFlag {
    
    if (this.flags.has(options.key)) {
      throw new Error(`Flag with key '${options.key}' already exists`);
    }

    const flag: FeatureFlag = {
      key: options.key,
      name: options.name,
      description: options.description,
      enabled: options.enabled ?? this.config.defaultEnabled,
      rolloutPercentage: options.rolloutPercentage ?? 100,
      conditions: options.conditions || [],
      variants: options.variants || [],
      metadata: options.metadata || {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: options.createdBy,
      tags: options.tags || []
    };

    this.flags.set(options.key, flag);
    this.initializeMetrics(options.key);
    
    this.logAudit({
      timestamp: Date.now(),
      action: 'created',
      flagKey: options.key,
      userId: options.createdBy,
      newValue: flag
    });

    this.cache.invalidate(options.key);
    this.persistFlags();
    
    this.logger.info(`Feature flag created: ${options.key}`);
    this.emit('flagCreated', flag);
    
    return flag;
  }

  updateFlag(key: string, updates: Partial<FeatureFlag>, updatedBy: string): FeatureFlag {
    const flag = this.flags.get(key);
    if (!flag) {
      throw new Error(`Flag with key '${key}' not found`);
    }

    const oldValue = { ...flag };
    const updatedFlag = {
      ...flag,
      ...updates,
      updatedAt: Date.now()
    };

    this.flags.set(key, updatedFlag);
    
    this.logAudit({
      timestamp: Date.now(),
      action: 'updated',
      flagKey: key,
      userId: updatedBy,
      oldValue,
      newValue: updatedFlag
    });

    this.cache.invalidate(key);
    this.persistFlags();
    
    this.logger.info(`Feature flag updated: ${key}`);
    this.emit('flagUpdated', { flag: updatedFlag, oldValue });
    
    return updatedFlag;
  }

  deleteFlag(key: string, deletedBy: string): boolean {
    const flag = this.flags.get(key);
    if (!flag) {
      return false;
    }

    this.flags.delete(key);
    this.metrics.delete(key);
    
    this.logAudit({
      timestamp: Date.now(),
      action: 'deleted',
      flagKey: key,
      userId: deletedBy,
      oldValue: flag
    });

    this.cache.invalidate(key);
    this.persistFlags();
    
    this.logger.info(`Feature flag deleted: ${key}`);
    this.emit('flagDeleted', flag);
    
    return true;
  }

  isEnabled(key: string, context: EvaluationContext = {}): boolean {
    const result = this.evaluate(key, context);
    return result.enabled;
  }

  getVariant(key: string, context: EvaluationContext = {}): string | null {
    const result = this.evaluate(key, context);
    return result.variant || null;
  }

  getPayload(key: string, context: EvaluationContext = {}): any {
    const result = this.evaluate(key, context);
    return result.payload;
  }

  evaluate(key: string, context: EvaluationContext = {}): EvaluationResult {
    // キャッシュチェック
    if (this.config.enableCache) {
      const cacheKey = this.generateCacheKey(key, context);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.updateMetrics(key, cached);
        return cached;
      }
    }

    const flag = this.flags.get(key);
    if (!flag) {
      const result: EvaluationResult = {
        enabled: this.config.defaultEnabled,
        reason: 'flag_not_found'
      };
      
      this.updateMetrics(key, result);
      return result;
    }

    // フラグが無効の場合
    if (!flag.enabled) {
      const result: EvaluationResult = {
        enabled: false,
        reason: 'flag_disabled'
      };
      
      this.cacheResult(key, context, result);
      this.updateMetrics(key, result);
      return result;
    }

    // 条件評価
    if (flag.conditions.length > 0) {
      const conditionsMet = flag.conditions.every(condition => 
        ConditionEvaluator.evaluate(condition, context)
      );
      
      if (!conditionsMet) {
        const result: EvaluationResult = {
          enabled: false,
          reason: 'conditions_not_met'
        };
        
        this.cacheResult(key, context, result);
        this.updateMetrics(key, result);
        return result;
      }
    }

    // ロールアウト率チェック
    if (flag.rolloutPercentage < 100) {
      const hashInput = context.userId || context.ipAddress || 'anonymous';
      const hash = this.simpleHash(`${key}:${hashInput}`);
      const percentage = hash % 100;
      
      if (percentage >= flag.rolloutPercentage) {
        const result: EvaluationResult = {
          enabled: false,
          reason: 'rollout_percentage'
        };
        
        this.cacheResult(key, context, result);
        this.updateMetrics(key, result);
        return result;
      }
    }

    // バリアント選択
    let variant: FlagVariant | null = null;
    if (flag.variants.length > 0) {
      variant = VariantSelector.selectVariant(flag.variants, context);
    }

    const result: EvaluationResult = {
      enabled: true,
      variant: variant?.key,
      payload: variant?.payload,
      reason: 'enabled'
    };

    this.cacheResult(key, context, result);
    this.updateMetrics(key, result);
    this.logEvaluation(key, context, result);
    
    return result;
  }

  private generateCacheKey(flagKey: string, context: EvaluationContext): string {
    const contextHash = this.simpleHash(JSON.stringify(context));
    return `${flagKey}:${contextHash}`;
  }

  private cacheResult(flagKey: string, context: EvaluationContext, result: EvaluationResult): void {
    if (this.config.enableCache) {
      const cacheKey = this.generateCacheKey(flagKey, context);
      this.cache.set(cacheKey, result);
    }
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  private initializeMetrics(flagKey: string): void {
    if (this.config.enableMetrics) {
      this.metrics.set(flagKey, {
        evaluations: 0,
        enabledCount: 0,
        disabledCount: 0,
        variantCounts: {},
        lastEvaluated: 0
      });
    }
  }

  private updateMetrics(flagKey: string, result: EvaluationResult): void {
    if (!this.config.enableMetrics) return;

    let metrics = this.metrics.get(flagKey);
    if (!metrics) {
      this.initializeMetrics(flagKey);
      metrics = this.metrics.get(flagKey)!;
    }

    metrics.evaluations++;
    metrics.lastEvaluated = Date.now();

    if (result.enabled) {
      metrics.enabledCount++;
    } else {
      metrics.disabledCount++;
    }

    if (result.variant) {
      metrics.variantCounts[result.variant] = (metrics.variantCounts[result.variant] || 0) + 1;
    }
  }

  private logAudit(entry: AuditLogEntry): void {
    if (!this.config.enableAuditLog) return;

    this.auditLog.push(entry);
    
    // ログサイズ制限（最新1000件）
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }

    this.emit('audit', entry);
  }

  private logEvaluation(flagKey: string, context: EvaluationContext, result: EvaluationResult): void {
    this.logAudit({
      timestamp: Date.now(),
      action: 'evaluated',
      flagKey,
      context,
      result
    });
  }

  private async persistFlags(): Promise<void> {
    try {
      await this.storage.save(this.flags);
    } catch (error) {
      this.logger.error('Failed to persist flags', error);
    }
  }

  // 管理用メソッド
  getAllFlags(): FeatureFlag[] {
    return Array.from(this.flags.values());
  }

  getFlag(key: string): FeatureFlag | null {
    return this.flags.get(key) || null;
  }

  getFlagsByTag(tag: string): FeatureFlag[] {
    return Array.from(this.flags.values())
      .filter(flag => flag.tags.includes(tag));
  }

  getMetrics(flagKey?: string): FlagMetrics | Map<string, FlagMetrics> {
    if (flagKey) {
      return this.metrics.get(flagKey) || {
        evaluations: 0,
        enabledCount: 0,
        disabledCount: 0,
        variantCounts: {},
        lastEvaluated: 0
      };
    }
    return new Map(this.metrics);
  }

  getAuditLog(flagKey?: string, limit: number = 100): AuditLogEntry[] {
    let logs = flagKey 
      ? this.auditLog.filter(entry => entry.flagKey === flagKey)
      : this.auditLog;
    
    return logs.slice(-limit);
  }

  // ユーティリティメソッド
  bulkUpdate(updates: Array<{ key: string; updates: Partial<FeatureFlag> }>, updatedBy: string): void {
    for (const { key, updates } of updates) {
      try {
        this.updateFlag(key, updates, updatedBy);
      } catch (error) {
        this.logger.error(`Failed to update flag ${key}`, error);
      }
    }
  }

  enableFlag(key: string, updatedBy: string): FeatureFlag {
    return this.updateFlag(key, { enabled: true }, updatedBy);
  }

  disableFlag(key: string, updatedBy: string): FeatureFlag {
    return this.updateFlag(key, { enabled: false }, updatedBy);
  }

  setRolloutPercentage(key: string, percentage: number, updatedBy: string): FeatureFlag {
    if (percentage < 0 || percentage > 100) {
      throw new Error('Rollout percentage must be between 0 and 100');
    }
    return this.updateFlag(key, { rolloutPercentage: percentage }, updatedBy);
  }

  // Express.jsミドルウェア
  createMiddleware() {
    return (req: any, res: any, next: any) => {
      const context: EvaluationContext = {
        userId: req.user?.id || req.headers['x-user-id'],
        userGroup: req.user?.group || req.headers['x-user-group'],
        ipAddress: req.ip || req.connection.remoteAddress,
        timestamp: Date.now(),
        custom: req.featureFlagContext || {}
      };

      req.featureFlags = {
        isEnabled: (key: string, customContext?: Partial<EvaluationContext>) => {
          return this.isEnabled(key, { ...context, ...customContext });
        },
        getVariant: (key: string, customContext?: Partial<EvaluationContext>) => {
          return this.getVariant(key, { ...context, ...customContext });
        },
        getPayload: (key: string, customContext?: Partial<EvaluationContext>) => {
          return this.getPayload(key, { ...context, ...customContext });
        },
        evaluate: (key: string, customContext?: Partial<EvaluationContext>) => {
          return this.evaluate(key, { ...context, ...customContext });
        }
      };

      next();
    };
  }

  getStats() {
    const allFlags = this.getAllFlags();
    const enabledFlags = allFlags.filter(f => f.enabled);
    const totalEvaluations = Array.from(this.metrics.values())
      .reduce((sum, m) => sum + m.evaluations, 0);

    return {
      totalFlags: allFlags.length,
      enabledFlags: enabledFlags.length,
      disabledFlags: allFlags.length - enabledFlags.length,
      totalEvaluations,
      cacheStats: this.cache.getStats(),
      auditLogSize: this.auditLog.length,
      config: {
        enableCache: this.config.enableCache,
        enableMetrics: this.config.enableMetrics,
        enableAuditLog: this.config.enableAuditLog,
        storageBackend: this.config.storageBackend
      }
    };
  }
}

export {
  LightFeatureFlags,
  FeatureFlag,
  FlagCondition,
  FlagVariant,
  EvaluationContext,
  EvaluationResult,
  FlagConfig,
  FlagMetrics,
  AuditLogEntry,
  ConditionEvaluator,
  VariantSelector
};