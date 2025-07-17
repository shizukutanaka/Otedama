#!/usr/bin/env node

/**
 * Otedama Performance Benchmarking Suite
 * Comprehensive performance testing for commercial deployment validation
 */

const { performance } = require('perf_hooks');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const cluster = require('cluster');
const fs = require('fs');
const path = require('path');

class OtedamaBenchmark {
    constructor() {
        this.config = {
            baseURL: process.env.BASE_URL || 'http://localhost:8080',
            stratumURL: process.env.STRATUM_URL || 'ws://localhost:3333',
            concurrency: parseInt(process.env.CONCURRENCY) || 1000,
            duration: parseInt(process.env.DURATION) || 60000,
            rampUpTime: parseInt(process.env.RAMP_UP_TIME) || 10000,
            reportInterval: parseInt(process.env.REPORT_INTERVAL) || 5000
        };
        
        this.metrics = {
            requests: 0,
            errors: 0,
            responses: new Map(),
            latencies: [],
            throughput: [],
            connections: 0,
            startTime: 0,
            endTime: 0
        };
        
        this.workers = [];
        this.isRunning = false;
    }

    // HTTP API Performance Testing
    async benchmarkAPI() {
        console.log('🚀 Starting API Performance Benchmark...');
        
        const endpoints = [
            '/api/stats',
            '/api/pool/info',
            '/api/pool/stats',
            '/api/miners',
            '/api/blocks',
            '/api/payments',
            '/api/defi/stats',
            '/api/dex/pairs',
            '/api/dex/orderbook/BTC-USDT',
            '/health'
        ];
        
        const results = new Map();
        
        for (const endpoint of endpoints) {
            console.log(`Testing ${endpoint}...`);
            const result = await this.loadTestEndpoint(endpoint);
            results.set(endpoint, result);
        }
        
        return results;
    }

    async loadTestEndpoint(endpoint, concurrency = 100, duration = 30000) {
        return new Promise((resolve) => {
            const stats = {
                requests: 0,
                errors: 0,
                latencies: [],
                startTime: Date.now(),
                endTime: 0
            };
            
            const makeRequest = () => {
                const start = performance.now();
                const req = http.request(`${this.config.baseURL}${endpoint}`, (res) => {
                    const end = performance.now();
                    stats.latencies.push(end - start);
                    stats.requests++;
                    
                    res.on('data', () => {});
                    res.on('end', () => {
                        if (stats.startTime + duration > Date.now()) {
                            setImmediate(makeRequest);
                        }
                    });
                });
                
                req.on('error', () => {
                    stats.errors++;
                    if (stats.startTime + duration > Date.now()) {
                        setImmediate(makeRequest);
                    }
                });
                
                req.end();
            };
            
            // Start concurrent requests
            for (let i = 0; i < concurrency; i++) {
                setTimeout(makeRequest, (i / concurrency) * 1000);
            }
            
            setTimeout(() => {
                stats.endTime = Date.now();
                stats.duration = stats.endTime - stats.startTime;
                stats.rps = (stats.requests / stats.duration) * 1000;
                stats.avgLatency = stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length;
                stats.p95Latency = this.percentile(stats.latencies, 95);
                stats.p99Latency = this.percentile(stats.latencies, 99);
                stats.errorRate = (stats.errors / (stats.requests + stats.errors)) * 100;
                
                resolve(stats);
            }, duration);
        });
    }

    // Stratum Protocol Performance Testing
    async benchmarkStratum() {
        console.log('⚡ Starting Stratum Performance Benchmark...');
        
        const minerCount = 1000;
        const testDuration = 60000;
        const results = {
            connections: 0,
            subscriptions: 0,
            submissions: 0,
            errors: 0,
            latencies: [],
            startTime: Date.now()
        };
        
        const miners = [];
        
        // Create virtual miners
        for (let i = 0; i < minerCount; i++) {
            const miner = await this.createVirtualMiner(i, results);
            miners.push(miner);
            
            // Stagger connections
            await this.delay(10);
        }
        
        // Run test
        await this.delay(testDuration);
        
        // Cleanup
        miners.forEach(miner => miner.terminate());
        
        results.endTime = Date.now();
        results.duration = results.endTime - results.startTime;
        results.avgLatency = results.latencies.reduce((a, b) => a + b, 0) / results.latencies.length;
        results.connectionsPerSecond = (results.connections / results.duration) * 1000;
        results.submissionsPerSecond = (results.submissions / results.duration) * 1000;
        
        return results;
    }

    async createVirtualMiner(id, results) {
        return new Promise((resolve) => {
            const ws = new WebSocket(this.config.stratumURL);
            let subscribed = false;
            
            ws.on('open', () => {
                results.connections++;
                
                // Subscribe to mining
                const subscribeMessage = {
                    id: 1,
                    method: 'mining.subscribe',
                    params: [`miner_${id}`, null, 'localhost', 3333]
                };
                
                ws.send(JSON.stringify(subscribeMessage));
            });
            
            ws.on('message', (data) => {
                const message = JSON.parse(data);
                
                if (message.id === 1 && !subscribed) {
                    subscribed = true;
                    results.subscriptions++;
                    
                    // Authorize worker
                    const authMessage = {
                        id: 2,
                        method: 'mining.authorize',
                        params: [`worker_${id}`, 'password']
                    };
                    
                    ws.send(JSON.stringify(authMessage));
                }
                
                if (message.method === 'mining.notify') {
                    // Submit share
                    const submitMessage = {
                        id: 3,
                        method: 'mining.submit',
                        params: [
                            `worker_${id}`,
                            message.params[0], // job_id
                            crypto.randomBytes(4).toString('hex'), // nonce
                            Math.floor(Date.now() / 1000).toString(16), // ntime
                            crypto.randomBytes(4).toString('hex') // nonce2
                        ]
                    };
                    
                    const start = performance.now();
                    ws.send(JSON.stringify(submitMessage));
                    
                    // Track submission
                    results.submissions++;
                    results.latencies.push(performance.now() - start);
                }
            });
            
            ws.on('error', () => {
                results.errors++;
            });
            
            resolve({
                terminate: () => ws.close()
            });
        });
    }

    // Memory and CPU Stress Testing
    async benchmarkSystemResources() {
        console.log('💾 Starting System Resource Benchmark...');
        
        const results = {
            memory: {
                initial: process.memoryUsage(),
                peak: process.memoryUsage(),
                final: process.memoryUsage()
            },
            cpu: {
                utilization: [],
                loadAverage: []
            },
            startTime: Date.now()
        };
        
        // Memory stress test
        const memoryStressTest = () => {
            const data = [];
            for (let i = 0; i < 1000000; i++) {
                data.push(crypto.randomBytes(1024));
            }
            return data;
        };
        
        // CPU stress test
        const cpuStressTest = () => {
            const iterations = 1000000;
            let hash = 'initial';
            
            for (let i = 0; i < iterations; i++) {
                hash = crypto.createHash('sha256').update(hash + i).digest('hex');
            }
            
            return hash;
        };
        
        // Monitor resources
        const monitor = setInterval(() => {
            const usage = process.memoryUsage();
            if (usage.heapUsed > results.memory.peak.heapUsed) {
                results.memory.peak = usage;
            }
            
            results.cpu.utilization.push(process.cpuUsage());
        }, 1000);
        
        // Run stress tests
        const tasks = [];
        for (let i = 0; i < 10; i++) {
            tasks.push(Promise.resolve().then(() => {
                memoryStressTest();
                return cpuStressTest();
            }));
        }
        
        await Promise.all(tasks);
        
        clearInterval(monitor);
        results.memory.final = process.memoryUsage();
        results.endTime = Date.now();
        results.duration = results.endTime - results.startTime;
        
        return results;
    }

    // Database Performance Testing
    async benchmarkDatabase() {
        console.log('🗄️ Starting Database Performance Benchmark...');
        
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database('./data/benchmark.db');
        
        const results = {
            insertOperations: 0,
            selectOperations: 0,
            updateOperations: 0,
            deleteOperations: 0,
            errors: 0,
            latencies: {
                insert: [],
                select: [],
                update: [],
                delete: []
            },
            startTime: Date.now()
        };
        
        // Create test table
        await this.dbRun(db, `
            CREATE TABLE IF NOT EXISTS benchmark_test (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                data TEXT,
                timestamp INTEGER,
                value REAL
            )
        `);
        
        // Insert test
        for (let i = 0; i < 10000; i++) {
            const start = performance.now();
            try {
                await this.dbRun(db, 
                    'INSERT INTO benchmark_test (data, timestamp, value) VALUES (?, ?, ?)',
                    [crypto.randomBytes(64).toString('hex'), Date.now(), Math.random()]
                );
                results.insertOperations++;
                results.latencies.insert.push(performance.now() - start);
            } catch (error) {
                results.errors++;
            }
        }
        
        // Select test
        for (let i = 0; i < 5000; i++) {
            const start = performance.now();
            try {
                await this.dbGet(db, 'SELECT * FROM benchmark_test ORDER BY RANDOM() LIMIT 1');
                results.selectOperations++;
                results.latencies.select.push(performance.now() - start);
            } catch (error) {
                results.errors++;
            }
        }
        
        // Update test
        for (let i = 0; i < 2000; i++) {
            const start = performance.now();
            try {
                await this.dbRun(db, 
                    'UPDATE benchmark_test SET value = ? WHERE id = ?',
                    [Math.random(), Math.floor(Math.random() * 10000) + 1]
                );
                results.updateOperations++;
                results.latencies.update.push(performance.now() - start);
            } catch (error) {
                results.errors++;
            }
        }
        
        // Cleanup
        await this.dbRun(db, 'DROP TABLE benchmark_test');
        db.close();
        
        results.endTime = Date.now();
        results.duration = results.endTime - results.startTime;
        
        return results;
    }

    // Network I/O Performance Testing
    async benchmarkNetworkIO() {
        console.log('🌐 Starting Network I/O Benchmark...');
        
        const results = {
            tcpConnections: 0,
            websocketConnections: 0,
            httpRequests: 0,
            dataTransferred: 0,
            errors: 0,
            latencies: [],
            startTime: Date.now()
        };
        
        // TCP Connection Test
        const tcpTest = async () => {
            const net = require('net');
            const connections = 100;
            
            for (let i = 0; i < connections; i++) {
                try {
                    const socket = new net.Socket();
                    const start = performance.now();
                    
                    socket.connect(8080, 'localhost', () => {
                        results.tcpConnections++;
                        results.latencies.push(performance.now() - start);
                        socket.end();
                    });
                    
                    socket.on('error', () => {
                        results.errors++;
                    });
                } catch (error) {
                    results.errors++;
                }
            }
        };
        
        // WebSocket Test
        const wsTest = async () => {
            const connections = 100;
            const sockets = [];
            
            for (let i = 0; i < connections; i++) {
                try {
                    const ws = new WebSocket('ws://localhost:8080');
                    const start = performance.now();
                    
                    ws.on('open', () => {
                        results.websocketConnections++;
                        results.latencies.push(performance.now() - start);
                        ws.close();
                    });
                    
                    ws.on('error', () => {
                        results.errors++;
                    });
                    
                    sockets.push(ws);
                } catch (error) {
                    results.errors++;
                }
            }
            
            await this.delay(5000);
            sockets.forEach(ws => ws.close());
        };
        
        await Promise.all([tcpTest(), wsTest()]);
        
        results.endTime = Date.now();
        results.duration = results.endTime - results.startTime;
        
        return results;
    }

    // Comprehensive Performance Report
    async generateReport(results) {
        const report = {
            timestamp: new Date().toISOString(),
            system: {
                platform: process.platform,
                arch: process.arch,
                nodeVersion: process.version,
                cpuCount: require('os').cpus().length,
                totalMemory: require('os').totalmem(),
                freeMemory: require('os').freemem()
            },
            configuration: this.config,
            results: results,
            summary: {
                overallScore: this.calculateOverallScore(results),
                recommendations: this.generateRecommendations(results),
                commercialReadiness: this.assessCommercialReadiness(results)
            }
        };
        
        // Save detailed report
        const reportPath = path.join(__dirname, '..', 'reports', `benchmark-${Date.now()}.json`);
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        
        // Generate human-readable summary
        const summaryPath = path.join(__dirname, '..', 'reports', `benchmark-summary-${Date.now()}.txt`);
        fs.writeFileSync(summaryPath, this.generateSummaryReport(report));
        
        console.log(`📊 Benchmark report saved to: ${reportPath}`);
        console.log(`📋 Summary report saved to: ${summaryPath}`);
        
        return report;
    }

    calculateOverallScore(results) {
        let score = 100;
        
        // API Performance (30%)
        if (results.api) {
            const avgRPS = Array.from(results.api.values()).reduce((sum, r) => sum + r.rps, 0) / results.api.size;
            const avgLatency = Array.from(results.api.values()).reduce((sum, r) => sum + r.avgLatency, 0) / results.api.size;
            
            if (avgRPS < 1000) score -= 10;
            if (avgLatency > 100) score -= 10;
        }
        
        // Stratum Performance (25%)
        if (results.stratum) {
            if (results.stratum.connectionsPerSecond < 100) score -= 10;
            if (results.stratum.submissionsPerSecond < 1000) score -= 10;
        }
        
        // System Resources (20%)
        if (results.system) {
            const memoryIncrease = results.system.memory.peak.heapUsed - results.system.memory.initial.heapUsed;
            if (memoryIncrease > 1073741824) score -= 10; // 1GB
        }
        
        // Database Performance (15%)
        if (results.database) {
            const avgInsertLatency = results.database.latencies.insert.reduce((a, b) => a + b, 0) / results.database.latencies.insert.length;
            if (avgInsertLatency > 10) score -= 10;
        }
        
        // Network I/O (10%)
        if (results.network) {
            if (results.network.errors > results.network.tcpConnections * 0.05) score -= 10;
        }
        
        return Math.max(0, score);
    }

    generateRecommendations(results) {
        const recommendations = [];
        
        if (results.api) {
            const avgErrorRate = Array.from(results.api.values()).reduce((sum, r) => sum + r.errorRate, 0) / results.api.size;
            if (avgErrorRate > 1) {
                recommendations.push('API error rate is high - implement better error handling and rate limiting');
            }
        }
        
        if (results.stratum && results.stratum.errors > 10) {
            recommendations.push('Stratum connection errors detected - optimize connection handling');
        }
        
        if (results.system) {
            const memoryLeak = results.system.memory.final.heapUsed > results.system.memory.initial.heapUsed * 1.5;
            if (memoryLeak) {
                recommendations.push('Potential memory leak detected - review memory management');
            }
        }
        
        if (results.database) {
            const avgInsertLatency = results.database.latencies.insert.reduce((a, b) => a + b, 0) / results.database.latencies.insert.length;
            if (avgInsertLatency > 5) {
                recommendations.push('Database insert performance is slow - consider indexing and query optimization');
            }
        }
        
        return recommendations;
    }

    assessCommercialReadiness(results) {
        const score = this.calculateOverallScore(results);
        
        if (score >= 90) return 'EXCELLENT - Ready for commercial deployment';
        if (score >= 80) return 'GOOD - Minor optimizations recommended';
        if (score >= 70) return 'ACCEPTABLE - Some improvements needed';
        if (score >= 60) return 'POOR - Significant improvements required';
        return 'CRITICAL - Major performance issues detected';
    }

    generateSummaryReport(report) {
        return `
OTEDAMA PERFORMANCE BENCHMARK REPORT
====================================

Test Date: ${report.timestamp}
System: ${report.system.platform} ${report.system.arch}
Node.js: ${report.system.nodeVersion}
CPU Cores: ${report.system.cpuCount}
Total Memory: ${Math.round(report.system.totalMemory / 1024 / 1024 / 1024)}GB

OVERALL SCORE: ${report.summary.overallScore}/100
COMMERCIAL READINESS: ${report.summary.commercialReadiness}

API PERFORMANCE:
${report.results.api ? Array.from(report.results.api.entries()).map(([endpoint, stats]) => 
    `  ${endpoint}: ${stats.rps.toFixed(0)} RPS, ${stats.avgLatency.toFixed(2)}ms avg, ${stats.errorRate.toFixed(2)}% errors`
).join('\n') : '  Not tested'}

STRATUM PERFORMANCE:
${report.results.stratum ? 
    `  Connections: ${report.results.stratum.connections}
  Submissions: ${report.results.stratum.submissions}
  Errors: ${report.results.stratum.errors}
  Avg Latency: ${report.results.stratum.avgLatency?.toFixed(2)}ms` : '  Not tested'}

DATABASE PERFORMANCE:
${report.results.database ? 
    `  Insert Operations: ${report.results.database.insertOperations}
  Select Operations: ${report.results.database.selectOperations}
  Update Operations: ${report.results.database.updateOperations}
  Errors: ${report.results.database.errors}` : '  Not tested'}

RECOMMENDATIONS:
${report.summary.recommendations.map(rec => `  • ${rec}`).join('\n')}

For detailed metrics, see the full JSON report.
        `;
    }

    // Utility Methods
    percentile(arr, p) {
        const sorted = arr.sort((a, b) => a - b);
        const index = (p / 100) * (sorted.length - 1);
        return sorted[Math.floor(index)];
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    dbRun(db, sql, params = []) {
        return new Promise((resolve, reject) => {
            db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve(this);
            });
        });
    }

    dbGet(db, sql, params = []) {
        return new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    // Main Benchmark Runner
    async run() {
        console.log('🎯 Starting Otedama Performance Benchmark Suite...\n');
        
        const results = {};
        
        try {
            // API Performance
            results.api = await this.benchmarkAPI();
            
            // Stratum Performance
            results.stratum = await this.benchmarkStratum();
            
            // System Resources
            results.system = await this.benchmarkSystemResources();
            
            // Database Performance
            results.database = await this.benchmarkDatabase();
            
            // Network I/O
            results.network = await this.benchmarkNetworkIO();
            
            // Generate comprehensive report
            const report = await this.generateReport(results);
            
            console.log('\n🏆 Benchmark Complete!');
            console.log(`Overall Score: ${report.summary.overallScore}/100`);
            console.log(`Commercial Readiness: ${report.summary.commercialReadiness}`);
            
            return report;
            
        } catch (error) {
            console.error('❌ Benchmark failed:', error.message);
            throw error;
        }
    }
}

// CLI Interface
if (require.main === module) {
    const benchmark = new OtedamaBenchmark();
    benchmark.run()
        .then(report => {
            process.exit(report.summary.overallScore >= 70 ? 0 : 1);
        })
        .catch(error => {
            console.error('Benchmark failed:', error);
            process.exit(1);
        });
}

module.exports = OtedamaBenchmark;