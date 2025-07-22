import EventEmitter from 'events';
import crypto from 'crypto';

const ArbitrageType = {
  DEX_ARBITRAGE: 'dex_arbitrage',
  CROSS_CHAIN: 'cross_chain',
  LENDING_RATE: 'lending_rate',
  LIQUIDATION: 'liquidation',
  TRIANGULAR: 'triangular',
  STATISTICAL: 'statistical'
};

const FlashLoanProvider = {
  AAVE: 'aave',
  DYDX: 'dydx',
  COMPOUND: 'compound',
  BALANCER: 'balancer',
  UNISWAP: 'uniswap'
};

const OpportunityStatus = {
  DETECTED: 'detected',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  EXPIRED: 'expired'
};

const RiskLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  EXTREME: 'extreme'
};

export class FlashLoanArbitrageSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableArbitrageDetection: options.enableArbitrageDetection !== false,
      enableRiskManagement: options.enableRiskManagement !== false,
      enableMultiHopArbitrage: options.enableMultiHopArbitrage !== false,
      enableCrossChainArbitrage: options.enableCrossChainArbitrage !== false,
      enableMEVProtection: options.enableMEVProtection !== false,
      minProfitThreshold: options.minProfitThreshold || 0.005, // 0.5%
      maxGasPrice: options.maxGasPrice || 100, // 100 gwei
      maxSlippage: options.maxSlippage || 0.02, // 2%
      opportunityTTL: options.opportunityTTL || 30000, // 30 seconds
      maxFlashLoanAmount: options.maxFlashLoanAmount || 1000000, // $1M
      flashLoanFee: options.flashLoanFee || 0.0009, // 0.09%
      executionTimeout: options.executionTimeout || 60000, // 60 seconds
      riskScoreThreshold: options.riskScoreThreshold || 7.0
    };

    this.opportunities = new Map();
    this.providers = new Map();
    this.exchanges = new Map();
    this.priceFeeds = new Map();
    this.executionHistory = new Map();
    this.riskMetrics = new Map();
    
    this.isRunning = false;
    this.metrics = {
      totalOpportunities: 0,
      successfulTrades: 0,
      failedTrades: 0,
      totalProfit: 0,
      totalVolume: 0,
      averageProfit: 0,
      successRate: 0,
      gasSpent: 0,
      mevAttacks: 0
    };

    this.initializeProviders();
    this.initializeExchanges();
    this.startOpportunityScanner();
    this.startPriceFeeds();
    this.startRiskMonitoring();
  }

  initializeProviders() {
    const providers = [
      {
        name: FlashLoanProvider.AAVE,
        fee: 0.0009, // 0.09%
        maxAmount: 1000000,
        supportedTokens: ['USDC', 'USDT', 'DAI', 'WETH', 'WBTC'],
        gasEstimate: 150000,
        reliability: 0.98
      },
      {
        name: FlashLoanProvider.DYDX,
        fee: 0.0000, // 0%
        maxAmount: 500000,
        supportedTokens: ['USDC', 'WETH', 'DAI'],
        gasEstimate: 200000,
        reliability: 0.95
      },
      {
        name: FlashLoanProvider.BALANCER,
        fee: 0.0000, // 0%
        maxAmount: 2000000,
        supportedTokens: ['USDC', 'USDT', 'DAI', 'WETH', 'WBTC', 'BAL'],
        gasEstimate: 180000,
        reliability: 0.96
      },
      {
        name: FlashLoanProvider.COMPOUND,
        fee: 0.0010, // 0.1%
        maxAmount: 750000,
        supportedTokens: ['USDC', 'USDT', 'DAI', 'WETH'],
        gasEstimate: 160000,
        reliability: 0.97
      }
    ];

    providers.forEach(provider => {
      this.providers.set(provider.name, provider);
    });
  }

  initializeExchanges() {
    const exchanges = [
      {
        name: 'Uniswap V3',
        fee: 0.003, // 0.3% average
        liquidity: 5000000000,
        gasEstimate: 120000,
        slippage: 0.001
      },
      {
        name: 'Sushiswap',
        fee: 0.003,
        liquidity: 2000000000,
        gasEstimate: 110000,
        slippage: 0.002
      },
      {
        name: 'Curve',
        fee: 0.0004,
        liquidity: 8000000000,
        gasEstimate: 200000,
        slippage: 0.0005
      },
      {
        name: 'Balancer V2',
        fee: 0.002,
        liquidity: 1500000000,
        gasEstimate: 150000,
        slippage: 0.003
      },
      {
        name: '1inch',
        fee: 0.001,
        liquidity: 10000000000,
        gasEstimate: 300000,
        slippage: 0.0015
      }
    ];

    exchanges.forEach(exchange => {
      this.exchanges.set(exchange.name, exchange);
    });
  }

  async detectArbitrageOpportunities() {
    try {
      const opportunities = [];
      
      // DEX arbitrage detection
      const dexOpportunities = await this.detectDEXArbitrage();
      opportunities.push(...dexOpportunities);

      // Cross-chain arbitrage
      if (this.options.enableCrossChainArbitrage) {
        const crossChainOpportunities = await this.detectCrossChainArbitrage();
        opportunities.push(...crossChainOpportunities);
      }

      // Triangular arbitrage
      const triangularOpportunities = await this.detectTriangularArbitrage();
      opportunities.push(...triangularOpportunities);

      // Liquidation arbitrage
      const liquidationOpportunities = await this.detectLiquidationArbitrage();
      opportunities.push(...liquidationOpportunities);

      // Lending rate arbitrage
      const lendingOpportunities = await this.detectLendingRateArbitrage();
      opportunities.push(...lendingOpportunities);

      // Filter and score opportunities
      const scoredOpportunities = await this.scoreOpportunities(opportunities);
      
      for (const opportunity of scoredOpportunities) {
        if (opportunity.profitability > this.options.minProfitThreshold) {
          await this.addOpportunity(opportunity);
        }
      }

      return scoredOpportunities;
    } catch (error) {
      this.emit('error', error);
      return [];
    }
  }

  async detectDEXArbitrage() {
    try {
      const opportunities = [];
      const tokens = ['USDC', 'USDT', 'DAI', 'WETH', 'WBTC'];
      const exchangeList = Array.from(this.exchanges.keys());

      for (const token of tokens) {
        const prices = await this.getTokenPricesAcrossExchanges(token);
        
        for (let i = 0; i < exchangeList.length; i++) {
          for (let j = i + 1; j < exchangeList.length; j++) {
            const exchangeA = exchangeList[i];
            const exchangeB = exchangeList[j];
            
            const priceA = prices[exchangeA];
            const priceB = prices[exchangeB];
            
            if (!priceA || !priceB) continue;

            const priceDiff = Math.abs(priceA - priceB) / Math.min(priceA, priceB);
            
            if (priceDiff > 0.002) { // 0.2% minimum difference
              const buyExchange = priceA < priceB ? exchangeA : exchangeB;
              const sellExchange = priceA < priceB ? exchangeB : exchangeA;
              const buyPrice = Math.min(priceA, priceB);
              const sellPrice = Math.max(priceA, priceB);

              opportunities.push({
                type: ArbitrageType.DEX_ARBITRAGE,
                token,
                buyExchange,
                sellExchange,
                buyPrice,
                sellPrice,
                priceDifference: priceDiff,
                estimatedProfit: priceDiff - this.calculateTotalFees(buyExchange, sellExchange),
                detectedAt: Date.now(),
                ttl: this.options.opportunityTTL
              });
            }
          }
        }
      }

      return opportunities;
    } catch (error) {
      this.emit('error', error);
      return [];
    }
  }

  async detectTriangularArbitrage() {
    try {
      const opportunities = [];
      const tokens = ['USDC', 'WETH', 'WBTC'];
      
      // Example: USDC -> WETH -> WBTC -> USDC
      for (const exchange of this.exchanges.keys()) {
        for (let i = 0; i < tokens.length; i++) {
          for (let j = 0; j < tokens.length; j++) {
            for (let k = 0; k < tokens.length; k++) {
              if (i === j || j === k || i === k) continue;
              
              const tokenA = tokens[i];
              const tokenB = tokens[j];
              const tokenC = tokens[k];
              
              const priceAB = await this.getExchangeRate(exchange, tokenA, tokenB);
              const priceBC = await this.getExchangeRate(exchange, tokenB, tokenC);
              const priceCA = await this.getExchangeRate(exchange, tokenC, tokenA);
              
              if (!priceAB || !priceBC || !priceCA) continue;
              
              const cyclePrice = priceAB * priceBC * priceCA;
              const profit = cyclePrice - 1.0;
              
              if (profit > 0.005) { // 0.5% minimum profit
                opportunities.push({
                  type: ArbitrageType.TRIANGULAR,
                  exchange,
                  path: [tokenA, tokenB, tokenC, tokenA],
                  prices: [priceAB, priceBC, priceCA],
                  cyclePrice,
                  estimatedProfit: profit - this.calculateTriangularFees(exchange),
                  detectedAt: Date.now(),
                  ttl: this.options.opportunityTTL
                });
              }
            }
          }
        }
      }

      return opportunities;
    } catch (error) {
      this.emit('error', error);
      return [];
    }
  }

  async detectCrossChainArbitrage() {
    try {
      const opportunities = [];
      const tokens = ['USDC', 'WETH'];
      const chains = ['ethereum', 'polygon', 'arbitrum', 'bsc'];

      for (const token of tokens) {
        const chainPrices = {};
        
        for (const chain of chains) {
          chainPrices[chain] = await this.getTokenPriceOnChain(token, chain);
        }

        for (let i = 0; i < chains.length; i++) {
          for (let j = i + 1; j < chains.length; j++) {
            const chainA = chains[i];
            const chainB = chains[j];
            
            const priceA = chainPrices[chainA];
            const priceB = chainPrices[chainB];
            
            if (!priceA || !priceB) continue;

            const priceDiff = Math.abs(priceA - priceB) / Math.min(priceA, priceB);
            
            if (priceDiff > 0.01) { // 1% minimum for cross-chain
              const buyChain = priceA < priceB ? chainA : chainB;
              const sellChain = priceA < priceB ? chainB : chainA;
              const bridgeFee = await this.getBridgeFee(token, buyChain, sellChain);

              opportunities.push({
                type: ArbitrageType.CROSS_CHAIN,
                token,
                buyChain,
                sellChain,
                buyPrice: Math.min(priceA, priceB),
                sellPrice: Math.max(priceA, priceB),
                priceDifference: priceDiff,
                bridgeFee,
                estimatedProfit: priceDiff - bridgeFee - 0.002, // Additional risk premium
                detectedAt: Date.now(),
                ttl: this.options.opportunityTTL * 2 // Longer TTL for cross-chain
              });
            }
          }
        }
      }

      return opportunities;
    } catch (error) {
      this.emit('error', error);
      return [];
    }
  }

  async detectLiquidationArbitrage() {
    try {
      const opportunities = [];
      
      // Simulate liquidation opportunities
      const protocols = ['Aave', 'Compound', 'MakerDAO'];
      
      for (const protocol of protocols) {
        const liquidations = await this.getLiquidationOpportunities(protocol);
        
        for (const liquidation of liquidations) {
          const discountRate = liquidation.discount || 0.05; // 5% discount
          const liquidationFee = 0.005; // 0.5% fee
          const estimatedProfit = discountRate - liquidationFee;
          
          if (estimatedProfit > this.options.minProfitThreshold) {
            opportunities.push({
              type: ArbitrageType.LIQUIDATION,
              protocol,
              asset: liquidation.asset,
              collateralAmount: liquidation.collateralAmount,
              debtAmount: liquidation.debtAmount,
              discount: discountRate,
              estimatedProfit,
              healthFactor: liquidation.healthFactor,
              detectedAt: Date.now(),
              ttl: 60000 // 1 minute TTL for liquidations
            });
          }
        }
      }

      return opportunities;
    } catch (error) {
      this.emit('error', error);
      return [];
    }
  }

  async detectLendingRateArbitrage() {
    try {
      const opportunities = [];
      const tokens = ['USDC', 'DAI', 'USDT'];
      const protocols = ['Aave', 'Compound', 'Yearn'];

      for (const token of tokens) {
        const rates = {};
        
        for (const protocol of protocols) {
          rates[protocol] = await this.getLendingRate(protocol, token);
        }

        for (let i = 0; i < protocols.length; i++) {
          for (let j = i + 1; j < protocols.length; j++) {
            const protocolA = protocols[i];
            const protocolB = protocols[j];
            
            const rateA = rates[protocolA];
            const rateB = rates[protocolB];
            
            if (!rateA || !rateB) continue;

            const rateDiff = Math.abs(rateA.borrow - rateB.lend);
            
            if (rateDiff > 0.02) { // 2% rate difference
              const borrowProtocol = rateA.borrow < rateB.borrow ? protocolA : protocolB;
              const lendProtocol = rateA.borrow < rateB.borrow ? protocolB : protocolA;

              opportunities.push({
                type: ArbitrageType.LENDING_RATE,
                token,
                borrowProtocol,
                lendProtocol,
                borrowRate: Math.min(rateA.borrow, rateB.borrow),
                lendRate: Math.max(rateA.lend, rateB.lend),
                rateDifference: rateDiff,
                estimatedProfit: rateDiff - 0.005, // Gas and transaction costs
                detectedAt: Date.now(),
                ttl: this.options.opportunityTTL * 5 // Longer TTL for lending rates
              });
            }
          }
        }
      }

      return opportunities;
    } catch (error) {
      this.emit('error', error);
      return [];
    }
  }

  async scoreOpportunities(opportunities) {
    try {
      const scoredOpportunities = [];

      for (const opportunity of opportunities) {
        const score = await this.calculateOpportunityScore(opportunity);
        const riskLevel = await this.assessRiskLevel(opportunity);
        
        scoredOpportunities.push({
          ...opportunity,
          score,
          riskLevel,
          profitability: opportunity.estimatedProfit,
          gasEstimate: await this.estimateGasCost(opportunity),
          flashLoanAmount: await this.calculateOptimalLoanAmount(opportunity)
        });
      }

      // Sort by score (highest first)
      scoredOpportunities.sort((a, b) => b.score - a.score);

      return scoredOpportunities;
    } catch (error) {
      this.emit('error', error);
      return opportunities;
    }
  }

  async calculateOpportunityScore(opportunity) {
    try {
      let score = 0;

      // Profitability weight (40%)
      score += (opportunity.estimatedProfit * 1000) * 0.4;

      // Speed weight (20%)
      const timeRemaining = (opportunity.detectedAt + opportunity.ttl - Date.now()) / opportunity.ttl;
      score += timeRemaining * 20 * 0.2;

      // Liquidity weight (20%)
      const liquidityScore = await this.getLiquidityScore(opportunity);
      score += liquidityScore * 0.2;

      // Risk weight (20%) - inverse scoring
      const riskScore = await this.getRiskScore(opportunity);
      score += (10 - riskScore) * 0.2;

      return Math.max(0, score);
    } catch (error) {
      this.emit('error', error);
      return 0;
    }
  }

  async executeArbitrage(opportunityId, options = {}) {
    try {
      const opportunity = this.opportunities.get(opportunityId);
      if (!opportunity || opportunity.status !== OpportunityStatus.DETECTED) {
        throw new Error('Opportunity not found or already executed');
      }

      // Check if opportunity is still valid
      if (Date.now() > opportunity.detectedAt + opportunity.ttl) {
        opportunity.status = OpportunityStatus.EXPIRED;
        return { success: false, reason: 'Opportunity expired' };
      }

      opportunity.status = OpportunityStatus.EXECUTING;
      opportunity.executionStartTime = Date.now();

      this.emit('arbitrageStarted', opportunity);

      // Select optimal flash loan provider
      const provider = await this.selectOptimalProvider(opportunity);
      
      // Execute the arbitrage strategy
      const result = await this.executeArbitrageStrategy(opportunity, provider, options);
      
      // Record execution
      opportunity.status = result.success ? OpportunityStatus.COMPLETED : OpportunityStatus.FAILED;
      opportunity.executionEndTime = Date.now();
      opportunity.actualProfit = result.profit || 0;
      opportunity.gasUsed = result.gasUsed || 0;
      opportunity.error = result.error;

      // Update metrics
      this.updateMetrics(opportunity);

      this.emit('arbitrageCompleted', opportunity);
      
      return result;
    } catch (error) {
      const opportunity = this.opportunities.get(opportunityId);
      if (opportunity) {
        opportunity.status = OpportunityStatus.FAILED;
        opportunity.error = error.message;
      }
      this.emit('error', error);
      throw error;
    }
  }

  async executeArbitrageStrategy(opportunity, provider, options) {
    try {
      switch (opportunity.type) {
        case ArbitrageType.DEX_ARBITRAGE:
          return await this.executeDEXArbitrage(opportunity, provider, options);
          
        case ArbitrageType.TRIANGULAR:
          return await this.executeTriangularArbitrage(opportunity, provider, options);
          
        case ArbitrageType.CROSS_CHAIN:
          return await this.executeCrossChainArbitrage(opportunity, provider, options);
          
        case ArbitrageType.LIQUIDATION:
          return await this.executeLiquidationArbitrage(opportunity, provider, options);
          
        case ArbitrageType.LENDING_RATE:
          return await this.executeLendingRateArbitrage(opportunity, provider, options);
          
        default:
          throw new Error('Unsupported arbitrage type');
      }
    } catch (error) {
      this.emit('error', error);
      return { success: false, error: error.message };
    }
  }

  async executeDEXArbitrage(opportunity, provider, options) {
    try {
      const { token, buyExchange, sellExchange, buyPrice, sellPrice, flashLoanAmount } = opportunity;
      
      // Step 1: Take flash loan
      const flashLoanResult = await this.takeFlashLoan(provider, token, flashLoanAmount);
      if (!flashLoanResult.success) {
        throw new Error('Flash loan failed');
      }

      // Step 2: Buy token on cheaper exchange
      const buyResult = await this.executeSwap(buyExchange, 'USDC', token, flashLoanAmount, buyPrice);
      if (!buyResult.success) {
        throw new Error('Buy swap failed');
      }

      // Step 3: Sell token on more expensive exchange
      const sellResult = await this.executeSwap(sellExchange, token, 'USDC', buyResult.receivedAmount, sellPrice);
      if (!sellResult.success) {
        throw new Error('Sell swap failed');
      }

      // Step 4: Repay flash loan
      const repayAmount = flashLoanAmount * (1 + provider.fee);
      const profit = sellResult.receivedAmount - repayAmount;
      
      const repayResult = await this.repayFlashLoan(provider, token, repayAmount);
      if (!repayResult.success) {
        throw new Error('Flash loan repayment failed');
      }

      const gasUsed = flashLoanResult.gasUsed + buyResult.gasUsed + sellResult.gasUsed + repayResult.gasUsed;
      const netProfit = profit - (gasUsed * options.gasPrice / 1e9);

      return {
        success: true,
        profit: netProfit,
        gasUsed,
        steps: ['flashLoan', 'buy', 'sell', 'repay']
      };
    } catch (error) {
      this.emit('error', error);
      return { success: false, error: error.message };
    }
  }

  async executeTriangularArbitrage(opportunity, provider, options) {
    try {
      const { path, prices, flashLoanAmount } = opportunity;
      let currentAmount = flashLoanAmount;
      const swapResults = [];

      // Take flash loan
      const flashLoanResult = await this.takeFlashLoan(provider, path[0], flashLoanAmount);
      if (!flashLoanResult.success) {
        throw new Error('Flash loan failed');
      }

      // Execute triangular swaps
      for (let i = 0; i < path.length - 1; i++) {
        const fromToken = path[i];
        const toToken = path[i + 1];
        const price = prices[i];

        const swapResult = await this.executeSwap(opportunity.exchange, fromToken, toToken, currentAmount, price);
        if (!swapResult.success) {
          throw new Error(`Swap ${i + 1} failed: ${fromToken} -> ${toToken}`);
        }

        currentAmount = swapResult.receivedAmount;
        swapResults.push(swapResult);
      }

      // Repay flash loan
      const repayAmount = flashLoanAmount * (1 + provider.fee);
      const profit = currentAmount - repayAmount;

      const repayResult = await this.repayFlashLoan(provider, path[0], repayAmount);
      if (!repayResult.success) {
        throw new Error('Flash loan repayment failed');
      }

      const totalGasUsed = [flashLoanResult, ...swapResults, repayResult]
        .reduce((sum, result) => sum + result.gasUsed, 0);
      const netProfit = profit - (totalGasUsed * options.gasPrice / 1e9);

      return {
        success: true,
        profit: netProfit,
        gasUsed: totalGasUsed,
        steps: ['flashLoan', ...path.slice(0, -1).map((_, i) => `swap${i + 1}`), 'repay']
      };
    } catch (error) {
      this.emit('error', error);
      return { success: false, error: error.message };
    }
  }

  async selectOptimalProvider(opportunity) {
    try {
      const suitableProviders = Array.from(this.providers.values())
        .filter(provider => 
          provider.supportedTokens.includes(opportunity.token || 'USDC') &&
          provider.maxAmount >= opportunity.flashLoanAmount
        );

      if (suitableProviders.length === 0) {
        throw new Error('No suitable flash loan provider found');
      }

      // Select provider with lowest total cost (fee + gas)
      let bestProvider = suitableProviders[0];
      let lowestCost = bestProvider.fee * opportunity.flashLoanAmount + bestProvider.gasEstimate * 20e-9; // 20 gwei gas

      for (const provider of suitableProviders.slice(1)) {
        const cost = provider.fee * opportunity.flashLoanAmount + provider.gasEstimate * 20e-9;
        if (cost < lowestCost) {
          lowestCost = cost;
          bestProvider = provider;
        }
      }

      return bestProvider;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async takeFlashLoan(provider, token, amount) {
    // Simulate flash loan initiation
    await this.delay(1000 + Math.random() * 1000);
    
    return {
      success: Math.random() > 0.05, // 95% success rate
      gasUsed: provider.gasEstimate,
      fee: amount * provider.fee
    };
  }

  async repayFlashLoan(provider, token, amount) {
    // Simulate flash loan repayment
    await this.delay(500 + Math.random() * 500);
    
    return {
      success: Math.random() > 0.02, // 98% success rate
      gasUsed: 50000
    };
  }

  async executeSwap(exchange, fromToken, toToken, amount, expectedPrice) {
    // Simulate swap execution
    await this.delay(800 + Math.random() * 1200);
    
    const exchangeData = this.exchanges.get(exchange);
    const slippage = exchangeData ? exchangeData.slippage : 0.002;
    const actualPrice = expectedPrice * (1 - slippage * Math.random());
    
    return {
      success: Math.random() > 0.03, // 97% success rate
      receivedAmount: amount * actualPrice * (1 - exchangeData.fee),
      gasUsed: exchangeData ? exchangeData.gasEstimate : 120000,
      actualPrice,
      slippage: (expectedPrice - actualPrice) / expectedPrice
    };
  }

  startOpportunityScanner() {
    if (this.opportunityScanner) return;
    
    this.opportunityScanner = setInterval(async () => {
      try {
        await this.detectArbitrageOpportunities();
        await this.cleanupExpiredOpportunities();
      } catch (error) {
        this.emit('error', error);
      }
    }, 5000); // Scan every 5 seconds
  }

  startPriceFeeds() {
    if (this.priceFeedInterval) return;
    
    this.priceFeedInterval = setInterval(async () => {
      try {
        // Simulate price feed updates
        const tokens = ['USDC', 'USDT', 'DAI', 'WETH', 'WBTC'];
        const exchanges = Array.from(this.exchanges.keys());

        for (const token of tokens) {
          for (const exchange of exchanges) {
            const basePrice = this.getBaseTokenPrice(token);
            const variation = (Math.random() - 0.5) * 0.02; // ±1% variation
            const price = basePrice * (1 + variation);

            if (!this.priceFeeds.has(token)) {
              this.priceFeeds.set(token, new Map());
            }

            this.priceFeeds.get(token).set(exchange, {
              price,
              timestamp: Date.now()
            });
          }
        }
      } catch (error) {
        this.emit('error', error);
      }
    }, 2000); // Update every 2 seconds
  }

  startRiskMonitoring() {
    if (this.riskMonitor) return;
    
    this.riskMonitor = setInterval(async () => {
      try {
        for (const [opportunityId, opportunity] of this.opportunities) {
          if (opportunity.status === OpportunityStatus.EXECUTING) {
            const executionTime = Date.now() - opportunity.executionStartTime;
            
            if (executionTime > this.options.executionTimeout) {
              opportunity.status = OpportunityStatus.FAILED;
              opportunity.error = 'Execution timeout';
              this.emit('arbitrageTimeout', opportunity);
            }
          }
        }
      } catch (error) {
        this.emit('error', error);
      }
    }, 10000); // Check every 10 seconds
  }

  async addOpportunity(opportunity) {
    const opportunityId = this.generateOpportunityId();
    opportunity.id = opportunityId;
    opportunity.status = OpportunityStatus.DETECTED;
    
    this.opportunities.set(opportunityId, opportunity);
    this.metrics.totalOpportunities++;
    
    this.emit('opportunityDetected', opportunity);
    
    // Auto-execute high-score opportunities if enabled
    if (opportunity.score > 8.0 && this.options.enableAutoExecution) {
      setTimeout(() => {
        this.executeArbitrage(opportunityId).catch(error => this.emit('error', error));
      }, 1000);
    }
    
    return opportunityId;
  }

  async cleanupExpiredOpportunities() {
    const now = Date.now();
    const expiredIds = [];

    for (const [opportunityId, opportunity] of this.opportunities) {
      if (opportunity.status === OpportunityStatus.DETECTED && 
          now > opportunity.detectedAt + opportunity.ttl) {
        opportunity.status = OpportunityStatus.EXPIRED;
        expiredIds.push(opportunityId);
      }
    }

    // Remove very old opportunities
    for (const [opportunityId, opportunity] of this.opportunities) {
      if (now > opportunity.detectedAt + (opportunity.ttl * 5)) {
        this.opportunities.delete(opportunityId);
      }
    }

    if (expiredIds.length > 0) {
      this.emit('opportunitiesExpired', expiredIds);
    }
  }

  updateMetrics(opportunity) {
    if (opportunity.status === OpportunityStatus.COMPLETED) {
      this.metrics.successfulTrades++;
      this.metrics.totalProfit += opportunity.actualProfit || 0;
      this.metrics.totalVolume += opportunity.flashLoanAmount || 0;
    } else if (opportunity.status === OpportunityStatus.FAILED) {
      this.metrics.failedTrades++;
    }

    this.metrics.gasSpent += opportunity.gasUsed || 0;
    
    const totalTrades = this.metrics.successfulTrades + this.metrics.failedTrades;
    if (totalTrades > 0) {
      this.metrics.successRate = (this.metrics.successfulTrades / totalTrades) * 100;
      this.metrics.averageProfit = this.metrics.totalProfit / this.metrics.successfulTrades;
    }
  }

  // Helper methods for price simulation
  getBaseTokenPrice(token) {
    const basePrices = {
      'USDC': 1.0,
      'USDT': 1.0,
      'DAI': 1.0,
      'WETH': 2500,
      'WBTC': 45000
    };
    return basePrices[token] || 1.0;
  }

  async getTokenPricesAcrossExchanges(token) {
    const prices = {};
    const tokenPrices = this.priceFeeds.get(token);
    
    if (tokenPrices) {
      for (const [exchange, data] of tokenPrices) {
        prices[exchange] = data.price;
      }
    }
    
    return prices;
  }

  calculateTotalFees(buyExchange, sellExchange) {
    const buyEx = this.exchanges.get(buyExchange);
    const sellEx = this.exchanges.get(sellExchange);
    
    return (buyEx?.fee || 0.003) + (sellEx?.fee || 0.003);
  }

  calculateTriangularFees(exchange) {
    const ex = this.exchanges.get(exchange);
    return (ex?.fee || 0.003) * 3; // Three swaps
  }

  generateOpportunityId() {
    return crypto.randomBytes(16).toString('hex');
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Mock methods for demonstration
  async getExchangeRate(exchange, tokenA, tokenB) {
    return Math.random() * 0.1 + 0.95; // Random rate around 1.0
  }

  async getTokenPriceOnChain(token, chain) {
    return this.getBaseTokenPrice(token) * (0.98 + Math.random() * 0.04);
  }

  async getBridgeFee(token, fromChain, toChain) {
    return 0.005 + Math.random() * 0.005; // 0.5-1% bridge fee
  }

  async getLiquidationOpportunities(protocol) {
    // Simulate liquidation opportunities
    return Math.random() > 0.8 ? [{
      asset: 'WETH',
      collateralAmount: 100 + Math.random() * 900,
      debtAmount: 80 + Math.random() * 720,
      discount: 0.05 + Math.random() * 0.05,
      healthFactor: 0.8 + Math.random() * 0.15
    }] : [];
  }

  async getLendingRate(protocol, token) {
    return {
      lend: 0.02 + Math.random() * 0.08,
      borrow: 0.03 + Math.random() * 0.10
    };
  }

  async getLiquidityScore(opportunity) {
    return Math.random() * 10;
  }

  async getRiskScore(opportunity) {
    return Math.random() * 10;
  }

  async assessRiskLevel(opportunity) {
    const score = await this.getRiskScore(opportunity);
    if (score > 7) return RiskLevel.EXTREME;
    if (score > 5) return RiskLevel.HIGH;
    if (score > 3) return RiskLevel.MEDIUM;
    return RiskLevel.LOW;
  }

  async calculateOptimalLoanAmount(opportunity) {
    return Math.min(100000 + Math.random() * 400000, this.options.maxFlashLoanAmount);
  }

  async estimateGasCost(opportunity) {
    return 200000 + Math.random() * 300000;
  }

  // Public API methods
  async getOpportunity(opportunityId) {
    return this.opportunities.get(opportunityId) || null;
  }

  async getAllOpportunities(status = null) {
    const opportunities = Array.from(this.opportunities.values());
    return status ? opportunities.filter(opp => opp.status === status) : opportunities;
  }

  async getOpportunitiesByType(type) {
    return Array.from(this.opportunities.values())
      .filter(opp => opp.type === type);
  }

  getMetrics() {
    return {
      ...this.metrics,
      activeOpportunities: Array.from(this.opportunities.values())
        .filter(opp => opp.status === OpportunityStatus.DETECTED).length,
      executingOpportunities: Array.from(this.opportunities.values())
        .filter(opp => opp.status === OpportunityStatus.EXECUTING).length,
      totalOpportunities: this.opportunities.size
    };
  }

  async stop() {
    this.isRunning = false;
    
    if (this.opportunityScanner) {
      clearInterval(this.opportunityScanner);
      this.opportunityScanner = null;
    }
    
    if (this.priceFeedInterval) {
      clearInterval(this.priceFeedInterval);
      this.priceFeedInterval = null;
    }
    
    if (this.riskMonitor) {
      clearInterval(this.riskMonitor);
      this.riskMonitor = null;
    }
    
    this.emit('stopped');
  }
}

export { ArbitrageType, FlashLoanProvider, OpportunityStatus, RiskLevel };