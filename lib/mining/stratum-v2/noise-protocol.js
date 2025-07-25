/**
 * NOISE Protocol - Otedama Stratum V2
 * Simplified NOISE protocol implementation for secure communication
 * 
 * Design principles:
 * - Secure by default (Carmack)
 * - Clear cryptographic boundaries (Martin)  
 * - Simple, auditable implementation (Pike)
 */

import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto';
import { createLogger } from '../../core/logger.js';

const logger = createLogger('NoiseProtocol');

/**
 * Simplified NOISE protocol state machine
 * In production, use a proper NOISE implementation
 */
export class NoiseState {
  constructor(role) {
    this.role = role; // 'initiator' or 'responder'
    this.state = 'initial';
    
    // Simplified key exchange
    this.localKeyPair = this.generateKeyPair();
    this.remotePublicKey = null;
    this.sharedSecret = null;
    
    // Encryption state
    this.sendCipher = null;
    this.recvCipher = null;
    this.sendNonce = 0;
    this.recvNonce = 0;
  }
  
  /**
   * Generate key pair (simplified)
   */
  generateKeyPair() {
    // In production, use proper elliptic curve cryptography
    return {
      publicKey: randomBytes(32),
      privateKey: randomBytes(32)
    };
  }
  
  /**
   * Start handshake
   */
  startHandshake() {
    if (this.role !== 'initiator') {
      throw new Error('Only initiator can start handshake');
    }
    
    this.state = 'handshaking';
    
    // Send public key
    return Buffer.concat([
      Buffer.from([0x01]), // Handshake message type
      this.localKeyPair.publicKey
    ]);
  }
  
  /**
   * Process handshake message
   */
  processHandshake(message) {
    const messageType = message[0];
    const payload = message.slice(1);
    
    switch (this.state) {
      case 'initial':
        if (this.role !== 'responder') {
          throw new Error('Invalid state');
        }
        
        // Receive initiator's public key
        this.remotePublicKey = payload;
        this.state = 'handshaking';
        
        // Send responder's public key
        return Buffer.concat([
          Buffer.from([0x02]), // Handshake response
          this.localKeyPair.publicKey
        ]);
        
      case 'handshaking':
        if (this.role !== 'initiator') {
          throw new Error('Invalid state');
        }
        
        // Receive responder's public key
        this.remotePublicKey = payload;
        
        // Derive shared secret
        this.deriveSharedSecret();
        this.state = 'established';
        
        // Send confirmation
        return Buffer.concat([
          Buffer.from([0x03]), // Handshake complete
          randomBytes(16) // Confirmation token
        ]);
        
      default:
        throw new Error('Invalid handshake state');
    }
  }
  
  /**
   * Check if handshake is complete
   */
  isHandshakeComplete() {
    return this.state === 'established';
  }
  
  /**
   * Derive shared secret (simplified)
   */
  deriveSharedSecret() {
    // In production, use proper ECDH
    const hash = createHash('sha256');
    hash.update(this.localKeyPair.privateKey);
    hash.update(this.remotePublicKey);
    this.sharedSecret = hash.digest();
    
    // Derive encryption keys
    const keys = this.deriveKeys(this.sharedSecret);
    
    if (this.role === 'initiator') {
      this.sendCipher = this.createCipher(keys.key1, keys.iv1);
      this.recvCipher = this.createCipher(keys.key2, keys.iv2);
    } else {
      this.sendCipher = this.createCipher(keys.key2, keys.iv2);
      this.recvCipher = this.createCipher(keys.key1, keys.iv1);
    }
  }
  
  /**
   * Derive encryption keys
   */
  deriveKeys(secret) {
    const hash1 = createHash('sha256').update(Buffer.concat([secret, Buffer.from('key1')])).digest();
    const hash2 = createHash('sha256').update(Buffer.concat([secret, Buffer.from('key2')])).digest();
    
    return {
      key1: hash1.slice(0, 32),
      iv1: hash1.slice(32, 48),
      key2: hash2.slice(0, 32),
      iv2: hash2.slice(32, 48)
    };
  }
  
  /**
   * Create cipher configuration
   */
  createCipher(key, iv) {
    return { key, iv };
  }
  
  /**
   * Encrypt message
   */
  encryptMessage(plaintext) {
    if (!this.isHandshakeComplete()) {
      throw new Error('Handshake not complete');
    }
    
    // Add nonce to prevent replay attacks
    const nonce = Buffer.allocUnsafe(8);
    nonce.writeBigUInt64LE(BigInt(this.sendNonce++));
    
    // Encrypt
    const cipher = createCipheriv('aes-256-ctr', this.sendCipher.key, this.sendCipher.iv);
    const encrypted = Buffer.concat([
      nonce,
      cipher.update(plaintext),
      cipher.final()
    ]);
    
    // Add simple MAC (in production, use proper AEAD)
    const mac = createHash('sha256')
      .update(this.sharedSecret)
      .update(encrypted)
      .digest()
      .slice(0, 16);
    
    return Buffer.concat([encrypted, mac]);
  }
  
  /**
   * Decrypt message
   */
  decryptMessage(ciphertext) {
    if (!this.isHandshakeComplete()) {
      throw new Error('Handshake not complete');
    }
    
    // Verify MAC
    const message = ciphertext.slice(0, -16);
    const mac = ciphertext.slice(-16);
    
    const expectedMac = createHash('sha256')
      .update(this.sharedSecret)
      .update(message)
      .digest()
      .slice(0, 16);
    
    if (!mac.equals(expectedMac)) {
      throw new Error('MAC verification failed');
    }
    
    // Extract nonce
    const nonce = message.slice(0, 8);
    const encrypted = message.slice(8);
    
    // Verify nonce is increasing (prevent replay)
    const nonceValue = nonce.readBigUInt64LE();
    if (nonceValue <= this.recvNonce) {
      throw new Error('Nonce replay detected');
    }
    this.recvNonce = Number(nonceValue);
    
    // Decrypt
    const decipher = createDecipheriv('aes-256-ctr', this.recvCipher.key, this.recvCipher.iv);
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
  }
}

export default NoiseState;