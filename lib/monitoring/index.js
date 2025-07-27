/**
 * Monitoring Module - Otedama
 * Enterprise-grade monitoring and management
 * 
 * Design:
 * - Carmack: Low-overhead monitoring
 * - Martin: Clean monitoring interfaces
 * - Pike: Simple but comprehensive
 */

// Unified dashboard system
export { UnifiedDashboard } from './dashboard-unified.js';
export { UnifiedDashboard as DashboardServer } from './dashboard-unified.js';
export { UnifiedDashboard as RealtimeDashboard } from './dashboard-unified.js';
export { UnifiedDashboard as Dashboard } from './dashboard-unified.js';

// Core monitoring components
export { MetricsCollector } from './metrics-collector.js';
export { PrometheusExporter } from './prometheus-exporter.js';
export { AlertSystem } from './alert-system.js';
export { HealthCheckService } from './health-check-service.js';

// Auto-scaling system
export {
  AutoScalingSystem,
  ScalingPolicy,
  ScalingAction
} from './auto-scaling.js';

// Disaster recovery
export {
  DisasterRecoverySystem,
  RecoveryMode,
  RecoveryState
} from './disaster-recovery.js';

// Performance monitoring
export { PerformanceMonitor } from './realtime-performance-monitor.js';
export { HardwareHealthMonitor } from './hardware-health-monitor.js';

// Distributed tracing
export { DistributedTracingSystem } from './distributed-tracing-system.js';
export { OpenTelemetryTracing } from './opentelemetry-tracing.js';

// Log management
export { LogAnalyzer } from './log-analyzer.js';

// Cost monitoring
export { CostMonitor } from './cost-monitor.js';

// Anomaly detection
export { AnomalyDetection } from './anomaly-detection.js';

// WebSocket metrics
export { MetricsWebSocket } from './metrics-websocket.js';

// Default export
export default {
  UnifiedDashboard,
  MetricsCollector,
  PrometheusExporter,
  AlertSystem,
  AutoScalingSystem,
  DisasterRecoverySystem,
  PerformanceMonitor
};