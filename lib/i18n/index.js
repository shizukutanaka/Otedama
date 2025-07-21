/**
 * Internationalization (i18n) Module
 * Supports 50 languages for global accessibility
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Supported languages (50 languages)
export const SUPPORTED_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'zh', 'ja', 'ko',
  'ar', 'hi', 'bn', 'pa', 'te', 'mr', 'ta', 'ur', 'gu', 'kn',
  'ml', 'or', 'fa', 'tr', 'pl', 'uk', 'nl', 'sv', 'no', 'da',
  'fi', 'cs', 'hu', 'ro', 'el', 'he', 'id', 'ms', 'vi', 'th',
  'fil', 'my', 'km', 'lo', 'si', 'ne', 'am', 'sw', 'zu', 'yo'
];

// Language names in their native script
export const LANGUAGE_NAMES = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  pt: 'Português',
  ru: 'Русский',
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
  ar: 'العربية',
  hi: 'हिन्दी',
  bn: 'বাংলা',
  pa: 'ਪੰਜਾਬੀ',
  te: 'తెలుగు',
  mr: 'मराठी',
  ta: 'தமிழ்',
  ur: 'اردو',
  gu: 'ગુજરાતી',
  kn: 'ಕನ್ನಡ',
  ml: 'മലയാളം',
  or: 'ଓଡ଼ିଆ',
  fa: 'فارسی',
  tr: 'Türkçe',
  pl: 'Polski',
  uk: 'Українська',
  nl: 'Nederlands',
  sv: 'Svenska',
  no: 'Norsk',
  da: 'Dansk',
  fi: 'Suomi',
  cs: 'Čeština',
  hu: 'Magyar',
  ro: 'Română',
  el: 'Ελληνικά',
  he: 'עברית',
  id: 'Bahasa Indonesia',
  ms: 'Bahasa Melayu',
  vi: 'Tiếng Việt',
  th: 'ไทย',
  fil: 'Filipino',
  my: 'မြန်မာ',
  km: 'ខ្មែរ',
  lo: 'ລາວ',
  si: 'සිංහල',
  ne: 'नेपाली',
  am: 'አማርኛ',
  sw: 'Kiswahili',
  zu: 'isiZulu',
  yo: 'Yorùbá'
};

class I18n {
  constructor() {
    this.translations = new Map();
    this.currentLanguage = 'en';
    this.fallbackLanguage = 'en';
    this.loaded = false;
  }

  /**
   * Initialize i18n with language
   */
  async init(language = 'en') {
    if (!SUPPORTED_LANGUAGES.includes(language)) {
      console.warn(`Language ${language} not supported, falling back to English`);
      language = 'en';
    }

    this.currentLanguage = language;
    await this.loadTranslations(language);
    
    // Always load English as fallback
    if (language !== 'en') {
      await this.loadTranslations('en');
    }
    
    this.loaded = true;
  }

  /**
   * Load translations for a language
   */
  async loadTranslations(language) {
    try {
      const filePath = join(__dirname, 'locales', `${language}.json`);
      const data = await readFile(filePath, 'utf8');
      this.translations.set(language, JSON.parse(data));
    } catch (error) {
      console.error(`Failed to load translations for ${language}:`, error.message);
      
      // Use empty translations if file doesn't exist
      this.translations.set(language, {});
    }
  }

  /**
   * Get translation for key
   */
  t(key, params = {}) {
    // Get translation from current language
    let translation = this.getTranslation(this.currentLanguage, key);
    
    // Fallback to English if not found
    if (!translation && this.currentLanguage !== this.fallbackLanguage) {
      translation = this.getTranslation(this.fallbackLanguage, key);
    }
    
    // Return key if no translation found
    if (!translation) {
      return key;
    }
    
    // Replace parameters
    return this.interpolate(translation, params);
  }

  /**
   * Get translation from language data
   */
  getTranslation(language, key) {
    const translations = this.translations.get(language);
    if (!translations) return null;
    
    // Support nested keys (e.g., "mining.hashrate")
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
   * Interpolate parameters in translation
   */
  interpolate(text, params) {
    return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return params[key] !== undefined ? params[key] : match;
    });
  }

  /**
   * Change current language
   */
  async setLanguage(language) {
    if (!SUPPORTED_LANGUAGES.includes(language)) {
      throw new Error(`Language ${language} not supported`);
    }
    
    if (!this.translations.has(language)) {
      await this.loadTranslations(language);
    }
    
    this.currentLanguage = language;
  }

  /**
   * Get current language
   */
  getLanguage() {
    return this.currentLanguage;
  }

  /**
   * Get all supported languages
   */
  getSupportedLanguages() {
    return SUPPORTED_LANGUAGES.map(code => ({
      code,
      name: LANGUAGE_NAMES[code],
      nativeName: LANGUAGE_NAMES[code]
    }));
  }

  /**
   * Detect user's preferred language
   */
  detectLanguage(acceptLanguageHeader) {
    if (!acceptLanguageHeader) return this.fallbackLanguage;
    
    // Parse Accept-Language header
    const languages = acceptLanguageHeader
      .split(',')
      .map(lang => {
        const [code, q = '1'] = lang.trim().split(';q=');
        return {
          code: code.toLowerCase().split('-')[0],
          quality: parseFloat(q)
        };
      })
      .sort((a, b) => b.quality - a.quality);
    
    // Find first supported language
    for (const { code } of languages) {
      if (SUPPORTED_LANGUAGES.includes(code)) {
        return code;
      }
    }
    
    return this.fallbackLanguage;
  }

  /**
   * Format number according to locale
   */
  formatNumber(value, options = {}) {
    const locale = this.getLocale(this.currentLanguage);
    return new Intl.NumberFormat(locale, options).format(value);
  }

  /**
   * Format currency according to locale
   */
  formatCurrency(value, currency = 'USD') {
    const locale = this.getLocale(this.currentLanguage);
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency
    }).format(value);
  }

  /**
   * Format date according to locale
   */
  formatDate(date, options = {}) {
    const locale = this.getLocale(this.currentLanguage);
    return new Intl.DateTimeFormat(locale, options).format(date);
  }

  /**
   * Format relative time
   */
  formatRelativeTime(date) {
    const locale = this.getLocale(this.currentLanguage);
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    
    const diff = date - new Date();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (Math.abs(days) > 0) return rtf.format(days, 'day');
    if (Math.abs(hours) > 0) return rtf.format(hours, 'hour');
    if (Math.abs(minutes) > 0) return rtf.format(minutes, 'minute');
    return rtf.format(seconds, 'second');
  }

  /**
   * Get locale code for language
   */
  getLocale(language) {
    const localeMap = {
      en: 'en-US',
      es: 'es-ES',
      fr: 'fr-FR',
      de: 'de-DE',
      it: 'it-IT',
      pt: 'pt-BR',
      ru: 'ru-RU',
      zh: 'zh-CN',
      ja: 'ja-JP',
      ko: 'ko-KR',
      ar: 'ar-SA',
      hi: 'hi-IN',
      bn: 'bn-BD',
      pa: 'pa-IN',
      te: 'te-IN',
      mr: 'mr-IN',
      ta: 'ta-IN',
      ur: 'ur-PK',
      gu: 'gu-IN',
      kn: 'kn-IN',
      ml: 'ml-IN',
      or: 'or-IN',
      fa: 'fa-IR',
      tr: 'tr-TR',
      pl: 'pl-PL',
      uk: 'uk-UA',
      nl: 'nl-NL',
      sv: 'sv-SE',
      no: 'no-NO',
      da: 'da-DK',
      fi: 'fi-FI',
      cs: 'cs-CZ',
      hu: 'hu-HU',
      ro: 'ro-RO',
      el: 'el-GR',
      he: 'he-IL',
      id: 'id-ID',
      ms: 'ms-MY',
      vi: 'vi-VN',
      th: 'th-TH',
      fil: 'fil-PH',
      my: 'my-MM',
      km: 'km-KH',
      lo: 'lo-LA',
      si: 'si-LK',
      ne: 'ne-NP',
      am: 'am-ET',
      sw: 'sw-KE',
      zu: 'zu-ZA',
      yo: 'yo-NG'
    };
    
    return localeMap[language] || 'en-US';
  }

  /**
   * Pluralization helper
   */
  plural(count, key, params = {}) {
    const forms = this.t(key);
    
    if (typeof forms !== 'object') {
      return this.interpolate(forms, { count, ...params });
    }
    
    // Simple pluralization rules (can be extended for complex languages)
    let form;
    if (count === 0 && forms.zero) {
      form = forms.zero;
    } else if (count === 1 && forms.one) {
      form = forms.one;
    } else if (count === 2 && forms.two) {
      form = forms.two;
    } else if (count > 2 && count < 5 && forms.few) {
      form = forms.few;
    } else if (forms.many) {
      form = forms.many;
    } else {
      form = forms.other || key;
    }
    
    return this.interpolate(form, { count, ...params });
  }
}

// Create singleton instance
const i18n = new I18n();

// Helper function for translations
export const t = (key, params) => i18n.t(key, params);

export default i18n;