/**
 * Swagger Integration Middleware
 * Provides Swagger UI and automatic documentation serving
 */

import { EventEmitter } from 'events';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { OpenAPIGenerator } from './openapi-generator.js';
import { getLogger } from '../core/logger.js';
import fs from 'fs/promises';
import path from 'path';

// Documentation themes
export const DocumentationThemes = {
    DEFAULT: 'default',
    DARK: 'dark',
    MATERIAL: 'material',
    OTEDAMA: 'otedama'
};

// Authentication methods for docs
export const DocsAuthMethods = {
    NONE: 'none',
    BASIC: 'basic',
    API_KEY: 'api-key',
    OAUTH: 'oauth'
};

export class SwaggerIntegration extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.logger = getLogger('SwaggerIntegration');
        this.options = {
            // Swagger UI settings
            swaggerUiPath: options.swaggerUiPath || '/api-docs',
            specPath: options.specPath || '/api-docs/spec',
            theme: options.theme || DocumentationThemes.OTEDAMA,
            
            // Documentation settings
            title: options.title || 'Otedama API Documentation',
            logoUrl: options.logoUrl || '/assets/otedama-logo.png',
            enableSearch: options.enableSearch !== false,
            enableFilter: options.enableFilter !== false,
            enableJsonEditor: options.enableJsonEditor !== false,
            
            // Authentication
            authMethod: options.authMethod || DocsAuthMethods.NONE,
            authCredentials: options.authCredentials || {},
            
            // Auto-generation
            autoGenerate: options.autoGenerate !== false,
            watchFiles: options.watchFiles !== false,
            generateInterval: options.generateInterval || 300000, // 5 minutes
            
            // Customization
            customCss: options.customCss || '',
            customJs: options.customJs || '',
            favicon: options.favicon || '/favicon.ico',
            
            // Performance
            cacheEnabled: options.cacheEnabled !== false,
            cacheTTL: options.cacheTTL || 3600000, // 1 hour
            
            ...options
        };
        
        // Core components
        this.generator = new OpenAPIGenerator({
            title: this.options.title,
            version: options.version || '1.0.0',
            description: options.description || 'Otedama P2P Mining Pool and DEX API'
        });
        
        // Express router
        this.router = express.Router();
        
        // Cache
        this.specCache = null;
        this.cacheTimestamp = 0;
        
        // File watchers
        this.watchers = new Set();
        
        // Initialize
        this.initialize();
    }
    
    /**
     * Initialize Swagger integration
     */
    async initialize() {
        this.logger.info('Initializing Swagger integration...');
        
        // Register default routes in generator
        this.generator.registerDefaultRoutes();
        
        // Setup middleware routes
        this.setupRoutes();
        
        // Setup file watching if enabled
        if (this.options.watchFiles) {
            this.setupFileWatching();
        }
        
        // Setup auto-generation
        if (this.options.autoGenerate) {
            this.setupAutoGeneration();
        }
        
        this.logger.info('Swagger integration initialized');
        this.emit('initialized');
    }
    
    /**
     * Setup Express routes
     */
    setupRoutes() {
        // Serve OpenAPI specification
        this.router.get(this.options.specPath, async (req, res) => {
            try {
                const spec = await this.getSpecification();
                res.json(spec);
            } catch (error) {
                this.logger.error('Error serving specification:', error);
                res.status(500).json({ error: 'Failed to generate specification' });
            }
        });
        
        // Serve OpenAPI specification in YAML format
        this.router.get(`${this.options.specPath}.yaml`, async (req, res) => {
            try {
                const spec = await this.getSpecification();
                const yaml = await import('js-yaml');
                const yamlContent = yaml.dump(spec);
                
                res.set('Content-Type', 'application/x-yaml');
                res.send(yamlContent);
            } catch (error) {
                this.logger.error('Error serving YAML specification:', error);
                res.status(500).json({ error: 'Failed to generate YAML specification' });
            }
        });
        
        // Custom CSS endpoint
        this.router.get('/swagger-ui-custom.css', (req, res) => {
            const customCss = this.generateCustomCSS();
            res.set('Content-Type', 'text/css');
            res.send(customCss);
        });
        
        // Custom JS endpoint
        this.router.get('/swagger-ui-custom.js', (req, res) => {
            const customJs = this.generateCustomJS();
            res.set('Content-Type', 'application/javascript');
            res.send(customJs);
        });
        
        // Setup Swagger UI with authentication if required
        if (this.options.authMethod !== DocsAuthMethods.NONE) {
            this.router.use(this.options.swaggerUiPath, this.authenticationMiddleware.bind(this));
        }
        
        // Swagger UI options
        const swaggerUiOptions = {
            customCss: `
                @import url('/swagger-ui-custom.css');
                ${this.options.customCss}
            `,
            customJs: `
                // Load custom JavaScript
                fetch('/swagger-ui-custom.js')
                    .then(response => response.text())
                    .then(js => {
                        const script = document.createElement('script');
                        script.textContent = js;
                        document.head.appendChild(script);
                    });
                ${this.options.customJs}
            `,
            swaggerOptions: {
                url: this.options.specPath,
                deepLinking: true,
                displayRequestDuration: true,
                filter: this.options.enableFilter,
                showExtensions: true,
                showCommonExtensions: true,
                tryItOutEnabled: true,
                requestInterceptor: this.options.enableJsonEditor ? this.requestInterceptor : undefined
            },
            customSiteTitle: this.options.title,
            customfavIcon: this.options.favicon
        };
        
        // Setup Swagger UI middleware
        this.router.use(
            this.options.swaggerUiPath,
            swaggerUi.serveFiles(null, swaggerUiOptions),
            swaggerUi.setup(null, swaggerUiOptions)
        );
        
        this.logger.info(`Swagger UI available at ${this.options.swaggerUiPath}`);
    }
    
    /**
     * Authentication middleware for documentation access
     */
    authenticationMiddleware(req, res, next) {
        switch (this.options.authMethod) {
            case DocsAuthMethods.BASIC:
                return this.basicAuth(req, res, next);
                
            case DocsAuthMethods.API_KEY:
                return this.apiKeyAuth(req, res, next);
                
            case DocsAuthMethods.OAUTH:
                return this.oauthAuth(req, res, next);
                
            default:
                return next();
        }
    }
    
    /**
     * Basic authentication
     */
    basicAuth(req, res, next) {
        const auth = req.get('Authorization');
        
        if (!auth || !auth.startsWith('Basic ')) {
            res.set('WWW-Authenticate', 'Basic realm="API Documentation"');
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        const credentials = Buffer.from(auth.slice(6), 'base64').toString().split(':');
        const [username, password] = credentials;
        
        if (username === this.options.authCredentials.username &&
            password === this.options.authCredentials.password) {
            return next();
        }
        
        res.set('WWW-Authenticate', 'Basic realm="API Documentation"');
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    /**
     * API key authentication
     */
    apiKeyAuth(req, res, next) {
        const apiKey = req.get('X-API-Key') || req.query.apiKey;
        
        if (!apiKey) {
            return res.status(401).json({ error: 'API key required' });
        }
        
        if (apiKey === this.options.authCredentials.apiKey) {
            return next();
        }
        
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    /**
     * OAuth authentication
     */
    oauthAuth(req, res, next) {
        // Simplified OAuth check - in production would validate JWT
        const token = req.get('Authorization')?.replace('Bearer ', '');
        
        if (!token) {
            return res.status(401).json({ error: 'Bearer token required' });
        }
        
        // Mock validation - in production would verify JWT
        if (token === this.options.authCredentials.validToken) {
            return next();
        }
        
        return res.status(401).json({ error: 'Invalid token' });
    }
    
    /**
     * Get OpenAPI specification with caching
     */
    async getSpecification() {
        const now = Date.now();
        
        // Return cached version if valid
        if (this.options.cacheEnabled &&
            this.specCache &&
            (now - this.cacheTimestamp) < this.options.cacheTTL) {
            return this.specCache;
        }
        
        // Generate fresh specification
        const spec = this.generator.buildSpecification();
        
        // Cache the result
        if (this.options.cacheEnabled) {
            this.specCache = spec;
            this.cacheTimestamp = now;
        }
        
        return spec;
    }
    
    /**
     * Generate custom CSS for theming
     */
    generateCustomCSS() {
        let css = '';
        
        switch (this.options.theme) {
            case DocumentationThemes.DARK:
                css += this.getDarkThemeCSS();
                break;
                
            case DocumentationThemes.MATERIAL:
                css += this.getMaterialThemeCSS();
                break;
                
            case DocumentationThemes.OTEDAMA:
                css += this.getOtedamaThemeCSS();
                break;
                
            default:
                css += this.getDefaultThemeCSS();
        }
        
        return css;
    }
    
    /**
     * Get Otedama custom theme CSS
     */
    getOtedamaThemeCSS() {
        return `
            /* Otedama Theme */
            .swagger-ui {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            
            .swagger-ui .topbar {
                background-color: #1a1a2e;
                border-bottom: 3px solid #16213e;
            }
            
            .swagger-ui .topbar .download-url-wrapper {
                display: none;
            }
            
            .swagger-ui .topbar-wrapper .link {
                content: url('${this.options.logoUrl}');
                width: 120px;
                height: 40px;
            }
            
            .swagger-ui .info .title {
                color: #16213e;
                font-size: 2.5rem;
                font-weight: 700;
            }
            
            .swagger-ui .info .description {
                font-size: 1.1rem;
                color: #666;
            }
            
            .swagger-ui .scheme-container {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                border-radius: 8px;
                padding: 1rem;
                margin: 1rem 0;
            }
            
            .swagger-ui .opblock.opblock-get {
                border-color: #49cc90;
                background: rgba(73, 204, 144, 0.1);
            }
            
            .swagger-ui .opblock.opblock-post {
                border-color: #fca130;
                background: rgba(252, 161, 48, 0.1);
            }
            
            .swagger-ui .opblock.opblock-put {
                border-color: #fc7500;
                background: rgba(252, 117, 0, 0.1);
            }
            
            .swagger-ui .opblock.opblock-delete {
                border-color: #f93e3e;
                background: rgba(249, 62, 62, 0.1);
            }
            
            .swagger-ui .btn.execute {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                border: none;
                color: white;
                border-radius: 6px;
                font-weight: 600;
            }
            
            .swagger-ui .btn.execute:hover {
                background: linear-gradient(135deg, #5a6fd8 0%, #6a4190 100%);
            }
            
            .swagger-ui .response-col_status {
                font-weight: 700;
            }
            
            .swagger-ui .parameters-col_description {
                color: #666;
            }
            
            /* Custom scrollbar */
            .swagger-ui ::-webkit-scrollbar {
                width: 8px;
            }
            
            .swagger-ui ::-webkit-scrollbar-track {
                background: #f1f1f1;
                border-radius: 4px;
            }
            
            .swagger-ui ::-webkit-scrollbar-thumb {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                border-radius: 4px;
            }
            
            .swagger-ui ::-webkit-scrollbar-thumb:hover {
                background: linear-gradient(135deg, #5a6fd8 0%, #6a4190 100%);
            }
        `;
    }
    
    /**
     * Get dark theme CSS
     */
    getDarkThemeCSS() {
        return `
            /* Dark Theme */
            .swagger-ui {
                background-color: #1a1a1a;
                color: #ffffff;
            }
            
            .swagger-ui .topbar {
                background-color: #2d2d2d;
            }
            
            .swagger-ui .info .title {
                color: #ffffff;
            }
            
            .swagger-ui .opblock {
                background-color: #2d2d2d;
                border-color: #404040;
            }
            
            .swagger-ui .opblock-summary {
                border-color: #404040;
            }
            
            .swagger-ui .opblock-body {
                background-color: #1a1a1a;
            }
        `;
    }
    
    /**
     * Get material theme CSS
     */
    getMaterialThemeCSS() {
        return `
            /* Material Theme */
            .swagger-ui {
                font-family: 'Roboto', sans-serif;
            }
            
            .swagger-ui .topbar {
                background-color: #3f51b5;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            
            .swagger-ui .opblock {
                border-radius: 4px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24);
                margin-bottom: 16px;
            }
            
            .swagger-ui .btn {
                border-radius: 4px;
                text-transform: uppercase;
                font-weight: 500;
            }
        `;
    }
    
    /**
     * Get default theme CSS
     */
    getDefaultThemeCSS() {
        return `
            /* Default Theme Enhancements */
            .swagger-ui .info .title {
                font-weight: 600;
            }
            
            .swagger-ui .opblock-summary {
                font-weight: 500;
            }
        `;
    }
    
    /**
     * Generate custom JavaScript
     */
    generateCustomJS() {
        return `
            // Custom Swagger UI enhancements
            window.addEventListener('DOMContentLoaded', function() {
                // Add copy button to code examples
                function addCopyButtons() {
                    const codeBlocks = document.querySelectorAll('pre code');
                    codeBlocks.forEach(function(block) {
                        if (block.parentNode.querySelector('.copy-button')) return;
                        
                        const button = document.createElement('button');
                        button.className = 'copy-button';
                        button.textContent = 'Copy';
                        button.style.cssText = '
                            position: absolute;
                            top: 8px;
                            right: 8px;
                            padding: 4px 8px;
                            background: #007acc;
                            color: white;
                            border: none;
                            border-radius: 3px;
                            cursor: pointer;
                            font-size: 12px;
                        ';
                        
                        button.addEventListener('click', function() {
                            navigator.clipboard.writeText(block.textContent).then(function() {
                                button.textContent = 'Copied!';
                                setTimeout(function() {
                                    button.textContent = 'Copy';
                                }, 2000);
                            });
                        });
                        
                        block.parentNode.style.position = 'relative';
                        block.parentNode.appendChild(button);
                    });
                }
                
                // Add search functionality
                function addSearchBox() {
                    if (!${this.options.enableSearch}) return;
                    
                    const searchContainer = document.createElement('div');
                    searchContainer.style.cssText = '
                        padding: 1rem;
                        background: #f8f9fa;
                        border-bottom: 1px solid #dee2e6;
                    ';
                    
                    const searchInput = document.createElement('input');
                    searchInput.type = 'text';
                    searchInput.placeholder = 'Search API endpoints...';
                    searchInput.style.cssText = '
                        width: 100%;
                        padding: 8px 12px;
                        border: 1px solid #ced4da;
                        border-radius: 4px;
                        font-size: 14px;
                    ';
                    
                    searchInput.addEventListener('input', function() {
                        const query = this.value.toLowerCase();
                        const operations = document.querySelectorAll('.opblock');
                        
                        operations.forEach(function(op) {
                            const summary = op.querySelector('.opblock-summary-description');
                            const path = op.querySelector('.opblock-summary-path');
                            const text = (summary ? summary.textContent : '') + 
                                        (path ? path.textContent : '');
                            
                            if (text.toLowerCase().includes(query)) {
                                op.style.display = 'block';
                            } else {
                                op.style.display = 'none';
                            }
                        });
                    });
                    
                    searchContainer.appendChild(searchInput);
                    
                    const infoSection = document.querySelector('.swagger-ui .info');
                    if (infoSection) {
                        infoSection.parentNode.insertBefore(searchContainer, infoSection.nextSibling);
                    }
                }
                
                // Initialize enhancements
                setTimeout(function() {
                    addCopyButtons();
                    addSearchBox();
                    
                    // Re-add copy buttons when new content is loaded
                    const observer = new MutationObserver(function() {
                        addCopyButtons();
                    });
                    
                    observer.observe(document.body, {
                        childList: true,
                        subtree: true
                    });
                }, 1000);
            });
        `;
    }
    
    /**
     * Request interceptor for custom auth headers
     */
    requestInterceptor(request) {
        // Add custom headers if needed
        if (this.options.authMethod === DocsAuthMethods.API_KEY) {
            request.headers['X-API-Key'] = this.options.authCredentials.apiKey;
        }
        
        return request;
    }
    
    /**
     * Setup file watching for auto-regeneration
     */
    setupFileWatching() {
        const watchPaths = [
            './lib/routes',
            './lib/api',
            './routes'
        ];
        
        for (const watchPath of watchPaths) {
            try {
                const watcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
                    if (filename && filename.endsWith('.js')) {
                        this.logger.debug(`File changed: ${filename}, regenerating docs`);
                        this.invalidateCache();
                    }
                });
                
                this.watchers.add(watcher);
            } catch (error) {
                this.logger.debug(`Cannot watch ${watchPath}:`, error.message);
            }
        }
    }
    
    /**
     * Setup auto-generation interval
     */
    setupAutoGeneration() {
        setInterval(() => {
            this.invalidateCache();
            this.logger.debug('Auto-regenerating API documentation');
        }, this.options.generateInterval);
    }
    
    /**
     * Invalidate specification cache
     */
    invalidateCache() {
        this.specCache = null;
        this.cacheTimestamp = 0;
        this.emit('cacheInvalidated');
    }
    
    /**
     * Add route to documentation
     */
    addRoute(method, path, definition) {
        this.generator.addRoute(method, path, definition);
        this.invalidateCache();
    }
    
    /**
     * Add schema to documentation
     */
    addSchema(name, schema) {
        this.generator.addSchema(name, schema);
        this.invalidateCache();
    }
    
    /**
     * Get Express router
     */
    getRouter() {
        return this.router;
    }
    
    /**
     * Get documentation URL
     */
    getDocumentationUrl(baseUrl = 'http://localhost:3000') {
        return `${baseUrl}${this.options.swaggerUiPath}`;
    }
    
    /**
     * Generate static documentation files
     */
    async generateStaticDocs(outputDir = './docs/static') {
        await this.generator.generateDocumentation();
        
        // Copy generated files to static directory
        await fs.mkdir(outputDir, { recursive: true });
        
        const sourceDir = this.generator.options.outputDir;
        const files = await fs.readdir(sourceDir);
        
        for (const file of files) {
            const sourcePath = path.join(sourceDir, file);
            const destPath = path.join(outputDir, file);
            await fs.copyFile(sourcePath, destPath);
        }
        
        this.logger.info(`Static documentation generated in ${outputDir}`);
    }
    
    /**
     * Get integration statistics
     */
    getStats() {
        const summary = this.generator.getSpecificationSummary();
        
        return {
            ...summary,
            cacheHits: this.specCache ? 1 : 0,
            watchers: this.watchers.size,
            theme: this.options.theme,
            authMethod: this.options.authMethod,
            docsUrl: this.options.swaggerUiPath
        };
    }
    
    /**
     * Cleanup resources
     */
    async cleanup() {
        this.logger.info('Cleaning up Swagger integration...');
        
        // Close file watchers
        for (const watcher of this.watchers) {
            watcher.close();
        }
        this.watchers.clear();
        
        // Clear cache
        this.invalidateCache();
        
        this.emit('cleanup');
    }
}

export default SwaggerIntegration;