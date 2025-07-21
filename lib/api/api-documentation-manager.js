/**
 * API Documentation Manager
 * Centralized management of API documentation with versioning and publishing
 */

import { EventEmitter } from 'events';
import { OpenAPIGenerator } from './openapi-generator.js';
import { SwaggerIntegration } from './swagger-integration.js';
import { getLogger } from '../core/logger.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Documentation versions
export const DocumentationVersions = {
    V1: 'v1',
    V2: 'v2',
    LATEST: 'latest'
};

// Publishing targets
export const PublishingTargets = {
    STATIC_SITE: 'static-site',
    S3: 's3',
    GITHUB_PAGES: 'github-pages',
    CONFLUENCE: 'confluence',
    NOTION: 'notion'
};

export class APIDocumentationManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.logger = getLogger('APIDocumentationManager');
        this.options = {
            // Base configuration
            baseUrl: options.baseUrl || 'http://localhost:3000',
            docsPath: options.docsPath || './docs',
            versioning: options.versioning !== false,
            
            // Default version settings
            currentVersion: options.currentVersion || DocumentationVersions.V1,
            supportedVersions: options.supportedVersions || [DocumentationVersions.V1],
            
            // Auto-generation settings
            autoGenerate: options.autoGenerate !== false,
            generateOnStartup: options.generateOnStartup !== false,
            watchForChanges: options.watchForChanges !== false,
            
            // Publishing settings
            publishingEnabled: options.publishingEnabled || false,
            publishingTargets: options.publishingTargets || [],
            
            // Theme and customization
            theme: options.theme || 'otedama',
            customization: options.customization || {},
            
            // Integration settings
            integrateWithExpress: options.integrateWithExpress !== false,
            enableSwaggerUI: options.enableSwaggerUI !== false,
            enableRedoc: options.enableRedoc || false,
            
            ...options
        };
        
        // Documentation generators per version
        this.generators = new Map();
        
        // Swagger integrations per version
        this.swaggerIntegrations = new Map();
        
        // Published documentation metadata
        this.publishedDocs = new Map();
        
        // Route registry for auto-discovery
        this.routeRegistry = new Map();
        
        // File watchers
        this.watchers = new Set();
        
        // Statistics
        this.stats = {
            totalEndpoints: 0,
            versionsSupported: 0,
            lastGenerated: null,
            lastPublished: null,
            generationCount: 0,
            publishingCount: 0
        };
        
        // Initialize
        this.initialize();
    }
    
    /**
     * Initialize documentation manager
     */
    async initialize() {
        this.logger.info('Initializing API Documentation Manager...');
        
        // Create documentation directories
        await this.createDirectories();
        
        // Initialize generators for each version
        for (const version of this.options.supportedVersions) {
            await this.initializeVersion(version);
        }
        
        // Setup file watching if enabled
        if (this.options.watchForChanges) {
            this.setupFileWatching();
        }
        
        // Generate documentation on startup if enabled
        if (this.options.generateOnStartup) {
            await this.generateAllVersions();
        }
        
        this.stats.versionsSupported = this.options.supportedVersions.length;
        
        this.logger.info(`Documentation manager initialized for versions: ${this.options.supportedVersions.join(', ')}`);
        this.emit('initialized');
    }
    
    /**
     * Create necessary directories
     */
    async createDirectories() {
        const dirs = [
            this.options.docsPath,
            path.join(this.options.docsPath, 'api'),
            path.join(this.options.docsPath, 'static'),
            path.join(this.options.docsPath, 'templates')
        ];
        
        for (const dir of dirs) {
            await fs.mkdir(dir, { recursive: true });
        }
    }
    
    /**
     * Initialize documentation for a specific version
     */
    async initializeVersion(version) {
        this.logger.info(`Initializing documentation for version ${version}`);
        
        // Create version-specific generator
        const generator = new OpenAPIGenerator({
            title: `Otedama API ${version}`,
            version: version === DocumentationVersions.LATEST ? '1.0.0' : version,
            description: `Otedama P2P Mining Pool and DEX API - Version ${version}`,
            outputDir: path.join(this.options.docsPath, 'api', version)
        });
        
        this.generators.set(version, generator);
        
        // Create Swagger integration if enabled
        if (this.options.enableSwaggerUI) {
            const swaggerIntegration = new SwaggerIntegration({
                title: `Otedama API ${version} Documentation`,
                swaggerUiPath: `/api-docs/${version}`,
                specPath: `/api-docs/${version}/spec`,
                theme: this.options.theme,
                ...this.options.customization
            });
            
            this.swaggerIntegrations.set(version, swaggerIntegration);
        }
        
        // Register version-specific routes
        await this.registerVersionRoutes(version);
    }
    
    /**
     * Register routes for a specific API version
     */
    async registerVersionRoutes(version) {
        const generator = this.generators.get(version);
        if (!generator) return;
        
        // Load route definitions from files
        const routeFiles = [
            path.join(__dirname, '../routes', version, 'mining.js'),
            path.join(__dirname, '../routes', version, 'dex.js'),
            path.join(__dirname, '../routes', version, 'p2p.js'),
            path.join(__dirname, '../routes', version, 'auth.js')
        ];
        
        for (const routeFile of routeFiles) {
            try {
                await this.loadRouteDefinitions(routeFile, generator);
            } catch (error) {
                this.logger.debug(`Could not load route definitions from ${routeFile}:`, error.message);
            }
        }
        
        // Add version-specific routes
        this.addVersionSpecificRoutes(generator, version);
    }
    
    /**
     * Load route definitions from file
     */
    async loadRouteDefinitions(filePath, generator) {
        try {
            const routeModule = await import(filePath);
            
            if (routeModule.routes && Array.isArray(routeModule.routes)) {
                for (const route of routeModule.routes) {
                    generator.addRoute(route.method, route.path, route.definition);
                }
            }
            
            if (routeModule.schemas) {
                for (const [name, schema] of Object.entries(routeModule.schemas)) {
                    generator.addSchema(name, schema);
                }
            }
            
        } catch (error) {
            this.logger.debug(`Failed to load route definitions from ${filePath}:`, error.message);
        }
    }
    
    /**
     * Add version-specific route definitions
     */
    addVersionSpecificRoutes(generator, version) {
        const versionPrefix = `/api/${version}`;
        
        // Health check endpoint
        generator.addRoute('GET', `${versionPrefix}/health`, {
            summary: 'Health check',
            description: 'Check API health and version information',
            tags: ['System'],
            responses: {
                '200': {
                    description: 'API is healthy',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    status: { type: 'string', example: 'healthy' },
                                    version: { type: 'string', example: version },
                                    timestamp: { type: 'string', format: 'date-time' },
                                    uptime: { type: 'number' }
                                }
                            }
                        }
                    }
                }
            }
        });
        
        // Version info endpoint
        generator.addRoute('GET', `${versionPrefix}/version`, {
            summary: 'Get version information',
            description: 'Get detailed API version information',
            tags: ['System'],
            responses: {
                '200': {
                    description: 'Version information',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    version: { type: 'string' },
                                    buildDate: { type: 'string', format: 'date-time' },
                                    gitCommit: { type: 'string' },
                                    features: {
                                        type: 'array',
                                        items: { type: 'string' }
                                    },
                                    deprecatedEndpoints: {
                                        type: 'array',
                                        items: { type: 'string' }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });
        
        // API documentation endpoint
        generator.addRoute('GET', `${versionPrefix}/docs`, {
            summary: 'Get API documentation',
            description: 'Get API documentation in various formats',
            tags: ['System'],
            parameters: [
                {
                    name: 'format',
                    in: 'query',
                    schema: {
                        type: 'string',
                        enum: ['json', 'yaml', 'html'],
                        default: 'json'
                    }
                }
            ],
            responses: {
                '200': {
                    description: 'API documentation',
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                description: 'OpenAPI specification'
                            }
                        },
                        'application/x-yaml': {
                            schema: {
                                type: 'string',
                                description: 'OpenAPI specification in YAML format'
                            }
                        },
                        'text/html': {
                            schema: {
                                type: 'string',
                                description: 'HTML documentation'
                            }
                        }
                    }
                }
            }
        });
    }
    
    /**
     * Generate documentation for all versions
     */
    async generateAllVersions() {
        this.logger.info('Generating documentation for all versions...');
        
        const promises = [];
        
        for (const [version, generator] of this.generators) {
            promises.push(this.generateVersionDocumentation(version, generator));
        }
        
        await Promise.all(promises);
        
        // Generate cross-version documentation
        await this.generateCrossVersionDocs();
        
        this.stats.lastGenerated = new Date();
        this.stats.generationCount++;
        
        this.logger.info('Documentation generation completed for all versions');
        this.emit('documentationGenerated', {
            versions: Array.from(this.generators.keys()),
            timestamp: this.stats.lastGenerated
        });
    }
    
    /**
     * Generate documentation for a specific version
     */
    async generateVersionDocumentation(version, generator) {
        try {
            await generator.generateDocumentation();
            
            // Update statistics
            const summary = generator.getSpecificationSummary();
            this.stats.totalEndpoints += summary.operations;
            
            this.logger.info(`Documentation generated for version ${version}: ${summary.operations} endpoints`);
            
        } catch (error) {
            this.logger.error(`Failed to generate documentation for version ${version}:`, error);
            throw error;
        }
    }
    
    /**
     * Generate cross-version documentation
     */
    async generateCrossVersionDocs() {
        const indexContent = this.generateVersionIndexHTML();
        const indexPath = path.join(this.options.docsPath, 'index.html');
        
        await fs.writeFile(indexPath, indexContent);
        
        // Generate version comparison
        const comparisonContent = this.generateVersionComparison();
        const comparisonPath = path.join(this.options.docsPath, 'version-comparison.json');
        
        await fs.writeFile(comparisonPath, JSON.stringify(comparisonContent, null, 2));
        
        this.logger.debug('Cross-version documentation generated');
    }
    
    /**
     * Generate version index HTML
     */
    generateVersionIndexHTML() {
        const versions = Array.from(this.generators.keys());
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Otedama API Documentation</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 2rem;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            padding: 2rem;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        }
        h1 {
            color: #333;
            text-align: center;
            margin-bottom: 2rem;
            font-size: 2.5rem;
        }
        .version-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1.5rem;
            margin: 2rem 0;
        }
        .version-card {
            border: 2px solid #e1e5e9;
            border-radius: 8px;
            padding: 1.5rem;
            text-decoration: none;
            color: #333;
            transition: all 0.3s ease;
        }
        .version-card:hover {
            border-color: #667eea;
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.2);
        }
        .version-title {
            font-size: 1.5rem;
            font-weight: 600;
            margin-bottom: 0.5rem;
        }
        .version-description {
            color: #666;
            margin-bottom: 1rem;
        }
        .version-status {
            display: inline-block;
            padding: 0.25rem 0.75rem;
            border-radius: 12px;
            font-size: 0.875rem;
            font-weight: 500;
        }
        .status-current {
            background: #d4edda;
            color: #155724;
        }
        .status-stable {
            background: #d1ecf1;
            color: #0c5460;
        }
        .status-deprecated {
            background: #f8d7da;
            color: #721c24;
        }
        .footer {
            text-align: center;
            margin-top: 2rem;
            padding-top: 2rem;
            border-top: 1px solid #e1e5e9;
            color: #666;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Otedama API Documentation</h1>
        <p style="text-align: center; font-size: 1.2rem; color: #666; margin-bottom: 2rem;">
            Comprehensive API documentation for the Otedama P2P Mining Pool and DEX platform
        </p>
        
        <div class="version-grid">
            ${versions.map(version => `
                <a href="/api-docs/${version}" class="version-card">
                    <div class="version-title">Version ${version}</div>
                    <div class="version-description">
                        ${this.getVersionDescription(version)}
                    </div>
                    <span class="version-status ${this.getVersionStatusClass(version)}">
                        ${this.getVersionStatus(version)}
                    </span>
                </a>
            `).join('')}
        </div>
        
        <div class="footer">
            <p>Generated on ${new Date().toLocaleString()}</p>
            <p>
                <a href="/api-docs/latest/spec">OpenAPI Spec</a> |
                <a href="/version-comparison.json">Version Comparison</a> |
                <a href="https://github.com/otedama/api">GitHub</a>
            </p>
        </div>
    </div>
</body>
</html>`;
    }
    
    /**
     * Get version description
     */
    getVersionDescription(version) {
        const descriptions = {
            [DocumentationVersions.V1]: 'Stable API with core mining and trading functionality',
            [DocumentationVersions.V2]: 'Enhanced API with advanced features and improved performance',
            [DocumentationVersions.LATEST]: 'Latest development version with cutting-edge features'
        };
        
        return descriptions[version] || 'API documentation for this version';
    }
    
    /**
     * Get version status
     */
    getVersionStatus(version) {
        if (version === this.options.currentVersion) {
            return 'Current';
        }
        
        if (version === DocumentationVersions.LATEST) {
            return 'Development';
        }
        
        return 'Stable';
    }
    
    /**
     * Get version status CSS class
     */
    getVersionStatusClass(version) {
        if (version === this.options.currentVersion) {
            return 'status-current';
        }
        
        if (version === DocumentationVersions.LATEST) {
            return 'status-deprecated';
        }
        
        return 'status-stable';
    }
    
    /**
     * Generate version comparison data
     */
    generateVersionComparison() {
        const comparison = {
            generated: new Date().toISOString(),
            versions: {},
            changes: {}
        };
        
        for (const [version, generator] of this.generators) {
            const summary = generator.getSpecificationSummary();
            
            comparison.versions[version] = {
                ...summary,
                status: this.getVersionStatus(version),
                description: this.getVersionDescription(version)
            };
        }
        
        return comparison;
    }
    
    /**
     * Setup file watching for automatic regeneration
     */
    setupFileWatching() {
        const watchPaths = [
            './lib/routes',
            './lib/api',
            './routes',
            './src/routes'
        ];
        
        for (const watchPath of watchPaths) {
            try {
                const watcher = fs.watch(watchPath, { recursive: true }, async (eventType, filename) => {
                    if (filename && (filename.endsWith('.js') || filename.endsWith('.json'))) {
                        this.logger.debug(`File changed: ${filename}, regenerating documentation`);
                        
                        // Debounce regeneration
                        clearTimeout(this.regenerationTimeout);
                        this.regenerationTimeout = setTimeout(async () => {
                            try {
                                await this.generateAllVersions();
                            } catch (error) {
                                this.logger.error('Auto-regeneration failed:', error);
                            }
                        }, 2000);
                    }
                });
                
                this.watchers.add(watcher);
                this.logger.debug(`Watching ${watchPath} for changes`);
                
            } catch (error) {
                this.logger.debug(`Cannot watch ${watchPath}:`, error.message);
            }
        }
    }
    
    /**
     * Publish documentation to configured targets
     */
    async publishDocumentation() {
        if (!this.options.publishingEnabled || this.options.publishingTargets.length === 0) {
            this.logger.info('Publishing disabled or no targets configured');
            return;
        }
        
        this.logger.info('Publishing documentation to configured targets...');
        
        const publishPromises = this.options.publishingTargets.map(target => 
            this.publishToTarget(target)
        );
        
        const results = await Promise.allSettled(publishPromises);
        
        const successful = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;
        
        this.stats.lastPublished = new Date();
        this.stats.publishingCount++;
        
        this.logger.info(`Publishing completed: ${successful} successful, ${failed} failed`);
        this.emit('documentationPublished', {
            successful,
            failed,
            targets: this.options.publishingTargets,
            timestamp: this.stats.lastPublished
        });
    }
    
    /**
     * Publish to specific target
     */
    async publishToTarget(target) {
        switch (target.type) {
            case PublishingTargets.STATIC_SITE:
                return this.publishToStaticSite(target);
                
            case PublishingTargets.S3:
                return this.publishToS3(target);
                
            case PublishingTargets.GITHUB_PAGES:
                return this.publishToGitHubPages(target);
                
            default:
                throw new Error(`Unsupported publishing target: ${target.type}`);
        }
    }
    
    /**
     * Publish to static site
     */
    async publishToStaticSite(target) {
        const outputDir = target.outputDir || './dist/docs';
        
        // Copy all generated documentation
        await this.copyDirectory(this.options.docsPath, outputDir);
        
        this.logger.info(`Documentation published to static site: ${outputDir}`);
    }
    
    /**
     * Publish to S3
     */
    async publishToS3(target) {
        // Mock S3 publishing - in production would use AWS SDK
        this.logger.info(`Publishing to S3 bucket: ${target.bucket}`);
        
        // Would implement actual S3 upload logic here
        throw new Error('S3 publishing not implemented');
    }
    
    /**
     * Publish to GitHub Pages
     */
    async publishToGitHubPages(target) {
        // Mock GitHub Pages publishing
        this.logger.info(`Publishing to GitHub Pages: ${target.repository}`);
        
        // Would implement actual GitHub Pages deployment here
        throw new Error('GitHub Pages publishing not implemented');
    }
    
    /**
     * Copy directory recursively
     */
    async copyDirectory(src, dest) {
        await fs.mkdir(dest, { recursive: true });
        
        const entries = await fs.readdir(src, { withFileTypes: true });
        
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            
            if (entry.isDirectory()) {
                await this.copyDirectory(srcPath, destPath);
            } else {
                await fs.copyFile(srcPath, destPath);
            }
        }
    }
    
    /**
     * Get Express routers for all versions
     */
    getExpressRouters() {
        const routers = new Map();
        
        for (const [version, integration] of this.swaggerIntegrations) {
            routers.set(version, integration.getRouter());
        }
        
        return routers;
    }
    
    /**
     * Add route to specific version
     */
    addRoute(version, method, path, definition) {
        const generator = this.generators.get(version);
        const integration = this.swaggerIntegrations.get(version);
        
        if (generator) {
            generator.addRoute(method, path, definition);
        }
        
        if (integration) {
            integration.addRoute(method, path, definition);
        }
        
        this.logger.debug(`Route added to version ${version}: ${method} ${path}`);
    }
    
    /**
     * Add schema to specific version
     */
    addSchema(version, name, schema) {
        const generator = this.generators.get(version);
        const integration = this.swaggerIntegrations.get(version);
        
        if (generator) {
            generator.addSchema(name, schema);
        }
        
        if (integration) {
            integration.addSchema(name, schema);
        }
        
        this.logger.debug(`Schema added to version ${version}: ${name}`);
    }
    
    /**
     * Get documentation statistics
     */
    getStats() {
        const versionStats = {};
        
        for (const [version, generator] of this.generators) {
            versionStats[version] = generator.getSpecificationSummary();
        }
        
        return {
            ...this.stats,
            versions: versionStats,
            watchers: this.watchers.size,
            publishingTargets: this.options.publishingTargets.length
        };
    }
    
    /**
     * Cleanup resources
     */
    async cleanup() {
        this.logger.info('Cleaning up API Documentation Manager...');
        
        // Clear regeneration timeout
        if (this.regenerationTimeout) {
            clearTimeout(this.regenerationTimeout);
        }
        
        // Close file watchers
        for (const watcher of this.watchers) {
            watcher.close();
        }
        this.watchers.clear();
        
        // Cleanup Swagger integrations
        for (const integration of this.swaggerIntegrations.values()) {
            await integration.cleanup();
        }
        
        this.emit('cleanup');
    }
}

export default APIDocumentationManager;