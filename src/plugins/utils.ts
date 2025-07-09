/**
 * Plugin System Utilities
 */

import { PluginManager } from './plugin-manager';
import { PluginConfig } from './types';
import { createLogger } from '../utils/logger';

/**
 * Create a configured plugin manager instance
 */
export function createPluginManager(
    pluginDir: string,
    config?: PluginConfig
): PluginManager {
    const defaultConfig: PluginConfig = {
        enableSandbox: true,
        enableWorkers: false,
        maxWorkers: 4,
        pluginTimeout: 30000,
        allowedModules: [
            'path',
            'url',
            'crypto',
            'util',
            'events',
            'stream',
            'buffer',
            'querystring'
        ],
        ...config
    };

    return new PluginManager(pluginDir, defaultConfig);
}

/**
 * Validate plugin manifest
 */
export function validatePluginManifest(manifest: any): string[] {
    const errors: string[] = [];

    if (!manifest.name) {
        errors.push('Missing required field: name');
    } else if (!/^[a-z0-9-_]+$/i.test(manifest.name)) {
        errors.push('Invalid plugin name format');
    }

    if (!manifest.version) {
        errors.push('Missing required field: version');
    } else if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
        errors.push('Invalid version format (must be semver)');
    }

    if (!manifest.main) {
        errors.push('Missing required field: main');
    }

    if (manifest.hooks && !Array.isArray(manifest.hooks)) {
        errors.push('Hooks must be an array');
    }

    if (manifest.permissions && !Array.isArray(manifest.permissions)) {
        errors.push('Permissions must be an array');
    }

    return errors;
}

/**
 * Check if plugin version satisfies requirement
 */
export function satisfiesVersion(version: string, requirement: string): boolean {
    // Simple version check - could be enhanced with semver
    if (requirement === '*' || requirement === 'latest') {
        return true;
    }

    if (requirement.startsWith('^')) {
        // Compatible with minor/patch updates
        const reqMajor = parseInt(requirement.substring(1).split('.')[0]);
        const verMajor = parseInt(version.split('.')[0]);
        return verMajor === reqMajor;
    }

    if (requirement.startsWith('~')) {
        // Compatible with patch updates only
        const reqParts = requirement.substring(1).split('.');
        const verParts = version.split('.');
        return reqParts[0] === verParts[0] && reqParts[1] === verParts[1];
    }

    // Exact match
    return version === requirement;
}

/**
 * Create plugin sandbox context
 */
export function createSandboxContext(allowedGlobals: string[] = []): any {
    const context: any = {
        console: {
            log: (...args: any[]) => console.log('[Plugin]', ...args),
            error: (...args: any[]) => console.error('[Plugin]', ...args),
            warn: (...args: any[]) => console.warn('[Plugin]', ...args),
            info: (...args: any[]) => console.info('[Plugin]', ...args),
            debug: (...args: any[]) => console.debug('[Plugin]', ...args)
        },
        setTimeout,
        setInterval,
        clearTimeout,
        clearInterval,
        setImmediate,
        clearImmediate,
        process: {
            env: {},
            version: process.version,
            platform: process.platform,
            arch: process.arch
        }
    };

    // Add allowed globals
    for (const global of allowedGlobals) {
        if (global in globalThis) {
            context[global] = (globalThis as any)[global];
        }
    }

    return context;
}

/**
 * Plugin error class
 */
export class PluginError extends Error {
    constructor(
        message: string,
        public pluginName: string,
        public code: string = 'PLUGIN_ERROR'
    ) {
        super(message);
        this.name = 'PluginError';
    }
}

/**
 * Plugin validation error
 */
export class PluginValidationError extends PluginError {
    constructor(
        message: string,
        pluginName: string,
        public validationErrors: string[]
    ) {
        super(message, pluginName, 'PLUGIN_VALIDATION_ERROR');
    }
}

/**
 * Plugin dependency error
 */
export class PluginDependencyError extends PluginError {
    constructor(
        message: string,
        pluginName: string,
        public missingDependencies: string[]
    ) {
        super(message, pluginName, 'PLUGIN_DEPENDENCY_ERROR');
    }
}

/**
 * Plugin permission error
 */
export class PluginPermissionError extends PluginError {
    constructor(
        message: string,
        pluginName: string,
        public requiredPermission: string
    ) {
        super(message, pluginName, 'PLUGIN_PERMISSION_ERROR');
    }
}

/**
 * Safe require function for plugins
 */
export function createSafeRequire(
    allowedModules: string[],
    pluginName: string
): (id: string) => any {
    return (id: string) => {
        // Check if module is allowed
        if (!allowedModules.includes(id)) {
            throw new PluginPermissionError(
                `Module '${id}' is not allowed`,
                pluginName,
                `require:${id}`
            );
        }

        // Check if it's a relative path (not allowed for security)
        if (id.startsWith('.') || id.startsWith('/')) {
            throw new PluginPermissionError(
                'Relative imports are not allowed',
                pluginName,
                'require:relative'
            );
        }

        try {
            return require(id);
        } catch (error) {
            throw new PluginError(
                `Failed to require module '${id}': ${error.message}`,
                pluginName,
                'REQUIRE_ERROR'
            );
        }
    };
}
