/**
 * Setup Versioned API for Otedama
 * Integrates API versioning into the application
 * 
 * Design principles:
 * - Carmack: Minimal setup overhead
 * - Martin: Clean integration
 * - Pike: Simple configuration
 */

import express from 'express';
import { createVersionedApi, createVersionDiscoveryRoute, createDeprecationRoute } from './versioned-routes.js';
import { createVersionedAuthRoutes } from '../routes/auth-routes-v2.js';
import { getLogger } from '../core/logger.js';

const logger = getLogger('SetupVersionedApi');

/**
 * Setup versioned API with all routes
 */
export function setupVersionedApi(app, middleware, managers) {
  const { securityMiddleware, authManager, miningManager, dexManager } = managers;
  
  // Create versioned API infrastructure
  const { versionManager, versionedRouter, router } = createVersionedApi({
    strategy: process.env.API_VERSION_STRATEGY || 'url_path',
    defaultVersion: process.env.API_DEFAULT_VERSION || '2',
    enableVersionNegotiation: true,
    enableDeprecationHeaders: true,
    enableVersionDiscovery: true,
    deprecationWarningDays: 90,
    sunsetGraceDays: 30
  });
  
  // Register authentication routes
  createVersionedAuthRoutes(versionedRouter, securityMiddleware, authManager);
  
  // Register mining routes
  registerMiningRoutes(versionedRouter, miningManager);
  
  // Register DEX routes
  registerDexRoutes(versionedRouter, dexManager);
  
  // Register user routes
  registerUserRoutes(versionedRouter, authManager);
  
  // Create the router
  const apiRouter = versionedRouter.createRouter();
  
  // Version discovery endpoints (available without version prefix)
  app.get('/api/versions', createVersionDiscoveryRoute(versionManager));
  app.get('/api/deprecation', createDeprecationRoute(versionManager));
  
  // Mount versioned API
  if (versionManager.options.strategy === 'url_path') {
    // URL path versioning: /api/v1/*, /api/v2/*, etc.
    app.use('/api/v:version', apiRouter);
    
    // Default version redirect
    app.use('/api', (req, res, next) => {
      if (req.path === '/' || req.path === '') {
        return res.redirect(`/api/v${versionManager.currentVersion}`);
      }
      // Redirect unversioned requests to default version
      req.url = `/v${versionManager.currentVersion}${req.url}`;
      next();
    });
  } else {
    // Other versioning strategies
    app.use('/api', apiRouter);
  }
  
  // API documentation per version
  app.get('/api/v:version/docs', (req, res) => {
    const version = req.params.version;
    const apiVersion = versionManager.versions.get(version);
    
    if (!apiVersion) {
      return res.status(404).json({
        error: 'Version not found'
      });
    }
    
    res.json({
      version,
      status: apiVersion.status,
      documentation: `/docs/api/v${version}`,
      openapi: `/api/v${version}/openapi.json`,
      changes: apiVersion.changes
    });
  });
  
  // Version migration guides
  app.get('/api/migration/:fromVersion-to-:toVersion', (req, res) => {
    const { fromVersion, toVersion } = req.params;
    
    res.json({
      from: fromVersion,
      to: toVersion,
      guide: getMigrationGuide(fromVersion, toVersion),
      examples: getMigrationExamples(fromVersion, toVersion)
    });
  });
  
  // Log API setup
  logger.info('Versioned API initialized', {
    strategy: versionManager.options.strategy,
    currentVersion: versionManager.currentVersion,
    supportedVersions: versionManager.getSupportedVersions()
  });
  
  return { versionManager, apiRouter };
}

/**
 * Register mining routes with versions
 */
function registerMiningRoutes(versionedRouter, miningManager) {
  const routes = versionedRouter;
  
  // V1 + V2: Basic mining operations
  routes.versions('1', '2')
    .post('/api/mining/submit', async (req, res, next) => {
      try {
        const { minerId, share } = req.body;
        
        // V1 uses different field names
        const shareData = req.apiVersion === '1' ? {
          ...share,
          minerID: minerId || share.miner_id,
          nonce: share.nonce || share.nonce_value
        } : share;
        
        const result = await miningManager.submitShare(shareData);
        
        res.json({
          success: true,
          accepted: result.accepted,
          difficulty: result.difficulty,
          // V2 adds more details
          ...(req.apiVersion === '2' && {
            shareId: result.shareId,
            reward: result.reward
          })
        });
      } catch (error) {
        next(error);
      }
    })
    .get('/api/mining/stats', async (req, res, next) => {
      try {
        const stats = await miningManager.getStats();
        
        if (req.apiVersion === '1') {
          // V1 format
          res.json({
            hashrate: stats.pool.hashrate,
            miners: stats.pool.activeMiners,
            difficulty: stats.network.difficulty
          });
        } else {
          // V2 format
          res.json(stats);
        }
      } catch (error) {
        next(error);
      }
    });
  
  // V2 only: Advanced mining features
  routes.versions('2')
    .get('/api/mining/miners/:minerId', async (req, res, next) => {
      try {
        const miner = await miningManager.getMiner(req.params.minerId);
        res.json({
          success: true,
          miner
        });
      } catch (error) {
        next(error);
      }
    })
    .post('/api/mining/payout/request', async (req, res, next) => {
      try {
        const result = await miningManager.requestPayout(req.userId);
        res.json({
          success: true,
          payout: result
        });
      } catch (error) {
        next(error);
      }
    });
  
  // V3 preview: Stratum v2 support
  routes.versions('3')
    .post('/api/mining/stratum2/negotiate', async (req, res, next) => {
      res.json({
        message: 'Stratum v2 support coming in API v3',
        preview: true
      });
    });
}

/**
 * Register DEX routes with versions
 */
function registerDexRoutes(versionedRouter, dexManager) {
  const routes = versionedRouter;
  
  // V1 + V2: Basic trading
  routes.versions('1', '2')
    .post('/api/dex/orders', async (req, res, next) => {
      try {
        const order = req.apiVersion === '1' ? 
          convertV1OrderToV2(req.body) : req.body;
        
        const result = await dexManager.createOrder(order);
        
        res.json({
          success: true,
          order: req.apiVersion === '1' ? 
            convertV2OrderToV1(result) : result
        });
      } catch (error) {
        next(error);
      }
    })
    .get('/api/dex/orderbook/:pair', async (req, res, next) => {
      try {
        const orderbook = await dexManager.getOrderbook(req.params.pair);
        
        if (req.apiVersion === '1') {
          // V1 uses different structure
          res.json({
            bids: orderbook.bids.map(b => [b.price, b.amount]),
            asks: orderbook.asks.map(a => [a.price, a.amount])
          });
        } else {
          res.json(orderbook);
        }
      } catch (error) {
        next(error);
      }
    });
  
  // V2 only: AMM and advanced features
  routes.versions('2')
    .post('/api/dex/swap', async (req, res, next) => {
      try {
        const result = await dexManager.executeSwap(req.body);
        res.json({
          success: true,
          swap: result
        });
      } catch (error) {
        next(error);
      }
    })
    .post('/api/dex/liquidity/add', async (req, res, next) => {
      try {
        const result = await dexManager.addLiquidity(req.body);
        res.json({
          success: true,
          position: result
        });
      } catch (error) {
        next(error);
      }
    });
}

/**
 * Register user routes with versions
 */
function registerUserRoutes(versionedRouter, authManager) {
  const routes = versionedRouter;
  
  // All versions
  routes.versions('1', '2', '3')
    .get('/api/users/profile', async (req, res, next) => {
      try {
        const user = await authManager.getUser(req.userId);
        
        // Apply version-specific transformations
        const profile = req.apiVersion === '1' ? {
          id: user.id,
          username: user.username,
          created: user.createdAt
        } : {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt
        };
        
        res.json({
          success: true,
          profile
        });
      } catch (error) {
        next(error);
      }
    });
}

/**
 * Migration guides
 */
function getMigrationGuide(fromVersion, toVersion) {
  const guides = {
    '1->2': {
      summary: 'Migrate from API v1 to v2',
      steps: [
        'Update authentication to use new session format',
        'Convert offset-based pagination to page-based',
        'Update error handling to use new error format',
        'Add support for new 2FA endpoints',
        'Update field names (created -> createdAt, etc.)'
      ],
      breaking: [
        'Session token format changed',
        'Error response structure changed',
        'Some field names changed to camelCase'
      ]
    },
    '2->3': {
      summary: 'Migrate from API v2 to v3',
      steps: [
        'Implement OAuth2 authentication flow',
        'Add support for batch operations',
        'Update to GraphQL endpoints where available',
        'Implement webhook handlers'
      ],
      breaking: [
        'Authentication header format changed',
        'Some REST endpoints replaced with GraphQL'
      ]
    }
  };
  
  return guides[`${fromVersion}->${toVersion}`] || {
    summary: 'No migration guide available',
    steps: [],
    breaking: []
  };
}

/**
 * Migration examples
 */
function getMigrationExamples(fromVersion, toVersion) {
  const examples = {
    '1->2': {
      authentication: {
        v1: {
          request: 'POST /api/v1/auth/login',
          response: {
            success: true,
            user_id: '123',
            token: 'abc123'
          }
        },
        v2: {
          request: 'POST /api/v2/auth/login',
          response: {
            success: true,
            user: { id: '123', username: 'user' },
            session: { token: 'abc123', expiresAt: '2024-01-01' }
          }
        }
      }
    }
  };
  
  return examples[`${fromVersion}->${toVersion}`] || {};
}

/**
 * Order format converters
 */
function convertV1OrderToV2(v1Order) {
  return {
    type: v1Order.order_type,
    side: v1Order.side,
    pair: v1Order.pair,
    price: v1Order.price,
    amount: v1Order.amount,
    userId: v1Order.user_id
  };
}

function convertV2OrderToV1(v2Order) {
  return {
    order_id: v2Order.id,
    order_type: v2Order.type,
    side: v2Order.side,
    pair: v2Order.pair,
    price: v2Order.price,
    amount: v2Order.amount,
    user_id: v2Order.userId,
    created: v2Order.createdAt
  };
}

export default setupVersionedApi;