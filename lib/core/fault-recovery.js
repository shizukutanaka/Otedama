/**
 * Fault Recovery System - Otedama
 * Automatic failure detection and recovery
 * 
 * Features:
 * - Component health monitoring
 * - Automatic restart on failure
 * - Cascading failure prevention
 * - State persistence and recovery
 * - Notification system
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import path from 'path';
import axios from 'axios';

const logger = createLogger('FaultRecovery');

export class FaultRecoverySystem extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      checkInterval: config.checkInterval || 30000, // 30 seconds
      maxRestarts: config.maxRestarts || 3,
      restartDelay: config.restartDelay || 5000,
      stateFile: config.stateFile || './data/recovery-state.json',
      notificationWebhook: config.notificationWebhook || process.env.ALERT_WEBHOOK,
      components: config.components || []
    };
    
    this.components = new Map();
    this.failures = new Map();
    this.state = {
      lastCheck: Date.now(),
      totalFailures: 0,
      totalRecoveries: 0
    };
    
    this.checkTimer = null;
  }
  
  /**
   * Initialize fault recovery
   */
  async initialize() {
    logger.info('Initializing fault recovery system...');
    
    // Load previous state
    await this.loadState();
    
    // Start monitoring
    this.checkTimer = setInterval(() => {
      this.performHealthChecks();
    }, this.config.checkInterval);
    
    logger.info('Fault recovery system initialized');
  }
  
  /**
   * Register component for monitoring
   */
  registerComponent(name, component) {
    this.components.set(name, {
      name,
      component,
      status: 'unknown',
      lastCheck: 0,
      restarts: 0,
      failures: []
    });
    
    logger.info(`Registered component for monitoring: ${name}`);
  }
  
  /**
   * Perform health checks
   */
  async performHealthChecks() {
    const checks = [];
    
    for (const [name, info] of this.components) {
      checks.push(this.checkComponent(name, info));
    }
    
    await Promise.all(checks);
    
    this.state.lastCheck = Date.now();
    await this.saveState();
  }
  
  /**
   * Check component health
   */
  async checkComponent(name, info) {
    try {
      const startTime = Date.now();
      let healthy = false;
      
      // Different check methods based on component type
      if (typeof info.component.isHealthy === 'function') {
        healthy = await info.component.isHealthy();
      } else if (typeof info.component.getStatus === 'function') {
        const status = await info.component.getStatus();
        healthy = status === 'running' || status === 'connected';
      } else if (info.component.server && info.component.server.listening) {
        healthy = info.component.server.listening;
      } else {
        // Default check - component exists and no error property
        healthy = info.component && !info.component.error;
      }
      
      const checkTime = Date.now() - startTime;
      
      if (healthy) {
        this.handleHealthy(name, info, checkTime);
      } else {
        await this.handleUnhealthy(name, info);
      }
      
    } catch (error) {
      logger.error(`Health check failed for ${name}:`, error);
      await this.handleUnhealthy(name, info, error);
    }
  }
  
  /**
   * Handle healthy component
   */
  handleHealthy(name, info, checkTime) {
    const wasUnhealthy = info.status === 'unhealthy';
    
    info.status = 'healthy';
    info.lastCheck = Date.now();
    info.checkTime = checkTime;
    
    if (wasUnhealthy) {
      logger.info(`Component ${name} recovered`);
      this.state.totalRecoveries++;
      this.emit('component:recovered', { name, info });
      
      // Clear failure history after recovery
      if (info.failures.length > 0) {
        info.failures = [];
        info.restarts = 0;
      }
    }
  }
  
  /**
   * Handle unhealthy component
   */
  async handleUnhealthy(name, info, error = null) {
    info.status = 'unhealthy';
    info.lastCheck = Date.now();
    
    // Record failure
    const failure = {
      timestamp: Date.now(),
      error: error?.message || 'Health check failed'
    };
    
    info.failures.push(failure);
    this.state.totalFailures++;
    
    // Keep only recent failures
    if (info.failures.length > 10) {
      info.failures = info.failures.slice(-10);
    }
    
    logger.error(`Component ${name} is unhealthy: ${failure.error}`);
    this.emit('component:unhealthy', { name, info, error });
    
    // Attempt recovery
    await this.attemptRecovery(name, info);
  }
  
  /**
   * Attempt component recovery
   */
  async attemptRecovery(name, info) {
    // Check restart limit
    if (info.restarts >= this.config.maxRestarts) {
      logger.error(`Component ${name} exceeded max restarts (${this.config.maxRestarts})`);
      await this.handleCriticalFailure(name, info);
      return;
    }
    
    logger.info(`Attempting recovery for ${name} (attempt ${info.restarts + 1}/${this.config.maxRestarts})`);
    
    // Wait before restart
    await new Promise(resolve => setTimeout(resolve, this.config.restartDelay));
    
    try {
      // Try to stop component gracefully
      if (typeof info.component.stop === 'function') {
        await info.component.stop();
      }
      
      // Wait a bit more
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Try to start component
      if (typeof info.component.start === 'function') {
        await info.component.start();
      } else if (typeof info.component.initialize === 'function') {
        await info.component.initialize();
      }
      
      info.restarts++;
      logger.info(`Component ${name} restarted successfully`);
      
    } catch (error) {
      logger.error(`Failed to restart component ${name}:`, error);
      info.failures.push({
        timestamp: Date.now(),
        error: `Restart failed: ${error.message}`
      });
    }
  }
  
  /**
   * Handle critical failure
   */
  async handleCriticalFailure(name, info) {
    logger.error(`CRITICAL: Component ${name} failed permanently`);
    
    // Send notification
    await this.sendNotification({
      level: 'critical',
      component: name,
      message: `Component ${name} has failed permanently after ${info.restarts} restart attempts`,
      failures: info.failures.slice(-5)
    });
    
    // Emit critical event
    this.emit('component:critical', { name, info });
    
    // Check for cascading failures
    this.checkCascadingFailure();
  }
  
  /**
   * Check for cascading failures
   */
  checkCascadingFailure() {
    const unhealthyCount = Array.from(this.components.values())
      .filter(info => info.status === 'unhealthy').length;
    
    const unhealthyPercentage = unhealthyCount / this.components.size;
    
    if (unhealthyPercentage > 0.5) {
      logger.error('CRITICAL: Cascading failure detected - over 50% of components unhealthy');
      this.emit('system:critical', {
        unhealthyCount,
        totalComponents: this.components.size
      });
    }
  }
  
  /**
   * Send notification
   */
  async sendNotification(alert) {
    if (!this.config.notificationWebhook) return;
    
    try {
      const payload = {
        username: 'Otedama Fault Recovery',
        embeds: [{
          title: `${alert.level.toUpperCase()}: ${alert.component}`,
          description: alert.message,
          color: alert.level === 'critical' ? 0xff0000 : 0xffaa00,
          fields: alert.failures?.map(f => ({
            name: new Date(f.timestamp).toLocaleString(),
            value: f.error,
            inline: false
          })) || [],
          timestamp: new Date().toISOString()
        }]
      };
      
      // Send to webhook (Discord/Slack format)
      await axios.post(this.config.notificationWebhook, payload);
      
    } catch (error) {
      logger.error('Failed to send notification:', error);
    }
  }
  
  /**
   * Manual component restart
   */
  async restartComponent(name) {
    const info = this.components.get(name);
    if (!info) {
      throw new Error(`Component ${name} not found`);
    }
    
    // Reset restart counter for manual restart
    info.restarts = 0;
    
    await this.attemptRecovery(name, info);
  }
  
  /**
   * Get system status
   */
  getStatus() {
    const components = {};
    
    for (const [name, info] of this.components) {
      components[name] = {
        status: info.status,
        lastCheck: info.lastCheck,
        restarts: info.restarts,
        recentFailures: info.failures.slice(-3),
        checkTime: info.checkTime
      };
    }
    
    return {
      ...this.state,
      components,
      summary: {
        total: this.components.size,
        healthy: Array.from(this.components.values()).filter(c => c.status === 'healthy').length,
        unhealthy: Array.from(this.components.values()).filter(c => c.status === 'unhealthy').length
      }
    };
  }
  
  /**
   * Save state to file
   */
  async saveState() {
    try {
      const state = {
        ...this.state,
        components: Object.fromEntries(
          Array.from(this.components.entries()).map(([name, info]) => [
            name,
            {
              status: info.status,
              restarts: info.restarts,
              failures: info.failures
            }
          ])
        )
      };
      
      await fs.mkdir(path.dirname(this.config.stateFile), { recursive: true });
      await fs.writeFile(this.config.stateFile, JSON.stringify(state, null, 2));
      
    } catch (error) {
      logger.error('Failed to save state:', error);
    }
  }
  
  /**
   * Load state from file
   */
  async loadState() {
    try {
      const data = await fs.readFile(this.config.stateFile, 'utf8');
      const savedState = JSON.parse(data);
      
      this.state = {
        ...this.state,
        ...savedState,
        components: undefined
      };
      
      // Restore component states
      if (savedState.components) {
        Object.entries(savedState.components).forEach(([name, state]) => {
          const info = this.components.get(name);
          if (info) {
            info.restarts = state.restarts || 0;
            info.failures = state.failures || [];
          }
        });
      }
      
      logger.info('Loaded recovery state');
      
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Failed to load state:', error);
      }
    }
  }
  
  /**
   * Shutdown fault recovery
   */
  async shutdown() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
    }
    
    await this.saveState();
    
    logger.info('Fault recovery system shutdown');
  }
}

export default FaultRecoverySystem;
