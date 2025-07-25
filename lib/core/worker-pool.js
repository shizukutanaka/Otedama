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
 * Task queue with priority support
 */
class PriorityQueue {
  constructor() {
    this.queues = {
      high: [],
      normal: [],
      low: []
    };
  }
  
  enqueue(task, priority = 'normal') {
    this.queues[priority].push(task);
  }
  
  dequeue() {
    if (this.queues.high.length > 0) {
      return this.queues.high.shift();
    }
    if (this.queues.normal.length > 0) {
      return this.queues.normal.shift();
    }
    if (this.queues.low.length > 0) {
      return this.queues.low.shift();
    }
    return null;
  }
  
  get size() {
    return this.queues.high.length + 
           this.queues.normal.length + 
           this.queues.low.length;
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
   * Auto-scaling logic
   */
  startAutoScaling() {
    this.scaleInterval = setInterval(() => {
      if (this.shouldScaleUp()) {
        this.scaleUp();
      } else if (this.shouldScaleDown()) {
        this.scaleDown();
      }
    }, 5000); // Check every 5 seconds
  }
  
  shouldScaleUp() {
    return this.metrics.workerUtilization > this.options.scaleThreshold &&
           this.workers.size < this.options.maxWorkers &&
           this.taskQueue.size > 0;
  }
  
  shouldScaleDown() {
    return this.metrics.workerUtilization < 0.2 &&
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
