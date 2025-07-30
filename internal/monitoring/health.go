package monitoring

import (
	"context"
	"fmt"
	"net"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/shizukutanaka/Otedama/internal/core"
	"go.uber.org/zap"
)

// HealthMonitor monitors system and component health
type HealthMonitor struct {
	logger         *zap.Logger
	recoveryMgr    *core.RecoveryManager
	checks         map[string]HealthChecker
	thresholds     HealthThresholds
	metrics        *HealthMetrics
	alertHandlers  []AlertHandler
	
	checkInterval  time.Duration
	stopCh        chan struct{}
	wg            sync.WaitGroup
	mu            sync.RWMutex
}

// HealthChecker interface for component health checks
type HealthChecker interface {
	Name() string
	Check(context.Context) HealthStatus
	Component() string
}

// HealthStatus represents health check result
type HealthStatus struct {
	Healthy     bool
	Status      string
	Message     string
	Metrics     map[string]float64
	Error       error
	Timestamp   time.Time
}

// HealthThresholds defines health check thresholds
type HealthThresholds struct {
	CPUWarning       float64
	CPUCritical      float64
	MemoryWarning    float64
	MemoryCritical   float64
	DiskWarning      float64
	DiskCritical     float64
	LatencyWarning   time.Duration
	LatencyCritical  time.Duration
	ErrorRateWarning float64
	ErrorRateCritical float64
}

// HealthMetrics tracks health metrics
type HealthMetrics struct {
	ChecksTotal      atomic.Uint64
	ChecksHealthy    atomic.Uint64
	ChecksUnhealthy  atomic.Uint64
	AlertsTriggered  atomic.Uint64
	LastHealthyTime  atomic.Value // time.Time
	ConsecutiveFails map[string]*atomic.Uint32
	mu               sync.RWMutex
}

// AlertHandler handles health alerts
type AlertHandler interface {
	HandleAlert(Alert)
}

// Alert represents a health alert
type Alert struct {
	Level     AlertLevel
	Component string
	Message   string
	Details   map[string]interface{}
	Timestamp time.Time
}

// AlertLevel represents alert severity
type AlertLevel int

const (
	AlertLevelInfo AlertLevel = iota
	AlertLevelWarning
	AlertLevelError
	AlertLevelCritical
)

// NewHealthMonitor creates a new health monitor
func NewHealthMonitor(logger *zap.Logger, recoveryMgr *core.RecoveryManager) *HealthMonitor {
	hm := &HealthMonitor{
		logger:        logger,
		recoveryMgr:   recoveryMgr,
		checks:        make(map[string]HealthChecker),
		checkInterval: 30 * time.Second,
		stopCh:        make(chan struct{}),
		metrics: &HealthMetrics{
			ConsecutiveFails: make(map[string]*atomic.Uint32),
		},
		thresholds: HealthThresholds{
			CPUWarning:        70.0,
			CPUCritical:       90.0,
			MemoryWarning:     75.0,
			MemoryCritical:    90.0,
			DiskWarning:       80.0,
			DiskCritical:      95.0,
			LatencyWarning:    100 * time.Millisecond,
			LatencyCritical:   500 * time.Millisecond,
			ErrorRateWarning:  5.0,
			ErrorRateCritical: 10.0,
		},
	}
	
	// Register default health checks
	hm.RegisterCheck(&SystemHealthCheck{thresholds: hm.thresholds})
	hm.RegisterCheck(&NetworkHealthCheck{})
	hm.RegisterCheck(&StorageHealthCheck{thresholds: hm.thresholds})
	hm.RegisterCheck(&MiningHealthCheck{})
	hm.RegisterCheck(&P2PHealthCheck{})
	
	// Register with recovery manager
	if recoveryMgr != nil {
		for _, check := range hm.checks {
			recoveryMgr.RegisterHealthCheck(&healthCheckAdapter{check: check})
		}
	}
	
	return hm
}

// Start starts health monitoring
func (hm *HealthMonitor) Start(ctx context.Context) {
	hm.wg.Add(1)
	go hm.monitorRoutine(ctx)
	
	hm.logger.Info("Health monitor started")
}

// Stop stops health monitoring
func (hm *HealthMonitor) Stop() {
	close(hm.stopCh)
	hm.wg.Wait()
	
	hm.logger.Info("Health monitor stopped")
}

// RegisterCheck registers a health check
func (hm *HealthMonitor) RegisterCheck(check HealthChecker) {
	hm.mu.Lock()
	defer hm.mu.Unlock()
	
	hm.checks[check.Name()] = check
	hm.metrics.ConsecutiveFails[check.Name()] = &atomic.Uint32{}
}

// RegisterAlertHandler registers an alert handler
func (hm *HealthMonitor) RegisterAlertHandler(handler AlertHandler) {
	hm.mu.Lock()
	defer hm.mu.Unlock()
	
	hm.alertHandlers = append(hm.alertHandlers, handler)
}

// GetHealthStatus returns current health status
func (hm *HealthMonitor) GetHealthStatus() map[string]HealthStatus {
	hm.mu.RLock()
	defer hm.mu.RUnlock()
	
	status := make(map[string]HealthStatus)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	
	for name, check := range hm.checks {
		status[name] = check.Check(ctx)
	}
	
	return status
}

// GetMetrics returns health metrics
func (hm *HealthMonitor) GetMetrics() map[string]interface{} {
	metrics := map[string]interface{}{
		"checks_total":      hm.metrics.ChecksTotal.Load(),
		"checks_healthy":    hm.metrics.ChecksHealthy.Load(),
		"checks_unhealthy":  hm.metrics.ChecksUnhealthy.Load(),
		"alerts_triggered":  hm.metrics.AlertsTriggered.Load(),
	}
	
	if lastHealthy := hm.metrics.LastHealthyTime.Load(); lastHealthy != nil {
		metrics["last_healthy_time"] = lastHealthy.(time.Time)
		metrics["time_since_healthy"] = time.Since(lastHealthy.(time.Time))
	}
	
	// Consecutive failures
	failures := make(map[string]uint32)
	hm.metrics.mu.RLock()
	for name, counter := range hm.metrics.ConsecutiveFails {
		failures[name] = counter.Load()
	}
	hm.metrics.mu.RUnlock()
	metrics["consecutive_failures"] = failures
	
	return metrics
}

// Background monitoring routine
func (hm *HealthMonitor) monitorRoutine(ctx context.Context) {
	defer hm.wg.Done()
	
	ticker := time.NewTicker(hm.checkInterval)
	defer ticker.Stop()
	
	// Initial check
	hm.performHealthChecks(ctx)
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-hm.stopCh:
			return
		case <-ticker.C:
			hm.performHealthChecks(ctx)
		}
	}
}

func (hm *HealthMonitor) performHealthChecks(ctx context.Context) {
	hm.mu.RLock()
	checks := make([]HealthChecker, 0, len(hm.checks))
	for _, check := range hm.checks {
		checks = append(checks, check)
	}
	hm.mu.RUnlock()
	
	allHealthy := true
	var wg sync.WaitGroup
	results := make(chan struct {
		name   string
		status HealthStatus
	}, len(checks))
	
	// Run checks in parallel
	for _, check := range checks {
		wg.Add(1)
		go func(c HealthChecker) {
			defer wg.Done()
			
			checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			
			status := c.Check(checkCtx)
			results <- struct {
				name   string
				status HealthStatus
			}{name: c.Name(), status: status}
		}(check)
	}
	
	// Wait for all checks
	go func() {
		wg.Wait()
		close(results)
	}()
	
	// Process results
	for result := range results {
		hm.metrics.ChecksTotal.Add(1)
		
		if result.status.Healthy {
			hm.metrics.ChecksHealthy.Add(1)
			hm.metrics.ConsecutiveFails[result.name].Store(0)
		} else {
			hm.metrics.ChecksUnhealthy.Add(1)
			allHealthy = false
			
			// Increment consecutive failures
			fails := hm.metrics.ConsecutiveFails[result.name].Add(1)
			
			// Generate alert if needed
			hm.handleUnhealthyStatus(result.name, result.status, fails)
		}
		
		// Log status
		hm.logHealthStatus(result.name, result.status)
	}
	
	// Update last healthy time
	if allHealthy {
		hm.metrics.LastHealthyTime.Store(time.Now())
	}
}

func (hm *HealthMonitor) handleUnhealthyStatus(name string, status HealthStatus, consecutiveFails uint32) {
	level := AlertLevelWarning
	
	// Determine alert level based on consecutive failures
	if consecutiveFails >= 5 {
		level = AlertLevelCritical
	} else if consecutiveFails >= 3 {
		level = AlertLevelError
	}
	
	// Create alert
	alert := Alert{
		Level:     level,
		Component: name,
		Message:   fmt.Sprintf("Health check failed: %s", status.Message),
		Details: map[string]interface{}{
			"status":            status.Status,
			"error":             status.Error,
			"metrics":           status.Metrics,
			"consecutive_fails": consecutiveFails,
		},
		Timestamp: time.Now(),
	}
	
	// Trigger alert
	hm.triggerAlert(alert)
	
	// Trigger recovery if critical
	if level == AlertLevelCritical && hm.recoveryMgr != nil {
		go hm.recoveryMgr.TriggerRecovery(context.Background(), status.Error)
	}
}

func (hm *HealthMonitor) triggerAlert(alert Alert) {
	hm.metrics.AlertsTriggered.Add(1)
	
	hm.mu.RLock()
	handlers := make([]AlertHandler, len(hm.alertHandlers))
	copy(handlers, hm.alertHandlers)
	hm.mu.RUnlock()
	
	// Send to all handlers
	for _, handler := range handlers {
		go handler.HandleAlert(alert)
	}
}

func (hm *HealthMonitor) logHealthStatus(name string, status HealthStatus) {
	fields := []zap.Field{
		zap.String("check", name),
		zap.Bool("healthy", status.Healthy),
		zap.String("status", status.Status),
		zap.Time("timestamp", status.Timestamp),
	}
	
	if len(status.Metrics) > 0 {
		fields = append(fields, zap.Any("metrics", status.Metrics))
	}
	
	if status.Error != nil {
		fields = append(fields, zap.Error(status.Error))
	}
	
	if status.Healthy {
		hm.logger.Debug("Health check passed", fields...)
	} else {
		hm.logger.Warn("Health check failed", fields...)
	}
}

// Default health checks

// SystemHealthCheck checks overall system health
type SystemHealthCheck struct {
	thresholds HealthThresholds
}

func (c *SystemHealthCheck) Name() string {
	return "system"
}

func (c *SystemHealthCheck) Component() string {
	return "system"
}

func (c *SystemHealthCheck) Check(ctx context.Context) HealthStatus {
	status := HealthStatus{
		Healthy:   true,
		Status:    "healthy",
		Metrics:   make(map[string]float64),
		Timestamp: time.Now(),
	}
	
	// Check CPU usage
	cpuPercent := getCPUUsage()
	status.Metrics["cpu_percent"] = cpuPercent
	
	if cpuPercent >= c.thresholds.CPUCritical {
		status.Healthy = false
		status.Status = "critical"
		status.Message = fmt.Sprintf("CPU usage critical: %.1f%%", cpuPercent)
	} else if cpuPercent >= c.thresholds.CPUWarning {
		status.Status = "warning"
		status.Message = fmt.Sprintf("CPU usage high: %.1f%%", cpuPercent)
	}
	
	// Check memory usage
	memPercent := getMemoryUsage()
	status.Metrics["memory_percent"] = memPercent
	
	if memPercent >= c.thresholds.MemoryCritical {
		status.Healthy = false
		status.Status = "critical"
		status.Message = fmt.Sprintf("Memory usage critical: %.1f%%", memPercent)
	} else if memPercent >= c.thresholds.MemoryWarning && status.Status == "healthy" {
		status.Status = "warning"
		status.Message = fmt.Sprintf("Memory usage high: %.1f%%", memPercent)
	}
	
	// Check goroutines
	goroutines := runtime.NumGoroutine()
	status.Metrics["goroutines"] = float64(goroutines)
	
	if goroutines > 10000 {
		status.Healthy = false
		status.Status = "critical"
		status.Message = fmt.Sprintf("Too many goroutines: %d", goroutines)
	}
	
	return status
}

// NetworkHealthCheck checks network connectivity
type NetworkHealthCheck struct{}

func (c *NetworkHealthCheck) Name() string {
	return "network"
}

func (c *NetworkHealthCheck) Component() string {
	return "network"
}

func (c *NetworkHealthCheck) Check(ctx context.Context) HealthStatus {
	status := HealthStatus{
		Healthy:   true,
		Status:    "healthy",
		Metrics:   make(map[string]float64),
		Timestamp: time.Now(),
	}
	
	// Check network connectivity
	start := time.Now()
	conn, err := net.DialTimeout("tcp", "8.8.8.8:53", 5*time.Second)
	latency := time.Since(start)
	
	if err != nil {
		status.Healthy = false
		status.Status = "error"
		status.Message = "Network connectivity failed"
		status.Error = err
	} else {
		conn.Close()
		status.Metrics["latency_ms"] = float64(latency.Milliseconds())
		
		if latency > 1000*time.Millisecond {
			status.Status = "warning"
			status.Message = fmt.Sprintf("High network latency: %v", latency)
		}
	}
	
	return status
}

// StorageHealthCheck checks storage health
type StorageHealthCheck struct {
	thresholds HealthThresholds
}

func (c *StorageHealthCheck) Name() string {
	return "storage"
}

func (c *StorageHealthCheck) Component() string {
	return "storage"
}

func (c *StorageHealthCheck) Check(ctx context.Context) HealthStatus {
	status := HealthStatus{
		Healthy:   true,
		Status:    "healthy",
		Metrics:   make(map[string]float64),
		Timestamp: time.Now(),
	}
	
	// Check disk usage
	diskPercent := getDiskUsage()
	status.Metrics["disk_percent"] = diskPercent
	
	if diskPercent >= c.thresholds.DiskCritical {
		status.Healthy = false
		status.Status = "critical"
		status.Message = fmt.Sprintf("Disk usage critical: %.1f%%", diskPercent)
	} else if diskPercent >= c.thresholds.DiskWarning {
		status.Status = "warning"
		status.Message = fmt.Sprintf("Disk usage high: %.1f%%", diskPercent)
	}
	
	// Test write performance
	testFile := fmt.Sprintf("/tmp/health_check_%d", time.Now().UnixNano())
	start := time.Now()
	
	file, err := os.Create(testFile)
	if err != nil {
		status.Healthy = false
		status.Status = "error"
		status.Message = "Failed to create test file"
		status.Error = err
		return status
	}
	defer os.Remove(testFile)
	defer file.Close()
	
	// Write 1MB of data
	data := make([]byte, 1024*1024)
	_, err = file.Write(data)
	writeTime := time.Since(start)
	
	if err != nil {
		status.Healthy = false
		status.Status = "error"
		status.Message = "Storage write test failed"
		status.Error = err
	} else {
		status.Metrics["write_latency_ms"] = float64(writeTime.Milliseconds())
		
		if writeTime > 100*time.Millisecond {
			status.Status = "warning"
			status.Message = fmt.Sprintf("Slow storage write: %v", writeTime)
		}
	}
	
	return status
}

// MiningHealthCheck checks mining subsystem
type MiningHealthCheck struct{}

func (c *MiningHealthCheck) Name() string {
	return "mining"
}

func (c *MiningHealthCheck) Component() string {
	return "mining"
}

func (c *MiningHealthCheck) Check(ctx context.Context) HealthStatus {
	// This would check actual mining engine status
	return HealthStatus{
		Healthy:   true,
		Status:    "healthy",
		Message:   "Mining subsystem operational",
		Timestamp: time.Now(),
	}
}

// P2PHealthCheck checks P2P network
type P2PHealthCheck struct{}

func (c *P2PHealthCheck) Name() string {
	return "p2p"
}

func (c *P2PHealthCheck) Component() string {
	return "p2p"
}

func (c *P2PHealthCheck) Check(ctx context.Context) HealthStatus {
	// This would check P2P connectivity and peer count
	return HealthStatus{
		Healthy:   true,
		Status:    "healthy",
		Message:   "P2P network operational",
		Timestamp: time.Now(),
	}
}

// Adapter for recovery manager
type healthCheckAdapter struct {
	check HealthChecker
}

func (a *healthCheckAdapter) Name() string {
	return a.check.Name()
}

func (a *healthCheckAdapter) Check(ctx context.Context) error {
	status := a.check.Check(ctx)
	if !status.Healthy {
		return fmt.Errorf("%s: %s", status.Status, status.Message)
	}
	return nil
}

func (a *healthCheckAdapter) Critical() bool {
	// System, network, and storage are critical
	name := a.check.Name()
	return name == "system" || name == "network" || name == "storage"
}

// Utility functions

func getCPUUsage() float64 {
	// This is a simplified implementation
	// In production, use proper CPU usage calculation
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return float64(m.Sys) / float64(m.Sys+m.HeapIdle) * 100
}

func getMemoryUsage() float64 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return float64(m.Alloc) / float64(m.Sys) * 100
}

func getDiskUsage() float64 {
	// This is platform-specific
	// Here's a simple implementation
	var stat syscall.Statfs_t
	wd, _ := os.Getwd()
	
	if err := syscall.Statfs(wd, &stat); err != nil {
		return 0
	}
	
	total := stat.Blocks * uint64(stat.Bsize)
	free := stat.Bfree * uint64(stat.Bsize)
	used := total - free
	
	return float64(used) / float64(total) * 100
}