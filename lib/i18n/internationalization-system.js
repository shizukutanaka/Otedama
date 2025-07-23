/**
 * Internationalization System for Otedama
 * Multi-language support with dynamic loading and caching
 */

import { EventEmitter } from 'events';
import { readFile, writeFile, access } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../core/standardized-error-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Supported languages (50 languages as per requirements)
export const SUPPORTED_LANGUAGES = {
  'en': 'English',
  'zh': 'Chinese (Simplified)',
  'es': 'Spanish',
  'hi': 'Hindi',
  'ar': 'Arabic',
  'pt': 'Portuguese',
  'bn': 'Bengali',
  'ru': 'Russian',
  'ja': 'Japanese',
  'pa': 'Punjabi',
  'de': 'German',
  'jv': 'Javanese',
  'wu': 'Wu Chinese',
  'ms': 'Malay',
  'te': 'Telugu',
  'vi': 'Vietnamese',
  'ko': 'Korean',
  'fr': 'French',
  'mr': 'Marathi',
  'ta': 'Tamil',
  'ur': 'Urdu',
  'tr': 'Turkish',
  'it': 'Italian',
  'th': 'Thai',
  'gu': 'Gujarati',
  'jin': 'Jin Chinese',
  'min': 'Min Chinese',
  'kn': 'Kannada',
  'ml': 'Malayalam',
  'my': 'Burmese',
  'or': 'Odia',
  'xh': 'Xhosa',
  'zu': 'Zulu',
  'am': 'Amharic',
  'az': 'Azerbaijani',
  'be': 'Belarusian',
  'bg': 'Bulgarian',
  'bs': 'Bosnian',
  'ca': 'Catalan',
  'cs': 'Czech',
  'da': 'Danish',
  'el': 'Greek',
  'et': 'Estonian',
  'fa': 'Persian',
  'fi': 'Finnish',
  'he': 'Hebrew',
  'hr': 'Croatian',
  'hu': 'Hungarian',
  'id': 'Indonesian',
  'is': 'Icelandic'
};

export class InternationalizationSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      defaultLanguage: options.defaultLanguage || 'en',
      fallbackLanguage: options.fallbackLanguage || 'en',
      translationsPath: options.translationsPath || join(__dirname, '../../translations'),
      cacheEnabled: options.cacheEnabled !== false,
      autoDetectLanguage: options.autoDetectLanguage !== false,
      pluralizationEnabled: options.pluralizationEnabled !== false,
      interpolationEnabled: options.interpolationEnabled !== false,
      ...options
    };
    
    this.cache = new Map();
    this.loadedLanguages = new Set();
    this.currentLanguage = this.options.defaultLanguage;
    this.errorHandler = getErrorHandler();
    
    this.pluralRules = new Map();
    this.initializePluralRules();
  }
  
  /**
   * Initialize plural rules for different languages
   */
  initializePluralRules() {
    // English plural rule
    this.pluralRules.set('en', (n) => n === 1 ? 0 : 1);
    
    // Russian plural rule
    this.pluralRules.set('ru', (n) => {
      if (n % 10 === 1 && n % 100 !== 11) return 0;
      if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 1;
      return 2;
    });
    
    // Arabic plural rule
    this.pluralRules.set('ar', (n) => {
      if (n === 0) return 0;
      if (n === 1) return 1;
      if (n === 2) return 2;
      if (n % 100 >= 3 && n % 100 <= 10) return 3;
      if (n % 100 >= 11) return 4;
      return 5;
    });
    
    // Default plural rule for most languages
    const defaultRule = (n) => n === 1 ? 0 : 1;
    for (const lang of Object.keys(SUPPORTED_LANGUAGES)) {
      if (!this.pluralRules.has(lang)) {
        this.pluralRules.set(lang, defaultRule);
      }
    }
  }
  
  /**
   * Set current language
   */
  async setLanguage(language) {
    if (!SUPPORTED_LANGUAGES[language]) {
      throw new OtedamaError(`Unsupported language: ${language}`, ErrorCategory.VALIDATION);
    }
    
    await this.loadLanguage(language);
    this.currentLanguage = language;
    this.emit('languageChanged', language);
  }
  
  /**
   * Load language translations
   */
  async loadLanguage(language) {
    if (this.loadedLanguages.has(language)) return;
    
    try {
      const translationPath = join(this.options.translationsPath, `${language}.json`);
      
      // Check if translation file exists
      try {
        await access(translationPath);
      } catch {
        // Create default translation file if it doesn't exist
        await this.createDefaultTranslationFile(language);
      }
      
      const translationData = await readFile(translationPath, 'utf8');
      const translations = JSON.parse(translationData);
      
      if (this.options.cacheEnabled) {
        this.cache.set(language, translations);
      }
      
      this.loadedLanguages.add(language);
      this.emit('languageLoaded', language);
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'load_language',
        language,
        category: ErrorCategory.I18N
      });
      throw error;
    }
  }
  
  /**
   * Create default translation file
   */
  async createDefaultTranslationFile(language) {
    const defaultTranslations = {
      // Common UI elements
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
        search: 'Search',
        filter: 'Filter',
        sort: 'Sort',
        refresh: 'Refresh'
      },
      
      // Mining related
      mining: {
        title: 'Mining',
        start: 'Start Mining',
        stop: 'Stop Mining',
        status: 'Status',
        hashrate: 'Hashrate',
        shares: 'Shares',
        accepted: 'Accepted',
        rejected: 'Rejected',
        pool: 'Pool',
        worker: 'Worker',
        algorithm: 'Algorithm',
        difficulty: 'Difficulty',
        temperature: 'Temperature',
        power: 'Power Consumption'
      },
      
      // DEX related
      dex: {
        title: 'Decentralized Exchange',
        trade: 'Trade',
        buy: 'Buy',
        sell: 'Sell',
        price: 'Price',
        amount: 'Amount',
        total: 'Total',
        balance: 'Balance',
        orders: 'Orders',
        history: 'History',
        market: 'Market',
        limit: 'Limit',
        orderbook: 'Order Book',
        chart: 'Chart'
      },
      
      // DeFi related
      defi: {
        title: 'Decentralized Finance',
        stake: 'Stake',
        unstake: 'Unstake',
        rewards: 'Rewards',
        yield: 'Yield',
        liquidity: 'Liquidity',
        pool: 'Pool',
        farming: 'Farming',
        lending: 'Lending',
        borrowing: 'Borrowing',
        collateral: 'Collateral',
        interest: 'Interest Rate',
        apy: 'APY'
      },
      
      // Security related
      security: {
        title: 'Security',
        login: 'Login',
        logout: 'Logout',
        password: 'Password',
        username: 'Username',
        email: 'Email',
        twoFactor: 'Two-Factor Authentication',
        backup: 'Backup',
        recovery: 'Recovery',
        seed: 'Seed Phrase',
        private_key: 'Private Key',
        public_key: 'Public Key',
        wallet: 'Wallet',
        address: 'Address'
      },
      
      // Error messages
      errors: {
        network: 'Network error occurred',
        timeout: 'Request timeout',
        invalid_input: 'Invalid input',
        unauthorized: 'Unauthorized access',
        forbidden: 'Access forbidden',
        not_found: 'Resource not found',
        server_error: 'Server error',
        maintenance: 'System under maintenance',
        rate_limit: 'Rate limit exceeded',
        insufficient_funds: 'Insufficient funds'
      },
      
      // Success messages
      success: {
        saved: 'Successfully saved',
        updated: 'Successfully updated',
        deleted: 'Successfully deleted',
        created: 'Successfully created',
        sent: 'Successfully sent',
        received: 'Successfully received',
        connected: 'Successfully connected',
        disconnected: 'Successfully disconnected',
        authenticated: 'Successfully authenticated',
        verified: 'Successfully verified'
      }
    };
    
    const translationPath = join(this.options.translationsPath, `${language}.json`);
    await writeFile(translationPath, JSON.stringify(defaultTranslations, null, 2));
  }
  
  /**
   * Translate text
   */
  t(key, options = {}) {
    try {
      const { language = this.currentLanguage, count, interpolation = {} } = options;
      
      // Get translation
      let translation = this.getTranslation(key, language);
      
      // Handle pluralization
      if (this.options.pluralizationEnabled && count !== undefined) {
        translation = this.handlePluralization(translation, count, language);
      }
      
      // Handle interpolation
      if (this.options.interpolationEnabled && Object.keys(interpolation).length > 0) {
        translation = this.handleInterpolation(translation, interpolation);
      }
      
      return translation;
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'translate',
        key,
        language: options.language,
        category: ErrorCategory.I18N
      });
      
      // Return key as fallback
      return key;
    }
  }
  
  /**
   * Get translation from cache or fallback
   */
  getTranslation(key, language) {
    const translations = this.cache.get(language);
    if (!translations) {
      // Try fallback language
      const fallbackTranslations = this.cache.get(this.options.fallbackLanguage);
      if (!fallbackTranslations) {
        return key;
      }
      return this.getNestedValue(fallbackTranslations, key) || key;
    }
    
    return this.getNestedValue(translations, key) || key;
  }
  
  /**
   * Get nested value from object using dot notation
   */
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }
  
  /**
   * Handle pluralization
   */
  handlePluralization(translation, count, language) {
    if (typeof translation !== 'object') return translation;
    
    const pluralRule = this.pluralRules.get(language) || this.pluralRules.get('en');
    const pluralIndex = pluralRule(count);
    
    if (Array.isArray(translation)) {
      return translation[pluralIndex] || translation[0];
    }
    
    // Handle object-based pluralization
    const pluralKeys = ['zero', 'one', 'two', 'few', 'many', 'other'];
    const key = pluralKeys[pluralIndex] || 'other';
    
    return translation[key] || translation.other || translation;
  }
  
  /**
   * Handle interpolation
   */
  handleInterpolation(translation, interpolation) {
    if (typeof translation !== 'string') return translation;
    
    return translation.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return interpolation[key] !== undefined ? interpolation[key] : match;
    });
  }
  
  /**
   * Auto-detect language from request
   */
  detectLanguage(req) {
    if (!this.options.autoDetectLanguage) return this.options.defaultLanguage;
    
    // Check query parameter
    if (req.query?.lang && SUPPORTED_LANGUAGES[req.query.lang]) {
      return req.query.lang;
    }
    
    // Check Accept-Language header
    const acceptLanguage = req.headers['accept-language'];
    if (acceptLanguage) {
      const languages = acceptLanguage.split(',').map(lang => {
        const [code, quality = '1'] = lang.trim().split(';q=');
        return { code: code.split('-')[0], quality: parseFloat(quality) };
      }).sort((a, b) => b.quality - a.quality);
      
      for (const { code } of languages) {
        if (SUPPORTED_LANGUAGES[code]) {
          return code;
        }
      }
    }
    
    return this.options.defaultLanguage;
  }
  
  /**
   * Get available languages
   */
  getAvailableLanguages() {
    return Object.entries(SUPPORTED_LANGUAGES).map(([code, name]) => ({
      code,
      name,
      loaded: this.loadedLanguages.has(code)
    }));
  }
  
  /**
   * Get current language info
   */
  getCurrentLanguage() {
    return {
      code: this.currentLanguage,
      name: SUPPORTED_LANGUAGES[this.currentLanguage],
      loaded: this.loadedLanguages.has(this.currentLanguage)
    };
  }
  
  /**
   * Preload multiple languages
   */
  async preloadLanguages(languages) {
    const loadPromises = languages.map(lang => this.loadLanguage(lang));
    await Promise.all(loadPromises);
  }
  
  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    this.loadedLanguages.clear();
    this.emit('cacheCleared');
  }
  
  /**
   * Get translation statistics
   */
  getStatistics() {
    return {
      supportedLanguages: Object.keys(SUPPORTED_LANGUAGES).length,
      loadedLanguages: this.loadedLanguages.size,
      currentLanguage: this.currentLanguage,
      cacheSize: this.cache.size,
      cacheEnabled: this.options.cacheEnabled
    };
  }
  
  /**
   * Cleanup resources
   */
  cleanup() {
    this.clearCache();
    this.removeAllListeners();
  }
}

/**
 * Express middleware for internationalization
 */
export function i18nMiddleware(i18nSystem) {
  return async (req, res, next) => {
    try {
      // Detect language
      const detectedLanguage = i18nSystem.detectLanguage(req);
      
      // Set language if different from current
      if (detectedLanguage !== i18nSystem.currentLanguage) {
        await i18nSystem.setLanguage(detectedLanguage);
      }
      
      // Add translation function to request
      req.t = (key, options = {}) => i18nSystem.t(key, options);
      req.language = detectedLanguage;
      
      // Add language info to response locals
      res.locals.language = detectedLanguage;
      res.locals.t = req.t;
      
      next();
      
    } catch (error) {
      // Continue with default language on error
      req.t = (key) => key;
      req.language = i18nSystem.options.defaultLanguage;
      next();
    }
  };
}

export default InternationalizationSystem;
