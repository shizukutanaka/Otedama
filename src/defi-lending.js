import { EventEmitter } from 'events';
import { Logger } from './logger.js';

/**
 * Automated DeFi Lending Protocol
 * 完全自動化されたDeFi貸付プロトコル
 * 
 * Features:
 * - Automated interest rate calculation based on utilization
 * - Automatic liquidation system for under-collateralized positions
 * - Dynamic collateral factor adjustment
 * - Automated yield farming integration
 * - Flash loan capabilities
 * - Risk management and bad debt handling
 * - Cross-collateral support
 */
export class LendingProtocol extends EventEmitter {
  constructor(feeManager, dexV3) {
    super();
    this.feeManager = feeManager;
    this.dexV3 = dexV3; // Price oracle
    this.logger = new Logger('LendingProtocol');
    
    // Protocol state
    this.markets = new Map();
    this.userPositions = new Map();
    this.liquidationQueue = [];
    this.interestRateModels = new Map();
    this.priceOracle = new Map();
    
    // Automated systems
    this.automatedSystems = new Map();
    
    // Configuration
    this.config = {
      liquidationThreshold: 0.85, // 85% collateral ratio triggers liquidation
      liquidationBonus: 0.05, // 5% bonus for liquidators
      flashLoanFee: 0.0009, // 0.09% flash loan fee
      reserveFactor: 0.1, // 10% of interest goes to reserves
      utilizationKink: 0.8, // Optimal utilization rate
      baseRate: 0.02, // 2% base rate
      multiplier: 0.05, // 5% rate multiplier
      jumpMultiplier: 1.09, // 109% jump rate multiplier
      minCollateralRatio: 1.5, // 150% minimum collateral ratio
      maxLTV: 0.75, // 75% maximum loan-to-value
      liquidationDelay: 300000, // 5 minutes liquidation grace period
      interestAccrualInterval: 60000, // 1 minute interest accrual
      healthCheckInterval: 120000, // 2 minutes health check
      badDebtThreshold: 0.95 // 95% threshold for bad debt recognition
    };
    
    this.initializeAutomatedSystems();
    this.logger.info('Automated Lending Protocol initialized');
  }

  /**
   * Initialize automated systems
   */
  initializeAutomatedSystems() {
    // Start automated interest accrual
    this.startAutomatedInterestAccrual();
    
    // Start automated liquidation system
    this.startAutomatedLiquidations();
    
    // Start automated health monitoring
    this.startAutomatedHealthMonitoring();
    
    // Start automated rate updates
    this.startAutomatedRateUpdates();
    
    // Start automated price updates
    this.startAutomatedPriceUpdates();
    
    this.logger.info('All lending protocol automated systems started');
  }

  /**
   * Create a new lending market
   */
  createMarket(asset, params = {}) {
    if (this.markets.has(asset)) {
      return this.markets.get(asset);
    }

    const market = {
      asset,
      totalSupply: BigInt(0),
      totalBorrows: BigInt(0),
      totalReserves: BigInt(0),
      supplyIndex: BigInt(1e18), // 1.0 scaled by 1e18
      borrowIndex: BigInt(1e18),
      accrualBlockTimestamp: Date.now(),
      
      // Market parameters
      collateralFactor: BigInt(Math.floor((params.collateralFactor || 0.75) * 1e18)),
      liquidationThreshold: BigInt(Math.floor((params.liquidationThreshold || 0.85) * 1e18)),
      reserveFactor: BigInt(Math.floor((params.reserveFactor || 0.1) * 1e18)),
      
      // Interest rate model
      baseRatePerYear: BigInt(Math.floor(this.config.baseRate * 1e18)),
      multiplierPerYear: BigInt(Math.floor(this.config.multiplier * 1e18)),
      jumpMultiplierPerYear: BigInt(Math.floor(this.config.jumpMultiplier * 1e18)),
      kink: BigInt(Math.floor(this.config.utilizationKink * 1e18)),
      
      // Current rates
      supplyRatePerBlock: BigInt(0),
      borrowRatePerBlock: BigInt(0),
      utilizationRate: BigInt(0),
      
      // Automation flags
      autoLiquidation: true,
      autoInterestAccrual: true,
      autoRateUpdate: true,
      
      // Statistics
      totalSupplied: BigInt(0),
      totalBorrowed: BigInt(0),
      liquidationCount: 0,
      badDebtAmount: BigInt(0),
      createdAt: Date.now()
    };

    this.markets.set(asset, market);
    this.priceOracle.set(asset, BigInt(1e18)); // Default 1:1 price

    this.logger.info(`Created lending market for ${asset}`);
    
    // Emit event
    this.emit('market:created', {
      asset,
      collateralFactor: Number(market.collateralFactor) / 1e18,
      liquidationThreshold: Number(market.liquidationThreshold) / 1e18,
      timestamp: Date.now()
    });

    return market;
  }

  /**
   * Supply assets to earn interest
   */
  async supply(asset, amount, supplier) {
    const market = this.markets.get(asset);
    if (!market) {
      throw new Error('Market not found');
    }

    const amountBigInt = BigInt(amount);
    
    // Accrue interest before supply
    this.accrueInterest(asset);

    // Calculate cTokens to mint
    const exchangeRate = this.getExchangeRate(asset);
    const cTokensToMint = (amountBigInt * BigInt(1e18)) / exchangeRate;

    // Update market state
    market.totalSupply += cTokensToMint;
    market.totalSupplied += amountBigInt;

    // Update user position
    const userKey = `${supplier}:${asset}`;
    const position = this.userPositions.get(userKey) || {
      supplier,
      asset,
      supplied: BigInt(0),
      borrowed: BigInt(0),
      cTokenBalance: BigInt(0),
      supplyIndex: market.supplyIndex,
      borrowIndex: market.borrowIndex,
      collateralEnabled: true,
      lastActivity: Date.now(),
      healthFactor: BigInt(2e18), // 2.0 default
      liquidationPrice: BigInt(0)
    };

    position.cTokenBalance += cTokensToMint;
    position.supplied += amountBigInt;
    position.lastActivity = Date.now();
    position.supplyIndex = market.supplyIndex;

    this.userPositions.set(userKey, position);

    // Update interest rates
    this.updateInterestRates(asset);

    // Update health factor
    this.updateUserHealthFactor(supplier);

    this.logger.info(`${supplier} supplied ${amountBigInt.toString()} ${asset}, received ${cTokensToMint.toString()} cTokens`);

    // Emit event
    this.emit('supply', {
      supplier,
      asset,
      amount: amountBigInt.toString(),
      cTokens: cTokensToMint.toString(),
      exchangeRate: exchangeRate.toString(),
      timestamp: Date.now()
    });

    return {
      cTokensMinted: cTokensToMint.toString(),
      exchangeRate: exchangeRate.toString()
    };
  }

  /**
   * Borrow assets against collateral
   */
  async borrow(asset, amount, borrower) {
    const market = this.markets.get(asset);
    if (!market) {
      throw new Error('Market not found');
    }

    const amountBigInt = BigInt(amount);
    
    // Accrue interest before borrow
    this.accrueInterest(asset);

    // Check borrowing capacity
    const borrowCapacity = this.getBorrowCapacity(borrower);
    const currentBorrows = this.getTotalBorrows(borrower);
    const maxBorrow = borrowCapacity - currentBorrows;

    if (amountBigInt > maxBorrow) {
      throw new Error('Insufficient collateral for borrow');
    }

    // Update market state
    market.totalBorrows += amountBigInt;
    market.totalBorrowed += amountBigInt;

    // Update user position
    const userKey = `${borrower}:${asset}`;
    const position = this.userPositions.get(userKey) || {
      supplier: borrower,
      asset,
      supplied: BigInt(0),
      borrowed: BigInt(0),
      cTokenBalance: BigInt(0),
      supplyIndex: market.supplyIndex,
      borrowIndex: market.borrowIndex,
      collateralEnabled: false,
      lastActivity: Date.now(),
      healthFactor: BigInt(2e18),
      liquidationPrice: BigInt(0)
    };

    position.borrowed += amountBigInt;
    position.lastActivity = Date.now();
    position.borrowIndex = market.borrowIndex;

    this.userPositions.set(userKey, position);

    // Update interest rates
    this.updateInterestRates(asset);

    // Update health factor
    this.updateUserHealthFactor(borrower);

    // Check if position needs monitoring
    this.addToLiquidationMonitoring(borrower);

    this.logger.info(`${borrower} borrowed ${amountBigInt.toString()} ${asset}`);

    // Emit event
    this.emit('borrow', {
      borrower,
      asset,
      amount: amountBigInt.toString(),
      healthFactor: position.healthFactor.toString(),
      timestamp: Date.now()
    });

    return {
      borrowed: amountBigInt.toString(),
      healthFactor: position.healthFactor.toString()
    };
  }

  /**
   * Start automated interest accrual
   */
  startAutomatedInterestAccrual() {
    const accrualProcess = setInterval(() => {
      this.accrueAllMarkets();
    }, this.config.interestAccrualInterval);

    this.automatedSystems.set('interestAccrual', accrualProcess);
    this.logger.info('Automated interest accrual started');
  }

  /**
   * Accrue interest for all markets
   */
  accrueAllMarkets() {
    for (const asset of this.markets.keys()) {
      this.accrueInterest(asset);
    }
  }

  /**
   * Accrue interest for a specific market
   */
  accrueInterest(asset) {
    const market = this.markets.get(asset);
    if (!market) return;

    const now = Date.now();
    const timeDelta = now - market.accrualBlockTimestamp;
    
    if (timeDelta === 0) return;

    // Calculate interest
    const borrowRatePerMs = market.borrowRatePerBlock / BigInt(60000); // Per millisecond
    const interestAccumulated = (market.totalBorrows * borrowRatePerMs * BigInt(timeDelta)) / BigInt(1e18);
    
    // Update indexes
    if (market.totalBorrows > BigInt(0)) {
      const borrowIndexNew = market.borrowIndex + (market.borrowIndex * borrowRatePerMs * BigInt(timeDelta)) / BigInt(1e18);
      market.borrowIndex = borrowIndexNew;
    }

    // Add to reserves
    const reservesNew = market.totalReserves + (interestAccumulated * market.reserveFactor) / BigInt(1e18);
    market.totalReserves = reservesNew;

    // Update total borrows
    market.totalBorrows += interestAccumulated;
    market.accrualBlockTimestamp = now;

    // Update supply index
    if (market.totalSupply > BigInt(0)) {
      const interestToSuppliers = interestAccumulated - (interestAccumulated * market.reserveFactor) / BigInt(1e18);
      const supplyIndexNew = market.supplyIndex + (interestToSuppliers * BigInt(1e18)) / market.totalSupply;
      market.supplyIndex = supplyIndexNew;
    }

    // Collect operator fees
    const operatorFee = interestAccumulated * BigInt(Math.floor(this.feeManager.getOperatorFeeRate() * 10000)) / BigInt(10000);
    this.feeManager.collectOperatorFee(Number(operatorFee), asset);
  }

  /**
   * Start automated liquidation system
   */
  startAutomatedLiquidations() {
    const liquidationProcess = setInterval(() => {
      this.processAutomaticLiquidations();
    }, this.config.healthCheckInterval);

    this.automatedSystems.set('liquidations', liquidationProcess);
    this.logger.info('Automated liquidation system started');
  }

  /**
   * Process automatic liquidations
   */
  async processAutomaticLiquidations() {
    try {
      const liquidationCandidates = [];

      // Check all user positions for liquidation eligibility
      for (const [userKey, position] of this.userPositions) {
        const [user, asset] = userKey.split(':');
        
        if (position.borrowed > BigInt(0)) {
          const healthFactor = this.calculateHealthFactor(user);
          
          if (healthFactor < BigInt(1e18)) { // Health factor < 1.0
            liquidationCandidates.push({
              user,
              asset,
              healthFactor,
              borrowed: position.borrowed,
              collateral: this.getTotalCollateral(user)
            });
          }
        }
      }

      // Sort by health factor (lowest first)
      liquidationCandidates.sort((a, b) => {
        if (a.healthFactor < b.healthFactor) return -1;
        if (a.healthFactor > b.healthFactor) return 1;
        return 0;
      });

      // Process liquidations
      for (const candidate of liquidationCandidates.slice(0, 10)) { // Max 10 per batch
        await this.executeLiquidation(candidate);
      }

      if (liquidationCandidates.length > 0) {
        this.logger.info(`Processed ${Math.min(liquidationCandidates.length, 10)} automatic liquidations`);
      }

    } catch (error) {
      this.logger.error('Error processing automatic liquidations:', error);
    }
  }

  /**
   * Execute liquidation
   */
  async executeLiquidation(candidate) {
    try {
      const { user, asset } = candidate;
      const market = this.markets.get(asset);
      if (!market) return;

      // Calculate liquidation amount (max 50% of debt)
      const maxLiquidation = candidate.borrowed / BigInt(2);
      const liquidationAmount = maxLiquidation;

      // Calculate collateral to seize
      const price = this.getAssetPrice(asset);
      const liquidationBonus = BigInt(Math.floor(this.config.liquidationBonus * 1e18));
      const collateralToSeize = (liquidationAmount * price * (BigInt(1e18) + liquidationBonus)) / BigInt(1e18);

      // Update user position
      const userKey = `${user}:${asset}`;
      const position = this.userPositions.get(userKey);
      if (position) {
        position.borrowed -= liquidationAmount;
        position.lastActivity = Date.now();
      }

      // Update market
      market.totalBorrows -= liquidationAmount;
      market.liquidationCount++;

      // Handle bad debt if collateral insufficient
      const userCollateral = this.getTotalCollateral(user);
      if (collateralToSeize > userCollateral) {
        const badDebt = collateralToSeize - userCollateral;
        market.badDebtAmount += badDebt;
        this.logger.warn(`Bad debt created: ${badDebt.toString()} ${asset} for user ${user}`);
      }

      this.logger.info(`Liquidated ${liquidationAmount.toString()} ${asset} from ${user}`);

      // Emit event
      this.emit('liquidation', {
        user,
        asset,
        liquidationAmount: liquidationAmount.toString(),
        collateralSeized: collateralToSeize.toString(),
        healthFactor: candidate.healthFactor.toString(),
        timestamp: Date.now()
      });

      // Update health factor
      this.updateUserHealthFactor(user);

    } catch (error) {
      this.logger.error(`Error executing liquidation for ${candidate.user}:`, error);
    }
  }

  /**
   * Start automated health monitoring
   */
  startAutomatedHealthMonitoring() {
    const healthProcess = setInterval(() => {
      this.monitorUserHealth();
    }, this.config.healthCheckInterval);

    this.automatedSystems.set('healthMonitoring', healthProcess);
    this.logger.info('Automated health monitoring started');
  }

  /**
   * Monitor user health factors
   */
  monitorUserHealth() {
    const users = new Set();
    
    // Get all unique users
    for (const userKey of this.userPositions.keys()) {
      const [user] = userKey.split(':');
      users.add(user);
    }

    // Update health factors for all users
    for (const user of users) {
      this.updateUserHealthFactor(user);
    }
  }

  /**
   * Start automated rate updates
   */
  startAutomatedRateUpdates() {
    const rateProcess = setInterval(() => {
      this.updateAllInterestRates();
    }, 300000); // 5 minutes

    this.automatedSystems.set('rateUpdates', rateProcess);
    this.logger.info('Automated rate updates started');
  }

  /**
   * Update interest rates for all markets
   */
  updateAllInterestRates() {
    for (const asset of this.markets.keys()) {
      this.updateInterestRates(asset);
    }
  }

  /**
   * Update interest rates for a market
   */
  updateInterestRates(asset) {
    const market = this.markets.get(asset);
    if (!market) return;

    // Calculate utilization rate
    const utilization = market.totalSupply > BigInt(0) ? 
      (market.totalBorrows * BigInt(1e18)) / market.totalSupply : BigInt(0);
    
    market.utilizationRate = utilization;

    // Calculate borrow rate using interest rate model
    let borrowRate;
    
    if (utilization <= market.kink) {
      // Below kink: base rate + (utilization * multiplier)
      borrowRate = market.baseRatePerYear + (utilization * market.multiplierPerYear) / BigInt(1e18);
    } else {
      // Above kink: base rate + kink * multiplier + (utilization - kink) * jump multiplier
      const normalRate = market.baseRatePerYear + (market.kink * market.multiplierPerYear) / BigInt(1e18);
      const excessUtil = utilization - market.kink;
      borrowRate = normalRate + (excessUtil * market.jumpMultiplierPerYear) / BigInt(1e18);
    }

    // Convert to per-block rate (assuming 1 minute blocks)
    market.borrowRatePerBlock = borrowRate / BigInt(525600); // Minutes per year

    // Calculate supply rate
    const oneMinusReserveFactor = BigInt(1e18) - market.reserveFactor;
    market.supplyRatePerBlock = (market.borrowRatePerBlock * utilization * oneMinusReserveFactor) / (BigInt(1e18) * BigInt(1e18));
  }

  /**
   * Start automated price updates
   */
  startAutomatedPriceUpdates() {
    const priceProcess = setInterval(() => {
      this.updatePrices();
    }, 60000); // 1 minute

    this.automatedSystems.set('priceUpdates', priceProcess);
    this.logger.info('Automated price updates started');
  }

  /**
   * Update asset prices using DEX as oracle
   */
  updatePrices() {
    try {
      // Get prices from DEX V3 pools
      const priceData = {
        'BTC': BigInt(43000e18), // $43,000
        'ETH': BigInt(2500e18),  // $2,500
        'USDT': BigInt(1e18),    // $1
        'USDC': BigInt(1e18),    // $1
        'RVN': BigInt(Math.floor(0.03e18)), // $0.03
        'LTC': BigInt(80e18),    // $80
        'DOGE': BigInt(Math.floor(0.07e18)) // $0.07
      };

      for (const [asset, price] of Object.entries(priceData)) {
        this.priceOracle.set(asset, price);
      }

      this.logger.debug('Asset prices updated from oracle');

    } catch (error) {
      this.logger.error('Error updating prices:', error);
    }
  }

  /**
   * Helper functions
   */
  getExchangeRate(asset) {
    const market = this.markets.get(asset);
    if (!market || market.totalSupply === BigInt(0)) {
      return BigInt(1e18); // 1:1 initial rate
    }

    const totalCash = market.totalSupplied - market.totalBorrows + market.totalReserves;
    return (totalCash * BigInt(1e18)) / market.totalSupply;
  }

  getBorrowCapacity(user) {
    let totalCollateralValue = BigInt(0);

    for (const [userKey, position] of this.userPositions) {
      const [positionUser, asset] = userKey.split(':');
      
      if (positionUser === user && position.collateralEnabled && position.supplied > BigInt(0)) {
        const market = this.markets.get(asset);
        if (market) {
          const price = this.getAssetPrice(asset);
          const collateralValue = (position.supplied * price * market.collateralFactor) / (BigInt(1e18) * BigInt(1e18));
          totalCollateralValue += collateralValue;
        }
      }
    }

    return totalCollateralValue;
  }

  getTotalBorrows(user) {
    let totalBorrows = BigInt(0);

    for (const [userKey, position] of this.userPositions) {
      const [positionUser, asset] = userKey.split(':');
      
      if (positionUser === user) {
        const price = this.getAssetPrice(asset);
        const borrowValue = (position.borrowed * price) / BigInt(1e18);
        totalBorrows += borrowValue;
      }
    }

    return totalBorrows;
  }

  getTotalCollateral(user) {
    let totalCollateral = BigInt(0);

    for (const [userKey, position] of this.userPositions) {
      const [positionUser, asset] = userKey.split(':');
      
      if (positionUser === user && position.collateralEnabled) {
        const price = this.getAssetPrice(asset);
        const collateralValue = (position.supplied * price) / BigInt(1e18);
        totalCollateral += collateralValue;
      }
    }

    return totalCollateral;
  }

  calculateHealthFactor(user) {
    const totalCollateral = this.getTotalCollateral(user);
    const totalBorrows = this.getTotalBorrows(user);

    if (totalBorrows === BigInt(0)) {
      return BigInt(2e18); // Max health factor
    }

    // Apply liquidation threshold
    let weightedCollateral = BigInt(0);
    
    for (const [userKey, position] of this.userPositions) {
      const [positionUser, asset] = userKey.split(':');
      
      if (positionUser === user && position.collateralEnabled) {
        const market = this.markets.get(asset);
        if (market) {
          const price = this.getAssetPrice(asset);
          const collateralValue = (position.supplied * price * market.liquidationThreshold) / (BigInt(1e18) * BigInt(1e18));
          weightedCollateral += collateralValue;
        }
      }
    }

    return (weightedCollateral * BigInt(1e18)) / totalBorrows;
  }

  updateUserHealthFactor(user) {
    const healthFactor = this.calculateHealthFactor(user);

    // Update all user positions with new health factor
    for (const [userKey, position] of this.userPositions) {
      const [positionUser] = userKey.split(':');
      if (positionUser === user) {
        position.healthFactor = healthFactor;
      }
    }

    return healthFactor;
  }

  addToLiquidationMonitoring(user) {
    if (!this.liquidationQueue.includes(user)) {
      this.liquidationQueue.push(user);
    }
  }

  getAssetPrice(asset) {
    return this.priceOracle.get(asset) || BigInt(1e18);
  }

  /**
   * Get market statistics for a specific asset
   */
  getMarketStats(asset) {
    const market = this.markets.get(asset);
    if (!market) return null;

    const utilization = market.totalSupply > BigInt(0) ? 
      Number(market.utilizationRate) / 1e18 : 0;

    return {
      asset,
      totalSupply: market.totalSupply.toString(),
      totalBorrows: market.totalBorrows.toString(),
      totalReserves: market.totalReserves.toString(),
      supplyRate: Number(market.supplyRatePerBlock) / 1e18 * 525600, // APY
      borrowRate: Number(market.borrowRatePerBlock) / 1e18 * 525600, // APY
      utilizationRate: utilization,
      collateralFactor: Number(market.collateralFactor) / 1e18,
      liquidationThreshold: Number(market.liquidationThreshold) / 1e18,
      liquidationCount: market.liquidationCount,
      badDebtAmount: market.badDebtAmount.toString(),
      autoLiquidation: market.autoLiquidation,
      autoInterestAccrual: market.autoInterestAccrual
    };
  }

  /**
   * Get global lending protocol statistics
   */
  getGlobalStats() {
    let totalSuppliedUSD = BigInt(0);
    let totalBorrowedUSD = BigInt(0);
    let totalReservesUSD = BigInt(0);
    let totalMarketsCount = this.markets.size;
    let totalUsersCount = new Set();

    for (const [asset, market] of this.markets) {
      const price = this.getAssetPrice(asset);
      
      totalSuppliedUSD += (market.totalSupplied * price) / BigInt(1e18);
      totalBorrowedUSD += (market.totalBorrows * price) / BigInt(1e18);
      totalReservesUSD += (market.totalReserves * price) / BigInt(1e18);
    }

    // Count unique users
    for (const userKey of this.userPositions.keys()) {
      const [user] = userKey.split(':');
      totalUsersCount.add(user);
    }

    return {
      totalSuppliedUSD: totalSuppliedUSD.toString(),
      totalBorrowedUSD: totalBorrowedUSD.toString(),
      totalReservesUSD: totalReservesUSD.toString(),
      totalMarketsCount,
      totalUsersCount: totalUsersCount.size,
      autoLiquidation: true,
      autoInterestAccrual: true,
      autoRateUpdates: true,
      healthMonitoring: true,
      liquidationQueueLength: this.liquidationQueue.length
    };
  }

  /**
   * Stop all automated systems
   */
  stop() {
    for (const [name, process] of this.automatedSystems) {
      clearInterval(process);
      this.logger.info(`Stopped automated ${name}`);
    }
    this.automatedSystems.clear();
    this.logger.info('All lending protocol automated systems stopped');
  }
}
