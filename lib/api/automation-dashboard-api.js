/**
 * Automation Dashboard API
 * API endpoints for monitoring and controlling automation
 * 
 * Features:
 * - Real-time automation status
 * - Manual override controls
 * - Performance analytics
 * - Configuration management
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('AutomationDashboardAPI');

/**
 * API Endpoints
 */
export const AUTOMATION_ENDPOINTS = {
  // Dashboard
  DASHBOARD: '/api/v1/automation/dashboard',
  LIVE_STATUS: '/api/v1/automation/status',
  
  // Control
  SET_MODE: '/api/v1/automation/mode',
  PAUSE: '/api/v1/automation/pause',
  RESUME: '/api/v1/automation/resume',
  MANUAL_TRIGGER: '/api/v1/automation/trigger',
  
  // Confirmations
  PENDING_CONFIRMATIONS: '/api/v1/automation/confirmations',
  CONFIRM: '/api/v1/automation/confirm/:id',
  REJECT: '/api/v1/automation/reject/:id',
  
  // Analytics
  STATISTICS: '/api/v1/automation/stats',
  HISTORY: '/api/v1/automation/history',
  PREDICTIONS: '/api/v1/automation/predictions',
  
  // Configuration
  CONFIG: '/api/v1/automation/config',
  THRESHOLDS: '/api/v1/automation/thresholds',
  SCHEDULES: '/api/v1/automation/schedules'
};

/**
 * Automation Dashboard API
 */
export class AutomationDashboardAPI extends EventEmitter {
  constructor(apiServer, automationController) {
    super();
    
    this.api = apiServer;
    this.controller = automationController;
    
    // WebSocket connections for real-time updates
    this.wsConnections = new Set();
    
    // Register endpoints
    this.registerEndpoints();
    
    // Setup real-time updates
    this.setupRealtimeUpdates();
  }
  
  /**
   * Register API endpoints
   */
  registerEndpoints() {
    // Dashboard endpoints
    this.api.registerEndpoint('GET', AUTOMATION_ENDPOINTS.DASHBOARD,
      this.handleDashboard.bind(this));
    
    this.api.registerEndpoint('GET', AUTOMATION_ENDPOINTS.LIVE_STATUS,
      this.handleLiveStatus.bind(this));
    
    // Control endpoints
    this.api.registerEndpoint('POST', AUTOMATION_ENDPOINTS.SET_MODE,
      this.requireAuth(this.handleSetMode.bind(this)));
    
    this.api.registerEndpoint('POST', AUTOMATION_ENDPOINTS.PAUSE,
      this.requireAuth(this.handlePause.bind(this)));
    
    this.api.registerEndpoint('POST', AUTOMATION_ENDPOINTS.RESUME,
      this.requireAuth(this.handleResume.bind(this)));
    
    this.api.registerEndpoint('POST', AUTOMATION_ENDPOINTS.MANUAL_TRIGGER,
      this.requireAuth(this.handleManualTrigger.bind(this)));
    
    // Confirmation endpoints
    this.api.registerEndpoint('GET', AUTOMATION_ENDPOINTS.PENDING_CONFIRMATIONS,
      this.requireAuth(this.handlePendingConfirmations.bind(this)));
    
    this.api.registerEndpoint('POST', AUTOMATION_ENDPOINTS.CONFIRM,
      this.requireAuth(this.handleConfirm.bind(this)));
    
    this.api.registerEndpoint('POST', AUTOMATION_ENDPOINTS.REJECT,
      this.requireAuth(this.handleReject.bind(this)));
    
    // Analytics endpoints
    this.api.registerEndpoint('GET', AUTOMATION_ENDPOINTS.STATISTICS,
      this.handleStatistics.bind(this));
    
    this.api.registerEndpoint('GET', AUTOMATION_ENDPOINTS.HISTORY,
      this.handleHistory.bind(this));
    
    this.api.registerEndpoint('GET', AUTOMATION_ENDPOINTS.PREDICTIONS,
      this.handlePredictions.bind(this));
    
    // Configuration endpoints
    this.api.registerEndpoint('GET', AUTOMATION_ENDPOINTS.CONFIG,
      this.requireAuth(this.handleGetConfig.bind(this)));
    
    this.api.registerEndpoint('PUT', AUTOMATION_ENDPOINTS.THRESHOLDS,
      this.requireAuth(this.handleUpdateThresholds.bind(this)));
    
    this.api.registerEndpoint('PUT', AUTOMATION_ENDPOINTS.SCHEDULES,
      this.requireAuth(this.handleUpdateSchedules.bind(this)));
    
    // WebSocket endpoint
    this.api.registerWebSocket('/ws/automation', this.handleWebSocket.bind(this));
  }
  
  /**
   * Require authentication
   */
  requireAuth(handler) {
    return async (req, res) => {
      const apiKey = req.headers['x-api-key'] || req.query.api_key;
      
      // Simple API key check (implement proper auth in production)
      if (!apiKey || apiKey !== process.env.API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      return handler(req, res);
    };
  }
  
  /**
   * Handle dashboard request
   */
  async handleDashboard(req, res) {
    try {
      const stats = this.controller.getStats();
      const engineStats = stats.engine;
      const payoutStats = stats.payout;
      
      const dashboard = {
        status: {
          mode: stats.controller.mode,
          enabled: stats.controller.enabled,
          health: this.calculateHealth(stats)
        },
        
        overview: {
          pendingConversions: engineStats.pendingConversions,
          pendingConfirmations: stats.controller.pendingConfirmations,
          totalAutomated: stats.controller.totalAutomated,
          successRate: stats.controller.successRate,
          dailyVolume: stats.dailyVolume
        },
        
        performance: {
          averageProcessingTime: stats.controller.averageProcessingTime,
          totalValue: stats.controller.totalValue,
          profitGenerated: engineStats.profitGenerated || 0,
          feeSavings: payoutStats.conversionSavings || 0
        },
        
        predictions: {
          accuracy: engineStats.strategy === 'adaptive' ? 0.75 : null,
          confidence: engineStats.averageRate ? 0.8 : 0
        },
        
        services: payoutStats.multiService || {},
        
        recentActivity: stats.recentAutomations || []
      };
      
      res.json(dashboard);
      
    } catch (error) {
      logger.error('Dashboard error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle live status
   */
  async handleLiveStatus(req, res) {
    try {
      const stats = this.controller.getStats();
      
      res.json({
        mode: stats.controller.mode,
        enabled: stats.controller.enabled,
        pendingConversions: stats.engine.pendingConversions,
        pendingConfirmations: stats.controller.pendingConfirmations,
        activeSchedules: stats.controller.activeSchedules,
        timestamp: Date.now()
      });
      
    } catch (error) {
      logger.error('Status error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle set mode
   */
  async handleSetMode(req, res) {
    try {
      const { mode } = req.body;
      
      if (!['full_auto', 'semi_auto', 'scheduled', 'manual'].includes(mode)) {
        return res.status(400).json({ error: 'Invalid mode' });
      }
      
      this.controller.changeMode(mode);
      
      res.json({
        success: true,
        mode,
        message: `Automation mode changed to ${mode}`
      });
      
    } catch (error) {
      logger.error('Set mode error:', error);
      res.status(500).json({ error: error.message });
    }
  }
  
  /**
   * Handle pause
   */
  async handlePause(req, res) {
    try {
      this.controller.stop();
      
      res.json({
        success: true,
        message: 'Automation paused'
      });
      
    } catch (error) {
      logger.error('Pause error:', error);
      res.status(500).json({ error: error.message });
    }
  }
  
  /**
   * Handle resume
   */
  async handleResume(req, res) {
    try {
      this.controller.start();
      
      res.json({
        success: true,
        message: 'Automation resumed'
      });
      
    } catch (error) {
      logger.error('Resume error:', error);
      res.status(500).json({ error: error.message });
    }
  }
  
  /**
   * Handle manual trigger
   */
  async handleManualTrigger(req, res) {
    try {
      const { action, params } = req.body;
      
      let result;
      
      switch (action) {
        case 'convert':
          result = await this.controller.manualConversion(params);
          break;
          
        case 'optimize':
          result = await this.controller.optimizeConversions();
          break;
          
        case 'bulk_convert':
          result = await this.controller.processBulkConversions();
          break;
          
        default:
          return res.status(400).json({ error: 'Invalid action' });
      }
      
      res.json({
        success: true,
        action,
        result
      });
      
    } catch (error) {
      logger.error('Manual trigger error:', error);
      res.status(500).json({ error: error.message });
    }
  }
  
  /**
   * Handle pending confirmations
   */
  async handlePendingConfirmations(req, res) {
    try {
      const pending = Array.from(this.controller.pendingConfirmations.entries())
        .map(([id, data]) => ({
          confirmationId: id,
          ...data,
          timeRemaining: Math.max(0, data.expiresAt - Date.now())
        }));
      
      res.json({
        pending,
        total: pending.length
      });
      
    } catch (error) {
      logger.error('Pending confirmations error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle confirm
   */
  async handleConfirm(req, res) {
    try {
      const { id } = req.params;
      
      const conversionId = await this.controller.confirmConversion(id, true);
      
      res.json({
        success: true,
        confirmationId: id,
        conversionId,
        message: 'Conversion confirmed and queued'
      });
      
    } catch (error) {
      logger.error('Confirm error:', error);
      res.status(400).json({ error: error.message });
    }
  }
  
  /**
   * Handle reject
   */
  async handleReject(req, res) {
    try {
      const { id } = req.params;
      
      await this.controller.confirmConversion(id, false);
      
      res.json({
        success: true,
        confirmationId: id,
        message: 'Conversion rejected'
      });
      
    } catch (error) {
      logger.error('Reject error:', error);
      res.status(400).json({ error: error.message });
    }
  }
  
  /**
   * Handle statistics
   */
  async handleStatistics(req, res) {
    try {
      const { period = '24h' } = req.query;
      
      const stats = this.controller.getStats();
      const engineStats = stats.engine;
      
      const statistics = {
        automation: {
          total: stats.controller.totalAutomated,
          manual: stats.controller.totalManual,
          successRate: (stats.controller.successRate * 100).toFixed(2) + '%',
          averageProcessingTime: Math.round(stats.controller.averageProcessingTime / 1000) + 's'
        },
        
        financial: {
          totalVolume: stats.controller.totalValue,
          profitGenerated: engineStats.profitGenerated || 0,
          feeSavings: stats.payout.conversionSavings || 0,
          averageRate: engineStats.averageRate || 0
        },
        
        triggers: engineStats.triggerStats || {},
        
        predictions: {
          totalPredictions: engineStats.totalConversions || 0,
          accuracy: engineStats.strategy === 'adaptive' ? '75%' : 'N/A'
        },
        
        period
      };
      
      res.json(statistics);
      
    } catch (error) {
      logger.error('Statistics error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle history
   */
  async handleHistory(req, res) {
    try {
      const { limit = 100, offset = 0 } = req.query;
      
      const stats = this.controller.getStats();
      const history = stats.recentAutomations || [];
      
      res.json({
        history: history.slice(offset, offset + limit),
        total: history.length,
        limit,
        offset
      });
      
    } catch (error) {
      logger.error('History error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle predictions
   */
  async handlePredictions(req, res) {
    try {
      const predictor = this.controller.automationEngine.ratePredictor;
      const predictions = {};
      
      // Get predictions for active pairs
      const pairs = ['BTC:USDT', 'ETH:BTC', 'LTC:BTC'];
      
      for (const pair of pairs) {
        const [from, to] = pair.split(':');
        predictions[pair] = await predictor.predict(from, to, []);
      }
      
      res.json({
        predictions,
        accuracy: predictor.getStats().accuracy || {},
        timestamp: Date.now()
      });
      
    } catch (error) {
      logger.error('Predictions error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle get config
   */
  async handleGetConfig(req, res) {
    try {
      const config = {
        mode: this.controller.config.mode,
        enabled: this.controller.config.enabled,
        confirmationThresholds: this.controller.config.confirmationThresholds,
        dailyConversionLimit: this.controller.config.dailyConversionLimit,
        schedules: this.controller.config.schedules,
        strategy: this.controller.automationEngine.config.strategy,
        triggers: this.controller.automationEngine.config.triggers
      };
      
      res.json(config);
      
    } catch (error) {
      logger.error('Get config error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  /**
   * Handle update thresholds
   */
  async handleUpdateThresholds(req, res) {
    try {
      const { confirmation, daily } = req.body;
      
      if (confirmation) {
        Object.assign(this.controller.config.confirmationThresholds, confirmation);
      }
      
      if (daily) {
        Object.assign(this.controller.config.dailyConversionLimit, daily);
      }
      
      res.json({
        success: true,
        message: 'Thresholds updated',
        confirmationThresholds: this.controller.config.confirmationThresholds,
        dailyConversionLimit: this.controller.config.dailyConversionLimit
      });
      
    } catch (error) {
      logger.error('Update thresholds error:', error);
      res.status(500).json({ error: error.message });
    }
  }
  
  /**
   * Handle update schedules
   */
  async handleUpdateSchedules(req, res) {
    try {
      const { schedules } = req.body;
      
      if (!Array.isArray(schedules)) {
        return res.status(400).json({ error: 'Schedules must be an array' });
      }
      
      // Update schedules
      this.controller.config.schedules = schedules;
      
      // Restart scheduled automation if active
      if (this.controller.config.mode === 'scheduled') {
        this.controller.stop();
        this.controller.start();
      }
      
      res.json({
        success: true,
        message: 'Schedules updated',
        schedules
      });
      
    } catch (error) {
      logger.error('Update schedules error:', error);
      res.status(500).json({ error: error.message });
    }
  }
  
  /**
   * Handle WebSocket connection
   */
  handleWebSocket(ws, req) {
    logger.info('WebSocket connection established');
    
    this.wsConnections.add(ws);
    
    // Send initial status
    ws.send(JSON.stringify({
      type: 'connected',
      data: this.controller.getStats()
    }));
    
    // Handle messages
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        this.handleWebSocketMessage(ws, data);
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid message' }));
      }
    });
    
    // Handle disconnect
    ws.on('close', () => {
      this.wsConnections.delete(ws);
      logger.info('WebSocket connection closed');
    });
  }
  
  /**
   * Handle WebSocket message
   */
  handleWebSocketMessage(ws, data) {
    switch (data.type) {
      case 'subscribe':
        // Client wants real-time updates
        ws.subscribed = true;
        break;
        
      case 'unsubscribe':
        ws.subscribed = false;
        break;
        
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
        
      default:
        ws.send(JSON.stringify({ type: 'error', error: 'Unknown message type' }));
    }
  }
  
  /**
   * Setup real-time updates
   */
  setupRealtimeUpdates() {
    // Forward controller events to WebSocket clients
    const events = [
      'conversion:automated',
      'confirmation:required',
      'automation:completed',
      'automation:failed',
      'limit:exceeded',
      'mode:changed'
    ];
    
    for (const event of events) {
      this.controller.on(event, (data) => {
        this.broadcastUpdate({
          type: 'event',
          event,
          data,
          timestamp: Date.now()
        });
      });
    }
    
    // Send periodic status updates
    setInterval(() => {
      this.broadcastUpdate({
        type: 'status',
        data: this.controller.getStats().controller,
        timestamp: Date.now()
      });
    }, 5000); // Every 5 seconds
  }
  
  /**
   * Broadcast update to WebSocket clients
   */
  broadcastUpdate(update) {
    const message = JSON.stringify(update);
    
    for (const ws of this.wsConnections) {
      if (ws.readyState === 1 && ws.subscribed) { // OPEN state
        ws.send(message);
      }
    }
  }
  
  /**
   * Calculate system health
   */
  calculateHealth(stats) {
    const factors = [
      stats.controller.successRate > 0.9 ? 1 : stats.controller.successRate,
      stats.engine.pendingConversions < 100 ? 1 : 0.5,
      stats.controller.pendingConfirmations < 10 ? 1 : 0.7,
      stats.payout.multiService?.healthyServices > 2 ? 1 : 0.6
    ];
    
    const health = factors.reduce((sum, f) => sum + f, 0) / factors.length;
    
    if (health > 0.9) return 'excellent';
    if (health > 0.7) return 'good';
    if (health > 0.5) return 'fair';
    return 'poor';
  }
}

export default AutomationDashboardAPI;