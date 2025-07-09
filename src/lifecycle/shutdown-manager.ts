// Graceful shutdown manager
// Ensures all resources are properly cleaned up on shutdown

import { Container } from '../di/container';
import { Logger } from '../logging/logger';
import { InitializationManager } from '../initialization/base-initializer';
import { AlertManager } from '../alerts/alert-manager';

export class ShutdownManager {
  private container: Container;
  private logger: Logger;
  private initManager: InitializationManager;
  private shutdownCallbacks: Array<() => Promise<void>> = [];
  private isShuttingDown = false;
  
  constructor(container: Container, initManager: InitializationManager) {
    this.container = container;
    this.initManager = initManager;
    this.logger = new Logger('ShutdownManager');
    
    this.setupSignalHandlers();
  }
  
  /**
   * Setup signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    
    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught exception:', error);
      this.sendAlert('Uncaught Exception', error.message);
      // Give time for alert to send before crashing
      setTimeout(() => process.exit(1), 1000);
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Unhandled rejection at:', promise, 'reason:', reason);
      this.sendAlert('Unhandled Rejection', String(reason));
    });
  }
  
  /**
   * Perform graceful shutdown
   */
  async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn('Shutdown already in progress');
      return;
    }
    
    this.isShuttingDown = true;
    this.logger.info(`Received ${signal}, shutting down gracefully...`);
    
    try {
      // Stop accepting new connections
      await this.stopAcceptingConnections();
      
      // Wait for existing connections to finish
      this.logger.info('Waiting for existing connections to finish...');
      await this.waitForConnections(5000);
      
      // Run shutdown callbacks
      for (const callback of this.shutdownCallbacks) {
        try {
          await callback();
        } catch (error) {
          this.logger.error('Error in shutdown callback:', error as Error);
        }
      }
      
      // Stop all services
      await this.stopAllServices();
      
      // Run cleanup from initializers
      await this.initManager.cleanup();
      
      // Close Redis connection
      const redis = this.container.get('redis');
      if (redis && typeof redis.disconnect === 'function') {
        await redis.disconnect();
      }
      
      this.logger.info('Shutdown complete');
      process.exit(0);
      
    } catch (error) {
      this.logger.error('Error during shutdown:', error as Error);
      process.exit(1);
    }
  }
  
  /**
   * Stop accepting new connections
   */
  private async stopAcceptingConnections(): Promise<void> {
    const core = this.container.get('core');
    if (core && typeof core.stopAcceptingConnections === 'function') {
      core.stopAcceptingConnections();
    }
  }
  
  /**
   * Wait for existing connections to finish
   */
  private async waitForConnections(timeout: number): Promise<void> {
    const startTime = Date.now();
    const core = this.container.get('core');
    
    while (Date.now() - startTime < timeout) {
      if (core && typeof core.getConnectedMiners === 'function') {
        const miners = core.getConnectedMiners();
        if (miners.size === 0) {
          break;
        }
        this.logger.info(`Waiting for ${miners.size} miners to disconnect...`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  /**
   * Stop all services
   */
  private async stopAllServices(): Promise<void> {
    const services = [
      'pluginManager',
      'core',
      'wsServer',
      'dashboardServer',
      'apiServer',
      'metricsServer',
      'multiPortServer',
      'backupManager',
      'smartPool',
      'miningProxy'
    ];
    
    const stopPromises: Promise<void>[] = [];
    
    for (const serviceName of services) {
      const service = this.container.get(serviceName);
      if (service) {
        if (typeof service.stop === 'function') {
          this.logger.info(`Stopping ${serviceName}...`);
          stopPromises.push(
            service.stop().catch((error: Error) => {
              this.logger.error(`Error stopping ${serviceName}:`, error);
            })
          );
        } else if (typeof service.stopAll === 'function') {
          // For plugin manager
          this.logger.info(`Stopping ${serviceName}...`);
          stopPromises.push(
            service.stopAll().catch((error: Error) => {
              this.logger.error(`Error stopping ${serviceName}:`, error);
            })
          );
        }
      }
    }
    
    await Promise.all(stopPromises);
  }
  
  /**
   * Send alert if alert manager is available
   */
  private sendAlert(title: string, message: string): void {
    const alertManager = this.container.get<AlertManager>('alertManager');
    if (alertManager) {
      // Fire and forget - don't wait for alert to send
      alertManager.sendAlert(title, message).catch(() => {
        // Ignore errors when sending alerts during shutdown
      });
    }
  }
  
  /**
   * Register a callback to run during shutdown
   */
  onShutdown(callback: () => Promise<void>): void {
    this.shutdownCallbacks.push(callback);
  }
  
  /**
   * Force immediate shutdown (for emergencies)
   */
  forceShutdown(exitCode: number = 1): void {
    this.logger.warn('Forcing immediate shutdown');
    process.exit(exitCode);
  }
}
