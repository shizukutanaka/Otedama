# Otedama Pool SDK for TypeScript/JavaScript

Official TypeScript/JavaScript SDK for the Otedama Mining Pool API.

## Installation

```bash
npm install @otedama/pool-sdk
# or
yarn add @otedama/pool-sdk
```

## Quick Start

```typescript
import { createClient } from '@otedama/pool-sdk';

// Create client instance
const client = createClient({
  baseUrl: 'https://api.otedama.pool',
  apiKey: 'your-api-key', // Optional
  debug: true // Enable debug logging
});

// Get pool statistics
const stats = await client.getPoolStats();
console.log('Pool hashrate:', stats.pool.hashrate);

// Get miner information
const miner = await client.getMiner('your-wallet-address');
console.log('Miner balance:', miner.balance);
```

## Authentication

Some endpoints require authentication. You can authenticate using your wallet address and signature:

```typescript
// Authenticate with wallet signature
const auth = await client.authenticate(
  'your-wallet-address',
  'signed-message'
);

// The SDK will automatically handle token refresh
```

## API Methods

### Pool Statistics

```typescript
// Get comprehensive pool stats
const stats = await client.getPoolStats();

// Get current real-time stats
const current = await client.getCurrentStats();

// Get historical stats
const history = await client.getHistoricalStats('24h'); // '1h', '24h', '7d', '30d'
```

### Miners

```typescript
// List all miners
const miners = await client.getMiners({
  page: 1,
  limit: 50,
  sortBy: 'hashrate' // 'hashrate', 'shares', 'balance', 'lastSeen'
});

// Get specific miner
const miner = await client.getMiner('wallet-address');
```

### Blocks

```typescript
// List blocks
const blocks = await client.getBlocks({
  page: 1,
  limit: 20
});

// Get specific block
const block = await client.getBlock(12345);
```

### Payments

```typescript
// List recent payments
const payments = await client.getPayments({
  page: 1,
  limit: 20
});

// Get miner's payment history
const minerPayments = await client.getMinerPayments('wallet-address', {
  page: 1,
  limit: 20
});
```

### Account Management

```typescript
// Get account details (requires authentication)
const account = await client.getAccount();

// Update account settings
await client.updateAccountSettings({
  payoutThreshold: 0.1,
  email: 'user@example.com',
  notifications: {
    blockFound: true,
    paymentSent: true,
    workerOffline: true
  }
});

// Request withdrawal
const withdrawal = await client.requestWithdrawal(0.5);
```

## WebSocket Support

The SDK supports real-time updates via WebSocket:

```typescript
// Connect to WebSocket
client.connectWebSocket();

// Listen for events
client.on('connected', () => {
  console.log('WebSocket connected');
});

client.on('stats', (data) => {
  console.log('New stats:', data);
});

client.on('block', (data) => {
  console.log('New block found:', data);
});

client.on('payment', (data) => {
  console.log('Payment processed:', data);
});

// Disconnect when done
client.disconnectWebSocket();
```

## Error Handling

The SDK provides typed errors for better error handling:

```typescript
import { 
  OtedamaError, 
  OtedamaAuthError, 
  OtedamaValidationError,
  OtedamaRateLimitError 
} from '@otedama/pool-sdk';

try {
  const miner = await client.getMiner('invalid-address');
} catch (error) {
  if (error instanceof OtedamaValidationError) {
    console.error('Validation error:', error.field, error.message);
  } else if (error instanceof OtedamaAuthError) {
    console.error('Authentication required');
  } else if (error instanceof OtedamaRateLimitError) {
    console.error('Rate limited, retry after:', error.retryAfter);
  } else {
    console.error('Unknown error:', error);
  }
}
```

## Admin Functions

For pool administrators:

```typescript
// Get all miners (admin only)
const allMiners = await client.admin_getMiners();

// Ban a miner
await client.admin_banMiner(
  'miner-address',
  'Reason for ban',
  3600 // Duration in seconds (optional, 0 for permanent)
);

// Unban a miner
await client.admin_unbanMiner('miner-address');
```

## Configuration Options

```typescript
const client = createClient({
  baseUrl: 'https://api.otedama.pool',  // Required
  apiKey: 'your-api-key',               // Optional, for API key auth
  timeout: 30000,                       // Request timeout in ms (default: 30000)
  retries: 3,                           // Number of retries (default: 3)
  debug: false                          // Enable debug logging (default: false)
});
```

## TypeScript Support

This SDK is written in TypeScript and provides full type definitions:

```typescript
import { 
  PoolStats, 
  MinerStats, 
  Block, 
  Payment 
} from '@otedama/pool-sdk';
```

## Examples

### Monitor Pool Performance

```typescript
async function monitorPool() {
  const client = createClient({
    baseUrl: 'https://api.otedama.pool'
  });

  // Connect WebSocket for real-time updates
  client.connectWebSocket();

  client.on('stats', async (stats) => {
    console.log(`Hashrate: ${stats.hashrate}`);
    console.log(`Active miners: ${stats.miners}`);
    
    // Check if hashrate dropped significantly
    if (stats.hashrate < 1000000) {
      console.warn('Low hashrate detected!');
    }
  });

  // Check stats every minute
  setInterval(async () => {
    try {
      const stats = await client.getCurrentStats();
      console.log('Current stats:', stats);
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    }
  }, 60000);
}
```

### Track Miner Performance

```typescript
async function trackMiner(address: string) {
  const client = createClient({
    baseUrl: 'https://api.otedama.pool'
  });

  try {
    const miner = await client.getMiner(address);
    console.log(`Miner ${address}:`);
    console.log(`- Hashrate: ${miner.hashrate}`);
    console.log(`- Balance: ${miner.balance}`);
    console.log(`- Valid shares: ${miner.shares.valid}`);
    
    // Check workers
    miner.workers.forEach(worker => {
      console.log(`Worker ${worker.name}: ${worker.hashrate} H/s`);
    });
  } catch (error) {
    console.error('Failed to get miner stats:', error);
  }
}
```

## License

MIT License - see LICENSE file for details.

## Support

- Documentation: https://docs.otedama.pool
- API Reference: https://api.otedama.pool/api-docs
- Issues: https://github.com/otedama/pool-sdk-typescript/issues
- Discord: https://discord.gg/otedama
