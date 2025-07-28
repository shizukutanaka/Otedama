const { EventEmitter } = require('events');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

class StratumV2Client extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            host: options.host || 'pool.example.com',
            port: options.port || 3334,
            ssl: options.ssl || false,
            username: options.username || 'anonymous',
            password: options.password || 'x',
            reconnectDelay: options.reconnectDelay || 5000,
            maxReconnectAttempts: options.maxReconnectAttempts || 10,
            timeout: options.timeout || 30000,
            ...options
        };
        
        this.connection = null;
        this.messageId = 0;
        this.pendingRequests = new Map();
        this.currentJob = null;
        this.extraNonce1 = null;
        this.extraNonce2Size = null;
        this.difficulty = 1;
        this.reconnectAttempts = 0;
        
        // Stratum V2 specific
        this.sessionId = null;
        this.channelId = null;
        this.setupConnection = null;
        this.noise = null;
        
        // Performance tracking
        this.stats = {
            connected: false,
            authorized: false,
            jobsReceived: 0,
            sharesSubmitted: 0,
            sharesAccepted: 0,
            sharesRejected: 0,
            lastShare: null,
            startTime: Date.now()
        };
    }

    async connect() {
        try {
            this.emit('connecting', { host: this.config.host, port: this.config.port });
            
            if (this.config.ssl) {
                this.connection = tls.connect({
                    host: this.config.host,
                    port: this.config.port,
                    rejectUnauthorized: false
                });
            } else {
                this.connection = net.createConnection({
                    host: this.config.host,
                    port: this.config.port
                });
            }
            
            this.setupConnectionHandlers();
            
            await this.waitForConnection();
            
            // Initialize Stratum V2 protocol
            await this.initializeStratumV2();
            
            this.stats.connected = true;
            this.reconnectAttempts = 0;
            
            this.emit('connected');
            
            // Subscribe and authorize
            await this.subscribe();
            await this.authorize();
            
        } catch (error) {
            this.emit('error', error);
            this.handleReconnect();
        }
    }

    setupConnectionHandlers() {
        let buffer = Buffer.alloc(0);
        
        this.connection.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);
            
            // Stratum V2 uses binary protocol
            while (buffer.length >= 6) { // Header size
                const header = this.parseHeader(buffer);
                
                if (buffer.length < header.length) {
                    break; // Wait for complete message
                }
                
                const message = buffer.slice(0, header.length);
                buffer = buffer.slice(header.length);
                
                this.handleMessage(message);
            }
        });
        
        this.connection.on('close', () => {
            this.stats.connected = false;
            this.emit('disconnected');
            this.handleReconnect();
        });
        
        this.connection.on('error', (error) => {
            this.emit('error', error);
        });
        
        this.connection.setTimeout(this.config.timeout);
        
        this.connection.on('timeout', () => {
            this.emit('timeout');
            this.connection.destroy();
        });
    }

    parseHeader(buffer) {
        // Stratum V2 header format
        const extension = buffer.readUInt16LE(0);
        const messageType = buffer.readUInt8(2);
        const messageLength = buffer.readUInt32LE(3) & 0xFFFFFF; // 24 bits
        
        return {
            extension,
            messageType,
            length: messageLength + 6 // Include header
        };
    }

    async initializeStratumV2() {
        // Setup Noise protocol for encrypted communication
        this.noise = this.createNoiseHandshake();
        
        // Send SetupConnection message
        await this.sendSetupConnection();
        
        // Wait for SetupConnection.Success
        await this.waitForSetupSuccess();
        
        // Open standard mining channel
        await this.openStandardMiningChannel();
    }

    createNoiseHandshake() {
        // Simplified Noise protocol implementation
        return {
            localKeyPair: crypto.generateKeyPairSync('x25519'),
            remotePublicKey: null,
            handshakeHash: crypto.createHash('sha256'),
            
            processHandshake: (data) => {
                // Process Noise handshake
                return data;
            },
            
            encrypt: (data) => {
                // Encrypt outgoing data
                return data;
            },
            
            decrypt: (data) => {
                // Decrypt incoming data
                return data;
            }
        };
    }

    async sendSetupConnection() {
        const flags = 0x01 | 0x02; // REQUIRES_STANDARD_JOBS | REQUIRES_WORK_SELECTION
        const message = {
            protocol: 2,
            minVersion: 2,
            maxVersion: 2,
            flags,
            endpointHost: this.config.host,
            endpointPort: this.config.port,
            vendor: 'Otedama',
            hardwareVersion: '1.0',
            firmwareVersion: '1.0',
            deviceId: crypto.randomBytes(32).toString('hex')
        };
        
        await this.sendMessage('SetupConnection', message);
    }

    async openStandardMiningChannel() {
        const message = {
            requestId: this.getNextMessageId(),
            userIdentity: this.config.username,
            nominalHashRate: 1000000000000, // 1 TH/s
            maxTarget: Buffer.alloc(32, 0xFF)
        };
        
        const response = await this.sendRequest('OpenStandardMiningChannel', message);
        
        this.channelId = response.channelId;
        this.emit('channel:opened', { channelId: this.channelId });
    }

    async sendMessage(messageType, data) {
        const messageId = this.getMessageTypeId(messageType);
        const payload = this.serializeMessage(data);
        
        const header = Buffer.alloc(6);
        header.writeUInt16LE(0, 0); // No extension
        header.writeUInt8(messageId, 2);
        header.writeUInt32LE(payload.length, 3);
        
        const message = Buffer.concat([header, payload]);
        
        // Apply Noise encryption if established
        const encrypted = this.noise ? this.noise.encrypt(message) : message;
        
        this.connection.write(encrypted);
    }

    async sendRequest(messageType, data) {
        const requestId = data.requestId || this.getNextMessageId();
        data.requestId = requestId;
        
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(requestId, { resolve, reject });
            
            this.sendMessage(messageType, data).catch(reject);
            
            // Timeout after 30 seconds
            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('Request timeout'));
                }
            }, 30000);
        });
    }

    getMessageTypeId(messageType) {
        const messageTypes = {
            'SetupConnection': 0x00,
            'SetupConnection.Success': 0x01,
            'SetupConnection.Error': 0x02,
            'OpenStandardMiningChannel': 0x10,
            'OpenStandardMiningChannel.Success': 0x11,
            'OpenMiningChannel.Error': 0x12,
            'UpdateChannel': 0x13,
            'UpdateChannel.Error': 0x14,
            'CloseChannel': 0x18,
            'SetExtranoncePrefix': 0x19,
            'SubmitSharesStandard': 0x1a,
            'SubmitShares.Success': 0x1b,
            'SubmitShares.Error': 0x1c,
            'NewMiningJob': 0x1e,
            'SetNewPrevHash': 0x1f,
            'SetTarget': 0x20
        };
        
        return messageTypes[messageType] || 0xFF;
    }

    serializeMessage(data) {
        // Simplified serialization - in production use proper Stratum V2 serialization
        return Buffer.from(JSON.stringify(data));
    }

    deserializeMessage(buffer, messageType) {
        // Simplified deserialization
        try {
            return JSON.parse(buffer.toString());
        } catch {
            return buffer;
        }
    }

    handleMessage(message) {
        const header = this.parseHeader(message);
        const payload = message.slice(6);
        
        // Decrypt if Noise is established
        const decrypted = this.noise ? this.noise.decrypt(payload) : payload;
        
        const messageType = this.getMessageTypeName(header.messageType);
        const data = this.deserializeMessage(decrypted, messageType);
        
        this.emit('message', { type: messageType, data });
        
        // Handle specific message types
        switch (messageType) {
            case 'SetupConnection.Success':
                this.handleSetupSuccess(data);
                break;
                
            case 'OpenStandardMiningChannel.Success':
                this.handleChannelOpened(data);
                break;
                
            case 'NewMiningJob':
                this.handleNewJob(data);
                break;
                
            case 'SetTarget':
                this.handleSetTarget(data);
                break;
                
            case 'SubmitShares.Success':
                this.handleShareAccepted(data);
                break;
                
            case 'SubmitShares.Error':
                this.handleShareRejected(data);
                break;
        }
        
        // Handle responses to requests
        if (data.requestId && this.pendingRequests.has(data.requestId)) {
            const pending = this.pendingRequests.get(data.requestId);
            this.pendingRequests.delete(data.requestId);
            
            if (messageType.includes('.Error')) {
                pending.reject(new Error(data.errorCode || 'Request failed'));
            } else {
                pending.resolve(data);
            }
        }
    }

    getMessageTypeName(typeId) {
        const typeNames = {
            0x00: 'SetupConnection',
            0x01: 'SetupConnection.Success',
            0x02: 'SetupConnection.Error',
            0x10: 'OpenStandardMiningChannel',
            0x11: 'OpenStandardMiningChannel.Success',
            0x12: 'OpenMiningChannel.Error',
            0x1a: 'SubmitSharesStandard',
            0x1b: 'SubmitShares.Success',
            0x1c: 'SubmitShares.Error',
            0x1e: 'NewMiningJob',
            0x1f: 'SetNewPrevHash',
            0x20: 'SetTarget'
        };
        
        return typeNames[typeId] || `Unknown(${typeId})`;
    }

    handleSetupSuccess(data) {
        this.sessionId = data.sessionId;
        this.emit('setup:success', data);
    }

    handleChannelOpened(data) {
        this.channelId = data.channelId;
        this.extraNonce1 = data.extranonce_prefix;
        this.extraNonce2Size = data.extranonce_size;
        
        this.emit('channel:opened', data);
    }

    handleNewJob(data) {
        this.currentJob = {
            jobId: data.job_id,
            prevHash: data.prev_hash,
            coinbasePrefix: data.coinbase_prefix,
            coinbaseSuffix: data.coinbase_suffix,
            merklePath: data.merkle_path,
            version: data.version,
            nbits: data.nbits,
            ntime: data.ntime,
            cleanJobs: data.clean_jobs || false,
            futureJob: data.future_job || false
        };
        
        this.stats.jobsReceived++;
        
        this.emit('job', this.currentJob);
    }

    handleSetTarget(data) {
        this.difficulty = this.targetToDifficulty(data.maximum_target);
        this.emit('difficulty', this.difficulty);
    }

    handleShareAccepted(data) {
        this.stats.sharesAccepted++;
        this.stats.lastShare = Date.now();
        
        this.emit('share:accepted', {
            jobId: data.job_id,
            sequenceNumber: data.sequence_number
        });
    }

    handleShareRejected(data) {
        this.stats.sharesRejected++;
        
        this.emit('share:rejected', {
            jobId: data.job_id,
            sequenceNumber: data.sequence_number,
            errorCode: data.error_code
        });
    }

    async submitShare(nonce, ntime, extranonce2) {
        if (!this.currentJob || !this.channelId) {
            throw new Error('No active job or channel');
        }
        
        const share = {
            channelId: this.channelId,
            sequenceNumber: this.getNextSequenceNumber(),
            jobId: this.currentJob.jobId,
            nonce,
            ntime,
            version: this.currentJob.version
        };
        
        this.stats.sharesSubmitted++;
        
        await this.sendMessage('SubmitSharesStandard', share);
    }

    async subscribe() {
        // Stratum V2 doesn't have explicit subscribe, handled in channel opening
        this.emit('subscribed');
    }

    async authorize() {
        // Authorization is part of channel opening in Stratum V2
        this.stats.authorized = true;
        this.emit('authorized');
    }

    targetToDifficulty(target) {
        if (typeof target === 'string') {
            target = Buffer.from(target, 'hex');
        }
        
        const max = Buffer.from('00000000ffff0000000000000000000000000000000000000000000000000000', 'hex');
        const targetNum = BigInt('0x' + target.toString('hex'));
        const maxNum = BigInt('0x' + max.toString('hex'));
        
        return Number(maxNum / targetNum);
    }

    waitForConnection() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, this.config.timeout);
            
            this.connection.once('connect', () => {
                clearTimeout(timeout);
                resolve();
            });
            
            this.connection.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });
    }

    waitForSetupSuccess() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Setup timeout'));
            }, 10000);
            
            this.once('setup:success', (data) => {
                clearTimeout(timeout);
                resolve(data);
            });
        });
    }

    handleReconnect() {
        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            this.emit('max-reconnects');
            return;
        }
        
        this.reconnectAttempts++;
        
        setTimeout(() => {
            this.emit('reconnecting', { attempt: this.reconnectAttempts });
            this.connect();
        }, this.config.reconnectDelay);
    }

    getNextMessageId() {
        return ++this.messageId;
    }

    getNextSequenceNumber() {
        return Date.now(); // Simplified - should maintain proper sequence
    }

    disconnect() {
        if (this.connection) {
            this.connection.destroy();
            this.connection = null;
        }
        
        this.pendingRequests.clear();
        this.currentJob = null;
        this.stats.connected = false;
        this.stats.authorized = false;
    }

    getStatistics() {
        const uptime = Date.now() - this.stats.startTime;
        const acceptRate = this.stats.sharesSubmitted > 0 ? 
            (this.stats.sharesAccepted / this.stats.sharesSubmitted) * 100 : 0;
        
        return {
            ...this.stats,
            uptime,
            acceptRate,
            sharesPerMinute: (this.stats.sharesSubmitted / (uptime / 60000)).toFixed(2)
        };
    }
}

module.exports = StratumV2Client;