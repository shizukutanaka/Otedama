/**
 * WebSocket Compression and Optimization System
 * WebSocket圧縮と最適化システム
 */

const { EventEmitter } = require('events');
const zlib = require('zlib');
const WebSocket = require('ws');

class WebSocketCompressionManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Compression settings
            enableCompression: config.enableCompression !== false,
            compressionLevel: config.compressionLevel || 6, // 1-9
            memLevel: config.memLevel || 8, // 1-9
            strategy: config.strategy || zlib.constants.Z_DEFAULT_STRATEGY,
            threshold: config.threshold || 1024, // Don't compress below 1KB
            
            // PerMessage-Deflate options
            serverNoContextTakeover: config.serverNoContextTakeover || false,
            clientNoContextTakeover: config.clientNoContextTakeover || false,
            serverMaxWindowBits: config.serverMaxWindowBits || 15,
            clientMaxWindowBits: config.clientMaxWindowBits || 15,
            
            // Binary frame optimization
            enableBinaryFraming: config.enableBinaryFraming !== false,
            binaryThreshold: config.binaryThreshold || 256, // Use binary for data > 256 bytes
            
            // Message batching
            enableBatching: config.enableBatching !== false,
            batchSize: config.batchSize || 10,
            batchDelay: config.batchDelay || 10, // ms
            maxBatchSize: config.maxBatchSize || 65536, // 64KB
            
            // Protocol optimization
            enableProtocolOptimization: config.enableProtocolOptimization !== false,
            protocolVersion: config.protocolVersion || 2,
            
            // Adaptive compression
            enableAdaptiveCompression: config.enableAdaptiveCompression !== false,
            adaptiveInterval: config.adaptiveInterval || 5000, // 5 seconds
            
            ...config
        };
        
        // Compression statistics
        this.stats = {
            messagesSent: 0,
            messagesReceived: 0,
            bytesOriginal: 0,
            bytesCompressed: 0,
            compressionRatio: 0,
            batchedMessages: 0,
            errors: 0
        };
        
        // Message batching
        this.messageBatches = new Map();
        this.batchTimers = new Map();
        
        // Compression contexts
        this.compressionContexts = new Map();
        
        // Protocol definitions
        this.protocols = this.initializeProtocols();
        
        // Initialize
        this.initialize();
    }
    
    initialize() {
        console.log('WebSocket圧縮マネージャーを初期化中...');
        
        // Start adaptive compression
        if (this.config.enableAdaptiveCompression) {
            this.startAdaptiveCompression();
        }
        
        console.log('✓ WebSocket圧縮マネージャーの初期化完了');
    }
    
    /**
     * Create optimized WebSocket server
     */
    createServer(options = {}) {
        const serverOptions = {
            ...options,
            perMessageDeflate: this.config.enableCompression ? {
                zlibDeflateOptions: {
                    level: this.config.compressionLevel,
                    memLevel: this.config.memLevel,
                    strategy: this.config.strategy
                },
                zlibInflateOptions: {
                    level: this.config.compressionLevel
                },
                serverNoContextTakeover: this.config.serverNoContextTakeover,
                clientNoContextTakeover: this.config.clientNoContextTakeover,
                serverMaxWindowBits: this.config.serverMaxWindowBits,
                clientMaxWindowBits: this.config.clientMaxWindowBits,
                threshold: this.config.threshold
            } : false
        };
        
        const server = new WebSocket.Server(serverOptions);
        
        // Wrap server methods
        this.wrapServer(server);
        
        return server;
    }
    
    /**
     * Create optimized WebSocket client
     */
    createClient(url, options = {}) {
        const clientOptions = {
            ...options,
            perMessageDeflate: this.config.enableCompression ? {
                zlibDeflateOptions: {
                    level: this.config.compressionLevel,
                    memLevel: this.config.memLevel,
                    strategy: this.config.strategy
                },
                zlibInflateOptions: {
                    level: this.config.compressionLevel
                },
                clientNoContextTakeover: this.config.clientNoContextTakeover,
                serverMaxWindowBits: this.config.serverMaxWindowBits,
                clientMaxWindowBits: this.config.clientMaxWindowBits,
                threshold: this.config.threshold
            } : false
        };
        
        const client = new WebSocket(url, clientOptions);
        
        // Wrap client methods
        this.wrapClient(client);
        
        return client;
    }
    
    /**
     * Wrap WebSocket server
     */
    wrapServer(server) {
        server.on('connection', (ws, req) => {
            this.wrapConnection(ws);
            
            // Track connection
            this.emit('connection', ws, req);
        });
    }
    
    /**
     * Wrap WebSocket client
     */
    wrapClient(client) {
        this.wrapConnection(client);
    }
    
    /**
     * Wrap WebSocket connection
     */
    wrapConnection(ws) {
        const originalSend = ws.send.bind(ws);
        
        // Override send method
        ws.send = (data, options, callback) => {
            this.optimizedSend(ws, originalSend, data, options, callback);
        };
        
        // Add batch send method
        ws.batchSend = (data, options) => {
            return this.batchSend(ws, data, options);
        };
        
        // Add protocol send method
        ws.protocolSend = (type, payload, options) => {
            return this.protocolSend(ws, type, payload, options);
        };
        
        // Track incoming messages
        ws.on('message', (data, isBinary) => {
            this.handleIncomingMessage(ws, data, isBinary);
        });
        
        // Cleanup on close
        ws.on('close', () => {
            this.cleanupConnection(ws);
        });
    }
    
    /**
     * Optimized send implementation
     */
    optimizedSend(ws, originalSend, data, options = {}, callback) {
        try {
            let optimizedData = data;
            let optimizedOptions = { ...options };
            
            // Convert to binary if beneficial
            if (this.config.enableBinaryFraming && !options.binary) {
                const shouldUseBinary = this.shouldUseBinary(data);
                if (shouldUseBinary) {
                    optimizedData = this.convertToBinary(data);
                    optimizedOptions.binary = true;
                }
            }
            
            // Apply custom compression if needed
            if (this.shouldApplyCustomCompression(optimizedData, optimizedOptions)) {
                optimizedData = this.applyCustomCompression(optimizedData);
                optimizedOptions.compressed = true;
            }
            
            // Update statistics
            this.updateSendStatistics(data, optimizedData);
            
            // Send optimized data
            originalSend(optimizedData, optimizedOptions, callback);
            
        } catch (error) {
            this.stats.errors++;
            this.emit('send-error', error);
            if (callback) callback(error);
        }
    }
    
    /**
     * Batch send implementation
     */
    async batchSend(ws, data, options = {}) {
        if (!this.config.enableBatching) {
            ws.send(data, options);
            return;
        }
        
        const batchKey = ws._batchKey || (ws._batchKey = this.generateBatchKey());
        
        if (!this.messageBatches.has(batchKey)) {
            this.messageBatches.set(batchKey, []);
        }
        
        const batch = this.messageBatches.get(batchKey);
        batch.push({ data, options });
        
        // Clear existing timer
        if (this.batchTimers.has(batchKey)) {
            clearTimeout(this.batchTimers.get(batchKey));
        }
        
        // Check if should send immediately
        if (this.shouldSendBatch(batch)) {
            this.sendBatch(ws, batchKey);
        } else {
            // Schedule batch send
            const timer = setTimeout(() => {
                this.sendBatch(ws, batchKey);
            }, this.config.batchDelay);
            
            this.batchTimers.set(batchKey, timer);
        }
    }
    
    /**
     * Protocol-based send
     */
    protocolSend(ws, type, payload, options = {}) {
        if (!this.config.enableProtocolOptimization) {
            ws.send(JSON.stringify({ type, payload }), options);
            return;
        }
        
        const protocol = this.protocols[this.config.protocolVersion];
        const encoded = protocol.encode(type, payload);
        
        ws.send(encoded, { binary: true, ...options });
    }
    
    /**
     * Handle incoming message
     */
    handleIncomingMessage(ws, data, isBinary) {
        this.stats.messagesReceived++;
        
        try {
            let decoded = data;
            
            // Handle custom compression
            if (this.isCustomCompressed(data)) {
                decoded = this.decompressCustom(data);
            }
            
            // Handle protocol messages
            if (isBinary && this.config.enableProtocolOptimization) {
                const protocol = this.protocols[this.config.protocolVersion];
                const message = protocol.decode(decoded);
                
                this.emit('protocol-message', ws, message);
                return;
            }
            
            this.emit('message', ws, decoded, isBinary);
            
        } catch (error) {
            this.stats.errors++;
            this.emit('message-error', error);
        }
    }
    
    /**
     * Should use binary framing
     */
    shouldUseBinary(data) {
        if (Buffer.isBuffer(data)) return true;
        
        const size = typeof data === 'string' ? 
            Buffer.byteLength(data) : 
            JSON.stringify(data).length;
        
        return size > this.config.binaryThreshold;
    }
    
    /**
     * Convert data to binary
     */
    convertToBinary(data) {
        if (Buffer.isBuffer(data)) return data;
        
        const str = typeof data === 'string' ? data : JSON.stringify(data);
        return Buffer.from(str);
    }
    
    /**
     * Should apply custom compression
     */
    shouldApplyCustomCompression(data, options) {
        if (!this.config.enableCompression) return false;
        if (options.compressed) return false;
        
        const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
        return size > this.config.threshold * 2; // Higher threshold for custom
    }
    
    /**
     * Apply custom compression
     */
    applyCustomCompression(data) {
        const input = Buffer.isBuffer(data) ? data : Buffer.from(data);
        
        const compressed = zlib.gzipSync(input, {
            level: this.config.compressionLevel
        });
        
        // Add compression header
        const result = Buffer.allocUnsafe(compressed.length + 1);
        result[0] = 0x01; // Custom compression flag
        compressed.copy(result, 1);
        
        return result;
    }
    
    /**
     * Check if data is custom compressed
     */
    isCustomCompressed(data) {
        return Buffer.isBuffer(data) && data.length > 0 && data[0] === 0x01;
    }
    
    /**
     * Decompress custom compressed data
     */
    decompressCustom(data) {
        const compressed = data.slice(1);
        return zlib.gunzipSync(compressed);
    }
    
    /**
     * Should send batch
     */
    shouldSendBatch(batch) {
        if (batch.length >= this.config.batchSize) return true;
        
        const batchSize = batch.reduce((size, msg) => {
            const msgSize = Buffer.isBuffer(msg.data) ? 
                msg.data.length : 
                Buffer.byteLength(JSON.stringify(msg.data));
            return size + msgSize;
        }, 0);
        
        return batchSize >= this.config.maxBatchSize;
    }
    
    /**
     * Send message batch
     */
    sendBatch(ws, batchKey) {
        const batch = this.messageBatches.get(batchKey);
        if (!batch || batch.length === 0) return;
        
        // Clear batch
        this.messageBatches.delete(batchKey);
        this.batchTimers.delete(batchKey);
        
        // Create batch message
        const batchMessage = {
            type: 'batch',
            messages: batch.map(msg => ({
                data: msg.data,
                options: msg.options
            }))
        };
        
        // Send as single message
        ws.send(JSON.stringify(batchMessage), { compress: true });
        
        this.stats.batchedMessages += batch.length;
        
        this.emit('batch-sent', {
            count: batch.length,
            size: JSON.stringify(batchMessage).length
        });
    }
    
    /**
     * Initialize protocol definitions
     */
    initializeProtocols() {
        return {
            1: new SimpleProtocol(),
            2: new OptimizedProtocol()
        };
    }
    
    /**
     * Update send statistics
     */
    updateSendStatistics(original, optimized) {
        this.stats.messagesSent++;
        
        const originalSize = Buffer.isBuffer(original) ? 
            original.length : 
            Buffer.byteLength(JSON.stringify(original));
        
        const optimizedSize = Buffer.isBuffer(optimized) ? 
            optimized.length : 
            Buffer.byteLength(JSON.stringify(optimized));
        
        this.stats.bytesOriginal += originalSize;
        this.stats.bytesCompressed += optimizedSize;
        
        // Update compression ratio
        if (this.stats.bytesOriginal > 0) {
            this.stats.compressionRatio = 
                1 - (this.stats.bytesCompressed / this.stats.bytesOriginal);
        }
    }
    
    /**
     * Start adaptive compression
     */
    startAdaptiveCompression() {
        setInterval(() => {
            this.adaptCompressionSettings();
        }, this.config.adaptiveInterval);
    }
    
    /**
     * Adapt compression settings based on performance
     */
    adaptCompressionSettings() {
        const ratio = this.stats.compressionRatio;
        
        // Adjust compression level based on effectiveness
        if (ratio < 0.1) {
            // Poor compression, reduce level
            this.config.compressionLevel = Math.max(1, this.config.compressionLevel - 1);
        } else if (ratio > 0.5) {
            // Good compression, can increase level
            this.config.compressionLevel = Math.min(9, this.config.compressionLevel + 1);
        }
        
        // Adjust threshold based on message sizes
        const avgMessageSize = this.stats.bytesOriginal / this.stats.messagesSent;
        if (avgMessageSize < this.config.threshold) {
            this.config.threshold = Math.max(256, Math.floor(avgMessageSize * 0.8));
        }
        
        this.emit('compression-adapted', {
            level: this.config.compressionLevel,
            threshold: this.config.threshold,
            ratio: ratio
        });
    }
    
    /**
     * Cleanup connection resources
     */
    cleanupConnection(ws) {
        const batchKey = ws._batchKey;
        
        if (batchKey) {
            // Send remaining batched messages
            if (this.messageBatches.has(batchKey)) {
                this.sendBatch(ws, batchKey);
            }
            
            // Clear timer
            if (this.batchTimers.has(batchKey)) {
                clearTimeout(this.batchTimers.get(batchKey));
                this.batchTimers.delete(batchKey);
            }
        }
    }
    
    /**
     * Generate batch key
     */
    generateBatchKey() {
        return `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * Get compression statistics
     */
    getStatistics() {
        return {
            ...this.stats,
            compressionLevel: this.config.compressionLevel,
            threshold: this.config.threshold,
            activeBatches: this.messageBatches.size
        };
    }
}

/**
 * Simple protocol implementation
 */
class SimpleProtocol {
    encode(type, payload) {
        const message = { type, payload };
        return Buffer.from(JSON.stringify(message));
    }
    
    decode(data) {
        const str = data.toString();
        return JSON.parse(str);
    }
}

/**
 * Optimized binary protocol implementation
 */
class OptimizedProtocol {
    constructor() {
        // Message type mappings
        this.typeToCode = new Map([
            ['ping', 0x01],
            ['pong', 0x02],
            ['subscribe', 0x03],
            ['unsubscribe', 0x04],
            ['publish', 0x05],
            ['request', 0x06],
            ['response', 0x07],
            ['error', 0x08],
            ['share', 0x10],
            ['block', 0x11],
            ['transaction', 0x12],
            ['difficulty', 0x13],
            ['stats', 0x14]
        ]);
        
        this.codeToType = new Map(
            Array.from(this.typeToCode.entries()).map(([k, v]) => [v, k])
        );
    }
    
    encode(type, payload) {
        const typeCode = this.typeToCode.get(type) || 0xFF;
        const payloadBuffer = Buffer.from(JSON.stringify(payload));
        
        // Format: [type:1][length:4][payload:n]
        const buffer = Buffer.allocUnsafe(5 + payloadBuffer.length);
        
        buffer.writeUInt8(typeCode, 0);
        buffer.writeUInt32BE(payloadBuffer.length, 1);
        payloadBuffer.copy(buffer, 5);
        
        return buffer;
    }
    
    decode(data) {
        if (data.length < 5) {
            throw new Error('Invalid protocol message');
        }
        
        const typeCode = data.readUInt8(0);
        const length = data.readUInt32BE(1);
        
        if (data.length < 5 + length) {
            throw new Error('Incomplete protocol message');
        }
        
        const type = this.codeToType.get(typeCode) || 'unknown';
        const payloadBuffer = data.slice(5, 5 + length);
        const payload = JSON.parse(payloadBuffer.toString());
        
        return { type, payload };
    }
}

module.exports = WebSocketCompressionManager;