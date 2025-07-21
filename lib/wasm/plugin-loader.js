/**
 * WebAssembly Plugin Loader for Otedama
 * Dynamic plugin loading and management
 * 
 * Design principles:
 * - Carmack: Fast plugin loading
 * - Martin: Clean plugin lifecycle
 * - Pike: Simple plugin management
 */

import { EventEmitter } from 'events';
import { watch } from 'fs/promises';
import { join } from 'path';
import { logger } from '../core/logger.js';
import { WasmPluginSystem } from './plugin-system.js';

/**
 * Plugin loader configuration
 */
export class PluginLoaderConfig {
  constructor(config = {}) {
    this.watchDirectories = config.watchDirectories !== false;
    this.hotReload = config.hotReload !== false;
    this.autoRecover = config.autoRecover !== false;
    this.pluginTimeout = config.pluginTimeout || 30000;
    this.maxRetries = config.maxRetries || 3;
    this.retryDelay = config.retryDelay || 1000;
  }
}

/**
 * Plugin dependency resolver
 */
export class PluginDependencyResolver {
  constructor() {
    this.dependencies = new Map();
    this.resolved = new Set();
  }
  
  /**
   * Add plugin dependencies
   */
  addPlugin(pluginId, dependencies = []) {
    this.dependencies.set(pluginId, dependencies);
  }
  
  /**
   * Resolve load order
   */
  resolveLoadOrder() {
    const order = [];
    const visited = new Set();
    const visiting = new Set();
    
    const visit = (pluginId) => {
      if (visited.has(pluginId)) return;
      if (visiting.has(pluginId)) {
        throw new Error(`Circular dependency detected: ${pluginId}`);
      }
      
      visiting.add(pluginId);
      
      const deps = this.dependencies.get(pluginId) || [];
      for (const dep of deps) {
        visit(dep);
      }
      
      visiting.delete(pluginId);
      visited.add(pluginId);
      order.push(pluginId);
    };
    
    for (const pluginId of this.dependencies.keys()) {
      visit(pluginId);
    }
    
    return order;
  }
  
  /**
   * Check if dependencies are satisfied
   */
  checkDependencies(pluginId, loadedPlugins) {
    const deps = this.dependencies.get(pluginId) || [];
    return deps.every(dep => loadedPlugins.has(dep));
  }
}

/**
 * Plugin loader
 */
export class WasmPluginLoader extends EventEmitter {
  constructor(pluginSystem, config = {}) {
    super();
    
    this.pluginSystem = pluginSystem;
    this.config = new PluginLoaderConfig(config);
    
    // Plugin state
    this.loadedPlugins = new Map();
    this.failedPlugins = new Map();
    this.watchHandlers = new Map();
    
    // Dependency resolver
    this.dependencyResolver = new PluginDependencyResolver();
    
    // Loading queue
    this.loadQueue = [];
    this.isProcessingQueue = false;
    
    // Metrics
    this.metrics = {
      pluginsLoaded: 0,
      pluginsFailed: 0,
      reloads: 0,
      recoveries: 0
    };
  }
  
  /**
   * Start plugin loader
   */
  async start() {
    logger.info('Starting WebAssembly plugin loader');
    
    // Initialize plugin system
    await this.pluginSystem.initialize();
    
    // Start directory watching
    if (this.config.watchDirectories) {
      await this._startWatching();
    }
    
    // Start queue processor
    this._startQueueProcessor();
    
    this.emit('started');
  }
  
  /**
   * Stop plugin loader
   */
  async stop() {
    logger.info('Stopping WebAssembly plugin loader');
    
    // Stop watching
    for (const [dir, controller] of this.watchHandlers) {
      controller.abort();
    }
    this.watchHandlers.clear();
    
    // Clear queue
    this.loadQueue = [];
    
    this.emit('stopped');
  }
  
  /**
   * Load plugin with dependencies
   */
  async loadPlugin(pluginPath, manifest = null) {
    const loadRequest = {
      path: pluginPath,
      manifest,
      retries: 0,
      priority: 0
    };
    
    // Add to queue
    this.loadQueue.push(loadRequest);
    
    // Process queue
    await this._processQueue();
  }
  
  /**
   * Unload plugin
   */
  async unloadPlugin(pluginId) {
    try {
      await this.pluginSystem.unloadPlugin(pluginId);
      this.loadedPlugins.delete(pluginId);
      
      this.emit('plugin:unloaded', { pluginId });
      
    } catch (error) {
      logger.error(`Failed to unload plugin ${pluginId}:`, error);
      throw error;
    }
  }
  
  /**
   * Reload plugin
   */
  async reloadPlugin(pluginId) {
    const pluginInfo = this.loadedPlugins.get(pluginId);
    if (!pluginInfo) {
      throw new Error(`Plugin not loaded: ${pluginId}`);
    }
    
    logger.info(`Reloading plugin: ${pluginId}`);
    
    try {
      // Unload existing
      await this.unloadPlugin(pluginId);
      
      // Reload
      await this.loadPlugin(pluginInfo.path, pluginInfo.manifest);
      
      this.metrics.reloads++;
      
      this.emit('plugin:reloaded', { pluginId });
      
    } catch (error) {
      logger.error(`Failed to reload plugin ${pluginId}:`, error);
      
      if (this.config.autoRecover) {
        await this._recoverPlugin(pluginId, pluginInfo);
      }
      
      throw error;
    }
  }
  
  /**
   * Start watching plugin directories
   */
  async _startWatching() {
    for (const dir of this.pluginSystem.options.pluginDirs) {
      try {
        const controller = new AbortController();
        this.watchHandlers.set(dir, controller);
        
        this._watchDirectory(dir, controller.signal);
        
        logger.info(`Watching plugin directory: ${dir}`);
      } catch (error) {
        logger.error(`Failed to watch directory ${dir}:`, error);
      }
    }
  }
  
  /**
   * Watch directory for changes
   */
  async _watchDirectory(directory, signal) {
    try {
      const watcher = watch(directory, { signal, recursive: true });
      
      for await (const event of watcher) {
        this._handleFileChange(directory, event);
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        logger.error(`Watch error for ${directory}:`, error);
      }
    }
  }
  
  /**
   * Handle file change event
   */
  async _handleFileChange(directory, event) {
    const { filename, eventType } = event;
    
    // Only handle WASM and manifest files
    if (!filename.endsWith('.wasm') && !filename.endsWith('plugin.json')) {
      return;
    }
    
    const filepath = join(directory, filename);
    
    logger.debug(`File ${eventType}: ${filepath}`);
    
    // Find affected plugin
    const pluginId = this._findPluginByPath(filepath);
    
    if (pluginId && this.config.hotReload) {
      // Debounce reloads
      if (this._reloadTimers?.has(pluginId)) {
        clearTimeout(this._reloadTimers.get(pluginId));
      }
      
      if (!this._reloadTimers) {
        this._reloadTimers = new Map();
      }
      
      const timer = setTimeout(() => {
        this.reloadPlugin(pluginId).catch(error => {
          logger.error(`Auto-reload failed for ${pluginId}:`, error);
        });
        this._reloadTimers.delete(pluginId);
      }, 1000);
      
      this._reloadTimers.set(pluginId, timer);
    }
  }
  
  /**
   * Find plugin by file path
   */
  _findPluginByPath(filepath) {
    for (const [pluginId, info] of this.loadedPlugins) {
      if (info.path === filepath || filepath.includes(pluginId)) {
        return pluginId;
      }
    }
    return null;
  }
  
  /**
   * Start queue processor
   */
  _startQueueProcessor() {
    setInterval(() => {
      if (this.loadQueue.length > 0 && !this.isProcessingQueue) {
        this._processQueue();
      }
    }, 100);
  }
  
  /**
   * Process load queue
   */
  async _processQueue() {
    if (this.isProcessingQueue || this.loadQueue.length === 0) return;
    
    this.isProcessingQueue = true;
    
    try {
      // Sort by priority
      this.loadQueue.sort((a, b) => b.priority - a.priority);
      
      while (this.loadQueue.length > 0) {
        const request = this.loadQueue.shift();
        
        try {
          await this._loadPluginInternal(request);
        } catch (error) {
          await this._handleLoadError(request, error);
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }
  
  /**
   * Internal plugin loading
   */
  async _loadPluginInternal(request) {
    const { path, manifest } = request;
    
    // Load manifest if not provided
    let pluginManifest = manifest;
    if (!pluginManifest) {
      pluginManifest = await this.pluginSystem._loadManifest(path);
    }
    
    // Check dependencies
    const dependencies = pluginManifest.dependencies || [];
    this.dependencyResolver.addPlugin(pluginManifest.id, dependencies);
    
    if (!this.dependencyResolver.checkDependencies(pluginManifest.id, this.loadedPlugins)) {
      // Re-queue with higher priority
      request.priority++;
      this.loadQueue.push(request);
      return;
    }
    
    // Load plugin
    await this.pluginSystem.loadPlugin(path);
    
    // Track loaded plugin
    this.loadedPlugins.set(pluginManifest.id, {
      path,
      manifest: pluginManifest,
      loadTime: Date.now(),
      dependencies
    });
    
    this.metrics.pluginsLoaded++;
    
    this.emit('plugin:loaded', {
      pluginId: pluginManifest.id,
      path
    });
    
    logger.info(`Plugin loaded: ${pluginManifest.id}`);
  }
  
  /**
   * Handle load error
   */
  async _handleLoadError(request, error) {
    logger.error(`Failed to load plugin from ${request.path}:`, error);
    
    request.retries++;
    
    if (request.retries < this.config.maxRetries) {
      // Retry with delay
      setTimeout(() => {
        this.loadQueue.push(request);
      }, this.config.retryDelay * request.retries);
      
      this.emit('plugin:retry', {
        path: request.path,
        attempt: request.retries,
        error: error.message
      });
    } else {
      // Max retries reached
      this.failedPlugins.set(request.path, {
        error: error.message,
        attempts: request.retries,
        timestamp: Date.now()
      });
      
      this.metrics.pluginsFailed++;
      
      this.emit('plugin:failed', {
        path: request.path,
        error: error.message
      });
    }
  }
  
  /**
   * Recover failed plugin
   */
  async _recoverPlugin(pluginId, pluginInfo) {
    logger.info(`Attempting to recover plugin: ${pluginId}`);
    
    try {
      // Wait before recovery
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Try to reload
      await this.loadPlugin(pluginInfo.path, pluginInfo.manifest);
      
      this.metrics.recoveries++;
      
      this.emit('plugin:recovered', { pluginId });
      
      logger.info(`Plugin recovered: ${pluginId}`);
      
    } catch (error) {
      logger.error(`Failed to recover plugin ${pluginId}:`, error);
      
      this.emit('plugin:recovery-failed', {
        pluginId,
        error: error.message
      });
    }
  }
  
  /**
   * Get loader status
   */
  getStatus() {
    return {
      loaded: Array.from(this.loadedPlugins.entries()).map(([id, info]) => ({
        id,
        path: info.path,
        loadTime: info.loadTime,
        dependencies: info.dependencies
      })),
      failed: Array.from(this.failedPlugins.entries()).map(([path, info]) => ({
        path,
        error: info.error,
        attempts: info.attempts,
        timestamp: info.timestamp
      })),
      queueLength: this.loadQueue.length,
      metrics: this.metrics,
      config: {
        watchDirectories: this.config.watchDirectories,
        hotReload: this.config.hotReload,
        autoRecover: this.config.autoRecover
      }
    };
  }
}

export default WasmPluginLoader;