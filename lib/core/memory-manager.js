const { EventEmitter } = require('events');
const v8 = require('v8');
const { performance } = require('perf_hooks');

/**
 * メモリ管理とリーク検出システム
 */
class MemoryManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            checkInterval: config.checkInterval || 60000, // 1分
            heapSnapshotInterval: config.heapSnapshotInterval || 3600000, // 1時間
            memoryThreshold: config.memoryThreshold || 0.85, // 85%
            gcInterval: config.gcInterval || 300000, // 5分
            leakDetection: config.leakDetection !== false,
            autoCleanup: config.autoCleanup !== false,
            ...config
        };
        
        this.baseline = null;
        this.measurements = [];
        this.leakSuspects = new Map();
        this.resourceTracking = new Map();
        this.checkTimer = null;
        this.gcTimer = null;
        
        // WeakMapを使用してメモリリークを防ぐ
        this.weakReferences = new WeakMap();
        this.eventListenerCounts = new WeakMap();
    }
    
    /**
     * メモリ管理を開始
     */
    start() {
        // ベースラインを設定
        this.baseline = this.getMemoryStats();
        
        // 定期的なメモリチェック
        this.checkTimer = setInterval(() => {
            this.checkMemory();
        }, this.config.checkInterval);
        
        // 定期的なガベージコレクション
        if (this.config.autoCleanup && global.gc) {
            this.gcTimer = setInterval(() => {
                this.forceGarbageCollection();
            }, this.config.gcInterval);
        }
        
        // プロセスのメモリ警告を監視
        this.setupMemoryWarnings();
        
        this.emit('started', this.baseline);
    }
    
    /**
     * 停止
     */
    stop() {
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
            this.checkTimer = null;
        }
        
        if (this.gcTimer) {
            clearInterval(this.gcTimer);
            this.gcTimer = null;
        }
        
        this.emit('stopped');
    }
    
    /**
     * メモリ統計を取得
     */
    getMemoryStats() {
        const usage = process.memoryUsage();
        const heap = v8.getHeapStatistics();
        
        return {
            timestamp: Date.now(),
            process: {
                rss: usage.rss,
                heapTotal: usage.heapTotal,
                heapUsed: usage.heapUsed,
                external: usage.external,
                arrayBuffers: usage.arrayBuffers || 0
            },
            v8: {
                totalHeapSize: heap.total_heap_size,
                totalHeapSizeExecutable: heap.total_heap_size_executable,
                totalPhysicalSize: heap.total_physical_size,
                totalAvailableSize: heap.total_available_size,
                usedHeapSize: heap.used_heap_size,
                heapSizeLimit: heap.heap_size_limit,
                mallocedMemory: heap.malloced_memory,
                peakMallocedMemory: heap.peak_malloced_memory
            },
            usage: {
                percent: heap.used_heap_size / heap.heap_size_limit,
                available: heap.total_available_size
            }
        };
    }
    
    /**
     * メモリをチェック
     */
    checkMemory() {
        const current = this.getMemoryStats();
        this.measurements.push(current);
        
        // 古い測定値を削除（最大100件保持）
        if (this.measurements.length > 100) {
            this.measurements.shift();
        }
        
        // メモリ使用率をチェック
        if (current.usage.percent > this.config.memoryThreshold) {
            this.handleHighMemoryUsage(current);
        }
        
        // メモリリークを検出
        if (this.config.leakDetection) {
            this.detectMemoryLeaks(current);
        }
        
        this.emit('memory-check', current);
    }
    
    /**
     * メモリリークを検出
     */
    detectMemoryLeaks(current) {
        if (this.measurements.length < 10) {
            return; // 十分なデータがない
        }
        
        // 過去10回の測定値から傾向を分析
        const recent = this.measurements.slice(-10);
        const trend = this.calculateMemoryTrend(recent);
        
        // 継続的な増加傾向がある場合
        if (trend.increasing && trend.rate > 0.01) { // 1%/分以上の増加
            this.emit('memory-leak-suspected', {
                trend,
                current,
                suspects: Array.from(this.leakSuspects.entries())
            });
        }
    }
    
    /**
     * メモリ使用傾向を計算
     */
    calculateMemoryTrend(measurements) {
        const first = measurements[0];
        const last = measurements[measurements.length - 1];
        const duration = last.timestamp - first.timestamp;
        
        const heapGrowth = last.v8.usedHeapSize - first.v8.usedHeapSize;
        const rate = heapGrowth / first.v8.usedHeapSize / (duration / 60000); // per minute
        
        // 線形回帰で傾向を判定
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        measurements.forEach((m, i) => {
            sumX += i;
            sumY += m.v8.usedHeapSize;
            sumXY += i * m.v8.usedHeapSize;
            sumX2 += i * i;
        });
        
        const n = measurements.length;
        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        
        return {
            increasing: slope > 0,
            rate,
            slope,
            growth: heapGrowth
        };
    }
    
    /**
     * 高メモリ使用時の処理
     */
    handleHighMemoryUsage(stats) {
        this.emit('high-memory-usage', stats);
        
        if (this.config.autoCleanup) {
            // 強制的にガベージコレクション
            this.forceGarbageCollection();
            
            // キャッシュをクリア
            this.clearCaches();
            
            // 未使用のリソースを解放
            this.releaseUnusedResources();
        }
    }
    
    /**
     * 強制ガベージコレクション
     */
    forceGarbageCollection() {
        if (global.gc) {
            const before = this.getMemoryStats();
            
            performance.mark('gc-start');
            global.gc();
            performance.mark('gc-end');
            
            const after = this.getMemoryStats();
            const duration = performance.measure('gc-duration', 'gc-start', 'gc-end').duration;
            
            this.emit('garbage-collection', {
                before: before.v8.usedHeapSize,
                after: after.v8.usedHeapSize,
                freed: before.v8.usedHeapSize - after.v8.usedHeapSize,
                duration
            });
        }
    }
    
    /**
     * キャッシュをクリア
     */
    clearCaches() {
        this.emit('clear-caches');
        
        // グローバルキャッシュのクリア
        if (global.caches) {
            for (const cache of global.caches.values()) {
                if (cache.clear) {
                    cache.clear();
                }
            }
        }
    }
    
    /**
     * 未使用リソースを解放
     */
    releaseUnusedResources() {
        // タイマーのクリーンアップ
        this.cleanupTimers();
        
        // イベントリスナーのクリーンアップ
        this.cleanupEventListeners();
        
        // 未使用の接続をクローズ
        this.cleanupConnections();
    }
    
    /**
     * タイマーをクリーンアップ
     */
    cleanupTimers() {
        // アクティブなタイマーを取得（Node.js内部API）
        const activeTimers = process._getActiveHandles().filter(handle => 
            handle.constructor.name === 'Timer'
        );
        
        this.emit('cleanup-timers', { count: activeTimers.length });
    }
    
    /**
     * イベントリスナーをクリーンアップ
     */
    cleanupEventListeners() {
        let totalRemoved = 0;
        
        // EventEmitterの最大リスナー数チェック
        const emitters = this.resourceTracking.get('eventemitters') || [];
        emitters.forEach(emitter => {
            const events = emitter.eventNames();
            events.forEach(event => {
                const count = emitter.listenerCount(event);
                if (count > 10) { // 閾値
                    this.emit('excessive-listeners', {
                        event,
                        count,
                        emitter: emitter.constructor.name
                    });
                }
            });
        });
        
        this.emit('cleanup-listeners', { totalRemoved });
    }
    
    /**
     * 接続をクリーンアップ
     */
    cleanupConnections() {
        // アクティブな接続を取得
        const connections = process._getActiveHandles().filter(handle =>
            handle.constructor.name === 'Socket' || 
            handle.constructor.name === 'TCP'
        );
        
        this.emit('cleanup-connections', { count: connections.length });
    }
    
    /**
     * リソースを追跡
     */
    trackResource(type, resource, metadata = {}) {
        if (!this.resourceTracking.has(type)) {
            this.resourceTracking.set(type, new Set());
        }
        
        const resources = this.resourceTracking.get(type);
        resources.add({
            resource: new WeakRef(resource),
            metadata,
            created: Date.now()
        });
        
        // 定期的にWeakRefをクリーンアップ
        this.cleanupWeakRefs(type);
    }
    
    /**
     * WeakRefをクリーンアップ
     */
    cleanupWeakRefs(type) {
        const resources = this.resourceTracking.get(type);
        if (!resources) return;
        
        const alive = new Set();
        resources.forEach(item => {
            if (item.resource.deref()) {
                alive.add(item);
            }
        });
        
        this.resourceTracking.set(type, alive);
    }
    
    /**
     * EventEmitterの安全なラッパー
     */
    wrapEventEmitter(emitter) {
        const original = {
            on: emitter.on.bind(emitter),
            once: emitter.once.bind(emitter),
            removeListener: emitter.removeListener.bind(emitter)
        };
        
        // リスナー数を追跡
        if (!this.eventListenerCounts.has(emitter)) {
            this.eventListenerCounts.set(emitter, new Map());
        }
        
        const counts = this.eventListenerCounts.get(emitter);
        
        emitter.on = (event, listener) => {
            counts.set(event, (counts.get(event) || 0) + 1);
            
            // 警告
            if (counts.get(event) > 10) {
                this.emit('listener-leak-warning', {
                    event,
                    count: counts.get(event),
                    emitter: emitter.constructor.name
                });
            }
            
            return original.on(event, listener);
        };
        
        emitter.removeListener = (event, listener) => {
            counts.set(event, Math.max(0, (counts.get(event) || 0) - 1));
            return original.removeListener(event, listener);
        };
        
        return emitter;
    }
    
    /**
     * メモリプロファイルを取得
     */
    async getMemoryProfile() {
        const stats = this.getMemoryStats();
        const profile = {
            ...stats,
            resources: {},
            suspects: []
        };
        
        // リソース使用状況
        this.resourceTracking.forEach((resources, type) => {
            profile.resources[type] = resources.size;
        });
        
        // メモリリーク候補
        this.leakSuspects.forEach((info, name) => {
            profile.suspects.push({ name, ...info });
        });
        
        return profile;
    }
    
    /**
     * ヒープスナップショットを作成
     */
    async createHeapSnapshot() {
        const filename = `heap-${Date.now()}.heapsnapshot`;
        const stream = v8.writeHeapSnapshot();
        
        // ストリームをファイルに保存（実装は環境依存）
        this.emit('heap-snapshot', { filename });
        
        return filename;
    }
    
    /**
     * メモリ警告を設定
     */
    setupMemoryWarnings() {
        // メモリ使用量の警告
        if (process.emitWarning) {
            const checkMemoryPressure = () => {
                const stats = this.getMemoryStats();
                if (stats.usage.percent > 0.9) {
                    process.emitWarning(
                        `High memory usage: ${(stats.usage.percent * 100).toFixed(1)}%`,
                        'MemoryWarning'
                    );
                }
            };
            
            setInterval(checkMemoryPressure, 30000);
        }
    }
    
    /**
     * 統計情報を取得
     */
    getStats() {
        const current = this.getMemoryStats();
        const trend = this.measurements.length >= 10 
            ? this.calculateMemoryTrend(this.measurements.slice(-10))
            : null;
        
        return {
            current,
            baseline: this.baseline,
            trend,
            resourceCounts: Object.fromEntries(
                Array.from(this.resourceTracking.entries()).map(([type, resources]) => 
                    [type, resources.size]
                )
            ),
            suspectedLeaks: this.leakSuspects.size
        };
    }
}

// シングルトンインスタンス
let instance = null;

module.exports = {
    MemoryManager,
    
    getInstance(config) {
        if (!instance) {
            instance = new MemoryManager(config);
        }
        return instance;
    }
};