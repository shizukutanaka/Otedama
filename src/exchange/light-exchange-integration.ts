/**
 * 軽量取引所API統合システム
 * 設計思想: Rob Pike (シンプル), John Carmack (効率性), Robert C. Martin (クリーン)
 * 
 * 特徴:
 * - 複数取引所対応
 * - 自動売却機能
 * - リアルタイム価格監視
 * - 利益最適化
 * - 手数料最小化
 * - 安全な認証
 */

import { EventEmitter } from 'events';
import axios from 'axios';
import crypto from 'crypto';

// === 型定義 ===
export interface ExchangeConfig {
  name: string;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  sandbox?: boolean;
  baseUrl: string;
  rateLimit: number; // requests per minute
  tradingFee: number; // percentage
  withdrawalFees: Record<string, number>;
}

export interface MarketData {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  volume24h: number;
  change24h: number;
  timestamp: number;
}

export interface OrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop';
  amount: number;
  price?: number;
  stopPrice?: number;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

export interface Order {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop';
  amount: number;
  price: number;
  filled: number;
  remaining: number;
  status: 'open' | 'filled' | 'cancelled' | 'rejected';
  timestamp: number;
  fee: number;
  feeCurrency: string;
}

export interface Balance {
  currency: string;
  available: number;
  locked: number;
  total: number;
}

export interface AutoSellRule {
  id: string;
  currency: string;
  enabled: boolean;
  trigger: {
    type: 'threshold' | 'scheduled' | 'price_target';
    value: number;
    condition: 'above' | 'below' | 'equals';
  };
  sellAmount: {
    type: 'percentage' | 'fixed' | 'all';
    value: number;
  };
  priceStrategy: 'market' | 'limit_best' | 'limit_custom';
  customPrice?: number;
  maxSlippage: number; // percentage
}

export interface TradingMetrics {
  totalVolume: number;
  totalFees: number;
  successfulTrades: number;
  failedTrades: number;
  averageSlippage: number;
  profitLoss: number;
  winRate: number;
}

// === 取引所抽象クラス ===
export abstract class ExchangeAdapter {
  protected config: ExchangeConfig;
  protected rateLimiter: Map<string, number> = new Map();

  constructor(config: ExchangeConfig) {
    this.config = config;
  }

  // === 抽象メソッド ===
  abstract authenticate(params: any): any;
  abstract getMarketData(symbol: string): Promise<MarketData>;
  abstract getBalances(): Promise<Balance[]>;
  abstract placeOrder(order: OrderRequest): Promise<Order>;
  abstract getOrder(orderId: string): Promise<Order>;
  abstract cancelOrder(orderId: string): Promise<boolean>;
  abstract getTradingFee(symbol: string): Promise<number>;

  // === 共通メソッド ===
  protected checkRateLimit(): boolean {
    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const requests = this.rateLimiter.get(minute.toString()) || 0;
    
    if (requests >= this.config.rateLimit) {
      return false;
    }
    
    this.rateLimiter.set(minute.toString(), requests + 1);
    return true;
  }

  protected createSignature(method: string, path: string, body: string, timestamp: string): string {
    const message = timestamp + method + path + body;
    return crypto.createHmac('sha256', this.config.apiSecret).update(message).digest('hex');
  }

  protected generateNonce(): string {
    return Date.now().toString();
  }
}

// === Binance アダプター ===
export class BinanceAdapter extends ExchangeAdapter {
  authenticate(params: any): any {
    const timestamp = Date.now().toString();
    const queryString = new URLSearchParams(params).toString() + `&timestamp=${timestamp}`;
    const signature = crypto
      .createHmac('sha256', this.config.apiSecret)
      .update(queryString)
      .digest('hex');
    
    return {
      ...params,
      timestamp,
      signature,
      'X-MBX-APIKEY': this.config.apiKey
    };
  }

  async getMarketData(symbol: string): Promise<MarketData> {
    if (!this.checkRateLimit()) {
      throw new Error('Rate limit exceeded');
    }

    const response = await axios.get(`${this.config.baseUrl}/api/v3/ticker/24hr`, {
      params: { symbol: symbol.toUpperCase() }
    });

    const data = response.data;
    return {
      symbol,
      price: parseFloat(data.lastPrice),
      bid: parseFloat(data.bidPrice),
      ask: parseFloat(data.askPrice),
      volume24h: parseFloat(data.volume),
      change24h: parseFloat(data.priceChangePercent),
      timestamp: Date.now()
    };
  }

  async getBalances(): Promise<Balance[]> {
    const params = this.authenticate({});
    
    const response = await axios.get(`${this.config.baseUrl}/api/v3/account`, {
      params,
      headers: { 'X-MBX-APIKEY': this.config.apiKey }
    });

    return response.data.balances
      .filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
      .map((balance: any) => ({
        currency: balance.asset,
        available: parseFloat(balance.free),
        locked: parseFloat(balance.locked),
        total: parseFloat(balance.free) + parseFloat(balance.locked)
      }));
  }

  async placeOrder(order: OrderRequest): Promise<Order> {
    const params = this.authenticate({
      symbol: order.symbol.toUpperCase(),
      side: order.side.toUpperCase(),
      type: order.type.toUpperCase(),
      quantity: order.amount.toString(),
      ...(order.price && { price: order.price.toString() }),
      ...(order.timeInForce && { timeInForce: order.timeInForce })
    });

    const response = await axios.post(`${this.config.baseUrl}/api/v3/order`, null, {
      params,
      headers: { 'X-MBX-APIKEY': this.config.apiKey }
    });

    const data = response.data;
    return {
      id: data.orderId.toString(),
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      amount: order.amount,
      price: parseFloat(data.price || order.price || '0'),
      filled: parseFloat(data.executedQty),
      remaining: order.amount - parseFloat(data.executedQty),
      status: this.mapOrderStatus(data.status),
      timestamp: data.transactTime,
      fee: 0, // 別途取得が必要
      feeCurrency: ''
    };
  }

  async getOrder(orderId: string): Promise<Order> {
    // Binance specific implementation
    throw new Error('Not implemented');
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    // Binance specific implementation
    throw new Error('Not implemented');
  }

  async getTradingFee(symbol: string): Promise<number> {
    return this.config.tradingFee;
  }

  private mapOrderStatus(status: string): Order['status'] {
    switch (status) {
      case 'NEW': return 'open';
      case 'FILLED': return 'filled';
      case 'CANCELED': return 'cancelled';
      case 'REJECTED': return 'rejected';
      default: return 'open';
    }
  }
}

// === Coinbase Pro アダプター ===
export class CoinbaseProAdapter extends ExchangeAdapter {
  authenticate(method: string, path: string, body: string = ''): any {
    const timestamp = Date.now() / 1000;
    const message = timestamp + method.toUpperCase() + path + body;
    const signature = crypto
      .createHmac('sha256', Buffer.from(this.config.apiSecret, 'base64'))
      .update(message)
      .digest('base64');

    return {
      'CB-ACCESS-KEY': this.config.apiKey,
      'CB-ACCESS-SIGN': signature,
      'CB-ACCESS-TIMESTAMP': timestamp.toString(),
      'CB-ACCESS-PASSPHRASE': this.config.passphrase
    };
  }

  async getMarketData(symbol: string): Promise<MarketData> {
    const productId = symbol.replace('/', '-');
    
    const [tickerResponse, statsResponse] = await Promise.all([
      axios.get(`${this.config.baseUrl}/products/${productId}/ticker`),
      axios.get(`${this.config.baseUrl}/products/${productId}/stats`)
    ]);

    const ticker = tickerResponse.data;
    const stats = statsResponse.data;

    return {
      symbol,
      price: parseFloat(ticker.price),
      bid: parseFloat(ticker.bid),
      ask: parseFloat(ticker.ask),
      volume24h: parseFloat(ticker.volume),
      change24h: ((parseFloat(ticker.price) - parseFloat(stats.open)) / parseFloat(stats.open)) * 100,
      timestamp: Date.now()
    };
  }

  async getBalances(): Promise<Balance[]> {
    const headers = this.authenticate('GET', '/accounts');
    
    const response = await axios.get(`${this.config.baseUrl}/accounts`, { headers });

    return response.data.map((account: any) => ({
      currency: account.currency,
      available: parseFloat(account.available),
      locked: parseFloat(account.hold),
      total: parseFloat(account.balance)
    }));
  }

  async placeOrder(order: OrderRequest): Promise<Order> {
    const body = JSON.stringify({
      product_id: order.symbol.replace('/', '-'),
      side: order.side,
      type: order.type,
      size: order.amount.toString(),
      ...(order.price && { price: order.price.toString() })
    });

    const headers = {
      'Content-Type': 'application/json',
      ...this.authenticate('POST', '/orders', body)
    };

    const response = await axios.post(`${this.config.baseUrl}/orders`, body, { headers });

    const data = response.data;
    return {
      id: data.id,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      amount: order.amount,
      price: parseFloat(data.price || '0'),
      filled: parseFloat(data.filled_size || '0'),
      remaining: parseFloat(data.size) - parseFloat(data.filled_size || '0'),
      status: this.mapOrderStatus(data.status),
      timestamp: new Date(data.created_at).getTime(),
      fee: 0,
      feeCurrency: ''
    };
  }

  async getOrder(orderId: string): Promise<Order> {
    // Coinbase Pro specific implementation
    throw new Error('Not implemented');
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    // Coinbase Pro specific implementation
    throw new Error('Not implemented');
  }

  async getTradingFee(symbol: string): Promise<number> {
    return this.config.tradingFee;
  }

  private mapOrderStatus(status: string): Order['status'] {
    switch (status) {
      case 'open': return 'open';
      case 'done': return 'filled';
      case 'cancelled': return 'cancelled';
      case 'rejected': return 'rejected';
      default: return 'open';
    }
  }
}

// === メイン取引所統合システム ===
export class LightExchangeIntegration extends EventEmitter {
  private exchanges = new Map<string, ExchangeAdapter>();
  private autoSellRules = new Map<string, AutoSellRule>();
  private metrics: TradingMetrics;
  private priceCache = new Map<string, MarketData>();
  private activeOrders = new Map<string, Order>();
  private monitoringTimer?: NodeJS.Timeout;

  constructor() {
    super();
    this.metrics = {
      totalVolume: 0,
      totalFees: 0,
      successfulTrades: 0,
      failedTrades: 0,
      averageSlippage: 0,
      profitLoss: 0,
      winRate: 0
    };
  }

  // === 取引所管理 ===
  addExchange(name: string, config: ExchangeConfig): void {
    let adapter: ExchangeAdapter;

    switch (name.toLowerCase()) {
      case 'binance':
        adapter = new BinanceAdapter(config);
        break;
      case 'coinbase':
      case 'coinbasepro':
        adapter = new CoinbaseProAdapter(config);
        break;
      default:
        throw new Error(`Unsupported exchange: ${name}`);
    }

    this.exchanges.set(name, adapter);
    console.log(`📈 Added exchange: ${name}`);
  }

  removeExchange(name: string): boolean {
    return this.exchanges.delete(name);
  }

  // === 自動売却ルール管理 ===
  addAutoSellRule(rule: AutoSellRule): void {
    this.autoSellRules.set(rule.id, rule);
    console.log(`🤖 Added auto-sell rule: ${rule.currency} ${rule.trigger.type}`);
  }

  removeAutoSellRule(ruleId: string): boolean {
    return this.autoSellRules.delete(ruleId);
  }

  toggleAutoSellRule(ruleId: string, enabled: boolean): boolean {
    const rule = this.autoSellRules.get(ruleId);
    if (rule) {
      rule.enabled = enabled;
      return true;
    }
    return false;
  }

  // === 価格監視 ===
  async startPriceMonitoring(symbols: string[], intervalMs = 30000): Promise<void> {
    console.log(`📊 Starting price monitoring for: ${symbols.join(', ')}`);

    // 初回価格取得
    for (const symbol of symbols) {
      await this.updatePrice(symbol);
    }

    // 定期更新
    this.monitoringTimer = setInterval(async () => {
      for (const symbol of symbols) {
        try {
          await this.updatePrice(symbol);
          await this.checkAutoSellRules(symbol);
        } catch (error) {
          console.error(`Failed to update price for ${symbol}:`, error);
        }
      }
    }, intervalMs);
  }

  private async updatePrice(symbol: string): Promise<void> {
    const exchange = this.getBestExchangeForSymbol(symbol);
    if (!exchange) return;

    try {
      const marketData = await exchange.getMarketData(symbol);
      this.priceCache.set(symbol, marketData);
      this.emit('priceUpdated', marketData);
    } catch (error) {
      console.error(`Failed to fetch price for ${symbol}:`, error);
    }
  }

  private getBestExchangeForSymbol(symbol: string): ExchangeAdapter | null {
    // 簡略化：最初の取引所を返す
    return Array.from(this.exchanges.values())[0] || null;
  }

  // === 自動売却実行 ===
  private async checkAutoSellRules(symbol: string): Promise<void> {
    const marketData = this.priceCache.get(symbol);
    if (!marketData) return;

    for (const [ruleId, rule] of this.autoSellRules) {
      if (!rule.enabled || rule.currency !== symbol.split('/')[0]) continue;

      try {
        if (this.shouldTriggerRule(rule, marketData)) {
          await this.executeAutoSell(rule, marketData);
        }
      } catch (error) {
        console.error(`Auto-sell rule ${ruleId} failed:`, error);
      }
    }
  }

  private shouldTriggerRule(rule: AutoSellRule, marketData: MarketData): boolean {
    switch (rule.trigger.type) {
      case 'price_target':
        if (rule.trigger.condition === 'above') {
          return marketData.price >= rule.trigger.value;
        } else if (rule.trigger.condition === 'below') {
          return marketData.price <= rule.trigger.value;
        }
        break;
      case 'threshold':
        // 残高閾値チェック（別途残高取得が必要）
        return false;
      case 'scheduled':
        // 時間ベースのトリガー
        return false;
    }
    return false;
  }

  private async executeAutoSell(rule: AutoSellRule, marketData: MarketData): Promise<void> {
    console.log(`🤖 Executing auto-sell for ${rule.currency} at ${marketData.price}`);

    const exchange = this.getBestExchangeForSymbol(marketData.symbol);
    if (!exchange) return;

    // 残高確認
    const balances = await exchange.getBalances();
    const balance = balances.find(b => b.currency === rule.currency);
    if (!balance || balance.available <= 0) return;

    // 売却量計算
    let sellAmount: number;
    switch (rule.sellAmount.type) {
      case 'all':
        sellAmount = balance.available;
        break;
      case 'percentage':
        sellAmount = balance.available * (rule.sellAmount.value / 100);
        break;
      case 'fixed':
        sellAmount = Math.min(rule.sellAmount.value, balance.available);
        break;
      default:
        return;
    }

    // 最小取引量チェック
    if (sellAmount < 0.001) return; // 例：最小0.001

    try {
      // 注文作成
      const order: OrderRequest = {
        symbol: marketData.symbol,
        side: 'sell',
        type: rule.priceStrategy === 'market' ? 'market' : 'limit',
        amount: sellAmount,
        ...(rule.priceStrategy === 'limit_custom' && rule.customPrice && { price: rule.customPrice }),
        ...(rule.priceStrategy === 'limit_best' && { price: marketData.bid })
      };

      const placedOrder = await exchange.placeOrder(order);
      this.activeOrders.set(placedOrder.id, placedOrder);

      // メトリクス更新
      this.metrics.totalVolume += sellAmount;
      
      this.emit('autoSellExecuted', {
        rule: rule.id,
        order: placedOrder,
        marketData
      });

      console.log(`✅ Auto-sell order placed: ${sellAmount} ${rule.currency} at ${marketData.price}`);

    } catch (error) {
      this.metrics.failedTrades++;
      console.error(`❌ Auto-sell failed for ${rule.currency}:`, error);
    }
  }

  // === 手動取引 ===
  async placeSellOrder(
    exchangeName: string,
    symbol: string,
    amount: number,
    type: 'market' | 'limit' = 'market',
    price?: number
  ): Promise<Order> {
    const exchange = this.exchanges.get(exchangeName);
    if (!exchange) {
      throw new Error(`Exchange ${exchangeName} not found`);
    }

    const order: OrderRequest = {
      symbol,
      side: 'sell',
      type,
      amount,
      ...(price && { price })
    };

    try {
      const placedOrder = await exchange.placeOrder(order);
      this.activeOrders.set(placedOrder.id, placedOrder);
      
      this.metrics.totalVolume += amount;
      this.metrics.successfulTrades++;
      
      this.emit('orderPlaced', placedOrder);
      return placedOrder;

    } catch (error) {
      this.metrics.failedTrades++;
      throw error;
    }
  }

  // === 最適化機能 ===
  async findBestExchange(symbol: string, amount: number): Promise<{ exchange: string; netAmount: number }> {
    const results: Array<{ exchange: string; netAmount: number }> = [];

    for (const [name, exchange] of this.exchanges) {
      try {
        const marketData = await exchange.getMarketData(symbol);
        const fee = await exchange.getTradingFee(symbol);
        const grossAmount = amount * marketData.bid;
        const netAmount = grossAmount * (1 - fee / 100);
        
        results.push({ exchange: name, netAmount });
      } catch (error) {
        console.warn(`Failed to check ${name} for ${symbol}:`, error);
      }
    }

    results.sort((a, b) => b.netAmount - a.netAmount);
    return results[0] || { exchange: '', netAmount: 0 };
  }

  async optimizeTrading(currency: string, targetUSD: number): Promise<void> {
    console.log(`🔧 Optimizing trading for ${currency} (target: $${targetUSD})`);

    // 対USD ペアを探す
    const usdSymbols = [`${currency}/USD`, `${currency}/USDT`, `${currency}/USDC`];
    
    for (const symbol of usdSymbols) {
      try {
        const marketData = this.priceCache.get(symbol);
        if (!marketData) continue;

        const requiredAmount = targetUSD / marketData.price;
        const bestExchange = await this.findBestExchange(symbol, requiredAmount);
        
        if (bestExchange.exchange) {
          console.log(`💡 Best exchange for ${symbol}: ${bestExchange.exchange} (net: $${bestExchange.netAmount.toFixed(2)})`);
        }
      } catch (error) {
        console.error(`Optimization failed for ${symbol}:`, error);
      }
    }
  }

  // === 情報取得 ===
  getCurrentPrice(symbol: string): MarketData | null {
    return this.priceCache.get(symbol) || null;
  }

  getActiveOrders(): Order[] {
    return Array.from(this.activeOrders.values());
  }

  getAutoSellRules(): AutoSellRule[] {
    return Array.from(this.autoSellRules.values());
  }

  getTradingMetrics(): TradingMetrics {
    this.metrics.winRate = this.metrics.successfulTrades / 
      (this.metrics.successfulTrades + this.metrics.failedTrades) * 100;
    return { ...this.metrics };
  }

  async getBalances(exchangeName?: string): Promise<Record<string, Balance[]>> {
    const balances: Record<string, Balance[]> = {};

    if (exchangeName) {
      const exchange = this.exchanges.get(exchangeName);
      if (exchange) {
        balances[exchangeName] = await exchange.getBalances();
      }
    } else {
      for (const [name, exchange] of this.exchanges) {
        try {
          balances[name] = await exchange.getBalances();
        } catch (error) {
          console.error(`Failed to get balances from ${name}:`, error);
          balances[name] = [];
        }
      }
    }

    return balances;
  }

  // === 停止処理 ===
  stop(): void {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = undefined;
    }
    
    this.priceCache.clear();
    this.activeOrders.clear();
    
    console.log('🛑 Exchange integration stopped');
  }
}

// === ヘルパークラス ===
export class ExchangeIntegrationHelper {
  static createBinanceConfig(apiKey: string, apiSecret: string, sandbox = false): ExchangeConfig {
    return {
      name: 'Binance',
      apiKey,
      apiSecret,
      baseUrl: sandbox ? 'https://testnet.binance.vision' : 'https://api.binance.com',
      rateLimit: 1200, // per minute
      tradingFee: 0.1, // 0.1%
      withdrawalFees: {
        BTC: 0.0005,
        ETH: 0.005,
        LTC: 0.001
      }
    };
  }

  static createCoinbaseConfig(apiKey: string, apiSecret: string, passphrase: string, sandbox = false): ExchangeConfig {
    return {
      name: 'Coinbase Pro',
      apiKey,
      apiSecret,
      passphrase,
      baseUrl: sandbox ? 'https://api-public.sandbox.pro.coinbase.com' : 'https://api.pro.coinbase.com',
      rateLimit: 10, // per second
      tradingFee: 0.5, // 0.5%
      withdrawalFees: {
        BTC: 0.0001,
        ETH: 0.01,
        LTC: 0.001
      }
    };
  }

  static createThresholdAutoSellRule(
    currency: string,
    thresholdAmount: number,
    sellPercentage: number
  ): AutoSellRule {
    return {
      id: `threshold_${currency}_${Date.now()}`,
      currency,
      enabled: true,
      trigger: {
        type: 'threshold',
        value: thresholdAmount,
        condition: 'above'
      },
      sellAmount: {
        type: 'percentage',
        value: sellPercentage
      },
      priceStrategy: 'market',
      maxSlippage: 2.0
    };
  }

  static createPriceTargetAutoSellRule(
    currency: string,
    targetPrice: number,
    sellAll = false
  ): AutoSellRule {
    return {
      id: `price_${currency}_${Date.now()}`,
      currency,
      enabled: true,
      trigger: {
        type: 'price_target',
        value: targetPrice,
        condition: 'above'
      },
      sellAmount: {
        type: sellAll ? 'all' : 'percentage',
        value: sellAll ? 100 : 50
      },
      priceStrategy: 'limit_best',
      maxSlippage: 1.0
    };
  }

  static formatCurrency(amount: number, currency: string): string {
    return `${amount.toFixed(8)} ${currency}`;
  }

  static formatUSD(amount: number): string {
    return `$${amount.toFixed(2)}`;
  }

  static calculateSlippage(expectedPrice: number, actualPrice: number): number {
    return Math.abs((actualPrice - expectedPrice) / expectedPrice) * 100;
  }

  static estimateTradeValue(amount: number, price: number, fee: number): number {
    return amount * price * (1 - fee / 100);
  }
}

export default LightExchangeIntegration;