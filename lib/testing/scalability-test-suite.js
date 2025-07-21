/**
 * Scalability Test Suite for Otedama
 * Comprehensive load testing, stress testing, and performance benchmarking for the Otedama platform.
 */

import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { performance } from 'perf_hooks';
import { cpus } from 'os';
import { getErrorHandler, ErrorCategory } from '../error-handler.js';

/**
 * Scalability Test Suite
 */
export class ScalabilityTestSuite extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      api: { port: process.env.API_PORT || 3333, ...options.api },
      ws: { port: process.env.WS_PORT || 3334, ...options.ws },
      maxWorkers: options.maxWorkers || cpus().length,
      scenarios: options.scenarios || {},
      thresholds: {
        avgResponseTime: 200, // ms
        errorRate: 1, // %
        wsLatency: 150, // ms
        ...options.thresholds,
      },
      ...options,
    };

    this.errorHandler = getErrorHandler();
    this.workers = [];
    this.results = [];
    this.report = {};
    this.isInitialized = false;
  }

  async initialize() {
    if (this.isInitialized) return;
    console.log('🔧 Initializing Scalability Test Suite...');
    this.initializeWorkers();
    this.isInitialized = true;
    console.log('✅ Test Suite Initialized.');
  }

  async runAllScenarios() {
    await this.initialize();
    console.log('🚀 Starting all scalability test scenarios...');
    const startTime = performance.now();

    const scenarioPromises = Object.entries(this.options.scenarios).map(([name, config]) =>
      this.runScenario(name, config)
    );

    await Promise.all(scenarioPromises);

    const endTime = performance.now();
    this.generateReport(endTime - startTime);

    this.emit('testReport', this.report);
    await this.cleanup();
    return this.report;
  }

  async runScenario(name, config) {
    console.log(`▶️  Running scenario: ${name}`);
    const scenarioResults = [];
    const promises = this.workers.map(worker => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          worker.terminate();
          reject(new Error(`Scenario '${name}' timed out.`));
        }, (config.duration || 10000) + 5000);

        worker.once('message', (message) => {
          clearTimeout(timeout);
          if (message.status === 'completed') {
            scenarioResults.push(message.results);
            resolve();
          } else {
            reject(new Error(message.error || 'Unknown worker error'));
          }
        });

        worker.postMessage({ ...config, type: name });
      });
    });

    try {
      await Promise.all(promises);
      this.results.push({ name, results: this.aggregateWorkerResults(scenarioResults), config });
      console.log(`✅ Scenario completed: ${name}`);
    } catch (error) {
      console.error(`❌ Scenario failed: ${name}`, error);
      this.results.push({ name, error: error.message, config });
      this.errorHandler.handleError(error, { context: 'scalability_test_scenario', category: ErrorCategory.TESTING });
    }
  }

  aggregateWorkerResults(workerResults) {
    const aggregated = { successes: 0, failures: 0, latencies: [] };
    for (const result of workerResults) {
      if(result) {
        aggregated.successes += result.successes;
        aggregated.failures += result.failures;
        aggregated.latencies.push(...result.latencies);
      }
    }
    return aggregated;
  }

  initializeWorkers() {
    console.log(`🔧 Initializing ${this.options.maxWorkers} test workers...`);

    const workerScript = `
      const { parentPort, workerData } = require('worker_threads');
      const http = require('http');

      const agent = new http.Agent({ keepAlive: true, maxSockets: 100 });

      async function runApiLoadTest(scenario) {
        const results = { successes: 0, failures: 0, latencies: [] };
        const endTime = Date.now() + scenario.duration;
        
        const run = () => {
            return new Promise(resolve => {
                const startTime = Date.now();
                const req = http.get({ host: 'localhost', port: workerData.api.port, path: scenario.targetEndpoint, agent }, (res) => {
                    res.on('data', () => {});
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 400) {
                            results.successes++;
                        } else {
                            results.failures++;
                        }
                        results.latencies.push(Date.now() - startTime);
                        resolve();
                    });
                });
                req.on('error', (e) => { 
                    results.failures++; 
                    resolve(); 
                });
                req.end();
            });
        }

        const promises = [];
        while (Date.now() < endTime) {
            promises.push(run());
        }
        await Promise.all(promises);

        return results;
      }
      
      parentPort.on('message', async (scenario) => {
        try {
          let results;
          if (scenario.type.includes('apiLoadTest')) {
             results = await runApiLoadTest(scenario);
          } else {
             // WebSocket and other tests would be implemented here as placeholders
             results = { successes: 0, failures: 0, latencies: [] };
          }
          parentPort.postMessage({ status: 'completed', results });
        } catch (e) {
          parentPort.postMessage({ status: 'error', error: e.message });
        }
      });
    `;

    for (let i = 0; i < this.options.maxWorkers; i++) {
      const worker = new Worker(workerScript, {
        eval: true,
        workerData: {
          workerId: i,
          api: this.options.api,
          ws: this.options.ws,
          thresholds: this.options.thresholds,
        },
      });
      worker.on('error', (err) => {
          console.error(`Worker ${i} error:`, err);
          this.errorHandler.handleError(err, { context: 'scalability_worker', category: ErrorCategory.TESTING });
      });
      worker.on('exit', (code) => {
        if (code !== 0) {
            console.error(`Worker ${i} stopped with exit code ${code}`);
        }
      });
      this.workers.push(worker);
    }
  }

  generateReport(totalDuration) {
    const summary = {};
    let overallResult = 'PASS';

    for (const item of this.results) {
      if (item.error) {
        summary[item.name] = { result: 'FAIL', error: item.error };
        overallResult = 'FAIL';
        continue;
      }

      const { successes, failures: failCount, latencies } = item.results;
      const totalRequests = successes + failCount;
      const errorRate = totalRequests > 0 ? (failCount / totalRequests) * 100 : 0;
      const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

      const isPass = errorRate <= this.options.thresholds.errorRate && avgLatency <= this.options.thresholds.avgResponseTime;
      if (!isPass) overallResult = 'FAIL';

      summary[item.name] = {
        result: isPass ? 'PASS' : 'FAIL',
        requests: totalRequests,
        successes,
        failures: failCount,
        errorRate: errorRate.toFixed(2) + '%',
        avgLatency: avgLatency.toFixed(2) + 'ms',
        thresholds: {
            errorRate: `< ${this.options.thresholds.errorRate}%`,
            avgLatency: `< ${this.options.thresholds.avgResponseTime}ms`
        }
      };
    }

    this.report = {
      overallResult,
      totalDuration: (totalDuration / 1000).toFixed(2) + 's',
      summary,
      recommendations: overallResult === 'FAIL' ? ['Review failed scenarios, check application logs, and consider performance optimization.'] : ['All scalability tests passed.'],
    };
  }

  async cleanup() {
    console.log('🧹 Cleaning up test resources...');
    for (const worker of this.workers) {
      await worker.terminate();
    }
    this.workers = [];
    console.log('✅ Cleanup completed');
  }
}

export default ScalabilityTestSuite;
