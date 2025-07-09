# WebSocket API Documentation

## Overview

The Otedama Pool WebSocket API provides real-time updates for mining pool data, enabling efficient monitoring and reactive applications.

## Connection

### WebSocket URL
```
ws://pool.example.com:3001
wss://pool.example.com:3001 (SSL)
```

### Authentication

Authentication is required for user-specific channels. Send an authentication message after connecting:

```json
{
  "type": "auth",
  "data": {
    "token": "your-jwt-token"
  }
}
```

## Message Format

All messages follow this structure:

```typescript
interface WebSocketMessage {
  id: string;
  type: string;
  timestamp: string;
  data?: any;
  error?: string;
}
```

## Message Types

### Client → Server

#### Authentication
```json
{
  "type": "auth",
  "data": {
    "token": "jwt-token"
  }
}
```

#### Subscribe
```json
{
  "type": "subscribe",
  "data": {
    "channel": "pool.stats",
    "filters": [
      {
        "field": "hashrate",
        "operator": "greater_than",
        "value": 1000000
      }
    ]
  }
}
```

#### Unsubscribe
```json
{
  "type": "unsubscribe",
  "data": {
    "subscriptionId": "sub-123",
    "channel": "pool.stats"
  }
}
```

#### Ping
```json
{
  "type": "ping"
}
```

### Server → Client

#### Authentication Success
```json
{
  "type": "auth_success",
  "data": {
    "userId": "miner-address"
  }
}
```

#### Subscription Success
```json
{
  "type": "subscription_success",
  "data": {
    "subscriptionId": "sub-123",
    "channel": "pool.stats"
  }
}
```

#### Event
```json
{
  "type": "event",
  "data": {
    "channel": "pool.stats",
    "payload": {
      "hashrate": 2500000000,
      "miners": 150,
      "workers": 450
    }
  }
}
```

#### Error
```json
{
  "type": "error",
  "error": "Error message"
}
```

## Channels

### Public Channels (No Auth Required)

#### pool.stats
Real-time pool statistics
```json
{
  "hashrate": 2500000000,
  "miners": 150,
  "workers": 450,
  "difficulty": 15000000,
  "blockHeight": 750000,
  "lastBlockTime": "2024-01-10T12:00:00Z"
}
```

#### pool.blocks
New blocks found by the pool
```json
{
  "height": 750001,
  "hash": "0x123...",
  "reward": 6.25,
  "timestamp": "2024-01-10T12:05:00Z",
  "miner": "0xabc...",
  "effort": 95.5
}
```

#### pool.shares
Share submissions (aggregated)
```json
{
  "validShares": 1250,
  "invalidShares": 5,
  "shareRate": 125.5,
  "difficulty": 1000000
}
```

### Authenticated Channels

#### miner.stats
Individual miner statistics
```json
{
  "minerId": "0xabc...",
  "hashrate": 125000000,
  "shares": {
    "valid": 1250,
    "invalid": 5
  },
  "balance": 0.0125,
  "workers": 3
}
```

#### miner.workers
Worker-specific updates
```json
{
  "minerId": "0xabc...",
  "workerId": "worker-1",
  "hashrate": 45000000,
  "lastShare": "2024-01-10T12:00:00Z",
  "status": "active"
}
```

#### pool.payouts
Payment notifications
```json
{
  "payoutId": "payout-123",
  "minerId": "0xabc...",
  "amount": 0.1,
  "txHash": "0xdef...",
  "timestamp": "2024-01-10T12:00:00Z",
  "status": "confirmed"
}
```

## Subscription Filters

Filters allow you to receive only relevant updates:

### Filter Operators
- `equals`: Exact match
- `contains`: String contains (string fields only)
- `greater_than`: Numeric greater than
- `less_than`: Numeric less than

### Example Filters

#### High hashrate miners only
```json
{
  "channel": "miner.stats",
  "filters": [
    {
      "field": "hashrate",
      "operator": "greater_than",
      "value": 100000000
    }
  ]
}
```

#### Specific miner updates
```json
{
  "channel": "miner.stats",
  "filters": [
    {
      "field": "minerId",
      "operator": "equals",
      "value": "0xabc..."
    }
  ]
}
```

## Advanced Features

### Batch Messages

The server may send multiple updates in a single batch:

```json
{
  "type": "event",
  "data": {
    "type": "batch",
    "compressed": false,
    "payload": "[{...}, {...}, {...}]"
  }
}
```

### Message Priority

Critical messages (like payment confirmations) are delivered with higher priority.

### Automatic Reconnection

The client SDK supports automatic reconnection with subscription restoration.

### Message History

Recent messages can be replayed upon reconnection to ensure no data is lost.

## Rate Limiting

WebSocket connections are subject to rate limiting:
- Max connections per IP: 5
- Max messages per minute: 600
- Max subscriptions per connection: 20

## Client SDK

### Installation
```bash
npm install @otedama/websocket-client
```

### Basic Usage
```typescript
import { createOtedamaWebSocketClient, Channels } from '@otedama/websocket-client';

const client = createOtedamaWebSocketClient({
  url: 'ws://localhost:3001',
  token: 'your-jwt-token',
  autoReconnect: true,
  debug: true
});

// Connect
await client.connect();

// Subscribe to pool stats
await client.subscribe({
  channel: Channels.POOL_STATS
});

// Handle updates
client.on(Channels.POOL_STATS, (stats) => {
  console.log('Pool stats:', stats);
});

// Handle errors
client.on('error', (error) => {
  console.error('Error:', error);
});
```

### Advanced Usage
```typescript
// Subscribe with filters
await client.subscribe({
  channel: Channels.MINER_STATS,
  filters: [
    {
      field: 'hashrate',
      operator: 'greater_than',
      value: 100000000
    }
  ]
});

// Custom event handling
client.on('authenticated', (data) => {
  console.log('Authenticated as:', data.userId);
});

client.on('reconnecting', ({ attempt }) => {
  console.log(`Reconnecting... attempt ${attempt}`);
});

// Get connection state
const state = client.getState();
console.log('Connected:', state.connected);
console.log('Subscriptions:', state.subscriptions);
```

## Error Codes

| Code | Description |
|------|-------------|
| 1000 | Normal closure |
| 1002 | Protocol error |
| 1008 | Policy violation (rate limit, max connections) |
| 4000 | Authentication required |
| 4001 | Authentication failed |
| 4002 | Invalid subscription |
| 4003 | Rate limit exceeded |

## Best Practices

1. **Use filters**: Subscribe only to relevant data to reduce bandwidth
2. **Handle reconnections**: Implement proper reconnection logic
3. **Process messages efficiently**: Don't block the message handler
4. **Monitor connection state**: Track connection health
5. **Respect rate limits**: Implement backoff strategies

## Examples

### React Hook
```typescript
import { useEffect, useState } from 'react';
import { createOtedamaWebSocketClient, Channels } from '@otedama/websocket-client';

export function usePoolStats() {
  const [stats, setStats] = useState(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const client = createOtedamaWebSocketClient({
      url: process.env.REACT_APP_WS_URL,
      autoReconnect: true
    });

    client.on('connected', () => setConnected(true));
    client.on('disconnected', () => setConnected(false));

    client.on(Channels.POOL_STATS, (newStats) => {
      setStats(newStats);
    });

    client.connect().then(() => {
      return client.subscribe({ channel: Channels.POOL_STATS });
    });

    return () => {
      client.disconnect();
    };
  }, []);

  return { stats, connected };
}
```

### Node.js Monitor
```typescript
import { createOtedamaWebSocketClient, Channels } from '@otedama/websocket-client';

async function monitorPool() {
  const client = createOtedamaWebSocketClient({
    url: 'ws://pool.example.com:3001',
    token: process.env.API_TOKEN
  });

  await client.connect();

  // Monitor all channels
  const channels = [
    Channels.POOL_STATS,
    Channels.POOL_BLOCKS,
    Channels.POOL_SHARES
  ];

  for (const channel of channels) {
    await client.subscribe({ channel });
    
    client.on(channel, (data) => {
      console.log(`[${channel}]`, data);
      // Process data, save to database, etc.
    });
  }

  // Keep running
  process.on('SIGINT', () => {
    client.disconnect();
    process.exit(0);
  });
}

monitorPool().catch(console.error);
```

## Support

For questions or issues:
- GitHub: https://github.com/otedama/pool
- Discord: #websocket-api channel
- Email: support@otedama-pool.com
