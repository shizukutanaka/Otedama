/**
 * CQRS Core - Command Query Responsibility Segregation
 * 
 * 設計原則:
 * - Martin: 読み書きの責任を明確に分離
 * - Pike: シンプルで予測可能なインターフェース
 * - Carmack: 高速な読み取りと信頼性の高い書き込み
 */

import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';
import { EventBus } from '../events/event-bus';

// Command types
export interface Command {
    id: string;
    type: string;
    aggregateId?: string;
    payload: any;
    metadata?: CommandMetadata;
    timestamp: Date;
}

export interface CommandMetadata {
    userId?: string;
    correlationId?: string;
    causationId?: string;
    ipAddress?: string;
    userAgent?: string;
}

export interface CommandResult<T = any> {
    success: boolean;
    data?: T;
    error?: Error;
    events?: any[];
}

// Query types
export interface Query {
    id: string;
    type: string;
    criteria: any;
    projection?: string[];
    pagination?: PaginationOptions;
    metadata?: QueryMetadata;
    timestamp: Date;
}

export interface QueryMetadata {
    userId?: string;
    cached?: boolean;
    timeout?: number;
}

export interface PaginationOptions {
    page: number;
    pageSize: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
}

export interface QueryResult<T = any> {
    data: T;
    metadata?: {
        totalCount?: number;
        page?: number;
        pageSize?: number;
        cached?: boolean;
        executionTime?: number;
    };
}

// Handler interfaces
export interface CommandHandler<TCommand = any, TResult = any> {
    commandType: string;
    handle(command: Command<TCommand>): Promise<CommandResult<TResult>>;
    validate?(command: Command<TCommand>): Promise<boolean>;
}

export interface QueryHandler<TQuery = any, TResult = any> {
    queryType: string;
    handle(query: Query<TQuery>): Promise<QueryResult<TResult>>;
    validate?(query: Query<TQuery>): Promise<boolean>;
}

// Middleware interfaces
export interface CommandMiddleware {
    name: string;
    pre?(command: Command): Promise<Command | null>;
    post?(command: Command, result: CommandResult): Promise<CommandResult>;
}

export interface QueryMiddleware {
    name: string;
    pre?(query: Query): Promise<Query | null>;
    post?(query: Query, result: QueryResult): Promise<QueryResult>;
}

/**
 * Command Bus - Handles command execution
 */
export class CommandBus extends EventEmitter {
    private logger = createLogger('CommandBus');
    private handlers: Map<string, CommandHandler> = new Map();
    private middleware: CommandMiddleware[] = [];
    private executing: Map<string, Promise<CommandResult>> = new Map();

    constructor(private eventBus?: EventBus) {
        super();
    }

    /**
     * Register a command handler
     */
    public registerHandler(handler: CommandHandler): void {
        if (this.handlers.has(handler.commandType)) {
            throw new Error(`Handler already registered for command type: ${handler.commandType}`);
        }

        this.handlers.set(handler.commandType, handler);
        this.logger.info(`Registered command handler: ${handler.commandType}`);
    }

    /**
     * Register middleware
     */
    public use(middleware: CommandMiddleware): void {
        this.middleware.push(middleware);
        this.logger.debug(`Added command middleware: ${middleware.name}`);
    }

    /**
     * Execute a command
     */
    public async execute<T = any>(command: Command): Promise<CommandResult<T>> {
        const startTime = Date.now();

        try {
            // Check if command is already executing (idempotency)
            const existingExecution = this.executing.get(command.id);
            if (existingExecution) {
                this.logger.debug(`Command ${command.id} already executing`);
                return existingExecution as Promise<CommandResult<T>>;
            }

            // Create execution promise
            const executionPromise = this.executeCommand<T>(command);
            this.executing.set(command.id, executionPromise);

            // Execute and clean up
            try {
                const result = await executionPromise;
                return result;
            } finally {
                this.executing.delete(command.id);
            }

        } catch (error) {
            this.logger.error(`Command execution failed: ${command.type}`, error);
            return {
                success: false,
                error: error as Error
            };
        } finally {
            const duration = Date.now() - startTime;
            this.emit('command:executed', {
                command,
                duration
            });
        }
    }

    private async executeCommand<T>(command: Command): Promise<CommandResult<T>> {
        // Apply pre-middleware
        let processedCommand: Command | null = command;
        for (const mw of this.middleware) {
            if (mw.pre) {
                processedCommand = await mw.pre(processedCommand);
                if (!processedCommand) {
                    return {
                        success: false,
                        error: new Error(`Command rejected by middleware: ${mw.name}`)
                    };
                }
            }
        }

        // Get handler
        const handler = this.handlers.get(processedCommand.type);
        if (!handler) {
            throw new Error(`No handler registered for command type: ${processedCommand.type}`);
        }

        // Validate command
        if (handler.validate) {
            const isValid = await handler.validate(processedCommand);
            if (!isValid) {
                return {
                    success: false,
                    error: new Error('Command validation failed')
                };
            }
        }

        // Execute command
        this.logger.debug(`Executing command: ${processedCommand.type}`, {
            commandId: processedCommand.id,
            aggregateId: processedCommand.aggregateId
        });

        let result = await handler.handle(processedCommand);

        // Publish events if any
        if (result.success && result.events && this.eventBus) {
            for (const event of result.events) {
                await this.eventBus.publish(
                    event.type,
                    event.data,
                    `Command:${processedCommand.type}`,
                    {
                        commandId: processedCommand.id,
                        correlationId: processedCommand.metadata?.correlationId
                    }
                );
            }
        }

        // Apply post-middleware
        for (const mw of [...this.middleware].reverse()) {
            if (mw.post) {
                result = await mw.post(processedCommand, result);
            }
        }

        return result;
    }
}

/**
 * Query Bus - Handles query execution
 */
export class QueryBus extends EventEmitter {
    private logger = createLogger('QueryBus');
    private handlers: Map<string, QueryHandler> = new Map();
    private middleware: QueryMiddleware[] = [];
    private cache: Map<string, { result: QueryResult; expiry: number }> = new Map();

    /**
     * Register a query handler
     */
    public registerHandler(handler: QueryHandler): void {
        if (this.handlers.has(handler.queryType)) {
            throw new Error(`Handler already registered for query type: ${handler.queryType}`);
        }

        this.handlers.set(handler.queryType, handler);
        this.logger.info(`Registered query handler: ${handler.queryType}`);
    }

    /**
     * Register middleware
     */
    public use(middleware: QueryMiddleware): void {
        this.middleware.push(middleware);
        this.logger.debug(`Added query middleware: ${middleware.name}`);
    }

    /**
     * Execute a query
     */
    public async execute<T = any>(query: Query): Promise<QueryResult<T>> {
        const startTime = Date.now();

        try {
            // Check cache if enabled
            if (query.metadata?.cached !== false) {
                const cached = this.getFromCache(query);
                if (cached) {
                    return {
                        ...cached,
                        metadata: {
                            ...cached.metadata,
                            cached: true,
                            executionTime: Date.now() - startTime
                        }
                    };
                }
            }

            // Execute query
            const result = await this.executeQuery<T>(query);

            // Cache result if successful
            if (query.metadata?.cached !== false) {
                this.cacheResult(query, result);
            }

            return {
                ...result,
                metadata: {
                    ...result.metadata,
                    cached: false,
                    executionTime: Date.now() - startTime
                }
            };

        } catch (error) {
            this.logger.error(`Query execution failed: ${query.type}`, error);
            throw error;
        } finally {
            const duration = Date.now() - startTime;
            this.emit('query:executed', {
                query,
                duration
            });
        }
    }

    private async executeQuery<T>(query: Query): Promise<QueryResult<T>> {
        // Apply pre-middleware
        let processedQuery: Query | null = query;
        for (const mw of this.middleware) {
            if (mw.pre) {
                processedQuery = await mw.pre(processedQuery);
                if (!processedQuery) {
                    throw new Error(`Query rejected by middleware: ${mw.name}`);
                }
            }
        }

        // Get handler
        const handler = this.handlers.get(processedQuery.type);
        if (!handler) {
            throw new Error(`No handler registered for query type: ${processedQuery.type}`);
        }

        // Validate query
        if (handler.validate) {
            const isValid = await handler.validate(processedQuery);
            if (!isValid) {
                throw new Error('Query validation failed');
            }
        }

        // Execute query
        this.logger.debug(`Executing query: ${processedQuery.type}`, {
            queryId: processedQuery.id
        });

        let result = await handler.handle(processedQuery);

        // Apply post-middleware
        for (const mw of [...this.middleware].reverse()) {
            if (mw.post) {
                result = await mw.post(processedQuery, result);
            }
        }

        return result;
    }

    private getCacheKey(query: Query): string {
        return `${query.type}:${JSON.stringify(query.criteria)}:${JSON.stringify(query.projection)}`;
    }

    private getFromCache(query: Query): QueryResult | null {
        const key = this.getCacheKey(query);
        const cached = this.cache.get(key);

        if (cached && cached.expiry > Date.now()) {
            this.logger.debug(`Cache hit for query: ${query.type}`);
            return cached.result;
        }

        if (cached) {
            this.cache.delete(key);
        }

        return null;
    }

    private cacheResult(query: Query, result: QueryResult): void {
        const key = this.getCacheKey(query);
        const ttl = query.metadata?.timeout || 60000; // Default 1 minute

        this.cache.set(key, {
            result,
            expiry: Date.now() + ttl
        });

        // Clean up expired entries periodically
        if (this.cache.size > 1000) {
            this.cleanupCache();
        }
    }

    private cleanupCache(): void {
        const now = Date.now();
        for (const [key, value] of this.cache.entries()) {
            if (value.expiry < now) {
                this.cache.delete(key);
            }
        }
    }
}

/**
 * CQRS System - Coordinates commands and queries
 */
export class CQRSSystem {
    public readonly commandBus: CommandBus;
    public readonly queryBus: QueryBus;
    private logger = createLogger('CQRSSystem');

    constructor(eventBus?: EventBus) {
        this.commandBus = new CommandBus(eventBus);
        this.queryBus = new QueryBus();
    }

    /**
     * Send a command
     */
    public async sendCommand<T = any>(
        type: string,
        payload: any,
        metadata?: CommandMetadata
    ): Promise<CommandResult<T>> {
        const command: Command = {
            id: this.generateId(),
            type,
            payload,
            metadata,
            timestamp: new Date()
        };

        return this.commandBus.execute<T>(command);
    }

    /**
     * Send a query
     */
    public async sendQuery<T = any>(
        type: string,
        criteria: any,
        options?: {
            projection?: string[];
            pagination?: PaginationOptions;
            metadata?: QueryMetadata;
        }
    ): Promise<QueryResult<T>> {
        const query: Query = {
            id: this.generateId(),
            type,
            criteria,
            projection: options?.projection,
            pagination: options?.pagination,
            metadata: options?.metadata,
            timestamp: new Date()
        };

        return this.queryBus.execute<T>(query);
    }

    /**
     * Register command handler
     */
    public registerCommandHandler(handler: CommandHandler): void {
        this.commandBus.registerHandler(handler);
    }

    /**
     * Register query handler
     */
    public registerQueryHandler(handler: QueryHandler): void {
        this.queryBus.registerHandler(handler);
    }

    /**
     * Use command middleware
     */
    public useCommandMiddleware(middleware: CommandMiddleware): void {
        this.commandBus.use(middleware);
    }

    /**
     * Use query middleware
     */
    public useQueryMiddleware(middleware: QueryMiddleware): void {
        this.queryBus.use(middleware);
    }

    private generateId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
}

// Helper to create typed command
export function createCommand<T>(
    type: string,
    payload: T,
    options?: {
        aggregateId?: string;
        metadata?: CommandMetadata;
    }
): Command {
    return {
        id: `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type,
        aggregateId: options?.aggregateId,
        payload,
        metadata: options?.metadata,
        timestamp: new Date()
    };
}

// Helper to create typed query
export function createQuery<T>(
    type: string,
    criteria: T,
    options?: {
        projection?: string[];
        pagination?: PaginationOptions;
        metadata?: QueryMetadata;
    }
): Query {
    return {
        id: `qry_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type,
        criteria,
        projection: options?.projection,
        pagination: options?.pagination,
        metadata: options?.metadata,
        timestamp: new Date()
    };
}
