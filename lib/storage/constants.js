/**
 * Storage Constants - Otedama
 */

// Cache TTL values
export const TTL = {
  VERY_SHORT: 1000,      // 1 second
  SHORT: 5000,           // 5 seconds
  MEDIUM: 60000,         // 1 minute
  LONG: 300000,          // 5 minutes
  VERY_LONG: 3600000,    // 1 hour
  DAY: 86400000,         // 24 hours
  PERMANENT: 0           // No expiration
};

// Cache key prefixes
export const CACHE_PREFIX = {
  WORKER: 'worker:',
  JOB: 'job:',
  SHARE: 'share:',
  BLOCK: 'block:',
  STATS: 'stats:',
  SESSION: 'session:',
  API: 'api:'
};

// Database tables
export const TABLES = {
  SHARES: 'shares',
  MINERS: 'miners',
  BLOCKS: 'blocks',
  PAYMENTS: 'payments'
};

// Storage limits
export const LIMITS = {
  MAX_CACHE_SIZE: 100 * 1024 * 1024, // 100MB
  MAX_CACHE_ITEMS: 10000,
  MAX_SHARES_IN_MEMORY: 100000,
  MAX_BLOCKS_IN_MEMORY: 1000,
  CLEANUP_THRESHOLD: 0.9 // Cleanup when 90% full
};

// File extensions
export const FILE_EXT = {
  JSON: '.json',
  BACKUP: '.bak',
  LOG: '.log',
  DB: '.db'
};

export default {
  TTL,
  CACHE_PREFIX,
  TABLES,
  LIMITS,
  FILE_EXT
};
