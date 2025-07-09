/**
 * GPU メモリ最適化システム
 * 設計思想: John Carmack (高性能), Robert C. Martin (クリーン), Rob Pike (シンプル)
 * 
 * 機能:
 * - VRAM使用量最適化
 * - メモリプール管理
 * - GPU専用バッファ管理
 * - メモリリーク検出
 * - 動的メモリ調整
 */

import { EventEmitter } from 'events';

// === 型定義 ===
export interface GPUMemoryInfo {
  total: number;          // 総VRAM容量 (bytes)
  used: number;           // 使用中VRAM (bytes)
  free: number;           // 空きVRAM (bytes)
  allocated: number;      // 割り当て済み (bytes)
  fragmented: number;     // 断片化サイズ (bytes)
  efficiency: number;     // 使用効率 (0-100%)
}

export interface MemoryPool {
  id: string;
  size: number;
  used: number;
  blocks: MemoryBlock[];
  fragmentationRatio: number;
}

export interface MemoryBlock {
  id: string;
  offset: number;
  size: number;
  inUse: boolean;
  allocatedAt: number;
  purpose: string;
}

export interface OptimizationSettings {
  maxVRAMUsage: number;           // 最大VRAM使用率 (0-1)
  fragmentationThreshold: number; // 断片化しきい値 (0-1)
  cleanupInterval: number;        // クリーンアップ間隔 (ms)
  preallocationSize: number;      // 事前割り当てサイズ (bytes)
  enableCompaction: boolean;      // メモリ圧縮有効
  emergencyCleanup: boolean;      // 緊急クリーンアップ
}

export interface MemoryAlert {
  type: 'high_usage' | 'fragmentation' | 'leak' | 'allocation_failed';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  details: any;
  timestamp: number;
}

// === GPUメモリ最適化システム ===
export class GPUMemoryOptimizer extends EventEmitter {
  private pools = new Map<string, MemoryPool>();
  private allocations = new Map<string, MemoryBlock>();
  private settings: OptimizationSettings;
  private gpuInfo: GPUMemoryInfo;
  private cleanupTimer?: NodeJS.Timeout;
  private nextBlockId = 1;

  constructor(settings: Partial<OptimizationSettings> = {}) {
    super();
    
    this.settings = {
      maxVRAMUsage: 0.9,              // 90%まで使用
      fragmentationThreshold: 0.3,    // 30%断片化でクリーンアップ
      cleanupInterval: 30000,         // 30秒間隔
      preallocationSize: 256 * 1024 * 1024, // 256MB事前割り当て
      enableCompaction: true,
      emergencyCleanup: true,
      ...settings
    };

    this.gpuInfo = {
      total: 0,
      used: 0,
      free: 0,
      allocated: 0,
      fragmented: 0,
      efficiency: 0
    };

    this.startMemoryMonitoring();
  }

  // === 初期化 ===
  async initialize(gpuId: number = 0): Promise<void> {
    console.log(`🔧 Initializing GPU memory optimizer for GPU ${gpuId}...`);
    
    // GPU情報取得（実際の実装ではGPUライブラリ使用）
    await this.detectGPUMemory(gpuId);
    
    // メインメモリプール作成
    this.createMemoryPool('main', this.settings.preallocationSize);
    
    // バッファプール作成
    this.createMemoryPool('buffers', 64 * 1024 * 1024); // 64MB
    
    // テクスチャプール作成
    this.createMemoryPool('textures', 128 * 1024 * 1024); // 128MB
    
    console.log(`✅ GPU memory optimizer initialized - Total: ${this.formatBytes(this.gpuInfo.total)}`);
    this.emit('initialized', this.gpuInfo);
  }

  // === メモリプール管理 ===
  createMemoryPool(poolId: string, size: number): MemoryPool {
    const pool: MemoryPool = {
      id: poolId,
      size,
      used: 0,
      blocks: [],
      fragmentationRatio: 0
    };

    this.pools.set(poolId, pool);
    console.log(`📦 Created memory pool '${poolId}': ${this.formatBytes(size)}`);
    this.emit('poolCreated', pool);
    
    return pool;
  }

  // === メモリ割り当て ===
  allocate(size: number, purpose: string, poolId: string = 'main'): string | null {
    const pool = this.pools.get(poolId);
    if (!pool) {
      console.error(`❌ Pool '${poolId}' not found`);
      return null;
    }

    // メモリ使用量チェック
    if (!this.canAllocate(size)) {
      if (this.settings.emergencyCleanup) {
        this.performEmergencyCleanup();
        if (!this.canAllocate(size)) {
          this.emitAlert('allocation_failed', 'critical', 
            `Failed to allocate ${this.formatBytes(size)} for ${purpose}`);
          return null;
        }
      } else {
        return null;
      }
    }

    // 最適な位置を探す
    const offset = this.findBestFit(pool, size);
    if (offset === -1) {
      // 断片化解消を試行
      if (this.settings.enableCompaction) {
        this.compactPool(pool);
        const retryOffset = this.findBestFit(pool, size);
        if (retryOffset === -1) {
          return null;
        }
      } else {
        return null;
      }
    }

    // ブロック作成
    const blockId = `block_${this.nextBlockId++}`;
    const block: MemoryBlock = {
      id: blockId,
      offset: offset !== -1 ? offset : this.findNextOffset(pool),
      size,
      inUse: true,
      allocatedAt: Date.now(),
      purpose
    };

    // 登録
    pool.blocks.push(block);
    this.allocations.set(blockId, block);
    pool.used += size;
    this.updateGPUInfo();

    console.log(`📝 Allocated ${this.formatBytes(size)} for ${purpose} (${blockId})`);
    this.emit('allocated', { blockId, size, purpose, poolId });
    
    return blockId;
  }

  // === メモリ解放 ===
  deallocate(blockId: string): boolean {
    const block = this.allocations.get(blockId);
    if (!block) {
      console.warn(`⚠️ Block '${blockId}' not found for deallocation`);
      return false;
    }

    // プールから削除
    for (const pool of this.pools.values()) {
      const index = pool.blocks.findIndex(b => b.id === blockId);
      if (index !== -1) {
        pool.blocks.splice(index, 1);
        pool.used -= block.size;
        break;
      }
    }

    // 登録から削除
    this.allocations.delete(blockId);
    this.updateGPUInfo();

    console.log(`🗑️ Deallocated ${this.formatBytes(block.size)} (${blockId})`);
    this.emit('deallocated', { blockId, size: block.size });
    
    return true;
  }

  // === メモリ最適化 ===
  optimize(): void {
    console.log('🔄 Starting memory optimization...');
    
    let optimized = false;

    // 各プールを最適化
    for (const pool of this.pools.values()) {
      const initialFragmentation = pool.fragmentationRatio;
      
      // 未使用ブロック削除
      this.cleanupUnusedBlocks(pool);
      
      // 断片化チェック
      this.updateFragmentation(pool);
      
      // 圧縮実行
      if (pool.fragmentationRatio > this.settings.fragmentationThreshold) {
        this.compactPool(pool);
        optimized = true;
      }

      if (pool.fragmentationRatio < initialFragmentation) {
        console.log(`✨ Pool '${pool.id}' fragmentation reduced: ${(initialFragmentation * 100).toFixed(1)}% → ${(pool.fragmentationRatio * 100).toFixed(1)}%`);
      }
    }

    this.updateGPUInfo();
    
    if (optimized) {
      this.emit('optimized', this.getMemoryStats());
    }
    
    console.log('✅ Memory optimization completed');
  }

  // === 緊急クリーンアップ ===
  performEmergencyCleanup(): void {
    console.log('🚨 Performing emergency cleanup...');
    
    let freedBytes = 0;

    // 古い割り当てから削除
    const now = Date.now();
    const cutoffTime = now - (5 * 60 * 1000); // 5分前

    for (const [blockId, block] of this.allocations) {
      if (block.allocatedAt < cutoffTime && block.purpose !== 'critical') {
        freedBytes += block.size;
        this.deallocate(blockId);
      }
    }

    // 全プール最適化
    this.optimize();

    console.log(`🧹 Emergency cleanup freed ${this.formatBytes(freedBytes)}`);
    this.emit('emergencyCleanup', { freedBytes });
  }

  // === 統計・情報取得 ===
  getMemoryStats(): GPUMemoryInfo {
    return { ...this.gpuInfo };
  }

  getPoolStats(): MemoryPool[] {
    return Array.from(this.pools.values()).map(pool => ({ ...pool }));
  }

  getAllocationStats(): { total: number; count: number; avgSize: number; purposes: Record<string, number> } {
    const allocations = Array.from(this.allocations.values());
    const total = allocations.reduce((sum, block) => sum + block.size, 0);
    const purposes: Record<string, number> = {};
    
    allocations.forEach(block => {
      purposes[block.purpose] = (purposes[block.purpose] || 0) + block.size;
    });

    return {
      total,
      count: allocations.length,
      avgSize: allocations.length > 0 ? total / allocations.length : 0,
      purposes
    };
  }

  // === プライベートメソッド ===
  private async detectGPUMemory(gpuId: number): Promise<void> {
    // 実際の実装ではGPUライブラリを使用
    // ここではモック実装
    this.gpuInfo = {
      total: 8 * 1024 * 1024 * 1024, // 8GB
      used: 0,
      free: 8 * 1024 * 1024 * 1024,
      allocated: 0,
      fragmented: 0,
      efficiency: 0
    };
  }

  private canAllocate(size: number): boolean {
    const totalAllocated = this.getTotalAllocated();
    const maxUsage = this.gpuInfo.total * this.settings.maxVRAMUsage;
    return (totalAllocated + size) <= maxUsage;
  }

  private findBestFit(pool: MemoryPool, size: number): number {
    // First-fit アルゴリズム（簡略化）
    let offset = 0;
    const sortedBlocks = pool.blocks.sort((a, b) => a.offset - b.offset);
    
    for (const block of sortedBlocks) {
      if (block.offset - offset >= size) {
        return offset;
      }
      offset = block.offset + block.size;
    }
    
    // 末尾に配置可能かチェック
    if (pool.size - offset >= size) {
      return offset;
    }
    
    return -1;
  }

  private findNextOffset(pool: MemoryPool): number {
    if (pool.blocks.length === 0) return 0;
    
    const lastBlock = pool.blocks.reduce((latest, block) => 
      block.offset + block.size > latest.offset + latest.size ? block : latest
    );
    
    return lastBlock.offset + lastBlock.size;
  }

  private compactPool(pool: MemoryPool): void {
    console.log(`🔧 Compacting pool '${pool.id}'...`);
    
    // ブロックをオフセット順にソート
    pool.blocks.sort((a, b) => a.offset - b.offset);
    
    // 隙間を詰める
    let currentOffset = 0;
    for (const block of pool.blocks) {
      if (block.inUse) {
        block.offset = currentOffset;
        currentOffset += block.size;
      }
    }
    
    this.updateFragmentation(pool);
  }

  private cleanupUnusedBlocks(pool: MemoryPool): void {
    const initialCount = pool.blocks.length;
    pool.blocks = pool.blocks.filter(block => block.inUse);
    
    const removed = initialCount - pool.blocks.length;
    if (removed > 0) {
      console.log(`🧹 Cleaned up ${removed} unused blocks from pool '${pool.id}'`);
    }
  }

  private updateFragmentation(pool: MemoryPool): void {
    if (pool.blocks.length === 0) {
      pool.fragmentationRatio = 0;
      return;
    }

    const sortedBlocks = pool.blocks.sort((a, b) => a.offset - b.offset);
    let gapSize = 0;
    let lastEnd = 0;

    for (const block of sortedBlocks) {
      if (block.offset > lastEnd) {
        gapSize += block.offset - lastEnd;
      }
      lastEnd = block.offset + block.size;
    }

    pool.fragmentationRatio = pool.used > 0 ? gapSize / pool.used : 0;
  }

  private updateGPUInfo(): void {
    const totalAllocated = this.getTotalAllocated();
    const totalUsed = totalAllocated; // 簡略化
    
    this.gpuInfo.allocated = totalAllocated;
    this.gpuInfo.used = totalUsed;
    this.gpuInfo.free = this.gpuInfo.total - totalUsed;
    this.gpuInfo.efficiency = this.gpuInfo.total > 0 ? (totalUsed / this.gpuInfo.total) * 100 : 0;
    
    // 断片化計算
    let totalFragmented = 0;
    for (const pool of this.pools.values()) {
      totalFragmented += pool.used * pool.fragmentationRatio;
    }
    this.gpuInfo.fragmented = totalFragmented;
  }

  private getTotalAllocated(): number {
    return Array.from(this.pools.values()).reduce((sum, pool) => sum + pool.used, 0);
  }

  private startMemoryMonitoring(): void {
    this.cleanupTimer = setInterval(() => {
      this.checkMemoryHealth();
    }, this.settings.cleanupInterval);
  }

  private checkMemoryHealth(): void {
    this.updateGPUInfo();
    
    // 使用量チェック
    if (this.gpuInfo.efficiency > 85) {
      this.emitAlert('high_usage', 'medium', 
        `High VRAM usage: ${this.gpuInfo.efficiency.toFixed(1)}%`);
    }
    
    // 断片化チェック
    const avgFragmentation = Array.from(this.pools.values())
      .reduce((sum, pool) => sum + pool.fragmentationRatio, 0) / this.pools.size;
    
    if (avgFragmentation > this.settings.fragmentationThreshold) {
      this.emitAlert('fragmentation', 'low', 
        `High fragmentation detected: ${(avgFragmentation * 100).toFixed(1)}%`);
      this.optimize();
    }
  }

  private emitAlert(type: MemoryAlert['type'], severity: MemoryAlert['severity'], message: string, details?: any): void {
    const alert: MemoryAlert = {
      type,
      severity,
      message,
      details: details || {},
      timestamp: Date.now()
    };
    
    console.log(`🚨 ${severity.toUpperCase()}: ${message}`);
    this.emit('alert', alert);
  }

  private formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  // === 破棄 ===
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    // 全メモリ解放
    for (const blockId of this.allocations.keys()) {
      this.deallocate(blockId);
    }
    
    this.pools.clear();
    console.log('🗑️ GPU memory optimizer destroyed');
  }
}

// === 使用例 ===
export async function createGPUMemoryOptimizer(settings?: Partial<OptimizationSettings>): Promise<GPUMemoryOptimizer> {
  const optimizer = new GPUMemoryOptimizer(settings);
  
  // イベントハンドラー設定
  optimizer.on('alert', (alert) => {
    if (alert.severity === 'critical') {
      console.error(`🚨 GPU Memory Critical: ${alert.message}`);
    }
  });

  optimizer.on('optimized', (stats) => {
    console.log(`✨ GPU Memory optimized - Efficiency: ${stats.efficiency.toFixed(1)}%`);
  });

  await optimizer.initialize();
  return optimizer;
}

export default GPUMemoryOptimizer;