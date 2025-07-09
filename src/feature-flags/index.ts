// src/feature-flags/index.ts
export { 
  FeatureFlagManager,
  type FeatureFlag,
  type FlagRule,
  type Condition,
  type FlagVariant,
  type RolloutConfig,
  type ScheduleConfig,
  type EvaluationContext,
  type FlagEvaluation,
  type FlagMetrics,
  type ExperimentConfig
} from './feature-flag-manager';

export { FeatureFlagAPI } from './feature-flag-api';
export { FeatureFlagUI } from './feature-flag-ui';

// Convenience factory function
import { FeatureFlagManager } from './feature-flag-manager';
import { FeatureFlagAPI } from './feature-flag-api';
import { FeatureFlagUI } from './feature-flag-ui';
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';
import express from 'express';

export interface FeatureFlagConfig {
  cacheExpiry?: number;
  refreshInterval?: number;
}

export class FeatureFlagSystem {
  public manager: FeatureFlagManager;
  public api: FeatureFlagAPI;
  public ui: FeatureFlagUI;

  constructor(
    logger: Logger, 
    cache: RedisCache, 
    config: FeatureFlagConfig = {}
  ) {
    this.manager = new FeatureFlagManager(logger, cache);
    this.api = new FeatureFlagAPI(this.manager, logger);
    this.ui = new FeatureFlagUI(this.manager, logger);
  }

  public setupRoutes(app: express.Application): void {
    // API routes
    app.use('/feature-flags/api', this.api.getRouter());
    
    // UI routes
    app.use('/feature-flags', this.ui.getRouter());
  }

  public async createBasicFlags(): Promise<void> {
    // Create some basic flags for demonstration
    await this.manager.createFlag({
      name: 'maintenance_mode',
      description: 'Enable maintenance mode to block all operations',
      type: 'kill_switch',
      enabled: false,
      rules: [],
      rollout: {
        enabled: false,
        percentage: 0,
        strategy: 'user_id'
      }
    });

    await this.manager.createFlag({
      name: 'new_dashboard',
      description: 'Show new dashboard design',
      type: 'boolean',
      enabled: false,
      rules: [],
      rollout: {
        enabled: true,
        percentage: 10,
        strategy: 'user_id'
      }
    });

    await this.manager.createFlag({
      name: 'algorithm_test',
      description: 'Test different mining algorithms',
      type: 'variant',
      enabled: true,
      rules: [],
      variants: [
        {
          id: 'sha256',
          name: 'SHA256',
          value: 'sha256',
          weight: 50,
          description: 'Standard SHA256 algorithm'
        },
        {
          id: 'scrypt',
          name: 'Scrypt',
          value: 'scrypt',
          weight: 30,
          description: 'Scrypt algorithm'
        },
        {
          id: 'x11',
          name: 'X11',
          value: 'x11',
          weight: 20,
          description: 'X11 algorithm'
        }
      ],
      rollout: {
        enabled: true,
        percentage: 25,
        strategy: 'user_id'
      }
    });
  }

  public destroy(): void {
    this.manager.destroy();
  }
}

// Helper functions for common use cases
export const createFeatureFlagDecorator = (manager: FeatureFlagManager) => {
  return (flagId: string, defaultValue: any = false) => {
    return (target: any, propertyName: string, descriptor: PropertyDescriptor) => {
      const method = descriptor.value;

      descriptor.value = async function (...args: any[]) {
        const context = this.getFeatureFlagContext?.() || {};
        const enabled = await manager.isEnabled(flagId, context);
        
        if (enabled) {
          return method.apply(this, args);
        } else {
          return defaultValue;
        }
      };
    };
  };
};

export const createVariantSelector = (manager: FeatureFlagManager) => {
  return async (flagId: string, context: any = {}) => {
    const evaluation = await manager.evaluateFlag(flagId, context);
    return evaluation.value || evaluation.variant;
  };
};

// Middleware for Express
export const featureFlagMiddleware = (manager: FeatureFlagManager) => {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Add feature flag helpers to request object
    (req as any).featureFlags = {
      isEnabled: async (flagId: string, context: any = {}) => {
        const mergedContext = {
          userId: req.headers['x-user-id'] as string,
          sessionId: req.headers['x-session-id'] as string,
          userAgent: req.headers['user-agent'],
          ip: req.ip,
          ...context
        };
        return manager.isEnabled(flagId, mergedContext);
      },
      
      getValue: async (flagId: string, defaultValue: any = false, context: any = {}) => {
        const mergedContext = {
          userId: req.headers['x-user-id'] as string,
          sessionId: req.headers['x-session-id'] as string,
          userAgent: req.headers['user-agent'],
          ip: req.ip,
          ...context
        };
        return manager.getValue(flagId, mergedContext, defaultValue);
      },
      
      getVariant: async (flagId: string, context: any = {}) => {
        const mergedContext = {
          userId: req.headers['x-user-id'] as string,
          sessionId: req.headers['x-session-id'] as string,
          userAgent: req.headers['user-agent'],
          ip: req.ip,
          ...context
        };
        return manager.getVariant(flagId, mergedContext);
      }
    };

    next();
  };
};

// Type extensions for Express
declare global {
  namespace Express {
    interface Request {
      featureFlags?: {
        isEnabled(flagId: string, context?: any): Promise<boolean>;
        getValue(flagId: string, defaultValue?: any, context?: any): Promise<any>;
        getVariant(flagId: string, context?: any): Promise<string | undefined>;
      };
    }
  }
}

export default FeatureFlagSystem;
