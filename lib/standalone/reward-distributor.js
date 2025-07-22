/**
 * Reward Distributor
 * Handles fair reward distribution based on shares
 * Supports PPLNS (Pay Per Last N Shares) and other schemes
 */

const { EventEmitter } = require('events');
const fs = require('fs').promises;
const path = require('path');

class RewardDistributor extends EventEmitter {
    constructor(config) {
        super();
        
        this.config = {
            // Distribution settings
            scheme: config.scheme || 'PPLNS', // PPLNS, PPS, PROP
            shareWindow: config.shareWindow || 3600000, // 1 hour for PPLNS
            
            // Payment settings
            payoutThreshold: config.payoutThreshold || 0.001,
            payoutInterval: config.payoutInterval || 3600000, // 1 hour
            poolFee: config.poolFee || 0.01, // 1%
            
            // Transaction settings
            txFeePerKb: config.txFeePerKb || 0.0001,
            maxRecipientsPerTx: config.maxRecipientsPerTx || 100,
            
            // Data persistence
            dataDir: config.dataDir || './data/payouts',
            
            // Dependencies
            blockchain: config.blockchain,
            shareChain: config.shareChain,
            
            ...config
        };
        
        // Payout state
        this.pendingPayouts = new Map();
        this.payoutHistory = [];
        this.lastPayoutTime = Date.now();
        
        // Statistics
        this.stats = {
            totalPaid: 0,
            totalFees: 0,
            payoutCount: 0,
            minersPaid: new Set()
        };
    }
    
    // Initialize reward distributor
    async initialize() {
        try {
            // Create data directory
            await fs.mkdir(this.config.dataDir, { recursive: true });
            
            // Load pending payouts
            await this.loadPendingPayouts();
            
            // Load payout history
            await this.loadPayoutHistory();
            
            this.emit('initialized', {
                pending: this.pendingPayouts.size,
                history: this.payoutHistory.length
            });
            
        } catch (error) {
            this.emit('error', { type: 'initialization', error });
        }
    }
    
    // Calculate rewards based on shares
    async calculateRewards() {
        if (!this.config.shareChain) {
            throw new Error('Share chain not configured');
        }
        
        switch (this.config.scheme) {
            case 'PPLNS':
                return this.calculatePPLNS();
            case 'PPS':
                return this.calculatePPS();
            case 'PROP':
                return this.calculatePROP();
            default:
                throw new Error(`Unknown reward scheme: ${this.config.scheme}`);
        }
    }
    
    // PPLNS (Pay Per Last N Shares) calculation
    async calculatePPLNS() {
        // Get recent blocks
        const blocks = await this.getUnpaidBlocks();
        
        if (blocks.length === 0) {
            return { rewards: new Map(), totalReward: 0 };
        }
        
        const rewards = new Map();
        let totalReward = 0;
        
        for (const block of blocks) {
            // Get block reward
            const blockReward = block.reward || 0;
            const poolFee = blockReward * this.config.poolFee;
            const distributableReward = blockReward - poolFee;
            
            // Get shares for PPLNS window
            const shares = this.config.shareChain.getSharesForReward(this.config.shareWindow);
            
            if (shares.length === 0) {
                continue;
            }
            
            // Calculate total work in window
            let totalWork = 0;
            const minerWork = new Map();
            
            for (const share of shares) {
                const work = share.difficulty;
                totalWork += work;
                
                const current = minerWork.get(share.miner) || 0;
                minerWork.set(share.miner, current + work);
            }
            
            // Distribute rewards proportionally
            for (const [miner, work] of minerWork) {
                const proportion = work / totalWork;
                const minerReward = Math.floor(distributableReward * proportion);
                
                if (minerReward > 0) {
                    const current = rewards.get(miner) || 0;
                    rewards.set(miner, current + minerReward);
                    totalReward += minerReward;
                }
            }
            
            // Mark block as processed
            block.rewardProcessed = true;
        }
        
        return { rewards, totalReward };
    }
    
    // PPS (Pay Per Share) calculation
    async calculatePPS() {
        const rewards = new Map();
        let totalReward = 0;
        
        // Get expected block value
        const expectedBlockValue = await this.getExpectedBlockValue();
        const shareValue = expectedBlockValue / this.config.expectedSharesPerBlock;
        
        // Get unpaid shares
        const shares = await this.getUnpaidShares();
        
        for (const share of shares) {
            const minerReward = Math.floor(shareValue * share.difficulty);
            
            if (minerReward > 0) {
                const current = rewards.get(share.miner) || 0;
                rewards.set(share.miner, current + minerReward);
                totalReward += minerReward;
            }
            
            share.paid = true;
        }
        
        return { rewards, totalReward };
    }
    
    // PROP (Proportional) calculation
    async calculatePROP() {
        // Get current round shares
        const shares = await this.getCurrentRoundShares();
        const lastBlock = await this.getLastBlock();
        
        if (!lastBlock || shares.length === 0) {
            return { rewards: new Map(), totalReward: 0 };
        }
        
        const rewards = new Map();
        const blockReward = lastBlock.reward || 0;
        const poolFee = blockReward * this.config.poolFee;
        const distributableReward = blockReward - poolFee;
        
        // Calculate total work
        let totalWork = 0;
        const minerWork = new Map();
        
        for (const share of shares) {
            const work = share.difficulty;
            totalWork += work;
            
            const current = minerWork.get(share.miner) || 0;
            minerWork.set(share.miner, current + work);
        }
        
        // Distribute proportionally
        let totalReward = 0;
        for (const [miner, work] of minerWork) {
            const proportion = work / totalWork;
            const minerReward = Math.floor(distributableReward * proportion);
            
            if (minerReward > 0) {
                rewards.set(miner, minerReward);
                totalReward += minerReward;
            }
        }
        
        return { rewards, totalReward };
    }
    
    // Process payout
    async processPayout(rewardData) {
        const { rewards, totalReward } = rewardData;
        
        if (rewards.size === 0) {
            return { success: true, payouts: [] };
        }
        
        // Add to pending payouts
        for (const [miner, amount] of rewards) {
            const current = this.pendingPayouts.get(miner) || 0;
            this.pendingPayouts.set(miner, current + amount);
        }
        
        // Filter miners above threshold
        const readyPayouts = new Map();
        
        for (const [miner, amount] of this.pendingPayouts) {
            if (amount >= this.satoshisToCoins(this.config.payoutThreshold)) {
                readyPayouts.set(miner, amount);
            }
        }
        
        if (readyPayouts.size === 0) {
            return { success: true, payouts: [] };
        }
        
        // Create payout transactions
        const payouts = await this.createPayoutTransactions(readyPayouts);
        
        // Save pending payouts
        await this.savePendingPayouts();
        
        return { success: true, payouts };
    }
    
    // Create payout transactions
    async createPayoutTransactions(payouts) {
        const transactions = [];
        const miners = Array.from(payouts.entries());
        
        // Split into batches
        for (let i = 0; i < miners.length; i += this.config.maxRecipientsPerTx) {
            const batch = miners.slice(i, i + this.config.maxRecipientsPerTx);
            const recipients = {};
            
            let totalAmount = 0;
            for (const [miner, amount] of batch) {
                recipients[miner] = this.satoshisToCoins(amount);
                totalAmount += amount;
            }
            
            try {
                // Send transaction
                const result = await this.config.blockchain.sendTransaction(
                    recipients,
                    this.config.txFeePerKb
                );
                
                if (result.success) {
                    // Record successful payout
                    const payoutRecord = {
                        txid: result.txid,
                        timestamp: Date.now(),
                        recipients: batch.map(([miner, amount]) => ({
                            address: miner,
                            amount
                        })),
                        totalAmount,
                        fee: result.fee || 0
                    };
                    
                    transactions.push(payoutRecord);
                    
                    // Remove from pending
                    for (const [miner] of batch) {
                        this.pendingPayouts.delete(miner);
                        this.stats.minersPaid.add(miner);
                    }
                    
                    // Update stats
                    this.stats.totalPaid += totalAmount;
                    this.stats.totalFees += result.fee || 0;
                    this.stats.payoutCount++;
                    
                    // Save to history
                    await this.savePayoutRecord(payoutRecord);
                    
                    this.emit('payout:sent', payoutRecord);
                    
                } else {
                    this.emit('payout:failed', {
                        error: result.error,
                        miners: batch.map(([miner]) => miner)
                    });
                }
                
            } catch (error) {
                this.emit('payout:error', {
                    error: error.message,
                    miners: batch.map(([miner]) => miner)
                });
            }
        }
        
        return transactions;
    }
    
    // Get unpaid blocks
    async getUnpaidBlocks() {
        if (!this.config.shareChain) {
            return [];
        }
        
        return this.config.shareChain.blocks.filter(b => !b.rewardProcessed);
    }
    
    // Get unpaid shares (for PPS)
    async getUnpaidShares() {
        if (!this.config.shareChain) {
            return [];
        }
        
        return this.config.shareChain.shares.filter(s => !s.paid);
    }
    
    // Get current round shares (for PROP)
    async getCurrentRoundShares() {
        if (!this.config.shareChain) {
            return [];
        }
        
        const lastBlock = await this.getLastBlock();
        const lastBlockTime = lastBlock ? lastBlock.timestamp : 0;
        
        return this.config.shareChain.shares.filter(s => s.timestamp > lastBlockTime);
    }
    
    // Get last block
    async getLastBlock() {
        if (!this.config.shareChain || this.config.shareChain.blocks.length === 0) {
            return null;
        }
        
        return this.config.shareChain.blocks[this.config.shareChain.blocks.length - 1];
    }
    
    // Get expected block value
    async getExpectedBlockValue() {
        if (!this.config.blockchain) {
            return 5000000000; // Default 50 coins
        }
        
        const info = await this.config.blockchain.getInfo();
        const reward = this.config.blockchain.calculateBlockReward(info.blocks + 1);
        
        return reward;
    }
    
    // Load pending payouts
    async loadPendingPayouts() {
        try {
            const filepath = path.join(this.config.dataDir, 'pending.json');
            const data = await fs.readFile(filepath, 'utf8');
            const pending = JSON.parse(data);
            
            this.pendingPayouts = new Map(Object.entries(pending));
            
        } catch (error) {
            // File doesn't exist, start fresh
        }
    }
    
    // Save pending payouts
    async savePendingPayouts() {
        const filepath = path.join(this.config.dataDir, 'pending.json');
        const pending = Object.fromEntries(this.pendingPayouts);
        
        await fs.writeFile(filepath, JSON.stringify(pending, null, 2));
    }
    
    // Load payout history
    async loadPayoutHistory() {
        try {
            const files = await fs.readdir(this.config.dataDir);
            const payoutFiles = files.filter(f => f.startsWith('payout_')).sort();
            
            // Load recent payouts
            const recentFiles = payoutFiles.slice(-100); // Last 100 payouts
            
            for (const file of recentFiles) {
                try {
                    const data = await fs.readFile(
                        path.join(this.config.dataDir, file),
                        'utf8'
                    );
                    this.payoutHistory.push(JSON.parse(data));
                } catch (error) {
                    // Skip corrupted files
                }
            }
            
        } catch (error) {
            // Directory doesn't exist
        }
    }
    
    // Save payout record
    async savePayoutRecord(record) {
        const filename = `payout_${record.timestamp}_${record.txid.substring(0, 8)}.json`;
        const filepath = path.join(this.config.dataDir, filename);
        
        await fs.writeFile(filepath, JSON.stringify(record, null, 2));
        
        this.payoutHistory.push(record);
        
        // Keep only recent history in memory
        if (this.payoutHistory.length > 1000) {
            this.payoutHistory = this.payoutHistory.slice(-1000);
        }
    }
    
    // Get payout statistics
    getStats() {
        return {
            scheme: this.config.scheme,
            totalPaid: this.satoshisToCoins(this.stats.totalPaid),
            totalFees: this.satoshisToCoins(this.stats.totalFees),
            payoutCount: this.stats.payoutCount,
            uniqueMiners: this.stats.minersPaid.size,
            pendingPayouts: this.pendingPayouts.size,
            pendingAmount: this.satoshisToCoins(
                Array.from(this.pendingPayouts.values()).reduce((a, b) => a + b, 0)
            ),
            lastPayout: this.payoutHistory.length > 0 ? 
                this.payoutHistory[this.payoutHistory.length - 1].timestamp : null
        };
    }
    
    // Get miner balance
    getMinerBalance(minerAddress) {
        const pending = this.pendingPayouts.get(minerAddress) || 0;
        
        const paid = this.payoutHistory
            .filter(p => p.recipients.some(r => r.address === minerAddress))
            .reduce((total, payout) => {
                const recipient = payout.recipients.find(r => r.address === minerAddress);
                return total + (recipient ? recipient.amount : 0);
            }, 0);
        
        return {
            address: minerAddress,
            pending: this.satoshisToCoins(pending),
            paid: this.satoshisToCoins(paid),
            total: this.satoshisToCoins(pending + paid)
        };
    }
    
    // Utility functions
    satoshisToCoins(satoshis) {
        return satoshis / 100000000;
    }
    
    coinsToSatoshis(coins) {
        return Math.floor(coins * 100000000);
    }
}

module.exports = RewardDistributor;