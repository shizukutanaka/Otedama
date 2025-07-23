/**
 * API Documentation Generator
 * 
 * Automatic API documentation generation from code annotations and runtime analysis
 * Following Carmack's performance-first with Martin's clean architecture
 */

import { EventEmitter } from 'events';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, extname } from 'path';
import { createHash } from 'crypto';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../core/standardized-error-handler.js';

export class APIDocumentationGenerator extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Source scanning
      sourceDirectory: options.sourceDirectory || './api',
      routesDirectory: options.routesDirectory || './routes',
      controllersDirectory: options.controllersDirectory || './controllers',
      modelsDirectory: options.modelsDirectory || './models',
      
      // Output options
      outputDirectory: options.outputDirectory || './docs/api',
      enableOpenAPI: options.enableOpenAPI !== false,
      enableMarkdown: options.enableMarkdown !== false,
      enableHTML: options.enableHTML !== false,
      enablePostman: options.enablePostman !== false,
      
      // Generation options
      enableCodeAnalysis: options.enableCodeAnalysis !== false,
      enableRuntimeAnalysis: options.enableRuntimeAnalysis !== false,
      enableValidation: options.enableValidation !== false,
      enableExamples: options.enableExamples !== false,
      
      // API metadata
      title: options.title || 'Otedama API',
      version: options.version || '1.0.0',
      description: options.description || 'Advanced P2P Mining Pool and DEX API',
      baseUrl: options.baseUrl || 'http://localhost:3000',
      
      // Advanced features
      enableVersioning: options.enableVersioning !== false,
      enableDeprecation: options.enableDeprecation !== false,
      enableSecurity: options.enableSecurity !== false,
      enableMetrics: options.enableMetrics !== false,
      
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.endpoints = new Map();
    this.schemas = new Map();
    this.routeRegistry = new Map();
    this.securitySchemes = new Map();
    
    // Documentation metadata
    this.metadata = {
      title: this.options.title,
      version: this.options.version,
      description: this.options.description,
      baseUrl: this.options.baseUrl,
      generatedAt: null,
      totalEndpoints: 0,
      documented: 0,
      undocumented: 0
    };
    
    // Performance tracking
    this.metrics = {
      scanTime: 0,
      analysisTime: 0,
      generationTime: 0,
      filesScanned: 0,
      endpointsFound: 0,
      errorsEncountered: 0
    };
    
    this.initialize();
  }
  
  /**
   * Initialize documentation generator
   */
  async initialize() {
    try {
      // Ensure output directory exists
      if (!existsSync(this.options.outputDirectory)) {
        await mkdir(this.options.outputDirectory, { recursive: true });
      }
      
      // Initialize security schemes
      this.initializeSecuritySchemes();
      
      this.emit('initialized');
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'api-docs-generator',
        category: ErrorCategory.INITIALIZATION
      });
    }
  }
  
  /**
   * Generate complete API documentation
   */
  async generateDocumentation(options = {}) {
    const startTime = performance.now();
    
    try {
      console.log('Starting API documentation generation...');
      
      // Step 1: Scan source files
      await this.scanSourceFiles();
      
      // Step 2: Analyze code structure
      if (this.options.enableCodeAnalysis) {
        await this.analyzeCodeStructure();
      }
      
      // Step 3: Generate OpenAPI specification
      if (this.options.enableOpenAPI) {
        await this.generateOpenAPISpec();
      }
      
      // Step 4: Generate Markdown documentation
      if (this.options.enableMarkdown) {
        await this.generateMarkdownDocs();
      }
      
      // Step 5: Generate HTML documentation
      if (this.options.enableHTML) {
        await this.generateHTMLDocs();
      }
      
      // Step 6: Generate Postman collection
      if (this.options.enablePostman) {
        await this.generatePostmanCollection();
      }
      
      // Step 7: Generate metrics report
      if (this.options.enableMetrics) {
        await this.generateMetricsReport();
      }
      
      // Update metadata
      this.metadata.generatedAt = new Date().toISOString();
      this.metadata.totalEndpoints = this.endpoints.size;
      this.metadata.documented = Array.from(this.endpoints.values())
        .filter(endpoint => endpoint.documented).length;
      this.metadata.undocumented = this.metadata.totalEndpoints - this.metadata.documented;
      
      this.metrics.generationTime = performance.now() - startTime;
      
      this.emit('documentation:generated', {
        metadata: this.metadata,
        metrics: this.metrics
      });
      
      console.log(`API documentation generated in ${this.metrics.generationTime.toFixed(2)}ms`);
      console.log(`Found ${this.metadata.totalEndpoints} endpoints (${this.metadata.documented} documented)`);
      
      return {
        success: true,
        metadata: this.metadata,
        metrics: this.metrics
      };
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'api-docs-generator',
        category: ErrorCategory.GENERATION
      });
      throw error;
    }
  }
  
  /**
   * Scan source files for API endpoints
   */
  async scanSourceFiles() {
    const startTime = performance.now();
    
    try {
      const directories = [
        this.options.sourceDirectory,
        this.options.routesDirectory,
        this.options.controllersDirectory
      ];
      
      for (const directory of directories) {
        if (existsSync(directory)) {
          await this.scanDirectory(directory);
        }
      }
      
      this.metrics.scanTime = performance.now() - startTime;
      this.emit('scan:completed', { 
        filesScanned: this.metrics.filesScanned,
        endpointsFound: this.metrics.endpointsFound
      });
      
    } catch (error) {
      this.metrics.errorsEncountered++;
      throw error;
    }
  }
  
  /**
   * Scan directory for JavaScript/TypeScript files
   */
  async scanDirectory(directory) {
    const { readdir, stat } = await import('fs/promises');
    
    try {
      const items = await readdir(directory);
      
      for (const item of items) {
        const fullPath = join(directory, item);
        const stats = await stat(fullPath);
        
        if (stats.isDirectory()) {
          await this.scanDirectory(fullPath);
        } else if (this.isSourceFile(fullPath)) {
          await this.scanSourceFile(fullPath);
        }
      }
    } catch (error) {
      // Ignore directory access errors
    }
  }
  
  /**
   * Check if file is a source file
   */
  isSourceFile(filePath) {
    const validExtensions = ['.js', '.ts', '.mjs'];
    return validExtensions.includes(extname(filePath));
  }
  
  /**
   * Scan individual source file
   */
  async scanSourceFile(filePath) {
    try {
      this.metrics.filesScanned++;
      
      const content = await readFile(filePath, 'utf8');
      
      // Parse with Babel
      const ast = parse(content, {
        sourceType: 'module',
        plugins: ['typescript', 'decorators-legacy']
      });
      
      // Extract endpoints from AST
      const endpoints = this.extractEndpointsFromAST(ast, filePath);
      
      // Store endpoints
      endpoints.forEach(endpoint => {
        this.endpoints.set(endpoint.id, endpoint);
        this.metrics.endpointsFound++;
      });
      
    } catch (error) {
      this.metrics.errorsEncountered++;
      console.warn(`Error scanning ${filePath}:`, error.message);
    }
  }
  
  /**
   * Extract API endpoints from AST
   */
  extractEndpointsFromAST(ast, filePath) {
    const endpoints = [];
    
    const self = this;
    traverse.default(ast, {
      // Express route definitions: app.get(), router.post(), etc.
      CallExpression(path) {
        const { node } = path;
        
        if (self.isRouteDefinition(node)) {
          const endpoint = self.parseRouteDefinition(node, filePath);
          if (endpoint) {
            endpoints.push(endpoint);
          }
        }
      }
    });
    
    return endpoints;
  }
  
  /**
   * Check if node is a route definition
   */
  isRouteDefinition(node) {
    const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
    
    return node.type === 'CallExpression' &&
           node.callee.type === 'MemberExpression' &&
           node.callee.property.type === 'Identifier' &&
           httpMethods.includes(node.callee.property.name.toLowerCase()) &&
           node.arguments.length >= 2;
  }
  
  /**
   * Parse route definition from AST node
   */
  parseRouteDefinition(node, filePath) {
    try {
      const method = node.callee.property.name.toUpperCase();
      const pathArg = node.arguments[0];
      
      if (pathArg.type !== 'Literal') return null;
      
      const path = pathArg.value;
      const id = this.generateEndpointId(method, path);
      
      const endpoint = {
        id,
        method,
        path,
        filePath,
        handler: null,
        middleware: [],
        parameters: [],
        responses: new Map(),
        tags: [],
        summary: '',
        description: '',
        security: [],
        deprecated: false,
        documented: false,
        examples: [],
        line: node.loc?.start.line || 0
      };
      
      // Extract handler function
      const handlerArg = node.arguments[node.arguments.length - 1];
      if (handlerArg.type === 'FunctionExpression' || handlerArg.type === 'ArrowFunctionExpression') {
        endpoint.handler = this.analyzeFunctionHandler(handlerArg);
      }
      
      // Extract middleware
      for (let i = 1; i < node.arguments.length - 1; i++) {
        const middlewareArg = node.arguments[i];
        if (middlewareArg.type === 'Identifier') {
          endpoint.middleware.push(middlewareArg.name);
        }
      }
      
      // Extract path parameters
      endpoint.parameters = this.extractPathParameters(path);
      
      return endpoint;
      
    } catch (error) {
      console.warn('Error parsing route definition:', error.message);
      return null;
    }
  }
  
  /**
   * Analyze function handler for additional metadata
   */
  analyzeFunctionHandler(node) {
    const handler = {
      async: node.async || false,
      params: [],
      returnType: null,
      usesDatabase: false,
      usesCache: false,
      usesValidation: false
    };
    
    // Extract parameter names
    node.params.forEach(param => {
      if (param.type === 'Identifier') {
        handler.params.push(param.name);
      }
    });
    
    // Analyze function body for patterns
    if (node.body.type === 'BlockStatement') {
      traverse.default(node, {
        CallExpression(path) {
          const callee = path.node.callee;
          
          // Check for database usage
          if (callee.type === 'MemberExpression' && 
              (callee.property.name === 'query' || 
               callee.property.name === 'findOne' || 
               callee.property.name === 'save')) {
            handler.usesDatabase = true;
          }
          
          // Check for cache usage
          if (callee.type === 'MemberExpression' && 
              (callee.property.name === 'get' || 
               callee.property.name === 'set') &&
              callee.object.name === 'cache') {
            handler.usesCache = true;
          }
          
          // Check for validation
          if (callee.type === 'MemberExpression' && 
              callee.property.name === 'validate') {
            handler.usesValidation = true;
          }
        }
      });
    }
    
    return handler;
  }
  
  /**
   * Extract path parameters from route path
   */
  extractPathParameters(path) {
    const parameters = [];
    const paramPattern = /:([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
    let match;
    
    while ((match = paramPattern.exec(path)) !== null) {
      parameters.push({
        name: match[1],
        in: 'path',
        required: true,
        type: 'string',
        description: `Path parameter: ${match[1]}`
      });
    }
    
    return parameters;
  }
  
  /**
   * Parse API documentation from comments
   */
  parseAPIComment(comment) {
    const apiDoc = {
      documented: true
    };
    
    // Parse @api tags
    const apiPattern = /@api\s*\{(\w+)\}\s*(\S+)?\s*(.*)/;
    const match = comment.match(apiPattern);
    
    if (match) {
      apiDoc.method = match[1].toUpperCase();
      apiDoc.path = match[2];
      apiDoc.summary = match[3];
    }
    
    // Parse other JSDoc tags
    const patterns = {
      summary: /@summary\s+(.*)/,
      description: /@description\s+(.*)/,
      param: /@param\s+\{([^}]+)\}\s+(\w+)\s*(.*)/,
      returns: /@returns?\s+\{([^}]+)\}\s*(.*)/,
      example: /@example\s+([\s\S]*?)(?=@|\*\/|$)/,
      deprecated: /@deprecated/,
      security: /@security\s+(.*)/,
      tag: /@tag\s+(.*)/
    };
    
    Object.entries(patterns).forEach(([key, pattern]) => {
      const matches = comment.match(pattern);
      if (matches) {
        switch (key) {
          case 'param':
            if (!apiDoc.parameters) apiDoc.parameters = [];
            apiDoc.parameters.push({
              name: matches[2],
              type: matches[1],
              description: matches[3] || ''
            });
            break;
          case 'returns':
            apiDoc.responses = new Map([['200', {
              description: matches[2] || 'Success',
              schema: { type: matches[1] }
            }]]);
            break;
          case 'example':
            if (!apiDoc.examples) apiDoc.examples = [];
            apiDoc.examples.push(matches[1].trim());
            break;
          case 'deprecated':
            apiDoc.deprecated = true;
            break;
          case 'tag':
            if (!apiDoc.tags) apiDoc.tags = [];
            apiDoc.tags.push(matches[1]);
            break;
          default:
            apiDoc[key] = matches[1];
        }
      }
    });
    
    return apiDoc;
  }
  
  /**
   * Analyze code structure for schema definitions
   */
  async analyzeCodeStructure() {
    const startTime = performance.now();
    
    try {
      // Scan models directory for schema definitions
      if (existsSync(this.options.modelsDirectory)) {
        await this.scanModelsDirectory();
      }
      
      // Extract schemas from endpoint handlers
      this.extractSchemasFromEndpoints();
      
      this.metrics.analysisTime = performance.now() - startTime;
      this.emit('analysis:completed', { 
        schemasFound: this.schemas.size 
      });
      
    } catch (error) {
      this.metrics.errorsEncountered++;
      throw error;
    }
  }
  
  /**
   * Scan models directory for schema definitions
   */
  async scanModelsDirectory() {
    const { readdir } = await import('fs/promises');
    
    try {
      const files = await readdir(this.options.modelsDirectory);
      
      for (const file of files) {
        if (this.isSourceFile(file)) {
          const filePath = join(this.options.modelsDirectory, file);
          await this.extractSchemasFromFile(filePath);
        }
      }
    } catch (error) {
      // Ignore directory access errors
    }
  }
  
  /**
   * Extract schemas from endpoints
   */
  extractSchemasFromEndpoints() {
    // Extract schema information from collected endpoints
    this.endpoints.forEach(endpoint => {
      if (endpoint.handler && endpoint.handler.usesValidation) {
        // Generate basic schema from endpoint
        const schema = {
          name: `${endpoint.method}${endpoint.path.replace(/[^\\w]/g, '')}Request`,
          type: 'object',
          properties: {}
        };
        
        endpoint.parameters.forEach(param => {
          schema.properties[param.name] = {
            type: param.type || 'string',
            description: param.description
          };
        });
        
        this.schemas.set(schema.name, schema);
      }
    });
  }
  
  /**
   * Extract schemas from model files
   */
  async extractSchemasFromFile(filePath) {
    try {
      const content = await readFile(filePath, 'utf8');
      const ast = parse(content, {
        sourceType: 'module',
        plugins: ['typescript', 'decorators-legacy']
      });
      
      traverse.default(ast, {
        // Mongoose schemas
        VariableDeclarator(path) {
          if (path.node.id.name.includes('Schema') && 
              path.node.init?.type === 'CallExpression') {
            const schema = this.parseMongooseSchema(path.node);
            if (schema) {
              this.schemas.set(schema.name, schema);
            }
          }
        },
        
        // TypeScript interfaces
        TSInterfaceDeclaration(path) {
          const schema = this.parseTypeScriptInterface(path.node);
          if (schema) {
            this.schemas.set(schema.name, schema);
          }
        }
      });
      
    } catch (error) {
      console.warn(`Error extracting schemas from ${filePath}:`, error.message);
    }
  }
  
  /**
   * Parse Mongoose schema
   */
  parseMongooseSchema(node) {
    // Basic Mongoose schema parsing
    return {
      name: node.id.name.replace('Schema', ''),
      type: 'object',
      properties: {}
    };
  }
  
  /**
   * Parse TypeScript interface
   */
  parseTypeScriptInterface(node) {
    // Basic TypeScript interface parsing
    return {
      name: node.id.name,
      type: 'object',
      properties: {}
    };
  }
  
  /**
   * Generate endpoint ID
   */
  generateEndpointId(method, path) {
    return createHash('md5')
      .update(`${method}:${path}`)
      .digest('hex')
      .substring(0, 8);
  }
  
  /**
   * Initialize security schemes
   */
  initializeSecuritySchemes() {
    this.securitySchemes.set('bearerAuth', {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'JWT token obtained from authentication'
    });
    
    this.securitySchemes.set('apiKey', {
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
      description: 'API key for programmatic access'
    });
  }
  
  /**
   * Generate OpenAPI specification
   */
  async generateOpenAPISpec() {
    try {
      const spec = {
        openapi: '3.0.3',
        info: {
          title: this.metadata.title,
          version: this.metadata.version,
          description: this.metadata.description,
          contact: {
            name: 'API Support',
            url: 'https://github.com/shizukutanaka/Otedama/issues'
          }
        },
        servers: [{
          url: this.options.baseUrl,
          description: 'API Server'
        }],
        paths: {},
        components: {
          securitySchemes: Object.fromEntries(this.securitySchemes),
          schemas: this.generateOpenAPISchemas()
        }
      };
      
      // Generate paths from endpoints
      this.endpoints.forEach(endpoint => {
        const pathKey = endpoint.path;
        if (!spec.paths[pathKey]) {
          spec.paths[pathKey] = {};
        }
        
        spec.paths[pathKey][endpoint.method.toLowerCase()] = {
          summary: endpoint.summary || `${endpoint.method} ${endpoint.path}`,
          description: endpoint.description || '',
          operationId: `${endpoint.method.toLowerCase()}${endpoint.path.replace(/[^\w]/g, '')}`,
          tags: endpoint.tags.length > 0 ? endpoint.tags : ['API'],
          parameters: endpoint.parameters.map(this.convertParameterToOpenAPI),
          responses: this.convertResponsesToOpenAPI(endpoint.responses),
          security: endpoint.security.length > 0 ? endpoint.security : undefined,
          deprecated: endpoint.deprecated || undefined
        };
        
        // Add examples if available
        if (endpoint.examples.length > 0) {
          spec.paths[pathKey][endpoint.method.toLowerCase()].examples = endpoint.examples;
        }
      });
      
      // Write OpenAPI spec
      const outputPath = join(this.options.outputDirectory, 'openapi.yaml');
      await writeFile(outputPath, this.convertToYAML(spec), 'utf8');
      
      this.emit('openapi:generated', { path: outputPath });
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'api-docs-generator',
        category: ErrorCategory.GENERATION,
        operation: 'openapi'
      });
    }
  }
  
  /**
   * Generate OpenAPI schemas from collected schemas
   */
  generateOpenAPISchemas() {
    const schemas = {};
    
    this.schemas.forEach((schema, name) => {
      schemas[name] = this.convertSchemaToOpenAPI(schema);
    });
    
    return schemas;
  }
  
  /**
   * Convert parameter to OpenAPI format
   */
  convertParameterToOpenAPI(param) {
    return {
      name: param.name,
      in: param.in,
      required: param.required,
      schema: {
        type: param.type || 'string'
      },
      description: param.description
    };
  }
  
  /**
   * Convert responses to OpenAPI format
   */
  convertResponsesToOpenAPI(responses) {
    if (responses.size === 0) {
      return {
        '200': {
          description: 'Success'
        }
      };
    }
    
    const openAPIResponses = {};
    responses.forEach((response, statusCode) => {
      openAPIResponses[statusCode] = {
        description: response.description,
        content: response.schema ? {
          'application/json': {
            schema: response.schema
          }
        } : undefined
      };
    });
    
    return openAPIResponses;
  }
  
  /**
   * Convert object to YAML string
   */
  convertToYAML(obj) {
    // Simple YAML conversion - in production, use a proper YAML library
    return JSON.stringify(obj, null, 2)
      .replace(/"/g, '')
      .replace(/,$/gm, '')
      .replace(/^\s*{\s*$/gm, '')
      .replace(/^\s*}\s*$/gm, '');
  }
  
  /**
   * Generate Markdown documentation
   */
  async generateMarkdownDocs() {
    try {
      let markdown = `# ${this.metadata.title}\n\n`;
      markdown += `${this.metadata.description}\n\n`;
      markdown += `**Version:** ${this.metadata.version}\n`;
      markdown += `**Generated:** ${this.metadata.generatedAt}\n\n`;
      
      // Group endpoints by tags
      const endpointsByTag = new Map();
      this.endpoints.forEach(endpoint => {
        const tag = endpoint.tags[0] || 'API';
        if (!endpointsByTag.has(tag)) {
          endpointsByTag.set(tag, []);
        }
        endpointsByTag.get(tag).push(endpoint);
      });
      
      // Generate documentation for each tag
      endpointsByTag.forEach((endpoints, tag) => {
        markdown += `## ${tag}\n\n`;
        
        endpoints.forEach(endpoint => {
          markdown += `### ${endpoint.method} ${endpoint.path}\n\n`;
          
          if (endpoint.summary) {
            markdown += `${endpoint.summary}\n\n`;
          }
          
          if (endpoint.description) {
            markdown += `${endpoint.description}\n\n`;
          }
          
          if (endpoint.parameters.length > 0) {
            markdown += `**Parameters:**\n\n`;
            endpoint.parameters.forEach(param => {
              markdown += `- \`${param.name}\` (${param.in}) - ${param.description}\n`;
            });
            markdown += '\n';
          }
          
          if (endpoint.examples.length > 0) {
            markdown += `**Example:**\n\n`;
            markdown += '```json\n';
            markdown += endpoint.examples[0];
            markdown += '\n```\n\n';
          }
          
          markdown += '---\n\n';
        });
      });
      
      const outputPath = join(this.options.outputDirectory, 'README.md');
      await writeFile(outputPath, markdown, 'utf8');
      
      this.emit('markdown:generated', { path: outputPath });
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'api-docs-generator',
        category: ErrorCategory.GENERATION,
        operation: 'markdown'
      });
    }
  }
  
  /**
   * Generate HTML documentation
   */
  async generateHTMLDocs() {
    try {
      const htmlContent = this.generateHTMLContent();
      const outputPath = join(this.options.outputDirectory, 'index.html');
      await writeFile(outputPath, htmlContent, 'utf8');
      
      this.emit('html:generated', { path: outputPath });
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'api-docs-generator',
        category: ErrorCategory.GENERATION,
        operation: 'html'
      });
    }
  }
  
  /**
   * Generate Postman collection
   */
  async generatePostmanCollection() {
    try {
      const collection = this.generatePostmanJSON();
      const outputPath = join(this.options.outputDirectory, 'postman-collection.json');
      await writeFile(outputPath, JSON.stringify(collection, null, 2), 'utf8');
      
      this.emit('postman:generated', { path: outputPath });
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'api-docs-generator',
        category: ErrorCategory.GENERATION,
        operation: 'postman'
      });
    }
  }
  
  /**
   * Generate metrics report
   */
  async generateMetricsReport() {
    try {
      const report = {
        metadata: this.metadata,
        metrics: this.metrics,
        endpoints: Array.from(this.endpoints.values()),
        schemas: Array.from(this.schemas.values())
      };
      
      const outputPath = join(this.options.outputDirectory, 'metrics-report.json');
      await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8');
      
      this.emit('metrics:generated', { path: outputPath });
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'api-docs-generator',
        category: ErrorCategory.GENERATION,
        operation: 'metrics'
      });
    }
  }
  
  /**
   * Generate HTML content
   */
  generateHTMLContent() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.metadata.title}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .endpoint { border: 1px solid #ddd; margin: 20px 0; padding: 20px; border-radius: 5px; }
        .method { display: inline-block; padding: 5px 10px; color: white; border-radius: 3px; font-weight: bold; }
        .get { background-color: #61affe; }
        .post { background-color: #49cc90; }
        .put { background-color: #fca130; }
        .delete { background-color: #f93e3e; }
    </style>
</head>
<body>
    <h1>${this.metadata.title}</h1>
    <p>${this.metadata.description}</p>
    <p><strong>Version:</strong> ${this.metadata.version}</p>
    
    <h2>Endpoints</h2>
    ${Array.from(this.endpoints.values()).map(endpoint => `
        <div class="endpoint">
            <h3><span class="method ${endpoint.method.toLowerCase()}">${endpoint.method}</span> ${endpoint.path}</h3>
            <p>${endpoint.description || endpoint.summary || 'No description available'}</p>
        </div>
    `).join('')}
</body>
</html>`;
  }
  
  /**
   * Generate Postman collection JSON
   */
  generatePostmanJSON() {
    return {
      info: {
        name: this.metadata.title,
        description: this.metadata.description,
        version: this.metadata.version
      },
      item: Array.from(this.endpoints.values()).map(endpoint => ({
        name: `${endpoint.method} ${endpoint.path}`,
        request: {
          method: endpoint.method,
          header: [],
          url: {
            raw: `${this.options.baseUrl}${endpoint.path}`,
            host: [this.options.baseUrl.replace(/https?:\/\//, '')],
            path: endpoint.path.split('/').filter(Boolean)
          }
        }
      }))
    };
  }
  
  /**
   * Convert schema to OpenAPI format
   */
  convertSchemaToOpenAPI(schema) {
    return {
      type: schema.type || 'object',
      properties: schema.properties || {},
      description: schema.description || ''
    };
  }
  
  /**
   * Get generation statistics
   */
  getStatistics() {
    return {
      metadata: { ...this.metadata },
      metrics: { ...this.metrics },
      endpoints: this.endpoints.size,
      schemas: this.schemas.size,
      documented: Array.from(this.endpoints.values()).filter(e => e.documented).length
    };
  }
  
  /**
   * Clear all collected data
   */
  clear() {
    this.endpoints.clear();
    this.schemas.clear();
    this.routeRegistry.clear();
    
    this.metrics = {
      scanTime: 0,
      analysisTime: 0,
      generationTime: 0,
      filesScanned: 0,
      endpointsFound: 0,
      errorsEncountered: 0
    };
  }
}

export default APIDocumentationGenerator;