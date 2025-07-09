/**
 * Input validation system with type safety
 * Following Clean Code principles: clear validation rules, helpful error messages
 */

import { Request, Response, NextFunction } from 'express';
import { z, ZodError, ZodSchema } from 'zod';
import validator from 'validator';
import { ValidationError } from '../errors/pool-errors';

// Common validation schemas
export const commonSchemas = {
  // Blockchain addresses
  bitcoinAddress: z.string().refine(
    (val) => /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(val) || /^bc1[a-z0-9]{39,59}$/.test(val),
    'Invalid Bitcoin address'
  ),
  
  ethereumAddress: z.string().refine(
    (val) => /^0x[a-fA-F0-9]{40}$/.test(val),
    'Invalid Ethereum address'
  ),
  
  // Common types
  email: z.string().email('Invalid email address'),
  
  username: z.string()
    .min(3, 'Username must be at least 3 characters')
    .max(30, 'Username must not exceed 30 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, underscores, and hyphens'),
  
  password: z.string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number')
    .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character'),
  
  // Numeric types
  positiveInt: z.number().int().positive(),
  
  percentage: z.number().min(0).max(100),
  
  port: z.number().int().min(1).max(65535),
  
  // Crypto amounts
  cryptoAmount: z.number().positive().refine(
    (val) => {
      const decimals = val.toString().split('.')[1];
      return !decimals || decimals.length <= 8;
    },
    'Maximum 8 decimal places allowed'
  ),
  
  // Pagination
  page: z.number().int().min(1).default(1),
  
  limit: z.number().int().min(1).max(100).default(20),
  
  // Dates
  dateString: z.string().refine(
    (val) => !isNaN(Date.parse(val)),
    'Invalid date format'
  ),
  
  // UUID
  uuid: z.string().uuid('Invalid UUID format'),
  
  // IP Address
  ipAddress: z.string().refine(
    (val) => validator.isIP(val),
    'Invalid IP address'
  ),
  
  // URL
  url: z.string().url('Invalid URL format'),
  
  // Hex string
  hexString: z.string().regex(/^[0-9a-fA-F]+$/, 'Invalid hex string'),
  
  // Worker name
  workerName: z.string()
    .max(50, 'Worker name too long')
    .regex(/^[a-zA-Z0-9_.-]*$/, 'Invalid worker name format')
    .optional()
};

// Validation schemas for pool operations
export const poolSchemas = {
  // Miner authorization
  minerAuth: z.object({
    address: commonSchemas.bitcoinAddress,
    signature: z.string().min(1),
    message: z.string().optional(),
    timestamp: z.number().optional()
  }),
  
  // Share submission
  shareSubmit: z.object({
    jobId: z.string(),
    nonce: z.string(),
    extraNonce2: z.string(),
    ntime: z.string(),
    address: z.string().optional()
  }),
  
  // Withdrawal request
  withdrawal: z.object({
    amount: commonSchemas.cryptoAmount,
    address: commonSchemas.bitcoinAddress,
    otp: z.string().length(6).optional()
  }),
  
  // Settings update
  settingsUpdate: z.object({
    email: commonSchemas.email.optional(),
    payoutThreshold: commonSchemas.cryptoAmount.optional(),
    donationPercentage: commonSchemas.percentage.optional(),
    notifications: z.object({
      blockFound: z.boolean().optional(),
      paymentSent: z.boolean().optional(),
      workerOffline: z.boolean().optional()
    }).optional()
  }),
  
  // API query parameters
  minerStatsQuery: z.object({
    address: commonSchemas.bitcoinAddress,
    period: z.enum(['1h', '24h', '7d', '30d']).default('24h'),
    includeShares: z.boolean().default(false),
    includePayments: z.boolean().default(false)
  }),
  
  // Pool stats query
  poolStatsQuery: z.object({
    period: z.enum(['1h', '24h', '7d', '30d']).default('24h'),
    interval: z.enum(['5m', '1h', '1d']).optional(),
    metrics: z.array(z.enum(['hashrate', 'miners', 'difficulty', 'blocks'])).optional()
  })
};

// Request validation middleware
export function validateRequest(schema: ZodSchema) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate request body
      if (req.body && Object.keys(req.body).length > 0) {
        req.body = await schema.parseAsync(req.body);
      }
      
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = formatZodErrors(error);
        res.status(400).json({
          error: 'Validation Error',
          message: 'Invalid request data',
          errors
        });
      } else {
        next(error);
      }
    }
  };
}

// Query parameter validation middleware
export function validateQuery(schema: ZodSchema) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Parse and validate query parameters
      const parsed = await schema.parseAsync(req.query);
      req.query = parsed as any;
      
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = formatZodErrors(error);
        res.status(400).json({
          error: 'Validation Error',
          message: 'Invalid query parameters',
          errors
        });
      } else {
        next(error);
      }
    }
  };
}

// Parameter validation middleware
export function validateParams(schema: ZodSchema) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate route parameters
      const parsed = await schema.parseAsync(req.params);
      req.params = parsed as any;
      
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = formatZodErrors(error);
        res.status(400).json({
          error: 'Validation Error',
          message: 'Invalid route parameters',
          errors
        });
      } else {
        next(error);
      }
    }
  };
}

// Combined validation middleware
export function validate(options: {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate all parts of the request
      if (options.body && req.body && Object.keys(req.body).length > 0) {
        req.body = await options.body.parseAsync(req.body);
      }
      
      if (options.query && req.query && Object.keys(req.query).length > 0) {
        req.query = await options.query.parseAsync(req.query) as any;
      }
      
      if (options.params && req.params && Object.keys(req.params).length > 0) {
        req.params = await options.params.parseAsync(req.params) as any;
      }
      
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = formatZodErrors(error);
        res.status(400).json({
          error: 'Validation Error',
          message: 'Invalid request',
          errors
        });
      } else {
        next(error);
      }
    }
  };
}

// Format Zod errors for API response
function formatZodErrors(error: ZodError): Array<{
  field: string;
  message: string;
  code: string;
}> {
  return error.errors.map(err => ({
    field: err.path.join('.'),
    message: err.message,
    code: err.code
  }));
}

// Custom validators
export const customValidators = {
  // Validate Bitcoin address checksum
  isBitcoinAddressValid(address: string): boolean {
    try {
      // Basic validation
      if (!commonSchemas.bitcoinAddress.safeParse(address).success) {
        return false;
      }
      
      // TODO: Implement proper checksum validation
      return true;
    } catch {
      return false;
    }
  },
  
  // Validate miner signature
  async validateMinerSignature(
    address: string,
    message: string,
    signature: string
  ): Promise<boolean> {
    try {
      // TODO: Implement signature verification
      return true;
    } catch {
      return false;
    }
  },
  
  // Sanitize input
  sanitize: {
    // Remove HTML tags
    stripHtml(input: string): string {
      return input.replace(/<[^>]*>/g, '');
    },
    
    // Escape HTML entities
    escapeHtml(input: string): string {
      const map: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
        '/': '&#x2F;'
      };
      
      return input.replace(/[&<>"'/]/g, (char) => map[char]);
    },
    
    // Normalize whitespace
    normalizeWhitespace(input: string): string {
      return input.trim().replace(/\s+/g, ' ');
    },
    
    // Convert to safe filename
    toSafeFilename(input: string): string {
      return input
        .replace(/[^a-zA-Z0-9.-]/g, '_')
        .replace(/_{2,}/g, '_')
        .substring(0, 255);
    }
  }
};

// Rate limit validation
export function validateRateLimit(
  maxRequests: number,
  windowMs: number,
  keyGenerator?: (req: Request) => string
) {
  const requests = new Map<string, { count: number; resetTime: number }>();
  
  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyGenerator ? keyGenerator(req) : req.ip;
    const now = Date.now();
    
    const record = requests.get(key);
    
    if (!record || now > record.resetTime) {
      requests.set(key, {
        count: 1,
        resetTime: now + windowMs
      });
      next();
      return;
    }
    
    if (record.count >= maxRequests) {
      res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded',
        retryAfter: Math.ceil((record.resetTime - now) / 1000)
      });
      return;
    }
    
    record.count++;
    next();
  };
}

// Export validation utilities
export const validation = {
  schemas: {
    common: commonSchemas,
    pool: poolSchemas
  },
  middleware: {
    body: validateRequest,
    query: validateQuery,
    params: validateParams,
    all: validate
  },
  validators: customValidators,
  rateLimit: validateRateLimit
};

export default validation;
