// Startup manager for coordinating the pool startup process
// Following John Carmack's principle: "Make it work, make it right, make it fast"

import { Container } from '../di/container';
import { Logger } from '../logging/logger';
import { ICompletePoolConfig } from '../config/pool/config-loader';
import { InitializationManager } from '../initialization/base-initializer';
import { CoreInitializer } from '../initialization/core-initializer';
import { SecurityInitializer } from '../initialization/security-initializer';
import { PaymentInitializer } from '../initialization/payment-initializer';
import { NetworkInitializer } from '../initialization/network-initializer';
import { MonitoringInitializer } from '../initialization/monitoring-initializer';
import { AdvancedFeaturesInitializer } from '../initialization/advanced-features-initializer';

export class StartupManager {
  private container: Container;
  private logger: Logger;
  private config: ICompletePoolConfig;
  private initManager: InitializationManager;
  private startupCallbacks: Array<() => Promise<void>> = [];
  
  constructor(config: ICompletePoolConfig) {
    this.config = config;
    this.container = new Container();
    this.logger = new Logger('StartupManager');
    this.initManager = new InitializationManager();
    
    this.registerInitializers();
  }
  
  /**
   * Register all initializers in the correct order
   */
  private registerInitializers(): void {
    // Core must be initialized first (priority 100)
    this.initManager.register('Core', new CoreInitializer(), 100);
    
    // Security depends on core (priority 90)
    this.initManager.register('Security', new SecurityInitializer(), 90);
    
    // Payment systems (priority 80)
    this.initManager.register('Payment', new PaymentInitializer(), 80);
    
    // Network features (priority 70)
    this.initManager.register('Network', new NetworkInitializer(), 70);
    
    // Monitoring (priority 60)
    this.initManager.register('Monitoring', new MonitoringInitializer(), 60);
    
    // Advanced features last (priority 50)
    this.initManager.register('AdvancedFeatures', new AdvancedFeaturesInitializer(), 50);
  }
  
  /**
   * Start the pool
   */
  async start(): Promise<void> {
    this.logger.info('Starting Otedama Pool...');
    
    try {
      // Register core services
      this.container.register('config', this.config);
      this.container.register('logger', this.logger);
      
      // Run all initializers
      await this.initManager.initializeAll(this.config, this.container, this.logger);
      
      // Start all services
      await this.startServices();
      
      // Run startup callbacks
      for (const callback of this.startupCallbacks) {
        await callback();
      }
      
      this.logger.info('Otedama Pool started successfully!');
      this.logStartupInfo();
      
    } catch (error) {
      this.logger.error('Failed to start pool:', error as Error);
      throw error;
    }
  }
  
  /**
   * Start all services
   */
  private async startServices(): Promise<void> {
    const services = [
      { name: 'core', method: 'start' },
      { name: 'wsServer', method: 'start' },
      { name: 'multiPortServer', method: 'start' },
      { name: 'miningProxy', method: 'start' },
      { name: 'dashboardServer', method: 'start' },
      { name: 'apiServer', method: 'start' },
      { name: 'metricsServer', method: 'start' },
      { name: 'mobileAPI', method: 'start' },
      { name: 'backupManager', method: 'start' },
      { name: 'smartPool', method: 'start' },
    ];
    
    for (const { name, method } of services) {
      const service = this.container.get(name);
      if (service && typeof service[method] === 'function') {
        this.logger.info(`Starting ${name}...`);
        await service[method]();
      }
    }
  }
  
  /**
   * Log startup information
   */
  private logStartupInfo(): void {
    this.logger.info(`Main Stratum port: ${this.config.stratumPort}`);
    this.logger.info(`WebSocket port: ${this.config.wsPort}`);
    this.logger.info(`API port: ${this.config.apiPort}`);
    this.logger.info(`Dashboard: http://localhost:${this.config.dashboardPort}`);
    this.logger.info(`Metrics: http://localhost:${this.config.metricsPort}/metrics`);
    
    if (this.config.additionalPorts.length > 0) {
      this.logger.info(`Additional ports: ${this.config.additionalPorts.join(', ')}`);
    }
    
    if (this.config.redisEnabled) {
      this.logger.info('Redis caching enabled');
    }
    
    const enabledFeatures = [];
    if (this.config.enableWebSocket) enabledFeatures.push('WebSocket');
    if (this.config.enableMobileAPI) enabledFeatures.push('Mobile API');
    if (this.config.enableStratumV2) enabledFeatures.push('Stratum V2');
    if (this.config.enableBinaryProtocol) enabledFeatures.push('Binary Protocol');
    if (this.config.enableSmartPool) enabledFeatures.push('Smart Pool');
    if (this.config.enableMergeMining) enabledFeatures.push('Merge Mining');
    
    if (enabledFeatures.length > 0) {
      this.logger.info(`Enabled features: ${enabledFeatures.join(', ')}`);
    }
  }
  
  /**
   * Register a callback to run after startup
   */
  onStartup(callback: () => Promise<void>): void {
    this.startupCallbacks.push(callback);
  }
  
  /**
   * Get the dependency injection container
   */
  getContainer(): Container {
    return this.container;
  }
  
  /**
   * Get the initialization manager (for cleanup)
   */
  getInitManager(): InitializationManager {
    return this.initManager;
  }
}
