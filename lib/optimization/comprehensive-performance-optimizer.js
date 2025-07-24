/**
 * Comprehensive Performance Optimization System
 * 包括的なパフォーマンス最適化システム
 */

const cluster = require('cluster');
const os = require('os');
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const v8 = require('v8');
const perf_hooks = require('perf_hooks');

class ComprehensivePerformanceOptimizer extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // CPU最適化
            cpuAffinity: config.cpuAffinity !== false,
            cpuThreads: config.cpuThreads || os.cpus().length,
            workerPoolSize: config.workerPoolSize || Math.max(4, os.cpus().length - 1),
            
            // メモリ最適化
            heapSnapshotInterval: config.heapSnapshotInterval || 3600000, // 1時間
            gcInterval: config.gcInterval || 300000, // 5分
            maxHeapSize: config.maxHeapSize || 4096, // MB
            memoryThreshold: config.memoryThreshold || 0.85, // 85%
            
            // I/O最適化
            enableZeroCopy: config.enableZeroCopy !== false,
            bufferPoolSize: config.bufferPoolSize || 1000,
            bufferSize: config.bufferSize || 65536, // 64KB
            
            // ネットワーク最適化
            tcpNoDelay: config.tcpNoDelay !== false,
            tcpKeepAlive: config.tcpKeepAlive !== false,
            socketTimeout: config.socketTimeout || 300000, // 5分
            
            // キャッシュ最適化
            cacheWarmup: config.cacheWarmup !== false,
            cachePreload: config.cachePreload || [],
            
            // 自動最適化
            enableAutoTuning: config.enableAutoTuning !== false,
            tuningInterval: config.tuningInterval || 60000, // 1分
            
            ...config
        };
        
        this.metrics = {
            cpu: {
                usage: 0,
                loadAverage: [0, 0, 0],
                utilization: new Map()
            },
            memory: {
                heapUsed: 0,
                heapTotal: 0,
                external: 0,
                rss: 0,
                arrayBuffers: 0
            },
            performance: {
                eventLoopLag: 0,
                gcCount: 0,
                gcDuration: 0,
                throughput: 0
            },
            optimizations: {
                applied: 0,
                successful: 0,
                failed: 0
            }
        };
        
        // バッファプール
        this.bufferPool = [];
        this.usedBuffers = new WeakSet();
        
        // ワーカープール
        this.workerPool = [];
        this.workerQueue = [];
        
        // パフォーマンスモニター
        this.performanceObserver = null;
        
        // 初期化
        this.initialize();
    }
    
    /**
     * システム初期化
     */
    async initialize() {
        console.log('パフォーマンス最適化システムを初期化中...');
        
        try {
            // CPU最適化の設定
            if (this.config.cpuAffinity) {
                this.setupCPUAffinity();
            }
            
            // メモリ最適化の設定
            this.setupMemoryOptimization();
            
            // バッファプールの初期化
            this.initializeBufferPool();
            
            // ワーカープールの初期化
            await this.initializeWorkerPool();
            
            // パフォーマンス監視の開始
            this.startPerformanceMonitoring();
            
            // 自動チューニングの開始
            if (this.config.enableAutoTuning) {
                this.startAutoTuning();
            }
            
            // キャッシュのウォームアップ
            if (this.config.cacheWarmup) {
                await this.warmupCache();
            }
            
            console.log('✓ パフォーマンス最適化システムの初期化完了');
            
        } catch (error) {
            console.error('パフォーマンス最適化の初期化エラー:', error);
            throw error;
        }
    }
    
    /**
     * CPU親和性の設定
     */
    setupCPUAffinity() {
        if (process.platform === 'linux') {
            try {
                const { exec } = require('child_process');
                const cpuCount = os.cpus().length;
                
                // メインプロセスは最初のCPUに固定
                exec(`taskset -cp 0 ${process.pid}`);
                
                // ワーカープロセスを他のCPUに分散
                if (cluster.isWorker) {
                    const cpuId = (cluster.worker.id % (cpuCount - 1)) + 1;
                    exec(`taskset -cp ${cpuId} ${process.pid}`);
                }
                
                console.log('CPU親和性を設定しました');
            } catch (error) {
                console.warn('CPU親和性の設定に失敗:', error);
            }
        }
    }
    
    /**
     * メモリ最適化の設定
     */
    setupMemoryOptimization() {
        // ヒープサイズの設定
        if (this.config.maxHeapSize) {
            const maxHeap = this.config.maxHeapSize;
            if (process.execArgv.indexOf(`--max-old-space-size=${maxHeap}`) === -1) {
                console.warn(`ヒープサイズを設定するには --max-old-space-size=${maxHeap} で起動してください`);
            }
        }
        
        // ガベージコレクションの最適化
        if (global.gc) {
            setInterval(() => {
                const before = process.memoryUsage();
                global.gc();
                const after = process.memoryUsage();
                
                this.metrics.performance.gcCount++;
                this.metrics.performance.gcDuration += Date.now();
                
                this.emit('gc', {
                    before,
                    after,
                    freed: before.heapUsed - after.heapUsed
                });
            }, this.config.gcInterval);
        }
        
        // メモリ圧迫時の対処
        setInterval(() => {
            this.checkMemoryPressure();
        }, 10000);
    }
    
    /**
     * バッファプールの初期化
     */
    initializeBufferPool() {
        console.log(`バッファプールを初期化中 (サイズ: ${this.config.bufferPoolSize})`);
        
        for (let i = 0; i < this.config.bufferPoolSize; i++) {
            const buffer = Buffer.allocUnsafe(this.config.bufferSize);
            this.bufferPool.push(buffer);
        }
        
        // SharedArrayBufferを使用（利用可能な場合）
        if (typeof SharedArrayBuffer !== 'undefined') {
            this.sharedBufferPool = new SharedArrayBuffer(
                this.config.bufferPoolSize * this.config.bufferSize
            );
        }
    }
    
    /**
     * ワーカープールの初期化
     */
    async initializeWorkerPool() {
        console.log(`ワーカープールを初期化中 (サイズ: ${this.config.workerPoolSize})`);
        
        for (let i = 0; i < this.config.workerPoolSize; i++) {
            const worker = await this.createWorker(i);
            this.workerPool.push(worker);
        }
    }
    
    /**
     * ワーカーの作成
     */
    async createWorker(id) {
        const worker = new Worker(`${__dirname}/../workers/optimized-worker.js`, {
            workerData: {
                id,
                config: this.config
            }
        });
        
        worker.on('message', (message) => {
            this.handleWorkerMessage(worker, message);
        });
        
        worker.on('error', (error) => {
            console.error(`ワーカー ${id} エラー:`, error);
            this.replaceWorker(id);
        });
        
        worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`ワーカー ${id} が異常終了: ${code}`);
                this.replaceWorker(id);
            }
        });
        
        worker.busy = false;
        worker.id = id;
        
        return worker;
    }
    
    /**
     * パフォーマンス監視の開始
     */
    startPerformanceMonitoring() {
        // Event Loop監視
        let lastCheck = process.hrtime.bigint();
        setInterval(() => {
            const now = process.hrtime.bigint();
            const lag = Number(now - lastCheck) / 1000000 - 100; // ms
            this.metrics.performance.eventLoopLag = Math.max(0, lag);
            lastCheck = now;
        }, 100);
        
        // CPU使用率の監視
        const startUsage = process.cpuUsage();
        setInterval(() => {
            const usage = process.cpuUsage(startUsage);
            const total = usage.user + usage.system;
            const seconds = process.uptime();
            this.metrics.cpu.usage = (total / 1000000 / seconds * 100).toFixed(2);
            this.metrics.cpu.loadAverage = os.loadavg();
        }, 1000);
        
        // メモリ使用率の監視
        setInterval(() => {
            const mem = process.memoryUsage();
            this.metrics.memory = {
                heapUsed: mem.heapUsed,
                heapTotal: mem.heapTotal,
                external: mem.external,
                rss: mem.rss,
                arrayBuffers: mem.arrayBuffers || 0
            };
        }, 1000);
        
        // パフォーマンスオブザーバー
        this.performanceObserver = new perf_hooks.PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                this.emit('performance-entry', entry);
            }
        });
        
        this.performanceObserver.observe({ 
            entryTypes: ['measure', 'mark', 'gc', 'function'] 
        });
    }
    
    /**
     * 自動チューニングの開始
     */
    startAutoTuning() {
        setInterval(() => {
            this.performAutoTuning();
        }, this.config.tuningInterval);
    }
    
    /**
     * 自動チューニングの実行
     */
    async performAutoTuning() {
        const optimizations = [];
        
        // CPU最適化
        if (this.metrics.cpu.usage > 80) {
            optimizations.push(this.optimizeCPU());
        }
        
        // メモリ最適化
        const memoryUsage = this.metrics.memory.heapUsed / this.metrics.memory.heapTotal;
        if (memoryUsage > this.config.memoryThreshold) {
            optimizations.push(this.optimizeMemory());
        }
        
        // Event Loop最適化
        if (this.metrics.performance.eventLoopLag > 50) {
            optimizations.push(this.optimizeEventLoop());
        }
        
        // ワーカープール最適化
        const busyWorkers = this.workerPool.filter(w => w.busy).length;
        if (busyWorkers > this.workerPool.length * 0.8) {
            optimizations.push(this.optimizeWorkerPool());
        }
        
        // 最適化の実行
        const results = await Promise.allSettled(optimizations);
        
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                this.metrics.optimizations.successful++;
                console.log(`最適化 ${index + 1} 成功:`, result.value);
            } else {
                this.metrics.optimizations.failed++;
                console.error(`最適化 ${index + 1} 失敗:`, result.reason);
            }
        });
        
        this.metrics.optimizations.applied += optimizations.length;
    }
    
    /**
     * CPU最適化
     */
    async optimizeCPU() {
        const optimizations = [];
        
        // プロセス優先度の調整
        if (process.platform !== 'win32') {
            try {
                const nice = Math.floor((100 - this.metrics.cpu.usage) / 10);
                require('child_process').execSync(`renice -n ${nice} -p ${process.pid}`);
                optimizations.push('プロセス優先度を調整');
            } catch (error) {
                // 権限がない場合は無視
            }
        }
        
        // タスクの再分散
        if (this.workerQueue.length > 0) {
            const tasks = this.workerQueue.splice(0, Math.floor(this.workerQueue.length / 2));
            setTimeout(() => {
                tasks.forEach(task => this.workerQueue.push(task));
            }, 1000);
            optimizations.push('タスクキューを再分散');
        }
        
        return optimizations;
    }
    
    /**
     * メモリ最適化
     */
    async optimizeMemory() {
        const optimizations = [];
        
        // 強制ガベージコレクション
        if (global.gc) {
            global.gc();
            optimizations.push('ガベージコレクションを実行');
        }
        
        // バッファプールの縮小
        if (this.bufferPool.length > this.config.bufferPoolSize / 2) {
            const removeCount = Math.floor(this.bufferPool.length / 4);
            this.bufferPool.splice(0, removeCount);
            optimizations.push(`バッファプールを${removeCount}個縮小`);
        }
        
        // キャッシュのクリア
        if (global.caches) {
            this.emit('clear-cache', { reason: 'memory-pressure' });
            optimizations.push('キャッシュをクリア');
        }
        
        // ヒープスナップショット
        if (this.shouldTakeHeapSnapshot()) {
            this.takeHeapSnapshot();
            optimizations.push('ヒープスナップショットを作成');
        }
        
        return optimizations;
    }
    
    /**
     * Event Loop最適化
     */
    async optimizeEventLoop() {
        const optimizations = [];
        
        // 重いタスクをワーカーに移動
        const pendingTasks = this.workerQueue.length;
        if (pendingTasks > 10) {
            // タスクをバッチ処理
            const batchSize = Math.min(pendingTasks, 50);
            const batch = this.workerQueue.splice(0, batchSize);
            
            const worker = this.getAvailableWorker();
            if (worker) {
                worker.postMessage({ type: 'batch', tasks: batch });
                optimizations.push(`${batchSize}個のタスクをバッチ処理`);
            }
        }
        
        // setImmediateを使用してタスクを分割
        process.nextTick(() => {
            setImmediate(() => {
                this.emit('event-loop-optimized');
            });
        });
        
        optimizations.push('Event Loopを最適化');
        
        return optimizations;
    }
    
    /**
     * ワーカープール最適化
     */
    async optimizeWorkerPool() {
        const optimizations = [];
        
        // ワーカーの追加
        if (this.workerPool.length < this.config.cpuThreads) {
            const newWorker = await this.createWorker(this.workerPool.length);
            this.workerPool.push(newWorker);
            optimizations.push('新しいワーカーを追加');
        }
        
        // アイドルワーカーの削除
        const idleWorkers = this.workerPool.filter(w => !w.busy);
        if (idleWorkers.length > this.config.workerPoolSize) {
            const removeCount = idleWorkers.length - this.config.workerPoolSize;
            for (let i = 0; i < removeCount; i++) {
                const worker = idleWorkers[i];
                worker.terminate();
                this.workerPool = this.workerPool.filter(w => w !== worker);
            }
            optimizations.push(`${removeCount}個のアイドルワーカーを削除`);
        }
        
        return optimizations;
    }
    
    /**
     * バッファの取得（ゼロコピー）
     */
    getBuffer() {
        if (this.bufferPool.length > 0) {
            const buffer = this.bufferPool.pop();
            this.usedBuffers.add(buffer);
            return buffer;
        }
        
        // プールが空の場合は新しいバッファを作成
        console.warn('バッファプールが空です。新しいバッファを作成します。');
        return Buffer.allocUnsafe(this.config.bufferSize);
    }
    
    /**
     * バッファの返却
     */
    releaseBuffer(buffer) {
        if (this.usedBuffers.has(buffer)) {
            this.usedBuffers.delete(buffer);
            buffer.fill(0); // セキュリティのためクリア
            this.bufferPool.push(buffer);
        }
    }
    
    /**
     * タスクの実行（ワーカープール使用）
     */
    async executeTask(task) {
        return new Promise((resolve, reject) => {
            const taskWithCallback = {
                ...task,
                id: Math.random().toString(36).substr(2, 9),
                resolve,
                reject
            };
            
            const worker = this.getAvailableWorker();
            if (worker) {
                worker.busy = true;
                worker.currentTask = taskWithCallback;
                worker.postMessage({ type: 'task', task: taskWithCallback });
            } else {
                this.workerQueue.push(taskWithCallback);
            }
        });
    }
    
    /**
     * 利用可能なワーカーの取得
     */
    getAvailableWorker() {
        return this.workerPool.find(w => !w.busy);
    }
    
    /**
     * ワーカーメッセージの処理
     */
    handleWorkerMessage(worker, message) {
        if (message.type === 'result') {
            const task = worker.currentTask;
            if (task) {
                if (message.error) {
                    task.reject(new Error(message.error));
                } else {
                    task.resolve(message.result);
                }
                
                worker.busy = false;
                worker.currentTask = null;
                
                // キューからタスクを取得
                if (this.workerQueue.length > 0) {
                    const nextTask = this.workerQueue.shift();
                    worker.busy = true;
                    worker.currentTask = nextTask;
                    worker.postMessage({ type: 'task', task: nextTask });
                }
            }
        } else if (message.type === 'metrics') {
            this.emit('worker-metrics', { worker: worker.id, metrics: message.metrics });
        }
    }
    
    /**
     * ワーカーの置き換え
     */
    async replaceWorker(id) {
        const index = this.workerPool.findIndex(w => w.id === id);
        if (index !== -1) {
            const oldWorker = this.workerPool[index];
            if (oldWorker.currentTask) {
                this.workerQueue.unshift(oldWorker.currentTask);
            }
            
            try {
                await oldWorker.terminate();
            } catch (error) {
                // エラーは無視
            }
            
            const newWorker = await this.createWorker(id);
            this.workerPool[index] = newWorker;
        }
    }
    
    /**
     * メモリ圧迫のチェック
     */
    checkMemoryPressure() {
        const usage = process.memoryUsage();
        const heapUsage = usage.heapUsed / usage.heapTotal;
        
        if (heapUsage > this.config.memoryThreshold) {
            this.emit('memory-pressure', {
                heapUsed: usage.heapUsed,
                heapTotal: usage.heapTotal,
                percentage: (heapUsage * 100).toFixed(2)
            });
            
            // 自動的にメモリを最適化
            this.optimizeMemory();
        }
    }
    
    /**
     * ヒープスナップショットの作成
     */
    takeHeapSnapshot() {
        const filename = `heap-${Date.now()}.heapsnapshot`;
        const stream = v8.getHeapSnapshot();
        const fs = require('fs');
        const fileStream = fs.createWriteStream(filename);
        
        stream.pipe(fileStream);
        
        fileStream.on('finish', () => {
            console.log(`ヒープスナップショットを保存: ${filename}`);
            this.emit('heap-snapshot', { filename });
        });
    }
    
    /**
     * ヒープスナップショットを取るべきか
     */
    shouldTakeHeapSnapshot() {
        const lastSnapshot = this.lastHeapSnapshot || 0;
        return Date.now() - lastSnapshot > this.config.heapSnapshotInterval;
    }
    
    /**
     * キャッシュのウォームアップ
     */
    async warmupCache() {
        console.log('キャッシュをウォームアップ中...');
        
        const warmupTasks = this.config.cachePreload.map(async (item) => {
            try {
                await this.executeTask({
                    type: 'cache-warmup',
                    data: item
                });
            } catch (error) {
                console.warn(`キャッシュウォームアップエラー:`, error);
            }
        });
        
        await Promise.allSettled(warmupTasks);
        console.log('✓ キャッシュのウォームアップ完了');
    }
    
    /**
     * パフォーマンスメトリクスの取得
     */
    getMetrics() {
        return {
            ...this.metrics,
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            workers: {
                total: this.workerPool.length,
                busy: this.workerPool.filter(w => w.busy).length,
                queueLength: this.workerQueue.length
            },
            buffers: {
                poolSize: this.bufferPool.length,
                totalSize: this.config.bufferPoolSize
            }
        };
    }
    
    /**
     * パフォーマンステスト
     */
    async runPerformanceTest() {
        console.log('パフォーマンステストを実行中...');
        
        const tests = [
            { name: 'CPU集約的タスク', type: 'cpu-intensive', iterations: 1000 },
            { name: 'メモリ集約的タスク', type: 'memory-intensive', size: 100 * 1024 * 1024 },
            { name: 'I/O集約的タスク', type: 'io-intensive', operations: 1000 },
            { name: '並列処理タスク', type: 'parallel', tasks: 100 }
        ];
        
        const results = [];
        
        for (const test of tests) {
            const start = process.hrtime.bigint();
            
            try {
                await this.executeTask({
                    type: 'performance-test',
                    test
                });
                
                const end = process.hrtime.bigint();
                const duration = Number(end - start) / 1000000; // ms
                
                results.push({
                    name: test.name,
                    duration,
                    success: true
                });
                
                console.log(`✓ ${test.name}: ${duration.toFixed(2)}ms`);
                
            } catch (error) {
                results.push({
                    name: test.name,
                    error: error.message,
                    success: false
                });
                
                console.error(`✗ ${test.name}: ${error.message}`);
            }
        }
        
        return results;
    }
    
    /**
     * クリーンアップ
     */
    async cleanup() {
        console.log('パフォーマンス最適化システムをクリーンアップ中...');
        
        // ワーカーの終了
        await Promise.all(this.workerPool.map(worker => worker.terminate()));
        
        // パフォーマンスオブザーバーの停止
        if (this.performanceObserver) {
            this.performanceObserver.disconnect();
        }
        
        // バッファプールのクリア
        this.bufferPool = [];
        this.usedBuffers = new WeakSet();
        
        console.log('✓ クリーンアップ完了');
    }
}

module.exports = ComprehensivePerformanceOptimizer;