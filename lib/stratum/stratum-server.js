const net = require('net');
const EventEmitter = require('events');
const crypto = require('crypto');

class StratumServer extends EventEmitter {
    constructor(config) {
        super();
        this.config = {
            port: config.port || 3333,
            host: config.host || '0.0.0.0',
            coin: config.coin || 'bitcoin',
            difficulty: config.difficulty || 16,
            vardiff: {
                enabled: config.vardiff !== false,
                minDiff: config.minDiff || 8,
                maxDiff: config.maxDiff || 65536,
                targetTime: config.targetTime || 10,
                retargetTime: config.retargetTime || 90,
                variancePercent: config.variancePercent || 30
            },
            banning: {
                enabled: config.banning !== false,
                checkThreshold: config.checkThreshold || 100,
                invalidPercent: config.invalidPercent || 50,
                banTime: config.banTime || 600000 // 10 minutes
            },
            ...config
        };
        
        this.server = null;
        this.clients = new Map();
        this.jobs = new Map();
        this.shares = new Map();
        this.bannedIPs = new Map();
        
        this.currentJob = null;
        this.extraNonce1Counter = 0;
        this.submittedShares = new Set();
    }
    
    async start() {
        return new Promise((resolve, reject) => {
            this.server = net.createServer(socket => {
                this.handleConnection(socket);
            });
            
            this.server.on('error', err => {
                this.emit('error', err);
                reject(err);
            });
            
            this.server.listen(this.config.port, this.config.host, () => {
                this.emit('started', {
                    host: this.config.host,
                    port: this.config.port
                });
                resolve();
            });
        });
    }
    
    handleConnection(socket) {
        const clientId = crypto.randomBytes(16).toString('hex');
        const remoteAddress = socket.remoteAddress;
        
        // Check if banned
        if (this.isBanned(remoteAddress)) {
            socket.end();
            return;
        }
        
        const client = {
            id: clientId,
            socket: socket,
            address: remoteAddress,
            extraNonce1: this.generateExtraNonce1(),
            difficulty: this.config.difficulty,
            authorized: false,
            worker: null,
            shares: {
                valid: 0,
                invalid: 0,
                lastShare: Date.now()
            },
            vardiff: {
                buffer: [],
                startTime: Date.now(),
                lastRetarget: Date.now()
            }
        };
        
        this.clients.set(clientId, client);
        
        socket.setKeepAlive(true, 60000);
        socket.setNoDelay(true);
        
        let dataBuffer = '';
        
        socket.on('data', data => {
            dataBuffer += data.toString();
            
            let messages = dataBuffer.split('\n');
            dataBuffer = messages.pop();
            
            for (const message of messages) {
                if (message.trim()) {
                    this.handleMessage(client, message);
                }
            }
        });
        
        socket.on('error', err => {
            this.emit('client-error', { client: clientId, error: err });
        });
        
        socket.on('close', () => {
            this.clients.delete(clientId);
            this.emit('client-disconnected', clientId);
        });
        
        this.emit('client-connected', clientId);
    }
    
    handleMessage(client, message) {
        try {
            const data = JSON.parse(message);
            
            if (!data.id || !data.method) {
                this.sendError(client, null, 'Invalid request');
                return;
            }
            
            switch (data.method) {
                case 'mining.subscribe':
                    this.handleSubscribe(client, data);
                    break;
                    
                case 'mining.authorize':
                    this.handleAuthorize(client, data);
                    break;
                    
                case 'mining.submit':
                    this.handleSubmit(client, data);
                    break;
                    
                case 'mining.get_transactions':
                    this.handleGetTransactions(client, data);
                    break;
                    
                case 'mining.extranonce.subscribe':
                    this.handleExtranonceSubscribe(client, data);
                    break;
                    
                default:
                    this.sendError(client, data.id, 'Unknown method');
            }
            
        } catch (err) {
            this.sendError(client, null, 'Parse error');
        }
    }
    
    // Stratum methods
    handleSubscribe(client, data) {
        const sessionId = crypto.randomBytes(4).toString('hex');
        
        const response = {
            id: data.id,
            result: [
                [
                    ['mining.set_difficulty', sessionId],
                    ['mining.notify', sessionId]
                ],
                client.extraNonce1,
                4 // extraNonce2 size
            ],
            error: null
        };
        
        this.sendJson(client, response);
        
        // Send initial difficulty
        this.sendDifficulty(client);
        
        // Send current job if available
        if (this.currentJob) {
            this.sendJob(client, this.currentJob);
        }
    }
    
    handleAuthorize(client, data) {
        const [worker, password] = data.params;
        
        // Validate worker
        if (!worker) {
            this.sendJson(client, {
                id: data.id,
                result: false,
                error: [20, 'Invalid worker', null]
            });
            return;
        }
        
        client.authorized = true;
        client.worker = worker;
        
        this.sendJson(client, {
            id: data.id,
            result: true,
            error: null
        });
        
        this.emit('client-authorized', {
            id: client.id,
            worker: worker
        });
    }
    
    handleSubmit(client, data) {
        if (!client.authorized) {
            this.sendError(client, data.id, 'Not authorized');
            return;
        }
        
        const [worker, jobId, extraNonce2, ntime, nonce] = data.params;
        
        // Validate submission
        const job = this.jobs.get(jobId);
        if (!job) {
            this.sendError(client, data.id, 'Job not found');
            client.shares.invalid++;
            this.checkBanning(client);
            return;
        }
        
        // Check for duplicate share
        const shareId = `${jobId}:${extraNonce2}:${ntime}:${nonce}`;
        if (this.submittedShares.has(shareId)) {
            this.sendError(client, data.id, 'Duplicate share');
            client.shares.invalid++;
            this.checkBanning(client);
            return;
        }
        
        this.submittedShares.add(shareId);
        
        // Validate share
        const isValid = this.validateShare(client, job, extraNonce2, ntime, nonce);
        
        if (isValid) {
            client.shares.valid++;
            client.shares.lastShare = Date.now();
            
            this.sendJson(client, {
                id: data.id,
                result: true,
                error: null
            });
            
            // Check if it's a block solution
            const isBlock = this.checkBlock(client, job, extraNonce2, ntime, nonce);
            
            this.emit('share', {
                client: client.id,
                worker: client.worker,
                job: jobId,
                difficulty: client.difficulty,
                isValid: true,
                isBlock: isBlock
            });
            
            // Update vardiff
            if (this.config.vardiff.enabled) {
                this.updateVardiff(client);
            }
            
        } else {
            client.shares.invalid++;
            
            this.sendError(client, data.id, 'Invalid share');
            
            this.emit('share', {
                client: client.id,
                worker: client.worker,
                job: jobId,
                difficulty: client.difficulty,
                isValid: false,
                isBlock: false
            });
            
            this.checkBanning(client);
        }
    }
    
    handleGetTransactions(client, data) {
        // Return transactions for current job
        const job = this.jobs.get(data.params[0]);
        if (!job) {
            this.sendError(client, data.id, 'Job not found');
            return;
        }
        
        this.sendJson(client, {
            id: data.id,
            result: job.transactions || [],
            error: null
        });
    }
    
    handleExtranonceSubscribe(client, data) {
        // Enable extranonce subscription
        this.sendJson(client, {
            id: data.id,
            result: true,
            error: null
        });
    }
    
    // Job management
    setJob(job) {
        const jobId = crypto.randomBytes(4).toString('hex');
        
        this.currentJob = {
            id: jobId,
            prevHash: job.prevHash,
            coinbase1: job.coinbase1,
            coinbase2: job.coinbase2,
            merkleBranch: job.merkleBranch,
            version: job.version,
            bits: job.bits,
            time: job.time,
            cleanJobs: job.cleanJobs || false,
            transactions: job.transactions
        };
        
        this.jobs.set(jobId, this.currentJob);
        
        // Clean old jobs
        if (this.jobs.size > 10) {
            const oldestKey = this.jobs.keys().next().value;
            this.jobs.delete(oldestKey);
        }
        
        // Notify all clients
        for (const client of this.clients.values()) {
            if (client.authorized) {
                this.sendJob(client, this.currentJob);
            }
        }
        
        return jobId;
    }
    
    // Sending methods
    sendJson(client, data) {
        if (client.socket.writable) {
            client.socket.write(JSON.stringify(data) + '\n');
        }
    }
    
    sendError(client, id, message) {
        this.sendJson(client, {
            id: id,
            result: null,
            error: [20, message, null]
        });
    }
    
    sendDifficulty(client) {
        this.sendJson(client, {
            id: null,
            method: 'mining.set_difficulty',
            params: [client.difficulty]
        });
    }
    
    sendJob(client, job) {
        this.sendJson(client, {
            id: null,
            method: 'mining.notify',
            params: [
                job.id,
                job.prevHash,
                job.coinbase1,
                job.coinbase2,
                job.merkleBranch,
                job.version,
                job.bits,
                job.time,
                job.cleanJobs
            ]
        });
    }
    
    // Utility methods
    generateExtraNonce1() {
        const extraNonce = Buffer.allocUnsafe(4);
        extraNonce.writeUInt32BE(this.extraNonce1Counter++, 0);
        return extraNonce.toString('hex');
    }
    
    validateShare(client, job, extraNonce2, ntime, nonce) {
        // Build block header
        const coinbase = Buffer.concat([
            Buffer.from(job.coinbase1, 'hex'),
            Buffer.from(client.extraNonce1, 'hex'),
            Buffer.from(extraNonce2, 'hex'),
            Buffer.from(job.coinbase2, 'hex')
        ]);
        
        // Calculate coinbase hash
        const coinbaseHash = crypto.createHash('sha256')
            .update(crypto.createHash('sha256').update(coinbase).digest())
            .digest();
        
        // Build merkle root
        let merkleRoot = coinbaseHash;
        for (const branch of job.merkleBranch) {
            merkleRoot = crypto.createHash('sha256')
                .update(crypto.createHash('sha256')
                    .update(Buffer.concat([merkleRoot, Buffer.from(branch, 'hex')]))
                    .digest())
                .digest();
        }
        
        // Build header
        const header = Buffer.concat([
            Buffer.from(job.version, 'hex'),
            Buffer.from(job.prevHash, 'hex'),
            merkleRoot,
            Buffer.from(ntime, 'hex'),
            Buffer.from(job.bits, 'hex'),
            Buffer.from(nonce, 'hex')
        ]);
        
        // Double SHA256
        const hash = crypto.createHash('sha256')
            .update(crypto.createHash('sha256').update(header).digest())
            .digest();
        
        // Check difficulty
        const hashValue = hash.readBigUInt64LE(0);
        const target = this.difficultyToTarget(client.difficulty);
        
        return hashValue <= target;
    }
    
    checkBlock(client, job, extraNonce2, ntime, nonce) {
        // Similar to validateShare but check against network difficulty
        // This is simplified - real implementation would check full target
        return Math.random() < 0.0001; // Simulate block finding
    }
    
    difficultyToTarget(difficulty) {
        // Convert pool difficulty to target
        // Simplified version
        return BigInt(0xffff0000) * BigInt(0x100000000) / BigInt(difficulty);
    }
    
    // Variable difficulty
    updateVardiff(client) {
        const now = Date.now();
        const timeDiff = (now - client.vardiff.lastRetarget) / 1000;
        
        if (timeDiff < this.config.vardiff.retargetTime) {
            return;
        }
        
        const sharesPerMin = client.shares.valid / (timeDiff / 60);
        const targetSharesPerMin = 60 / this.config.vardiff.targetTime;
        
        let newDiff = client.difficulty;
        
        if (sharesPerMin > targetSharesPerMin * (1 + this.config.vardiff.variancePercent / 100)) {
            newDiff = Math.min(client.difficulty * 2, this.config.vardiff.maxDiff);
        } else if (sharesPerMin < targetSharesPerMin * (1 - this.config.vardiff.variancePercent / 100)) {
            newDiff = Math.max(client.difficulty / 2, this.config.vardiff.minDiff);
        }
        
        if (newDiff !== client.difficulty) {
            client.difficulty = newDiff;
            this.sendDifficulty(client);
            client.vardiff.lastRetarget = now;
            
            this.emit('vardiff-update', {
                client: client.id,
                oldDiff: client.difficulty,
                newDiff: newDiff
            });
        }
    }
    
    // Banning
    checkBanning(client) {
        if (!this.config.banning.enabled) return;
        
        const totalShares = client.shares.valid + client.shares.invalid;
        if (totalShares < this.config.banning.checkThreshold) return;
        
        const invalidPercent = (client.shares.invalid / totalShares) * 100;
        
        if (invalidPercent > this.config.banning.invalidPercent) {
            this.banClient(client);
        }
    }
    
    banClient(client) {
        this.bannedIPs.set(client.address, Date.now() + this.config.banning.banTime);
        client.socket.end();
        
        this.emit('client-banned', {
            client: client.id,
            address: client.address,
            reason: 'Too many invalid shares'
        });
    }
    
    isBanned(address) {
        const banExpiry = this.bannedIPs.get(address);
        if (!banExpiry) return false;
        
        if (Date.now() > banExpiry) {
            this.bannedIPs.delete(address);
            return false;
        }
        
        return true;
    }
    
    // Stats
    getStats() {
        const stats = {
            clients: this.clients.size,
            totalHashrate: 0,
            shares: {
                valid: 0,
                invalid: 0
            },
            workers: new Map()
        };
        
        for (const client of this.clients.values()) {
            if (client.authorized) {
                stats.shares.valid += client.shares.valid;
                stats.shares.invalid += client.shares.invalid;
                
                // Estimate hashrate from shares
                const timeDiff = (Date.now() - client.vardiff.startTime) / 1000;
                const hashrate = (client.shares.valid * client.difficulty * Math.pow(2, 32)) / timeDiff;
                stats.totalHashrate += hashrate;
                
                if (!stats.workers.has(client.worker)) {
                    stats.workers.set(client.worker, {
                        hashrate: 0,
                        shares: { valid: 0, invalid: 0 }
                    });
                }
                
                const workerStats = stats.workers.get(client.worker);
                workerStats.hashrate += hashrate;
                workerStats.shares.valid += client.shares.valid;
                workerStats.shares.invalid += client.shares.invalid;
            }
        }
        
        return stats;
    }
    
    // Cleanup
    async stop() {
        return new Promise((resolve) => {
            // Close all client connections
            for (const client of this.clients.values()) {
                client.socket.end();
            }
            
            this.clients.clear();
            
            if (this.server) {
                this.server.close(() => {
                    this.emit('stopped');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }
}

module.exports = StratumServer;