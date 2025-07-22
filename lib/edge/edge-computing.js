/**
 * Edge Computing Support for Otedama
 * Distributed computing at the network edge
 * 
 * Design principles:
 * - Carmack: Ultra-low latency edge processing
 * - Martin: Clean edge architecture
 * - Pike: Simple edge deployment
 */

import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { getLogger } from '../core/logger.js';
import { WasmPluginSystem } from '../wasm/plugin-system.js';

const logger = getLogger('EdgeComputing');

/**
 * Edge node types
 */
export const EdgeNodeType = {
  GATEWAY: 'gateway',         // Edge gateway nodes
  COMPUTE: 'compute',         // Compute-intensive nodes
  STORAGE: 'storage',         // Storage nodes
  INFERENCE: 'inference',     // ML inference nodes
  IOT_HUB: 'iot_hub',        // IoT device hub
  AGGREGATOR: 'aggregator'    // Data aggregation nodes
};

/**
 * Edge deployment models
 */
export const DeploymentModel = {
  STANDALONE: 'standalone',   // Single edge node
  CLUSTER: 'cluster',         // Edge cluster
  HIERARCHICAL: 'hierarchical', // Multi-tier edge
  MESH: 'mesh',              // Edge mesh network
  FOG: 'fog'                 // Fog computing
};

/**
 * Edge workload types
 */
export const WorkloadType = {
  STREAM_PROCESSING: 'stream_processing',
  BATCH_PROCESSING: 'batch_processing',
  REAL_TIME_ANALYTICS: 'real_time_analytics',
  ML_INFERENCE: 'ml_inference',
  DATA_FILTERING: 'data_filtering',
  PROTOCOL_TRANSLATION: 'protocol_translation',
  MINING_OFFLOAD: 'mining_offload'
};

/**
 * Edge node capabilities
 */
export class EdgeCapabilities {
  constructor(data = {}) {
    this.cpu = data.cpu || { cores: 1, frequency: 1000 };
    this.memory = data.memory || { total: 1024, available: 512 };
    this.storage = data.storage || { total: 10240, available: 5120 };
    this.network = data.network || { bandwidth: 100, latency: 10 };
    this.gpu = data.gpu || null;
    this.tpu = data.tpu || null;
    this.sensors = data.sensors || [];
    this.protocols = data.protocols || ['http', 'mqtt', 'coap'];
  }
  
  hasCapability(requirement) {
    if (requirement.cpu && this.cpu.cores < requirement.cpu.cores) return false;
    if (requirement.memory && this.memory.available < requirement.memory) return false;
    if (requirement.gpu && !this.gpu) return false;
    if (requirement.tpu && !this.tpu) return false;
    return true;
  }
  
  getScore() {
    return this.cpu.cores * this.cpu.frequency +
           this.memory.available +
           (this.gpu ? 10000 : 0) +
           (this.tpu ? 20000 : 0);
  }
}

/**
 * Edge workload
 */
export class EdgeWorkload {
  constructor(data) {
    this.id = data.id || this._generateId();
    this.type = data.type || WorkloadType.STREAM_PROCESSING;
    this.priority = data.priority || 5;
    this.requirements = data.requirements || {};
    this.code = data.code;
    this.data = data.data || {};
    this.constraints = data.constraints || {};
    this.deadline = data.deadline;
    this.createdAt = data.createdAt || Date.now();
  }
  
  _generateId() {
    return `workload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  isExpired() {
    return this.deadline && Date.now() > this.deadline;
  }
}

/**
 * Edge node
 */
export class EdgeNode extends EventEmitter {
  constructor(config) {
    super();
    
    this.id = config.id || this._generateId();
    this.name = config.name;
    this.type = config.type || EdgeNodeType.COMPUTE;
    this.location = config.location || { lat: 0, lon: 0 };
    this.capabilities = new EdgeCapabilities(config.capabilities);
    this.status = 'initializing';
    
    // Workload management
    this.workloads = new Map();
    this.workloadQueue = [];
    this.executingWorkloads = new Map();
    
    // Plugin system for edge functions
    this.pluginSystem = new WasmPluginSystem({
      sandboxEnabled: true,
      memoryLimit: this.capabilities.memory.available / 2
    });
    
    // Metrics
    this.metrics = {
      workloadsProcessed: 0,
      workloadsFailed: 0,
      cpuUsage: 0,
      memoryUsage: 0,
      networkUsage: 0,
      uptime: 0
    };
    
    // Connection to coordinator
    this.coordinator = null;
    this.heartbeatInterval = null;
  }
  
  _generateId() {
    return `edge-${this.type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Initialize edge node
   */
  async initialize() {
    logger.info(`Initializing edge node: ${this.id}`);
    
    // Initialize plugin system
    await this.pluginSystem.initialize();
    
    // Start resource monitoring
    this._startResourceMonitoring();
    
    // Start workload processor
    this._startWorkloadProcessor();
    
    this.status = 'ready';
    this.emit('initialized');
  }
  
  /**
   * Connect to coordinator
   */
  async connectToCoordinator(coordinatorUrl) {
    return new Promise((resolve, reject) => {
      this.coordinator = new WebSocket(coordinatorUrl);
      
      this.coordinator.on('open', () => {
        logger.info(`Connected to coordinator: ${coordinatorUrl}`);
        
        // Send registration
        this._sendToCoordinator({
          type: 'register',
          node: {
            id: this.id,
            name: this.name,
            type: this.type,
            location: this.location,
            capabilities: this.capabilities,
            status: this.status
          }
        });
        
        // Start heartbeat
        this._startHeartbeat();
        
        resolve();
      });
      
      this.coordinator.on('message', (data) => {
        const message = JSON.parse(data);
        this._handleCoordinatorMessage(message);
      });
      
      this.coordinator.on('error', (error) => {
        logger.error('Coordinator connection error:', error);
        reject(error);
      });
      
      this.coordinator.on('close', () => {
        logger.warn('Disconnected from coordinator');
        this._stopHeartbeat();
        this.emit('disconnected');
      });
    });
  }
  
  /**
   * Submit workload
   */
  async submitWorkload(workloadData) {
    const workload = new EdgeWorkload(workloadData);
    
    // Check if we can handle it
    if (!this.capabilities.hasCapability(workload.requirements)) {
      throw new Error('Insufficient capabilities for workload');
    }
    
    // Add to queue
    this.workloads.set(workload.id, workload);
    this.workloadQueue.push(workload);
    
    // Sort by priority
    this.workloadQueue.sort((a, b) => b.priority - a.priority);
    
    this.emit('workload:submitted', workload);
    
    return workload.id;
  }
  
  /**
   * Execute workload
   */
  async executeWorkload(workload) {
    const startTime = Date.now();
    
    try {
      this.executingWorkloads.set(workload.id, workload);
      
      let result;
      
      switch (workload.type) {
        case WorkloadType.STREAM_PROCESSING:
          result = await this._executeStreamProcessing(workload);
          break;
          
        case WorkloadType.ML_INFERENCE:
          result = await this._executeMLInference(workload);
          break;
          
        case WorkloadType.MINING_OFFLOAD:
          result = await this._executeMiningOffload(workload);
          break;
          
        default:
          result = await this._executeGenericWorkload(workload);
      }
      
      this.metrics.workloadsProcessed++;
      
      this.emit('workload:completed', {
        workloadId: workload.id,
        result,
        duration: Date.now() - startTime
      });
      
      return result;
      
    } catch (error) {
      this.metrics.workloadsFailed++;
      
      this.emit('workload:failed', {
        workloadId: workload.id,
        error: error.message
      });
      
      throw error;
      
    } finally {
      this.executingWorkloads.delete(workload.id);
      this.workloads.delete(workload.id);
    }
  }
  
  /**
   * Execute stream processing workload
   */
  async _executeStreamProcessing(workload) {
    const { streamId, processors, aggregation } = workload.data;
    
    // Create stream processor
    const processor = {
      buffer: [],
      results: [],
      
      async process(data) {
        // Apply processors
        let processed = data;
        for (const proc of processors) {
          processed = await this._applyProcessor(processed, proc);
        }
        
        this.buffer.push(processed);
        
        // Apply aggregation
        if (aggregation && this.buffer.length >= aggregation.windowSize) {
          const aggregated = await this._aggregate(this.buffer, aggregation);
          this.results.push(aggregated);
          this.buffer = [];
        }
        
        return processed;
      }.bind(this)
    };
    
    // Process stream data
    const streamData = workload.data.stream || [];
    for (const item of streamData) {
      await processor.process(item);
    }
    
    return {
      processed: processor.buffer.length + processor.results.length,
      results: processor.results
    };
  }
  
  /**
   * Execute ML inference workload
   */
  async _executeMLInference(workload) {
    const { model, input, batchSize = 1 } = workload.data;
    
    // Load model (simplified)
    const modelInstance = await this._loadModel(model);
    
    // Prepare input batches
    const batches = [];
    for (let i = 0; i < input.length; i += batchSize) {
      batches.push(input.slice(i, i + batchSize));
    }
    
    // Run inference
    const results = [];
    for (const batch of batches) {
      const predictions = await modelInstance.predict(batch);
      results.push(...predictions);
    }
    
    return {
      predictions: results,
      modelId: model.id,
      inferenceTime: Date.now()
    };
  }
  
  /**
   * Execute mining offload workload
   */
  async _executeMiningOffload(workload) {
    const { algorithm, difficulty, data } = workload.data;
    
    // Create mining context
    const miningContext = {
      algorithm,
      difficulty,
      nonce: 0,
      found: false
    };
    
    // Mine
    const startNonce = workload.data.startNonce || 0;
    const maxNonce = workload.data.maxNonce || 1000000;
    
    for (let nonce = startNonce; nonce < maxNonce; nonce++) {
      const hash = await this._computeHash(data, nonce, algorithm);
      
      if (this._meetsTarget(hash, difficulty)) {
        miningContext.nonce = nonce;
        miningContext.found = true;
        miningContext.hash = hash;
        break;
      }
      
      // Check if workload is cancelled
      if (workload.isExpired()) {
        break;
      }
    }
    
    return miningContext;
  }
  
  /**
   * Execute generic workload
   */
  async _executeGenericWorkload(workload) {
    // Execute as WASM plugin if code provided
    if (workload.code) {
      const pluginId = await this.pluginSystem.loadPlugin({
        code: workload.code,
        memory: workload.requirements.memory || 64
      });
      
      const result = await this.pluginSystem.execute(
        pluginId,
        'execute',
        workload.data
      );
      
      await this.pluginSystem.unloadPlugin(pluginId);
      
      return result;
    }
    
    // Default processing
    return {
      processed: true,
      data: workload.data
    };
  }
  
  /**
   * Start workload processor
   */
  _startWorkloadProcessor() {
    setInterval(() => {
      if (this.workloadQueue.length === 0) return;
      
      // Check resource availability
      if (this.metrics.cpuUsage > 80 || this.metrics.memoryUsage > 80) {
        return;
      }
      
      // Get next workload
      const workload = this.workloadQueue.shift();
      if (!workload) return;
      
      // Execute asynchronously
      this.executeWorkload(workload).catch(error => {
        logger.error(`Workload execution failed: ${workload.id}`, error);
      });
      
    }, 100);
  }
  
  /**
   * Handle coordinator message
   */
  _handleCoordinatorMessage(message) {
    switch (message.type) {
      case 'workload':
        this.submitWorkload(message.workload);
        break;
        
      case 'update_config':
        this._updateConfiguration(message.config);
        break;
        
      case 'migrate_workload':
        this._migrateWorkload(message.workloadId, message.targetNode);
        break;
        
      case 'health_check':
        this._sendHealthReport();
        break;
    }
  }
  
  /**
   * Send message to coordinator
   */
  _sendToCoordinator(message) {
    if (this.coordinator && this.coordinator.readyState === WebSocket.OPEN) {
      this.coordinator.send(JSON.stringify(message));
    }
  }
  
  /**
   * Start heartbeat
   */
  _startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this._sendToCoordinator({
        type: 'heartbeat',
        nodeId: this.id,
        metrics: this.metrics,
        workloads: {
          queued: this.workloadQueue.length,
          executing: this.executingWorkloads.size
        }
      });
    }, 5000);
  }
  
  /**
   * Stop heartbeat
   */
  _stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
  
  /**
   * Start resource monitoring
   */
  _startResourceMonitoring() {
    setInterval(() => {
      // Simulate resource monitoring
      this.metrics.cpuUsage = 30 + Math.random() * 40;
      this.metrics.memoryUsage = 40 + Math.random() * 30;
      this.metrics.networkUsage = Math.random() * 100;
      this.metrics.uptime = Date.now() - this.startTime;
    }, 1000);
  }
  
  /**
   * Helper methods
   */
  async _applyProcessor(data, processor) {
    // Apply data processor
    switch (processor.type) {
      case 'filter':
        return data.filter(processor.predicate);
      case 'map':
        return data.map(processor.transform);
      case 'reduce':
        return data.reduce(processor.reducer, processor.initial);
      default:
        return data;
    }
  }
  
  async _aggregate(data, aggregation) {
    switch (aggregation.type) {
      case 'sum':
        return data.reduce((sum, item) => sum + item.value, 0);
      case 'avg':
        return data.reduce((sum, item) => sum + item.value, 0) / data.length;
      case 'max':
        return Math.max(...data.map(item => item.value));
      case 'min':
        return Math.min(...data.map(item => item.value));
      default:
        return data;
    }
  }
  
  async _loadModel(model) {
    // Simplified model loading
    return {
      async predict(input) {
        // Mock prediction
        return input.map(() => Math.random());
      }
    };
  }
  
  async _computeHash(data, nonce, algorithm) {
    // Simplified hash computation
    const crypto = require('crypto');
    return crypto.createHash(algorithm || 'sha256')
      .update(JSON.stringify(data))
      .update(nonce.toString())
      .digest('hex');
  }
  
  _meetsTarget(hash, difficulty) {
    const target = '0'.repeat(difficulty);
    return hash.startsWith(target);
  }
  
  /**
   * Get node status
   */
  getStatus() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      status: this.status,
      location: this.location,
      capabilities: this.capabilities,
      workloads: {
        total: this.workloads.size,
        queued: this.workloadQueue.length,
        executing: this.executingWorkloads.size
      },
      metrics: this.metrics
    };
  }
  
  /**
   * Shutdown node
   */
  async shutdown() {
    logger.info(`Shutting down edge node: ${this.id}`);
    
    this.status = 'shutting_down';
    
    // Stop heartbeat
    this._stopHeartbeat();
    
    // Close coordinator connection
    if (this.coordinator) {
      this.coordinator.close();
    }
    
    // Shutdown plugin system
    await this.pluginSystem.destroy();
    
    this.status = 'shutdown';
    this.emit('shutdown');
  }
}

/**
 * Edge coordinator
 */
export class EdgeCoordinator extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      port: options.port || 8090,
      
      // Scheduling
      schedulingAlgorithm: options.schedulingAlgorithm || 'least_loaded',
      loadBalancing: options.loadBalancing !== false,
      
      // Fault tolerance
      replicationFactor: options.replicationFactor || 2,
      failoverEnabled: options.failoverEnabled !== false,
      
      // Optimization
      optimizationInterval: options.optimizationInterval || 30000,
      migrationEnabled: options.migrationEnabled !== false,
      
      ...options
    };
    
    // Node registry
    this.nodes = new Map();
    this.nodesByType = new Map();
    this.nodesByLocation = new Map();
    
    // Workload tracking
    this.workloads = new Map();
    this.workloadAssignments = new Map();
    
    // WebSocket server
    this.server = null;
    this.wss = null;
    
    // Metrics
    this.metrics = {
      totalNodes: 0,
      activeNodes: 0,
      totalWorkloads: 0,
      completedWorkloads: 0,
      failedWorkloads: 0
    };
  }
  
  /**
   * Start coordinator
   */
  async start() {
    logger.info('Starting edge coordinator');
    
    // Create HTTP server
    this.server = createServer();
    
    // Create WebSocket server
    this.wss = new WebSocketServer({ server: this.server });
    
    this.wss.on('connection', (ws, req) => {
      this._handleNodeConnection(ws, req);
    });
    
    // Start optimization loop
    this._startOptimization();
    
    // Listen
    await new Promise((resolve) => {
      this.server.listen(this.options.port, () => {
        logger.info(`Edge coordinator listening on port ${this.options.port}`);
        resolve();
      });
    });
    
    this.emit('started');
  }
  
  /**
   * Handle node connection
   */
  _handleNodeConnection(ws, req) {
    let nodeId = null;
    
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        
        switch (message.type) {
          case 'register':
            nodeId = this._registerNode(message.node, ws);
            break;
            
          case 'heartbeat':
            this._updateNodeStatus(message.nodeId, message);
            break;
            
          case 'workload_complete':
            this._handleWorkloadComplete(message);
            break;
            
          case 'workload_failed':
            this._handleWorkloadFailed(message);
            break;
        }
      } catch (error) {
        logger.error('Error handling node message:', error);
      }
    });
    
    ws.on('close', () => {
      if (nodeId) {
        this._unregisterNode(nodeId);
      }
    });
    
    ws.on('error', (error) => {
      logger.error(`Node connection error: ${nodeId}`, error);
    });
  }
  
  /**
   * Register node
   */
  _registerNode(nodeInfo, ws) {
    const node = {
      ...nodeInfo,
      ws,
      lastSeen: Date.now(),
      workloads: new Set()
    };
    
    this.nodes.set(node.id, node);
    
    // Index by type
    if (!this.nodesByType.has(node.type)) {
      this.nodesByType.set(node.type, new Set());
    }
    this.nodesByType.get(node.type).add(node.id);
    
    // Index by location (grid-based)
    const locationKey = this._getLocationKey(node.location);
    if (!this.nodesByLocation.has(locationKey)) {
      this.nodesByLocation.set(locationKey, new Set());
    }
    this.nodesByLocation.get(locationKey).add(node.id);
    
    this.metrics.totalNodes++;
    this.metrics.activeNodes++;
    
    logger.info(`Node registered: ${node.id} (${node.type})`);
    
    this.emit('node:registered', node);
    
    return node.id;
  }
  
  /**
   * Unregister node
   */
  _unregisterNode(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    
    // Remove from indexes
    this.nodesByType.get(node.type)?.delete(nodeId);
    const locationKey = this._getLocationKey(node.location);
    this.nodesByLocation.get(locationKey)?.delete(nodeId);
    
    // Handle workload failover
    if (this.options.failoverEnabled) {
      for (const workloadId of node.workloads) {
        this._failoverWorkload(workloadId);
      }
    }
    
    this.nodes.delete(nodeId);
    this.metrics.activeNodes--;
    
    logger.info(`Node unregistered: ${nodeId}`);
    
    this.emit('node:unregistered', nodeId);
  }
  
  /**
   * Submit workload to edge
   */
  async submitWorkload(workloadData) {
    const workload = new EdgeWorkload(workloadData);
    
    // Find suitable node
    const node = this._selectNode(workload);
    if (!node) {
      throw new Error('No suitable edge node found');
    }
    
    // Track workload
    this.workloads.set(workload.id, workload);
    this.workloadAssignments.set(workload.id, node.id);
    node.workloads.add(workload.id);
    
    // Send to node
    this._sendToNode(node.id, {
      type: 'workload',
      workload: workload
    });
    
    this.metrics.totalWorkloads++;
    
    this.emit('workload:submitted', {
      workloadId: workload.id,
      nodeId: node.id
    });
    
    return workload.id;
  }
  
  /**
   * Select node for workload
   */
  _selectNode(workload) {
    const candidates = [];
    
    // Filter nodes by capabilities
    for (const node of this.nodes.values()) {
      if (node.status === 'ready' && 
          node.capabilities.hasCapability(workload.requirements)) {
        candidates.push(node);
      }
    }
    
    if (candidates.length === 0) return null;
    
    // Apply scheduling algorithm
    switch (this.options.schedulingAlgorithm) {
      case 'least_loaded':
        return this._selectLeastLoaded(candidates);
        
      case 'round_robin':
        return this._selectRoundRobin(candidates);
        
      case 'location_aware':
        return this._selectLocationAware(candidates, workload);
        
      case 'capability_score':
        return this._selectByCapability(candidates, workload);
        
      default:
        return candidates[0];
    }
  }
  
  /**
   * Scheduling algorithms
   */
  _selectLeastLoaded(nodes) {
    return nodes.reduce((selected, node) => {
      const load = node.workloads.size;
      const selectedLoad = selected.workloads.size;
      return load < selectedLoad ? node : selected;
    });
  }
  
  _selectRoundRobin(nodes) {
    this._rrIndex = (this._rrIndex || 0) % nodes.length;
    return nodes[this._rrIndex++];
  }
  
  _selectLocationAware(nodes, workload) {
    if (!workload.constraints.location) {
      return this._selectLeastLoaded(nodes);
    }
    
    // Find closest node
    const targetLocation = workload.constraints.location;
    return nodes.reduce((closest, node) => {
      const distance = this._calculateDistance(node.location, targetLocation);
      const closestDistance = this._calculateDistance(closest.location, targetLocation);
      return distance < closestDistance ? node : closest;
    });
  }
  
  _selectByCapability(nodes, workload) {
    // Score nodes by capability match
    return nodes.reduce((best, node) => {
      const score = node.capabilities.getScore();
      const bestScore = best.capabilities.getScore();
      return score > bestScore ? node : best;
    });
  }
  
  /**
   * Handle workload completion
   */
  _handleWorkloadComplete(message) {
    const { workloadId, result } = message;
    
    this.metrics.completedWorkloads++;
    
    // Clean up tracking
    const nodeId = this.workloadAssignments.get(workloadId);
    if (nodeId) {
      const node = this.nodes.get(nodeId);
      node?.workloads.delete(workloadId);
    }
    
    this.workloads.delete(workloadId);
    this.workloadAssignments.delete(workloadId);
    
    this.emit('workload:completed', {
      workloadId,
      nodeId,
      result
    });
  }
  
  /**
   * Handle workload failure
   */
  _handleWorkloadFailed(message) {
    const { workloadId, error } = message;
    
    this.metrics.failedWorkloads++;
    
    // Attempt failover
    if (this.options.failoverEnabled) {
      this._failoverWorkload(workloadId);
    } else {
      // Clean up
      const nodeId = this.workloadAssignments.get(workloadId);
      if (nodeId) {
        const node = this.nodes.get(nodeId);
        node?.workloads.delete(workloadId);
      }
      
      this.workloads.delete(workloadId);
      this.workloadAssignments.delete(workloadId);
    }
    
    this.emit('workload:failed', {
      workloadId,
      error
    });
  }
  
  /**
   * Failover workload to another node
   */
  _failoverWorkload(workloadId) {
    const workload = this.workloads.get(workloadId);
    if (!workload) return;
    
    const currentNodeId = this.workloadAssignments.get(workloadId);
    
    // Find alternative node
    const alternatives = [];
    for (const node of this.nodes.values()) {
      if (node.id !== currentNodeId &&
          node.status === 'ready' &&
          node.capabilities.hasCapability(workload.requirements)) {
        alternatives.push(node);
      }
    }
    
    if (alternatives.length === 0) {
      logger.error(`No failover node available for workload: ${workloadId}`);
      return;
    }
    
    // Select new node
    const newNode = this._selectLeastLoaded(alternatives);
    
    // Reassign workload
    this.workloadAssignments.set(workloadId, newNode.id);
    newNode.workloads.add(workloadId);
    
    if (currentNodeId) {
      const oldNode = this.nodes.get(currentNodeId);
      oldNode?.workloads.delete(workloadId);
    }
    
    // Send to new node
    this._sendToNode(newNode.id, {
      type: 'workload',
      workload: workload
    });
    
    logger.info(`Workload ${workloadId} failed over to node ${newNode.id}`);
  }
  
  /**
   * Start optimization loop
   */
  _startOptimization() {
    setInterval(() => {
      if (this.options.migrationEnabled) {
        this._optimizeWorkloadPlacement();
      }
      
      this._cleanupStaleNodes();
    }, this.options.optimizationInterval);
  }
  
  /**
   * Optimize workload placement
   */
  _optimizeWorkloadPlacement() {
    // Simple optimization: balance workloads
    const avgWorkloads = this.metrics.totalWorkloads / this.metrics.activeNodes;
    
    for (const node of this.nodes.values()) {
      if (node.workloads.size > avgWorkloads * 1.5) {
        // Node is overloaded, migrate some workloads
        const toMigrate = Math.floor(node.workloads.size - avgWorkloads);
        const workloadIds = Array.from(node.workloads).slice(0, toMigrate);
        
        for (const workloadId of workloadIds) {
          this._migrateWorkload(workloadId);
        }
      }
    }
  }
  
  /**
   * Migrate workload
   */
  _migrateWorkload(workloadId) {
    const workload = this.workloads.get(workloadId);
    if (!workload) return;
    
    const currentNodeId = this.workloadAssignments.get(workloadId);
    if (!currentNodeId) return;
    
    // Find better node
    const newNode = this._selectNode(workload);
    if (!newNode || newNode.id === currentNodeId) return;
    
    // Send migration command
    this._sendToNode(currentNodeId, {
      type: 'migrate_workload',
      workloadId,
      targetNode: newNode.id
    });
    
    // Update assignment
    this.workloadAssignments.set(workloadId, newNode.id);
    
    const oldNode = this.nodes.get(currentNodeId);
    oldNode?.workloads.delete(workloadId);
    newNode.workloads.add(workloadId);
    
    logger.info(`Migrating workload ${workloadId} from ${currentNodeId} to ${newNode.id}`);
  }
  
  /**
   * Update node status
   */
  _updateNodeStatus(nodeId, status) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    
    node.lastSeen = Date.now();
    node.metrics = status.metrics;
    node.workloadCounts = status.workloads;
  }
  
  /**
   * Clean up stale nodes
   */
  _cleanupStaleNodes() {
    const staleTimeout = 30000; // 30 seconds
    const now = Date.now();
    
    for (const [nodeId, node] of this.nodes) {
      if (now - node.lastSeen > staleTimeout) {
        logger.warn(`Node ${nodeId} is stale, removing`);
        this._unregisterNode(nodeId);
      }
    }
  }
  
  /**
   * Send message to node
   */
  _sendToNode(nodeId, message) {
    const node = this.nodes.get(nodeId);
    if (node && node.ws.readyState === WebSocket.OPEN) {
      node.ws.send(JSON.stringify(message));
    }
  }
  
  /**
   * Utility methods
   */
  _getLocationKey(location) {
    // Grid-based location indexing
    const gridSize = 10; // degrees
    const latGrid = Math.floor(location.lat / gridSize);
    const lonGrid = Math.floor(location.lon / gridSize);
    return `${latGrid},${lonGrid}`;
  }
  
  _calculateDistance(loc1, loc2) {
    // Simplified distance calculation
    const dlat = loc1.lat - loc2.lat;
    const dlon = loc1.lon - loc2.lon;
    return Math.sqrt(dlat * dlat + dlon * dlon);
  }
  
  /**
   * Get coordinator status
   */
  getStatus() {
    const nodeStatus = {};
    
    for (const [id, node] of this.nodes) {
      nodeStatus[id] = {
        type: node.type,
        status: node.status,
        location: node.location,
        workloads: node.workloads.size,
        lastSeen: node.lastSeen
      };
    }
    
    return {
      nodes: nodeStatus,
      metrics: this.metrics,
      workloads: {
        total: this.workloads.size,
        assignments: Object.fromEntries(this.workloadAssignments)
      }
    };
  }
  
  /**
   * Shutdown coordinator
   */
  async shutdown() {
    logger.info('Shutting down edge coordinator');
    
    // Close all connections
    for (const node of this.nodes.values()) {
      if (node.ws) {
        node.ws.close();
      }
    }
    
    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
    }
    
    // Close HTTP server
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
    }
    
    this.emit('shutdown');
  }
}

export default { EdgeNode, EdgeCoordinator };