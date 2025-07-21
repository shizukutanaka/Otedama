/**
 * GraphQL Server for Otedama
 * Apollo Server with subscriptions support
 * 
 * Design principles:
 * - Carmack: High-performance GraphQL execution
 * - Martin: Clean server architecture
 * - Pike: Simple server setup
 */

import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/lib/use/ws';
import { GraphQLError } from 'graphql';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { createServer } from 'http';
import { 
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLNonNull,
  GraphQLList,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean
} from 'graphql';
import { logger } from '../core/logger.js';
import { resolvers, createDataLoaders } from './resolvers.js';
import * as types from './schema.js';

/**
 * Build GraphQL schema
 */
function buildSchema() {
  // Query type
  const QueryType = new GraphQLObjectType({
    name: 'Query',
    fields: () => ({
      me: {
        type: types.UserType,
        description: 'Get current authenticated user',
        resolve: resolvers.Query.me
      },
      
      user: {
        type: types.UserType,
        description: 'Get user by ID',
        args: {
          id: { type: new GraphQLNonNull(GraphQLString) }
        },
        resolve: resolvers.Query.user
      },
      
      users: {
        type: types.UserConnection,
        description: 'Get paginated list of users',
        args: {
          first: { type: GraphQLInt },
          after: { type: GraphQLString },
          filter: { type: types.UserFilterInput }
        },
        resolve: resolvers.Query.users
      },
      
      miner: {
        type: types.MinerType,
        description: 'Get miner by ID',
        args: {
          id: { type: new GraphQLNonNull(GraphQLString) }
        },
        resolve: resolvers.Query.miner
      },
      
      miners: {
        type: types.MinerConnection,
        description: 'Get paginated list of miners',
        args: {
          first: { type: GraphQLInt },
          after: { type: GraphQLString },
          filter: { type: types.MinerFilterInput }
        },
        resolve: resolvers.Query.miners
      },
      
      metrics: {
        type: types.MetricConnection,
        description: 'Query metrics',
        args: {
          filter: { type: types.MetricFilterInput },
          aggregation: { type: GraphQLString }
        },
        resolve: resolvers.Query.metrics
      },
      
      health: {
        type: types.HealthType,
        description: 'Get system health status',
        resolve: resolvers.Query.health
      },
      
      search: {
        type: types.SearchResultType,
        description: 'Search across entities',
        args: {
          query: { type: new GraphQLNonNull(GraphQLString) },
          types: { type: new GraphQLList(types.SearchableTypeEnum) },
          first: { type: GraphQLInt }
        },
        resolve: resolvers.Query.search
      }
    })
  });
  
  // Mutation type
  const MutationType = new GraphQLObjectType({
    name: 'Mutation',
    fields: () => ({
      createUser: {
        type: types.UserPayload,
        description: 'Create a new user',
        args: {
          input: { type: new GraphQLNonNull(types.CreateUserInput) }
        },
        resolve: resolvers.Mutation.createUser
      },
      
      updateUser: {
        type: types.UserPayload,
        description: 'Update a user',
        args: {
          id: { type: new GraphQLNonNull(GraphQLString) },
          input: { type: new GraphQLNonNull(types.UpdateUserInput) }
        },
        resolve: resolvers.Mutation.updateUser
      },
      
      deleteUser: {
        type: types.DeletePayload,
        description: 'Delete a user',
        args: {
          id: { type: new GraphQLNonNull(GraphQLString) }
        },
        resolve: resolvers.Mutation.deleteUser
      },
      
      createMiner: {
        type: types.MinerPayload,
        description: 'Create a new miner',
        args: {
          input: { type: new GraphQLNonNull(types.CreateMinerInput) }
        },
        resolve: resolvers.Mutation.createMiner
      },
      
      updateMiner: {
        type: types.MinerPayload,
        description: 'Update a miner',
        args: {
          id: { type: new GraphQLNonNull(GraphQLString) },
          input: { type: new GraphQLNonNull(types.UpdateMinerInput) }
        },
        resolve: resolvers.Mutation.updateMiner
      },
      
      deleteMiner: {
        type: types.DeletePayload,
        description: 'Delete a miner',
        args: {
          id: { type: new GraphQLNonNull(GraphQLString) }
        },
        resolve: resolvers.Mutation.deleteMiner
      },
      
      startMining: {
        type: types.MinerPayload,
        description: 'Start mining on a miner',
        args: {
          minerId: { type: new GraphQLNonNull(GraphQLString) }
        },
        resolve: resolvers.Mutation.startMining
      },
      
      stopMining: {
        type: types.MinerPayload,
        description: 'Stop mining on a miner',
        args: {
          minerId: { type: new GraphQLNonNull(GraphQLString) }
        },
        resolve: resolvers.Mutation.stopMining
      }
    })
  });
  
  // Subscription type
  const SubscriptionType = new GraphQLObjectType({
    name: 'Subscription',
    fields: () => ({
      userUpdated: {
        type: types.UserType,
        description: 'Subscribe to user updates',
        args: {
          actions: { type: new GraphQLList(types.ActionEnum) }
        },
        subscribe: resolvers.Subscription.userUpdated.subscribe,
        resolve: (payload) => payload.userUpdated
      },
      
      minerCreated: {
        type: types.MinerType,
        description: 'Subscribe to new miners',
        subscribe: resolvers.Subscription.minerCreated.subscribe,
        resolve: (payload) => payload.minerCreated
      },
      
      minerUpdated: {
        type: types.MinerType,
        description: 'Subscribe to miner updates',
        args: {
          minerId: { type: GraphQLString }
        },
        subscribe: resolvers.Subscription.minerUpdated.subscribe,
        resolve: (payload) => payload.minerUpdated
      },
      
      minerDeleted: {
        type: types.DeletedObjectType,
        description: 'Subscribe to miner deletions',
        subscribe: resolvers.Subscription.minerDeleted.subscribe,
        resolve: (payload) => payload.minerDeleted
      },
      
      minerStatusChanged: {
        type: types.MinerStatusChangeType,
        description: 'Subscribe to miner status changes',
        args: {
          minerId: { type: GraphQLString }
        },
        subscribe: resolvers.Subscription.minerStatusChanged.subscribe,
        resolve: (payload) => payload.minerStatusChanged
      },
      
      metricReceived: {
        type: types.MetricType,
        description: 'Subscribe to metrics',
        args: {
          names: { type: new GraphQLList(GraphQLString) },
          tags: { type: types.TagFilterInput }
        },
        subscribe: resolvers.Subscription.metricReceived.subscribe,
        resolve: (payload) => payload.metricReceived
      },
      
      logCreated: {
        type: types.LogEntryType,
        description: 'Subscribe to log entries',
        args: {
          minLevel: { type: types.LogLevelEnum },
          sources: { type: new GraphQLList(GraphQLString) }
        },
        subscribe: resolvers.Subscription.logCreated.subscribe,
        resolve: (payload) => payload.logCreated
      },
      
      alertTriggered: {
        type: types.AlertType,
        description: 'Subscribe to alerts',
        args: {
          minSeverity: { type: types.SeverityEnum },
          types: { type: new GraphQLList(types.AlertTypeEnum) }
        },
        subscribe: resolvers.Subscription.alertTriggered.subscribe,
        resolve: (payload) => payload.alertTriggered
      }
    })
  });
  
  return new GraphQLSchema({
    query: QueryType,
    mutation: MutationType,
    subscription: SubscriptionType
  });
}

/**
 * Create GraphQL server
 */
export class GraphQLServer {
  constructor(options = {}) {
    this.options = {
      port: options.port || 4000,
      host: options.host || '0.0.0.0',
      path: options.path || '/graphql',
      subscriptionPath: options.subscriptionPath || '/graphql',
      playground: options.playground !== false,
      introspection: options.introspection !== false,
      cors: options.cors || {
        origin: '*',
        credentials: true
      },
      ...options
    };
    
    this.app = null;
    this.httpServer = null;
    this.apolloServer = null;
    this.wsServer = null;
    this.services = options.services || {};
    this.authMiddleware = options.authMiddleware;
  }
  
  /**
   * Start GraphQL server
   */
  async start() {
    // Create Express app
    this.app = express();
    
    // Apply middleware
    this.app.use(cors(this.options.cors));
    this.app.use(bodyParser.json());
    
    // Create HTTP server
    this.httpServer = createServer(this.app);
    
    // Create WebSocket server
    this.wsServer = new WebSocketServer({
      server: this.httpServer,
      path: this.options.subscriptionPath
    });
    
    // Build schema
    const schema = buildSchema();
    
    // Create GraphQL context
    const createContext = async ({ req, connection }) => {
      let user = null;
      
      // Get user from auth middleware
      if (this.authMiddleware) {
        if (req) {
          // HTTP request context
          user = await this.authMiddleware(req);
        } else if (connection?.context?.user) {
          // WebSocket connection context
          user = connection.context.user;
        }
      }
      
      // Create DataLoaders for this request
      const dataloaders = createDataLoaders(this.services);
      
      return {
        user,
        services: this.services,
        dataloaders,
        req
      };
    };
    
    // Setup WebSocket server
    const serverCleanup = useServer(
      {
        schema,
        context: async (ctx, msg, args) => {
          // Authenticate WebSocket connection
          let user = null;
          
          if (this.authMiddleware && ctx.connectionParams?.token) {
            try {
              user = await this.authMiddleware({
                headers: { authorization: `Bearer ${ctx.connectionParams.token}` }
              });
            } catch (error) {
              throw new GraphQLError('Authentication failed', {
                extensions: { code: 'UNAUTHENTICATED' }
              });
            }
          }
          
          return createContext({ connection: { context: { user } } });
        },
        onConnect: async (ctx) => {
          logger.info('GraphQL WebSocket client connected');
        },
        onDisconnect: async (ctx) => {
          logger.info('GraphQL WebSocket client disconnected');
        }
      },
      this.wsServer
    );
    
    // Create Apollo Server
    this.apolloServer = new ApolloServer({
      schema,
      plugins: [
        // Drain HTTP server on shutdown
        ApolloServerPluginDrainHttpServer({ httpServer: this.httpServer }),
        
        // Drain WebSocket server on shutdown
        {
          async serverWillStart() {
            return {
              async drainServer() {
                await serverCleanup.dispose();
              }
            };
          }
        },
        
        // Request logging
        {
          async requestDidStart() {
            return {
              async willSendResponse(requestContext) {
                const { request, response } = requestContext;
                
                // Log GraphQL operations
                if (request.operationName) {
                  logger.info('GraphQL operation', {
                    operation: request.operationName,
                    query: request.query,
                    variables: request.variables,
                    status: response.http.status
                  });
                }
              },
              
              async didEncounterErrors(requestContext) {
                const { errors } = requestContext;
                
                // Log GraphQL errors
                for (const error of errors) {
                  logger.error('GraphQL error', {
                    message: error.message,
                    path: error.path,
                    extensions: error.extensions
                  });
                }
              }
            };
          }
        }
      ],
      
      // Error formatting
      formatError: (formattedError, error) => {
        // Log internal errors
        if (!formattedError.extensions?.code) {
          logger.error('Unexpected GraphQL error', error);
        }
        
        // Don't expose internal errors to clients
        if (formattedError.extensions?.code === 'INTERNAL_SERVER_ERROR') {
          return {
            message: 'Internal server error',
            extensions: {
              code: 'INTERNAL_SERVER_ERROR'
            }
          };
        }
        
        return formattedError;
      },
      
      // Enable introspection and playground in dev
      introspection: this.options.introspection,
      includeStacktraceInErrorResponses: process.env.NODE_ENV !== 'production'
    });
    
    // Start Apollo Server
    await this.apolloServer.start();
    
    // Apply GraphQL middleware
    this.app.use(
      this.options.path,
      expressMiddleware(this.apolloServer, {
        context: createContext
      })
    );
    
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({ status: 'healthy', service: 'graphql' });
    });
    
    // Start HTTP server
    await new Promise((resolve) => {
      this.httpServer.listen(this.options.port, this.options.host, () => {
        logger.info(`GraphQL server running at http://${this.options.host}:${this.options.port}${this.options.path}`);
        logger.info(`GraphQL subscriptions at ws://${this.options.host}:${this.options.port}${this.options.subscriptionPath}`);
        resolve();
      });
    });
  }
  
  /**
   * Stop GraphQL server
   */
  async stop() {
    logger.info('Stopping GraphQL server...');
    
    // Stop Apollo Server
    if (this.apolloServer) {
      await this.apolloServer.stop();
    }
    
    // Close WebSocket server
    if (this.wsServer) {
      await new Promise((resolve) => {
        this.wsServer.close(resolve);
      });
    }
    
    // Close HTTP server
    if (this.httpServer) {
      await new Promise((resolve) => {
        this.httpServer.close(resolve);
      });
    }
    
    logger.info('GraphQL server stopped');
  }
}

/**
 * Additional type definitions
 */

// Filter inputs
export const UserFilterInput = new types.GraphQLInputObjectType({
  name: 'UserFilterInput',
  fields: () => ({
    status: { type: types.StatusEnum },
    search: { type: GraphQLString }
  })
});

export const MinerFilterInput = new types.GraphQLInputObjectType({
  name: 'MinerFilterInput',
  fields: () => ({
    status: { type: types.MiningStatusEnum },
    ownerId: { type: GraphQLString },
    search: { type: GraphQLString }
  })
});

export const TagFilterInput = new types.GraphQLInputObjectType({
  name: 'TagFilterInput',
  fields: () => ({
    // Dynamic tag filtering
  })
});

// Additional types
export const HealthType = new GraphQLObjectType({
  name: 'Health',
  fields: () => ({
    status: { type: new GraphQLNonNull(GraphQLString) },
    uptime: { type: new GraphQLNonNull(GraphQLInt) },
    version: { type: new GraphQLNonNull(GraphQLString) },
    services: { type: types.GraphQLJSON }
  })
});

export const SearchableTypeEnum = new types.GraphQLEnumType({
  name: 'SearchableType',
  values: {
    USER: { value: 'USER' },
    MINER: { value: 'MINER' }
  }
});

export const SearchResultType = new GraphQLObjectType({
  name: 'SearchResult',
  fields: () => ({
    users: { type: new GraphQLList(types.UserType) },
    miners: { type: new GraphQLList(types.MinerType) },
    totalCount: { type: new GraphQLNonNull(GraphQLInt) }
  })
});

export const ActionEnum = new types.GraphQLEnumType({
  name: 'Action',
  values: {
    CREATED: { value: 'CREATED' },
    UPDATED: { value: 'UPDATED' },
    DELETED: { value: 'DELETED' }
  }
});

export const DeletePayload = new GraphQLObjectType({
  name: 'DeletePayload',
  fields: () => ({
    success: { type: new GraphQLNonNull(GraphQLBoolean) },
    errors: { type: new GraphQLList(types.ErrorType) }
  })
});

export const DeletedObjectType = new GraphQLObjectType({
  name: 'DeletedObject',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) }
  })
});

export const MinerStatusChangeType = new GraphQLObjectType({
  name: 'MinerStatusChange',
  fields: () => ({
    miner: { type: new GraphQLNonNull(types.MinerType) },
    previousStatus: { type: new GraphQLNonNull(types.MiningStatusEnum) },
    newStatus: { type: new GraphQLNonNull(types.MiningStatusEnum) }
  })
});

export const SeverityEnum = new types.GraphQLEnumType({
  name: 'Severity',
  values: {
    LOW: { value: 'low' },
    MEDIUM: { value: 'medium' },
    HIGH: { value: 'high' },
    CRITICAL: { value: 'critical' }
  }
});

export const AlertTypeEnum = new types.GraphQLEnumType({
  name: 'AlertType',
  values: {
    SYSTEM: { value: 'system' },
    PERFORMANCE: { value: 'performance' },
    SECURITY: { value: 'security' },
    ERROR: { value: 'error' }
  }
});

export const AlertType = new GraphQLObjectType({
  name: 'Alert',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) },
    type: { type: new GraphQLNonNull(AlertTypeEnum) },
    severity: { type: new GraphQLNonNull(SeverityEnum) },
    message: { type: new GraphQLNonNull(GraphQLString) },
    metadata: { type: types.GraphQLJSON },
    timestamp: { type: new GraphQLNonNull(types.GraphQLDateTime) }
  })
});

// Extend types module
types.UserFilterInput = UserFilterInput;
types.MinerFilterInput = MinerFilterInput;
types.TagFilterInput = TagFilterInput;
types.HealthType = HealthType;
types.SearchableTypeEnum = SearchableTypeEnum;
types.SearchResultType = SearchResultType;
types.ActionEnum = ActionEnum;
types.DeletePayload = DeletePayload;
types.DeletedObjectType = DeletedObjectType;
types.MinerStatusChangeType = MinerStatusChangeType;
types.SeverityEnum = SeverityEnum;
types.AlertTypeEnum = AlertTypeEnum;
types.AlertType = AlertType;

export default GraphQLServer;