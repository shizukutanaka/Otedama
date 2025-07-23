const EventEmitter = require('events');
const crypto = require('crypto');
const { BigNumber } = require('bignumber.js');

class AutomatedMarketMaker extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      feeRate: options.feeRate || 0.003, // 0.3% default fee
      slippageTolerance: options.slippageTolerance || 0.005, // 0.5% default
      priceImpactWarning: options.priceImpactWarning || 0.05, // 5% warning threshold
      minLiquidity: options.minLiquidity || new BigNumber('1000'),
      flashLoanEnabled: options.flashLoanEnabled !== false,
      flashLoanFee: options.flashLoanFee || 0.0009, // 0.09%
      dynamicFees: options.dynamicFees !== false,
      concentratedLiquidity: options.concentratedLiquidity !== false,
      multiHopEnabled: options.multiHopEnabled !== false,
      maxHops: options.maxHops || 3,
      oracleIntegration: options.oracleIntegration !== false
    };
    
    this.pools = new Map();
    this.liquidityProviders = new Map();
    this.priceOracles = new Map();
    this.flashLoans = new Map();
    this.routingEngine = new RoutingEngine(this.config);
    this.impermanentLossCalculator = new ImpermanentLossCalculator();
  }
  
  async initialize() {
    try {
      // Initialize price oracles
      await this.initializePriceOracles();
      
      // Load existing pools
      await this.loadPools();
      
      // Start price update cycle
      this.startPriceUpdateCycle();
      
      this.emit('initialized', {
        poolCount: this.pools.size,
        totalLiquidity: this.calculateTotalLiquidity()
      });
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  async createPool(tokenA, tokenB, options = {}) {
    const poolId = this.generatePoolId(tokenA, tokenB);
    
    if (this.pools.has(poolId)) {
      throw new Error('Pool already exists');
    }
    
    const pool = {
      id: poolId,
      tokenA,
      tokenB,
      reserveA: new BigNumber(0),
      reserveB: new BigNumber(0),
      totalSupply: new BigNumber(0),
      feeRate: options.feeRate || this.config.feeRate,
      createdAt: Date.now(),
      lastUpdate: Date.now(),
      volume24h: new BigNumber(0),
      fees24h: new BigNumber(0),
      priceHistory: [],
      liquidityHistory: [],
      concentratedLiquidity: options.concentratedLiquidity || this.config.concentratedLiquidity,
      priceRange: options.priceRange || null
    };
    
    if (pool.concentratedLiquidity) {
      pool.liquidityRanges = new Map();
      pool.activeLiquidity = new BigNumber(0);
    }
    
    this.pools.set(poolId, pool);
    
    this.emit('poolCreated', {
      poolId,
      tokenA,
      tokenB
    });
    
    return pool;
  }
  
  async addLiquidity(poolId, amountA, amountB, provider, options = {}) {
    const pool = this.pools.get(poolId);
    if (!pool) throw new Error('Pool not found');
    
    const amounts = {
      tokenA: new BigNumber(amountA),
      tokenB: new BigNumber(amountB)
    };
    
    // Calculate optimal amounts if pool has existing liquidity
    if (pool.totalSupply.gt(0)) {
      const optimalAmounts = this.calculateOptimalLiquidity(pool, amounts);
      amounts.tokenA = optimalAmounts.tokenA;
      amounts.tokenB = optimalAmounts.tokenB;
    }
    
    // Calculate LP tokens to mint
    let lpTokens;
    if (pool.totalSupply.eq(0)) {
      // First liquidity provider
      lpTokens = amounts.tokenA.multipliedBy(amounts.tokenB).sqrt();
      
      // Set minimum liquidity
      if (lpTokens.lt(this.config.minLiquidity)) {
        throw new Error('Insufficient initial liquidity');
      }
    } else {
      // Subsequent providers
      const lpFromA = amounts.tokenA.multipliedBy(pool.totalSupply).dividedBy(pool.reserveA);
      const lpFromB = amounts.tokenB.multipliedBy(pool.totalSupply).dividedBy(pool.reserveB);
      lpTokens = BigNumber.min(lpFromA, lpFromB);
    }
    
    // Handle concentrated liquidity
    if (pool.concentratedLiquidity && options.priceRange) {
      await this.addConcentratedLiquidity(pool, amounts, lpTokens, provider, options.priceRange);
    } else {
      // Update reserves
      pool.reserveA = pool.reserveA.plus(amounts.tokenA);
      pool.reserveB = pool.reserveB.plus(amounts.tokenB);
      pool.totalSupply = pool.totalSupply.plus(lpTokens);
    }
    
    // Track liquidity provider
    this.updateLiquidityProvider(poolId, provider, lpTokens, amounts);
    
    // Update pool state
    pool.lastUpdate = Date.now();
    this.recordLiquidityHistory(pool);
    
    this.emit('liquidityAdded', {
      poolId,
      provider,
      amounts,
      lpTokens: lpTokens.toString()
    });
    
    return {
      lpTokens: lpTokens.toString(),
      share: lpTokens.dividedBy(pool.totalSupply).multipliedBy(100).toFixed(2) + '%'
    };
  }
  
  async removeLiquidity(poolId, lpTokens, provider, options = {}) {
    const pool = this.pools.get(poolId);
    if (!pool) throw new Error('Pool not found');
    
    const lpAmount = new BigNumber(lpTokens);
    const providerInfo = this.liquidityProviders.get(`${poolId}_${provider}`);
    
    if (!providerInfo || providerInfo.lpTokens.lt(lpAmount)) {
      throw new Error('Insufficient LP tokens');
    }
    
    // Calculate amounts to return
    const shareOfPool = lpAmount.dividedBy(pool.totalSupply);
    const amountA = pool.reserveA.multipliedBy(shareOfPool);
    const amountB = pool.reserveB.multipliedBy(shareOfPool);
    
    // Handle concentrated liquidity removal
    if (pool.concentratedLiquidity && providerInfo.priceRange) {
      await this.removeConcentratedLiquidity(pool, lpAmount, provider);
    } else {
      // Update reserves
      pool.reserveA = pool.reserveA.minus(amountA);
      pool.reserveB = pool.reserveB.minus(amountB);
      pool.totalSupply = pool.totalSupply.minus(lpAmount);
    }
    
    // Update provider info
    providerInfo.lpTokens = providerInfo.lpTokens.minus(lpAmount);
    
    // Calculate impermanent loss
    const impermanentLoss = this.impermanentLossCalculator.calculate(
      providerInfo.initialAmounts,
      { tokenA: amountA, tokenB: amountB },
      providerInfo.initialPrice
    );
    
    pool.lastUpdate = Date.now();
    
    this.emit('liquidityRemoved', {
      poolId,
      provider,
      amounts: { tokenA: amountA.toString(), tokenB: amountB.toString() },
      impermanentLoss
    });
    
    return {
      amountA: amountA.toString(),
      amountB: amountB.toString(),
      impermanentLoss
    };
  }
  
  async swap(poolId, tokenIn, amountIn, minAmountOut, recipient, options = {}) {
    const pool = this.pools.get(poolId);
    if (!pool) throw new Error('Pool not found');
    
    const amount = new BigNumber(amountIn);
    
    // Determine swap direction
    const isTokenA = tokenIn === pool.tokenA;
    const reserveIn = isTokenA ? pool.reserveA : pool.reserveB;
    const reserveOut = isTokenA ? pool.reserveB : pool.reserveA;
    
    // Calculate output amount
    const { amountOut, fee, priceImpact } = this.calculateSwapAmount(
      amount,
      reserveIn,
      reserveOut,
      pool.feeRate
    );
    
    // Check slippage
    if (amountOut.lt(minAmountOut)) {
      throw new Error('Insufficient output amount');
    }
    
    // Check price impact warning
    if (priceImpact.gt(this.config.priceImpactWarning)) {
      this.emit('priceImpactWarning', {
        poolId,
        priceImpact: priceImpact.toString(),
        threshold: this.config.priceImpactWarning
      });
    }
    
    // Update reserves
    if (isTokenA) {
      pool.reserveA = pool.reserveA.plus(amount);
      pool.reserveB = pool.reserveB.minus(amountOut);
    } else {
      pool.reserveB = pool.reserveB.plus(amount);
      pool.reserveA = pool.reserveA.minus(amountOut);
    }
    
    // Update statistics
    pool.volume24h = pool.volume24h.plus(amount);
    pool.fees24h = pool.fees24h.plus(fee);
    
    // Record price
    this.recordPrice(pool);
    
    // Check arbitrage opportunity
    if (this.config.oracleIntegration) {
      await this.checkArbitrageOpportunity(pool);
    }
    
    this.emit('swap', {
      poolId,
      tokenIn,
      tokenOut: isTokenA ? pool.tokenB : pool.tokenA,
      amountIn: amount.toString(),
      amountOut: amountOut.toString(),
      fee: fee.toString(),
      priceImpact: priceImpact.toString(),
      recipient
    });
    
    return {
      amountOut: amountOut.toString(),
      fee: fee.toString(),
      priceImpact: priceImpact.toString(),
      executionPrice: amount.dividedBy(amountOut).toString()
    };
  }
  
  async multiHopSwap(tokenPath, amountIn, minAmountOut, recipient, options = {}) {
    if (!this.config.multiHopEnabled) {
      throw new Error('Multi-hop swaps are disabled');
    }
    
    if (tokenPath.length > this.config.maxHops + 1) {
      throw new Error(`Maximum ${this.config.maxHops} hops allowed`);
    }
    
    let currentAmount = new BigNumber(amountIn);
    const swaps = [];
    let totalFees = new BigNumber(0);
    let totalPriceImpact = new BigNumber(0);
    
    // Execute swaps through the path
    for (let i = 0; i < tokenPath.length - 1; i++) {
      const tokenIn = tokenPath[i];
      const tokenOut = tokenPath[i + 1];
      const poolId = this.findPool(tokenIn, tokenOut);
      
      if (!poolId) {
        throw new Error(`No pool found for ${tokenIn}/${tokenOut}`);
      }
      
      const swapResult = await this.swap(
        poolId,
        tokenIn,
        currentAmount,
        i === tokenPath.length - 2 ? minAmountOut : 0,
        i === tokenPath.length - 2 ? recipient : this.address,
        options
      );
      
      swaps.push({
        poolId,
        tokenIn,
        tokenOut,
        ...swapResult
      });
      
      currentAmount = new BigNumber(swapResult.amountOut);
      totalFees = totalFees.plus(swapResult.fee);
      totalPriceImpact = totalPriceImpact.plus(swapResult.priceImpact);
    }
    
    this.emit('multiHopSwap', {
      path: tokenPath,
      amountIn: amountIn.toString(),
      amountOut: currentAmount.toString(),
      swaps,
      totalFees: totalFees.toString(),
      totalPriceImpact: totalPriceImpact.toString()
    });
    
    return {
      amountOut: currentAmount.toString(),
      swaps,
      totalFees: totalFees.toString(),
      averagePriceImpact: totalPriceImpact.dividedBy(swaps.length).toString()
    };
  }
  
  calculateSwapAmount(amountIn, reserveIn, reserveOut, feeRate) {
    // Apply fee
    const amountInWithFee = amountIn.multipliedBy(1 - feeRate);
    const fee = amountIn.multipliedBy(feeRate);
    
    // Calculate output using constant product formula
    // (x + ”x) * (y - ”y) = x * y
    const numerator = amountInWithFee.multipliedBy(reserveOut);
    const denominator = reserveIn.plus(amountInWithFee);
    const amountOut = numerator.dividedBy(denominator);
    
    // Calculate price impact
    const spotPriceBefore = reserveOut.dividedBy(reserveIn);
    const executionPrice = amountIn.dividedBy(amountOut);
    const priceImpact = executionPrice.minus(spotPriceBefore).dividedBy(spotPriceBefore).abs();
    
    return { amountOut, fee, priceImpact };
  }
  
  calculateOptimalLiquidity(pool, amounts) {
    // Calculate optimal amounts to maintain price ratio
    const currentRatio = pool.reserveA.dividedBy(pool.reserveB);
    const providedRatio = amounts.tokenA.dividedBy(amounts.tokenB);
    
    if (currentRatio.eq(providedRatio)) {
      return amounts;
    }
    
    // Adjust amounts to match pool ratio
    if (providedRatio.gt(currentRatio)) {
      // Too much token A, reduce it
      return {
        tokenA: amounts.tokenB.multipliedBy(currentRatio),
        tokenB: amounts.tokenB
      };
    } else {
      // Too much token B, reduce it
      return {
        tokenA: amounts.tokenA,
        tokenB: amounts.tokenA.dividedBy(currentRatio)
      };
    }
  }
  
  async addConcentratedLiquidity(pool, amounts, lpTokens, provider, priceRange) {
    const range = {
      lower: new BigNumber(priceRange.lower),
      upper: new BigNumber(priceRange.upper),
      liquidity: lpTokens,
      provider
    };
    
    const rangeKey = `${priceRange.lower}_${priceRange.upper}`;
    
    if (!pool.liquidityRanges.has(rangeKey)) {
      pool.liquidityRanges.set(rangeKey, []);
    }
    
    pool.liquidityRanges.get(rangeKey).push(range);
    
    // Update active liquidity if current price is in range
    const currentPrice = pool.reserveB.dividedBy(pool.reserveA);
    if (currentPrice.gte(range.lower) && currentPrice.lte(range.upper)) {
      pool.activeLiquidity = pool.activeLiquidity.plus(lpTokens);
    }
  }
  
  async removeConcentratedLiquidity(pool, lpAmount, provider) {
    // Find and remove liquidity from ranges
    for (const [rangeKey, positions] of pool.liquidityRanges) {
      const index = positions.findIndex(p => p.provider === provider);
      if (index !== -1) {
        const position = positions[index];
        if (position.liquidity.gte(lpAmount)) {
          position.liquidity = position.liquidity.minus(lpAmount);
          
          // Update active liquidity
          const currentPrice = pool.reserveB.dividedBy(pool.reserveA);
          if (currentPrice.gte(position.lower) && currentPrice.lte(position.upper)) {
            pool.activeLiquidity = pool.activeLiquidity.minus(lpAmount);
          }
          
          if (position.liquidity.eq(0)) {
            positions.splice(index, 1);
          }
          
          break;
        }
      }
    }
  }
  
  async flashLoan(token, amount, borrower, data, options = {}) {
    if (!this.config.flashLoanEnabled) {
      throw new Error('Flash loans are disabled');
    }
    
    const loanAmount = new BigNumber(amount);
    const loanId = this.generateLoanId();
    
    // Find pools with sufficient liquidity
    const availablePools = this.findPoolsWithToken(token);
    let totalAvailable = new BigNumber(0);
    const poolsToUse = [];
    
    for (const poolId of availablePools) {
      const pool = this.pools.get(poolId);
      const reserve = pool.tokenA === token ? pool.reserveA : pool.reserveB;
      
      if (totalAvailable.plus(reserve).gte(loanAmount)) {
        poolsToUse.push({ poolId, amount: loanAmount.minus(totalAvailable) });
        break;
      } else {
        poolsToUse.push({ poolId, amount: reserve });
        totalAvailable = totalAvailable.plus(reserve);
      }
    }
    
    if (totalAvailable.lt(loanAmount)) {
      throw new Error('Insufficient liquidity for flash loan');
    }
    
    // Calculate fee
    const fee = loanAmount.multipliedBy(this.config.flashLoanFee);
    
    // Record loan
    this.flashLoans.set(loanId, {
      borrower,
      token,
      amount: loanAmount,
      fee,
      pools: poolsToUse,
      timestamp: Date.now(),
      status: 'active'
    });
    
    // Execute loan
    try {
      // Remove liquidity from pools
      for (const { poolId, amount } of poolsToUse) {
        const pool = this.pools.get(poolId);
        if (pool.tokenA === token) {
          pool.reserveA = pool.reserveA.minus(amount);
        } else {
          pool.reserveB = pool.reserveB.minus(amount);
        }
      }
      
      // Call borrower contract
      // In production, this would call the borrower's contract
      const result = await this.executeFlashLoan(borrower, token, loanAmount, fee, data);
      
      // Verify repayment
      const expectedReturn = loanAmount.plus(fee);
      
      // Return liquidity to pools
      for (const { poolId, amount } of poolsToUse) {
        const pool = this.pools.get(poolId);
        const returnAmount = amount.plus(amount.multipliedBy(this.config.flashLoanFee));
        
        if (pool.tokenA === token) {
          pool.reserveA = pool.reserveA.plus(returnAmount);
        } else {
          pool.reserveB = pool.reserveB.plus(returnAmount);
        }
      }
      
      // Mark loan as completed
      const loan = this.flashLoans.get(loanId);
      loan.status = 'completed';
      
      this.emit('flashLoan', {
        loanId,
        borrower,
        token,
        amount: loanAmount.toString(),
        fee: fee.toString(),
        status: 'completed'
      });
      
      return { loanId, result };
    } catch (error) {
      // Revert changes
      const loan = this.flashLoans.get(loanId);
      loan.status = 'failed';
      
      throw new Error(`Flash loan failed: ${error.message}`);
    }
  }
  
  async executeFlashLoan(borrower, token, amount, fee, data) {
    // This would execute the actual flash loan logic
    // For now, simulate successful execution
    return { success: true, data: 'Flash loan executed' };
  }
  
  findPool(tokenA, tokenB) {
    const id1 = this.generatePoolId(tokenA, tokenB);
    const id2 = this.generatePoolId(tokenB, tokenA);
    
    if (this.pools.has(id1)) return id1;
    if (this.pools.has(id2)) return id2;
    
    return null;
  }
  
  findPoolsWithToken(token) {
    const pools = [];
    
    for (const [poolId, pool] of this.pools) {
      if (pool.tokenA === token || pool.tokenB === token) {
        pools.push(poolId);
      }
    }
    
    return pools;
  }
  
  generatePoolId(tokenA, tokenB) {
    // Sort tokens to ensure consistent pool IDs
    const [token0, token1] = tokenA < tokenB ? [tokenA, tokenB] : [tokenB, tokenA];
    return crypto.createHash('sha256')
      .update(`${token0}_${token1}`)
      .digest('hex')
      .substring(0, 16);
  }
  
  generateLoanId() {
    return crypto.randomBytes(16).toString('hex');
  }
  
  updateLiquidityProvider(poolId, provider, lpTokens, amounts) {
    const key = `${poolId}_${provider}`;
    const existing = this.liquidityProviders.get(key);
    
    if (existing) {
      existing.lpTokens = existing.lpTokens.plus(lpTokens);
      existing.amounts.tokenA = existing.amounts.tokenA.plus(amounts.tokenA);
      existing.amounts.tokenB = existing.amounts.tokenB.plus(amounts.tokenB);
    } else {
      const pool = this.pools.get(poolId);
      this.liquidityProviders.set(key, {
        poolId,
        provider,
        lpTokens,
        amounts,
        initialAmounts: { ...amounts },
        initialPrice: pool.reserveB.dividedBy(pool.reserveA),
        timestamp: Date.now()
      });
    }
  }
  
  recordPrice(pool) {
    const price = pool.reserveB.dividedBy(pool.reserveA);
    
    pool.priceHistory.push({
      price: price.toString(),
      timestamp: Date.now()
    });
    
    // Keep only last 24 hours
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    pool.priceHistory = pool.priceHistory.filter(p => p.timestamp > cutoff);
  }
  
  recordLiquidityHistory(pool) {
    pool.liquidityHistory.push({
      totalSupply: pool.totalSupply.toString(),
      reserveA: pool.reserveA.toString(),
      reserveB: pool.reserveB.toString(),
      timestamp: Date.now()
    });
    
    // Keep only last 7 days
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    pool.liquidityHistory = pool.liquidityHistory.filter(l => l.timestamp > cutoff);
  }
  
  async initializePriceOracles() {
    // Initialize price oracle connections
    // This would connect to actual price feeds in production
    this.priceOracles.set('chainlink', {
      name: 'Chainlink',
      isActive: true,
      lastUpdate: Date.now()
    });
  }
  
  async checkArbitrageOpportunity(pool) {
    if (!this.config.oracleIntegration) return;
    
    const currentPrice = pool.reserveB.dividedBy(pool.reserveA);
    const oraclePrice = await this.getOraclePrice(pool.tokenA, pool.tokenB);
    
    if (!oraclePrice) return;
    
    const priceDifference = currentPrice.minus(oraclePrice).dividedBy(oraclePrice).abs();
    
    if (priceDifference.gt(0.02)) { // 2% threshold
      this.emit('arbitrageOpportunity', {
        poolId: pool.id,
        poolPrice: currentPrice.toString(),
        oraclePrice: oraclePrice.toString(),
        difference: priceDifference.toString()
      });
    }
  }
  
  async getOraclePrice(tokenA, tokenB) {
    // This would fetch actual oracle prices in production
    // For now, return a simulated price
    return new BigNumber(Math.random() * 2 + 0.5);
  }
  
  startPriceUpdateCycle() {
    setInterval(() => {
      for (const pool of this.pools.values()) {
        this.recordPrice(pool);
        
        // Reset 24h stats if needed
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        if (pool.lastUpdate < cutoff) {
          pool.volume24h = new BigNumber(0);
          pool.fees24h = new BigNumber(0);
        }
      }
    }, 60000); // Every minute
  }
  
  calculateTotalLiquidity() {
    let total = new BigNumber(0);
    
    for (const pool of this.pools.values()) {
      // Calculate USD value (simplified)
      const value = pool.reserveA.plus(pool.reserveB);
      total = total.plus(value);
    }
    
    return total.toString();
  }
  
  async loadPools() {
    // Load existing pools from storage
    // This would connect to actual storage in production
  }
  
  getPoolStats(poolId) {
    const pool = this.pools.get(poolId);
    if (!pool) throw new Error('Pool not found');
    
    const currentPrice = pool.reserveB.dividedBy(pool.reserveA);
    const tvl = pool.reserveA.plus(pool.reserveB); // Simplified TVL
    
    // Calculate APY from fees
    const yearlyFees = pool.fees24h.multipliedBy(365);
    const apy = yearlyFees.dividedBy(tvl).multipliedBy(100);
    
    return {
      poolId,
      tokenA: pool.tokenA,
      tokenB: pool.tokenB,
      currentPrice: currentPrice.toString(),
      tvl: tvl.toString(),
      volume24h: pool.volume24h.toString(),
      fees24h: pool.fees24h.toString(),
      apy: apy.toFixed(2) + '%',
      liquidityProviders: this.getPoolProviderCount(poolId),
      priceChange24h: this.calculate24hPriceChange(pool)
    };
  }
  
  getPoolProviderCount(poolId) {
    let count = 0;
    for (const key of this.liquidityProviders.keys()) {
      if (key.startsWith(poolId)) count++;
    }
    return count;
  }
  
  calculate24hPriceChange(pool) {
    if (pool.priceHistory.length < 2) return '0%';
    
    const current = new BigNumber(pool.priceHistory[pool.priceHistory.length - 1].price);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const historical = pool.priceHistory.find(p => p.timestamp <= cutoff);
    
    if (!historical) return '0%';
    
    const change = current.minus(historical.price)
      .dividedBy(historical.price)
      .multipliedBy(100);
    
    return change.toFixed(2) + '%';
  }
  
  async simulateSwap(poolId, tokenIn, amountIn) {
    const pool = this.pools.get(poolId);
    if (!pool) throw new Error('Pool not found');
    
    const amount = new BigNumber(amountIn);
    const isTokenA = tokenIn === pool.tokenA;
    const reserveIn = isTokenA ? pool.reserveA : pool.reserveB;
    const reserveOut = isTokenA ? pool.reserveB : pool.reserveA;
    
    const result = this.calculateSwapAmount(amount, reserveIn, reserveOut, pool.feeRate);
    
    return {
      amountOut: result.amountOut.toString(),
      fee: result.fee.toString(),
      priceImpact: result.priceImpact.toString(),
      executionPrice: amount.dividedBy(result.amountOut).toString(),
      minimumReceived: result.amountOut.multipliedBy(1 - this.config.slippageTolerance).toString()
    };
  }
}

class RoutingEngine {
  constructor(config) {
    this.config = config;
  }
  
  findBestPath(tokenIn, tokenOut, amountIn, pools) {
    // Implement path finding algorithm (simplified Dijkstra's)
    const paths = this.findAllPaths(tokenIn, tokenOut, pools);
    let bestPath = null;
    let bestOutput = new BigNumber(0);
    
    for (const path of paths) {
      const output = this.simulatePathSwap(path, amountIn, pools);
      if (output.gt(bestOutput)) {
        bestOutput = output;
        bestPath = path;
      }
    }
    
    return { path: bestPath, expectedOutput: bestOutput };
  }
  
  findAllPaths(tokenIn, tokenOut, pools, maxHops = 3, currentPath = [tokenIn], visited = new Set()) {
    if (currentPath.length > maxHops + 1) return [];
    if (currentPath[currentPath.length - 1] === tokenOut) return [currentPath];
    
    const paths = [];
    const currentToken = currentPath[currentPath.length - 1];
    
    for (const [poolId, pool] of pools) {
      if (visited.has(poolId)) continue;
      
      let nextToken = null;
      if (pool.tokenA === currentToken) nextToken = pool.tokenB;
      else if (pool.tokenB === currentToken) nextToken = pool.tokenA;
      
      if (nextToken && !currentPath.includes(nextToken)) {
        visited.add(poolId);
        const newPaths = this.findAllPaths(
          tokenIn,
          tokenOut,
          pools,
          maxHops,
          [...currentPath, nextToken],
          visited
        );
        paths.push(...newPaths);
        visited.delete(poolId);
      }
    }
    
    return paths;
  }
  
  simulatePathSwap(path, amountIn, pools) {
    let currentAmount = new BigNumber(amountIn);
    
    for (let i = 0; i < path.length - 1; i++) {
      const poolId = this.findPoolForPair(path[i], path[i + 1], pools);
      if (!poolId) return new BigNumber(0);
      
      const pool = pools.get(poolId);
      const isTokenA = path[i] === pool.tokenA;
      const reserveIn = isTokenA ? pool.reserveA : pool.reserveB;
      const reserveOut = isTokenA ? pool.reserveB : pool.reserveA;
      
      const result = this.calculateSwapAmount(currentAmount, reserveIn, reserveOut, pool.feeRate);
      currentAmount = result.amountOut;
    }
    
    return currentAmount;
  }
  
  findPoolForPair(tokenA, tokenB, pools) {
    for (const [poolId, pool] of pools) {
      if ((pool.tokenA === tokenA && pool.tokenB === tokenB) ||
          (pool.tokenA === tokenB && pool.tokenB === tokenA)) {
        return poolId;
      }
    }
    return null;
  }
  
  calculateSwapAmount(amountIn, reserveIn, reserveOut, feeRate) {
    const amountInWithFee = amountIn.multipliedBy(1 - feeRate);
    const numerator = amountInWithFee.multipliedBy(reserveOut);
    const denominator = reserveIn.plus(amountInWithFee);
    return { amountOut: numerator.dividedBy(denominator) };
  }
}

class ImpermanentLossCalculator {
  calculate(initialAmounts, finalAmounts, initialPrice) {
    // Calculate value if held
    const initialValueA = initialAmounts.tokenA;
    const initialValueB = initialAmounts.tokenB;
    const currentPrice = finalAmounts.tokenB.dividedBy(finalAmounts.tokenA);
    
    const valueIfHeldA = initialAmounts.tokenA;
    const valueIfHeldB = initialAmounts.tokenB.multipliedBy(currentPrice).dividedBy(initialPrice);
    const valueIfHeld = valueIfHeldA.plus(valueIfHeldB);
    
    // Calculate current value
    const currentValueA = finalAmounts.tokenA;
    const currentValueB = finalAmounts.tokenB.multipliedBy(currentPrice).dividedBy(initialPrice);
    const currentValue = currentValueA.plus(currentValueB);
    
    // Calculate IL
    const impermanentLoss = valueIfHeld.minus(currentValue).dividedBy(valueIfHeld);
    
    return {
      percentage: impermanentLoss.multipliedBy(100).toFixed(2) + '%',
      valueIfHeld: valueIfHeld.toString(),
      currentValue: currentValue.toString(),
      loss: valueIfHeld.minus(currentValue).toString()
    };
  }
}

module.exports = AutomatedMarketMaker;