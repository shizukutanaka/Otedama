/**
 * Basic Agent System Tests
 * Simple tests without complex dependencies
 */

import { BaseAgent } from '../../lib/agents/base-agent.js';
import { MonitoringAgent } from '../../lib/agents/monitoring-agent.js';

describe('Basic Agent Tests', () => {
  let testAgent;

  afterEach(async () => {
    if (testAgent) {
      if (testAgent.state === 'running') {
        testAgent.stop();
      }
      await testAgent.shutdown();
      testAgent = null;
    }
  });

  test('BaseAgent should initialize correctly', async () => {
    testAgent = new BaseAgent({
      name: 'TestAgent',
      type: 'test',
      enabled: true
    });

    expect(testAgent.name).toBe('TestAgent');
    expect(testAgent.type).toBe('test');
    expect(testAgent.enabled).toBe(true);
    expect(testAgent.state).toBe('idle');
    expect(testAgent.runCount).toBe(0);
  });

  test('BaseAgent should handle lifecycle events', async () => {
    testAgent = new BaseAgent({
      name: 'LifecycleTest',
      type: 'test'
    });

    let initCalled = false;
    let startCalled = false;
    let stopCalled = false;

    testAgent.on('initialized', () => { initCalled = true; });
    testAgent.on('started', () => { startCalled = true; });
    testAgent.on('stopped', () => { stopCalled = true; });

    await testAgent.initialize();
    expect(initCalled).toBe(true);
    expect(testAgent.state).toBe('ready');

    testAgent.start();
    expect(startCalled).toBe(true);

    testAgent.stop();
    expect(stopCalled).toBe(true);
    expect(testAgent.state).toBe('stopped');
  });

  test('BaseAgent should track metrics', async () => {
    class MetricsTestAgent extends BaseAgent {
      async run() {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { test: 'success' };
      }
    }

    testAgent = new MetricsTestAgent({
      name: 'MetricsTest',
      type: 'test'
    });

    await testAgent.initialize();
    await testAgent.execute();

    expect(testAgent.metrics.successCount).toBe(1);
    expect(testAgent.metrics.failureCount).toBe(0);
    expect(testAgent.metrics.totalExecutionTime).toBeGreaterThan(0);
    expect(testAgent.runCount).toBe(1);
  });

  test('BaseAgent should handle errors gracefully', async () => {
    class ErrorTestAgent extends BaseAgent {
      async run() {
        throw new Error('Test error');
      }
    }

    testAgent = new ErrorTestAgent({
      name: 'ErrorTest',
      type: 'test'
    });

    await testAgent.initialize();
    
    let errorEvent = null;
    testAgent.on('execute:error', (data) => { errorEvent = data; });

    await testAgent.execute();

    expect(testAgent.metrics.failureCount).toBe(1);
    expect(testAgent.metrics.successCount).toBe(0);
    expect(testAgent.errors.length).toBe(1);
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.error.message).toBe('Test error');
  });

  test('MonitoringAgent should collect basic metrics', async () => {
    testAgent = new MonitoringAgent({
      name: 'TestMonitor',
      interval: 1000
    });

    await testAgent.initialize();
    const result = await testAgent.execute();

    expect(result).toBeTruthy();
    expect(result.metrics).toBeTruthy();
    expect(result.metrics.system).toBeTruthy();
    expect(result.metrics.application).toBeTruthy();
    expect(result.analysis).toBeTruthy();

    // Check system metrics structure
    expect(result.metrics.system.cpu).toBeTruthy();
    expect(result.metrics.system.memory).toBeTruthy();
    expect(typeof result.metrics.system.cpu.usage).toBe('number');
    expect(typeof result.metrics.system.memory.percentage).toBe('number');
  });

  test('MonitoringAgent should analyze metrics correctly', async () => {
    testAgent = new MonitoringAgent({
      name: 'AnalysisTest',
      cpuThreshold: 50,
      memoryThreshold: 50
    });

    await testAgent.initialize();

    // Mock high resource usage
    const originalCollectMetrics = testAgent.collectSystemMetrics;
    testAgent.collectSystemMetrics = async () => ({
      cpu: { usage: 90, cores: 4 },
      memory: { 
        total: 8000000000,
        used: 7200000000,
        free: 800000000,
        percentage: 90
      },
      uptime: 1000,
      loadAverage: [2, 2, 2]
    });

    const result = await testAgent.execute();

    expect(result.analysis.issues.length).toBeGreaterThan(0);
    expect(result.analysis.score).toBeLessThan(80);
    expect(result.analysis.health).not.toBe('good');

    // Restore original method
    testAgent.collectSystemMetrics = originalCollectMetrics;
  });

  test('Agent context should work correctly', async () => {
    testAgent = new BaseAgent({
      name: 'ContextTest',
      type: 'test'
    });

    await testAgent.initialize();

    // Test setting and getting context
    testAgent.setContext('testKey', 'testValue');
    expect(testAgent.getContext('testKey')).toBe('testValue');

    // Test getting all context
    testAgent.setContext('anotherKey', 42);
    const allContext = testAgent.getContext();
    expect(allContext.testKey).toBe('testValue');
    expect(allContext.anotherKey).toBe(42);
  });

  test('Agent communication should work', async () => {
    const agent1 = new BaseAgent({ name: 'Agent1', type: 'test' });
    const agent2 = new BaseAgent({ name: 'Agent2', type: 'test' });

    await agent1.initialize();
    await agent2.initialize();

    let receivedMessage = null;
    agent2.on('message:received', (payload) => { 
      receivedMessage = payload; 
    });

    const response = await agent1.communicate(agent2, 'Hello from Agent1');

    expect(receivedMessage).toBeTruthy();
    expect(receivedMessage.from).toBe('Agent1');
    expect(receivedMessage.message).toBe('Hello from Agent1');
    expect(response.status).toBe('received');

    // Cleanup
    await agent1.shutdown();
    await agent2.shutdown();
  });

  test('Agent status should be comprehensive', async () => {
    testAgent = new BaseAgent({
      name: 'StatusTest',
      type: 'test',
      priority: 'high'
    });

    await testAgent.initialize();
    await testAgent.execute();

    const status = testAgent.getStatus();

    expect(status.name).toBe('StatusTest');
    expect(status.type).toBe('test');
    expect(status.state).toBe('ready');
    expect(status.enabled).toBe(true);
    expect(status.runCount).toBe(1);
    expect(status.metrics).toBeTruthy();
    expect(status.metrics.successCount).toBe(1);
    expect(typeof status.errorCount).toBe('number');
  });
});