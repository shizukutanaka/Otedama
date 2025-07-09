/**
 * Profitability Calculator
 * Calculates mining profitability with real-time data and predictions
 * Following Carmack's principle: "Make it useful first, then make it pretty"
 */

import { EventEmitter } from 'events';
import { Logger } from '../../logging/logger';
import { getCacheManager } from '../../cache/redis-cache';

const logger = new Logger('ProfitabilityCalculator');

// Hardware specifications for mining devices
export interface MiningHardware {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  algorithm: string;
  hashrate: number;        // H/s
  powerConsumption: number; // Watts
  initialCost: number;     // USD
  efficiency: number;      // H/J (Hashes per Joule)
  releaseDate: Date;
  category: 'ASIC' | 'GPU' | 'FPGA' | 'CPU';
  availability: 'available' | 'discontinued' | 'preorder';
}

// Electricity cost structure
export interface ElectricityCost {
  rate: number;           // USD per kWh
  currency: string;
  timeOfUse?: {
    peak: { rate: number; hours: number[] };
    offPeak: { rate: number; hours: number[] };
    shoulder?: { rate: number; hours: number[] };
  };
  demandCharges?: number; // USD per kW
  connectionFee?: number; // USD per month
  renewable?: boolean;
}

// Market conditions
export interface MarketConditions {
  coinPrice: number;           // USD
  coinSymbol: string;
  networkHashrate: number;     // H/s
  networkDifficulty: number;
  blockReward: number;         // Coins
  blockTime: number;           // Seconds
  poolFee: number;             // Percentage
  transactionFees?: number;    // Average transaction fees per block
  halvingDate?: Date;
  priceVolatility: number;     // 30-day volatility percentage
  marketCap: number;           // USD
  volume24h: number;           // USD
  lastUpdated: Date;
}

// Profitability calculation result
export interface ProfitabilityResult {
  daily: {
    revenue: number;        // USD
    electricityCost: number; // USD
    poolFees: number;       // USD
    netProfit: number;      // USD
    coinsMined: number;     // Coins
    profitMargin: number;   // Percentage
  };
  monthly: {
    revenue: number;
    electricityCost: number;
    poolFees: number;
    netProfit: number;
    coinsMined: number;
    profitMargin: number;
  };
  yearly: {
    revenue: number;
    electricityCost: number;
    poolFees: number;
    netProfit: number;
    coinsMined: number;
    profitMargin: number;
    roi: number;           // Return on Investment percentage
    paybackPeriod: number; // Days to break even
  };
  breakeven: {
    electricityRate: number; // Break-even electricity rate
    coinPrice: number;       // Break-even coin price
    networkHashrate: number; // Break-even network hashrate
  };
  scenarios: {
    conservative: ProfitabilityScenario;
    realistic: ProfitabilityScenario;
    optimistic: ProfitabilityScenario;
  };
}

// Profitability scenario
export interface ProfitabilityScenario {
  name: string;
  assumptions: {
    priceChange: number;      // Percentage change
    difficultyChange: number; // Percentage change
    powerCostChange: number;  // Percentage change
  };
  result: {
    dailyProfit: number;
    monthlyProfit: number;
    yearlyProfit: number;
    roi: number;
    paybackDays: number;
  };
}

// Historical profitability data
export interface HistoricalData {
  date: Date;
  coinPrice: number;
  networkDifficulty: number;
  dailyProfit: number;
  electricityCost: number;
  profitMargin: number;
}

/**
 * Real-time market data provider
 */
export class MarketDataProvider extends EventEmitter {
  private cacheManager = getCacheManager();
  private updateInterval: NodeJS.Timeout | null = null;

  constructor(
    private config: {
      updateIntervalMs: number;
      apiKeys: {
        coinGecko?: string;
        coinMarketCap?: string;
        nomics?: string;
      };
      cacheTtl: number;
    } = {
      updateIntervalMs: 300000, // 5 minutes
      apiKeys: {},
      cacheTtl: 300 // 5 minutes
    }
  ) {
    super();
    this.startUpdates();
  }

  /**
   * Get current market conditions for a coin
   */
  async getMarketConditions(symbol: string): Promise<MarketConditions | null> {
    try {
      // Try cache first
      const cached = await this.cacheManager?.stats.getPoolStats();
      if (cached && (cached as any)[`market_${symbol}`]) {
        const data = (cached as any)[`market_${symbol}`];
        if (Date.now() - data.timestamp < this.config.cacheTtl * 1000) {
          return data.conditions;
        }
      }

      // Fetch from multiple sources
      const conditions = await this.fetchMarketData(symbol);
      
      // Cache result
      if (this.cacheManager) {
        await this.cacheManager.stats.setPoolStats({
          [`market_${symbol}`]: {
            conditions,
            timestamp: Date.now()
          }
        });
      }

      return conditions;
    } catch (error) {
      logger.error('Failed to get market conditions', error as Error, { symbol });
      return null;
    }
  }

  /**
   * Fetch market data from APIs
   */
  private async fetchMarketData(symbol: string): Promise<MarketConditions> {
    // Mock implementation - in production would use real APIs
    const mockData: MarketConditions = {
      coinPrice: this.generateRealisticPrice(symbol),
      coinSymbol: symbol,
      networkHashrate: this.generateNetworkHashrate(symbol),
      networkDifficulty: this.generateDifficulty(symbol),
      blockReward: this.getBlockReward(symbol),
      blockTime: this.getBlockTime(symbol),
      poolFee: 1.0, // 1%
      transactionFees: 0.5,
      priceVolatility: Math.random() * 50 + 10, // 10-60%
      marketCap: 1000000000 + Math.random() * 500000000000,
      volume24h: 1000000 + Math.random() * 10000000000,
      lastUpdated: new Date()
    };

    logger.debug('Market data fetched', { symbol, price: mockData.coinPrice });
    return mockData;
  }

  private generateRealisticPrice(symbol: string): number {
    const basePrices: { [key: string]: number } = {
      'BTC': 45000,
      'ETH': 3000,
      'LTC': 150,
      'DOGE': 0.08,
      'BCH': 400
    };
    
    const basePrice = basePrices[symbol] || 100;
    const volatility = (Math.random() - 0.5) * 0.1; // ±5% volatility
    return basePrice * (1 + volatility);
  }

  private generateNetworkHashrate(symbol: string): number {
    const baseHashrates: { [key: string]: number } = {
      'BTC': 200e18,  // 200 EH/s
      'ETH': 800e12,  // 800 TH/s
      'LTC': 500e12,  // 500 TH/s
      'DOGE': 400e12, // 400 TH/s
      'BCH': 2e18     // 2 EH/s
    };
    
    return baseHashrates[symbol] || 1e12;
  }

  private generateDifficulty(symbol: string): number {
    return Math.random() * 1e12 + 1e11;
  }

  private getBlockReward(symbol: string): number {
    const rewards: { [key: string]: number } = {
      'BTC': 6.25,
      'ETH': 2.0,
      'LTC': 12.5,
      'DOGE': 10000,
      'BCH': 6.25
    };
    
    return rewards[symbol] || 1.0;
  }

  private getBlockTime(symbol: string): number {
    const blockTimes: { [key: string]: number } = {
      'BTC': 600,    // 10 minutes
      'ETH': 13,     // 13 seconds
      'LTC': 150,    // 2.5 minutes
      'DOGE': 60,    // 1 minute
      'BCH': 600     // 10 minutes
    };
    
    return blockTimes[symbol] || 600;
  }

  private startUpdates(): void {
    this.updateInterval = setInterval(async () => {
      try {
        // Update commonly watched coins
        const coins = ['BTC', 'ETH', 'LTC', 'DOGE', 'BCH'];
        for (const coin of coins) {
          const conditions = await this.fetchMarketData(coin);
          this.emit('marketUpdate', coin, conditions);
        }
      } catch (error) {
        logger.error('Error updating market data', error as Error);
      }
    }, this.config.updateIntervalMs);
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }
}

/**
 * Hardware database with popular mining devices
 */
export class HardwareDatabase {
  private hardware = new Map<string, MiningHardware>();

  constructor() {
    this.loadDefaultHardware();
  }

  private loadDefaultHardware(): void {
    const defaultHardware: MiningHardware[] = [
      // ASIC Miners
      {
        id: 'antminer-s19-pro',
        name: 'Antminer S19 Pro',
        manufacturer: 'Bitmain',
        model: 'S19 Pro',
        algorithm: 'SHA256',
        hashrate: 110e12, // 110 TH/s
        powerConsumption: 3250, // 3250W
        initialCost: 8000,
        efficiency: 33846153846, // H/J
        releaseDate: new Date('2021-01-01'),
        category: 'ASIC',
        availability: 'available'
      },
      {
        id: 'antminer-l7',
        name: 'Antminer L7',
        manufacturer: 'Bitmain',
        model: 'L7',
        algorithm: 'SCRYPT',
        hashrate: 9050e6, // 9.05 GH/s
        powerConsumption: 3425,
        initialCost: 12000,
        efficiency: 2642335766,
        releaseDate: new Date('2021-06-01'),
        category: 'ASIC',
        availability: 'available'
      },
      {
        id: 'whatsminer-m30s',
        name: 'WhatsMiner M30S++',
        manufacturer: 'MicroBT',
        model: 'M30S++',
        algorithm: 'SHA256',
        hashrate: 112e12, // 112 TH/s
        powerConsumption: 3472,
        initialCost: 7500,
        efficiency: 32266858718,
        releaseDate: new Date('2020-11-01'),
        category: 'ASIC',
        availability: 'available'
      },
      // GPU Miners
      {
        id: 'rtx-3090',
        name: 'GeForce RTX 3090',
        manufacturer: 'NVIDIA',
        model: 'RTX 3090',
        algorithm: 'ETHASH',
        hashrate: 120e6, // 120 MH/s
        powerConsumption: 300,
        initialCost: 1500,
        efficiency: 400000,
        releaseDate: new Date('2020-09-24'),
        category: 'GPU',
        availability: 'discontinued'
      },
      {
        id: 'rx-6800-xt',
        name: 'Radeon RX 6800 XT',
        manufacturer: 'AMD',
        model: 'RX 6800 XT',
        algorithm: 'ETHASH',
        hashrate: 64e6, // 64 MH/s
        powerConsumption: 250,
        initialCost: 800,
        efficiency: 256000,
        releaseDate: new Date('2020-11-18'),
        category: 'GPU',
        availability: 'available'
      }
    ];

    for (const hw of defaultHardware) {
      this.hardware.set(hw.id, hw);
    }

    logger.info('Hardware database loaded', { count: this.hardware.size });
  }

  /**
   * Get hardware by ID
   */
  getHardware(id: string): MiningHardware | undefined {
    return this.hardware.get(id);
  }

  /**
   * Get all hardware for algorithm
   */
  getHardwareByAlgorithm(algorithm: string): MiningHardware[] {
    return Array.from(this.hardware.values())
      .filter(hw => hw.algorithm.toLowerCase() === algorithm.toLowerCase())
      .sort((a, b) => b.efficiency - a.efficiency);
  }

  /**
   * Get all available hardware
   */
  getAllHardware(): MiningHardware[] {
    return Array.from(this.hardware.values())
      .sort((a, b) => b.efficiency - a.efficiency);
  }

  /**
   * Add custom hardware
   */
  addHardware(hardware: MiningHardware): void {
    this.hardware.set(hardware.id, hardware);
    logger.info('Hardware added', { id: hardware.id, name: hardware.name });
  }

  /**
   * Search hardware by name or model
   */
  searchHardware(query: string): MiningHardware[] {
    const searchTerm = query.toLowerCase();
    return Array.from(this.hardware.values())
      .filter(hw => 
        hw.name.toLowerCase().includes(searchTerm) ||
        hw.model.toLowerCase().includes(searchTerm) ||
        hw.manufacturer.toLowerCase().includes(searchTerm)
      );
  }
}

/**
 * Main profitability calculator
 */
export class ProfitabilityCalculator {
  private marketData = new MarketDataProvider();
  private hardwareDb = new HardwareDatabase();
  private historicalData = new Map<string, HistoricalData[]>();

  constructor(
    private config: {
      defaultElectricityRate: number;
      taxRate: number;
      includeHardwareDepreciation: boolean;
      depreciationPeriodYears: number;
    } = {
      defaultElectricityRate: 0.12, // $0.12 per kWh
      taxRate: 0.25, // 25%
      includeHardwareDepreciation: true,
      depreciationPeriodYears: 3
    }
  ) {
    logger.info('Profitability calculator initialized');
  }

  /**
   * Calculate profitability for specific hardware and conditions
   */
  async calculateProfitability(
    hardwareId: string,
    coinSymbol: string,
    electricityCost: ElectricityCost,
    customConditions?: Partial<MarketConditions>
  ): Promise<ProfitabilityResult | null> {
    try {
      // Get hardware specs
      const hardware = this.hardwareDb.getHardware(hardwareId);
      if (!hardware) {
        throw new Error(`Hardware not found: ${hardwareId}`);
      }

      // Get market conditions
      let market = await this.marketData.getMarketConditions(coinSymbol);
      if (!market) {
        throw new Error(`Market data not available for ${coinSymbol}`);
      }

      // Apply custom conditions
      if (customConditions) {
        market = { ...market, ...customConditions };
      }

      // Calculate base metrics
      const dailyBlocksPerMiner = this.calculateDailyBlocks(hardware, market);
      const dailyRevenue = dailyBlocksPerMiner * market.blockReward * market.coinPrice;
      const dailyElectricityCost = this.calculateElectricityCost(hardware, electricityCost);
      const dailyPoolFees = dailyRevenue * (market.poolFee / 100);
      const dailyNetProfit = dailyRevenue - dailyElectricityCost - dailyPoolFees;

      // Calculate for different periods
      const daily = {
        revenue: dailyRevenue,
        electricityCost: dailyElectricityCost,
        poolFees: dailyPoolFees,
        netProfit: dailyNetProfit,
        coinsMined: dailyBlocksPerMiner * market.blockReward,
        profitMargin: dailyRevenue > 0 ? (dailyNetProfit / dailyRevenue) * 100 : 0
      };

      const monthly = {
        revenue: daily.revenue * 30,
        electricityCost: daily.electricityCost * 30,
        poolFees: daily.poolFees * 30,
        netProfit: daily.netProfit * 30,
        coinsMined: daily.coinsMined * 30,
        profitMargin: daily.profitMargin
      };

      const yearly = {
        revenue: daily.revenue * 365,
        electricityCost: daily.electricityCost * 365,
        poolFees: daily.poolFees * 365,
        netProfit: daily.netProfit * 365,
        coinsMined: daily.coinsMined * 365,
        profitMargin: daily.profitMargin,
        roi: hardware.initialCost > 0 ? (yearly.netProfit / hardware.initialCost) * 100 : 0,
        paybackPeriod: dailyNetProfit > 0 ? hardware.initialCost / dailyNetProfit : -1
      };

      // Calculate break-even points
      const breakeven = {
        electricityRate: this.calculateBreakevenElectricityRate(hardware, market),
        coinPrice: this.calculateBreakevenCoinPrice(hardware, market, electricityCost),
        networkHashrate: this.calculateBreakevenHashrate(hardware, market, electricityCost)
      };

      // Generate scenarios
      const scenarios = {
        conservative: this.generateScenario('conservative', hardware, market, electricityCost, {
          priceChange: -20,
          difficultyChange: 15,
          powerCostChange: 10
        }),
        realistic: this.generateScenario('realistic', hardware, market, electricityCost, {
          priceChange: 0,
          difficultyChange: 5,
          powerCostChange: 0
        }),
        optimistic: this.generateScenario('optimistic', hardware, market, electricityCost, {
          priceChange: 30,
          difficultyChange: -5,
          powerCostChange: -10
        })
      };

      const result: ProfitabilityResult = {
        daily,
        monthly,
        yearly,
        breakeven,
        scenarios
      };

      logger.debug('Profitability calculated', {
        hardwareId,
        coinSymbol,
        dailyProfit: daily.netProfit,
        roi: yearly.roi,
        paybackDays: yearly.paybackPeriod
      });

      return result;
    } catch (error) {
      logger.error('Failed to calculate profitability', error as Error, {
        hardwareId,
        coinSymbol
      });
      return null;
    }
  }

  /**
   * Calculate daily blocks mined per hardware unit
   */
  private calculateDailyBlocks(hardware: MiningHardware, market: MarketConditions): number {
    const secondsPerDay = 86400;
    const blocksPerDay = secondsPerDay / market.blockTime;
    const networkSharePercentage = hardware.hashrate / market.networkHashrate;
    return blocksPerDay * networkSharePercentage;
  }

  /**
   * Calculate daily electricity cost
   */
  private calculateElectricityCost(
    hardware: MiningHardware,
    electricityCost: ElectricityCost
  ): number {
    const hoursPerDay = 24;
    const kWh = (hardware.powerConsumption / 1000) * hoursPerDay;
    
    if (electricityCost.timeOfUse) {
      // Time-of-use pricing
      let totalCost = 0;
      const tou = electricityCost.timeOfUse;
      
      totalCost += (tou.peak.rate * tou.peak.hours.length * (hardware.powerConsumption / 1000));
      totalCost += (tou.offPeak.rate * tou.offPeak.hours.length * (hardware.powerConsumption / 1000));
      
      if (tou.shoulder) {
        totalCost += (tou.shoulder.rate * tou.shoulder.hours.length * (hardware.powerConsumption / 1000));
      }
      
      return totalCost;
    } else {
      // Flat rate
      return kWh * electricityCost.rate;
    }
  }

  /**
   * Calculate break-even electricity rate
   */
  private calculateBreakevenElectricityRate(
    hardware: MiningHardware,
    market: MarketConditions
  ): number {
    const dailyBlocks = this.calculateDailyBlocks(hardware, market);
    const dailyRevenue = dailyBlocks * market.blockReward * market.coinPrice;
    const dailyPoolFees = dailyRevenue * (market.poolFee / 100);
    const netDailyRevenue = dailyRevenue - dailyPoolFees;
    
    const kWhPerDay = (hardware.powerConsumption / 1000) * 24;
    return kWhPerDay > 0 ? netDailyRevenue / kWhPerDay : 0;
  }

  /**
   * Calculate break-even coin price
   */
  private calculateBreakevenCoinPrice(
    hardware: MiningHardware,
    market: MarketConditions,
    electricityCost: ElectricityCost
  ): number {
    const dailyBlocks = this.calculateDailyBlocks(hardware, market);
    const dailyElectricityCost = this.calculateElectricityCost(hardware, electricityCost);
    
    const coinRevenueNeeded = dailyElectricityCost / (1 - market.poolFee / 100);
    const coinsPerDay = dailyBlocks * market.blockReward;
    
    return coinsPerDay > 0 ? coinRevenueNeeded / coinsPerDay : 0;
  }

  /**
   * Calculate break-even network hashrate
   */
  private calculateBreakevenHashrate(
    hardware: MiningHardware,
    market: MarketConditions,
    electricityCost: ElectricityCost
  ): number {
    const dailyElectricityCost = this.calculateElectricityCost(hardware, electricityCost);
    const secondsPerDay = 86400;
    const blocksPerDay = secondsPerDay / market.blockTime;
    const revenuePerBlock = market.blockReward * market.coinPrice * (1 - market.poolFee / 100);
    
    const requiredBlocks = dailyElectricityCost / revenuePerBlock;
    const requiredShare = requiredBlocks / blocksPerDay;
    
    return requiredShare > 0 ? hardware.hashrate / requiredShare : 0;
  }

  /**
   * Generate profitability scenario
   */
  private generateScenario(
    name: string,
    hardware: MiningHardware,
    market: MarketConditions,
    electricityCost: ElectricityCost,
    assumptions: { priceChange: number; difficultyChange: number; powerCostChange: number }
  ): ProfitabilityScenario {
    // Apply scenario adjustments
    const adjustedMarket: MarketConditions = {
      ...market,
      coinPrice: market.coinPrice * (1 + assumptions.priceChange / 100),
      networkDifficulty: market.networkDifficulty * (1 + assumptions.difficultyChange / 100)
    };

    const adjustedElectricity: ElectricityCost = {
      ...electricityCost,
      rate: electricityCost.rate * (1 + assumptions.powerCostChange / 100)
    };

    // Calculate with adjusted values
    const dailyBlocks = this.calculateDailyBlocks(hardware, adjustedMarket);
    const dailyRevenue = dailyBlocks * adjustedMarket.blockReward * adjustedMarket.coinPrice;
    const dailyElectricityCost = this.calculateElectricityCost(hardware, adjustedElectricity);
    const dailyPoolFees = dailyRevenue * (adjustedMarket.poolFee / 100);
    const dailyProfit = dailyRevenue - dailyElectricityCost - dailyPoolFees;

    return {
      name,
      assumptions,
      result: {
        dailyProfit,
        monthlyProfit: dailyProfit * 30,
        yearlyProfit: dailyProfit * 365,
        roi: hardware.initialCost > 0 ? (dailyProfit * 365 / hardware.initialCost) * 100 : 0,
        paybackDays: dailyProfit > 0 ? hardware.initialCost / dailyProfit : -1
      }
    };
  }

  /**
   * Compare multiple hardware options
   */
  async compareHardware(
    hardwareIds: string[],
    coinSymbol: string,
    electricityCost: ElectricityCost
  ): Promise<Array<{ hardwareId: string; hardware: MiningHardware; profitability: ProfitabilityResult }>> {
    const results = [];

    for (const hardwareId of hardwareIds) {
      const hardware = this.hardwareDb.getHardware(hardwareId);
      const profitability = await this.calculateProfitability(hardwareId, coinSymbol, electricityCost);
      
      if (hardware && profitability) {
        results.push({ hardwareId, hardware, profitability });
      }
    }

    // Sort by daily profit
    return results.sort((a, b) => b.profitability.daily.netProfit - a.profitability.daily.netProfit);
  }

  /**
   * Get hardware database
   */
  getHardwareDatabase(): HardwareDatabase {
    return this.hardwareDb;
  }

  /**
   * Get market data provider
   */
  getMarketDataProvider(): MarketDataProvider {
    return this.marketData;
  }

  /**
   * Stop all services
   */
  stop(): void {
    this.marketData.stop();
    logger.info('Profitability calculator stopped');
  }
}

export {
  MiningHardware,
  ElectricityCost,
  MarketConditions,
  ProfitabilityResult,
  ProfitabilityScenario,
  MarketDataProvider,
  HardwareDatabase
};
