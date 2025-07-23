/**
 * Liquidity Mining Rewards System
 * Incentivize liquidity provision with token rewards
 * 
 * Features:
 * - Multi-pool reward distribution
 * - Time-weighted rewards
 * - Boost multipliers
 * - LP token staking
 * - Compound rewards
 * - Vesting schedules
 * - Referral bonuses
 * - Dynamic APY calculation
 */

const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const crypto = require('crypto');
const { createLogger } = require('../core/logger');

const logger = createLogger('liquidity-mining');

// Reward types
const RewardType = {
  LINEAR: 'linear',
  EXPONENTIAL: 'exponential',
  TIERED: 'tiered',
  DYNAMIC: 'dynamic',
  BOOSTED: 'boosted'
};

// Pool states
const PoolState = {
  PENDING: 'pending',
  ACTIVE: 'active',
  PAUSED: 'paused',
  ENDED: 'ended'
};

// Stake states
const StakeState = {
  ACTIVE: 'active',
  UNSTAKING: 'unstaking',
  WITHDRAWN: 'withdrawn',
  EMERGENCY_WITHDRAWN: 'emergency_withdrawn'
};

class RewardPool {
  constructor(config) {
    this.poolId = config.poolId || this.generatePoolId();
    this.name = config.name;
    this.stakingToken = config.stakingToken;
    this.rewardToken = config.rewardToken;
    this.rewardRate = ethers.BigNumber.from(config.rewardRate || '0');
    this.rewardType = config.rewardType || RewardType.LINEAR;
    this.startTime = config.startTime || Date.now();
    this.endTime = config.endTime;
    this.state = PoolState.PENDING;
    
    // Pool metrics
    this.totalStaked = ethers.BigNumber.from(0);
    this.totalRewards = ethers.BigNumber.from(0);
    this.rewardPerTokenStored = ethers.BigNumber.from(0);
    this.lastUpdateTime = this.startTime;
    
    // Staker data
    this.stakers = new Map();
    this.stakes = new Map();
    
    // Boost configuration
    this.boostEnabled = config.boostEnabled || false;
    this.maxBoostMultiplier = config.maxBoostMultiplier || 250; // 2.5x max
    
    // Vesting configuration
    this.vestingEnabled = config.vestingEnabled || false;
    this.vestingDuration = config.vestingDuration || 2592000000; // 30 days
    
    // Initialize pool
    this.initialize();
  }

  initialize() {
    if (Date.now() >= this.startTime) {
      this.state = PoolState.ACTIVE;
    }
    
    // Set up auto-end timer
    if (this.endTime) {
      setTimeout(() => {
        this.state = PoolState.ENDED;
      }, this.endTime - Date.now());
    }
  }

  generatePoolId() {
    return 'pool_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
  }

  async stake(staker, amount) {
    if (this.state !== PoolState.ACTIVE) {
      throw new Error('Pool not active');
    }
    
    const stakeAmount = ethers.BigNumber.from(amount);
    
    // Update rewards before staking
    await this.updateRewardPerToken();
    
    // Get or create staker data
    let stakerData = this.stakers.get(staker);
    if (!stakerData) {
      stakerData = {
        balance: ethers.BigNumber.from(0),
        rewardPerTokenPaid: ethers.BigNumber.from(0),
        rewards: ethers.BigNumber.from(0),
        boostMultiplier: 100, // 1x default
        lastStakeTime: Date.now(),
        referrer: null
      };
      this.stakers.set(staker, stakerData);
    }
    
    // Calculate pending rewards
    const pendingRewards = this.calculateRewards(staker);
    stakerData.rewards = stakerData.rewards.add(pendingRewards);
    
    // Update staker balance
    stakerData.balance = stakerData.balance.add(stakeAmount);
    stakerData.rewardPerTokenPaid = this.rewardPerTokenStored;
    stakerData.lastStakeTime = Date.now();
    
    // Update total staked
    this.totalStaked = this.totalStaked.add(stakeAmount);
    
    // Create stake record
    const stakeId = this.generateStakeId();
    const stake = {
      id: stakeId,
      staker,
      amount: stakeAmount,
      timestamp: Date.now(),
      state: StakeState.ACTIVE,
      poolId: this.poolId
    };
    
    this.stakes.set(stakeId, stake);
    
    return {
      stakeId,
      staked: stakeAmount.toString(),
      totalStaked: stakerData.balance.toString(),
      pendingRewards: stakerData.rewards.toString()
    };
  }

  async unstake(staker, amount) {
    const stakerData = this.stakers.get(staker);
    if (!stakerData) {
      throw new Error('No stake found');
    }
    
    const unstakeAmount = ethers.BigNumber.from(amount);
    
    if (stakerData.balance.lt(unstakeAmount)) {
      throw new Error('Insufficient staked balance');
    }
    
    // Update rewards before unstaking
    await this.updateRewardPerToken();
    
    // Calculate pending rewards
    const pendingRewards = this.calculateRewards(staker);
    stakerData.rewards = stakerData.rewards.add(pendingRewards);
    
    // Update balances
    stakerData.balance = stakerData.balance.sub(unstakeAmount);
    stakerData.rewardPerTokenPaid = this.rewardPerTokenStored;
    
    // Update total staked
    this.totalStaked = this.totalStaked.sub(unstakeAmount);
    
    return {
      unstaked: unstakeAmount.toString(),
      remainingStake: stakerData.balance.toString(),
      pendingRewards: stakerData.rewards.toString()
    };
  }

  async claimRewards(staker) {
    const stakerData = this.stakers.get(staker);
    if (!stakerData) {
      throw new Error('No stake found');
    }
    
    // Update rewards
    await this.updateRewardPerToken();
    
    // Calculate all pending rewards
    const pendingRewards = this.calculateRewards(staker);
    const totalRewards = stakerData.rewards.add(pendingRewards);
    
    if (totalRewards.eq(0)) {
      throw new Error('No rewards to claim');
    }
    
    // Reset rewards
    stakerData.rewards = ethers.BigNumber.from(0);
    stakerData.rewardPerTokenPaid = this.rewardPerTokenStored;
    
    // Handle vesting if enabled
    if (this.vestingEnabled) {
      return this.createVestedReward(staker, totalRewards);
    }
    
    return {
      claimed: totalRewards.toString(),
      vested: false
    };
  }

  async updateRewardPerToken() {
    if (this.totalStaked.eq(0)) {
      this.lastUpdateTime = Date.now();
      return;
    }
    
    const currentTime = Math.min(Date.now(), this.endTime || Date.now());
    const timeDelta = currentTime - this.lastUpdateTime;
    
    if (timeDelta > 0) {
      const rewardPerToken = this.calculateRewardPerToken(timeDelta);
      this.rewardPerTokenStored = this.rewardPerTokenStored.add(rewardPerToken);
      this.lastUpdateTime = currentTime;
    }
  }

  calculateRewardPerToken(timeDelta) {
    // Base calculation: (rewardRate * timeDelta * 1e18) / totalStaked
    const rewards = this.rewardRate.mul(timeDelta).mul(ethers.constants.WeiPerEther);
    return rewards.div(this.totalStaked);
  }

  calculateRewards(staker) {
    const stakerData = this.stakers.get(staker);
    if (!stakerData || stakerData.balance.eq(0)) {
      return ethers.BigNumber.from(0);
    }
    
    // (balance * (rewardPerToken - rewardPerTokenPaid)) / 1e18
    const rewardsDiff = this.rewardPerTokenStored.sub(stakerData.rewardPerTokenPaid);
    let rewards = stakerData.balance.mul(rewardsDiff).div(ethers.constants.WeiPerEther);
    
    // Apply boost multiplier if enabled
    if (this.boostEnabled) {
      rewards = rewards.mul(stakerData.boostMultiplier).div(100);
    }
    
    return rewards;
  }

  async applyBoost(staker, boostToken, boostAmount) {
    if (!this.boostEnabled) {
      throw new Error('Boost not enabled for this pool');
    }
    
    const stakerData = this.stakers.get(staker);
    if (!stakerData) {
      throw new Error('No stake found');
    }
    
    // Calculate boost multiplier based on boost token amount
    // Linear scaling: 1x to maxBoostMultiplier
    const boostRatio = ethers.BigNumber.from(boostAmount)
      .mul(100)
      .div(stakerData.balance);
    
    const newMultiplier = Math.min(
      100 + boostRatio.toNumber(),
      this.maxBoostMultiplier
    );
    
    // Update rewards before applying boost
    await this.updateRewardPerToken();
    const pendingRewards = this.calculateRewards(staker);
    stakerData.rewards = stakerData.rewards.add(pendingRewards);
    
    // Apply new multiplier
    stakerData.boostMultiplier = newMultiplier;
    stakerData.rewardPerTokenPaid = this.rewardPerTokenStored;
    
    return {
      newMultiplier: newMultiplier / 100,
      effectiveStake: stakerData.balance.mul(newMultiplier).div(100).toString()
    };
  }

  createVestedReward(staker, amount) {
    const vestingSchedule = {
      beneficiary: staker,
      amount,
      startTime: Date.now(),
      endTime: Date.now() + this.vestingDuration,
      claimed: ethers.BigNumber.from(0),
      lastClaimTime: Date.now()
    };
    
    return {
      claimed: '0',
      vested: true,
      vestingSchedule: {
        total: amount.toString(),
        startTime: vestingSchedule.startTime,
        endTime: vestingSchedule.endTime,
        duration: this.vestingDuration
      }
    };
  }

  async setReferrer(staker, referrer) {
    const stakerData = this.stakers.get(staker);
    if (!stakerData) {
      throw new Error('No stake found');
    }
    
    if (stakerData.referrer) {
      throw new Error('Referrer already set');
    }
    
    if (staker === referrer) {
      throw new Error('Cannot refer yourself');
    }
    
    stakerData.referrer = referrer;
    
    // Give referral bonus if configured
    if (this.config.referralBonus) {
      const bonus = stakerData.balance.mul(this.config.referralBonus).div(10000);
      
      let referrerData = this.stakers.get(referrer);
      if (!referrerData) {
        referrerData = {
          balance: ethers.BigNumber.from(0),
          rewardPerTokenPaid: this.rewardPerTokenStored,
          rewards: ethers.BigNumber.from(0),
          boostMultiplier: 100,
          lastStakeTime: Date.now(),
          referrer: null
        };
        this.stakers.set(referrer, referrerData);
      }
      
      referrerData.rewards = referrerData.rewards.add(bonus);
    }
    
    return {
      referrer,
      bonusApplied: !!this.config.referralBonus
    };
  }

  calculateAPY() {
    if (this.totalStaked.eq(0)) {
      return 0;
    }
    
    // Annual rewards = rewardRate * seconds in year
    const annualRewards = this.rewardRate.mul(31536000);
    
    // APY = (annual rewards / total staked) * 100
    const apy = annualRewards.mul(10000).div(this.totalStaked).toNumber() / 100;
    
    return apy;
  }

  getStakerInfo(staker) {
    const stakerData = this.stakers.get(staker);
    if (!stakerData) {
      return null;
    }
    
    // Calculate current rewards
    const pendingRewards = this.calculateRewards(staker);
    const totalRewards = stakerData.rewards.add(pendingRewards);
    
    return {
      balance: stakerData.balance.toString(),
      rewards: totalRewards.toString(),
      boostMultiplier: stakerData.boostMultiplier / 100,
      lastStakeTime: stakerData.lastStakeTime,
      referrer: stakerData.referrer,
      share: this.totalStaked.gt(0) 
        ? stakerData.balance.mul(10000).div(this.totalStaked).toNumber() / 100
        : 0
    };
  }

  getPoolInfo() {
    return {
      poolId: this.poolId,
      name: this.name,
      state: this.state,
      stakingToken: this.stakingToken,
      rewardToken: this.rewardToken,
      totalStaked: this.totalStaked.toString(),
      rewardRate: this.rewardRate.toString(),
      apy: this.calculateAPY(),
      startTime: this.startTime,
      endTime: this.endTime,
      stakerCount: this.stakers.size,
      boostEnabled: this.boostEnabled,
      vestingEnabled: this.vestingEnabled
    };
  }

  generateStakeId() {
    return 'stake_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
  }
}

class YieldFarm {
  constructor(config) {
    this.farmId = config.farmId || this.generateFarmId();
    this.name = config.name;
    this.lpToken = config.lpToken; // Liquidity provider token
    this.rewardTokens = config.rewardTokens || []; // Multiple reward tokens
    this.multiplier = config.multiplier || 100; // Farm multiplier (1x = 100)
    this.allocPoint = config.allocPoint || 100; // Allocation points
    this.depositFee = config.depositFee || 0; // Deposit fee in basis points
    this.withdrawFee = config.withdrawFee || 0; // Withdraw fee in basis points
    
    this.deposits = new Map();
    this.totalDeposited = ethers.BigNumber.from(0);
    this.accRewardPerShare = new Map(); // Per reward token
    this.lastRewardBlock = config.startBlock || 0;
    
    // Initialize accumulator for each reward token
    for (const token of this.rewardTokens) {
      this.accRewardPerShare.set(token.address, ethers.BigNumber.from(0));
    }
  }

  generateFarmId() {
    return 'farm_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
  }

  async deposit(user, amount) {
    const depositAmount = ethers.BigNumber.from(amount);
    
    // Apply deposit fee if any
    let actualDeposit = depositAmount;
    if (this.depositFee > 0) {
      const fee = depositAmount.mul(this.depositFee).div(10000);
      actualDeposit = depositAmount.sub(fee);
    }
    
    // Update rewards
    await this.updatePool();
    
    // Get or create user deposit
    let userDeposit = this.deposits.get(user);
    if (!userDeposit) {
      userDeposit = {
        amount: ethers.BigNumber.from(0),
        rewardDebt: new Map(),
        depositTime: Date.now()
      };
      
      // Initialize reward debt for each token
      for (const token of this.rewardTokens) {
        userDeposit.rewardDebt.set(token.address, ethers.BigNumber.from(0));
      }
      
      this.deposits.set(user, userDeposit);
    }
    
    // Calculate pending rewards
    const pendingRewards = this.calculatePendingRewards(user);
    
    // Update user deposit
    userDeposit.amount = userDeposit.amount.add(actualDeposit);
    
    // Update reward debt
    for (const token of this.rewardTokens) {
      const accPerShare = this.accRewardPerShare.get(token.address);
      const debt = userDeposit.amount.mul(accPerShare).div(ethers.constants.WeiPerEther);
      userDeposit.rewardDebt.set(token.address, debt);
    }
    
    // Update total deposited
    this.totalDeposited = this.totalDeposited.add(actualDeposit);
    
    return {
      deposited: actualDeposit.toString(),
      totalDeposit: userDeposit.amount.toString(),
      pendingRewards
    };
  }

  async withdraw(user, amount) {
    const userDeposit = this.deposits.get(user);
    if (!userDeposit) {
      throw new Error('No deposit found');
    }
    
    const withdrawAmount = ethers.BigNumber.from(amount);
    if (userDeposit.amount.lt(withdrawAmount)) {
      throw new Error('Insufficient deposit');
    }
    
    // Update rewards
    await this.updatePool();
    
    // Calculate pending rewards
    const pendingRewards = this.calculatePendingRewards(user);
    
    // Update user deposit
    userDeposit.amount = userDeposit.amount.sub(withdrawAmount);
    
    // Apply withdraw fee if any
    let actualWithdraw = withdrawAmount;
    if (this.withdrawFee > 0) {
      const fee = withdrawAmount.mul(this.withdrawFee).div(10000);
      actualWithdraw = withdrawAmount.sub(fee);
    }
    
    // Update reward debt
    for (const token of this.rewardTokens) {
      const accPerShare = this.accRewardPerShare.get(token.address);
      const debt = userDeposit.amount.mul(accPerShare).div(ethers.constants.WeiPerEther);
      userDeposit.rewardDebt.set(token.address, debt);
    }
    
    // Update total deposited
    this.totalDeposited = this.totalDeposited.sub(withdrawAmount);
    
    return {
      withdrawn: actualWithdraw.toString(),
      remainingDeposit: userDeposit.amount.toString(),
      pendingRewards
    };
  }

  async harvest(user) {
    const userDeposit = this.deposits.get(user);
    if (!userDeposit) {
      throw new Error('No deposit found');
    }
    
    // Update rewards
    await this.updatePool();
    
    // Calculate pending rewards
    const pendingRewards = this.calculatePendingRewards(user);
    
    // Update reward debt
    for (const token of this.rewardTokens) {
      const accPerShare = this.accRewardPerShare.get(token.address);
      const debt = userDeposit.amount.mul(accPerShare).div(ethers.constants.WeiPerEther);
      userDeposit.rewardDebt.set(token.address, debt);
    }
    
    return {
      harvested: pendingRewards
    };
  }

  async updatePool() {
    const currentBlock = await this.getCurrentBlock();
    
    if (currentBlock <= this.lastRewardBlock) {
      return;
    }
    
    if (this.totalDeposited.eq(0)) {
      this.lastRewardBlock = currentBlock;
      return;
    }
    
    const blocksSinceLastReward = currentBlock - this.lastRewardBlock;
    
    // Update accumulator for each reward token
    for (const token of this.rewardTokens) {
      const rewardPerBlock = ethers.BigNumber.from(token.rewardPerBlock);
      const reward = rewardPerBlock
        .mul(blocksSinceLastReward)
        .mul(this.multiplier)
        .div(100);
      
      const accPerShare = this.accRewardPerShare.get(token.address);
      const newAccPerShare = accPerShare.add(
        reward.mul(ethers.constants.WeiPerEther).div(this.totalDeposited)
      );
      
      this.accRewardPerShare.set(token.address, newAccPerShare);
    }
    
    this.lastRewardBlock = currentBlock;
  }

  calculatePendingRewards(user) {
    const userDeposit = this.deposits.get(user);
    if (!userDeposit || userDeposit.amount.eq(0)) {
      return {};
    }
    
    const rewards = {};
    
    for (const token of this.rewardTokens) {
      const accPerShare = this.accRewardPerShare.get(token.address);
      const rewardDebt = userDeposit.rewardDebt.get(token.address);
      
      const pending = userDeposit.amount
        .mul(accPerShare)
        .div(ethers.constants.WeiPerEther)
        .sub(rewardDebt);
      
      rewards[token.address] = pending.toString();
    }
    
    return rewards;
  }

  async getCurrentBlock() {
    // Simulate block number
    return Math.floor(Date.now() / 12000); // ~12 second blocks
  }

  getFarmInfo() {
    return {
      farmId: this.farmId,
      name: this.name,
      lpToken: this.lpToken,
      rewardTokens: this.rewardTokens.map(t => ({
        address: t.address,
        symbol: t.symbol,
        rewardPerBlock: t.rewardPerBlock
      })),
      totalDeposited: this.totalDeposited.toString(),
      multiplier: this.multiplier / 100,
      allocPoint: this.allocPoint,
      depositFee: this.depositFee / 100,
      withdrawFee: this.withdrawFee / 100,
      depositorCount: this.deposits.size
    };
  }
}

class StakingVault {
  constructor(config) {
    this.vaultId = config.vaultId || this.generateVaultId();
    this.name = config.name;
    this.strategy = config.strategy; // Vault investment strategy
    this.underlying = config.underlying; // Underlying token
    this.performanceFee = config.performanceFee || 1000; // 10%
    this.managementFee = config.managementFee || 200; // 2%
    
    this.totalShares = ethers.BigNumber.from(0);
    this.totalAssets = ethers.BigNumber.from(0);
    this.shareBalances = new Map();
    this.lastHarvest = Date.now();
    
    this.strategies = [];
    this.earnings = ethers.BigNumber.from(0);
  }

  generateVaultId() {
    return 'vault_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
  }

  async deposit(depositor, amount) {
    const depositAmount = ethers.BigNumber.from(amount);
    
    // Calculate shares to mint
    let shares;
    if (this.totalShares.eq(0)) {
      shares = depositAmount;
    } else {
      shares = depositAmount.mul(this.totalShares).div(this.totalAssets);
    }
    
    // Update balances
    const currentShares = this.shareBalances.get(depositor) || ethers.BigNumber.from(0);
    this.shareBalances.set(depositor, currentShares.add(shares));
    
    this.totalShares = this.totalShares.add(shares);
    this.totalAssets = this.totalAssets.add(depositAmount);
    
    // Deploy capital to strategies
    await this.allocateToStrategies(depositAmount);
    
    return {
      deposited: depositAmount.toString(),
      sharesMinted: shares.toString(),
      sharePrice: this.getSharePrice().toString()
    };
  }

  async withdraw(withdrawer, shares) {
    const shareAmount = ethers.BigNumber.from(shares);
    const userShares = this.shareBalances.get(withdrawer) || ethers.BigNumber.from(0);
    
    if (userShares.lt(shareAmount)) {
      throw new Error('Insufficient shares');
    }
    
    // Calculate assets to withdraw
    const assets = shareAmount.mul(this.totalAssets).div(this.totalShares);
    
    // Withdraw from strategies
    await this.withdrawFromStrategies(assets);
    
    // Update balances
    this.shareBalances.set(withdrawer, userShares.sub(shareAmount));
    this.totalShares = this.totalShares.sub(shareAmount);
    this.totalAssets = this.totalAssets.sub(assets);
    
    return {
      withdrawn: assets.toString(),
      sharesBurned: shareAmount.toString(),
      sharePrice: this.getSharePrice().toString()
    };
  }

  async harvest() {
    const timeSinceLastHarvest = Date.now() - this.lastHarvest;
    
    // Collect earnings from strategies
    let totalEarnings = ethers.BigNumber.from(0);
    
    for (const strategy of this.strategies) {
      const earnings = await strategy.harvest();
      totalEarnings = totalEarnings.add(earnings);
    }
    
    // Apply performance fee
    if (totalEarnings.gt(0)) {
      const performanceFeeAmount = totalEarnings.mul(this.performanceFee).div(10000);
      totalEarnings = totalEarnings.sub(performanceFeeAmount);
    }
    
    // Apply management fee (annualized)
    const managementFeeAmount = this.totalAssets
      .mul(this.managementFee)
      .mul(timeSinceLastHarvest)
      .div(365 * 24 * 60 * 60 * 1000 * 10000);
    
    // Update earnings
    this.earnings = this.earnings.add(totalEarnings).sub(managementFeeAmount);
    this.totalAssets = this.totalAssets.add(totalEarnings).sub(managementFeeAmount);
    
    this.lastHarvest = Date.now();
    
    return {
      harvested: totalEarnings.toString(),
      performanceFee: this.performanceFee / 100,
      managementFee: this.managementFee / 100,
      newTotalAssets: this.totalAssets.toString()
    };
  }

  async allocateToStrategies(amount) {
    // Simple equal allocation
    const strategyCount = this.strategies.length;
    if (strategyCount === 0) return;
    
    const perStrategy = amount.div(strategyCount);
    
    for (const strategy of this.strategies) {
      await strategy.deposit(perStrategy);
    }
  }

  async withdrawFromStrategies(amount) {
    // Withdraw proportionally from all strategies
    const strategyCount = this.strategies.length;
    if (strategyCount === 0) return;
    
    const perStrategy = amount.div(strategyCount);
    
    for (const strategy of this.strategies) {
      await strategy.withdraw(perStrategy);
    }
  }

  getSharePrice() {
    if (this.totalShares.eq(0)) {
      return ethers.constants.WeiPerEther;
    }
    
    return this.totalAssets.mul(ethers.constants.WeiPerEther).div(this.totalShares);
  }

  getUserInfo(user) {
    const shares = this.shareBalances.get(user) || ethers.BigNumber.from(0);
    const assets = shares.mul(this.totalAssets).div(this.totalShares);
    
    return {
      shares: shares.toString(),
      assets: assets.toString(),
      sharePrice: this.getSharePrice().toString(),
      percentOwnership: this.totalShares.gt(0)
        ? shares.mul(10000).div(this.totalShares).toNumber() / 100
        : 0
    };
  }

  getVaultInfo() {
    return {
      vaultId: this.vaultId,
      name: this.name,
      underlying: this.underlying,
      totalShares: this.totalShares.toString(),
      totalAssets: this.totalAssets.toString(),
      sharePrice: this.getSharePrice().toString(),
      performanceFee: this.performanceFee / 100,
      managementFee: this.managementFee / 100,
      strategies: this.strategies.length,
      totalEarnings: this.earnings.toString(),
      depositorCount: this.shareBalances.size
    };
  }
}

class LiquidityMiningRewards extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      rewardToken: options.rewardToken,
      defaultRewardRate: options.defaultRewardRate || '1000000000000000000', // 1 token per second
      boostEnabled: options.boostEnabled !== false,
      vestingEnabled: options.vestingEnabled || false,
      compoundingEnabled: options.compoundingEnabled !== false,
      ...options
    };
    
    // Pools management
    this.pools = new Map();
    this.farms = new Map();
    this.vaults = new Map();
    
    // Global stats
    this.totalValueLocked = ethers.BigNumber.from(0);
    this.totalRewardsDistributed = ethers.BigNumber.from(0);
    this.uniqueStakers = new Set();
    
    this.stats = {
      totalPools: 0,
      totalFarms: 0,
      totalVaults: 0,
      activePools: 0,
      totalStakers: 0,
      averageAPY: 0
    };
    
    this.initialize();
  }

  initialize() {
    // Update stats periodically
    this.statsInterval = setInterval(() => {
      this.updateGlobalStats();
    }, 60000); // Every minute
    
    logger.info('Liquidity mining rewards system initialized');
  }

  async createRewardPool(config) {
    const pool = new RewardPool({
      ...config,
      rewardToken: config.rewardToken || this.config.rewardToken,
      boostEnabled: config.boostEnabled !== undefined ? config.boostEnabled : this.config.boostEnabled,
      vestingEnabled: config.vestingEnabled !== undefined ? config.vestingEnabled : this.config.vestingEnabled
    });
    
    this.pools.set(pool.poolId, pool);
    this.stats.totalPools++;
    
    if (pool.state === PoolState.ACTIVE) {
      this.stats.activePools++;
    }
    
    this.emit('pool:created', {
      poolId: pool.poolId,
      name: pool.name,
      stakingToken: pool.stakingToken,
      rewardToken: pool.rewardToken
    });
    
    return pool.getPoolInfo();
  }

  async createYieldFarm(config) {
    const farm = new YieldFarm(config);
    
    this.farms.set(farm.farmId, farm);
    this.stats.totalFarms++;
    
    this.emit('farm:created', {
      farmId: farm.farmId,
      name: farm.name,
      lpToken: farm.lpToken
    });
    
    return farm.getFarmInfo();
  }

  async createStakingVault(config) {
    const vault = new StakingVault(config);
    
    this.vaults.set(vault.vaultId, vault);
    this.stats.totalVaults++;
    
    this.emit('vault:created', {
      vaultId: vault.vaultId,
      name: vault.name,
      underlying: vault.underlying
    });
    
    return vault.getVaultInfo();
  }

  async stake(poolId, staker, amount) {
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new Error('Pool not found');
    }
    
    const result = await pool.stake(staker, amount);
    
    // Track unique stakers
    this.uniqueStakers.add(staker);
    
    // Update TVL
    this.updateTVL();
    
    this.emit('stake:completed', {
      poolId,
      staker,
      amount: result.staked,
      totalStaked: result.totalStaked
    });
    
    return result;
  }

  async unstake(poolId, staker, amount) {
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new Error('Pool not found');
    }
    
    const result = await pool.unstake(staker, amount);
    
    // Update TVL
    this.updateTVL();
    
    this.emit('unstake:completed', {
      poolId,
      staker,
      amount: result.unstaked,
      remainingStake: result.remainingStake
    });
    
    return result;
  }

  async claimRewards(poolId, staker) {
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new Error('Pool not found');
    }
    
    const result = await pool.claimRewards(staker);
    
    // Update total rewards distributed
    this.totalRewardsDistributed = this.totalRewardsDistributed.add(
      ethers.BigNumber.from(result.claimed || '0')
    );
    
    this.emit('rewards:claimed', {
      poolId,
      staker,
      amount: result.claimed,
      vested: result.vested
    });
    
    return result;
  }

  async compound(poolId, staker) {
    if (!this.config.compoundingEnabled) {
      throw new Error('Compounding not enabled');
    }
    
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new Error('Pool not found');
    }
    
    // Claim rewards
    const rewards = await pool.claimRewards(staker);
    
    // Restake rewards
    const compoundResult = await pool.stake(staker, rewards.claimed);
    
    this.emit('rewards:compounded', {
      poolId,
      staker,
      amount: rewards.claimed,
      newTotal: compoundResult.totalStaked
    });
    
    return {
      compounded: rewards.claimed,
      totalStaked: compoundResult.totalStaked
    };
  }

  async boost(poolId, staker, boostToken, amount) {
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new Error('Pool not found');
    }
    
    const result = await pool.applyBoost(staker, boostToken, amount);
    
    this.emit('boost:applied', {
      poolId,
      staker,
      multiplier: result.newMultiplier,
      effectiveStake: result.effectiveStake
    });
    
    return result;
  }

  updateTVL() {
    let tvl = ethers.BigNumber.from(0);
    
    // Sum all pool stakes
    for (const pool of this.pools.values()) {
      tvl = tvl.add(pool.totalStaked);
    }
    
    // Sum all farm deposits
    for (const farm of this.farms.values()) {
      tvl = tvl.add(farm.totalDeposited);
    }
    
    // Sum all vault assets
    for (const vault of this.vaults.values()) {
      tvl = tvl.add(vault.totalAssets);
    }
    
    this.totalValueLocked = tvl;
  }

  updateGlobalStats() {
    this.updateTVL();
    
    // Calculate average APY
    let totalAPY = 0;
    let activePoolCount = 0;
    
    for (const pool of this.pools.values()) {
      if (pool.state === PoolState.ACTIVE) {
        totalAPY += pool.calculateAPY();
        activePoolCount++;
      }
    }
    
    this.stats.averageAPY = activePoolCount > 0 ? totalAPY / activePoolCount : 0;
    this.stats.totalStakers = this.uniqueStakers.size;
    this.stats.activePools = activePoolCount;
  }

  getPoolInfo(poolId) {
    const pool = this.pools.get(poolId);
    return pool ? pool.getPoolInfo() : null;
  }

  getFarmInfo(farmId) {
    const farm = this.farms.get(farmId);
    return farm ? farm.getFarmInfo() : null;
  }

  getVaultInfo(vaultId) {
    const vault = this.vaults.get(vaultId);
    return vault ? vault.getVaultInfo() : null;
  }

  getUserPositions(user) {
    const positions = {
      pools: [],
      farms: [],
      vaults: []
    };
    
    // Get pool positions
    for (const [poolId, pool] of this.pools) {
      const info = pool.getStakerInfo(user);
      if (info && !ethers.BigNumber.from(info.balance).eq(0)) {
        positions.pools.push({
          poolId,
          poolName: pool.name,
          ...info
        });
      }
    }
    
    // Get farm positions
    for (const [farmId, farm] of this.farms) {
      const deposit = farm.deposits.get(user);
      if (deposit && !deposit.amount.eq(0)) {
        positions.farms.push({
          farmId,
          farmName: farm.name,
          deposited: deposit.amount.toString(),
          pendingRewards: farm.calculatePendingRewards(user)
        });
      }
    }
    
    // Get vault positions
    for (const [vaultId, vault] of this.vaults) {
      const info = vault.getUserInfo(user);
      if (info && !ethers.BigNumber.from(info.shares).eq(0)) {
        positions.vaults.push({
          vaultId,
          vaultName: vault.name,
          ...info
        });
      }
    }
    
    return positions;
  }

  getStatistics() {
    return {
      ...this.stats,
      totalValueLocked: this.totalValueLocked.toString(),
      totalRewardsDistributed: this.totalRewardsDistributed.toString(),
      pools: {
        total: this.pools.size,
        active: Array.from(this.pools.values()).filter(p => p.state === PoolState.ACTIVE).length
      },
      farms: {
        total: this.farms.size,
        totalDeposited: Array.from(this.farms.values()).reduce(
          (sum, f) => sum.add(f.totalDeposited),
          ethers.BigNumber.from(0)
        ).toString()
      },
      vaults: {
        total: this.vaults.size,
        totalAssets: Array.from(this.vaults.values()).reduce(
          (sum, v) => sum.add(v.totalAssets),
          ethers.BigNumber.from(0)
        ).toString()
      }
    };
  }

  async cleanup() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }
    
    this.removeAllListeners();
    logger.info('Liquidity mining rewards system cleaned up');
  }
}

module.exports = {
  LiquidityMiningRewards,
  RewardPool,
  YieldFarm,
  StakingVault,
  RewardType,
  PoolState,
  StakeState
};