/**
 * Circuit Breaker Pattern Implementation
 * サーキットブレーカーパターンの実装
 */

const { EventEmitter } = require('events');

class CircuitBreaker extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Circuit breaker thresholds
            failureThreshold: config.failureThreshold || 5,
            failureRateThreshold: config.failureRateThreshold || 0.5, // 50%
            timeout: config.timeout || 60000, // 60 seconds
            resetTimeout: config.resetTimeout || 30000, // 30 seconds
            
            // Monitoring window
            monitoringWindow: config.monitoringWindow || 60000, // 1 minute
            minimumRequests: config.minimumRequests || 10,
            
            // Half-open state
            halfOpenRequests: config.halfOpenRequests || 3,
            
            // Fallback
            fallbackFunction: config.fallbackFunction || null,
            
            // Health check
            healthCheckInterval: config.healthCheckInterval || 10000,
            healthCheckFunction: config.healthCheckFunction || null,
            
            // Bulkhead pattern
            enableBulkhead: config.enableBulkhead || false,
            maxConcurrentRequests: config.maxConcurrentRequests || 100,
            queueSize: config.queueSize || 50,
            
            // Retry settings
            enableRetry: config.enableRetry !== false,
            maxRetries: config.maxRetries || 3,
            retryDelay: config.retryDelay || 1000,
            retryBackoff: config.retryBackoff || 2,
            
            ...config
        };
        
        // Circuit states
        this.STATE = {
            CLOSED: 'CLOSED',
            OPEN: 'OPEN',
            HALF_OPEN: 'HALF_OPEN'
        };
        
        // Current state
        this.state = this.STATE.CLOSED;
        this.lastStateChange = Date.now();
        this.nextAttempt = 0;
        
        // Request tracking
        this.requests = [];
        this.successCount = 0;
        this.failureCount = 0;
        this.consecutiveFailures = 0;
        this.halfOpenSuccesses = 0;
        
        // Bulkhead
        this.activeRequests = 0;
        this.requestQueue = [];
        
        // Statistics
        this.stats = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            rejectedRequests: 0,
            timeouts: 0,
            fallbackExecutions: 0,
            stateChanges: 0
        };
        
        // Initialize
        this.initialize();
    }
    
    initialize() {
        console.log('サーキットブレーカーを初期化中...');
        
        // Start monitoring
        this.startMonitoring();
        
        // Start health checks if configured
        if (this.config.healthCheckFunction) {
            this.startHealthChecks();
        }
        
        console.log('✓ サーキットブレーカーの初期化完了');
    }
    
    /**
     * Execute function with circuit breaker protection
     */
    async execute(fn, ...args) {
        this.stats.totalRequests++;
        
        // Check if circuit is open
        if (this.state === this.STATE.OPEN) {
            if (Date.now() < this.nextAttempt) {
                return await this.handleOpenCircuit();
            } else {
                // Try half-open
                this.transitionToHalfOpen();
            }
        }
        
        // Check bulkhead limits
        if (this.config.enableBulkhead && !this.checkBulkhead()) {
            return await this.handleBulkheadRejection();
        }
        
        // Execute with retry logic
        return await this.executeWithRetry(fn, args);
    }
    
    /**
     * Execute with retry logic
     */
    async executeWithRetry(fn, args, attempt = 0) {
        try {
            // Track request
            const requestId = this.trackRequest();
            
            // Set timeout
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Circuit breaker timeout')), this.config.timeout);
            });
            
            // Execute function
            const result = await Promise.race([
                fn(...args),
                timeoutPromise
            ]);
            
            // Handle success
            this.recordSuccess(requestId);
            
            return result;
            
        } catch (error) {
            // Handle failure
            this.recordFailure(error);
            
            // Check if should retry
            if (this.config.enableRetry && attempt < this.config.maxRetries && this.state !== this.STATE.OPEN) {
                const delay = this.calculateRetryDelay(attempt);
                
                await new Promise(resolve => setTimeout(resolve, delay));
                
                return await this.executeWithRetry(fn, args, attempt + 1);
            }
            
            // Use fallback if available
            if (this.config.fallbackFunction) {
                this.stats.fallbackExecutions++;
                return await this.config.fallbackFunction(error, ...args);
            }
            
            throw error;
            
        } finally {
            // Release bulkhead
            if (this.config.enableBulkhead) {
                this.releaseBulkhead();
            }
        }
    }
    
    /**
     * Track request start
     */
    trackRequest() {
        const request = {
            id: Date.now() + Math.random(),
            startTime: Date.now(),
            state: this.state
        };
        
        this.requests.push(request);
        
        // Maintain window size
        this.cleanupOldRequests();
        
        if (this.config.enableBulkhead) {
            this.activeRequests++;
        }
        
        return request.id;
    }
    
    /**
     * Record successful request
     */
    recordSuccess(requestId) {
        const request = this.requests.find(r => r.id === requestId);
        if (request) {
            request.success = true;
            request.endTime = Date.now();
            request.duration = request.endTime - request.startTime;
        }
        
        this.successCount++;
        this.consecutiveFailures = 0;
        this.stats.successfulRequests++;
        
        // Handle half-open state
        if (this.state === this.STATE.HALF_OPEN) {
            this.halfOpenSuccesses++;
            
            if (this.halfOpenSuccesses >= this.config.halfOpenRequests) {
                this.transitionToClosed();
            }
        }
        
        this.emit('request-success', {
            duration: request?.duration,
            state: this.state
        });
    }
    
    /**
     * Record failed request
     */
    recordFailure(error) {
        const isTimeout = error.message === 'Circuit breaker timeout';
        
        this.failureCount++;
        this.consecutiveFailures++;
        this.stats.failedRequests++;
        
        if (isTimeout) {
            this.stats.timeouts++;
        }
        
        // Check if should open circuit
        if (this.shouldOpenCircuit()) {
            this.transitionToOpen();
        }
        
        this.emit('request-failure', {
            error,
            consecutiveFailures: this.consecutiveFailures,
            state: this.state
        });
    }
    
    /**
     * Check if circuit should open
     */
    shouldOpenCircuit() {
        if (this.state === this.STATE.OPEN) return false;
        
        // Check consecutive failures
        if (this.consecutiveFailures >= this.config.failureThreshold) {
            return true;
        }
        
        // Check failure rate
        const recentRequests = this.getRecentRequests();
        if (recentRequests.length >= this.config.minimumRequests) {
            const failures = recentRequests.filter(r => !r.success).length;
            const failureRate = failures / recentRequests.length;
            
            if (failureRate >= this.config.failureRateThreshold) {
                return true;
            }
        }
        
        return false;
    }
    
    /**
     * Transition to open state
     */
    transitionToOpen() {
        this.state = this.STATE.OPEN;
        this.lastStateChange = Date.now();
        this.nextAttempt = Date.now() + this.config.resetTimeout;
        this.stats.stateChanges++;
        
        console.warn('サーキットブレーカーがOPEN状態に移行しました');
        
        this.emit('state-change', {
            from: this.STATE.CLOSED,
            to: this.STATE.OPEN,
            reason: 'failure_threshold_exceeded'
        });
    }
    
    /**
     * Transition to half-open state
     */
    transitionToHalfOpen() {
        this.state = this.STATE.HALF_OPEN;
        this.lastStateChange = Date.now();
        this.halfOpenSuccesses = 0;
        this.stats.stateChanges++;
        
        console.log('サーキットブレーカーがHALF_OPEN状態に移行しました');
        
        this.emit('state-change', {
            from: this.STATE.OPEN,
            to: this.STATE.HALF_OPEN,
            reason: 'reset_timeout_expired'
        });
    }
    
    /**
     * Transition to closed state
     */
    transitionToClosed() {
        const previousState = this.state;
        this.state = this.STATE.CLOSED;
        this.lastStateChange = Date.now();
        this.consecutiveFailures = 0;
        this.halfOpenSuccesses = 0;
        this.stats.stateChanges++;
        
        console.log('サーキットブレーカーがCLOSED状態に移行しました');
        
        this.emit('state-change', {
            from: previousState,
            to: this.STATE.CLOSED,
            reason: 'recovery_confirmed'
        });
    }
    
    /**
     * Handle open circuit
     */
    async handleOpenCircuit() {
        this.stats.rejectedRequests++;
        
        if (this.config.fallbackFunction) {
            this.stats.fallbackExecutions++;
            return await this.config.fallbackFunction(
                new Error('Circuit breaker is OPEN')
            );
        }
        
        throw new Error('Circuit breaker is OPEN');
    }
    
    /**
     * Check bulkhead availability
     */
    checkBulkhead() {
        if (this.activeRequests < this.config.maxConcurrentRequests) {
            return true;
        }
        
        if (this.requestQueue.length < this.config.queueSize) {
            // Add to queue
            return new Promise((resolve) => {
                this.requestQueue.push(resolve);
            });
        }
        
        return false;
    }
    
    /**
     * Handle bulkhead rejection
     */
    async handleBulkheadRejection() {
        this.stats.rejectedRequests++;
        
        if (this.config.fallbackFunction) {
            this.stats.fallbackExecutions++;
            return await this.config.fallbackFunction(
                new Error('Bulkhead capacity exceeded')
            );
        }
        
        throw new Error('Bulkhead capacity exceeded');
    }
    
    /**
     * Release bulkhead slot
     */
    releaseBulkhead() {
        this.activeRequests--;
        
        // Process queued request
        if (this.requestQueue.length > 0) {
            const resolve = this.requestQueue.shift();
            resolve(true);
        }
    }
    
    /**
     * Calculate retry delay with backoff
     */
    calculateRetryDelay(attempt) {
        return this.config.retryDelay * Math.pow(this.config.retryBackoff, attempt);
    }
    
    /**
     * Get recent requests within monitoring window
     */
    getRecentRequests() {
        const cutoff = Date.now() - this.config.monitoringWindow;
        return this.requests.filter(r => r.startTime > cutoff);
    }
    
    /**
     * Cleanup old requests
     */
    cleanupOldRequests() {
        const cutoff = Date.now() - this.config.monitoringWindow * 2;
        this.requests = this.requests.filter(r => r.startTime > cutoff);
    }
    
    /**
     * Start monitoring
     */
    startMonitoring() {
        // Periodic cleanup
        setInterval(() => {
            this.cleanupOldRequests();
            
            // Emit metrics
            this.emit('metrics', this.getMetrics());
        }, 10000);
    }
    
    /**
     * Start health checks
     */
    startHealthChecks() {
        setInterval(async () => {
            if (this.state === this.STATE.OPEN || this.state === this.STATE.HALF_OPEN) {
                try {
                    await this.config.healthCheckFunction();
                    
                    // Health check passed
                    if (this.state === this.STATE.OPEN) {
                        this.transitionToHalfOpen();
                    }
                    
                } catch (error) {
                    // Health check failed
                    console.log('ヘルスチェック失敗:', error.message);
                }
            }
        }, this.config.healthCheckInterval);
    }
    
    /**
     * Get circuit breaker metrics
     */
    getMetrics() {
        const recentRequests = this.getRecentRequests();
        const successfulRequests = recentRequests.filter(r => r.success).length;
        const failedRequests = recentRequests.filter(r => !r.success).length;
        
        return {
            state: this.state,
            lastStateChange: this.lastStateChange,
            timeSinceLastStateChange: Date.now() - this.lastStateChange,
            
            recentRequests: {
                total: recentRequests.length,
                successful: successfulRequests,
                failed: failedRequests,
                successRate: recentRequests.length > 0 ? 
                    successfulRequests / recentRequests.length : 0
            },
            
            consecutiveFailures: this.consecutiveFailures,
            activeRequests: this.activeRequests,
            queuedRequests: this.requestQueue.length,
            
            stats: this.stats
        };
    }
    
    /**
     * Get current state
     */
    getState() {
        return {
            state: this.state,
            isOpen: this.state === this.STATE.OPEN,
            isHalfOpen: this.state === this.STATE.HALF_OPEN,
            isClosed: this.state === this.STATE.CLOSED
        };
    }
    
    /**
     * Force open circuit (for testing/emergency)
     */
    forceOpen() {
        if (this.state !== this.STATE.OPEN) {
            this.transitionToOpen();
        }
    }
    
    /**
     * Force close circuit (for testing/recovery)
     */
    forceClose() {
        if (this.state !== this.STATE.CLOSED) {
            this.transitionToClosed();
        }
    }
    
    /**
     * Reset circuit breaker
     */
    reset() {
        this.state = this.STATE.CLOSED;
        this.lastStateChange = Date.now();
        this.consecutiveFailures = 0;
        this.halfOpenSuccesses = 0;
        this.requests = [];
        this.successCount = 0;
        this.failureCount = 0;
        
        // Reset stats
        this.stats = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            rejectedRequests: 0,
            timeouts: 0,
            fallbackExecutions: 0,
            stateChanges: 0
        };
        
        this.emit('reset');
    }
}

/**
 * Circuit Breaker Manager for managing multiple breakers
 */
class CircuitBreakerManager extends EventEmitter {
    constructor() {
        super();
        this.breakers = new Map();
    }
    
    /**
     * Create or get circuit breaker
     */
    getBreaker(name, config = {}) {
        if (!this.breakers.has(name)) {
            const breaker = new CircuitBreaker(config);
            
            // Forward events
            breaker.on('state-change', (data) => {
                this.emit('breaker-state-change', { name, ...data });
            });
            
            this.breakers.set(name, breaker);
        }
        
        return this.breakers.get(name);
    }
    
    /**
     * Execute function with named circuit breaker
     */
    async execute(name, fn, ...args) {
        const breaker = this.getBreaker(name);
        return await breaker.execute(fn, ...args);
    }
    
    /**
     * Get all breaker states
     */
    getAllStates() {
        const states = {};
        
        for (const [name, breaker] of this.breakers) {
            states[name] = breaker.getState();
        }
        
        return states;
    }
    
    /**
     * Get all breaker metrics
     */
    getAllMetrics() {
        const metrics = {};
        
        for (const [name, breaker] of this.breakers) {
            metrics[name] = breaker.getMetrics();
        }
        
        return metrics;
    }
    
    /**
     * Reset all breakers
     */
    resetAll() {
        for (const breaker of this.breakers.values()) {
            breaker.reset();
        }
    }
}

module.exports = {
    CircuitBreaker,
    CircuitBreakerManager
};