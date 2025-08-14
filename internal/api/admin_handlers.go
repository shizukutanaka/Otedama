package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"
	"github.com/shizukutanaka/Otedama/internal/auth"
	"github.com/shizukutanaka/Otedama/internal/pool"
	"go.uber.org/zap"
)

// AdminHandlers handles admin API endpoints
type AdminHandlers struct {
	logger      *zap.Logger
	poolManager *pool.PoolManager
	totp        *auth.TOTPProvider
}

// NewAdminHandlers creates new admin handlers
func NewAdminHandlers(logger *zap.Logger, poolManager *pool.PoolManager, totp *auth.TOTPProvider) *AdminHandlers {
	return &AdminHandlers{
		logger:      logger,
		poolManager: poolManager,
		totp:        totp,
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
	// Parse query parameters
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 || limit > 100 {
		limit = 50
	}
	
	sortBy := r.URL.Query().Get("sort")
	if sortBy == "" {
		sortBy = "hashrate"
	}
	
	// TODO: Implement worker listing with pagination
	workers := []map[string]interface{}{
		{
			"id":           "worker1",
			"username":     "miner1",
			"hashrate":     125000000,
			"valid_shares": 1234,
			"invalid_shares": 12,
			"last_seen":    time.Now().Add(-5 * time.Minute).Unix(),
			"status":       "active",
		},
		// Add more mock data or implement actual database query
	}
	
	response := map[string]interface{}{
		"workers": workers,
		"page":    page,
		"limit":   limit,
		"total":   len(workers),
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// GetWorker returns detailed worker information
func (h *AdminHandlers) GetWorker(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	workerID := vars["id"]
	
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
	// TODO: Implement block listing from database
	blocks := []map[string]interface{}{
		{
			"height":        1234567,
			"hash":          "0x123...abc",
			"reward":        6.25,
			"status":        "confirmed",
			"confirmations": 12,
			"found_at":      time.Now().Add(-2 * time.Hour).Unix(),
			"miner":         "worker1",
		},
		// Add more mock data
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(blocks)
}

// GetPayouts returns list of payouts
func (h *AdminHandlers) GetPayouts(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement payout listing from database
	payouts := []map[string]interface{}{
		{
			"id":             1,
			"worker_id":      "worker1",
			"amount":         0.01234567,
			"currency":       "BTC",
			"address":        "bc1q...",
			"transaction_id": "tx123...",
			"status":         "completed",
			"created_at":     time.Now().Add(-1 * time.Hour).Unix(),
		},
		// Add more mock data
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(payouts)
}

// GetHashrateChart returns hashrate time series data
func (h *AdminHandlers) GetHashrateChart(w http.ResponseWriter, r *http.Request) {
	// Parse time range
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	interval := r.URL.Query().Get("interval")
	
	if interval == "" {
		interval = "5m"
	}
	
	// TODO: Implement actual time series query
	data := []map[string]interface{}{
		{"time": time.Now().Add(-1 * time.Hour).Unix(), "value": 100000000},
		{"time": time.Now().Add(-50 * time.Minute).Unix(), "value": 120000000},
		{"time": time.Now().Add(-40 * time.Minute).Unix(), "value": 115000000},
		{"time": time.Now().Add(-30 * time.Minute).Unix(), "value": 125000000},
		{"time": time.Now().Add(-20 * time.Minute).Unix(), "value": 130000000},
		{"time": time.Now().Add(-10 * time.Minute).Unix(), "value": 128000000},
		{"time": time.Now().Unix(), "value": 135000000},
	}
	
	response := map[string]interface{}{
		"data":     data,
		"from":     from,
		"to":       to,
		"interval": interval,
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// GetSharesChart returns shares time series data
func (h *AdminHandlers) GetSharesChart(w http.ResponseWriter, r *http.Request) {
	// Similar to hashrate chart but for shares
	data := []map[string]interface{}{
		{"time": time.Now().Add(-1 * time.Hour).Unix(), "valid": 100, "invalid": 2},
		{"time": time.Now().Add(-50 * time.Minute).Unix(), "valid": 120, "invalid": 3},
		{"time": time.Now().Add(-40 * time.Minute).Unix(), "valid": 115, "invalid": 1},
		{"time": time.Now().Add(-30 * time.Minute).Unix(), "valid": 125, "invalid": 4},
		{"time": time.Now().Add(-20 * time.Minute).Unix(), "valid": 130, "invalid": 2},
		{"time": time.Now().Add(-10 * time.Minute).Unix(), "valid": 128, "invalid": 3},
		{"time": time.Now().Unix(), "valid": 135, "invalid": 2},
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"data": data})
}

// GetEarningsChart returns earnings time series data
func (h *AdminHandlers) GetEarningsChart(w http.ResponseWriter, r *http.Request) {
	// Earnings over time
	data := []map[string]interface{}{
		{"time": time.Now().Add(-7 * 24 * time.Hour).Unix(), "value": 0.5},
		{"time": time.Now().Add(-6 * 24 * time.Hour).Unix(), "value": 0.7},
		{"time": time.Now().Add(-5 * 24 * time.Hour).Unix(), "value": 0.6},
		{"time": time.Now().Add(-4 * 24 * time.Hour).Unix(), "value": 0.8},
		{"time": time.Now().Add(-3 * 24 * time.Hour).Unix(), "value": 0.9},
		{"time": time.Now().Add(-2 * 24 * time.Hour).Unix(), "value": 0.7},
		{"time": time.Now().Add(-1 * 24 * time.Hour).Unix(), "value": 1.1},
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"data": data})
}

// Management actions

// BanWorker bans a worker
func (h *AdminHandlers) BanWorker(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	workerID := vars["id"]
	
	// TODO: Implement worker ban logic
	h.logger.Info("Banning worker", zap.String("worker_id", workerID))
	
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "banned", "worker_id": workerID})
}

// UnbanWorker unbans a worker
func (h *AdminHandlers) UnbanWorker(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	workerID := vars["id"]
	
	// TODO: Implement worker unban logic
	h.logger.Info("Unbanning worker", zap.String("worker_id", workerID))
	
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "active", "worker_id": workerID})
}

// ProcessPayouts triggers payout processing
func (h *AdminHandlers) ProcessPayouts(w http.ResponseWriter, r *http.Request) {
	// TODO: Trigger payout processing
	h.logger.Info("Processing payouts triggered by admin")
	
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "processing"})
}

// RunCleanup runs cleanup tasks
func (h *AdminHandlers) RunCleanup(w http.ResponseWriter, r *http.Request) {
	// TODO: Trigger cleanup
	h.logger.Info("Cleanup triggered by admin")
	
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "cleanup started"})
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