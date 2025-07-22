/**
 * GraphQL Resolvers for Otedama
 * Implements query, mutation, and subscription resolvers
 * 
 * Design principles:
 * - Carmack: Efficient data fetching with DataLoader
 * - Martin: Clean resolver organization
 * - Pike: Simple resolver functions
 */

import { GraphQLError } from 'graphql';
import { PubSub, withFilter } from 'graphql-subscriptions';
import DataLoader from 'dataloader';
import { getLogger } from '../core/logger.js';

const logger = getLogger('Resolvers');

// PubSub instance for subscriptions
const pubsub = new PubSub();

// Subscription topics
export const TOPICS = {
  USER_UPDATED: 'USER_UPDATED',
  MINER_CREATED: 'MINER_CREATED',
  MINER_UPDATED: 'MINER_UPDATED',
  MINER_DELETED: 'MINER_DELETED',
  MINER_STATUS_CHANGED: 'MINER_STATUS_CHANGED',
  METRIC_RECEIVED: 'METRIC_RECEIVED',
  LOG_CREATED: 'LOG_CREATED',
  ALERT_TRIGGERED: 'ALERT_TRIGGERED'
};

/**
 * Query resolvers
 */
export const queryResolvers = {
  // Get current user
  me: async (parent, args, context) => {
    if (!context.user) {
      throw new GraphQLError('Not authenticated', {
        extensions: { code: 'UNAUTHENTICATED' }
      });
    }
    
    return context.dataloaders.user.load(context.user.id);
  },
  
  // Get user by ID
  user: async (parent, { id }, context) => {
    return context.dataloaders.user.load(id);
  },
  
  // Get users with pagination
  users: async (parent, { first = 10, after, filter }, context) => {
    const users = await context.services.user.findMany({
      limit: first + 1, // Fetch one extra to check for next page
      cursor: after,
      filter
    });
    
    const hasNextPage = users.length > first;
    const edges = users.slice(0, first).map(user => ({
      node: user,
      cursor: Buffer.from(user.id).toString('base64')
    }));
    
    return {
      pageInfo: {
        hasNextPage,
        hasPreviousPage: !!after,
        startCursor: edges[0]?.cursor,
        endCursor: edges[edges.length - 1]?.cursor,
        totalCount: await context.services.user.count(filter)
      },
      edges
    };
  },
  
  // Get miner by ID
  miner: async (parent, { id }, context) => {
    const miner = await context.dataloaders.miner.load(id);
    
    // Check ownership
    if (miner && !context.user.isAdmin && miner.ownerId !== context.user.id) {
      throw new GraphQLError('Not authorized', {
        extensions: { code: 'FORBIDDEN' }
      });
    }
    
    return miner;
  },
  
  // Get miners with pagination
  miners: async (parent, { first = 10, after, filter }, context) => {
    // Add owner filter for non-admins
    if (!context.user.isAdmin) {
      filter = { ...filter, ownerId: context.user.id };
    }
    
    const miners = await context.services.miner.findMany({
      limit: first + 1,
      cursor: after,
      filter
    });
    
    const hasNextPage = miners.length > first;
    const edges = miners.slice(0, first).map(miner => ({
      node: miner,
      cursor: Buffer.from(miner.id).toString('base64')
    }));
    
    return {
      pageInfo: {
        hasNextPage,
        hasPreviousPage: !!after,
        startCursor: edges[0]?.cursor,
        endCursor: edges[edges.length - 1]?.cursor,
        totalCount: await context.services.miner.count(filter)
      },
      edges
    };
  },
  
  // Get metrics
  metrics: async (parent, { filter, aggregation }, context) => {
    const metrics = await context.services.metrics.query({
      filter,
      aggregation
    });
    
    return metrics.map(metric => ({
      node: metric,
      cursor: Buffer.from(`${metric.name}:${metric.timestamp}`).toString('base64')
    }));
  },
  
  // Get system health
  health: async (parent, args, context) => {
    return context.services.health.check();
  },
  
  // Search across entities
  search: async (parent, { query, types = ['USER', 'MINER'], first = 10 }, context) => {
    const results = await context.services.search.query({
      query,
      types,
      limit: first,
      userId: context.user.isAdmin ? null : context.user.id
    });
    
    return results;
  }
};

/**
 * Mutation resolvers
 */
export const mutationResolvers = {
  // Create user
  createUser: async (parent, { input }, context) => {
    try {
      const user = await context.services.user.create(input);
      
      // Publish event
      pubsub.publish(TOPICS.USER_UPDATED, { 
        userUpdated: user,
        action: 'CREATED'
      });
      
      return { user, errors: [] };
    } catch (error) {
      logger.error('Failed to create user', error);
      
      return {
        user: null,
        errors: [{
          message: error.message,
          code: error.code || 'CREATE_FAILED'
        }]
      };
    }
  },
  
  // Update user
  updateUser: async (parent, { id, input }, context) => {
    // Check authorization
    if (!context.user.isAdmin && id !== context.user.id) {
      throw new GraphQLError('Not authorized', {
        extensions: { code: 'FORBIDDEN' }
      });
    }
    
    try {
      const user = await context.services.user.update(id, input);
      
      // Clear cache
      context.dataloaders.user.clear(id);
      
      // Publish event
      pubsub.publish(TOPICS.USER_UPDATED, {
        userUpdated: user,
        action: 'UPDATED'
      });
      
      return { user, errors: [] };
    } catch (error) {
      logger.error('Failed to update user', error);
      
      return {
        user: null,
        errors: [{
          message: error.message,
          code: error.code || 'UPDATE_FAILED'
        }]
      };
    }
  },
  
  // Delete user
  deleteUser: async (parent, { id }, context) => {
    // Admin only
    if (!context.user.isAdmin) {
      throw new GraphQLError('Not authorized', {
        extensions: { code: 'FORBIDDEN' }
      });
    }
    
    try {
      await context.services.user.delete(id);
      
      // Clear cache
      context.dataloaders.user.clear(id);
      
      // Publish event
      pubsub.publish(TOPICS.USER_UPDATED, {
        userUpdated: { id },
        action: 'DELETED'
      });
      
      return { success: true, errors: [] };
    } catch (error) {
      logger.error('Failed to delete user', error);
      
      return {
        success: false,
        errors: [{
          message: error.message,
          code: error.code || 'DELETE_FAILED'
        }]
      };
    }
  },
  
  // Create miner
  createMiner: async (parent, { input }, context) => {
    try {
      const miner = await context.services.miner.create({
        ...input,
        ownerId: context.user.id
      });
      
      // Publish event
      pubsub.publish(TOPICS.MINER_CREATED, {
        minerCreated: miner
      });
      
      return { miner, errors: [] };
    } catch (error) {
      logger.error('Failed to create miner', error);
      
      return {
        miner: null,
        errors: [{
          message: error.message,
          code: error.code || 'CREATE_FAILED'
        }]
      };
    }
  },
  
  // Update miner
  updateMiner: async (parent, { id, input }, context) => {
    const miner = await context.dataloaders.miner.load(id);
    
    // Check ownership
    if (!miner || (!context.user.isAdmin && miner.ownerId !== context.user.id)) {
      throw new GraphQLError('Not authorized', {
        extensions: { code: 'FORBIDDEN' }
      });
    }
    
    try {
      const updatedMiner = await context.services.miner.update(id, input);
      
      // Clear cache
      context.dataloaders.miner.clear(id);
      
      // Publish events
      pubsub.publish(TOPICS.MINER_UPDATED, {
        minerUpdated: updatedMiner
      });
      
      if (input.status && input.status !== miner.status) {
        pubsub.publish(TOPICS.MINER_STATUS_CHANGED, {
          minerStatusChanged: {
            miner: updatedMiner,
            previousStatus: miner.status,
            newStatus: input.status
          }
        });
      }
      
      return { miner: updatedMiner, errors: [] };
    } catch (error) {
      logger.error('Failed to update miner', error);
      
      return {
        miner: null,
        errors: [{
          message: error.message,
          code: error.code || 'UPDATE_FAILED'
        }]
      };
    }
  },
  
  // Delete miner
  deleteMiner: async (parent, { id }, context) => {
    const miner = await context.dataloaders.miner.load(id);
    
    // Check ownership
    if (!miner || (!context.user.isAdmin && miner.ownerId !== context.user.id)) {
      throw new GraphQLError('Not authorized', {
        extensions: { code: 'FORBIDDEN' }
      });
    }
    
    try {
      await context.services.miner.delete(id);
      
      // Clear cache
      context.dataloaders.miner.clear(id);
      
      // Publish event
      pubsub.publish(TOPICS.MINER_DELETED, {
        minerDeleted: { id }
      });
      
      return { success: true, errors: [] };
    } catch (error) {
      logger.error('Failed to delete miner', error);
      
      return {
        success: false,
        errors: [{
          message: error.message,
          code: error.code || 'DELETE_FAILED'
        }]
      };
    }
  },
  
  // Start mining
  startMining: async (parent, { minerId }, context) => {
    const miner = await context.dataloaders.miner.load(minerId);
    
    // Check ownership
    if (!miner || (!context.user.isAdmin && miner.ownerId !== context.user.id)) {
      throw new GraphQLError('Not authorized', {
        extensions: { code: 'FORBIDDEN' }
      });
    }
    
    try {
      await context.services.miner.start(minerId);
      
      // Clear cache and reload
      context.dataloaders.miner.clear(minerId);
      const updatedMiner = await context.dataloaders.miner.load(minerId);
      
      // Publish event
      pubsub.publish(TOPICS.MINER_STATUS_CHANGED, {
        minerStatusChanged: {
          miner: updatedMiner,
          previousStatus: miner.status,
          newStatus: 'mining'
        }
      });
      
      return { miner: updatedMiner, errors: [] };
    } catch (error) {
      logger.error('Failed to start mining', error);
      
      return {
        miner: null,
        errors: [{
          message: error.message,
          code: error.code || 'START_FAILED'
        }]
      };
    }
  },
  
  // Stop mining
  stopMining: async (parent, { minerId }, context) => {
    const miner = await context.dataloaders.miner.load(minerId);
    
    // Check ownership
    if (!miner || (!context.user.isAdmin && miner.ownerId !== context.user.id)) {
      throw new GraphQLError('Not authorized', {
        extensions: { code: 'FORBIDDEN' }
      });
    }
    
    try {
      await context.services.miner.stop(minerId);
      
      // Clear cache and reload
      context.dataloaders.miner.clear(minerId);
      const updatedMiner = await context.dataloaders.miner.load(minerId);
      
      // Publish event
      pubsub.publish(TOPICS.MINER_STATUS_CHANGED, {
        minerStatusChanged: {
          miner: updatedMiner,
          previousStatus: miner.status,
          newStatus: 'idle'
        }
      });
      
      return { miner: updatedMiner, errors: [] };
    } catch (error) {
      logger.error('Failed to stop mining', error);
      
      return {
        miner: null,
        errors: [{
          message: error.message,
          code: error.code || 'STOP_FAILED'
        }]
      };
    }
  }
};

/**
 * Subscription resolvers
 */
export const subscriptionResolvers = {
  // User updates
  userUpdated: {
    subscribe: withFilter(
      () => pubsub.asyncIterator([TOPICS.USER_UPDATED]),
      (payload, variables, context) => {
        // Only allow users to subscribe to their own updates
        if (!context.user.isAdmin && payload.userUpdated.id !== context.user.id) {
          return false;
        }
        
        // Filter by action if specified
        if (variables.actions && !variables.actions.includes(payload.action)) {
          return false;
        }
        
        return true;
      }
    )
  },
  
  // Miner created
  minerCreated: {
    subscribe: withFilter(
      () => pubsub.asyncIterator([TOPICS.MINER_CREATED]),
      (payload, variables, context) => {
        // Only show miners owned by the user
        if (!context.user.isAdmin && payload.minerCreated.ownerId !== context.user.id) {
          return false;
        }
        
        return true;
      }
    )
  },
  
  // Miner updated
  minerUpdated: {
    subscribe: withFilter(
      () => pubsub.asyncIterator([TOPICS.MINER_UPDATED]),
      (payload, variables, context) => {
        const miner = payload.minerUpdated;
        
        // Only show miners owned by the user
        if (!context.user.isAdmin && miner.ownerId !== context.user.id) {
          return false;
        }
        
        // Filter by miner ID if specified
        if (variables.minerId && miner.id !== variables.minerId) {
          return false;
        }
        
        return true;
      }
    )
  },
  
  // Miner deleted
  minerDeleted: {
    subscribe: withFilter(
      () => pubsub.asyncIterator([TOPICS.MINER_DELETED]),
      (payload, variables, context) => {
        // Admin only for now
        return context.user.isAdmin;
      }
    )
  },
  
  // Miner status changed
  minerStatusChanged: {
    subscribe: withFilter(
      () => pubsub.asyncIterator([TOPICS.MINER_STATUS_CHANGED]),
      (payload, variables, context) => {
        const { miner } = payload.minerStatusChanged;
        
        // Only show miners owned by the user
        if (!context.user.isAdmin && miner.ownerId !== context.user.id) {
          return false;
        }
        
        // Filter by miner ID if specified
        if (variables.minerId && miner.id !== variables.minerId) {
          return false;
        }
        
        return true;
      }
    )
  },
  
  // Metric received
  metricReceived: {
    subscribe: withFilter(
      () => pubsub.asyncIterator([TOPICS.METRIC_RECEIVED]),
      (payload, variables, context) => {
        const metric = payload.metricReceived;
        
        // Filter by metric name
        if (variables.names && !variables.names.includes(metric.name)) {
          return false;
        }
        
        // Filter by tags
        if (variables.tags) {
          for (const [key, value] of Object.entries(variables.tags)) {
            if (metric.tags[key] !== value) {
              return false;
            }
          }
        }
        
        return true;
      }
    )
  },
  
  // Log created
  logCreated: {
    subscribe: withFilter(
      () => pubsub.asyncIterator([TOPICS.LOG_CREATED]),
      (payload, variables, context) => {
        const log = payload.logCreated;
        
        // Filter by level
        if (variables.minLevel) {
          const levels = ['debug', 'info', 'warn', 'error', 'fatal'];
          const minIndex = levels.indexOf(variables.minLevel);
          const logIndex = levels.indexOf(log.level);
          
          if (logIndex < minIndex) {
            return false;
          }
        }
        
        // Filter by source
        if (variables.sources && !variables.sources.includes(log.source)) {
          return false;
        }
        
        return true;
      }
    )
  },
  
  // Alert triggered
  alertTriggered: {
    subscribe: withFilter(
      () => pubsub.asyncIterator([TOPICS.ALERT_TRIGGERED]),
      (payload, variables, context) => {
        const alert = payload.alertTriggered;
        
        // Filter by severity
        if (variables.minSeverity) {
          const severities = ['low', 'medium', 'high', 'critical'];
          const minIndex = severities.indexOf(variables.minSeverity);
          const alertIndex = severities.indexOf(alert.severity);
          
          if (alertIndex < minIndex) {
            return false;
          }
        }
        
        // Filter by type
        if (variables.types && !variables.types.includes(alert.type)) {
          return false;
        }
        
        return true;
      }
    )
  }
};

/**
 * Create DataLoaders for efficient data fetching
 */
export function createDataLoaders(services) {
  return {
    user: new DataLoader(async (ids) => {
      const users = await services.user.findByIds(ids);
      const userMap = new Map(users.map(user => [user.id, user]));
      return ids.map(id => userMap.get(id) || null);
    }),
    
    profile: new DataLoader(async (userIds) => {
      const profiles = await services.profile.findByUserIds(userIds);
      const profileMap = new Map(profiles.map(p => [p.userId, p]));
      return userIds.map(id => profileMap.get(id) || null);
    }),
    
    userStats: new DataLoader(async (userIds) => {
      const stats = await services.stats.getUserStats(userIds);
      const statsMap = new Map(stats.map(s => [s.userId, s]));
      return userIds.map(id => statsMap.get(id) || {
        totalMiners: 0,
        activeMiners: 0,
        totalHashrate: 0,
        totalEarnings: 0,
        last24hEarnings: 0
      });
    }),
    
    userMiners: new DataLoader(async (queries) => {
      return Promise.all(queries.map(query => 
        services.miner.findByUser(query.userId, query)
      ));
    }, {
      cacheKeyFn: (query) => JSON.stringify(query)
    }),
    
    miner: new DataLoader(async (ids) => {
      const miners = await services.miner.findByIds(ids);
      const minerMap = new Map(miners.map(miner => [miner.id, miner]));
      return ids.map(id => minerMap.get(id) || null);
    }),
    
    minerStats: new DataLoader(async (minerIds) => {
      const stats = await services.stats.getMinerStats(minerIds);
      const statsMap = new Map(stats.map(s => [s.minerId, s]));
      return minerIds.map(id => statsMap.get(id) || {
        hashrate: 0,
        shares: 0,
        validShares: 0,
        invalidShares: 0,
        uptime: 0,
        temperature: null,
        powerUsage: null
      });
    }),
    
    minerLogs: new DataLoader(async (queries) => {
      return Promise.all(queries.map(query =>
        services.logs.findByMiner(query.minerId, query)
      ));
    }, {
      cacheKeyFn: (query) => JSON.stringify(query)
    })
  };
}

/**
 * Combined resolvers
 */
export const resolvers = {
  Query: queryResolvers,
  Mutation: mutationResolvers,
  Subscription: subscriptionResolvers,
  
  // Field resolvers
  DateTime: {
    // Custom scalar implementation handled by graphql-scalars
  },
  
  JSON: {
    // Custom scalar implementation handled by graphql-scalars
  }
};

export default {
  resolvers,
  queryResolvers,
  mutationResolvers,
  subscriptionResolvers,
  createDataLoaders,
  pubsub,
  TOPICS
};