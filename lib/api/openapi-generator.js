/**
 * OpenAPI Documentation Generator
 * Automatically generates OpenAPI 3.0 specifications from route definitions
 */

import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import { getLogger } from '../core/logger.js';

// HTTP method types
export const HTTPMethods = {
    GET: 'get',
    POST: 'post',
    PUT: 'put',
    DELETE: 'delete',
    PATCH: 'patch',
    HEAD: 'head',
    OPTIONS: 'options'
};

// Parameter types
export const ParameterTypes = {
    QUERY: 'query',
    PATH: 'path',
    HEADER: 'header',
    COOKIE: 'cookie'
};

// Schema types
export const SchemaTypes = {
    STRING: 'string',
    NUMBER: 'number',
    INTEGER: 'integer',
    BOOLEAN: 'boolean',
    ARRAY: 'array',
    OBJECT: 'object'
};

export class OpenAPIGenerator extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.logger = getLogger('OpenAPIGenerator');
        this.options = {
            // API metadata
            title: options.title || 'Otedama API',
            version: options.version || '1.0.0',
            description: options.description || 'Otedama P2P Mining Pool and DEX API',
            
            // Server configuration
            servers: options.servers || [
                {
                    url: 'http://localhost:3000',
                    description: 'Development server'
                },
                {
                    url: 'https://api.otedama.io',
                    description: 'Production server'
                }
            ],
            
            // Documentation settings
            outputDir: options.outputDir || './docs/api',
            outputFormats: options.outputFormats || ['json', 'yaml', 'html'],
            includeExamples: options.includeExamples !== false,
            includeSchemas: options.includeSchemas !== false,
            
            // Security schemes
            securitySchemes: options.securitySchemes || {
                ApiKeyAuth: {
                    type: 'apiKey',
                    in: 'header',
                    name: 'X-API-Key'
                },
                BearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT'
                }
            },
            
            // Tags for grouping
            tags: options.tags || [
                { name: 'Mining', description: 'Mining pool operations' },
                { name: 'DEX', description: 'Decentralized exchange operations' },
                { name: 'P2P', description: 'Peer-to-peer network operations' },
                { name: 'Auth', description: 'Authentication and authorization' },
                { name: 'Admin', description: 'Administrative operations' }
            ],
            
            ...options
        };
        
        // API specification
        this.specification = {
            openapi: '3.0.3',
            info: {
                title: this.options.title,
                version: this.options.version,
                description: this.options.description,
                contact: {
                    name: 'Otedama Team',
                    email: 'api@otedama.io',
                    url: 'https://otedama.io'
                },
                license: {
                    name: 'MIT',
                    url: 'https://opensource.org/licenses/MIT'
                }
            },
            servers: this.options.servers,
            tags: this.options.tags,
            paths: {},
            components: {
                schemas: {},
                securitySchemes: this.options.securitySchemes,
                parameters: {},
                responses: {},
                examples: {},
                requestBodies: {},
                headers: {}
            },
            security: [
                { ApiKeyAuth: [] },
                { BearerAuth: [] }
            ]
        };
        
        // Route registry
        this.routes = new Map();
        this.schemas = new Map();
        this.examples = new Map();
        
        // Initialize common schemas
        this.initializeCommonSchemas();
    }
    
    /**
     * Initialize common API schemas
     */
    initializeCommonSchemas() {
        // Error response schema
        this.addSchema('Error', {
            type: 'object',
            required: ['error', 'message'],
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
            example: {
                error: 'VALIDATION_ERROR',
                message: 'Invalid request parameters',
                details: {
                    field: 'amount',
                    reason: 'must be positive'
                },
                timestamp: '2024-01-01T00:00:00Z'
            }
        });
        
        // Success response schema
        this.addSchema('Success', {
            type: 'object',
            required: ['success', 'data'],
            properties: {
                success: {
                    type: 'boolean',
                    description: 'Operation success flag'
                },
                data: {
                    type: 'object',
                    description: 'Response data'
                },
                timestamp: {
                    type: 'string',
                    format: 'date-time',
                    description: 'Response timestamp'
                }
            }
        });
        
        // Pagination schema
        this.addSchema('Pagination', {
            type: 'object',
            properties: {
                page: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Current page number'
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 100,
                    description: 'Items per page'
                },
                total: {
                    type: 'integer',
                    description: 'Total number of items'
                },
                totalPages: {
                    type: 'integer',
                    description: 'Total number of pages'
                },
                hasNext: {
                    type: 'boolean',
                    description: 'Whether there are more pages'
                },
                hasPrev: {
                    type: 'boolean',
                    description: 'Whether there are previous pages'
                }
            }
        });
        
        // Mining-related schemas
        this.initializeMiningSchemas();
        
        // DEX-related schemas
        this.initializeDEXSchemas();
        
        // P2P-related schemas
        this.initializeP2PSchemas();
    }
    
    /**
     * Initialize mining-related schemas
     */
    initializeMiningSchemas() {
        this.addSchema('Miner', {
            type: 'object',
            required: ['id', 'username', 'hashrate'],
            properties: {
                id: {
                    type: 'string',
                    description: 'Miner unique identifier'
                },
                username: {
                    type: 'string',
                    description: 'Miner username'
                },
                workerName: {
                    type: 'string',
                    description: 'Worker name'
                },
                hashrate: {
                    type: 'number',
                    description: 'Current hashrate in H/s'
                },
                sharesSubmitted: {
                    type: 'integer',
                    description: 'Total shares submitted'
                },
                sharesAccepted: {
                    type: 'integer',
                    description: 'Total shares accepted'
                },
                lastShareTime: {
                    type: 'string',
                    format: 'date-time',
                    description: 'Last share submission time'
                },
                connected: {
                    type: 'boolean',
                    description: 'Connection status'
                }
            }
        });
        
        this.addSchema('MiningJob', {
            type: 'object',
            required: ['jobId', 'prevHash', 'merkleRoot', 'target'],
            properties: {
                jobId: {
                    type: 'string',
                    description: 'Job identifier'
                },
                prevHash: {
                    type: 'string',
                    description: 'Previous block hash'
                },
                merkleRoot: {
                    type: 'string',
                    description: 'Merkle root hash'
                },
                target: {
                    type: 'string',
                    description: 'Mining target'
                },
                difficulty: {
                    type: 'number',
                    description: 'Mining difficulty'
                },
                timestamp: {
                    type: 'string',
                    format: 'date-time',
                    description: 'Job creation time'
                }
            }
        });
        
        this.addSchema('Share', {
            type: 'object',
            required: ['minerId', 'jobId', 'nonce', 'hash'],
            properties: {
                minerId: {
                    type: 'string',
                    description: 'Miner identifier'
                },
                jobId: {
                    type: 'string',
                    description: 'Job identifier'
                },
                nonce: {
                    type: 'string',
                    description: 'Nonce value'
                },
                hash: {
                    type: 'string',
                    description: 'Share hash'
                },
                difficulty: {
                    type: 'number',
                    description: 'Share difficulty'
                },
                valid: {
                    type: 'boolean',
                    description: 'Share validity'
                },
                submittedAt: {
                    type: 'string',
                    format: 'date-time',
                    description: 'Submission time'
                }
            }
        });
    }
    
    /**
     * Initialize DEX-related schemas
     */
    initializeDEXSchemas() {
        this.addSchema('TradingPair', {
            type: 'object',
            required: ['symbol', 'baseToken', 'quoteToken'],
            properties: {
                symbol: {
                    type: 'string',
                    description: 'Trading pair symbol (e.g., ETH/USDC)'
                },
                baseToken: {
                    type: 'string',
                    description: 'Base token symbol'
                },
                quoteToken: {
                    type: 'string',
                    description: 'Quote token symbol'
                },
                price: {
                    type: 'number',
                    description: 'Current price'
                },
                volume24h: {
                    type: 'number',
                    description: '24-hour trading volume'
                },
                priceChange24h: {
                    type: 'number',
                    description: '24-hour price change percentage'
                }
            }
        });
        
        this.addSchema('Order', {
            type: 'object',
            required: ['id', 'pair', 'type', 'side', 'amount'],
            properties: {
                id: {
                    type: 'string',
                    description: 'Order identifier'
                },
                pair: {
                    type: 'string',
                    description: 'Trading pair'
                },
                type: {
                    type: 'string',
                    enum: ['market', 'limit', 'stop-loss'],
                    description: 'Order type'
                },
                side: {
                    type: 'string',
                    enum: ['buy', 'sell'],
                    description: 'Order side'
                },
                amount: {
                    type: 'number',
                    description: 'Order amount'
                },
                price: {
                    type: 'number',
                    description: 'Order price (for limit orders)'
                },
                filled: {
                    type: 'number',
                    description: 'Filled amount'
                },
                status: {
                    type: 'string',
                    enum: ['pending', 'filled', 'cancelled'],
                    description: 'Order status'
                },
                createdAt: {
                    type: 'string',
                    format: 'date-time',
                    description: 'Order creation time'
                }
            }
        });
        
        this.addSchema('LiquidityPosition', {
            type: 'object',
            required: ['id', 'pair', 'liquidity'],
            properties: {
                id: {
                    type: 'string',
                    description: 'Position identifier'
                },
                pair: {
                    type: 'string',
                    description: 'Trading pair'
                },
                liquidity: {
                    type: 'number',
                    description: 'Liquidity amount'
                },
                token0Amount: {
                    type: 'number',
                    description: 'Token0 amount'
                },
                token1Amount: {
                    type: 'number',
                    description: 'Token1 amount'
                },
                feesEarned: {
                    type: 'number',
                    description: 'Fees earned'
                },
                createdAt: {
                    type: 'string',
                    format: 'date-time',
                    description: 'Position creation time'
                }
            }
        });
    }
    
    /**
     * Initialize P2P-related schemas
     */
    initializeP2PSchemas() {
        this.addSchema('Peer', {
            type: 'object',
            required: ['nodeId', 'host', 'port'],
            properties: {
                nodeId: {
                    type: 'string',
                    description: 'Peer node identifier'
                },
                host: {
                    type: 'string',
                    description: 'Peer IP address'
                },
                port: {
                    type: 'integer',
                    description: 'Peer port number'
                },
                type: {
                    type: 'string',
                    enum: ['miner', 'trader', 'validator', 'relay'],
                    description: 'Peer type'
                },
                connected: {
                    type: 'boolean',
                    description: 'Connection status'
                },
                lastSeen: {
                    type: 'string',
                    format: 'date-time',
                    description: 'Last seen time'
                },
                reputation: {
                    type: 'integer',
                    description: 'Peer reputation score'
                }
            }
        });
        
        this.addSchema('NetworkStats', {
            type: 'object',
            properties: {
                totalPeers: {
                    type: 'integer',
                    description: 'Total number of peers'
                },
                activePeers: {
                    type: 'integer',
                    description: 'Number of active peers'
                },
                totalHashrate: {
                    type: 'number',
                    description: 'Total network hashrate'
                },
                blockHeight: {
                    type: 'integer',
                    description: 'Current block height'
                },
                difficulty: {
                    type: 'number',
                    description: 'Current mining difficulty'
                },
                networkVersion: {
                    type: 'string',
                    description: 'Network protocol version'
                }
            }
        });
    }
    
    /**
     * Register API route
     */
    addRoute(method, path, definition) {
        const routeKey = `${method.toUpperCase()} ${path}`;
        
        const routeDefinition = {
            method: method.toLowerCase(),
            path,
            summary: definition.summary || '',
            description: definition.description || '',
            tags: definition.tags || [],
            parameters: definition.parameters || [],
            requestBody: definition.requestBody || null,
            responses: definition.responses || {
                '200': {
                    description: 'Success',
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/Success' }
                        }
                    }
                },
                '400': {
                    description: 'Bad Request',
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/Error' }
                        }
                    }
                },
                '401': {
                    description: 'Unauthorized',
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/Error' }
                        }
                    }
                },
                '500': {
                    description: 'Internal Server Error',
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/Error' }
                        }
                    }
                }
            },
            security: definition.security || [],
            deprecated: definition.deprecated || false,
            operationId: definition.operationId || this.generateOperationId(method, path)
        };
        
        this.routes.set(routeKey, routeDefinition);
        
        this.logger.debug(`Route registered: ${routeKey}`);
    }
    
    /**
     * Add schema definition
     */
    addSchema(name, schema) {
        this.schemas.set(name, schema);
        this.specification.components.schemas[name] = schema;
    }
    
    /**
     * Add example
     */
    addExample(name, example) {
        this.examples.set(name, example);
        this.specification.components.examples[name] = example;
    }
    
    /**
     * Generate operation ID from method and path
     */
    generateOperationId(method, path) {
        const cleanPath = path
            .replace(/\{([^}]+)\}/g, 'By$1') // {id} -> ById
            .replace(/[^a-zA-Z0-9]/g, '') // Remove special chars
            .replace(/^./, char => char.toLowerCase()); // Lowercase first char
        
        return method.toLowerCase() + cleanPath.charAt(0).toUpperCase() + cleanPath.slice(1);
    }
    
    /**
     * Build OpenAPI specification
     */
    buildSpecification() {
        // Clear existing paths
        this.specification.paths = {};
        
        // Group routes by path
        const pathGroups = new Map();
        
        for (const [routeKey, route] of this.routes) {
            if (!pathGroups.has(route.path)) {
                pathGroups.set(route.path, {});
            }
            
            const pathObject = pathGroups.get(route.path);
            pathObject[route.method] = {
                summary: route.summary,
                description: route.description,
                tags: route.tags,
                operationId: route.operationId,
                parameters: route.parameters,
                responses: route.responses,
                security: route.security.length > 0 ? route.security : undefined,
                deprecated: route.deprecated || undefined
            };
            
            if (route.requestBody) {
                pathObject[route.method].requestBody = route.requestBody;
            }
        }
        
        // Add paths to specification
        for (const [path, pathObject] of pathGroups) {
            this.specification.paths[path] = pathObject;
        }
        
        this.logger.info(`OpenAPI specification built with ${this.routes.size} routes`);
        
        return this.specification;
    }
    
    /**
     * Register default API routes
     */
    registerDefaultRoutes() {
        // Mining routes
        this.addRoute('GET', '/api/v1/mining/stats', {
            summary: 'Get mining statistics',
            description: 'Retrieve comprehensive mining pool statistics',
            tags: ['Mining'],
            responses: {
                '200': {
                    description: 'Mining statistics',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    hashrate: { type: 'number' },
                                    miners: { type: 'integer' },
                                    blocksFound: { type: 'integer' },
                                    difficulty: { type: 'number' }
                                }
                            }
                        }
                    }
                }
            }
        });
        
        this.addRoute('GET', '/api/v1/mining/miners', {
            summary: 'List miners',
            description: 'Get list of connected miners',
            tags: ['Mining'],
            parameters: [
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
                    description: 'List of miners',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    miners: {
                                        type: 'array',
                                        items: { $ref: '#/components/schemas/Miner' }
                                    },
                                    pagination: { $ref: '#/components/schemas/Pagination' }
                                }
                            }
                        }
                    }
                }
            }
        });
        
        // DEX routes
        this.addRoute('GET', '/api/v1/dex/pairs', {
            summary: 'List trading pairs',
            description: 'Get all available trading pairs',
            tags: ['DEX'],
            responses: {
                '200': {
                    description: 'Trading pairs',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'array',
                                items: { $ref: '#/components/schemas/TradingPair' }
                            }
                        }
                    }
                }
            }
        });
        
        this.addRoute('POST', '/api/v1/dex/orders', {
            summary: 'Place order',
            description: 'Place a new trading order',
            tags: ['DEX'],
            security: [{ ApiKeyAuth: [] }],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['pair', 'type', 'side', 'amount'],
                            properties: {
                                pair: { type: 'string', example: 'ETH/USDC' },
                                type: { type: 'string', enum: ['market', 'limit'] },
                                side: { type: 'string', enum: ['buy', 'sell'] },
                                amount: { type: 'number', minimum: 0 },
                                price: { type: 'number', minimum: 0 }
                            }
                        }
                    }
                }
            },
            responses: {
                '201': {
                    description: 'Order placed',
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/Order' }
                        }
                    }
                }
            }
        });
        
        // P2P routes
        this.addRoute('GET', '/api/v1/p2p/peers', {
            summary: 'List peers',
            description: 'Get list of connected peers',
            tags: ['P2P'],
            responses: {
                '200': {
                    description: 'Connected peers',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'array',
                                items: { $ref: '#/components/schemas/Peer' }
                            }
                        }
                    }
                }
            }
        });
        
        this.addRoute('GET', '/api/v1/p2p/network', {
            summary: 'Network statistics',
            description: 'Get P2P network statistics',
            tags: ['P2P'],
            responses: {
                '200': {
                    description: 'Network statistics',
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/NetworkStats' }
                        }
                    }
                }
            }
        });
        
        // Authentication routes
        this.addRoute('POST', '/api/v1/auth/login', {
            summary: 'Login',
            description: 'Authenticate user and get access token',
            tags: ['Auth'],
            requestBody: {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['username', 'password'],
                            properties: {
                                username: { type: 'string' },
                                password: { type: 'string', format: 'password' }
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
                }
            }
        });
        
        this.logger.info('Default API routes registered');
    }
    
    /**
     * Generate documentation files
     */
    async generateDocumentation() {
        this.logger.info('Generating API documentation...');
        
        // Build specification
        const spec = this.buildSpecification();
        
        // Ensure output directory exists
        await fs.mkdir(this.options.outputDir, { recursive: true });
        
        // Generate different formats
        const promises = [];
        
        if (this.options.outputFormats.includes('json')) {
            promises.push(this.generateJSON(spec));
        }
        
        if (this.options.outputFormats.includes('yaml')) {
            promises.push(this.generateYAML(spec));
        }
        
        if (this.options.outputFormats.includes('html')) {
            promises.push(this.generateHTML(spec));
        }
        
        await Promise.all(promises);
        
        this.logger.info(`Documentation generated in ${this.options.outputDir}`);
        this.emit('documentationGenerated', {
            outputDir: this.options.outputDir,
            formats: this.options.outputFormats
        });
    }
    
    /**
     * Generate JSON documentation
     */
    async generateJSON(spec) {
        const filePath = path.join(this.options.outputDir, 'openapi.json');
        await fs.writeFile(filePath, JSON.stringify(spec, null, 2));
        this.logger.debug('JSON documentation generated');
    }
    
    /**
     * Generate YAML documentation
     */
    async generateYAML(spec) {
        const filePath = path.join(this.options.outputDir, 'openapi.yaml');
        const yamlContent = yaml.dump(spec, { indent: 2 });
        await fs.writeFile(filePath, yamlContent);
        this.logger.debug('YAML documentation generated');
    }
    
    /**
     * Generate HTML documentation
     */
    async generateHTML(spec) {
        const filePath = path.join(this.options.outputDir, 'index.html');
        
        const htmlContent = `<!DOCTYPE html>
<html>
<head>
    <title>${this.options.title} - API Documentation</title>
    <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@3.52.5/swagger-ui.css" />
    <style>
        html {
            box-sizing: border-box;
            overflow: -moz-scrollbars-vertical;
            overflow-y: scroll;
        }
        *, *:before, *:after {
            box-sizing: inherit;
        }
        body {
            margin:0;
            background: #fafafa;
        }
    </style>
</head>
<body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@3.52.5/swagger-ui-bundle.js"></script>
    <script src="https://unpkg.com/swagger-ui-dist@3.52.5/swagger-ui-standalone-preset.js"></script>
    <script>
        window.onload = function() {
            const ui = SwaggerUIBundle({
                spec: ${JSON.stringify(spec)},
                dom_id: '#swagger-ui',
                deepLinking: true,
                presets: [
                    SwaggerUIBundle.presets.apis,
                    SwaggerUIStandalonePreset
                ],
                plugins: [
                    SwaggerUIBundle.plugins.DownloadUrl
                ],
                layout: "StandaloneLayout"
            });
        }
    </script>
</body>
</html>`;
        
        await fs.writeFile(filePath, htmlContent);
        this.logger.debug('HTML documentation generated');
    }
    
    /**
     * Generate documentation from Express app
     */
    async generateFromExpressApp(app) {
        this.logger.info('Generating documentation from Express app...');
        
        // Extract routes from Express app
        const routes = this.extractExpressRoutes(app);
        
        for (const route of routes) {
            this.addRoute(route.method, route.path, route.definition);
        }
        
        await this.generateDocumentation();
    }
    
    /**
     * Extract routes from Express app
     */
    extractExpressRoutes(app) {
        const routes = [];
        
        // This is a simplified implementation
        // In practice, would need to traverse Express router stack
        if (app._router && app._router.stack) {
            for (const layer of app._router.stack) {
                if (layer.route) {
                    const route = layer.route;
                    const path = route.path;
                    
                    for (const method of Object.keys(route.methods)) {
                        routes.push({
                            method: method.toUpperCase(),
                            path,
                            definition: {
                                summary: `${method.toUpperCase()} ${path}`,
                                description: `Auto-generated documentation for ${method.toUpperCase()} ${path}`,
                                tags: [this.guessTagFromPath(path)]
                            }
                        });
                    }
                }
            }
        }
        
        return routes;
    }
    
    /**
     * Guess tag from path
     */
    guessTagFromPath(path) {
        if (path.includes('/mining')) return 'Mining';
        if (path.includes('/dex')) return 'DEX';
        if (path.includes('/p2p')) return 'P2P';
        if (path.includes('/auth')) return 'Auth';
        if (path.includes('/admin')) return 'Admin';
        return 'General';
    }
    
    /**
     * Validate OpenAPI specification
     */
    validateSpecification() {
        const spec = this.buildSpecification();
        const errors = [];
        
        // Basic validation
        if (!spec.info.title) {
            errors.push('Missing API title');
        }
        
        if (!spec.info.version) {
            errors.push('Missing API version');
        }
        
        if (Object.keys(spec.paths).length === 0) {
            errors.push('No paths defined');
        }
        
        // Validate each path
        for (const [path, pathItem] of Object.entries(spec.paths)) {
            for (const [method, operation] of Object.entries(pathItem)) {
                if (!operation.responses) {
                    errors.push(`Missing responses for ${method.toUpperCase()} ${path}`);
                }
                
                if (!operation.responses['200'] && !operation.responses['201']) {
                    errors.push(`Missing success response for ${method.toUpperCase()} ${path}`);
                }
            }
        }
        
        if (errors.length > 0) {
            this.logger.warn('OpenAPI specification validation errors:', errors);
        } else {
            this.logger.info('OpenAPI specification validation passed');
        }
        
        return {
            valid: errors.length === 0,
            errors
        };
    }
    
    /**
     * Get specification summary
     */
    getSpecificationSummary() {
        const spec = this.buildSpecification();
        
        const summary = {
            title: spec.info.title,
            version: spec.info.version,
            paths: Object.keys(spec.paths).length,
            operations: 0,
            schemas: Object.keys(spec.components.schemas).length,
            tags: spec.tags.map(tag => tag.name)
        };
        
        // Count operations
        for (const pathItem of Object.values(spec.paths)) {
            summary.operations += Object.keys(pathItem).length;
        }
        
        return summary;
    }
}

export default OpenAPIGenerator;