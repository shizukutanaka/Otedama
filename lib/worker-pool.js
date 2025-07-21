/**
 * Worker Pool Manager for Otedama
 * Efficient worker thread management with dynamic scaling
 */

import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import { cpus } from 'os';
import { Logger } from './logger.js';

export class WorkerPool extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || new Logger('WorkerPool');
    this.options = {
      minWorkers: options.minWorkers || 2,
      maxWorkers: options.maxWorkers || cpus().length,
      idleTimeout: options.idleTimeout || 30000, // 30 seconds
      taskTimeout: options.taskTimeout || 60000, // 60 seconds
      workerScript: options.workerScript || './workers/mining-worker.js',
      ...options
    };
    
    // Worker management
    this.workers = [];
    this.idleWorkers = [];
    this.busyWorkers = new Map();
    this.taskQueue = [];
    this.taskCallbacks = new Map();
    
    // Performance tracking
    this.metrics = {
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      avgTaskTime: 0,
      workerUtilization: 0,
      queueLength: 0
    };
    
    // Initialize pool
    this.initialize();
  }
  
  async initialize() {
    // Create minimum workers
    for (let i = 0; i < this.options.minWorkers; i++) {
      await this.createWorker();
    }
    
    // Start monitoring
    this.startMonitoring();
    
    this.logger.info(`Worker pool initialized with ${this.workers.length} workers`);
    this.emit('initialized', { workers: this.workers.length });
  }
  
  async createWorker() {
    try {
      const worker = new Worker(this.options.workerScript);
      const workerId = this.generateWorkerId();
      
      const workerInfo = {
        id: workerId,
        worker,
        state: 'idle',
        createdAt: Date.now(),
        lastUsed: Date.now(),
        tasksCompleted: 0,
        errors: 0
      };
      
      // Setup event handlers
      worker.on('message', (message) => this.handleWorkerMessage(workerId, message));
      worker.on('error', (error) => this.handleWorkerError(workerId, error));
      worker.on('exit', (code) => this.handleWorkerExit(workerId, code));
      
      this.workers.push(workerInfo);
      this.idleWorkers.push(workerId);
      
      this.logger.debug(`Created worker ${workerId}`);
      this.emit('worker:created', { workerId });
      
      return workerInfo;
    } catch (error) {
      this.logger.error('Failed to create worker:', error);
      throw error;
    }
  }
  
  async executeTask(task, callback) {
    const taskId = this.generateTaskId();
    const startTime = Date.now();
    
    // Store callback
    this.taskCallbacks.set(taskId, {
      callback,
      startTime,
      timeout: setTimeout(() => {
        this.handleTaskTimeout(taskId);
      }, this.options.taskTimeout)
    });
    
    // Queue task
    const taskInfo = {
      id: taskId,
      task,
      queued: Date.now()
    };
    
    this.taskQueue.push(taskInfo);
    this.metrics.totalTasks++;
    this.metrics.queueLength = this.taskQueue.length;
    
    // Process queue
    await this.processQueue();
    
    return taskId;
  }
  
  async processQueue() {
    while (this.taskQueue.length > 0 && this.idleWorkers.length > 0) {
      const taskInfo = this.taskQueue.shift();
      const workerId = this.idleWorkers.shift();
      
      await this.assignTask(workerId, taskInfo);
    }
    
    // Scale up if needed
    if (this.taskQueue.length > 0 && this.workers.length < this.options.maxWorkers) {
      await this.scaleUp();
    }
    
    this.metrics.queueLength = this.taskQueue.length;
  }
  
  async assignTask(workerId, taskInfo) {
    const workerInfo = this.workers.find(w => w.id === workerId);
    if (!workerInfo) return;
    
    workerInfo.state = 'busy';
    workerInfo.lastUsed = Date.now();
    this.busyWorkers.set(workerId, taskInfo.id);
    
    // Send task to worker
    workerInfo.worker.postMessage({
      type: 'execute',
      taskId: taskInfo.id,
      task: taskInfo.task
    });
    
    this.logger.debug(`Assigned task ${taskInfo.id} to worker ${workerId}`);
    this.emit('task:assigned', { taskId: taskInfo.id, workerId });
  }
  
  handleWorkerMessage(workerId, message) {
    const { type, taskId, result, error } = message;
    
    if (type === 'result') {
      this.handleTaskComplete(workerId, taskId, result);
    } else if (type === 'error') {
      this.handleTaskError(workerId, taskId, error);
    }
  }
  
  handleTaskComplete(workerId, taskId, result) {
    const taskCallback = this.taskCallbacks.get(taskId);
    if (!taskCallback) return;
    
    // Clear timeout
    clearTimeout(taskCallback.timeout);
    
    // Update metrics
    const duration = Date.now() - taskCallback.startTime;
    this.metrics.completedTasks++;
    this.metrics.avgTaskTime = 
      (this.metrics.avgTaskTime * (this.metrics.completedTasks - 1) + duration) / 
      this.metrics.completedTasks;
    
    // Update worker info
    const workerInfo = this.workers.find(w => w.id === workerId);
    if (workerInfo) {
      workerInfo.state = 'idle';
      workerInfo.tasksCompleted++;
      this.idleWorkers.push(workerId);
      this.busyWorkers.delete(workerId);
    }
    
    // Execute callback
    taskCallback.callback(null, result);
    this.taskCallbacks.delete(taskId);
    
    this.emit('task:complete', { taskId, workerId, duration });
    
    // Process more tasks
    this.processQueue();
  }
  
  handleTaskError(workerId, taskId, error) {
    const taskCallback = this.taskCallbacks.get(taskId);
    if (!taskCallback) return;
    
    // Clear timeout
    clearTimeout(taskCallback.timeout);
    
    // Update metrics
    this.metrics.failedTasks++;
    
    // Update worker info
    const workerInfo = this.workers.find(w => w.id === workerId);
    if (workerInfo) {
      workerInfo.state = 'idle';
      workerInfo.errors++;
      this.idleWorkers.push(workerId);
      this.busyWorkers.delete(workerId);
    }
    
    // Execute callback
    taskCallback.callback(new Error(error));
    this.taskCallbacks.delete(taskId);
    
    this.emit('task:error', { taskId, workerId, error });
    
    // Process more tasks
    this.processQueue();
  }
  
  handleTaskTimeout(taskId) {
    const taskCallback = this.taskCallbacks.get(taskId);
    if (!taskCallback) return;
    
    // Find worker handling this task
    let workerId = null;
    for (const [wId, tId] of this.busyWorkers) {
      if (tId === taskId) {
        workerId = wId;
        break;
      }
    }
    
    if (workerId) {
      // Terminate worker
      const workerInfo = this.workers.find(w => w.id === workerId);
      if (workerInfo) {
        this.terminateWorker(workerId);
      }
    }
    
    // Execute callback with timeout error
    taskCallback.callback(new Error('Task timeout'));
    this.taskCallbacks.delete(taskId);
    
    this.metrics.failedTasks++;
    this.emit('task:timeout', { taskId });
  }
  
  handleWorkerError(workerId, error) {
    this.logger.error(`Worker ${workerId} error:`, error);
    
    const workerInfo = this.workers.find(w => w.id === workerId);
    if (workerInfo) {
      workerInfo.errors++;
      
      // Terminate if too many errors
      if (workerInfo.errors > 5) {
        this.terminateWorker(workerId);
      }
    }
    
    this.emit('worker:error', { workerId, error });
  }
  
  handleWorkerExit(workerId, code) {
    this.logger.info(`Worker ${workerId} exited with code ${code}`);
    
    // Remove from all lists
    this.workers = this.workers.filter(w => w.id !== workerId);
    this.idleWorkers = this.idleWorkers.filter(id => id !== workerId);
    
    // Handle any pending task
    const taskId = this.busyWorkers.get(workerId);
    if (taskId) {
      this.busyWorkers.delete(workerId);
      this.handleTaskError(workerId, taskId, 'Worker exited');
    }
    
    // Ensure minimum workers
    if (this.workers.length < this.options.minWorkers) {
      this.createWorker().catch(error => {
        this.logger.error('Failed to replace worker:', error);
      });
    }
    
    this.emit('worker:exit', { workerId, code });
  }
  
  async scaleUp() {
    if (this.workers.length >= this.options.maxWorkers) return;
    
    try {
      await this.createWorker();
      this.logger.info(`Scaled up to ${this.workers.length} workers`);
      
      // Process queue with new worker
      await this.processQueue();
    } catch (error) {
      this.logger.error('Failed to scale up:', error);
    }
  }
  
  async scaleDown() {
    if (this.workers.length <= this.options.minWorkers) return;
    
    // Find workers that have been idle longest
    const now = Date.now();
    const idleWorkerInfos = this.idleWorkers
      .map(id => this.workers.find(w => w.id === id))
      .filter(w => w && now - w.lastUsed > this.options.idleTimeout)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    
    if (idleWorkerInfos.length > 0) {
      const workerToRemove = idleWorkerInfos[0];
      this.terminateWorker(workerToRemove.id);
      this.logger.info(`Scaled down to ${this.workers.length} workers`);
    }
  }
  
  terminateWorker(workerId) {
    const workerInfo = this.workers.find(w => w.id === workerId);
    if (!workerInfo) return;
    
    // Terminate worker
    workerInfo.worker.terminate();
    
    // Remove from all lists
    this.workers = this.workers.filter(w => w.id !== workerId);
    this.idleWorkers = this.idleWorkers.filter(id => id !== workerId);
    this.busyWorkers.delete(workerId);
    
    this.logger.debug(`Terminated worker ${workerId}`);
    this.emit('worker:terminated', { workerId });
  }
  
  startMonitoring() {
    // Monitor performance and scale
    setInterval(() => {
      this.updateMetrics();
      
      // Scale based on queue length and utilization
      if (this.taskQueue.length > 5 || this.metrics.workerUtilization > 0.8) {
        this.scaleUp();
      } else if (this.metrics.workerUtilization < 0.2) {
        this.scaleDown();
      }
    }, 5000); // Every 5 seconds
    
    // Cleanup old workers
    setInterval(() => {
      this.scaleDown();
    }, 30000); // Every 30 seconds
  }
  
  updateMetrics() {
    const busyCount = this.busyWorkers.size;
    const totalCount = this.workers.length;
    
    this.metrics.workerUtilization = totalCount > 0 ? busyCount / totalCount : 0;
    
    this.emit('metrics:updated', this.metrics);
  }
  
  generateWorkerId() {
    return `worker-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateTaskId() {
    return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  async shutdown() {
    this.logger.info('Shutting down worker pool...');
    
    // Clear task queue
    this.taskQueue = [];
    
    // Cancel all pending tasks
    for (const [taskId, taskCallback] of this.taskCallbacks) {
      clearTimeout(taskCallback.timeout);
      taskCallback.callback(new Error('Worker pool shutdown'));
    }
    this.taskCallbacks.clear();
    
    // Terminate all workers
    for (const workerInfo of this.workers) {
      workerInfo.worker.terminate();
    }
    
    this.workers = [];
    this.idleWorkers = [];
    this.busyWorkers.clear();
    
    this.emit('shutdown');
  }
  
  getMetrics() {
    return {
      ...this.metrics,
      workers: {
        total: this.workers.length,
        idle: this.idleWorkers.length,
        busy: this.busyWorkers.size
      }
    };
  }
}