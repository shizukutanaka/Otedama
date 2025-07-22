/**
 * Logger compatibility layer
 * Redirects to the unified logger implementation in core
 */

export * from './core/logger.js';
export { default } from './core/logger.js';

// Maintain backward compatibility
import { getLogger } from './core/logger.js';
export const createLogger = (options) => getLogger('app', options);