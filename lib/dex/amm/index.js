/**
 * AMM Improvements Module
 * Export all AMM optimization components
 */

export { ConcentratedLiquidityPool } from './concentrated-liquidity.js';
export { DynamicFeeManager, FeeOracle } from './dynamic-fee.js';
export { MEVProtection } from './mev-protection.js';
export { AMMOptimizer } from './optimizer.js';

// Default export is the main optimizer
import AMMOptimizer from './optimizer.js';
export default AMMOptimizer;