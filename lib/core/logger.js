/**
 * Logger Compatibility Module for Otedama
 * Provides backward compatibility for modules importing logger.js
 * 
 * Design: Simple compatibility layer (Pike principle)
 */

// Re-export from structured-logger
export { createStructuredLogger as createLogger } from './structured-logger.js';
export { createStructuredLogger } from './structured-logger.js';

// Default logger instance
import { createStructuredLogger } from './structured-logger.js';
export const logger = createStructuredLogger('Default');

// For backward compatibility with different import styles
export const getLogger = (name) => createStructuredLogger(name);
export default logger;