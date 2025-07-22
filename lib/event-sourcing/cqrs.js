/**
 * CQRS (Command Query Responsibility Segregation) for Otedama
 * Separating read and write models
 * 
 * Design principles:
 * - Carmack: Optimized read/write paths
 * - Martin: Clean separation of concerns
 * - Pike: Simple command/query interfaces
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { EventStore } from './event-store.js';

const logger = getLogger('Cqrs');

/**
 * Command types
 */
export const CommandType = {
  // User commands
  CREATE_USER: 'CREATE_USER',
  UPDATE_USER: 'UPDATE_USER',
  DELETE_USER: 'DELETE_USER',
  
  // Miner commands
  START_MINER: 'START_MINER',
  STOP_MINER: 'STOP_MINER',
  CONFIGURE_MINER: 'CONFIGURE_MINER',
  
  // Transaction commands
  CREATE_TRANSACTION: 'CREATE_TRANSACTION',
  COMPLETE_TRANSACTION: 'COMPLETE_TRANSACTION',
  CANCEL_TRANSACTION: 'CANCEL_TRANSACTION'
};

/**
 * Base command
 */
export class Command {
  constructor(data) {
    this.id = data.id || this._generateId();
    this.type = data.type;
    this.aggregateId = data.aggregateId;
    this.userId = data.userId;
    this.data = data.data || {};
    this.timestamp = data.timestamp || Date.now();
    this.metadata = data.metadata || {};
  }
  
  _generateId() {
    return `cmd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  validate() {
    if (!this.type) throw new Error('Command type is required');
    if (!this.aggregateId) throw new Error('Aggregate ID is required');
  }
}

/**
 * Base query
 */
export class Query {
  constructor(data) {
    this.id = data.id || this._generateId();
    this.type = data.type;
    this.filters = data.filters || {};
    this.projection = data.projection || null;
    this.sorting = data.sorting || {};
    this.pagination = data.pagination || { offset: 0, limit: 100 };
    this.timestamp = data.timestamp || Date.now();
  }
  
  _generateId() {
    return `qry-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * Command handler interface
 */
export class CommandHandler {
  constructor(name, commandType) {
    this.name = name;
    this.commandType = commandType;
  }
  
  async handle(command) {
    throw new Error('Command handler must implement handle method');
  }
  
  canHandle(commandType) {
    return this.commandType === commandType;
  }
}

/**
 * Query handler interface
 */
export class QueryHandler {
  constructor(name, queryType) {
    this.name = name;
    this.queryType = queryType;
  }
  
  async handle(query) {
    throw new Error('Query handler must implement handle method');
  }
  
  canHandle(queryType) {
    return this.queryType === queryType;
  }
}

/**
 * Aggregate root base class
 */
export class AggregateRoot extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.version = 0;
    this.uncommittedEvents = [];
  }
  
  applyEvent(event) {
    const handler = this[`on${event.type}`];
    if (handler) {
      handler.call(this, event);
    }
    this.version = event.version;
  }
  
  raiseEvent(eventType, eventData) {
    const event = {
      type: eventType,
      aggregateId: this.id,
      aggregateType: this.constructor.name,
      version: this.version + 1,
      data: eventData,
      timestamp: Date.now()
    };
    
    this.applyEvent(event);
    this.uncommittedEvents.push(event);
    
    return event;
  }
  
  markEventsAsCommitted() {
    this.uncommittedEvents = [];
  }
  
  getUncommittedEvents() {
    return this.uncommittedEvents;
  }
  
  loadFromHistory(events) {
    events.forEach(event => this.applyEvent(event));
  }
}

/**
 * Projection base class
 */
export class Projection {
  constructor(name, eventTypes) {
    this.name = name;
    this.eventTypes = eventTypes;
    this.state = new Map();
  }
  
  handles(eventType) {
    return this.eventTypes.includes(eventType);
  }
  
  async handle(event) {
    const handler = this[`on${event.type}`];
    if (handler) {
      await handler.call(this, event);
    }
  }
  
  async query(query) {
    throw new Error('Projection must implement query method');
  }
  
  async reset() {
    this.state.clear();
  }
}

/**
 * Command bus
 */
export class CommandBus extends EventEmitter {
  constructor(eventStore) {
    super();
    this.eventStore = eventStore;
    this.handlers = new Map();
    this.middleware = [];
    
    this.metrics = {
      totalCommands: 0,
      successfulCommands: 0,
      failedCommands: 0,
      commandsByType: new Map()
    };
  }
  
  /**
   * Register command handler
   */
  registerHandler(handler) {
    if (this.handlers.has(handler.commandType)) {
      throw new Error(`Handler already registered for command type: ${handler.commandType}`);
    }
    
    this.handlers.set(handler.commandType, handler);
    logger.info(`Registered command handler: ${handler.name} for ${handler.commandType}`);
  }
  
  /**
   * Use middleware
   */
  use(middleware) {
    this.middleware.push(middleware);
  }
  
  /**
   * Send command
   */
  async send(commandData) {
    const command = new Command(commandData);
    command.validate();
    
    const startTime = Date.now();
    this.metrics.totalCommands++;
    
    // Update metrics by type
    const typeCount = this.metrics.commandsByType.get(command.type) || 0;
    this.metrics.commandsByType.set(command.type, typeCount + 1);
    
    try {
      // Run middleware
      for (const middleware of this.middleware) {
        await middleware(command);
      }
      
      // Find handler
      const handler = this.handlers.get(command.type);
      if (!handler) {
        throw new Error(`No handler registered for command type: ${command.type}`);
      }
      
      // Execute command
      const result = await handler.handle(command);
      
      this.metrics.successfulCommands++;
      
      this.emit('command:executed', {
        command,
        result,
        duration: Date.now() - startTime
      });
      
      return result;
      
    } catch (error) {
      this.metrics.failedCommands++;
      
      this.emit('command:failed', {
        command,
        error: error.message,
        duration: Date.now() - startTime
      });
      
      throw error;
    }
  }
  
  /**
   * Send multiple commands
   */
  async sendBatch(commands) {
    const results = [];
    
    for (const commandData of commands) {
      try {
        const result = await this.send(commandData);
        results.push({ success: true, result });
      } catch (error) {
        results.push({ success: false, error: error.message });
      }
    }
    
    return results;
  }
}

/**
 * Query bus
 */
export class QueryBus extends EventEmitter {
  constructor() {
    super();
    this.handlers = new Map();
    this.cache = new Map();
    this.cacheConfig = {
      enabled: true,
      ttl: 60000, // 1 minute
      maxSize: 1000
    };
    
    this.metrics = {
      totalQueries: 0,
      cacheHits: 0,
      cacheMisses: 0,
      queriesByType: new Map()
    };
  }
  
  /**
   * Register query handler
   */
  registerHandler(handler) {
    if (this.handlers.has(handler.queryType)) {
      throw new Error(`Handler already registered for query type: ${handler.queryType}`);
    }
    
    this.handlers.set(handler.queryType, handler);
    logger.info(`Registered query handler: ${handler.name} for ${handler.queryType}`);
  }
  
  /**
   * Execute query
   */
  async query(queryData) {
    const query = new Query(queryData);
    
    const startTime = Date.now();
    this.metrics.totalQueries++;
    
    // Update metrics by type
    const typeCount = this.metrics.queriesByType.get(query.type) || 0;
    this.metrics.queriesByType.set(query.type, typeCount + 1);
    
    try {
      // Check cache
      const cacheKey = this._getCacheKey(query);
      if (this.cacheConfig.enabled && this.cache.has(cacheKey)) {
        const cached = this.cache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheConfig.ttl) {
          this.metrics.cacheHits++;
          
          this.emit('query:cached', {
            query,
            duration: Date.now() - startTime
          });
          
          return cached.result;
        }
      }
      
      this.metrics.cacheMisses++;
      
      // Find handler
      const handler = this.handlers.get(query.type);
      if (!handler) {
        throw new Error(`No handler registered for query type: ${query.type}`);
      }
      
      // Execute query
      const result = await handler.handle(query);
      
      // Cache result
      if (this.cacheConfig.enabled) {
        this._addToCache(cacheKey, result);
      }
      
      this.emit('query:executed', {
        query,
        result,
        duration: Date.now() - startTime
      });
      
      return result;
      
    } catch (error) {
      this.emit('query:failed', {
        query,
        error: error.message,
        duration: Date.now() - startTime
      });
      
      throw error;
    }
  }
  
  /**
   * Configure cache
   */
  configureCache(config) {
    this.cacheConfig = { ...this.cacheConfig, ...config };
  }
  
  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }
  
  /**
   * Get cache key
   */
  _getCacheKey(query) {
    return JSON.stringify({
      type: query.type,
      filters: query.filters,
      projection: query.projection,
      sorting: query.sorting,
      pagination: query.pagination
    });
  }
  
  /**
   * Add to cache
   */
  _addToCache(key, result) {
    this.cache.set(key, {
      result,
      timestamp: Date.now()
    });
    
    // Evict old entries if cache full
    if (this.cache.size > this.cacheConfig.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }
}

/**
 * CQRS system
 */
export class CQRSSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      eventStore: options.eventStore || new EventStore(),
      enableSaga: options.enableSaga !== false,
      enableProjections: options.enableProjections !== false,
      ...options
    };
    
    // Core components
    this.eventStore = this.options.eventStore;
    this.commandBus = new CommandBus(this.eventStore);
    this.queryBus = new QueryBus();
    
    // Registered components
    this.aggregates = new Map();
    this.projections = new Map();
    this.sagas = new Map();
    
    // Metrics
    this.metrics = {
      aggregatesLoaded: 0,
      projectionsRebuilt: 0,
      sagasExecuted: 0
    };
  }
  
  /**
   * Initialize CQRS system
   */
  async initialize() {
    logger.info('Initializing CQRS system');
    
    await this.eventStore.initialize();
    
    // Register default middleware
    this._registerDefaultMiddleware();
    
    this.emit('initialized');
  }
  
  /**
   * Register aggregate
   */
  registerAggregate(aggregateClass) {
    this.aggregates.set(aggregateClass.name, aggregateClass);
    logger.info(`Registered aggregate: ${aggregateClass.name}`);
  }
  
  /**
   * Register projection
   */
  registerProjection(projection) {
    this.projections.set(projection.name, projection);
    
    // Register with event store
    this.eventStore.registerProjection(projection);
    
    logger.info(`Registered projection: ${projection.name}`);
  }
  
  /**
   * Register saga
   */
  registerSaga(saga) {
    if (!this.options.enableSaga) return;
    
    this.sagas.set(saga.name, saga);
    
    // Subscribe to events
    for (const eventType of saga.handles) {
      this.eventStore.subscribe(eventType, async (event) => {
        await this._executeSaga(saga, event);
      });
    }
    
    logger.info(`Registered saga: ${saga.name}`);
  }
  
  /**
   * Load aggregate
   */
  async loadAggregate(aggregateType, aggregateId) {
    const AggregateClass = this.aggregates.get(aggregateType);
    if (!AggregateClass) {
      throw new Error(`Unknown aggregate type: ${aggregateType}`);
    }
    
    const aggregate = new AggregateClass(aggregateId);
    
    // Load events
    const events = await this.eventStore.getEvents(aggregateId);
    aggregate.loadFromHistory(events);
    
    this.metrics.aggregatesLoaded++;
    
    return aggregate;
  }
  
  /**
   * Save aggregate
   */
  async saveAggregate(aggregate) {
    const events = aggregate.getUncommittedEvents();
    
    // Append events to store
    for (const event of events) {
      await this.eventStore.append(event);
    }
    
    // Mark events as committed
    aggregate.markEventsAsCommitted();
    
    return events;
  }
  
  /**
   * Execute command
   */
  async executeCommand(commandData) {
    return this.commandBus.send(commandData);
  }
  
  /**
   * Execute query
   */
  async executeQuery(queryData) {
    return this.queryBus.query(queryData);
  }
  
  /**
   * Rebuild all projections
   */
  async rebuildProjections() {
    logger.info('Rebuilding all projections');
    
    for (const projection of this.projections.values()) {
      await projection.reset();
      
      // Get all events
      const eventStream = await this.eventStore.getEventStream();
      
      // Replay events
      for (const event of eventStream) {
        if (projection.handles(event.type)) {
          await projection.handle(event);
        }
      }
      
      this.metrics.projectionsRebuilt++;
    }
    
    logger.info('Projections rebuilt');
  }
  
  /**
   * Register default middleware
   */
  _registerDefaultMiddleware() {
    // Validation middleware
    this.commandBus.use(async (command) => {
      // Validate command structure
      command.validate();
      
      // Check permissions
      // await this._checkPermissions(command);
    });
    
    // Logging middleware
    this.commandBus.use(async (command) => {
      logger.debug(`Executing command: ${command.type}`, {
        aggregateId: command.aggregateId,
        userId: command.userId
      });
    });
  }
  
  /**
   * Execute saga
   */
  async _executeSaga(saga, event) {
    try {
      const commands = await saga.handle(event);
      
      // Execute generated commands
      for (const command of commands) {
        await this.executeCommand(command);
      }
      
      this.metrics.sagasExecuted++;
      
    } catch (error) {
      logger.error(`Saga ${saga.name} failed:`, error);
      
      // Compensate if needed
      if (saga.compensate) {
        await saga.compensate(event, error);
      }
    }
  }
  
  /**
   * Get system metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      eventStore: this.eventStore.getStatistics(),
      commandBus: this.commandBus.metrics,
      queryBus: this.queryBus.metrics
    };
  }
  
  /**
   * Shutdown CQRS system
   */
  async shutdown() {
    logger.info('Shutting down CQRS system');
    
    await this.eventStore.shutdown();
    
    this.emit('shutdown');
  }
}

export default CQRSSystem;