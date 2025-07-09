/**
 * Otedama 多言語対応システム (i18n)
 * 50言語対応・動的言語切り替え・リアルタイム反映
 * 
 * 設計思想: Rob Pike (シンプル・効率的), John Carmack (高速), Robert C. Martin (保守性)
 */

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { languageData } from './language-data';

// === 型定義 ===
export interface Translation {
  [key: string]: string | Translation;
}

export interface Language {
  code: string;
  name: string;
  nativeName: string;
  region: string;
  rtl: boolean;
  pluralRules: string[];
  dateFormat: string;
  numberFormat: {
    decimal: string;
    thousands: string;
    currency: string;
  };
}

export interface I18nConfig {
  defaultLanguage: string;
  fallbackLanguage: string;
  supportedLanguages: string[];
  autoDetect: boolean;
  cacheTranslations: boolean;
  interpolationPattern: RegExp;
}

// === 多言語システム実装 ===
export class I18nSystem extends EventEmitter {
  private static instance: I18nSystem;
  private translations: Map<string, Translation> = new Map();
  private currentLanguage: string = 'en';
  private config: I18nConfig;
  private languages: Map<string, Language> = new Map();
  private cache: Map<string, string> = new Map();

  private constructor(config?: Partial<I18nConfig>) {
    super();
    this.config = {
      defaultLanguage: 'en',
      fallbackLanguage: 'en',
      supportedLanguages: [], // 動的に設定
      autoDetect: true,
      cacheTranslations: true,
      interpolationPattern: /\{\{([^}]+)\}\}/g,
      ...config
    };

    this.initializeLanguages();
  }

  static getInstance(config?: Partial<I18nConfig>): I18nSystem {
    if (!this.instance) {
      this.instance = new I18nSystem(config);
    }
    return this.instance;
  }

  private initializeLanguages(): void {
    for (const [code, language] of languageData) {
      this.languages.set(code, language);
    }
  }

  async initialize(): Promise<void> {
    await this.detectAndLoadLanguages();

    // 言語を自動検出
    if (this.config.autoDetect) {
      this.currentLanguage = this.detectSystemLanguage();
    } else {
      this.currentLanguage = this.config.defaultLanguage;
    }
    
    this.emit('initialized', { language: this.currentLanguage });
  }

  private async detectAndLoadLanguages(): Promise<void> {
    const localesPath = path.join(__dirname, '../locales');
    try {
      const files = await fs.readdir(localesPath);
      const supportedLanguages = files
        .filter(file => file.endsWith('.json'))
        .map(file => file.replace('.json', ''));
      
      this.config.supportedLanguages = supportedLanguages;
      await this.loadTranslations();

    } catch (error) {
      console.error('Failed to detect languages from locales directory:', error);
      // フォールバックとしてデフォルト言語のみ設定
      this.config.supportedLanguages = [this.config.defaultLanguage];
      await this.loadTranslations();
    }
  }

  private detectSystemLanguage(): string {
    const envLang = process.env['LANG'] || process.env['LANGUAGE'] || process.env['LC_ALL'];
    if (envLang) {
      const langCode = envLang.split('.')[0];
      if (langCode) {
        const lang = langCode.replace('_', '-');
        if (this.config.supportedLanguages.includes(lang)) {
          return lang;
        }
        const langOnly = lang.split('-')[0];
        if (langOnly && this.config.supportedLanguages.includes(langOnly)) {
          return langOnly;
        }
      }
    }
    return this.config.defaultLanguage;
  }

  private async loadTranslations(): Promise<void> {
    for (const lang of this.config.supportedLanguages) {
      try {
        const translationPath = path.join(__dirname, '../locales', `${lang}.json`);
        const content = await fs.readFile(translationPath, 'utf-8');
        const translations = JSON.parse(content);
        this.translations.set(lang, translations);
      } catch (error) {
        console.warn(`Failed to load translations for ${lang}:`, error);
        // フォールバック翻訳を作成
        if (lang === this.config.fallbackLanguage) {
          this.translations.set(lang, this.createFallbackTranslations());
        }
      }
    }
  }

  private createFallbackTranslations(): Translation {
    return {
      common: {
        loading: 'Loading...',
        error: 'Error',
        success: 'Success',
        cancel: 'Cancel',
        confirm: 'Confirm',
        save: 'Save',
        delete: 'Delete',
        edit: 'Edit',
        close: 'Close',
        back: 'Back',
        next: 'Next',
        previous: 'Previous',
        home: 'Home',
        settings: 'Settings',
        help: 'Help',
        about: 'About'
      },
      mining: {
        title: 'Otedama - Zero Fee Mining Pool',
        subtitle: 'The World\'s First True Zero-Fee Mining Pool',
        stats: {
          dailyRevenue: 'Daily Revenue',
          activeMiners: 'Active Miners',
          totalHashrate: 'Total Hashrate',
          efficiency: 'Efficiency',
          poolFee: 'Pool Fee',
          uptime: 'Uptime'
        },
        algorithms: {
          randomx: 'RandomX (CPU)',
          kawpow: 'KawPow (GPU)',
          sha256d: 'SHA256d (ASIC)',
          ethash: 'Ethash (GPU)'
        },
        coins: {
          XMR: 'Monero',
          RVN: 'Ravencoin',
          BTC: 'Bitcoin',
          ETC: 'Ethereum Classic'
        }
      }
    };
  }

  // 翻訳取得メソッド
  t(key: string, params?: Record<string, any>, language?: string): string {
    const lang = language || this.currentLanguage;
    const cacheKey = `${lang}:${key}:${JSON.stringify(params)}`;
    
    // キャッシュチェック
    if (this.config.cacheTranslations && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    let translation = this.getTranslation(key, lang);
    
    // フォールバック処理
    if (!translation && lang !== this.config.fallbackLanguage) {
      translation = this.getTranslation(key, this.config.fallbackLanguage);
    }
    
    // 最終フォールバック
    if (!translation) {
      translation = key;
    }

    // パラメータ補間
    if (params) {
      translation = this.interpolate(translation, params);
    }

    // キャッシュ保存
    if (this.config.cacheTranslations) {
      this.cache.set(cacheKey, translation);
    }

    return translation;
  }

  private getTranslation(key: string, language: string): string {
    const translations = this.translations.get(language);
    if (!translations) return '';

    const keys = key.split('.');
    let current: Translation | string = translations;

    for (const k of keys) {
        if (typeof current === 'object' && current !== null && k in current) {
            const next: string | Translation | undefined = current[k];
            if (typeof next === 'string') {
                current = next;
            } else if (typeof next === 'object' && next !== null) {
                current = next as Translation;
            } else {
                return ''; // Not a string or a valid translation object
            }
        } else {
            return '';
        }
    }

    return typeof current === 'string' ? current : '';
  }

  private interpolate(template: string, params: Record<string, any>): string {
    return template.replace(this.config.interpolationPattern, (match, key) => {
      const value = params[key.trim()];
      return value !== undefined ? String(value) : match;
    });
  }

  // 複数形対応
  plural(key: string, count: number, params?: Record<string, any>, language?: string): string {
    const lang = language || this.currentLanguage;
    const languageInfo = this.languages.get(lang);
    
    if (!languageInfo) {
      return this.t(key, { ...params, count }, language);
    }

    const pluralRule = this.getPluralRule(count, languageInfo.pluralRules);
    const pluralKey = `${key}.${pluralRule}`;
    
    return this.t(pluralKey, { ...params, count }, language);
  }

  private getPluralRule(count: number, rules: string[]): string {
    // 簡易複数形ルール（実際の実装ではより詳細なルールが必要）
    if (rules.includes('zero') && count === 0) return 'zero';
    if (rules.includes('one') && count === 1) return 'one';
    if (rules.includes('two') && count === 2) return 'two';
    if (rules.includes('few') && count >= 3 && count <= 6) return 'few';
    if (rules.includes('many') && count >= 7) return 'many';
    return 'other';
  }

  // 言語変更
  async setLanguage(language: string): Promise<void> {
    if (!this.config.supportedLanguages.includes(language)) {
      throw new Error(`Unsupported language: ${language}`);
    }

    const oldLanguage = this.currentLanguage;
    this.currentLanguage = language;
    
    // 翻訳が未ロードの場合はロード
    if (!this.translations.has(language)) {
      await this.loadTranslations();
    }

    // キャッシュクリア
    this.cache.clear();

    this.emit('languageChanged', { 
      oldLanguage, 
      newLanguage: language,
      languageInfo: this.languages.get(language)
    });
  }

  // 数値フォーマット
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    const lang = this.currentLanguage;
    const languageInfo = this.languages.get(lang);
    
    if (!languageInfo) {
      return value.toString();
    }

    try {
      return new Intl.NumberFormat(lang, options).format(value);
    } catch {
      return value.toString();
    }
  }

  // 通貨フォーマット
  formatCurrency(value: number, currency?: string): string {
    const lang = this.currentLanguage;
    const languageInfo = this.languages.get(lang);
    
    if (!languageInfo) {
      return `$${value.toFixed(2)}`;
    }

    try {
      return new Intl.NumberFormat(lang, {
        style: 'currency',
        currency: currency || 'USD'
      }).format(value);
    } catch {
      return `${languageInfo.numberFormat.currency}${value.toFixed(2)}`;
    }
  }

  // 日付フォーマット
  formatDate(date: Date, options?: Intl.DateTimeFormatOptions): string {
    const lang = this.currentLanguage;
    
    try {
      return new Intl.DateTimeFormat(lang, options).format(date);
    } catch {
      return date.toLocaleDateString();
    }
  }

  // ゲッター
  getCurrentLanguage(): string {
    return this.currentLanguage;
  }

  getSupportedLanguages(): Language[] {
    return Array.from(this.languages.values())
      .filter(lang => this.config.supportedLanguages.includes(lang.code));
  }

  isRTL(): boolean {
    const languageInfo = this.languages.get(this.currentLanguage);
    return languageInfo?.rtl || false;
  }

  // 翻訳の動的追加
  addTranslation(language: string, key: string, value: string): void {
    if (!this.translations.has(language)) {
      this.translations.set(language, {});
    }

    const translations = this.translations.get(language)!;
    const keys = key.split('.');
    let current: any = translations;

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (k) { // Ensure k is not an empty string or undefined
        if (!(k in current) || typeof current[k] !== 'object' || current[k] === null) {
          current[k] = {};
        }
        current = current[k];
      }
    }

    const lastKey = keys[keys.length - 1];
    if (lastKey) { // Ensure lastKey is not an empty string or undefined
      current[lastKey] = value;
    }
    
    // キャッシュクリア
    this.cache.clear();
  }

  // バッチ翻訳追加
  addTranslations(language: string, translations: Translation): void {
    if (!this.translations.has(language)) {
      this.translations.set(language, {});
    }

    const existing = this.translations.get(language)!;
    this.translations.set(language, this.deepMerge(existing, translations));
    
    // キャッシュクリア
    this.cache.clear();
  }

  private deepMerge(target: any, source: any): any {
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key] || typeof target[key] !== 'object') {
          target[key] = {};
        }
        this.deepMerge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
    return target;
  }

  // 統計
  getStats() {
    return {
      currentLanguage: this.currentLanguage,
      supportedLanguages: this.config.supportedLanguages.length,
      loadedTranslations: this.translations.size,
      cacheSize: this.cache.size,
      isRTL: this.isRTL()
    };
  }
}

// === 便利関数 ===
let i18nInstance: I18nSystem;

export function initI18n(config?: Partial<I18nConfig>): I18nSystem {
  i18nInstance = I18nSystem.getInstance(config);
  return i18nInstance;
}

export function t(key: string, params?: Record<string, any>, language?: string): string {
  if (!i18nInstance) {
    i18nInstance = I18nSystem.getInstance();
  }
  return i18nInstance.t(key, params, language);
}

export function plural(key: string, count: number, params?: Record<string, any>, language?: string): string {
  if (!i18nInstance) {
    i18nInstance = I18nSystem.getInstance();
  }
  return i18nInstance.plural(key, count, params, language);
}

export function formatCurrency(value: number, currency?: string): string {
  if (!i18nInstance) {
    i18nInstance = I18nSystem.getInstance();
  }
  return i18nInstance.formatCurrency(value, currency);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  if (!i18nInstance) {
    i18nInstance = I18nSystem.getInstance();
  }
  return i18nInstance.formatNumber(value, options);
}

export function formatDate(date: Date, options?: Intl.DateTimeFormatOptions): string {
  if (!i18nInstance) {
    i18nInstance = I18nSystem.getInstance();
  }
  return i18nInstance.formatDate(date, options);
}
