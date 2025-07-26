/**
 * Mining Profitability Calculator - Otedama
 * Real-time profitability calculations for mining operations
 * 
 * Design Principles:
 * - Carmack: Fast calculations with minimal overhead
 * - Martin: Clean separation of calculation domains
 * - Pike: Simple interface for complex economics
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('ProfitabilityCalculator');

/**
 * Calculation modes
 */
const CALCULATION_MODES = {
  REAL_TIME: 'real_time',        // Current profitability
  HISTORICAL: 'historical',       // Based on historical data
  PROJECTED: 'projected',         // Future projections
  COMPARATIVE: 'comparative'      // Compare different scenarios
};

/**
 * Cost factors
 */
const COST_FACTORS = {
  ELECTRICITY: 'electricity',
  HARDWARE: 'hardware',
  COOLING: 'cooling',
  MAINTENANCE: 'maintenance',
  POOL_FEES: 'pool_fees',
  NETWORK_FEES: 'network_fees'
};

/**
 * Mining Profitability Calculator
 */
export class ProfitabilityCalculator extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Update intervals
      priceUpdateInterval: config.priceUpdateInterval || 60000, // 1 minute
      difficultyUpdateInterval: config.difficultyUpdateInterval || 600000, // 10 minutes
      
      // Default costs
      electricityRate: config.electricityRate || 0.10, // $/kWh
      coolingEfficiency: config.coolingEfficiency || 0.3, // 30% of power for cooling
      maintenanceCostRatio: config.maintenanceCostRatio || 0.02, // 2% monthly
      
      // Calculation settings
      calculationMode: config.calculationMode || CALCULATION_MODES.REAL_TIME,
      projectionPeriod: config.projectionPeriod || 365, // days
      
      // Currency settings
      baseCurrency: config.baseCurrency || 'USD',
      supportedCurrencies: config.supportedCurrencies || ['BTC', 'ETH', 'LTC'],
      
      ...config
    };
    
    // Market data
    this.marketData = new Map();
    this.difficultyData = new Map();
    this.blockRewards = new Map();
    
    // Hardware profiles
    this.hardwareProfiles = new Map();
    
    // Calculation cache
    this.calculationCache = new Map();
    this.historicalData = [];
    
    // Statistics
    this.stats = {
      calculationsPerformed: 0,
      lastUpdateTime: Date.now(),
      averageCalculationTime: 0
    };
    
    this.logger = logger;
  }
  
  /**
   * Initialize calculator
   */
  async initialize() {
    // Load initial market data
    await this.loadMarketData();
    
    // Load hardware profiles
    this.loadHardwareProfiles();
    
    // Start update intervals
    this.startDataUpdates();
    
    this.logger.info('Profitability calculator initialized', {
      mode: this.config.calculationMode,
      currencies: this.config.supportedCurrencies
    });
  }
  
  /**
   * Calculate profitability for given parameters
   */
  calculate(params) {
    const startTime = Date.now();
    
    const {
      algorithm,
      hashrate,
      powerConsumption,
      hardwareProfile,
      currency = 'BTC',
      electricityRate = this.config.electricityRate,
      poolFee = 0.01
    } = params;
    
    // Get current data
    const marketPrice = this.getMarketPrice(currency);
    const difficulty = this.getDifficulty(currency, algorithm);
    const blockReward = this.getBlockReward(currency);
    
    if (!marketPrice || !difficulty || !blockReward) {
      return {
        error: 'Missing market data',
        currency,
        algorithm
      };
    }
    
    // Calculate mining rewards
    const miningRewards = this.calculateMiningRewards({
      hashrate,
      difficulty,
      blockReward,
      algorithm,
      currency
    });
    
    // Calculate costs
    const costs = this.calculateCosts({
      powerConsumption,
      electricityRate,
      hardwareProfile,
      poolFee,
      miningRewards
    });
    
    // Calculate profitability
    const profitability = this.calculateProfitability({
      miningRewards,
      costs,
      marketPrice
    });
    
    // Cache result
    const result = {
      timestamp: Date.now(),
      params,
      miningRewards,
      costs,
      profitability,
      marketData: {
        price: marketPrice,
        difficulty,
        blockReward
      }
    };
    
    this.cacheCalculation(result);
    
    // Update statistics
    const duration = Date.now() - startTime;
    this.updateStats(duration);
    
    this.emit('calculation:completed', result);
    
    return result;
  }
  
  /**
   * Calculate mining rewards
   */
  calculateMiningRewards(params) {
    const { hashrate, difficulty, blockReward, algorithm, currency } = params;
    
    // Algorithm-specific calculations
    let blocksPerDay;
    let networkHashrate;
    
    switch (algorithm) {
      case 'sha256':
        // Bitcoin-like
        blocksPerDay = 144; // 10 min blocks
        networkHashrate = difficulty * Math.pow(2, 32) / 600;
        break;
        
      case 'ethash':
        // Ethereum-like
        blocksPerDay = 6646; // ~13 sec blocks
        networkHashrate = difficulty / 13;
        break;
        
      case 'scrypt':
        // Litecoin-like
        blocksPerDay = 576; // 2.5 min blocks
        networkHashrate = difficulty * Math.pow(2, 32) / 150;
        break;
        
      default:
        blocksPerDay = 144;
        networkHashrate = difficulty * Math.pow(2, 32) / 600;
    }
    
    // Calculate expected rewards
    const minerShare = hashrate / networkHashrate;
    const expectedBlocksPerDay = blocksPerDay * minerShare;
    const dailyReward = expectedBlocksPerDay * blockReward;
    
    return {
      dailyReward,
      monthlyReward: dailyReward * 30,
      yearlyReward: dailyReward * 365,
      expectedBlocksPerDay,
      minerShare: minerShare * 100, // percentage
      networkHashrate
    };
  }
  
  /**
   * Calculate mining costs
   */
  calculateCosts(params) {
    const {
      powerConsumption,
      electricityRate,
      hardwareProfile,
      poolFee,
      miningRewards
    } = params;
    
    // Electricity costs
    const dailyPowerUsage = (powerConsumption / 1000) * 24; // kWh
    const dailyElectricityCost = dailyPowerUsage * electricityRate;
    
    // Cooling costs
    const coolingPower = powerConsumption * this.config.coolingEfficiency;
    const dailyCoolingUsage = (coolingPower / 1000) * 24;
    const dailyCoolingCost = dailyCoolingUsage * electricityRate;
    
    // Hardware depreciation (if profile provided)
    let dailyHardwareCost = 0;
    if (hardwareProfile) {
      const profile = this.hardwareProfiles.get(hardwareProfile);
      if (profile) {
        // Linear depreciation over lifespan
        dailyHardwareCost = profile.cost / (profile.lifespan * 365);
      }
    }
    
    // Maintenance costs
    const dailyMaintenanceCost = dailyHardwareCost * this.config.maintenanceCostRatio / 30;
    
    // Pool fees
    const dailyPoolFee = miningRewards.dailyReward * poolFee;
    
    // Total costs
    const totalDailyCost = 
      dailyElectricityCost + 
      dailyCoolingCost + 
      dailyHardwareCost + 
      dailyMaintenanceCost + 
      dailyPoolFee;
    
    return {
      electricity: {
        daily: dailyElectricityCost,
        monthly: dailyElectricityCost * 30,
        yearly: dailyElectricityCost * 365
      },
      cooling: {
        daily: dailyCoolingCost,
        monthly: dailyCoolingCost * 30,
        yearly: dailyCoolingCost * 365
      },
      hardware: {
        daily: dailyHardwareCost,
        monthly: dailyHardwareCost * 30,
        yearly: dailyHardwareCost * 365
      },
      maintenance: {
        daily: dailyMaintenanceCost,
        monthly: dailyMaintenanceCost * 30,
        yearly: dailyMaintenanceCost * 365
      },
      poolFees: {
        daily: dailyPoolFee,
        monthly: dailyPoolFee * 30,
        yearly: dailyPoolFee * 365
      },
      total: {
        daily: totalDailyCost,
        monthly: totalDailyCost * 30,
        yearly: totalDailyCost * 365
      }
    };
  }
  
  /**
   * Calculate profitability metrics
   */
  calculateProfitability(params) {
    const { miningRewards, costs, marketPrice } = params;
    
    // Revenue in base currency
    const dailyRevenue = miningRewards.dailyReward * marketPrice;
    const monthlyRevenue = miningRewards.monthlyReward * marketPrice;
    const yearlyRevenue = miningRewards.yearlyReward * marketPrice;
    
    // Profit calculations
    const dailyProfit = dailyRevenue - costs.total.daily;
    const monthlyProfit = monthlyRevenue - costs.total.monthly;
    const yearlyProfit = yearlyRevenue - costs.total.yearly;
    
    // ROI calculations
    const dailyROI = costs.total.daily > 0 ? (dailyProfit / costs.total.daily) * 100 : 0;
    const monthlyROI = costs.total.monthly > 0 ? (monthlyProfit / costs.total.monthly) * 100 : 0;
    
    // Break-even analysis
    const breakEvenDays = costs.hardware.daily > 0 
      ? Math.abs(costs.hardware.yearly / 365 / dailyProfit)
      : Infinity;
    
    // Efficiency metrics
    const revenuePerTH = dailyRevenue / (params.hashrate / 1e12);
    const profitPerTH = dailyProfit / (params.hashrate / 1e12);
    const electricityEfficiency = dailyRevenue / costs.electricity.daily;
    
    return {
      revenue: {
        daily: dailyRevenue,
        monthly: monthlyRevenue,
        yearly: yearlyRevenue
      },
      profit: {
        daily: dailyProfit,
        monthly: monthlyProfit,
        yearly: yearlyProfit
      },
      roi: {
        daily: dailyROI,
        monthly: monthlyROI
      },
      margins: {
        gross: (dailyProfit / dailyRevenue) * 100,
        net: ((dailyRevenue - costs.total.daily) / dailyRevenue) * 100
      },
      breakEven: {
        days: breakEvenDays,
        date: new Date(Date.now() + breakEvenDays * 86400000)
      },
      efficiency: {
        revenuePerTH,
        profitPerTH,
        electricityEfficiency
      },
      isProfitable: dailyProfit > 0
    };
  }
  
  /**
   * Project future profitability
   */
  projectProfitability(params, days = this.config.projectionPeriod) {
    const projections = [];
    const baseCalculation = this.calculate(params);
    
    if (baseCalculation.error) {
      return { error: baseCalculation.error };
    }
    
    // Projection factors
    const difficultyGrowthRate = this.estimateDifficultyGrowth(params.currency);
    const priceVolatility = this.estimatePriceVolatility(params.currency);
    
    for (let day = 0; day <= days; day += 30) {
      // Adjust difficulty
      const projectedDifficulty = baseCalculation.marketData.difficulty * 
        Math.pow(1 + difficultyGrowthRate, day / 365);
      
      // Simulate price (simplified random walk)
      const priceChange = (Math.random() - 0.5) * priceVolatility;
      const projectedPrice = baseCalculation.marketData.price * 
        (1 + priceChange);
      
      // Recalculate with projected values
      const projection = this.calculate({
        ...params,
        _projected: true,
        _difficulty: projectedDifficulty,
        _price: projectedPrice
      });
      
      projections.push({
        day,
        date: new Date(Date.now() + day * 86400000),
        difficulty: projectedDifficulty,
        price: projectedPrice,
        profitability: projection.profitability
      });
    }
    
    return {
      baseCalculation,
      projections,
      summary: {
        averageProfit: this.average(projections.map(p => p.profitability.profit.daily)),
        bestCase: Math.max(...projections.map(p => p.profitability.profit.daily)),
        worstCase: Math.min(...projections.map(p => p.profitability.profit.daily)),
        profitableDays: projections.filter(p => p.profitability.isProfitable).length
      }
    };
  }
  
  /**
   * Compare multiple scenarios
   */
  compareScenarios(scenarios) {
    const results = [];
    
    for (const scenario of scenarios) {
      const calculation = this.calculate(scenario);
      results.push({
        name: scenario.name || 'Unnamed',
        params: scenario,
        result: calculation
      });
    }
    
    // Sort by profitability
    results.sort((a, b) => 
      b.result.profitability.profit.daily - a.result.profitability.profit.daily
    );
    
    return {
      scenarios: results,
      best: results[0],
      comparison: {
        mostProfitable: results[0].name,
        leastProfitable: results[results.length - 1].name,
        averageProfit: this.average(results.map(r => r.result.profitability.profit.daily))
      }
    };
  }
  
  /**
   * Load hardware profiles
   */
  loadHardwareProfiles() {
    // Common mining hardware profiles
    const profiles = [
      {
        id: 'antminer_s19_pro',
        name: 'Antminer S19 Pro',
        hashrate: 110e12, // 110 TH/s
        power: 3250, // watts
        algorithm: 'sha256',
        cost: 10000,
        lifespan: 3 // years
      },
      {
        id: 'rtx_3090',
        name: 'NVIDIA RTX 3090',
        hashrate: 120e6, // 120 MH/s (Ethash)
        power: 350,
        algorithm: 'ethash',
        cost: 2000,
        lifespan: 3
      },
      {
        id: 'antminer_l7',
        name: 'Antminer L7',
        hashrate: 9.5e9, // 9.5 GH/s
        power: 3425,
        algorithm: 'scrypt',
        cost: 15000,
        lifespan: 3
      }
    ];
    
    for (const profile of profiles) {
      this.hardwareProfiles.set(profile.id, profile);
    }
  }
  
  /**
   * Market data management
   */
  
  async loadMarketData() {
    // Simulate loading market data
    this.marketData.set('BTC', { price: 50000, change24h: 2.5 });
    this.marketData.set('ETH', { price: 3000, change24h: -1.2 });
    this.marketData.set('LTC', { price: 150, change24h: 0.8 });
    
    this.difficultyData.set('BTC:sha256', 35e12);
    this.difficultyData.set('ETH:ethash', 15e15);
    this.difficultyData.set('LTC:scrypt', 20e6);
    
    this.blockRewards.set('BTC', 6.25);
    this.blockRewards.set('ETH', 2);
    this.blockRewards.set('LTC', 12.5);
  }
  
  getMarketPrice(currency) {
    const data = this.marketData.get(currency);
    return data?.price || 0;
  }
  
  getDifficulty(currency, algorithm) {
    return this.difficultyData.get(`${currency}:${algorithm}`) || 0;
  }
  
  getBlockReward(currency) {
    return this.blockRewards.get(currency) || 0;
  }
  
  /**
   * Estimation helpers
   */
  
  estimateDifficultyGrowth(currency) {
    // Simplified estimation based on historical trends
    const growthRates = {
      'BTC': 0.05, // 5% annual growth
      'ETH': 0.03, // 3% annual growth
      'LTC': 0.02  // 2% annual growth
    };
    
    return growthRates[currency] || 0.03;
  }
  
  estimatePriceVolatility(currency) {
    // Simplified volatility estimation
    const volatilities = {
      'BTC': 0.3,  // 30% volatility
      'ETH': 0.4,  // 40% volatility
      'LTC': 0.35  // 35% volatility
    };
    
    return volatilities[currency] || 0.3;
  }
  
  /**
   * Data updates
   */
  
  startDataUpdates() {
    // Update market prices
    this.priceInterval = setInterval(() => {
      this.updateMarketPrices();
    }, this.config.priceUpdateInterval);
    
    // Update difficulty
    this.difficultyInterval = setInterval(() => {
      this.updateDifficulty();
    }, this.config.difficultyUpdateInterval);
  }
  
  updateMarketPrices() {
    // Simulate price updates
    for (const [currency, data] of this.marketData) {
      const change = (Math.random() - 0.5) * 0.02; // ±1% change
      data.price *= (1 + change);
      data.change24h = change * 100;
    }
    
    this.emit('prices:updated', Object.fromEntries(this.marketData));
  }
  
  updateDifficulty() {
    // Simulate difficulty adjustments
    for (const [key, difficulty] of this.difficultyData) {
      const adjustment = (Math.random() - 0.5) * 0.01; // ±0.5% change
      this.difficultyData.set(key, difficulty * (1 + adjustment));
    }
    
    this.emit('difficulty:updated', Object.fromEntries(this.difficultyData));
  }
  
  /**
   * Caching and statistics
   */
  
  cacheCalculation(result) {
    const key = this.generateCacheKey(result.params);
    this.calculationCache.set(key, result);
    
    // Limit cache size
    if (this.calculationCache.size > 1000) {
      const firstKey = this.calculationCache.keys().next().value;
      this.calculationCache.delete(firstKey);
    }
    
    // Store historical data
    this.historicalData.push({
      timestamp: result.timestamp,
      profitability: result.profitability.profit.daily
    });
    
    // Limit historical data
    if (this.historicalData.length > 10000) {
      this.historicalData.shift();
    }
  }
  
  generateCacheKey(params) {
    return `${params.algorithm}-${params.hashrate}-${params.currency}-${params.electricityRate}`;
  }
  
  updateStats(duration) {
    this.stats.calculationsPerformed++;
    this.stats.lastUpdateTime = Date.now();
    
    // Update average calculation time
    const n = this.stats.calculationsPerformed;
    this.stats.averageCalculationTime = 
      (this.stats.averageCalculationTime * (n - 1) + duration) / n;
  }
  
  /**
   * Utility methods
   */
  
  average(values) {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }
  
  /**
   * Get calculator statistics
   */
  getStats() {
    return {
      ...this.stats,
      cachedCalculations: this.calculationCache.size,
      historicalDataPoints: this.historicalData.length,
      supportedCurrencies: this.config.supportedCurrencies,
      hardwareProfiles: this.hardwareProfiles.size
    };
  }
  
  /**
   * Shutdown calculator
   */
  shutdown() {
    if (this.priceInterval) {
      clearInterval(this.priceInterval);
    }
    
    if (this.difficultyInterval) {
      clearInterval(this.difficultyInterval);
    }
    
    this.logger.info('Profitability calculator shutdown');
  }
}

// Export constants
export {
  CALCULATION_MODES,
  COST_FACTORS
};

export default ProfitabilityCalculator;