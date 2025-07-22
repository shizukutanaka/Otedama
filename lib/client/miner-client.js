/**
 * Miner Client Software
 * User-friendly mining client with automatic payout management
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import os from 'os';
import { createHash } from 'crypto';

/**
 * Miner Client
 */
export class MinerClient extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Pool connection
            poolUrl: config.poolUrl || 'stratum+tcp://pool.otedama.io:3333',
            workerName: config.workerName || os.hostname(),
            
            // Payout configuration
            payoutAddress: config.payoutAddress,
            minPayout: config.minPayout || 0.001,
            
            // Mining settings
            algorithm: config.algorithm || 'sha256',
            threads: config.threads || os.cpus().length - 1,
            intensity: config.intensity || 80, // 80% intensity
            
            // Profitability settings
            electricityCost: config.electricityCost || 0.10, // $/kWh
            powerConsumption: config.powerConsumption || 1000, // Watts
            minProfitability: config.minProfitability || 0, // Mine even at loss if 0
            
            // Auto-switching
            autoSwitch: config.autoSwitch !== false,
            switchThreshold: config.switchThreshold || 0.05, // 5% better
            
            ...config
        };
        
        // Validate required configuration
        if (!this.config.payoutAddress) {
            throw new Error('Payout address is required');
        }
        
        // Mining state
        this.mining = false;
        this.connected = false;
        this.currentJob = null;
        this.submitQueue = [];
        
        // Performance tracking
        this.stats = {
            hashrate: 0,
            shares: {
                accepted: 0,
                rejected: 0,
                stale: 0
            },
            uptime: 0,
            earnings: {
                unpaid: 0,
                paid: 0,
                daily: 0,
                monthly: 0
            }
        };
        
        // Profitability tracking
        this.profitability = {
            current: 0,
            daily: 0,
            electricityCost: 0,
            netProfit: 0,
            breakEven: false
        };
        
        // Connection management
        this.connection = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        
        // Mining workers
        this.workers = [];
        
        // Dashboard data
        this.dashboardData = {
            systemInfo: this.getSystemInfo(),
            miningHistory: [],
            profitHistory: []
        };
    }
    
    /**
     * Start mining
     */
    async start() {
        console.log('Starting Otedama Miner Client...');
        console.log(`Payout Address: ${this.config.payoutAddress}`);
        console.log(`Min Payout: ${this.config.minPayout} BTC`);
        
        try {
            // Check profitability before starting
            const profitable = await this.checkProfitability();
            
            if (!profitable && this.config.minProfitability > 0) {
                this.emit('error', new Error('Mining not profitable at current rates'));
                return false;
            }
            
            // Connect to pool
            await this.connectToPool();
            
            // Start mining workers
            this.startMiningWorkers();
            
            // Start monitoring
            this.startMonitoring();
            
            this.mining = true;
            this.emit('started', {
                algorithm: this.config.algorithm,
                threads: this.config.threads,
                pool: this.config.poolUrl
            });
            
            // Show initial dashboard
            this.displayDashboard();
            
            return true;
            
        } catch (error) {
            this.emit('error', error);
            return false;
        }
    }
    
    /**
     * Stop mining
     */
    async stop() {
        console.log('Stopping miner...');
        
        this.mining = false;
        
        // Stop workers
        for (const worker of this.workers) {
            worker.terminate();
        }
        this.workers = [];
        
        // Disconnect from pool
        if (this.connection) {
            this.connection.close();
        }
        
        this.emit('stopped', {
            totalShares: this.stats.shares.accepted + this.stats.shares.rejected,
            earnings: this.stats.earnings
        });
    }
    
    /**
     * Connect to mining pool
     */
    async connectToPool() {
        return new Promise((resolve, reject) => {
            const poolUrl = this.config.poolUrl.replace('stratum+tcp://', 'ws://');
            
            this.connection = new WebSocket(poolUrl);
            
            this.connection.on('open', () => {
                console.log('Connected to pool');
                this.connected = true;
                this.reconnectAttempts = 0;
                
                // Subscribe to pool
                this.subscribe();
                
                resolve();
            });
            
            this.connection.on('message', (data) => {
                this.handlePoolMessage(JSON.parse(data));
            });
            
            this.connection.on('error', (error) => {
                console.error('Pool connection error:', error);
                this.emit('error', error);
            });
            
            this.connection.on('close', () => {
                this.connected = false;
                console.log('Disconnected from pool');
                
                // Auto-reconnect
                if (this.mining && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.reconnectAttempts++;
                    setTimeout(() => {
                        this.connectToPool();
                    }, Math.min(30000, this.reconnectAttempts * 5000));
                }
            });
            
            // Timeout
            setTimeout(() => {
                if (!this.connected) {
                    reject(new Error('Connection timeout'));
                }
            }, 30000);
        });
    }
    
    /**
     * Subscribe to pool
     */
    subscribe() {
        const subscribeMessage = {
            id: 1,
            method: 'mining.subscribe',
            params: [
                'OtedamaMiner/1.0',
                null,
                this.config.poolUrl,
                this.config.workerName
            ]
        };
        
        this.sendToPool(subscribeMessage);
        
        // Authorize worker
        const authMessage = {
            id: 2,
            method: 'mining.authorize',
            params: [
                `${this.config.payoutAddress}.${this.config.workerName}`,
                'x'
            ]
        };
        
        this.sendToPool(authMessage);
    }
    
    /**
     * Handle pool messages
     */
    handlePoolMessage(message) {
        if (message.method) {
            switch (message.method) {
                case 'mining.notify':
                    this.handleNewJob(message.params);
                    break;
                    
                case 'mining.set_difficulty':
                    this.handleSetDifficulty(message.params[0]);
                    break;
                    
                case 'client.show_message':
                    console.log('Pool message:', message.params[0]);
                    break;
            }
        } else if (message.id) {
            // Response to our request
            this.handlePoolResponse(message);
        }
    }
    
    /**
     * Handle new mining job
     */
    handleNewJob(params) {
        this.currentJob = {
            jobId: params[0],
            prevHash: params[1],
            coinbase1: params[2],
            coinbase2: params[3],
            merkleBranch: params[4],
            version: params[5],
            bits: params[6],
            time: params[7],
            cleanJobs: params[8]
        };
        
        // Notify workers of new job
        for (const worker of this.workers) {
            worker.postMessage({
                type: 'newJob',
                job: this.currentJob
            });
        }
        
        this.emit('new-job', {
            jobId: this.currentJob.jobId,
            clean: this.currentJob.cleanJobs
        });
    }
    
    /**
     * Start mining workers
     */
    startMiningWorkers() {
        const { Worker } = require('worker_threads');
        
        for (let i = 0; i < this.config.threads; i++) {
            const worker = new Worker(`
                const { parentPort } = require('worker_threads');
                const crypto = require('crypto');
                
                let currentJob = null;
                let mining = true;
                
                parentPort.on('message', (msg) => {
                    if (msg.type === 'newJob') {
                        currentJob = msg.job;
                    } else if (msg.type === 'stop') {
                        mining = false;
                    }
                });
                
                // Mining loop
                async function mine() {
                    let nonce = Math.floor(Math.random() * 0xFFFFFFFF);
                    let hashCount = 0;
                    
                    while (mining) {
                        if (!currentJob) {
                            await new Promise(resolve => setTimeout(resolve, 100));
                            continue;
                        }
                        
                        // Construct block header
                        const header = constructHeader(currentJob, nonce);
                        
                        // Calculate hash
                        const hash = doublesha256(header);
                        hashCount++;
                        
                        // Check if meets difficulty
                        if (checkDifficulty(hash, currentJob.bits)) {
                            parentPort.postMessage({
                                type: 'share',
                                jobId: currentJob.jobId,
                                nonce: nonce,
                                time: currentJob.time,
                                hash: hash
                            });
                        }
                        
                        // Report hashrate
                        if (hashCount % 100000 === 0) {
                            parentPort.postMessage({
                                type: 'hashrate',
                                hashes: hashCount
                            });
                            hashCount = 0;
                        }
                        
                        nonce = (nonce + 1) >>> 0;
                    }
                }
                
                function constructHeader(job, nonce) {
                    // Simplified - real implementation would properly construct header
                    return Buffer.concat([
                        Buffer.from(job.version, 'hex'),
                        Buffer.from(job.prevHash, 'hex'),
                        Buffer.from('merkleroot', 'hex'),
                        Buffer.from(job.time, 'hex'),
                        Buffer.from(job.bits, 'hex'),
                        Buffer.from(nonce.toString(16).padStart(8, '0'), 'hex')
                    ]);
                }
                
                function doublesha256(data) {
                    return crypto.createHash('sha256')
                        .update(crypto.createHash('sha256').update(data).digest())
                        .digest('hex');
                }
                
                function checkDifficulty(hash, bits) {
                    // Simplified difficulty check
                    return hash.startsWith('00000');
                }
                
                mine();
            `, { eval: true });
            
            worker.on('message', (msg) => {
                if (msg.type === 'share') {
                    this.submitShare(msg);
                } else if (msg.type === 'hashrate') {
                    this.updateHashrate(msg.hashes);
                }
            });
            
            worker.on('error', (error) => {
                console.error('Worker error:', error);
            });
            
            this.workers.push(worker);
        }
    }
    
    /**
     * Submit share to pool
     */
    submitShare(share) {
        const submitMessage = {
            id: Date.now(),
            method: 'mining.submit',
            params: [
                `${this.config.payoutAddress}.${this.config.workerName}`,
                share.jobId,
                share.time,
                share.nonce
            ]
        };
        
        this.sendToPool(submitMessage);
        this.submitQueue.push({
            id: submitMessage.id,
            share: share,
            timestamp: Date.now()
        });
    }
    
    /**
     * Handle pool response
     */
    handlePoolResponse(message) {
        // Check if it's a share submission response
        const submission = this.submitQueue.find(s => s.id === message.id);
        if (submission) {
            if (message.result) {
                this.stats.shares.accepted++;
                this.emit('share-accepted', {
                    hash: submission.share.hash
                });
            } else {
                this.stats.shares.rejected++;
                this.emit('share-rejected', {
                    reason: message.error
                });
            }
            
            // Remove from queue
            this.submitQueue = this.submitQueue.filter(s => s.id !== message.id);
        }
    }
    
    /**
     * Check profitability
     */
    async checkProfitability() {
        try {
            // Get current mining difficulty and price
            const marketData = await this.fetchMarketData();
            
            // Calculate expected revenue
            const dailyBTC = this.calculateDailyRevenue(marketData);
            const dailyUSD = dailyBTC * marketData.price;
            
            // Calculate costs
            const dailyPower = (this.config.powerConsumption / 1000) * 24; // kWh
            const dailyCost = dailyPower * this.config.electricityCost;
            
            // Update profitability
            this.profitability = {
                current: dailyUSD - dailyCost,
                daily: dailyUSD,
                electricityCost: dailyCost,
                netProfit: dailyUSD - dailyCost,
                breakEven: dailyUSD >= dailyCost
            };
            
            return this.profitability.netProfit >= this.config.minProfitability;
            
        } catch (error) {
            console.error('Failed to check profitability:', error);
            return true; // Continue mining if can't check
        }
    }
    
    /**
     * Display mining dashboard
     */
    displayDashboard() {
        console.clear();
        console.log('╔══════════════════════════════════════════════════════════════╗');
        console.log('║                    OTEDAMA MINER CLIENT                      ║');
        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log(`║ Status: ${this.mining ? '🟢 Mining' : '🔴 Stopped'}                                             ║`);
        console.log(`║ Pool: ${this.connected ? '🟢 Connected' : '🔴 Disconnected'}                                          ║`);
        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log('║ PERFORMANCE                                                  ║');
        console.log(`║ Hashrate: ${this.formatHashrate(this.stats.hashrate)}                                    ║`);
        console.log(`║ Shares: ${this.stats.shares.accepted}/${this.stats.shares.accepted + this.stats.shares.rejected} (${this.getAcceptRate()}% accepted)                     ║`);
        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log('║ EARNINGS                                                     ║');
        console.log(`║ Unpaid Balance: ${this.stats.earnings.unpaid.toFixed(8)} BTC                     ║`);
        console.log(`║ Total Paid: ${this.stats.earnings.paid.toFixed(8)} BTC                         ║`);
        console.log(`║ Min Payout: ${this.config.minPayout} BTC                                 ║`);
        console.log(`║ Next Payout: ${this.getNextPayoutTime()}                              ║`);
        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log('║ PROFITABILITY                                                ║');
        console.log(`║ Daily Revenue: $${this.profitability.daily.toFixed(2)}                                 ║`);
        console.log(`║ Daily Cost: $${this.profitability.electricityCost.toFixed(2)}                                    ║`);
        console.log(`║ Daily Profit: ${this.profitability.netProfit >= 0 ? '🟢' : '🔴'} $${this.profitability.netProfit.toFixed(2)}                              ║`);
        console.log('╠══════════════════════════════════════════════════════════════╣');
        console.log('║ Press Ctrl+C to stop mining                                  ║');
        console.log('╚══════════════════════════════════════════════════════════════╝');
        
        // Update dashboard every 5 seconds
        if (this.mining) {
            setTimeout(() => this.displayDashboard(), 5000);
        }
    }
    
    /**
     * Monitoring functions
     */
    startMonitoring() {
        // Update stats every minute
        setInterval(() => {
            this.updateStats();
        }, 60000);
        
        // Check profitability every 30 minutes
        setInterval(() => {
            this.checkProfitability();
            
            // Auto-switch if enabled
            if (this.config.autoSwitch) {
                this.checkForBetterPool();
            }
        }, 30 * 60000);
        
        // Save stats every hour
        setInterval(() => {
            this.saveStats();
        }, 3600000);
    }
    
    /**
     * Update earnings from pool
     */
    async updateStats() {
        try {
            // Query pool API for stats
            const response = await fetch(`https://api.otedama.io/miner/${this.config.payoutAddress}`);
            const data = await response.json();
            
            this.stats.earnings.unpaid = data.unpaid || 0;
            this.stats.earnings.paid = data.paid || 0;
            this.stats.earnings.daily = data.daily || 0;
            this.stats.earnings.monthly = data.monthly || 0;
            
            this.emit('stats-updated', this.stats);
            
        } catch (error) {
            console.error('Failed to update stats:', error);
        }
    }
    
    /**
     * Utility functions
     */
    sendToPool(message) {
        if (this.connected && this.connection) {
            this.connection.send(JSON.stringify(message));
        }
    }
    
    updateHashrate(hashes) {
        // Calculate hashrate (simplified)
        this.stats.hashrate = hashes * this.config.threads * 10; // Approximate
    }
    
    formatHashrate(hashrate) {
        if (hashrate > 1e15) return `${(hashrate / 1e15).toFixed(2)} PH/s`;
        if (hashrate > 1e12) return `${(hashrate / 1e12).toFixed(2)} TH/s`;
        if (hashrate > 1e9) return `${(hashrate / 1e9).toFixed(2)} GH/s`;
        if (hashrate > 1e6) return `${(hashrate / 1e6).toFixed(2)} MH/s`;
        if (hashrate > 1e3) return `${(hashrate / 1e3).toFixed(2)} KH/s`;
        return `${hashrate.toFixed(2)} H/s`;
    }
    
    getAcceptRate() {
        const total = this.stats.shares.accepted + this.stats.shares.rejected;
        return total > 0 ? ((this.stats.shares.accepted / total) * 100).toFixed(1) : '0.0';
    }
    
    getNextPayoutTime() {
        if (this.stats.earnings.unpaid < this.config.minPayout) {
            const remaining = this.config.minPayout - this.stats.earnings.unpaid;
            const daysToGo = remaining / (this.stats.earnings.daily || 0.0001);
            
            if (daysToGo < 1) return `${(daysToGo * 24).toFixed(1)} hours`;
            return `${daysToGo.toFixed(1)} days`;
        }
        return 'Next batch';
    }
    
    getSystemInfo() {
        return {
            platform: os.platform(),
            cpus: os.cpus().length,
            memory: os.totalmem(),
            hostname: os.hostname()
        };
    }
    
    async fetchMarketData() {
        // Simplified - fetch from API
        return {
            difficulty: 70e12,
            price: 65000,
            networkHashrate: 500e18
        };
    }
    
    calculateDailyRevenue(marketData) {
        // Simplified calculation
        const myHashrate = this.stats.hashrate || 100e12; // 100 TH/s
        const blocksPerDay = 144;
        const blockReward = 6.25;
        
        const myShare = myHashrate / marketData.networkHashrate;
        return myShare * blocksPerDay * blockReward;
    }
    
    saveStats() {
        // Save stats to file for persistence
        const fs = require('fs').promises;
        const statsFile = 'miner-stats.json';
        
        fs.writeFile(statsFile, JSON.stringify({
            stats: this.stats,
            profitability: this.profitability,
            timestamp: Date.now()
        }, null, 2));
    }
}

/**
 * Create miner client
 */
export function createMinerClient(config) {
    return new MinerClient(config);
}

export default {
    MinerClient,
    createMinerClient
};