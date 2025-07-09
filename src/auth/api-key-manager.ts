import { logger } from '../logging/logger';
import { EventBus } from '../event/bus';
import { PoolEvent } from '../event/types';
import { v4 as uuidv4 } from 'uuid';
import { RateLimiter } from '../utils/rate-limiter';

export interface ApiKey {
  id: string;
  key: string;
  userId: string;
  name: string;
  description: string;
  permissions: string[];
  rateLimit: {
    requests: number;
    windowMs: number;
  };
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  status: 'active' | 'inactive' | 'revoked';
}

export class ApiKeyManager {
  private apiKeys: Map<string, ApiKey>;
  private rateLimiters: Map<string, RateLimiter>;
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.apiKeys = new Map();
    this.rateLimiters = new Map();
    this.eventBus = eventBus;

    // Initialize default rate limiter settings
    this.initializeDefaultRateLimiters();

    // Setup event handlers
    this.setupEventHandlers();
  }

  private initializeDefaultRateLimiters(): void {
    // Default rate limiter settings
    this.rateLimiters.set('default', new RateLimiter({
      points: 1000,    // 1000 requests
      duration: 60 * 60 * 1000, // per hour
    }));

    this.rateLimiters.set('premium', new RateLimiter({
      points: 5000,    // 5000 requests
      duration: 60 * 60 * 1000, // per hour
    }));
  }

  private setupEventHandlers(): void {
    this.eventBus.on('apiKeyCreated', (apiKey: ApiKey) => {
      this.apiKeys.set(apiKey.key, apiKey);
      logger.info(`API key created: ${apiKey.name}`);
    });

    this.eventBus.on('apiKeyUpdated', (apiKey: ApiKey) => {
      this.apiKeys.set(apiKey.key, apiKey);
      logger.info(`API key updated: ${apiKey.name}`);
    });

    this.eventBus.on('apiKeyDeleted', (apiKeyId: string) => {
      const apiKey = Array.from(this.apiKeys.values()).find(key => key.id === apiKeyId);
      if (apiKey) {
        this.apiKeys.delete(apiKey.key);
        logger.info(`API key deleted: ${apiKey.name}`);
      }
    });

    this.eventBus.on('apiKeyUsed', (apiKey: ApiKey) => {
      const limiter = this.rateLimiters.get(apiKey.rateLimit.requests.toString());
      if (limiter) {
        const isLimited = limiter.consume(apiKey.key);
        if (!isLimited) {
          logger.warn(`API key rate limit exceeded: ${apiKey.name}`);
        }
      }
    });
  }

  public async createApiKey(
    userId: string,
    name: string,
    description: string,
    permissions: string[],
    rateLimit: { requests: number; windowMs: number; } = { requests: 1000, windowMs: 60 * 60 * 1000 }
  ): Promise<ApiKey> {
    const apiKey: ApiKey = {
      id: uuidv4(),
      key: uuidv4(),
      userId,
      name,
      description,
      permissions,
      rateLimit,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
      status: 'active',
    };

    this.apiKeys.set(apiKey.key, apiKey);
    this.eventBus.emit('apiKeyCreated', apiKey);
    logger.info(`Created API key: ${name}`);

    return apiKey;
  }

  public async updateApiKey(apiKeyId: string, updates: Partial<ApiKey>): Promise<ApiKey | null> {
    const apiKey = Array.from(this.apiKeys.values()).find(key => key.id === apiKeyId);
    if (!apiKey) {
      logger.warn(`API key not found: ${apiKeyId}`);
      return null;
    }

    const updatedApiKey = { ...apiKey, ...updates, updatedAt: new Date().toISOString() };
    this.apiKeys.set(updatedApiKey.key, updatedApiKey);
    this.eventBus.emit('apiKeyUpdated', updatedApiKey);
    logger.info(`Updated API key: ${apiKeyId}`);

    return updatedApiKey;
  }

  public async deleteApiKey(apiKeyId: string): Promise<boolean> {
    const apiKey = Array.from(this.apiKeys.values()).find(key => key.id === apiKeyId);
    if (apiKey) {
      this.apiKeys.delete(apiKey.key);
      this.eventBus.emit('apiKeyDeleted', apiKeyId);
      logger.info(`Deleted API key: ${apiKeyId}`);
      return true;
    }
    return false;
  }

  public async validateApiKey(apiKey: string): Promise<ApiKey | null> {
    const key = this.apiKeys.get(apiKey);
    if (!key) {
      logger.warn(`Invalid API key: ${apiKey}`);
      return null;
    }

    if (key.status !== 'active') {
      logger.warn(`API key is ${key.status}: ${apiKey}`);
      return null;
    }

    // Check rate limit
    const limiter = this.rateLimiters.get(key.rateLimit.requests.toString());
    if (limiter && !limiter.consume(apiKey)) {
      logger.warn(`API key rate limit exceeded: ${apiKey}`);
      return null;
    }

    // Update last used time
    const updatedKey = {
      ...key,
      lastUsedAt: new Date().toISOString(),
    };
    this.apiKeys.set(apiKey, updatedKey);
    this.eventBus.emit('apiKeyUsed', updatedKey);

    return updatedKey;
  }

  public getApiKey(apiKeyId: string): ApiKey | null {
    const apiKey = Array.from(this.apiKeys.values()).find(key => key.id === apiKeyId);
    return apiKey || null;
  }

  public getApiKeyByKey(apiKey: string): ApiKey | null {
    return this.apiKeys.get(apiKey) || null;
  }

  public getAllApiKeys(userId: string): ApiKey[] {
    return Array.from(this.apiKeys.values()).filter(key => key.userId === userId);
  }

  public checkPermission(apiKey: string, permission: string): boolean {
    const key = this.apiKeys.get(apiKey);
    if (!key) return false;

    // Check if key has the permission
    return key.permissions.includes(permission) || key.permissions.includes('*');
  }

  public async rotateApiKey(apiKeyId: string): Promise<ApiKey | null> {
    const apiKey = Array.from(this.apiKeys.values()).find(key => key.id === apiKeyId);
    if (!apiKey) {
      logger.warn(`API key not found: ${apiKeyId}`);
      return null;
    }

    const newKey = {
      ...apiKey,
      key: uuidv4(),
      updatedAt: new Date().toISOString(),
    };

    this.apiKeys.delete(apiKey.key);
    this.apiKeys.set(newKey.key, newKey);
    this.eventBus.emit('apiKeyUpdated', newKey);
    logger.info(`Rotated API key: ${apiKeyId}`);

    return newKey;
  }
}
