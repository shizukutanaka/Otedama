/**
 * GraphQL Context - Authentication and Service Management
 * 
 * Design Philosophy:
 * - Carmack: Efficient context creation, minimal overhead
 * - Martin: Clear separation of concerns, dependency injection
 * - Pike: Simple authentication, clear error messages
 */

import { PubSub } from 'graphql-subscriptions';
import * as jwt from 'jsonwebtoken';
import { UnifiedDatabase } from '../database/unified-database';
import { UnifiedMetrics } from '../metrics/unified-metrics';
import { UnifiedSecurity } from '../security/unified-security';
import { UnifiedLogger } from '../logging/unified-logger';

export interface User {
  address: string;
  role: 'user' | 'moderator' | 'admin';
  permissions: string[];
}

export interface GraphQLServices {
  database: UnifiedDatabase;
  metrics: UnifiedMetrics;
  security: UnifiedSecurity;
  logger: UnifiedLogger;
}

export interface GraphQLContext {
  user?: User;
  isAuthenticated: boolean;
  services: GraphQLServices;
  pubsub: PubSub;
  logger: UnifiedLogger;
  
  // Helper methods
  requireAuth(): void;
  requireRole(role: string): void;
  requirePermission(permission: string): void;
  requireOwnership(resourceId: string): void;
  getClientIP(): string;
  getUserAgent(): string;
}

export interface ContextParams {
  req: any; // Express request object
  database: UnifiedDatabase;
  metrics: UnifiedMetrics;
  security: UnifiedSecurity;
  pubsub: PubSub;
  logger: UnifiedLogger;
  jwtSecret: string;
}

export async function createContext(params: ContextParams): Promise<GraphQLContext> {
  const { req, database, metrics, security, pubsub, logger, jwtSecret } = params;
  
  let user: User | undefined;
  let isAuthenticated = false;

  // Extract and verify JWT token
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    
    try {
      const decoded = jwt.verify(token, jwtSecret) as any;
      
      // Load user data from database
      const account = await database.getAccount(decoded.address);
      if (account) {
        user = {
          address: decoded.address,
          role: decoded.role || 'user',
          permissions: decoded.permissions || []
        };
        isAuthenticated = true;
        
        logger.debug(`Authenticated user: ${user.address}`);
      }
    } catch (error) {
      logger.warn('Invalid JWT token:', error);
      // Continue without authentication
    }
  }

  const context: GraphQLContext = {
    user,
    isAuthenticated,
    services: {
      database,
      metrics,
      security,
      logger
    },
    pubsub,
    logger,

    requireAuth(): void {
      if (!this.isAuthenticated || !this.user) {
        throw new AuthenticationError('Authentication required');
      }
    },

    requireRole(requiredRole: string): void {
      this.requireAuth();
      
      const roleHierarchy = {
        'user': 0,
        'moderator': 1,
        'admin': 2
      };
      
      const userLevel = roleHierarchy[this.user!.role as keyof typeof roleHierarchy] || 0;
      const requiredLevel = roleHierarchy[requiredRole as keyof typeof roleHierarchy] || 0;
      
      if (userLevel < requiredLevel) {
        throw new ForbiddenError(`Role '${requiredRole}' required`);
      }
    },

    requirePermission(permission: string): void {
      this.requireAuth();
      
      if (!this.user!.permissions.includes(permission)) {
        throw new ForbiddenError(`Permission '${permission}' required`);
      }
    },

    requireOwnership(resourceId: string): void {
      this.requireAuth();
      
      // For mining pools, users can only access their own resources
      // This would need to be implemented based on the specific resource type
      // For now, we'll allow admins to access everything and users to access their own resources
      
      if (this.user!.role === 'admin') {
        return; // Admins can access everything
      }
      
      // Check if the resource belongs to the user
      // This would typically involve a database lookup
      // For simplicity, we'll assume the resourceId contains the user address
      if (!resourceId.includes(this.user!.address)) {
        throw new ForbiddenError('Access denied: resource ownership required');
      }
    },

    getClientIP(): string {
      return req.ip || 
             req.connection?.remoteAddress || 
             req.socket?.remoteAddress ||
             (req.connection?.socket ? req.connection.socket.remoteAddress : null) ||
             '0.0.0.0';
    },

    getUserAgent(): string {
      return req.headers['user-agent'] || 'Unknown';
    }
  };

  // Log request for audit purposes
  logger.debug('GraphQL request', {
    ip: context.getClientIP(),
    userAgent: context.getUserAgent(),
    authenticated: isAuthenticated,
    user: user?.address
  });

  return context;
}

// Custom error classes for better error handling
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
    Object.setPrototypeOf(this, ForbiddenError.prototype);
  }
}

export class ValidationError extends Error {
  constructor(message: string, public field?: string) {
    super(message);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

// Context middleware for rate limiting
export class ContextMiddleware {
  private requestCounts: Map<string, { count: number; resetTime: number }> = new Map();
  
  constructor(
    private rateLimitPerMinute: number = 100,
    private logger: UnifiedLogger
  ) {}

  public checkRateLimit(context: GraphQLContext): void {
    const clientIP = context.getClientIP();
    const now = Date.now();
    const windowStart = Math.floor(now / 60000) * 60000; // 1-minute window
    
    const key = `${clientIP}:${windowStart}`;
    const current = this.requestCounts.get(key) || { count: 0, resetTime: windowStart + 60000 };
    
    if (now > current.resetTime) {
      // Reset counter for new window
      current.count = 0;
      current.resetTime = windowStart + 60000;
    }
    
    current.count++;
    this.requestCounts.set(key, current);
    
    if (current.count > this.rateLimitPerMinute) {
      this.logger.warn(`Rate limit exceeded for IP: ${clientIP}`);
      throw new Error('Rate limit exceeded. Please try again later.');
    }
    
    // Clean up old entries
    if (this.requestCounts.size > 10000) {
      const cutoff = now - 120000; // 2 minutes ago
      for (const [k, v] of this.requestCounts.entries()) {
        if (v.resetTime < cutoff) {
          this.requestCounts.delete(k);
        }
      }
    }
  }
}

// Helper function to validate GraphQL input
export function validateInput(input: any, schema: any): void {
  // Simple validation - in production, use a proper validation library like Joi or Yup
  for (const [field, rules] of Object.entries(schema)) {
    const value = input[field];
    
    if (rules && typeof rules === 'object') {
      const fieldRules = rules as any;
      
      if (fieldRules.required && (value === undefined || value === null)) {
        throw new ValidationError(`Field '${field}' is required`, field);
      }
      
      if (fieldRules.type && value !== undefined) {
        const expectedType = fieldRules.type;
        const actualType = typeof value;
        
        if (actualType !== expectedType) {
          throw new ValidationError(
            `Field '${field}' must be of type ${expectedType}, got ${actualType}`,
            field
          );
        }
      }
      
      if (fieldRules.minLength && typeof value === 'string' && value.length < fieldRules.minLength) {
        throw new ValidationError(
          `Field '${field}' must be at least ${fieldRules.minLength} characters`,
          field
        );
      }
      
      if (fieldRules.maxLength && typeof value === 'string' && value.length > fieldRules.maxLength) {
        throw new ValidationError(
          `Field '${field}' must be at most ${fieldRules.maxLength} characters`,
          field
        );
      }
      
      if (fieldRules.min && typeof value === 'number' && value < fieldRules.min) {
        throw new ValidationError(
          `Field '${field}' must be at least ${fieldRules.min}`,
          field
        );
      }
      
      if (fieldRules.max && typeof value === 'number' && value > fieldRules.max) {
        throw new ValidationError(
          `Field '${field}' must be at most ${fieldRules.max}`,
          field
        );
      }
      
      if (fieldRules.pattern && typeof value === 'string' && !fieldRules.pattern.test(value)) {
        throw new ValidationError(
          `Field '${field}' format is invalid`,
          field
        );
      }
    }
  }
}

// Schema definitions for common validation
export const schemas = {
  minerAddress: {
    address: {
      required: true,
      type: 'string',
      minLength: 26,
      maxLength: 62,
      pattern: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$/ // Bitcoin address pattern
    }
  },
  
  workerName: {
    name: {
      required: true,
      type: 'string',
      minLength: 1,
      maxLength: 32,
      pattern: /^[a-zA-Z0-9_-]+$/ // Alphanumeric, underscore, dash
    }
  },
  
  poolConfig: {
    fee: {
      type: 'number',
      min: 0,
      max: 10
    },
    minPayout: {
      type: 'number',
      min: 0.00001,
      max: 1000
    },
    payoutInterval: {
      type: 'number',
      min: 3600, // 1 hour
      max: 604800 // 1 week
    }
  }
};