import { Plugin } from './types';
import { logger } from '../logging/logger';
import { EventEmitter } from 'events';

export class PluginManager extends EventEmitter {
  private plugins: Map<string, Plugin>;
  private loadedPlugins: Set<string>;

  constructor() {
    super();
    this.plugins = new Map();
    this.loadedPlugins = new Set();
  }

  public registerPlugin(plugin: Plugin): void {
    if (this.plugins.has(plugin.name)) {
      logger.warn(`Plugin ${plugin.name} is already registered`);
      return;
    }

    this.plugins.set(plugin.name, plugin);
    logger.info(`Registered plugin: ${plugin.name}`);
  }

  public loadPlugin(pluginName: string): boolean {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      logger.error(`Plugin ${pluginName} not found`);
      return false;
    }

    if (this.loadedPlugins.has(pluginName)) {
      logger.warn(`Plugin ${pluginName} is already loaded`);
      return true;
    }

    try {
      plugin.initialize();
      this.loadedPlugins.add(pluginName);
      logger.info(`Loaded plugin: ${pluginName}`);
      return true;
    } catch (error) {
      logger.error(`Failed to load plugin ${pluginName}:`, error);
      return false;
    }
  }

  public unloadPlugin(pluginName: string): boolean {
    if (!this.loadedPlugins.has(pluginName)) {
      logger.warn(`Plugin ${pluginName} is not loaded`);
      return false;
    }

    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      logger.error(`Plugin ${pluginName} not found`);
      return false;
    }

    try {
      plugin.deinitialize();
      this.loadedPlugins.delete(pluginName);
      logger.info(`Unloaded plugin: ${pluginName}`);
      return true;
    } catch (error) {
      logger.error(`Failed to unload plugin ${pluginName}:`, error);
      return false;
    }
  }

  public getPlugin(pluginName: string): Plugin | undefined {
    return this.plugins.get(pluginName);
  }

  public getLoadedPlugins(): string[] {
    return Array.from(this.loadedPlugins);
  }

  public emitEvent(eventName: string, data: any): void {
    this.emit(eventName, data);
    
    // Emit to specific plugin listeners
    this.plugins.forEach((plugin) => {
      if (plugin.eventListeners && plugin.eventListeners.has(eventName)) {
        plugin.eventListeners.get(eventName)?.forEach((handler) => {
          try {
            handler(data);
          } catch (error) {
            logger.error(`Error in plugin ${plugin.name} event handler:`, error);
          }
        });
      }
    });
  }

  public on(eventName: string, listener: (...args: any[]) => void): void {
    super.on(eventName, listener);
  }

  public off(eventName: string, listener: (...args: any[]) => void): void {
    super.off(eventName, listener);
  }
}
