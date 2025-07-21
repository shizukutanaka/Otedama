/**
 * Enhanced P2P Manager
 * Integrates node discovery, NAT traversal, and encrypted transport
 */

import { EventEmitter } from 'events';
import { NodeDiscovery } from './node-discovery.js';
import { NATTraversal } from './nat-traversal.js';
import { EncryptedTransport } from './encrypted-transport.js';
import { getLogger } from '../core/logger.js';
import net from 'net';
import Database from 'better-sqlite3';

// Connection states
export const ConnectionState = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    AUTHENTICATED: 'authenticated',
    ERROR: 'error'
};

// Peer types
export const PeerType = {
    MINER: 'miner',
    TRADER: 'trader',
    VALIDATOR: 'validator',
    RELAY: 'relay',
    BOOTSTRAP: 'bootstrap'
};

export class EnhancedP2PManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.logger = getLogger('EnhancedP2P');
        this.options = {
            // Network identity
            nodeId: options.nodeId || this.generateNodeId(),
            nodeType: options.nodeType || PeerType.MINER,
            port: options.port || 8333,
            host: options.host || '0.0.0.0',
            
            // Connection limits
            maxInboundConnections: options.maxInboundConnections || 32,
            maxOutboundConnections: options.maxOutboundConnections || 16,
            maxTotalConnections: options.maxTotalConnections || 50,
            
            // Discovery settings
            enableDiscovery: options.enableDiscovery !== false,
            bootstrapNodes: options.bootstrapNodes || [],
            
            // NAT traversal
            enableNATTraversal: options.enableNATTraversal !== false,
            upnpEnabled: options.upnpEnabled !== false,
            
            // Encryption
            enableEncryption: options.enableEncryption !== false,
            requireEncryption: options.requireEncryption !== false,
            
            // Database
            databasePath: options.databasePath || './p2p.db',
            
            // Timeouts
            connectionTimeout: options.connectionTimeout || 10000,
            handshakeTimeout: options.handshakeTimeout || 30000,
            pingInterval: options.pingInterval || 60000,
            
            ...options
        };
        
        // Core components
        this.nodeDiscovery = null;
        this.natTraversal = null;
        this.encryptedTransport = null;
        
        // Network state
        this.server = null;
        this.connections = new Map();
        this.peers = new Map();
        
        // Connection queues
        this.inboundConnections = new Set();
        this.outboundConnections = new Set();
        this.pendingConnections = new Map();
        
        // Message handling
        this.messageHandlers = new Map();
        this.messageQueue = [];
        
        // Database
        this.database = null;
        
        // Statistics
        this.stats = {
            inboundConnections: 0,
            outboundConnections: 0,
            totalConnections: 0,
            messagesReceived: 0,
            messagesSent: 0,
            bytesReceived: 0,
            bytesSent: 0,
            peersDiscovered: 0,
            connectionAttempts: 0,
            connectionFailures: 0,
            uptime: Date.now()
        };
        
        // Initialize components
        this.initializeComponents();
    }
    
    /**
     * Initialize P2P components
     */
    initializeComponents() {
        // Node discovery
        if (this.options.enableDiscovery) {
            this.nodeDiscovery = new NodeDiscovery({
                nodeId: this.options.nodeId,
                nodeType: this.options.nodeType,
                port: this.options.port,
                bootstrapNodes: this.options.bootstrapNodes,
                maxPeers: this.options.maxTotalConnections
            });
            
            this.setupDiscoveryEventHandlers();
        }
        
        // NAT traversal
        if (this.options.enableNATTraversal) {
            this.natTraversal = new NATTraversal({
                localPort: this.options.port,
                upnpEnabled: this.options.upnpEnabled
            });
            
            this.setupNATEventHandlers();
        }
        
        // Encrypted transport
        if (this.options.enableEncryption) {
            this.encryptedTransport = new EncryptedTransport({
                requireAuthentication: this.options.requireEncryption
            });
            
            this.setupTransportEventHandlers();
        }
    }
    
    /**
     * Start P2P manager
     */
    async start() {
        this.logger.info('Starting Enhanced P2P Manager...');
        
        // Initialize database
        await this.initializeDatabase();
        
        // Initialize components
        if (this.encryptedTransport) {
            await this.encryptedTransport.initialize();
        }
        
        if (this.natTraversal) {
            await this.natTraversal.initialize();
        }
        
        // Start server
        await this.startServer();
        
        // Start node discovery
        if (this.nodeDiscovery) {
            await this.nodeDiscovery.start();
        }
        
        // Start periodic tasks
        this.startPeriodicTasks();
        
        this.logger.info(`P2P Manager started on ${this.options.host}:${this.options.port}`);
        this.emit('started', {
            nodeId: this.options.nodeId,
            address: `${this.options.host}:${this.options.port}`
        });
    }
    
    /**
     * Initialize database
     */
    async initializeDatabase() {
        this.database = new Database(this.options.databasePath);
        
        this.database.exec(`
            -- Peers table
            CREATE TABLE IF NOT EXISTS peers (
                id TEXT PRIMARY KEY,
                node_id TEXT UNIQUE NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                public_host TEXT,
                public_port INTEGER,
                peer_type TEXT,
                protocol_version TEXT,
                services TEXT,
                last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                reputation INTEGER DEFAULT 0,
                connection_attempts INTEGER DEFAULT 0,
                successful_connections INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            
            -- Connections table
            CREATE TABLE IF NOT EXISTS connections (
                id TEXT PRIMARY KEY,
                peer_id TEXT NOT NULL,
                direction TEXT NOT NULL, -- 'inbound' or 'outbound'
                local_address TEXT,
                remote_address TEXT,
                encrypted BOOLEAN DEFAULT 0,
                protocol TEXT,
                connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                disconnected_at DATETIME,
                bytes_sent INTEGER DEFAULT 0,
                bytes_received INTEGER DEFAULT 0,
                messages_sent INTEGER DEFAULT 0,
                messages_received INTEGER DEFAULT 0,
                FOREIGN KEY (peer_id) REFERENCES peers(node_id)
            );
            
            -- Messages table
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                connection_id TEXT NOT NULL,
                direction TEXT NOT NULL, -- 'sent' or 'received'
                message_type TEXT NOT NULL,
                size INTEGER NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (connection_id) REFERENCES connections(id)
            );
            
            -- Network events table
            CREATE TABLE IF NOT EXISTS network_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                peer_id TEXT,
                details TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            
            -- Create indexes
            CREATE INDEX IF NOT EXISTS idx_peers_node_id ON peers(node_id);
            CREATE INDEX IF NOT EXISTS idx_peers_last_seen ON peers(last_seen DESC);
            CREATE INDEX IF NOT EXISTS idx_connections_peer ON connections(peer_id);
            CREATE INDEX IF NOT EXISTS idx_messages_connection ON messages(connection_id);
            CREATE INDEX IF NOT EXISTS idx_network_events_type ON network_events(event_type);
        `);
        
        this.logger.info('P2P database initialized');
    }
    
    /**
     * Start TCP server
     */
    async startServer() {
        return new Promise((resolve, reject) => {
            this.server = net.createServer();
            
            this.server.on('connection', (socket) => {
                this.handleInboundConnection(socket);
            });
            
            this.server.on('error', (error) => {
                this.logger.error('Server error:', error);
                reject(error);
            });
            
            this.server.listen(this.options.port, this.options.host, () => {
                this.logger.info(`Server listening on ${this.options.host}:${this.options.port}`);
                resolve();
            });
        });
    }
    
    /**
     * Handle inbound connection
     */
    async handleInboundConnection(socket) {
        const connectionId = this.generateConnectionId();
        const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`;
        
        this.logger.info(`Inbound connection from ${remoteAddress}`);
        
        // Check connection limits
        if (this.inboundConnections.size >= this.options.maxInboundConnections) {
            this.logger.warn(`Rejecting inbound connection: limit reached (${this.options.maxInboundConnections})`);
            socket.destroy();
            return;
        }
        
        try {
            // Setup encryption if enabled
            let secureSocket = socket;
            if (this.encryptedTransport) {
                secureSocket = await this.encryptedTransport.establishSecureConnection(socket, false);
            }
            
            // Perform handshake
            const peerInfo = await this.performHandshake(secureSocket, false);
            
            // Create connection
            const connection = {
                id: connectionId,
                socket: secureSocket,
                peerId: peerInfo.nodeId,
                direction: 'inbound',
                state: ConnectionState.CONNECTED,
                peerInfo,
                connected: Date.now(),
                lastActivity: Date.now(),
                stats: {
                    bytesReceived: 0,
                    bytesSent: 0,
                    messagesReceived: 0,
                    messagesSent: 0
                }
            };
            
            this.addConnection(connection);
            
        } catch (error) {
            this.logger.error(`Failed to establish inbound connection from ${remoteAddress}:`, error);
            socket.destroy();
        }
    }
    
    /**
     * Connect to peer
     */
    async connectToPeer(peerInfo) {
        const { nodeId, host, port, publicHost, publicPort } = peerInfo;
        
        this.logger.info(`Connecting to peer ${nodeId} at ${host}:${port}`);
        
        // Check if already connected
        if (this.peers.has(nodeId)) {
            throw new Error('Already connected to peer');
        }
        
        // Check connection limits
        if (this.outboundConnections.size >= this.options.maxOutboundConnections) {
            throw new Error('Outbound connection limit reached');
        }
        
        const connectionId = this.generateConnectionId();
        this.stats.connectionAttempts++;
        
        try {
            // Try to establish connection
            let socket;
            
            if (this.natTraversal) {
                // Use NAT traversal for connection
                const localAddress = { host, port };
                const publicAddress = publicHost ? { host: publicHost, port: publicPort } : null;
                
                socket = await this.natTraversal.establishConnection(localAddress, publicAddress);
            } else {
                // Direct connection
                socket = await this.createDirectConnection(host, port);
            }
            
            // Setup encryption if enabled
            let secureSocket = socket;
            if (this.encryptedTransport) {
                secureSocket = await this.encryptedTransport.establishSecureConnection(socket, true, nodeId);
            }
            
            // Perform handshake
            const remotePeerInfo = await this.performHandshake(secureSocket, true);
            
            // Verify peer identity
            if (remotePeerInfo.nodeId !== nodeId) {
                throw new Error('Peer identity mismatch');
            }
            
            // Create connection
            const connection = {
                id: connectionId,
                socket: secureSocket,
                peerId: nodeId,
                direction: 'outbound',
                state: ConnectionState.CONNECTED,
                peerInfo: remotePeerInfo,
                connected: Date.now(),
                lastActivity: Date.now(),
                stats: {
                    bytesReceived: 0,
                    bytesSent: 0,
                    messagesReceived: 0,
                    messagesSent: 0
                }
            };
            
            this.addConnection(connection);
            
            return connection;
            
        } catch (error) {
            this.stats.connectionFailures++;
            this.logger.error(`Failed to connect to peer ${nodeId}:`, error);
            throw error;
        }
    }
    
    /**
     * Create direct TCP connection
     */
    async createDirectConnection(host, port) {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            
            const timeout = setTimeout(() => {
                socket.destroy();
                reject(new Error('Connection timeout'));
            }, this.options.connectionTimeout);
            
            socket.connect(port, host, () => {
                clearTimeout(timeout);
                resolve(socket);
            });
            
            socket.on('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });
    }
    
    /**
     * Perform P2P handshake
     */
    async performHandshake(socket, isInitiator) {
        const handshakeTimeout = setTimeout(() => {
            socket.destroy();
            throw new Error('Handshake timeout');
        }, this.options.handshakeTimeout);
        
        try {
            if (isInitiator) {
                // Send version message
                await this.sendMessage(socket, 'version', {
                    nodeId: this.options.nodeId,
                    nodeType: this.options.nodeType,
                    version: '1.0.0',
                    services: ['mining', 'dex'],
                    timestamp: Date.now(),
                    localAddress: `${this.options.host}:${this.options.port}`
                });
                
                // Wait for verack
                const response = await this.receiveMessage(socket);
                if (response.type !== 'verack') {
                    throw new Error('Invalid handshake response');
                }
                
                return response.payload;
                
            } else {
                // Wait for version message
                const versionMessage = await this.receiveMessage(socket);
                if (versionMessage.type !== 'version') {
                    throw new Error('Invalid handshake initiation');
                }
                
                // Send verack
                await this.sendMessage(socket, 'verack', {
                    nodeId: this.options.nodeId,
                    nodeType: this.options.nodeType,
                    version: '1.0.0',
                    services: ['mining', 'dex'],
                    timestamp: Date.now(),
                    localAddress: `${this.options.host}:${this.options.port}`
                });
                
                return versionMessage.payload;
            }
            
        } finally {
            clearTimeout(handshakeTimeout);
        }
    }
    
    /**
     * Add connection
     */
    addConnection(connection) {
        this.connections.set(connection.id, connection);
        this.peers.set(connection.peerId, connection);
        
        if (connection.direction === 'inbound') {
            this.inboundConnections.add(connection.id);
            this.stats.inboundConnections++;
        } else {
            this.outboundConnections.add(connection.id);
            this.stats.outboundConnections++;
        }
        
        this.stats.totalConnections++;
        
        // Setup message handling
        this.setupConnectionHandlers(connection);
        
        // Store in database
        this.storePeerInfo(connection.peerInfo);
        this.storeConnectionInfo(connection);
        
        this.emit('peerConnected', {
            peerId: connection.peerId,
            direction: connection.direction,
            peerInfo: connection.peerInfo
        });
        
        this.logger.info(`Peer connected: ${connection.peerId} (${connection.direction})`);
    }
    
    /**
     * Setup connection event handlers
     */
    setupConnectionHandlers(connection) {
        connection.socket.on('data', (data) => {
            this.handleConnectionData(connection, data);
        });
        
        connection.socket.on('close', () => {
            this.handleConnectionClose(connection);
        });
        
        connection.socket.on('error', (error) => {
            this.handleConnectionError(connection, error);
        });
    }
    
    /**
     * Handle connection data
     */
    handleConnectionData(connection, data) {
        connection.lastActivity = Date.now();
        connection.stats.bytesReceived += data.length;
        this.stats.bytesReceived += data.length;
        
        try {
            // Parse messages
            const messages = this.parseMessages(data);
            
            for (const message of messages) {
                this.handleMessage(connection, message);
            }
            
        } catch (error) {
            this.logger.error(`Error handling data from ${connection.peerId}:`, error);
        }
    }
    
    /**
     * Handle message
     */
    handleMessage(connection, message) {
        connection.stats.messagesReceived++;
        this.stats.messagesReceived++;
        
        // Store message in database
        this.storeMessage(connection.id, 'received', message.type, JSON.stringify(message).length);
        
        // Handle built-in messages
        switch (message.type) {
            case 'ping':
                this.handlePing(connection, message);
                break;
                
            case 'pong':
                this.handlePong(connection, message);
                break;
                
            case 'addr':
                this.handleAddr(connection, message);
                break;
                
            case 'getaddr':
                this.handleGetAddr(connection, message);
                break;
                
            default:
                // Forward to registered handlers
                const handler = this.messageHandlers.get(message.type);
                if (handler) {
                    handler(connection, message);
                } else {
                    this.logger.debug(`Unhandled message type: ${message.type}`);
                }
        }
    }
    
    /**
     * Send message to peer
     */
    async sendMessage(socket, type, payload) {
        const message = {
            type,
            payload,
            timestamp: Date.now()
        };
        
        const data = this.serializeMessage(message);
        
        return new Promise((resolve, reject) => {
            socket.write(data, (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }
    
    /**
     * Broadcast message to all peers
     */
    async broadcastMessage(type, payload, excludePeers = []) {
        const excludeSet = new Set(excludePeers);
        const promises = [];
        
        for (const connection of this.connections.values()) {
            if (!excludeSet.has(connection.peerId) && connection.state === ConnectionState.CONNECTED) {
                promises.push(
                    this.sendMessage(connection.socket, type, payload).catch(error => {
                        this.logger.warn(`Failed to send message to ${connection.peerId}:`, error.message);
                    })
                );
            }
        }
        
        return Promise.allSettled(promises);
    }
    
    /**
     * Register message handler
     */
    onMessage(type, handler) {
        this.messageHandlers.set(type, handler);
    }
    
    /**
     * Get peer list
     */
    getPeers() {
        return Array.from(this.peers.values()).map(connection => ({
            peerId: connection.peerId,
            direction: connection.direction,
            connected: connection.connected,
            lastActivity: connection.lastActivity,
            stats: connection.stats,
            peerInfo: connection.peerInfo
        }));
    }
    
    /**
     * Get network statistics
     */
    getStats() {
        return {
            ...this.stats,
            uptime: Date.now() - this.stats.uptime,
            discoveryStats: this.nodeDiscovery?.getStats(),
            natStats: this.natTraversal?.getStats(),
            transportStats: this.encryptedTransport?.getStats()
        };
    }
    
    /**
     * Setup component event handlers
     */
    setupDiscoveryEventHandlers() {
        this.nodeDiscovery.on('peerDiscovered', async (peer) => {
            this.stats.peersDiscovered++;
            
            // Try to connect if we need more peers
            if (this.outboundConnections.size < this.options.maxOutboundConnections) {
                try {
                    await this.connectToPeer(peer);
                } catch (error) {
                    this.logger.debug(`Failed to connect to discovered peer:`, error.message);
                }
            }
        });
    }
    
    setupNATEventHandlers() {
        this.natTraversal.on('connectionEstablished', (data) => {
            this.logger.info(`NAT traversal connection established via ${data.method}`);
        });
    }
    
    setupTransportEventHandlers() {
        this.encryptedTransport.on('connectionEstablished', (data) => {
            this.logger.info(`Encrypted connection established with ${data.peerId}`);
        });
    }
    
    /**
     * Utility methods
     */
    
    generateNodeId() {
        return crypto.randomBytes(32).toString('hex');
    }
    
    generateConnectionId() {
        return `conn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    
    serializeMessage(message) {
        const json = JSON.stringify(message);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(json.length, 0);
        return Buffer.concat([length, Buffer.from(json)]);
    }
    
    parseMessages(data) {
        const messages = [];
        let offset = 0;
        
        while (offset < data.length) {
            if (offset + 4 > data.length) break;
            
            const length = data.readUInt32BE(offset);
            offset += 4;
            
            if (offset + length > data.length) break;
            
            const messageData = data.slice(offset, offset + length);
            offset += length;
            
            try {
                const message = JSON.parse(messageData.toString());
                messages.push(message);
            } catch (error) {
                this.logger.error('Failed to parse message:', error);
                break;
            }
        }
        
        return messages;
    }
    
    async receiveMessage(socket) {
        return new Promise((resolve, reject) => {
            let lengthBuffer = Buffer.alloc(4);
            let lengthReceived = 0;
            let messageLength = 0;
            let messageBuffer = null;
            let messageReceived = 0;
            
            const onData = (data) => {
                let offset = 0;
                
                // Read length if not complete
                if (lengthReceived < 4) {
                    const needed = 4 - lengthReceived;
                    const available = Math.min(needed, data.length);
                    
                    data.copy(lengthBuffer, lengthReceived, offset, offset + available);
                    lengthReceived += available;
                    offset += available;
                    
                    if (lengthReceived === 4) {
                        messageLength = lengthBuffer.readUInt32BE(0);
                        messageBuffer = Buffer.alloc(messageLength);
                    }
                }
                
                // Read message if length is known
                if (messageBuffer && offset < data.length) {
                    const needed = messageLength - messageReceived;
                    const available = Math.min(needed, data.length - offset);
                    
                    data.copy(messageBuffer, messageReceived, offset, offset + available);
                    messageReceived += available;
                    
                    if (messageReceived === messageLength) {
                        socket.removeListener('data', onData);
                        
                        try {
                            const message = JSON.parse(messageBuffer.toString());
                            resolve(message);
                        } catch (error) {
                            reject(error);
                        }
                    }
                }
            };
            
            socket.on('data', onData);
            
            socket.on('error', (error) => {
                socket.removeListener('data', onData);
                reject(error);
            });
        });
    }
    
    /**
     * Database operations
     */
    
    storePeerInfo(peerInfo) {
        this.database.prepare(`
            INSERT OR REPLACE INTO peers 
            (node_id, host, port, public_host, public_port, peer_type, protocol_version, services, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
            peerInfo.nodeId,
            peerInfo.host || null,
            peerInfo.port || null,
            peerInfo.publicHost || null,
            peerInfo.publicPort || null,
            peerInfo.nodeType || null,
            peerInfo.version || null,
            JSON.stringify(peerInfo.services || [])
        );
    }
    
    storeConnectionInfo(connection) {
        this.database.prepare(`
            INSERT INTO connections 
            (id, peer_id, direction, local_address, remote_address, encrypted, protocol)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            connection.id,
            connection.peerId,
            connection.direction,
            `${this.options.host}:${this.options.port}`,
            `${connection.socket.remoteAddress}:${connection.socket.remotePort}`,
            connection.socket.encrypted ? 1 : 0,
            connection.socket.protocol || 'tcp'
        );
    }
    
    storeMessage(connectionId, direction, messageType, size) {
        this.database.prepare(`
            INSERT INTO messages (id, connection_id, direction, message_type, size)
            VALUES (?, ?, ?, ?, ?)
        `).run(
            `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            connectionId,
            direction,
            messageType,
            size
        );
    }
    
    /**
     * Built-in message handlers
     */
    
    handlePing(connection, message) {
        // Respond with pong
        this.sendMessage(connection.socket, 'pong', {
            nonce: message.payload.nonce,
            timestamp: Date.now()
        });
    }
    
    handlePong(connection, message) {
        // Update connection activity
        connection.lastActivity = Date.now();
    }
    
    handleAddr(connection, message) {
        // Process address list from peer
        const addresses = message.payload.addresses || [];
        
        for (const addr of addresses) {
            if (this.nodeDiscovery) {
                this.nodeDiscovery.addCandidate(addr);
            }
        }
    }
    
    handleGetAddr(connection, message) {
        // Send known peers
        const knownPeers = this.database.prepare(`
            SELECT node_id, host, port, public_host, public_port, peer_type
            FROM peers
            WHERE last_seen > datetime('now', '-1 hour')
            LIMIT 100
        `).all();
        
        this.sendMessage(connection.socket, 'addr', {
            addresses: knownPeers.map(peer => ({
                nodeId: peer.node_id,
                host: peer.host,
                port: peer.port,
                publicHost: peer.public_host,
                publicPort: peer.public_port,
                type: peer.peer_type
            }))
        });
    }
    
    handleConnectionClose(connection) {
        this.logger.info(`Connection closed: ${connection.peerId}`);
        
        // Update database
        this.database.prepare(`
            UPDATE connections
            SET disconnected_at = CURRENT_TIMESTAMP,
                bytes_sent = ?, bytes_received = ?,
                messages_sent = ?, messages_received = ?
            WHERE id = ?
        `).run(
            connection.stats.bytesSent,
            connection.stats.bytesReceived,
            connection.stats.messagesSent,
            connection.stats.messagesReceived,
            connection.id
        );
        
        // Remove from tracking
        this.removeConnection(connection);
    }
    
    handleConnectionError(connection, error) {
        this.logger.error(`Connection error from ${connection.peerId}:`, error);
        this.removeConnection(connection);
    }
    
    removeConnection(connection) {
        this.connections.delete(connection.id);
        this.peers.delete(connection.peerId);
        
        if (connection.direction === 'inbound') {
            this.inboundConnections.delete(connection.id);
            this.stats.inboundConnections--;
        } else {
            this.outboundConnections.delete(connection.id);
            this.stats.outboundConnections--;
        }
        
        this.stats.totalConnections--;
        
        this.emit('peerDisconnected', {
            peerId: connection.peerId,
            direction: connection.direction
        });
    }
    
    /**
     * Start periodic tasks
     */
    startPeriodicTasks() {
        // Ping connected peers
        setInterval(() => {
            this.pingPeers();
        }, this.options.pingInterval);
        
        // Clean up stale connections
        setInterval(() => {
            this.cleanupConnections();
        }, 300000); // 5 minutes
        
        // Update statistics
        setInterval(() => {
            this.updateStatistics();
        }, 60000); // 1 minute
    }
    
    pingPeers() {
        for (const connection of this.connections.values()) {
            if (connection.state === ConnectionState.CONNECTED) {
                this.sendMessage(connection.socket, 'ping', {
                    nonce: Math.random().toString(36),
                    timestamp: Date.now()
                }).catch(error => {
                    this.logger.debug(`Failed to ping ${connection.peerId}:`, error.message);
                });
            }
        }
    }
    
    cleanupConnections() {
        const now = Date.now();
        const timeout = 5 * 60 * 1000; // 5 minutes
        
        for (const connection of this.connections.values()) {
            if (now - connection.lastActivity > timeout) {
                this.logger.warn(`Closing stale connection: ${connection.peerId}`);
                connection.socket.destroy();
            }
        }
    }
    
    updateStatistics() {
        // Update peer statistics in database
        for (const connection of this.connections.values()) {
            this.database.prepare(`
                UPDATE peers
                SET last_seen = CURRENT_TIMESTAMP,
                    successful_connections = successful_connections + 1
                WHERE node_id = ?
            `).run(connection.peerId);
        }
    }
    
    /**
     * Shutdown P2P manager
     */
    async shutdown() {
        this.logger.info('Shutting down P2P manager...');
        
        // Close all connections
        for (const connection of this.connections.values()) {
            connection.socket.destroy();
        }
        
        // Close server
        if (this.server) {
            this.server.close();
        }
        
        // Shutdown components
        if (this.nodeDiscovery) {
            await this.nodeDiscovery.shutdown();
        }
        
        if (this.natTraversal) {
            await this.natTraversal.cleanup();
        }
        
        if (this.encryptedTransport) {
            await this.encryptedTransport.cleanup();
        }
        
        // Close database
        if (this.database) {
            this.database.close();
        }
        
        this.emit('shutdown');
    }
}

export default EnhancedP2PManager;