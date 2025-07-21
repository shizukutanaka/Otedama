/**
 * WebSocket Handler for Data Synchronization
 * Handles real-time data sync between client and server
 * 
 * Design principles:
 * - Fast message processing (Carmack)
 * - Clean protocol design (Martin)
 * - Simple sync logic (Pike)
 */

import { EventEmitter } from 'events';
import { logger } from '../core/logger.js';

export class SyncWebSocketHandler extends EventEmitter {
    constructor(persistenceManager) {
        super();
        
        this.persistenceManager = persistenceManager;
        this.connections = new Map(); // ws -> ConnectionInfo
        this.sessions = new Map(); // sessionId -> ws
        
        // Statistics
        this.stats = {
            totalConnections: 0,
            activeConnections: 0,
            messagesReceived: 0,
            messagesSent: 0,
            syncOperations: 0,
            errors: 0
        };
    }
    
    /**
     * Handle new WebSocket connection
     */
    handleConnection(ws, req) {
        const connectionId = this.generateConnectionId();
        const connectionInfo = {
            id: connectionId,
            ws,
            sessionId: null,
            userId: null,
            authenticated: false,
            lastActivity: Date.now(),
            ip: req.socket.remoteAddress,
            userAgent: req.headers['user-agent']
        };
        
        this.connections.set(ws, connectionInfo);
        this.stats.totalConnections++;
        this.stats.activeConnections++;
        
        logger.info(`WebSocket connection established: ${connectionId}`);
        
        // Setup event handlers
        ws.on('message', (data) => this.handleMessage(ws, data));
        ws.on('close', () => this.handleDisconnect(ws));
        ws.on('error', (error) => this.handleError(ws, error));
        ws.on('pong', () => this.handlePong(ws));
        
        // Send welcome message
        this.sendMessage(ws, {
            type: 'connection:established',
            connectionId,
            timestamp: Date.now()
        });
        
        // Start heartbeat
        this.startHeartbeat(ws);
    }
    
    /**
     * Handle incoming messages
     */
    async handleMessage(ws, data) {
        const connection = this.connections.get(ws);
        if (!connection) return;
        
        connection.lastActivity = Date.now();
        this.stats.messagesReceived++;
        
        try {
            const message = JSON.parse(data);
            
            // Log message for debugging
            logger.debug(`Received message: ${message.type}`);
            
            switch (message.type) {
                case 'auth':
                    await this.handleAuth(ws, message);
                    break;
                    
                case 'sync:batch':
                    await this.handleSyncBatch(ws, message);
                    break;
                    
                case 'data:save':
                    await this.handleDataSave(ws, message);
                    break;
                    
                case 'data:load':
                    await this.handleDataLoad(ws, message);
                    break;
                    
                case 'session:create':
                    await this.handleSessionCreate(ws, message);
                    break;
                    
                case 'session:resume':
                    await this.handleSessionResume(ws, message);
                    break;
                    
                case 'ping':
                    this.sendMessage(ws, { type: 'pong' });
                    break;
                    
                default:
                    logger.warn(`Unknown message type: ${message.type}`);
                    this.sendError(ws, 'Unknown message type');
            }
            
        } catch (error) {
            logger.error('Failed to handle message:', error);
            this.stats.errors++;
            this.sendError(ws, 'Invalid message format');
        }
    }
    
    /**
     * Handle authentication
     */
    async handleAuth(ws, message) {
        const connection = this.connections.get(ws);
        const { sessionId } = message;
        
        try {
            // Resume session
            const session = await this.persistenceManager.resumeSession(sessionId);
            
            // Update connection info
            connection.sessionId = sessionId;
            connection.userId = session.userId;
            connection.authenticated = true;
            
            // Map session to WebSocket
            this.sessions.set(sessionId, ws);
            
            // Send success response
            this.sendMessage(ws, {
                type: 'auth:success',
                sessionId,
                userId: session.userId,
                timestamp: Date.now()
            });
            
            logger.info(`Session authenticated: ${sessionId}`);
            
        } catch (error) {
            logger.error('Authentication failed:', error);
            this.sendMessage(ws, {
                type: 'auth:failed',
                error: error.message
            });
        }
    }
    
    /**
     * Handle sync batch
     */
    async handleSyncBatch(ws, message) {
        const connection = this.connections.get(ws);
        if (!connection.authenticated) {
            this.sendError(ws, 'Not authenticated');
            return;
        }
        
        const { requestId, batch } = message;
        const results = [];
        const conflicts = [];
        
        this.stats.syncOperations++;
        
        for (const operation of batch) {
            try {
                let result;
                
                switch (operation.operation) {
                    case 'save':
                        result = await this.persistenceManager.saveUserData(
                            connection.userId,
                            operation.dataType,
                            operation.data
                        );
                        
                        // Notify other connections of the same user
                        this.broadcastToUser(connection.userId, ws, {
                            type: 'data:updated',
                            data: {
                                dataType: operation.dataType,
                                data: operation.data,
                                version: result.version
                            }
                        });
                        
                        results.push({
                            operationId: operation.id,
                            success: true,
                            dataType: operation.dataType,
                            version: result.version
                        });
                        break;
                        
                    case 'delete':
                        // Handle delete operation
                        await this.persistenceManager.deleteUserData(
                            connection.userId,
                            operation.dataType
                        );
                        
                        results.push({
                            operationId: operation.id,
                            success: true,
                            dataType: operation.dataType
                        });
                        break;
                        
                    case 'force-update':
                        // Force update ignoring conflicts
                        result = await this.persistenceManager.saveUserData(
                            connection.userId,
                            operation.dataType,
                            operation.data
                        );
                        
                        results.push({
                            operationId: operation.id,
                            success: true,
                            dataType: operation.dataType,
                            version: result.version
                        });
                        break;
                        
                    default:
                        results.push({
                            operationId: operation.id,
                            success: false,
                            error: 'Unknown operation'
                        });
                }
                
            } catch (error) {
                logger.error(`Sync operation failed: ${operation.operation}`, error);
                
                // Check if it's a conflict
                if (error.code === 'VERSION_CONFLICT') {
                    const serverData = await this.persistenceManager.loadUserData(
                        connection.userId,
                        operation.dataType
                    );
                    
                    conflicts.push({
                        dataType: operation.dataType,
                        localVersion: {
                            data: operation.data,
                            version: operation.version,
                            lastModified: operation.timestamp
                        },
                        serverVersion: {
                            data: serverData,
                            version: serverData.version,
                            lastModified: serverData.lastModified
                        }
                    });
                    
                    results.push({
                        operationId: operation.id,
                        success: false,
                        error: 'Version conflict',
                        conflict: true
                    });
                } else {
                    results.push({
                        operationId: operation.id,
                        success: false,
                        error: error.message
                    });
                }
            }
        }
        
        // Send response
        this.sendMessage(ws, {
            type: 'sync:response',
            requestId,
            data: {
                results,
                conflicts
            }
        });
    }
    
    /**
     * Handle data save
     */
    async handleDataSave(ws, message) {
        const connection = this.connections.get(ws);
        if (!connection.authenticated) {
            this.sendError(ws, 'Not authenticated');
            return;
        }
        
        const { dataType, data, requestId } = message;
        
        try {
            const result = await this.persistenceManager.saveUserData(
                connection.userId,
                dataType,
                data
            );
            
            // Notify other connections
            this.broadcastToUser(connection.userId, ws, {
                type: 'data:updated',
                data: {
                    dataType,
                    data,
                    version: result.version
                }
            });
            
            // Send success response
            this.sendMessage(ws, {
                type: 'data:saved',
                requestId,
                dataType,
                version: result.version,
                checksum: result.checksum
            });
            
        } catch (error) {
            this.sendMessage(ws, {
                type: 'data:save:error',
                requestId,
                error: error.message
            });
        }
    }
    
    /**
     * Handle data load
     */
    async handleDataLoad(ws, message) {
        const connection = this.connections.get(ws);
        if (!connection.authenticated) {
            this.sendError(ws, 'Not authenticated');
            return;
        }
        
        const { dataType, requestId } = message;
        
        try {
            const data = await this.persistenceManager.loadUserData(
                connection.userId,
                dataType
            );
            
            this.sendMessage(ws, {
                type: 'data:loaded',
                requestId,
                dataType,
                data
            });
            
        } catch (error) {
            this.sendMessage(ws, {
                type: 'data:load:error',
                requestId,
                error: error.message
            });
        }
    }
    
    /**
     * Handle session creation
     */
    async handleSessionCreate(ws, message) {
        const { userId, connectionData, requestId } = message;
        
        try {
            const sessionId = await this.persistenceManager.createSession(
                userId,
                connectionData
            );
            
            // Update connection
            const connection = this.connections.get(ws);
            connection.sessionId = sessionId;
            connection.userId = userId;
            connection.authenticated = true;
            
            // Map session
            this.sessions.set(sessionId, ws);
            
            this.sendMessage(ws, {
                type: 'session:created',
                requestId,
                sessionId,
                userId
            });
            
        } catch (error) {
            this.sendMessage(ws, {
                type: 'session:create:error',
                requestId,
                error: error.message
            });
        }
    }
    
    /**
     * Handle session resume
     */
    async handleSessionResume(ws, message) {
        const { sessionId, requestId } = message;
        
        try {
            const session = await this.persistenceManager.resumeSession(sessionId);
            
            // Update connection
            const connection = this.connections.get(ws);
            connection.sessionId = sessionId;
            connection.userId = session.userId;
            connection.authenticated = true;
            
            // Update session mapping
            const oldWs = this.sessions.get(sessionId);
            if (oldWs && oldWs !== ws) {
                // Close old connection
                oldWs.close(1000, 'Session resumed elsewhere');
            }
            this.sessions.set(sessionId, ws);
            
            this.sendMessage(ws, {
                type: 'session:resumed',
                requestId,
                sessionId,
                userId: session.userId,
                lastActivity: session.lastActivity
            });
            
        } catch (error) {
            this.sendMessage(ws, {
                type: 'session:resume:error',
                requestId,
                error: error.message
            });
        }
    }
    
    /**
     * Handle disconnect
     */
    handleDisconnect(ws) {
        const connection = this.connections.get(ws);
        if (!connection) return;
        
        // Remove from sessions map
        if (connection.sessionId) {
            this.sessions.delete(connection.sessionId);
        }
        
        // Remove from connections
        this.connections.delete(ws);
        
        // Update stats
        this.stats.activeConnections--;
        
        // Clear heartbeat
        if (connection.heartbeatInterval) {
            clearInterval(connection.heartbeatInterval);
        }
        
        logger.info(`WebSocket disconnected: ${connection.id}`);
        
        this.emit('connection:closed', {
            connectionId: connection.id,
            sessionId: connection.sessionId,
            userId: connection.userId
        });
    }
    
    /**
     * Handle error
     */
    handleError(ws, error) {
        logger.error('WebSocket error:', error);
        this.stats.errors++;
        
        // Close connection on error
        ws.close(1011, 'Internal error');
    }
    
    /**
     * Handle pong (heartbeat response)
     */
    handlePong(ws) {
        const connection = this.connections.get(ws);
        if (connection) {
            connection.lastPong = Date.now();
        }
    }
    
    /**
     * Start heartbeat for connection
     */
    startHeartbeat(ws) {
        const connection = this.connections.get(ws);
        if (!connection) return;
        
        connection.heartbeatInterval = setInterval(() => {
            if (ws.readyState === ws.OPEN) {
                // Check if connection is alive
                if (connection.lastPong && Date.now() - connection.lastPong > 60000) {
                    // No pong received for 60 seconds
                    logger.warn(`Connection timeout: ${connection.id}`);
                    ws.close(1001, 'Connection timeout');
                    return;
                }
                
                ws.ping();
            }
        }, 30000); // Ping every 30 seconds
    }
    
    /**
     * Send message to WebSocket
     */
    sendMessage(ws, message) {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(message));
            this.stats.messagesSent++;
        }
    }
    
    /**
     * Send error message
     */
    sendError(ws, error) {
        this.sendMessage(ws, {
            type: 'error',
            error: typeof error === 'string' ? error : error.message,
            timestamp: Date.now()
        });
    }
    
    /**
     * Broadcast to all connections of a user
     */
    broadcastToUser(userId, excludeWs, message) {
        for (const [ws, connection] of this.connections) {
            if (connection.userId === userId && 
                connection.authenticated && 
                ws !== excludeWs &&
                ws.readyState === ws.OPEN) {
                this.sendMessage(ws, message);
            }
        }
    }
    
    /**
     * Broadcast to all authenticated connections
     */
    broadcast(message) {
        for (const [ws, connection] of this.connections) {
            if (connection.authenticated && ws.readyState === ws.OPEN) {
                this.sendMessage(ws, message);
            }
        }
    }
    
    /**
     * Generate connection ID
     */
    generateConnectionId() {
        return `CONN${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            activeSessions: this.sessions.size,
            timestamp: Date.now()
        };
    }
    
    /**
     * Cleanup inactive connections
     */
    cleanupInactiveConnections() {
        const now = Date.now();
        const timeout = 300000; // 5 minutes
        
        for (const [ws, connection] of this.connections) {
            if (now - connection.lastActivity > timeout && !connection.authenticated) {
                logger.info(`Closing inactive connection: ${connection.id}`);
                ws.close(1001, 'Inactive connection');
            }
        }
    }
    
    /**
     * Start cleanup timer
     */
    startCleanupTimer() {
        setInterval(() => {
            this.cleanupInactiveConnections();
        }, 60000); // Every minute
    }
}

export default SyncWebSocketHandler;