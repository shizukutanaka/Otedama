/**
 * Plugin System Core
 * 
 * 設計原則:
 * - Martin: SOLID原則、プラグインは単一責任を持つ
 * - Carmack: 最小限のオーバーヘッド、高速な実行
 * - Pike: シンプルなインターフェース、並行性の活用
 */

import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';
import { Worker } from 'worker_threads';
import * as vm from 'vm';

const readFile = promisify(fs.readFile);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);

export interface PluginMetadata {
    name: string;
    version: string;
    description?: string;
    author?: string;
    license?: string;
    main: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    hooks?: string[];
    permissions?: string[];
    config?: Record<string, any>;
}

export interface Plugin {
    metadata: PluginMetadata;
    instance: PluginInstance;
    state: PluginState;
    sandbox?: vm.Context;
    worker?: Worker;
}

export interface PluginInstance {
    onLoad?(): Promise<void>;
    onUnload?(): Promise<void>;
    onEnable?(): Promise<void>;
    onDisable?(): Promise<void>;
    [hookName: string]: any;
}

export enum PluginState {
    UNLOADED = 'unloaded',
    LOADED = 'loaded',
    ENABLED = 'enabled',
    DISABLED = 'disabled',
    ERROR = 'error'
}

export interface PluginHook {
    name: string;
    priority: number;
    handler: (...args: any[]) => any | Promise<any>;
}

export interface PluginContext {
    logger: any;
    config: any;
    api: PluginAPI;
    emit: (event: string, ...args: any[]) => void;
}

export interface PluginAPI {
    // Core APIs exposed to plugins
    getPoolStats(): Promise<any>;
    getMinerStats(minerId: string): Promise<any>;
    registerWebhook(url: string, events: string[]): Promise<void>;
    storeData(key: string, value: any): Promise<void>;
    retrieveData(key: string): Promise<any>;
    scheduleTask(task: () => void, interval: number): number;
    cancelTask(taskId: number): void;
}

export class PluginManager extends EventEmitter {
    private plugins: Map<string, Plugin> = new Map();
    private hooks: Map<string, PluginHook[]> = new Map();
    private logger = createLogger('PluginManager');
    private pluginDir: string;
    private pluginAPI: PluginAPI;
    private sandboxOptions: vm.RunningScriptOptions;

    constructor(
        pluginDir: string,
        private config: {
            enableSandbox?: boolean;
            enableWorkers?: boolean;
            maxWorkers?: number;
            pluginTimeout?: number;
            allowedModules?: string[];
        } = {}
    ) {
        super();
        this.pluginDir = pluginDir;
        this.config = {
            enableSandbox: true,
            enableWorkers: false,
            maxWorkers: 4,
            pluginTimeout: 30000,
            allowedModules: ['path', 'url', 'crypto', 'util'],
            ...config
        };

        this.sandboxOptions = {
            timeout: this.config.pluginTimeout,
            displayErrors: true
        };

        this.pluginAPI = this.createPluginAPI();
    }

    /**
     * Load all plugins from directory
     */
    public async loadPlugins(): Promise<void> {
        this.logger.info(`Loading plugins from ${this.pluginDir}`);

        try {
            const entries = await readdir(this.pluginDir);
            
            for (const entry of entries) {
                const pluginPath = path.join(this.pluginDir, entry);
                const stats = await stat(pluginPath);
                
                if (stats.isDirectory()) {
                    try {
                        await this.loadPlugin(pluginPath);
                    } catch (error) {
                        this.logger.error(`Failed to load plugin from ${pluginPath}:`, error);
                    }
                }
            }

            this.logger.info(`Loaded ${this.plugins.size} plugins`);
        } catch (error) {
            this.logger.error('Error loading plugins:', error);
        }
    }

    /**
     * Load a single plugin
     */
    public async loadPlugin(pluginPath: string): Promise<void> {
        const metadataPath = path.join(pluginPath, 'plugin.json');
        
        try {
            // Read plugin metadata
            const metadataContent = await readFile(metadataPath, 'utf8');
            const metadata: PluginMetadata = JSON.parse(metadataContent);

            // Validate metadata
            this.validateMetadata(metadata);

            // Check dependencies
            await this.checkDependencies(metadata);

            // Create plugin context
            const context = this.createPluginContext(metadata);

            // Load plugin code
            const mainPath = path.join(pluginPath, metadata.main);
            const instance = await this.loadPluginCode(mainPath, context, metadata);

            // Create plugin object
            const plugin: Plugin = {
                metadata,
                instance,
                state: PluginState.LOADED
            };

            // Store plugin
            this.plugins.set(metadata.name, plugin);

            // Call onLoad lifecycle hook
            if (instance.onLoad) {
                await instance.onLoad();
            }

            this.logger.info(`Loaded plugin: ${metadata.name} v${metadata.version}`);
            this.emit('pluginLoaded', metadata);

        } catch (error) {
            this.logger.error(`Failed to load plugin from ${pluginPath}:`, error);
            throw error;
        }
    }

    /**
     * Enable a plugin
     */
    public async enablePlugin(pluginName: string): Promise<void> {
        const plugin = this.plugins.get(pluginName);
        if (!plugin) {
            throw new Error(`Plugin ${pluginName} not found`);
        }

        if (plugin.state === PluginState.ENABLED) {
            return;
        }

        try {
            // Register hooks
            this.registerPluginHooks(plugin);

            // Call onEnable lifecycle hook
            if (plugin.instance.onEnable) {
                await plugin.instance.onEnable();
            }

            plugin.state = PluginState.ENABLED;
            this.logger.info(`Enabled plugin: ${pluginName}`);
            this.emit('pluginEnabled', pluginName);

        } catch (error) {
            plugin.state = PluginState.ERROR;
            this.logger.error(`Failed to enable plugin ${pluginName}:`, error);
            throw error;
        }
    }

    /**
     * Disable a plugin
     */
    public async disablePlugin(pluginName: string): Promise<void> {
        const plugin = this.plugins.get(pluginName);
        if (!plugin) {
            throw new Error(`Plugin ${pluginName} not found`);
        }

        if (plugin.state !== PluginState.ENABLED) {
            return;
        }

        try {
            // Call onDisable lifecycle hook
            if (plugin.instance.onDisable) {
                await plugin.instance.onDisable();
            }

            // Unregister hooks
            this.unregisterPluginHooks(plugin);

            plugin.state = PluginState.DISABLED;
            this.logger.info(`Disabled plugin: ${pluginName}`);
            this.emit('pluginDisabled', pluginName);

        } catch (error) {
            this.logger.error(`Failed to disable plugin ${pluginName}:`, error);
            throw error;
        }
    }

    /**
     * Unload a plugin
     */
    public async unloadPlugin(pluginName: string): Promise<void> {
        const plugin = this.plugins.get(pluginName);
        if (!plugin) {
            return;
        }

        try {
            // Disable first if enabled
            if (plugin.state === PluginState.ENABLED) {
                await this.disablePlugin(pluginName);
            }

            // Call onUnload lifecycle hook
            if (plugin.instance.onUnload) {
                await plugin.instance.onUnload();
            }

            // Clean up worker if exists
            if (plugin.worker) {
                await plugin.worker.terminate();
            }

            // Remove from registry
            this.plugins.delete(pluginName);

            this.logger.info(`Unloaded plugin: ${pluginName}`);
            this.emit('pluginUnloaded', pluginName);

        } catch (error) {
            this.logger.error(`Failed to unload plugin ${pluginName}:`, error);
            throw error;
        }
    }

    /**
     * Execute hook
     */
    public async executeHook(hookName: string, ...args: any[]): Promise<any[]> {
        const hooks = this.hooks.get(hookName) || [];
        const results: any[] = [];

        // Sort by priority (lower number = higher priority)
        const sortedHooks = hooks.sort((a, b) => a.priority - b.priority);

        for (const hook of sortedHooks) {
            try {
                const result = await hook.handler(...args);
                results.push(result);

                // If hook returns false, stop processing
                if (result === false) {
                    break;
                }
            } catch (error) {
                this.logger.error(`Error executing hook ${hookName}:`, error);
                this.emit('hookError', { hookName, error });
            }
        }

        return results;
    }

    /**
     * Register a hook from external code
     */
    public registerHook(hookName: string, handler: Function, priority: number = 10): void {
        if (!this.hooks.has(hookName)) {
            this.hooks.set(hookName, []);
        }

        this.hooks.get(hookName)!.push({
            name: hookName,
            priority,
            handler: handler as any
        });
    }

    /**
     * Get plugin info
     */
    public getPlugin(pluginName: string): Plugin | undefined {
        return this.plugins.get(pluginName);
    }

    /**
     * Get all plugins
     */
    public getAllPlugins(): Plugin[] {
        return Array.from(this.plugins.values());
    }

    /**
     * Get enabled plugins
     */
    public getEnabledPlugins(): Plugin[] {
        return this.getAllPlugins().filter(p => p.state === PluginState.ENABLED);
    }

    // Private methods

    private validateMetadata(metadata: PluginMetadata): void {
        if (!metadata.name || !metadata.version || !metadata.main) {
            throw new Error('Invalid plugin metadata: missing required fields');
        }

        if (!/^[a-z0-9-_]+$/i.test(metadata.name)) {
            throw new Error('Invalid plugin name: must contain only alphanumeric characters, hyphens, and underscores');
        }

        if (!/^\d+\.\d+\.\d+/.test(metadata.version)) {
            throw new Error('Invalid plugin version: must follow semver format');
        }
    }

    private async checkDependencies(metadata: PluginMetadata): Promise<void> {
        if (!metadata.dependencies) return;

        for (const [dep, version] of Object.entries(metadata.dependencies)) {
            const depPlugin = this.plugins.get(dep);
            
            if (!depPlugin) {
                throw new Error(`Missing dependency: ${dep}`);
            }

            // Simple version check (could be enhanced with semver)
            if (depPlugin.metadata.version !== version) {
                throw new Error(`Dependency version mismatch: ${dep} requires ${version}, found ${depPlugin.metadata.version}`);
            }
        }
    }

    private createPluginContext(metadata: PluginMetadata): PluginContext {
        const pluginLogger = createLogger(`Plugin:${metadata.name}`);
        
        return {
            logger: pluginLogger,
            config: metadata.config || {},
            api: this.pluginAPI,
            emit: (event: string, ...args: any[]) => {
                this.emit(`plugin:${metadata.name}:${event}`, ...args);
            }
        };
    }

    private async loadPluginCode(
        mainPath: string,
        context: PluginContext,
        metadata: PluginMetadata
    ): Promise<PluginInstance> {
        if (this.config.enableWorkers) {
            return this.loadPluginInWorker(mainPath, context, metadata);
        } else if (this.config.enableSandbox) {
            return this.loadPluginInSandbox(mainPath, context, metadata);
        } else {
            return this.loadPluginDirect(mainPath, context);
        }
    }

    private async loadPluginDirect(mainPath: string, context: PluginContext): Promise<PluginInstance> {
        // Direct require (less secure but faster)
        delete require.cache[require.resolve(mainPath)];
        const PluginClass = require(mainPath);
        
        if (PluginClass.default) {
            return new PluginClass.default(context);
        } else if (typeof PluginClass === 'function') {
            return new PluginClass(context);
        } else {
            return PluginClass;
        }
    }

    private async loadPluginInSandbox(
        mainPath: string,
        context: PluginContext,
        metadata: PluginMetadata
    ): Promise<PluginInstance> {
        const code = await readFile(mainPath, 'utf8');
        
        // Create sandbox with limited globals
        const sandbox = {
            console,
            setTimeout,
            setInterval,
            clearTimeout,
            clearInterval,
            Buffer,
            process: {
                env: {},
                version: process.version
            },
            require: this.createSafeRequire(metadata),
            module: { exports: {} },
            exports: {},
            __dirname: path.dirname(mainPath),
            __filename: mainPath,
            context
        };

        vm.createContext(sandbox);
        
        // Run plugin code in sandbox
        const script = new vm.Script(code, {
            filename: mainPath,
            displayErrors: true
        });

        script.runInContext(sandbox, this.sandboxOptions);

        const exports = sandbox.module.exports || sandbox.exports;
        
        if (exports.default) {
            return new exports.default(context);
        } else if (typeof exports === 'function') {
            return new exports(context);
        } else {
            return exports;
        }
    }

    private async loadPluginInWorker(
        mainPath: string,
        context: PluginContext,
        metadata: PluginMetadata
    ): Promise<PluginInstance> {
        // Worker implementation would go here
        // For now, fall back to sandbox
        return this.loadPluginInSandbox(mainPath, context, metadata);
    }

    private createSafeRequire(metadata: PluginMetadata): (id: string) => any {
        return (id: string) => {
            // Only allow specific modules
            if (!this.config.allowedModules?.includes(id)) {
                throw new Error(`Module '${id}' is not allowed for plugins`);
            }
            return require(id);
        };
    }

    private registerPluginHooks(plugin: Plugin): void {
        const { metadata, instance } = plugin;
        
        if (!metadata.hooks) return;

        for (const hookName of metadata.hooks) {
            if (typeof instance[hookName] === 'function') {
                const hook: PluginHook = {
                    name: hookName,
                    priority: 10, // Default priority
                    handler: instance[hookName].bind(instance)
                };

                if (!this.hooks.has(hookName)) {
                    this.hooks.set(hookName, []);
                }

                this.hooks.get(hookName)!.push(hook);
                this.logger.debug(`Registered hook ${hookName} for plugin ${metadata.name}`);
            }
        }
    }

    private unregisterPluginHooks(plugin: Plugin): void {
        const { metadata, instance } = plugin;
        
        if (!metadata.hooks) return;

        for (const hookName of metadata.hooks) {
            const hooks = this.hooks.get(hookName);
            if (hooks) {
                // Remove hooks from this plugin
                const filtered = hooks.filter(h => h.handler !== instance[hookName]);
                if (filtered.length > 0) {
                    this.hooks.set(hookName, filtered);
                } else {
                    this.hooks.delete(hookName);
                }
            }
        }
    }

    private createPluginAPI(): PluginAPI {
        const tasks = new Map<number, NodeJS.Timeout>();
        let taskIdCounter = 0;

        return {
            getPoolStats: async () => {
                // This would connect to the actual pool instance
                return { hashrate: 0, miners: 0 };
            },

            getMinerStats: async (minerId: string) => {
                // This would connect to the actual pool instance
                return { minerId, hashrate: 0, balance: 0 };
            },

            registerWebhook: async (url: string, events: string[]) => {
                this.logger.info(`Plugin registered webhook: ${url} for events: ${events.join(', ')}`);
                // Actual webhook registration would go here
            },

            storeData: async (key: string, value: any) => {
                // Plugin data storage implementation
                this.emit('pluginDataStore', { key, value });
            },

            retrieveData: async (key: string) => {
                // Plugin data retrieval implementation
                return null;
            },

            scheduleTask: (task: () => void, interval: number): number => {
                const taskId = ++taskIdCounter;
                const intervalId = setInterval(task, interval);
                tasks.set(taskId, intervalId);
                return taskId;
            },

            cancelTask: (taskId: number): void => {
                const intervalId = tasks.get(taskId);
                if (intervalId) {
                    clearInterval(intervalId);
                    tasks.delete(taskId);
                }
            }
        };
    }
}

// Hook names for type safety
export const PLUGIN_HOOKS = {
    // Pool events
    POOL_STATS_UPDATE: 'poolStatsUpdate',
    NEW_BLOCK_FOUND: 'newBlockFound',
    SHARE_SUBMITTED: 'shareSubmitted',
    SHARE_ACCEPTED: 'shareAccepted',
    SHARE_REJECTED: 'shareRejected',
    
    // Miner events
    MINER_CONNECTED: 'minerConnected',
    MINER_DISCONNECTED: 'minerDisconnected',
    MINER_AUTHENTICATED: 'minerAuthenticated',
    
    // Payment events
    PAYMENT_PROCESSED: 'paymentProcessed',
    PAYMENT_SENT: 'paymentSent',
    
    // System events
    SYSTEM_STARTUP: 'systemStartup',
    SYSTEM_SHUTDOWN: 'systemShutdown',
    CONFIG_CHANGED: 'configChanged',
    
    // Custom hooks
    BEFORE_SHARE_VALIDATION: 'beforeShareValidation',
    AFTER_SHARE_VALIDATION: 'afterShareValidation',
    BEFORE_PAYMENT_CALCULATION: 'beforePaymentCalculation',
    AFTER_PAYMENT_CALCULATION: 'afterPaymentCalculation'
} as const;
