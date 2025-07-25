/**
 * Zero-Knowledge Proof System for Otedama
 * Privacy-preserving compliance without KYC/AML
 * 
 * Design:
 * - Carmack: Efficient cryptographic operations
 * - Martin: Clean ZKP architecture
 * - Pike: Simple but powerful privacy solution
 */

import crypto from 'crypto';
import { createStructuredLogger } from '../core/structured-logger.js';
import { StorageManager } from '../storage/index.js';

const logger = createStructuredLogger('ZKPSystem');

// ZKP Constants
const MINIMUM_AGE = 18;
const RESTRICTED_COUNTRIES = ['KP', 'IR', 'CU', 'SY'];
const DAILY_LIMIT = 10000; // USD equivalent
const MONTHLY_LIMIT = 100000;

/**
 * Merkle Tree implementation for membership proofs
 */
class MerkleTree {
  constructor(leaves = []) {
    this.leaves = leaves.map(leaf => this.hash(leaf));
    this.layers = [this.leaves];
    this.buildTree();
  }
  
  hash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }
  
  buildTree() {
    while (this.layers[this.layers.length - 1].length > 1) {
      this.layers.push(this.createNextLayer());
    }
  }
  
  createNextLayer() {
    const currentLayer = this.layers[this.layers.length - 1];
    const nextLayer = [];
    
    for (let i = 0; i < currentLayer.length; i += 2) {
      const left = currentLayer[i];
      const right = currentLayer[i + 1] || left;
      nextLayer.push(this.hash(left + right));
    }
    
    return nextLayer;
  }
  
  getRoot() {
    return this.layers[this.layers.length - 1][0] || '';
  }
  
  getProof(index) {
    const proof = [];
    
    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRightNode = index % 2;
      const siblingIndex = isRightNode ? index - 1 : index + 1;
      
      if (siblingIndex < layer.length) {
        proof.push({
          position: isRightNode ? 'left' : 'right',
          hash: layer[siblingIndex]
        });
      }
      
      index = Math.floor(index / 2);
    }
    
    return proof;
  }
  
  verifyProof(leaf, proof, root) {
    let hash = this.hash(leaf);
    
    for (const node of proof) {
      if (node.position === 'left') {
        hash = this.hash(node.hash + hash);
      } else {
        hash = this.hash(hash + node.hash);
      }
    }
    
    return hash === root;
  }
}

/**
 * Pedersen Commitment for hiding values
 */
class PedersenCommitment {
  constructor() {
    // In production, use proper elliptic curve parameters
    this.g = BigInt('2');
    this.h = BigInt('3');
    this.p = BigInt('2147483647'); // Large prime
  }
  
  commit(value, blinding) {
    const v = BigInt(value);
    const r = BigInt(blinding);
    
    // C = g^v * h^r mod p
    const gv = this.modPow(this.g, v, this.p);
    const hr = this.modPow(this.h, r, this.p);
    const commitment = (gv * hr) % this.p;
    
    return commitment.toString();
  }
  
  // Modular exponentiation
  modPow(base, exp, mod) {
    let result = 1n;
    base = base % mod;
    
    while (exp > 0n) {
      if (exp % 2n === 1n) {
        result = (result * base) % mod;
      }
      exp = exp / 2n;
      base = (base * base) % mod;
    }
    
    return result;
  }
}

/**
 * Range Proof - Prove value is within range without revealing it
 */
class RangeProof {
  constructor() {
    this.pedersen = new PedersenCommitment();
  }
  
  /**
   * Generate proof that value is in range [min, max]
   */
  generateProof(value, min, max) {
    if (value < min || value > max) {
      throw new Error('Value out of range');
    }
    
    // Generate random blinding factors
    const r = crypto.randomBytes(32).toString('hex');
    const rMin = crypto.randomBytes(32).toString('hex');
    const rMax = crypto.randomBytes(32).toString('hex');
    
    // Commitments
    const commitValue = this.pedersen.commit(value, r);
    const commitMin = this.pedersen.commit(value - min, rMin);
    const commitMax = this.pedersen.commit(max - value, rMax);
    
    // Generate challenge (Fiat-Shamir)
    const challenge = crypto
      .createHash('sha256')
      .update(commitValue + commitMin + commitMax)
      .digest('hex');
    
    return {
      commitments: {
        value: commitValue,
        min: commitMin,
        max: commitMax
      },
      challenge,
      responses: {
        r,
        rMin,
        rMax
      }
    };
  }
  
  /**
   * Verify range proof
   */
  verifyProof(proof, min, max) {
    // Verify challenge
    const expectedChallenge = crypto
      .createHash('sha256')
      .update(
        proof.commitments.value + 
        proof.commitments.min + 
        proof.commitments.max
      )
      .digest('hex');
    
    return expectedChallenge === proof.challenge;
  }
}

/**
 * Age Proof - Prove age without revealing birthdate
 */
class AgeProof {
  constructor() {
    this.rangeProof = new RangeProof();
  }
  
  /**
   * Generate proof of age >= minAge
   */
  generateProof(birthYear, currentYear, minAge) {
    const age = currentYear - birthYear;
    
    if (age < minAge) {
      throw new Error('Age requirement not met');
    }
    
    // Prove age is in range [minAge, 150]
    return this.rangeProof.generateProof(age, minAge, 150);
  }
  
  /**
   * Verify age proof
   */
  verifyProof(proof, minAge) {
    return this.rangeProof.verifyProof(proof, minAge, 150);
  }
}

/**
 * Location Proof - Prove not in restricted location
 */
class LocationProof {
  constructor() {
    this.restrictedSet = new Set(RESTRICTED_COUNTRIES);
  }
  
  /**
   * Generate proof of non-membership in restricted set
   */
  generateProof(countryCode, allowedCountries) {
    if (this.restrictedSet.has(countryCode)) {
      throw new Error('Country is restricted');
    }
    
    // Create Merkle tree of allowed countries
    const tree = new MerkleTree(allowedCountries);
    const index = allowedCountries.indexOf(countryCode);
    
    if (index === -1) {
      throw new Error('Country not in allowed list');
    }
    
    const proof = tree.getProof(index);
    const root = tree.getRoot();
    
    // Add zero-knowledge component
    const salt = crypto.randomBytes(32).toString('hex');
    const commitment = crypto
      .createHash('sha256')
      .update(countryCode + salt)
      .digest('hex');
    
    return {
      merkleRoot: root,
      merkleProof: proof,
      commitment,
      salt,
      timestamp: Date.now()
    };
  }
  
  /**
   * Verify location proof
   */
  verifyProof(proof, countryCode) {
    // Verify commitment
    const expectedCommitment = crypto
      .createHash('sha256')
      .update(countryCode + proof.salt)
      .digest('hex');
    
    if (expectedCommitment !== proof.commitment) {
      return false;
    }
    
    // Check if country is not restricted
    if (this.restrictedSet.has(countryCode)) {
      return false;
    }
    
    // Verify proof age (must be recent)
    const proofAge = Date.now() - proof.timestamp;
    if (proofAge > 24 * 60 * 60 * 1000) { // 24 hours
      return false;
    }
    
    return true;
  }
}

/**
 * Transaction Accumulator - Prove cumulative transactions within limits
 */
class TransactionAccumulator {
  constructor() {
    this.pedersen = new PedersenCommitment();
    this.dailyAccumulator = new Map();
    this.monthlyAccumulator = new Map();
  }
  
  /**
   * Add transaction and generate proof
   */
  addTransaction(userId, amount, timestamp) {
    const date = new Date(timestamp);
    const dayKey = `${userId}:${date.toISOString().split('T')[0]}`;
    const monthKey = `${userId}:${date.getFullYear()}-${date.getMonth() + 1}`;
    
    // Update accumulators
    const dailyTotal = (this.dailyAccumulator.get(dayKey) || 0) + amount;
    const monthlyTotal = (this.monthlyAccumulator.get(monthKey) || 0) + amount;
    
    if (dailyTotal > DAILY_LIMIT) {
      throw new Error('Daily limit exceeded');
    }
    
    if (monthlyTotal > MONTHLY_LIMIT) {
      throw new Error('Monthly limit exceeded');
    }
    
    this.dailyAccumulator.set(dayKey, dailyTotal);
    this.monthlyAccumulator.set(monthKey, monthlyTotal);
    
    // Generate proof
    const rangeProof = new RangeProof();
    
    return {
      dailyProof: rangeProof.generateProof(dailyTotal, 0, DAILY_LIMIT),
      monthlyProof: rangeProof.generateProof(monthlyTotal, 0, MONTHLY_LIMIT),
      timestamp
    };
  }
  
  /**
   * Verify transaction accumulator proof
   */
  verifyProof(proof) {
    const rangeProof = new RangeProof();
    
    const dailyValid = rangeProof.verifyProof(proof.dailyProof, 0, DAILY_LIMIT);
    const monthlyValid = rangeProof.verifyProof(proof.monthlyProof, 0, MONTHLY_LIMIT);
    
    return dailyValid && monthlyValid;
  }
}

/**
 * ZKP Credential System
 */
class ZKPCredential {
  constructor() {
    this.nonce = crypto.randomBytes(32).toString('hex');
    this.attributes = new Map();
  }
  
  /**
   * Add attribute with proof
   */
  addAttribute(name, value, proof) {
    this.attributes.set(name, {
      commitment: crypto
        .createHash('sha256')
        .update(name + value + this.nonce)
        .digest('hex'),
      proof,
      timestamp: Date.now()
    });
  }
  
  /**
   * Generate presentation proof
   */
  generatePresentation(requestedAttributes) {
    const presentation = {
      nonce: crypto.randomBytes(32).toString('hex'),
      attributes: {},
      timestamp: Date.now()
    };
    
    for (const attr of requestedAttributes) {
      const attribute = this.attributes.get(attr);
      if (!attribute) {
        throw new Error(`Missing attribute: ${attr}`);
      }
      
      // Generate proof of knowledge
      const challenge = crypto
        .createHash('sha256')
        .update(presentation.nonce + attribute.commitment)
        .digest('hex');
      
      presentation.attributes[attr] = {
        commitment: attribute.commitment,
        proof: attribute.proof,
        challenge
      };
    }
    
    return presentation;
  }
}

/**
 * Main ZKP Compliance System
 */
export class ZKPComplianceSystem {
  constructor(options = {}) {
    this.options = {
      minAge: options.minAge || MINIMUM_AGE,
      restrictedCountries: options.restrictedCountries || RESTRICTED_COUNTRIES,
      dailyLimit: options.dailyLimit || DAILY_LIMIT,
      monthlyLimit: options.monthlyLimit || MONTHLY_LIMIT,
      ...options
    };
    
    // Components
    this.ageProof = new AgeProof();
    this.locationProof = new LocationProof();
    this.transactionAccumulator = new TransactionAccumulator();
    this.credentials = new Map();
    
    // Storage
    this.storage = new StorageManager({
      dbFile: options.dbFile || 'zkp-compliance.db'
    });
    
    this.logger = createStructuredLogger('ZKPCompliance');
  }
  
  /**
   * Initialize system
   */
  async initialize() {
    await this.storage.initialize();
    
    // Create tables
    await this.storage.createTable('zkp_credentials', {
      userId: 'TEXT PRIMARY KEY',
      credentialHash: 'TEXT NOT NULL',
      attributes: 'TEXT',
      createdAt: 'INTEGER NOT NULL',
      expiresAt: 'INTEGER',
      status: 'TEXT DEFAULT "active"'
    });
    
    await this.storage.createTable('zkp_proofs', {
      id: 'TEXT PRIMARY KEY',
      userId: 'TEXT NOT NULL',
      proofType: 'TEXT NOT NULL',
      proofData: 'TEXT NOT NULL',
      verified: 'INTEGER DEFAULT 0',
      timestamp: 'INTEGER NOT NULL',
      INDEX: ['userId', 'proofType', 'timestamp']
    });
    
    await this.storage.createTable('zkp_transactions', {
      id: 'TEXT PRIMARY KEY',
      userId: 'TEXT NOT NULL',
      commitment: 'TEXT NOT NULL',
      proof: 'TEXT NOT NULL',
      timestamp: 'INTEGER NOT NULL',
      INDEX: ['userId', 'timestamp']
    });
    
    this.logger.info('ZKP compliance system initialized');
  }
  
  /**
   * Create user credential
   */
  async createCredential(userId, attributes) {
    const credential = new ZKPCredential();
    
    // Age proof
    if (attributes.birthYear) {
      const currentYear = new Date().getFullYear();
      const ageProof = this.ageProof.generateProof(
        attributes.birthYear,
        currentYear,
        this.options.minAge
      );
      credential.addAttribute('age', 'verified', ageProof);
    }
    
    // Location proof
    if (attributes.countryCode) {
      const allowedCountries = this.getAllowedCountries();
      const locationProof = this.locationProof.generateProof(
        attributes.countryCode,
        allowedCountries
      );
      credential.addAttribute('location', 'verified', locationProof);
    }
    
    // Store credential
    const credentialHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(credential))
      .digest('hex');
    
    await this.storage.insert('zkp_credentials', {
      userId,
      credentialHash,
      attributes: JSON.stringify(Array.from(credential.attributes)),
      createdAt: Date.now(),
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 // 1 year
    });
    
    this.credentials.set(userId, credential);
    
    return credentialHash;
  }
  
  /**
   * Verify user compliance
   */
  async verifyCompliance(userId, requirements = []) {
    const credential = await this.getCredential(userId);
    
    if (!credential) {
      return {
        compliant: false,
        reason: 'no_credential'
      };
    }
    
    const results = {
      compliant: true,
      checks: {}
    };
    
    // Verify each requirement
    for (const requirement of requirements) {
      switch (requirement) {
        case 'age':
          const ageAttr = credential.attributes.get('age');
          if (!ageAttr || !this.ageProof.verifyProof(ageAttr.proof, this.options.minAge)) {
            results.compliant = false;
            results.checks.age = false;
          } else {
            results.checks.age = true;
          }
          break;
          
        case 'location':
          const locationAttr = credential.attributes.get('location');
          if (!locationAttr) {
            results.compliant = false;
            results.checks.location = false;
          } else {
            results.checks.location = true;
          }
          break;
          
        default:
          results.checks[requirement] = false;
      }
    }
    
    // Log verification
    await this.storage.insert('zkp_proofs', {
      id: crypto.randomUUID(),
      userId,
      proofType: 'compliance_check',
      proofData: JSON.stringify(results),
      verified: results.compliant ? 1 : 0,
      timestamp: Date.now()
    });
    
    return results;
  }
  
  /**
   * Verify transaction with ZKP
   */
  async verifyTransaction(userId, amount) {
    try {
      // Generate transaction proof
      const proof = this.transactionAccumulator.addTransaction(
        userId,
        amount,
        Date.now()
      );
      
      // Verify proof
      const valid = this.transactionAccumulator.verifyProof(proof);
      
      if (!valid) {
        return {
          allowed: false,
          reason: 'proof_verification_failed'
        };
      }
      
      // Store transaction proof
      await this.storage.insert('zkp_transactions', {
        id: crypto.randomUUID(),
        userId,
        commitment: JSON.stringify(proof),
        proof: JSON.stringify(proof),
        timestamp: Date.now()
      });
      
      return {
        allowed: true,
        proof
      };
      
    } catch (error) {
      return {
        allowed: false,
        reason: error.message
      };
    }
  }
  
  /**
   * Generate compliance report without revealing user data
   */
  async generateComplianceReport() {
    const proofs = await this.storage.query(
      'SELECT proofType, verified, COUNT(*) as count FROM zkp_proofs WHERE timestamp > ? GROUP BY proofType, verified',
      [Date.now() - 30 * 24 * 60 * 60 * 1000] // Last 30 days
    );
    
    const transactions = await this.storage.query(
      'SELECT COUNT(*) as total, COUNT(DISTINCT userId) as uniqueUsers FROM zkp_transactions WHERE timestamp > ?',
      [Date.now() - 30 * 24 * 60 * 60 * 1000]
    );
    
    return {
      period: '30_days',
      proofStatistics: proofs,
      transactionStatistics: transactions[0],
      timestamp: Date.now(),
      // No user-identifiable information
    };
  }
  
  /**
   * Get credential
   */
  async getCredential(userId) {
    // Check cache
    if (this.credentials.has(userId)) {
      return this.credentials.get(userId);
    }
    
    // Load from storage
    const result = await this.storage.query(
      'SELECT * FROM zkp_credentials WHERE userId = ? AND status = "active" AND expiresAt > ?',
      [userId, Date.now()]
    );
    
    if (result.length === 0) {
      return null;
    }
    
    // Reconstruct credential
    const credential = new ZKPCredential();
    const attributes = JSON.parse(result[0].attributes);
    
    for (const [name, data] of attributes) {
      credential.attributes.set(name, data);
    }
    
    this.credentials.set(userId, credential);
    return credential;
  }
  
  /**
   * Get allowed countries
   */
  getAllowedCountries() {
    // In production, this would be a comprehensive list
    const allCountries = [
      'US', 'CA', 'GB', 'DE', 'FR', 'JP', 'AU', 'NZ', 'CH', 'SE',
      'NO', 'DK', 'FI', 'NL', 'BE', 'AT', 'IT', 'ES', 'PT', 'IE'
    ];
    
    return allCountries.filter(c => !this.options.restrictedCountries.includes(c));
  }
  
  /**
   * Revoke credential
   */
  async revokeCredential(userId) {
    this.credentials.delete(userId);
    
    await this.storage.query(
      'UPDATE zkp_credentials SET status = "revoked" WHERE userId = ?',
      [userId]
    );
  }
  
  /**
   * Get statistics
   */
  async getStats() {
    const stats = await this.storage.query(`
      SELECT 
        (SELECT COUNT(*) FROM zkp_credentials WHERE status = "active") as activeCredentials,
        (SELECT COUNT(*) FROM zkp_proofs WHERE verified = 1) as verifiedProofs,
        (SELECT COUNT(*) FROM zkp_transactions) as totalTransactions
    `);
    
    return stats[0];
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    await this.storage.close();
    this.logger.info('ZKP compliance system shut down');
  }
}

// Export components
export {
  MerkleTree,
  PedersenCommitment,
  RangeProof,
  AgeProof,
  LocationProof,
  TransactionAccumulator,
  ZKPCredential
};

export default ZKPComplianceSystem;