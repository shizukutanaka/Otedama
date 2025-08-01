// Package monitoring provides comprehensive system monitoring capabilities.
//
// The monitoring package offers three complementary monitoring approaches:
//
// 1. Prometheus-based monitoring (monitor.go):
//    - Production-ready metrics export
//    - Integration with external monitoring tools
//    - Standard metrics format
//
// 2. Lightweight performance monitoring (simple_performance.go):
//    - Resource-efficient monitoring
//    - Rolling window calculations
//    - Development and testing focus
//
// 3. Advanced profiling (performance_profiler.go):
//    - Deep performance analysis
//    - Bottleneck detection
//    - pprof integration
//
// Usage:
//
//	// For production monitoring
//	monitor := monitoring.NewMonitor(logger, config)
//	monitor.Start()
//
//	// For lightweight monitoring
//	perfMon := monitoring.NewSimplePerformanceMonitor(logger)
//	perfMon.Start()
//
//	// For performance profiling
//	profiler := monitoring.NewPerformanceProfiler(logger, config)
//	profiler.Start()
package monitoring