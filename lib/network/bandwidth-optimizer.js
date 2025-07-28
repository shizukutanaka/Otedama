const { EventEmitter } = require('events');
const { Transform } = require('stream');

class BandwidthOptimizer extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            maxBandwidth: options.maxBandwidth || 1000000000, // 1 Gbps
            burstSize: options.burstSize || 1048576, // 1 MB
            compressionThreshold: options.compressionThreshold || 1024, // 1 KB
            priorityLevels: options.priorityLevels || 4,
            shapingInterval: options.shapingInterval || 10, // ms
            adaptiveWindow: options.adaptiveWindow || 5000, // 5 seconds
            ...options
        };
        
        this.connections = new Map();
        this.globalTokenBucket = {
            tokens: this.config.burstSize,
            lastRefill: Date.now()
        };
        
        this.trafficStats = {
            totalBytes: 0,
            compressedBytes: 0,
            droppedPackets: 0,
            shapedPackets: 0
        };
        
        this.priorityQueues = new Array(this.config.priorityLevels)
            .fill(null)
            .map(() => []);
        
        this.compressionCache = new Map();
        this.adaptiveThresholds = new Map();
    }

    async initialize() {
        this.startTrafficShaping();
        this.startAdaptiveOptimization();
        this.emit('initialized');
    }

    createOptimizedStream(connectionId, options = {}) {
        const stream = new OptimizedTransform({
            optimizer: this,
            connectionId,
            priority: options.priority || 2,
            compress: options.compress !== false,
            ...options
        });
        
        const connection = {
            id: connectionId,
            stream,
            priority: options.priority || 2,
            bandwidth: options.bandwidth || this.config.maxBandwidth / 10,
            tokens: this.config.burstSize / 10,
            lastActivity: Date.now(),
            stats: {
                bytesSent: 0,
                bytesReceived: 0,
                packetsDropped: 0,
                compressionRatio: 1
            }
        };
        
        this.connections.set(connectionId, connection);
        
        stream.on('close', () => {
            this.connections.delete(connectionId);
        });
        
        return stream;
    }

    allocateBandwidth(connectionId, bytes) {
        const connection = this.connections.get(connectionId);
        if (!connection) return false;
        
        // Check connection-level token bucket
        const now = Date.now();
        const elapsed = now - connection.lastActivity;
        const refillTokens = (elapsed / 1000) * connection.bandwidth;
        
        connection.tokens = Math.min(
            connection.tokens + refillTokens,
            this.config.burstSize / 10
        );
        
        if (connection.tokens < bytes) {
            // Queue packet for shaping
            this.queuePacket(connection, bytes);
            return false;
        }
        
        // Check global token bucket
        this.refillGlobalBucket();
        
        if (this.globalTokenBucket.tokens < bytes) {
            this.queuePacket(connection, bytes);
            return false;
        }
        
        // Deduct tokens
        connection.tokens -= bytes;
        this.globalTokenBucket.tokens -= bytes;
        connection.lastActivity = now;
        
        // Update stats
        connection.stats.bytesSent += bytes;
        this.trafficStats.totalBytes += bytes;
        
        return true;
    }

    refillGlobalBucket() {
        const now = Date.now();
        const elapsed = now - this.globalTokenBucket.lastRefill;
        const refillTokens = (elapsed / 1000) * this.config.maxBandwidth;
        
        this.globalTokenBucket.tokens = Math.min(
            this.globalTokenBucket.tokens + refillTokens,
            this.config.burstSize
        );
        
        this.globalTokenBucket.lastRefill = now;
    }

    queuePacket(connection, bytes) {
        const packet = {
            connectionId: connection.id,
            bytes,
            timestamp: Date.now(),
            priority: connection.priority
        };
        
        this.priorityQueues[connection.priority].push(packet);
        this.trafficStats.shapedPackets++;
        
        this.emit('packet:queued', packet);
    }

    startTrafficShaping() {
        this.shapingInterval = setInterval(() => {
            this.processQueuedPackets();
        }, this.config.shapingInterval);
    }

    processQueuedPackets() {
        this.refillGlobalBucket();
        
        // Process queues in priority order
        for (let priority = 0; priority < this.config.priorityLevels; priority++) {
            const queue = this.priorityQueues[priority];
            
            while (queue.length > 0 && this.globalTokenBucket.tokens > 0) {
                const packet = queue[0];
                const connection = this.connections.get(packet.connectionId);
                
                if (!connection) {
                    queue.shift();
                    continue;
                }
                
                if (this.allocateBandwidth(packet.connectionId, packet.bytes)) {
                    queue.shift();
                    this.emit('packet:sent', packet);
                } else {
                    break; // Not enough tokens, try next priority
                }
            }
        }
        
        // Drop old packets
        this.dropExpiredPackets();
    }

    dropExpiredPackets() {
        const maxAge = 5000; // 5 seconds
        const now = Date.now();
        
        for (const queue of this.priorityQueues) {
            let dropped = 0;
            
            while (queue.length > 0 && now - queue[0].timestamp > maxAge) {
                queue.shift();
                dropped++;
            }
            
            if (dropped > 0) {
                this.trafficStats.droppedPackets += dropped;
                this.emit('packets:dropped', { count: dropped });
            }
        }
    }

    async compressData(data, connectionId) {
        if (data.length < this.config.compressionThreshold) {
            return { compressed: false, data };
        }
        
        // Check compression cache
        const hash = this.hashData(data);
        const cached = this.compressionCache.get(hash);
        
        if (cached) {
            this.emit('compression:cached', { size: data.length });
            return { compressed: true, data: cached, cached: true };
        }
        
        // Simulate compression (in production use zlib or lz4)
        const compressed = await this.performCompression(data);
        
        if (compressed.length < data.length * 0.9) {
            // Cache compressed data
            this.compressionCache.set(hash, compressed);
            this.maintainCacheSize();
            
            const ratio = compressed.length / data.length;
            this.updateCompressionStats(connectionId, ratio);
            
            return { compressed: true, data: compressed, ratio };
        }
        
        return { compressed: false, data };
    }

    hashData(data) {
        // Simple hash for demo - use crypto.createHash in production
        let hash = 0;
        for (let i = 0; i < Math.min(data.length, 100); i++) {
            hash = ((hash << 5) - hash) + data[i];
            hash = hash & hash;
        }
        return hash.toString(16);
    }

    async performCompression(data) {
        // Simulate compression - in production use actual compression
        const compressed = Buffer.alloc(Math.floor(data.length * 0.7));
        
        // Copy some data patterns
        for (let i = 0; i < compressed.length; i++) {
            compressed[i] = data[i % data.length];
        }
        
        return compressed;
    }

    updateCompressionStats(connectionId, ratio) {
        const connection = this.connections.get(connectionId);
        if (!connection) return;
        
        // Update moving average
        connection.stats.compressionRatio = 
            connection.stats.compressionRatio * 0.9 + ratio * 0.1;
        
        this.trafficStats.compressedBytes += 1;
    }

    maintainCacheSize() {
        const maxCacheSize = 1000;
        
        if (this.compressionCache.size > maxCacheSize) {
            // Remove oldest entries
            const entries = Array.from(this.compressionCache.entries());
            const toRemove = entries.slice(0, entries.length - maxCacheSize);
            
            toRemove.forEach(([key]) => this.compressionCache.delete(key));
        }
    }

    startAdaptiveOptimization() {
        this.adaptiveInterval = setInterval(() => {
            this.optimizeBandwidthAllocation();
            this.adjustCompressionThresholds();
        }, this.config.adaptiveWindow);
    }

    optimizeBandwidthAllocation() {
        const activeConnections = Array.from(this.connections.values())
            .filter(conn => Date.now() - conn.lastActivity < 10000);
        
        if (activeConnections.length === 0) return;
        
        // Calculate fair share with priority weighting
        const totalWeight = activeConnections.reduce((sum, conn) => 
            sum + Math.pow(2, this.config.priorityLevels - conn.priority), 0
        );
        
        activeConnections.forEach(conn => {
            const weight = Math.pow(2, this.config.priorityLevels - conn.priority);
            const share = (weight / totalWeight) * this.config.maxBandwidth;
            
            // Smooth transition
            conn.bandwidth = conn.bandwidth * 0.7 + share * 0.3;
            
            this.emit('bandwidth:adjusted', {
                connectionId: conn.id,
                bandwidth: conn.bandwidth
            });
        });
    }

    adjustCompressionThresholds() {
        for (const [connId, conn] of this.connections) {
            const ratio = conn.stats.compressionRatio;
            
            // Adaptive threshold based on compression effectiveness
            let threshold = this.config.compressionThreshold;
            
            if (ratio < 0.5) {
                // Very good compression, lower threshold
                threshold *= 0.5;
            } else if (ratio > 0.9) {
                // Poor compression, raise threshold
                threshold *= 2;
            }
            
            this.adaptiveThresholds.set(connId, threshold);
        }
    }

    implementQoS(rules) {
        // Apply Quality of Service rules
        rules.forEach(rule => {
            switch (rule.type) {
                case 'guaranteed_bandwidth':
                    this.setGuaranteedBandwidth(rule.connectionId, rule.bandwidth);
                    break;
                    
                case 'rate_limit':
                    this.setRateLimit(rule.connectionId, rule.limit);
                    break;
                    
                case 'priority':
                    this.setPriority(rule.connectionId, rule.priority);
                    break;
            }
        });
    }

    setGuaranteedBandwidth(connectionId, bandwidth) {
        const connection = this.connections.get(connectionId);
        if (connection) {
            connection.guaranteedBandwidth = bandwidth;
            connection.bandwidth = Math.max(connection.bandwidth, bandwidth);
        }
    }

    setRateLimit(connectionId, limit) {
        const connection = this.connections.get(connectionId);
        if (connection) {
            connection.rateLimit = limit;
            connection.bandwidth = Math.min(connection.bandwidth, limit);
        }
    }

    setPriority(connectionId, priority) {
        const connection = this.connections.get(connectionId);
        if (connection) {
            connection.priority = Math.max(0, Math.min(priority, this.config.priorityLevels - 1));
        }
    }

    getStatistics() {
        const connectionStats = Array.from(this.connections.values()).map(conn => ({
            id: conn.id,
            priority: conn.priority,
            bandwidth: conn.bandwidth,
            stats: conn.stats
        }));
        
        return {
            global: this.trafficStats,
            connections: connectionStats,
            queues: this.priorityQueues.map((q, i) => ({
                priority: i,
                length: q.length
            })),
            cacheSize: this.compressionCache.size,
            tokenBucket: {
                tokens: this.globalTokenBucket.tokens,
                capacity: this.config.burstSize
            }
        };
    }

    stop() {
        if (this.shapingInterval) clearInterval(this.shapingInterval);
        if (this.adaptiveInterval) clearInterval(this.adaptiveInterval);
        
        this.connections.clear();
        this.compressionCache.clear();
        this.priorityQueues.forEach(q => q.length = 0);
        
        this.emit('stopped');
    }
}

class OptimizedTransform extends Transform {
    constructor(options) {
        super(options);
        
        this.optimizer = options.optimizer;
        this.connectionId = options.connectionId;
        this.compress = options.compress;
    }
    
    async _transform(chunk, encoding, callback) {
        try {
            // Check bandwidth allocation
            if (!this.optimizer.allocateBandwidth(this.connectionId, chunk.length)) {
                // Packet queued for later transmission
                return callback();
            }
            
            // Compress if enabled
            if (this.compress) {
                const result = await this.optimizer.compressData(chunk, this.connectionId);
                chunk = result.data;
            }
            
            this.push(chunk);
            callback();
            
        } catch (error) {
            callback(error);
        }
    }
}

module.exports = BandwidthOptimizer;