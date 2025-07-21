/**
 * Versioned Routes Handler for Otedama
 * Manages route registration and versioning
 * 
 * Design principles:
 * - Carmack: Fast route resolution
 * - Martin: Clean route organization
 * - Pike: Simple versioning logic
 */

import express from 'express';
import { ApiVersionManager } from './versioning.js';
import { createOtedamaAdapters } from './version-adapter.js';
import { logger } from '../core/logger.js';

/**
 * Versioned router wrapper
 */
export class VersionedRouter {
  constructor(versionManager, adapterRegistry) {
    this.versionManager = versionManager;
    this.adapterRegistry = adapterRegistry;
    this.routes = new Map();
  }
  
  /**
   * Register a versioned route
   */
  route(method, path, versions, handler) {
    const key = `${method.toUpperCase()}:${path}`;
    
    if (!this.routes.has(key)) {
      this.routes.set(key, new Map());
    }
    
    const routeVersions = this.routes.get(key);
    
    // Register handler for each version
    for (const version of versions) {
      routeVersions.set(version, handler);
      
      // Register with version manager
      const apiVersion = this.versionManager.versions.get(version);
      if (apiVersion) {
        apiVersion.addHandler(method, path, handler);
      }
    }
  }
  
  /**
   * Create Express router with version handling
   */
  createRouter() {
    const router = express.Router();
    
    // Add version middleware
    router.use(this.versionManager.middleware());
    
    // Create route handlers
    for (const [routeKey, versions] of this.routes) {
      const [method, path] = routeKey.split(':');
      
      // Create unified handler
      const handler = this._createVersionedHandler(method, path, versions);
      
      // Register with Express
      const expressMethod = method.toLowerCase();
      if (router[expressMethod]) {
        router[expressMethod](path, handler);
      }
    }
    
    return router;
  }
  
  /**
   * Create handler that manages version routing
   */
  _createVersionedHandler(method, path, versions) {
    return async (req, res, next) => {
      try {
        const requestedVersion = req.apiVersion;
        
        // Find handler for requested version
        let handler = versions.get(requestedVersion);
        let actualVersion = requestedVersion;
        
        // If no exact match, try to find compatible version
        if (!handler && this.versionManager.options.enableVersionNegotiation) {
          const availableVersions = Array.from(versions.keys());
          const negotiatedVersion = this.versionManager.negotiateVersion(
            requestedVersion,
            availableVersions
          );
          
          if (negotiatedVersion) {
            handler = versions.get(negotiatedVersion);
            actualVersion = negotiatedVersion;
          }
        }
        
        if (!handler) {
          return res.status(404).json({
            error: 'Endpoint not available in requested version',
            requested: requestedVersion,
            available: Array.from(versions.keys())
          });
        }
        
        // Apply request transformation if needed
        if (actualVersion !== requestedVersion) {
          const adapter = this.adapterRegistry.getAdapter(requestedVersion, actualVersion);
          if (adapter) {
            req = adapter.transformRequest(path, req);
          }
        }
        
        // Wrap response to apply transformation
        if (actualVersion !== requestedVersion) {
          const originalJson = res.json.bind(res);
          res.json = (data) => {
            const adapter = this.adapterRegistry.getAdapter(actualVersion, requestedVersion);
            if (adapter) {
              data = adapter.transformResponse(path, data);
            }
            return originalJson(data);
          };
        }
        
        // Call the handler
        handler(req, res, next);
        
      } catch (error) {
        logger.error('Version routing error', {
          method,
          path,
          version: req.apiVersion,
          error: error.message
        });
        next(error);
      }
    };
  }
}

/**
 * Create versioned API routes
 */
export function createVersionedApi(options = {}) {
  // Initialize version manager
  const versionManager = new ApiVersionManager({
    strategy: options.strategy || 'url_path',
    defaultVersion: options.defaultVersion || '1',
    ...options
  });
  
  // Register API versions
  versionManager.registerVersion('1', {
    status: 'deprecated',
    deprecatedAt: new Date('2024-06-01'),
    sunsetAt: new Date('2025-01-01'),
    changes: [
      'Initial API version',
      'Basic authentication',
      'Offset-based pagination'
    ]
  });
  
  versionManager.registerVersion('2', {
    status: 'current',
    changes: [
      'Improved authentication with JWT',
      'Page-based pagination',
      'Standardized error format',
      'Added rate limiting',
      'WebSocket support for real-time updates'
    ]
  });
  
  versionManager.registerVersion('3', {
    status: 'beta',
    changes: [
      'GraphQL support',
      'Enhanced filtering and sorting',
      'Batch operations',
      'Webhook support'
    ]
  });
  
  // Create adapter registry
  const adapterRegistry = createOtedamaAdapters();
  
  // Create versioned router
  const versionedRouter = new VersionedRouter(versionManager, adapterRegistry);
  
  return {
    versionManager,
    adapterRegistry,
    versionedRouter,
    router: versionedRouter.createRouter()
  };
}

/**
 * Helper to define versioned routes
 */
export class VersionedRouteBuilder {
  constructor(versionedRouter) {
    this.versionedRouter = versionedRouter;
    this.currentVersions = ['2']; // Default to current version
  }
  
  /**
   * Set versions for subsequent routes
   */
  versions(...versions) {
    this.currentVersions = versions;
    return this;
  }
  
  /**
   * Define GET route
   */
  get(path, handler) {
    this.versionedRouter.route('GET', path, this.currentVersions, handler);
    return this;
  }
  
  /**
   * Define POST route
   */
  post(path, handler) {
    this.versionedRouter.route('POST', path, this.currentVersions, handler);
    return this;
  }
  
  /**
   * Define PUT route
   */
  put(path, handler) {
    this.versionedRouter.route('PUT', path, this.currentVersions, handler);
    return this;
  }
  
  /**
   * Define PATCH route
   */
  patch(path, handler) {
    this.versionedRouter.route('PATCH', path, this.currentVersions, handler);
    return this;
  }
  
  /**
   * Define DELETE route
   */
  delete(path, handler) {
    this.versionedRouter.route('DELETE', path, this.currentVersions, handler);
    return this;
  }
  
  /**
   * Define route for all methods
   */
  all(path, handler) {
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    for (const method of methods) {
      this.versionedRouter.route(method, path, this.currentVersions, handler);
    }
    return this;
  }
}

/**
 * Version discovery endpoint
 */
export function createVersionDiscoveryRoute(versionManager) {
  return (req, res) => {
    const versions = Array.from(versionManager.versions.entries()).map(([version, apiVersion]) => ({
      version,
      status: apiVersion.status,
      current: apiVersion.isCurrent(),
      deprecated: apiVersion.isDeprecated(),
      deprecatedAt: apiVersion.deprecatedAt,
      sunsetAt: apiVersion.sunsetAt,
      changes: apiVersion.changes,
      endpoints: {
        base: `/api/v${version}`,
        docs: `/api/v${version}/docs`,
        schema: `/api/v${version}/schema`
      }
    }));
    
    res.json({
      current: versionManager.currentVersion,
      supported: versionManager.getSupportedVersions(),
      versions,
      deprecationPolicy: {
        warningDays: versionManager.options.deprecationWarningDays,
        sunsetGraceDays: versionManager.options.sunsetGraceDays
      }
    });
  };
}

/**
 * Deprecation information endpoint
 */
export function createDeprecationRoute(versionManager) {
  return (req, res) => {
    const deprecatedVersions = Array.from(versionManager.versions.entries())
      .filter(([_, apiVersion]) => apiVersion.isDeprecated())
      .map(([version, apiVersion]) => ({
        version,
        deprecatedAt: apiVersion.deprecatedAt,
        sunsetAt: apiVersion.sunsetAt,
        daysUntilSunset: apiVersion.sunsetAt ? 
          Math.ceil((apiVersion.sunsetAt - Date.now()) / (1000 * 60 * 60 * 24)) : null,
        migrationGuide: `/api/migration/v${version}-to-v${versionManager.currentVersion}`
      }));
    
    res.json({
      deprecated: deprecatedVersions,
      migrationResources: {
        documentation: '/api/docs/migration',
        examples: '/api/examples/migration',
        support: 'support@otedama.io'
      }
    });
  };
}

export default createVersionedApi;