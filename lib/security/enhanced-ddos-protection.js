/**
 * Enhanced DDoS Protection System
 * Multi-layered protection against various DDoS attack types
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const cluster = require('cluster');

class EnhancedDDoSProtection extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Connection limits
            maxConnectionsPerIP: config.maxConnectionsPerIP || 100,
            maxGlobalConnections: config.maxGlobalConnections || 10000,
            connectionBurstSize: config.connectionBurstSize || 50,
            
            // Rate limiting
            requestsPerMinute: config.requestsPerMinute || 600,
            requestsPerSecond: config.requestsPerSecond || 20,
            requestBurstSize: config.requestBurstSize || 100,
            
            // Bandwidth limits
            bandwidthPerIP: config.bandwidthPerIP || 10 * 1024 * 1024, // 10MB/s
            globalBandwidth: config.globalBandwidth || 1024 * 1024 * 1024, // 1GB/s
            
            // Attack detection thresholds
            synFloodThreshold: config.synFloodThreshold || 1000,
            udpFloodThreshold: config.udpFloodThreshold || 5000,
            httpFloodThreshold: config.httpFloodThreshold || 100,
            slowlorisTimeout: config.slowlorisTimeout || 30000,
            
            // Mitigation settings
            blacklistDuration: config.blacklistDuration || 3600000, // 1 hour
            greylistDuration: config.greylistDuration || 300000, // 5 minutes
            challengeTimeout: config.challengeTimeout || 60000, // 1 minute
            
            // Advanced features
            enableSynCookies: config.enableSynCookies !== false,
            enableRateLimitBypass: config.enableRateLimitBypass || true,
            enableGeoBlocking: config.enableGeoBlocking || false,
            enableBehaviorAnalysis: config.enableBehaviorAnalysis !== false,
            
            // Clustering
            enableClustering: cluster.isMaster && config.enableClustering !== false,
            
            ...config
        };
        
        // State management
        this.connections = new Map();
        this.requestRates = new Map();
        this.bandwidthUsage = new Map();
        this.blacklist = new Map();
        this.greylist = new Map();
        this.whitelist = new Set(config.whitelist || []);
        this.challenges = new Map();
        
        // Attack detection state
        this.attackPatterns = new Map();
        this.suspiciousIPs = new Map();
        this.attackMetrics = {
            synFlood: { count: 0, lastSeen: 0 },
            udpFlood: { count: 0, lastSeen: 0 },
            httpFlood: { count: 0, lastSeen: 0 },
            slowloris: { count: 0, lastSeen: 0 },
            amplification: { count: 0, lastSeen: 0 }
        };
        
        // Initialize components
        this.initializeFilters();
        this.startMonitoring();
    }
    
    /**
     * Initialize attack filters
     */
    initializeFilters() {
        // SYN flood filter
        this.addFilter('synFlood', {
            detect: (packet) => {
                return packet.flags === 'SYN' && !packet.ack;
            },
            mitigate: (ip) => {
                if (this.config.enableSynCookies) {
                    return this.generateSynCookie(ip);
                }
                this.blacklist.set(ip, {
                    reason: 'SYN flood',
                    expires: Date.now() + this.config.blacklistDuration
                });
            }
        });
        
        // UDP flood filter
        this.addFilter('udpFlood', {
            detect: (packet) => {
                return packet.protocol === 'UDP' && packet.size > 512;
            },
            mitigate: (ip) => {
                this.rateLimit(ip, 'udp', 10); // Strict rate limit
            }
        });
        
        // HTTP flood filter
        this.addFilter('httpFlood', {
            detect: (request) => {
                const rate = this.getRequestRate(request.ip);
                return rate > this.config.httpFloodThreshold;
            },
            mitigate: (ip) => {
                this.issueChallenge(ip);
            }
        });
        
        // Slowloris filter
        this.addFilter('slowloris', {
            detect: (connection) => {
                return connection.duration > this.config.slowlorisTimeout &&
                       connection.bytesReceived < 1000;
            },
            mitigate: (ip) => {
                this.dropConnection(ip);
                this.greylist.set(ip, {
                    reason: 'Slowloris attack',
                    expires: Date.now() + this.config.greylistDuration
                });
            }
        });
        
        // Amplification attack filter
        this.addFilter('amplification', {
            detect: (packet) => {
                return packet.responseSize > packet.requestSize * 10;
            },
            mitigate: (ip) => {
                this.rateLimit(ip, 'amplification', 1);
            }
        });
    }
    
    /**
     * Add custom filter
     */
    addFilter(name, filter) {
        this.attackPatterns.set(name, filter);
    }
    
    /**
     * Check incoming connection
     */
    async checkConnection(ip, metadata = {}) {
        // Check whitelist
        if (this.whitelist.has(ip)) {
            return { allowed: true, bypass: true };
        }
        
        // Check blacklist
        const blacklistEntry = this.blacklist.get(ip);
        if (blacklistEntry) {
            if (Date.now() < blacklistEntry.expires) {
                this.emit('connection-blocked', { ip, reason: blacklistEntry.reason });
                return { allowed: false, reason: 'blacklisted' };
            }
            this.blacklist.delete(ip);
        }
        
        // Check greylist
        const greylistEntry = this.greylist.get(ip);
        if (greylistEntry) {
            if (Date.now() < greylistEntry.expires) {
                // Require challenge
                return this.requireChallenge(ip);
            }
            this.greylist.delete(ip);
        }
        
        // Check connection limits
        const connectionCheck = this.checkConnectionLimits(ip);
        if (!connectionCheck.allowed) {
            return connectionCheck;
        }
        
        // Check rate limits
        const rateCheck = this.checkRateLimits(ip);
        if (!rateCheck.allowed) {
            return rateCheck;
        }
        
        // Check bandwidth limits
        const bandwidthCheck = this.checkBandwidthLimits(ip);
        if (!bandwidthCheck.allowed) {
            return bandwidthCheck;
        }
        
        // Detect attack patterns
        const attackDetected = await this.detectAttack(ip, metadata);
        if (attackDetected) {
            return { allowed: false, reason: attackDetected.type };
        }
        
        // Behavior analysis
        if (this.config.enableBehaviorAnalysis) {
            const behaviorScore = this.analyzeBehavior(ip, metadata);
            if (behaviorScore > 0.8) {
                this.greylist.set(ip, {
                    reason: 'Suspicious behavior',
                    expires: Date.now() + this.config.greylistDuration
                });
                return this.requireChallenge(ip);
            }
        }
        
        return { allowed: true };
    }
    
    /**
     * Check connection limits
     */
    checkConnectionLimits(ip) {
        const ipConnections = this.connections.get(ip) || 0;
        
        // Per-IP limit
        if (ipConnections >= this.config.maxConnectionsPerIP) {
            this.emit('limit-exceeded', { ip, type: 'connections', count: ipConnections });
            return { allowed: false, reason: 'connection_limit' };
        }
        
        // Global limit
        const totalConnections = Array.from(this.connections.values())
            .reduce((sum, count) => sum + count, 0);
            
        if (totalConnections >= this.config.maxGlobalConnections) {
            return { allowed: false, reason: 'server_full' };
        }
        
        return { allowed: true };
    }
    
    /**
     * Check rate limits
     */
    checkRateLimits(ip) {
        const now = Date.now();
        let rateData = this.requestRates.get(ip);
        
        if (!rateData) {
            rateData = {
                tokens: this.config.requestBurstSize,
                lastRefill: now,
                minuteCount: 0,
                minuteStart: now
            };
            this.requestRates.set(ip, rateData);
        }
        
        // Token bucket algorithm
        const elapsed = now - rateData.lastRefill;
        const tokensToAdd = (elapsed / 1000) * this.config.requestsPerSecond;
        rateData.tokens = Math.min(
            this.config.requestBurstSize,
            rateData.tokens + tokensToAdd
        );
        rateData.lastRefill = now;
        
        // Check minute rate
        if (now - rateData.minuteStart > 60000) {
            rateData.minuteCount = 0;
            rateData.minuteStart = now;
        }
        
        if (rateData.minuteCount >= this.config.requestsPerMinute) {
            this.emit('rate-limit-exceeded', { ip, type: 'minute' });
            return { allowed: false, reason: 'rate_limit_minute' };
        }
        
        // Check token bucket
        if (rateData.tokens < 1) {
            this.emit('rate-limit-exceeded', { ip, type: 'burst' });
            return { allowed: false, reason: 'rate_limit_burst' };
        }
        
        // Consume token
        rateData.tokens--;
        rateData.minuteCount++;
        
        return { allowed: true, remaining: Math.floor(rateData.tokens) };
    }
    
    /**
     * Check bandwidth limits
     */
    checkBandwidthLimits(ip) {
        const usage = this.bandwidthUsage.get(ip) || { in: 0, out: 0, timestamp: Date.now() };
        const now = Date.now();
        
        // Reset if window expired
        if (now - usage.timestamp > 1000) {
            usage.in = 0;
            usage.out = 0;
            usage.timestamp = now;
        }
        
        const totalUsage = usage.in + usage.out;
        if (totalUsage > this.config.bandwidthPerIP) {
            this.emit('bandwidth-exceeded', { ip, usage: totalUsage });
            return { allowed: false, reason: 'bandwidth_limit' };
        }
        
        this.bandwidthUsage.set(ip, usage);
        return { allowed: true };
    }
    
    /**
     * Detect attack patterns
     */
    async detectAttack(ip, metadata) {
        for (const [type, filter] of this.attackPatterns) {
            if (filter.detect(metadata)) {
                this.attackMetrics[type].count++;
                this.attackMetrics[type].lastSeen = Date.now();
                
                // Apply mitigation
                if (filter.mitigate) {
                    await filter.mitigate(ip);
                }
                
                this.emit('attack-detected', { ip, type, metadata });
                return { type, detected: true };
            }
        }
        
        return null;
    }
    
    /**
     * Analyze behavior for anomalies
     */
    analyzeBehavior(ip, metadata) {
        let score = 0;
        const suspicious = this.suspiciousIPs.get(ip) || { score: 0, flags: [] };
        
        // Check user agent
        if (!metadata.userAgent || metadata.userAgent.length < 10) {
            score += 0.2;
            suspicious.flags.push('missing_user_agent');
        }
        
        // Check request patterns
        const requests = this.getRecentRequests(ip);
        if (requests.length > 10) {
            const intervals = [];
            for (let i = 1; i < requests.length; i++) {
                intervals.push(requests[i].timestamp - requests[i-1].timestamp);
            }
            
            // Check for robotic timing
            const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
            const variance = intervals.reduce((sum, interval) => 
                sum + Math.pow(interval - avgInterval, 2), 0) / intervals.length;
                
            if (variance < 100) { // Very consistent timing
                score += 0.3;
                suspicious.flags.push('robotic_timing');
            }
        }
        
        // Check for scanner patterns
        if (metadata.path && this.isScannerPath(metadata.path)) {
            score += 0.4;
            suspicious.flags.push('scanner_pattern');
        }
        
        // Check for proxy headers
        const proxyHeaders = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip'];
        const hasMultipleProxyHeaders = proxyHeaders.filter(h => 
            metadata.headers && metadata.headers[h]
        ).length > 1;
        
        if (hasMultipleProxyHeaders) {
            score += 0.2;
            suspicious.flags.push('multiple_proxy_headers');
        }
        
        // Update suspicious IP tracking
        suspicious.score = score;
        this.suspiciousIPs.set(ip, suspicious);
        
        return score;
    }
    
    /**
     * Issue challenge to verify legitimate user
     */
    requireChallenge(ip) {
        const challenge = {
            id: crypto.randomBytes(16).toString('hex'),
            type: 'proof_of_work',
            difficulty: 4,
            issued: Date.now(),
            expires: Date.now() + this.config.challengeTimeout
        };
        
        this.challenges.set(ip, challenge);
        
        return {
            allowed: false,
            reason: 'challenge_required',
            challenge: {
                id: challenge.id,
                type: challenge.type,
                difficulty: challenge.difficulty
            }
        };
    }
    
    /**
     * Verify challenge response
     */
    verifyChallenge(ip, response) {
        const challenge = this.challenges.get(ip);
        if (!challenge) {
            return { valid: false, reason: 'no_challenge' };
        }
        
        if (Date.now() > challenge.expires) {
            this.challenges.delete(ip);
            return { valid: false, reason: 'challenge_expired' };
        }
        
        // Verify proof of work
        if (challenge.type === 'proof_of_work') {
            const hash = crypto.createHash('sha256')
                .update(challenge.id + response.nonce)
                .digest('hex');
                
            const leadingZeros = hash.match(/^0*/)[0].length;
            if (leadingZeros >= challenge.difficulty) {
                this.challenges.delete(ip);
                // Add to temporary whitelist
                this.addTemporaryWhitelist(ip, 3600000); // 1 hour
                return { valid: true };
            }
        }
        
        return { valid: false, reason: 'invalid_solution' };
    }
    
    /**
     * Generate SYN cookie
     */
    generateSynCookie(ip) {
        const timestamp = Math.floor(Date.now() / 60000); // 1 minute precision
        const secret = crypto.randomBytes(32);
        
        const cookie = crypto.createHmac('sha256', secret)
            .update(ip + timestamp)
            .digest('hex')
            .substring(0, 8);
            
        return cookie;
    }
    
    /**
     * Rate limit specific traffic type
     */
    rateLimit(ip, type, limit) {
        const key = `${ip}:${type}`;
        const current = this.requestRates.get(key) || 0;
        
        if (current >= limit) {
            this.blacklist.set(ip, {
                reason: `Rate limit exceeded: ${type}`,
                expires: Date.now() + this.config.greylistDuration
            });
            return false;
        }
        
        this.requestRates.set(key, current + 1);
        return true;
    }
    
    /**
     * Drop connection
     */
    dropConnection(ip) {
        this.emit('drop-connection', { ip });
        const count = this.connections.get(ip) || 0;
        if (count > 0) {
            this.connections.set(ip, count - 1);
        }
    }
    
    /**
     * Add to temporary whitelist
     */
    addTemporaryWhitelist(ip, duration) {
        this.whitelist.add(ip);
        setTimeout(() => {
            this.whitelist.delete(ip);
        }, duration);
    }
    
    /**
     * Get recent requests for analysis
     */
    getRecentRequests(ip) {
        // Implementation would maintain request history
        return [];
    }
    
    /**
     * Check if path matches scanner patterns
     */
    isScannerPath(path) {
        const scannerPaths = [
            '/admin', '/wp-admin', '/phpmyadmin', '/.env',
            '/config', '/backup', '/.git', '/api/v1',
            '/login', '/dashboard', '/cpanel'
        ];
        
        return scannerPaths.some(p => path.startsWith(p));
    }
    
    /**
     * Update connection tracking
     */
    trackConnection(ip, action) {
        const count = this.connections.get(ip) || 0;
        
        if (action === 'add') {
            this.connections.set(ip, count + 1);
        } else if (action === 'remove' && count > 0) {
            this.connections.set(ip, count - 1);
            if (count <= 1) {
                this.connections.delete(ip);
            }
        }
    }
    
    /**
     * Update bandwidth usage
     */
    updateBandwidth(ip, direction, bytes) {
        const usage = this.bandwidthUsage.get(ip) || { 
            in: 0, 
            out: 0, 
            timestamp: Date.now() 
        };
        
        usage[direction] += bytes;
        this.bandwidthUsage.set(ip, usage);
    }
    
    /**
     * Start monitoring and cleanup
     */
    startMonitoring() {
        // Cleanup expired entries
        setInterval(() => {
            this.cleanup();
        }, 60000); // Every minute
        
        // Reset rate limits
        setInterval(() => {
            this.requestRates.clear();
            this.bandwidthUsage.clear();
        }, 60000); // Every minute
        
        // Monitor attack metrics
        setInterval(() => {
            this.monitorAttackMetrics();
        }, 5000); // Every 5 seconds
    }
    
    /**
     * Cleanup expired entries
     */
    cleanup() {
        const now = Date.now();
        
        // Clean blacklist
        for (const [ip, entry] of this.blacklist) {
            if (now > entry.expires) {
                this.blacklist.delete(ip);
            }
        }
        
        // Clean greylist
        for (const [ip, entry] of this.greylist) {
            if (now > entry.expires) {
                this.greylist.delete(ip);
            }
        }
        
        // Clean expired challenges
        for (const [ip, challenge] of this.challenges) {
            if (now > challenge.expires) {
                this.challenges.delete(ip);
            }
        }
        
        // Clean suspicious IPs
        if (this.suspiciousIPs.size > 10000) {
            // Keep only recent entries
            const sorted = Array.from(this.suspiciousIPs.entries())
                .sort((a, b) => b[1].score - a[1].score)
                .slice(0, 5000);
                
            this.suspiciousIPs = new Map(sorted);
        }
    }
    
    /**
     * Monitor attack metrics
     */
    monitorAttackMetrics() {
        const now = Date.now();
        let underAttack = false;
        
        for (const [type, metric] of Object.entries(this.attackMetrics)) {
            // Check if attack is ongoing
            if (metric.count > this.config[`${type}Threshold`]) {
                if (now - metric.lastSeen < 60000) { // Within last minute
                    underAttack = true;
                    this.emit('attack-ongoing', { type, count: metric.count });
                }
            }
            
            // Reset old metrics
            if (now - metric.lastSeen > 300000) { // 5 minutes
                metric.count = 0;
            }
        }
        
        if (underAttack) {
            this.activatePanicMode();
        }
    }
    
    /**
     * Activate panic mode during severe attacks
     */
    activatePanicMode() {
        this.emit('panic-mode-activated');
        
        // Reduce limits
        this.config.maxConnectionsPerIP = Math.floor(this.config.maxConnectionsPerIP / 2);
        this.config.requestsPerMinute = Math.floor(this.config.requestsPerMinute / 2);
        
        // Schedule recovery
        setTimeout(() => {
            this.deactivatePanicMode();
        }, 300000); // 5 minutes
    }
    
    /**
     * Deactivate panic mode
     */
    deactivatePanicMode() {
        this.emit('panic-mode-deactivated');
        
        // Restore normal limits
        this.config.maxConnectionsPerIP = this.config.maxConnectionsPerIP * 2;
        this.config.requestsPerMinute = this.config.requestsPerMinute * 2;
    }
    
    /**
     * Get current status
     */
    getStatus() {
        return {
            connections: {
                total: Array.from(this.connections.values()).reduce((a, b) => a + b, 0),
                unique: this.connections.size
            },
            blacklist: this.blacklist.size,
            greylist: this.greylist.size,
            whitelist: this.whitelist.size,
            challenges: this.challenges.size,
            attacks: this.attackMetrics,
            suspicious: this.suspiciousIPs.size
        };
    }
}

/**
 * Express middleware for DDoS protection
 */
class DDoSProtectionMiddleware {
    constructor(ddosProtection) {
        this.protection = ddosProtection;
    }
    
    middleware() {
        return async (req, res, next) => {
            const ip = req.ip || req.connection.remoteAddress;
            
            // Prepare metadata
            const metadata = {
                method: req.method,
                path: req.path,
                userAgent: req.headers['user-agent'],
                headers: req.headers,
                protocol: req.protocol,
                size: parseInt(req.headers['content-length'] || '0')
            };
            
            // Check if connection is allowed
            const check = await this.protection.checkConnection(ip, metadata);
            
            if (!check.allowed) {
                if (check.reason === 'challenge_required') {
                    res.status(429).json({
                        error: 'Too many requests',
                        challenge: check.challenge
                    });
                } else {
                    res.status(403).json({
                        error: 'Access denied',
                        reason: check.reason
                    });
                }
                return;
            }
            
            // Track connection
            this.protection.trackConnection(ip, 'add');
            
            // Track bandwidth
            req.on('data', (chunk) => {
                this.protection.updateBandwidth(ip, 'in', chunk.length);
            });
            
            res.on('finish', () => {
                const size = parseInt(res.get('content-length') || '0');
                this.protection.updateBandwidth(ip, 'out', size);
                this.protection.trackConnection(ip, 'remove');
            });
            
            req.on('close', () => {
                this.protection.trackConnection(ip, 'remove');
            });
            
            next();
        };
    }
    
    /**
     * Challenge verification endpoint
     */
    verifyChallengeEndpoint() {
        return async (req, res) => {
            const ip = req.ip || req.connection.remoteAddress;
            const { challengeId, nonce } = req.body;
            
            const result = this.protection.verifyChallenge(ip, {
                challengeId,
                nonce
            });
            
            if (result.valid) {
                res.json({ success: true, message: 'Challenge completed' });
            } else {
                res.status(400).json({ 
                    success: false, 
                    reason: result.reason 
                });
            }
        };
    }
}

module.exports = {
    EnhancedDDoSProtection,
    DDoSProtectionMiddleware
};