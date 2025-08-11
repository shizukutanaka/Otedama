package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/gorilla/mux"
	"go.uber.org/zap"
)

// MiningStartRequest represents a mining start request
type MiningStartRequest struct {
	Algorithm  string `json:"algorithm"`
	Threads    int    `json:"threads"`
	Intensity  int    `json:"intensity"`
	PoolURL    string `json:"pool_url,omitempty"`
	WalletAddr string `json:"wallet_address"`
}

// MiningStatsResponse represents mining statistics
type MiningStatsResponse struct {
	Running       bool      `json:"running"`
	Algorithm     string    `json:"algorithm"`
	Hashrate      float64   `json:"hashrate"`
	HashrateUnit  string    `json:"hashrate_unit"`
	Threads       int       `json:"threads"`
	Temperature   float64   `json:"temperature"`
	Power         float64   `json:"power_watts"`
	Efficiency    float64   `json:"efficiency"`
	ValidShares   int64     `json:"valid_shares"`
	InvalidShares int64     `json:"invalid_shares"`
	ShareRate     float64   `json:"share_rate"`
	Difficulty    float64   `json:"difficulty"`
	BlocksFound   int64     `json:"blocks_found"`
	Uptime        int64     `json:"uptime_seconds"`
	LastShare     time.Time `json:"last_share"`
	EstimatedProfit float64 `json:"estimated_profit_btc"`
}

// WorkerInfo represents information about a mining worker
type WorkerInfo struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Type          string    `json:"type"` // CPU, GPU, ASIC
	Model         string    `json:"model"`
	Hashrate      float64   `json:"hashrate"`
	Temperature   float64   `json:"temperature"`
	FanSpeed      int       `json:"fan_speed"`
	Power         float64   `json:"power_watts"`
	Status        string    `json:"status"`
	Algorithm     string    `json:"algorithm"`
	ValidShares   int64     `json:"valid_shares"`
	InvalidShares int64     `json:"invalid_shares"`
	LastSeen      time.Time `json:"last_seen"`
	Errors        []string  `json:"errors,omitempty"`
}

// handleStartMining starts the mining process
func (s *Server) handleStartMining(w http.ResponseWriter, r *http.Request) {
	var req MiningStartRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate request
	if req.Algorithm == "" {
		s.respondError(w, http.StatusBadRequest, "Algorithm is required")
		return
	}

	if req.WalletAddr == "" {
		s.respondError(w, http.StatusBadRequest, "Wallet address is required")
		return
	}

	// Set defaults
	if req.Threads == 0 {
		req.Threads = 4
	}

	if req.Intensity == 0 {
		req.Intensity = 100
	}

	// Start mining
	if s.miningEngine != nil {
		config := map[string]interface{}{
			"algorithm":  req.Algorithm,
			"threads":    req.Threads,
			"intensity":  req.Intensity,
			"wallet":     req.WalletAddr,
			"pool_url":   req.PoolURL,
		}

		if err := s.miningEngine.Start(r.Context(), config); err != nil {
			s.logger.Error("Failed to start mining", zap.Error(err))
			s.respondError(w, http.StatusInternalServerError, "Failed to start mining")
			return
		}
	}

	s.respondJSON(w, http.StatusOK, map[string]interface{}{
		"status":    "started",
		"algorithm": req.Algorithm,
		"threads":   req.Threads,
		"message":   "Mining started successfully",
	})
}

// handleStopMining stops the mining process
func (s *Server) handleStopMining(w http.ResponseWriter, r *http.Request) {
	if s.miningEngine != nil {
		if err := s.miningEngine.Stop(); err != nil {
			s.logger.Error("Failed to stop mining", zap.Error(err))
			s.respondError(w, http.StatusInternalServerError, "Failed to stop mining")
			return
		}
	}

	s.respondJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "stopped",
		"message": "Mining stopped successfully",
	})
}

// handleMiningStatus returns current mining status
func (s *Server) handleMiningStatus(w http.ResponseWriter, r *http.Request) {
	status := MiningStatsResponse{
		Running: false,
	}

	if s.miningEngine != nil && s.miningEngine.IsRunning() {
		stats := s.miningEngine.GetStats()
		
		status.Running = true
		status.Algorithm = stats.Algorithm
		status.Hashrate = stats.Hashrate
		status.HashrateUnit = getHashrateUnit(stats.Hashrate)
		status.Threads = stats.Threads
		status.Temperature = stats.Temperature
		status.Power = stats.PowerUsage
		status.Efficiency = stats.Efficiency
		status.ValidShares = stats.ValidShares
		status.InvalidShares = stats.InvalidShares
		status.ShareRate = stats.ShareRate
		status.Difficulty = stats.Difficulty
		status.BlocksFound = stats.BlocksFound
		status.Uptime = int64(stats.Uptime.Seconds())
		status.LastShare = stats.LastShare
		status.EstimatedProfit = calculateProfit(stats.Hashrate, stats.Algorithm)
	}

	s.respondJSON(w, http.StatusOK, status)
}

// handleMiningStats returns detailed mining statistics
func (s *Server) handleMiningStats(w http.ResponseWriter, r *http.Request) {
	// Get time range from query parameters
	timeRange := r.URL.Query().Get("range")
	if timeRange == "" {
		timeRange = "1h"
	}

	stats := map[string]interface{}{
		"current": nil,
		"history": []interface{}{},
		"summary": map[string]interface{}{
			"total_shares":    0,
			"total_blocks":    0,
			"average_hashrate": 0.0,
			"total_earnings":  0.0,
			"efficiency":      0.0,
		},
	}

	if s.miningEngine != nil {
		currentStats := s.miningEngine.GetStats()
		stats["current"] = currentStats

		// Get historical stats based on time range
		history := s.miningEngine.GetHistoricalStats(timeRange)
		stats["history"] = history

		// Calculate summary
		if summary := s.miningEngine.GetSummary(); summary != nil {
			stats["summary"] = summary
		}
	}

	s.respondJSON(w, http.StatusOK, stats)
}

// handleGetWorkers returns information about all mining workers
func (s *Server) handleGetWorkers(w http.ResponseWriter, r *http.Request) {
	workers := []WorkerInfo{}

	if s.miningEngine != nil {
		for _, worker := range s.miningEngine.GetWorkers() {
			info := WorkerInfo{
				ID:            worker.ID,
				Name:          worker.Name,
				Type:          worker.Type,
				Model:         worker.Model,
				Hashrate:      worker.Hashrate,
				Temperature:   worker.Temperature,
				FanSpeed:      worker.FanSpeed,
				Power:         worker.PowerUsage,
				Status:        worker.Status,
				Algorithm:     worker.Algorithm,
				ValidShares:   worker.ValidShares,
				InvalidShares: worker.InvalidShares,
				LastSeen:      worker.LastSeen,
				Errors:        worker.Errors,
			}
			workers = append(workers, info)
		}
	}

	s.respondJSON(w, http.StatusOK, workers)
}

// handleAddWorker adds a new mining worker
func (s *Server) handleAddWorker(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name      string                 `json:"name"`
		Type      string                 `json:"type"`
		Algorithm string                 `json:"algorithm"`
		Config    map[string]interface{} `json:"config"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.Name == "" || req.Type == "" {
		s.respondError(w, http.StatusBadRequest, "Name and type are required")
		return
	}

	if s.miningEngine != nil {
		workerID, err := s.miningEngine.AddWorker(req.Name, req.Type, req.Algorithm, req.Config)
		if err != nil {
			s.logger.Error("Failed to add worker", zap.Error(err))
			s.respondError(w, http.StatusInternalServerError, "Failed to add worker")
			return
		}

		s.respondJSON(w, http.StatusCreated, map[string]interface{}{
			"id":      workerID,
			"message": "Worker added successfully",
		})
		return
	}

	s.respondError(w, http.StatusServiceUnavailable, "Mining engine not available")
}

// handleRemoveWorker removes a mining worker
func (s *Server) handleRemoveWorker(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	workerID := vars["id"]

	if workerID == "" {
		s.respondError(w, http.StatusBadRequest, "Worker ID is required")
		return
	}

	if s.miningEngine != nil {
		if err := s.miningEngine.RemoveWorker(workerID); err != nil {
			s.logger.Error("Failed to remove worker", 
				zap.String("worker_id", workerID),
				zap.Error(err))
			s.respondError(w, http.StatusNotFound, "Worker not found")
			return
		}

		s.respondJSON(w, http.StatusOK, map[string]interface{}{
			"message": "Worker removed successfully",
		})
		return
	}

	s.respondError(w, http.StatusServiceUnavailable, "Mining engine not available")
}

// Helper functions

// getHashrateUnit returns appropriate unit for hashrate
func getHashrateUnit(hashrate float64) string {
	units := []string{"H/s", "KH/s", "MH/s", "GH/s", "TH/s", "PH/s"}
	unitIndex := 0
	
	for hashrate >= 1000 && unitIndex < len(units)-1 {
		hashrate /= 1000
		unitIndex++
	}
	
	return units[unitIndex]
}

// calculateProfit estimates profit based on hashrate and algorithm
func calculateProfit(hashrate float64, algorithm string) float64 {
	// Simplified profit calculation
	// In production, this would use real-time difficulty and price data
	profitRates := map[string]float64{
		"SHA256":  0.00000001,
		"Ethash":  0.00000005,
		"KawPow":  0.00000003,
		"RandomX": 0.00000002,
		"Scrypt":  0.00000004,
	}
	
	rate, exists := profitRates[algorithm]
	if !exists {
		return 0
	}
	
	return hashrate * rate * 86400 // Daily profit
}