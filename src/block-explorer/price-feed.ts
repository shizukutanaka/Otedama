/**
 * 軽量価格フィード統合
 * 設計思想: Carmack (シンプル・高速), Martin (クリーン), Pike (明瞭・効率性)
 * 
 * 主要機能:
 * - 複数価格プロバイダー対応
 * - リアルタイム価格取得
 * - 価格履歴管理
 * - フォールバック機能
 * - レート制限対応
 */

import { EventEmitter } from 'events';

// === 型定義 ===
interface PriceData {
  symbol: string;
  price: number;
  volume24h: number;
  change24h: number;
  marketCap?: number;
  timestamp: number;
  source: string;
}

interface PriceFeedConfig {
  provider: string;
  apiUrl: string;
  apiKey?: string;
  symbols: string[];
  updateInterval: number; // milliseconds
  retryAttempts: number;
  timeout: number;
}

interface PriceAlert {
  symbol: string;
  condition: 'above' | 'below' | 'change';
  value: number;
  enabled: boolean;
}

// === 価格プロバイダー抽象クラス ===
abstract class PriceProvider {
  protected config: PriceFeedConfig;
  protected cache = new Map<string, PriceData>();

  constructor(config: PriceFeedConfig) {
    this.config = config;
  }

  abstract fetchPrice(symbol: string): Promise<PriceData>;
  abstract fetchMultiplePrices(symbols: string[]): Promise<PriceData[]>;

  protected async request<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };

      if (this.config.apiKey) {
        headers['X-API-Key'] = this.config.apiKey;
      }

      const response = await fetch(url, {
        headers,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw new Error(`Price request failed: ${error.message}`);
    }
  }

  getCachedPrice(symbol: string): PriceData | null {
    const cached = this.cache.get(symbol);
    if (!cached) return null;

    // 5分以内のデータのみ有効
    if (Date.now() - cached.timestamp > 300000) {
      this.cache.delete(symbol);
      return null;
    }

    return cached;
  }

  setCachedPrice(symbol: string, data: PriceData): void {
    this.cache.set(symbol, data);
  }
}

// === CoinGecko プロバイダー ===
class CoinGeckoProvider extends PriceProvider {
  async fetchPrice(symbol: string): Promise<PriceData> {
    const cached = this.getCachedPrice(symbol);
    if (cached) return cached;

    const url = `${this.config.apiUrl}/simple/price?ids=${symbol}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true&include_market_cap=true`;
    
    const data = await this.request<any>(url);
    const coinData = data[symbol];

    if (!coinData) {
      throw new Error(`Price not found for symbol: ${symbol}`);
    }

    const priceData: PriceData = {
      symbol,
      price: coinData.usd,
      volume24h: coinData.usd_24h_vol || 0,
      change24h: coinData.usd_24h_change || 0,
      marketCap: coinData.usd_market_cap,
      timestamp: Date.now(),
      source: 'coingecko'
    };

    this.setCachedPrice(symbol, priceData);
    return priceData;
  }

  async fetchMultiplePrices(symbols: string[]): Promise<PriceData[]> {
    const uncachedSymbols = symbols.filter(s => !this.getCachedPrice(s));
    const cachedPrices = symbols
      .map(s => this.getCachedPrice(s))
      .filter(p => p !== null) as PriceData[];

    if (uncachedSymbols.length === 0) {
      return cachedPrices;
    }

    const url = `${this.config.apiUrl}/simple/price?ids=${uncachedSymbols.join(',')}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true&include_market_cap=true`;
    
    const data = await this.request<any>(url);
    const newPrices: PriceData[] = [];

    for (const symbol of uncachedSymbols) {
      const coinData = data[symbol];
      if (coinData) {
        const priceData: PriceData = {
          symbol,
          price: coinData.usd,
          volume24h: coinData.usd_24h_vol || 0,
          change24h: coinData.usd_24h_change || 0,
          marketCap: coinData.usd_market_cap,
          timestamp: Date.now(),
          source: 'coingecko'
        };

        this.setCachedPrice(symbol, priceData);
        newPrices.push(priceData);
      }
    }

    return [...cachedPrices, ...newPrices];
  }
}

// === CoinMarketCap プロバイダー ===
class CoinMarketCapProvider extends PriceProvider {
  async fetchPrice(symbol: string): Promise<PriceData> {
    const cached = this.getCachedPrice(symbol);
    if (cached) return cached;

    const url = `${this.config.apiUrl}/v1/cryptocurrency/quotes/latest?symbol=${symbol.toUpperCase()}`;
    
    const data = await this.request<any>(url);
    const coinData = data.data[symbol.toUpperCase()];

    if (!coinData) {
      throw new Error(`Price not found for symbol: ${symbol}`);
    }

    const usdQuote = coinData.quote.USD;
    const priceData: PriceData = {
      symbol,
      price: usdQuote.price,
      volume24h: usdQuote.volume_24h || 0,
      change24h: usdQuote.percent_change_24h || 0,
      marketCap: usdQuote.market_cap,
      timestamp: Date.now(),
      source: 'coinmarketcap'
    };

    this.setCachedPrice(symbol, priceData);
    return priceData;
  }

  async fetchMultiplePrices(symbols: string[]): Promise<PriceData[]> {
    const uncachedSymbols = symbols.filter(s => !this.getCachedPrice(s));
    const cachedPrices = symbols
      .map(s => this.getCachedPrice(s))
      .filter(p => p !== null) as PriceData[];

    if (uncachedSymbols.length === 0) {
      return cachedPrices;
    }

    const url = `${this.config.apiUrl}/v1/cryptocurrency/quotes/latest?symbol=${uncachedSymbols.map(s => s.toUpperCase()).join(',')}`;
    
    const data = await this.request<any>(url);
    const newPrices: PriceData[] = [];

    for (const symbol of uncachedSymbols) {
      const coinData = data.data[symbol.toUpperCase()];
      if (coinData) {
        const usdQuote = coinData.quote.USD;
        const priceData: PriceData = {
          symbol,
          price: usdQuote.price,
          volume24h: usdQuote.volume_24h || 0,
          change24h: usdQuote.percent_change_24h || 0,
          marketCap: usdQuote.market_cap,
          timestamp: Date.now(),
          source: 'coinmarketcap'
        };

        this.setCachedPrice(symbol, priceData);
        newPrices.push(priceData);
      }
    }

    return [...cachedPrices, ...newPrices];
  }
}

// === プロバイダーファクトリー ===
class PriceProviderFactory {
  static create(config: PriceFeedConfig): PriceProvider {
    switch (config.provider.toLowerCase()) {
      case 'coingecko':
        return new CoinGeckoProvider(config);
      
      case 'coinmarketcap':
        return new CoinMarketCapProvider(config);
      
      default:
        throw new Error(`Unsupported price provider: ${config.provider}`);
    }
  }
}

// === 価格履歴管理 ===
class PriceHistory {
  private history = new Map<string, PriceData[]>();
  private maxHistory: number;

  constructor(maxHistory: number = 1000) {
    this.maxHistory = maxHistory;
  }

  addPrice(price: PriceData): void {
    const symbol = price.symbol;
    
    if (!this.history.has(symbol)) {
      this.history.set(symbol, []);
    }

    const symbolHistory = this.history.get(symbol)!;
    symbolHistory.push(price);

    // 履歴サイズ制限
    if (symbolHistory.length > this.maxHistory) {
      symbolHistory.shift();
    }
  }

  getHistory(symbol: string, limit?: number): PriceData[] {
    const symbolHistory = this.history.get(symbol) || [];
    
    if (limit) {
      return symbolHistory.slice(-limit);
    }
    
    return symbolHistory;
  }

  getLatestPrice(symbol: string): PriceData | null {
    const symbolHistory = this.history.get(symbol);
    
    if (!symbolHistory || symbolHistory.length === 0) {
      return null;
    }
    
    return symbolHistory[symbolHistory.length - 1];
  }

  getPriceChange(symbol: string, hours: number): number | null {
    const symbolHistory = this.history.get(symbol);
    
    if (!symbolHistory || symbolHistory.length < 2) {
      return null;
    }

    const now = Date.now();
    const targetTime = now - (hours * 60 * 60 * 1000);
    
    // 指定時間に最も近い価格を探す
    let closestPrice: PriceData | null = null;
    let minTimeDiff = Infinity;
    
    for (const price of symbolHistory) {
      const timeDiff = Math.abs(price.timestamp - targetTime);
      if (timeDiff < minTimeDiff) {
        minTimeDiff = timeDiff;
        closestPrice = price;
      }
    }

    if (!closestPrice) return null;

    const currentPrice = symbolHistory[symbolHistory.length - 1];
    return ((currentPrice.price - closestPrice.price) / closestPrice.price) * 100;
  }

  getStats() {
    const symbols = Array.from(this.history.keys());
    const totalDataPoints = symbols.reduce((sum, symbol) => {
      return sum + (this.history.get(symbol)?.length || 0);
    }, 0);

    return {
      symbols: symbols.length,
      totalDataPoints,
      maxHistory: this.maxHistory
    };
  }
}

// === メイン価格フィードクラス ===
class LightPriceFeed extends EventEmitter {
  private providers = new Map<string, PriceProvider>();
  private history = new PriceHistory();
  private alerts: PriceAlert[] = [];
  private updateTimers = new Map<string, NodeJS.Timeout>();
  private logger: any;

  constructor(logger?: any) {
    super();
    this.logger = logger || {
      info: (msg: string, data?: any) => console.log(`[INFO] ${msg}`, data || ''),
      error: (msg: string, err?: any) => console.error(`[ERROR] ${msg}`, err || ''),
      warn: (msg: string, data?: any) => console.warn(`[WARN] ${msg}`, data || '')
    };
  }

  addProvider(name: string, config: PriceFeedConfig): void {
    try {
      const provider = PriceProviderFactory.create(config);
      this.providers.set(name, provider);
      
      // 定期更新タイマー設定
      if (config.updateInterval > 0) {
        this.startUpdateTimer(name, config);
      }

      this.logger.info(`Price provider added: ${name}`, { 
        provider: config.provider, 
        symbols: config.symbols.length 
      });
    } catch (error) {
      this.logger.error(`Failed to add price provider: ${name}`, error);
      throw error;
    }
  }

  private startUpdateTimer(name: string, config: PriceFeedConfig): void {
    const timer = setInterval(async () => {
      try {
        await this.updatePrices(name, config.symbols);
      } catch (error) {
        this.logger.error(`Failed to update prices for ${name}`, error);
      }
    }, config.updateInterval);

    this.updateTimers.set(name, timer);
  }

  async getPrice(symbol: string, providerName?: string): Promise<PriceData> {
    // 特定プロバイダーが指定された場合
    if (providerName) {
      const provider = this.providers.get(providerName);
      if (!provider) {
        throw new Error(`Provider not found: ${providerName}`);
      }
      return await provider.fetchPrice(symbol);
    }

    // フォールバック実装（複数プロバイダー試行）
    for (const [name, provider] of this.providers) {
      try {
        const price = await provider.fetchPrice(symbol);
        this.history.addPrice(price);
        this.checkAlerts(price);
        this.emit('priceUpdated', price);
        return price;
      } catch (error) {
        this.logger.warn(`Failed to get price from ${name}`, error);
        continue;
      }
    }

    throw new Error(`Failed to get price for ${symbol} from all providers`);
  }

  async getPrices(symbols: string[], providerName?: string): Promise<PriceData[]> {
    if (providerName) {
      const provider = this.providers.get(providerName);
      if (!provider) {
        throw new Error(`Provider not found: ${providerName}`);
      }
      return await provider.fetchMultiplePrices(symbols);
    }

    // フォールバック実装
    for (const [name, provider] of this.providers) {
      try {
        const prices = await provider.fetchMultiplePrices(symbols);
        
        // 履歴に追加
        prices.forEach(price => {
          this.history.addPrice(price);
          this.checkAlerts(price);
        });

        this.emit('pricesUpdated', prices);
        return prices;
      } catch (error) {
        this.logger.warn(`Failed to get prices from ${name}`, error);
        continue;
      }
    }

    throw new Error(`Failed to get prices for symbols from all providers`);
  }

  private async updatePrices(providerName: string, symbols: string[]): Promise<void> {
    const provider = this.providers.get(providerName);
    if (!provider) return;

    try {
      const prices = await provider.fetchMultiplePrices(symbols);
      
      prices.forEach(price => {
        this.history.addPrice(price);
        this.checkAlerts(price);
      });

      this.emit('pricesUpdated', prices);
      this.logger.info(`Prices updated for ${providerName}`, { count: prices.length });
    } catch (error) {
      this.logger.error(`Failed to update prices for ${providerName}`, error);
    }
  }

  addAlert(alert: PriceAlert): void {
    this.alerts.push(alert);
    this.logger.info('Price alert added', alert);
  }

  removeAlert(symbol: string, condition: string): boolean {
    const index = this.alerts.findIndex(a => a.symbol === symbol && a.condition === condition);
    
    if (index !== -1) {
      this.alerts.splice(index, 1);
      this.logger.info('Price alert removed', { symbol, condition });
      return true;
    }
    
    return false;
  }

  private checkAlerts(price: PriceData): void {
    for (const alert of this.alerts) {
      if (!alert.enabled || alert.symbol !== price.symbol) continue;

      let triggered = false;

      switch (alert.condition) {
        case 'above':
          triggered = price.price > alert.value;
          break;
        case 'below':
          triggered = price.price < alert.value;
          break;
        case 'change':
          triggered = Math.abs(price.change24h) > alert.value;
          break;
      }

      if (triggered) {
        this.emit('priceAlert', { alert, price });
        this.logger.warn('Price alert triggered', { alert, currentPrice: price.price });
      }
    }
  }

  getHistory(symbol: string, limit?: number): PriceData[] {
    return this.history.getHistory(symbol, limit);
  }

  getLatestPrice(symbol: string): PriceData | null {
    return this.history.getLatestPrice(symbol);
  }

  getPriceChange(symbol: string, hours: number): number | null {
    return this.history.getPriceChange(symbol, hours);
  }

  getProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  removeProvider(name: string): boolean {
    const timer = this.updateTimers.get(name);
    if (timer) {
      clearInterval(timer);
      this.updateTimers.delete(name);
    }

    const removed = this.providers.delete(name);
    if (removed) {
      this.logger.info(`Price provider removed: ${name}`);
    }
    return removed;
  }

  getStats() {
    return {
      providers: this.getProviders(),
      alerts: this.alerts.length,
      activeAlerts: this.alerts.filter(a => a.enabled).length,
      history: this.history.getStats()
    };
  }

  async calculateMiningRevenue(hashrate: number, difficulty: number, blockReward: number, symbol: string): Promise<{ daily: number; weekly: number; monthly: number }> {
    try {
      const price = await this.getPrice(symbol);
      
      // 簡易マイニング収益計算
      const hashratePerSecond = hashrate;
      const networkHashrate = difficulty * Math.pow(2, 32) / 600; // 10分平均
      const shareOfNetwork = hashratePerSecond / networkHashrate;
      const blocksPerDay = (24 * 60 * 60) / 600; // 1日のブロック数
      const dailyCoins = shareOfNetwork * blocksPerDay * blockReward;
      const dailyRevenue = dailyCoins * price.price;

      return {
        daily: dailyRevenue,
        weekly: dailyRevenue * 7,
        monthly: dailyRevenue * 30
      };
    } catch (error) {
      this.logger.error('Failed to calculate mining revenue', error);
      throw error;
    }
  }

  stop(): void {
    // 全タイマーを停止
    for (const [name, timer] of this.updateTimers) {
      clearInterval(timer);
    }
    this.updateTimers.clear();

    this.logger.info('Price feed stopped');
  }
}

export {
  LightPriceFeed,
  PriceFeedConfig,
  PriceData,
  PriceAlert,
  PriceProviderFactory
};