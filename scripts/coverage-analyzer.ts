/**
 * Code Coverage Configuration and Reporter
 * Following Carmack/Martin/Pike principles:
 * - Simple and effective coverage tracking
 * - Clear reporting and actionable insights
 * - Fast execution
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

interface CoverageReport {
  total: CoverageMetrics;
  files: FileCoverage[];
  timestamp: string;
  testDuration: number;
}

interface CoverageMetrics {
  lines: CoverageStats;
  statements: CoverageStats;
  functions: CoverageStats;
  branches: CoverageStats;
}

interface CoverageStats {
  total: number;
  covered: number;
  skipped: number;
  percentage: number;
}

interface FileCoverage {
  path: string;
  metrics: CoverageMetrics;
  uncoveredLines: number[];
}

class CoverageReporter {
  private coverageDir: string;
  private threshold = 80; // Target coverage percentage
  private criticalFiles: string[] = [
    'src/core/',
    'src/mining/',
    'src/payment/',
    'src/security/',
    'src/blockchain/'
  ];

  constructor(coverageDir: string = 'coverage') {
    this.coverageDir = coverageDir;
  }

  /**
   * Run coverage analysis
   */
  async analyze(): Promise<CoverageReport> {
    console.log('📊 Running Code Coverage Analysis...\n');
    
    const startTime = Date.now();
    
    // Run tests with coverage
    try {
      execSync('npm run test:coverage', { stdio: 'inherit' });
    } catch (error) {
      console.error('Failed to run tests with coverage');
      throw error;
    }
    
    const duration = Date.now() - startTime;
    
    // Parse coverage data
    const report = this.parseCoverageData();
    report.testDuration = duration;
    
    return report;
  }

  /**
   * Parse coverage data from lcov
   */
  private parseCoverageData(): CoverageReport {
    const lcovPath = path.join(this.coverageDir, 'lcov.info');
    
    if (!fs.existsSync(lcovPath)) {
      throw new Error('Coverage data not found. Run tests with coverage first.');
    }
    
    const lcovContent = fs.readFileSync(lcovPath, 'utf8');
    const files = this.parseLcov(lcovContent);
    
    // Calculate totals
    const total = this.calculateTotals(files);
    
    return {
      total,
      files,
      timestamp: new Date().toISOString(),
      testDuration: 0
    };
  }

  /**
   * Parse LCOV format
   */
  private parseLcov(content: string): FileCoverage[] {
    const files: FileCoverage[] = [];
    const lines = content.split('\n');
    
    let currentFile: FileCoverage | null = null;
    let linesCovered = 0;
    let linesTotal = 0;
    let functionsCovered = 0;
    let functionsTotal = 0;
    let branchesCovered = 0;
    let branchesTotal = 0;
    let uncoveredLines: number[] = [];
    
    for (const line of lines) {
      if (line.startsWith('SF:')) {
        // Start of new file
        if (currentFile) {
          files.push(currentFile);
        }
        
        const filePath = line.substring(3);
        currentFile = {
          path: filePath,
          metrics: this.createEmptyMetrics(),
          uncoveredLines: []
        };
        
        // Reset counters
        linesCovered = 0;
        linesTotal = 0;
        functionsCovered = 0;
        functionsTotal = 0;
        branchesCovered = 0;
        branchesTotal = 0;
        uncoveredLines = [];
      } else if (line.startsWith('DA:')) {
        // Line coverage data
        const [lineNum, hitCount] = line.substring(3).split(',').map(Number);
        linesTotal++;
        if (hitCount > 0) {
          linesCovered++;
        } else {
          uncoveredLines.push(lineNum);
        }
      } else if (line.startsWith('FN:')) {
        // Function found
        functionsTotal++;
      } else if (line.startsWith('FNDA:')) {
        // Function coverage data
        const hitCount = parseInt(line.substring(5).split(',')[0]);
        if (hitCount > 0) {
          functionsCovered++;
        }
      } else if (line.startsWith('BRF:')) {
        // Branches found
        branchesTotal = parseInt(line.substring(4));
      } else if (line.startsWith('BRH:')) {
        // Branches hit
        branchesCovered = parseInt(line.substring(4));
      } else if (line === 'end_of_record' && currentFile) {
        // End of file record
        currentFile.metrics = {
          lines: {
            total: linesTotal,
            covered: linesCovered,
            skipped: 0,
            percentage: linesTotal > 0 ? (linesCovered / linesTotal) * 100 : 100
          },
          statements: {
            total: linesTotal,
            covered: linesCovered,
            skipped: 0,
            percentage: linesTotal > 0 ? (linesCovered / linesTotal) * 100 : 100
          },
          functions: {
            total: functionsTotal,
            covered: functionsCovered,
            skipped: 0,
            percentage: functionsTotal > 0 ? (functionsCovered / functionsTotal) * 100 : 100
          },
          branches: {
            total: branchesTotal,
            covered: branchesCovered,
            skipped: 0,
            percentage: branchesTotal > 0 ? (branchesCovered / branchesTotal) * 100 : 100
          }
        };
        currentFile.uncoveredLines = uncoveredLines;
      }
    }
    
    // Add last file if exists
    if (currentFile) {
      files.push(currentFile);
    }
    
    return files;
  }

  /**
   * Calculate total coverage metrics
   */
  private calculateTotals(files: FileCoverage[]): CoverageMetrics {
    const totals = {
      lines: { total: 0, covered: 0, skipped: 0, percentage: 0 },
      statements: { total: 0, covered: 0, skipped: 0, percentage: 0 },
      functions: { total: 0, covered: 0, skipped: 0, percentage: 0 },
      branches: { total: 0, covered: 0, skipped: 0, percentage: 0 }
    };
    
    for (const file of files) {
      totals.lines.total += file.metrics.lines.total;
      totals.lines.covered += file.metrics.lines.covered;
      totals.statements.total += file.metrics.statements.total;
      totals.statements.covered += file.metrics.statements.covered;
      totals.functions.total += file.metrics.functions.total;
      totals.functions.covered += file.metrics.functions.covered;
      totals.branches.total += file.metrics.branches.total;
      totals.branches.covered += file.metrics.branches.covered;
    }
    
    // Calculate percentages
    totals.lines.percentage = totals.lines.total > 0 
      ? (totals.lines.covered / totals.lines.total) * 100 : 100;
    totals.statements.percentage = totals.statements.total > 0 
      ? (totals.statements.covered / totals.statements.total) * 100 : 100;
    totals.functions.percentage = totals.functions.total > 0 
      ? (totals.functions.covered / totals.functions.total) * 100 : 100;
    totals.branches.percentage = totals.branches.total > 0 
      ? (totals.branches.covered / totals.branches.total) * 100 : 100;
    
    return totals;
  }

  /**
   * Create empty metrics object
   */
  private createEmptyMetrics(): CoverageMetrics {
    return {
      lines: { total: 0, covered: 0, skipped: 0, percentage: 0 },
      statements: { total: 0, covered: 0, skipped: 0, percentage: 0 },
      functions: { total: 0, covered: 0, skipped: 0, percentage: 0 },
      branches: { total: 0, covered: 0, skipped: 0, percentage: 0 }
    };
  }

  /**
   * Generate HTML report
   */
  generateHTMLReport(report: CoverageReport): void {
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Code Coverage Report</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .summary { background: #f0f0f0; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
        .metric { display: inline-block; margin: 10px 20px 10px 0; }
        .percentage { font-size: 24px; font-weight: bold; }
        .good { color: #28a745; }
        .warning { color: #ffc107; }
        .danger { color: #dc3545; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background-color: #f2f2f2; }
        .file-path { font-family: monospace; font-size: 12px; }
        .uncovered { background-color: #ffcccc; }
        .critical { background-color: #ffe6e6; }
    </style>
</head>
<body>
    <h1>Code Coverage Report</h1>
    <p>Generated: ${new Date(report.timestamp).toLocaleString()}</p>
    <p>Test Duration: ${(report.testDuration / 1000).toFixed(2)}s</p>
    
    <div class="summary">
        <h2>Overall Coverage</h2>
        ${this.renderMetric('Lines', report.total.lines)}
        ${this.renderMetric('Statements', report.total.statements)}
        ${this.renderMetric('Functions', report.total.functions)}
        ${this.renderMetric('Branches', report.total.branches)}
    </div>
    
    <h2>File Coverage</h2>
    <table>
        <thead>
            <tr>
                <th>File</th>
                <th>Lines</th>
                <th>Statements</th>
                <th>Functions</th>
                <th>Branches</th>
                <th>Uncovered Lines</th>
            </tr>
        </thead>
        <tbody>
            ${report.files.map(file => this.renderFileRow(file)).join('')}
        </tbody>
    </table>
    
    <h2>Critical Files Below Threshold</h2>
    ${this.renderCriticalFiles(report)}
</body>
</html>
    `;
    
    const reportPath = path.join(this.coverageDir, 'coverage-report.html');
    fs.writeFileSync(reportPath, html);
    console.log(`\n📄 HTML report generated: ${reportPath}`);
  }

  /**
   * Render a metric
   */
  private renderMetric(name: string, stats: CoverageStats): string {
    const colorClass = stats.percentage >= this.threshold ? 'good' : 
                      stats.percentage >= 60 ? 'warning' : 'danger';
    
    return `
        <div class="metric">
            <strong>${name}:</strong>
            <span class="percentage ${colorClass}">${stats.percentage.toFixed(2)}%</span>
            <span>(${stats.covered}/${stats.total})</span>
        </div>
    `;
  }

  /**
   * Render file row
   */
  private renderFileRow(file: FileCoverage): string {
    const isCritical = this.criticalFiles.some(cf => file.path.includes(cf));
    const rowClass = isCritical && file.metrics.lines.percentage < this.threshold ? 'critical' : '';
    
    return `
        <tr class="${rowClass}">
            <td class="file-path">${file.path}</td>
            <td>${this.renderPercentage(file.metrics.lines)}</td>
            <td>${this.renderPercentage(file.metrics.statements)}</td>
            <td>${this.renderPercentage(file.metrics.functions)}</td>
            <td>${this.renderPercentage(file.metrics.branches)}</td>
            <td>${file.uncoveredLines.slice(0, 10).join(', ')}${file.uncoveredLines.length > 10 ? '...' : ''}</td>
        </tr>
    `;
  }

  /**
   * Render percentage
   */
  private renderPercentage(stats: CoverageStats): string {
    const colorClass = stats.percentage >= this.threshold ? 'good' : 
                      stats.percentage >= 60 ? 'warning' : 'danger';
    
    return `<span class="${colorClass}">${stats.percentage.toFixed(1)}%</span>`;
  }

  /**
   * Render critical files section
   */
  private renderCriticalFiles(report: CoverageReport): string {
    const criticalBelowThreshold = report.files.filter(file => {
      const isCritical = this.criticalFiles.some(cf => file.path.includes(cf));
      return isCritical && file.metrics.lines.percentage < this.threshold;
    });
    
    if (criticalBelowThreshold.length === 0) {
      return '<p>✅ All critical files meet the coverage threshold!</p>';
    }
    
    return `
        <ul>
            ${criticalBelowThreshold.map(file => 
                `<li>${file.path}: ${file.metrics.lines.percentage.toFixed(1)}% (needs ${this.threshold}%)</li>`
            ).join('')}
        </ul>
    `;
  }

  /**
   * Check coverage thresholds
   */
  checkThresholds(report: CoverageReport): boolean {
    console.log('\n🎯 Checking Coverage Thresholds...\n');
    
    let passed = true;
    
    // Check overall coverage
    const metrics = ['lines', 'statements', 'functions', 'branches'] as const;
    for (const metric of metrics) {
      const coverage = report.total[metric].percentage;
      const status = coverage >= this.threshold ? '✅' : '❌';
      
      console.log(`${status} ${metric}: ${coverage.toFixed(2)}% (threshold: ${this.threshold}%)`);
      
      if (coverage < this.threshold) {
        passed = false;
      }
    }
    
    // Check critical files
    console.log('\n🔍 Critical Files Check:\n');
    
    for (const file of report.files) {
      const isCritical = this.criticalFiles.some(cf => file.path.includes(cf));
      if (isCritical) {
        const coverage = file.metrics.lines.percentage;
        const status = coverage >= this.threshold ? '✅' : '❌';
        
        console.log(`${status} ${file.path}: ${coverage.toFixed(2)}%`);
        
        if (coverage < this.threshold) {
          passed = false;
        }
      }
    }
    
    return passed;
  }

  /**
   * Generate coverage badge
   */
  generateBadge(report: CoverageReport): void {
    const coverage = report.total.lines.percentage;
    const color = coverage >= this.threshold ? 'brightgreen' : 
                 coverage >= 60 ? 'yellow' : 'red';
    
    const badge = {
      schemaVersion: 1,
      label: 'coverage',
      message: `${coverage.toFixed(1)}%`,
      color
    };
    
    const badgePath = path.join(this.coverageDir, 'coverage-badge.json');
    fs.writeFileSync(badgePath, JSON.stringify(badge, null, 2));
    
    console.log(`\n🎖️  Badge generated: ${badgePath}`);
  }

  /**
   * Compare with previous coverage
   */
  compareCoverage(current: CoverageReport, previous: CoverageReport): void {
    console.log('\n📈 Coverage Comparison:\n');
    
    const metrics = ['lines', 'statements', 'functions', 'branches'] as const;
    
    for (const metric of metrics) {
      const currentCov = current.total[metric].percentage;
      const previousCov = previous.total[metric].percentage;
      const diff = currentCov - previousCov;
      
      const trend = diff > 0 ? '📈' : diff < 0 ? '📉' : '➡️';
      const sign = diff > 0 ? '+' : '';
      
      console.log(`${trend} ${metric}: ${currentCov.toFixed(2)}% (${sign}${diff.toFixed(2)}%)`);
    }
    
    // Find files with significant changes
    console.log('\n📝 Significant File Changes:\n');
    
    const fileMap = new Map(previous.files.map(f => [f.path, f]));
    
    for (const file of current.files) {
      const prevFile = fileMap.get(file.path);
      if (prevFile) {
        const diff = file.metrics.lines.percentage - prevFile.metrics.lines.percentage;
        if (Math.abs(diff) > 5) {
          const trend = diff > 0 ? '📈' : '📉';
          console.log(`${trend} ${file.path}: ${diff > 0 ? '+' : ''}${diff.toFixed(1)}%`);
        }
      }
    }
  }
}

// Jest configuration for coverage
export const jestConfig = {
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/test/**',
    '!src/types/**'
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    },
    './src/core/': {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90
    },
    './src/security/': {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90
    }
  }
};

// Main execution
async function main() {
  const reporter = new CoverageReporter();
  
  try {
    // Run analysis
    const report = await reporter.analyze();
    
    // Generate reports
    reporter.generateHTMLReport(report);
    reporter.generateBadge(report);
    
    // Check thresholds
    const passed = reporter.checkThresholds(report);
    
    // Load previous report if exists
    const previousReportPath = 'coverage/coverage-report.json';
    if (fs.existsSync(previousReportPath)) {
      const previousReport = JSON.parse(fs.readFileSync(previousReportPath, 'utf8'));
      reporter.compareCoverage(report, previousReport);
    }
    
    // Save current report
    fs.writeFileSync(
      'coverage/coverage-report.json',
      JSON.stringify(report, null, 2)
    );
    
    if (!passed) {
      console.log('\n❌ Coverage thresholds not met!');
      process.exit(1);
    } else {
      console.log('\n✅ All coverage thresholds met!');
    }
  } catch (error) {
    console.error('Coverage analysis failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { CoverageReporter, CoverageReport };
