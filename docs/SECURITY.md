# Security Guide

This guide covers security features and best practices for Otedama.

## Table of Contents

1. [Security Features](#security-features)
2. [Configuration](#configuration)
3. [API Authentication](#api-authentication)
4. [Rate Limiting](#rate-limiting)
5. [DDoS Protection](#ddos-protection)
6. [Miner Authentication](#miner-authentication)
7. [Best Practices](#best-practices)

## Security Features

Otedama includes comprehensive security features:

- **DDoS Protection**: Built-in rate limiting and IP blocking
- **Authentication**: Token-based API authentication
- **Rate Limiting**: Configurable per-endpoint limits
- **IP Whitelisting**: Allow trusted miners bypass security
- **Password Hashing**: PBKDF2 with 100,000 iterations
- **Input Validation**: All inputs are sanitized and validated

## Configuration

### Basic Security Setup

```javascript
const security = new SecurityManager(logger);

// Configure rate limits
security.addRateLimit({
  endpoint: '/api/*',
  window: 60000, // 1 minute
  maxRequests: 100,
  blockDuration: 300000 // 5 minutes
});

// Stratum-specific limits
security.addRateLimit({
  endpoint: 'stratum:submit',
  window: 1000, // 1 second
  maxRequests: 100,
  blockDuration: 60000 // 1 minute
});
```

### Environment Variables

```bash
# .env file
API_SECRET_KEY=your-secret-key-here
DATABASE_ENCRYPTION_KEY=your-encryption-key
ADMIN_PASSWORD_HASH=pbkdf2-hash-here
```

## API Authentication

### Generating Tokens

```javascript
// Generate API token
const token = security.generateToken('user-id', ['read', 'write']);

// Validate token
const authToken = security.validateToken(token);
if (authToken && authToken.permissions.includes('write')) {
  // Allow write access
}
```

### Using API Keys

```javascript
// Generate API key for external service
const apiKey = security.addAPIKey('monitoring-service', ['read']);
console.log('API Key:', apiKey); // Save this securely

// Validate API key in requests
const validKey = security.validateAPIKey(providedKey);
```

### HTTP Headers

```bash
# Using token
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8445/api/secure

# Using API key
curl -H "X-API-Key: YOUR_API_KEY" http://localhost:8445/api/secure
```

## Rate Limiting

### Default Limits

| Endpoint | Window | Max Requests | Block Duration |
|----------|--------|--------------|----------------|
| /api/* | 1 minute | 100 | 5 minutes |
| stratum:authorize | 1 minute | 10 | 10 minutes |
| stratum:submit | 1 second | 100 | 1 minute |

### Custom Rate Limits

```javascript
// Add custom rate limit
security.addRateLimit({
  endpoint: '/api/expensive-operation',
  window: 300000, // 5 minutes
  maxRequests: 5,
  blockDuration: 1800000 // 30 minutes
});

// Check rate limit manually
const allowed = security.checkRateLimit(clientIp, '/api/stats');
if (!allowed) {
  // Return 429 Too Many Requests
}
```

## DDoS Protection

### Automatic IP Blocking

```javascript
// IPs are automatically blocked when rate limits are exceeded
// Manual blocking
security.blockIP('192.168.1.100', 3600000); // Block for 1 hour

// Unblock IP
security.unblockIP('192.168.1.100');
```

### Firewall Rules

Recommended iptables rules:

```bash
# Limit new connections
iptables -A INPUT -p tcp --dport 3333 -m state --state NEW -m limit --limit 10/s --limit-burst 20 -j ACCEPT

# Drop excessive connections
iptables -A INPUT -p tcp --dport 3333 -m state --state NEW -j DROP

# Limit per IP
iptables -A INPUT -p tcp --dport 3333 -m connlimit --connlimit-above 10 -j REJECT
```

## Miner Authentication

### Address Validation

```javascript
// Basic validation (automatic)
const isValid = await security.validateMiner(minerAddress);

// With signature verification
const isValid = await security.validateMiner(minerAddress, signature);
```

### Whitelisting Trusted Miners

```javascript
// Whitelist miner (bypasses rate limits)
security.whitelistMiner('TRUSTED_WALLET_ADDRESS');

// Remove from whitelist
security.unwhitelistMiner('TRUSTED_WALLET_ADDRESS');

// Check if whitelisted
const stats = security.getStats();
console.log('Whitelisted miners:', stats.whitelistedMiners);
```

## Best Practices

### 1. Use HTTPS in Production

```nginx
server {
    listen 443 ssl;
    server_name pool.example.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:8445;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 2. Secure Configuration

```javascript
// config/production.json
{
  "api": {
    "enabled": true,
    "port": 8445,
    "host": "127.0.0.1" // Only localhost in production
  },
  "security": {
    "enableAuthentication": true,
    "requireApiKey": true,
    "maxFailedAttempts": 3,
    "blockDuration": 3600000
  }
}
```

### 3. Monitor Security Events

```javascript
// Listen for security events
security.on('rate-limit-exceeded', ({ identifier, endpoint }) => {
  logger.warn('Rate limit exceeded', { identifier, endpoint });
  // Send alert
});

security.on('ip-blocked', ({ ip, unblockTime }) => {
  logger.warn('IP blocked', { ip, unblockTime });
  // Log to security monitoring system
});
```

### 4. Regular Security Audits

```bash
# Check for vulnerabilities
npm audit

# Update dependencies
npm update

# Review security stats
curl http://localhost:8445/security/stats
```

### 5. Secure Database

```javascript
// Use encrypted connections
const dbConfig = {
  type: 'postgresql',
  connectionString: 'postgresql://user:password@localhost/otedama',
  ssl: {
    rejectUnauthorized: true,
    ca: fs.readFileSync('server-ca.pem')
  }
};
```

### 6. Password Security

```javascript
// Hash passwords before storing
const { hash, salt } = await security.hashPassword(plainPassword);

// Verify passwords
const isValid = await security.verifyPassword(plainPassword, hash, salt);
```

### 7. Input Validation

All inputs are automatically validated, but you can add custom validation:

```javascript
// Custom miner validation
class CustomSecurity extends SecurityManager {
  async validateMiner(address: string, signature?: string): Promise<boolean> {
    // Add custom validation logic
    if (!address.startsWith('R')) {
      return false; // Ravencoin addresses start with R
    }
    
    return super.validateMiner(address, signature);
  }
}
```

## Security Monitoring

### Metrics to Monitor

1. **Failed Authentication Attempts**
   - Track failed logins
   - Alert on suspicious patterns

2. **Rate Limit Violations**
   - Monitor which endpoints are hit most
   - Identify potential attacks

3. **Blocked IPs**
   - Review blocked IP list regularly
   - Look for patterns

4. **API Usage**
   - Track API key usage
   - Monitor for anomalies

### Security Dashboard

```javascript
// Get security statistics
const stats = security.getStats();
console.log('Security Stats:', {
  activeTokens: stats.activeTokens,
  blockedIPs: stats.blockedIPs,
  whitelistedMiners: stats.whitelistedMiners,
  rateLimitViolations: stats.activeRequestCounts
});
```

## Incident Response

### 1. Detect
- Monitor logs for suspicious activity
- Set up alerts for security events
- Regular security audits

### 2. Respond
- Automatically block malicious IPs
- Revoke compromised tokens
- Increase rate limits if needed

### 3. Recover
- Unblock legitimate IPs
- Issue new tokens
- Review and update security policies

### 4. Learn
- Analyze attack patterns
- Update security rules
- Improve monitoring

## Compliance

Ensure compliance with relevant regulations:

- **GDPR**: Implement data protection measures
- **KYC/AML**: If required in your jurisdiction
- **Data Retention**: Configure appropriate retention policies
- **Audit Logs**: Maintain security audit trails