package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"
	"github.com/otedama/otedama/internal/auth"
	"github.com/otedama/otedama/internal/mining"
	"github.com/otedama/otedama/internal/pool"
	"go.uber.org/zap"
)

// AdminHandlers handles admin API endpoints
type AdminHandlers struct {
	logger      *zap.Logger
	poolManager *pool.PoolManager
	totp        *auth.TOTPProvider
	server      *Server
}

// Firmware optimizer endpoints

// getEngine resolves and validates the mining engine instance
func (h *AdminHandlers) getEngine() (*mining.Engine, error) {
	if h.server == nil || h.server.miningEngine == nil {
		return nil, errors.New("mining engine not available")
	}
	eng, ok := h.server.miningEngine.(*mining.Engine)
	if !ok || eng == nil {
		return nil, errors.New("invalid mining engine type")
	}
	return eng, nil
}

// FirmwareListProfiles lists available firmware profiles
func (h *AdminHandlers) FirmwareListProfiles(w http.ResponseWriter, r *http.Request) {
	eng, err := h.getEngine()
	if err != nil {
		h.server.sendResponse(w, http.StatusServiceUnavailable, nil, err)
		return
	}
	profiles, err := eng.ListFirmwareProfiles()
	if err != nil {
		h.server.sendResponse(w, http.StatusInternalServerError, nil, err)
		return
	}
	h.server.sendResponse(w, http.StatusOK, map[string]interface{}{"profiles": profiles}, nil)
}

// FirmwareApplyProfile applies a named firmware profile
func (h *AdminHandlers) FirmwareApplyProfile(w http.ResponseWriter, r *http.Request) {
	eng, err := h.getEngine()
	if err != nil {
		h.server.sendResponse(w, http.StatusServiceUnavailable, nil, err)
		return
	}
	var req struct {
		Name   string `json:"name"`
		DryRun bool   `json:"dry_run"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.server.sendResponse(w, http.StatusBadRequest, nil, err)
		return
	}
	if err := h.server.validator.ValidateProfileName(req.Name); err != nil {
		h.server.sendResponse(w, http.StatusBadRequest, nil, err)
		return
	}
	result, err := eng.ApplyFirmwareProfile(req.Name, req.DryRun)
	if err != nil {
		h.server.sendResponse(w, http.StatusBadRequest, nil, err)
		return
	}
	h.server.sendResponse(w, http.StatusOK, map[string]interface{}{
		"profile": req.Name,
		"dry_run": req.DryRun,
		"result":  result,
	}, nil)
}

// FirmwareResetDefaults resets firmware to default profile
func (h *AdminHandlers) FirmwareResetDefaults(w http.ResponseWriter, r *http.Request) {
	eng, err := h.getEngine()
	if err != nil {
		h.server.sendResponse(w, http.StatusServiceUnavailable, nil, err)
		return
	}
	result, err := eng.ResetFirmwareDefaults()
	if err != nil {
		h.server.sendResponse(w, http.StatusInternalServerError, nil, err)
		return
	}
	h.server.sendResponse(w, http.StatusOK, map[string]interface{}{"result": result}, nil)
}

// FirmwareGetSettings returns current firmware settings snapshot
func (h *AdminHandlers) FirmwareGetSettings(w http.ResponseWriter, r *http.Request) {
	eng, err := h.getEngine()
	if err != nil {
		h.server.sendResponse(w, http.StatusServiceUnavailable, nil, err)
		return
	}
	settings := eng.GetFirmwareSettings()
	if settings == nil {
		h.server.sendResponse(w, http.StatusOK, map[string]interface{}{"settings": map[string]interface{}{}}, nil)
		return
	}
	h.server.sendResponse(w, http.StatusOK, map[string]interface{}{"settings": settings}, nil)
}

// FirmwareApplySettings validates/applies settings; supports dry run
func (h *AdminHandlers) FirmwareApplySettings(w http.ResponseWriter, r *http.Request) {
	eng, err := h.getEngine()
	if err != nil {
		h.server.sendResponse(w, http.StatusServiceUnavailable, nil, err)
		return
	}
	var req struct {
		Settings map[string]interface{} `json:"settings"`
		DryRun   bool                   `json:"dry_run"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.server.sendResponse(w, http.StatusBadRequest, nil, err)
		return
	}
	if req.Settings == nil {
		h.server.sendResponse(w, http.StatusBadRequest, nil, errors.New("settings is required"))
		return
	}
	result, err := eng.ApplyFirmwareSettings(req.Settings, req.DryRun)
	if err != nil {
		h.server.sendResponse(w, http.StatusBadRequest, nil, err)
		return
	}
	h.server.sendResponse(w, http.StatusOK, map[string]interface{}{
		"dry_run": req.DryRun,
		"result":  result,
	}, nil)
}

// FirmwareBackup creates a backup snapshot of current firmware settings
func (h *AdminHandlers) FirmwareBackup(w http.ResponseWriter, r *http.Request) {
	eng, err := h.getEngine()
	if err != nil {
		h.server.sendResponse(w, http.StatusServiceUnavailable, nil, err)
		return
	}
	snap, err := eng.BackupFirmware()
	if err != nil {
		h.server.sendResponse(w, http.StatusInternalServerError, nil, err)
		return
	}
	h.server.sendResponse(w, http.StatusOK, map[string]interface{}{"backup": snap}, nil)
}

// FirmwareBackupCount returns the number of retained backups
func (h *AdminHandlers) FirmwareBackupCount(w http.ResponseWriter, r *http.Request) {
	eng, err := h.getEngine()
	if err != nil {
		h.server.sendResponse(w, http.StatusServiceUnavailable, nil, err)
		return
	}
	n, err := eng.GetFirmwareBackupCount()
	if err != nil {
		h.server.sendResponse(w, http.StatusInternalServerError, nil, err)
		return
	}
	h.server.sendResponse(w, http.StatusOK, map[string]interface{}{"count": n}, nil)
}

// FirmwareRollback restores the most recent backup
func (h *AdminHandlers) FirmwareRollback(w http.ResponseWriter, r *http.Request) {
	eng, err := h.getEngine()
	if err != nil {
		h.server.sendResponse(w, http.StatusServiceUnavailable, nil, err)
		return
	}
	result, err := eng.RollbackFirmware()
	if err != nil {
		h.server.sendResponse(w, http.StatusBadRequest, nil, err)
		return
	}
	h.server.sendResponse(w, http.StatusOK, map[string]interface{}{"result": result}, nil)
}

// FirmwareSaveToFile saves current settings to a JSON file
func (h *AdminHandlers) FirmwareSaveToFile(w http.ResponseWriter, r *http.Request) {
	eng, err := h.getEngine()
	if err != nil {
		h.server.sendResponse(w, http.StatusServiceUnavailable, nil, err)
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.server.sendResponse(w, http.StatusBadRequest, nil, err)
		return
	}
	if err := h.server.validator.ValidateFilePath(req.Path); err != nil {
		h.server.sendResponse(w, http.StatusBadRequest, nil, err)
		return
	}
	if err := eng.SaveFirmwareToFile(req.Path); err != nil {
		h.server.sendResponse(w, http.StatusInternalServerError, nil, err)
		return
	}
	h.server.sendResponse(w, http.StatusOK, map[string]interface{}{"status": "saved", "path": req.Path}, nil)
}

// FirmwareLoadFromFile loads settings from a JSON file; supports dry run
func (h *AdminHandlers) FirmwareLoadFromFile(w http.ResponseWriter, r *http.Request) {
	eng, err := h.getEngine()
	if err != nil {
		h.server.sendResponse(w, http.StatusServiceUnavailable, nil, err)
		return
	}
	var req struct {
		Path   string `json:"path"`
		DryRun bool   `json:"dry_run"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.server.sendResponse(w, http.StatusBadRequest, nil, err)
		return
	}
	if err := h.server.validator.ValidateFilePath(req.Path); err != nil {
		h.server.sendResponse(w, http.StatusBadRequest, nil, err)
		return
	}
	result, err := eng.LoadFirmwareFromFile(req.Path, req.DryRun)
	if err != nil {
		h.server.sendResponse(w, http.StatusBadRequest, nil, err)
		return
	}
	h.server.sendResponse(w, http.StatusOK, map[string]interface{}{
		"dry_run": req.DryRun,
		"result":  result,
		"path":    req.Path,
	}, nil)
}

// FirmwareSetMode sets the firmware operational mode
func (h *AdminHandlers) FirmwareSetMode(w http.ResponseWriter, r *http.Request) {
    eng, err := h.getEngine()
    if err != nil {
        h.server.sendResponse(w, http.StatusServiceUnavailable, nil, err)
        return
    }
    var req struct {
        Mode string `json:"mode"`
    }
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        h.server.sendResponse(w, http.StatusBadRequest, nil, err)
        return
    }
    if strings.TrimSpace(req.Mode) == "" {
        h.server.sendResponse(w, http.StatusBadRequest, nil, errors.New("mode is required"))
        return
    }
    allowedModes := map[string]struct{}{
		"eco":      {},
		"balanced": {},
		"turbo":    {},
		"silent":   {},
	}
	if _, ok := allowedModes[req.Mode]; !ok {
		h.server.sendResponse(w, http.StatusBadRequest, nil, errors.New("invalid mode specified, allowed modes are: eco, balanced, turbo, silent"))
		return
	}
    if err := eng.SetFirmwareMode(req.Mode); err != nil {
        h.server.sendResponse(w, http.StatusBadRequest, nil, err)
        return
    }
    h.server.sendResponse(w, http.StatusOK, map[string]interface{}{"status": "updated", "mode": req.Mode}, nil)
}

// FirmwareSetFanPercent sets the fan speed percentage
func (h *AdminHandlers) FirmwareSetFanPercent(w http.ResponseWriter, r *http.Request) {
    eng, err := h.getEngine()
    if err != nil {
        h.server.sendResponse(w, http.StatusServiceUnavailable, nil, err)
        return
    }
    var req struct {
        FanPercent int `json:"fan_percent"`
    }
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        h.server.sendResponse(w, http.StatusBadRequest, nil, err)
        return
    }

	if req.FanPercent < 0 || req.FanPercent > 100 {
		h.server.sendResponse(w, http.StatusBadRequest, nil, errors.New("fan_percent must be between 0 and 100"))
		return
	}

    if err := eng.SetFanPercent(req.FanPercent); err != nil {
        h.server.sendResponse(w, http.StatusBadRequest, nil, err)
        return
    }
    h.server.sendResponse(w, http.StatusOK, map[string]interface{}{"status": "updated", "fan_percent": req.FanPercent}, nil)
}

// FirmwareSetPowerLimit sets the power limit in Watts
func (h *AdminHandlers) FirmwareSetPowerLimit(w http.ResponseWriter, r *http.Request) {
    eng, err := h.getEngine()
    if err != nil {
        h.server.sendResponse(w, http.StatusServiceUnavailable, nil, err)
        return
    }
    var req struct {
        PowerLimitW int `json:"power_limit_w"`
    }
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        h.server.sendResponse(w, http.StatusBadRequest, nil, err)
        return
    }

	if req.PowerLimitW < 0 {
		h.server.sendResponse(w, http.StatusBadRequest, nil, errors.New("power_limit_w must be a non-negative integer"))
		return
	}

    if err := eng.SetPowerLimit(req.PowerLimitW); err != nil {
        h.server.sendResponse(w, http.StatusBadRequest, nil, err)
        return
    }
    h.server.sendResponse(w, http.StatusOK, map[string]interface{}{"status": "updated", "power_limit_w": req.PowerLimitW}, nil)
}

// FirmwareSetMinApplyInterval sets minimum interval between firmware apply operations
func (h *AdminHandlers) FirmwareSetMinApplyInterval(w http.ResponseWriter, r *http.Request) {
    eng, err := h.getEngine()
    if err != nil {
        h.server.sendResponse(w, http.StatusServiceUnavailable, nil, err)
        return
    }
    var req struct {
        Interval string `json:"interval"`
    }
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        h.server.sendResponse(w, http.StatusBadRequest, nil, err)
        return
    }
    if strings.TrimSpace(req.Interval) == "" {
        h.server.sendResponse(w, http.StatusBadRequest, nil, errors.New("interval is required"))
        return
    }
    d, err := time.ParseDuration(req.Interval)
    if err != nil {
        h.server.sendResponse(w, http.StatusBadRequest, nil, errors.New("invalid interval format"))
        return
    }
    if d < 0 {
        h.server.sendResponse(w, http.StatusBadRequest, nil, errors.New("interval must be a non-negative duration"))
        return
    }
    if err := eng.SetFirmwareMinApplyInterval(d); err != nil {
        h.server.sendResponse(w, http.StatusBadRequest, nil, err)
        return
    }
    h.server.sendResponse(w, http.StatusOK, map[string]interface{}{"status": "updated", "interval": d.String()}, nil)
}

// FirmwareSetMaxBackups sets the maximum number of retained firmware backups
func (h *AdminHandlers) FirmwareSetMaxBackups(w http.ResponseWriter, r *http.Request) {
    eng, err := h.getEngine()
    if err != nil {
        h.server.sendResponse(w, http.StatusServiceUnavailable, nil, err)
        return
    }
    var req struct {
        Max int `json:"max"`
    }
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        h.server.sendResponse(w, http.StatusBadRequest, nil, err)
        return
    }

	if req.Max < 0 {
		h.server.sendResponse(w, http.StatusBadRequest, nil, errors.New("max must be a non-negative integer"))
		return
	}

    if err := eng.SetFirmwareMaxBackups(req.Max); err != nil {
        h.server.sendResponse(w, http.StatusBadRequest, nil, err)
        return
    }
    h.server.sendResponse(w, http.StatusOK, map[string]interface{}{"status": "updated", "max": req.Max}, nil)
}

// FirmwareGetLastAppliedAt returns the last applied time for firmware settings
func (h *AdminHandlers) FirmwareGetLastAppliedAt(w http.ResponseWriter, r *http.Request) {
    eng, err := h.getEngine()
    if err != nil {
        h.server.sendResponse(w, http.StatusServiceUnavailable, nil, err)
        return
    }
    t, err := eng.GetFirmwareLastAppliedAt()
    if err != nil {
        h.server.sendResponse(w, http.StatusInternalServerError, nil, err)
        return
    }
    var ts string
    if !t.IsZero() {
        ts = t.Format(time.RFC3339)
    } else {
        ts = ""
    }
    h.server.sendResponse(w, http.StatusOK, map[string]interface{}{"last_applied_at": ts}, nil)
}

// NewAdminHandlers creates new admin handlers
func NewAdminHandlers(logger *zap.Logger, poolManager *pool.PoolManager, totp *auth.TOTPProvider, server *Server) *AdminHandlers {
	return &AdminHandlers{
		logger:      logger,
		poolManager: poolManager,
		totp:        totp,
		server:      server,
	}
}

// RegisterRoutes registers admin routes
func (h *AdminHandlers) RegisterRoutes(router *mux.Router) {
	// The provided router is already mounted under /admin by the caller.
	// Register endpoints directly on it to avoid double-prefixing.
	
	// Dashboard data
	router.HandleFunc("/dashboard", h.GetDashboard).Methods("GET")
	router.HandleFunc("/stats", h.GetPoolStats).Methods("GET")
	router.HandleFunc("/workers", h.GetWorkers).Methods("GET")
	router.HandleFunc("/workers/{id}", h.GetWorker).Methods("GET")
	router.HandleFunc("/blocks", h.GetBlocks).Methods("GET")
	router.HandleFunc("/payouts", h.GetPayouts).Methods("GET")
	router.HandleFunc("/charts/hashrate", h.GetHashrateChart).Methods("GET")
	router.HandleFunc("/charts/shares", h.GetSharesChart).Methods("GET")
	router.HandleFunc("/charts/earnings", h.GetEarningsChart).Methods("GET")
	
	// Management actions
	router.HandleFunc("/workers/{id}/ban", h.BanWorker).Methods("POST")
	router.HandleFunc("/workers/{id}/unban", h.UnbanWorker).Methods("POST")
	router.HandleFunc("/payouts/process", h.ProcessPayouts).Methods("POST")
	router.HandleFunc("/maintenance/cleanup", h.RunCleanup).Methods("POST")

	// Firmware optimizer endpoints (protected by admin auth + 2FA)
	router.HandleFunc("/firmware/profiles", h.FirmwareListProfiles).Methods("GET")
	router.HandleFunc("/firmware/profile/apply", h.FirmwareApplyProfile).Methods("POST")
	router.HandleFunc("/firmware/reset-defaults", h.FirmwareResetDefaults).Methods("POST")
	router.HandleFunc("/firmware/settings", h.FirmwareGetSettings).Methods("GET")
	router.HandleFunc("/firmware/settings/apply", h.FirmwareApplySettings).Methods("POST")
	router.HandleFunc("/firmware/backup", h.FirmwareBackup).Methods("POST")
	router.HandleFunc("/firmware/backups/count", h.FirmwareBackupCount).Methods("GET")
	router.HandleFunc("/firmware/rollback", h.FirmwareRollback).Methods("POST")
	router.HandleFunc("/firmware/save", h.FirmwareSaveToFile).Methods("POST")
	router.HandleFunc("/firmware/load", h.FirmwareLoadFromFile).Methods("POST")

	// Additional firmware controls
	router.HandleFunc("/firmware/mode/set", h.FirmwareSetMode).Methods("POST")
	router.HandleFunc("/firmware/fan/set", h.FirmwareSetFanPercent).Methods("POST")
	router.HandleFunc("/firmware/power/set", h.FirmwareSetPowerLimit).Methods("POST")
	router.HandleFunc("/firmware/apply-interval/set", h.FirmwareSetMinApplyInterval).Methods("POST")
	router.HandleFunc("/firmware/backups/max/set", h.FirmwareSetMaxBackups).Methods("POST")
	router.HandleFunc("/firmware/last-applied-at", h.FirmwareGetLastAppliedAt).Methods("GET")
}

// GetDashboard returns dashboard summary data
func (h *AdminHandlers) GetDashboard(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	
	stats, err := h.poolManager.GetPoolStats(ctx)
	if err != nil {
		h.logger.Error("Failed to get pool stats", zap.Error(err))
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	
	// Extract key metrics for dashboard
	dashboard := map[string]interface{}{
		"overview": map[string]interface{}{
			"total_workers":     getNestedValue(stats, "shares.unique_workers", 0),
			"total_hashrate":    calculatePoolHashrate(stats),
			"blocks_found_24h":  getNestedValue(stats, "blocks.total_blocks", 0),
			"total_paid_24h":    getNestedValue(stats, "payouts.total_paid", 0.0),
			"pending_payouts":   toInt(getNestedValue(stats, "payout_processor.total_payouts", 0)) - toInt(getNestedValue(stats, "payout_processor.completed_payouts", 0)),
			"pool_efficiency":   calculateEfficiency(stats),
		},
		"shares": map[string]interface{}{
			"valid_shares":     getNestedValue(stats, "shares.valid_shares", 0),
			"invalid_shares":   getNestedValue(stats, "shares.invalid_shares", 0),
			"valid_rate":       getNestedValue(stats, "shares.valid_rate", 0.0),
			"shares_per_min":   calculateSharesPerMinute(stats),
		},
		"blocks": map[string]interface{}{
			"confirmed":  getNestedValue(stats, "blocks.confirmed_blocks", 0),
			"pending":    getNestedValue(stats, "block_submitter.pending_submissions", 0),
			"orphaned":   getNestedValue(stats, "blocks.orphaned_blocks", 0),
			"total_24h":  getNestedValue(stats, "blocks.total_blocks", 0),
		},
		"payouts": map[string]interface{}{
			"completed":      getNestedValue(stats, "payouts.completed_payouts", 0),
			"failed":         getNestedValue(stats, "payouts.failed_payouts", 0),
			"total_paid":     getNestedValue(stats, "payouts.total_paid", 0.0),
			"avg_payout":     getNestedValue(stats, "payouts.avg_payout", 0.0),
			"unique_workers": getNestedValue(stats, "payouts.unique_workers", 0),
		},
		"config": getNestedValue(stats, "config", map[string]interface{}{}),
		"timestamp": time.Now().Unix(),
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(dashboard)
}

// GetPoolStats returns detailed pool statistics
func (h *AdminHandlers) GetPoolStats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	
	stats, err := h.poolManager.GetPoolStats(ctx)
	if err != nil {
		h.logger.Error("Failed to get pool stats", zap.Error(err))
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

// GetWorkers returns list of workers
func (h *AdminHandlers) GetWorkers(w http.ResponseWriter, r *http.Request) {
	page, limit := getPagination(r)
	offset := (page - 1) * limit

	workers, total, err := h.poolManager.GetWorkers(r.Context(), limit, offset)
	if err != nil {
		h.logger.Error("Failed to get workers", zap.Error(err))
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	response := map[string]interface{}{
		"data":  workers,
		"page":    page,
		"limit":   limit,
		"total":   total,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// GetWorker returns detailed worker information
func (h *AdminHandlers) GetWorker(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	workerID := vars["id"]

	if err := h.server.validator.ValidateWorkerID(workerID); err != nil {
		h.server.sendResponse(w, http.StatusBadRequest, nil, err)
		return
	}
	
	ctx := r.Context()
	
	stats, err := h.poolManager.GetWorkerStats(ctx, workerID)
	if err != nil {
		h.logger.Error("Failed to get worker stats", zap.Error(err))
		http.Error(w, "Worker not found", http.StatusNotFound)
		return
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

// GetBlocks returns list of blocks
func (h *AdminHandlers) GetBlocks(w http.ResponseWriter, r *http.Request) {
	page, limit := getPagination(r)
	offset := (page - 1) * limit

	blocks, total, err := h.poolManager.GetBlocks(r.Context(), limit, offset)
	if err != nil {
		h.logger.Error("Failed to get blocks", zap.Error(err))
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	response := map[string]interface{}{
		"data":  blocks,
		"page":    page,
		"limit":   limit,
		"total":   total,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// GetPayouts returns list of payouts
func (h *AdminHandlers) GetPayouts(w http.ResponseWriter, r *http.Request) {
	page, limit := getPagination(r)
	offset := (page - 1) * limit

	payouts, total, err := h.poolManager.GetPayouts(r.Context(), limit, offset)
	if err != nil {
		h.logger.Error("Failed to get payouts", zap.Error(err))
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	response := map[string]interface{}{
		"data":  payouts,
		"page":    page,
		"limit":   limit,
		"total":   total,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// GetHashrateChart returns hashrate time series data
func (h *AdminHandlers) GetHashrateChart(w http.ResponseWriter, r *http.Request) {
	start, end, interval := parseTimeParams(r)

	data, err := h.poolManager.GetHashrateChartData(r.Context(), start, end, interval)
	if err != nil {
		h.logger.Error("Failed to get hashrate chart data", zap.Error(err))
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	response := map[string]interface{}{
		"data":     data,
		"from":     start.Format(time.RFC3339),
		"to":       end.Format(time.RFC3339),
		"interval": interval.String(),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// GetSharesChart returns shares time series data
func (h *AdminHandlers) GetSharesChart(w http.ResponseWriter, r *http.Request) {
	start, end, interval := parseTimeParams(r)

	data, err := h.poolManager.GetSharesChartData(r.Context(), start, end, interval)
	if err != nil {
		h.logger.Error("Failed to get shares chart data", zap.Error(err))
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"data": data})
}

// GetEarningsChart returns earnings time series data
func (h *AdminHandlers) GetEarningsChart(w http.ResponseWriter, r *http.Request) {
	start, end, interval := parseTimeParams(r)

	data, err := h.poolManager.GetEarningsChartData(r.Context(), start, end, interval)
	if err != nil {
		h.logger.Error("Failed to get earnings chart data", zap.Error(err))
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"data": data})
}

// Management actions

// BanWorker bans a worker
func (h *AdminHandlers) BanWorker(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	workerID := vars["id"]

	if err := h.server.validator.ValidateWorkerID(workerID); err != nil {
		h.server.sendResponse(w, http.StatusBadRequest, nil, err)
		return
	}

	if err := h.poolManager.BanWorker(r.Context(), workerID); err != nil {
		h.logger.Error("Failed to ban worker", zap.String("worker_id", workerID), zap.Error(err))
		// Distinguish between not found and other errors
		if strings.Contains(err.Error(), "not found") {
			http.Error(w, "Worker not found", http.StatusNotFound)
		} else {
			http.Error(w, "Failed to ban worker", http.StatusInternalServerError)
		}
		return
	}

	h.logger.Info("Banned worker", zap.String("worker_id", workerID))
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "banned", "worker_id": workerID})
}

// UnbanWorker unbans a worker
func (h *AdminHandlers) UnbanWorker(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	workerID := vars["id"]

	if err := h.server.validator.ValidateWorkerID(workerID); err != nil {
		h.server.sendResponse(w, http.StatusBadRequest, nil, err)
		return
	}

	if err := h.poolManager.UnbanWorker(r.Context(), workerID); err != nil {
		h.logger.Error("Failed to unban worker", zap.String("worker_id", workerID), zap.Error(err))
		if strings.Contains(err.Error(), "not found") {
			http.Error(w, "Worker not found", http.StatusNotFound)
		} else {
			http.Error(w, "Failed to unban worker", http.StatusInternalServerError)
		}
		return
	}

	h.logger.Info("Unbanned worker", zap.String("worker_id", workerID))
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "active", "worker_id": workerID})
}

// ProcessPayouts triggers payout processing
func (h *AdminHandlers) ProcessPayouts(w http.ResponseWriter, r *http.Request) {
	if err := h.poolManager.TriggerPayouts(); err != nil {
		h.logger.Error("Failed to trigger payouts", zap.Error(err))
		http.Error(w, "Failed to trigger payouts", http.StatusInternalServerError)
		return
	}

	h.logger.Info("Processing payouts triggered by admin")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "payout processing triggered"})
}

// RunCleanup runs cleanup tasks
func (h *AdminHandlers) RunCleanup(w http.ResponseWriter, r *http.Request) {
	if err := h.poolManager.TriggerCleanup(); err != nil {
		h.logger.Error("Failed to trigger cleanup", zap.Error(err))
		http.Error(w, "Failed to trigger cleanup", http.StatusInternalServerError)
		return
	}

	h.logger.Info("Cleanup triggered by admin")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "cleanup triggered"})
}

// MFA management endpoints (admin-authenticated; enrollment flows should be accessible without 2FA)

// EnrollMFA enrolls the current admin for TOTP-based 2FA and returns enrollment info
func (h *AdminHandlers) EnrollMFA(w http.ResponseWriter, r *http.Request) {
	if h.totp == nil {
		http.Error(w, "2FA provider unavailable", http.StatusServiceUnavailable)
		return
	}
	user, _ := r.Context().Value("user").(string)
	if user == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	// If already enrolled, just return info
	if h.totp.IsEnrolled(user) {
		info, err := h.totp.GetEnrollmentInfo(user)
		if err != nil {
			h.logger.Error("GetEnrollmentInfo failed", zap.Error(err))
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(info)
		return
	}
	if err := h.totp.EnrollUser(user, nil); err != nil {
		h.logger.Warn("EnrollUser failed", zap.Error(err))
		http.Error(w, "Unable to enroll", http.StatusBadRequest)
		return
	}
	info, err := h.totp.GetEnrollmentInfo(user)
	if err != nil {
		h.logger.Error("GetEnrollmentInfo after enroll failed", zap.Error(err))
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(info)
}

// GetMFAInfo returns current TOTP enrollment info for the admin
func (h *AdminHandlers) GetMFAInfo(w http.ResponseWriter, r *http.Request) {
	if h.totp == nil {
		http.Error(w, "2FA provider unavailable", http.StatusServiceUnavailable)
		return
	}
	user, _ := r.Context().Value("user").(string)
	if user == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	info, err := h.totp.GetEnrollmentInfo(user)
	if err != nil {
		http.Error(w, "Not enrolled", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(info)
}

// DisableMFA disables TOTP for the current admin
func (h *AdminHandlers) DisableMFA(w http.ResponseWriter, r *http.Request) {
	if h.totp == nil {
		http.Error(w, "2FA provider unavailable", http.StatusServiceUnavailable)
		return
	}
	user, _ := r.Context().Value("user").(string)
	if user == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if err := h.totp.DisableUser(user); err != nil {
		http.Error(w, "Not enrolled", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "disabled"})
}

// RegenerateBackupCodes regenerates backup codes for the current admin
func (h *AdminHandlers) RegenerateBackupCodes(w http.ResponseWriter, r *http.Request) {
	if h.totp == nil {
		http.Error(w, "2FA provider unavailable", http.StatusServiceUnavailable)
		return
	}
	user, _ := r.Context().Value("user").(string)
	if user == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	codes, err := h.totp.RegenerateBackupCodes(user)
	if err != nil {
		http.Error(w, "Not enrolled", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"backup_codes": codes})
}

// Helper functions

func parseTimeParams(r *http.Request) (start, end time.Time, interval time.Duration) {
	// Default to the last 24 hours
	end = time.Now()
	start = end.Add(-24 * time.Hour)

	if fromStr := r.URL.Query().Get("from"); fromStr != "" {
		if from, err := time.Parse(time.RFC3339, fromStr); err == nil {
			start = from
		}
	}

	if toStr := r.URL.Query().Get("to"); toStr != "" {
		if to, err := time.Parse(time.RFC3339, toStr); err == nil {
			end = to
		}
	}

	if start.After(end) {
		start = end.Add(-24 * time.Hour) // Reset start to a valid range if order is wrong
	}

	// Default interval to 1 hour
	interval = time.Hour
	if intervalStr := r.URL.Query().Get("interval"); intervalStr != "" {
		if d, err := time.ParseDuration(intervalStr); err == nil {
			interval = d
		}
	}

	if interval <= 0 {
		interval = time.Hour // Default to 1 hour if not a positive duration
	}

	return start, end, interval
}

func getPagination(r *http.Request) (page, limit int) {
	page, _ = strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}

	limit, _ = strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 {
		limit = 20 // Default limit
	} else if limit > 100 {
		limit = 100 // Max limit
	}
	return page, limit
}

func getNestedValue(data map[string]interface{}, path string, defaultValue interface{}) interface{} {
	keys := []string{path}
	if idx := strings.Index(path, "."); idx > 0 {
		keys = strings.Split(path, ".")
	}
	
	current := data
	for i, key := range keys {
		if val, ok := current[key]; ok {
			if i == len(keys)-1 {
				return val
			}
			if nextMap, ok := val.(map[string]interface{}); ok {
				current = nextMap
			} else {
				return defaultValue
			}
		} else {
			return defaultValue
		}
	}
	
	return defaultValue
}

func calculatePoolHashrate(stats map[string]interface{}) float64 {
	// Calculate from worker stats or difficulty stats
	return 135000000.0 // Placeholder
}

func calculateEfficiency(stats map[string]interface{}) float64 {
	validShares := getNestedValue(stats, "shares.valid_shares", float64(0)).(float64)
	totalShares := getNestedValue(stats, "shares.total_shares", float64(1)).(float64)
	
	if totalShares > 0 {
		return (validShares / totalShares) * 100
	}
	return 0
}

func calculateSharesPerMinute(stats map[string]interface{}) float64 {
	// Calculate from share submission rate
	return 13.5 // Placeholder
}

func toInt(v interface{}) int {
	switch t := v.(type) {
	case int:
		return t
	case int32:
		return int(t)
	case int64:
		return int(t)
	case uint:
		return int(t)
	case uint32:
		return int(t)
	case uint64:
		return int(t)
	case float32:
		return int(t)
	case float64:
		return int(t)
	case string:
		if i, err := strconv.Atoi(t); err == nil {
			return i
		}
		return 0
	default:
		return 0
	}
}