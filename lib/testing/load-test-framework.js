/**
 * Advanced Load Testing Framework
 * 
 * Comprehensive load testing with real-time monitoring and reporting
 * Following John Carmack's performance-first approach with clean architecture
 */

import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { performance } from 'perf_hooks';
import { createWriteStream } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../core/standardized-error-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class LoadTestFramework extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Test configuration
      maxConcurrentUsers: options.maxConcurrentUsers || 100,
      testDuration: options.testDuration || 60000, // 60 seconds
      rampUpTime: options.rampUpTime || 10000,     // 10 seconds
      rampDownTime: options.rampDownTime || 5000,  // 5 seconds
      
      // Request configuration
      baseUrl: options.baseUrl || 'http://localhost:3333',
      timeout: options.timeout || 5000,
      keepAlive: options.keepAlive !== false,
      
      // Monitoring configuration
      metricsInterval: options.metricsInterval || 1000, // 1 second
      enableRealTimeMonitoring: options.enableRealTimeMonitoring !== false,
      enableDetailedMetrics: options.enableDetailedMetrics !== false,
      
      // Output configuration
      outputDirectory: options.outputDirectory || './reports/load-test',
      enableReports: options.enableReports !== false,
      enableCharts: options.enableCharts !== false,
      
      // Advanced features
      enableAdaptiveLoad: options.enableAdaptiveLoad !== false,
      enablePerformanceProfile: options.enablePerformanceProfile !== false,
      enableResourceMonitoring: options.enableResourceMonitoring !== false,
      
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.workers = [];
    this.testScenarios = new Map();
    this.testSession = null;
    this.isRunning = false;
    
    // Real-time metrics
    this.metrics = {
      totalRequests: 0,
      completedRequests: 0,
      failedRequests: 0,
      activeUsers: 0,
      currentRPS: 0,
      averageResponseTime: 0,
      minResponseTime: Infinity,
      maxResponseTime: 0,
      p50ResponseTime: 0,
      p90ResponseTime: 0,
      p95ResponseTime: 0,
      p99ResponseTime: 0,
      bytesReceived: 0,
      bytesSent: 0,
      errorRate: 0,
      throughput: 0
    };
    
    // Performance tracking
    this.responseTimes = [];
    this.errorCounts = new Map();
    this.timeSeriesData = [];
    this.resourceUsage = [];
    
    this.initialize();
  }
  
  /**
   * Initialize load testing framework
   */
  async initialize() {
    try {
      // Ensure output directory exists
      if (this.options.enableReports) {
        await mkdir(this.options.outputDirectory, { recursive: true });
      }
      
      // Setup performance monitoring
      if (this.options.enableResourceMonitoring) {
        this.setupResourceMonitoring();
      }
      
      // Setup real-time monitoring
      if (this.options.enableRealTimeMonitoring) {
        this.setupRealTimeMonitoring();
      }
      
      this.emit('initialized');
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'load-test-framework',
        category: ErrorCategory.INITIALIZATION
      });
    }
  }
  
  /**
   * Add test scenario
   */
  addScenario(name, scenario) {
    const scenarioConfig = {
      name,
      weight: scenario.weight || 1,
      requests: scenario.requests || [],
      setup: scenario.setup,
      teardown: scenario.teardown,
      assertions: scenario.assertions || [],
      variables: scenario.variables || {},
      rampUp: scenario.rampUp || this.options.rampUpTime,
      duration: scenario.duration || this.options.testDuration,
      users: scenario.users || this.options.maxConcurrentUsers,
      ...scenario
    };
    
    this.testScenarios.set(name, scenarioConfig);
    
    this.emit('scenario:added', { name, scenario: scenarioConfig });
  }
  
  /**
   * Remove test scenario
   */
  removeScenario(name) {
    if (this.testScenarios.has(name)) {
      this.testScenarios.delete(name);
      this.emit('scenario:removed', { name });
    }
  }
  
  /**
   * Run load test
   */
  async runTest(scenarios = null) {
    if (this.isRunning) {
      throw new OtedamaError('Load test is already running', ErrorCategory.OPERATION);
    }
    
    try {
      this.isRunning = true;
      this.testSession = {
        id: `test_${Date.now()}`,
        startTime: Date.now(),
        scenarios: scenarios || Array.from(this.testScenarios.keys()),
        status: 'running'
      };
      
      console.log(`🚀 Starting load test session: ${this.testSession.id}`);
      this.emit('test:started', this.testSession);
      
      // Reset metrics
      this.resetMetrics();
      
      // Run test phases
      await this.runTestPhases();
      
      // Complete test
      this.testSession.endTime = Date.now();
      this.testSession.duration = this.testSession.endTime - this.testSession.startTime;
      this.testSession.status = 'completed';
      
      // Generate reports
      if (this.options.enableReports) {
        await this.generateReports();
      }
      
      this.emit('test:completed', {
        session: this.testSession,
        metrics: this.getMetricsSummary()
      });
      
      console.log(`✅ Load test completed in ${this.testSession.duration}ms`);
      
      return {
        session: this.testSession,
        metrics: this.getMetricsSummary(),
        success: true
      };
      
    } catch (error) {
      this.testSession.status = 'failed';
      this.testSession.error = error.message;
      
      this.errorHandler.handleError(error, {
        service: 'load-test-framework',
        category: ErrorCategory.TEST_EXECUTION,
        sessionId: this.testSession.id
      });
      
      throw error;
      
    } finally {
      this.isRunning = false;
      await this.cleanup();
    }
  }
  
  /**
   * Run test phases (ramp-up, steady-state, ramp-down)
   */
  async runTestPhases() {
    const scenarios = this.testSession.scenarios
      .map(name => this.testScenarios.get(name))
      .filter(Boolean);
    
    if (scenarios.length === 0) {
      throw new OtedamaError('No valid scenarios found', ErrorCategory.CONFIGURATION);
    }
    
    // Phase 1: Ramp-up
    console.log('📈 Phase 1: Ramp-up');
    await this.runRampUpPhase(scenarios);
    
    // Phase 2: Steady state
    console.log('⚡ Phase 2: Steady state');
    await this.runSteadyStatePhase(scenarios);
    
    // Phase 3: Ramp-down
    console.log('📉 Phase 3: Ramp-down');
    await this.runRampDownPhase();
  }
  
  /**
   * Run ramp-up phase
   */
  async runRampUpPhase(scenarios) {
    const totalUsers = Math.max(...scenarios.map(s => s.users));
    const rampUpTime = Math.max(...scenarios.map(s => s.rampUp));
    const userIncrement = Math.ceil(totalUsers / 10); // 10 steps
    const stepDuration = rampUpTime / 10;
    
    for (let step = 1; step <= 10; step++) {
      const targetUsers = Math.min(step * userIncrement, totalUsers);
      
      // Spawn workers for this step
      await this.spawnWorkers(scenarios, targetUsers);
      
      // Wait for step duration
      await this.sleep(stepDuration);
      
      this.emit('phase:rampup_step', {
        step,
        currentUsers: this.metrics.activeUsers,
        targetUsers,
        progress: (step / 10) * 100
      });
    }
  }
  
  /**
   * Run steady state phase
   */
  async runSteadyStatePhase(scenarios) {
    const maxDuration = Math.max(...scenarios.map(s => s.duration));
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxDuration) {
      // Monitor and adjust if adaptive load is enabled
      if (this.options.enableAdaptiveLoad) {
        await this.adjustLoadBasedOnPerformance();
      }
      
      // Wait for monitoring interval
      await this.sleep(this.options.metricsInterval);
      
      // Check if any critical failures occurred
      if (this.metrics.errorRate > 50) {
        console.warn('⚠️  High error rate detected, considering early termination');
        this.emit('warning:high_error_rate', { errorRate: this.metrics.errorRate });
      }
    }
  }
  
  /**
   * Run ramp-down phase
   */
  async runRampDownPhase() {
    const rampDownSteps = 5;
    const stepDuration = this.options.rampDownTime / rampDownSteps;
    
    for (let step = 1; step <= rampDownSteps; step++) {
      const workersToStop = Math.ceil(this.workers.length / (rampDownSteps - step + 1));
      
      // Stop some workers
      for (let i = 0; i < workersToStop && this.workers.length > 0; i++) {
        const worker = this.workers.pop();
        if (worker && !worker.terminated) {
          worker.postMessage({ command: 'stop' });
          worker.terminate();
        }
      }
      
      await this.sleep(stepDuration);
      
      this.emit('phase:rampdown_step', {
        step,
        remainingWorkers: this.workers.length,
        progress: (step / rampDownSteps) * 100
      });
    }
  }
  
  /**
   * Spawn workers for load generation
   */
  async spawnWorkers(scenarios, targetUsers) {
    const currentWorkers = this.workers.length;
    const workersToSpawn = targetUsers - currentWorkers;
    
    if (workersToSpawn <= 0) return;
    
    for (let i = 0; i < workersToSpawn; i++) {
      try {
        const worker = new Worker(join(__dirname, 'load-test-worker.js'));
        
        // Setup worker communication
        worker.on('message', (message) => {
          this.handleWorkerMessage(message);
        });
        
        worker.on('error', (error) => {
          this.handleWorkerError(worker, error);
        });
        
        worker.on('exit', (code) => {
          this.handleWorkerExit(worker, code);
        });
        
        // Configure worker
        const scenario = scenarios[i % scenarios.length];
        worker.postMessage({
          command: 'configure',
          config: {
            baseUrl: this.options.baseUrl,
            scenario,
            timeout: this.options.timeout,
            keepAlive: this.options.keepAlive
          }
        });
        
        // Start worker
        worker.postMessage({ command: 'start' });
        
        this.workers.push(worker);
        this.metrics.activeUsers++;
        
      } catch (error) {
        console.error('Failed to spawn worker:', error.message);
      }
    }
    
    this.emit('workers:spawned', {
      newWorkers: workersToSpawn,
      totalWorkers: this.workers.length
    });
  }
  
  /**
   * Handle worker message
   */
  handleWorkerMessage(message) {
    switch (message.type) {
      case 'request_completed':
        this.updateMetrics(message.data);
        break;
        
      case 'request_failed':
        this.updateErrorMetrics(message.data);
        break;
        
      case 'worker_status':
        this.emit('worker:status', message.data);
        break;
        
      case 'performance_data':
        this.updatePerformanceData(message.data);
        break;
    }
  }
  
  /**
   * Handle worker error
   */
  handleWorkerError(worker, error) {
    console.error('Worker error:', error.message);
    this.metrics.activeUsers = Math.max(0, this.metrics.activeUsers - 1);
    
    // Remove from workers array
    const index = this.workers.indexOf(worker);
    if (index > -1) {
      this.workers.splice(index, 1);
    }
    
    this.emit('worker:error', { error: error.message });
  }
  
  /**
   * Handle worker exit
   */
  handleWorkerExit(worker, code) {
    this.metrics.activeUsers = Math.max(0, this.metrics.activeUsers - 1);
    
    // Remove from workers array
    const index = this.workers.indexOf(worker);
    if (index > -1) {
      this.workers.splice(index, 1);
    }
    
    this.emit('worker:exit', { code });
  }
  
  /**
   * Update metrics from worker data
   */
  updateMetrics(data) {
    this.metrics.totalRequests++;
    this.metrics.completedRequests++;
    
    // Update response time metrics
    const responseTime = data.responseTime;
    this.responseTimes.push(responseTime);
    
    this.metrics.minResponseTime = Math.min(this.metrics.minResponseTime, responseTime);
    this.metrics.maxResponseTime = Math.max(this.metrics.maxResponseTime, responseTime);
    
    // Update average response time
    const totalTime = this.responseTimes.reduce((sum, time) => sum + time, 0);
    this.metrics.averageResponseTime = totalTime / this.responseTimes.length;
    
    // Update percentiles (calculated every 100 requests for performance)
    if (this.responseTimes.length % 100 === 0) {
      this.updateResponseTimePercentiles();
    }
    
    // Update throughput metrics
    if (data.bytesReceived) {
      this.metrics.bytesReceived += data.bytesReceived;
    }
    if (data.bytesSent) {
      this.metrics.bytesSent += data.bytesSent;
    }
    
    this.emit('metrics:updated', { type: 'request_completed', data });
  }
  
  /**
   * Update error metrics
   */
  updateErrorMetrics(data) {
    this.metrics.totalRequests++;
    this.metrics.failedRequests++;
    
    // Track error types
    const errorType = data.error || 'unknown';
    this.errorCounts.set(errorType, (this.errorCounts.get(errorType) || 0) + 1);
    
    // Update error rate
    this.metrics.errorRate = (this.metrics.failedRequests / this.metrics.totalRequests) * 100;
    
    this.emit('metrics:updated', { type: 'request_failed', data });
  }
  
  /**
   * Update response time percentiles
   */
  updateResponseTimePercentiles() {
    const sorted = [...this.responseTimes].sort((a, b) => a - b);
    const length = sorted.length;
    
    this.metrics.p50ResponseTime = sorted[Math.floor(length * 0.5)];
    this.metrics.p90ResponseTime = sorted[Math.floor(length * 0.9)];
    this.metrics.p95ResponseTime = sorted[Math.floor(length * 0.95)];
    this.metrics.p99ResponseTime = sorted[Math.floor(length * 0.99)];
  }
  
  /**
   * Update performance data
   */
  updatePerformanceData(data) {
    if (this.options.enablePerformanceProfile) {
      this.timeSeriesData.push({
        timestamp: Date.now(),
        ...this.metrics,
        ...data
      });
    }
  }
  
  /**
   * Setup real-time monitoring
   */
  setupRealTimeMonitoring() {
    this.monitoringInterval = setInterval(() => {
      if (this.isRunning) {
        this.calculateRealTimeMetrics();
        this.emit('metrics:realtime', this.metrics);
      }
    }, this.options.metricsInterval);
  }
  
  /**
   * Calculate real-time metrics
   */
  calculateRealTimeMetrics() {
    const now = Date.now();
    const oneSecondAgo = now - 1000;
    
    // Calculate current RPS
    const recentRequests = this.timeSeriesData.filter(
      data => data.timestamp >= oneSecondAgo
    );
    this.metrics.currentRPS = recentRequests.length;
    
    // Calculate throughput (bytes per second)
    const recentBytes = recentRequests.reduce(
      (sum, data) => sum + (data.bytesReceived || 0),
      0
    );
    this.metrics.throughput = recentBytes;
  }
  
  /**
   * Setup resource monitoring
   */
  setupResourceMonitoring() {
    this.resourceInterval = setInterval(() => {
      if (this.isRunning) {
        const usage = process.memoryUsage();
        const cpuUsage = process.cpuUsage();
        
        this.resourceUsage.push({
          timestamp: Date.now(),
          memory: {
            rss: usage.rss,
            heapTotal: usage.heapTotal,
            heapUsed: usage.heapUsed,
            external: usage.external
          },
          cpu: {
            user: cpuUsage.user,
            system: cpuUsage.system
          }
        });
        
        this.emit('resource:updated', this.resourceUsage[this.resourceUsage.length - 1]);
      }
    }, this.options.metricsInterval);
  }
  
  /**
   * Adjust load based on performance (adaptive loading)
   */
  async adjustLoadBasedOnPerformance() {
    const avgResponseTime = this.metrics.averageResponseTime;
    const errorRate = this.metrics.errorRate;
    
    // If response time is too high or error rate is high, reduce load
    if (avgResponseTime > 5000 || errorRate > 10) {
      const workersToStop = Math.ceil(this.workers.length * 0.1); // Stop 10%
      
      for (let i = 0; i < workersToStop && this.workers.length > 0; i++) {
        const worker = this.workers.pop();
        if (worker && !worker.terminated) {
          worker.postMessage({ command: 'slow_down' });
        }
      }
      
      this.emit('adaptive:load_reduced', {
        reason: avgResponseTime > 5000 ? 'high_response_time' : 'high_error_rate',
        workersRemoved: workersToStop
      });
    }
    // If performance is good, potentially increase load
    else if (avgResponseTime < 1000 && errorRate < 1 && this.workers.length < this.options.maxConcurrentUsers) {
      // Could add more workers here if needed
    }
  }
  
  /**
   * Generate comprehensive reports
   */
  async generateReports() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportDir = join(this.options.outputDirectory, `test-${timestamp}`);
    
    await mkdir(reportDir, { recursive: true });
    
    // Generate summary report
    await this.generateSummaryReport(reportDir);
    
    // Generate detailed metrics report
    await this.generateDetailedReport(reportDir);
    
    // Generate charts if enabled
    if (this.options.enableCharts) {
      await this.generateCharts(reportDir);
    }
    
    // Generate raw data export
    await this.generateRawDataExport(reportDir);
    
    console.log(`📊 Reports generated in: ${reportDir}`);
  }
  
  /**
   * Generate summary report
   */
  async generateSummaryReport(reportDir) {
    const summary = {
      testSession: this.testSession,
      metrics: this.getMetricsSummary(),
      topErrors: this.getTopErrors(),
      recommendations: this.generateRecommendations()
    };
    
    const summaryPath = join(reportDir, 'summary.json');
    await writeFile(summaryPath, JSON.stringify(summary, null, 2));
    
    // Generate markdown summary
    const markdownSummary = this.generateMarkdownSummary(summary);
    const markdownPath = join(reportDir, 'summary.md');
    await writeFile(markdownPath, markdownSummary);
  }
  
  /**
   * Generate detailed report
   */
  async generateDetailedReport(reportDir) {
    const detailed = {
      timeSeriesData: this.timeSeriesData,
      responseTimes: this.responseTimes,
      errorCounts: Object.fromEntries(this.errorCounts),
      resourceUsage: this.resourceUsage
    };
    
    const detailedPath = join(reportDir, 'detailed.json');
    await writeFile(detailedPath, JSON.stringify(detailed, null, 2));
  }
  
  /**
   * Generate charts (placeholder - would integrate with charting library)
   */
  async generateCharts(reportDir) {
    // This would generate HTML/SVG charts showing:
    // - Response time over time
    // - RPS over time
    // - Error rate over time
    // - Resource usage over time
    
    const chartHtml = this.generateChartHTML();
    const chartPath = join(reportDir, 'charts.html');
    await writeFile(chartPath, chartHtml);
  }
  
  /**
   * Generate raw data export
   */
  async generateRawDataExport(reportDir) {
    const csvData = this.convertToCSV(this.timeSeriesData);
    const csvPath = join(reportDir, 'raw-data.csv');
    await writeFile(csvPath, csvData);
  }
  
  /**
   * Get metrics summary
   */
  getMetricsSummary() {
    return {
      ...this.metrics,
      testDuration: this.testSession?.duration || 0,
      averageRPS: this.metrics.totalRequests / ((this.testSession?.duration || 1) / 1000),
      successRate: 100 - this.metrics.errorRate
    };
  }
  
  /**
   * Get top errors
   */
  getTopErrors() {
    return Array.from(this.errorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([error, count]) => ({ error, count }));
  }
  
  /**
   * Generate performance recommendations
   */
  generateRecommendations() {
    const recommendations = [];
    
    if (this.metrics.errorRate > 5) {
      recommendations.push({
        type: 'error_rate',
        message: `High error rate (${this.metrics.errorRate.toFixed(2)}%). Check server logs and capacity.`
      });
    }
    
    if (this.metrics.averageResponseTime > 2000) {
      recommendations.push({
        type: 'response_time',
        message: `High average response time (${this.metrics.averageResponseTime.toFixed(2)}ms). Consider optimizing queries or scaling.`
      });
    }
    
    if (this.metrics.p95ResponseTime > 5000) {
      recommendations.push({
        type: 'p95_response_time',
        message: `95th percentile response time is high (${this.metrics.p95ResponseTime.toFixed(2)}ms). Some requests are very slow.`
      });
    }
    
    return recommendations;
  }
  
  /**
   * Generate markdown summary
   */
  generateMarkdownSummary(summary) {
    return `# Load Test Report

## Test Overview
- **Test ID**: ${summary.testSession.id}
- **Duration**: ${summary.testSession.duration}ms
- **Start Time**: ${new Date(summary.testSession.startTime).toISOString()}
- **End Time**: ${new Date(summary.testSession.endTime).toISOString()}

## Performance Metrics
- **Total Requests**: ${summary.metrics.totalRequests}
- **Completed Requests**: ${summary.metrics.completedRequests}
- **Failed Requests**: ${summary.metrics.failedRequests}
- **Success Rate**: ${summary.metrics.successRate.toFixed(2)}%
- **Average RPS**: ${summary.metrics.averageRPS.toFixed(2)}
- **Average Response Time**: ${summary.metrics.averageResponseTime.toFixed(2)}ms
- **95th Percentile**: ${summary.metrics.p95ResponseTime.toFixed(2)}ms

## Top Errors
${summary.topErrors.map(error => `- ${error.error}: ${error.count} occurrences`).join('\\n')}

## Recommendations
${summary.recommendations.map(rec => `- **${rec.type}**: ${rec.message}`).join('\\n')}
`;
  }
  
  /**
   * Generate chart HTML
   */
  generateChartHTML() {
    return `<!DOCTYPE html>
<html>
<head>
    <title>Load Test Charts</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
    <h1>Load Test Performance Charts</h1>
    <div style="width: 80%; margin: 20px auto;">
        <canvas id="responseTimeChart"></canvas>
    </div>
    <script>
        // Chart implementation would go here
        console.log('Charts would be rendered here with actual data');
    </script>
</body>
</html>`;
  }
  
  /**
   * Convert data to CSV format
   */
  convertToCSV(data) {
    if (data.length === 0) return '';
    
    const headers = Object.keys(data[0]);
    const csvRows = [headers.join(',')];
    
    for (const row of data) {
      const values = headers.map(header => {
        const value = row[header];
        return typeof value === 'string' ? `"${value}"` : value;
      });
      csvRows.push(values.join(','));
    }
    
    return csvRows.join('\\n');
  }
  
  /**
   * Reset metrics for new test
   */
  resetMetrics() {
    this.metrics = {
      totalRequests: 0,
      completedRequests: 0,
      failedRequests: 0,
      activeUsers: 0,
      currentRPS: 0,
      averageResponseTime: 0,
      minResponseTime: Infinity,
      maxResponseTime: 0,
      p50ResponseTime: 0,
      p90ResponseTime: 0,
      p95ResponseTime: 0,
      p99ResponseTime: 0,
      bytesReceived: 0,
      bytesSent: 0,
      errorRate: 0,
      throughput: 0
    };
    
    this.responseTimes = [];
    this.errorCounts.clear();
    this.timeSeriesData = [];
    this.resourceUsage = [];
  }
  
  /**
   * Stop running test
   */
  async stopTest() {
    if (!this.isRunning) return;
    
    console.log('🛑 Stopping load test...');
    
    // Stop all workers
    for (const worker of this.workers) {
      if (!worker.terminated) {
        worker.postMessage({ command: 'stop' });
        worker.terminate();
      }
    }
    
    this.workers = [];
    this.metrics.activeUsers = 0;
    this.isRunning = false;
    
    if (this.testSession) {
      this.testSession.status = 'stopped';
      this.testSession.endTime = Date.now();
      this.testSession.duration = this.testSession.endTime - this.testSession.startTime;
    }
    
    this.emit('test:stopped');
  }
  
  /**
   * Cleanup resources
   */
  async cleanup() {
    // Clear intervals
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    
    if (this.resourceInterval) {
      clearInterval(this.resourceInterval);
      this.resourceInterval = null;
    }
    
    // Terminate any remaining workers
    for (const worker of this.workers) {
      if (!worker.terminated) {
        worker.terminate();
      }
    }
    
    this.workers = [];
    this.metrics.activeUsers = 0;
  }
  
  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Get current status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      testSession: this.testSession,
      metrics: this.metrics,
      activeWorkers: this.workers.length,
      scenarios: Array.from(this.testScenarios.keys())
    };
  }
}

export default LoadTestFramework;