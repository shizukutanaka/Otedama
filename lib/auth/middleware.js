/**
 * Authentication Middleware for Otedama
 * Provides JWT and API key authentication for all endpoints
 */

import { AuthenticationManager, Permission } from './authentication-manager.js';

/**
 * Create authentication middleware
 */
export function createAuthMiddleware(authManager) {
  return {
    /**
     * Require authentication (JWT or API key)
     */
    requireAuth: (req, res, next) => {
      try {
        // Check for Bearer token
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          const token = authHeader.substring(7);
          const payload = authManager.verifyAccessToken(token);
          
          if (payload) {
            req.user = {
              id: payload.userId,
              role: payload.role,
              permissions: payload.permissions,
              type: 'jwt'
            };
            return next ? next() : true;
          }
        }
        
        // Check for API key
        const apiKey = req.headers['x-api-key'] || req.query.apiKey;
        if (apiKey) {
          authManager.verifyApiKey(apiKey).then(keyInfo => {
            if (keyInfo) {
              req.user = {
                id: keyInfo.userId,
                permissions: keyInfo.permissions,
                type: 'apikey'
              };
              next ? next() : true;
            } else {
              res.statusCode = 401;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Invalid API key' }));
            }
          }).catch(error => {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Authentication error' }));
          });
          return;
        }
        
        // No valid authentication
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('WWW-Authenticate', 'Bearer realm="Otedama"');
        res.end(JSON.stringify({ error: 'Authentication required' }));
        
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Authentication error' }));
      }
    },
    
    /**
     * Require specific permission
     */
    requirePermission: (permission) => {
      return (req, res, next) => {
        if (!req.user) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Authentication required' }));
          return;
        }
        
        if (!authManager.hasPermission(req.user.permissions, permission)) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ 
            error: 'Insufficient permissions',
            required: permission.toString(2),
            current: req.user.permissions.toString(2)
          }));
          return;
        }
        
        next ? next() : true;
      };
    },
    
    /**
     * Optional authentication
     */
    optionalAuth: (req, res, next) => {
      try {
        // Try Bearer token
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          const token = authHeader.substring(7);
          const payload = authManager.verifyAccessToken(token);
          
          if (payload) {
            req.user = {
              id: payload.userId,
              role: payload.role,
              permissions: payload.permissions,
              type: 'jwt'
            };
          }
        }
        
        // Try API key
        const apiKey = req.headers['x-api-key'] || req.query.apiKey;
        if (apiKey && !req.user) {
          authManager.verifyApiKey(apiKey).then(keyInfo => {
            if (keyInfo) {
              req.user = {
                id: keyInfo.userId,
                permissions: keyInfo.permissions,
                type: 'apikey'
              };
            }
            next ? next() : true;
          }).catch(() => {
            next ? next() : true;
          });
          return;
        }
        
        next ? next() : true;
        
      } catch (error) {
        // Continue without auth
        next ? next() : true;
      }
    },
    
    /**
     * Require specific role
     */
    requireRole: (role) => {
      return (req, res, next) => {
        if (!req.user) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Authentication required' }));
          return;
        }
        
        if (req.user.role !== role) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ 
            error: 'Insufficient role',
            required: role,
            current: req.user.role
          }));
          return;
        }
        
        next ? next() : true;
      };
    },
    
    /**
     * Rate limiting per user
     */
    userRateLimit: (limit = 100, window = 60000) => {
      const requests = new Map();
      
      return (req, res, next) => {
        if (!req.user) {
          next ? next() : true;
          return;
        }
        
        const userId = req.user.id;
        const now = Date.now();
        const userRequests = requests.get(userId) || [];
        
        // Clean old requests
        const validRequests = userRequests.filter(time => time > now - window);
        
        if (validRequests.length >= limit) {
          res.statusCode = 429;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Retry-After', Math.ceil(window / 1000));
          res.end(JSON.stringify({ 
            error: 'Rate limit exceeded',
            limit,
            window,
            retryAfter: Math.ceil(window / 1000)
          }));
          return;
        }
        
        validRequests.push(now);
        requests.set(userId, validRequests);
        
        next ? next() : true;
      };
    }
  };
}

/**
 * Apply authentication to HTTP request handler
 */
export function withAuth(authManager, handler, options = {}) {
  const middleware = createAuthMiddleware(authManager);
  
  return async (req, res) => {
    // Apply authentication
    if (options.required !== false) {
      const authenticated = await new Promise(resolve => {
        middleware.requireAuth(req, res, () => resolve(true));
      });
      
      if (!authenticated) return;
    } else if (options.optional) {
      await new Promise(resolve => {
        middleware.optionalAuth(req, res, () => resolve(true));
      });
    }
    
    // Check permission
    if (options.permission) {
      const authorized = await new Promise(resolve => {
        middleware.requirePermission(options.permission)(req, res, () => resolve(true));
      });
      
      if (!authorized) return;
    }
    
    // Check role
    if (options.role) {
      const authorized = await new Promise(resolve => {
        middleware.requireRole(options.role)(req, res, () => resolve(true));
      });
      
      if (!authorized) return;
    }
    
    // Apply rate limiting
    if (options.rateLimit) {
      const allowed = await new Promise(resolve => {
        const limit = options.rateLimit.limit || 100;
        const window = options.rateLimit.window || 60000;
        middleware.userRateLimit(limit, window)(req, res, () => resolve(true));
      });
      
      if (!allowed) return;
    }
    
    // Call handler
    return handler(req, res);
  };
}

/**
 * Authentication route handlers
 */
export function createAuthRoutes(authManager) {
  return {
    /**
     * POST /api/auth/register
     */
    register: async (req, res) => {
      try {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const result = await authManager.register(data);
            
            res.statusCode = 201;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              success: true,
              userId: result.userId,
              apiKey: result.apiKey,
              message: result.message
            }));
          } catch (error) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: error.message }));
          }
        });
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Server error' }));
      }
    },
    
    /**
     * POST /api/auth/login
     */
    login: async (req, res) => {
      try {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            const userAgent = req.headers['user-agent'];
            
            const result = await authManager.login({
              ...data,
              ipAddress,
              userAgent
            });
            
            if (result.requiresTwoFactor) {
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                requiresTwoFactor: true,
                message: 'Please provide 2FA token'
              }));
              return;
            }
            
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              success: true,
              ...result
            }));
          } catch (error) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: error.message }));
          }
        });
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Server error' }));
      }
    },
    
    /**
     * POST /api/auth/logout
     */
    logout: async (req, res) => {
      try {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const data = body ? JSON.parse(body) : {};
            const result = await authManager.logout(
              data.sessionId || req.headers['x-session-id'],
              data.refreshToken
            );
            
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
          } catch (error) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: error.message }));
          }
        });
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Server error' }));
      }
    },
    
    /**
     * POST /api/auth/refresh
     */
    refresh: async (req, res) => {
      try {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const result = await authManager.refreshAccessToken(data.refreshToken);
            
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
          } catch (error) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: error.message }));
          }
        });
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Server error' }));
      }
    },
    
    /**
     * GET /api/auth/profile
     */
    profile: withAuth(authManager, async (req, res) => {
      try {
        const profile = await authManager.getUserProfile(req.user.id);
        
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(profile));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.message }));
      }
    }),
    
    /**
     * PUT /api/auth/profile
     */
    updateProfile: withAuth(authManager, async (req, res) => {
      try {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const result = await authManager.updateUserProfile(req.user.id, data);
            
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
          } catch (error) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: error.message }));
          }
        });
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Server error' }));
      }
    }),
    
    /**
     * POST /api/auth/change-password
     */
    changePassword: withAuth(authManager, async (req, res) => {
      try {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const result = await authManager.changePassword(
              req.user.id,
              data.oldPassword,
              data.newPassword
            );
            
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
          } catch (error) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: error.message }));
          }
        });
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Server error' }));
      }
    }),
    
    /**
     * POST /api/auth/2fa/enable
     */
    enable2FA: withAuth(authManager, async (req, res) => {
      try {
        const result = await authManager.enable2FA(req.user.id);
        
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.message }));
      }
    }),
    
    /**
     * POST /api/auth/2fa/confirm
     */
    confirm2FA: withAuth(authManager, async (req, res) => {
      try {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const result = await authManager.confirm2FA(req.user.id, data.token);
            
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
          } catch (error) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: error.message }));
          }
        });
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Server error' }));
      }
    }),
    
    /**
     * GET /api/auth/sessions
     */
    sessions: withAuth(authManager, async (req, res) => {
      try {
        const sessions = await authManager.getUserSessions(req.user.id);
        
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ sessions }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.message }));
      }
    }),
    
    /**
     * DELETE /api/auth/sessions/:id
     */
    revokeSession: withAuth(authManager, async (req, res) => {
      try {
        const sessionId = req.url.split('/').pop();
        const result = await authManager.revokeSession(req.user.id, sessionId);
        
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.message }));
      }
    }),
    
    /**
     * POST /api/auth/apikeys
     */
    createApiKey: withAuth(authManager, async (req, res) => {
      try {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            const result = await authManager.createApiKey(
              req.user.id,
              data.name,
              data.permissions
            );
            
            res.statusCode = 201;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
          } catch (error) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: error.message }));
          }
        });
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Server error' }));
      }
    })
  };
}

export default { createAuthMiddleware, withAuth, createAuthRoutes };
