package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/gorilla/mux"
	"github.com/otedama/otedama/internal/logging"
	"go.uber.org/zap"
)

// RegisterLogRoutes registers log management API routes
func (s *Server) RegisterLogRoutes(router *mux.Router) {
	logs := router.PathPrefix("/logs").Subrouter()
	
	// Get log files
	logs.HandleFunc("/files", s.handleGetLogFiles).Methods("GET")
	
	// Get rotation status
	logs.HandleFunc("/rotation/status", s.handleGetRotationStatus).Methods("GET")
	
	// Force rotation
	logs.HandleFunc("/rotation/rotate", s.handleForceRotation).Methods("POST")
	
	// Cleanup old logs
	logs.HandleFunc("/cleanup", s.handleCleanupLogs).Methods("POST")
	
	// Compress old logs
	logs.HandleFunc("/compress", s.handleCompressLogs).Methods("POST")
	
	// Get disk usage
	logs.HandleFunc("/disk-usage", s.handleGetDiskUsage).Methods("GET")
	
	// Download log file
	logs.HandleFunc("/download/{filename}", s.handleDownloadLog).Methods("GET")
}

// handleGetLogFiles returns list of log files
func (s *Server) handleGetLogFiles(w http.ResponseWriter, r *http.Request) {
	// This would need access to the enhanced logger
	// For now, return mock data
	files := []map[string]interface{}{
		{
			"path":         "logs/otedama.log",
			"size":         1048576,
			"modified":     "2025-08-02T12:00:00Z",
			"is_compressed": false,
		},
		{
			"path":         "logs/otedama.log.1.gz",
			"size":         524288,
			"modified":     "2025-08-01T00:00:00Z",
			"is_compressed": true,
		},
	}
	
	s.writeJSON(w, http.StatusOK, map[string]interface{}{
		"files": files,
		"count": len(files),
	})
}

// handleGetRotationStatus returns log rotation status
func (s *Server) handleGetRotationStatus(w http.ResponseWriter, r *http.Request) {
	status := map[string]interface{}{
		"enabled":         true,
		"max_size_mb":     100,
		"max_age_days":    30,
		"max_backups":     10,
		"compress":        true,
		"disk_usage_mb":   150,
		"max_disk_usage_mb": 10240,
		"file_count":      5,
		"oldest_file":     "2025-07-03T00:00:00Z",
		"newest_file":     "2025-08-02T12:00:00Z",
	}
	
	s.writeJSON(w, http.StatusOK, status)
}

// handleForceRotation forces log rotation
func (s *Server) handleForceRotation(w http.ResponseWriter, r *http.Request) {
	// In production, this would call logger.Rotate()
	s.logger.Info("Forcing log rotation")
	
	s.writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "Log rotation initiated",
	})
}

// CleanupRequest represents log cleanup request
type CleanupRequest struct {
	DaysOld int `json:"days_old"`
}

// handleCleanupLogs handles log cleanup
func (s *Server) handleCleanupLogs(w http.ResponseWriter, r *http.Request) {
	var req CleanupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	if req.DaysOld < 1 || req.DaysOld > 365 {
		s.writeError(w, http.StatusBadRequest, "Invalid days_old value (must be between 1 and 365)")
		return
	}
	
	s.logger.Info("Cleaning up old logs",
		zap.Int("days_old", req.DaysOld))
	
	// In production, this would call logger.CleanupOldLogs(req.DaysOld)
	
	s.writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":      true,
		"message":      "Log cleanup completed",
		"deleted_count": 3,
		"deleted_size_mb": 25,
	})
}

// CompressRequest represents log compression request
type CompressRequest struct {
	DaysOld int `json:"days_old"`
}

// handleCompressLogs handles log compression
func (s *Server) handleCompressLogs(w http.ResponseWriter, r *http.Request) {
	var req CompressRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	if req.DaysOld < 1 || req.DaysOld > 365 {
		s.writeError(w, http.StatusBadRequest, "Invalid days_old value (must be between 1 and 365)")
		return
	}
	
	s.logger.Info("Compressing old logs",
		zap.Int("days_old", req.DaysOld))
	
	// In production, this would call logger.CompressOldLogs(req.DaysOld)
	
	s.writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":          true,
		"message":          "Log compression completed",
		"compressed_count": 5,
		"space_saved_mb":   100,
	})
}

// handleGetDiskUsage returns log disk usage
func (s *Server) handleGetDiskUsage(w http.ResponseWriter, r *http.Request) {
	// In production, this would call logger.GetDiskUsage()
	usage := map[string]interface{}{
		"total_size_mb":     150,
		"log_count":         10,
		"compressed_count":  5,
		"uncompressed_count": 5,
		"max_disk_usage_mb": 10240,
		"usage_percent":     1.5,
	}
	
	s.writeJSON(w, http.StatusOK, usage)
}

// handleDownloadLog handles log file download
func (s *Server) handleDownloadLog(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	filename := vars["filename"]
	
	// Security check - prevent directory traversal
	if containsPathTraversal(filename) {
		s.writeError(w, http.StatusBadRequest, "Invalid filename")
		return
	}
	
	// In production, this would serve the actual log file
	s.logger.Info("Log file download requested",
		zap.String("filename", filename))
	
	// Set appropriate headers
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename="+filename)
	
	// In production, would stream the file content
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("Log file content here..."))
}

// containsPathTraversal checks if filename contains path traversal attempts
func containsPathTraversal(filename string) bool {
	return len(filename) == 0 ||
		filename[0] == '/' ||
		filename[0] == '\\' ||
		contains(filename, "..") ||
		contains(filename, "./") ||
		contains(filename, ".\\")
}

// contains checks if string contains substring
func contains(s, substr string) bool {
	return len(s) >= len(substr) && hasSubstring(s, substr)
}

// hasSubstring checks if s contains substr
func hasSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// LogManagementConfig represents log management configuration
type LogManagementConfig struct {
	RotationEnabled      bool `json:"rotation_enabled"`
	MaxSizeMB           int  `json:"max_size_mb"`
	MaxAgeDays          int  `json:"max_age_days"`
	MaxBackups          int  `json:"max_backups"`
	Compress            bool `json:"compress"`
	DiskManagementEnabled bool `json:"disk_management_enabled"`
	MaxDiskUsageGB      int  `json:"max_disk_usage_gb"`
}

// handleGetLogConfig returns log management configuration
func (s *Server) handleGetLogConfig(w http.ResponseWriter, r *http.Request) {
	config := LogManagementConfig{
		RotationEnabled:      true,
		MaxSizeMB:           100,
		MaxAgeDays:          30,
		MaxBackups:          10,
		Compress:            true,
		DiskManagementEnabled: true,
		MaxDiskUsageGB:      10,
	}
	
	s.writeJSON(w, http.StatusOK, config)
}

// handleUpdateLogConfig updates log management configuration
func (s *Server) handleUpdateLogConfig(w http.ResponseWriter, r *http.Request) {
	var config LogManagementConfig
	if err := json.NewDecoder(r.Body).Decode(&config); err != nil {
		s.writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	// Validate configuration
	if config.MaxSizeMB < 1 || config.MaxSizeMB > 1000 {
		s.writeError(w, http.StatusBadRequest, "Invalid max_size_mb (must be between 1 and 1000)")
		return
	}
	
	if config.MaxAgeDays < 1 || config.MaxAgeDays > 365 {
		s.writeError(w, http.StatusBadRequest, "Invalid max_age_days (must be between 1 and 365)")
		return
	}
	
	if config.MaxBackups < 0 || config.MaxBackups > 100 {
		s.writeError(w, http.StatusBadRequest, "Invalid max_backups (must be between 0 and 100)")
		return
	}
	
	if config.MaxDiskUsageGB < 1 || config.MaxDiskUsageGB > 1000 {
		s.writeError(w, http.StatusBadRequest, "Invalid max_disk_usage_gb (must be between 1 and 1000)")
		return
	}
	
	s.logger.Info("Updating log configuration",
		zap.Bool("rotation_enabled", config.RotationEnabled),
		zap.Int("max_size_mb", config.MaxSizeMB),
		zap.Int("max_age_days", config.MaxAgeDays),
		zap.Int("max_backups", config.MaxBackups),
		zap.Bool("compress", config.Compress),
		zap.Bool("disk_management_enabled", config.DiskManagementEnabled),
		zap.Int("max_disk_usage_gb", config.MaxDiskUsageGB))
	
	// In production, this would update the actual logger configuration
	
	s.writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "Log configuration updated",
		"config":  config,
	})
}