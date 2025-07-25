/**
 * Enhanced Authentication System
 * Multi-factor authentication with advanced security features
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const jwt = require('jsonwebtoken');
const argon2 = require('argon2');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');

class EnhancedAuthSystem extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // JWT Configuration
            jwtSecret: config.jwtSecret || crypto.randomBytes(64).toString('hex'),
            jwtAlgorithm: config.jwtAlgorithm || 'HS512',
            accessTokenExpiry: config.accessTokenExpiry || '15m',
            refreshTokenExpiry: config.refreshTokenExpiry || '7d',
            
            // Password Policy
            passwordMinLength: config.passwordMinLength || 12,
            passwordRequireUppercase: config.passwordRequireUppercase !== false,
            passwordRequireLowercase: config.passwordRequireLowercase !== false,
            passwordRequireNumbers: config.passwordRequireNumbers !== false,
            passwordRequireSymbols: config.passwordRequireSymbols !== false,
            passwordHistory: config.passwordHistory || 5,
            
            // Account Security
            maxLoginAttempts: config.maxLoginAttempts || 5,
            lockoutDuration: config.lockoutDuration || 1800000, // 30 minutes
            sessionTimeout: config.sessionTimeout || 3600000, // 1 hour
            concurrentSessionLimit: config.concurrentSessionLimit || 3,
            
            // Multi-Factor Authentication
            mfaRequired: config.mfaRequired || false,
            mfaGracePeriod: config.mfaGracePeriod || 86400000, // 24 hours
            backupCodesCount: config.backupCodesCount || 10,
            
            // Security Features
            enableDeviceFingerprinting: config.enableDeviceFingerprinting !== false,
            enableGeoIPValidation: config.enableGeoIPValidation || true,
            enableBehaviorAnalysis: config.enableBehaviorAnalysis || true,
            
            // Argon2 Settings
            argon2Options: {
                type: argon2.argon2id,
                memoryCost: config.argon2MemoryCost || 65536,
                timeCost: config.argon2TimeCost || 3,
                parallelism: config.argon2Parallelism || 4
            },
            
            ...config
        };
        
        // State management
        this.users = new Map();
        this.sessions = new Map();
        this.refreshTokens = new Map();
        this.loginAttempts = new Map();
        this.blacklistedTokens = new Set();
        this.deviceFingerprints = new Map();
        this.passwordHistory = new Map();
        this.mfaSecrets = new Map();
        this.backupCodes = new Map();
        this.trustedDevices = new Map();
        
        // Initialize components
        this.setupCleanupTasks();
    }
    
    /**
     * Register new user
     */
    async register(userData) {
        const { username, email, password, role = 'user' } = userData;
        
        // Validate input
        this.validateUsername(username);
        this.validateEmail(email);
        await this.validatePassword(password);
        
        // Check if user exists
        if (this.getUserByUsername(username)) {
            throw new Error('Username already exists');
        }
        
        if (this.getUserByEmail(email)) {
            throw new Error('Email already registered');
        }
        
        // Generate user ID
        const userId = crypto.randomBytes(16).toString('hex');
        
        // Hash password
        const passwordHash = await this.hashPassword(password);
        
        // Create user
        const user = {
            id: userId,
            username: username.toLowerCase(),
            email: email.toLowerCase(),
            passwordHash,
            role,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            isActive: true,
            isVerified: false,
            mfaEnabled: this.config.mfaRequired,
            mfaGracePeriodEnd: Date.now() + this.config.mfaGracePeriod,
            lastLogin: null,
            failedLogins: 0,
            lockedUntil: null
        };
        
        this.users.set(userId, user);
        
        // Initialize password history
        this.passwordHistory.set(userId, [passwordHash]);
        
        // Generate email verification token
        const verificationToken = this.generateVerificationToken(userId);
        
        // Setup MFA if required
        let mfaSetup = null;
        if (this.config.mfaRequired) {
            mfaSetup = await this.setupMFA(userId);
        }
        
        this.emit('user-registered', { userId, username, email });
        
        return {
            userId,
            username,
            email,
            verificationToken,
            mfaSetup
        };
    }
    
    /**
     * User login
     */
    async login(credentials, deviceInfo = {}) {
        const { username, password, mfaCode, backupCode } = credentials;
        
        // Get user
        const user = this.getUserByUsername(username);
        if (!user) {
            await this.recordFailedLogin(username);
            throw new Error('Invalid credentials');
        }
        
        // Check if account is locked
        if (user.lockedUntil && Date.now() < user.lockedUntil) {
            const remainingTime = Math.ceil((user.lockedUntil - Date.now()) / 60000);
            throw new Error(`Account locked. Try again in ${remainingTime} minutes`);
        }
        
        // Check if account is active
        if (!user.isActive) {
            throw new Error('Account is disabled');
        }
        
        // Verify password
        const isValidPassword = await this.verifyPassword(password, user.passwordHash);
        if (!isValidPassword) {
            await this.recordFailedLogin(username, user.id);
            throw new Error('Invalid credentials');
        }
        
        // Check MFA
        if (user.mfaEnabled && Date.now() > user.mfaGracePeriodEnd) {
            // Check if device is trusted
            const isTrustedDevice = this.checkTrustedDevice(user.id, deviceInfo);
            
            if (!isTrustedDevice) {
                if (mfaCode) {
                    const isValidMFA = await this.verifyMFA(user.id, mfaCode);
                    if (!isValidMFA) {
                        throw new Error('Invalid MFA code');
                    }
                } else if (backupCode) {
                    const isValidBackup = await this.verifyBackupCode(user.id, backupCode);
                    if (!isValidBackup) {
                        throw new Error('Invalid backup code');
                    }
                } else {
                    throw new Error('MFA code required');
                }
            }
        }
        
        // Clear failed login attempts
        user.failedLogins = 0;
        user.lockedUntil = null;
        
        // Check concurrent sessions
        const userSessions = this.getUserSessions(user.id);
        if (userSessions.length >= this.config.concurrentSessionLimit) {
            // Revoke oldest session
            const oldestSession = userSessions.sort((a, b) => a.createdAt - b.createdAt)[0];
            await this.revokeSession(oldestSession.token);
        }
        
        // Generate tokens
        const accessToken = this.generateAccessToken(user);
        const refreshToken = this.generateRefreshToken();
        
        // Create session
        const session = {
            userId: user.id,
            username: user.username,
            role: user.role,
            token: accessToken,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            deviceInfo: {
                ...deviceInfo,
                fingerprint: this.generateDeviceFingerprint(deviceInfo)
            },
            ipAddress: deviceInfo.ipAddress,
            userAgent: deviceInfo.userAgent
        };
        
        this.sessions.set(accessToken, session);
        this.refreshTokens.set(refreshToken, {
            userId: user.id,
            accessToken,
            createdAt: Date.now()
        });
        
        // Update user
        user.lastLogin = Date.now();
        user.updatedAt = Date.now();
        
        // Behavior analysis
        if (this.config.enableBehaviorAnalysis) {
            this.analyzeBehavior(user.id, session);
        }
        
        this.emit('user-login', {
            userId: user.id,
            username: user.username,
            sessionId: session.token,
            deviceInfo
        });
        
        return {
            accessToken,
            refreshToken,
            expiresIn: this.config.accessTokenExpiry,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                mfaEnabled: user.mfaEnabled
            }
        };
    }
    
    /**
     * Verify access token
     */
    async verifyAccessToken(token) {
        // Check if blacklisted
        if (this.blacklistedTokens.has(token)) {
            throw new Error('Token has been revoked');
        }
        
        try {
            // Verify JWT
            const decoded = jwt.verify(token, this.config.jwtSecret, {
                algorithms: [this.config.jwtAlgorithm]
            });
            
            // Get session
            const session = this.sessions.get(token);
            if (!session) {
                throw new Error('Session not found');
            }
            
            // Check session timeout
            if (Date.now() - session.lastActivity > this.config.sessionTimeout) {
                this.sessions.delete(token);
                throw new Error('Session expired');
            }
            
            // Validate device fingerprint
            if (this.config.enableDeviceFingerprinting && session.deviceInfo.fingerprint) {
                // Implementation would validate current device matches session
            }
            
            // Update activity
            session.lastActivity = Date.now();
            
            return {
                userId: decoded.userId,
                username: decoded.username,
                role: decoded.role,
                session
            };
            
        } catch (error) {
            if (error.name === 'TokenExpiredError') {
                this.sessions.delete(token);
            }
            throw error;
        }
    }
    
    /**
     * Refresh access token
     */
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
        
        // Get user
        const user = this.users.get(tokenData.userId);
        if (!user || !user.isActive) {
            throw new Error('User not found or inactive');
        }
        
        // Revoke old access token
        await this.revokeSession(tokenData.accessToken);
        
        // Generate new tokens
        const newAccessToken = this.generateAccessToken(user);
        const newRefreshToken = this.generateRefreshToken();
        
        // Create new session
        const oldSession = this.sessions.get(tokenData.accessToken);
        const newSession = {
            ...oldSession,
            token: newAccessToken,
            createdAt: Date.now(),
            lastActivity: Date.now()
        };
        
        this.sessions.set(newAccessToken, newSession);
        this.refreshTokens.delete(refreshToken);
        this.refreshTokens.set(newRefreshToken, {
            userId: user.id,
            accessToken: newAccessToken,
            createdAt: Date.now()
        });
        
        return {
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            expiresIn: this.config.accessTokenExpiry
        };
    }
    
    /**
     * Logout user
     */
    async logout(token) {
        await this.revokeSession(token);
        
        const session = this.sessions.get(token);
        if (session) {
            this.emit('user-logout', {
                userId: session.userId,
                username: session.username,
                sessionId: token
            });
        }
    }
    
    /**
     * Setup MFA for user
     */
    async setupMFA(userId) {
        const user = this.users.get(userId);
        if (!user) {
            throw new Error('User not found');
        }
        
        // Generate secret
        const secret = speakeasy.generateSecret({
            name: `Otedama (${user.username})`,
            issuer: 'Otedama Mining Pool'
        });
        
        this.mfaSecrets.set(userId, secret);
        
        // Generate backup codes
        const backupCodes = [];
        for (let i = 0; i < this.config.backupCodesCount; i++) {
            const code = crypto.randomBytes(4).toString('hex').toUpperCase();
            backupCodes.push(code);
        }
        
        const hashedBackupCodes = await Promise.all(
            backupCodes.map(code => this.hashPassword(code))
        );
        
        this.backupCodes.set(userId, hashedBackupCodes);
        
        // Generate QR code
        const qrCode = await QRCode.toDataURL(secret.otpauth_url);
        
        return {
            secret: secret.base32,
            qrCode,
            backupCodes
        };
    }
    
    /**
     * Verify MFA code
     */
    async verifyMFA(userId, code) {
        const secret = this.mfaSecrets.get(userId);
        if (!secret) {
            return false;
        }
        
        return speakeasy.totp.verify({
            secret: secret.base32,
            encoding: 'base32',
            token: code,
            window: 2 // Allow 2 time steps before/after
        });
    }
    
    /**
     * Verify backup code
     */
    async verifyBackupCode(userId, code) {
        const hashedCodes = this.backupCodes.get(userId);
        if (!hashedCodes || hashedCodes.length === 0) {
            return false;
        }
        
        // Find and remove used code
        for (let i = 0; i < hashedCodes.length; i++) {
            const isValid = await this.verifyPassword(code, hashedCodes[i]);
            if (isValid) {
                hashedCodes.splice(i, 1);
                return true;
            }
        }
        
        return false;
    }
    
    /**
     * Change password
     */
    async changePassword(userId, oldPassword, newPassword) {
        const user = this.users.get(userId);
        if (!user) {
            throw new Error('User not found');
        }
        
        // Verify old password
        const isValid = await this.verifyPassword(oldPassword, user.passwordHash);
        if (!isValid) {
            throw new Error('Invalid current password');
        }
        
        // Validate new password
        await this.validatePassword(newPassword);
        
        // Check password history
        const history = this.passwordHistory.get(userId) || [];
        for (const oldHash of history.slice(0, this.config.passwordHistory)) {
            const isReused = await this.verifyPassword(newPassword, oldHash);
            if (isReused) {
                throw new Error('Password has been used recently');
            }
        }
        
        // Hash new password
        const newHash = await this.hashPassword(newPassword);
        
        // Update user
        user.passwordHash = newHash;
        user.updatedAt = Date.now();
        
        // Update password history
        history.unshift(newHash);
        if (history.length > this.config.passwordHistory) {
            history.pop();
        }
        this.passwordHistory.set(userId, history);
        
        // Revoke all sessions
        await this.revokeAllUserSessions(userId);
        
        this.emit('password-changed', { userId });
    }
    
    /**
     * Password reset
     */
    async initiatePasswordReset(email) {
        const user = this.getUserByEmail(email);
        if (!user) {
            // Don't reveal if email exists
            return { message: 'If the email exists, a reset link will be sent' };
        }
        
        const resetToken = crypto.randomBytes(32).toString('hex');
        const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
        
        user.resetToken = hashedToken;
        user.resetTokenExpiry = Date.now() + 3600000; // 1 hour
        
        this.emit('password-reset-requested', {
            userId: user.id,
            email: user.email,
            resetToken
        });
        
        return { message: 'If the email exists, a reset link will be sent' };
    }
    
    /**
     * Complete password reset
     */
    async resetPassword(resetToken, newPassword) {
        const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
        
        // Find user with reset token
        let user = null;
        for (const [userId, userData] of this.users) {
            if (userData.resetToken === hashedToken && 
                userData.resetTokenExpiry > Date.now()) {
                user = userData;
                break;
            }
        }
        
        if (!user) {
            throw new Error('Invalid or expired reset token');
        }
        
        // Validate new password
        await this.validatePassword(newPassword);
        
        // Hash new password
        const newHash = await this.hashPassword(newPassword);
        
        // Update user
        user.passwordHash = newHash;
        user.resetToken = null;
        user.resetTokenExpiry = null;
        user.updatedAt = Date.now();
        
        // Update password history
        const history = this.passwordHistory.get(user.id) || [];
        history.unshift(newHash);
        if (history.length > this.config.passwordHistory) {
            history.pop();
        }
        this.passwordHistory.set(user.id, history);
        
        // Revoke all sessions
        await this.revokeAllUserSessions(user.id);
        
        this.emit('password-reset', { userId: user.id });
    }
    
    /**
     * Trust device
     */
    async trustDevice(userId, deviceInfo, duration = 30 * 24 * 60 * 60 * 1000) {
        const fingerprint = this.generateDeviceFingerprint(deviceInfo);
        const trustedUntil = Date.now() + duration;
        
        let userDevices = this.trustedDevices.get(userId) || [];
        userDevices = userDevices.filter(d => d.fingerprint !== fingerprint);
        
        userDevices.push({
            fingerprint,
            trustedUntil,
            deviceInfo: {
                name: deviceInfo.name || 'Unknown Device',
                type: deviceInfo.type || 'Unknown',
                os: deviceInfo.os || 'Unknown'
            }
        });
        
        this.trustedDevices.set(userId, userDevices);
    }
    
    /**
     * Check if device is trusted
     */
    checkTrustedDevice(userId, deviceInfo) {
        const userDevices = this.trustedDevices.get(userId) || [];
        const fingerprint = this.generateDeviceFingerprint(deviceInfo);
        
        const trustedDevice = userDevices.find(d => 
            d.fingerprint === fingerprint && d.trustedUntil > Date.now()
        );
        
        return !!trustedDevice;
    }
    
    /**
     * Revoke session
     */
    async revokeSession(token) {
        this.sessions.delete(token);
        this.blacklistedTokens.add(token);
        
        // Remove associated refresh tokens
        for (const [refreshToken, data] of this.refreshTokens) {
            if (data.accessToken === token) {
                this.refreshTokens.delete(refreshToken);
            }
        }
    }
    
    /**
     * Revoke all user sessions
     */
    async revokeAllUserSessions(userId) {
        const sessions = this.getUserSessions(userId);
        
        for (const session of sessions) {
            await this.revokeSession(session.token);
        }
        
        this.emit('all-sessions-revoked', { userId });
    }
    
    /**
     * Get user sessions
     */
    getUserSessions(userId) {
        const sessions = [];
        
        for (const [token, session] of this.sessions) {
            if (session.userId === userId) {
                sessions.push(session);
            }
        }
        
        return sessions;
    }
    
    /**
     * Record failed login attempt
     */
    async recordFailedLogin(username, userId = null) {
        // Track by username
        let attempts = this.loginAttempts.get(username) || {
            count: 0,
            firstAttempt: Date.now(),
            lastAttempt: Date.now()
        };
        
        attempts.count++;
        attempts.lastAttempt = Date.now();
        
        // Reset if window expired
        if (Date.now() - attempts.firstAttempt > 3600000) { // 1 hour
            attempts.count = 1;
            attempts.firstAttempt = Date.now();
        }
        
        this.loginAttempts.set(username, attempts);
        
        // Update user if found
        if (userId) {
            const user = this.users.get(userId);
            if (user) {
                user.failedLogins++;
                
                if (user.failedLogins >= this.config.maxLoginAttempts) {
                    user.lockedUntil = Date.now() + this.config.lockoutDuration;
                    this.emit('account-locked', { userId, username });
                }
            }
        }
        
        this.emit('failed-login', { username, attempts: attempts.count });
    }
    
    /**
     * Analyze user behavior
     */
    analyzeBehavior(userId, session) {
        // Check for suspicious patterns
        const userSessions = this.getUserSessions(userId);
        
        // Check for rapid location changes
        if (userSessions.length > 1) {
            const lastSession = userSessions[userSessions.length - 2];
            // Implementation would check IP geolocation
        }
        
        // Check for unusual login times
        const loginHour = new Date().getHours();
        const user = this.users.get(userId);
        if (user && user.lastLogin) {
            const lastLoginHour = new Date(user.lastLogin).getHours();
            // Implementation would check for unusual patterns
        }
        
        // Check for device changes
        const deviceChanges = new Set(userSessions.map(s => s.deviceInfo.fingerprint)).size;
        if (deviceChanges > 5) {
            this.emit('suspicious-activity', {
                userId,
                type: 'multiple_devices',
                count: deviceChanges
            });
        }
    }
    
    /**
     * Helper methods
     */
    
    async hashPassword(password) {
        return await argon2.hash(password, this.config.argon2Options);
    }
    
    async verifyPassword(password, hash) {
        try {
            return await argon2.verify(hash, password);
        } catch (error) {
            return false;
        }
    }
    
    generateAccessToken(user) {
        return jwt.sign(
            {
                userId: user.id,
                username: user.username,
                role: user.role
            },
            this.config.jwtSecret,
            {
                algorithm: this.config.jwtAlgorithm,
                expiresIn: this.config.accessTokenExpiry
            }
        );
    }
    
    generateRefreshToken() {
        return crypto.randomBytes(32).toString('hex');
    }
    
    generateVerificationToken(userId) {
        const token = crypto.randomBytes(32).toString('hex');
        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
        
        const user = this.users.get(userId);
        if (user) {
            user.verificationToken = hashedToken;
            user.verificationTokenExpiry = Date.now() + 86400000; // 24 hours
        }
        
        return token;
    }
    
    generateDeviceFingerprint(deviceInfo) {
        const data = [
            deviceInfo.userAgent || '',
            deviceInfo.screenResolution || '',
            deviceInfo.timezone || '',
            deviceInfo.language || '',
            deviceInfo.platform || ''
        ].join('|');
        
        return crypto.createHash('sha256').update(data).digest('hex');
    }
    
    validateUsername(username) {
        if (!username || username.length < 3 || username.length > 20) {
            throw new Error('Username must be between 3 and 20 characters');
        }
        
        if (!/^[a-zA-Z0-9_]+$/.test(username)) {
            throw new Error('Username can only contain letters, numbers, and underscores');
        }
    }
    
    validateEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            throw new Error('Invalid email format');
        }
    }
    
    async validatePassword(password) {
        if (password.length < this.config.passwordMinLength) {
            throw new Error(`Password must be at least ${this.config.passwordMinLength} characters`);
        }
        
        const checks = [];
        
        if (this.config.passwordRequireUppercase) {
            checks.push({
                test: /[A-Z]/.test(password),
                message: 'Password must contain uppercase letters'
            });
        }
        
        if (this.config.passwordRequireLowercase) {
            checks.push({
                test: /[a-z]/.test(password),
                message: 'Password must contain lowercase letters'
            });
        }
        
        if (this.config.passwordRequireNumbers) {
            checks.push({
                test: /\d/.test(password),
                message: 'Password must contain numbers'
            });
        }
        
        if (this.config.passwordRequireSymbols) {
            checks.push({
                test: /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password),
                message: 'Password must contain special characters'
            });
        }
        
        for (const check of checks) {
            if (!check.test) {
                throw new Error(check.message);
            }
        }
        
        // Check for common passwords
        const commonPasswords = ['password', '12345678', 'qwerty', 'abc123'];
        if (commonPasswords.includes(password.toLowerCase())) {
            throw new Error('Password is too common');
        }
    }
    
    getUserByUsername(username) {
        for (const [userId, user] of this.users) {
            if (user.username === username.toLowerCase()) {
                return user;
            }
        }
        return null;
    }
    
    getUserByEmail(email) {
        for (const [userId, user] of this.users) {
            if (user.email === email.toLowerCase()) {
                return user;
            }
        }
        return null;
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
    
    /**
     * Setup cleanup tasks
     */
    setupCleanupTasks() {
        // Clean expired tokens
        setInterval(() => {
            this.cleanupExpiredTokens();
        }, 3600000); // Every hour
        
        // Clean login attempts
        setInterval(() => {
            this.cleanupLoginAttempts();
        }, 1800000); // Every 30 minutes
    }
    
    cleanupExpiredTokens() {
        // Clean blacklisted tokens
        if (this.blacklistedTokens.size > 10000) {
            this.blacklistedTokens.clear();
        }
        
        // Clean expired sessions
        const now = Date.now();
        for (const [token, session] of this.sessions) {
            if (now - session.lastActivity > this.config.sessionTimeout) {
                this.sessions.delete(token);
            }
        }
        
        // Clean expired refresh tokens
        const expiryMs = this.parseTimeToMs(this.config.refreshTokenExpiry);
        for (const [token, data] of this.refreshTokens) {
            if (now - data.createdAt > expiryMs) {
                this.refreshTokens.delete(token);
            }
        }
    }
    
    cleanupLoginAttempts() {
        const now = Date.now();
        for (const [username, attempts] of this.loginAttempts) {
            if (now - attempts.lastAttempt > 3600000) { // 1 hour
                this.loginAttempts.delete(username);
            }
        }
    }
}

module.exports = EnhancedAuthSystem;