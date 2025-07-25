#!/usr/bin/env node

/**
 * Performance Test Suite - Otedama
 * Load testing and performance benchmarking
 */

import autocannon from 'autocannon';
import { createStructuredLogger } from '../lib/core/index.js';
import { performance } from 'perf_hooks';
import fs from 'fs/promises';
import path from 'path';

const logger = createStructuredLogger('PerformanceTest');

class PerformanceTestSuite {
  constructor(config = {}) {
    this.config = {
      baseUrl: config.baseUrl || process.env.BASE_URL || 'http://localhost:8080',
      duration: config.duration || 30, // seconds
      connections: config.connections || 100,
      pipelining: config.pipelining || 10,
      outputDir: config.outputDir || './performance-results',
      ...config
    };
    
    this.results = [];
  }
  
  async run() {
    logger.info('Starting performance test suite...');
    
    try {
      // Create output directory
      await fs.mkdir(this.config.outputDir, { recursive: true });
      
      // Run test scenarios
      await this.testHealthEndpoint();
      await this.testAPIEndpoints();
      await this.testShareSubmission();
      await this.testConcurrentMiners();
      await this.testSustainedLoad();
      
      // Generate report
      await this.generateReport();
      
      logger.info('Performance test suite completed');
      
    } catch (error) {
      logger.error('Performance test failed:', error);
      throw error;
    }
  }
  
  async testHealthEndpoint() {
    logger.info('Testing health endpoint...');
    
    const result = await this.runLoadTest({
      title: 'Health Endpoint',
      url: `${this.config.baseUrl}/health`,
      duration: 10,
      connections: 10
    });
    
    this.results.push(result);
  }
  
  async testAPIEndpoints() {
    logger.info('Testing API endpoints...');
    
    const endpoints = [
      {
        title: 'Pool Stats',
        url: '/api/pool/stats',
        method: 'GET'
      },
      {
        title: 'Recent Blocks',
        url: '/api/pool/blocks',
        method: 'GET'
      },
      {
        title: 'Miner Stats',
        url: '/api/miners/1234567890',
        method: 'GET'
      }
    ];
    
    for (const endpoint of endpoints) {
      const result = await this.runLoadTest({
        title: `API - ${endpoint.title}`,
        url: `${this.config.baseUrl}${endpoint.url}`,
        method: endpoint.method,
        duration: this.config.duration,
        connections: this.config.connections
      });
      
      this.results.push(result);
    }
  }
  
  async testShareSubmission() {
    logger.info('Testing share submission...');
    
    const shareData = {
      jobId: '0x1234567890abcdef',
      nonce: '0x12345678',
      extraNonce2: '0x1234',
      time: '0x5f123456'
    };
    
    const result = await this.runLoadTest({
      title: 'Share Submission',
      url: `${this.config.baseUrl}/api/mining/submit`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-api-key'
      },
      body: JSON.stringify(shareData),
      duration: this.config.duration,
      connections: this.config.connections
    });
    
    this.results.push(result);
  }
  
  async testConcurrentMiners() {
    logger.info('Testing concurrent miner connections...');
    
    // Simulate multiple miners connecting
    const minerRequests = [];
    
    for (let i = 0; i < 10; i++) {
      minerRequests.push({
        title: `Miner ${i}`,
        setupRequest: {
          path: '/api/mining/job',
          method: 'GET',
          headers: {
            'X-API-Key': `miner-${i}-key`
          }
        }
      });
    }
    
    const result = await this.runLoadTest({
      title: 'Concurrent Miners',
      url: `${this.config.baseUrl}/api/mining/job`,
      duration: this.config.duration,
      connections: 50,
      requests: minerRequests
    });
    
    this.results.push(result);
  }
  
  async testSustainedLoad() {
    logger.info('Testing sustained load...');
    
    const result = await this.runLoadTest({
      title: 'Sustained Load',
      url: `${this.config.baseUrl}/api/pool/stats`,
      duration: 300, // 5 minutes
      connections: 200,
      pipelining: 10,
      bailout: 1000 // Stop if latency exceeds 1 second
    });
    
    this.results.push(result);
  }
  
  async runLoadTest(options) {
    const startTime = performance.now();
    
    return new Promise((resolve, reject) => {
      const instance = autocannon({
        url: options.url,
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body,
        duration: options.duration || this.config.duration,
        connections: options.connections || this.config.connections,
        pipelining: options.pipelining || this.config.pipelining,
        bailout: options.bailout,
        setupClient: options.setupClient
      }, (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        
        const endTime = performance.now();
        const testDuration = (endTime - startTime) / 1000;
        
        const summary = {
          title: options.title,
          duration: testDuration,
          url: options.url,
          requests: {
            total: result.requests.total,
            persec: result.requests.mean
          },
          throughput: {
            total: result.throughput.total,
            persec: result.throughput.mean
          },
          latency: {
            mean: result.latency.mean,
            p50: result.latency.p50,
            p90: result.latency.p90,
            p95: result.latency.p95,
            p99: result.latency.p99,
            max: result.latency.max
          },
          errors: result.errors,
          timeouts: result.timeouts,
          non2xx: result.non2xx || 0
        };
        
        logger.info(`Test completed: ${options.title}`, {
          requests: summary.requests.total,
          rps: summary.requests.persec,
          p95Latency: summary.latency.p95
        });
        
        resolve(summary);
      });
      
      // Track progress
      instance.on('tick', () => {
        const progress = instance.opts.progress();
        if (progress % 10 === 0) {
          logger.debug(`Progress: ${progress}%`);
        }
      });
      
      // Handle errors
      instance.on('error', (err) => {
        logger.error('Load test error:', err);
      });
    });
  }
  
  async generateReport() {
    logger.info('Generating performance report...');
    
    const report = {
      timestamp: new Date().toISOString(),
      config: this.config,
      results: this.results,
      summary: this.generateSummary()
    };
    
    // Save JSON report
    const jsonPath = path.join(this.config.outputDir, `performance-${Date.now()}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
    
    // Generate HTML report
    const htmlPath = path.join(this.config.outputDir, `performance-${Date.now()}.html`);
    await fs.writeFile(htmlPath, this.generateHTMLReport(report));
    
    // Generate markdown summary
    const mdPath = path.join(this.config.outputDir, `performance-${Date.now()}.md`);
    await fs.writeFile(mdPath, this.generateMarkdownReport(report));
    
    logger.info('Reports generated:', {
      json: jsonPath,
      html: htmlPath,
      markdown: mdPath
    });
  }
  
  generateSummary() {
    const summary = {
      totalTests: this.results.length,
      passedTests: 0,
      failedTests: 0,
      avgLatencyP95: 0,
      totalRequests: 0,
      totalErrors: 0,
      recommendations: []
    };
    
    for (const result of this.results) {
      summary.totalRequests += result.requests.total;
      summary.totalErrors += result.errors;
      summary.avgLatencyP95 += result.latency.p95;
      
      // Define pass criteria
      const passed = result.latency.p95 < 1000 && // P95 < 1 second
                    result.errors === 0 &&
                    result.non2xx === 0;
      
      if (passed) {
        summary.passedTests++;
      } else {
        summary.failedTests++;
      }
    }
    
    summary.avgLatencyP95 /= this.results.length;
    
    // Generate recommendations
    if (summary.avgLatencyP95 > 500) {
      summary.recommendations.push('Consider optimizing API response times');
    }
    
    if (summary.totalErrors > 0) {
      summary.recommendations.push('Investigate and fix errors in the application');
    }
    
    const errorRate = summary.totalErrors / summary.totalRequests;
    if (errorRate > 0.01) {
      summary.recommendations.push('Error rate is above 1%, needs attention');
    }
    
    return summary;
  }
  
  generateHTMLReport(report) {
    return `
<!DOCTYPE html>
<html>
<head>
  <title>Otedama Performance Test Report</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 20px;
      background-color: #f5f5f5;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background-color: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1, h2, h3 {
      color: #333;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #ddd;
    }
    th {
      background-color: #4CAF50;
      color: white;
    }
    tr:hover {
      background-color: #f5f5f5;
    }
    .pass {
      color: green;
      font-weight: bold;
    }
    .fail {
      color: red;
      font-weight: bold;
    }
    .summary {
      background-color: #e3f2fd;
      padding: 15px;
      border-radius: 4px;
      margin: 20px 0;
    }
    .recommendation {
      background-color: #fff3cd;
      padding: 10px;
      border-left: 4px solid #ffc107;
      margin: 10px 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Otedama Performance Test Report</h1>
    <p>Generated: ${report.timestamp}</p>
    
    <div class="summary">
      <h2>Summary</h2>
      <p>Total Tests: ${report.summary.totalTests}</p>
      <p>Passed: <span class="pass">${report.summary.passedTests}</span></p>
      <p>Failed: <span class="fail">${report.summary.failedTests}</span></p>
      <p>Average P95 Latency: ${report.summary.avgLatencyP95.toFixed(2)}ms</p>
      <p>Total Requests: ${report.summary.totalRequests.toLocaleString()}</p>
      <p>Total Errors: ${report.summary.totalErrors}</p>
    </div>
    
    ${report.summary.recommendations.length > 0 ? `
      <h2>Recommendations</h2>
      ${report.summary.recommendations.map(rec => `
        <div class="recommendation">${rec}</div>
      `).join('')}
    ` : ''}
    
    <h2>Test Results</h2>
    <table>
      <thead>
        <tr>
          <th>Test</th>
          <th>Duration</th>
          <th>Requests</th>
          <th>RPS</th>
          <th>P50 Latency</th>
          <th>P95 Latency</th>
          <th>P99 Latency</th>
          <th>Errors</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${report.results.map(result => {
          const passed = result.latency.p95 < 1000 && result.errors === 0;
          return `
            <tr>
              <td>${result.title}</td>
              <td>${result.duration.toFixed(1)}s</td>
              <td>${result.requests.total.toLocaleString()}</td>
              <td>${result.requests.persec.toFixed(1)}</td>
              <td>${result.latency.p50.toFixed(1)}ms</td>
              <td>${result.latency.p95.toFixed(1)}ms</td>
              <td>${result.latency.p99.toFixed(1)}ms</td>
              <td>${result.errors}</td>
              <td class="${passed ? 'pass' : 'fail'}">${passed ? 'PASS' : 'FAIL'}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  </div>
</body>
</html>
    `;
  }
  
  generateMarkdownReport(report) {
    return `# Otedama Performance Test Report

Generated: ${report.timestamp}

## Summary

- **Total Tests**: ${report.summary.totalTests}
- **Passed**: ${report.summary.passedTests}
- **Failed**: ${report.summary.failedTests}
- **Average P95 Latency**: ${report.summary.avgLatencyP95.toFixed(2)}ms
- **Total Requests**: ${report.summary.totalRequests.toLocaleString()}
- **Total Errors**: ${report.summary.totalErrors}

${report.summary.recommendations.length > 0 ? `
## Recommendations

${report.summary.recommendations.map(rec => `- ${rec}`).join('\n')}
` : ''}

## Test Results

| Test | Duration | Requests | RPS | P50 | P95 | P99 | Errors | Status |
|------|----------|----------|-----|-----|-----|-----|--------|--------|
${report.results.map(result => {
  const passed = result.latency.p95 < 1000 && result.errors === 0;
  return `| ${result.title} | ${result.duration.toFixed(1)}s | ${result.requests.total.toLocaleString()} | ${result.requests.persec.toFixed(1)} | ${result.latency.p50.toFixed(1)}ms | ${result.latency.p95.toFixed(1)}ms | ${result.latency.p99.toFixed(1)}ms | ${result.errors} | ${passed ? '✅ PASS' : '❌ FAIL'} |`;
}).join('\n')}

## Configuration

- **Base URL**: ${report.config.baseUrl}
- **Duration**: ${report.config.duration}s
- **Connections**: ${report.config.connections}
- **Pipelining**: ${report.config.pipelining}
    `;
  }
}

// Run tests
if (import.meta.url === `file://${process.argv[1]}`) {
  const suite = new PerformanceTestSuite();
  
  suite.run()
    .then(() => {
      logger.info('Performance tests completed successfully');
      process.exit(0);
    })
    .catch(error => {
      logger.error('Performance tests failed:', error);
      process.exit(1);
    });
}

export default PerformanceTestSuite;