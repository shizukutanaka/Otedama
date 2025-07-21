/**
 * Feature Flags System for Otedama
 * Dynamic feature toggling and A/B testing
 * 
 * Design principles:
 * - Carmack: Zero-overhead feature checks
 * - Martin: Clean feature flag architecture
 * - Pike: Simple feature flag API
 */

import { EventEmitter } from 'events';
import { readFile, writeFile } from 'fs/promises';
import { logger } from '../core/logger.js';

/**
 * Feature flag types
 */
export const FlagType = {
  BOOLEAN: 'boolean',
  PERCENTAGE: 'percentage',
  VARIANT: 'variant',
  GRADUAL: 'gradual',
  SCHEDULED: 'scheduled',
  USER_TARGETING: 'user_targeting'
};

/**
 * Evaluation strategies
 */
export const EvaluationStrategy = {
  ALL_USERS: 'all_users',
  PERCENTAGE: 'percentage',
  USER_ID: 'user_id',
  USER_ATTRIBUTE: 'user_attribute',
  GROUP: 'group',
  CUSTOM: 'custom'
};

/**
 * Feature flag definition
 */
export class FeatureFlag {
  constructor(data) {
    this.key = data.key;
    this.name = data.name;
    this.description = data.description;
    this.type = data.type || FlagType.BOOLEAN;
    this.enabled = data.enabled !== false;
    this.defaultValue = data.defaultValue || false;
    this.variants = data.variants || [];
    this.rules = data.rules || [];
    this.metadata = data.metadata || {};
    this.createdAt = data.createdAt || Date.now();
    this.updatedAt = data.updatedAt || Date.now();
    this.schedule = data.schedule || null;
  }
  
  /**
   * Evaluate flag for context
   */
  evaluate(context = {}) {
    if (!this.enabled) {
      return this.defaultValue;
    }
    
    // Check schedule
    if (this.schedule && !this._isInSchedule()) {
      return this.defaultValue;
    }
    
    // Evaluate rules in order
    for (const rule of this.rules) {
      if (this._evaluateRule(rule, context)) {
        return rule.value;
      }
    }
    
    // Return default value
    return this.defaultValue;
  }
  
  /**
   * Evaluate rule
   */
  _evaluateRule(rule, context) {
    switch (rule.strategy) {
      case EvaluationStrategy.ALL_USERS:
        return true;
        
      case EvaluationStrategy.PERCENTAGE:
        return this._evaluatePercentage(rule, context);
        
      case EvaluationStrategy.USER_ID:
        return this._evaluateUserId(rule, context);
        
      case EvaluationStrategy.USER_ATTRIBUTE:
        return this._evaluateUserAttribute(rule, context);
        
      case EvaluationStrategy.GROUP:
        return this._evaluateGroup(rule, context);
        
      case EvaluationStrategy.CUSTOM:
        return rule.evaluator ? rule.evaluator(context) : false;
        
      default:
        return false;
    }
  }
  
  /**
   * Evaluate percentage rule
   */
  _evaluatePercentage(rule, context) {
    const userId = context.userId || 'anonymous';
    const hash = this._hashString(`${this.key}:${userId}`);
    const bucket = (hash % 100) + 1;
    return bucket <= rule.percentage;
  }
  
  /**
   * Evaluate user ID rule
   */
  _evaluateUserId(rule, context) {
    if (!context.userId) return false;
    
    if (rule.userIds) {
      return rule.userIds.includes(context.userId);
    }
    
    if (rule.pattern) {
      return new RegExp(rule.pattern).test(context.userId);
    }
    
    return false;
  }
  
  /**
   * Evaluate user attribute rule
   */
  _evaluateUserAttribute(rule, context) {
    if (!context.user) return false;
    
    const value = this._getNestedValue(context.user, rule.attribute);
    
    switch (rule.operator) {
      case 'equals':
        return value === rule.value;
      case 'not_equals':
        return value !== rule.value;
      case 'contains':
        return String(value).includes(rule.value);
      case 'not_contains':
        return !String(value).includes(rule.value);
      case 'greater_than':
        return Number(value) > Number(rule.value);
      case 'less_than':
        return Number(value) < Number(rule.value);
      case 'in':
        return rule.value.includes(value);
      case 'not_in':
        return !rule.value.includes(value);
      default:
        return false;
    }
  }
  
  /**
   * Evaluate group rule
   */
  _evaluateGroup(rule, context) {
    if (!context.groups) return false;
    return context.groups.some(group => rule.groups.includes(group));
  }
  
  /**
   * Check if in schedule
   */
  _isInSchedule() {
    if (!this.schedule) return true;
    
    const now = Date.now();
    
    if (this.schedule.startTime && now < this.schedule.startTime) {
      return false;
    }
    
    if (this.schedule.endTime && now > this.schedule.endTime) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Hash string to number
   */
  _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }
  
  /**
   * Get nested value from object
   */
  _getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }
  
  /**
   * Update flag
   */
  update(updates) {
    Object.assign(this, updates);
    this.updatedAt = Date.now();
  }
  
  /**
   * Convert to JSON
   */
  toJSON() {
    return {
      key: this.key,
      name: this.name,
      description: this.description,
      type: this.type,
      enabled: this.enabled,
      defaultValue: this.defaultValue,
      variants: this.variants,
      rules: this.rules,
      metadata: this.metadata,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      schedule: this.schedule
    };
  }
}

/**
 * Feature flag rule
 */
export class FlagRule {
  constructor(data) {
    this.id = data.id || this._generateId();
    this.name = data.name;
    this.strategy = data.strategy;
    this.value = data.value;
    this.percentage = data.percentage;
    this.userIds = data.userIds;
    this.pattern = data.pattern;
    this.attribute = data.attribute;
    this.operator = data.operator;
    this.groups = data.groups;
    this.evaluator = data.evaluator;
    this.priority = data.priority || 0;
  }
  
  _generateId() {
    return `rule-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * Feature flags system
 */
export class FeatureFlagsSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Storage
      storageType: options.storageType || 'memory', // memory, file, remote
      configFile: options.configFile || './feature-flags.json',
      
      // Sync settings
      syncInterval: options.syncInterval || 60000, // 1 minute
      remoteEndpoint: options.remoteEndpoint,
      
      // Cache settings
      cacheEnabled: options.cacheEnabled !== false,
      cacheTTL: options.cacheTTL || 300000, // 5 minutes
      
      // Analytics
      analyticsEnabled: options.analyticsEnabled !== false,
      analyticsInterval: options.analyticsInterval || 60000,
      
      // Defaults
      defaultContext: options.defaultContext || {},
      
      ...options
    };
    
    // Flags storage
    this.flags = new Map();
    
    // Evaluation cache
    this.cache = new Map();
    this.cacheTimestamps = new Map();
    
    // Analytics
    this.analytics = {
      evaluations: new Map(), // flag -> count
      variations: new Map(),  // flag:value -> count
      errors: new Map()       // flag -> error count
    };
    
    // Metrics
    this.metrics = {
      totalEvaluations: 0,
      cacheHits: 0,
      cacheMisses: 0,
      errors: 0
    };
  }
  
  /**
   * Initialize feature flags system
   */
  async initialize() {
    logger.info('Initializing feature flags system');
    
    // Load flags
    await this._loadFlags();
    
    // Start sync
    if (this.options.storageType === 'remote') {
      this._startSync();
    }
    
    // Start analytics
    if (this.options.analyticsEnabled) {
      this._startAnalytics();
    }
    
    this.emit('initialized');
  }
  
  /**
   * Define feature flag
   */
  defineFlag(flagData) {
    const flag = new FeatureFlag(flagData);
    this.flags.set(flag.key, flag);
    
    // Clear cache for this flag
    this._clearFlagCache(flag.key);
    
    logger.info(`Defined feature flag: ${flag.key}`);
    
    this.emit('flag:defined', flag);
    
    return flag;
  }
  
  /**
   * Get feature flag
   */
  getFlag(key) {
    return this.flags.get(key);
  }
  
  /**
   * Get all flags
   */
  getAllFlags() {
    return Array.from(this.flags.values());
  }
  
  /**
   * Update feature flag
   */
  updateFlag(key, updates) {
    const flag = this.flags.get(key);
    if (!flag) {
      throw new Error(`Feature flag not found: ${key}`);
    }
    
    flag.update(updates);
    
    // Clear cache
    this._clearFlagCache(key);
    
    logger.info(`Updated feature flag: ${key}`);
    
    this.emit('flag:updated', flag);
    
    // Save if file storage
    if (this.options.storageType === 'file') {
      this._saveFlags();
    }
    
    return flag;
  }
  
  /**
   * Delete feature flag
   */
  deleteFlag(key) {
    const flag = this.flags.get(key);
    if (!flag) {
      throw new Error(`Feature flag not found: ${key}`);
    }
    
    this.flags.delete(key);
    
    // Clear cache
    this._clearFlagCache(key);
    
    logger.info(`Deleted feature flag: ${key}`);
    
    this.emit('flag:deleted', flag);
    
    // Save if file storage
    if (this.options.storageType === 'file') {
      this._saveFlags();
    }
  }
  
  /**
   * Evaluate feature flag
   */
  evaluate(key, context = {}) {
    this.metrics.totalEvaluations++;
    
    try {
      // Merge with default context
      const evalContext = {
        ...this.options.defaultContext,
        ...context
      };
      
      // Check cache
      const cacheKey = this._getCacheKey(key, evalContext);
      if (this.options.cacheEnabled) {
        const cached = this._getFromCache(cacheKey);
        if (cached !== undefined) {
          this.metrics.cacheHits++;
          return cached;
        }
        this.metrics.cacheMisses++;
      }
      
      // Get flag
      const flag = this.flags.get(key);
      if (!flag) {
        this._recordError(key, 'Flag not found');
        return null;
      }
      
      // Evaluate
      const value = flag.evaluate(evalContext);
      
      // Cache result
      if (this.options.cacheEnabled) {
        this._addToCache(cacheKey, value);
      }
      
      // Record analytics
      this._recordEvaluation(key, value);
      
      // Emit event
      this.emit('flag:evaluated', {
        key,
        value,
        context: evalContext
      });
      
      return value;
      
    } catch (error) {
      this.metrics.errors++;
      this._recordError(key, error.message);
      
      logger.error(`Error evaluating flag ${key}:`, error);
      
      // Return default value
      const flag = this.flags.get(key);
      return flag ? flag.defaultValue : null;
    }
  }
  
  /**
   * Evaluate all flags
   */
  evaluateAll(context = {}) {
    const results = {};
    
    for (const [key, flag] of this.flags) {
      results[key] = this.evaluate(key, context);
    }
    
    return results;
  }
  
  /**
   * Is enabled (boolean shorthand)
   */
  isEnabled(key, context = {}) {
    return !!this.evaluate(key, context);
  }
  
  /**
   * Get variant
   */
  getVariant(key, context = {}) {
    const value = this.evaluate(key, context);
    
    const flag = this.flags.get(key);
    if (!flag || flag.type !== FlagType.VARIANT) {
      return null;
    }
    
    return flag.variants.find(v => v.key === value) || null;
  }
  
  /**
   * Add rule to flag
   */
  addRule(flagKey, ruleData) {
    const flag = this.flags.get(flagKey);
    if (!flag) {
      throw new Error(`Feature flag not found: ${flagKey}`);
    }
    
    const rule = new FlagRule(ruleData);
    flag.rules.push(rule);
    
    // Sort by priority
    flag.rules.sort((a, b) => b.priority - a.priority);
    
    // Clear cache
    this._clearFlagCache(flagKey);
    
    this.emit('rule:added', { flag: flagKey, rule });
    
    return rule;
  }
  
  /**
   * Remove rule from flag
   */
  removeRule(flagKey, ruleId) {
    const flag = this.flags.get(flagKey);
    if (!flag) {
      throw new Error(`Feature flag not found: ${flagKey}`);
    }
    
    flag.rules = flag.rules.filter(r => r.id !== ruleId);
    
    // Clear cache
    this._clearFlagCache(flagKey);
    
    this.emit('rule:removed', { flag: flagKey, ruleId });
  }
  
  /**
   * Load flags from storage
   */
  async _loadFlags() {
    switch (this.options.storageType) {
      case 'file':
        await this._loadFromFile();
        break;
        
      case 'remote':
        await this._loadFromRemote();
        break;
        
      case 'memory':
      default:
        // No loading needed
        break;
    }
  }
  
  /**
   * Load from file
   */
  async _loadFromFile() {
    try {
      const data = await readFile(this.options.configFile, 'utf8');
      const config = JSON.parse(data);
      
      for (const flagData of config.flags || []) {
        this.defineFlag(flagData);
      }
      
      logger.info(`Loaded ${this.flags.size} feature flags from file`);
    } catch (error) {
      logger.warn('No feature flags file found, starting with empty set');
    }
  }
  
  /**
   * Load from remote
   */
  async _loadFromRemote() {
    if (!this.options.remoteEndpoint) return;
    
    try {
      const response = await fetch(this.options.remoteEndpoint);
      const config = await response.json();
      
      // Clear existing flags
      this.flags.clear();
      
      // Load new flags
      for (const flagData of config.flags || []) {
        this.defineFlag(flagData);
      }
      
      logger.info(`Loaded ${this.flags.size} feature flags from remote`);
      
    } catch (error) {
      logger.error('Failed to load flags from remote:', error);
    }
  }
  
  /**
   * Save flags to file
   */
  async _saveFlags() {
    const config = {
      flags: this.getAllFlags().map(flag => flag.toJSON()),
      savedAt: Date.now()
    };
    
    await writeFile(this.options.configFile, JSON.stringify(config, null, 2));
  }
  
  /**
   * Start sync with remote
   */
  _startSync() {
    setInterval(() => {
      this._loadFromRemote();
    }, this.options.syncInterval);
  }
  
  /**
   * Start analytics collection
   */
  _startAnalytics() {
    setInterval(() => {
      this._flushAnalytics();
    }, this.options.analyticsInterval);
  }
  
  /**
   * Record evaluation
   */
  _recordEvaluation(key, value) {
    if (!this.options.analyticsEnabled) return;
    
    // Total evaluations
    const evalCount = this.analytics.evaluations.get(key) || 0;
    this.analytics.evaluations.set(key, evalCount + 1);
    
    // Variation distribution
    const variationKey = `${key}:${JSON.stringify(value)}`;
    const varCount = this.analytics.variations.get(variationKey) || 0;
    this.analytics.variations.set(variationKey, varCount + 1);
  }
  
  /**
   * Record error
   */
  _recordError(key, error) {
    if (!this.options.analyticsEnabled) return;
    
    const errorCount = this.analytics.errors.get(key) || 0;
    this.analytics.errors.set(key, errorCount + 1);
  }
  
  /**
   * Flush analytics
   */
  _flushAnalytics() {
    const analytics = {
      timestamp: Date.now(),
      evaluations: Object.fromEntries(this.analytics.evaluations),
      variations: Object.fromEntries(this.analytics.variations),
      errors: Object.fromEntries(this.analytics.errors),
      metrics: this.metrics
    };
    
    this.emit('analytics:flush', analytics);
    
    // Reset counters
    this.analytics.evaluations.clear();
    this.analytics.variations.clear();
    this.analytics.errors.clear();
  }
  
  /**
   * Cache management
   */
  _getCacheKey(flagKey, context) {
    return `${flagKey}:${JSON.stringify(context)}`;
  }
  
  _getFromCache(cacheKey) {
    const cached = this.cache.get(cacheKey);
    if (!cached) return undefined;
    
    const timestamp = this.cacheTimestamps.get(cacheKey);
    if (Date.now() - timestamp > this.options.cacheTTL) {
      this.cache.delete(cacheKey);
      this.cacheTimestamps.delete(cacheKey);
      return undefined;
    }
    
    return cached;
  }
  
  _addToCache(cacheKey, value) {
    this.cache.set(cacheKey, value);
    this.cacheTimestamps.set(cacheKey, Date.now());
    
    // Limit cache size
    if (this.cache.size > 10000) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
      this.cacheTimestamps.delete(firstKey);
    }
  }
  
  _clearFlagCache(flagKey) {
    const keysToDelete = [];
    
    for (const cacheKey of this.cache.keys()) {
      if (cacheKey.startsWith(`${flagKey}:`)) {
        keysToDelete.push(cacheKey);
      }
    }
    
    for (const key of keysToDelete) {
      this.cache.delete(key);
      this.cacheTimestamps.delete(key);
    }
  }
  
  /**
   * Get analytics summary
   */
  getAnalytics() {
    const summary = {};
    
    for (const [key, flag] of this.flags) {
      const evaluations = this.analytics.evaluations.get(key) || 0;
      const errors = this.analytics.errors.get(key) || 0;
      
      const variations = {};
      for (const [varKey, count] of this.analytics.variations) {
        if (varKey.startsWith(`${key}:`)) {
          const value = varKey.substring(key.length + 1);
          variations[value] = count;
        }
      }
      
      summary[key] = {
        evaluations,
        errors,
        errorRate: evaluations > 0 ? (errors / evaluations * 100).toFixed(2) + '%' : '0%',
        variations
      };
    }
    
    return summary;
  }
  
  /**
   * Get system status
   */
  getStatus() {
    return {
      flags: this.flags.size,
      cacheSize: this.cache.size,
      metrics: {
        ...this.metrics,
        cacheHitRate: this.metrics.cacheHits > 0 ?
          (this.metrics.cacheHits / (this.metrics.cacheHits + this.metrics.cacheMisses) * 100).toFixed(2) + '%' : '0%',
        errorRate: this.metrics.totalEvaluations > 0 ?
          (this.metrics.errors / this.metrics.totalEvaluations * 100).toFixed(2) + '%' : '0%'
      }
    };
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    logger.info('Shutting down feature flags system');
    
    // Flush analytics
    if (this.options.analyticsEnabled) {
      this._flushAnalytics();
    }
    
    // Save flags if file storage
    if (this.options.storageType === 'file') {
      await this._saveFlags();
    }
    
    this.emit('shutdown');
  }
}

export default FeatureFlagsSystem;