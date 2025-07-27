/**
 * Multi-Language Support System - Otedama
 * Comprehensive internationalization with dynamic language switching
 * 
 * Design principles:
 * - Carmack: Fast translation lookup
 * - Martin: Clean i18n architecture
 * - Pike: Simple translation management
 */

import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createStructuredLogger } from '../core/structured-logger.js';
import acceptLanguageParser from 'accept-language-parser';

const logger = createStructuredLogger('MultiLanguageSupport');
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Supported languages
 */
export const SupportedLanguages = {
  EN: 'en',
  JA: 'ja',
  ZH_CN: 'zh-CN',
  ZH_TW: 'zh-TW',
  KO: 'ko',
  ES: 'es',
  FR: 'fr',
  DE: 'de',
  RU: 'ru',
  PT: 'pt'
};

/**
 * Language information
 */
export const LanguageInfo = {
  [SupportedLanguages.EN]: { name: 'English', nativeName: 'English', rtl: false },
  [SupportedLanguages.JA]: { name: 'Japanese', nativeName: '日本語', rtl: false },
  [SupportedLanguages.ZH_CN]: { name: 'Chinese (Simplified)', nativeName: '简体中文', rtl: false },
  [SupportedLanguages.ZH_TW]: { name: 'Chinese (Traditional)', nativeName: '繁體中文', rtl: false },
  [SupportedLanguages.KO]: { name: 'Korean', nativeName: '한국어', rtl: false },
  [SupportedLanguages.ES]: { name: 'Spanish', nativeName: 'Español', rtl: false },
  [SupportedLanguages.FR]: { name: 'French', nativeName: 'Français', rtl: false },
  [SupportedLanguages.DE]: { name: 'German', nativeName: 'Deutsch', rtl: false },
  [SupportedLanguages.RU]: { name: 'Russian', nativeName: 'Русский', rtl: false },
  [SupportedLanguages.PT]: { name: 'Portuguese', nativeName: 'Português', rtl: false }
};

/**
 * Translation categories
 */
export const TranslationCategory = {
  UI: 'ui',
  ERRORS: 'errors',
  MINING: 'mining',
  POOL: 'pool',
  WALLET: 'wallet',
  SETTINGS: 'settings',
  HELP: 'help'
};

/**
 * Multi-Language Support System
 */
export class MultiLanguageSupport extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      defaultLanguage: config.defaultLanguage || SupportedLanguages.EN,
      fallbackLanguage: config.fallbackLanguage || SupportedLanguages.EN,
      translationsPath: config.translationsPath || join(__dirname, '../../translations'),
      autoDetect: config.autoDetect !== false,
      cache: config.cache !== false,
      pluralRules: config.pluralRules || {},
      dateFormats: config.dateFormats || {},
      numberFormats: config.numberFormats || {},
      ...config
    };
    
    this.translations = new Map();
    this.currentLanguage = this.config.defaultLanguage;
    this.loadedLanguages = new Set();
    this.translationCache = new Map();
    
    this.initialize();
  }
  
  /**
   * Initialize language support
   */
  async initialize() {
    try {
      // Create translations directory
      await fs.mkdir(this.config.translationsPath, { recursive: true });
      
      // Load default language
      await this.loadLanguage(this.config.defaultLanguage);
      
      // Load fallback language if different
      if (this.config.fallbackLanguage !== this.config.defaultLanguage) {
        await this.loadLanguage(this.config.fallbackLanguage);
      }
      
      // Initialize plural rules
      this.initializePluralRules();
      
      // Initialize formatters
      this.initializeFormatters();
      
      logger.info('Multi-language support initialized', {
        defaultLanguage: this.config.defaultLanguage,
        loadedLanguages: Array.from(this.loadedLanguages)
      });
      
      this.emit('initialized');
      
    } catch (error) {
      logger.error('Failed to initialize language support', { error });
      throw error;
    }
  }
  
  /**
   * Load language translations
   */
  async loadLanguage(language) {
    if (this.loadedLanguages.has(language)) {
      return;
    }
    
    try {
      const translations = {};
      
      // Load translation files for each category
      for (const category of Object.values(TranslationCategory)) {
        const filePath = join(this.config.translationsPath, language, `${category}.json`);
        
        try {
          const data = await fs.readFile(filePath, 'utf8');
          translations[category] = JSON.parse(data);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            logger.warn('Failed to load translation file', {
              language,
              category,
              error
            });
          }
        }
      }
      
      // Load common translations
      const commonPath = join(this.config.translationsPath, language, 'common.json');
      try {
        const data = await fs.readFile(commonPath, 'utf8');
        translations.common = JSON.parse(data);
      } catch (error) {
        // Common translations are optional
      }
      
      this.translations.set(language, translations);
      this.loadedLanguages.add(language);
      
      logger.info('Language loaded', { language });
      
    } catch (error) {
      logger.error('Failed to load language', { language, error });
      throw error;
    }
  }
  
  /**
   * Initialize plural rules
   */
  initializePluralRules() {
    // Default plural rules for common languages
    const defaultRules = {
      [SupportedLanguages.EN]: (n) => n === 1 ? 'one' : 'other',
      [SupportedLanguages.JA]: () => 'other',
      [SupportedLanguages.ZH_CN]: () => 'other',
      [SupportedLanguages.ZH_TW]: () => 'other',
      [SupportedLanguages.KO]: () => 'other',
      [SupportedLanguages.ES]: (n) => n === 1 ? 'one' : 'other',
      [SupportedLanguages.FR]: (n) => n === 0 || n === 1 ? 'one' : 'other',
      [SupportedLanguages.DE]: (n) => n === 1 ? 'one' : 'other',
      [SupportedLanguages.RU]: (n) => {
        if (n % 10 === 1 && n % 100 !== 11) return 'one';
        if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'few';
        return 'many';
      },
      [SupportedLanguages.PT]: (n) => n === 1 ? 'one' : 'other'
    };
    
    this.pluralRules = { ...defaultRules, ...this.config.pluralRules };
  }
  
  /**
   * Initialize formatters
   */
  initializeFormatters() {
    // Date formatters
    this.dateFormatters = new Map();
    Object.entries(SupportedLanguages).forEach(([_, lang]) => {
      this.dateFormatters.set(lang, new Intl.DateTimeFormat(lang, 
        this.config.dateFormats[lang] || {}
      ));
    });
    
    // Number formatters
    this.numberFormatters = new Map();
    Object.entries(SupportedLanguages).forEach(([_, lang]) => {
      this.numberFormatters.set(lang, new Intl.NumberFormat(lang,
        this.config.numberFormats[lang] || {}
      ));
    });
    
    // Currency formatters
    this.currencyFormatters = new Map();
    Object.entries(SupportedLanguages).forEach(([_, lang]) => {
      this.currencyFormatters.set(lang, new Intl.NumberFormat(lang, {
        style: 'currency',
        currency: this.getCurrencyForLanguage(lang),
        ...this.config.numberFormats[lang]
      }));
    });
  }
  
  /**
   * Set current language
   */
  async setLanguage(language) {
    if (!Object.values(SupportedLanguages).includes(language)) {
      throw new Error(`Unsupported language: ${language}`);
    }
    
    // Load language if not already loaded
    if (!this.loadedLanguages.has(language)) {
      await this.loadLanguage(language);
    }
    
    const previousLanguage = this.currentLanguage;
    this.currentLanguage = language;
    
    // Clear translation cache
    if (this.config.cache) {
      this.translationCache.clear();
    }
    
    logger.info('Language changed', {
      from: previousLanguage,
      to: language
    });
    
    this.emit('languageChanged', {
      previous: previousLanguage,
      current: language
    });
  }
  
  /**
   * Get current language
   */
  getLanguage() {
    return this.currentLanguage;
  }
  
  /**
   * Translate key
   */
  translate(key, params = {}, options = {}) {
    const language = options.language || this.currentLanguage;
    
    // Check cache
    if (this.config.cache) {
      const cacheKey = `${language}:${key}:${JSON.stringify(params)}`;
      if (this.translationCache.has(cacheKey)) {
        return this.translationCache.get(cacheKey);
      }
    }
    
    // Get translation
    let translation = this.getTranslation(key, language);
    
    // Fallback to default language
    if (!translation && language !== this.config.fallbackLanguage) {
      translation = this.getTranslation(key, this.config.fallbackLanguage);
    }
    
    // Return key if no translation found
    if (!translation) {
      logger.warn('Translation not found', { key, language });
      return key;
    }
    
    // Handle pluralization
    if (typeof translation === 'object' && params.count !== undefined) {
      const pluralForm = this.getPluralForm(params.count, language);
      translation = translation[pluralForm] || translation.other || key;
    }
    
    // Replace parameters
    let result = translation;
    Object.entries(params).forEach(([param, value]) => {
      result = result.replace(new RegExp(`{{\\s*${param}\\s*}}`, 'g'), value);
    });
    
    // Cache result
    if (this.config.cache) {
      const cacheKey = `${language}:${key}:${JSON.stringify(params)}`;
      this.translationCache.set(cacheKey, result);
    }
    
    return result;
  }
  
  /**
   * Alias for translate
   */
  t(key, params, options) {
    return this.translate(key, params, options);
  }
  
  /**
   * Get translation from loaded data
   */
  getTranslation(key, language) {
    const languageData = this.translations.get(language);
    if (!languageData) return null;
    
    // Support nested keys (e.g., 'errors.network.timeout')
    const keys = key.split('.');
    let current = languageData;
    
    for (const k of keys) {
      if (current && typeof current === 'object') {
        current = current[k];
      } else {
        return null;
      }
    }
    
    return current;
  }
  
  /**
   * Get plural form
   */
  getPluralForm(count, language) {
    const rule = this.pluralRules[language];
    if (!rule) return 'other';
    
    return rule(count);
  }
  
  /**
   * Format date
   */
  formatDate(date, options = {}) {
    const language = options.language || this.currentLanguage;
    const formatter = this.dateFormatters.get(language);
    
    if (!formatter) {
      return date.toISOString();
    }
    
    return formatter.format(date);
  }
  
  /**
   * Format number
   */
  formatNumber(number, options = {}) {
    const language = options.language || this.currentLanguage;
    const formatter = this.numberFormatters.get(language);
    
    if (!formatter) {
      return number.toString();
    }
    
    return formatter.format(number);
  }
  
  /**
   * Format currency
   */
  formatCurrency(amount, currency, options = {}) {
    const language = options.language || this.currentLanguage;
    
    try {
      const formatter = new Intl.NumberFormat(language, {
        style: 'currency',
        currency: currency || this.getCurrencyForLanguage(language)
      });
      
      return formatter.format(amount);
    } catch (error) {
      logger.error('Failed to format currency', { error, amount, currency });
      return `${currency || 'USD'} ${amount}`;
    }
  }
  
  /**
   * Get currency for language
   */
  getCurrencyForLanguage(language) {
    const currencyMap = {
      [SupportedLanguages.EN]: 'USD',
      [SupportedLanguages.JA]: 'JPY',
      [SupportedLanguages.ZH_CN]: 'CNY',
      [SupportedLanguages.ZH_TW]: 'TWD',
      [SupportedLanguages.KO]: 'KRW',
      [SupportedLanguages.ES]: 'EUR',
      [SupportedLanguages.FR]: 'EUR',
      [SupportedLanguages.DE]: 'EUR',
      [SupportedLanguages.RU]: 'RUB',
      [SupportedLanguages.PT]: 'EUR'
    };
    
    return currencyMap[language] || 'USD';
  }
  
  /**
   * Detect language from request
   */
  detectLanguage(req) {
    if (!this.config.autoDetect) {
      return this.config.defaultLanguage;
    }
    
    // Check query parameter
    if (req.query?.lang && Object.values(SupportedLanguages).includes(req.query.lang)) {
      return req.query.lang;
    }
    
    // Check cookie
    if (req.cookies?.language && Object.values(SupportedLanguages).includes(req.cookies.language)) {
      return req.cookies.language;
    }
    
    // Check Accept-Language header
    if (req.headers['accept-language']) {
      const languages = acceptLanguageParser.parse(req.headers['accept-language']);
      const supportedLangs = Object.values(SupportedLanguages);
      
      for (const lang of languages) {
        // Exact match
        if (supportedLangs.includes(lang.code)) {
          return lang.code;
        }
        
        // Language without region
        const baseCode = lang.code.split('-')[0];
        const match = supportedLangs.find(l => l.startsWith(baseCode));
        if (match) {
          return match;
        }
      }
    }
    
    return this.config.defaultLanguage;
  }
  
  /**
   * Express middleware
   */
  middleware() {
    return async (req, res, next) => {
      // Detect language
      const detectedLanguage = this.detectLanguage(req);
      
      // Create translation function for request
      req.language = detectedLanguage;
      req.t = (key, params, options) => {
        return this.translate(key, params, {
          ...options,
          language: req.language
        });
      };
      
      // Add formatters
      req.formatDate = (date, options) => {
        return this.formatDate(date, {
          ...options,
          language: req.language
        });
      };
      
      req.formatNumber = (number, options) => {
        return this.formatNumber(number, {
          ...options,
          language: req.language
        });
      };
      
      req.formatCurrency = (amount, currency, options) => {
        return this.formatCurrency(amount, currency, {
          ...options,
          language: req.language
        });
      };
      
      // Set language in response locals
      res.locals.language = req.language;
      res.locals.t = req.t;
      res.locals.languages = LanguageInfo;
      res.locals.currentLanguage = LanguageInfo[req.language];
      
      next();
    };
  }
  
  /**
   * Get available languages
   */
  getAvailableLanguages() {
    return Object.entries(LanguageInfo).map(([code, info]) => ({
      code,
      ...info,
      active: code === this.currentLanguage,
      loaded: this.loadedLanguages.has(code)
    }));
  }
  
  /**
   * Export translations for client-side use
   */
  async exportTranslations(language, categories = null) {
    if (!this.loadedLanguages.has(language)) {
      await this.loadLanguage(language);
    }
    
    const translations = this.translations.get(language);
    if (!translations) {
      return {};
    }
    
    if (!categories) {
      return translations;
    }
    
    // Filter by categories
    const filtered = {};
    for (const category of categories) {
      if (translations[category]) {
        filtered[category] = translations[category];
      }
    }
    
    return filtered;
  }
  
  /**
   * Add custom translations
   */
  addTranslations(language, category, translations) {
    if (!this.translations.has(language)) {
      this.translations.set(language, {});
    }
    
    const languageData = this.translations.get(language);
    languageData[category] = {
      ...languageData[category],
      ...translations
    };
    
    // Clear cache
    if (this.config.cache) {
      this.translationCache.clear();
    }
    
    logger.info('Custom translations added', {
      language,
      category,
      count: Object.keys(translations).length
    });
  }
  
  /**
   * Generate missing translations report
   */
  async generateMissingTranslationsReport() {
    const report = {};
    const baseLanguage = this.config.defaultLanguage;
    const baseTranslations = this.translations.get(baseLanguage);
    
    if (!baseTranslations) {
      return report;
    }
    
    // Check each language
    for (const [language, translations] of this.translations) {
      if (language === baseLanguage) continue;
      
      report[language] = {
        missing: [],
        extra: []
      };
      
      // Find missing keys
      this.compareTranslations(
        baseTranslations,
        translations,
        '',
        report[language].missing
      );
      
      // Find extra keys
      this.compareTranslations(
        translations,
        baseTranslations,
        '',
        report[language].extra
      );
    }
    
    return report;
  }
  
  /**
   * Compare translations recursively
   */
  compareTranslations(source, target, prefix, missing) {
    for (const [key, value] of Object.entries(source)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      
      if (typeof value === 'object' && value !== null) {
        if (!target[key] || typeof target[key] !== 'object') {
          missing.push(fullKey);
        } else {
          this.compareTranslations(value, target[key], fullKey, missing);
        }
      } else {
        if (!target[key]) {
          missing.push(fullKey);
        }
      }
    }
  }
  
  /**
   * Save translations to disk
   */
  async saveTranslations(language) {
    const translations = this.translations.get(language);
    if (!translations) {
      throw new Error(`No translations loaded for language: ${language}`);
    }
    
    const langDir = join(this.config.translationsPath, language);
    await fs.mkdir(langDir, { recursive: true });
    
    // Save each category
    for (const [category, data] of Object.entries(translations)) {
      const filePath = join(langDir, `${category}.json`);
      await fs.writeFile(
        filePath,
        JSON.stringify(data, null, 2)
      );
    }
    
    logger.info('Translations saved', { language });
  }
  
  /**
   * Create default translation files
   */
  async createDefaultTranslations() {
    const defaultTranslations = {
      [TranslationCategory.UI]: {
        common: {
          title: 'Otedama P2P Mining Pool',
          welcome: 'Welcome',
          loading: 'Loading...',
          error: 'Error',
          success: 'Success',
          cancel: 'Cancel',
          save: 'Save',
          delete: 'Delete',
          confirm: 'Confirm',
          back: 'Back',
          next: 'Next',
          previous: 'Previous',
          search: 'Search',
          filter: 'Filter',
          sort: 'Sort',
          refresh: 'Refresh',
          download: 'Download',
          upload: 'Upload',
          settings: 'Settings',
          help: 'Help',
          about: 'About',
          logout: 'Logout',
          login: 'Login',
          register: 'Register'
        },
        navigation: {
          dashboard: 'Dashboard',
          mining: 'Mining',
          pool: 'Pool',
          wallet: 'Wallet',
          statistics: 'Statistics',
          settings: 'Settings',
          help: 'Help'
        }
      },
      [TranslationCategory.MINING]: {
        status: {
          active: 'Active',
          inactive: 'Inactive',
          paused: 'Paused',
          error: 'Error'
        },
        metrics: {
          hashrate: 'Hashrate',
          shares: 'Shares',
          difficulty: 'Difficulty',
          efficiency: 'Efficiency',
          temperature: 'Temperature',
          power: 'Power Consumption'
        },
        actions: {
          start: 'Start Mining',
          stop: 'Stop Mining',
          pause: 'Pause Mining',
          resume: 'Resume Mining'
        }
      },
      [TranslationCategory.ERRORS]: {
        network: {
          connection_failed: 'Connection failed',
          timeout: 'Request timeout',
          server_error: 'Server error'
        },
        validation: {
          required: 'This field is required',
          invalid_format: 'Invalid format',
          too_short: 'Too short',
          too_long: 'Too long'
        },
        mining: {
          worker_offline: 'Worker offline',
          invalid_share: 'Invalid share',
          pool_disconnected: 'Pool disconnected'
        }
      }
    };
    
    // Save default translations for English
    this.translations.set(SupportedLanguages.EN, defaultTranslations);
    await this.saveTranslations(SupportedLanguages.EN);
    
    logger.info('Default translations created');
  }
  
  /**
   * Get statistics
   */
  getStatistics() {
    const stats = {
      loadedLanguages: this.loadedLanguages.size,
      currentLanguage: this.currentLanguage,
      cacheSize: this.translationCache.size,
      totalTranslations: 0
    };
    
    // Count total translations
    for (const [_, translations] of this.translations) {
      stats.totalTranslations += this.countTranslations(translations);
    }
    
    return stats;
  }
  
  /**
   * Count translations recursively
   */
  countTranslations(obj) {
    let count = 0;
    
    for (const value of Object.values(obj)) {
      if (typeof value === 'object' && value !== null) {
        count += this.countTranslations(value);
      } else {
        count++;
      }
    }
    
    return count;
  }
  
  /**
   * Clear cache
   */
  clearCache() {
    this.translationCache.clear();
    logger.info('Translation cache cleared');
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    this.clearCache();
    logger.info('Multi-language support shutdown');
    this.emit('shutdown');
  }
}

/**
 * Factory function
 */
export function createLanguageSupport(config) {
  return new MultiLanguageSupport(config);
}

export default MultiLanguageSupport;