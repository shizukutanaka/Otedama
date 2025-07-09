/**
 * App Config Manager - アプリケーション設定管理
 * 
 * 設計思想: Robert C. Martin (クリーンコード)
 * 
 * 機能:
 * - ユーザー設定の永続化
 * - 通貨別ウォレットアドレス管理
 * - マイニング設定管理
 * - デバイス設定保存
 * - 暗号化された安全な保存
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';

export interface CurrencyConfig {
  symbol: string;
  name: string;
  payoutAddress: string;
  workerName: string;
  minPayout: number;
  enabled: boolean;
  algorithm: string;
  poolUrl?: string;
  customSettings?: Record<string, any>;
}

export interface DeviceConfig {
  id: string;
  enabled: boolean;
  intensity: number;
  powerLimit: number;
  temperatureLimit: number;
  fanSpeed: number;
  customArgs: string[];
}

export interface MiningSettings {
  autoStart: boolean;
  autoOptimize: boolean;
  powerMode: 'eco' | 'balanced' | 'performance';
  temperatureTarget: number;
  powerCostPerKwh: number;
  profitSwitching: boolean;
  minProfitSwitchPercentage: number;
}

export interface SecuritySettings {
  encryptConfig: boolean;
  requirePassword: boolean;
  autoLockMinutes: number;
  backupEnabled: boolean;
  backupLocation: string;
}

export interface UISettings {
  theme: 'light' | 'dark' | 'auto';
  language: string;
  startMinimized: boolean;
  minimizeToTray: boolean;
  showNotifications: boolean;
  autoCheckUpdates: boolean;
  refreshInterval: number;
}

export interface AppConfig {
  version: string;
  currencies: Map<string, CurrencyConfig>;
  devices: Map<string, DeviceConfig>;
  mining: MiningSettings;
  security: SecuritySettings;
  ui: UISettings;
  lastModified: number;
}

export class ConfigManager {
  private config: AppConfig;
  private configPath: string;
  private encryptionKey?: Buffer;
  private isEncrypted: boolean = false;

  constructor() {
    this.configPath = this.getConfigPath();
    this.config = this.createDefaultConfig();
  }

  private getConfigPath(): string {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'otedama-config.json');
  }

  private createDefaultConfig(): AppConfig {
    return {
      version: '1.0.0',
      currencies: new Map([
        ['XMR', {
          symbol: 'XMR',
          name: 'Monero',
          payoutAddress: '',
          workerName: 'Otedama-Worker',
          minPayout: 0.001,
          enabled: true,
          algorithm: 'RandomX',
          poolUrl: 'stratum+tcp://localhost:8333',
          customSettings: {
            profitability: 676,
            estimatedDaily: 0.86
          }
        }],
        ['RVN', {
          symbol: 'RVN',
          name: 'Ravencoin',
          payoutAddress: '',
          workerName: 'Otedama-Worker',
          minPayout: 10,
          enabled: true,
          algorithm: 'KawPow',
          poolUrl: 'stratum+tcp://localhost:8333',
          customSettings: {
            profitability: 550,
            estimatedDaily: 1.15
          }
        }],
        ['ETC', {
          symbol: 'ETC',
          name: 'Ethereum Classic',
          payoutAddress: '',
          workerName: 'Otedama-Worker',
          minPayout: 0.01,
          enabled: true,
          algorithm: 'Ethash',
          poolUrl: 'stratum+tcp://localhost:8333',
          customSettings: {
            profitability: 676,
            estimatedDaily: 0.95
          }
        }],
        ['ERG', {
          symbol: 'ERG',
          name: 'Ergo',
          payoutAddress: '',
          workerName: 'Otedama-Worker',
          minPayout: 1,
          enabled: true,
          algorithm: 'Autolykos2',
          poolUrl: 'stratum+tcp://localhost:8333',
          customSettings: {
            profitability: 581,
            estimatedDaily: 1.05
          }
        }],
        ['FLUX', {
          symbol: 'FLUX',
          name: 'Flux',
          payoutAddress: '',
          workerName: 'Otedama-Worker',
          minPayout: 5,
          enabled: true,
          algorithm: 'ZelHash',
          poolUrl: 'stratum+tcp://localhost:8333',
          customSettings: {
            profitability: 625,
            estimatedDaily: 1.25
          }
        }],
        ['KAS', {
          symbol: 'KAS',
          name: 'Kaspa',
          payoutAddress: '',
          workerName: 'Otedama-Worker',
          minPayout: 100,
          enabled: true,
          algorithm: 'kHeavyHash',
          poolUrl: 'stratum+tcp://localhost:8333',
          customSettings: {
            profitability: 410,
            estimatedDaily: 0.78
          }
        }],
        ['BTC', {
          symbol: 'BTC',
          name: 'Bitcoin',
          payoutAddress: '',
          workerName: 'Otedama-Worker',
          minPayout: 0.00001,
          enabled: true,
          algorithm: 'SHA-256',
          poolUrl: 'stratum+tcp://localhost:8333',
          customSettings: {
            profitability: 385,
            estimatedDaily: 12.50
          }
        }]
      ]),
      devices: new Map(),
      mining: {
        autoStart: false,
        autoOptimize: true,
        powerMode: 'balanced',
        temperatureTarget: 75,
        powerCostPerKwh: 0.10,
        profitSwitching: true,
        minProfitSwitchPercentage: 5
      },
      security: {
        encryptConfig: false,
        requirePassword: false,
        autoLockMinutes: 30,
        backupEnabled: true,
        backupLocation: path.join(app.getPath('documents'), 'Otedama Backups')
      },
      ui: {
        theme: 'dark',
        language: 'en',
        startMinimized: false,
        minimizeToTray: true,
        showNotifications: true,
        autoCheckUpdates: true,
        refreshInterval: 5000
      },
      lastModified: Date.now()
    };
  }

  async load(): Promise<void> {
    try {
      if (!fs.existsSync(this.configPath)) {
        // 初回起動時は既定設定を保存
        await this.save();
        return;
      }

      const data = fs.readFileSync(this.configPath, 'utf8');
      const parsed = JSON.parse(data);

      // 暗号化チェック
      if (parsed.encrypted) {
        if (!this.encryptionKey) {
          throw new Error('Config is encrypted but no decryption key provided');
        }
        const decryptedData = this.decrypt(parsed.data);
        const config = JSON.parse(decryptedData);
        this.config = this.deserializeConfig(config);
        this.isEncrypted = true;
      } else {
        this.config = this.deserializeConfig(parsed);
      }

      // 設定バージョンチェック・マイグレーション
      await this.migrateConfig();

    } catch (error) {
      console.error('Failed to load config, using defaults:', error);
      this.config = this.createDefaultConfig();
    }
  }

  async save(): Promise<void> {
    try {
      this.config.lastModified = Date.now();
      
      let dataToSave: any;
      
      if (this.isEncrypted && this.encryptionKey) {
        const serialized = this.serializeConfig(this.config);
        const encrypted = this.encrypt(JSON.stringify(serialized));
        dataToSave = {
          encrypted: true,
          data: encrypted,
          version: this.config.version
        };
      } else {
        dataToSave = this.serializeConfig(this.config);
      }

      // 設定ディレクトリが存在しない場合は作成
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // バックアップ作成
      if (fs.existsSync(this.configPath) && this.config.security.backupEnabled) {
        await this.createBackup();
      }

      fs.writeFileSync(this.configPath, JSON.stringify(dataToSave, null, 2));

    } catch (error) {
      console.error('Failed to save config:', error);
      throw error;
    }
  }

  private serializeConfig(config: AppConfig): any {
    return {
      ...config,
      currencies: Array.from(config.currencies.entries()),
      devices: Array.from(config.devices.entries())
    };
  }

  private deserializeConfig(data: any): AppConfig {
    return {
      ...data,
      currencies: new Map(data.currencies || []),
      devices: new Map(data.devices || [])
    };
  }

  private async migrateConfig(): Promise<void> {
    // 設定バージョンのマイグレーション処理
    const currentVersion = this.config.version;
    
    if (currentVersion !== '1.0.0') {
      console.log('Migrating config from version', currentVersion, 'to 1.0.0');
      
      // マイグレーション処理をここに追加
      // 例: 新しい通貨の追加、削除された設定の処理など
      
      this.config.version = '1.0.0';
      await this.save();
    }
  }

  private async createBackup(): Promise<void> {
    try {
      const backupDir = this.config.security.backupLocation;
      
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `otedama-config-${timestamp}.json`);
      
      fs.copyFileSync(this.configPath, backupPath);

      // 古いバックアップを削除（10個まで保持）
      const backups = fs.readdirSync(backupDir)
        .filter(file => file.startsWith('otedama-config-'))
        .sort()
        .reverse();

      if (backups.length > 10) {
        for (const backup of backups.slice(10)) {
          fs.unlinkSync(path.join(backupDir, backup));
        }
      }

    } catch (error) {
      console.warn('Failed to create backup:', error);
    }
  }

  private encrypt(data: string): string {
    if (!this.encryptionKey) {
      throw new Error('No encryption key available');
    }

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipher('aes-256-cbc', this.encryptionKey);
    
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return iv.toString('hex') + ':' + encrypted;
  }

  private decrypt(encryptedData: string): string {
    if (!this.encryptionKey) {
      throw new Error('No encryption key available');
    }

    const [ivHex, encrypted] = encryptedData.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    
    const decipher = crypto.createDecipher('aes-256-cbc', this.encryptionKey);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  setEncryptionKey(password: string): void {
    this.encryptionKey = crypto.scryptSync(password, 'otedama-salt', 32);
  }

  enableEncryption(password: string): void {
    this.setEncryptionKey(password);
    this.isEncrypted = true;
    this.config.security.encryptConfig = true;
  }

  disableEncryption(): void {
    this.encryptionKey = undefined;
    this.isEncrypted = false;
    this.config.security.encryptConfig = false;
  }

  // 通貨設定管理
  getCurrencyConfig(symbol: string): CurrencyConfig | undefined {
    return this.config.currencies.get(symbol.toUpperCase());
  }

  setCurrencyConfig(symbol: string, config: CurrencyConfig): void {
    this.config.currencies.set(symbol.toUpperCase(), config);
  }

  getEnabledCurrencies(): CurrencyConfig[] {
    return Array.from(this.config.currencies.values()).filter(c => c.enabled);
  }

  // デバイス設定管理
  getDeviceConfig(deviceId: string): DeviceConfig | undefined {
    return this.config.devices.get(deviceId);
  }

  setDeviceConfig(deviceId: string, config: DeviceConfig): void {
    this.config.devices.set(deviceId, config);
  }

  getEnabledDevices(): DeviceConfig[] {
    return Array.from(this.config.devices.values()).filter(d => d.enabled);
  }

  // 設定セクション取得・更新
  getMiningSettings(): MiningSettings {
    return { ...this.config.mining };
  }

  setMiningSettings(settings: Partial<MiningSettings>): void {
    this.config.mining = { ...this.config.mining, ...settings };
  }

  getSecuritySettings(): SecuritySettings {
    return { ...this.config.security };
  }

  setSecuritySettings(settings: Partial<SecuritySettings>): void {
    this.config.security = { ...this.config.security, ...settings };
  }

  getUISettings(): UISettings {
    return { ...this.config.ui };
  }

  setUISettings(settings: Partial<UISettings>): void {
    this.config.ui = { ...this.config.ui, ...settings };
  }

  // 全設定取得
  getAll(): AppConfig {
    return JSON.parse(JSON.stringify({
      ...this.config,
      currencies: Array.from(this.config.currencies.entries()),
      devices: Array.from(this.config.devices.entries())
    }));
  }

  // 設定のリセット
  reset(): void {
    this.config = this.createDefaultConfig();
  }

  // 設定のエクスポート
  async exportConfig(filePath: string, includeAddresses: boolean = false): Promise<void> {
    try {
      const exportData = { ...this.config };
      
      if (!includeAddresses) {
        // アドレス情報を除外
        for (const [symbol, currencyConfig] of exportData.currencies) {
          currencyConfig.payoutAddress = '';
        }
      }

      const serialized = this.serializeConfig(exportData);
      fs.writeFileSync(filePath, JSON.stringify(serialized, null, 2));

    } catch (error) {
      console.error('Failed to export config:', error);
      throw error;
    }
  }

  // 設定のインポート
  async importConfig(filePath: string): Promise<void> {
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(data);
      const imported = this.deserializeConfig(parsed);

      // 現在の設定とマージ
      this.config = {
        ...this.config,
        ...imported,
        lastModified: Date.now()
      };

      await this.save();

    } catch (error) {
      console.error('Failed to import config:', error);
      throw error;
    }
  }

  // 設定の検証
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // 通貨設定の検証
    for (const [symbol, currency] of this.config.currencies) {
      if (currency.enabled && !currency.payoutAddress) {
        errors.push(`Payout address required for ${symbol}`);
      }

      if (currency.minPayout <= 0) {
        errors.push(`Invalid minimum payout for ${symbol}`);
      }
    }

    // マイニング設定の検証
    if (this.config.mining.temperatureTarget < 40 || this.config.mining.temperatureTarget > 95) {
      errors.push('Temperature target must be between 40-95°C');
    }

    if (this.config.mining.powerCostPerKwh < 0) {
      errors.push('Power cost cannot be negative');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  // 自動保存の設定
  enableAutoSave(intervalMs: number = 30000): void {
    setInterval(async () => {
      try {
        await this.save();
      } catch (error) {
        console.warn('Auto-save failed:', error);
      }
    }, intervalMs);
  }

  // 最適な通貨の推奨
  getRecommendedCurrency(): CurrencyConfig | null {
    const enabled = this.getEnabledCurrencies();
    if (enabled.length === 0) return null;

    // 収益性に基づいて推奨
    return enabled.reduce((best, current) => {
      const bestProfitability = best.customSettings?.profitability || 0;
      const currentProfitability = current.customSettings?.profitability || 0;
      return currentProfitability > bestProfitability ? current : best;
    });
  }

  // 設定の健全性チェック
  healthCheck(): { healthy: boolean; warnings: string[] } {
    const warnings: string[] = [];

    // アドレス設定チェック
    const enabledWithoutAddress = this.getEnabledCurrencies()
      .filter(c => !c.payoutAddress);
    
    if (enabledWithoutAddress.length > 0) {
      warnings.push(`${enabledWithoutAddress.length} enabled currencies missing payout addresses`);
    }

    // バックアップチェック
    if (!this.config.security.backupEnabled) {
      warnings.push('Configuration backup is disabled');
    }

    // 電力コストチェック
    if (this.config.mining.powerCostPerKwh > 0.30) {
      warnings.push('High power cost may affect profitability');
    }

    return {
      healthy: warnings.length === 0,
      warnings
    };
  }
}
