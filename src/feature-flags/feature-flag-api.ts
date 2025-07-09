// src/feature-flags/feature-flag-api.ts
import express from 'express';
import { FeatureFlagManager, FeatureFlag, EvaluationContext } from './feature-flag-manager';
import { Logger } from '../logging/logger';

export class FeatureFlagAPI {
  private router: express.Router;
  private flagManager: FeatureFlagManager;
  private logger: Logger;

  constructor(flagManager: FeatureFlagManager, logger: Logger) {
    this.router = express.Router();
    this.flagManager = flagManager;
    this.logger = logger;
    
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Flag evaluation endpoints
    this.router.get('/evaluate/:flagId', async (req, res) => {
      try {
        const { flagId } = req.params;
        const context = this.extractContext(req);
        
        const evaluation = await this.flagManager.evaluateFlag(flagId, context);
        
        res.json({
          success: true,
          data: evaluation
        });
      } catch (error) {
        this.logger.error('Flag evaluation error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to evaluate flag'
        });
      }
    });

    this.router.post('/evaluate', async (req, res) => {
      try {
        const { flags, context } = req.body;
        
        if (!Array.isArray(flags)) {
          return res.status(400).json({
            success: false,
            error: 'flags must be an array'
          });
        }

        const evaluations: any[] = [];
        
        for (const flagId of flags) {
          const evaluation = await this.flagManager.evaluateFlag(flagId, context || {});
          evaluations.push(evaluation);
        }
        
        res.json({
          success: true,
          data: evaluations
        });
      } catch (error) {
        this.logger.error('Bulk flag evaluation error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to evaluate flags'
        });
      }
    });

    // Convenience endpoints
    this.router.get('/enabled/:flagId', async (req, res) => {
      try {
        const { flagId } = req.params;
        const context = this.extractContext(req);
        
        const enabled = await this.flagManager.isEnabled(flagId, context);
        
        res.json({
          success: true,
          data: { enabled }
        });
      } catch (error) {
        this.logger.error('Flag enabled check error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to check flag status'
        });
      }
    });

    this.router.get('/variant/:flagId', async (req, res) => {
      try {
        const { flagId } = req.params;
        const context = this.extractContext(req);
        
        const variant = await this.flagManager.getVariant(flagId, context);
        
        res.json({
          success: true,
          data: { variant }
        });
      } catch (error) {
        this.logger.error('Flag variant error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get flag variant'
        });
      }
    });

    this.router.get('/value/:flagId', async (req, res) => {
      try {
        const { flagId } = req.params;
        const context = this.extractContext(req);
        const defaultValue = req.query.default;
        
        const value = await this.flagManager.getValue(flagId, context, defaultValue);
        
        res.json({
          success: true,
          data: { value }
        });
      } catch (error) {
        this.logger.error('Flag value error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get flag value'
        });
      }
    });

    // Admin endpoints
    this.router.get('/admin/flags', (req, res) => {
      try {
        const flags = this.flagManager.getAllFlags();
        res.json({
          success: true,
          data: flags
        });
      } catch (error) {
        this.logger.error('Get flags error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get flags'
        });
      }
    });

    this.router.get('/admin/flags/:flagId', (req, res) => {
      try {
        const { flagId } = req.params;
        const flag = this.flagManager.getFlag(flagId);
        
        if (!flag) {
          return res.status(404).json({
            success: false,
            error: 'Flag not found'
          });
        }
        
        res.json({
          success: true,
          data: flag
        });
      } catch (error) {
        this.logger.error('Get flag error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get flag'
        });
      }
    });

    this.router.post('/admin/flags', async (req, res) => {
      try {
        const flagData = req.body;
        
        // Validate required fields
        if (!flagData.name || !flagData.type) {
          return res.status(400).json({
            success: false,
            error: 'Name and type are required'
          });
        }

        const flag = await this.flagManager.createFlag(flagData);
        
        res.status(201).json({
          success: true,
          data: flag
        });
      } catch (error) {
        this.logger.error('Create flag error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to create flag'
        });
      }
    });

    this.router.put('/admin/flags/:flagId', async (req, res) => {
      try {
        const { flagId } = req.params;
        const updates = req.body;
        
        const flag = await this.flagManager.updateFlag(flagId, updates);
        
        res.json({
          success: true,
          data: flag
        });
      } catch (error) {
        this.logger.error('Update flag error:', error);
        
        if (error.message.includes('not found')) {
          res.status(404).json({
            success: false,
            error: error.message
          });
        } else {
          res.status(500).json({
            success: false,
            error: 'Failed to update flag'
          });
        }
      }
    });

    this.router.delete('/admin/flags/:flagId', async (req, res) => {
      try {
        const { flagId } = req.params;
        
        await this.flagManager.deleteFlag(flagId);
        
        res.json({
          success: true,
          data: { deleted: true }
        });
      } catch (error) {
        this.logger.error('Delete flag error:', error);
        
        if (error.message.includes('not found')) {
          res.status(404).json({
            success: false,
            error: error.message
          });
        } else {
          res.status(500).json({
            success: false,
            error: 'Failed to delete flag'
          });
        }
      }
    });

    // Flag control endpoints
    this.router.post('/admin/flags/:flagId/enable', async (req, res) => {
      try {
        const { flagId } = req.params;
        await this.flagManager.enableFlag(flagId);
        
        res.json({
          success: true,
          data: { enabled: true }
        });
      } catch (error) {
        this.logger.error('Enable flag error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to enable flag'
        });
      }
    });

    this.router.post('/admin/flags/:flagId/disable', async (req, res) => {
      try {
        const { flagId } = req.params;
        await this.flagManager.disableFlag(flagId);
        
        res.json({
          success: true,
          data: { enabled: false }
        });
      } catch (error) {
        this.logger.error('Disable flag error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to disable flag'
        });
      }
    });

    this.router.post('/admin/flags/:flagId/rollout', async (req, res) => {
      try {
        const { flagId } = req.params;
        const { percentage } = req.body;
        
        if (typeof percentage !== 'number' || percentage < 0 || percentage > 100) {
          return res.status(400).json({
            success: false,
            error: 'Percentage must be a number between 0 and 100'
          });
        }
        
        await this.flagManager.setRolloutPercentage(flagId, percentage);
        
        res.json({
          success: true,
          data: { percentage }
        });
      } catch (error) {
        this.logger.error('Set rollout error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to set rollout percentage'
        });
      }
    });

    // Metrics endpoints
    this.router.get('/admin/metrics/:flagId', (req, res) => {
      try {
        const { flagId } = req.params;
        const metrics = this.flagManager.getMetrics(flagId);
        
        if (!metrics) {
          return res.status(404).json({
            success: false,
            error: 'Metrics not found'
          });
        }
        
        res.json({
          success: true,
          data: metrics
        });
      } catch (error) {
        this.logger.error('Get metrics error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get metrics'
        });
      }
    });

    this.router.get('/admin/metrics', (req, res) => {
      try {
        const allMetrics = this.flagManager.getAllMetrics();
        const metricsArray = Array.from(allMetrics.values());
        
        res.json({
          success: true,
          data: metricsArray
        });
      } catch (error) {
        this.logger.error('Get all metrics error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get metrics'
        });
      }
    });

    // Summary endpoint
    this.router.get('/admin/summary', (req, res) => {
      try {
        const summary = this.flagManager.getFlagSummary();
        
        res.json({
          success: true,
          data: summary
        });
      } catch (error) {
        this.logger.error('Get summary error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get summary'
        });
      }
    });

    // Health check
    this.router.get('/health', (req, res) => {
      res.json({
        success: true,
        data: {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          flags: this.flagManager.getAllFlags().length
        }
      });
    });
  }

  private extractContext(req: express.Request): EvaluationContext {
    const context: EvaluationContext = {};

    // Extract from headers
    if (req.headers['x-user-id']) {
      context.userId = req.headers['x-user-id'] as string;
    }
    
    if (req.headers['x-session-id']) {
      context.sessionId = req.headers['x-session-id'] as string;
    }

    if (req.headers['x-user-email']) {
      context.email = req.headers['x-user-email'] as string;
    }

    if (req.headers['x-user-role']) {
      context.role = req.headers['x-user-role'] as string;
    }

    if (req.headers['x-environment']) {
      context.environment = req.headers['x-environment'] as string;
    }

    // Extract from query parameters
    if (req.query.userId) {
      context.userId = req.query.userId as string;
    }

    if (req.query.sessionId) {
      context.sessionId = req.query.sessionId as string;
    }

    // Extract standard request info
    context.userAgent = req.headers['user-agent'];
    context.ip = req.ip || req.connection.remoteAddress;

    // Extract from custom attributes in query
    if (req.query.attributes) {
      try {
        const attributes = JSON.parse(req.query.attributes as string);
        context.customAttributes = attributes;
      } catch (error) {
        // Ignore invalid JSON
      }
    }

    return context;
  }

  public getRouter(): express.Router {
    return this.router;
  }
}
