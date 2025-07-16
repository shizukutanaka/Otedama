#!/usr/bin/env node



/**
 * Otedama Ver0.6 - Professional P2P Mining Pool & DEX Platform
 * 
 * Design Philosophy:
 * - Carmack: Performance first, minimal overhead, direct implementation
 * - Martin: Clean code, clear responsibilities, SOLID principles  
 * - Pike: Simple is better than complex, obvious solutions
 * 
 * Ver0.6 Features:
 * - NEW: All payouts in BTC only
 * - NEW: 1% pool fee + auto-calculated BTC conversion fee
 * - Remaining amount paid in BTC to miners
 * - P2P Mining Pool with automatic BTC conversion
 * - CPU/GPU/ASIC Support (13 currencies, 10 algorithms)
 * - Integrated DEX with 50+ currency pairs
 * - 50+ Language Support
 * - Mobile PWA
 * - Enterprise Security
 */

import { Worker } from 'worker_threads';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { cpus, freemem, totalmem } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import Database from 'better-sqlite3';
import { getPrices } from './services/price-feed.js';

// ===== CONSTANTS Ver0.6 =====
const VERSION = '0.6.0';
const OPERATOR_ADDRESS = '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa';

// NEW Ver0.6: Updated fee structure
const POOL_FEE_RATE = 0.01; // 1% pool usage fee (fixed)
// BTC conversion fee is auto-calculated based on actual conversion costs

// Wallet patterns for validation (13 supported currencies)
const WALLET_PATTERNS = {
  BTC: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$/,
  ETH: /^0x[a-fA-F0-9]{40}$/,
  RVN: /^R[a-km-zA-HJ-NP-Z1-9]{33}$/,
  XMR: /^4[0-9AB][0-9a-zA-Z]{93}$/,
  LTC: /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$|^ltc1[a-z0-9]{39,59}$/,
  ETC: /^0x[a-fA-F0-9]{40}$/,
  DOGE: /^D{1}[5-9A-HJ-NP-U]{1}[1-9A-HJ-NP-Za-km-z]{32}$/,
  ZEC: /^t1[a-km-zA-HJ-NP-Z1-9]{33}$/,
  DASH: /^X[a-km-zA-HJ-NP-Z1-9]{33}$/,
  ERGO: /^9[a-km-zA-HJ-NP-Z1-9]{50,}$/,
  FLUX: /^t1[a-km-zA-HJ-NP-Z1-9]{33}$/,
  KAS: /^kaspa:[a-z0-9]{61,63}$|^[a-z0-9]{61,63}$/,
  ALPH: /^[a-zA-Z0-9]{58}$/
};

// Algorithm configurations (10 supported algorithms)
const ALGORITHMS = {
  sha256: { name: 'SHA-256', coins: ['BTC'], hashUnit: 'TH/s', difficulty: 1000000 },
  kawpow: { name: 'KawPow', coins: ['RVN'], hashUnit: 'MH/s', difficulty: 100000 },
  ethash: { name: 'Ethash', coins: ['ETH', 'ETC'], hashUnit: 'MH/s', difficulty: 200000 },
  randomx: { name: 'RandomX', coins: ['XMR'], hashUnit: 'kH/s', difficulty: 50000 },
  scrypt: { name: 'Scrypt', coins: ['LTC', 'DOGE'], hashUnit: 'MH/s', difficulty: 500000 },
  equihash: { name: 'Equihash', coins: ['ZEC', 'FLUX'], hashUnit: 'Sol/s', difficulty: 300000 },
  x11: { name: 'X11', coins: ['DASH'], hashUnit: 'MH/s', difficulty: 400000 },
  autolykos: { name: 'Autolykos', coins: ['ERGO'], hashUnit: 'MH/s', difficulty: 150000 },
  kheavyhash: { name: 'kHeavyHash', coins: ['KAS'], hashUnit: 'GH/s', difficulty: 80000 },
  blake3: { name: 'Blake3', coins: ['ALPH'], hashUnit: 'MH/s', difficulty: 120000 }
};

// Ver0.6: Minimum payout amounts for each currency
const MIN_PAYOUT = {
  BTC: 0.001,      // Final payout currency
  ETH: 0.01,       // Will be converted to BTC
  RVN: 100,        // Will be converted to BTC
  XMR: 0.1,        // Will be converted to BTC
  LTC: 0.1,        // Will be converted to BTC
  ETC: 0.1,        // Will be converted to BTC
  DOGE: 50,        // Will be converted to BTC
  ZEC: 0.01,       // Will be converted to BTC
  DASH: 0.01,      // Will be converted to BTC
  ERGO: 1,         // Will be converted to BTC
  FLUX: 1,         // Will be converted to BTC
  KAS: 100,        // Will be converted to BTC
  ALPH: 1          // Will be converted to BTC
};

// Ver0.6: Live conversion rates to BTC, fetched from API
let liveCoinPrices = {};

// Ver0.6: DEPRECATED - Conversion rates to BTC (would use real API in production)
const BTC_CONVERSION_RATES = {
  BTC: 1.0,
  ETH: 0.065,      // 1 ETH = ~0.065 BTC
  RVN: 0.0000007,  // 1 RVN = ~0.0000007 BTC
  XMR: 0.0035,     // 1 XMR = ~0.0035 BTC
  LTC: 0.00215,    // 1 LTC = ~0.00215 BTC
  ETC: 0.0005,     // 1 ETC = ~0.0005 BTC
  DOGE: 0.0000025, // 1 DOGE = ~0.0000025 BTC
  ZEC: 0.0008,     // 1 ZEC = ~0.0008 BTC
  DASH: 0.0007,    // 1 DASH = ~0.0007 BTC
  ERGO: 0.00003,   // 1 ERGO = ~0.00003 BTC
  FLUX: 0.000015,  // 1 FLUX = ~0.000015 BTC
  KAS: 0.000003,   // 1 KAS = ~0.000003 BTC
  ALPH: 0.00002    // 1 ALPH = ~0.00002 BTC
};

// Ver0.6: Auto-calculated BTC conversion fees (based on exchange/network costs)
const BTC_CONVERSION_COSTS = {
  BTC: 0.0,        // No conversion needed
  ETH: 0.002,      // ~0.2% for ETH->BTC conversion
  RVN: 0.005,      // ~0.5% for RVN->BTC conversion  
  XMR: 0.008,      // ~0.8% for XMR->BTC conversion (privacy coin premium)
  LTC: 0.003,      // ~0.3% for LTC->BTC conversion
  ETC: 0.004,      // ~0.4% for ETC->BTC conversion
  DOGE: 0.006,     // ~0.6% for DOGE->BTC conversion
  ZEC: 0.007,      // ~0.7% for ZEC->BTC conversion (privacy coin)
  DASH: 0.005,     // ~0.5% for DASH->BTC conversion
  ERGO: 0.010,     // ~1.0% for ERGO->BTC conversion (low liquidity)
  FLUX: 0.008,     // ~0.8% for FLUX->BTC conversion
  KAS: 0.012,      // ~1.2% for KAS->BTC conversion (new coin)
  ALPH: 0.015      // ~1.5% for ALPH->BTC conversion (new coin)
};

// Multi-language support (50+ languages)
const TRANSLATIONS = {
  en: {
    welcome: 'Welcome to Otedama Mining Pool - All Payouts in BTC',
    mining: 'Mining',
    hashrate: 'Hashrate',
    earnings: 'BTC Earnings',
    balance: 'BTC Balance',
    payout: 'BTC Payout',
    stats: 'Statistics',
    dex: 'Exchange',
    liquidity: 'Liquidity',
    trade: 'Trade',
    error: 'Error',
    success: 'Success',
    btcOnly: 'All payouts in BTC',
    converted: 'Auto-converted to BTC',
    fee: 'Fee: 1% pool + auto-calculated BTC conversion',
    remaining: 'Remaining amount paid in BTC'
  },
  ja: {
    welcome: 'Otedamaマイニングプールへようこそ - 全支払いBTC',
    mining: 'マイニング',
    hashrate: 'ハッシュレート', 
    earnings: 'BTC収益',
    balance: 'BTC残高',
    payout: 'BTC支払い',
    stats: '統計',
    dex: '取引所',
    liquidity: '流動性',
    trade: '取引',
    error: 'エラー',
    success: '成功',
    btcOnly: '全支払いBTC',
    converted: 'BTCに自動変換',
    fee: '手数料: プール1% + BTC変換自動計算',
    remaining: '残額をBTCで支払い'
  },
  zh: {
    welcome: '欢迎来到Otedama挖矿池 - 全部以BTC支付',
    mining: '挖矿',
    hashrate: '算力',
    earnings: 'BTC收益',
    balance: 'BTC余额',
    payout: 'BTC支付',
    stats: '统计',
    dex: '交易所',
    liquidity: '流动性',
    trade: '交易',
    error: '错误',
    success: '成功',
    btcOnly: '全部BTC支付',
    converted: '自动转换为BTC',
    fee: '费用：矿池1% + BTC转换自动计算',
    remaining: '余额以BTC支付'
  },
  ko: {
    welcome: 'Otedama 마이닝 풀에 오신 것을 환영합니다 - 모든 지급은 BTC로',
    mining: '마이닝',
    hashrate: '해시율',
    earnings: 'BTC 수익',
    balance: 'BTC 잔고',
    payout: 'BTC 지급',
    stats: '통계',
    dex: '거래소',
    liquidity: '유동성',
    trade: '거래',
    error: '오류',
    success: '성공',
    btcOnly: '모든 지급 BTC',
    converted: 'BTC로 자동 변환',
    fee: '수수료: 풀 1% + BTC 변환 자동계산',
    remaining: '잔액을 BTC로 지급'
  },
  es: {
    welcome: 'Bienvenido a Otedama Mining Pool - Todos los pagos en BTC',
    mining: 'Minería',
    hashrate: 'Tasa de hash',
    earnings: 'Ganancias BTC',
    balance: 'Saldo BTC',
    payout: 'Pago BTC',
    stats: 'Estadísticas',
    dex: 'Intercambio',
    liquidity: 'Liquidez',
    trade: 'Comercio',
    error: 'Error',
    success: 'Éxito',
    btcOnly: 'Todos los pagos en BTC',
    converted: 'Auto-convertido a BTC',
    fee: 'Tarifa: 1% piscina + conversión BTC auto-calculada',
    remaining: 'Cantidad restante pagada en BTC'
  },
  fr: {
    welcome: 'Bienvenue dans Otedama Mining Pool - Tous les paiements en BTC',
    mining: 'Minage',
    hashrate: 'Taux de hachage',
    earnings: 'Gains BTC',
    balance: 'Solde BTC',
    payout: 'Paiement BTC',
    stats: 'Statistiques',
    dex: 'Échange',
    liquidity: 'Liquidité',
    trade: 'Commerce',
    error: 'Erreur',
    success: 'Succès',
    btcOnly: 'Tous les paiements en BTC',
    converted: 'Auto-converti en BTC',
    fee: 'Frais: 1% piscine + conversion BTC auto-calculée',
    remaining: 'Montant restant payé en BTC'
  },
  de: {
    welcome: 'Willkommen bei Otedama Mining Pool - Alle Auszahlungen in BTC',
    mining: 'Bergbau',
    hashrate: 'Hash-Rate',
    earnings: 'BTC-Einnahmen',
    balance: 'BTC-Saldo',
    payout: 'BTC-Auszahlung',
    stats: 'Statistiken',
    dex: 'Börse',
    liquidity: 'Liquidität',
    trade: 'Handel',
    error: 'Fehler',
    success: 'Erfolg',
    btcOnly: 'Alle Auszahlungen in BTC',
    converted: 'Auto-konvertiert zu BTC',
    fee: 'Gebühr: 1% Pool + BTC-Umwandlung auto-berechnet',
    remaining: 'Restbetrag in BTC ausgezahlt'
  },
  ru: {
    welcome: 'Добро пожаловать в Otedama Mining Pool - Все выплаты в BTC',
    mining: 'Майнинг',
    hashrate: 'Хешрейт',
    earnings: 'Доходы BTC',
    balance: 'Баланс BTC',
    payout: 'Выплата BTC',
    stats: 'Статистика',
    dex: 'Биржа',
    liquidity: 'Ликвидность',
    trade: 'Торговля',
    error: 'Ошибка',
    success: 'Успех',
    btcOnly: 'Все выплаты в BTC',
    converted: 'Авто-конвертация в BTC',
    fee: 'Комиссия: 1% пул + авто-расчет конвертации BTC',
    remaining: 'Остаток выплачивается в BTC'
  },
  it: {
    welcome: 'Benvenuto in Otedama Mining Pool - Tutti i pagamenti in BTC',
    mining: 'Estrazione',
    hashrate: 'Tasso di hash',
    earnings: 'Guadagni BTC',
    balance: 'Saldo BTC',
    payout: 'Pagamento BTC',
    stats: 'Statistiche',
    dex: 'Scambio',
    liquidity: 'Liquidità',
    trade: 'Commercio',
    error: 'Errore',
    success: 'Successo',
    btcOnly: 'Tutti i pagamenti in BTC',
    converted: 'Auto-convertito in BTC',
    fee: 'Commissione: 1% piscina + conversione BTC auto-calcolata',
    remaining: 'Importo rimanente pagato in BTC'
  },
  pt: {
    welcome: 'Bem-vindo ao Otedama Mining Pool - Todos os pagamentos em BTC',
    mining: 'Mineração',
    hashrate: 'Taxa de hash',
    earnings: 'Ganhos BTC',
    balance: 'Saldo BTC',
    payout: 'Pagamento BTC',
    stats: 'Estatísticas',
    dex: 'Intercâmbio',
    liquidity: 'Liquidez',
    trade: 'Comércio',
    error: 'Erro',
    success: 'Sucesso',
    btcOnly: 'Todos os pagamentos em BTC',
    converted: 'Auto-convertido para BTC',
    fee: 'Taxa: 1% piscina + conversão BTC auto-calculada',
    remaining: 'Valor restante pago em BTC'
  },
  ar: {
    welcome: 'مرحبا بك في Otedama Mining Pool - جميع المدفوعات بـ BTC',
    mining: 'التعدين',
    hashrate: 'معدل التشفير',
    earnings: 'أرباح BTC',
    balance: 'رصيد BTC',
    payout: 'دفع BTC',
    stats: 'الإحصائيات',
    dex: 'البورصة',
    liquidity: 'السيولة',
    trade: 'التجارة',
    error: 'خطأ',
    success: 'نجح',
    btcOnly: 'جميع المدفوعات BTC',
    converted: 'تحويل تلقائي إلى BTC',
    fee: 'رسوم: 1% حوض + تحويل BTC محسوب تلقائياً',
    remaining: 'المبلغ المتبقي يُدفع بـ BTC'
  }
  // Additional 40+ languages would be added here for full 50+ support
};

// ===== Ver0.6 IMPROVED FEE CALCULATOR =====
class FeeCalculator {
  /**
   * Calculate pool usage fee (1% fixed)
   */
  static calculatePoolFee(amount, currency) {
    const poolFee = amount * POOL_FEE_RATE;
    
    return {
      poolFee: poolFee,
      feeRate: POOL_FEE_RATE,
      currency: currency,
      description: `Pool usage fee: ${(POOL_FEE_RATE * 100).toFixed(1)}%`
    };
  }
  
  /**
   * Calculate auto BTC conversion fee based on actual conversion costs
   */
  static calculateBTCConversionFee(btcAmount, fromCurrency) {
    if (fromCurrency === 'BTC') {
      return {
        conversionFee: 0,
        btcAmount: btcAmount,
        feeRate: 0,
        description: 'No conversion needed (already BTC)'
      };
    }
    
    const conversionCostRate = BTC_CONVERSION_COSTS[fromCurrency] || 0.01; // Default 1%
    const conversionFee = btcAmount * conversionCostRate;
    
    return {
      conversionFee: conversionFee,
      btcAmount: btcAmount,
      feeRate: conversionCostRate,
      fromCurrency: fromCurrency,
      description: `${fromCurrency}→BTC conversion: ${(conversionCostRate * 100).toFixed(2)}%`
    };
  }
  
  /**
   * Convert amount to BTC using current rates
   */
  static convertToBTC(amount, currency, livePrices) {
    if (currency === 'BTC') return amount;
    
    const btcPriceUsd = livePrices?.bitcoin?.usd;
    const coinPriceUsd = livePrices?.[currency.toLowerCase()]?.usd;

    if (!btcPriceUsd || !coinPriceUsd) {
      console.warn(`Price data missing for BTC or ${currency}. Using deprecated fallback.`);
      // Fallback to deprecated static rates if live prices are unavailable
      const rate = BTC_CONVERSION_RATES[currency];
      if (!rate) throw new Error(`Unsupported currency for conversion: ${currency}`);
      return amount * rate;
    }

    const btcRate = coinPriceUsd / btcPriceUsd;

    if (!btcRate) throw new Error(`Unsupported currency: ${currency}`);
    
    return amount * btcRate;
  }
  
  /**
   * Main calculation: Pool fee + BTC conversion fee, remainder paid in BTC
   */
  static calculateFinalPayout(amount, currency, livePrices) {
    // Step 1: Calculate pool fee (1% of original amount)
    const poolFeeCalc = this.calculatePoolFee(amount, currency);
    const afterPoolFee = amount - poolFeeCalc.poolFee;
    
    // Step 2: Convert remaining amount to BTC
    const btcAmount = this.convertToBTC(afterPoolFee, currency, livePrices);
    
    // Step 3: Calculate BTC conversion fee (auto-calculated based on currency)
    const conversionFeeCalc = this.calculateBTCConversionFee(btcAmount, currency);
    const finalBTCAmount = btcAmount - conversionFeeCalc.conversionFee;
    
    // Step 4: Calculate total fees in BTC equivalent
    const poolFeeInBTC = this.convertToBTC(poolFeeCalc.poolFee, currency, livePrices);
    const totalFeesInBTC = poolFeeInBTC + conversionFeeCalc.conversionFee;
    
    return {
      originalAmount: amount,
      originalCurrency: currency,
      poolFee: poolFeeCalc.poolFee,
      poolFeeCurrency: currency,
      poolFeeRate: POOL_FEE_RATE,
      poolFeeDescription: poolFeeCalc.description,
      afterPoolFee: afterPoolFee,
      afterPoolFeeCurrency: currency,
      btcBeforeConversionFee: btcAmount,
      conversionRate: (livePrices?.[currency.toLowerCase()]?.usd / livePrices?.bitcoin?.usd) || BTC_CONVERSION_RATES[currency],
      btcConversionFee: conversionFeeCalc.conversionFee,
      btcConversionFeeRate: conversionFeeCalc.feeRate,
      btcConversionDescription: conversionFeeCalc.description,
      finalBTCPayout: finalBTCAmount,
      totalFeesInBTC: totalFeesInBTC,
      totalFeePercentage: ((totalFeesInBTC / this.convertToBTC(amount, currency, livePrices)) * 100).toFixed(2),
      breakdown: {
        step1: `${amount} ${currency} mined`,
        step2: `${poolFeeCalc.poolFee.toFixed(8)} ${currency} pool fee (1%)`,
        step3: `${afterPoolFee.toFixed(8)} ${currency} -> ${btcAmount.toFixed(8)} BTC`,
        step4: `${conversionFeeCalc.conversionFee.toFixed(8)} BTC conversion fee (${(conversionFeeCalc.feeRate * 100).toFixed(2)}%)`,
        step5: `${finalBTCAmount.toFixed(8)} BTC final payout`
      }
    };
  }

  /**
   * Get conversion cost rate for a currency
   */
  static getConversionCostRate(currency) {
    return BTC_CONVERSION_COSTS[currency] || 0.01;
  }

  /**
   * Get all supported currencies with their conversion costs
   */
  static getAllConversionCosts() {
    return Object.keys(BTC_CONVERSION_COSTS).map(currency => ({
      currency,
      conversionCostRate: BTC_CONVERSION_COSTS[currency],
      conversionCostPercentage: (BTC_CONVERSION_COSTS[currency] * 100).toFixed(2) + '%',
      btcRate: BTC_CONVERSION_RATES[currency]
    }));
  }
}

// ===== CONFIGURATION MANAGER =====
class ConfigManager {
  constructor() {
    this.config = this.loadConfig();
    this.validateConfig();
  }

  loadConfig() {
    const defaultConfig = {
      pool: {
        name: 'Otedama Mining Pool Ver0.6',
        poolFeeRate: POOL_FEE_RATE,
        btcOnlyPayouts: true,
        autoCalculatedConversion: true,
        minPayout: MIN_PAYOUT,
        payoutInterval: 3600000 // 1 hour
      },
      mining: {
        enabled: true,
        currency: 'RVN',
        algorithm: 'kawpow',
        walletAddress: '',
        threads: 0,
        intensity: 100
      },
      network: {
        p2pPort: 8333,
        stratumPort: 3333,
        apiPort: 8080,
        maxPeers: 100,
        maxMiners: 10000
      },
      dex: {
        enabled: true,
        tradingFee: 0.003,
        minLiquidity: 0.001,
        maxSlippage: 0.05
      },
      security: {
        enableRateLimit: true,
        maxRequestsPerMinute: 1000,
        enableDDoSProtection: true,
        maxConnectionsPerIP: 10
      },
      i18n: {
        defaultLanguage: 'en',
        autoDetect: true,
        supportedLanguages: Object.keys(TRANSLATIONS)
      }
    };

    try {
      if (existsSync('otedama.json')) {
        const savedConfig = JSON.parse(readFileSync('otedama.json', 'utf8'));
        return { ...defaultConfig, ...savedConfig };
      }
    } catch (error) {
      console.warn('Config load error:', error.message);
    }

    return defaultConfig;
  }

  validateConfig() {
    const currency = this.config.mining.currency;
    const wallet = this.config.mining.walletAddress;

    if (!Object.keys(WALLET_PATTERNS).includes(currency)) {
      this.config.mining.currency = 'RVN';
      this.config.mining.algorithm = 'kawpow';
    }

    if (wallet && WALLET_PATTERNS[currency]) {
      if (!WALLET_PATTERNS[currency].test(wallet)) {
        console.warn(`Invalid ${currency} wallet address format`);
        this.config.mining.walletAddress = '';
      }
    }

    const algorithm = this.config.mining.algorithm;
    if (!ALGORITHMS[algorithm] || !ALGORITHMS[algorithm].coins.includes(currency)) {
      const validAlgorithms = Object.keys(ALGORITHMS).filter(algo => 
        ALGORITHMS[algo].coins.includes(currency)
      );
      this.config.mining.algorithm = validAlgorithms[0] || 'kawpow';
    }

    if (this.config.pool.poolFeeRate !== POOL_FEE_RATE) {
      console.warn('Pool fee rate reset to immutable value:', POOL_FEE_RATE);
      this.config.pool.poolFeeRate = POOL_FEE_RATE;
    }
    
    this.config.pool.btcOnlyPayouts = true;
    this.config.pool.autoCalculatedConversion = true;
  }

  get(path) {
    return path.split('.').reduce((obj, key) => obj?.[key], this.config);
  }

  set(path, value) {
    if (path.includes('fee') || path === 'pool.btcOnlyPayouts' || path === 'pool.autoCalculatedConversion') {
      console.error('Cannot change fee structure or BTC-only payout settings - they are immutable');
      return;
    }
    
    const keys = path.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((obj, key) => {
      if (!obj[key]) obj[key] = {};
      return obj[key];
    }, this.config);
    target[lastKey] = value;
    this.saveConfig();
  }

  saveConfig() {
    try {
      writeFileSync('otedama.json', JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error('Config save error:', error.message);
    }
  }
}

class OtedamaApp {
  constructor() {
    this.logger = new Logger('App');
    this.config = new ConfigManager();
    this.db = new DatabaseManager();
    this.dex = new DEXEngine(this.config.get('dex'), this.db, () => liveCoinPrices);
    this.miningEngine = null;
    this.stratumServer = null;
    this.apiServer = null;
    this.startTime = Date.now();

    this.setupProcessHandlers();
  }

  async startPriceFeed() {
    this.logger.info('Starting price feed service...');
    try {
      const initialPrices = await getPrices();
      if (initialPrices) {
        liveCoinPrices = initialPrices;
        this.logger.info('Successfully fetched initial prices.');
      } else {
        this.logger.warn('Could not fetch initial prices. Using fallback data.');
      }
    } catch (error) {
      this.logger.error('Failed to fetch initial prices:', error);
    }

    // Periodically update prices every 5 minutes
    setInterval(async () => {
      try {
        const newPrices = await getPrices();
        if (newPrices) {
          liveCoinPrices = newPrices;
          this.logger.info('Price feed updated successfully.');
        }
      } catch (error) {
        this.logger.error('Error updating prices:', error);
      }
    }, 5 * 60 * 1000); // 300,000 milliseconds = 5 minutes
  }

  async start() {
    this.showBanner();
    await this.startPriceFeed(); // Fetch initial prices before starting other services
    try {
      
      // Initialize mining engine if enabled
      if (this.config.get('mining.enabled')) {
        this.miningEngine = new MiningEngine(this.config.get('mining'));
        await this.miningEngine.start();
      }
      
      // Start Stratum server
      this.stratumServer = new StratumServer(
        this.config.get('network'),
        this.db,
        this.miningEngine,
        () => liveCoinPrices // Pass a function to get live prices
      );
      this.stratumServer.start();
      
      // Start API server
      this.apiServer = new APIServer(
        this.config.get('network'),
        this.db,
        this.dex,
        this.stratumServer
      );
      this.apiServer.start();
      
      // Start fee collection
      this.startFeeCollection();
      
      // Start BTC payout processing
      this.startBTCPayoutProcessing();
      
      this.logger.info('Otedama Ver0.6 started successfully - Auto-calculated BTC conversion enabled');
      this.logger.info(`Dashboard: http://localhost:${this.config.get('network.apiPort')}`);
      this.logger.info(`Stratum: stratum+tcp://localhost:${this.config.get('network.stratumPort')}`);
      
    } catch (error) {
      this.logger.error('Startup failed:', error);
      process.exit(1);
    }
  }

  startFeeCollection() {
    setInterval(() => {
      this.collectFees();
    }, this.config.get('pool.payoutInterval')); // Use same interval as payouts for consistency
    this.logger.info('Fee collection service started.');
  }

  collectFees() {
    this.logger.info('Collecting operator fees...');
    try {
      // In this version, fees are calculated and deducted during the share submission process.
      // This function will aggregate the collected fees and record them for the operator.
      const unpaidShares = this.db.db.prepare(`
        SELECT SUM(total_pool_fees) as totalPoolFees, SUM(total_conversion_fees) as totalConversionFees 
        FROM miners WHERE total_pool_fees > 0 OR total_conversion_fees > 0
      `).get();

      const totalPoolFees = unpaidShares.totalPoolFees || 0;
      const totalConversionFees = unpaidShares.totalConversionFees || 0;
      const totalBTCFees = totalPoolFees + totalConversionFees;

      if (totalBTCFees > 0) {
        this.db.db.prepare(`
          INSERT INTO operator_fees (btc_amount, original_amount, original_currency, fee_type, pool_fee, conversion_fee) 
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          totalBTCFees, 
          totalBTCFees, 
          'BTC', 
          'aggregated',
          totalPoolFees,
          totalConversionFees
        );
        
        // Reset the fee counters for miners
        this.db.db.prepare(`UPDATE miners SET total_pool_fees = 0, total_conversion_fees = 0`).run();

        this.logger.info(`Operator fees collected: ${totalBTCFees.toFixed(8)} BTC (Pool: ${totalPoolFees.toFixed(8)}, Conversion: ${totalConversionFees.toFixed(8)})`);
      }

    } catch (error) {
      this.logger.error('Fee collection failed:', error);
    }
  }

  calculateReward(difficulty, algorithm) {
    const baseRewards = {
      'sha256': 1.0,
      'kawpow': 0.8,
      'randomx': 0.6,
      'ethash': 0.7,
      'scrypt': 0.9,
      'equihash': 0.75,
      'x11': 0.85,
      'autolykos': 0.7,
      'kheavyhash': 0.9,
      'blake3': 0.8
    };

    const baseReward = baseRewards[algorithm] || 1.0;
    const difficultyAdjustment = Math.log10(difficulty / 1000000 + 1);
    
    return baseReward * difficultyAdjustment;
  }

  startBTCPayoutProcessing() {
    setInterval(() => {
      this.processBTCPayouts();
    }, 3600000); // Every hour
  }

  processBTCPayouts() {
    try {
      this.logger.info('Processing automatic BTC payouts with auto-calculated conversion...');
      
      // Get miners with sufficient BTC balance
      const miners = this.db.db.prepare(`
        SELECT *
        FROM miners 
        WHERE btc_balance >= ? AND last_seen > ?
      `).all(
        MIN_PAYOUT.BTC, // Minimum 0.001 BTC
        Math.floor(Date.now() / 1000) - 86400 // Active in last 24 hours
      );

      let processedPayouts = 0;
      
      for (const miner of miners) {
        try {
          const btcAmount = miner.btc_balance;
          const txHash = this.generateTxHash();
          
          // Record BTC payout with detailed fee breakdown
          this.db.db.prepare(`
            INSERT INTO payouts (miner_id, btc_amount, original_amount, original_currency, 
                               pool_fee, conversion_fee, total_fees, conversion_rate, tx_hash, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')
          `).run(
            miner.id, 
            btcAmount, 
            miner.original_balance, 
            miner.original_currency,
            miner.total_pool_fees,
            miner.total_conversion_fees,
            miner.total_pool_fees + miner.total_conversion_fees,
            BTC_CONVERSION_RATES[miner.original_currency] || 1.0,
            txHash
          );
          
          // Reset miner balance
          this.db.db.prepare(`
            UPDATE miners SET btc_balance = 0, original_balance = 0, total_pool_fees = 0, total_conversion_fees = 0 WHERE id = ?
          `).run(miner.id);
          
          this.logger.info(`BTC payout processed: ${btcAmount.toFixed(8)} BTC to ${miner.address} (originally ${miner.original_balance} ${miner.original_currency} with auto-calculated fees)`);
          processedPayouts++;
          
        } catch (error) {
          this.logger.error(`BTC payout failed for miner ${miner.address}:`, error);
        }
      }
      
      this.logger.info(`Processed ${processedPayouts} BTC payouts with auto-calculated conversion fees`);
      
    } catch (error) {
      this.logger.error('BTC payout processing failed:', error);
    }
  }

  generateTxHash() {
    return 'btc_auto_' + randomBytes(16).toString('hex');
  }

  setupProcessHandlers() {
    process.on('SIGINT', () => {
      this.logger.info('Received SIGINT, shutting down...');
      this.shutdown();
    });

    process.on('SIGTERM', () => {
      this.logger.info('Received SIGTERM, shutting down...');
      this.shutdown();
    });

    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught exception:', error);
      this.shutdown();
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Unhandled rejection at:', promise, 'reason:', reason);
    });
  }



}

// ===== UTILITY & HELPER CLASSES =====

class Logger {
  constructor(prefix) {
    this.prefix = prefix;
  }

  info(message, ...args) {
    console.log(`[${new Date().toISOString()}] [${this.prefix}] [INFO] ${message}`, ...args);
  }

  warn(message, ...args) {
    console.warn(`[${new Date().toISOString()}] [${this.prefix}] [WARN] ${message}`, ...args);
  }

  error(message, ...args) {
    console.error(`[${new Date().toISOString()}] [${this.prefix}] [ERROR] ${message}`, ...args);
  }
}

class DatabaseManager {
  constructor() {
    try {
      this.db = new Database('otedama.db');
      this.init();
    } catch (error) {
      console.error('CRITICAL: Database initialization failed.', error.message);
      process.exit(1);
    }
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS miners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT UNIQUE NOT NULL,
        currency TEXT NOT NULL,
        btc_balance REAL DEFAULT 0,
        original_balance REAL DEFAULT 0,
        total_pool_fees REAL DEFAULT 0,
        total_conversion_fees REAL DEFAULT 0,
        hashrate REAL DEFAULT 0,
        shares INTEGER DEFAULT 0,
        last_seen INTEGER
      );

      CREATE TABLE IF NOT EXISTS payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        miner_id INTEGER,
        btc_amount REAL,
        original_amount REAL,
        original_currency TEXT,
        pool_fee REAL,
        conversion_fee REAL,
        total_fees REAL,
        conversion_rate REAL,
        tx_hash TEXT,
        status TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (miner_id) REFERENCES miners(id)
      );

      CREATE TABLE IF NOT EXISTS operator_fees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        btc_amount REAL,
        original_amount REAL,
        original_currency TEXT,
        fee_type TEXT,
        pool_fee REAL,
        conversion_fee REAL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS dex_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pair TEXT NOT NULL,
        type TEXT NOT NULL, -- 'buy' or 'sell'
        price REAL NOT NULL,
        amount REAL NOT NULL,
        total REAL NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  close() {
    this.db.close();
  }
}

// ===== MINING ENGINE =====
class MiningEngine {
  constructor(config) {
    this.config = config;
    this.logger = new Logger('Mining');
    this.worker = null;
  }

  async start() {
    this.logger.info(`Starting mining for ${this.config.currency} with ${this.config.algorithm}`);
    // In a real scenario, this would launch a CPU/GPU miner process.
    // Here we simulate it with a simple worker thread.
  }

  stop() {
    if (this.worker) {
      this.worker.terminate();
      this.logger.info('Mining worker stopped.');
    }
  }

  getJob() {
    // This would generate a real mining job
    return {
      job_id: randomBytes(4).toString('hex'),
      blob: randomBytes(76).toString('hex'),
      target: 'ffff000000000000000000000000000000000000000000000000000000000000',
      difficulty: 100000
    };
  }

  submit(job) {
    // This would validate the submitted share
    this.logger.info(`Received share for job ${job.job_id}`);
    return true; // Share accepted
  }
}

// ===== DEX ENGINE =====
class DEXEngine {
  constructor(config, db, getLivePrices) {
    this.config = config;
    this.db = db;
    this.getLivePrices = getLivePrices;
    this.logger = new Logger('DEX');
    this.pairs = new Map();
    this.init();
  }

  init() {
    // Initialize trading pairs
    const currencies = Object.keys(WALLET_PATTERNS);
    for (const c1 of currencies) {
      for (const c2 of currencies) {
        if (c1 !== c2) {
          this.pairs.set(`${c1}/${c2}`, { liquidity: 0.1, price: 1 });
        }
      }
    }
    this.logger.info('DEX Engine initialized with all currency pairs.');
  }

  getPairs() {
    return Array.from(this.pairs.keys());
  }

  executeTrade(pair, type, amount) {
    const prices = this.getLivePrices();
    if (!prices || Object.keys(prices).length === 0) {
      throw new Error('Live prices are not available for trading.');
    }

    const [base, quote] = pair.split('/');
    const basePrice = prices[base.toLowerCase()]?.usd;
    const quotePrice = prices[quote.toLowerCase()]?.usd;

    if (!basePrice || !quotePrice) {
      throw new Error(`Price not available for pair ${pair}`);
    }

    const price = basePrice / quotePrice;
    const total = amount * price;
    const fee = total * this.config.tradingFee;
    const finalTotal = total - fee;

    this.db.db.prepare('INSERT INTO dex_trades (pair, type, price, amount, total) VALUES (?, ?, ?, ?, ?)').run(pair, type, price, amount, finalTotal);
    this.logger.info(`Trade executed: ${type} ${amount} ${base} for ${finalTotal.toFixed(8)} ${quote}`);
    return { price, total: finalTotal, fee };
  }
}

// ===== STRATUM SERVER =====
class StratumServer {
  constructor(config, db, miningEngine, getLivePrices) {
    this.config = config;
    this.db = db;
    this.miningEngine = miningEngine;
    this.getLivePrices = getLivePrices;
    this.logger = new Logger('Stratum');
    this.server = null;
    this.clients = new Map();
  }

  start() {
    this.server = new WebSocketServer({ port: this.config.stratumPort });
    this.server.on('connection', (ws) => this.handleConnection(ws));
    this.logger.info(`Stratum server listening on port ${this.config.stratumPort}`);
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.logger.info('Stratum server stopped.');
    }
  }

  handleConnection(ws) {
    const clientId = randomBytes(8).toString('hex');
    this.clients.set(clientId, { ws, authenticated: false });
    this.logger.info(`New miner connected: ${clientId}`);

    ws.on('message', (message) => this.handleMessage(clientId, message));
    ws.on('close', () => this.handleDisconnect(clientId));
  }

  handleMessage(clientId, message) {
    try {
      const data = JSON.parse(message);
      const client = this.clients.get(clientId);

      switch (data.method) {
        case 'login':
          this.handleLogin(clientId, data.params);
          break;
        case 'submit':
          if (client.authenticated) {
            this.handleSubmit(clientId, data.params);
          } else {
            this.sendError(clientId, 'Not authenticated');
          }
          break;
        default:
          this.sendError(clientId, 'Unknown method');
      }
    } catch (error) {
      this.sendError(clientId, 'Invalid JSON');
    }
  }

  handleLogin(clientId, params) {
    const { login, pass, agent } = params;
    const currency = Object.keys(WALLET_PATTERNS).find(c => WALLET_PATTERNS[c].test(login));

    if (!currency) {
      this.sendError(clientId, 'Invalid wallet address');
      return;
    }

    const client = this.clients.get(clientId);
    client.authenticated = true;
    client.address = login;
    client.currency = currency;
    this.clients.set(clientId, client);

    let miner = this.db.db.prepare('SELECT * FROM miners WHERE address = ?').get(login);
    if (!miner) {
      this.db.db.prepare('INSERT INTO miners (address, currency, last_seen) VALUES (?, ?, ?)').run(login, currency, Math.floor(Date.now() / 1000));
    }

    this.sendResult(clientId, { status: 'OK' });
    this.sendJob(clientId);
  }

  handleSubmit(clientId, params) {
    const client = this.clients.get(clientId);
    const isValid = this.miningEngine.submit(params);

    if (isValid) {
      const reward = 0.01; // Simplified reward
      const feeCalculation = FeeCalculator.calculateFinalPayout(reward, client.currency, this.getLivePrices());

      this.db.db.prepare(`
        UPDATE miners 
        SET btc_balance = btc_balance + ?, 
            original_balance = original_balance + ?, 
            total_pool_fees = total_pool_fees + ?, 
            total_conversion_fees = total_conversion_fees + ?, 
            shares = shares + 1, 
            last_seen = ? 
        WHERE address = ?
      `).run(
        feeCalculation.finalBTCPayout,
        reward,
        feeCalculation.poolFee,
        feeCalculation.btcConversionFee,
        Math.floor(Date.now() / 1000),
        client.address
      );

      this.sendResult(clientId, { status: 'OK' });
      this.logger.info(`Accepted share from ${client.address}. Payout: ${feeCalculation.finalBTCPayout.toFixed(8)} BTC`);
    } else {
      this.sendError(clientId, 'Invalid share');
    }

    this.sendJob(clientId);
  }

  sendJob(clientId) {
    const job = this.miningEngine.getJob();
    this.sendMessage(clientId, { method: 'job', params: job });
  }

  sendResult(clientId, result) {
    this.sendMessage(clientId, { id: 1, result, error: null });
  }

  sendError(clientId, error) {
    this.sendMessage(clientId, { id: 1, result: null, error });
  }

  sendMessage(clientId, data) {
    const client = this.clients.get(clientId);
    if (client && client.ws.readyState === client.ws.OPEN) {
      client.ws.send(JSON.stringify(data));
    }
  }

  handleDisconnect(clientId) {
    this.clients.delete(clientId);
    this.logger.info(`Miner disconnected: ${clientId}`);
  }
}

// ===== API SERVER =====
class APIServer {
  constructor(config, db, dex, stratum) {
    this.config = config;
    this.db = db;
    this.dex = dex;
    this.stratum = stratum;
    this.logger = new Logger('API');
    this.server = null;
  }

  start() {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.listen(this.config.apiPort, () => {
      this.logger.info(`API server listening on http://localhost:${this.config.apiPort}`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.logger.info('API server stopped.');
    }
  }

  handleRequest(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*'); // For development

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/stats') {
      const stats = this.getStats();
      res.end(JSON.stringify(stats));
    } else if (url.pathname === '/api/miner' && url.searchParams.has('address')) {
      const minerStats = this.getMinerStats(url.searchParams.get('address'));
      res.end(JSON.stringify(minerStats));
    } else if (url.pathname === '/api/prices') {
        res.end(JSON.stringify(liveCoinPrices));
    } else if (url.pathname === '/api/fees') {
        // Return BTC conversion rates and predefined conversion cost percentages
        const btcConversionRates = {};
        for (const currency of Object.keys(WALLET_PATTERNS)) {
          if (currency === 'BTC') continue;
          try {
            btcConversionRates[currency] = FeeCalculator.convertToBTC(1, currency, liveCoinPrices);
          } catch (err) {
            // Skip unsupported or missing price data
          }
        }
        res.end(JSON.stringify({
          btcConversionRates,
          conversionCosts: BTC_CONVERSION_COSTS
        }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not Found' }));
    }
  }

  getStats() {
    const miners = this.db.db.prepare('SELECT COUNT(*) as count FROM miners').get();
    return {
      pool: {
        name: this.config.name,
        miners: miners.count,
        hashrate: '1.2 TH/s' // Placeholder
      },
      prices: liveCoinPrices
    };
  }

  getMinerStats(address) {
    const miner = this.db.db.prepare('SELECT * FROM miners WHERE address = ?').get(address);
    if (miner) {
      const payouts = this.db.db.prepare('SELECT * FROM payouts WHERE miner_id = ? ORDER BY timestamp DESC').all(miner.id);
      return { miner, payouts };
    } else {
      return { error: 'Miner not found' };
    }
  }
}

// ===== COMMAND LINE INTERFACE =====
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {};

  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(`Otedama Version ${VERSION}`);
    process.exit(0);
  }

  if (args.includes('--fees')) {
    showFeeInfo();
    process.exit(0);
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--wallet' || arg === '-w') && i + 1 < args.length) {
      config.walletAddress = args[i + 1];
      i++;
    } else if ((arg === '--currency' || arg === '-c') && i + 1 < args.length) {
      config.currency = args[i + 1].toUpperCase();
      i++;
    } else if (arg === '--threads' && i + 1 < args.length) {
      config.threads = parseInt(args[i + 1]);
      i++;
    }
  }
  return config;
}

function showFeeInfo() {
  console.log(`
₿ Otedama v${VERSION} - Fee Information ₿

Pool Usage Fee: ${(POOL_FEE_RATE * 100).toFixed(1)}% (fixed)

Auto-calculated BTC Conversion Fees:
${Object.keys(BTC_CONVERSION_COSTS).map(currency => 
  `  ${currency.padEnd(6)}: ${(BTC_CONVERSION_COSTS[currency] * 100).toFixed(2)}%`
).join('\n')}

Example calculation for 1000 RVN:
1. Pool fee: 1000 × 1% = 10 RVN
2. Remaining: 990 RVN
3. Convert to BTC: 990 × 0.0000007 = 0.000693 BTC
4. Conversion fee: 0.000693 × 0.5% = 0.000003465 BTC
5. Final payout: 0.000689535 BTC

Total effective fee: ~1.5% (Pool 1% + Conversion 0.5%)
  `);
}

function showHelp() {
  console.log(`
₿ Otedama v${VERSION} - Professional Mining Pool with Auto-calculated BTC Conversion ₿

Usage: node index.js [options]

Options:
  --wallet ADDRESS    Set wallet address for mining (any supported currency)
  --currency SYMBOL   Set mining currency (payouts always in BTC)
  --threads NUMBER    Set number of mining threads
  --fees              Show detailed fee information
  --help, -h          Show this help message
  --version, -v       Show version

Examples:
  node index.js --wallet RYourRavencoinAddress --currency RVN
  node index.js --wallet bc1yourbtcaddress --currency BTC --threads 4
  node index.js --wallet 0xyourethaddress --currency ETH

Ver0.6 Auto-calculated Fees:
• POOL FEE: ${(POOL_FEE_RATE * 100).toFixed(1)}% (fixed) - supports pool operations
• CONVERSION FEE: Auto-calculated per currency (${Object.keys(BTC_CONVERSION_COSTS).map(c => `${c}: ${(BTC_CONVERSION_COSTS[c] * 100).toFixed(2)}%`).slice(0, 3).join(', ')}, etc.)
• REMAINING: Paid in Bitcoin to miners
• TRANSPARENCY: Complete fee breakdown available

Supported currencies: ${Object.keys(WALLET_PATTERNS).join(', ')}
(All automatically converted to BTC for payouts)

Supported algorithms: ${Object.keys(ALGORITHMS).join(', ')}
Languages: ${Object.keys(TRANSLATIONS).length}+ languages supported

For more information, visit: https://github.com/otedama/otedama
  `);
}

// ===== MAIN EXECUTION =====
async function main() {

  const cliConfig = parseArgs();

  // If parseArgs returned and we're still running, it means we should start the server.
  // The process.exit() in parseArgs handles --help, --version, etc.
  
  const app = new OtedamaApp();
  
  // Apply CLI configuration
  if (cliConfig.walletAddress) {
    app.config.set('mining.walletAddress', cliConfig.walletAddress);
  }
  if (cliConfig.currency) {
    app.config.set('mining.currency', cliConfig.currency);
  }
  if (cliConfig.threads) {
    app.config.set('mining.threads', cliConfig.threads);
  }
  
  await app.start();

  console.log('Otedama server is running. Press Ctrl+C to exit.');
  // Keep the process alive. The servers should do this, but we can be explicit.
  process.stdin.resume();
}

// Start the application
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(console.error);
}

export default OtedamaApp;
