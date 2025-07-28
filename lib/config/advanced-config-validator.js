const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const yaml = require('js-yaml');
const Ajv = require('ajv');

class AdvancedConfigValidator extends EventEmitter {
    constructor() {
        super();
        this.ajv = new Ajv({ allErrors: true, useDefaults: true });
        this.configCache = new Map();
        this.validationHistory = [];
        this.maxHistorySize = 100;
        
        this.schemas = {
            mining: {
                type: 'object',
                required: ['algorithm', 'pool'],
                properties: {
                    algorithm: {
                        type: 'string',
                        enum: ['sha256', 'scrypt', 'ethash', 'kawpow', 'randomx', 'cryptonight'],
                        description: 'Mining algorithm to use'
                    },
                    intensity: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 100,
                        default: 80,
                        description: 'Mining intensity percentage'
                    },
                    threads: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 256,
                        default: 0,
                        description: 'Number of mining threads (0 for auto)'
                    },
                    pool: {
                        type: 'object',
                        required: ['url', 'username'],
                        properties: {
                            url: {
                                type: 'string',
                                pattern: '^(stratum\\+tcp|stratum\\+ssl|http|https):\\/\\/.+',
                                description: 'Pool connection URL'
                            },
                            username: {
                                type: 'string',
                                minLength: 1,
                                description: 'Pool username or wallet address'
                            },
                            password: {
                                type: 'string',
                                default: 'x',
                                description: 'Pool password'
                            },
                            fallbackPools: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    required: ['url', 'username'],
                                    properties: {
                                        url: { type: 'string', pattern: '^(stratum\\+tcp|stratum\\+ssl|http|https):\\/\\/.+' },
                                        username: { type: 'string', minLength: 1 },
                                        password: { type: 'string', default: 'x' }
                                    }
                                },
                                maxItems: 10,
                                description: 'Backup pools for failover'
                            }
                        }
                    },
                    wallet: {
                        type: 'object',
                        properties: {
                            address: {
                                type: 'string',
                                pattern: '^[a-zA-Z0-9]{26,}$',
                                description: 'Wallet address for payouts'
                            },
                            paymentThreshold: {
                                type: 'number',
                                minimum: 0.0001,
                                default: 0.01,
                                description: 'Minimum payout threshold'
                            }
                        }
                    }
                }
            },
            hardware: {
                type: 'object',
                properties: {
                    gpu: {
                        type: 'object',
                        properties: {
                            enabled: { type: 'boolean', default: true },
                            devices: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        id: { type: 'integer', minimum: 0 },
                                        enabled: { type: 'boolean', default: true },
                                        temperatureLimit: { type: 'integer', minimum: 40, maximum: 95, default: 85 },
                                        powerLimit: { type: 'integer', minimum: 50, maximum: 150, default: 100 },
                                        memoryOverclock: { type: 'integer', minimum: -1000, maximum: 3000, default: 0 },
                                        coreOverclock: { type: 'integer', minimum: -500, maximum: 500, default: 0 },
                                        fanSpeed: { type: 'integer', minimum: 0, maximum: 100 }
                                    }
                                }
                            },
                            temperatureTarget: { type: 'integer', minimum: 50, maximum: 85, default: 70 },
                            autoTune: { type: 'boolean', default: true }
                        }
                    },
                    cpu: {
                        type: 'object',
                        properties: {
                            enabled: { type: 'boolean', default: false },
                            threads: { 
                                oneOf: [
                                    { type: 'integer', minimum: 1 },
                                    { type: 'string', const: 'auto' }
                                ],
                                default: 'auto'
                            },
                            affinity: { type: 'string', pattern: '^[0-9,\\-]+$' },
                            priority: { type: 'integer', minimum: 0, maximum: 5, default: 2 }
                        }
                    },
                    asic: {
                        type: 'object',
                        properties: {
                            enabled: { type: 'boolean', default: false },
                            devices: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    required: ['type', 'serial'],
                                    properties: {
                                        type: { type: 'string' },
                                        serial: { type: 'string' },
                                        frequency: { type: 'integer', minimum: 100, maximum: 2000 }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            monitoring: {
                type: 'object',
                properties: {
                    enabled: { type: 'boolean', default: true },
                    interval: { type: 'integer', minimum: 5, maximum: 3600, default: 60 },
                    webPort: { type: 'integer', minimum: 1024, maximum: 65535, default: 8080 },
                    apiEnabled: { type: 'boolean', default: true },
                    metrics: {
                        type: 'object',
                        properties: {
                            hashrate: { type: 'boolean', default: true },
                            temperature: { type: 'boolean', default: true },
                            power: { type: 'boolean', default: true },
                            shares: { type: 'boolean', default: true },
                            earnings: { type: 'boolean', default: true },
                            network: { type: 'boolean', default: true }
                        }
                    },
                    alerts: {
                        type: 'object',
                        properties: {
                            enabled: { type: 'boolean', default: true },
                            email: { type: 'string', format: 'email' },
                            webhook: { type: 'string', format: 'uri' },
                            conditions: {
                                type: 'object',
                                properties: {
                                    lowHashrate: { type: 'number', minimum: 0 },
                                    highTemperature: { type: 'integer', minimum: 60, maximum: 100 },
                                    deviceOffline: { type: 'boolean', default: true },
                                    poolDisconnected: { type: 'boolean', default: true }
                                }
                            }
                        }
                    }
                }
            },
            profitSwitching: {
                type: 'object',
                properties: {
                    enabled: { type: 'boolean', default: false },
                    checkInterval: { type: 'integer', minimum: 60, maximum: 7200, default: 300 },
                    minProfitThreshold: { type: 'number', minimum: 0, maximum: 100, default: 5 },
                    switchingDelay: { type: 'integer', minimum: 0, maximum: 3600, default: 60 },
                    supportedCoins: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['symbol', 'algorithm'],
                            properties: {
                                symbol: { type: 'string', minLength: 2, maxLength: 10 },
                                algorithm: { type: 'string' },
                                pools: { type: 'array', items: { type: 'object' } }
                            }
                        }
                    },
                    excludeCoins: { type: 'array', items: { type: 'string' } },
                    strategy: {
                        type: 'string',
                        enum: ['conservative', 'balanced', 'aggressive', 'custom'],
                        default: 'balanced'
                    }
                }
            },
            security: {
                type: 'object',
                properties: {
                    apiKey: { type: 'string', minLength: 32 },
                    apiSecret: { type: 'string', minLength: 64 },
                    tls: {
                        type: 'object',
                        properties: {
                            enabled: { type: 'boolean', default: true },
                            cert: { type: 'string' },
                            key: { type: 'string' },
                            ca: { type: 'string' },
                            rejectUnauthorized: { type: 'boolean', default: true }
                        }
                    },
                    authentication: {
                        type: 'object',
                        properties: {
                            type: { type: 'string', enum: ['none', 'basic', 'jwt', 'oauth2'], default: 'basic' },
                            users: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    required: ['username', 'passwordHash'],
                                    properties: {
                                        username: { type: 'string', minLength: 3 },
                                        passwordHash: { type: 'string', minLength: 60 },
                                        role: { type: 'string', enum: ['admin', 'user', 'viewer'], default: 'user' }
                                    }
                                }
                            }
                        }
                    },
                    whitelist: {
                        type: 'array',
                        items: {
                            type: 'string',
                            anyOf: [
                                { pattern: '^(\\d{1,3}\\.){3}\\d{1,3}$' },
                                { pattern: '^(\\d{1,3}\\.){3}\\d{1,3}\\/\\d{1,2}$' }
                            ]
                        }
                    },
                    rateLimit: {
                        type: 'object',
                        properties: {
                            enabled: { type: 'boolean', default: true },
                            maxRequests: { type: 'integer', minimum: 1, default: 100 },
                            windowMs: { type: 'integer', minimum: 1000, default: 60000 }
                        }
                    }
                }
            },
            advanced: {
                type: 'object',
                properties: {
                    logLevel: { type: 'string', enum: ['error', 'warn', 'info', 'debug'], default: 'info' },
                    logFile: { type: 'string' },
                    database: {
                        type: 'object',
                        properties: {
                            type: { type: 'string', enum: ['sqlite', 'mysql', 'postgresql'], default: 'sqlite' },
                            connectionString: { type: 'string' },
                            poolSize: { type: 'integer', minimum: 1, maximum: 100, default: 10 }
                        }
                    },
                    clustering: {
                        type: 'object',
                        properties: {
                            enabled: { type: 'boolean', default: false },
                            workers: { type: 'integer', minimum: 1, maximum: 64, default: 0 },
                            masterPort: { type: 'integer', minimum: 1024, maximum: 65535 }
                        }
                    },
                    experimental: {
                        type: 'object',
                        properties: {
                            quantumResistant: { type: 'boolean', default: false },
                            aiOptimization: { type: 'boolean', default: false },
                            distributedValidation: { type: 'boolean', default: false }
                        }
                    }
                }
            }
        };
        
        this.initializeValidators();
    }

    initializeValidators() {
        for (const [key, schema] of Object.entries(this.schemas)) {
            this.ajv.addSchema(schema, key);
        }
        
        // Add custom formats
        this.ajv.addFormat('wallet-address', {
            validate: (address) => /^[a-zA-Z0-9]{26,}$/.test(address)
        });
        
        this.ajv.addFormat('mining-url', {
            validate: (url) => /^(stratum\+tcp|stratum\+ssl|http|https):\/\/.+/.test(url)
        });
    }

    async validateConfig(config, options = {}) {
        const startTime = Date.now();
        const errors = [];
        const warnings = [];
        const validated = {};
        
        try {
            // Validate each section
            for (const [section, schema] of Object.entries(this.schemas)) {
                if (config[section]) {
                    const validate = this.ajv.getSchema(section);
                    const valid = validate(config[section]);
                    
                    if (valid) {
                        validated[section] = config[section];
                    } else {
                        errors.push(...validate.errors.map(err => ({
                            path: `${section}${err.instancePath}`,
                            message: err.message,
                            params: err.params
                        })));
                    }
                }
            }
            
            // Cross-section validation
            this.performCrossValidation(validated, errors, warnings);
            
            // Security checks
            this.performSecurityChecks(validated, warnings);
            
            // Performance recommendations
            if (options.includeRecommendations) {
                this.addPerformanceRecommendations(validated, warnings);
            }
            
            const validationResult = {
                valid: errors.length === 0,
                errors,
                warnings,
                config: validated,
                timestamp: new Date().toISOString(),
                duration: Date.now() - startTime
            };
            
            // Store in history
            this.addToHistory(validationResult);
            
            this.emit('validation', validationResult);
            
            if (!validationResult.valid) {
                throw new ValidationError('Configuration validation failed', errors);
            }
            
            return validationResult;
            
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    performCrossValidation(config, errors, warnings) {
        // Check algorithm compatibility
        if (config.mining?.algorithm && config.hardware?.gpu?.enabled) {
            const gpuAlgorithms = ['ethash', 'kawpow', 'progpow'];
            if (!gpuAlgorithms.includes(config.mining.algorithm)) {
                warnings.push({
                    path: 'mining.algorithm',
                    message: `Algorithm ${config.mining.algorithm} may not be optimal for GPU mining`
                });
            }
        }
        
        // Check CPU mining settings
        if (config.mining?.algorithm === 'randomx' && !config.hardware?.cpu?.enabled) {
            warnings.push({
                path: 'hardware.cpu.enabled',
                message: 'RandomX algorithm is optimized for CPU mining but CPU mining is disabled'
            });
        }
        
        // Validate profit switching configuration
        if (config.profitSwitching?.enabled) {
            if (!config.profitSwitching.supportedCoins?.length) {
                errors.push({
                    path: 'profitSwitching.supportedCoins',
                    message: 'Profit switching enabled but no supported coins configured'
                });
            }
        }
        
        // Check monitoring and alerts
        if (config.monitoring?.alerts?.enabled && !config.monitoring.enabled) {
            warnings.push({
                path: 'monitoring.alerts.enabled',
                message: 'Alerts are enabled but monitoring is disabled'
            });
        }
    }

    performSecurityChecks(config, warnings) {
        // Check API security
        if (config.monitoring?.apiEnabled && !config.security?.apiKey) {
            warnings.push({
                path: 'security.apiKey',
                message: 'API is enabled but no API key is configured'
            });
        }
        
        // Check TLS configuration
        if (config.security?.tls?.enabled) {
            if (!config.security.tls.cert || !config.security.tls.key) {
                warnings.push({
                    path: 'security.tls',
                    message: 'TLS is enabled but certificate or key is missing'
                });
            }
        }
        
        // Check authentication
        if (config.security?.authentication?.type !== 'none' && 
            (!config.security.authentication.users?.length)) {
            warnings.push({
                path: 'security.authentication.users',
                message: 'Authentication is enabled but no users are configured'
            });
        }
    }

    addPerformanceRecommendations(config, warnings) {
        // GPU optimization
        if (config.hardware?.gpu?.enabled && !config.hardware.gpu.autoTune) {
            warnings.push({
                type: 'recommendation',
                path: 'hardware.gpu.autoTune',
                message: 'Consider enabling GPU auto-tuning for optimal performance'
            });
        }
        
        // Thread optimization
        if (config.mining?.threads === 0 && config.hardware?.cpu?.threads === 'auto') {
            warnings.push({
                type: 'recommendation',
                path: 'mining.threads',
                message: 'Auto thread detection is recommended for optimal CPU utilization'
            });
        }
        
        // Database optimization
        if (config.advanced?.database?.type === 'sqlite' && config.advanced?.clustering?.enabled) {
            warnings.push({
                type: 'recommendation',
                path: 'advanced.database.type',
                message: 'Consider using PostgreSQL or MySQL for better clustering performance'
            });
        }
    }

    async loadConfig(filePath, options = {}) {
        try {
            const ext = path.extname(filePath).toLowerCase();
            let config;
            
            const content = await fs.promises.readFile(filePath, 'utf8');
            
            switch (ext) {
                case '.json':
                    config = JSON.parse(content);
                    break;
                case '.yaml':
                case '.yml':
                    config = yaml.load(content);
                    break;
                case '.js':
                    delete require.cache[require.resolve(filePath)];
                    config = require(filePath);
                    break;
                default:
                    throw new Error(`Unsupported config file format: ${ext}`);
            }
            
            // Check cache
            const cacheKey = `${filePath}:${crypto.createHash('md5').update(content).digest('hex')}`;
            if (this.configCache.has(cacheKey) && !options.noCache) {
                return this.configCache.get(cacheKey);
            }
            
            // Validate configuration
            const result = await this.validateConfig(config, options);
            
            // Cache result
            this.configCache.set(cacheKey, result);
            
            // Limit cache size
            if (this.configCache.size > 100) {
                const firstKey = this.configCache.keys().next().value;
                this.configCache.delete(firstKey);
            }
            
            return result;
            
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    watchConfig(filePath, callback) {
        let debounceTimer;
        
        const watcher = fs.watch(filePath, (eventType) => {
            if (eventType === 'change') {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(async () => {
                    try {
                        const result = await this.loadConfig(filePath, { noCache: true });
                        callback(null, result);
                    } catch (error) {
                        callback(error);
                    }
                }, 300);
            }
        });
        
        return {
            close: () => {
                clearTimeout(debounceTimer);
                watcher.close();
            }
        };
    }

    generateTemplate(format = 'json', sections = null) {
        const template = {};
        
        const includedSections = sections || Object.keys(this.schemas);
        
        for (const section of includedSections) {
            if (this.schemas[section]) {
                template[section] = this.generateSectionTemplate(this.schemas[section]);
            }
        }
        
        switch (format) {
            case 'json':
                return JSON.stringify(template, null, 2);
            case 'yaml':
                return yaml.dump(template);
            default:
                return template;
        }
    }

    generateSectionTemplate(schema) {
        if (schema.type === 'object') {
            const obj = {};
            
            if (schema.properties) {
                for (const [key, prop] of Object.entries(schema.properties)) {
                    if (prop.default !== undefined) {
                        obj[key] = prop.default;
                    } else if (prop.type === 'object') {
                        obj[key] = this.generateSectionTemplate(prop);
                    } else if (prop.type === 'array') {
                        obj[key] = [];
                    } else {
                        obj[key] = this.getDefaultValue(prop);
                    }
                }
            }
            
            return obj;
        }
        
        return this.getDefaultValue(schema);
    }

    getDefaultValue(schema) {
        if (schema.default !== undefined) return schema.default;
        
        switch (schema.type) {
            case 'string': return '';
            case 'number':
            case 'integer': return schema.minimum || 0;
            case 'boolean': return false;
            case 'array': return [];
            case 'object': return {};
            default: return null;
        }
    }

    addToHistory(result) {
        this.validationHistory.unshift(result);
        
        if (this.validationHistory.length > this.maxHistorySize) {
            this.validationHistory.pop();
        }
    }

    getValidationHistory(limit = 10) {
        return this.validationHistory.slice(0, limit);
    }

    exportSchema(format = 'json') {
        const fullSchema = {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: this.schemas,
            additionalProperties: false
        };
        
        switch (format) {
            case 'json':
                return JSON.stringify(fullSchema, null, 2);
            case 'yaml':
                return yaml.dump(fullSchema);
            case 'markdown':
                return this.schemaToMarkdown(fullSchema);
            default:
                return fullSchema;
        }
    }

    schemaToMarkdown(schema, level = 0) {
        let md = '';
        const indent = '  '.repeat(level);
        
        if (schema.properties) {
            for (const [key, prop] of Object.entries(schema.properties)) {
                md += `${indent}- **${key}**`;
                
                if (prop.type) md += `: \`${prop.type}\``;
                if (prop.required) md += ' *(required)*';
                if (prop.default !== undefined) md += ` (default: \`${JSON.stringify(prop.default)}\`)`;
                if (prop.description) md += `\n${indent}  ${prop.description}`;
                md += '\n';
                
                if (prop.properties) {
                    md += this.schemaToMarkdown(prop, level + 1);
                }
                
                if (prop.enum) {
                    md += `${indent}  Options: ${prop.enum.map(v => `\`${v}\``).join(', ')}\n`;
                }
                
                if (prop.minimum !== undefined || prop.maximum !== undefined) {
                    md += `${indent}  Range: ${prop.minimum || '*'} - ${prop.maximum || '*'}\n`;
                }
            }
        }
        
        return md;
    }
}

class ValidationError extends Error {
    constructor(message, errors) {
        super(message);
        this.name = 'ValidationError';
        this.errors = errors;
    }
}

module.exports = AdvancedConfigValidator;