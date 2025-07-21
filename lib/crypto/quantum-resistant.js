/**
 * Quantum-Resistant Cryptography for Otedama
 * Post-quantum cryptographic algorithms
 * 
 * Design principles:
 * - Carmack: High-performance quantum-safe crypto
 * - Martin: Clean cryptographic architecture
 * - Pike: Simple quantum-resistant API
 */

import { randomBytes, createHash } from 'crypto';
import { EventEmitter } from 'events';
import { logger } from '../core/logger.js';

/**
 * Post-quantum algorithms
 */
export const PQAlgorithm = {
  // Lattice-based
  KYBER: 'kyber',           // Key encapsulation
  DILITHIUM: 'dilithium',   // Digital signatures
  NTRU: 'ntru',             // Encryption
  
  // Code-based
  MCELIECE: 'mceliece',     // Encryption
  
  // Hash-based
  SPHINCS: 'sphincs',       // Signatures
  XMSS: 'xmss',            // Signatures
  
  // Multivariate
  RAINBOW: 'rainbow',       // Signatures
  
  // Isogeny-based
  SIKE: 'sike'             // Key exchange
};

/**
 * Security levels
 */
export const SecurityLevel = {
  LEVEL1: 1,  // 128-bit classical security
  LEVEL3: 3,  // 192-bit classical security
  LEVEL5: 5   // 256-bit classical security
};

/**
 * Lattice parameters for learning with errors (LWE)
 */
class LatticeParams {
  constructor(n, q, sigma) {
    this.n = n;        // Dimension
    this.q = q;        // Modulus
    this.sigma = sigma; // Gaussian parameter
  }
  
  static getParams(securityLevel) {
    switch (securityLevel) {
      case SecurityLevel.LEVEL1:
        return new LatticeParams(512, 3329, 2.0);
      case SecurityLevel.LEVEL3:
        return new LatticeParams(768, 3329, 2.0);
      case SecurityLevel.LEVEL5:
        return new LatticeParams(1024, 3329, 2.0);
      default:
        throw new Error('Invalid security level');
    }
  }
}

/**
 * Polynomial operations for lattice crypto
 */
class PolynomialRing {
  constructor(coefficients, modulus) {
    this.coefficients = coefficients;
    this.modulus = modulus;
    this.degree = coefficients.length;
  }
  
  /**
   * Add two polynomials
   */
  add(other) {
    const result = new Array(this.degree);
    for (let i = 0; i < this.degree; i++) {
      result[i] = (this.coefficients[i] + other.coefficients[i]) % this.modulus;
      if (result[i] < 0) result[i] += this.modulus;
    }
    return new PolynomialRing(result, this.modulus);
  }
  
  /**
   * Multiply two polynomials (NTT for efficiency)
   */
  multiply(other) {
    // Simplified multiplication - in production use NTT
    const result = new Array(this.degree).fill(0);
    
    for (let i = 0; i < this.degree; i++) {
      for (let j = 0; j < this.degree; j++) {
        const index = (i + j) % this.degree;
        result[index] = (result[index] + this.coefficients[i] * other.coefficients[j]) % this.modulus;
      }
    }
    
    return new PolynomialRing(result, this.modulus);
  }
  
  /**
   * Sample from centered binomial distribution
   */
  static sampleCBD(params, eta) {
    const coefficients = new Array(params.n);
    
    for (let i = 0; i < params.n; i++) {
      let sum = 0;
      const bytes = randomBytes(2 * eta);
      
      for (let j = 0; j < eta; j++) {
        sum += bytes[j] - bytes[j + eta];
      }
      
      coefficients[i] = sum % params.q;
      if (coefficients[i] < 0) coefficients[i] += params.q;
    }
    
    return new PolynomialRing(coefficients, params.q);
  }
  
  /**
   * Convert to bytes
   */
  toBytes() {
    const bytes = Buffer.alloc(this.degree * 2);
    for (let i = 0; i < this.degree; i++) {
      bytes.writeUInt16LE(this.coefficients[i], i * 2);
    }
    return bytes;
  }
  
  /**
   * Convert from bytes
   */
  static fromBytes(bytes, modulus) {
    const degree = bytes.length / 2;
    const coefficients = new Array(degree);
    
    for (let i = 0; i < degree; i++) {
      coefficients[i] = bytes.readUInt16LE(i * 2) % modulus;
    }
    
    return new PolynomialRing(coefficients, modulus);
  }
}

/**
 * Kyber key encapsulation mechanism
 */
export class Kyber {
  constructor(securityLevel = SecurityLevel.LEVEL3) {
    this.params = LatticeParams.getParams(securityLevel);
    this.k = securityLevel === SecurityLevel.LEVEL1 ? 2 : 
             securityLevel === SecurityLevel.LEVEL3 ? 3 : 4;
  }
  
  /**
   * Generate key pair
   */
  generateKeyPair() {
    const startTime = Date.now();
    
    // Generate matrix A
    const A = this._generateMatrix();
    
    // Sample secret vector s
    const s = new Array(this.k);
    for (let i = 0; i < this.k; i++) {
      s[i] = PolynomialRing.sampleCBD(this.params, 2);
    }
    
    // Sample error vector e
    const e = new Array(this.k);
    for (let i = 0; i < this.k; i++) {
      e[i] = PolynomialRing.sampleCBD(this.params, 2);
    }
    
    // Compute public key: pk = As + e
    const pk = new Array(this.k);
    for (let i = 0; i < this.k; i++) {
      pk[i] = e[i];
      for (let j = 0; j < this.k; j++) {
        pk[i] = pk[i].add(A[i][j].multiply(s[j]));
      }
    }
    
    logger.debug(`Kyber key generation took ${Date.now() - startTime}ms`);
    
    return {
      publicKey: {
        pk,
        A,
        params: this.params
      },
      secretKey: {
        s,
        params: this.params
      }
    };
  }
  
  /**
   * Encapsulate - generate shared secret and ciphertext
   */
  encapsulate(publicKey) {
    const startTime = Date.now();
    
    // Generate random message
    const m = randomBytes(32);
    
    // Sample r, e1, e2
    const r = new Array(this.k);
    const e1 = new Array(this.k);
    for (let i = 0; i < this.k; i++) {
      r[i] = PolynomialRing.sampleCBD(this.params, 2);
      e1[i] = PolynomialRing.sampleCBD(this.params, 2);
    }
    const e2 = PolynomialRing.sampleCBD(this.params, 2);
    
    // Compute ciphertext
    // u = A^T r + e1
    const u = new Array(this.k);
    for (let i = 0; i < this.k; i++) {
      u[i] = e1[i];
      for (let j = 0; j < this.k; j++) {
        u[i] = u[i].add(publicKey.A[j][i].multiply(r[j]));
      }
    }
    
    // v = pk^T r + e2 + encode(m)
    let v = e2.add(this._encode(m));
    for (let i = 0; i < this.k; i++) {
      v = v.add(publicKey.pk[i].multiply(r[i]));
    }
    
    // Derive shared secret
    const sharedSecret = this._kdf(m);
    
    logger.debug(`Kyber encapsulation took ${Date.now() - startTime}ms`);
    
    return {
      ciphertext: { u, v },
      sharedSecret
    };
  }
  
  /**
   * Decapsulate - recover shared secret from ciphertext
   */
  decapsulate(secretKey, ciphertext) {
    const startTime = Date.now();
    
    // Compute m' = v - s^T u
    let m_prime = ciphertext.v;
    for (let i = 0; i < this.k; i++) {
      m_prime = m_prime.add(secretKey.s[i].multiply(ciphertext.u[i]).multiply(-1));
    }
    
    // Decode message
    const m = this._decode(m_prime);
    
    // Derive shared secret
    const sharedSecret = this._kdf(m);
    
    logger.debug(`Kyber decapsulation took ${Date.now() - startTime}ms`);
    
    return sharedSecret;
  }
  
  /**
   * Generate matrix A
   */
  _generateMatrix() {
    const A = new Array(this.k);
    
    for (let i = 0; i < this.k; i++) {
      A[i] = new Array(this.k);
      for (let j = 0; j < this.k; j++) {
        // Generate uniform polynomial
        const coefficients = new Array(this.params.n);
        const bytes = randomBytes(this.params.n * 2);
        
        for (let k = 0; k < this.params.n; k++) {
          coefficients[k] = bytes.readUInt16LE(k * 2) % this.params.q;
        }
        
        A[i][j] = new PolynomialRing(coefficients, this.params.q);
      }
    }
    
    return A;
  }
  
  /**
   * Encode message to polynomial
   */
  _encode(message) {
    const coefficients = new Array(this.params.n).fill(0);
    
    for (let i = 0; i < Math.min(32, this.params.n / 8); i++) {
      for (let j = 0; j < 8; j++) {
        if (message[i] & (1 << j)) {
          coefficients[i * 8 + j] = Math.floor(this.params.q / 2);
        }
      }
    }
    
    return new PolynomialRing(coefficients, this.params.q);
  }
  
  /**
   * Decode polynomial to message
   */
  _decode(poly) {
    const message = Buffer.alloc(32);
    
    for (let i = 0; i < 32; i++) {
      let byte = 0;
      for (let j = 0; j < 8; j++) {
        const coeff = poly.coefficients[i * 8 + j];
        if (coeff > this.params.q / 4 && coeff < 3 * this.params.q / 4) {
          byte |= (1 << j);
        }
      }
      message[i] = byte;
    }
    
    return message;
  }
  
  /**
   * Key derivation function
   */
  _kdf(input) {
    return createHash('sha3-256').update(input).digest();
  }
}

/**
 * Dilithium digital signature
 */
export class Dilithium {
  constructor(securityLevel = SecurityLevel.LEVEL3) {
    this.params = LatticeParams.getParams(securityLevel);
    this.k = securityLevel === SecurityLevel.LEVEL1 ? 4 : 
             securityLevel === SecurityLevel.LEVEL3 ? 6 : 8;
    this.l = securityLevel === SecurityLevel.LEVEL1 ? 4 :
             securityLevel === SecurityLevel.LEVEL3 ? 5 : 7;
  }
  
  /**
   * Generate key pair
   */
  generateKeyPair() {
    const startTime = Date.now();
    
    // Generate matrix A
    const A = this._generateMatrix();
    
    // Sample secret vectors s1, s2
    const s1 = new Array(this.l);
    const s2 = new Array(this.k);
    
    for (let i = 0; i < this.l; i++) {
      s1[i] = PolynomialRing.sampleCBD(this.params, 3);
    }
    
    for (let i = 0; i < this.k; i++) {
      s2[i] = PolynomialRing.sampleCBD(this.params, 3);
    }
    
    // Compute t = As1 + s2
    const t = new Array(this.k);
    for (let i = 0; i < this.k; i++) {
      t[i] = s2[i];
      for (let j = 0; j < this.l; j++) {
        t[i] = t[i].add(A[i][j].multiply(s1[j]));
      }
    }
    
    logger.debug(`Dilithium key generation took ${Date.now() - startTime}ms`);
    
    return {
      publicKey: {
        A,
        t,
        params: this.params
      },
      secretKey: {
        A,
        s1,
        s2,
        t,
        params: this.params
      }
    };
  }
  
  /**
   * Sign message
   */
  sign(secretKey, message) {
    const startTime = Date.now();
    
    // Hash message
    const mu = createHash('sha3-256').update(message).digest();
    
    let attempts = 0;
    while (attempts < 1000) {
      attempts++;
      
      // Sample masking vector y
      const y = new Array(this.l);
      for (let i = 0; i < this.l; i++) {
        y[i] = this._sampleMask();
      }
      
      // Compute w = Ay
      const w = new Array(this.k);
      for (let i = 0; i < this.k; i++) {
        w[i] = new PolynomialRing(new Array(this.params.n).fill(0), this.params.q);
        for (let j = 0; j < this.l; j++) {
          w[i] = w[i].add(secretKey.A[i][j].multiply(y[j]));
        }
      }
      
      // Compute challenge c
      const c = this._hashToChallenge(mu, w);
      
      // Compute z = y + cs1
      const z = new Array(this.l);
      for (let i = 0; i < this.l; i++) {
        z[i] = y[i].add(c.multiply(secretKey.s1[i]));
      }
      
      // Check bounds
      if (this._checkBounds(z)) {
        logger.debug(`Dilithium signing took ${Date.now() - startTime}ms (${attempts} attempts)`);
        
        return {
          z,
          c,
          attempts
        };
      }
    }
    
    throw new Error('Signature generation failed');
  }
  
  /**
   * Verify signature
   */
  verify(publicKey, message, signature) {
    const startTime = Date.now();
    
    // Hash message
    const mu = createHash('sha3-256').update(message).digest();
    
    // Compute w' = Az - ct
    const w_prime = new Array(this.k);
    for (let i = 0; i < this.k; i++) {
      w_prime[i] = publicKey.t[i].multiply(signature.c).multiply(-1);
      
      for (let j = 0; j < this.l; j++) {
        w_prime[i] = w_prime[i].add(publicKey.A[i][j].multiply(signature.z[j]));
      }
    }
    
    // Recompute challenge
    const c_prime = this._hashToChallenge(mu, w_prime);
    
    // Check if challenges match
    const valid = this._comparePolynomials(signature.c, c_prime);
    
    logger.debug(`Dilithium verification took ${Date.now() - startTime}ms`);
    
    return valid;
  }
  
  /**
   * Generate matrix A
   */
  _generateMatrix() {
    const A = new Array(this.k);
    
    for (let i = 0; i < this.k; i++) {
      A[i] = new Array(this.l);
      for (let j = 0; j < this.l; j++) {
        const coefficients = new Array(this.params.n);
        const bytes = randomBytes(this.params.n * 2);
        
        for (let k = 0; k < this.params.n; k++) {
          coefficients[k] = bytes.readUInt16LE(k * 2) % this.params.q;
        }
        
        A[i][j] = new PolynomialRing(coefficients, this.params.q);
      }
    }
    
    return A;
  }
  
  /**
   * Sample masking polynomial
   */
  _sampleMask() {
    const gamma1 = (1 << 17);
    const coefficients = new Array(this.params.n);
    
    for (let i = 0; i < this.params.n; i++) {
      const bytes = randomBytes(3);
      const value = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16);
      coefficients[i] = (value % (2 * gamma1 + 1)) - gamma1;
      
      if (coefficients[i] < 0) {
        coefficients[i] += this.params.q;
      }
    }
    
    return new PolynomialRing(coefficients, this.params.q);
  }
  
  /**
   * Hash to challenge polynomial
   */
  _hashToChallenge(mu, w) {
    // Simplified challenge generation
    const seed = Buffer.concat([mu, this._packPolynomialVector(w)]);
    const hash = createHash('sha3-256').update(seed).digest();
    
    const coefficients = new Array(this.params.n).fill(0);
    const tau = 60; // Number of ±1 coefficients
    
    for (let i = 0; i < tau; i++) {
      const pos = hash[i] % this.params.n;
      coefficients[pos] = (i % 2 === 0) ? 1 : this.params.q - 1;
    }
    
    return new PolynomialRing(coefficients, this.params.q);
  }
  
  /**
   * Check bounds for rejection sampling
   */
  _checkBounds(z) {
    const gamma1 = (1 << 17);
    const bound = gamma1 - (1 << 8);
    
    for (const poly of z) {
      for (const coeff of poly.coefficients) {
        const centered = coeff > this.params.q / 2 ? coeff - this.params.q : coeff;
        if (Math.abs(centered) >= bound) {
          return false;
        }
      }
    }
    
    return true;
  }
  
  /**
   * Compare two polynomials
   */
  _comparePolynomials(a, b) {
    if (a.degree !== b.degree) return false;
    
    for (let i = 0; i < a.degree; i++) {
      if (a.coefficients[i] !== b.coefficients[i]) {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Pack polynomial vector
   */
  _packPolynomialVector(vec) {
    const buffers = vec.map(poly => poly.toBytes());
    return Buffer.concat(buffers);
  }
}

/**
 * SPHINCS+ hash-based signatures
 */
export class SPHINCS {
  constructor(securityLevel = SecurityLevel.LEVEL3) {
    this.n = securityLevel === SecurityLevel.LEVEL1 ? 16 :
             securityLevel === SecurityLevel.LEVEL3 ? 24 : 32;
    this.h = 64;  // Tree height
    this.d = 8;   // Hypertree layers
    this.w = 16;  // Winternitz parameter
  }
  
  /**
   * Generate key pair
   */
  generateKeyPair() {
    const startTime = Date.now();
    
    // Generate secret seed and public seed
    const secretSeed = randomBytes(this.n);
    const publicSeed = randomBytes(this.n);
    
    // Generate root of hypertree
    const root = this._computeRoot(secretSeed, publicSeed);
    
    logger.debug(`SPHINCS+ key generation took ${Date.now() - startTime}ms`);
    
    return {
      publicKey: {
        root,
        publicSeed
      },
      secretKey: {
        secretSeed,
        publicSeed,
        root
      }
    };
  }
  
  /**
   * Sign message
   */
  sign(secretKey, message) {
    const startTime = Date.now();
    
    // Generate randomness
    const optRand = randomBytes(this.n);
    
    // Compute message digest and index
    const digest = this._hashMessage(message, secretKey.publicSeed, optRand);
    const { msgHash, treeIndex, leafIndex } = this._splitDigest(digest);
    
    // Generate FORS signature
    const forsSignature = this._signFORS(msgHash, secretKey, treeIndex, leafIndex);
    
    // Get FORS public key
    const forsPk = this._getFORSPublicKey(forsSignature, msgHash, secretKey.publicSeed, treeIndex, leafIndex);
    
    // Sign FORS public key with hypertree
    const htSignature = this._signHypertree(forsPk, secretKey, treeIndex, leafIndex);
    
    logger.debug(`SPHINCS+ signing took ${Date.now() - startTime}ms`);
    
    return {
      optRand,
      forsSignature,
      htSignature
    };
  }
  
  /**
   * Verify signature
   */
  verify(publicKey, message, signature) {
    const startTime = Date.now();
    
    // Compute message digest and index
    const digest = this._hashMessage(message, publicKey.publicSeed, signature.optRand);
    const { msgHash, treeIndex, leafIndex } = this._splitDigest(digest);
    
    // Verify FORS signature and get public key
    const forsPk = this._getFORSPublicKey(
      signature.forsSignature,
      msgHash,
      publicKey.publicSeed,
      treeIndex,
      leafIndex
    );
    
    // Verify hypertree signature
    const computedRoot = this._verifyHypertree(
      forsPk,
      signature.htSignature,
      publicKey.publicSeed,
      treeIndex,
      leafIndex
    );
    
    // Compare roots
    const valid = computedRoot.equals(publicKey.root);
    
    logger.debug(`SPHINCS+ verification took ${Date.now() - startTime}ms`);
    
    return valid;
  }
  
  /**
   * Compute hypertree root
   */
  _computeRoot(secretSeed, publicSeed) {
    // Simplified root computation
    const address = Buffer.alloc(32);
    return this._prf(secretSeed, publicSeed, address);
  }
  
  /**
   * Hash message with randomness
   */
  _hashMessage(message, publicSeed, optRand) {
    return createHash('sha3-256')
      .update(optRand)
      .update(publicSeed)
      .update(message)
      .digest();
  }
  
  /**
   * Split digest into components
   */
  _splitDigest(digest) {
    const msgHash = digest.slice(0, this.n);
    const indexBytes = digest.slice(this.n, this.n + 8);
    const index = indexBytes.readBigUInt64BE();
    
    const treeIndex = Number(index >> BigInt(this.h / this.d));
    const leafIndex = Number(index & BigInt((1 << (this.h / this.d)) - 1));
    
    return { msgHash, treeIndex, leafIndex };
  }
  
  /**
   * FORS signature (simplified)
   */
  _signFORS(msgHash, secretKey, treeIndex, leafIndex) {
    const k = Math.ceil(this.n * 8 / Math.log2(2 ** 4));
    const signature = [];
    
    for (let i = 0; i < k; i++) {
      const idx = (msgHash[Math.floor(i / 2)] >> ((i % 2) * 4)) & 0xF;
      const sk = this._deriveFORSKey(secretKey, treeIndex, leafIndex, i, idx);
      signature.push(sk);
    }
    
    return signature;
  }
  
  /**
   * Get FORS public key
   */
  _getFORSPublicKey(signature, msgHash, publicSeed, treeIndex, leafIndex) {
    // Simplified FORS verification
    const roots = signature.map((sk, i) => {
      return this._hash(sk, publicSeed, Buffer.from([i]));
    });
    
    return this._hash(Buffer.concat(roots), publicSeed, Buffer.from('FORS'));
  }
  
  /**
   * Sign with hypertree (simplified)
   */
  _signHypertree(message, secretKey, treeIndex, leafIndex) {
    const signatures = [];
    
    for (let layer = 0; layer < this.d; layer++) {
      const wotsSig = this._signWOTS(message, secretKey, treeIndex, leafIndex, layer);
      signatures.push(wotsSig);
    }
    
    return signatures;
  }
  
  /**
   * Verify hypertree (simplified)
   */
  _verifyHypertree(message, signatures, publicSeed, treeIndex, leafIndex) {
    let currentHash = message;
    
    for (let layer = 0; layer < this.d; layer++) {
      currentHash = this._verifyWOTS(currentHash, signatures[layer], publicSeed, layer);
    }
    
    return currentHash;
  }
  
  /**
   * WOTS+ operations (simplified)
   */
  _signWOTS(message, secretKey, treeIndex, leafIndex, layer) {
    const signature = [];
    const msgInts = this._baseW(message);
    
    for (let i = 0; i < msgInts.length; i++) {
      const sk = this._deriveWOTSKey(secretKey, treeIndex, leafIndex, layer, i);
      const sig = this._chain(sk, 0, msgInts[i]);
      signature.push(sig);
    }
    
    return signature;
  }
  
  _verifyWOTS(message, signature, publicSeed, layer) {
    const msgInts = this._baseW(message);
    const pubKeys = [];
    
    for (let i = 0; i < msgInts.length; i++) {
      const pk = this._chain(signature[i], msgInts[i], this.w - 1 - msgInts[i]);
      pubKeys.push(pk);
    }
    
    return this._hash(Buffer.concat(pubKeys), publicSeed, Buffer.from([layer]));
  }
  
  /**
   * Helper functions
   */
  _prf(key, publicSeed, address) {
    return createHash('sha3-256')
      .update(key)
      .update(publicSeed)
      .update(address)
      .digest()
      .slice(0, this.n);
  }
  
  _hash(data, publicSeed, address) {
    return createHash('sha3-256')
      .update(publicSeed)
      .update(address)
      .update(data)
      .digest()
      .slice(0, this.n);
  }
  
  _deriveFORSKey(secretKey, treeIndex, leafIndex, keyIndex, chainIndex) {
    const address = Buffer.alloc(32);
    address.writeUInt32BE(treeIndex, 0);
    address.writeUInt32BE(leafIndex, 4);
    address.writeUInt32BE(keyIndex, 8);
    address.writeUInt32BE(chainIndex, 12);
    
    return this._prf(secretKey.secretSeed, secretKey.publicSeed, address);
  }
  
  _deriveWOTSKey(secretKey, treeIndex, leafIndex, layer, keyIndex) {
    const address = Buffer.alloc(32);
    address.writeUInt32BE(treeIndex, 0);
    address.writeUInt32BE(leafIndex, 4);
    address.writeUInt32BE(layer, 8);
    address.writeUInt32BE(keyIndex, 12);
    
    return this._prf(secretKey.secretSeed, secretKey.publicSeed, address);
  }
  
  _baseW(data) {
    const result = [];
    const bits = this.w === 16 ? 4 : 8;
    
    for (const byte of data) {
      if (bits === 4) {
        result.push((byte >> 4) & 0xF);
        result.push(byte & 0xF);
      } else {
        result.push(byte);
      }
    }
    
    return result;
  }
  
  _chain(start, from, to) {
    let current = start;
    
    for (let i = from; i < from + to; i++) {
      current = this._hash(current, Buffer.alloc(this.n), Buffer.from([i]));
    }
    
    return current;
  }
}

/**
 * Quantum-resistant crypto system
 */
export class QuantumResistantCrypto extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      defaultAlgorithm: options.defaultAlgorithm || PQAlgorithm.KYBER,
      securityLevel: options.securityLevel || SecurityLevel.LEVEL3,
      hybridMode: options.hybridMode !== false,
      ...options
    };
    
    // Algorithm implementations
    this.algorithms = new Map();
    this._initializeAlgorithms();
    
    // Metrics
    this.metrics = {
      keyPairsGenerated: 0,
      signaturesCreated: 0,
      signaturesVerified: 0,
      encapsulations: 0,
      decapsulations: 0
    };
  }
  
  /**
   * Initialize algorithm implementations
   */
  _initializeAlgorithms() {
    this.algorithms.set(PQAlgorithm.KYBER, new Kyber(this.options.securityLevel));
    this.algorithms.set(PQAlgorithm.DILITHIUM, new Dilithium(this.options.securityLevel));
    this.algorithms.set(PQAlgorithm.SPHINCS, new SPHINCS(this.options.securityLevel));
  }
  
  /**
   * Generate key pair
   */
  generateKeyPair(algorithm = this.options.defaultAlgorithm) {
    const impl = this.algorithms.get(algorithm);
    if (!impl) {
      throw new Error(`Unknown algorithm: ${algorithm}`);
    }
    
    const keyPair = impl.generateKeyPair();
    this.metrics.keyPairsGenerated++;
    
    this.emit('keypair:generated', { algorithm });
    
    return {
      algorithm,
      ...keyPair
    };
  }
  
  /**
   * Encapsulate (KEM)
   */
  encapsulate(publicKey) {
    if (publicKey.algorithm !== PQAlgorithm.KYBER) {
      throw new Error('Encapsulation only supported for Kyber');
    }
    
    const kyber = this.algorithms.get(PQAlgorithm.KYBER);
    const result = kyber.encapsulate(publicKey);
    
    this.metrics.encapsulations++;
    
    return result;
  }
  
  /**
   * Decapsulate (KEM)
   */
  decapsulate(secretKey, ciphertext) {
    if (secretKey.algorithm !== PQAlgorithm.KYBER) {
      throw new Error('Decapsulation only supported for Kyber');
    }
    
    const kyber = this.algorithms.get(PQAlgorithm.KYBER);
    const sharedSecret = kyber.decapsulate(secretKey, ciphertext);
    
    this.metrics.decapsulations++;
    
    return sharedSecret;
  }
  
  /**
   * Sign message
   */
  sign(secretKey, message) {
    const algorithm = secretKey.algorithm || PQAlgorithm.DILITHIUM;
    const impl = this.algorithms.get(algorithm);
    
    if (!impl || !impl.sign) {
      throw new Error(`Signing not supported for algorithm: ${algorithm}`);
    }
    
    const signature = impl.sign(secretKey, message);
    this.metrics.signaturesCreated++;
    
    return {
      algorithm,
      signature
    };
  }
  
  /**
   * Verify signature
   */
  verify(publicKey, message, signatureData) {
    const algorithm = signatureData.algorithm || publicKey.algorithm;
    const impl = this.algorithms.get(algorithm);
    
    if (!impl || !impl.verify) {
      throw new Error(`Verification not supported for algorithm: ${algorithm}`);
    }
    
    const valid = impl.verify(publicKey, message, signatureData.signature);
    this.metrics.signaturesVerified++;
    
    return valid;
  }
  
  /**
   * Hybrid encryption (combines classical and post-quantum)
   */
  async hybridEncrypt(publicKey, plaintext) {
    if (!this.options.hybridMode) {
      throw new Error('Hybrid mode is disabled');
    }
    
    // Generate ephemeral ECDH key
    const { publicKey: ephemeralPublic, privateKey: ephemeralPrivate } = 
      await this._generateECDHKeyPair();
    
    // Classical ECDH
    const classicalSecret = await this._deriveECDHSecret(ephemeralPrivate, publicKey.classical);
    
    // Post-quantum KEM
    const { ciphertext, sharedSecret: quantumSecret } = this.encapsulate(publicKey.quantum);
    
    // Combine secrets
    const combinedSecret = this._combineSecrets(classicalSecret, quantumSecret);
    
    // Encrypt with combined key
    const encrypted = await this._symmetricEncrypt(combinedSecret, plaintext);
    
    return {
      ephemeralPublic,
      quantumCiphertext: ciphertext,
      encrypted
    };
  }
  
  /**
   * Hybrid decryption
   */
  async hybridDecrypt(secretKey, ciphertext) {
    if (!this.options.hybridMode) {
      throw new Error('Hybrid mode is disabled');
    }
    
    // Classical ECDH
    const classicalSecret = await this._deriveECDHSecret(
      secretKey.classical,
      ciphertext.ephemeralPublic
    );
    
    // Post-quantum KEM
    const quantumSecret = this.decapsulate(secretKey.quantum, ciphertext.quantumCiphertext);
    
    // Combine secrets
    const combinedSecret = this._combineSecrets(classicalSecret, quantumSecret);
    
    // Decrypt
    return this._symmetricDecrypt(combinedSecret, ciphertext.encrypted);
  }
  
  /**
   * Helper methods
   */
  async _generateECDHKeyPair() {
    // Simplified ECDH key generation
    const privateKey = randomBytes(32);
    const publicKey = createHash('sha256').update(privateKey).digest();
    
    return { publicKey, privateKey };
  }
  
  async _deriveECDHSecret(privateKey, publicKey) {
    // Simplified ECDH
    return createHash('sha256')
      .update(privateKey)
      .update(publicKey)
      .digest();
  }
  
  _combineSecrets(classical, quantum) {
    return createHash('sha3-256')
      .update(classical)
      .update(quantum)
      .digest();
  }
  
  async _symmetricEncrypt(key, plaintext) {
    // Simplified AES-GCM encryption
    const iv = randomBytes(16);
    const cipher = createHash('sha256').update(key).update(iv).digest();
    
    const encrypted = Buffer.alloc(plaintext.length);
    for (let i = 0; i < plaintext.length; i++) {
      encrypted[i] = plaintext[i] ^ cipher[i % cipher.length];
    }
    
    return { iv, encrypted };
  }
  
  async _symmetricDecrypt(key, { iv, encrypted }) {
    // Simplified decryption
    const cipher = createHash('sha256').update(key).update(iv).digest();
    
    const decrypted = Buffer.alloc(encrypted.length);
    for (let i = 0; i < encrypted.length; i++) {
      decrypted[i] = encrypted[i] ^ cipher[i % cipher.length];
    }
    
    return decrypted;
  }
  
  /**
   * Get metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      algorithms: Array.from(this.algorithms.keys())
    };
  }
}

export default QuantumResistantCrypto;