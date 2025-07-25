/**
 * Monitoring Module - Otedama
 * National-grade monitoring and management
 * 
 * Design:
 * - Carmack: Low-overhead monitoring
 * - Martin: Clean monitoring interfaces
 * - Pike: Simple but comprehensive
 */

// National monitoring system
export {
  NationalMonitoringSystem,
  getMonitoringSystem,
  metrics,
  register
} from './national-monitoring.js';

// Auto-scaling system
export {
  AutoScalingSystem,
  getAutoScalingSystem,
  ScalingPolicy,
  ScalingAction
} from './auto-scaling.js';

// Disaster recovery
export {
  DisasterRecoverySystem,
  getDisasterRecoverySystem,
  RecoveryMode,
  RecoveryState
} from './disaster-recovery.js';

// Performance testing
export {
  PerformanceTestSuite,
  TestType,
  TestPhase
} from './performance-test.js';

// Health checks
export { HealthCheckManager } from './health-check-manager.js';

// Metrics collector
export { MetricsCollector } from './metrics-collector.js';

// Log aggregation
export { LogAggregator } from './log-aggregator.js';

// Statistics
export { StatsCollector } from './stats-collector.js';

// Default export
export default {
  NationalMonitoringSystem,
  AutoScalingSystem,
  DisasterRecoverySystem,
  PerformanceTestSuite,
  getMonitoringSystem,
  getAutoScalingSystem,
  getDisasterRecoverySystem
};
