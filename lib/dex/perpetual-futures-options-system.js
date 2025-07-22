import EventEmitter from 'events';
import crypto from 'crypto';

const ContractType = {
  PERPETUAL_FUTURE: 'perpetual_future',
  QUARTERLY_FUTURE: 'quarterly_future',
  CALL_OPTION: 'call_option',
  PUT_OPTION: 'put_option'
};

const PositionSide = {
  LONG: 'long',
  SHORT: 'short'
};

const OrderType = {
  MARKET: 'market',
  LIMIT: 'limit',
  STOP: 'stop',
  STOP_LIMIT: 'stop_limit',
  TAKE_PROFIT: 'take_profit',
  REDUCE_ONLY: 'reduce_only'
};

const PositionStatus = {
  OPEN: 'open',
  CLOSED: 'closed',
  LIQUIDATED: 'liquidated',
  EXPIRED: 'expired'
};

const MarginType = {
  ISOLATED: 'isolated',
  CROSS: 'cross'
};

export class PerpetualFuturesOptionsSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enablePerpetualFutures: options.enablePerpetualFutures !== false,
      enableOptions: options.enableOptions !== false,
      enableLiquidations: options.enableLiquidations !== false,
      enableFundingRates: options.enableFundingRates !== false,
      enableAutoDeleveraging: options.enableAutoDeleveraging !== false,
      maxLeverage: options.maxLeverage || 100,
      maintenanceMarginRatio: options.maintenanceMarginRatio || 0.05, // 5%
      initialMarginRatio: options.initialMarginRatio || 0.1, // 10%
      fundingInterval: options.fundingInterval || 8 * 60 * 60 * 1000, // 8 hours
      liquidationFeeRate: options.liquidationFeeRate || 0.005, // 0.5%
      maxFundingRate: options.maxFundingRate || 0.002, // 0.2%
      minOptionDTE: options.minOptionDTE || 1, // 1 day
      maxOptionDTE: options.maxOptionDTE || 365, // 1 year
      impliedVolatility: options.impliedVolatility || 0.8 // 80%
    };

    this.contracts = new Map();
    this.positions = new Map();
    this.orders = new Map();
    this.fundingRates = new Map();
    this.priceFeeds = new Map();
    this.collateral = new Map();
    this.liquidationQueue = new Map();
    
    this.isRunning = false;
    this.metrics = {
      totalContracts: 0,
      totalPositions: 0,
      totalVolume: 0,
      totalOpenInterest: 0,
      liquidations: 0,
      fundingCollected: 0,
      optionPremiums: 0,
      pnlRealized: 0
    };

    this.initializeContracts();
    this.startFundingRateCalculation();
    this.startLiquidationEngine();
    this.startPriceFeeds();
  }

  async initializeContracts() {
    try {
      const defaultContracts = [
        {
          symbol: 'BTCUSDT-PERP',
          type: ContractType.PERPETUAL_FUTURE,
          underlying: 'BTC',
          quoteCurrency: 'USDT',
          contractSize: 1,
          tickSize: 0.5,
          minOrderSize: 0.001,
          maxLeverage: 100,
          fundingRate: 0,
          markPrice: 0,
          indexPrice: 0,
          isActive: true
        },
        {
          symbol: 'ETHUSDT-PERP',
          type: ContractType.PERPETUAL_FUTURE,
          underlying: 'ETH',
          quoteCurrency: 'USDT',
          contractSize: 1,
          tickSize: 0.01,
          minOrderSize: 0.01,
          maxLeverage: 75,
          fundingRate: 0,
          markPrice: 0,
          indexPrice: 0,
          isActive: true
        },
        {
          symbol: 'BTCUSDT-240329',
          type: ContractType.QUARTERLY_FUTURE,
          underlying: 'BTC',
          quoteCurrency: 'USDT',
          contractSize: 1,
          tickSize: 0.5,
          minOrderSize: 0.001,
          maxLeverage: 50,
          expiryDate: new Date('2024-03-29').getTime(),
          isActive: true
        }
      ];

      for (const contract of defaultContracts) {
        contract.id = this.generateContractId(contract.symbol);
        this.contracts.set(contract.id, contract);
        this.fundingRates.set(contract.id, []);
        this.metrics.totalContracts++;
      }

      this.emit('contractsInitialized', this.contracts.size);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async createOption(underlying, strike, expiry, type, premium, options = {}) {
    try {
      const symbol = `${underlying}USDT-${strike}-${type.toUpperCase()}-${expiry}`;
      const contractId = this.generateContractId(symbol);

      if (this.contracts.has(contractId)) {
        throw new Error('Option contract already exists');
      }

      const expiryDate = new Date(expiry).getTime();
      const dte = Math.ceil((expiryDate - Date.now()) / (24 * 60 * 60 * 1000));

      if (dte < this.options.minOptionDTE || dte > this.options.maxOptionDTE) {
        throw new Error(`Invalid expiry date. DTE must be between ${this.options.minOptionDTE} and ${this.options.maxOptionDTE} days`);
      }

      const contract = {
        id: contractId,
        symbol,
        type,
        underlying,
        quoteCurrency: 'USDT',
        strike,
        expiryDate,
        dte,
        premium,
        impliedVolatility: this.options.impliedVolatility,
        delta: 0,
        gamma: 0,
        theta: 0,
        vega: 0,
        rho: 0,
        openInterest: 0,
        volume24h: 0,
        isActive: true,
        createdAt: Date.now()
      };

      this.contracts.set(contractId, contract);
      this.metrics.totalContracts++;

      await this.calculateOptionGreeks(contractId);

      this.emit('optionCreated', contract);
      return contractId;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async openPosition(contractId, userId, side, size, price, leverage, marginType, options = {}) {
    try {
      const contract = this.contracts.get(contractId);
      if (!contract || !contract.isActive) {
        throw new Error('Contract not found or inactive');
      }

      if (leverage > contract.maxLeverage) {
        throw new Error(`Leverage exceeds maximum of ${contract.maxLeverage}x`);
      }

      const positionId = this.generatePositionId(contractId, userId);
      const notionalValue = size * price;
      const requiredMargin = notionalValue / leverage;
      const maintenanceMargin = notionalValue * this.options.maintenanceMarginRatio;

      // Check collateral
      const userCollateral = this.collateral.get(userId) || 0;
      if (userCollateral < requiredMargin) {
        throw new Error('Insufficient collateral');
      }

      const position = {
        id: positionId,
        contractId,
        userId,
        side,
        size,
        entryPrice: price,
        markPrice: contract.markPrice || price,
        leverage,
        marginType,
        margin: requiredMargin,
        maintenanceMargin,
        unrealizedPnl: 0,
        realizedPnl: 0,
        fundingPaid: 0,
        liquidationPrice: this.calculateLiquidationPrice(side, price, leverage, maintenanceMargin, size),
        status: PositionStatus.OPEN,
        openTime: Date.now(),
        lastUpdateTime: Date.now()
      };

      this.positions.set(positionId, position);

      // Update collateral
      this.collateral.set(userId, userCollateral - requiredMargin);

      // Update metrics
      this.metrics.totalPositions++;
      this.metrics.totalOpenInterest += notionalValue;

      // Update contract open interest
      if (contract.openInterest !== undefined) {
        contract.openInterest += notionalValue;
      }

      this.emit('positionOpened', position);
      return positionId;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async closePosition(positionId, price, options = {}) {
    try {
      const position = this.positions.get(positionId);
      if (!position || position.status !== PositionStatus.OPEN) {
        throw new Error('Position not found or already closed');
      }

      const contract = this.contracts.get(position.contractId);
      if (!contract) {
        throw new Error('Contract not found');
      }

      const pnl = this.calculatePnL(position, price);
      const closingFee = (position.size * price) * 0.0005; // 0.05% closing fee

      position.realizedPnl = pnl - closingFee;
      position.status = PositionStatus.CLOSED;
      position.closeTime = Date.now();
      position.closePrice = price;

      // Return margin + PnL to user
      const returnAmount = position.margin + position.realizedPnl;
      const currentCollateral = this.collateral.get(position.userId) || 0;
      this.collateral.set(position.userId, currentCollateral + returnAmount);

      // Update metrics
      this.metrics.pnlRealized += position.realizedPnl;
      this.metrics.totalOpenInterest -= (position.size * position.entryPrice);

      // Update contract open interest
      if (contract.openInterest !== undefined) {
        contract.openInterest -= (position.size * position.entryPrice);
      }

      this.emit('positionClosed', position);
      return position;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  calculatePnL(position, currentPrice) {
    const notionalValue = position.size * position.entryPrice;
    let pnl = 0;

    if (position.side === PositionSide.LONG) {
      pnl = position.size * (currentPrice - position.entryPrice);
    } else {
      pnl = position.size * (position.entryPrice - currentPrice);
    }

    return pnl;
  }

  calculateLiquidationPrice(side, entryPrice, leverage, maintenanceMargin, size) {
    const mmr = this.options.maintenanceMarginRatio;
    
    if (side === PositionSide.LONG) {
      return entryPrice * (1 - (1 / leverage) + mmr);
    } else {
      return entryPrice * (1 + (1 / leverage) - mmr);
    }
  }

  async liquidatePosition(positionId, options = {}) {
    try {
      const position = this.positions.get(positionId);
      if (!position || position.status !== PositionStatus.OPEN) {
        return false;
      }

      const contract = this.contracts.get(position.contractId);
      if (!contract) {
        return false;
      }

      const markPrice = contract.markPrice;
      const maintenanceMarginRatio = position.maintenanceMargin / (position.size * position.entryPrice);
      
      let shouldLiquidate = false;
      
      if (position.side === PositionSide.LONG && markPrice <= position.liquidationPrice) {
        shouldLiquidate = true;
      } else if (position.side === PositionSide.SHORT && markPrice >= position.liquidationPrice) {
        shouldLiquidate = true;
      }

      if (!shouldLiquidate) {
        return false;
      }

      const liquidationFee = (position.size * markPrice) * this.options.liquidationFeeRate;
      const remainingMargin = Math.max(0, position.margin - Math.abs(this.calculatePnL(position, markPrice)) - liquidationFee);

      position.status = PositionStatus.LIQUIDATED;
      position.liquidationTime = Date.now();
      position.liquidationPrice = markPrice;
      position.liquidationFee = liquidationFee;
      position.realizedPnl = -position.margin + remainingMargin;

      // Return remaining margin if any
      if (remainingMargin > 0) {
        const currentCollateral = this.collateral.get(position.userId) || 0;
        this.collateral.set(position.userId, currentCollateral + remainingMargin);
      }

      this.metrics.liquidations++;
      this.metrics.totalOpenInterest -= (position.size * position.entryPrice);

      this.emit('positionLiquidated', position);
      return true;
    } catch (error) {
      this.emit('error', error);
      return false;
    }
  }

  startLiquidationEngine() {
    if (this.liquidationEngine) return;
    
    this.liquidationEngine = setInterval(async () => {
      try {
        for (const [positionId, position] of this.positions) {
          if (position.status === PositionStatus.OPEN) {
            await this.liquidatePosition(positionId);
          }
        }
      } catch (error) {
        this.emit('error', error);
      }
    }, 5000); // Check every 5 seconds
  }

  async calculateFundingRate(contractId) {
    try {
      const contract = this.contracts.get(contractId);
      if (!contract || contract.type !== ContractType.PERPETUAL_FUTURE) {
        return 0;
      }

      const markPrice = contract.markPrice || 0;
      const indexPrice = contract.indexPrice || 0;
      
      if (markPrice === 0 || indexPrice === 0) {
        return 0;
      }

      const premium = (markPrice - indexPrice) / indexPrice;
      const fundingRate = Math.max(-this.options.maxFundingRate, 
        Math.min(this.options.maxFundingRate, premium * 0.1)); // 10% of premium

      return fundingRate;
    } catch (error) {
      this.emit('error', error);
      return 0;
    }
  }

  startFundingRateCalculation() {
    if (this.fundingRateInterval) return;
    
    this.fundingRateInterval = setInterval(async () => {
      try {
        for (const [contractId, contract] of this.contracts) {
          if (contract.type === ContractType.PERPETUAL_FUTURE) {
            const fundingRate = await this.calculateFundingRate(contractId);
            contract.fundingRate = fundingRate;
            
            const rates = this.fundingRates.get(contractId) || [];
            rates.push({
              rate: fundingRate,
              timestamp: Date.now()
            });
            
            // Keep only last 100 funding rates
            if (rates.length > 100) {
              rates.shift();
            }
            
            this.fundingRates.set(contractId, rates);
            
            // Apply funding to positions
            await this.applyFunding(contractId, fundingRate);
          }
        }
      } catch (error) {
        this.emit('error', error);
      }
    }, this.options.fundingInterval);
  }

  async applyFunding(contractId, fundingRate) {
    try {
      const positions = Array.from(this.positions.values())
        .filter(pos => pos.contractId === contractId && pos.status === PositionStatus.OPEN);

      for (const position of positions) {
        const notionalValue = position.size * position.markPrice;
        const fundingPayment = notionalValue * fundingRate;
        
        if (position.side === PositionSide.LONG) {
          position.fundingPaid -= fundingPayment; // Longs pay funding
        } else {
          position.fundingPaid += fundingPayment; // Shorts receive funding
        }

        this.metrics.fundingCollected += Math.abs(fundingPayment);
      }

      this.emit('fundingApplied', { contractId, fundingRate, positionsAffected: positions.length });
    } catch (error) {
      this.emit('error', error);
    }
  }

  async calculateOptionGreeks(contractId) {
    try {
      const contract = this.contracts.get(contractId);
      if (!contract || (contract.type !== ContractType.CALL_OPTION && contract.type !== ContractType.PUT_OPTION)) {
        return;
      }

      const S = contract.indexPrice || 50000; // Current price
      const K = contract.strike; // Strike price
      const T = contract.dte / 365; // Time to expiry in years
      const r = 0.05; // Risk-free rate
      const sigma = contract.impliedVolatility; // Volatility

      // Black-Scholes calculations
      const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
      const d2 = d1 - sigma * Math.sqrt(T);

      const N = (x) => 0.5 * (1 + this.erf(x / Math.sqrt(2))); // Cumulative normal distribution
      const n = (x) => (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x); // Normal probability density

      if (contract.type === ContractType.CALL_OPTION) {
        contract.delta = N(d1);
        contract.premium = S * N(d1) - K * Math.exp(-r * T) * N(d2);
      } else {
        contract.delta = N(d1) - 1;
        contract.premium = K * Math.exp(-r * T) * N(-d2) - S * N(-d1);
      }

      contract.gamma = n(d1) / (S * sigma * Math.sqrt(T));
      contract.theta = -(S * n(d1) * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * 
        (contract.type === ContractType.CALL_OPTION ? N(d2) : N(-d2));
      contract.vega = S * n(d1) * Math.sqrt(T);
      contract.rho = K * T * Math.exp(-r * T) * 
        (contract.type === ContractType.CALL_OPTION ? N(d2) : -N(-d2));

      this.emit('optionGreeksUpdated', { contractId, greeks: {
        delta: contract.delta,
        gamma: contract.gamma,
        theta: contract.theta,
        vega: contract.vega,
        rho: contract.rho,
        premium: contract.premium
      }});
    } catch (error) {
      this.emit('error', error);
    }
  }

  // Error function approximation for normal distribution
  erf(x) {
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return sign * y;
  }

  startPriceFeeds() {
    if (this.priceFeedInterval) return;
    
    this.priceFeedInterval = setInterval(async () => {
      try {
        // Simulate price updates
        for (const [contractId, contract] of this.contracts) {
          const basePrice = this.getBasePrice(contract.underlying);
          const variation = (Math.random() - 0.5) * 0.02; // ±1% variation
          
          contract.indexPrice = basePrice * (1 + variation);
          contract.markPrice = contract.indexPrice * (1 + (Math.random() - 0.5) * 0.001); // ±0.05% spread

          // Update unrealized PnL for open positions
          await this.updatePositionPnL(contractId);
          
          // Update option greeks
          if (contract.type === ContractType.CALL_OPTION || contract.type === ContractType.PUT_OPTION) {
            await this.calculateOptionGreeks(contractId);
          }
        }
      } catch (error) {
        this.emit('error', error);
      }
    }, 5000); // Update every 5 seconds
  }

  getBasePrice(underlying) {
    const basePrices = {
      'BTC': 50000,
      'ETH': 3000,
      'SOL': 100,
      'AVAX': 40
    };
    return basePrices[underlying] || 1000;
  }

  async updatePositionPnL(contractId) {
    try {
      const contract = this.contracts.get(contractId);
      if (!contract) return;

      const positions = Array.from(this.positions.values())
        .filter(pos => pos.contractId === contractId && pos.status === PositionStatus.OPEN);

      for (const position of positions) {
        position.markPrice = contract.markPrice;
        position.unrealizedPnl = this.calculatePnL(position, contract.markPrice);
        position.lastUpdateTime = Date.now();
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  async exerciseOption(contractId, userId, options = {}) {
    try {
      const contract = this.contracts.get(contractId);
      if (!contract || (contract.type !== ContractType.CALL_OPTION && contract.type !== ContractType.PUT_OPTION)) {
        throw new Error('Invalid option contract');
      }

      if (contract.expiryDate <= Date.now()) {
        throw new Error('Option has expired');
      }

      const position = Array.from(this.positions.values())
        .find(pos => pos.contractId === contractId && pos.userId === userId && pos.status === PositionStatus.OPEN);

      if (!position) {
        throw new Error('No open position found');
      }

      const currentPrice = contract.indexPrice;
      let exerciseValue = 0;

      if (contract.type === ContractType.CALL_OPTION && currentPrice > contract.strike) {
        exerciseValue = (currentPrice - contract.strike) * position.size;
      } else if (contract.type === ContractType.PUT_OPTION && currentPrice < contract.strike) {
        exerciseValue = (contract.strike - currentPrice) * position.size;
      }

      if (exerciseValue <= 0) {
        throw new Error('Option is out of the money');
      }

      position.status = PositionStatus.CLOSED;
      position.realizedPnl = exerciseValue - (contract.premium * position.size);
      position.closeTime = Date.now();

      // Add exercise value to user collateral
      const currentCollateral = this.collateral.get(userId) || 0;
      this.collateral.set(userId, currentCollateral + exerciseValue);

      this.metrics.optionPremiums += contract.premium * position.size;

      this.emit('optionExercised', { contractId, userId, exerciseValue });
      return exerciseValue;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  generateContractId(symbol) {
    return crypto.createHash('sha256')
      .update(symbol + Date.now())
      .digest('hex')
      .substring(0, 16);
  }

  generatePositionId(contractId, userId) {
    return crypto.createHash('sha256')
      .update(`${contractId}-${userId}-${Date.now()}`)
      .digest('hex')
      .substring(0, 16);
  }

  async getContract(contractId) {
    return this.contracts.get(contractId) || null;
  }

  async getPosition(positionId) {
    return this.positions.get(positionId) || null;
  }

  async getUserPositions(userId, status = null) {
    const positions = Array.from(this.positions.values())
      .filter(pos => pos.userId === userId);
    
    return status ? positions.filter(pos => pos.status === status) : positions;
  }

  async getAllContracts(type = null) {
    const contracts = Array.from(this.contracts.values());
    return type ? contracts.filter(contract => contract.type === type) : contracts;
  }

  async addCollateral(userId, amount) {
    const currentAmount = this.collateral.get(userId) || 0;
    this.collateral.set(userId, currentAmount + amount);
    
    this.emit('collateralAdded', { userId, amount, totalCollateral: currentAmount + amount });
    return currentAmount + amount;
  }

  async withdrawCollateral(userId, amount) {
    const currentAmount = this.collateral.get(userId) || 0;
    
    if (currentAmount < amount) {
      throw new Error('Insufficient collateral balance');
    }

    // Check if withdrawal would cause insufficient margin for open positions
    const userPositions = await this.getUserPositions(userId, PositionStatus.OPEN);
    const totalRequiredMargin = userPositions.reduce((sum, pos) => sum + pos.margin, 0);
    
    if ((currentAmount - amount) < totalRequiredMargin) {
      throw new Error('Cannot withdraw collateral: would cause insufficient margin');
    }

    this.collateral.set(userId, currentAmount - amount);
    
    this.emit('collateralWithdrawn', { userId, amount, remainingCollateral: currentAmount - amount });
    return currentAmount - amount;
  }

  getMetrics() {
    const openPositions = Array.from(this.positions.values())
      .filter(pos => pos.status === PositionStatus.OPEN);
    
    const totalUnrealizedPnL = openPositions.reduce((sum, pos) => sum + pos.unrealizedPnl, 0);
    
    return {
      ...this.metrics,
      totalContracts: this.contracts.size,
      openPositions: openPositions.length,
      totalUnrealizedPnL,
      averagePosition: openPositions.length > 0 ? this.metrics.totalOpenInterest / openPositions.length : 0,
      liquidationRatio: this.metrics.totalPositions > 0 ? (this.metrics.liquidations / this.metrics.totalPositions) * 100 : 0
    };
  }

  async stop() {
    this.isRunning = false;
    
    if (this.liquidationEngine) {
      clearInterval(this.liquidationEngine);
      this.liquidationEngine = null;
    }
    
    if (this.fundingRateInterval) {
      clearInterval(this.fundingRateInterval);
      this.fundingRateInterval = null;
    }
    
    if (this.priceFeedInterval) {
      clearInterval(this.priceFeedInterval);
      this.priceFeedInterval = null;
    }
    
    this.emit('stopped');
  }
}

export { ContractType, PositionSide, OrderType, PositionStatus, MarginType };