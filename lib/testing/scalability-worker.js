/**
 * Scalability Test Worker
 * Executes test scenarios in a separate thread.
 */

import { parentPort, workerData } from 'worker_threads';
import axios from 'axios';
import WebSocket from 'ws';

const { workerId, scenarios, thresholds, api, ws } = workerData;

/**
 * Simulates API Load Test
 */
async function runApiLoadTest(scenario) {
    const results = { successes: 0, failures: 0, latencies: [] };
    const endTime = Date.now() + scenario.duration;
    const promises = [];

    while (Date.now() < endTime) {
        const startTime = Date.now();
        promises.push(
            axios.get(`http://localhost:${api.port}${scenario.targetEndpoint}`)
                .then(() => {
                    results.successes++;
                    results.latencies.push(Date.now() - startTime);
                })
                .catch(() => results.failures++)
        );
        await new Promise(resolve => setTimeout(resolve, 1000 / scenario.concurrentUsers));
    }
    await Promise.all(promises);
    return results;
}

/**
 * Main worker logic
 */
async function main() {
    parentPort.postMessage({ status: 'started', workerId });

    for (const scenario of scenarios) {
        let results;
        try {
            switch (scenario.type) {
                case 'apiLoadTest':
                    results = await runApiLoadTest(scenario);
                    break;
                // Other scenario types would be handled here
                default:
                    throw new Error(`Unknown scenario type: ${scenario.type}`);
            }
            parentPort.postMessage({ status: 'scenarioCompleted', workerId, scenario, results });
        } catch (error) {
            parentPort.postMessage({ status: 'error', workerId, scenario, error: error.message });
        }
    }

    parentPort.postMessage({ status: 'finished', workerId });
}

main().catch(err => {
    parentPort.postMessage({ status: 'error', workerId, error: err.message });
});
