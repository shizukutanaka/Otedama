/**
 * Simple Logger - Fast and Lightweight
 * Design: Rob Pike (Simple) + John Carmack (Fast)
 */

import * as fs from 'fs';
import * as path from 'path';

enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3
}

interface LogEntry {
  timestamp: number;
  level: LogLevel;
  component: string;
  message: string;
  data?: any;
}

class SimpleLogger {
  private logDir: string;
  private maxLevel: LogLevel;
  private writeStream: fs.WriteStream | null = null;
  private logQueue: string[] = [];
  private isFlushingLogs = false;
  
  constructor(logDir: string = './logs', maxLevel: LogLevel = LogLevel.INFO) {
    this.logDir = logDir;
    this.maxLevel = maxLevel;
    
    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    this.initializeLogFile();
    this.startLogFlush();
  }
  
  private initializeLogFile(): void {
    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(this.logDir, `pool-${today}.log`);
    
    this.writeStream = fs.createWriteStream(logFile, { flags: 'a' });
    this.writeStream.on('error', (error) => {
      console.error('Log file write error:', error);
    });
  }
  
  private startLogFlush(): void {
    // Flush logs every 100ms for performance
    setInterval(() => {
      this.flushLogs();
    }, 100);
  }
  
  private flushLogs(): void {
    if (this.isFlushingLogs || this.logQueue.length === 0 || !this.writeStream) {
      return;
    }
    
    this.isFlushingLogs = true;
    
    try {
      const logs = this.logQueue.splice(0);
      const logData = logs.join('');
      this.writeStream.write(logData);
    } catch (error) {
      console.error('Log flush error:', error);
    } finally {
      this.isFlushingLogs = false;
    }
  }
  
  private formatLog(entry: LogEntry): string {
    const timestamp = new Date(entry.timestamp).toISOString();
    const level = LogLevel[entry.level];
    const data = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
    
    return `[${timestamp}] ${level} [${entry.component}] ${entry.message}${data}\n`;
  }
  
  private log(level: LogLevel, component: string, message: string, data?: any): void {
    if (level > this.maxLevel) return;
    
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      component,
      message,
      data
    };
    
    // Console output (sync for immediate feedback)
    const formattedLog = this.formatLog(entry);
    if (level <= LogLevel.WARN) {
      console.error(formattedLog.trim());
    } else {
      console.log(formattedLog.trim());
    }
    
    // Queue for file output (async for performance)
    this.logQueue.push(formattedLog);
  }
  
  error(component: string, message: string, error?: Error, data?: any): void {
    const errorData = error ? {
      message: error.message,
      stack: error.stack,
      ...data
    } : data;
    
    this.log(LogLevel.ERROR, component, message, errorData);
  }
  
  warn(component: string, message: string, data?: any): void {
    this.log(LogLevel.WARN, component, message, data);
  }
  
  info(component: string, message: string, data?: any): void {
    this.log(LogLevel.INFO, component, message, data);
  }
  
  debug(component: string, message: string, data?: any): void {
    this.log(LogLevel.DEBUG, component, message, data);
  }
  
  // Performance metrics logging
  metric(component: string, metric: string, value: number, labels?: Record<string, string>): void {
    const data = {
      metric,
      value,
      labels: labels || {}
    };
    
    this.log(LogLevel.INFO, component, `METRIC: ${metric}`, data);
  }
  
  // Cleanup old log files
  cleanup(daysToKeep: number = 7): void {
    try {
      const files = fs.readdirSync(this.logDir);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
      
      for (const file of files) {
        if (file.startsWith('pool-') && file.endsWith('.log')) {
          const filePath = path.join(this.logDir, file);
          const stats = fs.statSync(filePath);
          
          if (stats.mtime < cutoffDate) {
            fs.unlinkSync(filePath);
            console.log(`Removed old log file: ${file}`);
          }
        }
      }
    } catch (error) {
      console.error('Log cleanup error:', error);
    }
  }
  
  close(): void {
    this.flushLogs();
    
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }
}

// Component-specific logger wrapper
class ComponentLogger {
  constructor(private logger: SimpleLogger, private component: string) {}
  
  error(message: string, error?: Error, data?: any): void {
    this.logger.error(this.component, message, error, data);
  }
  
  warn(message: string, data?: any): void {
    this.logger.warn(this.component, message, data);
  }
  
  info(message: string, data?: any): void {
    this.logger.info(this.component, message, data);
  }
  
  debug(message: string, data?: any): void {
    this.logger.debug(this.component, message, data);
  }
  
  metric(metric: string, value: number, labels?: Record<string, string>): void {
    this.logger.metric(this.component, metric, value, labels);
  }
}

// Singleton instance
let instance: SimpleLogger | null = null;

export function getLogger(logDir?: string, maxLevel?: LogLevel): SimpleLogger {
  if (!instance) {
    instance = new SimpleLogger(logDir, maxLevel);
  }
  return instance;
}

export function createComponentLogger(component: string): ComponentLogger {
  const logger = getLogger();
  return new ComponentLogger(logger, component);
}

export { SimpleLogger, ComponentLogger, LogLevel };
