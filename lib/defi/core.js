/**
 * DeFi Core for Otedama
 * Comprehensive decentralized finance with yield farming, lending, staking
 * 
 * Optimizations:
 * - Gas-efficient operations (Carmack)
 * - Modular DeFi protocols (Martin)
 * - Simple user interfaces (Pike)
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { randomBytes } from 'crypto';

// DeFi protocol constants
const PROTOCOL_CONSTANTS = Object.freeze({
  // Yield farming
  YIELD_FARMING: {
    BASE_APY: 0.05, // 5%
    MAX_APY: 2.0,   // 200%
    COMPOUND_FREQUENCY: 86400, // Daily compounding
    MIN_STAKE: 0.001,
    LOCK_PERIODS: [0, 30, 90, 180, 365] // days
  },
  
  // Lending
  LENDING: {
    BASE_RATE: 0.02,    // 2%
    MAX_LTV: 0.75,      // 75% loan-to-value
    LIQUIDATION_THRESHOLD: 0.85, // 85%
    LIQUIDATION_PENALTY: 0.1,    // 10%
    MIN_LOAN: 100,      // $100 minimum
    ORIGINATION_FEE: 0.005 // 0.5%
  },
  
  // Staking
  STAKING: {
    BASE_REWARD: 0.08,  // 8% APY
    SLASH_PENALTY: 0.05, // 5%
    MIN_STAKE: 32,      // Minimum stake amount
    UNSTAKE_DELAY: 604800, // 7 days
    VALIDATOR_COMMISSION: 0.1 // 10%
  },
  
  // Liquidity mining
  LIQUIDITY_MINING: {
    EMISSION_RATE: 100, // tokens per block
    DECAY_RATE: 0.99,   // 1% decay per epoch
    BOOST_MULTIPLIER: 2.5, // Maximum boost
    MIN_LIQUIDITY: 1000 // $1000 minimum
  }
});

// Supported assets with risk parameters
const SUPPORTED_ASSETS = Object.freeze(new Map([
  ['BTC', { 
    symbol: 'BTC', 
    collateralFactor: 0.75, 
    liquidationThreshold: 0.85,
    borrowRate: 0.03,
    supplyRate: 0.025,
    volatilityScore: 3
  }],
  ['ETH', { 
    symbol: 'ETH', 
    collateralFactor: 0.8, 
    liquidationThreshold: 0.85,
    borrowRate: 0.025,
    supplyRate: 0.02,
    volatilityScore: 4
  }],
  ['USDT', { 
    symbol: 'USDT', 
    collateralFactor: 0.9, 
    liquidationThreshold: 0.95,
    borrowRate: 0.02,
    supplyRate: 0.015,
    volatilityScore: 1
  }],
  ['USDC', { 
    symbol: 'USDC', 
    collateralFactor: 0.9, 
    liquidationThreshold: 0.95,
    borrowRate: 0.02,
    supplyRate: 0.015,
    volatilityScore: 1
  }]
]));

/**
 * Yield Farming Manager
 * Optimized for high-frequency compound calculations
 */
class YieldFarmingManager {
  constructor(database, options = {}) {
    this.database = database;
    this.options = {
      maxPools: options.maxPools || 100,
      compoundInterval: options.compoundInterval || 3600000, // 1 hour
      ...options
    };
    
    // Yield farming pools
    this.pools = new Map();
    this.userPositions = new Map(); // userId -> positions[]
    
    // Performance tracking
    this.metrics = {
      totalValueLocked: 0,
      totalRewardsDistributed: 0,
      activePositions: 0,
      avgAPY: 0
    };
    
    // Auto-compound system
    this.compoundQueue = [];
    this.isCompounding = false;
  }
  
  async initialize() {
    // Create tables
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS yield_pools (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token0 TEXT NOT NULL,
        token1 TEXT NOT NULL,
        reward_token TEXT NOT NULL,
        apy REAL NOT NULL,
        total_staked REAL DEFAULT 0,
        total_rewards REAL DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
      
      CREATE TABLE IF NOT EXISTS yield_positions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        pool_id TEXT NOT NULL,
        amount REAL NOT NULL,
        rewards_earned REAL DEFAULT 0,
        last_compound INTEGER DEFAULT (strftime('%s', 'now')),
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        lock_until INTEGER,
        FOREIGN KEY (pool_id) REFERENCES yield_pools(id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_yield_positions_user ON yield_positions(user_id);
      CREATE INDEX IF NOT EXISTS idx_yield_positions_pool ON yield_positions(pool_id);
    `);
    
    // Load existing pools
    await this.loadPools();
    
    // Start auto-compound process
    this.startAutoCompound();
  }
  
  async createPool(poolData) {
    const { name, token0, token1, rewardToken, initialAPY } = poolData;
    
    const poolId = randomBytes(16).toString('hex');
    const pool = {
      id: poolId,
      name,
      token0,
      token1,
      rewardToken,
      apy: initialAPY || PROTOCOL_CONSTANTS.YIELD_FARMING.BASE_APY,
      totalStaked: 0,
      totalRewards: 0,
      positions: new Map(),
      lastUpdate: Date.now()
    };
    
    this.pools.set(poolId, pool);
    
    // Store in database
    await this.database.run(`
      INSERT INTO yield_pools (id, name, token0, token1, reward_token, apy)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [poolId, name, token0, token1, rewardToken, pool.apy]);
    
    return poolId;
  }
  
  async stake(userId, poolId, amount, lockPeriod = 0) {
    const pool = this.pools.get(poolId);
    if (!pool) throw new Error('Pool not found');
    
    if (amount < PROTOCOL_CONSTANTS.YIELD_FARMING.MIN_STAKE) {
      throw new Error('Amount below minimum stake');
    }
    
    // Calculate lock bonus
    const lockBonus = this.calculateLockBonus(lockPeriod);
    const effectiveAPY = pool.apy * (1 + lockBonus);
    
    const positionId = randomBytes(16).toString('hex');
    const lockUntil = lockPeriod > 0 ? Date.now() + (lockPeriod * 86400000) : null;
    
    const position = {
      id: positionId,
      userId,
      poolId,
      amount,
      effectiveAPY,
      rewardsEarned: 0,
      lastCompound: Date.now(),
      createdAt: Date.now(),
      lockUntil
    };
    
    // Add to pool
    pool.positions.set(positionId, position);
    pool.totalStaked += amount;
    
    // Add to user positions
    if (!this.userPositions.has(userId)) {
      this.userPositions.set(userId, []);
    }
    this.userPositions.get(userId).push(position);
    
    // Store in database
    await this.database.run(`
      INSERT INTO yield_positions (id, user_id, pool_id, amount, lock_until)
      VALUES (?, ?, ?, ?, ?)
    `, [positionId, userId, poolId, amount, lockUntil]);
    
    // Update metrics
    this.metrics.totalValueLocked += amount;
    this.metrics.activePositions++;
    
    return position;
  }
  
  async unstake(userId, positionId, amount = null) {
    const position = this.findUserPosition(userId, positionId);
    if (!position) throw new Error('Position not found');
    
    // Check lock period
    if (position.lockUntil && Date.now() < position.lockUntil) {
      throw new Error('Position is still locked');
    }
    
    const unstakeAmount = amount || position.amount;
    if (unstakeAmount > position.amount) {
      throw new Error('Insufficient staked amount');
    }
    
    // Calculate pending rewards
    const pendingRewards = this.calculatePendingRewards(position);
    
    // Update position
    position.amount -= unstakeAmount;
    position.rewardsEarned += pendingRewards;
    position.lastCompound = Date.now();
    
    // Update pool
    const pool = this.pools.get(position.poolId);
    pool.totalStaked -= unstakeAmount;
    
    // Remove position if fully unstaked
    if (position.amount <= 0) {
      pool.positions.delete(positionId);
      this.removeUserPosition(userId, positionId);
      this.metrics.activePositions--;
    }
    
    // Update database
    if (position.amount > 0) {
      await this.database.run(`
        UPDATE yield_positions SET amount = ?, rewards_earned = ?, last_compound = strftime('%s', 'now')
        WHERE id = ?
      `, [position.amount, position.rewardsEarned, positionId]);
    } else {
      await this.database.run('DELETE FROM yield_positions WHERE id = ?', [positionId]);
    }
    
    // Update metrics
    this.metrics.totalValueLocked -= unstakeAmount;
    this.metrics.totalRewardsDistributed += pendingRewards;
    
    return {
      unstaked: unstakeAmount,
      rewards: pendingRewards,
      remaining: position.amount
    };
  }
  
  async compound(userId, positionId) {
    const position = this.findUserPosition(userId, positionId);
    if (!position) throw new Error('Position not found');
    
    const pendingRewards = this.calculatePendingRewards(position);
    if (pendingRewards <= 0) return { compounded: 0 };
    
    // Add rewards to principal
    position.amount += pendingRewards;
    position.rewardsEarned = 0;
    position.lastCompound = Date.now();
    
    // Update pool
    const pool = this.pools.get(position.poolId);
    pool.totalStaked += pendingRewards;
    
    // Update database
    await this.database.run(`
      UPDATE yield_positions SET amount = ?, rewards_earned = 0, last_compound = strftime('%s', 'now')
      WHERE id = ?
    `, [position.amount, positionId]);
    
    // Update metrics
    this.metrics.totalValueLocked += pendingRewards;
    this.metrics.totalRewardsDistributed += pendingRewards;
    
    return { compounded: pendingRewards };
  }
  
  // Auto-compound system
  startAutoCompound() {
    setInterval(() => {
      if (!this.isCompounding) {
        this.processAutoCompound();
      }
    }, this.options.compoundInterval);
  }
  
  async processAutoCompound() {
    this.isCompounding = true;
    
    try {
      const batchSize = 100;
      let processed = 0;
      
      for (const [poolId, pool] of this.pools) {
        for (const [positionId, position] of pool.positions) {
          if (processed >= batchSize) break;
          
          // Auto-compound if significant rewards
          const pendingRewards = this.calculatePendingRewards(position);
          const threshold = position.amount * 0.001; // 0.1% threshold
          
          if (pendingRewards > threshold) {
            await this.compound(position.userId, positionId);
            processed++;
          }
        }
      }
      
    } finally {
      this.isCompounding = false;
    }
  }
  
  // Helper methods
  calculatePendingRewards(position) {
    const timeDiff = (Date.now() - position.lastCompound) / 1000; // seconds
    const yearlyRate = position.effectiveAPY || PROTOCOL_CONSTANTS.YIELD_FARMING.BASE_APY;
    const secondlyRate = yearlyRate / (365 * 24 * 3600);
    
    return position.amount * secondlyRate * timeDiff;
  }
  
  calculateLockBonus(lockPeriod) {
    const bonusRates = {
      0: 0,      // No lock
      30: 0.1,   // 10% bonus for 30 days
      90: 0.25,  // 25% bonus for 90 days
      180: 0.5,  // 50% bonus for 180 days
      365: 1.0   // 100% bonus for 1 year
    };
    
    return bonusRates[lockPeriod] || 0;
  }
  
  findUserPosition(userId, positionId) {
    const userPositions = this.userPositions.get(userId) || [];
    return userPositions.find(p => p.id === positionId);
  }
  
  removeUserPosition(userId, positionId) {
    const userPositions = this.userPositions.get(userId) || [];
    const index = userPositions.findIndex(p => p.id === positionId);
    if (index !== -1) {
      userPositions.splice(index, 1);
    }
  }
  
  async loadPools() {
    const pools = await this.database.all('SELECT * FROM yield_pools');
    
    for (const poolData of pools) {
      const pool = {
        ...poolData,
        positions: new Map(),
        lastUpdate: Date.now()
      };
      
      this.pools.set(pool.id, pool);
      
      // Load positions for this pool
      const positions = await this.database.all(
        'SELECT * FROM yield_positions WHERE pool_id = ?',
        [pool.id]
      );
      
      for (const posData of positions) {
        const position = {
          ...posData,
          lockUntil: posData.lock_until,
          lastCompound: posData.last_compound * 1000,
          createdAt: posData.created_at * 1000
        };
        
        pool.positions.set(position.id, position);
        
        // Add to user positions
        if (!this.userPositions.has(position.user_id)) {
          this.userPositions.set(position.user_id, []);
        }
        this.userPositions.get(position.user_id).push(position);
      }
    }
  }
  
  // Public API
  getUserPositions(userId) {
    return this.userPositions.get(userId) || [];
  }
  
  getPoolInfo(poolId) {
    const pool = this.pools.get(poolId);
    if (!pool) return null;
    
    return {
      ...pool,
      positionCount: pool.positions.size
    };
  }
  
  getAllPools() {
    return Array.from(this.pools.values()).map(pool => ({
      ...pool,
      positionCount: pool.positions.size
    }));
  }
  
  getMetrics() {
    // Update avg APY
    let totalWeightedAPY = 0;
    let totalStaked = 0;
    
    for (const pool of this.pools.values()) {
      totalWeightedAPY += pool.apy * pool.totalStaked;
      totalStaked += pool.totalStaked;
    }
    
    this.metrics.avgAPY = totalStaked > 0 ? totalWeightedAPY / totalStaked : 0;
    
    return { ...this.metrics };
  }
}

/**
 * Lending Protocol Manager
 * Supports over-collateralized loans with liquidation
 */
class LendingManager {
  constructor(database, priceOracle, options = {}) {
    this.database = database;
    this.priceOracle = priceOracle;
    this.options = {
      liquidationBot: options.liquidationBot !== false,
      ...options
    };
    
    // Lending pools by asset
    this.lendingPools = new Map();
    
    // Active loans
    this.loans = new Map();
    
    // Collateral positions
    this.collateral = new Map();
    
    // Metrics
    this.metrics = {
      totalSupply: 0,
      totalBorrow: 0,
      totalCollateral: 0,
      activeLoans: 0,
      liquidations: 0
    };
  }
  
  async initialize() {
    // Create tables
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS lending_pools (
        asset TEXT PRIMARY KEY,
        total_supply REAL DEFAULT 0,
        total_borrow REAL DEFAULT 0,
        supply_rate REAL NOT NULL,
        borrow_rate REAL NOT NULL,
        utilization_rate REAL DEFAULT 0,
        last_update INTEGER DEFAULT (strftime('%s', 'now'))
      );
      
      CREATE TABLE IF NOT EXISTS loans (
        id TEXT PRIMARY KEY,
        borrower TEXT NOT NULL,
        collateral_asset TEXT NOT NULL,
        collateral_amount REAL NOT NULL,
        borrow_asset TEXT NOT NULL,
        borrow_amount REAL NOT NULL,
        interest_rate REAL NOT NULL,
        ltv REAL NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        last_interest_update INTEGER DEFAULT (strftime('%s', 'now')),
        status TEXT DEFAULT 'active'
      );
      
      CREATE TABLE IF NOT EXISTS collateral_deposits (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        asset TEXT NOT NULL,
        amount REAL NOT NULL,
        locked_amount REAL DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
      
      CREATE INDEX IF NOT EXISTS idx_loans_borrower ON loans(borrower, status);
      CREATE INDEX IF NOT EXISTS idx_collateral_user ON collateral_deposits(user_id, asset);
    `);
    
    // Initialize lending pools for supported assets
    for (const [asset, config] of SUPPORTED_ASSETS) {
      await this.initializeLendingPool(asset, config);
    }
    
    // Start liquidation bot
    if (this.options.liquidationBot) {
      this.startLiquidationBot();
    }
    
    // Start interest accrual
    this.startInterestAccrual();
  }
  
  async initializeLendingPool(asset, config) {
    const pool = {
      asset,
      totalSupply: 0,
      totalBorrow: 0,
      supplyRate: config.supplyRate,
      borrowRate: config.borrowRate,
      utilizationRate: 0,
      lastUpdate: Date.now()
    };
    
    this.lendingPools.set(asset, pool);
    
    // Insert or update in database
    await this.database.run(`
      INSERT OR REPLACE INTO lending_pools (asset, supply_rate, borrow_rate)
      VALUES (?, ?, ?)
    `, [asset, config.supplyRate, config.borrowRate]);
  }
  
  async depositCollateral(userId, asset, amount) {
    if (!SUPPORTED_ASSETS.has(asset)) {
      throw new Error('Unsupported asset');
    }
    
    if (amount <= 0) {
      throw new Error('Invalid amount');
    }
    
    const depositId = randomBytes(16).toString('hex');
    
    // Store collateral
    const deposit = {
      id: depositId,
      userId,
      asset,
      amount,
      lockedAmount: 0,
      createdAt: Date.now()
    };
    
    this.collateral.set(depositId, deposit);
    
    // Update database
    await this.database.run(`
      INSERT INTO collateral_deposits (id, user_id, asset, amount)
      VALUES (?, ?, ?, ?)
    `, [depositId, userId, asset, amount]);
    
    // Update metrics
    const price = await this.priceOracle.getPrice(asset);
    this.metrics.totalCollateral += amount * price;
    
    return depositId;
  }
  
  async borrow(userId, collateralAsset, collateralAmount, borrowAsset, borrowAmount) {
    // Validate assets
    if (!SUPPORTED_ASSETS.has(collateralAsset) || !SUPPORTED_ASSETS.has(borrowAsset)) {
      throw new Error('Unsupported asset');
    }
    
    // Get prices
    const collateralPrice = await this.priceOracle.getPrice(collateralAsset);
    const borrowPrice = await this.priceOracle.getPrice(borrowAsset);
    
    // Calculate LTV
    const collateralValue = collateralAmount * collateralPrice;
    const borrowValue = borrowAmount * borrowPrice;
    const ltv = borrowValue / collateralValue;
    
    // Check LTV limits
    const assetConfig = SUPPORTED_ASSETS.get(collateralAsset);
    if (ltv > assetConfig.collateralFactor) {
      throw new Error('LTV too high');
    }
    
    const loanId = randomBytes(16).toString('hex');
    
    // Create loan
    const loan = {
      id: loanId,
      borrower: userId,
      collateralAsset,
      collateralAmount,
      borrowAsset,
      borrowAmount,
      interestRate: assetConfig.borrowRate,
      ltv,
      createdAt: Date.now(),
      lastInterestUpdate: Date.now(),
      status: 'active'
    };
    
    this.loans.set(loanId, loan);
    
    // Update lending pool
    const pool = this.lendingPools.get(borrowAsset);
    pool.totalBorrow += borrowAmount;
    pool.utilizationRate = pool.totalBorrow / pool.totalSupply;
    
    // Store in database
    await this.database.run(`
      INSERT INTO loans (
        id, borrower, collateral_asset, collateral_amount, 
        borrow_asset, borrow_amount, interest_rate, ltv
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [loanId, userId, collateralAsset, collateralAmount, borrowAsset, borrowAmount, loan.interestRate, ltv]);
    
    // Update metrics
    this.metrics.totalBorrow += borrowValue;
    this.metrics.activeLoans++;
    
    return loanId;
  }
  
  async repay(userId, loanId, repayAmount = null) {
    const loan = this.loans.get(loanId);
    if (!loan || loan.borrower !== userId) {
      throw new Error('Loan not found');
    }
    
    // Calculate interest
    const interest = this.calculateInterest(loan);
    const totalOwed = loan.borrowAmount + interest;
    const actualRepayAmount = repayAmount || totalOwed;
    
    if (actualRepayAmount > totalOwed) {
      throw new Error('Repay amount exceeds debt');
    }
    
    // Update loan
    loan.borrowAmount = Math.max(0, totalOwed - actualRepayAmount);
    loan.lastInterestUpdate = Date.now();
    
    // Close loan if fully repaid
    if (loan.borrowAmount <= 0) {
      loan.status = 'closed';
      this.metrics.activeLoans--;
    }
    
    // Update lending pool
    const pool = this.lendingPools.get(loan.borrowAsset);
    pool.totalBorrow -= actualRepayAmount;
    pool.utilizationRate = pool.totalBorrow / pool.totalSupply;
    
    // Update database
    await this.database.run(`
      UPDATE loans SET borrow_amount = ?, last_interest_update = strftime('%s', 'now'), status = ?
      WHERE id = ?
    `, [loan.borrowAmount, loan.status, loanId]);
    
    // Update metrics
    const borrowPrice = await this.priceOracle.getPrice(loan.borrowAsset);
    this.metrics.totalBorrow -= actualRepayAmount * borrowPrice;
    
    return {
      repaid: actualRepayAmount,
      interest,
      remaining: loan.borrowAmount
    };
  }
  
  async liquidate(loanId) {
    const loan = this.loans.get(loanId);
    if (!loan || loan.status !== 'active') {
      throw new Error('Invalid loan for liquidation');
    }
    
    // Check if loan is liquidatable
    const isLiquidatable = await this.checkLiquidation(loan);
    if (!isLiquidatable) {
      throw new Error('Loan not liquidatable');
    }
    
    // Calculate liquidation amounts
    const interest = this.calculateInterest(loan);
    const totalDebt = loan.borrowAmount + interest;
    const liquidationPenalty = totalDebt * PROTOCOL_CONSTANTS.LENDING.LIQUIDATION_PENALTY;
    
    // Update loan status
    loan.status = 'liquidated';
    loan.liquidatedAt = Date.now();
    
    // Update pools
    const pool = this.lendingPools.get(loan.borrowAsset);
    pool.totalBorrow -= loan.borrowAmount;
    
    // Update database
    await this.database.run(`
      UPDATE loans SET status = 'liquidated', last_interest_update = strftime('%s', 'now')
      WHERE id = ?
    `, [loanId]);
    
    // Update metrics
    this.metrics.liquidations++;
    this.metrics.activeLoans--;
    
    return {
      loanId,
      debtRepaid: totalDebt,
      collateralSeized: loan.collateralAmount,
      penalty: liquidationPenalty
    };
  }
  
  // Background processes
  startLiquidationBot() {
    setInterval(async () => {
      await this.checkAllLoansForLiquidation();
    }, 60000); // Every minute
  }
  
  startInterestAccrual() {
    setInterval(async () => {
      await this.accrueInterest();
    }, 3600000); // Every hour
  }
  
  async checkAllLoansForLiquidation() {
    for (const [loanId, loan] of this.loans) {
      if (loan.status === 'active') {
        try {
          const isLiquidatable = await this.checkLiquidation(loan);
          if (isLiquidatable) {
            await this.liquidate(loanId);
          }
        } catch (error) {
          // Log error but continue checking other loans
          console.error(`Liquidation check failed for loan ${loanId}:`, error);
        }
      }
    }
  }
  
  async accrueInterest() {
    for (const [loanId, loan] of this.loans) {
      if (loan.status === 'active') {
        const interest = this.calculateInterest(loan);
        loan.borrowAmount += interest;
        loan.lastInterestUpdate = Date.now();
        
        // Update database
        await this.database.run(`
          UPDATE loans SET borrow_amount = ?, last_interest_update = strftime('%s', 'now')
          WHERE id = ?
        `, [loan.borrowAmount, loanId]);
      }
    }
  }
  
  // Helper methods
  async checkLiquidation(loan) {
    const collateralPrice = await this.priceOracle.getPrice(loan.collateralAsset);
    const borrowPrice = await this.priceOracle.getPrice(loan.borrowAsset);
    
    const interest = this.calculateInterest(loan);
    const totalDebt = loan.borrowAmount + interest;
    
    const collateralValue = loan.collateralAmount * collateralPrice;
    const debtValue = totalDebt * borrowPrice;
    
    const currentLTV = debtValue / collateralValue;
    const assetConfig = SUPPORTED_ASSETS.get(loan.collateralAsset);
    
    return currentLTV >= assetConfig.liquidationThreshold;
  }
  
  calculateInterest(loan) {
    const timeDiff = (Date.now() - loan.lastInterestUpdate) / 1000; // seconds
    const yearlyRate = loan.interestRate;
    const secondlyRate = yearlyRate / (365 * 24 * 3600);
    
    return loan.borrowAmount * secondlyRate * timeDiff;
  }
  
  // Public API
  getUserLoans(userId) {
    return Array.from(this.loans.values()).filter(loan => loan.borrower === userId);
  }
  
  getUserCollateral(userId) {
    return Array.from(this.collateral.values()).filter(deposit => deposit.userId === userId);
  }
  
  getLendingPoolInfo(asset) {
    return this.lendingPools.get(asset);
  }
  
  getMetrics() {
    return { ...this.metrics };
  }
}

/**
 * Staking Manager
 * Proof-of-Stake validation with slashing protection
 */
class StakingManager {
  constructor(database, options = {}) {
    this.database = database;
    this.options = {
      validatorMinStake: options.validatorMinStake || PROTOCOL_CONSTANTS.STAKING.MIN_STAKE,
      ...options
    };
    
    // Validators and delegators
    this.validators = new Map();
    this.delegations = new Map();
    
    // Rewards and penalties
    this.rewardPool = 0;
    this.slashingEvents = [];
    
    // Metrics
    this.metrics = {
      totalStaked: 0,
      activeValidators: 0,
      totalDelegators: 0,
      averageReward: PROTOCOL_CONSTANTS.STAKING.BASE_REWARD
    };
  }
  
  async initialize() {
    // Create tables
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS validators (
        id TEXT PRIMARY KEY,
        operator TEXT NOT NULL,
        self_stake REAL NOT NULL,
        total_stake REAL DEFAULT 0,
        commission REAL NOT NULL,
        status TEXT DEFAULT 'active',
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
      
      CREATE TABLE IF NOT EXISTS delegations (
        id TEXT PRIMARY KEY,
        delegator TEXT NOT NULL,
        validator_id TEXT NOT NULL,
        amount REAL NOT NULL,
        rewards_earned REAL DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (validator_id) REFERENCES validators(id)
      );
      
      CREATE TABLE IF NOT EXISTS slashing_events (
        id TEXT PRIMARY KEY,
        validator_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        penalty_rate REAL NOT NULL,
        amount_slashed REAL NOT NULL,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (validator_id) REFERENCES validators(id)
      );
    `);
    
    // Start reward distribution
    this.startRewardDistribution();
  }
  
  async createValidator(operatorId, selfStake, commission) {
    if (selfStake < this.options.validatorMinStake) {
      throw new Error('Insufficient self stake');
    }
    
    if (commission > 1 || commission < 0) {
      throw new Error('Invalid commission rate');
    }
    
    const validatorId = randomBytes(16).toString('hex');
    
    const validator = {
      id: validatorId,
      operator: operatorId,
      selfStake,
      totalStake: selfStake,
      commission,
      delegations: new Map(),
      status: 'active',
      createdAt: Date.now()
    };
    
    this.validators.set(validatorId, validator);
    
    // Store in database
    await this.database.run(`
      INSERT INTO validators (id, operator, self_stake, total_stake, commission)
      VALUES (?, ?, ?, ?, ?)
    `, [validatorId, operatorId, selfStake, selfStake, commission]);
    
    // Update metrics
    this.metrics.totalStaked += selfStake;
    this.metrics.activeValidators++;
    
    return validatorId;
  }
  
  async delegate(delegatorId, validatorId, amount) {
    const validator = this.validators.get(validatorId);
    if (!validator || validator.status !== 'active') {
      throw new Error('Invalid or inactive validator');
    }
    
    const delegationId = randomBytes(16).toString('hex');
    
    const delegation = {
      id: delegationId,
      delegator: delegatorId,
      validatorId,
      amount,
      rewardsEarned: 0,
      createdAt: Date.now()
    };
    
    // Add to validator
    validator.delegations.set(delegationId, delegation);
    validator.totalStake += amount;
    
    // Store delegation
    this.delegations.set(delegationId, delegation);
    
    // Store in database
    await this.database.run(`
      INSERT INTO delegations (id, delegator, validator_id, amount)
      VALUES (?, ?, ?, ?)
    `, [delegationId, delegatorId, validatorId, amount]);
    
    // Update validator total stake
    await this.database.run(`
      UPDATE validators SET total_stake = ? WHERE id = ?
    `, [validator.totalStake, validatorId]);
    
    // Update metrics
    this.metrics.totalStaked += amount;
    this.metrics.totalDelegators++;
    
    return delegationId;
  }
  
  async undelegate(delegatorId, delegationId) {
    const delegation = this.delegations.get(delegationId);
    if (!delegation || delegation.delegator !== delegatorId) {
      throw new Error('Delegation not found');
    }
    
    const validator = this.validators.get(delegation.validatorId);
    
    // Calculate pending rewards
    const rewards = this.calculateDelegationRewards(delegation);
    
    // Remove delegation
    validator.delegations.delete(delegationId);
    validator.totalStake -= delegation.amount;
    this.delegations.delete(delegationId);
    
    // Update database
    await this.database.run('DELETE FROM delegations WHERE id = ?', [delegationId]);
    await this.database.run(`
      UPDATE validators SET total_stake = ? WHERE id = ?
    `, [validator.totalStake, delegation.validatorId]);
    
    // Update metrics
    this.metrics.totalStaked -= delegation.amount;
    this.metrics.totalDelegators--;
    
    return {
      amount: delegation.amount,
      rewards,
      unstakeDelay: PROTOCOL_CONSTANTS.STAKING.UNSTAKE_DELAY
    };
  }
  
  async slash(validatorId, reason, penaltyRate = PROTOCOL_CONSTANTS.STAKING.SLASH_PENALTY) {
    const validator = this.validators.get(validatorId);
    if (!validator) throw new Error('Validator not found');
    
    const slashAmount = validator.totalStake * penaltyRate;
    
    // Apply slashing
    validator.totalStake -= slashAmount;
    
    // Slash delegations proportionally
    for (const [delegationId, delegation] of validator.delegations) {
      const delegationSlash = delegation.amount * penaltyRate;
      delegation.amount -= delegationSlash;
      
      // Update database
      await this.database.run(`
        UPDATE delegations SET amount = ? WHERE id = ?
      `, [delegation.amount, delegationId]);
    }
    
    // Record slashing event
    const slashingId = randomBytes(16).toString('hex');
    const slashingEvent = {
      id: slashingId,
      validatorId,
      reason,
      penaltyRate,
      amountSlashed: slashAmount,
      timestamp: Date.now()
    };
    
    this.slashingEvents.push(slashingEvent);
    
    // Store in database
    await this.database.run(`
      INSERT INTO slashing_events (id, validator_id, reason, penalty_rate, amount_slashed)
      VALUES (?, ?, ?, ?, ?)
    `, [slashingId, validatorId, reason, penaltyRate, slashAmount]);
    
    await this.database.run(`
      UPDATE validators SET total_stake = ? WHERE id = ?
    `, [validator.totalStake, validatorId]);
    
    // Update metrics
    this.metrics.totalStaked -= slashAmount;
    
    return slashingEvent;
  }
  
  startRewardDistribution() {
    setInterval(() => {
      this.distributeRewards();
    }, 86400000); // Daily
  }
  
  async distributeRewards() {
    const dailyRewardRate = PROTOCOL_CONSTANTS.STAKING.BASE_REWARD / 365;
    
    for (const [validatorId, validator] of this.validators) {
      if (validator.status !== 'active') continue;
      
      const totalRewards = validator.totalStake * dailyRewardRate;
      const validatorCommission = totalRewards * validator.commission;
      const delegatorRewards = totalRewards - validatorCommission;
      
      // Distribute to delegators
      for (const [delegationId, delegation] of validator.delegations) {
        const delegatorShare = (delegation.amount / validator.totalStake) * delegatorRewards;
        delegation.rewardsEarned += delegatorShare;
        
        // Update database
        await this.database.run(`
          UPDATE delegations SET rewards_earned = ? WHERE id = ?
        `, [delegation.rewardsEarned, delegationId]);
      }
    }
  }
  
  calculateDelegationRewards(delegation) {
    // Simplified reward calculation
    const dailyRate = PROTOCOL_CONSTANTS.STAKING.BASE_REWARD / 365;
    const timeDiff = (Date.now() - delegation.createdAt) / 86400000; // days
    
    return delegation.amount * dailyRate * timeDiff;
  }
  
  // Public API
  getValidator(validatorId) {
    return this.validators.get(validatorId);
  }
  
  getUserDelegations(userId) {
    return Array.from(this.delegations.values()).filter(d => d.delegator === userId);
  }
  
  getValidators() {
    return Array.from(this.validators.values());
  }
  
  getMetrics() {
    return { ...this.metrics };
  }
}

/**
 * Main DeFi Core
 */
export class DeFiCore extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = Object.freeze({
      enableYieldFarming: options.enableYieldFarming !== false,
      enableLending: options.enableLending !== false,
      enableStaking: options.enableStaking !== false,
      ...options
    });
    
    // Core components
    this.database = options.database;
    this.logger = options.logger;
    this.priceOracle = options.priceOracle;
    
    // DeFi managers
    if (this.config.enableYieldFarming) {
      this.yieldFarming = new YieldFarmingManager(this.database, options.yieldFarming);
    }
    
    if (this.config.enableLending) {
      this.lending = new LendingManager(this.database, this.priceOracle, options.lending);
    }
    
    if (this.config.enableStaking) {
      this.staking = new StakingManager(this.database, options.staking);
    }
    
    // Aggregated metrics
    this.metrics = {
      totalValueLocked: 0,
      totalUsers: 0,
      totalTransactions: 0
    };
    
    this.initialized = false;
  }
  
  async initialize() {
    if (this.initialized) return;
    
    this.logger.info('Initializing DeFi Core...');
    
    // Initialize components
    if (this.yieldFarming) {
      await this.yieldFarming.initialize();
    }
    
    if (this.lending) {
      await this.lending.initialize();
    }
    
    if (this.staking) {
      await this.staking.initialize();
    }
    
    // Start metrics collection
    this.startMetricsCollection();
    
    this.initialized = true;
    this.logger.info('DeFi Core initialized successfully');
    
    this.emit('initialized');
  }
  
  startMetricsCollection() {
    setInterval(() => {
      this.updateAggregatedMetrics();
    }, 30000); // Every 30 seconds
  }
  
  updateAggregatedMetrics() {
    let totalTVL = 0;
    
    if (this.yieldFarming) {
      const yieldMetrics = this.yieldFarming.getMetrics();
      totalTVL += yieldMetrics.totalValueLocked;
    }
    
    if (this.lending) {
      const lendingMetrics = this.lending.getMetrics();
      totalTVL += lendingMetrics.totalSupply + lendingMetrics.totalCollateral;
    }
    
    if (this.staking) {
      const stakingMetrics = this.staking.getMetrics();
      totalTVL += stakingMetrics.totalStaked;
    }
    
    this.metrics.totalValueLocked = totalTVL;
    
    this.emit('metrics:updated', this.metrics);
  }
  
  // Public API
  getMetrics() {
    return {
      ...this.metrics,
      yieldFarming: this.yieldFarming?.getMetrics(),
      lending: this.lending?.getMetrics(),
      staking: this.staking?.getMetrics()
    };
  }
  
  async shutdown() {
    this.logger.info('Shutting down DeFi Core...');
    
    // Cleanup logic here
    
    this.logger.info('DeFi Core shutdown complete');
  }
}

export default DeFiCore;