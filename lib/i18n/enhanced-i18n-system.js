/**
 * Enhanced I18n System
 * 
 * Unified internationalization system integrating all advanced features
 * Following all three principles: Carmack's performance, Martin's clean code, Pike's simplicity
 */

import { EventEmitter } from 'events';
import { I18nManager } from './i18n-manager.js';
import { RealtimeLanguageSwitcher } from './realtime-language-switcher.js';
import { DynamicTranslationLoader } from './dynamic-translation-loader.js';
import { TranslationQualityManager } from './translation-quality-manager.js';
import { ContextualTranslationSystem } from './contextual-translation-system.js';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../error-handler.js';

export class EnhancedI18nSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Core options
      defaultLanguage: options.defaultLanguage || 'en',
      fallbackLanguage: options.fallbackLanguage || 'en',
      
      // Feature flags
      enableRealtimeSwitching: options.enableRealtimeSwitching !== false,
      enableDynamicLoading: options.enableDynamicLoading !== false,
      enableQualityManagement: options.enableQualityManagement !== false,
      enableContextualTranslation: options.enableContextualTranslation !== false,
      
      // Performance options
      enableCaching: options.enableCaching !== false,
      enablePreloading: options.enablePreloading !== false,
      cacheExpiry: options.cacheExpiry || 24 * 60 * 60 * 1000, // 24 hours
      
      // Quality options
      autoQualityCheck: options.autoQualityCheck !== false,
      qualityThreshold: options.qualityThreshold || 0.7,
      
      // UI options
      autoUpdateUI: options.autoUpdateUI !== false,
      enableDirectionSupport: options.enableDirectionSupport !== false,
      
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.components = {};
    this.currentLanguage = this.options.defaultLanguage;
    this.isInitialized = false;
    
    // Performance metrics
    this.metrics = {
      translationRequests: 0,
      cacheHits: 0,
      qualityChecks: 0,
      languageSwitches: 0,
      averageResponseTime: 0,
      totalResponseTime: 0
    };
    
    this.initialize();
  }
  
  /**
   * Initialize enhanced i18n system
   */
  async initialize() {
    try {
      console.log('Initializing Enhanced I18n System...');
      
      // Initialize core i18n manager
      this.components.i18nManager = new I18nManager({
        defaultLanguage: this.options.defaultLanguage,
        fallbackLanguage: this.options.fallbackLanguage,
        cacheTranslations: this.options.enableCaching,
        autoDetect: this.options.autoDetect
      });
      
      await this.components.i18nManager.initialize();
      
      // Initialize optional components
      await this.initializeOptionalComponents();
      
      // Setup integration between components
      this.setupComponentIntegration();
      
      // Setup performance monitoring
      this.setupPerformanceMonitoring();
      
      this.currentLanguage = this.components.i18nManager.currentLanguage;
      this.isInitialized = true;
      
      this.emit('initialized', {
        language: this.currentLanguage,
        components: Object.keys(this.components),
        features: this.getEnabledFeatures()
      });
      
      console.log(`Enhanced I18n System initialized with language: ${this.currentLanguage}`);
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'enhanced-i18n',
        category: ErrorCategory.INITIALIZATION
      });
      throw error;
    }
  }
  
  /**
   * Initialize optional components
   */
  async initializeOptionalComponents() {
    // Initialize dynamic translation loader
    if (this.options.enableDynamicLoading) {
      this.components.dynamicLoader = new DynamicTranslationLoader({
        enableCaching: this.options.enableCaching,
        cacheExpiry: this.options.cacheExpiry
      });
      await this.components.dynamicLoader.initialize();
    }
    
    // Initialize realtime language switcher
    if (this.options.enableRealtimeSwitching) {
      this.components.languageSwitcher = new RealtimeLanguageSwitcher({
        i18nManager: this.components.i18nManager,
        autoUpdateUI: this.options.autoUpdateUI,
        enableDirection: this.options.enableDirectionSupport,
        preloadLanguages: this.options.preloadLanguages
      });
      await this.components.languageSwitcher.initialize();
    }
    
    // Initialize quality manager
    if (this.options.enableQualityManagement) {
      this.components.qualityManager = new TranslationQualityManager({
        enableAutomaticChecks: this.options.autoQualityCheck,
        qualityThreshold: this.options.qualityThreshold
      });
    }
    
    // Initialize contextual translation system
    if (this.options.enableContextualTranslation) {
      this.components.contextualSystem = new ContextualTranslationSystem({
        enableContextCache: this.options.enableCaching,
        enableDomainAdaptation: true,
        enableUserPersonalization: true
      });
      await this.components.contextualSystem.initialize();
    }
  }
  
  /**
   * Setup integration between components
   */
  setupComponentIntegration() {
    // Integrate language switcher with main system
    if (this.components.languageSwitcher) {
      this.components.languageSwitcher.on('language:switched', (event) => {
        this.currentLanguage = event.to;
        this.metrics.languageSwitches++;
        
        this.emit('language:changed', event);
      });
    }
    
    // Integrate quality manager with translations
    if (this.components.qualityManager) {
      this.components.qualityManager.on('quality:assessed', (assessment) => {
        this.metrics.qualityChecks++;
        
        if (assessment.quality === 'poor' || assessment.quality === 'unacceptable') {
          this.emit('quality:warning', assessment);
        }
      });
    }
    
    // Integrate contextual system with main translations
    if (this.components.contextualSystem) {
      this.components.contextualSystem.on('translation:contextual', (event) => {
        this.emit('translation:contextual', event);
      });
    }
    
    // Integrate dynamic loader with main system
    if (this.components.dynamicLoader) {
      this.components.dynamicLoader.on('translations:loaded', (event) => {
        if (event.source === 'cache') {
          this.metrics.cacheHits++;
        }
      });
    }
  }
  
  /**
   * Setup performance monitoring
   */
  setupPerformanceMonitoring() {
    // Monitor translation performance
    const originalT = this.components.i18nManager.t.bind(this.components.i18nManager);
    
    this.components.i18nManager.t = (key, options = {}) => {
      const startTime = performance.now();
      this.metrics.translationRequests++;
      
      const result = originalT(key, options);
      
      const duration = performance.now() - startTime;
      this.metrics.totalResponseTime += duration;
      this.metrics.averageResponseTime = this.metrics.totalResponseTime / this.metrics.translationRequests;
      
      return result;
    };
  }
  
  /**
   * Enhanced translation method with all features
   */
  async t(key, options = {}) {
    const startTime = performance.now();
    
    try {
      let translation;
      
      // Use contextual translation if available and context provided
      if (this.components.contextualSystem && this.hasContextualOptions(options)) {
        translation = await this.components.contextualSystem.translateWithContext(key, {
          language: this.currentLanguage,
          ...options
        });
      } else {
        // Use standard translation
        translation = this.components.i18nManager.t(key, options);
      }
      
      // Perform quality check if enabled
      if (this.options.autoQualityCheck && this.components.qualityManager) {
        const baseTranslation = this.components.i18nManager.t(key, { language: 'en' });
        
        // Perform quality assessment asynchronously
        setImmediate(() => {
          this.components.qualityManager.assessTranslationQuality(
            baseTranslation,
            translation,
            this.currentLanguage,
            options.context || {}
          );
        });
      }
      
      // Update metrics
      const duration = performance.now() - startTime;
      this.updateTranslationMetrics(duration);
      
      return translation;
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'enhanced-i18n',
        category: ErrorCategory.TRANSLATION,
        key,
        language: this.currentLanguage
      });
      
      // Fallback to key or basic translation
      return this.components.i18nManager.t(key, options) || key;
    }
  }
  
  /**
   * Switch language with enhanced features
   */
  async switchLanguage(languageCode, options = {}) {
    try {
      if (this.components.languageSwitcher) {
        await this.components.languageSwitcher.switchLanguage(languageCode, options);
      } else {
        await this.components.i18nManager.setLanguage(languageCode);
        this.currentLanguage = languageCode;
      }
      
      this.emit('language:switched', {
        from: this.currentLanguage,
        to: languageCode,
        timestamp: Date.now()
      });
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'enhanced-i18n',
        category: ErrorCategory.OPERATION,
        language: languageCode
      });
      throw error;
    }
  }
  
  /**
   * Load translations dynamically
   */
  async loadTranslations(languageCode, namespace = 'common', options = {}) {
    if (this.components.dynamicLoader) {
      return await this.components.dynamicLoader.loadTranslations(languageCode, namespace, options);
    } else {
      return await this.components.i18nManager.loadLanguage(languageCode);
    }
  }
  
  /**
   * Assess translation quality
   */
  async assessQuality(originalText, translatedText, languageCode, context = {}) {
    if (!this.components.qualityManager) {
      throw new OtedamaError(
        'Quality management is not enabled',
        ErrorCategory.FEATURE_DISABLED
      );
    }
    
    return await this.components.qualityManager.assessTranslationQuality(
      originalText,
      translatedText,
      languageCode,
      context
    );
  }
  
  /**
   * Update user context profile
   */
  updateUserProfile(userId, profile) {
    if (this.components.contextualSystem) {
      this.components.contextualSystem.updateUserProfile(userId, profile);
    }
  }
  
  /**
   * Create language selector UI
   */
  createLanguageSelector(container, options = {}) {
    if (!this.components.languageSwitcher) {
      throw new OtedamaError(
        'Realtime language switching is not enabled',
        ErrorCategory.FEATURE_DISABLED
      );
    }
    
    return this.components.languageSwitcher.createLanguageSelector(container, options);
  }
  
  /**
   * Get comprehensive system status
   */
  getSystemStatus() {
    const status = {
      initialized: this.isInitialized,
      currentLanguage: this.currentLanguage,
      enabledFeatures: this.getEnabledFeatures(),
      metrics: { ...this.metrics },
      components: {}
    };
    
    // Get component-specific status
    Object.entries(this.components).forEach(([name, component]) => {
      if (component.getStats) {
        status.components[name] = component.getStats();
      } else if (component.getMetrics) {
        status.components[name] = component.getMetrics();
      } else {
        status.components[name] = { active: true };
      }
    });
    
    return status;
  }
  
  /**
   * Get available languages with metadata
   */
  getAvailableLanguages() {
    if (this.components.languageSwitcher) {
      return this.components.languageSwitcher.getAvailableLanguages();
    } else {
      return this.components.i18nManager.getAvailableLanguages();
    }
  }
  
  /**
   * Get quality report
   */
  getQualityReport(languageCode = null) {
    if (!this.components.qualityManager) {
      return { error: 'Quality management not enabled' };
    }
    
    return this.components.qualityManager.getQualityReport(languageCode);
  }
  
  /**
   * Get context analytics
   */
  getContextAnalytics() {
    if (!this.components.contextualSystem) {
      return { error: 'Contextual translation not enabled' };
    }
    
    return this.components.contextualSystem.getContextAnalytics();
  }
  
  /**
   * Preload common languages
   */
  async preloadLanguages(languages = ['en', 'ja', 'zh', 'es']) {
    const preloadPromises = languages.map(async (lang) => {
      try {
        await this.loadTranslations(lang, 'common');
        return { language: lang, success: true };
      } catch (error) {
        return { language: lang, success: false, error: error.message };
      }
    });
    
    const results = await Promise.all(preloadPromises);
    
    this.emit('languages:preloaded', {
      results,
      successCount: results.filter(r => r.success).length
    });
    
    return results;
  }
  
  /**
   * Clear all caches
   */
  clearCaches() {
    Object.values(this.components).forEach(component => {
      if (component.clearCache) {
        component.clearCache();
      }
    });
    
    this.emit('caches:cleared', { timestamp: Date.now() });
  }
  
  /**
   * Export system configuration
   */
  exportConfiguration() {
    return {
      options: { ...this.options },
      currentLanguage: this.currentLanguage,
      enabledFeatures: this.getEnabledFeatures(),
      componentConfigs: this.getComponentConfigurations()
    };
  }
  
  /**
   * Import system configuration
   */
  async importConfiguration(config) {
    try {
      // Update options
      Object.assign(this.options, config.options);
      
      // Switch to configured language
      if (config.currentLanguage && config.currentLanguage !== this.currentLanguage) {
        await this.switchLanguage(config.currentLanguage);
      }
      
      // Apply component configurations
      if (config.componentConfigs) {
        await this.applyComponentConfigurations(config.componentConfigs);
      }
      
      this.emit('configuration:imported', { config });
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'enhanced-i18n',
        category: ErrorCategory.CONFIGURATION
      });
      throw error;
    }
  }
  
  /**
   * Check if options contain contextual information
   */
  hasContextualOptions(options) {
    const contextualKeys = ['domain', 'audience', 'formality', 'context', 'userId'];
    return contextualKeys.some(key => options.hasOwnProperty(key));
  }
  
  /**
   * Update translation metrics
   */
  updateTranslationMetrics(duration) {
    this.metrics.translationRequests++;
    this.metrics.totalResponseTime += duration;
    this.metrics.averageResponseTime = this.metrics.totalResponseTime / this.metrics.translationRequests;
  }
  
  /**
   * Get enabled features
   */
  getEnabledFeatures() {
    return {
      realtimeSwitching: this.options.enableRealtimeSwitching,
      dynamicLoading: this.options.enableDynamicLoading,
      qualityManagement: this.options.enableQualityManagement,
      contextualTranslation: this.options.enableContextualTranslation,
      caching: this.options.enableCaching,
      preloading: this.options.enablePreloading,
      autoUpdateUI: this.options.autoUpdateUI,
      directionSupport: this.options.enableDirectionSupport
    };
  }
  
  /**
   * Get component configurations
   */
  getComponentConfigurations() {
    const configs = {};
    
    Object.entries(this.components).forEach(([name, component]) => {
      if (component.options) {
        configs[name] = { ...component.options };
      }
    });
    
    return configs;
  }
  
  /**
   * Apply component configurations
   */
  async applyComponentConfigurations(configs) {
    for (const [componentName, config] of Object.entries(configs)) {
      const component = this.components[componentName];
      if (component && component.updateConfiguration) {
        await component.updateConfiguration(config);
      }
    }
  }
  
  /**
   * Format number with localization
   */
  formatNumber(number, options = {}) {
    return this.components.i18nManager.formatNumber(number, options);
  }
  
  /**
   * Format date with localization
   */
  formatDate(date, options = {}) {
    return this.components.i18nManager.formatDate(date, options);
  }
  
  /**
   * Format currency with localization
   */
  formatCurrency(amount, currency, options = {}) {
    return this.components.i18nManager.formatCurrency(amount, currency, options);
  }
  
  /**
   * Get current language direction
   */
  getLanguageDirection() {
    return this.components.i18nManager.getLanguageDirection(this.currentLanguage);
  }
  
  /**
   * Cleanup and destroy system
   */
  destroy() {
    // Cleanup all components
    Object.values(this.components).forEach(component => {
      if (component.destroy) {
        component.destroy();
      }
    });
    
    // Clear all data
    this.components = {};
    this.metrics = {};
    
    // Remove all listeners
    this.removeAllListeners();
    
    this.emit('destroyed', { timestamp: Date.now() });
  }
}

// Global instance management
let globalEnhancedI18n = null;

/**
 * Get global enhanced i18n instance
 */
export function getEnhancedI18n() {
  if (!globalEnhancedI18n) {
    globalEnhancedI18n = new EnhancedI18nSystem();
  }
  return globalEnhancedI18n;
}

/**
 * Initialize global enhanced i18n
 */
export async function initEnhancedI18n(options = {}) {
  globalEnhancedI18n = new EnhancedI18nSystem(options);
  await globalEnhancedI18n.initialize();
  return globalEnhancedI18n;
}

/**
 * Enhanced translate function shorthand
 */
export function t(key, options = {}) {
  return getEnhancedI18n().t(key, options);
}

/**
 * Switch language shorthand
 */
export async function switchLanguage(languageCode, options = {}) {
  return await getEnhancedI18n().switchLanguage(languageCode, options);
}

export default EnhancedI18nSystem;