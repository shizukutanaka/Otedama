const BaseService = require('./base-service');

/**
 * Base class for all pool implementations
 */
class BasePool extends BaseService {
  constructor(poolName, config = {}) {
    super(poolName, {
      // Pool-specific defaults
      minSize: config.minSize || 2,
      maxSize: config.maxSize || 10,
      acquireTimeout: config.acquireTimeout || 30000,
      idleTimeout: config.idleTimeout || 300000,
      validateInterval: config.validateInterval || 30000,
      evictionRunInterval: config.evictionRunInterval || 60000,
      
      // Resource creation
      createRetries: config.createRetries || 3,
      createTimeout: config.createTimeout || 10000,
      
      // Monitoring
      enableResourceMetrics: config.enableResourceMetrics !== false,
      
      ...config
    });
    
    // Pool state
    this.resources = new Map();
    this.availableResources = [];
    this.pendingCreates = 0;
    this.waitingClients = [];
    
    // Pool metrics
    this.poolMetrics = {
      created: 0,
      destroyed: 0,
      acquired: 0,
      released: 0,
      timeouts: 0,
      validationFailures: 0,
      currentSize: 0,
      availableSize: 0,
      waitingCount: 0,
      peakSize: 0
    };
  }
  
  /**
   * Initialize the pool
   */
  async onInitialize() {
    // Create minimum resources
    await this.ensureMinimumResources();
    
    // Start eviction timer
    this.startTimer('eviction', 
      () => this.evictIdleResources(), 
      this.config.evictionRunInterval
    );
    
    // Start validation timer if enabled
    if (this.config.validateInterval > 0) {
      this.startTimer('validation',
        () => this.validateResources(),
        this.config.validateInterval
      );
    }
  }
  
  /**
   * Acquire a resource from the pool
   */
  async acquire() {
    const startTime = Date.now();
    
    try {
      // Try to get available resource
      let resource = this.getAvailableResource();
      
      if (!resource) {
        // Create new resource if under limit
        if (this.canCreateResource()) {
          resource = await this.createResource();
        } else {
          // Wait for available resource
          resource = await this.waitForResource(startTime);
        }
      }
      
      if (!resource) {
        this.poolMetrics.timeouts++;
        throw new Error('Failed to acquire resource: timeout');
      }
      
      // Mark as in use
      const wrapper = this.resources.get(resource);
      wrapper.inUse = true;
      wrapper.lastUsed = Date.now();
      wrapper.useCount++;
      
      this.poolMetrics.acquired++;
      this.updatePoolMetrics();
      
      return resource;
      
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }
  
  /**
   * Release a resource back to the pool
   */
  async release(resource) {
    const wrapper = this.resources.get(resource);
    if (!wrapper) {
      this.logger.warn('Attempted to release unknown resource');
      return;
    }
    
    try {
      // Validate before returning to pool
      if (await this.validateResource(resource)) {
        wrapper.inUse = false;
        wrapper.lastUsed = Date.now();
        
        // Add back to available
        this.availableResources.push(resource);
        
        // Notify waiting clients
        this.notifyWaitingClient();
      } else {
        // Destroy invalid resource
        await this.destroyResource(resource);
      }
      
      this.poolMetrics.released++;
      this.updatePoolMetrics();
      
    } catch (error) {
      this.logger.error('Error releasing resource:', error);
      await this.destroyResource(resource);
    }
  }
  
  /**
   * Get an available resource
   */
  getAvailableResource() {
    while (this.availableResources.length > 0) {
      const resource = this.availableResources.shift();
      const wrapper = this.resources.get(resource);
      
      if (wrapper && !wrapper.inUse) {
        return resource;
      }
    }
    
    return null;
  }
  
  /**
   * Check if we can create a new resource
   */
  canCreateResource() {
    const totalSize = this.resources.size + this.pendingCreates;
    return totalSize < this.config.maxSize;
  }
  
  /**
   * Create a new resource
   */
  async createResource() {
    this.pendingCreates++;
    
    try {
      const resource = await this.executeWithRetry(
        () => this.createResourceWithTimeout(),
        'createResource'
      );
      
      // Wrap resource
      this.resources.set(resource, {
        resource,
        created: Date.now(),
        lastUsed: Date.now(),
        useCount: 0,
        inUse: false
      });
      
      this.poolMetrics.created++;
      this.updatePoolMetrics();
      
      return resource;
      
    } finally {
      this.pendingCreates--;
    }
  }
  
  /**
   * Create resource with timeout
   */
  async createResourceWithTimeout() {
    return Promise.race([
      this.onCreateResource(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Resource creation timeout')), 
          this.config.createTimeout)
      )
    ]);
  }
  
  /**
   * Wait for an available resource
   */
  async waitForResource(startTime) {
    return new Promise((resolve, reject) => {
      const timeout = this.config.acquireTimeout - (Date.now() - startTime);
      
      if (timeout <= 0) {
        reject(new Error('Acquire timeout'));
        return;
      }
      
      const timeoutId = setTimeout(() => {
        const index = this.waitingClients.indexOf(client);
        if (index !== -1) {
          this.waitingClients.splice(index, 1);
        }
        reject(new Error('Acquire timeout'));
      }, timeout);
      
      const client = { resolve, reject, timeoutId };
      this.waitingClients.push(client);
      this.poolMetrics.waitingCount = this.waitingClients.length;
    });
  }
  
  /**
   * Notify a waiting client
   */
  notifyWaitingClient() {
    if (this.waitingClients.length === 0) return;
    
    const resource = this.getAvailableResource();
    if (!resource) return;
    
    const client = this.waitingClients.shift();
    this.poolMetrics.waitingCount = this.waitingClients.length;
    
    clearTimeout(client.timeoutId);
    client.resolve(resource);
  }
  
  /**
   * Ensure minimum resources exist
   */
  async ensureMinimumResources() {
    const promises = [];
    const currentSize = this.resources.size;
    const needed = this.config.minSize - currentSize;
    
    for (let i = 0; i < needed; i++) {
      promises.push(this.createResource().catch(error => {
        this.logger.error('Failed to create minimum resource:', error);
      }));
    }
    
    await Promise.all(promises);
  }
  
  /**
   * Destroy a resource
   */
  async destroyResource(resource) {
    const wrapper = this.resources.get(resource);
    if (!wrapper) return;
    
    try {
      this.resources.delete(resource);
      
      // Remove from available
      const index = this.availableResources.indexOf(resource);
      if (index !== -1) {
        this.availableResources.splice(index, 1);
      }
      
      // Call subclass destroy
      await this.onDestroyResource(resource);
      
      this.poolMetrics.destroyed++;
      this.updatePoolMetrics();
      
    } catch (error) {
      this.logger.error('Error destroying resource:', error);
    }
  }
  
  /**
   * Validate resources
   */
  async validateResources() {
    const promises = [];
    
    for (const [resource, wrapper] of this.resources) {
      if (!wrapper.inUse) {
        promises.push(this.validateAndHandleResource(resource));
      }
    }
    
    await Promise.all(promises);
  }
  
  /**
   * Validate and handle a single resource
   */
  async validateAndHandleResource(resource) {
    try {
      const isValid = await this.validateResource(resource);
      
      if (!isValid) {
        this.poolMetrics.validationFailures++;
        await this.destroyResource(resource);
      }
    } catch (error) {
      this.logger.error('Validation error:', error);
      await this.destroyResource(resource);
    }
  }
  
  /**
   * Validate a resource
   */
  async validateResource(resource) {
    try {
      return await this.onValidateResource(resource);
    } catch (error) {
      return false;
    }
  }
  
  /**
   * Evict idle resources
   */
  async evictIdleResources() {
    const now = Date.now();
    const promises = [];
    
    for (const [resource, wrapper] of this.resources) {
      if (!wrapper.inUse && 
          now - wrapper.lastUsed > this.config.idleTimeout &&
          this.resources.size > this.config.minSize) {
        promises.push(this.destroyResource(resource));
      }
    }
    
    await Promise.all(promises);
  }
  
  /**
   * Update pool metrics
   */
  updatePoolMetrics() {
    this.poolMetrics.currentSize = this.resources.size;
    this.poolMetrics.availableSize = this.availableResources.length;
    
    if (this.poolMetrics.currentSize > this.poolMetrics.peakSize) {
      this.poolMetrics.peakSize = this.poolMetrics.currentSize;
    }
  }
  
  /**
   * Get pool statistics
   */
  getPoolStats() {
    return {
      ...this.poolMetrics,
      pendingCreates: this.pendingCreates,
      utilization: this.poolMetrics.currentSize > 0 
        ? (this.poolMetrics.currentSize - this.poolMetrics.availableSize) / this.poolMetrics.currentSize
        : 0
    };
  }
  
  /**
   * Drain the pool
   */
  async drain() {
    // Stop accepting new acquires
    this.draining = true;
    
    // Wait for all resources to be released
    while (this.poolMetrics.currentSize > this.poolMetrics.availableSize) {
      await this.delay(100);
    }
    
    // Destroy all resources
    const promises = [];
    for (const resource of this.resources.keys()) {
      promises.push(this.destroyResource(resource));
    }
    
    await Promise.all(promises);
  }
  
  /**
   * Shutdown the pool
   */
  async onShutdown() {
    await this.drain();
  }
  
  /**
   * Override in subclasses to create resource
   */
  async onCreateResource() {
    throw new Error('onCreateResource must be implemented by subclass');
  }
  
  /**
   * Override in subclasses to destroy resource
   */
  async onDestroyResource(resource) {
    throw new Error('onDestroyResource must be implemented by subclass');
  }
  
  /**
   * Override in subclasses to validate resource
   */
  async onValidateResource(resource) {
    return true;
  }
  
  /**
   * Health check
   */
  async onHealthCheck() {
    const stats = this.getPoolStats();
    
    return {
      pool: {
        size: stats.currentSize,
        available: stats.availableSize,
        waiting: stats.waitingCount,
        utilization: stats.utilization
      }
    };
  }
}

module.exports = BasePool;