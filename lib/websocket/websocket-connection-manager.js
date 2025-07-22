/**
 * WebSocket Connection Manager
 * 
 * This is now a facade that uses the Unified WebSocket Manager
 * Maintains backward compatibility while using the consolidated system
 */

import UnifiedWebSocketManager from '../core/websocket-manager.js';

// Facade class that extends UnifiedWebSocketManager for backward compatibility
class WebSocketConnectionManager extends UnifiedWebSocketManager {
    constructor(options = {}) {
        // Transform old options to new format
        const unifiedOptions = {
            ...options,
            maxConnections: options.maxConnections || 10000,
            heartbeatInterval: options.heartbeatInterval || 30000,
            heartbeatTimeout: options.heartbeatTimeout || 60000,
            reconnectOptions: {
                maxAttempts: options.maxReconnectAttempts || 10,
                baseDelay: options.reconnectInterval || 1000,
                maxDelay: options.maxReconnectDelay || 30000,
                ...options.reconnectOptions
            }
        };
        
        super(unifiedOptions);
        
        // Maintain backward compatibility properties
        this.connections = this.connectionPool;
        this.stats = this.metrics;
    }
    
    // Backward compatibility methods
    handleConnection(ws, req) {
        return this.handleNewConnection(ws, req);
    }
    
    sendToClient(connectionId, data) {
        return this.send(connectionId, data);
    }
    
    broadcastToAll(data) {
        return this.broadcast(data);
    }
    
    getConnectionById(id) {
        return this.connectionPool.get(id);
    }
    
    removeConnection(id) {
        const connection = this.connectionPool.get(id);
        if (connection) {
            this.disconnect(id, 'Manual disconnect');
        }
    }
    
    getStats() {
        return this.getMetrics();
    }
}

export default WebSocketConnectionManager;