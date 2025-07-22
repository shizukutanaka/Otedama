/**
 * WebAssembly Plugin System for Otedama
 * High-performance plugin execution with sandboxing
 * 
 * Design principles:
 * - Carmack: Zero-overhead plugin execution
 * - Martin: Clean plugin architecture
 * - Pike: Simple plugin API
 */

import { EventEmitter } from 'events';
import { readFile, readdir, stat } from 'fs/promises';
import { join, extname } from 'path';
import { WASI } from 'wasi';
import { performance } from 'perf_hooks';
import { getLogger } from '../core/logger.js';

const logger = getLogger('PluginSystem');

/**
 * Plugin capabilities
 */
export const PluginCapability = {
  COMPUTATION: 'computation',
  TRANSFORMATION: 'transformation',
  VALIDATION: 'validation',
  ANALYSIS: 'analysis',
  OPTIMIZATION: 'optimization',
  CUSTOM_MINING: 'custom_mining'
};

/**
 * Plugin lifecycle events
 */
export const PluginLifecycle = {
  LOADING: 'loading',
  LOADED: 'loaded',
  INITIALIZING: 'initializing',
  INITIALIZED: 'initialized',
  EXECUTING: 'executing',
  EXECUTED: 'executed',
  ERROR: 'error',
  UNLOADING: 'unloading',
  UNLOADED: 'unloaded'
};

/**
 * WebAssembly plugin
 */
export class WasmPlugin {
  constructor(manifest) {
    this.id = manifest.id;
    this.name = manifest.name;
    this.version = manifest.version;
    this.author = manifest.author;
    this.description = manifest.description;
    this.capabilities = manifest.capabilities || [];
    this.exports = manifest.exports || [];
    this.imports = manifest.imports || {};
    this.config = manifest.config || {};
    
    this.instance = null;
    this.memory = null;
    this.state = PluginLifecycle.LOADING;
    this.metrics = {
      executions: 0,
      totalTime: 0,
      errors: 0,
      lastExecution: null
    };
  }
  
  /**
   * Get plugin info
   */
  getInfo() {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      author: this.author,
      description: this.description,
      capabilities: this.capabilities,
      exports: this.exports,
      state: this.state,
      metrics: this.metrics
    };
  }
  
  /**
   * Check if plugin has capability
   */
  hasCapability(capability) {
    return this.capabilities.includes(capability);
  }
  
  /**
   * Check if plugin exports function
   */
  hasFunction(functionName) {
    return this.exports.includes(functionName) && 
           this.instance?.exports[functionName];
  }
}

/**
 * WebAssembly plugin system
 */
export class WasmPluginSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Plugin directories
      pluginDirs: options.pluginDirs || ['./plugins'],
      
      // Security
      sandbox: {
        enabled: options.sandbox?.enabled !== false,
        memory: {
          initial: options.sandbox?.memory?.initial || 256, // pages (16MB)
          maximum: options.sandbox?.memory?.maximum || 4096, // pages (256MB)
          shared: options.sandbox?.memory?.shared || false
        },
        cpu: {
          instructionLimit: options.sandbox?.cpu?.instructionLimit || 1000000000,
          timeout: options.sandbox?.cpu?.timeout || 30000 // 30 seconds
        },
        filesystem: {
          enabled: options.sandbox?.filesystem?.enabled || false,
          dirs: options.sandbox?.filesystem?.dirs || []
        }
      },
      
      // Performance
      cache: {
        enabled: options.cache?.enabled !== false,
        maxSize: options.cache?.maxSize || 100 * 1024 * 1024, // 100MB
        ttl: options.cache?.ttl || 3600000 // 1 hour
      },
      
      // Plugin management
      autoLoad: options.autoLoad !== false,
      validateSignatures: options.validateSignatures || false,
      
      ...options
    };
    
    // Plugin registry
    this.plugins = new Map();
    this.moduleCache = new Map();
    
    // Execution context
    this.executionContexts = new Map();
    
    // Host functions available to plugins
    this.hostFunctions = this._createHostFunctions();
    
    // Metrics
    this.metrics = {
      pluginsLoaded: 0,
      totalExecutions: 0,
      cacheHits: 0,
      cacheMisses: 0
    };
  }
  
  /**
   * Initialize plugin system
   */
  async initialize() {
    logger.info('Initializing WebAssembly plugin system');
    
    if (this.options.autoLoad) {
      await this.loadAllPlugins();
    }
    
    this.emit('initialized', {
      pluginCount: this.plugins.size
    });
  }
  
  /**
   * Load all plugins from directories
   */
  async loadAllPlugins() {
    for (const dir of this.options.pluginDirs) {
      try {
        await this.loadPluginsFromDirectory(dir);
      } catch (error) {
        logger.error(`Failed to load plugins from ${dir}:`, error);
      }
    }
  }
  
  /**
   * Load plugins from directory
   */
  async loadPluginsFromDirectory(directory) {
    const files = await readdir(directory);
    
    for (const file of files) {
      const filepath = join(directory, file);
      const stats = await stat(filepath);
      
      if (stats.isDirectory()) {
        // Check for plugin manifest
        const manifestPath = join(filepath, 'plugin.json');
        try {
          await stat(manifestPath);
          await this.loadPlugin(filepath);
        } catch {
          // Not a plugin directory
        }
      } else if (extname(file) === '.wasm') {
        // Single WASM file plugin
        await this.loadPlugin(filepath);
      }
    }
  }
  
  /**
   * Load a plugin
   */
  async loadPlugin(pluginPath) {
    try {
      // Load manifest
      const manifest = await this._loadManifest(pluginPath);
      
      // Validate plugin
      this._validateManifest(manifest);
      
      // Create plugin instance
      const plugin = new WasmPlugin(manifest);
      plugin.path = pluginPath;
      
      logger.info(`Loading plugin: ${plugin.name} v${plugin.version}`);
      
      // Load WASM module
      const wasmPath = join(pluginPath, manifest.entry || 'plugin.wasm');
      const wasmBuffer = await readFile(wasmPath);
      
      // Compile module
      const module = await this._compileModule(wasmBuffer, plugin.id);
      
      // Create imports
      const imports = this._createImports(plugin);
      
      // Instantiate module
      const instance = await WebAssembly.instantiate(module, imports);
      plugin.instance = instance.instance;
      plugin.memory = instance.instance.exports.memory;
      
      // Initialize plugin
      if (plugin.hasFunction('_initialize')) {
        plugin.instance.exports._initialize();
      }
      
      plugin.state = PluginLifecycle.INITIALIZED;
      
      // Register plugin
      this.plugins.set(plugin.id, plugin);
      this.metrics.pluginsLoaded++;
      
      this.emit('plugin:loaded', plugin.getInfo());
      
      logger.info(`Plugin loaded successfully: ${plugin.name}`);
      
    } catch (error) {
      logger.error(`Failed to load plugin from ${pluginPath}:`, error);
      throw error;
    }
  }
  
  /**
   * Unload a plugin
   */
  async unloadPlugin(pluginId) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }
    
    plugin.state = PluginLifecycle.UNLOADING;
    
    // Call cleanup if available
    if (plugin.hasFunction('_cleanup')) {
      try {
        plugin.instance.exports._cleanup();
      } catch (error) {
        logger.error(`Plugin cleanup failed for ${pluginId}:`, error);
      }
    }
    
    // Remove from registry
    this.plugins.delete(pluginId);
    
    // Clear execution contexts
    this.executionContexts.delete(pluginId);
    
    plugin.state = PluginLifecycle.UNLOADED;
    
    this.emit('plugin:unloaded', { pluginId });
    
    logger.info(`Plugin unloaded: ${pluginId}`);
  }
  
  /**
   * Execute plugin function
   */
  async execute(pluginId, functionName, args = {}) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }
    
    if (!plugin.hasFunction(functionName)) {
      throw new Error(`Function not found: ${functionName} in plugin ${pluginId}`);
    }
    
    const startTime = performance.now();
    plugin.state = PluginLifecycle.EXECUTING;
    
    try {
      // Create execution context
      const context = this._createExecutionContext(plugin, functionName);
      
      // Serialize arguments
      const argsPtr = await this._serializeArgs(plugin, args);
      
      // Execute function with timeout
      const resultPtr = await this._executeWithTimeout(
        plugin,
        functionName,
        argsPtr,
        context
      );
      
      // Deserialize result
      const result = await this._deserializeResult(plugin, resultPtr);
      
      // Update metrics
      const executionTime = performance.now() - startTime;
      plugin.metrics.executions++;
      plugin.metrics.totalTime += executionTime;
      plugin.metrics.lastExecution = Date.now();
      this.metrics.totalExecutions++;
      
      plugin.state = PluginLifecycle.EXECUTED;
      
      this.emit('plugin:executed', {
        pluginId,
        functionName,
        executionTime,
        success: true
      });
      
      return result;
      
    } catch (error) {
      plugin.metrics.errors++;
      plugin.state = PluginLifecycle.ERROR;
      
      this.emit('plugin:error', {
        pluginId,
        functionName,
        error: error.message
      });
      
      throw error;
    }
  }
  
  /**
   * Execute multiple plugins in parallel
   */
  async executeParallel(executions) {
    const promises = executions.map(({ pluginId, functionName, args }) =>
      this.execute(pluginId, functionName, args)
        .catch(error => ({ error: error.message }))
    );
    
    return Promise.all(promises);
  }
  
  /**
   * Execute plugins in pipeline
   */
  async executePipeline(pipeline, initialData) {
    let data = initialData;
    
    for (const step of pipeline) {
      const { pluginId, functionName, transform } = step;
      
      try {
        const result = await this.execute(pluginId, functionName, data);
        data = transform ? transform(result) : result;
      } catch (error) {
        throw new Error(`Pipeline failed at ${pluginId}.${functionName}: ${error.message}`);
      }
    }
    
    return data;
  }
  
  /**
   * Get plugin by capability
   */
  getPluginsByCapability(capability) {
    const plugins = [];
    
    for (const plugin of this.plugins.values()) {
      if (plugin.hasCapability(capability)) {
        plugins.push(plugin.getInfo());
      }
    }
    
    return plugins;
  }
  
  /**
   * Create host functions for plugins
   */
  _createHostFunctions() {
    return {
      // Logging functions
      log_info: (msgPtr, msgLen) => {
        const msg = this._readString(msgPtr, msgLen);
        logger.info(`[Plugin] ${msg}`);
      },
      
      log_error: (msgPtr, msgLen) => {
        const msg = this._readString(msgPtr, msgLen);
        logger.error(`[Plugin] ${msg}`);
      },
      
      // Memory allocation
      allocate: (size) => {
        // Allocate memory in plugin's heap
        return this._allocateMemory(size);
      },
      
      deallocate: (ptr, size) => {
        // Deallocate memory
        this._deallocateMemory(ptr, size);
      },
      
      // Crypto functions
      hash_sha256: (dataPtr, dataLen, outPtr) => {
        const data = this._readBytes(dataPtr, dataLen);
        const hash = this._sha256(data);
        this._writeBytes(outPtr, hash);
      },
      
      // Time functions
      get_timestamp: () => {
        return Date.now();
      },
      
      // Random functions
      get_random: () => {
        return Math.random();
      },
      
      // Performance monitoring
      perf_start: () => {
        return performance.now();
      },
      
      perf_end: (start) => {
        return performance.now() - start;
      }
    };
  }
  
  /**
   * Create imports for plugin
   */
  _createImports(plugin) {
    const imports = {
      env: {
        memory: new WebAssembly.Memory({
          initial: this.options.sandbox.memory.initial,
          maximum: this.options.sandbox.memory.maximum,
          shared: this.options.sandbox.memory.shared
        })
      },
      host: {}
    };
    
    // Add host functions
    for (const [name, func] of Object.entries(this.hostFunctions)) {
      imports.host[name] = func.bind(this);
    }
    
    // Add custom imports from manifest
    for (const [module, funcs] of Object.entries(plugin.imports)) {
      if (!imports[module]) {
        imports[module] = {};
      }
      
      for (const func of funcs) {
        if (this.hostFunctions[func]) {
          imports[module][func] = this.hostFunctions[func].bind(this);
        }
      }
    }
    
    return imports;
  }
  
  /**
   * Create execution context
   */
  _createExecutionContext(plugin, functionName) {
    const context = {
      pluginId: plugin.id,
      functionName,
      startTime: performance.now(),
      instructionCount: 0,
      memoryUsage: 0,
      cancelled: false
    };
    
    this.executionContexts.set(`${plugin.id}:${functionName}`, context);
    
    return context;
  }
  
  /**
   * Execute with timeout
   */
  async _executeWithTimeout(plugin, functionName, argsPtr, context) {
    return new Promise((resolve, reject) => {
      let timeoutId;
      
      // Set timeout
      if (this.options.sandbox.cpu.timeout > 0) {
        timeoutId = setTimeout(() => {
          context.cancelled = true;
          reject(new Error(`Execution timeout: ${functionName}`));
        }, this.options.sandbox.cpu.timeout);
      }
      
      try {
        // Execute function
        const result = plugin.instance.exports[functionName](argsPtr);
        
        clearTimeout(timeoutId);
        resolve(result);
        
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }
  
  /**
   * Compile WASM module with caching
   */
  async _compileModule(wasmBuffer, pluginId) {
    const cacheKey = `module:${pluginId}`;
    
    // Check cache
    if (this.options.cache.enabled && this.moduleCache.has(cacheKey)) {
      const cached = this.moduleCache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.options.cache.ttl) {
        this.metrics.cacheHits++;
        return cached.module;
      }
    }
    
    this.metrics.cacheMisses++;
    
    // Compile module
    const module = await WebAssembly.compile(wasmBuffer);
    
    // Cache module
    if (this.options.cache.enabled) {
      this.moduleCache.set(cacheKey, {
        module,
        timestamp: Date.now(),
        size: wasmBuffer.length
      });
      
      // Enforce cache size limit
      this._enforceCacheLimit();
    }
    
    return module;
  }
  
  /**
   * Load plugin manifest
   */
  async _loadManifest(pluginPath) {
    let manifestPath;
    
    if (pluginPath.endsWith('.wasm')) {
      // Single file plugin - look for adjacent manifest
      manifestPath = pluginPath.replace('.wasm', '.json');
    } else {
      // Directory plugin
      manifestPath = join(pluginPath, 'plugin.json');
    }
    
    try {
      const manifestData = await readFile(manifestPath, 'utf8');
      return JSON.parse(manifestData);
    } catch (error) {
      // Create minimal manifest for single file plugins
      if (pluginPath.endsWith('.wasm')) {
        const filename = pluginPath.split('/').pop().replace('.wasm', '');
        return {
          id: filename,
          name: filename,
          version: '1.0.0',
          entry: pluginPath
        };
      }
      throw error;
    }
  }
  
  /**
   * Validate plugin manifest
   */
  _validateManifest(manifest) {
    const required = ['id', 'name', 'version'];
    
    for (const field of required) {
      if (!manifest[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
    
    // Validate version format
    if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
      throw new Error(`Invalid version format: ${manifest.version}`);
    }
    
    // Validate capabilities
    if (manifest.capabilities) {
      for (const capability of manifest.capabilities) {
        if (!Object.values(PluginCapability).includes(capability)) {
          throw new Error(`Unknown capability: ${capability}`);
        }
      }
    }
  }
  
  /**
   * Memory management helpers
   */
  _allocateMemory(size) {
    // Simple bump allocator for demo
    // In production, use proper memory management
    const ptr = this._heapPointer || 65536; // Start after first page
    this._heapPointer = ptr + size;
    return ptr;
  }
  
  _deallocateMemory(ptr, size) {
    // No-op for bump allocator
    // In production, implement proper deallocation
  }
  
  _readString(ptr, len) {
    const memory = new Uint8Array(this.currentPlugin.memory.buffer);
    const bytes = memory.slice(ptr, ptr + len);
    return new TextDecoder().decode(bytes);
  }
  
  _readBytes(ptr, len) {
    const memory = new Uint8Array(this.currentPlugin.memory.buffer);
    return memory.slice(ptr, ptr + len);
  }
  
  _writeBytes(ptr, bytes) {
    const memory = new Uint8Array(this.currentPlugin.memory.buffer);
    memory.set(bytes, ptr);
  }
  
  /**
   * Serialization helpers
   */
  async _serializeArgs(plugin, args) {
    const json = JSON.stringify(args);
    const bytes = new TextEncoder().encode(json);
    const ptr = this._allocateMemory(bytes.length + 4);
    
    // Write length prefix
    const view = new DataView(plugin.memory.buffer);
    view.setUint32(ptr, bytes.length, true);
    
    // Write data
    const memory = new Uint8Array(plugin.memory.buffer);
    memory.set(bytes, ptr + 4);
    
    return ptr;
  }
  
  async _deserializeResult(plugin, ptr) {
    if (!ptr) return null;
    
    const view = new DataView(plugin.memory.buffer);
    const len = view.getUint32(ptr, true);
    
    const memory = new Uint8Array(plugin.memory.buffer);
    const bytes = memory.slice(ptr + 4, ptr + 4 + len);
    const json = new TextDecoder().decode(bytes);
    
    return JSON.parse(json);
  }
  
  /**
   * Cache management
   */
  _enforceCacheLimit() {
    let totalSize = 0;
    const entries = [];
    
    for (const [key, value] of this.moduleCache) {
      totalSize += value.size;
      entries.push({ key, ...value });
    }
    
    if (totalSize <= this.options.cache.maxSize) return;
    
    // Sort by timestamp (LRU)
    entries.sort((a, b) => a.timestamp - b.timestamp);
    
    // Remove oldest entries
    while (totalSize > this.options.cache.maxSize && entries.length > 0) {
      const entry = entries.shift();
      this.moduleCache.delete(entry.key);
      totalSize -= entry.size;
    }
  }
  
  /**
   * Crypto helpers
   */
  _sha256(data) {
    // Simple SHA256 implementation for demo
    // In production, use proper crypto library
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(data).digest();
  }
  
  /**
   * Get system status
   */
  getStatus() {
    return {
      plugins: Array.from(this.plugins.values()).map(p => p.getInfo()),
      metrics: this.metrics,
      cache: {
        size: this.moduleCache.size,
        enabled: this.options.cache.enabled
      }
    };
  }
  
  /**
   * Cleanup
   */
  async destroy() {
    // Unload all plugins
    for (const pluginId of this.plugins.keys()) {
      await this.unloadPlugin(pluginId);
    }
    
    // Clear cache
    this.moduleCache.clear();
    
    this.emit('destroyed');
  }
}

export default WasmPluginSystem;