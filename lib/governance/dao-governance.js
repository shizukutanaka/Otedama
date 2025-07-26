/**
 * DAO Governance System - Otedama
 * Decentralized Autonomous Organization for mining pool governance
 * Features: proposal system, voting, treasury management, timelock
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import crypto from 'crypto';

const logger = createLogger('DAOGovernance');

/**
 * Proposal types
 */
export const ProposalType = {
  PARAMETER_CHANGE: 'parameter_change',    // Change pool parameters
  TREASURY_ALLOCATION: 'treasury_allocation', // Allocate treasury funds
  UPGRADE: 'upgrade',                      // Protocol upgrades
  EMERGENCY: 'emergency',                  // Emergency actions
  STRATEGY: 'strategy',                    // Mining strategy changes
  FEE_ADJUSTMENT: 'fee_adjustment'        // Fee structure changes
};

/**
 * Proposal status
 */
export const ProposalStatus = {
  PENDING: 'pending',
  ACTIVE: 'active',
  SUCCEEDED: 'succeeded',
  DEFEATED: 'defeated',
  QUEUED: 'queued',
  EXECUTED: 'executed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired'
};

/**
 * DAO Governance system
 */
export class DAOGovernance extends EventEmitter {
  constructor(pool, options = {}) {
    super();
    
    this.pool = pool;
    this.config = {
      tokenAddress: options.tokenAddress,
      quorumPercentage: options.quorumPercentage || 4, // 4% of total supply
      proposalThreshold: options.proposalThreshold || 0.1, // 0.1% to propose
      votingDelay: options.votingDelay || 86400000, // 1 day
      votingPeriod: options.votingPeriod || 259200000, // 3 days
      timelockDelay: options.timelockDelay || 172800000, // 2 days
      gracePeriod: options.gracePeriod || 86400000, // 1 day
      ...options
    };
    
    this.proposals = new Map();
    this.votes = new Map();
    this.delegates = new Map();
    this.treasury = {
      balance: {},
      allocated: {},
      pending: {}
    };
    this.timelock = new Map();
    
    this.stats = {
      totalProposals: 0,
      executedProposals: 0,
      totalVotes: 0,
      uniqueVoters: new Set(),
      treasuryValue: 0
    };
  }
  
  /**
   * Initialize DAO governance
   */
  async initialize() {
    logger.info('Initializing DAO governance...');
    
    // Initialize voting token tracking
    await this.initializeVotingPower();
    
    // Start governance cycles
    this.startGovernanceCycle();
    this.startTimelockProcessor();
    
    logger.info('DAO governance initialized');
    this.emit('initialized');
  }
  
  /**
   * Initialize voting power tracking
   */
  async initializeVotingPower() {
    // In production, would track actual token balances
    // Mock initialization with miner contributions
    const miners = this.pool.getConnectedMiners();
    
    for (const miner of miners) {
      const votingPower = this.calculateVotingPower(miner);
      this.delegates.set(miner.address || miner.id, {
        votingPower,
        delegatedTo: null,
        delegatedFrom: new Set(),
        lastUpdate: Date.now()
      });
    }
  }
  
  /**
   * Create proposal
   */
  async createProposal(params) {
    const {
      proposer,
      type,
      title,
      description,
      actions,
      metadata = {}
    } = params;
    
    logger.info(`Creating proposal: ${title}`);
    
    // Check proposer has enough voting power
    const proposerPower = this.getVotingPower(proposer);
    const totalSupply = this.getTotalVotingPower();
    const threshold = totalSupply * (this.config.proposalThreshold / 100);
    
    if (proposerPower < threshold) {
      throw new Error('Insufficient voting power to create proposal');
    }
    
    // Create proposal
    const proposal = {
      id: this.generateProposalId(),
      proposer,
      type,
      title,
      description,
      actions,
      metadata,
      status: ProposalStatus.PENDING,
      createdAt: Date.now(),
      startTime: Date.now() + this.config.votingDelay,
      endTime: Date.now() + this.config.votingDelay + this.config.votingPeriod,
      votes: {
        for: 0,
        against: 0,
        abstain: 0
      },
      voters: new Set(),
      quorumReached: false,
      eta: null // Execution time after timelock
    };
    
    // Validate actions based on type
    this.validateProposalActions(type, actions);
    
    // Store proposal
    this.proposals.set(proposal.id, proposal);
    this.stats.totalProposals++;
    
    logger.info(`Proposal created: ${proposal.id}`);
    this.emit('proposal:created', proposal);
    
    return proposal;
  }
  
  /**
   * Cast vote
   */
  async castVote(proposalId, voter, support, reason = '') {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error('Proposal not found');
    }
    
    const now = Date.now();
    
    // Check voting period
    if (now < proposal.startTime) {
      throw new Error('Voting has not started');
    }
    
    if (now > proposal.endTime) {
      throw new Error('Voting has ended');
    }
    
    // Check if already voted
    if (proposal.voters.has(voter)) {
      throw new Error('Already voted');
    }
    
    // Get voting power
    const votingPower = this.getVotingPower(voter);
    if (votingPower === 0) {
      throw new Error('No voting power');
    }
    
    // Record vote
    const vote = {
      proposalId,
      voter,
      support, // 0: against, 1: for, 2: abstain
      votingPower,
      reason,
      timestamp: now
    };
    
    // Update proposal votes
    if (support === 0) {
      proposal.votes.against += votingPower;
    } else if (support === 1) {
      proposal.votes.for += votingPower;
    } else if (support === 2) {
      proposal.votes.abstain += votingPower;
    }
    
    proposal.voters.add(voter);
    
    // Store vote
    const voteKey = `${proposalId}-${voter}`;
    this.votes.set(voteKey, vote);
    
    // Update stats
    this.stats.totalVotes++;
    this.stats.uniqueVoters.add(voter);
    
    // Check if quorum reached
    const totalVoted = proposal.votes.for + proposal.votes.against + proposal.votes.abstain;
    const quorumVotes = this.getTotalVotingPower() * (this.config.quorumPercentage / 100);
    proposal.quorumReached = totalVoted >= quorumVotes;
    
    logger.info(`Vote cast: ${voter} voted ${support} on proposal ${proposalId}`);
    this.emit('vote:cast', vote);
    
    return vote;
  }
  
  /**
   * Queue proposal for execution
   */
  async queueProposal(proposalId) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error('Proposal not found');
    }
    
    // Check proposal succeeded
    if (proposal.status !== ProposalStatus.ACTIVE) {
      throw new Error('Proposal must be active');
    }
    
    // Check voting ended
    if (Date.now() <= proposal.endTime) {
      throw new Error('Voting period not ended');
    }
    
    // Check if passed
    const passed = proposal.quorumReached && proposal.votes.for > proposal.votes.against;
    
    if (!passed) {
      proposal.status = ProposalStatus.DEFEATED;
      this.emit('proposal:defeated', proposal);
      return;
    }
    
    // Queue for execution
    proposal.status = ProposalStatus.QUEUED;
    proposal.eta = Date.now() + this.config.timelockDelay;
    
    // Add to timelock
    this.timelock.set(proposalId, {
      proposal,
      eta: proposal.eta,
      executed: false
    });
    
    logger.info(`Proposal queued: ${proposalId}`);
    this.emit('proposal:queued', proposal);
    
    return proposal;
  }
  
  /**
   * Execute proposal
   */
  async executeProposal(proposalId) {
    const timelockEntry = this.timelock.get(proposalId);
    if (!timelockEntry) {
      throw new Error('Proposal not in timelock');
    }
    
    const proposal = timelockEntry.proposal;
    
    // Check timelock passed
    if (Date.now() < timelockEntry.eta) {
      throw new Error('Timelock not passed');
    }
    
    // Check grace period
    if (Date.now() > timelockEntry.eta + this.config.gracePeriod) {
      proposal.status = ProposalStatus.EXPIRED;
      this.timelock.delete(proposalId);
      throw new Error('Proposal expired');
    }
    
    logger.info(`Executing proposal: ${proposalId}`);
    
    try {
      // Execute actions based on type
      await this.executeProposalActions(proposal);
      
      // Update status
      proposal.status = ProposalStatus.EXECUTED;
      timelockEntry.executed = true;
      
      this.stats.executedProposals++;
      
      logger.info(`Proposal executed: ${proposalId}`);
      this.emit('proposal:executed', proposal);
      
      // Clean up timelock
      this.timelock.delete(proposalId);
      
    } catch (error) {
      logger.error(`Failed to execute proposal ${proposalId}:`, error);
      proposal.status = ProposalStatus.CANCELLED;
      this.emit('proposal:failed', { proposal, error: error.message });
      throw error;
    }
  }
  
  /**
   * Execute proposal actions
   */
  async executeProposalActions(proposal) {
    const { type, actions } = proposal;
    
    switch (type) {
      case ProposalType.PARAMETER_CHANGE:
        await this.executeParameterChange(actions);
        break;
        
      case ProposalType.TREASURY_ALLOCATION:
        await this.executeTreasuryAllocation(actions);
        break;
        
      case ProposalType.FEE_ADJUSTMENT:
        await this.executeFeeAdjustment(actions);
        break;
        
      case ProposalType.STRATEGY:
        await this.executeStrategyChange(actions);
        break;
        
      case ProposalType.UPGRADE:
        await this.executeUpgrade(actions);
        break;
        
      case ProposalType.EMERGENCY:
        await this.executeEmergencyAction(actions);
        break;
        
      default:
        throw new Error('Unknown proposal type');
    }
  }
  
  /**
   * Execute parameter change
   */
  async executeParameterChange(actions) {
    for (const action of actions) {
      const { parameter, newValue, target } = action;
      
      logger.info(`Changing parameter ${parameter} to ${newValue}`);
      
      // Apply parameter change
      if (target === 'pool') {
        await this.pool.updateParameter(parameter, newValue);
      } else if (target === 'governance') {
        this.config[parameter] = newValue;
      }
      
      this.emit('parameter:changed', {
        parameter,
        newValue,
        target,
        timestamp: Date.now()
      });
    }
  }
  
  /**
   * Execute treasury allocation
   */
  async executeTreasuryAllocation(actions) {
    for (const action of actions) {
      const { recipient, amount, token, purpose } = action;
      
      // Check treasury balance
      const balance = this.treasury.balance[token] || 0;
      if (balance < amount) {
        throw new Error(`Insufficient treasury balance for ${token}`);
      }
      
      // Allocate funds
      this.treasury.balance[token] -= amount;
      this.treasury.allocated[token] = (this.treasury.allocated[token] || 0) + amount;
      
      logger.info(`Allocated ${amount} ${token} to ${recipient} for ${purpose}`);
      
      this.emit('treasury:allocated', {
        recipient,
        amount,
        token,
        purpose,
        timestamp: Date.now()
      });
    }
  }
  
  /**
   * Execute fee adjustment
   */
  async executeFeeAdjustment(actions) {
    for (const action of actions) {
      const { feeType, newFee } = action;
      
      if (feeType === 'pool') {
        await this.pool.updateFee(newFee);
      } else if (feeType === 'withdrawal') {
        await this.pool.updateWithdrawalFee(newFee);
      }
      
      this.emit('fee:adjusted', {
        feeType,
        newFee,
        timestamp: Date.now()
      });
    }
  }
  
  /**
   * Delegate voting power
   */
  async delegate(delegator, delegatee) {
    const delegatorData = this.delegates.get(delegator);
    if (!delegatorData) {
      throw new Error('Delegator not found');
    }
    
    // Remove previous delegation
    if (delegatorData.delegatedTo) {
      const previousDelegatee = this.delegates.get(delegatorData.delegatedTo);
      if (previousDelegatee) {
        previousDelegatee.delegatedFrom.delete(delegator);
      }
    }
    
    // Add new delegation
    delegatorData.delegatedTo = delegatee;
    
    const delegateeData = this.delegates.get(delegatee);
    if (delegateeData) {
      delegateeData.delegatedFrom.add(delegator);
    }
    
    logger.info(`${delegator} delegated voting power to ${delegatee}`);
    this.emit('delegation:changed', {
      delegator,
      delegatee,
      timestamp: Date.now()
    });
  }
  
  /**
   * Get voting power
   */
  getVotingPower(address) {
    const delegate = this.delegates.get(address);
    if (!delegate) return 0;
    
    let totalPower = delegate.votingPower;
    
    // Add delegated power
    for (const delegator of delegate.delegatedFrom) {
      const delegatorData = this.delegates.get(delegator);
      if (delegatorData && delegatorData.delegatedTo === address) {
        totalPower += delegatorData.votingPower;
      }
    }
    
    return totalPower;
  }
  
  /**
   * Get total voting power
   */
  getTotalVotingPower() {
    let total = 0;
    for (const [address, delegate] of this.delegates) {
      if (!delegate.delegatedTo) {
        total += delegate.votingPower;
      }
    }
    return total;
  }
  
  /**
   * Calculate voting power based on miner contribution
   */
  calculateVotingPower(miner) {
    // Factors: hashrate contribution, shares submitted, time in pool
    const hashrateWeight = 0.5;
    const sharesWeight = 0.3;
    const timeWeight = 0.2;
    
    const poolHashrate = this.pool.getPoolHashrate();
    const hashrateContribution = miner.hashrate / poolHashrate;
    
    const totalShares = this.pool.getTotalShares();
    const sharesContribution = miner.validShares / totalShares;
    
    const timeInPool = Date.now() - miner.joinedAt;
    const maxTime = 365 * 24 * 60 * 60 * 1000; // 1 year
    const timeContribution = Math.min(timeInPool / maxTime, 1);
    
    const votingPower = 
      hashrateContribution * hashrateWeight +
      sharesContribution * sharesWeight +
      timeContribution * timeWeight;
    
    // Scale to token units (e.g., 1000000 total)
    return Math.floor(votingPower * 1000000);
  }
  
  /**
   * Validate proposal actions
   */
  validateProposalActions(type, actions) {
    if (!actions || actions.length === 0) {
      throw new Error('Proposal must have actions');
    }
    
    switch (type) {
      case ProposalType.PARAMETER_CHANGE:
        for (const action of actions) {
          if (!action.parameter || action.newValue === undefined) {
            throw new Error('Invalid parameter change action');
          }
        }
        break;
        
      case ProposalType.TREASURY_ALLOCATION:
        for (const action of actions) {
          if (!action.recipient || !action.amount || !action.token) {
            throw new Error('Invalid treasury allocation action');
          }
        }
        break;
        
      // Add more validation as needed
    }
  }
  
  /**
   * Update treasury
   */
  updateTreasury(token, amount) {
    this.treasury.balance[token] = (this.treasury.balance[token] || 0) + amount;
    
    // Update total value
    const price = this.getTokenPrice(token);
    this.stats.treasuryValue += amount * price;
    
    this.emit('treasury:updated', {
      token,
      amount,
      newBalance: this.treasury.balance[token],
      totalValue: this.stats.treasuryValue
    });
  }
  
  /**
   * Get active proposals
   */
  getActiveProposals() {
    const active = [];
    const now = Date.now();
    
    for (const [id, proposal] of this.proposals) {
      if (proposal.status === ProposalStatus.ACTIVE ||
          (proposal.status === ProposalStatus.PENDING && now >= proposal.startTime)) {
        
        // Update status if needed
        if (proposal.status === ProposalStatus.PENDING) {
          proposal.status = ProposalStatus.ACTIVE;
        }
        
        active.push(proposal);
      }
    }
    
    return active;
  }
  
  /**
   * Get proposal details
   */
  getProposal(proposalId) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return null;
    
    // Calculate current state
    const now = Date.now();
    const totalVotes = proposal.votes.for + proposal.votes.against + proposal.votes.abstain;
    const participation = totalVotes / this.getTotalVotingPower();
    
    return {
      ...proposal,
      participation,
      timeRemaining: Math.max(0, proposal.endTime - now),
      currentQuorum: totalVotes / this.getTotalVotingPower() * 100,
      requiredQuorum: this.config.quorumPercentage,
      passing: proposal.votes.for > proposal.votes.against
    };
  }
  
  /**
   * Start governance cycle
   */
  startGovernanceCycle() {
    setInterval(() => {
      // Update proposal statuses
      const now = Date.now();
      
      for (const [id, proposal] of this.proposals) {
        if (proposal.status === ProposalStatus.PENDING && now >= proposal.startTime) {
          proposal.status = ProposalStatus.ACTIVE;
          this.emit('proposal:active', proposal);
        }
        
        if (proposal.status === ProposalStatus.ACTIVE && now > proposal.endTime) {
          this.queueProposal(id).catch(error => {
            logger.error(`Failed to queue proposal ${id}:`, error);
          });
        }
      }
    }, 60000); // Every minute
  }
  
  /**
   * Start timelock processor
   */
  startTimelockProcessor() {
    setInterval(() => {
      const now = Date.now();
      
      for (const [proposalId, entry] of this.timelock) {
        if (!entry.executed && now >= entry.eta && 
            now <= entry.eta + this.config.gracePeriod) {
          
          // Notify that proposal is ready for execution
          this.emit('proposal:executable', entry.proposal);
        }
        
        // Clean up expired proposals
        if (now > entry.eta + this.config.gracePeriod) {
          entry.proposal.status = ProposalStatus.EXPIRED;
          this.timelock.delete(proposalId);
          this.emit('proposal:expired', entry.proposal);
        }
      }
    }, 60000); // Every minute
  }
  
  /**
   * Helper methods
   */
  generateProposalId() {
    return `prop_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  }
  
  getTokenPrice(token) {
    // Mock token prices
    const prices = {
      BTC: 45000,
      ETH: 3000,
      USDC: 1,
      USDT: 1
    };
    return prices[token] || 0;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeProposals: this.getActiveProposals().length,
      totalDelegates: this.delegates.size,
      treasuryValueUSD: this.stats.treasuryValue,
      participation: (this.stats.uniqueVoters.size / this.delegates.size) * 100
    };
  }
  
  /**
   * Shutdown
   */
  shutdown() {
    this.removeAllListeners();
    logger.info('DAO governance shutdown');
  }
}

export default {
  DAOGovernance,
  ProposalType,
  ProposalStatus
};