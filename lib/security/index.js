/**
 * Security Module - Unified Export
 * Consolidates all security implementations into a single interface
 * Maintains backward compatibility while using the core security manager
 */

// Import the unified security manager
import { SecurityManager } from '../core/security-manager.js';
export { SecurityManager as default };

// Re-export all security utilities for backward compatibility
export * from './core.js';
export * from './rate-limiter.js';
export * from './csrf-protection.js';
export * from './session-manager.js';
export * from './api-key-manager.js';
export * from './ip-list-manager.js';
export * from './audit.js';
export * from './ddos-protection.js';

// Import specific implementations for selective exports
import { UnifiedSecurityMiddleware } from './unified-security-middleware.js';
import { SecurityEnhanced } from './enhanced.js';
import { SecurityHardening } from './security-hardening.js';

// Export specific implementations
export { UnifiedSecurityMiddleware, SecurityEnhanced, SecurityHardening };

// Create unified middleware factory
export function createSecurityMiddleware(options = {}) {
  // Use the UnifiedSecurityMiddleware which already integrates everything
  return new UnifiedSecurityMiddleware(options);
}

// Helper function to create a security manager instance
export function createSecurityManager(options = {}) {
  return new SecurityManager(options);
}

// Export common security utilities
export const SecurityUtils = {
  generateSecureToken: (length = 32) => {
    const { randomBytes } = require('crypto');
    return randomBytes(length).toString('hex');
  },
  
  hashPassword: async (password) => {
    const bcrypt = await import('bcrypt');
    return bcrypt.hash(password, 10);
  },
  
  verifyPassword: async (password, hash) => {
    const bcrypt = await import('bcrypt');
    return bcrypt.compare(password, hash);
  },
  
  sanitizeInput: (input) => {
    if (typeof input !== 'string') return input;
    return input
      .replace(/[<>]/g, '') // Remove potential HTML tags
      .replace(/javascript:/gi, '') // Remove javascript: protocol
      .replace(/on\w+\s*=/gi, '') // Remove event handlers
      .trim();
  },
  
  validateEmail: (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  },
  
  validateUrl: (url) => {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }
};

// Backward compatibility aliases
export const Security = {
  Manager: SecurityManager,
  Middleware: UnifiedSecurityMiddleware,
  Enhanced: SecurityEnhanced,
  Hardening: SecurityHardening,
  Utils: SecurityUtils
};