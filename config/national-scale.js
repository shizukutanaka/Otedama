/**
 * National-Scale Configuration - Otedama
 * Practical configuration for large-scale deployment
 * 
 * This configuration supports:
 * - Millions of concurrent miners
 * - Multi-region deployment
 * - Auto-scaling
 * - High availability
 */

export default {
  // Basic pool configuration
  pool: {
    name: "Otedama National Mining Pool",
    algorithm: "sha256",
    coin: "BTC",
    fee: 0.01, // 1%
    minPayout: 0.001,
    payoutInterval: 3600, // 1 hour
    
    // High-performance settings
    maxConnections: 1000000, // 1M connections per instance
    maxSharesPerSecond: 100000, // 100K shares/sec per instance
    targetLatency: 1, // 1ms target latency
    
    // Geographic distribution
    regions: [
      "us-east-1",
      "us-west-1", 
      "eu-west-1",
      "eu-central-1",
      "asia-northeast-1",
      "asia-southeast-1"
    ]
  },
  
  // Auto-scaling configuration
  scaling: {
    enabled: true,
    minWorkers: 4,
    maxWorkers: 64,
    targetCPU: 70,
    targetMemory: 80,
    scaleUpThreshold: 85,
    scaleDownThreshold: 40,
    checkInterval: 15000, // 15 seconds
    cooldownPeriod: 180000, // 3 minutes
    
    // Instance scaling
    minInstances: 2,
    maxInstances: 100,
    instanceTypes: ["c5.xlarge", "c5.2xlarge", "c5.4xlarge"],
    
    // Scaling triggers
    triggers: {
      cpuThreshold: 80,
      memoryThreshold: 85,
      connectionThreshold: 900000, // 90% of max connections
      latencyThreshold: 5 // 5ms
    }
  },
  
  // Load balancing
  loadBalancer: {
    algorithm: "round_robin", // round_robin, least_connections, ip_hash
    healthCheck: {
      enabled: true,
      interval: 10000, // 10 seconds
      timeout: 3000, // 3 seconds
      retries: 3,
      path: "/health"
    },
    
    // Session affinity for miners
    stickySession: {
      enabled: true,
      cookieName: "miner_session",
      duration: 3600 // 1 hour
    }
  },
  
  // High availability
  highAvailability: {
    enabled: true,
    replicationFactor: 3,
    crossRegion: true,
    autoFailover: true,
    backupRegions: ["us-west-2", "eu-north-1", "asia-south-1"],
    
    // Data synchronization
    syncInterval: 30000, // 30 seconds
    conflictResolution: "timestamp" // timestamp, version, manual
  },
  
  // Database configuration for scale
  database: {
    type: "postgresql", // postgresql, mysql, mongodb
    cluster: {
      enabled: true,
      readReplicas: 5,
      writeNodes: 2,
      sharding: {
        enabled: true,
        shardKey: "miner_id",
        shardCount: 64
      }
    },
    
    // Connection pooling
    connectionPool: {
      min: 10,
      max: 100,
      acquireTimeoutMillis: 3000,
      idleTimeoutMillis: 30000
    },
    
    // Performance optimization
    optimization: {
      indexing: "automatic",
      partitioning: "time_based", // time_based, hash_based
      compression: true,
      archival: {
        enabled: true,
        retentionDays: 90,
        archiveAfterDays: 30
      }
    }
  },
  
  // Caching for performance
  cache: {
    type: "redis", // redis, memcached, in_memory
    cluster: {
      enabled: true,
      nodes: 6,
      replicas: 2
    },
    
    // Cache strategies
    strategies: {
      shares: {
        ttl: 300, // 5 minutes
        strategy: "write_through"
      },
      miners: {
        ttl: 3600, // 1 hour
        strategy: "lazy_loading"
      },
      jobs: {
        ttl: 60, // 1 minute
        strategy: "write_around"
      }
    }
  },
  
  // Monitoring and observability
  monitoring: {
    enabled: true,
    metricsInterval: 10000, // 10 seconds
    
    // Metrics to track
    metrics: [
      "cpu_usage",
      "memory_usage",
      "connection_count",
      "shares_per_second",
      "latency_p95",
      "error_rate",
      "throughput"
    ],
    
    // Alerting
    alerts: {
      enabled: true,
      channels: ["email", "slack", "webhook"],
      thresholds: {
        cpu: 90,
        memory: 95,
        latency: 10,
        errorRate: 5
      }
    },
    
    // External monitoring
    external: {
      prometheus: {
        enabled: true,
        port: 9090,
        path: "/metrics"
      },
      grafana: {
        enabled: true,
        dashboards: ["pool_overview", "performance", "miners"]
      }
    }
  },
  
  // Security for national-scale
  security: {
    // DDoS protection
    ddosProtection: {
      enabled: true,
      maxConnections: 10000, // per IP
      rateLimiting: {
        windowMs: 60000, // 1 minute
        maxRequests: 1000 // per IP per minute
      },
      
      // Geographic restrictions
      geoBlocking: {
        enabled: false, // Set to true to enable
        allowedCountries: ["US", "CA", "EU"],
        blockedCountries: []
      }
    },
    
    // Encryption
    encryption: {
      tls: {
        enabled: true,
        version: "1.3",
        ciphers: ["TLS_AES_256_GCM_SHA384", "TLS_CHACHA20_POLY1305_SHA256"]
      },
      
      // Data encryption
      dataEncryption: {
        enabled: true,
        algorithm: "AES-256-GCM",
        keyRotation: 86400000 // 24 hours
      }
    },
    
    // Audit logging
    audit: {
      enabled: true,
      events: ["login", "share_submit", "payout", "config_change"],
      retention: 2592000000, // 30 days
      compliance: ["SOX", "GDPR", "CCPA"]
    }
  },
  
  // Network optimization
  network: {
    // TCP optimization
    tcp: {
      keepAlive: true,
      noDelay: true,
      reuseAddress: true,
      socketTimeout: 30000
    },
    
    // Connection limits
    limits: {
      maxConnections: 1000000,
      maxConnectionsPerIP: 100,
      connectionTimeout: 30000,
      idleTimeout: 300000
    },
    
    // Bandwidth management
    bandwidth: {
      limitPerConnection: 1048576, // 1MB/s
      totalLimit: 10737418240, // 10GB/s
      prioritizeByHashrate: true
    }
  },
  
  // Performance tuning
  performance: {
    // Worker optimization
    workers: {
      useAllCPUs: true,
      cpuAffinity: true,
      priorityClass: "high"
    },
    
    // Memory optimization  
    memory: {
      bufferPoolSize: 1000,
      maxBufferAge: 60000,
      gcOptimization: true,
      preAllocateBuffers: true
    },
    
    // Disk I/O
    io: {
      asyncWrites: true,
      batchWrites: true,
      compression: true,
      writeBufferSize: 65536
    }
  },
  
  // Backup and disaster recovery
  backup: {
    enabled: true,
    strategy: "incremental",
    interval: 3600000, // 1 hour
    retention: 30, // 30 backups
    
    // Multi-region backup
    regions: ["us-west-2", "eu-north-1"],
    encryption: true,
    compression: true,
    
    // Recovery testing
    testing: {
      enabled: true,
      frequency: "weekly",
      automated: true
    }
  },
  
  // Feature flags for gradual rollout
  features: {
    // New features can be toggled
    advancedDifficulty: true,
    smartRouting: true,
    predictiveScaling: false, // Experimental
    mlOptimization: false, // Disabled for simplicity
    
    // Regional features
    regional: {
      "us": { complianceMode: "strict" },
      "eu": { complianceMode: "gdpr" },
      "asia": { complianceMode: "standard" }
    }
  }
};