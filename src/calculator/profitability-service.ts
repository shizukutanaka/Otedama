/**
 * Profitability Service - Manages real-time profitability calculations
 * Integrates with network data and provides caching for performance
 */

import { 
  ProfitabilityCalculator, 
  createProfitabilityCalculator,
  NetworkStats,
  CalculationInput,
  ProfitabilityResult,
  MiningHardware,
  COMMON_HARDWARE
} from './profitability-calculator';
import { BlockchainClient } from '../core/blockchain';
import { CacheManager } from '../cache/redis-cache';
import { createComponentLogger } from '../logging/logger';

export interface MarketData {
  readonly btcPrice: number;
  readonly timestamp: number;
  readonly source: string;
}

export interface PoolStats {
  readonly poolFee: number;
  readonly networkHashrate: number;
  readonly difficulty: number;
  readonly estimatedNextDifficulty?: number;
  readonly lastBlockTime: number;
}

export interface ProfitabilityServiceConfig {
  readonly updateInterval: number; // milliseconds
  readonly cacheTimeout: number; // seconds
  readonly priceApiUrl?: string;
  readonly fallbackBtcPrice?: number;
}

/**
 * Real-time profitability calculation service
 */
export class ProfitabilityService {
  private readonly calculator: ProfitabilityCalculator;
  private readonly logger = createComponentLogger('ProfitabilityService');
  private readonly config: ProfitabilityServiceConfig;
  
  private marketData: MarketData | null = null;
  private networkStats: NetworkStats | null = null;
  private updateTimer: NodeJS.Timer | null = null;
  private isRunning = false;

  constructor(
    private readonly blockchain: BlockchainClient,
    private readonly cache?: CacheManager,
    config?: Partial<ProfitabilityServiceConfig>
  ) {
    this.calculator = createProfitabilityCalculator();
    this.config = {
      updateInterval: 60000, // 1 minute
      cacheTimeout: 300, // 5 minutes
      priceApiUrl: 'https://api.coindesk.com/v1/bpi/currentprice/USD.json',
      fallbackBtcPrice: 45000,
      ...config
    };
  }

  /**
   * Start the profitability service
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    
    this.logger.info('Starting profitability service...', {
      updateInterval: this.config.updateInterval,
      cacheTimeout: this.config.cacheTimeout
    });

    // Initial data fetch
    await this.updateMarketData();
    await this.updateNetworkStats();

    // Start periodic updates
    this.updateTimer = setInterval(async () => {
      try {
        await this.updateMarketData();
        await this.updateNetworkStats();
      } catch (error) {
        this.logger.error('Failed to update profitability data', error as Error);
      }
    }, this.config.updateInterval);

    this.isRunning = true;
    this.logger.info('Profitability service started');
  }

  /**
   * Stop the profitability service
   */
  stop(): void {
    if (!this.isRunning) return;

    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }

    this.isRunning = false;
    this.logger.info('Profitability service stopped');
  }

  /**
   * Calculate profitability for given input
   */
  async calculate(input: Partial<CalculationInput>): Promise<ProfitabilityResult> {
    const completeInput = await this.prepareCalculationInput(input);
    return this.calculator.calculate(completeInput);
  }

  /**
   * Quick profitability check
   */
  async isProfitable(input: Partial<CalculationInput>): Promise<boolean> {
    const completeInput = await this.prepareCalculationInput(input);
    return this.calculator.isProfitable(completeInput);
  }

  /**
   * Get current market data
   */
  getMarketData(): MarketData | null {
    return this.marketData;
  }

  /**
   * Get current network statistics
   */
  getNetworkStats(): NetworkStats | null {
    return this.networkStats;
  }

  /**
   * Calculate profitability for all common hardware
   */
  async calculateAllHardware(
    electricityPrice: number,
    currency = 'USD'
  ): Promise<Array<{ hardware: MiningHardware; result: ProfitabilityResult; rank: number }>> {
    if (!this.marketData || !this.networkStats) {
      throw new Error('Market data or network stats not available');
    }

    const hardwareList = Object.values(COMMON_HARDWARE);
    const poolStats = await this.getPoolStats();

    return this.calculator.compareHardware(
      hardwareList,
      this.networkStats,
      { pricePerKwh: electricityPrice, currency },
      this.marketData.btcPrice,
      poolStats.poolFee
    );
  }

  /**
   * Get profitability trends (cached)
   */
  async getProfitabilityTrends(
    hardware: MiningHardware,
    electricityPrice: number,
    days = 30
  ): Promise<Array<{ date: string; profit: number; btcPrice: number; difficulty: number }>> {
    const cacheKey = `profitability_trends:${hardware.name}:${electricityPrice}:${days}`;
    
    if (this.cache) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }

    // Calculate trends (simplified - in real implementation would fetch historical data)
    const trends = [];
    const currentDate = new Date();
    
    for (let i = days; i >= 0; i--) {
      const date = new Date(currentDate.getTime() - i * 24 * 60 * 60 * 1000);
      
      // Simulate historical data (in real implementation, fetch from database)
      const btcPrice = this.marketData?.btcPrice || 45000;
      const priceVariation = Math.random() * 0.1 - 0.05; // ±5% variation
      const historicalPrice = btcPrice * (1 + priceVariation);
      
      const difficulty = this.networkStats?.difficulty || 0;
      const difficultyVariation = Math.random() * 0.02 - 0.01; // ±1% variation
      const historicalDifficulty = difficulty * (1 + difficultyVariation);

      const result = this.calculator.calculate({
        hardware,
        network: {
          ...this.networkStats!,
          difficulty: historicalDifficulty
        },
        electricity: { pricePerKwh: electricityPrice, currency: 'USD' },
        btcPrice: historicalPrice,
        poolFee: 1.0
      });

      trends.push({
        date: date.toISOString().split('T')[0],
        profit: result.daily.profit,
        btcPrice: historicalPrice,
        difficulty: historicalDifficulty
      });
    }

    // Cache the result
    if (this.cache) {
      await this.cache.setex(cacheKey, this.config.cacheTimeout, JSON.stringify(trends));
    }

    return trends;
  }

  /**
   * Estimate future profitability with difficulty adjustment
   */
  async estimateFutureProfitability(
    hardware: MiningHardware,
    electricityPrice: number,
    futureDaysCount = 14
  ): Promise<{
    current: ProfitabilityResult;
    future: ProfitabilityResult;
    difficultyChange: number;
  }> {
    if (!this.networkStats || !this.marketData) {
      throw new Error('Required data not available');
    }

    const poolStats = await this.getPoolStats();
    
    // Current profitability
    const current = this.calculator.calculate({
      hardware,
      network: this.networkStats,
      electricity: { pricePerKwh: electricityPrice, currency: 'USD' },
      btcPrice: this.marketData.btcPrice,
      poolFee: poolStats.poolFee
    });

    // Estimate future difficulty (simplified prediction)
    const estimatedDifficulty = poolStats.estimatedNextDifficulty || 
      this.networkStats.difficulty * 1.05; // Assume 5% increase

    const difficultyChange = ((estimatedDifficulty - this.networkStats.difficulty) / this.networkStats.difficulty) * 100;

    // Future profitability with adjusted difficulty
    const future = this.calculator.calculate({
      hardware,
      network: {
        ...this.networkStats,
        difficulty: estimatedDifficulty
      },
      electricity: { pricePerKwh: electricityPrice, currency: 'USD' },
      btcPrice: this.marketData.btcPrice,
      poolFee: poolStats.poolFee
    });

    return {
      current,
      future,
      difficultyChange
    };
  }

  /**
   * Prepare complete calculation input with defaults
   */
  private async prepareCalculationInput(input: Partial<CalculationInput>): Promise<CalculationInput> {
    if (!input.hardware) {
      throw new Error('Hardware configuration is required');
    }

    const network = input.network || this.networkStats;
    if (!network) {
      throw new Error('Network statistics not available');
    }

    const btcPrice = input.btcPrice || this.marketData?.btcPrice;
    if (!btcPrice) {
      throw new Error('BTC price not available');
    }

    const poolStats = await this.getPoolStats();

    return {
      hardware: input.hardware,
      network,
      electricity: input.electricity || { pricePerKwh: 0.10, currency: 'USD' },
      btcPrice,
      poolFee: input.poolFee !== undefined ? input.poolFee : poolStats.poolFee
    };
  }

  /**
   * Update market data from external API
   */
  private async updateMarketData(): Promise<void> {
    try {
      const cacheKey = 'market_data:btc_price';
      
      // Try cache first
      if (this.cache) {
        const cached = await this.cache.get(cacheKey);
        if (cached) {
          this.marketData = JSON.parse(cached);
          return;
        }
      }

      // Fetch from API (simplified - use a real price API)
      if (this.config.priceApiUrl) {
        const response = await fetch(this.config.priceApiUrl);
        const data = await response.json();
        
        // Parse CoinDesk API response
        const btcPrice = parseFloat(data.bpi?.USD?.rate?.replace(/[,$]/g, '') || '0');
        
        if (btcPrice > 0) {
          this.marketData = {
            btcPrice,
            timestamp: Date.now(),
            source: 'coindesk'
          };

          // Cache the result
          if (this.cache) {
            await this.cache.setex(cacheKey, this.config.cacheTimeout, JSON.stringify(this.marketData));
          }

          this.logger.debug('Market data updated', { btcPrice });
          return;
        }
      }

      // Fallback to configured price
      if (this.config.fallbackBtcPrice) {
        this.marketData = {
          btcPrice: this.config.fallbackBtcPrice,
          timestamp: Date.now(),
          source: 'fallback'
        };
      }

    } catch (error) {
      this.logger.warn('Failed to update market data', error as Error);
      
      // Use fallback if available
      if (this.config.fallbackBtcPrice && !this.marketData) {
        this.marketData = {
          btcPrice: this.config.fallbackBtcPrice,
          timestamp: Date.now(),
          source: 'fallback'
        };
      }
    }
  }

  /**
   * Update network statistics from blockchain
   */
  private async updateNetworkStats(): Promise<void> {
    try {
      const info = await this.blockchain.getBlockchainInfo();
      const difficulty = await this.blockchain.getDifficulty();
      const networkHashrate = await this.blockchain.getNetworkHashPS();

      this.networkStats = {
        difficulty,
        networkHashrate,
        blockReward: 6.25, // Current Bitcoin block reward
        blockTime: 600 // 10 minutes in seconds
      };

      this.logger.debug('Network stats updated', {
        difficulty,
        networkHashrate: networkHashrate / 1e18 + ' EH/s'
      });

    } catch (error) {
      this.logger.warn('Failed to update network stats', error as Error);
    }
  }

  /**
   * Get current pool statistics
   */
  private async getPoolStats(): Promise<PoolStats> {
    // Default pool stats (would be retrieved from pool configuration/database)
    return {
      poolFee: 1.0, // 1%
      networkHashrate: this.networkStats?.networkHashrate || 0,
      difficulty: this.networkStats?.difficulty || 0,
      lastBlockTime: Date.now()
    };
  }
}

/**
 * Factory function for creating profitability service
 */
export function createProfitabilityService(
  blockchain: BlockchainClient,
  cache?: CacheManager,
  config?: Partial<ProfitabilityServiceConfig>
): ProfitabilityService {
  return new ProfitabilityService(blockchain, cache, config);
}
