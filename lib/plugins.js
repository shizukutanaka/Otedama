/**
 * Plugin System for Otedama
 * Enables extensibility through a modular plugin architecture
 */

import { EventEmitter } from 'events';
import { readdir, readFile } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';
import { Logger } from './logger.js';
import { existsSync } from 'fs';

/**
 * Plugin lifecycle states
 */
export const PluginState = {
  UNLOADED: 'unloaded',
  LOADING: 'loading',
  LOADED: 'loaded',
  ENABLED: 'enabled',
  DISABLED: 'disabled',
  ERROR: 'error'
};

/**
 * Plugin capabilities
 */
export const PluginCapabilities = {
  MINING_ALGORITHM: 'mining.algorithm',
  POOL_STRATEGY: 'pool.strategy',
  PAYOUT_PROCESSOR: 'payout.processor',
  NOTIFICATION_CHANNEL: 'notification.channel',
  ANALYTICS_PROVIDER: 'analytics.provider',
  EXCHANGE_CONNECTOR: 'exchange.connector',
  MONITORING_EXPORTER: 'monitoring.exporter',
  AUTHENTICATION_PROVIDER: 'auth.provider',
  STORAGE_BACKEND: 'storage.backend',
  UI_COMPONENT: 'ui.component'
};

/**
 * Plugin API - Exposed to plugins
 */
export class PluginAPI {
  constructor(manager, pluginId) {
    this.manager = manager;
    this.pluginId = pluginId;
    this.logger = manager.logger.child({ plugin: pluginId });
    
    // Exposed APIs
    this.events = new PluginEventAPI(manager, pluginId);
    this.storage = new PluginStorageAPI(manager, pluginId);
    this.config = new PluginConfigAPI(manager, pluginId);
    this.hooks = new PluginHooksAPI(manager, pluginId);
  }
  
  // Get core service
  getService(name) {
    return this.manager.getService(name);
  }
  
  // Register capability
  registerCapability(capability, handler) {
    return this.manager.registerCapability(this.pluginId, capability, handler);
  }
  
  // Get other plugin's API
  getPlugin(pluginId) {
    const plugin = this.manager.getPlugin(pluginId);
    return plugin ? plugin.api : null;
  }
}

/**
 * Plugin Event API
 */
class PluginEventAPI {
  constructor(manager, pluginId) {
    this.manager = manager;
    this.pluginId = pluginId;
    this.listeners = new Map();
  }
  
  on(event, handler) {
    const wrappedHandler = (...args) => {
      try {
        return handler(...args);
      } catch (error) {
        this.manager.logger.error(`Plugin ${this.pluginId} event handler error`, {
          event,
          error: error.stack
        });
      }
    };
    
    this.manager.on(event, wrappedHandler);
    
    // Track for cleanup
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(wrappedHandler);
    
    return () => this.manager.off(event, wrappedHandler);
  }
  
  once(event, handler) {
    const wrappedHandler = (...args) => {
      this.removeListener(event, wrappedHandler);
      return handler(...args);
    };
    
    return this.on(event, wrappedHandler);
  }
  
  emit(event, ...args) {
    this.manager.emit(`plugin:${this.pluginId}:${event}`, ...args);
  }
  
  removeListener(event, handler) {
    this.manager.off(event, handler);
    
    const listeners = this.listeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(handler);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }
  
  removeAllListeners() {
    for (const [event, handlers] of this.listeners) {
      for (const handler of handlers) {
        this.manager.off(event, handler);
      }
    }
    this.listeners.clear();
  }
}

/**
 * Plugin Storage API
 */
class PluginStorageAPI {
  constructor(manager, pluginId) {
    this.manager = manager;
    this.pluginId = pluginId;
    this.prefix = `plugin:${pluginId}:`;
  }
  
  async get(key, defaultValue = null) {
    const fullKey = this.prefix + key;
    const value = await this.manager.storage.get(fullKey);
    return value !== undefined ? value : defaultValue;
  }
  
  async set(key, value) {
    const fullKey = this.prefix + key;
    return await this.manager.storage.set(fullKey, value);
  }
  
  async delete(key) {
    const fullKey = this.prefix + key;
    return await this.manager.storage.delete(fullKey);
  }
  
  async list(pattern = '*') {
    const fullPattern = this.prefix + pattern;
    const keys = await this.manager.storage.list(fullPattern);
    return keys.map(key => key.substring(this.prefix.length));
  }
}

/**
 * Plugin Config API
 */
class PluginConfigAPI {
  constructor(manager, pluginId) {
    this.manager = manager;
    this.pluginId = pluginId;
  }
  
  get(key, defaultValue) {
    const plugin = this.manager.plugins.get(this.pluginId);
    if (!plugin || !plugin.config) {
      return defaultValue;
    }
    
    const keys = key.split('.');
    let value = plugin.config;
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return defaultValue;
      }
    }
    
    return value;
  }
  
  getAll() {
    const plugin = this.manager.plugins.get(this.pluginId);
    return plugin ? { ...plugin.config } : {};
  }
}

/**
 * Plugin Hooks API
 */
class PluginHooksAPI {
  constructor(manager, pluginId) {
    this.manager = manager;
    this.pluginId = pluginId;
    this.hooks = new Map();
  }
  
  register(hookName, handler, priority = 10) {
    const hookId = `${this.pluginId}:${hookName}`;
    
    const hookHandler = {
      id: hookId,
      plugin: this.pluginId,
      handler,
      priority
    };
    
    this.manager.registerHook(hookName, hookHandler);
    
    // Track for cleanup
    if (!this.hooks.has(hookName)) {
      this.hooks.set(hookName, []);
    }
    this.hooks.get(hookName).push(hookHandler);
    
    return () => this.manager.unregisterHook(hookName, hookId);
  }
  
  async execute(hookName, context) {
    return await this.manager.executeHook(hookName, context);
  }
  
  removeAllHooks() {
    for (const [hookName, handlers] of this.hooks) {
      for (const handler of handlers) {
        this.manager.unregisterHook(hookName, handler.id);
      }
    }
    this.hooks.clear();
  }
}

/**
 * Plugin Manager
 */
export class PluginManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      pluginsDir: options.pluginsDir || './plugins',
      autoLoad: options.autoLoad !== false,
      sandboxed: options.sandboxed || false,
      ...options
    };
    
    this.logger = options.logger || new Logger();
    this.storage = options.storage || new Map();
    this.services = new Map();
    this.plugins = new Map();
    this.capabilities = new Map();
    this.hooks = new Map();
    
    if (this.options.autoLoad) {
      this.loadPlugins().catch(error => {
        this.logger.error('Failed to auto-load plugins', { error });
      });
    }
  }
  
  /**
   * Register core service
   */
  registerService(name, service) {
    this.services.set(name, service);
    this.emit('service:registered', { name, service });
  }
  
  /**
   * Get core service
   */
  getService(name) {
    return this.services.get(name);
  }
  
  /**
   * Load all plugins from directory
   */
  async loadPlugins() {
    if (!existsSync(this.options.pluginsDir)) {
      this.logger.info('Plugins directory not found, skipping plugin loading');
      return;
    }
    
    const entries = await readdir(this.options.pluginsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const pluginPath = join(this.options.pluginsDir, entry.name);
        
        try {
          await this.loadPlugin(pluginPath);
        } catch (error) {
          this.logger.error(`Failed to load plugin from ${pluginPath}`, { error });
        }
      }
    }
  }
  
  /**
   * Load individual plugin
   */
  async loadPlugin(pluginPath) {
    // Check for package.json
    const packagePath = join(pluginPath, 'package.json');
    if (!existsSync(packagePath)) {
      throw new Error('Plugin package.json not found');
    }
    
    // Read plugin metadata
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
    const pluginId = packageJson.name || dirname(pluginPath);
    
    // Check if already loaded
    if (this.plugins.has(pluginId)) {
      throw new Error(`Plugin ${pluginId} already loaded`);
    }
    
    // Validate plugin metadata
    this.validatePluginMetadata(packageJson);
    
    const plugin = {
      id: pluginId,
      path: pluginPath,
      metadata: packageJson,
      state: PluginState.LOADING,
      instance: null,
      api: null,
      config: packageJson.otedama?.config || {},
      error: null
    };
    
    this.plugins.set(pluginId, plugin);
    this.emit('plugin:loading', { pluginId });
    
    try {
      // Load plugin module
      const mainFile = packageJson.main || 'index.js';
      const modulePath = join(pluginPath, mainFile);
      const moduleUrl = pathToFileURL(resolve(modulePath)).href;
      
      const PluginModule = await import(moduleUrl);
      const PluginClass = PluginModule.default || PluginModule.Plugin;
      
      if (!PluginClass) {
        throw new Error('Plugin must export a default class or Plugin class');
      }
      
      // Create plugin API
      plugin.api = new PluginAPI(this, pluginId);
      
      // Instantiate plugin
      plugin.instance = new PluginClass(plugin.api, plugin.config);
      
      // Initialize plugin
      if (plugin.instance.initialize) {
        await plugin.instance.initialize();
      }
      
      plugin.state = PluginState.LOADED;
      this.emit('plugin:loaded', { pluginId });
      
      // Auto-enable if configured
      if (packageJson.otedama?.autoEnable !== false) {
        await this.enablePlugin(pluginId);
      }
      
      this.logger.info(`Plugin ${pluginId} loaded successfully`, {
        version: packageJson.version,
        capabilities: packageJson.otedama?.capabilities
      });
      
    } catch (error) {
      plugin.state = PluginState.ERROR;
      plugin.error = error;
      
      this.logger.error(`Failed to load plugin ${pluginId}`, { error: error.stack });
      this.emit('plugin:error', { pluginId, error });
      
      throw error;
    }
  }
  
  /**
   * Enable plugin
   */
  async enablePlugin(pluginId) {
    const plugin = this.plugins.get(pluginId);
    
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }
    
    if (plugin.state === PluginState.ENABLED) {
      return;
    }
    
    if (plugin.state !== PluginState.LOADED && plugin.state !== PluginState.DISABLED) {
      throw new Error(`Plugin ${pluginId} is not in a valid state to enable`);
    }
    
    try {
      // Check dependencies
      await this.checkDependencies(plugin);
      
      // Enable plugin
      if (plugin.instance.enable) {
        await plugin.instance.enable();
      }
      
      plugin.state = PluginState.ENABLED;
      this.emit('plugin:enabled', { pluginId });
      
      this.logger.info(`Plugin ${pluginId} enabled`);
      
    } catch (error) {
      plugin.state = PluginState.ERROR;
      plugin.error = error;
      
      this.logger.error(`Failed to enable plugin ${pluginId}`, { error });
      throw error;
    }
  }
  
  /**
   * Disable plugin
   */
  async disablePlugin(pluginId) {
    const plugin = this.plugins.get(pluginId);
    
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }
    
    if (plugin.state !== PluginState.ENABLED) {
      return;
    }
    
    try {
      // Check dependents
      const dependents = this.getDependents(pluginId);
      if (dependents.length > 0) {
        throw new Error(
          `Cannot disable plugin ${pluginId}, required by: ${dependents.join(', ')}`
        );
      }
      
      // Disable plugin
      if (plugin.instance.disable) {
        await plugin.instance.disable();
      }
      
      // Cleanup event listeners
      if (plugin.api.events) {
        plugin.api.events.removeAllListeners();
      }
      
      // Cleanup hooks
      if (plugin.api.hooks) {
        plugin.api.hooks.removeAllHooks();
      }
      
      plugin.state = PluginState.DISABLED;
      this.emit('plugin:disabled', { pluginId });
      
      this.logger.info(`Plugin ${pluginId} disabled`);
      
    } catch (error) {
      plugin.state = PluginState.ERROR;
      plugin.error = error;
      
      this.logger.error(`Failed to disable plugin ${pluginId}`, { error });
      throw error;
    }
  }
  
  /**
   * Unload plugin
   */
  async unloadPlugin(pluginId) {
    const plugin = this.plugins.get(pluginId);
    
    if (!plugin) {
      return;
    }
    
    // Disable first if enabled
    if (plugin.state === PluginState.ENABLED) {
      await this.disablePlugin(pluginId);
    }
    
    try {
      // Cleanup
      if (plugin.instance && plugin.instance.cleanup) {
        await plugin.instance.cleanup();
      }
      
      // Remove capabilities
      for (const [capability, handlers] of this.capabilities) {
        this.capabilities.set(
          capability,
          handlers.filter(h => h.plugin !== pluginId)
        );
      }
      
      // Remove from registry
      this.plugins.delete(pluginId);
      
      this.emit('plugin:unloaded', { pluginId });
      this.logger.info(`Plugin ${pluginId} unloaded`);
      
    } catch (error) {
      this.logger.error(`Error unloading plugin ${pluginId}`, { error });
      throw error;
    }
  }
  
  /**
   * Reload plugin
   */
  async reloadPlugin(pluginId) {
    const plugin = this.plugins.get(pluginId);
    
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }
    
    const wasEnabled = plugin.state === PluginState.ENABLED;
    const pluginPath = plugin.path;
    
    // Unload
    await this.unloadPlugin(pluginId);
    
    // Clear module cache
    const modulePath = resolve(pluginPath);
    Object.keys(require.cache).forEach(key => {
      if (key.startsWith(modulePath)) {
        delete require.cache[key];
      }
    });
    
    // Reload
    await this.loadPlugin(pluginPath);
    
    // Re-enable if was enabled
    if (wasEnabled) {
      await this.enablePlugin(pluginId);
    }
  }
  
  /**
   * Get plugin
   */
  getPlugin(pluginId) {
    return this.plugins.get(pluginId);
  }
  
  /**
   * List plugins
   */
  listPlugins(filter = {}) {
    const plugins = Array.from(this.plugins.values());
    
    return plugins.filter(plugin => {
      if (filter.state && plugin.state !== filter.state) {
        return false;
      }
      
      if (filter.capability) {
        const capabilities = plugin.metadata.otedama?.capabilities || [];
        if (!capabilities.includes(filter.capability)) {
          return false;
        }
      }
      
      return true;
    }).map(plugin => ({
      id: plugin.id,
      name: plugin.metadata.name,
      version: plugin.metadata.version,
      description: plugin.metadata.description,
      state: plugin.state,
      capabilities: plugin.metadata.otedama?.capabilities || [],
      error: plugin.error?.message
    }));
  }
  
  /**
   * Register capability handler
   */
  registerCapability(pluginId, capability, handler) {
    if (!this.capabilities.has(capability)) {
      this.capabilities.set(capability, []);
    }
    
    this.capabilities.get(capability).push({
      plugin: pluginId,
      handler
    });
    
    this.emit('capability:registered', { pluginId, capability });
  }
  
  /**
   * Get capability handlers
   */
  getCapabilityHandlers(capability) {
    return this.capabilities.get(capability) || [];
  }
  
  /**
   * Register hook
   */
  registerHook(hookName, hookHandler) {
    if (!this.hooks.has(hookName)) {
      this.hooks.set(hookName, []);
    }
    
    const hooks = this.hooks.get(hookName);
    hooks.push(hookHandler);
    
    // Sort by priority
    hooks.sort((a, b) => a.priority - b.priority);
  }
  
  /**
   * Unregister hook
   */
  unregisterHook(hookName, hookId) {
    const hooks = this.hooks.get(hookName);
    if (!hooks) return;
    
    const index = hooks.findIndex(h => h.id === hookId);
    if (index > -1) {
      hooks.splice(index, 1);
    }
  }
  
  /**
   * Execute hook
   */
  async executeHook(hookName, context) {
    const hooks = this.hooks.get(hookName) || [];
    
    let result = context;
    
    for (const hook of hooks) {
      try {
        result = await hook.handler(result);
        
        // Allow hooks to stop propagation
        if (result && result._stopPropagation) {
          break;
        }
      } catch (error) {
        this.logger.error(`Hook execution error`, {
          hook: hook.id,
          error: error.stack
        });
        
        // Continue with other hooks
      }
    }
    
    return result;
  }
  
  /**
   * Validate plugin metadata
   */
  validatePluginMetadata(metadata) {
    if (!metadata.name) {
      throw new Error('Plugin must have a name');
    }
    
    if (!metadata.version) {
      throw new Error('Plugin must have a version');
    }
    
    if (!metadata.otedama) {
      throw new Error('Plugin must have otedama configuration');
    }
    
    if (!metadata.otedama.minVersion) {
      throw new Error('Plugin must specify minimum Otedama version');
    }
    
    // Check version compatibility
    const minVersion = metadata.otedama.minVersion;
    const currentVersion = '0.6.1';
    
    if (this.compareVersions(minVersion, currentVersion) > 0) {
      throw new Error(
        `Plugin requires Otedama ${minVersion} or higher, current version is ${currentVersion}`
      );
    }
  }
  
  /**
   * Check plugin dependencies
   */
  async checkDependencies(plugin) {
    const dependencies = plugin.metadata.otedama?.dependencies || {};
    
    for (const [depId, depVersion] of Object.entries(dependencies)) {
      const dep = this.plugins.get(depId);
      
      if (!dep) {
        throw new Error(`Required plugin ${depId} not found`);
      }
      
      if (dep.state !== PluginState.ENABLED) {
        // Try to enable dependency
        await this.enablePlugin(depId);
      }
      
      // Check version
      if (depVersion !== '*') {
        const actualVersion = dep.metadata.version;
        if (!this.satisfiesVersion(actualVersion, depVersion)) {
          throw new Error(
            `Plugin ${depId} version ${actualVersion} does not satisfy ${depVersion}`
          );
        }
      }
    }
  }
  
  /**
   * Get plugins that depend on a given plugin
   */
  getDependents(pluginId) {
    const dependents = [];
    
    for (const [id, plugin] of this.plugins) {
      if (plugin.state === PluginState.ENABLED) {
        const dependencies = plugin.metadata.otedama?.dependencies || {};
        if (pluginId in dependencies) {
          dependents.push(id);
        }
      }
    }
    
    return dependents;
  }
  
  /**
   * Compare versions
   */
  compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }
    
    return 0;
  }
  
  /**
   * Check if version satisfies requirement
   */
  satisfiesVersion(version, requirement) {
    // Simple implementation - enhance as needed
    if (requirement === '*') return true;
    
    if (requirement.startsWith('^')) {
      const reqVersion = requirement.substring(1);
      const reqMajor = reqVersion.split('.')[0];
      const actualMajor = version.split('.')[0];
      
      return reqMajor === actualMajor && 
             this.compareVersions(version, reqVersion) >= 0;
    }
    
    return version === requirement;
  }
}

/**
 * Base Plugin Class
 */
export class Plugin {
  constructor(api, config) {
    this.api = api;
    this.config = config;
    this.logger = api.logger;
  }
  
  async initialize() {
    // Override in plugin
  }
  
  async enable() {
    // Override in plugin
  }
  
  async disable() {
    // Override in plugin
  }
  
  async cleanup() {
    // Override in plugin
  }
}