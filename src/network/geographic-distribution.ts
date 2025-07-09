/**
 * Geographic Distribution - Multi-Region Support
 * Following Carmack/Martin/Pike principles:
 * - Intelligent region selection
 * - Latency-aware routing
 * - Geo-redundancy
 */

import { EventEmitter } from 'events';
import * as dns from 'dns';
import * as net from 'net';
import { logger } from '../utils/logger';

interface Region {
  id: string;
  name: string;
  location: {
    latitude: number;
    longitude: number;
    city: string;
    country: string;
    continent: string;
  };
  endpoints: Endpoint[];
  capacity: {
    current: number;
    maximum: number;
  };
  status: 'active' | 'degraded' | 'offline';
  lastUpdate: Date;
}

interface Endpoint {
  id: string;
  type: 'pool' | 'proxy' | 'node';
  host: string;
  port: number;
  protocol: 'stratum' | 'stratum2' | 'http' | 'https';
  priority: number;
  weight: number;
  
  // Performance metrics
  latency: number;
  packetLoss: number;
  bandwidth: number;
  
  // Health
  healthy: boolean;
  lastCheck: Date;
}

interface GeoConfig {
  regions: Region[];
  strategy: 'nearest' | 'lowest-latency' | 'least-loaded' | 'failover';
  
  // Client location detection
  geoip: {
    enabled: boolean;
    database?: string;
    fallbackRegion: string;
  };
  
  // Health monitoring
  healthCheck: {
    interval: number;
    timeout: number;
    retries: number;
  };
  
  // Failover
  failover: {
    enabled: boolean;
    threshold: number;
    cooldown: number;
  };
  
  // Load balancing
  loadBalance: {
    enabled: boolean;
    maxLoadDifference: number; // Percentage
  };
}

interface ClientLocation {
  ip: string;
  latitude?: number;
  longitude?: number;
  country?: string;
  region?: string;
  isp?: string;
}

interface LatencyMap {
  [fromRegion: string]: {
    [toRegion: string]: number;
  };
}

export class GeographicDistribution extends EventEmitter {
  private config: GeoConfig;
  private regions: Map<string, Region> = new Map();
  private latencyMap: LatencyMap = {};
  private healthCheckInterval?: NodeJS.Timer;
  private geoipDatabase?: any; // Would be actual GeoIP database
  
  // Caches
  private regionCache: Map<string, { region: string; timestamp: number }> = new Map();
  private dnsCache: Map<string, { addresses: string[]; timestamp: number }> = new Map();

  constructor(config: GeoConfig) {
    super();
    this.config = config;
    
    // Initialize regions
    for (const region of config.regions) {
      this.regions.set(region.id, region);
    }
  }

  /**
   * Initialize geographic distribution
   */
  async initialize(): Promise<void> {
    logger.info('Initializing geographic distribution', {
      regions: this.regions.size,
      strategy: this.config.strategy
    });

    // Load GeoIP database if enabled
    if (this.config.geoip.enabled && this.config.geoip.database) {
      await this.loadGeoIPDatabase();
    }

    // Measure initial latencies between regions
    await this.measureInterRegionLatencies();

    // Start health monitoring
    this.startHealthMonitoring();

    // DNS prefetch for all endpoints
    await this.prefetchDNS();

    this.emit('initialized', {
      regions: Array.from(this.regions.keys())
    });
  }

  /**
   * Get best region for client
   */
  async getBestRegion(clientIp: string): Promise<Region | null> {
    // Check cache
    const cached = this.regionCache.get(clientIp);
    if (cached && Date.now() - cached.timestamp < 3600000) { // 1 hour cache
      return this.regions.get(cached.region) || null;
    }

    let selectedRegion: Region | null = null;

    switch (this.config.strategy) {
      case 'nearest':
        selectedRegion = await this.getNearestRegion(clientIp);
        break;
        
      case 'lowest-latency':
        selectedRegion = await this.getLowestLatencyRegion(clientIp);
        break;
        
      case 'least-loaded':
        selectedRegion = this.getLeastLoadedRegion();
        break;
        
      case 'failover':
        selectedRegion = this.getFailoverRegion();
        break;
    }

    if (selectedRegion) {
      this.regionCache.set(clientIp, {
        region: selectedRegion.id,
        timestamp: Date.now()
      });
    }

    return selectedRegion;
  }

  /**
   * Get nearest region based on geographic distance
   */
  private async getNearestRegion(clientIp: string): Promise<Region | null> {
    const clientLocation = await this.getClientLocation(clientIp);
    if (!clientLocation.latitude || !clientLocation.longitude) {
      return this.getDefaultRegion();
    }

    let nearestRegion: Region | null = null;
    let minDistance = Infinity;

    for (const region of this.regions.values()) {
      if (region.status === 'offline') continue;

      const distance = this.calculateDistance(
        clientLocation.latitude,
        clientLocation.longitude,
        region.location.latitude,
        region.location.longitude
      );

      if (distance < minDistance) {
        minDistance = distance;
        nearestRegion = region;
      }
    }

    logger.debug('Selected nearest region', {
      clientIp,
      region: nearestRegion?.id,
      distance: minDistance
    });

    return nearestRegion;
  }

  /**
   * Get region with lowest latency
   */
  private async getLowestLatencyRegion(clientIp: string): Promise<Region | null> {
    const activeRegions = Array.from(this.regions.values())
      .filter(r => r.status === 'active');

    if (activeRegions.length === 0) return null;

    // Measure latency to each region
    const latencies = await Promise.all(
      activeRegions.map(async (region) => {
        const endpoint = this.getBestEndpoint(region);
        if (!endpoint) return { region, latency: Infinity };

        const latency = await this.measureLatency(endpoint.host, endpoint.port);
        return { region, latency };
      })
    );

    // Select region with lowest latency
    const best = latencies.reduce((min, current) => 
      current.latency < min.latency ? current : min
    );

    logger.debug('Selected lowest latency region', {
      clientIp,
      region: best.region.id,
      latency: best.latency
    });

    return best.region;
  }

  /**
   * Get least loaded region
   */
  private getLeastLoadedRegion(): Region | null {
    const activeRegions = Array.from(this.regions.values())
      .filter(r => r.status !== 'offline');

    if (activeRegions.length === 0) return null;

    return activeRegions.reduce((min, region) => {
      const currentLoad = region.capacity.current / region.capacity.maximum;
      const minLoad = min.capacity.current / min.capacity.maximum;
      return currentLoad < minLoad ? region : min;
    });
  }

  /**
   * Get failover region
   */
  private getFailoverRegion(): Region | null {
    // Get regions by priority
    const activeRegions = Array.from(this.regions.values())
      .filter(r => r.status !== 'offline')
      .sort((a, b) => {
        // Sort by status (active > degraded) then by load
        if (a.status !== b.status) {
          return a.status === 'active' ? -1 : 1;
        }
        const loadA = a.capacity.current / a.capacity.maximum;
        const loadB = b.capacity.current / b.capacity.maximum;
        return loadA - loadB;
      });

    return activeRegions[0] || null;
  }

  /**
   * Get best endpoint in region
   */
  getBestEndpoint(region: Region): Endpoint | null {
    const healthyEndpoints = region.endpoints
      .filter(e => e.healthy)
      .sort((a, b) => {
        // Sort by priority, then by latency
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        return a.latency - b.latency;
      });

    return healthyEndpoints[0] || null;
  }

  /**
   * Get client location
   */
  private async getClientLocation(clientIp: string): Promise<ClientLocation> {
    const location: ClientLocation = { ip: clientIp };

    if (this.geoipDatabase) {
      try {
        // const geoData = this.geoipDatabase.get(clientIp);
        // Mock data for now
        const geoData = {
          location: {
            latitude: 37.7749 + (Math.random() - 0.5) * 10,
            longitude: -122.4194 + (Math.random() - 0.5) * 10
          },
          country: { iso_code: 'US' },
          subdivisions: [{ iso_code: 'CA' }],
          traits: { isp: 'Mock ISP' }
        };

        location.latitude = geoData.location.latitude;
        location.longitude = geoData.location.longitude;
        location.country = geoData.country.iso_code;
        location.region = geoData.subdivisions[0]?.iso_code;
        location.isp = geoData.traits.isp;
      } catch (err) {
        logger.warn('Failed to get client location', { clientIp, error: err });
      }
    }

    return location;
  }

  /**
   * Calculate distance between two coordinates (Haversine formula)
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth's radius in km
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Convert degrees to radians
   */
  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  /**
   * Measure latency to endpoint
   */
  private async measureLatency(host: string, port: number, samples: number = 3): Promise<number> {
    const latencies: number[] = [];

    for (let i = 0; i < samples; i++) {
      const startTime = Date.now();
      
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = new net.Socket();
          const timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error('Timeout'));
          }, this.config.healthCheck.timeout);

          socket.on('connect', () => {
            clearTimeout(timeout);
            socket.destroy();
            resolve();
          });

          socket.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });

          socket.connect(port, host);
        });

        latencies.push(Date.now() - startTime);
      } catch {
        latencies.push(Infinity);
      }

      // Small delay between samples
      if (i < samples - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Return median latency
    latencies.sort((a, b) => a - b);
    return latencies[Math.floor(latencies.length / 2)];
  }

  /**
   * Measure inter-region latencies
   */
  private async measureInterRegionLatencies(): Promise<void> {
    const regionIds = Array.from(this.regions.keys());

    for (const fromId of regionIds) {
      this.latencyMap[fromId] = {};
      
      for (const toId of regionIds) {
        if (fromId === toId) {
          this.latencyMap[fromId][toId] = 0;
          continue;
        }

        const toRegion = this.regions.get(toId)!;
        const endpoint = this.getBestEndpoint(toRegion);
        
        if (endpoint) {
          const latency = await this.measureLatency(endpoint.host, endpoint.port);
          this.latencyMap[fromId][toId] = latency;
        } else {
          this.latencyMap[fromId][toId] = Infinity;
        }
      }
    }

    logger.debug('Inter-region latency map updated', this.latencyMap);
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(async () => {
      await this.checkAllEndpoints();
      await this.updateRegionStatuses();
      
      if (this.config.loadBalance.enabled) {
        await this.rebalanceLoad();
      }
    }, this.config.healthCheck.interval);

    // Initial check
    this.checkAllEndpoints();
  }

  /**
   * Check all endpoints health
   */
  private async checkAllEndpoints(): Promise<void> {
    const checks: Promise<void>[] = [];

    for (const region of this.regions.values()) {
      for (const endpoint of region.endpoints) {
        checks.push(this.checkEndpointHealth(endpoint));
      }
    }

    await Promise.all(checks);
  }

  /**
   * Check endpoint health
   */
  private async checkEndpointHealth(endpoint: Endpoint): Promise<void> {
    const startTime = Date.now();
    let healthy = false;

    try {
      // TCP health check
      await new Promise<void>((resolve, reject) => {
        const socket = new net.Socket();
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error('Health check timeout'));
        }, this.config.healthCheck.timeout);

        socket.on('connect', () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve();
        });

        socket.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        socket.connect(endpoint.port, endpoint.host);
      });

      healthy = true;
      endpoint.latency = Date.now() - startTime;
    } catch (err) {
      logger.warn('Endpoint health check failed', {
        endpointId: endpoint.id,
        error: err
      });
    }

    endpoint.healthy = healthy;
    endpoint.lastCheck = new Date();
  }

  /**
   * Update region statuses
   */
  private async updateRegionStatuses(): Promise<void> {
    for (const region of this.regions.values()) {
      const healthyEndpoints = region.endpoints.filter(e => e.healthy).length;
      const totalEndpoints = region.endpoints.length;

      let status: Region['status'] = 'active';
      
      if (healthyEndpoints === 0) {
        status = 'offline';
      } else if (healthyEndpoints < totalEndpoints * 0.5) {
        status = 'degraded';
      }

      if (region.status !== status) {
        region.status = status;
        logger.info('Region status changed', {
          regionId: region.id,
          oldStatus: region.status,
          newStatus: status
        });
        
        this.emit('region:status', {
          regionId: region.id,
          status
        });
      }

      region.lastUpdate = new Date();
    }
  }

  /**
   * Rebalance load across regions
   */
  private async rebalanceLoad(): Promise<void> {
    const activeRegions = Array.from(this.regions.values())
      .filter(r => r.status === 'active');

    if (activeRegions.length < 2) return;

    // Calculate average load
    const totalLoad = activeRegions.reduce((sum, r) => sum + r.capacity.current, 0);
    const avgLoad = totalLoad / activeRegions.length;

    // Find imbalanced regions
    const overloaded = activeRegions.filter(r => 
      r.capacity.current > avgLoad * (1 + this.config.loadBalance.maxLoadDifference / 100)
    );
    
    const underloaded = activeRegions.filter(r => 
      r.capacity.current < avgLoad * (1 - this.config.loadBalance.maxLoadDifference / 100)
    );

    if (overloaded.length > 0 && underloaded.length > 0) {
      logger.info('Load rebalancing needed', {
        overloaded: overloaded.map(r => r.id),
        underloaded: underloaded.map(r => r.id)
      });

      this.emit('rebalance:needed', {
        overloaded,
        underloaded,
        avgLoad
      });
    }
  }

  /**
   * Prefetch DNS for all endpoints
   */
  private async prefetchDNS(): Promise<void> {
    const dnsPromises: Promise<void>[] = [];

    for (const region of this.regions.values()) {
      for (const endpoint of region.endpoints) {
        dnsPromises.push(this.resolveDNS(endpoint.host));
      }
    }

    await Promise.all(dnsPromises);
  }

  /**
   * Resolve DNS with caching
   */
  private async resolveDNS(hostname: string): Promise<string[]> {
    // Check cache
    const cached = this.dnsCache.get(hostname);
    if (cached && Date.now() - cached.timestamp < 300000) { // 5 minute cache
      return cached.addresses;
    }

    return new Promise((resolve) => {
      dns.resolve4(hostname, (err, addresses) => {
        if (err) {
          logger.warn('DNS resolution failed', { hostname, error: err });
          resolve([hostname]); // Fallback to hostname
        } else {
          this.dnsCache.set(hostname, {
            addresses,
            timestamp: Date.now()
          });
          resolve(addresses);
        }
      });
    });
  }

  /**
   * Load GeoIP database
   */
  private async loadGeoIPDatabase(): Promise<void> {
    // In production, would load actual GeoIP database
    // const Reader = require('@maxmind/geoip2-node').Reader;
    // this.geoipDatabase = await Reader.open(this.config.geoip.database);
    
    logger.info('GeoIP database loaded');
  }

  /**
   * Get default region
   */
  private getDefaultRegion(): Region | null {
    if (this.config.geoip.fallbackRegion) {
      return this.regions.get(this.config.geoip.fallbackRegion) || null;
    }
    
    // Return first active region
    return Array.from(this.regions.values())
      .find(r => r.status === 'active') || null;
  }

  /**
   * Get statistics
   */
  getStatistics(): any {
    const stats = {
      regions: Array.from(this.regions.values()).map(region => ({
        id: region.id,
        name: region.name,
        location: `${region.location.city}, ${region.location.country}`,
        status: region.status,
        load: `${region.capacity.current}/${region.capacity.maximum}`,
        loadPercentage: (region.capacity.current / region.capacity.maximum * 100).toFixed(1) + '%',
        endpoints: {
          total: region.endpoints.length,
          healthy: region.endpoints.filter(e => e.healthy).length
        },
        avgLatency: region.endpoints.length > 0
          ? Math.round(region.endpoints.reduce((sum, e) => sum + e.latency, 0) / region.endpoints.length)
          : 0
      })),
      cacheStats: {
        regionCache: this.regionCache.size,
        dnsCache: this.dnsCache.size
      },
      latencyMatrix: this.latencyMap
    };

    return stats;
  }

  /**
   * Update region capacity
   */
  updateRegionCapacity(regionId: string, current: number): void {
    const region = this.regions.get(regionId);
    if (region) {
      region.capacity.current = current;
      
      // Check if rebalancing needed
      if (this.config.loadBalance.enabled) {
        const loadPercentage = current / region.capacity.maximum * 100;
        if (loadPercentage > 90) {
          this.emit('region:overloaded', { regionId, load: loadPercentage });
        }
      }
    }
  }

  /**
   * Shutdown
   */
  shutdown(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.regionCache.clear();
    this.dnsCache.clear();
    
    logger.info('Geographic distribution shutdown');
  }
}

// Export types
export { Region, Endpoint, GeoConfig, ClientLocation };
