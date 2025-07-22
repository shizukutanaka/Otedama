/**
 * Standalone Mining Pool
 * Can operate with just one node and automatically scale to P2P network
 * 
 * Design: KISS principle with auto-scaling capabilities
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const net = require('net');
const dgram = require('dgram');
const { SimpleMiningPool } = require('../core/simple-mining-pool');
const BlockchainConnector = require('./blockchain-connector');
const LocalShareChain = require('./local-share-chain');
const AutoDiscovery = require('./auto-discovery');
const RewardDistributor = require('./reward-distributor');

class StandalonePool extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Pool identity
            poolId: config.poolId || crypto.randomBytes(32).toString('hex'),
            poolName: config.poolName || 'Otedama Standalone Pool',
            
            // Network settings
            stratumPort: config.stratumPort || 3333,
            p2pPort: config.p2pPort || 6633,
            discoveryPort: config.discoveryPort || 6634,
            
            // Blockchain settings
            blockchainUrl: config.blockchainUrl || 'http://localhost:8332',
            blockchainUser: config.blockchainUser || 'user',
            blockchainPass: config.blockchainPass || 'pass',
            coinbaseAddress: config.coinbaseAddress || null,
            
            // Pool settings
            minPeers: config.minPeers || 0, // 0 means solo mode is OK
            targetPeers: config.targetPeers || 10,
            maxPeers: config.maxPeers || 50,
            
            // Mining settings
            initialDifficulty: config.initialDifficulty || 16,
            vardiffRetargetTime: config.vardiffRetargetTime || 30000, // 30 seconds
            shareTargetTime: config.shareTargetTime || 10000, // 10 seconds
            
            // Reward settings
            poolFee: config.poolFee || 0.01, // 1%
            payoutThreshold: config.payoutThreshold || 0.001,
            payoutInterval: config.payoutInterval || 3600000, // 1 hour
            
            // Solo mining settings
            soloMiningEnabled: config.soloMiningEnabled !== false,
            autoSwitchThreshold: config.autoSwitchThreshold || 3, // Switch to pool mode with 3+ miners
            
            ...config
        };
        
        // Core components
        this.miningPool = null;
        this.blockchain = null;
        this.shareChain = null;
        this.discovery = null;
        this.rewardDistributor = null;
        
        // State
        this.mode = 'solo'; // 'solo' or 'pool'
        this.peers = new Map();
        this.miners = new Map();
        this.currentWork = null;
        this.stats = {
            blocksFound: 0,
            sharesAccepted: 0,
            sharesRejected: 0,
            totalHashrate: 0,
            networkHashrate: 0,
            currentDifficulty: this.config.initialDifficulty
        };
        
        // Initialize
        this.initialize();
    }
    
    async initialize() {
        try {
            // 1. Setup blockchain connection
            this.blockchain = new BlockchainConnector({
                url: this.config.blockchainUrl,
                user: this.config.blockchainUser,
                pass: this.config.blockchainPass
            });
            
            await this.blockchain.connect();
            this.emit('blockchain:connected');
            
            // 2. Setup local share chain
            this.shareChain = new LocalShareChain({
                poolId: this.config.poolId,
                dataDir: './data/shares'
            });
            
            await this.shareChain.initialize();
            this.emit('sharechain:initialized');
            
            // 3. Setup mining pool
            this.miningPool = new SimpleMiningPool({
                port: this.config.stratumPort,
                difficulty: this.config.initialDifficulty,
                coinbaseAddress: this.config.coinbaseAddress
            });
            
            this.setupPoolHandlers();
            await this.miningPool.start();
            this.emit('pool:started');
            
            // 4. Setup P2P discovery (optional)
            if (this.config.minPeers > 0 || this.config.targetPeers > 0) {
                this.discovery = new AutoDiscovery({
                    port: this.config.discoveryPort,
                    poolId: this.config.poolId,
                    poolInfo: {
                        name: this.config.poolName,
                        stratumPort: this.config.stratumPort,
                        p2pPort: this.config.p2pPort
                    }
                });
                
                this.setupDiscoveryHandlers();
                await this.discovery.start();
                this.emit('discovery:started');
            }
            
            // 5. Setup reward distributor
            this.rewardDistributor = new RewardDistributor({
                blockchain: this.blockchain,
                shareChain: this.shareChain,
                poolFee: this.config.poolFee,
                payoutThreshold: this.config.payoutThreshold
            });
            
            // 6. Start main loops
            this.startWorkGeneration();
            this.startDifficultyAdjustment();
            this.startPayouts();
            
            this.emit('initialized', {
                mode: this.mode,
                poolId: this.config.poolId
            });
            
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }
    
    setupPoolHandlers() {
        // Handle new miner connections
        this.miningPool.on('miner:connected', (miner) => {
            this.miners.set(miner.id, {
                ...miner,
                shares: 0,
                hashrate: 0,
                difficulty: this.config.initialDifficulty,
                lastShareTime: Date.now()
            });
            
            this.checkModeSwitch();
            this.emit('miner:connected', miner);
        });
        
        // Handle miner disconnections
        this.miningPool.on('miner:disconnected', (minerId) => {
            this.miners.delete(minerId);
            this.checkModeSwitch();
            this.emit('miner:disconnected', minerId);
        });
        
        // Handle share submissions
        this.miningPool.on('share:submitted', async (share) => {
            const isValid = await this.validateShare(share);
            
            if (isValid) {
                this.stats.sharesAccepted++;
                
                // Record in local share chain
                await this.shareChain.addShare({
                    ...share,
                    poolId: this.config.poolId,
                    timestamp: Date.now()
                });
                
                // Check if it's a block
                if (this.isBlockSolution(share)) {
                    await this.handleBlockFound(share);
                }
                
                // Broadcast to peers if in pool mode
                if (this.mode === 'pool' && this.peers.size > 0) {
                    this.broadcastShare(share);
                }
                
                this.emit('share:accepted', share);
            } else {
                this.stats.sharesRejected++;
                this.emit('share:rejected', share);
            }
        });
    }
    
    setupDiscoveryHandlers() {
        // Handle peer discovery
        this.discovery.on('peer:discovered', async (peerInfo) => {
            if (this.peers.size < this.config.maxPeers) {
                await this.connectToPeer(peerInfo);
            }
        });
        
        // Handle peer connections
        this.discovery.on('peer:connected', (peer) => {
            this.peers.set(peer.id, peer);
            this.checkModeSwitch();
            this.emit('peer:connected', peer);
        });
        
        // Handle peer disconnections
        this.discovery.on('peer:disconnected', (peerId) => {
            this.peers.delete(peerId);
            this.checkModeSwitch();
            this.emit('peer:disconnected', peerId);
        });
        
        // Handle share broadcasts from peers
        this.discovery.on('share:received', async (share) => {
            // Validate and add to local share chain
            if (await this.validatePeerShare(share)) {
                await this.shareChain.addShare(share);
                this.emit('peer:share', share);
            }
        });
    }
    
    // Work generation loop
    async startWorkGeneration() {
        const generateWork = async () => {
            try {
                // Get block template from blockchain
                const template = await this.blockchain.getBlockTemplate();
                
                // Create coinbase transaction
                const coinbase = this.createCoinbaseTransaction(template);
                
                // Generate work
                this.currentWork = {
                    jobId: crypto.randomBytes(8).toString('hex'),
                    prevHash: template.previousblockhash,
                    coinbase1: coinbase.part1,
                    coinbase2: coinbase.part2,
                    merkleBranch: template.merklebranch || [],
                    version: template.version,
                    nbits: template.bits,
                    ntime: Math.floor(Date.now() / 1000),
                    cleanJobs: true
                };
                
                // Distribute to local miners
                this.miningPool.setWork(this.currentWork);
                
                // Distribute to peer pools if in pool mode
                if (this.mode === 'pool' && this.peers.size > 0) {
                    this.broadcastWork(this.currentWork);
                }
                
                this.emit('work:new', this.currentWork);
                
            } catch (error) {
                this.emit('error', { type: 'work_generation', error });
            }
        };
        
        // Generate work immediately and then periodically
        generateWork();
        setInterval(generateWork, 30000); // Every 30 seconds
    }
    
    // Difficulty adjustment
    startDifficultyAdjustment() {
        setInterval(() => {
            for (const [minerId, miner] of this.miners) {
                const timeSinceLastShare = Date.now() - miner.lastShareTime;
                const targetTime = this.config.shareTargetTime;
                
                // Adjust difficulty based on share submission rate
                if (timeSinceLastShare < targetTime * 0.5) {
                    // Too fast, increase difficulty
                    miner.difficulty = Math.min(miner.difficulty * 1.5, 65536);
                } else if (timeSinceLastShare > targetTime * 2) {
                    // Too slow, decrease difficulty
                    miner.difficulty = Math.max(miner.difficulty * 0.7, 1);
                }
                
                // Update miner difficulty
                this.miningPool.setMinerDifficulty(minerId, miner.difficulty);
            }
            
            this.emit('difficulty:adjusted');
        }, this.config.vardiffRetargetTime);
    }
    
    // Payout loop
    startPayouts() {
        setInterval(async () => {
            try {
                // Calculate rewards based on shares
                const rewards = await this.rewardDistributor.calculateRewards();
                
                // Process payouts
                const payouts = await this.rewardDistributor.processPayout(rewards);
                
                this.emit('payouts:processed', payouts);
                
            } catch (error) {
                this.emit('error', { type: 'payout', error });
            }
        }, this.config.payoutInterval);
    }
    
    // Validate share
    async validateShare(share) {
        // Basic validation
        if (!share.nonce || !share.ntime || !share.jobId) {
            return false;
        }
        
        // Check if job is current
        if (share.jobId !== this.currentWork.jobId) {
            return false;
        }
        
        // Verify hash meets difficulty
        const hash = this.calculateShareHash(share);
        const hashNum = parseInt(hash, 16);
        const target = this.difficultyToTarget(share.difficulty || this.config.initialDifficulty);
        
        return hashNum <= target;
    }
    
    // Check if share is a valid block
    isBlockSolution(share) {
        const hash = this.calculateShareHash(share);
        const hashNum = parseInt(hash, 16);
        const blockTarget = this.difficultyToTarget(this.currentWork.difficulty);
        
        return hashNum <= blockTarget;
    }
    
    // Handle found block
    async handleBlockFound(share) {
        try {
            // Submit to blockchain
            const blockHex = this.constructBlock(share);
            const result = await this.blockchain.submitBlock(blockHex);
            
            if (result.accepted) {
                this.stats.blocksFound++;
                
                // Record block in share chain
                await this.shareChain.addBlock({
                    height: result.height,
                    hash: result.hash,
                    finder: share.minerAddress,
                    timestamp: Date.now(),
                    reward: result.reward
                });
                
                // Distribute block notification
                if (this.mode === 'pool') {
                    this.broadcastBlock(result);
                }
                
                this.emit('block:found', {
                    ...result,
                    finder: share.minerAddress
                });
            }
            
        } catch (error) {
            this.emit('error', { type: 'block_submission', error });
        }
    }
    
    // Mode switching logic
    checkModeSwitch() {
        const totalMiners = this.miners.size;
        const totalPeers = this.peers.size;
        const totalNodes = totalMiners + totalPeers;
        
        if (this.mode === 'solo' && totalNodes >= this.config.autoSwitchThreshold) {
            // Switch to pool mode
            this.mode = 'pool';
            this.emit('mode:changed', { mode: 'pool', nodes: totalNodes });
            
        } else if (this.mode === 'pool' && totalNodes < this.config.autoSwitchThreshold) {
            // Switch back to solo mode
            this.mode = 'solo';
            this.emit('mode:changed', { mode: 'solo', nodes: totalNodes });
        }
    }
    
    // Create coinbase transaction
    createCoinbaseTransaction(template) {
        const coinbaseValue = template.coinbasevalue;
        const height = template.height;
        
        // Build coinbase script
        const heightBuf = Buffer.alloc(4);
        heightBuf.writeUInt32LE(height, 0);
        
        const coinbaseScript = Buffer.concat([
            heightBuf,
            Buffer.from('Otedama Pool', 'utf8')
        ]);
        
        // Split for extranonce
        const part1 = coinbaseScript.slice(0, coinbaseScript.length / 2);
        const part2 = coinbaseScript.slice(coinbaseScript.length / 2);
        
        return { part1, part2, value: coinbaseValue };
    }
    
    // Helper methods
    calculateShareHash(share) {
        // Simplified - actual implementation would construct full block header
        const data = Buffer.concat([
            Buffer.from(share.jobId, 'hex'),
            Buffer.from(share.nonce, 'hex'),
            Buffer.from(share.ntime.toString(16), 'hex')
        ]);
        
        return crypto.createHash('sha256')
            .update(crypto.createHash('sha256').update(data).digest())
            .digest('hex');
    }
    
    difficultyToTarget(difficulty) {
        // Convert difficulty to target
        const maxTarget = BigInt('0xffff0000000000000000000000000000000000000000000000000000');
        return maxTarget / BigInt(difficulty);
    }
    
    constructBlock(share) {
        // Construct full block from share
        // Simplified - actual implementation would be more complex
        return Buffer.concat([
            Buffer.from(this.currentWork.version.toString(16), 'hex'),
            Buffer.from(this.currentWork.prevHash, 'hex'),
            Buffer.from(share.merkleRoot || '', 'hex'),
            Buffer.from(share.ntime.toString(16), 'hex'),
            Buffer.from(this.currentWork.nbits, 'hex'),
            Buffer.from(share.nonce, 'hex')
        ]).toString('hex');
    }
    
    // P2P broadcast methods
    broadcastShare(share) {
        const message = {
            type: 'share',
            poolId: this.config.poolId,
            data: share,
            timestamp: Date.now()
        };
        
        for (const peer of this.peers.values()) {
            peer.send(message);
        }
    }
    
    broadcastWork(work) {
        const message = {
            type: 'work',
            poolId: this.config.poolId,
            data: work,
            timestamp: Date.now()
        };
        
        for (const peer of this.peers.values()) {
            peer.send(message);
        }
    }
    
    broadcastBlock(block) {
        const message = {
            type: 'block',
            poolId: this.config.poolId,
            data: block,
            timestamp: Date.now()
        };
        
        for (const peer of this.peers.values()) {
            peer.send(message);
        }
    }
    
    // Get pool stats
    getStats() {
        return {
            mode: this.mode,
            poolId: this.config.poolId,
            miners: this.miners.size,
            peers: this.peers.size,
            hashrate: this.calculateTotalHashrate(),
            difficulty: this.stats.currentDifficulty,
            blocksFound: this.stats.blocksFound,
            sharesAccepted: this.stats.sharesAccepted,
            sharesRejected: this.stats.sharesRejected,
            uptime: process.uptime()
        };
    }
    
    calculateTotalHashrate() {
        let total = 0;
        for (const miner of this.miners.values()) {
            total += miner.hashrate || 0;
        }
        return total;
    }
    
    // Shutdown
    async shutdown() {
        // Stop loops
        clearInterval(this.workInterval);
        clearInterval(this.difficultyInterval);
        clearInterval(this.payoutInterval);
        
        // Close connections
        if (this.miningPool) await this.miningPool.stop();
        if (this.discovery) await this.discovery.stop();
        if (this.blockchain) await this.blockchain.disconnect();
        if (this.shareChain) await this.shareChain.close();
        
        this.emit('shutdown');
    }
}

module.exports = StandalonePool;