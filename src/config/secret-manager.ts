// Secret management integration (supports HashiCorp Vault and AWS Secrets Manager)
import { createComponentLogger } from '../logging/logger';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

const logger = createComponentLogger('secret-manager');

// Secret provider interface
export interface SecretProvider {
  getName(): string;
  initialize(): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  listSecrets(prefix?: string): Promise<string[]>;
  rotateSecret(key: string): Promise<string>;
}

// Secret metadata
export interface SecretMetadata {
  key: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  rotatedAt?: Date;
  expiresAt?: Date;
  tags?: { [key: string]: string };
}

// Base secret manager
export abstract class BaseSecretManager implements SecretProvider {
  protected initialized = false;
  
  abstract getName(): string;
  abstract initialize(): Promise<void>;
  abstract getSecret(key: string): Promise<string | null>;
  abstract setSecret(key: string, value: string): Promise<void>;
  abstract deleteSecret(key: string): Promise<void>;
  abstract listSecrets(prefix?: string): Promise<string[]>;
  
  async rotateSecret(key: string): Promise<string> {
    const newValue = this.generateSecretValue();
    await this.setSecret(key, newValue);
    return newValue;
  }
  
  protected generateSecretValue(length: number = 32): string {
    return crypto.randomBytes(length).toString('base64');
  }
  
  protected validateKey(key: string): void {
    if (!key || typeof key !== 'string') {
      throw new Error('Invalid secret key');
    }
    
    if (!/^[a-zA-Z0-9/_-]+$/.test(key)) {
      throw new Error('Secret key contains invalid characters');
    }
  }
}

// Local file-based secret storage (development only)
export class LocalSecretManager extends BaseSecretManager {
  private secretsPath: string;
  private secrets: Map<string, string> = new Map();
  private encryptionKey: Buffer;
  
  constructor(secretsPath: string = './secrets') {
    super();
    this.secretsPath = secretsPath;
    
    // Generate or load encryption key
    const keyPath = path.join(this.secretsPath, '.key');
    try {
      this.encryptionKey = Buffer.from(
        require('fs').readFileSync(keyPath, 'utf8'),
        'hex'
      );
    } catch {
      this.encryptionKey = crypto.randomBytes(32);
      require('fs').mkdirSync(this.secretsPath, { recursive: true });
      require('fs').writeFileSync(keyPath, this.encryptionKey.toString('hex'));
    }
  }
  
  getName(): string {
    return 'local';
  }
  
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      await fs.mkdir(this.secretsPath, { recursive: true });
      await this.loadSecrets();
      this.initialized = true;
      logger.info('Local secret manager initialized');
    } catch (error) {
      logger.error('Failed to initialize local secret manager', error);
      throw error;
    }
  }
  
  async getSecret(key: string): Promise<string | null> {
    this.validateKey(key);
    
    const encrypted = this.secrets.get(key);
    if (!encrypted) return null;
    
    return this.decrypt(encrypted);
  }
  
  async setSecret(key: string, value: string): Promise<void> {
    this.validateKey(key);
    
    const encrypted = this.encrypt(value);
    this.secrets.set(key, encrypted);
    
    await this.saveSecrets();
  }
  
  async deleteSecret(key: string): Promise<void> {
    this.validateKey(key);
    
    this.secrets.delete(key);
    await this.saveSecrets();
  }
  
  async listSecrets(prefix?: string): Promise<string[]> {
    const keys = Array.from(this.secrets.keys());
    
    if (prefix) {
      return keys.filter(k => k.startsWith(prefix));
    }
    
    return keys;
  }
  
  private async loadSecrets(): Promise<void> {
    try {
      const filePath = path.join(this.secretsPath, 'secrets.enc');
      const data = await fs.readFile(filePath, 'utf8');
      const lines = data.split('\n').filter(l => l.trim());
      
      for (const line of lines) {
        const [key, value] = line.split('=');
        if (key && value) {
          this.secrets.set(key, value);
        }
      }
    } catch (error) {
      // File doesn't exist yet
      if ((error as any).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  
  private async saveSecrets(): Promise<void> {
    const lines = Array.from(this.secrets.entries())
      .map(([key, value]) => `${key}=${value}`);
    
    const filePath = path.join(this.secretsPath, 'secrets.enc');
    await fs.writeFile(filePath, lines.join('\n'), 'utf8');
  }
  
  private encrypt(value: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      'aes-256-cbc',
      this.encryptionKey,
      iv
    );
    
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return iv.toString('hex') + ':' + encrypted;
  }
  
  private decrypt(encrypted: string): string {
    const [ivHex, encryptedHex] = encrypted.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      this.encryptionKey,
      iv
    );
    
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
}

// HashiCorp Vault integration
export class VaultSecretManager extends BaseSecretManager {
  private vaultUrl: string;
  private token: string;
  private mountPath: string;
  private namespace?: string;
  
  constructor(config: {
    url: string;
    token: string;
    mountPath?: string;
    namespace?: string;
  }) {
    super();
    this.vaultUrl = config.url;
    this.token = config.token;
    this.mountPath = config.mountPath || 'secret';
    this.namespace = config.namespace;
  }
  
  getName(): string {
    return 'vault';
  }
  
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      // Verify connection to Vault
      const response = await this.request('GET', '/v1/sys/health');
      
      if (response.sealed) {
        throw new Error('Vault is sealed');
      }
      
      this.initialized = true;
      logger.info('Vault secret manager initialized');
    } catch (error) {
      logger.error('Failed to initialize Vault secret manager', error);
      throw error;
    }
  }
  
  async getSecret(key: string): Promise<string | null> {
    this.validateKey(key);
    
    try {
      const response = await this.request(
        'GET',
        `/v1/${this.mountPath}/data/${key}`
      );
      
      return response.data?.data?.value || null;
    } catch (error) {
      if ((error as any).statusCode === 404) {
        return null;
      }
      throw error;
    }
  }
  
  async setSecret(key: string, value: string): Promise<void> {
    this.validateKey(key);
    
    await this.request(
      'POST',
      `/v1/${this.mountPath}/data/${key}`,
      {
        data: { value }
      }
    );
  }
  
  async deleteSecret(key: string): Promise<void> {
    this.validateKey(key);
    
    await this.request(
      'DELETE',
      `/v1/${this.mountPath}/metadata/${key}`
    );
  }
  
  async listSecrets(prefix?: string): Promise<string[]> {
    try {
      const response = await this.request(
        'LIST',
        `/v1/${this.mountPath}/metadata/${prefix || ''}`
      );
      
      return response.data?.keys || [];
    } catch (error) {
      if ((error as any).statusCode === 404) {
        return [];
      }
      throw error;
    }
  }
  
  private async request(
    method: string,
    path: string,
    body?: any
  ): Promise<any> {
    const url = `${this.vaultUrl}${path}`;
    const headers: any = {
      'X-Vault-Token': this.token,
      'Content-Type': 'application/json'
    };
    
    if (this.namespace) {
      headers['X-Vault-Namespace'] = this.namespace;
    }
    
    // Simple HTTP request implementation
    // In production, use a proper HTTP client like axios
    return new Promise((resolve, reject) => {
      const https = require('https');
      const urlParts = new URL(url);
      
      const options = {
        hostname: urlParts.hostname,
        port: urlParts.port || 443,
        path: urlParts.pathname + urlParts.search,
        method,
        headers
      };
      
      const req = https.request(options, (res: any) => {
        let data = '';
        
        res.on('data', (chunk: any) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            
            if (res.statusCode >= 400) {
              const error: any = new Error(parsed.errors?.[0] || 'Request failed');
              error.statusCode = res.statusCode;
              reject(error);
            } else {
              resolve(parsed);
            }
          } catch (error) {
            reject(error);
          }
        });
      });
      
      req.on('error', reject);
      
      if (body) {
        req.write(JSON.stringify(body));
      }
      
      req.end();
    });
  }
}

// AWS Secrets Manager integration
export class AWSSecretManager extends BaseSecretManager {
  private region: string;
  private accessKeyId?: string;
  private secretAccessKey?: string;
  
  constructor(config: {
    region: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  }) {
    super();
    this.region = config.region;
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
  }
  
  getName(): string {
    return 'aws-secrets-manager';
  }
  
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      // AWS SDK would be initialized here
      // For now, we'll use AWS CLI as a simple implementation
      this.initialized = true;
      logger.info('AWS Secrets Manager initialized');
    } catch (error) {
      logger.error('Failed to initialize AWS Secrets Manager', error);
      throw error;
    }
  }
  
  async getSecret(key: string): Promise<string | null> {
    this.validateKey(key);
    
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      const { stdout } = await execAsync(
        `aws secretsmanager get-secret-value --secret-id ${key} --region ${this.region}`
      );
      
      const result = JSON.parse(stdout);
      return result.SecretString || null;
    } catch (error) {
      if ((error as any).message.includes('ResourceNotFoundException')) {
        return null;
      }
      throw error;
    }
  }
  
  async setSecret(key: string, value: string): Promise<void> {
    this.validateKey(key);
    
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    try {
      // Try to update existing secret
      await execAsync(
        `aws secretsmanager update-secret --secret-id ${key} --secret-string "${value}" --region ${this.region}`
      );
    } catch (error) {
      // If secret doesn't exist, create it
      if ((error as any).message.includes('ResourceNotFoundException')) {
        await execAsync(
          `aws secretsmanager create-secret --name ${key} --secret-string "${value}" --region ${this.region}`
        );
      } else {
        throw error;
      }
    }
  }
  
  async deleteSecret(key: string): Promise<void> {
    this.validateKey(key);
    
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    await execAsync(
      `aws secretsmanager delete-secret --secret-id ${key} --force-delete-without-recovery --region ${this.region}`
    );
  }
  
  async listSecrets(prefix?: string): Promise<string[]> {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    const { stdout } = await execAsync(
      `aws secretsmanager list-secrets --region ${this.region}`
    );
    
    const result = JSON.parse(stdout);
    let secrets = result.SecretList.map((s: any) => s.Name);
    
    if (prefix) {
      secrets = secrets.filter((s: string) => s.startsWith(prefix));
    }
    
    return secrets;
  }
}

// Secret manager factory
export class SecretManagerFactory {
  private static providers = new Map<string, () => SecretProvider>();
  
  static {
    // Register default providers
    this.register('local', () => new LocalSecretManager());
    
    this.register('vault', () => {
      if (!process.env.VAULT_URL || !process.env.VAULT_TOKEN) {
        throw new Error('Vault URL and token are required');
      }
      
      return new VaultSecretManager({
        url: process.env.VAULT_URL,
        token: process.env.VAULT_TOKEN,
        mountPath: process.env.VAULT_MOUNT_PATH,
        namespace: process.env.VAULT_NAMESPACE
      });
    });
    
    this.register('aws', () => {
      if (!process.env.AWS_REGION) {
        throw new Error('AWS region is required');
      }
      
      return new AWSSecretManager({
        region: process.env.AWS_REGION,
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      });
    });
  }
  
  static register(name: string, factory: () => SecretProvider): void {
    this.providers.set(name, factory);
  }
  
  static create(provider?: string): SecretProvider {
    const providerName = provider || process.env.SECRET_PROVIDER || 'local';
    const factory = this.providers.get(providerName);
    
    if (!factory) {
      throw new Error(`Unknown secret provider: ${providerName}`);
    }
    
    return factory();
  }
}

// Singleton secret manager
let secretManager: SecretProvider;

export async function getSecretManager(): Promise<SecretProvider> {
  if (!secretManager) {
    secretManager = SecretManagerFactory.create();
    await secretManager.initialize();
  }
  
  return secretManager;
}

// Helper functions
export async function getSecret(key: string): Promise<string | null> {
  const manager = await getSecretManager();
  return manager.getSecret(key);
}

export async function setSecret(key: string, value: string): Promise<void> {
  const manager = await getSecretManager();
  return manager.setSecret(key, value);
}

export async function deleteSecret(key: string): Promise<void> {
  const manager = await getSecretManager();
  return manager.deleteSecret(key);
}

export async function rotateSecret(key: string): Promise<string> {
  const manager = await getSecretManager();
  return manager.rotateSecret(key);
}
