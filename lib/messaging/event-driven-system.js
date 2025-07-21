/**
 * Event-Driven Architecture and Message Queue System
 * Pub/Sub, message queues, event sourcing, and CQRS
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { logger } from '../core/logger.js';

/**
 * Message Queue Implementation
 */
export class MessageQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      name: 'default',
      maxSize: 10000,
      maxRetries: 3,
      visibilityTimeout: 30000, // 30 seconds
      retentionPeriod: 4 * 24 * 60 * 60 * 1000, // 4 days
      deadLetterQueue: true,
      priority: true,
      persistent: false,
      ...options
    };
    
    this.messages = [];
    this.deadLetters = [];
    this.processing = new Map();
    this.stats = {
      enqueued: 0,
      dequeued: 0,
      completed: 0,
      failed: 0,
      expired: 0,
      deadLettered: 0
    };
    
    this.startMaintenance();
  }

  /**
   * Enqueue message
   */
  async enqueue(message, options = {}) {
    if (this.messages.length >= this.options.maxSize) {
      throw new Error('Queue is full');
    }
    
    const messageWrapper = {
      id: crypto.randomBytes(16).toString('hex'),
      body: message,
      priority: options.priority || 0,
      timestamp: Date.now(),
      expiresAt: options.ttl ? Date.now() + options.ttl : null,
      retries: 0,
      maxRetries: options.maxRetries || this.options.maxRetries,
      metadata: options.metadata || {},
      correlationId: options.correlationId,
      replyTo: options.replyTo
    };
    
    if (this.options.priority) {
      // Insert based on priority
      const insertIndex = this.messages.findIndex(m => m.priority < messageWrapper.priority);
      if (insertIndex === -1) {
        this.messages.push(messageWrapper);
      } else {
        this.messages.splice(insertIndex, 0, messageWrapper);
      }
    } else {
      this.messages.push(messageWrapper);
    }
    
    this.stats.enqueued++;
    
    if (this.options.persistent) {
      await this.persist(messageWrapper);
    }
    
    this.emit('message-enqueued', {
      id: messageWrapper.id,
      queueSize: this.messages.length
    });
    
    return messageWrapper.id;
  }

  /**
   * Dequeue message
   */
  async dequeue(options = {}) {
    // Remove expired messages
    this.removeExpiredMessages();
    
    if (this.messages.length === 0) {
      return null;
    }
    
    const message = this.messages.shift();
    
    // Mark as processing
    const processingEntry = {
      message,
      startTime: Date.now(),
      visibilityTimeout: options.visibilityTimeout || this.options.visibilityTimeout
    };
    
    this.processing.set(message.id, processingEntry);
    
    this.stats.dequeued++;
    
    this.emit('message-dequeued', {
      id: message.id,
      queueSize: this.messages.length
    });
    
    return {
      id: message.id,
      body: message.body,
      metadata: message.metadata,
      attempts: message.retries + 1,
      timestamp: message.timestamp,
      correlationId: message.correlationId,
      replyTo: message.replyTo
    };
  }

  /**
   * Acknowledge message completion
   */
  async ack(messageId) {
    const processing = this.processing.get(messageId);
    if (!processing) {
      throw new Error('Message not found in processing');
    }
    
    this.processing.delete(messageId);
    this.stats.completed++;
    
    if (this.options.persistent) {
      await this.remove(messageId);
    }
    
    this.emit('message-completed', {
      id: messageId,
      duration: Date.now() - processing.startTime
    });
  }

  /**
   * Negative acknowledge (return to queue)
   */
  async nack(messageId, options = {}) {
    const processing = this.processing.get(messageId);
    if (!processing) {
      throw new Error('Message not found in processing');
    }
    
    const message = processing.message;
    message.retries++;
    
    this.processing.delete(messageId);
    this.stats.failed++;
    
    // Check if should go to dead letter queue
    if (message.retries >= message.maxRetries) {
      if (this.options.deadLetterQueue) {
        this.deadLetters.push({
          ...message,
          deadLetteredAt: Date.now(),
          reason: options.reason || 'Max retries exceeded'
        });
        
        this.stats.deadLettered++;
        
        this.emit('message-dead-lettered', {
          id: messageId,
          reason: options.reason
        });
      }
    } else {
      // Re-queue with delay
      const delay = options.delay || Math.pow(2, message.retries) * 1000;
      
      setTimeout(() => {
        if (this.options.priority) {
          const insertIndex = this.messages.findIndex(m => m.priority < message.priority);
          if (insertIndex === -1) {
            this.messages.push(message);
          } else {
            this.messages.splice(insertIndex, 0, message);
          }
        } else {
          this.messages.push(message);
        }
        
        this.emit('message-requeued', {
          id: messageId,
          retries: message.retries
        });
      }, delay);
    }
  }

  /**
   * Batch enqueue
   */
  async enqueueBatch(messages) {
    const results = [];
    
    for (const message of messages) {
      try {
        const id = await this.enqueue(message.body, message.options);
        results.push({ success: true, id });
      } catch (error) {
        results.push({ success: false, error: error.message });
      }
    }
    
    return results;
  }

  /**
   * Batch dequeue
   */
  async dequeueBatch(count, options = {}) {
    const messages = [];
    
    for (let i = 0; i < count && this.messages.length > 0; i++) {
      const message = await this.dequeue(options);
      if (message) {
        messages.push(message);
      }
    }
    
    return messages;
  }

  /**
   * Start maintenance tasks
   */
  startMaintenance() {
    // Check for stuck messages
    setInterval(() => {
      this.checkStuckMessages();
    }, 10000); // Every 10 seconds
    
    // Clean expired messages
    setInterval(() => {
      this.removeExpiredMessages();
    }, 60000); // Every minute
    
    // Clean old dead letters
    setInterval(() => {
      this.cleanDeadLetters();
    }, 3600000); // Every hour
  }

  /**
   * Check for stuck messages
   */
  checkStuckMessages() {
    const now = Date.now();
    
    for (const [messageId, processing] of this.processing) {
      if (now - processing.startTime > processing.visibilityTimeout) {
        // Message is stuck, return to queue
        this.nack(messageId, { reason: 'Visibility timeout exceeded' });
      }
    }
  }

  /**
   * Remove expired messages
   */
  removeExpiredMessages() {
    const now = Date.now();
    const initialLength = this.messages.length;
    
    this.messages = this.messages.filter(message => {
      if (message.expiresAt && now > message.expiresAt) {
        this.stats.expired++;
        return false;
      }
      return true;
    });
    
    if (this.messages.length < initialLength) {
      this.emit('messages-expired', {
        count: initialLength - this.messages.length
      });
    }
  }

  /**
   * Clean old dead letters
   */
  cleanDeadLetters() {
    const cutoff = Date.now() - this.options.retentionPeriod;
    this.deadLetters = this.deadLetters.filter(message => 
      message.deadLetteredAt > cutoff
    );
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      name: this.options.name,
      size: this.messages.length,
      processing: this.processing.size,
      deadLetters: this.deadLetters.length,
      stats: { ...this.stats }
    };
  }

  /**
   * Persistence methods (stubs)
   */
  async persist(message) {
    // In production, save to database or disk
  }
  
  async remove(messageId) {
    // In production, remove from storage
  }
}

/**
 * Event Bus for Pub/Sub
 */
export class EventBus extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      maxListeners: 100,
      wildcard: true,
      delimiter: '.',
      newListener: false,
      removeListener: false,
      verboseMemoryLeak: true,
      ...options
    };
    
    this.setMaxListeners(this.options.maxListeners);
    
    this.subscriptions = new Map();
    this.messageHistory = [];
    this.stats = {
      published: 0,
      delivered: 0,
      failed: 0
    };
    
    this.patterns = new Map(); // For wildcard subscriptions
  }

  /**
   * Subscribe to events
   */
  subscribe(topic, handler, options = {}) {
    const subscription = {
      id: crypto.randomBytes(8).toString('hex'),
      topic,
      handler,
      filter: options.filter,
      transform: options.transform,
      priority: options.priority || 0,
      maxRetries: options.maxRetries || 0,
      retries: 0
    };
    
    // Handle wildcard subscriptions
    if (this.options.wildcard && topic.includes('*')) {
      const pattern = this.topicToRegex(topic);
      this.patterns.set(subscription.id, { pattern, subscription });
    } else {
      if (!this.subscriptions.has(topic)) {
        this.subscriptions.set(topic, []);
      }
      
      const subscribers = this.subscriptions.get(topic);
      
      // Insert based on priority
      const insertIndex = subscribers.findIndex(s => s.priority < subscription.priority);
      if (insertIndex === -1) {
        subscribers.push(subscription);
      } else {
        subscribers.splice(insertIndex, 0, subscription);
      }
    }
    
    this.emit('subscription-added', { topic, subscriptionId: subscription.id });
    
    return subscription.id;
  }

  /**
   * Unsubscribe
   */
  unsubscribe(subscriptionId) {
    // Check patterns first
    if (this.patterns.has(subscriptionId)) {
      this.patterns.delete(subscriptionId);
      return true;
    }
    
    // Check regular subscriptions
    for (const [topic, subscribers] of this.subscriptions) {
      const index = subscribers.findIndex(s => s.id === subscriptionId);
      if (index !== -1) {
        subscribers.splice(index, 1);
        if (subscribers.length === 0) {
          this.subscriptions.delete(topic);
        }
        return true;
      }
    }
    
    return false;
  }

  /**
   * Publish event
   */
  async publish(topic, data, options = {}) {
    const event = {
      id: crypto.randomBytes(16).toString('hex'),
      topic,
      data,
      timestamp: Date.now(),
      metadata: options.metadata || {},
      correlationId: options.correlationId
    };
    
    // Store in history if enabled
    if (options.store) {
      this.messageHistory.push(event);
      if (this.messageHistory.length > 1000) {
        this.messageHistory.shift();
      }
    }
    
    this.stats.published++;
    
    // Get all matching subscribers
    const subscribers = this.getSubscribers(topic);
    
    // Deliver to subscribers
    const deliveryPromises = subscribers.map(subscription => 
      this.deliverToSubscriber(event, subscription)
    );
    
    const results = await Promise.allSettled(deliveryPromises);
    
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    this.stats.delivered += successful;
    this.stats.failed += failed;
    
    this.emit('event-published', {
      topic,
      eventId: event.id,
      subscribers: subscribers.length,
      successful,
      failed
    });
    
    return {
      eventId: event.id,
      delivered: successful,
      failed
    };
  }

  /**
   * Get matching subscribers
   */
  getSubscribers(topic) {
    const subscribers = [];
    
    // Direct subscribers
    if (this.subscriptions.has(topic)) {
      subscribers.push(...this.subscriptions.get(topic));
    }
    
    // Pattern subscribers
    for (const { pattern, subscription } of this.patterns.values()) {
      if (pattern.test(topic)) {
        subscribers.push(subscription);
      }
    }
    
    // Sort by priority
    return subscribers.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Deliver event to subscriber
   */
  async deliverToSubscriber(event, subscription) {
    try {
      // Apply filter
      if (subscription.filter && !subscription.filter(event)) {
        return;
      }
      
      // Apply transformation
      let eventData = event.data;
      if (subscription.transform) {
        eventData = subscription.transform(eventData);
      }
      
      // Call handler
      await subscription.handler({
        ...event,
        data: eventData
      });
      
      subscription.retries = 0;
      
    } catch (error) {
      subscription.retries++;
      
      if (subscription.retries <= subscription.maxRetries) {
        // Retry with exponential backoff
        const delay = Math.pow(2, subscription.retries) * 1000;
        setTimeout(() => {
          this.deliverToSubscriber(event, subscription);
        }, delay);
      } else {
        this.emit('delivery-failed', {
          subscriptionId: subscription.id,
          eventId: event.id,
          error: error.message
        });
        
        throw error;
      }
    }
  }

  /**
   * Convert topic with wildcards to regex
   */
  topicToRegex(topic) {
    const delimiter = this.options.delimiter;
    const escaped = topic
      .split(delimiter)
      .map(part => {
        if (part === '*') return '[^' + delimiter + ']+';
        if (part === '**') return '.*';
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('\\' + delimiter);
    
    return new RegExp('^' + escaped + '$');
  }

  /**
   * Request-Reply pattern
   */
  async request(topic, data, options = {}) {
    const replyTopic = `${topic}.reply.${crypto.randomBytes(8).toString('hex')}`;
    const timeout = options.timeout || 30000;
    
    return new Promise((resolve, reject) => {
      let subscriptionId;
      
      // Setup timeout
      const timer = setTimeout(() => {
        if (subscriptionId) {
          this.unsubscribe(subscriptionId);
        }
        reject(new Error('Request timeout'));
      }, timeout);
      
      // Subscribe to reply
      subscriptionId = this.subscribe(replyTopic, (event) => {
        clearTimeout(timer);
        this.unsubscribe(subscriptionId);
        resolve(event.data);
      });
      
      // Publish request
      this.publish(topic, data, {
        metadata: {
          replyTo: replyTopic,
          ...options.metadata
        }
      });
    });
  }

  /**
   * Get bus status
   */
  getStatus() {
    const topicsCount = this.subscriptions.size;
    const subscribersCount = Array.from(this.subscriptions.values())
      .reduce((sum, subs) => sum + subs.length, 0);
    const patternsCount = this.patterns.size;
    
    return {
      topics: topicsCount,
      subscribers: subscribersCount + patternsCount,
      patterns: patternsCount,
      historySize: this.messageHistory.length,
      stats: { ...this.stats }
    };
  }
}

/**
 * Event Store for Event Sourcing
 */
export class EventStore extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      snapshotFrequency: 100,
      retentionPeriod: 30 * 24 * 60 * 60 * 1000, // 30 days
      compactionEnabled: true,
      ...options
    };
    
    this.streams = new Map();
    this.snapshots = new Map();
    this.projections = new Map();
  }

  /**
   * Append event to stream
   */
  async append(streamId, event, expectedVersion = -1) {
    if (!this.streams.has(streamId)) {
      this.streams.set(streamId, {
        id: streamId,
        events: [],
        version: -1,
        metadata: {}
      });
    }
    
    const stream = this.streams.get(streamId);
    
    // Check expected version
    if (expectedVersion !== -1 && stream.version !== expectedVersion) {
      throw new Error('Concurrency conflict: unexpected version');
    }
    
    const eventWrapper = {
      id: crypto.randomBytes(16).toString('hex'),
      streamId,
      type: event.type,
      data: event.data,
      metadata: event.metadata || {},
      version: stream.version + 1,
      timestamp: Date.now()
    };
    
    stream.events.push(eventWrapper);
    stream.version++;
    
    // Create snapshot if needed
    if (stream.version % this.options.snapshotFrequency === 0) {
      await this.createSnapshot(streamId);
    }
    
    // Update projections
    await this.updateProjections(eventWrapper);
    
    this.emit('event-appended', {
      streamId,
      eventId: eventWrapper.id,
      version: eventWrapper.version
    });
    
    return eventWrapper;
  }

  /**
   * Read events from stream
   */
  async read(streamId, options = {}) {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return [];
    }
    
    let events = stream.events;
    
    // Apply filters
    if (options.fromVersion !== undefined) {
      events = events.filter(e => e.version >= options.fromVersion);
    }
    
    if (options.toVersion !== undefined) {
      events = events.filter(e => e.version <= options.toVersion);
    }
    
    if (options.types) {
      events = events.filter(e => options.types.includes(e.type));
    }
    
    if (options.fromTimestamp) {
      events = events.filter(e => e.timestamp >= options.fromTimestamp);
    }
    
    if (options.toTimestamp) {
      events = events.filter(e => e.timestamp <= options.toTimestamp);
    }
    
    // Apply limit
    if (options.limit) {
      events = events.slice(0, options.limit);
    }
    
    return events;
  }

  /**
   * Get current state by replaying events
   */
  async getState(streamId, options = {}) {
    // Check for snapshot
    let state = {};
    let fromVersion = 0;
    
    if (this.snapshots.has(streamId)) {
      const snapshot = this.snapshots.get(streamId);
      state = { ...snapshot.state };
      fromVersion = snapshot.version + 1;
    }
    
    // Apply events since snapshot
    const events = await this.read(streamId, { fromVersion });
    
    for (const event of events) {
      state = this.applyEvent(state, event);
    }
    
    return state;
  }

  /**
   * Apply event to state (event sourcing reducer)
   */
  applyEvent(state, event) {
    // This should be customized per domain
    switch (event.type) {
      case 'created':
        return { ...state, ...event.data, version: event.version };
        
      case 'updated':
        return { ...state, ...event.data, version: event.version };
        
      case 'deleted':
        return { ...state, deleted: true, version: event.version };
        
      default:
        return state;
    }
  }

  /**
   * Create snapshot
   */
  async createSnapshot(streamId) {
    const state = await this.getState(streamId);
    const stream = this.streams.get(streamId);
    
    const snapshot = {
      streamId,
      version: stream.version,
      state,
      timestamp: Date.now()
    };
    
    this.snapshots.set(streamId, snapshot);
    
    this.emit('snapshot-created', {
      streamId,
      version: snapshot.version
    });
  }

  /**
   * Register projection
   */
  registerProjection(name, projection) {
    this.projections.set(name, {
      name,
      handler: projection.handler,
      filter: projection.filter,
      state: projection.initialState || {}
    });
  }

  /**
   * Update projections
   */
  async updateProjections(event) {
    for (const [name, projection] of this.projections) {
      if (!projection.filter || projection.filter(event)) {
        projection.state = await projection.handler(projection.state, event);
        
        this.emit('projection-updated', {
          name,
          eventId: event.id
        });
      }
    }
  }

  /**
   * Get projection state
   */
  getProjection(name) {
    const projection = this.projections.get(name);
    return projection ? projection.state : null;
  }

  /**
   * Replay events
   */
  async replay(options = {}) {
    const { fromTimestamp, toTimestamp, streamId, projection } = options;
    
    // Get all relevant events
    const events = [];
    
    if (streamId) {
      events.push(...await this.read(streamId, { fromTimestamp, toTimestamp }));
    } else {
      for (const stream of this.streams.values()) {
        events.push(...stream.events.filter(e => {
          if (fromTimestamp && e.timestamp < fromTimestamp) return false;
          if (toTimestamp && e.timestamp > toTimestamp) return false;
          return true;
        }));
      }
    }
    
    // Sort by timestamp
    events.sort((a, b) => a.timestamp - b.timestamp);
    
    // Replay to projection
    if (projection) {
      const proj = this.projections.get(projection);
      if (proj) {
        proj.state = proj.initialState || {};
        
        for (const event of events) {
          if (!proj.filter || proj.filter(event)) {
            proj.state = await proj.handler(proj.state, event);
          }
        }
      }
    }
    
    return events;
  }
}

/**
 * CQRS Command Bus
 */
export class CommandBus extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      timeout: 30000,
      validation: true,
      ...options
    };
    
    this.handlers = new Map();
    this.middleware = [];
    this.stats = {
      executed: 0,
      succeeded: 0,
      failed: 0,
      rejected: 0
    };
  }

  /**
   * Register command handler
   */
  register(commandType, handler) {
    if (this.handlers.has(commandType)) {
      throw new Error(`Handler already registered for ${commandType}`);
    }
    
    this.handlers.set(commandType, {
      type: commandType,
      handler: handler.execute || handler,
      validator: handler.validate,
      authorizer: handler.authorize
    });
  }

  /**
   * Execute command
   */
  async execute(command) {
    const startTime = Date.now();
    
    try {
      // Get handler
      const handler = this.handlers.get(command.type);
      if (!handler) {
        throw new Error(`No handler registered for ${command.type}`);
      }
      
      // Apply middleware
      const context = await this.applyMiddleware(command);
      
      // Validate
      if (this.options.validation && handler.validator) {
        const validation = await handler.validator(command);
        if (!validation.valid) {
          this.stats.rejected++;
          throw new ValidationError('Command validation failed', validation.errors);
        }
      }
      
      // Authorize
      if (handler.authorizer) {
        const authorized = await handler.authorizer(command, context);
        if (!authorized) {
          this.stats.rejected++;
          throw new AuthorizationError('Command authorization failed');
        }
      }
      
      // Execute with timeout
      const result = await Promise.race([
        handler.handler(command, context),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Command timeout')), this.options.timeout);
        })
      ]);
      
      this.stats.executed++;
      this.stats.succeeded++;
      
      this.emit('command-executed', {
        type: command.type,
        commandId: command.id,
        duration: Date.now() - startTime,
        result
      });
      
      return result;
      
    } catch (error) {
      this.stats.executed++;
      this.stats.failed++;
      
      this.emit('command-failed', {
        type: command.type,
        commandId: command.id,
        duration: Date.now() - startTime,
        error: error.message
      });
      
      throw error;
    }
  }

  /**
   * Add middleware
   */
  use(middleware) {
    this.middleware.push(middleware);
  }

  /**
   * Apply middleware
   */
  async applyMiddleware(command) {
    let context = {};
    
    for (const mw of this.middleware) {
      context = await mw(command, context);
    }
    
    return context;
  }

  /**
   * Get bus status
   */
  getStatus() {
    return {
      handlers: this.handlers.size,
      middleware: this.middleware.length,
      stats: { ...this.stats }
    };
  }
}

/**
 * Validation error
 */
class ValidationError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/**
 * Authorization error
 */
class AuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

/**
 * Message broker for inter-service communication
 */
export class MessageBroker extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      heartbeatInterval: 30000,
      reconnectDelay: 5000,
      maxReconnectAttempts: 10,
      ...options
    };
    
    this.channels = new Map();
    this.consumers = new Map();
    this.producers = new Map();
    this.connections = new Map();
  }

  /**
   * Create channel
   */
  async createChannel(name, options = {}) {
    const channel = {
      name,
      type: options.type || 'direct', // direct, fanout, topic
      durable: options.durable !== false,
      autoDelete: options.autoDelete || false,
      bindings: new Map(),
      consumers: new Set()
    };
    
    this.channels.set(name, channel);
    
    this.emit('channel-created', { name });
    
    return channel;
  }

  /**
   * Publish message
   */
  async publish(channel, routingKey, message, options = {}) {
    const ch = this.channels.get(channel);
    if (!ch) {
      throw new Error(`Channel ${channel} not found`);
    }
    
    const messageWrapper = {
      id: crypto.randomBytes(16).toString('hex'),
      channel,
      routingKey,
      content: message,
      timestamp: Date.now(),
      headers: options.headers || {},
      persistent: options.persistent !== false,
      priority: options.priority || 0,
      expiration: options.ttl
    };
    
    // Route based on channel type
    const consumers = this.route(ch, routingKey);
    
    // Deliver to consumers
    const deliveries = consumers.map(consumerId => 
      this.deliverToConsumer(consumerId, messageWrapper)
    );
    
    await Promise.all(deliveries);
    
    this.emit('message-published', {
      channel,
      routingKey,
      messageId: messageWrapper.id,
      consumers: consumers.length
    });
    
    return messageWrapper.id;
  }

  /**
   * Consume messages
   */
  async consume(channel, queue, handler, options = {}) {
    const consumerId = crypto.randomBytes(8).toString('hex');
    
    const consumer = {
      id: consumerId,
      channel,
      queue,
      handler,
      prefetch: options.prefetch || 1,
      autoAck: options.autoAck !== false,
      exclusive: options.exclusive || false,
      processing: 0
    };
    
    this.consumers.set(consumerId, consumer);
    
    const ch = this.channels.get(channel);
    if (ch) {
      ch.consumers.add(consumerId);
    }
    
    this.emit('consumer-created', {
      channel,
      queue,
      consumerId
    });
    
    return consumerId;
  }

  /**
   * Route message based on channel type
   */
  route(channel, routingKey) {
    const consumers = [];
    
    switch (channel.type) {
      case 'direct':
        // Direct routing - exact match
        for (const consumerId of channel.consumers) {
          const consumer = this.consumers.get(consumerId);
          if (consumer && consumer.queue === routingKey) {
            consumers.push(consumerId);
          }
        }
        break;
        
      case 'fanout':
        // Fanout - all consumers
        consumers.push(...channel.consumers);
        break;
        
      case 'topic':
        // Topic - pattern matching
        for (const consumerId of channel.consumers) {
          const consumer = this.consumers.get(consumerId);
          if (consumer && this.matchTopicPattern(consumer.queue, routingKey)) {
            consumers.push(consumerId);
          }
        }
        break;
    }
    
    return consumers;
  }

  /**
   * Match topic pattern
   */
  matchTopicPattern(pattern, routingKey) {
    const regex = pattern
      .split('.')
      .map(part => {
        if (part === '*') return '[^.]+';
        if (part === '#') return '.*';
        return part;
      })
      .join('\\.');
    
    return new RegExp('^' + regex + '$').test(routingKey);
  }

  /**
   * Deliver to consumer
   */
  async deliverToConsumer(consumerId, message) {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) return;
    
    // Check prefetch limit
    if (consumer.processing >= consumer.prefetch) {
      // Queue for later
      setTimeout(() => this.deliverToConsumer(consumerId, message), 100);
      return;
    }
    
    consumer.processing++;
    
    try {
      await consumer.handler(message);
      
      if (consumer.autoAck) {
        consumer.processing--;
      }
    } catch (error) {
      consumer.processing--;
      
      this.emit('consumer-error', {
        consumerId,
        messageId: message.id,
        error: error.message
      });
    }
  }

  /**
   * Acknowledge message
   */
  ack(consumerId) {
    const consumer = this.consumers.get(consumerId);
    if (consumer && consumer.processing > 0) {
      consumer.processing--;
    }
  }

  /**
   * Get broker status
   */
  getStatus() {
    return {
      channels: Array.from(this.channels.entries()).map(([name, channel]) => ({
        name,
        type: channel.type,
        consumers: channel.consumers.size
      })),
      consumers: this.consumers.size,
      producers: this.producers.size
    };
  }
}

export default {
  MessageQueue,
  EventBus,
  EventStore,
  CommandBus,
  MessageBroker
};