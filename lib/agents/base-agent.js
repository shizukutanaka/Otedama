import EventEmitter from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('Agent');

export class BaseAgent extends EventEmitter {
  constructor(config = {}) {
    super();
    this.name = config.name || 'BaseAgent';
    this.type = config.type || 'generic';
    this.enabled = config.enabled !== false;
    this.interval = config.interval || 60000; // Default: 1 minute
    this.priority = config.priority || 'normal';
    this.state = 'idle';
    this.lastRun = null;
    this.runCount = 0;
    this.errors = [];
    this.metrics = {
      successCount: 0,
      failureCount: 0,
      totalExecutionTime: 0,
      averageExecutionTime: 0
    };
    
    this.intervalId = null;
    this.context = {};
    this.dependencies = new Map();
  }

  async initialize() {
    try {
      logger.info(`Initializing agent: ${this.name}`);
      this.state = 'initializing';
      
      await this.onInitialize();
      
      if (this.enabled) {
        this.start();
      }
      
      this.state = 'ready';
      this.emit('initialized', this);
      logger.info(`Agent initialized: ${this.name}`);
    } catch (error) {
      this.state = 'error';
      this.errors.push({ timestamp: Date.now(), error: error.message });
      logger.error(`Failed to initialize agent ${this.name}:`, error);
      throw error;
    }
  }

  async onInitialize() {
    // Override in subclasses
  }

  start() {
    if (!this.enabled) {
      logger.warn(`Agent ${this.name} is disabled`);
      return;
    }

    if (this.intervalId) {
      logger.warn(`Agent ${this.name} is already running`);
      return;
    }

    logger.info(`Starting agent: ${this.name}`);
    this.state = 'running';
    
    // Run immediately
    this.execute();
    
    // Schedule periodic execution
    this.intervalId = setInterval(() => {
      this.execute();
    }, this.interval);
    
    this.emit('started', this);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    
    this.state = 'stopped';
    logger.info(`Stopped agent: ${this.name}`);
    this.emit('stopped', this);
  }

  async execute() {
    if (this.state === 'executing') {
      logger.warn(`Agent ${this.name} is already executing`);
      return;
    }

    const startTime = Date.now();
    this.state = 'executing';
    this.lastRun = startTime;
    this.runCount++;

    try {
      logger.debug(`Executing agent: ${this.name}`);
      this.emit('execute:start', this);
      
      const result = await this.run();
      
      const executionTime = Date.now() - startTime;
      this.updateMetrics(true, executionTime);
      
      this.state = 'running';
      this.emit('execute:success', { agent: this, result, executionTime });
      
      return result;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      this.updateMetrics(false, executionTime);
      
      this.errors.push({ 
        timestamp: Date.now(), 
        error: error.message,
        stack: error.stack 
      });
      
      // Keep only last 100 errors
      if (this.errors.length > 100) {
        this.errors = this.errors.slice(-100);
      }
      
      this.state = 'error';
      logger.error(`Agent ${this.name} execution failed:`, error);
      this.emit('execute:error', { agent: this, error, executionTime });
      
      // Auto-recovery attempt
      if (this.intervalId) {
        this.state = 'running';
      }
    }
  }

  async run() {
    // Override in subclasses
    throw new Error('run() method must be implemented by subclass');
  }

  updateMetrics(success, executionTime) {
    if (success) {
      this.metrics.successCount++;
    } else {
      this.metrics.failureCount++;
    }
    
    this.metrics.totalExecutionTime += executionTime;
    const totalRuns = this.metrics.successCount + this.metrics.failureCount;
    this.metrics.averageExecutionTime = this.metrics.totalExecutionTime / totalRuns;
  }

  setContext(key, value) {
    this.context[key] = value;
  }

  getContext(key) {
    return key ? this.context[key] : this.context;
  }

  addDependency(name, agent) {
    this.dependencies.set(name, agent);
  }

  getDependency(name) {
    return this.dependencies.get(name);
  }

  async communicate(targetAgent, message) {
    if (!targetAgent || typeof targetAgent.receiveMessage !== 'function') {
      throw new Error('Invalid target agent');
    }
    
    return await targetAgent.receiveMessage({
      from: this.name,
      timestamp: Date.now(),
      message
    });
  }

  async receiveMessage(payload) {
    logger.debug(`Agent ${this.name} received message from ${payload.from}`);
    this.emit('message:received', payload);
    
    // Override in subclasses for custom message handling
    return { status: 'received', agent: this.name };
  }

  getStatus() {
    return {
      name: this.name,
      type: this.type,
      state: this.state,
      enabled: this.enabled,
      lastRun: this.lastRun,
      runCount: this.runCount,
      metrics: this.metrics,
      errorCount: this.errors.length,
      recentErrors: this.errors.slice(-5)
    };
  }

  async shutdown() {
    logger.info(`Shutting down agent: ${this.name}`);
    this.stop();
    
    await this.onShutdown();
    
    this.removeAllListeners();
    this.dependencies.clear();
    this.context = {};
    
    logger.info(`Agent shutdown complete: ${this.name}`);
  }

  async onShutdown() {
    // Override in subclasses for cleanup
  }
}