import { OtedamaCore } from '../lib/core/otedama-core.js';
import enterpriseConfig from '../config/enterprise-scale.js';

// Enterprise deployment example
async function deployEnterprisePool() {
  console.log('Deploying Otedama Enterprise Mining Pool...');
  
  const config = {
    pool: {
      name: 'Enterprise Mining Pool',
      algorithm: 'sha256',
      coin: 'BTC',
      fee: 0.01,
      minPayout: 0.001
    },
    
    // Enterprise scale settings
    enterprise: enterpriseConfig.scale,
    
    // Performance settings
    performance: enterpriseConfig.performance,
    
    // Security settings
    security: enterpriseConfig.security,
    
    // High availability
    highAvailability: enterpriseConfig.highAvailability,
    
    // Monitoring
    monitoring: enterpriseConfig.monitoring,
    
    // Network configuration
    network: {
      stratum: {
        port: 3333,
        maxConnections: 10000000
      },
      api: {
        port: 8081,
        cors: true
      },
      monitoring: {
        port: 8082
      }
    }
  };
  
  try {
    // Initialize core
    const core = new OtedamaCore(config);
    
    // Start services
    await core.start();
    
    console.log('✅ Enterprise pool deployed successfully!');
    console.log(`Stratum: stratum+tcp://0.0.0.0:${config.network.stratum.port}`);
    console.log(`API: http://0.0.0.0:${config.network.api.port}`);
    console.log(`Monitoring: http://0.0.0.0:${config.network.monitoring.port}`);
    
    // Monitor performance
    setInterval(() => {
      const metrics = core.getMetrics();
      console.log(`
📊 Enterprise Pool Metrics:
- Active Miners: ${metrics.activeMiners}
- Hashrate: ${metrics.totalHashrate} TH/s
- Shares/sec: ${metrics.sharesPerSecond}
- Latency: ${metrics.averageLatency} ms
- CPU: ${metrics.cpuUsage}%
- Memory: ${metrics.memoryUsage}%
      `);
    }, 30000);
    
  } catch (error) {
    console.error('Failed to deploy enterprise pool:', error);
    process.exit(1);
  }
}

// Handle shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down enterprise pool...');
  process.exit(0);
});

// Deploy
deployEnterprisePool();