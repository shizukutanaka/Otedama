/**
 * Mining Algorithms Module
 * Export all mining algorithm implementations
 * 
 * Automatically uses native implementations when available for production mining.
 * Falls back to JavaScript implementations for development/testing.
 */

import { algorithmRegistry } from './base-algorithm.js';
import { getAvailableNativeAlgorithms } from './native-bindings.js';

// Import all algorithms
import SHA256 from './sha256.js';
import Scrypt from './scrypt.js';
import Ethash from './ethash.js';
import RandomX from './randomx.js';
import KawPow from './kawpow.js';
import ProgPoW from './progpow.js';
import Octopus from './octopus.js';
import X16R from './x16r.js';
import CryptoNight from './cryptonight.js';
import Equihash from './equihash.js';
import Blake2s from './blake2s.js';
import Lyra2REv3 from './lyra2rev3.js';
import X11 from './x11.js';
import Autolykos from './autolykos.js';
import KHeavyHash from './kheavyhash.js';
import Blake3 from './blake3.js';
import FishHash from './fishhash.js';
import DynexSolve from './dynexsolve.js';

// Register all algorithms
algorithmRegistry.register('sha256', SHA256);
algorithmRegistry.register('sha256d', SHA256); // Double SHA256
algorithmRegistry.register('scrypt', Scrypt);
algorithmRegistry.register('ethash', Ethash);
algorithmRegistry.register('etchash', Ethash); // Ethereum Classic
algorithmRegistry.register('randomx', RandomX);
algorithmRegistry.register('kawpow', KawPow);
algorithmRegistry.register('progpow', ProgPoW);
algorithmRegistry.register('octopus', Octopus);
algorithmRegistry.register('x16r', X16R);
algorithmRegistry.register('x16rv2', X16R); // X16R variant 2
algorithmRegistry.register('cryptonight', CryptoNight);
algorithmRegistry.register('cryptonight-r', CryptoNight);
algorithmRegistry.register('equihash', Equihash);
algorithmRegistry.register('blake2s', Blake2s);
algorithmRegistry.register('lyra2rev3', Lyra2REv3);
algorithmRegistry.register('x11', X11);
algorithmRegistry.register('autolykos', Autolykos);
algorithmRegistry.register('autolykos2', Autolykos); // Autolykos v2
algorithmRegistry.register('kheavyhash', KHeavyHash);
algorithmRegistry.register('blake3', Blake3);
algorithmRegistry.register('fishhash', FishHash);
algorithmRegistry.register('dynexsolve', DynexSolve);

// Log available native algorithms
const nativeAlgos = getAvailableNativeAlgorithms();
if (nativeAlgos.length > 0) {
    console.log(`Mining algorithms with native acceleration: ${nativeAlgos.join(', ')}`);
} else {
    console.log('No native mining algorithm implementations found. Using JavaScript implementations.');
}

// Export registry and base class
export { algorithmRegistry, MiningAlgorithm } from './base-algorithm.js';
export { isNativeAvailable, getAvailableNativeAlgorithms } from './native-bindings.js';

// Export algorithm constants for backward compatibility
export const MINING_ALGORITHMS = {
  SHA256: { name: 'sha256', currency: 'BTC' },
  SCRYPT: { name: 'scrypt', currency: 'LTC' },
  ETHASH: { name: 'ethash', currency: 'ETC' },
  RANDOMX: { name: 'randomx', currency: 'XMR' },
  KAWPOW: { name: 'kawpow', currency: 'RVN' },
  X11: { name: 'x11', currency: 'DASH' },
  EQUIHASH: { name: 'equihash', currency: 'ZEC' },
  AUTOLYKOS2: { name: 'autolykos2', currency: 'ERGO' },
  KHEAVYHASH: { name: 'kheavyhash', currency: 'KAS' },
  BLAKE3: { name: 'blake3', currency: 'ALPH' },
  FISHHASH: { name: 'fishhash', currency: 'IRON' },
  DYNEXSOLVE: { name: 'dynexsolve', currency: 'DNX' }
};

// Export individual algorithm classes
export { SHA256, Scrypt, Ethash, RandomX, KawPow, X11, Equihash, Autolykos, KHeavyHash, Blake3, FishHash, DynexSolve };

// Export all algorithm classes
export {
    SHA256,
    Scrypt,
    Ethash,
    RandomX,
    KawPow,
    ProgPoW,
    Octopus,
    X16R,
    CryptoNight,
    Equihash,
    Blake2s,
    Lyra2REv3,
    X11,
    Autolykos,
    KHeavyHash,
    Blake3,
    FishHash,
    DynexSolve
};

// Algorithm information
export const ALGORITHM_INFO = {
    sha256: {
        name: 'SHA-256',
        coins: ['BTC', 'BCH', 'BSV'],
        hardware: ['ASIC'],
        description: 'Bitcoin\'s original algorithm'
    },
    scrypt: {
        name: 'Scrypt',
        coins: ['LTC', 'DOGE'],
        hardware: ['ASIC'],
        description: 'Memory-hard algorithm'
    },
    ethash: {
        name: 'Ethash',
        coins: ['ETH', 'ETC'],
        hardware: ['GPU', 'ASIC'],
        description: 'Ethereum\'s PoW algorithm'
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
        description: 'ProgPoW variant for Ravencoin'
    },
    progpow: {
        name: 'ProgPoW',
        coins: ['SERO'],
        hardware: ['GPU'],
        description: 'ASIC-resistant GPU algorithm'
    },
    octopus: {
        name: 'Octopus',
        coins: ['CFX'],
        hardware: ['GPU'],
        description: 'Memory-hard GPU algorithm'
    },
    x16r: {
        name: 'X16R',
        coins: ['RVN'],
        hardware: ['GPU'],
        description: '16 algorithms in random order'
    },
    cryptonight: {
        name: 'CryptoNight',
        coins: ['XMR', 'AEON'],
        hardware: ['CPU', 'GPU'],
        description: 'Privacy-focused algorithm'
    },
    equihash: {
        name: 'Equihash',
        coins: ['ZEC', 'ZEN', 'BTG'],
        hardware: ['GPU', 'ASIC'],
        description: 'Memory-oriented algorithm'
    },
    blake2s: {
        name: 'Blake2s',
        coins: ['KDA'],
        hardware: ['ASIC'],
        description: 'Fast cryptographic hash'
    },
    lyra2rev3: {
        name: 'Lyra2REv3',
        coins: ['VTC'],
        hardware: ['GPU'],
        description: 'ASIC-resistant chain algorithm'
    },
    x11: {
        name: 'X11',
        coins: ['DASH'],
        hardware: ['GPU', 'ASIC'],
        description: 'Chain of 11 hash functions'
    },
    autolykos: {
        name: 'Autolykos v2',
        coins: ['ERGO'],
        hardware: ['GPU'],
        description: 'Memory-hard algorithm'
    },
    kheavyhash: {
        name: 'KHeavyHash',
        coins: ['KAS'],
        hardware: ['ASIC', 'GPU'],
        description: 'Matrix-based algorithm'
    },
    blake3: {
        name: 'Blake3',
        coins: ['ALPH'],
        hardware: ['ASIC', 'GPU', 'CPU'],
        description: 'High-performance hash'
    },
    fishhash: {
        name: 'FishHash',
        coins: ['IRON'],
        hardware: ['GPU'],
        description: 'Memory-hard algorithm optimized for GPUs'
    },
    dynexsolve: {
        name: 'DynexSolve',
        coins: ['DNX'],
        hardware: ['CPU', 'GPU'],
        description: 'Quantum-resistant neuromorphic computing algorithm'
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