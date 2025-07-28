const { EventEmitter } = require('events');
const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

class RealtimeWebSocketServer extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            port: options.port || 8080,
            heartbeatInterval: options.heartbeatInterval || 30000,
            maxClients: options.maxClients || 10000,
            maxMessageSize: options.maxMessageSize || 1048576, // 1MB
            compressionThreshold: options.compressionThreshold || 1024,
            enableBinary: options.enableBinary !== false,
            enableCompression: options.enableCompression !== false,
            ...options
        };
        
        this.clients = new Map();
        this.rooms = new Map();
        this.subscriptions = new Map();
        
        // Message queue for reliable delivery
        this.messageQueue = new Map();
        this.acknowledgments = new Map();
        
        // Performance metrics
        this.metrics = {
            connections: 0,
            messages: 0,
            broadcasts: 0,
            errors: 0,
            bandwidth: { in: 0, out: 0 }
        };
        
        this.initialize();
    }

    initialize() {
        // Create HTTP server
        this.server = http.createServer();
        
        // Create WebSocket server
        this.wss = new WebSocket.Server({
            server: this.server,
            perMessageDeflate: this.config.enableCompression,
            maxPayload: this.config.maxMessageSize,
            clientTracking: false
        });
        
        // Setup handlers
        this.wss.on('connection', this.handleConnection.bind(this));
        
        // Start heartbeat
        this.startHeartbeat();
    }

    async start() {
        return new Promise((resolve, reject) => {
            this.server.listen(this.config.port, (err) => {
                if (err) {
                    reject(err);
                } else {
                    this.emit('server:started', { port: this.config.port });
                    resolve();
                }
            });
        });
    }

    handleConnection(ws, request) {
        const clientId = this.generateClientId();
        const clientIp = request.connection.remoteAddress;
        
        // Check connection limit
        if (this.clients.size >= this.config.maxClients) {
            ws.close(1008, 'Server full');
            return;
        }
        
        // Create client object
        const client = {
            id: clientId,
            ws: ws,
            ip: clientIp,
            connected: Date.now(),
            authenticated: false,
            user: null,
            rooms: new Set(),
            subscriptions: new Set(),
            lastPing: Date.now(),
            stats: {
                messages: 0,
                bytes: { sent: 0, received: 0 }
            }
        };
        
        this.clients.set(clientId, client);
        this.metrics.connections++;
        
        // Setup client handlers
        ws.on('message', (data) => this.handleMessage(clientId, data));
        ws.on('pong', () => this.handlePong(clientId));
        ws.on('close', (code, reason) => this.handleDisconnect(clientId, code, reason));
        ws.on('error', (error) => this.handleError(clientId, error));
        
        // Send welcome message
        this.sendToClient(clientId, {
            type: 'welcome',
            clientId: clientId,
            timestamp: Date.now()
        });
        
        this.emit('client:connected', { clientId, ip: clientIp });
    }

    async handleMessage(clientId, data) {
        const client = this.clients.get(clientId);
        if (!client) return;
        
        try {
            // Parse message
            const message = this.parseMessage(data);
            
            // Update stats
            client.stats.messages++;
            client.stats.bytes.received += data.length;
            this.metrics.messages++;
            this.metrics.bandwidth.in += data.length;
            
            // Handle message based on type
            switch (message.type) {
                case 'auth':
                    await this.handleAuth(clientId, message);
                    break;
                    
                case 'subscribe':
                    this.handleSubscribe(clientId, message);
                    break;
                    
                case 'unsubscribe':
                    this.handleUnsubscribe(clientId, message);
                    break;
                    
                case 'join':
                    this.handleJoinRoom(clientId, message);
                    break;
                    
                case 'leave':
                    this.handleLeaveRoom(clientId, message);
                    break;
                    
                case 'message':
                    this.handleClientMessage(clientId, message);
                    break;
                    
                case 'broadcast':
                    this.handleBroadcast(clientId, message);
                    break;
                    
                case 'ack':
                    this.handleAcknowledgment(clientId, message);
                    break;
                    
                default:
                    // Emit custom message type
                    this.emit(`message:${message.type}`, { clientId, message });
            }
            
        } catch (error) {
            this.sendError(clientId, 'Invalid message format');
            this.metrics.errors++;
        }
    }

    parseMessage(data) {
        if (this.config.enableBinary && data instanceof Buffer) {
            // Binary protocol for efficiency
            return this.parseBinaryMessage(data);
        } else {
            // JSON protocol
            return JSON.parse(data.toString());
        }
    }

    parseBinaryMessage(buffer) {
        // Simple binary protocol
        const type = buffer.readUInt8(0);
        const length = buffer.readUInt32BE(1);
        const payload = buffer.slice(5, 5 + length);
        
        const typeMap = {
            1: 'auth',
            2: 'subscribe',
            3: 'message',
            4: 'broadcast',
            5: 'ack'
        };
        
        return {
            type: typeMap[type] || 'unknown',
            data: JSON.parse(payload.toString())
        };
    }

    async handleAuth(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client) return;
        
        // Verify authentication
        const valid = await this.verifyAuth(message.data);
        
        if (valid) {
            client.authenticated = true;
            client.user = message.data.user;
            
            this.sendToClient(clientId, {
                type: 'auth-success',
                user: client.user
            });
            
            this.emit('client:authenticated', { clientId, user: client.user });
        } else {
            this.sendToClient(clientId, {
                type: 'auth-failed',
                reason: 'Invalid credentials'
            });
        }
    }

    handleSubscribe(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client || !client.authenticated) return;
        
        const channel = message.data.channel;
        
        // Add to subscription
        client.subscriptions.add(channel);
        
        if (!this.subscriptions.has(channel)) {
            this.subscriptions.set(channel, new Set());
        }
        this.subscriptions.get(channel).add(clientId);
        
        this.sendToClient(clientId, {
            type: 'subscribed',
            channel: channel
        });
        
        this.emit('client:subscribed', { clientId, channel });
    }

    handleUnsubscribe(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client) return;
        
        const channel = message.data.channel;
        
        client.subscriptions.delete(channel);
        
        const subscribers = this.subscriptions.get(channel);
        if (subscribers) {
            subscribers.delete(clientId);
            if (subscribers.size === 0) {
                this.subscriptions.delete(channel);
            }
        }
        
        this.sendToClient(clientId, {
            type: 'unsubscribed',
            channel: channel
        });
    }

    handleJoinRoom(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client || !client.authenticated) return;
        
        const room = message.data.room;
        
        // Add to room
        client.rooms.add(room);
        
        if (!this.rooms.has(room)) {
            this.rooms.set(room, new Set());
        }
        this.rooms.get(room).add(clientId);
        
        // Notify room members
        this.broadcastToRoom(room, {
            type: 'user-joined',
            user: client.user,
            room: room
        }, clientId);
        
        this.sendToClient(clientId, {
            type: 'joined-room',
            room: room,
            members: this.getRoomMembers(room)
        });
    }

    handleLeaveRoom(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client) return;
        
        const room = message.data.room;
        this.removeFromRoom(clientId, room);
    }

    handleClientMessage(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client || !client.authenticated) return;
        
        // Add sender info
        message.data.from = client.user;
        message.data.timestamp = Date.now();
        
        if (message.data.to) {
            // Direct message
            this.sendToUser(message.data.to, message.data);
        } else if (message.data.room) {
            // Room message
            this.broadcastToRoom(message.data.room, message.data);
        } else if (message.data.channel) {
            // Channel broadcast
            this.broadcastToChannel(message.data.channel, message.data);
        }
    }

    handleBroadcast(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client || !client.authenticated) return;
        
        // Check permissions
        if (!this.canBroadcast(client)) {
            this.sendError(clientId, 'Broadcast not allowed');
            return;
        }
        
        this.broadcastToAll(message.data, clientId);
        this.metrics.broadcasts++;
    }

    handleAcknowledgment(clientId, message) {
        const ackId = message.data.ackId;
        const pending = this.acknowledgments.get(ackId);
        
        if (pending) {
            clearTimeout(pending.timeout);
            this.acknowledgments.delete(ackId);
            pending.resolve();
        }
    }

    sendToClient(clientId, message, options = {}) {
        const client = this.clients.get(clientId);
        if (!client || client.ws.readyState !== WebSocket.OPEN) return false;
        
        try {
            const data = this.encodeMessage(message);
            
            if (options.reliable) {
                // Queue for reliable delivery
                const messageId = this.generateMessageId();
                this.queueMessage(clientId, messageId, data);
            } else {
                // Direct send
                client.ws.send(data);
                client.stats.bytes.sent += data.length;
                this.metrics.bandwidth.out += data.length;
            }
            
            return true;
        } catch (error) {
            this.handleError(clientId, error);
            return false;
        }
    }

    encodeMessage(message) {
        const json = JSON.stringify(message);
        
        if (this.config.enableBinary && json.length > this.config.compressionThreshold) {
            // Use binary encoding for large messages
            return this.encodeBinaryMessage(message);
        }
        
        return json;
    }

    encodeBinaryMessage(message) {
        const payload = Buffer.from(JSON.stringify(message.data || {}));
        const buffer = Buffer.allocUnsafe(5 + payload.length);
        
        const typeMap = {
            'auth-success': 10,
            'message': 11,
            'broadcast': 12,
            'update': 13
        };
        
        buffer.writeUInt8(typeMap[message.type] || 0, 0);
        buffer.writeUInt32BE(payload.length, 1);
        payload.copy(buffer, 5);
        
        return buffer;
    }

    broadcastToAll(message, excludeClient = null) {
        const data = this.encodeMessage({
            type: 'broadcast',
            data: message,
            timestamp: Date.now()
        });
        
        for (const [clientId, client] of this.clients) {
            if (clientId !== excludeClient && 
                client.authenticated && 
                client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(data);
                client.stats.bytes.sent += data.length;
            }
        }
        
        this.metrics.bandwidth.out += data.length * this.clients.size;
    }

    broadcastToRoom(room, message, excludeClient = null) {
        const members = this.rooms.get(room);
        if (!members) return;
        
        const data = this.encodeMessage({
            type: 'room-message',
            room: room,
            data: message,
            timestamp: Date.now()
        });
        
        for (const clientId of members) {
            if (clientId !== excludeClient) {
                this.sendRawToClient(clientId, data);
            }
        }
    }

    broadcastToChannel(channel, message) {
        const subscribers = this.subscriptions.get(channel);
        if (!subscribers) return;
        
        const data = this.encodeMessage({
            type: 'channel-update',
            channel: channel,
            data: message,
            timestamp: Date.now()
        });
        
        for (const clientId of subscribers) {
            this.sendRawToClient(clientId, data);
        }
    }

    sendRawToClient(clientId, data) {
        const client = this.clients.get(clientId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(data);
            client.stats.bytes.sent += data.length;
        }
    }

    queueMessage(clientId, messageId, data) {
        if (!this.messageQueue.has(clientId)) {
            this.messageQueue.set(clientId, []);
        }
        
        const queue = this.messageQueue.get(clientId);
        queue.push({
            id: messageId,
            data: data,
            timestamp: Date.now(),
            attempts: 0
        });
        
        this.processMessageQueue(clientId);
    }

    async processMessageQueue(clientId) {
        const queue = this.messageQueue.get(clientId);
        if (!queue || queue.length === 0) return;
        
        const client = this.clients.get(clientId);
        if (!client || client.ws.readyState !== WebSocket.OPEN) return;
        
        const message = queue[0];
        
        // Send with acknowledgment request
        const ackMessage = {
            ...JSON.parse(message.data),
            ackId: message.id
        };
        
        client.ws.send(JSON.stringify(ackMessage));
        
        // Wait for acknowledgment
        await this.waitForAcknowledgment(message.id, 5000);
        
        // Remove from queue
        queue.shift();
        
        // Process next message
        if (queue.length > 0) {
            setImmediate(() => this.processMessageQueue(clientId));
        }
    }

    waitForAcknowledgment(ackId, timeout) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.acknowledgments.delete(ackId);
                reject(new Error('Acknowledgment timeout'));
            }, timeout);
            
            this.acknowledgments.set(ackId, {
                resolve,
                reject,
                timeout: timer
            });
        });
    }

    startHeartbeat() {
        setInterval(() => {
            const now = Date.now();
            
            for (const [clientId, client] of this.clients) {
                if (client.ws.readyState === WebSocket.OPEN) {
                    // Send ping
                    client.ws.ping();
                    
                    // Check for timeout
                    if (now - client.lastPing > this.config.heartbeatInterval * 2) {
                        client.ws.terminate();
                    }
                }
            }
        }, this.config.heartbeatInterval);
    }

    handlePong(clientId) {
        const client = this.clients.get(clientId);
        if (client) {
            client.lastPing = Date.now();
        }
    }

    handleDisconnect(clientId, code, reason) {
        const client = this.clients.get(clientId);
        if (!client) return;
        
        // Remove from rooms
        for (const room of client.rooms) {
            this.removeFromRoom(clientId, room);
        }
        
        // Remove from subscriptions
        for (const channel of client.subscriptions) {
            const subscribers = this.subscriptions.get(channel);
            if (subscribers) {
                subscribers.delete(clientId);
            }
        }
        
        // Clean up
        this.clients.delete(clientId);
        this.messageQueue.delete(clientId);
        this.metrics.connections--;
        
        this.emit('client:disconnected', { 
            clientId, 
            code, 
            reason,
            duration: Date.now() - client.connected
        });
    }

    handleError(clientId, error) {
        this.metrics.errors++;
        this.emit('client:error', { clientId, error: error.message });
    }

    removeFromRoom(clientId, room) {
        const client = this.clients.get(clientId);
        if (!client) return;
        
        client.rooms.delete(room);
        
        const members = this.rooms.get(room);
        if (members) {
            members.delete(clientId);
            
            if (members.size === 0) {
                this.rooms.delete(room);
            } else {
                // Notify remaining members
                this.broadcastToRoom(room, {
                    type: 'user-left',
                    user: client.user,
                    room: room
                });
            }
        }
    }

    sendError(clientId, error) {
        this.sendToClient(clientId, {
            type: 'error',
            error: error
        });
    }

    async verifyAuth(data) {
        // Implement authentication logic
        return data.token === 'valid-token';
    }

    canBroadcast(client) {
        // Implement permission check
        return client.user?.role === 'admin';
    }

    getRoomMembers(room) {
        const members = this.rooms.get(room);
        if (!members) return [];
        
        return Array.from(members).map(clientId => {
            const client = this.clients.get(clientId);
            return client?.user;
        }).filter(Boolean);
    }

    generateClientId() {
        return crypto.randomBytes(16).toString('hex');
    }

    generateMessageId() {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    getStatus() {
        return {
            clients: this.clients.size,
            rooms: this.rooms.size,
            subscriptions: this.subscriptions.size,
            metrics: { ...this.metrics },
            uptime: process.uptime()
        };
    }

    async stop() {
        // Close all client connections
        for (const [clientId, client] of this.clients) {
            client.ws.close(1001, 'Server shutting down');
        }
        
        // Close WebSocket server
        return new Promise((resolve) => {
            this.wss.close(() => {
                this.server.close(() => {
                    this.emit('server:stopped');
                    resolve();
                });
            });
        });
    }
}

module.exports = RealtimeWebSocketServer;