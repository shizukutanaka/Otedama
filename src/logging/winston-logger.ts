/**
 * Log Rotation System with Winston Integration
 * Design: Carmack (Performance) + Martin (Clean Architecture) + Pike (Simplicity)
 * 
 * Production-ready logging with rotation, compression, and archival
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import * as net from 'net';

// ===== INTERFACES =====
export interface LogConfig {
  level?: string;
  dir?: string;
  filename?: string;
  datePattern?: string;
  maxSize?: string;
  maxFiles?: string | number;
  zippedArchive?: boolean;
  format?: 'json' | 'simple' | 'detailed';
  console?: boolean;
  handleExceptions?: boolean;
  handleRejections?: boolean;
  elk?: ELKConfig;
}

export interface ELKConfig {
  enabled?: boolean;
  logstashHost?: string;
  logstashPort?: number;
  elasticsearchUrl?: string;
  kibanaUrl?: string;
  index?: string;
  type?: string;
}

export interface LogMetadata {
  component?: string;
  requestId?: string;
  userId?: string;
  action?: string;
  duration?: number;
  [key: string]: any;
}

export interface LogStats {
  totalLogs: number;
  errorCount: number;
  warnCount: number;
  infoCount: number;
  debugCount: number;
  averageLogSize: number;
  rotations: number;
}

// ===== CUSTOM FORMATS =====
const customFormats = {
  simple: winston.format.printf(({ timestamp, level, message, ...meta }) => {
    return `${timestamp} [${level.toUpperCase()}] ${message}`;
  }),

  detailed: winston.format.printf(({ timestamp, level, message, component, ...meta }) => {
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level.toUpperCase()}] [${component || 'System'}] ${message}${metaStr}`;
  }),

  json: winston.format.json()
};

// ===== LOGSTASH TRANSPORT =====
class LogstashTransport extends winston.transports.Stream {
  private socket?: net.Socket;
  private reconnectTimer?: NodeJS.Timeout;
  private connected = false;
  private queue: string[] = [];
  private config: Required<ELKConfig>;

  constructor(config: ELKConfig) {
    super();
    
    this.config = {
      enabled: config.enabled ?? true,
      logstashHost: config.logstashHost || 'logstash',
      logstashPort: config.logstashPort || 5000,
      elasticsearchUrl: config.elasticsearchUrl || 'http://otedama-elasticsearch-es-http:9200',
      kibanaUrl: config.kibanaUrl || 'http://otedama-kibana-kb-http:5601',
      index: config.index || 'otedama-pool-logs',
      type: config.type || 'pool-log'
    };

    if (this.config.enabled) {
      this.connect();
    }
  }

  private connect(): void {
    if (this.socket) {
      this.socket.destroy();
    }

    this.socket = new net.Socket();
    
    this.socket.on('connect', () => {
      this.connected = true;
      this.emit('connect');
      
      // Send queued messages
      while (this.queue.length > 0) {
        const message = this.queue.shift();
        if (message) {
          this.socket!.write(message + '\n');
        }
      }
    });

    this.socket.on('error', (error) => {
      this.connected = false;
      this.emit('error', error);
      this.scheduleReconnect();
    });

    this.socket.on('close', () => {
      this.connected = false;
      this.emit('close');
      this.scheduleReconnect();
    });

    this.socket.connect(this.config.logstashPort, this.config.logstashHost);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, 5000); // Reconnect after 5 seconds
  }

  log(info: any, callback?: () => void): boolean {
    if (!this.config.enabled) {
      if (callback) callback();
      return true;
    }

    // Create Logstash-compatible message
    const logstashMessage = {
      '@timestamp': info.timestamp || new Date().toISOString(),
      '@version': '1',
      host: process.env.HOSTNAME || 'otedama-pool',
      level: info.level,
      message: info.message,
      service: 'otedama-pool',
      environment: process.env.NODE_ENV || 'development',
      ...info
    };

    const messageStr = JSON.stringify(logstashMessage);

    if (this.connected && this.socket) {
      this.socket.write(messageStr + '\n');
    } else {
      // Queue message if not connected
      this.queue.push(messageStr);
      
      // Limit queue size to prevent memory issues
      if (this.queue.length > 1000) {
        this.queue.shift(); // Remove oldest message
      }
    }

    if (callback) callback();
    return true;
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    
    if (this.socket) {
      this.socket.destroy();
    }
  }
}

// ===== LOG MANAGER =====
export class LogManager extends EventEmitter {
  private logger!: winston.Logger;
  private config: Required<LogConfig>;
  private stats: LogStats = {
    totalLogs: 0,
    errorCount: 0,
    warnCount: 0,
    infoCount: 0,
    debugCount: 0,
    averageLogSize: 0,
    rotations: 0
  };
  private transports: winston.transport[] = [];
  private requestContexts = new Map<string, any>();

  constructor(config: LogConfig = {}) {
    super();

    this.config = {
      level: config.level || 'info',
      dir: config.dir || './logs',
      filename: config.filename || 'app',
      datePattern: config.datePattern || 'YYYY-MM-DD',
      maxSize: config.maxSize || '20m',
      maxFiles: config.maxFiles || '14d',
      zippedArchive: config.zippedArchive !== false,
      format: config.format || 'json',
      console: config.console !== false,
      handleExceptions: config.handleExceptions !== false,
      handleRejections: config.handleRejections !== false,
      elk: {
        enabled: config.elk?.enabled ?? false,
        logstashHost: config.elk?.logstashHost || 'logstash',
        logstashPort: config.elk?.logstashPort || 5000,
        elasticsearchUrl: config.elk?.elasticsearchUrl || 'http://otedama-elasticsearch-es-http:9200',
        kibanaUrl: config.elk?.kibanaUrl || 'http://otedama-kibana-kb-http:5601',
        index: config.elk?.index || 'otedama-pool-logs',
        type: config.elk?.type || 'pool-log'
      }
    };

    this.ensureLogDirectory();
    this.setupLogger();
  }

  private ensureLogDirectory(): void {
    if (!existsSync(this.config.dir)) {
      mkdirSync(this.config.dir, { recursive: true });
    }
  }

  private setupLogger(): void {
    // Create transports
    this.createFileTransports();
    
    if (this.config.console) {
      this.createConsoleTransport();
    }

    // Add ELK transport if enabled
    if (this.config.elk.enabled) {
      this.createELKTransport();
    }

    // Create logger
    this.logger = winston.createLogger({
      level: this.config.level,
      format: winston.format.combine(
        winston.format((info) => {
            this.updateStats(info.level, info.message);
            return info;
        })(),
        winston.format.timestamp({
          format: 'YYYY-MM-DD HH:mm:ss.SSS'
        }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        customFormats[this.config.format]
      ),
      transports: this.transports,
      handleExceptions: this.config.handleExceptions,
      handleRejections: this.config.handleRejections,
      exitOnError: false
    });
  }

  private createFileTransports(): void {
    // Combined log file (all levels)
    const combinedTransport = new DailyRotateFile({
      dirname: this.config.dir,
      filename: `${this.config.filename}-%DATE%.log`,
      datePattern: this.config.datePattern,
      zippedArchive: this.config.zippedArchive,
      maxSize: this.config.maxSize,
      maxFiles: this.config.maxFiles,
      format: winston.format.combine(
        winston.format.timestamp(),
        customFormats[this.config.format]
      )
    });

    combinedTransport.on('rotate', (oldFilename, newFilename) => {
      this.stats.rotations++;
      this.emit('log:rotated', { oldFilename, newFilename });
    });

    this.transports.push(combinedTransport);

    // Error log file (errors only)
    const errorTransport = new DailyRotateFile({
      dirname: this.config.dir,
      filename: `${this.config.filename}-error-%DATE%.log`,
      datePattern: this.config.datePattern,
      zippedArchive: this.config.zippedArchive,
      maxSize: this.config.maxSize,
      maxFiles: this.config.maxFiles,
      level: 'error',
      format: winston.format.combine(
        winston.format.timestamp(),
        customFormats[this.config.format]
      )
    });

    this.transports.push(errorTransport);

    // Performance log file
    const perfTransport = new DailyRotateFile({
      dirname: join(this.config.dir, 'performance'),
      filename: 'perf-%DATE%.log',
      datePattern: this.config.datePattern,
      zippedArchive: this.config.zippedArchive,
      maxSize: this.config.maxSize,
      maxFiles: '7d', // Keep performance logs for 7 days
      format: winston.format.json()
    });

    this.transports.push(perfTransport);
  }

  private createConsoleTransport(): void {
    const consoleTransport = new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    });

    this.transports.push(consoleTransport);
  }

  private createELKTransport(): void {
    const logstashTransport = new LogstashTransport(this.config.elk);
    
    logstashTransport.on('connect', () => {
      this.emit('elk:connected');
    });
    
    logstashTransport.on('error', (error) => {
      this.emit('elk:error', error);
    });
    
    logstashTransport.on('close', () => {
      this.emit('elk:disconnected');
    });
    
    this.transports.push(logstashTransport);
  }



  private updateStats(level: string, message: any): void {
    this.stats.totalLogs++;
    
    const messageSize = JSON.stringify(message).length;
    this.stats.averageLogSize = 
      (this.stats.averageLogSize * (this.stats.totalLogs - 1) + messageSize) / 
      this.stats.totalLogs;

    switch (level) {
      case 'error':
        this.stats.errorCount++;
        break;
      case 'warn':
        this.stats.warnCount++;
        break;
      case 'info':
        this.stats.infoCount++;
        break;
      case 'debug':
        this.stats.debugCount++;
        break;
    }
  }

  // ===== LOGGING METHODS =====
  
  error(message: string, error?: Error, meta?: LogMetadata): void {
    const logData: any = {
      ...meta,
      message
    };

    if (error) {
      logData.error = {
        name: error.name,
        message: error.message,
        stack: error.stack
      };
    }

    this.logger.error(logData);
  }

  warn(message: string, meta?: LogMetadata): void {
    this.logger.warn({
      ...meta,
      message
    });
  }

  info(message: string, meta?: LogMetadata): void {
    this.logger.info({
      ...meta,
      message
    });
  }

  debug(message: string, meta?: LogMetadata): void {
    this.logger.debug({
      ...meta,
      message
    });
  }

  // ===== PERFORMANCE LOGGING =====
  
  startTimer(label: string): () => void {
    const startTime = performance.now();
    
    return () => {
      const duration = performance.now() - startTime;
      this.performance(label, duration);
    };
  }

  performance(action: string, duration: number, meta?: any): void {
    const perfLogger = this.logger.child({
      type: 'performance'
    });

    perfLogger.info({
      action,
      duration,
      ...meta
    });

    // Emit performance event for monitoring
    this.emit('performance:logged', {
      action,
      duration,
      ...meta
    });
  }

  // ===== REQUEST CONTEXT =====
  
  createRequestContext(requestId: string, context: any = {}): void {
    this.requestContexts.set(requestId, context);
  }

  updateRequestContext(requestId: string, updates: any): void {
    const context = this.requestContexts.get(requestId) || {};
    this.requestContexts.set(requestId, { ...context, ...updates });
  }

  logWithContext(requestId: string, level: string, message: string, meta?: any): void {
    const context = this.requestContexts.get(requestId) || {};
    
    this.logger.log(level, {
      message,
      requestId,
      ...context,
      ...meta
    });
  }

  clearRequestContext(requestId: string): void {
    this.requestContexts.delete(requestId);
  }

  // ===== AUDIT LOGGING =====
  
  audit(action: string, userId: string, details: any): void {
    const auditLogger = this.logger.child({
      type: 'audit'
    });

    auditLogger.info({
      action,
      userId,
      timestamp: new Date().toISOString(),
      details
    });

    this.emit('audit:logged', {
      action,
      userId,
      details
    });
  }

  // ===== LOG QUERYING =====
  
  async query(options: {
    from: Date;
    to: Date;
    level?: string;
    limit?: number;
    fields?: string[];
  }): Promise<any[]> {
    // This is a placeholder - in production, you would query from a log aggregation service
    // or parse log files
    return [];
  }

  // ===== UTILITIES =====
  
  setLevel(level: string): void {
    this.config.level = level;
    this.logger.level = level;
    
    this.info('Log level changed', { newLevel: level });
  }

  getStats(): LogStats {
    return { ...this.stats };
  }

  async flush(): Promise<void> {
    return new Promise((resolve) => {
      // Wait for all transports to finish
      let pending = this.transports.length;
      
      this.transports.forEach(transport => {
        transport.once('finish', () => {
          pending--;
          if (pending === 0) {
            resolve();
          }
        });
        
        transport.end();
      });

      // Timeout after 5 seconds
      setTimeout(resolve, 5000);
    });
  }

  close(): void {
    this.transports.forEach(transport => {
      if ('close' in transport && typeof transport.close === 'function') {
        transport.close();
      }
    });
  }
}

// ===== COMPONENT LOGGER =====
export class ComponentLogger {
  constructor(
    private component: string,
    private logManager: LogManager
  ) {}

  error(message: string, error?: Error, meta?: LogMetadata): void {
    this.logManager.error(message, error, {
      component: this.component,
      ...meta
    });
  }

  warn(message: string, meta?: LogMetadata): void {
    this.logManager.warn(message, {
      component: this.component,
      ...meta
    });
  }

  info(message: string, meta?: LogMetadata): void {
    this.logManager.info(message, {
      component: this.component,
      ...meta
    });
  }

  debug(message: string, meta?: LogMetadata): void {
    this.logManager.debug(message, {
      component: this.component,
      ...meta
    });
  }

  startTimer(label: string): () => void {
    return this.logManager.startTimer(`${this.component}:${label}`);
  }

  performance(action: string, duration: number, meta?: any): void {
    this.logManager.performance(`${this.component}:${action}`, duration, meta);
  }
}

// ===== LOG AGGREGATOR =====
export class LogAggregator extends EventEmitter {
  private loggers = new Map<string, LogManager>();
  private globalConfig: LogConfig;

  constructor(globalConfig: LogConfig = {}) {
    super();
    this.globalConfig = globalConfig;
  }

  createLogger(name: string, config?: Partial<LogConfig>): LogManager {
    const loggerConfig = {
      ...this.globalConfig,
      ...config,
      filename: `${this.globalConfig.filename || 'app'}-${name}`
    };

    const logger = new LogManager(loggerConfig);
    this.loggers.set(name, logger);

    // Forward events
    logger.on('log:rotated', (data) => {
      this.emit('log:rotated', { logger: name, ...data });
    });

    return logger;
  }

  getLogger(name: string): LogManager | undefined {
    return this.loggers.get(name);
  }

  createComponentLogger(name: string, component: string): ComponentLogger {
    const logger = this.loggers.get(name);
    if (!logger) {
      throw new Error(`Logger '${name}' not found`);
    }

    return new ComponentLogger(component, logger);
  }

  async flushAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    
    for (const logger of this.loggers.values()) {
      promises.push(logger.flush());
    }

    await Promise.all(promises);
  }

  closeAll(): void {
    for (const logger of this.loggers.values()) {
      logger.close();
    }
  }

  getStats(): Map<string, LogStats> {
    const stats = new Map<string, LogStats>();
    
    for (const [name, logger] of this.loggers) {
      stats.set(name, logger.getStats());
    }

    return stats;
  }
}

// ===== SINGLETON INSTANCE =====
let defaultLogManager: LogManager | null = null;

export function getDefaultLogger(config?: LogConfig): LogManager {
  if (!defaultLogManager) {
    defaultLogManager = new LogManager(config);
  }
  return defaultLogManager;
}

export function createComponentLoggerSimple(component: string): ComponentLogger {
  const logManager = getDefaultLogger();
  return new ComponentLogger(component, logManager);
}

// ===== STRUCTURED LOGGING HELPERS =====
export class StructuredLogger {
  constructor(private logger: ComponentLogger) {}

  request(method: string, path: string, meta?: any): void {
    this.logger.info('HTTP Request', {
      method,
      path,
      type: 'http_request',
      ...meta
    });
  }

  response(method: string, path: string, statusCode: number, duration: number, meta?: any): void {
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    
    this.logger[level]('HTTP Response', {
      method,
      path,
      statusCode,
      duration,
      type: 'http_response',
      ...meta
    });
  }

  database(operation: string, table: string, duration: number, meta?: any): void {
    this.logger.debug('Database Operation', {
      operation,
      table,
      duration,
      type: 'database',
      ...meta
    });
  }

  share(action: string, minerId: string, meta?: any): void {
    this.logger.info('Share Event', {
      action,
      minerId,
      type: 'share',
      ...meta
    });
  }

  block(action: string, height: number, hash: string, meta?: any): void {
    this.logger.info('Block Event', {
      action,
      height,
      hash,
      type: 'block',
      ...meta
    });
  }

  payment(action: string, minerId: string, amount: number, meta?: any): void {
    this.logger.info('Payment Event', {
      action,
      minerId,
      amount,
      type: 'payment',
      ...meta
    });
  }
}
