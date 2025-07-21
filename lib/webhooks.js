/**
 * Webhook System for Otedama
 * Enables external integrations via HTTP callbacks
 */

import { EventEmitter } from 'events';
import { createHash, createHmac, randomBytes } from 'crypto';
import Database from 'better-sqlite3';
import { Logger } from './logger.js';
import { getErrorHandler, OtedamaError, ErrorCategory, safeExecute } from './error-handler.js';

/**
 * Webhook events
 */
export const WebhookEvents = {
  // Mining events
  MINER_CONNECTED: 'miner.connected',
  MINER_DISCONNECTED: 'miner.disconnected',
  SHARE_SUBMITTED: 'share.submitted',
  SHARE_ACCEPTED: 'share.accepted',
  SHARE_REJECTED: 'share.rejected',
  BLOCK_FOUND: 'block.found',
  
  // Payout events
  PAYOUT_INITIATED: 'payout.initiated',
  PAYOUT_COMPLETED: 'payout.completed',
  PAYOUT_FAILED: 'payout.failed',
  BALANCE_UPDATED: 'balance.updated',
  
  // Pool events
  POOL_STATS_UPDATED: 'pool.stats.updated',
  DIFFICULTY_ADJUSTED: 'difficulty.adjusted',
  NEW_ROUND: 'round.new',
  
  // DEX events
  SWAP_EXECUTED: 'swap.executed',
  LIQUIDITY_ADDED: 'liquidity.added',
  LIQUIDITY_REMOVED: 'liquidity.removed',
  PRICE_UPDATED: 'price.updated',
  
  // System events
  SYSTEM_STARTED: 'system.started',
  SYSTEM_STOPPED: 'system.stopped',
  ERROR_OCCURRED: 'error.occurred',
  MAINTENANCE_MODE: 'maintenance.mode',
  
  // Security events
  SUSPICIOUS_ACTIVITY: 'security.suspicious',
  RATE_LIMIT_EXCEEDED: 'security.rate_limit',
  AUTHENTICATION_FAILED: 'security.auth_failed',
  
  // Custom events
  CUSTOM: 'custom'
};

/**
 * Webhook delivery status
 */
export const DeliveryStatus = {
  PENDING: 'pending',
  SENDING: 'sending',
  SUCCESS: 'success',
  FAILED: 'failed',
  RETRYING: 'retrying'
};

/**
 * Webhook Manager
 */
export class WebhookManager extends EventEmitter {
  constructor(db, options = {}) {
    super();
    this.db = db;
    this.logger = options.logger || new Logger();
    this.options = {
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000, // Start with 1 second
      timeout: options.timeout || 30000, // 30 seconds
      maxConcurrent: options.maxConcurrent || 10,
      signatureHeader: options.signatureHeader || 'X-Otedama-Signature',
      timestampHeader: options.timestampHeader || 'X-Otedama-Timestamp',
      ...options
    };
    
    this.queue = [];
    this.processing = false;
    this.activeDeliveries = 0;
    
    this.initializeDatabase();
    this.startProcessor();
  }
  
  initializeDatabase() {
    // Webhooks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        events TEXT NOT NULL,
        secret TEXT,
        active INTEGER DEFAULT 1,
        createdAt INTEGER NOT NULL,
        lastTriggered INTEGER,
        failureCount INTEGER DEFAULT 0,
        metadata TEXT,
        INDEX idx_active (active)
      )
    `);
    
    // Webhook deliveries table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhookId TEXT NOT NULL,
        event TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        createdAt INTEGER NOT NULL,
        sentAt INTEGER,
        responseStatus INTEGER,
        responseBody TEXT,
        error TEXT,
        nextRetry INTEGER,
        INDEX idx_webhookId (webhookId),
        INDEX idx_status (status),
        INDEX idx_nextRetry (nextRetry),
        FOREIGN KEY (webhookId) REFERENCES webhooks(id)
      )
    `);
  }
  
  /**
   * Register a new webhook
   */
  async register(url, events, options = {}) {
    return await safeExecute(async () => {
      // Validate URL
      try {
        new URL(url);
      } catch (error) {
        throw new OtedamaError(
          'Invalid webhook URL',
          ErrorCategory.VALIDATION,
          { url }
        );
      }
      
      // Validate events
      if (!Array.isArray(events) || events.length === 0) {
        throw new OtedamaError(
          'Events must be a non-empty array',
          ErrorCategory.VALIDATION
        );
      }
      
      const id = randomBytes(16).toString('hex');
      const secret = options.secret || randomBytes(32).toString('hex');
      
      this.db.prepare(`
        INSERT INTO webhooks (id, url, events, secret, active, createdAt, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        url,
        JSON.stringify(events),
        secret,
        options.active !== false ? 1 : 0,
        Date.now(),
        JSON.stringify(options.metadata || {})
      );
      
      this.logger.info('Webhook registered', { id, url, events });
      
      return { id, secret };
    }, {
      service: 'webhook-register',
      category: ErrorCategory.DATABASE,
      context: { url }
    });
  }
  
  /**
   * Update webhook
   */
  async update(id, updates) {
    const webhook = this.getWebhook(id);
    if (!webhook) {
      throw new Error('Webhook not found');
    }
    
    const fields = [];
    const values = [];
    
    if (updates.url !== undefined) {
      fields.push('url = ?');
      values.push(updates.url);
    }
    
    if (updates.events !== undefined) {
      fields.push('events = ?');
      values.push(JSON.stringify(updates.events));
    }
    
    if (updates.active !== undefined) {
      fields.push('active = ?');
      values.push(updates.active ? 1 : 0);
    }
    
    if (updates.metadata !== undefined) {
      fields.push('metadata = ?');
      values.push(JSON.stringify(updates.metadata));
    }
    
    if (fields.length > 0) {
      values.push(id);
      this.db.prepare(`
        UPDATE webhooks SET ${fields.join(', ')} WHERE id = ?
      `).run(...values);
      
      this.logger.info('Webhook updated', { id, updates });
    }
    
    return this.getWebhook(id);
  }
  
  /**
   * Delete webhook
   */
  async delete(id) {
    const result = this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    
    if (result.changes > 0) {
      // Also delete pending deliveries
      this.db.prepare('DELETE FROM webhook_deliveries WHERE webhookId = ? AND status = ?')
        .run(id, DeliveryStatus.PENDING);
      
      this.logger.info('Webhook deleted', { id });
      return true;
    }
    
    return false;
  }
  
  /**
   * Get webhook by ID
   */
  getWebhook(id) {
    const webhook = this.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
    
    if (webhook) {
      webhook.events = JSON.parse(webhook.events);
      webhook.metadata = JSON.parse(webhook.metadata || '{}');
      webhook.active = webhook.active === 1;
    }
    
    return webhook;
  }
  
  /**
   * List webhooks
   */
  listWebhooks(options = {}) {
    let query = 'SELECT * FROM webhooks WHERE 1=1';
    const params = [];
    
    if (options.active !== undefined) {
      query += ' AND active = ?';
      params.push(options.active ? 1 : 0);
    }
    
    if (options.event) {
      query += ' AND events LIKE ?';
      params.push(`%"${options.event}"%`);
    }
    
    query += ' ORDER BY createdAt DESC';
    
    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }
    
    const webhooks = this.db.prepare(query).all(...params);
    
    return webhooks.map(webhook => ({
      ...webhook,
      events: JSON.parse(webhook.events),
      metadata: JSON.parse(webhook.metadata || '{}'),
      active: webhook.active === 1
    }));
  }
  
  /**
   * Trigger webhook event
   */
  async trigger(event, data) {
    const webhooks = this.getActiveWebhooksForEvent(event);
    
    if (webhooks.length === 0) {
      return;
    }
    
    this.logger.debug('Triggering webhooks', { event, count: webhooks.length });
    
    const payload = {
      event,
      timestamp: Date.now(),
      data
    };
    
    for (const webhook of webhooks) {
      await this.queueDelivery(webhook, event, payload);
    }
  }
  
  /**
   * Get active webhooks for event
   */
  getActiveWebhooksForEvent(event) {
    return this.db.prepare(`
      SELECT * FROM webhooks 
      WHERE active = 1 
      AND (events LIKE ? OR events LIKE ?)
    `).all(`%"${event}"%`, '%"*"%');
  }
  
  /**
   * Queue webhook delivery
   */
  async queueDelivery(webhook, event, payload) {
    const deliveryId = randomBytes(16).toString('hex');
    
    this.db.prepare(`
      INSERT INTO webhook_deliveries (
        id, webhookId, event, payload, status, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      deliveryId,
      webhook.id,
      event,
      JSON.stringify(payload),
      DeliveryStatus.PENDING,
      Date.now()
    );
    
    this.queue.push(deliveryId);
    this.processQueue();
  }
  
  /**
   * Process delivery queue
   */
  async processQueue() {
    if (this.processing || this.activeDeliveries >= this.options.maxConcurrent) {
      return;
    }
    
    this.processing = true;
    
    while (this.queue.length > 0 && this.activeDeliveries < this.options.maxConcurrent) {
      const deliveryId = this.queue.shift();
      this.activeDeliveries++;
      
      this.deliverWebhook(deliveryId)
        .catch(error => {
          this.logger.error('Webhook delivery error', { deliveryId, error });
        })
        .finally(() => {
          this.activeDeliveries--;
          this.processQueue();
        });
    }
    
    this.processing = false;
  }
  
  /**
   * Deliver webhook
   */
  async deliverWebhook(deliveryId) {
    await safeExecute(async () => {
      const delivery = this.db.prepare(`
        SELECT d.*, w.url, w.secret 
        FROM webhook_deliveries d 
        JOIN webhooks w ON d.webhookId = w.id 
        WHERE d.id = ?
      `).get(deliveryId);
      
      if (!delivery) {
        return;
      }
      
      const payload = JSON.parse(delivery.payload);
      const body = JSON.stringify(payload);
      
      // Update status to sending
      this.updateDeliveryStatus(deliveryId, DeliveryStatus.SENDING);
      
      const errorHandler = getErrorHandler();
      const circuitBreaker = errorHandler.getCircuitBreaker(`webhook-${delivery.webhookId}`);
      
      try {
        await circuitBreaker.execute(async () => {
          // Create signature
          const timestamp = Date.now();
          const signature = this.createSignature(body, delivery.secret, timestamp);
          
          // Create AbortController for timeout
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), this.options.timeout);
          
          try {
            // Send webhook
            const response = await fetch(delivery.url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Otedama-Webhook/1.0',
                [this.options.signatureHeader]: signature,
                [this.options.timestampHeader]: timestamp.toString(),
                'X-Otedama-Event': delivery.event,
                'X-Otedama-Delivery': deliveryId
              },
              body,
              signal: controller.signal
            });
            
            clearTimeout(timeout);
            
            const responseBody = await response.text();
            
            // Update delivery record
            this.db.prepare(`
              UPDATE webhook_deliveries 
              SET status = ?, sentAt = ?, responseStatus = ?, responseBody = ?, attempts = attempts + 1
              WHERE id = ?
            `).run(
              response.ok ? DeliveryStatus.SUCCESS : DeliveryStatus.FAILED,
              Date.now(),
              response.status,
              responseBody.substring(0, 1000), // Limit response size
              deliveryId
            );
            
            if (response.ok) {
              this.logger.info('Webhook delivered successfully', { 
                deliveryId, 
                url: delivery.url, 
                status: response.status 
              });
              
              // Update webhook last triggered
              this.db.prepare(`
                UPDATE webhooks SET lastTriggered = ?, failureCount = 0 WHERE id = ?
              `).run(Date.now(), delivery.webhookId);
              
            } else {
              // Handle specific HTTP status codes
              if (response.status === 410) { // Gone
                throw new OtedamaError(
                  'Webhook endpoint no longer exists',
                  ErrorCategory.EXTERNAL_API,
                  { 
                    webhookId: delivery.webhookId,
                    url: delivery.url,
                    recoveryStrategy: 'notify_admin'
                  }
                );
              }
              
              throw new OtedamaError(
                `HTTP ${response.status}: ${responseBody}`,
                ErrorCategory.EXTERNAL_API,
                { status: response.status }
              );
            }
          } finally {
            clearTimeout(timeout);
          }
        });
        
      } catch (error) {
        // Handle specific error types
        if (error.name === 'AbortError') {
          error = new OtedamaError(
            'Webhook delivery timeout',
            ErrorCategory.NETWORK,
            { timeout: this.options.timeout }
          );
        }
        
        await errorHandler.handleError(error, {
          service: 'webhook-delivery',
          context: { 
            deliveryId, 
            url: delivery.url,
            webhookId: delivery.webhookId 
          }
        });
        
        // Update delivery error
        this.db.prepare(`
          UPDATE webhook_deliveries 
          SET status = ?, error = ?, attempts = attempts + 1 
          WHERE id = ?
        `).run(DeliveryStatus.FAILED, error.message, deliveryId);
        
        // Schedule retry if applicable
        if (delivery.attempts + 1 < this.options.maxRetries) {
          const retryDelay = this.calculateRetryDelay(delivery.attempts + 1);
          const nextRetry = Date.now() + retryDelay;
          
          this.db.prepare(`
            UPDATE webhook_deliveries 
            SET status = ?, nextRetry = ? 
            WHERE id = ?
          `).run(DeliveryStatus.RETRYING, nextRetry, deliveryId);
          
          setTimeout(() => {
            this.queue.push(deliveryId);
            this.processQueue();
          }, retryDelay);
          
        } else {
          // Update webhook failure count
          this.db.prepare(`
            UPDATE webhooks 
            SET failureCount = failureCount + 1 
            WHERE id = ?
          `).run(delivery.webhookId);
          
          // Disable webhook if too many failures
          const webhook = this.db.prepare('SELECT failureCount FROM webhooks WHERE id = ?')
            .get(delivery.webhookId);
          
          if (webhook && webhook.failureCount >= 10) {
            this.db.prepare('UPDATE webhooks SET active = 0 WHERE id = ?')
              .run(delivery.webhookId);
            
            this.logger.warn('Webhook disabled due to repeated failures', { 
              webhookId: delivery.webhookId 
            });
            
            this.emit('webhookDisabled', { 
              webhookId: delivery.webhookId,
              url: delivery.url,
              failureCount: webhook.failureCount 
            });
          }
        }
      }
    }, {
      service: 'webhook-delivery',
      category: ErrorCategory.EXTERNAL_API,
      maxRetries: 0 // Don't retry at this level, we handle retries internally
    });
  }
  
  /**
   * Update delivery status
   */
  updateDeliveryStatus(deliveryId, status) {
    this.db.prepare('UPDATE webhook_deliveries SET status = ? WHERE id = ?')
      .run(status, deliveryId);
  }
  
  /**
   * Calculate retry delay with exponential backoff
   */
  calculateRetryDelay(attempt) {
    return Math.min(
      this.options.retryDelay * Math.pow(2, attempt - 1),
      300000 // Max 5 minutes
    );
  }
  
  /**
   * Create webhook signature
   */
  createSignature(payload, secret, timestamp) {
    const message = `${timestamp}.${payload}`;
    return createHmac('sha256', secret).update(message).digest('hex');
  }
  
  /**
   * Verify webhook signature
   */
  verifySignature(payload, signature, secret, timestamp, maxAge = 300000) {
    // Check timestamp
    const now = Date.now();
    const webhookTimestamp = parseInt(timestamp);
    
    if (isNaN(webhookTimestamp) || now - webhookTimestamp > maxAge) {
      return false;
    }
    
    // Verify signature
    const expectedSignature = this.createSignature(payload, secret, webhookTimestamp);
    
    try {
      return signature === expectedSignature;
    } catch {
      return false;
    }
  }
  
  /**
   * Get delivery history
   */
  getDeliveryHistory(webhookId, options = {}) {
    let query = 'SELECT * FROM webhook_deliveries WHERE webhookId = ?';
    const params = [webhookId];
    
    if (options.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }
    
    if (options.event) {
      query += ' AND event = ?';
      params.push(options.event);
    }
    
    query += ' ORDER BY createdAt DESC';
    
    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }
    
    return this.db.prepare(query).all(...params).map(delivery => ({
      ...delivery,
      payload: JSON.parse(delivery.payload)
    }));
  }
  
  /**
   * Retry failed deliveries
   */
  async retryFailedDeliveries() {
    const failed = this.db.prepare(`
      SELECT id FROM webhook_deliveries 
      WHERE status = ? AND attempts < ?
      ORDER BY createdAt ASC
      LIMIT 100
    `).all(DeliveryStatus.FAILED, this.options.maxRetries);
    
    for (const delivery of failed) {
      this.queue.push(delivery.id);
    }
    
    this.processQueue();
    
    return failed.length;
  }
  
  /**
   * Clean old deliveries
   */
  async cleanOldDeliveries(maxAge = 7 * 24 * 60 * 60 * 1000) { // 7 days
    const cutoff = Date.now() - maxAge;
    
    const result = this.db.prepare(`
      DELETE FROM webhook_deliveries 
      WHERE createdAt < ? AND status IN (?, ?)
    `).run(cutoff, DeliveryStatus.SUCCESS, DeliveryStatus.FAILED);
    
    this.logger.info('Cleaned old webhook deliveries', { 
      deleted: result.changes 
    });
    
    return result.changes;
  }
  
  /**
   * Start background processor
   */
  startProcessor() {
    // Process pending deliveries on startup
    const pending = this.db.prepare(`
      SELECT id FROM webhook_deliveries 
      WHERE status IN (?, ?) AND (nextRetry IS NULL OR nextRetry <= ?)
      ORDER BY createdAt ASC
    `).all(DeliveryStatus.PENDING, DeliveryStatus.RETRYING, Date.now());
    
    for (const delivery of pending) {
      this.queue.push(delivery.id);
    }
    
    this.processQueue();
    
    // Periodic cleanup
    setInterval(() => {
      this.cleanOldDeliveries();
    }, 24 * 60 * 60 * 1000); // Daily
  }
  
  /**
   * Get statistics
   */
  getStats() {
    const stats = this.db.prepare(`
      SELECT 
        COUNT(CASE WHEN active = 1 THEN 1 END) as activeWebhooks,
        COUNT(CASE WHEN active = 0 THEN 1 END) as inactiveWebhooks,
        COUNT(*) as totalWebhooks
      FROM webhooks
    `).get();
    
    const deliveryStats = this.db.prepare(`
      SELECT 
        status,
        COUNT(*) as count
      FROM webhook_deliveries
      WHERE createdAt > ?
      GROUP BY status
    `).all(Date.now() - 24 * 60 * 60 * 1000); // Last 24 hours
    
    return {
      webhooks: stats,
      deliveries: deliveryStats.reduce((acc, stat) => {
        acc[stat.status] = stat.count;
        return acc;
      }, {}),
      queue: this.queue.length,
      activeDeliveries: this.activeDeliveries
    };
  }
}

// Export singleton instance
let webhookManager;

export function initializeWebhooks(db, options) {
  webhookManager = new WebhookManager(db, options);
  return webhookManager;
}

export function getWebhookManager() {
  if (!webhookManager) {
    throw new Error('Webhook manager not initialized');
  }
  return webhookManager;
}