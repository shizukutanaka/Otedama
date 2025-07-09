/**
 * WebSocket Module Exports
 * Unified interface for all WebSocket functionality
 */

// Core WebSocket API
export { 
    WebSocketAPI,
    WebSocketMessage,
    WebSocketClient,
    Subscription,
    SubscriptionFilter,
    MessageType,
    EventChannel,
    WebSocketConfig
} from './websocket-api';

// Enhanced WebSocket API with advanced features
export {
    EnhancedWebSocketAPI,
    MessageQueueItem,
    MessageHistory,
    ReconnectionData,
    BatchMessage,
    CustomEventHandler,
    MessagePriority
} from './enhanced-websocket-api';

// Client SDK
export {
    OtedamaWebSocketClient,
    WebSocketClientConfig,
    SubscriptionOptions,
    MessageHandler,
    ErrorHandler,
    Channels,
    createOtedamaWebSocketClient
} from './client-sdk';

// WebSocket Server (if needed)
export { WebSocketServer } from './websocket-server';

// Re-export common types
export type { Server } from './server';

// Utility functions
export function createWebSocketAPI(
    logger: any,
    metrics: any,
    security: any,
    config: any
): WebSocketAPI {
    const { WebSocketAPI } = require('./websocket-api');
    return new WebSocketAPI(logger, metrics, security, config);
}

export function createEnhancedWebSocketAPI(baseAPI: any): EnhancedWebSocketAPI {
    const { EnhancedWebSocketAPI } = require('./enhanced-websocket-api');
    return new EnhancedWebSocketAPI(baseAPI);
}

// Default configuration
export const defaultWebSocketConfig = {
    port: 3001,
    pingInterval: 30000,
    authTimeout: 10000,
    maxConnections: 1000,
    enableRateLimit: true,
    jwtSecret: process.env.JWT_SECRET || 'change-this-secret'
};

// Channel definitions for type safety
export const CHANNELS = {
    POOL: {
        STATS: 'pool.stats',
        BLOCKS: 'pool.blocks',
        SHARES: 'pool.shares',
        PAYOUTS: 'pool.payouts'
    },
    MINER: {
        STATS: 'miner.stats',
        WORKERS: 'miner.workers'
    },
    SYSTEM: {
        ALERTS: 'system.alerts',
        STATUS: 'system.status'
    }
} as const;

// Message type definitions
export const MESSAGE_TYPES = {
    // Client to Server
    PING: 'ping',
    AUTH: 'auth',
    SUBSCRIBE: 'subscribe',
    UNSUBSCRIBE: 'unsubscribe',
    
    // Server to Client
    PONG: 'pong',
    AUTH_SUCCESS: 'auth_success',
    AUTH_ERROR: 'auth_error',
    SUBSCRIPTION_SUCCESS: 'subscription_success',
    SUBSCRIPTION_ERROR: 'subscription_error',
    EVENT: 'event',
    ERROR: 'error',
    RATE_LIMIT: 'rate_limit'
} as const;

// Filter operators
export const FILTER_OPERATORS = {
    EQUALS: 'equals',
    CONTAINS: 'contains',
    GREATER_THAN: 'greater_than',
    LESS_THAN: 'less_than'
} as const;

// Helper type for channel payloads
export interface ChannelPayloads {
    'pool.stats': {
        hashrate: number;
        miners: number;
        workers: number;
        difficulty: number;
        blockHeight: number;
        lastBlockTime: string;
    };
    'pool.blocks': {
        height: number;
        hash: string;
        reward: number;
        timestamp: string;
        miner: string;
        effort: number;
    };
    'pool.shares': {
        validShares: number;
        invalidShares: number;
        shareRate: number;
        difficulty: number;
    };
    'pool.payouts': {
        payoutId: string;
        minerId: string;
        amount: number;
        txHash: string;
        timestamp: string;
        status: string;
    };
    'miner.stats': {
        minerId: string;
        hashrate: number;
        shares: {
            valid: number;
            invalid: number;
        };
        balance: number;
        workers: number;
    };
    'miner.workers': {
        minerId: string;
        workerId: string;
        hashrate: number;
        lastShare: string;
        status: string;
    };
    'system.alerts': {
        level: 'info' | 'warning' | 'error' | 'critical';
        message: string;
        timestamp: string;
        details?: any;
    };
    'system.status': {
        healthy: boolean;
        uptime: number;
        connections: number;
        version: string;
    };
}

// Type-safe event emitter for channels
export interface TypedWebSocketEvents {
    'pool.stats': (data: ChannelPayloads['pool.stats']) => void;
    'pool.blocks': (data: ChannelPayloads['pool.blocks']) => void;
    'pool.shares': (data: ChannelPayloads['pool.shares']) => void;
    'pool.payouts': (data: ChannelPayloads['pool.payouts']) => void;
    'miner.stats': (data: ChannelPayloads['miner.stats']) => void;
    'miner.workers': (data: ChannelPayloads['miner.workers']) => void;
    'system.alerts': (data: ChannelPayloads['system.alerts']) => void;
    'system.status': (data: ChannelPayloads['system.status']) => void;
}
