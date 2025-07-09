// Alert Configuration
export interface AlertConfig {
  // Alert levels and thresholds
  thresholds: {
    warning: number;    // Warning threshold (0-100)
    critical: number;   // Critical threshold (0-100)
    emergency: number;  // Emergency threshold (0-100)
  };
  
  // Alert types
  types: {
    performance: {
      memoryUsage: number;    // Memory usage threshold (%)
      cpuUsage: number;      // CPU usage threshold (%)
      networkLatency: number; // Network latency threshold (ms)
    };
    pool: {
      minerCount: number;     // Minimum miner count
      hashrate: number;       // Minimum hashrate (H/s)
      blockTime: number;      // Maximum block time (s)
    };
    security: {
      ddosAttempts: number;   // Maximum DDoS attempts
      failedAuth: number;     // Maximum failed auth attempts
      suspiciousConnections: number; // Maximum suspicious connections
    };
  };
  
  // Notification settings
  notifications: {
    enabled: boolean;
    methods: {
      email: {
        enabled: boolean;
        recipients: string[];
        smtp: {
          host: string;
          port: number;
          user: string;
          password: string;
        };
      };
      webhook: {
        enabled: boolean;
        urls: string[];
      };
      console: {
        enabled: boolean;
        level: 'warning' | 'critical' | 'emergency';
      };
    };
  };
  
  // Alert cooldown periods
  cooldown: {
    warning: number;    // Cooldown period in milliseconds
    critical: number;   // Cooldown period in milliseconds
    emergency: number;  // Cooldown period in milliseconds
  };
  
  // Alert message templates
  templates: {
    performance: string;
    pool: string;
    security: string;
  };
}

// Default configuration
export const defaultAlertConfig: AlertConfig = {
  thresholds: {
    warning: 70,
    critical: 85,
    emergency: 95
  },
  
  types: {
    performance: {
      memoryUsage: 90,
      cpuUsage: 95,
      networkLatency: 500
    },
    pool: {
      minerCount: 10,
      hashrate: 1000000, // 1MH/s
      blockTime: 300
    },
    security: {
      ddosAttempts: 100,
      failedAuth: 5,
      suspiciousConnections: 20
    }
  },
  
  notifications: {
    enabled: true,
    methods: {
      email: {
        enabled: false,
        recipients: [],
        smtp: {
          host: '',
          port: 587,
          user: '',
          password: ''
        }
      },
      webhook: {
        enabled: true,
        urls: []
      },
      console: {
        enabled: true,
        level: 'warning'
      }
    }
  },
  
  cooldown: {
    warning: 300000,    // 5 minutes
    critical: 600000,   // 10 minutes
    emergency: 1800000  // 30 minutes
  },
  
  templates: {
    performance: 'Performance alert: {{type}} is {{value}}% (threshold: {{threshold}}%)',
    pool: 'Pool alert: {{type}} is {{value}} (threshold: {{threshold}})',
    security: 'Security alert: {{type}} detected (count: {{count}})'
  }
};

// Load configuration from environment or config file
export function loadAlertConfig(): AlertConfig {
  // In a real implementation, this would load from a config file or environment variables
  // For now, just return the default config
  return defaultAlertConfig;
}
