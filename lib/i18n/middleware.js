/**
 * Enhanced Express i18n Middleware
 * Advanced language detection with context-aware translation
 * Following all design principles for maximum performance and simplicity
 */

import { EnhancedI18nSystem, getEnhancedI18n } from './enhanced-i18n-system.js';
import { SupportedLanguages } from './i18n-manager.js';
import { getErrorHandler, ErrorCategory } from '../error-handler.js';

// Enhanced i18n system instance
let enhancedI18n = null;
const errorHandler = getErrorHandler();

/**
 * Enhanced Express i18n Middleware
 */
export async function i18nMiddleware(req, res, next) {
    try {
        // Initialize enhanced i18n if not already done
        if (!enhancedI18n) {
            enhancedI18n = getEnhancedI18n();
            if (!enhancedI18n.isInitialized) {
                await enhancedI18n.initialize();
            }
        }
        
        // Advanced language detection with multiple sources
        const detectedLanguage = detectLanguageFromRequest(req);
        
        // Build request context
        const context = buildRequestContext(req);
        
        // Set language with context
        if (detectedLanguage !== enhancedI18n.currentLanguage) {
            await enhancedI18n.switchLanguage(detectedLanguage, { source: 'request' });
        }
        
        // Enhanced request object
        req.i18n = enhancedI18n;
        req.locale = detectedLanguage;
        req.context = context;
        
        // Enhanced response helpers
        setupEnhancedResponseHelpers(req, res, enhancedI18n, context);
        
        next();
        
    } catch (error) {
        errorHandler.handleError(error, {
            service: 'i18n-middleware',
            category: ErrorCategory.MIDDLEWARE,
            url: req.url
        });
        
        // Fallback to basic functionality
        setupBasicResponseHelpers(req, res);
        next();
    }
}

/**
 * Detect language from request with multiple sources
 */
function detectLanguageFromRequest(req) {
    // Priority order:
    // 1. Query parameter (?lang=ja)
    // 2. Cookie (lang=ja)
    // 3. Authorization header (user preference)
    // 4. Accept-Language header
    // 5. Default language
    
    // Query parameter
    if (req.query.lang && SupportedLanguages[req.query.lang]) {
        return req.query.lang;
    }
    
    // Cookie
    if (req.cookies?.lang && SupportedLanguages[req.cookies.lang]) {
        return req.cookies.lang;
    }
    
    // User preference from JWT or session
    if (req.user?.preferredLanguage && SupportedLanguages[req.user.preferredLanguage]) {
        return req.user.preferredLanguage;
    }
    
    // Accept-Language header
    if (req.headers['accept-language']) {
        const acceptedLanguages = parseAcceptLanguage(req.headers['accept-language']);
        for (const lang of acceptedLanguages) {
            if (SupportedLanguages[lang]) {
                return lang;
            }
        }
    }
    
    // Default language
    return 'en';
}

/**
 * Build request context for contextual translation
 */
function buildRequestContext(req) {
    const context = {
        // Request context
        path: req.path,
        method: req.method,
        userAgent: req.headers['user-agent'],
        
        // User context
        userId: req.user?.id,
        userRole: req.user?.role,
        subscription: req.user?.subscription,
        
        // Technical context
        platform: detectPlatform(req.headers['user-agent']),
        deviceType: detectDeviceType(req.headers['user-agent']),
        
        // Domain context
        domain: detectDomain(req.path),
        
        // Business context
        feature: detectFeature(req.path),
        action: detectAction(req.method, req.path)
    };
    
    return context;
}

/**
 * Setup enhanced response helpers
 */
function setupEnhancedResponseHelpers(req, res, i18n, context) {
    const availableLanguages = i18n.getAvailableLanguages();
    
    // Enhanced translation helper
    res.locals.t = async (key, options = {}) => {
        return await i18n.t(key, {
            ...context,
            ...options,
            language: req.locale
        });
    };
    
    // Simple translation helper (synchronous)
    res.locals.__ = (key, params = {}) => {
        return i18n.components.i18nManager.t(key, params);
    };
    
    // Context-aware translation
    res.locals.tc = async (key, contextOptions = {}) => {
        return await i18n.t(key, {
            ...context,
            ...contextOptions,
            language: req.locale
        });
    };
    
    // Language metadata
    res.locals.locale = req.locale;
    res.locals.locales = availableLanguages;
    res.locals.languageDirection = i18n.getLanguageDirection();
    
    // Language switching helper
    res.setLocale = async (newLocale, options = {}) => {
        if (SupportedLanguages[newLocale]) {
            await i18n.switchLanguage(newLocale, options);
            
            // Set cookie for persistence
            res.cookie('lang', newLocale, {
                maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
                httpOnly: false,
                sameSite: 'lax',
                secure: req.secure
            });
            
            req.locale = newLocale;
            res.locals.locale = newLocale;
            res.locals.languageDirection = i18n.getLanguageDirection();
        }
    };
    
    // Format helpers
    res.locals.formatNumber = (number, options) => i18n.formatNumber(number, options);
    res.locals.formatDate = (date, options) => i18n.formatDate(date, options);
    res.locals.formatCurrency = (amount, currency, options) => i18n.formatCurrency(amount, currency, options);
    
    // Quality assessment helper (for development)
    if (process.env.NODE_ENV === 'development' && i18n.components.qualityManager) {
        res.locals.assessQuality = async (original, translated) => {
            return await i18n.assessQuality(original, translated, req.locale, context);
        };
    }
}

/**
 * Setup basic response helpers (fallback)
 */
function setupBasicResponseHelpers(req, res) {
    const locale = req.query.lang || req.cookies?.lang || 'en';
    
    res.locals.__ = (key, params = {}) => key; // Fallback to key
    res.locals.locale = locale;
    res.locals.locales = Object.keys(SupportedLanguages);
    res.locals.languageDirection = SupportedLanguages[locale]?.direction || 'ltr';
    
    res.setLocale = (newLocale) => {
        if (SupportedLanguages[newLocale]) {
            res.cookie('lang', newLocale, {
                maxAge: 365 * 24 * 60 * 60 * 1000,
                httpOnly: false,
                sameSite: 'lax'
            });
            req.locale = newLocale;
            res.locals.locale = newLocale;
        }
    };
}

/**
 * Parse Accept-Language header
 */
function parseAcceptLanguage(header) {
    return header
        .split(',')
        .map(lang => {
            const [code, q = '1'] = lang.trim().split(';q=');
            return { code: code.toLowerCase().split('-')[0], quality: parseFloat(q) };
        })
        .sort((a, b) => b.quality - a.quality)
        .map(lang => lang.code);
}

/**
 * Detect platform from user agent
 */
function detectPlatform(userAgent) {
    if (!userAgent) return 'unknown';
    
    const ua = userAgent.toLowerCase();
    if (ua.includes('windows')) return 'windows';
    if (ua.includes('macintosh') || ua.includes('mac os')) return 'macos';
    if (ua.includes('linux')) return 'linux';
    if (ua.includes('android')) return 'android';
    if (ua.includes('iphone') || ua.includes('ipad')) return 'ios';
    
    return 'unknown';
}

/**
 * Detect device type from user agent
 */
function detectDeviceType(userAgent) {
    if (!userAgent) return 'unknown';
    
    const ua = userAgent.toLowerCase();
    if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) return 'mobile';
    if (ua.includes('tablet') || ua.includes('ipad')) return 'tablet';
    
    return 'desktop';
}

/**
 * Detect domain from request path
 */
function detectDomain(path) {
    if (path.startsWith('/api/mining') || path.includes('mining')) return 'mining';
    if (path.startsWith('/api/dex') || path.includes('dex') || path.includes('trade')) return 'dex';
    if (path.startsWith('/api/defi') || path.includes('defi') || path.includes('staking')) return 'defi';
    if (path.startsWith('/api/wallet') || path.includes('wallet')) return 'wallet';
    if (path.startsWith('/api/p2p') || path.includes('p2p')) return 'p2p';
    
    return 'general';
}

/**
 * Detect feature from request path
 */
function detectFeature(path) {
    const segments = path.split('/').filter(Boolean);
    if (segments.length >= 2) {
        return segments[1]; // Usually api/feature
    }
    return 'general';
}

/**
 * Detect action from method and path
 */
function detectAction(method, path) {
    const actions = {
        GET: 'view',
        POST: 'create',
        PUT: 'update',
        PATCH: 'update',
        DELETE: 'delete'
    };
    
    return actions[method] || 'unknown';
}

/**
 * Enhanced API i18n Middleware
 * JSON responses with contextual translation
 */
export async function apiI18nMiddleware(req, res, next) {
    try {
        // Setup enhanced i18n for API
        await i18nMiddleware(req, res, () => {});
        
        // Enhanced API response helpers
        res.sendLocalizedError = async (status, messageKey, params = {}) => {
            const message = await req.i18n.t(messageKey, {
                ...req.context,
                ...params,
                domain: req.context.domain,
                audience: 'api_users'
            });
            
            res.status(status).json({
                error: true,
                message,
                messageKey,
                locale: req.locale,
                context: {
                    domain: req.context.domain,
                    timestamp: Date.now()
                }
            });
        };
        
        res.sendLocalizedSuccess = async (data, messageKey, params = {}) => {
            let message;
            if (messageKey) {
                message = await req.i18n.t(messageKey, {
                    ...req.context,
                    ...params,
                    domain: req.context.domain,
                    audience: 'api_users'
                });
            }
            
            res.json({
                success: true,
                message,
                data,
                locale: req.locale,
                context: {
                    domain: req.context.domain,
                    timestamp: Date.now()
                }
            });
        };
        
        // Context-aware API helpers
        res.sendContextualResponse = async (data, messageKey, contextOverride = {}) => {
            const message = await req.i18n.t(messageKey, {
                ...req.context,
                ...contextOverride
            });
            
            res.json({
                success: true,
                message,
                data,
                locale: req.locale,
                context: {
                    ...req.context,
                    ...contextOverride
                }
            });
        };
        
        next();
        
    } catch (error) {
        errorHandler.handleError(error, {
            service: 'api-i18n-middleware',
            category: ErrorCategory.MIDDLEWARE,
            url: req.url
        });
        next();
    }
}

/**
 * Enhanced WebSocket i18n Helper
 */
export async function wsI18nHelper(ws, locale = 'en', options = {}) {
    const wsI18n = getEnhancedI18n();
    if (!wsI18n.isInitialized) {
        await wsI18n.initialize();
    }
    
    await wsI18n.switchLanguage(locale);
    
    // WebSocketメッセージ送信ヘルパー
    ws.sendLocalized = (type, dataOrKey, params = {}) => {
        let message;
        
        if (typeof dataOrKey === 'string') {
            // 翻訳キーの場合
            message = {
                type,
                message: wsI18n.t(dataOrKey, params),
                locale
            };
        } else {
            // データオブジェクトの場合
            message = {
                type,
                data: dataOrKey,
                locale
            };
        }
        
        ws.send(JSON.stringify(message));
    };
    
    // 言語変更
    ws.setLocale = (newLocale) => {
        if (['ja', 'en', 'zh'].includes(newLocale)) {
            locale = newLocale;
            wsI18n.setLocale(newLocale);
        }
    };
    
    return ws;
}

/**
 * 翻訳キー検証ミドルウェア（開発用）
 */
export function i18nValidationMiddleware(req, res, next) {
    if (process.env.NODE_ENV === 'development') {
        const originalT = req.i18n.t;
        const missingKeys = new Set();
        
        req.i18n.t = (key, params) => {
            const result = originalT.call(req.i18n, key, params);
            if (result === key) {
                missingKeys.add(key);
            }
            return result;
        };
        
        // レスポンス送信時に警告
        const originalSend = res.send;
        res.send = function(...args) {
            if (missingKeys.size > 0) {
                console.warn(`⚠️ Missing translation keys for locale '${req.locale}':`, 
                    Array.from(missingKeys));
            }
            return originalSend.apply(res, args);
        };
    }
    
    next();
}

/**
 * 言語切り替えルート
 */
export function languageRoutes(router) {
    // 言語切り替えAPI
    router.post('/api/language', (req, res) => {
        const { locale } = req.body;
        
        if (!locale || !['ja', 'en', 'zh'].includes(locale)) {
            return res.sendLocalizedError(400, 'errors.invalidInput');
        }
        
        res.setLocale(locale);
        res.sendLocalizedSuccess({ locale }, 'common.success');
    });
    
    // 現在の言語取得
    router.get('/api/language', (req, res) => {
        res.json({
            current: req.locale,
            available: [
                { code: 'ja', name: '日本語' },
                { code: 'en', name: 'English' },
                { code: 'zh', name: '中文' }
            ]
        });
    });
    
    // 翻訳リソース取得
    router.get('/api/translations/:locale', async (req, res) => {
        const { locale } = req.params;
        
        if (!['ja', 'en', 'zh'].includes(locale)) {
            return res.sendLocalizedError(400, 'errors.invalidInput');
        }
        
        try {
            const translations = await i18n.loadLocale(locale);
            res.json(translations);
        } catch (error) {
            res.sendLocalizedError(500, 'errors.general');
        }
    });
}

// テンプレートエンジン用ヘルパー登録
export function registerTemplateHelpers(app) {
    // EJS
    if (app.get('view engine') === 'ejs') {
        app.locals.__ = function(key, params) {
            return this.req.i18n.t(key, params);
        };
    }
    
    // Pug
    if (app.get('view engine') === 'pug') {
        app.locals.t = function(key, params) {
            return this.req.i18n.t(key, params);
        };
    }
    
    // Handlebars
    if (app.get('view engine') === 'hbs' || app.get('view engine') === 'handlebars') {
        const hbs = app.get('view engine') === 'hbs' ? 
            require('hbs') : require('express-handlebars');
            
        hbs.registerHelper('t', function(key, options) {
            return options.data.root.__.call(this, key, options.hash);
        });
        
        hbs.registerHelper('tn', function(key, count, options) {
            return options.data.root.__n.call(this, key, count, options.hash);
        });
    }
}

// エクスポート
export default {
    i18nMiddleware,
    apiI18nMiddleware,
    wsI18nHelper,
    i18nValidationMiddleware,
    languageRoutes,
    registerTemplateHelpers
};