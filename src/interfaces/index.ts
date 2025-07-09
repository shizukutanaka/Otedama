// Central export point for all interfaces
// This follows the Interface Segregation Principle - clients should not be forced to depend on interfaces they don't use

// Core interfaces
export * from './core/IMiningPool';

// Security interfaces
export * from './ISecurity';

// Payment interfaces
export * from './IPayment';

// Monitoring interfaces
export * from './IMonitoring';

// Network interfaces
export * from './INetwork';

// Type guards for runtime interface checking
export const isIMiner = (obj: any): obj is IMiner => {
  return obj && typeof obj.id === 'string' && typeof obj.address === 'string';
};

export const isIShare = (obj: any): obj is IShare => {
  return obj && typeof obj.id === 'string' && typeof obj.minerId === 'string';
};

export const isIPayment = (obj: any): obj is IPayment => {
  return obj && typeof obj.id === 'string' && typeof obj.amount === 'number';
};

// Re-export for convenience
import { IMiner, IShare, IPayment } from './core/IMiningPool';
