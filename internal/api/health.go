package api

import (
	"context"
	"encoding/json"
	"net/http"
	"runtime"
	"sync"
	"time"
)

// HealthService provides health check functionality
type HealthService struct {
	checks      map[string]HealthCheckFunc
	checksMu    sync.RWMutex
	lastResults map[string]HealthResult
	resultsMu   sync.RWMutex
}

// HealthCheckFunc represents a health check function
type HealthCheckFunc func(ctx context.Context) error

// HealthResult represents a health check result
type HealthResult struct {
	Status    string    `json:"status"`
	Message   string    `json:"message,omitempty"`
	Timestamp time.Time `json:"timestamp"`
	Duration  string    `json:"duration"`
}

// HealthResponse represents the health check response
type HealthResponse struct {
	Status     string                  `json:"status"`
	Timestamp  time.Time              `json:"timestamp"`
	Checks     map[string]HealthResult `json:"checks"`
	System     SystemInfo             `json:"system"`
}

// SystemInfo contains system information
type SystemInfo struct {
	Version       string  `json:"version"`
	Uptime        string  `json:"uptime"`
	Goroutines    int     `json:"goroutines"`
	MemoryUsageMB float64 `json:"memory_usage_mb"`
	CPUCount      int     `json:"cpu_count"`
}

var (
	startTime = time.Now()
)

// NewHealthService creates a new health service
func NewHealthService() *HealthService {
	return &HealthService{
		checks:      make(map[string]HealthCheckFunc),
		lastResults: make(map[string]HealthResult),
	}
}

// RegisterCheck registers a health check
func (hs *HealthService) RegisterCheck(name string, check HealthCheckFunc) {
	hs.checksMu.Lock()
	defer hs.checksMu.Unlock()
	hs.checks[name] = check
}

// RegisterHealthEndpoints registers health check HTTP endpoints
func (hs *HealthService) RegisterHealthEndpoints(mux *http.ServeMux) {
	mux.HandleFunc("/health", hs.handleHealth)
	mux.HandleFunc("/health/live", hs.handleLiveness)
	mux.HandleFunc("/health/ready", hs.handleReadiness)
	mux.HandleFunc("/health/startup", hs.handleStartup)
}

// handleHealth handles comprehensive health check
func (hs *HealthService) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	response := hs.performHealthCheck(ctx)
	
	// Set appropriate status code
	statusCode := http.StatusOK
	if response.Status != "healthy" {
		statusCode = http.StatusServiceUnavailable
	}
	
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(response)
}

// handleLiveness handles liveness probe
func (hs *HealthService) handleLiveness(w http.ResponseWriter, r *http.Request) {
	// Simple liveness check - if we can respond, we're alive
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status": "alive",
		"timestamp": time.Now().Format(time.RFC3339),
	})
}

// handleReadiness handles readiness probe
func (hs *HealthService) handleReadiness(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	// Check critical components
	criticalChecks := []string{"database", "mining_engine", "network"}
	allHealthy := true
	
	hs.checksMu.RLock()
	defer hs.checksMu.RUnlock()
	
	for _, checkName := range criticalChecks {
		if check, exists := hs.checks[checkName]; exists {
			if err := check(ctx); err != nil {
				allHealthy = false
				break
			}
		}
	}
	
	if allHealthy {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{
			"status": "ready",
			"timestamp": time.Now().Format(time.RFC3339),
		})
	} else {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"status": "not_ready",
			"timestamp": time.Now().Format(time.RFC3339),
		})
	}
}

// handleStartup handles startup probe
func (hs *HealthService) handleStartup(w http.ResponseWriter, r *http.Request) {
	// Check if startup is complete (e.g., after 30 seconds)
	if time.Since(startTime) < 30*time.Second {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"status": "starting",
			"timestamp": time.Now().Format(time.RFC3339),
		})
		return
	}
	
	// After startup period, delegate to readiness
	hs.handleReadiness(w, r)
}

// performHealthCheck performs all health checks
func (hs *HealthService) performHealthCheck(ctx context.Context) HealthResponse {
	hs.checksMu.RLock()
	checks := make(map[string]HealthCheckFunc)
	for name, check := range hs.checks {
		checks[name] = check
	}
	hs.checksMu.RUnlock()
	
	results := make(map[string]HealthResult)
	overallStatus := "healthy"
	
	var wg sync.WaitGroup
	var resultsMu sync.Mutex
	
	for name, check := range checks {
		wg.Add(1)
		go func(n string, c HealthCheckFunc) {
			defer wg.Done()
			
			start := time.Now()
			err := c(ctx)
			duration := time.Since(start)
			
			result := HealthResult{
				Status:    "healthy",
				Timestamp: time.Now(),
				Duration:  duration.String(),
			}
			
			if err != nil {
				result.Status = "unhealthy"
				result.Message = err.Error()
				resultsMu.Lock()
				overallStatus = "degraded"
				resultsMu.Unlock()
			}
			
			resultsMu.Lock()
			results[n] = result
			resultsMu.Unlock()
			
			// Cache result
			hs.resultsMu.Lock()
			hs.lastResults[n] = result
			hs.resultsMu.Unlock()
		}(name, check)
	}
	
	wg.Wait()
	
	// Check if all critical services are unhealthy
	criticalUnhealthy := 0
	for name, result := range results {
		if isCritical(name) && result.Status == "unhealthy" {
			criticalUnhealthy++
		}
	}
	
	if criticalUnhealthy > 0 {
		overallStatus = "unhealthy"
	}
	
	return HealthResponse{
		Status:    overallStatus,
		Timestamp: time.Now(),
		Checks:    results,
		System:    getSystemInfo(),
	}
}

// getSystemInfo returns current system information
func getSystemInfo() SystemInfo {
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	
	return SystemInfo{
		Version:       "Otedama",
		Uptime:        time.Since(startTime).String(),
		Goroutines:    runtime.NumGoroutine(),
		MemoryUsageMB: float64(memStats.Alloc) / 1024 / 1024,
		CPUCount:      runtime.NumCPU(),
	}
}

// isCritical checks if a service is critical
func isCritical(name string) bool {
	critical := []string{"database", "mining_engine", "network"}
	for _, c := range critical {
		if c == name {
			return true
		}
	}
	return false
}

// DefaultHealthChecks returns default health checks
func DefaultHealthChecks() map[string]HealthCheckFunc {
	return map[string]HealthCheckFunc{
		"database": func(ctx context.Context) error {
			// Database health check
			// In production, ping the database
			return nil
		},
		"mining_engine": func(ctx context.Context) error {
			// Mining engine health check
			// Check if mining engine is responsive
			return nil
		},
		"network": func(ctx context.Context) error {
			// Network health check
			// Check P2P network connectivity
			return nil
		},
		"disk_space": func(ctx context.Context) error {
			// Disk space check
			// Check available disk space
			return nil
		},
		"memory": func(ctx context.Context) error {
			// Memory check
			var memStats runtime.MemStats
			runtime.ReadMemStats(&memStats)
			
			// Check if memory usage is too high (>90%)
			if memStats.Alloc > uint64(runtime.NumCPU())*1024*1024*1024*9/10 {
				return ErrHighMemoryUsage
			}
			return nil
		},
		"api": func(ctx context.Context) error {
			// API health check
			// Self-check API responsiveness
			return nil
		},
	}
}

// Errors for health checks
var (
	ErrDatabaseUnavailable = &HealthError{Code: "DB_UNAVAILABLE", Message: "Database connection failed"}
	ErrMiningEngineStopped = &HealthError{Code: "MINING_STOPPED", Message: "Mining engine is not running"}
	ErrNetworkUnreachable  = &HealthError{Code: "NETWORK_UNREACHABLE", Message: "P2P network is unreachable"}
	ErrDiskSpaceLow        = &HealthError{Code: "DISK_SPACE_LOW", Message: "Disk space is critically low"}
	ErrHighMemoryUsage     = &HealthError{Code: "HIGH_MEMORY", Message: "Memory usage is too high"}
)

// HealthError represents a health check error
type HealthError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *HealthError) Error() string {
	return e.Message
}

// HealthMonitor continuously monitors health
type HealthMonitor struct {
	service  *HealthService
	interval time.Duration
	ctx      context.Context
	cancel   context.CancelFunc
}

// NewHealthMonitor creates a new health monitor
func NewHealthMonitor(service *HealthService, interval time.Duration) *HealthMonitor {
	ctx, cancel := context.WithCancel(context.Background())
	return &HealthMonitor{
		service:  service,
		interval: interval,
		ctx:      ctx,
		cancel:   cancel,
	}
}

// Start starts the health monitor
func (hm *HealthMonitor) Start() {
	go hm.monitor()
}

// Stop stops the health monitor
func (hm *HealthMonitor) Stop() {
	hm.cancel()
}

// monitor continuously monitors health
func (hm *HealthMonitor) monitor() {
	ticker := time.NewTicker(hm.interval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(hm.ctx, 5*time.Second)
			hm.service.performHealthCheck(ctx)
			cancel()
			
		case <-hm.ctx.Done():
			return
		}
	}
}