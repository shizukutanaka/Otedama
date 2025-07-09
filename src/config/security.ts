// Security configuration for Otedama Light
// Contains settings for DDoS protection, rate limiting, and other security features

export interface DDoSProtectionConfig {
  // Connection limits
  maxConnectionsPerIP: number;      // Maximum connections from a single IP
  maxTotalConnections: number;      // Maximum total connections to the server
  
  // Rate limiting
  maxRequestsPerMinute: number;     // Maximum requests per minute from a single IP
  maxRequestBurst: number;          // Maximum burst of requests allowed
  
  // Blocking
  blockDuration: number;            // Duration to block IPs in milliseconds
  autoBlockThreshold: number;       // Number of violations before auto-blocking
  
  // Advanced settings
  ipReputationEnabled: boolean;     // Whether to use IP reputation system
  geographicFilteringEnabled: boolean; // Whether to use geographic filtering
  
  // Whitelisted IPs (never blocked)
  whitelistedIPs: string[];
}

export interface ShareThrottlerConfig {
  maxSharesPerSecond: number;       // Maximum shares per second from a miner
  burstSize: number;                // Maximum burst of shares allowed
  penaltyDuration: number;          // Duration of penalty for exceeding limits
}

export interface SynFloodConfig {
  maxSynPerIP: number;              // Maximum SYN packets from a single IP
  synTimeout: number;               // Timeout for SYN connections in milliseconds
}

// Default configuration
export const defaultSecurityConfig = {
  ddosProtection: {
    maxConnectionsPerIP: 10,        // Allow up to 10 connections per IP
    maxTotalConnections: 10000,     // Allow up to 10,000 total connections
    maxRequestsPerMinute: 1200,     // Allow up to 20 requests per second (1200/min)
    maxRequestBurst: 100,           // Allow bursts of up to 100 requests
    blockDuration: 3600000,         // Block for 1 hour (in milliseconds)
    autoBlockThreshold: 5,          // Auto-block after 5 violations
    ipReputationEnabled: false,     // IP reputation system disabled by default
    geographicFilteringEnabled: false, // Geographic filtering disabled by default
    whitelistedIPs: ['127.0.0.1']   // Localhost is always whitelisted
  },
  
  shareThrottler: {
    maxSharesPerSecond: 100,        // Maximum 100 shares per second
    burstSize: 200,                 // Allow bursts of up to 200 shares
    penaltyDuration: 300000         // 5 minute penalty for exceeding limits
  },
  
  synFlood: {
    maxSynPerIP: 30,                // Maximum 30 SYN packets per IP
    synTimeout: 30000               // 30 second timeout for SYN connections
  }
};

// Load configuration from environment or config file
export function loadSecurityConfig(): {
  ddosProtection: DDoSProtectionConfig;
  shareThrottler: ShareThrottlerConfig;
  synFlood: SynFloodConfig;
} {
  // In a real implementation, this would load from a config file or environment variables
  // For now, just return the default config
  return defaultSecurityConfig;
}
