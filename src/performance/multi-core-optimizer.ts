// Multi-core CPU Optimization System
import * as cluster from 'cluster';
import * as os from 'os';
import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { performance } from 'perf_hooks';

interface WorkerPoolConfig {
  minWorkers: number;
  maxWorkers: number;
  idleTimeout: number;
  taskQueueSize: number;
  enableCPUAffinity: boolean;
  enableNUMA: boolean;
}

interface Task {
  id: string;
  type: string;
  data: any;
  priority: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

interface WorkerInfo {
  id: number;
  worker: Worker;
  busy: boolean;
  cpuCore?: number;
  currentTask?: Task;
  tasksCompleted: number;
  avgTaskTime: number;
}

export class MultiCoreCPUOptimizer extends EventEmitter {
  private config: WorkerPoolConfig;
  private workers: Map<number, WorkerInfo> = new Map();
  private taskQueue: Task[] = [];
  private cpuCount: number;
  private cpuTopology: any;
  private nextWorkerId: number = 0;
  
  constructor(config: WorkerPoolConfig) {
    super();
    this.config = config;
    this.cpuCount = os.cpus().length;
    this.cpuTopology = this.analyzeCPUTopology();
  }
  
  /**
   * Initialize the worker pool
   */
  async initialize(): Promise<void> {
    this.emit('initializing', { cpuCount: this.cpuCount });
    
    // Start minimum number of workers
    for (let i = 0; i < this.config.minWorkers; i++) {
      await this.createWorker();
    }
    
    // Setup auto-scaling
    this.setupAutoScaling();
    
    this.emit('initialized', { workers: this.workers.size });
  }
  
  /**
   * Analyze CPU topology for NUMA optimization
   */
  private analyzeCPUTopology(): any {
    const cpus = os.cpus();
    const topology = {
      totalCores: cpus.length,
      physicalCores: cpus.length / 2, // Assuming hyperthreading
      numaNodes: [],
      cacheHierarchy: {
        l1: 32 * 1024, // 32KB typical L1
        l2: 256 * 1024, // 256KB typical L2
        l3: 8 * 1024 * 1024 // 8MB typical L3
      }
    };
    
    // Detect NUMA nodes (simplified)
    if (this.config.enableNUMA && cpus.length > 8) {
      const nodesCount = Math.ceil(cpus.length / 8);
      for (let i = 0; i < nodesCount; i++) {
        topology.numaNodes.push({
          id: i,
          cores: Array.from({ length: 8 }, (_, j) => i * 8 + j).filter(c => c < cpus.length)
        });
      }
    }
    
    return topology;
  }
  
  /**
   * Create a new worker with CPU affinity
   */
  private async createWorker(): Promise<WorkerInfo> {
    const workerId = this.nextWorkerId++;
    
    // Create worker thread
    const worker = new Worker(path.join(__dirname, 'cpu-worker.js'), {
      workerData: {
        workerId,
        cpuCore: this.assignCPUCore(workerId)
      }
    });
    
    const workerInfo: WorkerInfo = {
      id: workerId,
      worker,
      busy: false,
      cpuCore: this.assignCPUCore(workerId),
      tasksCompleted: 0,
      avgTaskTime: 0
    };
    
    // Setup worker event handlers
    worker.on('message', (message) => {
      this.handleWorkerMessage(workerId, message);
    });
    
    worker.on('error', (error) => {
      this.emit('worker_error', { workerId, error });
      this.replaceWorker(workerId);
    });
    
    worker.on('exit', (code) => {
      if (code !== 0) {
        this.emit('worker_exit', { workerId, code });
        this.replaceWorker(workerId);
      }
    });
    
    // Set CPU affinity if enabled
    if (this.config.enableCPUAffinity && workerInfo.cpuCore !== undefined) {
      await this.setCPUAffinity(worker, workerInfo.cpuCore);
    }
    
    this.workers.set(workerId, workerInfo);
    
    return workerInfo;
  }
  
  /**
   * Assign CPU core to worker for optimal performance
   */
  private assignCPUCore(workerId: number): number | undefined {
    if (!this.config.enableCPUAffinity) return undefined;
    
    // NUMA-aware assignment
    if (this.config.enableNUMA && this.cpuTopology.numaNodes.length > 0) {
      const nodeIndex = workerId % this.cpuTopology.numaNodes.length;
      const node = this.cpuTopology.numaNodes[nodeIndex];
      return node.cores[workerId % node.cores.length];
    }
    
    // Simple round-robin assignment
    return workerId % this.cpuCount;
  }
  
  /**
   * Set CPU affinity for a worker
   */
  private async setCPUAffinity(worker: Worker, cpuCore: number): Promise<void> {
    // This would use native bindings or system calls
    // For now, we'll simulate it
    worker.postMessage({
      type: 'set_affinity',
      cpuCore
    });
  }
  
  /**
   * Submit a task to the worker pool
   */
  async submitTask(type: string, data: any, priority: number = 5): Promise<any> {
    const task: Task = {
      id: this.generateTaskId(),
      type,
      data,
      priority,
      createdAt: Date.now()
    };
    
    // Try to assign to an idle worker immediately
    const idleWorker = this.findIdleWorker();
    if (idleWorker) {
      return this.executeTask(idleWorker, task);
    }
    
    // Queue the task
    this.taskQueue.push(task);
    this.taskQueue.sort((a, b) => b.priority - a.priority);
    
    // Check if we need more workers
    if (this.shouldScaleUp()) {
      await this.scaleUp();
    }
    
    // Return promise that resolves when task completes
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        const completedTask = this.getCompletedTask(task.id);
        if (completedTask) {
          clearInterval(checkInterval);
          resolve(completedTask);
        }
      }, 10);
    });
  }
  
  /**
   * Execute task on a worker
   */
  private async executeTask(workerInfo: WorkerInfo, task: Task): Promise<any> {
    workerInfo.busy = true;
    workerInfo.currentTask = task;
    task.startedAt = Date.now();
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Task timeout'));
      }, 30000); // 30 second timeout
      
      const messageHandler = (message: any) => {
        if (message.taskId === task.id) {
          clearTimeout(timeout);
          workerInfo.worker.off('message', messageHandler);
          
          task.completedAt = Date.now();
          const taskTime = task.completedAt - task.startedAt!;
          
          // Update worker stats
          workerInfo.tasksCompleted++;
          workerInfo.avgTaskTime = 
            (workerInfo.avgTaskTime * (workerInfo.tasksCompleted - 1) + taskTime) / 
            workerInfo.tasksCompleted;
          
          workerInfo.busy = false;
          workerInfo.currentTask = undefined;
          
          // Process next task
          this.processNextTask();
          
          if (message.error) {
            reject(new Error(message.error));
          } else {
            resolve(message.result);
          }
        }
      };
      
      workerInfo.worker.on('message', messageHandler);
      
      // Send task to worker
      workerInfo.worker.postMessage({
        type: 'execute_task',
        task
      });
    });
  }
  
  /**
   * Find an idle worker
   */
  private findIdleWorker(): WorkerInfo | undefined {
    // Find worker with best performance characteristics
    let bestWorker: WorkerInfo | undefined;
    let bestScore = Infinity;
    
    for (const worker of this.workers.values()) {
      if (!worker.busy) {
        // Score based on average task time and tasks completed
        const score = worker.avgTaskTime / (worker.tasksCompleted + 1);
        if (score < bestScore) {
          bestScore = score;
          bestWorker = worker;
        }
      }
    }
    
    return bestWorker;
  }
  
  /**
   * Process next task in queue
   */
  private processNextTask(): void {
    if (this.taskQueue.length === 0) return;
    
    const worker = this.findIdleWorker();
    if (worker) {
      const task = this.taskQueue.shift()!;
      this.executeTask(worker, task);
    }
  }
  
  /**
   * Setup auto-scaling
   */
  private setupAutoScaling(): void {
    setInterval(() => {
      const utilization = this.getUtilization();
      
      if (this.shouldScaleUp()) {
        this.scaleUp();
      } else if (this.shouldScaleDown()) {
        this.scaleDown();
      }
      
      this.emit('utilization', { 
        utilization, 
        workers: this.workers.size,
        queueLength: this.taskQueue.length 
      });
    }, 5000); // Check every 5 seconds
  }
  
  /**
   * Calculate worker pool utilization
   */
  private getUtilization(): number {
    if (this.workers.size === 0) return 0;
    
    const busyWorkers = Array.from(this.workers.values()).filter(w => w.busy).length;
    return busyWorkers / this.workers.size;
  }
  
  /**
   * Determine if we should scale up
   */
  private shouldScaleUp(): boolean {
    const utilization = this.getUtilization();
    const queueLength = this.taskQueue.length;
    
    return (
      this.workers.size < this.config.maxWorkers &&
      (utilization > 0.8 || queueLength > this.workers.size * 2)
    );
  }
  
  /**
   * Determine if we should scale down
   */
  private shouldScaleDown(): boolean {
    const utilization = this.getUtilization();
    const idleWorkers = Array.from(this.workers.values())
      .filter(w => !w.busy && Date.now() - (w.currentTask?.completedAt || 0) > this.config.idleTimeout);
    
    return (
      this.workers.size > this.config.minWorkers &&
      utilization < 0.2 &&
      idleWorkers.length > 0
    );
  }
  
  /**
   * Scale up worker pool
   */
  private async scaleUp(): Promise<void> {
    const newWorkerCount = Math.min(
      this.workers.size + 2,
      this.config.maxWorkers
    ) - this.workers.size;
    
    for (let i = 0; i < newWorkerCount; i++) {
      await this.createWorker();
    }
    
    this.emit('scaled_up', { newWorkers: newWorkerCount });
  }
  
  /**
   * Scale down worker pool
   */
  private scaleDown(): void {
    const idleWorkers = Array.from(this.workers.values())
      .filter(w => !w.busy)
      .sort((a, b) => a.avgTaskTime - b.avgTaskTime)
      .slice(1); // Keep the best performer
    
    for (const worker of idleWorkers) {
      if (this.workers.size <= this.config.minWorkers) break;
      
      this.workers.delete(worker.id);
      worker.worker.terminate();
    }
    
    this.emit('scaled_down', { removedWorkers: idleWorkers.length });
  }
  
  /**
   * Get performance statistics
   */
  getStats(): {
    workers: number;
    utilization: number;
    queueLength: number;
    avgTaskTime: number;
    tasksCompleted: number;
    cpuTopology: any;
  } {
    const avgTaskTime = Array.from(this.workers.values())
      .reduce((sum, w) => sum + w.avgTaskTime, 0) / this.workers.size || 0;
    
    const tasksCompleted = Array.from(this.workers.values())
      .reduce((sum, w) => sum + w.tasksCompleted, 0);
    
    return {
      workers: this.workers.size,
      utilization: this.getUtilization(),
      queueLength: this.taskQueue.length,
      avgTaskTime,
      tasksCompleted,
      cpuTopology: this.cpuTopology
    };
  }
  
  /**
   * Optimize task distribution based on NUMA topology
   */
  private optimizeTaskDistribution(task: Task): WorkerInfo | undefined {
    if (!this.config.enableNUMA || this.cpuTopology.numaNodes.length === 0) {
      return this.findIdleWorker();
    }
    
    // Find worker on the same NUMA node if possible
    const dataSize = JSON.stringify(task.data).length;
    
    if (dataSize > this.cpuTopology.cacheHierarchy.l3) {
      // Large data - prefer local NUMA node
      // This would analyze data locality and assign accordingly
    }
    
    return this.findIdleWorker();
  }
  
  /**
   * Replace a failed worker
   */
  private async replaceWorker(workerId: number): Promise<void> {
    const oldWorker = this.workers.get(workerId);
    if (!oldWorker) return;
    
    this.workers.delete(workerId);
    
    // Create replacement worker
    const newWorker = await this.createWorker();
    
    // Reassign any pending task
    if (oldWorker.currentTask) {
      this.taskQueue.unshift(oldWorker.currentTask);
    }
    
    this.emit('worker_replaced', { oldId: workerId, newId: newWorker.id });
  }
  
  private handleWorkerMessage(workerId: number, message: any): void {
    // Handle various worker messages
    switch (message.type) {
      case 'task_progress':
        this.emit('task_progress', { workerId, ...message });
        break;
      case 'performance_metrics':
        this.updateWorkerMetrics(workerId, message.metrics);
        break;
    }
  }
  
  private updateWorkerMetrics(workerId: number, metrics: any): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      // Update worker performance metrics
    }
  }
  
  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  private getCompletedTask(taskId: string): any {
    // This would check a completed tasks map
    return null;
  }
  
  /**
   * Shutdown the worker pool
   */
  async shutdown(): Promise<void> {
    this.emit('shutting_down');
    
    // Wait for all tasks to complete
    const timeout = Date.now() + 30000; // 30 seconds
    while (this.taskQueue.length > 0 || Array.from(this.workers.values()).some(w => w.busy)) {
      if (Date.now() > timeout) {
        this.emit('shutdown_timeout');
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Terminate all workers
    for (const worker of this.workers.values()) {
      await worker.worker.terminate();
    }
    
    this.workers.clear();
    this.emit('shutdown_complete');
  }
}

// Worker thread code would be in separate file
const path = require('path');

export default MultiCoreCPUOptimizer;
