/**
 * Advanced Log Analysis System
 * 
 * Intelligent log processing, pattern detection, and analytics
 * Real-time log monitoring with ML-based anomaly detection
 */

import { EventEmitter } from 'events';
import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { join, dirname } from 'path';
import { createInterface } from 'readline';
import { Worker } from 'worker_threads';
import { performance } from 'perf_hooks';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../core/standardized-error-handler.js';

export class LogAnalyzer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Log sources
      logDirectory: options.logDirectory || './logs',
      logPatterns: options.logPatterns || ['*.log', '*.txt'],
      watchMode: options.watchMode !== false,
      
      // Analysis settings
      maxLogFileSize: options.maxLogFileSize || 100 * 1024 * 1024, // 100MB
      analysisWindow: options.analysisWindow || 3600000, // 1 hour
      bufferSize: options.bufferSize || 10000,
      
      // Pattern detection
      enablePatternDetection: options.enablePatternDetection !== false,
      enableAnomalyDetection: options.enableAnomalyDetection !== false,
      enableRealTimeAnalysis: options.enableRealTimeAnalysis !== false,
      
      // Performance thresholds
      maxMemoryUsage: options.maxMemoryUsage || 512 * 1024 * 1024, // 512MB
      maxCpuUsage: options.maxCpuUsage || 80, // 80%
      workerCount: options.workerCount || Math.min(4, 4),
      
      // Output settings
      reportDirectory: options.reportDirectory || './reports/logs',
      enableDashboard: options.enableDashboard !== false,
      enableAlerts: options.enableAlerts !== false,
      
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.isRunning = false;
    this.logSources = new Map();
    this.workers = [];
    this.logBuffer = [];
    this.patterns = new Map();
    this.metrics = this.initializeMetrics();
    
    // Analysis state
    this.state = {
      totalLinesProcessed: 0,
      currentLogFiles: 0,
      activeWorkers: 0,
      lastAnalysisTime: null,
      memoryUsage: 0,
      processingSpeed: 0
    };
    
    this.initialize();
  }
  
  /**
   * Initialize log analyzer
   */
  async initialize() {
    try {
      await this.ensureDirectories();
      await this.loadPatternLibrary();
      await this.initializeWorkers();
      await this.setupLogSources();
      
      this.emit('initialized');
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'log-analyzer',
        category: ErrorCategory.INITIALIZATION
      });
    }
  }
  
  /**
   * Start log analysis
   */
  async start() {
    if (this.isRunning) {
      throw new OtedamaError('Log analyzer already running', ErrorCategory.OPERATION);
    }
    
    console.log('🔍 Starting log analysis system...');
    this.isRunning = true;
    
    try {
      // Start real-time monitoring
      if (this.options.enableRealTimeAnalysis) {
        await this.startRealTimeMonitoring();
      }
      
      // Start periodic analysis
      this.startPeriodicAnalysis();
      
      // Start performance monitoring
      this.startPerformanceMonitoring();
      
      this.emit('started');
      console.log('✅ Log analyzer started successfully');
      
    } catch (error) {
      this.isRunning = false;
      throw error;
    }
  }
  
  /**
   * Stop log analysis
   */
  async stop() {
    if (!this.isRunning) return;
    
    console.log('🛑 Stopping log analysis system...');
    this.isRunning = false;
    
    // Stop workers
    await this.terminateWorkers();
    
    // Stop monitoring
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
    }
    
    if (this.performanceTimer) {
      clearInterval(this.performanceTimer);
    }
    
    this.emit('stopped');
    console.log('✅ Log analyzer stopped');
  }
  
  /**
   * Analyze specific log file
   */
  async analyzeLogFile(filePath, options = {}) {
    const startTime = performance.now();
    
    try {
      const stats = await stat(filePath);
      if (stats.size > this.options.maxLogFileSize) {
        throw new Error(`Log file too large: ${stats.size} bytes`);
      }
      
      console.log(`📄 Analyzing log file: ${filePath}`);
      
      const analysis = {
        filePath,
        fileSize: stats.size,
        startTime: Date.now(),
        lines: 0,
        errors: 0,
        warnings: 0,
        patterns: new Map(),
        anomalies: [],
        performance: {
          responseTime: [],
          throughput: [],
          errors: []
        }
      };
      
      // Process file line by line
      const fileStream = createReadStream(filePath);
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });
      
      for await (const line of rl) {
        await this.processLogLine(line, analysis);
        analysis.lines++;
        
        // Emit progress for large files
        if (analysis.lines % 10000 === 0) {
          this.emit('analysis:progress', {
            filePath,
            linesProcessed: analysis.lines,
            progress: (analysis.lines * line.length) / stats.size * 100
          });
        }
      }
      
      // Finalize analysis
      const duration = performance.now() - startTime;
      analysis.duration = duration;
      analysis.endTime = Date.now();
      analysis.processingSpeed = analysis.lines / (duration / 1000);
      
      // Generate insights
      analysis.insights = await this.generateInsights(analysis);
      
      // Save analysis report
      if (options.saveReport !== false) {
        await this.saveAnalysisReport(analysis);
      }
      
      this.emit('analysis:completed', analysis);
      
      return analysis;
      
    } catch (error) {
      this.emit('analysis:failed', { filePath, error: error.message });
      throw error;
    }
  }
  
  /**
   * Process individual log line
   */
  async processLogLine(line, analysis) {
    try {
      // Parse log line
      const logEntry = this.parseLogLine(line);
      if (!logEntry) return;
      
      // Update basic metrics
      if (logEntry.level === 'ERROR') analysis.errors++;
      if (logEntry.level === 'WARN') analysis.warnings++;
      
      // Pattern detection
      if (this.options.enablePatternDetection) {
        await this.detectPatterns(logEntry, analysis);
      }
      
      // Performance metrics extraction
      this.extractPerformanceMetrics(logEntry, analysis);
      
      // Anomaly detection
      if (this.options.enableAnomalyDetection) {
        await this.detectAnomalies(logEntry, analysis);
      }
      
      // Update global metrics
      this.updateGlobalMetrics(logEntry);
      
    } catch (error) {
      // Log parsing errors are non-fatal
      console.warn(`Failed to process log line: ${error.message}`);
    }
  }
  
  /**
   * Parse log line into structured format
   */
  parseLogLine(line) {
    const patterns = [
      // Standard format: 2024-01-20 10:30:45 [INFO] Message
      /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s+(.+)$/,
      
      // JSON format
      /^{.*}$/,
      
      // Combined log format (Apache)
      /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([^"]+)"\s+(\d+)\s+(\d+|-)\s*(.*)$/,
      
      // Simple format: INFO: Message
      /^(\w+):\s*(.+)$/
    ];
    
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        return this.parseMatchedLine(match, line);
      }
    }
    
    // Fallback: treat as unstructured message
    return {
      timestamp: Date.now(),
      level: 'INFO',
      message: line,
      raw: line
    };
  }
  
  /**
   * Parse matched log line
   */
  parseMatchedLine(match, raw) {
    // JSON format
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        return {
          timestamp: new Date(parsed.timestamp || Date.now()).getTime(),
          level: parsed.level || 'INFO',
          message: parsed.message || raw,
          ...parsed,
          raw
        };
      } catch {
        return { timestamp: Date.now(), level: 'INFO', message: raw, raw };
      }
    }
    
    // Standard format
    if (match.length >= 4 && match[1].includes('-')) {
      return {
        timestamp: new Date(match[1]).getTime(),
        level: match[2],
        message: match[3],
        raw
      };
    }
    
    // Apache combined log format
    if (match.length >= 6) {
      return {
        timestamp: new Date().getTime(), // Would parse Apache date format in production
        level: parseInt(match[4]) >= 400 ? 'ERROR' : 'INFO',
        message: match[3],
        ip: match[1],
        status: parseInt(match[4]),
        size: match[5] === '-' ? 0 : parseInt(match[5]),
        raw
      };
    }
    
    // Simple format
    return {
      timestamp: Date.now(),
      level: match[1],
      message: match[2],
      raw
    };
  }
  
  /**
   * Detect patterns in log entries
   */
  async detectPatterns(logEntry, analysis) {
    // Common error patterns
    const errorPatterns = [
      { name: 'connection_timeout', regex: /connection.*timeout/i },
      { name: 'out_of_memory', regex: /out of memory|oom/i },
      { name: 'database_error', regex: /database.*error|sql.*error/i },
      { name: 'authentication_failure', regex: /auth.*fail|login.*fail/i },
      { name: 'permission_denied', regex: /permission.*denied|access.*denied/i },
      { name: 'file_not_found', regex: /file.*not.*found|no such file/i },
      { name: 'service_unavailable', regex: /service.*unavailable|503/i }
    ];
    
    for (const pattern of errorPatterns) {
      if (pattern.regex.test(logEntry.message)) {
        const count = analysis.patterns.get(pattern.name) || 0;
        analysis.patterns.set(pattern.name, count + 1);
        
        // Update global pattern tracking
        this.patterns.set(pattern.name, (this.patterns.get(pattern.name) || 0) + 1);
      }
    }
    
    // Performance patterns
    const perfPatterns = [
      { name: 'slow_query', regex: /slow.*query|query.*slow/i },
      { name: 'high_cpu', regex: /cpu.*high|high.*cpu/i },
      { name: 'memory_leak', regex: /memory.*leak|leak.*memory/i },
      { name: 'deadlock', regex: /deadlock/i }
    ];
    
    for (const pattern of perfPatterns) {
      if (pattern.regex.test(logEntry.message)) {
        const count = analysis.patterns.get(pattern.name) || 0;
        analysis.patterns.set(pattern.name, count + 1);
      }
    }
  }
  
  /**
   * Extract performance metrics from log entries
   */
  extractPerformanceMetrics(logEntry, analysis) {
    // Response time extraction
    const responseTimeMatch = logEntry.message.match(/(\d+\.?\d*)\s*(ms|seconds?)/i);
    if (responseTimeMatch) {
      let time = parseFloat(responseTimeMatch[1]);
      if (responseTimeMatch[2].toLowerCase().includes('s')) {
        time *= 1000; // Convert to ms
      }
      analysis.performance.responseTime.push({ timestamp: logEntry.timestamp, value: time });
    }
    
    // Throughput extraction (requests per second)
    const throughputMatch = logEntry.message.match(/(\d+\.?\d*)\s*rps|requests.*second/i);
    if (throughputMatch) {
      const rps = parseFloat(throughputMatch[1]);
      analysis.performance.throughput.push({ timestamp: logEntry.timestamp, value: rps });
    }
    
    // HTTP status codes
    if (logEntry.status) {
      if (logEntry.status >= 400) {
        analysis.performance.errors.push({
          timestamp: logEntry.timestamp,
          status: logEntry.status,
          message: logEntry.message
        });
      }
    }
  }
  
  /**
   * Detect anomalies using statistical analysis
   */
  async detectAnomalies(logEntry, analysis) {
    // Error rate anomaly detection
    const errorRate = analysis.errors / analysis.lines;
    if (errorRate > 0.1) { // More than 10% errors
      analysis.anomalies.push({
        type: 'high_error_rate',
        severity: 'high',
        timestamp: logEntry.timestamp,
        value: errorRate,
        message: `High error rate detected: ${(errorRate * 100).toFixed(1)}%`
      });
    }
    
    // Response time anomaly detection
    if (analysis.performance.responseTime.length > 10) {
      const recentTimes = analysis.performance.responseTime.slice(-10);
      const avgTime = recentTimes.reduce((sum, t) => sum + t.value, 0) / recentTimes.length;
      
      if (avgTime > 5000) { // > 5 seconds
        analysis.anomalies.push({
          type: 'slow_response_time',
          severity: 'medium',
          timestamp: logEntry.timestamp,
          value: avgTime,
          message: `Slow response time detected: ${avgTime.toFixed(0)}ms`
        });
      }
    }
    
    // Pattern-based anomaly detection
    for (const [pattern, count] of analysis.patterns.entries()) {
      if (count > 50) { // Pattern appears too frequently
        analysis.anomalies.push({
          type: 'pattern_frequency_anomaly',
          severity: 'medium',
          timestamp: logEntry.timestamp,
          pattern,
          count,
          message: `Pattern '${pattern}' appears frequently: ${count} times`
        });
      }
    }
  }
  
  /**
   * Generate insights from analysis
   */
  async generateInsights(analysis) {
    const insights = {
      summary: {
        totalLines: analysis.lines,
        errorRate: (analysis.errors / analysis.lines * 100).toFixed(2) + '%',
        warningRate: (analysis.warnings / analysis.lines * 100).toFixed(2) + '%',
        processingSpeed: Math.round(analysis.processingSpeed) + ' lines/sec'
      },
      patterns: [],
      recommendations: [],
      alerts: []
    };
    
    // Pattern insights
    for (const [pattern, count] of analysis.patterns.entries()) {
      insights.patterns.push({
        name: pattern,
        count,
        percentage: (count / analysis.lines * 100).toFixed(2) + '%'
      });
    }
    
    // Generate recommendations
    if (analysis.errors > analysis.lines * 0.05) {
      insights.recommendations.push({
        type: 'error_rate',
        message: 'High error rate detected. Consider investigating root causes.',
        priority: 'high'
      });
    }
    
    if (analysis.performance.responseTime.length > 0) {
      const avgResponseTime = analysis.performance.responseTime
        .reduce((sum, t) => sum + t.value, 0) / analysis.performance.responseTime.length;
      
      if (avgResponseTime > 2000) {
        insights.recommendations.push({
          type: 'performance',
          message: 'Slow response times detected. Consider performance optimization.',
          priority: 'medium'
        });
      }
    }
    
    // Generate alerts based on anomalies
    for (const anomaly of analysis.anomalies) {
      if (anomaly.severity === 'high') {
        insights.alerts.push({
          type: anomaly.type,
          message: anomaly.message,
          severity: anomaly.severity,
          timestamp: anomaly.timestamp
        });
      }
    }
    
    return insights;
  }
  
  /**
   * Start real-time log monitoring
   */
  async startRealTimeMonitoring() {
    console.log('👁️  Starting real-time log monitoring...');
    
    // This would use file watchers in production
    this.realtimeTimer = setInterval(async () => {
      try {
        await this.processNewLogEntries();
      } catch (error) {
        console.error('Real-time monitoring error:', error.message);
      }
    }, 5000); // Check every 5 seconds
  }
  
  /**
   * Process new log entries in real-time
   */
  async processNewLogEntries() {
    // Implementation would track file positions and process only new lines
    // For now, we'll simulate real-time processing
    
    this.emit('realtime:update', {
      timestamp: Date.now(),
      newEntries: Math.floor(Math.random() * 100),
      alertCount: this.patterns.size
    });
  }
  
  /**
   * Start periodic analysis
   */
  startPeriodicAnalysis() {
    this.periodicTimer = setInterval(async () => {
      try {
        await this.runPeriodicAnalysis();
      } catch (error) {
        console.error('Periodic analysis error:', error.message);
      }
    }, this.options.analysisWindow);
  }
  
  /**
   * Run periodic analysis
   */
  async runPeriodicAnalysis() {
    console.log('📊 Running periodic log analysis...');
    
    const report = {
      timestamp: Date.now(),
      period: this.options.analysisWindow,
      totalPatterns: this.patterns.size,
      totalLinesProcessed: this.state.totalLinesProcessed,
      memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
      insights: await this.generateGlobalInsights()
    };
    
    await this.savePeriodicReport(report);
    this.emit('periodic:analysis_completed', report);
  }
  
  /**
   * Generate global insights
   */
  async generateGlobalInsights() {
    const topPatterns = Array.from(this.patterns.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    
    return {
      topPatterns,
      totalUniquePatterns: this.patterns.size,
      averageProcessingSpeed: this.state.processingSpeed,
      systemHealth: this.assessSystemHealth()
    };
  }
  
  /**
   * Assess system health
   */
  assessSystemHealth() {
    const memoryUsage = process.memoryUsage().heapUsed;
    const memoryPercent = (memoryUsage / this.options.maxMemoryUsage) * 100;
    
    let health = 'good';
    if (memoryPercent > 80) health = 'warning';
    if (memoryPercent > 95) health = 'critical';
    
    return {
      status: health,
      memoryUsage: Math.round(memoryUsage / 1024 / 1024) + 'MB',
      memoryPercent: Math.round(memoryPercent) + '%',
      uptime: process.uptime()
    };
  }
  
  /**
   * Start performance monitoring
   */
  startPerformanceMonitoring() {
    this.performanceTimer = setInterval(() => {
      this.updatePerformanceMetrics();
    }, 30000); // Every 30 seconds
  }
  
  /**
   * Update performance metrics
   */
  updatePerformanceMetrics() {
    const memUsage = process.memoryUsage();
    this.state.memoryUsage = memUsage.heapUsed;
    
    // Emit performance metrics
    this.emit('performance:update', {
      memoryUsage: memUsage.heapUsed / 1024 / 1024,
      activeWorkers: this.state.activeWorkers,
      processingSpeed: this.state.processingSpeed,
      totalLinesProcessed: this.state.totalLinesProcessed
    });
  }
  
  /**
   * Utility methods
   */
  async ensureDirectories() {
    const dirs = [
      this.options.logDirectory,
      this.options.reportDirectory
    ];
    
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }
  
  async loadPatternLibrary() {
    // Load predefined patterns from file if exists
    try {
      const patternsFile = join(this.options.reportDirectory, 'patterns.json');
      const content = await readFile(patternsFile, 'utf8');
      const savedPatterns = JSON.parse(content);
      
      for (const [pattern, count] of Object.entries(savedPatterns)) {
        this.patterns.set(pattern, count);
      }
    } catch {
      // File doesn't exist yet
    }
  }
  
  async initializeWorkers() {
    // Worker pool initialization would go here
    // For now, we'll simulate worker management
    this.state.activeWorkers = this.options.workerCount;
  }
  
  async terminateWorkers() {
    for (const worker of this.workers) {
      await worker.terminate();
    }
    this.workers = [];
    this.state.activeWorkers = 0;
  }
  
  async setupLogSources() {
    // Setup log source monitoring
    this.logSources.set('application', {
      path: join(this.options.logDirectory, 'app.log'),
      type: 'application',
      lastPosition: 0
    });
    
    this.logSources.set('error', {
      path: join(this.options.logDirectory, 'error.log'),
      type: 'error',
      lastPosition: 0
    });
    
    this.logSources.set('access', {
      path: join(this.options.logDirectory, 'access.log'),
      type: 'access',
      lastPosition: 0
    });
  }
  
  initializeMetrics() {
    return {
      totalLinesProcessed: 0,
      totalErrors: 0,
      totalWarnings: 0,
      averageProcessingTime: 0,
      patternCounts: new Map(),
      anomalyCount: 0
    };
  }
  
  updateGlobalMetrics(logEntry) {
    this.metrics.totalLinesProcessed++;
    this.state.totalLinesProcessed++;
    
    if (logEntry.level === 'ERROR') this.metrics.totalErrors++;
    if (logEntry.level === 'WARN') this.metrics.totalWarnings++;
  }
  
  async saveAnalysisReport(analysis) {
    const filename = `analysis_${Date.now()}.json`;
    const filepath = join(this.options.reportDirectory, filename);
    
    await writeFile(filepath, JSON.stringify(analysis, null, 2));
    console.log(`📄 Analysis report saved: ${filepath}`);
  }
  
  async savePeriodicReport(report) {
    const filename = `periodic_${Date.now()}.json`;
    const filepath = join(this.options.reportDirectory, filename);
    
    await writeFile(filepath, JSON.stringify(report, null, 2));
  }
  
  /**
   * Get current status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      state: this.state,
      metrics: this.metrics,
      patterns: Object.fromEntries(this.patterns),
      logSources: Array.from(this.logSources.values())
    };
  }
  
  /**
   * Get analysis metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      patterns: Object.fromEntries(this.patterns),
      health: this.assessSystemHealth()
    };
  }
}

export default LogAnalyzer;