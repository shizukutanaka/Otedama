/**
 * Unified Constants - Otedama v1.1.8
 * 統合定数ファイル
 * 
 * This file consolidates all constants from:
 * - config/constants.js (global config)
 * - lib/core/constants.js (core constants)
 * - lib/mining/constants.js (mining constants)
 * - lib/storage/constants.js (storage constants)
 */

import { secureFeeConfig } from '../lib/security/fee-protection.js';

// ===== UTILITY FUNCTIONS =====

// Freeze function to make objects completely immutable
const deepFreeze = (obj) => {
  Object.freeze(obj);
  Object.getOwnPropertyNames(obj).forEach((prop) => {
    if (obj[prop] !== null
        && (typeof obj[prop] === 'object' || typeof obj[prop] === 'function')
        && !Object.isFrozen(obj[prop])) {
      deepFreeze(obj[prop]);
    }
  });
  return obj;
};

// ===== CORE APPLICATION METADATA =====
export const VERSION = '1.1.8';
export const OPERATOR_ADDRESS = process.env.POOL_OPERATOR_ADDRESS || (() => {
  throw new Error('POOL_OPERATOR_ADDRESS environment variable is required for production');
})();

// Pool operator configuration - IMMUTABLE
export const POOL_OPERATOR = deepFreeze({
  BTC_ADDRESS: '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa',
  NAME: 'Otedama Mining Pool',
  VERSION: '1.1.8'
});

// ===== FEE STRUCTURE =====
// CRITICAL: Fee rates are protected by cryptographic integrity checks
export const POOL_FEE_RATE = secureFeeConfig.getPoolFeeRate();
export const getFeeTransparency = () => secureFeeConfig.getFeeTransparencyReport();

// Pool fee configuration - IMMUTABLE
export const POOL_FEES = deepFreeze({
  MINING_FEE: 0.01, // 1% - Cannot be changed
  WITHDRAWAL_FEE: 0.0001, // 0.0001 BTC - Cannot be changed
  CONVERSION_FEE: 0.002 // 0.2% - Cannot be changed
});

// Mining fee structures
export const FEE_STRUCTURES = deepFreeze({
  DIRECT: {
    baseFee: 0.018,    // 1.8%
    description: 'Direct payout in mined currency'
  },
  CONVERT: {
    poolFee: 0.018,    // 1.8%
    conversionFee: 0.002, // 0.2%
    totalFee: 0.02,    // 2.0%
    description: 'Convert to BTC payout'
  }
});

// ===== SUPPORTED CRYPTOCURRENCIES & ALGORITHMS =====

// Wallet patterns for validation (13 supported currencies)
export const WALLET_PATTERNS = deepFreeze({
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
});

// Mining algorithms
export const ALGORITHMS = deepFreeze({
  SHA256: 'sha256',
  SCRYPT: 'scrypt',
  ETHASH: 'ethash',
  RANDOMX: 'randomx',
  KAWPOW: 'kawpow',
  X11: 'x11',
  EQUIHASH: 'equihash',
  AUTOLYKOS: 'autolykos2',
  KHEAVYHASH: 'kheavyhash',
  BLAKE3: 'blake3'
});

// Enhanced algorithm configurations
export const ALGORITHM_CONFIG = deepFreeze({
  sha256: { 
    name: 'SHA-256', 
    coins: ['BTC'], 
    hashUnit: 'TH/s', 
    difficulty: 1000000,
    target: 0x1d00ffff,
    shareMultiplier: 65536,
    hashFunction: 'sha256d'
  },
  kawpow: { 
    name: 'KawPow', 
    coins: ['RVN'], 
    hashUnit: 'MH/s', 
    difficulty: 100000,
    target: 0x00000000ff000000,
    shareMultiplier: 4096,
    hashFunction: 'kawpow'
  },
  ethash: { 
    name: 'Ethash', 
    coins: ['ETH', 'ETC'], 
    hashUnit: 'MH/s', 
    difficulty: 200000,
    target: 0x00000000ffff0000,
    shareMultiplier: 4294967296,
    hashFunction: 'ethash'
  },
  randomx: { 
    name: 'RandomX', 
    coins: ['XMR'], 
    hashUnit: 'kH/s', 
    difficulty: 50000,
    target: 0x00000000ffffffff,
    shareMultiplier: 256,
    hashFunction: 'randomx'
  },
  scrypt: { 
    name: 'Scrypt', 
    coins: ['LTC', 'DOGE'], 
    hashUnit: 'MH/s', 
    difficulty: 500000,
    target: 0x1e0ffff0,
    shareMultiplier: 65536,
    hashFunction: 'scrypt'
  },
  equihash: { 
    name: 'Equihash', 
    coins: ['ZEC', 'FLUX'], 
    hashUnit: 'Sol/s', 
    difficulty: 300000,
    target: 0x1f07ffff,
    shareMultiplier: 131072,
    hashFunction: 'equihash'
  },
  x11: { 
    name: 'X11', 
    coins: ['DASH'], 
    hashUnit: 'MH/s', 
    difficulty: 400000,
    target: 0x1e0fffff,
    shareMultiplier: 256,
    hashFunction: 'x11'
  },
  autolykos: { 
    name: 'Autolykos', 
    coins: ['ERGO'], 
    hashUnit: 'MH/s', 
    difficulty: 150000,
    target: 0x1b0404cb,
    shareMultiplier: 4096,
    hashFunction: 'autolykos2'
  },
  kheavyhash: { 
    name: 'kHeavyHash', 
    coins: ['KAS'], 
    hashUnit: 'GH/s', 
    difficulty: 80000,
    target: 0x1e00ffff,
    shareMultiplier: 65536,
    hashFunction: 'kheavyhash'
  },
  blake3: { 
    name: 'Blake3', 
    coins: ['ALPH'], 
    hashUnit: 'MH/s', 
    difficulty: 120000,
    target: 0x1d00ffff,
    shareMultiplier: 256,
    hashFunction: 'blake3'
  }
});

// ===== PAYOUT CONFIGURATION =====

// Minimum payout amounts for each currency before conversion to BTC
export const MIN_PAYOUT = deepFreeze({
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
});

// BTC conversion costs
export const BTC_CONVERSION_COSTS = deepFreeze({
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
});

// ===== BLOCKCHAIN CONFIGURATION =====

// Block time targets (seconds)
export const BLOCK_TIME_TARGETS = deepFreeze({
  BTC: 600,      // 10 minutes
  LTC: 150,      // 2.5 minutes
  ETH: 13,       // 13 seconds
  XMR: 120,      // 2 minutes
  DOGE: 60,      // 1 minute
  DASH: 150,     // 2.5 minutes
  ZEC: 75,       // 1.25 minutes
  RVN: 60,       // 1 minute
  ERGO: 120,     // 2 minutes
  KAS: 1,        // 1 second
  ALPH: 64       // 64 seconds
});

// Network difficulty adjustment intervals (blocks)
export const DIFFICULTY_ADJUSTMENT_INTERVALS = deepFreeze({
  BTC: 2016,     // ~2 weeks
  LTC: 2016,     // ~3.5 days
  ETH: 1,        // Every block
  XMR: 1,        // Every block
  DOGE: 240,     // ~4 hours
  DASH: 1,       // Every block (DGW)
  ZEC: 1,        // Every block
  RVN: 2016,     // ~1 day
  ERGO: 1,       // Every block
  KAS: 1,        // Every block (DAA)
  ALPH: 1        // Every block
});

// ===== NETWORK CONFIGURATION =====

// Network ports - IMMUTABLE
export const NETWORK_CONFIG = deepFreeze({
  STRATUM_PORT: 3333,
  API_PORT: 8081,
  MONITORING_PORT: 8082
});

// Stratum error codes
export const STRATUM_ERRORS = deepFreeze({
  UNAUTHORIZED: [-1, 'Unauthorized', null],
  NOT_SUBSCRIBED: [-2, 'Not subscribed', null],
  NOT_AUTHORIZED: [-3, 'Not authorized', null],
  UNKNOWN_METHOD: [-3, 'Unknown method', null],
  INVALID_PARAMS: [-20, 'Invalid params', null],
  INTERNAL_ERROR: [-20, 'Internal error', null],
  LOW_DIFFICULTY: [-23, 'Low difficulty share', null],
  DUPLICATE_SHARE: [-22, 'Duplicate share', null],
  JOB_NOT_FOUND: [-21, 'Job not found', null],
  STALE_SHARE: [-21, 'Stale share', null]
});

// ===== SECURITY CONFIGURATION =====

// Security configuration - IMMUTABLE
export const SECURITY_CONFIG = deepFreeze({
  ZKP_ENABLED: true,
  SSL_ENABLED: true,
  ANTI_DDOS: true,
  RATE_LIMIT: {
    WINDOW_MS: 60000,
    MAX_REQUESTS: 1000
  }
});

// ===== HARDWARE & SOFTWARE =====

// Mining hardware types
export const HARDWARE_TYPES = deepFreeze({
  ASIC: 'asic',
  GPU: 'gpu',
  CPU: 'cpu',
  FPGA: 'fpga'
});

// Common mining software user agents
export const MINING_SOFTWARE = deepFreeze({
  CGMINER: /cgminer/i,
  BFGMINER: /bfgminer/i,
  CCMINER: /ccminer/i,
  CLAYMORE: /claymore/i,
  PHOENIXMINER: /phoenix/i,
  TEAMREDMINER: /teamred/i,
  TREX: /t-rex/i,
  GMINER: /gminer/i,
  LOLMINER: /lolminer/i,
  XMRIG: /xmrig/i,
  CPUMINER: /cpuminer/i,
  MINIRIG: /minirig/i,
  NBMINER: /nbminer/i,
  KAWPOWMINER: /kawpowminer/i
});

// ===== STORAGE CONFIGURATION =====

// Cache TTL values
export const CACHE_TTL = deepFreeze({
  VERY_SHORT: 1000,      // 1 second
  SHORT: 5000,           // 5 seconds
  MEDIUM: 60000,         // 1 minute
  LONG: 300000,          // 5 minutes
  VERY_LONG: 3600000,    // 1 hour
  DAY: 86400000,         // 24 hours
  PERMANENT: 0           // No expiration
});

// Cache key prefixes
export const CACHE_PREFIX = deepFreeze({
  WORKER: 'worker:',
  JOB: 'job:',
  SHARE: 'share:',
  BLOCK: 'block:',
  STATS: 'stats:',
  SESSION: 'session:',
  API: 'api:'
});

// Database tables
export const DB_TABLES = deepFreeze({
  SHARES: 'shares',
  MINERS: 'miners',
  BLOCKS: 'blocks',
  PAYMENTS: 'payments'
});

// Storage limits
export const STORAGE_LIMITS = deepFreeze({
  MAX_CACHE_SIZE: 100 * 1024 * 1024, // 100MB
  MAX_CACHE_ITEMS: 10000,
  MAX_SHARES_IN_MEMORY: 100000,
  MAX_BLOCKS_IN_MEMORY: 1000,
  CLEANUP_THRESHOLD: 0.9 // Cleanup when 90% full
});

// File extensions
export const FILE_EXTENSIONS = deepFreeze({
  JSON: '.json',
  BACKUP: '.bak',
  LOG: '.log',
  DB: '.db'
});

// ===== VALIDATION FUNCTIONS =====

// Validate that constants haven't been tampered with
export function validateConstants() {
  if (POOL_OPERATOR.BTC_ADDRESS !== '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa') {
    throw new Error('FATAL: Pool operator address has been tampered with!');
  }
  
  if (POOL_FEES.MINING_FEE !== 0.01) {
    throw new Error('FATAL: Pool fee configuration has been tampered with!');
  }
  
  return true;
}

// Auto-validate on module load
validateConstants();

// ===== DEPRECATED (for backward compatibility) =====

// DEPRECATED: Fallback static conversion rates. 
export const DEPRECATED_BTC_CONVERSION_RATES = deepFreeze({
  BTC: 1.0,
  ETH: 0.065,
  RVN: 0.0000007,
  XMR: 0.0035,
  LTC: 0.00215,
  ETC: 0.0005,
  DOGE: 0.0000025,
  ZEC: 0.0008,
  DASH: 0.0007,
  ERGO: 0.00003,
  FLUX: 0.000015,
  KAS: 0.000003,
  ALPH: 0.00002
});

// Legacy aliases for backward compatibility
export const MINING_ALGORITHMS = ALGORITHM_CONFIG;
export const MIN_PAYOUTS = MIN_PAYOUT;
export const TTL = CACHE_TTL;
export const CACHE_PREFIXES = CACHE_PREFIX;
export const TABLES = DB_TABLES;
export const LIMITS = STORAGE_LIMITS;
export const FILE_EXT = FILE_EXTENSIONS;

// ===== DEFAULT EXPORT =====

export default deepFreeze({
  // Metadata
  VERSION,
  OPERATOR_ADDRESS,
  POOL_OPERATOR,
  
  // Fees
  POOL_FEE_RATE,
  POOL_FEES,
  FEE_STRUCTURES,
  BTC_CONVERSION_COSTS,
  
  // Cryptocurrencies & Algorithms
  WALLET_PATTERNS,
  ALGORITHMS,
  ALGORITHM_CONFIG,
  
  // Payouts
  MIN_PAYOUT,
  
  // Blockchain
  BLOCK_TIME_TARGETS,
  DIFFICULTY_ADJUSTMENT_INTERVALS,
  
  // Network
  NETWORK_CONFIG,
  STRATUM_ERRORS,
  
  // Security
  SECURITY_CONFIG,
  
  // Hardware & Software
  HARDWARE_TYPES,
  MINING_SOFTWARE,
  
  // Storage
  CACHE_TTL,
  CACHE_PREFIX,
  DB_TABLES,
  STORAGE_LIMITS,
  FILE_EXTENSIONS,
  
  // Functions
  validateConstants,
  getFeeTransparency,
  
  // Legacy aliases
  MINING_ALGORITHMS,
  MIN_PAYOUTS,
  TTL,
  CACHE_PREFIXES,
  TABLES,
  LIMITS,
  FILE_EXT
});