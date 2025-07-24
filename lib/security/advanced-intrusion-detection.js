/**
 * Advanced Intrusion Detection System
 * Real-time threat detection and prevention
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const ml = require('ml-regression');

class AdvancedIntrusionDetection extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Detection thresholds
            anomalyThreshold: config.anomalyThreshold || 0.8,
            threatScoreThreshold: config.threatScoreThreshold || 0.7,
            
            // Attack signatures
            enableSignatureDetection: config.enableSignatureDetection !== false,
            enableAnomalyDetection: config.enableAnomalyDetection !== false,
            enableBehaviorAnalysis: config.enableBehaviorAnalysis !== false,
            enableMachineLearning: config.enableMachineLearning || false,
            
            // Response actions
            autoBlock: config.autoBlock !== false,
            blockDuration: config.blockDuration || 3600000, // 1 hour
            alertThreshold: config.alertThreshold || 'medium',
            
            // Analysis settings
            contextWindow: config.contextWindow || 300000, // 5 minutes
            maxRequestsPerAnalysis: config.maxRequestsPerAnalysis || 1000,
            
            // Machine learning
            mlModelPath: config.mlModelPath || null,
            mlUpdateInterval: config.mlUpdateInterval || 3600000, // 1 hour
            
            ...config
        };
        
        // Threat signatures database
        this.signatures = new Map();
        this.loadSignatures();
        
        // User behavior profiles
        this.userProfiles = new Map();
        this.ipProfiles = new Map();
        
        // Active threats
        this.activeThreats = new Map();
        this.blockedEntities = new Map();
        
        // Request history for analysis
        this.requestHistory = [];
        this.maxHistorySize = 10000;
        
        // Machine learning model
        this.mlModel = null;
        if (this.config.enableMachineLearning) {
            this.initializeMachineLearning();
        }
        
        // Metrics
        this.metrics = {
            requestsAnalyzed: 0,
            threatsDetected: 0,
            falsePositives: 0,
            blockedRequests: 0,
            detectionTypes: {
                signature: 0,
                anomaly: 0,
                behavior: 0,
                ml: 0
            }
        };
        
        // Start monitoring
        this.startMonitoring();
    }
    
    /**
     * Load attack signatures
     */
    loadSignatures() {
        // SQL Injection signatures
        this.addSignature('sql_injection', {
            patterns: [
                /(\b(union|select|insert|update|delete|drop|create|alter|exec|execute)\b.*\b(from|where|table|database)\b)/gi,
                /(\b(and|or)\b.*=.*)/gi,
                /(\'|\").*(\b(or|and)\b).*(\1).*=/gi,
                /(\b(waitfor|benchmark|sleep)\b.*\()/gi
            ],
            severity: 'high',
            category: 'injection'
        });
        
        // XSS signatures
        this.addSignature('xss', {
            patterns: [
                /<script[^>]*>[\s\S]*?<\/script>/gi,
                /javascript:\s*[^"']+/gi,
                /on\w+\s*=\s*["'][^"']+["']/gi,
                /<iframe[^>]*>[\s\S]*?<\/iframe>/gi,
                /<object[^>]*>[\s\S]*?<\/object>/gi,
                /document\.(cookie|write|location)/gi
            ],
            severity: 'high',
            category: 'injection'
        });
        
        // Command Injection signatures
        this.addSignature('command_injection', {
            patterns: [
                /[;&|`$\(\)]/g,
                /\$\{.*\}/g,
                /\b(nc|netcat|bash|sh|cmd|powershell)\b.*[;&|]/gi,
                /\b(wget|curl)\b.*http/gi
            ],
            severity: 'critical',
            category: 'injection'
        });
        
        // Path Traversal signatures
        this.addSignature('path_traversal', {
            patterns: [
                /\.\.[\/\\]/g,
                /\.\.%2[fF]/g,
                /\.\.\x5c/g,
                /(\/etc\/passwd|\/windows\/system32)/gi
            ],
            severity: 'high',
            category: 'traversal'
        });
        
        // LDAP Injection signatures
        this.addSignature('ldap_injection', {
            patterns: [
                /[)(|&*]/g,
                /\(\|\(/g,
                /\)\(\*/g
            ],
            severity: 'medium',
            category: 'injection'
        });
        
        // XXE signatures
        this.addSignature('xxe', {
            patterns: [
                /<!DOCTYPE[^>]*\[/gi,
                /<!ENTITY[^>]*>/gi,
                /SYSTEM\s+["'][^"']*["']/gi
            ],
            severity: 'high',
            category: 'injection'
        });
        
        // Reconnaissance signatures
        this.addSignature('reconnaissance', {
            patterns: [
                /\/(admin|wp-admin|phpmyadmin|cpanel)/gi,
                /\.(git|svn|env|config|backup)/gi,
                /\/(api|swagger|graphql)$/gi
            ],
            severity: 'low',
            category: 'recon'
        });
        
        // Bot/Scanner signatures
        this.addSignature('bot_scanner', {
            patterns: [
                /bot|crawler|spider|scraper/gi,
                /nikto|nmap|masscan|sqlmap/gi,
                /burp|zaproxy|acunetix/gi
            ],
            severity: 'medium',
            category: 'scanner',
            checkUserAgent: true
        });
    }
    
    /**
     * Add custom signature
     */
    addSignature(name, signature) {
        this.signatures.set(name, signature);
    }
    
    /**
     * Analyze request for threats
     */
    async analyze(request) {
        this.metrics.requestsAnalyzed++;
        
        const analysis = {
            timestamp: Date.now(),
            threats: [],
            anomalies: [],
            score: 0,
            blocked: false
        };
        
        // Add to history
        this.addToHistory(request);
        
        // Check if already blocked
        if (this.isBlocked(request.ip) || this.isBlocked(request.userId)) {
            analysis.blocked = true;
            analysis.reason = 'Previously blocked entity';
            return analysis;
        }
        
        // Signature-based detection
        if (this.config.enableSignatureDetection) {
            const signatureThreats = this.detectSignatures(request);
            analysis.threats.push(...signatureThreats);
        }
        
        // Anomaly detection
        if (this.config.enableAnomalyDetection) {
            const anomalies = await this.detectAnomalies(request);
            analysis.anomalies.push(...anomalies);
        }
        
        // Behavior analysis
        if (this.config.enableBehaviorAnalysis) {
            const behaviorThreats = this.analyzeBehavior(request);
            analysis.threats.push(...behaviorThreats);
        }
        
        // Machine learning detection
        if (this.config.enableMachineLearning && this.mlModel) {
            const mlScore = await this.mlPredict(request);
            if (mlScore > this.config.threatScoreThreshold) {
                analysis.threats.push({
                    type: 'ml_detection',
                    severity: this.scoreToSeverity(mlScore),
                    confidence: mlScore,
                    details: 'Machine learning model detected suspicious activity'
                });
                this.metrics.detectionTypes.ml++;
            }
        }
        
        // Calculate overall threat score
        analysis.score = this.calculateThreatScore(analysis);
        
        // Determine if request should be blocked
        if (analysis.score > this.config.threatScoreThreshold) {
            analysis.blocked = true;
            analysis.severity = this.scoreToSeverity(analysis.score);
            
            if (this.config.autoBlock) {
                this.blockEntity(request.ip, 'Threat detected', this.config.blockDuration);
                if (request.userId) {
                    this.blockEntity(request.userId, 'Threat detected', this.config.blockDuration);
                }
            }
            
            this.metrics.threatsDetected++;
            this.metrics.blockedRequests++;
            
            // Emit alert
            this.emit('threat-detected', {
                request,
                analysis,
                timestamp: new Date().toISOString()
            });
        }
        
        // Update profiles
        this.updateProfiles(request, analysis);
        
        return {
            detected: analysis.threats.length > 0 || analysis.anomalies.length > 0,
            blocked: analysis.blocked,
            score: analysis.score,
            severity: this.scoreToSeverity(analysis.score),
            threats: analysis.threats,
            anomalies: analysis.anomalies
        };
    }
    
    /**
     * Detect signature-based threats
     */
    detectSignatures(request) {
        const threats = [];
        const dataToCheck = [
            request.path,
            request.query ? JSON.stringify(request.query) : '',
            request.body ? JSON.stringify(request.body) : '',
            request.headers ? JSON.stringify(request.headers) : ''
        ].join(' ');
        
        for (const [name, signature] of this.signatures) {
            // Check user agent if specified
            if (signature.checkUserAgent && request.headers?.['user-agent']) {
                const userAgent = request.headers['user-agent'];
                for (const pattern of signature.patterns) {
                    if (pattern.test(userAgent)) {
                        threats.push({
                            type: name,
                            severity: signature.severity,
                            category: signature.category,
                            pattern: pattern.toString(),
                            location: 'user-agent'
                        });
                        this.metrics.detectionTypes.signature++;
                        break;
                    }
                }
            }
            
            // Check all data
            for (const pattern of signature.patterns) {
                if (pattern.test(dataToCheck)) {
                    threats.push({
                        type: name,
                        severity: signature.severity,
                        category: signature.category,
                        pattern: pattern.toString(),
                        location: 'request'
                    });
                    this.metrics.detectionTypes.signature++;
                    break;
                }
            }
        }
        
        return threats;
    }
    
    /**
     * Detect anomalies
     */
    async detectAnomalies(request) {
        const anomalies = [];
        
        // Get baseline for comparison
        const ipProfile = this.ipProfiles.get(request.ip) || this.createProfile();
        const userProfile = request.userId ? 
            this.userProfiles.get(request.userId) || this.createProfile() : null;
        
        // Request rate anomaly
        const requestRate = this.calculateRequestRate(request.ip);
        if (requestRate > ipProfile.avgRequestRate * 3) {
            anomalies.push({
                type: 'high_request_rate',
                severity: 'medium',
                value: requestRate,
                baseline: ipProfile.avgRequestRate
            });
        }
        
        // Path anomaly
        if (!ipProfile.paths.has(request.path) && ipProfile.paths.size > 10) {
            const pathSimilarity = this.calculatePathSimilarity(request.path, ipProfile.paths);
            if (pathSimilarity < 0.3) {
                anomalies.push({
                    type: 'unusual_path',
                    severity: 'low',
                    path: request.path,
                    similarity: pathSimilarity
                });
            }
        }
        
        // Time anomaly
        const hour = new Date().getHours();
        if (!ipProfile.activeHours.has(hour) && ipProfile.activeHours.size > 5) {
            anomalies.push({
                type: 'unusual_time',
                severity: 'low',
                hour: hour,
                normalHours: Array.from(ipProfile.activeHours)
            });
        }
        
        // Payload size anomaly
        const payloadSize = JSON.stringify(request.body || {}).length;
        if (payloadSize > ipProfile.avgPayloadSize * 10 && payloadSize > 1000) {
            anomalies.push({
                type: 'large_payload',
                severity: 'medium',
                size: payloadSize,
                baseline: ipProfile.avgPayloadSize
            });
        }
        
        // Geographic anomaly (if available)
        if (request.geoip && ipProfile.locations.size > 0) {
            const location = `${request.geoip.country}:${request.geoip.city}`;
            if (!ipProfile.locations.has(location)) {
                anomalies.push({
                    type: 'geographic_anomaly',
                    severity: 'medium',
                    location: location,
                    knownLocations: Array.from(ipProfile.locations)
                });
            }
        }
        
        // User agent anomaly
        if (request.headers?.['user-agent']) {
            const ua = request.headers['user-agent'];
            if (!ipProfile.userAgents.has(ua) && ipProfile.userAgents.size > 2) {
                anomalies.push({
                    type: 'user_agent_change',
                    severity: 'low',
                    userAgent: ua,
                    knownAgents: Array.from(ipProfile.userAgents)
                });
            }
        }
        
        if (anomalies.length > 0) {
            this.metrics.detectionTypes.anomaly++;
        }
        
        return anomalies;
    }
    
    /**
     * Analyze behavior patterns
     */
    analyzeBehavior(request) {
        const threats = [];
        
        // Get recent requests from same IP
        const recentRequests = this.getRecentRequests(request.ip, this.config.contextWindow);
        
        // Brute force detection
        if (request.path.includes('login') || request.path.includes('auth')) {
            const loginAttempts = recentRequests.filter(r => 
                r.path.includes('login') || r.path.includes('auth')
            );
            
            if (loginAttempts.length > 10) {
                threats.push({
                    type: 'brute_force',
                    severity: 'high',
                    attempts: loginAttempts.length,
                    timeWindow: this.config.contextWindow
                });
            }
        }
        
        // Credential stuffing detection
        const uniqueUsernames = new Set();
        recentRequests.forEach(r => {
            if (r.body?.username) {
                uniqueUsernames.add(r.body.username);
            }
        });
        
        if (uniqueUsernames.size > 5) {
            threats.push({
                type: 'credential_stuffing',
                severity: 'high',
                uniqueAttempts: uniqueUsernames.size
            });
        }
        
        // Resource enumeration
        const paths = recentRequests.map(r => r.path);
        const sequentialPattern = this.detectSequentialPattern(paths);
        if (sequentialPattern) {
            threats.push({
                type: 'resource_enumeration',
                severity: 'medium',
                pattern: sequentialPattern
            });
        }
        
        // Fuzzing detection
        const paramVariations = this.detectParameterFuzzing(recentRequests);
        if (paramVariations > 20) {
            threats.push({
                type: 'parameter_fuzzing',
                severity: 'medium',
                variations: paramVariations
            });
        }
        
        // Data exfiltration detection
        const outboundData = recentRequests.reduce((sum, r) => 
            sum + (r.responseSize || 0), 0
        );
        
        if (outboundData > 100 * 1024 * 1024) { // 100MB
            threats.push({
                type: 'data_exfiltration',
                severity: 'high',
                dataSize: outboundData,
                requests: recentRequests.length
            });
        }
        
        if (threats.length > 0) {
            this.metrics.detectionTypes.behavior++;
        }
        
        return threats;
    }
    
    /**
     * Machine learning prediction
     */
    async mlPredict(request) {
        if (!this.mlModel) return 0;
        
        // Extract features
        const features = this.extractFeatures(request);
        
        try {
            // Predict threat probability
            const prediction = this.mlModel.predict([features]);
            return prediction[0];
        } catch (error) {
            console.error('ML prediction error:', error);
            return 0;
        }
    }
    
    /**
     * Extract features for ML
     */
    extractFeatures(request) {
        const features = [];
        
        // Request features
        features.push(
            request.method === 'POST' ? 1 : 0,
            request.path.length,
            Object.keys(request.query || {}).length,
            JSON.stringify(request.body || {}).length,
            Object.keys(request.headers || {}).length
        );
        
        // Path features
        features.push(
            request.path.includes('admin') ? 1 : 0,
            request.path.includes('api') ? 1 : 0,
            request.path.includes('..') ? 1 : 0,
            (request.path.match(/\//g) || []).length
        );
        
        // Time features
        const now = new Date();
        features.push(
            now.getHours(),
            now.getDay(),
            now.getMonth()
        );
        
        // Historical features
        const recentRequests = this.getRecentRequests(request.ip, 60000); // Last minute
        features.push(
            recentRequests.length,
            new Set(recentRequests.map(r => r.path)).size,
            recentRequests.filter(r => r.method === 'POST').length
        );
        
        return features;
    }
    
    /**
     * Calculate threat score
     */
    calculateThreatScore(analysis) {
        let score = 0;
        
        // Weight threats by severity
        const severityWeights = {
            critical: 1.0,
            high: 0.8,
            medium: 0.5,
            low: 0.2
        };
        
        // Score threats
        analysis.threats.forEach(threat => {
            score += severityWeights[threat.severity] || 0.5;
        });
        
        // Score anomalies
        analysis.anomalies.forEach(anomaly => {
            score += severityWeights[anomaly.severity] || 0.3;
        });
        
        // Normalize score
        return Math.min(1, score);
    }
    
    /**
     * Helper methods
     */
    
    createProfile() {
        return {
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            requestCount: 0,
            avgRequestRate: 0,
            paths: new Set(),
            methods: new Set(),
            userAgents: new Set(),
            locations: new Set(),
            activeHours: new Set(),
            avgPayloadSize: 0,
            suspiciousActivities: 0
        };
    }
    
    updateProfiles(request, analysis) {
        // Update IP profile
        let ipProfile = this.ipProfiles.get(request.ip) || this.createProfile();
        ipProfile.lastSeen = Date.now();
        ipProfile.requestCount++;
        ipProfile.paths.add(request.path);
        ipProfile.methods.add(request.method);
        
        if (request.headers?.['user-agent']) {
            ipProfile.userAgents.add(request.headers['user-agent']);
        }
        
        const hour = new Date().getHours();
        ipProfile.activeHours.add(hour);
        
        if (analysis.score > 0.5) {
            ipProfile.suspiciousActivities++;
        }
        
        this.ipProfiles.set(request.ip, ipProfile);
        
        // Update user profile if authenticated
        if (request.userId) {
            let userProfile = this.userProfiles.get(request.userId) || this.createProfile();
            // Similar updates...
            this.userProfiles.set(request.userId, userProfile);
        }
    }
    
    calculateRequestRate(ip) {
        const recentRequests = this.getRecentRequests(ip, 60000); // Last minute
        return recentRequests.length;
    }
    
    calculatePathSimilarity(path, knownPaths) {
        // Simple similarity calculation
        let maxSimilarity = 0;
        
        for (const knownPath of knownPaths) {
            const similarity = this.stringSimilarity(path, knownPath);
            maxSimilarity = Math.max(maxSimilarity, similarity);
        }
        
        return maxSimilarity;
    }
    
    stringSimilarity(str1, str2) {
        const longer = str1.length > str2.length ? str1 : str2;
        const shorter = str1.length > str2.length ? str2 : str1;
        
        if (longer.length === 0) return 1.0;
        
        const editDistance = this.levenshteinDistance(longer, shorter);
        return (longer.length - editDistance) / longer.length;
    }
    
    levenshteinDistance(str1, str2) {
        const matrix = [];
        
        for (let i = 0; i <= str2.length; i++) {
            matrix[i] = [i];
        }
        
        for (let j = 0; j <= str1.length; j++) {
            matrix[0][j] = j;
        }
        
        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }
        
        return matrix[str2.length][str1.length];
    }
    
    detectSequentialPattern(paths) {
        // Detect patterns like /user/1, /user/2, /user/3
        const patterns = {};
        
        paths.forEach(path => {
            const normalized = path.replace(/\d+/g, '{id}');
            patterns[normalized] = (patterns[normalized] || 0) + 1;
        });
        
        for (const [pattern, count] of Object.entries(patterns)) {
            if (count > 10 && pattern.includes('{id}')) {
                return pattern;
            }
        }
        
        return null;
    }
    
    detectParameterFuzzing(requests) {
        const paramSets = new Set();
        
        requests.forEach(req => {
            if (req.query) {
                paramSets.add(JSON.stringify(Object.keys(req.query).sort()));
            }
            if (req.body) {
                paramSets.add(JSON.stringify(Object.keys(req.body).sort()));
            }
        });
        
        return paramSets.size;
    }
    
    scoreToSeverity(score) {
        if (score >= 0.9) return 'critical';
        if (score >= 0.7) return 'high';
        if (score >= 0.5) return 'medium';
        return 'low';
    }
    
    addToHistory(request) {
        this.requestHistory.push({
            ...request,
            timestamp: Date.now()
        });
        
        // Limit history size
        if (this.requestHistory.length > this.maxHistorySize) {
            this.requestHistory.shift();
        }
    }
    
    getRecentRequests(identifier, timeWindow) {
        const cutoff = Date.now() - timeWindow;
        return this.requestHistory.filter(req => 
            (req.ip === identifier || req.userId === identifier) && 
            req.timestamp > cutoff
        );
    }
    
    blockEntity(identifier, reason, duration) {
        this.blockedEntities.set(identifier, {
            reason,
            blockedAt: Date.now(),
            expiresAt: Date.now() + duration
        });
        
        this.emit('entity-blocked', {
            identifier,
            reason,
            duration
        });
    }
    
    isBlocked(identifier) {
        const block = this.blockedEntities.get(identifier);
        if (!block) return false;
        
        if (Date.now() > block.expiresAt) {
            this.blockedEntities.delete(identifier);
            return false;
        }
        
        return true;
    }
    
    /**
     * Initialize machine learning
     */
    async initializeMachineLearning() {
        try {
            // Load or create model
            if (this.config.mlModelPath) {
                // Load existing model
                // this.mlModel = await loadModel(this.config.mlModelPath);
            } else {
                // Create new model with sample data
                // this.mlModel = new MLModel();
            }
            
            // Schedule model updates
            setInterval(() => {
                this.updateMLModel();
            }, this.config.mlUpdateInterval);
            
        } catch (error) {
            console.error('Failed to initialize ML:', error);
            this.config.enableMachineLearning = false;
        }
    }
    
    /**
     * Update ML model with new data
     */
    async updateMLModel() {
        if (!this.mlModel) return;
        
        try {
            // Prepare training data from recent history
            const trainingData = this.prepareTrainingData();
            
            // Retrain model
            // await this.mlModel.train(trainingData);
            
            // Save updated model
            // await this.mlModel.save(this.config.mlModelPath);
            
        } catch (error) {
            console.error('Failed to update ML model:', error);
        }
    }
    
    prepareTrainingData() {
        // Convert request history to training data
        const data = [];
        
        // Implementation would prepare labeled training data
        
        return data;
    }
    
    /**
     * Start monitoring tasks
     */
    startMonitoring() {
        // Clean up old data
        setInterval(() => {
            this.cleanup();
        }, 300000); // Every 5 minutes
        
        // Generate reports
        setInterval(() => {
            this.generateReport();
        }, 3600000); // Every hour
    }
    
    cleanup() {
        const now = Date.now();
        
        // Clean blocked entities
        for (const [id, block] of this.blockedEntities) {
            if (now > block.expiresAt) {
                this.blockedEntities.delete(id);
            }
        }
        
        // Clean old history
        const cutoff = now - 86400000; // 24 hours
        this.requestHistory = this.requestHistory.filter(req => 
            req.timestamp > cutoff
        );
        
        // Clean old profiles
        const profileCutoff = now - 604800000; // 7 days
        for (const [ip, profile] of this.ipProfiles) {
            if (profile.lastSeen < profileCutoff) {
                this.ipProfiles.delete(ip);
            }
        }
    }
    
    generateReport() {
        const report = {
            timestamp: new Date().toISOString(),
            metrics: this.metrics,
            activeThreats: this.activeThreats.size,
            blockedEntities: this.blockedEntities.size,
            topThreats: this.getTopThreats(),
            suspiciousIPs: this.getSuspiciousIPs()
        };
        
        this.emit('security-report', report);
    }
    
    getTopThreats() {
        const threatCounts = {};
        
        this.requestHistory.forEach(req => {
            if (req.threats) {
                req.threats.forEach(threat => {
                    threatCounts[threat.type] = (threatCounts[threat.type] || 0) + 1;
                });
            }
        });
        
        return Object.entries(threatCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([type, count]) => ({ type, count }));
    }
    
    getSuspiciousIPs() {
        return Array.from(this.ipProfiles.entries())
            .filter(([ip, profile]) => profile.suspiciousActivities > 5)
            .sort((a, b) => b[1].suspiciousActivities - a[1].suspiciousActivities)
            .slice(0, 20)
            .map(([ip, profile]) => ({
                ip,
                suspiciousActivities: profile.suspiciousActivities,
                lastSeen: new Date(profile.lastSeen).toISOString()
            }));
    }
    
    /**
     * Get system status
     */
    getStatus() {
        return {
            active: true,
            metrics: this.metrics,
            signatures: this.signatures.size,
            profiledIPs: this.ipProfiles.size,
            profiledUsers: this.userProfiles.size,
            blockedEntities: this.blockedEntities.size,
            historySize: this.requestHistory.length,
            mlEnabled: this.config.enableMachineLearning && !!this.mlModel
        };
    }
}

module.exports = AdvancedIntrusionDetection;