/**
 * Otedama Mining Pool Configuration
 * Default configuration for quick start
 */

export default {
  // Pool identity
  poolName: 'Otedama Mining Pool',
  poolMode: 'hybrid',
  
  // Mining settings
  algorithm: 'sha256',
  paymentScheme: 'PPLNS',
  minimumPayment: 0.001,
  poolFee: 0.01, // 1%
  
  // Network ports
  stratumPort: 3333,
  stratumV2Port: 3336,
  p2pPort: 8333,
  apiPort: 8080,
  
  // Performance
  workerProcesses: 4,
  shareValidationWorkers: 8,
  maxConnections: 10000,
  
  // Enable all hardware types
  enableCPUMining: true,
  enableGPUMining: true,
  enableASICMining: true,
  asicDiscovery: true,
  
  // Payment interval (1 hour)
  paymentInterval: 3600000,
  
  // Security
  enableDDoSProtection: true,
  enableBanManagement: true,
  
  // Storage
  dataDir: './data',
  dbFile: 'otedama-pool.db',
  
  // Monitoring
  enablePrometheus: true,
  enableWebSocket: true,
  
  // Development
  debug: false,
  logLevel: 'info'
};
