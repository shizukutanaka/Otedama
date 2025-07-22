const { EventEmitter } = require('events');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * Configuration Management System
 * Centralized configuration with validation and hot-reload
 */
class ConfigManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = {
            configDir: options.configDir || './config',
            envFile: options.envFile || '.env',
            defaultsDir: options.defaultsDir || './config/defaults',
            schemasDir: options.schemasDir || './config/schemas',
            
            // Features
            hotReload: options.hotReload !== false,
            validation: options.validation !== false,
            encryption: options.encryption || false,
            versioning: options.versioning !== false,
            
            // Encryption settings
            encryptionKey: options.encryptionKey || null,
            encryptedFields: options.encryptedFields || [
                'password', 'secret', 'key', 'token', 'privateKey'
            ],
            
            ...options
        };
        
        // Configuration storage
        this.configs = new Map();
        this.schemas = new Map();
        this.defaults = new Map();
        this.watchers = new Map();
        
        // Configuration history
        this.history = [];
        this.currentVersion = 1;
        
        // Initialize
        this.initialize();
    }
    
    // Initialize configuration manager
    async initialize() {
        try {
            // Create directories
            await fs.mkdir(this.options.configDir, { recursive: true });
            await fs.mkdir(this.options.defaultsDir, { recursive: true });
            await fs.mkdir(this.options.schemasDir, { recursive: true });
            
            // Load schemas
            await this.loadSchemas();
            
            // Load defaults
            await this.loadDefaults();
            
            // Load configurations
            await this.loadConfigurations();
            
            // Load environment variables
            await this.loadEnvironment();
            
            // Setup hot reload
            if (this.options.hotReload) {
                this.setupWatchers();
            }
            
            this.emit('initialized');
            
        } catch (error) {
            this.emit('error', { operation: 'initialize', error });
        }
    }
    
    // Load schemas
    async loadSchemas() {
        try {
            const files = await fs.readdir(this.options.schemasDir);
            
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                
                const name = path.basename(file, '.json');
                const content = await fs.readFile(
                    path.join(this.options.schemasDir, file),
                    'utf8'
                );
                
                this.schemas.set(name, JSON.parse(content));
            }
        } catch (error) {
            // No schemas directory
        }
    }
    
    // Load defaults
    async loadDefaults() {
        try {
            const files = await fs.readdir(this.options.defaultsDir);
            
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                
                const name = path.basename(file, '.json');
                const content = await fs.readFile(
                    path.join(this.options.defaultsDir, file),
                    'utf8'
                );
                
                this.defaults.set(name, JSON.parse(content));
            }
        } catch (error) {
            // No defaults directory
        }
    }
    
    // Load configurations
    async loadConfigurations() {
        try {
            const files = await fs.readdir(this.options.configDir);
            
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                
                const name = path.basename(file, '.json');
                await this.loadConfig(name);
            }
        } catch (error) {
            this.emit('error', { operation: 'load-configs', error });
        }
    }
    
    // Load single configuration
    async loadConfig(name) {
        try {
            const filePath = path.join(this.options.configDir, `${name}.json`);
            const content = await fs.readFile(filePath, 'utf8');
            let config = JSON.parse(content);
            
            // Decrypt if needed
            if (this.options.encryption) {
                config = await this.decryptConfig(config);
            }
            
            // Apply defaults
            const defaults = this.defaults.get(name);
            if (defaults) {
                config = this.mergeWithDefaults(config, defaults);
            }
            
            // Validate
            if (this.options.validation) {
                const schema = this.schemas.get(name);
                if (schema) {
                    this.validateConfig(config, schema);
                }
            }
            
            // Store configuration
            this.configs.set(name, {
                data: config,
                path: filePath,
                loadedAt: Date.now(),
                version: config.version || 1
            });
            
            this.emit('config-loaded', { name, config });
            
        } catch (error) {
            this.emit('error', { operation: 'load-config', name, error });
            
            // Use defaults if available
            const defaults = this.defaults.get(name);
            if (defaults) {
                this.configs.set(name, {
                    data: defaults,
                    path: null,
                    loadedAt: Date.now(),
                    version: 1
                });
            }
        }
    }
    
    // Load environment variables
    async loadEnvironment() {
        try {
            // Load .env file
            const envPath = path.join(process.cwd(), this.options.envFile);
            const envContent = await fs.readFile(envPath, 'utf8');
            
            // Parse environment variables
            const lines = envContent.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                
                const [key, ...valueParts] = trimmed.split('=');
                const value = valueParts.join('=').replace(/^["']|["']$/g, '');
                
                process.env[key] = value;
            }
        } catch (error) {
            // .env file not found or error reading
        }
        
        // Create environment config
        this.configs.set('env', {
            data: { ...process.env },
            path: null,
            loadedAt: Date.now(),
            version: 1
        });
    }
    
    // Get configuration
    get(name, path = null) {
        const config = this.configs.get(name);
        if (!config) {
            throw new Error(`Configuration '${name}' not found`);
        }
        
        if (!path) {
            return config.data;
        }
        
        // Navigate path
        const parts = path.split('.');
        let value = config.data;
        
        for (const part of parts) {
            if (value && typeof value === 'object' && part in value) {
                value = value[part];
            } else {
                return undefined;
            }
        }
        
        return value;
    }
    
    // Set configuration value
    async set(name, path, value) {
        const config = this.configs.get(name);
        if (!config) {
            throw new Error(`Configuration '${name}' not found`);
        }
        
        // Create backup for versioning
        if (this.options.versioning) {
            this.createBackup(name, config.data);
        }
        
        // Navigate and set value
        const parts = path.split('.');
        let obj = config.data;
        
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (!(part in obj) || typeof obj[part] !== 'object') {
                obj[part] = {};
            }
            obj = obj[part];
        }
        
        const lastPart = parts[parts.length - 1];
        const oldValue = obj[lastPart];
        obj[lastPart] = value;
        
        // Validate if schema exists
        if (this.options.validation) {
            const schema = this.schemas.get(name);
            if (schema) {
                this.validateConfig(config.data, schema);
            }
        }
        
        // Update version
        config.version = (config.version || 1) + 1;
        config.data.version = config.version;
        
        // Save to disk
        await this.saveConfig(name);
        
        this.emit('config-changed', {
            name,
            path,
            oldValue,
            newValue: value,
            version: config.version
        });
    }
    
    // Save configuration
    async saveConfig(name) {
        const config = this.configs.get(name);
        if (!config || !config.path) {
            throw new Error(`Cannot save configuration '${name}'`);
        }
        
        let data = { ...config.data };
        
        // Encrypt sensitive fields
        if (this.options.encryption) {
            data = await this.encryptConfig(data);
        }
        
        // Write to file
        await fs.writeFile(
            config.path,
            JSON.stringify(data, null, 2)
        );
        
        this.emit('config-saved', { name });
    }
    
    // Merge with defaults
    mergeWithDefaults(config, defaults) {
        const merged = { ...defaults };
        
        const merge = (target, source) => {
            for (const key in source) {
                if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                    target[key] = target[key] || {};
                    merge(target[key], source[key]);
                } else {
                    target[key] = source[key];
                }
            }
        };
        
        merge(merged, config);
        return merged;
    }
    
    // Validate configuration
    validateConfig(config, schema) {
        const errors = [];
        
        const validate = (obj, schema, path = '') => {
            // Check required fields
            if (schema.required) {
                for (const field of schema.required) {
                    if (!(field in obj)) {
                        errors.push(`Missing required field: ${path}${field}`);
                    }
                }
            }
            
            // Check properties
            if (schema.properties) {
                for (const [key, propSchema] of Object.entries(schema.properties)) {
                    const value = obj[key];
                    const fullPath = path ? `${path}.${key}` : key;
                    
                    if (value === undefined) continue;
                    
                    // Type validation
                    if (propSchema.type) {
                        const actualType = Array.isArray(value) ? 'array' : typeof value;
                        if (actualType !== propSchema.type) {
                            errors.push(`Invalid type for ${fullPath}: expected ${propSchema.type}, got ${actualType}`);
                        }
                    }
                    
                    // Enum validation
                    if (propSchema.enum && !propSchema.enum.includes(value)) {
                        errors.push(`Invalid value for ${fullPath}: must be one of ${propSchema.enum.join(', ')}`);
                    }
                    
                    // Range validation
                    if (typeof value === 'number') {
                        if (propSchema.minimum !== undefined && value < propSchema.minimum) {
                            errors.push(`Value for ${fullPath} below minimum: ${propSchema.minimum}`);
                        }
                        if (propSchema.maximum !== undefined && value > propSchema.maximum) {
                            errors.push(`Value for ${fullPath} above maximum: ${propSchema.maximum}`);
                        }
                    }
                    
                    // String validation
                    if (typeof value === 'string') {
                        if (propSchema.minLength !== undefined && value.length < propSchema.minLength) {
                            errors.push(`Value for ${fullPath} too short: minimum length ${propSchema.minLength}`);
                        }
                        if (propSchema.maxLength !== undefined && value.length > propSchema.maxLength) {
                            errors.push(`Value for ${fullPath} too long: maximum length ${propSchema.maxLength}`);
                        }
                        if (propSchema.pattern) {
                            const regex = new RegExp(propSchema.pattern);
                            if (!regex.test(value)) {
                                errors.push(`Value for ${fullPath} does not match pattern: ${propSchema.pattern}`);
                            }
                        }
                    }
                    
                    // Nested object validation
                    if (propSchema.properties && typeof value === 'object') {
                        validate(value, propSchema, fullPath);
                    }
                }
            }
        };
        
        validate(config, schema);
        
        if (errors.length > 0) {
            throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
        }
    }
    
    // Encrypt configuration
    async encryptConfig(config) {
        if (!this.options.encryptionKey) {
            return config;
        }
        
        const encrypted = { ...config };
        
        const encryptValue = (obj, path = '') => {
            for (const [key, value] of Object.entries(obj)) {
                const fullPath = path ? `${path}.${key}` : key;
                
                // Check if field should be encrypted
                const shouldEncrypt = this.options.encryptedFields.some(field => 
                    key.toLowerCase().includes(field.toLowerCase()) ||
                    fullPath.toLowerCase().includes(field.toLowerCase())
                );
                
                if (shouldEncrypt && typeof value === 'string') {
                    obj[key] = this.encryptString(value);
                } else if (value && typeof value === 'object' && !Array.isArray(value)) {
                    encryptValue(value, fullPath);
                }
            }
        };
        
        encryptValue(encrypted);
        return encrypted;
    }
    
    // Decrypt configuration
    async decryptConfig(config) {
        if (!this.options.encryptionKey) {
            return config;
        }
        
        const decrypted = { ...config };
        
        const decryptValue = (obj) => {
            for (const [key, value] of Object.entries(obj)) {
                if (typeof value === 'string' && value.startsWith('enc:')) {
                    obj[key] = this.decryptString(value);
                } else if (value && typeof value === 'object' && !Array.isArray(value)) {
                    decryptValue(value);
                }
            }
        };
        
        decryptValue(decrypted);
        return decrypted;
    }
    
    // Encrypt string
    encryptString(value) {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(
            'aes-256-gcm',
            Buffer.from(this.options.encryptionKey, 'hex'),
            iv
        );
        
        const encrypted = Buffer.concat([
            cipher.update(value, 'utf8'),
            cipher.final()
        ]);
        
        const tag = cipher.getAuthTag();
        
        return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
    }
    
    // Decrypt string
    decryptString(value) {
        if (!value.startsWith('enc:')) {
            return value;
        }
        
        const parts = value.split(':');
        if (parts.length !== 4) {
            throw new Error('Invalid encrypted value format');
        }
        
        const iv = Buffer.from(parts[1], 'hex');
        const tag = Buffer.from(parts[2], 'hex');
        const encrypted = Buffer.from(parts[3], 'hex');
        
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            Buffer.from(this.options.encryptionKey, 'hex'),
            iv
        );
        
        decipher.setAuthTag(tag);
        
        return decipher.update(encrypted) + decipher.final('utf8');
    }
    
    // Setup file watchers for hot reload
    setupWatchers() {
        const { watch } = require('fs');
        
        // Watch config directory
        const watcher = watch(this.options.configDir, async (eventType, filename) => {
            if (!filename || !filename.endsWith('.json')) return;
            
            const name = path.basename(filename, '.json');
            
            // Debounce
            if (this.watchers.has(name)) {
                clearTimeout(this.watchers.get(name));
            }
            
            this.watchers.set(name, setTimeout(async () => {
                try {
                    await this.loadConfig(name);
                    this.emit('config-reloaded', { name });
                } catch (error) {
                    this.emit('reload-error', { name, error });
                }
            }, 100));
        });
        
        // Store watcher
        this.watchers.set('_directory', watcher);
    }
    
    // Create configuration backup
    createBackup(name, data) {
        this.history.push({
            name,
            data: JSON.parse(JSON.stringify(data)),
            version: this.currentVersion++,
            timestamp: Date.now()
        });
        
        // Keep only last 100 versions
        if (this.history.length > 100) {
            this.history = this.history.slice(-100);
        }
    }
    
    // Restore configuration from backup
    async restore(name, version) {
        const backup = this.history.find(h => 
            h.name === name && h.version === version
        );
        
        if (!backup) {
            throw new Error(`Backup not found: ${name} v${version}`);
        }
        
        const config = this.configs.get(name);
        if (!config) {
            throw new Error(`Configuration '${name}' not found`);
        }
        
        config.data = JSON.parse(JSON.stringify(backup.data));
        config.version = version;
        
        await this.saveConfig(name);
        
        this.emit('config-restored', { name, version });
    }
    
    // Get configuration history
    getHistory(name = null) {
        if (name) {
            return this.history.filter(h => h.name === name);
        }
        return this.history;
    }
    
    // Export all configurations
    async exportConfigs(outputPath) {
        const configs = {};
        
        for (const [name, config] of this.configs) {
            configs[name] = config.data;
        }
        
        await fs.writeFile(
            outputPath,
            JSON.stringify(configs, null, 2)
        );
    }
    
    // Import configurations
    async importConfigs(inputPath) {
        const content = await fs.readFile(inputPath, 'utf8');
        const configs = JSON.parse(content);
        
        for (const [name, data] of Object.entries(configs)) {
            this.configs.set(name, {
                data,
                path: path.join(this.options.configDir, `${name}.json`),
                loadedAt: Date.now(),
                version: data.version || 1
            });
            
            await this.saveConfig(name);
        }
        
        this.emit('configs-imported', { count: Object.keys(configs).length });
    }
    
    // Get all configuration names
    getConfigNames() {
        return Array.from(this.configs.keys());
    }
    
    // Check if configuration exists
    has(name) {
        return this.configs.has(name);
    }
    
    // Shutdown
    shutdown() {
        // Close watchers
        for (const [name, watcher] of this.watchers) {
            if (name === '_directory') {
                watcher.close();
            } else {
                clearTimeout(watcher);
            }
        }
        
        this.removeAllListeners();
    }
}

module.exports = ConfigManager;