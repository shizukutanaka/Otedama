/**
 * Distributed Processing Engine - Otedama
 * High-performance distributed computing for national-scale mining operations
 * 
 * Design Principles:
 * - Carmack: Maximum parallelization with minimal coordination overhead
 * - Martin: Clean separation of distribution, execution, and coordination
 * - Pike: Simple interface for complex distributed computations
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { Worker } from 'worker_threads';
import cluster from 'cluster';
import crypto from 'crypto';
import os from 'os';

const logger = createStructuredLogger('DistributedProcessingEngine');

/**
 * Processing strategies
 */
const PROCESSING_STRATEGIES = {
  MAP_REDUCE: 'map_reduce',
  PIPELINE: 'pipeline',
  SCATTER_GATHER: 'scatter_gather',
  MASTER_WORKER: 'master_worker',
  PEER_TO_PEER: 'peer_to_peer'
};

/**
 * Node types
 */
const NODE_TYPES = {
  COORDINATOR: 'coordinator',
  WORKER: 'worker',
  STORAGE: 'storage',
  HYBRID: 'hybrid'
};

/**
 * Task states
 */
const TASK_STATES = {
  PENDING: 'pending',
  ASSIGNED: 'assigned',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

/**
 * Distributed hash table for node coordination
 */
class DistributedHashTable {
  constructor(nodeId, config = {}) {
    this.nodeId = nodeId;
    this.config = {
      replicationFactor: config.replicationFactor || 3,
      virtualNodes: config.virtualNodes || 100,
      ...config
    };
    
    this.nodes = new Map();
    this.ring = [];
    this.data = new Map();
    this.replicas = new Map();
  }
  
  /**
   * Add node to DHT
   */
  addNode(nodeId, nodeInfo) {
    this.nodes.set(nodeId, {
      id: nodeId,
      info: nodeInfo,
      lastSeen: Date.now(),
      active: true
    });
    
    this.rebuildRing();
  }
  
  /**
   * Remove node from DHT
   */
  removeNode(nodeId) {
    this.nodes.delete(nodeId);
    this.rebuildRing();
  }
  
  /**
   * Rebuild consistent hash ring
   */
  rebuildRing() {
    this.ring = [];
    
    for (const [nodeId] of this.nodes) {
      // Add virtual nodes for better distribution
      for (let i = 0; i < this.config.virtualNodes; i++) {
        const virtualNodeId = `${nodeId}:${i}`;
        const hash = this.hash(virtualNodeId);
        
        this.ring.push({
          hash,
          nodeId,
          virtualId: virtualNodeId
        });
      }
    }
    
    // Sort ring by hash
    this.ring.sort((a, b) => a.hash - b.hash);
  }
  
  /**
   * Hash function for consistent hashing
   */
  hash(key) {
    const hash = crypto.createHash('md5');
    hash.update(key);
    return parseInt(hash.digest('hex').substring(0, 8), 16);
  }
  
  /**
   * Find responsible nodes for key
   */
  findNodes(key, count = this.config.replicationFactor) {
    if (this.ring.length === 0) return [];
    
    const keyHash = this.hash(key);
    const nodes = new Set();
    let startIndex = 0;
    
    // Find position in ring
    for (let i = 0; i < this.ring.length; i++) {
      if (this.ring[i].hash >= keyHash) {
        startIndex = i;
        break;
      }
    }
    
    // Get nodes starting from position
    for (let i = 0; i < this.ring.length && nodes.size < count; i++) {
      const index = (startIndex + i) % this.ring.length;
      nodes.add(this.ring[index].nodeId);
    }
    
    return Array.from(nodes);
  }
  
  /**
   * Store data with replication
   */
  async store(key, value) {
    const nodes = this.findNodes(key);
    const promises = [];
    
    for (const nodeId of nodes) {
      if (nodeId === this.nodeId) {
        // Store locally
        this.data.set(key, {
          value,
          timestamp: Date.now(),
          replicas: nodes
        });
      } else {
        // Store on remote node
        promises.push(this.storeRemote(nodeId, key, value));
      }
    }
    
    // Wait for majority of replicas
    const results = await Promise.allSettled(promises);
    const successful = results.filter(r => r.status === 'fulfilled').length + 1; // +1 for local
    
    return successful > Math.floor(nodes.length / 2);
  }
  
  /**
   * Retrieve data
   */
  async retrieve(key) {
    const nodes = this.findNodes(key);
    
    // Try local first
    if (this.data.has(key)) {
      return this.data.get(key).value;
    }
    
    // Try remote nodes
    for (const nodeId of nodes) {
      if (nodeId !== this.nodeId) {
        try {
          const value = await this.retrieveRemote(nodeId, key);
          if (value !== null) {
            return value;
          }
        } catch (error) {
          // Continue to next node
        }
      }
    }
    
    return null;
  }
  
  /**
   * Store on remote node (placeholder)
   */
  async storeRemote(nodeId, key, value) {
    // In production, would use network protocol
    return Promise.resolve(true);
  }
  
  /**
   * Retrieve from remote node (placeholder)
   */
  async retrieveRemote(nodeId, key) {
    // In production, would use network protocol
    return Promise.resolve(null);
  }
}

/**
 * Work queue for distributed tasks
 */
class DistributedWorkQueue {
  constructor(nodeId, dht) {
    this.nodeId = nodeId;
    this.dht = dht;
    this.tasks = new Map();
    this.workers = new Map();
    this.completedTasks = new Map();
  }
  
  /**
   * Submit task to queue
   */
  async submitTask(task) {
    const taskId = crypto.randomBytes(16).toString('hex');
    
    const taskInfo = {
      id: taskId,
      ...task,
      state: TASK_STATES.PENDING,
      submittedAt: Date.now(),
      submittedBy: this.nodeId,
      attempts: 0,
      maxAttempts: task.maxAttempts || 3
    };
    
    // Store task in DHT
    await this.dht.store(`task:${taskId}`, taskInfo);
    this.tasks.set(taskId, taskInfo);
    
    // Try to assign immediately
    await this.assignTask(taskId);
    
    return taskId;
  }
  
  /**
   * Assign task to worker
   */
  async assignTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.state !== TASK_STATES.PENDING) {
      return false;
    }
    
    // Find suitable worker
    const worker = this.findAvailableWorker(task);
    if (!worker) {
      return false;
    }
    
    // Assign task
    task.state = TASK_STATES.ASSIGNED;
    task.assignedTo = worker.id;
    task.assignedAt = Date.now();
    
    // Update in DHT
    await this.dht.store(`task:${taskId}`, task);
    
    // Send task to worker
    await this.sendTaskToWorker(worker, task);
    
    return true;
  }
  
  /**
   * Find available worker
   */
  findAvailableWorker(task) {
    for (const [workerId, worker] of this.workers) {
      if (worker.available && 
          worker.capabilities.includes(task.type) &&
          worker.load < worker.maxLoad) {
        return worker;
      }
    }
    return null;
  }
  
  /**
   * Send task to worker
   */
  async sendTaskToWorker(worker, task) {
    worker.load++;
    worker.available = worker.load < worker.maxLoad;
    
    // In production, would send over network
    // For now, simulate async execution
    setTimeout(async () => {
      await this.handleTaskResult(task.id, {
        success: Math.random() > 0.1, // 90% success rate
        result: `Result for task ${task.id}`,
        executionTime: Math.random() * 1000
      });
    }, Math.random() * 5000);
  }
  
  /**
   * Handle task result
   */
  async handleTaskResult(taskId, result) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    
    const worker = this.workers.get(task.assignedTo);
    if (worker) {
      worker.load--;
      worker.available = worker.load < worker.maxLoad;
    }
    
    if (result.success) {
      task.state = TASK_STATES.COMPLETED;
      task.result = result.result;
      task.completedAt = Date.now();
      task.executionTime = result.executionTime;
      
      this.completedTasks.set(taskId, task);
    } else {
      task.attempts++;
      
      if (task.attempts >= task.maxAttempts) {
        task.state = TASK_STATES.FAILED;
        task.failedAt = Date.now();
        task.error = result.error || 'Max attempts exceeded';
      } else {
        task.state = TASK_STATES.PENDING;
        // Retry assignment
        await this.assignTask(taskId);
      }
    }
    
    // Update in DHT
    await this.dht.store(`task:${taskId}`, task);
  }
  
  /**
   * Register worker
   */
  registerWorker(workerId, capabilities, maxLoad = 5) {
    this.workers.set(workerId, {
      id: workerId,
      capabilities,
      maxLoad,
      load: 0,
      available: true,
      registeredAt: Date.now(),
      lastSeen: Date.now()
    });
  }
  
  /**
   * Get task status
   */
  getTaskStatus(taskId) {
    return this.tasks.get(taskId) || this.completedTasks.get(taskId);
  }
  
  /**
   * Get queue statistics
   */
  getStats() {
    const pending = Array.from(this.tasks.values()).filter(t => t.state === TASK_STATES.PENDING).length;
    const running = Array.from(this.tasks.values()).filter(t => t.state === TASK_STATES.RUNNING).length;
    const completed = this.completedTasks.size;
    const failed = Array.from(this.tasks.values()).filter(t => t.state === TASK_STATES.FAILED).length;
    
    return {
      pending,
      running,
      completed,
      failed,
      workers: this.workers.size,
      totalTasks: this.tasks.size + this.completedTasks.size
    };
  }
}

/**
 * MapReduce implementation
 */
class MapReduceEngine {
  constructor(workQueue) {
    this.workQueue = workQueue;
    this.jobs = new Map();
  }
  
  /**
   * Submit MapReduce job
   */
  async submitJob(jobConfig) {
    const jobId = crypto.randomBytes(16).toString('hex');
    
    const job = {
      id: jobId,
      ...jobConfig,
      state: 'submitted',
      submittedAt: Date.now(),
      mapTasks: [],
      reduceTasks: [],
      results: new Map()
    };
    
    this.jobs.set(jobId, job);
    
    // Create map tasks
    await this.createMapTasks(job);
    
    return jobId;
  }
  
  /**
   * Create map tasks
   */
  async createMapTasks(job) {
    const mapTasks = [];
    
    // Split input data into chunks
    const chunks = this.splitData(job.input, job.mappers || 4);
    
    for (let i = 0; i < chunks.length; i++) {
      const taskId = await this.workQueue.submitTask({
        type: 'map',
        jobId: job.id,
        chunkIndex: i,
        data: chunks[i],
        mapFunction: job.mapFunction
      });
      
      mapTasks.push(taskId);
    }
    
    job.mapTasks = mapTasks;
    job.state = 'mapping';
    
    // Monitor map tasks
    this.monitorMapTasks(job);
  }
  
  /**
   * Split data into chunks
   */
  splitData(data, chunks) {
    if (Array.isArray(data)) {
      const chunkSize = Math.ceil(data.length / chunks);
      const result = [];
      
      for (let i = 0; i < data.length; i += chunkSize) {
        result.push(data.slice(i, i + chunkSize));
      }
      
      return result;
    }
    
    return [data]; // Single chunk for non-array data
  }
  
  /**
   * Monitor map tasks completion
   */
  async monitorMapTasks(job) {
    const checkInterval = setInterval(async () => {
      const completedMaps = [];
      const failedMaps = [];
      
      for (const taskId of job.mapTasks) {
        const task = this.workQueue.getTaskStatus(taskId);
        
        if (task.state === TASK_STATES.COMPLETED) {
          completedMaps.push(task);
        } else if (task.state === TASK_STATES.FAILED) {
          failedMaps.push(task);
        }
      }
      
      if (completedMaps.length + failedMaps.length === job.mapTasks.length) {
        clearInterval(checkInterval);
        
        if (failedMaps.length > 0) {
          job.state = 'failed';
          job.error = `${failedMaps.length} map tasks failed`;
        } else {
          // Start reduce phase
          await this.startReducePhase(job, completedMaps);
        }
      }
    }, 1000);
  }
  
  /**
   * Start reduce phase
   */
  async startReducePhase(job, mapResults) {
    job.state = 'reducing';
    
    // Collect intermediate data
    const intermediateData = new Map();
    
    for (const mapTask of mapResults) {
      const mapResult = mapTask.result;
      
      // Group by key
      for (const [key, values] of Object.entries(mapResult)) {
        if (!intermediateData.has(key)) {
          intermediateData.set(key, []);
        }
        intermediateData.get(key).push(...values);
      }
    }
    
    // Create reduce tasks
    const reduceTasks = [];
    const reducers = job.reducers || 2;
    const keys = Array.from(intermediateData.keys());
    const keysPerReducer = Math.ceil(keys.length / reducers);
    
    for (let i = 0; i < reducers; i++) {
      const reducerKeys = keys.slice(i * keysPerReducer, (i + 1) * keysPerReducer);
      const reducerData = {};
      
      for (const key of reducerKeys) {
        reducerData[key] = intermediateData.get(key);
      }
      
      const taskId = await this.workQueue.submitTask({
        type: 'reduce',
        jobId: job.id,
        reducerIndex: i,
        data: reducerData,
        reduceFunction: job.reduceFunction
      });
      
      reduceTasks.push(taskId);
    }
    
    job.reduceTasks = reduceTasks;
    
    // Monitor reduce tasks
    this.monitorReduceTasks(job);
  }
  
  /**
   * Monitor reduce tasks completion
   */
  async monitorReduceTasks(job) {
    const checkInterval = setInterval(async () => {
      const completedReduces = [];
      const failedReduces = [];
      
      for (const taskId of job.reduceTasks) {
        const task = this.workQueue.getTaskStatus(taskId);
        
        if (task.state === TASK_STATES.COMPLETED) {
          completedReduces.push(task);
        } else if (task.state === TASK_STATES.FAILED) {
          failedReduces.push(task);
        }
      }
      
      if (completedReduces.length + failedReduces.length === job.reduceTasks.length) {
        clearInterval(checkInterval);
        
        if (failedReduces.length > 0) {
          job.state = 'failed';
          job.error = `${failedReduces.length} reduce tasks failed`;
        } else {
          // Combine results
          const finalResult = {};
          
          for (const reduceTask of completedReduces) {
            Object.assign(finalResult, reduceTask.result);
          }
          
          job.state = 'completed';
          job.result = finalResult;
          job.completedAt = Date.now();
        }
      }
    }, 1000);
  }
  
  /**
   * Get job status
   */
  getJobStatus(jobId) {
    return this.jobs.get(jobId);
  }
}

/**
 * Distributed Processing Engine
 */
export class DistributedProcessingEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Node configuration
      nodeId: config.nodeId || crypto.randomBytes(8).toString('hex'),
      nodeType: config.nodeType || NODE_TYPES.HYBRID,
      
      // Processing configuration
      defaultStrategy: config.defaultStrategy || PROCESSING_STRATEGIES.MASTER_WORKER,
      maxWorkers: config.maxWorkers || os.cpus().length,
      maxTasksPerWorker: config.maxTasksPerWorker || 5,
      
      // Network configuration
      enableP2P: config.enableP2P !== false,
      gossipInterval: config.gossipInterval || 30000,
      heartbeatInterval: config.heartbeatInterval || 10000,
      
      // Fault tolerance
      replicationFactor: config.replicationFactor || 3,
      maxRetries: config.maxRetries || 3,
      taskTimeout: config.taskTimeout || 300000, // 5 minutes
      
      ...config
    };
    
    // Components
    this.dht = new DistributedHashTable(this.config.nodeId, {
      replicationFactor: this.config.replicationFactor
    });
    
    this.workQueue = new DistributedWorkQueue(this.config.nodeId, this.dht);
    this.mapReduceEngine = new MapReduceEngine(this.workQueue);
    
    // State
    this.nodes = new Map();
    this.workers = new Map();
    this.running = false;
    
    // Statistics
    this.stats = {
      tasksProcessed: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      nodesConnected: 0,
      workersActive: 0,
      averageProcessingTime: 0
    };
    
    this.logger = logger;
    
    // Initialize node
    this.initializeNode();
  }
  
  /**
   * Initialize processing node
   */
  async initializeNode() {
    // Add self to DHT
    this.dht.addNode(this.config.nodeId, {
      type: this.config.nodeType,
      capabilities: this.getNodeCapabilities(),
      load: 0,
      maxLoad: this.config.maxTasksPerWorker * this.config.maxWorkers
    });
    
    // Create local workers if this is a worker node
    if (this.config.nodeType === NODE_TYPES.WORKER || 
        this.config.nodeType === NODE_TYPES.HYBRID) {
      await this.createLocalWorkers();
    }
    
    this.logger.info('Distributed processing node initialized', {
      nodeId: this.config.nodeId,
      nodeType: this.config.nodeType,
      workers: this.workers.size
    });
  }
  
  /**
   * Get node capabilities
   */
  getNodeCapabilities() {
    return [
      'mining_hash_calculation',
      'share_validation',
      'merkle_tree_construction',
      'cryptographic_operations',
      'data_processing',
      'map_reduce'
    ];
  }
  
  /**
   * Create local workers
   */
  async createLocalWorkers() {
    for (let i = 0; i < this.config.maxWorkers; i++) {
      const workerId = `${this.config.nodeId}_worker_${i}`;
      
      // Create worker thread
      const worker = new Worker(`
        const { parentPort } = require('worker_threads');
        
        parentPort.on('message', async (task) => {
          try {
            const result = await processTask(task);
            parentPort.postMessage({ success: true, result });
          } catch (error) {
            parentPort.postMessage({ success: false, error: error.message });
          }
        });
        
        async function processTask(task) {
          const startTime = Date.now();
          
          switch (task.type) {
            case 'mining_hash':
              return calculateMiningHash(task.data);
            case 'share_validation':
              return validateShares(task.data);
            case 'map':
              return executeMapFunction(task.data, task.mapFunction);
            case 'reduce':
              return executeReduceFunction(task.data, task.reduceFunction);
            default:
              throw new Error('Unknown task type: ' + task.type);
          }
        }
        
        function calculateMiningHash(data) {
          const crypto = require('crypto');
          const hash = crypto.createHash('sha256');
          hash.update(JSON.stringify(data));
          return hash.digest('hex');
        }
        
        function validateShares(shares) {
          return shares.filter(share => 
            share.difficulty > 0 && 
            share.nonce > 0 && 
            share.hash.length === 64
          );
        }
        
        function executeMapFunction(data, mapFunction) {
          const mapFn = new Function('data', mapFunction);
          return mapFn(data);
        }
        
        function executeReduceFunction(data, reduceFunction) {
          const reduceFn = new Function('data', reduceFunction);
          return reduceFn(data);
        }
      `, { eval: true });
      
      this.workers.set(workerId, {
        id: workerId,
        worker,
        busy: false,
        tasksProcessed: 0,
        lastTask: null
      });
      
      // Register with work queue
      this.workQueue.registerWorker(workerId, 
        this.getNodeCapabilities(), 
        this.config.maxTasksPerWorker
      );
    }
  }
  
  /**
   * Start distributed processing
   */
  async start() {
    if (this.running) return;
    
    this.running = true;
    
    // Start heartbeat
    this.startHeartbeat();
    
    // Start gossip protocol
    if (this.config.enableP2P) {
      this.startGossipProtocol();
    }
    
    this.logger.info('Distributed processing engine started');
  }
  
  /**
   * Submit distributed task
   */
  async submitTask(taskConfig) {
    this.stats.tasksProcessed++;
    
    const taskId = await this.workQueue.submitTask({
      ...taskConfig,
      submittedBy: this.config.nodeId,
      strategy: taskConfig.strategy || this.config.defaultStrategy
    });
    
    this.emit('task:submitted', {
      taskId,
      type: taskConfig.type,
      strategy: taskConfig.strategy
    });
    
    return taskId;
  }
  
  /**
   * Submit MapReduce job
   */
  async submitMapReduceJob(input, mapFunction, reduceFunction, options = {}) {
    const jobId = await this.mapReduceEngine.submitJob({
      input,
      mapFunction: mapFunction.toString(),
      reduceFunction: reduceFunction.toString(),
      mappers: options.mappers || 4,
      reducers: options.reducers || 2,
      ...options
    });
    
    this.emit('mapreduce:submitted', { jobId });
    
    return jobId;
  }
  
  /**
   * Process mining shares in parallel
   */
  async processMiningShares(shares) {
    // Split shares into chunks for parallel processing
    const chunkSize = Math.ceil(shares.length / this.config.maxWorkers);
    const chunks = [];
    
    for (let i = 0; i < shares.length; i += chunkSize) {
      chunks.push(shares.slice(i, i + chunkSize));
    }
    
    // Submit tasks for each chunk
    const taskIds = [];
    for (const chunk of chunks) {
      const taskId = await this.submitTask({
        type: 'share_validation',
        data: chunk,
        priority: 'high'
      });
      taskIds.push(taskId);
    }
    
    // Wait for completion and collect results
    const results = [];
    for (const taskId of taskIds) {
      const result = await this.waitForTask(taskId);
      if (result.success) {
        results.push(...result.result);
      }
    }
    
    return results;
  }
  
  /**
   * Calculate distributed hash for mining
   */
  async calculateDistributedHash(data, target, nonces) {
    // Distribute nonce ranges across workers
    const nonceRanges = this.distributeNonceRanges(nonces, this.config.maxWorkers);
    
    const taskIds = [];
    for (const range of nonceRanges) {
      const taskId = await this.submitTask({
        type: 'mining_hash',
        data: {
          ...data,
          nonceStart: range.start,
          nonceEnd: range.end,
          target
        },
        priority: 'critical'
      });
      taskIds.push(taskId);
    }
    
    // Wait for first valid hash
    return new Promise((resolve, reject) => {
      let completed = 0;
      
      for (const taskId of taskIds) {
        this.waitForTask(taskId).then(result => {
          completed++;
          
          if (result.success && result.result.valid) {
            resolve(result.result);
          } else if (completed === taskIds.length) {
            resolve(null); // No valid hash found
          }
        }).catch(reject);
      }
    });
  }
  
  /**
   * Distribute nonce ranges
   */
  distributeNonceRanges(totalNonces, workers) {
    const ranges = [];
    const noncesPerWorker = Math.ceil(totalNonces / workers);
    
    for (let i = 0; i < workers; i++) {
      const start = i * noncesPerWorker;
      const end = Math.min(start + noncesPerWorker - 1, totalNonces - 1);
      
      if (start <= end) {
        ranges.push({ start, end });
      }
    }
    
    return ranges;
  }
  
  /**
   * Wait for task completion
   */
  async waitForTask(taskId, timeout = this.config.taskTimeout) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      const checkStatus = () => {
        const task = this.workQueue.getTaskStatus(taskId);
        
        if (!task) {
          reject(new Error('Task not found'));
          return;
        }
        
        if (task.state === TASK_STATES.COMPLETED) {
          this.stats.tasksCompleted++;
          resolve({ success: true, result: task.result });
        } else if (task.state === TASK_STATES.FAILED) {
          this.stats.tasksFailed++;
          resolve({ success: false, error: task.error });
        } else if (Date.now() - startTime > timeout) {
          reject(new Error('Task timeout'));
        } else {
          setTimeout(checkStatus, 100);
        }
      };
      
      checkStatus();
    });
  }
  
  /**
   * Start heartbeat mechanism
   */
  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.heartbeatInterval);
  }
  
  /**
   * Send heartbeat to other nodes
   */
  sendHeartbeat() {
    const heartbeat = {
      nodeId: this.config.nodeId,
      timestamp: Date.now(),
      load: this.getCurrentLoad(),
      stats: this.getNodeStats()
    };
    
    // Broadcast to all known nodes
    for (const [nodeId] of this.nodes) {
      if (nodeId !== this.config.nodeId) {
        this.sendMessage(nodeId, 'heartbeat', heartbeat);
      }
    }
  }
  
  /**
   * Start gossip protocol
   */
  startGossipProtocol() {
    this.gossipTimer = setInterval(() => {
      this.performGossip();
    }, this.config.gossipInterval);
  }
  
  /**
   * Perform gossip round
   */
  performGossip() {
    // Select random subset of nodes to gossip with
    const nodes = Array.from(this.nodes.keys());
    const gossipTargets = this.selectRandomNodes(nodes, Math.min(3, nodes.length));
    
    for (const nodeId of gossipTargets) {
      this.exchangeNodeInfo(nodeId);
    }
  }
  
  /**
   * Select random nodes
   */
  selectRandomNodes(nodes, count) {
    const shuffled = [...nodes].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }
  
  /**
   * Exchange node information
   */
  async exchangeNodeInfo(nodeId) {
    // Send node list to peer
    const nodeInfo = {
      nodes: Array.from(this.nodes.entries()),
      timestamp: Date.now()
    };
    
    this.sendMessage(nodeId, 'gossip', nodeInfo);
  }
  
  /**
   * Send message to node
   */
  sendMessage(nodeId, type, data) {
    // In production, would use network protocol
    // For now, simulate message passing
    this.emit('message:sent', {
      to: nodeId,
      type,
      data,
      timestamp: Date.now()
    });
  }
  
  /**
   * Get current node load
   */
  getCurrentLoad() {
    const activeTasks = this.workQueue.getStats().running;
    const maxCapacity = this.config.maxWorkers * this.config.maxTasksPerWorker;
    
    return activeTasks / maxCapacity;
  }
  
  /**
   * Get node statistics
   */
  getNodeStats() {
    return {
      ...this.stats,
      workQueue: this.workQueue.getStats(),
      workers: this.workers.size,
      load: this.getCurrentLoad()
    };
  }
  
  /**
   * Add peer node
   */
  addPeerNode(nodeId, nodeInfo) {
    this.nodes.set(nodeId, {
      ...nodeInfo,
      addedAt: Date.now(),
      lastSeen: Date.now()
    });
    
    this.dht.addNode(nodeId, nodeInfo);
    this.stats.nodesConnected = this.nodes.size;
    
    this.emit('node:added', { nodeId, nodeInfo });
  }
  
  /**
   * Remove peer node
   */
  removePeerNode(nodeId) {
    this.nodes.delete(nodeId);
    this.dht.removeNode(nodeId);
    this.stats.nodesConnected = this.nodes.size;
    
    this.emit('node:removed', { nodeId });
  }
  
  /**
   * Get processing statistics
   */
  getStats() {
    return {
      ...this.stats,
      nodes: this.nodes.size,
      workers: this.workers.size,
      dht: {
        nodes: this.dht.nodes.size,
        data: this.dht.data.size
      },
      workQueue: this.workQueue.getStats()
    };
  }
  
  /**
   * Shutdown processing engine
   */
  async shutdown() {
    this.running = false;
    
    // Stop timers
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    
    if (this.gossipTimer) {
      clearInterval(this.gossipTimer);
    }
    
    // Terminate workers
    for (const [workerId, workerInfo] of this.workers) {
      await workerInfo.worker.terminate();
    }
    
    this.logger.info('Distributed processing engine shutdown');
  }
}

// Export constants
export {
  PROCESSING_STRATEGIES,
  NODE_TYPES,
  TASK_STATES
};

export default DistributedProcessingEngine;