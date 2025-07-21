/**
 * Otedama - Global Constants
 * 
 * This file centralizes all the core constants and configurations for the application.
 * By externalizing these values, we can easily manage and update them without
 * modifying the main application logic.
 */

// ===== CORE APPLICATION METADATA =====
export const VERSION = '1.0.0'; // Internal version, not for display
export const OPERATOR_ADDRESS = '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa';

// ===== FEE STRUCTURE =====
export const POOL_FEE_RATE = 0.01; // 1% pool usage fee (fixed)

// ===== SUPPORTED CRYPTOCURRENCIES & ALGORITHMS =====

// Wallet patterns for validation (13 supported currencies)
export const WALLET_PATTERNS = {
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
export const ALGORITHMS = {
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

// ===== PAYOUT CONFIGURATION =====

// Minimum payout amounts for each currency before conversion to BTC
export const MIN_PAYOUT = {
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

// ===== DEX & CONVERSION FEES =====

// Auto-calculated BTC conversion fees (based on exchange/network costs)
// These represent the estimated cost rate for converting a currency to BTC.
export const BTC_CONVERSION_COSTS = {
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

// DEPRECATED: Fallback static conversion rates. 
// The system prioritizes live price feeds. These are for emergency use only.
export const DEPRECATED_BTC_CONVERSION_RATES = {
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
};
