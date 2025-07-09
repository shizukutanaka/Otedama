// Advanced Wallet Security System for Otedama Pool
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { scrypt, randomBytes } from 'crypto';

const scryptAsync = promisify(scrypt);

interface EncryptedKey {
  algorithm: string;
  salt: string;
  iv: string;
  tag: string;
  encrypted: string;
  version: number;
  timestamp: number;
}

interface KeyDerivationParams {
  N: number; // CPU/memory cost parameter
  r: number; // Block size parameter
  p: number; // Parallelization parameter
  dkLen: number; // Derived key length
}

interface WalletSecurityConfig {
  keyStorePath: string;
  useHardwareWallet: boolean;
  multiSigThreshold?: number;
  multiSigParticipants?: number;
  rotationIntervalDays: number;
  backupLocations: string[];
}

export class WalletSecuritySystem {
  private readonly CURRENT_VERSION = 1;
  private readonly ALGORITHM = 'aes-256-gcm';
  private readonly KEY_DERIVATION_PARAMS: KeyDerivationParams = {
    N: 16384, // 2^14
    r: 8,
    p: 1,
    dkLen: 32
  };
  
  private masterKey: Buffer | null = null;
  private config: WalletSecurityConfig;
  
  constructor(config: WalletSecurityConfig) {
    this.config = config;
  }
  
  /**
   * Initialize the wallet security system
   */
  async initialize(masterPassword: string): Promise<void> {
    // Derive master key from password
    const salt = await this.getSalt();
    this.masterKey = await this.deriveKey(masterPassword, salt);
    
    // Verify master key by attempting to decrypt a test value
    await this.verifyMasterKey();
    
    // Setup key rotation if needed
    await this.checkKeyRotation();
  }
  
  /**
   * Encrypt a private key with multiple layers of security
   */
  async encryptPrivateKey(privateKey: string, keyId: string): Promise<void> {
    if (!this.masterKey) {
      throw new Error('Security system not initialized');
    }
    
    // Generate unique salt and IV for this key
    const salt = randomBytes(32);
    const iv = randomBytes(16);
    
    // Derive a unique encryption key for this private key
    const derivedKey = await this.deriveKey(keyId, salt);
    
    // Combine master key and derived key
    const combinedKey = this.combineKeys(this.masterKey, derivedKey);
    
    // Encrypt the private key
    const cipher = crypto.createCipheriv(this.ALGORITHM, combinedKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(privateKey, 'utf8'),
      cipher.final()
    ]);
    
    const tag = cipher.getAuthTag();
    
    // Create encrypted key object
    const encryptedKey: EncryptedKey = {
      algorithm: this.ALGORITHM,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      encrypted: encrypted.toString('base64'),
      version: this.CURRENT_VERSION,
      timestamp: Date.now()
    };
    
    // Store encrypted key
    await this.storeEncryptedKey(keyId, encryptedKey);
    
    // Create secure backups
    await this.createSecureBackups(keyId, encryptedKey);
  }
  
  /**
   * Decrypt a private key
   */
  async decryptPrivateKey(keyId: string): Promise<string> {
    if (!this.masterKey) {
      throw new Error('Security system not initialized');
    }
    
    // Load encrypted key
    const encryptedKey = await this.loadEncryptedKey(keyId);
    
    // Verify version compatibility
    if (encryptedKey.version > this.CURRENT_VERSION) {
      throw new Error('Encrypted key version not supported');
    }
    
    // Recreate buffers
    const salt = Buffer.from(encryptedKey.salt, 'base64');
    const iv = Buffer.from(encryptedKey.iv, 'base64');
    const tag = Buffer.from(encryptedKey.tag, 'base64');
    const encrypted = Buffer.from(encryptedKey.encrypted, 'base64');
    
    // Derive the encryption key
    const derivedKey = await this.deriveKey(keyId, salt);
    const combinedKey = this.combineKeys(this.masterKey, derivedKey);
    
    // Decrypt
    const decipher = crypto.createDecipheriv(this.ALGORITHM, combinedKey, iv);
    decipher.setAuthTag(tag);
    
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
    
    return decrypted.toString('utf8');
  }
  
  /**
   * Generate a new wallet with hardware wallet support
   */
  async generateSecureWallet(walletType: 'hot' | 'cold'): Promise<{
    address: string;
    publicKey: string;
    keyId: string;
  }> {
    if (walletType === 'cold' && this.config.useHardwareWallet) {
      // Interface with hardware wallet
      return this.generateHardwareWallet();
    }
    
    // Generate new key pair
    const keyPair = crypto.generateKeyPairSync('ec', {
      namedCurve: 'secp256k1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    
    // Generate unique key ID
    const keyId = crypto.randomBytes(16).toString('hex');
    
    // Encrypt and store private key
    await this.encryptPrivateKey(keyPair.privateKey, keyId);
    
    // Derive Bitcoin address from public key
    const address = this.deriveBitcoinAddress(keyPair.publicKey);
    
    return {
      address,
      publicKey: keyPair.publicKey,
      keyId
    };
  }
  
  /**
   * Setup multi-signature wallet
   */
  async setupMultiSigWallet(participants: string[]): Promise<{
    address: string;
    redeemScript: string;
    publicKeys: string[];
  }> {
    if (!this.config.multiSigThreshold || !this.config.multiSigParticipants) {
      throw new Error('Multi-sig configuration not set');
    }
    
    const { multiSigThreshold: m, multiSigParticipants: n } = this.config;
    
    if (participants.length !== n) {
      throw new Error(`Expected ${n} participants, got ${participants.length}`);
    }
    
    // Generate redeem script for m-of-n multisig
    const publicKeys = participants;
    const redeemScript = this.createMultiSigRedeemScript(m, publicKeys);
    const address = this.deriveP2SHAddress(redeemScript);
    
    return {
      address,
      redeemScript,
      publicKeys
    };
  }
  
  /**
   * Rotate encryption keys
   */
  async rotateKeys(newMasterPassword: string): Promise<void> {
    // Decrypt all keys with current master key
    const keyIds = await this.getAllKeyIds();
    const decryptedKeys = new Map<string, string>();
    
    for (const keyId of keyIds) {
      const privateKey = await this.decryptPrivateKey(keyId);
      decryptedKeys.set(keyId, privateKey);
    }
    
    // Generate new master key
    const newSalt = randomBytes(32);
    const newMasterKey = await this.deriveKey(newMasterPassword, newSalt);
    
    // Update master key
    const oldMasterKey = this.masterKey;
    this.masterKey = newMasterKey;
    
    // Re-encrypt all keys with new master key
    for (const [keyId, privateKey] of decryptedKeys) {
      await this.encryptPrivateKey(privateKey, keyId);
    }
    
    // Update salt storage
    await this.storeSalt(newSalt);
    
    // Secure cleanup
    if (oldMasterKey) {
      crypto.randomFillSync(oldMasterKey);
    }
  }
  
  /**
   * Emergency key recovery
   */
  async emergencyRecovery(recoveryShares: string[], threshold: number): Promise<void> {
    // Implement Shamir's Secret Sharing recovery
    if (recoveryShares.length < threshold) {
      throw new Error(`Need at least ${threshold} recovery shares`);
    }
    
    // Reconstruct master key from shares
    const reconstructedKey = this.reconstructFromShares(recoveryShares, threshold);
    this.masterKey = reconstructedKey;
    
    // Verify recovery was successful
    await this.verifyMasterKey();
  }
  
  /**
   * Create secure backups with encryption
   */
  private async createSecureBackups(keyId: string, encryptedKey: EncryptedKey): Promise<void> {
    for (const location of this.config.backupLocations) {
      const backupPath = path.join(location, `${keyId}.backup`);
      
      // Add additional encryption layer for backups
      const backupKey = await this.deriveKey('backup', randomBytes(32));
      const backupIv = randomBytes(16);
      
      const cipher = crypto.createCipheriv(this.ALGORITHM, backupKey, backupIv);
      const backupData = JSON.stringify(encryptedKey);
      const encryptedBackup = Buffer.concat([
        cipher.update(backupData, 'utf8'),
        cipher.final()
      ]);
      
      const backupObject = {
        data: encryptedBackup.toString('base64'),
        iv: backupIv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        timestamp: Date.now()
      };
      
      await fs.writeFile(backupPath, JSON.stringify(backupObject, null, 2));
    }
  }
  
  /**
   * Hardware wallet integration
   */
  private async generateHardwareWallet(): Promise<{
    address: string;
    publicKey: string;
    keyId: string;
  }> {
    // This would interface with actual hardware wallet APIs
    // For now, return a mock implementation
    throw new Error('Hardware wallet support not yet implemented');
  }
  
  /**
   * Key derivation using scrypt
   */
  private async deriveKey(password: string, salt: Buffer): Promise<Buffer> {
    const key = await scryptAsync(
      password,
      salt,
      this.KEY_DERIVATION_PARAMS.dkLen,
      {
        N: this.KEY_DERIVATION_PARAMS.N,
        r: this.KEY_DERIVATION_PARAMS.r,
        p: this.KEY_DERIVATION_PARAMS.p,
        maxmem: 128 * this.KEY_DERIVATION_PARAMS.N * this.KEY_DERIVATION_PARAMS.r
      }
    ) as Buffer;
    
    return key;
  }
  
  /**
   * Combine two keys using XOR
   */
  private combineKeys(key1: Buffer, key2: Buffer): Buffer {
    const combined = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
      combined[i] = key1[i] ^ key2[i % key2.length];
    }
    return combined;
  }
  
  /**
   * Store encrypted key securely
   */
  private async storeEncryptedKey(keyId: string, encryptedKey: EncryptedKey): Promise<void> {
    const keyPath = path.join(this.config.keyStorePath, `${keyId}.key`);
    await fs.mkdir(path.dirname(keyPath), { recursive: true });
    await fs.writeFile(keyPath, JSON.stringify(encryptedKey, null, 2));
    
    // Set restrictive permissions (Unix-like systems)
    try {
      await fs.chmod(keyPath, 0o600);
    } catch {
      // Windows doesn't support chmod
    }
  }
  
  /**
   * Load encrypted key from storage
   */
  private async loadEncryptedKey(keyId: string): Promise<EncryptedKey> {
    const keyPath = path.join(this.config.keyStorePath, `${keyId}.key`);
    const data = await fs.readFile(keyPath, 'utf8');
    return JSON.parse(data);
  }
  
  /**
   * Get all key IDs
   */
  private async getAllKeyIds(): Promise<string[]> {
    const files = await fs.readdir(this.config.keyStorePath);
    return files
      .filter(f => f.endsWith('.key'))
      .map(f => f.replace('.key', ''));
  }
  
  /**
   * Get or generate salt for master key
   */
  private async getSalt(): Promise<Buffer> {
    const saltPath = path.join(this.config.keyStorePath, '.salt');
    
    try {
      const salt = await fs.readFile(saltPath);
      return salt;
    } catch {
      // Generate new salt
      const salt = randomBytes(32);
      await this.storeSalt(salt);
      return salt;
    }
  }
  
  /**
   * Store salt securely
   */
  private async storeSalt(salt: Buffer): Promise<void> {
    const saltPath = path.join(this.config.keyStorePath, '.salt');
    await fs.mkdir(path.dirname(saltPath), { recursive: true });
    await fs.writeFile(saltPath, salt);
    
    try {
      await fs.chmod(saltPath, 0o600);
    } catch {
      // Windows doesn't support chmod
    }
  }
  
  /**
   * Verify master key is correct
   */
  private async verifyMasterKey(): Promise<void> {
    const testPath = path.join(this.config.keyStorePath, '.test');
    
    try {
      // Try to decrypt test value
      const testData = await fs.readFile(testPath, 'utf8');
      const parsed = JSON.parse(testData);
      
      const iv = Buffer.from(parsed.iv, 'base64');
      const tag = Buffer.from(parsed.tag, 'base64');
      const encrypted = Buffer.from(parsed.encrypted, 'base64');
      
      const decipher = crypto.createDecipheriv(this.ALGORITHM, this.masterKey!, iv);
      decipher.setAuthTag(tag);
      
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
      ]);
      
      if (decrypted.toString('utf8') !== 'OTEDAMA_WALLET_TEST') {
        throw new Error('Invalid master key');
      }
    } catch (error) {
      // Create test value if it doesn't exist
      if ((error as any).code === 'ENOENT') {
        await this.createTestValue();
      } else {
        throw new Error('Master key verification failed');
      }
    }
  }
  
  /**
   * Create test value for master key verification
   */
  private async createTestValue(): Promise<void> {
    const testValue = 'OTEDAMA_WALLET_TEST';
    const iv = randomBytes(16);
    
    const cipher = crypto.createCipheriv(this.ALGORITHM, this.masterKey!, iv);
    const encrypted = Buffer.concat([
      cipher.update(testValue, 'utf8'),
      cipher.final()
    ]);
    
    const testData = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      encrypted: encrypted.toString('base64')
    };
    
    const testPath = path.join(this.config.keyStorePath, '.test');
    await fs.writeFile(testPath, JSON.stringify(testData));
    
    try {
      await fs.chmod(testPath, 0o600);
    } catch {
      // Windows doesn't support chmod
    }
  }
  
  /**
   * Check if key rotation is needed
   */
  private async checkKeyRotation(): Promise<void> {
    const rotationPath = path.join(this.config.keyStorePath, '.rotation');
    
    try {
      const data = await fs.readFile(rotationPath, 'utf8');
      const lastRotation = parseInt(data);
      const daysSinceRotation = (Date.now() - lastRotation) / (1000 * 60 * 60 * 24);
      
      if (daysSinceRotation > this.config.rotationIntervalDays) {
        console.warn(`Key rotation recommended - last rotation was ${Math.floor(daysSinceRotation)} days ago`);
      }
    } catch {
      // First time, record current time
      await fs.writeFile(rotationPath, Date.now().toString());
    }
  }
  
  /**
   * Derive Bitcoin address from public key
   */
  private deriveBitcoinAddress(publicKey: string): string {
    // This would use bitcoinjs-lib in real implementation
    // For now, return mock address
    const hash = crypto.createHash('sha256').update(publicKey).digest();
    return '1' + hash.toString('base64').substring(0, 33);
  }
  
  /**
   * Create multi-sig redeem script
   */
  private createMultiSigRedeemScript(m: number, publicKeys: string[]): string {
    // This would create actual Bitcoin script
    // For now, return mock script
    const script = `${m} ${publicKeys.join(' ')} ${publicKeys.length} OP_CHECKMULTISIG`;
    return Buffer.from(script).toString('hex');
  }
  
  /**
   * Derive P2SH address from redeem script
   */
  private deriveP2SHAddress(redeemScript: string): string {
    // This would derive actual P2SH address
    // For now, return mock address
    const hash = crypto.createHash('sha256').update(redeemScript).digest();
    return '3' + hash.toString('base64').substring(0, 33);
  }
  
  /**
   * Reconstruct key from Shamir shares
   */
  private reconstructFromShares(shares: string[], threshold: number): Buffer {
    // This would implement Shamir's Secret Sharing
    // For now, return mock implementation
    throw new Error('Shamir recovery not yet implemented');
  }
  
  /**
   * Clean up sensitive data
   */
  async cleanup(): void {
    if (this.masterKey) {
      crypto.randomFillSync(this.masterKey);
      this.masterKey = null;
    }
  }
}

// Export for use in the pool
export default WalletSecuritySystem;
