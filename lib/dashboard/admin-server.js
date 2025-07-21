/**
 * Admin Dashboard Server for Otedama
 * Lightweight web interface for system administration
 * 
 * Design principles:
 * - Performance-first with minimal dependencies (Carmack)
 * - Clean separation of API and UI (Martin)
 * - Simple and powerful interface (Pike)
 */

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { logger } from '../core/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class AdminDashboardServer {
    constructor(config = {}) {
        this.config = {
            port: config.port || 3001,
            host: config.host || 'localhost',
            enableAuth: config.enableAuth !== false,
            enableSSL: config.enableSSL || false,
            publicPath: config.publicPath || join(__dirname, '../../public/admin'),
            apiPrefix: config.apiPrefix || '/admin/api',
            ...config
        };
        
        this.server = null;
        this.services = config.services || {};
        this.isRunning = false;
        
        // Request statistics
        this.stats = {
            totalRequests: 0,
            apiRequests: 0,
            staticRequests: 0,
            errors: 0,
            startTime: Date.now()
        };
    }
    
    /**
     * Start admin dashboard server
     */
    async start() {
        if (this.isRunning) {
            throw new Error('Admin dashboard already running');
        }
        
        this.server = createServer(async (req, res) => {
            await this.handleRequest(req, res);
        });
        
        return new Promise((resolve, reject) => {
            this.server.listen(this.config.port, this.config.host, () => {
                this.isRunning = true;
                logger.info(`Admin dashboard running at http://${this.config.host}:${this.config.port}`);
                resolve();
            });
            
            this.server.on('error', (error) => {
                logger.error('Admin dashboard server error:', error);
                reject(error);
            });
        });
    }
    
    /**
     * Stop admin dashboard server
     */
    async stop() {
        if (!this.isRunning || !this.server) {
            return;
        }
        
        return new Promise((resolve) => {
            this.server.close(() => {
                this.isRunning = false;
                logger.info('Admin dashboard stopped');
                resolve();
            });
        });
    }
    
    /**
     * Handle incoming requests
     */
    async handleRequest(req, res) {
        this.stats.totalRequests++;
        
        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        
        if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            res.end();
            return;
        }
        
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const pathname = url.pathname;
            
            // Handle API routes
            if (pathname.startsWith(this.config.apiPrefix)) {
                this.stats.apiRequests++;
                await this.handleAPIRequest(req, res, pathname.slice(this.config.apiPrefix.length));
            }
            // Handle static files
            else {
                this.stats.staticRequests++;
                await this.handleStaticRequest(req, res, pathname);
            }
        } catch (error) {
            this.stats.errors++;
            logger.error('Request handling error:', error);
            
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }
    
    /**
     * Handle API requests
     */
    async handleAPIRequest(req, res, path) {
        res.setHeader('Content-Type', 'application/json');
        
        // System overview
        if (path === '/overview' && req.method === 'GET') {
            const overview = await this.getSystemOverview();
            res.end(JSON.stringify(overview));
        }
        // Mining stats
        else if (path === '/mining' && req.method === 'GET') {
            const stats = await this.getMiningStats();
            res.end(JSON.stringify(stats));
        }
        // DEX stats
        else if (path === '/dex' && req.method === 'GET') {
            const stats = await this.getDEXStats();
            res.end(JSON.stringify(stats));
        }
        // Network stats
        else if (path === '/network' && req.method === 'GET') {
            const stats = await this.getNetworkStats();
            res.end(JSON.stringify(stats));
        }
        // Performance metrics
        else if (path === '/performance' && req.method === 'GET') {
            const metrics = await this.getPerformanceMetrics();
            res.end(JSON.stringify(metrics));
        }
        // Security status
        else if (path === '/security' && req.method === 'GET') {
            const status = await this.getSecurityStatus();
            res.end(JSON.stringify(status));
        }
        // Active alerts
        else if (path === '/alerts' && req.method === 'GET') {
            const alerts = await this.getActiveAlerts();
            res.end(JSON.stringify(alerts));
        }
        // System configuration
        else if (path === '/config' && req.method === 'GET') {
            const config = await this.getSystemConfig();
            res.end(JSON.stringify(config));
        }
        // Update configuration
        else if (path === '/config' && req.method === 'POST') {
            await this.updateSystemConfig(req, res);
        }
        // System control
        else if (path === '/control' && req.method === 'POST') {
            await this.handleSystemControl(req, res);
        }
        else {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'API endpoint not found' }));
        }
    }
    
    /**
     * Handle static file requests
     */
    async handleStaticRequest(req, res, pathname) {
        // Default to index.html
        if (pathname === '/' || pathname === '') {
            pathname = '/index.html';
        }
        
        const filePath = join(this.config.publicPath, pathname);
        const ext = extname(filePath).toLowerCase();
        
        // Security check - prevent directory traversal
        if (!filePath.startsWith(this.config.publicPath)) {
            res.statusCode = 403;
            res.end('Forbidden');
            return;
        }
        
        try {
            const content = await readFile(filePath);
            
            // Set content type
            const contentTypes = {
                '.html': 'text/html',
                '.css': 'text/css',
                '.js': 'application/javascript',
                '.json': 'application/json',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.svg': 'image/svg+xml',
                '.ico': 'image/x-icon'
            };
            
            res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
            
            // Cache static assets
            if (ext !== '.html') {
                res.setHeader('Cache-Control', 'public, max-age=3600');
            }
            
            res.end(content);
        } catch (error) {
            if (error.code === 'ENOENT') {
                // Try to serve index.html for SPA routes
                if (!ext) {
                    try {
                        const indexContent = await readFile(join(this.config.publicPath, 'index.html'));
                        res.setHeader('Content-Type', 'text/html');
                        res.end(indexContent);
                        return;
                    } catch {}
                }
                
                res.statusCode = 404;
                res.end('Not found');
            } else {
                throw error;
            }
        }
    }
    
    /**
     * Get system overview
     */
    async getSystemOverview() {
        const overview = {
            system: {
                name: 'Otedama',
                uptime: Date.now() - this.stats.startTime,
                version: '1.0.0',
                environment: process.env.NODE_ENV || 'development'
            },
            status: {
                mining: this.services.miningPool ? 'active' : 'inactive',
                dex: this.services.dexEngine ? 'active' : 'inactive',
                network: this.services.p2pController ? 'active' : 'inactive',
                monitoring: this.services.monitoringManager ? 'active' : 'inactive'
            },
            resources: {
                memory: process.memoryUsage(),
                cpu: process.cpuUsage(),
                connections: 0 // Would get from services
            },
            requests: this.stats
        };
        
        return overview;
    }
    
    /**
     * Get mining statistics
     */
    async getMiningStats() {
        if (!this.services.miningPool) {
            return { error: 'Mining pool not available' };
        }
        
        const pool = this.services.miningPool;
        const stats = await pool.getStats();
        
        return {
            hashrate: stats.poolHashrate || 0,
            workers: stats.activeWorkers || 0,
            shares: {
                accepted: stats.totalSharesAccepted || 0,
                rejected: stats.totalSharesRejected || 0,
                stale: stats.totalSharesStale || 0
            },
            blocks: {
                found: stats.blocksFound || 0,
                pending: stats.blocksPending || 0,
                confirmed: stats.blocksConfirmed || 0
            },
            algorithms: stats.algorithms || [],
            profitability: stats.profitability || {}
        };
    }
    
    /**
     * Get DEX statistics
     */
    async getDEXStats() {
        if (!this.services.dexEngine) {
            return { error: 'DEX engine not available' };
        }
        
        const dex = this.services.dexEngine;
        const metrics = dex.getMetrics();
        
        return {
            trades: {
                total: metrics.totalTrades || 0,
                volume: metrics.totalVolume || 0,
                activeOrders: metrics.activeOrders || 0
            },
            liquidity: {
                pools: metrics.liquidityPools || 0,
                totalLocked: metrics.totalValueLocked || 0
            },
            crossChain: {
                transfers: metrics.crossChainBridge?.totalTransfers || 0,
                volume: metrics.crossChainBridge?.totalVolume || 0,
                activeChains: metrics.crossChainBridge?.activeChains || 0
            },
            performance: {
                ordersPerSecond: metrics.matchingEngine?.throughput || 0,
                avgExecutionTime: metrics.avgExecutionTime || 0
            }
        };
    }
    
    /**
     * Get network statistics
     */
    async getNetworkStats() {
        if (!this.services.p2pController) {
            return { error: 'P2P network not available' };
        }
        
        const p2p = this.services.p2pController;
        const stats = p2p.getNetworkStats();
        
        return {
            peers: {
                total: stats.totalPeers || 0,
                active: stats.activePeers || 0,
                incoming: stats.incomingConnections || 0,
                outgoing: stats.outgoingConnections || 0
            },
            bandwidth: {
                upload: stats.uploadBandwidth || 0,
                download: stats.downloadBandwidth || 0
            },
            messages: {
                sent: stats.messagesSent || 0,
                received: stats.messagesReceived || 0
            },
            topology: stats.networkTopology || {}
        };
    }
    
    /**
     * Get performance metrics
     */
    async getPerformanceMetrics() {
        if (!this.services.monitoringManager) {
            return { error: 'Monitoring not available' };
        }
        
        const monitoring = this.services.monitoringManager;
        const metrics = await monitoring.getStats();
        
        return {
            system: metrics.system || {},
            application: metrics.application || {},
            database: metrics.database || {},
            cache: metrics.cache || {},
            alerts: metrics.alerts || []
        };
    }
    
    /**
     * Get security status
     */
    async getSecurityStatus() {
        if (!this.services.securityManager) {
            return { error: 'Security manager not available' };
        }
        
        const security = this.services.securityManager;
        const status = security.getStatus();
        
        return {
            authentication: {
                activeUsers: status.activeUsers || 0,
                failedAttempts: status.failedLoginAttempts || 0,
                blockedIPs: status.blockedIPs || 0
            },
            threats: {
                detected: status.threatsDetected || 0,
                blocked: status.threatsBlocked || 0
            },
            audit: {
                events: status.auditEvents || 0,
                violations: status.securityViolations || 0
            },
            certificates: status.certificates || {}
        };
    }
    
    /**
     * Get active alerts
     */
    async getActiveAlerts() {
        if (!this.services.alertManager) {
            return { error: 'Alert manager not available' };
        }
        
        const alertManager = this.services.alertManager;
        const alerts = alertManager.alertSystem.getActiveAlerts();
        
        return {
            active: alerts,
            total: alerts.length,
            critical: alerts.filter(a => a.severity === 'critical').length,
            high: alerts.filter(a => a.severity === 'high').length,
            medium: alerts.filter(a => a.severity === 'medium').length,
            low: alerts.filter(a => a.severity === 'low').length
        };
    }
    
    /**
     * Get system configuration (sanitized)
     */
    async getSystemConfig() {
        // Return sanitized configuration
        return {
            mining: {
                algorithms: ['SHA256', 'Scrypt', 'Ethash', 'RandomX', 'KawPow'],
                poolFee: 1.0,
                minPayout: 0.001,
                confirmations: 6
            },
            dex: {
                makerFee: 0.1,
                takerFee: 0.2,
                minOrderSize: 0.00001,
                maxOrdersPerUser: 1000
            },
            network: {
                maxPeers: 50,
                port: 8333,
                enableUPnP: true
            },
            security: {
                enableTwoFactor: true,
                sessionTimeout: 3600,
                maxLoginAttempts: 5
            }
        };
    }
    
    /**
     * Update system configuration
     */
    async updateSystemConfig(req, res) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const config = JSON.parse(body);
                
                // Validate and apply configuration
                // This would update the actual system configuration
                logger.info('System configuration updated:', config);
                
                res.end(JSON.stringify({ success: true }));
            } catch (error) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    }
    
    /**
     * Handle system control commands
     */
    async handleSystemControl(req, res) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const command = JSON.parse(body);
                
                switch (command.action) {
                    case 'restart':
                        logger.info('System restart requested');
                        res.end(JSON.stringify({ success: true, message: 'Restart initiated' }));
                        break;
                        
                    case 'backup':
                        logger.info('System backup requested');
                        res.end(JSON.stringify({ success: true, message: 'Backup started' }));
                        break;
                        
                    case 'clear-cache':
                        if (this.services.cache) {
                            await this.services.cache.clear();
                        }
                        res.end(JSON.stringify({ success: true, message: 'Cache cleared' }));
                        break;
                        
                    default:
                        res.statusCode = 400;
                        res.end(JSON.stringify({ error: 'Unknown action' }));
                }
            } catch (error) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    }
}

export default AdminDashboardServer;