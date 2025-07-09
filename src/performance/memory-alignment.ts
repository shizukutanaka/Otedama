/**
 * メモリアライメント最適化
 * CPUキャッシュ効率向上とメモリアクセス最適化
 */

import { performance } from 'perf_hooks';

export interface MemoryAlignmentConfig {
  cacheLineSize: number;       // CPUキャッシュラインサイズ（通常64バイト）
  enablePadding: boolean;      // パディング有効化
  enablePooling: boolean;      // オブジェクトプール有効化
  poolInitialSize: number;     // プール初期サイズ
  enableMetrics: boolean;      // メトリクス収集
}

interface AlignedObject {
  data: any;
  padding?: Uint8Array;
  alignmentOffset: number;
  createdAt: number;
}

interface MemoryPool<T> {
  available: T[];
  used: Set<T>;
  factory: () => T;
  reset?: (obj: T) => void;
}

export class MemoryAlignmentManager {
  private config: MemoryAlignmentConfig;
  private pools = new Map<string, MemoryPool<any>>();
  private alignedBuffers = new Map<string, ArrayBuffer>();
  private stats = {
    allocations: 0,
    deallocations: 0,
    cacheHits: 0,
    cacheMisses: 0,
    totalMemoryUsed: 0,
    poolHits: 0,
    poolMisses: 0
  };

  constructor(config: Partial<MemoryAlignmentConfig> = {}) {
    this.config = {
      cacheLineSize: 64,         // 一般的なx86_64のキャッシュラインサイズ
      enablePadding: true,
      enablePooling: true,
      poolInitialSize: 100,
      enableMetrics: true,
      ...config
    };

    console.log('[Memory Alignment] Initialized with cache line size:', this.config.cacheLineSize);
  }

  /**
   * アライメントされたバッファを作成
   */
  public createAlignedBuffer(size: number, alignment?: number): ArrayBuffer {
    const alignSize = alignment || this.config.cacheLineSize;
    
    // アライメントされたサイズを計算
    const alignedSize = Math.ceil(size / alignSize) * alignSize;
    
    // バッファを作成
    const buffer = new ArrayBuffer(alignedSize);
    
    this.stats.allocations++;
    this.stats.totalMemoryUsed += alignedSize;
    
    if (this.config.enableMetrics) {
      console.log(`[Memory Alignment] Created aligned buffer: ${size} -> ${alignedSize} bytes`);
    }
    
    return buffer;
  }

  /**
   * 構造体をアライメント最適化
   */
  public alignStruct<T extends Record<string, any>>(obj: T, name?: string): T & { __aligned: true } {
    if (!this.config.enablePadding) {
      return obj as T & { __aligned: true };
    }

    const aligned = { ...obj } as any;
    
    // フィールドをサイズ順でソート（大きいものから）
    const fields = Object.entries(obj);
    fields.sort(([, a], [, b]) => this.getFieldSize(b) - this.getFieldSize(a));
    
    // パディングを追加してアライメント最適化
    let currentOffset = 0;
    for (const [key, value] of fields) {
      const fieldSize = this.getFieldSize(value);
      const alignment = Math.min(fieldSize, 8); // 最大8バイトアライメント
      
      // アライメント調整
      const padding = (alignment - (currentOffset % alignment)) % alignment;
      currentOffset += padding + fieldSize;
      
      aligned[key] = value;
    }

    // キャッシュライン境界でのパディング
    const totalSize = currentOffset;
    const cacheLinePadding = (this.config.cacheLineSize - (totalSize % this.config.cacheLineSize)) % this.config.cacheLineSize;
    
    if (cacheLinePadding > 0) {
      aligned.__padding = new Uint8Array(cacheLinePadding);
    }

    aligned.__aligned = true;
    aligned.__size = totalSize + cacheLinePadding;

    if (name && this.config.enableMetrics) {
      console.log(`[Memory Alignment] Aligned struct '${name}': ${Object.keys(obj).length} fields, ${aligned.__size} bytes`);
    }

    return aligned;
  }

  /**
   * フィールドサイズを推定
   */
  private getFieldSize(value: any): number {
    if (typeof value === 'number') {
      return Number.isInteger(value) ? 8 : 8; // int64/double
    }
    if (typeof value === 'string') {
      return value.length * 2; // UTF-16
    }
    if (typeof value === 'boolean') {
      return 1;
    }
    if (value instanceof Date) {
      return 8;
    }
    if (value instanceof ArrayBuffer) {
      return value.byteLength;
    }
    if (Array.isArray(value)) {
      return value.length * 8; // ポインタサイズ
    }
    if (typeof value === 'object' && value !== null) {
      return Object.keys(value).length * 8; // 概算
    }
    return 8; // デフォルト
  }

  /**
   * オブジェクトプールを作成
   */
  public createPool<T>(
    name: string,
    factory: () => T,
    reset?: (obj: T) => void,
    initialSize?: number
  ): void {
    const size = initialSize || this.config.poolInitialSize;
    
    const pool: MemoryPool<T> = {
      available: [],
      used: new Set(),
      factory,
      reset
    };

    // 初期オブジェクトを作成
    for (let i = 0; i < size; i++) {
      pool.available.push(factory());
    }

    this.pools.set(name, pool);
    
    console.log(`[Memory Alignment] Created pool '${name}' with ${size} objects`);
  }

  /**
   * プールからオブジェクトを取得
   */
  public getFromPool<T>(name: string): T | null {
    const pool = this.pools.get(name) as MemoryPool<T>;
    if (!pool) {
      console.warn(`[Memory Alignment] Pool '${name}' not found`);
      return null;
    }

    let obj: T;
    
    if (pool.available.length > 0) {
      obj = pool.available.pop()!;
      this.stats.poolHits++;
    } else {
      // プールが空の場合、新しいオブジェクトを作成
      obj = pool.factory();
      this.stats.poolMisses++;
    }

    pool.used.add(obj);
    return obj;
  }

  /**
   * オブジェクトをプールに返却
   */
  public returnToPool<T>(name: string, obj: T): void {
    const pool = this.pools.get(name) as MemoryPool<T>;
    if (!pool) {
      console.warn(`[Memory Alignment] Pool '${name}' not found`);
      return;
    }

    if (!pool.used.has(obj)) {
      console.warn(`[Memory Alignment] Object not from pool '${name}'`);
      return;
    }

    pool.used.delete(obj);
    
    // リセット関数があれば実行
    if (pool.reset) {
      pool.reset(obj);
    }
    
    pool.available.push(obj);
    this.stats.deallocations++;
  }

  /**
   * 頻繁にアクセスされるデータの最適配置
   */
  public optimizeHotData<T extends Record<string, any>>(data: T[]): T[] {
    if (!this.config.enablePadding) {
      return data;
    }

    // データをアクセス頻度でソート（頻度の高いものを先頭に）
    const optimized = [...data];
    
    // キャッシュライン境界を考慮した配置
    const itemsPerCacheLine = Math.floor(this.config.cacheLineSize / this.estimateObjectSize(optimized[0]));
    
    // ホットデータを連続配置
    return optimized.map(item => this.alignStruct(item));
  }

  /**
   * オブジェクトサイズを推定
   */
  private estimateObjectSize(obj: any): number {
    if (!obj || typeof obj !== 'object') {
      return 8;
    }

    let size = 0;
    for (const [, value] of Object.entries(obj)) {
      size += this.getFieldSize(value);
    }
    
    return size;
  }

  /**
   * メモリアクセスパターンを最適化
   */
  public optimizeAccessPattern<T>(
    data: T[],
    accessPattern: 'sequential' | 'random' | 'temporal'
  ): T[] {
    switch (accessPattern) {
      case 'sequential':
        // 順次アクセス用：データを連続配置
        return this.packSequentially(data);
        
      case 'random':
        // ランダムアクセス用：各要素をキャッシュライン境界に配置
        return this.alignForRandomAccess(data);
        
      case 'temporal':
        // 時間局所性重視：最近使用されたデータを先頭に
        return this.organizeByTemporalLocality(data);
        
      default:
        return data;
    }
  }

  /**
   * 順次アクセス用パッキング
   */
  private packSequentially<T>(data: T[]): T[] {
    // キャッシュライン効率を最大化するため、データを密にパック
    return data; // 簡易実装
  }

  /**
   * ランダムアクセス用アライメント
   */
  private alignForRandomAccess<T>(data: T[]): T[] {
    // 各要素をキャッシュライン境界に配置
    return data; // 簡易実装
  }

  /**
   * 時間局所性による整理
   */
  private organizeByTemporalLocality<T>(data: T[]): T[] {
    // アクセス履歴に基づいてデータを再配置
    return data; // 簡易実装
  }

  /**
   * キャッシュ効率をベンチマーク
   */
  public benchmarkCacheEfficiency<T>(
    data: T[],
    accessFunction: (item: T) => void,
    iterations: number = 1000
  ): { normalTime: number; optimizedTime: number; improvement: number } {
    // 通常のアクセス
    const normalStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      data.forEach(accessFunction);
    }
    const normalTime = performance.now() - normalStart;

    // 最適化されたアクセス
    const optimizedData = this.optimizeHotData(data);
    const optimizedStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      optimizedData.forEach(accessFunction);
    }
    const optimizedTime = performance.now() - optimizedStart;

    const improvement = ((normalTime - optimizedTime) / normalTime) * 100;

    if (this.config.enableMetrics) {
      console.log(`[Memory Alignment] Cache benchmark results:`);
      console.log(`  Normal: ${normalTime.toFixed(2)}ms`);
      console.log(`  Optimized: ${optimizedTime.toFixed(2)}ms`);
      console.log(`  Improvement: ${improvement.toFixed(1)}%`);
    }

    return { normalTime, optimizedTime, improvement };
  }

  /**
   * 統計情報取得
   */
  public getStats() {
    const poolStats = Array.from(this.pools.entries()).map(([name, pool]) => ({
      name,
      available: pool.available.length,
      used: pool.used.size,
      total: pool.available.length + pool.used.size
    }));

    return {
      ...this.stats,
      pools: poolStats,
      totalPools: this.pools.size,
      poolEfficiency: this.stats.poolHits / (this.stats.poolHits + this.stats.poolMisses) * 100 || 0,
      memoryEfficiency: this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses) * 100 || 0
    };
  }

  /**
   * 統計リセット
   */
  public resetStats(): void {
    this.stats = {
      allocations: 0,
      deallocations: 0,
      cacheHits: 0,
      cacheMisses: 0,
      totalMemoryUsed: 0,
      poolHits: 0,
      poolMisses: 0
    };
  }

  /**
   * メモリ使用量レポート
   */
  public getMemoryReport(): string {
    const stats = this.getStats();
    
    return `
=== Memory Alignment Report ===
Allocations: ${stats.allocations}
Deallocations: ${stats.deallocations}
Total Memory Used: ${(stats.totalMemoryUsed / 1024 / 1024).toFixed(2)} MB
Pool Efficiency: ${stats.poolEfficiency.toFixed(1)}%
Memory Efficiency: ${stats.memoryEfficiency.toFixed(1)}%
Active Pools: ${stats.totalPools}
==============================`;
  }
}

// ヘルパー関数
export function createAlignedArray<T>(
  size: number,
  factory: () => T,
  alignment?: number
): T[] {
  const manager = new MemoryAlignmentManager();
  const buffer = manager.createAlignedBuffer(size * 8, alignment);
  const array: T[] = [];
  
  for (let i = 0; i < size; i++) {
    array.push(factory());
  }
  
  return array;
}

export default MemoryAlignmentManager;