/**
 * Governance System for Otedama
 * Decentralized governance with voting and proposals
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

export class GovernanceSystem extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            proposalThreshold: config.proposalThreshold || 10000, // OTD tokens required
            votingPeriod: config.votingPeriod || 3 * 24 * 60 * 60 * 1000, // 3 days
            executionDelay: config.executionDelay || 24 * 60 * 60 * 1000, // 1 day
            quorumPercentage: config.quorumPercentage || 0.04, // 4% of total supply
            passingPercentage: config.passingPercentage || 0.51, // 51% majority
            maxActiveProposals: config.maxActiveProposals || 10,
            ...config
        };
        
        this.logger = getLogger('Governance');
        
        // Proposals storage
        this.proposals = new Map(); // proposalId -> proposal
        
        // Voting records
        this.votes = new Map(); // proposalId -> userId -> vote
        
        // Voting power snapshots
        this.votingPowerSnapshots = new Map(); // proposalId -> userId -> power
        
        // Execution queue
        this.executionQueue = [];
        
        // Governance token info
        this.tokenInfo = {
            totalSupply: 1000000000, // 1B OTD
            circulatingSupply: 100000000 // 100M OTD
        };
        
        this.isRunning = false;
    }
    
    /**
     * Start governance system
     */
    async start() {
        if (this.isRunning) return;
        
        this.logger.info('Starting governance system...');
        
        // Start proposal monitoring
        this.startProposalMonitoring();
        
        // Start execution processing
        this.startExecutionProcessing();
        
        this.isRunning = true;
        this.logger.info('Governance system started');
    }
    
    /**
     * Create proposal
     */
    async createProposal(params) {
        const {
            proposerId,
            title,
            description,
            category, // 'parameter', 'upgrade', 'treasury', 'emergency'
            actions, // Array of actions to execute
            metadata = {}
        } = params;
        
        // Check proposer's token balance
        const proposerBalance = await this.getVotingPower(proposerId);
        if (proposerBalance < this.config.proposalThreshold) {
            throw new Error(`Insufficient tokens. Required: ${this.config.proposalThreshold}`);
        }
        
        // Check active proposals limit
        const activeProposals = Array.from(this.proposals.values())
            .filter(p => ['active', 'queued'].includes(p.status)).length;
        
        if (activeProposals >= this.config.maxActiveProposals) {
            throw new Error('Maximum active proposals reached');
        }
        
        // Create proposal
        const proposalId = this.generateProposalId();
        const now = Date.now();
        
        const proposal = {
            id: proposalId,
            proposerId,
            title,
            description,
            category,
            actions,
            metadata,
            status: 'active',
            createdAt: now,
            votingStartTime: now,
            votingEndTime: now + this.config.votingPeriod,
            executionTime: 0,
            votes: {
                for: 0,
                against: 0,
                abstain: 0
            },
            totalVotes: 0,
            executed: false,
            cancelled: false
        };
        
        this.proposals.set(proposalId, proposal);
        
        // Take snapshot of voting power
        await this.takeVotingPowerSnapshot(proposalId);
        
        this.logger.info(`Proposal created: ${proposalId} - ${title}`);
        this.emit('proposal-created', proposal);
        
        return {
            proposalId,
            votingEndTime: proposal.votingEndTime
        };
    }
    
    /**
     * Vote on proposal
     */
    async vote(params) {
        const {
            userId,
            proposalId,
            support, // true = for, false = against, null = abstain
            reason = ''
        } = params;
        
        const proposal = this.proposals.get(proposalId);
        if (!proposal) {
            throw new Error('Proposal not found');
        }
        
        const now = Date.now();
        
        // Check if voting is active
        if (proposal.status !== 'active') {
            throw new Error('Proposal is not active');
        }
        
        if (now < proposal.votingStartTime || now > proposal.votingEndTime) {
            throw new Error('Voting period has ended');
        }
        
        // Check if already voted
        if (!this.votes.has(proposalId)) {
            this.votes.set(proposalId, new Map());
        }
        
        const proposalVotes = this.votes.get(proposalId);
        if (proposalVotes.has(userId)) {
            throw new Error('Already voted on this proposal');
        }
        
        // Get voting power from snapshot
        const snapshots = this.votingPowerSnapshots.get(proposalId);
        const votingPower = snapshots.get(userId) || 0;
        
        if (votingPower === 0) {
            throw new Error('No voting power');
        }
        
        // Record vote
        const vote = {
            userId,
            proposalId,
            support,
            votingPower,
            reason,
            timestamp: now
        };
        
        proposalVotes.set(userId, vote);
        
        // Update proposal vote counts
        if (support === true) {
            proposal.votes.for += votingPower;
        } else if (support === false) {
            proposal.votes.against += votingPower;
        } else {
            proposal.votes.abstain += votingPower;
        }
        
        proposal.totalVotes += votingPower;
        
        this.emit('vote-cast', {
            ...vote,
            proposal: proposal.title
        });
        
        return {
            votingPower,
            currentResults: proposal.votes
        };
    }
    
    /**
     * Execute proposal
     */
    async executeProposal(proposalId) {
        const proposal = this.proposals.get(proposalId);
        if (!proposal) {
            throw new Error('Proposal not found');
        }
        
        const now = Date.now();
        
        // Check if proposal passed
        if (proposal.status !== 'queued') {
            throw new Error('Proposal must be queued for execution');
        }
        
        // Check execution delay
        if (now < proposal.executionTime) {
            const timeRemaining = proposal.executionTime - now;
            throw new Error(`Execution delay not met. ${timeRemaining}ms remaining`);
        }
        
        // Execute actions
        try {
            for (const action of proposal.actions) {
                await this.executeAction(action, proposal);
            }
            
            proposal.status = 'executed';
            proposal.executed = true;
            proposal.executedAt = now;
            
            this.logger.info(`Proposal executed: ${proposalId}`);
            this.emit('proposal-executed', proposal);
            
        } catch (error) {
            proposal.status = 'failed';
            proposal.error = error.message;
            
            this.logger.error(`Proposal execution failed: ${proposalId}`, error);
            this.emit('proposal-failed', {
                proposal,
                error: error.message
            });
            
            throw error;
        }
    }
    
    /**
     * Execute single action
     */
    async executeAction(action, proposal) {
        const { type, target, method, params } = action;
        
        switch (type) {
            case 'parameter':
                await this.updateParameter(target, method, params);
                break;
                
            case 'treasury':
                await this.executeTreasuryAction(target, method, params);
                break;
                
            case 'upgrade':
                await this.executeUpgrade(target, method, params);
                break;
                
            case 'emergency':
                if (proposal.category !== 'emergency') {
                    throw new Error('Emergency actions require emergency proposal');
                }
                await this.executeEmergencyAction(target, method, params);
                break;
                
            default:
                throw new Error(`Unknown action type: ${type}`);
        }
    }
    
    /**
     * Cancel proposal
     */
    async cancelProposal(proposalId, cancelerId) {
        const proposal = this.proposals.get(proposalId);
        if (!proposal) {
            throw new Error('Proposal not found');
        }
        
        // Only proposer or emergency admin can cancel
        if (proposal.proposerId !== cancelerId && !this.isEmergencyAdmin(cancelerId)) {
            throw new Error('Unauthorized to cancel proposal');
        }
        
        if (['executed', 'cancelled', 'failed'].includes(proposal.status)) {
            throw new Error('Cannot cancel proposal in current state');
        }
        
        proposal.status = 'cancelled';
        proposal.cancelled = true;
        proposal.cancelledAt = Date.now();
        proposal.cancelledBy = cancelerId;
        
        this.emit('proposal-cancelled', proposal);
        
        return {
            proposalId,
            status: 'cancelled'
        };
    }
    
    /**
     * Get proposal details
     */
    getProposal(proposalId) {
        const proposal = this.proposals.get(proposalId);
        if (!proposal) return null;
        
        // Calculate current state
        const now = Date.now();
        const quorum = this.calculateQuorum();
        const hasQuorum = proposal.totalVotes >= quorum;
        const supportPercentage = proposal.totalVotes > 0 ?
            proposal.votes.for / proposal.totalVotes : 0;
        const hasPassed = supportPercentage >= this.config.passingPercentage;
        
        return {
            ...proposal,
            quorum,
            hasQuorum,
            supportPercentage,
            hasPassed,
            timeRemaining: Math.max(0, proposal.votingEndTime - now)
        };
    }
    
    /**
     * Get all proposals
     */
    getProposals(filter = {}) {
        const proposals = [];
        
        for (const [proposalId, proposal] of this.proposals) {
            // Apply filters
            if (filter.status && proposal.status !== filter.status) continue;
            if (filter.category && proposal.category !== filter.category) continue;
            if (filter.proposerId && proposal.proposerId !== filter.proposerId) continue;
            
            proposals.push(this.getProposal(proposalId));
        }
        
        // Sort by creation date (newest first)
        proposals.sort((a, b) => b.createdAt - a.createdAt);
        
        return proposals;
    }
    
    /**
     * Take voting power snapshot
     */
    async takeVotingPowerSnapshot(proposalId) {
        const snapshots = new Map();
        
        // This would integrate with token contract
        // For now, use mock data
        const holders = await this.getTokenHolders();
        
        for (const holder of holders) {
            const votingPower = await this.calculateVotingPower(holder.userId, holder.balance);
            if (votingPower > 0) {
                snapshots.set(holder.userId, votingPower);
            }
        }
        
        this.votingPowerSnapshots.set(proposalId, snapshots);
    }
    
    /**
     * Calculate voting power
     */
    async calculateVotingPower(userId, balance) {
        // Base voting power = token balance
        let votingPower = balance;
        
        // Bonus for staked tokens (up to 2x)
        const stakedAmount = await this.getStakedAmount(userId);
        const stakeBonus = Math.min(stakedAmount, balance); // Max 100% bonus
        votingPower += stakeBonus;
        
        // Bonus for long-term holders (up to 1.5x)
        const holdingDuration = await this.getHoldingDuration(userId);
        const daysHeld = holdingDuration / (24 * 60 * 60 * 1000);
        const holdingBonus = Math.min(daysHeld / 365, 0.5) * balance; // Max 50% bonus after 1 year
        votingPower += holdingBonus;
        
        return Math.floor(votingPower);
    }
    
    /**
     * Calculate quorum
     */
    calculateQuorum() {
        return Math.floor(this.tokenInfo.circulatingSupply * this.config.quorumPercentage);
    }
    
    /**
     * Start proposal monitoring
     */
    startProposalMonitoring() {
        setInterval(() => {
            this.checkProposals();
        }, 60 * 1000); // Every minute
    }
    
    /**
     * Check and update proposal states
     */
    checkProposals() {
        const now = Date.now();
        
        for (const [proposalId, proposal] of this.proposals) {
            if (proposal.status === 'active' && now > proposal.votingEndTime) {
                // Voting ended, check results
                const quorum = this.calculateQuorum();
                const hasQuorum = proposal.totalVotes >= quorum;
                const supportPercentage = proposal.totalVotes > 0 ?
                    proposal.votes.for / proposal.totalVotes : 0;
                const hasPassed = supportPercentage >= this.config.passingPercentage;
                
                if (hasQuorum && hasPassed) {
                    // Queue for execution
                    proposal.status = 'queued';
                    proposal.executionTime = now + this.config.executionDelay;
                    this.executionQueue.push(proposalId);
                    
                    this.emit('proposal-queued', proposal);
                } else {
                    // Failed
                    proposal.status = 'failed';
                    proposal.failureReason = !hasQuorum ? 'Quorum not met' : 'Majority not reached';
                    
                    this.emit('proposal-failed', {
                        proposal,
                        reason: proposal.failureReason
                    });
                }
            }
        }
    }
    
    /**
     * Start execution processing
     */
    startExecutionProcessing() {
        setInterval(() => {
            this.processExecutionQueue();
        }, 30 * 1000); // Every 30 seconds
    }
    
    /**
     * Process execution queue
     */
    async processExecutionQueue() {
        const now = Date.now();
        const toExecute = [];
        
        // Find proposals ready for execution
        this.executionQueue = this.executionQueue.filter(proposalId => {
            const proposal = this.proposals.get(proposalId);
            if (!proposal || proposal.status !== 'queued') {
                return false; // Remove from queue
            }
            
            if (now >= proposal.executionTime) {
                toExecute.push(proposalId);
                return false; // Remove from queue
            }
            
            return true; // Keep in queue
        });
        
        // Execute ready proposals
        for (const proposalId of toExecute) {
            try {
                await this.executeProposal(proposalId);
            } catch (error) {
                this.logger.error(`Failed to execute proposal ${proposalId}:`, error);
            }
        }
    }
    
    /**
     * Delegate voting power
     */
    async delegate(delegatorId, delegateeId) {
        // This would integrate with token contract
        this.emit('delegation', {
            from: delegatorId,
            to: delegateeId,
            timestamp: Date.now()
        });
    }
    
    /**
     * Helper functions
     */
    generateProposalId() {
        return `PROP-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    
    async getVotingPower(userId) {
        // This would integrate with token contract
        return 50000; // Mock: 50k OTD
    }
    
    async getTokenHolders() {
        // This would integrate with token contract
        return [
            { userId: 'user1', balance: 100000 },
            { userId: 'user2', balance: 50000 },
            { userId: 'user3', balance: 25000 }
        ];
    }
    
    async getStakedAmount(userId) {
        // This would integrate with staking contract
        return 25000; // Mock: 25k staked
    }
    
    async getHoldingDuration(userId) {
        // This would integrate with token contract
        return 180 * 24 * 60 * 60 * 1000; // Mock: 180 days
    }
    
    isEmergencyAdmin(userId) {
        // This would check admin permissions
        return false;
    }
    
    /**
     * Action executors
     */
    async updateParameter(target, method, params) {
        this.logger.info(`Updating parameter: ${target}.${method}`, params);
        // This would call the actual contract/system
    }
    
    async executeTreasuryAction(target, method, params) {
        this.logger.info(`Executing treasury action: ${target}.${method}`, params);
        // This would interact with treasury
    }
    
    async executeUpgrade(target, method, params) {
        this.logger.info(`Executing upgrade: ${target}.${method}`, params);
        // This would perform system upgrades
    }
    
    async executeEmergencyAction(target, method, params) {
        this.logger.warn(`Executing emergency action: ${target}.${method}`, params);
        // This would perform emergency actions
    }
    
    /**
     * Get governance statistics
     */
    getStats() {
        const proposals = Array.from(this.proposals.values());
        
        return {
            totalProposals: proposals.length,
            activeProposals: proposals.filter(p => p.status === 'active').length,
            queuedProposals: proposals.filter(p => p.status === 'queued').length,
            executedProposals: proposals.filter(p => p.status === 'executed').length,
            failedProposals: proposals.filter(p => p.status === 'failed').length,
            totalVotesCast: proposals.reduce((sum, p) => sum + p.totalVotes, 0),
            currentQuorum: this.calculateQuorum(),
            tokenInfo: this.tokenInfo
        };
    }
    
    /**
     * Stop governance system
     */
    async stop() {
        if (!this.isRunning) return;
        
        this.logger.info('Stopping governance system...');
        
        // Clear intervals
        // (Would need to store interval IDs)
        
        this.isRunning = false;
        this.logger.info('Governance system stopped');
    }
}

export default GovernanceSystem;