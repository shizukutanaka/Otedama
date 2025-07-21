/**
 * Stratum V2 Protocol Implementation
 * Next-generation mining protocol with improved efficiency and security
 */

import { EventEmitter } from 'events';
import { createServer } from 'net';
import { randomBytes, createHash } from 'crypto';
import { Worker } from 'worker_threads';
import { getLogger } from '../../core/logger.js';

// Stratum V2 Message Types
const MessageType = {
    // Setup Connection
    SETUP_CONNECTION: 0x00,
    SETUP_CONNECTION_SUCCESS: 0x01,
    SETUP_CONNECTION_ERROR: 0x02,
    
    // Channel Management
    OPEN_STANDARD_MINING_CHANNEL: 0x10,
    OPEN_STANDARD_MINING_CHANNEL_SUCCESS: 0x11,
    OPEN_EXTENDED_MINING_CHANNEL: 0x12,
    OPEN_EXTENDED_MINING_CHANNEL_SUCCESS: 0x13,
    CLOSE_CHANNEL: 0x18,
    
    // Mining Protocol
    NEW_MINING_JOB: 0x1F,
    SET_NEW_PREV_HASH: 0x20,
    SET_TARGET: 0x21,
    SUBMIT_SHARES_STANDARD: 0x22,
    SUBMIT_SHARES_EXTENDED: 0x23,
    
    // Share Acknowledgments
    SHARE_ACCEPTED: 0x24,
    SHARE_REJECTED: 0x25,
    
    // Work Selection (Extended channels)
    SET_CUSTOM_MINING_JOB: 0x30,
    COMMIT_MINING_JOB: 0x31,
    
    // Group Channels
    OPEN_GROUP_CHANNEL: 0x40,
    UPDATE_CHANNEL: 0x41
};

// Stratum V2 Error Codes
const ErrorCode = {
    UNKNOWN: 0,
    TOO_MANY_CHANNELS: 1,
    INVALID_CHANNEL_ID: 2,
    DUPLICATE_CHANNEL_ID: 3,
    CHANNEL_NOT_FOUND: 4,
    INVALID_MESSAGE: 5,
    PROTOCOL_VERSION_MISMATCH: 6,
    UNAUTHORIZED: 7
};

export class StratumV2Server extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.logger = getLogger('StratumV2');
        this.options = {
            port: options.port || 3333,
            host: options.host || '0.0.0.0',
            protocolVersion: 2,
            minProtocolVersion: 2,
            maxChannelsPerConnection: options.maxChannelsPerConnection || 64,
            maxConnectionsPerIP: options.maxConnectionsPerIP || 4,
            jobTimeout: options.jobTimeout || 120000, // 2 minutes
            shareTimeout: options.shareTimeout || 5000, // 5 seconds
            enableGroupChannels: options.enableGroupChannels !== false,
            enableExtendedChannels: options.enableExtendedChannels !== false,
            enableEncryption: options.enableEncryption !== false,
            ...options
        };
        
        // Server state
        this.server = null;
        this.connections = new Map();
        this.channels = new Map();
        this.jobs = new Map();
        this.pendingShares = new Map();
        
        // Statistics
        this.stats = {
            connectionsTotal: 0,
            connectionsActive: 0,
            channelsTotal: 0,
            channelsActive: 0,
            sharesSubmitted: 0,
            sharesAccepted: 0,
            sharesRejected: 0,
            jobsSent: 0
        };
        
        // Security
        this.connectionLimits = new Map(); // IP -> connection count
        this.bannedIPs = new Set();
        
        // Job management
        this.currentJob = null;
        this.jobCounter = 0;
        this.jobHistory = [];
        
        // Noise protocol for encryption
        if (this.options.enableEncryption) {
            this.setupEncryption();
        }
    }
    
    /**
     * Start the Stratum V2 server
     */
    async start() {
        return new Promise((resolve, reject) => {
            this.server = createServer();
            
            this.server.on('connection', (socket) => {
                this.handleConnection(socket);
            });
            
            this.server.on('error', (error) => {
                this.logger.error('Server error:', error);
                this.emit('error', error);
                reject(error);
            });
            
            this.server.listen(this.options.port, this.options.host, () => {
                this.logger.info(`Stratum V2 server listening on ${this.options.host}:${this.options.port}`);
                this.emit('listening', {
                    host: this.options.host,
                    port: this.options.port
                });
                resolve();
            });
        });
    }
    
    /**
     * Handle new connection
     */
    handleConnection(socket) {
        const clientId = this.generateClientId();
        const clientIP = socket.remoteAddress;
        
        // Check connection limits
        if (!this.checkConnectionLimit(clientIP)) {
            this.logger.warn(`Connection limit exceeded for ${clientIP}`);
            socket.destroy();
            return;
        }
        
        // Create connection object
        const connection = {
            id: clientId,
            socket,
            ip: clientIP,
            channels: new Map(),
            authorized: false,
            protocolVersion: null,
            features: new Set(),
            created: Date.now(),
            lastActivity: Date.now(),
            stats: {
                sharesSubmitted: 0,
                sharesAccepted: 0,
                sharesRejected: 0
            }
        };
        
        this.connections.set(clientId, connection);
        this.stats.connectionsTotal++;
        this.stats.connectionsActive++;
        
        // Setup socket handlers
        socket.on('data', (data) => {
            this.handleData(connection, data);
        });
        
        socket.on('close', () => {
            this.handleDisconnection(connection);
        });
        
        socket.on('error', (error) => {
            this.logger.error(`Socket error for ${clientId}:`, error);
            this.handleDisconnection(connection);
        });
        
        // Set socket options
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30000);
        
        this.emit('connection', {
            clientId,
            ip: clientIP
        });
    }
    
    /**
     * Handle incoming data
     */
    handleData(connection, data) {
        try {
            connection.lastActivity = Date.now();
            
            // Parse Stratum V2 binary protocol
            const messages = this.parseMessages(data);
            
            for (const message of messages) {
                this.handleMessage(connection, message);
            }
        } catch (error) {
            this.logger.error('Error handling data:', error);
            this.sendError(connection, ErrorCode.INVALID_MESSAGE, error.message);
        }
    }
    
    /**
     * Handle individual message
     */
    async handleMessage(connection, message) {
        const { type, id, payload } = message;
        
        switch (type) {
            case MessageType.SETUP_CONNECTION:
                await this.handleSetupConnection(connection, id, payload);
                break;
                
            case MessageType.OPEN_STANDARD_MINING_CHANNEL:
                await this.handleOpenStandardChannel(connection, id, payload);
                break;
                
            case MessageType.OPEN_EXTENDED_MINING_CHANNEL:
                await this.handleOpenExtendedChannel(connection, id, payload);
                break;
                
            case MessageType.SUBMIT_SHARES_STANDARD:
                await this.handleSubmitSharesStandard(connection, id, payload);
                break;
                
            case MessageType.SUBMIT_SHARES_EXTENDED:
                await this.handleSubmitSharesExtended(connection, id, payload);
                break;
                
            case MessageType.CLOSE_CHANNEL:
                await this.handleCloseChannel(connection, id, payload);
                break;
                
            default:
                this.logger.warn(`Unknown message type: ${type}`);
                this.sendError(connection, ErrorCode.INVALID_MESSAGE, 'Unknown message type');
        }
    }
    
    /**
     * Handle setup connection request
     */
    async handleSetupConnection(connection, messageId, payload) {
        const { protocolVersion, minVersion, maxVersion, flags, endpoint } = payload;
        
        // Check protocol version compatibility
        if (maxVersion < this.options.minProtocolVersion ||
            minVersion > this.options.protocolVersion) {
            this.sendMessage(connection, MessageType.SETUP_CONNECTION_ERROR, messageId, {
                errorCode: ErrorCode.PROTOCOL_VERSION_MISMATCH,
                errorMessage: 'Protocol version not supported'
            });
            return;
        }
        
        // Negotiate protocol version
        connection.protocolVersion = Math.min(maxVersion, this.options.protocolVersion);
        connection.protocolVersion = Math.max(connection.protocolVersion, minVersion);
        
        // Set connection features based on flags
        if (flags & 0x01) connection.features.add('requires_fixed_time');
        if (flags & 0x02) connection.features.add('requires_work_selection');
        if (flags & 0x04) connection.features.add('requires_version_rolling');
        
        connection.authorized = true;
        
        // Send success response
        this.sendMessage(connection, MessageType.SETUP_CONNECTION_SUCCESS, messageId, {
            protocolVersion: connection.protocolVersion,
            flags: this.getServerFlags(),
            endpoint: this.options.host + ':' + this.options.port
        });
        
        this.emit('setup', {
            clientId: connection.id,
            protocolVersion: connection.protocolVersion,
            features: Array.from(connection.features)
        });
    }
    
    /**
     * Handle open standard mining channel
     */
    async handleOpenStandardChannel(connection, messageId, payload) {
        if (!connection.authorized) {
            this.sendError(connection, ErrorCode.UNAUTHORIZED, 'Setup connection first');
            return;
        }
        
        const { requestId, userIdentity, nominalHashrate, maxTarget } = payload;
        
        // Check channel limit
        if (connection.channels.size >= this.options.maxChannelsPerConnection) {
            this.sendError(connection, ErrorCode.TOO_MANY_CHANNELS, 'Channel limit exceeded');
            return;
        }
        
        // Create channel
        const channelId = this.generateChannelId();
        const channel = {
            id: channelId,
            type: 'standard',
            connectionId: connection.id,
            userIdentity,
            nominalHashrate,
            maxTarget: maxTarget || this.getDefaultTarget(),
            currentTarget: this.getInitialTarget(nominalHashrate),
            extranonce1: this.generateExtranonce1(),
            extranonce2Size: 4,
            created: Date.now(),
            stats: {
                sharesSubmitted: 0,
                sharesAccepted: 0,
                sharesRejected: 0,
                lastShareTime: null
            }
        };
        
        connection.channels.set(channelId, channel);
        this.channels.set(channelId, channel);
        this.stats.channelsTotal++;
        this.stats.channelsActive++;
        
        // Send success response
        this.sendMessage(connection, MessageType.OPEN_STANDARD_MINING_CHANNEL_SUCCESS, messageId, {
            requestId,
            channelId,
            target: channel.currentTarget,
            extranonce1: channel.extranonce1,
            extranonce2Size: channel.extranonce2Size,
            groupChannelId: 0 // Not using group channels for standard
        });
        
        // Send initial job
        this.sendNewJob(connection, channel);
        
        this.emit('channel:opened', {
            clientId: connection.id,
            channelId,
            type: 'standard',
            nominalHashrate
        });
    }
    
    /**
     * Handle submit shares standard
     */
    async handleSubmitSharesStandard(connection, messageId, payload) {
        const { channelId, sequence, jobId, nonce, ntime, version } = payload;
        
        const channel = connection.channels.get(channelId);
        if (!channel) {
            this.sendError(connection, ErrorCode.CHANNEL_NOT_FOUND, 'Channel not found');
            return;
        }
        
        // Validate job
        const job = this.jobs.get(jobId);
        if (!job) {
            this.sendShareRejected(connection, messageId, sequence, 'Job not found');
            return;
        }
        
        // Check if job is still valid
        if (Date.now() - job.created > this.options.jobTimeout) {
            this.sendShareRejected(connection, messageId, sequence, 'Job expired');
            return;
        }
        
        // Create share object
        const share = {
            channelId,
            jobId,
            nonce,
            ntime: ntime || job.ntime,
            version: version || job.version,
            extranonce1: channel.extranonce1,
            extranonce2: payload.extranonce2,
            submitted: Date.now()
        };
        
        // Validate share in worker thread
        const validation = await this.validateShare(share, job, channel);
        
        if (validation.valid) {
            channel.stats.sharesAccepted++;
            connection.stats.sharesAccepted++;
            this.stats.sharesAccepted++;
            channel.stats.lastShareTime = Date.now();
            
            // Send accepted
            this.sendMessage(connection, MessageType.SHARE_ACCEPTED, messageId, {
                channelId,
                sequence,
                newTarget: validation.newTarget || channel.currentTarget,
                newExtranonce1: validation.newExtranonce1
            });
            
            // Check if it's a block
            if (validation.isBlock) {
                this.emit('block:found', {
                    channelId,
                    jobId,
                    hash: validation.hash,
                    value: validation.value
                });
            }
            
            // Adjust difficulty if needed
            if (validation.newTarget) {
                channel.currentTarget = validation.newTarget;
                this.sendNewTarget(connection, channel);
            }
            
            this.emit('share:accepted', {
                clientId: connection.id,
                channelId,
                difficulty: validation.difficulty
            });
            
        } else {
            channel.stats.sharesRejected++;
            connection.stats.sharesRejected++;
            this.stats.sharesRejected++;
            
            this.sendShareRejected(connection, messageId, sequence, validation.reason);
            
            this.emit('share:rejected', {
                clientId: connection.id,
                channelId,
                reason: validation.reason
            });
        }
    }
    
    /**
     * Send new mining job
     */
    sendNewJob(connection, channel) {
        const job = this.createNewJob(channel);
        this.jobs.set(job.id, job);
        this.stats.jobsSent++;
        
        this.sendMessage(connection, MessageType.NEW_MINING_JOB, 0, {
            channelId: channel.id,
            jobId: job.id,
            futureJob: false,
            version: job.version,
            prevHash: job.prevHash,
            merkleRoot: job.merkleRoot,
            ntime: job.ntime,
            nbits: job.nbits
        });
        
        // Store job reference in channel
        channel.currentJobId = job.id;
    }
    
    /**
     * Create new mining job
     */
    createNewJob(channel) {
        const jobId = ++this.jobCounter;
        
        return {
            id: jobId,
            channelId: channel.id,
            version: 0x20000000, // Version 2 blocks
            prevHash: this.getCurrentBlockHash(),
            merkleRoot: this.calculateMerkleRoot(channel),
            ntime: Math.floor(Date.now() / 1000),
            nbits: this.targetToNBits(channel.currentTarget),
            extranonce1: channel.extranonce1,
            created: Date.now()
        };
    }
    
    /**
     * Validate share
     */
    async validateShare(share, job, channel) {
        return new Promise((resolve) => {
            const worker = new Worker('./lib/mining/workers/share-validator.js', {
                workerData: {
                    share,
                    job,
                    target: channel.currentTarget,
                    networkTarget: this.getNetworkTarget()
                }
            });
            
            worker.on('message', (result) => {
                resolve(result);
                worker.terminate();
            });
            
            worker.on('error', (error) => {
                this.logger.error('Share validation error:', error);
                resolve({
                    valid: false,
                    reason: 'Validation error'
                });
                worker.terminate();
            });
            
            // Timeout protection
            setTimeout(() => {
                worker.terminate();
                resolve({
                    valid: false,
                    reason: 'Validation timeout'
                });
            }, this.options.shareTimeout);
        });
    }
    
    /**
     * Parse Stratum V2 binary messages
     */
    parseMessages(data) {
        const messages = [];
        let offset = 0;
        
        while (offset < data.length) {
            // Read header (6 bytes)
            if (offset + 6 > data.length) break;
            
            const extension = data.readUInt16LE(offset);
            const type = data.readUInt8(offset + 2);
            const length = data.readUInt8(offset + 3) | 
                          (data.readUInt16LE(offset + 4) << 8);
            
            offset += 6;
            
            // Read payload
            if (offset + length > data.length) break;
            
            const payload = data.slice(offset, offset + length);
            offset += length;
            
            messages.push({
                extension,
                type,
                id: extension, // Message ID is in extension field
                payload: this.decodePayload(type, payload)
            });
        }
        
        return messages;
    }
    
    /**
     * Send message to client
     */
    sendMessage(connection, type, messageId, payload) {
        const encodedPayload = this.encodePayload(type, payload);
        const header = Buffer.alloc(6);
        
        header.writeUInt16LE(messageId, 0); // Extension/Message ID
        header.writeUInt8(type, 2);
        header.writeUInt8(encodedPayload.length & 0xFF, 3);
        header.writeUInt16LE(encodedPayload.length >> 8, 4);
        
        const message = Buffer.concat([header, encodedPayload]);
        
        try {
            connection.socket.write(message);
        } catch (error) {
            this.logger.error('Error sending message:', error);
            this.handleDisconnection(connection);
        }
    }
    
    /**
     * Handle disconnection
     */
    handleDisconnection(connection) {
        this.logger.info(`Client ${connection.id} disconnected`);
        
        // Clean up channels
        for (const [channelId, channel] of connection.channels) {
            this.channels.delete(channelId);
            this.stats.channelsActive--;
        }
        
        // Clean up connection
        this.connections.delete(connection.id);
        this.stats.connectionsActive--;
        
        // Update connection limits
        const currentCount = this.connectionLimits.get(connection.ip) || 0;
        if (currentCount > 0) {
            this.connectionLimits.set(connection.ip, currentCount - 1);
        }
        
        // Close socket if not already closed
        if (!connection.socket.destroyed) {
            connection.socket.destroy();
        }
        
        this.emit('disconnection', {
            clientId: connection.id,
            ip: connection.ip
        });
    }
    
    /**
     * Utility methods
     */
    
    generateClientId() {
        return randomBytes(16).toString('hex');
    }
    
    generateChannelId() {
        return Math.floor(Math.random() * 0xFFFFFFFF);
    }
    
    generateExtranonce1() {
        return randomBytes(4).toString('hex');
    }
    
    checkConnectionLimit(ip) {
        const current = this.connectionLimits.get(ip) || 0;
        if (current >= this.options.maxConnectionsPerIP) {
            return false;
        }
        this.connectionLimits.set(ip, current + 1);
        return true;
    }
    
    getServerFlags() {
        let flags = 0;
        if (this.options.enableGroupChannels) flags |= 0x01;
        if (this.options.enableExtendedChannels) flags |= 0x02;
        return flags;
    }
    
    /**
     * Shutdown the server
     */
    async shutdown() {
        this.logger.info('Shutting down Stratum V2 server...');
        
        // Close all connections
        for (const connection of this.connections.values()) {
            connection.socket.end();
        }
        
        // Close server
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    this.logger.info('Stratum V2 server shut down');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }
}

export default StratumV2Server;