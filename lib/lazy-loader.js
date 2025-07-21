/**
 * Lazy Module Loader for Otedama
 * Improves startup time by loading modules only when needed
 */

const moduleCache = new Map();

/**
 * Lazy load a module
 * @param {string} modulePath - Path to the module
 * @returns {Promise<any>} The loaded module
 */
export async function lazyLoad(modulePath) {
  if (moduleCache.has(modulePath)) {
    return moduleCache.get(modulePath);
  }
  
  const module = await import(modulePath);
  moduleCache.set(modulePath, module);
  return module;
}

/**
 * Lazy load multiple modules
 * @param {string[]} modulePaths - Array of module paths
 * @returns {Promise<any[]>} Array of loaded modules
 */
export async function lazyLoadMultiple(modulePaths) {
  return Promise.all(modulePaths.map(path => lazyLoad(path)));
}

/**
 * Create a lazy proxy for a module
 * @param {string} modulePath - Path to the module
 * @param {string} exportName - Name of the export to proxy
 * @returns {Proxy} Proxy that loads the module on first access
 */
export function createLazyProxy(modulePath, exportName) {
  let module = null;
  
  return new Proxy({}, {
    get(target, prop) {
      if (!module) {
        throw new Error('Module not loaded. Use await to initialize.');
      }
      const exported = exportName ? module[exportName] : module.default || module;
      return exported[prop];
    },
    
    has(target, prop) {
      if (!module) return false;
      const exported = exportName ? module[exportName] : module.default || module;
      return prop in exported;
    },
    
    apply(target, thisArg, argumentsList) {
      if (!module) {
        throw new Error('Module not loaded. Use await to initialize.');
      }
      const exported = exportName ? module[exportName] : module.default || module;
      return exported.apply(thisArg, argumentsList);
    },
    
    construct(target, args) {
      if (!module) {
        throw new Error('Module not loaded. Use await to initialize.');
      }
      const exported = exportName ? module[exportName] : module.default || module;
      return new exported(...args);
    }
  });
}

/**
 * Preload critical modules in background
 * @param {string[]} criticalPaths - Paths to critical modules
 */
export function preloadCritical(criticalPaths) {
  // Load in background without blocking
  setTimeout(() => {
    criticalPaths.forEach(path => {
      lazyLoad(path).catch(err => {
        console.error(`Failed to preload ${path}:`, err);
      });
    });
  }, 100);
}

/**
 * Clear module cache to free memory
 * @param {string[]} [modulePaths] - Specific modules to clear, or all if not specified
 */
export function clearCache(modulePaths) {
  if (modulePaths) {
    modulePaths.forEach(path => moduleCache.delete(path));
  } else {
    moduleCache.clear();
  }
}