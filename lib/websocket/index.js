/**
 * WebSocket Real-time Module
 * 
 * This is now a facade that uses the Unified WebSocket Manager
 * Maintains backward compatibility while using the consolidated system
 */

import UnifiedWebSocketManager from '../core/websocket-manager.js';

// Create specialized server instances for backward compatibility
export class RealtimeServer extends UnifiedWebSocketManager {
    constructor(config = {}) {
        super({ ...config, purpose: 'general' });
    }
}

export class MiningStatsServer extends UnifiedWebSocketManager {
    constructor(config = {}) {
        super({ ...config, purpose: 'mining' });
    }
}

export class DexDataServer extends UnifiedWebSocketManager {
    constructor(config = {}) {
        super({ ...config, purpose: 'dex' });
    }
}

// Alias for enhanced version
export { RealtimeServer as EnhancedRealtimeServer };

// Export client components
export { RealtimeClient } from './realtime-client.js';
export { RealtimeDataClient, MiningDataClient, TradingDataClient } from './realtime-client.js';

// Export the connection manager (which is now part of UnifiedWebSocketManager)
export { default as WebSocketConnectionManager } from './websocket-connection-manager.js';

// Quick setup function using unified manager
export function setupRealtimeServers(config = {}, workDistributor = null) {
    const servers = {
        mining: null,
        dex: null
    };
    
    // Create mining server
    if (config.miningPort) {
        servers.mining = new UnifiedWebSocketManager({
            port: config.miningPort,
            purpose: 'mining',
            ...config
        });
        
        servers.mining.initialize()
            .then(() => console.log(`Mining stats: ws://localhost:${config.miningPort}`))
            .catch(error => console.error('Failed to initialize mining server:', error));
    }
    
    // Create DEX server
    if (config.dexPort) {
        servers.dex = new UnifiedWebSocketManager({
            port: config.dexPort,
            purpose: 'dex',
            ...config
        });
        
        servers.dex.initialize()
            .then(() => console.log(`DEX data: ws://localhost:${config.dexPort}`))
            .catch(error => console.error('Failed to initialize DEX server:', error));
    }
    
    // Attach work distributor if provided
    if (workDistributor && servers.mining) {
        // The unified manager handles work distribution internally
        servers.mining.setWorkDistributor(workDistributor);
    }
    
    return servers;
}

// Export unified manager for direct usage
export { default as UnifiedWebSocketManager } from '../core/websocket-manager.js';