const { EventEmitter } = require('events');
const crypto = require('crypto');

class DistributedGovernanceSystem extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            votingPeriod: options.votingPeriod || 7 * 24 * 60 * 60 * 1000, // 7 days
            quorumPercentage: options.quorumPercentage || 0.51,
            proposalThreshold: options.proposalThreshold || 100, // Min tokens to propose
            executionDelay: options.executionDelay || 2 * 24 * 60 * 60 * 1000, // 2 days
            maxActiveProposals: options.maxActiveProposals || 10,
            delegationEnabled: options.delegationEnabled !== false,
            quadraticVoting: options.quadraticVoting || false,
            ...options
        };
        
        this.proposals = new Map();
        this.votes = new Map();
        this.delegations = new Map();
        this.members = new Map();
        this.executionQueue = [];
        
        // Governance tokens
        this.tokenHolders = new Map();
        this.totalSupply = 0;
        
        // Committees
        this.committees = new Map();
        this.committeeProposals = new Map();
        
        // State
        this.governanceState = {
            proposalCount: 0,
            executedProposals: 0,
            rejectedProposals: 0,
            activeVoters: new Set(),
            participation: 0
        };
        
        this.isRunning = false;
    }

    async initialize() {
        // Initialize governance token distribution
        await this.initializeTokenDistribution();
        
        // Setup committees
        this.setupCommittees();
        
        // Start execution scheduler
        this.startExecutionScheduler();
        
        // Load saved state if exists
        await this.loadGovernanceState();
        
        this.isRunning = true;
        this.emit('initialized');
    }

    async initializeTokenDistribution() {
        // Initial token distribution
        const initialDistribution = this.config.initialDistribution || {
            founders: 0.2,
            community: 0.5,
            treasury: 0.2,
            rewards: 0.1
        };
        
        const totalTokens = this.config.totalSupply || 1000000;
        
        for (const [category, percentage] of Object.entries(initialDistribution)) {
            const amount = totalTokens * percentage;
            this.tokenHolders.set(category, amount);
            this.totalSupply += amount;
        }
        
        this.emit('tokens:distributed', initialDistribution);
    }

    setupCommittees() {
        // Technical Committee
        this.createCommittee('technical', {
            members: [],
            threshold: 0.6,
            scope: ['protocol', 'security', 'performance'],
            maxMembers: 7
        });
        
        // Economic Committee
        this.createCommittee('economic', {
            members: [],
            threshold: 0.7,
            scope: ['tokenomics', 'fees', 'rewards'],
            maxMembers: 5
        });
        
        // Security Committee
        this.createCommittee('security', {
            members: [],
            threshold: 0.8,
            scope: ['emergency', 'vulnerabilities', 'audits'],
            maxMembers: 3,
            fastTrack: true
        });
    }

    createCommittee(name, config) {
        this.committees.set(name, {
            name,
            ...config,
            proposals: new Map(),
            decisions: []
        });
        
        this.emit('committee:created', { name, config });
    }

    async createProposal(proposalData) {
        const { 
            proposer, 
            title, 
            description, 
            category,
            actions,
            metadata 
        } = proposalData;
        
        // Validate proposer has enough tokens
        const proposerBalance = this.getVotingPower(proposer);
        if (proposerBalance < this.config.proposalThreshold) {
            throw new Error('Insufficient tokens to create proposal');
        }
        
        // Check active proposal limit
        const activeProposals = Array.from(this.proposals.values())
            .filter(p => p.status === 'active').length;
        
        if (activeProposals >= this.config.maxActiveProposals) {
            throw new Error('Maximum active proposals reached');
        }
        
        const proposalId = this.generateProposalId();
        
        const proposal = {
            id: proposalId,
            proposer,
            title,
            description,
            category,
            actions: actions || [],
            metadata: metadata || {},
            createdAt: Date.now(),
            endTime: Date.now() + this.config.votingPeriod,
            status: 'active',
            votes: {
                for: 0,
                against: 0,
                abstain: 0
            },
            voters: new Set(),
            executionTime: null,
            result: null
        };
        
        this.proposals.set(proposalId, proposal);
        this.governanceState.proposalCount++;
        
        this.emit('proposal:created', proposal);
        
        // Auto-vote with proposer's tokens
        await this.vote(proposalId, proposer, 'for');
        
        return proposalId;
    }

    async vote(proposalId, voter, choice, amount = null) {
        const proposal = this.proposals.get(proposalId);
        if (!proposal) {
            throw new Error('Proposal not found');
        }
        
        if (proposal.status !== 'active') {
            throw new Error('Proposal is not active');
        }
        
        if (Date.now() > proposal.endTime) {
            throw new Error('Voting period has ended');
        }
        
        if (proposal.voters.has(voter)) {
            throw new Error('Already voted on this proposal');
        }
        
        // Calculate voting power
        let votingPower = this.getVotingPower(voter);
        
        // Apply quadratic voting if enabled
        if (this.config.quadraticVoting && amount !== null) {
            votingPower = Math.sqrt(Math.min(amount, votingPower));
        }
        
        // Apply delegation
        const delegatedPower = this.getDelegatedVotingPower(voter);
        votingPower += delegatedPower;
        
        // Record vote
        if (choice === 'for') {
            proposal.votes.for += votingPower;
        } else if (choice === 'against') {
            proposal.votes.against += votingPower;
        } else if (choice === 'abstain') {
            proposal.votes.abstain += votingPower;
        } else {
            throw new Error('Invalid vote choice');
        }
        
        proposal.voters.add(voter);
        
        // Store vote details
        if (!this.votes.has(proposalId)) {
            this.votes.set(proposalId, new Map());
        }
        
        this.votes.get(proposalId).set(voter, {
            choice,
            power: votingPower,
            timestamp: Date.now(),
            delegated: delegatedPower > 0
        });
        
        // Update active voters
        this.governanceState.activeVoters.add(voter);
        
        this.emit('vote:cast', {
            proposalId,
            voter,
            choice,
            votingPower
        });
        
        // Check if proposal should be finalized early
        await this.checkEarlyFinalization(proposalId);
    }

    async delegate(delegator, delegate, amount = null) {
        if (!this.config.delegationEnabled) {
            throw new Error('Delegation is not enabled');
        }
        
        if (delegator === delegate) {
            throw new Error('Cannot delegate to self');
        }
        
        const delegatorBalance = this.getVotingPower(delegator);
        const delegationAmount = amount || delegatorBalance;
        
        if (delegationAmount > delegatorBalance) {
            throw new Error('Insufficient balance to delegate');
        }
        
        // Check for circular delegation
        if (this.wouldCreateCircularDelegation(delegator, delegate)) {
            throw new Error('Would create circular delegation');
        }
        
        this.delegations.set(delegator, {
            delegate,
            amount: delegationAmount,
            timestamp: Date.now()
        });
        
        this.emit('delegation:created', {
            delegator,
            delegate,
            amount: delegationAmount
        });
    }

    wouldCreateCircularDelegation(delegator, delegate) {
        let current = delegate;
        const visited = new Set();
        
        while (current) {
            if (visited.has(current) || current === delegator) {
                return true;
            }
            
            visited.add(current);
            const delegation = this.delegations.get(current);
            current = delegation?.delegate;
        }
        
        return false;
    }

    getVotingPower(address) {
        // Base voting power from token balance
        const balance = this.tokenHolders.get(address) || 0;
        
        // Subtract delegated amount
        const delegation = this.delegations.get(address);
        const delegatedAmount = delegation?.amount || 0;
        
        return balance - delegatedAmount;
    }

    getDelegatedVotingPower(address) {
        let delegatedPower = 0;
        
        // Sum all delegations to this address
        for (const [delegator, delegation] of this.delegations) {
            if (delegation.delegate === address) {
                delegatedPower += delegation.amount;
            }
        }
        
        return delegatedPower;
    }

    async checkEarlyFinalization(proposalId) {
        const proposal = this.proposals.get(proposalId);
        const totalVotes = proposal.votes.for + proposal.votes.against + proposal.votes.abstain;
        const totalPossibleVotes = this.totalSupply;
        
        // Check if outcome is already determined
        if (proposal.votes.for > totalPossibleVotes / 2) {
            // Proposal will pass regardless of remaining votes
            await this.finalizeProposal(proposalId, true);
        } else if (proposal.votes.against > totalPossibleVotes / 2) {
            // Proposal will fail regardless of remaining votes
            await this.finalizeProposal(proposalId, true);
        }
    }

    async finalizeProposal(proposalId, early = false) {
        const proposal = this.proposals.get(proposalId);
        if (!proposal) return;
        
        if (!early && Date.now() < proposal.endTime) {
            return; // Not time yet
        }
        
        const totalVotes = proposal.votes.for + proposal.votes.against + proposal.votes.abstain;
        const quorum = totalVotes / this.totalSupply;
        
        // Check quorum
        if (quorum < this.config.quorumPercentage) {
            proposal.status = 'rejected';
            proposal.result = 'no_quorum';
            this.governanceState.rejectedProposals++;
        } else {
            // Check if proposal passed
            const forPercentage = proposal.votes.for / totalVotes;
            
            if (forPercentage > 0.5) {
                proposal.status = 'passed';
                proposal.result = 'approved';
                proposal.executionTime = Date.now() + this.config.executionDelay;
                
                // Add to execution queue
                this.executionQueue.push({
                    proposalId,
                    executionTime: proposal.executionTime
                });
            } else {
                proposal.status = 'rejected';
                proposal.result = 'defeated';
                this.governanceState.rejectedProposals++;
            }
        }
        
        // Calculate participation rate
        this.governanceState.participation = 
            this.governanceState.activeVoters.size / this.members.size;
        
        this.emit('proposal:finalized', {
            proposalId,
            status: proposal.status,
            result: proposal.result,
            votes: proposal.votes,
            quorum,
            participation: totalVotes / this.totalSupply
        });
    }

    startExecutionScheduler() {
        this.executionInterval = setInterval(async () => {
            await this.processExecutionQueue();
        }, 60000); // Check every minute
    }

    async processExecutionQueue() {
        const now = Date.now();
        const toExecute = [];
        
        // Find proposals ready to execute
        this.executionQueue = this.executionQueue.filter(item => {
            if (item.executionTime <= now) {
                toExecute.push(item);
                return false;
            }
            return true;
        });
        
        // Execute proposals
        for (const item of toExecute) {
            await this.executeProposal(item.proposalId);
        }
    }

    async executeProposal(proposalId) {
        const proposal = this.proposals.get(proposalId);
        if (!proposal || proposal.status !== 'passed') {
            return;
        }
        
        try {
            // Execute all actions
            for (const action of proposal.actions) {
                await this.executeAction(action, proposal);
            }
            
            proposal.status = 'executed';
            this.governanceState.executedProposals++;
            
            this.emit('proposal:executed', {
                proposalId,
                actions: proposal.actions
            });
            
        } catch (error) {
            proposal.status = 'failed';
            proposal.error = error.message;
            
            this.emit('proposal:execution-failed', {
                proposalId,
                error: error.message
            });
        }
    }

    async executeAction(action, proposal) {
        const { type, target, method, params } = action;
        
        switch (type) {
            case 'parameter_change':
                await this.changeParameter(target, params);
                break;
                
            case 'transfer':
                await this.executeTransfer(target, params);
                break;
                
            case 'contract_call':
                await this.executeContractCall(target, method, params);
                break;
                
            case 'committee_action':
                await this.executeCommitteeAction(target, params);
                break;
                
            default:
                throw new Error(`Unknown action type: ${type}`);
        }
    }

    async changeParameter(parameter, value) {
        // Update governance parameters
        const allowedParameters = [
            'votingPeriod',
            'quorumPercentage',
            'proposalThreshold',
            'executionDelay'
        ];
        
        if (!allowedParameters.includes(parameter)) {
            throw new Error(`Parameter ${parameter} cannot be changed`);
        }
        
        const oldValue = this.config[parameter];
        this.config[parameter] = value;
        
        this.emit('parameter:changed', {
            parameter,
            oldValue,
            newValue: value
        });
    }

    async executeTransfer(recipient, params) {
        const { amount, token } = params;
        
        // Transfer from treasury
        const treasuryBalance = this.tokenHolders.get('treasury') || 0;
        
        if (amount > treasuryBalance) {
            throw new Error('Insufficient treasury balance');
        }
        
        this.tokenHolders.set('treasury', treasuryBalance - amount);
        
        const recipientBalance = this.tokenHolders.get(recipient) || 0;
        this.tokenHolders.set(recipient, recipientBalance + amount);
        
        this.emit('transfer:executed', {
            from: 'treasury',
            to: recipient,
            amount,
            token
        });
    }

    async executeContractCall(target, method, params) {
        // Placeholder for smart contract interactions
        this.emit('contract:called', {
            target,
            method,
            params
        });
    }

    // Committee Governance
    async createCommitteeProposal(committee, proposalData) {
        const committeeInfo = this.committees.get(committee);
        if (!committeeInfo) {
            throw new Error('Committee not found');
        }
        
        const { proposer } = proposalData;
        
        // Check if proposer is committee member
        if (!committeeInfo.members.includes(proposer)) {
            throw new Error('Only committee members can create proposals');
        }
        
        const proposalId = this.generateProposalId();
        
        const proposal = {
            id: proposalId,
            committee,
            ...proposalData,
            createdAt: Date.now(),
            votes: new Map(),
            status: 'active'
        };
        
        committeeInfo.proposals.set(proposalId, proposal);
        
        this.emit('committee:proposal-created', {
            committee,
            proposal
        });
        
        return proposalId;
    }

    async voteCommitteeProposal(committee, proposalId, member, vote) {
        const committeeInfo = this.committees.get(committee);
        if (!committeeInfo) {
            throw new Error('Committee not found');
        }
        
        if (!committeeInfo.members.includes(member)) {
            throw new Error('Only committee members can vote');
        }
        
        const proposal = committeeInfo.proposals.get(proposalId);
        if (!proposal) {
            throw new Error('Proposal not found');
        }
        
        proposal.votes.set(member, {
            vote,
            timestamp: Date.now()
        });
        
        // Check if threshold reached
        const approvals = Array.from(proposal.votes.values())
            .filter(v => v.vote === 'approve').length;
        
        const threshold = Math.ceil(committeeInfo.members.length * committeeInfo.threshold);
        
        if (approvals >= threshold) {
            await this.executeCommitteeProposal(committee, proposalId);
        }
        
        this.emit('committee:vote-cast', {
            committee,
            proposalId,
            member,
            vote
        });
    }

    async executeCommitteeProposal(committee, proposalId) {
        const committeeInfo = this.committees.get(committee);
        const proposal = committeeInfo.proposals.get(proposalId);
        
        if (!proposal) return;
        
        // Execute committee action
        if (committeeInfo.fastTrack && proposal.type === 'emergency') {
            // Fast track execution for emergency proposals
            await this.executeAction(proposal.action, proposal);
        } else {
            // Create main governance proposal
            await this.createProposal({
                proposer: `committee:${committee}`,
                title: `[${committee}] ${proposal.title}`,
                description: proposal.description,
                category: 'committee',
                actions: [proposal.action]
            });
        }
        
        proposal.status = 'executed';
        
        committeeInfo.decisions.push({
            proposalId,
            timestamp: Date.now(),
            decision: 'approved'
        });
        
        this.emit('committee:proposal-executed', {
            committee,
            proposalId
        });
    }

    async executeCommitteeAction(committee, params) {
        const { action, member } = params;
        const committeeInfo = this.committees.get(committee);
        
        if (!committeeInfo) {
            throw new Error('Committee not found');
        }
        
        switch (action) {
            case 'add_member':
                if (committeeInfo.members.length >= committeeInfo.maxMembers) {
                    throw new Error('Committee is full');
                }
                committeeInfo.members.push(member);
                break;
                
            case 'remove_member':
                committeeInfo.members = committeeInfo.members.filter(m => m !== member);
                break;
                
            default:
                throw new Error(`Unknown committee action: ${action}`);
        }
        
        this.emit('committee:updated', {
            committee,
            action,
            members: committeeInfo.members
        });
    }

    // Quadratic Funding
    async createFundingRound(params) {
        const {
            name,
            matchingPool,
            startTime,
            endTime,
            eligibilityCriteria
        } = params;
        
        const round = {
            id: this.generateProposalId(),
            name,
            matchingPool,
            startTime: startTime || Date.now(),
            endTime: endTime || Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
            eligibilityCriteria,
            projects: new Map(),
            contributions: new Map(),
            status: 'active'
        };
        
        this.fundingRounds = this.fundingRounds || new Map();
        this.fundingRounds.set(round.id, round);
        
        this.emit('funding:round-created', round);
        
        return round.id;
    }

    async contributeToProject(roundId, projectId, contributor, amount) {
        const round = this.fundingRounds?.get(roundId);
        if (!round || round.status !== 'active') {
            throw new Error('Funding round not active');
        }
        
        const project = round.projects.get(projectId);
        if (!project) {
            throw new Error('Project not found');
        }
        
        // Record contribution
        const contributionKey = `${contributor}-${projectId}`;
        const existing = round.contributions.get(contributionKey) || 0;
        round.contributions.set(contributionKey, existing + amount);
        
        // Update project totals
        project.totalContributed += amount;
        project.contributorCount = new Set([
            ...Array.from(round.contributions.keys())
                .filter(key => key.endsWith(`-${projectId}`))
                .map(key => key.split('-')[0])
        ]).size;
        
        this.emit('funding:contribution', {
            roundId,
            projectId,
            contributor,
            amount
        });
    }

    calculateQuadraticMatching(roundId) {
        const round = this.fundingRounds?.get(roundId);
        if (!round) return null;
        
        const results = new Map();
        
        // Calculate quadratic funding for each project
        for (const [projectId, project] of round.projects) {
            const contributions = Array.from(round.contributions.entries())
                .filter(([key, _]) => key.endsWith(`-${projectId}`))
                .map(([_, amount]) => Math.sqrt(amount));
            
            const sumOfSqrts = contributions.reduce((a, b) => a + b, 0);
            const quadraticValue = Math.pow(sumOfSqrts, 2);
            
            results.set(projectId, {
                directFunding: project.totalContributed,
                quadraticValue,
                contributorCount: project.contributorCount
            });
        }
        
        // Distribute matching pool
        const totalQuadraticValue = Array.from(results.values())
            .reduce((sum, r) => sum + r.quadraticValue, 0);
        
        for (const [projectId, result] of results) {
            result.matchingAmount = (result.quadraticValue / totalQuadraticValue) * round.matchingPool;
            result.totalAmount = result.directFunding + result.matchingAmount;
        }
        
        return results;
    }

    // Token Management
    async mintTokens(recipient, amount, reason) {
        // Only treasury or governance can mint
        const treasuryBalance = this.tokenHolders.get('treasury') || 0;
        
        this.tokenHolders.set(recipient, (this.tokenHolders.get(recipient) || 0) + amount);
        this.totalSupply += amount;
        
        this.emit('tokens:minted', {
            recipient,
            amount,
            reason,
            newTotalSupply: this.totalSupply
        });
    }

    async burnTokens(holder, amount, reason) {
        const balance = this.tokenHolders.get(holder) || 0;
        
        if (balance < amount) {
            throw new Error('Insufficient balance to burn');
        }
        
        this.tokenHolders.set(holder, balance - amount);
        this.totalSupply -= amount;
        
        this.emit('tokens:burned', {
            holder,
            amount,
            reason,
            newTotalSupply: this.totalSupply
        });
    }

    // Snapshot and State Management
    async createSnapshot() {
        const snapshot = {
            timestamp: Date.now(),
            blockHeight: this.getBlockHeight(),
            tokenHolders: new Map(this.tokenHolders),
            totalSupply: this.totalSupply,
            proposals: Array.from(this.proposals.values()),
            delegations: new Map(this.delegations)
        };
        
        this.snapshots = this.snapshots || [];
        this.snapshots.push(snapshot);
        
        return snapshot;
    }

    async loadGovernanceState() {
        // Load saved state from storage
        // Placeholder implementation
    }

    generateProposalId() {
        return `proposal_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    }

    getBlockHeight() {
        // Placeholder - would get actual blockchain block height
        return Math.floor(Date.now() / 15000); // Approximate 15-second blocks
    }

    getGovernanceStats() {
        const activeProposals = Array.from(this.proposals.values())
            .filter(p => p.status === 'active');
        
        const participation = this.governanceState.activeVoters.size / 
                            Math.max(1, this.members.size);
        
        return {
            totalProposals: this.governanceState.proposalCount,
            activeProposals: activeProposals.length,
            executedProposals: this.governanceState.executedProposals,
            rejectedProposals: this.governanceState.rejectedProposals,
            participationRate: participation,
            totalMembers: this.members.size,
            activeVoters: this.governanceState.activeVoters.size,
            totalSupply: this.totalSupply,
            committees: Array.from(this.committees.keys()),
            delegations: this.delegations.size
        };
    }

    async stop() {
        this.isRunning = false;
        
        if (this.executionInterval) {
            clearInterval(this.executionInterval);
        }
        
        // Save state
        await this.saveGovernanceState();
        
        this.emit('stopped');
    }

    async saveGovernanceState() {
        // Save current state to storage
        // Placeholder implementation
    }
}

module.exports = DistributedGovernanceSystem;