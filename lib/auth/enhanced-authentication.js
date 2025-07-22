import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import crypto from 'crypto';
import bcrypt from 'bcrypt';

export class EnhancedAuthentication extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableTwoFactor: options.enableTwoFactor !== false,
      enableBiometricAuth: options.enableBiometricAuth !== false,
      enableRiskBasedAuth: options.enableRiskBasedAuth !== false,
      enableSessionManagement: options.enableSessionManagement !== false,
      maxLoginAttempts: options.maxLoginAttempts || 5,
      lockoutDuration: options.lockoutDuration || 900000, // 15 minutes
      sessionTimeout: options.sessionTimeout || 3600000, // 1 hour
      ...options
    };

    this.users = new Map();
    this.sessions = new Map();
    this.loginAttempts = new Map();
    this.riskScores = new Map();
    
    this.metrics = {
      totalLogins: 0,
      failedLogins: 0,
      successfulLogins: 0,
      twoFactorEnabled: 0,
      riskyLogins: 0
    };

    this.initializeAuthSystem();
  }

  async initializeAuthSystem() {
    try {
      await this.setupPasswordPolicies();
      await this.setupTwoFactorAuth();
      await this.setupSessionManagement();
      await this.setupRiskBasedAuth();
      
      this.emit('authSystemInitialized', {
        policies: 'active',
        twoFactor: 'enabled',
        timestamp: Date.now()
      });
      
      console.log('🔐 Enhanced Authentication System initialized');
    } catch (error) {
      this.emit('authSystemError', { error: error.message, timestamp: Date.now() });
      throw error;
    }
  }

  async setupPasswordPolicies() {
    this.passwordPolicies = {
      minLength: 12,
      requireUppercase: true,
      requireLowercase: true,
      requireNumbers: true,
      requireSpecialChars: true,
      preventCommonPasswords: true,
      preventReuse: 5, // Last 5 passwords
      maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
      
      validate: (password) => {
        const errors = [];
        
        if (password.length < this.passwordPolicies.minLength) {
          errors.push(`Password must be at least ${this.passwordPolicies.minLength} characters long`);
        }
        
        if (this.passwordPolicies.requireUppercase && !/[A-Z]/.test(password)) {
          errors.push('Password must contain at least one uppercase letter');
        }
        
        if (this.passwordPolicies.requireLowercase && !/[a-z]/.test(password)) {
          errors.push('Password must contain at least one lowercase letter');
        }
        
        if (this.passwordPolicies.requireNumbers && !/\d/.test(password)) {
          errors.push('Password must contain at least one number');
        }
        
        if (this.passwordPolicies.requireSpecialChars && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
          errors.push('Password must contain at least one special character');
        }
        
        return {
          isValid: errors.length === 0,
          errors,
          strength: this.calculatePasswordStrength(password)
        };
      }
    };
  }

  async setupTwoFactorAuth() {
    this.twoFactorAuth = {
      // TOTP (Time-based One-Time Password)
      totp: {
        generateSecret: () => {
          return crypto.randomBytes(20).toString('base32');
        },
        
        generateQRCode: (secret, userEmail) => {
          const otpauth = `otpauth://totp/Otedama:${userEmail}?secret=${secret}&issuer=Otedama`;
          return otpauth; // In practice, generate QR code image
        },
        
        verifyToken: (token, secret) => {
          // Simplified TOTP verification
          const timeWindow = Math.floor(Date.now() / 30000);
          const expectedToken = this.generateTOTPToken(secret, timeWindow);
          return token === expectedToken;
        }
      },
      
      // SMS-based 2FA (backup method)
      sms: {
        sendCode: async (phoneNumber) => {
          const code = Math.floor(100000 + Math.random() * 900000).toString();
          // In practice, integrate with SMS service provider
          console.log(`SMS code for ${phoneNumber}: ${code}`);
          return { success: true, codeHash: await bcrypt.hash(code, 10) };
        },
        
        verifyCode: async (code, codeHash) => {
          return await bcrypt.compare(code, codeHash);
        }
      },
      
      // Email-based 2FA (backup method)
      email: {
        sendCode: async (email) => {
          const code = Math.floor(100000 + Math.random() * 900000).toString();
          // In practice, integrate with email service provider
          console.log(`Email code for ${email}: ${code}`);
          return { success: true, codeHash: await bcrypt.hash(code, 10) };
        },
        
        verifyCode: async (code, codeHash) => {
          return await bcrypt.compare(code, codeHash);
        }
      }
    };
  }

  async setupSessionManagement() {
    this.sessionManagement = {
      create: (userId, deviceInfo) => {
        const sessionId = crypto.randomBytes(32).toString('hex');
        const session = {
          id: sessionId,
          userId,
          deviceInfo,
          createdAt: Date.now(),
          lastActivity: Date.now(),
          isActive: true,
          ipAddress: deviceInfo.ipAddress,
          userAgent: deviceInfo.userAgent
        };
        
        this.sessions.set(sessionId, session);
        return sessionId;
      },
      
      validate: (sessionId) => {
        const session = this.sessions.get(sessionId);
        if (!session || !session.isActive) {
          return { valid: false, reason: 'Invalid session' };
        }
        
        const now = Date.now();
        if (now - session.lastActivity > this.options.sessionTimeout) {
          session.isActive = false;
          return { valid: false, reason: 'Session expired' };
        }
        
        session.lastActivity = now;
        return { valid: true, session };
      },
      
      invalidate: (sessionId) => {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.isActive = false;
        }
      },
      
      invalidateAllUserSessions: (userId) => {
        for (const [sessionId, session] of this.sessions) {
          if (session.userId === userId) {
            session.isActive = false;
          }
        }
      }
    };
  }

  async setupRiskBasedAuth() {
    this.riskAssessment = {
      factors: {
        // Device and location factors
        newDevice: { weight: 0.3, description: 'Login from unrecognized device' },
        newLocation: { weight: 0.25, description: 'Login from new geographic location' },
        unusualTime: { weight: 0.15, description: 'Login at unusual time for user' },
        
        // Behavioral factors
        rapidSuccessiveAttempts: { weight: 0.2, description: 'Multiple rapid login attempts' },
        passwordResetRecent: { weight: 0.1, description: 'Recent password reset activity' },
        
        // Network factors
        vpnOrProxy: { weight: 0.2, description: 'Login through VPN or proxy' },
        suspiciousIP: { weight: 0.4, description: 'Login from suspicious IP address' }
      },
      
      calculateRiskScore: (userId, loginContext) => {
        let riskScore = 0;
        const riskFactors = [];
        
        // Check each risk factor
        if (this.isNewDevice(userId, loginContext.deviceInfo)) {
          riskScore += this.riskAssessment.factors.newDevice.weight;
          riskFactors.push('newDevice');
        }
        
        if (this.isNewLocation(userId, loginContext.ipAddress)) {
          riskScore += this.riskAssessment.factors.newLocation.weight;
          riskFactors.push('newLocation');
        }
        
        if (this.isUnusualTime(userId, new Date())) {
          riskScore += this.riskAssessment.factors.unusualTime.weight;
          riskFactors.push('unusualTime');
        }
        
        if (this.hasSuspiciousIP(loginContext.ipAddress)) {
          riskScore += this.riskAssessment.factors.suspiciousIP.weight;
          riskFactors.push('suspiciousIP');
        }
        
        return {
          score: Math.min(riskScore, 1.0), // Cap at 1.0
          level: this.getRiskLevel(riskScore),
          factors: riskFactors
        };
      },
      
      getRiskLevel: (score) => {
        if (score < 0.3) return 'low';
        if (score < 0.6) return 'medium';
        return 'high';
      }
    };
  }

  // Main Authentication Methods
  async authenticateUser(credentials, deviceInfo) {
    const startTime = performance.now();
    
    try {
      this.metrics.totalLogins++;
      
      // Check for account lockout
      const lockoutCheck = this.checkAccountLockout(credentials.email);
      if (lockoutCheck.isLocked) {
        this.metrics.failedLogins++;
        this.emit('loginBlocked', {
          email: credentials.email,
          reason: 'account_locked',
          unlockTime: lockoutCheck.unlockTime,
          timestamp: Date.now()
        });
        
        throw new Error(`Account locked until ${new Date(lockoutCheck.unlockTime).toISOString()}`);
      }
      
      // Validate credentials
      const user = await this.validateCredentials(credentials);
      if (!user) {
        this.recordFailedLogin(credentials.email);
        this.metrics.failedLogins++;
        
        this.emit('loginFailed', {
          email: credentials.email,
          reason: 'invalid_credentials',
          timestamp: Date.now()
        });
        
        throw new Error('Invalid credentials');
      }
      
      // Risk assessment
      const riskAssessment = this.riskAssessment.calculateRiskScore(user.id, {
        deviceInfo,
        ipAddress: deviceInfo.ipAddress
      });
      
      this.riskScores.set(user.id, riskAssessment);
      
      // Determine authentication requirements based on risk
      const authRequirements = this.determineAuthRequirements(user, riskAssessment);
      
      // If 2FA is required
      if (authRequirements.requireTwoFactor) {
        const twoFactorResult = await this.handleTwoFactorAuth(user, credentials.twoFactorCode);
        if (!twoFactorResult.success) {
          this.recordFailedLogin(credentials.email);
          this.metrics.failedLogins++;
          throw new Error(twoFactorResult.error);
        }
      }
      
      // Create session
      const sessionId = this.sessionManagement.create(user.id, deviceInfo);
      
      // Clear failed login attempts
      this.clearFailedLogins(credentials.email);
      
      this.metrics.successfulLogins++;
      if (riskAssessment.level === 'high') {
        this.metrics.riskyLogins++;
      }
      
      this.emit('loginSuccess', {
        userId: user.id,
        sessionId,
        riskLevel: riskAssessment.level,
        riskScore: riskAssessment.score,
        processingTime: performance.now() - startTime,
        timestamp: Date.now()
      });
      
      return {
        success: true,
        sessionId,
        user: {
          id: user.id,
          email: user.email,
          name: user.name
        },
        riskAssessment
      };
    } catch (error) {
      this.emit('authenticationError', { 
        error: error.message, 
        email: credentials.email, 
        timestamp: Date.now() 
      });
      throw error;
    }
  }

  async registerUser(userData) {
    try {
      // Validate password
      const passwordValidation = this.passwordPolicies.validate(userData.password);
      if (!passwordValidation.isValid) {
        throw new Error(`Password policy violation: ${passwordValidation.errors.join(', ')}`);
      }
      
      // Check if user already exists
      const existingUser = Array.from(this.users.values()).find(u => u.email === userData.email);
      if (existingUser) {
        throw new Error('User already exists');
      }
      
      // Hash password
      const passwordHash = await bcrypt.hash(userData.password, 12);
      
      // Create user
      const userId = crypto.randomUUID();
      const user = {
        id: userId,
        email: userData.email,
        name: userData.name,
        passwordHash,
        createdAt: Date.now(),
        isActive: true,
        twoFactorEnabled: false,
        lastPasswordChange: Date.now(),
        passwordHistory: [passwordHash]
      };
      
      this.users.set(userId, user);
      
      this.emit('userRegistered', {
        userId,
        email: userData.email,
        timestamp: Date.now()
      });
      
      return { success: true, userId };
    } catch (error) {
      this.emit('registrationError', { error: error.message, timestamp: Date.now() });
      throw error;
    }
  }

  async enableTwoFactor(userId, method = 'totp') {
    try {
      const user = this.users.get(userId);
      if (!user) {
        throw new Error('User not found');
      }
      
      let setup;
      
      switch (method) {
        case 'totp':
          const secret = this.twoFactorAuth.totp.generateSecret();
          setup = {
            secret,
            qrCode: this.twoFactorAuth.totp.generateQRCode(secret, user.email),
            backupCodes: this.generateBackupCodes()
          };
          break;
        case 'sms':
          setup = await this.twoFactorAuth.sms.sendCode(user.phoneNumber);
          break;
        case 'email':
          setup = await this.twoFactorAuth.email.sendCode(user.email);
          break;
        default:
          throw new Error('Unsupported 2FA method');
      }
      
      user.twoFactorMethod = method;
      user.twoFactorSecret = setup.secret;
      user.twoFactorEnabled = true;
      user.backupCodes = setup.backupCodes;
      
      this.metrics.twoFactorEnabled++;
      
      this.emit('twoFactorEnabled', {
        userId,
        method,
        timestamp: Date.now()
      });
      
      return setup;
    } catch (error) {
      this.emit('twoFactorError', { error: error.message, userId, timestamp: Date.now() });
      throw error;
    }
  }

  // Helper Methods
  async validateCredentials(credentials) {
    const user = Array.from(this.users.values()).find(u => u.email === credentials.email);
    if (!user || !user.isActive) {
      return null;
    }
    
    const isPasswordValid = await bcrypt.compare(credentials.password, user.passwordHash);
    return isPasswordValid ? user : null;
  }

  checkAccountLockout(email) {
    const attempts = this.loginAttempts.get(email);
    if (!attempts || attempts.count < this.options.maxLoginAttempts) {
      return { isLocked: false };
    }
    
    const lockoutEnd = attempts.firstAttempt + this.options.lockoutDuration;
    const isLocked = Date.now() < lockoutEnd;
    
    return {
      isLocked,
      unlockTime: isLocked ? lockoutEnd : null
    };
  }

  recordFailedLogin(email) {
    const attempts = this.loginAttempts.get(email) || { count: 0, firstAttempt: Date.now() };
    attempts.count++;
    
    if (attempts.count === 1) {
      attempts.firstAttempt = Date.now();
    }
    
    this.loginAttempts.set(email, attempts);
  }

  clearFailedLogins(email) {
    this.loginAttempts.delete(email);
  }

  determineAuthRequirements(user, riskAssessment) {
    return {
      requireTwoFactor: user.twoFactorEnabled || riskAssessment.level === 'high',
      requireAdditionalVerification: riskAssessment.level === 'high'
    };
  }

  async handleTwoFactorAuth(user, providedCode) {
    if (!providedCode) {
      return { success: false, error: '2FA code required' };
    }
    
    let isValid = false;
    
    switch (user.twoFactorMethod) {
      case 'totp':
        isValid = this.twoFactorAuth.totp.verifyToken(providedCode, user.twoFactorSecret);
        break;
      case 'sms':
      case 'email':
        // In practice, verify against stored hash
        isValid = providedCode.length === 6 && /^\d+$/.test(providedCode);
        break;
    }
    
    if (!isValid && user.backupCodes && user.backupCodes.includes(providedCode)) {
      // Remove used backup code
      user.backupCodes = user.backupCodes.filter(code => code !== providedCode);
      isValid = true;
    }
    
    return {
      success: isValid,
      error: isValid ? null : 'Invalid 2FA code'
    };
  }

  calculatePasswordStrength(password) {
    let score = 0;
    
    // Length bonus
    score += Math.min(password.length * 4, 50);
    
    // Character variety bonus
    if (/[a-z]/.test(password)) score += 5;
    if (/[A-Z]/.test(password)) score += 5;
    if (/\d/.test(password)) score += 5;
    if (/[!@#$%^&*(),.?":{}|<>]/.test(password)) score += 10;
    
    // Penalty for common patterns
    if (/(.)\1{2,}/.test(password)) score -= 10; // Repeating characters
    if (/123|abc|qwe/i.test(password)) score -= 10; // Sequential patterns
    
    return Math.max(0, Math.min(100, score));
  }

  generateTOTPToken(secret, timeWindow) {
    // Simplified TOTP generation - in practice use proper TOTP library
    const hash = crypto.createHmac('sha1', Buffer.from(secret, 'base32'));
    hash.update(Buffer.alloc(8));
    const hmac = hash.digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const code = ((hmac[offset] & 0x7f) << 24) | 
                 ((hmac[offset + 1] & 0xff) << 16) | 
                 ((hmac[offset + 2] & 0xff) << 8) | 
                 (hmac[offset + 3] & 0xff);
    return (code % 1000000).toString().padStart(6, '0');
  }

  generateBackupCodes() {
    const codes = [];
    for (let i = 0; i < 10; i++) {
      codes.push(Math.floor(Math.random() * 1000000).toString().padStart(6, '0'));
    }
    return codes;
  }

  isNewDevice(userId, deviceInfo) {
    // In practice, check against stored device fingerprints
    return Math.random() > 0.7; // 30% chance of new device
  }

  isNewLocation(userId, ipAddress) {
    // In practice, check against user's historical locations
    return Math.random() > 0.8; // 20% chance of new location
  }

  isUnusualTime(userId, timestamp) {
    // In practice, analyze user's typical login patterns
    const hour = timestamp.getHours();
    return hour < 6 || hour > 23; // Outside normal business hours
  }

  hasSuspiciousIP(ipAddress) {
    // In practice, check against threat intelligence feeds
    return Math.random() > 0.95; // 5% chance of suspicious IP
  }

  // System monitoring
  getAuthMetrics() {
    return {
      ...this.metrics,
      activeUsers: this.users.size,
      activeSessions: Array.from(this.sessions.values()).filter(s => s.isActive).length,
      lockedAccounts: Array.from(this.loginAttempts.values()).filter(a => a.count >= this.options.maxLoginAttempts).length,
      uptime: process.uptime()
    };
  }

  async shutdownAuthSystem() {
    this.emit('authSystemShutdown', { timestamp: Date.now() });
    console.log('🔐 Enhanced Authentication System shutdown complete');
  }
}

export default EnhancedAuthentication;