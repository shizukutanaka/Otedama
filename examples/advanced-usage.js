/**
 * Otedama Advanced Usage Examples
 * Version 4.1.0
 */

// Example 1: Using Blockchain RPC
const otedamaRPCExample = async () => {
  // Configure RPC in otedama.json
  const config = {
    "rpc": {
      "rvn": {
        "url": "http://localhost:8766",
        "auth": "rpcuser:rpcpassword"
      },
      "btc": {
        "url": "http://localhost:8332",
        "auth": "btcuser:btcpassword"
      }
    }
  };

  // The RPC client will be available globally after startup
  // Example usage:
  try {
    const height = await global.rpc.getBlockHeight('RVN');
    console.log('Current RVN block height:', height);

    const difficulty = await global.rpc.getNetworkDifficulty('RVN');
    console.log('Network difficulty:', difficulty);

    const isValid = await global.rpc.validateAddress('RVN', 'RXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    console.log('Address valid:', isValid);
  } catch (error) {
    console.error('RPC error:', error);
  }
};

// Example 2: Monitoring Security Metrics
const securityMonitoring = async () => {
  // Enable authentication in config
  const config = {
    "security": {
      "enableAuth": true,
      "apiKey": "your-secure-api-key"
    }
  };

  // Fetch security metrics
  const response = await fetch('http://localhost:8080/api/security/metrics', {
    headers: {
      'X-API-Key': 'your-secure-api-key'
    }
  });

  const metrics = await response.json();
  console.log('Security Metrics:', metrics);
  // Output:
  // {
  //   blockedIPs: 5,
  //   activeRateLimits: 23,
  //   connectionTracking: 45,
  //   patternTracking: 12,
  //   suspiciousIPs: 3
  // }
};

// Example 3: Performance Profiling
const performanceProfiling = async () => {
  // Enable profiling
  process.env.PROFILING = 'true';

  // Fetch performance profile
  const response = await fetch('http://localhost:8080/api/performance/profile', {
    headers: {
      'X-API-Key': 'your-secure-api-key'
    }
  });

  const profile = await response.json();
  console.log('Performance Profile:', profile);
  // Output:
  // {
  //   enabled: true,
  //   metrics: {
  //     'mining.handleShare': {
  //       count: 1523,
  //       total: 4569.23,
  //       min: 0.45,
  //       max: 12.3,
  //       avg: 3.0
  //     },
  //     'dex.swap': {
  //       count: 89,
  //       total: 234.56,
  //       min: 1.2,
  //       max: 8.9,
  //       avg: 2.63
  //     }
  //   }
  // }
};

// Example 4: Auto-Tuning Configuration
const autoTuningSetup = () => {
  // Configure auto-tuning in otedama.json
  const config = {
    "tuning": {
      "enabled": true,
      "interval": 300000,  // 5 minutes
      "aggressive": false   // Conservative tuning
    }
  };

  // Check tuning status
  fetch('http://localhost:8080/api/tuning/status')
    .then(res => res.json())
    .then(status => {
      console.log('Auto-Tuning Status:', status);
      // Output:
      // {
      //   enabled: true,
      //   metrics: {
      //     cpu: [45.2, 48.1, 43.5, ...],
      //     memory: [42343432, 43534534, ...],
      //     hashrate: [15000000, 15500000, ...],
      //     efficiency: [92.3, 93.1, 91.8, ...]
      //   },
      //   lastTune: 1634567890123
      // }
    });
};

// Example 5: Advanced DEX Features
const advancedDEXUsage = async () => {
  // Get TWAP (Time-Weighted Average Price)
  const twapResponse = await fetch(
    'http://localhost:8080/api/dex/pool/RVN-USDT/twap?token=RVN&duration=300000'
  );
  const twap = await twapResponse.json();
  console.log('5-minute TWAP for RVN:', twap);

  // Get Impermanent Loss
  const ilResponse = await fetch(
    'http://localhost:8080/api/dex/pool/RVN-USDT/impermanent-loss?provider=0xYourAddress'
  );
  const il = await ilResponse.json();
  console.log('Impermanent Loss:', il);
  // Output:
  // {
  //   percentage: "-2.34",
  //   currentValue: {
  //     token0: 10234.56,
  //     token1: 9876.54
  //   }
  // }
};

// Example 6: WebSocket with Compression
const websocketExample = () => {
  const ws = new WebSocket('ws://localhost:8080');

  ws.on('open', () => {
    console.log('Connected with compression enabled');
    
    // Large messages will be automatically compressed
    ws.send(JSON.stringify({
      type: 'subscribe',
      channel: 'mining',
      // Large payload will be compressed if > 1KB
      data: new Array(1000).fill('data')
    }));
  });

  ws.on('message', (data) => {
    // Decompression is automatic
    const message = JSON.parse(data);
    console.log('Received:', message);
  });
};

// Example 7: Custom Transaction Pool Usage
const transactionPoolExample = () => {
  // Add transaction to pool
  const tx = {
    from: '0xSender',
    to: '0xReceiver',
    amount: 100,
    fee: 0.1,
    data: 'custom data'
  };

  // Transaction will be prioritized by fee
  const txId = global.txPool.addTransaction(tx);
  console.log('Transaction added:', txId);

  // Get pool statistics
  const stats = global.txPool.getStats();
  console.log('TX Pool Stats:', stats);
  // Output:
  // {
  //   pending: 234,
  //   totalFees: 45.67,
  //   avgPriority: 0.195,
  //   oldestTx: 1634567890123
  // }
};

// Example 8: SSL/TLS Configuration
const sslSetup = () => {
  // Configure SSL in otedama.json
  const config = {
    "security": {
      "enableSSL": true,
      "sslCert": "/path/to/cert.pem",
      "sslKey": "/path/to/key.pem",
      "corsOrigins": ["https://yourdomain.com", "https://app.yourdomain.com"]
    }
  };

  // API will be available at https://localhost:8080
  // WebSocket at wss://localhost:8080
};

// Example 9: DDoS Protection Events
const ddosProtection = () => {
  // Monitor DDoS events via logs
  // The system automatically detects and blocks:
  // - High connection rates (>100/min)
  // - Identical request patterns (>20)
  // - Slowloris attacks
  
  // Check current blocks
  fetch('http://localhost:8080/api/security/metrics', {
    headers: { 'X-API-Key': 'your-api-key' }
  })
    .then(res => res.json())
    .then(metrics => {
      if (metrics.blockedIPs > 0) {
        console.warn(`DDoS Protection: ${metrics.blockedIPs} IPs blocked`);
      }
    });
};

// Example 10: Production Deployment
const productionConfig = {
  "pool": {
    "name": "MyProductionPool",
    "fee": 1.0,
    "minPayout": {
      "RVN": 100,
      "BTC": 0.001
    }
  },
  "mining": {
    "enabled": true,
    "currency": "RVN",
    "algorithm": "kawpow",
    "walletAddress": "RYourProductionWalletAddress",
    "threads": 0  // Auto-detect
  },
  "network": {
    "p2pPort": 8333,
    "stratumPort": 3333,
    "apiPort": 443,  // HTTPS
    "maxPeers": 100,
    "maxMiners": 5000
  },
  "security": {
    "enableRateLimit": true,
    "maxRequestsPerMinute": 1000,
    "enableAuth": true,
    "apiKey": "generate-secure-key-here",
    "enableSSL": true,
    "sslCert": "/etc/letsencrypt/live/yourdomain/fullchain.pem",
    "sslKey": "/etc/letsencrypt/live/yourdomain/privkey.pem",
    "corsOrigins": ["https://yourdomain.com"]
  },
  "monitoring": {
    "enableMetrics": true,
    "metricsPort": 9090,
    "alertThresholds": {
      "cpuUsage": 85,
      "memoryUsage": 80,
      "minerDisconnectRate": 25
    }
  },
  "tuning": {
    "enabled": true,
    "interval": 300000,
    "aggressive": true  // Aggressive tuning for production
  },
  "rpc": {
    "rvn": {
      "url": "http://localhost:8766",
      "auth": "rpcuser:strongpassword"
    }
  }
};

module.exports = {
  otedamaRPCExample,
  securityMonitoring,
  performanceProfiling,
  autoTuningSetup,
  advancedDEXUsage,
  websocketExample,
  transactionPoolExample,
  sslSetup,
  ddosProtection,
  productionConfig
};
