/**
 * Dynamic Translation Loader
 * 
 * Advanced translation loading with caching, chunking, and fallbacks
 * Following Pike's simplicity principles with Carmack's performance focus
 */

import { EventEmitter } from 'events';
import { readFile, writeFile, mkdir, existsSync } from 'fs/promises';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../error-handler.js';

export class DynamicTranslationLoader extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      baseUrl: options.baseUrl || '/translations',
      localPath: options.localPath || './translations',
      enableCaching: options.enableCaching !== false,
      enableChunking: options.enableChunking !== false,
      enableCompression: options.enableCompression !== false,
      cacheExpiry: options.cacheExpiry || 24 * 60 * 60 * 1000, // 24 hours
      chunkSize: options.chunkSize || 50, // Keys per chunk
      maxCacheSize: options.maxCacheSize || 100 * 1024 * 1024, // 100MB
      retryAttempts: options.retryAttempts || 3,
      retryDelay: options.retryDelay || 1000,
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.cache = new Map();
    this.loadingPromises = new Map();
    this.chunks = new Map();
    this.metadata = new Map();
    
    // Performance metrics
    this.metrics = {
      totalLoads: 0,
      cacheHits: 0,
      cacheMisses: 0,
      networkRequests: 0,
      bytesLoaded: 0,
      loadTime: 0
    };
    
    this.initialize();
  }
  
  /**
   * Initialize loader
   */
  async initialize() {
    try {
      // Ensure local path exists
      if (!existsSync(this.options.localPath)) {
        await mkdir(this.options.localPath, { recursive: true });
      }
      
      // Load metadata
      await this.loadMetadata();
      
      // Setup cache cleanup
      this.setupCacheCleanup();
      
      this.emit('initialized');
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'translation-loader',
        category: ErrorCategory.INITIALIZATION
      });
    }
  }
  
  /**
   * Load translations for language
   */
  async loadTranslations(languageCode, namespace = 'common', options = {}) {
    const startTime = performance.now();
    this.metrics.totalLoads++;
    
    try {
      const cacheKey = `${languageCode}:${namespace}`;
      
      // Check cache first
      if (this.options.enableCaching && this.cache.has(cacheKey)) {
        const cached = this.cache.get(cacheKey);
        
        // Check if cache is still valid
        if (Date.now() - cached.timestamp < this.options.cacheExpiry) {
          this.metrics.cacheHits++;
          
          this.emit('translations:loaded', {
            language: languageCode,
            namespace,
            source: 'cache',
            duration: performance.now() - startTime
          });
          
          return cached.data;
        } else {
          // Remove expired cache
          this.cache.delete(cacheKey);
        }
      }
      
      this.metrics.cacheMisses++;
      
      // Check if already loading
      if (this.loadingPromises.has(cacheKey)) {
        return await this.loadingPromises.get(cacheKey);
      }
      
      // Create loading promise
      const loadingPromise = this.performLoad(languageCode, namespace, options);
      this.loadingPromises.set(cacheKey, loadingPromise);
      
      try {
        const translations = await loadingPromise;
        
        // Cache the result
        if (this.options.enableCaching) {
          this.cacheTranslations(cacheKey, translations);
        }
        
        this.metrics.loadTime += performance.now() - startTime;
        
        this.emit('translations:loaded', {
          language: languageCode,
          namespace,
          source: 'network',
          duration: performance.now() - startTime,
          size: JSON.stringify(translations).length
        });
        
        return translations;
        
      } finally {
        this.loadingPromises.delete(cacheKey);
      }
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'translation-loader',
        category: ErrorCategory.NETWORK,
        language: languageCode,
        namespace
      });
      
      // Try fallback
      return await this.loadFallback(languageCode, namespace);
    }
  }
  
  /**
   * Perform actual loading
   */
  async performLoad(languageCode, namespace, options) {
    // Try multiple sources in order
    const sources = [
      () => this.loadFromRemote(languageCode, namespace, options),
      () => this.loadFromLocal(languageCode, namespace),
      () => this.loadFromBundle(languageCode, namespace)
    ];
    
    let lastError;
    
    for (const source of sources) {
      try {
        const result = await this.retryOperation(source, this.options.retryAttempts);
        if (result) {
          return result;
        }
      } catch (error) {
        lastError = error;
        continue;
      }
    }
    
    throw lastError || new OtedamaError(
      `Failed to load translations for ${languageCode}:${namespace}`,
      ErrorCategory.NOT_FOUND
    );
  }
  
  /**
   * Load from remote URL
   */
  async loadFromRemote(languageCode, namespace, options) {
    if (typeof fetch === 'undefined') {
      throw new Error('Fetch not available');
    }
    
    const url = options.chunked ? 
      `${this.options.baseUrl}/${languageCode}/${namespace}/chunks` :
      `${this.options.baseUrl}/${languageCode}/${namespace}.json`;
    
    this.metrics.networkRequests++;
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': this.options.enableCompression ? 'gzip, deflate' : 'identity'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    this.metrics.bytesLoaded += JSON.stringify(data).length;
    
    // Save to local cache
    await this.saveToLocal(languageCode, namespace, data);
    
    return data;
  }
  
  /**
   * Load from local file system
   */
  async loadFromLocal(languageCode, namespace) {
    const filePath = join(this.options.localPath, `${languageCode}-${namespace}.json`);
    
    if (!existsSync(filePath)) {
      throw new Error('Local file not found');
    }
    
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content);
  }
  
  /**
   * Load from embedded bundle
   */
  async loadFromBundle(languageCode, namespace) {
    // Try to load from embedded translations
    try {
      const bundlePath = join(__dirname, 'locales', `${languageCode}.json`);
      const content = await readFile(bundlePath, 'utf8');
      const bundle = JSON.parse(content);
      
      return bundle[namespace] || bundle;
    } catch (error) {
      throw new Error('Bundle not available');
    }
  }
  
  /**
   * Load fallback translations
   */
  async loadFallback(languageCode, namespace) {
    // Try English as fallback
    if (languageCode !== 'en') {
      try {
        return await this.loadTranslations('en', namespace, { fallback: true });
      } catch (error) {
        // Ignore fallback errors
      }
    }
    
    // Return minimal fallback
    return this.getMinimalFallback(namespace);
  }
  
  /**
   * Get minimal fallback translations
   */
  getMinimalFallback(namespace) {
    const fallbacks = {
      common: {
        loading: 'Loading...',
        error: 'Error',
        success: 'Success',
        cancel: 'Cancel',
        confirm: 'Confirm'
      },
      mining: {
        hashrate: 'Hashrate',
        difficulty: 'Difficulty',
        shares: 'Shares'
      },
      dex: {
        buy: 'Buy',
        sell: 'Sell',
        price: 'Price'
      }
    };
    
    return fallbacks[namespace] || {};
  }
  
  /**
   * Save translations to local cache
   */
  async saveToLocal(languageCode, namespace, data) {
    try {
      const filePath = join(this.options.localPath, `${languageCode}-${namespace}.json`);
      await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      // Ignore save errors
    }
  }
  
  /**
   * Cache translations in memory
   */
  cacheTranslations(key, data) {
    const size = JSON.stringify(data).length;
    
    // Check cache size limit
    if (this.getCacheSize() + size > this.options.maxCacheSize) {
      this.evictOldestCache();
    }
    
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      size,
      accessCount: 1
    });
  }
  
  /**
   * Get total cache size
   */
  getCacheSize() {
    let totalSize = 0;
    for (const cached of this.cache.values()) {
      totalSize += cached.size;
    }
    return totalSize;
  }
  
  /**
   * Evict oldest cache entries
   */
  evictOldestCache() {
    const entries = Array.from(this.cache.entries());
    
    // Sort by timestamp (oldest first)
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    // Remove oldest 25%
    const toRemove = Math.floor(entries.length * 0.25) || 1;
    
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(entries[i][0]);
    }
    
    this.emit('cache:evicted', {
      removed: toRemove,
      remaining: this.cache.size
    });
  }
  
  /**
   * Load chunked translations
   */
  async loadChunkedTranslations(languageCode, namespace, chunkIds = []) {
    const translations = {};
    
    const chunkPromises = chunkIds.map(async (chunkId) => {
      const chunkKey = `${languageCode}:${namespace}:${chunkId}`;
      
      if (this.chunks.has(chunkKey)) {
        return this.chunks.get(chunkKey);
      }
      
      const chunk = await this.loadChunk(languageCode, namespace, chunkId);
      this.chunks.set(chunkKey, chunk);
      
      return chunk;
    });
    
    const chunks = await Promise.all(chunkPromises);
    
    // Merge chunks
    chunks.forEach(chunk => {
      Object.assign(translations, chunk);
    });
    
    return translations;
  }
  
  /**
   * Load individual chunk
   */
  async loadChunk(languageCode, namespace, chunkId) {
    const url = `${this.options.baseUrl}/${languageCode}/${namespace}/chunk-${chunkId}.json`;
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load chunk ${chunkId}`);
    }
    
    return await response.json();
  }
  
  /**
   * Preload translations
   */
  async preloadTranslations(languages, namespaces = ['common']) {
    const preloadPromises = [];
    
    languages.forEach(lang => {
      namespaces.forEach(ns => {
        preloadPromises.push(
          this.loadTranslations(lang, ns).catch(() => {})
        );
      });
    });
    
    await Promise.all(preloadPromises);
    
    this.emit('translations:preloaded', {
      languages,
      namespaces,
      count: preloadPromises.length
    });
  }
  
  /**
   * Get chunk info for namespace
   */
  async getChunkInfo(languageCode, namespace) {
    const infoUrl = `${this.options.baseUrl}/${languageCode}/${namespace}/info.json`;
    
    try {
      const response = await fetch(infoUrl);
      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      // Ignore errors
    }
    
    return null;
  }
  
  /**
   * Load metadata about available translations
   */
  async loadMetadata() {
    try {
      const metadataUrl = `${this.options.baseUrl}/metadata.json`;
      const response = await fetch(metadataUrl);
      
      if (response.ok) {
        const metadata = await response.json();
        
        Object.entries(metadata).forEach(([key, value]) => {
          this.metadata.set(key, value);
        });
        
        this.emit('metadata:loaded', { count: this.metadata.size });
      }
    } catch (error) {
      // Ignore metadata errors
    }
  }
  
  /**
   * Setup cache cleanup interval
   */
  setupCacheCleanup() {
    setInterval(() => {
      this.cleanupExpiredCache();
    }, 60 * 60 * 1000); // Every hour
  }
  
  /**
   * Clean up expired cache entries
   */
  cleanupExpiredCache() {
    const now = Date.now();
    let removedCount = 0;
    
    for (const [key, cached] of this.cache.entries()) {
      if (now - cached.timestamp > this.options.cacheExpiry) {
        this.cache.delete(key);
        removedCount++;
      }
    }
    
    if (removedCount > 0) {
      this.emit('cache:cleaned', {
        removed: removedCount,
        remaining: this.cache.size
      });
    }
  }
  
  /**
   * Retry operation with exponential backoff
   */
  async retryOperation(operation, maxAttempts) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        
        if (attempt < maxAttempts) {
          const delay = this.options.retryDelay * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError;
  }
  
  /**
   * Get loader statistics
   */
  getStats() {
    return {
      ...this.metrics,
      cacheSize: this.cache.size,
      cacheSizeBytes: this.getCacheSize(),
      chunksLoaded: this.chunks.size,
      metadataEntries: this.metadata.size
    };
  }
  
  /**
   * Clear all caches
   */
  clearCache() {
    this.cache.clear();
    this.chunks.clear();
    this.loadingPromises.clear();
    
    this.emit('cache:cleared');
  }
  
  /**
   * Get cache info
   */
  getCacheInfo() {
    const info = [];
    
    for (const [key, cached] of this.cache.entries()) {
      info.push({
        key,
        size: cached.size,
        timestamp: cached.timestamp,
        accessCount: cached.accessCount,
        age: Date.now() - cached.timestamp
      });
    }
    
    return info.sort((a, b) => b.timestamp - a.timestamp);
  }
}

export default DynamicTranslationLoader;