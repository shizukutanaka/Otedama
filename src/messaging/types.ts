/**
 * Messaging System Type Definitions
 */

import { Message } from './message-queue';

export type QueueType = 'rabbitmq' | 'kafka' | 'memory';

export interface MessagePattern {
    topic: string;
    pattern?: string;
    exchange?: string;
}

export interface RetryStrategy {
    maxRetries: number;
    retryDelays: number[]; // milliseconds for each retry
    retryCondition?: (error: Error) => boolean;
    onRetryExhausted?: (error: Error, message: any) => void;
}

export interface CircuitBreakerConfig {
    threshold: number;
    timeout: number;
    resetTimeout: number;
}

export interface MessageTransformer<TIn = any, TOut = any> {
    transform(message: TIn): TOut | Promise<TOut>;
}

export interface MessageValidator<T = any> {
    validate(message: T): boolean | Promise<boolean>;
    getSchema?(): any;
}

export interface MessageSerializer<T = any> {
    serialize(data: T): Buffer | string;
    deserialize(data: Buffer | string): T;
}

export interface DLQConfig {
    enabled: boolean;
    topic: string;
    maxRetries?: number;
    ttl?: number;
}

export interface MetricsCollector {
    recordMessage(topic: string, size: number): void;
    recordLatency(topic: string, latency: number): void;
    recordError(topic: string, error: Error): void;
    getMetrics(): MessageMetrics;
}

export interface MessageMetrics {
    messagesProcessed: number;
    messagesErrored: number;
    averageLatency: number;
    throughput: number;
    errorRate: number;
    topicMetrics: Record<string, TopicMetrics>;
}

export interface TopicMetrics {
    messages: number;
    errors: number;
    avgLatency: number;
    lastMessage?: Date;
    lastError?: Date;
}

export interface MessageMiddleware<T = any> {
    name: string;
    priority?: number;
    pre?: (message: T) => T | Promise<T>;
    post?: (message: T, result: any) => void | Promise<void>;
    error?: (message: T, error: Error) => void | Promise<void>;
}

export interface MessagePipeline<T = any> {
    use(middleware: MessageMiddleware<T>): this;
    execute(message: T): Promise<T>;
}

// Share processing specific types
export interface ShareValidationResult {
    valid: boolean;
    reason?: string;
    difficulty?: number;
    reward?: number;
}

export interface ShareProcessingContext {
    shareId: string;
    minerId: string;
    workerId: string;
    jobId: string;
    submittedAt: Date;
    validatedAt?: Date;
}

// Block processing specific types
export interface BlockProcessingContext {
    height: number;
    hash: string;
    previousHash: string;
    foundAt: Date;
    processedAt?: Date;
}

export interface BlockValidationResult {
    valid: boolean;
    orphaned: boolean;
    confirmations: number;
    reward: number;
}

// Payment processing specific types
export interface PaymentBatch {
    id: string;
    blockHeight: number;
    totalAmount: number;
    minerCount: number;
    createdAt: Date;
    processedAt?: Date;
    status: PaymentBatchStatus;
}

export type PaymentBatchStatus = 
    | 'pending'
    | 'processing'
    | 'partially_sent'
    | 'sent'
    | 'confirmed'
    | 'failed';

export interface PaymentTransaction {
    batchId: string;
    minerId: string;
    address: string;
    amount: number;
    txHash?: string;
    status: PaymentTransactionStatus;
    attempts: number;
    lastError?: string;
}

export type PaymentTransactionStatus =
    | 'pending'
    | 'sent'
    | 'confirmed'
    | 'failed';

// Queue monitoring types
export interface QueueMonitor {
    getQueueDepth(topic: string): Promise<number>;
    getConsumerLag(topic: string, group: string): Promise<number>;
    getMessageRate(topic: string): Promise<number>;
    getErrorRate(topic: string): Promise<number>;
    getHealthStatus(): Promise<QueueHealthStatus>;
}

export interface QueueHealthStatus {
    healthy: boolean;
    issues: QueueHealthIssue[];
    metrics: {
        totalMessages: number;
        totalErrors: number;
        avgProcessingTime: number;
        consumerGroups: number;
    };
}

export interface QueueHealthIssue {
    severity: 'warning' | 'error' | 'critical';
    topic?: string;
    consumer?: string;
    message: string;
    timestamp: Date;
}

// Message routing types
export interface MessageRouter {
    route(message: any): string | string[]; // Returns topic(s)
    addRoute(pattern: MessagePattern, handler: MessageHandler): void;
    removeRoute(pattern: MessagePattern): void;
}

export interface MessageHandler {
    (message: any): void | Promise<void>;
}

// Saga types for distributed transactions
export interface SagaDefinition<T = any> {
    name: string;
    steps: SagaStepDefinition<T>[];
    compensationStrategy?: 'sequential' | 'parallel';
    timeout?: number;
}

export interface SagaStepDefinition<T = any> {
    name: string;
    action: (context: T) => Promise<any>;
    compensation?: (context: T, error?: Error) => Promise<void>;
    retryable?: boolean;
    timeout?: number;
}

export interface SagaExecutionContext<T = any> {
    id: string;
    sagaName: string;
    data: T;
    status: SagaStatus;
    currentStep?: string;
    completedSteps: string[];
    failedStep?: string;
    error?: Error;
}

export type SagaStatus = 
    | 'started'
    | 'running'
    | 'compensating'
    | 'completed'
    | 'failed'
    | 'aborted';

// Message deduplication
export interface MessageDeduplicator {
    isDuplicate(messageId: string): Promise<boolean>;
    markProcessed(messageId: string, ttl?: number): Promise<void>;
    cleanup(): Promise<void>;
}

// Priority queue support
export interface PriorityMessage<T = any> extends Message<T> {
    priority: number; // 0 = highest priority
}

export interface PriorityQueueConfig {
    priorities: number;
    defaultPriority: number;
}
