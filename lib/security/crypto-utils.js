/**
 * Cryptographic utilities for Otedama
 * Standard secure implementations
 */

import { createHash, randomBytes, pbkdf2Sync } from 'crypto';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('CryptoUtils');

/**
 * Secure hash function using SHA-256 with optional salt
 */
export class SecureHasher {
  constructor() {
    this.algorithm = 'sha256';
  }

  hash(data, salt = null) {
    const hash = createHash(this.algorithm);
    if (salt) hash.update(salt);
    hash.update(data);
    return hash.digest();
  }

  merkleHash(leaves) {
    if (leaves.length === 0) return null;
    if (leaves.length === 1) return leaves[0];

    const pairs = [];
    for (let i = 0; i < leaves.length; i += 2) {
      if (i + 1 < leaves.length) {
        const combined = Buffer.concat([leaves[i], leaves[i + 1]]);
        pairs.push(this.hash(combined));
      } else {
        pairs.push(leaves[i]);
      }
    }

    return this.merkleHash(pairs);
  }
}

/**
 * Standard key derivation using PBKDF2
 */
export class StandardKDF {
  constructor() {
    // Updated to 600,000 iterations for 2025 security standards
    this.iterations = 600000;
    this.saltLength = 32;
    this.keyLength = 32;
  }

  deriveKey(password, salt = null) {
    if (!salt) {
      salt = randomBytes(this.saltLength);
    }

    const key = pbkdf2Sync(password, salt, this.iterations, this.keyLength, 'sha512');
    return { key, salt };
  }

  randomBytes(length) {
    return randomBytes(length);
  }
}

export const secureHasher = new SecureHasher();
export const standardKDF = new StandardKDF();

export default {
  SecureHasher,
  StandardKDF,
  secureHasher,
  standardKDF
};
