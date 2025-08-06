package worker

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/mux"
	"go.uber.org/zap"

)

// WorkerAPI provides REST API for worker management
// Following Rob Pike's simplicity principles
type WorkerAPI struct {
	logger  *zap.Logger
	manager *WorkerManager
	router  *mux.Router
}

// APIResponse is the standard API response format
type APIResponse struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
	Meta    *APIMeta    `json:"meta,omitempty"`
}

// APIMeta contains metadata for API responses
type APIMeta struct {
	Page       int    `json:"page,omitempty"`
	PerPage    int    `json:"per_page,omitempty"`
	Total      int    `json:"total,omitempty"`
	TotalPages int    `json:"total_pages,omitempty"`
	Timestamp  string `json:"timestamp"`
}

// Worker API request/response structures

// RegisterWorkerRequest represents a worker registration request
type RegisterWorkerRequest struct {
	Name         string            `json:"name"`
	GroupID      string            `json:"group_id,omitempty"`
	HardwareType string            `json:"hardware_type"`
	HardwareInfo HardwareInfo      `json:"hardware_info"`
	Algorithm    string            `json:"algorithm"`
	Currency     string            `json:"currency"`
	Pool         string            `json:"pool"`
	Wallet       string            `json:"wallet"`
	Config       WorkerConfiguration `json:"config,omitempty"`
}

// UpdateWalletRequest represents a wallet address update request
type UpdateWalletRequest struct {
	Wallet   string `json:"wallet"`
	Currency string `json:"currency"`
}

// UpdateWorkerRequest represents a worker update request
type UpdateWorkerRequest struct {
	Name     string              `json:"name,omitempty"`
	GroupID  string              `json:"group_id,omitempty"`
	Config   *WorkerConfiguration `json:"config,omitempty"`
}

// WorkerStatusUpdate represents a worker status update
type WorkerStatusUpdate struct {
	Status       string      `json:"status"`
	Hashrate     float64     `json:"hashrate"`
	Shares       ShareMetric `json:"shares"`
	Temperature  float64     `json:"temperature,omitempty"`
	PowerUsage   float64     `json:"power_usage,omitempty"`
	FanSpeed     int         `json:"fan_speed,omitempty"`
}

// CreateGroupRequest represents a group creation request
type CreateGroupRequest struct {
	Name        string             `json:"name"`
	Description string             `json:"description,omitempty"`
	Config      GroupConfiguration `json:"config,omitempty"`
}

// CommandRequest represents a command execution request
type CommandRequest struct {
	Type       string                 `json:"type"`
	Target     string                 `json:"target"`
	TargetID   string                 `json:"target_id,omitempty"`
	Parameters map[string]interface{} `json:"parameters,omitempty"`
	Timeout    int                    `json:"timeout,omitempty"` // seconds
}

// WorkerResponse represents a worker in API responses
type WorkerResponse struct {
	ID           string                 `json:"id"`
	UserID       string                 `json:"user_id"`
	GroupID      string                 `json:"group_id,omitempty"`
	Name         string                 `json:"name"`
	Status       string                 `json:"status"`
	HardwareType string                 `json:"hardware_type"`
	HardwareInfo HardwareInfo           `json:"hardware_info"`
	Algorithm    string                 `json:"algorithm"`
	Currency     string                 `json:"currency"`
	Hashrate     float64                `json:"hashrate"`
	Shares       ShareStats             `json:"shares"`
	Efficiency   float64                `json:"efficiency"`
	Uptime       int64                  `json:"uptime"`
	LastSeen     string                 `json:"last_seen"`
	Config       WorkerConfiguration    `json:"config"`
	Metadata     map[string]interface{} `json:"metadata,omitempty"`
}

// ShareStats represents share statistics
type ShareStats struct {
	Accepted uint64  `json:"accepted"`
	Rejected uint64  `json:"rejected"`
	Stale    uint64  `json:"stale"`
	Ratio    float64 `json:"ratio"`
}

// GroupResponse represents a group in API responses
type GroupResponse struct {
	ID              string             `json:"id"`
	UserID          string             `json:"user_id"`
	Name            string             `json:"name"`
	Description     string             `json:"description"`
	Status          string             `json:"status"`
	WorkerCount     int32              `json:"worker_count"`
	TotalHashrate   float64            `json:"total_hashrate"`
	AverageHashrate float64            `json:"average_hashrate"`
	Config          GroupConfiguration `json:"config"`
	CreatedAt       string             `json:"created_at"`
	UpdatedAt       string             `json:"updated_at"`
}

// NewWorkerAPI creates a new worker API
func NewWorkerAPI(logger *zap.Logger, manager *WorkerManager) *WorkerAPI {
	api := &WorkerAPI{
		logger:  logger,
		manager: manager,
		router:  mux.NewRouter(),
	}
	
	api.setupRoutes()
	return api
}

// ServeHTTP implements http.Handler
func (api *WorkerAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	api.router.ServeHTTP(w, r)
}

// setupRoutes configures API routes
func (api *WorkerAPI) setupRoutes() {
	// Middleware
	api.router.Use(api.loggingMiddleware)
	api.router.Use(api.authMiddleware)
	
	// Worker routes
	api.router.HandleFunc("/api/v1/workers", api.handleListWorkers).Methods("GET")
	api.router.HandleFunc("/api/v1/workers", api.handleRegisterWorker).Methods("POST")
	api.router.HandleFunc("/api/v1/workers/{id}", api.handleGetWorker).Methods("GET")
	api.router.HandleFunc("/api/v1/workers/{id}", api.handleUpdateWorker).Methods("PUT")
	api.router.HandleFunc("/api/v1/workers/{id}", api.handleDeleteWorker).Methods("DELETE")
	api.router.HandleFunc("/api/v1/workers/{id}/wallet", api.handleUpdateWallet).Methods("PUT")
	api.router.HandleFunc("/api/v1/workers/{id}/status", api.handleUpdateWorkerStatus).Methods("POST")
	api.router.HandleFunc("/api/v1/workers/{id}/metrics", api.handleGetWorkerMetrics).Methods("GET")
	
	// Group routes
	api.router.HandleFunc("/api/v1/groups", api.handleListGroups).Methods("GET")
	api.router.HandleFunc("/api/v1/groups", api.handleCreateGroup).Methods("POST")
	api.router.HandleFunc("/api/v1/groups/{id}", api.handleGetGroup).Methods("GET")
	api.router.HandleFunc("/api/v1/groups/{id}", api.handleUpdateGroup).Methods("PUT")
	api.router.HandleFunc("/api/v1/groups/{id}", api.handleDeleteGroup).Methods("DELETE")
	api.router.HandleFunc("/api/v1/groups/{id}/workers", api.handleGetGroupWorkers).Methods("GET")
	
	// Command routes
	api.router.HandleFunc("/api/v1/commands", api.handleExecuteCommand).Methods("POST")
	api.router.HandleFunc("/api/v1/commands/{id}", api.handleGetCommandStatus).Methods("GET")
	
	// Statistics routes
	api.router.HandleFunc("/api/v1/stats", api.handleGetStats).Methods("GET")
	api.router.HandleFunc("/api/v1/stats/performance", api.handleGetPerformanceStats).Methods("GET")
}

// Middleware

func (api *WorkerAPI) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		
		next.ServeHTTP(w, r)
		
		api.logger.Debug("API request",
			zap.String("method", r.Method),
			zap.String("path", r.URL.Path),
			zap.Duration("duration", time.Since(start)),
		)
	})
}

func (api *WorkerAPI) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Simple auth check - in production, implement proper authentication
		userID := r.Header.Get("X-User-ID")
		if userID == "" {
			api.sendError(w, http.StatusUnauthorized, "Missing user ID")
			return
		}
		
		// Add user ID to request context
		r.Header.Set("User-ID", userID)
		
		next.ServeHTTP(w, r)
	})
}

// Worker handlers

func (api *WorkerAPI) handleListWorkers(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("User-ID")
	
	// Get pagination
	page := 1
	perPage := 50
	
	if p := r.URL.Query().Get("page"); p != "" {
		if parsed, err := strconv.Atoi(p); err == nil && parsed > 0 {
			page = parsed
		}
	}
	
	if pp := r.URL.Query().Get("per_page"); pp != "" {
		if parsed, err := strconv.Atoi(pp); err == nil && parsed > 0 && parsed <= 100 {
			perPage = parsed
		}
	}
	
	// Get workers
	workers, err := api.manager.GetUserWorkers(userID)
	if err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to get workers")
		return
	}
	
	// Convert to response format
	responses := make([]WorkerResponse, 0, len(workers))
	for _, worker := range workers {
		responses = append(responses, api.workerToResponse(worker))
	}
	
	// Apply pagination
	total := len(responses)
	start := (page - 1) * perPage
	end := start + perPage
	
	if start >= total {
		responses = []WorkerResponse{}
	} else if end > total {
		responses = responses[start:]
	} else {
		responses = responses[start:end]
	}
	
	api.sendSuccess(w, responses, &APIMeta{
		Page:       page,
		PerPage:    perPage,
		Total:      total,
		TotalPages: (total + perPage - 1) / perPage,
	})
}

func (api *WorkerAPI) handleRegisterWorker(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("User-ID")
	
	var req RegisterWorkerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		api.sendError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	// Validate wallet address
	if err := req.Validate(); err != nil {
		api.sendError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Create worker
	worker := &Worker{
		ID:           generateWorkerID(),
		UserID:       userID,
		Name:         req.Name,
		GroupID:      req.GroupID,
		HardwareType: HardwareType(req.HardwareType),
		HardwareInfo: req.HardwareInfo,
		Algorithm:    req.Algorithm,
		Currency:     req.Currency,
		Pool:         req.Pool,
		Metadata:     map[string]interface{}{"wallet": req.Wallet},
		IPAddress:    r.RemoteAddr,
		ConnectedAt:  time.Now(),
		LastSeen:     time.Now(),
		Config:       req.Config,
	}
	
	// Register worker
	if err := api.manager.RegisterWorker(worker); err != nil {
		api.sendError(w, http.StatusBadRequest, err.Error())
		return
	}
	
	api.sendSuccess(w, api.workerToResponse(worker), nil)
}

func (api *WorkerAPI) handleGetWorker(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("User-ID")
	workerID := mux.Vars(r)["id"]
	
	worker, err := api.manager.GetWorker(workerID)
	if err != nil {
		api.sendError(w, http.StatusNotFound, "Worker not found")
		return
	}
	
	// Check ownership
	if worker.UserID != userID {
		api.sendError(w, http.StatusForbidden, "Access denied")
		return
	}
	
	api.sendSuccess(w, api.workerToResponse(worker), nil)
}

func (api *WorkerAPI) handleUpdateWorker(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("User-ID")
	workerID := mux.Vars(r)["id"]
	
	worker, err := api.manager.GetWorker(workerID)
	if err != nil {
		api.sendError(w, http.StatusNotFound, "Worker not found")
		return
	}
	
	// Check ownership
	if worker.UserID != userID {
		api.sendError(w, http.StatusForbidden, "Access denied")
		return
	}
	
	var req UpdateWorkerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		api.sendError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	// Update worker
	if req.Name != "" {
		worker.Name = req.Name
	}
	if req.GroupID != "" {
		worker.GroupID = req.GroupID
	}
	if req.Config != nil {
		worker.Config = *req.Config
	}
	
	api.sendSuccess(w, api.workerToResponse(worker), nil)
}

// handleUpdateWallet updates a worker's wallet address
func (api *WorkerAPI) handleUpdateWallet(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("User-ID")
	workerID := mux.Vars(r)["id"]
	
	worker, err := api.manager.GetWorker(workerID)
	if err != nil {
		api.sendError(w, http.StatusNotFound, "Worker not found")
		return
	}
	
	// Check ownership
	if worker.UserID != userID {
		api.sendError(w, http.StatusForbidden, "Access denied")
		return
	}
	
	var req UpdateWalletRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		api.sendError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	// Validate wallet address
	if err := req.Validate(); err != nil {
		api.sendError(w, http.StatusBadRequest, err.Error())
		return
	}
	
	// Update wallet address
	if err := api.manager.UpdateWorkerWallet(workerID, req.Wallet); err != nil {
		api.sendError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to update wallet: %v", err))
		return
	}
	
	// Refresh worker data
	worker, err = api.manager.GetWorker(workerID)
	if err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to retrieve updated worker")
		return
	}
	
	api.sendSuccess(w, api.workerToResponse(worker), nil)
}

func (api *WorkerAPI) handleDeleteWorker(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("User-ID")
	workerID := mux.Vars(r)["id"]
	
	worker, err := api.manager.GetWorker(workerID)
	if err != nil {
		api.sendError(w, http.StatusNotFound, "Worker not found")
		return
	}
	
	// Check ownership
	if worker.UserID != userID {
		api.sendError(w, http.StatusForbidden, "Access denied")
		return
	}
	
	// Unregister worker
	if err := api.manager.UnregisterWorker(workerID); err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to delete worker")
		return
	}
	
	api.sendSuccess(w, map[string]string{"message": "Worker deleted successfully"}, nil)
}

func (api *WorkerAPI) handleUpdateWorkerStatus(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("User-ID")
	workerID := mux.Vars(r)["id"]
	
	worker, err := api.manager.GetWorker(workerID)
	if err != nil {
		api.sendError(w, http.StatusNotFound, "Worker not found")
		return
	}
	
	// Check ownership
	if worker.UserID != userID {
		api.sendError(w, http.StatusForbidden, "Access denied")
		return
	}
	
	var req WorkerStatusUpdate
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		api.sendError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	// Update status
	if err := api.manager.UpdateWorkerStatus(
		workerID,
		WorkerStatus(req.Status),
		req.Hashrate,
		req.Shares,
	); err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to update status")
		return
	}
	
	// Update hardware info if provided
	if req.Temperature > 0 {
		worker.HardwareInfo.Temperature = req.Temperature
	}
	if req.PowerUsage > 0 {
		worker.HardwareInfo.PowerUsage = req.PowerUsage
	}
	if req.FanSpeed > 0 {
		worker.HardwareInfo.FanSpeed = req.FanSpeed
	}
	
	api.sendSuccess(w, map[string]string{"message": "Status updated successfully"}, nil)
}

func (api *WorkerAPI) handleGetWorkerMetrics(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("User-ID")
	workerID := mux.Vars(r)["id"]
	
	worker, err := api.manager.GetWorker(workerID)
	if err != nil {
		api.sendError(w, http.StatusNotFound, "Worker not found")
		return
	}
	
	// Check ownership
	if worker.UserID != userID {
		api.sendError(w, http.StatusForbidden, "Access denied")
		return
	}
	
	// Get time range
	period := r.URL.Query().Get("period")
	if period == "" {
		period = "24h"
	}
	
	// Get metrics
	worker.metricsLock.RLock()
	metrics := map[string]interface{}{
		"hashrate_history": worker.metrics.HashrateHistory,
		"share_history":    worker.metrics.ShareHistory,
		"error_count":      worker.metrics.ErrorCount,
		"bandwidth":        worker.metrics.Bandwidth,
	}
	worker.metricsLock.RUnlock()
	
	api.sendSuccess(w, metrics, nil)
}

// Group handlers

func (api *WorkerAPI) handleListGroups(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("User-ID")
	
	groups := make([]GroupResponse, 0)
	
	// Get user's groups
	api.manager.workerGroups.Range(func(key, value interface{}) bool {
		group := value.(*WorkerGroup)
		if group.UserID == userID {
			groups = append(groups, api.groupToResponse(group))
		}
		return true
	})
	
	api.sendSuccess(w, groups, nil)
}

func (api *WorkerAPI) handleCreateGroup(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("User-ID")
	
	var req CreateGroupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		api.sendError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	// Create group
	group := &WorkerGroup{
		ID:          generateGroupID(),
		UserID:      userID,
		Name:        req.Name,
		Description: req.Description,
		Config:      req.Config,
	}
	
	if err := api.manager.CreateGroup(group); err != nil {
		api.sendError(w, http.StatusBadRequest, err.Error())
		return
	}
	
	api.sendSuccess(w, api.groupToResponse(group), nil)
}

func (api *WorkerAPI) handleGetGroup(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("User-ID")
	groupID := mux.Vars(r)["id"]
	
	group, err := api.manager.GetGroup(groupID)
	if err != nil {
		api.sendError(w, http.StatusNotFound, "Group not found")
		return
	}
	
	// Check ownership
	if group.UserID != userID {
		api.sendError(w, http.StatusForbidden, "Access denied")
		return
	}
	
	api.sendSuccess(w, api.groupToResponse(group), nil)
}

func (api *WorkerAPI) handleUpdateGroup(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("User-ID")
	groupID := mux.Vars(r)["id"]
	
	group, err := api.manager.GetGroup(groupID)
	if err != nil {
		api.sendError(w, http.StatusNotFound, "Group not found")
		return
	}
	
	// Check ownership
	if group.UserID != userID {
		api.sendError(w, http.StatusForbidden, "Access denied")
		return
	}
	
	var req CreateGroupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		api.sendError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	// Update group
	if req.Name != "" {
		group.Name = req.Name
	}
	if req.Description != "" {
		group.Description = req.Description
	}
	group.Config = req.Config
	group.UpdatedAt = time.Now()
	
	api.sendSuccess(w, api.groupToResponse(group), nil)
}

func (api *WorkerAPI) handleDeleteGroup(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("User-ID")
	groupID := mux.Vars(r)["id"]
	
	group, err := api.manager.GetGroup(groupID)
	if err != nil {
		api.sendError(w, http.StatusNotFound, "Group not found")
		return
	}
	
	// Check ownership
	if group.UserID != userID {
		api.sendError(w, http.StatusForbidden, "Access denied")
		return
	}
	
	// Delete group
	if err := api.manager.DeleteGroup(groupID); err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to delete group")
		return
	}
	
	api.sendSuccess(w, map[string]string{"message": "Group deleted successfully"}, nil)
}

func (api *WorkerAPI) handleGetGroupWorkers(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("User-ID")
	groupID := mux.Vars(r)["id"]
	
	group, err := api.manager.GetGroup(groupID)
	if err != nil {
		api.sendError(w, http.StatusNotFound, "Group not found")
		return
	}
	
	// Check ownership
	if group.UserID != userID {
		api.sendError(w, http.StatusForbidden, "Access denied")
		return
	}
	
	// Get workers in group
	workers := make([]WorkerResponse, 0)
	
	group.Workers.Range(func(key, value interface{}) bool {
		worker := value.(*Worker)
		workers = append(workers, api.workerToResponse(worker))
		return true
	})
	
	api.sendSuccess(w, workers, nil)
}

// Command handlers

func (api *WorkerAPI) handleExecuteCommand(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("User-ID")
	
	var req CommandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		api.sendError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	// Validate ownership for targeted commands
	if req.Target == "worker" && req.TargetID != "" {
		worker, err := api.manager.GetWorker(req.TargetID)
		if err != nil || worker.UserID != userID {
			api.sendError(w, http.StatusForbidden, "Access denied")
			return
		}
	} else if req.Target == "group" && req.TargetID != "" {
		group, err := api.manager.GetGroup(req.TargetID)
		if err != nil || group.UserID != userID {
			api.sendError(w, http.StatusForbidden, "Access denied")
			return
		}
	}
	
	// Create command
	cmd := WorkerCommand{
		Type:       CommandType(req.Type),
		Target:     CommandTarget(req.Target),
		TargetID:   req.TargetID,
		Parameters: req.Parameters,
	}
	
	if req.Timeout > 0 {
		cmd.Timeout = time.Duration(req.Timeout) * time.Second
	}
	
	// Execute command
	responseChan := make(chan CommandResponse, 1)
	cmd.ResponseChan = responseChan
	
	if err := api.manager.ExecuteCommand(cmd); err != nil {
		api.sendError(w, http.StatusInternalServerError, err.Error())
		return
	}
	
	// Wait for response
	select {
	case response := <-responseChan:
		if response.Success {
			api.sendSuccess(w, response.Data, nil)
		} else {
			api.sendError(w, http.StatusInternalServerError, response.Error.Error())
		}
		
	case <-time.After(30 * time.Second):
		api.sendError(w, http.StatusRequestTimeout, "Command timeout")
	}
}

func (api *WorkerAPI) handleGetCommandStatus(w http.ResponseWriter, r *http.Request) {
	// Command status tracking would be implemented here
	api.sendError(w, http.StatusNotImplemented, "Command status tracking not implemented")
}

// Statistics handlers

func (api *WorkerAPI) handleGetStats(w http.ResponseWriter, r *http.Request) {
	stats := api.manager.GetStats()
	api.sendSuccess(w, stats, nil)
}

func (api *WorkerAPI) handleGetPerformanceStats(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("User-ID")
	
	// Calculate user-specific performance stats
	totalHashrate := 0.0
	workerCount := 0
	groupCount := 0
	
	api.manager.workers.Range(func(key, value interface{}) bool {
		worker := value.(*Worker)
		if worker.UserID == userID {
			workerCount++
			if hr := worker.Hashrate.Load(); hr != nil {
				totalHashrate += hr.(float64)
			}
		}
		return true
	})
	
	api.manager.workerGroups.Range(func(key, value interface{}) bool {
		group := value.(*WorkerGroup)
		if group.UserID == userID {
			groupCount++
		}
		return true
	})
	
	stats := map[string]interface{}{
		"total_workers":   workerCount,
		"total_groups":    groupCount,
		"total_hashrate":  totalHashrate,
		"average_hashrate": totalHashrate / float64(workerCount),
	}
	
	api.sendSuccess(w, stats, nil)
}

// Helper methods

func (api *WorkerAPI) sendSuccess(w http.ResponseWriter, data interface{}, meta *APIMeta) {
	if meta == nil {
		meta = &APIMeta{}
	}
	meta.Timestamp = time.Now().Format(time.RFC3339)
	
	response := APIResponse{
		Success: true,
		Data:    data,
		Meta:    meta,
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func (api *WorkerAPI) sendError(w http.ResponseWriter, status int, message string) {
	response := APIResponse{
		Success: false,
		Error:   message,
		Meta: &APIMeta{
			Timestamp: time.Now().Format(time.RFC3339),
		},
	}
	
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(response)
}

func (api *WorkerAPI) workerToResponse(worker *Worker) WorkerResponse {
	efficiency := 0.0
	accepted := worker.SharesAccepted.Load()
	rejected := worker.SharesRejected.Load()
	if accepted > 0 {
		efficiency = float64(accepted) / float64(accepted+rejected) * 100
	}
	
	uptime := int64(0)
	if worker.ConnectedAt.Unix() > 0 {
		uptime = time.Since(worker.ConnectedAt).Seconds()
	}
	
	hashrate := 0.0
	if hr := worker.Hashrate.Load(); hr != nil {
		hashrate = hr.(float64)
	}
	
	status := StatusOffline
	if s := worker.Status.Load(); s != nil {
		status = s.(WorkerStatus)
	}
	
	return WorkerResponse{
		ID:           worker.ID,
		UserID:       worker.UserID,
		GroupID:      worker.GroupID,
		Name:         worker.Name,
		Status:       string(status),
		HardwareType: string(worker.HardwareType),
		HardwareInfo: worker.HardwareInfo,
		Algorithm:    worker.Algorithm,
		Currency:     worker.Currency,
		Hashrate:     hashrate,
		Shares: ShareStats{
			Accepted: accepted,
			Rejected: rejected,
			Stale:    worker.SharesStale.Load(),
			Ratio:    efficiency,
		},
		Efficiency: efficiency,
		Uptime:     uptime,
		LastSeen:   worker.LastSeen.Format(time.RFC3339),
		Config:     worker.Config,
		Metadata:   worker.Metadata,
	}
}

func (api *WorkerAPI) groupToResponse(group *WorkerGroup) GroupResponse {
	totalHashrate := 0.0
	if hr := group.TotalHashrate.Load(); hr != nil {
		totalHashrate = hr.(float64)
	}
	
	avgHashrate := 0.0
	if hr := group.AverageHashrate.Load(); hr != nil {
		avgHashrate = hr.(float64)
	}
	
	return GroupResponse{
		ID:              group.ID,
		UserID:          group.UserID,
		Name:            group.Name,
		Description:     group.Description,
		Status:          string(group.Status),
		WorkerCount:     group.WorkerCount.Load(),
		TotalHashrate:   totalHashrate,
		AverageHashrate: avgHashrate,
		Config:          group.Config,
		CreatedAt:       group.CreatedAt.Format(time.RFC3339),
		UpdatedAt:       group.UpdatedAt.Format(time.RFC3339),
	}
}

// Helper functions

func generateWorkerID() string {
	return fmt.Sprintf("worker_%d", time.Now().UnixNano())
}

func generateGroupID() string {
	return fmt.Sprintf("group_%d", time.Now().UnixNano())
}