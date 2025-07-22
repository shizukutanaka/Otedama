/**
 * Governance Token & DAO System
 * Decentralized governance with token-based voting and treasury management
 */

import { EventEmitter } from 'events';
import { BigNumber, ethers } from 'ethers';
import { getLogger } from '../logger.js';

const logger = getLogger('GovernanceDAO');

// Proposal types
export const ProposalType = {
  PARAMETER_CHANGE: 'parameter_change',
  TREASURY_SPEND: 'treasury_spend',
  PROTOCOL_UPGRADE: 'protocol_upgrade',
  EMERGENCY_ACTION: 'emergency_action',
  GRANT_FUNDING: 'grant_funding',
  PARTNERSHIP: 'partnership',
  CUSTOM: 'custom'
};

// Proposal status
export const ProposalStatus = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  SUCCEEDED: 'succeeded',
  DEFEATED: 'defeated',
  EXECUTED: 'executed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired'
};

// Vote types
export const VoteType = {
  FOR: 'for',
  AGAINST: 'against',
  ABSTAIN: 'abstain'
};

// Delegation types
export const DelegationType = {
  FULL: 'full',
  PARTIAL: 'partial',
  TOPIC_BASED: 'topic_based'
};

export class GovernanceDAO extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || logger;
    this.options = {
      governanceToken: options.governanceToken || 'GOV',
      votingDelay: options.votingDelay || 86400000, // 24 hours
      votingPeriod: options.votingPeriod || 604800000, // 7 days
      proposalThreshold: options.proposalThreshold || BigNumber.from('100000000000000000000000'), // 100k tokens
      quorumThreshold: options.quorumThreshold || 0.04, // 4% of total supply
      timelock: options.timelock || 172800000, // 48 hours
      emergencyTimelock: options.emergencyTimelock || 86400000, // 24 hours
      maxProposalsPerUser: options.maxProposalsPerUser || 3,
      delegationEnabled: options.delegationEnabled !== false,
      ...options
    };
    
    // Governance token
    this.tokenSupply = {
      total: BigNumber.from('1000000000000000000000000000'), // 1B tokens
      circulating: BigNumber.from('400000000000000000000000000'), // 400M tokens
      locked: BigNumber.from('600000000000000000000000000'), // 600M tokens
      staked: BigNumber.from(0)
    };
    
    // Token holders and balances
    this.tokenHolders = new Map();
    this.votingPower = new Map();
    this.stakingPositions = new Map();
    
    // Proposals
    this.proposals = new Map();
    this.proposalCounter = 0;
    this.activeProposals = new Set();
    
    // Voting
    this.votes = new Map();
    this.userVotes = new Map();
    this.votingHistory = [];
    
    // Delegation
    this.delegations = new Map();
    this.delegatedVotes = new Map();
    
    // Treasury
    this.treasury = new TreasuryManager(this.options);
    
    // Timelock
    this.timelock = new TimelockController(this.options);
    
    // Committees
    this.committees = new Map();
    this.committeeMembers = new Map();
    
    // Statistics
    this.stats = {
      totalProposals: 0,
      activeProposals: 0,
      executedProposals: 0,
      totalVotes: 0,
      totalVoters: 0,
      averageParticipation: 0,
      treasuryBalance: BigNumber.from(0),
      totalDelegated: BigNumber.from(0)
    };
    
    // Initialize governance
    this.initializeGovernance();
    
    // Start background processes
    this.startProposalProcessing();
    this.startVotingProcessing();
    this.startDelegationProcessing();
    this.startStatisticsUpdate();
  }
  
  /**
   * Initialize governance system
   */
  initializeGovernance() {
    // Create initial committees
    this.createCommittee('Security', 'Handles security-related proposals', 7);
    this.createCommittee('Treasury', 'Manages treasury spending proposals', 5);
    this.createCommittee('Technical', 'Reviews technical upgrade proposals', 9);
    this.createCommittee('Grants', 'Evaluates grant funding requests', 5);
    
    // Initialize treasury
    this.treasury.initialize();
    
    this.logger.info('Governance system initialized');
  }
  
  /**
   * Create committee
   */
  createCommittee(name, description, maxMembers) {
    const committeeId = this.generateCommitteeId(name);
    
    const committee = {
      id: committeeId,
      name,
      description,
      maxMembers,
      members: new Set(),
      proposalTypes: [],
      votingWeight: 1.0,
      active: true,
      createdAt: Date.now()
    };
    
    this.committees.set(committeeId, committee);
    
    this.emit('committee:created', { committeeId, name, description });
    return committee;
  }
  
  /**
   * Distribute governance tokens
   */
  async distributeTokens(recipient, amount, vestingSchedule = null) {
    const tokenAmount = BigNumber.from(amount);
    
    // Validate distribution
    if (tokenAmount.gt(this.tokenSupply.total.sub(this.tokenSupply.circulating))) {
      throw new Error('Insufficient tokens available for distribution');
    }
    
    // Update token holdings
    const currentBalance = this.tokenHolders.get(recipient) || BigNumber.from(0);
    this.tokenHolders.set(recipient, currentBalance.add(tokenAmount));
    
    // Update voting power
    this.updateVotingPower(recipient);
    
    // Update circulating supply
    this.tokenSupply.circulating = this.tokenSupply.circulating.add(tokenAmount);
    
    // Handle vesting if specified
    if (vestingSchedule) {
      await this.createVestingSchedule(recipient, tokenAmount, vestingSchedule);
    }
    
    this.emit('tokens:distributed', {
      recipient,
      amount: tokenAmount,
      vestingSchedule,
      newBalance: this.tokenHolders.get(recipient)
    });
    
    return this.tokenHolders.get(recipient);
  }
  
  /**
   * Stake tokens for enhanced voting power
   */
  async stakeTokens(staker, amount, lockPeriod = 2629746000) { // 1 month default
    const stakeAmount = BigNumber.from(amount);
    const userBalance = this.tokenHolders.get(staker) || BigNumber.from(0);
    
    if (stakeAmount.gt(userBalance)) {
      throw new Error('Insufficient token balance');
    }
    
    const stakingId = this.generateStakingId(staker);
    const unlockTime = Date.now() + lockPeriod;
    
    // Calculate staking multiplier based on lock period
    const multiplier = this.calculateStakingMultiplier(lockPeriod);
    
    const stakingPosition = {
      id: stakingId,
      staker,
      amount: stakeAmount,
      lockPeriod,
      unlockTime,
      multiplier,
      votingPower: stakeAmount.mul(Math.floor(multiplier * 100)).div(100),
      createdAt: Date.now(),
      active: true
    };
    
    this.stakingPositions.set(stakingId, stakingPosition);
    
    // Update balances
    this.tokenHolders.set(staker, userBalance.sub(stakeAmount));
    this.tokenSupply.staked = this.tokenSupply.staked.add(stakeAmount);
    
    // Update voting power
    this.updateVotingPower(staker);
    
    this.emit('tokens:staked', {
      staker,
      amount: stakeAmount,
      lockPeriod,
      multiplier,
      votingPower: stakingPosition.votingPower
    });
    
    return stakingPosition;
  }
  
  /**
   * Unstake tokens
   */
  async unstakeTokens(stakingId, staker) {
    const stakingPosition = this.stakingPositions.get(stakingId);
    
    if (!stakingPosition || stakingPosition.staker !== staker) {
      throw new Error('Staking position not found');
    }
    
    if (!stakingPosition.active) {
      throw new Error('Staking position already closed');
    }
    
    if (Date.now() < stakingPosition.unlockTime) {
      throw new Error('Tokens are still locked');
    }
    
    // Return tokens to user
    const currentBalance = this.tokenHolders.get(staker) || BigNumber.from(0);
    this.tokenHolders.set(staker, currentBalance.add(stakingPosition.amount));
    
    // Update supply
    this.tokenSupply.staked = this.tokenSupply.staked.sub(stakingPosition.amount);
    
    // Close staking position
    stakingPosition.active = false;
    stakingPosition.unstakedAt = Date.now();
    
    // Update voting power
    this.updateVotingPower(staker);
    
    this.emit('tokens:unstaked', {
      staker,
      amount: stakingPosition.amount,
      stakingId
    });
    
    return stakingPosition.amount;
  }
  
  /**
   * Create governance proposal
   */
  async createProposal(proposer, type, title, description, actions, options = {}) {
    // Validate proposer has sufficient tokens
    const proposerBalance = this.getVotingPower(proposer);
    if (proposerBalance.lt(this.options.proposalThreshold)) {
      throw new Error('Insufficient tokens to create proposal');
    }
    
    // Check proposal limits
    const userProposals = Array.from(this.proposals.values())
      .filter(p => p.proposer === proposer && p.status === ProposalStatus.ACTIVE);
    
    if (userProposals.length >= this.options.maxProposalsPerUser) {
      throw new Error('Maximum active proposals limit reached');
    }
    
    const proposalId = ++this.proposalCounter;
    const startTime = Date.now() + this.options.votingDelay;
    const endTime = startTime + this.options.votingPeriod;
    
    const proposal = {
      id: proposalId,
      proposer,
      type,
      title,
      description,
      actions,
      
      // Voting parameters
      startTime,
      endTime,
      quorumThreshold: this.options.quorumThreshold,
      
      // Vote counts
      votesFor: BigNumber.from(0),
      votesAgainst: BigNumber.from(0),
      votesAbstain: BigNumber.from(0),
      totalVotes: BigNumber.from(0),
      
      // Status
      status: ProposalStatus.DRAFT,
      
      // Committee assignment
      assignedCommittee: options.committee || this.getAppropriateCommittee(type),
      
      // Emergency flag
      isEmergency: options.emergency === true,
      
      // Metadata
      tags: options.tags || [],
      discussionUrl: options.discussionUrl || '',
      
      // Timestamps
      createdAt: Date.now(),
      activatedAt: null,
      executedAt: null,
      
      // Execution
      executed: false,
      executionResult: null
    };
    
    this.proposals.set(proposalId, proposal);
    
    // Schedule activation
    setTimeout(() => {
      this.activateProposal(proposalId);
    }, this.options.votingDelay);
    
    this.stats.totalProposals++;
    
    this.emit('proposal:created', {
      proposalId,
      proposer,
      type,
      title,
      startTime,
      endTime,
      isEmergency: proposal.isEmergency
    });
    
    return proposal;
  }
  
  /**
   * Activate proposal for voting
   */
  activateProposal(proposalId) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== ProposalStatus.DRAFT) {
      return;
    }
    
    proposal.status = ProposalStatus.ACTIVE;
    proposal.activatedAt = Date.now();
    
    this.activeProposals.add(proposalId);
    this.stats.activeProposals++;
    
    this.emit('proposal:activated', {
      proposalId,
      title: proposal.title,
      endTime: proposal.endTime
    });
    
    // Schedule voting end
    setTimeout(() => {
      this.endVoting(proposalId);
    }, this.options.votingPeriod);
  }
  
  /**
   * Cast vote on proposal
   */
  async castVote(proposalId, voter, voteType, reason = '') {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error('Proposal not found');
    }
    
    if (proposal.status !== ProposalStatus.ACTIVE) {
      throw new Error('Proposal not active for voting');
    }
    
    const now = Date.now();
    if (now < proposal.startTime || now > proposal.endTime) {
      throw new Error('Voting period not active');
    }
    
    // Check if user already voted
    const existingVote = this.votes.get(`${proposalId}-${voter}`);
    if (existingVote) {
      throw new Error('User has already voted on this proposal');
    }
    
    // Calculate voting power
    const votingPower = this.getVotingPower(voter);
    if (votingPower.isZero()) {
      throw new Error('No voting power');
    }
    
    // Create vote record
    const vote = {
      proposalId,
      voter,
      voteType,
      votingPower,
      reason,
      timestamp: now,
      delegated: false
    };
    
    this.votes.set(`${proposalId}-${voter}`, vote);
    
    // Update proposal vote counts
    switch (voteType) {
      case VoteType.FOR:
        proposal.votesFor = proposal.votesFor.add(votingPower);
        break;
      case VoteType.AGAINST:
        proposal.votesAgainst = proposal.votesAgainst.add(votingPower);
        break;
      case VoteType.ABSTAIN:
        proposal.votesAbstain = proposal.votesAbstain.add(votingPower);
        break;
    }
    
    proposal.totalVotes = proposal.totalVotes.add(votingPower);
    
    // Track user votes
    if (!this.userVotes.has(voter)) {
      this.userVotes.set(voter, []);
    }
    this.userVotes.get(voter).push(vote);
    
    // Add to voting history
    this.votingHistory.push(vote);
    
    this.stats.totalVotes++;
    
    this.emit('vote:cast', {
      proposalId,
      voter,
      voteType,
      votingPower,
      reason
    });
    
    return vote;
  }
  
  /**
   * End voting period
   */
  async endVoting(proposalId) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== ProposalStatus.ACTIVE) {
      return;
    }
    
    this.activeProposals.delete(proposalId);
    this.stats.activeProposals--;
    
    // Calculate results
    const totalSupply = this.tokenSupply.circulating.add(this.tokenSupply.staked);
    const quorumRequired = totalSupply.mul(Math.floor(proposal.quorumThreshold * 10000)).div(10000);
    
    const quorumReached = proposal.totalVotes.gte(quorumRequired);
    const majorityFor = proposal.votesFor.gt(proposal.votesAgainst);
    
    // Determine outcome
    if (quorumReached && majorityFor) {
      proposal.status = ProposalStatus.SUCCEEDED;
      
      // Schedule execution
      const executionDelay = proposal.isEmergency ? 
        this.options.emergencyTimelock : 
        this.options.timelock;
      
      setTimeout(() => {
        this.executeProposal(proposalId);
      }, executionDelay);
      
    } else {
      proposal.status = ProposalStatus.DEFEATED;
    }
    
    this.emit('voting:ended', {
      proposalId,
      status: proposal.status,
      votesFor: proposal.votesFor,
      votesAgainst: proposal.votesAgainst,
      votesAbstain: proposal.votesAbstain,
      totalVotes: proposal.totalVotes,
      quorumReached,
      majorityFor
    });
  }
  
  /**
   * Execute approved proposal
   */
  async executeProposal(proposalId) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== ProposalStatus.SUCCEEDED) {
      return;
    }
    
    try {
      // Execute proposal actions
      const results = [];
      
      for (const action of proposal.actions) {
        const result = await this.executeAction(action);
        results.push(result);
      }
      
      proposal.status = ProposalStatus.EXECUTED;
      proposal.executedAt = Date.now();
      proposal.executed = true;
      proposal.executionResult = results;
      
      this.stats.executedProposals++;
      
      this.emit('proposal:executed', {
        proposalId,
        title: proposal.title,
        results
      });
      
    } catch (error) {
      this.logger.error(`Proposal execution failed: ${error.message}`);
      
      this.emit('proposal:execution_failed', {
        proposalId,
        error: error.message
      });
    }
  }
  
  /**
   * Execute proposal action
   */
  async executeAction(action) {
    switch (action.type) {
      case 'parameter_change':
        return await this.executeParameterChange(action);
        
      case 'treasury_spend':
        return await this.executeTreasurySpend(action);
        
      case 'protocol_upgrade':
        return await this.executeProtocolUpgrade(action);
        
      case 'grant_funding':
        return await this.executeGrantFunding(action);
        
      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }
  
  /**
   * Delegate voting power
   */
  async delegateVotes(delegator, delegate, amount = null, options = {}) {
    const delegatorBalance = this.getVotingPower(delegator);
    
    if (delegatorBalance.isZero()) {
      throw new Error('No voting power to delegate');
    }
    
    const delegateAmount = amount || delegatorBalance;
    
    if (delegateAmount.gt(delegatorBalance)) {
      throw new Error('Insufficient voting power to delegate');
    }
    
    const delegationId = this.generateDelegationId(delegator, delegate);
    
    const delegation = {
      id: delegationId,
      delegator,
      delegate,
      amount: delegateAmount,
      type: options.type || DelegationType.FULL,
      topicFilter: options.topicFilter || [],
      startTime: Date.now(),
      endTime: options.endTime || null,
      active: true
    };
    
    this.delegations.set(delegationId, delegation);
    
    // Update delegated votes
    const currentDelegated = this.delegatedVotes.get(delegate) || BigNumber.from(0);
    this.delegatedVotes.set(delegate, currentDelegated.add(delegateAmount));
    
    // Update voting power
    this.updateVotingPower(delegator);
    this.updateVotingPower(delegate);
    
    this.stats.totalDelegated = this.stats.totalDelegated.add(delegateAmount);
    
    this.emit('votes:delegated', {
      delegationId,
      delegator,
      delegate,
      amount: delegateAmount,
      type: delegation.type
    });
    
    return delegation;
  }
  
  /**
   * Revoke delegation
   */
  async revokeDelegation(delegationId, delegator) {
    const delegation = this.delegations.get(delegationId);
    
    if (!delegation || delegation.delegator !== delegator) {
      throw new Error('Delegation not found');
    }
    
    if (!delegation.active) {
      throw new Error('Delegation already inactive');
    }
    
    delegation.active = false;
    delegation.revokedAt = Date.now();
    
    // Update delegated votes
    const currentDelegated = this.delegatedVotes.get(delegation.delegate) || BigNumber.from(0);
    this.delegatedVotes.set(delegation.delegate, currentDelegated.sub(delegation.amount));
    
    // Update voting power
    this.updateVotingPower(delegator);
    this.updateVotingPower(delegation.delegate);
    
    this.stats.totalDelegated = this.stats.totalDelegated.sub(delegation.amount);
    
    this.emit('delegation:revoked', {
      delegationId,
      delegator,
      delegate: delegation.delegate,
      amount: delegation.amount
    });
    
    return delegation;
  }
  
  /**
   * Calculate voting power for user
   */
  getVotingPower(user) {
    let votingPower = BigNumber.from(0);
    
    // Base token balance
    const tokenBalance = this.tokenHolders.get(user) || BigNumber.from(0);
    votingPower = votingPower.add(tokenBalance);
    
    // Staking bonus
    for (const [stakingId, position] of this.stakingPositions) {
      if (position.staker === user && position.active) {
        votingPower = votingPower.add(position.votingPower);
      }
    }
    
    // Delegated votes
    const delegatedVotes = this.delegatedVotes.get(user) || BigNumber.from(0);
    votingPower = votingPower.add(delegatedVotes);
    
    return votingPower;
  }
  
  /**
   * Update voting power cache
   */
  updateVotingPower(user) {
    const votingPower = this.getVotingPower(user);
    this.votingPower.set(user, votingPower);
  }
  
  /**
   * Calculate staking multiplier
   */
  calculateStakingMultiplier(lockPeriod) {
    const baseMultiplier = 1.0;
    const maxMultiplier = 2.5;
    const maxLockPeriod = 31556952000; // 1 year
    
    const multiplier = baseMultiplier + 
      (maxMultiplier - baseMultiplier) * 
      Math.min(lockPeriod / maxLockPeriod, 1);
    
    return multiplier;
  }
  
  /**
   * Get appropriate committee for proposal type
   */
  getAppropriateCommittee(proposalType) {
    const committeeMapping = {
      [ProposalType.PARAMETER_CHANGE]: 'Technical',
      [ProposalType.TREASURY_SPEND]: 'Treasury',
      [ProposalType.PROTOCOL_UPGRADE]: 'Technical',
      [ProposalType.EMERGENCY_ACTION]: 'Security',
      [ProposalType.GRANT_FUNDING]: 'Grants',
      [ProposalType.PARTNERSHIP]: 'Treasury'
    };
    
    return committeeMapping[proposalType] || 'Technical';
  }
  
  /**
   * Start proposal processing
   */
  startProposalProcessing() {
    setInterval(() => {
      this.processProposals();
    }, 60000); // Every minute
  }
  
  /**
   * Process proposals
   */
  processProposals() {
    const now = Date.now();
    
    // Check for expired proposals
    for (const [proposalId, proposal] of this.proposals) {
      if (proposal.status === ProposalStatus.ACTIVE && now > proposal.endTime) {
        this.endVoting(proposalId);
      }
    }
  }
  
  /**
   * Start voting processing
   */
  startVotingProcessing() {
    setInterval(() => {
      this.processVoting();
    }, 30000); // Every 30 seconds
  }
  
  /**
   * Process voting
   */
  processVoting() {
    // Update participation statistics
    const totalVoters = new Set(this.votingHistory.map(v => v.voter)).size;
    const totalHolders = this.tokenHolders.size;
    
    this.stats.totalVoters = totalVoters;
    this.stats.averageParticipation = totalHolders > 0 ? (totalVoters / totalHolders) * 100 : 0;
  }
  
  /**
   * Start delegation processing
   */
  startDelegationProcessing() {
    setInterval(() => {
      this.processDelegations();
    }, 300000); // Every 5 minutes
  }
  
  /**
   * Process delegations
   */
  processDelegations() {
    const now = Date.now();
    
    // Check for expired delegations
    for (const [delegationId, delegation] of this.delegations) {
      if (delegation.active && delegation.endTime && now > delegation.endTime) {
        this.revokeDelegation(delegationId, delegation.delegator);
      }
    }
  }
  
  /**
   * Start statistics updates
   */
  startStatisticsUpdate() {
    setInterval(() => {
      this.updateStatistics();
    }, 60000); // Every minute
  }
  
  /**
   * Update statistics
   */
  updateStatistics() {
    // Update treasury balance
    this.stats.treasuryBalance = this.treasury.getTotalBalance();
    
    // Update active proposals count
    this.stats.activeProposals = this.activeProposals.size;
  }
  
  /**
   * Helper methods
   */
  
  generateCommitteeId(name) {
    return `committee_${name.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`;
  }
  
  generateStakingId(staker) {
    return `stake_${staker}_${Date.now()}`;
  }
  
  generateDelegationId(delegator, delegate) {
    return `delegation_${delegator}_${delegate}_${Date.now()}`;
  }
  
  createVestingSchedule(recipient, amount, schedule) {
    // Implementation for vesting schedule
    return Promise.resolve();
  }
  
  // Action execution methods
  executeParameterChange(action) {
    this.logger.info(`Parameter change: ${action.parameter} = ${action.value}`);
    return Promise.resolve({ success: true, parameter: action.parameter, value: action.value });
  }
  
  executeTreasurySpend(action) {
    return this.treasury.spend(action.recipient, action.amount, action.reason);
  }
  
  executeProtocolUpgrade(action) {
    this.logger.info(`Protocol upgrade: ${action.target} to ${action.implementation}`);
    return Promise.resolve({ success: true, upgraded: true });
  }
  
  executeGrantFunding(action) {
    return this.treasury.allocateGrant(action.recipient, action.amount, action.milestones);
  }
  
  /**
   * Get proposal information
   */
  getProposal(proposalId) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return null;
    
    return {
      id: proposal.id,
      proposer: proposal.proposer,
      type: proposal.type,
      title: proposal.title,
      description: proposal.description,
      status: proposal.status,
      votesFor: proposal.votesFor,
      votesAgainst: proposal.votesAgainst,
      votesAbstain: proposal.votesAbstain,
      totalVotes: proposal.totalVotes,
      startTime: proposal.startTime,
      endTime: proposal.endTime,
      isEmergency: proposal.isEmergency,
      assignedCommittee: proposal.assignedCommittee,
      createdAt: proposal.createdAt,
      executed: proposal.executed
    };
  }
  
  /**
   * Get user governance statistics
   */
  getUserStats(user) {
    const tokenBalance = this.tokenHolders.get(user) || BigNumber.from(0);
    const votingPower = this.getVotingPower(user);
    const userVotes = this.userVotes.get(user) || [];
    
    // Calculate staking positions
    const stakingPositions = Array.from(this.stakingPositions.values())
      .filter(pos => pos.staker === user && pos.active);
    
    // Calculate delegations
    const delegationsOut = Array.from(this.delegations.values())
      .filter(del => del.delegator === user && del.active);
    
    const delegationsIn = Array.from(this.delegations.values())
      .filter(del => del.delegate === user && del.active);
    
    return {
      tokenBalance,
      votingPower,
      totalVotes: userVotes.length,
      stakingPositions: stakingPositions.length,
      totalStaked: stakingPositions.reduce((sum, pos) => sum.add(pos.amount), BigNumber.from(0)),
      delegationsOut: delegationsOut.length,
      delegationsIn: delegationsIn.length,
      totalDelegatedOut: delegationsOut.reduce((sum, del) => sum.add(del.amount), BigNumber.from(0)),
      totalDelegatedIn: delegationsIn.reduce((sum, del) => sum.add(del.amount), BigNumber.from(0))
    };
  }
  
  /**
   * Get global governance statistics
   */
  getGlobalStats() {
    return {
      ...this.stats,
      tokenSupply: this.tokenSupply,
      totalProposals: this.proposals.size,
      totalCommittees: this.committees.size,
      totalDelegations: this.delegations.size,
      totalStakers: Array.from(this.stakingPositions.values()).filter(pos => pos.active).length
    };
  }
  
  /**
   * Get active proposals
   */
  getActiveProposals() {
    return Array.from(this.proposals.values())
      .filter(proposal => proposal.status === ProposalStatus.ACTIVE)
      .map(proposal => this.getProposal(proposal.id));
  }
  
  /**
   * Get proposal voting results
   */
  getVotingResults(proposalId) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return null;
    
    const totalSupply = this.tokenSupply.circulating.add(this.tokenSupply.staked);
    const quorumRequired = totalSupply.mul(Math.floor(proposal.quorumThreshold * 10000)).div(10000);
    
    return {
      proposalId,
      votesFor: proposal.votesFor,
      votesAgainst: proposal.votesAgainst,
      votesAbstain: proposal.votesAbstain,
      totalVotes: proposal.totalVotes,
      quorumRequired,
      quorumReached: proposal.totalVotes.gte(quorumRequired),
      participationRate: totalSupply.gt(0) ? proposal.totalVotes.div(totalSupply).toNumber() : 0,
      status: proposal.status
    };
  }
}

/**
 * Treasury Manager
 */
class TreasuryManager {
  constructor(options = {}) {
    this.options = options;
    this.balances = new Map();
    this.transactions = [];
    this.grants = new Map();
    
    // Initialize with some assets
    this.balances.set('ETH', BigNumber.from('10000000000000000000000')); // 10k ETH
    this.balances.set('USDC', BigNumber.from('50000000000000')); // 50M USDC
  }
  
  initialize() {
    this.logger = logger;
    this.logger.info('Treasury initialized');
  }
  
  getTotalBalance() {
    // Calculate total balance in USD equivalent
    let totalBalance = BigNumber.from(0);
    
    for (const [token, balance] of this.balances) {
      const usdValue = this.convertToUSD(token, balance);
      totalBalance = totalBalance.add(usdValue);
    }
    
    return totalBalance;
  }
  
  async spend(recipient, amount, reason) {
    const spendAmount = BigNumber.from(amount);
    const ethBalance = this.balances.get('ETH') || BigNumber.from(0);
    
    if (spendAmount.gt(ethBalance)) {
      throw new Error('Insufficient treasury balance');
    }
    
    // Execute spend
    this.balances.set('ETH', ethBalance.sub(spendAmount));
    
    // Record transaction
    this.transactions.push({
      type: 'spend',
      recipient,
      amount: spendAmount,
      reason,
      timestamp: Date.now()
    });
    
    return { success: true, amount: spendAmount, recipient };
  }
  
  async allocateGrant(recipient, amount, milestones) {
    const grantAmount = BigNumber.from(amount);
    const grantId = `grant_${Date.now()}`;
    
    const grant = {
      id: grantId,
      recipient,
      totalAmount: grantAmount,
      remainingAmount: grantAmount,
      milestones,
      currentMilestone: 0,
      createdAt: Date.now(),
      active: true
    };
    
    this.grants.set(grantId, grant);
    
    return { success: true, grantId, amount: grantAmount };
  }
  
  convertToUSD(token, amount) {
    const prices = {
      'ETH': 2000,
      'USDC': 1
    };
    
    const price = prices[token] || 1;
    return amount.mul(price);
  }
}

/**
 * Timelock Controller
 */
class TimelockController {
  constructor(options = {}) {
    this.options = options;
    this.queue = new Map();
    this.executed = new Set();
  }
  
  schedule(actionId, executeAt) {
    this.queue.set(actionId, {
      actionId,
      executeAt,
      scheduled: true,
      executed: false
    });
  }
  
  execute(actionId) {
    const action = this.queue.get(actionId);
    if (!action) {
      throw new Error('Action not found');
    }
    
    if (Date.now() < action.executeAt) {
      throw new Error('Action not ready for execution');
    }
    
    action.executed = true;
    this.executed.add(actionId);
    
    return action;
  }
  
  cancel(actionId) {
    this.queue.delete(actionId);
  }
}