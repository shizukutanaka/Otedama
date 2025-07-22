const { EventEmitter } = require('events');
const crypto = require('crypto');

/**
 * Input Validation System
 * Comprehensive input validation with context-aware rules
 */
class InputValidator extends EventEmitter {
    constructor(config) {
        super();
        this.config = {
            maxRequestSize: config.maxRequestSize || 10 * 1024 * 1024, // 10MB
            maxFieldLength: config.maxFieldLength || 10000,
            maxArrayLength: config.maxArrayLength || 1000,
            allowedMimeTypes: config.allowedMimeTypes || ['application/json', 'text/plain'],
            sqlInjectionPatterns: [
                /(\b(union|select|insert|update|delete|drop|create|alter|exec|execute)\b)/gi,
                /(-{2}|\/\*|\*\/|;|'|")/g,
                /(xp_|sp_|0x[0-9a-f]+)/gi
            ],
            xssPatterns: [
                /<script[^>]*>[\s\S]*?<\/script>/gi,
                /<iframe[^>]*>[\s\S]*?<\/iframe>/gi,
                /javascript:/gi,
                /on\w+\s*=/gi,
                /<embed[^>]*>/gi,
                /<object[^>]*>/gi
            ],
            pathTraversalPatterns: [
                /\.\.[\/\\]/g,
                /^\/etc\//,
                /^\/proc\//,
                /^\/sys\//,
                /^c:\\/i
            ],
            commandInjectionPatterns: [
                /[;&|`$()]/g,
                /\$\{.*\}/g,
                /\$\(.*\)/g
            ],
            ...config
        };
        
        this.validators = new Map();
        this.sanitizers = new Map();
        this.rulesets = new Map();
        
        this.setupDefaultValidators();
        this.setupDefaultSanitizers();
        this.setupDefaultRulesets();
    }
    
    // Setup default validators
    setupDefaultValidators() {
        // String validators
        this.addValidator('minLength', (value, min) => {
            return typeof value === 'string' && value.length >= min;
        });
        
        this.addValidator('maxLength', (value, max) => {
            return typeof value === 'string' && value.length <= max;
        });
        
        this.addValidator('pattern', (value, pattern) => {
            return typeof value === 'string' && new RegExp(pattern).test(value);
        });
        
        this.addValidator('email', (value) => {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            return typeof value === 'string' && emailRegex.test(value);
        });
        
        this.addValidator('url', (value) => {
            try {
                new URL(value);
                return true;
            } catch {
                return false;
            }
        });
        
        // Number validators
        this.addValidator('min', (value, min) => {
            return typeof value === 'number' && value >= min;
        });
        
        this.addValidator('max', (value, max) => {
            return typeof value === 'number' && value <= max;
        });
        
        this.addValidator('integer', (value) => {
            return Number.isInteger(value);
        });
        
        this.addValidator('positive', (value) => {
            return typeof value === 'number' && value > 0;
        });
        
        // Type validators
        this.addValidator('type', (value, type) => {
            if (type === 'array') return Array.isArray(value);
            return typeof value === type;
        });
        
        this.addValidator('enum', (value, allowed) => {
            return allowed.includes(value);
        });
        
        // Security validators
        this.addValidator('noSqlInjection', (value) => {
            if (typeof value !== 'string') return true;
            
            for (const pattern of this.config.sqlInjectionPatterns) {
                if (pattern.test(value)) {
                    return false;
                }
            }
            return true;
        });
        
        this.addValidator('noXss', (value) => {
            if (typeof value !== 'string') return true;
            
            for (const pattern of this.config.xssPatterns) {
                if (pattern.test(value)) {
                    return false;
                }
            }
            return true;
        });
        
        this.addValidator('noPathTraversal', (value) => {
            if (typeof value !== 'string') return true;
            
            for (const pattern of this.config.pathTraversalPatterns) {
                if (pattern.test(value)) {
                    return false;
                }
            }
            return true;
        });
        
        this.addValidator('noCommandInjection', (value) => {
            if (typeof value !== 'string') return true;
            
            for (const pattern of this.config.commandInjectionPatterns) {
                if (pattern.test(value)) {
                    return false;
                }
            }
            return true;
        });
        
        // Bitcoin/crypto validators
        this.addValidator('bitcoinAddress', (value) => {
            if (typeof value !== 'string') return false;
            
            // P2PKH (1...)
            const p2pkh = /^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/;
            // P2SH (3...)
            const p2sh = /^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/;
            // Bech32 (bc1...)
            const bech32 = /^bc1[a-z0-9]{39,59}$/;
            
            return p2pkh.test(value) || p2sh.test(value) || bech32.test(value);
        });
        
        this.addValidator('ethereumAddress', (value) => {
            if (typeof value !== 'string') return false;
            return /^0x[a-fA-F0-9]{40}$/.test(value);
        });
        
        this.addValidator('hash', (value, algorithm = 'sha256') => {
            if (typeof value !== 'string') return false;
            
            const lengths = {
                sha256: 64,
                sha512: 128,
                sha1: 40,
                md5: 32
            };
            
            const len = lengths[algorithm];
            if (!len) return false;
            
            return new RegExp(`^[a-fA-F0-9]{${len}}$`).test(value);
        });
    }
    
    // Setup default sanitizers
    setupDefaultSanitizers() {
        this.addSanitizer('trim', (value) => {
            return typeof value === 'string' ? value.trim() : value;
        });
        
        this.addSanitizer('lowercase', (value) => {
            return typeof value === 'string' ? value.toLowerCase() : value;
        });
        
        this.addSanitizer('uppercase', (value) => {
            return typeof value === 'string' ? value.toUpperCase() : value;
        });
        
        this.addSanitizer('escape', (value) => {
            if (typeof value !== 'string') return value;
            
            return value
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#x27;')
                .replace(/\//g, '&#x2F;');
        });
        
        this.addSanitizer('stripTags', (value) => {
            if (typeof value !== 'string') return value;
            return value.replace(/<[^>]*>/g, '');
        });
        
        this.addSanitizer('normalizeWhitespace', (value) => {
            if (typeof value !== 'string') return value;
            return value.replace(/\s+/g, ' ').trim();
        });
        
        this.addSanitizer('removeNonPrintable', (value) => {
            if (typeof value !== 'string') return value;
            // eslint-disable-next-line no-control-regex
            return value.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
        });
        
        this.addSanitizer('toNumber', (value) => {
            const num = Number(value);
            return isNaN(num) ? 0 : num;
        });
        
        this.addSanitizer('toBoolean', (value) => {
            if (typeof value === 'boolean') return value;
            if (typeof value === 'string') {
                return value.toLowerCase() === 'true' || value === '1';
            }
            return !!value;
        });
    }
    
    // Setup default rulesets
    setupDefaultRulesets() {
        // User input rules
        this.addRuleset('username', {
            validators: [
                { name: 'type', params: ['string'] },
                { name: 'minLength', params: [3] },
                { name: 'maxLength', params: [20] },
                { name: 'pattern', params: ['^[a-zA-Z0-9_]+$'] },
                { name: 'noSqlInjection' }
            ],
            sanitizers: ['trim', 'lowercase']
        });
        
        this.addRuleset('password', {
            validators: [
                { name: 'type', params: ['string'] },
                { name: 'minLength', params: [8] },
                { name: 'maxLength', params: [128] },
                { name: 'pattern', params: ['(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[@$!%*?&])'] }
            ],
            sanitizers: []
        });
        
        this.addRuleset('email', {
            validators: [
                { name: 'type', params: ['string'] },
                { name: 'email' },
                { name: 'maxLength', params: [254] },
                { name: 'noSqlInjection' }
            ],
            sanitizers: ['trim', 'lowercase']
        });
        
        // Mining pool rules
        this.addRuleset('walletAddress', {
            validators: [
                { name: 'type', params: ['string'] },
                { name: 'noSqlInjection' },
                { name: 'noCommandInjection' }
            ],
            sanitizers: ['trim']
        });
        
        this.addRuleset('minerName', {
            validators: [
                { name: 'type', params: ['string'] },
                { name: 'maxLength', params: [50] },
                { name: 'pattern', params: ['^[a-zA-Z0-9._-]+$'] },
                { name: 'noSqlInjection' }
            ],
            sanitizers: ['trim']
        });
        
        this.addRuleset('shareNonce', {
            validators: [
                { name: 'type', params: ['string'] },
                { name: 'pattern', params: ['^[0-9a-fA-F]+$'] },
                { name: 'maxLength', params: [16] }
            ],
            sanitizers: ['trim', 'lowercase']
        });
        
        this.addRuleset('difficulty', {
            validators: [
                { name: 'type', params: ['number'] },
                { name: 'positive' },
                { name: 'max', params: [1000000000] }
            ],
            sanitizers: ['toNumber']
        });
        
        // API rules
        this.addRuleset('apiKey', {
            validators: [
                { name: 'type', params: ['string'] },
                { name: 'pattern', params: ['^[a-zA-Z0-9]{32,64}$'] }
            ],
            sanitizers: ['trim']
        });
        
        this.addRuleset('pagination', {
            page: {
                validators: [
                    { name: 'type', params: ['number'] },
                    { name: 'integer' },
                    { name: 'min', params: [1] }
                ],
                sanitizers: ['toNumber']
            },
            limit: {
                validators: [
                    { name: 'type', params: ['number'] },
                    { name: 'integer' },
                    { name: 'min', params: [1] },
                    { name: 'max', params: [100] }
                ],
                sanitizers: ['toNumber']
            }
        });
    }
    
    // Add custom validator
    addValidator(name, validator) {
        this.validators.set(name, validator);
    }
    
    // Add custom sanitizer
    addSanitizer(name, sanitizer) {
        this.sanitizers.set(name, sanitizer);
    }
    
    // Add ruleset
    addRuleset(name, rules) {
        this.rulesets.set(name, rules);
    }
    
    // Validate single value
    async validateValue(value, rules) {
        const errors = [];
        let sanitizedValue = value;
        
        // Apply sanitizers first
        if (rules.sanitizers) {
            for (const sanitizerName of rules.sanitizers) {
                const sanitizer = this.sanitizers.get(sanitizerName);
                if (sanitizer) {
                    sanitizedValue = sanitizer(sanitizedValue);
                }
            }
        }
        
        // Apply validators
        if (rules.validators) {
            for (const validator of rules.validators) {
                const validatorFn = this.validators.get(validator.name);
                if (!validatorFn) {
                    errors.push(`Unknown validator: ${validator.name}`);
                    continue;
                }
                
                const params = validator.params || [];
                const isValid = await validatorFn(sanitizedValue, ...params);
                
                if (!isValid) {
                    errors.push({
                        validator: validator.name,
                        params: params,
                        value: sanitizedValue
                    });
                }
            }
        }
        
        return {
            valid: errors.length === 0,
            errors,
            value: sanitizedValue
        };
    }
    
    // Validate object
    async validateObject(obj, schema) {
        const results = {};
        const errors = {};
        const sanitized = {};
        let isValid = true;
        
        for (const [field, rules] of Object.entries(schema)) {
            const value = obj[field];
            
            // Check required fields
            if (rules.required && (value === undefined || value === null)) {
                errors[field] = ['Field is required'];
                isValid = false;
                continue;
            }
            
            // Skip optional empty fields
            if (!rules.required && (value === undefined || value === null)) {
                continue;
            }
            
            // Validate nested objects
            if (rules.type === 'object' && rules.schema) {
                const nestedResult = await this.validateObject(value, rules.schema);
                if (!nestedResult.valid) {
                    errors[field] = nestedResult.errors;
                    isValid = false;
                } else {
                    sanitized[field] = nestedResult.data;
                }
                continue;
            }
            
            // Validate arrays
            if (rules.type === 'array' && rules.items) {
                if (!Array.isArray(value)) {
                    errors[field] = ['Must be an array'];
                    isValid = false;
                    continue;
                }
                
                if (value.length > this.config.maxArrayLength) {
                    errors[field] = [`Array too long (max: ${this.config.maxArrayLength})`];
                    isValid = false;
                    continue;
                }
                
                const arrayResults = [];
                const arrayErrors = [];
                
                for (let i = 0; i < value.length; i++) {
                    const itemResult = await this.validateValue(value[i], rules.items);
                    if (!itemResult.valid) {
                        arrayErrors.push({ index: i, errors: itemResult.errors });
                    } else {
                        arrayResults.push(itemResult.value);
                    }
                }
                
                if (arrayErrors.length > 0) {
                    errors[field] = arrayErrors;
                    isValid = false;
                } else {
                    sanitized[field] = arrayResults;
                }
                continue;
            }
            
            // Use predefined ruleset if specified
            if (rules.ruleset) {
                const ruleset = this.rulesets.get(rules.ruleset);
                if (!ruleset) {
                    errors[field] = [`Unknown ruleset: ${rules.ruleset}`];
                    isValid = false;
                    continue;
                }
                rules.validators = ruleset.validators;
                rules.sanitizers = ruleset.sanitizers;
            }
            
            // Validate field
            const result = await this.validateValue(value, rules);
            if (!result.valid) {
                errors[field] = result.errors;
                isValid = false;
            } else {
                sanitized[field] = result.value;
            }
        }
        
        return {
            valid: isValid,
            errors: isValid ? null : errors,
            data: sanitized
        };
    }
    
    // Express middleware
    middleware(schema) {
        return async (req, res, next) => {
            try {
                // Check request size
                const contentLength = parseInt(req.headers['content-length'] || '0');
                if (contentLength > this.config.maxRequestSize) {
                    return res.status(413).json({
                        error: 'Request too large',
                        maxSize: this.config.maxRequestSize
                    });
                }
                
                // Check content type
                const contentType = req.headers['content-type'] || '';
                const mimeType = contentType.split(';')[0].trim();
                
                if (req.method !== 'GET' && req.method !== 'DELETE') {
                    if (!this.config.allowedMimeTypes.includes(mimeType)) {
                        return res.status(415).json({
                            error: 'Unsupported media type',
                            allowed: this.config.allowedMimeTypes
                        });
                    }
                }
                
                // Validate different parts of request
                const validationPromises = [];
                
                if (schema.body && req.body) {
                    validationPromises.push(
                        this.validateObject(req.body, schema.body)
                            .then(result => ({ type: 'body', result }))
                    );
                }
                
                if (schema.query && req.query) {
                    validationPromises.push(
                        this.validateObject(req.query, schema.query)
                            .then(result => ({ type: 'query', result }))
                    );
                }
                
                if (schema.params && req.params) {
                    validationPromises.push(
                        this.validateObject(req.params, schema.params)
                            .then(result => ({ type: 'params', result }))
                    );
                }
                
                if (schema.headers && req.headers) {
                    validationPromises.push(
                        this.validateObject(req.headers, schema.headers)
                            .then(result => ({ type: 'headers', result }))
                    );
                }
                
                // Wait for all validations
                const results = await Promise.all(validationPromises);
                
                // Check results
                const errors = {};
                for (const { type, result } of results) {
                    if (!result.valid) {
                        errors[type] = result.errors;
                    } else {
                        // Replace with sanitized data
                        if (type === 'body') req.body = result.data;
                        else if (type === 'query') req.query = result.data;
                        else if (type === 'params') req.params = result.data;
                    }
                }
                
                if (Object.keys(errors).length > 0) {
                    this.emit('validation-failed', {
                        ip: req.ip,
                        path: req.path,
                        errors
                    });
                    
                    return res.status(400).json({
                        error: 'Validation failed',
                        details: errors
                    });
                }
                
                next();
                
            } catch (error) {
                this.emit('validation-error', error);
                res.status(500).json({
                    error: 'Internal validation error'
                });
            }
        };
    }
    
    // Create schema for common endpoints
    static createSchema() {
        return {
            login: {
                body: {
                    username: { ruleset: 'username', required: true },
                    password: { ruleset: 'password', required: true },
                    totp: {
                        validators: [
                            { name: 'type', params: ['string'] },
                            { name: 'pattern', params: ['^[0-9]{6}$'] }
                        ],
                        sanitizers: ['trim'],
                        required: false
                    }
                }
            },
            
            submitShare: {
                body: {
                    minerId: { ruleset: 'minerName', required: true },
                    jobId: {
                        validators: [
                            { name: 'type', params: ['string'] },
                            { name: 'maxLength', params: [64] }
                        ],
                        sanitizers: ['trim'],
                        required: true
                    },
                    nonce: { ruleset: 'shareNonce', required: true },
                    extraNonce2: {
                        validators: [
                            { name: 'type', params: ['string'] },
                            { name: 'pattern', params: ['^[0-9a-fA-F]+$'] }
                        ],
                        sanitizers: ['trim', 'lowercase'],
                        required: true
                    },
                    ntime: {
                        validators: [
                            { name: 'type', params: ['string'] },
                            { name: 'pattern', params: ['^[0-9a-fA-F]{8}$'] }
                        ],
                        sanitizers: ['trim', 'lowercase'],
                        required: true
                    }
                }
            },
            
            createPayout: {
                body: {
                    address: { ruleset: 'walletAddress', required: true },
                    amount: {
                        validators: [
                            { name: 'type', params: ['number'] },
                            { name: 'positive' },
                            { name: 'max', params: [21000000] } // BTC max supply
                        ],
                        sanitizers: ['toNumber'],
                        required: true
                    },
                    currency: {
                        validators: [
                            { name: 'type', params: ['string'] },
                            { name: 'enum', params: [['BTC', 'ETH', 'LTC']] }
                        ],
                        sanitizers: ['trim', 'uppercase'],
                        required: true
                    }
                }
            }
        };
    }
}

// Rate limiting for input validation
class ValidationRateLimiter {
    constructor(config = {}) {
        this.windowMs = config.windowMs || 60000; // 1 minute
        this.maxFailures = config.maxFailures || 10;
        this.blockDuration = config.blockDuration || 900000; // 15 minutes
        this.failures = new Map();
        this.blocks = new Map();
        
        // Cleanup old entries
        setInterval(() => this.cleanup(), 60000);
    }
    
    recordFailure(identifier) {
        const now = Date.now();
        
        // Check if blocked
        if (this.isBlocked(identifier)) {
            return true;
        }
        
        // Get or create failure record
        let record = this.failures.get(identifier);
        if (!record) {
            record = { count: 0, windowStart: now };
            this.failures.set(identifier, record);
        }
        
        // Reset window if expired
        if (now - record.windowStart > this.windowMs) {
            record.count = 0;
            record.windowStart = now;
        }
        
        // Increment failures
        record.count++;
        
        // Block if threshold exceeded
        if (record.count >= this.maxFailures) {
            this.blocks.set(identifier, now + this.blockDuration);
            this.failures.delete(identifier);
            return true;
        }
        
        return false;
    }
    
    isBlocked(identifier) {
        const blockExpiry = this.blocks.get(identifier);
        if (!blockExpiry) return false;
        
        if (Date.now() > blockExpiry) {
            this.blocks.delete(identifier);
            return false;
        }
        
        return true;
    }
    
    cleanup() {
        const now = Date.now();
        
        // Clean expired blocks
        for (const [id, expiry] of this.blocks) {
            if (now > expiry) {
                this.blocks.delete(id);
            }
        }
        
        // Clean old failure windows
        for (const [id, record] of this.failures) {
            if (now - record.windowStart > this.windowMs * 2) {
                this.failures.delete(id);
            }
        }
    }
}

module.exports = {
    InputValidator,
    ValidationRateLimiter
};