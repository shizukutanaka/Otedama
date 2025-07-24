const { EventEmitter } = require('events');
const crypto = require('crypto');

/**
 * Network Security System
 * DDoS protection, rate limiting, and traffic filtering
 */
class NetworkSecurityManager extends EventEmitter {
    constructor(config) {
        super();
        this.config = {
            // DDoS Protection
            maxConnectionsPerIP: config.maxConnectionsPerIP || 100,
            maxRequestsPerMinute: config.maxRequestsPerMinute || 1000,
            burstAllowance: config.burstAllowance || 50,
            
            // Connection limits
            maxConcurrentConnections: config.maxConcurrentConnections || 10000,
            connectionTimeout: config.connectionTimeout || 30000, // 30 seconds
            
            // Blacklist/Whitelist
            blacklistDuration: config.blacklistDuration || 3600000, // 1 hour
            whitelistBypass: config.whitelistBypass !== false,
            
            // Traffic shaping
            bandwidthLimit: config.bandwidthLimit || 100 * 1024 * 1024, // 100 MB/s
            packetSizeLimit: config.packetSizeLimit || 1024 * 1024, // 1 MB
            
            // Geo-blocking
            enableGeoBlocking: config.enableGeoBlocking || false,
            blockedCountries: config.blockedCountries || [],
            allowedCountries: config.allowedCountries || [],
            
            // Pattern detection
            suspiciousPatterns: config.suspiciousPatterns || true,
            anomalyDetection: config.anomalyDetection || true,
            
            ...config
        };
        
        // Connection tracking
        this.connections = new Map();
        this.connectionCounts = new Map();
        
        // Rate limiting
        this.requestCounts = new Map();
        this.bandwidthUsage = new Map();
        
        // Security lists
        this.blacklist = new Map();
        this.whitelist = new Set(config.whitelist || []);
        this.tempBlacklist = new Map();
        
        // Pattern detection
        this.patterns = new Map();
        this.anomalies = new Map();
        
        // Metrics
        this.metrics = {
            totalConnections: 0,
            blockedConnections: 0,
            rateLimitHits: 0,
            ddosAttacks: 0,
            anomaliesDetected: 0,
            bandwidth: {
                inbound: 0,
                outbound: 0
            }
        };
        
        this.setupCleanupTasks();
        this.loadSecurityPatterns();
    }
    
    // Setup periodic cleanup
    setupCleanupTasks() {
        // Clean up old entries every minute
        setInterval(() => {
            this.cleanupExpiredEntries();
            this.updateMetrics();
        }, 60000);
        
        // Reset rate limit windows every minute
        setInterval(() => {
            this.requestCounts.clear();
            this.bandwidthUsage.clear();
        }, 60000);
    }
    
    // Load security patterns
    loadSecurityPatterns() {
        // Common attack patterns
        this.patterns.set('synFlood', {
            description: 'SYN flood attack',
            detect: (conn) => {
                return conn.flags === 'SYN' && !conn.ack;
            }
        });
        
        this.patterns.set('udpFlood', {
            description: 'UDP flood attack',
            detect: (conn) => {
                return conn.protocol === 'UDP' && conn.size > 1000;
            }
        });
        
        this.patterns.set('httpFlood', {
            description: 'HTTP flood attack',
            detect: (conn) => {
                return conn.method === 'GET' && conn.userAgent === '';
            }
        });
        
        this.patterns.set('slowloris', {
            description: 'Slowloris attack',
            detect: (conn) => {
                return conn.duration > 30000 && conn.bytesReceived < 1000;
            }
        });
        
        this.patterns.set('amplification', {
            description: 'Amplification attack',
            detect: (conn) => {
                return conn.responseSize > conn.requestSize * 10;
            }
        });
    }
    
    // Check if connection should be allowed
    async checkConnection(ip, metadata = {}) {
        // Check whitelist
        if (this.config.whitelistBypass && this.whitelist.has(ip)) {
            return { allowed: true, reason: 'whitelisted' };
        }
        
        // Check blacklist
        if (this.isBlacklisted(ip)) {
            this.metrics.blockedConnections++;
            return { allowed: false, reason: 'blacklisted' };
        }
        
        // Check connection limit per IP
        const ipConnections = this.connectionCounts.get(ip) || 0;
        if (ipConnections >= this.config.maxConnectionsPerIP) {
            this.metrics.blockedConnections++;
            this.emit('connection-limit-exceeded', { ip, count: ipConnections });
            return { allowed: false, reason: 'connection_limit' };
        }
        
        // Check total connections
        if (this.connections.size >= this.config.maxConcurrentConnections) {
            this.metrics.blockedConnections++;
            return { allowed: false, reason: 'server_full' };
        }
        
        // Check rate limit
        const rateLimit = this.checkRateLimit(ip);
        if (!rateLimit.allowed) {
            this.metrics.rateLimitHits++;
            return { allowed: false, reason: 'rate_limit' };
        }
        
        // Geo-blocking
        if (this.config.enableGeoBlocking && metadata.country) {
            const geoCheck = this.checkGeoBlocking(metadata.country);
            if (!geoCheck.allowed) {
                this.metrics.blockedConnections++;
                return { allowed: false, reason: 'geo_blocked' };
            }
        }
        
        // Pattern detection
        if (this.config.suspiciousPatterns) {
            const patternCheck = this.detectAttackPattern(ip, metadata);
            if (patternCheck.detected) {
                this.metrics.blockedConnections++;
                this.addToBlacklist(ip, 'attack_pattern', patternCheck.pattern);
                return { allowed: false, reason: 'attack_detected', pattern: patternCheck.pattern };
            }
        }
        
        // Anomaly detection
        if (this.config.anomalyDetection) {
            const anomaly = this.detectAnomaly(ip, metadata);
            if (anomaly.detected) {
                this.metrics.anomaliesDetected++;
                this.emit('anomaly-detected', { ip, anomaly: anomaly.type });
            }
        }
        
        return { allowed: true };
    }
    
    // Track new connection
    trackConnection(ip, connectionId, metadata = {}) {
        // Update connection count
        const count = this.connectionCounts.get(ip) || 0;
        this.connectionCounts.set(ip, count + 1);
        
        // Store connection info
        this.connections.set(connectionId, {
            ip,
            startTime: Date.now(),
            metadata,
            bytesIn: 0,
            bytesOut: 0
        });
        
        this.metrics.totalConnections++;
        
        return connectionId;
    }
    
    // Update connection metrics
    updateConnection(connectionId, data) {
        const conn = this.connections.get(connectionId);
        if (!conn) return;
        
        if (data.bytesIn) {
            conn.bytesIn += data.bytesIn;
            this.updateBandwidth(conn.ip, 'inbound', data.bytesIn);
        }
        
        if (data.bytesOut) {
            conn.bytesOut += data.bytesOut;
            this.updateBandwidth(conn.ip, 'outbound', data.bytesOut);
        }
        
        if (data.metadata) {
            Object.assign(conn.metadata, data.metadata);
        }
    }
    
    // Remove connection
    removeConnection(connectionId) {
        const conn = this.connections.get(connectionId);
        if (!conn) return;
        
        // Update connection count
        const count = this.connectionCounts.get(conn.ip) || 0;
        if (count > 0) {
            this.connectionCounts.set(conn.ip, count - 1);
        }
        
        // Clean up if no more connections
        if (count <= 1) {
            this.connectionCounts.delete(conn.ip);
        }
        
        this.connections.delete(connectionId);
    }
    
    // Rate limiting
    checkRateLimit(ip) {
        const now = Date.now();
        let record = this.requestCounts.get(ip);
        
        if (!record) {
            record = {
                count: 0,
                windowStart: now,
                tokens: this.config.burstAllowance
            };
            this.requestCounts.set(ip, record);
        }
        
        // Token bucket algorithm
        const elapsed = now - record.windowStart;
        const tokensToAdd = (elapsed / 60000) * this.config.maxRequestsPerMinute;
        record.tokens = Math.min(
            this.config.burstAllowance,
            record.tokens + tokensToAdd
        );
        record.windowStart = now;
        
        if (record.tokens >= 1) {
            record.tokens--;
            record.count++;
            return { allowed: true, remaining: Math.floor(record.tokens) };
        }
        
        return { allowed: false, remaining: 0 };
    }
    
    // Bandwidth tracking
    updateBandwidth(ip, direction, bytes) {
        let usage = this.bandwidthUsage.get(ip);
        if (!usage) {
            usage = { inbound: 0, outbound: 0 };
            this.bandwidthUsage.set(ip, usage);
        }
        
        usage[direction] += bytes;
        this.metrics.bandwidth[direction] += bytes;
        
        // Check bandwidth limit
        const total = usage.inbound + usage.outbound;
        if (total > this.config.bandwidthLimit) {
            this.emit('bandwidth-exceeded', { ip, usage: total });
            this.addToBlacklist(ip, 'bandwidth_abuse');
        }
    }
    
    // Blacklist management
    addToBlacklist(ip, reason, details = {}) {
        const entry = {
            reason,
            details,
            timestamp: Date.now(),
            expires: Date.now() + this.config.blacklistDuration
        };
        
        this.blacklist.set(ip, entry);
        this.emit('ip-blacklisted', { ip, reason, details });
        
        // Disconnect existing connections
        for (const [id, conn] of this.connections) {
            if (conn.ip === ip) {
                this.emit('force-disconnect', id);
            }
        }
    }
    
    removeFromBlacklist(ip) {
        this.blacklist.delete(ip);
        this.tempBlacklist.delete(ip);
        this.emit('ip-unblacklisted', { ip });
    }
    
    isBlacklisted(ip) {
        // Check permanent blacklist
        const entry = this.blacklist.get(ip);
        if (entry) {
            if (Date.now() > entry.expires) {
                this.blacklist.delete(ip);
                return false;
            }
            return true;
        }
        
        // Check temporary blacklist
        const tempEntry = this.tempBlacklist.get(ip);
        if (tempEntry) {
            if (Date.now() > tempEntry.expires) {
                this.tempBlacklist.delete(ip);
                return false;
            }
            return true;
        }
        
        return false;
    }
    
    // Whitelist management
    addToWhitelist(ip) {
        this.whitelist.add(ip);
        this.emit('ip-whitelisted', { ip });
    }
    
    removeFromWhitelist(ip) {
        this.whitelist.delete(ip);
        this.emit('ip-unwhitelisted', { ip });
    }
    
    // Geo-blocking
    checkGeoBlocking(country) {
        if (this.config.allowedCountries.length > 0) {
            return {
                allowed: this.config.allowedCountries.includes(country)
            };
        }
        
        if (this.config.blockedCountries.length > 0) {
            return {
                allowed: !this.config.blockedCountries.includes(country)
            };
        }
        
        return { allowed: true };
    }
    
    // Attack pattern detection
    detectAttackPattern(ip, metadata) {
        for (const [name, pattern] of this.patterns) {
            if (pattern.detect(metadata)) {
                this.metrics.ddosAttacks++;
                return {
                    detected: true,
                    pattern: name,
                    description: pattern.description
                };
            }
        }
        
        // Check for rapid connection attempts
        const requests = this.requestCounts.get(ip);
        if (requests && requests.count > this.config.maxRequestsPerMinute * 0.8) {
            return {
                detected: true,
                pattern: 'rapid_requests',
                description: 'Rapid request pattern detected'
            };
        }
        
        return { detected: false };
    }
    
    // Anomaly detection
    detectAnomaly(ip, metadata) {
        let anomalyScore = 0;
        const anomalies = [];
        
        // Check user agent
        if (!metadata.userAgent || metadata.userAgent.length < 10) {
            anomalyScore += 20;
            anomalies.push('suspicious_user_agent');
        }
        
        // Check headers
        if (metadata.headers) {
            const headers = Object.keys(metadata.headers);
            if (headers.length < 3) {
                anomalyScore += 15;
                anomalies.push('minimal_headers');
            }
            
            // Check for common bot headers
            const botHeaders = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip'];
            const hasMultipleProxyHeaders = botHeaders.filter(h => headers.includes(h)).length > 1;
            if (hasMultipleProxyHeaders) {
                anomalyScore += 25;
                anomalies.push('multiple_proxy_headers');
            }
        }
        
        // Check request patterns
        const requests = this.requestCounts.get(ip);
        if (requests) {
            // Perfectly timed requests (bot behavior)
            if (requests.count > 10 && requests.intervalVariance < 100) {
                anomalyScore += 30;
                anomalies.push('robotic_timing');
            }
        }
        
        // Check connection behavior
        const connections = Array.from(this.connections.values())
            .filter(conn => conn.ip === ip);
        
        if (connections.length > 5) {
            const avgDuration = connections.reduce((sum, conn) => 
                sum + (Date.now() - conn.startTime), 0) / connections.length;
            
            // Very short connections
            if (avgDuration < 1000) {
                anomalyScore += 20;
                anomalies.push('short_connections');
            }
        }
        
        // Store anomaly data
        if (anomalyScore > 0) {
            this.anomalies.set(ip, {
                score: anomalyScore,
                anomalies,
                timestamp: Date.now()
            });
        }
        
        return {
            detected: anomalyScore > 50,
            score: anomalyScore,
            type: anomalies
        };
    }
    
    // Cleanup expired entries
    cleanupExpiredEntries() {
        const now = Date.now();
        
        // Clean expired blacklist entries
        for (const [ip, entry] of this.blacklist) {
            if (now > entry.expires) {
                this.blacklist.delete(ip);
            }
        }
        
        // Clean expired temporary blacklist
        for (const [ip, entry] of this.tempBlacklist) {
            if (now > entry.expires) {
                this.tempBlacklist.delete(ip);
            }
        }
        
        // Clean old connections (possible leaked connections)
        for (const [id, conn] of this.connections) {
            if (now - conn.startTime > this.config.connectionTimeout) {
                this.removeConnection(id);
                this.emit('connection-timeout', id);
            }
        }
        
        // Clean old anomaly data
        for (const [ip, data] of this.anomalies) {
            if (now - data.timestamp > 3600000) { // 1 hour
                this.anomalies.delete(ip);
            }
        }
    }
    
    // Update metrics
    updateMetrics() {
        // Calculate connection rate
        const connectionRate = this.metrics.totalConnections / (Date.now() / 1000 / 60);
        
        // Check for DDoS indicators
        if (connectionRate > 1000) { // More than 1000 connections per minute
            this.emit('ddos-suspected', {
                rate: connectionRate,
                blocked: this.metrics.blockedConnections,
                total: this.metrics.totalConnections
            });
        }
        
        // Emit periodic metrics
        this.emit('metrics', {
            ...this.metrics,
            connectionRate,
            activeConnections: this.connections.size,
            blacklistedIPs: this.blacklist.size,
            whitelistedIPs: this.whitelist.size
        });
    }
    
    // Get security status
    getStatus() {
        return {
            connections: {
                active: this.connections.size,
                total: this.metrics.totalConnections,
                blocked: this.metrics.blockedConnections,
                limit: this.config.maxConcurrentConnections
            },
            rateLimit: {
                hits: this.metrics.rateLimitHits,
                maxPerMinute: this.config.maxRequestsPerMinute
            },
            security: {
                blacklisted: this.blacklist.size,
                whitelisted: this.whitelist.size,
                ddosAttacks: this.metrics.ddosAttacks,
                anomalies: this.metrics.anomaliesDetected
            },
            bandwidth: {
                inbound: this.metrics.bandwidth.inbound,
                outbound: this.metrics.bandwidth.outbound,
                limit: this.config.bandwidthLimit
            }
        };
    }
    
    // Export/Import security rules
    exportRules() {
        return {
            whitelist: Array.from(this.whitelist),
            blacklist: Array.from(this.blacklist.entries()).map(([ip, entry]) => ({
                ip,
                ...entry
            })),
            patterns: Array.from(this.patterns.entries()).map(([name, pattern]) => ({
                name,
                description: pattern.description
            }))
        };
    }
    
    importRules(rules) {
        if (rules.whitelist) {
            this.whitelist = new Set(rules.whitelist);
        }
        
        if (rules.blacklist) {
            this.blacklist.clear();
            for (const entry of rules.blacklist) {
                this.blacklist.set(entry.ip, {
                    reason: entry.reason,
                    details: entry.details,
                    timestamp: entry.timestamp,
                    expires: entry.expires
                });
            }
        }
    }
    
    // Validation methods
    isValidIP(ip) {
        // IPv4 validation
        const ipv4Regex = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        
        // IPv6 validation (simplified)
        const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
        
        return ipv4Regex.test(ip) || ipv6Regex.test(ip);
    }
    
    sanitizeMetadata(metadata) {
        const sanitized = {};
        const maxStringLength = 1000;
        
        for (const [key, value] of Object.entries(metadata)) {
            if (typeof value === 'string') {
                sanitized[key] = value.slice(0, maxStringLength);
            } else if (typeof value === 'number' || typeof value === 'boolean') {
                sanitized[key] = value;
            } else if (value && typeof value === 'object') {
                // Recursively sanitize nested objects (shallow)
                sanitized[key] = {};
                for (const [nestedKey, nestedValue] of Object.entries(value)) {
                    if (typeof nestedValue === 'string') {
                        sanitized[key][nestedKey] = nestedValue.slice(0, maxStringLength);
                    } else if (typeof nestedValue === 'number' || typeof nestedValue === 'boolean') {
                        sanitized[key][nestedKey] = nestedValue;
                    }
                }
            }
        }
        
        return sanitized;
    }
    
    // Cleanup method for graceful shutdown
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        if (this.rateLimitInterval) {
            clearInterval(this.rateLimitInterval);
        }
        
        this.connections.clear();
        this.connectionCounts.clear();
        this.requestCounts.clear();
        this.bandwidthUsage.clear();
        this.blacklist.clear();
        this.tempBlacklist.clear();
        this.patterns.clear();
        this.anomalies.clear();
    }
}

// Express middleware for network security
class NetworkSecurityMiddleware {
    constructor(securityManager) {
        this.security = securityManager;
        this.connections = new Map();
    }
    
    middleware() {
        return async (req, res, next) => {
            const ip = req.ip || req.connection.remoteAddress;
            const connectionId = crypto.randomBytes(32).toString('hex'); // Increased entropy
            
            // Prepare metadata
            const metadata = {
                method: req.method,
                path: req.path,
                userAgent: req.headers['user-agent'],
                headers: req.headers,
                protocol: req.protocol,
                secure: req.secure
            };
            
            // Check if connection should be allowed
            const check = await this.security.checkConnection(ip, metadata);
            
            if (!check.allowed) {
                res.status(403).json({
                    error: 'Access denied',
                    reason: check.reason
                });
                return;
            }
            
            // Track connection
            this.security.trackConnection(ip, connectionId, metadata);
            this.connections.set(connectionId, { req, res });
            
            // Track request completion
            res.on('finish', () => {
                const size = parseInt(res.get('content-length') || '0');
                this.security.updateConnection(connectionId, {
                    bytesOut: size,
                    bytesIn: parseInt(req.headers['content-length'] || '0')
                });
                this.security.removeConnection(connectionId);
                this.connections.delete(connectionId);
            });
            
            // Handle connection close
            req.on('close', () => {
                this.security.removeConnection(connectionId);
                this.connections.delete(connectionId);
            });
            
            next();
        };
    }
    
    // WebSocket protection
    wsMiddleware() {
        return async (ws, req) => {
            const ip = req.connection.remoteAddress;
            const connectionId = crypto.randomBytes(32).toString('hex'); // Increased entropy
            
            const metadata = {
                type: 'websocket',
                headers: req.headers,
                secure: req.secure
            };
            
            const check = await this.security.checkConnection(ip, metadata);
            
            if (!check.allowed) {
                ws.close(1008, 'Access denied');
                return;
            }
            
            this.security.trackConnection(ip, connectionId, metadata);
            
            ws.on('message', (data) => {
                this.security.updateConnection(connectionId, {
                    bytesIn: Buffer.byteLength(data)
                });
            });
            
            ws.on('close', () => {
                this.security.removeConnection(connectionId);
            });
        };
    }
}

module.exports = {
    NetworkSecurityManager,
    NetworkSecurityMiddleware
};