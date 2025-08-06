# Security Guide

Comprehensive security guide for deploying and operating Otedama in production environments.

## Table of Contents

- [Security Overview](#security-overview)
- [Network Security](#network-security)
- [Authentication & Authorization](#authentication--authorization)
- [Encryption](#encryption)
- [Wallet Security](#wallet-security)
- [Smart Contract Security](#smart-contract-security)
- [Operational Security](#operational-security)
- [Incident Response](#incident-response)
- [Compliance](#compliance)
- [Security Checklist](#security-checklist)

## Security Overview

Otedama implements defense-in-depth security:

1. **Network Layer**: DDoS protection, rate limiting, firewall rules
2. **Transport Layer**: TLS encryption, certificate pinning
3. **Application Layer**: Input validation, CSRF/XSS protection
4. **Data Layer**: Encryption at rest, secure key storage
5. **Access Layer**: RBAC, MFA, audit logging

## Network Security

### DDoS Protection

Configure DDoS protection in `config.yaml`:

```yaml
security:
  ddos:
    enabled: true
    # Connection limits
    maxConnectionsPerIP: 10
    connectionRatePerIP: 5  # per second
    
    # Packet filtering
    synCookies: true
    connectionTimeout: 30s
    
    # Blacklisting
    autoBlacklist: true
    blacklistDuration: 1h
    blacklistThreshold: 100  # violations
```

### Firewall Rules

#### iptables Configuration

```bash
#!/bin/bash
# Basic firewall rules for Otedama

# Flush existing rules
iptables -F

# Default policies
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT ACCEPT

# Allow localhost
iptables -A INPUT -i lo -j ACCEPT

# Allow established connections
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow SSH (restrict source IP in production)
iptables -A INPUT -p tcp --dport 22 -j ACCEPT

# Allow Otedama ports
iptables -A INPUT -p tcp --dport 8080 -j ACCEPT  # API
iptables -A INPUT -p tcp --dport 3333 -j ACCEPT  # Stratum

# Rate limiting
iptables -A INPUT -p tcp --dport 3333 -m state --state NEW -m recent --set
iptables -A INPUT -p tcp --dport 3333 -m state --state NEW -m recent --update --seconds 60 --hitcount 10 -j DROP

# DDoS protection
iptables -A INPUT -p tcp --syn -m limit --limit 1/s --limit-burst 3 -j ACCEPT
iptables -A INPUT -p tcp --syn -j DROP

# Save rules
iptables-save > /etc/iptables/rules.v4
```

### Rate Limiting

Configure application-level rate limiting:

```go
// middleware/ratelimit.go
func RateLimitMiddleware(config RateLimitConfig) gin.HandlerFunc {
    limiter := rate.NewLimiter(
        rate.Limit(config.RequestsPerSecond),
        config.BurstSize,
    )
    
    return func(c *gin.Context) {
        if !limiter.Allow() {
            c.JSON(429, gin.H{
                "error": "Too many requests",
            })
            c.Abort()
            return
        }
        c.Next()
    }
}
```

## Authentication & Authorization

### Multi-Factor Authentication (MFA)

Enable MFA for all administrative accounts:

```yaml
auth:
  mfa:
    required: true
    providers:
      - totp
      - webauthn
      - sms
    backupCodes: 8
    gracePeriod: 30d  # for new accounts
```

### Role-Based Access Control (RBAC)

Define roles and permissions:

```yaml
rbac:
  roles:
    - name: admin
      permissions:
        - "*"
    
    - name: operator
      permissions:
        - "pool:read"
        - "pool:manage"
        - "worker:*"
        - "payout:read"
    
    - name: miner
      permissions:
        - "worker:create"
        - "worker:read:own"
        - "stats:read:own"
        - "payout:read:own"
    
    - name: viewer
      permissions:
        - "stats:read:public"
        - "pool:read:public"
```

### API Authentication

#### JWT Configuration

```yaml
jwt:
  secret: "${JWT_SECRET}"  # Use environment variable
  algorithm: "HS256"
  expiry: 24h
  refreshExpiry: 7d
  issuer: "otedama"
```

#### API Key Management

```go
// Generate secure API key
func GenerateAPIKey() (string, error) {
    bytes := make([]byte, 32)
    if _, err := rand.Read(bytes); err != nil {
        return "", err
    }
    return base64.URLEncoding.EncodeToString(bytes), nil
}

// Validate API key
func ValidateAPIKey(key string) (*User, error) {
    hash := sha256.Sum256([]byte(key))
    user, err := db.GetUserByAPIKeyHash(hex.EncodeToString(hash[:]))
    if err != nil {
        return nil, ErrInvalidAPIKey
    }
    return user, nil
}
```

## Encryption

### TLS Configuration

#### Certificate Management

```yaml
tls:
  enabled: true
  certFile: "/etc/otedama/tls/cert.pem"
  keyFile: "/etc/otedama/tls/key.pem"
  minVersion: "1.2"
  cipherSuites:
    - TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
    - TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
    - TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
    - TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
```

#### Auto-renewal with Let's Encrypt

```bash
# Install certbot
apt-get install certbot

# Obtain certificate
certbot certonly --standalone -d pool.example.com

# Auto-renewal cron job
echo "0 0 * * * /usr/bin/certbot renew --quiet --post-hook 'systemctl reload otedama'" > /etc/cron.d/certbot
```

### Data Encryption

#### Encryption at Rest

```go
// Encrypt sensitive data before storage
func EncryptData(data []byte, key []byte) ([]byte, error) {
    block, err := aes.NewCipher(key)
    if err != nil {
        return nil, err
    }
    
    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return nil, err
    }
    
    nonce := make([]byte, gcm.NonceSize())
    if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
        return nil, err
    }
    
    return gcm.Seal(nonce, nonce, data, nil), nil
}
```

## Wallet Security

### Secure Key Storage

#### Hardware Security Module (HSM)

```yaml
wallet:
  hsm:
    enabled: true
    provider: "pkcs11"
    library: "/usr/lib/softhsm/libsofthsm2.so"
    slot: 0
    pin: "${HSM_PIN}"
```

#### Key Derivation

```go
// Hierarchical Deterministic (HD) wallet
func DeriveKey(masterKey []byte, path string) (*ecdsa.PrivateKey, error) {
    // Parse derivation path (e.g., "m/44'/60'/0'/0/0")
    indexes := parsePath(path)
    
    key := masterKey
    for _, index := range indexes {
        key = deriveChild(key, index)
    }
    
    return ecdsa.GenerateKey(elliptic.P256(), bytes.NewReader(key))
}
```

### Cold Storage Integration

```yaml
wallet:
  coldStorage:
    enabled: true
    threshold: 100  # BTC
    address: "bc1qcold..."
    confirmations: 6
    schedule: "0 2 * * *"  # Daily at 2 AM
```

## Smart Contract Security

### Vulnerability Scanning

```go
// Smart contract security scanner
type ContractScanner struct {
    patterns []SecurityPattern
}

func (s *ContractScanner) Scan(code []byte) []Vulnerability {
    var vulnerabilities []Vulnerability
    
    // Check for reentrancy
    if hasReentrancy(code) {
        vulnerabilities = append(vulnerabilities, Vulnerability{
            Type:     "reentrancy",
            Severity: "high",
            Line:     findReentrancyLine(code),
        })
    }
    
    // Check for integer overflow
    if hasIntegerOverflow(code) {
        vulnerabilities = append(vulnerabilities, Vulnerability{
            Type:     "integer_overflow",
            Severity: "medium",
        })
    }
    
    return vulnerabilities
}
```

### Safe Interaction Patterns

```solidity
// Safe withdrawal pattern
contract SafePool {
    mapping(address => uint256) private balances;
    mapping(address => bool) private locked;
    
    modifier noReentrant() {
        require(!locked[msg.sender], "Reentrant call");
        locked[msg.sender] = true;
        _;
        locked[msg.sender] = false;
    }
    
    function withdraw(uint256 amount) public noReentrant {
        require(balances[msg.sender] >= amount, "Insufficient balance");
        
        balances[msg.sender] -= amount;
        
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");
        
        emit Withdrawal(msg.sender, amount);
    }
}
```

## Operational Security

### Secure Deployment

#### Environment Variables

```bash
# .env.production (never commit!)
DATABASE_PASSWORD=complex-password-here
JWT_SECRET=random-secret-here
ENCRYPTION_KEY=32-byte-key-here
HSM_PIN=hsm-pin-here
```

#### Secrets Management

```yaml
# Using HashiCorp Vault
vault:
  enabled: true
  address: "https://vault.example.com"
  token: "${VAULT_TOKEN}"
  paths:
    database: "secret/data/otedama/database"
    jwt: "secret/data/otedama/jwt"
    encryption: "secret/data/otedama/encryption"
```

### Audit Logging

```yaml
audit:
  enabled: true
  targets:
    - type: file
      path: "/var/log/otedama/audit.log"
      format: json
      rotation:
        maxSize: 100M
        maxAge: 90d
        compress: true
    
    - type: siem
      endpoint: "https://siem.example.com/api/events"
      token: "${SIEM_TOKEN}"
  
  events:
    - authentication
    - authorization
    - configuration_change
    - wallet_operation
    - admin_action
    - security_event
```

### Monitoring & Alerting

```yaml
security_monitoring:
  alerts:
    - name: "Multiple failed login attempts"
      condition: "failed_login_count > 5"
      window: "5m"
      action: "block_ip"
    
    - name: "Unusual withdrawal pattern"
      condition: "withdrawal_amount > avg_withdrawal * 10"
      action: "require_manual_approval"
    
    - name: "New IP for admin account"
      condition: "admin_login && !known_ip"
      action: "send_alert"
```

## Incident Response

### Response Plan

1. **Detection**: Automated alerts, monitoring dashboards
2. **Containment**: Isolate affected systems, block malicious IPs
3. **Investigation**: Analyze logs, identify root cause
4. **Remediation**: Apply fixes, patch vulnerabilities
5. **Recovery**: Restore normal operations
6. **Lessons Learned**: Post-mortem, update procedures

### Emergency Procedures

```bash
#!/bin/bash
# Emergency shutdown script

# Stop all services
systemctl stop otedama

# Block all incoming connections except SSH
iptables -P INPUT DROP
iptables -A INPUT -p tcp --dport 22 -j ACCEPT

# Backup critical data
tar -czf /backup/emergency-$(date +%Y%m%d-%H%M%S).tar.gz /var/lib/otedama

# Notify team
curl -X POST https://api.pagerduty.com/incidents \
  -H "Authorization: Token token=${PAGERDUTY_TOKEN}" \
  -d '{"incident":{"type":"incident","title":"Emergency shutdown activated"}}'
```

## Compliance

### GDPR Compliance

```yaml
gdpr:
  enabled: true
  dataRetention:
    logs: 90d
    userdata: 2y
    transactions: 7y
  
  anonymization:
    enabled: true
    fields:
      - ip_address
      - email
      - wallet_address
  
  exportFormat: "json"
  deletionGracePeriod: 30d
```

### Security Standards

- **PCI DSS**: For payment processing
- **SOC 2**: For service organizations
- **ISO 27001**: Information security management
- **NIST Cybersecurity Framework**: Risk management

## Security Checklist

### Pre-deployment

- [ ] Generate strong passwords for all services
- [ ] Configure TLS certificates
- [ ] Set up firewall rules
- [ ] Enable audit logging
- [ ] Configure backup procedures
- [ ] Set up monitoring and alerting
- [ ] Review and update dependencies
- [ ] Perform security scan
- [ ] Configure rate limiting
- [ ] Enable DDoS protection

### Post-deployment

- [ ] Verify TLS configuration (SSL Labs)
- [ ] Test rate limiting
- [ ] Verify backup restoration
- [ ] Conduct penetration testing
- [ ] Review audit logs
- [ ] Update security documentation
- [ ] Train operations team
- [ ] Schedule security reviews
- [ ] Monitor security advisories
- [ ] Plan incident response drills

### Ongoing

- [ ] Weekly: Review audit logs
- [ ] Monthly: Update dependencies
- [ ] Quarterly: Security assessment
- [ ] Annually: Penetration testing
- [ ] Continuously: Monitor threats

## Security Contacts

- **Security Team**: security@otedama.io
- **Bug Bounty**: https://otedama.io/security/bounty
- **PGP Key**: https://otedama.io/security/pgp
- **Emergency**: Use PagerDuty integration