/**
 * GraphQL Schema Definition for Otedama
 * Provides type-safe API with real-time subscriptions
 * 
 * Design principles:
 * - Carmack: Efficient query execution
 * - Martin: Clean schema design
 * - Pike: Simple and intuitive API
 */

import { 
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLUnionType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLID
} from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';

/**
 * Node interface for Relay-style pagination
 */
export const NodeInterface = new GraphQLInterfaceType({
  name: 'Node',
  description: 'An object with an ID',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLID),
      description: 'The id of the object'
    }
  })
});

/**
 * Timestamp fields interface
 */
export const TimestampInterface = new GraphQLInterfaceType({
  name: 'Timestamped',
  description: 'An object with timestamp fields',
  fields: () => ({
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'Creation timestamp'
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'Last update timestamp'
    }
  })
});

/**
 * Status enum
 */
export const StatusEnum = new GraphQLEnumType({
  name: 'Status',
  values: {
    ACTIVE: { value: 'active' },
    INACTIVE: { value: 'inactive' },
    PENDING: { value: 'pending' },
    SUSPENDED: { value: 'suspended' },
    DELETED: { value: 'deleted' }
  }
});

/**
 * Mining status enum
 */
export const MiningStatusEnum = new GraphQLEnumType({
  name: 'MiningStatus',
  values: {
    IDLE: { value: 'idle' },
    MINING: { value: 'mining' },
    PAUSED: { value: 'paused' },
    ERROR: { value: 'error' }
  }
});

/**
 * User type
 */
export const UserType = new GraphQLObjectType({
  name: 'User',
  description: 'A user in the system',
  interfaces: [NodeInterface, TimestampInterface],
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLID),
      description: 'Unique user identifier'
    },
    username: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'User username'
    },
    email: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'User email address'
    },
    status: {
      type: new GraphQLNonNull(StatusEnum),
      description: 'User account status'
    },
    profile: {
      type: ProfileType,
      description: 'User profile information',
      resolve: (user, args, context) => {
        return context.dataloaders.profile.load(user.id);
      }
    },
    miners: {
      type: new GraphQLList(MinerType),
      description: 'Miners owned by this user',
      args: {
        status: { type: MiningStatusEnum },
        limit: { type: GraphQLInt, defaultValue: 10 },
        offset: { type: GraphQLInt, defaultValue: 0 }
      },
      resolve: (user, args, context) => {
        return context.dataloaders.userMiners.load({
          userId: user.id,
          ...args
        });
      }
    },
    stats: {
      type: UserStatsType,
      description: 'User statistics',
      resolve: (user, args, context) => {
        return context.dataloaders.userStats.load(user.id);
      }
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime)
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime)
    }
  })
});

/**
 * Profile type
 */
export const ProfileType = new GraphQLObjectType({
  name: 'Profile',
  description: 'User profile information',
  fields: () => ({
    displayName: {
      type: GraphQLString,
      description: 'Display name'
    },
    bio: {
      type: GraphQLString,
      description: 'User biography'
    },
    avatar: {
      type: GraphQLString,
      description: 'Avatar URL'
    },
    metadata: {
      type: GraphQLJSON,
      description: 'Additional metadata'
    }
  })
});

/**
 * User statistics type
 */
export const UserStatsType = new GraphQLObjectType({
  name: 'UserStats',
  description: 'User statistics',
  fields: () => ({
    totalMiners: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Total number of miners'
    },
    activeMiners: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Number of active miners'
    },
    totalHashrate: {
      type: new GraphQLNonNull(GraphQLFloat),
      description: 'Combined hashrate of all miners'
    },
    totalEarnings: {
      type: new GraphQLNonNull(GraphQLFloat),
      description: 'Total earnings'
    },
    last24hEarnings: {
      type: new GraphQLNonNull(GraphQLFloat),
      description: 'Earnings in last 24 hours'
    }
  })
});

/**
 * Miner type
 */
export const MinerType = new GraphQLObjectType({
  name: 'Miner',
  description: 'A mining instance',
  interfaces: [NodeInterface, TimestampInterface],
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLID),
      description: 'Unique miner identifier'
    },
    name: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Miner name'
    },
    status: {
      type: new GraphQLNonNull(MiningStatusEnum),
      description: 'Current mining status'
    },
    owner: {
      type: new GraphQLNonNull(UserType),
      description: 'Miner owner',
      resolve: (miner, args, context) => {
        return context.dataloaders.user.load(miner.ownerId);
      }
    },
    config: {
      type: MinerConfigType,
      description: 'Miner configuration'
    },
    stats: {
      type: MinerStatsType,
      description: 'Miner statistics',
      resolve: (miner, args, context) => {
        return context.dataloaders.minerStats.load(miner.id);
      }
    },
    logs: {
      type: new GraphQLList(LogEntryType),
      description: 'Recent log entries',
      args: {
        level: { type: LogLevelEnum },
        limit: { type: GraphQLInt, defaultValue: 100 },
        since: { type: GraphQLDateTime }
      },
      resolve: (miner, args, context) => {
        return context.dataloaders.minerLogs.load({
          minerId: miner.id,
          ...args
        });
      }
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime)
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime)
    }
  })
});

/**
 * Miner configuration type
 */
export const MinerConfigType = new GraphQLObjectType({
  name: 'MinerConfig',
  description: 'Miner configuration',
  fields: () => ({
    algorithm: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Mining algorithm'
    },
    pool: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Mining pool URL'
    },
    wallet: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Wallet address'
    },
    threads: {
      type: GraphQLInt,
      description: 'Number of mining threads'
    },
    intensity: {
      type: GraphQLFloat,
      description: 'Mining intensity (0-1)'
    },
    autoStart: {
      type: GraphQLBoolean,
      description: 'Auto-start mining'
    }
  })
});

/**
 * Miner statistics type
 */
export const MinerStatsType = new GraphQLObjectType({
  name: 'MinerStats',
  description: 'Miner statistics',
  fields: () => ({
    hashrate: {
      type: new GraphQLNonNull(GraphQLFloat),
      description: 'Current hashrate'
    },
    shares: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Total shares submitted'
    },
    validShares: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Valid shares'
    },
    invalidShares: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Invalid shares'
    },
    uptime: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Uptime in seconds'
    },
    temperature: {
      type: GraphQLFloat,
      description: 'GPU/CPU temperature'
    },
    powerUsage: {
      type: GraphQLFloat,
      description: 'Power usage in watts'
    }
  })
});

/**
 * Log level enum
 */
export const LogLevelEnum = new GraphQLEnumType({
  name: 'LogLevel',
  values: {
    DEBUG: { value: 'debug' },
    INFO: { value: 'info' },
    WARN: { value: 'warn' },
    ERROR: { value: 'error' },
    FATAL: { value: 'fatal' }
  }
});

/**
 * Log entry type
 */
export const LogEntryType = new GraphQLObjectType({
  name: 'LogEntry',
  description: 'A log entry',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLID)
    },
    level: {
      type: new GraphQLNonNull(LogLevelEnum)
    },
    message: {
      type: new GraphQLNonNull(GraphQLString)
    },
    metadata: {
      type: GraphQLJSON
    },
    timestamp: {
      type: new GraphQLNonNull(GraphQLDateTime)
    }
  })
});

/**
 * Metric type
 */
export const MetricType = new GraphQLObjectType({
  name: 'Metric',
  description: 'A metric data point',
  fields: () => ({
    name: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Metric name'
    },
    value: {
      type: new GraphQLNonNull(GraphQLFloat),
      description: 'Metric value'
    },
    unit: {
      type: GraphQLString,
      description: 'Metric unit'
    },
    tags: {
      type: GraphQLJSON,
      description: 'Metric tags'
    },
    timestamp: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'Metric timestamp'
    }
  })
});

/**
 * Page info for pagination
 */
export const PageInfoType = new GraphQLObjectType({
  name: 'PageInfo',
  description: 'Information about pagination',
  fields: () => ({
    hasNextPage: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether there are more pages'
    },
    hasPreviousPage: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether there are previous pages'
    },
    startCursor: {
      type: GraphQLString,
      description: 'Start cursor'
    },
    endCursor: {
      type: GraphQLString,
      description: 'End cursor'
    },
    totalCount: {
      type: GraphQLInt,
      description: 'Total number of items'
    }
  })
});

/**
 * Connection type factory
 */
export function createConnectionType(nodeType) {
  const EdgeType = new GraphQLObjectType({
    name: `${nodeType.name}Edge`,
    description: `An edge in a ${nodeType.name} connection`,
    fields: () => ({
      node: {
        type: nodeType,
        description: 'The item at the end of the edge'
      },
      cursor: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'A cursor for use in pagination'
      }
    })
  });
  
  return new GraphQLObjectType({
    name: `${nodeType.name}Connection`,
    description: `A connection to a list of ${nodeType.name} items`,
    fields: () => ({
      pageInfo: {
        type: new GraphQLNonNull(PageInfoType),
        description: 'Information to aid in pagination'
      },
      edges: {
        type: new GraphQLList(EdgeType),
        description: 'A list of edges'
      },
      nodes: {
        type: new GraphQLList(nodeType),
        description: 'A list of nodes',
        resolve: (connection) => {
          return connection.edges.map(edge => edge.node);
        }
      }
    })
  });
}

/**
 * Create connections for types
 */
export const UserConnection = createConnectionType(UserType);
export const MinerConnection = createConnectionType(MinerType);
export const LogEntryConnection = createConnectionType(LogEntryType);
export const MetricConnection = createConnectionType(MetricType);

/**
 * Input types
 */
export const CreateUserInput = new GraphQLInputObjectType({
  name: 'CreateUserInput',
  fields: () => ({
    username: {
      type: new GraphQLNonNull(GraphQLString)
    },
    email: {
      type: new GraphQLNonNull(GraphQLString)
    },
    password: {
      type: new GraphQLNonNull(GraphQLString)
    },
    profile: {
      type: ProfileInput
    }
  })
});

export const UpdateUserInput = new GraphQLInputObjectType({
  name: 'UpdateUserInput',
  fields: () => ({
    username: {
      type: GraphQLString
    },
    email: {
      type: GraphQLString
    },
    status: {
      type: StatusEnum
    },
    profile: {
      type: ProfileInput
    }
  })
});

export const ProfileInput = new GraphQLInputObjectType({
  name: 'ProfileInput',
  fields: () => ({
    displayName: {
      type: GraphQLString
    },
    bio: {
      type: GraphQLString
    },
    avatar: {
      type: GraphQLString
    },
    metadata: {
      type: GraphQLJSON
    }
  })
});

export const CreateMinerInput = new GraphQLInputObjectType({
  name: 'CreateMinerInput',
  fields: () => ({
    name: {
      type: new GraphQLNonNull(GraphQLString)
    },
    config: {
      type: new GraphQLNonNull(MinerConfigInput)
    }
  })
});

export const UpdateMinerInput = new GraphQLInputObjectType({
  name: 'UpdateMinerInput',
  fields: () => ({
    name: {
      type: GraphQLString
    },
    status: {
      type: MiningStatusEnum
    },
    config: {
      type: MinerConfigInput
    }
  })
});

export const MinerConfigInput = new GraphQLInputObjectType({
  name: 'MinerConfigInput',
  fields: () => ({
    algorithm: {
      type: GraphQLString
    },
    pool: {
      type: GraphQLString
    },
    wallet: {
      type: GraphQLString
    },
    threads: {
      type: GraphQLInt
    },
    intensity: {
      type: GraphQLFloat
    },
    autoStart: {
      type: GraphQLBoolean
    }
  })
});

export const MetricFilterInput = new GraphQLInputObjectType({
  name: 'MetricFilterInput',
  fields: () => ({
    name: {
      type: GraphQLString
    },
    minValue: {
      type: GraphQLFloat
    },
    maxValue: {
      type: GraphQLFloat
    },
    tags: {
      type: GraphQLJSON
    },
    startTime: {
      type: GraphQLDateTime
    },
    endTime: {
      type: GraphQLDateTime
    }
  })
});

/**
 * Payload types for mutations
 */
export const UserPayload = new GraphQLObjectType({
  name: 'UserPayload',
  fields: () => ({
    user: {
      type: UserType
    },
    errors: {
      type: new GraphQLList(ErrorType)
    }
  })
});

export const MinerPayload = new GraphQLObjectType({
  name: 'MinerPayload',
  fields: () => ({
    miner: {
      type: MinerType
    },
    errors: {
      type: new GraphQLList(ErrorType)
    }
  })
});

export const ErrorType = new GraphQLObjectType({
  name: 'Error',
  fields: () => ({
    field: {
      type: GraphQLString,
      description: 'Field that caused the error'
    },
    message: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Error message'
    },
    code: {
      type: GraphQLString,
      description: 'Error code'
    }
  })
});

export default {
  // Interfaces
  NodeInterface,
  TimestampInterface,
  
  // Enums
  StatusEnum,
  MiningStatusEnum,
  LogLevelEnum,
  
  // Object Types
  UserType,
  ProfileType,
  UserStatsType,
  MinerType,
  MinerConfigType,
  MinerStatsType,
  LogEntryType,
  MetricType,
  PageInfoType,
  ErrorType,
  
  // Connections
  UserConnection,
  MinerConnection,
  LogEntryConnection,
  MetricConnection,
  
  // Input Types
  CreateUserInput,
  UpdateUserInput,
  ProfileInput,
  CreateMinerInput,
  UpdateMinerInput,
  MinerConfigInput,
  MetricFilterInput,
  
  // Payloads
  UserPayload,
  MinerPayload,
  
  // Utilities
  createConnectionType
};