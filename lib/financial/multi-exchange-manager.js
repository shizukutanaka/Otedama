/**
 * Multi-Exchange Manager - Otedama
 * 複数取引所統合管理システム
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import axios from 'axios';
import { createHmac } from 'crypto';

const logger = createStructuredLogger('MultiExchangeManager');

// 取引所API設定
export const ExchangeConfigs = {
  BINANCE: {
    name: 'Binance',
    apiUrl: 'https://api.binance.com',
    wsUrl: 'wss://stream.binance.com:9443/ws/',
    rateLimits: {
      requests: 1200, // per minute
      orders: 100000, // per 24h
      weight: 6000 // per minute
    },
    fees: {
      maker: 0.001,
      taker: 0.001
    },
    supportedPairs: ['BTC/USDT', 'ETH/BTC', 'LTC/BTC'],
    requiredCredentials: ['apiKey', 'secretKey']
  },
  
  COINBASE: {
    name: 'Coinbase Pro',
    apiUrl: 'https://api.exchange.coinbase.com',
    wsUrl: 'wss://ws-feed.exchange.coinbase.com',
    rateLimits: {
      requests: 10, // per second
      orders: 1000, // per day
    },
    fees: {
      maker: 0.005,
      taker: 0.005
    },
    supportedPairs: ['BTC-USD', 'ETH-BTC', 'LTC-BTC'],
    requiredCredentials: ['apiKey', 'secretKey', 'passphrase']
  },
  
  KRAKEN: {
    name: 'Kraken',
    apiUrl: 'https://api.kraken.com',
    wsUrl: 'wss://ws.kraken.com',
    rateLimits: {
      requests: 60, // per minute
      orders: 60, // per minute
    },
    fees: {
      maker: 0.0016,
      taker: 0.0026
    },
    supportedPairs: ['XBTUSDT', 'ETHXBT', 'LTCXBT'],
    requiredCredentials: ['apiKey', 'secretKey']
  },
  
  BITFINEX: {
    name: 'Bitfinex',
    apiUrl: 'https://api.bitfinex.com',
    wsUrl: 'wss://api.bitfinex.com/ws/2',
    rateLimits: {
      requests: 90, // per minute
      orders: 1000, // per 5 minutes
    },
    fees: {
      maker: 0.001,
      taker: 0.002
    },
    supportedPairs: ['tBTCUSD', 'tETHBTC', 'tLTCBTC'],
    requiredCredentials: ['apiKey', 'secretKey']
  }
};

export class MultiExchangeManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // 取引所設定
      exchanges: options.exchanges || Object.keys(ExchangeConfigs),
      credentials: options.credentials || {},
      
      // 接続設定
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      connectionTimeout: options.connectionTimeout || 30000,
      
      // レート制限
      respectRateLimits: options.respectRateLimits !== false,
      rateLimitBuffer: options.rateLimitBuffer || 0.9, // 90%で制限
      
      // アービトラージ検出
      arbitrageDetection: options.arbitrageDetection !== false,
      minArbitrageProfit: options.minArbitrageProfit || 0.005, // 0.5%
      
      // 価格集約
      priceAggregation: options.priceAggregation !== false,
      weightedAveraging: options.weightedAveraging !== false,
      
      // 監視設定
      priceUpdateInterval: options.priceUpdateInterval || 5000, // 5秒
      balanceUpdateInterval: options.balanceUpdateInterval || 60000, // 1分
      
      ...options
    };
    
    // 取引所インスタンス
    this.exchanges = new Map();
    this.exchangeStates = new Map();
    this.connections = new Map();
    
    // レート制限管理
    this.rateLimiters = new Map();
    this.requestQueues = new Map();
    
    // 価格データ
    this.prices = new Map();
    this.orderBooks = new Map();
    this.tickers = new Map();
    
    // 残高データ
    this.balances = new Map();
    
    // アービトラージ機会
    this.arbitrageOpportunities = [];
    
    // 統計
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageLatency: 0,
      exchangeUptime: new Map(),
      arbitrageOpportunities: 0,
      totalVolume: 0
    };
    
    // タイマー
    this.priceUpdateTimer = null;
    this.balanceUpdateTimer = null;
    this.arbitrageTimer = null;
  }
  
  /**
   * 初期化
   */
  async initialize() {
    logger.info('マルチ取引所マネージャー初期化中', {
      exchanges: this.options.exchanges.length
    });
    
    try {
      // 各取引所の初期化
      for (const exchangeName of this.options.exchanges) {
        await this.initializeExchange(exchangeName);
      }
      
      // 価格更新開始
      if (this.options.priceAggregation) {
        this.startPriceUpdates();
      }
      
      // 残高更新開始
      this.startBalanceUpdates();
      
      // アービトラージ検出開始
      if (this.options.arbitrageDetection) {
        this.startArbitrageDetection();
      }
      
      logger.info('マルチ取引所マネージャー初期化完了', {
        connectedExchanges: this.exchanges.size
      });
      
      this.emit('initialized', {
        exchanges: Array.from(this.exchanges.keys())
      });
      
    } catch (error) {
      logger.error('初期化失敗', { error: error.message });
      throw error;
    }
  }
  
  /**
   * 取引所初期化
   */
  async initializeExchange(exchangeName) {
    const config = ExchangeConfigs[exchangeName];
    if (!config) {
      throw new Error(`未対応の取引所: ${exchangeName}`);
    }
    
    const credentials = this.options.credentials[exchangeName];
    if (!credentials) {
      logger.warn('認証情報なし、読み取り専用モード', { exchange: exchangeName });
    }
    
    const exchange = {
      name: exchangeName,
      config,
      credentials,
      connected: false,
      authenticated: false,
      lastHeartbeat: null,
      supportedPairs: new Set(config.supportedPairs),
      capabilities: {
        trading: !!credentials,
        websocket: !!config.wsUrl,
        orderBook: true,
        ticker: true
      }
    };
    
    // レート制限初期化
    this.initializeRateLimiter(exchangeName, config.rateLimits);
    
    // 接続テスト
    await this.testConnection(exchange);
    
    // 認証テスト（認証情報がある場合）
    if (credentials) {
      await this.testAuthentication(exchange);
    }
    
    // WebSocket接続（サポートしている場合）
    if (exchange.capabilities.websocket) {
      await this.initializeWebSocket(exchange);
    }
    
    this.exchanges.set(exchangeName, exchange);
    this.exchangeStates.set(exchangeName, {
      status: 'connected',
      lastUpdate: Date.now(),
      requestCount: 0,
      errorCount: 0,
      latency: 0
    });
    
    logger.info('取引所初期化完了', {
      exchange: exchangeName,
      authenticated: exchange.authenticated,
      websocket: exchange.capabilities.websocket
    });
    
    this.emit('exchange:connected', {
      exchange: exchangeName,
      capabilities: exchange.capabilities
    });
  }
  
  /**
   * API リクエスト実行
   */
  async executeRequest(exchangeName, method, endpoint, params = {}, authenticated = false) {
    const exchange = this.exchanges.get(exchangeName);
    if (!exchange) {
      throw new Error(`取引所が見つかりません: ${exchangeName}`);
    }
    
    // レート制限チェック
    if (this.options.respectRateLimits) {
      await this.checkRateLimit(exchangeName);
    }
    
    const startTime = Date.now();
    
    try {
      let result;
      
      switch (exchangeName) {
        case 'BINANCE':
          result = await this.executeBinanceRequest(method, endpoint, params, authenticated);
          break;
          
        case 'COINBASE':
          result = await this.executeCoinbaseRequest(method, endpoint, params, authenticated);
          break;
          
        case 'KRAKEN':
          result = await this.executeKrakenRequest(method, endpoint, params, authenticated);
          break;
          
        case 'BITFINEX':
          result = await this.executeBitfinexRequest(method, endpoint, params, authenticated);
          break;
          
        default:
          throw new Error(`未実装の取引所: ${exchangeName}`);
      }
      
      // 統計更新
      const latency = Date.now() - startTime;
      this.updateRequestStats(exchangeName, true, latency);
      
      return result;
      
    } catch (error) {
      this.updateRequestStats(exchangeName, false, Date.now() - startTime);
      throw error;
    }
  }
  
  /**
   * Binance API リクエスト
   */
  async executeBinanceRequest(method, endpoint, params, authenticated) {
    const exchange = this.exchanges.get('BINANCE');
    const baseUrl = exchange.config.apiUrl;
    
    let url = `${baseUrl}${endpoint}`;\n    let headers = {\n      'X-MBX-APIKEY': exchange.credentials?.apiKey\n    };\n    \n    // 認証が必要な場合\n    if (authenticated && exchange.credentials) {\n      params.timestamp = Date.now();\n      \n      // クエリストリング作成\n      const queryString = Object.keys(params)\n        .sort()\n        .map(key => `${key}=${encodeURIComponent(params[key])}`)\n        .join('&');\n      \n      // 署名作成\n      const signature = createHmac('sha256', exchange.credentials.secretKey)\n        .update(queryString)\n        .digest('hex');\n      \n      params.signature = signature;\n    }\n    \n    // リクエスト実行\n    const config = {\n      method,\n      url,\n      headers,\n      timeout: this.options.connectionTimeout\n    };\n    \n    if (method === 'GET') {\n      config.params = params;\n    } else {\n      config.data = params;\n    }\n    \n    const response = await axios(config);\n    return response.data;\n  }\n  \n  /**\n   * Coinbase API リクエスト\n   */\n  async executeCoinbaseRequest(method, endpoint, params, authenticated) {\n    const exchange = this.exchanges.get('COINBASE');\n    const baseUrl = exchange.config.apiUrl;\n    \n    let url = `${baseUrl}${endpoint}`;\n    let headers = {};\n    \n    // 認証が必要な場合\n    if (authenticated && exchange.credentials) {\n      const timestamp = Date.now() / 1000;\n      const body = method === 'GET' ? '' : JSON.stringify(params);\n      const message = timestamp + method + endpoint + body;\n      \n      headers = {\n        'CB-ACCESS-KEY': exchange.credentials.apiKey,\n        'CB-ACCESS-SIGN': createHmac('sha256', \n          Buffer.from(exchange.credentials.secretKey, 'base64'))\n          .update(message)\n          .digest('base64'),\n        'CB-ACCESS-TIMESTAMP': timestamp,\n        'CB-ACCESS-PASSPHRASE': exchange.credentials.passphrase,\n        'Content-Type': 'application/json'\n      };\n    }\n    \n    const config = {\n      method,\n      url,\n      headers,\n      timeout: this.options.connectionTimeout\n    };\n    \n    if (method === 'GET') {\n      config.params = params;\n    } else {\n      config.data = params;\n    }\n    \n    const response = await axios(config);\n    return response.data;\n  }\n  \n  /**\n   * 注文実行\n   */\n  async placeOrder(exchangeName, pair, side, amount, price = null, type = 'market') {\n    const exchange = this.exchanges.get(exchangeName);\n    if (!exchange || !exchange.authenticated) {\n      throw new Error(`取引所 ${exchangeName} で認証されていません`);\n    }\n    \n    logger.info('注文実行', {\n      exchange: exchangeName,\n      pair,\n      side,\n      amount,\n      price,\n      type\n    });\n    \n    let result;\n    \n    switch (exchangeName) {\n      case 'BINANCE':\n        result = await this.placeBinanceOrder(pair, side, amount, price, type);\n        break;\n        \n      case 'COINBASE':\n        result = await this.placeCoinbaseOrder(pair, side, amount, price, type);\n        break;\n        \n      case 'KRAKEN':\n        result = await this.placeKrakenOrder(pair, side, amount, price, type);\n        break;\n        \n      case 'BITFINEX':\n        result = await this.placeBitfinexOrder(pair, side, amount, price, type);\n        break;\n        \n      default:\n        throw new Error(`未対応の取引所: ${exchangeName}`);\n    }\n    \n    this.emit('order:placed', {\n      exchange: exchangeName,\n      orderId: result.orderId,\n      pair,\n      side,\n      amount,\n      price,\n      type\n    });\n    \n    return result;\n  }\n  \n  /**\n   * 最良価格取得\n   */\n  getBestPrice(pair, side) {\n    let bestPrice = null;\n    let bestExchange = null;\n    \n    for (const [exchangeName, orderBook] of this.orderBooks) {\n      const book = orderBook.get(pair);\n      if (!book) continue;\n      \n      const orders = side === 'buy' ? book.asks : book.bids;\n      if (orders.length === 0) continue;\n      \n      const price = orders[0].price;\n      \n      if (!bestPrice || \n          (side === 'buy' && price < bestPrice) ||\n          (side === 'sell' && price > bestPrice)) {\n        bestPrice = price;\n        bestExchange = exchangeName;\n      }\n    }\n    \n    return {\n      price: bestPrice,\n      exchange: bestExchange\n    };\n  }\n  \n  /**\n   * アービトラージ機会検出\n   */\n  detectArbitrageOpportunities() {\n    const opportunities = [];\n    \n    // 全ペアをチェック\n    for (const pair of this.getSupportedPairs()) {\n      const prices = this.getPricesForPair(pair);\n      \n      if (prices.length < 2) continue;\n      \n      // 価格をソート\n      prices.sort((a, b) => a.bid - b.bid);\n      \n      const lowest = prices[0];\n      const highest = prices[prices.length - 1];\n      \n      // 利益計算\n      const profit = (highest.bid - lowest.ask) / lowest.ask;\n      \n      if (profit > this.options.minArbitrageProfit) {\n        opportunities.push({\n          pair,\n          buyExchange: lowest.exchange,\n          sellExchange: highest.exchange,\n          buyPrice: lowest.ask,\n          sellPrice: highest.bid,\n          profit,\n          timestamp: Date.now()\n        });\n      }\n    }\n    \n    this.arbitrageOpportunities = opportunities;\n    this.stats.arbitrageOpportunities += opportunities.length;\n    \n    if (opportunities.length > 0) {\n      this.emit('arbitrage:detected', opportunities);\n    }\n    \n    return opportunities;\n  }\n  \n  /**\n   * 統合価格取得\n   */\n  getAggregatedPrice(pair) {\n    const prices = this.getPricesForPair(pair);\n    \n    if (prices.length === 0) return null;\n    if (prices.length === 1) return prices[0];\n    \n    if (this.options.weightedAveraging) {\n      // ボリューム加重平均\n      let totalBidVolume = 0;\n      let totalAskVolume = 0;\n      let weightedBid = 0;\n      let weightedAsk = 0;\n      \n      for (const price of prices) {\n        const volume = price.volume || 1;\n        totalBidVolume += volume;\n        totalAskVolume += volume;\n        weightedBid += price.bid * volume;\n        weightedAsk += price.ask * volume;\n      }\n      \n      return {\n        bid: weightedBid / totalBidVolume,\n        ask: weightedAsk / totalAskVolume,\n        exchanges: prices.map(p => p.exchange),\n        aggregated: true\n      };\n      \n    } else {\n      // 単純平均\n      const avgBid = prices.reduce((sum, p) => sum + p.bid, 0) / prices.length;\n      const avgAsk = prices.reduce((sum, p) => sum + p.ask, 0) / prices.length;\n      \n      return {\n        bid: avgBid,\n        ask: avgAsk,\n        exchanges: prices.map(p => p.exchange),\n        aggregated: true\n      };\n    }\n  }\n  \n  /**\n   * 状況取得\n   */\n  getStatus() {\n    const status = {\n      exchanges: {},\n      aggregatedPrices: {},\n      arbitrageOpportunities: this.arbitrageOpportunities.slice(0, 10),\n      stats: this.stats\n    };\n    \n    // 取引所状況\n    for (const [name, exchange] of this.exchanges) {\n      const state = this.exchangeStates.get(name);\n      status.exchanges[name] = {\n        connected: exchange.connected,\n        authenticated: exchange.authenticated,\n        status: state.status,\n        latency: state.latency,\n        requestCount: state.requestCount,\n        errorCount: state.errorCount,\n        lastUpdate: state.lastUpdate\n      };\n    }\n    \n    // 統合価格\n    for (const pair of this.getSupportedPairs()) {\n      status.aggregatedPrices[pair] = this.getAggregatedPrice(pair);\n    }\n    \n    return status;\n  }\n  \n  /**\n   * シャットダウン\n   */\n  async shutdown() {\n    logger.info('マルチ取引所マネージャーシャットダウン中');\n    \n    // タイマー停止\n    if (this.priceUpdateTimer) clearInterval(this.priceUpdateTimer);\n    if (this.balanceUpdateTimer) clearInterval(this.balanceUpdateTimer);\n    if (this.arbitrageTimer) clearInterval(this.arbitrageTimer);\n    \n    // WebSocket接続切断\n    for (const connection of this.connections.values()) {\n      if (connection && connection.close) {\n        connection.close();\n      }\n    }\n    \n    logger.info('マルチ取引所マネージャーシャットダウン完了');\n  }\n  \n  // ユーティリティメソッド\n  \n  initializeRateLimiter(exchangeName, limits) {\n    this.rateLimiters.set(exchangeName, {\n      requests: [],\n      orders: [],\n      weight: [],\n      limits\n    });\n  }\n  \n  async checkRateLimit(exchangeName) {\n    const limiter = this.rateLimiters.get(exchangeName);\n    if (!limiter) return;\n    \n    const now = Date.now();\n    const windowSize = 60000; // 1分\n    \n    // 古いリクエストを削除\n    limiter.requests = limiter.requests.filter(time => now - time < windowSize);\n    \n    // レート制限チェック\n    if (limiter.requests.length >= limiter.limits.requests * this.options.rateLimitBuffer) {\n      const waitTime = windowSize - (now - limiter.requests[0]);\n      await new Promise(resolve => setTimeout(resolve, waitTime));\n    }\n    \n    limiter.requests.push(now);\n  }\n  \n  updateRequestStats(exchangeName, success, latency) {\n    const state = this.exchangeStates.get(exchangeName);\n    if (state) {\n      state.requestCount++;\n      if (!success) state.errorCount++;\n      state.latency = latency;\n      state.lastUpdate = Date.now();\n    }\n    \n    this.stats.totalRequests++;\n    if (success) {\n      this.stats.successfulRequests++;\n    } else {\n      this.stats.failedRequests++;\n    }\n    \n    // 移動平均でレイテンシ更新\n    const alpha = 0.1;\n    this.stats.averageLatency = this.stats.averageLatency * (1 - alpha) + latency * alpha;\n  }\n  \n  getSupportedPairs() {\n    const pairs = new Set();\n    for (const exchange of this.exchanges.values()) {\n      for (const pair of exchange.supportedPairs) {\n        pairs.add(pair);\n      }\n    }\n    return Array.from(pairs);\n  }\n  \n  getPricesForPair(pair) {\n    const prices = [];\n    \n    for (const [exchangeName, ticker] of this.tickers) {\n      const price = ticker.get(pair);\n      if (price) {\n        prices.push({\n          ...price,\n          exchange: exchangeName\n        });\n      }\n    }\n    \n    return prices;\n  }\n  \n  // 以下、実装が必要なメソッド（簡略化）\n  async testConnection(exchange) { /* 接続テスト */ exchange.connected = true; }\n  async testAuthentication(exchange) { /* 認証テスト */ exchange.authenticated = true; }\n  async initializeWebSocket(exchange) { /* WebSocket初期化 */ }\n  async executeKrakenRequest(method, endpoint, params, authenticated) { /* Kraken API */ return {}; }\n  async executeBitfinexRequest(method, endpoint, params, authenticated) { /* Bitfinex API */ return {}; }\n  async placeBinanceOrder(pair, side, amount, price, type) { /* Binance注文 */ return { orderId: '123' }; }\n  async placeCoinbaseOrder(pair, side, amount, price, type) { /* Coinbase注文 */ return { orderId: '123' }; }\n  async placeKrakenOrder(pair, side, amount, price, type) { /* Kraken注文 */ return { orderId: '123' }; }\n  async placeBitfinexOrder(pair, side, amount, price, type) { /* Bitfinex注文 */ return { orderId: '123' }; }\n  \n  startPriceUpdates() {\n    this.priceUpdateTimer = setInterval(async () => {\n      await this.updateAllPrices();\n    }, this.options.priceUpdateInterval);\n  }\n  \n  startBalanceUpdates() {\n    this.balanceUpdateTimer = setInterval(async () => {\n      await this.updateAllBalances();\n    }, this.options.balanceUpdateInterval);\n  }\n  \n  startArbitrageDetection() {\n    this.arbitrageTimer = setInterval(() => {\n      this.detectArbitrageOpportunities();\n    }, 10000); // 10秒間隔\n  }\n  \n  async updateAllPrices() { /* 全価格更新 */ }\n  async updateAllBalances() { /* 全残高更新 */ }\n}\n\nexport default MultiExchangeManager;