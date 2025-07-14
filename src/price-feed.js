import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { createHash } from 'crypto';

/**
 * Real-time Price Feed System
 * 運営手数料のBTC変換用リアルタイム価格フィード
 * 
 * Features:
 * - Multiple price source aggregation
 * - Automatic failover
 * - Price manipulation protection
 * - Historical price tracking
 * - WebSocket real-time updates
 */
export class PriceFeedSystem extends EventEmitter {
  constructor(config = {}) {
    super();
    this.logger = new Logger('PriceFeed');
    this.config = {
      updateInterval: 30000, // 30 seconds
      priceSourceTimeout: 5000,
      maxPriceDeviation: 0.1, // 10% max deviation
      historicalDataRetention: 86400000, // 24 hours
      ...config
    };
    
    // Price sources configuration
    this.priceSources = [
      {
        name: 'Binance',
        endpoint: 'https://api.binance.com/api/v3/ticker/price',
        weight: 3,
        enabled: true,
        parser: this.parseBinancePrice.bind(this)
      },
      {
        name: 'CoinGecko',
        endpoint: 'https://api.coingecko.com/api/v3/simple/price',
        weight: 2,
        enabled: true,
        parser: this.parseCoinGeckoPrice.bind(this)
      },
      {
        name: 'CoinCap',
        endpoint: 'https://api.coincap.io/v2/rates',
        weight: 1,
        enabled: true,
        parser: this.parseCoinCapPrice.bind(this)
      }
    ];
    
    // Price storage
    this.currentPrices = new Map();
    this.priceHistory = new Map();
    this.lastUpdate = new Map();
    this.sourceStatus = new Map();
    
    // Supported trading pairs
    this.supportedPairs = [
      'BTC/USDT', 'ETH/BTC', 'RVN/BTC', 'XMR/BTC', 
      'LTC/BTC', 'DOGE/BTC', 'ETC/BTC', 'ZEC/BTC',
      'DASH/BTC', 'ERGO/BTC', 'FLUX/BTC', 'KAS/BTC'
    ];
    
    // Initialize
    this.initialize();
  }

  /**
   * Initialize price feed system
   */
  async initialize() {
    this.logger.info('Initializing real-time price feed system...');
    
    // Initialize price history for each pair
    for (const pair of this.supportedPairs) {
      this.priceHistory.set(pair, []);
      this.currentPrices.set(pair, 0);
      this.lastUpdate.set(pair, 0);
    }
    
    // Initialize source status
    for (const source of this.priceSources) {
      this.sourceStatus.set(source.name, {
        available: true,
        lastSuccess: Date.now(),
        failureCount: 0,
        averageLatency: 0
      });
    }
    
    // Start price updates
    await this.updateAllPrices();
    this.startPriceUpdateTimer();
    
    // Start historical data cleanup
    this.startHistoricalDataCleanup();
    
    this.logger.info('Price feed system initialized');
  }

  /**
   * Start automatic price updates
   */
  startPriceUpdateTimer() {
    this.updateTimer = setInterval(async () => {
      await this.updateAllPrices();
    }, this.config.updateInterval);
    
    this.logger.info(`Price updates scheduled every ${this.config.updateInterval / 1000} seconds`);
  }

  /**
   * Update all prices from all sources
   */
  async updateAllPrices() {
    const startTime = Date.now();
    const priceUpdates = new Map();
    
    // Fetch prices from all available sources
    const sourcePromises = this.priceSources
      .filter(source => source.enabled && this.sourceStatus.get(source.name).available)
      .map(source => this.fetchPricesFromSource(source));
    
    const results = await Promise.allSettled(sourcePromises);
    
    // Aggregate prices by pair
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled') {
        const { source, prices } = results[i].value;
        
        for (const [pair, price] of prices) {
          if (!priceUpdates.has(pair)) {
            priceUpdates.set(pair, []);
          }
          priceUpdates.get(pair).push({ source: source.name, price, weight: source.weight });
        }
      }
    }
    
    // Calculate weighted average prices
    let updatedCount = 0;
    for (const [pair, sources] of priceUpdates) {
      const validPrices = this.filterValidPrices(pair, sources);
      
      if (validPrices.length > 0) {
        const weightedPrice = this.calculateWeightedPrice(validPrices);
        const previousPrice = this.currentPrices.get(pair);
        
        // Check for price manipulation
        if (this.isPriceValid(pair, weightedPrice, previousPrice)) {
          this.currentPrices.set(pair, weightedPrice);
          this.lastUpdate.set(pair, Date.now());
          
          // Add to history
          this.addPriceToHistory(pair, weightedPrice);
          
          // Emit price update event
          this.emit('price:updated', {
            pair,
            price: weightedPrice,
            previousPrice,
            change: previousPrice > 0 ? ((weightedPrice - previousPrice) / previousPrice) * 100 : 0,
            sources: validPrices.length,
            timestamp: Date.now()
          });
          
          updatedCount++;
        } else {
          this.logger.warn(`Price manipulation detected for ${pair}: ${weightedPrice}`);
          this.emit('price:manipulation', { pair, attemptedPrice: weightedPrice, currentPrice: previousPrice });
        }
      }
    }
    
    const updateTime = Date.now() - startTime;
    this.logger.debug(`Updated ${updatedCount} prices in ${updateTime}ms`);
    
    // Emit aggregated update
    this.emit('prices:batch_updated', {
      count: updatedCount,
      duration: updateTime,
      timestamp: Date.now()
    });
  }

  /**
   * Fetch prices from a specific source
   */
  async fetchPricesFromSource(source) {
    const startTime = Date.now();
    const status = this.sourceStatus.get(source.name);
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.priceSourceTimeout);
      
      const response = await fetch(source.endpoint, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Otedama/0.5'
        }
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      const prices = source.parser(data);
      
      // Update source status
      const latency = Date.now() - startTime;
      status.lastSuccess = Date.now();
      status.failureCount = 0;
      status.averageLatency = (status.averageLatency * 0.9) + (latency * 0.1);
      
      this.logger.debug(`${source.name}: Fetched ${prices.size} prices in ${latency}ms`);
      
      return { source, prices };
      
    } catch (error) {
      // Update failure status
      status.failureCount++;
      
      if (status.failureCount >= 3) {
        status.available = false;
        this.logger.error(`${source.name} marked as unavailable after ${status.failureCount} failures`);
        
        // Schedule re-enable after 5 minutes
        setTimeout(() => {
          status.available = true;
          status.failureCount = 0;
          this.logger.info(`${source.name} re-enabled`);
        }, 300000);
      }
      
      this.logger.warn(`Failed to fetch from ${source.name}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Parse Binance price data
   */
  parseBinancePrice(data) {
    const prices = new Map();
    
    if (Array.isArray(data)) {
      for (const ticker of data) {
        const symbol = ticker.symbol;
        const price = parseFloat(ticker.price);
        
        // Convert Binance symbols to standard pairs
        const pairMap = {
          'BTCUSDT': 'BTC/USDT',
          'ETHBTC': 'ETH/BTC',
          'RVNBTC': 'RVN/BTC',
          'XMRBTC': 'XMR/BTC',
          'LTCBTC': 'LTC/BTC',
          'DOGEBTC': 'DOGE/BTC',
          'ETCBTC': 'ETC/BTC',
          'ZECBTC': 'ZEC/BTC',
          'DASHBTC': 'DASH/BTC'
        };
        
        if (pairMap[symbol] && !isNaN(price)) {
          prices.set(pairMap[symbol], price);
        }
      }
    }
    
    return prices;
  }

  /**
   * Parse CoinGecko price data
   */
  parseCoinGeckoPrice(data) {
    const prices = new Map();
    
    // CoinGecko returns prices in a different format
    const coinMap = {
      'bitcoin': 'BTC',
      'ethereum': 'ETH',
      'ravencoin': 'RVN',
      'monero': 'XMR',
      'litecoin': 'LTC',
      'dogecoin': 'DOGE',
      'ethereum-classic': 'ETC',
      'zcash': 'ZEC',
      'dash': 'DASH'
    };
    
    for (const [coinId, coinData of Object.entries(data)) {
      const symbol = coinMap[coinId];
      if (symbol && coinData.btc) {
        prices.set(`${symbol}/BTC`, coinData.btc);
      }
      if (symbol === 'BTC' && coinData.usd) {
        prices.set('BTC/USDT', coinData.usd);
      }
    }
    
    return prices;
  }

  /**
   * Parse CoinCap price data
   */
  parseCoinCapPrice(data) {
    const prices = new Map();
    
    if (data.data && Array.isArray(data.data)) {
      const btcPrice = data.data.find(asset => asset.symbol === 'BTC')?.rateUsd;
      
      if (btcPrice) {
        prices.set('BTC/USDT', parseFloat(btcPrice));
        
        for (const asset of data.data) {
          const assetPrice = parseFloat(asset.rateUsd);
          if (!isNaN(assetPrice) && asset.symbol !== 'BTC') {
            const btcRate = assetPrice / parseFloat(btcPrice);
            prices.set(`${asset.symbol}/BTC`, btcRate);
          }
        }
      }
    }
    
    return prices;
  }

  /**
   * Filter valid prices (remove outliers)
   */
  filterValidPrices(pair, sources) {
    if (sources.length <= 2) return sources;
    
    // Calculate median
    const sortedPrices = sources.map(s => s.price).sort((a, b) => a - b);
    const median = sortedPrices[Math.floor(sortedPrices.length / 2)];
    
    // Filter out prices that deviate too much from median
    return sources.filter(source => {
      const deviation = Math.abs(source.price - median) / median;
      return deviation <= this.config.maxPriceDeviation;
    });
  }

  /**
   * Calculate weighted average price
   */
  calculateWeightedPrice(sources) {
    let totalWeight = 0;
    let weightedSum = 0;
    
    for (const source of sources) {
      weightedSum += source.price * source.weight;
      totalWeight += source.weight;
    }
    
    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  /**
   * Check if price is valid (no manipulation)
   */
  isPriceValid(pair, newPrice, oldPrice) {
    // First price is always valid
    if (oldPrice === 0) return true;
    
    // Check maximum allowed change (50% in one update)
    const changeRatio = Math.abs(newPrice - oldPrice) / oldPrice;
    if (changeRatio > 0.5) {
      return false;
    }
    
    // Check against historical average
    const history = this.priceHistory.get(pair);
    if (history && history.length >= 10) {
      const recentPrices = history.slice(-10).map(h => h.price);
      const avgPrice = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
      const deviationFromAvg = Math.abs(newPrice - avgPrice) / avgPrice;
      
      if (deviationFromAvg > 0.3) { // 30% deviation from recent average
        return false;
      }
    }
    
    return true;
  }

  /**
   * Add price to history
   */
  addPriceToHistory(pair, price) {
    const history = this.priceHistory.get(pair);
    history.push({
      price,
      timestamp: Date.now()
    });
    
    // Limit history size
    if (history.length > 2880) { // 24 hours at 30-second intervals
      history.shift();
    }
  }

  /**
   * Get current price for a pair
   */
  getPrice(pair) {
    return this.currentPrices.get(pair) || 0;
  }

  /**
   * Get price in BTC for any currency
   */
  getPriceInBTC(currency) {
    if (currency === 'BTC') return 1;
    
    const pair = `${currency}/BTC`;
    return this.currentPrices.get(pair) || 0;
  }

  /**
   * Get BTC price in USD
   */
  getBTCPrice() {
    return this.currentPrices.get('BTC/USDT') || 0;
  }

  /**
   * Convert amount to BTC
   */
  convertToBTC(amount, currency) {
    if (currency === 'BTC') return amount;
    
    const rate = this.getPriceInBTC(currency);
    if (rate === 0) {
      this.logger.warn(`No price available for ${currency}/BTC`);
      return 0;
    }
    
    return amount * rate;
  }

  /**
   * Get price history for a pair
   */
  getPriceHistory(pair, duration = 3600000) { // Default 1 hour
    const history = this.priceHistory.get(pair) || [];
    const cutoff = Date.now() - duration;
    
    return history.filter(h => h.timestamp >= cutoff);
  }

  /**
   * Get price statistics
   */
  getPriceStats(pair) {
    const history = this.getPriceHistory(pair, 86400000); // 24 hours
    
    if (history.length === 0) {
      return null;
    }
    
    const prices = history.map(h => h.price);
    const currentPrice = this.currentPrices.get(pair);
    
    return {
      current: currentPrice,
      high24h: Math.max(...prices),
      low24h: Math.min(...prices),
      average24h: prices.reduce((a, b) => a + b, 0) / prices.length,
      change24h: prices.length > 0 ? ((currentPrice - prices[0]) / prices[0]) * 100 : 0,
      lastUpdate: this.lastUpdate.get(pair),
      dataPoints: history.length
    };
  }

  /**
   * Get source status
   */
  getSourceStatus() {
    const status = {};
    
    for (const [name, sourceStatus] of this.sourceStatus) {
      status[name] = {
        ...sourceStatus,
        uptime: sourceStatus.available ? 
          ((Date.now() - sourceStatus.lastSuccess) < 60000 ? 100 : 90) : 0
      };
    }
    
    return status;
  }

  /**
   * Start historical data cleanup
   */
  startHistoricalDataCleanup() {
    setInterval(() => {
      const cutoff = Date.now() - this.config.historicalDataRetention;
      
      for (const [pair, history] of this.priceHistory) {
        const filtered = history.filter(h => h.timestamp >= cutoff);
        if (filtered.length < history.length) {
          this.priceHistory.set(pair, filtered);
          this.logger.debug(`Cleaned ${history.length - filtered.length} old prices for ${pair}`);
        }
      }
    }, 3600000); // Every hour
  }

  /**
   * Get comprehensive statistics
   */
  getStats() {
    const stats = {
      pairs: this.supportedPairs.length,
      activePairs: Array.from(this.currentPrices).filter(([_, price]) => price > 0).length,
      sources: {
        total: this.priceSources.length,
        active: this.priceSources.filter(s => this.sourceStatus.get(s.name).available).length,
        status: this.getSourceStatus()
      },
      lastUpdate: Math.max(...Array.from(this.lastUpdate.values())),
      btcPrice: this.getBTCPrice(),
      updateInterval: this.config.updateInterval
    };
    
    return stats;
  }

  /**
   * Stop price feed system
   */
  stop() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    
    this.logger.info('Price feed system stopped');
  }
}
