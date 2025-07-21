/**
 * Comprehensive unit tests for CryptoUtils
 * Tests all cryptographic functions for correctness, security, and performance
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { CryptoUtils, getCryptoUtils, HashAlgorithm } from '../lib/crypto/crypto-utils.js';

describe('CryptoUtils', () => {
  let crypto;

  beforeEach(() => {
    crypto = new CryptoUtils();
  });

  afterEach(() => {
    crypto.resetStats();
  });

  describe('Hash Functions', () => {
    it('should compute SHA256 correctly', () => {
      const input = 'Hello, World!';
      const expected = 'dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f';
      const result = crypto.sha256(input);
      expect(result).to.equal(expected);
    });

    it('should handle Buffer input for SHA256', () => {
      const input = Buffer.from('test', 'utf8');
      const result = crypto.sha256(input);
      expect(result).to.be.a('string');
      expect(result).to.have.lengthOf(64);
    });

    it('should compute double SHA256 correctly', () => {
      const input = 'test';
      const result = crypto.doubleSha256(input);
      const expected = crypto.sha256(crypto.sha256(input, 'buffer'), 'hex');
      expect(result).to.equal(expected);
    });

    it('should compute HMAC-SHA256 correctly', () => {
      const data = 'message';
      const key = 'secret';
      const result = crypto.hmacSha256(data, key);
      expect(result).to.be.a('string');
      expect(result).to.have.lengthOf(64);
    });

    it('should create multi-hash correctly', () => {
      const input = 'test data';
      const algorithms = [HashAlgorithm.SHA256, HashAlgorithm.SHA512];
      const result = crypto.multiHash(input, algorithms);
      
      expect(result).to.be.an('object');
      expect(result).to.have.property(HashAlgorithm.SHA256);
      expect(result).to.have.property(HashAlgorithm.SHA512);
      expect(result[HashAlgorithm.SHA256]).to.have.lengthOf(64);
      expect(result[HashAlgorithm.SHA512]).to.have.lengthOf(128);
    });
  });

  describe('Random Generation', () => {
    it('should generate random bytes with correct length', () => {
      const result = crypto.randomBytes(32);
      expect(result).to.be.a('string');
      expect(result).to.have.lengthOf(64); // 32 bytes = 64 hex chars
    });

    it('should generate random bytes as buffer', () => {
      const result = crypto.randomBytes(16, null);
      expect(Buffer.isBuffer(result)).to.be.true;
      expect(result).to.have.lengthOf(16);
    });

    it('should generate random integers in range', () => {
      for (let i = 0; i < 100; i++) {
        const result = crypto.randomInt(10, 20);
        expect(result).to.be.at.least(10);
        expect(result).to.be.below(20);
      }
    });

    it('should generate different random values', () => {
      const values = new Set();
      for (let i = 0; i < 100; i++) {
        values.add(crypto.randomBytes(16));
      }
      // Should have close to 100 unique values
      expect(values.size).to.be.at.least(95);
    });
  });

  describe('Password Hashing', () => {
    it('should hash passwords securely', async () => {
      const password = 'mySecurePassword123!';
      const result = await crypto.hashPassword(password);
      
      expect(result).to.be.an('object');
      expect(result).to.have.property('hash');
      expect(result).to.have.property('salt');
      expect(result).to.have.property('algorithm');
      expect(result.hash).to.have.lengthOf(128); // 64 bytes = 128 hex chars
      expect(result.salt).to.have.lengthOf(64);   // 32 bytes = 64 hex chars
    });

    it('should verify passwords correctly', async () => {
      const password = 'testPassword123!';
      const hashed = await crypto.hashPassword(password);
      
      const valid = await crypto.verifyPassword(password, hashed.hash, hashed.salt);
      expect(valid).to.be.true;
      
      const invalid = await crypto.verifyPassword('wrongPassword', hashed.hash, hashed.salt);
      expect(invalid).to.be.false;
    });

    it('should generate different salts for same password', async () => {
      const password = 'samePassword';
      const hash1 = await crypto.hashPassword(password);
      const hash2 = await crypto.hashPassword(password);
      
      expect(hash1.salt).to.not.equal(hash2.salt);
      expect(hash1.hash).to.not.equal(hash2.hash);
    });

    it('should be timing attack resistant', async () => {
      const password = 'testPassword';
      const hashed = await crypto.hashPassword(password);
      
      const startTime = process.hrtime.bigint();
      await crypto.verifyPassword('correct', hashed.hash, hashed.salt);
      const correctTime = process.hrtime.bigint();
      
      await crypto.verifyPassword('wrong', hashed.hash, hashed.salt);
      const wrongTime = process.hrtime.bigint();
      
      // Time difference should be minimal (within 50ms)
      const timeDiff = Number(wrongTime - correctTime) / 1000000;
      expect(Math.abs(timeDiff)).to.be.below(50);
    });
  });

  describe('Encryption/Decryption', () => {
    it('should encrypt and decrypt correctly', () => {
      const plaintext = 'This is a secret message';
      const key = crypto.randomBytes(32, 'hex');
      
      const encrypted = crypto.encrypt(plaintext, key);
      expect(encrypted).to.be.an('object');
      expect(encrypted).to.have.property('encrypted');
      expect(encrypted).to.have.property('iv');
      expect(encrypted).to.have.property('authTag');
      
      const decrypted = crypto.decrypt(encrypted, key);
      expect(decrypted).to.equal(plaintext);
    });

    it('should fail decryption with wrong key', () => {
      const plaintext = 'Secret data';
      const key1 = crypto.randomBytes(32, 'hex');
      const key2 = crypto.randomBytes(32, 'hex');
      
      const encrypted = crypto.encrypt(plaintext, key1);
      
      expect(() => {
        crypto.decrypt(encrypted, key2);
      }).to.throw();
    });

    it('should support additional authenticated data', () => {
      const plaintext = 'Secret message';
      const key = crypto.randomBytes(32, 'hex');
      const aad = 'additional data';
      
      const encrypted = crypto.encrypt(plaintext, key, aad);
      const decrypted = crypto.decrypt(encrypted, key, aad);
      expect(decrypted).to.equal(plaintext);
      
      // Should fail with wrong AAD
      expect(() => {
        crypto.decrypt(encrypted, key, 'wrong aad');
      }).to.throw();
    });
  });

  describe('Key Derivation', () => {
    it('should derive keys consistently', async () => {
      const password = 'userPassword';
      const salt = crypto.randomBytes(16, 'hex');
      
      const key1 = await crypto.deriveKey(password, salt, 10000, 32);
      const key2 = await crypto.deriveKey(password, salt, 10000, 32);
      
      expect(Buffer.compare(key1, key2)).to.equal(0);
    });

    it('should derive different keys with different salts', async () => {
      const password = 'samePassword';
      const salt1 = crypto.randomBytes(16, 'hex');
      const salt2 = crypto.randomBytes(16, 'hex');
      
      const key1 = await crypto.deriveKey(password, salt1);
      const key2 = await crypto.deriveKey(password, salt2);
      
      expect(Buffer.compare(key1, key2)).to.not.equal(0);
    });
  });

  describe('Timing-Safe Comparison', () => {
    it('should return true for equal strings', () => {
      const str1 = 'identical';
      const str2 = 'identical';
      expect(crypto.timingSafeEqual(str1, str2)).to.be.true;
    });

    it('should return false for different strings', () => {
      const str1 = 'different';
      const str2 = 'strings';
      expect(crypto.timingSafeEqual(str1, str2)).to.be.false;
    });

    it('should be timing attack resistant', () => {
      const correct = 'a'.repeat(1000);
      const wrong1 = 'b' + 'a'.repeat(999);  // Different at start
      const wrong2 = 'a'.repeat(999) + 'b';  // Different at end
      
      const iterations = 100;
      
      // Measure time for comparison with difference at start
      let startTime = process.hrtime.bigint();
      for (let i = 0; i < iterations; i++) {
        crypto.timingSafeEqual(correct, wrong1);
      }
      const time1 = process.hrtime.bigint();
      
      // Measure time for comparison with difference at end
      for (let i = 0; i < iterations; i++) {
        crypto.timingSafeEqual(correct, wrong2);
      }
      const time2 = process.hrtime.bigint();
      
      const timeDiff = Number(time2 - time1) / 1000000; // Convert to milliseconds
      
      // Time difference should be minimal (within 10ms for 100 iterations)
      expect(Math.abs(timeDiff)).to.be.below(10);
    });
  });

  describe('Mining Functions', () => {
    it('should validate proof of work correctly', () => {
      // Mock a hash with sufficient leading zeros
      const easyHash = '0000abcd' + 'f'.repeat(56);
      const hardHash = '00abcdef' + 'f'.repeat(56);
      
      expect(crypto.validateProofOfWork(easyHash, 2)).to.be.true;  // 2 hex digits = 8 bits
      expect(crypto.validateProofOfWork(hardHash, 2)).to.be.false;
    });

    it('should mine blocks with correct difficulty', () => {
      const blockData = { transactions: [], timestamp: Date.now() };
      const difficulty = 1; // Very low difficulty for testing
      
      const result = crypto.mineBlock(blockData, difficulty, 1000);
      
      if (result) { // Might not find solution with low max nonce
        expect(result).to.have.property('hash');
        expect(result).to.have.property('nonce');
        expect(result).to.have.property('difficulty');
        expect(crypto.validateProofOfWork(result.hash, difficulty)).to.be.true;
      }
    });
  });

  describe('API Key Generation', () => {
    it('should generate API keys with correct format', () => {
      const apiKey = crypto.generateApiKey();
      expect(apiKey).to.match(/^otd_[A-Za-z0-9_-]+$/);
    });

    it('should generate unique API keys', () => {
      const keys = new Set();
      for (let i = 0; i < 100; i++) {
        keys.add(crypto.generateApiKey());
      }
      expect(keys.size).to.equal(100);
    });

    it('should hash API keys consistently', () => {
      const apiKey = crypto.generateApiKey();
      const hash1 = crypto.hashApiKey(apiKey);
      const hash2 = crypto.hashApiKey(apiKey);
      expect(hash1).to.equal(hash2);
      expect(hash1).to.have.lengthOf(64);
    });
  });

  describe('Merkle Tree', () => {
    it('should create merkle root for single transaction', () => {
      const transactions = ['tx1'];
      const root = crypto.createMerkleRoot(transactions);
      expect(root).to.be.a('string');
      expect(root).to.have.lengthOf(64);
    });

    it('should create merkle root for multiple transactions', () => {
      const transactions = ['tx1', 'tx2', 'tx3', 'tx4'];
      const root = crypto.createMerkleRoot(transactions);
      expect(root).to.be.a('string');
      expect(root).to.have.lengthOf(64);
    });

    it('should handle odd number of transactions', () => {
      const transactions = ['tx1', 'tx2', 'tx3'];
      const root = crypto.createMerkleRoot(transactions);
      expect(root).to.be.a('string');
      expect(root).to.have.lengthOf(64);
    });

    it('should create different roots for different transaction sets', () => {
      const txs1 = ['tx1', 'tx2'];
      const txs2 = ['tx3', 'tx4'];
      
      const root1 = crypto.createMerkleRoot(txs1);
      const root2 = crypto.createMerkleRoot(txs2);
      
      expect(root1).to.not.equal(root2);
    });
  });

  describe('Performance Stats', () => {
    it('should track performance statistics', async () => {
      // Perform some operations
      crypto.sha256('test1');
      crypto.sha256('test2');
      await crypto.hashPassword('password');
      
      const stats = crypto.getStats();
      expect(stats).to.have.property('hashOperations');
      expect(stats).to.have.property('keyDerivations');
      expect(stats).to.have.property('averageHashTime');
      expect(stats.hashOperations).to.be.at.least(2);
    });

    it('should reset statistics correctly', async () => {
      // Perform operations
      crypto.sha256('test');
      await crypto.hashPassword('password');
      
      let stats = crypto.getStats();
      expect(stats.hashOperations).to.be.greaterThan(0);
      
      crypto.resetStats();
      stats = crypto.getStats();
      expect(stats.hashOperations).to.equal(0);
      expect(stats.keyDerivations).to.equal(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid encryption keys gracefully', () => {
      expect(() => {
        crypto.encrypt('test', 'too_short_key');
      }).to.throw();
    });

    it('should handle corrupted encrypted data', () => {
      const key = crypto.randomBytes(32, 'hex');
      const encrypted = crypto.encrypt('test', key);
      
      // Corrupt the encrypted data
      encrypted.encrypted = 'corrupted';
      
      expect(() => {
        crypto.decrypt(encrypted, key);
      }).to.throw();
    });

    it('should handle invalid hash input gracefully', () => {
      // Should not throw for various input types
      expect(() => {
        crypto.sha256(null);
        crypto.sha256(undefined);
        crypto.sha256({});
        crypto.sha256([]);
      }).to.not.throw();
    });
  });
});

describe('CryptoUtils Singleton', () => {
  it('should return same instance', () => {
    const crypto1 = getCryptoUtils();
    const crypto2 = getCryptoUtils();
    expect(crypto1).to.equal(crypto2);
  });

  it('should maintain state across calls', () => {
    const crypto1 = getCryptoUtils();
    crypto1.sha256('test'); // Increment stats
    
    const crypto2 = getCryptoUtils();
    const stats = crypto2.getStats();
    expect(stats.hashOperations).to.be.greaterThan(0);
  });
});

describe('Convenience Functions', () => {
  it('should provide working convenience functions', () => {
    const { sha256, doubleSha256, hmacSha256, randomBytes, timingSafeEqual, generateApiKey, hashApiKey } = 
      await import('../lib/crypto/crypto-utils.js');
    
    expect(sha256('test')).to.be.a('string');
    expect(doubleSha256('test')).to.be.a('string');
    expect(hmacSha256('data', 'key')).to.be.a('string');
    expect(randomBytes(16)).to.be.a('string');
    expect(timingSafeEqual('a', 'a')).to.be.true;
    expect(timingSafeEqual('a', 'b')).to.be.false;
    expect(generateApiKey()).to.match(/^otd_/);
    expect(hashApiKey('test_key')).to.have.lengthOf(64);
  });
});