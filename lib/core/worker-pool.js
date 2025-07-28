/**
 * High-Performance Worker Pool for Otedama
 * Following Carmack's principle: optimize the critical path
 */

import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { PerformanceError } from '../core/errors.js';

const logger = createStructuredLogger('WorkerPool');

/**
 * Min-heap implementation for priority queue
 */
class MinHeap {
  constructor(compareFn) {
    this.heap = [];
    this.compare = compareFn || ((a, b) => a.priority - b.priority);
  }
  
  parent(index) {
    return Math.floor((index - 1) / 2);
  }
  
  leftChild(index) {
    return 2 * index + 1;
  }
  
  rightChild(index) {
    return 2 * index + 2;
  }
  
  swap(index1, index2) {
    [this.heap[index1], this.heap[index2]] = [this.heap[index2], this.heap[index1]];
  }
  
  insert(item) {
    this.heap.push(item);
    this.heapifyUp(this.heap.length - 1);
  }
  
  extractMin() {
    if (this.heap.length === 0) return null;
    if (this.heap.length === 1) return this.heap.pop();
    
    const min = this.heap[0];
    this.heap[0] = this.heap.pop();
    this.heapifyDown(0);
    return min;
  }
  
  heapifyUp(index) {
    const parentIndex = this.parent(index);
    
    if (parentIndex >= 0 && this.compare(this.heap[index], this.heap[parentIndex]) < 0) {
      this.swap(index, parentIndex);
      this.heapifyUp(parentIndex);
    }
  }
  
  heapifyDown(index) {
    const leftIndex = this.leftChild(index);
    const rightIndex = this.rightChild(index);
    let smallest = index;
    
    if (leftIndex < this.heap.length && 
        this.compare(this.heap[leftIndex], this.heap[smallest]) < 0) {
      smallest = leftIndex;
    }
    
    if (rightIndex < this.heap.length && 
        this.compare(this.heap[rightIndex], this.heap[smallest]) < 0) {
      smallest = rightIndex;
    }
    
    if (smallest !== index) {
      this.swap(index, smallest);
      this.heapifyDown(smallest);
    }
  }
  
  get size() {
    return this.heap.length;
  }
  
  peek() {
    return this.heap.length > 0 ? this.heap[0] : null;
  }
}

/**
 * Advanced priority queue with deadline scheduling
 */
class PriorityQueue {
  constructor() {
    // Use min-heap for priority-based scheduling
    this.heap = new MinHeap((a, b) => {
      // First compare by deadline, then by priority
      if (a.deadline && b.deadline) {
        const deadlineDiff = a.deadline - b.deadline;
        if (deadlineDiff !== 0) return deadlineDiff;
      } else if (a.deadline) {
        return -1; // Tasks with deadlines get priority
      } else if (b.deadline) {
        return 1;
      }
      
      // Then by numerical priority (lower number = higher priority)
      const priorityMap = { high: 1, normal: 2, low: 3 };
      return priorityMap[a.priority] - priorityMap[b.priority];
    });
  }
  
  enqueue(task, priority = 'normal', deadline = null) {
    const taskWithMeta = {
      ...task,
      priority,
      deadline,
      enqueueTime: Date.now()
    };
    
    this.heap.insert(taskWithMeta);
  }
  
  dequeue() {
    return this.heap.extractMin();
  }
  
  get size() {
    return this.heap.size;
  }
  
  peek() {
    return this.heap.peek();
  }
}

/**
 * Worker wrapper with lifecycle management
 */
class WorkerWrapper extends EventEmitter {
  constructor(workerPath, options = {}) {
    super();
    
    this.id = crypto.randomUUID();
    this.workerPath = workerPath;
    this.options = options;
    this.worker = null;
    this.state = 'idle';
    this.currentTask = null;
    this.taskCount = 0;
    this.errorCount = 0;
    this.lastError = null;
    
    this.createWorker();
  }
  
  createWorker() {
    this.worker = new Worker(this.workerPath, {
      ...this.options,
      workerData: {
        workerId: this.id,
        ...this.options.workerData
      }
    });
    
    this.worker.on('message', this.handleMessage.bind(this));
    this.worker.on('error', this.handleError.bind(this));
    this.worker.on('exit', this.handleExit.bind(this));
    
    this.state = 'ready';
  }
  
  async execute(task) {
    if (this.state !== 'ready') {
      throw new PerformanceError('Worker not ready', 'WORKER_NOT_READY');
    }
    
    this.state = 'busy';
    this.currentTask = task;
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new PerformanceError('Worker timeout', 'WORKER_TIMEOUT'));
        this.terminate();
      }, task.timeout || 30000);
      
      this.once('result', (result) => {
        clearTimeout(timeout);
        resolve(result);
      });
      
      this.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      
      this.worker.postMessage(task);
    });
  }
  
  handleMessage(message) {
    if (message.type === 'result') {
      this.taskCount++;
      this.state = 'ready';
      this.currentTask = null;
      this.emit('result', message.data);
    } else if (message.type === 'progress') {
      this.emit('progress', message.data);
    } else if (message.type === 'log') {
      logger.debug(`Worker ${this.id}: ${message.data}`);
    }
  }
  
  handleError(error) {
    this.errorCount++;
    this.lastError = error;
    this.state = 'error';
    this.emit('error', error);
  }
  
  handleExit(code) {
    if (code !== 0) {
      logger.error(`Worker ${this.id} exited with code ${code}`);
    }
    this.state = 'terminated';
    this.emit('exit', code);
  }
  
  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.state = 'terminated';
    }
  }
  
  get stats() {
    return {
      id: this.id,
      state: this.state,
      taskCount: this.taskCount,
      errorCount: this.errorCount,
      lastError: this.lastError
    };
  }
}

/**
 * High-Performance Worker Pool
 */
export class WorkerPool extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      workerPath: options.workerPath,
      minWorkers: options.minWorkers || 2,
      maxWorkers: options.maxWorkers || 8,
      maxTasksPerWorker: options.maxTasksPerWorker || 1000,
      workerTimeout: options.workerTimeout || 60000,
      autoScale: options.autoScale !== false,
      scaleThreshold: options.scaleThreshold || 0.8,
      ...options
    };
    
    this.workers = new Map();
    this.taskQueue = new PriorityQueue();
    this.activeTasksCount = 0;
    this.completedTasksCount = 0;
    this.failedTasksCount = 0;
    
    this.initialized = false;
    this.shuttingDown = false;
    
    // Metrics
    this.metrics = {
      tasksQueued: 0,
      tasksExecuted: 0,
      tasksFailed: 0,
      avgExecutionTime: 0,
      workerUtilization: 0
    };
    
    // Auto-scaling
    if (this.options.autoScale) {
      this.startAutoScaling();
    }
  }
  
  /**
   * Initialize the worker pool
   */
  async initialize() {
    if (this.initialized) return;
    
    logger.info('Initializing worker pool', {
      minWorkers: this.options.minWorkers,
      maxWorkers: this.options.maxWorkers
    });
    
    // Create initial workers
    for (let i = 0; i < this.options.minWorkers; i++) {
      await this.createWorker();
    }
    
    this.initialized = true;
    this.emit('initialized');
    
    // Start processing queue
    this.processQueue();
  }
  
  /**
   * Create a new worker
   */
  async createWorker() {
    if (this.workers.size >= this.options.maxWorkers) {
      logger.warn('Max workers reached', {
        current: this.workers.size,
        max: this.options.maxWorkers
      });
      return null;
    }
    
    const worker = new WorkerWrapper(this.options.workerPath, {
      workerData: this.options.workerData
    });
    
    worker.on('exit', () => {
      this.workers.delete(worker.id);
      
      // Replace worker if not shutting down
      if (!this.shuttingDown && this.workers.size < this.options.minWorkers) {
        this.createWorker();
      }
    });
    
    this.workers.set(worker.id, worker);
    
    logger.debug('Worker created', {
      workerId: worker.id,
      totalWorkers: this.workers.size
    });
    
    return worker;
  }
  
  /**
   * Execute a task
   */
  async execute(taskData, options = {}) {
    if (!this.initialized) {
      throw new PerformanceError('Worker pool not initialized', 'POOL_NOT_INITIALIZED');
    }
    
    const task = {
      id: crypto.randomUUID(),
      data: taskData,
      priority: options.priority || 'normal',
      timeout: options.timeout || this.options.workerTimeout,
      timestamp: Date.now()
    };
    
    return new Promise((resolve, reject) => {
      task.callback = { resolve, reject };
      
      this.taskQueue.enqueue(task, task.priority);
      this.metrics.tasksQueued++;
      
      // Trigger queue processing
      setImmediate(() => this.processQueue());
    });
  }
  
  /**
   * Process the task queue
   */
  async processQueue() {
    if (this.shuttingDown) return;
    
    while (this.taskQueue.size > 0) {
      const worker = this.getAvailableWorker();
      
      if (!worker) {
        // No available workers, try auto-scaling
        if (this.options.autoScale && this.shouldScaleUp()) {
          await this.scaleUp();
        }
        
        // Wait and retry
        setTimeout(() => this.processQueue(), 100);
        return;
      }
      
      const task = this.taskQueue.dequeue();
      if (!task) break;
      
      this.executeTask(worker, task);
    }
  }
  
  /**
   * Execute a task on a worker
   */
  async executeTask(worker, task) {
    const startTime = Date.now();
    this.activeTasksCount++;
    
    try {
      const result = await worker.execute(task);
      
      const executionTime = Date.now() - startTime;
      this.updateMetrics(executionTime, true);
      
      task.callback.resolve(result);
      
      this.completedTasksCount++;
      this.emit('task:completed', {
        taskId: task.id,
        workerId: worker.id,
        executionTime
      });
      
    } catch (error) {
      this.updateMetrics(Date.now() - startTime, false);
      
      task.callback.reject(error);
      
      this.failedTasksCount++;
      this.emit('task:failed', {
        taskId: task.id,
        workerId: worker.id,
        error
      });
      
      // Handle worker errors
      if (worker.state === 'error' || worker.state === 'terminated') {
        this.workers.delete(worker.id);
        
        // Replace failed worker
        if (this.workers.size < this.options.minWorkers) {
          await this.createWorker();
        }
      }
      
    } finally {
      this.activeTasksCount--;
      
      // Continue processing queue
      setImmediate(() => this.processQueue());
    }
  }
  
  /**
   * Get an available worker
   */
  getAvailableWorker() {
    for (const worker of this.workers.values()) {
      if (worker.state === 'ready' && 
          worker.taskCount < this.options.maxTasksPerWorker) {
        return worker;
      }
    }
    return null;
  }
  
  /**
   * Update metrics
   */
  updateMetrics(executionTime, success) {
    if (success) {
      this.metrics.tasksExecuted++;
      
      // Update average execution time
      const total = this.metrics.avgExecutionTime * (this.metrics.tasksExecuted - 1);
      this.metrics.avgExecutionTime = (total + executionTime) / this.metrics.tasksExecuted;
    } else {
      this.metrics.tasksFailed++;
    }
    
    // Calculate worker utilization
    const busyWorkers = Array.from(this.workers.values())
      .filter(w => w.state === 'busy').length;
    this.metrics.workerUtilization = this.workers.size > 0 ? 
      busyWorkers / this.workers.size : 0;
  }
  
  /**
   * Predictive auto-scaling logic
   */
  startAutoScaling() {
    // Track throughput history for prediction
    this.throughputHistory = [];
    this.maxHistorySize = 60; // Keep 5 minutes of history (5s intervals)
    
    this.scaleInterval = setInterval(() => {
      this.recordThroughput();
      
      if (this.shouldScaleUp()) {
        this.scaleUp();
      } else if (this.shouldScaleDown()) {
        this.scaleDown();
      }
    }, 5000); // Check every 5 seconds
  }

  /**
   * Record current throughput for prediction
   */
  recordThroughput() {
    const currentTime = Date.now();
    const throughput = {
      timestamp: currentTime,
      queueSize: this.taskQueue.size,
      activeWorkers: this.workers.size,
      utilization: this.metrics.workerUtilization,
      avgExecutionTime: this.metrics.avgExecutionTime
    };
    
    this.throughputHistory.push(throughput);
    
    if (this.throughputHistory.length > this.maxHistorySize) {
      this.throughputHistory.shift();
    }
  }

  /**
   * Predict future load based on historical patterns
   */
  predictFutureLoad(lookAheadSeconds = 30) {
    if (this.throughputHistory.length < 3) return this.taskQueue.size;
    
    // Simple linear regression for trend prediction
    const recent = this.throughputHistory.slice(-6); // Last 30 seconds
    const n = recent.length;
    
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    for (let i = 0; i < n; i++) {
      const x = i;
      const y = recent[i].queueSize;
      
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // Predict queue size after lookAheadSeconds
    const futureX = n + (lookAheadSeconds / 5); // 5 second intervals
    const predictedQueueSize = Math.max(0, slope * futureX + intercept);
    
    return predictedQueueSize;
  }
  
  shouldScaleUp() {
    const currentUtilization = this.metrics.workerUtilization;
    const predictedLoad = this.predictFutureLoad();
    const currentCapacity = this.workers.size;
    
    // Scale up if current utilization is high OR predicted load will exceed capacity
    const utilizationThreshold = currentUtilization > this.options.scaleThreshold;
    const predictiveThreshold = predictedLoad > currentCapacity * 0.8;
    
    return (utilizationThreshold || predictiveThreshold) &&
           this.workers.size < this.options.maxWorkers &&
           this.taskQueue.size > 0;
  }
  
  shouldScaleDown() {
    const currentUtilization = this.metrics.workerUtilization;
    const predictedLoad = this.predictFutureLoad();
    const currentCapacity = this.workers.size;
    
    // Scale down if utilization is low AND predicted load doesn't require current capacity
    return currentUtilization < 0.2 &&
           predictedLoad < (currentCapacity - 1) * 0.5 &&
           this.workers.size > this.options.minWorkers &&
           this.taskQueue.size === 0;
  }
  
  async scaleUp() {
    const worker = await this.createWorker();
    if (worker) {
      logger.info('Scaled up worker pool', {
        totalWorkers: this.workers.size
      });
    }
  }
  
  scaleDown() {
    // Find idle worker with least tasks
    let targetWorker = null;
    let minTasks = Infinity;
    
    for (const worker of this.workers.values()) {
      if (worker.state === 'ready' && worker.taskCount < minTasks) {
        targetWorker = worker;
        minTasks = worker.taskCount;
      }
    }
    
    if (targetWorker) {
      targetWorker.terminate();
      this.workers.delete(targetWorker.id);
      
      logger.info('Scaled down worker pool', {
        totalWorkers: this.workers.size
      });
    }
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    const workerStats = Array.from(this.workers.values())
      .map(w => w.stats);
    
    return {
      workers: workerStats,
      workerCount: this.workers.size,
      queueSize: this.taskQueue.size,
      activeTasksCount: this.activeTasksCount,
      completedTasksCount: this.completedTasksCount,
      failedTasksCount: this.failedTasksCount,
      metrics: this.metrics
    };
  }
  
  /**
   * Shutdown the pool
   */
  async shutdown() {
    logger.info('Shutting down worker pool');
    
    this.shuttingDown = true;
    
    // Clear auto-scaling
    if (this.scaleInterval) {
      clearInterval(this.scaleInterval);
    }
    
    // Wait for active tasks
    while (this.activeTasksCount > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Terminate all workers
    for (const worker of this.workers.values()) {
      worker.terminate();
    }
    
    this.workers.clear();
    this.initialized = false;
    
    logger.info('Worker pool shut down');
  }
}

/**
 * Create specialized worker pools
 */
export function createMiningWorkerPool(options = {}) {
  return new WorkerPool({
    workerPath: './lib/workers/mining-worker.js',
    minWorkers: 4,
    maxWorkers: 16,
    ...options
  });
}

export function createValidationWorkerPool(options = {}) {
  return new WorkerPool({
    workerPath: './lib/workers/validation-worker.js',
    minWorkers: 2,
    maxWorkers: 8,
    ...options
  });
}

export function createZKPWorkerPool(options = {}) {
  return new WorkerPool({
    workerPath: './lib/workers/zkp-worker.js',
    minWorkers: 2,
    maxWorkers: 4,
    ...options
  });
}

export default WorkerPool;
