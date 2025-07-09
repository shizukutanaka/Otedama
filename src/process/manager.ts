// Process manager integration (PM2/systemd ready signal)
import { logger } from '../logging/logger';

export class ProcessManager {
  private isReady = false;
  private shutdownHandlers: (() => Promise<void>)[] = [];
  
  // Signal that the process is ready (for PM2 wait_ready)
  ready(): void {
    if (!this.isReady) {
      this.isReady = true;
      
      // Send ready signal to PM2
      if (process.send) {
        process.send('ready');
      }
      
      // Log for systemd
      logger.info('process', 'Process is ready and accepting connections');
      console.log('READY=1'); // systemd notification
    }
  }
  
  // Register shutdown handler
  onShutdown(handler: () => Promise<void>): void {
    this.shutdownHandlers.push(handler);
  }
  
  // Setup IPC communication with PM2
  setupIPC(): void {
    if (!process.send) {
      return; // Not running under PM2
    }
    
    // Handle IPC messages from PM2
    process.on('message', (msg: any) => {
      if (msg === 'shutdown') {
        this.gracefulShutdown('PM2 shutdown signal');
      }
    });
    
    // Send custom metrics to PM2
    setInterval(() => {
      if (process.send) {
        process.send({
          type: 'process:msg',
          data: {
            memory: process.memoryUsage(),
            cpu: process.cpuUsage()
          }
        });
      }
    }, 30000);
  }
  
  // Graceful shutdown
  private async gracefulShutdown(reason: string): Promise<void> {
    logger.info('process', `Graceful shutdown initiated: ${reason}`);
    
    // Notify systemd
    console.log('STOPPING=1');
    
    try {
      // Run all shutdown handlers
      await Promise.all(
        this.shutdownHandlers.map(handler => 
          this.runWithTimeout(handler(), 10000)
        )
      );
      
      logger.info('process', 'Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('process', 'Graceful shutdown failed', error as Error);
      process.exit(1);
    }
  }
  
  private async runWithTimeout(promise: Promise<void>, timeout: number): Promise<void> {
    return Promise.race([
      promise,
      new Promise<void>((_, reject) => 
        setTimeout(() => reject(new Error('Operation timed out')), timeout)
      )
    ]);
  }
  
  // Health endpoint for monitoring
  getHealth(): {
    status: 'healthy' | 'unhealthy';
    uptime: number;
    memory: NodeJS.MemoryUsage;
    pid: number;
    version: string;
  } {
    return {
      status: this.isReady ? 'healthy' : 'unhealthy',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      pid: process.pid,
      version: process.version
    };
  }
  
  // Setup Windows service support
  setupWindowsService(): void {
    if (process.platform !== 'win32') {
      return;
    }
    
    // Windows service signals
    process.on('SIGBREAK', () => {
      this.gracefulShutdown('Windows service stop');
    });
  }
}

// PM2 custom actions
export function registerPM2Actions(): void {
  if (!process.send) {
    return;
  }
  
  // Custom action: reload config
  process.on('message', (msg: any) => {
    if (msg.type === 'custom:reload-config') {
      logger.info('pm2', 'Reloading configuration...');
      // Implement config reload logic
      process.send!({ type: 'custom:reload-config:result', success: true });
    }
  });
  
  // Custom action: dump stats
  process.on('message', (msg: any) => {
    if (msg.type === 'custom:dump-stats') {
      // Implement stats dump
      process.send!({
        type: 'custom:dump-stats:result',
        data: {
          // Add pool statistics here
        }
      });
    }
  });
}
