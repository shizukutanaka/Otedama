/**
 * DEX Engine Main Entry Point
 * 
 * DEPRECATED: This file is maintained for backward compatibility only.
 * Please use lib/dex/index.js for the consolidated DEX implementation.
 */

import { getLogger } from '../core/logger.js';

const logger = getLogger('DEXEngine');
logger.warn('lib/dex/dex-engine.js is deprecated. Please use lib/dex/index.js');

// Re-export from compatibility layer
export { DEXEngine, DEXEngineV2, ORDER_TYPE, ORDER_SIDE, ORDER_STATUS, AdvancedOrderType } from './compatibility.js';
export { OrderType, OrderStatus } from './index.js';

// Export for backward compatibility
export { SupportedChains } from './cross-chain-bridge.js';

// Re-export trading pairs for backward compatibility
export const TRADING_PAIRS = [
  { base: 'BTC', quote: 'USDT' },
  { base: 'ETH', quote: 'USDT' },
  { base: 'ETH', quote: 'BTC' },
  { base: 'XMR', quote: 'BTC' },
  { base: 'RVN', quote: 'BTC' },
  { base: 'LTC', quote: 'BTC' },
  { base: 'DOGE', quote: 'USDT' },
  { base: 'DASH', quote: 'BTC' },
  { base: 'ZEC', quote: 'BTC' },
  { base: 'ETC', quote: 'ETH' }
];