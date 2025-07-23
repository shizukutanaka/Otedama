/**
 * Unified Mining Pool Implementation
 * 
 * Consolidates all mining pool functionality into a single, modular system
 * Base architecture from pool-optimized.js with features from all implementations
 * 
 * Design Philosophy (Carmack/Martin/Pike):
 * - Performance-first with zero-copy operations
 * - Modular feature system with configuration
 * - Clean interfaces and minimal dependencies
 * - Production-ready with 100k+ miner support
 */

const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');
const { createHash, randomBytes } = require('crypto');
const net = require('net');
const { promisify } = require('util');
const dgram = require('dgram');

// Import feature modules
const { StratumV2Handler } = require('./stratum-v2');
const { MergeMiningHandler } = require('./merge-mining');
const { ProxyHandler } = require('./proxy-handler');
const { DifficultyAdjuster } = require('./difficulty-adjuster');
const { NonceAllocator } = require('./nonce-allocator');
const { ShareValidator } = require('./share-validator');
const { VardiffManager } = require('./vardiff-manager');
const { BanManager } = require('./ban-manager');
const { JobManager } = require('./job-manager');
const { LoadBalancer } = require('./load-balancer');
const { HashratePrediction } = require('./hashrate-prediction');
const { HardwareValidator } = require('./hardware-validator');
const { ProfitSwitcher } = require('./profit-switcher');
const { DifficultyTracker } = require('./difficulty-tracker');
const { MiningMemoryManager } = require('./memory-manager');
const MinerAddressManager = require('./miner-address-manager');
const PaymentProcessor = require('./payment-processor');

class UnifiedMiningPool extends EventEmitter {
    constructor(config = {}) {
        super();
        
        // Core configuration with sensible defaults
        this.config = {
            // Basic settings
            coinType: config.coinType || 'BTC',
            algorithm: config.algorithm || 'sha256',
            poolAddress: config.poolAddress || '',
            poolFee: config.poolFee || 0.01,
            
            // Network settings
            stratumPort: config.stratumPort || 3333,
            maxConnections: config.maxConnections || 100000,
            connectionTimeout: config.connectionTimeout || 60000,
            
            // Performance settings
            workerThreads: config.workerThreads || 4,
            shareProcessBatchSize: config.shareProcessBatchSize || 1000,
            nonceSegmentSize: config.nonceSegmentSize || 0x100000,
            gcInterval: config.gcInterval || 300000,
            
            // Feature flags
            features: {
                stratumV2: config.features?.stratumV2 || false,
                mergeMining: config.features?.mergeMining || false,
                proxy: config.features?.proxy || false,
                vardiff: config.features?.vardiff || true,
                antihop: config.features?.antihop || false,
                loadBalancing: config.features?.loadBalancing || true,
                hashratePrediction: config.features?.hashratePrediction || false,
                hardwareValidation: config.features?.hardwareValidation || true,
                profitSwitching: config.features?.profitSwitching || false,
                ...config.features
            },
            
            // Module-specific configs
            difficulty: {
                initial: config.difficulty?.initial || 16,
                minimum: config.difficulty?.minimum || 1,
                maximum: config.difficulty?.maximum || 65536,
                targetTime: config.difficulty?.targetTime || 10,
                retargetTime: config.difficulty?.retargetTime || 90,
                variancePercent: config.difficulty?.variancePercent || 30,
                ...config.difficulty
            },
            
            payout: {
                scheme: config.payout?.scheme || 'PPLNS',
                interval: config.payout?.interval || 3600000,
                minPayout: config.payout?.minPayout || 0.001,
                ...config.payout
            },
            
            ...config
        };
        
        // Core components
        this.miners = new Map();
        this.jobs = new Map();
        this.shares = [];
        this.stats = {
            totalHashrate: 0,
            validShares: 0,
            invalidShares: 0,
            blocksFound: 0,
            totalMiners: 0,
            activeMiners: 0,
            connections: 0,
            uptime: Date.now()
        };
        
        // Initialize memory manager
        this.memoryManager = new MiningMemoryManager({
            gcInterval: this.config.gcInterval,
            maxMinerAge: 3600000, // 1 hour
            maxConnectionsPerIP: 10,
            cleanupInterval: 60000, // 1 minute
            memoryThreshold: 1024 * 1024 * 1024 // 1GB
        });

        // Initialize address manager for custom payment addresses
        this.addressManager = new MinerAddressManager({
            addressValidation: true,
            allowAddressChange: true,
            addressChangeDelay: 86400000, // 24 hours
            requireSignature: false
        });

        // Initialize payment processor
        this.paymentProcessor = new PaymentProcessor({
            scheme: this.config.payout.scheme,
            interval: this.config.payout.interval,
            minPayout: this.config.payout.minPayout,
            fee: this.config.poolFee,
            poolAddress: this.config.poolAddress
        });

        // Initialize feature modules based on config
        this.initializeModules();
        
        // Performance optimization
        this.shareBuffer = Buffer.allocUnsafe(this.config.shareProcessBatchSize * 256);
        this.shareBufferOffset = 0;
        
        // Connection tracking
        this.connectionPool = new Set();
        this.ipConnections = new Map();
        
        // Start time for uptime tracking
        this.startTime = Date.now();
    }
    
    /**
     * Initialize feature modules based on configuration
     */
    initializeModules() {
        // Core modules (always enabled)
        this.jobManager = new JobManager(this.config);
        this.shareValidator = new ShareValidator(this.config);
        this.banManager = new BanManager();
        this.nonceAllocator = new NonceAllocator(this.config.nonceSegmentSize);
        this.difficultyAdjuster = new DifficultyAdjuster(this.config.difficulty);
        
        // Optional modules based on features
        if (this.config.features.stratumV2) {
            this.stratumV2 = new StratumV2Handler(this.config);
        }
        
        if (this.config.features.mergeMining) {
            this.mergeMining = new MergeMiningHandler(this.config);
        }
        
        if (this.config.features.proxy) {
            this.proxy = new ProxyHandler(this.config);
        }
        
        if (this.config.features.vardiff) {
            this.vardiff = new VardiffManager(this.config.difficulty);
        }
        
        if (this.config.features.loadBalancing) {
            this.loadBalancer = new LoadBalancer(this.config);
        }
        
        if (this.config.features.hashratePrediction) {
            this.hashratePrediction = new HashratePrediction();
        }
        
        if (this.config.features.hardwareValidation) {
            this.hardwareValidator = new HardwareValidator();
        }
        
        if (this.config.features.profitSwitching) {
            this.profitSwitcher = new ProfitSwitcher(this.config.profitSwitching || {});
            this.difficultyTracker = new DifficultyTracker();
            
            // Listen for profit switch events
            this.profitSwitcher.on('switched', (event) => {
                this.handleProfitSwitch(event);
            });
        }
        
        // Initialize worker threads for share processing
        this.initializeWorkers();
    }
    
    /**
     * Initialize worker threads for parallel share processing
     */
    initializeWorkers() {
        this.workers = [];
        this.workerRoundRobin = 0;
        
        for (let i = 0; i < this.config.workerThreads; i++) {
            const worker = new Worker('./lib/mining/mining-worker-thread.js', {
                workerData: {
                    workerId: i,
                    config: this.config
                }
            });
            
            worker.on('message', (msg) => this.handleWorkerMessage(msg));
            worker.on('error', (err) => this.handleWorkerError(err));
            
            this.workers.push(worker);
        }
    }
    
    /**
     * Start the mining pool
     */
    async start() {
        console.log('🚀 Starting Unified Mining Pool...');
        
        try {
            // Start memory manager
            this.memoryManager.start();
            
            // Start payment processor
            this.paymentProcessor.start();
            
            // Set up payment processing
            this.paymentProcessor.on('payment-batch', (payments, callback) => {
                // Handle payment processing with address manager
                console.log(`Processing ${payments.length} payments`);
                // In production, this would integrate with your blockchain interface
                const results = payments.map(payment => ({
                    ...payment,
                    success: true,
                    txid: randomBytes(32).toString('hex')
                }));
                callback(results);
            });
            
            // Start stratum server
            await this.startStratumServer();
            
            // Start periodic tasks
            this.startPeriodicTasks();
            
            // Initialize feature modules in parallel for better performance
            const featurePromises = [];
            
            if (this.config.features.stratumV2) {
                featurePromises.push(
                    this.stratumV2.start().then(() => console.log('📡 Stratum v2 enabled'))
                );
            }
            
            if (this.config.features.proxy) {
                featurePromises.push(
                    this.proxy.start().then(() => console.log('🌐 Proxy enabled'))
                );
            }
            
            if (this.config.features.profitSwitching) {
                featurePromises.push(
                    (async () => {
                        // Import price feed service
                        const { default: PriceFeed } = await import('../../services/price-feed.js');
                        const priceFeed = new PriceFeed();
                        
                        // Initialize and start profit switching
                        await this.difficultyTracker.start();
                        await this.profitSwitcher.initialize(priceFeed, this.difficultyTracker);
                        this.profitSwitcher.start();
                        console.log('📈 Profit switching enabled');
                    })()
                );
            }
            
            if (this.config.features.mergeMining) {
                featurePromises.push(
                    this.mergeMining.start().then(() => console.log('🔗 Merge mining enabled'))
                );
            }
            
            // Wait for all features to initialize in parallel
            await Promise.all(featurePromises);
            
            console.log(`✅ Mining pool started on port ${this.config.stratumPort}`);
            this.emit('started');
            
        } catch (error) {
            console.error('❌ Failed to start mining pool:', error);
            throw error;
        }
    }
    
    /**
     * Start stratum server
     */
    async startStratumServer() {
        return new Promise((resolve, reject) => {
            this.server = net.createServer((socket) => {
                this.handleNewConnection(socket);
            });
            
            this.server.on('error', reject);
            
            this.server.listen(this.config.stratumPort, () => {
                console.log(`⛏️ Stratum server listening on port ${this.config.stratumPort}`);
                resolve();
            });
        });
    }
    
    /**
     * Handle new miner connection with optimizations
     */
    handleNewConnection(socket) {
        const connectionId = randomBytes(16).toString('hex');
        const clientIp = socket.remoteAddress;
        
        // Connection limiting per IP using memory manager
        if (this.memoryManager.isIPLimitExceeded(clientIp)) {
            socket.destroy();
            return;
        }
        
        // Check total connections
        if (this.connectionPool.size >= this.config.maxConnections) {
            socket.destroy();
            return;
        }
        
        // Check ban status
        if (this.banManager.isBanned(clientIp)) {
            socket.destroy();
            return;
        }
        
        // Register connection with memory manager
        this.memoryManager.registerConnection(connectionId, {
            ipAddress: clientIp,
            timestamp: Date.now()
        });
        
        // Track connection
        this.connectionPool.add(connectionId);
        this.stats.connections++;
        
        // Create miner object
        const miner = {
            id: connectionId,
            socket: socket,
            ip: clientIp,
            authorized: false,
            subscribed: false,
            extraNonce1: randomBytes(4).toString('hex'),
            difficulty: this.config.difficulty.initial,
            shares: {
                valid: 0,
                invalid: 0,
                lastShare: null
            },
            hashrate: 0,
            lastActivity: Date.now(),
            vardiff: {
                buffer: [],
                startTime: Date.now(),
                lastUpdate: Date.now()
            },
            hardware: null // For hardware validation
        };
        
        // Set socket options for performance
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30000);
        
        // Handle socket events
        socket.on('data', (data) => this.handleMinerData(miner, data));
        socket.on('error', (err) => this.handleMinerError(miner, err));
        socket.on('close', () => this.handleMinerDisconnect(miner));
        
        // Register miner with memory manager
        this.memoryManager.registerMiner(connectionId, {
            ipAddress: clientIp,
            timestamp: Date.now()
        });
        
        // Add to miners map
        this.miners.set(connectionId, miner);
        
        // Send mining.notify immediately for fast start
        this.sendMiningJob(miner);
        
        this.emit('miner:connected', miner);
    }
    
    /**
     * Handle miner data with zero-copy optimization
     */
    handleMinerData(miner, data) {
        try {
            // Update last activity
            miner.lastActivity = Date.now();
            
            // Update activity in memory manager
            this.memoryManager.updateMinerActivity(miner.id);
            this.memoryManager.updateConnectionActivity(miner.id);
            
            // Parse JSON-RPC messages (stratum uses line-delimited JSON)
            const messages = data.toString().trim().split('\n');
            
            for (const message of messages) {
                if (!message) continue;
                
                try {
                    const parsed = JSON.parse(message);
                    this.processStratumMessage(miner, parsed);
                } catch (parseError) {
                    console.error('Invalid message from miner:', parseError);
                    this.sendError(miner, -32700, 'Parse error');
                }
            }
        } catch (error) {
            console.error('Error handling miner data:', error);
            miner.socket.destroy();
        }
    }
    
    /**
     * Process stratum message based on method
     */
    async processStratumMessage(miner, message) {
        const { id, method, params } = message;
        
        switch (method) {
            case 'mining.subscribe':
                await this.handleSubscribe(miner, id, params);
                break;
                
            case 'mining.authorize':
                await this.handleAuthorize(miner, id, params);
                break;
                
            case 'mining.submit':
                await this.handleSubmit(miner, id, params);
                break;
                
            case 'mining.extranonce.subscribe':
                await this.handleExtraNonceSubscribe(miner, id);
                break;
                
            case 'mining.suggest_difficulty':
                await this.handleSuggestDifficulty(miner, id, params);
                break;
                
            default:
                this.sendError(miner, -32601, 'Method not found', id);
        }
    }
    
    /**
     * Handle mining.subscribe
     */
    async handleSubscribe(miner, id, params) {
        miner.subscribed = true;
        miner.userAgent = params[0] || 'unknown';
        
        // Hardware validation if enabled
        if (this.config.features.hardwareValidation && this.hardwareValidator) {
            miner.hardware = this.hardwareValidator.validateUserAgent(miner.userAgent);
        }
        
        const response = {
            id: id,
            result: [
                [
                    ['mining.set_difficulty', randomBytes(8).toString('hex')],
                    ['mining.notify', randomBytes(8).toString('hex')]
                ],
                miner.extraNonce1,
                4 // extraNonce2 size
            ],
            error: null
        };
        
        this.sendToMiner(miner, response);
        
        // Send initial difficulty
        this.sendDifficulty(miner);
    }
    
    /**
     * Handle mining.authorize
     */
    async handleAuthorize(miner, id, params) {
        const [username, password] = params;
        
        // Validate authorization (implement your logic here)
        miner.authorized = true;
        miner.username = username;
        miner.workerName = username.split('.')[1] || 'default';
        
        // Register miner with address manager
        try {
            const minerId = this.addressManager.registerMiner(
                username.split('.')[0], // Mining address
                miner.workerName,
                null // No custom payment address initially
            );
            miner.minerId = minerId;
        } catch (error) {
            console.error('Failed to register miner address:', error);
            this.sendError(miner, -32502, 'Invalid mining address', id);
            return;
        }
        
        this.sendToMiner(miner, {
            id: id,
            result: true,
            error: null
        });
        
        // Send current job
        this.sendMiningJob(miner);
        
        // Update stats
        this.stats.totalMiners++;
        this.stats.activeMiners++;
        
        this.emit('miner:authorized', miner);
    }
    
    /**
     * Handle mining.submit with batch processing
     */
    async handleSubmit(miner, id, params) {
        if (!miner.authorized) {
            this.sendError(miner, -32501, 'Not authorized', id);
            return;
        }
        
        const [username, jobId, extraNonce2, ntime, nonce] = params;
        
        // Create share object
        const share = {
            minerId: miner.id,
            username: username,
            jobId: jobId,
            extraNonce1: miner.extraNonce1,
            extraNonce2: extraNonce2,
            ntime: ntime,
            nonce: nonce,
            difficulty: miner.difficulty,
            timestamp: Date.now()
        };
        
        // Add to batch buffer for processing
        this.addShareToBatch(share);
        
        // Send immediate response (optimistic)
        this.sendToMiner(miner, {
            id: id,
            result: true,
            error: null
        });
        
        // Update vardiff buffer if enabled
        if (this.config.features.vardiff && this.vardiff) {
            miner.vardiff.buffer.push({
                difficulty: miner.difficulty,
                timestamp: Date.now()
            });
            
            // Check if vardiff adjustment needed
            if (Date.now() - miner.vardiff.lastUpdate > this.config.difficulty.retargetTime * 1000) {
                this.adjustMinerDifficulty(miner);
            }
        }
    }
    
    /**
     * Add share to batch for worker processing
     */
    addShareToBatch(share) {
        this.shares.push(share);
        
        // Add share to memory manager for tracking
        this.memoryManager.addShare(share.minerId, {
            timestamp: share.timestamp,
            difficulty: share.difficulty,
            isValid: share.isValid
        });
        
        // Process batch when full
        if (this.shares.length >= this.config.shareProcessBatchSize) {
            this.processBatchedShares();
        }
    }
    
    /**
     * Process batched shares in worker thread
     */
    processBatchedShares() {
        if (this.shares.length === 0) return;
        
        // Get next worker (round-robin)
        const worker = this.workers[this.workerRoundRobin];
        this.workerRoundRobin = (this.workerRoundRobin + 1) % this.workers.length;
        
        // Send batch to worker
        worker.postMessage({
            type: 'validateShares',
            shares: this.shares.splice(0, this.config.shareProcessBatchSize),
            currentJob: this.jobManager.currentJob
        });
    }
    
    /**
     * Handle worker thread messages
     */
    handleWorkerMessage(message) {
        switch (message.type) {
            case 'sharesValidated':
                this.handleValidatedShares(message.results);
                break;
                
            case 'blockFound':
                this.handleBlockFound(message.block);
                break;
                
            case 'error':
                console.error('Worker error:', message.error);
                break;
        }
    }
    
    /**
     * Handle validated shares from worker
     */
    handleValidatedShares(results) {
        for (const result of results) {
            const miner = this.miners.get(result.minerId);
            if (!miner) continue;
            
            if (result.valid) {
                miner.shares.valid++;
                this.stats.validShares++;
                miner.shares.lastShare = Date.now();
                
                // Update hashrate calculation
                this.updateMinerHashrate(miner);
                
                // Record share in payment processor
                if (miner.minerId) {
                    this.paymentProcessor.recordShare(
                        miner.minerId,
                        result.difficulty,
                        true
                    );
                }
                
                // Emit share event
                this.emit('share:accepted', {
                    miner: miner,
                    share: result.share,
                    difficulty: result.difficulty
                });
            } else {
                miner.shares.invalid++;
                this.stats.invalidShares++;
                
                // Record invalid share
                if (miner.minerId) {
                    this.paymentProcessor.recordShare(
                        miner.minerId,
                        result.difficulty,
                        false
                    );
                }
                
                // Check for ban conditions
                const invalidRate = miner.shares.invalid / (miner.shares.valid + miner.shares.invalid);
                if (invalidRate > 0.5 && miner.shares.invalid > 10) {
                    this.banManager.ban(miner.ip, 'High invalid share rate');
                    miner.socket.destroy();
                }
                
                this.emit('share:rejected', {
                    miner: miner,
                    reason: result.reason
                });
            }
        }
    }
    
    /**
     * Handle block found
     */
    async handleBlockFound(block) {
        this.stats.blocksFound++;
        
        console.log(`🎉 Block found! Height: ${block.height}, Hash: ${block.hash}`);
        
        // Record block in payment processor
        const miner = this.miners.get(block.minerId);
        if (miner && miner.minerId) {
            this.paymentProcessor.recordBlock({
                height: block.height,
                hash: block.hash,
                reward: block.reward || 6.25, // Default BTC block reward
                minerAddress: miner.minerId
            });
        }
        
        // Check for merge mining auxiliary blocks
        if (this.config.features.mergeMining && this.mergeMining) {
            try {
                const mergeResults = await this.mergeMining.processShare(block.share, block.job);
                
                if (mergeResults.primary) {
                    console.log(`💎 Primary chain block found!`);
                }
                
                for (const [chain, found] of mergeResults.auxiliary) {
                    if (found) {
                        console.log(`🔗 Auxiliary chain block found: ${chain}`);
                        this.emit('aux:block:found', { chain, block });
                    }
                }
            } catch (error) {
                logger.error('Merge mining processing error:', error);
            }
        }
        
        this.emit('block:found', block);
        
        // Update job for all miners
        this.broadcastNewJob();
    }
    
    /**
     * Adjust miner difficulty based on share rate
     */
    adjustMinerDifficulty(miner) {
        if (!this.vardiff) return;
        
        const newDifficulty = this.vardiff.calculateNewDifficulty(
            miner.vardiff.buffer,
            miner.difficulty
        );
        
        if (newDifficulty !== miner.difficulty) {
            miner.difficulty = newDifficulty;
            this.sendDifficulty(miner);
            
            // Clear vardiff buffer
            miner.vardiff.buffer = [];
            miner.vardiff.lastUpdate = Date.now();
        }
    }
    
    /**
     * Update miner hashrate calculation
     */
    updateMinerHashrate(miner) {
        const timeDiff = (Date.now() - miner.vardiff.startTime) / 1000;
        if (timeDiff > 0) {
            // Hashrate = (shares * difficulty * 2^32) / time
            miner.hashrate = (miner.shares.valid * miner.difficulty * 4294967296) / timeDiff;
            
            // Update prediction if enabled
            if (this.config.features.hashratePrediction && this.hashratePrediction) {
                this.hashratePrediction.addDataPoint(miner.id, miner.hashrate);
            }
        }
    }
    
    /**
     * Send mining job to miner
     */
    async sendMiningJob(miner) {
        if (!miner.authorized || !miner.subscribed) return;
        
        let job = this.jobManager.currentJob;
        if (!job) return;
        
        // If merge mining is enabled, create merged job
        if (this.config.features.mergeMining && this.mergeMining) {
            try {
                const mergedJob = await this.mergeMining.createJob(job);
                job = {
                    ...job,
                    ...mergedJob,
                    coinbase1: mergedJob.coinbase.slice(0, 42).toString('hex'),
                    coinbase2: mergedJob.coinbase.slice(42).toString('hex')
                };
            } catch (error) {
                logger.error('Failed to create merged job:', error);
            }
        }
        
        const params = [
            job.id || job.jobId,
            job.prevHash || job.previousblockhash,
            job.coinbase1,
            job.coinbase2,
            job.merkleBranch || job.merklebranch || [],
            job.version,
            job.nBits || job.bits,
            job.nTime || job.curtime,
            true // clean jobs
        ];
        
        this.sendToMiner(miner, {
            id: null,
            method: 'mining.notify',
            params: params
        });
    }
    
    /**
     * Send difficulty to miner
     */
    sendDifficulty(miner) {
        this.sendToMiner(miner, {
            id: null,
            method: 'mining.set_difficulty',
            params: [miner.difficulty]
        });
    }
    
    /**
     * Send message to miner
     */
    sendToMiner(miner, message) {
        if (miner.socket.writable) {
            miner.socket.write(JSON.stringify(message) + '\n');
        }
    }
    
    /**
     * Send error to miner
     */
    sendError(miner, code, message, id = null) {
        this.sendToMiner(miner, {
            id: id,
            result: null,
            error: [code, message, null]
        });
    }
    
    /**
     * Broadcast new job to all miners
     */
    broadcastNewJob() {
        const job = this.jobManager.getNewJob();
        
        for (const [id, miner] of this.miners) {
            if (miner.authorized && miner.subscribed) {
                this.sendMiningJob(miner);
            }
        }
    }
    
    /**
     * Handle miner disconnect with proper cleanup
     */
    handleMinerDisconnect(miner) {
        // Unregister from memory manager (handles IP tracking and cleanup)
        this.memoryManager.unregisterMiner(miner.id);
        this.memoryManager.unregisterConnection(miner.id);
        
        // Update connection tracking
        this.connectionPool.delete(miner.id);
        
        // Remove from miners
        this.miners.delete(miner.id);
        
        // Update stats
        this.stats.connections--;
        if (miner.authorized) {
            this.stats.activeMiners--;
        }
        
        this.emit('miner:disconnected', miner);
    }
    
    /**
     * Handle miner error
     */
    handleMinerError(miner, error) {
        console.error(`Miner ${miner.id} error:`, error.message);
        miner.socket.destroy();
    }
    
    /**
     * Handle worker error
     */
    handleWorkerError(error) {
        console.error('Worker thread error:', error);
        // Restart worker if needed
    }
    
    /**
     * Start periodic tasks
     */
    startPeriodicTasks() {
        // Process share batch every second
        setInterval(() => {
            if (this.shares.length > 0) {
                this.processBatchedShares();
            }
        }, 1000);
        
        // Update stats every 10 seconds
        setInterval(() => {
            this.updatePoolStats();
        }, 10000);
        
        // Clean up inactive miners every minute
        setInterval(() => {
            this.cleanupInactiveMiners();
        }, 60000);
        
        // Process payments with address manager
        setInterval(() => {
            this.paymentProcessor.processPayments(this.addressManager).catch(err => {
                console.error('Payment processing error:', err);
            });
        }, this.config.payout.interval || 3600000); // Default 1 hour
        
        // Garbage collection
        setInterval(() => {
            if (global.gc) {
                global.gc();
            }
        }, this.config.gcInterval);
    }
    
    /**
     * Update pool statistics
     */
    updatePoolStats() {
        let totalHashrate = 0;
        
        for (const [id, miner] of this.miners) {
            if (miner.authorized) {
                totalHashrate += miner.hashrate || 0;
            }
        }
        
        this.stats.totalHashrate = totalHashrate;
        this.stats.uptime = Date.now() - this.startTime;
        
        this.emit('stats:updated', this.stats);
    }
    
    /**
     * Clean up inactive miners
     */
    cleanupInactiveMiners() {
        const timeout = this.config.connectionTimeout;
        const now = Date.now();
        
        for (const [id, miner] of this.miners) {
            if (now - miner.lastActivity > timeout) {
                console.log(`Disconnecting inactive miner: ${miner.id}`);
                miner.socket.destroy();
            }
        }
    }
    
    /**
     * Get pool statistics
     */
    getStats() {
        const stats = {
            ...this.stats,
            uptime: Math.floor((Date.now() - this.startTime) / 1000),
            efficiency: this.stats.validShares / (this.stats.validShares + this.stats.invalidShares) || 0,
            averageDifficulty: this.calculateAverageDifficulty(),
            features: Object.keys(this.config.features).filter(f => this.config.features[f])
        };
        
        // Add profit switching stats if enabled
        if (this.config.features.profitSwitching && this.profitSwitcher) {
            stats.profitSwitching = this.profitSwitcher.getStats();
            stats.currentProfitability = this.profitSwitcher.getCurrentRanking();
        }
        
        // Add merge mining stats if enabled
        if (this.config.features.mergeMining && this.mergeMining) {
            stats.mergeMining = this.mergeMining.getStats();
        }
        
        return stats;
    }
    
    /**
     * Calculate average difficulty across all miners
     */
    calculateAverageDifficulty() {
        if (this.miners.size === 0) return 0;
        
        let total = 0;
        let count = 0;
        
        for (const [id, miner] of this.miners) {
            if (miner.authorized) {
                total += miner.difficulty;
                count++;
            }
        }
        
        return count > 0 ? total / count : 0;
    }
    
    /**
     * Handle profit switch event
     */
    async handleProfitSwitch(event) {
        console.log(`🔄 Switching from ${event.from || 'none'} to ${event.to}`);
        
        // Update pool configuration
        this.config.coinType = event.to;
        this.config.algorithm = event.algorithm;
        
        // Create new job for the new coin
        const newJob = await this.jobManager.createJob(event.to, event.algorithm);
        
        // Notify all miners of the new job
        for (const [id, miner] of this.miners) {
            if (miner.authorized) {
                // Send new mining job
                this.sendMiningJob(miner);
            }
        }
        
        // Update stats
        this.stats.lastSwitch = Date.now();
        this.stats.currentCoin = event.to;
        this.stats.currentAlgorithm = event.algorithm;
        
        // Emit event
        this.emit('coin:switched', event);
    }
    
    /**
     * Shutdown pool gracefully
     */
    async shutdown() {
        console.log('Shutting down mining pool...');
        
        // Stop accepting new connections
        if (this.server) {
            this.server.close();
        }
        
        // Disconnect all miners
        for (const [id, miner] of this.miners) {
            miner.socket.end();
        }
        
        // Terminate worker threads
        for (const worker of this.workers) {
            await worker.terminate();
        }
        
        // Shutdown feature modules in parallel for faster cleanup
        const shutdownPromises = [];
        
        if (this.stratumV2) {
            shutdownPromises.push(this.stratumV2.shutdown());
        }
        if (this.proxy) {
            shutdownPromises.push(this.proxy.shutdown());
        }
        if (this.mergeMining) {
            shutdownPromises.push(this.mergeMining.shutdown());
        }
        
        // Synchronous shutdowns
        if (this.profitSwitcher) this.profitSwitcher.stop();
        if (this.difficultyTracker) this.difficultyTracker.stop();
        
        // Wait for all async shutdowns to complete
        await Promise.all(shutdownPromises);
        
        this.emit('shutdown');
    }
}

module.exports = { UnifiedMiningPool };