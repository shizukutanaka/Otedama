/**
 * Otedama v6.0.0 - Commercial Grade Component
 * Optimized for production deployment
 * Part of the automated mining pool & DeFi ecosystem
 */

// Wallet address patterns for validation (大幅拡張)
export const WALLET_PATTERNS = {
  // Bitcoin Family
  BTC: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$/,
  BCH: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bitcoincash:[a-z0-9]{42}$|^q[a-z0-9]{41}$/,
  BSV: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/,
  BTG: /^[AG][a-km-zA-HJ-NP-Z1-9]{33}$/,
  
  // Ethereum Family
  ETH: /^0x[a-fA-F0-9]{40}$/,
  ETC: /^0x[a-fA-F0-9]{40}$/,
  ETHW: /^0x[a-fA-F0-9]{40}$/,
  ETHF: /^0x[a-fA-F0-9]{40}$/,
  
  // Ravencoin Family
  RVN: /^R[a-km-zA-HJ-NP-Z1-9]{33}$/,
  
  // Monero Family
  XMR: /^4[0-9AB][0-9a-zA-Z]{93}$/,
  
  // Litecoin Family
  LTC: /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$|^ltc1[a-z0-9]{39,59}$/,
  DOGE: /^D{1}[5-9A-HJ-NP-U]{1}[1-9A-HJ-NP-Za-km-z]{32}$/,
  
  // Privacy Coins
  ZEC: /^t1[a-km-zA-HJ-NP-Z1-9]{33}$|^t3[a-km-zA-HJ-NP-Z1-9]{33}$/,
  DASH: /^X[a-km-zA-HJ-NP-Z1-9]{33}$/,
  
  // Modern Algorithms
  ERGO: /^9[a-km-zA-HJ-NP-Z1-9]{50,}$/,
  FLUX: /^t1[a-km-zA-HJ-NP-Z1-9]{33}$/,
  NEXA: /^nexa:[a-z0-9]{42,}$|^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/,
  KAS: /^kaspa:[a-z0-9]{61,63}$|^[a-z0-9]{61,63}$/,
  ALPH: /^[a-zA-Z0-9]{58}$/,
  
  // Other Popular Coins
  XTZ: /^tz[1-3][a-km-zA-HJ-NP-Z1-9]{33}$/,
  ZEN: /^zn[a-km-zA-HJ-NP-Z1-9]{33}$/,
  BEAM: /^[a-f0-9]{64}$/,
  GRIN: /^[a-f0-9]{56}$/,
  
  // GPU-Friendly Coins
  FIRO: /^a[a-km-zA-HJ-NP-Z1-9]{33}$/,
  VTC: /^V[a-km-zA-HJ-NP-Z1-9]{33}$/,
  CFX: /^cfx:[a-z0-9]{42}$|^0x[a-fA-F0-9]{40}$/,
  
  // Newer Coins
  CLORE: /^C[a-km-zA-HJ-NP-Z1-9]{33}$/,
  NEURAI: /^N[a-km-zA-HJ-NP-Z1-9]{33}$/,
  PEPEW: /^0x[a-fA-F0-9]{40}$/
};

// Algorithm configuration (大幅拡張)
export const ALGO_CONFIG = {
  // SHA256 Family
  sha256: {
    name: 'SHA256',
    coins: ['BTC', 'BCH', 'BSV'],
    difficulty: 1000000,
    blockTime: 600,
    reward: { BTC: 6.25, BCH: 6.25, BSV: 6.25 },
    hashUnit: 'TH/s',
    intensity: { cpu: 1, gpu: 20 }
  },
  
  // KawPow Family
  kawpow: {
    name: 'KawPow',
    coins: ['RVN'],
    difficulty: 100000,
    blockTime: 60,
    reward: { RVN: 5000 },
    hashUnit: 'MH/s',
    intensity: { cpu: 4, gpu: 23 }
  },
  
  // RandomX Family
  randomx: {
    name: 'RandomX',
    coins: ['XMR'],
    difficulty: 50000,
    blockTime: 120,
    reward: { XMR: 0.6 },
    hashUnit: 'kH/s',
    intensity: { cpu: 8, gpu: 0 }
  },
  
  // Ethash Family
  ethash: {
    name: 'Ethash',
    coins: ['ETH', 'ETC', 'ETHW', 'ETHF'],
    difficulty: 200000,
    blockTime: 15,
    reward: { ETH: 2.0, ETC: 3.2, ETHW: 2.0, ETHF: 2.0 },
    hashUnit: 'MH/s',
    intensity: { cpu: 1, gpu: 20 }
  },
  
  // Scrypt Family
  scrypt: {
    name: 'Scrypt',
    coins: ['LTC', 'DOGE'],
    difficulty: 500000,
    blockTime: 150,
    reward: { LTC: 12.5, DOGE: 10000 },
    hashUnit: 'MH/s',
    intensity: { cpu: 4, gpu: 18 }
  },
  
  // Equihash Family
  equihash: {
    name: 'Equihash',
    coins: ['ZEC', 'FLUX', 'ZEN'],
    difficulty: 300000,
    blockTime: 75,
    reward: { ZEC: 3.125, FLUX: 37.5, ZEN: 7.5 },
    hashUnit: 'Sol/s',
    intensity: { cpu: 2, gpu: 24 }
  },
  
  // X11 Family
  x11: {
    name: 'X11',
    coins: ['DASH'],
    difficulty: 400000,
    blockTime: 156,
    reward: { DASH: 2.88 },
    hashUnit: 'MH/s',
    intensity: { cpu: 4, gpu: 22 }
  },
  
  // Autolykos Family
  autolykos: {
    name: 'Autolykos',
    coins: ['ERGO'],
    difficulty: 150000,
    blockTime: 120,
    reward: { ERGO: 51 },
    hashUnit: 'MH/s',
    intensity: { cpu: 1, gpu: 25 }
  },
  
  // kHeavyHash Family
  kheavyhash: {
    name: 'kHeavyHash',
    coins: ['KAS'],
    difficulty: 80000,
    blockTime: 1,
    reward: { KAS: 440 },
    hashUnit: 'GH/s',
    intensity: { cpu: 1, gpu: 28 }
  },
  
  // Blake3 Family
  blake3: {
    name: 'Blake3',
    coins: ['ALPH'],
    difficulty: 120000,
    blockTime: 64,
    reward: { ALPH: 8.75 },
    hashUnit: 'MH/s',
    intensity: { cpu: 6, gpu: 26 }
  },
  
  // NexaPow Family
  nexapow: {
    name: 'NexaPow',
    coins: ['NEXA'],
    difficulty: 90000,
    blockTime: 120,
    reward: { NEXA: 10000000 },
    hashUnit: 'MH/s',
    intensity: { cpu: 1, gpu: 24 }
  },
  
  // Octopus Family
  octopus: {
    name: 'Octopus',
    coins: ['CFX'],
    difficulty: 110000,
    blockTime: 13,
    reward: { CFX: 2.0 },
    hashUnit: 'MH/s',
    intensity: { cpu: 1, gpu: 23 }
  },
  
  // FiroPow Family
  firopow: {
    name: 'FiroPow',
    coins: ['FIRO'],
    difficulty: 140000,
    blockTime: 150,
    reward: { FIRO: 6.25 },
    hashUnit: 'MH/s',
    intensity: { cpu: 1, gpu: 22 }
  },
  
  // Lyra2REv3 Family
  lyra2rev3: {
    name: 'Lyra2REv3',
    coins: ['VTC'],
    difficulty: 160000,
    blockTime: 150,
    reward: { VTC: 12.5 },
    hashUnit: 'MH/s',
    intensity: { cpu: 4, gpu: 21 }
  }
};

// 通貨の詳細情報
export const COIN_INFO = {
  // Bitcoin Family
  BTC: { name: 'Bitcoin', symbol: 'BTC', decimals: 8, minPayout: 0.001, category: 'Bitcoin' },
  BCH: { name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, minPayout: 0.01, category: 'Bitcoin' },
  BSV: { name: 'Bitcoin SV', symbol: 'BSV', decimals: 8, minPayout: 0.01, category: 'Bitcoin' },
  BTG: { name: 'Bitcoin Gold', symbol: 'BTG', decimals: 8, minPayout: 0.1, category: 'Bitcoin' },
  
  // Ethereum Family
  ETH: { name: 'Ethereum', symbol: 'ETH', decimals: 18, minPayout: 0.01, category: 'Ethereum' },
  ETC: { name: 'Ethereum Classic', symbol: 'ETC', decimals: 18, minPayout: 0.1, category: 'Ethereum' },
  ETHW: { name: 'EthereumPoW', symbol: 'ETHW', decimals: 18, minPayout: 1, category: 'Ethereum' },
  ETHF: { name: 'EthereumFair', symbol: 'ETHF', decimals: 18, minPayout: 10, category: 'Ethereum' },
  
  // Popular Altcoins
  RVN: { name: 'Ravencoin', symbol: 'RVN', decimals: 8, minPayout: 100, category: 'GPU' },
  XMR: { name: 'Monero', symbol: 'XMR', decimals: 12, minPayout: 0.1, category: 'Privacy' },
  LTC: { name: 'Litecoin', symbol: 'LTC', decimals: 8, minPayout: 0.1, category: 'Scrypt' },
  DOGE: { name: 'Dogecoin', symbol: 'DOGE', decimals: 8, minPayout: 100, category: 'Scrypt' },
  ZEC: { name: 'Zcash', symbol: 'ZEC', decimals: 8, minPayout: 0.01, category: 'Privacy' },
  DASH: { name: 'Dash', symbol: 'DASH', decimals: 8, minPayout: 0.01, category: 'Privacy' },
  
  // Modern GPU Coins
  ERGO: { name: 'Ergo', symbol: 'ERGO', decimals: 9, minPayout: 1, category: 'GPU' },
  FLUX: { name: 'Flux', symbol: 'FLUX', decimals: 8, minPayout: 1, category: 'GPU' },
  NEXA: { name: 'Nexa', symbol: 'NEXA', decimals: 2, minPayout: 1000000, category: 'GPU' },
  KAS: { name: 'Kaspa', symbol: 'KAS', decimals: 8, minPayout: 100, category: 'GPU' },
  ALPH: { name: 'Alephium', symbol: 'ALPH', decimals: 18, minPayout: 1, category: 'GPU' },
  
  // Others
  XTZ: { name: 'Tezos', symbol: 'XTZ', decimals: 6, minPayout: 1, category: 'PoS' },
  ZEN: { name: 'Horizen', symbol: 'ZEN', decimals: 8, minPayout: 0.1, category: 'Privacy' },
  CFX: { name: 'Conflux', symbol: 'CFX', decimals: 18, minPayout: 10, category: 'GPU' },
  FIRO: { name: 'Firo', symbol: 'FIRO', decimals: 8, minPayout: 1, category: 'Privacy' },
  VTC: { name: 'Vertcoin', symbol: 'VTC', decimals: 8, minPayout: 1, category: 'GPU' },
  
  // Emerging Coins
  CLORE: { name: 'Clore.ai', symbol: 'CLORE', decimals: 18, minPayout: 100, category: 'GPU' },
  NEURAI: { name: 'Neurai', symbol: 'NEURAI', decimals: 8, minPayout: 1000, category: 'GPU' },
  PEPEW: { name: 'PepeW', symbol: 'PEPEW', decimals: 18, minPayout: 1000000, category: 'Meme' }
};

// 通貨カテゴリー
export const CURRENCY_CATEGORIES = {
  'Bitcoin': ['BTC', 'BCH', 'BSV', 'BTG'],
  'Ethereum': ['ETH', 'ETC', 'ETHW', 'ETHF'],
  'Privacy': ['XMR', 'ZEC', 'DASH', 'FIRO', 'ZEN'],
  'GPU': ['RVN', 'ERGO', 'FLUX', 'NEXA', 'KAS', 'ALPH', 'CFX', 'VTC', 'CLORE', 'NEURAI'],
  'Scrypt': ['LTC', 'DOGE'],
  'Meme': ['DOGE', 'PEPEW'],
  'DeFi': ['ETH', 'ALPH', 'CFX'],
  'PoS': ['XTZ']
};

// BTC変換レート（運営手数料計算用）
export const BTC_CONVERSION_RATES = {
  // Bitcoin Family (1:1 or close)
  BTC: 1.0,
  BCH: 0.0065,   // Approximately BCH/BTC rate
  BSV: 0.0013,   // Approximately BSV/BTC rate
  BTG: 0.0005,   // Approximately BTG/BTC rate
  
  // Major Coins
  ETH: 0.058,    // Approximately ETH/BTC rate
  ETC: 0.0005,   // Approximately ETC/BTC rate
  LTC: 0.00186,  // Approximately LTC/BTC rate
  XMR: 0.0035,   // Approximately XMR/BTC rate
  
  // GPU Coins
  RVN: 0.00000070,
  ERGO: 0.000035,
  FLUX: 0.000015,
  KAS: 0.0000035,
  ALPH: 0.000025,
  ZEC: 0.00063,
  DASH: 0.00065,
  
  // Others
  DOGE: 0.00000017,
  NEXA: 0.0000000015,
  CFX: 0.000035,
  FIRO: 0.000045,
  VTC: 0.000012,
  ZEN: 0.00032,
  
  // Emerging/Small
  CLORE: 0.000008,
  NEURAI: 0.0000002,
  PEPEW: 0.000000001,
  ETHW: 0.00008,
  ETHF: 0.000001
};

// Network constants
export const NETWORK_CONSTANTS = {
  DEFAULT_PORTS: {
    STRATUM: 3333,
    API: 8080,
    P2P: 8333,
    METRICS: 9090
  },
  MAX_CONNECTIONS: {
    STRATUM: 10000,
    API: 1000,
    P2P: 100
  },
  TIMEOUTS: {
    CONNECTION: 30000,
    REQUEST: 10000,
    HEARTBEAT: 30000
  }
};

// DEX constants (更新)
export const DEX_CONSTANTS = {
  MIN_LIQUIDITY: {
    // Major pairs
    BTC: 0.001, ETH: 0.01, USDT: 100, USDC: 100,
    // Popular altcoins
    RVN: 1000, XMR: 0.1, LTC: 0.1, BCH: 0.01,
    ETC: 0.1, ZEC: 0.01, DASH: 0.01,
    // GPU coins
    ERGO: 10, FLUX: 10, KAS: 1000, ALPH: 10
  },
  FEE_TIERS: {
    V2: [0.3],
    V3: [0.05, 0.3, 1.0]
  },
  SLIPPAGE_LIMITS: {
    MAX: 50.0,
    WARNING: 5.0
  }
};

// DeFi constants
export const DEFI_CONSTANTS = {
  LENDING: {
    MAX_LTV: 75,
    LIQUIDATION_THRESHOLD: 85,
    INTEREST_RATE_BASE: 2.0
  },
  GOVERNANCE: {
    VOTING_PERIOD: 7 * 24 * 60 * 60 * 1000, // 7 days
    EXECUTION_DELAY: 24 * 60 * 60 * 1000,   // 24 hours
    QUORUM_THRESHOLD: 10
  },
  BRIDGE: {
    MIN_TRANSFER: 0.001,
    MAX_TRANSFER: 1000,
    CONFIRMATION_BLOCKS: {
      ETH: 12, BSC: 15, POLYGON: 20, AVAX: 10, FTM: 5
    }
  }
};

// Error codes
export const ERROR_CODES = {
  // General
  INVALID_REQUEST: 'E001',
  UNAUTHORIZED: 'E002',
  RATE_LIMITED: 'E003',
  UNSUPPORTED_CURRENCY: 'E004',
  
  // Mining
  INVALID_SHARE: 'M001',
  DUPLICATE_SHARE: 'M002',
  STALE_SHARE: 'M003',
  INVALID_ALGORITHM: 'M004',
  
  // DEX
  INSUFFICIENT_LIQUIDITY: 'D001',
  SLIPPAGE_EXCEEDED: 'D002',
  INVALID_PAIR: 'D003',
  
  // DeFi
  INSUFFICIENT_COLLATERAL: 'F001',
  LIQUIDATION_TRIGGERED: 'F002',
  INVALID_AMOUNT: 'F003',
  
  // Operator
  FEE_COLLECTION_FAILED: 'O001',
  SYSTEM_TAMPERED: 'O002',
  CONVERSION_FAILED: 'O003'
};

// Performance constants
export const PERFORMANCE_CONSTANTS = {
  BATCH_SIZES: {
    SHARES: 1000,
    PAYMENTS: 100,
    TRADES: 500
  },
  CACHE_SIZES: {
    SHARES: 10000,
    BALANCES: 5000,
    RATES: 1000
  },
  GC_INTERVALS: {
    MINOR: 60000,   // 1 minute
    MAJOR: 300000   // 5 minutes
  }
};

// Immutable operator constants (CANNOT BE CHANGED)
export const OPERATOR_CONSTANTS = Object.freeze({
  BTC_ADDRESS: '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa',
  FEE_RATE: 0.001, // 0.1%
  COLLECTION_INTERVAL: 300000, // 5 minutes
  MIN_COLLECTION_AMOUNT: 0.001, // 0.001 BTC
  CONVERSION_RATES_UPDATE: 60000, // 1 minute
  SUPPORTED_CURRENCIES: Object.keys(BTC_CONVERSION_RATES)
});

// Immutable pool constants (CANNOT BE CHANGED)
export const POOL_CONSTANTS = Object.freeze({
  FEE_RATE: 0.014, // 1.4% FIXED POOL FEE
  TOTAL_FEE_RATE: 0.015, // 1.5% (1.4% pool + 0.1% operator)
  PAYOUT_INTERVAL: 3600000, // 1 hour
  IMMUTABLE: true
});

// Security constants
export const SECURITY_CONSTANTS = {
  RATE_LIMITS: {
    API: 1000,     // requests per minute
    STRATUM: 100,  // connections per IP
    P2P: 10        // connections per IP
  },
  TIMEOUTS: {
    AUTH: 5000,
    CAPTCHA: 30000,
    SESSION: 3600000
  },
  ENCRYPTION: {
    ALGORITHM: 'aes-256-gcm',
    KEY_LENGTH: 32,
    IV_LENGTH: 16
  }
};

// Monitoring constants
export const MONITORING_CONSTANTS = {
  METRICS_INTERVAL: 10000,  // 10 seconds
  ALERT_THRESHOLDS: {
    CPU_USAGE: 90,
    MEMORY_USAGE: 85,
    DISK_USAGE: 90,
    ERROR_RATE: 5
  },
  RETENTION: {
    METRICS: 7 * 24 * 60 * 60 * 1000,    // 7 days
    LOGS: 30 * 24 * 60 * 60 * 1000,      // 30 days
    ALERTS: 90 * 24 * 60 * 60 * 1000     // 90 days
  }
};

// API response templates
export const API_RESPONSES = {
  SUCCESS: {
    status: 'success',
    code: 200
  },
  ERROR: {
    status: 'error',
    code: 400
  },
  UNAUTHORIZED: {
    status: 'error',
    code: 401,
    message: 'Unauthorized access'
  },
  NOT_FOUND: {
    status: 'error',
    code: 404,
    message: 'Resource not found'
  },
  RATE_LIMITED: {
    status: 'error',
    code: 429,
    message: 'Rate limit exceeded'
  }
};

// Database constants
export const DATABASE_CONSTANTS = {
  MAX_CONNECTIONS: 100,
  TIMEOUT: 30000,
  RETRY_ATTEMPTS: 3,
  BATCH_SIZE: 1000,
  VACUUM_INTERVAL: 24 * 60 * 60 * 1000, // 24 hours
  BACKUP_INTERVAL: 6 * 60 * 60 * 1000   // 6 hours
};

// Validation rules
export const VALIDATION_RULES = {
  WALLET_ADDRESS: {
    MIN_LENGTH: 26,
    MAX_LENGTH: 95
  },
  WORKER_NAME: {
    MIN_LENGTH: 1,
    MAX_LENGTH: 32,
    PATTERN: /^[a-zA-Z0-9_-]+$/
  },
  AMOUNT: {
    MIN: 0.00000001,
    MAX: 21000000
  },
  FEE: {
    MIN: 0.01,
    MAX: 10.0
  }
};

// Export all constants as a single object for convenience
export const CONSTANTS = {
  WALLET_PATTERNS,
  ALGO_CONFIG,
  COIN_INFO,
  CURRENCY_CATEGORIES,
  BTC_CONVERSION_RATES,
  NETWORK_CONSTANTS,
  DEX_CONSTANTS,
  DEFI_CONSTANTS,
  ERROR_CODES,
  PERFORMANCE_CONSTANTS,
  OPERATOR_CONSTANTS,
  SECURITY_CONSTANTS,
  MONITORING_CONSTANTS,
  API_RESPONSES,
  DATABASE_CONSTANTS,
  VALIDATION_RULES
};
