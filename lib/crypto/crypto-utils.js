/**
 * Centralized Crypto Utilities for Otedama
 * Provides secure, optimized, and consistent cryptographic operations
 */

import { 
  createHash, 
  createHmac, 
  randomBytes, 
  scrypt, 
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  pbkdf2,
  generateKeyPairSync
} from 'crypto';
import { promisify } from 'util';
import { getLogger } from '../core/logger.js';

const logger = getLogger('CryptoUtils');

// Promisified functions for async operations
const scryptAsync = promisify(scrypt);
const pbkdf2Async = promisify(pbkdf2);

// Algorithm constants
export const HashAlgorithm = {
  SHA256: 'sha256',
  SHA512: 'sha512',
  SHA3_256: 'sha3-256',
  SHA3_512: 'sha3-512',
  BLAKE2B512: 'blake2b512',
  RIPEMD160: 'ripemd160'
};

export const CipherAlgorithm = {
  AES_256_GCM: 'aes-256-gcm',
  AES_256_CBC: 'aes-256-cbc',
  CHACHA20_POLY1305: 'chacha20-poly1305'
};

export const KeyDerivationFunction = {
  SCRYPT: 'scrypt',
  PBKDF2: 'pbkdf2',
  ARGON2: 'argon2'
};

// Configuration constants
const DEFAULT_CONFIG = {
  // Scrypt parameters (recommended for password hashing)
  scrypt: {
    N: 16384,      // CPU/memory cost parameter
    r: 8,          // Block size parameter
    p: 1,          // Parallelization parameter
    keyLength: 64  // Output key length
  },
  
  // PBKDF2 parameters
  pbkdf2: {
    iterations: 100000,
    keyLength: 64,
    digest: 'sha256'
  },
  
  // Default salt length
  saltLength: 32,
  
  // Default IV length for AES
  ivLength: 16,
  
  // Mining difficulty targets
  mining: {
    targetBits: 4,  // Number of leading zero bits required
    maxNonce: 0xFFFFFFFF
  }
};

/**
 * Centralized Crypto Utilities class
 */
export class CryptoUtils {
  constructor(options = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...options
    };
    
    // Performance tracking
    this.stats = {
      hashOperations: 0,
      encryptionOperations: 0,
      keyDerivations: 0,
      signatureVerifications: 0,
      averageHashTime: 0,
      averageEncryptTime: 0
    };
  }

  /**
   * Fast SHA256 hash - optimized for blockchain operations
   */
  sha256(data, encoding = 'hex') {
    const startTime = process.hrtime.bigint();
    
    try {
      const hash = createHash(HashAlgorithm.SHA256);
      
      if (Buffer.isBuffer(data)) {
        hash.update(data);
      } else if (typeof data === 'string') {
        hash.update(data, 'utf8');
      } else {
        hash.update(JSON.stringify(data), 'utf8');
      }
      
      const result = hash.digest(encoding);
      this._updateHashStats(startTime);
      
      return result;
    } catch (error) {
      logger.error('SHA256 hash error:', error);
      throw new Error('Hash operation failed');
    }
  }

  /**
   * Double SHA256 hash (used in Bitcoin)
   */
  doubleSha256(data, encoding = 'hex') {
    const firstHash = this.sha256(data, 'buffer');
    return this.sha256(firstHash, encoding);
  }

  /**
   * SHA256 with HMAC for message authentication
   */
  hmacSha256(data, key, encoding = 'hex') {
    try {
      const hmac = createHmac(HashAlgorithm.SHA256, key);
      
      if (Buffer.isBuffer(data)) {
        hmac.update(data);
      } else {
        hmac.update(data, 'utf8');
      }
      
      return hmac.digest(encoding);
    } catch (error) {
      logger.error('HMAC SHA256 error:', error);
      throw new Error('HMAC operation failed');
    }
  }

  /**
   * Secure random bytes generation
   */
  randomBytes(length, encoding = 'hex') {
    try {
      const bytes = randomBytes(length);
      return encoding ? bytes.toString(encoding) : bytes;
    } catch (error) {
      logger.error('Random bytes generation error:', error);
      throw new Error('Random bytes generation failed');
    }
  }

  /**
   * Generate cryptographically secure random integer
   */
  randomInt(min = 0, max = Number.MAX_SAFE_INTEGER) {
    const range = max - min;
    const bytesNeeded = Math.ceil(Math.log2(range) / 8);
    const maxValidValue = Math.floor(256 ** bytesNeeded / range) * range;
    
    let randomValue;
    do {
      const bytes = randomBytes(bytesNeeded);
      randomValue = bytes.readUIntBE(0, bytesNeeded);
    } while (randomValue >= maxValidValue);
    
    return min + (randomValue % range);
  }

  /**
   * Secure password hashing with Scrypt
   */
  async hashPassword(password, salt = null) {
    const startTime = process.hrtime.bigint();
    
    try {
      const actualSalt = salt || randomBytes(this.config.saltLength);
      const saltBuffer = Buffer.isBuffer(actualSalt) ? actualSalt : Buffer.from(actualSalt, 'hex');
      
      const hash = await scryptAsync(password, saltBuffer, this.config.scrypt.keyLength, {
        N: this.config.scrypt.N,
        r: this.config.scrypt.r,
        p: this.config.scrypt.p
      });
      
      this._updateKeyDerivationStats(startTime);
      
      return {
        hash: hash.toString('hex'),
        salt: saltBuffer.toString('hex'),
        algorithm: KeyDerivationFunction.SCRYPT,
        params: this.config.scrypt
      };
    } catch (error) {
      logger.error('Password hashing error:', error);
      throw new Error('Password hashing failed');
    }
  }

  /**
   * Verify password against hash
   */
  async verifyPassword(password, storedHash, salt, algorithm = KeyDerivationFunction.SCRYPT) {
    try {
      let derivedHash;
      const saltBuffer = Buffer.from(salt, 'hex');
      
      switch (algorithm) {
        case KeyDerivationFunction.SCRYPT:
          derivedHash = await scryptAsync(password, saltBuffer, this.config.scrypt.keyLength, {
            N: this.config.scrypt.N,
            r: this.config.scrypt.r,
            p: this.config.scrypt.p
          });
          break;
          
        case KeyDerivationFunction.PBKDF2:
          derivedHash = await pbkdf2Async(password, saltBuffer, 
            this.config.pbkdf2.iterations, 
            this.config.pbkdf2.keyLength, 
            this.config.pbkdf2.digest
          );
          break;
          
        default:
          throw new Error(`Unsupported KDF: ${algorithm}`);
      }
      
      const storedHashBuffer = Buffer.from(storedHash, 'hex');
      return timingSafeEqual(derivedHash, storedHashBuffer);
    } catch (error) {
      logger.error('Password verification error:', error);
      return false;
    }
  }

  /**
   * AES-256-GCM encryption
   */
  encrypt(plaintext, key, additionalData = null) {
    const startTime = process.hrtime.bigint();
    
    try {
      const keyBuffer = Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex');
      const iv = randomBytes(this.config.ivLength);
      
      const cipher = createCipheriv(CipherAlgorithm.AES_256_GCM, keyBuffer, iv);
      
      if (additionalData) {
        cipher.setAAD(Buffer.isBuffer(additionalData) ? additionalData : Buffer.from(additionalData, 'utf8'));
      }
      
      let encrypted = cipher.update(plaintext, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      const authTag = cipher.getAuthTag();
      
      this._updateEncryptionStats(startTime);
      
      return {
        encrypted,
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        algorithm: CipherAlgorithm.AES_256_GCM
      };
    } catch (error) {
      logger.error('Encryption error:', error);
      throw new Error('Encryption failed');
    }
  }

  /**
   * AES-256-GCM decryption
   */
  decrypt(encryptedData, key, additionalData = null) {
    try {
      const keyBuffer = Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex');
      const iv = Buffer.from(encryptedData.iv, 'hex');
      const authTag = Buffer.from(encryptedData.authTag, 'hex');
      
      const decipher = createDecipheriv(CipherAlgorithm.AES_256_GCM, keyBuffer, iv);
      decipher.setAuthTag(authTag);
      
      if (additionalData) {
        decipher.setAAD(Buffer.isBuffer(additionalData) ? additionalData : Buffer.from(additionalData, 'utf8'));
      }
      
      let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      logger.error('Decryption error:', error);
      throw new Error('Decryption failed');
    }
  }

  /**
   * Key derivation from password using PBKDF2
   */
  async deriveKey(password, salt, iterations = null, keyLength = 32) {
    const startTime = process.hrtime.bigint();
    
    try {
      const actualIterations = iterations || this.config.pbkdf2.iterations;
      const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(salt, 'hex');
      
      const key = await pbkdf2Async(password, saltBuffer, actualIterations, keyLength, 'sha256');
      
      this._updateKeyDerivationStats(startTime);
      
      return key;
    } catch (error) {
      logger.error('Key derivation error:', error);
      throw new Error('Key derivation failed');
    }
  }

  /**
   * Generate RSA key pair for signatures
   */
  generateKeyPair(keySize = 2048) {
    try {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', {
        modulusLength: keySize,
        publicKeyEncoding: {
          type: 'spki',
          format: 'pem'
        },
        privateKeyEncoding: {
          type: 'pkcs8',
          format: 'pem'
        }
      });
      
      return { publicKey, privateKey };
    } catch (error) {
      logger.error('Key pair generation error:', error);
      throw new Error('Key pair generation failed');
    }
  }

  /**
   * Mining proof-of-work hash validation
   */
  validateProofOfWork(blockHash, difficulty) {
    try {
      const hash = Buffer.from(blockHash, 'hex');
      const target = this._calculateTarget(difficulty);
      
      // Check if hash meets difficulty requirement
      return this._hashMeetsTarget(hash, target);
    } catch (error) {
      logger.error('PoW validation error:', error);
      return false;
    }
  }

  /**
   * Mining hash with nonce
   */
  mineBlock(blockData, difficulty, maxNonce = this.config.mining.maxNonce) {
    let nonce = 0;
    const target = this._calculateTarget(difficulty);
    const baseData = JSON.stringify(blockData);
    
    while (nonce <= maxNonce) {
      const data = baseData + nonce;
      const hash = this.sha256(data, 'buffer');
      
      if (this._hashMeetsTarget(hash, target)) {
        return {
          hash: hash.toString('hex'),
          nonce,
          difficulty,
          timestamp: Date.now()
        };
      }
      
      nonce++;
    }
    
    return null; // No valid nonce found
  }

  /**
   * Timing-safe string comparison
   */
  timingSafeEqual(a, b) {
    try {
      const bufferA = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
      const bufferB = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
      
      if (bufferA.length !== bufferB.length) {
        return false;
      }
      
      return timingSafeEqual(bufferA, bufferB);
    } catch (error) {
      logger.error('Timing safe comparison error:', error);
      return false;
    }
  }

  /**
   * Hash data with multiple algorithms for extra security
   */
  multiHash(data, algorithms = [HashAlgorithm.SHA256, HashAlgorithm.SHA3_256]) {
    const hashes = {};
    
    for (const algorithm of algorithms) {
      try {
        const hash = createHash(algorithm);
        
        if (Buffer.isBuffer(data)) {
          hash.update(data);
        } else {
          hash.update(data, 'utf8');
        }
        
        hashes[algorithm] = hash.digest('hex');
      } catch (error) {
        logger.warn(`Multi-hash failed for algorithm ${algorithm}:`, error);
      }
    }
    
    return hashes;
  }

  /**
   * Generate secure API key
   */
  generateApiKey(prefix = 'otd_', length = 32) {
    const randomPart = this.randomBytes(length, 'base64url');
    return `${prefix}${randomPart}`;
  }

  /**
   * Generate secure session token
   */
  generateSessionToken() {
    const timestamp = Date.now().toString(36);
    const random = this.randomBytes(24, 'base64url');
    return `${timestamp}-${random}`;
  }

  /**
   * Hash API key for storage
   */
  hashApiKey(apiKey) {
    return this.sha256(apiKey);
  }

  /**
   * Create merkle tree root hash
   */
  createMerkleRoot(transactions) {
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return this.sha256('');
    }
    
    if (transactions.length === 1) {
      return this.sha256(transactions[0]);
    }
    
    let level = transactions.map(tx => this.sha256(tx, 'buffer'));
    
    while (level.length > 1) {
      const nextLevel = [];
      
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1] || left; // Duplicate last if odd number
        
        const combined = Buffer.concat([left, right]);
        nextLevel.push(this.sha256(combined, 'buffer'));
      }
      
      level = nextLevel;
    }
    
    return level[0].toString('hex');
  }

  /**
   * Get performance statistics
   */
  getStats() {
    return {
      ...this.stats,
      cacheHitRate: this.stats.hashOperations > 0 ? 
        (this.stats.hashOperations - this.stats.averageHashTime) / this.stats.hashOperations : 0
    };
  }

  /**
   * Reset performance statistics
   */
  resetStats() {
    this.stats = {
      hashOperations: 0,
      encryptionOperations: 0,
      keyDerivations: 0,
      signatureVerifications: 0,
      averageHashTime: 0,
      averageEncryptTime: 0
    };
  }

  // Private helper methods

  _calculateTarget(difficulty) {
    // Simple difficulty: number of leading zero bits required
    const targetBits = difficulty * 4; // 4 bits per hex digit
    const target = Buffer.alloc(32, 0xFF);
    
    const byteOffset = Math.floor(targetBits / 8);
    const bitOffset = targetBits % 8;
    
    // Set leading bytes to 0
    for (let i = 0; i < byteOffset; i++) {
      target[i] = 0x00;
    }
    
    // Set partial byte
    if (bitOffset > 0) {
      target[byteOffset] = 0xFF >> bitOffset;
    }
    
    return target;
  }

  _hashMeetsTarget(hash, target) {
    for (let i = 0; i < hash.length; i++) {
      if (hash[i] < target[i]) {
        return true;
      } else if (hash[i] > target[i]) {
        return false;
      }
    }
    return true; // Equal is considered meeting target
  }

  _updateHashStats(startTime) {
    const endTime = process.hrtime.bigint();
    const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds
    
    this.stats.hashOperations++;
    const alpha = 0.1;
    this.stats.averageHashTime = alpha * duration + (1 - alpha) * this.stats.averageHashTime;
  }

  _updateEncryptionStats(startTime) {
    const endTime = process.hrtime.bigint();
    const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds
    
    this.stats.encryptionOperations++;
    const alpha = 0.1;
    this.stats.averageEncryptTime = alpha * duration + (1 - alpha) * this.stats.averageEncryptTime;
  }

  _updateKeyDerivationStats(startTime) {
    const endTime = process.hrtime.bigint();
    const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds
    
    this.stats.keyDerivations++;
    // Key derivation is expensive, so we track it separately
  }
}

// Create singleton instance
let cryptoUtilsInstance = null;

/**
 * Get or create crypto utils instance
 */
export function getCryptoUtils(options = {}) {
  if (!cryptoUtilsInstance) {
    cryptoUtilsInstance = new CryptoUtils(options);
  }
  return cryptoUtilsInstance;
}

// Convenience functions for common operations
export const sha256 = (data) => getCryptoUtils().sha256(data);
export const doubleSha256 = (data) => getCryptoUtils().doubleSha256(data);
export const hmacSha256 = (data, key) => getCryptoUtils().hmacSha256(data, key);
export const randomBytes = (length, encoding) => getCryptoUtils().randomBytes(length, encoding);
export const timingSafeEqual = (a, b) => getCryptoUtils().timingSafeEqual(a, b);
export const generateApiKey = (prefix, length) => getCryptoUtils().generateApiKey(prefix, length);
export const hashApiKey = (apiKey) => getCryptoUtils().hashApiKey(apiKey);

export default CryptoUtils;