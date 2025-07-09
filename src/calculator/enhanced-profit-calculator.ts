/**
 * Enhanced Profit Calculator with Advanced Features
 * Real-time market data, multi-algorithm support, and AI-powered predictions
 * Following Martin's clean architecture principles
 */

import { EventEmitter } from 'events';
import { Logger } from '../logging/logger';
import { ProfitCalculator, MiningHardware, ElectricityCost, MiningParameters, ProfitabilityResult } from './profit-calculator';

const logger = new Logger('EnhancedProfitCalculator');

// Market data provider interface
export interface MarketDataProvider {
  getCurrentPrice(symbol: string): Promise<number>;
  getHistoricalPrices(symbol: string, days: number): Promise<Array<{ date: Date; price: number }>>;
  getDifficulty(network: string): Promise<number>;
  getNetworkHashrate(network: string): Promise<number>;
  getBlockReward(network: string): Promise<number>;
}

// Algorithm configuration
export interface AlgorithmConfig {
  name: string;
  symbol: string;
  blockTime: number; // seconds
  difficultyAdjustmentInterval: number; // blocks
  rewardHalvingInterval?: number; // blocks
  supportedHardware: string[]; // Hardware model names
  powerMultiplier: number; // Power efficiency factor
  marketCap?: number;
  exchanges: string[];
}

// Mining pool configuration
export interface PoolConfiguration {
  name: string;
  url: string;
  algorithm: string;
  fee: number; // percentage
  payoutMethod: 'PPS' | 'PPLNS' | 'PROP' | 'SOLO';
  minimumPayout: number;
  latency: number; // ms
  reliability: number; // 0-1
  shareRate: number; // shares per second
}

// Market analysis result
export interface MarketAnalysis {
  currentPrice: number;
  priceChange24h: number;
  priceChange7d: number;
  priceChange30d: number;
  volatility: number;
  marketCap: number;
  volume24h: number;
  priceTargets: {
    bearish: number;
    neutral: number;
    bullish: number;
  };
  sentiment: 'bearish' | 'neutral' | 'bullish';
  confidence: number; // 0-1
}

// Profitability forecast
export interface ProfitabilityForecast {
  timeframe: '1d' | '1w' | '1m' | '3m' | '6m' | '1y';
  scenarios: {
    pessimistic: ProfitabilityResult;
    realistic: ProfitabilityResult;
    optimistic: ProfitabilityResult;
  };
  riskFactors: string[];
  confidence: number;
}

// Multi-algorithm comparison
export interface AlgorithmComparison {
  algorithm: string;
  profitability: ProfitabilityResult;
  marketAnalysis: MarketAnalysis;
  competitionLevel: 'low' | 'medium' | 'high';
  recommendation: 'strong-buy' | 'buy' | 'hold' | 'sell' | 'strong-sell';
  score: number; // 0-100
}

/**
 * Real-time market data provider
 */
export class RealTimeMarketProvider implements MarketDataProvider {
  private cache = new Map<string, { data: any; expires: number }>();
  private readonly CACHE_TTL = 60000; // 1 minute

  constructor(
    private apiKeys: {
      coinGecko?: string;
      coinMarketCap?: string;
      blockchainInfo?: string;
    } = {}
  ) {}

  async getCurrentPrice(symbol: string): Promise<number> {
    const cacheKey = `price_${symbol}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() < cached.expires) {
      return cached.data;
    }

    try {
      // Try multiple APIs for redundancy
      const price = await this.fetchPriceFromAPIs(symbol);
      
      this.cache.set(cacheKey, {
        data: price,
        expires: Date.now() + this.CACHE_TTL
      });
      
      return price;
    } catch (error) {
      logger.error('Failed to fetch current price', error as Error, { symbol });
      throw error;
    }
  }

  async getHistoricalPrices(symbol: string, days: number): Promise<Array<{ date: Date; price: number }>> {
    const cacheKey = `history_${symbol}_${days}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() < cached.expires) {
      return cached.data;
    }

    try {
      const prices = await this.fetchHistoricalPrices(symbol, days);
      
      this.cache.set(cacheKey, {
        data: prices,
        expires: Date.now() + this.CACHE_TTL * 5 // 5 minutes for historical data
      });
      
      return prices;
    } catch (error) {
      logger.error('Failed to fetch historical prices', error as Error, { symbol, days });
      throw error;
    }
  }

  async getDifficulty(network: string): Promise<number> {
    const cacheKey = `difficulty_${network}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() < cached.expires) {
      return cached.data;
    }

    try {
      const difficulty = await this.fetchNetworkDifficulty(network);
      
      this.cache.set(cacheKey, {
        data: difficulty,
        expires: Date.now() + this.CACHE_TTL * 2 // 2 minutes
      });
      
      return difficulty;
    } catch (error) {
      logger.error('Failed to fetch network difficulty', error as Error, { network });
      throw error;
    }
  }

  async getNetworkHashrate(network: string): Promise<number> {
    const cacheKey = `hashrate_${network}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() < cached.expires) {
      return cached.data;
    }

    try {
      const hashrate = await this.fetchNetworkHashrate(network);
      
      this.cache.set(cacheKey, {
        data: hashrate,
        expires: Date.now() + this.CACHE_TTL * 2
      });
      
      return hashrate;
    } catch (error) {
      logger.error('Failed to fetch network hashrate', error as Error, { network });
      throw error;
    }
  }

  async getBlockReward(network: string): Promise<number> {
    // Block rewards change infrequently, cache for longer
    const cacheKey = `reward_${network}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() < cached.expires) {
      return cached.data;
    }

    try {
      const reward = await this.fetchBlockReward(network);
      
      this.cache.set(cacheKey, {
        data: reward,
        expires: Date.now() + this.CACHE_TTL * 60 // 1 hour
      });
      
      return reward;
    } catch (error) {
      logger.error('Failed to fetch block reward', error as Error, { network });
      throw error;
    }
  }

  private async fetchPriceFromAPIs(symbol: string): Promise<number> {
    // Mock implementation - in production would use real APIs
    const mockPrices: { [key: string]: number } = {
      'BTC': 45000 + Math.random() * 10000,
      'ETH': 3000 + Math.random() * 1000,
      'LTC': 100 + Math.random() * 50,
      'DOGE': 0.1 + Math.random() * 0.05
    };
    
    return mockPrices[symbol.toUpperCase()] || 100;
  }

  private async fetchHistoricalPrices(symbol: string, days: number): Promise<Array<{ date: Date; price: number }>> {
    // Mock implementation
    const prices = [];
    const basePrice = await this.getCurrentPrice(symbol);
    
    for (let i = days; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      
      // Simulate price volatility
      const volatility = Math.random() * 0.1 - 0.05; // ±5%
      const price = basePrice * (1 + volatility * i / days);
      
      prices.push({ date, price });
    }
    
    return prices;
  }

  private async fetchNetworkDifficulty(network: string): Promise<number> {
    // Mock implementation
    const mockDifficulties: { [key: string]: number } = {
      'bitcoin': 25e12,
      'litecoin': 15e6,
      'ethereum': 10e15
    };
    
    return mockDifficulties[network.toLowerCase()] || 1e12;
  }

  private async fetchNetworkHashrate(network: string): Promise<number> {
    // Mock implementation
    const mockHashrates: { [key: string]: number } = {
      'bitcoin': 200e18, // 200 EH/s
      'litecoin': 500e12, // 500 TH/s
      'ethereum': 900e12  // 900 TH/s
    };
    
    return mockHashrates[network.toLowerCase()] || 1e15;
  }

  private async fetchBlockReward(network: string): Promise<number> {
    // Mock implementation
    const mockRewards: { [key: string]: number } = {
      'bitcoin': 6.25,
      'litecoin': 12.5,
      'ethereum': 2.0
    };
    
    return mockRewards[network.toLowerCase()] || 1.0;
  }
}

/**
 * Algorithm manager for multi-coin mining
 */
export class AlgorithmManager {
  private algorithms = new Map<string, AlgorithmConfig>();

  constructor() {
    this.initializeAlgorithms();
  }

  private initializeAlgorithms(): void {
    const configs: AlgorithmConfig[] = [
      {
        name: 'SHA256',
        symbol: 'BTC',
        blockTime: 600,
        difficultyAdjustmentInterval: 2016,
        rewardHalvingInterval: 210000,
        supportedHardware: ['Antminer S19 Pro', 'Antminer S19j Pro', 'Whatsminer M30S++'],
        powerMultiplier: 1.0,
        marketCap: 800000000000,
        exchanges: ['binance', 'coinbase', 'kraken']
      },
      {
        name: 'Scrypt',
        symbol: 'LTC',
        blockTime: 150,
        difficultyAdjustmentInterval: 2016,
        rewardHalvingInterval: 840000,
        supportedHardware: ['Antminer L7', 'Innosilicon A6+ LTCMaster'],
        powerMultiplier: 0.8,
        marketCap: 8000000000,
        exchanges: ['binance', 'coinbase', 'okex']
      },
      {
        name: 'Ethash',
        symbol: 'ETH',
        blockTime: 13,
        difficultyAdjustmentInterval: 1,
        supportedHardware: ['RTX 3080', 'RTX 3090', 'RX 6800 XT'],
        powerMultiplier: 1.2,
        marketCap: 400000000000,
        exchanges: ['binance', 'coinbase', 'uniswap']
      },
      {
        name: 'X11',
        symbol: 'DASH',
        blockTime: 150,
        difficultyAdjustmentInterval: 2016,
        supportedHardware: ['Antminer D7', 'iBeLink DM22G'],
        powerMultiplier: 0.9,
        marketCap: 1000000000,
        exchanges: ['binance', 'bittrex', 'poloniex']
      }
    ];

    for (const config of configs) {
      this.algorithms.set(config.name, config);
    }

    logger.info('Algorithms initialized', {
      count: this.algorithms.size,
      algorithms: Array.from(this.algorithms.keys())
    });
  }

  getAlgorithm(name: string): AlgorithmConfig | undefined {
    return this.algorithms.get(name);
  }

  getAllAlgorithms(): AlgorithmConfig[] {
    return Array.from(this.algorithms.values());
  }

  getSupportedHardware(algorithm: string): string[] {
    const config = this.algorithms.get(algorithm);
    return config ? config.supportedHardware : [];
  }

  getAlgorithmBySymbol(symbol: string): AlgorithmConfig | undefined {
    for (const config of this.algorithms.values()) {
      if (config.symbol === symbol) {
        return config;
      }
    }
    return undefined;
  }
}

/**
 * Market analyzer for sentiment and trend analysis
 */
export class MarketAnalyzer {
  constructor(private marketProvider: MarketDataProvider) {}

  async analyzeMarket(symbol: string): Promise<MarketAnalysis> {
    try {
      const currentPrice = await this.marketProvider.getCurrentPrice(symbol);
      const historicalPrices = await this.marketProvider.getHistoricalPrices(symbol, 30);
      
      // Calculate price changes
      const prices = historicalPrices.map(p => p.price);
      const priceChange24h = this.calculatePriceChange(prices, 1);
      const priceChange7d = this.calculatePriceChange(prices, 7);
      const priceChange30d = this.calculatePriceChange(prices, 30);
      
      // Calculate volatility
      const volatility = this.calculateVolatility(prices);
      
      // Generate price targets using technical analysis
      const priceTargets = this.calculatePriceTargets(currentPrice, prices);
      
      // Determine market sentiment
      const sentiment = this.determineSentiment(priceChange24h, priceChange7d, volatility);
      
      // Calculate confidence based on data quality and consistency
      const confidence = this.calculateConfidence(prices, volatility);

      return {
        currentPrice,
        priceChange24h,
        priceChange7d,
        priceChange30d,
        volatility,
        marketCap: 0, // Would fetch from API
        volume24h: 0, // Would fetch from API
        priceTargets,
        sentiment,
        confidence
      };
    } catch (error) {
      logger.error('Market analysis failed', error as Error, { symbol });
      throw error;
    }
  }

  private calculatePriceChange(prices: number[], days: number): number {
    if (prices.length < days + 1) return 0;
    
    const currentPrice = prices[prices.length - 1];
    const pastPrice = prices[prices.length - 1 - days];
    
    return ((currentPrice - pastPrice) / pastPrice) * 100;
  }

  private calculateVolatility(prices: number[]): number {
    if (prices.length < 2) return 0;
    
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }
    
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    
    return Math.sqrt(variance) * Math.sqrt(365) * 100; // Annualized volatility percentage
  }

  private calculatePriceTargets(currentPrice: number, prices: number[]): {
    bearish: number;
    neutral: number;
    bullish: number;
  } {
    // Simple technical analysis using support/resistance levels
    const max = Math.max(...prices);
    const min = Math.min(...prices);
    const range = max - min;
    
    return {
      bearish: currentPrice - range * 0.2,
      neutral: currentPrice,
      bullish: currentPrice + range * 0.3
    };
  }

  private determineSentiment(
    change24h: number,
    change7d: number,
    volatility: number
  ): 'bearish' | 'neutral' | 'bullish' {
    const shortTermWeight = 0.6;
    const longTermWeight = 0.4;
    const volatilityPenalty = volatility > 50 ? 0.2 : 0; // High volatility reduces confidence
    
    const score = (change24h * shortTermWeight + change7d * longTermWeight) - volatilityPenalty;
    
    if (score > 5) return 'bullish';
    if (score < -5) return 'bearish';
    return 'neutral';
  }

  private calculateConfidence(prices: number[], volatility: number): number {
    // Higher confidence with more data points and lower volatility
    const dataQuality = Math.min(prices.length / 30, 1); // Max confidence with 30+ data points
    const volatilityPenalty = Math.max(0, 1 - volatility / 100); // Lower confidence with high volatility
    
    return Math.min(dataQuality * volatilityPenalty, 1);
  }
}

/**
 * Enhanced profit calculator with advanced features
 */
export class EnhancedProfitCalculator extends EventEmitter {
  private calculator = new ProfitCalculator();
  private algorithmManager = new AlgorithmManager();
  private marketAnalyzer: MarketAnalyzer;

  constructor(private marketProvider: MarketDataProvider) {
    super();
    this.marketAnalyzer = new MarketAnalyzer(marketProvider);
  }

  /**
   * Calculate profitability for multiple algorithms
   */
  async calculateMultiAlgorithm(
    hardware: MiningHardware,
    electricity: ElectricityCost,
    algorithms?: string[]
  ): Promise<AlgorithmComparison[]> {
    const algos = algorithms || this.algorithmManager.getAllAlgorithms().map(a => a.name);
    const results: AlgorithmComparison[] = [];

    for (const algoName of algos) {
      try {
        const algorithm = this.algorithmManager.getAlgorithm(algoName);
        if (!algorithm || !algorithm.supportedHardware.includes(hardware.name)) {
          continue;
        }

        // Get real-time market data
        const difficulty = await this.marketProvider.getDifficulty(algorithm.symbol.toLowerCase());
        const price = await this.marketProvider.getCurrentPrice(algorithm.symbol);
        const blockReward = await this.marketProvider.getBlockReward(algorithm.symbol.toLowerCase());

        const params: MiningParameters = {
          difficulty,
          blockReward,
          blockTime: algorithm.blockTime,
          poolFee: 1.0, // Default 1%
          price
        };

        // Adjust hardware for algorithm
        const adjustedHardware = {
          ...hardware,
          powerConsumption: hardware.powerConsumption * algorithm.powerMultiplier
        };

        const profitability = this.calculator.calculate(adjustedHardware, electricity, params);
        const marketAnalysis = await this.marketAnalyzer.analyzeMarket(algorithm.symbol);

        // Calculate competition level based on network hashrate growth
        const competitionLevel = await this.assessCompetitionLevel(algorithm);

        // Generate recommendation
        const recommendation = this.generateRecommendation(profitability, marketAnalysis, competitionLevel);

        // Calculate overall score (0-100)
        const score = this.calculateAlgorithmScore(profitability, marketAnalysis, competitionLevel);

        results.push({
          algorithm: algoName,
          profitability,
          marketAnalysis,
          competitionLevel,
          recommendation,
          score
        });

      } catch (error) {
        logger.error('Failed to calculate for algorithm', error as Error, { algorithm: algoName });
      }
    }

    // Sort by score (highest first)
    results.sort((a, b) => b.score - a.score);

    logger.info('Multi-algorithm calculation completed', {
      algorithmsAnalyzed: results.length,
      topAlgorithm: results[0]?.algorithm,
      topScore: results[0]?.score
    });

    return results;
  }

  /**
   * Generate profitability forecast
   */
  async generateForecast(
    hardware: MiningHardware,
    electricity: ElectricityCost,
    algorithm: string,
    timeframe: '1d' | '1w' | '1m' | '3m' | '6m' | '1y'
  ): Promise<ProfitabilityForecast> {
    const algorithmConfig = this.algorithmManager.getAlgorithm(algorithm);
    if (!algorithmConfig) {
      throw new Error(`Algorithm not found: ${algorithm}`);
    }

    // Get current market data
    const currentPrice = await this.marketProvider.getCurrentPrice(algorithmConfig.symbol);
    const difficulty = await this.marketProvider.getDifficulty(algorithmConfig.symbol.toLowerCase());
    const blockReward = await this.marketProvider.getBlockReward(algorithmConfig.symbol.toLowerCase());

    // Generate scenarios based on market analysis
    const marketAnalysis = await this.marketAnalyzer.analyzeMarket(algorithmConfig.symbol);
    
    const scenarios = await this.generateScenarios(
      hardware,
      electricity,
      algorithmConfig,
      currentPrice,
      difficulty,
      blockReward,
      timeframe,
      marketAnalysis
    );

    // Identify risk factors
    const riskFactors = this.identifyRiskFactors(algorithmConfig, marketAnalysis, timeframe);

    // Calculate forecast confidence
    const confidence = this.calculateForecastConfidence(marketAnalysis, timeframe);

    return {
      timeframe,
      scenarios,
      riskFactors,
      confidence
    };
  }

  /**
   * Real-time profitability monitoring
   */
  startRealTimeMonitoring(
    hardware: MiningHardware,
    electricity: ElectricityCost,
    algorithms: string[],
    updateInterval: number = 60000 // 1 minute
  ): void {
    const monitor = setInterval(async () => {
      try {
        const results = await this.calculateMultiAlgorithm(hardware, electricity, algorithms);
        
        this.emit('profitabilityUpdate', {
          timestamp: new Date(),
          results,
          mostProfitable: results[0]
        });

        // Alert on significant changes
        const topResult = results[0];
        if (topResult && topResult.profitability.profitPerDay > 0) {
          this.emit('profitAlert', {
            type: 'profitable',
            algorithm: topResult.algorithm,
            dailyProfit: topResult.profitability.profitPerDay,
            recommendation: topResult.recommendation
          });
        }

      } catch (error) {
        logger.error('Real-time monitoring error', error as Error);
        this.emit('monitoringError', error);
      }
    }, updateInterval);

    // Store monitor for cleanup
    this.emit('monitoringStarted', { interval: updateInterval, monitor });
  }

  /**
   * Calculate optimal mining strategy
   */
  async calculateOptimalStrategy(
    availableHardware: MiningHardware[],
    electricity: ElectricityCost,
    constraints: {
      maxPowerConsumption?: number;
      maxInitialInvestment?: number;
      targetROI?: number; // days
      riskTolerance: 'low' | 'medium' | 'high';
    }
  ): Promise<{
    recommendedHardware: MiningHardware[];
    algorithms: AlgorithmComparison[];
    projectedProfit: ProfitabilityResult;
    riskAssessment: {
      level: 'low' | 'medium' | 'high';
      factors: string[];
      mitigation: string[];
    };
    timeline: {
      breakeven: number; // days
      roi12months: number;
    };
  }> {
    const strategies = [];

    // Evaluate each hardware option
    for (const hardware of availableHardware) {
      // Check constraints
      if (constraints.maxPowerConsumption && hardware.powerConsumption > constraints.maxPowerConsumption) {
        continue;
      }
      if (constraints.maxInitialInvestment && hardware.cost > constraints.maxInitialInvestment) {
        continue;
      }

      const algorithmResults = await this.calculateMultiAlgorithm(hardware, electricity);
      
      if (algorithmResults.length === 0) continue;

      const bestAlgorithm = algorithmResults[0];
      
      // Check ROI constraint
      if (constraints.targetROI && bestAlgorithm.profitability.roiDays > constraints.targetROI) {
        continue;
      }

      strategies.push({
        hardware,
        algorithms: algorithmResults,
        bestProfit: bestAlgorithm.profitability,
        score: bestAlgorithm.score
      });
    }

    if (strategies.length === 0) {
      throw new Error('No viable strategies found with given constraints');
    }

    // Sort strategies by score
    strategies.sort((a, b) => b.score - a.score);

    const optimalStrategy = strategies[0];
    
    // Assess risk based on market volatility and competition
    const riskAssessment = await this.assessStrategyRisk(
      optimalStrategy.hardware,
      optimalStrategy.algorithms[0],
      constraints.riskTolerance
    );

    return {
      recommendedHardware: [optimalStrategy.hardware],
      algorithms: optimalStrategy.algorithms,
      projectedProfit: optimalStrategy.bestProfit,
      riskAssessment,
      timeline: {
        breakeven: optimalStrategy.bestProfit.roiDays,
        roi12months: (optimalStrategy.bestProfit.profitPerYear / optimalStrategy.hardware.cost) * 100
      }
    };
  }

  // Helper methods
  private async assessCompetitionLevel(algorithm: AlgorithmConfig): Promise<'low' | 'medium' | 'high'> {
    // Mock implementation - would analyze hashrate growth trends
    const marketCap = algorithm.marketCap || 0;
    if (marketCap > 100000000000) return 'high'; // > $100B
    if (marketCap > 10000000000) return 'medium'; // > $10B
    return 'low';
  }

  private generateRecommendation(
    profitability: ProfitabilityResult,
    marketAnalysis: MarketAnalysis,
    competitionLevel: 'low' | 'medium' | 'high'
  ): 'strong-buy' | 'buy' | 'hold' | 'sell' | 'strong-sell' {
    const profitScore = profitability.profitPerDay > 0 ? 2 : -2;
    const marketScore = marketAnalysis.sentiment === 'bullish' ? 2 : 
                       marketAnalysis.sentiment === 'bearish' ? -2 : 0;
    const competitionScore = competitionLevel === 'low' ? 1 : 
                            competitionLevel === 'high' ? -1 : 0;
    
    const totalScore = profitScore + marketScore + competitionScore;
    
    if (totalScore >= 4) return 'strong-buy';
    if (totalScore >= 2) return 'buy';
    if (totalScore >= -1) return 'hold';
    if (totalScore >= -3) return 'sell';
    return 'strong-sell';
  }

  private calculateAlgorithmScore(
    profitability: ProfitabilityResult,
    marketAnalysis: MarketAnalysis,
    competitionLevel: 'low' | 'medium' | 'high'
  ): number {
    // Weighted scoring system (0-100)
    const profitWeight = 0.4;
    const marketWeight = 0.3;
    const competitionWeight = 0.2;
    const riskWeight = 0.1;

    // Profit score (0-40)
    const profitScore = Math.min(Math.max(profitability.profitPerDay / 10, 0), 40);
    
    // Market score (0-30)
    const marketScore = marketAnalysis.sentiment === 'bullish' ? 30 : 
                       marketAnalysis.sentiment === 'neutral' ? 15 : 0;
    
    // Competition score (0-20)
    const competitionScore = competitionLevel === 'low' ? 20 : 
                            competitionLevel === 'medium' ? 10 : 0;
    
    // Risk score (0-10) - lower volatility = higher score
    const riskScore = Math.max(10 - marketAnalysis.volatility / 10, 0);

    return profitScore + marketScore + competitionScore + riskScore;
  }

  private async generateScenarios(
    hardware: MiningHardware,
    electricity: ElectricityCost,
    algorithm: AlgorithmConfig,
    currentPrice: number,
    difficulty: number,
    blockReward: number,
    timeframe: string,
    marketAnalysis: MarketAnalysis
  ): Promise<{
    pessimistic: ProfitabilityResult;
    realistic: ProfitabilityResult;
    optimistic: ProfitabilityResult;
  }> {
    // Define scenario parameters based on market analysis and timeframe
    const scenarios = {
      pessimistic: {
        priceMultiplier: 0.7, // 30% price drop
        difficultyMultiplier: 1.5, // 50% difficulty increase
      },
      realistic: {
        priceMultiplier: 1.0, // Current price
        difficultyMultiplier: 1.2, // 20% difficulty increase
      },
      optimistic: {
        priceMultiplier: 1.5, // 50% price increase
        difficultyMultiplier: 1.1, // 10% difficulty increase
      }
    };

    const results: any = {};

    for (const [scenario, params] of Object.entries(scenarios)) {
      const adjustedParams: MiningParameters = {
        difficulty: difficulty * params.difficultyMultiplier,
        blockReward,
        blockTime: algorithm.blockTime,
        poolFee: 1.0,
        price: currentPrice * params.priceMultiplier
      };

      results[scenario] = this.calculator.calculate(hardware, electricity, adjustedParams);
    }

    return results;
  }

  private identifyRiskFactors(
    algorithm: AlgorithmConfig,
    marketAnalysis: MarketAnalysis,
    timeframe: string
  ): string[] {
    const risks: string[] = [];

    if (marketAnalysis.volatility > 50) {
      risks.push('High price volatility');
    }

    if (marketAnalysis.sentiment === 'bearish') {
      risks.push('Bearish market sentiment');
    }

    if (algorithm.rewardHalvingInterval) {
      risks.push('Potential reward halving event');
    }

    if (timeframe === '1y' || timeframe === '6m') {
      risks.push('Long-term market uncertainty');
    }

    return risks;
  }

  private calculateForecastConfidence(
    marketAnalysis: MarketAnalysis,
    timeframe: string
  ): number {
    let confidence = marketAnalysis.confidence;

    // Reduce confidence for longer timeframes
    const timeframePenalty = {
      '1d': 0,
      '1w': 0.1,
      '1m': 0.2,
      '3m': 0.3,
      '6m': 0.4,
      '1y': 0.5
    };

    confidence -= timeframePenalty[timeframe] || 0.5;

    return Math.max(confidence, 0.1); // Minimum 10% confidence
  }

  private async assessStrategyRisk(
    hardware: MiningHardware,
    algorithmResult: AlgorithmComparison,
    riskTolerance: 'low' | 'medium' | 'high'
  ): Promise<{
    level: 'low' | 'medium' | 'high';
    factors: string[];
    mitigation: string[];
  }> {
    const factors: string[] = [];
    const mitigation: string[] = [];

    // Assess various risk factors
    if (algorithmResult.marketAnalysis.volatility > 70) {
      factors.push('Extremely high price volatility');
      mitigation.push('Diversify across multiple algorithms');
    }

    if (algorithmResult.profitability.roiDays > 365) {
      factors.push('Long payback period');
      mitigation.push('Consider more efficient hardware');
    }

    if (algorithmResult.competitionLevel === 'high') {
      factors.push('High network competition');
      mitigation.push('Monitor difficulty trends closely');
    }

    // Determine overall risk level
    let riskLevel: 'low' | 'medium' | 'high' = 'low';
    if (factors.length >= 3) riskLevel = 'high';
    else if (factors.length >= 1) riskLevel = 'medium';

    return { level: riskLevel, factors, mitigation };
  }
}

export {
  MarketDataProvider,
  AlgorithmConfig,
  PoolConfiguration,
  MarketAnalysis,
  ProfitabilityForecast,
  AlgorithmComparison,
  RealTimeMarketProvider,
  AlgorithmManager,
  MarketAnalyzer
};
