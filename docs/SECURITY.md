# Otedama Security Guide

## Overview

This comprehensive security guide covers all aspects of securing your Otedama mining pool deployment, from basic hardening to advanced threat protection suitable for national-scale operations.

## Security Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Edge Security                         │
│  CDN/DDoS Protection | WAF | Rate Limiting | Geo-blocking  │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                    Application Layer                         │
│  Authentication | Authorization | Input Validation | Audit   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                      Data Layer                              │
│  Encryption at Rest | Access Control | Backup Encryption    │
└─────────────────────────────────────────────────────────────┘
```

## Threat Model

### Primary Threats

1. **DDoS Attacks**
   - Volumetric attacks
   - Protocol attacks
   - Application layer attacks

2. **Mining-Specific Attacks**
   - Block withholding
   - Selfish mining
   - Share manipulation
   - Difficulty exploitation

3. **Financial Attacks**
   - Double spending
   - Payment manipulation
   - Fee bypass attempts

4. **Data Breaches**
   - Database compromise
   - API key theft
   - Wallet key exposure

## Security Implementation

### 1. Network Security

#### Firewall Configuration

**iptables rules:**
```bash
#!/bin/bash
# Otedama firewall rules

# Clear existing rules
iptables -F
iptables -X

# Default policies
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT ACCEPT

# Loopback
iptables -A INPUT -i lo -j ACCEPT

# Established connections
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# SSH (restrict to management IPs)
iptables -A INPUT -p tcp --dport 22 -s 10.0.0.0/8 -j ACCEPT

# Stratum ports
iptables -A INPUT -p tcp --dport 3333 -j ACCEPT
iptables -A INPUT -p tcp --dport 3336 -j ACCEPT

# API (behind reverse proxy)
iptables -A INPUT -p tcp --dport 8080 -s 127.0.0.1 -j ACCEPT

# P2P
iptables -A INPUT -p tcp --dport 8333 -j ACCEPT

# Rate limiting
iptables -A INPUT -p tcp --dport 3333 -m connlimit --connlimit-above 10 -j REJECT
iptables -A INPUT -p tcp --dport 3333 -m recent --set --name STRATUM
iptables -A INPUT -p tcp --dport 3333 -m recent --update --seconds 1 --hitcount 20 --name STRATUM -j DROP

# DDoS protection
iptables -A INPUT -p tcp --tcp-flags ALL NONE -j DROP
iptables -A INPUT -p tcp --tcp-flags SYN,FIN SYN,FIN -j DROP
iptables -A INPUT -p tcp --tcp-flags SYN,RST SYN,RST -j DROP
iptables -A INPUT -f -j DROP

# Save rules
iptables-save > /etc/iptables/rules.v4
```

#### DDoS Protection

**Configure fail2ban:**
```ini
# /etc/fail2ban/jail.d/otedama.conf
[otedama-stratum]
enabled = true
port = 3333,3336
filter = otedama-stratum
logpath = /var/log/otedama/stratum.log
maxretry = 5
findtime = 60
bantime = 3600

[otedama-api]
enabled = true
port = 8080
filter = otedama-api
logpath = /var/log/otedama/api.log
maxretry = 100
findtime = 60
bantime = 3600
```

**Filter definitions:**
```ini
# /etc/fail2ban/filter.d/otedama-stratum.conf
[Definition]
failregex = ^.*\[SECURITY\].*Invalid share from <HOST>.*$
            ^.*\[SECURITY\].*Malformed request from <HOST>.*$
            ^.*\[SECURITY\].*Authentication failed from <HOST>.*$
```

### 2. Application Security

#### Input Validation

**Comprehensive validation middleware:**
```javascript
// lib/security/input-validator.js
import { body, param, query, validationResult } from 'express-validator';
import { SecuritySystem } from './national-security.js';

const security = new SecuritySystem();

// Validation rules
export const validators = {
  // Wallet address validation
  walletAddress: param('address')
    .matches(/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^0x[a-fA-F0-9]{40}$/)
    .withMessage('Invalid wallet address'),
  
  // Mining submission
  shareSubmission: [
    body('jobId').isHexadecimal().isLength({ min: 8, max: 64 }),
    body('nonce').isHexadecimal().isLength({ min: 8, max: 16 }),
    body('hash').optional().isHexadecimal().isLength({ min: 64, max: 64 })
  ],
  
  // Payment amount
  amount: body('amount')
    .isFloat({ min: 0.00000001, max: 21000000 })
    .withMessage('Invalid amount'),
  
  // API key
  apiKey: body('apiKey')
    .matches(/^[a-zA-Z0-9]{32,64}$/)
    .withMessage('Invalid API key format')
};

// Sanitization middleware
export const sanitizeInput = (req, res, next) => {
  // Remove null bytes
  const sanitize = (obj) => {
    for (let key in obj) {
      if (typeof obj[key] === 'string') {
        obj[key] = obj[key].replace(/\0/g, '');
      } else if (typeof obj[key] === 'object') {
        sanitize(obj[key]);
      }
    }
  };
  
  sanitize(req.body);
  sanitize(req.query);
  sanitize(req.params);
  
  next();
};

// SQL injection prevention
export const preventSQLInjection = (req, res, next) => {
  const suspicious = /(\b(union|select|insert|update|delete|drop)\b|--|;|\/\*|\*\/)/i;
  
  const checkValue = (value) => {
    if (typeof value === 'string' && suspicious.test(value)) {
      return true;
    }
    return false;
  };
  
  const check = (obj) => {
    for (let key in obj) {
      if (checkValue(obj[key])) {
        return true;
      }
      if (typeof obj[key] === 'object') {
        if (check(obj[key])) return true;
      }
    }
    return false;
  };
  
  if (check(req.body) || check(req.query) || check(req.params)) {
    security.blacklist(req.ip, 86400000); // 24 hour ban
    return res.status(400).json({ error: 'Invalid input detected' });
  }
  
  next();
};
```

#### Authentication & Authorization

**JWT implementation with refresh tokens:**
```javascript
// lib/security/auth-manager.js
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

export class AuthManager {
  constructor(config) {
    this.accessTokenSecret = config.jwtSecret;
    this.refreshTokenSecret = config.refreshSecret || crypto.randomBytes(64).toString('hex');
    this.accessTokenExpiry = config.accessTokenExpiry || '15m';
    this.refreshTokenExpiry = config.refreshTokenExpiry || '7d';
    
    this.refreshTokens = new Map(); // In production, use Redis
  }
  
  generateTokens(userId, role = 'user') {
    const payload = { userId, role };
    
    const accessToken = jwt.sign(
      payload,
      this.accessTokenSecret,
      { expiresIn: this.accessTokenExpiry }
    );
    
    const refreshToken = jwt.sign(
      payload,
      this.refreshTokenSecret,
      { expiresIn: this.refreshTokenExpiry }
    );
    
    // Store refresh token
    this.refreshTokens.set(refreshToken, {
      userId,
      role,
      created: Date.now()
    });
    
    return { accessToken, refreshToken };
  }
  
  verifyAccessToken(token) {
    try {
      return jwt.verify(token, this.accessTokenSecret);
    } catch (error) {
      throw new Error('Invalid access token');
    }
  }
  
  async refreshAccessToken(refreshToken) {
    try {
      const payload = jwt.verify(refreshToken, this.refreshTokenSecret);
      
      // Check if refresh token exists and is valid
      const stored = this.refreshTokens.get(refreshToken);
      if (!stored || stored.userId !== payload.userId) {
        throw new Error('Invalid refresh token');
      }
      
      // Generate new access token
      const accessToken = jwt.sign(
        { userId: payload.userId, role: payload.role },
        this.accessTokenSecret,
        { expiresIn: this.accessTokenExpiry }
      );
      
      return { accessToken };
      
    } catch (error) {
      throw new Error('Invalid refresh token');
    }
  }
  
  revokeRefreshToken(refreshToken) {
    this.refreshTokens.delete(refreshToken);
  }
  
  // Middleware
  authenticate(requiredRole = null) {
    return async (req, res, next) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      
      if (!token) {
        return res.status(401).json({ error: 'No token provided' });
      }
      
      try {
        const payload = this.verifyAccessToken(token);
        req.user = payload;
        
        // Check role if required
        if (requiredRole && payload.role !== requiredRole && payload.role !== 'admin') {
          return res.status(403).json({ error: 'Insufficient permissions' });
        }
        
        next();
      } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
      }
    };
  }
}
```

### 3. Data Security

#### Encryption at Rest

**Database encryption:**
```javascript
// lib/security/crypto-manager.js
import crypto from 'crypto';

export class CryptoManager {
  constructor(config) {
    this.algorithm = 'aes-256-gcm';
    this.keyDerivationIterations = 100000;
    
    // Master key should be stored in HSM or KMS in production
    this.masterKey = Buffer.from(config.encryptionKey, 'hex');
  }
  
  // Derive key from master key
  deriveKey(salt, info) {
    return crypto.hkdfSync(
      'sha256',
      this.masterKey,
      salt,
      info,
      32
    );
  }
  
  // Encrypt sensitive data
  encrypt(data, context = 'default') {
    const salt = crypto.randomBytes(32);
    const key = this.deriveKey(salt, context);
    const iv = crypto.randomBytes(16);
    
    const cipher = crypto.createCipheriv(this.algorithm, key, iv);
    
    const encrypted = Buffer.concat([
      cipher.update(data, 'utf8'),
      cipher.final()
    ]);
    
    const authTag = cipher.getAuthTag();
    
    // Combine salt, iv, authTag, and encrypted data
    return Buffer.concat([
      salt,
      iv,
      authTag,
      encrypted
    ]).toString('base64');
  }
  
  // Decrypt sensitive data
  decrypt(encryptedData, context = 'default') {
    const buffer = Buffer.from(encryptedData, 'base64');
    
    const salt = buffer.slice(0, 32);
    const iv = buffer.slice(32, 48);
    const authTag = buffer.slice(48, 64);
    const encrypted = buffer.slice(64);
    
    const key = this.deriveKey(salt, context);
    
    const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
    decipher.setAuthTag(authTag);
    
    return decipher.update(encrypted) + decipher.final('utf8');
  }
  
  // Hash passwords with salt
  async hashPassword(password) {
    const salt = crypto.randomBytes(32);
    const hash = crypto.pbkdf2Sync(
      password,
      salt,
      this.keyDerivationIterations,
      64,
      'sha512'
    );
    
    return `${salt.toString('hex')}:${hash.toString('hex')}`;
  }
  
  // Verify password
  async verifyPassword(password, storedHash) {
    const [salt, hash] = storedHash.split(':');
    
    const verifyHash = crypto.pbkdf2Sync(
      password,
      Buffer.from(salt, 'hex'),
      this.keyDerivationIterations,
      64,
      'sha512'
    );
    
    return crypto.timingSafeEqual(
      Buffer.from(hash, 'hex'),
      verifyHash
    );
  }
}
```

#### Secure Key Management

**Hardware Security Module (HSM) integration:**
```javascript
// lib/security/hsm-manager.js
import { CloudHSM } from '@aws-sdk/client-cloudhsm-v2';

export class HSMManager {
  constructor(config) {
    this.client = new CloudHSM({
      region: config.region,
      credentials: config.credentials
    });
    
    this.clusterId = config.clusterId;
  }
  
  async generateDataKey() {
    const command = {
      ClusterId: this.clusterId,
      KeySpec: 'AES_256'
    };
    
    const response = await this.client.generateDataKey(command);
    
    return {
      plaintext: response.Plaintext,
      ciphertext: response.CiphertextBlob
    };
  }
  
  async decrypt(ciphertextBlob) {
    const command = {
      ClusterId: this.clusterId,
      CiphertextBlob: ciphertextBlob
    };
    
    const response = await this.client.decrypt(command);
    return response.Plaintext;
  }
  
  async sign(data, keyId) {
    const command = {
      ClusterId: this.clusterId,
      KeyId: keyId,
      Message: data,
      SigningAlgorithm: 'ECDSA_SHA_256'
    };
    
    const response = await this.client.sign(command);
    return response.Signature;
  }
}
```

### 4. API Security

#### Rate Limiting

**Advanced rate limiting with Redis:**
```javascript
// lib/security/rate-limiter-advanced.js
import Redis from 'ioredis';
import { RateLimiterRedis } from 'rate-limiter-flexible';

export class AdvancedRateLimiter {
  constructor(config) {
    this.redis = new Redis(config.redis);
    
    // Different limiters for different endpoints
    this.limiters = {
      // General API
      api: new RateLimiterRedis({
        storeClient: this.redis,
        keyPrefix: 'rl:api',
        points: 1000,
        duration: 60,
        blockDuration: 300
      }),
      
      // Authentication
      auth: new RateLimiterRedis({
        storeClient: this.redis,
        keyPrefix: 'rl:auth',
        points: 5,
        duration: 900, // 15 minutes
        blockDuration: 900
      }),
      
      // Mining submissions
      mining: new RateLimiterRedis({
        storeClient: this.redis,
        keyPrefix: 'rl:mining',
        points: 10000,
        duration: 60,
        blockDuration: 60
      }),
      
      // Admin operations
      admin: new RateLimiterRedis({
        storeClient: this.redis,
        keyPrefix: 'rl:admin',
        points: 100,
        duration: 60,
        blockDuration: 3600
      })
    };
    
    // Distributed rate limiting for multiple instances
    this.distributedLimiter = new RateLimiterRedis({
      storeClient: this.redis,
      keyPrefix: 'rl:distributed',
      points: 100000,
      duration: 60,
      execEvenly: true
    });
  }
  
  middleware(type = 'api') {
    return async (req, res, next) => {
      const limiter = this.limiters[type];
      if (!limiter) {
        return next();
      }
      
      const key = req.ip;
      
      try {
        await limiter.consume(key);
        
        // Add rate limit headers
        const rateLimitInfo = await limiter.get(key);
        res.setHeader('X-RateLimit-Limit', limiter.points);
        res.setHeader('X-RateLimit-Remaining', rateLimitInfo?.remainingPoints || 0);
        res.setHeader('X-RateLimit-Reset', new Date(Date.now() + rateLimitInfo?.msBeforeNext || 0).toISOString());
        
        next();
      } catch (rejRes) {
        res.setHeader('Retry-After', Math.round(rejRes.msBeforeNext / 1000) || 60);
        res.status(429).json({
          error: 'Too Many Requests',
          retryAfter: Math.round(rejRes.msBeforeNext / 1000)
        });
      }
    };
  }
  
  // Dynamic rate limiting based on behavior
  async adjustLimits(ip, behavior) {
    const key = `behavior:${ip}`;
    
    if (behavior === 'suspicious') {
      // Reduce limits for suspicious behavior
      await this.limiters.api.block(ip, 3600); // 1 hour
    } else if (behavior === 'verified') {
      // Increase limits for verified users
      await this.limiters.api.reward(ip, 500);
    }
  }
}
```

### 5. Wallet Security

#### Multi-Signature Wallet

**Implementation:**
```javascript
// lib/security/multisig-wallet.js
import { bitcoin } from 'bitcoinjs-lib';

export class MultiSigWallet {
  constructor(config) {
    this.network = config.network || bitcoin.networks.bitcoin;
    this.requiredSignatures = config.requiredSignatures || 2;
    this.totalSigners = config.totalSigners || 3;
  }
  
  generateMultiSigAddress(publicKeys) {
    if (publicKeys.length !== this.totalSigners) {
      throw new Error(`Expected ${this.totalSigners} public keys`);
    }
    
    const pubkeys = publicKeys.map(hex => Buffer.from(hex, 'hex'));
    const p2ms = bitcoin.payments.p2ms({
      m: this.requiredSignatures,
      pubkeys,
      network: this.network
    });
    
    const p2sh = bitcoin.payments.p2sh({
      redeem: p2ms,
      network: this.network
    });
    
    return {
      address: p2sh.address,
      redeemScript: p2ms.output.toString('hex')
    };
  }
  
  createTransaction(inputs, outputs, redeemScript) {
    const txb = new bitcoin.TransactionBuilder(this.network);
    
    // Add inputs
    inputs.forEach(input => {
      txb.addInput(input.txid, input.vout);
    });
    
    // Add outputs
    outputs.forEach(output => {
      txb.addOutput(output.address, output.amount);
    });
    
    return {
      transaction: txb.buildIncomplete(),
      redeemScript: Buffer.from(redeemScript, 'hex')
    };
  }
  
  signTransaction(transaction, keyPair, redeemScript, inputIndex) {
    const tx = bitcoin.Transaction.fromHex(transaction);
    const txb = bitcoin.TransactionBuilder.fromTransaction(tx, this.network);
    
    txb.sign(
      inputIndex,
      keyPair,
      redeemScript
    );
    
    return txb.buildIncomplete().toHex();
  }
}
```

#### Cold Storage Integration

**Automated cold storage transfers:**
```javascript
// lib/security/cold-storage.js
export class ColdStorageManager {
  constructor(config) {
    this.hotWalletThreshold = config.hotWalletThreshold || 10; // BTC
    this.coldStorageAddress = config.coldStorageAddress;
    this.transferPercentage = config.transferPercentage || 0.9;
  }
  
  async checkAndTransfer(hotWallet) {
    const balance = await hotWallet.getBalance();
    
    if (balance > this.hotWalletThreshold) {
      const transferAmount = balance * this.transferPercentage;
      
      // Create transaction to cold storage
      const tx = await hotWallet.createTransaction({
        to: this.coldStorageAddress,
        amount: transferAmount,
        fee: 'priority'
      });
      
      // Log for audit
      await this.auditLog({
        event: 'COLD_STORAGE_TRANSFER',
        amount: transferAmount,
        txid: tx.id,
        timestamp: new Date().toISOString()
      });
      
      return tx;
    }
    
    return null;
  }
}
```

### 6. Monitoring & Incident Response

#### Security Information and Event Management (SIEM)

**Log aggregation and analysis:**
```javascript
// lib/security/siem.js
import { ElasticsearchClient } from '@elastic/elasticsearch';

export class SIEM {
  constructor(config) {
    this.client = new ElasticsearchClient({
      node: config.elasticsearch.node,
      auth: config.elasticsearch.auth
    });
    
    this.alertThresholds = {
      failedLogins: 10,
      invalidShares: 100,
      apiErrors: 50,
      suspiciousPatterns: 5
    };
  }
  
  async ingestLog(log) {
    await this.client.index({
      index: 'otedama-security',
      body: {
        ...log,
        '@timestamp': new Date().toISOString(),
        environment: process.env.NODE_ENV
      }
    });
  }
  
  async analyzePatterns() {
    // Failed login analysis
    const failedLogins = await this.client.search({
      index: 'otedama-security',
      body: {
        query: {
          bool: {
            must: [
              { match: { event: 'AUTH_FAILURE' } },
              { range: { '@timestamp': { gte: 'now-15m' } } }
            ]
          }
        },
        aggs: {
          by_ip: {
            terms: { field: 'ip.keyword', size: 100 }
          }
        }
      }
    });
    
    // Check thresholds
    for (const bucket of failedLogins.aggregations.by_ip.buckets) {
      if (bucket.doc_count > this.alertThresholds.failedLogins) {
        await this.createAlert({
          type: 'BRUTE_FORCE_ATTEMPT',
          severity: 'HIGH',
          ip: bucket.key,
          count: bucket.doc_count
        });
      }
    }
    
    // Similar analysis for other patterns...
  }
  
  async createAlert(alert) {
    // Send to alerting system
    await this.notificationService.send({
      channel: 'security-alerts',
      priority: alert.severity,
      message: `Security Alert: ${alert.type}`,
      details: alert
    });
    
    // Store alert
    await this.client.index({
      index: 'otedama-alerts',
      body: alert
    });
  }
}
```

#### Incident Response Plan

**Automated incident response:**
```javascript
// lib/security/incident-response.js
export class IncidentResponse {
  constructor(config) {
    this.playbooks = {
      BRUTE_FORCE: this.handleBruteForce.bind(this),
      DDoS: this.handleDDoS.bind(this),
      DATA_BREACH: this.handleDataBreach.bind(this),
      WALLET_COMPROMISE: this.handleWalletCompromise.bind(this)
    };
    
    this.notificationChannels = config.notificationChannels;
  }
  
  async handleIncident(type, details) {
    const playbook = this.playbooks[type];
    if (!playbook) {
      throw new Error(`No playbook for incident type: ${type}`);
    }
    
    // Create incident record
    const incident = {
      id: crypto.randomUUID(),
      type,
      details,
      status: 'ACTIVE',
      startTime: new Date().toISOString(),
      actions: []
    };
    
    // Execute playbook
    await playbook(incident);
    
    // Store incident
    await this.storage.saveIncident(incident);
    
    return incident;
  }
  
  async handleBruteForce(incident) {
    const { ip, targetAccount } = incident.details;
    
    // 1. Block IP immediately
    await this.security.blacklist(ip, 86400000); // 24 hours
    incident.actions.push({
      action: 'IP_BLOCKED',
      details: { ip, duration: '24h' }
    });
    
    // 2. Force password reset
    if (targetAccount) {
      await this.auth.forcePasswordReset(targetAccount);
      incident.actions.push({
        action: 'PASSWORD_RESET_FORCED',
        details: { account: targetAccount }
      });
    }
    
    // 3. Notify security team
    await this.notify('security', {
      level: 'HIGH',
      message: `Brute force attack detected from ${ip}`,
      incident
    });
    
    // 4. Increase monitoring
    await this.monitoring.increaseScrutiny(ip);
  }
  
  async handleDDoS(incident) {
    // 1. Enable DDoS protection mode
    await this.security.enableDDoSMode();
    
    // 2. Scale infrastructure
    await this.infrastructure.autoScale(5); // 5x capacity
    
    // 3. Enable rate limiting
    await this.rateLimiter.enableStrictMode();
    
    // 4. Notify operations team
    await this.notify('operations', {
      level: 'CRITICAL',
      message: 'DDoS attack in progress',
      incident
    });
  }
  
  async handleWalletCompromise(incident) {
    // 1. Freeze all payments immediately
    await this.payments.freezeAll();
    
    // 2. Move funds to secure wallet
    await this.wallet.emergencyTransfer();
    
    // 3. Notify executive team
    await this.notify('executive', {
      level: 'CRITICAL',
      message: 'Wallet compromise detected',
      incident
    });
    
    // 4. Begin forensic analysis
    await this.forensics.startAnalysis(incident);
  }
}
```

## Security Checklist

### Pre-Deployment

- [ ] All dependencies updated and audited
- [ ] Security headers configured
- [ ] SSL/TLS certificates installed
- [ ] Firewall rules configured
- [ ] DDoS protection enabled
- [ ] Rate limiting configured
- [ ] Input validation implemented
- [ ] Authentication system tested
- [ ] Encryption keys secured
- [ ] Backup encryption verified

### Post-Deployment

- [ ] Security monitoring active
- [ ] Incident response team notified
- [ ] Penetration testing scheduled
- [ ] Audit logging verified
- [ ] Compliance requirements met
- [ ] Security training completed
- [ ] Emergency procedures documented
- [ ] Recovery procedures tested

### Ongoing

- [ ] Daily security reports reviewed
- [ ] Weekly vulnerability scans
- [ ] Monthly penetration tests
- [ ] Quarterly security audits
- [ ] Annual disaster recovery drills

## Compliance

### Regulatory Requirements

1. **KYC/AML Compliance**
   - User verification required for withdrawals > $10,000
   - Transaction monitoring for suspicious patterns
   - Sanctions list screening

2. **Data Protection**
   - GDPR compliance for EU users
   - Data retention policies
   - Right to be forgotten implementation

3. **Financial Regulations**
   - Transaction reporting (CTR/SAR)
   - Anti-money laundering procedures
   - Tax reporting requirements

## Contact

**Security Team**: security@otedama.io
**Bug Bounty**: https://otedama.io/security/bounty
**Security Hotline**: +1-800-OTEDAMA (24/7)