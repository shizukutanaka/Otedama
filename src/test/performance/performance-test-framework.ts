// Performance test framework for mining pool
// John Carmack: "Focus on the important things. Performance matters."

import { performance } from 'perf_hooks';
import * as os from 'os';
import { Logger } from '../../logging/logger';

export interface PerformanceMetrics {
  operation: string;
  iterations: number;
  totalTime: number;
  avgTime: number;
  minTime: number;
  maxTime: number;
  opsPerSecond: number;
  standardDeviation: number;
  percentiles: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
}

export interface PerformanceTestOptions {
  name: string;
  iterations?: number;
  warmupIterations?: number;
  maxTime?: number; // Maximum time in milliseconds
  async?: boolean;
}

export interface SystemInfo {
  cpu: {
    model: string;
    cores: number;
    speed: number;
  };
  memory: {
    total: number;
    free: number;
    used: number;
  };
  platform: string;
  nodeVersion: string;
}

/**
 * Performance test runner
 */
export class PerformanceTestRunner {
  private logger: Logger;
  private results: Map<string, PerformanceMetrics[]> = new Map();

  constructor() {
    this.logger = new Logger('PerformanceTest');
  }

  /**
   * Run a performance test
   */
  async run<T>(
    fn: () => T | Promise<T>,
    options: PerformanceTestOptions
  ): Promise<PerformanceMetrics> {
    const {
      name,
      iterations = 1000,
      warmupIterations = 100,
      maxTime = 30000,
      async = false
    } = options;

    this.logger.info(`Running performance test: ${name}`);

    // Warmup
    if (warmupIterations > 0) {
      this.logger.debug(`Warming up with ${warmupIterations} iterations...`);
      for (let i = 0; i < warmupIterations; i++) {
        if (async) {
          await fn();
        } else {
          fn();
        }
      }
    }

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    // Run test
    const times: number[] = [];
    const startTime = performance.now();
    let actualIterations = 0;

    for (let i = 0; i < iterations; i++) {
      const iterStart = performance.now();
      
      if (async) {
        await fn();
      } else {
        fn();
      }
      
      const iterEnd = performance.now();
      times.push(iterEnd - iterStart);
      actualIterations++;

      // Check if we've exceeded max time
      if (iterEnd - startTime > maxTime) {
        this.logger.warn(`Test exceeded max time after ${actualIterations} iterations`);
        break;
      }
    }

    const totalTime = performance.now() - startTime;

    // Calculate metrics
    const metrics = this.calculateMetrics(name, times, totalTime);
    
    // Store results
    if (!this.results.has(name)) {
      this.results.set(name, []);
    }
    this.results.get(name)!.push(metrics);

    return metrics;
  }

  /**
   * Compare two functions
   */
  async compare<T>(
    name: string,
    fnA: () => T | Promise<T>,
    fnB: () => T | Promise<T>,
    options: Omit<PerformanceTestOptions, 'name'> = {}
  ): Promise<{
    a: PerformanceMetrics;
    b: PerformanceMetrics;
    comparison: {
      speedup: number;
      winner: 'A' | 'B';
      significant: boolean;
    };
  }> {
    const resultA = await this.run(fnA, { ...options, name: `${name} - A` });
    const resultB = await this.run(fnB, { ...options, name: `${name} - B` });

    const speedup = resultA.avgTime / resultB.avgTime;
    const winner = speedup > 1 ? 'B' : 'A';
    
    // Simple significance test (could be improved with proper statistics)
    const significant = Math.abs(speedup - 1) > 0.1;

    return {
      a: resultA,
      b: resultB,
      comparison: {
        speedup,
        winner,
        significant
      }
    };
  }

  /**
   * Run a benchmark suite
   */
  async suite(
    name: string,
    tests: Array<{
      name: string;
      fn: () => any | Promise<any>;
      options?: Omit<PerformanceTestOptions, 'name'>;
    }>
  ): Promise<void> {
    this.logger.info(`Running benchmark suite: ${name}`);
    this.logger.info('='.repeat(60));

    const systemInfo = this.getSystemInfo();
    this.displaySystemInfo(systemInfo);

    const results: PerformanceMetrics[] = [];

    for (const test of tests) {
      const result = await this.run(test.fn, {
        name: test.name,
        ...test.options
      });
      results.push(result);
      this.displayResult(result);
    }

    // Display summary
    this.displaySummary(results);
  }

  /**
   * Calculate metrics from timing data
   */
  private calculateMetrics(
    operation: string,
    times: number[],
    totalTime: number
  ): PerformanceMetrics {
    const iterations = times.length;
    const sum = times.reduce((a, b) => a + b, 0);
    const avgTime = sum / iterations;
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const opsPerSecond = 1000 / avgTime;

    // Calculate standard deviation
    const variance = times.reduce((acc, time) => {
      return acc + Math.pow(time - avgTime, 2);
    }, 0) / iterations;
    const standardDeviation = Math.sqrt(variance);

    // Calculate percentiles
    const sorted = [...times].sort((a, b) => a - b);
    const percentiles = {
      p50: sorted[Math.floor(iterations * 0.5)],
      p90: sorted[Math.floor(iterations * 0.9)],
      p95: sorted[Math.floor(iterations * 0.95)],
      p99: sorted[Math.floor(iterations * 0.99)]
    };

    return {
      operation,
      iterations,
      totalTime,
      avgTime,
      minTime,
      maxTime,
      opsPerSecond,
      standardDeviation,
      percentiles
    };
  }

  /**
   * Get system information
   */
  private getSystemInfo(): SystemInfo {
    const cpus = os.cpus();
    return {
      cpu: {
        model: cpus[0].model,
        cores: cpus.length,
        speed: cpus[0].speed
      },
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        used: os.totalmem() - os.freemem()
      },
      platform: os.platform(),
      nodeVersion: process.version
    };
  }

  /**
   * Display system information
   */
  private displaySystemInfo(info: SystemInfo): void {
    console.log('\nSystem Information:');
    console.log(`  CPU: ${info.cpu.model} (${info.cpu.cores} cores @ ${info.cpu.speed}MHz)`);
    console.log(`  Memory: ${this.formatBytes(info.memory.used)} / ${this.formatBytes(info.memory.total)}`);
    console.log(`  Platform: ${info.platform}`);
    console.log(`  Node.js: ${info.nodeVersion}`);
    console.log('');
  }

  /**
   * Display a single result
   */
  private displayResult(result: PerformanceMetrics): void {
    console.log(`\n${result.operation}:`);
    console.log(`  Iterations: ${result.iterations.toLocaleString()}`);
    console.log(`  Total time: ${result.totalTime.toFixed(2)}ms`);
    console.log(`  Average: ${this.formatTime(result.avgTime)}`);
    console.log(`  Min: ${this.formatTime(result.minTime)}`);
    console.log(`  Max: ${this.formatTime(result.maxTime)}`);
    console.log(`  Std Dev: ${this.formatTime(result.standardDeviation)}`);
    console.log(`  Ops/sec: ${result.opsPerSecond.toFixed(2)}`);
    console.log(`  Percentiles:`);
    console.log(`    50th: ${this.formatTime(result.percentiles.p50)}`);
    console.log(`    90th: ${this.formatTime(result.percentiles.p90)}`);
    console.log(`    95th: ${this.formatTime(result.percentiles.p95)}`);
    console.log(`    99th: ${this.formatTime(result.percentiles.p99)}`);
  }

  /**
   * Display summary of all results
   */
  private displaySummary(results: PerformanceMetrics[]): void {
    console.log('\n' + '='.repeat(60));
    console.log('Summary:');
    console.log('='.repeat(60));
    
    // Sort by ops/sec
    const sorted = [...results].sort((a, b) => b.opsPerSecond - a.opsPerSecond);
    const fastest = sorted[0];
    
    console.log('\nOperation                     Avg Time    Ops/sec    Relative');
    console.log('-'.repeat(60));
    
    for (const result of sorted) {
      const relative = (fastest.opsPerSecond / result.opsPerSecond).toFixed(2);
      console.log(
        `${result.operation.padEnd(28)} ` +
        `${this.formatTime(result.avgTime).padStart(10)} ` +
        `${result.opsPerSecond.toFixed(2).padStart(10)} ` +
        `${relative}x`.padStart(10)
      );
    }
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

  /**
   * Format bytes for display
   */
  private formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  /**
   * Export results to JSON
   */
  exportResults(): string {
    const data = {
      timestamp: new Date().toISOString(),
      system: this.getSystemInfo(),
      results: Object.fromEntries(this.results)
    };
    
    return JSON.stringify(data, null, 2);
  }

  /**
   * Generate markdown report
   */
  generateReport(): string {
    const system = this.getSystemInfo();
    let report = '# Performance Test Report\n\n';
    
    report += `Generated: ${new Date().toISOString()}\n\n`;
    
    report += '## System Information\n\n';
    report += `- **CPU**: ${system.cpu.model} (${system.cpu.cores} cores @ ${system.cpu.speed}MHz)\n`;
    report += `- **Memory**: ${this.formatBytes(system.memory.total)}\n`;
    report += `- **Platform**: ${system.platform}\n`;
    report += `- **Node.js**: ${system.nodeVersion}\n\n`;
    
    report += '## Results\n\n';
    
    for (const [name, results] of this.results) {
      const latest = results[results.length - 1];
      report += `### ${name}\n\n`;
      report += `| Metric | Value |\n`;
      report += `|--------|-------|\n`;
      report += `| Iterations | ${latest.iterations.toLocaleString()} |\n`;
      report += `| Average Time | ${this.formatTime(latest.avgTime)} |\n`;
      report += `| Min Time | ${this.formatTime(latest.minTime)} |\n`;
      report += `| Max Time | ${this.formatTime(latest.maxTime)} |\n`;
      report += `| Ops/sec | ${latest.opsPerSecond.toFixed(2)} |\n`;
      report += `| Std Dev | ${this.formatTime(latest.standardDeviation)} |\n`;
      report += `| P50 | ${this.formatTime(latest.percentiles.p50)} |\n`;
      report += `| P90 | ${this.formatTime(latest.percentiles.p90)} |\n`;
      report += `| P95 | ${this.formatTime(latest.percentiles.p95)} |\n`;
      report += `| P99 | ${this.formatTime(latest.percentiles.p99)} |\n\n`;
    }
    
    return report;
  }
}

/**
 * Global performance test runner instance
 */
export const perfTest = new PerformanceTestRunner();

/**
 * Decorator for performance testing methods
 */
export function PerfTest(options?: Partial<PerformanceTestOptions>) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function (...args: any[]) {
      const result = await perfTest.run(
        () => originalMethod.apply(this, args),
        {
          name: `${target.constructor.name}.${propertyKey}`,
          ...options
        }
      );
      
      console.log(`Performance: ${result.operation} - ${result.opsPerSecond.toFixed(2)} ops/sec`);
      
      return originalMethod.apply(this, args);
    };
    
    return descriptor;
  };
}
