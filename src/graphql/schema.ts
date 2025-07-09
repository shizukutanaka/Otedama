import { gql } from 'apollo-server-express';

export const typeDefs = gql`
  # Core Types
  type Miner {
    id: ID!
    address: String!
    hashrate: Float!
    shares: Int!
    lastSeen: String!
    status: String!
  }

  type Block {
    id: ID!
    height: Int!
    hash: String!
    timestamp: String!
    difficulty: Float!
    reward: Float!
    miner: Miner
  }

  type PoolStats {
    totalHashrate: Float!
    activeMiners: Int!
    pendingPayments: Float!
    totalPaid: Float!
    blockCount: Int!
    lastBlock: Block
  }

  type Payment {
    id: ID!
    miner: Miner!
    amount: Float!
    timestamp: String!
    status: String!
  }

  # Query Definitions
  type Query {
    # Pool Information
    poolStats: PoolStats!
    getMiner(address: String!): Miner
    getBlock(height: Int, hash: String): Block
    getPayments(miner: String, limit: Int = 10): [Payment!]!
    
    # Mining Information
    getAlgorithmStats: [AlgorithmStats!]!
    getDifficulty: Float!
    getNetworkHashrate: Float!
    
    # Network Information
    getNetworkStatus: NetworkStatus!
    getPeerCount: Int!
  }

  # Mutation Definitions
  type Mutation {
    # Miner Operations
    registerMiner(address: String!, name: String): Miner
    updateMinerStatus(address: String!, status: String): Boolean
    
    # Payment Operations
    requestPayment(miner: String!): Payment
    confirmPayment(id: String!): Boolean
    
    # Configuration Operations
    updatePoolConfig(config: PoolConfigInput): Boolean
  }

  # Subscription Definitions
  type Subscription {
    # Real-time updates
    minerStatusChanged(address: String): Miner
    newBlock: Block
    poolStatsUpdated: PoolStats
    paymentProcessed: Payment
  }

  # Input Types
  input PoolConfigInput {
    difficulty: Float
    reward: Float
    paymentThreshold: Float
    maintenanceMode: Boolean
  }

  type AlgorithmStats {
    name: String!
    hashrate: Float!
    miners: Int!
    efficiency: Float!
  }

  type NetworkStatus {
    version: String!
    connections: Int!
    height: Int!
    difficulty: Float!
    hashrate: Float!
  }
`;
