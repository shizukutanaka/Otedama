/**
 * Homomorphic Encryption for Otedama
 * Privacy-preserving computation capabilities
 * 
 * Design principles:
 * - Carmack: High-performance encrypted computation
 * - Martin: Clean privacy-preserving architecture
 * - Pike: Simple homomorphic encryption API
 */

import { EventEmitter } from 'events';
import { randomBytes, createHash } from 'crypto';
import { getLogger } from '../core/logger.js';

const logger = getLogger('HomomorphicEncryption');

/**
 * Homomorphic encryption schemes
 */
export const EncryptionScheme = {
  PAILLIER: 'paillier',           // Additive homomorphism
  BFV: 'bfv',                     // Fully homomorphic (BFV)
  CKKS: 'ckks',                   // Approximate homomorphic
  BGV: 'bgv',                     // Fully homomorphic (BGV)
  TFHE: 'tfhe'                    // Fast bootstrapping
};

/**
 * Operation types
 */
export const OperationType = {
  ADD: 'add',
  MULTIPLY: 'multiply',
  SUBTRACT: 'subtract',
  COMPARE: 'compare',
  AGGREGATE: 'aggregate',
  TRANSFORM: 'transform'
};

/**
 * Big integer utilities for homomorphic operations
 */
export class BigIntMath {
  static modPow(base, exponent, modulus) {
    if (modulus === 1n) return 0n;
    
    let result = 1n;
    base = base % modulus;
    
    while (exponent > 0n) {
      if (exponent % 2n === 1n) {
        result = (result * base) % modulus;
      }
      exponent = exponent >> 1n;
      base = (base * base) % modulus;
    }
    
    return result;
  }
  
  static gcd(a, b) {
    while (b !== 0n) {
      [a, b] = [b, a % b];
    }
    return a;
  }
  
  static modInverse(a, m) {
    const [gcd, x] = this.extendedGcd(a, m);
    if (gcd !== 1n) {
      throw new Error('Modular inverse does not exist');
    }
    return ((x % m) + m) % m;
  }
  
  static extendedGcd(a, b) {
    if (a === 0n) return [b, 0n, 1n];
    
    const [gcd, x1, y1] = this.extendedGcd(b % a, a);
    const x = y1 - (b / a) * x1;
    const y = x1;
    
    return [gcd, x, y];
  }
  
  static isPrime(n, k = 10) {
    if (n < 2n) return false;
    if (n === 2n || n === 3n) return true;
    if (n % 2n === 0n) return false;
    
    // Miller-Rabin primality test
    let r = 0n;
    let d = n - 1n;
    
    while (d % 2n === 0n) {
      d /= 2n;
      r++;
    }
    
    for (let i = 0; i < k; i++) {
      const a = this.randomBigInt(2n, n - 2n);
      let x = this.modPow(a, d, n);
      
      if (x === 1n || x === n - 1n) continue;
      
      let composite = true;
      for (let j = 0n; j < r - 1n; j++) {
        x = this.modPow(x, 2n, n);
        if (x === n - 1n) {
          composite = false;
          break;
        }
      }
      
      if (composite) return false;
    }
    
    return true;
  }
  
  static randomBigInt(min, max) {
    const range = max - min;
    const bits = range.toString(2).length;
    const bytes = Math.ceil(bits / 8);
    
    let result;
    do {
      const randomBuffer = randomBytes(bytes);
      result = BigInt('0x' + randomBuffer.toString('hex'));
    } while (result >= range);
    
    return result + min;
  }
  
  static generatePrime(bits) {
    const min = 1n << BigInt(bits - 1);
    const max = (1n << BigInt(bits)) - 1n;
    
    let candidate;
    do {
      candidate = this.randomBigInt(min, max);
      if (candidate % 2n === 0n) candidate += 1n;
    } while (!this.isPrime(candidate));
    
    return candidate;
  }
}

/**
 * Paillier cryptosystem (additive homomorphic)
 */
export class PaillierCrypto {
  constructor(keySize = 2048) {
    this.keySize = keySize;
    this.publicKey = null;
    this.privateKey = null;
  }
  
  /**
   * Generate key pair
   */
  generateKeys() {
    const bits = this.keySize / 2;
    
    // Generate two large primes
    const p = BigIntMath.generatePrime(bits);
    const q = BigIntMath.generatePrime(bits);
    
    const n = p * q;
    const lambda = (p - 1n) * (q - 1n) / BigIntMath.gcd(p - 1n, q - 1n);
    const g = n + 1n;
    
    // Calculate mu
    const mu = BigIntMath.modInverse(
      this._L(BigIntMath.modPow(g, lambda, n * n), n),
      n
    );
    
    this.publicKey = { n, g };
    this.privateKey = { lambda, mu, n };
    
    return {
      publicKey: this.publicKey,
      privateKey: this.privateKey
    };
  }
  
  /**
   * Encrypt plaintext
   */
  encrypt(plaintext, publicKey = this.publicKey) {
    if (!publicKey) throw new Error('Public key required');
    
    const { n, g } = publicKey;
    const m = BigInt(plaintext);
    
    if (m >= n) throw new Error('Plaintext too large');
    
    const r = BigIntMath.randomBigInt(1n, n);
    const c = (BigIntMath.modPow(g, m, n * n) * BigIntMath.modPow(r, n, n * n)) % (n * n);
    
    return {
      ciphertext: c.toString(),
      publicKey: publicKey
    };
  }
  
  /**
   * Decrypt ciphertext
   */
  decrypt(encrypted, privateKey = this.privateKey) {
    if (!privateKey) throw new Error('Private key required');
    
    const { lambda, mu, n } = privateKey;
    const c = BigInt(encrypted.ciphertext);
    
    const m = (this._L(BigIntMath.modPow(c, lambda, n * n), n) * mu) % n;
    
    return m.toString();
  }
  
  /**
   * Homomorphic addition
   */
  add(encrypted1, encrypted2) {
    if (encrypted1.publicKey.n !== encrypted2.publicKey.n) {
      throw new Error('Ciphertexts must use same public key');
    }
    
    const c1 = BigInt(encrypted1.ciphertext);
    const c2 = BigInt(encrypted2.ciphertext);
    const n = BigInt(encrypted1.publicKey.n);
    
    const result = (c1 * c2) % (n * n);
    
    return {
      ciphertext: result.toString(),
      publicKey: encrypted1.publicKey
    };
  }
  
  /**
   * Homomorphic scalar multiplication
   */
  scalarMultiply(encrypted, scalar) {
    const c = BigInt(encrypted.ciphertext);
    const k = BigInt(scalar);
    const n = BigInt(encrypted.publicKey.n);
    
    const result = BigIntMath.modPow(c, k, n * n);
    
    return {
      ciphertext: result.toString(),
      publicKey: encrypted.publicKey
    };
  }
  
  /**
   * L function for Paillier
   */
  _L(u, n) {
    return (u - 1n) / n;
  }
}

/**
 * BFV cryptosystem (fully homomorphic)
 */
export class BFVCrypto {
  constructor(options = {}) {
    this.polyModulusDegree = options.polyModulusDegree || 8192;
    this.coeffModulus = options.coeffModulus || [60, 40, 40, 60];
    this.plainModulus = options.plainModulus || 1024;
    this.securityLevel = options.securityLevel || 128;
    
    this.publicKey = null;
    this.privateKey = null;
    this.relinKeys = null;
  }
  
  /**
   * Generate keys (simplified implementation)
   */
  generateKeys() {
    // In real implementation, would use proper polynomial ring operations
    // This is a simplified version for demonstration
    
    const n = this.polyModulusDegree;
    const q = this.coeffModulus.reduce((a, b) => a * b, 1);
    const t = this.plainModulus;
    
    // Generate secret key (polynomial with small coefficients)
    const secretKey = Array(n).fill(0).map(() => 
      Math.floor(Math.random() * 3) - 1 // {-1, 0, 1}
    );
    
    // Generate error polynomial
    const error = Array(n).fill(0).map(() => 
      Math.floor(Math.random() * 7) - 3 // small error
    );
    
    // Public key: (-a*s + e, a) mod q
    const a = Array(n).fill(0).map(() => 
      Math.floor(Math.random() * q)
    );
    
    const publicKey0 = a.map((ai, i) => 
      (-ai * secretKey[i] + error[i]) % q
    );
    
    this.publicKey = [publicKey0, a];
    this.privateKey = secretKey;
    
    return {
      publicKey: this.publicKey,
      privateKey: this.privateKey
    };
  }
  
  /**
   * Encrypt plaintext
   */
  encrypt(plaintext) {
    if (!this.publicKey) throw new Error('Keys not generated');
    
    const n = this.polyModulusDegree;
    const t = this.plainModulus;
    const q = this.coeffModulus.reduce((a, b) => a * b, 1);
    
    // Convert plaintext to polynomial
    const m = Array(n).fill(0);
    if (Array.isArray(plaintext)) {
      for (let i = 0; i < Math.min(plaintext.length, n); i++) {
        m[i] = plaintext[i] % t;
      }
    } else {
      m[0] = Number(plaintext) % t;
    }
    
    // Generate random polynomials
    const u = Array(n).fill(0).map(() => Math.floor(Math.random() * 3) - 1);
    const e1 = Array(n).fill(0).map(() => Math.floor(Math.random() * 7) - 3);
    const e2 = Array(n).fill(0).map(() => Math.floor(Math.random() * 7) - 3);
    
    // Encrypt: c = (pk[0]*u + e1 + delta*m, pk[1]*u + e2) mod q
    const delta = Math.floor(q / t);
    
    const c0 = this.publicKey[0].map((pk0, i) => 
      (pk0 * u[i] + e1[i] + delta * m[i]) % q
    );
    
    const c1 = this.publicKey[1].map((pk1, i) => 
      (pk1 * u[i] + e2[i]) % q
    );
    
    return {
      ciphertext: [c0, c1],
      scheme: 'bfv'
    };
  }
  
  /**
   * Decrypt ciphertext
   */
  decrypt(encrypted) {
    if (!this.privateKey) throw new Error('Private key required');
    
    const [c0, c1] = encrypted.ciphertext;
    const s = this.privateKey;
    const t = this.plainModulus;
    const q = this.coeffModulus.reduce((a, b) => a * b, 1);
    
    // Decrypt: m = (c0 + c1*s) * t / q mod t
    const delta = Math.floor(q / t);
    
    const result = c0.map((c0i, i) => {
      const temp = (c0i + c1[i] * s[i]) % q;
      return Math.floor((temp * t) / q) % t;
    });
    
    return result.filter(x => x !== 0);
  }
  
  /**
   * Homomorphic addition
   */
  add(encrypted1, encrypted2) {
    const [c0_1, c1_1] = encrypted1.ciphertext;
    const [c0_2, c1_2] = encrypted2.ciphertext;
    const q = this.coeffModulus.reduce((a, b) => a * b, 1);
    
    const result_c0 = c0_1.map((c, i) => (c + c0_2[i]) % q);
    const result_c1 = c1_1.map((c, i) => (c + c1_2[i]) % q);
    
    return {
      ciphertext: [result_c0, result_c1],
      scheme: 'bfv'
    };
  }
  
  /**
   * Homomorphic multiplication
   */
  multiply(encrypted1, encrypted2) {
    // Simplified multiplication (real implementation requires relinearization)
    const [c0_1, c1_1] = encrypted1.ciphertext;
    const [c0_2, c1_2] = encrypted2.ciphertext;
    const q = this.coeffModulus.reduce((a, b) => a * b, 1);
    const t = this.plainModulus;
    
    // This is a simplified version - real BFV requires careful coefficient management
    const result_c0 = c0_1.map((c, i) => 
      Math.floor((c * c0_2[i] * t) / q) % q
    );
    
    const result_c1 = c1_1.map((c, i) => 
      Math.floor((c * c1_2[i] * t) / q) % q
    );
    
    return {
      ciphertext: [result_c0, result_c1],
      scheme: 'bfv'
    };
  }
}

/**
 * Homomorphic encryption system
 */
export class HomomorphicEncryptionSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      defaultScheme: options.defaultScheme || EncryptionScheme.PAILLIER,
      keySize: options.keySize || 2048,
      cachingEnabled: options.cachingEnabled !== false,
      batchSize: options.batchSize || 1000,
      
      // Performance settings
      parallelProcessing: options.parallelProcessing !== false,
      workerCount: options.workerCount || 4,
      
      ...options
    };
    
    // Crypto schemes
    this.paillier = new PaillierCrypto(this.options.keySize);
    this.bfv = new BFVCrypto();
    
    // Key storage
    this.keys = new Map();
    
    // Operation cache
    this.cache = new Map();
    this.cacheStats = {
      hits: 0,
      misses: 0
    };
    
    // Metrics
    this.metrics = {
      totalOperations: 0,
      encryptionTime: 0,
      decryptionTime: 0,
      homomorphicOperations: 0,
      averageLatency: 0
    };
  }
  
  /**
   * Initialize system
   */
  async initialize() {
    logger.info('Initializing homomorphic encryption system');
    
    // Generate default keys
    await this.generateKeys('default', this.options.defaultScheme);
    
    this.emit('initialized');
  }
  
  /**
   * Generate keys for scheme
   */
  async generateKeys(keyId, scheme = this.options.defaultScheme) {
    const startTime = Date.now();
    
    let keys;
    switch (scheme) {
      case EncryptionScheme.PAILLIER:
        keys = this.paillier.generateKeys();
        break;
        
      case EncryptionScheme.BFV:
        keys = this.bfv.generateKeys();
        break;
        
      default:
        throw new Error(`Unsupported scheme: ${scheme}`);
    }
    
    this.keys.set(keyId, {
      scheme,
      ...keys,
      createdAt: Date.now()
    });
    
    logger.info(`Generated keys for scheme ${scheme} (${Date.now() - startTime}ms)`);
    
    this.emit('keys:generated', { keyId, scheme });
    
    return keys;
  }
  
  /**
   * Encrypt data
   */
  async encrypt(data, keyId = 'default') {
    const startTime = Date.now();
    const keyInfo = this.keys.get(keyId);
    
    if (!keyInfo) {
      throw new Error(`Key not found: ${keyId}`);
    }
    
    let result;
    switch (keyInfo.scheme) {
      case EncryptionScheme.PAILLIER:
        result = this.paillier.encrypt(data, keyInfo.publicKey);
        break;
        
      case EncryptionScheme.BFV:
        result = this.bfv.encrypt(data);
        break;
        
      default:
        throw new Error(`Unsupported scheme: ${keyInfo.scheme}`);
    }
    
    const duration = Date.now() - startTime;
    this.metrics.totalOperations++;
    this.metrics.encryptionTime += duration;
    
    this.emit('data:encrypted', {
      keyId,
      scheme: keyInfo.scheme,
      duration
    });
    
    return {
      ...result,
      keyId,
      scheme: keyInfo.scheme,
      encryptedAt: Date.now()
    };
  }
  
  /**
   * Decrypt data
   */
  async decrypt(encryptedData, keyId = 'default') {
    const startTime = Date.now();
    const keyInfo = this.keys.get(keyId);
    
    if (!keyInfo) {
      throw new Error(`Key not found: ${keyId}`);
    }
    
    let result;
    switch (keyInfo.scheme) {
      case EncryptionScheme.PAILLIER:
        result = this.paillier.decrypt(encryptedData, keyInfo.privateKey);
        break;
        
      case EncryptionScheme.BFV:
        result = this.bfv.decrypt(encryptedData);
        break;
        
      default:
        throw new Error(`Unsupported scheme: ${keyInfo.scheme}`);
    }
    
    const duration = Date.now() - startTime;
    this.metrics.totalOperations++;
    this.metrics.decryptionTime += duration;
    
    this.emit('data:decrypted', {
      keyId,
      scheme: keyInfo.scheme,
      duration
    });
    
    return result;
  }
  
  /**
   * Perform homomorphic operations
   */
  async performOperation(operation, operands, options = {}) {
    const startTime = Date.now();
    
    // Check cache
    const cacheKey = this._getCacheKey(operation, operands);
    if (this.options.cachingEnabled && this.cache.has(cacheKey)) {
      this.cacheStats.hits++;
      return this.cache.get(cacheKey);
    }
    
    this.cacheStats.misses++;
    
    let result;
    const scheme = operands[0].scheme;
    
    switch (scheme) {
      case EncryptionScheme.PAILLIER:
        result = await this._performPaillierOperation(operation, operands);
        break;
        
      case EncryptionScheme.BFV:
        result = await this._performBFVOperation(operation, operands);
        break;
        
      default:
        throw new Error(`Unsupported scheme: ${scheme}`);
    }
    
    // Cache result
    if (this.options.cachingEnabled) {
      this.cache.set(cacheKey, result);
    }
    
    const duration = Date.now() - startTime;
    this.metrics.homomorphicOperations++;
    this.metrics.averageLatency = (this.metrics.averageLatency + duration) / 2;
    
    this.emit('operation:completed', {
      operation,
      operandCount: operands.length,
      scheme,
      duration
    });
    
    return result;
  }
  
  /**
   * Batch encrypt multiple values
   */
  async batchEncrypt(dataArray, keyId = 'default') {
    const results = [];
    const batchSize = this.options.batchSize;
    
    for (let i = 0; i < dataArray.length; i += batchSize) {
      const batch = dataArray.slice(i, i + batchSize);
      
      if (this.options.parallelProcessing) {
        const promises = batch.map(data => this.encrypt(data, keyId));
        const batchResults = await Promise.all(promises);
        results.push(...batchResults);
      } else {
        for (const data of batch) {
          const encrypted = await this.encrypt(data, keyId);
          results.push(encrypted);
        }
      }
    }
    
    return results;
  }
  
  /**
   * Secure aggregation (sum of encrypted values)
   */
  async secureSum(encryptedValues) {
    if (encryptedValues.length === 0) {
      throw new Error('No values to aggregate');
    }
    
    let result = encryptedValues[0];
    
    for (let i = 1; i < encryptedValues.length; i++) {
      result = await this.performOperation(OperationType.ADD, [result, encryptedValues[i]]);
    }
    
    return result;
  }
  
  /**
   * Secure average (encrypted)
   */
  async secureAverage(encryptedValues) {
    const sum = await this.secureSum(encryptedValues);
    const count = encryptedValues.length;
    
    // For Paillier, we can divide by scalar
    if (sum.scheme === EncryptionScheme.PAILLIER) {
      const avgEncrypted = await this.performOperation(
        OperationType.MULTIPLY,
        [sum],
        { scalar: 1 / count }
      );
      return avgEncrypted;
    }
    
    throw new Error('Average calculation not supported for this scheme');
  }
  
  /**
   * Privacy-preserving data analysis
   */
  async analyzeEncryptedData(encryptedDatasets) {
    const analysis = {
      totalRecords: 0,
      schemes: new Set(),
      patterns: []
    };
    
    for (const dataset of encryptedDatasets) {
      analysis.totalRecords += dataset.length;
      dataset.forEach(item => analysis.schemes.add(item.scheme));
      
      // Pattern analysis on encrypted data structure
      const pattern = {
        size: dataset.length,
        scheme: dataset[0]?.scheme,
        timestamp: Date.now()
      };
      
      analysis.patterns.push(pattern);
    }
    
    return analysis;
  }
  
  /**
   * Perform Paillier operations
   */
  async _performPaillierOperation(operation, operands) {
    switch (operation) {
      case OperationType.ADD:
        return this.paillier.add(operands[0], operands[1]);
        
      case OperationType.MULTIPLY:
        if (operands.length === 1) {
          // Scalar multiplication
          const scalar = operands[1] || 2;
          return this.paillier.scalarMultiply(operands[0], scalar);
        }
        throw new Error('Paillier does not support ciphertext multiplication');
        
      default:
        throw new Error(`Unsupported Paillier operation: ${operation}`);
    }
  }
  
  /**
   * Perform BFV operations
   */
  async _performBFVOperation(operation, operands) {
    switch (operation) {
      case OperationType.ADD:
        return this.bfv.add(operands[0], operands[1]);
        
      case OperationType.MULTIPLY:
        return this.bfv.multiply(operands[0], operands[1]);
        
      default:
        throw new Error(`Unsupported BFV operation: ${operation}`);
    }
  }
  
  /**
   * Get cache key for operation
   */
  _getCacheKey(operation, operands) {
    const operandHashes = operands.map(op => {
      const content = typeof op.ciphertext === 'string' 
        ? op.ciphertext 
        : JSON.stringify(op.ciphertext);
      return createHash('sha256').update(content).digest('hex').substring(0, 16);
    });
    
    return `${operation}:${operandHashes.join(':')}`;
  }
  
  /**
   * Get key information
   */
  getKeyInfo(keyId) {
    const keyInfo = this.keys.get(keyId);
    if (!keyInfo) return null;
    
    return {
      scheme: keyInfo.scheme,
      createdAt: keyInfo.createdAt,
      hasPublicKey: !!keyInfo.publicKey,
      hasPrivateKey: !!keyInfo.privateKey
    };
  }
  
  /**
   * List all keys
   */
  listKeys() {
    const keys = {};
    for (const [keyId, keyInfo] of this.keys) {
      keys[keyId] = this.getKeyInfo(keyId);
    }
    return keys;
  }
  
  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    this.cacheStats = { hits: 0, misses: 0 };
  }
  
  /**
   * Get system metrics
   */
  getMetrics() {
    const cacheHitRate = this.cacheStats.hits > 0 
      ? (this.cacheStats.hits / (this.cacheStats.hits + this.cacheStats.misses) * 100).toFixed(2) + '%'
      : '0%';
    
    return {
      ...this.metrics,
      cache: {
        ...this.cacheStats,
        hitRate: cacheHitRate,
        size: this.cache.size
      },
      keys: this.keys.size,
      supportedSchemes: Object.values(EncryptionScheme)
    };
  }
  
  /**
   * Export public key
   */
  exportPublicKey(keyId) {
    const keyInfo = this.keys.get(keyId);
    if (!keyInfo) {
      throw new Error(`Key not found: ${keyId}`);
    }
    
    return {
      keyId,
      scheme: keyInfo.scheme,
      publicKey: keyInfo.publicKey,
      createdAt: keyInfo.createdAt
    };
  }
  
  /**
   * Import public key
   */
  importPublicKey(keyData) {
    this.keys.set(keyData.keyId, {
      scheme: keyData.scheme,
      publicKey: keyData.publicKey,
      createdAt: keyData.createdAt,
      imported: true
    });
    
    logger.info(`Imported public key: ${keyData.keyId} (${keyData.scheme})`);
  }
  
  /**
   * Shutdown system
   */
  async shutdown() {
    logger.info('Shutting down homomorphic encryption system');
    
    // Clear sensitive data
    this.keys.clear();
    this.cache.clear();
    
    this.emit('shutdown');
  }
}

export default HomomorphicEncryptionSystem;