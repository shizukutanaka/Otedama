/**
 * Otedama Core Constants
 * Immutable configuration values
 * 
 * IMPORTANT: These values are hardcoded and cannot be modified
 * Any attempt to change these values will result in pool failure
 */

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

// Pool operator configuration - IMMUTABLE
export const POOL_OPERATOR = deepFreeze({
  BTC_ADDRESS: '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa',
  NAME: 'Otedama Mining Pool',
  VERSION: '1.1.1'
});

// Pool fee configuration - IMMUTABLE
export const POOL_FEES = deepFreeze({
  MINING_FEE: 0.01, // 1% - Cannot be changed
  WITHDRAWAL_FEE: 0.0001, // 0.0001 BTC - Cannot be changed
  CONVERSION_FEE: 0.002 // 0.2% - Cannot be changed
});

// Minimum payout configuration - IMMUTABLE
export const MIN_PAYOUTS = deepFreeze({
  BTC: 0.001,
  LTC: 0.01,
  ETH: 0.01,
  XMR: 0.1,
  RVN: 100
});

// Network configuration - IMMUTABLE
export const NETWORK_CONFIG = deepFreeze({
  STRATUM_PORT: 3333,
  API_PORT: 8081,
  MONITORING_PORT: 8082
});

// Mining algorithms - IMMUTABLE
export const MINING_ALGORITHMS = deepFreeze({
  sha256: {
    name: 'SHA256',
    coins: ['BTC', 'BCH', 'BSV'],
    difficulty: 1,
    hashFunction: 'sha256d'
  },
  scrypt: {
    name: 'Scrypt',
    coins: ['LTC', 'DOGE', 'VTC'],
    difficulty: 1024,
    hashFunction: 'scrypt'
  },
  ethash: {
    name: 'Ethash',
    coins: ['ETH', 'ETC'],
    difficulty: 1000000000,
    hashFunction: 'ethash'
  },
  randomx: {
    name: 'RandomX',
    coins: ['XMR'],
    difficulty: 1000,
    hashFunction: 'randomx'
  },
  kawpow: {
    name: 'KawPow',
    coins: ['RVN'],
    difficulty: 1000000,
    hashFunction: 'kawpow'
  }
});

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

// Prevent module from being modified
Object.freeze(exports);
Object.seal(module);

export default deepFreeze({
  POOL_OPERATOR,
  POOL_FEES,
  MIN_PAYOUTS,
  NETWORK_CONFIG,
  MINING_ALGORITHMS,
  SECURITY_CONFIG,
  validateConstants
});