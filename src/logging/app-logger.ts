/**
 * App Logger - 高性能アプリケーションロギングシステム
 * 
 * 設計思想: John Carmack (高性能・実用的)
 * 
 * 機能:
 * - 構造化ログ出力
 * - ファイルローテーション
 * - パフォーマンス重視
 * - エラー追跡
 * - デバッグ支援
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  TRACE = 4
}

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  component: string;
  message: string;
  data?: any;
  error?: Error;
  sessionId: string;
}

export interface LoggerConfig {
  level: LogLevel;
  enableConsole: boolean;
  enableFile: boolean;
  enableStructured: boolean;
  maxFileSize: number; // bytes
  maxFiles: number;
  bufferSize: number;
  flushInterval: number; // ms
}

export class AppLogger {
  private component: string;
  private config: LoggerConfig;
  private logDir: string;
  private currentLogFile: string;
  private buffer: LogEntry[] = [];
  private flushTimer?: NodeJS.Timeout;
  private sessionId: string;
  private static globalConfig: LoggerConfig = {
    level: LogLevel.INFO,
    enableConsole: true,
    enableFile: true,
    enableStructured: true,
    maxFileSize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
    bufferSize: 100,
    flushInterval: 5000 // 5秒
  };

  constructor(component: string, config?: Partial<LoggerConfig>) {
    this.component = component;
    this.config = { ...AppLogger.globalConfig, ...config };
    this.sessionId = this.generateSessionId();
    this.logDir = this.getLogDirectory();
    this.currentLogFile = this.getLogFilePath();
    
    this.ensureLogDirectory();
    this.startFlushTimer();
  }

  private generateSessionId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  private getLogDirectory(): string {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'logs');
  }

  private getLogFilePath(): string {
    const today = new Date().toISOString().split('T')[0];
    return path.join(this.logDir, `otedama-${today}.log`);
  }

  private ensureLogDirectory(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.config.flushInterval);
  }

  private createLogEntry(level: LogLevel, message: string, data?: any, error?: Error): LogEntry {
    return {
      timestamp: Date.now(),
      level,
      component: this.component,
      message,
      data,
      error,
      sessionId: this.sessionId
    };
  }

  private shouldLog(level: LogLevel): boolean {
    return level <= this.config.level;
  }

  private formatForConsole(entry: LogEntry): string {
    const timestamp = new Date(entry.timestamp).toISOString();
    const levelName = LogLevel[entry.level];
    const component = `[${entry.component}]`;
    
    let output = `${timestamp} ${levelName.padEnd(5)} ${component.padEnd(12)} ${entry.message}`;
    
    if (entry.data) {
      output += '\n' + JSON.stringify(entry.data, null, 2);
    }
    
    if (entry.error) {
      output += '\n' + entry.error.stack;
    }
    
    return output;
  }

  private formatForFile(entry: LogEntry): string {
    if (this.config.enableStructured) {
      return JSON.stringify({
        timestamp: entry.timestamp,
        level: LogLevel[entry.level],
        component: entry.component,
        message: entry.message,
        data: entry.data,
        error: entry.error ? {
          name: entry.error.name,
          message: entry.error.message,
          stack: entry.error.stack
        } : undefined,
        sessionId: entry.sessionId
      }) + '\n';
    } else {
      return this.formatForConsole(entry) + '\n';
    }
  }

  private writeToConsole(entry: LogEntry): void {
    if (!this.config.enableConsole) return;

    const formatted = this.formatForConsole(entry);
    
    switch (entry.level) {
      case LogLevel.ERROR:
        console.error(formatted);
        break;
      case LogLevel.WARN:
        console.warn(formatted);
        break;
      case LogLevel.INFO:
        console.info(formatted);
        break;
      case LogLevel.DEBUG:
      case LogLevel.TRACE:
        console.log(formatted);
        break;
    }
  }

  private addToBuffer(entry: LogEntry): void {
    if (!this.config.enableFile) return;

    this.buffer.push(entry);
    
    if (this.buffer.length >= this.config.bufferSize) {
      this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    try {
      // ログローテーションチェック
      await this.checkLogRotation();
      
      const entries = this.buffer.splice(0);
      const output = entries.map(entry => this.formatForFile(entry)).join('');
      
      await fs.promises.appendFile(this.currentLogFile, output);
      
    } catch (error) {
      console.error('Failed to flush logs:', error);
    }
  }

  private async checkLogRotation(): Promise<void> {
    try {
      const stats = await fs.promises.stat(this.currentLogFile);
      
      if (stats.size > this.config.maxFileSize) {
        await this.rotateLogFile();
      }
    } catch (error) {
      // ファイルが存在しない場合は新しく作成される
    }
  }

  private async rotateLogFile(): Promise<void> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedFile = path.join(
        this.logDir, 
        `otedama-${timestamp}.log`
      );
      
      await fs.promises.rename(this.currentLogFile, rotatedFile);
      
      // 古いログファイルを削除
      await this.cleanupOldLogs();
      
    } catch (error) {
      console.error('Failed to rotate log file:', error);
    }
  }

  private async cleanupOldLogs(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.logDir);
      const logFiles = files
        .filter(file => file.startsWith('otedama-') && file.endsWith('.log'))
        .map(file => ({
          name: file,
          path: path.join(this.logDir, file),
          mtime: fs.statSync(path.join(this.logDir, file)).mtime
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      if (logFiles.length > this.config.maxFiles) {
        const filesToDelete = logFiles.slice(this.config.maxFiles);
        
        for (const file of filesToDelete) {
          await fs.promises.unlink(file.path);
        }
      }
    } catch (error) {
      console.error('Failed to cleanup old logs:', error);
    }
  }

  private log(level: LogLevel, message: string, data?: any, error?: Error): void {
    if (!this.shouldLog(level)) return;

    const entry = this.createLogEntry(level, message, data, error);
    
    this.writeToConsole(entry);
    this.addToBuffer(entry);
  }

  error(message: string, error?: Error | any, data?: any): void {
    if (error && error.stack) {
      this.log(LogLevel.ERROR, message, data, error);
    } else {
      this.log(LogLevel.ERROR, message, { error, ...data });
    }
  }

  warn(message: string, data?: any): void {
    this.log(LogLevel.WARN, message, data);
  }

  info(message: string, data?: any): void {
    this.log(LogLevel.INFO, message, data);
  }

  debug(message: string, data?: any): void {
    this.log(LogLevel.DEBUG, message, data);
  }

  trace(message: string, data?: any): void {
    this.log(LogLevel.TRACE, message, data);
  }

  success(message: string, data?: any): void {
    this.log(LogLevel.INFO, `✅ ${message}`, data);
  }

  // Performance logging
  time(label: string): void {
    this.debug(`⏱️ Timer started: ${label}`, { timerStart: Date.now() });
  }

  timeEnd(label: string): void {
    this.debug(`⏱️ Timer ended: ${label}`, { timerEnd: Date.now() });
  }

  // Structured logging helpers
  logMiningEvent(event: string, data: any): void {
    this.info(`🔨 Mining: ${event}`, { type: 'mining', event, ...data });
  }

  logPoolEvent(event: string, data: any): void {
    this.info(`🏊 Pool: ${event}`, { type: 'pool', event, ...data });
  }

  logSystemEvent(event: string, data: any): void {
    this.info(`⚙️ System: ${event}`, { type: 'system', event, ...data });
  }

  logSecurityEvent(event: string, data: any): void {
    this.warn(`🔒 Security: ${event}`, { type: 'security', event, ...data });
  }

  logPerformance(metric: string, value: number, unit: string): void {
    this.debug(`📊 Performance: ${metric}`, { 
      type: 'performance', 
      metric, 
      value, 
      unit,
      timestamp: Date.now()
    });
  }

  // Create child logger
  child(childComponent: string): AppLogger {
    return new AppLogger(`${this.component}:${childComponent}`, this.config);
  }

  // Configuration methods
  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  enableConsole(enable: boolean): void {
    this.config.enableConsole = enable;
  }

  enableFile(enable: boolean): void {
    this.config.enableFile = enable;
  }

  // Get log file path for external access
  getLogPath(): string {
    return this.currentLogFile;
  }

  // Export logs
  async exportLogs(outputPath: string, fromDate?: Date, toDate?: Date): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.logDir);
      const logFiles = files
        .filter(file => file.startsWith('otedama-') && file.endsWith('.log'))
        .map(file => path.join(this.logDir, file));

      let allLogs = '';

      for (const file of logFiles) {
        const content = await fs.promises.readFile(file, 'utf8');
        
        if (fromDate || toDate) {
          // フィルタリング処理（簡略化）
          const lines = content.split('\n');
          const filteredLines = lines.filter(line => {
            if (!line.trim()) return false;
            
            try {
              const entry = JSON.parse(line);
              const timestamp = new Date(entry.timestamp);
              
              if (fromDate && timestamp < fromDate) return false;
              if (toDate && timestamp > toDate) return false;
              
              return true;
            } catch {
              return true; // 非JSON行は含める
            }
          });
          
          allLogs += filteredLines.join('\n') + '\n';
        } else {
          allLogs += content;
        }
      }

      await fs.promises.writeFile(outputPath, allLogs);
      
    } catch (error) {
      this.error('Failed to export logs', error);
      throw error;
    }
  }

  // Statistics
  async getLogStats(): Promise<any> {
    try {
      const files = await fs.promises.readdir(this.logDir);
      const logFiles = files.filter(file => 
        file.startsWith('otedama-') && file.endsWith('.log')
      );

      let totalSize = 0;
      let totalEntries = 0;
      const levelCounts = { ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0, TRACE: 0 };

      for (const file of logFiles) {
        const filePath = path.join(this.logDir, file);
        const stats = await fs.promises.stat(filePath);
        totalSize += stats.size;

        if (this.config.enableStructured) {
          const content = await fs.promises.readFile(filePath, 'utf8');
          const lines = content.split('\n').filter(line => line.trim());
          
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              totalEntries++;
              levelCounts[entry.level as keyof typeof levelCounts]++;
            } catch {
              // 非JSON行をスキップ
            }
          }
        }
      }

      return {
        totalFiles: logFiles.length,
        totalSize,
        totalEntries,
        levelCounts,
        currentSession: this.sessionId,
        logDirectory: this.logDir
      };
    } catch (error) {
      this.error('Failed to get log stats', error);
      return null;
    }
  }

  // Cleanup
  async destroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    
    await this.flush();
  }

  // Static methods for global configuration
  static setGlobalLevel(level: LogLevel): void {
    AppLogger.globalConfig.level = level;
  }

  static setGlobalConfig(config: Partial<LoggerConfig>): void {
    AppLogger.globalConfig = { ...AppLogger.globalConfig, ...config };
  }

  static createLogger(component: string, config?: Partial<LoggerConfig>): AppLogger {
    return new AppLogger(component, config);
  }
}

// Singleton instance for global logging
let globalLogger: AppLogger | null = null;

export function getGlobalLogger(): AppLogger {
  if (!globalLogger) {
    globalLogger = new AppLogger('Global');
  }
  return globalLogger;
}

export function setGlobalLogger(logger: AppLogger): void {
  globalLogger = logger;
}

// Performance logging decorator
export function logPerformance(target: any, propertyName: string, descriptor: PropertyDescriptor) {
  const method = descriptor.value;
  
  descriptor.value = function (...args: any[]) {
    const logger = getGlobalLogger();
    const start = Date.now();
    
    logger.trace(`Method ${propertyName} started`);
    
    try {
      const result = method.apply(this, args);
      
      if (result && typeof result.then === 'function') {
        return result.then((res: any) => {
          const duration = Date.now() - start;
          logger.logPerformance(`${propertyName}_async`, duration, 'ms');
          return res;
        });
      } else {
        const duration = Date.now() - start;
        logger.logPerformance(propertyName, duration, 'ms');
        return result;
      }
    } catch (error) {
      const duration = Date.now() - start;
      logger.error(`Method ${propertyName} failed after ${duration}ms`, error);
      throw error;
    }
  };
  
  return descriptor;
}

// Error logging helper
export function logError(component: string, operation: string, error: any): void {
  const logger = getGlobalLogger().child(component);
  logger.error(`Failed to ${operation}`, error);
}

// Mining specific logging helpers
export function logMiningStart(currency: string, devices: string[]): void {
  getGlobalLogger().logMiningEvent('start', { currency, devices });
}

export function logMiningStop(): void {
  getGlobalLogger().logMiningEvent('stop', {});
}

export function logShareSubmitted(currency: string, valid: boolean, difficulty: number): void {
  getGlobalLogger().logMiningEvent('share_submitted', { 
    currency, 
    valid, 
    difficulty 
  });
}

export function logBlockFound(currency: string, height: number, reward: number): void {
  getGlobalLogger().logMiningEvent('block_found', { 
    currency, 
    height, 
    reward 
  });
}
