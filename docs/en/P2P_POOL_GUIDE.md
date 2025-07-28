# Otedama P2P Mining Pool Guide

## Overview

The Otedama P2P Mining Pool implements a fully decentralized mining pool architecture similar to P2Pool. It eliminates the single point of failure found in traditional centralized pools by distributing the pool operations across all participating nodes.

## Key Features

- **Decentralized Architecture**: No central server, all nodes are equal
- **Share Chain**: Blockchain-based share tracking (like P2Pool)
- **PPLNS Payments**: Fair pay-per-last-N-shares distribution
- **Multi-Algorithm Support**: Works with Bitcoin, Litecoin, Ethereum, Monero, and more
- **Low Latency**: Direct peer-to-peer work distribution
- **DoS Resistant**: Built-in protection against attacks
- **Zero Trust**: No need to trust a pool operator

## Architecture Components

### 1. Share Chain
- Maintains a blockchain of mining shares
- 10-second target block time
- PPLNS window of ~6 hours (2160 shares)
- Automatic difficulty adjustment

### 2. P2P Network Discovery
- Kademlia-style DHT for peer discovery
- Automatic peer reputation system
- UDP discovery + TCP connections
- Bootstrap node support

### 3. Decentralized Stratum Proxy
- Standard stratum protocol for miner connections
- Automatic difficulty adjustment per miner
- Share validation and propagation
- Real-time job distribution

### 4. Work Distribution Coordinator
- Fetches block templates from blockchain
- Coordinates work between components
- Consensus-based share verification
- Block submission handling

## Quick Start

### 1. Configuration

Create a configuration file `config/p2p-pool.json`:

```json
{
  "poolName": "My Otedama Pool",
  "poolAddress": "YOUR_WALLET_ADDRESS",
  "poolFee": 0.01,
  
  "blockchain": "bitcoin",
  "blockchainHost": "localhost",
  "blockchainPort": 8332,
  "blockchainUsername": "rpcuser",
  "blockchainPassword": "rpcpassword",
  
  "p2pPort": 30303,
  "stratumPort": 3333,
  
  "bootstrapNodes": [
    "seed1.otedama.pool:30303",
    "seed2.otedama.pool:30303"
  ]
}
```

### 2. Start the Pool

```bash
node scripts/start-p2p-pool.js config/p2p-pool.json
```

### 3. Connect Your Miners

Point your mining software to:
```
stratum+tcp://YOUR_WALLET_ADDRESS.WORKER_NAME@localhost:3333
```

## Supported Blockchains

| Blockchain | Algorithm | Status |
|------------|-----------|---------|
| Bitcoin | SHA-256 | ✅ Supported |
| Litecoin | Scrypt | ✅ Supported |
| Ethereum | Ethash | ✅ Supported |
| Monero | RandomX | ✅ Supported |
| Ravencoin | KawPow | ✅ Supported |
| Ergo | Autolykos2 | ✅ Supported |
| Kaspa | kHeavyHash | ✅ Supported |
| Flux | Equihash | ✅ Supported |
| Conflux | Octopus | ✅ Supported |
| Beam | BeamHash | ✅ Supported |

## Network Protocol

### Message Types

1. **Share Chain Messages**
   - `sharechain:block` - New share chain block
   - `share:submit` - Submit share for validation
   - `share:verification` - Share validation result

2. **Work Distribution**
   - `template:request` - Request current block template
   - `template:response` - Block template data
   - `template:update` - New block template broadcast

3. **Peer Management**
   - `handshake` - Initial peer connection
   - `ping/pong` - Keep-alive and latency measurement
   - `peer:status` - Peer statistics update

## Payment System

### PPLNS (Pay Per Last N Shares)
- Window size: 2160 shares (~6 hours at 10s/share)
- Payments proportional to difficulty-weighted shares
- Automatic payout when block is found
- No payment threshold - all miners get paid

### Share Difficulty
- Automatic per-miner difficulty adjustment
- Target: 1 share per 10 seconds
- Prevents share flooding
- Ensures fair contribution tracking

## Security Features

### Zero-Knowledge Proof Support
- Optional ZKP authentication for miners
- Privacy-preserving identity verification
- Compliance without KYC

### DDoS Protection
- Rate limiting per IP
- Share validation quorum
- Peer reputation system
- Automatic ban for malicious peers

### Byzantine Fault Tolerance
- Consensus-based share verification
- Multiple peer validation
- Share chain reorganization handling

## Performance Optimization

### Low Latency Design
- Direct peer-to-peer communication
- Efficient binary protocol
- Memory-pooled objects
- Optimized share validation

### Scalability
- Supports thousands of miners
- Horizontal scaling through P2P
- Efficient share pruning
- Automatic peer balancing

## Monitoring

### Built-in Metrics
- Pool hashrate
- Active miners
- Share statistics
- Block finding rate
- Network health

### API Endpoints
- `/api/stats` - Pool statistics
- `/api/miners` - Active miner list
- `/api/blocks` - Recent blocks
- `/api/payments` - Payment history

## Troubleshooting

### Common Issues

1. **Cannot connect to blockchain**
   - Check RPC credentials
   - Ensure blockchain is synced
   - Verify firewall settings

2. **No peers connecting**
   - Check P2P port is open
   - Verify bootstrap nodes
   - Check firewall/NAT settings

3. **Miners cannot connect**
   - Verify stratum port is open
   - Check miner configuration
   - Review stratum proxy logs

### Debug Mode

Enable debug logging:
```json
{
  "logging": {
    "level": "debug",
    "file": "logs/debug.log"
  }
}
```

## Advanced Configuration

### Custom Share Window
```json
{
  "shareWindow": 4320,  // 12 hours
  "targetShareTime": 5  // 5 seconds per share
}
```

### Multiple Bootstrap Nodes
```json
{
  "bootstrapNodes": [
    "node1.pool.com:30303",
    "node2.pool.com:30303",
    "backup.pool.com:30303"
  ],
  "maxPeers": 200
}
```

### Algorithm-Specific Settings
```json
{
  "blockchain": "monero",
  "algorithm": {
    "variant": "randomx",
    "threads": 4
  }
}
```

## Development

### Running Tests
```bash
npm test -- p2p-pool
```

### Building from Source
```bash
npm run build
```

### Contributing
- Follow the design principles (Carmack, Martin, Pike)
- Add tests for new features
- Update documentation
- Submit pull requests

## FAQ

**Q: How is this different from traditional pools?**
A: No central server, no pool operator trust required, true decentralization.

**Q: What happens if peers disconnect?**
A: The pool continues operating with remaining peers. New peers can join anytime.

**Q: How are payments handled?**
A: Payments are encoded directly in the coinbase transaction when blocks are found.

**Q: Can I run multiple nodes?**
A: Yes, each node should use a different P2P port and node ID.

**Q: Is this compatible with mining software?**
A: Yes, it supports standard stratum protocol used by all major mining software.