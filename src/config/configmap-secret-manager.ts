/**
 * ConfigMap and Secret Manager
 * Kubernetes ConfigMap/Secret統合と動的設定管理
 * 
 * 設計思想：
 * - Carmack: 高速な設定読み込みとキャッシング
 * - Martin: 階層的で型安全な設定管理
 * - Pike: シンプルで使いやすい設定API
 */

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '../logging/logger';
import Joi from 'joi';

// === 型定義 ===
export interface ConfigSource {
  type: 'file' | 'env' | 'k8s-configmap' | 'k8s-secret' | 'vault' | 'remote';
  name: string;
  path?: string;
  optional?: boolean;
  watch?: boolean;
  format?: 'json' | 'yaml' | 'properties' | 'env';
  decrypt?: boolean;
}

export interface ConfigSchema {
  [key: string]: Joi.Schema | ConfigSchema;
}

export interface ConfigOptions {
  sources: ConfigSource[];
  schema?: ConfigSchema;
  defaults?: any;
  transformers?: ConfigTransformer[];
  watchInterval?: number;
  cacheEnabled?: boolean;
  cacheTTL?: number;
  encryptionKey?: string;
}

export interface ConfigTransformer {
  name: string;
  transform: (config: any) => any | Promise<any>;
}

export interface ConfigChange {
  path: string;
  oldValue: any;
  newValue: any;
  source: string;
  timestamp: number;
}

export interface SecretMetadata {
  version: string;
  created: number;
  rotated?: number;
  expiresAt?: number;
  algorithm: string;
}

// === ConfigMap/Secret Manager ===
export class ConfigSecretManager extends EventEmitter {
  private config: any = {};
  private secrets: Map<string, any> = new Map();
  private sources: Map<string, ConfigSource> = new Map();
  private watchers: Map<string, fs.FileHandle | NodeJS.Timer> = new Map();
  private cache: Map<string, { value: any; expires: number }> = new Map();
  private schema?: Joi.ObjectSchema;
  private encryptionKey?: Buffer;
  
  constructor(private options: ConfigOptions) {
    super();
    
    // 暗号化キーの設定
    if (options.encryptionKey) {
      this.encryptionKey = crypto.scryptSync(options.encryptionKey, 'salt', 32);
    }
    
    // スキーマのコンパイル
    if (options.schema) {
      this.schema = this.compileSchema(options.schema);
    }
    
    // ソースの登録
    for (const source of options.sources) {
      this.sources.set(source.name, source);
    }
  }
  
  // 初期化と読み込み
  async initialize(): Promise<void> {
    // デフォルト値の適用
    if (this.options.defaults) {
      this.config = this.deepClone(this.options.defaults);
    }
    
    // 各ソースからの読み込み
    for (const source of this.options.sources) {
      try {
        await this.loadFromSource(source);
        
        // ウォッチの設定
        if (source.watch) {
          await this.watchSource(source);
        }
      } catch (error) {
        if (!source.optional) {
          throw new Error(`Failed to load config from ${source.name}: ${error.message}`);
        }
        logger.warn(`Optional config source ${source.name} failed:`, error.message);
      }
    }
    
    // トランスフォーマーの適用
    if (this.options.transformers) {
      for (const transformer of this.options.transformers) {
        this.config = await transformer.transform(this.config);
      }
    }
    
    // スキーマ検証
    if (this.schema) {
      const { error, value } = this.schema.validate(this.config);
      if (error) {
        throw new Error(`Config validation failed: ${error.message}`);
      }
      this.config = value;
    }
    
    logger.info('Configuration loaded successfully');
    this.emit('loaded', this.config);
  }
  
  // ソースからの読み込み
  private async loadFromSource(source: ConfigSource): Promise<void> {
    switch (source.type) {
      case 'file':
        await this.loadFromFile(source);
        break;
        
      case 'env':
        await this.loadFromEnv(source);
        break;
        
      case 'k8s-configmap':
        await this.loadFromConfigMap(source);
        break;
        
      case 'k8s-secret':
        await this.loadFromSecret(source);
        break;
        
      case 'vault':
        await this.loadFromVault(source);
        break;
        
      case 'remote':
        await this.loadFromRemote(source);
        break;
        
      default:
        throw new Error(`Unknown config source type: ${source.type}`);
    }
  }
  
  // ファイルからの読み込み
  private async loadFromFile(source: ConfigSource): Promise<void> {
    if (!source.path) {
      throw new Error('File path is required for file source');
    }
    
    const content = await fs.readFile(source.path, 'utf-8');
    const data = await this.parseContent(content, source.format || 'json');
    
    if (source.decrypt && this.encryptionKey) {
      this.mergeConfig(await this.decryptObject(data), source.name);
    } else {
      this.mergeConfig(data, source.name);
    }
  }
  
  // 環境変数からの読み込み
  private async loadFromEnv(source: ConfigSource): Promise<void> {
    const prefix = source.name.toUpperCase() + '_';
    const envConfig: any = {};
    
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(prefix)) {
        const configKey = key
          .substring(prefix.length)
          .toLowerCase()
          .replace(/_/g, '.');
        
        this.setNestedValue(envConfig, configKey, this.parseEnvValue(value!));
      }
    }
    
    this.mergeConfig(envConfig, source.name);
  }
  
  // Kubernetes ConfigMapからの読み込み
  private async loadFromConfigMap(source: ConfigSource): Promise<void> {
    const configMapPath = source.path || `/etc/config/${source.name}`;
    
    try {
      const files = await fs.readdir(configMapPath);
      const configData: any = {};
      
      for (const file of files) {
        const filePath = path.join(configMapPath, file);
        const stat = await fs.stat(filePath);
        
        if (stat.isFile()) {
          const content = await fs.readFile(filePath, 'utf-8');
          
          // ファイル名をキーとして使用
          if (file.endsWith('.json')) {
            configData[file.replace('.json', '')] = JSON.parse(content);
          } else if (file.endsWith('.yaml') || file.endsWith('.yml')) {
            const yaml = await import('js-yaml');
            configData[file.replace(/\.(yaml|yml)$/, '')] = yaml.load(content);
          } else {
            configData[file] = content.trim();
          }
        }
      }
      
      this.mergeConfig(configData, source.name);
    } catch (error) {
      if (error.code === 'ENOENT' && source.optional) {
        logger.debug(`ConfigMap ${source.name} not found (optional)`);
      } else {
        throw error;
      }
    }
  }
  
  // Kubernetes Secretからの読み込み
  private async loadFromSecret(source: ConfigSource): Promise<void> {
    const secretPath = source.path || `/etc/secrets/${source.name}`;
    
    try {
      const files = await fs.readdir(secretPath);
      const secretData: any = {};
      
      for (const file of files) {
        const filePath = path.join(secretPath, file);
        const stat = await fs.stat(filePath);
        
        if (stat.isFile()) {
          const content = await fs.readFile(filePath, 'utf-8');
          
          // Base64デコード（K8s Secretは自動的にデコードされる）
          secretData[file] = content.trim();
          
          // 特別な処理
          if (file === 'tls.crt' || file === 'tls.key') {
            this.secrets.set(file, content);
          } else {
            this.secrets.set(file, content);
          }
        }
      }
      
      // 設定にマージ（センシティブ情報は別管理）
      this.mergeConfig({ secrets: Object.keys(secretData) }, source.name);
    } catch (error) {
      if (error.code === 'ENOENT' && source.optional) {
        logger.debug(`Secret ${source.name} not found (optional)`);
      } else {
        throw error;
      }
    }
  }
  
  // HashiCorp Vaultからの読み込み
  private async loadFromVault(source: ConfigSource): Promise<void> {
    // Vault統合の実装
    logger.warn('Vault integration not implemented');
  }
  
  // リモートソースからの読み込み
  private async loadFromRemote(source: ConfigSource): Promise<void> {
    if (!source.path) {
      throw new Error('URL is required for remote source');
    }
    
    const response = await fetch(source.path, {
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Remote config fetch failed: ${response.statusText}`);
    }
    
    const data = await response.json();
    this.mergeConfig(data, source.name);
  }
  
  // ソースの監視
  private async watchSource(source: ConfigSource): Promise<void> {
    switch (source.type) {
      case 'file':
        await this.watchFile(source);
        break;
        
      case 'k8s-configmap':
      case 'k8s-secret':
        await this.watchK8sResource(source);
        break;
        
      default:
        logger.debug(`Watch not supported for source type: ${source.type}`);
    }
  }
  
  // ファイル監視
  private async watchFile(source: ConfigSource): Promise<void> {
    if (!source.path) return;
    
    const watcher = fs.watch(source.path);
    
    for await (const event of watcher) {
      if (event.eventType === 'change') {
        logger.info(`Config file changed: ${source.path}`);
        
        try {
          const oldConfig = this.deepClone(this.config);
          await this.loadFromSource(source);
          
          // 変更検知
          const changes = this.detectChanges(oldConfig, this.config);
          if (changes.length > 0) {
            this.emit('changed', changes);
          }
        } catch (error) {
          logger.error(`Failed to reload config from ${source.name}:`, error);
          this.emit('error', error);
        }
      }
    }
    
    this.watchers.set(source.name, watcher);
  }
  
  // K8sリソース監視
  private async watchK8sResource(source: ConfigSource): Promise<void> {
    // inotifyを使用したディレクトリ監視
    const watchPath = source.path || 
      (source.type === 'k8s-configmap' ? `/etc/config/${source.name}` : `/etc/secrets/${source.name}`);
    
    const interval = setInterval(async () => {
      try {
        const oldConfig = this.deepClone(this.config);
        await this.loadFromSource(source);
        
        const changes = this.detectChanges(oldConfig, this.config);
        if (changes.length > 0) {
          logger.info(`K8s ${source.type} changed: ${source.name}`);
          this.emit('changed', changes);
        }
      } catch (error) {
        logger.error(`Failed to check K8s resource ${source.name}:`, error);
      }
    }, this.options.watchInterval || 10000);
    
    this.watchers.set(source.name, interval);
  }
  
  // 設定の取得
  get<T = any>(path?: string, defaultValue?: T): T {
    if (!path) {
      return this.config as T;
    }
    
    // キャッシュチェック
    if (this.options.cacheEnabled) {
      const cached = this.cache.get(path);
      if (cached && cached.expires > Date.now()) {
        return cached.value as T;
      }
    }
    
    const value = this.getNestedValue(this.config, path) ?? defaultValue;
    
    // キャッシュ更新
    if (this.options.cacheEnabled && value !== undefined) {
      this.cache.set(path, {
        value,
        expires: Date.now() + (this.options.cacheTTL || 60000)
      });
    }
    
    return value as T;
  }
  
  // 設定の設定（実行時）
  set(path: string, value: any): void {
    const oldValue = this.getNestedValue(this.config, path);
    this.setNestedValue(this.config, path, value);
    
    // キャッシュクリア
    this.cache.delete(path);
    
    // 変更通知
    if (oldValue !== value) {
      this.emit('changed', [{
        path,
        oldValue,
        newValue: value,
        source: 'runtime',
        timestamp: Date.now()
      }]);
    }
  }
  
  // シークレットの取得
  getSecret(name: string): string | undefined {
    return this.secrets.get(name);
  }
  
  // シークレットの設定
  setSecret(name: string, value: string, metadata?: SecretMetadata): void {
    this.secrets.set(name, value);
    
    if (metadata) {
      this.secrets.set(`${name}:metadata`, metadata);
    }
    
    this.emit('secretUpdated', { name, metadata });
  }
  
  // シークレットのローテーション
  async rotateSecret(name: string, newValue: string): Promise<void> {
    const oldMetadata = this.secrets.get(`${name}:metadata`) as SecretMetadata;
    
    const newMetadata: SecretMetadata = {
      version: oldMetadata ? String(parseInt(oldMetadata.version) + 1) : '1',
      created: oldMetadata?.created || Date.now(),
      rotated: Date.now(),
      algorithm: oldMetadata?.algorithm || 'aes-256-gcm'
    };
    
    this.setSecret(name, newValue, newMetadata);
    
    logger.info(`Secret rotated: ${name} (version ${newMetadata.version})`);
  }
  
  // 暗号化
  async encrypt(data: string): Promise<string> {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not configured');
    }
    
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return JSON.stringify({
      encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex')
    });
  }
  
  // 復号化
  async decrypt(encryptedData: string): Promise<string> {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not configured');
    }
    
    const { encrypted, iv, authTag } = JSON.parse(encryptedData);
    
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(iv, 'hex')
    );
    
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
  
  // オブジェクト全体の暗号化
  private async encryptObject(obj: any): Promise<any> {
    if (typeof obj === 'string') {
      return await this.encrypt(obj);
    } else if (Array.isArray(obj)) {
      return Promise.all(obj.map(item => this.encryptObject(item)));
    } else if (obj && typeof obj === 'object') {
      const encrypted: any = {};
      for (const [key, value] of Object.entries(obj)) {
        encrypted[key] = await this.encryptObject(value);
      }
      return encrypted;
    }
    return obj;
  }
  
  // オブジェクト全体の復号化
  private async decryptObject(obj: any): Promise<any> {
    if (typeof obj === 'string' && obj.startsWith('{"encrypted":')) {
      return await this.decrypt(obj);
    } else if (Array.isArray(obj)) {
      return Promise.all(obj.map(item => this.decryptObject(item)));
    } else if (obj && typeof obj === 'object') {
      const decrypted: any = {};
      for (const [key, value] of Object.entries(obj)) {
        decrypted[key] = await this.decryptObject(value);
      }
      return decrypted;
    }
    return obj;
  }
  
  // ヘルパーメソッド
  private mergeConfig(data: any, source: string): void {
    this.config = this.deepMerge(this.config, data);
    logger.debug(`Config merged from source: ${source}`);
  }
  
  private deepMerge(target: any, source: any): any {
    if (!source) return target;
    
    const output = { ...target };
    
    for (const key in source) {
      if (source.hasOwnProperty(key)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          output[key] = this.deepMerge(target[key] || {}, source[key]);
        } else {
          output[key] = source[key];
        }
      }
    }
    
    return output;
  }
  
  private deepClone(obj: any): any {
    return JSON.parse(JSON.stringify(obj));
  }
  
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }
  
  private setNestedValue(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    const lastKey = keys.pop()!;
    
    const target = keys.reduce((current, key) => {
      if (!current[key]) {
        current[key] = {};
      }
      return current[key];
    }, obj);
    
    target[lastKey] = value;
  }
  
  private parseEnvValue(value: string): any {
    // Boolean
    if (value === 'true') return true;
    if (value === 'false') return false;
    
    // Number
    if (/^\d+$/.test(value)) return parseInt(value);
    if (/^\d*\.\d+$/.test(value)) return parseFloat(value);
    
    // JSON
    if (value.startsWith('{') || value.startsWith('[')) {
      try {
        return JSON.parse(value);
      } catch {
        // Not valid JSON
      }
    }
    
    return value;
  }
  
  private async parseContent(content: string, format: string): Promise<any> {
    switch (format) {
      case 'json':
        return JSON.parse(content);
        
      case 'yaml':
        const yaml = await import('js-yaml');
        return yaml.load(content);
        
      case 'properties':
        return this.parseProperties(content);
        
      case 'env':
        return this.parseEnvFile(content);
        
      default:
        throw new Error(`Unknown format: ${format}`);
    }
  }
  
  private parseProperties(content: string): any {
    const result: any = {};
    
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const [key, ...valueParts] = trimmed.split('=');
      if (key) {
        this.setNestedValue(result, key.trim(), valueParts.join('=').trim());
      }
    }
    
    return result;
  }
  
  private parseEnvFile(content: string): any {
    const result: any = {};
    
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const [key, ...valueParts] = trimmed.split('=');
      if (key) {
        result[key.trim()] = this.parseEnvValue(valueParts.join('=').trim());
      }
    }
    
    return result;
  }
  
  private detectChanges(oldConfig: any, newConfig: any, basePath = ''): ConfigChange[] {
    const changes: ConfigChange[] = [];
    
    // 新しいキーと変更されたキー
    for (const key in newConfig) {
      const path = basePath ? `${basePath}.${key}` : key;
      
      if (!(key in oldConfig)) {
        changes.push({
          path,
          oldValue: undefined,
          newValue: newConfig[key],
          source: 'update',
          timestamp: Date.now()
        });
      } else if (typeof newConfig[key] === 'object' && !Array.isArray(newConfig[key])) {
        changes.push(...this.detectChanges(oldConfig[key], newConfig[key], path));
      } else if (JSON.stringify(oldConfig[key]) !== JSON.stringify(newConfig[key])) {
        changes.push({
          path,
          oldValue: oldConfig[key],
          newValue: newConfig[key],
          source: 'update',
          timestamp: Date.now()
        });
      }
    }
    
    // 削除されたキー
    for (const key in oldConfig) {
      if (!(key in newConfig)) {
        const path = basePath ? `${basePath}.${key}` : key;
        changes.push({
          path,
          oldValue: oldConfig[key],
          newValue: undefined,
          source: 'update',
          timestamp: Date.now()
        });
      }
    }
    
    return changes;
  }
  
  private compileSchema(schema: ConfigSchema): Joi.ObjectSchema {
    const joiSchema: any = {};
    
    for (const [key, value] of Object.entries(schema)) {
      if (value instanceof Joi.Schema) {
        joiSchema[key] = value;
      } else {
        joiSchema[key] = this.compileSchema(value as ConfigSchema);
      }
    }
    
    return Joi.object(joiSchema);
  }
  
  // クリーンアップ
  async cleanup(): Promise<void> {
    for (const [name, watcher] of this.watchers) {
      if (watcher instanceof NodeJS.Timer) {
        clearInterval(watcher);
      } else {
        await watcher.close();
      }
    }
    
    this.watchers.clear();
    this.cache.clear();
    
    logger.info('ConfigSecretManager cleaned up');
  }
}

// === 使用例 ===
/*
// 設定管理の初期化
const configManager = new ConfigSecretManager({
  sources: [
    // デフォルト設定
    {
      type: 'file',
      name: 'defaults',
      path: './config/default.json',
      format: 'json'
    },
    
    // 環境変数
    {
      type: 'env',
      name: 'app',
      optional: true
    },
    
    // Kubernetes ConfigMap
    {
      type: 'k8s-configmap',
      name: 'app-config',
      watch: true,
      optional: true
    },
    
    // Kubernetes Secret
    {
      type: 'k8s-secret',
      name: 'app-secrets',
      watch: true
    }
  ],
  
  schema: {
    server: {
      port: Joi.number().port().required(),
      host: Joi.string().hostname().default('0.0.0.0')
    },
    database: {
      host: Joi.string().required(),
      port: Joi.number().port().required(),
      name: Joi.string().required()
    }
  },
  
  transformers: [
    {
      name: 'expand-env',
      transform: (config) => {
        // ${VAR} 形式の環境変数を展開
        return JSON.parse(
          JSON.stringify(config).replace(
            /\$\{([^}]+)\}/g,
            (_, key) => process.env[key] || ''
          )
        );
      }
    }
  ],
  
  cacheEnabled: true,
  cacheTTL: 60000,
  encryptionKey: process.env.CONFIG_ENCRYPTION_KEY
});

// 初期化
await configManager.initialize();

// 設定の取得
const serverPort = configManager.get('server.port');
const dbConfig = configManager.get<DatabaseConfig>('database');

// シークレットの取得
const apiKey = configManager.getSecret('api-key');

// 変更の監視
configManager.on('changed', (changes) => {
  for (const change of changes) {
    console.log(`Config changed: ${change.path}`);
  }
});
*/

export default ConfigSecretManager;