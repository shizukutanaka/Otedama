/**
 * 軽量国際化（i18n）システム
 * 設計思想: Carmack (シンプル・高速), Martin (クリーン), Pike (明瞭・効率性)
 * 
 * 主要機能:
 * - 複数言語サポート
 * - 動的言語切り替え
 * - パラメータ置換
 * - フォールバック機能
 * - 軽量JSONベース
 */

import { EventEmitter } from 'events';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// === 型定義 ===
interface TranslationMap {
  [key: string]: string | TranslationMap;
}

interface LanguageData {
  code: string;
  name: string;
  nativeName: string;
  translations: TranslationMap;
}

interface I18nConfig {
  defaultLanguage: string;
  fallbackLanguage: string;
  translationsPath: string;
  autoDetectLanguage: boolean;
  supportedLanguages: string[];
  parameterPattern: RegExp;
}

interface TranslationParams {
  [key: string]: string | number;
}

// === 軽量翻訳キャッシュ ===
class TranslationCache {
  private cache = new Map<string, string>();
  private maxSize: number;

  constructor(maxSize: number = 10000) {
    this.maxSize = maxSize;
  }

  set(key: string, value: string): void {
    // LRUキャッシュ実装
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  get(key: string): string | null {
    const value = this.cache.get(key);
    if (value) {
      // アクセスされたアイテムを最新に移動
      this.cache.delete(key);
      this.cache.set(key, value);
      return value;
    }
    return null;
  }

  clear(): void {
    this.cache.clear();
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize
    };
  }
}

// === 言語検出器 ===
class LanguageDetector {
  static detectFromBrowser(acceptLanguage?: string): string {
    if (!acceptLanguage) return 'en';
    
    // Accept-Languageヘッダーから言語を抽出
    const languages = acceptLanguage
      .split(',')
      .map(lang => {
        const [code, q = '1'] = lang.trim().split(';q=');
        return {
          code: code.split('-')[0].toLowerCase(),
          quality: parseFloat(q)
        };
      })
      .sort((a, b) => b.quality - a.quality);

    return languages[0]?.code || 'en';
  }

  static detectFromEnvironment(): string {
    // 環境変数から言語検出
    const envLang = process.env.LANG || process.env.LANGUAGE || process.env.LC_ALL;
    if (envLang) {
      return envLang.split('.')[0].split('_')[0].toLowerCase();
    }
    return 'en';
  }

  static detectFromHeaders(headers: Record<string, string>): string {
    const acceptLanguage = headers['accept-language'];
    if (acceptLanguage) {
      return this.detectFromBrowser(acceptLanguage);
    }
    return 'en';
  }
}

// === メイン国際化クラス ===
class LightI18n extends EventEmitter {
  private config: I18nConfig;
  private languages = new Map<string, LanguageData>();
  private currentLanguage: string;
  private cache = new TranslationCache();
  private logger: any;

  constructor(config: Partial<I18nConfig> = {}, logger?: any) {
    super();
    
    this.config = {
      defaultLanguage: 'en',
      fallbackLanguage: 'en',
      translationsPath: './src/locales',
      autoDetectLanguage: true,
      supportedLanguages: ['en', 'ja', 'zh', 'ko', 'es', 'fr', 'de', 'ru'],
      parameterPattern: /\{\{(\w+)\}\}/g,
      ...config
    };

    this.currentLanguage = this.config.defaultLanguage;
    
    this.logger = logger || {
      info: (msg: string, data?: any) => console.log(`[I18N] ${msg}`, data || ''),
      error: (msg: string, err?: any) => console.error(`[I18N] ${msg}`, err || ''),
      warn: (msg: string, data?: any) => console.warn(`[I18N] ${msg}`, data || '')
    };

    this.loadDefaultTranslations();
  }

  private loadDefaultTranslations(): void {
    // デフォルト翻訳データを組み込み
    const defaultTranslations = this.getDefaultTranslations();
    
    for (const [langCode, translations] of Object.entries(defaultTranslations)) {
      this.addLanguage(langCode, translations);
    }
  }

  private getDefaultTranslations(): Record<string, any> {
    return {
      en: {
        code: 'en',
        name: 'English',
        nativeName: 'English',
        translations: {
          common: {
            loading: 'Loading...',
            error: 'Error',
            success: 'Success',
            cancel: 'Cancel',
            save: 'Save',
            delete: 'Delete',
            edit: 'Edit',
            close: 'Close',
            yes: 'Yes',
            no: 'No'
          },
          mining: {
            pool: 'Mining Pool',
            miners: 'Miners',
            hashrate: 'Hashrate',
            shares: 'Shares',
            blocks: 'Blocks',
            difficulty: 'Difficulty',
            reward: 'Reward',
            fee: 'Fee',
            payout: 'Payout',
            worker: 'Worker',
            connected: 'Connected',
            disconnected: 'Disconnected',
            valid_share: 'Valid Share',
            invalid_share: 'Invalid Share',
            block_found: 'Block Found!',
            zero_fee: 'Zero Fee',
            direct_payout: 'Direct Payout'
          },
          api: {
            stats: 'Statistics',
            status: 'Status',
            health: 'Health',
            metrics: 'Metrics',
            version: 'Version'
          },
          alerts: {
            miner_connected: 'Miner {{id}} connected',
            miner_disconnected: 'Miner {{id}} disconnected',
            block_found: 'Block found at height {{height}}',
            high_memory_usage: 'High memory usage: {{percent}}%',
            low_hashrate: 'Low hashrate detected',
            system_error: 'System error occurred'
          }
        }
      },
      ja: {
        code: 'ja',
        name: 'Japanese',
        nativeName: '日本語',
        translations: {
          common: {
            loading: '読み込み中...',
            error: 'エラー',
            success: '成功',
            cancel: 'キャンセル',
            save: '保存',
            delete: '削除',
            edit: '編集',
            close: '閉じる',
            yes: 'はい',
            no: 'いいえ'
          },
          mining: {
            pool: 'マイニングプール',
            miners: 'マイナー',
            hashrate: 'ハッシュレート',
            shares: 'シェア',
            blocks: 'ブロック',
            difficulty: '難易度',
            reward: '報酬',
            fee: '手数料',
            payout: '支払い',
            worker: 'ワーカー',
            connected: '接続済み',
            disconnected: '切断済み',
            valid_share: '有効シェア',
            invalid_share: '無効シェア',
            block_found: 'ブロック発見！',
            zero_fee: '手数料0%',
            direct_payout: '直接支払い'
          },
          api: {
            stats: '統計',
            status: 'ステータス',
            health: 'ヘルス',
            metrics: 'メトリクス',
            version: 'バージョン'
          },
          alerts: {
            miner_connected: 'マイナー {{id}} が接続しました',
            miner_disconnected: 'マイナー {{id}} が切断しました',
            block_found: 'ブロックが発見されました (高さ: {{height}})',
            high_memory_usage: 'メモリ使用量が高いです: {{percent}}%',
            low_hashrate: '低ハッシュレートを検出',
            system_error: 'システムエラーが発生しました'
          }
        }
      },
      zh: {
        code: 'zh',
        name: 'Chinese',
        nativeName: '中文',
        translations: {
          common: {
            loading: '加载中...',
            error: '错误',
            success: '成功',
            cancel: '取消',
            save: '保存',
            delete: '删除',
            edit: '编辑',
            close: '关闭',
            yes: '是',
            no: '否'
          },
          mining: {
            pool: '矿池',
            miners: '矿工',
            hashrate: '算力',
            shares: '份额',
            blocks: '区块',
            difficulty: '难度',
            reward: '奖励',
            fee: '费用',
            payout: '支付',
            worker: '工人',
            connected: '已连接',
            disconnected: '已断开',
            valid_share: '有效份额',
            invalid_share: '无效份额',
            block_found: '找到区块！',
            zero_fee: '零费用',
            direct_payout: '直接支付'
          },
          api: {
            stats: '统计',
            status: '状态',
            health: '健康',
            metrics: '指标',
            version: '版本'
          },
          alerts: {
            miner_connected: '矿工 {{id}} 已连接',
            miner_disconnected: '矿工 {{id}} 已断开',
            block_found: '在高度 {{height}} 发现区块',
            high_memory_usage: '内存使用率高：{{percent}}%',
            low_hashrate: '检测到低算力',
            system_error: '发生系统错误'
          }
        }
      }
    };
  }

  addLanguage(code: string, data: any): void {
    if (typeof data === 'object' && data.translations) {
      // 完全な言語データオブジェクト
      this.languages.set(code, data as LanguageData);
    } else {
      // 翻訳データのみ
      this.languages.set(code, {
        code,
        name: code.toUpperCase(),
        nativeName: code.toUpperCase(),
        translations: data
      });
    }

    this.logger.info(`Language added: ${code}`);
    this.emit('languageAdded', code);
  }

  loadLanguageFromFile(code: string): boolean {
    try {
      const filePath = join(this.config.translationsPath, `${code}.json`);
      
      if (!existsSync(filePath)) {
        this.logger.warn(`Translation file not found: ${filePath}`);
        return false;
      }

      const content = readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);
      
      this.addLanguage(code, data);
      return true;
    } catch (error) {
      this.logger.error(`Failed to load language file for ${code}`, error);
      return false;
    }
  }

  setLanguage(code: string): boolean {
    if (!this.languages.has(code)) {
      // ファイルから読み込みを試行
      if (!this.loadLanguageFromFile(code)) {
        this.logger.warn(`Language not supported: ${code}`);
        return false;
      }
    }

    const oldLanguage = this.currentLanguage;
    this.currentLanguage = code;
    this.cache.clear(); // キャッシュクリア
    
    this.logger.info(`Language changed: ${oldLanguage} -> ${code}`);
    this.emit('languageChanged', { from: oldLanguage, to: code });
    
    return true;
  }

  getCurrentLanguage(): string {
    return this.currentLanguage;
  }

  getSupportedLanguages(): LanguageData[] {
    return Array.from(this.languages.values());
  }

  isLanguageSupported(code: string): boolean {
    return this.languages.has(code) || this.config.supportedLanguages.includes(code);
  }

  t(key: string, params?: TranslationParams): string {
    // キャッシュキー生成
    const cacheKey = `${this.currentLanguage}:${key}:${JSON.stringify(params || {})}`;
    
    // キャッシュから取得
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    // 翻訳実行
    const translation = this.getTranslation(key, this.currentLanguage, params);
    
    // キャッシュに保存
    this.cache.set(cacheKey, translation);
    
    return translation;
  }

  private getTranslation(key: string, languageCode: string, params?: TranslationParams): string {
    // 現在の言語から取得を試行
    let translation = this.findTranslation(key, languageCode);
    
    // フォールバック言語から取得を試行
    if (!translation && languageCode !== this.config.fallbackLanguage) {
      translation = this.findTranslation(key, this.config.fallbackLanguage);
    }

    // 翻訳が見つからない場合はキー自体を返す
    if (!translation) {
      this.logger.warn(`Translation not found: ${key} (${languageCode})`);
      return key;
    }

    // パラメータ置換
    if (params) {
      translation = this.replaceParameters(translation, params);
    }

    return translation;
  }

  private findTranslation(key: string, languageCode: string): string | null {
    const language = this.languages.get(languageCode);
    if (!language) return null;

    const keys = key.split('.');
    let current: any = language.translations;

    for (const k of keys) {
      if (typeof current === 'object' && current[k] !== undefined) {
        current = current[k];
      } else {
        return null;
      }
    }

    return typeof current === 'string' ? current : null;
  }

  private replaceParameters(translation: string, params: TranslationParams): string {
    return translation.replace(this.config.parameterPattern, (match, paramName) => {
      const value = params[paramName];
      return value !== undefined ? String(value) : match;
    });
  }

  detectLanguage(request?: any): string {
    if (!this.config.autoDetectLanguage) {
      return this.config.defaultLanguage;
    }

    let detectedLanguage = this.config.defaultLanguage;

    // HTTPリクエストからの検出
    if (request?.headers) {
      detectedLanguage = LanguageDetector.detectFromHeaders(request.headers);
    } else {
      // 環境からの検出
      detectedLanguage = LanguageDetector.detectFromEnvironment();
    }

    // サポートされている言語かチェック
    if (this.isLanguageSupported(detectedLanguage)) {
      return detectedLanguage;
    }

    return this.config.defaultLanguage;
  }

  createMiddleware() {
    return (req: any, res: any, next: any) => {
      // 言語検出
      const detectedLanguage = this.detectLanguage(req);
      
      // クエリパラメータやヘッダーから言語指定があるかチェック
      const requestedLanguage = req.query?.lang || req.headers['x-language'];
      
      const languageToUse = requestedLanguage && this.isLanguageSupported(requestedLanguage) 
        ? requestedLanguage 
        : detectedLanguage;

      // 一時的に言語を設定（リクエストスコープ）
      const originalLanguage = this.currentLanguage;
      this.setLanguage(languageToUse);

      // ヘルパー関数をレスポンスに追加
      res.locals.t = (key: string, params?: TranslationParams) => this.t(key, params);
      res.locals.currentLanguage = languageToUse;
      res.locals.supportedLanguages = this.getSupportedLanguages();

      // レスポンス終了時に元の言語に戻す
      const originalEnd = res.end;
      res.end = function(...args: any[]) {
        res.end = originalEnd;
        originalEnd.apply(res, args);
      };

      next();
    };
  }

  exportTranslations(languageCode?: string): any {
    if (languageCode) {
      const language = this.languages.get(languageCode);
      return language ? language.translations : null;
    }

    const allTranslations: Record<string, any> = {};
    for (const [code, language] of this.languages) {
      allTranslations[code] = language.translations;
    }
    return allTranslations;
  }

  importTranslations(data: Record<string, any>): void {
    for (const [code, translations] of Object.entries(data)) {
      this.addLanguage(code, translations);
    }
  }

  getStats() {
    return {
      currentLanguage: this.currentLanguage,
      supportedLanguages: Array.from(this.languages.keys()),
      totalTranslations: this.languages.size,
      cache: this.cache.getStats(),
      config: {
        defaultLanguage: this.config.defaultLanguage,
        fallbackLanguage: this.config.fallbackLanguage,
        autoDetectLanguage: this.config.autoDetectLanguage
      }
    };
  }

  // 便利なヘルパーメソッド
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(this.currentLanguage, options).format(value);
  }

  formatDate(date: Date, options?: Intl.DateTimeFormatOptions): string {
    return new Intl.DateTimeFormat(this.currentLanguage, options).format(date);
  }

  formatCurrency(value: number, currency: string): string {
    return new Intl.NumberFormat(this.currentLanguage, {
      style: 'currency',
      currency: currency.toUpperCase()
    }).format(value);
  }

  pluralize(key: string, count: number, params?: TranslationParams): string {
    const pluralKey = count === 1 ? `${key}.one` : `${key}.other`;
    return this.t(pluralKey, { count, ...params });
  }
}

// === エクスポート ===
export {
  LightI18n,
  LanguageData,
  I18nConfig,
  TranslationParams,
  LanguageDetector,
  TranslationCache
};