/**
 * Internationalization Manager for Otedama
 * Supports 50+ languages with dynamic loading and fallback
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../error-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Supported languages with their metadata
export const SupportedLanguages = {
  // Major languages
  'en': { name: 'English', nativeName: 'English', direction: 'ltr', family: 'Germanic' },
  'zh': { name: 'Chinese', nativeName: '中文', direction: 'ltr', family: 'Sino-Tibetan' },
  'es': { name: 'Spanish', nativeName: 'Español', direction: 'ltr', family: 'Romance' },
  'hi': { name: 'Hindi', nativeName: 'हिन्दी', direction: 'ltr', family: 'Indo-European' },
  'ar': { name: 'Arabic', nativeName: 'العربية', direction: 'rtl', family: 'Semitic' },
  'pt': { name: 'Portuguese', nativeName: 'Português', direction: 'ltr', family: 'Romance' },
  'bn': { name: 'Bengali', nativeName: 'বাংলা', direction: 'ltr', family: 'Indo-European' },
  'ru': { name: 'Russian', nativeName: 'Русский', direction: 'ltr', family: 'Slavic' },
  'ja': { name: 'Japanese', nativeName: '日本語', direction: 'ltr', family: 'Japonic' },
  'pa': { name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', direction: 'ltr', family: 'Indo-European' },
  
  // European languages
  'de': { name: 'German', nativeName: 'Deutsch', direction: 'ltr', family: 'Germanic' },
  'fr': { name: 'French', nativeName: 'Français', direction: 'ltr', family: 'Romance' },
  'it': { name: 'Italian', nativeName: 'Italiano', direction: 'ltr', family: 'Romance' },
  'pl': { name: 'Polish', nativeName: 'Polski', direction: 'ltr', family: 'Slavic' },
  'tr': { name: 'Turkish', nativeName: 'Türkçe', direction: 'ltr', family: 'Turkic' },
  'nl': { name: 'Dutch', nativeName: 'Nederlands', direction: 'ltr', family: 'Germanic' },
  'sv': { name: 'Swedish', nativeName: 'Svenska', direction: 'ltr', family: 'Germanic' },
  'da': { name: 'Danish', nativeName: 'Dansk', direction: 'ltr', family: 'Germanic' },
  'no': { name: 'Norwegian', nativeName: 'Norsk', direction: 'ltr', family: 'Germanic' },
  'fi': { name: 'Finnish', nativeName: 'Suomi', direction: 'ltr', family: 'Uralic' },
  'el': { name: 'Greek', nativeName: 'Ελληνικά', direction: 'ltr', family: 'Indo-European' },
  'cs': { name: 'Czech', nativeName: 'Čeština', direction: 'ltr', family: 'Slavic' },
  'hu': { name: 'Hungarian', nativeName: 'Magyar', direction: 'ltr', family: 'Uralic' },
  'ro': { name: 'Romanian', nativeName: 'Română', direction: 'ltr', family: 'Romance' },
  'sk': { name: 'Slovak', nativeName: 'Slovenčina', direction: 'ltr', family: 'Slavic' },
  'bg': { name: 'Bulgarian', nativeName: 'Български', direction: 'ltr', family: 'Slavic' },
  'hr': { name: 'Croatian', nativeName: 'Hrvatski', direction: 'ltr', family: 'Slavic' },
  'sl': { name: 'Slovenian', nativeName: 'Slovenščina', direction: 'ltr', family: 'Slavic' },
  'lv': { name: 'Latvian', nativeName: 'Latviešu', direction: 'ltr', family: 'Baltic' },
  'lt': { name: 'Lithuanian', nativeName: 'Lietuvių', direction: 'ltr', family: 'Baltic' },
  'et': { name: 'Estonian', nativeName: 'Eesti', direction: 'ltr', family: 'Uralic' },
  
  // Asian languages
  'ko': { name: 'Korean', nativeName: '한국어', direction: 'ltr', family: 'Koreanic' },
  'th': { name: 'Thai', nativeName: 'ไทย', direction: 'ltr', family: 'Tai-Kadai' },
  'vi': { name: 'Vietnamese', nativeName: 'Tiếng Việt', direction: 'ltr', family: 'Austro-Asiatic' },
  'id': { name: 'Indonesian', nativeName: 'Bahasa Indonesia', direction: 'ltr', family: 'Austronesian' },
  'ms': { name: 'Malay', nativeName: 'Bahasa Melayu', direction: 'ltr', family: 'Austronesian' },
  'tl': { name: 'Filipino', nativeName: 'Filipino', direction: 'ltr', family: 'Austronesian' },
  'my': { name: 'Myanmar', nativeName: 'မြန်မာ', direction: 'ltr', family: 'Sino-Tibetan' },
  'km': { name: 'Khmer', nativeName: 'ខ្មែរ', direction: 'ltr', family: 'Austro-Asiatic' },
  'lo': { name: 'Lao', nativeName: 'ລາວ', direction: 'ltr', family: 'Tai-Kadai' },
  'ka': { name: 'Georgian', nativeName: 'ქართული', direction: 'ltr', family: 'Kartvelian' },
  'am': { name: 'Amharic', nativeName: 'አማርኛ', direction: 'ltr', family: 'Semitic' },
  'he': { name: 'Hebrew', nativeName: 'עברית', direction: 'rtl', family: 'Semitic' },
  'fa': { name: 'Persian', nativeName: 'فارسی', direction: 'rtl', family: 'Indo-European' },
  'ur': { name: 'Urdu', nativeName: 'اردو', direction: 'rtl', family: 'Indo-European' },
  
  // African languages
  'sw': { name: 'Swahili', nativeName: 'Kiswahili', direction: 'ltr', family: 'Niger-Congo' },
  'yo': { name: 'Yoruba', nativeName: 'Yorùbá', direction: 'ltr', family: 'Niger-Congo' },
  'ig': { name: 'Igbo', nativeName: 'Asụsụ Igbo', direction: 'ltr', family: 'Niger-Congo' },
  'ha': { name: 'Hausa', nativeName: 'Hausa', direction: 'ltr', family: 'Afro-Asiatic' },
  'zu': { name: 'Zulu', nativeName: 'isiZulu', direction: 'ltr', family: 'Niger-Congo' },
  'af': { name: 'Afrikaans', nativeName: 'Afrikaans', direction: 'ltr', family: 'Germanic' },
  
  // Other languages
  'uk': { name: 'Ukrainian', nativeName: 'Українська', direction: 'ltr', family: 'Slavic' },
  'be': { name: 'Belarusian', nativeName: 'Беларуская', direction: 'ltr', family: 'Slavic' },
  'kk': { name: 'Kazakh', nativeName: 'Қазақ тілі', direction: 'ltr', family: 'Turkic' },
  'uz': { name: 'Uzbek', nativeName: 'Oʻzbek tili', direction: 'ltr', family: 'Turkic' },
  'ky': { name: 'Kyrgyz', nativeName: 'Кыргызча', direction: 'ltr', family: 'Turkic' },
  'tg': { name: 'Tajik', nativeName: 'Тоҷикӣ', direction: 'ltr', family: 'Indo-European' },
  'mn': { name: 'Mongolian', nativeName: 'Монгол', direction: 'ltr', family: 'Mongolic' },
  'ne': { name: 'Nepali', nativeName: 'नेपाली', direction: 'ltr', family: 'Indo-European' },
  'si': { name: 'Sinhala', nativeName: 'සිංහල', direction: 'ltr', family: 'Indo-European' },
  'ta': { name: 'Tamil', nativeName: 'தமிழ்', direction: 'ltr', family: 'Dravidian' },
  'te': { name: 'Telugu', nativeName: 'తెలుగు', direction: 'ltr', family: 'Dravidian' },
  'kn': { name: 'Kannada', nativeName: 'ಕನ್ನಡ', direction: 'ltr', family: 'Dravidian' },
  'ml': { name: 'Malayalam', nativeName: 'മലയാളം', direction: 'ltr', family: 'Dravidian' },
  'gu': { name: 'Gujarati', nativeName: 'ગુજરાતી', direction: 'ltr', family: 'Indo-European' },
  'or': { name: 'Odia', nativeName: 'ଓଡ଼ିଆ', direction: 'ltr', family: 'Indo-European' },
  'as': { name: 'Assamese', nativeName: 'অসমীয়া', direction: 'ltr', family: 'Indo-European' }
};

// Default language
export const DEFAULT_LANGUAGE = 'en';

// Language detection patterns
export const LanguageDetectionPatterns = {
  'en': /^en/i,
  'zh': /^zh/i,
  'es': /^es/i,
  'hi': /^hi/i,
  'ar': /^ar/i,
  'pt': /^pt/i,
  'bn': /^bn/i,
  'ru': /^ru/i,
  'ja': /^ja/i,
  'de': /^de/i,
  'fr': /^fr/i,
  'it': /^it/i,
  'ko': /^ko/i,
  'tr': /^tr/i,
  'nl': /^nl/i,
  'sv': /^sv/i,
  'da': /^da/i,
  'no': /^no/i,
  'fi': /^fi/i,
  'pl': /^pl/i,
  'th': /^th/i,
  'vi': /^vi/i,
  'id': /^id/i,
  'ms': /^ms/i,
  'tl': /^tl/i,
  'my': /^my/i,
  'km': /^km/i,
  'lo': /^lo/i,
  'ka': /^ka/i,
  'am': /^am/i,
  'he': /^he/i,
  'fa': /^fa/i,
  'ur': /^ur/i,
  'sw': /^sw/i,
  'yo': /^yo/i,
  'ig': /^ig/i,
  'ha': /^ha/i,
  'zu': /^zu/i,
  'af': /^af/i,
  'uk': /^uk/i,
  'be': /^be/i,
  'kk': /^kk/i,
  'uz': /^uz/i,
  'ky': /^ky/i,
  'tg': /^tg/i,
  'mn': /^mn/i,
  'ne': /^ne/i,
  'si': /^si/i,
  'ta': /^ta/i,
  'te': /^te/i,
  'kn': /^kn/i,
  'ml': /^ml/i,
  'gu': /^gu/i,
  'or': /^or/i,
  'as': /^as/i
};

export class I18nManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      defaultLanguage: options.defaultLanguage || DEFAULT_LANGUAGE,
      fallbackLanguage: options.fallbackLanguage || DEFAULT_LANGUAGE,
      autoDetect: options.autoDetect !== false,
      cacheTranslations: options.cacheTranslations !== false,
      loadOnDemand: options.loadOnDemand !== false,
      translationsPath: options.translationsPath || join(__dirname, 'translations'),
      enableInterpolation: options.enableInterpolation !== false,
      enablePluralForms: options.enablePluralForms !== false,
      enableNamespaces: options.enableNamespaces !== false,
      missingKeyHandler: options.missingKeyHandler || this.defaultMissingKeyHandler.bind(this),
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.currentLanguage = this.options.defaultLanguage;
    this.loadedLanguages = new Set();
    this.translationCache = new Map();
    this.missingKeys = new Map();
    this.namespaces = new Map();
    
    // Statistics
    this.stats = {
      translationsLoaded: 0,
      keysRequested: 0,
      keysFound: 0,
      keysMissing: 0,
      cacheHits: 0,
      cacheMisses: 0
    };
    
    // Initialize
    this.initialize();
  }
  
  /**
   * Initialize i18n manager
   */
  async initialize() {
    // Load default language
    await this.loadLanguage(this.options.defaultLanguage);
    
    // Auto-detect language if enabled
    if (this.options.autoDetect) {
      const detectedLanguage = this.detectLanguage();
      if (detectedLanguage && detectedLanguage !== this.options.defaultLanguage) {
        await this.setLanguage(detectedLanguage);
      }
    }
    
    // Load common namespaces
    if (this.options.enableNamespaces) {
      await this.loadNamespace('common');
      await this.loadNamespace('errors');
      await this.loadNamespace('mining');
      await this.loadNamespace('dex');
    }
    
    this.emit('initialized', {
      language: this.currentLanguage,
      supportedLanguages: Object.keys(SupportedLanguages)
    });
  }
  
  /**
   * Detect language from environment
   */
  detectLanguage() {
    // Check environment variables
    const envLang = process.env.LANG || process.env.LANGUAGE || process.env.LC_ALL;
    if (envLang) {
      for (const [code, pattern] of Object.entries(LanguageDetectionPatterns)) {
        if (pattern.test(envLang)) {
          return code;
        }
      }
    }
    
    // Check system locale
    try {
      const locale = Intl.DateTimeFormat().resolvedOptions().locale;
      const langCode = locale.split('-')[0];
      if (SupportedLanguages[langCode]) {
        return langCode;
      }
    } catch (error) {
      // Ignore errors
    }
    
    return this.options.defaultLanguage;
  }
  
  /**
   * Set current language
   */
  async setLanguage(languageCode) {
    if (!SupportedLanguages[languageCode]) {
      throw new OtedamaError(
        `Unsupported language: ${languageCode}`,
        ErrorCategory.VALIDATION,
        { supportedLanguages: Object.keys(SupportedLanguages) }
      );
    }
    
    // Load language if not already loaded
    if (!this.loadedLanguages.has(languageCode)) {
      await this.loadLanguage(languageCode);
    }
    
    const previousLanguage = this.currentLanguage;
    this.currentLanguage = languageCode;
    
    this.emit('language:changed', {
      from: previousLanguage,
      to: languageCode,
      timestamp: Date.now()
    });
  }
  
  /**
   * Load language translations
   */
  async loadLanguage(languageCode) {
    try {
      const translationPath = join(this.options.translationsPath, `${languageCode}.json`);
      
      if (!existsSync(translationPath)) {
        // Create basic translation file
        await this.createBasicTranslationFile(languageCode);
      }
      
      const translations = JSON.parse(readFileSync(translationPath, 'utf8'));
      
      // Store translations in cache
      this.translationCache.set(languageCode, translations);
      this.loadedLanguages.add(languageCode);
      this.stats.translationsLoaded++;
      
      this.emit('language:loaded', {
        language: languageCode,
        keysCount: this.countKeys(translations),
        timestamp: Date.now()
      });
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'i18n',
        category: ErrorCategory.FILE_IO,
        language: languageCode
      });
      
      // Fallback to default language
      if (languageCode !== this.options.fallbackLanguage) {
        await this.loadLanguage(this.options.fallbackLanguage);
      }
    }
  }
  
  /**
   * Create basic translation file
   */
  async createBasicTranslationFile(languageCode) {
    const basicTranslations = {
      common: {
        hello: 'Hello',
        goodbye: 'Goodbye',
        welcome: 'Welcome',
        loading: 'Loading...',
        error: 'Error',
        success: 'Success',
        cancel: 'Cancel',
        confirm: 'Confirm',
        save: 'Save',
        delete: 'Delete',
        edit: 'Edit',
        close: 'Close',
        yes: 'Yes',
        no: 'No'
      },
      mining: {
        hashrate: 'Hashrate',
        difficulty: 'Difficulty',
        shares: 'Shares',
        miners: 'Miners',
        pool: 'Pool',
        reward: 'Reward',
        payout: 'Payout',
        balance: 'Balance',
        stats: 'Statistics',
        connected: 'Connected',
        disconnected: 'Disconnected'
      },
      dex: {
        buy: 'Buy',
        sell: 'Sell',
        trade: 'Trade',
        order: 'Order',
        price: 'Price',
        amount: 'Amount',
        volume: 'Volume',
        market: 'Market',
        limit: 'Limit',
        orderbook: 'Order Book',
        trades: 'Trades',
        history: 'History'
      },
      errors: {
        network: 'Network error',
        database: 'Database error',
        validation: 'Validation error',
        unauthorized: 'Unauthorized',
        forbidden: 'Forbidden',
        notFound: 'Not found',
        serverError: 'Server error',
        timeout: 'Request timeout',
        unavailable: 'Service unavailable'
      }
    };
    
    // Auto-translate for major languages (simplified)
    if (languageCode !== 'en') {
      const translatedContent = await this.autoTranslate(basicTranslations, languageCode);
      if (translatedContent) {
        return translatedContent;
      }
    }
    
    return basicTranslations;
  }
  
  /**
   * Auto-translate content (simplified implementation)
   */
  async autoTranslate(content, targetLanguage) {
    // This is a simplified implementation
    // In a real system, you would integrate with translation APIs
    const translations = {
      'zh': {
        common: {
          hello: '你好',
          goodbye: '再见',
          welcome: '欢迎',
          loading: '加载中...',
          error: '错误',
          success: '成功',
          cancel: '取消',
          confirm: '确认',
          save: '保存',
          delete: '删除',
          edit: '编辑',
          close: '关闭',
          yes: '是',
          no: '否'
        }
      },
      'es': {
        common: {
          hello: 'Hola',
          goodbye: 'Adiós',
          welcome: 'Bienvenido',
          loading: 'Cargando...',
          error: 'Error',
          success: 'Éxito',
          cancel: 'Cancelar',
          confirm: 'Confirmar',
          save: 'Guardar',
          delete: 'Eliminar',
          edit: 'Editar',
          close: 'Cerrar',
          yes: 'Sí',
          no: 'No'
        }
      },
      'ja': {
        common: {
          hello: 'こんにちは',
          goodbye: 'さようなら',
          welcome: 'いらっしゃいませ',
          loading: '読み込み中...',
          error: 'エラー',
          success: '成功',
          cancel: 'キャンセル',
          confirm: '確認',
          save: '保存',
          delete: '削除',
          edit: '編集',
          close: '閉じる',
          yes: 'はい',
          no: 'いいえ'
        }
      }
    };
    
    return translations[targetLanguage] || content;
  }
  
  /**
   * Get translation
   */
  t(key, options = {}) {
    this.stats.keysRequested++;
    
    // Check cache first
    const cacheKey = `${this.currentLanguage}:${key}`;
    if (this.options.cacheTranslations && this.translationCache.has(cacheKey)) {
      this.stats.cacheHits++;
      return this.processTranslation(this.translationCache.get(cacheKey), options);
    }
    
    this.stats.cacheMisses++;
    
    // Get translation from current language
    let translation = this.getTranslationFromLanguage(key, this.currentLanguage);
    
    // Fallback to default language
    if (!translation && this.currentLanguage !== this.options.fallbackLanguage) {
      translation = this.getTranslationFromLanguage(key, this.options.fallbackLanguage);
    }
    
    // Handle missing key
    if (!translation) {
      this.stats.keysMissing++;
      translation = this.handleMissingKey(key, this.currentLanguage);
    } else {
      this.stats.keysFound++;
    }
    
    // Cache the result
    if (this.options.cacheTranslations) {
      this.translationCache.set(cacheKey, translation);
    }
    
    return this.processTranslation(translation, options);
  }
  
  /**
   * Get translation from specific language
   */
  getTranslationFromLanguage(key, languageCode) {
    const translations = this.translationCache.get(languageCode);
    if (!translations) return null;
    
    // Support dot notation for nested keys
    const keys = key.split('.');
    let current = translations;
    
    for (const k of keys) {
      if (current && typeof current === 'object' && k in current) {
        current = current[k];
      } else {
        return null;
      }
    }
    
    return typeof current === 'string' ? current : null;
  }
  
  /**
   * Process translation with interpolation and plural forms
   */
  processTranslation(translation, options) {
    if (!translation) return translation;
    
    let result = translation;
    
    // Handle interpolation
    if (this.options.enableInterpolation && options.interpolation) {
      result = this.interpolate(result, options.interpolation);
    }
    
    // Handle plural forms
    if (this.options.enablePluralForms && options.count !== undefined) {
      result = this.pluralize(result, options.count, this.currentLanguage);
    }
    
    return result;
  }
  
  /**
   * Interpolate variables in translation
   */
  interpolate(text, variables) {
    return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return variables[key] !== undefined ? variables[key] : match;
    });
  }
  
  /**
   * Handle plural forms
   */
  pluralize(text, count, language) {
    // Simplified plural rules
    const pluralRules = {
      'en': (n) => n === 1 ? 0 : 1,
      'zh': (n) => 0, // No plural in Chinese
      'ja': (n) => 0, // No plural in Japanese
      'ru': (n) => {
        if (n % 10 === 1 && n % 100 !== 11) return 0;
        if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 1;
        return 2;
      },
      'ar': (n) => {
        if (n === 0) return 0;
        if (n === 1) return 1;
        if (n === 2) return 2;
        if (n % 100 >= 3 && n % 100 <= 10) return 3;
        if (n % 100 >= 11) return 4;
        return 5;
      }
    };
    
    const rule = pluralRules[language] || pluralRules['en'];
    const forms = text.split('|');
    const index = rule(count);
    
    return forms[index] || forms[0] || text;
  }
  
  /**
   * Handle missing translation key
   */
  handleMissingKey(key, language) {
    // Track missing key
    const missingKey = `${language}:${key}`;
    if (!this.missingKeys.has(missingKey)) {
      this.missingKeys.set(missingKey, {
        key,
        language,
        count: 0,
        firstSeen: Date.now()
      });
    }
    
    const missing = this.missingKeys.get(missingKey);
    missing.count++;
    missing.lastSeen = Date.now();
    
    // Emit missing key event
    this.emit('key:missing', {
      key,
      language,
      count: missing.count,
      timestamp: Date.now()
    });
    
    // Use configured missing key handler
    return this.options.missingKeyHandler(key, language);
  }
  
  /**
   * Default missing key handler
   */
  defaultMissingKeyHandler(key, language) {
    // Return the key itself as fallback
    return key.split('.').pop() || key;
  }
  
  /**
   * Load namespace
   */
  async loadNamespace(namespace) {
    if (this.namespaces.has(namespace)) return;
    
    try {
      const namespacePath = join(this.options.translationsPath, 'namespaces', `${namespace}.json`);
      
      if (existsSync(namespacePath)) {
        const namespaceTranslations = JSON.parse(readFileSync(namespacePath, 'utf8'));
        this.namespaces.set(namespace, namespaceTranslations);
        
        this.emit('namespace:loaded', {
          namespace,
          languages: Object.keys(namespaceTranslations),
          timestamp: Date.now()
        });
      }
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'i18n',
        category: ErrorCategory.FILE_IO,
        namespace
      });
    }
  }
  
  /**
   * Get available languages
   */
  getAvailableLanguages() {
    return Object.keys(SupportedLanguages).map(code => ({
      code,
      ...SupportedLanguages[code],
      loaded: this.loadedLanguages.has(code)
    }));
  }
  
  /**
   * Get current language
   */
  getCurrentLanguage() {
    return {
      code: this.currentLanguage,
      ...SupportedLanguages[this.currentLanguage]
    };
  }
  
  /**
   * Get language direction
   */
  getLanguageDirection(languageCode = this.currentLanguage) {
    return SupportedLanguages[languageCode]?.direction || 'ltr';
  }
  
  /**
   * Get translation statistics
   */
  getStats() {
    return {
      ...this.stats,
      loadedLanguages: Array.from(this.loadedLanguages),
      missingKeysCount: this.missingKeys.size,
      cacheSize: this.translationCache.size,
      currentLanguage: this.currentLanguage
    };
  }
  
  /**
   * Get missing keys report
   */
  getMissingKeysReport() {
    const report = [];
    
    for (const [key, info] of this.missingKeys) {
      report.push({
        key: info.key,
        language: info.language,
        count: info.count,
        firstSeen: info.firstSeen,
        lastSeen: info.lastSeen
      });
    }
    
    return report.sort((a, b) => b.count - a.count);
  }
  
  /**
   * Clear translation cache
   */
  clearCache() {
    this.translationCache.clear();
    this.stats.cacheHits = 0;
    this.stats.cacheMisses = 0;
    
    this.emit('cache:cleared', { timestamp: Date.now() });
  }
  
  /**
   * Count keys in translations object
   */
  countKeys(obj, prefix = '') {
    let count = 0;
    
    for (const key in obj) {
      if (typeof obj[key] === 'object') {
        count += this.countKeys(obj[key], `${prefix}${key}.`);
      } else {
        count++;
      }
    }
    
    return count;
  }
  
  /**
   * Format number according to locale
   */
  formatNumber(number, options = {}) {
    try {
      const locale = this.getLocaleFromLanguage(this.currentLanguage);
      return new Intl.NumberFormat(locale, options).format(number);
    } catch (error) {
      return number.toString();
    }
  }
  
  /**
   * Format date according to locale
   */
  formatDate(date, options = {}) {
    try {
      const locale = this.getLocaleFromLanguage(this.currentLanguage);
      return new Intl.DateTimeFormat(locale, options).format(date);
    } catch (error) {
      return date.toString();
    }
  }
  
  /**
   * Format currency according to locale
   */
  formatCurrency(amount, currency, options = {}) {
    try {
      const locale = this.getLocaleFromLanguage(this.currentLanguage);
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        ...options
      }).format(amount);
    } catch (error) {
      return `${amount} ${currency}`;
    }
  }
  
  /**
   * Get locale from language code
   */
  getLocaleFromLanguage(languageCode) {
    const localeMap = {
      'en': 'en-US',
      'zh': 'zh-CN',
      'es': 'es-ES',
      'hi': 'hi-IN',
      'ar': 'ar-SA',
      'pt': 'pt-BR',
      'bn': 'bn-BD',
      'ru': 'ru-RU',
      'ja': 'ja-JP',
      'de': 'de-DE',
      'fr': 'fr-FR',
      'it': 'it-IT',
      'ko': 'ko-KR',
      'tr': 'tr-TR',
      'nl': 'nl-NL',
      'sv': 'sv-SE',
      'da': 'da-DK',
      'no': 'nb-NO',
      'fi': 'fi-FI',
      'pl': 'pl-PL',
      'th': 'th-TH',
      'vi': 'vi-VN',
      'id': 'id-ID',
      'ms': 'ms-MY',
      'tl': 'tl-PH',
      'my': 'my-MM',
      'km': 'km-KH',
      'lo': 'lo-LA',
      'ka': 'ka-GE',
      'am': 'am-ET',
      'he': 'he-IL',
      'fa': 'fa-IR',
      'ur': 'ur-PK',
      'sw': 'sw-KE',
      'yo': 'yo-NG',
      'ig': 'ig-NG',
      'ha': 'ha-NG',
      'zu': 'zu-ZA',
      'af': 'af-ZA',
      'uk': 'uk-UA',
      'be': 'be-BY',
      'kk': 'kk-KZ',
      'uz': 'uz-UZ',
      'ky': 'ky-KG',
      'tg': 'tg-TJ',
      'mn': 'mn-MN',
      'ne': 'ne-NP',
      'si': 'si-LK',
      'ta': 'ta-IN',
      'te': 'te-IN',
      'kn': 'kn-IN',
      'ml': 'ml-IN',
      'gu': 'gu-IN',
      'or': 'or-IN',
      'as': 'as-IN'
    };
    
    return localeMap[languageCode] || 'en-US';
  }
}

// Global instance
let globalI18n = null;

/**
 * Get global i18n instance
 */
export function getI18n() {
  if (!globalI18n) {
    globalI18n = new I18nManager();
  }
  return globalI18n;
}

/**
 * Initialize global i18n
 */
export async function initI18n(options = {}) {
  globalI18n = new I18nManager(options);
  await globalI18n.initialize();
  return globalI18n;
}

/**
 * Translate function shorthand
 */
export function t(key, options = {}) {
  return getI18n().t(key, options);
}

export default I18nManager;