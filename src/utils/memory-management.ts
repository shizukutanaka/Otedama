/**
 * メモリリーク対策実装
 * WeakMap/WeakSet活用と効果的なメモリ管理
 * 
 * 設計思想：
 * - Carmack: メモリ効率の最大化
 * - Martin: 明確なライフサイクル管理
 * - Pike: シンプルで予測可能なメモリ使用
 */

import { EventEmitter } from 'events';
import * as v8 from 'v8';
import * as os from 'os';

// === 型定義 ===
export interface MemoryStats {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  arrayBuffers: number;
  gcCount?: number;
  lastGC?: number;
}

export interface LeakDetectionConfig {
  checkInterval: number;      // メモリチェック間隔（ms）
  growthThreshold: number;    // 成長率閾値（%）
  sampleSize: number;         // サンプルサイズ
  gcBeforeCheck: boolean;     // チェック前のGC実行
}

export interface ResourceStats {
  activeConnections: number;
  activeTimers: number;
  activeHandles: number;
  eventListeners: number;
}

// === WeakMapベースのキャッシュ ===
export class WeakCache<K extends object, V> {
  private cache = new WeakMap<K, { value: V; expires?: number }>();
  private expirationMap = new Map<K, NodeJS.Timeout>();
  
  // 値の設定
  set(key: K, value: V, ttl?: number): void {
    // 既存のタイマーをクリア
    this.clearTimer(key);
    
    const entry = { value, expires: ttl ? Date.now() + ttl : undefined };
    this.cache.set(key, entry);
    
    // TTLが設定されている場合はタイマーを設定
    if (ttl) {
      const timer = setTimeout(() => {
        this.delete(key);
      }, ttl);
      
      this.expirationMap.set(key, timer);
    }
  }
  
  // 値の取得
  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    
    if (!entry) {
      return undefined;
    }
    
    // 有効期限チェック
    if (entry.expires && entry.expires < Date.now()) {
      this.delete(key);
      return undefined;
    }
    
    return entry.value;
  }
  
  // 値の削除
  delete(key: K): boolean {
    this.clearTimer(key);
    return this.cache.delete(key);
  }
  
  // 存在チェック
  has(key: K): boolean {
    const entry = this.cache.get(key);
    
    if (!entry) {
      return false;
    }
    
    if (entry.expires && entry.expires < Date.now()) {
      this.delete(key);
      return false;
    }
    
    return true;
  }
  
  // タイマーのクリア
  private clearTimer(key: K): void {
    const timer = this.expirationMap.get(key);
    if (timer) {
      clearTimeout(timer);
      this.expirationMap.delete(key);
    }
  }
  
  // すべてのタイマーをクリア
  destroy(): void {
    for (const timer of this.expirationMap.values()) {
      clearTimeout(timer);
    }
    this.expirationMap.clear();
  }
}

// === WeakSetベースのトラッカー ===
export class WeakResourceTracker<T extends object> {
  private resources = new WeakSet<T>();
  private metadata = new WeakMap<T, any>();
  
  // リソースの追加
  track(resource: T, metadata?: any): void {
    this.resources.add(resource);
    if (metadata) {
      this.metadata.set(resource, metadata);
    }
  }
  
  // リソースの削除
  untrack(resource: T): boolean {
    this.metadata.delete(resource);
    return this.resources.delete(resource);
  }
  
  // リソースの存在チェック
  has(resource: T): boolean {
    return this.resources.has(resource);
  }
  
  // メタデータの取得
  getMetadata(resource: T): any {
    return this.metadata.get(resource);
  }
}

// === メモリプール（オブジェクト再利用）===
export class ObjectPool<T> {
  private pool: T[] = [];
  private factory: () => T;
  private reset: (obj: T) => void;
  private maxSize: number;
  private created: number = 0;
  
  constructor(
    factory: () => T,
    reset: (obj: T) => void,
    maxSize: number = 1000
  ) {
    this.factory = factory;
    this.reset = reset;
    this.maxSize = maxSize;
  }
  
  // オブジェクトの取得
  acquire(): T {
    if (this.pool.length > 0) {
      return this.pool.pop()!;
    }
    
    this.created++;
    return this.factory();
  }
  
  // オブジェクトの返却
  release(obj: T): void {
    if (this.pool.length < this.maxSize) {
      this.reset(obj);
      this.pool.push(obj);
    }
  }
  
  // プールのクリア
  clear(): void {
    this.pool = [];
  }
  
  // 統計情報
  getStats() {
    return {
      poolSize: this.pool.length,
      created: this.created,
      available: this.pool.length,
      maxSize: this.maxSize
    };
  }
}

// === イベントリスナー管理 ===
export class SafeEventEmitter extends EventEmitter {
  private listenerMap = new Map<string | symbol, Set<Function>>();
  private maxListenersPerEvent: number = 10;
  
  // リスナーの追加（メモリリーク防止）
  on(event: string | symbol, listener: Function): this {
    const listeners = this.listenerMap.get(event) || new Set();
    
    // リスナー数制限チェック
    if (listeners.size >= this.maxListenersPerEvent) {
      console.warn(`Warning: Possible memory leak detected. ${listeners.size} listeners added for event "${String(event)}"`);
    }
    
    listeners.add(listener);
    this.listenerMap.set(event, listeners);
    
    return super.on(event, listener as any);
  }
  
  // リスナーの削除
  off(event: string | symbol, listener: Function): this {
    const listeners = this.listenerMap.get(event);
    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listenerMap.delete(event);
      }
    }
    
    return super.off(event, listener as any);
  }
  
  // すべてのリスナーを削除
  removeAllListeners(event?: string | symbol): this {
    if (event) {
      this.listenerMap.delete(event);
    } else {
      this.listenerMap.clear();
    }
    
    return super.removeAllListeners(event);
  }
  
  // リスナー数の取得
  getListenerCount(event?: string | symbol): number {
    if (event) {
      const listeners = this.listenerMap.get(event);
      return listeners ? listeners.size : 0;
    }
    
    let total = 0;
    for (const listeners of this.listenerMap.values()) {
      total += listeners.size;
    }
    return total;
  }
}

// === メモリリーク検出器 ===
export class MemoryLeakDetector extends EventEmitter {
  private config: LeakDetectionConfig;
  private samples: MemoryStats[] = [];
  private checkTimer?: NodeJS.Timeout;
  private gcCount: number = 0;
  
  constructor(config: Partial<LeakDetectionConfig> = {}) {
    super();
    this.config = {
      checkInterval: config.checkInterval || 60000,      // 1分
      growthThreshold: config.growthThreshold || 10,    // 10%
      sampleSize: config.sampleSize || 10,
      gcBeforeCheck: config.gcBeforeCheck ?? true
    };
  }
  
  // 監視開始
  start(): void {
    this.checkTimer = setInterval(() => {
      this.checkMemory();
    }, this.config.checkInterval);
    
    // 初期サンプル
    this.checkMemory();
  }
  
  // 監視停止
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
  }
  
  // メモリチェック
  private async checkMemory(): Promise<void> {
    // オプションでGCを実行
    if (this.config.gcBeforeCheck && global.gc) {
      global.gc();
      this.gcCount++;
      await this.delay(100); // GC完了待ち
    }
    
    // メモリ統計を取得
    const memoryUsage = process.memoryUsage();
    const stats: MemoryStats = {
      heapUsed: memoryUsage.heapUsed,
      heapTotal: memoryUsage.heapTotal,
      external: memoryUsage.external,
      rss: memoryUsage.rss,
      arrayBuffers: memoryUsage.arrayBuffers || 0,
      gcCount: this.gcCount,
      lastGC: Date.now()
    };
    
    this.samples.push(stats);
    
    // サンプルサイズを維持
    if (this.samples.length > this.config.sampleSize) {
      this.samples.shift();
    }
    
    // リーク検出
    if (this.samples.length >= this.config.sampleSize) {
      this.detectLeak();
    }
    
    this.emit('sample', stats);
  }
  
  // リーク検出ロジック
  private detectLeak(): void {
    const samples = this.samples;
    const firstSample = samples[0];
    const lastSample = samples[samples.length - 1];
    
    // ヒープ使用量の成長率を計算
    const heapGrowth = ((lastSample.heapUsed - firstSample.heapUsed) / firstSample.heapUsed) * 100;
    
    // 線形回帰で傾向を分析
    const trend = this.calculateTrend(samples.map(s => s.heapUsed));
    
    // リーク判定
    if (heapGrowth > this.config.growthThreshold && trend.slope > 0) {
      this.emit('leak', {
        growth: heapGrowth,
        trend: trend,
        firstSample,
        lastSample
      });
    }
  }
  
  // 傾向計算（線形回帰）
  private calculateTrend(values: number[]): { slope: number; intercept: number } {
    const n = values.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumX2 += i * i;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    return { slope, intercept };
  }
  
  // 遅延
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  // 現在の統計
  getCurrentStats(): MemoryStats | null {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1] : null;
  }
  
  // ヒープスナップショット
  takeHeapSnapshot(): string {
    const filename = `heap-${Date.now()}.heapsnapshot`;
    v8.writeHeapSnapshot(filename);
    return filename;
  }
}

// === リソースマネージャー ===
export class ResourceManager {
  private resources = new Map<string, { 
    resource: any; 
    cleanup: () => void;
    timeout?: NodeJS.Timeout;
  }>();
  
  // リソースの登録
  register(
    id: string, 
    resource: any, 
    cleanup: () => void,
    ttl?: number
  ): void {
    // 既存のリソースをクリーンアップ
    this.unregister(id);
    
    const entry = { resource, cleanup, timeout: undefined as any };
    
    // TTLが設定されている場合
    if (ttl) {
      entry.timeout = setTimeout(() => {
        this.unregister(id);
      }, ttl);
    }
    
    this.resources.set(id, entry);
  }
  
  // リソースの取得
  get(id: string): any {
    const entry = this.resources.get(id);
    return entry ? entry.resource : undefined;
  }
  
  // リソースの登録解除
  unregister(id: string): boolean {
    const entry = this.resources.get(id);
    
    if (!entry) {
      return false;
    }
    
    // タイマーのクリア
    if (entry.timeout) {
      clearTimeout(entry.timeout);
    }
    
    // クリーンアップ実行
    try {
      entry.cleanup();
    } catch (error) {
      console.error(`Error cleaning up resource ${id}:`, error);
    }
    
    return this.resources.delete(id);
  }
  
  // すべてのリソースをクリーンアップ
  cleanup(): void {
    for (const [id, entry] of this.resources) {
      if (entry.timeout) {
        clearTimeout(entry.timeout);
      }
      
      try {
        entry.cleanup();
      } catch (error) {
        console.error(`Error cleaning up resource ${id}:`, error);
      }
    }
    
    this.resources.clear();
  }
  
  // リソース統計
  getStats(): ResourceStats {
    let activeTimers = 0;
    let activeHandles = 0;
    
    for (const entry of this.resources.values()) {
      if (entry.timeout) activeTimers++;
      if (entry.resource && typeof entry.resource === 'object') {
        activeHandles++;
      }
    }
    
    return {
      activeConnections: this.resources.size,
      activeTimers,
      activeHandles,
      eventListeners: 0 // カウント方法は実装による
    };
  }
}

// === メモリ効率的なバッファプール ===
export class BufferPool {
  private pools = new Map<number, Buffer[]>();
  private maxPoolSize: number;
  private totalAllocated: number = 0;
  
  constructor(maxPoolSize: number = 100) {
    this.maxPoolSize = maxPoolSize;
  }
  
  // バッファの取得
  acquire(size: number): Buffer {
    const pool = this.pools.get(size);
    
    if (pool && pool.length > 0) {
      return pool.pop()!;
    }
    
    this.totalAllocated += size;
    return Buffer.allocUnsafe(size);
  }
  
  // バッファの返却
  release(buffer: Buffer): void {
    const size = buffer.length;
    let pool = this.pools.get(size);
    
    if (!pool) {
      pool = [];
      this.pools.set(size, pool);
    }
    
    if (pool.length < this.maxPoolSize) {
      // バッファをクリア
      buffer.fill(0);
      pool.push(buffer);
    }
  }
  
  // プールのクリア
  clear(): void {
    this.pools.clear();
    this.totalAllocated = 0;
  }
  
  // 統計情報
  getStats() {
    let totalBuffers = 0;
    let totalSize = 0;
    
    for (const [size, pool] of this.pools) {
      totalBuffers += pool.length;
      totalSize += size * pool.length;
    }
    
    return {
      pools: this.pools.size,
      totalBuffers,
      totalSize,
      totalAllocated: this.totalAllocated
    };
  }
}

// === 循環参照検出 ===
export class CircularReferenceDetector {
  // オブジェクトの循環参照をチェック
  static detect(obj: any, seen = new WeakSet()): boolean {
    if (obj === null || typeof obj !== 'object') {
      return false;
    }
    
    if (seen.has(obj)) {
      return true; // 循環参照を検出
    }
    
    seen.add(obj);
    
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        if (this.detect(obj[key], seen)) {
          return true;
        }
      }
    }
    
    return false;
  }
  
  // 循環参照を除去
  static cleanup(obj: any, seen = new WeakSet()): any {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    
    if (seen.has(obj)) {
      return '[Circular]';
    }
    
    seen.add(obj);
    
    const cleaned: any = Array.isArray(obj) ? [] : {};
    
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        cleaned[key] = this.cleanup(obj[key], seen);
      }
    }
    
    return cleaned;
  }
}

// エクスポート
export default {
  WeakCache,
  WeakResourceTracker,
  ObjectPool,
  SafeEventEmitter,
  MemoryLeakDetector,
  ResourceManager,
  BufferPool,
  CircularReferenceDetector
};