/**
 * Performance Profiler for Otedama
 * Provides CPU, memory, and async profiling capabilities
 * 
 * Design principles:
 * - Carmack: Minimal profiling overhead
 * - Martin: Clean profiling interfaces
 * - Pike: Simple and effective profiling
 */

import { EventEmitter } from 'events';
import { performance, PerformanceObserver } from 'perf_hooks';
import v8 from 'v8';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getLogger } from '../core/logger.js';

const logger = getLogger('Profiler');

// Profile types
export const ProfileType = {
  CPU: 'cpu',
  MEMORY: 'memory',
  ASYNC: 'async',
  FUNCTION: 'function',
  HEAP: 'heap'
};

/**
 * Performance profiler
 */
export class Profiler extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      outputDir: options.outputDir || './profiles',
      sampleInterval: options.sampleInterval || 100, // microseconds for CPU profiling
      memoryInterval: options.memoryInterval || 1000, // ms for memory sampling
      asyncHooks: options.asyncHooks !== false,
      functionProfiling: options.functionProfiling !== false,
      maxProfileDuration: options.maxProfileDuration || 300000, // 5 minutes
      autoProfile: options.autoProfile || false,
      ...options
    };
    
    // Profile storage
    this.activeProfiles = new Map();
    this.completedProfiles = [];
    
    // Performance marks
    this.marks = new Map();
    this.measures = new Map();
    
    // Function profiling
    this.functionTimings = new Map();
    this.callCounts = new Map();
    
    // Memory tracking
    this.memorySnapshots = [];
    this.memoryTimer = null;
    
    // Async tracking
    this.asyncOperations = new Map();
    
    // Metrics
    this.metrics = {
      profilesStarted: 0,
      profilesCompleted: 0,
      profilesFailed: 0,
      totalProfileTime: 0
    };
    
    // Setup performance observer
    this._setupPerformanceObserver();
    
    // Mark as not initialized
    this.initialized = false;
  }
  
  /**
   * Initialize the profiler (async)
   */
  async initialize() {
    if (this.initialized) return;
    
    // Ensure output directory exists
    await mkdir(this.options.outputDir, { recursive: true });
    
    this.initialized = true;
  }
  
  /**
   * Start profiling
   */
  async startProfile(name, type = ProfileType.CPU, options = {}) {
    // Ensure profiler is initialized
    if (!this.initialized) {
      await this.initialize();
    }
    
    if (this.activeProfiles.has(name)) {
      throw new Error(`Profile ${name} is already active`);
    }
    
    const profile = {
      name,
      type,
      startTime: Date.now(),
      startCpu: process.cpuUsage(),
      startMemory: process.memoryUsage(),
      options,
      data: []
    };
    
    this.activeProfiles.set(name, profile);
    this.metrics.profilesStarted++;
    
    // Start specific profiling based on type
    switch (type) {
      case ProfileType.CPU:
        this._startCPUProfile(profile);
        break;
        
      case ProfileType.MEMORY:
        this._startMemoryProfile(profile);
        break;
        
      case ProfileType.ASYNC:
        this._startAsyncProfile(profile);
        break;
        
      case ProfileType.FUNCTION:
        this._startFunctionProfile(profile);
        break;
        
      case ProfileType.HEAP:
        this._startHeapProfile(profile);
        break;
    }
    
    // Auto-stop after max duration
    profile.timeout = setTimeout(() => {
      this.stopProfile(name).catch(error => {
        logger.error(`Failed to auto-stop profile ${name}`, error);
      });
    }, options.duration || this.options.maxProfileDuration);
    
    this.emit('profile:started', profile);
    
    return profile;
  }
  
  /**
   * Stop profiling
   */
  async stopProfile(name) {
    const profile = this.activeProfiles.get(name);
    if (!profile) {
      throw new Error(`Profile ${name} not found`);
    }
    
    // Clear timeout
    if (profile.timeout) {
      clearTimeout(profile.timeout);
    }
    
    // Stop specific profiling
    switch (profile.type) {
      case ProfileType.CPU:
        await this._stopCPUProfile(profile);
        break;
        
      case ProfileType.MEMORY:
        this._stopMemoryProfile(profile);
        break;
        
      case ProfileType.ASYNC:
        this._stopAsyncProfile(profile);
        break;
        
      case ProfileType.FUNCTION:
        this._stopFunctionProfile(profile);
        break;
        
      case ProfileType.HEAP:
        await this._stopHeapProfile(profile);
        break;
    }
    
    // Calculate final metrics
    profile.endTime = Date.now();
    profile.duration = profile.endTime - profile.startTime;
    profile.endCpu = process.cpuUsage(profile.startCpu);
    profile.endMemory = process.memoryUsage();
    
    // Move to completed
    this.activeProfiles.delete(name);
    this.completedProfiles.push(profile);
    this.metrics.profilesCompleted++;
    this.metrics.totalProfileTime += profile.duration;
    
    // Save profile
    await this._saveProfile(profile);
    
    this.emit('profile:completed', profile);
    
    return profile;
  }
  
  /**
   * CPU profiling
   */
  _startCPUProfile(profile) {
    if (typeof v8.startProfiling === 'function') {
      v8.startProfiling(profile.name, true);
      profile.v8Profile = true;
    } else {
      // Fallback to manual sampling
      profile.cpuSampler = setInterval(() => {
        const usage = process.cpuUsage();
        profile.data.push({
          timestamp: Date.now(),
          cpu: usage,
          memory: process.memoryUsage.rss()
        });
      }, this.options.sampleInterval);
    }
  }
  
  async _stopCPUProfile(profile) {
    if (profile.v8Profile && typeof v8.stopProfiling === 'function') {
      const cpuProfile = v8.stopProfiling(profile.name);
      profile.cpuProfile = cpuProfile;
      
      // Export profile
      return new Promise((resolve) => {
        cpuProfile.export((error, result) => {
          if (error) {
            logger.error('Failed to export CPU profile', error);
          } else {
            profile.cpuProfileData = result;
          }
          cpuProfile.delete();
          resolve();
        });
      });
    } else if (profile.cpuSampler) {
      clearInterval(profile.cpuSampler);
    }
  }
  
  /**
   * Memory profiling
   */
  _startMemoryProfile(profile) {
    profile.memoryTimer = setInterval(() => {
      const memory = process.memoryUsage();
      const heapStats = v8.getHeapStatistics();
      
      profile.data.push({
        timestamp: Date.now(),
        memory,
        heap: {
          totalHeapSize: heapStats.total_heap_size,
          usedHeapSize: heapStats.used_heap_size,
          heapSizeLimit: heapStats.heap_size_limit,
          mallocedMemory: heapStats.malloced_memory,
          externalMemory: heapStats.external_memory
        }
      });
    }, this.options.memoryInterval);
  }
  
  _stopMemoryProfile(profile) {
    if (profile.memoryTimer) {
      clearInterval(profile.memoryTimer);
    }
  }
  
  /**
   * Heap profiling
   */
  _startHeapProfile(profile) {
    // Take initial snapshot
    profile.startSnapshot = v8.writeHeapSnapshot();
  }
  
  async _stopHeapProfile(profile) {
    // Take final snapshot
    const filename = `heap-${profile.name}-${Date.now()}.heapsnapshot`;
    const filepath = join(this.options.outputDir, filename);
    
    v8.writeHeapSnapshot(filepath);
    profile.heapSnapshotPath = filepath;
  }
  
  /**
   * Async profiling
   */
  _startAsyncProfile(profile) {
    if (!this.options.asyncHooks) return;
    
    // Import async_hooks dynamically
    import('async_hooks').then(({ createHook }) => {
      profile.asyncHook = createHook({
        init: (asyncId, type, triggerAsyncId) => {
          profile.data.push({
            event: 'init',
            asyncId,
            type,
            triggerAsyncId,
            timestamp: Date.now()
          });
        },
        before: (asyncId) => {
          profile.data.push({
            event: 'before',
            asyncId,
            timestamp: Date.now()
          });
        },
        after: (asyncId) => {
          profile.data.push({
            event: 'after',
            asyncId,
            timestamp: Date.now()
          });
        },
        destroy: (asyncId) => {
          profile.data.push({
            event: 'destroy',
            asyncId,
            timestamp: Date.now()
          });
        }
      });
      
      profile.asyncHook.enable();
    }).catch(error => {
      logger.error('Failed to start async profiling', error);
    });
  }
  
  _stopAsyncProfile(profile) {
    if (profile.asyncHook) {
      profile.asyncHook.disable();
    }
  }
  
  /**
   * Function profiling
   */
  _startFunctionProfile(profile) {
    profile.functionInterceptor = (name, fn) => {
      return (...args) => {
        const start = performance.now();
        const startMem = process.memoryUsage.rss();
        
        try {
          const result = fn.apply(this, args);
          
          // Handle async functions
          if (result && typeof result.then === 'function') {
            return result.finally(() => {
              this._recordFunctionTiming(name, start, startMem);
            });
          }
          
          this._recordFunctionTiming(name, start, startMem);
          return result;
        } catch (error) {
          this._recordFunctionTiming(name, start, startMem, error);
          throw error;
        }
      };
    };
  }
  
  _stopFunctionProfile(profile) {
    // Collect function timings
    profile.functionTimings = Array.from(this.functionTimings.entries()).map(([name, timings]) => ({
      name,
      count: this.callCounts.get(name) || 0,
      totalTime: timings.reduce((sum, t) => sum + t.duration, 0),
      avgTime: timings.reduce((sum, t) => sum + t.duration, 0) / timings.length,
      minTime: Math.min(...timings.map(t => t.duration)),
      maxTime: Math.max(...timings.map(t => t.duration))
    }));
  }
  
  _recordFunctionTiming(name, startTime, startMem, error = null) {
    const duration = performance.now() - startTime;
    const memDelta = process.memoryUsage.rss() - startMem;
    
    if (!this.functionTimings.has(name)) {
      this.functionTimings.set(name, []);
      this.callCounts.set(name, 0);
    }
    
    this.functionTimings.get(name).push({
      duration,
      memDelta,
      error: error ? error.message : null,
      timestamp: Date.now()
    });
    
    this.callCounts.set(name, this.callCounts.get(name) + 1);
  }
  
  /**
   * Performance marks and measures
   */
  mark(name, metadata = {}) {
    const mark = {
      name,
      timestamp: performance.now(),
      metadata
    };
    
    this.marks.set(name, mark);
    performance.mark(name);
    
    return mark;
  }
  
  measure(name, startMark, endMark = null) {
    const start = this.marks.get(startMark);
    if (!start) {
      throw new Error(`Start mark ${startMark} not found`);
    }
    
    const end = endMark ? this.marks.get(endMark) : { timestamp: performance.now() };
    const duration = end.timestamp - start.timestamp;
    
    const measure = {
      name,
      startMark,
      endMark,
      duration,
      timestamp: Date.now()
    };
    
    if (!this.measures.has(name)) {
      this.measures.set(name, []);
    }
    this.measures.get(name).push(measure);
    
    if (endMark) {
      performance.measure(name, startMark, endMark);
    } else {
      performance.measure(name, startMark);
    }
    
    return measure;
  }
  
  /**
   * Get profiling report
   */
  getReport(profileName = null) {
    if (profileName) {
      const profile = this.completedProfiles.find(p => p.name === profileName);
      return profile ? this._generateProfileReport(profile) : null;
    }
    
    return {
      metrics: this.metrics,
      activeProfiles: Array.from(this.activeProfiles.keys()),
      completedProfiles: this.completedProfiles.map(p => ({
        name: p.name,
        type: p.type,
        duration: p.duration,
        startTime: p.startTime,
        endTime: p.endTime
      })),
      measures: Object.fromEntries(
        Array.from(this.measures.entries()).map(([name, measures]) => [
          name,
          {
            count: measures.length,
            totalDuration: measures.reduce((sum, m) => sum + m.duration, 0),
            avgDuration: measures.reduce((sum, m) => sum + m.duration, 0) / measures.length,
            minDuration: Math.min(...measures.map(m => m.duration)),
            maxDuration: Math.max(...measures.map(m => m.duration))
          }
        ])
      )
    };
  }
  
  _generateProfileReport(profile) {
    const report = {
      name: profile.name,
      type: profile.type,
      duration: profile.duration,
      startTime: new Date(profile.startTime).toISOString(),
      endTime: new Date(profile.endTime).toISOString(),
      cpu: {
        user: profile.endCpu.user,
        system: profile.endCpu.system,
        percentUser: (profile.endCpu.user / profile.duration / 10).toFixed(2) + '%',
        percentSystem: (profile.endCpu.system / profile.duration / 10).toFixed(2) + '%'
      },
      memory: {
        startRss: (profile.startMemory.rss / 1024 / 1024).toFixed(2) + ' MB',
        endRss: (profile.endMemory.rss / 1024 / 1024).toFixed(2) + ' MB',
        rssDelta: ((profile.endMemory.rss - profile.startMemory.rss) / 1024 / 1024).toFixed(2) + ' MB',
        heapUsed: (profile.endMemory.heapUsed / 1024 / 1024).toFixed(2) + ' MB',
        external: (profile.endMemory.external / 1024 / 1024).toFixed(2) + ' MB'
      }
    };
    
    // Add type-specific data
    switch (profile.type) {
      case ProfileType.FUNCTION:
        report.functions = profile.functionTimings;
        break;
        
      case ProfileType.MEMORY:
        report.memorySamples = profile.data.length;
        break;
        
      case ProfileType.ASYNC:
        report.asyncOperations = profile.data.length;
        break;
    }
    
    return report;
  }
  
  /**
   * Save profile to disk
   */
  async _saveProfile(profile) {
    const filename = `${profile.type}-${profile.name}-${profile.startTime}.json`;
    const filepath = join(this.options.outputDir, filename);
    
    const data = {
      ...this._generateProfileReport(profile),
      rawData: profile.data
    };
    
    // Add CPU profile data if available
    if (profile.cpuProfileData) {
      const cpuFilename = `cpu-${profile.name}-${profile.startTime}.cpuprofile`;
      const cpuFilepath = join(this.options.outputDir, cpuFilename);
      await writeFile(cpuFilepath, profile.cpuProfileData);
      data.cpuProfilePath = cpuFilepath;
    }
    
    await writeFile(filepath, JSON.stringify(data, null, 2));
    
    logger.info(`Profile saved to ${filepath}`);
  }
  
  /**
   * Setup performance observer
   */
  _setupPerformanceObserver() {
    const obs = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      
      for (const entry of entries) {
        if (entry.entryType === 'measure') {
          this.emit('measure', {
            name: entry.name,
            duration: entry.duration,
            startTime: entry.startTime
          });
        }
      }
    });
    
    obs.observe({ entryTypes: ['measure', 'mark'] });
  }
  
  /**
   * Profile wrapper for functions
   */
  profileFunction(name, fn) {
    if (!this.options.functionProfiling) return fn;
    
    const profiler = this;
    
    return function profiledFunction(...args) {
      profiler.mark(`${name}-start`);
      
      try {
        const result = fn.apply(this, args);
        
        if (result && typeof result.then === 'function') {
          return result.finally(() => {
            profiler.measure(name, `${name}-start`);
          });
        }
        
        profiler.measure(name, `${name}-start`);
        return result;
      } catch (error) {
        profiler.measure(name, `${name}-start`);
        throw error;
      }
    };
  }
  
  /**
   * Auto-profile based on conditions
   */
  enableAutoProfile(conditions = {}) {
    const checkConditions = () => {
      const memUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage();
      
      // High memory usage
      if (conditions.memoryThreshold && 
          memUsage.heapUsed > conditions.memoryThreshold) {
        this.startProfile('auto-memory', ProfileType.MEMORY, {
          duration: 60000,
          reason: 'high-memory'
        });
      }
      
      // High CPU usage (simplified check)
      if (conditions.cpuThreshold) {
        const cpuPercent = (cpuUsage.user + cpuUsage.system) / 1000000 * 100;
        if (cpuPercent > conditions.cpuThreshold) {
          this.startProfile('auto-cpu', ProfileType.CPU, {
            duration: 30000,
            reason: 'high-cpu'
          });
        }
      }
    };
    
    // Check periodically
    this.autoProfileTimer = setInterval(checkConditions, 
      conditions.checkInterval || 60000
    );
  }
  
  /**
   * Shutdown profiler
   */
  async shutdown() {
    // Stop all active profiles
    for (const [name] of this.activeProfiles) {
      await this.stopProfile(name).catch(error => {
        logger.error(`Failed to stop profile ${name}`, error);
      });
    }
    
    // Clear timers
    if (this.autoProfileTimer) {
      clearInterval(this.autoProfileTimer);
    }
    
    this.emit('shutdown');
  }
}

// Global profiler instance
let globalProfiler = null;

export function getProfiler(options) {
  if (!globalProfiler) {
    globalProfiler = new Profiler(options);
  }
  return globalProfiler;
}

export function setGlobalProfiler(profiler) {
  globalProfiler = profiler;
}

export default Profiler;