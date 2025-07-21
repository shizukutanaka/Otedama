/**
 * i18n compatibility layer
 * Redirects to the unified i18n implementation
 */

export * from './i18n/index.js';
export { default } from './i18n/index.js';

// Maintain backward compatibility
import { getI18n } from './i18n/index.js';
export const createI18n = (options) => getI18n(options);
export const t = (key, params, options) => getI18n().t(key, params, options);