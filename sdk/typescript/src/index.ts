/**
 * Otedama Pool SDK - Main entry point
 */

// Export main SDK class
export { OtedamaPoolSDK } from './client';
export { default } from './client';

// Export types
export * from './types';

// Export errors
export * from './errors';

// Export convenience factory function
import { OtedamaPoolSDK } from './client';
import { OtedamaConfig } from './types';

export function createClient(config: OtedamaConfig): OtedamaPoolSDK {
  return new OtedamaPoolSDK(config);
}

// Version info
export const VERSION = '1.0.0';
