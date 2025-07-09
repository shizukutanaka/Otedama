// src/auth/oauth2-jwt-provider.ts
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';

export interface OAuth2Config {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string[];
}

export interface JWTConfig {
  secret: string;
  issuer: string;
  audience: string;
  expiresIn: string;
  refreshExpiresIn: string;
  algorithm: jwt.Algorithm;
}

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  roles: string[];
  permissions: string[];
  verified: boolean;
  createdAt: Date;
  lastLogin?: Date;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  token?: string;
}

export class OAuth2JWTProvider {
  private jwtConfig: JWTConfig;
  private oauth2Providers: Map<string, OAuth2Config>;
  private logger: Logger;
  private cache: RedisCache;
  private refreshTokens: Map<string, string>; // refreshToken -> userId
  private rateLimitMap: Map<string, { count: number; resetTime: number }>;

  constructor(
    jwtConfig: JWTConfig,
    logger: Logger,
    cache?: RedisCache
  ) {
    this.jwtConfig = jwtConfig;
    this.logger = logger;
    this.cache = cache || new RedisCache({ host: 'localhost', port: 6379 });
    this.oauth2Providers = new Map();
    this.refreshTokens = new Map();
    this.rateLimitMap = new Map();

    // Clean up expired rate limits every minute
    setInterval(this.cleanupRateLimits.bind(this), 60000);
  }

  // OAuth2 Provider Management
  public addOAuth2Provider(name: string, config: OAuth2Config): void {
    this.oauth2Providers.set(name, config);
    this.logger.info(`OAuth2 provider '${name}' registered`);
  }

  public getAuthorizationUrl(provider: string, state?: string): string {
    const config = this.oauth2Providers.get(provider);
    if (!config) {
      throw new Error(`OAuth2 provider '${provider}' not found`);
    }

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: config.scope.join(' '),
      ...(state && { state })
    });

    return `${config.authorizationUrl}?${params.toString()}`;
  }

  public async exchangeCodeForToken(
    provider: string,
    code: string,
    state?: string
  ): Promise<any> {
    const config = this.oauth2Providers.get(provider);
    if (!config) {
      throw new Error(`OAuth2 provider '${provider}' not found`);
    }

    try {
      const response = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: config.redirectUri
        })
      });

      if (!response.ok) {
        throw new Error(`Token exchange failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      this.logger.error(`OAuth2 token exchange error for ${provider}:`, error);
      throw error;
    }
  }

  public async getUserInfo(provider: string, accessToken: string): Promise<any> {
    const config = this.oauth2Providers.get(provider);
    if (!config) {
      throw new Error(`OAuth2 provider '${provider}' not found`);
    }

    try {
      const response = await fetch(config.userInfoUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`User info fetch failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      this.logger.error(`OAuth2 user info error for ${provider}:`, error);
      throw error;
    }
  }

  // JWT Token Management
  public generateTokenPair(user: AuthUser): TokenPair {
    const payload = {
      sub: user.id,
      email: user.email,
      username: user.username,
      roles: user.roles,
      permissions: user.permissions,
      verified: user.verified,
      iat: Math.floor(Date.now() / 1000)
    };

    const accessToken = jwt.sign(payload, this.jwtConfig.secret, {
      issuer: this.jwtConfig.issuer,
      audience: this.jwtConfig.audience,
      expiresIn: this.jwtConfig.expiresIn,
      algorithm: this.jwtConfig.algorithm
    });

    const refreshToken = this.generateRefreshToken();
    this.refreshTokens.set(refreshToken, user.id);

    // Store refresh token in cache with expiration
    this.cache.set(
      `refresh_token:${refreshToken}`,
      user.id,
      this.parseExpirationToSeconds(this.jwtConfig.refreshExpiresIn)
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: this.parseExpirationToSeconds(this.jwtConfig.expiresIn),
      tokenType: 'Bearer'
    };
  }

  public verifyAccessToken(token: string): AuthUser | null {
    try {
      const payload = jwt.verify(token, this.jwtConfig.secret, {
        issuer: this.jwtConfig.issuer,
        audience: this.jwtConfig.audience,
        algorithms: [this.jwtConfig.algorithm]
      }) as jwt.JwtPayload;

      return {
        id: payload.sub!,
        email: payload.email,
        username: payload.username,
        roles: payload.roles || [],
        permissions: payload.permissions || [],
        verified: payload.verified || false,
        createdAt: new Date(payload.iat! * 1000)
      };
    } catch (error) {
      this.logger.debug('Token verification failed:', error);
      return null;
    }
  }

  public async refreshAccessToken(refreshToken: string): Promise<TokenPair | null> {
    const userId = await this.cache.get(`refresh_token:${refreshToken}`);
    
    if (!userId) {
      this.logger.warn('Invalid or expired refresh token');
      return null;
    }

    // In a real implementation, fetch user from database
    const user = await this.getUserById(userId);
    if (!user) {
      return null;
    }

    // Revoke old refresh token
    await this.revokeRefreshToken(refreshToken);

    // Generate new token pair
    return this.generateTokenPair(user);
  }

  public async revokeRefreshToken(refreshToken: string): Promise<void> {
    this.refreshTokens.delete(refreshToken);
    await this.cache.del(`refresh_token:${refreshToken}`);
  }

  public async revokeAllUserTokens(userId: string): Promise<void> {
    // In a real implementation, maintain a blacklist or token versioning
    const keys = await this.cache.keys(`refresh_token:*`);
    
    for (const key of keys) {
      const tokenUserId = await this.cache.get(key);
      if (tokenUserId === userId) {
        await this.cache.del(key);
      }
    }
  }

  // Middleware
  public authenticateJWT() {
    return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const authHeader = req.headers.authorization;
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Access token required' });
      }

      const token = authHeader.substring(7);
      
      // Check if token is blacklisted
      const isBlacklisted = await this.cache.get(`blacklist:${token}`);
      if (isBlacklisted) {
        return res.status(401).json({ error: 'Token has been revoked' });
      }

      const user = this.verifyAccessToken(token);
      
      if (!user) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      req.user = user;
      req.token = token;
      next();
    };
  }

  public requireRoles(roles: string[]) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const hasRole = roles.some(role => req.user!.roles.includes(role));
      
      if (!hasRole) {
        return res.status(403).json({ 
          error: 'Insufficient permissions',
          required: roles,
          current: req.user.roles
        });
      }

      next();
    };
  }

  public requirePermissions(permissions: string[]) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const hasPermission = permissions.every(permission => 
        req.user!.permissions.includes(permission)
      );
      
      if (!hasPermission) {
        return res.status(403).json({ 
          error: 'Insufficient permissions',
          required: permissions,
          current: req.user.permissions
        });
      }

      next();
    };
  }

  public rateLimitAuth(maxAttempts: number = 5, windowMs: number = 900000) {
    return (req: Request, res: Response, next: NextFunction) => {
      const identifier = req.ip || 'unknown';
      const now = Date.now();
      const window = now + windowMs;

      const current = this.rateLimitMap.get(identifier);
      
      if (!current || current.resetTime < now) {
        this.rateLimitMap.set(identifier, { count: 1, resetTime: window });
        return next();
      }

      if (current.count >= maxAttempts) {
        return res.status(429).json({
          error: 'Too many authentication attempts',
          retryAfter: Math.ceil((current.resetTime - now) / 1000)
        });
      }

      current.count++;
      next();
    };
  }

  // Utility methods
  private generateRefreshToken(): string {
    return crypto.randomBytes(64).toString('hex');
  }

  private parseExpirationToSeconds(expiration: string): number {
    const match = expiration.match(/^(\d+)([smhd])$/);
    if (!match) return 3600; // Default 1 hour

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case 's': return value;
      case 'm': return value * 60;
      case 'h': return value * 3600;
      case 'd': return value * 86400;
      default: return 3600;
    }
  }

  private cleanupRateLimits(): void {
    const now = Date.now();
    
    for (const [key, data] of this.rateLimitMap.entries()) {
      if (data.resetTime < now) {
        this.rateLimitMap.delete(key);
      }
    }
  }

  private async getUserById(userId: string): Promise<AuthUser | null> {
    // Simplified user lookup - in real implementation, query database
    try {
      const cached = await this.cache.get(`user:${userId}`);
      if (cached) {
        return JSON.parse(cached);
      }

      // Mock user for demonstration
      const user: AuthUser = {
        id: userId,
        email: `user${userId}@example.com`,
        username: `user${userId}`,
        roles: ['miner'],
        permissions: ['submit_shares', 'view_stats'],
        verified: true,
        createdAt: new Date(),
        lastLogin: new Date()
      };

      await this.cache.set(`user:${userId}`, JSON.stringify(user), 3600);
      return user;
    } catch (error) {
      this.logger.error(`Error fetching user ${userId}:`, error);
      return null;
    }
  }

  // Token blacklisting (for logout)
  public async blacklistToken(token: string): Promise<void> {
    try {
      const payload = jwt.decode(token) as jwt.JwtPayload;
      if (payload?.exp) {
        const ttl = payload.exp - Math.floor(Date.now() / 1000);
        if (ttl > 0) {
          await this.cache.set(`blacklist:${token}`, '1', ttl);
        }
      }
    } catch (error) {
      this.logger.error('Error blacklisting token:', error);
    }
  }

  // Health check
  public async healthCheck(): Promise<{ status: string; providers: string[] }> {
    return {
      status: 'healthy',
      providers: Array.from(this.oauth2Providers.keys())
    };
  }
}

// Express route handlers for OAuth2 flow
export class OAuth2Routes {
  constructor(private authProvider: OAuth2JWTProvider) {}

  public authorize = async (req: Request, res: Response) => {
    try {
      const { provider } = req.params;
      const state = crypto.randomBytes(32).toString('hex');
      
      // Store state for validation
      req.session = req.session || {};
      (req.session as any).oauth2State = state;

      const authUrl = this.authProvider.getAuthorizationUrl(provider, state);
      res.redirect(authUrl);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  };

  public callback = async (req: Request, res: Response) => {
    try {
      const { provider } = req.params;
      const { code, state } = req.query;
      
      // Validate state
      if (state !== (req.session as any)?.oauth2State) {
        return res.status(400).json({ error: 'Invalid state parameter' });
      }

      // Exchange code for token
      const tokenResponse = await this.authProvider.exchangeCodeForToken(
        provider,
        code as string,
        state as string
      );

      // Get user info
      const userInfo = await this.authProvider.getUserInfo(
        provider,
        tokenResponse.access_token
      );

      // Create or update user (simplified)
      const user: AuthUser = {
        id: userInfo.id || userInfo.sub,
        email: userInfo.email,
        username: userInfo.username || userInfo.login || userInfo.name,
        roles: ['miner'],
        permissions: ['submit_shares', 'view_stats'],
        verified: userInfo.verified || false,
        createdAt: new Date(),
        lastLogin: new Date()
      };

      // Generate JWT tokens
      const tokens = this.authProvider.generateTokenPair(user);

      res.json({
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          roles: user.roles
        },
        tokens
      });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  };

  public refresh = async (req: Request, res: Response) => {
    try {
      const { refreshToken } = req.body;
      
      if (!refreshToken) {
        return res.status(400).json({ error: 'Refresh token required' });
      }

      const tokens = await this.authProvider.refreshAccessToken(refreshToken);
      
      if (!tokens) {
        return res.status(401).json({ error: 'Invalid refresh token' });
      }

      res.json({ tokens });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  };

  public logout = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (req.token) {
        await this.authProvider.blacklistToken(req.token);
      }

      res.json({ message: 'Logged out successfully' });
    } catch (error) {
      res.status(500).json({ error: 'Logout failed' });
    }
  };
}