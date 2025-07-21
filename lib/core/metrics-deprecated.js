/**
 * DEPRECATED: This file is maintained for backward compatibility only.
 * Please use lib/monitoring/index.js for all new code.
 * 
 * This file re-exports the compatibility wrappers from the consolidated monitoring system.
 */

console.warn('DEPRECATED: lib/core/metrics.js is deprecated. Please use lib/monitoring/index.js instead.');

export { 
  MetricsSystem,
  metrics
} from '../monitoring/compatibility.js';

export { 
  MetricType,
  inc,
  set,
  observe,
  time
} from '../monitoring/index.js';

export default MetricsSystem;