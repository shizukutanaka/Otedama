/**
 * Comprehensive Optimization Integration Module
 * 包括的な最適化統合モジュール
 */

const ComprehensivePerformanceOptimizer = require('./comprehensive-performance-optimizer');
const ConnectionPoolManager = require('./connection-pool-manager');
const AdvancedMemoryManager = require('./advanced-memory-manager');
const AdvancedCacheLayer = require('./advanced-cache-layer');
const DatabaseQueryOptimizer = require('./database-query-optimizer');
const WebSocketCompressionManager = require('./websocket-compression');
const { CircuitBreakerManager } = require('./circuit-breaker');
const MessageQueueSystem = require('./message-queue-system');
const HorizontalScalingManager = require('./horizontal-scaling-manager');
const OptimizedMiningAlgorithm = require('./optimized-mining-algorithm');

class OptimizationIntegration {
    constructor(config = {}) {
        this.config = {
            // Enable/disable specific optimizations
            enablePerformanceOptimizer: config.enablePerformanceOptimizer !== false,
            enableConnectionPooling: config.enableConnectionPooling !== false,
            enableMemoryManagement: config.enableMemoryManagement !== false,
            enableCaching: config.enableCaching !== false,
            enableDatabaseOptimization: config.enableDatabaseOptimization !== false,
            enableWebSocketCompression: config.enableWebSocketCompression !== false,
            enableCircuitBreaker: config.enableCircuitBreaker !== false,
            enableMessageQueue: config.enableMessageQueue !== false,
            enableHorizontalScaling: config.enableHorizontalScaling !== false,
            enableMiningOptimization: config.enableMiningOptimization !== false,
            
            // Component-specific configurations
            performanceConfig: config.performanceConfig || {},
            connectionPoolConfig: config.connectionPoolConfig || {},
            memoryConfig: config.memoryConfig || {},
            cacheConfig: config.cacheConfig || {},
            databaseConfig: config.databaseConfig || {},
            webSocketConfig: config.webSocketConfig || {},
            circuitBreakerConfig: config.circuitBreakerConfig || {},
            messageQueueConfig: config.messageQueueConfig || {},
            scalingConfig: config.scalingConfig || {},
            miningConfig: config.miningConfig || {},
            
            ...config
        };
        
        // Component instances
        this.components = {};
        
        // Performance metrics
        this.metrics = {
            startTime: Date.now(),
            optimizationsApplied: 0,
            performanceGains: {}
        };
        
        // Initialize
        this.initialize();
    }
    
    async initialize() {
        console.log('=== Otedama最適化システムを初期化中 ===');
        
        const initPromises = [];
        
        // Initialize performance optimizer
        if (this.config.enablePerformanceOptimizer) {
            initPromises.push(this.initializePerformanceOptimizer());
        }
        
        // Initialize connection pooling
        if (this.config.enableConnectionPooling) {
            initPromises.push(this.initializeConnectionPooling());
        }
        
        // Initialize memory management
        if (this.config.enableMemoryManagement) {
            initPromises.push(this.initializeMemoryManagement());
        }
        
        // Initialize caching
        if (this.config.enableCaching) {
            initPromises.push(this.initializeCaching());
        }
        
        // Initialize database optimization
        if (this.config.enableDatabaseOptimization) {
            initPromises.push(this.initializeDatabaseOptimization());
        }
        
        // Initialize WebSocket compression
        if (this.config.enableWebSocketCompression) {
            initPromises.push(this.initializeWebSocketCompression());
        }
        
        // Initialize circuit breaker
        if (this.config.enableCircuitBreaker) {
            initPromises.push(this.initializeCircuitBreaker());
        }
        
        // Initialize message queue
        if (this.config.enableMessageQueue) {
            initPromises.push(this.initializeMessageQueue());
        }
        
        // Initialize horizontal scaling
        if (this.config.enableHorizontalScaling) {
            initPromises.push(this.initializeHorizontalScaling());
        }
        
        // Initialize mining optimization
        if (this.config.enableMiningOptimization) {
            initPromises.push(this.initializeMiningOptimization());
        }
        
        // Wait for all initializations
        await Promise.all(initPromises);
        
        // Setup inter-component communication
        this.setupComponentIntegration();
        
        console.log('=== ✓ 最適化システムの初期化完了 ===');
        console.log(`適用された最適化: ${this.metrics.optimizationsApplied}個`);
    }
    
    /**
     * Initialize performance optimizer
     */
    async initializePerformanceOptimizer() {
        try {
            this.components.performanceOptimizer = new ComprehensivePerformanceOptimizer(
                this.config.performanceConfig
            );
            
            this.metrics.optimizationsApplied++;
            console.log('✓ パフォーマンス最適化を有効化');
        } catch (error) {
            console.error('パフォーマンス最適化の初期化エラー:', error);
        }
    }
    
    /**
     * Initialize connection pooling
     */
    async initializeConnectionPooling() {
        try {
            this.components.connectionPool = new ConnectionPoolManager(
                this.config.connectionPoolConfig
            );
            
            this.metrics.optimizationsApplied++;
            console.log('✓ 接続プーリングを有効化');
        } catch (error) {
            console.error('接続プーリングの初期化エラー:', error);
        }
    }
    
    /**
     * Initialize memory management
     */
    async initializeMemoryManagement() {
        try {
            this.components.memoryManager = new AdvancedMemoryManager(
                this.config.memoryConfig
            );
            
            // Register memory pressure handlers
            this.components.memoryManager.registerPressureHandler('warning', () => {
                // Reduce cache sizes
                if (this.components.cache) {
                    this.components.cache.emit('reduce-cache-sizes', { factor: 0.8 });
                }
            });
            
            this.components.memoryManager.registerPressureHandler('critical', () => {
                // Clear non-essential caches
                if (this.components.cache) {
                    this.components.cache.emit('clear-all-caches', { reason: 'memory-pressure' });
                }
            });
            
            this.metrics.optimizationsApplied++;
            console.log('✓ メモリ管理を有効化');
        } catch (error) {
            console.error('メモリ管理の初期化エラー:', error);
        }
    }
    
    /**
     * Initialize caching layer
     */
    async initializeCaching() {
        try {
            this.components.cache = new AdvancedCacheLayer(
                this.config.cacheConfig
            );
            
            await this.components.cache.initialize();
            
            this.metrics.optimizationsApplied++;
            console.log('✓ キャッシングレイヤーを有効化');
        } catch (error) {
            console.error('キャッシングの初期化エラー:', error);
        }
    }
    
    /**
     * Initialize database optimization
     */
    async initializeDatabaseOptimization() {
        try {
            this.components.dbOptimizer = new DatabaseQueryOptimizer(
                this.config.databaseConfig
            );
            
            this.metrics.optimizationsApplied++;
            console.log('✓ データベース最適化を有効化');
        } catch (error) {
            console.error('データベース最適化の初期化エラー:', error);
        }
    }
    
    /**
     * Initialize WebSocket compression
     */
    async initializeWebSocketCompression() {
        try {
            this.components.wsCompression = new WebSocketCompressionManager(
                this.config.webSocketConfig
            );
            
            this.metrics.optimizationsApplied++;
            console.log('✓ WebSocket圧縮を有効化');
        } catch (error) {
            console.error('WebSocket圧縮の初期化エラー:', error);
        }
    }
    
    /**
     * Initialize circuit breaker
     */
    async initializeCircuitBreaker() {
        try {
            this.components.circuitBreaker = new CircuitBreakerManager();
            
            // Create breakers for critical services
            this.components.circuitBreaker.getBreaker('database', {
                ...this.config.circuitBreakerConfig,
                fallbackFunction: async () => {
                    // Return cached data if available
                    if (this.components.cache) {
                        return { source: 'cache', data: null };
                    }
                    throw new Error('Service unavailable');
                }
            });
            
            this.components.circuitBreaker.getBreaker('external-api', {
                ...this.config.circuitBreakerConfig,
                timeout: 10000
            });
            
            this.metrics.optimizationsApplied++;
            console.log('✓ サーキットブレーカーを有効化');
        } catch (error) {
            console.error('サーキットブレーカーの初期化エラー:', error);
        }
    }
    
    /**
     * Initialize message queue
     */
    async initializeMessageQueue() {
        try {
            this.components.messageQueue = new MessageQueueSystem(
                this.config.messageQueueConfig
            );
            
            // Create default queues
            this.components.messageQueue.createQueue('shares');
            this.components.messageQueue.createQueue('blocks');
            this.components.messageQueue.createQueue('payments');
            
            this.metrics.optimizationsApplied++;
            console.log('✓ メッセージキューを有効化');
        } catch (error) {
            console.error('メッセージキューの初期化エラー:', error);
        }
    }
    
    /**
     * Initialize horizontal scaling
     */
    async initializeHorizontalScaling() {
        try {
            this.components.scalingManager = new HorizontalScalingManager(
                this.config.scalingConfig
            );
            
            this.metrics.optimizationsApplied++;
            console.log('✓ 水平スケーリングを有効化');
        } catch (error) {
            console.error('水平スケーリングの初期化エラー:', error);
        }
    }
    
    /**
     * Initialize mining optimization
     */
    async initializeMiningOptimization() {
        try {
            this.components.miningOptimizer = new OptimizedMiningAlgorithm(
                this.config.miningConfig
            );
            
            this.metrics.optimizationsApplied++;
            console.log('✓ マイニング最適化を有効化');
        } catch (error) {
            console.error('マイニング最適化の初期化エラー:', error);
        }
    }
    
    /**
     * Setup integration between components
     */
    setupComponentIntegration() {
        // Memory manager integration
        if (this.components.memoryManager) {
            // Clear caches on memory pressure
            this.components.memoryManager.on('memory-pressure-changed', ({ newLevel }) => {
                if (newLevel === 'critical' && this.components.cache) {
                    this.components.cache.clear();
                }
            });
        }
        
        // Circuit breaker integration
        if (this.components.circuitBreaker) {
            // Notify other components when circuit opens
            this.components.circuitBreaker.on('breaker-state-change', ({ name, to }) => {
                if (to === 'OPEN') {
                    console.warn(`サービス ${name} が利用不可能です`);
                    
                    // Switch to cache-only mode
                    if (name === 'database' && this.components.cache) {
                        this.components.cache.emit('database-unavailable');
                    }
                }
            });
        }
        
        // Performance optimizer integration
        if (this.components.performanceOptimizer) {
            // Use worker pool for CPU-intensive tasks
            if (this.components.messageQueue) {
                this.components.messageQueue.registerProcessor('cpu-intensive', 
                    async (task) => {
                        return await this.components.performanceOptimizer.executeTask(task);
                    },
                    { concurrency: 4 }
                );
            }
        }
        
        // Database optimizer integration
        if (this.components.dbOptimizer && this.components.circuitBreaker) {
            // Wrap database queries with circuit breaker
            const originalExecute = this.components.dbOptimizer.executeQuery.bind(this.components.dbOptimizer);
            
            this.components.dbOptimizer.executeQuery = async (query, params, options) => {
                return await this.components.circuitBreaker.execute(
                    'database',
                    originalExecute,
                    query,
                    params,
                    options
                );
            };
        }
    }
    
    /**
     * Get optimization status
     */
    getOptimizationStatus() {
        const status = {
            uptime: Date.now() - this.metrics.startTime,
            optimizationsActive: this.metrics.optimizationsApplied,
            components: {}
        };
        
        // Collect status from each component
        if (this.components.performanceOptimizer) {
            status.components.performance = this.components.performanceOptimizer.getMetrics();
        }
        
        if (this.components.connectionPool) {
            status.components.connectionPool = this.components.connectionPool.getStatistics();
        }
        
        if (this.components.memoryManager) {
            status.components.memory = this.components.memoryManager.getMemoryStatistics();
        }
        
        if (this.components.cache) {
            status.components.cache = this.components.cache.getStatistics();
        }
        
        if (this.components.dbOptimizer) {
            status.components.database = this.components.dbOptimizer.getStatistics();
        }
        
        if (this.components.wsCompression) {
            status.components.webSocket = this.components.wsCompression.getStatistics();
        }
        
        if (this.components.circuitBreaker) {
            status.components.circuitBreaker = this.components.circuitBreaker.getAllMetrics();
        }
        
        if (this.components.messageQueue) {
            status.components.messageQueue = this.components.messageQueue.getMetrics();
        }
        
        if (this.components.scalingManager) {
            status.components.scaling = this.components.scalingManager.getClusterStatus();
        }
        
        if (this.components.miningOptimizer) {
            status.components.mining = this.components.miningOptimizer.getStatistics();
        }
        
        return status;
    }
    
    /**
     * Apply optimization recommendations
     */
    async applyOptimizationRecommendations() {
        const recommendations = [];
        
        // Analyze current performance
        const status = this.getOptimizationStatus();
        
        // Memory recommendations
        if (status.components.memory?.current?.heapUsagePercent > 70) {
            recommendations.push({
                component: 'memory',
                action: 'increase-heap-size',
                reason: 'High memory usage detected'
            });
        }
        
        // Cache recommendations
        if (status.components.cache?.global?.hitRate < 50) {
            recommendations.push({
                component: 'cache',
                action: 'increase-cache-size',
                reason: 'Low cache hit rate'
            });
        }
        
        // Database recommendations
        if (status.components.database?.avgQueryTime > 100) {
            recommendations.push({
                component: 'database',
                action: 'analyze-slow-queries',
                reason: 'High average query time'
            });
        }
        
        // Apply recommendations
        for (const rec of recommendations) {
            console.log(`最適化推奨: ${rec.component} - ${rec.action} (${rec.reason})`);
            
            // Apply specific optimizations
            switch (rec.action) {
                case 'increase-cache-size':
                    if (this.components.cache) {
                        // Increase L1 cache size by 20%
                        // Implementation would go here
                    }
                    break;
                    
                case 'analyze-slow-queries':
                    if (this.components.dbOptimizer) {
                        const slowQueries = this.components.dbOptimizer.slowQueries;
                        console.log('遅いクエリ:', slowQueries.slice(0, 5));
                    }
                    break;
            }
        }
        
        return recommendations;
    }
    
    /**
     * Get specific component
     */
    getComponent(name) {
        return this.components[name];
    }
    
    /**
     * Cleanup all components
     */
    async cleanup() {
        console.log('最適化システムをクリーンアップ中...');
        
        const cleanupPromises = [];
        
        for (const [name, component] of Object.entries(this.components)) {
            if (component && typeof component.cleanup === 'function') {
                cleanupPromises.push(
                    component.cleanup()
                        .catch(err => console.error(`${name} クリーンアップエラー:`, err))
                );
            }
        }
        
        await Promise.all(cleanupPromises);
        
        console.log('✓ 最適化システムのクリーンアップ完了');
    }
}

// Export singleton instance
let optimizationInstance = null;

module.exports = {
    OptimizationIntegration,
    
    // Initialize optimization system
    initializeOptimization: async (config) => {
        if (!optimizationInstance) {
            optimizationInstance = new OptimizationIntegration(config);
            await optimizationInstance.initialize();
        }
        return optimizationInstance;
    },
    
    // Get existing instance
    getOptimization: () => {
        if (!optimizationInstance) {
            throw new Error('Optimization not initialized. Call initializeOptimization first.');
        }
        return optimizationInstance;
    },
    
    // Direct component access
    getOptimizationComponent: (name) => {
        if (!optimizationInstance) {
            throw new Error('Optimization not initialized. Call initializeOptimization first.');
        }
        return optimizationInstance.getComponent(name);
    }
};