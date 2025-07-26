/**
 * API Documentation Generator - Otedama
 * OpenAPI/Swagger documentation generator
 * 
 * Design: Self-documenting APIs (Martin)
 */

import { createStructuredLogger } from './structured-logger.js';
import fs from 'fs/promises';
import path from 'path';

const logger = createStructuredLogger('APIDoc');

/**
 * API documentation builder
 */
export class APIDocBuilder {
  constructor(config = {}) {
    this.config = {
      title: config.title || 'API Documentation',
      description: config.description || '',
      version: config.version || '1.0.0',
      servers: config.servers || [{ url: 'http://localhost:3000' }],
      contact: config.contact || {},
      license: config.license || {},
      ...config
    };
    
    this.paths = {};
    this.components = {
      schemas: {},
      responses: {},
      parameters: {},
      securitySchemes: {}
    };
    this.tags = [];
  }
  
  /**
   * Add a tag
   */
  addTag(name, description) {
    this.tags.push({ name, description });
    return this;
  }
  
  /**
   * Add a path
   */
  addPath(path, method, operation) {
    if (!this.paths[path]) {
      this.paths[path] = {};
    }
    
    this.paths[path][method.toLowerCase()] = operation;
    return this;
  }
  
  /**
   * Add a schema
   */
  addSchema(name, schema) {
    this.components.schemas[name] = schema;
    return this;
  }
  
  /**
   * Add a response
   */
  addResponse(name, response) {
    this.components.responses[name] = response;
    return this;
  }
  
  /**
   * Add a parameter
   */
  addParameter(name, parameter) {
    this.components.parameters[name] = parameter;
    return this;
  }
  
  /**
   * Add security scheme
   */
  addSecurityScheme(name, scheme) {
    this.components.securitySchemes[name] = scheme;
    return this;
  }
  
  /**
   * Build OpenAPI specification
   */
  build() {
    return {
      openapi: '3.0.0',
      info: {
        title: this.config.title,
        description: this.config.description,
        version: this.config.version,
        contact: this.config.contact,
        license: this.config.license
      },
      servers: this.config.servers,
      tags: this.tags,
      paths: this.paths,
      components: this.components
    };
  }
  
  /**
   * Generate documentation
   */
  async generate(outputPath) {
    const spec = this.build();
    await fs.writeFile(outputPath, JSON.stringify(spec, null, 2));
    logger.info(`API documentation generated: ${outputPath}`);
  }
}

/**
 * Route documenter
 */
export class RouteDocumenter {
  constructor(builder) {
    this.builder = builder;
  }
  
  /**
   * Document a route
   */
  document(path, method, options = {}) {
    const operation = {
      summary: options.summary || '',
      description: options.description || '',
      tags: options.tags || [],
      operationId: options.operationId || `${method}${path.replace(/[^a-zA-Z0-9]/g, '')}`,
      parameters: [],
      responses: {},
      security: options.security || []
    };
    
    // Add parameters
    if (options.parameters) {
      operation.parameters = options.parameters.map(param => {
        if (typeof param === 'string') {
          return { $ref: `#/components/parameters/${param}` };
        }
        return param;
      });
    }
    
    // Add request body
    if (options.requestBody) {
      operation.requestBody = options.requestBody;
    }
    
    // Add responses
    if (options.responses) {
      operation.responses = options.responses;
    } else {
      // Default responses
      operation.responses = {
        200: {
          description: 'Success',
          content: {
            'application/json': {
              schema: { type: 'object' }
            }
          }
        },
        400: { $ref: '#/components/responses/BadRequest' },
        401: { $ref: '#/components/responses/Unauthorized' },
        500: { $ref: '#/components/responses/InternalError' }
      };
    }
    
    this.builder.addPath(path, method, operation);
    
    return this;
  }
  
  /**
   * Document middleware for Express
   */
  middleware(options = {}) {
    return (req, res, next) => {
      // Store documentation options on route
      if (req.route) {
        req.route._apiDoc = options;
      }
      next();
    };
  }
}

/**
 * Schema builder
 */
export class SchemaBuilder {
  static object(properties = {}, options = {}) {
    return {
      type: 'object',
      properties,
      required: options.required || [],
      additionalProperties: options.additionalProperties !== false,
      ...options
    };
  }
  
  static array(items, options = {}) {
    return {
      type: 'array',
      items,
      ...options
    };
  }
  
  static string(options = {}) {
    return {
      type: 'string',
      ...options
    };
  }
  
  static number(options = {}) {
    return {
      type: 'number',
      ...options
    };
  }
  
  static integer(options = {}) {
    return {
      type: 'integer',
      ...options
    };
  }
  
  static boolean(options = {}) {
    return {
      type: 'boolean',
      ...options
    };
  }
  
  static enum(values, options = {}) {
    return {
      type: 'string',
      enum: values,
      ...options
    };
  }
  
  static ref(name) {
    return { $ref: `#/components/schemas/${name}` };
  }
  
  static oneOf(schemas) {
    return { oneOf: schemas };
  }
  
  static allOf(schemas) {
    return { allOf: schemas };
  }
  
  static anyOf(schemas) {
    return { anyOf: schemas };
  }
}

/**
 * Common schemas
 */
export const CommonSchemas = {
  Error: SchemaBuilder.object({
    error: SchemaBuilder.object({
      message: SchemaBuilder.string({ description: 'Error message' }),
      code: SchemaBuilder.string({ description: 'Error code' }),
      details: SchemaBuilder.object({}, { additionalProperties: true })
    })
  }),
  
  Pagination: SchemaBuilder.object({
    page: SchemaBuilder.integer({ minimum: 1, default: 1 }),
    limit: SchemaBuilder.integer({ minimum: 1, maximum: 100, default: 20 }),
    total: SchemaBuilder.integer({ minimum: 0 }),
    totalPages: SchemaBuilder.integer({ minimum: 0 })
  }),
  
  Timestamp: SchemaBuilder.string({
    format: 'date-time',
    description: 'ISO 8601 timestamp'
  }),
  
  UUID: SchemaBuilder.string({
    format: 'uuid',
    pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  }),
  
  Email: SchemaBuilder.string({
    format: 'email',
    pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$'
  }),
  
  URL: SchemaBuilder.string({
    format: 'uri',
    pattern: '^https?://'
  }),
  
  Hash: SchemaBuilder.string({
    pattern: '^[a-fA-F0-9]{64}$',
    description: 'SHA256 hash'
  }),
  
  Address: SchemaBuilder.string({
    pattern: '^(0x[a-fA-F0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$',
    description: 'Cryptocurrency address'
  })
};

/**
 * Common responses
 */
export const CommonResponses = {
  Success: {
    description: 'Success',
    content: {
      'application/json': {
        schema: SchemaBuilder.object({
          success: SchemaBuilder.boolean({ example: true }),
          data: SchemaBuilder.object({}, { additionalProperties: true })
        })
      }
    }
  },
  
  BadRequest: {
    description: 'Bad Request',
    content: {
      'application/json': {
        schema: SchemaBuilder.ref('Error'),
        example: {
          error: {
            message: 'Invalid request parameters',
            code: 'BAD_REQUEST'
          }
        }
      }
    }
  },
  
  Unauthorized: {
    description: 'Unauthorized',
    content: {
      'application/json': {
        schema: SchemaBuilder.ref('Error'),
        example: {
          error: {
            message: 'Authentication required',
            code: 'UNAUTHORIZED'
          }
        }
      }
    }
  },
  
  Forbidden: {
    description: 'Forbidden',
    content: {
      'application/json': {
        schema: SchemaBuilder.ref('Error'),
        example: {
          error: {
            message: 'Access denied',
            code: 'FORBIDDEN'
          }
        }
      }
    }
  },
  
  NotFound: {
    description: 'Not Found',
    content: {
      'application/json': {
        schema: SchemaBuilder.ref('Error'),
        example: {
          error: {
            message: 'Resource not found',
            code: 'NOT_FOUND'
          }
        }
      }
    }
  },
  
  RateLimit: {
    description: 'Rate Limit Exceeded',
    content: {
      'application/json': {
        schema: SchemaBuilder.ref('Error'),
        example: {
          error: {
            message: 'Rate limit exceeded',
            code: 'RATE_LIMIT_EXCEEDED'
          }
        }
      }
    },
    headers: {
      'X-RateLimit-Limit': {
        description: 'Request limit per minute',
        schema: { type: 'integer' }
      },
      'X-RateLimit-Remaining': {
        description: 'Remaining requests',
        schema: { type: 'integer' }
      },
      'X-RateLimit-Reset': {
        description: 'Reset time (Unix timestamp)',
        schema: { type: 'integer' }
      }
    }
  },
  
  InternalError: {
    description: 'Internal Server Error',
    content: {
      'application/json': {
        schema: SchemaBuilder.ref('Error'),
        example: {
          error: {
            message: 'An unexpected error occurred',
            code: 'INTERNAL_ERROR'
          }
        }
      }
    }
  }
};

/**
 * Common parameters
 */
export const CommonParameters = {
  PageParam: {
    name: 'page',
    in: 'query',
    description: 'Page number',
    schema: SchemaBuilder.integer({ minimum: 1, default: 1 })
  },
  
  LimitParam: {
    name: 'limit',
    in: 'query',
    description: 'Items per page',
    schema: SchemaBuilder.integer({ minimum: 1, maximum: 100, default: 20 })
  },
  
  SortParam: {
    name: 'sort',
    in: 'query',
    description: 'Sort field',
    schema: SchemaBuilder.string()
  },
  
  OrderParam: {
    name: 'order',
    in: 'query',
    description: 'Sort order',
    schema: SchemaBuilder.enum(['asc', 'desc'], { default: 'desc' })
  },
  
  SearchParam: {
    name: 'search',
    in: 'query',
    description: 'Search query',
    schema: SchemaBuilder.string()
  },
  
  FilterParam: {
    name: 'filter',
    in: 'query',
    description: 'Filter criteria',
    schema: SchemaBuilder.string()
  },
  
  IdParam: {
    name: 'id',
    in: 'path',
    description: 'Resource ID',
    required: true,
    schema: SchemaBuilder.string()
  },
  
  AuthHeader: {
    name: 'Authorization',
    in: 'header',
    description: 'Bearer token',
    required: true,
    schema: SchemaBuilder.string({ pattern: '^Bearer .+$' })
  },
  
  APIKeyHeader: {
    name: 'X-API-Key',
    in: 'header',
    description: 'API key',
    required: true,
    schema: SchemaBuilder.string()
  }
};

/**
 * Otedama API documentation
 */
export function createOtedamaAPIDocs() {
  const builder = new APIDocBuilder({
    title: 'Otedama Mining Pool API',
    description: 'RESTful API for Otedama P2P Mining Pool',
    version: '1.0.0',
    contact: {
      name: 'Otedama Team',
      url: 'https://github.com/shizukutanaka/Otedama'
    },
    license: {
      name: 'MIT',
      url: 'https://opensource.org/licenses/MIT'
    }
  });
  
  // Add tags
  builder
    .addTag('Pool', 'Pool information and statistics')
    .addTag('Mining', 'Mining operations')
    .addTag('Miners', 'Miner management')
    .addTag('Shares', 'Share submission and validation')
    .addTag('Blocks', 'Block information')
    .addTag('Payments', 'Payment processing')
    .addTag('Admin', 'Administrative operations');
  
  // Add common schemas
  Object.entries(CommonSchemas).forEach(([name, schema]) => {
    builder.addSchema(name, schema);
  });
  
  // Add common responses
  Object.entries(CommonResponses).forEach(([name, response]) => {
    builder.addResponse(name, response);
  });
  
  // Add common parameters
  Object.entries(CommonParameters).forEach(([name, parameter]) => {
    builder.addParameter(name, parameter);
  });
  
  // Add security schemes
  builder
    .addSecurityScheme('bearerAuth', {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT'
    })
    .addSecurityScheme('apiKey', {
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key'
    });
  
  // Pool endpoints
  builder
    .addPath('/api/pool/stats', 'GET', {
      summary: 'Get pool statistics',
      tags: ['Pool'],
      responses: {
        200: {
          description: 'Pool statistics',
          content: {
            'application/json': {
              schema: SchemaBuilder.object({
                hashrate: SchemaBuilder.number({ description: 'Pool hashrate in H/s' }),
                miners: SchemaBuilder.integer({ description: 'Active miners' }),
                workers: SchemaBuilder.integer({ description: 'Active workers' }),
                difficulty: SchemaBuilder.number({ description: 'Current difficulty' }),
                lastBlock: SchemaBuilder.object({
                  height: SchemaBuilder.integer(),
                  hash: SchemaBuilder.ref('Hash'),
                  reward: SchemaBuilder.number(),
                  timestamp: SchemaBuilder.ref('Timestamp')
                })
              })
            }
          }
        }
      }
    })
    .addPath('/api/pool/blocks', 'GET', {
      summary: 'Get recent blocks',
      tags: ['Pool', 'Blocks'],
      parameters: ['PageParam', 'LimitParam'],
      responses: {
        200: {
          description: 'List of blocks',
          content: {
            'application/json': {
              schema: SchemaBuilder.object({
                blocks: SchemaBuilder.array(
                  SchemaBuilder.object({
                    height: SchemaBuilder.integer(),
                    hash: SchemaBuilder.ref('Hash'),
                    miner: SchemaBuilder.ref('Address'),
                    reward: SchemaBuilder.number(),
                    timestamp: SchemaBuilder.ref('Timestamp')
                  })
                ),
                pagination: SchemaBuilder.ref('Pagination')
              })
            }
          }
        }
      }
    });
  
  // Mining endpoints
  builder
    .addPath('/api/mining/job', 'GET', {
      summary: 'Get current mining job',
      tags: ['Mining'],
      security: [{ apiKey: [] }],
      responses: {
        200: {
          description: 'Mining job',
          content: {
            'application/json': {
              schema: SchemaBuilder.object({
                jobId: SchemaBuilder.string(),
                prevHash: SchemaBuilder.ref('Hash'),
                coinbase1: SchemaBuilder.string(),
                coinbase2: SchemaBuilder.string(),
                merkleTree: SchemaBuilder.array(SchemaBuilder.string()),
                version: SchemaBuilder.string(),
                bits: SchemaBuilder.string(),
                time: SchemaBuilder.integer(),
                difficulty: SchemaBuilder.number()
              })
            }
          }
        }
      }
    })
    .addPath('/api/mining/submit', 'POST', {
      summary: 'Submit share',
      tags: ['Mining', 'Shares'],
      security: [{ apiKey: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: SchemaBuilder.object({
              jobId: SchemaBuilder.string(),
              nonce: SchemaBuilder.string(),
              extraNonce2: SchemaBuilder.string(),
              time: SchemaBuilder.string()
            }, { required: ['jobId', 'nonce', 'extraNonce2', 'time'] })
          }
        }
      },
      responses: {
        200: {
          description: 'Share accepted',
          content: {
            'application/json': {
              schema: SchemaBuilder.object({
                accepted: SchemaBuilder.boolean(),
                difficulty: SchemaBuilder.number()
              })
            }
          }
        }
      }
    });
  
  return builder;
}

/**
 * API documentation middleware
 */
export function apiDocMiddleware(app, builder) {
  // Serve OpenAPI spec
  app.get('/api/docs/openapi.json', (req, res) => {
    res.json(builder.build());
  });
  
  // Serve Swagger UI
  app.get('/api/docs', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>${builder.config.title}</title>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@4/swagger-ui.css">
      </head>
      <body>
        <div id="swagger-ui"></div>
        <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@4/swagger-ui-bundle.js"></script>
        <script>
          SwaggerUIBundle({
            url: '/api/docs/openapi.json',
            dom_id: '#swagger-ui',
            presets: [
              SwaggerUIBundle.presets.apis,
              SwaggerUIBundle.SwaggerUIStandalonePreset
            ],
            layout: 'BaseLayout'
          });
        </script>
      </body>
      </html>
    `);
  });
}

export default {
  APIDocBuilder,
  RouteDocumenter,
  SchemaBuilder,
  CommonSchemas,
  CommonResponses,
  CommonParameters,
  createOtedamaAPIDocs,
  apiDocMiddleware
};
