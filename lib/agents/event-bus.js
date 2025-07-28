import EventEmitter from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('Agent');

/**
 * Enhanced Event Bus for Agent Communication
 * Provides advanced messaging, routing, and coordination capabilities
 */
export class AgentEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100); // Allow many agents to listen
    
    this.messageQueue = [];
    this.routingRules = new Map();
    this.messageHistory = [];
    this.subscriptions = new Map();
    this.priorities = {
      critical: 1,
      high: 2,
      medium: 3,
      low: 4
    };
    
    this.stats = {
      messagesProcessed: 0,
      messagesQueued: 0,
      averageProcessingTime: 0,
      totalProcessingTime: 0
    };
    
    this.isProcessing = false;
    this.processingQueue = [];
  }

  /**
   * Subscribe an agent to specific event types
   */
  subscribe(agentName, eventTypes, handler, options = {}) {
    if (!this.subscriptions.has(agentName)) {
      this.subscriptions.set(agentName, new Map());
    }
    
    const agentSubs = this.subscriptions.get(agentName);
    
    for (const eventType of eventTypes) {
      if (!agentSubs.has(eventType)) {
        agentSubs.set(eventType, []);
      }
      
      const subscription = {
        handler,
        priority: options.priority || 'medium',
        filter: options.filter,
        once: options.once || false,
        created: Date.now()
      };
      
      agentSubs.get(eventType).push(subscription);
      
      // Also register with EventEmitter
      if (subscription.once) {
        this.once(eventType, handler);
      } else {
        this.on(eventType, handler);
      }
      
      logger.debug(`Agent ${agentName} subscribed to ${eventType}`, {
        priority: subscription.priority,
        hasFilter: !!subscription.filter
      });
    }
  }

  /**
   * Unsubscribe an agent from events
   */
  unsubscribe(agentName, eventTypes = null) {
    const agentSubs = this.subscriptions.get(agentName);
    if (!agentSubs) return;
    
    const typesToRemove = eventTypes || Array.from(agentSubs.keys());
    
    for (const eventType of typesToRemove) {
      const subscriptions = agentSubs.get(eventType) || [];
      
      for (const subscription of subscriptions) {
        this.removeListener(eventType, subscription.handler);
      }
      
      agentSubs.delete(eventType);
      logger.debug(`Agent ${agentName} unsubscribed from ${eventType}`);
    }
    
    if (agentSubs.size === 0) {
      this.subscriptions.delete(agentName);
    }
  }

  /**
   * Publish a message with advanced routing and priority
   */
  async publish(eventType, data, options = {}) {
    const message = {
      id: this.generateMessageId(),
      type: eventType,
      data,
      timestamp: Date.now(),
      source: options.source || 'system',
      priority: options.priority || 'medium',
      targets: options.targets, // Specific target agents
      ttl: options.ttl || 300000, // 5 minutes default TTL
      persistent: options.persistent || false,
      correlation: options.correlation
    };

    // Add to message history
    this.addToHistory(message);
    
    // Check if message should be queued or processed immediately
    if (this.shouldQueue(message)) {
      this.queueMessage(message);
      this.stats.messagesQueued++;
    } else {
      await this.processMessage(message);
    }

    logger.debug(`Published message: ${eventType}`, {
      messageId: message.id,
      source: message.source,
      priority: message.priority,
      targets: message.targets
    });

    return message.id;
  }

  /**
   * Add routing rule for automatic message forwarding
   */
  addRoutingRule(name, condition, action) {
    this.routingRules.set(name, {
      condition,
      action,
      created: Date.now(),
      triggered: 0
    });
    
    logger.info(`Added routing rule: ${name}`);
  }

  /**
   * Remove routing rule
   */
  removeRoutingRule(name) {
    const removed = this.routingRules.delete(name);
    if (removed) {
      logger.info(`Removed routing rule: ${name}`);
    }
    return removed;
  }

  /**
   * Process message queue
   */
  async processMessageQueue() {
    if (this.isProcessing || this.messageQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      // Sort queue by priority
      this.messageQueue.sort((a, b) => {
        return this.priorities[a.priority] - this.priorities[b.priority];
      });

      while (this.messageQueue.length > 0) {
        const message = this.messageQueue.shift();
        
        // Check TTL
        if (Date.now() - message.timestamp > message.ttl) {
          logger.warn(`Message expired: ${message.id}`);
          continue;
        }

        await this.processMessage(message);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single message
   */
  async processMessage(message) {
    const startTime = Date.now();

    try {
      // Apply routing rules
      await this.applyRoutingRules(message);
      
      // Emit the event
      if (message.targets) {
        // Targeted delivery
        await this.deliverToTargets(message);
      } else {
        // Broadcast delivery
        this.emit(message.type, {
          ...message.data,
          _meta: {
            messageId: message.id,
            source: message.source,
            timestamp: message.timestamp,
            correlation: message.correlation
          }
        });
      }

      this.stats.messagesProcessed++;
      
    } catch (error) {
      logger.error(`Error processing message ${message.id}:`, error);
    } finally {
      const processingTime = Date.now() - startTime;
      this.updateProcessingStats(processingTime);
    }
  }

  /**
   * Apply routing rules to message
   */
  async applyRoutingRules(message) {
    for (const [name, rule] of this.routingRules) {
      try {
        if (rule.condition(message)) {
          await rule.action(message);
          rule.triggered++;
          
          logger.debug(`Routing rule triggered: ${name}`, {
            messageId: message.id,
            totalTriggers: rule.triggered
          });
        }
      } catch (error) {
        logger.error(`Error in routing rule ${name}:`, error);
      }
    }
  }

  /**
   * Deliver message to specific targets
   */
  async deliverToTargets(message) {
    const promises = message.targets.map(async (target) => {
      const agentSubs = this.subscriptions.get(target);
      if (!agentSubs) {
        logger.warn(`Target agent not found: ${target}`);
        return;
      }

      const typeSubscriptions = agentSubs.get(message.type) || [];
      
      for (const subscription of typeSubscriptions) {
        try {
          // Apply filter if present
          if (subscription.filter && !subscription.filter(message)) {
            continue;
          }

          await subscription.handler({
            ...message.data,
            _meta: {
              messageId: message.id,
              source: message.source,
              timestamp: message.timestamp,
              correlation: message.correlation,
              target: target
            }
          });

          // Remove if once subscription
          if (subscription.once) {
            const index = typeSubscriptions.indexOf(subscription);
            typeSubscriptions.splice(index, 1);
          }
          
        } catch (error) {
          logger.error(`Error delivering to ${target}:`, error);
        }
      }
    });

    await Promise.all(promises);
  }

  /**
   * Request-response pattern
   */
  async request(eventType, data, options = {}) {
    const timeout = options.timeout || 10000;
    const correlationId = this.generateMessageId();
    
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.removeListener(`response:${correlationId}`, responseHandler);
        reject(new Error(`Request timeout: ${eventType}`));
      }, timeout);

      const responseHandler = (response) => {
        clearTimeout(timeoutId);
        resolve(response);
      };

      // Listen for response
      this.once(`response:${correlationId}`, responseHandler);

      // Send request
      this.publish(eventType, data, {
        ...options,
        correlation: correlationId
      });
    });
  }

  /**
   * Send response to a request
   */
  async respond(correlationId, data, options = {}) {
    if (!correlationId) {
      throw new Error('Correlation ID required for response');
    }

    await this.publish(`response:${correlationId}`, data, {
      ...options,
      source: options.source || 'response'
    });
  }

  /**
   * Broadcast to all agents of specific types
   */
  async broadcast(eventType, data, agentTypes = null, options = {}) {
    const targets = [];
    
    if (agentTypes) {
      // Filter by agent types - would need agent registry
      // For now, broadcast to all
    }

    await this.publish(eventType, data, {
      ...options,
      targets: targets.length > 0 ? targets : undefined
    });
  }

  /**
   * Queue management
   */
  shouldQueue(message) {
    // Queue if currently processing or if low priority and queue not empty
    return this.isProcessing || 
           (message.priority === 'low' && this.messageQueue.length > 0);
  }

  queueMessage(message) {
    this.messageQueue.push(message);
    
    // Process queue in next tick to avoid blocking
    setImmediate(() => {
      this.processMessageQueue();
    });
  }

  /**
   * Message history management
   */
  addToHistory(message) {
    this.messageHistory.push({
      id: message.id,
      type: message.type,
      source: message.source,
      timestamp: message.timestamp,
      priority: message.priority,
      targets: message.targets
    });

    // Keep only last 1000 messages
    if (this.messageHistory.length > 1000) {
      this.messageHistory = this.messageHistory.slice(-1000);
    }
  }

  /**
   * Get message history with filtering
   */
  getMessageHistory(filter = {}) {
    let history = this.messageHistory;

    if (filter.type) {
      history = history.filter(msg => msg.type === filter.type);
    }

    if (filter.source) {
      history = history.filter(msg => msg.source === filter.source);
    }

    if (filter.since) {
      history = history.filter(msg => msg.timestamp >= filter.since);
    }

    if (filter.limit) {
      history = history.slice(-filter.limit);
    }

    return history;
  }

  /**
   * Get system statistics
   */
  getStats() {
    return {
      ...this.stats,
      queueLength: this.messageQueue.length,
      subscriptions: this.subscriptions.size,
      routingRules: this.routingRules.size,
      historySize: this.messageHistory.length,
      activeListeners: this.listenerCount()
    };
  }

  /**
   * Health check
   */
  healthCheck() {
    const queueHealth = this.messageQueue.length < 100 ? 'healthy' : 'degraded';
    const processingHealth = this.stats.averageProcessingTime < 100 ? 'healthy' : 'slow';
    
    return {
      status: queueHealth === 'healthy' && processingHealth === 'healthy' ? 'healthy' : 'degraded',
      queue: {
        status: queueHealth,
        length: this.messageQueue.length
      },
      processing: {
        status: processingHealth,
        avgTime: this.stats.averageProcessingTime
      },
      subscriptions: this.subscriptions.size,
      uptime: Date.now() - (this.startTime || Date.now())
    };
  }

  /**
   * Cleanup expired messages and subscriptions
   */
  cleanup() {
    const now = Date.now();
    
    // Remove expired messages from queue
    this.messageQueue = this.messageQueue.filter(msg => 
      now - msg.timestamp < msg.ttl
    );

    // Clean up old history
    this.messageHistory = this.messageHistory.filter(msg =>
      now - msg.timestamp < 3600000 // 1 hour
    );

    logger.debug('Event bus cleanup completed', {
      queueLength: this.messageQueue.length,
      historySize: this.messageHistory.length
    });
  }

  /**
   * Shutdown event bus
   */
  async shutdown() {
    logger.info('Shutting down event bus');
    
    // Process remaining queue
    await this.processMessageQueue();
    
    // Clear all subscriptions
    for (const agentName of this.subscriptions.keys()) {
      this.unsubscribe(agentName);
    }
    
    // Clear routing rules
    this.routingRules.clear();
    
    // Remove all listeners
    this.removeAllListeners();
    
    logger.info('Event bus shutdown complete');
  }

  // Utility methods
  generateMessageId() {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  updateProcessingStats(processingTime) {
    this.stats.totalProcessingTime += processingTime;
    this.stats.averageProcessingTime = 
      this.stats.totalProcessingTime / this.stats.messagesProcessed;
  }

  listenerCount() {
    return this.eventNames().reduce((count, event) => {
      return count + super.listenerCount(event);
    }, 0);
  }
}

// Export singleton instance
export const agentEventBus = new AgentEventBus();