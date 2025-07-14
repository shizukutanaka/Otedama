import * as fs from 'fs';
import { WALLET_PATTERNS, COIN_INFO, ALGO_CONFIG, BTC_CONVERSION_RATES, POOL_CONSTANTS } from './constants.js';

export class ConfigManager {
  constructor() {
    this.file = 'otedama.json';
    this.data = this.load();
    this.validate();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        return { ...this.defaults(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
      }
    } catch (e) { console.warn('Config load error:', e.message); }
    return this.defaults();
  }

  defaults() {
    return {
      pool: { 
        name: 'Otedama Pool', 
        fee: POOL_CONSTANTS.FEE_RATE * 100, // 1.4% IMMUTABLE
        minPayout: {
          // Bitcoin Family
          BTC: 0.001, BCH: 0.01, BSV: 0.01, BTG: 0.1,
          // Ethereum Family  
          ETH: 0.01, ETC: 0.1, ETHW: 1, ETHF: 10,
          // Popular Altcoins
          RVN: 100, XMR: 0.1, LTC: 0.1, DOGE: 100,
          ZEC: 0.01, DASH: 0.01,
          // Modern GPU Coins
          ERGO: 1, FLUX: 1, NEXA: 1000000, KAS: 100, ALPH: 1,
          // Others
          XTZ: 1, ZEN: 0.1, CFX: 10, FIRO: 1, VTC: 1,
          // Emerging
          CLORE: 100, NEURAI: 1000, PEPEW: 1000000
        },
        payoutInterval: 3600000,
        autoSwitching: {
          enabled: true,
          profitabilityThreshold: 10, // Switch if >10% more profitable
          switchCooldown: 300000 // 5 minutes cooldown
        }
      },
      mining: { 
        enabled: true, 
        currency: 'RVN', // Default to popular GPU coin
        algorithm: 'kawpow', 
        walletAddress: '', 
        threads: 0,
        intensity: 100,
        autoTune: true,
        multiCurrency: {
          enabled: false,
          currencies: ['RVN', 'ERGO', 'FLUX'], // Multi-currency mining
          switchInterval: 3600000 // 1 hour
        }
      },
      network: { 
        p2pPort: 8333, 
        stratumPort: 3333, 
        apiPort: 8080, 
        maxPeers: 100,
        maxMiners: 10000,
        stratumPorts: {
          // Different ports for different algorithms
          sha256: 3333,    // BTC, BCH, BSV
          kawpow: 3334,    // RVN
          ethash: 3335,    // ETH, ETC, ETHW, ETHF
          randomx: 3336,   // XMR
          scrypt: 3337,    // LTC, DOGE
          equihash: 3338,  // ZEC, FLUX, ZEN
          x11: 3339,       // DASH
          autolykos: 3340, // ERGO
          kheavyhash: 3341,// KAS
          blake3: 3342,    // ALPH
          nexapow: 3343,   // NEXA
          octopus: 3344,   // CFX
          firopow: 3345,   // FIRO
          lyra2rev3: 3346  // VTC
        }
      },
      dex: { 
        enabled: true, 
        tradingFee: 0.3,
        minLiquidity: 0.001,
        maxSlippage: 5.0,
        supportedPairs: [
          // Major pairs
          'BTC-USDT', 'ETH-USDT', 'BCH-USDT', 'LTC-USDT',
          // GPU coins
          'RVN-USDT', 'ERGO-USDT', 'FLUX-USDT', 'KAS-USDT', 'ALPH-USDT',
          // Privacy coins
          'XMR-USDT', 'ZEC-USDT', 'DASH-USDT', 'FIRO-USDT',
          // Cross pairs
          'ETH-BTC', 'BCH-BTC', 'LTC-BTC', 'RVN-BTC',
          // ETC pairs
          'ETC-USDT', 'ETC-BTC'
        ]
      },
      currencies: {
        supported: Object.keys(COIN_INFO),
        categories: {
          popular: ['BTC', 'ETH', 'RVN', 'LTC', 'XMR', 'ERGO', 'FLUX', 'KAS'],
          gpu: ['RVN', 'ETH', 'ETC', 'ERGO', 'FLUX', 'KAS', 'ALPH', 'NEXA', 'CFX'],
          cpu: ['XMR'],
          asic: ['BTC', 'BCH', 'BSV', 'LTC', 'DOGE', 'DASH'],
          privacy: ['XMR', 'ZEC', 'DASH', 'FIRO'],
          emerging: ['CLORE', 'NEURAI', 'PEPEW', 'ETHW', 'ETHF']
        },
        algorithms: Object.keys(ALGO_CONFIG),
        conversionRates: BTC_CONVERSION_RATES
      },
      profitability: {
        enabled: true,
        updateInterval: 300000, // 5 minutes
        sources: [
          'whattomine.com',
          'coinwarz.com',
          'crypto-coinz.net'
        ],
        factors: {
          difficulty: 0.4,
          price: 0.4,
          volume: 0.2
        }
      },
      security: {
        enableRateLimit: true,
        maxRequestsPerMinute: 1000,
        enableAuth: false,
        apiKey: '',
        enableDDoSProtection: true,
        maxConnectionsPerIP: 100,
        currencyValidation: {
          enabled: true,
          strictMode: true
        }
      },
      monitoring: {
        enableMetrics: true,
        metricsPort: 9090,
        alertThresholds: {
          cpuUsage: 90,
          memoryUsage: 85,
          minerDisconnectRate: 20,
          profitabilityDrop: 30
        },
        currencyMetrics: {
          trackProfitability: true,
          trackHashrate: true,
          trackDifficulty: true
        }
      },
      tuning: {
        enabled: true,
        interval: 300000,
        aggressive: false,
        algorithmOptimization: {
          enabled: true,
          perAlgorithm: true
        }
      },
      operatorFees: {
        address: '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa',
        rate: 0.001, // 0.1% fixed
        collectionInterval: 300000, // 5 minutes
        minimumCollection: 0.001, // 0.001 BTC
        autoConversion: true,
        conversionPairs: BTC_CONVERSION_RATES,
        immutable: true
      },
      rpc: {
        // Example RPC configurations for major currencies
        btc: { enabled: false, url: 'http://localhost:8332', timeout: 30000 },
        eth: { enabled: false, url: 'http://localhost:8545', timeout: 30000 },
        bch: { enabled: false, url: 'http://localhost:8232', timeout: 30000 },
        ltc: { enabled: false, url: 'http://localhost:9332', timeout: 30000 },
        rvn: { enabled: false, url: 'http://localhost:8766', timeout: 30000 },
        xmr: { enabled: false, url: 'http://localhost:18081', timeout: 30000 },
        zec: { enabled: false, url: 'http://localhost:8232', timeout: 30000 },
        etc: { enabled: false, url: 'http://localhost:8545', timeout: 30000 }
      },
      explorers: {
        // Blockchain explorers for each currency
        BTC: 'https://blockstream.info/api',
        ETH: 'https://api.etherscan.io/api',
        BCH: 'https://api.blockchair.com/bitcoin-cash',
        LTC: 'https://chainz.cryptoid.info/ltc/api.dws',
        RVN: 'https://ravencoin.network/api',
        XMR: 'https://xmrchain.net/api',
        ZEC: 'https://api.zcha.in',
        ETC: 'https://blockscout.com/etc/mainnet/api',
        DOGE: 'https://dogechain.info/api/v1',
        DASH: 'https://chainz.cryptoid.info/dash/api.dws',
        ERGO: 'https://api.ergoplatform.com',
        FLUX: 'https://explorer.runonflux.io/api',
        KAS: 'https://api.kaspa.org',
        ALPH: 'https://backend.alephium.org'
      }
    };
  }

  validate() {
    const currency = this.data.mining.currency;
    const wallet = this.data.mining.walletAddress;
    
    // Validate currency is supported
    if (!COIN_INFO[currency]) {
      console.warn(`Unsupported currency: ${currency}, switching to RVN`);
      this.data.mining.currency = 'RVN';
      this.data.mining.algorithm = 'kawpow';
    }
    
    // Validate wallet address format
    if (wallet && WALLET_PATTERNS[currency]) {
      if (!WALLET_PATTERNS[currency].test(wallet)) {
        console.warn(`Invalid ${currency} wallet address format`);
        this.data.mining.walletAddress = '';
      }
    }
    
    // Validate algorithm matches currency
    const validAlgos = this.getValidAlgorithmsForCurrency(currency);
    if (!validAlgos.includes(this.data.mining.algorithm)) {
      this.data.mining.algorithm = validAlgos[0];
      console.log(`Algorithm adjusted to ${this.data.mining.algorithm} for ${currency}`);
    }
    
    // Ensure min payout exists for currency
    if (!this.data.pool.minPayout[currency]) {
      this.data.pool.minPayout[currency] = COIN_INFO[currency]?.minPayout || 1;
    }
    
    // Validate operator fee settings (immutable)
    if (this.data.operatorFees.address !== '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa') {
      console.warn('Operator address reset to immutable value');
      this.data.operatorFees.address = '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa';
    }
    
    if (this.data.operatorFees.rate !== 0.001) {
      console.warn('Operator fee rate reset to immutable value (0.1%)');
      this.data.operatorFees.rate = 0.001;
    }
    
    // Validate pool fee settings (immutable)
    if (this.data.pool.fee !== POOL_CONSTANTS.FEE_RATE * 100) {
      console.warn(`Pool fee rate reset to immutable value (${POOL_CONSTANTS.FEE_RATE * 100}%)`);
      this.data.pool.fee = POOL_CONSTANTS.FEE_RATE * 100;
    }
  }

  getValidAlgorithmsForCurrency(currency) {
    const algorithms = [];
    for (const [algo, config] of Object.entries(ALGO_CONFIG)) {
      if (config.coins.includes(currency)) {
        algorithms.push(algo);
      }
    }
    return algorithms.length > 0 ? algorithms : ['kawpow']; // Default fallback
  }

  getSupportedCurrencies() {
    return Object.keys(COIN_INFO);
  }

  getCurrencyInfo(currency) {
    return COIN_INFO[currency] || null;
  }

  getAlgorithmInfo(algorithm) {
    return ALGO_CONFIG[algorithm] || null;
  }

  getBTCConversionRate(currency) {
    return BTC_CONVERSION_RATES[currency] || 0.000001;
  }

  isCurrencySupported(currency) {
    return !!COIN_INFO[currency];
  }

  isAlgorithmSupported(algorithm) {
    return !!ALGO_CONFIG[algorithm];
  }

  setCurrency(currency, updateAlgorithm = true) {
    if (!this.isCurrencySupported(currency)) {
      throw new Error(`Unsupported currency: ${currency}`);
    }
    
    this.data.mining.currency = currency;
    
    if (updateAlgorithm) {
      const validAlgos = this.getValidAlgorithmsForCurrency(currency);
      this.data.mining.algorithm = validAlgos[0];
    }
    
    this.save();
  }

  setWallet(walletAddress) {
    const currency = this.data.mining.currency;
    
    if (!WALLET_PATTERNS[currency]) {
      throw new Error(`No wallet pattern defined for ${currency}`);
    }
    
    if (!WALLET_PATTERNS[currency].test(walletAddress)) {
      throw new Error(`Invalid ${currency} wallet address format`);
    }
    
    this.data.mining.walletAddress = walletAddress;
    this.save();
  }

  enableMultiCurrency(currencies) {
    // Validate all currencies are supported
    for (const currency of currencies) {
      if (!this.isCurrencySupported(currency)) {
        throw new Error(`Unsupported currency in multi-currency setup: ${currency}`);
      }
    }
    
    this.data.mining.multiCurrency.enabled = true;
    this.data.mining.multiCurrency.currencies = currencies;
    this.save();
  }

  getStratumPortForAlgorithm(algorithm) {
    return this.data.network.stratumPorts[algorithm] || this.data.network.stratumPort;
  }

  getProfitabilitySources() {
    return this.data.profitability.sources || [];
  }

  get(path) { 
    return path.split('.').reduce((obj, key) => obj?.[key], this.data); 
  }

  set(path, value) {
    // Block attempts to change immutable values
    if (path === 'pool.fee') {
      console.error('Cannot change pool fee - it is immutable (1.4%)');
      return;
    }
    if (path === 'operatorFees.address' || path === 'operatorFees.rate') {
      console.error('Cannot change operator fee settings - they are immutable');
      return;
    }
    
    const keys = path.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((obj, key) => {
      if (!obj[key]) obj[key] = {};
      return obj[key];
    }, this.data);
    target[lastKey] = value;
    this.save();
  }

  save() {
    try {
      // Re-validate before saving
      this.validate();
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) { 
      console.error('Config save error:', e.message); 
    }
  }

  // Get currencies by category
  getCurrenciesByCategory(category) {
    return this.data.currencies.categories[category] || [];
  }

  // Get most profitable currency (mock implementation)
  getMostProfitableCurrency(hashrates = {}) {
    // In production, this would calculate actual profitability
    // For now, return a popular GPU-friendly coin
    const gpuCoins = this.getCurrenciesByCategory('gpu');
    return gpuCoins[0] || 'RVN';
  }

  // Export configuration for backup
  export() {
    return {
      ...this.data,
      exportedAt: new Date().toISOString(),
      version: '6.0.0'
    };
  }

  // Import configuration from backup
  import(configData) {
    if (configData.version !== '6.0.0') {
      console.warn('Configuration version mismatch, some features may not work');
    }
    
    this.data = { ...this.defaults(), ...configData };
    this.validate();
    this.save();
  }
}
