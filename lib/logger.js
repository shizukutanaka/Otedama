/**
 * Logger compatibility layer
 * Redirects to the unified logger implementation in core
 */

// Re-export everything from core logger
module.exports = require('./core/logger');

// Maintain backward compatibility
const { getLogger } = require('./core/logger');
module.exports.createLogger = (options) => getLogger('app', options);