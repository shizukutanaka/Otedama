/**
 * GraphQL Unified API - Flexible Query System
 * 
 * Design Philosophy:
 * - Carmack: Single entry point, efficient data fetching
 * - Martin: Clean schema design, clear resolvers
 * - Pike: Simple queries, intuitive API
 */

import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { PubSub } from 'graphql-subscriptions';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { UnifiedDatabase } from '../database/unified-database';
import { UnifiedMetrics } from '../metrics/unified-metrics';
import { UnifiedSecurity } from '../security/unified-security';
import { UnifiedLogger } from '../logging/unified-logger';
import { GraphQLContext, createContext } from './graphql-context';

// Type definitions
const typeDefs = `
  type Query {
    # Pool Information
    poolStatus: PoolStatus!
    poolStats: PoolStats!
    miners: [Miner!]!
    miner(id: ID!): Miner
    
    # Mining Data
    blocks: [Block!]!
    block(id: ID!): Block
    shares(limit: Int = 100): [Share!]!
    payouts(limit: Int = 100): [Payout!]!
    
    # Metrics
    hashrate(timeframe: String = "1h"): HashrateData!
    difficulty: DifficultyData!
    
    # User/Account
    account(address: String!): Account
    workers(accountId: ID!): [Worker!]!
  }

  type Mutation {
    # Pool Management
    updatePoolConfig(config: PoolConfigInput!): PoolStatus!
    
    # Miner Management
    banMiner(minerId: ID!, reason: String!): Boolean!
    unbanMiner(minerId: ID!): Boolean!
    
    # Worker Management
    addWorker(accountId: ID!, workerName: String!): Worker!
    removeWorker(workerId: ID!): Boolean!
    
    # Auth
    authenticate(address: String!, signature: String!): AuthResult!
    refreshToken(token: String!): AuthResult!
  }

  type Subscription {
    # Real-time updates
    newBlock: Block!
    newShare: Share!
    poolStatsUpdate: PoolStats!
    hashrateUpdate: HashrateData!
    payoutProcessed: Payout!
    
    # Miner specific
    minerStatsUpdate(minerId: ID!): MinerStats!
    workerStatsUpdate(workerId: ID!): WorkerStats!
  }

  # Core Types
  type PoolStatus {
    name: String!
    version: String!
    uptime: Int!
    connected: Boolean!
    lastBlock: Block
    nextPayout: String
    fee: Float!
    minPayout: Float!
  }

  type PoolStats {
    hashrate: Float!
    miners: Int!
    workers: Int!
    shares: Int!
    blocks: Int!
    luck: Float!
    effort: Float!
    networkHashrate: Float!
    networkDifficulty: Float!
    blockTime: Float!
  }

  type Miner {
    id: ID!
    address: String!
    hashrate: Float!
    shares: Int!
    workers: [Worker!]!
    joinedAt: String!
    lastSeen: String!
    banned: Boolean!
    banReason: String
  }

  type Worker {
    id: ID!
    name: String!
    minerId: ID!
    hashrate: Float!
    difficulty: Float!
    shares: Int!
    lastShare: String
    connected: Boolean!
  }

  type Block {
    id: ID!
    height: Int!
    hash: String!
    difficulty: Float!
    timestamp: String!
    reward: Float!
    foundBy: String!
    status: BlockStatus!
    confirmations: Int!
  }

  type Share {
    id: ID!
    minerId: ID!
    workerId: ID!
    difficulty: Float!
    timestamp: String!
    valid: Boolean!
    blockHash: String
  }

  type Payout {
    id: ID!
    minerId: ID!
    amount: Float!
    timestamp: String!
    txHash: String
    status: PayoutStatus!
  }

  type Account {
    address: String!
    balance: Float!
    paid: Float!
    miners: [Miner!]!
    payouts: [Payout!]!
  }

  type HashrateData {
    current: Float!
    average: Float!
    peak: Float!
    history: [HashratePoint!]!
  }

  type HashratePoint {
    timestamp: String!
    value: Float!
  }

  type DifficultyData {
    current: Float!
    next: Float!
    change: Float!
    retarget: String!
  }

  type MinerStats {
    minerId: ID!
    hashrate: Float!
    shares: Int!
    efficiency: Float!
    earnings: Float!
  }

  type WorkerStats {
    workerId: ID!
    hashrate: Float!
    shares: Int!
    difficulty: Float!
    uptime: Float!
  }

  type AuthResult {
    token: String!
    refreshToken: String!
    expiresIn: Int!
    user: Account!
  }

  # Enums
  enum BlockStatus {
    PENDING
    CONFIRMED
    ORPHANED
    REJECTED
  }

  enum PayoutStatus {
    PENDING
    PROCESSING
    COMPLETED
    FAILED
  }

  # Input Types
  input PoolConfigInput {
    fee: Float
    minPayout: Float
    payoutInterval: Int
    difficulty: Float
  }
`;

// Resolvers
const resolvers = {
  Query: {
    poolStatus: async (_: any, __: any, context: GraphQLContext) => {
      const status = await context.services.database.getPoolStatus();
      return {
        name: 'Otedama Pool',
        version: '1.0.0',
        uptime: process.uptime(),
        connected: true,
        lastBlock: await context.services.database.getLastBlock(),
        nextPayout: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
        fee: 1.0,
        minPayout: 0.01
      };
    },

    poolStats: async (_: any, __: any, context: GraphQLContext) => {
      const stats = await context.services.metrics.getPoolStats();
      return {
        hashrate: await context.services.metrics.getPoolHashrate(),
        miners: await context.services.metrics.getActiveMinerCount(),
        workers: await context.services.metrics.getActiveWorkerCount(),
        shares: await context.services.metrics.getTotalShares(),
        blocks: await context.services.database.getBlockCount(),
        luck: 95.5, // Mock data
        effort: 102.3, // Mock data
        networkHashrate: 150000000000, // Mock data
        networkDifficulty: 25000000000000, // Mock data
        blockTime: 600 // 10 minutes
      };
    },

    miners: async (_: any, __: any, context: GraphQLContext) => {
      return await context.services.database.getMiners();
    },

    miner: async (_: any, { id }: { id: string }, context: GraphQLContext) => {
      return await context.services.database.getMiner(id);
    },

    blocks: async (_: any, __: any, context: GraphQLContext) => {
      return await context.services.database.getBlocks();
    },

    block: async (_: any, { id }: { id: string }, context: GraphQLContext) => {
      return await context.services.database.getBlock(id);
    },

    shares: async (_: any, { limit }: { limit: number }, context: GraphQLContext) => {
      return await context.services.database.getShares(limit);
    },

    payouts: async (_: any, { limit }: { limit: number }, context: GraphQLContext) => {
      return await context.services.database.getPayouts(limit);
    },

    hashrate: async (_: any, { timeframe }: { timeframe: string }, context: GraphQLContext) => {
      const current = await context.services.metrics.getPoolHashrate();
      const history = await context.services.database.getHashrateHistory(timeframe);
      
      return {
        current,
        average: history.reduce((sum, point) => sum + point.value, 0) / history.length,
        peak: Math.max(...history.map(point => point.value)),
        history
      };
    },

    difficulty: async (_: any, __: any, context: GraphQLContext) => {
      return {
        current: 25000000000000,
        next: 26000000000000,
        change: 4.0,
        retarget: new Date(Date.now() + 86400000).toISOString() // 1 day
      };
    },

    account: async (_: any, { address }: { address: string }, context: GraphQLContext) => {
      return await context.services.database.getAccount(address);
    },

    workers: async (_: any, { accountId }: { accountId: string }, context: GraphQLContext) => {
      return await context.services.database.getWorkers(accountId);
    }
  },

  Mutation: {
    updatePoolConfig: async (_: any, { config }: any, context: GraphQLContext) => {
      context.requireAuth();
      context.requireRole('admin');
      
      await context.services.database.updatePoolConfig(config);
      return await resolvers.Query.poolStatus(_, __, context);
    },

    banMiner: async (_: any, { minerId, reason }: any, context: GraphQLContext) => {
      context.requireAuth();
      context.requireRole('moderator');
      
      await context.services.database.banMiner(minerId, reason);
      return true;
    },

    unbanMiner: async (_: any, { minerId }: any, context: GraphQLContext) => {
      context.requireAuth();
      context.requireRole('moderator');
      
      await context.services.database.unbanMiner(minerId);
      return true;
    },

    addWorker: async (_: any, { accountId, workerName }: any, context: GraphQLContext) => {
      context.requireAuth();
      context.requireOwnership(accountId);
      
      return await context.services.database.addWorker(accountId, workerName);
    },

    removeWorker: async (_: any, { workerId }: any, context: GraphQLContext) => {
      context.requireAuth();
      
      const worker = await context.services.database.getWorker(workerId);
      context.requireOwnership(worker.minerId);
      
      await context.services.database.removeWorker(workerId);
      return true;
    },

    authenticate: async (_: any, { address, signature }: any, context: GraphQLContext) => {
      const isValid = await context.services.security.verifySignature(address, signature);
      if (!isValid) {
        throw new Error('Invalid signature');
      }

      const tokens = await context.services.security.generateTokens(address);
      const user = await context.services.database.getAccount(address);

      return {
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: 3600,
        user
      };
    },

    refreshToken: async (_: any, { token }: any, context: GraphQLContext) => {
      const result = await context.services.security.refreshToken(token);
      const user = await context.services.database.getAccount(result.address);

      return {
        token: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: 3600,
        user
      };
    }
  },

  Subscription: {
    newBlock: {
      subscribe: (_: any, __: any, context: GraphQLContext) => {
        return context.pubsub.asyncIterator(['NEW_BLOCK']);
      }
    },

    newShare: {
      subscribe: (_: any, __: any, context: GraphQLContext) => {
        return context.pubsub.asyncIterator(['NEW_SHARE']);
      }
    },

    poolStatsUpdate: {
      subscribe: (_: any, __: any, context: GraphQLContext) => {
        return context.pubsub.asyncIterator(['POOL_STATS_UPDATE']);
      }
    },

    hashrateUpdate: {
      subscribe: (_: any, __: any, context: GraphQLContext) => {
        return context.pubsub.asyncIterator(['HASHRATE_UPDATE']);
      }
    },

    payoutProcessed: {
      subscribe: (_: any, __: any, context: GraphQLContext) => {
        return context.pubsub.asyncIterator(['PAYOUT_PROCESSED']);
      }
    },

    minerStatsUpdate: {
      subscribe: (_: any, { minerId }: any, context: GraphQLContext) => {
        return context.pubsub.asyncIterator([`MINER_STATS_${minerId}`]);
      }
    },

    workerStatsUpdate: {
      subscribe: (_: any, { workerId }: any, context: GraphQLContext) => {
        return context.pubsub.asyncIterator([`WORKER_STATS_${workerId}`]);
      }
    }
  }
};

export interface GraphQLConfig {
  jwtSecret: string;
  port: number;
  introspection?: boolean;
  playground?: boolean;
  cors?: boolean;
}

export class GraphQLUnifiedAPI {
  private server: ApolloServer | null = null;
  private pubsub: PubSub;
  private serverUrl: string | null = null;

  constructor(
    private database: UnifiedDatabase,
    private metrics: UnifiedMetrics,
    private security: UnifiedSecurity,
    private logger: UnifiedLogger,
    private config: GraphQLConfig
  ) {
    this.pubsub = new PubSub();
  }

  public async start(): Promise<void> {
    this.logger.info('Starting GraphQL Unified API...');

    const schema = makeExecutableSchema({
      typeDefs,
      resolvers
    });

    this.server = new ApolloServer({
      schema,
      introspection: this.config.introspection ?? true,
      formatError: (error) => {
        this.logger.error('GraphQL Error:', error);
        return {
          message: error.message,
          code: error.extensions?.code,
          path: error.path
        };
      }
    });

    const { url } = await startStandaloneServer(this.server, {
      listen: { port: this.config.port },
      context: async ({ req }) => {
        return createContext({
          req,
          database: this.database,
          metrics: this.metrics,
          security: this.security,
          pubsub: this.pubsub,
          logger: this.logger,
          jwtSecret: this.config.jwtSecret
        });
      }
    });

    this.serverUrl = url;
    this.logger.info(`GraphQL server started at ${url}`);
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping GraphQL Unified API...');
    
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }

    this.logger.info('GraphQL Unified API stopped');
  }

  // Subscription Publishers
  public publishNewBlock(block: any): void {
    this.pubsub.publish('NEW_BLOCK', { newBlock: block });
  }

  public publishNewShare(share: any): void {
    this.pubsub.publish('NEW_SHARE', { newShare: share });
  }

  public publishPoolStats(stats: any): void {
    this.pubsub.publish('POOL_STATS_UPDATE', { poolStatsUpdate: stats });
  }

  public publishHashrateUpdate(data: any): void {
    this.pubsub.publish('HASHRATE_UPDATE', { hashrateUpdate: data });
  }

  public publishPayout(payout: any): void {
    this.pubsub.publish('PAYOUT_PROCESSED', { payoutProcessed: payout });
  }

  public publishMinerStats(minerId: string, stats: any): void {
    this.pubsub.publish(`MINER_STATS_${minerId}`, { minerStatsUpdate: stats });
  }

  public publishWorkerStats(workerId: string, stats: any): void {
    this.pubsub.publish(`WORKER_STATS_${workerId}`, { workerStatsUpdate: stats });
  }

  public getServerUrl(): string | null {
    return this.serverUrl;
  }

  public getPubSub(): PubSub {
    return this.pubsub;
  }
}