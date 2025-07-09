/**
 * 軽量プラグインアーキテクチャシステム
 * 設計思想: Carmack (シンプル・高速), Martin (クリーン), Pike (明瞭・効率性)
 * 
 * 主要機能:
 * - プラグイン動的読み込み
 * - ライフサイクル管理
 * - 依存関係解決
 * - イベントベース通信
 * - API提供機能
 * - セキュリティ機能
 * - 設定管理
 */

import { EventEmitter } from 'events';
import { readdir, readFile, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { createRequire } from 'module';

// === 型定義 ===
interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  main: string;
  dependencies?: string[];
  permissions?: string[];
  hooks?: string[];
  api?: {
    endpoints?: string[];
    events?: string[];
  };
  config?: {
    schema?: any;
    defaults?: Record<string, any>;
  };
  tags?: string[];
}

interface PluginInstance {
  id: string;
  manifest: PluginManifest;
  module: any;
  state: PluginState;
  loadedAt: number;
  error?: Error;
  config: Record<string, any>;
  context: PluginContext;
  dependencies: string[];
  dependents: string[];
}

enum PluginState {
  UNLOADED = 'unloaded',
  LOADING = 'loading',
  LOADED = 'loaded',
  STARTING = 'starting',
  RUNNING = 'running',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
  ERROR = 'error'
}

interface PluginContext {
  api: PluginAPI;
  logger: any;
  config: Record<string, any>;
  events: EventEmitter;
  pool?: any;
  services?: any;
}

interface PluginAPI {
  // Core API
  getVersion(): string;
  getPlugins(): string[];
  getPlugin(name: string): PluginInstance | null;
  
  // Event API
  on(event: string, handler: Function): void;
  emit(event: string, ...args: any[]): void;
  off(event: string, handler: Function): void;
  
  // Hook API
  addHook(name: string, handler: Function, priority?: number): void;
  removeHook(name: string, handler: Function): void;
  executeHook(name: string, ...args: any[]): Promise<any[]>;
  
  // Service API
  registerService(name: string, service: any): void;
  getService(name: string): any;
  unregisterService(name: string): void;
  
  // Configuration API
  getConfig(key?: string): any;
  setConfig(key: string, value: any): void;
  
  // Storage API
  getData(key: string): any;
  setData(key: string, value: any): void;
  deleteData(key: string): void;
  
  // HTTP API
  addRoute(path: string, handler: Function, methods?: string[]): void;
  removeRoute(path: string): void;
  
  // WebSocket API
  addWebSocketHandler(type: string, handler: Function): void;
  sendWebSocketMessage(connectionId: string, message: any): void;
  broadcastWebSocketMessage(message: any, filter?: Function): void;
}

interface PluginHook {
  name: string;
  handlers: Array<{
    plugin: string;
    handler: Function;
    priority: number;
  }>;
}

interface PluginArchitectureConfig {
  pluginsDirectory: string;
  enableHotReload: boolean;
  securityLevel: 'low' | 'medium' | 'high';
  maxLoadTime: number;
  enablePermissions: boolean;
  defaultPermissions: string[];
  allowedModules: string[];
}

// === プラグインサンドボックス ===
class PluginSandbox {
  private allowedModules: string[];
  private securityLevel: string;

  constructor(allowedModules: string[], securityLevel: string) {
    this.allowedModules = allowedModules;
    this.securityLevel = securityLevel;
  }

  createSecureRequire(pluginPath: string): any {
    const require = createRequire(pluginPath);
    
    return (moduleName: string) => {
      // セキュリティチェック
      if (this.securityLevel === 'high' && !this.isModuleAllowed(moduleName)) {
        throw new Error(`Module '${moduleName}' is not allowed`);
      }

      // 危険なモジュールのブロック
      if (this.isDangerousModule(moduleName)) {
        throw new Error(`Module '${moduleName}' is blocked for security reasons`);
      }

      return require(moduleName);
    };
  }

  private isModuleAllowed(moduleName: string): boolean {
    return this.allowedModules.includes(moduleName) || 
           this.allowedModules.includes('*') ||
           moduleName.startsWith('./') ||
           moduleName.startsWith('../');
  }

  private isDangerousModule(moduleName: string): boolean {
    const dangerousModules = [
      'child_process',
      'cluster',
      'dgram',
      'dns',
      'net',
      'tls',
      'vm'
    ];

    return dangerousModules.includes(moduleName);
  }
}

// === 依存関係リゾルバー ===
class DependencyResolver {
  private plugins = new Map<string, PluginInstance>();

  addPlugin(plugin: PluginInstance): void {
    this.plugins.set(plugin.manifest.name, plugin);
  }

  removePlugin(name: string): void {
    this.plugins.delete(name);
  }

  resolveDependencies(pluginName: string): string[] {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) return [];

    const resolved: string[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    this.visitDependencies(pluginName, resolved, visiting, visited);
    return resolved;
  }

  private visitDependencies(
    pluginName: string,
    resolved: string[],
    visiting: Set<string>,
    visited: Set<string>
  ): void {
    if (visiting.has(pluginName)) {
      throw new Error(`Circular dependency detected: ${pluginName}`);
    }

    if (visited.has(pluginName)) {
      return;
    }

    visiting.add(pluginName);
    
    const plugin = this.plugins.get(pluginName);
    if (plugin && plugin.manifest.dependencies) {
      for (const dep of plugin.manifest.dependencies) {
        this.visitDependencies(dep, resolved, visiting, visited);
      }
    }

    visiting.delete(pluginName);
    visited.add(pluginName);
    resolved.push(pluginName);
  }

  getDependents(pluginName: string): string[] {
    const dependents: string[] = [];
    
    for (const [name, plugin] of this.plugins) {
      if (plugin.manifest.dependencies?.includes(pluginName)) {
        dependents.push(name);
      }
    }

    return dependents;
  }

  canUnload(pluginName: string): boolean {
    const dependents = this.getDependents(pluginName);
    return dependents.every(dep => {
      const plugin = this.plugins.get(dep);
      return !plugin || plugin.state === PluginState.STOPPED;
    });
  }
}

// === フックシステム ===
class HookSystem {
  private hooks = new Map<string, PluginHook>();

  addHook(name: string, plugin: string, handler: Function, priority: number = 0): void {
    if (!this.hooks.has(name)) {
      this.hooks.set(name, { name, handlers: [] });
    }

    const hook = this.hooks.get(name)!;
    
    // 既存のハンドラーを削除（同じプラグインの場合）
    hook.handlers = hook.handlers.filter(h => h.plugin !== plugin);
    
    // 新しいハンドラーを追加
    hook.handlers.push({ plugin, handler, priority });
    
    // 優先度でソート（高い優先度が先）
    hook.handlers.sort((a, b) => b.priority - a.priority);
  }

  removeHook(name: string, plugin: string): void {
    const hook = this.hooks.get(name);
    if (hook) {
      hook.handlers = hook.handlers.filter(h => h.plugin !== plugin);
      
      if (hook.handlers.length === 0) {
        this.hooks.delete(name);
      }
    }
  }

  async executeHook(name: string, ...args: any[]): Promise<any[]> {
    const hook = this.hooks.get(name);
    if (!hook) return [];

    const results: any[] = [];
    
    for (const { handler } of hook.handlers) {
      try {
        const result = await Promise.resolve(handler(...args));
        results.push(result);
      } catch (error) {
        console.error(`Hook handler error in ${name}:`, error);
        results.push(undefined);
      }
    }

    return results;
  }

  getHooks(): string[] {
    return Array.from(this.hooks.keys());
  }

  removePluginHooks(plugin: string): void {
    for (const [name, hook] of this.hooks) {
      hook.handlers = hook.handlers.filter(h => h.plugin !== plugin);
      
      if (hook.handlers.length === 0) {
        this.hooks.delete(name);
      }
    }
  }
}

// === サービスレジストリ ===
class ServiceRegistry {
  private services = new Map<string, any>();
  private providers = new Map<string, string>(); // service -> plugin

  register(name: string, service: any, provider: string): void {
    if (this.services.has(name)) {
      throw new Error(`Service '${name}' is already registered`);
    }

    this.services.set(name, service);
    this.providers.set(name, provider);
  }

  unregister(name: string): boolean {
    const removed = this.services.delete(name);
    this.providers.delete(name);
    return removed;
  }

  get(name: string): any {
    return this.services.get(name);
  }

  getProvider(name: string): string | undefined {
    return this.providers.get(name);
  }

  getServices(): string[] {
    return Array.from(this.services.keys());
  }

  unregisterByProvider(provider: string): void {
    for (const [name, serviceProvider] of this.providers) {
      if (serviceProvider === provider) {
        this.unregister(name);
      }
    }
  }
}

// === メインプラグインマネージャー ===
class LightPluginManager extends EventEmitter {
  private config: PluginArchitectureConfig;
  private plugins = new Map<string, PluginInstance>();
  private dependencyResolver = new DependencyResolver();
  private hookSystem = new HookSystem();
  private serviceRegistry = new ServiceRegistry();
  private sandbox: PluginSandbox;
  private logger: any;
  private pluginData = new Map<string, Map<string, any>>();
  private routes = new Map<string, { handler: Function; methods: string[]; plugin: string }>();
  private wsHandlers = new Map<string, { handler: Function; plugin: string }>();
  private watchTimer?: NodeJS.Timeout;

  constructor(config: Partial<PluginArchitectureConfig> = {}, logger?: any) {
    super();
    
    this.config = {
      pluginsDirectory: './plugins',
      enableHotReload: false,
      securityLevel: 'medium',
      maxLoadTime: 30000,
      enablePermissions: true,
      defaultPermissions: ['pool:read', 'stats:read'],
      allowedModules: ['lodash', 'axios', 'moment', 'crypto'],
      ...config
    };

    this.sandbox = new PluginSandbox(
      this.config.allowedModules,
      this.config.securityLevel
    );
    
    this.logger = logger || {
      info: (msg: string, data?: any) => console.log(`[PLUGIN] ${msg}`, data || ''),
      error: (msg: string, err?: any) => console.error(`[PLUGIN] ${msg}`, err || ''),
      warn: (msg: string, data?: any) => console.warn(`[PLUGIN] ${msg}`, data || '')
    };

    if (this.config.enableHotReload) {
      this.setupHotReload();
    }
  }

  async initialize(): Promise<void> {
    try {
      await this.discoverPlugins();
      await this.loadAllPlugins();
      this.logger.info('Plugin manager initialized', {
        pluginsLoaded: this.plugins.size
      });
    } catch (error) {
      this.logger.error('Failed to initialize plugin manager', error);
      throw error;
    }
  }

  private async discoverPlugins(): Promise<void> {
    try {
      const pluginDirs = await readdir(this.config.pluginsDirectory);
      
      for (const dir of pluginDirs) {
        const pluginPath = join(this.config.pluginsDirectory, dir);
        const stats = await stat(pluginPath);
        
        if (stats.isDirectory()) {
          try {
            await this.loadPluginManifest(pluginPath);
          } catch (error) {
            this.logger.warn(`Failed to load plugin from ${dir}`, error);
          }
        }
      }
    } catch (error) {
      this.logger.warn('Plugin directory not found or inaccessible', error);
    }
  }

  private async loadPluginManifest(pluginPath: string): Promise<void> {
    const manifestPath = join(pluginPath, 'plugin.json');
    
    try {
      const manifestContent = await readFile(manifestPath, 'utf8');
      const manifest: PluginManifest = JSON.parse(manifestContent);
      
      // バリデーション
      this.validateManifest(manifest);
      
      const plugin: PluginInstance = {
        id: `${manifest.name}@${manifest.version}`,
        manifest,
        module: null,
        state: PluginState.UNLOADED,
        loadedAt: 0,
        config: { ...manifest.config?.defaults },
        context: this.createPluginContext(manifest.name),
        dependencies: manifest.dependencies || [],
        dependents: []
      };

      this.plugins.set(manifest.name, plugin);
      this.dependencyResolver.addPlugin(plugin);
      
    } catch (error) {
      throw new Error(`Invalid plugin manifest: ${error.message}`);
    }
  }

  private validateManifest(manifest: PluginManifest): void {
    const required = ['name', 'version', 'description', 'author', 'main'];
    
    for (const field of required) {
      if (!manifest[field as keyof PluginManifest]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    // バージョン形式チェック
    if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
      throw new Error('Invalid version format');
    }
  }

  private createPluginContext(pluginName: string): PluginContext {
    const api: PluginAPI = {
      // Core API
      getVersion: () => '1.0.0',
      getPlugins: () => Array.from(this.plugins.keys()),
      getPlugin: (name: string) => this.plugins.get(name) || null,

      // Event API
      on: (event: string, handler: Function) => this.on(event, handler),
      emit: (event: string, ...args: any[]) => this.emit(event, ...args),
      off: (event: string, handler: Function) => this.off(event, handler),

      // Hook API
      addHook: (name: string, handler: Function, priority?: number) => {
        this.hookSystem.addHook(name, pluginName, handler, priority);
      },
      removeHook: (name: string, handler: Function) => {
        this.hookSystem.removeHook(name, pluginName);
      },
      executeHook: (name: string, ...args: any[]) => {
        return this.hookSystem.executeHook(name, ...args);
      },

      // Service API
      registerService: (name: string, service: any) => {
        this.serviceRegistry.register(name, service, pluginName);
      },
      getService: (name: string) => this.serviceRegistry.get(name),
      unregisterService: (name: string) => {
        this.serviceRegistry.unregister(name);
      },

      // Configuration API
      getConfig: (key?: string) => {
        const plugin = this.plugins.get(pluginName);
        if (!plugin) return null;
        return key ? plugin.config[key] : plugin.config;
      },
      setConfig: (key: string, value: any) => {
        const plugin = this.plugins.get(pluginName);
        if (plugin) {
          plugin.config[key] = value;
        }
      },

      // Storage API
      getData: (key: string) => {
        const pluginData = this.pluginData.get(pluginName);
        return pluginData?.get(key);
      },
      setData: (key: string, value: any) => {
        if (!this.pluginData.has(pluginName)) {
          this.pluginData.set(pluginName, new Map());
        }
        this.pluginData.get(pluginName)!.set(key, value);
      },
      deleteData: (key: string) => {
        const pluginData = this.pluginData.get(pluginName);
        pluginData?.delete(key);
      },

      // HTTP API
      addRoute: (path: string, handler: Function, methods: string[] = ['GET']) => {
        this.routes.set(path, { handler, methods, plugin: pluginName });
      },
      removeRoute: (path: string) => {
        const route = this.routes.get(path);
        if (route && route.plugin === pluginName) {
          this.routes.delete(path);
        }
      },

      // WebSocket API
      addWebSocketHandler: (type: string, handler: Function) => {
        this.wsHandlers.set(type, { handler, plugin: pluginName });
      },
      sendWebSocketMessage: (connectionId: string, message: any) => {
        this.emit('websocket:send', connectionId, message);
      },
      broadcastWebSocketMessage: (message: any, filter?: Function) => {
        this.emit('websocket:broadcast', message, filter);
      }
    };

    return {
      api,
      logger: {
        info: (msg: string, data?: any) => this.logger.info(`[${pluginName}] ${msg}`, data),
        error: (msg: string, err?: any) => this.logger.error(`[${pluginName}] ${msg}`, err),
        warn: (msg: string, data?: any) => this.logger.warn(`[${pluginName}] ${msg}`, data)
      },
      config: {},
      events: this
    };
  }

  private async loadAllPlugins(): Promise<void> {
    // 依存関係順にロード
    const loadOrder = this.calculateLoadOrder();
    
    for (const pluginName of loadOrder) {
      try {
        await this.loadPlugin(pluginName);
      } catch (error) {
        this.logger.error(`Failed to load plugin ${pluginName}`, error);
      }
    }
  }

  private calculateLoadOrder(): string[] {
    const visited = new Set<string>();
    const order: string[] = [];

    const visit = (pluginName: string) => {
      if (visited.has(pluginName)) return;
      
      const plugin = this.plugins.get(pluginName);
      if (!plugin) return;

      // 依存関係を先にロード
      for (const dep of plugin.dependencies) {
        visit(dep);
      }

      visited.add(pluginName);
      order.push(pluginName);
    };

    for (const pluginName of this.plugins.keys()) {
      visit(pluginName);
    }

    return order;
  }

  async loadPlugin(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin '${name}' not found`);
    }

    if (plugin.state !== PluginState.UNLOADED) {
      return false;
    }

    plugin.state = PluginState.LOADING;
    
    try {
      // 依存関係チェック
      for (const dep of plugin.dependencies) {
        const depPlugin = this.plugins.get(dep);
        if (!depPlugin || depPlugin.state !== PluginState.RUNNING) {
          throw new Error(`Dependency '${dep}' is not available`);
        }
      }

      // モジュール読み込み
      const pluginPath = join(this.config.pluginsDirectory, name, plugin.manifest.main);
      const fullPath = resolve(pluginPath);
      
      // セキュアrequireの設定
      global.require = this.sandbox.createSecureRequire(fullPath);
      
      // タイムアウト付きでロード
      const loadPromise = import(fullPath);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Plugin load timeout')), this.config.maxLoadTime);
      });

      plugin.module = await Promise.race([loadPromise, timeoutPromise]);
      plugin.loadedAt = Date.now();
      plugin.state = PluginState.LOADED;

      // プラグイン初期化
      if (plugin.module.initialize) {
        plugin.state = PluginState.STARTING;
        await plugin.module.initialize(plugin.context);
      }

      plugin.state = PluginState.RUNNING;
      
      this.logger.info(`Plugin loaded successfully: ${name}`);
      this.emit('pluginLoaded', plugin);
      
      return true;

    } catch (error) {
      plugin.error = error as Error;
      plugin.state = PluginState.ERROR;
      
      this.logger.error(`Failed to load plugin ${name}`, error);
      this.emit('pluginError', plugin, error);
      
      return false;
    }
  }

  async unloadPlugin(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin || plugin.state !== PluginState.RUNNING) {
      return false;
    }

    // 依存している他のプラグインがないかチェック
    if (!this.dependencyResolver.canUnload(name)) {
      throw new Error(`Cannot unload plugin '${name}': other plugins depend on it`);
    }

    plugin.state = PluginState.STOPPING;

    try {
      // プラグインクリーンアップ
      if (plugin.module.cleanup) {
        await plugin.module.cleanup(plugin.context);
      }

      // リソースクリーンアップ
      this.hookSystem.removePluginHooks(name);
      this.serviceRegistry.unregisterByProvider(name);
      this.pluginData.delete(name);
      
      // ルートとWebSocketハンドラーの削除
      for (const [path, route] of this.routes) {
        if (route.plugin === name) {
          this.routes.delete(path);
        }
      }
      
      for (const [type, handler] of this.wsHandlers) {
        if (handler.plugin === name) {
          this.wsHandlers.delete(type);
        }
      }

      plugin.state = PluginState.STOPPED;
      plugin.module = null;
      
      this.logger.info(`Plugin unloaded: ${name}`);
      this.emit('pluginUnloaded', plugin);
      
      return true;

    } catch (error) {
      plugin.error = error as Error;
      plugin.state = PluginState.ERROR;
      
      this.logger.error(`Failed to unload plugin ${name}`, error);
      return false;
    }
  }

  async reloadPlugin(name: string): Promise<boolean> {
    await this.unloadPlugin(name);
    return await this.loadPlugin(name);
  }

  private setupHotReload(): void {
    this.watchTimer = setInterval(() => {
      // ファイル変更監視（簡易実装）
      this.checkForChanges();
    }, 5000);
  }

  private async checkForChanges(): Promise<void> {
    // 実装は省略（本格実装ではchokidarなどを使用）
    // ファイル変更があった場合はreloadPluginを呼び出す
  }

  // パブリックメソッド
  getPlugin(name: string): PluginInstance | null {
    return this.plugins.get(name) || null;
  }

  getPlugins(filter?: (plugin: PluginInstance) => boolean): PluginInstance[] {
    const plugins = Array.from(this.plugins.values());
    return filter ? plugins.filter(filter) : plugins;
  }

  getRunningPlugins(): PluginInstance[] {
    return this.getPlugins(p => p.state === PluginState.RUNNING);
  }

  executeHook(name: string, ...args: any[]): Promise<any[]> {
    return this.hookSystem.executeHook(name, ...args);
  }

  getService(name: string): any {
    return this.serviceRegistry.get(name);
  }

  getRoutes(): Map<string, { handler: Function; methods: string[]; plugin: string }> {
    return new Map(this.routes);
  }

  getWebSocketHandlers(): Map<string, { handler: Function; plugin: string }> {
    return new Map(this.wsHandlers);
  }

  getStats() {
    const plugins = Array.from(this.plugins.values());
    const stateCount = plugins.reduce((acc, plugin) => {
      acc[plugin.state] = (acc[plugin.state] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return {
      totalPlugins: plugins.length,
      runningPlugins: plugins.filter(p => p.state === PluginState.RUNNING).length,
      stateDistribution: stateCount,
      services: this.serviceRegistry.getServices().length,
      hooks: this.hookSystem.getHooks().length,
      routes: this.routes.size,
      wsHandlers: this.wsHandlers.size,
      config: this.config
    };
  }

  stop(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
    }

    // 全プラグインを停止
    for (const plugin of this.plugins.values()) {
      if (plugin.state === PluginState.RUNNING) {
        this.unloadPlugin(plugin.manifest.name).catch(error => {
          this.logger.error(`Failed to stop plugin ${plugin.manifest.name}`, error);
        });
      }
    }

    this.logger.info('Plugin manager stopped');
  }
}

export {
  LightPluginManager,
  PluginManifest,
  PluginInstance,
  PluginState,
  PluginContext,
  PluginAPI,
  PluginArchitectureConfig,
  DependencyResolver,
  HookSystem,
  ServiceRegistry
};