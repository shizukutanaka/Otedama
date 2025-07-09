import { logger } from '../logging/logger';
import { PoolEvent } from '../event/types';
import { EventBus } from '../event/bus';

export interface RateLimitOptions {
  points: number;
  duration: number; // in milliseconds
}

export class RateLimiter {
  private points: number;
  private duration: number;
  private tokens: number;
  private lastRefill: number;
  private eventBus: EventBus;

  constructor(options: RateLimitOptions, eventBus: EventBus) {
    this.points = options.points;
    this.duration = options.duration;
    this.tokens = options.points;
    this.lastRefill = Date.now();
    this.eventBus = eventBus;

    // Setup event handlers
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.eventBus.on('rateLimitRefill', (data: { identifier: string; points: number }) => {
      const currentTokens = this.tokens;
      const newTokens = Math.min(currentTokens + data.points, this.points);
      
      if (newTokens !== currentTokens) {
        this.tokens = newTokens;
        logger.debug(`Rate limiter refilled: ${data.identifier} - ${newTokens}/${this.points}`);
      }
    });

    this.eventBus.on('rateLimitConsume', (data: { identifier: string; points: number }) => {
      const currentTokens = this.tokens;
      const newTokens = Math.max(0, currentTokens - data.points);
      
      if (newTokens !== currentTokens) {
        this.tokens = newTokens;
        logger.debug(`Rate limiter consumed: ${data.identifier} - ${newTokens}/${this.points}`);
      }
    });
  }

  public consume(identifier: string, points = 1): boolean {
    const now = Date.now();
    const timeSinceLastRefill = now - this.lastRefill;

    // Refill tokens if needed
    if (timeSinceLastRefill >= this.duration) {
      this.tokens = this.points;
      this.lastRefill = now;
      logger.debug(`Rate limiter refilled: ${identifier} - ${this.tokens}/${this.points}`);
    }

    // Check if we have enough tokens
    if (this.tokens >= points) {
      this.tokens -= points;
      this.eventBus.emit('rateLimitConsume', { identifier, points });
      return true;
    }

    // Not enough tokens
    return false;
  }

  public getTokens(): number {
    return this.tokens;
  }

  public getPoints(): number {
    return this.points;
  }

  public getDuration(): number {
    return this.duration;
  }

  public getTimeUntilRefill(): number {
    const now = Date.now();
    const timeSinceLastRefill = now - this.lastRefill;
    return Math.max(0, this.duration - timeSinceLastRefill);
  }

  public reset(): void {
    this.tokens = this.points;
    this.lastRefill = Date.now();
    logger.info(`Rate limiter reset: ${this.points}/${this.points}`);
  }

  public setPoints(points: number): void {
    this.points = points;
    this.tokens = points;
    logger.info(`Rate limiter points updated: ${this.points}`);
  }

  public setDuration(duration: number): void {
    this.duration = duration;
    logger.info(`Rate limiter duration updated: ${this.duration}`);
  }
}
