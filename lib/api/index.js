/**
 * API Module Index for Otedama
 * Exports unified API components
 */

export { APIServer as default } from './unified-api-server.js';
export { APIServer } from './unified-api-server.js';

// Legacy exports for compatibility
export { APIServer as PoolAPIServer } from './pool-api-server.js';
export { DashboardAPI } from './dashboard-api.js';
export { MinerAPI } from './miner-api.js';
export { RemoteManagementAPI } from './remote-management.js';

// New API modules
export { SoloMiningAPI } from './solo-mining-api.js';
export { PayoutPreferencesAPI } from './payout-preferences-api.js';
