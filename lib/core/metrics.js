/**
 * DEPRECATED: This file is maintained for backward compatibility only.
 * Please use lib/monitoring/index.js for all new code.
 * 
 * All metrics functionality has been consolidated into the unified monitoring system.
 */

// Re-export from compatibility layer
export { 
  MetricsSystem,
  metrics
} from '../monitoring/compatibility.js';

// Re-export common functions from new monitoring
export { 
  MetricType,
  inc,
  set,
  observe,
  time
} from '../monitoring/index.js';

// Default export for backward compatibility
import { MetricsSystem } from '../monitoring/compatibility.js';
export default MetricsSystem;