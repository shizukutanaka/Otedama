const { EventEmitter } = require('events');
const crypto = require('crypto');

class AdvancedDDoSProtection extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            // Rate limiting
            windowMs: options.windowMs || 60000,
            maxRequests: options.maxRequests || 100,
            blockDuration: options.blockDuration || 3600000,
            
            // Connection limits
            maxConnectionsPerIP: options.maxConnectionsPerIP || 10,
            maxNewConnectionsPerSecond: options.maxNewConnectionsPerSecond || 5,
            
            // Pattern detection
            suspiciousPatternThreshold: options.suspiciousPatternThreshold || 0.8,
            anomalyDetectionEnabled: options.anomalyDetectionEnabled !== false,
            
            // Challenge system
            enableProofOfWork: options.enableProofOfWork !== false,
            powDifficulty: options.powDifficulty || 4,
            
            // Geo-blocking
            enableGeoBlocking: options.enableGeoBlocking || false,
            blockedCountries: options.blockedCountries || [],
            
            ...options
        };
        
        // Tracking structures
        this.ipTracker = new Map();
        this.blockedIPs = new Map();
        this.connectionPool = new Map();
        this.patternAnalysis = new Map();
        
        // Attack detection
        this.attackIndicators = {
            synFlood: 0,
            httpFlood: 0,
            slowloris: 0,
            amplification: 0
        };
        
        // Whitelist/Blacklist
        this.whitelist = new Set(options.whitelist || []);
        this.blacklist = new Set(options.blacklist || []);
        
        // Statistics
        this.stats = {
            blocked: 0,
            challenged: 0,
            passed: 0,
            attacks: 0
        };
        
        this.initializeProtection();
    }

    initializeProtection() {
        // Start cleanup interval
        setInterval(() => this.cleanup(), 60000);
        
        // Start attack detection
        setInterval(() => this.detectAttacks(), 5000);
        
        // Initialize pattern recognition
        this.initializePatternRecognition();
    }

    async checkRequest(ip, request) {
        // Check whitelist
        if (this.whitelist.has(ip)) {
            return { allowed: true, reason: 'whitelisted' };
        }
        
        // Check blacklist
        if (this.blacklist.has(ip) || this.blockedIPs.has(ip)) {
            this.stats.blocked++;
            return { allowed: false, reason: 'blacklisted' };
        }
        
        // Check geo-blocking
        if (this.config.enableGeoBlocking) {
            const country = await this.getCountryCode(ip);
            if (this.config.blockedCountries.includes(country)) {
                return { allowed: false, reason: 'geo-blocked' };
            }
        }
        
        // Rate limiting check
        const rateLimitResult = this.checkRateLimit(ip);
        if (!rateLimitResult.allowed) {
            return rateLimitResult;
        }
        
        // Connection limit check
        const connectionResult = this.checkConnectionLimit(ip);
        if (!connectionResult.allowed) {
            return connectionResult;
        }
        
        // Pattern analysis
        const patternResult = this.analyzePattern(ip, request);
        if (patternResult.suspicious) {
            // Require proof of work
            if (this.config.enableProofOfWork) {
                return this.challengeRequest(ip, request);
            }
            return { allowed: false, reason: 'suspicious-pattern' };
        }
        
        // Track request
        this.trackRequest(ip, request);
        
        this.stats.passed++;
        return { allowed: true };
    }

    checkRateLimit(ip) {
        const now = Date.now();
        let ipData = this.ipTracker.get(ip);
        
        if (!ipData) {
            ipData = {
                requests: [],
                connections: 0,
                lastSeen: now,
                score: 100
            };
            this.ipTracker.set(ip, ipData);
        }
        
        // Remove old requests
        ipData.requests = ipData.requests.filter(
            timestamp => now - timestamp < this.config.windowMs
        );
        
        // Check limit
        if (ipData.requests.length >= this.config.maxRequests) {
            this.blockIP(ip, 'rate-limit-exceeded');
            return { allowed: false, reason: 'rate-limit' };
        }
        
        // Add current request
        ipData.requests.push(now);
        ipData.lastSeen = now;
        
        return { allowed: true };
    }

    checkConnectionLimit(ip) {
        const connections = this.connectionPool.get(ip) || 0;
        
        if (connections >= this.config.maxConnectionsPerIP) {
            return { allowed: false, reason: 'connection-limit' };
        }
        
        return { allowed: true };
    }

    analyzePattern(ip, request) {
        const patterns = this.patternAnalysis.get(ip) || {
            requests: [],
            suspicionScore: 0
        };
        
        // Add request to pattern history
        patterns.requests.push({
            timestamp: Date.now(),
            method: request.method,
            path: request.path,
            headers: this.extractHeaders(request),
            size: request.size
        });
        
        // Keep only recent requests
        const cutoff = Date.now() - 300000; // 5 minutes
        patterns.requests = patterns.requests.filter(r => r.timestamp > cutoff);
        
        // Analyze patterns
        const score = this.calculateSuspicionScore(patterns.requests);
        patterns.suspicionScore = score;
        
        this.patternAnalysis.set(ip, patterns);
        
        return {
            suspicious: score > this.config.suspiciousPatternThreshold,
            score
        };
    }

    calculateSuspicionScore(requests) {
        if (requests.length < 5) return 0;
        
        let score = 0;
        
        // Check request frequency
        const timeDeltas = [];
        for (let i = 1; i < requests.length; i++) {
            timeDeltas.push(requests[i].timestamp - requests[i-1].timestamp);
        }
        
        const avgDelta = timeDeltas.reduce((a, b) => a + b) / timeDeltas.length;
        const variance = timeDeltas.reduce((sum, delta) => 
            sum + Math.pow(delta - avgDelta, 2), 0) / timeDeltas.length;
        
        // Low variance = automated behavior
        if (variance < 100) score += 0.3;
        
        // Check for repeated patterns
        const paths = requests.map(r => r.path);
        const uniquePaths = new Set(paths).size;
        const pathRatio = uniquePaths / paths.length;
        
        if (pathRatio < 0.2) score += 0.3;
        
        // Check user agent consistency
        const userAgents = requests.map(r => r.headers['user-agent']).filter(Boolean);
        const uniqueAgents = new Set(userAgents).size;
        
        if (uniqueAgents > 3) score += 0.2;
        
        // Check for missing common headers
        const missingHeaders = requests.filter(r => 
            !r.headers['accept'] || !r.headers['accept-language']
        ).length;
        
        if (missingHeaders > requests.length * 0.5) score += 0.2;
        
        return Math.min(1, score);
    }

    challengeRequest(ip, request) {
        const challenge = this.generateChallenge();
        
        this.stats.challenged++;
        
        return {
            allowed: false,
            reason: 'challenge-required',
            challenge: {
                type: 'proof-of-work',
                difficulty: this.config.powDifficulty,
                challenge: challenge.challenge,
                id: challenge.id
            }
        };
    }

    generateChallenge() {
        const id = crypto.randomBytes(16).toString('hex');
        const challenge = crypto.randomBytes(32).toString('hex');
        
        // Store challenge for verification
        this.challengeStore = this.challengeStore || new Map();
        this.challengeStore.set(id, {
            challenge,
            created: Date.now(),
            attempts: 0
        });
        
        return { id, challenge };
    }

    verifyChallenge(id, solution) {
        const stored = this.challengeStore?.get(id);
        if (!stored) return false;
        
        // Check expiry (5 minutes)
        if (Date.now() - stored.created > 300000) {
            this.challengeStore.delete(id);
            return false;
        }
        
        // Check attempts
        stored.attempts++;
        if (stored.attempts > 10) {
            this.challengeStore.delete(id);
            return false;
        }
        
        // Verify proof of work
        const hash = crypto.createHash('sha256')
            .update(stored.challenge + solution)
            .digest('hex');
        
        const difficulty = '0'.repeat(this.config.powDifficulty);
        const valid = hash.startsWith(difficulty);
        
        if (valid) {
            this.challengeStore.delete(id);
        }
        
        return valid;
    }

    trackConnection(ip, socketId) {
        const connections = this.connectionPool.get(ip) || 0;
        this.connectionPool.set(ip, connections + 1);
        
        // Track socket for cleanup
        if (!this.socketMap) this.socketMap = new Map();
        this.socketMap.set(socketId, ip);
    }

    releaseConnection(socketId) {
        if (!this.socketMap) return;
        
        const ip = this.socketMap.get(socketId);
        if (ip) {
            const connections = this.connectionPool.get(ip) || 0;
            if (connections > 0) {
                this.connectionPool.set(ip, connections - 1);
            }
            this.socketMap.delete(socketId);
        }
    }

    detectAttacks() {
        // Reset indicators
        for (const key in this.attackIndicators) {
            this.attackIndicators[key] *= 0.9; // Decay
        }
        
        // Analyze current traffic
        const now = Date.now();
        const recentWindow = 10000; // 10 seconds
        
        let totalRequests = 0;
        let uniqueIPs = new Set();
        let synPackets = 0;
        
        for (const [ip, data] of this.ipTracker) {
            const recentRequests = data.requests.filter(
                t => now - t < recentWindow
            ).length;
            
            totalRequests += recentRequests;
            if (recentRequests > 0) uniqueIPs.add(ip);
            
            // Check for SYN flood pattern
            if (recentRequests > 50) synPackets++;
        }
        
        // SYN flood detection
        if (synPackets > uniqueIPs.size * 0.3) {
            this.attackIndicators.synFlood = Math.min(1, 
                this.attackIndicators.synFlood + 0.3);
        }
        
        // HTTP flood detection
        const requestRate = totalRequests / (recentWindow / 1000);
        if (requestRate > this.config.maxNewConnectionsPerSecond * 10) {
            this.attackIndicators.httpFlood = Math.min(1,
                this.attackIndicators.httpFlood + 0.3);
        }
        
        // Trigger mitigation if attack detected
        const maxIndicator = Math.max(...Object.values(this.attackIndicators));
        if (maxIndicator > 0.7) {
            this.activateMitigation(maxIndicator);
        }
    }

    activateMitigation(severity) {
        this.stats.attacks++;
        
        this.emit('attack:detected', {
            severity,
            indicators: { ...this.attackIndicators },
            timestamp: Date.now()
        });
        
        // Increase rate limits
        const factor = 1 - (severity * 0.5);
        this.config.maxRequests = Math.floor(this.config.maxRequests * factor);
        this.config.maxConnectionsPerIP = Math.floor(
            this.config.maxConnectionsPerIP * factor
        );
        
        // Enable stricter checking
        this.config.suspiciousPatternThreshold *= factor;
        
        // Schedule recovery
        setTimeout(() => this.recoverFromMitigation(), 300000); // 5 minutes
    }

    recoverFromMitigation() {
        // Restore original limits
        this.config.maxRequests = this.originalConfig?.maxRequests || 100;
        this.config.maxConnectionsPerIP = 
            this.originalConfig?.maxConnectionsPerIP || 10;
        this.config.suspiciousPatternThreshold = 
            this.originalConfig?.suspiciousPatternThreshold || 0.8;
        
        this.emit('attack:mitigated');
    }

    blockIP(ip, reason) {
        this.blockedIPs.set(ip, {
            reason,
            timestamp: Date.now(),
            expires: Date.now() + this.config.blockDuration
        });
        
        this.stats.blocked++;
        
        this.emit('ip:blocked', { ip, reason });
    }

    unblockIP(ip) {
        this.blockedIPs.delete(ip);
        this.emit('ip:unblocked', { ip });
    }

    cleanup() {
        const now = Date.now();
        
        // Clean expired blocks
        for (const [ip, block] of this.blockedIPs) {
            if (now > block.expires) {
                this.blockedIPs.delete(ip);
            }
        }
        
        // Clean old tracking data
        for (const [ip, data] of this.ipTracker) {
            if (now - data.lastSeen > 3600000) { // 1 hour
                this.ipTracker.delete(ip);
                this.patternAnalysis.delete(ip);
            }
        }
        
        // Clean old challenges
        if (this.challengeStore) {
            for (const [id, challenge] of this.challengeStore) {
                if (now - challenge.created > 300000) { // 5 minutes
                    this.challengeStore.delete(id);
                }
            }
        }
    }

    extractHeaders(request) {
        const important = [
            'user-agent',
            'accept',
            'accept-language',
            'accept-encoding',
            'referer'
        ];
        
        const headers = {};
        for (const header of important) {
            if (request.headers?.[header]) {
                headers[header] = request.headers[header];
            }
        }
        
        return headers;
    }

    async getCountryCode(ip) {
        // Simplified - would use actual GeoIP database
        return 'US';
    }

    trackRequest(ip, request) {
        // Additional tracking for analytics
        const hour = new Date().getHours();
        
        if (!this.hourlyStats) this.hourlyStats = new Array(24).fill(0);
        this.hourlyStats[hour]++;
    }

    getStatus() {
        return {
            stats: { ...this.stats },
            blocked: this.blockedIPs.size,
            tracked: this.ipTracker.size,
            connections: Array.from(this.connectionPool.values())
                .reduce((a, b) => a + b, 0),
            attackIndicators: { ...this.attackIndicators },
            limits: {
                maxRequests: this.config.maxRequests,
                maxConnections: this.config.maxConnectionsPerIP
            }
        };
    }

    exportRules() {
        return {
            whitelist: Array.from(this.whitelist),
            blacklist: Array.from(this.blacklist),
            blocked: Array.from(this.blockedIPs.entries()).map(([ip, data]) => ({
                ip,
                ...data
            }))
        };
    }

    importRules(rules) {
        if (rules.whitelist) {
            this.whitelist = new Set(rules.whitelist);
        }
        if (rules.blacklist) {
            this.blacklist = new Set(rules.blacklist);
        }
    }
}

module.exports = AdvancedDDoSProtection;