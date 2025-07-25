/**
 * Security Module - Otedama
 * National-grade security implementation
 * 
 * Design:
 * - Carmack: Fast security checks
 * - Martin: Layered security architecture
 * - Pike: Simple but effective security
 */

// National security system
export {
  SecuritySystem,
  AdvancedRateLimiter,
  ReputationManager,
  AttackDetector
} from './national-security.js';

// DDoS protection
export { DDoSProtection } from './ddos-protection.js';

// Ban manager
export { BanManager } from './ban-manager.js';

// Threat detection
export { ThreatDetection } from './threat-detection.js';

// Default export
export default {
  SecuritySystem,
  AdvancedRateLimiter,
  ReputationManager,
  AttackDetector,
  DDoSProtection,
  BanManager,
  ThreatDetection
};
