import { jest } from '@jest/globals';
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { BaseAgent } from '../../lib/agents/base-agent.js';
import { MonitoringAgent } from '../../lib/agents/monitoring-agent.js';
import { SecurityAgent } from '../../lib/agents/security-agent.js';
import { HealthCheckAgent } from '../../lib/agents/health-check-agent.js';
import { SelfHealingAgent } from '../../lib/agents/self-healing-agent.js';
import { OptimizationAgent } from '../../lib/agents/optimization-agent.js';
import { ScalingAgent } from '../../lib/agents/scaling-agent.js';
import { agentManager } from '../../lib/agents/agent-manager.js';

describe('Agent System Tests', () => {
  let testAgents = [];
  
  afterEach(async () => {
    // Cleanup all test agents
    for (const agent of testAgents) {
      if (agent.state === 'running') {
        agent.stop();
      }
      await agent.shutdown();
    }
    testAgents = [];
    
    // Reset agent manager
    await agentManager.shutdown();
  });

  describe('BaseAgent', () => {
    test('should initialize with default configuration', async () => {
      const agent = new BaseAgent({
        name: 'TestAgent',
        type: 'test'
      });
      testAgents.push(agent);

      expect(agent.name).toBe('TestAgent');
      expect(agent.type).toBe('test');
      expect(agent.enabled).toBe(true);
      expect(agent.state).toBe('idle');
      expect(agent.runCount).toBe(0);
    });

    test('should emit events during lifecycle', async () => {
      const agent = new BaseAgent({
        name: 'TestAgent',
        type: 'test',
        interval: 100
      });
      testAgents.push(agent);

      const events = [];
      agent.on('initialized', () => events.push('initialized'));
      agent.on('started', () => events.push('started'));
      agent.on('stopped', () => events.push('stopped'));

      await agent.initialize();
      expect(events).toContain('initialized');
      expect(agent.state).toBe('ready');

      agent.start();
      expect(events).toContain('started');
      expect(agent.state).toBe('running');

      agent.stop();
      expect(events).toContain('stopped');
      expect(agent.state).toBe('stopped');
    });

    test('should handle execution errors gracefully', async () => {
      class FailingAgent extends BaseAgent {
        async run() {
          throw new Error('Test error');
        }
      }

      const agent = new FailingAgent({
        name: 'FailingAgent',
        type: 'test'
      });
      testAgents.push(agent);

      await agent.initialize();
      
      const errorEvents = [];
      agent.on('execute:error', (data) => errorEvents.push(data));

      await agent.execute();
      
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error.message).toBe('Test error');
      expect(agent.errors).toHaveLength(1);
      expect(agent.metrics.failureCount).toBe(1);
    });

    test('should track performance metrics', async () => {
      class SlowAgent extends BaseAgent {
        async run() {
          await new Promise(resolve => setTimeout(resolve, 50));
          return { success: true };
        }
      }

      const agent = new SlowAgent({
        name: 'SlowAgent',
        type: 'test'
      });
      testAgents.push(agent);

      await agent.initialize();
      await agent.execute();

      expect(agent.metrics.successCount).toBe(1);
      expect(agent.metrics.totalExecutionTime).toBeGreaterThan(40);
      expect(agent.metrics.averageExecutionTime).toBeGreaterThan(40);
    });

    test('should support inter-agent communication', async () => {
      const agent1 = new BaseAgent({ name: 'Agent1', type: 'test' });
      const agent2 = new BaseAgent({ name: 'Agent2', type: 'test' });
      testAgents.push(agent1, agent2);

      await agent1.initialize();
      await agent2.initialize();

      const messages = [];
      agent2.on('message:received', (payload) => messages.push(payload));

      const response = await agent1.communicate(agent2, 'Hello from Agent1');
      
      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe('Agent1');
      expect(messages[0].message).toBe('Hello from Agent1');
      expect(response.status).toBe('received');
    });
  });

  describe('MonitoringAgent', () => {
    test('should collect system metrics', async () => {
      const agent = new MonitoringAgent({
        name: 'TestMonitor',
        interval: 100
      });
      testAgents.push(agent);

      await agent.initialize();
      const result = await agent.execute();

      expect(result).toHaveProperty('metrics');
      expect(result.metrics).toHaveProperty('system');
      expect(result.metrics).toHaveProperty('application');
      expect(result.metrics).toHaveProperty('mining');
      expect(result.metrics).toHaveProperty('network');

      expect(result.metrics.system).toHaveProperty('cpu');
      expect(result.metrics.system).toHaveProperty('memory');
      expect(result.metrics.application).toHaveProperty('memory');
      expect(result.metrics.application).toHaveProperty('uptime');
    });

    test('should detect anomalies in metrics', async () => {
      const agent = new MonitoringAgent({
        name: 'TestMonitor',
        cpuThreshold: 50
      });
      testAgents.push(agent);

      await agent.initialize();

      // Simulate high CPU usage
      agent.setContext('cpuUsage', 90);
      
      const result = await agent.execute();
      
      expect(result.analysis.issues.length).toBeGreaterThan(0);
      expect(result.analysis.issues[0].type).toBe('cpu');
      expect(result.analysis.health).not.toBe('good');
    });

    test('should generate alerts for critical issues', async () => {
      const agent = new MonitoringAgent({
        name: 'TestMonitor',
        cpuThreshold: 50,
        memoryThreshold: 50
      });
      testAgents.push(agent);

      await agent.initialize();

      const alerts = [];
      agent.on('alert', (alert) => alerts.push(alert));

      // Simulate critical system state
      agent.setContext('cpuUsage', 95);
      agent.setContext('memoryUsage', 95);

      await agent.execute();

      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[0].level).toBe('critical');
    });
  });

  describe('SecurityAgent', () => {
    test('should detect security threats', async () => {
      const agent = new SecurityAgent({
        name: 'TestSecurity',
        interval: 100
      });
      testAgents.push(agent);

      await agent.initialize();

      // Simulate failed authentication attempts
      const authLogs = Array.from({ length: 10 }, (_, i) => ({
        ip: '192.168.1.100',
        success: false,
        timestamp: Date.now() - i * 1000
      }));
      agent.setContext('authLogs', authLogs);

      const result = await agent.execute();

      expect(result.activeThreats).toBeGreaterThan(0);
      expect(result.blockedIPs).toBeGreaterThan(0);
    });

    test('should respond to threats automatically', async () => {
      const agent = new SecurityAgent({
        name: 'TestSecurity'
      });
      testAgents.push(agent);

      await agent.initialize();

      const alerts = [];
      agent.on('alert', (alert) => alerts.push(alert));

      // Simulate DDoS attack
      agent.setContext('activeConnections', Array.from({ length: 200 }, (_, i) => ({
        source: '192.168.1.100',
        requestRate: 150,
        timestamp: Date.now()
      })));

      await agent.execute();

      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[0].type).toBe('ddos_detected');
      expect(agent.blockedIPs.has('192.168.1.100')).toBe(true);
    });
  });

  describe('HealthCheckAgent', () => {
    test('should perform comprehensive health checks', async () => {
      const agent = new HealthCheckAgent({
        name: 'TestHealth',
        interval: 100
      });
      testAgents.push(agent);

      await agent.initialize();

      // Mock system state
      agent.setContext('databaseConnected', true);
      agent.setContext('redisConnected', true);
      agent.setContext('cpuUsage', 50);
      agent.setContext('memoryUsage', 60);

      const result = await agent.execute();

      expect(result).toHaveProperty('healthScore');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('checks');
      expect(result.healthScore).toBeGreaterThan(0);
      expect(result.status).toBe('healthy');
    });

    test('should predict potential failures', async () => {
      const agent = new HealthCheckAgent({
        name: 'TestHealth'
      });
      testAgents.push(agent);

      await agent.initialize();

      // Simulate degrading system state
      for (let i = 0; i < 10; i++) {
        agent.setContext('cpuUsage', 50 + i * 5);
        await agent.execute();
      }

      const result = await agent.execute();

      expect(result.predictions.length).toBeGreaterThan(0);
      expect(result.predictions[0].type).toBe('trend_based');
    });
  });

  describe('SelfHealingAgent', () => {
    test('should identify and heal issues', async () => {
      const agent = new SelfHealingAgent({
        name: 'TestHealer',
        interval: 100
      });
      testAgents.push(agent);

      await agent.initialize();

      // Mock health dependency
      const mockHealth = {
        getStatus: () => ({
          errorCount: 15,
          metrics: { averageExecutionTime: 6000 }
        })
      };
      agent.addDependency('health', mockHealth);

      const result = await agent.execute();

      expect(result.issuesFound).toBeGreaterThan(0);
      expect(result.healingApplied.length).toBeGreaterThan(0);
      expect(result.healingApplied[0].status).toBe('success');
    });

    test('should handle healing failures gracefully', async () => {
      class FailingHealingAgent extends SelfHealingAgent {
        async performGarbageCollection() {
          throw new Error('Healing failed');
        }
      }

      const agent = new FailingHealingAgent({
        name: 'FailingHealer'
      });
      testAgents.push(agent);

      await agent.initialize();

      const alerts = [];
      agent.on('alert', (alert) => alerts.push(alert));

      // Force a healing attempt
      const issue = {
        type: 'memory_leak',
        severity: 'high',
        component: 'system',
        healingStrategies: ['garbageCollection']
      };

      const result = await agent.healIssue(issue);

      expect(result.status).toBe('failed');
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[0].type).toBe('healing_failed');
    });
  });

  describe('OptimizationAgent', () => {
    test('should identify optimization opportunities', async () => {
      const agent = new OptimizationAgent({
        name: 'TestOptimizer',
        interval: 100
      });
      testAgents.push(agent);

      await agent.initialize();

      // Mock monitoring dependency with high CPU
      const mockMonitor = {
        getMetricsSummary: () => ({
          current: {
            system: { cpu: { usage: 85 }, memory: { percentage: 60 } },
            mining: { poolEfficiency: 90 },
            network: { latency: 50 }
          }
        })
      };
      agent.addDependency('monitor', mockMonitor);

      const result = await agent.execute();

      expect(result.opportunities.length).toBeGreaterThan(0);
      expect(result.opportunities[0].type).toBe('cpu');
      expect(result.opportunities[0].priority).toBe('high');
    });

    test('should apply optimizations automatically', async () => {
      const agent = new OptimizationAgent({
        name: 'TestOptimizer'
      });
      testAgents.push(agent);

      await agent.initialize();

      // Mock high CPU scenario
      const mockMonitor = {
        getMetricsSummary: () => ({
          current: {
            system: { cpu: { usage: 90 } }
          }
        })
      };
      agent.addDependency('monitor', mockMonitor);

      const result = await agent.execute();

      expect(result.applied.length).toBeGreaterThan(0);
      expect(result.applied[0].success).toBe(true);
      expect(result.applied[0].type).toBe('cpu');
    });
  });

  describe('ScalingAgent', () => {
    test('should analyze scaling needs', async () => {
      const agent = new ScalingAgent({
        name: 'TestScaler',
        interval: 100
      });
      testAgents.push(agent);

      await agent.initialize();

      // Mock monitoring data
      const mockMonitor = {
        getMetricsSummary: () => ({
          current: {
            system: { cpu: { usage: 85 }, memory: { percentage: 90 } },
            network: { connections: 900 },
            mining: { connectedMiners: 150 }
          }
        })
      };
      agent.addDependency('monitor', mockMonitor);

      const result = await agent.execute();

      expect(result.analysis.overall).toBe('scale_up');
      expect(result.analysis.cpu.need).toBe('scale_up');
      expect(result.analysis.memory.need).toBe('scale_up');
    });

    test('should execute scaling actions', async () => {
      const agent = new ScalingAgent({
        name: 'TestScaler'
      });
      testAgents.push(agent);

      await agent.initialize();

      const scalingEvents = [];
      agent.on('scale:workers', (data) => scalingEvents.push(data));

      // Mock critical CPU usage
      const mockMonitor = {
        getMetricsSummary: () => ({
          current: {
            system: { cpu: { usage: 95 } }
          }
        })
      };
      agent.addDependency('monitor', mockMonitor);

      const result = await agent.execute();

      expect(result.actions.length).toBeGreaterThan(0);
      expect(result.results.length).toBeGreaterThan(0);
      expect(scalingEvents.length).toBeGreaterThan(0);
    });

    test('should respect cooldown periods', async () => {
      const agent = new ScalingAgent({
        name: 'TestScaler'
      });
      testAgents.push(agent);

      await agent.initialize();

      // Set recent scaling action
      agent.lastScalingAction = {
        timestamp: Date.now() - 60000, // 1 minute ago
        action: { type: 'scale_workers' }
      };

      const mockMonitor = {
        getMetricsSummary: () => ({
          current: {
            system: { cpu: { usage: 95 } }
          }
        })
      };
      agent.addDependency('monitor', mockMonitor);

      const result = await agent.execute();

      // Should not scale due to cooldown
      expect(result.actions.length).toBe(0);
    });
  });

  describe('Agent Manager', () => {
    test('should initialize multiple agents', async () => {
      const config = {
        agents: [
          { type: 'monitoring', name: 'TestMonitor', config: { interval: 1000 } },
          { type: 'health', name: 'TestHealth', config: { interval: 2000 } },
          { type: 'security', name: 'TestSecurity', config: { interval: 1500 } }
        ]
      };

      await agentManager.initialize(config);

      expect(agentManager.agents.size).toBe(3);
      expect(agentManager.getAgent('TestMonitor')).toBeInstanceOf(MonitoringAgent);
      expect(agentManager.getAgent('TestHealth')).toBeInstanceOf(HealthCheckAgent);
      expect(agentManager.getAgent('TestSecurity')).toBeInstanceOf(SecurityAgent);
    });

    test('should coordinate agent actions', async () => {
      const config = {
        agents: [
          { type: 'monitoring', name: 'TestMonitor', config: { interval: 100 } },
          { type: 'optimization', name: 'TestOptimizer', config: { interval: 200 } }
        ]
      };

      await agentManager.initialize(config);

      const coordinations = [];
      agentManager.on('agent:execute:success', (data) => {
        if (data.result.metrics?.cpu > 80) {
          coordinations.push('high_cpu_detected');
        }
      });

      // Simulate high CPU from monitoring agent
      const monitor = agentManager.getAgent('TestMonitor');
      monitor.setContext('cpuUsage', 90);

      await monitor.execute();

      // Check if coordination was triggered
      expect(coordinations.length).toBeGreaterThan(0);
    });

    test('should handle agent failures', async () => {
      class FailingTestAgent extends BaseAgent {
        async run() {
          throw new Error('Agent failure');
        }
      }

      agentManager.registerAgentType('failing', FailingTestAgent);

      const config = {
        agents: [
          { type: 'failing', name: 'TestFailing', config: {} }
        ]
      };

      await agentManager.initialize(config);

      const errors = [];
      agentManager.on('agent:execute:error', (data) => errors.push(data));

      const agent = agentManager.getAgent('TestFailing');
      await agent.execute();

      expect(errors.length).toBe(1);
      expect(errors[0].error.message).toBe('Agent failure');
    });

    test('should provide comprehensive status reporting', async () => {
      const config = {
        agents: [
          { type: 'monitoring', name: 'TestMonitor', config: { interval: 100 } },
          { type: 'health', name: 'TestHealth', config: { interval: 200 } }
        ]
      };

      await agentManager.initialize(config);
      await agentManager.startAll();

      // Let agents run for a bit
      await new Promise(resolve => setTimeout(resolve, 150));

      const statuses = agentManager.getAgentStatuses();

      expect(Object.keys(statuses)).toHaveLength(2);
      expect(statuses.TestMonitor.state).toBe('running');
      expect(statuses.TestMonitor.runCount).toBeGreaterThan(0);
      expect(statuses.TestHealth.state).toBe('running');

      await agentManager.stopAll();
    });
  });
});

describe('Agent Integration Tests', () => {
  test('should demonstrate full system coordination', async () => {
    const config = {
      agents: [
        { type: 'monitoring', name: 'SystemMonitor', config: { interval: 50, cpuThreshold: 70 } },
        { type: 'optimization', name: 'Optimizer', config: { interval: 100 } },
        { type: 'scaling', name: 'Scaler', config: { interval: 150 } }
      ]
    };

    await agentManager.initialize(config);

    const events = [];
    agentManager.on('agent:execute:success', (data) => {
      events.push({
        agent: data.agent.name,
        type: data.agent.type,
        timestamp: Date.now()
      });
    });

    // Simulate high CPU scenario
    const monitor = agentManager.getAgent('SystemMonitor');
    monitor.setContext('cpuUsage', 85);

    // Setup dependencies
    const optimizer = agentManager.getAgent('Optimizer');
    const scaler = agentManager.getAgent('Scaler');
    
    optimizer.addDependency('monitor', monitor);
    scaler.addDependency('monitor', monitor);

    // Execute monitoring first
    await monitor.execute();
    
    // Then optimization and scaling should respond
    await optimizer.execute();
    await scaler.execute();

    expect(events.length).toBe(3);
    expect(events.some(e => e.agent === 'SystemMonitor')).toBe(true);
    expect(events.some(e => e.agent === 'Optimizer')).toBe(true);
    expect(events.some(e => e.agent === 'Scaler')).toBe(true);
  });

  test('should handle cascading failures gracefully', async () => {
    class CascadingFailureAgent extends BaseAgent {
      constructor(config) {
        super(config);
        this.failureCount = 0;
      }

      async run() {
        this.failureCount++;
        if (this.failureCount <= 2) {
          throw new Error(`Failure ${this.failureCount}`);
        }
        return { recovered: true, attempts: this.failureCount };
      }
    }

    agentManager.registerAgentType('cascading', CascadingFailureAgent);

    const config = {
      agents: [
        { type: 'cascading', name: 'TestCascading', config: {} }
      ]
    };

    await agentManager.initialize(config);

    const agent = agentManager.getAgent('TestCascading');
    
    // First execution should fail
    await agent.execute();
    expect(agent.metrics.failureCount).toBe(1);
    
    // Second execution should also fail
    await agent.execute();
    expect(agent.metrics.failureCount).toBe(2);
    
    // Third execution should succeed
    await agent.execute();
    expect(agent.metrics.successCount).toBe(1);
  });
});