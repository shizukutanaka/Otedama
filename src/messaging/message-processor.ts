/**
 * Message Processor - High-level message processing patterns
 */

import { Consumer, MessageEnvelope, ConsumerConfig } from './message-queue';
import { createLogger } from '../utils/logger';
import { EventEmitter } from 'events';

export interface ProcessorConfig extends ConsumerConfig {
    concurrency?: number;
    retryAttempts?: number;
    retryDelay?: number;
    deadLetterTopic?: string;
    errorHandler?: (error: Error, message: MessageEnvelope) => void;
}

export interface MessageHandler<T = any> {
    (message: T, envelope: MessageEnvelope): Promise<void>;
}

export class MessageProcessor extends EventEmitter {
    private logger = createLogger('MessageProcessor');
    private consumer?: Consumer;
    private processing = 0;
    private handlers: Map<string, MessageHandler[]> = new Map();
    private errorCounts: Map<string, number> = new Map();

    constructor(
        private name: string,
        private config: ProcessorConfig
    ) {
        super();
        this.config = {
            concurrency: 10,
            retryAttempts: 3,
            retryDelay: 1000,
            ...config
        };
    }

    /**
     * Register a handler for a specific message type
     */
    public on(messageType: string, handler: MessageHandler): this {
        if (!this.handlers.has(messageType)) {
            this.handlers.set(messageType, []);
        }
        this.handlers.get(messageType)!.push(handler);
        return this;
    }

    /**
     * Start processing messages
     */
    public async start(consumer: Consumer): Promise<void> {
        this.consumer = consumer;
        
        await this.consumer.start(async (envelope: MessageEnvelope) => {
            // Check concurrency limit
            while (this.processing >= (this.config.concurrency || 10)) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            this.processing++;
            
            try {
                await this.processMessage(envelope);
            } finally {
                this.processing--;
            }
        });

        this.logger.info(`Message processor '${this.name}' started`);
    }

    /**
     * Stop processing messages
     */
    public async stop(): Promise<void> {
        if (this.consumer) {
            await this.consumer.stop();
        }

        // Wait for current processing to complete
        while (this.processing > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        this.logger.info(`Message processor '${this.name}' stopped`);
    }

    /**
     * Get processing statistics
     */
    public getStats(): {
        processing: number;
        errorCounts: Record<string, number>;
    } {
        return {
            processing: this.processing,
            errorCounts: Object.fromEntries(this.errorCounts)
        };
    }

    private async processMessage(envelope: MessageEnvelope): Promise<void> {
        const { message } = envelope;
        const messageType = message.headers?.type || message.topic;

        try {
            this.logger.debug(`Processing message: ${message.id}`, {
                topic: message.topic,
                type: messageType
            });

            // Get handlers for this message type
            const handlers = this.getHandlers(messageType);
            
            if (handlers.length === 0) {
                this.logger.warn(`No handlers for message type: ${messageType}`);
                await envelope.ack();
                return;
            }

            // Execute all handlers
            for (const handler of handlers) {
                await this.executeHandler(handler, message.value, envelope);
            }

            // Acknowledge message
            await envelope.ack();
            
            // Reset error count on success
            this.errorCounts.delete(message.id);

            this.emit('message:processed', { message, success: true });

        } catch (error) {
            await this.handleError(error, envelope);
        }
    }

    private async executeHandler(
        handler: MessageHandler,
        value: any,
        envelope: MessageEnvelope
    ): Promise<void> {
        const timeout = this.config.sessionTimeout || 30000;
        
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Handler timeout')), timeout);
        });

        await Promise.race([
            handler(value, envelope),
            timeoutPromise
        ]);
    }

    private async handleError(error: any, envelope: MessageEnvelope): Promise<void> {
        const { message } = envelope;
        const errorCount = (this.errorCounts.get(message.id) || 0) + 1;
        this.errorCounts.set(message.id, errorCount);

        this.logger.error(`Error processing message: ${message.id}`, {
            error: error.message,
            stack: error.stack,
            attempt: errorCount,
            maxAttempts: this.config.retryAttempts
        });

        // Check if we should retry
        if (errorCount < (this.config.retryAttempts || 3)) {
            // Delay before retry
            await new Promise(resolve => 
                setTimeout(resolve, this.config.retryDelay || 1000)
            );

            // Requeue for retry
            await envelope.nack(true);
            
            this.emit('message:retry', { 
                message, 
                error, 
                attempt: errorCount 
            });

        } else {
            // Max retries exceeded
            this.logger.error(`Max retries exceeded for message: ${message.id}`);
            
            // Send to dead letter queue if configured
            if (this.config.deadLetterTopic) {
                await this.sendToDeadLetter(message, error);
            }

            // Acknowledge to remove from queue
            await envelope.ack();
            
            // Call error handler if provided
            if (this.config.errorHandler) {
                this.config.errorHandler(error, envelope);
            }

            this.emit('message:failed', { 
                message, 
                error, 
                attempts: errorCount 
            });
        }
    }

    private getHandlers(messageType: string): MessageHandler[] {
        const handlers: MessageHandler[] = [];

        // Exact match
        const exactHandlers = this.handlers.get(messageType);
        if (exactHandlers) {
            handlers.push(...exactHandlers);
        }

        // Wildcard handlers
        const wildcardHandlers = this.handlers.get('*');
        if (wildcardHandlers) {
            handlers.push(...wildcardHandlers);
        }

        return handlers;
    }

    private async sendToDeadLetter(message: any, error: Error): Promise<void> {
        // This would send to dead letter queue
        // Implementation depends on the queue system
        this.logger.info(`Sending message to dead letter queue: ${message.id}`);
        
        this.emit('deadletter', {
            message,
            error: error.message,
            timestamp: new Date()
        });
    }
}

// Typed message processor for better type safety
export class TypedMessageProcessor<T extends Record<string, any>> extends MessageProcessor {
    public on<K extends keyof T>(
        messageType: K,
        handler: (message: T[K], envelope: MessageEnvelope) => Promise<void>
    ): this {
        super.on(messageType as string, handler as MessageHandler);
        return this;
    }
}

// Helper function to create a typed processor
export function createMessageProcessor<T extends Record<string, any>>(
    name: string,
    config: ProcessorConfig
): TypedMessageProcessor<T> {
    return new TypedMessageProcessor<T>(name, config);
}
