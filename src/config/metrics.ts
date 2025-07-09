// Metrics Collection Configuration
export interface MetricsConfig {
  // Collection intervals
  intervals: {
    system: number;        // System metrics interval (seconds)
    pool: number;         // Pool metrics interval (seconds)
    miner: number;        // Miner metrics interval (seconds)
    network: number;      // Network metrics interval (seconds)
  };
  
  // Storage settings
  storage: {
    type: 'file' | 'database' | 'influxdb';
    retention: number;    // Days to keep metrics
    batchSize: number;    // Batch size for writes
    compression: boolean;  // Compress metrics data
  };
  
  // System metrics
  system: {
    cpu: {
      enabled: boolean;
      cores: boolean;
      temperature: boolean;
    };
    memory: {
      enabled: boolean;
      swap: boolean;
    };
    disk: {
      enabled: boolean;
      iops: boolean;
      latency: boolean;
    };
    network: {
      enabled: boolean;
      interfaces: string[];
      latency: boolean;
    };
  };
  
  // Pool metrics
  pool: {
    hashrate: {
      enabled: boolean;
      interval: number;    // Hashrate calculation interval (seconds)
      precision: number;   // Number of decimal places
    };
    shares: {
      enabled: boolean;
      valid: boolean;
      invalid: boolean;
      stale: boolean;
    };
    blocks: {
      enabled: boolean;
      found: boolean;
      confirmed: boolean;
      orphaned: boolean;
    };
  };
  
  // Miner metrics
  miner: {
    hashrate: {
      enabled: boolean;
      window: number;      // Hashrate calculation window (seconds)
    };
    shares: {
      enabled: boolean;
      valid: boolean;
      invalid: boolean;
      stale: boolean;
    };
    uptime: {
      enabled: boolean;
      checkInterval: number; // Uptime check interval (seconds)
    };
  };
  
  // Network metrics
  network: {
    latency: {
      enabled: boolean;
      targets: string[];
      timeout: number;     // Ping timeout (milliseconds)
    };
    bandwidth: {
      enabled: boolean;
      interfaces: string[];
    };
    connections: {
      enabled: boolean;
      max: number;
      timeout: number;     // Connection timeout (seconds)
    };
  };
  
  // Export settings
  export: {
    enabled: boolean;
    formats: {
      json: boolean;
      csv: boolean;
      prometheus: boolean;
    };
    endpoints: {
      http: {
        enabled: boolean;
        port: number;
        path: string;
      };
      websocket: {
        enabled: boolean;
        port: number;
        path: string;
      };
    };
  };
  
  // Alert thresholds
  alerts: {
    cpu: number;           // CPU usage threshold (%)
    memory: number;        // Memory usage threshold (%)
    disk: number;          // Disk usage threshold (%)
    network: number;       // Network latency threshold (ms)
    hashrateDrop: number;  // Hashrate drop threshold (%)
    shareInvalid: number;  // Invalid share threshold (%)
  };
}

// Default configuration
export const defaultMetricsConfig: MetricsConfig = {
  intervals: {
    system: 60,
    pool: 30,
    miner: 15,
    network: 60
  },
  
  storage: {
    type: 'database',
    retention: 30,
    batchSize: 1000,
    compression: true
  },
  
  system: {
    cpu: {
      enabled: true,
      cores: true,
      temperature: true
    },
    memory: {
      enabled: true,
      swap: true
    },
    disk: {
      enabled: true,
      iops: true,
      latency: true
    },
    network: {
      enabled: true,
      interfaces: ['eth0', 'en0'],
      latency: true
    }
  },
  
  pool: {
    hashrate: {
      enabled: true,
      interval: 30,
      precision: 2
    },
    shares: {
      enabled: true,
      valid: true,
      invalid: true,
      stale: true
    },
    blocks: {
      enabled: true,
      found: true,
      confirmed: true,
      orphaned: true
    }
  },
  
  miner: {
    hashrate: {
      enabled: true,
      window: 60
    },
    shares: {
      enabled: true,
      valid: true,
      invalid: true,
      stale: true
    },
    uptime: {
      enabled: true,
      checkInterval: 300
    }
  },
  
  network: {
    latency: {
      enabled: true,
      targets: ['8.8.8.8', '1.1.1.1'],
      timeout: 1000
    },
    bandwidth: {
      enabled: true,
      interfaces: ['eth0', 'en0']
    },
    connections: {
      enabled: true,
      max: 1000,
      timeout: 30
    }
  },
  
  export: {
    enabled: true,
    formats: {
      json: true,
      csv: true,
      prometheus: true
    },
    endpoints: {
      http: {
        enabled: true,
        port: 9090,
        path: '/metrics'
      },
      websocket: {
        enabled: true,
        port: 9091,
        path: '/ws/metrics'
      }
    }
  },
  
  alerts: {
    cpu: 90,
    memory: 90,
    disk: 90,
    network: 100,
    hashrateDrop: 30,
    shareInvalid: 5
  }
};

// Load configuration from environment or config file
export function loadMetricsConfig(): MetricsConfig {
  // In a real implementation, this would load from a config file or environment variables
  // For now, just return the default config
  return defaultMetricsConfig;
}
