/**
 * Base Plugin Class
 * All plugins should extend this class
 */

import { PluginContext, PluginInstance } from './plugin-manager';

export abstract class BasePlugin implements PluginInstance {
    protected context: PluginContext;
    protected logger: any;
    protected config: any;
    protected api: any;

    constructor(context: PluginContext) {
        this.context = context;
        this.logger = context.logger;
        this.config = context.config;
        this.api = context.api;
    }

    /**
     * Called when plugin is loaded
     */
    async onLoad(): Promise<void> {
        this.logger.info('Plugin loaded');
    }

    /**
     * Called when plugin is unloaded
     */
    async onUnload(): Promise<void> {
        this.logger.info('Plugin unloaded');
    }

    /**
     * Called when plugin is enabled
     */
    async onEnable(): Promise<void> {
        this.logger.info('Plugin enabled');
    }

    /**
     * Called when plugin is disabled
     */
    async onDisable(): Promise<void> {
        this.logger.info('Plugin disabled');
    }

    /**
     * Emit an event
     */
    protected emit(event: string, ...args: any[]): void {
        this.context.emit(event, ...args);
    }

    /**
     * Store plugin data
     */
    protected async storeData(key: string, value: any): Promise<void> {
        await this.api.storeData(`${this.constructor.name}:${key}`, value);
    }

    /**
     * Retrieve plugin data
     */
    protected async retrieveData(key: string): Promise<any> {
        return await this.api.retrieveData(`${this.constructor.name}:${key}`);
    }

    /**
     * Schedule a recurring task
     */
    protected scheduleTask(task: () => void, interval: number): number {
        return this.api.scheduleTask(task, interval);
    }

    /**
     * Cancel a scheduled task
     */
    protected cancelTask(taskId: number): void {
        this.api.cancelTask(taskId);
    }
}

/**
 * Plugin decorator for metadata
 */
export function Plugin(metadata: {
    name: string;
    version: string;
    description?: string;
    hooks?: string[];
}) {
    return function (target: any) {
        target.metadata = metadata;
        return target;
    };
}

/**
 * Hook decorator
 */
export function Hook(hookName: string, priority: number = 10) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        if (!target.constructor.hooks) {
            target.constructor.hooks = {};
        }
        target.constructor.hooks[hookName] = {
            method: propertyKey,
            priority
        };
        return descriptor;
    };
}

/**
 * RequirePermission decorator
 */
export function RequirePermission(permission: string) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;
        
        descriptor.value = async function (...args: any[]) {
            // Check permission (would be implemented in actual system)
            const hasPermission = true; // Placeholder
            
            if (!hasPermission) {
                throw new Error(`Permission denied: ${permission}`);
            }
            
            return originalMethod.apply(this, args);
        };
        
        return descriptor;
    };
}

/**
 * Cache decorator for method results
 */
export function Cache(ttl: number = 60000) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;
        const cache = new Map<string, { value: any; expires: number }>();
        
        descriptor.value = async function (...args: any[]) {
            const key = JSON.stringify(args);
            const cached = cache.get(key);
            
            if (cached && cached.expires > Date.now()) {
                return cached.value;
            }
            
            const result = await originalMethod.apply(this, args);
            cache.set(key, {
                value: result,
                expires: Date.now() + ttl
            });
            
            return result;
        };
        
        return descriptor;
    };
}
