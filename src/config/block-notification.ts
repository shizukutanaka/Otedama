// Block Notification Configuration
export interface BlockNotificationConfig {
  // Notification channels
  channels: {
    websocket: {
      enabled: boolean;
      maxConnections: number;
      pingInterval: number; // milliseconds
      maxPingTimeout: number; // milliseconds
    };
    email: {
      enabled: boolean;
      template: string;
      maxRecipients: number;
      cooldown: number; // seconds
    };
    webhook: {
      enabled: boolean;
      urls: string[];
      timeout: number; // milliseconds
      retryCount: number;
      retryDelay: number; // milliseconds
    };
    sms: {
      enabled: boolean;
      provider: string;
      apiKey: string;
      maxRecipients: number;
    };
  };
  
  // Notification content
  content: {
    includeBlockDetails: boolean;
    includePoolStats: boolean;
    includeMinerStats: boolean;
    includeNetworkStats: boolean;
  };
  
  // Performance settings
  performance: {
    maxNotificationsPerSecond: number;
    queueSize: number;
    retryCount: number;
    retryDelay: number; // milliseconds
  };
  
  // Security settings
  security: {
    rateLimit: number; // notifications per minute
    ipWhitelist: string[];
    maxMessageSize: number; // bytes
  };
  
  // Templates
  templates: {
    subject: string;
    body: string;
    webhook: string;
    email: string;
    sms: string;
  };
}

// Default configuration
export const defaultBlockNotificationConfig: BlockNotificationConfig = {
  channels: {
    websocket: {
      enabled: true,
      maxConnections: 1000,
      pingInterval: 30000,
      maxPingTimeout: 60000
    },
    email: {
      enabled: false,
      template: 'default',
      maxRecipients: 100,
      cooldown: 300 // 5 minutes
    },
    webhook: {
      enabled: true,
      urls: [],
      timeout: 5000,
      retryCount: 3,
      retryDelay: 1000
    },
    sms: {
      enabled: false,
      provider: 'twilio',
      apiKey: '',
      maxRecipients: 10
    }
  },
  
  content: {
    includeBlockDetails: true,
    includePoolStats: true,
    includeMinerStats: true,
    includeNetworkStats: true
  },
  
  performance: {
    maxNotificationsPerSecond: 100,
    queueSize: 1000,
    retryCount: 3,
    retryDelay: 1000
  },
  
  security: {
    rateLimit: 1000,
    ipWhitelist: ['127.0.0.1'],
    maxMessageSize: 1024 * 1024 // 1MB
  },
  
  templates: {
    subject: '[Otedama Pool] New Block Found - {{blockNumber}}',
    body: 'New block found:\n\n' +
           'Block Number: {{blockNumber}}\n' +
           'Block Hash: {{blockHash}}\n' +
           'Time: {{timestamp}}\n\n' +
           'Pool Stats:\n' +
           'Miners: {{minerCount}}\n' +
           'Hashrate: {{hashrate}} H/s\n\n' +
           'Network Stats:\n' +
           'Difficulty: {{difficulty}}\n' +
           'Block Time: {{blockTime}}s',
    webhook: {
      type: 'block_notification',
      block: {
        number: '{{blockNumber}}',
        hash: '{{blockHash}}',
        timestamp: '{{timestamp}}'
      },
      pool: {
        miners: '{{minerCount}}',
        hashrate: '{{hashrate}}'
      },
      network: {
        difficulty: '{{difficulty}}',
        blockTime: '{{blockTime}}'
      }
    },
    email: 'New block found:\n\n{{blockDetails}}\n\nPool Stats:\n{{poolStats}}\n\nNetwork Stats:\n{{networkStats}}',
    sms: 'New block {{blockNumber}} found! Pool hashrate: {{hashrate}} H/s'
  }
};

// Load configuration from environment or config file
export function loadBlockNotificationConfig(): BlockNotificationConfig {
  // In a real implementation, this would load from a config file or environment variables
  // For now, just return the default config
  return defaultBlockNotificationConfig;
}
