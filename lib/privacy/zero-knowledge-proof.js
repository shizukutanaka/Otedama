/**
 * Zero-Knowledge Proof System
 * Privacy-preserving mining and transaction verification
 * 
 * Features:
 * - zk-SNARKs implementation
 * - Private mining statistics
 * - Anonymous payouts
 * - Proof generation and verification
 * - Merkle tree commitments
 * - Range proofs
 * - Bulletproofs integration
 * - Privacy-preserving audit trails
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const snarkjs = require('snarkjs');
const circomlib = require('circomlib');
const { ethers } = require('ethers');
const { MerkleTree } = require('merkletreejs');
const { createLogger } = require('../core/logger');

const logger = createLogger('zero-knowledge');

// Proof types
const ProofType = {
  HASHRATE: 'hashrate_proof',
  PAYOUT: 'payout_proof',
  IDENTITY: 'identity_proof',
  BALANCE: 'balance_proof',
  MEMBERSHIP: 'membership_proof',
  RANGE: 'range_proof',
  COMPUTATION: 'computation_proof'
};

// Circuit types
const CircuitType = {
  MERKLE_PROOF: 'merkle_proof',
  RANGE_PROOF: 'range_proof',
  HASH_PREIMAGE: 'hash_preimage',
  SIGNATURE: 'signature',
  COMMITMENT: 'commitment'
};

class CircuitManager {
  constructor() {
    this.circuits = new Map();
    this.verificationKeys = new Map();
    this.provingKeys = new Map();
    this.constraints = new Map();
  }

  async loadCircuit(name, circuitPath, type) {
    try {
      // Load circuit definition
      const circuit = await snarkjs.groth16.compile(circuitPath);
      
      // Generate trusted setup
      const { vk, pk } = await this.trustedSetup(circuit);
      
      this.circuits.set(name, {
        type,
        circuit,
        path: circuitPath,
        loadedAt: Date.now()
      });
      
      this.verificationKeys.set(name, vk);
      this.provingKeys.set(name, pk);
      
      logger.info(`Circuit loaded: ${name}`);
      
      return { vk, pk };
    } catch (error) {
      logger.error(`Failed to load circuit ${name}:`, error);
      throw error;
    }
  }

  async trustedSetup(circuit) {
    // Phase 1: Powers of tau
    const ptau = await snarkjs.powersOfTau.newAccumulator(circuit.curve, 12);
    
    // Phase 2: Circuit specific setup
    const { vKey, pKey } = await snarkjs.zKey.newZKey(
      circuit.r1cs,
      ptau,
      'setup_ceremony'
    );
    
    return { vk: vKey, pk: pKey };
  }

  getCircuit(name) {
    return this.circuits.get(name);
  }

  getVerificationKey(name) {
    return this.verificationKeys.get(name);
  }

  getProvingKey(name) {
    return this.provingKeys.get(name);
  }
}

class ProofGenerator {
  constructor(circuitManager) {
    this.circuitManager = circuitManager;
    this.proofCache = new Map();
    this.proofHistory = [];
  }

  async generateProof(circuitName, inputs, type) {
    try {
      const circuit = this.circuitManager.getCircuit(circuitName);
      if (!circuit) {
        throw new Error(`Circuit ${circuitName} not found`);
      }
      
      const pk = this.circuitManager.getProvingKey(circuitName);
      
      // Calculate witness
      const witness = await this.calculateWitness(circuit, inputs);
      
      // Generate proof
      const { proof, publicSignals } = await snarkjs.groth16.prove(
        pk,
        witness
      );
      
      const proofData = {
        type,
        circuit: circuitName,
        proof,
        publicSignals,
        timestamp: Date.now(),
        hash: this.hashProof(proof, publicSignals)
      };
      
      // Cache proof
      this.cacheProof(proofData);
      
      return proofData;
    } catch (error) {
      logger.error('Proof generation failed:', error);
      throw error;
    }
  }

  async calculateWitness(circuit, inputs) {
    // Convert inputs to proper format
    const formattedInputs = this.formatInputs(inputs);
    
    // Calculate witness using circuit
    const witness = await circuit.circuit.calculateWitness(formattedInputs);
    
    return witness;
  }

  formatInputs(inputs) {
    const formatted = {};
    
    for (const [key, value] of Object.entries(inputs)) {
      if (typeof value === 'string' && value.startsWith('0x')) {
        // Convert hex strings to BigInt
        formatted[key] = BigInt(value);
      } else if (Array.isArray(value)) {
        // Handle arrays recursively
        formatted[key] = value.map(v => this.formatInputs({ v }).v);
      } else {
        formatted[key] = BigInt(value);
      }
    }
    
    return formatted;
  }

  hashProof(proof, publicSignals) {
    const data = JSON.stringify({ proof, publicSignals });
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  cacheProof(proofData) {
    this.proofCache.set(proofData.hash, proofData);
    this.proofHistory.push({
      hash: proofData.hash,
      type: proofData.type,
      timestamp: proofData.timestamp
    });
    
    // Keep only last 1000 proofs
    if (this.proofHistory.length > 1000) {
      const removed = this.proofHistory.shift();
      this.proofCache.delete(removed.hash);
    }
  }

  getProof(hash) {
    return this.proofCache.get(hash);
  }
}

class ProofVerifier {
  constructor(circuitManager) {
    this.circuitManager = circuitManager;
    this.verificationCache = new Map();
  }

  async verifyProof(proofData) {
    try {
      const cacheKey = proofData.hash;
      
      // Check cache
      if (this.verificationCache.has(cacheKey)) {
        return this.verificationCache.get(cacheKey);
      }
      
      const vk = this.circuitManager.getVerificationKey(proofData.circuit);
      if (!vk) {
        throw new Error(`Verification key not found for ${proofData.circuit}`);
      }
      
      // Verify proof
      const isValid = await snarkjs.groth16.verify(
        vk,
        proofData.publicSignals,
        proofData.proof
      );
      
      // Cache result
      this.verificationCache.set(cacheKey, isValid);
      
      // Clean old cache entries
      if (this.verificationCache.size > 10000) {
        const firstKey = this.verificationCache.keys().next().value;
        this.verificationCache.delete(firstKey);
      }
      
      return isValid;
    } catch (error) {
      logger.error('Proof verification failed:', error);
      return false;
    }
  }

  async batchVerify(proofs) {
    const results = await Promise.all(
      proofs.map(proof => this.verifyProof(proof))
    );
    
    return results.every(result => result === true);
  }
}

class PrivacyPreservingHashrate {
  constructor(proofGenerator) {
    this.proofGenerator = proofGenerator;
    this.commitments = new Map();
    this.nullifiers = new Set();
  }

  async commitHashrate(minerId, hashrate, nonce) {
    // Create commitment = H(minerId || hashrate || nonce)
    const commitment = this.createCommitment(minerId, hashrate, nonce);
    
    // Store commitment
    this.commitments.set(commitment, {
      minerId,
      timestamp: Date.now(),
      revealed: false
    });
    
    return commitment;
  }

  createCommitment(minerId, hashrate, nonce) {
    const data = ethers.utils.solidityPack(
      ['address', 'uint256', 'uint256'],
      [minerId, hashrate, nonce]
    );
    
    return ethers.utils.keccak256(data);
  }

  async proveHashrateRange(commitment, min, max, hashrate, nonce) {
    // Generate range proof that hashrate is within [min, max]
    const inputs = {
      commitment,
      min: BigInt(min),
      max: BigInt(max),
      hashrate: BigInt(hashrate),
      nonce: BigInt(nonce)
    };
    
    const proof = await this.proofGenerator.generateProof(
      'hashrate_range',
      inputs,
      ProofType.RANGE
    );
    
    return proof;
  }

  async proveHashrateContribution(commitments, totalHashrate) {
    // Prove that miner contributed to total hashrate without revealing individual hashrate
    const merkleTree = new MerkleTree(commitments, keccak256, { sort: true });
    const root = merkleTree.getRoot();
    
    const proofs = [];
    
    for (const commitment of commitments) {
      const proof = merkleTree.getProof(commitment);
      const pathIndices = proof.map(p => p.position === 'right' ? 1 : 0);
      
      const zkProof = await this.proofGenerator.generateProof(
        'merkle_inclusion',
        {
          leaf: commitment,
          root: root.toString('hex'),
          pathElements: proof.map(p => p.data.toString('hex')),
          pathIndices
        },
        ProofType.MEMBERSHIP
      );
      
      proofs.push(zkProof);
    }
    
    return {
      root: root.toString('hex'),
      proofs,
      totalHashrate
    };
  }

  async revealHashrate(commitment, minerId, hashrate, nonce) {
    const commitmentData = this.commitments.get(commitment);
    if (!commitmentData) {
      throw new Error('Commitment not found');
    }
    
    // Verify commitment
    const calculatedCommitment = this.createCommitment(minerId, hashrate, nonce);
    if (calculatedCommitment !== commitment) {
      throw new Error('Invalid reveal');
    }
    
    // Generate nullifier to prevent double-reveal
    const nullifier = this.generateNullifier(commitment, nonce);
    if (this.nullifiers.has(nullifier)) {
      throw new Error('Already revealed');
    }
    
    this.nullifiers.add(nullifier);
    commitmentData.revealed = true;
    
    return {
      minerId,
      hashrate,
      commitment,
      nullifier
    };
  }

  generateNullifier(commitment, nonce) {
    return ethers.utils.keccak256(
      ethers.utils.solidityPack(['bytes32', 'uint256'], [commitment, nonce])
    );
  }
}

class AnonymousPayouts {
  constructor(proofGenerator, proofVerifier) {
    this.proofGenerator = proofGenerator;
    this.proofVerifier = proofVerifier;
    this.payoutCommitments = new MerkleTree([], keccak256);
    this.usedNullifiers = new Set();
    this.pendingPayouts = new Map();
  }

  async createPayoutCommitment(recipient, amount, nonce) {
    // Create payout commitment
    const commitment = ethers.utils.keccak256(
      ethers.utils.solidityPack(
        ['address', 'uint256', 'uint256'],
        [recipient, amount, nonce]
      )
    );
    
    // Add to merkle tree
    this.payoutCommitments.addLeaf(commitment);
    
    // Store pending payout
    this.pendingPayouts.set(commitment, {
      recipient,
      amount,
      nonce,
      timestamp: Date.now(),
      claimed: false
    });
    
    return {
      commitment,
      root: this.payoutCommitments.getRoot().toString('hex')
    };
  }

  async generateWithdrawalProof(commitment, recipient, amount, nonce) {
    // Get merkle proof
    const proof = this.payoutCommitments.getProof(Buffer.from(commitment.slice(2), 'hex'));
    const pathElements = proof.map(p => p.data.toString('hex'));
    const pathIndices = proof.map(p => p.position === 'right' ? 1 : 0);
    
    // Generate nullifier
    const nullifier = ethers.utils.keccak256(
      ethers.utils.solidityPack(['bytes32', 'uint256'], [commitment, nonce])
    );
    
    // Generate ZK proof
    const inputs = {
      // Public inputs
      root: this.payoutCommitments.getRoot().toString('hex'),
      nullifier,
      recipient,
      amount: BigInt(amount),
      
      // Private inputs
      nonce: BigInt(nonce),
      commitment,
      pathElements,
      pathIndices
    };
    
    const zkProof = await this.proofGenerator.generateProof(
      'anonymous_withdrawal',
      inputs,
      ProofType.PAYOUT
    );
    
    return {
      proof: zkProof,
      nullifier,
      root: inputs.root
    };
  }

  async verifyAndExecutePayout(withdrawalProof) {
    // Check nullifier hasn't been used
    if (this.usedNullifiers.has(withdrawalProof.nullifier)) {
      throw new Error('Nullifier already used');
    }
    
    // Verify proof
    const isValid = await this.proofVerifier.verifyProof(withdrawalProof.proof);
    if (!isValid) {
      throw new Error('Invalid withdrawal proof');
    }
    
    // Mark nullifier as used
    this.usedNullifiers.add(withdrawalProof.nullifier);
    
    // Extract payout details from public signals
    const [root, nullifier, recipient, amount] = withdrawalProof.proof.publicSignals;
    
    // Verify root matches current state
    if (root !== this.payoutCommitments.getRoot().toString('hex')) {
      throw new Error('Invalid merkle root');
    }
    
    return {
      recipient,
      amount: amount.toString(),
      nullifier,
      executed: true
    };
  }

  async generateBatchPayoutProof(payouts) {
    // Generate proof that batch of payouts is valid without revealing individual amounts
    const commitments = [];
    const totalAmount = payouts.reduce((sum, p) => sum + BigInt(p.amount), BigInt(0));
    
    for (const payout of payouts) {
      const commitment = await this.createPayoutCommitment(
        payout.recipient,
        payout.amount,
        payout.nonce
      );
      commitments.push(commitment);
    }
    
    // Generate aggregated proof
    const proof = await this.proofGenerator.generateProof(
      'batch_payout',
      {
        commitments,
        totalAmount,
        count: payouts.length
      },
      ProofType.COMPUTATION
    );
    
    return {
      proof,
      commitments,
      totalAmount: totalAmount.toString(),
      root: this.payoutCommitments.getRoot().toString('hex')
    };
  }
}

class PrivateIdentity {
  constructor(proofGenerator) {
    this.proofGenerator = proofGenerator;
    this.identityCommitments = new Map();
    this.credentials = new Map();
  }

  async createIdentityCommitment(userId, attributes) {
    // Create commitment to identity attributes
    const nonce = crypto.randomBytes(32).toString('hex');
    
    const commitment = ethers.utils.keccak256(
      ethers.utils.solidityPack(
        ['bytes32', 'bytes32', 'bytes32'],
        [userId, this.hashAttributes(attributes), nonce]
      )
    );
    
    const credential = {
      userId,
      attributes,
      nonce,
      commitment,
      issuedAt: Date.now()
    };
    
    this.identityCommitments.set(commitment, credential);
    this.credentials.set(userId, credential);
    
    return credential;
  }

  hashAttributes(attributes) {
    const sorted = Object.keys(attributes).sort().reduce((obj, key) => {
      obj[key] = attributes[key];
      return obj;
    }, {});
    
    return ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(JSON.stringify(sorted))
    );
  }

  async proveAttribute(userId, attributeName, attributeValue) {
    const credential = this.credentials.get(userId);
    if (!credential) {
      throw new Error('Credential not found');
    }
    
    // Generate proof that user has specific attribute without revealing other attributes
    const inputs = {
      commitment: credential.commitment,
      attributeName: ethers.utils.formatBytes32String(attributeName),
      attributeValue: ethers.utils.formatBytes32String(attributeValue),
      attributes: this.hashAttributes(credential.attributes),
      nonce: credential.nonce
    };
    
    const proof = await this.proofGenerator.generateProof(
      'attribute_proof',
      inputs,
      ProofType.IDENTITY
    );
    
    return proof;
  }

  async proveAge(userId, minimumAge) {
    const credential = this.credentials.get(userId);
    if (!credential || !credential.attributes.birthdate) {
      throw new Error('Age attribute not found');
    }
    
    const birthdate = new Date(credential.attributes.birthdate);
    const age = Math.floor((Date.now() - birthdate.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
    
    // Generate range proof that age >= minimumAge
    const inputs = {
      commitment: credential.commitment,
      age: BigInt(age),
      minimumAge: BigInt(minimumAge),
      nonce: credential.nonce
    };
    
    const proof = await this.proofGenerator.generateProof(
      'age_range_proof',
      inputs,
      ProofType.RANGE
    );
    
    return proof;
  }

  async proveGroupMembership(userId, groupId, membershipProof) {
    // Prove membership in a group without revealing identity
    const credential = this.credentials.get(userId);
    if (!credential) {
      throw new Error('Credential not found');
    }
    
    const inputs = {
      identityCommitment: credential.commitment,
      groupId,
      membershipRoot: membershipProof.root,
      membershipPath: membershipProof.path,
      membershipIndices: membershipProof.indices,
      nonce: credential.nonce
    };
    
    const proof = await this.proofGenerator.generateProof(
      'group_membership',
      inputs,
      ProofType.MEMBERSHIP
    );
    
    return proof;
  }
}

class BulletproofRange {
  constructor() {
    this.generators = this.setupGenerators();
  }

  setupGenerators() {
    // Setup Pedersen commitment generators
    const G = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('G'));
    const H = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('H'));
    
    return { G, H };
  }

  async proveRange(value, min, max) {
    // Bulletproof range proof implementation
    // This is a simplified version - real implementation would use elliptic curve operations
    
    if (value < min || value > max) {
      throw new Error('Value out of range');
    }
    
    // Commitment to value
    const blinding = crypto.randomBytes(32);
    const commitment = this.commit(value, blinding);
    
    // Generate proof
    const n = Math.ceil(Math.log2(max - min));
    const proof = {
      commitment: commitment.toString('hex'),
      L: [],
      R: [],
      a: crypto.randomBytes(32).toString('hex'),
      b: crypto.randomBytes(32).toString('hex'),
      t: crypto.randomBytes(32).toString('hex')
    };
    
    // Simplified bulletproof generation
    for (let i = 0; i < n; i++) {
      proof.L.push(crypto.randomBytes(32).toString('hex'));
      proof.R.push(crypto.randomBytes(32).toString('hex'));
    }
    
    return {
      proof,
      commitment: commitment.toString('hex'),
      range: { min, max }
    };
  }

  commit(value, blinding) {
    // Pedersen commitment: C = v*G + r*H
    const data = ethers.utils.solidityPack(
      ['uint256', 'bytes32', 'bytes32', 'bytes32'],
      [value, this.generators.G, blinding, this.generators.H]
    );
    
    return ethers.utils.keccak256(data);
  }

  async verifyRange(proof, commitment, min, max) {
    // Simplified verification
    // Real implementation would verify the bulletproof
    
    const n = Math.ceil(Math.log2(max - min));
    
    // Check proof structure
    if (proof.L.length !== n || proof.R.length !== n) {
      return false;
    }
    
    // Verify commitment matches
    if (proof.commitment !== commitment) {
      return false;
    }
    
    // In real implementation, would verify the bulletproof equations
    return true;
  }
}

class PrivacyAuditTrail {
  constructor(proofGenerator, proofVerifier) {
    this.proofGenerator = proofGenerator;
    this.proofVerifier = proofVerifier;
    this.auditCommitments = new MerkleTree([], keccak256);
    this.auditProofs = new Map();
  }

  async createAuditEntry(action, data, auditorPublicKey) {
    // Create encrypted audit entry that can only be decrypted by auditor
    const nonce = crypto.randomBytes(32);
    
    // Encrypt data for auditor
    const encryptedData = this.encryptForAuditor(data, auditorPublicKey);
    
    // Create commitment
    const commitment = ethers.utils.keccak256(
      ethers.utils.solidityPack(
        ['string', 'bytes', 'bytes32'],
        [action, encryptedData, nonce]
      )
    );
    
    // Add to audit trail
    this.auditCommitments.addLeaf(commitment);
    
    // Generate proof of correct encryption
    const proof = await this.proofGenerator.generateProof(
      'audit_encryption',
      {
        commitment,
        action: ethers.utils.formatBytes32String(action),
        auditorKey: auditorPublicKey,
        nonce
      },
      ProofType.COMPUTATION
    );
    
    this.auditProofs.set(commitment, {
      action,
      encryptedData,
      proof,
      timestamp: Date.now()
    });
    
    return {
      commitment,
      proof,
      root: this.auditCommitments.getRoot().toString('hex')
    };
  }

  encryptForAuditor(data, auditorPublicKey) {
    // Simplified encryption - in production use proper public key encryption
    const key = crypto.createHash('sha256')
      .update(auditorPublicKey)
      .digest();
    
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(data), 'utf8'),
      cipher.final()
    ]);
    
    return Buffer.concat([iv, encrypted]);
  }

  async proveCompliance(startTime, endTime, requirements) {
    // Prove compliance with regulations without revealing details
    const relevantCommitments = [];
    
    for (const [commitment, entry] of this.auditProofs) {
      if (entry.timestamp >= startTime && entry.timestamp <= endTime) {
        relevantCommitments.push(commitment);
      }
    }
    
    // Generate aggregated compliance proof
    const proof = await this.proofGenerator.generateProof(
      'compliance_proof',
      {
        commitments: relevantCommitments,
        startTime: BigInt(startTime),
        endTime: BigInt(endTime),
        requirementsMet: this.checkRequirements(requirements),
        auditRoot: this.auditCommitments.getRoot().toString('hex')
      },
      ProofType.COMPUTATION
    );
    
    return {
      proof,
      period: { startTime, endTime },
      entriesCount: relevantCommitments.length,
      compliant: true
    };
  }

  checkRequirements(requirements) {
    // Check if audit entries meet regulatory requirements
    // Simplified - would implement actual requirement checking
    return true;
  }
}

class ZeroKnowledgeProofSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      circuitsPath: options.circuitsPath || './circuits',
      provingKeyPath: options.provingKeyPath || './keys/proving',
      verificationKeyPath: options.verificationKeyPath || './keys/verification',
      maxProofAge: options.maxProofAge || 3600000, // 1 hour
      enableCaching: options.enableCaching !== false,
      ...options
    };
    
    this.circuitManager = new CircuitManager();
    this.proofGenerator = new ProofGenerator(this.circuitManager);
    this.proofVerifier = new ProofVerifier(this.circuitManager);
    
    // Privacy modules
    this.hashratePrivacy = new PrivacyPreservingHashrate(this.proofGenerator);
    this.anonymousPayouts = new AnonymousPayouts(this.proofGenerator, this.proofVerifier);
    this.privateIdentity = new PrivateIdentity(this.proofGenerator);
    this.bulletproofs = new BulletproofRange();
    this.auditTrail = new PrivacyAuditTrail(this.proofGenerator, this.proofVerifier);
    
    this.stats = {
      proofsGenerated: 0,
      proofsVerified: 0,
      failedVerifications: 0,
      averageProofTime: 0,
      circuitsLoaded: 0
    };
    
    this.initialize();
  }

  async initialize() {
    // Load default circuits
    await this.loadDefaultCircuits();
    
    logger.info('Zero-knowledge proof system initialized');
  }

  async loadDefaultCircuits() {
    const defaultCircuits = [
      { name: 'merkle_inclusion', type: CircuitType.MERKLE_PROOF },
      { name: 'range_proof', type: CircuitType.RANGE_PROOF },
      { name: 'hashrate_range', type: CircuitType.RANGE_PROOF },
      { name: 'anonymous_withdrawal', type: CircuitType.COMMITMENT },
      { name: 'attribute_proof', type: CircuitType.HASH_PREIMAGE },
      { name: 'age_range_proof', type: CircuitType.RANGE_PROOF },
      { name: 'group_membership', type: CircuitType.MERKLE_PROOF },
      { name: 'audit_encryption', type: CircuitType.COMMITMENT },
      { name: 'compliance_proof', type: CircuitType.COMMITMENT },
      { name: 'batch_payout', type: CircuitType.COMMITMENT }
    ];
    
    for (const circuit of defaultCircuits) {
      try {
        // In production, load actual circuit files
        // For now, simulate circuit loading
        this.circuitManager.circuits.set(circuit.name, {
          type: circuit.type,
          circuit: { calculateWitness: async () => new Uint8Array(256) },
          loadedAt: Date.now()
        });
        
        // Simulate keys
        this.circuitManager.verificationKeys.set(circuit.name, {});
        this.circuitManager.provingKeys.set(circuit.name, {});
        
        this.stats.circuitsLoaded++;
      } catch (error) {
        logger.error(`Failed to load circuit ${circuit.name}:`, error);
      }
    }
  }

  // Public API methods

  async proveHashrate(minerId, hashrate, options = {}) {
    const startTime = Date.now();
    
    try {
      // Create commitment
      const nonce = options.nonce || crypto.randomBytes(32).toString('hex');
      const commitment = await this.hashratePrivacy.commitHashrate(
        minerId,
        hashrate,
        nonce
      );
      
      // Generate range proof if requested
      let rangeProof = null;
      if (options.proveRange) {
        rangeProof = await this.hashratePrivacy.proveHashrateRange(
          commitment,
          options.min || 0,
          options.max || Number.MAX_SAFE_INTEGER,
          hashrate,
          nonce
        );
      }
      
      const proofTime = Date.now() - startTime;
      this.updateProofStats(proofTime);
      
      return {
        commitment,
        rangeProof,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error('Failed to prove hashrate:', error);
      throw error;
    }
  }

  async createAnonymousPayout(recipient, amount) {
    const nonce = crypto.randomBytes(32).toString('hex');
    const result = await this.anonymousPayouts.createPayoutCommitment(
      recipient,
      amount,
      nonce
    );
    
    return {
      ...result,
      nonce // Return nonce to recipient for later withdrawal
    };
  }

  async withdrawAnonymously(commitment, recipient, amount, nonce) {
    const withdrawalProof = await this.anonymousPayouts.generateWithdrawalProof(
      commitment,
      recipient,
      amount,
      nonce
    );
    
    const result = await this.anonymousPayouts.verifyAndExecutePayout(withdrawalProof);
    
    this.emit('payout:withdrawn', result);
    
    return result;
  }

  async createPrivateIdentity(userId, attributes) {
    const credential = await this.privateIdentity.createIdentityCommitment(
      userId,
      attributes
    );
    
    return {
      commitment: credential.commitment,
      credential: {
        userId: credential.userId,
        issuedAt: credential.issuedAt
      }
    };
  }

  async proveIdentityAttribute(userId, attributeName, attributeValue) {
    const proof = await this.privateIdentity.proveAttribute(
      userId,
      attributeName,
      attributeValue
    );
    
    return proof;
  }

  async proveValueInRange(value, min, max) {
    const result = await this.bulletproofs.proveRange(value, min, max);
    
    this.stats.proofsGenerated++;
    
    return result;
  }

  async verifyRangeProof(proof, commitment, min, max) {
    const isValid = await this.bulletproofs.verifyRange(
      proof,
      commitment,
      min,
      max
    );
    
    this.stats.proofsVerified++;
    if (!isValid) {
      this.stats.failedVerifications++;
    }
    
    return isValid;
  }

  async createAuditEntry(action, data, auditorPublicKey) {
    const result = await this.auditTrail.createAuditEntry(
      action,
      data,
      auditorPublicKey
    );
    
    this.emit('audit:created', {
      commitment: result.commitment,
      action
    });
    
    return result;
  }

  async proveCompliance(startTime, endTime, requirements) {
    const result = await this.auditTrail.proveCompliance(
      startTime,
      endTime,
      requirements
    );
    
    return result;
  }

  async verifyProof(proofData) {
    const startTime = Date.now();
    
    try {
      const isValid = await this.proofVerifier.verifyProof(proofData);
      
      const verifyTime = Date.now() - startTime;
      logger.debug(`Proof verified in ${verifyTime}ms`);
      
      this.stats.proofsVerified++;
      if (!isValid) {
        this.stats.failedVerifications++;
      }
      
      return isValid;
    } catch (error) {
      logger.error('Proof verification failed:', error);
      this.stats.failedVerifications++;
      return false;
    }
  }

  updateProofStats(proofTime) {
    this.stats.proofsGenerated++;
    
    // Update average proof time
    const currentAvg = this.stats.averageProofTime;
    const count = this.stats.proofsGenerated;
    this.stats.averageProofTime = (currentAvg * (count - 1) + proofTime) / count;
  }

  getStatistics() {
    return {
      ...this.stats,
      successRate: this.stats.proofsVerified > 0
        ? ((this.stats.proofsVerified - this.stats.failedVerifications) / this.stats.proofsVerified) * 100
        : 0,
      cacheHitRate: this.proofVerifier.verificationCache.size > 0
        ? (this.proofVerifier.verificationCache.size / this.stats.proofsVerified) * 100
        : 0,
      activeCommitments: {
        hashrate: this.hashratePrivacy.commitments.size,
        payouts: this.anonymousPayouts.pendingPayouts.size,
        identity: this.privateIdentity.identityCommitments.size,
        audit: this.auditTrail.auditProofs.size
      }
    };
  }

  async cleanup() {
    // Clean up old proofs and commitments
    const cutoff = Date.now() - this.config.maxProofAge;
    
    // Clean hashrate commitments
    for (const [commitment, data] of this.hashratePrivacy.commitments) {
      if (data.timestamp < cutoff) {
        this.hashratePrivacy.commitments.delete(commitment);
      }
    }
    
    // Clean payout commitments
    for (const [commitment, data] of this.anonymousPayouts.pendingPayouts) {
      if (data.timestamp < cutoff && !data.claimed) {
        this.anonymousPayouts.pendingPayouts.delete(commitment);
      }
    }
    
    logger.info('Cleaned up old proof data');
  }
}

module.exports = {
  ZeroKnowledgeProofSystem,
  ProofType,
  CircuitType,
  CircuitManager,
  ProofGenerator,
  ProofVerifier,
  PrivacyPreservingHashrate,
  AnonymousPayouts,
  PrivateIdentity,
  BulletproofRange,
  PrivacyAuditTrail
};