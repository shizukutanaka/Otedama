/**
 * Profitability Calculator Module
 * Complete mining profitability calculation system
 */

// Core calculator
export {
  ProfitabilityCalculator,
  createProfitabilityCalculator,
  COMMON_HARDWARE,
  type HashingPowerUnit,
  type PowerConsumption,
  type ElectricityCost,
  type NetworkStats,
  type MiningHardware,
  type ProfitabilityResult,
  type CalculationInput
} from './profitability-calculator';

// Service layer
export {
  ProfitabilityService,
  createProfitabilityService,
  type MarketData,
  type PoolStats,
  type ProfitabilityServiceConfig
} from './profitability-service';

// API routes
export {
  setupProfitabilityRoutes,
  integrateProfitabilityAPI,
  type ProfitabilityApiRoutes
} from './profitability-api';
