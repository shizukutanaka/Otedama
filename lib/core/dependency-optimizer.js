const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs').promises;

/**
 * 依存関係最適化システム
 */
class DependencyOptimizer extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            autoInstall: config.autoInstall || false,
            checkInterval: config.checkInterval || 3600000, // 1時間
            cacheDir: config.cacheDir || './cache/modules',
            ...config
        };
        
        this.requiredModules = new Map();
        this.optionalModules = new Map();
        this.loadedModules = new Map();
        this.moduleStats = new Map();
        
        this.initializeModules();
    }
    
    /**
     * モジュールを初期化
     */
    initializeModules() {
        // 必須モジュール
        this.requiredModules.set('express', {
            version: '^4.18.2',
            purpose: 'Web framework for API endpoints',
            alternatives: []
        });
        
        this.requiredModules.set('ws', {
            version: '^8.14.2',
            purpose: 'WebSocket server for real-time communication',
            alternatives: []
        });
        
        this.requiredModules.set('better-sqlite3', {
            version: '^9.2.2',
            purpose: 'High-performance SQLite database',
            alternatives: ['sqlite3']
        });
        
        // オプショナルモジュール
        this.optionalModules.set('ioredis', {
            version: '^5.3.2',
            purpose: 'Redis client for distributed caching',
            fallback: 'in-memory'
        });
        
        this.optionalModules.set('validator', {
            version: '^13.11.0',
            purpose: 'Input validation and sanitization',
            fallback: 'basic'
        });
        
        this.optionalModules.set('compression', {
            version: '^1.7.4',
            purpose: 'HTTP response compression',
            fallback: 'none'
        });
        
        this.optionalModules.set('helmet', {
            version: '^7.1.0',
            purpose: 'Security headers middleware',
            fallback: 'basic'
        });
        
        this.optionalModules.set('cors', {
            version: '^2.8.5',
            purpose: 'CORS middleware',
            fallback: 'basic'
        });
        
        this.optionalModules.set('rate-limiter-flexible', {
            version: '^3.0.0',
            purpose: 'Advanced rate limiting',
            fallback: 'basic'
        });
        
        this.optionalModules.set('winston', {
            version: '^3.11.0',
            purpose: 'Advanced logging',
            fallback: 'console'
        });
        
        this.optionalModules.set('prom-client', {
            version: '^15.0.0',
            purpose: 'Prometheus metrics',
            fallback: 'basic'
        });
    }
    
    /**
     * モジュールの遅延読み込み
     */
    async loadModule(moduleName, options = {}) {
        // キャッシュから取得
        if (this.loadedModules.has(moduleName)) {
            this.updateModuleStats(moduleName, 'cache-hit');
            return this.loadedModules.get(moduleName);
        }
        
        try {
            // モジュールを読み込み
            const module = require(moduleName);
            this.loadedModules.set(moduleName, module);
            this.updateModuleStats(moduleName, 'loaded');
            
            this.emit('module-loaded', { moduleName });
            return module;
            
        } catch (error) {
            // オプショナルモジュールの場合はフォールバック
            if (this.optionalModules.has(moduleName)) {
                const moduleInfo = this.optionalModules.get(moduleName);
                this.updateModuleStats(moduleName, 'fallback');
                
                this.emit('module-fallback', {
                    moduleName,
                    fallback: moduleInfo.fallback,
                    error: error.message
                });
                
                return this.createFallback(moduleName, moduleInfo.fallback);
            }
            
            // 必須モジュールの場合はエラー
            this.emit('module-error', { moduleName, error });
            throw error;
        }
    }
    
    /**
     * フォールバック実装を作成
     */
    createFallback(moduleName, fallbackType) {
        switch (moduleName) {
            case 'ioredis':
                return this.createMemoryCache();
                
            case 'validator':
                return this.createBasicValidator();
                
            case 'compression':
                return (req, res, next) => next();
                
            case 'helmet':
                return this.createBasicSecurityHeaders();
                
            case 'cors':
                return this.createBasicCors();
                
            case 'rate-limiter-flexible':
                return this.createBasicRateLimiter();
                
            case 'winston':
                return this.createConsoleLogger();
                
            case 'prom-client':
                return this.createBasicMetrics();
                
            default:
                return null;
        }
    }
    
    /**
     * メモリキャッシュのフォールバック
     */
    createMemoryCache() {
        const cache = new Map();
        const ttlMap = new Map();
        
        return {
            async get(key) {
                const ttl = ttlMap.get(key);
                if (ttl && Date.now() > ttl) {
                    cache.delete(key);
                    ttlMap.delete(key);
                    return null;
                }
                return cache.get(key);
            },
            
            async set(key, value, ttlSeconds) {
                cache.set(key, value);
                if (ttlSeconds) {
                    ttlMap.set(key, Date.now() + ttlSeconds * 1000);
                }
                return 'OK';
            },
            
            async del(key) {
                cache.delete(key);
                ttlMap.delete(key);
                return 1;
            },
            
            async setex(key, ttlSeconds, value) {
                return this.set(key, value, ttlSeconds);
            }
        };
    }
    
    /**
     * 基本的なバリデーター
     */
    createBasicValidator() {
        return {
            isEmail(value) {
                return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
            },
            
            isURL(value) {
                try {
                    new URL(value);
                    return true;
                } catch {
                    return false;
                }
            },
            
            isAlphanumeric(value) {
                return /^[a-zA-Z0-9]+$/.test(value);
            },
            
            isNumeric(value) {
                return !isNaN(value) && !isNaN(parseFloat(value));
            },
            
            isInt(value) {
                return Number.isInteger(Number(value));
            },
            
            isUUID(value) {
                return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
            },
            
            isIP(value) {
                return /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(value) ||
                       /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/.test(value);
            },
            
            escape(value) {
                return String(value)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#x27;')
                    .replace(/\//g, '&#x2F;');
            },
            
            normalizeEmail(email) {
                return email.toLowerCase().trim();
            }
        };
    }
    
    /**
     * 基本的なセキュリティヘッダー
     */
    createBasicSecurityHeaders() {
        return (req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('X-XSS-Protection', '1; mode=block');
            res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
            res.setHeader('Content-Security-Policy', "default-src 'self'");
            next();
        };
    }
    
    /**
     * 基本的なCORS
     */
    createBasicCors() {
        return (req, res, next) => {
            const origin = req.headers.origin;
            
            // 設定可能なオリジンリスト
            const allowedOrigins = this.config.allowedOrigins || ['http://localhost:3000'];
            
            if (allowedOrigins.includes(origin)) {
                res.setHeader('Access-Control-Allow-Origin', origin);
            }
            
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            res.setHeader('Access-Control-Max-Age', '86400');
            
            if (req.method === 'OPTIONS') {
                res.sendStatus(204);
            } else {
                next();
            }
        };
    }
    
    /**
     * 基本的なレート制限
     */
    createBasicRateLimiter() {
        const limits = new Map();
        
        return {
            consume: async (key, points = 1) => {
                const now = Date.now();
                const windowMs = 60000; // 1分
                const maxPoints = 100;
                
                const userLimits = limits.get(key) || { points: 0, resetTime: now + windowMs };
                
                if (now > userLimits.resetTime) {
                    userLimits.points = 0;
                    userLimits.resetTime = now + windowMs;
                }
                
                if (userLimits.points + points > maxPoints) {
                    throw new Error('Rate limit exceeded');
                }
                
                userLimits.points += points;
                limits.set(key, userLimits);
                
                return {
                    remainingPoints: maxPoints - userLimits.points,
                    msBeforeNext: userLimits.resetTime - now
                };
            }
        };
    }
    
    /**
     * コンソールロガー
     */
    createConsoleLogger() {
        const levels = {
            error: 0,
            warn: 1,
            info: 2,
            debug: 3
        };
        
        return {
            log(level, message, meta = {}) {
                const timestamp = new Date().toISOString();
                const output = `[${timestamp}] ${level.toUpperCase()}: ${message}`;
                
                if (Object.keys(meta).length > 0) {
                    console.log(output, meta);
                } else {
                    console.log(output);
                }
            },
            
            error(message, meta) {
                this.log('error', message, meta);
            },
            
            warn(message, meta) {
                this.log('warn', message, meta);
            },
            
            info(message, meta) {
                this.log('info', message, meta);
            },
            
            debug(message, meta) {
                this.log('debug', message, meta);
            }
        };
    }
    
    /**
     * 基本的なメトリクス
     */
    createBasicMetrics() {
        const metrics = new Map();
        
        return {
            Counter: class {
                constructor(config) {
                    this.name = config.name;
                    this.help = config.help;
                    this.value = 0;
                    metrics.set(this.name, this);
                }
                
                inc(value = 1) {
                    this.value += value;
                }
                
                reset() {
                    this.value = 0;
                }
            },
            
            Gauge: class {
                constructor(config) {
                    this.name = config.name;
                    this.help = config.help;
                    this.value = 0;
                    metrics.set(this.name, this);
                }
                
                set(value) {
                    this.value = value;
                }
                
                inc(value = 1) {
                    this.value += value;
                }
                
                dec(value = 1) {
                    this.value -= value;
                }
            },
            
            Histogram: class {
                constructor(config) {
                    this.name = config.name;
                    this.help = config.help;
                    this.values = [];
                    metrics.set(this.name, this);
                }
                
                observe(value) {
                    this.values.push(value);
                }
                
                reset() {
                    this.values = [];
                }
            },
            
            register: {
                metrics() {
                    const result = [];
                    for (const [name, metric] of metrics) {
                        result.push({
                            name,
                            help: metric.help,
                            value: metric.value || metric.values
                        });
                    }
                    return result;
                }
            }
        };
    }
    
    /**
     * モジュール統計を更新
     */
    updateModuleStats(moduleName, event) {
        if (!this.moduleStats.has(moduleName)) {
            this.moduleStats.set(moduleName, {
                loadCount: 0,
                cacheHits: 0,
                fallbacks: 0,
                errors: 0,
                lastAccess: null
            });
        }
        
        const stats = this.moduleStats.get(moduleName);
        stats.lastAccess = Date.now();
        
        switch (event) {
            case 'loaded':
                stats.loadCount++;
                break;
            case 'cache-hit':
                stats.cacheHits++;
                break;
            case 'fallback':
                stats.fallbacks++;
                break;
            case 'error':
                stats.errors++;
                break;
        }
    }
    
    /**
     * 統計情報を取得
     */
    getStats() {
        const stats = {
            required: {},
            optional: {},
            loaded: this.loadedModules.size,
            moduleStats: {}
        };
        
        // 必須モジュールの状態
        for (const [name, info] of this.requiredModules) {
            stats.required[name] = {
                loaded: this.loadedModules.has(name),
                purpose: info.purpose
            };
        }
        
        // オプショナルモジュールの状態
        for (const [name, info] of this.optionalModules) {
            stats.optional[name] = {
                loaded: this.loadedModules.has(name),
                purpose: info.purpose,
                usingFallback: this.moduleStats.has(name) && 
                              this.moduleStats.get(name).fallbacks > 0
            };
        }
        
        // モジュール統計
        for (const [name, stat] of this.moduleStats) {
            stats.moduleStats[name] = stat;
        }
        
        return stats;
    }
    
    /**
     * 必要なモジュールをチェック
     */
    async checkRequiredModules() {
        const missing = [];
        
        for (const [moduleName, info] of this.requiredModules) {
            try {
                require.resolve(moduleName);
            } catch (error) {
                missing.push({
                    name: moduleName,
                    version: info.version,
                    purpose: info.purpose
                });
            }
        }
        
        if (missing.length > 0) {
            this.emit('missing-modules', { required: missing });
        }
        
        return missing;
    }
    
    /**
     * クリーンアップ
     */
    cleanup() {
        this.loadedModules.clear();
        this.moduleStats.clear();
        this.removeAllListeners();
    }
}

module.exports = DependencyOptimizer;