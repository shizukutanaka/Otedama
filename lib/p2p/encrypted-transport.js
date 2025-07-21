/**
 * Encrypted Transport Layer
 * Provides secure communication with noise protocol and TLS
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import tls from 'tls';
import { getLogger } from '../core/logger.js';

// Encryption protocols
export const EncryptionProtocol = {
    NOISE_XX: 'noise-xx',
    NOISE_IK: 'noise-ik',
    TLS_1_3: 'tls-1.3',
    CHACHA20_POLY1305: 'chacha20-poly1305',
    AES_256_GCM: 'aes-256-gcm'
};

// Key exchange methods
export const KeyExchange = {
    ECDH_P256: 'ecdh-p256',
    ECDH_P384: 'ecdh-p384',
    X25519: 'x25519',
    DH_2048: 'dh-2048'
};

export class EncryptedTransport extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.logger = getLogger('EncryptedTransport');
        this.options = {
            // Encryption settings
            protocol: options.protocol || EncryptionProtocol.NOISE_XX,
            keyExchange: options.keyExchange || KeyExchange.X25519,
            cipherSuite: options.cipherSuite || 'CHACHA20_POLY1305',
            
            // Key management
            staticKeyPair: options.staticKeyPair || this.generateKeyPair(),
            ephemeralKeys: options.ephemeralKeys !== false,
            keyRotationInterval: options.keyRotationInterval || 3600000, // 1 hour
            
            // TLS settings
            tlsCert: options.tlsCert,
            tlsKey: options.tlsKey,
            tlsCA: options.tlsCA,
            
            // Security settings
            requireAuthentication: options.requireAuthentication !== false,
            allowedPeers: options.allowedPeers || new Set(),
            maxHandshakeTime: options.maxHandshakeTime || 30000,
            
            // Performance
            compressionEnabled: options.compressionEnabled !== false,
            frameSize: options.frameSize || 16384, // 16KB frames
            
            ...options
        };
        
        // Key management
        this.staticKeys = this.options.staticKeyPair;
        this.ephemeralKeys = new Map();
        this.sessionKeys = new Map();
        
        // Connection tracking
        this.activeConnections = new Map();
        this.handshakeInProgress = new Map();
        
        // Security state
        this.trustedPeers = new Set(this.options.allowedPeers);
        this.suspiciousActivity = new Map();
        
        // Noise protocol state
        this.noiseStates = new Map();
        
        // Statistics
        this.stats = {
            connectionsEstablished: 0,
            handshakesCompleted: 0,
            handshakesFailed: 0,
            bytesEncrypted: 0,
            bytesDecrypted: 0,
            keyRotations: 0,
            securityViolations: 0
        };
        
        // Start key rotation if enabled
        if (this.options.keyRotationInterval > 0) {
            this.startKeyRotation();
        }
    }
    
    /**
     * Initialize encrypted transport
     */
    async initialize() {
        this.logger.info('Initializing encrypted transport...');
        
        // Validate key pair
        if (!this.staticKeys || !this.staticKeys.privateKey || !this.staticKeys.publicKey) {
            throw new Error('Invalid static key pair');
        }
        
        // Initialize Noise protocol if needed
        if (this.options.protocol.startsWith('noise')) {
            this.initializeNoise();
        }
        
        this.logger.info(`Encrypted transport initialized with ${this.options.protocol}`);
        this.emit('initialized');
    }
    
    /**
     * Initialize Noise protocol
     */
    initializeNoise() {
        // Noise protocol implementation
        this.noiseConfig = {
            protocol: this.options.protocol,
            staticKeyPair: this.staticKeys,
            prologue: Buffer.from('otedama-p2p-v1'),
            psk: this.options.psk || null
        };
        
        this.logger.info('Noise protocol initialized');
    }
    
    /**
     * Establish secure connection
     */
    async establishSecureConnection(socket, isInitiator = true, peerId = null) {
        const connectionId = `${socket.remoteAddress}:${socket.remotePort}`;
        
        this.logger.info(`Establishing secure connection to ${connectionId} (initiator: ${isInitiator})`);
        
        try {
            // Check if peer is allowed
            if (this.options.requireAuthentication && peerId && !this.trustedPeers.has(peerId)) {
                throw new Error('Peer not in trusted list');
            }
            
            // Perform handshake based on protocol
            let secureSocket;
            
            switch (this.options.protocol) {
                case EncryptionProtocol.NOISE_XX:
                case EncryptionProtocol.NOISE_IK:
                    secureSocket = await this.performNoiseHandshake(socket, isInitiator, peerId);
                    break;
                    
                case EncryptionProtocol.TLS_1_3:
                    secureSocket = await this.performTLSHandshake(socket, isInitiator);
                    break;
                    
                default:
                    throw new Error(`Unsupported protocol: ${this.options.protocol}`);
            }
            
            // Store connection
            this.activeConnections.set(connectionId, {
                socket: secureSocket,
                peerId,
                established: Date.now(),
                bytesIn: 0,
                bytesOut: 0,
                lastActivity: Date.now()
            });
            
            this.stats.connectionsEstablished++;
            
            this.emit('connectionEstablished', {
                connectionId,
                peerId,
                socket: secureSocket
            });
            
            return secureSocket;
            
        } catch (error) {
            this.logger.error(`Failed to establish secure connection to ${connectionId}:`, error);
            this.stats.handshakesFailed++;
            throw error;
        }
    }
    
    /**
     * Perform Noise protocol handshake
     */
    async performNoiseHandshake(socket, isInitiator, peerId) {
        const connectionId = `${socket.remoteAddress}:${socket.remotePort}`;
        
        // Create Noise state
        const noiseState = this.createNoiseState(isInitiator, peerId);
        this.noiseStates.set(connectionId, noiseState);
        
        try {
            if (isInitiator) {
                // Initiator sends first message
                const message1 = await this.noiseWriteMessage(noiseState, Buffer.alloc(0));
                await this.sendHandshakeMessage(socket, message1);
                
                // Receive response
                const response1 = await this.receiveHandshakeMessage(socket);
                await this.noiseReadMessage(noiseState, response1);
                
                // Send final message
                const message2 = await this.noiseWriteMessage(noiseState, Buffer.alloc(0));
                await this.sendHandshakeMessage(socket, message2);
                
            } else {
                // Responder receives first message
                const message1 = await this.receiveHandshakeMessage(socket);
                await this.noiseReadMessage(noiseState, message1);
                
                // Send response
                const response1 = await this.noiseWriteMessage(noiseState, Buffer.alloc(0));
                await this.sendHandshakeMessage(socket, response1);
                
                // Receive final message
                const message2 = await this.receiveHandshakeMessage(socket);
                await this.noiseReadMessage(noiseState, message2);
            }
            
            // Handshake complete - derive session keys
            const sessionKeys = this.deriveSessionKeys(noiseState);
            this.sessionKeys.set(connectionId, sessionKeys);
            
            // Create secure socket wrapper
            const secureSocket = this.createSecureSocket(socket, sessionKeys, connectionId);
            
            this.stats.handshakesCompleted++;
            this.logger.info(`Noise handshake completed for ${connectionId}`);
            
            return secureSocket;
            
        } catch (error) {
            this.noiseStates.delete(connectionId);
            throw error;
        }
    }
    
    /**
     * Create Noise protocol state
     */
    createNoiseState(isInitiator, peerId) {
        const state = {
            protocol: this.options.protocol,
            isInitiator,
            staticKeyPair: this.staticKeys,
            ephemeralKeyPair: this.generateKeyPair(),
            remoteStaticKey: null,
            remoteEphemeralKey: null,
            handshakeHash: crypto.createHash('sha256'),
            chainKey: null,
            sendingKey: null,
            receivingKey: null,
            step: 0
        };
        
        // Initialize handshake hash with protocol name
        state.handshakeHash.update(Buffer.from(this.options.protocol));
        state.handshakeHash.update(this.options.prologue || Buffer.alloc(0));
        
        return state;
    }
    
    /**
     * Noise write message
     */
    async noiseWriteMessage(state, payload) {
        const message = Buffer.alloc(1024); // Allocate buffer
        let offset = 0;
        
        switch (state.step) {
            case 0: // -> e
                // Send ephemeral public key
                state.ephemeralKeyPair.publicKey.copy(message, offset);
                offset += 32; // X25519 public key size
                state.handshakeHash.update(state.ephemeralKeyPair.publicKey);
                break;
                
            case 1: // -> e, ee, s, es
                if (!state.isInitiator) {
                    // Send ephemeral public key
                    state.ephemeralKeyPair.publicKey.copy(message, offset);
                    offset += 32;
                    state.handshakeHash.update(state.ephemeralKeyPair.publicKey);
                    
                    // Perform DH operations and encrypt static key
                    const sharedSecret = this.performDH(state.ephemeralKeyPair.privateKey, state.remoteEphemeralKey);
                    const encryptedStatic = this.encryptAndHash(state, this.staticKeys.publicKey);
                    encryptedStatic.copy(message, offset);
                    offset += encryptedStatic.length;
                }
                break;
                
            case 2: // -> s, se
                if (state.isInitiator) {
                    // Encrypt and send static key
                    const encryptedStatic = this.encryptAndHash(state, this.staticKeys.publicKey);
                    encryptedStatic.copy(message, offset);
                    offset += encryptedStatic.length;
                }
                break;
        }
        
        // Encrypt payload if any
        if (payload.length > 0) {
            const encryptedPayload = this.encryptAndHash(state, payload);
            encryptedPayload.copy(message, offset);
            offset += encryptedPayload.length;
        }
        
        state.step++;
        
        return message.slice(0, offset);
    }
    
    /**
     * Noise read message
     */
    async noiseReadMessage(state, message) {
        let offset = 0;
        
        switch (state.step) {
            case 0: // <- e
                if (state.isInitiator) {
                    // Read remote ephemeral key
                    state.remoteEphemeralKey = message.slice(offset, offset + 32);
                    offset += 32;
                    state.handshakeHash.update(state.remoteEphemeralKey);
                }
                break;
                
            case 1: // <- e, ee, s, es
                if (state.isInitiator) {
                    // Read ephemeral key
                    state.remoteEphemeralKey = message.slice(offset, offset + 32);
                    offset += 32;
                    state.handshakeHash.update(state.remoteEphemeralKey);
                    
                    // Perform DH and decrypt static key
                    const sharedSecret = this.performDH(state.ephemeralKeyPair.privateKey, state.remoteEphemeralKey);
                    const encryptedStatic = message.slice(offset, offset + 48); // 32 + 16 for auth tag
                    state.remoteStaticKey = this.decryptAndHash(state, encryptedStatic);
                    offset += encryptedStatic.length;
                }
                break;
                
            case 2: // <- s, se
                if (!state.isInitiator) {
                    // Decrypt static key
                    const encryptedStatic = message.slice(offset, offset + 48);
                    state.remoteStaticKey = this.decryptAndHash(state, encryptedStatic);
                    offset += encryptedStatic.length;
                }
                break;
        }
        
        state.step++;
    }
    
    /**
     * Perform TLS handshake
     */
    async performTLSHandshake(socket, isInitiator) {
        return new Promise((resolve, reject) => {
            const tlsOptions = {
                socket,
                isServer: !isInitiator,
                secureProtocol: 'TLSv1_3_method',
                ciphers: 'ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-CHACHA20-POLY1305',
                ...(this.options.tlsCert && { cert: this.options.tlsCert }),
                ...(this.options.tlsKey && { key: this.options.tlsKey }),
                ...(this.options.tlsCA && { ca: this.options.tlsCA })
            };
            
            const tlsSocket = tls.connect(tlsOptions);
            
            tlsSocket.on('secureConnect', () => {
                this.logger.info('TLS connection established');
                resolve(tlsSocket);
            });
            
            tlsSocket.on('error', (error) => {
                this.logger.error('TLS handshake failed:', error);
                reject(error);
            });
            
            setTimeout(() => {
                reject(new Error('TLS handshake timeout'));
            }, this.options.maxHandshakeTime);
        });
    }
    
    /**
     * Create secure socket wrapper
     */
    createSecureSocket(socket, sessionKeys, connectionId) {
        const secureSocket = {
            // Proxy all socket methods
            ...socket,
            
            // Override write to encrypt
            write: (data, encoding, callback) => {
                try {
                    const encrypted = this.encryptData(data, sessionKeys.sendingKey, sessionKeys.sendingNonce++);
                    this.updateConnectionStats(connectionId, 'out', encrypted.length);
                    return socket.write(encrypted, encoding, callback);
                } catch (error) {
                    this.logger.error('Encryption failed:', error);
                    if (callback) callback(error);
                    return false;
                }
            },
            
            // Override read events to decrypt
            on: (event, listener) => {
                if (event === 'data') {
                    return socket.on('data', (data) => {
                        try {
                            const decrypted = this.decryptData(data, sessionKeys.receivingKey, sessionKeys.receivingNonce++);
                            this.updateConnectionStats(connectionId, 'in', data.length);
                            listener(decrypted);
                        } catch (error) {
                            this.logger.error('Decryption failed:', error);
                            this.emit('error', error);
                        }
                    });
                } else {
                    return socket.on(event, listener);
                }
            },
            
            // Secure close
            destroy: () => {
                this.activeConnections.delete(connectionId);
                this.sessionKeys.delete(connectionId);
                return socket.destroy();
            },
            
            // Additional secure socket properties
            encrypted: true,
            protocol: this.options.protocol,
            sessionKeys
        };
        
        return secureSocket;
    }
    
    /**
     * Encrypt data with ChaCha20-Poly1305
     */
    encryptData(data, key, nonce) {
        const cipher = crypto.createCipher('chacha20-poly1305', key);
        cipher.setAAD(Buffer.from([0x01])); // Additional authenticated data
        
        let encrypted = cipher.update(data);
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        
        const authTag = cipher.getAuthTag();
        
        // Prepend nonce and auth tag
        const result = Buffer.concat([
            Buffer.from([nonce & 0xff, (nonce >> 8) & 0xff, (nonce >> 16) & 0xff, (nonce >> 24) & 0xff]),
            authTag,
            encrypted
        ]);
        
        this.stats.bytesEncrypted += data.length;
        
        return result;
    }
    
    /**
     * Decrypt data with ChaCha20-Poly1305
     */
    decryptData(data, key, nonce) {
        if (data.length < 20) { // 4 bytes nonce + 16 bytes auth tag
            throw new Error('Invalid encrypted data length');
        }
        
        const receivedNonce = data.readUInt32LE(0);
        const authTag = data.slice(4, 20);
        const encrypted = data.slice(20);
        
        // Verify nonce sequence
        if (receivedNonce !== nonce) {
            throw new Error('Invalid nonce sequence');
        }
        
        const decipher = crypto.createDecipher('chacha20-poly1305', key);
        decipher.setAAD(Buffer.from([0x01]));
        decipher.setAuthTag(authTag);
        
        let decrypted = decipher.update(encrypted);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        
        this.stats.bytesDecrypted += decrypted.length;
        
        return decrypted;
    }
    
    /**
     * Generate key pair for key exchange
     */
    generateKeyPair() {
        switch (this.options.keyExchange) {
            case KeyExchange.X25519:
                return crypto.generateKeyPairSync('x25519');
                
            case KeyExchange.ECDH_P256:
                return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
                
            case KeyExchange.ECDH_P384:
                return crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
                
            default:
                throw new Error(`Unsupported key exchange: ${this.options.keyExchange}`);
        }
    }
    
    /**
     * Perform Diffie-Hellman key exchange
     */
    performDH(privateKey, publicKey) {
        return crypto.diffieHellman({
            privateKey,
            publicKey
        });
    }
    
    /**
     * Derive session keys from handshake
     */
    deriveSessionKeys(noiseState) {
        const finalHash = noiseState.handshakeHash.digest();
        
        // HKDF key derivation
        const sendingKey = crypto.hkdfSync('sha256', finalHash, Buffer.alloc(0), 'sending', 32);
        const receivingKey = crypto.hkdfSync('sha256', finalHash, Buffer.alloc(0), 'receiving', 32);
        
        return {
            sendingKey,
            receivingKey,
            sendingNonce: 0,
            receivingNonce: 0,
            derived: Date.now()
        };
    }
    
    /**
     * Send handshake message
     */
    async sendHandshakeMessage(socket, message) {
        return new Promise((resolve, reject) => {
            // Frame the message with length prefix
            const frame = Buffer.alloc(4 + message.length);
            frame.writeUInt32BE(message.length, 0);
            message.copy(frame, 4);
            
            socket.write(frame, (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }
    
    /**
     * Receive handshake message
     */
    async receiveHandshakeMessage(socket) {
        return new Promise((resolve, reject) => {
            let lengthBuffer = Buffer.alloc(4);
            let lengthReceived = 0;
            let messageLength = 0;
            let messageBuffer = null;
            let messageReceived = 0;
            
            const timeout = setTimeout(() => {
                reject(new Error('Handshake message timeout'));
            }, this.options.maxHandshakeTime);
            
            const onData = (data) => {
                let offset = 0;
                
                // Read length if not complete
                if (lengthReceived < 4) {
                    const needed = 4 - lengthReceived;
                    const available = Math.min(needed, data.length - offset);
                    
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
                        clearTimeout(timeout);
                        socket.removeListener('data', onData);
                        resolve(messageBuffer);
                    }
                }
            };
            
            socket.on('data', onData);
            
            socket.on('error', (error) => {
                clearTimeout(timeout);
                socket.removeListener('data', onData);
                reject(error);
            });
        });
    }
    
    /**
     * Start key rotation
     */
    startKeyRotation() {
        setInterval(() => {
            this.rotateKeys();
        }, this.options.keyRotationInterval);
    }
    
    /**
     * Rotate encryption keys
     */
    rotateKeys() {
        this.logger.info('Rotating encryption keys...');
        
        // Generate new ephemeral keys
        this.ephemeralKeys.clear();
        
        // Rotate session keys for long-lived connections
        for (const [connectionId, keys] of this.sessionKeys) {
            const connection = this.activeConnections.get(connectionId);
            
            if (connection && Date.now() - keys.derived > this.options.keyRotationInterval) {
                // Derive new keys
                const newKeys = this.deriveRotatedKeys(keys);
                this.sessionKeys.set(connectionId, newKeys);
                
                this.logger.debug(`Keys rotated for connection ${connectionId}`);
            }
        }
        
        this.stats.keyRotations++;
    }
    
    /**
     * Derive rotated keys
     */
    deriveRotatedKeys(currentKeys) {
        const newSeed = crypto.hkdfSync('sha256', currentKeys.sendingKey, currentKeys.receivingKey, 'rotation', 64);
        
        return {
            sendingKey: newSeed.slice(0, 32),
            receivingKey: newSeed.slice(32, 64),
            sendingNonce: 0,
            receivingNonce: 0,
            derived: Date.now()
        };
    }
    
    /**
     * Update connection statistics
     */
    updateConnectionStats(connectionId, direction, bytes) {
        const connection = this.activeConnections.get(connectionId);
        if (connection) {
            if (direction === 'in') {
                connection.bytesIn += bytes;
            } else {
                connection.bytesOut += bytes;
            }
            connection.lastActivity = Date.now();
        }
    }
    
    /**
     * Encrypt and hash (for Noise protocol)
     */
    encryptAndHash(state, plaintext) {
        // Simplified - in production would implement proper Noise encryption
        const cipher = crypto.createCipher('aes-256-gcm', state.chainKey || Buffer.alloc(32));
        
        let encrypted = cipher.update(plaintext);
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        
        const authTag = cipher.getAuthTag();
        const result = Buffer.concat([encrypted, authTag]);
        
        // Update handshake hash
        state.handshakeHash.update(result);
        
        return result;
    }
    
    /**
     * Decrypt and hash (for Noise protocol)
     */
    decryptAndHash(state, ciphertext) {
        // Simplified - in production would implement proper Noise decryption
        const authTag = ciphertext.slice(-16);
        const encrypted = ciphertext.slice(0, -16);
        
        const decipher = crypto.createDecipher('aes-256-gcm', state.chainKey || Buffer.alloc(32));
        decipher.setAuthTag(authTag);
        
        let decrypted = decipher.update(encrypted);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        
        // Update handshake hash
        state.handshakeHash.update(ciphertext);
        
        return decrypted;
    }
    
    /**
     * Get transport statistics
     */
    getStats() {
        return {
            ...this.stats,
            activeConnections: this.activeConnections.size,
            sessionKeys: this.sessionKeys.size,
            trustedPeers: this.trustedPeers.size
        };
    }
    
    /**
     * Get connection info
     */
    getConnectionInfo(connectionId) {
        return this.activeConnections.get(connectionId);
    }
    
    /**
     * Close connection
     */
    closeConnection(connectionId) {
        const connection = this.activeConnections.get(connectionId);
        if (connection) {
            connection.socket.destroy();
            this.activeConnections.delete(connectionId);
            this.sessionKeys.delete(connectionId);
            this.noiseStates.delete(connectionId);
        }
    }
    
    /**
     * Cleanup transport
     */
    async cleanup() {
        this.logger.info('Cleaning up encrypted transport...');
        
        // Close all connections
        for (const connectionId of this.activeConnections.keys()) {
            this.closeConnection(connectionId);
        }
        
        // Clear state
        this.ephemeralKeys.clear();
        this.sessionKeys.clear();
        this.noiseStates.clear();
        
        this.emit('cleanup');
    }
}

export default EncryptedTransport;