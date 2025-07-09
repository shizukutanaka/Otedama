import { EventEmitter } from 'events';
import { UnifiedLogger } from '../logging/unified-logger';

/**
 * Graceful Shutdown Manager
 * Philosophy: Clean shutdown prevents data corruption (Martin)
 * Performance: Fast shutdown while maintaining data integrity (Carmack)
 * Simplicity: Clear shutdown sequence and error handling (Pike)
 */

interface ShutdownTask {
  name: string;
  priority: number; // Lower number = higher priority
  timeout: number; // milliseconds
  handler: () => Promise<void>;
  critical: boolean; // If true, failure will be logged but won't stop shutdown
}

interface ShutdownOptions {
  timeout: number; // Total shutdown timeout in milliseconds
  gracePeriod: number; // Grace period before forceful shutdown
  signal?: string; // Signal that triggered shutdown
}

type ShutdownHandler = (signal: string) => Promise<void>;

export class GracefulShutdownManager extends EventEmitter {
  private tasks = new Map<string, ShutdownTask>();
  private shutdownHandlers: ShutdownHandler[] = [];
  private isShuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private shutdownStartTime: number = 0;

  private readonly defaultOptions: ShutdownOptions = {
    timeout: 30000, // 30 seconds
    gracePeriod: 5000, // 5 seconds
    signal: 'SIGTERM'
  };

  constructor(private logger?: UnifiedLogger) {
    super();
    this.setupSignalHandlers();
  }

  private setupSignalHandlers(): void {
    // Handle termination signals
    const signals = ['SIGTERM', 'SIGINT', 'SIGUSR2'];
    
    signals.forEach(signal => {
      process.on(signal, () => {
        this.initiateShutdown({ ...this.defaultOptions, signal });
      });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.logger?.error('Uncaught exception during shutdown', error);
      this.initiateShutdown({ 
        ...this.defaultOptions, 
        signal: 'UNCAUGHT_EXCEPTION',
        timeout: 10000 // Shorter timeout for crashes
      });
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      this.logger?.error('Unhandled promise rejection during shutdown', { reason, promise });
      this.initiateShutdown({ 
        ...this.defaultOptions, 
        signal: 'UNHANDLED_REJECTION',
        timeout: 10000
      });
    });
  }

  /**
   * Register a shutdown task
   */
  public registerTask(
    name: string, 
    handler: () => Promise<void>, 
    options: {
      priority?: number;
      timeout?: number;
      critical?: boolean;
    } = {}
  ): void {
    const task: ShutdownTask = {
      name,
      priority: options.priority || 50,
      timeout: options.timeout || 5000,
      handler,
      critical: options.critical || false
    };

    this.tasks.set(name, task);
    this.logger?.debug('Shutdown task registered', { name, priority: task.priority });
  }

  /**
   * Unregister a shutdown task
   */
  public unregisterTask(name: string): boolean {
    const removed = this.tasks.delete(name);
    if (removed) {
      this.logger?.debug('Shutdown task unregistered', { name });
    }
    return removed;
  }

  /**
   * Register a general shutdown handler
   */
  public onShutdown(handler: ShutdownHandler): void {
    this.shutdownHandlers.push(handler);
  }

  /**
   * Initiate graceful shutdown
   */
  public async initiateShutdown(options: Partial<ShutdownOptions> = {}): Promise<void> {
    if (this.isShuttingDown) {
      return this.shutdownPromise!;
    }

    this.isShuttingDown = true;
    this.shutdownStartTime = Date.now();
    
    const shutdownOptions = { ...this.defaultOptions, ...options };
    
    this.logger?.info('Initiating graceful shutdown', {
      signal: shutdownOptions.signal,
      timeout: shutdownOptions.timeout,
      gracePeriod: shutdownOptions.gracePeriod
    });

    this.emit('shutdown:started', shutdownOptions);

    this.shutdownPromise = this.performShutdown(shutdownOptions);
    return this.shutdownPromise;
  }

  private async performShutdown(options: ShutdownOptions): Promise<void> {
    const shutdownTimeout = setTimeout(() => {
      this.logger?.warn('Shutdown timeout reached, forcing exit', {
        timeout: options.timeout,
        elapsed: Date.now() - this.shutdownStartTime
      });
      this.forceShutdown();
    }, options.timeout);

    try {
      // Step 1: Execute custom shutdown handlers
      await this.executeShutdownHandlers(options.signal!);

      // Step 2: Execute registered tasks in priority order
      await this.executeShutdownTasks();

      // Step 3: Emit completion event
      this.emit('shutdown:completed', {
        duration: Date.now() - this.shutdownStartTime,
        signal: options.signal
      });

      this.logger?.info('Graceful shutdown completed', {
        duration: Date.now() - this.shutdownStartTime,
        signal: options.signal
      });

    } catch (error) {
      this.logger?.error('Error during graceful shutdown', error);
      this.emit('shutdown:error', error);
    } finally {
      clearTimeout(shutdownTimeout);
    }
  }

  private async executeShutdownHandlers(signal: string): Promise<void> {
    this.logger?.debug('Executing shutdown handlers', { count: this.shutdownHandlers.length });

    const handlerPromises = this.shutdownHandlers.map(async (handler, index) => {
      try {
        await Promise.race([
          handler(signal),
          this.timeoutPromise(5000, `Shutdown handler ${index}`)
        ]);
      } catch (error) {
        this.logger?.error(`Shutdown handler ${index} failed`, error);
      }
    });

    await Promise.allSettled(handlerPromises);
  }

  private async executeShutdownTasks(): Promise<void> {
    // Sort tasks by priority (lower number = higher priority)
    const sortedTasks = Array.from(this.tasks.values())
      .sort((a, b) => a.priority - b.priority);

    this.logger?.debug('Executing shutdown tasks', { 
      count: sortedTasks.length,
      tasks: sortedTasks.map(t => ({ name: t.name, priority: t.priority }))
    });

    for (const task of sortedTasks) {
      await this.executeTask(task);
    }
  }

  private async executeTask(task: ShutdownTask): Promise<void> {
    const taskStart = Date.now();
    
    try {
      this.logger?.debug('Executing shutdown task', { name: task.name });
      this.emit('task:started', task.name);

      await Promise.race([
        task.handler(),
        this.timeoutPromise(task.timeout, `Task: ${task.name}`)
      ]);

      const duration = Date.now() - taskStart;
      this.logger?.debug('Shutdown task completed', { name: task.name, duration });
      this.emit('task:completed', { name: task.name, duration });

    } catch (error) {
      const duration = Date.now() - taskStart;
      
      if (task.critical) {
        this.logger?.error('Critical shutdown task failed', { 
          name: task.name, 
          duration, 
          error: error.message 
        });
        this.emit('task:failed', { name: task.name, duration, error, critical: true });
        throw error;
      } else {
        this.logger?.warn('Non-critical shutdown task failed', { 
          name: task.name, 
          duration, 
          error: error.message 
        });
        this.emit('task:failed', { name: task.name, duration, error, critical: false });
      }
    }
  }

  private timeoutPromise(ms: number, context: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Timeout after ${ms}ms in ${context}`));
      }, ms);
    });
  }

  private forceShutdown(): void {
    this.logger?.warn('Forcing shutdown due to timeout');
    this.emit('shutdown:forced');
    
    // Give a brief moment for logs to flush
    setTimeout(() => {
      process.exit(1);
    }, 100);
  }

  /**
   * Check if shutdown is in progress
   */
  public isShutdownInProgress(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Get shutdown statistics
   */
  public getShutdownStats(): {
    isShuttingDown: boolean;
    tasksRegistered: number;
    handlersRegistered: number;
    shutdownStartTime: number | null;
    elapsed: number | null;
  } {
    return {
      isShuttingDown: this.isShuttingDown,
      tasksRegistered: this.tasks.size,
      handlersRegistered: this.shutdownHandlers.length,
      shutdownStartTime: this.shutdownStartTime || null,
      elapsed: this.shutdownStartTime ? Date.now() - this.shutdownStartTime : null
    };
  }

  /**
   * Create shutdown manager with common tasks pre-configured
   */
  public static createWithCommonTasks(logger?: UnifiedLogger): GracefulShutdownManager {
    const manager = new GracefulShutdownManager(logger);
    
    // Register common cleanup task
    manager.registerTask(
      'process_cleanup',
      async () => {
        // Basic cleanup operations
        logger?.info('Performing final cleanup');
        
        // Clear any remaining timers/intervals
        if (global.gc) {
          global.gc();
        }
      },
      { priority: 95, timeout: 2000, critical: false }
    );

    return manager;
  }
}