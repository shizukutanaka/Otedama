/**
 * Real-time Data Streaming Processor
 * 
 * High-throughput data streaming with back-pressure handling,
 * multi-source aggregation, and real-time processing pipelines
 */

import { EventEmitter } from 'events';
import { Transform, Writable, pipeline } from 'stream';
import { Worker } from 'worker_threads';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../core/standardized-error-handler.js';

export class DataStreamProcessor extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Stream configuration
      maxConcurrentStreams: options.maxConcurrentStreams || 10,
      bufferSize: options.bufferSize || 10000,
      highWaterMark: options.highWaterMark || 16384,
      backpressureThreshold: options.backpressureThreshold || 0.8,
      
      // Processing configuration
      enableParallelProcessing: options.enableParallelProcessing !== false,
      workerCount: options.workerCount || 4,
      batchSize: options.batchSize || 100,
      processingTimeout: options.processingTimeout || 30000,
      
      // Stream types and sources
      supportedSources: options.supportedSources || ['websocket', 'http', 'tcp', 'file', 'database'],
      enableMultiplexing: options.enableMultiplexing !== false,
      enableBroadcast: options.enableBroadcast !== false,
      
      // Performance and reliability
      enableMetrics: options.enableMetrics !== false,
      enableHealthCheck: options.enableHealthCheck !== false,
      retryAttempts: options.retryAttempts || 3,
      circuitBreakerThreshold: options.circuitBreakerThreshold || 10,
      
      // Data processing
      enableTransformation: options.enableTransformation !== false,
      enableFiltering: options.enableFiltering !== false,
      enableAggregation: options.enableAggregation !== false,
      enableRouting: options.enableRouting !== false,
      
      // Storage and persistence
      dataDirectory: options.dataDirectory || './data/streaming',
      enablePersistence: options.enablePersistence !== false,
      compressionLevel: options.compressionLevel || 6,
      
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.isRunning = false;
    this.workers = [];
    
    // Stream management
    this.activeStreams = new Map(); // streamId -> stream instance
    this.streamMetrics = new Map(); // streamId -> metrics
    this.pipelines = new Map(); // pipelineId -> pipeline
    this.processors = new Map(); // processorId -> processor function
    
    // Data buffers and queues
    this.inputBuffer = [];
    this.outputBuffer = [];
    this.processingQueue = [];
    this.backpressureQueue = [];
    
    // Circuit breakers and health
    this.circuitBreakers = new Map(); // streamId -> breaker state
    this.healthStatus = new Map(); // streamId -> health status
    
    // Performance metrics
    this.metrics = {
      totalStreams: 0,
      activeStreams: 0,
      totalRecords: 0,
      recordsPerSecond: 0,
      averageLatency: 0,
      backpressureEvents: 0,
      errors: 0,
      retries: 0
    };
    
    this.initialize();
  }
  
  /**
   * Initialize data stream processor
   */
  async initialize() {
    try {
      await this.ensureDirectories();
      await this.initializeWorkers();
      await this.loadProcessors();
      
      this.emit('initialized');
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'data-stream-processor',
        category: ErrorCategory.INITIALIZATION
      });
    }
  }
  
  /**
   * Start stream processor
   */
  async start() {
    if (this.isRunning) {
      throw new OtedamaError('Stream processor already running', ErrorCategory.OPERATION);
    }
    
    console.log('🌊 Starting data stream processor...');
    this.isRunning = true;
    
    // Start processing loops
    this.startBufferProcessor();
    this.startMetricsCollector();
    this.startHealthChecker();
    this.startBackpressureManager();
    
    this.emit('started');
    console.log('✅ Data stream processor started successfully');
  }
  
  /**
   * Stop stream processor
   */
  async stop() {
    if (!this.isRunning) return;
    
    console.log('🛑 Stopping data stream processor...');
    this.isRunning = false;
    
    // Close all active streams
    for (const [streamId, stream] of this.activeStreams.entries()) {
      await this.closeStream(streamId);
    }
    
    // Process remaining buffers
    await this.flushBuffers();
    
    // Terminate workers
    await this.terminateWorkers();
    
    // Clear timers
    if (this.bufferTimer) clearInterval(this.bufferTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.backpressureTimer) clearInterval(this.backpressureTimer);
    
    this.emit('stopped');
    console.log('✅ Data stream processor stopped');
  }
  
  /**
   * Create new data stream
   */
  async createStream(config) {
    const streamId = this.generateStreamId();
    const stream = this.buildStreamPipeline(config);
    
    // Initialize stream metrics
    this.streamMetrics.set(streamId, {
      id: streamId,
      type: config.type,
      source: config.source,
      startTime: Date.now(),
      recordsProcessed: 0,
      bytesProcessed: 0,
      errors: 0,
      latency: [],
      throughput: 0
    });
    
    // Initialize circuit breaker
    this.circuitBreakers.set(streamId, {
      failures: 0,
      lastFailure: null,
      state: 'closed', // closed, open, half-open
      timeout: 60000
    });
    
    // Add to active streams
    this.activeStreams.set(streamId, stream);
    this.metrics.totalStreams++;
    this.metrics.activeStreams++;
    
    console.log(`🌊 Created stream: ${streamId} (${config.type})`);
    this.emit('stream:created', { streamId, config });
    
    return streamId;
  }
  
  /**
   * Close data stream
   */
  async closeStream(streamId) {
    const stream = this.activeStreams.get(streamId);
    if (!stream) return;
    
    try {
      // Close stream gracefully
      if (stream.destroy) {
        stream.destroy();
      }
      
      // Clean up resources
      this.activeStreams.delete(streamId);
      this.streamMetrics.delete(streamId);
      this.circuitBreakers.delete(streamId);
      this.healthStatus.delete(streamId);
      
      this.metrics.activeStreams--;
      
      console.log(`🔒 Closed stream: ${streamId}`);
      this.emit('stream:closed', { streamId });
      
    } catch (error) {
      console.error(`Failed to close stream ${streamId}:`, error.message);
    }
  }
  
  /**
   * Process data through stream
   */
  async processData(streamId, data) {
    const startTime = performance.now();
    
    if (!this.activeStreams.has(streamId)) {
      throw new Error(`Stream not found: ${streamId}`);
    }
    
    // Check circuit breaker
    if (this.isCircuitBreakerOpen(streamId)) {
      throw new Error(`Circuit breaker open for stream: ${streamId}`);
    }
    
    try {
      // Add to processing queue
      const record = {
        streamId,
        data,
        timestamp: Date.now(),
        id: this.generateRecordId()
      };
      
      this.processingQueue.push(record);
      
      // Update metrics
      const metrics = this.streamMetrics.get(streamId);
      if (metrics) {
        metrics.recordsProcessed++;
        metrics.bytesProcessed += this.estimateDataSize(data);
        
        const latency = performance.now() - startTime;
        metrics.latency.push(latency);
        
        // Keep only recent latency measurements
        if (metrics.latency.length > 1000) {
          metrics.latency = metrics.latency.slice(-1000);
        }
      }
      
      this.metrics.totalRecords++;
      
      this.emit('data:processed', { streamId, recordId: record.id, latency: performance.now() - startTime });
      
      return record.id;
      
    } catch (error) {
      this.handleStreamError(streamId, error);
      throw error;
    }
  }
  
  /**
   * Add data processor
   */
  addProcessor(name, processorFunction) {
    this.processors.set(name, processorFunction);
    console.log(`🔧 Added processor: ${name}`);
    this.emit('processor:added', { name });
  }
  
  /**
   * Remove data processor
   */
  removeProcessor(name) {
    if (this.processors.has(name)) {
      this.processors.delete(name);
      console.log(`🗑️  Removed processor: ${name}`);
      this.emit('processor:removed', { name });
    }
  }
  
  /**
   * Create processing pipeline
   */
  createPipeline(config) {
    const pipelineId = this.generatePipelineId();
    const steps = [];
    
    // Build pipeline steps
    for (const stepConfig of config.steps) {
      const step = this.createPipelineStep(stepConfig);
      steps.push(step);
    }
    
    const pipeline = {
      id: pipelineId,
      name: config.name,
      steps,
      metrics: {
        processed: 0,
        errors: 0,
        averageTime: 0
      }
    };
    
    this.pipelines.set(pipelineId, pipeline);
    
    console.log(`⚙️  Created pipeline: ${config.name} (${pipelineId})`);
    this.emit('pipeline:created', { pipelineId, config });
    
    return pipelineId;
  }
  
  /**
   * Execute pipeline on data
   */
  async executePipeline(pipelineId, data) {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) {
      throw new Error(`Pipeline not found: ${pipelineId}`);
    }
    
    const startTime = performance.now();
    let result = data;
    
    try {
      // Execute each step in sequence
      for (const step of pipeline.steps) {
        result = await this.executeStep(step, result);
        
        // Handle null/undefined results (filtered out)
        if (result === null || result === undefined) {
          break;
        }
      }
      
      // Update pipeline metrics
      const duration = performance.now() - startTime;
      pipeline.metrics.processed++;
      pipeline.metrics.averageTime = 
        (pipeline.metrics.averageTime * (pipeline.metrics.processed - 1) + duration) / 
        pipeline.metrics.processed;
      
      this.emit('pipeline:executed', { pipelineId, duration, result });
      
      return result;
      
    } catch (error) {
      pipeline.metrics.errors++;
      this.emit('pipeline:error', { pipelineId, error: error.message });
      throw error;
    }
  }
  
  /**
   * Build stream pipeline
   */
  buildStreamPipeline(config) {
    const transforms = [];
    
    // Add input transformation
    if (config.inputTransform) {
      transforms.push(this.createTransformStream(config.inputTransform));
    }
    
    // Add processors
    if (config.processors) {
      for (const processorName of config.processors) {
        const processor = this.processors.get(processorName);
        if (processor) {
          transforms.push(this.createProcessorStream(processor));
        }
      }
    }
    
    // Add output transformation
    if (config.outputTransform) {
      transforms.push(this.createTransformStream(config.outputTransform));
    }
    
    // Add sink
    const sink = this.createSinkStream(config.sink || { type: 'memory' });
    transforms.push(sink);
    
    return this.pipelineStreams(transforms);
  }
  
  /**
   * Create transform stream
   */
  createTransformStream(transformConfig) {
    return new Transform({
      objectMode: true,
      highWaterMark: this.options.highWaterMark,
      transform(chunk, encoding, callback) {
        try {
          const result = this.applyTransform(transformConfig, chunk);
          callback(null, result);
        } catch (error) {
          callback(error);
        }
      }
    });
  }
  
  /**
   * Create processor stream
   */
  createProcessorStream(processor) {
    return new Transform({
      objectMode: true,
      highWaterMark: this.options.highWaterMark,
      transform(chunk, encoding, callback) {
        try {
          const result = processor(chunk);
          if (result instanceof Promise) {
            result.then(res => callback(null, res)).catch(callback);
          } else {
            callback(null, result);
          }
        } catch (error) {
          callback(error);
        }
      }
    });
  }
  
  /**
   * Create sink stream
   */
  createSinkStream(sinkConfig) {
    return new Writable({
      objectMode: true,
      highWaterMark: this.options.highWaterMark,
      write(chunk, encoding, callback) {
        try {
          this.writeTo(sinkConfig, chunk);
          callback();
        } catch (error) {
          callback(error);
        }
      }
    });
  }
  
  /**
   * Pipeline multiple streams
   */
  pipelineStreams(streams) {
    return new Promise((resolve, reject) => {
      pipeline(...streams, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
  
  /**
   * Start buffer processor
   */
  startBufferProcessor() {
    this.bufferTimer = setInterval(() => {
      this.processBuffers();
    }, 100); // Process every 100ms
  }
  
  /**
   * Start metrics collector
   */
  startMetricsCollector() {
    this.metricsTimer = setInterval(() => {
      this.updateMetrics();
    }, 1000); // Update every second
  }
  
  /**
   * Start health checker
   */
  startHealthChecker() {
    if (this.options.enableHealthCheck) {
      this.healthTimer = setInterval(() => {
        this.checkStreamHealth();
      }, 30000); // Check every 30 seconds
    }
  }
  
  /**
   * Start backpressure manager
   */
  startBackpressureManager() {
    this.backpressureTimer = setInterval(() => {
      this.manageBackpressure();
    }, 500); // Check every 500ms
  }
  
  /**
   * Process input/output buffers
   */
  processBuffers() {
    // Process input buffer
    if (this.inputBuffer.length > 0) {
      const batch = this.inputBuffer.splice(0, this.options.batchSize);
      this.processBatch(batch);
    }
    
    // Flush output buffer if needed
    if (this.outputBuffer.length > this.options.bufferSize * 0.8) {
      this.flushOutputBuffer();
    }
  }
  
  /**
   * Process batch of records
   */
  async processBatch(batch) {
    if (this.options.enableParallelProcessing && this.workers.length > 0) {
      await this.processBatchParallel(batch);
    } else {
      await this.processBatchSequential(batch);
    }
  }
  
  /**
   * Process batch in parallel using workers
   */
  async processBatchParallel(batch) {
    const workerPromises = [];
    const batchSize = Math.ceil(batch.length / this.workers.length);
    
    for (let i = 0; i < this.workers.length && i * batchSize < batch.length; i++) {
      const workerBatch = batch.slice(i * batchSize, (i + 1) * batchSize);
      if (workerBatch.length > 0) {
        workerPromises.push(this.processWithWorker(this.workers[i], workerBatch));
      }
    }
    
    const results = await Promise.allSettled(workerPromises);
    
    // Handle results
    for (const result of results) {
      if (result.status === 'fulfilled') {
        this.outputBuffer.push(...result.value);
      } else {
        console.error('Worker processing failed:', result.reason);
        this.metrics.errors++;
      }
    }
  }
  
  /**
   * Process batch sequentially
   */
  async processBatchSequential(batch) {
    for (const record of batch) {
      try {
        const result = await this.processRecord(record);
        if (result) {
          this.outputBuffer.push(result);
        }
      } catch (error) {
        console.error('Record processing failed:', error.message);
        this.metrics.errors++;
      }
    }
  }
  
  /**
   * Process individual record
   */
  async processRecord(record) {
    const startTime = performance.now();
    
    try {
      // Apply transformations and processors
      let result = record.data;
      
      // Apply filtering if enabled
      if (this.options.enableFiltering && this.shouldFilter(result)) {
        return null;
      }
      
      // Apply transformations if enabled
      if (this.options.enableTransformation) {
        result = await this.applyTransformations(result);
      }
      
      // Apply aggregation if enabled
      if (this.options.enableAggregation) {
        result = await this.applyAggregation(result);
      }
      
      const processingTime = performance.now() - startTime;
      
      return {
        ...record,
        data: result,
        processedAt: Date.now(),
        processingTime
      };
      
    } catch (error) {
      throw new Error(`Record processing failed: ${error.message}`);
    }
  }
  
  /**
   * Update metrics
   */
  updateMetrics() {
    // Calculate records per second
    const now = Date.now();
    if (this.lastMetricsUpdate) {
      const timeDiff = (now - this.lastMetricsUpdate) / 1000;
      const recordsDiff = this.metrics.totalRecords - (this.lastRecordCount || 0);
      this.metrics.recordsPerSecond = recordsDiff / timeDiff;
    }
    
    this.lastMetricsUpdate = now;
    this.lastRecordCount = this.metrics.totalRecords;
    
    // Calculate average latency
    let totalLatency = 0;
    let latencyCount = 0;
    
    for (const metrics of this.streamMetrics.values()) {
      if (metrics.latency.length > 0) {
        totalLatency += metrics.latency.reduce((a, b) => a + b, 0);
        latencyCount += metrics.latency.length;
      }
    }
    
    this.metrics.averageLatency = latencyCount > 0 ? totalLatency / latencyCount : 0;
    
    this.emit('metrics:updated', this.metrics);
  }
  
  /**
   * Check stream health
   */
  checkStreamHealth() {
    for (const [streamId, metrics] of this.streamMetrics.entries()) {
      const health = this.calculateStreamHealth(metrics);
      this.healthStatus.set(streamId, health);
      
      if (health.status === 'unhealthy') {
        console.warn(`⚠️  Stream ${streamId} is unhealthy: ${health.reason}`);
        this.emit('stream:unhealthy', { streamId, health });
      }
    }
  }
  
  /**
   * Manage backpressure
   */
  manageBackpressure() {
    const bufferUtilization = this.inputBuffer.length / this.options.bufferSize;
    
    if (bufferUtilization > this.options.backpressureThreshold) {
      this.metrics.backpressureEvents++;
      
      // Apply backpressure strategies
      if (bufferUtilization > 0.95) {
        // Emergency: drop oldest records
        const dropCount = Math.floor(this.inputBuffer.length * 0.1);
        this.inputBuffer.splice(0, dropCount);
        console.warn(`⚠️  Emergency: dropped ${dropCount} records due to backpressure`);
      } else {
        // Throttle input
        this.throttleInput();
      }
      
      this.emit('backpressure:detected', { utilization: bufferUtilization });
    }
  }
  
  /**
   * Utility methods
   */
  generateStreamId() {
    return `stream_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }
  
  generatePipelineId() {
    return `pipeline_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }
  
  generateRecordId() {
    return `record_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }
  
  estimateDataSize(data) {
    return JSON.stringify(data).length * 2; // Rough estimate
  }
  
  isCircuitBreakerOpen(streamId) {
    const breaker = this.circuitBreakers.get(streamId);
    if (!breaker) return false;
    
    if (breaker.state === 'open') {
      // Check if timeout has passed
      if (Date.now() - breaker.lastFailure > breaker.timeout) {
        breaker.state = 'half-open';
        return false;
      }
      return true;
    }
    
    return false;
  }
  
  handleStreamError(streamId, error) {
    const metrics = this.streamMetrics.get(streamId);
    if (metrics) {
      metrics.errors++;
    }
    
    const breaker = this.circuitBreakers.get(streamId);
    if (breaker) {
      breaker.failures++;
      breaker.lastFailure = Date.now();
      
      if (breaker.failures >= this.options.circuitBreakerThreshold) {
        breaker.state = 'open';
        console.warn(`🔴 Circuit breaker opened for stream: ${streamId}`);
      }
    }
    
    this.metrics.errors++;
    this.emit('stream:error', { streamId, error: error.message });
  }
  
  calculateStreamHealth(metrics) {
    const now = Date.now();
    const age = now - metrics.startTime;
    
    // Check error rate
    const errorRate = metrics.recordsProcessed > 0 ? metrics.errors / metrics.recordsProcessed : 0;
    if (errorRate > 0.1) {
      return { status: 'unhealthy', reason: `High error rate: ${(errorRate * 100).toFixed(1)}%` };
    }
    
    // Check if stream is stale
    if (age > 300000 && metrics.recordsProcessed === 0) {
      return { status: 'unhealthy', reason: 'No records processed in 5 minutes' };
    }
    
    // Check throughput
    const throughput = metrics.recordsProcessed / (age / 1000);
    if (throughput < 0.1 && age > 60000) {
      return { status: 'unhealthy', reason: 'Low throughput' };
    }
    
    return { status: 'healthy', reason: 'All checks passed' };
  }
  
  shouldFilter(data) {
    // Implement filtering logic
    return false;
  }
  
  async applyTransformations(data) {
    // Implement transformation logic
    return data;
  }
  
  async applyAggregation(data) {
    // Implement aggregation logic
    return data;
  }
  
  throttleInput() {
    // Implement input throttling
    console.log('🚦 Throttling input due to backpressure');
  }
  
  async flushOutputBuffer() {
    // Flush output buffer
    const batch = this.outputBuffer.splice(0);
    if (batch.length > 0) {
      this.emit('output:flushed', { count: batch.length });
    }
  }
  
  async flushBuffers() {
    await this.flushOutputBuffer();
  }
  
  createPipelineStep(stepConfig) {
    return {
      type: stepConfig.type,
      config: stepConfig.config,
      processor: this.processors.get(stepConfig.processor)
    };
  }
  
  async executeStep(step, data) {
    if (step.processor) {
      return await step.processor(data);
    }
    return data;
  }
  
  applyTransform(transformConfig, data) {
    // Apply transformation based on config
    return data;
  }
  
  writeTo(sinkConfig, data) {
    // Write to sink based on config
    console.log('Writing to sink:', data);
  }
  
  async processWithWorker(worker, batch) {
    // Process batch with worker
    return batch;
  }
  
  async initializeWorkers() {
    if (this.options.enableParallelProcessing) {
      for (let i = 0; i < this.options.workerCount; i++) {
        // Worker initialization would go here
        this.workers.push({ id: i });
      }
    }
  }
  
  async terminateWorkers() {
    for (const worker of this.workers) {
      // Terminate worker
    }
    this.workers = [];
  }
  
  async loadProcessors() {
    // Load default processors
    this.addProcessor('passthrough', (data) => data);
    this.addProcessor('json_parse', (data) => JSON.parse(data));
    this.addProcessor('json_stringify', (data) => JSON.stringify(data));
    this.addProcessor('uppercase', (data) => typeof data === 'string' ? data.toUpperCase() : data);
    this.addProcessor('lowercase', (data) => typeof data === 'string' ? data.toLowerCase() : data);
  }
  
  async ensureDirectories() {
    await mkdir(this.options.dataDirectory, { recursive: true });
  }
  
  /**
   * Get processor status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      metrics: this.metrics,
      activeStreams: this.activeStreams.size,
      processors: this.processors.size,
      pipelines: this.pipelines.size,
      bufferSizes: {
        input: this.inputBuffer.length,
        output: this.outputBuffer.length,
        processing: this.processingQueue.length
      }
    };
  }
  
  /**
   * Get stream information
   */
  getStreamInfo(streamId) {
    return {
      metrics: this.streamMetrics.get(streamId),
      health: this.healthStatus.get(streamId),
      circuitBreaker: this.circuitBreakers.get(streamId)
    };
  }
  
  /**
   * Get all stream metrics
   */
  getAllStreamMetrics() {
    return Object.fromEntries(this.streamMetrics);
  }
}

export default DataStreamProcessor;