import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../core/logger.js';
import { agentManager } from '../agents/agent-manager.js';
import { agentEventBus } from '../agents/event-bus.js';
import { agentMetricsCollector } from './agent-metrics-collector.js';
import { agentLogAnalyzer } from './agent-log-analyzer.js';
import { agentReportGenerator } from './agent-report-generator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Real-time Agent Dashboard Server
 * Provides web-based monitoring interface for agent system
 */
export class AgentDashboard {
  constructor(options = {}) {
    this.port = options.port || 8084;
    this.app = express();
    this.server = createServer(this.app);
    this.io = new Server(this.server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });
    
    this.connectedClients = new Set();
    this.updateInterval = options.updateInterval || 1000;
    this.metricsHistory = {
      agents: new Map(),
      system: [],
      events: []
    };
    this.maxHistoryLength = 100;
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupSocketHandlers();
    this.setupAgentListeners();
    
    // Start metrics collection and analysis
    agentMetricsCollector.startCollection();
    agentLogAnalyzer.startAnalysis();
    agentReportGenerator.startAutoGeneration();
  }

  setupMiddleware() {
    this.app.use(express.static(path.join(__dirname, 'dashboard-public')));
    this.app.use(express.json());
  }

  setupRoutes() {
    // Serve dashboard HTML
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard-public', 'index.html'));
    });

    // API endpoints
    this.app.get('/api/agents', (req, res) => {
      const agents = agentManager.getAllAgents().map(agent => ({
        name: agent.name,
        type: agent.type,
        status: agent.getStatus(),
        metrics: this.getAgentMetrics(agent.name)
      }));
      
      res.json({ agents });
    });

    this.app.get('/api/agents/:name', (req, res) => {
      const agent = agentManager.getAgent(req.params.name);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      
      res.json({
        agent: agent.getStatus(),
        metrics: this.getAgentMetrics(req.params.name),
        history: this.metricsHistory.agents.get(req.params.name) || []
      });
    });

    this.app.get('/api/system', (req, res) => {
      res.json({
        agentManager: {
          initialized: agentManager.initialized,
          agentCount: agentManager.agents.size,
          coordinationRules: agentManager.coordinationRules.length
        },
        eventBus: agentEventBus.getStats(),
        systemMetrics: this.getSystemMetrics()
      });
    });

    this.app.get('/api/events', (req, res) => {
      const limit = parseInt(req.query.limit) || 50;
      const events = this.metricsHistory.events.slice(-limit);
      res.json({ events });
    });

    this.app.get('/api/metrics/report', (req, res) => {
      const timeRange = parseInt(req.query.timeRange) || 3600000; // 1 hour
      const format = req.query.format || 'json';
      
      try {
        const report = agentMetricsCollector.generateReport({ timeRange });
        
        if (format === 'json') {
          res.json(report);
        } else {
          const exported = agentMetricsCollector.exportMetrics(format, { timeRange });
          res.type(format === 'csv' ? 'text/csv' : 'text/plain');
          res.send(exported);
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/metrics/stats', (req, res) => {
      res.json({
        collector: agentMetricsCollector.getStats(),
        analyzer: agentLogAnalyzer.getAnalysisStats(),
        reportGenerator: agentReportGenerator.getGenerationStats(),
        dashboard: this.getStats()
      });
    });

    this.app.get('/api/analysis/report', (req, res) => {
      const timeRange = parseInt(req.query.timeRange) || 86400000;
      const format = req.query.format || 'json';
      
      try {
        const report = agentLogAnalyzer.generateReport({ timeRange, includeDetails: true });
        
        if (format === 'json') {
          res.json(report);
        } else {
          const exported = agentLogAnalyzer.exportAnalysis(format, { timeRange });
          res.type(format === 'csv' ? 'text/csv' : 'text/plain');
          res.send(exported);
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/reports/generate', async (req, res) => {
      try {
        const options = {
          type: req.body.type || 'comprehensive',
          timeRange: parseInt(req.body.timeRange) || 86400000,
          format: req.body.format || 'html',
          includeCharts: req.body.includeCharts || false,
          includeRecommendations: req.body.includeRecommendations !== false
        };
        
        const report = await agentReportGenerator.generateReport(options);
        
        if (req.body.save) {
          const filename = `adhoc_report_${Date.now()}.${options.format}`;
          const filepath = await agentReportGenerator.saveReport(report, filename);
          res.json({ 
            success: true, 
            filepath,
            filename,
            metadata: report.metadata 
          });
        } else {
          res.type(options.format === 'html' ? 'text/html' : 
                  options.format === 'csv' ? 'text/csv' : 'application/json');
          res.send(report.content);
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/reports/history', async (req, res) => {
      try {
        const type = req.query.type;
        const limit = parseInt(req.query.limit) || 10;
        
        const history = await agentReportGenerator.getReportHistory(type, limit);
        res.json({ history });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/agents/:name/action', async (req, res) => {
      const { action } = req.body;
      const agent = agentManager.getAgent(req.params.name);
      
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      try {
        let result;
        switch (action) {
          case 'start':
            agent.start();
            result = { status: 'started' };
            break;
          case 'stop':
            agent.stop();
            result = { status: 'stopped' };
            break;
          case 'execute':
            result = await agent.execute();
            break;
          default:
            return res.status(400).json({ error: 'Invalid action' });
        }
        
        res.json({ success: true, result });
      } catch (error) {
        logger.error(`Dashboard action error:`, error);
        res.status(500).json({ error: error.message });
      }
    });
  }

  setupSocketHandlers() {
    this.io.on('connection', (socket) => {
      this.connectedClients.add(socket);
      logger.info(`Dashboard client connected: ${socket.id}`);
      
      // Send initial data
      socket.emit('initial-data', {
        agents: this.getAgentsOverview(),
        system: this.getSystemMetrics(),
        eventBusStats: agentEventBus.getStats()
      });

      socket.on('request-agent-details', (agentName) => {
        const agent = agentManager.getAgent(agentName);
        if (agent) {
          socket.emit('agent-details', {
            agent: agent.getStatus(),
            metrics: this.getAgentMetrics(agentName),
            history: this.metricsHistory.agents.get(agentName) || []
          });
        }
      });

      socket.on('disconnect', () => {
        this.connectedClients.delete(socket);
        logger.info(`Dashboard client disconnected: ${socket.id}`);
      });
    });
  }

  setupAgentListeners() {
    // Listen to agent manager events
    agentManager.on('agent:execute:start', (agent) => {
      this.broadcastEvent({
        type: 'agent-execution-start',
        agent: agent.name,
        timestamp: Date.now()
      });
    });

    agentManager.on('agent:execute:success', (data) => {
      this.broadcastEvent({
        type: 'agent-execution-success',
        agent: data.agent.name,
        result: data.result,
        timestamp: Date.now()
      });
      
      this.updateAgentMetrics(data.agent.name, data.result);
    });

    agentManager.on('agent:execute:error', (data) => {
      this.broadcastEvent({
        type: 'agent-execution-error',
        agent: data.agent.name,
        error: data.error.message,
        timestamp: Date.now()
      });
    });

    agentManager.on('alert', (alertData) => {
      this.broadcastEvent({
        type: 'agent-alert',
        agent: alertData.agent,
        alert: alertData.alert,
        timestamp: Date.now()
      });
    });

    // Listen to event bus
    agentEventBus.on('message-processed', (data) => {
      this.broadcastEvent({
        type: 'event-bus-message',
        messageType: data.type,
        source: data.source,
        targets: data.targets,
        timestamp: Date.now()
      });
    });
  }

  getAgentsOverview() {
    return agentManager.getAllAgents().map(agent => ({
      name: agent.name,
      type: agent.type,
      state: agent.state,
      enabled: agent.enabled,
      runCount: agent.runCount,
      lastRun: agent.lastRun,
      metrics: {
        successCount: agent.metrics.successCount,
        failureCount: agent.metrics.failureCount,
        averageExecutionTime: agent.metrics.averageExecutionTime
      }
    }));
  }

  getSystemMetrics() {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    return {
      memory: {
        used: memUsage.heapUsed,
        total: memUsage.heapTotal,
        external: memUsage.external,
        rss: memUsage.rss
      },
      cpu: {
        user: cpuUsage.user,
        system: cpuUsage.system
      },
      uptime: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform,
      timestamp: Date.now()
    };
  }

  getAgentMetrics(agentName) {
    const agent = agentManager.getAgent(agentName);
    if (!agent) return null;

    return {
      performance: {
        successCount: agent.metrics.successCount,
        failureCount: agent.metrics.failureCount,
        totalExecutionTime: agent.metrics.totalExecutionTime,
        averageExecutionTime: agent.metrics.averageExecutionTime
      },
      status: {
        state: agent.state,
        enabled: agent.enabled,
        runCount: agent.runCount,
        lastRun: agent.lastRun,
        errorCount: agent.errors.length
      },
      dependencies: Object.keys(agent.dependencies || {}),
      context: agent.getContext ? agent.getContext() : {}
    };
  }

  updateAgentMetrics(agentName, executionResult) {
    if (!this.metricsHistory.agents.has(agentName)) {
      this.metricsHistory.agents.set(agentName, []);
    }
    
    const history = this.metricsHistory.agents.get(agentName);
    const agent = agentManager.getAgent(agentName);
    
    if (agent) {
      history.push({
        timestamp: Date.now(),
        executionTime: agent.lastExecutionTime || 0,
        result: executionResult,
        metrics: { ...agent.metrics }
      });
      
      // Keep only recent history
      if (history.length > this.maxHistoryLength) {
        history.splice(0, history.length - this.maxHistoryLength);
      }
    }
  }

  broadcastEvent(event) {
    // Add to event history
    this.metricsHistory.events.push(event);
    if (this.metricsHistory.events.length > this.maxHistoryLength) {
      this.metricsHistory.events.splice(0, this.metricsHistory.events.length - this.maxHistoryLength);
    }
    
    // Broadcast to all connected clients
    this.io.emit('agent-event', event);
  }

  startPeriodicUpdates() {
    this.updateTimer = setInterval(() => {
      if (this.connectedClients.size > 0) {
        // Broadcast system metrics
        this.io.emit('system-update', {
          system: this.getSystemMetrics(),
          agents: this.getAgentsOverview(),
          eventBusStats: agentEventBus.getStats()
        });
      }
    }, this.updateInterval);
  }

  stopPeriodicUpdates() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, (err) => {
        if (err) {
          logger.error(`Failed to start agent dashboard:`, err);
          reject(err);
        } else {
          logger.info(`Agent dashboard started on port ${this.port}`);
          logger.info(`Dashboard URL: http://localhost:${this.port}`);
          this.startPeriodicUpdates();
          resolve();
        }
      });
    });
  }

  async stop() {
    this.stopPeriodicUpdates();
    agentMetricsCollector.stopCollection();
    agentLogAnalyzer.stopAnalysis();
    agentReportGenerator.stopAutoGeneration();
    
    return new Promise((resolve) => {
      this.server.close(() => {
        logger.info('Agent dashboard stopped');
        resolve();
      });
    });
  }

  getStats() {
    return {
      connectedClients: this.connectedClients.size,
      port: this.port,
      metricsHistorySize: {
        agents: Array.from(this.metricsHistory.agents.values()).reduce((sum, hist) => sum + hist.length, 0),
        events: this.metricsHistory.events.length
      }
    };
  }
}

// Export singleton instance
export const agentDashboard = new AgentDashboard();