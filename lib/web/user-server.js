/**
 * User Web Interface Server for Otedama
 * Provides public-facing web interface for mining, trading, and DeFi
 * 
 * Design principles:
 * - Lightweight and responsive (Carmack)
 * - Clean API separation (Martin)
 * - Simple user experience (Pike)
 */

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { logger } from '../core/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class UserWebServer {
    constructor(config = {}) {
        this.config = {
            port: config.port || 3000,
            host: config.host || 'localhost',
            publicPath: config.publicPath || join(__dirname, '../../public/app'),
            apiPrefix: config.apiPrefix || '/api',
            enableCORS: config.enableCORS !== false,
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
            uniqueUsers: new Set(),
            startTime: Date.now()
        };
    }
    
    /**
     * Start user web server
     */
    async start() {
        if (this.isRunning) {
            throw new Error('User web server already running');
        }
        
        this.server = createServer(async (req, res) => {
            await this.handleRequest(req, res);
        });
        
        return new Promise((resolve, reject) => {
            this.server.listen(this.config.port, this.config.host, () => {
                this.isRunning = true;
                logger.info(`User web interface running at http://${this.config.host}:${this.config.port}`);
                resolve();
            });
            
            this.server.on('error', (error) => {
                logger.error('User web server error:', error);
                reject(error);
            });
        });
    }
    
    /**
     * Stop user web server
     */
    async stop() {
        if (!this.isRunning || !this.server) {
            return;
        }
        
        return new Promise((resolve) => {
            this.server.close(() => {
                this.isRunning = false;
                logger.info('User web server stopped');
                resolve();
            });
        });
    }
    
    /**
     * Handle incoming requests
     */
    async handleRequest(req, res) {
        this.stats.totalRequests++;
        
        // Track unique users by IP
        const userIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        this.stats.uniqueUsers.add(userIP);
        
        // Set CORS headers
        if (this.config.enableCORS) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        }
        
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
        
        // User account endpoints
        if (path === '/account' && req.method === 'GET') {
            const account = await this.getUserAccount(req);
            res.end(JSON.stringify(account));
        }
        // Mining endpoints
        else if (path === '/mining/stats' && req.method === 'GET') {
            const stats = await this.getUserMiningStats(req);
            res.end(JSON.stringify(stats));
        }
        else if (path === '/mining/workers' && req.method === 'GET') {
            const workers = await this.getUserWorkers(req);
            res.end(JSON.stringify(workers));
        }
        // DEX endpoints
        else if (path === '/dex/markets' && req.method === 'GET') {
            const markets = await this.getMarkets();
            res.end(JSON.stringify(markets));
        }
        else if (path === '/dex/orderbook' && req.method === 'GET') {
            const orderbook = await this.getOrderbook(req);
            res.end(JSON.stringify(orderbook));
        }
        else if (path === '/dex/orders' && req.method === 'GET') {
            const orders = await this.getUserOrders(req);
            res.end(JSON.stringify(orders));
        }
        else if (path === '/dex/order' && req.method === 'POST') {
            await this.createOrder(req, res);
        }
        // DeFi endpoints
        else if (path === '/defi/pools' && req.method === 'GET') {
            const pools = await this.getLiquidityPools();
            res.end(JSON.stringify(pools));
        }
        else if (path === '/defi/positions' && req.method === 'GET') {
            const positions = await this.getUserPositions(req);
            res.end(JSON.stringify(positions));
        }
        else if (path === '/defi/stake' && req.method === 'POST') {
            await this.stakeTokens(req, res);
        }
        // Portfolio overview
        else if (path === '/portfolio' && req.method === 'GET') {
            const portfolio = await this.getPortfolio(req);
            res.end(JSON.stringify(portfolio));
        }
        // Price feeds
        else if (path === '/prices' && req.method === 'GET') {
            const prices = await this.getPrices();
            res.end(JSON.stringify(prices));
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
                '.ico': 'image/x-icon',
                '.woff': 'font/woff',
                '.woff2': 'font/woff2'
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
     * Get user account info
     */
    async getUserAccount(req) {
        // Extract user from authorization header
        const userAddress = this.extractUserAddress(req);
        
        return {
            address: userAddress,
            balance: {
                BTC: 0.0,
                ETH: 0.0,
                USDT: 0.0
            },
            mining: {
                totalEarned: 0.0,
                pendingPayout: 0.0,
                lastPayout: null
            },
            trading: {
                totalVolume: 0.0,
                openOrders: 0,
                completedTrades: 0
            },
            defi: {
                totalStaked: 0.0,
                totalLiquidity: 0.0,
                rewards: 0.0
            }
        };
    }
    
    /**
     * Get user mining statistics
     */
    async getUserMiningStats(req) {
        const userAddress = this.extractUserAddress(req);
        
        if (!this.services.miningPool) {
            return { error: 'Mining pool not available' };
        }
        
        const pool = this.services.miningPool;
        const userStats = await pool.getUserStats(userAddress);
        
        return {
            hashrate: userStats?.hashrate || 0,
            shares: {
                accepted: userStats?.acceptedShares || 0,
                rejected: userStats?.rejectedShares || 0,
                efficiency: userStats?.efficiency || 0
            },
            earnings: {
                total: userStats?.totalEarnings || 0,
                pending: userStats?.pendingBalance || 0,
                paid: userStats?.totalPaid || 0
            },
            workers: userStats?.workerCount || 0
        };
    }
    
    /**
     * Get user workers
     */
    async getUserWorkers(req) {
        const userAddress = this.extractUserAddress(req);
        
        if (!this.services.miningPool) {
            return { error: 'Mining pool not available' };
        }
        
        const pool = this.services.miningPool;
        const workers = await pool.getUserWorkers(userAddress);
        
        return {
            workers: workers || [],
            total: workers?.length || 0
        };
    }
    
    /**
     * Get DEX markets
     */
    async getMarkets() {
        if (!this.services.dexEngine) {
            return { error: 'DEX not available' };
        }
        
        const dex = this.services.dexEngine;
        const markets = dex.getMarkets();
        
        return {
            markets: markets || [],
            total: markets?.length || 0
        };
    }
    
    /**
     * Get orderbook for market
     */
    async getOrderbook(req) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const market = url.searchParams.get('market');
        
        if (!market) {
            return { error: 'Market parameter required' };
        }
        
        if (!this.services.dexEngine) {
            return { error: 'DEX not available' };
        }
        
        const dex = this.services.dexEngine;
        const orderbook = dex.getOrderbook(market);
        
        return orderbook || { bids: [], asks: [] };
    }
    
    /**
     * Get user orders
     */
    async getUserOrders(req) {
        const userAddress = this.extractUserAddress(req);
        
        if (!this.services.dexEngine) {
            return { error: 'DEX not available' };
        }
        
        const dex = this.services.dexEngine;
        const orders = dex.getUserOrders(userAddress);
        
        return {
            orders: orders || [],
            total: orders?.length || 0
        };
    }
    
    /**
     * Create new order
     */
    async createOrder(req, res) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const order = JSON.parse(body);
                const userAddress = this.extractUserAddress(req);
                
                if (!this.services.dexEngine) {
                    res.statusCode = 503;
                    res.end(JSON.stringify({ error: 'DEX not available' }));
                    return;
                }
                
                const dex = this.services.dexEngine;
                const result = await dex.createOrder({
                    ...order,
                    user: userAddress
                });
                
                res.end(JSON.stringify(result));
            } catch (error) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    }
    
    /**
     * Get liquidity pools
     */
    async getLiquidityPools() {
        if (!this.services.dexEngine) {
            return { error: 'DeFi not available' };
        }
        
        const dex = this.services.dexEngine;
        const pools = dex.getLiquidityPools();
        
        return {
            pools: pools || [],
            total: pools?.length || 0
        };
    }
    
    /**
     * Get user DeFi positions
     */
    async getUserPositions(req) {
        const userAddress = this.extractUserAddress(req);
        
        if (!this.services.dexEngine) {
            return { error: 'DeFi not available' };
        }
        
        const dex = this.services.dexEngine;
        const positions = dex.getUserPositions(userAddress);
        
        return {
            positions: positions || [],
            total: positions?.length || 0
        };
    }
    
    /**
     * Stake tokens
     */
    async stakeTokens(req, res) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const stake = JSON.parse(body);
                const userAddress = this.extractUserAddress(req);
                
                if (!this.services.dexEngine) {
                    res.statusCode = 503;
                    res.end(JSON.stringify({ error: 'DeFi not available' }));
                    return;
                }
                
                const dex = this.services.dexEngine;
                const result = await dex.stake({
                    ...stake,
                    user: userAddress
                });
                
                res.end(JSON.stringify(result));
            } catch (error) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    }
    
    /**
     * Get user portfolio
     */
    async getPortfolio(req) {
        const userAddress = this.extractUserAddress(req);
        
        const [account, miningStats, orders, positions] = await Promise.all([
            this.getUserAccount(req),
            this.getUserMiningStats(req),
            this.getUserOrders(req),
            this.getUserPositions(req)
        ]);
        
        return {
            address: userAddress,
            totalValue: 0, // Calculate based on current prices
            assets: account.balance,
            mining: miningStats,
            trading: {
                openOrders: orders.total,
                volume24h: 0
            },
            defi: {
                positions: positions.total,
                totalStaked: 0
            }
        };
    }
    
    /**
     * Get current prices
     */
    async getPrices() {
        if (!this.services.priceFeed) {
            return { error: 'Price feed not available' };
        }
        
        const priceFeed = this.services.priceFeed;
        const prices = await priceFeed.getCurrentPrices();
        
        return prices || {};
    }
    
    /**
     * Extract user address from request
     */
    extractUserAddress(req) {
        // In production, this would extract from JWT or session
        const auth = req.headers.authorization;
        if (auth && auth.startsWith('Bearer ')) {
            return auth.slice(7); // Remove 'Bearer ' prefix
        }
        return 'anonymous';
    }
}

export default UserWebServer;