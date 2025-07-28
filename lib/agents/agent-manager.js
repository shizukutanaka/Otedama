import EventEmitter from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('Agent');
import { MonitoringAgent } from './monitoring-agent.js';
import { OptimizationAgent } from './optimization-agent.js';
import { SecurityAgent } from './security-agent.js';
import { HealthCheckAgent } from './health-check-agent.js';
import { SelfHealingAgent } from './self-healing-agent.js';
import { ScalingAgent } from './scaling-agent.js';
import { agentEventBus } from './event-bus.js';

class AgentManager extends EventEmitter {
  constructor() {
    super();
    this.agents = new Map();
    this.agentTypes = new Map([
      ['monitoring', MonitoringAgent],
      ['optimization', OptimizationAgent],
      ['security', SecurityAgent],
      ['health', HealthCheckAgent],
      ['healing', SelfHealingAgent],
      ['scaling', ScalingAgent]
    ]);
    this.initialized = false;
    this.coordinationRules = [];
    this.eventBus = agentEventBus;
  }

  async initialize(config = {}) {
    if (this.initialized) {
      logger.warn('AgentManager already initialized');
      return;
    }

    logger.info('Initializing Agent Manager');
    
    try {
      // Create default agents
      const defaultAgents = config.agents || [
        { type: 'monitoring', name: 'SystemMonitor', config: { interval: 30000 } },
        { type: 'health', name: 'HealthChecker', config: { interval: 60000 } },
        { type: 'security', name: 'SecurityGuard', config: { interval: 45000 } },
        { type: 'optimization', name: 'PerformanceOptimizer', config: { interval: 120000 } },
        { type: 'healing', name: 'SelfHealer', config: { interval: 90000 } },
        { type: 'scaling', name: 'AutoScaler', config: { interval: 180000 } }
      ];

      // Initialize each agent
      for (const agentConfig of defaultAgents) {
        await this.createAgent(agentConfig);
      }

      // Setup inter-agent communication
      this.setupCommunication();
      
      // Setup coordination rules
      this.setupCoordinationRules();
      
      // Setup event bus integration
      this.setupEventBusIntegration();

      this.initialized = true;
      this.emit('initialized', Array.from(this.agents.keys()));
      logger.info('Agent Manager initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Agent Manager:', error);
      throw error;
    }
  }

  async createAgent({ type, name, config = {} }) {
    if (this.agents.has(name)) {
      logger.warn(`Agent ${name} already exists`);
      return this.agents.get(name);
    }

    const AgentClass = this.agentTypes.get(type);
    if (!AgentClass) {
      throw new Error(`Unknown agent type: ${type}`);
    }

    try {
      const agent = new AgentClass({
        ...config,
        name,
        type
      });

      // Setup agent event listeners
      this.setupAgentListeners(agent);

      // Initialize the agent
      await agent.initialize();

      this.agents.set(name, agent);
      this.emit('agent:created', { name, type, agent });
      
      logger.info(`Created agent: ${name} (${type})`);
      return agent;
    } catch (error) {
      logger.error(`Failed to create agent ${name}:`, error);
      throw error;
    }
  }

  setupAgentListeners(agent) {
    agent.on('execute:start', () => {
      this.emit('agent:execute:start', agent);
    });

    agent.on('execute:success', (data) => {
      this.emit('agent:execute:success', data);
      this.processAgentResult(agent, data);
    });

    agent.on('execute:error', (data) => {
      this.emit('agent:execute:error', data);
      this.handleAgentError(agent, data);
    });

    agent.on('alert', (alert) => {
      this.handleAlert(agent, alert);
    });
  }

  setupCommunication() {
    // Setup dependencies between agents
    const monitor = this.agents.get('SystemMonitor');
    const optimizer = this.agents.get('PerformanceOptimizer');
    const security = this.agents.get('SecurityGuard');
    const healer = this.agents.get('SelfHealer');
    const scaler = this.agents.get('AutoScaler');
    const health = this.agents.get('HealthChecker');

    if (monitor && optimizer) {
      optimizer.addDependency('monitor', monitor);
    }

    if (monitor && scaler) {
      scaler.addDependency('monitor', monitor);
    }

    if (health && healer) {
      healer.addDependency('health', health);
    }

    if (security && healer) {
      healer.addDependency('security', security);
    }
  }

  setupCoordinationRules() {
    // Define rules for agent coordination
    this.coordinationRules = [
      {
        name: 'HighCPUResponse',
        condition: (data) => data.metrics?.cpu > 80,
        actions: [
          { agent: 'AutoScaler', action: 'scaleUp' },
          { agent: 'PerformanceOptimizer', action: 'optimizeCPU' }
        ]
      },
      {
        name: 'SecurityThreatResponse',
        condition: (data) => data.threatLevel === 'high',
        actions: [
          { agent: 'SelfHealer', action: 'isolateThreat' },
          { agent: 'SystemMonitor', action: 'increasedMonitoring' }
        ]
      },
      {
        name: 'HealthCheckFailure',
        condition: (data) => data.healthStatus === 'unhealthy',
        actions: [
          { agent: 'SelfHealer', action: 'diagnoseAndFix' },
          { agent: 'SystemMonitor', action: 'detailedMetrics' }
        ]
      }
    ];
  }

  async processAgentResult(agent, data) {
    // Check coordination rules
    for (const rule of this.coordinationRules) {
      if (rule.condition(data.result || {})) {
        logger.info(`Triggering coordination rule: ${rule.name}`);
        
        for (const action of rule.actions) {
          const targetAgent = this.agents.get(action.agent);
          if (targetAgent) {
            await targetAgent.receiveMessage({
              from: 'AgentManager',
              action: action.action,
              trigger: rule.name,
              data: data.result
            });
          }
        }
      }
    }
  }

  async handleAgentError(agent, data) {
    logger.error(`Agent error from ${agent.name}:`, data.error);
    
    // Notify self-healing agent
    const healer = this.agents.get('SelfHealer');
    if (healer && healer !== agent) {
      await healer.receiveMessage({
        from: 'AgentManager',
        action: 'agentError',
        agent: agent.name,
        error: data.error
      });
    }
  }

  async handleAlert(agent, alert) {
    logger.warn(`Alert from ${agent.name}:`, alert);
    this.emit('alert', { agent: agent.name, alert });
    
    // Broadcast important alerts to relevant agents
    if (alert.severity === 'critical') {
      for (const [name, otherAgent] of this.agents) {
        if (otherAgent !== agent) {
          await otherAgent.receiveMessage({
            from: 'AgentManager',
            type: 'alert',
            alert,
            source: agent.name
          });
        }
      }
    }
  }

  getAgent(name) {
    return this.agents.get(name);
  }

  getAllAgents() {
    return Array.from(this.agents.values());
  }

  getAgentStatuses() {
    const statuses = {};
    for (const [name, agent] of this.agents) {
      statuses[name] = agent.getStatus();
    }
    return statuses;
  }

  async startAll() {
    logger.info('Starting all agents');
    for (const agent of this.agents.values()) {
      agent.start();
    }
    this.emit('all:started');
  }

  async stopAll() {
    logger.info('Stopping all agents');
    for (const agent of this.agents.values()) {
      agent.stop();
    }
    this.emit('all:stopped');
  }

  async removeAgent(name) {
    const agent = this.agents.get(name);
    if (!agent) {
      logger.warn(`Agent ${name} not found`);
      return;
    }

    await agent.shutdown();
    this.agents.delete(name);
    this.emit('agent:removed', name);
    logger.info(`Removed agent: ${name}`);
  }

  async shutdown() {
    logger.info('Shutting down Agent Manager');
    
    for (const agent of this.agents.values()) {
      await agent.shutdown();
    }
    
    this.agents.clear();
    this.removeAllListeners();
    this.initialized = false;
    
    logger.info('Agent Manager shutdown complete');
  }

  registerAgentType(type, AgentClass) {
    this.agentTypes.set(type, AgentClass);
    logger.info(`Registered agent type: ${type}`);
  }

  addCoordinationRule(rule) {
    this.coordinationRules.push(rule);
    logger.info(`Added coordination rule: ${rule.name}`);
  }

  /**
   * Setup event bus integration for enhanced agent communication
   */
  setupEventBusIntegration() {
    // Register all agents with event bus
    for (const [name, agent] of this.agents) {
      this.registerAgentWithEventBus(name, agent);
    }

    // Setup global event routing rules
    this.setupGlobalEventRouting();

    logger.info('Event bus integration configured');
  }

  /**
   * Register an agent with the event bus
   */
  registerAgentWithEventBus(name, agent) {
    // Subscribe agent to relevant events based on type
    const eventSubscriptions = this.getEventSubscriptionsForAgent(agent.type);
    
    this.eventBus.subscribe(name, eventSubscriptions, async (data) => {
      try {
        // Forward event to agent's receiveMessage method
        await agent.receiveMessage({
          from: 'EventBus',
          type: 'event',
          eventType: data._meta?.type || 'unknown',
          data: data,
          timestamp: Date.now()
        });
      } catch (error) {
        logger.error(`Error forwarding event to ${name}:`, error);
      }
    }, {
      priority: this.getAgentPriority(agent.type)
    });

    // Setup agent to publish events through event bus
    this.setupAgentEventPublishing(name, agent);
  }

  /**
   * Get event subscriptions for agent type
   */
  getEventSubscriptionsForAgent(agentType) {
    const subscriptions = {
      monitoring: [
        'system:metrics',
        'system:alert',
        'mining:performance',
        'network:status'
      ],
      health: [
        'system:error',
        'agent:failure',
        'service:down',
        'performance:degraded'
      ],
      security: [
        'security:threat',
        'auth:failure',
        'network:anomaly',
        'mining:suspicious'
      ],
      optimization: [
        'performance:degraded',
        'resource:high_usage',
        'system:slow',
        'mining:inefficient'
      ],
      healing: [
        'system:error',
        'service:failure',
        'agent:error',
        'health:critical'
      ],
      scaling: [
        'resource:high_usage',
        'performance:bottleneck',
        'load:high',
        'capacity:limit'
      ]
    };

    return subscriptions[agentType] || ['system:general'];
  }

  /**
   * Setup agent to publish events through event bus
   */
  setupAgentEventPublishing(name, agent) {
    // Intercept agent events and republish through event bus
    const originalEmit = agent.emit.bind(agent);
    
    agent.emit = (eventType, ...args) => {
      // Call original emit
      originalEmit(eventType, ...args);
      
      // Also publish through event bus for cross-agent communication
      if (this.shouldRepublishEvent(eventType)) {
        this.eventBus.publish(`agent:${eventType}`, {
          agent: name,
          agentType: agent.type,
          data: args[0]
        }, {
          source: name,
          priority: this.getEventPriority(eventType)
        });
      }
    };
  }

  /**
   * Determine if event should be republished through event bus
   */
  shouldRepublishEvent(eventType) {
    const republishEvents = [
      'alert',
      'execute:success',
      'execute:error',
      'anomaly',
      'optimization:applied',
      'healing:completed',
      'scaling:action'
    ];
    
    return republishEvents.includes(eventType);
  }

  /**
   * Setup global event routing rules
   */
  setupGlobalEventRouting() {
    // Route security alerts to healing agent
    this.eventBus.addRoutingRule(
      'security_to_healing',
      (message) => message.type === 'agent:alert' && 
                   message.data?.alert?.type?.includes('security'),
      async (message) => {
        const healingAgent = this.agents.get('SelfHealer');
        if (healingAgent) {
          await healingAgent.receiveMessage({
            from: 'SecurityAgent',
            action: 'securityThreat',
            data: message.data
          });
        }
      }
    );

    // Route performance issues to optimization agent
    this.eventBus.addRoutingRule(
      'performance_to_optimization',
      (message) => message.type === 'agent:alert' && 
                   message.data?.alert?.type?.includes('performance'),
      async (message) => {
        const optimizationAgent = this.agents.get('PerformanceOptimizer');
        if (optimizationAgent) {
          await optimizationAgent.receiveMessage({
            from: 'MonitoringAgent',
            action: 'optimizePerformance',
            data: message.data
          });
        }
      }
    );

    // Route resource alerts to scaling agent
    this.eventBus.addRoutingRule(
      'resource_to_scaling',
      (message) => message.type === 'agent:alert' && 
                   (message.data?.alert?.type?.includes('cpu') || 
                    message.data?.alert?.type?.includes('memory')),
      async (message) => {
        const scalingAgent = this.agents.get('AutoScaler');
        if (scalingAgent) {
          await scalingAgent.receiveMessage({
            from: 'MonitoringAgent',
            action: 'evaluateScaling',
            data: message.data
          });
        }
      }
    );

    logger.info('Global event routing rules configured');
  }

  /**
   * Get agent priority for event processing
   */
  getAgentPriority(agentType) {
    const priorities = {
      security: 'critical',
      health: 'high',
      healing: 'high',
      monitoring: 'medium',
      optimization: 'medium',
      scaling: 'low'
    };
    
    return priorities[agentType] || 'medium';
  }

  /**
   * Get event priority
   */
  getEventPriority(eventType) {
    const priorities = {
      alert: 'high',
      'execute:error': 'high',
      anomaly: 'medium',
      'execute:success': 'low'
    };
    
    return priorities[eventType] || 'medium';
  }

  /**
   * Send targeted message to specific agents
   */
  async sendMessage(targets, eventType, data, options = {}) {
    return await this.eventBus.publish(eventType, data, {
      ...options,
      targets: Array.isArray(targets) ? targets : [targets]
    });
  }

  /**
   * Broadcast message to all agents
   */
  async broadcast(eventType, data, options = {}) {
    const targets = Array.from(this.agents.keys());
    return await this.eventBus.publish(eventType, data, {
      ...options,
      targets
    });
  }

  /**
   * Request-response pattern between agents
   */
  async requestFromAgent(targetAgent, requestType, data, timeout = 10000) {
    return await this.eventBus.request(`agent:${targetAgent}:${requestType}`, data, {
      timeout,
      source: 'AgentManager'
    });
  }

  /**
   * Get event bus statistics
   */
  getEventBusStats() {
    return this.eventBus.getStats();
  }

  /**
   * Enhanced shutdown with event bus cleanup
   */
  async shutdown() {
    logger.info('Shutting down Agent Manager');
    
    // Unsubscribe all agents from event bus
    for (const agentName of this.agents.keys()) {
      this.eventBus.unsubscribe(agentName);
    }
    
    // Shutdown all agents
    for (const agent of this.agents.values()) {
      await agent.shutdown();
    }
    
    // Shutdown event bus
    await this.eventBus.shutdown();
    
    this.agents.clear();
    this.removeAllListeners();
    this.initialized = false;
    
    logger.info('Agent Manager shutdown complete');
  }
}

// Export singleton instance
export const agentManager = new AgentManager();