/**
 * Language Manager
 * Supports 100+ languages with automatic detection and fallback
 */

const fs = require('fs').promises;
const path = require('path');
const { createLogger } = require('../core/logger');

const logger = createLogger('language-manager');

// Supported languages (100 languages)
const SUPPORTED_LANGUAGES = {
  // Major Languages
  'en': { name: 'English', nativeName: 'English', rtl: false },
  'zh': { name: 'Chinese (Simplified)', nativeName: '简体中文', rtl: false },
  'zh-TW': { name: 'Chinese (Traditional)', nativeName: '繁體中文', rtl: false },
  'es': { name: 'Spanish', nativeName: 'Español', rtl: false },
  'hi': { name: 'Hindi', nativeName: 'हिन्दी', rtl: false },
  'ar': { name: 'Arabic', nativeName: 'العربية', rtl: true },
  'bn': { name: 'Bengali', nativeName: 'বাংলা', rtl: false },
  'pt': { name: 'Portuguese', nativeName: 'Português', rtl: false },
  'pt-BR': { name: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)', rtl: false },
  'ru': { name: 'Russian', nativeName: 'Русский', rtl: false },
  'ja': { name: 'Japanese', nativeName: '日本語', rtl: false },
  'pa': { name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', rtl: false },
  'de': { name: 'German', nativeName: 'Deutsch', rtl: false },
  'jv': { name: 'Javanese', nativeName: 'Basa Jawa', rtl: false },
  'ko': { name: 'Korean', nativeName: '한국어', rtl: false },
  'fr': { name: 'French', nativeName: 'Français', rtl: false },
  'te': { name: 'Telugu', nativeName: 'తెలుగు', rtl: false },
  'vi': { name: 'Vietnamese', nativeName: 'Tiếng Việt', rtl: false },
  'mr': { name: 'Marathi', nativeName: 'मराठी', rtl: false },
  'ta': { name: 'Tamil', nativeName: 'தமிழ்', rtl: false },
  'ur': { name: 'Urdu', nativeName: 'اردو', rtl: true },
  'tr': { name: 'Turkish', nativeName: 'Türkçe', rtl: false },
  'it': { name: 'Italian', nativeName: 'Italiano', rtl: false },
  'th': { name: 'Thai', nativeName: 'ไทย', rtl: false },
  
  // European Languages
  'pl': { name: 'Polish', nativeName: 'Polski', rtl: false },
  'uk': { name: 'Ukrainian', nativeName: 'Українська', rtl: false },
  'nl': { name: 'Dutch', nativeName: 'Nederlands', rtl: false },
  'el': { name: 'Greek', nativeName: 'Ελληνικά', rtl: false },
  'cs': { name: 'Czech', nativeName: 'Čeština', rtl: false },
  'sv': { name: 'Swedish', nativeName: 'Svenska', rtl: false },
  'hu': { name: 'Hungarian', nativeName: 'Magyar', rtl: false },
  'ro': { name: 'Romanian', nativeName: 'Română', rtl: false },
  'bg': { name: 'Bulgarian', nativeName: 'Български', rtl: false },
  'hr': { name: 'Croatian', nativeName: 'Hrvatski', rtl: false },
  'sk': { name: 'Slovak', nativeName: 'Slovenčina', rtl: false },
  'da': { name: 'Danish', nativeName: 'Dansk', rtl: false },
  'fi': { name: 'Finnish', nativeName: 'Suomi', rtl: false },
  'no': { name: 'Norwegian', nativeName: 'Norsk', rtl: false },
  'sr': { name: 'Serbian', nativeName: 'Српски', rtl: false },
  'lt': { name: 'Lithuanian', nativeName: 'Lietuvių', rtl: false },
  'sl': { name: 'Slovenian', nativeName: 'Slovenščina', rtl: false },
  'lv': { name: 'Latvian', nativeName: 'Latviešu', rtl: false },
  'et': { name: 'Estonian', nativeName: 'Eesti', rtl: false },
  'mk': { name: 'Macedonian', nativeName: 'Македонски', rtl: false },
  'sq': { name: 'Albanian', nativeName: 'Shqip', rtl: false },
  'mt': { name: 'Maltese', nativeName: 'Malti', rtl: false },
  
  // Asian Languages
  'id': { name: 'Indonesian', nativeName: 'Bahasa Indonesia', rtl: false },
  'ms': { name: 'Malay', nativeName: 'Bahasa Melayu', rtl: false },
  'fil': { name: 'Filipino', nativeName: 'Filipino', rtl: false },
  'my': { name: 'Burmese', nativeName: 'မြန်မာဘာသာ', rtl: false },
  'km': { name: 'Khmer', nativeName: 'ភាសាខ្មែរ', rtl: false },
  'lo': { name: 'Lao', nativeName: 'ພາສາລາວ', rtl: false },
  'si': { name: 'Sinhala', nativeName: 'සිංහල', rtl: false },
  'ne': { name: 'Nepali', nativeName: 'नेपाली', rtl: false },
  'mn': { name: 'Mongolian', nativeName: 'Монгол', rtl: false },
  'kk': { name: 'Kazakh', nativeName: 'Қазақша', rtl: false },
  'uz': { name: 'Uzbek', nativeName: 'Oʻzbek', rtl: false },
  'ky': { name: 'Kyrgyz', nativeName: 'Кыргызча', rtl: false },
  'tg': { name: 'Tajik', nativeName: 'Тоҷикӣ', rtl: false },
  'tk': { name: 'Turkmen', nativeName: 'Türkmen', rtl: false },
  
  // Middle Eastern Languages
  'fa': { name: 'Persian', nativeName: 'فارسی', rtl: true },
  'he': { name: 'Hebrew', nativeName: 'עברית', rtl: true },
  'ps': { name: 'Pashto', nativeName: 'پښتو', rtl: true },
  'ku': { name: 'Kurdish', nativeName: 'Kurdî', rtl: false },
  'az': { name: 'Azerbaijani', nativeName: 'Azərbaycan', rtl: false },
  'hy': { name: 'Armenian', nativeName: 'Հայերեն', rtl: false },
  'ka': { name: 'Georgian', nativeName: 'ქართული', rtl: false },
  
  // African Languages
  'sw': { name: 'Swahili', nativeName: 'Kiswahili', rtl: false },
  'yo': { name: 'Yoruba', nativeName: 'Yorùbá', rtl: false },
  'ig': { name: 'Igbo', nativeName: 'Igbo', rtl: false },
  'zu': { name: 'Zulu', nativeName: 'isiZulu', rtl: false },
  'xh': { name: 'Xhosa', nativeName: 'isiXhosa', rtl: false },
  'ha': { name: 'Hausa', nativeName: 'Hausa', rtl: false },
  'am': { name: 'Amharic', nativeName: 'አማርኛ', rtl: false },
  'om': { name: 'Oromo', nativeName: 'Afaan Oromoo', rtl: false },
  'rw': { name: 'Kinyarwanda', nativeName: 'Ikinyarwanda', rtl: false },
  'mg': { name: 'Malagasy', nativeName: 'Malagasy', rtl: false },
  'so': { name: 'Somali', nativeName: 'Soomaali', rtl: false },
  'af': { name: 'Afrikaans', nativeName: 'Afrikaans', rtl: false },
  
  // South Asian Languages
  'gu': { name: 'Gujarati', nativeName: 'ગુજરાતી', rtl: false },
  'kn': { name: 'Kannada', nativeName: 'ಕನ್ನಡ', rtl: false },
  'ml': { name: 'Malayalam', nativeName: 'മലയാളം', rtl: false },
  'or': { name: 'Odia', nativeName: 'ଓଡ଼ିଆ', rtl: false },
  'as': { name: 'Assamese', nativeName: 'অসমীয়া', rtl: false },
  'sd': { name: 'Sindhi', nativeName: 'سنڌي', rtl: true },
  
  // Other Languages
  'ca': { name: 'Catalan', nativeName: 'Català', rtl: false },
  'eu': { name: 'Basque', nativeName: 'Euskara', rtl: false },
  'gl': { name: 'Galician', nativeName: 'Galego', rtl: false },
  'cy': { name: 'Welsh', nativeName: 'Cymraeg', rtl: false },
  'ga': { name: 'Irish', nativeName: 'Gaeilge', rtl: false },
  'gd': { name: 'Scottish Gaelic', nativeName: 'Gàidhlig', rtl: false },
  'is': { name: 'Icelandic', nativeName: 'Íslenska', rtl: false },
  'lb': { name: 'Luxembourgish', nativeName: 'Lëtzebuergesch', rtl: false },
  'eo': { name: 'Esperanto', nativeName: 'Esperanto', rtl: false },
  'la': { name: 'Latin', nativeName: 'Latina', rtl: false },
  'tl': { name: 'Tagalog', nativeName: 'Tagalog', rtl: false },
  'haw': { name: 'Hawaiian', nativeName: 'ʻŌlelo Hawaiʻi', rtl: false },
  'sm': { name: 'Samoan', nativeName: 'Gagana Samoa', rtl: false },
  'to': { name: 'Tongan', nativeName: 'lea faka-Tonga', rtl: false },
  'fj': { name: 'Fijian', nativeName: 'Na Vosa Vakaviti', rtl: false },
  'mi': { name: 'Maori', nativeName: 'Te Reo Māori', rtl: false }
};

// Language families for fallback
const LANGUAGE_FAMILIES = {
  'zh-TW': ['zh', 'en'],
  'pt-BR': ['pt', 'es', 'en'],
  'pa': ['hi', 'ur', 'en'],
  'ur': ['hi', 'ar', 'en'],
  'be': ['ru', 'uk', 'en'],
  'no': ['da', 'sv', 'en'],
  'sr': ['hr', 'bs', 'en'],
  'ms': ['id', 'en'],
  'fil': ['tl', 'en', 'es']
};

class LanguageManager {
  constructor(options = {}) {
    this.options = {
      defaultLanguage: options.defaultLanguage || 'en',
      fallbackLanguage: options.fallbackLanguage || 'en',
      autoDetect: options.autoDetect !== false,
      lazyLoad: options.lazyLoad !== false,
      cacheSize: options.cacheSize || 10,
      translationPath: options.translationPath || path.join(__dirname, 'locales'),
      ...options
    };
    
    this.currentLanguage = this.options.defaultLanguage;
    this.loadedTranslations = new Map();
    this.translationCache = new Map();
    this.loadingPromises = new Map();
    
    logger.info('Language manager initialized', {
      supportedLanguages: Object.keys(SUPPORTED_LANGUAGES).length,
      defaultLanguage: this.options.defaultLanguage
    });
  }
  
  /**
   * Get all supported languages
   */
  getSupportedLanguages() {
    return SUPPORTED_LANGUAGES;
  }
  
  /**
   * Check if language is supported
   */
  isSupported(lang) {
    return SUPPORTED_LANGUAGES.hasOwnProperty(lang);
  }
  
  /**
   * Detect system language
   */
  detectSystemLanguage() {
    // Try environment variables
    const locale = process.env.LANG || 
                  process.env.LANGUAGE || 
                  process.env.LC_ALL || 
                  process.env.LC_MESSAGES || 
                  '';
    
    // Extract language code
    const match = locale.match(/^([a-z]{2,3})(?:[_-]([A-Z]{2}))?/);
    if (match) {
      const lang = match[1];
      const region = match[2];
      
      // Try exact match first
      const exactMatch = region ? `${lang}-${region}` : lang;
      if (this.isSupported(exactMatch)) {
        return exactMatch;
      }
      
      // Try base language
      if (this.isSupported(lang)) {
        return lang;
      }
      
      // Try to find a variant
      for (const code of Object.keys(SUPPORTED_LANGUAGES)) {
        if (code.startsWith(lang + '-')) {
          return code;
        }
      }
    }
    
    // Fallback to system locale on Windows
    if (process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        const output = execSync('powershell Get-Culture | Select-Object -ExpandProperty Name', { 
          encoding: 'utf8' 
        }).trim();
        
        const winLang = output.split('-')[0].toLowerCase();
        if (this.isSupported(winLang)) {
          return winLang;
        }
      } catch (e) {
        // Ignore errors
      }
    }
    
    return this.options.defaultLanguage;
  }
  
  /**
   * Set current language
   */
  async setLanguage(lang) {
    if (!this.isSupported(lang)) {
      logger.warn(`Language ${lang} not supported, falling back to ${this.options.defaultLanguage}`);
      lang = this.options.defaultLanguage;
    }
    
    this.currentLanguage = lang;
    
    // Load translation if not already loaded
    if (!this.loadedTranslations.has(lang)) {
      await this.loadTranslation(lang);
    }
    
    logger.info(`Language set to ${lang}`);
    return lang;
  }
  
  /**
   * Load translation file
   */
  async loadTranslation(lang) {
    // Check if already loading
    if (this.loadingPromises.has(lang)) {
      return this.loadingPromises.get(lang);
    }
    
    const loadPromise = this._loadTranslationFile(lang);
    this.loadingPromises.set(lang, loadPromise);
    
    try {
      const translation = await loadPromise;
      this.loadedTranslations.set(lang, translation);
      
      // Manage cache size
      if (this.loadedTranslations.size > this.options.cacheSize) {
        const firstKey = this.loadedTranslations.keys().next().value;
        if (firstKey !== this.currentLanguage && firstKey !== this.options.fallbackLanguage) {
          this.loadedTranslations.delete(firstKey);
        }
      }
      
      return translation;
    } finally {
      this.loadingPromises.delete(lang);
    }
  }
  
  /**
   * Load translation file from disk
   */
  async _loadTranslationFile(lang) {
    const filePath = path.join(this.options.translationPath, `${lang}.json`);
    
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      // If file doesn't exist, try to generate basic translation
      if (error.code === 'ENOENT') {
        logger.info(`Translation file not found for ${lang}, generating basic translation`);
        return this.generateBasicTranslation(lang);
      }
      
      logger.error(`Failed to load translation for ${lang}:`, error);
      return {};
    }
  }
  
  /**
   * Generate basic translation
   */
  async generateBasicTranslation(lang) {
    // Load English as base
    const enTranslation = await this._loadTranslationFile('en');
    
    // For now, return English translation
    // In production, this could call a translation API
    return enTranslation;
  }
  
  /**
   * Translate key
   */
  translate(key, params = {}, lang = null) {
    lang = lang || this.currentLanguage;
    
    // Try to get translation
    let translation = this.getTranslationValue(lang, key);
    
    // Fallback chain
    if (!translation) {
      const fallbacks = this.getFallbackChain(lang);
      for (const fallbackLang of fallbacks) {
        translation = this.getTranslationValue(fallbackLang, key);
        if (translation) break;
      }
    }
    
    // If still no translation, return key
    if (!translation) {
      return key;
    }
    
    // Replace parameters
    if (typeof translation === 'string') {
      Object.keys(params).forEach(param => {
        translation = translation.replace(
          new RegExp(`{{${param}}}`, 'g'), 
          params[param]
        );
      });
    }
    
    return translation;
  }
  
  /**
   * Get translation value
   */
  getTranslationValue(lang, key) {
    const translations = this.loadedTranslations.get(lang);
    if (!translations) return null;
    
    // Support nested keys
    const keys = key.split('.');
    let value = translations;
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return null;
      }
    }
    
    return value;
  }
  
  /**
   * Get fallback chain for language
   */
  getFallbackChain(lang) {
    const chain = [];
    
    // Add language family fallbacks
    if (LANGUAGE_FAMILIES[lang]) {
      chain.push(...LANGUAGE_FAMILIES[lang]);
    }
    
    // Add base language if this is a variant
    if (lang.includes('-')) {
      const baseLang = lang.split('-')[0];
      if (!chain.includes(baseLang)) {
        chain.push(baseLang);
      }
    }
    
    // Add default fallback
    if (!chain.includes(this.options.fallbackLanguage)) {
      chain.push(this.options.fallbackLanguage);
    }
    
    return chain;
  }
  
  /**
   * Get language info
   */
  getLanguageInfo(lang) {
    return SUPPORTED_LANGUAGES[lang] || null;
  }
  
  /**
   * Check if language is RTL
   */
  isRTL(lang = null) {
    lang = lang || this.currentLanguage;
    const info = this.getLanguageInfo(lang);
    return info ? info.rtl : false;
  }
  
  /**
   * Format number based on locale
   */
  formatNumber(number, lang = null) {
    lang = lang || this.currentLanguage;
    
    try {
      return new Intl.NumberFormat(lang).format(number);
    } catch (e) {
      return number.toString();
    }
  }
  
  /**
   * Format date based on locale
   */
  formatDate(date, options = {}, lang = null) {
    lang = lang || this.currentLanguage;
    
    try {
      return new Intl.DateTimeFormat(lang, options).format(date);
    } catch (e) {
      return date.toString();
    }
  }
  
  /**
   * Format currency
   */
  formatCurrency(amount, currency = 'USD', lang = null) {
    lang = lang || this.currentLanguage;
    
    try {
      return new Intl.NumberFormat(lang, {
        style: 'currency',
        currency: currency
      }).format(amount);
    } catch (e) {
      return `${currency} ${amount}`;
    }
  }
  
  /**
   * Get pluralization rule
   */
  getPluralRule(count, lang = null) {
    lang = lang || this.currentLanguage;
    
    try {
      const pr = new Intl.PluralRules(lang);
      return pr.select(count);
    } catch (e) {
      return count === 1 ? 'one' : 'other';
    }
  }
  
  /**
   * Translate with plural
   */
  translatePlural(key, count, params = {}, lang = null) {
    const rule = this.getPluralRule(count, lang);
    const pluralKey = `${key}.${rule}`;
    
    // Try plural form first
    let translation = this.translate(pluralKey, { ...params, count }, lang);
    
    // Fallback to base key if plural not found
    if (translation === pluralKey) {
      translation = this.translate(key, { ...params, count }, lang);
    }
    
    return translation;
  }
}

// Singleton instance
let instance = null;

module.exports = {
  LanguageManager,
  
  // Get singleton instance
  getInstance(options) {
    if (!instance) {
      instance = new LanguageManager(options);
    }
    return instance;
  },
  
  // Export constants
  SUPPORTED_LANGUAGES,
  LANGUAGE_FAMILIES
};