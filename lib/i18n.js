/**
 * Enhanced Internationalization (i18n) System for Otedama
 * Supports 50+ languages with dynamic loading and pluralization
 */

import { EventEmitter } from 'events';
import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { Logger } from './logger.js';

/**
 * Language codes following ISO 639-1
 */
export const Languages = {
  // Major languages
  EN: 'en', // English
  ZH: 'zh', // Chinese
  ES: 'es', // Spanish  
  HI: 'hi', // Hindi
  AR: 'ar', // Arabic
  PT: 'pt', // Portuguese
  RU: 'ru', // Russian
  JA: 'ja', // Japanese
  DE: 'de', // German
  FR: 'fr', // French
  
  // Additional languages
  KO: 'ko', // Korean
  IT: 'it', // Italian
  TR: 'tr', // Turkish
  PL: 'pl', // Polish
  NL: 'nl', // Dutch
  SV: 'sv', // Swedish
  NO: 'no', // Norwegian
  FI: 'fi', // Finnish
  DA: 'da', // Danish
  CS: 'cs', // Czech
  HU: 'hu', // Hungarian
  RO: 'ro', // Romanian
  BG: 'bg', // Bulgarian
  HR: 'hr', // Croatian
  SK: 'sk', // Slovak
  SL: 'sl', // Slovenian
  UK: 'uk', // Ukrainian
  VI: 'vi', // Vietnamese
  TH: 'th', // Thai
  ID: 'id', // Indonesian
  MS: 'ms', // Malay
  FA: 'fa', // Persian
  HE: 'he', // Hebrew
  EL: 'el', // Greek
  CA: 'ca', // Catalan
  EU: 'eu', // Basque
  GL: 'gl', // Galician
  
  // Regional variants
  EN_US: 'en-US',
  EN_GB: 'en-GB',
  EN_AU: 'en-AU',
  ZH_CN: 'zh-CN',
  ZH_TW: 'zh-TW',
  PT_BR: 'pt-BR',
  PT_PT: 'pt-PT',
  ES_ES: 'es-ES',
  ES_MX: 'es-MX',
  FR_FR: 'fr-FR',
  FR_CA: 'fr-CA',
  DE_DE: 'de-DE',
  DE_AT: 'de-AT',
  DE_CH: 'de-CH'
};

/**
 * Pluralization rules for different languages
 */
const PluralizationRules = {
  // English, German, Dutch, Swedish, Norwegian, Danish
  default: (n) => n === 1 ? 'one' : 'other',
  
  // French, Portuguese, Spanish, Italian
  romance: (n) => n === 0 || n === 1 ? 'one' : 'other',
  
  // Polish
  polish: (n) => {
    if (n === 1) return 'one';
    if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return 'few';
    return 'many';
  },
  
  // Russian, Ukrainian
  slavic: (n) => {
    if (n % 10 === 1 && n % 100 !== 11) return 'one';
    if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return 'few';
    return 'many';
  },
  
  // Czech, Slovak
  czech: (n) => {
    if (n === 1) return 'one';
    if (n >= 2 && n <= 4) return 'few';
    return 'many';
  },
  
  // Arabic
  arabic: (n) => {
    if (n === 0) return 'zero';
    if (n === 1) return 'one';
    if (n === 2) return 'two';
    if (n % 100 >= 3 && n % 100 <= 10) return 'few';
    if (n % 100 >= 11) return 'many';
    return 'other';
  },
  
  // Japanese, Chinese, Korean, Thai, Vietnamese
  asian: (n) => 'other',
  
  // Turkish
  turkish: (n) => n === 1 ? 'one' : 'other'
};

/**
 * Language metadata
 */
const LanguageMetadata = {
  en: { name: 'English', nativeName: 'English', direction: 'ltr', pluralRule: 'default' },
  zh: { name: 'Chinese', nativeName: '中文', direction: 'ltr', pluralRule: 'asian' },
  es: { name: 'Spanish', nativeName: 'Español', direction: 'ltr', pluralRule: 'romance' },
  hi: { name: 'Hindi', nativeName: 'हिन्दी', direction: 'ltr', pluralRule: 'default' },
  ar: { name: 'Arabic', nativeName: 'العربية', direction: 'rtl', pluralRule: 'arabic' },
  pt: { name: 'Portuguese', nativeName: 'Português', direction: 'ltr', pluralRule: 'romance' },
  ru: { name: 'Russian', nativeName: 'Русский', direction: 'ltr', pluralRule: 'slavic' },
  ja: { name: 'Japanese', nativeName: '日本語', direction: 'ltr', pluralRule: 'asian' },
  de: { name: 'German', nativeName: 'Deutsch', direction: 'ltr', pluralRule: 'default' },
  fr: { name: 'French', nativeName: 'Français', direction: 'ltr', pluralRule: 'romance' },
  ko: { name: 'Korean', nativeName: '한국어', direction: 'ltr', pluralRule: 'asian' },
  it: { name: 'Italian', nativeName: 'Italiano', direction: 'ltr', pluralRule: 'romance' },
  tr: { name: 'Turkish', nativeName: 'Türkçe', direction: 'ltr', pluralRule: 'turkish' },
  pl: { name: 'Polish', nativeName: 'Polski', direction: 'ltr', pluralRule: 'polish' },
  nl: { name: 'Dutch', nativeName: 'Nederlands', direction: 'ltr', pluralRule: 'default' },
  sv: { name: 'Swedish', nativeName: 'Svenska', direction: 'ltr', pluralRule: 'default' },
  no: { name: 'Norwegian', nativeName: 'Norsk', direction: 'ltr', pluralRule: 'default' },
  fi: { name: 'Finnish', nativeName: 'Suomi', direction: 'ltr', pluralRule: 'default' },
  da: { name: 'Danish', nativeName: 'Dansk', direction: 'ltr', pluralRule: 'default' },
  cs: { name: 'Czech', nativeName: 'Čeština', direction: 'ltr', pluralRule: 'czech' },
  hu: { name: 'Hungarian', nativeName: 'Magyar', direction: 'ltr', pluralRule: 'default' },
  ro: { name: 'Romanian', nativeName: 'Română', direction: 'ltr', pluralRule: 'romance' },
  bg: { name: 'Bulgarian', nativeName: 'Български', direction: 'ltr', pluralRule: 'slavic' },
  hr: { name: 'Croatian', nativeName: 'Hrvatski', direction: 'ltr', pluralRule: 'slavic' },
  sk: { name: 'Slovak', nativeName: 'Slovenčina', direction: 'ltr', pluralRule: 'czech' },
  sl: { name: 'Slovenian', nativeName: 'Slovenščina', direction: 'ltr', pluralRule: 'slavic' },
  uk: { name: 'Ukrainian', nativeName: 'Українська', direction: 'ltr', pluralRule: 'slavic' },
  vi: { name: 'Vietnamese', nativeName: 'Tiếng Việt', direction: 'ltr', pluralRule: 'asian' },
  th: { name: 'Thai', nativeName: 'ไทย', direction: 'ltr', pluralRule: 'asian' },
  id: { name: 'Indonesian', nativeName: 'Bahasa Indonesia', direction: 'ltr', pluralRule: 'asian' },
  ms: { name: 'Malay', nativeName: 'Bahasa Melayu', direction: 'ltr', pluralRule: 'asian' },
  fa: { name: 'Persian', nativeName: 'فارسی', direction: 'rtl', pluralRule: 'default' },
  he: { name: 'Hebrew', nativeName: 'עברית', direction: 'rtl', pluralRule: 'default' },
  el: { name: 'Greek', nativeName: 'Ελληνικά', direction: 'ltr', pluralRule: 'default' },
  ca: { name: 'Catalan', nativeName: 'Català', direction: 'ltr', pluralRule: 'romance' },
  eu: { name: 'Basque', nativeName: 'Euskara', direction: 'ltr', pluralRule: 'default' },
  gl: { name: 'Galician', nativeName: 'Galego', direction: 'ltr', pluralRule: 'romance' }
};

/**
 * I18n Manager
 */
export class I18nManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      defaultLanguage: options.defaultLanguage || 'en',
      fallbackLanguage: options.fallbackLanguage || 'en',
      localesPath: options.localesPath || './locales',
      autoDetect: options.autoDetect !== false,
      interpolation: {
        prefix: options.interpolation?.prefix || '{{',
        suffix: options.interpolation?.suffix || '}}'
      },
      ...options
    };
    
    this.logger = options.logger || new Logger();
    this.translations = new Map();
    this.currentLanguage = this.options.defaultLanguage;
    this.loadedLanguages = new Set();
    
    // Load default language on init
    this.loadLanguage(this.options.defaultLanguage).catch(error => {
      this.logger.error('Failed to load default language', { error });
    });
  }
  
  /**
   * Get supported languages
   */
  getSupportedLanguages() {
    return Object.entries(LanguageMetadata).map(([code, meta]) => ({
      code,
      ...meta
    }));
  }
  
  /**
   * Get current language
   */
  getCurrentLanguage() {
    return this.currentLanguage;
  }
  
  /**
   * Get language metadata
   */
  getLanguageMetadata(code) {
    const baseCode = code.split('-')[0];
    return LanguageMetadata[baseCode] || LanguageMetadata[this.options.fallbackLanguage];
  }
  
  /**
   * Set current language
   */
  async setLanguage(code) {
    if (!this.isLanguageSupported(code)) {
      throw new Error(`Language ${code} is not supported`);
    }
    
    // Load language if not already loaded
    if (!this.loadedLanguages.has(code)) {
      await this.loadLanguage(code);
    }
    
    const previousLanguage = this.currentLanguage;
    this.currentLanguage = code;
    
    this.emit('languageChanged', {
      previous: previousLanguage,
      current: code
    });
    
    this.logger.info(`Language changed to ${code}`);
  }
  
  /**
   * Check if language is supported
   */
  isLanguageSupported(code) {
    const baseCode = code.split('-')[0];
    return baseCode in LanguageMetadata;
  }
  
  /**
   * Load language translations
   */
  async loadLanguage(code) {
    const baseCode = code.split('-')[0];
    const paths = [
      join(this.options.localesPath, `${code}.json`),
      join(this.options.localesPath, `${baseCode}.json`)
    ];
    
    for (const path of paths) {
      if (existsSync(path)) {
        try {
          const content = await readFile(path, 'utf8');
          const translations = JSON.parse(content);
          
          this.translations.set(code, translations);
          this.loadedLanguages.add(code);
          
          this.logger.debug(`Loaded language: ${code}`);
          return;
        } catch (error) {
          this.logger.error(`Failed to load language file: ${path}`, { error });
        }
      }
    }
    
    // Create minimal translations if file not found
    this.translations.set(code, {});
    this.loadedLanguages.add(code);
  }
  
  /**
   * Translate a key
   */
  t(key, params = {}, options = {}) {
    const language = options.language || this.currentLanguage;
    const count = params.count;
    
    // Get translation
    let translation = this.getTranslation(key, language);
    
    // Handle pluralization
    if (count !== undefined && typeof translation === 'object') {
      const pluralForm = this.getPluralForm(count, language);
      translation = translation[pluralForm] || translation.other || key;
    }
    
    // Interpolate parameters
    if (typeof translation === 'string') {
      translation = this.interpolate(translation, params);
    }
    
    return translation;
  }
  
  /**
   * Get translation for key
   */
  getTranslation(key, language) {
    // Try exact language
    let translations = this.translations.get(language);
    let value = this.getNestedValue(translations, key);
    
    if (value !== undefined) {
      return value;
    }
    
    // Try base language
    const baseLanguage = language.split('-')[0];
    if (baseLanguage !== language) {
      translations = this.translations.get(baseLanguage);
      value = this.getNestedValue(translations, key);
      
      if (value !== undefined) {
        return value;
      }
    }
    
    // Try fallback language
    if (language !== this.options.fallbackLanguage) {
      translations = this.translations.get(this.options.fallbackLanguage);
      value = this.getNestedValue(translations, key);
      
      if (value !== undefined) {
        return value;
      }
    }
    
    // Return key as fallback
    return key;
  }
  
  /**
   * Get nested value from object
   */
  getNestedValue(obj, key) {
    if (!obj) return undefined;
    
    const keys = key.split('.');
    let value = obj;
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return undefined;
      }
    }
    
    return value;
  }
  
  /**
   * Get plural form for count
   */
  getPluralForm(count, language) {
    const metadata = this.getLanguageMetadata(language);
    const ruleName = metadata.pluralRule || 'default';
    const rule = PluralizationRules[ruleName] || PluralizationRules.default;
    
    return rule(count);
  }
  
  /**
   * Interpolate parameters in translation
   */
  interpolate(translation, params) {
    const { prefix, suffix } = this.options.interpolation;
    const regex = new RegExp(`${prefix}([^${suffix}]+)${suffix}`, 'g');
    
    return translation.replace(regex, (match, key) => {
      const value = params[key.trim()];
      return value !== undefined ? value : match;
    });
  }
  
  /**
   * Format number according to locale
   */
  formatNumber(number, options = {}) {
    const locale = this.currentLanguage.replace('_', '-');
    return new Intl.NumberFormat(locale, options).format(number);
  }
  
  /**
   * Format currency according to locale
   */
  formatCurrency(amount, currency = 'USD', options = {}) {
    const locale = this.currentLanguage.replace('_', '-');
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      ...options
    }).format(amount);
  }
  
  /**
   * Format date according to locale
   */
  formatDate(date, options = {}) {
    const locale = this.currentLanguage.replace('_', '-');
    const dateObj = date instanceof Date ? date : new Date(date);
    return new Intl.DateTimeFormat(locale, options).format(dateObj);
  }
  
  /**
   * Format relative time
   */
  formatRelativeTime(date, options = {}) {
    const locale = this.currentLanguage.replace('_', '-');
    const rtf = new Intl.RelativeTimeFormat(locale, {
      numeric: 'auto',
      ...options
    });
    
    const dateObj = date instanceof Date ? date : new Date(date);
    const diff = dateObj.getTime() - Date.now();
    
    const units = [
      { unit: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
      { unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
      { unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
      { unit: 'day', ms: 24 * 60 * 60 * 1000 },
      { unit: 'hour', ms: 60 * 60 * 1000 },
      { unit: 'minute', ms: 60 * 1000 },
      { unit: 'second', ms: 1000 }
    ];
    
    for (const { unit, ms } of units) {
      const value = Math.round(diff / ms);
      if (Math.abs(value) >= 1) {
        return rtf.format(value, unit);
      }
    }
    
    return rtf.format(0, 'second');
  }
  
  /**
   * Detect language from request
   */
  detectLanguage(request) {
    if (!this.options.autoDetect) {
      return this.options.defaultLanguage;
    }
    
    // Check query parameter
    if (request.query?.lang) {
      const lang = request.query.lang;
      if (this.isLanguageSupported(lang)) {
        return lang;
      }
    }
    
    // Check cookie
    if (request.cookies?.language) {
      const lang = request.cookies.language;
      if (this.isLanguageSupported(lang)) {
        return lang;
      }
    }
    
    // Check Accept-Language header
    if (request.headers?.['accept-language']) {
      const languages = this.parseAcceptLanguage(request.headers['accept-language']);
      
      for (const lang of languages) {
        if (this.isLanguageSupported(lang.code)) {
          return lang.code;
        }
        
        // Try base language
        const baseCode = lang.code.split('-')[0];
        if (this.isLanguageSupported(baseCode)) {
          return baseCode;
        }
      }
    }
    
    return this.options.defaultLanguage;
  }
  
  /**
   * Parse Accept-Language header
   */
  parseAcceptLanguage(header) {
    return header
      .split(',')
      .map(lang => {
        const [code, q] = lang.trim().split(';q=');
        return {
          code: code.toLowerCase(),
          quality: q ? parseFloat(q) : 1.0
        };
      })
      .sort((a, b) => b.quality - a.quality);
  }
  
  /**
   * Create middleware for Express/Koa
   */
  middleware() {
    return async (req, res, next) => {
      // Detect language
      const detectedLanguage = this.detectLanguage(req);
      
      // Create i18n helper for request
      req.i18n = {
        language: detectedLanguage,
        t: (key, params, options) => this.t(key, params, { ...options, language: detectedLanguage }),
        setLanguage: async (lang) => {
          req.i18n.language = lang;
          if (res.cookie) {
            res.cookie('language', lang, { maxAge: 365 * 24 * 60 * 60 * 1000 });
          }
        },
        formatNumber: (number, options) => {
          const locale = detectedLanguage.replace('_', '-');
          return new Intl.NumberFormat(locale, options).format(number);
        },
        formatCurrency: (amount, currency, options) => {
          const locale = detectedLanguage.replace('_', '-');
          return new Intl.NumberFormat(locale, {
            style: 'currency',
            currency,
            ...options
          }).format(amount);
        },
        formatDate: (date, options) => {
          const locale = detectedLanguage.replace('_', '-');
          return new Intl.DateTimeFormat(locale, options).format(date);
        }
      };
      
      // Add helper to response locals (for template engines)
      if (res.locals) {
        res.locals.i18n = req.i18n;
        res.locals.__ = req.i18n.t;
      }
      
      next();
    };
  }
  
  /**
   * Load all available languages
   */
  async loadAllLanguages() {
    if (!existsSync(this.options.localesPath)) {
      this.logger.warn('Locales directory not found');
      return;
    }
    
    const files = await readdir(this.options.localesPath);
    const languages = files
      .filter(file => file.endsWith('.json'))
      .map(file => basename(file, '.json'));
    
    for (const language of languages) {
      if (!this.loadedLanguages.has(language)) {
        await this.loadLanguage(language);
      }
    }
    
    this.logger.info(`Loaded ${this.loadedLanguages.size} languages`);
  }
  
  /**
   * Export translations for client
   */
  exportForClient(language = null) {
    const lang = language || this.currentLanguage;
    const translations = this.translations.get(lang) || {};
    const metadata = this.getLanguageMetadata(lang);
    
    return {
      language: lang,
      direction: metadata.direction,
      translations
    };
  }
}

// Create singleton instance
let i18nInstance;

export function createI18n(options) {
  if (!i18nInstance) {
    i18nInstance = new I18nManager(options);
  }
  return i18nInstance;
}

export function getI18n() {
  if (!i18nInstance) {
    throw new Error('I18n not initialized');
  }
  return i18nInstance;
}

// Helper function for use in templates
export function t(key, params, options) {
  return getI18n().t(key, params, options);
}