/**
 * API Versioning System for Otedama
 * Provides flexible versioning strategies for backward compatibility
 * 
 * Design principles:
 * - Carmack: Fast version resolution, minimal overhead
 * - Martin: Clean separation of versioning concerns
 * - Pike: Simple and predictable versioning behavior
 */

import { EventEmitter } from 'events';
import { logger } from '../core/logger.js';
import semver from 'semver';

// Versioning strategies
export const VersionStrategy = {
  URL_PATH: 'url_path',      // /api/v1/resource
  HEADER: 'header',          // X-API-Version: 1.0
  QUERY_PARAM: 'query_param', // /api/resource?version=1
  ACCEPT_HEADER: 'accept_header' // Accept: application/vnd.api+json;version=1
};

// Version status
export const VersionStatus = {
  CURRENT: 'current',
  SUPPORTED: 'supported',
  DEPRECATED: 'deprecated',
  SUNSET: 'sunset',
  UNSUPPORTED: 'unsupported'
};

/**
 * API Version definition
 */
export class ApiVersion {
  constructor(version, options = {}) {
    this.version = version;
    this.semver = semver.coerce(version) || semver.parse('1.0.0');
    this.status = options.status || VersionStatus.CURRENT;
    this.deprecatedAt = options.deprecatedAt;
    this.sunsetAt = options.sunsetAt;
    this.changes = options.changes || [];
    this.handlers = new Map();
    this.middleware = [];
  }
  
  isSupported() {
    return this.status !== VersionStatus.UNSUPPORTED;
  }
  
  isDeprecated() {
    return this.status === VersionStatus.DEPRECATED || 
           this.status === VersionStatus.SUNSET;
  }
  
  isCurrent() {
    return this.status === VersionStatus.CURRENT;
  }
  
  addHandler(method, path, handler) {
    const key = `${method.toUpperCase()}:${path}`;
    this.handlers.set(key, handler);
  }
  
  getHandler(method, path) {
    const key = `${method.toUpperCase()}:${path}`;
    return this.handlers.get(key);
  }
  
  addMiddleware(middleware) {
    this.middleware.push(middleware);
  }
}

/**
 * API Versioning Manager
 */
export class ApiVersionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      strategy: options.strategy || VersionStrategy.URL_PATH,
      defaultVersion: options.defaultVersion || '1',
      headerName: options.headerName || 'X-API-Version',
      queryParam: options.queryParam || 'version',
      acceptPattern: options.acceptPattern || /version=(\d+(?:\.\d+)?)/,
      pathPattern: options.pathPattern || /^\/api\/v(\d+(?:\.\d+)?)/,
      
      // Version lifecycle
      deprecationWarningDays: options.deprecationWarningDays || 90,
      sunsetGraceDays: options.sunsetGraceDays || 30,
      
      // Features
      enableVersionNegotiation: options.enableVersionNegotiation !== false,
      enableDeprecationHeaders: options.enableDeprecationHeaders !== false,
      enableVersionDiscovery: options.enableVersionDiscovery !== false,
      
      ...options
    };
    
    // Version registry
    this.versions = new Map();
    this.currentVersion = null;
    
    // Metrics
    this.metrics = {
      requests: new Map(),
      deprecatedRequests: new Map(),
      versionMisses: 0,
      negotiatedRequests: 0
    };
  }
  
  /**
   * Register a new API version
   */
  registerVersion(version, options = {}) {
    const apiVersion = new ApiVersion(version, options);
    
    this.versions.set(version, apiVersion);
    
    // Update current version
    if (apiVersion.isCurrent() || !this.currentVersion) {
      this.currentVersion = version;
    }
    
    // Sort versions for negotiation
    this._sortVersions();
    
    logger.info(`Registered API version ${version}`, {
      status: apiVersion.status,
      deprecatedAt: apiVersion.deprecatedAt,
      sunsetAt: apiVersion.sunsetAt
    });
    
    this.emit('version:registered', apiVersion);
    
    return apiVersion;
  }
  
  /**
   * Get API version from request
   */
  getRequestVersion(req) {
    let version = null;
    
    switch (this.options.strategy) {
      case VersionStrategy.URL_PATH:
        const pathMatch = req.path.match(this.options.pathPattern);
        if (pathMatch) {
          version = pathMatch[1];
        }
        break;
        
      case VersionStrategy.HEADER:
        version = req.headers[this.options.headerName.toLowerCase()];
        break;
        
      case VersionStrategy.QUERY_PARAM:
        version = req.query[this.options.queryParam];
        break;
        
      case VersionStrategy.ACCEPT_HEADER:
        const accept = req.headers.accept || '';
        const acceptMatch = accept.match(this.options.acceptPattern);
        if (acceptMatch) {
          version = acceptMatch[1];
        }
        break;
    }
    
    // Default to current version if not specified
    if (!version) {
      version = this.options.defaultVersion;
    }
    
    // Normalize version
    version = this._normalizeVersion(version);
    
    // Track metrics
    this._trackRequest(version);
    
    return version;
  }
  
  /**
   * Version negotiation
   */
  negotiateVersion(requestedVersion, acceptableVersions = null) {
    // Check if exact version exists
    if (this.versions.has(requestedVersion)) {
      const version = this.versions.get(requestedVersion);
      if (version.isSupported()) {
        return requestedVersion;
      }
    }
    
    // Try to find compatible version
    if (this.options.enableVersionNegotiation) {
      const requested = semver.coerce(requestedVersion);
      if (!requested) return null;
      
      // Get acceptable versions
      const candidates = acceptableVersions || 
        Array.from(this.versions.keys()).filter(v => {
          const ver = this.versions.get(v);
          return ver.isSupported();
        });
      
      // Find best match
      let bestMatch = null;
      let bestScore = -1;
      
      for (const candidate of candidates) {
        const candidateSemver = semver.coerce(candidate);
        if (!candidateSemver) continue;
        
        // Check compatibility
        if (semver.major(candidateSemver) === semver.major(requested)) {
          // Same major version - check if candidate satisfies request
          if (semver.gte(candidateSemver, requested)) {
            const score = this._calculateVersionScore(requested, candidateSemver);
            if (score > bestScore) {
              bestScore = score;
              bestMatch = candidate;
            }
          }
        }
      }
      
      if (bestMatch) {
        this.metrics.negotiatedRequests++;
        return bestMatch;
      }
    }
    
    return null;
  }
  
  /**
   * Middleware factory
   */
  middleware() {
    return (req, res, next) => {
      // Get requested version
      const requestedVersion = this.getRequestVersion(req);
      const version = this.negotiateVersion(requestedVersion);
      
      if (!version) {
        this.metrics.versionMisses++;
        return res.status(400).json({
          error: 'Unsupported API version',
          requested: requestedVersion,
          supported: this.getSupportedVersions(),
          current: this.currentVersion
        });
      }
      
      // Attach version info to request
      req.apiVersion = version;
      req.apiVersionObject = this.versions.get(version);
      
      // Add deprecation headers if needed
      if (this.options.enableDeprecationHeaders) {
        this._addDeprecationHeaders(res, req.apiVersionObject);
      }
      
      // Add version headers
      res.setHeader('X-API-Version', version);
      
      if (this.options.enableVersionDiscovery) {
        res.setHeader('X-API-Versions', this.getSupportedVersions().join(', '));
      }
      
      next();
    };
  }
  
  /**
   * Version-specific route handler
   */
  versionedRoute(versions, handler) {
    return (req, res, next) => {
      const version = req.apiVersion || this.getRequestVersion(req);
      
      // Check if version is in allowed list
      if (versions && !versions.includes(version)) {
        return res.status(404).json({
          error: 'Endpoint not available in this API version',
          version,
          availableIn: versions
        });
      }
      
      handler(req, res, next);
    };
  }
  
  /**
   * Create versioned router
   */
  createVersionedRouter(express) {
    const router = express.Router();
    
    // Add version detection middleware
    router.use(this.middleware());
    
    // Create sub-routers for each version
    for (const [version, apiVersion] of this.versions) {
      const versionRouter = express.Router();
      
      // Apply version-specific middleware
      for (const middleware of apiVersion.middleware) {
        versionRouter.use(middleware);
      }
      
      // Mount version router
      if (this.options.strategy === VersionStrategy.URL_PATH) {
        router.use(`/v${version}`, versionRouter);
      } else {
        // For other strategies, use conditional routing
        router.use((req, res, next) => {
          if (req.apiVersion === version) {
            versionRouter(req, res, next);
          } else {
            next();
          }
        });
      }
      
      // Store router reference
      apiVersion.router = versionRouter;
    }
    
    return router;
  }
  
  /**
   * Add deprecation headers
   */
  _addDeprecationHeaders(res, version) {
    if (version.isDeprecated()) {
      res.setHeader('X-API-Deprecated', 'true');
      
      if (version.deprecatedAt) {
        res.setHeader('X-API-Deprecated-At', version.deprecatedAt.toISOString());
      }
      
      if (version.sunsetAt) {
        res.setHeader('X-API-Sunset', version.sunsetAt.toISOString());
        
        // Add Sunset header (RFC 8594)
        res.setHeader('Sunset', version.sunsetAt.toUTCString());
      }
      
      // Add deprecation link
      res.setHeader('Link', `</api/deprecation>; rel="deprecation"`);
      
      // Calculate days until sunset
      if (version.sunsetAt) {
        const daysUntilSunset = Math.ceil(
          (version.sunsetAt - Date.now()) / (1000 * 60 * 60 * 24)
        );
        res.setHeader('X-API-Sunset-Days', daysUntilSunset);
      }
    }
  }
  
  /**
   * Get supported versions
   */
  getSupportedVersions() {
    return Array.from(this.versions.entries())
      .filter(([_, v]) => v.isSupported())
      .map(([version]) => version);
  }
  
  /**
   * Mark version as deprecated
   */
  deprecateVersion(version, sunsetDate = null) {
    const apiVersion = this.versions.get(version);
    if (!apiVersion) {
      throw new Error(`Version ${version} not found`);
    }
    
    apiVersion.status = VersionStatus.DEPRECATED;
    apiVersion.deprecatedAt = new Date();
    
    if (sunsetDate) {
      apiVersion.sunsetAt = new Date(sunsetDate);
    } else {
      // Calculate sunset date based on grace period
      apiVersion.sunsetAt = new Date(
        Date.now() + (this.options.sunsetGraceDays * 24 * 60 * 60 * 1000)
      );
    }
    
    logger.warn(`API version ${version} deprecated`, {
      deprecatedAt: apiVersion.deprecatedAt,
      sunsetAt: apiVersion.sunsetAt
    });
    
    this.emit('version:deprecated', apiVersion);
  }
  
  /**
   * Sunset a version (make it unsupported)
   */
  sunsetVersion(version) {
    const apiVersion = this.versions.get(version);
    if (!apiVersion) {
      throw new Error(`Version ${version} not found`);
    }
    
    apiVersion.status = VersionStatus.UNSUPPORTED;
    
    logger.warn(`API version ${version} sunset`, {
      version,
      deprecatedAt: apiVersion.deprecatedAt
    });
    
    this.emit('version:sunset', apiVersion);
  }
  
  /**
   * Version transformation utilities
   */
  createTransformer(fromVersion, toVersion) {
    return {
      request: this._createRequestTransformer(fromVersion, toVersion),
      response: this._createResponseTransformer(fromVersion, toVersion)
    };
  }
  
  _createRequestTransformer(fromVersion, toVersion) {
    return (req) => {
      // Apply version-specific transformations
      const transformations = this._getTransformations(fromVersion, toVersion, 'request');
      
      for (const transform of transformations) {
        req = transform(req);
      }
      
      return req;
    };
  }
  
  _createResponseTransformer(fromVersion, toVersion) {
    return (data) => {
      // Apply version-specific transformations
      const transformations = this._getTransformations(fromVersion, toVersion, 'response');
      
      for (const transform of transformations) {
        data = transform(data);
      }
      
      return data;
    };
  }
  
  /**
   * Helper methods
   */
  _normalizeVersion(version) {
    // Remove 'v' prefix if present
    version = String(version).replace(/^v/i, '');
    
    // Ensure it's a valid version format
    if (!/^\d+(?:\.\d+)?(?:\.\d+)?/.test(version)) {
      version = this.options.defaultVersion;
    }
    
    return version;
  }
  
  _sortVersions() {
    // Sort versions for negotiation
    const sorted = Array.from(this.versions.keys())
      .sort((a, b) => {
        const verA = semver.coerce(a);
        const verB = semver.coerce(b);
        return semver.rcompare(verA, verB);
      });
    
    // Rebuild map in sorted order
    const newMap = new Map();
    for (const version of sorted) {
      newMap.set(version, this.versions.get(version));
    }
    this.versions = newMap;
  }
  
  _calculateVersionScore(requested, candidate) {
    // Higher score = better match
    let score = 0;
    
    // Exact match
    if (semver.eq(requested, candidate)) {
      score += 1000;
    }
    
    // Same minor version
    if (semver.minor(requested) === semver.minor(candidate)) {
      score += 100;
    }
    
    // Newer patch version
    if (semver.patch(candidate) > semver.patch(requested)) {
      score += 10;
    }
    
    // Prefer current version
    const version = Array.from(this.versions.entries())
      .find(([v]) => semver.eq(semver.coerce(v), candidate));
    
    if (version && version[1].isCurrent()) {
      score += 50;
    }
    
    return score;
  }
  
  _trackRequest(version) {
    const count = this.metrics.requests.get(version) || 0;
    this.metrics.requests.set(version, count + 1);
    
    // Track deprecated version usage
    const apiVersion = this.versions.get(version);
    if (apiVersion && apiVersion.isDeprecated()) {
      const depCount = this.metrics.deprecatedRequests.get(version) || 0;
      this.metrics.deprecatedRequests.set(version, depCount + 1);
    }
  }
  
  _getTransformations(fromVersion, toVersion, direction) {
    // This would contain version-specific transformation logic
    // For now, return empty array
    return [];
  }
  
  /**
   * Get metrics
   */
  getMetrics() {
    const versionStats = {};
    
    for (const [version, count] of this.metrics.requests) {
      const apiVersion = this.versions.get(version);
      versionStats[version] = {
        requests: count,
        status: apiVersion ? apiVersion.status : 'unknown',
        deprecated: this.metrics.deprecatedRequests.get(version) || 0
      };
    }
    
    return {
      versionStats,
      totalRequests: Array.from(this.metrics.requests.values()).reduce((a, b) => a + b, 0),
      versionMisses: this.metrics.versionMisses,
      negotiatedRequests: this.metrics.negotiatedRequests,
      supportedVersions: this.getSupportedVersions(),
      currentVersion: this.currentVersion
    };
  }
}

// Default instance
export const defaultVersionManager = new ApiVersionManager();

export default ApiVersionManager;