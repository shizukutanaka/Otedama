#!/usr/bin/env node

/**
 * Otedama Load Testing Suite
 * Advanced load testing for commercial-grade performance validation
 */

const cluster = require('cluster');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const { performance } = require('perf_hooks');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class OtedamaLoadTester {
    constructor() {
        this.config = {
            baseURL: process.env.BASE_URL || 'http://localhost:8080',
            stratumURL: process.env.STRATUM_URL || 'ws://localhost:3333',
            maxConcurrentUsers: parseInt(process.env.MAX_CONCURRENT_USERS) || 10000,
            rampUpDuration: parseInt(process.env.RAMP_UP_DURATION) || 300000, // 5 minutes
            testDuration: parseInt(process.env.TEST_DURATION) || 1800000, // 30 minutes
            rampDownDuration: parseInt(process.env.RAMP_DOWN_DURATION) || 300000, // 5 minutes
            reportInterval: parseInt(process.env.REPORT_INTERVAL) || 10000,
            errorThreshold: parseFloat(process.env.ERROR_THRESHOLD) || 0.05,
            latencyThreshold: parseInt(process.env.LATENCY_THRESHOLD) || 1000
        };
        
        this.stats = {
            totalRequests: 0,
            totalErrors: 0,
            totalConnections: 0,
            activeConnections: 0,
            responseTime: [],
            throughput: [],
            errors: new Map(),
            startTime: 0,
            endTime: 0,
            stages: {
                rampUp: { start: 0, end: 0 },
                load: { start: 0, end: 0 },
                rampDown: { start: 0, end: 0 }
            }
        };
        
        this.workers = [];
        this.isRunning = false;
        this.currentUsers = 0;
        this.testScenarios = [];
    }

    // Test Scenarios
    setupScenarios() {
        this.testScenarios = [
            {
                name: 'Mining Pool Operations',
                weight: 40,
                actions: [
                    { type: 'http', endpoint: '/api/pool/stats', frequency: 0.5 },
                    { type: 'http', endpoint: '/api/miners', frequency: 0.3 },
                    { type: 'http', endpoint: '/api/blocks', frequency: 0.2 },
                    { type: 'stratum', action: 'mine', frequency: 1.0 }
                ]
            },
            {
                name: 'DEX Trading Operations',
                weight: 30,
                actions: [
                    { type: 'http', endpoint: '/api/dex/pairs', frequency: 0.6 },
                    { type: 'http', endpoint: '/api/dex/orderbook/BTC-USDT', frequency: 0.4 },
                    { type: 'http', endpoint: '/api/dex/trades', frequency: 0.3 },
                    { type: 'websocket', endpoint: '/ws/dex', frequency: 0.2 }
                ]
            },
            {
                name: 'DeFi Operations',
                weight: 20,
                actions: [
                    { type: 'http', endpoint: '/api/defi/pools', frequency: 0.4 },
                    { type: 'http', endpoint: '/api/defi/farming', frequency: 0.3 },
                    { type: 'http', endpoint: '/api/defi/stats', frequency: 0.3 }
                ]
            },
            {
                name: 'General API Usage',
                weight: 10,
                actions: [
                    { type: 'http', endpoint: '/api/stats', frequency: 0.5 },
                    { type: 'http', endpoint: '/health', frequency: 0.3 },
                    { type: 'http', endpoint: '/api/config', frequency: 0.2 }
                ]
            }
        ];
    }

    // Worker Management
    createWorker(workerId, userLoad) {
        return new Promise((resolve, reject) => {
            const worker = cluster.fork({
                WORKER_ID: workerId,
                USER_LOAD: userLoad,
                BASE_URL: this.config.baseURL,
                STRATUM_URL: this.config.stratumURL
            });
            
            worker.on('message', (msg) => {
                this.handleWorkerMessage(msg);
            });
            
            worker.on('error', (error) => {
                console.error(`Worker ${workerId} error:`, error);
                this.stats.totalErrors++;
                reject(error);
            });
            
            worker.on('online', () => {
                resolve(worker);
            });
            
            this.workers.push(worker);
        });
    }

    handleWorkerMessage(message) {
        switch (message.type) {
            case 'stats':
                this.updateStats(message.data);
                break;
            case 'error':
                this.handleError(message.data);
                break;
            case 'connection':
                this.updateConnectionCount(message.data);
                break;
        }
    }

    updateStats(data) {
        this.stats.totalRequests += data.requests || 0;
        this.stats.totalErrors += data.errors || 0;
        this.stats.responseTime.push(...(data.responseTime || []));
        this.stats.throughput.push(data.throughput || 0);
    }

    handleError(error) {
        const errorKey = `${error.type}:${error.code}`;
        this.stats.errors.set(errorKey, (this.stats.errors.get(errorKey) || 0) + 1);
    }

    updateConnectionCount(change) {
        this.stats.activeConnections += change;
        this.stats.totalConnections = Math.max(this.stats.totalConnections, this.stats.activeConnections);
    }

    // Load Testing Phases
    async rampUp() {
        console.log('📈 Starting ramp-up phase...');
        this.stats.stages.rampUp.start = Date.now();
        
        const usersPerSecond = this.config.maxConcurrentUsers / (this.config.rampUpDuration / 1000);
        const interval = 1000 / usersPerSecond;
        
        let currentUsers = 0;
        
        while (currentUsers < this.config.maxConcurrentUsers && this.isRunning) {
            const usersToAdd = Math.min(10, this.config.maxConcurrentUsers - currentUsers);
            
            for (let i = 0; i < usersToAdd; i++) {
                await this.createVirtualUser(currentUsers + i);
            }
            
            currentUsers += usersToAdd;
            this.currentUsers = currentUsers;
            
            await this.delay(interval * usersToAdd);
        }
        
        this.stats.stages.rampUp.end = Date.now();
        console.log(`✅ Ramp-up complete: ${this.currentUsers} users`);
    }

    async loadTest() {
        console.log('⚡ Starting load test phase...');
        this.stats.stages.load.start = Date.now();
        
        // Monitor performance during load test
        const monitorInterval = setInterval(() => {
            this.reportStatus();
            this.checkThresholds();
        }, this.config.reportInterval);
        
        // Wait for test duration
        await this.delay(this.config.testDuration);
        
        clearInterval(monitorInterval);
        this.stats.stages.load.end = Date.now();
        console.log('✅ Load test phase complete');
    }

    async rampDown() {
        console.log('📉 Starting ramp-down phase...');
        this.stats.stages.rampDown.start = Date.now();
        
        const usersPerSecond = this.currentUsers / (this.config.rampDownDuration / 1000);
        const interval = 1000 / usersPerSecond;
        
        while (this.currentUsers > 0 && this.isRunning) {
            const usersToRemove = Math.min(10, this.currentUsers);
            
            for (let i = 0; i < usersToRemove; i++) {
                this.removeVirtualUser();
            }
            
            this.currentUsers -= usersToRemove;
            await this.delay(interval * usersToRemove);
        }
        
        this.stats.stages.rampDown.end = Date.now();
        console.log('✅ Ramp-down complete');
    }

    async createVirtualUser(userId) {
        const scenario = this.selectScenario();
        const userLoad = Math.floor(this.config.maxConcurrentUsers / 100) + 1;
        
        await this.createWorker(userId, userLoad);
    }

    removeVirtualUser() {
        if (this.workers.length > 0) {
            const worker = this.workers.pop();
            worker.kill();
        }
    }

    selectScenario() {
        const rand = Math.random() * 100;
        let cumulative = 0;
        
        for (const scenario of this.testScenarios) {
            cumulative += scenario.weight;
            if (rand <= cumulative) {
                return scenario;
            }
        }
        
        return this.testScenarios[0];
    }

    // Monitoring and Reporting
    reportStatus() {
        const now = Date.now();
        const elapsed = now - this.stats.startTime;
        const avgResponseTime = this.stats.responseTime.length > 0 
            ? this.stats.responseTime.reduce((a, b) => a + b, 0) / this.stats.responseTime.length 
            : 0;
        
        const currentThroughput = this.stats.totalRequests / (elapsed / 1000);
        const errorRate = this.stats.totalErrors / this.stats.totalRequests;
        
        console.log(`
📊 Load Test Status Report
==========================
Time Elapsed: ${Math.round(elapsed / 1000)}s
Active Users: ${this.currentUsers}
Total Requests: ${this.stats.totalRequests}
Total Errors: ${this.stats.totalErrors}
Error Rate: ${(errorRate * 100).toFixed(2)}%
Throughput: ${currentThroughput.toFixed(2)} req/s
Avg Response Time: ${avgResponseTime.toFixed(2)}ms
Active Connections: ${this.stats.activeConnections}
        `);
    }

    checkThresholds() {
        const errorRate = this.stats.totalErrors / this.stats.totalRequests;
        const avgResponseTime = this.stats.responseTime.length > 0 
            ? this.stats.responseTime.reduce((a, b) => a + b, 0) / this.stats.responseTime.length 
            : 0;
        
        if (errorRate > this.config.errorThreshold) {
            console.warn(`⚠️  Error rate exceeded threshold: ${(errorRate * 100).toFixed(2)}%`);
        }
        
        if (avgResponseTime > this.config.latencyThreshold) {
            console.warn(`⚠️  Response time exceeded threshold: ${avgResponseTime.toFixed(2)}ms`);
        }
    }

    // Stress Testing Scenarios
    async spikeTesting() {
        console.log('🔥 Starting spike testing...');
        
        // Sudden load increase
        const spikeUsers = this.config.maxConcurrentUsers * 2;
        const spikeWorkers = [];
        
        for (let i = 0; i < spikeUsers; i++) {
            const worker = await this.createWorker(`spike_${i}`, 1);
            spikeWorkers.push(worker);
        }
        
        // Hold spike for 30 seconds
        await this.delay(30000);
        
        // Remove spike load
        spikeWorkers.forEach(worker => worker.kill());
        
        console.log('✅ Spike testing complete');
    }

    async volumeTesting() {
        console.log('📊 Starting volume testing...');
        
        // Gradual increase to extreme load
        const maxVolume = this.config.maxConcurrentUsers * 5;
        const volumeWorkers = [];
        
        for (let i = 0; i < maxVolume; i++) {
            const worker = await this.createWorker(`volume_${i}`, 1);
            volumeWorkers.push(worker);
            
            if (i % 100 === 0) {
                await this.delay(1000);
                this.reportStatus();
            }
        }
        
        // Hold volume for 60 seconds
        await this.delay(60000);
        
        // Remove volume load
        volumeWorkers.forEach(worker => worker.kill());
        
        console.log('✅ Volume testing complete');
    }

    async enduranceTesting() {
        console.log('⏱️ Starting endurance testing...');
        
        // Run at 50% capacity for extended period
        const enduranceUsers = Math.floor(this.config.maxConcurrentUsers * 0.5);
        const enduranceWorkers = [];
        
        for (let i = 0; i < enduranceUsers; i++) {
            const worker = await this.createWorker(`endurance_${i}`, 1);
            enduranceWorkers.push(worker);
        }
        
        // Run for 2 hours
        const enduranceDuration = 7200000; // 2 hours
        const reportInterval = setInterval(() => {
            this.reportStatus();
            this.checkMemoryUsage();
        }, 60000); // Report every minute
        
        await this.delay(enduranceDuration);
        
        clearInterval(reportInterval);
        enduranceWorkers.forEach(worker => worker.kill());
        
        console.log('✅ Endurance testing complete');
    }

    checkMemoryUsage() {
        const usage = process.memoryUsage();
        const memoryUsage = usage.heapUsed / 1024 / 1024; // MB
        
        console.log(`💾 Memory usage: ${memoryUsage.toFixed(2)} MB`);
        
        if (memoryUsage > 2048) { // 2GB threshold
            console.warn('⚠️  High memory usage detected');
        }
    }

    // Report Generation
    async generateLoadTestReport() {
        const report = {
            timestamp: new Date().toISOString(),
            configuration: this.config,
            testDuration: this.stats.endTime - this.stats.startTime,
            summary: {
                totalRequests: this.stats.totalRequests,
                totalErrors: this.stats.totalErrors,
                errorRate: this.stats.totalErrors / this.stats.totalRequests,
                maxConcurrentUsers: this.config.maxConcurrentUsers,
                peakThroughput: Math.max(...this.stats.throughput),
                avgResponseTime: this.stats.responseTime.reduce((a, b) => a + b, 0) / this.stats.responseTime.length,
                p95ResponseTime: this.percentile(this.stats.responseTime, 95),
                p99ResponseTime: this.percentile(this.stats.responseTime, 99),
                maxResponseTime: Math.max(...this.stats.responseTime),
                minResponseTime: Math.min(...this.stats.responseTime)
            },
            phases: this.stats.stages,
            errors: Object.fromEntries(this.stats.errors),
            performance: {
                passed: this.assessPerformance(),
                score: this.calculateLoadScore(),
                recommendations: this.generateLoadRecommendations()
            }
        };
        
        // Save report
        const reportPath = path.join(__dirname, '..', 'reports', `load-test-${Date.now()}.json`);
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        
        console.log(`📊 Load test report saved: ${reportPath}`);
        return report;
    }

    assessPerformance() {
        const errorRate = this.stats.totalErrors / this.stats.totalRequests;
        const avgResponseTime = this.stats.responseTime.reduce((a, b) => a + b, 0) / this.stats.responseTime.length;
        
        return {
            errorRateAcceptable: errorRate <= this.config.errorThreshold,
            responseTimeAcceptable: avgResponseTime <= this.config.latencyThreshold,
            overallPass: errorRate <= this.config.errorThreshold && avgResponseTime <= this.config.latencyThreshold
        };
    }

    calculateLoadScore() {
        let score = 100;
        
        const errorRate = this.stats.totalErrors / this.stats.totalRequests;
        const avgResponseTime = this.stats.responseTime.reduce((a, b) => a + b, 0) / this.stats.responseTime.length;
        
        // Error rate scoring
        if (errorRate > 0.01) score -= 20;
        else if (errorRate > 0.005) score -= 10;
        
        // Response time scoring
        if (avgResponseTime > 2000) score -= 30;
        else if (avgResponseTime > 1000) score -= 20;
        else if (avgResponseTime > 500) score -= 10;
        
        // Throughput scoring
        const throughput = this.stats.totalRequests / ((this.stats.endTime - this.stats.startTime) / 1000);
        if (throughput < 1000) score -= 20;
        else if (throughput < 5000) score -= 10;
        
        return Math.max(0, score);
    }

    generateLoadRecommendations() {
        const recommendations = [];
        const errorRate = this.stats.totalErrors / this.stats.totalRequests;
        const avgResponseTime = this.stats.responseTime.reduce((a, b) => a + b, 0) / this.stats.responseTime.length;
        
        if (errorRate > 0.01) {
            recommendations.push('High error rate detected - implement circuit breakers and better error handling');
        }
        
        if (avgResponseTime > 1000) {
            recommendations.push('High response times - consider caching, database optimization, and load balancing');
        }
        
        if (this.stats.totalConnections < this.config.maxConcurrentUsers * 0.8) {
            recommendations.push('Connection limit reached - optimize connection pooling and keep-alive settings');
        }
        
        return recommendations;
    }

    // Utility Methods
    percentile(arr, p) {
        if (arr.length === 0) return 0;
        const sorted = arr.sort((a, b) => a - b);
        const index = (p / 100) * (sorted.length - 1);
        return sorted[Math.floor(index)];
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Main Test Runner
    async runLoadTest() {
        console.log('🚀 Starting Otedama Load Test Suite...\n');
        
        this.setupScenarios();
        this.isRunning = true;
        this.stats.startTime = Date.now();
        
        try {
            await this.rampUp();
            await this.loadTest();
            await this.rampDown();
            
            this.stats.endTime = Date.now();
            
            // Generate report
            const report = await this.generateLoadTestReport();
            
            console.log('\n🏆 Load Test Complete!');
            console.log(`Performance Score: ${report.performance.score}/100`);
            console.log(`Test Passed: ${report.performance.passed.overallPass}`);
            
            return report;
            
        } catch (error) {
            console.error('❌ Load test failed:', error);
            throw error;
        } finally {
            this.isRunning = false;
            this.workers.forEach(worker => worker.kill());
        }
    }

    async runStressTest() {
        console.log('🔥 Starting Otedama Stress Test Suite...\n');
        
        this.setupScenarios();
        this.isRunning = true;
        this.stats.startTime = Date.now();
        
        try {
            await this.spikeTesting();
            await this.volumeTesting();
            await this.enduranceTesting();
            
            this.stats.endTime = Date.now();
            
            const report = await this.generateLoadTestReport();
            
            console.log('\n🏆 Stress Test Complete!');
            console.log(`Performance Score: ${report.performance.score}/100`);
            
            return report;
            
        } catch (error) {
            console.error('❌ Stress test failed:', error);
            throw error;
        } finally {
            this.isRunning = false;
            this.workers.forEach(worker => worker.kill());
        }
    }
}

// Worker Process Logic
if (cluster.isWorker) {
    const workerId = process.env.WORKER_ID;
    const userLoad = parseInt(process.env.USER_LOAD) || 1;
    const baseURL = process.env.BASE_URL;
    const stratumURL = process.env.STRATUM_URL;
    
    const workerStats = {
        requests: 0,
        errors: 0,
        responseTime: [],
        connections: 0
    };
    
    // Worker HTTP client
    const makeRequest = (endpoint) => {
        return new Promise((resolve) => {
            const start = performance.now();
            
            const req = http.request(`${baseURL}${endpoint}`, (res) => {
                const end = performance.now();
                workerStats.requests++;
                workerStats.responseTime.push(end - start);
                
                res.on('data', () => {});
                res.on('end', () => {
                    resolve({ success: true, time: end - start });
                });
            });
            
            req.on('error', (error) => {
                workerStats.errors++;
                resolve({ success: false, error: error.message });
            });
            
            req.end();
        });
    };
    
    // Worker main loop
    const runWorker = async () => {
        const endpoints = [
            '/api/stats',
            '/api/pool/stats',
            '/api/miners',
            '/api/blocks',
            '/api/dex/pairs',
            '/health'
        ];
        
        while (true) {
            const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
            await makeRequest(endpoint);
            
            // Send stats to master
            if (workerStats.requests % 100 === 0) {
                process.send({
                    type: 'stats',
                    data: {
                        requests: workerStats.requests,
                        errors: workerStats.errors,
                        responseTime: workerStats.responseTime.splice(0),
                        throughput: workerStats.requests
                    }
                });
            }
            
            await new Promise(resolve => setTimeout(resolve, Math.random() * 1000));
        }
    };
    
    runWorker().catch(console.error);
}

// CLI Interface
if (require.main === module && cluster.isMaster) {
    const loadTester = new OtedamaLoadTester();
    const testType = process.argv[2] || 'load';
    
    if (testType === 'stress') {
        loadTester.runStressTest()
            .then(report => {
                process.exit(report.performance.passed.overallPass ? 0 : 1);
            })
            .catch(error => {
                console.error('Stress test failed:', error);
                process.exit(1);
            });
    } else {
        loadTester.runLoadTest()
            .then(report => {
                process.exit(report.performance.passed.overallPass ? 0 : 1);
            })
            .catch(error => {
                console.error('Load test failed:', error);
                process.exit(1);
            });
    }
}

module.exports = OtedamaLoadTester;