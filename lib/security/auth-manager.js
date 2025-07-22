const crypto = require('crypto');
const EventEmitter = require('events');
const jwt = require('jsonwebtoken');

class AuthenticationManager extends EventEmitter {
    constructor(config) {
        super();
        this.config = {
            jwtSecret: config.jwtSecret || crypto.randomBytes(32).toString('hex'),
            jwtExpiry: config.jwtExpiry || '15m',
            refreshTokenExpiry: config.refreshTokenExpiry || '7d',
            maxLoginAttempts: config.maxLoginAttempts || 5,
            lockoutDuration: config.lockoutDuration || 900000, // 15 minutes
            requireTwoFactor: config.requireTwoFactor || false,
            sessionTimeout: config.sessionTimeout || 3600000, // 1 hour
            ...config
        };
        
        this.sessions = new Map();
        this.refreshTokens = new Map();
        this.loginAttempts = new Map();
        this.blacklistedTokens = new Set();
        this.totpSecrets = new Map();
    }
    
    // User registration
    async register(username, password, email) {
        if (!this.validateUsername(username)) {
            throw new Error('Invalid username format');
        }
        
        if (!this.validatePassword(password)) {
            throw new Error('Password does not meet requirements');
        }
        
        if (!this.validateEmail(email)) {
            throw new Error('Invalid email format');
        }
        
        // Hash password with salt
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = this.hashPassword(password, salt);
        
        const user = {
            id: crypto.randomBytes(16).toString('hex'),
            username: username,
            email: email,
            passwordHash: hash,
            salt: salt,
            createdAt: Date.now(),
            twoFactorEnabled: false,
            roles: ['user']
        };
        
        // Generate 2FA secret if required
        if (this.config.requireTwoFactor) {
            const secret = this.generateTOTPSecret();
            this.totpSecrets.set(user.id, secret);
            user.twoFactorEnabled = true;
        }
        
        this.emit('user-registered', user);
        return user;
    }
    
    // User login
    async login(username, password, totpCode = null) {
        // Check login attempts
        const attempts = this.loginAttempts.get(username) || { count: 0, lastAttempt: 0 };
        
        if (attempts.count >= this.config.maxLoginAttempts) {
            const timeSinceLast = Date.now() - attempts.lastAttempt;
            if (timeSinceLast < this.config.lockoutDuration) {
                throw new Error('Account locked due to too many failed attempts');
            } else {
                // Reset attempts after lockout period
                this.loginAttempts.delete(username);
            }
        }
        
        // Verify credentials (simplified - would check against database)
        const user = await this.verifyCredentials(username, password);
        
        if (!user) {
            // Increment failed attempts
            attempts.count++;
            attempts.lastAttempt = Date.now();
            this.loginAttempts.set(username, attempts);
            
            throw new Error('Invalid credentials');
        }
        
        // Verify 2FA if enabled
        if (user.twoFactorEnabled) {
            if (!totpCode) {
                throw new Error('Two-factor authentication code required');
            }
            
            const isValidTOTP = this.verifyTOTP(user.id, totpCode);
            if (!isValidTOTP) {
                throw new Error('Invalid two-factor authentication code');
            }
        }
        
        // Clear login attempts on success
        this.loginAttempts.delete(username);
        
        // Generate tokens
        const accessToken = this.generateAccessToken(user);
        const refreshToken = this.generateRefreshToken(user);
        
        // Create session
        const session = {
            userId: user.id,
            username: user.username,
            roles: user.roles,
            loginTime: Date.now(),
            lastActivity: Date.now(),
            ipAddress: null, // Would be set from request
            userAgent: null  // Would be set from request
        };
        
        this.sessions.set(accessToken, session);
        this.refreshTokens.set(refreshToken, {
            userId: user.id,
            createdAt: Date.now()
        });
        
        this.emit('user-login', {
            userId: user.id,
            username: user.username,
            timestamp: Date.now()
        });
        
        return {
            accessToken,
            refreshToken,
            expiresIn: this.config.jwtExpiry,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                roles: user.roles
            }
        };
    }
    
    // Token refresh
    async refreshAccessToken(refreshToken) {
        const tokenData = this.refreshTokens.get(refreshToken);
        
        if (!tokenData) {
            throw new Error('Invalid refresh token');
        }
        
        // Check if refresh token is expired
        const expiryMs = this.parseTimeToMs(this.config.refreshTokenExpiry);
        if (Date.now() - tokenData.createdAt > expiryMs) {
            this.refreshTokens.delete(refreshToken);
            throw new Error('Refresh token expired');
        }
        
        // Get user data (simplified - would fetch from database)
        const user = { id: tokenData.userId, username: 'user', roles: ['user'] };
        
        // Generate new access token
        const newAccessToken = this.generateAccessToken(user);
        
        // Rotate refresh token
        const newRefreshToken = this.generateRefreshToken(user);
        this.refreshTokens.delete(refreshToken);
        this.refreshTokens.set(newRefreshToken, {
            userId: user.id,
            createdAt: Date.now()
        });
        
        return {
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            expiresIn: this.config.jwtExpiry
        };
    }
    
    // Verify token
    async verifyToken(token) {
        // Check if blacklisted
        if (this.blacklistedTokens.has(token)) {
            throw new Error('Token has been revoked');
        }
        
        try {
            const decoded = jwt.verify(token, this.config.jwtSecret);
            
            // Check session
            const session = this.sessions.get(token);
            if (!session) {
                throw new Error('Session not found');
            }
            
            // Check session timeout
            if (Date.now() - session.lastActivity > this.config.sessionTimeout) {
                this.sessions.delete(token);
                throw new Error('Session expired');
            }
            
            // Update last activity
            session.lastActivity = Date.now();
            
            return {
                userId: decoded.userId,
                username: decoded.username,
                roles: decoded.roles,
                session: session
            };
            
        } catch (err) {
            if (err.name === 'TokenExpiredError') {
                this.sessions.delete(token);
            }
            throw err;
        }
    }
    
    // Logout
    async logout(token) {
        const session = this.sessions.get(token);
        
        if (session) {
            this.sessions.delete(token);
            this.blacklistedTokens.add(token);
            
            this.emit('user-logout', {
                userId: session.userId,
                username: session.username,
                timestamp: Date.now()
            });
        }
        
        // Clean up blacklisted tokens periodically
        this.cleanupBlacklistedTokens();
    }
    
    // Password reset
    async initiatePasswordReset(email) {
        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiry = Date.now() + 3600000; // 1 hour
        
        // Store reset token (would be in database)
        this.emit('password-reset-requested', {
            email,
            resetToken,
            expiry
        });
        
        return resetToken;
    }
    
    async resetPassword(resetToken, newPassword) {
        if (!this.validatePassword(newPassword)) {
            throw new Error('Password does not meet requirements');
        }
        
        // Verify reset token and update password
        // (Implementation would check database)
        
        this.emit('password-reset', {
            resetToken,
            timestamp: Date.now()
        });
    }
    
    // Two-factor authentication
    enableTwoFactor(userId) {
        const secret = this.generateTOTPSecret();
        this.totpSecrets.set(userId, secret);
        
        // Generate QR code URL for authenticator apps
        const otpauth = `otpauth://totp/Otedama:${userId}?secret=${secret.base32}&issuer=Otedama`;
        
        return {
            secret: secret.base32,
            qrCode: otpauth
        };
    }
    
    verifyTOTP(userId, code) {
        const secret = this.totpSecrets.get(userId);
        if (!secret) return false;
        
        // Simple TOTP verification (would use proper library)
        const timeStep = Math.floor(Date.now() / 30000);
        const expectedCode = this.generateTOTP(secret.buffer, timeStep);
        
        // Allow for time drift
        return code === expectedCode || 
               code === this.generateTOTP(secret.buffer, timeStep - 1) ||
               code === this.generateTOTP(secret.buffer, timeStep + 1);
    }
    
    // Role-based access control
    hasPermission(user, resource, action) {
        const permissions = {
            admin: ['*'],
            operator: ['pool:read', 'pool:manage', 'miner:read'],
            user: ['miner:read', 'miner:own']
        };
        
        for (const role of user.roles) {
            const rolePerms = permissions[role] || [];
            
            if (rolePerms.includes('*')) return true;
            if (rolePerms.includes(`${resource}:${action}`)) return true;
            if (rolePerms.includes(`${resource}:*`)) return true;
        }
        
        return false;
    }
    
    // Helper methods
    hashPassword(password, salt) {
        return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    }
    
    validateUsername(username) {
        return /^[a-zA-Z0-9_]{3,20}$/.test(username);
    }
    
    validatePassword(password) {
        // At least 8 chars, 1 uppercase, 1 lowercase, 1 number, 1 special char
        return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/.test(password);
    }
    
    validateEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }
    
    generateAccessToken(user) {
        return jwt.sign(
            {
                userId: user.id,
                username: user.username,
                roles: user.roles
            },
            this.config.jwtSecret,
            { expiresIn: this.config.jwtExpiry }
        );
    }
    
    generateRefreshToken(user) {
        return crypto.randomBytes(32).toString('hex');
    }
    
    generateTOTPSecret() {
        const buffer = crypto.randomBytes(20);
        const base32 = this.base32Encode(buffer);
        
        return {
            buffer: buffer,
            base32: base32
        };
    }
    
    generateTOTP(secret, timeStep) {
        const hmac = crypto.createHmac('sha1', secret);
        const timeBuffer = Buffer.allocUnsafe(8);
        timeBuffer.writeBigInt64BE(BigInt(timeStep), 0);
        
        hmac.update(timeBuffer);
        const hash = hmac.digest();
        
        const offset = hash[hash.length - 1] & 0xf;
        const code = (hash[offset] & 0x7f) << 24 |
                    (hash[offset + 1] & 0xff) << 16 |
                    (hash[offset + 2] & 0xff) << 8 |
                    (hash[offset + 3] & 0xff);
        
        return String(code % 1000000).padStart(6, '0');
    }
    
    base32Encode(buffer) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = 0;
        let value = 0;
        let output = '';
        
        for (let i = 0; i < buffer.length; i++) {
            value = (value << 8) | buffer[i];
            bits += 8;
            
            while (bits >= 5) {
                output += alphabet[(value >>> (bits - 5)) & 31];
                bits -= 5;
            }
        }
        
        if (bits > 0) {
            output += alphabet[(value << (5 - bits)) & 31];
        }
        
        return output;
    }
    
    parseTimeToMs(time) {
        const units = {
            s: 1000,
            m: 60000,
            h: 3600000,
            d: 86400000
        };
        
        const match = time.match(/^(\d+)([smhd])$/);
        if (!match) return 0;
        
        return parseInt(match[1]) * (units[match[2]] || 0);
    }
    
    cleanupBlacklistedTokens() {
        // Remove expired tokens from blacklist
        // (Would check token expiry times)
        if (this.blacklistedTokens.size > 10000) {
            this.blacklistedTokens.clear();
        }
    }
    
    async verifyCredentials(username, password) {
        // Simplified - would check against database
        // This is just for demonstration
        return {
            id: 'user123',
            username: username,
            email: 'user@example.com',
            roles: ['user'],
            twoFactorEnabled: false
        };
    }
}

// API Key Manager for programmatic access
class APIKeyManager {
    constructor() {
        this.apiKeys = new Map();
        this.rateLimits = new Map();
    }
    
    generateAPIKey(userId, permissions, expiry = null) {
        const key = crypto.randomBytes(32).toString('hex');
        const apiKey = {
            key: key,
            userId: userId,
            permissions: permissions,
            createdAt: Date.now(),
            expiry: expiry,
            lastUsed: null,
            usageCount: 0
        };
        
        this.apiKeys.set(key, apiKey);
        return key;
    }
    
    validateAPIKey(key) {
        const apiKey = this.apiKeys.get(key);
        
        if (!apiKey) {
            throw new Error('Invalid API key');
        }
        
        if (apiKey.expiry && Date.now() > apiKey.expiry) {
            this.apiKeys.delete(key);
            throw new Error('API key expired');
        }
        
        // Update usage
        apiKey.lastUsed = Date.now();
        apiKey.usageCount++;
        
        // Check rate limit
        this.checkRateLimit(key);
        
        return apiKey;
    }
    
    checkRateLimit(key) {
        const limit = this.rateLimits.get(key) || { count: 0, resetTime: Date.now() + 60000 };
        
        if (Date.now() > limit.resetTime) {
            limit.count = 0;
            limit.resetTime = Date.now() + 60000;
        }
        
        limit.count++;
        
        if (limit.count > 100) { // 100 requests per minute
            throw new Error('Rate limit exceeded');
        }
        
        this.rateLimits.set(key, limit);
    }
    
    revokeAPIKey(key) {
        return this.apiKeys.delete(key);
    }
}

module.exports = {
    AuthenticationManager,
    APIKeyManager
};