/**
 * 非同期処理最適化
 * 効率的なasync/awaitパターンとパフォーマンス最適化
 * 
 * 設計思想：
 * - Carmack: 最小のオーバーヘッド、最大のスループット
 * - Martin: 明確な非同期フロー制御
 * - Pike: 並行性の適切な活用
 */

import { EventEmitter } from 'events';
import { promisify } from 'util';
import { Worker } from 'worker_threads';
import * as os from 'os';

// === 型定義 ===
export interface AsyncTaskOptions {
  timeout?: number;
  retries?: number;
  priority?: number;
  concurrency?: number;
}

export interface TaskResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  duration: number;
  retries: number;
}

export interface PoolOptions {
  minWorkers?: number;
  maxWorkers?: number;
  taskTimeout?: number;
  idleTimeout?: number;
}

// === 非同期タスクキュー ===
export class AsyncTaskQueue<T> extends EventEmitter {
  private queue: Array<{
    task: () => Promise<T>;
    resolve: (value: TaskResult<T>) => void;
    reject: (error: Error) => void;
    options: AsyncTaskOptions;
    startTime: number;
  }> = [];
  
  private running: number = 0;
  private maxConcurrency: number;
  private defaultTimeout: number;
  
  constructor(maxConcurrency: number = 10, defaultTimeout: number = 30000) {
    super();
    this.maxConcurrency = maxConcurrency;
    this.defaultTimeout = defaultTimeout;
  }
  
  // タスクの追加
  async add<R extends T>(
    task: () => Promise<R>,
    options: AsyncTaskOptions = {}
  ): Promise<TaskResult<R>> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        task: task as () => Promise<T>,
        resolve: resolve as (value: TaskResult<T>) => void,
        reject,
        options: {
          timeout: options.timeout || this.defaultTimeout,
          retries: options.retries || 0,
          priority: options.priority || 0,
          concurrency: options.concurrency || 1
        },
        startTime: Date.now()
      });
      
      // 優先度でソート
      this.queue.sort((a, b) => (b.options.priority || 0) - (a.options.priority || 0));
      
      this.processNext();
    });
  }
  
  // 次のタスクを処理
  private async processNext(): Promise<void> {
    if (this.running >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }
    
    const item = this.queue.shift();
    if (!item) return;
    
    this.running++;
    
    try {
      const result = await this.executeTask(item.task, item.options);
      item.resolve(result);
    } catch (error) {
      item.reject(error as Error);
    } finally {
      this.running--;
      this.emit('taskCompleted', { running: this.running, queued: this.queue.length });
      
      // 次のタスクを処理
      setImmediate(() => this.processNext());
    }
  }
  
  // タスクの実行
  private async executeTask<R extends T>(
    task: () => Promise<R>,
    options: AsyncTaskOptions
  ): Promise<TaskResult<R>> {
    const startTime = Date.now();
    let lastError: Error | undefined;
    let retries = 0;
    
    for (let attempt = 0; attempt <= (options.retries || 0); attempt++) {
      try {
        // タイムアウト付きで実行
        const data = await this.withTimeout(task(), options.timeout || this.defaultTimeout);
        
        return {
          success: true,
          data,
          duration: Date.now() - startTime,
          retries
        };
      } catch (error) {
        lastError = error as Error;
        retries++;
        
        if (attempt < (options.retries || 0)) {
          // リトライ前に待機（指数バックオフ）
          await this.delay(Math.min(1000 * Math.pow(2, attempt), 10000));
        }
      }
    }
    
    return {
      success: false,
      error: lastError,
      duration: Date.now() - startTime,
      retries
    };
  }
  
  // タイムアウト付き実行
  private async withTimeout<R>(promise: Promise<R>, timeout: number): Promise<R> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Task timeout')), timeout)
      )
    ]);
  }
  
  // 遅延
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  // キューの状態
  getStats() {
    return {
      running: this.running,
      queued: this.queue.length,
      maxConcurrency: this.maxConcurrency
    };
  }
  
  // キューをクリア
  clear(): void {
    this.queue = [];
  }
}

// === バッチ処理最適化 ===
export class BatchProcessor<T, R> {
  private batch: T[] = [];
  private batchSize: number;
  private flushInterval: number;
  private processor: (items: T[]) => Promise<R[]>;
  private timer?: NodeJS.Timeout;
  private processing: boolean = false;
  
  constructor(
    processor: (items: T[]) => Promise<R[]>,
    batchSize: number = 100,
    flushInterval: number = 1000
  ) {
    this.processor = processor;
    this.batchSize = batchSize;
    this.flushInterval = flushInterval;
  }
  
  // アイテムの追加
  async add(item: T): Promise<void> {
    this.batch.push(item);
    
    if (this.batch.length >= this.batchSize) {
      await this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushInterval);
    }
  }
  
  // バッチ処理の実行
  async flush(): Promise<void> {
    if (this.processing || this.batch.length === 0) {
      return;
    }
    
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    
    this.processing = true;
    const items = this.batch.splice(0, this.batchSize);
    
    try {
      await this.processor(items);
    } finally {
      this.processing = false;
      
      // 残りがあれば次のバッチを処理
      if (this.batch.length > 0) {
        setImmediate(() => this.flush());
      }
    }
  }
  
  // 破棄
  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.batch = [];
  }
}

// === 並列処理マネージャー ===
export class ParallelProcessor {
  // 並列マップ処理
  static async map<T, R>(
    items: T[],
    processor: (item: T) => Promise<R>,
    concurrency: number = 10
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    const executing: Promise<void>[] = [];
    
    for (let i = 0; i < items.length; i++) {
      const index = i;
      const item = items[i];
      
      const promise = processor(item).then(result => {
        results[index] = result;
      });
      
      executing.push(promise);
      
      if (executing.length >= concurrency) {
        await Promise.race(executing);
        // 完了したPromiseを削除
        executing.splice(
          executing.findIndex(p => p === promise),
          1
        );
      }
    }
    
    await Promise.all(executing);
    return results;
  }
  
  // チャンク処理
  static async processInChunks<T, R>(
    items: T[],
    processor: (chunk: T[]) => Promise<R[]>,
    chunkSize: number = 100
  ): Promise<R[]> {
    const results: R[] = [];
    
    for (let i = 0; i < items.length; i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize);
      const chunkResults = await processor(chunk);
      results.push(...chunkResults);
    }
    
    return results;
  }
  
  // 並列削減
  static async reduce<T, R>(
    items: T[],
    reducer: (acc: R, item: T) => Promise<R>,
    initial: R,
    concurrency: number = 1
  ): Promise<R> {
    if (concurrency === 1) {
      // 順次処理
      let result = initial;
      for (const item of items) {
        result = await reducer(result, item);
      }
      return result;
    }
    
    // 並列処理（順序保証なし）
    const chunks = this.chunkArray(items, concurrency);
    const chunkResults = await Promise.all(
      chunks.map(async chunk => {
        let result = initial;
        for (const item of chunk) {
          result = await reducer(result, item);
        }
        return result;
      })
    );
    
    // チャンク結果を統合
    let finalResult = initial;
    for (const chunkResult of chunkResults) {
      finalResult = await reducer(finalResult, chunkResult as any);
    }
    
    return finalResult;
  }
  
  // 配列をチャンクに分割
  private static chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}

// === ワーカープール ===
export class WorkerPool extends EventEmitter {
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private taskQueue: Array<{
    data: any;
    resolve: (result: any) => void;
    reject: (error: Error) => void;
  }> = [];
  
  private options: PoolOptions;
  private workerScript: string;
  
  constructor(workerScript: string, options: PoolOptions = {}) {
    super();
    this.workerScript = workerScript;
    this.options = {
      minWorkers: options.minWorkers || 2,
      maxWorkers: options.maxWorkers || os.cpus().length,
      taskTimeout: options.taskTimeout || 60000,
      idleTimeout: options.idleTimeout || 10000
    };
    
    // 最小数のワーカーを作成
    this.initialize();
  }
  
  // 初期化
  private async initialize(): Promise<void> {
    for (let i = 0; i < this.options.minWorkers!; i++) {
      await this.createWorker();
    }
  }
  
  // ワーカーの作成
  private async createWorker(): Promise<Worker> {
    const worker = new Worker(this.workerScript);
    
    worker.on('message', (result) => {
      // タスク完了時の処理
      const task = this.taskQueue.shift();
      if (task) {
        task.resolve(result);
        this.processNext(worker);
      } else {
        this.idleWorkers.push(worker);
        this.scheduleWorkerCleanup(worker);
      }
    });
    
    worker.on('error', (error) => {
      const task = this.taskQueue.shift();
      if (task) {
        task.reject(error);
      }
      this.removeWorker(worker);
    });
    
    this.workers.push(worker);
    this.idleWorkers.push(worker);
    
    return worker;
  }
  
  // ワーカーの削除
  private removeWorker(worker: Worker): void {
    const index = this.workers.indexOf(worker);
    if (index > -1) {
      this.workers.splice(index, 1);
    }
    
    const idleIndex = this.idleWorkers.indexOf(worker);
    if (idleIndex > -1) {
      this.idleWorkers.splice(idleIndex, 1);
    }
    
    worker.terminate();
  }
  
  // アイドルワーカーのクリーンアップスケジュール
  private scheduleWorkerCleanup(worker: Worker): void {
    setTimeout(() => {
      if (this.idleWorkers.includes(worker) && 
          this.workers.length > this.options.minWorkers!) {
        this.removeWorker(worker);
      }
    }, this.options.idleTimeout!);
  }
  
  // タスクの実行
  async execute<T, R>(data: T): Promise<R> {
    return new Promise((resolve, reject) => {
      this.taskQueue.push({ data, resolve, reject });
      this.processQueue();
    });
  }
  
  // キューの処理
  private async processQueue(): Promise<void> {
    if (this.taskQueue.length === 0) return;
    
    // アイドルワーカーがあれば使用
    const worker = this.idleWorkers.shift();
    if (worker) {
      this.processNext(worker);
      return;
    }
    
    // 新しいワーカーを作成できるかチェック
    if (this.workers.length < this.options.maxWorkers!) {
      const newWorker = await this.createWorker();
      this.idleWorkers.shift(); // 新しいワーカーをアイドルリストから削除
      this.processNext(newWorker);
    }
  }
  
  // 次のタスクを処理
  private processNext(worker: Worker): void {
    const task = this.taskQueue[0]; // まだshiftしない
    if (!task) {
      this.idleWorkers.push(worker);
      return;
    }
    
    worker.postMessage(task.data);
  }
  
  // 統計情報
  getStats() {
    return {
      totalWorkers: this.workers.length,
      idleWorkers: this.idleWorkers.length,
      busyWorkers: this.workers.length - this.idleWorkers.length,
      queuedTasks: this.taskQueue.length
    };
  }
  
  // 破棄
  async destroy(): Promise<void> {
    // すべてのワーカーを終了
    await Promise.all(this.workers.map(worker => worker.terminate()));
    this.workers = [];
    this.idleWorkers = [];
    this.taskQueue = [];
  }
}

// === 非同期イテレーター ===
export class AsyncIteratorProcessor {
  // 非同期イテレーターの並列処理
  static async *parallelProcess<T, R>(
    source: AsyncIterable<T>,
    processor: (item: T) => Promise<R>,
    concurrency: number = 10
  ): AsyncGenerator<R> {
    const processing = new Map<Promise<R>, { resolve: (value: R) => void }>();
    const results: R[] = [];
    let done = false;
    
    // ソースから読み取り
    const reader = source[Symbol.asyncIterator]();
    
    while (!done || processing.size > 0 || results.length > 0) {
      // 結果があれば yield
      if (results.length > 0) {
        yield results.shift()!;
        continue;
      }
      
      // 並列度に達していない場合は新しいタスクを開始
      while (processing.size < concurrency && !done) {
        const { value, done: isDone } = await reader.next();
        
        if (isDone) {
          done = true;
          break;
        }
        
        const promise = processor(value);
        const handler = { resolve: null as any };
        
        const wrappedPromise = promise.then(result => {
          processing.delete(wrappedPromise);
          handler.resolve(result);
        });
        
        handler.resolve = (result: R) => results.push(result);
        processing.set(wrappedPromise, handler);
      }
      
      // 少なくとも1つの処理が完了するまで待機
      if (processing.size > 0) {
        await Promise.race(processing.keys());
      }
    }
  }
  
  // バッチ処理付き非同期イテレーター
  static async *batchProcess<T>(
    source: AsyncIterable<T>,
    batchSize: number = 100
  ): AsyncGenerator<T[]> {
    const batch: T[] = [];
    
    for await (const item of source) {
      batch.push(item);
      
      if (batch.length >= batchSize) {
        yield batch.splice(0, batchSize);
      }
    }
    
    // 残りのアイテムを yield
    if (batch.length > 0) {
      yield batch;
    }
  }
}

// === デバウンス/スロットル ===
export class AsyncFlowControl {
  // デバウンス（最後の呼び出しのみ実行）
  static debounce<T extends (...args: any[]) => Promise<any>>(
    fn: T,
    delay: number
  ): T {
    let timeoutId: NodeJS.Timeout | undefined;
    let lastPromise: Promise<any> | undefined;
    
    return ((...args: Parameters<T>) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      return new Promise((resolve, reject) => {
        timeoutId = setTimeout(async () => {
          try {
            lastPromise = fn(...args);
            const result = await lastPromise;
            resolve(result);
          } catch (error) {
            reject(error);
          }
        }, delay);
      });
    }) as T;
  }
  
  // スロットル（一定間隔で実行）
  static throttle<T extends (...args: any[]) => Promise<any>>(
    fn: T,
    limit: number
  ): T {
    let inThrottle = false;
    let lastArgs: Parameters<T> | null = null;
    let lastPromise: Promise<any> | undefined;
    
    const executeThrottled = async () => {
      if (lastArgs) {
        const args = lastArgs;
        lastArgs = null;
        lastPromise = fn(...args);
        
        setTimeout(() => {
          inThrottle = false;
          executeThrottled();
        }, limit);
        
        return lastPromise;
      } else {
        inThrottle = false;
      }
    };
    
    return ((...args: Parameters<T>) => {
      lastArgs = args;
      
      if (!inThrottle) {
        inThrottle = true;
        return executeThrottled();
      }
      
      return lastPromise || Promise.resolve();
    }) as T;
  }
}

// === 非同期キャッシュ ===
export class AsyncCache<K, V> {
  private cache = new Map<K, { value: V; expires: number }>();
  private pending = new Map<K, Promise<V>>();
  
  constructor(
    private fetcher: (key: K) => Promise<V>,
    private ttl: number = 60000
  ) {}
  
  // 値の取得（キャッシュまたはフェッチ）
  async get(key: K): Promise<V> {
    // キャッシュチェック
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.value;
    }
    
    // 既に取得中かチェック
    const pending = this.pending.get(key);
    if (pending) {
      return pending;
    }
    
    // 新規取得
    const promise = this.fetcher(key).then(value => {
      this.cache.set(key, {
        value,
        expires: Date.now() + this.ttl
      });
      this.pending.delete(key);
      return value;
    }).catch(error => {
      this.pending.delete(key);
      throw error;
    });
    
    this.pending.set(key, promise);
    return promise;
  }
  
  // キャッシュクリア
  clear(): void {
    this.cache.clear();
  }
  
  // 期限切れエントリの削除
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expires <= now) {
        this.cache.delete(key);
      }
    }
  }
}

// エクスポート
export default {
  AsyncTaskQueue,
  BatchProcessor,
  ParallelProcessor,
  WorkerPool,
  AsyncIteratorProcessor,
  AsyncFlowControl,
  AsyncCache
};