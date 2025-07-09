import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import * as os from 'os';

/**
 * Async Processing Optimization System
 * Following John Carmack's performance principles and Rob Pike's concurrency patterns
 * Optimized async/await usage with worker pools and task queuing
 */

// ===== Task Types and Interfaces =====
export interface Task<T = any> {
  id: string;
  type: string;
  data: T;
  priority: number;
  timeout?: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  retries: number;
  maxRetries: number;
}

export interface TaskResult<T = any> {
  taskId: string;
  success: boolean;
  result?: T;
  error?: Error;
  duration: number;
}

export enum TaskPriority {
  LOW = 0,
  NORMAL = 1,
  HIGH = 2,
  CRITICAL = 3
}

// ===== Async Queue Implementation =====
export class PriorityQueue<T> {
  private heap: T[] = [];
  
  constructor(private compareFn: (a: T, b: T) => number) {}
  
  push(item: T): void {
    this.heap.push(item);
    this.bubbleUp(this.heap.length - 1);
  }
  
  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) return this.heap.pop();
    
    const result = this.heap[0];
    this.heap[0] = this.heap.pop()!;
    this.bubbleDown(0);
    return result;
  }
  
  peek(): T | undefined {
    return this.heap[0];
  }
  
  get size(): number {
    return this.heap.length;
  }
  
  isEmpty(): boolean {
    return this.heap.length === 0;
  }
  
  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.compareFn(this.heap[index], this.heap[parentIndex]) >= 0) break;
      
      [this.heap[index], this.heap[parentIndex]] = 
        [this.heap[parentIndex], this.heap[index]];
      index = parentIndex;
    }
  }
  
  private bubbleDown(index: number): void {
    while (true) {
      let minIndex = index;
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      
      if (leftChild < this.heap.length && 
          this.compareFn(this.heap[leftChild], this.heap[minIndex]) < 0) {
        minIndex = leftChild;
      }
      
      if (rightChild < this.heap.length && 
          this.compareFn(this.heap[rightChild], this.heap[minIndex]) < 0) {
        minIndex = rightChild;
      }
      
      if (minIndex === index) break;
      
      [this.heap[index], this.heap[minIndex]] = 
        [this.heap[minIndex], this.heap[index]];
      index = minIndex;
    }
  }
}

// ===== Task Queue Manager =====
export class TaskQueue extends EventEmitter {
  private queue: PriorityQueue<Task>;
  private activeTasks = new Map<string, Task>();
  private completedTasks = new Map<string, TaskResult>();
  private taskHandlers = new Map<string, (task: Task) => Promise<any>>();
  private processing = false;
  private concurrency: number;
  
  constructor(concurrency: number = os.cpus().length) {
    super();
    this.concurrency = concurrency;
    this.queue = new PriorityQueue<Task>((a, b) => {
      // Higher priority first, then older tasks
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return a.createdAt - b.createdAt;
    });
  }
  
  registerHandler<T>(taskType: string, handler: (task: Task<T>) => Promise<any>): void {
    this.taskHandlers.set(taskType, handler);
  }
  
  async enqueue<T>(task: Omit<Task<T>, 'id' | 'createdAt' | 'retries'>): Promise<string> {
    const fullTask: Task<T> = {
      ...task,
      id: this.generateTaskId(),
      createdAt: Date.now(),
      retries: 0,
      maxRetries: task.maxRetries || 3
    };
    
    this.queue.push(fullTask);
    this.emit('taskEnqueued', fullTask);
    
    // Start processing if not already running
    if (!this.processing) {
      this.startProcessing();
    }
    
    return fullTask.id;
  }
  
  private async startProcessing(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    
    while (!this.queue.isEmpty() || this.activeTasks.size > 0) {
      // Process up to concurrency limit
      while (this.activeTasks.size < this.concurrency && !this.queue.isEmpty()) {
        const task = this.queue.pop()!;
        this.processTask(task);
      }
      
      // Wait a bit before checking again
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    this.processing = false;
  }
  
  private async processTask(task: Task): Promise<void> {
    const handler = this.taskHandlers.get(task.type);
    if (!handler) {
      this.completeTask(task, {
        taskId: task.id,
        success: false,
        error: new Error(`No handler for task type: ${task.type}`),
        duration: 0
      });
      return;
    }
    
    task.startedAt = Date.now();
    this.activeTasks.set(task.id, task);
    this.emit('taskStarted', task);
    
    try {
      // Apply timeout if specified
      const timeoutPromise = task.timeout ? 
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Task timeout')), task.timeout)
        ) : null;
      
      const result = timeoutPromise ? 
        await Promise.race([handler(task), timeoutPromise]) :
        await handler(task);
      
      task.completedAt = Date.now();
      const taskResult: TaskResult = {
        taskId: task.id,
        success: true,
        result,
        duration: task.completedAt - task.startedAt!
      };
      
      this.completeTask(task, taskResult);
    } catch (error) {
      task.completedAt = Date.now();
      const taskResult: TaskResult = {
        taskId: task.id,
        success: false,
        error: error as Error,
        duration: task.completedAt - task.startedAt!
      };
      
      // Retry if possible
      if (task.retries < task.maxRetries) {
        task.retries++;
        task.startedAt = undefined;
        task.completedAt = undefined;
        this.activeTasks.delete(task.id);
        
        // Exponential backoff
        const delay = Math.pow(2, task.retries) * 1000;
        setTimeout(() => this.queue.push(task), delay);
        
        this.emit('taskRetrying', task);
      } else {
        this.completeTask(task, taskResult);
      }
    }
  }
  
  private completeTask(task: Task, result: TaskResult): void {
    this.activeTasks.delete(task.id);
    this.completedTasks.set(task.id, result);
    
    this.emit('taskCompleted', result);
    
    // Clean up old completed tasks
    if (this.completedTasks.size > 1000) {
      const oldestIds = Array.from(this.completedTasks.keys()).slice(0, 100);
      oldestIds.forEach(id => this.completedTasks.delete(id));
    }
  }
  
  getTaskResult(taskId: string): TaskResult | undefined {
    return this.completedTasks.get(taskId);
  }
  
  async waitForTask(taskId: string, timeout?: number): Promise<TaskResult> {
    // Check if already completed
    const existing = this.completedTasks.get(taskId);
    if (existing) return existing;
    
    return new Promise((resolve, reject) => {
      const timeoutId = timeout ? setTimeout(() => {
        this.off('taskCompleted', handler);
        reject(new Error('Wait timeout'));
      }, timeout) : null;
      
      const handler = (result: TaskResult) => {
        if (result.taskId === taskId) {
          if (timeoutId) clearTimeout(timeoutId);
          this.off('taskCompleted', handler);
          resolve(result);
        }
      };
      
      this.on('taskCompleted', handler);
    });
  }
  
  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  getStats() {
    return {
      queued: this.queue.size,
      active: this.activeTasks.size,
      completed: this.completedTasks.size,
      processing: this.processing
    };
  }
}

// ===== Worker Pool for CPU-Intensive Tasks =====
export class WorkerPool extends EventEmitter {
  private workers: Worker[] = [];
  private availableWorkers: Worker[] = [];
  private taskQueue: Array<{
    task: any;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }> = [];
  
  constructor(
    private workerScript: string,
    private poolSize: number = os.cpus().length
  ) {
    super();
    this.initializeWorkers();
  }
  
  private initializeWorkers(): void {
    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(this.workerScript);
      
      worker.on('message', (result) => {
        this.handleWorkerMessage(worker, result);
      });
      
      worker.on('error', (error) => {
        this.emit('workerError', { worker, error });
      });
      
      worker.on('exit', (code) => {
        this.handleWorkerExit(worker, code);
      });
      
      this.workers.push(worker);
      this.availableWorkers.push(worker);
    }
  }
  
  async execute<T, R>(task: T): Promise<R> {
    return new Promise((resolve, reject) => {
      const worker = this.availableWorkers.pop();
      
      if (worker) {
        this.sendTaskToWorker(worker, task, resolve, reject);
      } else {
        // Queue the task
        this.taskQueue.push({ task, resolve, reject });
      }
    });
  }
  
  private sendTaskToWorker(
    worker: Worker, 
    task: any, 
    resolve: (value: any) => void, 
    reject: (error: Error) => void
  ): void {
    const taskId = this.generateTaskId();
    
    // Store the resolver and rejector
    (worker as any).__currentTask = { taskId, resolve, reject };
    
    worker.postMessage({ taskId, task });
  }
  
  private handleWorkerMessage(worker: Worker, message: any): void {
    const currentTask = (worker as any).__currentTask;
    if (!currentTask) return;
    
    const { resolve, reject } = currentTask;
    delete (worker as any).__currentTask;
    
    if (message.error) {
      reject(new Error(message.error));
    } else {
      resolve(message.result);
    }
    
    // Process queued tasks
    if (this.taskQueue.length > 0) {
      const nextTask = this.taskQueue.shift()!;
      this.sendTaskToWorker(worker, nextTask.task, nextTask.resolve, nextTask.reject);
    } else {
      this.availableWorkers.push(worker);
    }
  }
  
  private handleWorkerExit(worker: Worker, code: number): void {
    const index = this.workers.indexOf(worker);
    if (index !== -1) {
      this.workers.splice(index, 1);
    }
    
    const availableIndex = this.availableWorkers.indexOf(worker);
    if (availableIndex !== -1) {
      this.availableWorkers.splice(availableIndex, 1);
    }
    
    // Restart worker if exit was unexpected
    if (code !== 0) {
      this.emit('workerCrashed', { code });
      this.addWorker();
    }
  }
  
  private addWorker(): void {
    const worker = new Worker(this.workerScript);
    
    worker.on('message', (result) => {
      this.handleWorkerMessage(worker, result);
    });
    
    worker.on('error', (error) => {
      this.emit('workerError', { worker, error });
    });
    
    worker.on('exit', (code) => {
      this.handleWorkerExit(worker, code);
    });
    
    this.workers.push(worker);
    this.availableWorkers.push(worker);
  }
  
  async terminate(): Promise<void> {
    await Promise.all(this.workers.map(worker => worker.terminate()));
    this.workers = [];
    this.availableWorkers = [];
    this.taskQueue = [];
  }
  
  private generateTaskId(): string {
    return `worker_task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  getStats() {
    return {
      totalWorkers: this.workers.length,
      availableWorkers: this.availableWorkers.length,
      queuedTasks: this.taskQueue.length
    };
  }
}

// ===== Batch Processing =====
export class BatchProcessor<T, R> {
  private batch: T[] = [];
  private batchPromises: Array<{
    resolve: (value: R) => void;
    reject: (error: Error) => void;
  }> = [];
  private timer?: NodeJS.Timeout;
  
  constructor(
    private processBatch: (items: T[]) => Promise<R[]>,
    private batchSize: number = 100,
    private batchTimeout: number = 100
  ) {}
  
  async add(item: T): Promise<R> {
    return new Promise((resolve, reject) => {
      this.batch.push(item);
      this.batchPromises.push({ resolve, reject });
      
      if (this.batch.length >= this.batchSize) {
        this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.batchTimeout);
      }
    });
  }
  
  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    
    if (this.batch.length === 0) return;
    
    const currentBatch = this.batch;
    const currentPromises = this.batchPromises;
    
    this.batch = [];
    this.batchPromises = [];
    
    try {
      const results = await this.processBatch(currentBatch);
      
      if (results.length !== currentBatch.length) {
        throw new Error('Batch processor returned wrong number of results');
      }
      
      currentPromises.forEach((promise, index) => {
        promise.resolve(results[index]);
      });
    } catch (error) {
      currentPromises.forEach(promise => {
        promise.reject(error as Error);
      });
    }
  }
  
  async forceFlush(): Promise<void> {
    await this.flush();
  }
}

// ===== Rate Limiter =====
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private queue: Array<() => void> = [];
  
  constructor(
    private maxTokens: number,
    private refillRate: number, // tokens per second
    private refillInterval: number = 100 // ms
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
    this.startRefillTimer();
  }
  
  private startRefillTimer(): void {
    setInterval(() => {
      this.refill();
      this.processQueue();
    }, this.refillInterval);
  }
  
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsed * this.refillRate;
    
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
  
  async acquire(tokens: number = 1): Promise<void> {
    if (tokens > this.maxTokens) {
      throw new Error(`Cannot acquire ${tokens} tokens, max is ${this.maxTokens}`);
    }
    
    return new Promise(resolve => {
      const tryAcquire = () => {
        if (this.tokens >= tokens) {
          this.tokens -= tokens;
          resolve();
          return true;
        }
        return false;
      };
      
      if (!tryAcquire()) {
        this.queue.push(() => {
          if (tryAcquire()) {
            this.processQueue();
          } else {
            // Re-queue if still not enough tokens
            this.queue.push(tryAcquire);
          }
        });
      }
    });
  }
  
  private processQueue(): void {
    while (this.queue.length > 0 && this.tokens > 0) {
      const fn = this.queue.shift()!;
      fn();
    }
  }
  
  getAvailableTokens(): number {
    return Math.floor(this.tokens);
  }
}

// ===== Async Utilities =====
export async function asyncPool<T, R>(
  items: T[],
  poolSize: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];
  
  for (const item of items) {
    const promise = fn(item).then(result => {
      results.push(result);
    });
    
    executing.push(promise);
    
    if (executing.length >= poolSize) {
      await Promise.race(executing);
      executing.splice(executing.findIndex(p => p === promise), 1);
    }
  }
  
  await Promise.all(executing);
  return results;
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    delay?: number;
    backoff?: number;
    onError?: (error: Error, attempt: number) => void;
  } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    delay = 1000,
    backoff = 2,
    onError
  } = options;
  
  let lastError: Error;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      if (onError) {
        onError(lastError, attempt);
      }
      
      if (attempt < maxAttempts) {
        const waitTime = delay * Math.pow(backoff, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  throw lastError!;
}

export function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error('Timeout')), ms)
    )
  ]);
}

export async function throttle<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  wait: number
): Promise<T> {
  let lastCall = 0;
  
  return (async (...args: Parameters<T>) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    
    if (timeSinceLastCall < wait) {
      await new Promise(resolve => 
        setTimeout(resolve, wait - timeSinceLastCall)
      );
    }
    
    lastCall = Date.now();
    return fn(...args);
  }) as T;
}

// ===== Performance Monitor =====
export class AsyncPerformanceMonitor {
  private metrics = new Map<string, {
    count: number;
    totalDuration: number;
    minDuration: number;
    maxDuration: number;
    errors: number;
  }>();
  
  async measure<T>(
    name: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const start = process.hrtime.bigint();
    
    try {
      const result = await fn();
      const duration = Number(process.hrtime.bigint() - start) / 1e6; // Convert to ms
      
      this.recordMetric(name, duration, false);
      return result;
    } catch (error) {
      const duration = Number(process.hrtime.bigint() - start) / 1e6;
      this.recordMetric(name, duration, true);
      throw error;
    }
  }
  
  private recordMetric(name: string, duration: number, error: boolean): void {
    const existing = this.metrics.get(name) || {
      count: 0,
      totalDuration: 0,
      minDuration: Infinity,
      maxDuration: 0,
      errors: 0
    };
    
    existing.count++;
    existing.totalDuration += duration;
    existing.minDuration = Math.min(existing.minDuration, duration);
    existing.maxDuration = Math.max(existing.maxDuration, duration);
    if (error) existing.errors++;
    
    this.metrics.set(name, existing);
  }
  
  getMetrics(name?: string) {
    if (name) {
      const metric = this.metrics.get(name);
      if (!metric) return null;
      
      return {
        name,
        ...metric,
        avgDuration: metric.totalDuration / metric.count,
        errorRate: metric.errors / metric.count
      };
    }
    
    const allMetrics: any[] = [];
    this.metrics.forEach((metric, name) => {
      allMetrics.push({
        name,
        ...metric,
        avgDuration: metric.totalDuration / metric.count,
        errorRate: metric.errors / metric.count
      });
    });
    
    return allMetrics;
  }
  
  reset(name?: string): void {
    if (name) {
      this.metrics.delete(name);
    } else {
      this.metrics.clear();
    }
  }
}