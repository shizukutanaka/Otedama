// src/cqrs/cqrs-implementation.ts
import { EventEmitter } from 'events';
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';

// Base interfaces
export interface Command {
  id: string;
  type: string;
  payload: any;
  metadata: {
    userId?: string;
    timestamp: number;
    correlationId?: string;
  };
}

export interface Query {
  id: string;
  type: string;
  parameters: any;
  metadata: {
    userId?: string;
    timestamp: number;
  };
}

export interface Event {
  id: string;
  type: string;
  aggregateId: string;
  aggregateType: string;
  version: number;
  payload: any;
  metadata: {
    userId?: string;
    timestamp: number;
    correlationId?: string;
  };
}

export interface CommandResult {
  success: boolean;
  aggregateId?: string;
  version?: number;
  events?: Event[];
  error?: string;
}

export interface QueryResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  metadata?: {
    totalCount?: number;
    page?: number;
    pageSize?: number;
  };
}

// Command handlers
export interface CommandHandler<T extends Command = Command> {
  handle(command: T): Promise<CommandResult>;
  canHandle(command: Command): boolean;
}

// Query handlers
export interface QueryHandler<T extends Query = Query> {
  handle(query: T): Promise<QueryResult>;
  canHandle(query: Query): boolean;
}

// Event handlers
export interface EventHandler {
  handle(event: Event): Promise<void>;
  canHandle(event: Event): boolean;
}

// CQRS Bus implementation
export class CQRSBus extends EventEmitter {
  private commandHandlers: Map<string, CommandHandler> = new Map();
  private queryHandlers: Map<string, QueryHandler> = new Map();
  private eventHandlers: Map<string, EventHandler[]> = new Map();
  private logger: Logger;
  private cache: RedisCache;

  constructor(logger: Logger, cache: RedisCache) {
    super();
    this.logger = logger;
    this.cache = cache;
  }

  // Command handling
  public registerCommandHandler<T extends Command>(
    commandType: string,
    handler: CommandHandler<T>
  ): void {
    this.commandHandlers.set(commandType, handler);
    this.logger.info(`Command handler registered for: ${commandType}`);
  }

  public async executeCommand(command: Command): Promise<CommandResult> {
    const startTime = Date.now();
    
    try {
      const handler = this.commandHandlers.get(command.type);
      
      if (!handler) {
        throw new Error(`No handler found for command type: ${command.type}`);
      }

      this.logger.debug(`Executing command: ${command.type}`, { commandId: command.id });
      
      const result = await handler.handle(command);
      
      // Publish events if command was successful
      if (result.success && result.events) {
        for (const event of result.events) {
          await this.publishEvent(event);
        }
      }

      const duration = Date.now() - startTime;
      this.logger.info(`Command executed: ${command.type}`, {
        commandId: command.id,
        success: result.success,
        duration
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`Command execution failed: ${command.type}`, {
        commandId: command.id,
        error: (error as Error).message,
        duration
      });

      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  // Query handling
  public registerQueryHandler<T extends Query>(
    queryType: string,
    handler: QueryHandler<T>
  ): void {
    this.queryHandlers.set(queryType, handler);
    this.logger.info(`Query handler registered for: ${queryType}`);
  }

  public async executeQuery<T = any>(query: Query): Promise<QueryResult<T>> {
    const startTime = Date.now();
    
    try {
      // Check cache first for read queries
      const cacheKey = `query:${query.type}:${JSON.stringify(query.parameters)}`;
      const cached = await this.cache.get(cacheKey);
      
      if (cached) {
        this.logger.debug(`Query cache hit: ${query.type}`, { queryId: query.id });
        return JSON.parse(cached);
      }

      const handler = this.queryHandlers.get(query.type);
      
      if (!handler) {
        throw new Error(`No handler found for query type: ${query.type}`);
      }

      this.logger.debug(`Executing query: ${query.type}`, { queryId: query.id });
      
      const result = await handler.handle(query);
      
      // Cache successful query results
      if (result.success && result.data) {
        await this.cache.set(cacheKey, JSON.stringify(result), 300); // 5 minutes
      }

      const duration = Date.now() - startTime;
      this.logger.info(`Query executed: ${query.type}`, {
        queryId: query.id,
        success: result.success,
        duration
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`Query execution failed: ${query.type}`, {
        queryId: query.id,
        error: (error as Error).message,
        duration
      });

      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  // Event handling
  public registerEventHandler(eventType: string, handler: EventHandler): void {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, []);
    }
    
    this.eventHandlers.get(eventType)!.push(handler);
    this.logger.info(`Event handler registered for: ${eventType}`);
  }

  public async publishEvent(event: Event): Promise<void> {
    const handlers = this.eventHandlers.get(event.type) || [];
    
    this.logger.debug(`Publishing event: ${event.type}`, {
      eventId: event.id,
      aggregateId: event.aggregateId,
      handlersCount: handlers.length
    });

    // Process events in parallel
    const promises = handlers.map(async (handler) => {
      try {
        await handler.handle(event);
      } catch (error) {
        this.logger.error(`Event handler failed for ${event.type}:`, {
          eventId: event.id,
          error: (error as Error).message
        });
      }
    });

    await Promise.allSettled(promises);
    
    // Emit for external listeners
    this.emit('event', event);
  }
}

// Mining Pool specific Commands
export interface SubmitShareCommand extends Command {
  type: 'SUBMIT_SHARE';
  payload: {
    minerId: string;
    jobId: string;
    nonce: number;
    result: string;
    difficulty: number;
  };
}

export interface CreateMinerCommand extends Command {
  type: 'CREATE_MINER';
  payload: {
    username: string;
    walletAddress: string;
    email?: string;
  };
}

export interface ProcessPayoutCommand extends Command {
  type: 'PROCESS_PAYOUT';
  payload: {
    minerId: string;
    amount: number;
    address: string;
  };
}

// Mining Pool specific Queries
export interface GetMinerStatsQuery extends Query {
  type: 'GET_MINER_STATS';
  parameters: {
    minerId: string;
    timeframe?: 'hour' | 'day' | 'week' | 'month';
  };
}

export interface GetPoolStatsQuery extends Query {
  type: 'GET_POOL_STATS';
  parameters: {
    timeframe?: 'hour' | 'day' | 'week' | 'month';
  };
}

export interface GetPayoutHistoryQuery extends Query {
  type: 'GET_PAYOUT_HISTORY';
  parameters: {
    minerId?: string;
    page?: number;
    pageSize?: number;
    startDate?: Date;
    endDate?: Date;
  };
}

// Mining Pool specific Events
export interface ShareSubmittedEvent extends Event {
  type: 'SHARE_SUBMITTED';
  payload: {
    minerId: string;
    jobId: string;
    nonce: number;
    result: string;
    difficulty: number;
    accepted: boolean;
    reason?: string;
  };
}

export interface MinerCreatedEvent extends Event {
  type: 'MINER_CREATED';
  payload: {
    minerId: string;
    username: string;
    walletAddress: string;
    email?: string;
  };
}

export interface PayoutProcessedEvent extends Event {
  type: 'PAYOUT_PROCESSED';
  payload: {
    minerId: string;
    amount: number;
    address: string;
    transactionId: string;
    status: 'success' | 'failed';
  };
}

// Command Handlers Implementation
export class SubmitShareHandler implements CommandHandler<SubmitShareCommand> {
  constructor(private logger: Logger) {}

  canHandle(command: Command): boolean {
    return command.type === 'SUBMIT_SHARE';
  }

  async handle(command: SubmitShareCommand): Promise<CommandResult> {
    const { minerId, jobId, nonce, result, difficulty } = command.payload;
    
    // Validate share (simplified)
    const isValid = await this.validateShare(result, difficulty);
    
    const event: ShareSubmittedEvent = {
      id: `share_${Date.now()}_${minerId}`,
      type: 'SHARE_SUBMITTED',
      aggregateId: minerId,
      aggregateType: 'Miner',
      version: 1,
      payload: {
        minerId,
        jobId,
        nonce,
        result,
        difficulty,
        accepted: isValid,
        reason: isValid ? undefined : 'Invalid hash'
      },
      metadata: {
        ...command.metadata,
        timestamp: Date.now()
      }
    };

    this.logger.info(`Share ${isValid ? 'accepted' : 'rejected'}`, {
      minerId,
      jobId,
      difficulty
    });

    return {
      success: true,
      aggregateId: minerId,
      version: 1,
      events: [event]
    };
  }

  private async validateShare(result: string, difficulty: number): Promise<boolean> {
    // Simplified validation - check if result meets difficulty target
    const hash = result.toLowerCase();
    const target = '0'.repeat(Math.floor(Math.log2(difficulty) / 4));
    return hash.startsWith(target);
  }
}

export class CreateMinerHandler implements CommandHandler<CreateMinerCommand> {
  constructor(private logger: Logger) {}

  canHandle(command: Command): boolean {
    return command.type === 'CREATE_MINER';
  }

  async handle(command: CreateMinerCommand): Promise<CommandResult> {
    const { username, walletAddress, email } = command.payload;
    const minerId = `miner_${Date.now()}_${username}`;
    
    const event: MinerCreatedEvent = {
      id: `miner_created_${Date.now()}`,
      type: 'MINER_CREATED',
      aggregateId: minerId,
      aggregateType: 'Miner',
      version: 1,
      payload: {
        minerId,
        username,
        walletAddress,
        email
      },
      metadata: {
        ...command.metadata,
        timestamp: Date.now()
      }
    };

    this.logger.info(`Miner created: ${username}`, { minerId });

    return {
      success: true,
      aggregateId: minerId,
      version: 1,
      events: [event]
    };
  }
}

// Query Handlers Implementation
export class GetMinerStatsHandler implements QueryHandler<GetMinerStatsQuery> {
  constructor(
    private logger: Logger,
    private cache: RedisCache
  ) {}

  canHandle(query: Query): boolean {
    return query.type === 'GET_MINER_STATS';
  }

  async handle(query: GetMinerStatsQuery): Promise<QueryResult> {
    const { minerId, timeframe = 'day' } = query.parameters;
    
    // In a real implementation, this would query a read-optimized database
    const stats = await this.getMinerStatsFromReadStore(minerId, timeframe);
    
    return {
      success: true,
      data: stats
    };
  }

  private async getMinerStatsFromReadStore(minerId: string, timeframe: string) {
    // Simplified implementation - would query read-optimized store
    return {
      minerId,
      timeframe,
      hashrate: 1000000, // 1 MH/s
      sharesAccepted: 100,
      sharesRejected: 5,
      efficiency: 95.2,
      earnings: 0.001,
      lastActive: new Date()
    };
  }
}

export class GetPoolStatsHandler implements QueryHandler<GetPoolStatsQuery> {
  constructor(private logger: Logger) {}

  canHandle(query: Query): boolean {
    return query.type === 'GET_POOL_STATS';
  }

  async handle(query: GetPoolStatsQuery): Promise<QueryResult> {
    const { timeframe = 'day' } = query.parameters;
    
    const stats = await this.getPoolStatsFromReadStore(timeframe);
    
    return {
      success: true,
      data: stats
    };
  }

  private async getPoolStatsFromReadStore(timeframe: string) {
    return {
      timeframe,
      totalHashrate: 10000000000, // 10 GH/s
      activeMiners: 50,
      blocksFound: 2,
      totalShares: 10000,
      poolFee: 1.5,
      lastBlockFound: new Date(Date.now() - 3600000) // 1 hour ago
    };
  }
}

// Event Handlers Implementation
export class ShareSubmittedEventHandler implements EventHandler {
  constructor(private logger: Logger, private cache: RedisCache) {}

  canHandle(event: Event): boolean {
    return event.type === 'SHARE_SUBMITTED';
  }

  async handle(event: ShareSubmittedEvent): Promise<void> {
    const { minerId, accepted, difficulty } = event.payload;
    
    // Update miner statistics in read store
    await this.updateMinerStats(minerId, accepted, difficulty);
    
    // Update pool statistics
    await this.updatePoolStats(accepted, difficulty);
    
    this.logger.debug(`Share statistics updated for miner: ${minerId}`);
  }

  private async updateMinerStats(minerId: string, accepted: boolean, difficulty: number): Promise<void> {
    const key = `miner_stats:${minerId}`;
    const stats = await this.cache.get(key);
    
    let minerStats = stats ? JSON.parse(stats) : {
      sharesAccepted: 0,
      sharesRejected: 0,
      totalDifficulty: 0
    };

    if (accepted) {
      minerStats.sharesAccepted++;
      minerStats.totalDifficulty += difficulty;
    } else {
      minerStats.sharesRejected++;
    }

    minerStats.lastActive = new Date();
    
    await this.cache.set(key, JSON.stringify(minerStats), 86400); // 24 hours
  }

  private async updatePoolStats(accepted: boolean, difficulty: number): Promise<void> {
    const key = 'pool_stats';
    const stats = await this.cache.get(key);
    
    let poolStats = stats ? JSON.parse(stats) : {
      totalShares: 0,
      totalDifficulty: 0
    };

    if (accepted) {
      poolStats.totalShares++;
      poolStats.totalDifficulty += difficulty;
    }

    await this.cache.set(key, JSON.stringify(poolStats), 86400);
  }
}

// Factory for creating CQRS system
export class CQRSFactory {
  public static create(logger: Logger, cache: RedisCache): CQRSBus {
    const bus = new CQRSBus(logger, cache);
    
    // Register command handlers
    bus.registerCommandHandler('SUBMIT_SHARE', new SubmitShareHandler(logger));
    bus.registerCommandHandler('CREATE_MINER', new CreateMinerHandler(logger));
    
    // Register query handlers
    bus.registerQueryHandler('GET_MINER_STATS', new GetMinerStatsHandler(logger, cache));
    bus.registerQueryHandler('GET_POOL_STATS', new GetPoolStatsHandler(logger));
    
    // Register event handlers
    bus.registerEventHandler('SHARE_SUBMITTED', new ShareSubmittedEventHandler(logger, cache));
    
    logger.info('CQRS system initialized with handlers');
    
    return bus;
  }
}