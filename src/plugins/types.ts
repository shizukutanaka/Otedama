/**
 * Plugin System Type Definitions
 */

export interface PluginConfig {
    enableSandbox?: boolean;
    enableWorkers?: boolean;
    maxWorkers?: number;
    pluginTimeout?: number;
    allowedModules?: string[];
}

export type PluginHookHandler = (...args: any[]) => any | Promise<any>;

export type PluginLifecycleMethod = () => Promise<void>;

export interface PluginStorage {
    get(key: string): Promise<any>;
    set(key: string, value: any): Promise<void>;
    delete(key: string): Promise<void>;
    clear(): Promise<void>;
}

export interface PluginPermission {
    name: string;
    description: string;
    resource: string;
    action: string;
}

export interface PluginDependency {
    name: string;
    version: string;
    optional?: boolean;
}

export interface PluginManifest {
    name: string;
    version: string;
    description?: string;
    author?: string | { name: string; email?: string; url?: string };
    license?: string;
    homepage?: string;
    repository?: string | { type: string; url: string };
    main: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    hooks?: string[];
    permissions?: string[] | PluginPermission[];
    config?: Record<string, any>;
    configSchema?: Record<string, any>; // JSON Schema
}

export interface PluginLoadOptions {
    force?: boolean;
    validateDependencies?: boolean;
    checkPermissions?: boolean;
}

export interface PluginSearchOptions {
    name?: string;
    version?: string;
    author?: string;
    enabled?: boolean;
    state?: string;
    hasHook?: string;
}

export interface PluginStats {
    name: string;
    loadTime: number;
    memoryUsage: number;
    hookExecutions: Record<string, number>;
    errors: number;
    lastError?: Error;
}
