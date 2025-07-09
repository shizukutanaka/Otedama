// Master performance test runner
// Runs all performance tests and generates comprehensive reports

import { perfTest } from './performance-test-framework';
import { ShareValidationPerformance } from './share-validation.perf';
import { DatabasePerformance } from './database.perf';
import { HashrateCalculationPerformance } from './hashrate-calculation.perf';
import { ConnectionHandlingPerformance } from './connection-handling.perf';
import { RedisCachePerformance } from './redis-cache.perf';
import { StratumProtocolPerformance } from './stratum-protocol.perf';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Performance test suite configuration
 */
interface TestSuiteConfig {
  name: string;
  runner: () => Promise<void>;
  enabled: boolean;
  critical: boolean;
}

/**
 * Master performance test runner
 */
export class MasterPerformanceRunner {
  private testSuites: TestSuiteConfig[] = [
    {
      name: 'Share Validation',
      runner: async () => {
        const test = new ShareValidationPerformance();
        await test.runAll();
      },
      enabled: true,
      critical: true
    },
    {
      name: 'Database Operations',
      runner: async () => {
        const test = new DatabasePerformance();
        await test.runAll();
      },
      enabled: true,
      critical: true
    },
    {
      name: 'Hashrate Calculation',
      runner: async () => {
        const test = new HashrateCalculationPerformance();
        await test.runAll();
      },
      enabled: true,
      critical: false
    },
    {
      name: 'Connection Handling',
      runner: async () => {
        const test = new ConnectionHandlingPerformance();
        await test.runAll();
      },
      enabled: true,
      critical: true
    },
    {
      name: 'Redis Cache',
      runner: async () => {
        const test = new RedisCachePerformance();
        await test.runAll();
      },
      enabled: true,
      critical: false
    },
    {
      name: 'Stratum Protocol',
      runner: async () => {
        const test = new StratumProtocolPerformance();
        await test.runAll();
      },
      enabled: true,
      critical: true
    }
  ];
  
  private results: Map<string, any> = new Map();
  private startTime!: number;
  private endTime!: number;
  
  /**
   * Run all enabled performance tests
   */
  async runAll(options: {
    critical?: boolean;
    outputDir?: string;
    generateReport?: boolean;
  } = {}): Promise<void> {
    const {
      critical = false,
      outputDir = path.join(process.cwd(), 'performance-results'),
      generateReport = true
    } = options;
    
    console.log('========================================');
    console.log('   Mining Pool Performance Test Suite   ');
    console.log('========================================\n');
    
    this.startTime = Date.now();
    
    // Filter test suites
    const suitesToRun = this.testSuites.filter(suite => {
      if (!suite.enabled) return false;
      if (critical && !suite.critical) return false;
      return true;
    });
    
    console.log(`Running ${suitesToRun.length} test suites${critical ? ' (critical only)' : ''}...\n`);
    
    // Run each test suite
    for (const suite of suitesToRun) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Running: ${suite.name}`);
      console.log('='.repeat(60));
      
      try {
        const suiteStart = Date.now();
        await suite.runner();
        const suiteEnd = Date.now();
        
        this.results.set(suite.name, {
          success: true,
          duration: suiteEnd - suiteStart,
          timestamp: new Date().toISOString()
        });
        
        console.log(`\n✅ ${suite.name} completed in ${((suiteEnd - suiteStart) / 1000).toFixed(2)}s`);
      } catch (error) {
        console.error(`\n❌ ${suite.name} failed:`, error);
        
        this.results.set(suite.name, {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        });
      }
    }
    
    this.endTime = Date.now();
    
    // Generate reports
    if (generateReport) {
      await this.generateReports(outputDir);
    }
    
    // Display summary
    this.displaySummary();
  }
  
  /**
   * Run specific test suites
   */
  async runSpecific(suiteNames: string[]): Promise<void> {
    const suitesToRun = this.testSuites.filter(suite => 
      suiteNames.includes(suite.name) && suite.enabled
    );
    
    if (suitesToRun.length === 0) {
      console.error('No matching test suites found');
      return;
    }
    
    console.log(`Running ${suitesToRun.length} specific test suites...\n`);
    
    for (const suite of suitesToRun) {
      console.log(`\nRunning: ${suite.name}`);
      console.log('='.repeat(60));
      
      try {
        await suite.runner();
        console.log(`✅ ${suite.name} completed`);
      } catch (error) {
        console.error(`❌ ${suite.name} failed:`, error);
      }
    }
  }
  
  /**
   * Generate performance reports
   */
  private async generateReports(outputDir: string): Promise<void> {
    console.log('\nGenerating performance reports...');
    
    // Create output directory
    await fs.mkdir(outputDir, { recursive: true });
    
    // Export raw results
    const rawResults = perfTest.exportResults();
    const rawResultsPath = path.join(outputDir, `performance-results-${Date.now()}.json`);
    await fs.writeFile(rawResultsPath, rawResults);
    console.log(`  ✅ Raw results: ${rawResultsPath}`);
    
    // Generate markdown report
    const markdownReport = this.generateMarkdownReport();
    const markdownPath = path.join(outputDir, `performance-report-${Date.now()}.md`);
    await fs.writeFile(markdownPath, markdownReport);
    console.log(`  ✅ Markdown report: ${markdownPath}`);
    
    // Generate HTML report
    const htmlReport = this.generateHTMLReport();
    const htmlPath = path.join(outputDir, `performance-report-${Date.now()}.html`);
    await fs.writeFile(htmlPath, htmlReport);
    console.log(`  ✅ HTML report: ${htmlPath}`);
  }
  
  /**
   * Generate markdown report
   */
  private generateMarkdownReport(): string {
    let report = '# Mining Pool Performance Test Report\n\n';
    
    report += `Generated: ${new Date().toISOString()}\n`;
    report += `Total Duration: ${((this.endTime - this.startTime) / 1000).toFixed(2)}s\n\n`;
    
    // Test suite summary
    report += '## Test Suite Summary\n\n';
    report += '| Suite | Status | Duration | Critical |\n';
    report += '|-------|--------|----------|----------|\n';
    
    for (const suite of this.testSuites) {
      const result = this.results.get(suite.name);
      if (result) {
        const status = result.success ? '✅ Pass' : '❌ Fail';
        const duration = result.duration ? `${(result.duration / 1000).toFixed(2)}s` : 'N/A';
        const critical = suite.critical ? 'Yes' : 'No';
        report += `| ${suite.name} | ${status} | ${duration} | ${critical} |\n`;
      }
    }
    
    // Detailed results from perfTest
    report += '\n' + perfTest.generateReport();
    
    // Performance recommendations
    report += '\n## Performance Recommendations\n\n';
    report += this.generateRecommendations();
    
    return report;
  }
  
  /**
   * Generate HTML report
   */
  private generateHTMLReport(): string {
    const rawResults = JSON.parse(perfTest.exportResults());
    
    let html = `<!DOCTYPE html>
<html>
<head>
    <title>Mining Pool Performance Report</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }
        .header {
            background: #2c3e50;
            color: white;
            padding: 30px;
            border-radius: 8px;
            margin-bottom: 30px;
        }
        .header h1 {
            margin: 0;
            font-size: 2.5em;
        }
        .info {
            margin-top: 10px;
            opacity: 0.9;
        }
        .card {
            background: white;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .card h2 {
            margin-top: 0;
            color: #2c3e50;
            border-bottom: 2px solid #3498db;
            padding-bottom: 10px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 10px;
        }
        th, td {
            text-align: left;
            padding: 12px;
            border-bottom: 1px solid #ddd;
        }
        th {
            background: #34495e;
            color: white;
            font-weight: 600;
        }
        tr:hover {
            background: #f8f9fa;
        }
        .metric {
            display: inline-block;
            padding: 4px 8px;
            background: #3498db;
            color: white;
            border-radius: 4px;
            font-size: 0.9em;
            margin-right: 5px;
        }
        .status-pass {
            color: #27ae60;
            font-weight: bold;
        }
        .status-fail {
            color: #e74c3c;
            font-weight: bold;
        }
        .critical {
            background: #e74c3c;
            color: white;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 0.8em;
        }
        .chart-container {
            margin: 20px 0;
            height: 300px;
            position: relative;
        }
        .recommendations {
            background: #f39c12;
            color: white;
            padding: 15px;
            border-radius: 4px;
            margin-top: 20px;
        }
        .recommendations h3 {
            margin-top: 0;
        }
        .footer {
            text-align: center;
            margin-top: 40px;
            color: #7f8c8d;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>⛏️ Mining Pool Performance Report</h1>
        <div class="info">
            <strong>Generated:</strong> ${new Date().toISOString()}<br>
            <strong>Duration:</strong> ${((this.endTime - this.startTime) / 1000).toFixed(2)}s<br>
            <strong>Platform:</strong> ${rawResults.system.platform} | 
            <strong>Node:</strong> ${rawResults.system.nodeVersion}
        </div>
    </div>
    
    <div class="card">
        <h2>System Information</h2>
        <table>
            <tr>
                <td><strong>CPU</strong></td>
                <td>${rawResults.system.cpu.model} (${rawResults.system.cpu.cores} cores)</td>
            </tr>
            <tr>
                <td><strong>Memory</strong></td>
                <td>${(rawResults.system.memory.total / 1024 / 1024 / 1024).toFixed(2)} GB</td>
            </tr>
        </table>
    </div>
    
    <div class="card">
        <h2>Test Suite Summary</h2>
        <table>
            <thead>
                <tr>
                    <th>Suite</th>
                    <th>Status</th>
                    <th>Duration</th>
                    <th>Type</th>
                </tr>
            </thead>
            <tbody>`;
    
    for (const suite of this.testSuites) {
      const result = this.results.get(suite.name);
      if (result) {
        const statusClass = result.success ? 'status-pass' : 'status-fail';
        const status = result.success ? '✅ Pass' : '❌ Fail';
        const duration = result.duration ? `${(result.duration / 1000).toFixed(2)}s` : 'N/A';
        
        html += `
                <tr>
                    <td>${suite.name}</td>
                    <td class="${statusClass}">${status}</td>
                    <td>${duration}</td>
                    <td>${suite.critical ? '<span class="critical">CRITICAL</span>' : 'Standard'}</td>
                </tr>`;
      }
    }
    
    html += `
            </tbody>
        </table>
    </div>
    
    <div class="card">
        <h2>Performance Metrics</h2>`;
    
    // Add detailed metrics for each test
    for (const [testName, results] of Object.entries(rawResults.results)) {
      if (Array.isArray(results) && results.length > 0) {
        const latest = results[results.length - 1];
        html += `
        <h3>${testName}</h3>
        <div>
            <span class="metric">Ops/sec: ${latest.opsPerSecond.toFixed(2)}</span>
            <span class="metric">Avg: ${this.formatTime(latest.avgTime)}</span>
            <span class="metric">P95: ${this.formatTime(latest.percentiles.p95)}</span>
            <span class="metric">P99: ${this.formatTime(latest.percentiles.p99)}</span>
        </div>`;
      }
    }
    
    html += `
    </div>
    
    <div class="card recommendations">
        <h3>⚡ Performance Recommendations</h3>
        ${this.generateHTMLRecommendations()}
    </div>
    
    <div class="footer">
        <p>Otedama Light - P2P Mining Pool Performance Suite</p>
    </div>
</body>
</html>`;
    
    return html;
  }
  
  /**
   * Generate performance recommendations
   */
  private generateRecommendations(): string {
    const recommendations: string[] = [];
    
    // Analyze results and generate recommendations
    const rawResults = JSON.parse(perfTest.exportResults());
    
    for (const [testName, results] of Object.entries(rawResults.results)) {
      if (Array.isArray(results) && results.length > 0) {
        const latest = results[results.length - 1] as any;
        
        // Check for slow operations
        if (latest.avgTime > 10) {
          recommendations.push(`- **${testName}**: Average time ${latest.avgTime.toFixed(2)}ms is high. Consider optimization.`);
        }
        
        // Check for high variance
        if (latest.standardDeviation > latest.avgTime * 0.5) {
          recommendations.push(`- **${testName}**: High variance detected. Performance is inconsistent.`);
        }
        
        // Check for low throughput
        if (latest.opsPerSecond < 100 && testName.includes('Cache')) {
          recommendations.push(`- **${testName}**: Low throughput (${latest.opsPerSecond.toFixed(2)} ops/sec) for cache operations.`);
        }
      }
    }
    
    if (recommendations.length === 0) {
      recommendations.push('- All performance metrics are within acceptable ranges.');
    }
    
    return recommendations.join('\n');
  }
  
  /**
   * Generate HTML recommendations
   */
  private generateHTMLRecommendations(): string {
    const recommendations = this.generateRecommendations();
    return recommendations
      .split('\n')
      .map(rec => rec.replace(/^- /, ''))
      .map(rec => `<p>${rec.replace(/\*\*/g, '<strong>').replace(/\*\*/g, '</strong>')}</p>`)
      .join('\n');
  }
  
  /**
   * Display summary in console
   */
  private displaySummary(): void {
    console.log('\n' + '='.repeat(60));
    console.log('PERFORMANCE TEST SUMMARY');
    console.log('='.repeat(60));
    
    const totalSuites = this.testSuites.filter(s => s.enabled).length;
    const passedSuites = Array.from(this.results.values()).filter(r => r.success).length;
    const failedSuites = totalSuites - passedSuites;
    
    console.log(`Total Test Suites: ${totalSuites}`);
    console.log(`Passed: ${passedSuites} ✅`);
    console.log(`Failed: ${failedSuites} ❌`);
    console.log(`Total Duration: ${((this.endTime - this.startTime) / 1000).toFixed(2)}s`);
    
    if (failedSuites > 0) {
      console.log('\nFailed Suites:');
      for (const [name, result] of this.results) {
        if (!result.success) {
          console.log(`  - ${name}: ${result.error}`);
        }
      }
    }
    
    console.log('\nRecommendations:');
    console.log(this.generateRecommendations());
  }
  
  /**
   * Format time for display
   */
  private formatTime(ms: number): string {
    if (ms < 0.001) {
      return `${(ms * 1000000).toFixed(2)}ns`;
    } else if (ms < 1) {
      return `${(ms * 1000).toFixed(2)}μs`;
    } else if (ms < 1000) {
      return `${ms.toFixed(2)}ms`;
    } else {
      return `${(ms / 1000).toFixed(2)}s`;
    }
  }
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  const runner = new MasterPerformanceRunner();
  
  async function main() {
    if (args.includes('--help') || args.includes('-h')) {
      console.log(`
Mining Pool Performance Test Suite

Usage: npm run perf [options]

Options:
  --critical    Run only critical performance tests
  --suite NAME  Run specific test suite(s)
  --no-report   Skip report generation
  --output DIR  Specify output directory for reports
  --help        Show this help message

Examples:
  npm run perf                    # Run all tests
  npm run perf --critical         # Run only critical tests
  npm run perf --suite Database   # Run specific suite
`);
      return;
    }
    
    if (args.includes('--suite')) {
      const suiteIndex = args.indexOf('--suite');
      const suiteNames = [];
      
      for (let i = suiteIndex + 1; i < args.length; i++) {
        if (args[i].startsWith('--')) break;
        suiteNames.push(args[i]);
      }
      
      await runner.runSpecific(suiteNames);
    } else {
      const options = {
        critical: args.includes('--critical'),
        generateReport: !args.includes('--no-report'),
        outputDir: args.includes('--output') 
          ? args[args.indexOf('--output') + 1] 
          : undefined
      };
      
      await runner.runAll(options);
    }
  }
  
  main().catch(console.error);
}

export default MasterPerformanceRunner;
