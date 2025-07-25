/**
 * Network Module - Otedama
 * High-performance networking with P2P capabilities
 * 
 * Design:
 * - Carmack: Zero-copy networking
 * - Martin: Clean network abstractions
 * - Pike: Simple but powerful protocols
 */

// Binary protocol v2 - Zero-copy, high-performance
export {
  BinaryProtocol,
  MessageFramer,
  MessageBuilder,
  MessageType,
  CompressionType,
  bufferPool,
  PROTOCOL_VERSION,
  MAX_PACKET_SIZE
} from './binary-protocol-v2.js';

// Enhanced P2P network - National scale
export {
  P2PNetwork,
  KademliaDHT,
  GossipProtocol
} from './p2p-network-enhanced.js';

// Network manager
export { NetworkManager } from './network-manager.js';

// Stratum servers
export { StratumServer } from './stratum-server.js';
export { StratumV2Server } from './stratum-v2-server.js';

// Connection management
export { ConnectionPool } from './connection-pool.js';
export { LoadBalancer } from './load-balancer.js';

// Re-export common network errors
export { NetworkError } from '../core/error-handler-unified.js';

// Default export
export default {
  BinaryProtocol,
  MessageFramer,
  MessageBuilder,
  MessageType,
  P2PNetwork,
  NetworkManager,
  StratumServer,
  StratumV2Server,
  ConnectionPool,
  LoadBalancer
};
