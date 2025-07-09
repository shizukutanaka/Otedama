/**
 * Plugin System Exports
 */

export { 
    PluginManager,
    Plugin,
    PluginMetadata,
    PluginInstance,
    PluginState,
    PluginHook,
    PluginContext,
    PluginAPI,
    PLUGIN_HOOKS
} from './plugin-manager';

export {
    BasePlugin,
    Plugin as PluginDecorator,
    Hook,
    RequirePermission,
    Cache
} from './base-plugin';

// Re-export types for convenience
export type { 
    PluginConfig,
    PluginHookHandler,
    PluginLifecycleMethod
} from './types';

// Utility functions
export { createPluginManager } from './utils';
