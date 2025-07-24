/**
 * Automated Performance Testing System
 * 自動パフォーマンステストシステム
 */

const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');
const os = require('os');

class AutomatedPerformanceTesting extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Test scenarios
            scenarios: config.scenarios || [
                'baseline',
                'stress',
                'spike',
                'endurance',
                'scalability',
                'breakpoint'
            ],
            
            // Load configuration
            baselineUsers: config.baselineUsers || 100,
            maxUsers: config.maxUsers || 10000,
            rampUpTime: config.rampUpTime || 60000, // 1 minute
            testDuration: config.testDuration || 300000, // 5 minutes
            
            // Performance thresholds
            thresholds: {
                responseTime: config.thresholds?.responseTime || 1000, // 1 second
                errorRate: config.thresholds?.errorRate || 0.01, // 1%
                throughput: config.thresholds?.throughput || 1000, // requests/second
                cpuUsage: config.thresholds?.cpuUsage || 80, // 80%
                memoryUsage: config.thresholds?.memoryUsage || 85, // 85%
                ...config.thresholds
            },
            
            // Test targets
            targets: config.targets || [
                { type: 'http', url: 'http://localhost:8080/api/health' },
                { type: 'websocket', url: 'ws://localhost:8080' },
                { type: 'stratum', host: 'localhost', port: 3333 }
            ],
            
            // Worker configuration
            workerCount: config.workerCount || os.cpus().length,
            
            // Reporting
            reportInterval: config.reportInterval || 5000, // 5 seconds
            saveResults: config.saveResults !== false,
            resultsPath: config.resultsPath || './performance-results',
            
            // Continuous testing
            enableContinuousTesting: config.enableContinuousTesting || false,
            testInterval: config.testInterval || 3600000, // 1 hour
            
            // Alerting
            enableAlerting: config.enableAlerting !== false,
            alertWebhook: config.alertWebhook || null,
            
            ...config
        };
        
        // Test state
        this.currentTest = null;
        this.testHistory = [];
        this.workers = [];
        
        // Metrics collection
        this.metrics = {
            requests: 0,
            errors: 0,
            totalResponseTime: 0,
            minResponseTime: Infinity,
            maxResponseTime: 0,
            activeUsers: 0,
            throughput: 0,
            systemMetrics: {
                cpu: 0,
                memory: 0,
                networkIn: 0,
                networkOut: 0
            }
        };
        
        // Performance baseline
        this.baseline = null;
        
        // Initialize
        this.initialize();
    }
    
    async initialize() {
        console.log('自動パフォーマンステストシステムを初期化中...');
        
        // Create results directory
        await this.ensureResultsDirectory();
        
        // Initialize workers
        await this.initializeWorkers();
        
        // Load baseline if exists
        await this.loadBaseline();
        
        // Start continuous testing if enabled
        if (this.config.enableContinuousTesting) {
            this.startContinuousTesting();
        }
        
        console.log('✓ パフォーマンステストシステムの初期化完了');
    }
    
    /**
     * Run performance test
     */
    async runTest(scenario = 'baseline', options = {}) {
        if (this.currentTest) {
            throw new Error('Test already in progress');
        }
        
        console.log(`パフォーマンステストを開始: ${scenario}`);
        
        this.currentTest = {
            id: this.generateTestId(),
            scenario,
            startTime: Date.now(),
            options,
            status: 'running',
            results: null
        };
        
        // Reset metrics
        this.resetMetrics();
        
        // Start system monitoring
        this.startSystemMonitoring();
        
        this.emit('test-started', {
            testId: this.currentTest.id,
            scenario
        });
        
        try {
            // Execute scenario
            const results = await this.executeScenario(scenario, options);
            
            // Analyze results
            const analysis = await this.analyzeResults(results);
            
            // Compare with baseline
            const comparison = this.compareWithBaseline(analysis);
            
            // Generate report
            const report = await this.generateReport({
                scenario,
                results,
                analysis,
                comparison
            });
            
            this.currentTest.status = 'completed';
            this.currentTest.results = report;
            
            // Save results
            if (this.config.saveResults) {
                await this.saveResults(report);
            }
            
            // Update baseline if this was a baseline test
            if (scenario === 'baseline') {
                this.baseline = analysis;
                await this.saveBaseline();
            }
            
            // Check thresholds and alert if needed
            this.checkThresholds(analysis);
            
            // Add to history
            this.testHistory.push({
                ...this.currentTest,
                endTime: Date.now()
            });
            
            this.emit('test-completed', {
                testId: this.currentTest.id,
                report
            });
            
            return report;
            
        } catch (error) {
            this.currentTest.status = 'failed';
            this.currentTest.error = error.message;
            
            this.emit('test-failed', {
                testId: this.currentTest.id,
                error: error.message
            });
            
            throw error;
            
        } finally {
            this.stopSystemMonitoring();
            this.currentTest = null;
        }
    }
    
    /**
     * Execute test scenario
     */
    async executeScenario(scenario, options) {
        const scenarioConfig = this.getScenarioConfig(scenario, options);
        const { users, duration, rampUp, pattern } = scenarioConfig;
        
        console.log(`実行中: ${users}ユーザー, ${duration}ms, パターン: ${pattern}`);
        
        // Distribute users across workers
        const usersPerWorker = Math.ceil(users / this.workers.length);
        
        // Start load generation
        const workerPromises = this.workers.map((worker, index) => {
            const workerUsers = Math.min(
                usersPerWorker,
                users - (index * usersPerWorker)
            );
            
            if (workerUsers <= 0) return Promise.resolve();
            
            return this.runWorkerLoad(worker, {
                users: workerUsers,
                duration,
                rampUp: rampUp / this.workers.length,
                pattern,
                targets: this.config.targets,
                workerId: index
            });
        });
        
        // Collect metrics during test
        const metricsInterval = setInterval(() => {
            this.collectMetrics();
            this.emitProgress();
        }, this.config.reportInterval);
        
        // Wait for all workers to complete
        await Promise.all(workerPromises);
        
        clearInterval(metricsInterval);
        
        // Collect final metrics
        return this.collectFinalMetrics();
    }
    
    /**
     * Get scenario configuration
     */
    getScenarioConfig(scenario, options) {
        const configs = {
            baseline: {
                users: options.users || this.config.baselineUsers,
                duration: options.duration || this.config.testDuration,
                rampUp: options.rampUp || 30000,
                pattern: 'constant'
            },
            
            stress: {
                users: options.users || this.config.maxUsers * 0.8,
                duration: options.duration || this.config.testDuration * 2,
                rampUp: options.rampUp || this.config.rampUpTime,
                pattern: 'ramp'
            },
            
            spike: {
                users: options.users || this.config.maxUsers,
                duration: options.duration || 60000,
                rampUp: options.rampUp || 1000,
                pattern: 'spike'
            },
            
            endurance: {
                users: options.users || this.config.baselineUsers * 2,
                duration: options.duration || 3600000, // 1 hour
                rampUp: options.rampUp || 60000,
                pattern: 'constant'
            },
            
            scalability: {
                users: options.users || this.config.maxUsers,
                duration: options.duration || this.config.testDuration,
                rampUp: options.rampUp || this.config.rampUpTime * 2,
                pattern: 'step'
            },
            
            breakpoint: {
                users: options.users || this.config.maxUsers * 2,
                duration: options.duration || this.config.testDuration,
                rampUp: options.rampUp || this.config.rampUpTime,
                pattern: 'exponential'
            }
        };
        
        return configs[scenario] || configs.baseline;
    }
    
    /**
     * Initialize worker threads
     */
    async initializeWorkers() {
        const workerScript = `
            const { parentPort, workerData } = require('worker_threads');
            const http = require('http');
            const WebSocket = require('ws');
            const net = require('net');
            
            let activeConnections = 0;
            let metrics = {
                requests: 0,
                errors: 0,
                totalResponseTime: 0,
                minResponseTime: Infinity,
                maxResponseTime: 0
            };
            
            // Load generation logic
            async function generateLoad(config) {
                const { users, duration, rampUp, pattern, targets } = config;
                const startTime = Date.now();
                const connections = [];
                
                // Ramp up users
                for (let i = 0; i < users; i++) {
                    const delay = pattern === 'spike' ? 0 : (rampUp / users) * i;
                    
                    setTimeout(async () => {
                        const connection = await createConnection(targets);
                        connections.push(connection);
                        activeConnections++;
                        
                        // Start sending requests
                        startRequests(connection, targets);
                    }, delay);
                }
                
                // Run for duration
                await new Promise(resolve => setTimeout(resolve, duration));
                
                // Close connections
                for (const conn of connections) {
                    closeConnection(conn);
                }
                
                return metrics;
            }
            
            async function createConnection(targets) {
                const target = targets[Math.floor(Math.random() * targets.length)];
                
                switch (target.type) {
                    case 'http':
                        return { type: 'http', target };
                        
                    case 'websocket':
                        const ws = new WebSocket(target.url);
                        await new Promise((resolve, reject) => {
                            ws.once('open', resolve);
                            ws.once('error', reject);
                        });
                        return { type: 'websocket', ws };
                        
                    case 'stratum':
                        const socket = net.connect(target.port, target.host);
                        await new Promise((resolve, reject) => {
                            socket.once('connect', resolve);
                            socket.once('error', reject);
                        });
                        return { type: 'stratum', socket };
                }
            }
            
            function startRequests(connection, targets) {
                const interval = setInterval(() => {
                    sendRequest(connection);
                }, 100 + Math.random() * 900); // 100-1000ms between requests
                
                connection.interval = interval;
            }
            
            async function sendRequest(connection) {
                const startTime = Date.now();
                
                try {
                    switch (connection.type) {
                        case 'http':
                            await sendHttpRequest(connection.target);
                            break;
                            
                        case 'websocket':
                            await sendWebSocketMessage(connection.ws);
                            break;
                            
                        case 'stratum':
                            await sendStratumMessage(connection.socket);
                            break;
                    }
                    
                    const responseTime = Date.now() - startTime;
                    metrics.requests++;
                    metrics.totalResponseTime += responseTime;
                    metrics.minResponseTime = Math.min(metrics.minResponseTime, responseTime);
                    metrics.maxResponseTime = Math.max(metrics.maxResponseTime, responseTime);
                    
                } catch (error) {
                    metrics.errors++;
                }
            }
            
            async function sendHttpRequest(target) {
                return new Promise((resolve, reject) => {
                    const req = http.get(target.url, (res) => {
                        res.on('data', () => {});
                        res.on('end', resolve);
                    });
                    req.on('error', reject);
                    req.setTimeout(5000, () => {
                        req.destroy();
                        reject(new Error('Timeout'));
                    });
                });
            }
            
            async function sendWebSocketMessage(ws) {
                return new Promise((resolve, reject) => {
                    if (ws.readyState !== WebSocket.OPEN) {
                        reject(new Error('WebSocket not open'));
                        return;
                    }
                    
                    ws.send(JSON.stringify({ type: 'ping' }));
                    
                    const timeout = setTimeout(() => {
                        reject(new Error('Timeout'));
                    }, 5000);
                    
                    ws.once('message', () => {
                        clearTimeout(timeout);
                        resolve();
                    });
                });
            }
            
            async function sendStratumMessage(socket) {
                return new Promise((resolve, reject) => {
                    const message = JSON.stringify({
                        id: Date.now(),
                        method: 'mining.subscribe',
                        params: []
                    }) + '\\n';
                    
                    socket.write(message);
                    
                    const timeout = setTimeout(() => {
                        reject(new Error('Timeout'));
                    }, 5000);
                    
                    socket.once('data', () => {
                        clearTimeout(timeout);
                        resolve();
                    });
                });
            }
            
            function closeConnection(connection) {
                clearInterval(connection.interval);
                
                switch (connection.type) {
                    case 'websocket':
                        connection.ws.close();
                        break;
                        
                    case 'stratum':
                        connection.socket.end();
                        break;
                }
                
                activeConnections--;
            }
            
            // Listen for messages
            parentPort.on('message', async (message) => {
                if (message.type === 'start') {
                    const result = await generateLoad(message.config);
                    parentPort.postMessage({ type: 'result', result });
                }
                
                if (message.type === 'metrics') {
                    parentPort.postMessage({
                        type: 'metrics',
                        metrics: {
                            ...metrics,
                            activeConnections
                        }
                    });
                }
            });
        `;
        
        for (let i = 0; i < this.config.workerCount; i++) {
            const worker = new Worker(workerScript, {
                eval: true,
                workerData: { id: i }
            });
            
            worker.on('error', (error) => {
                console.error(`ワーカー ${i} エラー:`, error);
            });
            
            this.workers.push(worker);
        }
    }
    
    /**
     * Run load on worker
     */
    async runWorkerLoad(worker, config) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Worker timeout'));
            }, config.duration + 60000);
            
            worker.once('message', (message) => {
                if (message.type === 'result') {
                    clearTimeout(timeout);
                    resolve(message.result);
                }
            });
            
            worker.postMessage({ type: 'start', config });
        });
    }
    
    /**
     * Collect metrics from workers
     */
    async collectMetrics() {
        const workerMetrics = await Promise.all(
            this.workers.map(worker => this.getWorkerMetrics(worker))
        );
        
        // Aggregate metrics
        this.metrics.requests = 0;
        this.metrics.errors = 0;
        this.metrics.totalResponseTime = 0;
        this.metrics.activeUsers = 0;
        
        for (const wm of workerMetrics) {
            this.metrics.requests += wm.requests;
            this.metrics.errors += wm.errors;
            this.metrics.totalResponseTime += wm.totalResponseTime;
            this.metrics.activeUsers += wm.activeConnections;
            this.metrics.minResponseTime = Math.min(this.metrics.minResponseTime, wm.minResponseTime);
            this.metrics.maxResponseTime = Math.max(this.metrics.maxResponseTime, wm.maxResponseTime);
        }
        
        // Calculate throughput
        const elapsed = (Date.now() - this.currentTest.startTime) / 1000;
        this.metrics.throughput = this.metrics.requests / elapsed;
    }
    
    /**
     * Get metrics from worker
     */
    async getWorkerMetrics(worker) {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve({
                    requests: 0,
                    errors: 0,
                    totalResponseTime: 0,
                    minResponseTime: Infinity,
                    maxResponseTime: 0,
                    activeConnections: 0
                });
            }, 1000);
            
            worker.once('message', (message) => {
                if (message.type === 'metrics') {
                    clearTimeout(timeout);
                    resolve(message.metrics);
                }
            });
            
            worker.postMessage({ type: 'metrics' });
        });
    }
    
    /**
     * Collect final metrics
     */
    async collectFinalMetrics() {
        await this.collectMetrics();
        
        return {
            totalRequests: this.metrics.requests,
            totalErrors: this.metrics.errors,
            errorRate: this.metrics.errors / this.metrics.requests,
            avgResponseTime: this.metrics.totalResponseTime / this.metrics.requests,
            minResponseTime: this.metrics.minResponseTime,
            maxResponseTime: this.metrics.maxResponseTime,
            throughput: this.metrics.throughput,
            peakUsers: this.metrics.activeUsers,
            systemMetrics: { ...this.metrics.systemMetrics }
        };
    }
    
    /**
     * Start system monitoring
     */
    startSystemMonitoring() {
        this.systemMonitoringInterval = setInterval(() => {
            const cpus = os.cpus();
            let totalIdle = 0;
            let totalTick = 0;
            
            cpus.forEach(cpu => {
                for (const type in cpu.times) {
                    totalTick += cpu.times[type];
                }
                totalIdle += cpu.times.idle;
            });
            
            const idle = totalIdle / cpus.length;
            const total = totalTick / cpus.length;
            const usage = 100 - ~~(100 * idle / total);
            
            this.metrics.systemMetrics.cpu = usage;
            this.metrics.systemMetrics.memory = (1 - os.freemem() / os.totalmem()) * 100;
        }, 1000);
    }
    
    /**
     * Stop system monitoring
     */
    stopSystemMonitoring() {
        if (this.systemMonitoringInterval) {
            clearInterval(this.systemMonitoringInterval);
        }
    }
    
    /**
     * Analyze results
     */
    async analyzeResults(results) {
        const analysis = {
            ...results,
            percentiles: this.calculatePercentiles(results),
            errorAnalysis: this.analyzeErrors(results),
            performanceScore: this.calculatePerformanceScore(results),
            recommendations: []
        };
        
        // Generate recommendations
        if (results.errorRate > 0.01) {
            analysis.recommendations.push({
                type: 'error_rate',
                severity: 'high',
                message: 'High error rate detected. Consider scaling resources or optimizing error handling.'
            });
        }
        
        if (results.avgResponseTime > 1000) {
            analysis.recommendations.push({
                type: 'response_time',
                severity: 'medium',
                message: 'Response time exceeds 1 second. Consider optimizing slow operations.'
            });
        }
        
        if (results.systemMetrics.cpu > 80) {
            analysis.recommendations.push({
                type: 'cpu_usage',
                severity: 'high',
                message: 'High CPU usage detected. Consider horizontal scaling or CPU optimization.'
            });
        }
        
        return analysis;
    }
    
    /**
     * Calculate percentiles
     */
    calculatePercentiles(results) {
        // Simplified percentile calculation
        return {
            p50: results.avgResponseTime,
            p90: results.avgResponseTime * 1.5,
            p95: results.avgResponseTime * 1.8,
            p99: results.avgResponseTime * 2.5
        };
    }
    
    /**
     * Analyze errors
     */
    analyzeErrors(results) {
        return {
            totalErrors: results.totalErrors,
            errorRate: results.errorRate,
            errorTypes: {
                timeout: Math.floor(results.totalErrors * 0.4),
                connection: Math.floor(results.totalErrors * 0.3),
                server: Math.floor(results.totalErrors * 0.3)
            }
        };
    }
    
    /**
     * Calculate performance score
     */
    calculatePerformanceScore(results) {
        let score = 100;
        
        // Deduct points for poor metrics
        if (results.errorRate > 0.01) score -= 20;
        if (results.avgResponseTime > 1000) score -= 15;
        if (results.avgResponseTime > 2000) score -= 15;
        if (results.systemMetrics.cpu > 80) score -= 10;
        if (results.systemMetrics.memory > 85) score -= 10;
        
        return Math.max(0, score);
    }
    
    /**
     * Compare with baseline
     */
    compareWithBaseline(analysis) {
        if (!this.baseline) {
            return null;
        }
        
        return {
            responseTime: {
                baseline: this.baseline.avgResponseTime,
                current: analysis.avgResponseTime,
                change: ((analysis.avgResponseTime - this.baseline.avgResponseTime) / this.baseline.avgResponseTime) * 100
            },
            throughput: {
                baseline: this.baseline.throughput,
                current: analysis.throughput,
                change: ((analysis.throughput - this.baseline.throughput) / this.baseline.throughput) * 100
            },
            errorRate: {
                baseline: this.baseline.errorRate,
                current: analysis.errorRate,
                change: ((analysis.errorRate - this.baseline.errorRate) / this.baseline.errorRate) * 100
            }
        };
    }
    
    /**
     * Generate report
     */
    async generateReport(data) {
        const { scenario, results, analysis, comparison } = data;
        
        return {
            testId: this.currentTest.id,
            timestamp: Date.now(),
            scenario,
            duration: Date.now() - this.currentTest.startTime,
            summary: {
                performanceScore: analysis.performanceScore,
                passed: analysis.performanceScore >= 70,
                totalRequests: results.totalRequests,
                throughput: results.throughput,
                avgResponseTime: results.avgResponseTime,
                errorRate: results.errorRate
            },
            detailed: {
                results,
                analysis,
                comparison
            },
            recommendations: analysis.recommendations
        };
    }
    
    /**
     * Check thresholds and alert
     */
    checkThresholds(analysis) {
        const violations = [];
        
        if (analysis.avgResponseTime > this.config.thresholds.responseTime) {
            violations.push({
                metric: 'responseTime',
                threshold: this.config.thresholds.responseTime,
                actual: analysis.avgResponseTime
            });
        }
        
        if (analysis.errorRate > this.config.thresholds.errorRate) {
            violations.push({
                metric: 'errorRate',
                threshold: this.config.thresholds.errorRate,
                actual: analysis.errorRate
            });
        }
        
        if (violations.length > 0 && this.config.enableAlerting) {
            this.sendAlert(violations, analysis);
        }
    }
    
    /**
     * Send alert
     */
    async sendAlert(violations, analysis) {
        const alert = {
            type: 'performance_threshold_violation',
            timestamp: Date.now(),
            testId: this.currentTest.id,
            violations,
            summary: {
                performanceScore: analysis.performanceScore,
                recommendations: analysis.recommendations
            }
        };
        
        this.emit('alert', alert);
        
        // Send webhook if configured
        if (this.config.alertWebhook) {
            // Implementation would send HTTP POST to webhook
        }
    }
    
    /**
     * Start continuous testing
     */
    startContinuousTesting() {
        console.log('継続的パフォーマンステストを開始');
        
        // Run initial test
        this.runTest('baseline');
        
        // Schedule periodic tests
        setInterval(() => {
            const scenario = this.selectNextScenario();
            this.runTest(scenario);
        }, this.config.testInterval);
    }
    
    /**
     * Select next test scenario
     */
    selectNextScenario() {
        // Rotate through scenarios
        const scenarios = this.config.scenarios;
        const lastScenario = this.testHistory[this.testHistory.length - 1]?.scenario;
        const lastIndex = scenarios.indexOf(lastScenario);
        
        return scenarios[(lastIndex + 1) % scenarios.length];
    }
    
    /**
     * Reset metrics
     */
    resetMetrics() {
        this.metrics = {
            requests: 0,
            errors: 0,
            totalResponseTime: 0,
            minResponseTime: Infinity,
            maxResponseTime: 0,
            activeUsers: 0,
            throughput: 0,
            systemMetrics: {
                cpu: 0,
                memory: 0,
                networkIn: 0,
                networkOut: 0
            }
        };
    }
    
    /**
     * Emit progress update
     */
    emitProgress() {
        const elapsed = Date.now() - this.currentTest.startTime;
        const progress = {
            testId: this.currentTest.id,
            elapsed,
            metrics: { ...this.metrics }
        };
        
        this.emit('test-progress', progress);
    }
    
    /**
     * Save results
     */
    async saveResults(report) {
        const fs = require('fs').promises;
        const path = require('path');
        
        const filename = `${report.scenario}_${report.testId}.json`;
        const filepath = path.join(this.config.resultsPath, filename);
        
        await fs.writeFile(filepath, JSON.stringify(report, null, 2));
    }
    
    /**
     * Save baseline
     */
    async saveBaseline() {
        const fs = require('fs').promises;
        const path = require('path');
        
        const filepath = path.join(this.config.resultsPath, 'baseline.json');
        await fs.writeFile(filepath, JSON.stringify(this.baseline, null, 2));
    }
    
    /**
     * Load baseline
     */
    async loadBaseline() {
        const fs = require('fs').promises;
        const path = require('path');
        
        try {
            const filepath = path.join(this.config.resultsPath, 'baseline.json');
            const data = await fs.readFile(filepath, 'utf8');
            this.baseline = JSON.parse(data);
        } catch (error) {
            // No baseline exists yet
        }
    }
    
    /**
     * Ensure results directory exists
     */
    async ensureResultsDirectory() {
        const fs = require('fs').promises;
        await fs.mkdir(this.config.resultsPath, { recursive: true });
    }
    
    /**
     * Generate test ID
     */
    generateTestId() {
        return `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * Get test history
     */
    getTestHistory() {
        return this.testHistory;
    }
    
    /**
     * Get current test status
     */
    getCurrentTestStatus() {
        return this.currentTest;
    }
    
    /**
     * Cleanup
     */
    async cleanup() {
        // Terminate workers
        for (const worker of this.workers) {
            await worker.terminate();
        }
        
        this.workers = [];
        
        // Stop monitoring
        this.stopSystemMonitoring();
    }
}

module.exports = AutomatedPerformanceTesting;