/**
 * Local Share Chain
 * Maintains a chain of shares for fair reward distribution
 * Can be synchronized across P2P network
 */

const { EventEmitter } = require('events');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class LocalShareChain extends EventEmitter {
    constructor(config) {
        super();
        
        this.config = {
            dataDir: config.dataDir || './data/shares',
            chainFile: config.chainFile || 'sharechain.json',
            maxShareAge: config.maxShareAge || 86400000, // 24 hours
            shareWindow: config.shareWindow || 3600000, // 1 hour for PPLNS
            compactInterval: config.compactInterval || 3600000, // 1 hour
            ...config
        };
        
        // Share chain data
        this.shares = [];
        this.blocks = [];
        this.minerStats = new Map();
        this.lastCompactTime = Date.now();
        
        // Chain metadata
        this.chainHeight = 0;
        this.chainHash = '0000000000000000000000000000000000000000000000000000000000000000';
    }
    
    // Initialize share chain
    async initialize() {
        try {
            // Create data directory
            await fs.mkdir(this.config.dataDir, { recursive: true });
            
            // Load existing chain
            await this.loadChain();
            
            // Start auto-compaction
            this.startAutoCompact();
            
            this.emit('initialized', {
                shares: this.shares.length,
                blocks: this.blocks.length,
                height: this.chainHeight
            });
            
        } catch (error) {
            this.emit('error', { type: 'initialization', error });
            throw error;
        }
    }
    
    // Add a new share to the chain
    async addShare(share) {
        // Validate share
        if (!this.validateShare(share)) {
            throw new Error('Invalid share');
        }
        
        // Create share entry
        const shareEntry = {
            id: crypto.randomBytes(16).toString('hex'),
            height: this.chainHeight + 1,
            previousHash: this.chainHash,
            timestamp: Date.now(),
            miner: share.minerAddress || share.workerId,
            difficulty: share.difficulty,
            hash: share.hash,
            nonce: share.nonce,
            poolId: share.poolId,
            jobId: share.jobId
        };
        
        // Calculate share hash
        shareEntry.shareHash = this.calculateShareHash(shareEntry);
        
        // Add to chain
        this.shares.push(shareEntry);
        this.chainHeight++;
        this.chainHash = shareEntry.shareHash;
        
        // Update miner stats
        this.updateMinerStats(shareEntry);
        
        // Save to disk
        await this.saveShare(shareEntry);
        
        this.emit('share:added', shareEntry);
        
        return shareEntry;
    }
    
    // Add a found block
    async addBlock(block) {
        const blockEntry = {
            ...block,
            id: crypto.randomBytes(16).toString('hex'),
            shareChainHeight: this.chainHeight,
            timestamp: Date.now()
        };
        
        this.blocks.push(blockEntry);
        
        // Save to disk
        await this.saveBlock(blockEntry);
        
        this.emit('block:added', blockEntry);
        
        return blockEntry;
    }
    
    // Get shares for reward calculation
    getSharesForReward(windowMs = null) {
        const window = windowMs || this.config.shareWindow;
        const cutoff = Date.now() - window;
        
        return this.shares.filter(share => share.timestamp > cutoff);
    }
    
    // Get miner statistics
    getMinerStats(minerAddress, windowMs = null) {
        const shares = windowMs ? this.getSharesForReward(windowMs) : this.shares;
        
        const stats = {
            totalShares: 0,
            totalDifficulty: 0,
            firstShare: null,
            lastShare: null,
            averageDifficulty: 0
        };
        
        for (const share of shares) {
            if (share.miner === minerAddress) {
                stats.totalShares++;
                stats.totalDifficulty += share.difficulty;
                
                if (!stats.firstShare || share.timestamp < stats.firstShare) {
                    stats.firstShare = share.timestamp;
                }
                
                if (!stats.lastShare || share.timestamp > stats.lastShare) {
                    stats.lastShare = share.timestamp;
                }
            }
        }
        
        if (stats.totalShares > 0) {
            stats.averageDifficulty = stats.totalDifficulty / stats.totalShares;
        }
        
        return stats;
    }
    
    // Calculate reward distribution
    calculateRewards(totalReward, feePercent = 0) {
        const shares = this.getSharesForReward();
        const poolFee = totalReward * feePercent;
        const distributableReward = totalReward - poolFee;
        
        // Calculate total work
        let totalWork = 0;
        const minerWork = new Map();
        
        for (const share of shares) {
            const work = share.difficulty;
            totalWork += work;
            
            const current = minerWork.get(share.miner) || 0;
            minerWork.set(share.miner, current + work);
        }
        
        // Calculate rewards
        const rewards = new Map();
        
        for (const [miner, work] of minerWork) {
            const proportion = work / totalWork;
            const reward = Math.floor(distributableReward * proportion);
            
            if (reward > 0) {
                rewards.set(miner, {
                    address: miner,
                    amount: reward,
                    shares: shares.filter(s => s.miner === miner).length,
                    proportion
                });
            }
        }
        
        return {
            totalReward,
            poolFee,
            distributableReward,
            rewards: Array.from(rewards.values()),
            shareWindow: this.config.shareWindow,
            totalShares: shares.length
        };
    }
    
    // Validate share
    validateShare(share) {
        // Basic validation
        if (!share.minerAddress && !share.workerId) return false;
        if (!share.difficulty || share.difficulty <= 0) return false;
        if (!share.nonce) return false;
        
        // Check for duplicate
        const duplicate = this.shares.find(s => 
            s.nonce === share.nonce && 
            s.jobId === share.jobId
        );
        
        return !duplicate;
    }
    
    // Calculate share hash
    calculateShareHash(share) {
        const data = JSON.stringify({
            height: share.height,
            previousHash: share.previousHash,
            timestamp: share.timestamp,
            miner: share.miner,
            difficulty: share.difficulty,
            nonce: share.nonce
        });
        
        return crypto.createHash('sha256').update(data).digest('hex');
    }
    
    // Update miner statistics
    updateMinerStats(share) {
        const stats = this.minerStats.get(share.miner) || {
            totalShares: 0,
            totalDifficulty: 0,
            lastShareTime: 0
        };
        
        stats.totalShares++;
        stats.totalDifficulty += share.difficulty;
        stats.lastShareTime = share.timestamp;
        
        this.minerStats.set(share.miner, stats);
    }
    
    // Save share to disk
    async saveShare(share) {
        const filename = `share_${share.height}_${share.id}.json`;
        const filepath = path.join(this.config.dataDir, filename);
        
        await fs.writeFile(filepath, JSON.stringify(share, null, 2));
    }
    
    // Save block to disk
    async saveBlock(block) {
        const filename = `block_${block.height}_${block.id}.json`;
        const filepath = path.join(this.config.dataDir, filename);
        
        await fs.writeFile(filepath, JSON.stringify(block, null, 2));
    }
    
    // Load chain from disk
    async loadChain() {
        try {
            // Load chain metadata
            const chainPath = path.join(this.config.dataDir, this.config.chainFile);
            
            try {
                const chainData = await fs.readFile(chainPath, 'utf8');
                const chain = JSON.parse(chainData);
                
                this.chainHeight = chain.height || 0;
                this.chainHash = chain.hash || '0000000000000000000000000000000000000000000000000000000000000000';
                
            } catch (error) {
                // Chain file doesn't exist, start fresh
            }
            
            // Load recent shares
            const files = await fs.readdir(this.config.dataDir);
            const shareFiles = files.filter(f => f.startsWith('share_')).sort();
            
            // Load last N shares based on max age
            const cutoff = Date.now() - this.config.maxShareAge;
            
            for (const file of shareFiles) {
                try {
                    const data = await fs.readFile(
                        path.join(this.config.dataDir, file),
                        'utf8'
                    );
                    const share = JSON.parse(data);
                    
                    if (share.timestamp > cutoff) {
                        this.shares.push(share);
                        this.updateMinerStats(share);
                    }
                } catch (error) {
                    // Skip corrupted files
                }
            }
            
            // Sort shares by height
            this.shares.sort((a, b) => a.height - b.height);
            
            // Load blocks
            const blockFiles = files.filter(f => f.startsWith('block_')).sort();
            
            for (const file of blockFiles) {
                try {
                    const data = await fs.readFile(
                        path.join(this.config.dataDir, file),
                        'utf8'
                    );
                    this.blocks.push(JSON.parse(data));
                } catch (error) {
                    // Skip corrupted files
                }
            }
            
        } catch (error) {
            this.emit('error', { type: 'load_chain', error });
        }
    }
    
    // Save chain metadata
    async saveChain() {
        const chainPath = path.join(this.config.dataDir, this.config.chainFile);
        
        const chainData = {
            height: this.chainHeight,
            hash: this.chainHash,
            shares: this.shares.length,
            blocks: this.blocks.length,
            lastUpdate: Date.now()
        };
        
        await fs.writeFile(chainPath, JSON.stringify(chainData, null, 2));
    }
    
    // Compact old shares
    async compactShares() {
        const cutoff = Date.now() - this.config.maxShareAge;
        const oldShares = this.shares.filter(s => s.timestamp < cutoff);
        
        // Remove old shares from memory
        this.shares = this.shares.filter(s => s.timestamp >= cutoff);
        
        // Delete old share files
        for (const share of oldShares) {
            try {
                const filename = `share_${share.height}_${share.id}.json`;
                const filepath = path.join(this.config.dataDir, filename);
                await fs.unlink(filepath);
            } catch (error) {
                // File might already be deleted
            }
        }
        
        // Save updated chain
        await this.saveChain();
        
        this.emit('compacted', {
            removed: oldShares.length,
            remaining: this.shares.length
        });
    }
    
    // Auto-compact timer
    startAutoCompact() {
        this.compactInterval = setInterval(async () => {
            try {
                await this.compactShares();
            } catch (error) {
                this.emit('error', { type: 'compact', error });
            }
        }, this.config.compactInterval);
    }
    
    // Get chain summary
    getSummary() {
        const now = Date.now();
        const hourAgo = now - 3600000;
        const dayAgo = now - 86400000;
        
        return {
            height: this.chainHeight,
            hash: this.chainHash,
            totalShares: this.shares.length,
            totalBlocks: this.blocks.length,
            sharesLastHour: this.shares.filter(s => s.timestamp > hourAgo).length,
            sharesLastDay: this.shares.filter(s => s.timestamp > dayAgo).length,
            activeMiners: this.minerStats.size,
            lastShare: this.shares.length > 0 ? 
                this.shares[this.shares.length - 1].timestamp : null
        };
    }
    
    // Export chain for P2P sync
    exportChain(fromHeight = 0, toHeight = null) {
        const maxHeight = toHeight || this.chainHeight;
        
        return {
            chainId: this.config.poolId,
            fromHeight,
            toHeight: maxHeight,
            shares: this.shares.filter(s => 
                s.height >= fromHeight && s.height <= maxHeight
            ),
            blocks: this.blocks.filter(b => 
                b.shareChainHeight >= fromHeight && 
                b.shareChainHeight <= maxHeight
            )
        };
    }
    
    // Import chain from P2P peer
    async importChain(chainData) {
        // Validate chain data
        if (!chainData.shares || !Array.isArray(chainData.shares)) {
            throw new Error('Invalid chain data');
        }
        
        // Import shares
        for (const share of chainData.shares) {
            // Skip if we already have this share
            if (this.shares.find(s => s.id === share.id)) {
                continue;
            }
            
            // Validate and add share
            if (this.validateShare(share)) {
                this.shares.push(share);
                this.updateMinerStats(share);
                await this.saveShare(share);
            }
        }
        
        // Import blocks
        if (chainData.blocks) {
            for (const block of chainData.blocks) {
                if (!this.blocks.find(b => b.id === block.id)) {
                    this.blocks.push(block);
                    await this.saveBlock(block);
                }
            }
        }
        
        // Re-sort shares
        this.shares.sort((a, b) => a.height - b.height);
        
        // Update chain height
        if (this.shares.length > 0) {
            const lastShare = this.shares[this.shares.length - 1];
            this.chainHeight = lastShare.height;
            this.chainHash = lastShare.shareHash;
        }
        
        await this.saveChain();
        
        this.emit('chain:imported', {
            shares: chainData.shares.length,
            blocks: (chainData.blocks || []).length
        });
    }
    
    // Close and cleanup
    async close() {
        if (this.compactInterval) {
            clearInterval(this.compactInterval);
        }
        
        await this.saveChain();
        this.emit('closed');
    }
}

module.exports = LocalShareChain;