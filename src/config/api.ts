// API Configuration
export interface APIConfig {
  // Server settings
  server: {
    port: number;
    host: string;
    maxConnections: number;
    timeout: number; // milliseconds
    keepAliveTimeout: number; // milliseconds
  };
  
  // Security settings
  security: {
    enabled: boolean;
    rateLimit: {
      window: number; // seconds
      max: number;   // requests per window
    };
    auth: {
      enabled: boolean;
      methods: string[];
      tokenExpiration: number; // seconds
    };
  };
  
  // Endpoints
  endpoints: {
    stats: {
      enabled: boolean;
      path: string;
      cache: number; // seconds
    };
    miners: {
      enabled: boolean;
      path: string;
      limit: number;
    };
    blocks: {
      enabled: boolean;
      path: string;
      limit: number;
    };
    shares: {
      enabled: boolean;
      path: string;
      window: number; // seconds
    };
  };
  
  // Response settings
  response: {
    format: 'json' | 'protobuf' | 'msgpack';
    compression: boolean;
    gzipThreshold: number; // bytes
  };
  
  // Monitoring
  monitoring: {
    enabled: boolean;
    metrics: boolean;
    logging: boolean;
    errorReporting: boolean;
  };
  
  // Caching
  cache: {
    enabled: boolean;
    provider: 'memory' | 'redis' | 'memcached';
    ttl: number; // seconds
    maxItems: number;
  };
  
  // Documentation
  docs: {
    enabled: boolean;
    path: string;
    format: 'swagger' | 'openapi';
  };
  
  // Versioning
  versioning: {
    enabled: boolean;
    strategy: 'path' | 'header' | 'query';
    defaultVersion: string;
  };
  
  // CORS settings
  cors: {
    enabled: boolean;
    origins: string[];
    methods: string[];
    headers: string[];
  };
  
  // SSL/TLS settings
  ssl: {
    enabled: boolean;
    cert: string;
    key: string;
    ca: string;
  };
}

// Default configuration
export const defaultAPIConfig: APIConfig = {
  server: {
    port: 3000,
    host: '0.0.0.0',
    maxConnections: 1000,
    timeout: 120000,
    keepAliveTimeout: 5000
  },
  
  security: {
    enabled: true,
    rateLimit: {
      window: 60,
      max: 1000
    },
    auth: {
      enabled: true,
      methods: ['bearer', 'api_key'],
      tokenExpiration: 3600
    }
  },
  
  endpoints: {
    stats: {
      enabled: true,
      path: '/api/v1/stats',
      cache: 60
    },
    miners: {
      enabled: true,
      path: '/api/v1/miners',
      limit: 100
    },
    blocks: {
      enabled: true,
      path: '/api/v1/blocks',
      limit: 100
    },
    shares: {
      enabled: true,
      path: '/api/v1/shares',
      window: 3600
    }
  },
  
  response: {
    format: 'json',
    compression: true,
    gzipThreshold: 1024
  },
  
  monitoring: {
    enabled: true,
    metrics: true,
    logging: true,
    errorReporting: true
  },
  
  cache: {
    enabled: true,
    provider: 'memory',
    ttl: 3600,
    maxItems: 1000
  },
  
  docs: {
    enabled: true,
    path: '/api/docs',
    format: 'swagger'
  },
  
  versioning: {
    enabled: true,
    strategy: 'path',
    defaultVersion: '1.0.0'
  },
  
  cors: {
    enabled: true,
    origins: ['*'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    headers: ['Content-Type', 'Authorization']
  },
  
  ssl: {
    enabled: false,
    cert: '',
    key: '',
    ca: ''
  }
};

// Load configuration from environment or config file
export function loadAPIConfig(): APIConfig {
  // In a real implementation, this would load from a config file or environment variables
  // For now, just return the default config
  return defaultAPIConfig;
}
