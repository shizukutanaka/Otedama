/**
 * Decentralized Governance System
 * Democratic decision-making for mining pool operations
 * 
 * Features:
 * - Token-based voting rights
 * - Proposal creation and management
 * - Multi-signature execution
 * - Timelock mechanisms
 * - Delegation support
 * - Quadratic voting
 * - Vote escrow for increased power
 * - Treasury management
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { ethers } = require('ethers');
const { MerkleTree } = require('merkletreejs');
const keccak256 = require('keccak256');
const { createLogger } = require('../core/logger');

const logger = createLogger('governance');

// Proposal types
const ProposalType = {
  PARAMETER_CHANGE: 'parameter_change',
  TREASURY_ALLOCATION: 'treasury_allocation',
  EMERGENCY_ACTION: 'emergency_action',
  CONSTITUTIONAL_AMENDMENT: 'constitutional_amendment',
  POOL_UPGRADE: 'pool_upgrade',
  FEE_ADJUSTMENT: 'fee_adjustment',
  NEW_FEATURE: 'new_feature',
  PARTNERSHIP: 'partnership'
};

// Proposal states
const ProposalState = {
  PENDING: 'pending',
  ACTIVE: 'active',
  CANCELED: 'canceled',
  DEFEATED: 'defeated',
  SUCCEEDED: 'succeeded',
  QUEUED: 'queued',
  EXPIRED: 'expired',
  EXECUTED: 'executed'
};

// Vote types
const VoteType = {
  FOR: 'for',
  AGAINST: 'against',
  ABSTAIN: 'abstain'
};

// Voting strategies
const VotingStrategy = {
  SIMPLE_MAJORITY: 'simple_majority',
  SUPER_MAJORITY: 'super_majority',
  QUADRATIC: 'quadratic',
  CONVICTION: 'conviction',
  RANKED_CHOICE: 'ranked_choice'
};

class GovernanceToken {
  constructor(config) {
    this.config = config;
    this.totalSupply = ethers.BigNumber.from(config.totalSupply || '1000000000000000000000000'); // 1M tokens
    this.balances = new Map();
    this.allowances = new Map();
    this.locked = new Map();
    this.delegations = new Map();
  }

  async mint(recipient, amount) {
    const currentBalance = this.balances.get(recipient) || ethers.BigNumber.from(0);
    this.balances.set(recipient, currentBalance.add(amount));
    this.totalSupply = this.totalSupply.add(amount);
    
    return {
      recipient,
      amount: amount.toString(),
      newBalance: this.balances.get(recipient).toString(),
      totalSupply: this.totalSupply.toString()
    };
  }

  async transfer(from, to, amount) {
    const senderBalance = this.balances.get(from) || ethers.BigNumber.from(0);
    
    if (senderBalance.lt(amount)) {
      throw new Error('Insufficient balance');
    }
    
    // Check if tokens are locked
    const lockedAmount = this.getLockedBalance(from);
    const availableBalance = senderBalance.sub(lockedAmount);
    
    if (availableBalance.lt(amount)) {
      throw new Error('Insufficient unlocked balance');
    }
    
    this.balances.set(from, senderBalance.sub(amount));
    const recipientBalance = this.balances.get(to) || ethers.BigNumber.from(0);
    this.balances.set(to, recipientBalance.add(amount));
    
    return {
      from,
      to,
      amount: amount.toString(),
      senderBalance: this.balances.get(from).toString(),
      recipientBalance: this.balances.get(to).toString()
    };
  }

  async lockTokens(holder, amount, unlockTime) {
    const balance = this.balances.get(holder) || ethers.BigNumber.from(0);
    
    if (balance.lt(amount)) {
      throw new Error('Insufficient balance to lock');
    }
    
    const lockData = {
      amount,
      unlockTime,
      lockedAt: Date.now()
    };
    
    if (!this.locked.has(holder)) {
      this.locked.set(holder, []);
    }
    
    this.locked.get(holder).push(lockData);
    
    return {
      holder,
      locked: amount.toString(),
      unlockTime,
      lockId: this.locked.get(holder).length - 1
    };
  }

  getLockedBalance(holder) {
    const locks = this.locked.get(holder) || [];
    const now = Date.now();
    
    return locks.reduce((total, lock) => {
      if (now < lock.unlockTime) {
        return total.add(lock.amount);
      }
      return total;
    }, ethers.BigNumber.from(0));
  }

  async delegate(delegator, delegatee) {
    const balance = this.balances.get(delegator) || ethers.BigNumber.from(0);
    
    if (balance.eq(0)) {
      throw new Error('No tokens to delegate');
    }
    
    this.delegations.set(delegator, delegatee);
    
    return {
      delegator,
      delegatee,
      delegatedAmount: balance.toString()
    };
  }

  getVotingPower(address) {
    // Get direct balance
    let votingPower = this.balances.get(address) || ethers.BigNumber.from(0);
    
    // Add delegated voting power
    for (const [delegator, delegatee] of this.delegations) {
      if (delegatee === address && delegator !== address) {
        votingPower = votingPower.add(
          this.balances.get(delegator) || ethers.BigNumber.from(0)
        );
      }
    }
    
    return votingPower;
  }

  getBalance(address) {
    return this.balances.get(address) || ethers.BigNumber.from(0);
  }

  getCirculatingSupply() {
    // Total supply minus locked tokens
    let lockedTotal = ethers.BigNumber.from(0);
    
    for (const [holder, locks] of this.locked) {
      const lockedAmount = this.getLockedBalance(holder);
      lockedTotal = lockedTotal.add(lockedAmount);
    }
    
    return this.totalSupply.sub(lockedTotal);
  }
}

class Proposal {
  constructor(params) {
    this.id = params.id || this.generateId();
    this.proposer = params.proposer;
    this.type = params.type;
    this.title = params.title;
    this.description = params.description;
    this.targets = params.targets || [];
    this.values = params.values || [];
    this.calldatas = params.calldatas || [];
    this.startBlock = params.startBlock;
    this.endBlock = params.endBlock;
    this.state = ProposalState.PENDING;
    this.createdAt = Date.now();
    
    // Voting data
    this.forVotes = ethers.BigNumber.from(0);
    this.againstVotes = ethers.BigNumber.from(0);
    this.abstainVotes = ethers.BigNumber.from(0);
    this.votes = new Map();
    this.voters = new Set();
    
    // Execution data
    this.eta = null; // Estimated time of arrival for timelock
    this.executionHash = null;
    this.executed = false;
  }

  generateId() {
    return crypto.randomBytes(16).toString('hex');
  }

  castVote(voter, voteType, votingPower, reason = '') {
    if (this.voters.has(voter)) {
      throw new Error('Already voted');
    }
    
    const vote = {
      voter,
      voteType,
      votingPower: ethers.BigNumber.from(votingPower),
      reason,
      timestamp: Date.now()
    };
    
    this.votes.set(voter, vote);
    this.voters.add(voter);
    
    // Update vote tallies
    switch (voteType) {
      case VoteType.FOR:
        this.forVotes = this.forVotes.add(votingPower);
        break;
      case VoteType.AGAINST:
        this.againstVotes = this.againstVotes.add(votingPower);
        break;
      case VoteType.ABSTAIN:
        this.abstainVotes = this.abstainVotes.add(votingPower);
        break;
    }
    
    return vote;
  }

  getVoteReceipt(voter) {
    return this.votes.get(voter) || null;
  }

  getTotalVotes() {
    return this.forVotes.add(this.againstVotes).add(this.abstainVotes);
  }

  getApprovalRate() {
    const totalVotes = this.getTotalVotes();
    if (totalVotes.eq(0)) return 0;
    
    return this.forVotes.mul(10000).div(totalVotes).toNumber() / 100;
  }

  isQuorumReached(quorumVotes) {
    return this.getTotalVotes().gte(quorumVotes);
  }

  updateState(newState) {
    const validTransitions = {
      [ProposalState.PENDING]: [ProposalState.ACTIVE, ProposalState.CANCELED],
      [ProposalState.ACTIVE]: [ProposalState.CANCELED, ProposalState.DEFEATED, ProposalState.SUCCEEDED],
      [ProposalState.SUCCEEDED]: [ProposalState.QUEUED, ProposalState.EXPIRED],
      [ProposalState.QUEUED]: [ProposalState.EXECUTED, ProposalState.EXPIRED],
      [ProposalState.DEFEATED]: [],
      [ProposalState.CANCELED]: [],
      [ProposalState.EXPIRED]: [],
      [ProposalState.EXECUTED]: []
    };
    
    const allowedTransitions = validTransitions[this.state] || [];
    
    if (!allowedTransitions.includes(newState)) {
      throw new Error(`Invalid state transition from ${this.state} to ${newState}`);
    }
    
    this.state = newState;
  }

  toJSON() {
    return {
      id: this.id,
      proposer: this.proposer,
      type: this.type,
      title: this.title,
      description: this.description,
      state: this.state,
      startBlock: this.startBlock,
      endBlock: this.endBlock,
      forVotes: this.forVotes.toString(),
      againstVotes: this.againstVotes.toString(),
      abstainVotes: this.abstainVotes.toString(),
      totalVotes: this.getTotalVotes().toString(),
      approvalRate: this.getApprovalRate(),
      voterCount: this.voters.size,
      createdAt: this.createdAt,
      executed: this.executed
    };
  }
}

class VotingStrategies {
  constructor(governanceToken) {
    this.governanceToken = governanceToken;
  }

  async calculateVotingPower(voter, strategy, options = {}) {
    switch (strategy) {
      case VotingStrategy.SIMPLE_MAJORITY:
        return this.simpleVotingPower(voter);
        
      case VotingStrategy.QUADRATIC:
        return this.quadraticVotingPower(voter);
        
      case VotingStrategy.CONVICTION:
        return this.convictionVotingPower(voter, options);
        
      default:
        return this.simpleVotingPower(voter);
    }
  }

  async simpleVotingPower(voter) {
    return this.governanceToken.getVotingPower(voter);
  }

  async quadraticVotingPower(voter) {
    const linearPower = await this.simpleVotingPower(voter);
    
    // Square root of token balance for quadratic voting
    const sqrtPower = ethers.BigNumber.from(
      Math.floor(Math.sqrt(linearPower.toNumber()))
    );
    
    return sqrtPower.mul('1000000000000000000'); // Scale back up
  }

  async convictionVotingPower(voter, options) {
    const basePower = await this.simpleVotingPower(voter);
    const lockDuration = options.lockDuration || 0;
    
    // Increase voting power based on lock duration
    // Each month of lock adds 10% voting power, max 2.5x
    const monthsLocked = Math.floor(lockDuration / (30 * 24 * 60 * 60 * 1000));
    const multiplier = Math.min(100 + (monthsLocked * 10), 250);
    
    return basePower.mul(multiplier).div(100);
  }

  async checkVotingEligibility(voter, proposal, strategy) {
    const votingPower = await this.calculateVotingPower(voter, strategy);
    
    // Check minimum voting power
    if (votingPower.eq(0)) {
      return { eligible: false, reason: 'No voting power' };
    }
    
    // Check if already voted
    if (proposal.voters.has(voter)) {
      return { eligible: false, reason: 'Already voted' };
    }
    
    // Check if proposal is active
    if (proposal.state !== ProposalState.ACTIVE) {
      return { eligible: false, reason: 'Proposal not active' };
    }
    
    return { eligible: true, votingPower };
  }
}

class Timelock {
  constructor(config) {
    this.config = config;
    this.minDelay = config.minDelay || 172800; // 2 days
    this.maxDelay = config.maxDelay || 2592000; // 30 days
    this.gracePeriod = config.gracePeriod || 1209600; // 14 days
    this.queuedTransactions = new Map();
  }

  async queueTransaction(target, value, signature, data, eta) {
    // Validate ETA
    const now = Math.floor(Date.now() / 1000);
    if (eta < now + this.minDelay) {
      throw new Error('ETA must satisfy minimum delay');
    }
    
    if (eta > now + this.maxDelay) {
      throw new Error('ETA must satisfy maximum delay');
    }
    
    const txHash = this.getTransactionHash(target, value, signature, data, eta);
    
    this.queuedTransactions.set(txHash, {
      target,
      value,
      signature,
      data,
      eta,
      queuedAt: now,
      executed: false
    });
    
    return {
      txHash,
      eta,
      queuedAt: now
    };
  }

  async executeTransaction(target, value, signature, data, eta) {
    const txHash = this.getTransactionHash(target, value, signature, data, eta);
    const queuedTx = this.queuedTransactions.get(txHash);
    
    if (!queuedTx) {
      throw new Error('Transaction not queued');
    }
    
    const now = Math.floor(Date.now() / 1000);
    
    if (now < eta) {
      throw new Error('Transaction not yet executable');
    }
    
    if (now > eta + this.gracePeriod) {
      throw new Error('Transaction grace period expired');
    }
    
    if (queuedTx.executed) {
      throw new Error('Transaction already executed');
    }
    
    // Mark as executed
    queuedTx.executed = true;
    queuedTx.executedAt = now;
    
    // In a real implementation, this would execute the actual transaction
    return {
      success: true,
      txHash,
      executedAt: now
    };
  }

  async cancelTransaction(target, value, signature, data, eta) {
    const txHash = this.getTransactionHash(target, value, signature, data, eta);
    
    if (!this.queuedTransactions.has(txHash)) {
      throw new Error('Transaction not found');
    }
    
    this.queuedTransactions.delete(txHash);
    
    return {
      canceled: true,
      txHash
    };
  }

  getTransactionHash(target, value, signature, data, eta) {
    return ethers.utils.solidityKeccak256(
      ['address', 'uint256', 'string', 'bytes', 'uint256'],
      [target, value, signature, data, eta]
    );
  }

  getQueuedTransaction(txHash) {
    return this.queuedTransactions.get(txHash) || null;
  }

  getPendingTransactions() {
    const pending = [];
    const now = Math.floor(Date.now() / 1000);
    
    for (const [txHash, tx] of this.queuedTransactions) {
      if (!tx.executed && now < tx.eta + this.gracePeriod) {
        pending.push({
          txHash,
          ...tx,
          timeUntilExecutable: Math.max(0, tx.eta - now)
        });
      }
    }
    
    return pending;
  }
}

class Treasury {
  constructor(config) {
    this.config = config;
    this.balances = new Map();
    this.allocations = [];
    this.spendingLimit = config.spendingLimit || '1000000000000000000000'; // 1000 tokens
    this.spentThisPeriod = ethers.BigNumber.from(0);
    this.periodStart = Date.now();
    this.periodDuration = config.periodDuration || 2592000000; // 30 days
  }

  async deposit(token, amount) {
    const currentBalance = this.balances.get(token) || ethers.BigNumber.from(0);
    this.balances.set(token, currentBalance.add(amount));
    
    return {
      token,
      deposited: amount.toString(),
      newBalance: this.balances.get(token).toString()
    };
  }

  async allocate(recipient, token, amount, reason) {
    const balance = this.balances.get(token) || ethers.BigNumber.from(0);
    
    if (balance.lt(amount)) {
      throw new Error('Insufficient treasury balance');
    }
    
    // Check spending limit
    this.checkPeriodReset();
    
    if (this.spentThisPeriod.add(amount).gt(this.spendingLimit)) {
      throw new Error('Exceeds spending limit for period');
    }
    
    const allocation = {
      id: this.generateAllocationId(),
      recipient,
      token,
      amount,
      reason,
      timestamp: Date.now(),
      executed: false
    };
    
    this.allocations.push(allocation);
    
    return allocation;
  }

  async executeAllocation(allocationId) {
    const allocation = this.allocations.find(a => a.id === allocationId);
    
    if (!allocation) {
      throw new Error('Allocation not found');
    }
    
    if (allocation.executed) {
      throw new Error('Allocation already executed');
    }
    
    const balance = this.balances.get(allocation.token) || ethers.BigNumber.from(0);
    
    if (balance.lt(allocation.amount)) {
      throw new Error('Insufficient balance');
    }
    
    // Update balance
    this.balances.set(
      allocation.token,
      balance.sub(allocation.amount)
    );
    
    // Update spending
    this.spentThisPeriod = this.spentThisPeriod.add(allocation.amount);
    
    // Mark as executed
    allocation.executed = true;
    allocation.executedAt = Date.now();
    
    return allocation;
  }

  checkPeriodReset() {
    const now = Date.now();
    if (now - this.periodStart > this.periodDuration) {
      this.periodStart = now;
      this.spentThisPeriod = ethers.BigNumber.from(0);
    }
  }

  generateAllocationId() {
    return 'alloc_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
  }

  getBalance(token) {
    return this.balances.get(token) || ethers.BigNumber.from(0);
  }

  getStats() {
    this.checkPeriodReset();
    
    return {
      totalValue: this.getTotalValue(),
      spentThisPeriod: this.spentThisPeriod.toString(),
      remainingLimit: ethers.BigNumber.from(this.spendingLimit)
        .sub(this.spentThisPeriod)
        .toString(),
      periodEnds: this.periodStart + this.periodDuration,
      allocations: this.allocations.length,
      pendingAllocations: this.allocations.filter(a => !a.executed).length
    };
  }

  getTotalValue() {
    // Simplified - in reality would use price oracles
    let total = ethers.BigNumber.from(0);
    for (const balance of this.balances.values()) {
      total = total.add(balance);
    }
    return total.toString();
  }
}

class ProposalValidator {
  constructor(config) {
    this.config = config;
    this.requiredFields = {
      [ProposalType.PARAMETER_CHANGE]: ['parameter', 'oldValue', 'newValue'],
      [ProposalType.TREASURY_ALLOCATION]: ['recipient', 'amount', 'token', 'reason'],
      [ProposalType.EMERGENCY_ACTION]: ['action', 'target', 'justification'],
      [ProposalType.POOL_UPGRADE]: ['upgradeContract', 'implementation', 'migrationPlan']
    };
  }

  async validateProposal(proposal, proposer, governanceToken) {
    const errors = [];
    
    // Check proposer has sufficient tokens
    const proposerBalance = governanceToken.getBalance(proposer);
    const minProposalThreshold = ethers.BigNumber.from(
      this.config.minProposalThreshold || '1000000000000000000' // 1 token
    );
    
    if (proposerBalance.lt(minProposalThreshold)) {
      errors.push('Insufficient token balance to create proposal');
    }
    
    // Validate required fields
    const requiredFields = this.requiredFields[proposal.type] || [];
    for (const field of requiredFields) {
      if (!proposal[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }
    
    // Validate proposal timing
    if (proposal.startBlock <= 0) {
      errors.push('Invalid start block');
    }
    
    if (proposal.endBlock <= proposal.startBlock) {
      errors.push('End block must be after start block');
    }
    
    const votingPeriod = proposal.endBlock - proposal.startBlock;
    const minVotingPeriod = this.config.minVotingPeriod || 17280; // ~3 days
    const maxVotingPeriod = this.config.maxVotingPeriod || 100800; // ~2 weeks
    
    if (votingPeriod < minVotingPeriod) {
      errors.push('Voting period too short');
    }
    
    if (votingPeriod > maxVotingPeriod) {
      errors.push('Voting period too long');
    }
    
    // Validate execution parameters
    if (proposal.targets.length !== proposal.values.length ||
        proposal.targets.length !== proposal.calldatas.length) {
      errors.push('Mismatched execution parameters');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
}

class GovernanceAnalytics {
  constructor() {
    this.proposalMetrics = new Map();
    this.voterMetrics = new Map();
    this.participationHistory = [];
  }

  recordProposal(proposal) {
    const metrics = {
      id: proposal.id,
      type: proposal.type,
      created: proposal.createdAt,
      totalVotes: proposal.getTotalVotes().toString(),
      approvalRate: proposal.getApprovalRate(),
      voterCount: proposal.voters.size,
      outcome: proposal.state
    };
    
    this.proposalMetrics.set(proposal.id, metrics);
    
    // Update type statistics
    this.updateTypeStats(proposal.type, metrics);
  }

  recordVote(voter, proposal, vote) {
    if (!this.voterMetrics.has(voter)) {
      this.voterMetrics.set(voter, {
        totalVotes: 0,
        proposalsVoted: new Set(),
        votingPower: ethers.BigNumber.from(0),
        participationRate: 0
      });
    }
    
    const metrics = this.voterMetrics.get(voter);
    metrics.totalVotes++;
    metrics.proposalsVoted.add(proposal.id);
    metrics.votingPower = metrics.votingPower.add(vote.votingPower);
    
    // Update participation history
    this.participationHistory.push({
      timestamp: Date.now(),
      voter,
      proposalId: proposal.id,
      voteType: vote.voteType,
      votingPower: vote.votingPower.toString()
    });
  }

  updateTypeStats(type, metrics) {
    // Aggregate statistics by proposal type
    // Implementation would track success rates, average participation, etc.
  }

  getGovernanceHealth() {
    const totalProposals = this.proposalMetrics.size;
    const activeVoters = this.voterMetrics.size;
    
    // Calculate average participation
    let totalParticipation = 0;
    for (const metrics of this.proposalMetrics.values()) {
      totalParticipation += metrics.voterCount;
    }
    const avgParticipation = totalProposals > 0 ? 
      totalParticipation / totalProposals : 0;
    
    // Calculate proposal success rate
    let successfulProposals = 0;
    for (const metrics of this.proposalMetrics.values()) {
      if (metrics.outcome === ProposalState.EXECUTED) {
        successfulProposals++;
      }
    }
    const successRate = totalProposals > 0 ?
      (successfulProposals / totalProposals) * 100 : 0;
    
    return {
      totalProposals,
      activeVoters,
      avgParticipation,
      successRate,
      recentActivity: this.getRecentActivity()
    };
  }

  getRecentActivity() {
    const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    return this.participationHistory.filter(p => p.timestamp > oneWeekAgo).length;
  }

  getVoterProfile(voter) {
    const metrics = this.voterMetrics.get(voter);
    if (!metrics) return null;
    
    return {
      ...metrics,
      proposalsVoted: metrics.proposalsVoted.size,
      avgVotingPower: metrics.votingPower.div(metrics.totalVotes).toString()
    };
  }
}

class DecentralizedGovernance extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      name: options.name || 'Otedama Governance',
      symbol: options.symbol || 'OTE-GOV',
      votingDelay: options.votingDelay || 1, // 1 block
      votingPeriod: options.votingPeriod || 17280, // ~3 days
      proposalThreshold: options.proposalThreshold || '1000000000000000000', // 1 token
      quorumNumerator: options.quorumNumerator || 4, // 4%
      votingStrategy: options.votingStrategy || VotingStrategy.SIMPLE_MAJORITY,
      ...options
    };
    
    // Core components
    this.governanceToken = new GovernanceToken(this.config);
    this.proposals = new Map();
    this.timelock = new Timelock(this.config);
    this.treasury = new Treasury(this.config);
    this.votingStrategies = new VotingStrategies(this.governanceToken);
    this.proposalValidator = new ProposalValidator(this.config);
    this.analytics = new GovernanceAnalytics();
    
    // Governance state
    this.currentBlock = 0;
    this.proposalCount = 0;
    
    this.stats = {
      totalProposals: 0,
      activeProposals: 0,
      executedProposals: 0,
      totalVoters: 0,
      totalVotesCast: 0
    };
    
    this.initialize();
  }

  initialize() {
    // Start block progression simulation
    this.blockInterval = setInterval(() => {
      this.currentBlock++;
      this.updateProposalStates();
    }, 12000); // ~12 second blocks
    
    logger.info('Decentralized governance initialized', {
      name: this.config.name,
      votingStrategy: this.config.votingStrategy
    });
  }

  async createProposal(proposer, proposalData) {
    // Validate proposal
    const validation = await this.proposalValidator.validateProposal(
      proposalData,
      proposer,
      this.governanceToken
    );
    
    if (!validation.valid) {
      throw new Error(`Invalid proposal: ${validation.errors.join(', ')}`);
    }
    
    // Create proposal
    const proposal = new Proposal({
      ...proposalData,
      proposer,
      startBlock: this.currentBlock + this.config.votingDelay,
      endBlock: this.currentBlock + this.config.votingDelay + this.config.votingPeriod
    });
    
    this.proposals.set(proposal.id, proposal);
    this.proposalCount++;
    this.stats.totalProposals++;
    
    this.emit('proposal:created', {
      proposalId: proposal.id,
      proposer,
      title: proposal.title
    });
    
    return proposal;
  }

  async castVote(proposalId, voter, voteType, reason = '') {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error('Proposal not found');
    }
    
    // Check voting eligibility
    const eligibility = await this.votingStrategies.checkVotingEligibility(
      voter,
      proposal,
      this.config.votingStrategy
    );
    
    if (!eligibility.eligible) {
      throw new Error(eligibility.reason);
    }
    
    // Cast vote
    const vote = proposal.castVote(
      voter,
      voteType,
      eligibility.votingPower,
      reason
    );
    
    this.stats.totalVotesCast++;
    
    // Record analytics
    this.analytics.recordVote(voter, proposal, vote);
    
    this.emit('vote:cast', {
      proposalId,
      voter,
      voteType,
      votingPower: vote.votingPower.toString()
    });
    
    return {
      proposalId,
      vote,
      currentTally: {
        forVotes: proposal.forVotes.toString(),
        againstVotes: proposal.againstVotes.toString(),
        abstainVotes: proposal.abstainVotes.toString()
      }
    };
  }

  async queueProposal(proposalId) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error('Proposal not found');
    }
    
    if (proposal.state !== ProposalState.SUCCEEDED) {
      throw new Error('Proposal must be in succeeded state');
    }
    
    // Queue in timelock
    const eta = Math.floor(Date.now() / 1000) + this.timelock.minDelay;
    
    for (let i = 0; i < proposal.targets.length; i++) {
      await this.timelock.queueTransaction(
        proposal.targets[i],
        proposal.values[i],
        '', // signature
        proposal.calldatas[i],
        eta
      );
    }
    
    proposal.eta = eta;
    proposal.updateState(ProposalState.QUEUED);
    
    this.emit('proposal:queued', {
      proposalId,
      eta
    });
    
    return {
      proposalId,
      eta,
      executeAfter: new Date(eta * 1000).toISOString()
    };
  }

  async executeProposal(proposalId) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error('Proposal not found');
    }
    
    if (proposal.state !== ProposalState.QUEUED) {
      throw new Error('Proposal must be queued');
    }
    
    // Execute through timelock
    for (let i = 0; i < proposal.targets.length; i++) {
      await this.timelock.executeTransaction(
        proposal.targets[i],
        proposal.values[i],
        '', // signature
        proposal.calldatas[i],
        proposal.eta
      );
    }
    
    proposal.executed = true;
    proposal.updateState(ProposalState.EXECUTED);
    
    this.stats.executedProposals++;
    
    // Record analytics
    this.analytics.recordProposal(proposal);
    
    this.emit('proposal:executed', {
      proposalId,
      executedAt: Date.now()
    });
    
    return {
      proposalId,
      executed: true
    };
  }

  async delegate(delegator, delegatee) {
    const result = await this.governanceToken.delegate(delegator, delegatee);
    
    this.emit('delegation:changed', result);
    
    return result;
  }

  async lockTokensForVoting(holder, amount, duration) {
    const unlockTime = Date.now() + duration;
    const result = await this.governanceToken.lockTokens(holder, amount, unlockTime);
    
    this.emit('tokens:locked', result);
    
    return result;
  }

  updateProposalStates() {
    for (const proposal of this.proposals.values()) {
      if (proposal.state === ProposalState.PENDING && 
          this.currentBlock >= proposal.startBlock) {
        proposal.updateState(ProposalState.ACTIVE);
        this.stats.activeProposals++;
        
        this.emit('proposal:active', {
          proposalId: proposal.id
        });
      }
      
      if (proposal.state === ProposalState.ACTIVE &&
          this.currentBlock > proposal.endBlock) {
        // Determine outcome
        const quorumVotes = this.calculateQuorum();
        
        if (proposal.isQuorumReached(quorumVotes) &&
            proposal.forVotes.gt(proposal.againstVotes)) {
          proposal.updateState(ProposalState.SUCCEEDED);
          
          this.emit('proposal:succeeded', {
            proposalId: proposal.id,
            forVotes: proposal.forVotes.toString(),
            againstVotes: proposal.againstVotes.toString()
          });
        } else {
          proposal.updateState(ProposalState.DEFEATED);
          
          this.emit('proposal:defeated', {
            proposalId: proposal.id,
            reason: !proposal.isQuorumReached(quorumVotes) ? 
              'Quorum not reached' : 'Insufficient support'
          });
        }
        
        this.stats.activeProposals--;
        this.analytics.recordProposal(proposal);
      }
      
      // Check for expired proposals
      if (proposal.state === ProposalState.QUEUED && proposal.eta) {
        const now = Math.floor(Date.now() / 1000);
        if (now > proposal.eta + this.timelock.gracePeriod) {
          proposal.updateState(ProposalState.EXPIRED);
          
          this.emit('proposal:expired', {
            proposalId: proposal.id
          });
        }
      }
    }
  }

  calculateQuorum() {
    const totalSupply = this.governanceToken.totalSupply;
    return totalSupply.mul(this.config.quorumNumerator).div(100);
  }

  getProposal(proposalId) {
    return this.proposals.get(proposalId);
  }

  getActiveProposals() {
    return Array.from(this.proposals.values())
      .filter(p => p.state === ProposalState.ACTIVE);
  }

  getProposalHistory(filter = {}) {
    let proposals = Array.from(this.proposals.values());
    
    if (filter.proposer) {
      proposals = proposals.filter(p => p.proposer === filter.proposer);
    }
    
    if (filter.state) {
      proposals = proposals.filter(p => p.state === filter.state);
    }
    
    if (filter.type) {
      proposals = proposals.filter(p => p.type === filter.type);
    }
    
    return proposals.map(p => p.toJSON());
  }

  async allocateTreasuryFunds(recipient, token, amount, reason) {
    const allocation = await this.treasury.allocate(
      recipient,
      token,
      ethers.BigNumber.from(amount),
      reason
    );
    
    this.emit('treasury:allocated', allocation);
    
    return allocation;
  }

  getGovernanceStats() {
    return {
      ...this.stats,
      currentBlock: this.currentBlock,
      proposalCount: this.proposalCount,
      treasuryStats: this.treasury.getStats(),
      governanceHealth: this.analytics.getGovernanceHealth(),
      activeVoters: this.analytics.voterMetrics.size,
      tokenSupply: {
        total: this.governanceToken.totalSupply.toString(),
        circulating: this.governanceToken.getCirculatingSupply().toString()
      }
    };
  }

  async cleanup() {
    if (this.blockInterval) {
      clearInterval(this.blockInterval);
    }
    
    this.removeAllListeners();
    logger.info('Governance system cleaned up');
  }
}

module.exports = {
  DecentralizedGovernance,
  ProposalType,
  ProposalState,
  VoteType,
  VotingStrategy,
  GovernanceToken,
  Proposal,
  VotingStrategies,
  Timelock,
  Treasury,
  ProposalValidator,
  GovernanceAnalytics
};