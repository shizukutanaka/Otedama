/**
 * API Version Adapter for Otedama
 * Handles version-specific transformations and compatibility
 * 
 * Design principles:
 * - Carmack: Minimal transformation overhead
 * - Martin: Clean adapter pattern
 * - Pike: Simple transformation rules
 */

import { logger } from '../core/logger.js';

/**
 * Base adapter for API version transformations
 */
export class VersionAdapter {
  constructor(fromVersion, toVersion) {
    this.fromVersion = fromVersion;
    this.toVersion = toVersion;
    this.requestTransformers = new Map();
    this.responseTransformers = new Map();
  }
  
  /**
   * Register request transformer
   */
  addRequestTransformer(path, transformer) {
    if (!this.requestTransformers.has(path)) {
      this.requestTransformers.set(path, []);
    }
    this.requestTransformers.get(path).push(transformer);
  }
  
  /**
   * Register response transformer
   */
  addResponseTransformer(path, transformer) {
    if (!this.responseTransformers.has(path)) {
      this.responseTransformers.set(path, []);
    }
    this.responseTransformers.get(path).push(transformer);
  }
  
  /**
   * Transform request
   */
  transformRequest(path, req) {
    const transformers = this._getTransformers(path, this.requestTransformers);
    
    let transformed = { ...req };
    for (const transformer of transformers) {
      transformed = transformer(transformed, this.fromVersion, this.toVersion);
    }
    
    return transformed;
  }
  
  /**
   * Transform response
   */
  transformResponse(path, res) {
    const transformers = this._getTransformers(path, this.responseTransformers);
    
    let transformed = res;
    for (const transformer of transformers) {
      transformed = transformer(transformed, this.fromVersion, this.toVersion);
    }
    
    return transformed;
  }
  
  /**
   * Get applicable transformers for a path
   */
  _getTransformers(path, transformerMap) {
    const transformers = [];
    
    // Exact match
    if (transformerMap.has(path)) {
      transformers.push(...transformerMap.get(path));
    }
    
    // Pattern match
    for (const [pattern, patternTransformers] of transformerMap) {
      if (pattern instanceof RegExp && pattern.test(path)) {
        transformers.push(...patternTransformers);
      } else if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        if (regex.test(path)) {
          transformers.push(...patternTransformers);
        }
      }
    }
    
    return transformers;
  }
}

/**
 * Version adapter registry
 */
export class VersionAdapterRegistry {
  constructor() {
    this.adapters = new Map();
  }
  
  /**
   * Register an adapter
   */
  registerAdapter(fromVersion, toVersion, adapter) {
    const key = `${fromVersion}->${toVersion}`;
    this.adapters.set(key, adapter);
  }
  
  /**
   * Get adapter for version transition
   */
  getAdapter(fromVersion, toVersion) {
    const key = `${fromVersion}->${toVersion}`;
    return this.adapters.get(key);
  }
  
  /**
   * Create adapter chain for multi-version transformation
   */
  createAdapterChain(fromVersion, toVersion, availableVersions) {
    // Find shortest path between versions
    const path = this._findVersionPath(fromVersion, toVersion, availableVersions);
    
    if (!path) return null;
    
    const adapters = [];
    for (let i = 0; i < path.length - 1; i++) {
      const adapter = this.getAdapter(path[i], path[i + 1]);
      if (adapter) {
        adapters.push(adapter);
      }
    }
    
    return adapters;
  }
  
  /**
   * Find path between versions
   */
  _findVersionPath(from, to, versions) {
    // Simple BFS to find path
    const queue = [[from]];
    const visited = new Set([from]);
    
    while (queue.length > 0) {
      const path = queue.shift();
      const current = path[path.length - 1];
      
      if (current === to) {
        return path;
      }
      
      for (const next of versions) {
        if (!visited.has(next) && this.getAdapter(current, next)) {
          visited.add(next);
          queue.push([...path, next]);
        }
      }
    }
    
    return null;
  }
}

/**
 * Built-in transformers
 */
export const CommonTransformers = {
  /**
   * Rename field transformer
   */
  renameField: (oldName, newName) => {
    return (data) => {
      if (data && typeof data === 'object' && oldName in data) {
        const transformed = { ...data };
        transformed[newName] = transformed[oldName];
        delete transformed[oldName];
        return transformed;
      }
      return data;
    };
  },
  
  /**
   * Add default field transformer
   */
  addDefaultField: (fieldName, defaultValue) => {
    return (data) => {
      if (data && typeof data === 'object' && !(fieldName in data)) {
        return { ...data, [fieldName]: defaultValue };
      }
      return data;
    };
  },
  
  /**
   * Remove field transformer
   */
  removeField: (fieldName) => {
    return (data) => {
      if (data && typeof data === 'object' && fieldName in data) {
        const transformed = { ...data };
        delete transformed[fieldName];
        return transformed;
      }
      return data;
    };
  },
  
  /**
   * Transform array items
   */
  transformArray: (fieldName, itemTransformer) => {
    return (data) => {
      if (data && typeof data === 'object' && Array.isArray(data[fieldName])) {
        return {
          ...data,
          [fieldName]: data[fieldName].map(itemTransformer)
        };
      }
      return data;
    };
  },
  
  /**
   * Nested object transformer
   */
  transformNested: (path, transformer) => {
    return (data) => {
      const parts = path.split('.');
      const transformed = { ...data };
      
      let current = transformed;
      for (let i = 0; i < parts.length - 1; i++) {
        if (current[parts[i]] && typeof current[parts[i]] === 'object') {
          current[parts[i]] = { ...current[parts[i]] };
          current = current[parts[i]];
        } else {
          return transformed;
        }
      }
      
      const lastPart = parts[parts.length - 1];
      if (lastPart in current) {
        current[lastPart] = transformer(current[lastPart]);
      }
      
      return transformed;
    };
  },
  
  /**
   * Pagination format transformer
   */
  transformPagination: (fromFormat, toFormat) => {
    return (data) => {
      if (!data || typeof data !== 'object') return data;
      
      const transformed = { ...data };
      
      // From offset/limit to page/size
      if (fromFormat === 'offset' && toFormat === 'page') {
        if ('offset' in data && 'limit' in data) {
          transformed.page = Math.floor(data.offset / data.limit) + 1;
          transformed.size = data.limit;
          delete transformed.offset;
          delete transformed.limit;
        }
      }
      
      // From page/size to offset/limit
      else if (fromFormat === 'page' && toFormat === 'offset') {
        if ('page' in data && 'size' in data) {
          transformed.offset = (data.page - 1) * data.size;
          transformed.limit = data.size;
          delete transformed.page;
          delete transformed.size;
        }
      }
      
      return transformed;
    };
  },
  
  /**
   * Error format transformer
   */
  transformError: (fromFormat, toFormat) => {
    return (error) => {
      if (!error) return error;
      
      // Transform to standard format
      if (toFormat === 'standard') {
        return {
          error: {
            code: error.code || error.error_code || 'UNKNOWN_ERROR',
            message: error.message || error.error_message || error.error || 'Unknown error',
            details: error.details || error.error_details || {},
            timestamp: error.timestamp || new Date().toISOString()
          }
        };
      }
      
      // Transform to legacy format
      else if (toFormat === 'legacy') {
        return {
          success: false,
          error: error.error?.message || error.message || 'Unknown error',
          error_code: error.error?.code || error.code || 'UNKNOWN_ERROR'
        };
      }
      
      return error;
    };
  }
};

/**
 * Create version adapters for Otedama API
 */
export function createOtedamaAdapters() {
  const registry = new VersionAdapterRegistry();
  
  // V1 to V2 adapter
  const v1ToV2 = new VersionAdapter('1', '2');
  
  // User endpoints
  v1ToV2.addResponseTransformer('/api/users/*', CommonTransformers.renameField('created', 'createdAt'));
  v1ToV2.addResponseTransformer('/api/users/*', CommonTransformers.renameField('updated', 'updatedAt'));
  v1ToV2.addResponseTransformer('/api/users/*', CommonTransformers.addDefaultField('apiVersion', '2'));
  
  // Mining endpoints
  v1ToV2.addRequestTransformer('/api/mining/submit', (req) => {
    // V2 expects different share format
    if (req.body && req.body.share) {
      return {
        ...req,
        body: {
          ...req.body,
          share: {
            ...req.body.share,
            version: req.body.share.version || 1,
            timestamp: req.body.share.timestamp || Date.now()
          }
        }
      };
    }
    return req;
  });
  
  // Pagination transformation
  v1ToV2.addRequestTransformer('/api/*', (req) => {
    if (req.query) {
      return {
        ...req,
        query: CommonTransformers.transformPagination('offset', 'page')(req.query)
      };
    }
    return req;
  });
  
  v1ToV2.addResponseTransformer('/api/*', (res) => {
    if (res.data && res.pagination) {
      return {
        ...res,
        pagination: CommonTransformers.transformPagination('offset', 'page')(res.pagination)
      };
    }
    return res;
  });
  
  // Error format transformation
  v1ToV2.addResponseTransformer('/api/*', (res) => {
    if (res.error || res.success === false) {
      return CommonTransformers.transformError('legacy', 'standard')(res);
    }
    return res;
  });
  
  registry.registerAdapter('1', '2', v1ToV2);
  
  // V2 to V3 adapter (future)
  const v2ToV3 = new VersionAdapter('2', '3');
  
  // Example: New authentication format
  v2ToV3.addRequestTransformer('/api/auth/*', (req) => {
    if (req.headers && req.headers.authorization) {
      // Transform Bearer token to new format
      const token = req.headers.authorization.replace('Bearer ', '');
      return {
        ...req,
        headers: {
          ...req.headers,
          'x-auth-token': token,
          'x-auth-type': 'bearer'
        }
      };
    }
    return req;
  });
  
  registry.registerAdapter('2', '3', v2ToV3);
  
  return registry;
}

export default VersionAdapterRegistry;