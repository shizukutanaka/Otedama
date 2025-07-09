/**
 * Webhook Manager - Event Notification System
 * 
 * Design Philosophy:
 * - Carmack: Reliable delivery, efficient queuing
 * - Martin: Clear event types, configurable endpoints
 * - Pike: Simple configuration, predictable behavior
 */

import { EventEmitter } from 'events';
import axios, { AxiosResponse } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { UnifiedLogger } from '../logging/unified-logger';
import { UnifiedDatabase } from '../database/unified-database';

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: WebhookEventType[];
  secret: string;
  enabled: boolean;
  retryPolicy: RetryPolicy;
  headers?: Record<string, string>;
  filters?: WebhookFilter[];
  createdAt: Date;
  lastTriggered?: Date;
  successCount: number;
  failureCount: number;
}

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  timestamp: Date;
  data: any;
  metadata?: Record<string, any>;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: string;
  url: string;
  status: 'pending' | 'success' | 'failed' | 'retrying';
  attempts: number;
  maxAttempts: number;
  lastAttempt?: Date;
  nextAttempt?: Date;
  response?: {
    status: number;
    body: string;
    headers: Record<string, string>;
    duration: number;
  };
  error?: string;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMultiplier: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export interface WebhookFilter {
  field: string;
  operator: 'equals' | 'contains' | 'greater_than' | 'less_than';
  value: any;
}

export type WebhookEventType = 
  | 'block.found'
  | 'block.confirmed'
  | 'block.orphaned'
  | 'share.submitted'
  | 'share.accepted'
  | 'share.rejected'
  | 'payout.processed'
  | 'payout.failed'
  | 'miner.connected'
  | 'miner.disconnected'
  | 'miner.banned'
  | 'pool.stats_updated'
  | 'pool.difficulty_changed'
  | 'system.alert'
  | 'system.error';

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  backoffMultiplier: 2,
  initialDelayMs: 1000,
  maxDelayMs: 300000 // 5 minutes
};

export class WebhookManager extends EventEmitter {
  private endpoints: Map<string, WebhookEndpoint> = new Map();
  private deliveryQueue: WebhookDelivery[] = [];
  private processingInterval: NodeJS.Timeout | null = null;
  private retryTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private database: UnifiedDatabase,
    private logger: UnifiedLogger,
    private config = {
      processingIntervalMs: 5000, // 5 seconds
      maxConcurrentDeliveries: 10,
      requestTimeoutMs: 30000, // 30 seconds
      enableRetries: true,
      enableSignatureValidation: true
    }
  ) {
    super();
  }

  public async start(): Promise<void> {
    this.logger.info('Starting Webhook Manager...');
    
    // Load existing endpoints from database
    await this.loadEndpoints();
    
    // Start delivery processing
    this.processingInterval = setInterval(() => {
      this.processDeliveryQueue();
    }, this.config.processingIntervalMs);

    this.logger.info('Webhook Manager started');
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping Webhook Manager...');
    
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    // Clear all retry timers
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();

    this.logger.info('Webhook Manager stopped');
  }

  public async addEndpoint(endpoint: Omit<WebhookEndpoint, 'id' | 'createdAt' | 'successCount' | 'failureCount'>): Promise<WebhookEndpoint> {
    const newEndpoint: WebhookEndpoint = {
      id: uuidv4(),
      createdAt: new Date(),
      successCount: 0,
      failureCount: 0,
      retryPolicy: endpoint.retryPolicy || DEFAULT_RETRY_POLICY,
      ...endpoint
    };

    this.endpoints.set(newEndpoint.id, newEndpoint);
    await this.saveEndpoint(newEndpoint);

    this.emit('endpointAdded', newEndpoint);
    this.logger.info(`Added webhook endpoint: ${newEndpoint.url}`);

    return newEndpoint;
  }

  public async removeEndpoint(endpointId: string): Promise<void> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) {
      throw new Error(`Webhook endpoint not found: ${endpointId}`);
    }

    this.endpoints.delete(endpointId);
    await this.database.deleteWebhookEndpoint(endpointId);

    this.emit('endpointRemoved', endpoint);
    this.logger.info(`Removed webhook endpoint: ${endpoint.url}`);
  }

  public async updateEndpoint(endpointId: string, updates: Partial<WebhookEndpoint>): Promise<WebhookEndpoint> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) {
      throw new Error(`Webhook endpoint not found: ${endpointId}`);
    }

    Object.assign(endpoint, updates);
    await this.saveEndpoint(endpoint);

    this.emit('endpointUpdated', endpoint);
    this.logger.info(`Updated webhook endpoint: ${endpoint.url}`);

    return endpoint;
  }

  public async triggerEvent(type: WebhookEventType, data: any, metadata?: Record<string, any>): Promise<void> {
    const event: WebhookEvent = {
      id: uuidv4(),
      type,
      timestamp: new Date(),
      data,
      metadata
    };

    this.logger.debug(`Triggering webhook event: ${type}`, { eventId: event.id });

    // Find matching endpoints
    const matchingEndpoints = Array.from(this.endpoints.values())
      .filter(endpoint => 
        endpoint.enabled && 
        endpoint.events.includes(type) &&
        this.passesFilters(event, endpoint.filters || [])
      );

    if (matchingEndpoints.length === 0) {
      this.logger.debug(`No matching endpoints for event: ${type}`);
      return;
    }

    // Create deliveries for each matching endpoint
    for (const endpoint of matchingEndpoints) {
      const delivery: WebhookDelivery = {
        id: uuidv4(),
        webhookId: endpoint.id,
        eventId: event.id,
        url: endpoint.url,
        status: 'pending',
        attempts: 0,
        maxAttempts: endpoint.retryPolicy.maxAttempts
      };

      this.deliveryQueue.push(delivery);
      this.logger.debug(`Queued delivery for endpoint: ${endpoint.url}`, { deliveryId: delivery.id });
    }

    this.emit('eventTriggered', event, matchingEndpoints.length);
  }

  public getEndpoints(): WebhookEndpoint[] {
    return Array.from(this.endpoints.values());
  }

  public getEndpoint(endpointId: string): WebhookEndpoint | undefined {
    return this.endpoints.get(endpointId);
  }

  public async getDeliveries(endpointId?: string, limit: number = 100): Promise<WebhookDelivery[]> {
    return await this.database.getWebhookDeliveries(endpointId, limit);
  }

  public async getDeliveryStats(endpointId: string): Promise<{
    total: number;
    success: number;
    failed: number;
    pending: number;
    successRate: number;
    averageResponseTime: number;
  }> {
    const deliveries = await this.database.getWebhookDeliveries(endpointId);
    
    const total = deliveries.length;
    const success = deliveries.filter(d => d.status === 'success').length;
    const failed = deliveries.filter(d => d.status === 'failed').length;
    const pending = deliveries.filter(d => d.status === 'pending' || d.status === 'retrying').length;
    
    const successRate = total > 0 ? (success / total) * 100 : 0;
    
    const responseTimes = deliveries
      .filter(d => d.response?.duration)
      .map(d => d.response!.duration);
    const averageResponseTime = responseTimes.length > 0
      ? responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length
      : 0;

    return {
      total,
      success,
      failed,
      pending,
      successRate,
      averageResponseTime
    };
  }

  private async processDeliveryQueue(): Promise<void> {
    if (this.deliveryQueue.length === 0) {
      return;
    }

    const pendingDeliveries = this.deliveryQueue
      .filter(delivery => delivery.status === 'pending')
      .slice(0, this.config.maxConcurrentDeliveries);

    const promises = pendingDeliveries.map(delivery => this.executeDelivery(delivery));
    await Promise.allSettled(promises);
  }

  private async executeDelivery(delivery: WebhookDelivery): Promise<void> {
    const endpoint = this.endpoints.get(delivery.webhookId);
    if (!endpoint) {
      this.logger.error(`Endpoint not found for delivery: ${delivery.id}`);
      delivery.status = 'failed';
      delivery.error = 'Endpoint not found';
      return;
    }

    delivery.attempts++;
    delivery.lastAttempt = new Date();
    delivery.status = 'retrying';

    try {
      const event = await this.getEvent(delivery.eventId);
      if (!event) {
        throw new Error('Event not found');
      }

      const payload = this.createPayload(event, delivery);
      const signature = this.generateSignature(payload, endpoint.secret);

      const startTime = Date.now();
      const response = await this.sendWebhook(endpoint, payload, signature);
      const duration = Date.now() - startTime;

      delivery.response = {
        status: response.status,
        body: typeof response.data === 'string' ? response.data.substring(0, 1000) : JSON.stringify(response.data).substring(0, 1000),
        headers: response.headers,
        duration
      };

      if (response.status >= 200 && response.status < 300) {
        delivery.status = 'success';
        endpoint.successCount++;
        endpoint.lastTriggered = new Date();
        
        this.emit('deliverySuccess', delivery, endpoint);
        this.logger.debug(`Webhook delivery successful: ${endpoint.url}`, { deliveryId: delivery.id });
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

    } catch (error) {
      delivery.error = error instanceof Error ? error.message : String(error);
      endpoint.failureCount++;

      this.logger.warn(`Webhook delivery failed: ${endpoint.url}`, {
        deliveryId: delivery.id,
        attempt: delivery.attempts,
        error: delivery.error
      });

      if (delivery.attempts >= delivery.maxAttempts || !this.config.enableRetries) {
        delivery.status = 'failed';
        this.emit('deliveryFailed', delivery, endpoint);
      } else {
        // Schedule retry
        this.scheduleRetry(delivery, endpoint);
      }
    }

    // Save delivery status
    await this.saveDelivery(delivery);
    await this.saveEndpoint(endpoint);

    // Remove from queue if completed
    if (delivery.status === 'success' || delivery.status === 'failed') {
      const index = this.deliveryQueue.indexOf(delivery);
      if (index > -1) {
        this.deliveryQueue.splice(index, 1);
      }
    }
  }

  private scheduleRetry(delivery: WebhookDelivery, endpoint: WebhookEndpoint): void {
    const delay = Math.min(
      endpoint.retryPolicy.initialDelayMs * Math.pow(endpoint.retryPolicy.backoffMultiplier, delivery.attempts - 1),
      endpoint.retryPolicy.maxDelayMs
    );

    delivery.nextAttempt = new Date(Date.now() + delay);
    delivery.status = 'pending';

    const timer = setTimeout(() => {
      this.retryTimers.delete(delivery.id);
      // Delivery will be picked up by the processing loop
    }, delay);

    this.retryTimers.set(delivery.id, timer);

    this.logger.debug(`Scheduled retry for delivery: ${delivery.id} in ${delay}ms`);
  }

  private async sendWebhook(endpoint: WebhookEndpoint, payload: any, signature: string): Promise<AxiosResponse> {
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Otedama-Webhook/1.0',
      'X-Webhook-Signature': signature,
      'X-Webhook-Timestamp': Date.now().toString(),
      ...endpoint.headers
    };

    return await axios.post(endpoint.url, payload, {
      headers,
      timeout: this.config.requestTimeoutMs,
      validateStatus: () => true // Don't throw on HTTP errors
    });
  }

  private createPayload(event: WebhookEvent, delivery: WebhookDelivery): any {
    return {
      id: delivery.id,
      event: {
        id: event.id,
        type: event.type,
        timestamp: event.timestamp.toISOString(),
        data: event.data,
        metadata: event.metadata
      },
      delivery: {
        id: delivery.id,
        attempt: delivery.attempts
      }
    };
  }

  private generateSignature(payload: any, secret: string): string {
    if (!this.config.enableSignatureValidation) {
      return '';
    }

    const crypto = require('crypto');
    const data = JSON.stringify(payload);
    return crypto.createHmac('sha256', secret).update(data).digest('hex');
  }

  private passesFilters(event: WebhookEvent, filters: WebhookFilter[]): boolean {
    if (filters.length === 0) {
      return true;
    }

    return filters.every(filter => {
      const value = this.getNestedValue(event.data, filter.field);
      
      switch (filter.operator) {
        case 'equals':
          return value === filter.value;
        case 'contains':
          return typeof value === 'string' && value.includes(filter.value);
        case 'greater_than':
          return typeof value === 'number' && value > filter.value;
        case 'less_than':
          return typeof value === 'number' && value < filter.value;
        default:
          return false;
      }
    });
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  private async loadEndpoints(): Promise<void> {
    try {
      const endpoints = await this.database.getWebhookEndpoints();
      endpoints.forEach(endpoint => {
        this.endpoints.set(endpoint.id, endpoint);
      });
      
      this.logger.info(`Loaded ${endpoints.length} webhook endpoints`);
    } catch (error) {
      this.logger.error('Error loading webhook endpoints:', error);
    }
  }

  private async saveEndpoint(endpoint: WebhookEndpoint): Promise<void> {
    try {
      await this.database.saveWebhookEndpoint(endpoint);
    } catch (error) {
      this.logger.error('Error saving webhook endpoint:', error);
    }
  }

  private async saveDelivery(delivery: WebhookDelivery): Promise<void> {
    try {
      await this.database.saveWebhookDelivery(delivery);
    } catch (error) {
      this.logger.error('Error saving webhook delivery:', error);
    }
  }

  private async getEvent(eventId: string): Promise<WebhookEvent | null> {
    try {
      return await this.database.getWebhookEvent(eventId);
    } catch (error) {
      this.logger.error('Error getting webhook event:', error);
      return null;
    }
  }

  // Convenience methods for common events
  public async triggerBlockFound(blockData: any): Promise<void> {
    await this.triggerEvent('block.found', blockData);
  }

  public async triggerShareAccepted(shareData: any): Promise<void> {
    await this.triggerEvent('share.accepted', shareData);
  }

  public async triggerPayoutProcessed(payoutData: any): Promise<void> {
    await this.triggerEvent('payout.processed', payoutData);
  }

  public async triggerMinerConnected(minerData: any): Promise<void> {
    await this.triggerEvent('miner.connected', minerData);
  }

  public async triggerSystemAlert(alertData: any): Promise<void> {
    await this.triggerEvent('system.alert', alertData);
  }
}