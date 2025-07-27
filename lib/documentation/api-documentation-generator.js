/**
 * API Documentation Generator - Otedama
 * Comprehensive API documentation with OpenAPI/Swagger
 * 
 * Design principles:
 * - Carmack: Fast documentation generation
 * - Martin: Clean documentation structure
 * - Pike: Simple API exploration
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import SwaggerJSDoc from 'swagger-jsdoc';
import { createStructuredLogger } from '../core/structured-logger.js';
import { marked } from 'marked';
import hljs from 'highlight.js';

const logger = createStructuredLogger('APIDocumentationGenerator');
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * API Documentation Generator
 */
export class APIDocumentationGenerator {
  constructor(config = {}) {
    this.config = {
      title: config.title || 'Otedama P2P Mining Pool API',
      version: config.version || '1.1.5',
      description: config.description || 'Production-ready P2P mining pool with advanced features',
      
      // OpenAPI config
      openApiVersion: config.openApiVersion || '3.0.0',
      servers: config.servers || [
        {
          url: 'http://localhost:3000',
          description: 'Development server'
        }
      ],
      
      // Paths
      sourcePaths: config.sourcePaths || ['./routes/**/*.js', './lib/**/*.js'],
      outputPath: config.outputPath || './docs/api',
      
      // Features
      includeExamples: config.includeExamples !== false,
      includeSchemas: config.includeSchemas !== false,
      includeAuthentication: config.includeAuthentication !== false,
      includeWebhooks: config.includeWebhooks !== false,
      includeAsyncAPI: config.includeAsyncAPI !== false,
      
      // Customization
      theme: config.theme || 'dark',
      logo: config.logo || '/assets/logo.png',
      
      ...config
    };
    
    this.documentation = {
      openapi: this.config.openApiVersion,
      info: {
        title: this.config.title,
        version: this.config.version,
        description: this.config.description,
        contact: {
          name: 'Otedama Support',
          url: 'https://github.com/shizukutanaka/Otedama/issues'
        },
        license: {
          name: 'MIT',
          url: 'https://opensource.org/licenses/MIT'
        }
      },
      servers: this.config.servers,
      tags: [],
      paths: {},
      components: {
        schemas: {},
        securitySchemes: {},
        parameters: {},
        responses: {},
        examples: {},
        requestBodies: {},
        headers: {},
        callbacks: {}
      },
      security: [],
      webhooks: {}
    };
    
    // Configure marked for markdown rendering
    marked.setOptions({
      highlight: function(code, lang) {
        const language = hljs.getLanguage(lang) ? lang : 'plaintext';
        return hljs.highlight(code, { language }).value;
      },
      langPrefix: 'hljs language-'
    });
  }
  
  /**
   * Generate API documentation
   */
  async generate() {
    try {
      logger.info('Starting API documentation generation');
      
      // Create output directory
      await fs.mkdir(this.config.outputPath, { recursive: true });
      
      // Define API tags
      this.defineTags();
      
      // Define security schemes
      if (this.config.includeAuthentication) {
        this.defineSecuritySchemes();
      }
      
      // Define common schemas
      if (this.config.includeSchemas) {
        this.defineSchemas();
      }
      
      // Define API endpoints
      this.defineEndpoints();
      
      // Define webhooks
      if (this.config.includeWebhooks) {
        this.defineWebhooks();
      }
      
      // Generate OpenAPI spec using swagger-jsdoc
      const options = {
        definition: this.documentation,
        apis: this.config.sourcePaths
      };
      
      const spec = SwaggerJSDoc(options);
      
      // Write OpenAPI spec
      await fs.writeFile(
        join(this.config.outputPath, 'openapi.json'),
        JSON.stringify(spec, null, 2)
      );
      
      // Generate HTML documentation
      await this.generateHTMLDocumentation(spec);
      
      // Generate markdown documentation
      await this.generateMarkdownDocumentation(spec);
      
      // Generate client SDKs
      await this.generateClientSDKs(spec);
      
      // Generate AsyncAPI documentation if enabled
      if (this.config.includeAsyncAPI) {
        await this.generateAsyncAPIDocumentation();
      }
      
      logger.info('API documentation generated successfully', {
        outputPath: this.config.outputPath
      });
      
      return spec;
      
    } catch (error) {
      logger.error('Failed to generate API documentation', { error });
      throw error;
    }
  }
  
  /**
   * Define API tags
   */
  defineTags() {
    this.documentation.tags = [
      {
        name: 'Authentication',
        description: 'Authentication and authorization endpoints'
      },
      {
        name: 'Mining',
        description: 'Mining operations and worker management'
      },
      {
        name: 'Pool',
        description: 'Pool statistics and configuration'
      },
      {
        name: 'Wallet',
        description: 'Wallet management and transactions'
      },
      {
        name: 'Statistics',
        description: 'Mining and pool statistics'
      },
      {
        name: 'Admin',
        description: 'Administrative operations'
      },
      {
        name: 'Webhooks',
        description: 'Webhook configuration and management'
      },
      {
        name: 'WebSocket',
        description: 'Real-time WebSocket endpoints'
      }
    ];
  }
  
  /**
   * Define security schemes
   */
  defineSecuritySchemes() {
    this.documentation.components.securitySchemes = {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT authentication token'
      },
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'API key for machine-to-machine authentication'
      },
      ZKProof: {
        type: 'apiKey',
        in: 'header',
        name: 'X-ZK-Proof',
        description: 'Zero-knowledge proof for anonymous authentication'
      }
    };
    
    // Set default security
    this.documentation.security = [
      { BearerAuth: [] },
      { ApiKeyAuth: [] }
    ];
  }
  
  /**
   * Define common schemas
   */
  defineSchemas() {
    this.documentation.components.schemas = {
      // Common schemas
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'string',
            description: 'Error code'
          },
          message: {
            type: 'string',
            description: 'Error message'
          },
          details: {
            type: 'object',
            description: 'Additional error details'
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
            description: 'Error timestamp'
          }
        },
        required: ['error', 'message']
      },
      
      Success: {
        type: 'object',
        properties: {
          success: {
            type: 'boolean',
            default: true
          },
          message: {
            type: 'string'
          },
          data: {
            type: 'object'
          }
        }
      },
      
      Pagination: {
        type: 'object',
        properties: {
          page: {
            type: 'integer',
            minimum: 1,
            default: 1
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: 20
          },
          total: {
            type: 'integer'
          },
          totalPages: {
            type: 'integer'
          }
        }
      },
      
      // Mining schemas
      Worker: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Worker ID'
          },
          name: {
            type: 'string',
            description: 'Worker name'
          },
          status: {
            type: 'string',
            enum: ['active', 'inactive', 'error'],
            description: 'Worker status'
          },
          hashrate: {
            type: 'number',
            description: 'Current hashrate in H/s'
          },
          shares: {
            type: 'object',
            properties: {
              accepted: { type: 'integer' },
              rejected: { type: 'integer' },
              stale: { type: 'integer' }
            }
          },
          lastSeen: {
            type: 'string',
            format: 'date-time'
          },
          algorithm: {
            type: 'string',
            enum: ['sha256d', 'scrypt', 'ethash', 'randomx', 'kawpow']
          }
        },
        required: ['id', 'name', 'status']
      },
      
      MiningStats: {
        type: 'object',
        properties: {
          hashrate: {
            type: 'object',
            properties: {
              current: { type: 'number' },
              average1h: { type: 'number' },
              average24h: { type: 'number' },
              average7d: { type: 'number' }
            }
          },
          shares: {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              accepted: { type: 'integer' },
              rejected: { type: 'integer' },
              stale: { type: 'integer' }
            }
          },
          blocks: {
            type: 'object',
            properties: {
              found: { type: 'integer' },
              confirmed: { type: 'integer' },
              orphaned: { type: 'integer' },
              pending: { type: 'integer' }
            }
          },
          earnings: {
            type: 'object',
            properties: {
              total: { type: 'number' },
              paid: { type: 'number' },
              pending: { type: 'number' },
              currency: { type: 'string' }
            }
          }
        }
      },
      
      // Pool schemas
      PoolInfo: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          algorithm: { type: 'string' },
          coin: { type: 'string' },
          network: { type: 'string' },
          fee: { type: 'number' },
          minPayout: { type: 'number' },
          payoutInterval: { type: 'string' },
          workers: { type: 'integer' },
          hashrate: { type: 'number' },
          difficulty: { type: 'number' },
          blockHeight: { type: 'integer' },
          lastBlock: {
            type: 'object',
            properties: {
              height: { type: 'integer' },
              hash: { type: 'string' },
              time: { type: 'string', format: 'date-time' },
              reward: { type: 'number' }
            }
          }
        }
      },
      
      // Wallet schemas
      Wallet: {
        type: 'object',
        properties: {
          address: { type: 'string' },
          balance: {
            type: 'object',
            properties: {
              confirmed: { type: 'number' },
              pending: { type: 'number' },
              total: { type: 'number' }
            }
          },
          currency: { type: 'string' },
          label: { type: 'string' },
          created: { type: 'string', format: 'date-time' }
        },
        required: ['address', 'balance', 'currency']
      },
      
      Transaction: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: {
            type: 'string',
            enum: ['payout', 'deposit', 'fee', 'reward']
          },
          amount: { type: 'number' },
          currency: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'confirmed', 'failed']
          },
          txid: { type: 'string' },
          confirmations: { type: 'integer' },
          timestamp: { type: 'string', format: 'date-time' },
          metadata: { type: 'object' }
        },
        required: ['id', 'type', 'amount', 'currency', 'status']
      }
    };
  }
  
  /**
   * Define API endpoints
   */
  defineEndpoints() {
    this.documentation.paths = {
      // Authentication endpoints
      '/auth/login': {
        post: {
          tags: ['Authentication'],
          summary: 'Login to the system',
          description: 'Authenticate using username/password or zero-knowledge proof',
          operationId: 'login',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      properties: {
                        username: { type: 'string' },
                        password: { type: 'string' }
                      },
                      required: ['username', 'password']
                    },
                    {
                      type: 'object',
                      properties: {
                        zkProof: { type: 'string' },
                        challenge: { type: 'string' }
                      },
                      required: ['zkProof', 'challenge']
                    }
                  ]
                },
                examples: {
                  password: {
                    summary: 'Password authentication',
                    value: {
                      username: 'miner123',
                      password: 'securepassword'
                    }
                  },
                  zkProof: {
                    summary: 'Zero-knowledge proof authentication',
                    value: {
                      zkProof: 'base64encodedproof...',
                      challenge: 'randomchallenge123'
                    }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Login successful',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      token: { type: 'string' },
                      refreshToken: { type: 'string' },
                      expiresIn: { type: 'integer' },
                      user: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          username: { type: 'string' },
                          role: { type: 'string' }
                        }
                      }
                    }
                  }
                }
              }
            },
            '401': {
              description: 'Authentication failed',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' }
                }
              }
            }
          },
          security: []
        }
      },
      
      // Mining endpoints
      '/mining/workers': {
        get: {
          tags: ['Mining'],
          summary: 'List all workers',
          description: 'Get a list of all mining workers for the authenticated user',
          operationId: 'listWorkers',
          parameters: [
            {
              name: 'status',
              in: 'query',
              description: 'Filter by worker status',
              schema: {
                type: 'string',
                enum: ['active', 'inactive', 'error']
              }
            },
            {
              name: 'page',
              in: 'query',
              schema: { type: 'integer', minimum: 1, default: 1 }
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
            }
          ],
          responses: {
            '200': {
              description: 'List of workers',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      workers: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Worker' }
                      },
                      pagination: { $ref: '#/components/schemas/Pagination' }
                    }
                  }
                }
              }
            }
          }
        },
        
        post: {
          tags: ['Mining'],
          summary: 'Create a new worker',
          description: 'Register a new mining worker',
          operationId: 'createWorker',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', minLength: 1, maxLength: 50 },
                    algorithm: {
                      type: 'string',
                      enum: ['sha256d', 'scrypt', 'ethash', 'randomx', 'kawpow']
                    },
                    password: { type: 'string', minLength: 8 }
                  },
                  required: ['name', 'algorithm']
                }
              }
            }
          },
          responses: {
            '201': {
              description: 'Worker created',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Worker' }
                }
              }
            },
            '400': {
              description: 'Invalid request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' }
                }
              }
            }
          }
        }
      },
      
      '/mining/workers/{workerId}': {
        get: {
          tags: ['Mining'],
          summary: 'Get worker details',
          description: 'Get detailed information about a specific worker',
          operationId: 'getWorker',
          parameters: [
            {
              name: 'workerId',
              in: 'path',
              required: true,
              description: 'Worker ID',
              schema: { type: 'string' }
            }
          ],
          responses: {
            '200': {
              description: 'Worker details',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Worker' }
                }
              }
            },
            '404': {
              description: 'Worker not found',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' }
                }
              }
            }
          }
        },
        
        delete: {
          tags: ['Mining'],
          summary: 'Delete worker',
          description: 'Remove a mining worker',
          operationId: 'deleteWorker',
          parameters: [
            {
              name: 'workerId',
              in: 'path',
              required: true,
              description: 'Worker ID',
              schema: { type: 'string' }
            }
          ],
          responses: {
            '204': {
              description: 'Worker deleted'
            },
            '404': {
              description: 'Worker not found',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' }
                }
              }
            }
          }
        }
      },
      
      '/mining/stats': {
        get: {
          tags: ['Mining', 'Statistics'],
          summary: 'Get mining statistics',
          description: 'Get comprehensive mining statistics for the authenticated user',
          operationId: 'getMiningStats',
          parameters: [
            {
              name: 'period',
              in: 'query',
              description: 'Time period for statistics',
              schema: {
                type: 'string',
                enum: ['1h', '24h', '7d', '30d', 'all'],
                default: '24h'
              }
            }
          ],
          responses: {
            '200': {
              description: 'Mining statistics',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/MiningStats' }
                }
              }
            }
          }
        }
      },
      
      // Pool endpoints
      '/pool/info': {
        get: {
          tags: ['Pool'],
          summary: 'Get pool information',
          description: 'Get general information about the mining pool',
          operationId: 'getPoolInfo',
          responses: {
            '200': {
              description: 'Pool information',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PoolInfo' }
                }
              }
            }
          },
          security: []
        }
      },
      
      // WebSocket documentation
      '/ws': {
        get: {
          tags: ['WebSocket'],
          summary: 'WebSocket connection',
          description: 'Real-time WebSocket connection for mining updates',
          operationId: 'websocket',
          responses: {
            '101': {
              description: 'Switching Protocols',
              headers: {
                Upgrade: {
                  schema: { type: 'string', default: 'websocket' }
                },
                Connection: {
                  schema: { type: 'string', default: 'Upgrade' }
                }
              }
            }
          }
        }
      }
    };
  }
  
  /**
   * Define webhooks
   */
  defineWebhooks() {
    this.documentation.webhooks = {
      'worker.status': {
        post: {
          summary: 'Worker status change',
          description: 'Triggered when a worker status changes',
          operationId: 'workerStatusWebhook',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    event: {
                      type: 'string',
                      enum: ['worker.online', 'worker.offline', 'worker.error']
                    },
                    timestamp: { type: 'string', format: 'date-time' },
                    worker: { $ref: '#/components/schemas/Worker' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Webhook processed successfully'
            }
          }
        }
      },
      
      'block.found': {
        post: {
          summary: 'Block found',
          description: 'Triggered when a new block is found',
          operationId: 'blockFoundWebhook',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    event: { type: 'string', const: 'block.found' },
                    timestamp: { type: 'string', format: 'date-time' },
                    block: {
                      type: 'object',
                      properties: {
                        height: { type: 'integer' },
                        hash: { type: 'string' },
                        reward: { type: 'number' },
                        finder: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Webhook processed successfully'
            }
          }
        }
      }
    };
  }
  
  /**
   * Generate HTML documentation
   */
  async generateHTMLDocumentation(spec) {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${spec.info.title}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@latest/swagger-ui.css">
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    #swagger-ui {
      max-width: 1200px;
      margin: 0 auto;
    }
    .topbar {
      display: none;
    }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@latest/swagger-ui-bundle.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@latest/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      window.ui = SwaggerUIBundle({
        url: './openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout",
        theme: '${this.config.theme}'
      });
    };
  </script>
</body>
</html>
`;
    
    await fs.writeFile(
      join(this.config.outputPath, 'index.html'),
      html
    );
  }
  
  /**
   * Generate markdown documentation
   */
  async generateMarkdownDocumentation(spec) {
    let markdown = `# ${spec.info.title}\n\n`;
    markdown += `**Version:** ${spec.info.version}\n\n`;
    markdown += `${spec.info.description}\n\n`;
    
    // Table of contents
    markdown += '## Table of Contents\n\n';
    markdown += '1. [Authentication](#authentication)\n';
    markdown += '2. [Endpoints](#endpoints)\n';
    markdown += '3. [Schemas](#schemas)\n';
    markdown += '4. [Webhooks](#webhooks)\n';
    markdown += '5. [Examples](#examples)\n\n';
    
    // Authentication section
    markdown += '## Authentication\n\n';
    markdown += 'The API supports multiple authentication methods:\n\n';
    for (const [name, scheme] of Object.entries(spec.components.securitySchemes || {})) {
      markdown += `### ${name}\n\n`;
      markdown += `- **Type:** ${scheme.type}\n`;
      if (scheme.scheme) markdown += `- **Scheme:** ${scheme.scheme}\n`;
      if (scheme.description) markdown += `- **Description:** ${scheme.description}\n`;
      markdown += '\n';
    }
    
    // Endpoints section
    markdown += '## Endpoints\n\n';
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        markdown += `### ${method.toUpperCase()} ${path}\n\n`;
        markdown += `**Summary:** ${operation.summary}\n\n`;
        if (operation.description) {
          markdown += `**Description:** ${operation.description}\n\n`;
        }
        
        // Parameters
        if (operation.parameters && operation.parameters.length > 0) {
          markdown += '**Parameters:**\n\n';
          markdown += '| Name | Type | In | Required | Description |\n';
          markdown += '|------|------|-----|----------|-------------|\n';
          for (const param of operation.parameters) {
            markdown += `| ${param.name} | ${param.schema?.type || 'string'} | ${param.in} | ${param.required ? 'Yes' : 'No'} | ${param.description || ''} |\n`;
          }
          markdown += '\n';
        }
        
        // Request body
        if (operation.requestBody) {
          markdown += '**Request Body:**\n\n';
          const content = operation.requestBody.content['application/json'];
          if (content && content.schema) {
            markdown += '```json\n';
            markdown += JSON.stringify(this.generateExample(content.schema), null, 2);
            markdown += '\n```\n\n';
          }
        }
        
        // Responses
        markdown += '**Responses:**\n\n';
        for (const [status, response] of Object.entries(operation.responses)) {
          markdown += `- **${status}:** ${response.description}\n`;
        }
        markdown += '\n';
      }
    }
    
    // Write markdown file
    await fs.writeFile(
      join(this.config.outputPath, 'API.md'),
      markdown
    );
  }
  
  /**
   * Generate example from schema
   */
  generateExample(schema) {
    if (schema.$ref) {
      const refName = schema.$ref.split('/').pop();
      return this.generateExample(this.documentation.components.schemas[refName]);
    }
    
    switch (schema.type) {
      case 'object':
        const obj = {};
        if (schema.properties) {
          for (const [key, prop] of Object.entries(schema.properties)) {
            obj[key] = this.generateExample(prop);
          }
        }
        return obj;
        
      case 'array':
        return [this.generateExample(schema.items)];
        
      case 'string':
        if (schema.enum) return schema.enum[0];
        if (schema.format === 'date-time') return new Date().toISOString();
        return schema.example || 'string';
        
      case 'number':
      case 'integer':
        return schema.example || (schema.minimum || 0);
        
      case 'boolean':
        return schema.example || true;
        
      default:
        return null;
    }
  }
  
  /**
   * Generate client SDKs
   */
  async generateClientSDKs(spec) {
    // Generate TypeScript types
    await this.generateTypeScriptTypes(spec);
    
    // Generate JavaScript SDK
    await this.generateJavaScriptSDK(spec);
    
    // Generate Python SDK
    await this.generatePythonSDK(spec);
  }
  
  /**
   * Generate TypeScript types
   */
  async generateTypeScriptTypes(spec) {
    let types = '// Auto-generated TypeScript types\n\n';
    
    // Generate interfaces from schemas
    for (const [name, schema] of Object.entries(spec.components.schemas || {})) {
      types += `export interface ${name} ${this.schemaToTypeScript(schema)}\n\n`;
    }
    
    await fs.writeFile(
      join(this.config.outputPath, 'types.d.ts'),
      types
    );
  }
  
  /**
   * Convert schema to TypeScript
   */
  schemaToTypeScript(schema, indent = 0) {
    const indentStr = '  '.repeat(indent);
    
    if (schema.$ref) {
      return schema.$ref.split('/').pop();
    }
    
    switch (schema.type) {
      case 'object':
        let ts = '{\n';
        if (schema.properties) {
          for (const [key, prop] of Object.entries(schema.properties)) {
            const optional = !schema.required?.includes(key) ? '?' : '';
            ts += `${indentStr}  ${key}${optional}: ${this.schemaToTypeScript(prop, indent + 1)};\n`;
          }
        }
        ts += `${indentStr}}`;
        return ts;
        
      case 'array':
        return `${this.schemaToTypeScript(schema.items, indent)}[]`;
        
      case 'string':
        if (schema.enum) {
          return schema.enum.map(v => `'${v}'`).join(' | ');
        }
        return 'string';
        
      case 'number':
      case 'integer':
        return 'number';
        
      case 'boolean':
        return 'boolean';
        
      default:
        return 'any';
    }
  }
  
  /**
   * Generate JavaScript SDK
   */
  async generateJavaScriptSDK(spec) {
    const sdk = `
// Auto-generated JavaScript SDK

class OtedamaAPI {
  constructor(baseURL = '${spec.servers[0].url}', options = {}) {
    this.baseURL = baseURL;
    this.headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };
    this.token = options.token;
  }
  
  setToken(token) {
    this.token = token;
    if (token) {
      this.headers['Authorization'] = \`Bearer \${token}\`;
    } else {
      delete this.headers['Authorization'];
    }
  }
  
  async request(method, path, options = {}) {
    const url = \`\${this.baseURL}\${path}\`;
    const config = {
      method,
      headers: { ...this.headers, ...options.headers },
      ...options
    };
    
    if (options.body && typeof options.body === 'object') {
      config.body = JSON.stringify(options.body);
    }
    
    const response = await fetch(url, config);
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || \`HTTP \${response.status}\`);
    }
    
    return response.json();
  }
  
  // Authentication
  async login(credentials) {
    const result = await this.request('POST', '/auth/login', {
      body: credentials
    });
    
    if (result.token) {
      this.setToken(result.token);
    }
    
    return result;
  }
  
  // Mining
  async getWorkers(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request('GET', \`/mining/workers\${query ? '?' + query : ''}\`);
  }
  
  async createWorker(worker) {
    return this.request('POST', '/mining/workers', { body: worker });
  }
  
  async getWorker(workerId) {
    return this.request('GET', \`/mining/workers/\${workerId}\`);
  }
  
  async deleteWorker(workerId) {
    return this.request('DELETE', \`/mining/workers/\${workerId}\`);
  }
  
  async getMiningStats(period = '24h') {
    return this.request('GET', \`/mining/stats?period=\${period}\`);
  }
  
  // Pool
  async getPoolInfo() {
    return this.request('GET', '/pool/info');
  }
}

export default OtedamaAPI;
`;
    
    await fs.writeFile(
      join(this.config.outputPath, 'otedama-sdk.js'),
      sdk
    );
  }
  
  /**
   * Generate Python SDK
   */
  async generatePythonSDK(spec) {
    const sdk = `
# Auto-generated Python SDK

import requests
from typing import Dict, Any, Optional
from dataclasses import dataclass
import json


class OtedamaAPIError(Exception):
    """API error exception"""
    pass


class OtedamaAPI:
    """Otedama P2P Mining Pool API Client"""
    
    def __init__(self, base_url: str = "${spec.servers[0].url}", token: Optional[str] = None):
        self.base_url = base_url.rstrip('/')
        self.session = requests.Session()
        self.session.headers.update({
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        })
        
        if token:
            self.set_token(token)
    
    def set_token(self, token: Optional[str]):
        """Set authentication token"""
        if token:
            self.session.headers['Authorization'] = f'Bearer {token}'
        else:
            self.session.headers.pop('Authorization', None)
    
    def _request(self, method: str, endpoint: str, **kwargs) -> Dict[str, Any]:
        """Make HTTP request"""
        url = f"{self.base_url}{endpoint}"
        
        response = self.session.request(method, url, **kwargs)
        
        if response.status_code >= 400:
            try:
                error_data = response.json()
                raise OtedamaAPIError(error_data.get('message', f'HTTP {response.status_code}'))
            except json.JSONDecodeError:
                raise OtedamaAPIError(f'HTTP {response.status_code}: {response.text}')
        
        return response.json() if response.content else None
    
    # Authentication
    def login(self, username: str = None, password: str = None, 
              zk_proof: str = None, challenge: str = None) -> Dict[str, Any]:
        """Login to the system"""
        if username and password:
            data = {'username': username, 'password': password}
        elif zk_proof and challenge:
            data = {'zkProof': zk_proof, 'challenge': challenge}
        else:
            raise ValueError("Either username/password or zkProof/challenge required")
        
        result = self._request('POST', '/auth/login', json=data)
        
        if result.get('token'):
            self.set_token(result['token'])
        
        return result
    
    # Mining
    def get_workers(self, status: Optional[str] = None, 
                   page: int = 1, limit: int = 20) -> Dict[str, Any]:
        """List all workers"""
        params = {'page': page, 'limit': limit}
        if status:
            params['status'] = status
        
        return self._request('GET', '/mining/workers', params=params)
    
    def create_worker(self, name: str, algorithm: str, 
                     password: Optional[str] = None) -> Dict[str, Any]:
        """Create a new worker"""
        data = {'name': name, 'algorithm': algorithm}
        if password:
            data['password'] = password
        
        return self._request('POST', '/mining/workers', json=data)
    
    def get_worker(self, worker_id: str) -> Dict[str, Any]:
        """Get worker details"""
        return self._request('GET', f'/mining/workers/{worker_id}')
    
    def delete_worker(self, worker_id: str) -> None:
        """Delete worker"""
        self._request('DELETE', f'/mining/workers/{worker_id}')
    
    def get_mining_stats(self, period: str = '24h') -> Dict[str, Any]:
        """Get mining statistics"""
        return self._request('GET', '/mining/stats', params={'period': period})
    
    # Pool
    def get_pool_info(self) -> Dict[str, Any]:
        """Get pool information"""
        return self._request('GET', '/pool/info')
`;
    
    await fs.writeFile(
      join(this.config.outputPath, 'otedama_sdk.py'),
      sdk
    );
  }
  
  /**
   * Generate AsyncAPI documentation
   */
  async generateAsyncAPIDocumentation() {
    const asyncApiSpec = {
      asyncapi: '2.6.0',
      info: {
        title: `${this.config.title} - WebSocket API`,
        version: this.config.version,
        description: 'Real-time WebSocket API for mining operations'
      },
      servers: {
        development: {
          url: 'ws://localhost:3001',
          protocol: 'ws',
          description: 'Development WebSocket server'
        }
      },
      channels: {
        '/': {
          subscribe: {
            summary: 'Receive real-time updates',
            operationId: 'onMessage',
            message: {
              oneOf: [
                { $ref: '#/components/messages/WorkerUpdate' },
                { $ref: '#/components/messages/HashRateUpdate' },
                { $ref: '#/components/messages/BlockFound' },
                { $ref: '#/components/messages/ShareSubmitted' }
              ]
            }
          },
          publish: {
            summary: 'Send commands',
            operationId: 'sendMessage',
            message: {
              oneOf: [
                { $ref: '#/components/messages/Subscribe' },
                { $ref: '#/components/messages/Unsubscribe' },
                { $ref: '#/components/messages/StartMining' },
                { $ref: '#/components/messages/StopMining' }
              ]
            }
          }
        }
      },
      components: {
        messages: {
          WorkerUpdate: {
            name: 'WorkerUpdate',
            title: 'Worker Status Update',
            summary: 'Updates about worker status changes',
            contentType: 'application/json',
            payload: {
              type: 'object',
              properties: {
                type: { const: 'worker.update' },
                timestamp: { type: 'string', format: 'date-time' },
                data: {
                  type: 'object',
                  properties: {
                    workerId: { type: 'string' },
                    status: { type: 'string', enum: ['online', 'offline', 'error'] },
                    hashrate: { type: 'number' },
                    temperature: { type: 'number' },
                    shares: {
                      type: 'object',
                      properties: {
                        accepted: { type: 'integer' },
                        rejected: { type: 'integer' }
                      }
                    }
                  }
                }
              }
            }
          },
          
          HashRateUpdate: {
            name: 'HashRateUpdate',
            title: 'Hash Rate Update',
            summary: 'Real-time hash rate updates',
            contentType: 'application/json',
            payload: {
              type: 'object',
              properties: {
                type: { const: 'hashrate.update' },
                timestamp: { type: 'string', format: 'date-time' },
                data: {
                  type: 'object',
                  properties: {
                    current: { type: 'number' },
                    average5m: { type: 'number' },
                    average1h: { type: 'number' },
                    workers: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          workerId: { type: 'string' },
                          hashrate: { type: 'number' }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          
          Subscribe: {
            name: 'Subscribe',
            title: 'Subscribe to updates',
            summary: 'Subscribe to specific event types',
            contentType: 'application/json',
            payload: {
              type: 'object',
              properties: {
                action: { const: 'subscribe' },
                events: {
                  type: 'array',
                  items: {
                    type: 'string',
                    enum: ['worker.update', 'hashrate.update', 'block.found', 'share.submitted']
                  }
                }
              }
            }
          }
        }
      }
    };
    
    await fs.writeFile(
      join(this.config.outputPath, 'asyncapi.json'),
      JSON.stringify(asyncApiSpec, null, 2)
    );
  }
  
  /**
   * Get statistics
   */
  getStatistics() {
    return {
      endpoints: Object.keys(this.documentation.paths).length,
      schemas: Object.keys(this.documentation.components.schemas).length,
      tags: this.documentation.tags.length,
      webhooks: Object.keys(this.documentation.webhooks || {}).length
    };
  }
}

/**
 * Factory function
 */
export function createAPIDocumentation(config) {
  return new APIDocumentationGenerator(config);
}

export default APIDocumentationGenerator;