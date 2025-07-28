/**
 * API Module Index for Otedama
 * Exports unified API components
 */

export { UnifiedAPIServer as default } from './unified-api-server.js';
export { UnifiedAPIServer as APIServer } from './unified-api-server.js';

// API middleware and utilities
export { rateLimitMiddleware } from './rate-limit-middleware.js';
export { requestLogger } from './request-logger.js';
export { responseFormatter } from './response-formatter.js';

// Specialized API modules
export { RemoteManagementAPI } from './remote-management.js';
export { SoloMiningAPI } from './solo-mining-api.js';
export { PayoutPreferencesAPI } from './payout-preferences-api.js';
export { ZKPAuthAPI } from './zkp-auth-api.js';
export { NotificationEndpoints } from './notification-endpoints.js';
export { MobileAPI } from './mobile-api.js';
export { StatisticsAPI } from './statistics-api.js';
