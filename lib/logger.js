/**
 * Logger compatibility layer
 * Redirects to the unified logger implementation in core
 * 
 * This file exists to maintain backward compatibility with code that imports from 'lib/logger'
 * All new code should import directly from 'lib/core/logger'
 */

// Re-export everything from core logger
module.exports = require('./core/logger');