/**
 * Price Oracle Aggregator
 * Reliable price feeds from multiple oracle sources with manipulation protection
 */

import { EventEmitter } from 'events';
import { BigNumber } from 'ethers';
import { Logger } from '../logger.js';

// Oracle types
export const OracleType = {
  CHAINLINK: 'chainlink',
  UNISWAP_V3: 'uniswap_v3',
  BALANCER: 'balancer',
  CURVE: 'curve',
  SUSHISWAP: 'sushiswap',
  CUSTOM: 'custom'
};

// Price source status
export const SourceStatus = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  DEGRADED: 'degraded',
  FAILED: 'failed'
};

// Aggregation methods
export const AggregationMethod = {
  MEDIAN: 'median',
  WEIGHTED_AVERAGE: 'weighted_average',
  VOLUME_WEIGHTED: 'volume_weighted',
  CONFIDENCE_WEIGHTED: 'confidence_weighted'
};

export class PriceOracleAggregator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || new Logger('PriceOracle');
    this.options = {
      maxPriceDeviation: options.maxPriceDeviation || 0.1, // 10% max deviation
      minSources: options.minSources || 3,
      maxSources: options.maxSources || 10,
      priceUpdateInterval: options.priceUpdateInterval || 30000, // 30 seconds
      heartbeatInterval: options.heartbeatInterval || 60000, // 1 minute
      maxPriceAge: options.maxPriceAge || 300000, // 5 minutes
      outlierThreshold: options.outlierThreshold || 0.15, // 15%
      confidenceThreshold: options.confidenceThreshold || 0.8, // 80%
      defaultAggregationMethod: options.defaultAggregationMethod || AggregationMethod.MEDIAN,
      ...options
    };
    
    // Oracle sources
    this.oracles = new Map();
    this.priceFeeds = new Map();
    this.sourceWeights = new Map();
    
    // Price data
    this.currentPrices = new Map();
    this.priceHistory = new Map();
    this.priceUpdates = new Map();
    
    // Validation and security
    this.manipulationDetector = new ManipulationDetector(this.options);
    this.outlierDetector = new OutlierDetector(this.options);
    this.confidenceCalculator = new ConfidenceCalculator(this.options);
    
    // Circuit breaker
    this.circuitBreaker = new CircuitBreaker(this.options);
    
    // Statistics
    this.stats = {
      totalPriceUpdates: 0,
      averageLatency: 0,
      manipulationAttempts: 0,
      outlierDetections: 0,
      circuitBreakerTrips: 0,
      uptimePercentage: 0
    };
    
    // Initialize oracle sources
    this.initializeOracles();
    
    // Start background processes
    this.startPriceUpdates();
    this.startHeartbeat();
    this.startManipulationDetection();
    this.startStatisticsUpdate();
  }
  
  /**
   * Initialize oracle sources
   */
  initializeOracles() {
    // Initialize Chainlink oracles
    this.addOracle('chainlink_eth_usd', {
      type: OracleType.CHAINLINK,
      address: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
      pair: 'ETH/USD',
      weight: 0.3,
      priority: 1,
      heartbeat: 3600000, // 1 hour
      deviation: 0.5
    });
    
    this.addOracle('chainlink_btc_usd', {
      type: OracleType.CHAINLINK,
      address: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
      pair: 'BTC/USD',
      weight: 0.3,
      priority: 1,
      heartbeat: 3600000,
      deviation: 0.5
    });
    
    // Initialize Uniswap V3 oracles
    this.addOracle('uniswap_v3_eth_usdc', {
      type: OracleType.UNISWAP_V3,
      poolAddress: '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8',
      pair: 'ETH/USDC',
      weight: 0.25,
      priority: 2,
      twapPeriod: 1800, // 30 minutes
      liquidity: BigNumber.from('1000000000000000000000000')
    });
    
    // Initialize other DEX oracles
    this.addOracle('balancer_eth_usdc', {
      type: OracleType.BALANCER,
      poolAddress: '0x96646936b91d6B9D7D0c47C496AfBF3D6ec7B6f8',
      pair: 'ETH/USDC',
      weight: 0.15,
      priority: 3
    });
    
    this.addOracle('sushiswap_eth_usdc', {
      type: OracleType.SUSHISWAP,
      poolAddress: '0x397FF1542f962076d0BFE58eA045FfA2d347ACa0',
      pair: 'ETH/USDC',
      weight: 0.15,
      priority: 3
    });
    
    this.addOracle('curve_usdc_usdt', {
      type: OracleType.CURVE,
      poolAddress: '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7',
      pair: 'USDC/USDT',
      weight: 0.15,
      priority: 3
    });
    
    this.logger.info(`Initialized ${this.oracles.size} oracle sources`);
  }
  
  /**
   * Add oracle source
   */
  addOracle(oracleId, config) {
    const oracle = {
      id: oracleId,
      ...config,
      status: SourceStatus.ACTIVE,
      lastUpdate: 0,
      lastPrice: BigNumber.from(0),
      reliability: 1.0,
      responseTime: 0,
      errorCount: 0,
      createdAt: Date.now(),
      
      // Statistics
      totalRequests: 0,
      successfulRequests: 0,
      averageLatency: 0,
      uptime: 1.0
    };
    
    this.oracles.set(oracleId, oracle);
    this.sourceWeights.set(oracleId, config.weight || 0.1);
    
    this.emit('oracle:added', { oracleId, config });
    return oracle;
  }
  
  /**
   * Remove oracle source
   */
  removeOracle(oracleId) {
    const oracle = this.oracles.get(oracleId);
    if (!oracle) return;
    
    this.oracles.delete(oracleId);
    this.sourceWeights.delete(oracleId);
    
    this.emit('oracle:removed', { oracleId });
  }
  
  /**
   * Get aggregated price for token pair
   */
  async getPrice(tokenPair, options = {}) {
    const startTime = Date.now();
    
    // Check circuit breaker
    if (this.circuitBreaker.isTripped(tokenPair)) {
      throw new Error(`Circuit breaker tripped for ${tokenPair}`);
    }
    
    // Get prices from all sources
    const prices = await this.collectPrices(tokenPair);
    
    if (prices.length < this.options.minSources) {
      throw new Error(`Insufficient price sources: ${prices.length} < ${this.options.minSources}`);
    }
    
    // Filter outliers
    const filteredPrices = this.outlierDetector.filterOutliers(prices);
    
    // Detect manipulation
    const manipulationCheck = this.manipulationDetector.checkManipulation(tokenPair, filteredPrices);
    
    if (manipulationCheck.isManipulated) {
      this.stats.manipulationAttempts++;
      this.emit('manipulation:detected', {
        tokenPair,
        reason: manipulationCheck.reason,
        prices: filteredPrices
      });
      
      // Use emergency aggregation method
      return this.getEmergencyPrice(tokenPair);
    }
    
    // Calculate confidence
    const confidence = this.confidenceCalculator.calculateConfidence(filteredPrices);
    
    if (confidence < this.options.confidenceThreshold) {
      this.logger.warn(`Low confidence price for ${tokenPair}: ${confidence}`);
    }
    
    // Aggregate prices
    const aggregationMethod = options.method || this.options.defaultAggregationMethod;
    const aggregatedPrice = this.aggregatePrices(filteredPrices, aggregationMethod);
    
    // Create price data
    const priceData = {
      tokenPair,
      price: aggregatedPrice.price,
      confidence,
      sources: filteredPrices.length,
      timestamp: Date.now(),
      method: aggregationMethod,
      latency: Date.now() - startTime,
      
      // Additional data
      priceRange: {
        min: Math.min(...filteredPrices.map(p => p.price)),
        max: Math.max(...filteredPrices.map(p => p.price))
      },
      
      sourceData: filteredPrices.map(p => ({
        source: p.source,
        price: p.price,
        weight: p.weight
      }))
    };
    
    // Store current price
    this.currentPrices.set(tokenPair, priceData);
    
    // Update price history
    this.updatePriceHistory(tokenPair, priceData);
    
    // Update statistics
    this.stats.totalPriceUpdates++;
    this.stats.averageLatency = 
      (this.stats.averageLatency * (this.stats.totalPriceUpdates - 1) + priceData.latency) / 
      this.stats.totalPriceUpdates;
    
    this.emit('price:updated', priceData);
    
    return priceData;
  }
  
  /**
   * Collect prices from all sources
   */
  async collectPrices(tokenPair) {
    const prices = [];
    const promises = [];
    
    // Filter relevant oracles for this pair
    const relevantOracles = Array.from(this.oracles.values())
      .filter(oracle => 
        oracle.pair === tokenPair && 
        oracle.status === SourceStatus.ACTIVE
      );
    
    // Create price fetch promises
    for (const oracle of relevantOracles) {
      const promise = this.fetchPriceFromOracle(oracle);
      promises.push(promise);
    }
    
    // Wait for all promises with timeout
    const results = await Promise.allSettled(promises);
    
    // Process results
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const oracle = relevantOracles[i];
      
      if (result.status === 'fulfilled' && result.value) {
        prices.push({
          source: oracle.id,
          price: result.value.price,
          weight: this.sourceWeights.get(oracle.id),
          confidence: result.value.confidence || 1.0,
          timestamp: result.value.timestamp,
          oracle: oracle.type
        });
        
        // Update oracle statistics
        oracle.successfulRequests++;
        oracle.reliability = Math.min(1.0, oracle.reliability + 0.01);
        oracle.lastPrice = result.value.price;
        oracle.lastUpdate = Date.now();
        
      } else {
        // Handle failure
        oracle.errorCount++;
        oracle.reliability = Math.max(0.1, oracle.reliability - 0.05);
        
        if (oracle.errorCount > 5) {
          oracle.status = SourceStatus.DEGRADED;
        }
        
        this.logger.warn(`Failed to fetch price from ${oracle.id}: ${result.reason}`);
      }
      
      oracle.totalRequests++;
    }
    
    return prices;
  }
  
  /**
   * Fetch price from individual oracle
   */
  async fetchPriceFromOracle(oracle) {
    const startTime = Date.now();
    
    try {
      let price;
      
      switch (oracle.type) {
        case OracleType.CHAINLINK:
          price = await this.fetchChainlinkPrice(oracle);
          break;
          
        case OracleType.UNISWAP_V3:
          price = await this.fetchUniswapV3Price(oracle);
          break;
          
        case OracleType.BALANCER:
          price = await this.fetchBalancerPrice(oracle);
          break;
          
        case OracleType.SUSHISWAP:
          price = await this.fetchSushiswapPrice(oracle);
          break;
          
        case OracleType.CURVE:
          price = await this.fetchCurvePrice(oracle);
          break;
          
        default:
          throw new Error(`Unsupported oracle type: ${oracle.type}`);
      }
      
      const responseTime = Date.now() - startTime;
      oracle.responseTime = responseTime;
      oracle.averageLatency = 
        (oracle.averageLatency * (oracle.totalRequests - 1) + responseTime) / 
        oracle.totalRequests;
      
      return {
        price: price,
        confidence: this.calculateSourceConfidence(oracle),
        timestamp: Date.now()
      };
      
    } catch (error) {
      this.logger.error(`Oracle ${oracle.id} fetch failed: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Fetch Chainlink price
   */
  async fetchChainlinkPrice(oracle) {
    // Simulate Chainlink price feed
    const basePrice = oracle.pair === 'ETH/USD' ? 2000 : 50000;
    const variance = basePrice * 0.02; // 2% variance
    const price = basePrice + (Math.random() - 0.5) * variance;
    
    return BigNumber.from(Math.floor(price * 100000000)); // 8 decimals
  }
  
  /**
   * Fetch Uniswap V3 price
   */
  async fetchUniswapV3Price(oracle) {
    // Simulate Uniswap V3 TWAP price
    const basePrice = 2000;
    const variance = basePrice * 0.01; // 1% variance
    const price = basePrice + (Math.random() - 0.5) * variance;
    
    return BigNumber.from(Math.floor(price * 1000000000000000000)); // 18 decimals
  }
  
  /**
   * Fetch Balancer price
   */
  async fetchBalancerPrice(oracle) {
    // Simulate Balancer weighted pool price
    const basePrice = 2000;
    const variance = basePrice * 0.015; // 1.5% variance
    const price = basePrice + (Math.random() - 0.5) * variance;
    
    return BigNumber.from(Math.floor(price * 1000000000000000000));
  }
  
  /**
   * Fetch Sushiswap price
   */
  async fetchSushiswapPrice(oracle) {
    // Simulate Sushiswap AMM price
    const basePrice = 2000;
    const variance = basePrice * 0.02; // 2% variance
    const price = basePrice + (Math.random() - 0.5) * variance;
    
    return BigNumber.from(Math.floor(price * 1000000000000000000));
  }
  
  /**
   * Fetch Curve price
   */
  async fetchCurvePrice(oracle) {
    // Simulate Curve stable swap price
    const basePrice = 1; // Stablecoin pair
    const variance = basePrice * 0.001; // 0.1% variance
    const price = basePrice + (Math.random() - 0.5) * variance;
    
    return BigNumber.from(Math.floor(price * 1000000000000000000));
  }
  
  /**
   * Calculate source confidence
   */
  calculateSourceConfidence(oracle) {
    let confidence = oracle.reliability;
    
    // Adjust for response time
    if (oracle.responseTime > 5000) {
      confidence *= 0.8; // Slow response
    } else if (oracle.responseTime < 1000) {
      confidence *= 1.1; // Fast response
    }
    
    // Adjust for price age
    const age = Date.now() - oracle.lastUpdate;
    if (age > this.options.maxPriceAge) {
      confidence *= 0.5; // Stale price
    }
    
    return Math.max(0.1, Math.min(1.0, confidence));
  }
  
  /**
   * Aggregate prices using specified method
   */
  aggregatePrices(prices, method) {
    switch (method) {
      case AggregationMethod.MEDIAN:
        return this.calculateMedianPrice(prices);
        
      case AggregationMethod.WEIGHTED_AVERAGE:
        return this.calculateWeightedAveragePrice(prices);
        
      case AggregationMethod.VOLUME_WEIGHTED:
        return this.calculateVolumeWeightedPrice(prices);
        
      case AggregationMethod.CONFIDENCE_WEIGHTED:
        return this.calculateConfidenceWeightedPrice(prices);
        
      default:
        return this.calculateMedianPrice(prices);
    }
  }
  
  /**
   * Calculate median price
   */
  calculateMedianPrice(prices) {
    const sortedPrices = prices.map(p => p.price).sort((a, b) => a - b);
    const middle = Math.floor(sortedPrices.length / 2);
    
    let medianPrice;
    if (sortedPrices.length % 2 === 0) {
      medianPrice = (sortedPrices[middle - 1] + sortedPrices[middle]) / 2;
    } else {
      medianPrice = sortedPrices[middle];
    }
    
    return {
      price: BigNumber.from(Math.floor(medianPrice)),
      method: AggregationMethod.MEDIAN,
      sources: prices.length
    };
  }
  
  /**
   * Calculate weighted average price
   */
  calculateWeightedAveragePrice(prices) {
    let totalWeight = 0;
    let weightedSum = 0;
    
    for (const priceData of prices) {
      totalWeight += priceData.weight;
      weightedSum += priceData.price * priceData.weight;
    }
    
    const weightedAverage = totalWeight > 0 ? weightedSum / totalWeight : 0;
    
    return {
      price: BigNumber.from(Math.floor(weightedAverage)),
      method: AggregationMethod.WEIGHTED_AVERAGE,
      sources: prices.length
    };
  }
  
  /**
   * Calculate volume weighted price
   */
  calculateVolumeWeightedPrice(prices) {
    // Simulate volume data
    let totalVolume = 0;
    let volumeWeightedSum = 0;
    
    for (const priceData of prices) {
      const volume = Math.random() * 1000000; // Mock volume
      totalVolume += volume;
      volumeWeightedSum += priceData.price * volume;
    }
    
    const volumeWeightedPrice = totalVolume > 0 ? volumeWeightedSum / totalVolume : 0;
    
    return {
      price: BigNumber.from(Math.floor(volumeWeightedPrice)),
      method: AggregationMethod.VOLUME_WEIGHTED,
      sources: prices.length
    };
  }
  
  /**
   * Calculate confidence weighted price
   */
  calculateConfidenceWeightedPrice(prices) {
    let totalConfidence = 0;
    let confidenceWeightedSum = 0;
    
    for (const priceData of prices) {
      totalConfidence += priceData.confidence;
      confidenceWeightedSum += priceData.price * priceData.confidence;
    }
    
    const confidenceWeightedPrice = totalConfidence > 0 ? confidenceWeightedSum / totalConfidence : 0;
    
    return {
      price: BigNumber.from(Math.floor(confidenceWeightedPrice)),
      method: AggregationMethod.CONFIDENCE_WEIGHTED,
      sources: prices.length
    };
  }
  
  /**
   * Get emergency price during manipulation
   */
  async getEmergencyPrice(tokenPair) {
    // Use historical data or most reliable source
    const history = this.priceHistory.get(tokenPair) || [];
    
    if (history.length > 0) {
      const recentPrices = history.slice(-10); // Last 10 prices
      const averagePrice = recentPrices.reduce((sum, p) => sum + p.price, 0) / recentPrices.length;
      
      return {
        tokenPair,
        price: BigNumber.from(Math.floor(averagePrice)),
        confidence: 0.7, // Lower confidence for emergency price
        sources: 1,
        timestamp: Date.now(),
        method: 'emergency',
        emergency: true
      };
    }
    
    throw new Error('No historical data available for emergency price');
  }
  
  /**
   * Update price history
   */
  updatePriceHistory(tokenPair, priceData) {
    if (!this.priceHistory.has(tokenPair)) {
      this.priceHistory.set(tokenPair, []);
    }
    
    const history = this.priceHistory.get(tokenPair);
    history.push({
      price: priceData.price.toNumber(),
      confidence: priceData.confidence,
      timestamp: priceData.timestamp
    });
    
    // Keep only recent history
    if (history.length > 1000) {
      history.shift();
    }
  }
  
  /**
   * Start price updates
   */
  startPriceUpdates() {
    setInterval(() => {
      this.updateAllPrices();
    }, this.options.priceUpdateInterval);
  }
  
  /**
   * Update all prices
   */
  async updateAllPrices() {
    const tokenPairs = new Set();
    
    // Collect all token pairs
    for (const oracle of this.oracles.values()) {
      tokenPairs.add(oracle.pair);
    }
    
    // Update prices for each pair
    for (const pair of tokenPairs) {
      try {
        await this.getPrice(pair);
      } catch (error) {
        this.logger.error(`Failed to update price for ${pair}: ${error.message}`);
      }
    }
  }
  
  /**
   * Start heartbeat monitoring
   */
  startHeartbeat() {
    setInterval(() => {
      this.performHeartbeat();
    }, this.options.heartbeatInterval);
  }
  
  /**
   * Perform heartbeat check
   */
  async performHeartbeat() {
    const now = Date.now();
    
    for (const [oracleId, oracle] of this.oracles) {
      const timeSinceUpdate = now - oracle.lastUpdate;
      
      // Check if oracle is responding
      if (timeSinceUpdate > this.options.heartbeatInterval * 2) {
        if (oracle.status === SourceStatus.ACTIVE) {
          oracle.status = SourceStatus.DEGRADED;
          this.emit('oracle:degraded', { oracleId, timeSinceUpdate });
        }
      }
      
      // Check if oracle has failed
      if (timeSinceUpdate > this.options.heartbeatInterval * 5) {
        if (oracle.status !== SourceStatus.FAILED) {
          oracle.status = SourceStatus.FAILED;
          this.emit('oracle:failed', { oracleId, timeSinceUpdate });
        }
      }
      
      // Calculate uptime
      const totalTime = now - oracle.createdAt;
      const downtime = oracle.errorCount * this.options.heartbeatInterval;
      oracle.uptime = Math.max(0, 1 - (downtime / totalTime));
    }
  }
  
  /**
   * Start manipulation detection
   */
  startManipulationDetection() {
    setInterval(() => {
      this.scanForManipulation();
    }, 60000); // Every minute
  }
  
  /**
   * Scan for price manipulation
   */
  scanForManipulation() {
    for (const [tokenPair, priceData] of this.currentPrices) {
      const manipulation = this.manipulationDetector.detectManipulation(tokenPair, priceData);
      
      if (manipulation.detected) {
        this.stats.manipulationAttempts++;
        
        // Trigger circuit breaker
        this.circuitBreaker.trip(tokenPair, manipulation.reason);
        
        this.emit('manipulation:detected', {
          tokenPair,
          manipulation,
          priceData
        });
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
    // Calculate overall uptime
    const totalOracles = this.oracles.size;
    const activeOracles = Array.from(this.oracles.values())
      .filter(oracle => oracle.status === SourceStatus.ACTIVE).length;
    
    this.stats.uptimePercentage = totalOracles > 0 ? (activeOracles / totalOracles) * 100 : 0;
    
    // Calculate outlier detections
    this.stats.outlierDetections = this.outlierDetector.getDetectionCount();
    
    // Calculate circuit breaker trips
    this.stats.circuitBreakerTrips = this.circuitBreaker.getTripCount();
  }
  
  /**
   * Get current price
   */
  getCurrentPrice(tokenPair) {
    return this.currentPrices.get(tokenPair);
  }
  
  /**
   * Get price history
   */
  getPriceHistory(tokenPair, limit = 100) {
    const history = this.priceHistory.get(tokenPair) || [];
    return history.slice(-limit);
  }
  
  /**
   * Get oracle status
   */
  getOracleStatus(oracleId) {
    const oracle = this.oracles.get(oracleId);
    if (!oracle) return null;
    
    return {
      id: oracle.id,
      type: oracle.type,
      pair: oracle.pair,
      status: oracle.status,
      reliability: oracle.reliability,
      uptime: oracle.uptime,
      lastUpdate: oracle.lastUpdate,
      averageLatency: oracle.averageLatency,
      successRate: oracle.totalRequests > 0 ? 
        (oracle.successfulRequests / oracle.totalRequests) * 100 : 0
    };
  }
  
  /**
   * Get all oracle statuses
   */
  getAllOracleStatuses() {
    const statuses = [];
    
    for (const [oracleId] of this.oracles) {
      statuses.push(this.getOracleStatus(oracleId));
    }
    
    return statuses;
  }
  
  /**
   * Get aggregator statistics
   */
  getStats() {
    return {
      ...this.stats,
      totalOracles: this.oracles.size,
      activeOracles: Array.from(this.oracles.values())
        .filter(oracle => oracle.status === SourceStatus.ACTIVE).length,
      totalPairs: new Set(Array.from(this.oracles.values()).map(o => o.pair)).size,
      currentPrices: this.currentPrices.size
    };
  }
}

/**
 * Manipulation Detector
 */
class ManipulationDetector {
  constructor(options = {}) {
    this.options = options;
    this.priceHistory = new Map();
    this.detectionCount = 0;
  }
  
  checkManipulation(tokenPair, prices) {
    // Check for extreme price deviations
    const priceValues = prices.map(p => p.price);
    const mean = priceValues.reduce((sum, price) => sum + price, 0) / priceValues.length;
    
    const deviations = priceValues.map(price => Math.abs(price - mean) / mean);
    const maxDeviation = Math.max(...deviations);
    
    if (maxDeviation > this.options.maxPriceDeviation) {
      return {
        isManipulated: true,
        reason: 'Extreme price deviation detected',
        maxDeviation,
        threshold: this.options.maxPriceDeviation
      };
    }
    
    return { isManipulated: false };
  }
  
  detectManipulation(tokenPair, currentPrice) {
    const history = this.priceHistory.get(tokenPair) || [];
    
    if (history.length < 5) {
      // Not enough history
      return { detected: false };
    }
    
    const recentPrices = history.slice(-5);
    const avgRecentPrice = recentPrices.reduce((sum, p) => sum + p.price, 0) / recentPrices.length;
    
    const deviation = Math.abs(currentPrice.price.toNumber() - avgRecentPrice) / avgRecentPrice;
    
    if (deviation > 0.2) { // 20% deviation
      this.detectionCount++;
      return {
        detected: true,
        reason: 'Sudden price movement detected',
        deviation,
        threshold: 0.2
      };
    }
    
    return { detected: false };
  }
}

/**
 * Outlier Detector
 */
class OutlierDetector {
  constructor(options = {}) {
    this.options = options;
    this.detectionCount = 0;
  }
  
  filterOutliers(prices) {
    if (prices.length < 3) {
      return prices;
    }
    
    const priceValues = prices.map(p => p.price);
    const mean = priceValues.reduce((sum, price) => sum + price, 0) / priceValues.length;
    
    const filteredPrices = prices.filter(priceData => {
      const deviation = Math.abs(priceData.price - mean) / mean;
      
      if (deviation > this.options.outlierThreshold) {
        this.detectionCount++;
        return false;
      }
      
      return true;
    });
    
    return filteredPrices.length >= 2 ? filteredPrices : prices;
  }
  
  getDetectionCount() {
    return this.detectionCount;
  }
}

/**
 * Confidence Calculator
 */
class ConfidenceCalculator {
  constructor(options = {}) {
    this.options = options;
  }
  
  calculateConfidence(prices) {
    if (prices.length === 0) return 0;
    
    let totalConfidence = 0;
    let totalWeight = 0;
    
    // Calculate agreement between sources
    const priceValues = prices.map(p => p.price);
    const mean = priceValues.reduce((sum, price) => sum + price, 0) / priceValues.length;
    
    for (const priceData of prices) {
      const deviation = Math.abs(priceData.price - mean) / mean;
      const agreement = Math.max(0, 1 - deviation * 5); // Scale deviation
      
      const sourceConfidence = priceData.confidence || 1.0;
      const weight = priceData.weight || 1.0;
      
      totalConfidence += agreement * sourceConfidence * weight;
      totalWeight += weight;
    }
    
    const baseConfidence = totalWeight > 0 ? totalConfidence / totalWeight : 0;
    
    // Adjust for number of sources
    const sourceBonus = Math.min(0.2, prices.length * 0.05);
    
    return Math.min(1.0, baseConfidence + sourceBonus);
  }
}

/**
 * Circuit Breaker
 */
class CircuitBreaker {
  constructor(options = {}) {
    this.options = options;
    this.trippedPairs = new Map();
    this.tripCount = 0;
  }
  
  trip(tokenPair, reason) {
    this.trippedPairs.set(tokenPair, {
      reason,
      trippedAt: Date.now(),
      duration: 300000 // 5 minutes
    });
    
    this.tripCount++;
    
    // Auto-reset after duration
    setTimeout(() => {
      this.reset(tokenPair);
    }, 300000);
  }
  
  reset(tokenPair) {
    this.trippedPairs.delete(tokenPair);
  }
  
  isTripped(tokenPair) {
    return this.trippedPairs.has(tokenPair);
  }
  
  getTripCount() {
    return this.tripCount;
  }
}