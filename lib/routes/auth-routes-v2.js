/**
 * Authentication Routes with API Versioning
 * Demonstrates how to implement versioned routes
 */

import { VersionedRouteBuilder } from '../api/versioned-routes.js';
import { TwoFactorAuth, TwoFactorRateLimiter } from '../auth/two-factor-auth.js';

export function createVersionedAuthRoutes(versionedRouter, securityMiddleware, authManager) {
  const routes = new VersionedRouteBuilder(versionedRouter);
  
  // Two-factor auth instances
  const twoFactorAuth = authManager.twoFactorAuth || new TwoFactorAuth();
  const twoFactorRateLimiter = new TwoFactorRateLimiter();
  
  // ============ V1 + V2 Routes ============
  
  // Login endpoint - available in v1 and v2
  routes.versions('1', '2')
    .post('/api/auth/login', async (req, res, next) => {
      try {
        const { username, password, twoFactorCode } = req.body;
        
        if (!username || !password) {
          return res.status(400).json({
            success: false,
            error: 'Username and password are required'
          });
        }
        
        const result = await authManager.authenticateUser({
          username,
          password,
          twoFactorCode,
          ipAddress: req.security?.ip || req.ip,
          userAgent: req.headers['user-agent']
        });
        
        if (result.user) {
          const session = await req.createSession(result.user.id, {
            username: result.user.username,
            role: result.user.role,
            permissions: result.user.permissions
          });
          
          // V1 response format
          if (req.apiVersion === '1') {
            res.json({
              success: true,
              user_id: result.user.id,
              username: result.user.username,
              token: session.token,
              expires_at: session.expiresAt
            });
          } 
          // V2 response format
          else {
            res.json({
              success: true,
              user: {
                id: result.user.id,
                username: result.user.username,
                role: result.user.role
              },
              session: {
                token: session.token,
                expiresAt: session.expiresAt
              }
            });
          }
        } else {
          res.status(401).json({
            success: false,
            error: 'Invalid credentials'
          });
        }
      } catch (error) {
        next(error);
      }
    });
  
  // Logout - same for v1 and v2
  routes.versions('1', '2')
    .post('/api/auth/logout', securityMiddleware.requireAuth(), async (req, res, next) => {
      try {
        if (req.session) {
          await req.session.destroy();
        }
        
        res.json({ 
          success: true, 
          message: 'Logged out successfully' 
        });
      } catch (error) {
        next(error);
      }
    });
  
  // ============ V2 Only Routes ============
  
  // Session info - enhanced in v2
  routes.versions('2')
    .get('/api/auth/session', securityMiddleware.requireAuth(), (req, res) => {
      res.json({
        success: true,
        session: {
          userId: req.userId,
          data: req.session.data,
          expiresAt: req.session.expiresAt,
          createdAt: req.session.createdAt,
          lastActivity: req.session.lastActivity
        }
      });
    });
  
  // API Key management - v2 only
  routes.versions('2')
    .get('/api/keys', securityMiddleware.requireAuth(), async (req, res, next) => {
      try {
        const keys = await securityMiddleware.apiKeyManager.listKeys(req.userId, {
          includeRevoked: req.query.includeRevoked === 'true',
          includeExpired: req.query.includeExpired === 'true'
        });
        
        res.json({
          success: true,
          keys: keys.map(key => ({
            id: key.id,
            name: key.name,
            prefix: key.key_prefix,
            permissions: key.permissions,
            scopes: key.scopes,
            status: key.status,
            lastUsed: key.last_used_at,
            usageCount: key.usage_count,
            expiresAt: key.expires_at,
            createdAt: key.created_at
          }))
        });
      } catch (error) {
        next(error);
      }
    })
    .post('/api/keys', securityMiddleware.requireAuth(), async (req, res, next) => {
      try {
        const { name, permissions, scopes, expiresIn, ipWhitelist, rateLimit } = req.body;
        
        if (!name) {
          return res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'API key name is required'
            }
          });
        }
        
        const key = await securityMiddleware.apiKeyManager.generateKey(req.userId, {
          name,
          permissions: permissions || ['read'],
          scopes: scopes || [],
          expiresIn,
          ipWhitelist,
          rateLimit
        });
        
        res.json({
          success: true,
          key: {
            id: key.id,
            key: key.key,
            name: key.name,
            prefix: key.prefix,
            permissions: key.permissions,
            scopes: key.scopes,
            expiresAt: key.expiresAt,
            createdAt: key.createdAt
          },
          warning: 'Save this API key securely. You will not be able to see it again.'
        });
      } catch (error) {
        next(error);
      }
    });
  
  // 2FA endpoints - v2 only
  routes.versions('2')
    .post('/api/auth/2fa/generate', securityMiddleware.requireAuth(), async (req, res, next) => {
      try {
        const user = req.session?.data || req.user;
        const result = await twoFactorAuth.generateSecret(
          req.userId, 
          user.email || user.username
        );
        
        res.json({
          success: true,
          secret: result.secret,
          qrCode: result.qrCode,
          manualEntry: result.manualEntry
        });
      } catch (error) {
        next(error);
      }
    })
    .post('/api/auth/2fa/enable', securityMiddleware.requireAuth(), async (req, res, next) => {
      try {
        const { token } = req.body;
        
        if (!token) {
          return res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Verification token is required'
            }
          });
        }
        
        if (twoFactorRateLimiter.isBlocked(req.userId)) {
          return res.status(429).json({
            error: {
              code: 'RATE_LIMIT_EXCEEDED',
              message: 'Too many failed attempts. Please try again later.'
            }
          });
        }
        
        try {
          const result = await twoFactorAuth.enableTwoFactor(req.userId, token);
          twoFactorRateLimiter.clearAttempts(req.userId);
          
          res.json({
            success: true,
            backupCodes: result.backupCodes,
            message: '2FA enabled successfully'
          });
        } catch (error) {
          const rateLimit = twoFactorRateLimiter.recordFailedAttempt(req.userId);
          
          if (rateLimit.blocked) {
            return res.status(429).json({
              error: {
                code: 'ACCOUNT_LOCKED',
                message: 'Too many failed attempts. Account temporarily locked.',
                retryAfter: Math.ceil(rateLimit.remainingTime / 1000)
              }
            });
          }
          
          return res.status(400).json({
            error: {
              code: 'INVALID_TOKEN',
              message: error.message,
              remainingAttempts: rateLimit.remainingAttempts
            }
          });
        }
      } catch (error) {
        next(error);
      }
    });
  
  // ============ V3 Preview Routes ============
  
  // OAuth2 support - v3 only
  routes.versions('3')
    .post('/api/auth/oauth/authorize', async (req, res, next) => {
      try {
        // OAuth2 authorization endpoint
        res.json({
          message: 'OAuth2 support coming in v3',
          preview: true
        });
      } catch (error) {
        next(error);
      }
    })
    .post('/api/auth/oauth/token', async (req, res, next) => {
      try {
        // OAuth2 token endpoint
        res.json({
          message: 'OAuth2 support coming in v3',
          preview: true
        });
      } catch (error) {
        next(error);
      }
    });
  
  // Batch operations - v3 only
  routes.versions('3')
    .post('/api/auth/batch', securityMiddleware.requireAuth(), async (req, res, next) => {
      try {
        const { operations } = req.body;
        
        if (!Array.isArray(operations)) {
          return res.status(400).json({
            error: {
              code: 'INVALID_REQUEST',
              message: 'Operations must be an array'
            }
          });
        }
        
        // Process batch operations
        const results = [];
        for (const op of operations) {
          // Process each operation
          results.push({
            id: op.id,
            status: 'preview',
            message: 'Batch operations coming in v3'
          });
        }
        
        res.json({
          success: true,
          results
        });
      } catch (error) {
        next(error);
      }
    });
}

export default createVersionedAuthRoutes;