/**
 * Worker Pool Manager for Otedama
 * Efficient worker thread management with dynamic scaling
 */

import { Worker } from 'worker_threads';
import { cpus } from 'os';
import BasePool from './common/base-pool.js';

export class WorkerPool extends BasePool {
  constructor(options = {}) {
    super('WorkerPool', {
      // Map to BasePool configuration
      minSize: options.minWorkers || 2,
      maxSize: options.maxWorkers || cpus().length,
      idleTimeout: options.idleTimeout || 30000,
      acquireTimeout: options.taskTimeout || 60000,
      
      // Worker-specific options
      workerScript: options.workerScript || './workers/mining-worker.js',
      taskTimeout: options.taskTimeout || 60000,
      
      ...options
    });
    
    // Task management
    this.taskQueue = [];
    this.taskCallbacks = new Map();
    this.workerMap = new Map(); // Maps Worker resource to metadata
    
    // Task-specific metrics
    this.taskMetrics = {
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      avgTaskTime: 0,
      queueLength: 0
    };
  }
  
  /**
   * Initialize the worker pool
   */
  async onInitialize() {
    // Start task monitoring
    this.startTimer('taskMonitor', () => this.monitorTasks(), 5000);
    this.startTimer('scaleMonitor', () => this.checkScaling(), 30000);
  }
  
  /**
   * Create a worker resource
   */
  async onCreateResource() {
    const worker = new Worker(this.config.workerScript);
    const workerId = this.generateWorkerId();
    
    const workerInfo = {
      id: workerId,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      tasksCompleted: 0,
      errors: 0,
      currentTask: null
    };
    
    // Store metadata
    this.workerMap.set(worker, workerInfo);
    
    // Setup event handlers
    worker.on('message', (message) => this.handleWorkerMessage(worker, message));
    worker.on('error', (error) => this.handleWorkerError(worker, error));
    worker.on('exit', (code) => this.handleWorkerExit(worker, code));
    
    this.logger.debug(`Created worker ${workerId}`);
    this.emit('worker:created', { workerId });
    
    return worker; // Return the Worker as the resource
  }
  
  /**
   * Destroy a worker resource
   */
  async onDestroyResource(worker) {
    const workerInfo = this.workerMap.get(worker);
    if (!workerInfo) return;
    
    await worker.terminate();
    this.workerMap.delete(worker);
    
    this.logger.debug(`Destroyed worker ${workerInfo.id}`);
    this.emit('worker:destroyed', { workerId: workerInfo.id });
  }
  
  /**
   * Validate a worker resource
   */
  async onValidateResource(worker) {
    if (!worker || worker.threadId === -1) return false;
    
    const workerInfo = this.workerMap.get(worker);
    if (!workerInfo) return false;
    
    // Check if worker has too many errors
    if (workerInfo.errors > 5) return false;
    
    return true;
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
      }, this.config.taskTimeout)
    });
    
    // Queue task
    const taskInfo = {
      id: taskId,
      task,
      queued: Date.now()
    };
    
    this.taskQueue.push(taskInfo);
    this.taskMetrics.totalTasks++;
    this.taskMetrics.queueLength = this.taskQueue.length;
    
    // Process queue
    await this.processQueue();
    
    return taskId;
  }
  
  async processQueue() {
    while (this.taskQueue.length > 0) {
      try {
        // Get an available worker from the pool
        const worker = await this.acquire();
        const taskInfo = this.taskQueue.shift();
        
        if (taskInfo) {
          await this.assignTask(worker, taskInfo);
        } else {
          // No task, release the worker
          await this.release(worker);
        }
      } catch (error) {
        // Could not acquire worker (timeout or pool full)
        this.logger.debug('Could not acquire worker:', error.message);
        break;
      }
    }
    
    this.taskMetrics.queueLength = this.taskQueue.length;
  }
  
  async assignTask(worker, taskInfo) {
    const workerInfo = this.workerMap.get(worker);
    if (!workerInfo) return;
    
    workerInfo.lastUsed = Date.now();
    workerInfo.currentTask = taskInfo.id;
    
    // Send task to worker
    worker.postMessage({
      type: 'execute',
      taskId: taskInfo.id,
      task: taskInfo.task
    });
    
    this.logger.debug(`Assigned task ${taskInfo.id} to worker ${workerInfo.id}`);
    this.emit('task:assigned', { taskId: taskInfo.id, workerId: workerInfo.id });
  }
  
  handleWorkerMessage(worker, message) {
    const { type, taskId, result, error } = message;
    
    if (type === 'result') {
      this.handleTaskComplete(worker, taskId, result);
    } else if (type === 'error') {
      this.handleTaskError(worker, taskId, error);
    }
  }
  
  handleTaskComplete(worker, taskId, result) {
    const taskCallback = this.taskCallbacks.get(taskId);
    if (!taskCallback) return;
    
    // Clear timeout
    clearTimeout(taskCallback.timeout);
    
    // Update metrics
    const duration = Date.now() - taskCallback.startTime;
    this.taskMetrics.completedTasks++;
    this.taskMetrics.avgTaskTime = 
      (this.taskMetrics.avgTaskTime * (this.taskMetrics.completedTasks - 1) + duration) / 
      this.taskMetrics.completedTasks;
    
    // Update worker info
    const workerInfo = this.workerMap.get(worker);
    if (workerInfo) {
      workerInfo.tasksCompleted++;
      workerInfo.currentTask = null;
    }
    
    // Release worker back to pool
    this.release(worker);
    
    // Execute callback
    taskCallback.callback(null, result);
    this.taskCallbacks.delete(taskId);
    
    this.recordSuccess();
    this.emit('task:complete', { taskId, workerId: workerInfo?.id, duration });
    
    // Process more tasks
    this.processQueue();
  }
  
  handleTaskError(worker, taskId, error) {
    const taskCallback = this.taskCallbacks.get(taskId);
    if (!taskCallback) return;
    
    // Clear timeout
    clearTimeout(taskCallback.timeout);
    
    // Update metrics
    this.taskMetrics.failedTasks++;
    
    // Update worker info
    const workerInfo = this.workerMap.get(worker);
    if (workerInfo) {
      workerInfo.errors++;
      workerInfo.currentTask = null;
    }
    
    // Release worker back to pool
    this.release(worker);
    
    // Execute callback
    const errorObj = new Error(error);
    taskCallback.callback(errorObj);
    this.taskCallbacks.delete(taskId);
    
    this.recordFailure(errorObj);
    this.emit('task:error', { taskId, workerId: workerInfo?.id, error });
    
    // Process more tasks
    this.processQueue();
  }
  
  handleTaskTimeout(taskId) {
    const taskCallback = this.taskCallbacks.get(taskId);
    if (!taskCallback) return;
    
    // Find worker handling this task
    let workerToTerminate = null;
    for (const [worker, info] of this.workerMap.entries()) {
      if (info.currentTask === taskId) {
        workerToTerminate = worker;
        break;
      }
    }
    
    if (workerToTerminate) {
      // Destroy the worker resource through BasePool
      this.destroyResource(workerToTerminate);
    }
    
    // Execute callback with timeout error
    const error = new Error('Task timeout');
    taskCallback.callback(error);
    this.taskCallbacks.delete(taskId);
    
    this.taskMetrics.failedTasks++;
    this.recordFailure(error);
    this.emit('task:timeout', { taskId });
  }
  
  handleWorkerError(worker, error) {
    const workerInfo = this.workerMap.get(worker);
    if (!workerInfo) return;
    
    this.logger.error(`Worker ${workerInfo.id} error:`, error);
    workerInfo.errors++;
    
    // BasePool will handle termination through validation
    this.emit('worker:error', { workerId: workerInfo.id, error });
  }
  
  handleWorkerExit(worker, code) {
    const workerInfo = this.workerMap.get(worker);
    if (!workerInfo) return;
    
    this.logger.info(`Worker ${workerInfo.id} exited with code ${code}`);
    
    // Handle any pending task
    if (workerInfo.currentTask) {
      this.handleTaskError(worker, workerInfo.currentTask, 'Worker exited');
    }
    
    // BasePool will handle recreation through its mechanisms
    this.emit('worker:exit', { workerId: workerInfo.id, code });
  }
  
  /**
   * Monitor tasks and adjust pool size
   */
  async monitorTasks() {
    this.updateTaskMetrics();
    
    const stats = await this.getPoolStats();
    const utilization = stats.totalSize > 0 ? stats.busySize / stats.totalSize : 0;
    
    // BasePool will handle scaling based on demand
    if (this.taskQueue.length > 5 || utilization > 0.8) {
      // High demand - BasePool will create more resources as needed
      this.emit('high:demand', { queueLength: this.taskQueue.length, utilization });
    }
  }
  
  /**
   * Check for scaling opportunities
   */
  async checkScaling() {
    // BasePool handles idle timeout and resource eviction automatically
    // We just need to trigger eviction check
    await this.evictIdleResources();
  }
  
  updateTaskMetrics() {
    // Task metrics are updated inline, this is just for periodic updates
    this.emit('metrics:updated', this.getMetrics());
  }
  
  generateWorkerId() {
    return `worker-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateTaskId() {
    return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Shutdown the worker pool
   */
  async onShutdown() {
    // Clear task queue
    this.taskQueue = [];
    
    // Cancel all pending tasks
    for (const [taskId, taskCallback] of this.taskCallbacks) {
      clearTimeout(taskCallback.timeout);
      taskCallback.callback(new Error('Worker pool shutdown'));
    }
    this.taskCallbacks.clear();
    
    // BasePool will handle worker termination
  }
  
  /**
   * Get pool statistics
   */
  async getStats() {
    const baseStats = await this.getPoolStats();
    
    return {
      ...baseStats,
      tasks: {
        ...this.taskMetrics,
        queueLength: this.taskQueue.length,
        pendingCallbacks: this.taskCallbacks.size
      }
    };
  }
  
  // Alias for backward compatibility
  getMetrics() {
    return this.getStats();
  }
}