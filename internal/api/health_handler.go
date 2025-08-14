//go:build ignore
package api

// Legacy/ignored: excluded from production builds.
// See internal/legacy/README.md for details.
import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/gorilla/mux"
	"github.com/shizukutanaka/Otedama/internal/monitoring"
)

// HealthHandler handles health-related API endpoints
type HealthHandler struct {
	healthMonitor *monitoring.HealthMonitor
	autoRecovery  *monitoring.AutoRecoveryManager
}

// NewHealthHandler creates a new health handler
func NewHealthHandler(healthMonitor *monitoring.HealthMonitor, autoRecovery *monitoring.AutoRecoveryManager) *HealthHandler {
	return &HealthHandler{
		healthMonitor: healthMonitor,
		autoRecovery:  autoRecovery,
	}
}

// HandleHealthCheck handles GET /api/v1/health endpoint
func (h *HealthHandler) HandleHealthCheck(w http.ResponseWriter, r *http.Request) {
	// Get health status from health monitor
	healthStatus := h.healthMonitor.GetHealthStatus()
	metrics := h.healthMonitor.GetMetrics()
	
	// Determine overall health
	overallHealthy := true
	for _, status := range healthStatus {
		if !status.Healthy {
			overallHealthy = false
			break
		}
	}
	
	// Build response
	response := Response{
		Success: overallHealthy,
		Data: map[string]interface{}{
			"healthy":  overallHealthy,
			"checks":   healthStatus,
			"metrics":  metrics,
			"timestamp": time.Now(),
		},
		Time: time.Now(),
	}
	
	// Set appropriate status code
	statusCode := http.StatusOK
	if !overallHealthy {
		statusCode = http.StatusServiceUnavailable
	}
	
	// Send response
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(response)
}

// HandleHealthDetails handles GET /api/v1/health/:component endpoint
func (h *HealthHandler) HandleHealthDetails(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	component := vars["component"]
	
	// Get health status
	healthStatus := h.healthMonitor.GetHealthStatus()
	
	// Find component status
	if status, exists := healthStatus[component]; exists {
		response := Response{
			Success: status.Healthy,
			Data:    status,
			Time:    time.Now(),
		}
		
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response)
	} else {
		response := Response{
			Success: false,
			Error:   "Component not found",
			Time:    time.Now(),
		}
		
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(response)
	}
}

// HandleRecoveryStatus handles GET /api/v1/recovery/status endpoint
func (h *HealthHandler) HandleRecoveryStatus(w http.ResponseWriter, r *http.Request) {
	// This would return recovery history and status
	// For now, return a placeholder
	response := Response{
		Success: true,
		Data: map[string]interface{}{
			"recovery_enabled": h.autoRecovery != nil,
			"max_retries":      3,
			"retry_interval":   "30s",
		},
		Time: time.Now(),
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}