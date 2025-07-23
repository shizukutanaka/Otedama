/**
 * i18n Middleware
 * Internationalization middleware for Express
 */

const { LanguageManager } = require('./language-manager');
const { createLogger } = require('../core/logger');

const logger = createLogger('i18n-middleware');

/**
 * Create i18n middleware
 */
function createI18nMiddleware(options = {}) {
  // Create language manager instance
  const languageManager = new LanguageManager({
    defaultLanguage: options.defaultLanguage || 'en',
    fallbackLanguage: options.fallbackLanguage || 'en',
    autoDetect: options.autoDetect !== false,
    ...options
  });
  
  // Middleware function
  return async (req, res, next) => {
    try {
      // Detect language from various sources
      let lang = detectLanguage(req, languageManager);
      
      // Set language in manager
      await languageManager.setLanguage(lang);
      
      // Attach to request
      req.language = lang;
      req.languageManager = languageManager;
      
      // Helper functions
      req.__ = req.t = (key, params) => {
        return languageManager.translate(key, params, req.language);
      };
      
      req.__n = req.tn = (key, count, params) => {
        return languageManager.translatePlural(key, count, params, req.language);
      };
      
      // Attach to response locals for views
      res.locals.__ = res.locals.t = req.__;
      res.locals.__n = res.locals.tn = req.__n;
      res.locals.language = lang;
      res.locals.languages = languageManager.getSupportedLanguages();
      res.locals.isRTL = languageManager.isRTL(lang);
      
      // Formatting helpers
      res.locals.formatNumber = (num) => languageManager.formatNumber(num, lang);
      res.locals.formatDate = (date, options) => languageManager.formatDate(date, options, lang);
      res.locals.formatCurrency = (amount, currency) => languageManager.formatCurrency(amount, currency, lang);
      
      // Set content language header
      res.set('Content-Language', lang);
      
      // Set text direction for RTL languages
      if (languageManager.isRTL(lang)) {
        res.set('X-Text-Direction', 'rtl');
      }
      
      next();
    } catch (error) {
      logger.error('i18n middleware error:', error);
      next(error);
    }
  };
}

/**
 * Detect language from request
 */
function detectLanguage(req, languageManager) {
  // Priority order:
  // 1. Query parameter (?lang=xx)
  // 2. Cookie (lang=xx)
  // 3. Session (if available)
  // 4. Accept-Language header
  // 5. System default
  
  // Check query parameter
  if (req.query && req.query.lang) {
    const lang = req.query.lang.toLowerCase();
    if (languageManager.isSupported(lang)) {
      return lang;
    }
  }
  
  // Check cookie
  if (req.cookies && req.cookies.lang) {
    const lang = req.cookies.lang.toLowerCase();
    if (languageManager.isSupported(lang)) {
      return lang;
    }
  }
  
  // Check session
  if (req.session && req.session.lang) {
    const lang = req.session.lang.toLowerCase();
    if (languageManager.isSupported(lang)) {
      return lang;
    }
  }
  
  // Parse Accept-Language header
  const acceptLanguage = req.headers['accept-language'];
  if (acceptLanguage) {
    const languages = parseAcceptLanguage(acceptLanguage);
    
    for (const { code, region } of languages) {
      // Try exact match
      const exact = region ? `${code}-${region}` : code;
      if (languageManager.isSupported(exact)) {
        return exact;
      }
      
      // Try base language
      if (languageManager.isSupported(code)) {
        return code;
      }
      
      // Try to find a variant
      const supportedLangs = Object.keys(languageManager.getSupportedLanguages());
      for (const supported of supportedLangs) {
        if (supported.startsWith(code + '-')) {
          return supported;
        }
      }
    }
  }
  
  // Use system detection as fallback
  return languageManager.detectSystemLanguage();
}

/**
 * Parse Accept-Language header
 */
function parseAcceptLanguage(header) {
  // Example: "en-US,en;q=0.9,es;q=0.8"
  const languages = [];
  
  const parts = header.split(',');
  for (const part of parts) {
    const [lang, qPart] = part.trim().split(';');
    const quality = qPart ? parseFloat(qPart.split('=')[1]) : 1.0;
    
    const [code, region] = lang.toLowerCase().split('-');
    languages.push({
      code,
      region: region ? region.toUpperCase() : null,
      quality
    });
  }
  
  // Sort by quality
  languages.sort((a, b) => b.quality - a.quality);
  
  return languages;
}

/**
 * Language selector middleware
 */
function createLanguageSelector(path = '/api/language') {
  return (req, res) => {
    const lang = req.body.language || req.query.language;
    
    if (!lang) {
      return res.status(400).json({
        error: 'Language parameter required'
      });
    }
    
    if (!req.languageManager.isSupported(lang)) {
      return res.status(400).json({
        error: 'Language not supported',
        supported: Object.keys(req.languageManager.getSupportedLanguages())
      });
    }
    
    // Set cookie
    res.cookie('lang', lang, {
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
      httpOnly: true
    });
    
    // Set in session if available
    if (req.session) {
      req.session.lang = lang;
    }
    
    res.json({
      success: true,
      language: lang,
      languageInfo: req.languageManager.getLanguageInfo(lang)
    });
  };
}

/**
 * Get available languages endpoint
 */
function createLanguagesEndpoint(path = '/api/languages') {
  return (req, res) => {
    const languages = req.languageManager.getSupportedLanguages();
    const current = req.language;
    
    // Format for response
    const formatted = Object.entries(languages).map(([code, info]) => ({
      code,
      name: info.name,
      nativeName: info.nativeName,
      rtl: info.rtl,
      current: code === current
    }));
    
    // Group by regions
    const grouped = {
      popular: [],
      europe: [],
      asia: [],
      middleEast: [],
      africa: [],
      americas: [],
      oceania: [],
      other: []
    };
    
    // Popular languages
    const popular = ['en', 'zh', 'es', 'hi', 'ar', 'pt', 'ru', 'ja', 'de', 'fr'];
    
    formatted.forEach(lang => {
      if (popular.includes(lang.code)) {
        grouped.popular.push(lang);
      }
      
      // Group by region (simplified)
      if (['de', 'fr', 'it', 'es', 'pt', 'nl', 'pl', 'ru', 'uk', 'cs', 'hu', 'ro', 'bg', 'hr', 'sr', 'el', 'tr'].includes(lang.code)) {
        grouped.europe.push(lang);
      } else if (['ja', 'ko', 'zh', 'zh-TW', 'vi', 'th', 'id', 'ms', 'fil', 'my', 'km', 'lo', 'hi', 'bn', 'ta', 'te'].includes(lang.code)) {
        grouped.asia.push(lang);
      } else if (['ar', 'he', 'fa', 'ur', 'ps', 'ku'].includes(lang.code)) {
        grouped.middleEast.push(lang);
      } else if (['sw', 'am', 'ha', 'yo', 'ig', 'zu', 'xh', 'af'].includes(lang.code)) {
        grouped.africa.push(lang);
      } else if (['pt-BR', 'es'].includes(lang.code)) {
        grouped.americas.push(lang);
      } else if (['mi', 'haw', 'sm', 'to', 'fj'].includes(lang.code)) {
        grouped.oceania.push(lang);
      } else {
        grouped.other.push(lang);
      }
    });
    
    res.json({
      current,
      total: formatted.length,
      languages: formatted,
      grouped
    });
  };
}

module.exports = {
  createI18nMiddleware,
  createLanguageSelector,
  createLanguagesEndpoint,
  detectLanguage,
  parseAcceptLanguage
};