/**
 * Real-time Language Switcher
 * 
 * Advanced language switching with hot reloading and UI updates
 * Following Carmack's performance-first principles
 */

import { EventEmitter } from 'events';
import { I18nManager, SupportedLanguages } from './i18n-manager.js';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../core/standardized-error-handler.js';

export class RealtimeLanguageSwitcher extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      autoUpdateUI: options.autoUpdateUI !== false,
      hotReload: options.hotReload !== false,
      preloadLanguages: options.preloadLanguages || ['en', 'ja', 'zh', 'es'],
      transitionDuration: options.transitionDuration || 300,
      enableDirection: options.enableDirection !== false,
      savePreference: options.savePreference !== false,
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.i18n = null;
    this.currentLanguage = 'en';
    this.preloadedLanguages = new Set();
    this.uiElements = new Map();
    this.directionObserver = null;
    
    // Performance tracking
    this.metrics = {
      switchTime: 0,
      preloadTime: 0,
      uiUpdateTime: 0,
      totalSwitches: 0
    };
    
    this.initialize();
  }
  
  /**
   * Initialize language switcher
   */
  async initialize() {
    try {
      // Create or get i18n manager
      this.i18n = this.options.i18nManager || new I18nManager();
      
      // Listen to language changes
      this.i18n.on('language:changed', this.handleLanguageChange.bind(this));
      
      // Preload common languages
      await this.preloadLanguages();
      
      // Setup UI auto-update if enabled
      if (this.options.autoUpdateUI) {
        this.setupUIAutoUpdate();
      }
      
      // Setup direction support
      if (this.options.enableDirection) {
        this.setupDirectionSupport();
      }
      
      // Load saved preference
      if (this.options.savePreference) {
        await this.loadSavedLanguage();
      }
      
      this.emit('initialized', {
        currentLanguage: this.currentLanguage,
        preloadedLanguages: Array.from(this.preloadedLanguages)
      });
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'language-switcher',
        category: ErrorCategory.INITIALIZATION
      });
    }
  }
  
  /**
   * Preload commonly used languages
   */
  async preloadLanguages() {
    const startTime = performance.now();
    
    try {
      const preloadPromises = this.options.preloadLanguages.map(async (lang) => {
        if (SupportedLanguages[lang] && !this.preloadedLanguages.has(lang)) {
          await this.i18n.loadLanguage(lang);
          this.preloadedLanguages.add(lang);
        }
      });
      
      await Promise.all(preloadPromises);
      
      this.metrics.preloadTime = performance.now() - startTime;
      
      this.emit('languages:preloaded', {
        languages: Array.from(this.preloadedLanguages),
        duration: this.metrics.preloadTime
      });
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'language-switcher',
        category: ErrorCategory.PERFORMANCE
      });
    }
  }
  
  /**
   * Switch language with performance tracking
   */
  async switchLanguage(languageCode, options = {}) {
    const startTime = performance.now();
    
    try {
      // Validate language
      if (!SupportedLanguages[languageCode]) {
        throw new OtedamaError(
          `Unsupported language: ${languageCode}`,
          ErrorCategory.VALIDATION,
          { availableLanguages: Object.keys(SupportedLanguages) }
        );
      }
      
      // Check if already current language
      if (languageCode === this.currentLanguage && !options.force) {
        return;
      }
      
      const previousLanguage = this.currentLanguage;
      
      // Emit switching event
      this.emit('language:switching', {
        from: previousLanguage,
        to: languageCode,
        timestamp: Date.now()
      });
      
      // Load language if not preloaded
      if (!this.preloadedLanguages.has(languageCode)) {
        await this.i18n.loadLanguage(languageCode);
        this.preloadedLanguages.add(languageCode);
      }
      
      // Switch language in i18n manager
      await this.i18n.setLanguage(languageCode);
      this.currentLanguage = languageCode;
      
      // Update UI if enabled
      if (this.options.autoUpdateUI) {
        await this.updateUI(languageCode);
      }
      
      // Update document direction
      if (this.options.enableDirection) {
        this.updateDocumentDirection(languageCode);
      }
      
      // Save preference if enabled
      if (this.options.savePreference) {
        this.saveLanguagePreference(languageCode);
      }
      
      // Update metrics
      this.metrics.switchTime = performance.now() - startTime;
      this.metrics.totalSwitches++;
      
      this.emit('language:switched', {
        from: previousLanguage,
        to: languageCode,
        duration: this.metrics.switchTime,
        timestamp: Date.now()
      });
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'language-switcher',
        category: ErrorCategory.OPERATION,
        language: languageCode
      });
      throw error;
    }
  }
  
  /**
   * Setup automatic UI updates
   */
  setupUIAutoUpdate() {
    // Find all translatable elements
    this.scanTranslatableElements();
    
    // Setup mutation observer for dynamic content
    if (typeof window !== 'undefined' && window.MutationObserver) {
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === 'childList') {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === Node.ELEMENT_NODE) {
                this.scanElementForTranslatables(node);
              }
            });
          }
        });
      });
      
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
  }
  
  /**
   * Scan document for translatable elements
   */
  scanTranslatableElements() {
    if (typeof document === 'undefined') return;
    
    // Find elements with data-i18n attribute
    const translatableElements = document.querySelectorAll('[data-i18n]');
    
    translatableElements.forEach((element) => {
      const key = element.getAttribute('data-i18n');
      const attribute = element.getAttribute('data-i18n-attr') || 'textContent';
      
      this.uiElements.set(element, {
        key,
        attribute,
        originalValue: element[attribute]
      });
    });
  }
  
  /**
   * Scan specific element for translatables
   */
  scanElementForTranslatables(element) {
    if (!element.querySelectorAll) return;
    
    const translatableElements = element.querySelectorAll('[data-i18n]');
    
    translatableElements.forEach((el) => {
      const key = el.getAttribute('data-i18n');
      const attribute = el.getAttribute('data-i18n-attr') || 'textContent';
      
      if (!this.uiElements.has(el)) {
        this.uiElements.set(el, {
          key,
          attribute,
          originalValue: el[attribute]
        });
        
        // Update immediately if not in default language
        if (this.currentLanguage !== 'en') {
          this.updateElement(el, key, attribute);
        }
      }
    });
  }
  
  /**
   * Update UI elements with new language
   */
  async updateUI(languageCode) {
    const startTime = performance.now();
    
    try {
      const updatePromises = [];
      
      this.uiElements.forEach((info, element) => {
        updatePromises.push(this.updateElement(element, info.key, info.attribute));
      });
      
      await Promise.all(updatePromises);
      
      this.metrics.uiUpdateTime = performance.now() - startTime;
      
      this.emit('ui:updated', {
        elementsUpdated: this.uiElements.size,
        duration: this.metrics.uiUpdateTime,
        language: languageCode
      });
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'language-switcher',
        category: ErrorCategory.UI,
        language: languageCode
      });
    }
  }
  
  /**
   * Update individual element
   */
  async updateElement(element, key, attribute) {
    try {
      // Add transition class for smooth updates
      if (this.options.transitionDuration > 0) {
        element.style.transition = `opacity ${this.options.transitionDuration}ms ease-in-out`;
        element.style.opacity = '0.7';
      }
      
      // Get translation
      const translation = this.i18n.t(key);
      
      // Update element
      if (attribute === 'textContent') {
        element.textContent = translation;
      } else if (attribute === 'innerHTML') {
        element.innerHTML = translation;
      } else {
        element.setAttribute(attribute, translation);
      }
      
      // Restore opacity
      if (this.options.transitionDuration > 0) {
        setTimeout(() => {
          element.style.opacity = '1';
        }, 50);
      }
      
    } catch (error) {
      // Fallback to original value or key
      if (attribute === 'textContent') {
        element.textContent = key.split('.').pop();
      }
    }
  }
  
  /**
   * Setup document direction support
   */
  setupDirectionSupport() {
    if (typeof document === 'undefined') return;
    
    // Create style element for RTL/LTR styles
    const styleElement = document.createElement('style');
    styleElement.id = 'i18n-direction-styles';
    styleElement.textContent = `
      [dir="rtl"] {
        text-align: right;
      }
      
      [dir="rtl"] .rtl-flip {
        transform: scaleX(-1);
      }
      
      [dir="rtl"] .margin-left {
        margin-right: var(--margin-value);
        margin-left: 0;
      }
      
      [dir="rtl"] .margin-right {
        margin-left: var(--margin-value);
        margin-right: 0;
      }
      
      [dir="rtl"] .float-left {
        float: right;
      }
      
      [dir="rtl"] .float-right {
        float: left;
      }
      
      [dir="ltr"] {
        text-align: left;
      }
    `;
    
    document.head.appendChild(styleElement);
  }
  
  /**
   * Update document direction based on language
   */
  updateDocumentDirection(languageCode) {
    if (typeof document === 'undefined') return;
    
    const direction = this.i18n.getLanguageDirection(languageCode);
    document.documentElement.setAttribute('dir', direction);
    document.documentElement.setAttribute('lang', languageCode);
    
    this.emit('direction:changed', {
      language: languageCode,
      direction,
      timestamp: Date.now()
    });
  }
  
  /**
   * Handle language change from i18n manager
   */
  handleLanguageChange(event) {
    this.currentLanguage = event.to;
    
    if (this.options.autoUpdateUI) {
      this.updateUI(event.to);
    }
    
    if (this.options.enableDirection) {
      this.updateDocumentDirection(event.to);
    }
  }
  
  /**
   * Save language preference
   */
  saveLanguagePreference(languageCode) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('otedama:language', languageCode);
      }
    } catch (error) {
      // Ignore storage errors
    }
  }
  
  /**
   * Load saved language preference
   */
  async loadSavedLanguage() {
    try {
      if (typeof localStorage !== 'undefined') {
        const savedLanguage = localStorage.getItem('otedama:language');
        if (savedLanguage && SupportedLanguages[savedLanguage]) {
          await this.switchLanguage(savedLanguage);
        }
      }
    } catch (error) {
      // Ignore errors and use default
    }
  }
  
  /**
   * Get available languages with metadata
   */
  getAvailableLanguages() {
    return Object.keys(SupportedLanguages).map(code => ({
      code,
      ...SupportedLanguages[code],
      preloaded: this.preloadedLanguages.has(code),
      current: code === this.currentLanguage
    }));
  }
  
  /**
   * Create language selector UI component
   */
  createLanguageSelector(container, options = {}) {
    if (typeof document === 'undefined') return null;
    
    const selectorOptions = {
      showNativeNames: options.showNativeNames !== false,
      showFlags: options.showFlags !== false,
      className: options.className || 'language-selector',
      onChange: options.onChange,
      ...options
    };
    
    const selector = document.createElement('select');
    selector.className = selectorOptions.className;
    
    // Add options for each language
    this.getAvailableLanguages().forEach(lang => {
      const option = document.createElement('option');
      option.value = lang.code;
      option.textContent = selectorOptions.showNativeNames ? 
        `${lang.nativeName} (${lang.name})` : 
        lang.name;
      
      if (lang.current) {
        option.selected = true;
      }
      
      selector.appendChild(option);
    });
    
    // Handle language change
    selector.addEventListener('change', async (event) => {
      const selectedLanguage = event.target.value;
      await this.switchLanguage(selectedLanguage);
      
      if (selectorOptions.onChange) {
        selectorOptions.onChange(selectedLanguage);
      }
    });
    
    // Append to container if provided
    if (container) {
      container.appendChild(selector);
    }
    
    return selector;
  }
  
  /**
   * Get performance metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      preloadedLanguages: Array.from(this.preloadedLanguages),
      currentLanguage: this.currentLanguage,
      trackedElements: this.uiElements.size
    };
  }
  
  /**
   * Reset metrics
   */
  resetMetrics() {
    this.metrics = {
      switchTime: 0,
      preloadTime: 0,
      uiUpdateTime: 0,
      totalSwitches: 0
    };
    
    this.emit('metrics:reset', { timestamp: Date.now() });
  }
  
  /**
   * Cleanup resources
   */
  destroy() {
    this.uiElements.clear();
    
    if (this.directionObserver) {
      this.directionObserver.disconnect();
    }
    
    this.removeAllListeners();
    
    this.emit('destroyed', { timestamp: Date.now() });
  }
}

export default RealtimeLanguageSwitcher;