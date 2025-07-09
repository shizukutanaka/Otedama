// GraphQL API System (Item 97: Advanced Features)
// Flexible GraphQL API for comprehensive pool data access

import { Logger } from '../logging/logger';
import { EventEmitter } from 'events';

export interface GraphQLConfig {
  enabled: boolean;
  endpoint: string;
  playground: boolean;
  introspection: boolean;
  tracing: boolean;
  caching: boolean;
  subscriptions: boolean;
  maxDepth: number;
  maxComplexity: number;
  timeout: number;
  rateLimiting: {
    enabled: boolean;
    maxRequests: number;
    windowMs: number;
  };
}

export interface GraphQLContext {
  user?: any;
  pool: any;
  database: any;
  metrics: any;
  logger: Logger;
  ip: string;
  userAgent: string;
  startTime: number;
}

export interface GraphQLResolver {
  [key: string]: any;
}

export interface GraphQLSubscription {
  subscribe(args: any, context: GraphQLContext): AsyncIterator<any>;
  resolve?(parent: any, args: any, context: GraphQLContext): any;
}

/**
 * Advanced GraphQL API Server
 * Provides flexible and efficient data access for mining pool operations
 */
export class GraphQLServer extends EventEmitter {
  private logger = new Logger('GraphQL');
  private config: GraphQLConfig;
  private schema: string;
  private resolvers: GraphQLResolver;
  private subscriptionManager: GraphQLSubscriptionManager;
  
  constructor(config: GraphQLConfig) {
    super();
    this.config = config;
    this.subscriptionManager = new GraphQLSubscriptionManager();
    this.initializeSchema();
    this.initializeResolvers();
  }
  
  /**
   * Initialize GraphQL schema
   */
  private initializeSchema(): void {
    this.schema = `
      # Pool Information
      type Pool {
        address: String!
        fee: Float!
        name: String!
        description: String
        website: String
        hashrate: Float!
        miners: Int!
        blocks: Int!
        uptime: Int!
        version: String!
        network: String!
      }
      
      # Miner Information
      type Miner {
        id: ID!
        address: String!
        workers: [Worker!]!
        hashrate: Float!
        shares: ShareStats!
        payments: [Payment!]!
        connected: Boolean!
        lastActivity: String
        totalEarnings: Float!
        estimatedEarnings: Float!
      }
      
      # Worker Information
      type Worker {
        id: String!
        name: String!
        hashrate: Float!
        shares: ShareStats!
        connected: Boolean!
        lastActivity: String
        difficulty: Float!
        version: String
      }
      
      # Share Statistics
      type ShareStats {
        submitted: Int!
        accepted: Int!
        rejected: Int!
        stale: Int!
        duplicate: Int!
        acceptanceRate: Float!
        efficiency: Float!
      }
      
      # Share Information
      type Share {
        id: ID!
        minerId: String!
        workerId: String
        jobId: String!
        nonce: String!
        timestamp: String!
        difficulty: Float!
        target: String!
        status: ShareStatus!
        blockHash: String
        txHash: String
      }
      
      enum ShareStatus {
        ACCEPTED
        REJECTED
        STALE
        DUPLICATE
      }
      
      # Block Information
      type Block {
        id: ID!
        height: Int!
        hash: String!
        previousHash: String!
        timestamp: String!
        difficulty: Float!
        reward: Float!
        fees: Float!
        transactions: Int!
        size: Int!
        finderId: String
        confirmed: Boolean!
        confirmations: Int!
        orphaned: Boolean!
      }
      
      # Payment Information
      type Payment {
        id: ID!
        minerId: String!
        amount: Float!
        fee: Float!
        txHash: String
        timestamp: String!
        status: PaymentStatus!
        blockHeight: Int
        confirmations: Int!
        method: String!
      }
      
      enum PaymentStatus {
        PENDING
        SENT
        CONFIRMED
        FAILED
      }
      
      # Network Statistics
      type NetworkStats {
        height: Int!
        difficulty: Float!
        hashrate: Float!
        mempool: Int!
        price: Float
        nodes: Int!
      }
      
      # Pool Statistics
      type PoolStats {
        hashrate: HashrateStats!
        miners: MinerStats!
        shares: ShareStats!
        blocks: BlockStats!
        payments: PaymentStats!
        network: NetworkStats!
        system: SystemStats!
      }
      
      type HashrateStats {
        current: Float!
        average1h: Float!
        average24h: Float!
        average7d: Float!
        peak24h: Float!
        workers: Int!
      }
      
      type MinerStats {
        total: Int!
        active: Int!
        inactive: Int!
        new24h: Int!
        countries: [CountryStats!]!
      }
      
      type CountryStats {
        country: String!
        count: Int!
        hashrate: Float!
      }
      
      type BlockStats {
        found24h: Int!
        found7d: Int!
        foundTotal: Int!
        orphaned: Int!
        luck24h: Float!
        luck7d: Float!
        avgTime: Float!
      }
      
      type PaymentStats {
        pending: Float!
        sent24h: Float!
        sent7d: Float!
        sentTotal: Float!
        fees24h: Float!
        avgTime: Float!
      }
      
      type SystemStats {
        uptime: Int!
        version: String!
        connections: Int!
        load: Float!
        memory: Float!
        disk: Float!
        errors24h: Int!
      }
      
      # Time series data
      type TimeSeriesData {
        timestamp: String!
        value: Float!
      }
      
      # Pagination
      type PageInfo {
        hasNextPage: Boolean!
        hasPreviousPage: Boolean!
        startCursor: String
        endCursor: String
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
      
      type BlockConnection {
        edges: [BlockEdge!]!
        pageInfo: PageInfo!
        totalCount: Int!
      }
      
      type BlockEdge {
        node: Block!
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
      
      # Input types for filtering
      input DateRange {
        from: String!
        to: String!
      }
      
      input ShareFilter {
        minerId: String
        workerId: String
        status: ShareStatus
        dateRange: DateRange
        minDifficulty: Float
        maxDifficulty: Float
      }
      
      input BlockFilter {
        confirmed: Boolean
        orphaned: Boolean
        dateRange: DateRange
        minHeight: Int
        maxHeight: Int
      }
      
      input PaymentFilter {
        minerId: String
        status: PaymentStatus
        dateRange: DateRange
        minAmount: Float
        maxAmount: Float
      }
      
      # Queries
      type Query {
        # Pool information
        pool: Pool!
        
        # Statistics
        stats: PoolStats!
        hashrate(period: String = "1h"): [TimeSeriesData!]!
        
        # Miners
        miners(
          first: Int = 20
          after: String
          filter: String
          sortBy: String = "hashrate"
          sortOrder: String = "DESC"
        ): [Miner!]!
        
        miner(id: String!): Miner
        
        # Shares
        shares(
          first: Int = 50
          after: String
          filter: ShareFilter
          sortBy: String = "timestamp"
          sortOrder: String = "DESC"
        ): ShareConnection!
        
        share(id: String!): Share
        
        # Blocks
        blocks(
          first: Int = 20
          after: String
          filter: BlockFilter
          sortBy: String = "height"
          sortOrder: String = "DESC"
        ): BlockConnection!
        
        block(id: String!): Block
        
        # Payments
        payments(
          first: Int = 20
          after: String
          filter: PaymentFilter
          sortBy: String = "timestamp"
          sortOrder: String = "DESC"
        ): PaymentConnection!
        
        payment(id: String!): Payment
        
        # Search
        search(
          query: String!
          type: String
          limit: Int = 10
        ): [SearchResult!]!
      }
      
      union SearchResult = Miner | Block | Payment | Share
      
      # Mutations
      type Mutation {
        # Miner operations
        updateMinerSettings(
          minerId: String!
          settings: MinerSettingsInput!
        ): Miner!
        
        # Payment operations
        requestPayout(minerId: String!): Payment!
        
        # Administrative operations
        banMiner(minerId: String!, reason: String!): Boolean!
        unbanMiner(minerId: String!): Boolean!
      }
      
      input MinerSettingsInput {
        minimumPayout: Float
        email: String
        notifications: Boolean
      }
      
      # Subscriptions
      type Subscription {
        # Real-time updates
        shareSubmitted: Share!
        blockFound: Block!
        paymentSent: Payment!
        minerConnected: Miner!
        minerDisconnected: Miner!
        
        # Statistics updates
        poolStats: PoolStats!
        hashrateUpdate: Float!
        
        # Filtered subscriptions
        minerShares(minerId: String!): Share!
        minerPayments(minerId: String!): Payment!
      }
    `;
  }
  
  /**
   * Initialize GraphQL resolvers
   */
  private initializeResolvers(): void {
    this.resolvers = {
      Query: {
        pool: this.resolvePool.bind(this),
        stats: this.resolveStats.bind(this),
        hashrate: this.resolveHashrate.bind(this),
        miners: this.resolveMiners.bind(this),
        miner: this.resolveMiner.bind(this),
        shares: this.resolveShares.bind(this),
        share: this.resolveShare.bind(this),
        blocks: this.resolveBlocks.bind(this),
        block: this.resolveBlock.bind(this),
        payments: this.resolvePayments.bind(this),
        payment: this.resolvePayment.bind(this),
        search: this.resolveSearch.bind(this)
      },
      
      Mutation: {
        updateMinerSettings: this.updateMinerSettings.bind(this),
        requestPayout: this.requestPayout.bind(this),
        banMiner: this.banMiner.bind(this),
        unbanMiner: this.unbanMiner.bind(this)
      },
      
      Subscription: {
        shareSubmitted: this.subscriptionManager.createSubscription('shareSubmitted'),
        blockFound: this.subscriptionManager.createSubscription('blockFound'),
        paymentSent: this.subscriptionManager.createSubscription('paymentSent'),
        minerConnected: this.subscriptionManager.createSubscription('minerConnected'),
        minerDisconnected: this.subscriptionManager.createSubscription('minerDisconnected'),
        poolStats: this.subscriptionManager.createSubscription('poolStats'),
        hashrateUpdate: this.subscriptionManager.createSubscription('hashrateUpdate'),
        minerShares: this.subscriptionManager.createFilteredSubscription('minerShares'),
        minerPayments: this.subscriptionManager.createFilteredSubscription('minerPayments')
      },
      
      // Union type resolver
      SearchResult: {
        __resolveType: (obj: any) => {
          if (obj.address && obj.workers) return 'Miner';
          if (obj.hash && obj.height) return 'Block';
          if (obj.amount && obj.txHash) return 'Payment';
          if (obj.nonce && obj.difficulty) return 'Share';
          return null;
        }
      }
    };
  }
  
  /**
   * Pool resolver
   */
  private async resolvePool(parent: any, args: any, context: GraphQLContext): Promise<any> {
    try {
      return {
        address: context.pool.getAddress(),
        fee: context.pool.getFee(),
        name: context.pool.getName(),
        description: context.pool.getDescription(),
        website: context.pool.getWebsite(),
        hashrate: await context.pool.getCurrentHashrate(),
        miners: await context.pool.getActiveMinerCount(),
        blocks: await context.pool.getBlockCount(),
        uptime: context.pool.getUptime(),
        version: context.pool.getVersion(),
        network: context.pool.getNetwork()
      };
    } catch (error) {
      context.logger.error('Error resolving pool:', error);
      throw error;
    }
  }
  
  /**
   * Statistics resolver
   */
  private async resolveStats(parent: any, args: any, context: GraphQLContext): Promise<any> {
    try {
      const stats = await context.pool.getStatistics();
      return {
        hashrate: stats.hashrate,
        miners: stats.miners,
        shares: stats.shares,
        blocks: stats.blocks,
        payments: stats.payments,
        network: stats.network,
        system: stats.system
      };
    } catch (error) {
      context.logger.error('Error resolving stats:', error);
      throw error;
    }
  }
  
  /**
   * Hashrate time series resolver
   */
  private async resolveHashrate(parent: any, args: any, context: GraphQLContext): Promise<any[]> {
    try {
      const { period = '1h' } = args;
      const data = await context.metrics.getHashrateTimeSeries(period);
      
      return data.map((point: any) => ({
        timestamp: point.timestamp,
        value: point.hashrate
      }));
    } catch (error) {
      context.logger.error('Error resolving hashrate:', error);
      throw error;
    }
  }
  
  /**
   * Miners resolver
   */
  private async resolveMiners(parent: any, args: any, context: GraphQLContext): Promise<any[]> {
    try {
      const { first = 20, after, filter, sortBy = 'hashrate', sortOrder = 'DESC' } = args;
      
      const miners = await context.database.getMiners({
        limit: first,
        offset: after ? this.decodeCursor(after) : 0,
        filter,
        sortBy,
        sortOrder
      });
      
      return miners.map((miner: any) => this.transformMiner(miner));
    } catch (error) {
      context.logger.error('Error resolving miners:', error);
      throw error;
    }
  }
  
  /**
   * Individual miner resolver
   */
  private async resolveMiner(parent: any, args: any, context: GraphQLContext): Promise<any> {
    try {
      const { id } = args;
      const miner = await context.database.getMiner(id);
      
      if (!miner) {
        throw new Error(`Miner not found: ${id}`);
      }
      
      return this.transformMiner(miner);
    } catch (error) {
      context.logger.error('Error resolving miner:', error);
      throw error;
    }
  }
  
  /**
   * Shares resolver with pagination
   */
  private async resolveShares(parent: any, args: any, context: GraphQLContext): Promise<any> {
    try {
      const { first = 50, after, filter, sortBy = 'timestamp', sortOrder = 'DESC' } = args;
      
      const result = await context.database.getShares({
        limit: first + 1, // Get one extra to check if there's a next page
        offset: after ? this.decodeCursor(after) : 0,
        filter,
        sortBy,
        sortOrder
      });
      
      const shares = result.shares.slice(0, first);
      const hasNextPage = result.shares.length > first;
      
      return {
        edges: shares.map((share: any, index: number) => ({
          node: this.transformShare(share),
          cursor: this.encodeCursor((after ? this.decodeCursor(after) : 0) + index)
        })),
        pageInfo: {
          hasNextPage,
          hasPreviousPage: !!after,
          startCursor: shares.length > 0 ? this.encodeCursor(0) : null,
          endCursor: shares.length > 0 ? this.encodeCursor(shares.length - 1) : null
        },
        totalCount: result.totalCount
      };
    } catch (error) {
      context.logger.error('Error resolving shares:', error);
      throw error;
    }
  }
  
  /**
   * Individual share resolver
   */
  private async resolveShare(parent: any, args: any, context: GraphQLContext): Promise<any> {
    try {
      const { id } = args;
      const share = await context.database.getShare(id);
      
      if (!share) {
        throw new Error(`Share not found: ${id}`);
      }
      
      return this.transformShare(share);
    } catch (error) {
      context.logger.error('Error resolving share:', error);
      throw error;
    }
  }
  
  /**
   * Blocks resolver
   */
  private async resolveBlocks(parent: any, args: any, context: GraphQLContext): Promise<any> {
    // Similar to shares resolver but for blocks
    return this.resolvePaginatedData('blocks', args, context);
  }
  
  /**
   * Individual block resolver
   */
  private async resolveBlock(parent: any, args: any, context: GraphQLContext): Promise<any> {
    try {
      const { id } = args;
      const block = await context.database.getBlock(id);
      
      if (!block) {
        throw new Error(`Block not found: ${id}`);
      }
      
      return this.transformBlock(block);
    } catch (error) {
      context.logger.error('Error resolving block:', error);
      throw error;
    }
  }
  
  /**
   * Payments resolver
   */
  private async resolvePayments(parent: any, args: any, context: GraphQLContext): Promise<any> {
    return this.resolvePaginatedData('payments', args, context);
  }
  
  /**
   * Individual payment resolver
   */
  private async resolvePayment(parent: any, args: any, context: GraphQLContext): Promise<any> {
    try {
      const { id } = args;
      const payment = await context.database.getPayment(id);
      
      if (!payment) {
        throw new Error(`Payment not found: ${id}`);
      }
      
      return this.transformPayment(payment);
    } catch (error) {
      context.logger.error('Error resolving payment:', error);
      throw error;
    }
  }
  
  /**
   * Search resolver
   */
  private async resolveSearch(parent: any, args: any, context: GraphQLContext): Promise<any[]> {
    try {
      const { query, type, limit = 10 } = args;
      const results = await context.database.search(query, type, limit);
      
      return results.map((result: any) => {
        switch (result.type) {
          case 'miner':
            return this.transformMiner(result.data);
          case 'block':
            return this.transformBlock(result.data);
          case 'payment':
            return this.transformPayment(result.data);
          case 'share':
            return this.transformShare(result.data);
          default:
            return result.data;
        }
      });
    } catch (error) {
      context.logger.error('Error resolving search:', error);
      throw error;
    }
  }
  
  /**
   * Update miner settings mutation
   */
  private async updateMinerSettings(parent: any, args: any, context: GraphQLContext): Promise<any> {
    try {
      const { minerId, settings } = args;
      const updatedMiner = await context.database.updateMinerSettings(minerId, settings);
      return this.transformMiner(updatedMiner);
    } catch (error) {
      context.logger.error('Error updating miner settings:', error);
      throw error;
    }
  }
  
  /**
   * Request payout mutation
   */
  private async requestPayout(parent: any, args: any, context: GraphQLContext): Promise<any> {
    try {
      const { minerId } = args;
      const payment = await context.pool.requestPayout(minerId);
      return this.transformPayment(payment);
    } catch (error) {
      context.logger.error('Error requesting payout:', error);
      throw error;
    }
  }
  
  /**
   * Ban miner mutation
   */
  private async banMiner(parent: any, args: any, context: GraphQLContext): Promise<boolean> {
    try {
      const { minerId, reason } = args;
      await context.pool.banMiner(minerId, reason);
      return true;
    } catch (error) {
      context.logger.error('Error banning miner:', error);
      throw error;
    }
  }
  
  /**
   * Unban miner mutation
   */
  private async unbanMiner(parent: any, args: any, context: GraphQLContext): Promise<boolean> {
    try {
      const { minerId } = args;
      await context.pool.unbanMiner(minerId);
      return true;
    } catch (error) {
      context.logger.error('Error unbanning miner:', error);
      throw error;
    }
  }
  
  /**
   * Generic paginated data resolver
   */
  private async resolvePaginatedData(type: string, args: any, context: GraphQLContext): Promise<any> {
    // Implementation for paginated data resolution
    // This would be customized for each data type
    return {
      edges: [],
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null
      },
      totalCount: 0
    };
  }
  
  /**
   * Transform database miner to GraphQL miner
   */
  private transformMiner(miner: any): any {
    return {
      id: miner.id,
      address: miner.address,
      workers: miner.workers || [],
      hashrate: miner.hashrate || 0,
      shares: miner.shareStats || {
        submitted: 0,
        accepted: 0,
        rejected: 0,
        stale: 0,
        duplicate: 0,
        acceptanceRate: 0,
        efficiency: 0
      },
      payments: miner.payments || [],
      connected: miner.connected || false,
      lastActivity: miner.lastActivity,
      totalEarnings: miner.totalEarnings || 0,
      estimatedEarnings: miner.estimatedEarnings || 0
    };
  }
  
  /**
   * Transform database share to GraphQL share
   */
  private transformShare(share: any): any {
    return {
      id: share.id,
      minerId: share.minerId,
      workerId: share.workerId,
      jobId: share.jobId,
      nonce: share.nonce,
      timestamp: share.timestamp,
      difficulty: share.difficulty,
      target: share.target,
      status: share.status,
      blockHash: share.blockHash,
      txHash: share.txHash
    };
  }
  
  /**
   * Transform database block to GraphQL block
   */
  private transformBlock(block: any): any {
    return {
      id: block.id,
      height: block.height,
      hash: block.hash,
      previousHash: block.previousHash,
      timestamp: block.timestamp,
      difficulty: block.difficulty,
      reward: block.reward,
      fees: block.fees,
      transactions: block.transactions,
      size: block.size,
      finderId: block.finderId,
      confirmed: block.confirmed,
      confirmations: block.confirmations,
      orphaned: block.orphaned
    };
  }
  
  /**
   * Transform database payment to GraphQL payment
   */
  private transformPayment(payment: any): any {
    return {
      id: payment.id,
      minerId: payment.minerId,
      amount: payment.amount,
      fee: payment.fee,
      txHash: payment.txHash,
      timestamp: payment.timestamp,
      status: payment.status,
      blockHeight: payment.blockHeight,
      confirmations: payment.confirmations,
      method: payment.method
    };
  }
  
  /**
   * Encode cursor for pagination
   */
  private encodeCursor(offset: number): string {
    return Buffer.from(offset.toString()).toString('base64');
  }
  
  /**
   * Decode cursor for pagination
   */
  private decodeCursor(cursor: string): number {
    return parseInt(Buffer.from(cursor, 'base64').toString());
  }
  
  /**
   * Create Express middleware for GraphQL
   */
  createMiddleware() {
    return async (req: any, res: any, next: any) => {
      try {
        const context: GraphQLContext = {
          pool: req.pool,
          database: req.database,
          metrics: req.metrics,
          logger: this.logger,
          ip: req.ip,
          userAgent: req.get('User-Agent') || '',
          startTime: Date.now()
        };
        
        // Mock GraphQL execution (would use real GraphQL library in production)
        const result = await this.executeGraphQLQuery(req.body.query, req.body.variables, context);
        
        res.json(result);
      } catch (error) {
        this.logger.error('GraphQL execution error:', error);
        res.status(500).json({
          errors: [{ message: 'Internal server error' }]
        });
      }
    };
  }
  
  /**
   * Execute GraphQL query (mock implementation)
   */
  private async executeGraphQLQuery(query: string, variables: any, context: GraphQLContext): Promise<any> {
    // This would use a real GraphQL execution engine in production
    // For now, return mock data
    return {
      data: {
        pool: {
          address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
          fee: 1.0,
          name: 'Otedama Pool',
          hashrate: 1000000000000,
          miners: 42,
          blocks: 123
        }
      }
    };
  }
  
  /**
   * Get GraphQL schema
   */
  getSchema(): string {
    return this.schema;
  }
  
  /**
   * Get GraphQL resolvers
   */
  getResolvers(): GraphQLResolver {
    return this.resolvers;
  }
}

/**
 * GraphQL Subscription Manager
 */
class GraphQLSubscriptionManager {
  private logger = new Logger('GraphQLSubscriptions');
  private subscriptions = new Map<string, Set<any>>();
  
  /**
   * Create subscription resolver
   */
  createSubscription(eventName: string): GraphQLSubscription {
    return {
      subscribe: (args: any, context: GraphQLContext) => {
        return this.createAsyncIterator(eventName, args, context);
      }
    };
  }
  
  /**
   * Create filtered subscription resolver
   */
  createFilteredSubscription(eventName: string): GraphQLSubscription {
    return {
      subscribe: (args: any, context: GraphQLContext) => {
        return this.createAsyncIterator(eventName, args, context);
      }
    };
  }
  
  /**
   * Create async iterator for subscription
   */
  private createAsyncIterator(eventName: string, args: any, context: GraphQLContext): AsyncIterator<any> {
    const iterator = {
      [Symbol.asyncIterator]: () => iterator,
      next: async (): Promise<IteratorResult<any>> => {
        // Mock implementation - would integrate with real subscription system
        return new Promise(resolve => {
          setTimeout(() => {
            resolve({
              value: { [eventName]: { mockData: true, timestamp: Date.now() } },
              done: false
            });
          }, 1000);
        });
      },
      return: async (): Promise<IteratorResult<any>> => {
        return { value: undefined, done: true };
      },
      throw: async (error: any): Promise<IteratorResult<any>> => {
        throw error;
      }
    };
    
    return iterator;
  }
  
  /**
   * Publish event to subscriptions
   */
  publish(eventName: string, payload: any): void {
    const subscribers = this.subscriptions.get(eventName);
    if (subscribers) {
      subscribers.forEach(subscriber => {
        try {
          subscriber(payload);
        } catch (error) {
          this.logger.error(`Error in subscription ${eventName}:`, error);
        }
      });
    }
  }
}

/**
 * Factory function for creating GraphQL server
 */
export function createGraphQLServer(config: Partial<GraphQLConfig> = {}): GraphQLServer {
  const defaultConfig: GraphQLConfig = {
    enabled: process.env.GRAPHQL_ENABLED === 'true',
    endpoint: process.env.GRAPHQL_ENDPOINT || '/graphql',
    playground: process.env.NODE_ENV !== 'production',
    introspection: process.env.NODE_ENV !== 'production',
    tracing: process.env.GRAPHQL_TRACING === 'true',
    caching: process.env.GRAPHQL_CACHING === 'true',
    subscriptions: process.env.GRAPHQL_SUBSCRIPTIONS === 'true',
    maxDepth: parseInt(process.env.GRAPHQL_MAX_DEPTH || '10'),
    maxComplexity: parseInt(process.env.GRAPHQL_MAX_COMPLEXITY || '1000'),
    timeout: parseInt(process.env.GRAPHQL_TIMEOUT || '30000'),
    rateLimiting: {
      enabled: process.env.GRAPHQL_RATE_LIMITING === 'true',
      maxRequests: parseInt(process.env.GRAPHQL_MAX_REQUESTS || '100'),
      windowMs: parseInt(process.env.GRAPHQL_WINDOW_MS || '60000')
    }
  };
  
  return new GraphQLServer({ ...defaultConfig, ...config });
}
