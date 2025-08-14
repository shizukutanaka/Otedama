package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/shizukutanaka/Otedama/internal/mining"
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

// handleMiningStats returns current and historical mining statistics
func (s *Server) handleMiningStats(w http.ResponseWriter, r *http.Request) {
    // Parse optional time range (e.g., "30m", "1h", "24h"). Default: 1h
    rng := r.URL.Query().Get("range")
    if rng == "" {
        rng = "1h"
    }
    dur, err := time.ParseDuration(rng)
    if err != nil {
        dur = time.Hour
    }

    resp := map[string]interface{}{
        "current": nil,
        "history": []interface{}{},
    }
    if s.engine != nil {
        resp["current"] = s.engine.GetStats()
        resp["history"] = s.engine.GetStatsHistory(dur)
    }

    respondJSON(w, http.StatusOK, resp)
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

// handleStartMining starts the mining process
func (s *Server) handleStartMining(w http.ResponseWriter, r *http.Request) {
	var req MiningStartRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate request
	if req.Algorithm == "" {
		respondError(w, http.StatusBadRequest, "Algorithm is required")
		return
	}

	if req.WalletAddr == "" {
		respondError(w, http.StatusBadRequest, "Wallet address is required")
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
	if s.engine != nil {
		// Configure engine from request
		if err := s.engine.SetAlgorithm(mining.AlgorithmType(req.Algorithm)); err != nil {
			s.logger.Error("Failed to set algorithm", zap.Error(err))
			respondError(w, http.StatusBadRequest, "Unsupported algorithm")
			return
		}
		if req.Threads > 0 {
			if err := s.engine.SetCPUThreads(req.Threads); err != nil {
				s.logger.Error("Failed to set threads", zap.Error(err))
				respondError(w, http.StatusBadRequest, "Invalid threads value")
				return
			}
		}
		if req.Intensity > 0 {
			_ = s.engine.SetConfig("intensity", req.Intensity)
		}
		if req.PoolURL != "" || req.WalletAddr != "" {
			if err := s.engine.SetPool(req.PoolURL, req.WalletAddr); err != nil {
				s.logger.Error("Failed to set pool", zap.Error(err))
				respondError(w, http.StatusBadRequest, "Invalid pool or wallet")
				return
			}
		}
		if err := s.engine.Start(); err != nil {
			s.logger.Error("Failed to start mining", zap.Error(err))
			respondError(w, http.StatusInternalServerError, "Failed to start mining")
			return
		}
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"status":    "started",
		"algorithm": req.Algorithm,
		"threads":   req.Threads,
		"message":   "Mining started successfully",
	})
}

// handleStopMining stops the mining process
func (s *Server) handleStopMining(w http.ResponseWriter, r *http.Request) {
	if s.engine != nil {
		if err := s.engine.Stop(); err != nil {
			s.logger.Error("Failed to stop mining", zap.Error(err))
			respondError(w, http.StatusInternalServerError, "Failed to stop mining")
			return
		}
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "stopped",
		"message": "Mining stopped successfully",
	})
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