/**
 * Frontend Performance Optimizer - Otedama
 * Optimizes frontend assets and performance
 * 
 * Design principles:
 * - Carmack: Maximum performance, minimal overhead
 * - Martin: Clean optimization pipeline
 * - Pike: Simple but effective
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createStructuredLogger } from './structured-logger.js';
import { memoryManager } from './memory-manager.js';

const logger = createStructuredLogger('FrontendOptimizer');
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Asset optimization strategies
 */
export const OptimizationStrategy = {
  MINIFY: 'minify',
  COMPRESS: 'compress',
  BUNDLE: 'bundle',
  LAZY_LOAD: 'lazy_load',
  PRELOAD: 'preload',
  CACHE: 'cache'
};

/**
 * Frontend Performance Optimizer
 */
export class FrontendOptimizer {
  constructor(config = {}) {
    this.config = {
      enableMinification: config.enableMinification !== false,
      enableCompression: config.enableCompression !== false,
      enableCaching: config.enableCaching !== false,
      enableBundling: config.enableBundling !== false,
      cacheMaxAge: config.cacheMaxAge || 31536000, // 1 year
      criticalCss: config.criticalCss || [],
      preloadAssets: config.preloadAssets || [],
      lazyLoadThreshold: config.lazyLoadThreshold || 1.5,
      ...config
    };
    
    // Asset cache
    this.assetCache = new Map();
    this.cssCache = new Map();
    this.jsCache = new Map();
    
    // Performance metrics
    this.metrics = {
      totalSize: 0,
      optimizedSize: 0,
      cacheHits: 0,
      cacheMisses: 0,
      loadTime: 0
    };
  }
  
  /**
   * Optimize HTML with performance enhancements
   */
  optimizeHTML(html, options = {}) {
    let optimized = html;
    
    // Inject critical CSS
    if (this.config.criticalCss.length > 0) {
      const criticalCss = this.getCriticalCSS();
      optimized = optimized.replace(
        '</head>',
        `<style>${criticalCss}</style>\n</head>`
      );
    }
    
    // Add preload hints
    const preloadLinks = this.generatePreloadLinks();
    optimized = optimized.replace(
      '</head>',
      `${preloadLinks}\n</head>`
    );
    
    // Add resource hints
    const resourceHints = this.generateResourceHints();
    optimized = optimized.replace(
      '</head>',
      `${resourceHints}\n</head>`
    );
    
    // Optimize images for lazy loading
    optimized = this.optimizeImages(optimized);
    
    // Add performance monitoring
    optimized = this.injectPerformanceMonitoring(optimized);
    
    // Minify HTML if enabled
    if (this.config.enableMinification) {
      optimized = this.minifyHTML(optimized);
    }
    
    return optimized;
  }
  
  /**
   * Optimize CSS with performance improvements
   */
  optimizeCSS(css, options = {}) {
    let optimized = css;
    
    // Remove unused CSS (tree shaking)
    if (options.treeShake) {
      optimized = this.treeShakeCSS(optimized, options.usedClasses || []);
    }
    
    // Optimize CSS properties
    optimized = this.optimizeCSSProperties(optimized);
    
    // Add vendor prefixes where needed
    optimized = this.addVendorPrefixes(optimized);
    
    // Minify CSS
    if (this.config.enableMinification) {
      optimized = this.minifyCSS(optimized);
    }
    
    // Generate hash for caching
    const hash = this.generateHash(optimized);
    this.cssCache.set(hash, optimized);
    
    return {
      content: optimized,
      hash,
      size: Buffer.byteLength(optimized),
      originalSize: Buffer.byteLength(css)
    };
  }
  
  /**
   * Optimize JavaScript with performance improvements
   */
  optimizeJS(js, options = {}) {
    let optimized = js;
    
    // Tree shake unused code
    if (options.treeShake) {
      optimized = this.treeShakeJS(optimized);
    }
    
    // Convert to ES5 for compatibility if needed
    if (options.transpile) {
      optimized = this.transpileJS(optimized);
    }
    
    // Minify JavaScript
    if (this.config.enableMinification) {
      optimized = this.minifyJS(optimized);
    }
    
    // Generate hash for caching
    const hash = this.generateHash(optimized);
    this.jsCache.set(hash, optimized);
    
    return {
      content: optimized,
      hash,
      size: Buffer.byteLength(optimized),
      originalSize: Buffer.byteLength(js)
    };
  }
  
  /**
   * Bundle multiple JS files
   */
  async bundleJS(files, options = {}) {
    const modules = [];
    
    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      modules.push({
        path: file,
        content: this.wrapModule(content, file)
      });
    }
    
    // Create bundle
    const bundle = this.createBundle(modules, options);
    
    // Optimize bundle
    const optimized = this.optimizeJS(bundle, {
      treeShake: true,
      transpile: options.transpile
    });
    
    return optimized;
  }
  
  /**
   * Generate critical CSS
   */
  getCriticalCSS() {
    // Critical CSS for above-the-fold content
    return `
      /* Critical CSS - Inlined for performance */
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
      .container { max-width: 1400px; margin: 0 auto; padding: 1rem; }
      .card { background: white; border-radius: 0.75rem; padding: 1.5rem; }
      .skeleton { background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%); background-size: 200% 100%; animation: loading 1.5s infinite; }
      @keyframes loading { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
      @media (prefers-color-scheme: dark) {
        body { background: #111827; color: #F9FAFB; }
        .card { background: #1F2937; }
      }
    `.replace(/\s+/g, ' ').trim();
  }
  
  /**
   * Generate preload links
   */
  generatePreloadLinks() {
    return this.config.preloadAssets.map(asset => {
      const type = this.getAssetType(asset);
      const as = type === 'font' ? 'font' : type === 'css' ? 'style' : 'script';
      const crossorigin = type === 'font' ? ' crossorigin' : '';
      return `<link rel="preload" href="${asset}" as="${as}"${crossorigin}>`;
    }).join('\n');
  }
  
  /**
   * Generate resource hints
   */
  generateResourceHints() {
    return `
      <link rel="dns-prefetch" href="//cdn.jsdelivr.net">
      <link rel="preconnect" href="//cdn.jsdelivr.net" crossorigin>
      <meta http-equiv="x-dns-prefetch-control" content="on">
    `.trim();
  }
  
  /**
   * Optimize images for lazy loading
   */
  optimizeImages(html) {
    // Add loading="lazy" to images below the fold
    return html.replace(
      /<img([^>]*?)src=/g,
      (match, attrs) => {
        if (attrs.includes('loading=')) return match;
        return `<img${attrs}loading="lazy" src=`;
      }
    );
  }
  
  /**
   * Inject performance monitoring
   */
  injectPerformanceMonitoring(html) {
    const perfScript = `
    <script>
      // Performance monitoring
      window.addEventListener('load', function() {
        if ('performance' in window) {
          const perfData = performance.getEntriesByType('navigation')[0];
          const metrics = {
            dns: perfData.domainLookupEnd - perfData.domainLookupStart,
            tcp: perfData.connectEnd - perfData.connectStart,
            request: perfData.responseStart - perfData.requestStart,
            response: perfData.responseEnd - perfData.responseStart,
            dom: perfData.domComplete - perfData.domLoading,
            load: perfData.loadEventEnd - perfData.loadEventStart,
            total: perfData.loadEventEnd - perfData.fetchStart
          };
          
          // Send metrics to analytics
          if (window.analytics) {
            window.analytics.track('Performance Metrics', metrics);
          }
          
          // Log to console in dev
          if (location.hostname === 'localhost') {
            console.table(metrics);
          }
        }
      });
      
      // Lazy load images when they come into view
      if ('IntersectionObserver' in window) {
        const imageObserver = new IntersectionObserver((entries) => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              const img = entry.target;
              img.src = img.dataset.src || img.src;
              img.classList.add('loaded');
              imageObserver.unobserve(img);
            }
          });
        }, { rootMargin: '50px' });
        
        document.querySelectorAll('img[loading="lazy"]').forEach(img => {
          imageObserver.observe(img);
        });
      }
    </script>
    `.trim();
    
    return html.replace('</body>', `${perfScript}\n</body>`);
  }
  
  /**
   * Minify HTML
   */
  minifyHTML(html) {
    return html
      .replace(/<!--[\s\S]*?-->/g, '') // Remove comments
      .replace(/\s+/g, ' ') // Collapse whitespace
      .replace(/>\s+</g, '><') // Remove whitespace between tags
      .trim();
  }
  
  /**
   * Minify CSS
   */
  minifyCSS(css) {
    return css
      .replace(/\/\*[\s\S]*?\*\//g, '') // Remove comments
      .replace(/\s+/g, ' ') // Collapse whitespace
      .replace(/:\s+/g, ':') // Remove space after colons
      .replace(/;\s+/g, ';') // Remove space after semicolons
      .replace(/\s*{\s*/g, '{') // Remove space around braces
      .replace(/\s*}\s*/g, '}')
      .replace(/;}/g, '}') // Remove last semicolon
      .trim();
  }
  
  /**
   * Minify JavaScript
   */
  minifyJS(js) {
    // Simple minification - in production use a proper minifier
    return js
      .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
      .replace(/\/\/.*$/gm, '') // Remove line comments
      .replace(/\s+/g, ' ') // Collapse whitespace
      .replace(/\s*([{}();,])\s*/g, '$1') // Remove space around operators
      .trim();
  }
  
  /**
   * Tree shake CSS
   */
  treeShakeCSS(css, usedClasses) {
    // Simple implementation - in production use PurgeCSS
    const rules = css.match(/[^{}]+{[^}]+}/g) || [];
    const usedRules = rules.filter(rule => {
      const selector = rule.match(/^([^{]+)/)[1];
      return usedClasses.some(cls => selector.includes(cls));
    });
    
    return usedRules.join('\n');
  }
  
  /**
   * Tree shake JavaScript
   */
  treeShakeJS(js) {
    // Simple dead code elimination
    // In production, use proper tree shaking tools
    return js.replace(/if\s*\(\s*false\s*\)\s*{[^}]*}/g, '');
  }
  
  /**
   * Transpile JavaScript
   */
  transpileJS(js) {
    // Simple ES6 to ES5 conversion
    // In production, use Babel
    return js
      .replace(/const\s+/g, 'var ')
      .replace(/let\s+/g, 'var ')
      .replace(/=>\s*{/g, 'function() {')
      .replace(/=>\s*([^{])/g, 'function() { return $1; }');
  }
  
  /**
   * Wrap module for bundling
   */
  wrapModule(content, path) {
    return `
    // Module: ${path}
    (function() {
      ${content}
    })();
    `;
  }
  
  /**
   * Create bundle from modules
   */
  createBundle(modules, options = {}) {
    const header = `
    // Otedama Bundle - Generated ${new Date().toISOString()}
    (function(global) {
      'use strict';
    `;
    
    const footer = `
    })(typeof window !== 'undefined' ? window : global);
    `;
    
    const moduleCode = modules.map(m => m.content).join('\n\n');
    
    return header + moduleCode + footer;
  }
  
  /**
   * Generate hash for caching
   */
  generateHash(content) {
    return createHash('sha256')
      .update(content)
      .digest('hex')
      .substring(0, 8);
  }
  
  /**
   * Get asset type from path
   */
  getAssetType(path) {
    const ext = path.split('.').pop().toLowerCase();
    const types = {
      js: 'script',
      css: 'style',
      woff: 'font',
      woff2: 'font',
      ttf: 'font',
      otf: 'font',
      jpg: 'image',
      jpeg: 'image',
      png: 'image',
      webp: 'image',
      svg: 'image'
    };
    
    return types[ext] || 'resource';
  }
  
  /**
   * Generate service worker for offline support
   */
  generateServiceWorker() {
    return `
    // Otedama Service Worker
    const CACHE_NAME = 'otedama-v1';
    const urlsToCache = [
      '/',
      '/css/main.css',
      '/js/app.js',
      '/offline.html'
    ];
    
    // Install event
    self.addEventListener('install', event => {
      event.waitUntil(
        caches.open(CACHE_NAME)
          .then(cache => cache.addAll(urlsToCache))
      );
    });
    
    // Fetch event
    self.addEventListener('fetch', event => {
      event.respondWith(
        caches.match(event.request)
          .then(response => {
            if (response) {
              return response;
            }
            
            return fetch(event.request).then(response => {
              if (!response || response.status !== 200 || response.type !== 'basic') {
                return response;
              }
              
              const responseToCache = response.clone();
              caches.open(CACHE_NAME).then(cache => {
                cache.put(event.request, responseToCache);
              });
              
              return response;
            });
          })
          .catch(() => {
            return caches.match('/offline.html');
          })
      );
    });
    
    // Activate event
    self.addEventListener('activate', event => {
      event.waitUntil(
        caches.keys().then(cacheNames => {
          return Promise.all(
            cacheNames.map(cacheName => {
              if (cacheName !== CACHE_NAME) {
                return caches.delete(cacheName);
              }
            })
          );
        })
      );
    });
    `.trim();
  }
  
  /**
   * Get optimization report
   */
  getOptimizationReport() {
    const savings = this.metrics.totalSize - this.metrics.optimizedSize;
    const savingsPercent = (savings / this.metrics.totalSize * 100).toFixed(2);
    const cacheHitRate = (this.metrics.cacheHits / (this.metrics.cacheHits + this.metrics.cacheMisses) * 100).toFixed(2);
    
    return {
      totalSize: this.formatBytes(this.metrics.totalSize),
      optimizedSize: this.formatBytes(this.metrics.optimizedSize),
      savings: this.formatBytes(savings),
      savingsPercent: savingsPercent + '%',
      cacheHitRate: cacheHitRate + '%',
      metrics: this.metrics
    };
  }
  
  /**
   * Format bytes to human readable
   */
  formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let unitIndex = 0;
    let size = bytes;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }
}

/**
 * Create frontend optimizer instance
 */
export function createFrontendOptimizer(config) {
  return new FrontendOptimizer(config);
}

export default FrontendOptimizer;