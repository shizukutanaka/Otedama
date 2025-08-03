package performance

import (
    "runtime"
    "time"
)

// SimpleProfiler provides basic performance monitoring
type SimpleProfiler struct {
    startTime time.Time
    startMem  runtime.MemStats
}

// NewProfiler creates a new profiler instance
func NewProfiler() *SimpleProfiler {
    return &SimpleProfiler{
        startTime: time.Now(),
    }
}

// Start begins profiling
func (p *SimpleProfiler) Start() {
    p.startTime = time.Now()
    runtime.ReadMemStats(&p.startMem)
}

// GetStats returns current performance statistics
func (p *SimpleProfiler) GetStats() map[string]interface{} {
    var m runtime.MemStats
    runtime.ReadMemStats(&m)
    
    return map[string]interface{}{
        "uptime_seconds":   time.Since(p.startTime).Seconds(),
        "memory_alloc_mb":  m.Alloc / 1024 / 1024,
        "memory_sys_mb":    m.Sys / 1024 / 1024,
        "num_goroutines":   runtime.NumGoroutine(),
        "num_gc":          m.NumGC,
    }
}

// GetMemoryUsage returns current memory usage
func GetMemoryUsage() uint64 {
    var m runtime.MemStats
    runtime.ReadMemStats(&m)
    return m.Alloc
}

// GetGoroutineCount returns current goroutine count
func GetGoroutineCount() int {
    return runtime.NumGoroutine()
}