/**
 * Unified Security Module for Otedama
 * Combines all security features into a clean, maintainable structure
 * 
 * Design principles:
 * - Carmack: Performance-critical security operations
 * - Martin: Clean separation of concerns
 * - Pike: Simple, composable security components
 */

// Core security components
export { DDoSProtection } from './ddos-protection.js';
export { RateLimiter } from './rate-limiter.js';
export { AuditCompliance } from './audit-compliance.js';
export { AuthManager } from './auth-manager.js';
export { InputValidator } from './input-validator.js';
export { EncryptionManager } from './encryption-manager.js';

// Advanced security features
export { ThreatDetection } from './advanced-threat-detection.js';
export { NationalSecurity } from './national-security.js';
export { ZKPComplianceSystem } from '../zkp/zkp-compliance.js';

// Network security
export { NetworkSecurity } from './network-security.js';
export { MTLSImplementation } from './mtls-implementation.js';

// Session and authentication
export { SessionManager } from './session-manager.js';
export { CSRFProtection } from './csrf-protection.js';

// Specialized features
export { MEVProtection } from './mev-protection.js';
export { FeeProtection } from './fee-protection.js';
export { MultiSignature } from './multi-signature.js';

// Security middleware
export { createSecurityMiddleware } from './unified-security-middleware.js';

// Import quantum-resistant crypto
import { getQuantumCrypto } from './quantum-resistant-crypto.js';

// Default security manager
class SecurityManager {
  constructor(options = {}) {
    this.ddos = new DDoSProtection(options.ddos);
    this.rateLimiter = new RateLimiter(options.rateLimit);
    this.auth = new AuthManager(options.auth);
    this.audit = new AuditCompliance(options.audit);
    this.threat = new ThreatDetection(options.threat);
    this.zkp = new ZKPComplianceSystem(options.zkp);
    this.quantumCrypto = getQuantumCrypto(options.quantum);
  }
  
  async initialize() {
    await Promise.all([
      this.ddos.initialize(),
      this.rateLimiter.initialize(),
      this.auth.initialize(),
      this.audit.initialize(),
      this.threat.initialize(),
      this.zkp.initialize()
    ]);
  }
  
  middleware() {
    return createSecurityMiddleware({
      ddos: this.ddos,
      rateLimiter: this.rateLimiter,
      auth: this.auth,
      audit: this.audit,
      threat: this.threat
    });
  }
  
  async shutdown() {
    await Promise.all([
      this.ddos.shutdown(),
      this.rateLimiter.shutdown(),
      this.auth.shutdown(),
      this.audit.shutdown(),
      this.threat.shutdown(),
      this.zkp.shutdown()
    ]);
  }
}

export default SecurityManager;
