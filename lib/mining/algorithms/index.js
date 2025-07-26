/**
 * Mining Algorithms Index
 * Export only essential algorithms for production use
 * 
 * Design: Focused on practical mining algorithms (Pike principle)
 */

import { algorithmRegistry } from './base-algorithm.js';
import { getAvailableNativeAlgorithms } from './native-bindings.js';

// Import only essential algorithms
import SHA256 from './sha256.js';
import Scrypt from './scrypt.js';
import Ethash from './ethash.js';
import RandomX from './randomx.js';
import KawPow from './kawpow.js';

// Register essential algorithms
algorithmRegistry.register('sha256', SHA256);
algorithmRegistry.register('sha256d', SHA256); // Double SHA256
algorithmRegistry.register('scrypt', Scrypt);
algorithmRegistry.register('ethash', Ethash);
algorithmRegistry.register('etchash', Ethash); // Ethereum Classic
algorithmRegistry.register('randomx', RandomX);
algorithmRegistry.register('kawpow', KawPow);

// Log available native algorithms
const nativeAlgos = getAvailableNativeAlgorithms();
if (nativeAlgos.length > 0) {
    console.log(`Mining algorithms with native acceleration: ${nativeAlgos.join(', ')}`);
}

// Export registry and base class
export { algorithmRegistry, MiningAlgorithm } from './base-algorithm.js';
export { isNativeAvailable, getAvailableNativeAlgorithms } from './native-bindings.js';

// Export algorithm constants
export const MINING_ALGORITHMS = {
  SHA256: { name: 'sha256', currency: 'BTC' },
  SCRYPT: { name: 'scrypt', currency: 'LTC' },
  ETHASH: { name: 'ethash', currency: 'ETC' },
  RANDOMX: { name: 'randomx', currency: 'XMR' },
  KAWPOW: { name: 'kawpow', currency: 'RVN' }
};

// Export individual algorithm classes
export { SHA256, Scrypt, Ethash, RandomX, KawPow };

// Algorithm information
export const ALGORITHM_INFO = {
    sha256: {
        name: 'SHA-256',
        coins: ['BTC', 'BCH', 'BSV'],
        hardware: ['CPU', 'GPU', 'ASIC'],
        description: 'Bitcoin algorithm'
    },
    scrypt: {
        name: 'Scrypt',
        coins: ['LTC', 'DOGE'],
        hardware: ['CPU', 'GPU', 'ASIC'],
        description: 'Memory-hard algorithm'
    },
    ethash: {
        name: 'Ethash',
        coins: ['ETC'],
        hardware: ['GPU'],
        description: 'Ethereum Classic algorithm'
    },
    randomx: {
        name: 'RandomX',
        coins: ['XMR'],
        hardware: ['CPU'],
        description: 'CPU-optimized algorithm'
    },
    kawpow: {
        name: 'KawPow',
        coins: ['RVN'],
        hardware: ['GPU'],
        description: 'Ravencoin algorithm'
    }
};

/**
 * Get supported algorithms for a coin
 */
export function getAlgorithmsForCoin(coin) {
    const algorithms = [];
    
    for (const [algo, info] of Object.entries(ALGORITHM_INFO)) {
        if (info.coins.includes(coin.toUpperCase())) {
            algorithms.push(algo);
        }
    }
    
    return algorithms;
}

/**
 * Get supported coins for an algorithm
 */
export function getCoinsForAlgorithm(algorithm) {
    const info = ALGORITHM_INFO[algorithm.toLowerCase()];
    return info ? info.coins : [];
}

/**
 * Check if hardware supports algorithm
 */
export function isHardwareSupported(algorithm, hardware) {
    const info = ALGORITHM_INFO[algorithm.toLowerCase()];
    return info ? info.hardware.includes(hardware.toUpperCase()) : false;
}

/**
 * Create algorithm instance with auto-detection
 */
export function createAlgorithm(coin, config = {}) {
    const algorithms = getAlgorithmsForCoin(coin);
    
    if (algorithms.length === 0) {
        throw new Error(`No algorithms found for coin: ${coin}`);
    }
    
    // Use first algorithm as default
    const algorithm = config.algorithm || algorithms[0];
    
    return algorithmRegistry.create(algorithm, {
        coin,
        ...config
    });
}

export default {
    SHA256,
    Scrypt,
    Ethash,
    RandomX,
    KawPow,
    MINING_ALGORITHMS,
    ALGORITHM_INFO,
    getAlgorithmsForCoin,
    getCoinsForAlgorithm,
    isHardwareSupported,
    createAlgorithm
};