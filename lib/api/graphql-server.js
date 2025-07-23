/**
 * GraphQL API Server for Otedama Mining Pool
 * Advanced API with real-time subscriptions and comprehensive query capabilities
 * 
 * Features:
 * - GraphQL schema with types for all pool entities
 * - Real-time subscriptions for live data
 * - Complex query support with filtering and pagination
 * - Authentication and authorization
 * - Rate limiting per query complexity
 * - Query depth limiting
 * - Caching and DataLoader integration
 */

const { ApolloServer, gql, PubSub, AuthenticationError, ForbiddenError } = require('apollo-server-express');
const { GraphQLScalarType, Kind } = require('graphql');
const DataLoader = require('dataloader');
const depthLimit = require('graphql-depth-limit');
const costAnalysis = require('graphql-cost-analysis');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const { createLogger } = require('../core/logger');

const logger = createLogger('graphql-api');

// PubSub instance for subscriptions
const pubsub = new PubSub();

// Subscription topics
const TOPICS = {
  SHARE_SUBMITTED: 'SHARE_SUBMITTED',
  BLOCK_FOUND: 'BLOCK_FOUND',
  PAYMENT_SENT: 'PAYMENT_SENT',
  MINER_CONNECTED: 'MINER_CONNECTED',
  MINER_DISCONNECTED: 'MINER_DISCONNECTED',
  HASHRATE_UPDATE: 'HASHRATE_UPDATE',
  DIFFICULTY_ADJUSTED: 'DIFFICULTY_ADJUSTED'
};

// Custom scalar for Date
const DateScalar = new GraphQLScalarType({
  name: 'Date',
  description: 'Date custom scalar type',
  serialize(value) {
    return value instanceof Date ? value.toISOString() : value;
  },
  parseValue(value) {
    return new Date(value);
  },
  parseLiteral(ast) {
    if (ast.kind === Kind.INT) {
      return new Date(parseInt(ast.value, 10));
    }
    if (ast.kind === Kind.STRING) {
      return new Date(ast.value);
    }
    return null;
  }
});

// Custom scalar for BigInt
const BigIntScalar = new GraphQLScalarType({
  name: 'BigInt',
  description: 'BigInt custom scalar type',
  serialize(value) {
    return value.toString();
  },
  parseValue(value) {
    return BigInt(value);
  },
  parseLiteral(ast) {
    if (ast.kind === Kind.STRING || ast.kind === Kind.INT) {
      return BigInt(ast.value);
    }
    return null;
  }
});

// GraphQL Schema
const typeDefs = gql`
  scalar Date
  scalar BigInt

  # Enums
  enum Algorithm {
    SHA256
    SCRYPT
    ETHASH
    KAWPOW
    RANDOMX
  }

  enum PaymentStatus {
    PENDING
    PROCESSING
    COMPLETED
    FAILED
  }

  enum MinerStatus {
    ACTIVE
    INACTIVE
    BANNED
  }

  enum ShareStatus {
    VALID
    INVALID
    STALE
    DUPLICATE
  }

  enum OrderType {
    ASC
    DESC
  }

  # Input Types
  input PaginationInput {
    limit: Int = 20
    offset: Int = 0
  }

  input DateRangeInput {
    from: Date!
    to: Date!
  }

  input MinerFilterInput {
    status: MinerStatus
    algorithm: Algorithm
    minHashrate: Float
    maxHashrate: Float
    address: String
  }

  input ShareFilterInput {
    minerId: ID
    status: ShareStatus
    dateRange: DateRangeInput
  }

  input BlockFilterInput {
    algorithm: Algorithm
    dateRange: DateRangeInput
    onlyOrphaned: Boolean
  }

  # Types
  type Miner {
    id: ID!
    address: String!
    status: MinerStatus!
    algorithm: Algorithm!
    hashrate: Float!
    shares: ShareConnection!
    payments: PaymentConnection!
    workers: [Worker!]!
    statistics: MinerStatistics!
    connectedAt: Date!
    lastShareAt: Date
    totalEarnings: BigInt!
    pendingBalance: BigInt!
    settings: MinerSettings!
  }

  type Worker {
    id: ID!
    name: String!
    miner: Miner!
    hashrate: Float!
    difficulty: Float!
    shares: Int!
    lastShareAt: Date
    isOnline: Boolean!
  }

  type Share {
    id: ID!
    miner: Miner!
    worker: Worker!
    status: ShareStatus!
    difficulty: Float!
    hash: String!
    timestamp: Date!
    block: Block
  }

  type Block {
    id: ID!
    hash: String!
    height: Int!
    algorithm: Algorithm!
    difficulty: Float!
    reward: BigInt!
    timestamp: Date!
    finder: Miner!
    confirmations: Int!
    isOrphaned: Boolean!
    shares: ShareConnection!
  }

  type Payment {
    id: ID!
    miner: Miner!
    amount: BigInt!
    status: PaymentStatus!
    transactionId: String
    createdAt: Date!
    processedAt: Date
    fee: BigInt!
    currency: String!
  }

  type MinerStatistics {
    validShares: Int!
    invalidShares: Int!
    staleShares: Int!
    blocksFound: Int!
    averageHashrate: Float!
    efficiency: Float!
  }

  type MinerSettings {
    payoutThreshold: BigInt!
    emailNotifications: Boolean!
    workerNotifications: Boolean!
  }

  type PoolStatistics {
    totalHashrate: Float!
    activeMiners: Int!
    activeWorkers: Int!
    totalShares: BigInt!
    blocksFound: Int!
    totalPaid: BigInt!
    algorithms: [AlgorithmStats!]!
  }

  type AlgorithmStats {
    algorithm: Algorithm!
    hashrate: Float!
    miners: Int!
    difficulty: Float!
    blockHeight: Int!
  }

  type HashrateHistory {
    timestamp: Date!
    hashrate: Float!
  }

  type DifficultyHistory {
    timestamp: Date!
    difficulty: Float!
    algorithm: Algorithm!
  }

  # Connection types for pagination
  type ShareConnection {
    edges: [ShareEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type ShareEdge {
    node: Share!
    cursor: String!
  }

  type PaymentConnection {
    edges: [PaymentEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type PaymentEdge {
    node: Payment!
    cursor: String!
  }

  type BlockConnection {
    edges: [BlockEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type BlockEdge {
    node: Block!
    cursor: String!
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  # Queries
  type Query {
    # Pool queries
    poolStatistics: PoolStatistics!
    algorithmStats(algorithm: Algorithm): AlgorithmStats
    
    # Miner queries
    miner(id: ID, address: String): Miner
    miners(
      filter: MinerFilterInput
      pagination: PaginationInput
      orderBy: String = "hashrate"
      order: OrderType = DESC
    ): [Miner!]!
    
    # Worker queries
    worker(id: ID!): Worker
    workers(minerId: ID!): [Worker!]!
    
    # Share queries
    share(id: ID!): Share
    shares(
      filter: ShareFilterInput
      pagination: PaginationInput
    ): ShareConnection!
    
    # Block queries
    block(id: ID, hash: String, height: Int): Block
    blocks(
      filter: BlockFilterInput
      pagination: PaginationInput
    ): BlockConnection!
    
    # Payment queries
    payment(id: ID!): Payment
    payments(
      minerId: ID
      status: PaymentStatus
      pagination: PaginationInput
    ): PaymentConnection!
    
    # Historical data
    hashrateHistory(
      minerId: ID
      algorithm: Algorithm
      interval: Int = 3600
      limit: Int = 24
    ): [HashrateHistory!]!
    
    difficultyHistory(
      algorithm: Algorithm!
      limit: Int = 100
    ): [DifficultyHistory!]!
    
    # Search
    search(query: String!): SearchResults!
  }

  # Mutations
  type Mutation {
    # Miner operations
    updateMinerSettings(
      minerId: ID!
      payoutThreshold: BigInt
      emailNotifications: Boolean
      workerNotifications: Boolean
    ): Miner!
    
    # Admin operations (require authentication)
    banMiner(minerId: ID!, reason: String!): Miner!
    unbanMiner(minerId: ID!): Miner!
    
    # Payment operations
    requestPayout(minerId: ID!): Payment!
    
    # Worker operations
    renameWorker(workerId: ID!, name: String!): Worker!
  }

  # Subscriptions
  type Subscription {
    # Share events
    shareSubmitted(minerId: ID, algorithm: Algorithm): Share!
    
    # Block events
    blockFound(algorithm: Algorithm): Block!
    
    # Payment events
    paymentSent(minerId: ID): Payment!
    
    # Miner events
    minerConnected: Miner!
    minerDisconnected: Miner!
    
    # Hashrate updates
    hashrateUpdate(minerId: ID, algorithm: Algorithm): HashrateUpdate!
    
    # Difficulty adjustments
    difficultyAdjusted(algorithm: Algorithm): DifficultyUpdate!
  }

  type HashrateUpdate {
    minerId: ID!
    algorithm: Algorithm!
    hashrate: Float!
    timestamp: Date!
  }

  type DifficultyUpdate {
    algorithm: Algorithm!
    oldDifficulty: Float!
    newDifficulty: Float!
    timestamp: Date!
  }

  type SearchResults {
    miners: [Miner!]!
    blocks: [Block!]!
    transactions: [Payment!]!
  }
`;

// Create DataLoaders
class DataLoaderFactory {
  constructor(database) {
    this.database = database;
  }

  createMinerLoader() {
    return new DataLoader(async (minerIds) => {
      const miners = await this.database.getMinersByIds(minerIds);
      const minerMap = new Map(miners.map(m => [m.id, m]));
      return minerIds.map(id => minerMap.get(id));
    });
  }

  createWorkerLoader() {
    return new DataLoader(async (workerIds) => {
      const workers = await this.database.getWorkersByIds(workerIds);
      const workerMap = new Map(workers.map(w => [w.id, w]));
      return workerIds.map(id => workerMap.get(id));
    });
  }

  createShareLoader() {
    return new DataLoader(async (shareIds) => {
      const shares = await this.database.getSharesByIds(shareIds);
      const shareMap = new Map(shares.map(s => [s.id, s]));
      return shareIds.map(id => shareMap.get(id));
    });
  }

  createBlockLoader() {
    return new DataLoader(async (blockIds) => {
      const blocks = await this.database.getBlocksByIds(blockIds);
      const blockMap = new Map(blocks.map(b => [b.id, b]));
      return blockIds.map(id => blockMap.get(id));
    });
  }
}

// Resolvers
const createResolvers = (pool, database) => ({
  Date: DateScalar,
  BigInt: BigIntScalar,

  Query: {
    // Pool queries
    poolStatistics: async () => {
      return pool.getStatistics();
    },

    algorithmStats: async (_, { algorithm }) => {
      const stats = await pool.getAlgorithmStats(algorithm);
      return stats;
    },

    // Miner queries
    miner: async (_, { id, address }, { loaders }) => {
      if (id) {
        return loaders.minerLoader.load(id);
      }
      if (address) {
        return database.getMinerByAddress(address);
      }
      return null;
    },

    miners: async (_, { filter, pagination, orderBy, order }) => {
      return database.getMiners({ filter, pagination, orderBy, order });
    },

    // Worker queries
    worker: async (_, { id }, { loaders }) => {
      return loaders.workerLoader.load(id);
    },

    workers: async (_, { minerId }) => {
      return database.getWorkersByMinerId(minerId);
    },

    // Share queries
    share: async (_, { id }, { loaders }) => {
      return loaders.shareLoader.load(id);
    },

    shares: async (_, { filter, pagination }) => {
      const result = await database.getShares({ filter, pagination });
      return {
        edges: result.shares.map(share => ({
          node: share,
          cursor: Buffer.from(share.id.toString()).toString('base64')
        })),
        pageInfo: {
          hasNextPage: result.hasMore,
          hasPreviousPage: pagination.offset > 0,
          startCursor: result.shares[0]?.id,
          endCursor: result.shares[result.shares.length - 1]?.id
        },
        totalCount: result.total
      };
    },

    // Block queries
    block: async (_, { id, hash, height }, { loaders }) => {
      if (id) {
        return loaders.blockLoader.load(id);
      }
      if (hash) {
        return database.getBlockByHash(hash);
      }
      if (height) {
        return database.getBlockByHeight(height);
      }
      return null;
    },

    blocks: async (_, { filter, pagination }) => {
      const result = await database.getBlocks({ filter, pagination });
      return {
        edges: result.blocks.map(block => ({
          node: block,
          cursor: Buffer.from(block.id.toString()).toString('base64')
        })),
        pageInfo: {
          hasNextPage: result.hasMore,
          hasPreviousPage: pagination.offset > 0,
          startCursor: result.blocks[0]?.id,
          endCursor: result.blocks[result.blocks.length - 1]?.id
        },
        totalCount: result.total
      };
    },

    // Payment queries
    payment: async (_, { id }) => {
      return database.getPaymentById(id);
    },

    payments: async (_, { minerId, status, pagination }) => {
      const result = await database.getPayments({ minerId, status, pagination });
      return {
        edges: result.payments.map(payment => ({
          node: payment,
          cursor: Buffer.from(payment.id.toString()).toString('base64')
        })),
        pageInfo: {
          hasNextPage: result.hasMore,
          hasPreviousPage: pagination.offset > 0,
          startCursor: result.payments[0]?.id,
          endCursor: result.payments[result.payments.length - 1]?.id
        },
        totalCount: result.total
      };
    },

    // Historical data
    hashrateHistory: async (_, { minerId, algorithm, interval, limit }) => {
      return database.getHashrateHistory({ minerId, algorithm, interval, limit });
    },

    difficultyHistory: async (_, { algorithm, limit }) => {
      return database.getDifficultyHistory({ algorithm, limit });
    },

    // Search
    search: async (_, { query }) => {
      const results = await database.search(query);
      return {
        miners: results.miners || [],
        blocks: results.blocks || [],
        transactions: results.payments || []
      };
    }
  },

  Mutation: {
    // Miner operations
    updateMinerSettings: async (_, args, { user }) => {
      if (!user || user.id !== args.minerId) {
        throw new ForbiddenError('Not authorized to update these settings');
      }
      
      return database.updateMinerSettings(args.minerId, {
        payoutThreshold: args.payoutThreshold,
        emailNotifications: args.emailNotifications,
        workerNotifications: args.workerNotifications
      });
    },

    // Admin operations
    banMiner: async (_, { minerId, reason }, { user }) => {
      if (!user || !user.isAdmin) {
        throw new ForbiddenError('Admin access required');
      }
      
      return database.banMiner(minerId, reason);
    },

    unbanMiner: async (_, { minerId }, { user }) => {
      if (!user || !user.isAdmin) {
        throw new ForbiddenError('Admin access required');
      }
      
      return database.unbanMiner(minerId);
    },

    // Payment operations
    requestPayout: async (_, { minerId }, { user }) => {
      if (!user || user.id !== minerId) {
        throw new ForbiddenError('Not authorized to request payout');
      }
      
      return pool.requestPayout(minerId);
    },

    // Worker operations
    renameWorker: async (_, { workerId, name }, { user }) => {
      const worker = await database.getWorkerById(workerId);
      
      if (!user || user.id !== worker.minerId) {
        throw new ForbiddenError('Not authorized to rename this worker');
      }
      
      return database.renameWorker(workerId, name);
    }
  },

  Subscription: {
    shareSubmitted: {
      subscribe: (_, { minerId, algorithm }) => {
        const topics = [];
        
        if (minerId) {
          topics.push(`${TOPICS.SHARE_SUBMITTED}:${minerId}`);
        }
        if (algorithm) {
          topics.push(`${TOPICS.SHARE_SUBMITTED}:${algorithm}`);
        }
        if (!minerId && !algorithm) {
          topics.push(TOPICS.SHARE_SUBMITTED);
        }
        
        return pubsub.asyncIterator(topics);
      }
    },

    blockFound: {
      subscribe: (_, { algorithm }) => {
        if (algorithm) {
          return pubsub.asyncIterator(`${TOPICS.BLOCK_FOUND}:${algorithm}`);
        }
        return pubsub.asyncIterator(TOPICS.BLOCK_FOUND);
      }
    },

    paymentSent: {
      subscribe: (_, { minerId }) => {
        if (minerId) {
          return pubsub.asyncIterator(`${TOPICS.PAYMENT_SENT}:${minerId}`);
        }
        return pubsub.asyncIterator(TOPICS.PAYMENT_SENT);
      }
    },

    minerConnected: {
      subscribe: () => pubsub.asyncIterator(TOPICS.MINER_CONNECTED)
    },

    minerDisconnected: {
      subscribe: () => pubsub.asyncIterator(TOPICS.MINER_DISCONNECTED)
    },

    hashrateUpdate: {
      subscribe: (_, { minerId, algorithm }) => {
        const topics = [];
        
        if (minerId) {
          topics.push(`${TOPICS.HASHRATE_UPDATE}:${minerId}`);
        }
        if (algorithm) {
          topics.push(`${TOPICS.HASHRATE_UPDATE}:${algorithm}`);
        }
        if (!minerId && !algorithm) {
          topics.push(TOPICS.HASHRATE_UPDATE);
        }
        
        return pubsub.asyncIterator(topics);
      }
    },

    difficultyAdjusted: {
      subscribe: (_, { algorithm }) => {
        if (algorithm) {
          return pubsub.asyncIterator(`${TOPICS.DIFFICULTY_ADJUSTED}:${algorithm}`);
        }
        return pubsub.asyncIterator(TOPICS.DIFFICULTY_ADJUSTED);
      }
    }
  },

  // Field resolvers
  Miner: {
    shares: async (miner, { pagination }) => {
      return database.getSharesByMinerId(miner.id, pagination);
    },

    payments: async (miner, { pagination }) => {
      return database.getPaymentsByMinerId(miner.id, pagination);
    },

    workers: async (miner) => {
      return database.getWorkersByMinerId(miner.id);
    },

    statistics: async (miner) => {
      return database.getMinerStatistics(miner.id);
    },

    settings: async (miner) => {
      return database.getMinerSettings(miner.id);
    }
  },

  Worker: {
    miner: async (worker, _, { loaders }) => {
      return loaders.minerLoader.load(worker.minerId);
    }
  },

  Share: {
    miner: async (share, _, { loaders }) => {
      return loaders.minerLoader.load(share.minerId);
    },

    worker: async (share, _, { loaders }) => {
      return loaders.workerLoader.load(share.workerId);
    },

    block: async (share, _, { loaders }) => {
      if (share.blockId) {
        return loaders.blockLoader.load(share.blockId);
      }
      return null;
    }
  },

  Block: {
    finder: async (block, _, { loaders }) => {
      return loaders.minerLoader.load(block.finderId);
    },

    shares: async (block, { pagination }) => {
      return database.getSharesByBlockId(block.id, pagination);
    }
  },

  Payment: {
    miner: async (payment, _, { loaders }) => {
      return loaders.minerLoader.load(payment.minerId);
    }
  }
});

// Rate limiter for queries
const queryRateLimiter = new RateLimiterMemory({
  points: 100,
  duration: 60, // per minute
  blockDuration: 60 * 5 // 5 minutes
});

// Create GraphQL server
class GraphQLServer {
  constructor(pool, database, options = {}) {
    this.pool = pool;
    this.database = database;
    this.options = {
      port: options.port || 4000,
      path: options.path || '/graphql',
      playground: options.playground !== false,
      introspection: options.introspection !== false,
      ...options
    };
    
    this.server = null;
    this.httpServer = null;
  }

  async initialize(app) {
    const loaderFactory = new DataLoaderFactory(this.database);
    
    this.server = new ApolloServer({
      typeDefs,
      resolvers: createResolvers(this.pool, this.database),
      
      context: async ({ req, connection }) => {
        // For subscriptions
        if (connection) {
          return {
            ...connection.context,
            loaders: {
              minerLoader: loaderFactory.createMinerLoader(),
              workerLoader: loaderFactory.createWorkerLoader(),
              shareLoader: loaderFactory.createShareLoader(),
              blockLoader: loaderFactory.createBlockLoader()
            }
          };
        }
        
        // For queries and mutations
        const user = await this.authenticateUser(req);
        
        // Rate limiting
        if (user) {
          await queryRateLimiter.consume(user.id);
        } else {
          await queryRateLimiter.consume(req.ip);
        }
        
        return {
          user,
          loaders: {
            minerLoader: loaderFactory.createMinerLoader(),
            workerLoader: loaderFactory.createWorkerLoader(),
            shareLoader: loaderFactory.createShareLoader(),
            blockLoader: loaderFactory.createBlockLoader()
          }
        };
      },
      
      validationRules: [
        depthLimit(5),
        costAnalysis({
          maximumCost: 1000,
          defaultCost: 1,
          variables: {},
          createError: (max, actual) => {
            return new Error(`Query cost ${actual} exceeds maximum cost ${max}`);
          }
        })
      ],
      
      formatError: (error) => {
        logger.error('GraphQL error:', error);
        
        // Remove internal error details in production
        if (process.env.NODE_ENV === 'production') {
          delete error.extensions.exception;
        }
        
        return error;
      },
      
      subscriptions: {
        path: '/subscriptions',
        onConnect: async (connectionParams) => {
          if (connectionParams.authToken) {
            const user = await this.validateToken(connectionParams.authToken);
            return { user };
          }
          return {};
        },
        onDisconnect: () => {
          logger.debug('Subscription client disconnected');
        }
      },
      
      playground: this.options.playground,
      introspection: this.options.introspection
    });
    
    await this.server.applyMiddleware({ app, path: this.options.path });
    
    // Store HTTP server reference for subscriptions
    this.httpServer = app;
    
    logger.info(`GraphQL server initialized at ${this.options.path}`);
  }

  async authenticateUser(req) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return null;
    
    try {
      return await this.validateToken(token);
    } catch (error) {
      throw new AuthenticationError('Invalid token');
    }
  }

  async validateToken(token) {
    // Implement token validation
    // This would integrate with your auth system
    return {
      id: 'user123',
      isAdmin: false
    };
  }

  // Event publishers for subscriptions
  publishShareSubmitted(share) {
    pubsub.publish(TOPICS.SHARE_SUBMITTED, { shareSubmitted: share });
    pubsub.publish(`${TOPICS.SHARE_SUBMITTED}:${share.minerId}`, { shareSubmitted: share });
    pubsub.publish(`${TOPICS.SHARE_SUBMITTED}:${share.algorithm}`, { shareSubmitted: share });
  }

  publishBlockFound(block) {
    pubsub.publish(TOPICS.BLOCK_FOUND, { blockFound: block });
    pubsub.publish(`${TOPICS.BLOCK_FOUND}:${block.algorithm}`, { blockFound: block });
  }

  publishPaymentSent(payment) {
    pubsub.publish(TOPICS.PAYMENT_SENT, { paymentSent: payment });
    pubsub.publish(`${TOPICS.PAYMENT_SENT}:${payment.minerId}`, { paymentSent: payment });
  }

  publishMinerConnected(miner) {
    pubsub.publish(TOPICS.MINER_CONNECTED, { minerConnected: miner });
  }

  publishMinerDisconnected(miner) {
    pubsub.publish(TOPICS.MINER_DISCONNECTED, { minerDisconnected: miner });
  }

  publishHashrateUpdate(update) {
    pubsub.publish(TOPICS.HASHRATE_UPDATE, { hashrateUpdate: update });
    pubsub.publish(`${TOPICS.HASHRATE_UPDATE}:${update.minerId}`, { hashrateUpdate: update });
    pubsub.publish(`${TOPICS.HASHRATE_UPDATE}:${update.algorithm}`, { hashrateUpdate: update });
  }

  publishDifficultyAdjusted(update) {
    pubsub.publish(TOPICS.DIFFICULTY_ADJUSTED, { difficultyAdjusted: update });
    pubsub.publish(`${TOPICS.DIFFICULTY_ADJUSTED}:${update.algorithm}`, { difficultyAdjusted: update });
  }
}

module.exports = GraphQLServer;