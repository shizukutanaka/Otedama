import { agentManager } from '../lib/agents/index.js';
import { logger } from '../lib/core/logger.js';
import chalk from 'chalk';

/**
 * Otedama Agent System Demo
 * 
 * This demonstrates the autonomous agent system that monitors, optimizes,
 * and maintains the Otedama mining platform.
 */

class AgentSystemDemo {
  constructor() {
    this.running = false;
    this.startTime = Date.now();
  }

  async start() {
    console.log(chalk.blue.bold('\n🤖 Otedama Agent System Demo\n'));
    console.log(chalk.gray('Initializing autonomous agents...\n'));

    try {
      // Initialize the agent manager with custom configuration
      await agentManager.initialize({
        agents: [
          {
            type: 'monitoring',
            name: 'SystemMonitor',
            config: {
              interval: 10000, // 10 seconds for demo
              cpuThreshold: 70,
              memoryThreshold: 80
            }
          },
          {
            type: 'health',
            name: 'HealthChecker',
            config: {
              interval: 15000 // 15 seconds
            }
          },
          {
            type: 'security',
            name: 'SecurityGuard',
            config: {
              interval: 20000 // 20 seconds
            }
          },
          {
            type: 'optimization',
            name: 'PerformanceOptimizer',
            config: {
              interval: 30000 // 30 seconds
            }
          },
          {
            type: 'healing',
            name: 'SelfHealer',
            config: {
              interval: 25000 // 25 seconds
            }
          },
          {
            type: 'scaling',
            name: 'AutoScaler',
            config: {
              interval: 40000, // 40 seconds
              predictiveScaling: true
            }
          }
        ]
      });

      // Setup event listeners
      this.setupEventListeners();

      // Simulate system metrics
      this.simulateSystemMetrics();

      // Start all agents
      await agentManager.startAll();
      this.running = true;

      console.log(chalk.green('✅ All agents initialized and running\n'));
      
      // Display agent statuses
      this.displayAgentStatuses();

      // Keep the demo running
      await this.runDemo();

    } catch (error) {
      console.error(chalk.red('Failed to start agent system:'), error);
    }
  }

  setupEventListeners() {
    // Listen for agent events
    agentManager.on('agent:execute:start', (agent) => {
      console.log(chalk.cyan(`⚡ ${agent.name} executing...`));
    });

    agentManager.on('agent:execute:success', (data) => {
      console.log(chalk.green(`✓ ${data.agent.name} completed in ${data.executionTime}ms`));
      
      // Display specific results based on agent type
      switch (data.agent.type) {
        case 'monitoring':
          this.displayMonitoringResults(data.result);
          break;
        case 'health':
          this.displayHealthResults(data.result);
          break;
        case 'security':
          this.displaySecurityResults(data.result);
          break;
        case 'optimization':
          this.displayOptimizationResults(data.result);
          break;
        case 'healing':
          this.displayHealingResults(data.result);
          break;
        case 'scaling':
          this.displayScalingResults(data.result);
          break;
      }
    });

    agentManager.on('agent:execute:error', (data) => {
      console.log(chalk.red(`✗ ${data.agent.name} failed: ${data.error.message}`));
    });

    agentManager.on('alert', (alert) => {
      console.log(chalk.yellow.bold(`\n🚨 ALERT from ${alert.agent}:`));
      console.log(chalk.yellow(`   Type: ${alert.alert.type}`));
      console.log(chalk.yellow(`   Severity: ${alert.alert.severity}`));
      console.log(chalk.yellow(`   Message: ${alert.alert.message || 'No message'}\n`));
    });
  }

  simulateSystemMetrics() {
    // Simulate dynamic system metrics for demonstration
    setInterval(() => {
      const agents = agentManager.getAllAgents();
      
      // Update monitoring agent context
      const monitor = agents.find(a => a.type === 'monitoring');
      if (monitor) {
        // Simulate CPU usage (varies between 30-90%)
        monitor.setContext('cpuUsage', 30 + Math.random() * 60);
        monitor.setContext('cpuCores', 8);
        
        // Simulate memory usage
        const totalMemory = 16 * 1024 * 1024 * 1024; // 16GB
        const usedMemory = totalMemory * (0.4 + Math.random() * 0.5);
        monitor.setContext('totalMemory', totalMemory);
        monitor.setContext('freeMemory', totalMemory - usedMemory);
        monitor.setContext('memoryUsage', usedMemory);
        
        // Simulate network metrics
        monitor.setContext('activeConnections', Math.floor(50 + Math.random() * 200));
        monitor.setContext('networkLatency', Math.floor(10 + Math.random() * 50));
        monitor.setContext('bandwidthIn', Math.floor(100000 + Math.random() * 900000));
        monitor.setContext('bandwidthOut', Math.floor(50000 + Math.random() * 450000));
        
        // Simulate mining metrics
        monitor.setContext('hashrate', Math.floor(1000000 + Math.random() * 9000000));
        monitor.setContext('difficulty', 1000000);
        monitor.setContext('blockHeight', Math.floor(700000 + Math.random() * 1000));
        monitor.setContext('connectedMiners', Math.floor(10 + Math.random() * 90));
        monitor.setContext('sharesSubmitted', Math.floor(1000 + Math.random() * 9000));
        monitor.setContext('sharesAccepted', Math.floor(900 + Math.random() * 8100));
        monitor.setContext('poolEfficiency', 85 + Math.random() * 14);
      }

      // Update other agents' contexts
      agents.forEach(agent => {
        if (agent.type === 'health') {
          agent.setContext('databaseConnected', Math.random() > 0.1);
          agent.setContext('redisConnected', Math.random() > 0.05);
          agent.setContext('averageQueryTime', Math.floor(5 + Math.random() * 50));
        }
        
        if (agent.type === 'security') {
          agent.setContext('authLogs', this.generateAuthLogs());
        }
        
        if (agent.type === 'scaling') {
          agent.setContext('cpuUsage', monitor?.getContext('cpuUsage'));
          agent.setContext('memoryUsage', monitor?.getContext('memoryUsage'));
          agent.setContext('activeConnections', monitor?.getContext('activeConnections'));
          agent.setContext('connectedMiners', monitor?.getContext('connectedMiners'));
        }
      });
    }, 5000);
  }

  generateAuthLogs() {
    // Generate some fake auth logs for demonstration
    const logs = [];
    const count = Math.floor(Math.random() * 10);
    
    for (let i = 0; i < count; i++) {
      logs.push({
        ip: `192.168.1.${Math.floor(1 + Math.random() * 254)}`,
        success: Math.random() > 0.3,
        timestamp: Date.now() - Math.floor(Math.random() * 60000)
      });
    }
    
    return logs;
  }

  displayAgentStatuses() {
    console.log(chalk.blue.bold('\n📊 Agent Status Overview:\n'));
    
    const statuses = agentManager.getAgentStatuses();
    
    for (const [name, status] of Object.entries(statuses)) {
      const stateColor = status.state === 'running' ? 'green' : 
                        status.state === 'error' ? 'red' : 'yellow';
      
      console.log(chalk.bold(`${name}:`));
      console.log(`  State: ${chalk[stateColor](status.state)}`);
      console.log(`  Type: ${status.type}`);
      console.log(`  Run Count: ${status.runCount}`);
      console.log(`  Success Rate: ${this.calculateSuccessRate(status.metrics)}%`);
      console.log();
    }
  }

  calculateSuccessRate(metrics) {
    const total = metrics.successCount + metrics.failureCount;
    if (total === 0) return 100;
    return ((metrics.successCount / total) * 100).toFixed(1);
  }

  displayMonitoringResults(result) {
    if (result.alerts && result.alerts.length > 0) {
      console.log(chalk.yellow('  ⚠️  Monitoring alerts detected'));
    }
    
    if (result.metrics?.system) {
      console.log(chalk.gray(`  CPU: ${result.metrics.system.cpu?.usage?.toFixed(1)}% | ` +
                           `Memory: ${result.metrics.system.memory?.percentage?.toFixed(1)}%`));
    }
  }

  displayHealthResults(result) {
    console.log(chalk.gray(`  Health Score: ${result.healthScore}/100 (${result.status})`));
    
    if (result.predictions && result.predictions.length > 0) {
      console.log(chalk.yellow(`  ⚠️  ${result.predictions.length} potential issues predicted`));
    }
  }

  displaySecurityResults(result) {
    console.log(chalk.gray(`  Threat Level: ${result.threatLevel} | ` +
                         `Active Threats: ${result.activeThreats} | ` +
                         `Blocked IPs: ${result.blockedIPs}`));
  }

  displayOptimizationResults(result) {
    if (result.applied && result.applied.length > 0) {
      console.log(chalk.green(`  ✓ Applied ${result.applied.length} optimizations`));
    }
  }

  displayHealingResults(result) {
    if (result.healingApplied && result.healingApplied.length > 0) {
      console.log(chalk.green(`  ✓ ${result.healingApplied.length} issues healed`));
    }
    console.log(chalk.gray(`  Success Rate: ${result.successRate?.toFixed(1)}%`));
  }

  displayScalingResults(result) {
    if (result.actions && result.actions.length > 0) {
      console.log(chalk.blue(`  📈 ${result.actions.length} scaling actions taken`));
    }
    console.log(chalk.gray(`  Efficiency: ${result.efficiency?.overall?.toFixed(1)}%`));
  }

  async runDemo() {
    // Display periodic summary
    setInterval(() => {
      if (this.running) {
        this.displaySummary();
      }
    }, 60000); // Every minute

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\n\nShutting down agent system...'));
      await this.shutdown();
    });

    // Keep the process running
    await new Promise(() => {});
  }

  displaySummary() {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    console.log(chalk.blue.bold(`\n📈 System Summary (Uptime: ${uptime}s):\n`));
    
    const statuses = agentManager.getAgentStatuses();
    let totalRuns = 0;
    let totalSuccess = 0;
    let totalFailures = 0;
    
    for (const status of Object.values(statuses)) {
      totalRuns += status.runCount;
      totalSuccess += status.metrics.successCount;
      totalFailures += status.metrics.failureCount;
    }
    
    console.log(`  Total Agent Executions: ${totalRuns}`);
    console.log(`  Successful: ${totalSuccess}`);
    console.log(`  Failed: ${totalFailures}`);
    console.log(`  Overall Success Rate: ${((totalSuccess / (totalSuccess + totalFailures)) * 100).toFixed(1)}%\n`);
  }

  async shutdown() {
    this.running = false;
    await agentManager.shutdown();
    console.log(chalk.green('Agent system shut down successfully'));
    process.exit(0);
  }
}

// Run the demo
const demo = new AgentSystemDemo();
demo.start().catch(console.error);