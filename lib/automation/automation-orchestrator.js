/**
 * Automation Orchestrator
 * Central coordinator for all automation systems
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import UserAutomationManager from './user-automation-manager.js';
import AdminAutomationManager from './admin-automation-manager.js';
import PredictiveMaintenanceSystem from './predictive-maintenance.js';
import SecurityAutomationSystem from './security-automation.js';
import SelfHealingSystem from './self-healing-system.js';
import AIOptimizationEngine from './ai-optimization-engine.js';
import AutoDeploymentSystem from './auto-deployment-system.js';

const logger = getLogger('AutomationOrchestrator');

/**
 * Central automation orchestrator
 */
export class AutomationOrchestrator extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Enable/disable automation systems
      userAutomation: options.userAutomation !== false,
      adminAutomation: options.adminAutomation !== false,
      predictiveMaintenance: options.predictiveMaintenance !== false,
      securityAutomation: options.securityAutomation !== false,
      selfHealing: options.selfHealing !== false,
      aiOptimization: options.aiOptimization !== false,
      autoDeployment: options.autoDeployment !== false,
      
      // Cross-system coordination
      enableCrossSystemOptimization: options.enableCrossSystemOptimization !== false,
      coordinationInterval: options.coordinationInterval || 300000, // 5 minutes
      
      // Emergency protocols
      emergencyShutdown: options.emergencyShutdown !== false,
      safeMode: options.safeMode || false,
      
      // Full automation settings
      enableFullAutomation: options.enableFullAutomation !== false,
      automationLevel: options.automationLevel || 'advanced', // basic, intermediate, advanced, full
      
      ...options
    };
    
    this.automationSystems = new Map();
    this.systemMetrics = new Map();
    this.coordinationHistory = [];
    this.isRunning = false;
    
    this.initialize();
  }

  /**
   * Initialize all automation systems
   */
  async initialize() {
    try {
      logger.info('🤖 Initializing Automation Orchestrator...');
      
      // Initialize individual automation systems
      await this.initializeAutomationSystems();
      
      // Setup cross-system coordination
      await this.setupCoordination();
      
      // Start monitoring and coordination
      await this.startOrchestration();
      
      logger.info('✅ Automation Orchestrator initialized successfully');
      this.emit('initialized');
      
    } catch (error) {
      logger.error('Failed to initialize Automation Orchestrator:', error);
      this.emit('error', error);
    }
  }

  /**
   * Initialize individual automation systems
   */
  async initializeAutomationSystems() {
    const initPromises = [];
    
    // User Automation System
    if (this.options.userAutomation) {
      this.automationSystems.set('user', new UserAutomationManager({
        autoOptimization: true,
        autoPoolSwitching: true,
        autoPayouts: true,
        autoMinerConfig: true
      }));
      initPromises.push(this.setupSystemEventHandlers('user'));
    }
    
    // Admin Automation System
    if (this.options.adminAutomation) {
      this.automationSystems.set('admin', new AdminAutomationManager({
        systemHealthCheck: true,
        autoScaling: true,
        selfHealing: true,
        securityMonitoring: true
      }));
      initPromises.push(this.setupSystemEventHandlers('admin'));
    }
    
    // Predictive Maintenance System
    if (this.options.predictiveMaintenance) {
      this.automationSystems.set('maintenance', new PredictiveMaintenanceSystem({
        autoRepair: true,
        predictionWindow: 86400000, // 24 hours
        maintenanceThreshold: 0.8
      }));
      initPromises.push(this.setupSystemEventHandlers('maintenance'));
    }
    
    // Security Automation System
    if (this.options.securityAutomation) {
      this.automationSystems.set('security', new SecurityAutomationSystem({
        threatDetection: true,
        autoBlock: true,
        autoQuarantine: true,
        behaviorAnalysis: true
      }));
      initPromises.push(this.setupSystemEventHandlers('security'));
    }
    
    // Self-Healing System
    if (this.options.selfHealing) {
      this.automationSystems.set('selfHealing', new SelfHealingSystem({
        enableAutoHealing: true,
        autoRestartOnCrash: true,
        autoScaleOnLoad: true,
        autoFailoverOnError: true,
        autoRollbackOnFailure: true
      }));
      initPromises.push(this.setupSystemEventHandlers('selfHealing'));
    }
    
    // AI Optimization Engine
    if (this.options.aiOptimization) {
      this.automationSystems.set('aiOptimization', new AIOptimizationEngine({
        enableAI: true,
        optimizationGoals: [
          { type: 'performance', weight: 0.4 },
          { type: 'cost', weight: 0.3 },
          { type: 'reliability', weight: 0.3 }
        ]
      }));
      initPromises.push(this.setupSystemEventHandlers('aiOptimization'));
    }
    
    // Auto-Deployment System
    if (this.options.autoDeployment) {
      this.automationSystems.set('autoDeployment', new AutoDeploymentSystem({
        enableAutoDeployment: true,
        deploymentStrategy: 'canary',
        pipeline: {
          autoTrigger: true,
          parallelJobs: 3
        },
        testing: {
          runUnitTests: true,
          runIntegrationTests: true,
          runE2ETests: true,
          minCoverage: 80
        }
      }));
      initPromises.push(this.setupSystemEventHandlers('autoDeployment'));
    }
    
    await Promise.all(initPromises);
    logger.info(`Initialized ${this.automationSystems.size} automation systems`);
  }

  /**
   * Setup event handlers for automation systems
   */
  async setupSystemEventHandlers(systemName) {
    const system = this.automationSystems.get(systemName);
    if (!system) return;
    
    // Forward all events with system prefix
    system.on('*', (eventName, ...args) => {
      this.emit(`${systemName}:${eventName}`, ...args);
    });
    
    // Handle critical events
    system.on('error', (error) => {
      this.handleSystemError(systemName, error);
    });
    
    // System-specific event handling
    switch (systemName) {
      case 'user':
        system.on('user-optimized', (data) => {
          this.recordUserOptimization(data);
        });
        break;
        
      case 'admin':
        system.on('critical-alert', (alert) => {
          this.handleCriticalAlert(alert);
        });
        break;
        
      case 'maintenance':
        system.on('auto-repair-successful', (data) => {
          this.recordSuccessfulRepair(data);
        });
        break;
        
      case 'security':
        system.on('threat-detected', (data) => {
          this.handleSecurityThreat(data);
        });
        break;
    }
  }

  /**
   * Setup cross-system coordination
   */
  async setupCoordination() {
    if (!this.options.enableCrossSystemOptimization) return;
    
    // Start coordination timer
    this.coordinationTimer = setInterval(() => {
      this.performCrossSystemCoordination();
    }, this.options.coordinationInterval);
    
    logger.info('Cross-system coordination enabled');
  }

  /**
   * Start orchestration
   */
  async startOrchestration() {
    this.isRunning = true;
    
    // Start all automation systems
    const startPromises = Array.from(this.automationSystems.entries()).map(
      async ([name, system]) => {
        try {
          if (typeof system.start === 'function') {
            await system.start();
          }
          logger.info(`${name} automation system started`);
        } catch (error) {
          logger.error(`Failed to start ${name} automation system:`, error);
        }
      }
    );
    
    await Promise.allSettled(startPromises);
    
    // Start metrics collection
    this.metricsTimer = setInterval(() => {
      this.collectSystemMetrics();
    }, 60000); // Every minute
    
    this.emit('orchestration-started');
    logger.info('🚀 Automation orchestration started');
  }

  /**
   * Perform cross-system coordination
   */
  async performCrossSystemCoordination() {
    try {
      const coordination = {
        timestamp: Date.now(),
        actions: []
      };
      
      // Collect metrics from all systems
      const systemMetrics = await this.collectAllSystemMetrics();
      
      // Identify coordination opportunities
      const opportunities = this.identifyCoordinationOpportunities(systemMetrics);
      
      // Execute coordinated actions
      for (const opportunity of opportunities) {
        const result = await this.executeCoordinatedAction(opportunity);
        coordination.actions.push(result);
      }
      
      this.coordinationHistory.push(coordination);
      
      this.emit('coordination-completed', coordination);
      
    } catch (error) {
      logger.error('Cross-system coordination failed:', error);
    }
  }

  /**
   * Identify coordination opportunities
   */
  identifyCoordinationOpportunities(metrics) {
    const opportunities = [];
    
    // High system load + user optimization opportunity
    if (metrics.admin?.cpu > 80 && metrics.user?.optimizableUsers > 0) {
      opportunities.push({
        type: 'load-balancing-optimization',
        priority: 'high',
        description: 'Optimize user mining to reduce system load',
        involvedSystems: ['admin', 'user']
      });
    }
    
    // Security threat + maintenance window
    if (metrics.security?.activeThreats > 0 && metrics.maintenance?.maintenanceWindow) {
      opportunities.push({
        type: 'security-maintenance-coordination',
        priority: 'medium',
        description: 'Coordinate security response with maintenance',
        involvedSystems: ['security', 'maintenance']
      });
    }
    
    // Predictive maintenance + user notification
    if (metrics.maintenance?.upcomingMaintenance > 0) {
      opportunities.push({
        type: 'maintenance-user-notification',
        priority: 'medium',
        description: 'Notify users of upcoming maintenance',
        involvedSystems: ['maintenance', 'user']
      });
    }
    
    return opportunities;
  }

  /**
   * Execute coordinated action
   */
  async executeCoordinatedAction(opportunity) {
    try {
      let result = { success: false };
      
      switch (opportunity.type) {
        case 'load-balancing-optimization':
          result = await this.coordinateLoadBalancing(opportunity);
          break;
        case 'security-maintenance-coordination':
          result = await this.coordinateSecurityMaintenance(opportunity);
          break;
        case 'maintenance-user-notification':
          result = await this.coordinateMaintenanceNotification(opportunity);
          break;
      }
      
      return {
        opportunity,
        result,
        executedAt: Date.now()
      };
      
    } catch (error) {
      return {
        opportunity,
        result: { success: false, error: error.message },
        executedAt: Date.now()
      };
    }
  }

  /**
   * Coordinate load balancing with user optimization
   */
  async coordinateLoadBalancing(opportunity) {
    const adminSystem = this.automationSystems.get('admin');
    const userSystem = this.automationSystems.get('user');
    
    if (!adminSystem || !userSystem) {
      return { success: false, reason: 'Required systems not available' };
    }
    
    // Get high-load indicators from admin system
    const adminDashboard = adminSystem.getAdminDashboard();
    
    // Trigger user optimizations to reduce load
    const optimizationResults = await userSystem.runOptimizationCycle();
    
    return {
      success: true,
      action: 'load-balancing-coordination',
      details: {
        systemLoad: adminDashboard.systemHealth.metrics?.cpu,
        optimizationsTriggered: optimizationResults?.optimizations || 0
      }
    };
  }

  /**
   * Handle critical system alerts
   */
  async handleCriticalAlert(alert) {
    logger.error('CRITICAL AUTOMATION ALERT:', alert);
    
    // Emergency protocols
    if (alert.severity === 'critical' && this.options.emergencyShutdown) {
      await this.initiateEmergencyProtocols(alert);
    }
    
    // Cross-system notification
    this.notifyAllSystems('critical-alert', alert);
    
    this.emit('critical-alert-handled', alert);
  }

  /**
   * Handle security threats
   */
  async handleSecurityThreat(threatData) {
    const { threat } = threatData;
    
    // Coordinate with other systems based on threat type
    if (threat.type === 'ddos-attack') {
      // Notify admin system for potential scaling
      const adminSystem = this.automationSystems.get('admin');
      if (adminSystem && typeof adminSystem.handleSecurityEvent === 'function') {
        await adminSystem.handleSecurityEvent(threat);
      }
    }
    
    // If threat affects mining, notify user system
    if (threat.type === 'mining-anomaly') {
      const userSystem = this.automationSystems.get('user');
      if (userSystem && typeof userSystem.handleSecurityThreat === 'function') {
        await userSystem.handleSecurityThreat(threat);
      }
    }
    
    this.emit('security-threat-coordinated', threatData);
  }

  /**
   * Initiate emergency protocols
   */
  async initiateEmergencyProtocols(alert) {
    logger.warn('🚨 INITIATING EMERGENCY PROTOCOLS');
    
    // Switch to safe mode
    this.options.safeMode = true;
    
    // Reduce automation aggressiveness
    await this.reduceCutomationAggressiveness();
    
    // Notify administrators
    this.emit('emergency-protocols-activated', { alert, timestamp: Date.now() });
    
    // Stop non-critical automation
    await this.stopNonCriticalAutomation();
  }

  /**
   * Get comprehensive automation dashboard
   */
  getAutomationDashboard() {
    const systemStatuses = new Map();
    
    for (const [name, system] of this.automationSystems) {
      systemStatuses.set(name, {
        status: system.getStatus ? system.getStatus() : { isRunning: true },
        lastActivity: Date.now() // In production, track actual last activity
      });
    }
    
    const recentCoordination = this.coordinationHistory.slice(-10);
    
    return {
      overview: {
        isRunning: this.isRunning,
        safeMode: this.options.safeMode,
        activeSystems: this.automationSystems.size,
        coordinationEnabled: this.options.enableCrossSystemOptimization
      },
      systems: Object.fromEntries(systemStatuses),
      coordination: {
        recentActions: recentCoordination,
        totalCoordinations: this.coordinationHistory.length,
        lastCoordination: recentCoordination[recentCoordination.length - 1]?.timestamp || null
      },
      performance: {
        systemMetrics: Object.fromEntries(this.systemMetrics),
        lastMetricsUpdate: Date.now()
      },
      alerts: {
        safeMode: this.options.safeMode,
        emergencyProtocolsActive: this.options.safeMode
      }
    };
  }

  /**
   * Get specific system status
   */
  getSystemStatus(systemName) {
    const system = this.automationSystems.get(systemName);
    if (!system) return null;
    
    return {
      name: systemName,
      status: system.getStatus ? system.getStatus() : { isRunning: true },
      lastUpdate: Date.now()
    };
  }

  /**
   * Manual system control
   */
  async controlSystem(systemName, action, params = {}) {
    const system = this.automationSystems.get(systemName);
    if (!system) {
      throw new Error(`System ${systemName} not found`);
    }
    
    let result = { success: false };
    
    switch (action) {
      case 'start':
        if (typeof system.start === 'function') {
          await system.start();
          result = { success: true, action: 'started' };
        }
        break;
      case 'stop':
        if (typeof system.stop === 'function') {
          await system.stop();
          result = { success: true, action: 'stopped' };
        }
        break;
      case 'restart':
        if (typeof system.stop === 'function' && typeof system.start === 'function') {
          await system.stop();
          await system.start();
          result = { success: true, action: 'restarted' };
        }
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    
    this.emit('system-controlled', { systemName, action, result, params });
    return result;
  }

  /**
   * Utility methods
   */
  async collectSystemMetrics() {
    for (const [name, system] of this.automationSystems) {
      if (typeof system.getStatus === 'function') {
        this.systemMetrics.set(name, system.getStatus());
      }
    }
  }

  async collectAllSystemMetrics() {
    const metrics = {};
    
    for (const [name, system] of this.automationSystems) {
      if (typeof system.getStatus === 'function') {
        metrics[name] = system.getStatus();
      }
    }
    
    return metrics;
  }

  notifyAllSystems(eventName, data) {
    for (const [name, system] of this.automationSystems) {
      if (typeof system.handleGlobalEvent === 'function') {
        system.handleGlobalEvent(eventName, data);
      }
    }
  }

  handleSystemError(systemName, error) {
    logger.error(`Automation system error in ${systemName}:`, error);
    this.emit('system-error', { systemName, error });
  }

  recordUserOptimization(data) {
    // Record optimization for coordination purposes
    this.emit('user-optimization-recorded', data);
  }

  recordSuccessfulRepair(data) {
    // Record repair for system health tracking
    this.emit('repair-recorded', data);
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      safeMode: this.options.safeMode,
      systemCount: this.automationSystems.size,
      coordinationEnabled: this.options.enableCrossSystemOptimization,
      totalCoordinations: this.coordinationHistory.length,
      lastActivity: Date.now()
    };
  }
}

export default AutomationOrchestrator;