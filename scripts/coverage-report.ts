#!/usr/bin/env node
// Coverage report generator and analyzer
// Robert C. Martin: "The only way to go fast is to go well"

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface CoverageSummary {
  total: {
    lines: { pct: number };
    statements: { pct: number };
    functions: { pct: number };
    branches: { pct: number };
  };
  [key: string]: any;
}

interface CoverageReport {
  summary: CoverageSummary;
  uncoveredFiles: string[];
  lowCoverageFiles: Array<{
    file: string;
    lines: number;
    statements: number;
    functions: number;
    branches: number;
  }>;
}

class CoverageReporter {
  private readonly coverageDir = path.join(process.cwd(), 'coverage');
  private readonly summaryFile = path.join(this.coverageDir, 'coverage-summary.json');
  private readonly threshold = 80; // Default threshold

  /**
   * Generate coverage report
   */
  async generate(): Promise<void> {
    console.log('🧪 Generating code coverage report...\n');

    try {
      // Run tests with coverage
      const { stdout, stderr } = await execAsync('npm run test:coverage', {
        maxBuffer: 1024 * 1024 * 10, // 10MB buffer
      });

      if (stderr && !stderr.includes('Warning')) {
        console.error('Test errors:', stderr);
      }

      // Read and analyze coverage
      const report = await this.analyzeCoverage();
      
      // Display report
      this.displayReport(report);
      
      // Open HTML report if requested
      if (process.argv.includes('--open')) {
        await this.openHtmlReport();
      }

    } catch (error) {
      console.error('❌ Failed to generate coverage report:', error);
      process.exit(1);
    }
  }

  /**
   * Analyze coverage data
   */
  private async analyzeCoverage(): Promise<CoverageReport> {
    try {
      const summaryData = await fs.readFile(this.summaryFile, 'utf-8');
      const summary: CoverageSummary = JSON.parse(summaryData);
      
      const uncoveredFiles: string[] = [];
      const lowCoverageFiles: Array<{
        file: string;
        lines: number;
        statements: number;
        functions: number;
        branches: number;
      }> = [];

      // Analyze each file
      for (const [file, data] of Object.entries(summary)) {
        if (file === 'total') continue;
        
        const coverage = {
          file: file.replace(process.cwd(), '.'),
          lines: data.lines.pct,
          statements: data.statements.pct,
          functions: data.functions.pct,
          branches: data.branches.pct,
        };

        // Check if file is uncovered
        if (coverage.lines === 0) {
          uncoveredFiles.push(coverage.file);
        }
        // Check if file has low coverage
        else if (
          coverage.lines < this.threshold ||
          coverage.functions < this.threshold ||
          coverage.branches < this.threshold
        ) {
          lowCoverageFiles.push(coverage);
        }
      }

      // Sort by lowest coverage
      lowCoverageFiles.sort((a, b) => {
        const aMin = Math.min(a.lines, a.functions, a.branches);
        const bMin = Math.min(b.lines, b.functions, b.branches);
        return aMin - bMin;
      });

      return {
        summary,
        uncoveredFiles,
        lowCoverageFiles,
      };
    } catch (error) {
      throw new Error(`Failed to read coverage summary: ${error}`);
    }
  }

  /**
   * Display coverage report
   */
  private displayReport(report: CoverageReport): void {
    const total = report.summary.total;
    
    console.log('📊 Coverage Summary\n');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`Lines:      ${this.formatPercentage(total.lines.pct)}`);
    console.log(`Statements: ${this.formatPercentage(total.statements.pct)}`);
    console.log(`Functions:  ${this.formatPercentage(total.functions.pct)}`);
    console.log(`Branches:   ${this.formatPercentage(total.branches.pct)}`);
    console.log('═══════════════════════════════════════════════════════\n');

    // Show uncovered files
    if (report.uncoveredFiles.length > 0) {
      console.log('❌ Uncovered Files:');
      report.uncoveredFiles.forEach(file => {
        console.log(`   ${file}`);
      });
      console.log('');
    }

    // Show low coverage files
    if (report.lowCoverageFiles.length > 0) {
      console.log('⚠️  Files with Low Coverage:');
      console.log('─────────────────────────────────────────────────────────────────────────');
      console.log('File                                          Lines   Funcs   Branch  Stmt');
      console.log('─────────────────────────────────────────────────────────────────────────');
      
      report.lowCoverageFiles.forEach(file => {
        const fileName = this.truncateFileName(file.file, 45);
        console.log(
          `${fileName.padEnd(45)} ` +
          `${this.formatPercent(file.lines)} ` +
          `${this.formatPercent(file.functions)} ` +
          `${this.formatPercent(file.branches)} ` +
          `${this.formatPercent(file.statements)}`
        );
      });
      console.log('');
    }

    // Coverage status
    const allMetrics = [
      total.lines.pct,
      total.statements.pct,
      total.functions.pct,
      total.branches.pct,
    ];
    
    const minCoverage = Math.min(...allMetrics);
    
    if (minCoverage >= 90) {
      console.log('✅ Excellent coverage!');
    } else if (minCoverage >= 80) {
      console.log('👍 Good coverage!');
    } else if (minCoverage >= 70) {
      console.log('⚠️  Coverage needs improvement');
    } else {
      console.log('❌ Coverage is below acceptable threshold');
    }
    
    console.log('\n💡 Run with --open to view detailed HTML report');
  }

  /**
   * Format percentage with color
   */
  private formatPercentage(value: number): string {
    const formatted = `${value.toFixed(2)}%`;
    
    if (value >= 90) {
      return `\x1b[32m${formatted}\x1b[0m`; // Green
    } else if (value >= 80) {
      return `\x1b[33m${formatted}\x1b[0m`; // Yellow
    } else {
      return `\x1b[31m${formatted}\x1b[0m`; // Red
    }
  }

  /**
   * Format percentage for table
   */
  private formatPercent(value: number): string {
    const formatted = `${value.toFixed(1)}%`.padStart(7);
    
    if (value >= 90) {
      return `\x1b[32m${formatted}\x1b[0m`;
    } else if (value >= 80) {
      return `\x1b[33m${formatted}\x1b[0m`;
    } else {
      return `\x1b[31m${formatted}\x1b[0m`;
    }
  }

  /**
   * Truncate file name if too long
   */
  private truncateFileName(fileName: string, maxLength: number): string {
    if (fileName.length <= maxLength) {
      return fileName;
    }
    
    const start = fileName.substring(0, 20);
    const end = fileName.substring(fileName.length - (maxLength - 23));
    return `${start}...${end}`;
  }

  /**
   * Open HTML coverage report
   */
  private async openHtmlReport(): Promise<void> {
    const htmlReport = path.join(this.coverageDir, 'index.html');
    
    try {
      const platform = process.platform;
      let command: string;
      
      if (platform === 'darwin') {
        command = `open ${htmlReport}`;
      } else if (platform === 'win32') {
        command = `start ${htmlReport}`;
      } else {
        command = `xdg-open ${htmlReport}`;
      }
      
      await execAsync(command);
      console.log('\n📈 Opened coverage report in browser');
    } catch (error) {
      console.log(`\n📈 View detailed report at: file://${htmlReport}`);
    }
  }

  /**
   * Watch mode - regenerate on file changes
   */
  async watch(): Promise<void> {
    console.log('👀 Watching for file changes...\n');
    
    const chokidar = await import('chokidar');
    
    const watcher = chokidar.watch('src/**/*.ts', {
      ignored: [
        '**/node_modules/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/test/**',
      ],
      persistent: true,
    });

    let debounceTimer: NodeJS.Timeout;
    
    watcher.on('change', (filePath) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        console.clear();
        console.log(`\n📝 File changed: ${filePath}`);
        await this.generate();
      }, 1000);
    });

    // Initial run
    await this.generate();
  }

  /**
   * Compare coverage with previous run
   */
  async compare(): Promise<void> {
    const previousFile = path.join(this.coverageDir, '.coverage-previous.json');
    const currentFile = this.summaryFile;
    
    try {
      // Check if previous coverage exists
      await fs.access(previousFile);
      
      const [previous, current] = await Promise.all([
        fs.readFile(previousFile, 'utf-8').then(JSON.parse),
        fs.readFile(currentFile, 'utf-8').then(JSON.parse),
      ]);
      
      console.log('\n📊 Coverage Comparison\n');
      console.log('Metric      Previous   Current    Change');
      console.log('──────────────────────────────────────────');
      
      const metrics = ['lines', 'statements', 'functions', 'branches'];
      
      for (const metric of metrics) {
        const prev = previous.total[metric].pct;
        const curr = current.total[metric].pct;
        const change = curr - prev;
        const changeStr = change >= 0 ? `+${change.toFixed(2)}%` : `${change.toFixed(2)}%`;
        const changeColor = change >= 0 ? '\x1b[32m' : '\x1b[31m';
        
        console.log(
          `${metric.padEnd(12)}` +
          `${prev.toFixed(2)}%`.padStart(10) +
          `${curr.toFixed(2)}%`.padStart(10) +
          `${changeColor}${changeStr.padStart(10)}\x1b[0m`
        );
      }
      
      // Save current as previous for next comparison
      await fs.copyFile(currentFile, previousFile);
      
    } catch (error) {
      console.log('ℹ️  No previous coverage data found for comparison');
      
      // Save current for next time
      try {
        await fs.copyFile(currentFile, previousFile);
      } catch {
        // Ignore errors
      }
    }
  }
}

// Main execution
async function main() {
  const reporter = new CoverageReporter();
  const command = process.argv[2];
  
  try {
    switch (command) {
      case 'watch':
        await reporter.watch();
        break;
      case 'compare':
        await reporter.generate();
        await reporter.compare();
        break;
      default:
        await reporter.generate();
        if (process.argv.includes('--compare')) {
          await reporter.compare();
        }
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { CoverageReporter };
