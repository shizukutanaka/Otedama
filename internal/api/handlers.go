package api

import (
	"encoding/json"
	"net/http"
	"time"
)

// HealthResponse represents health check response
type HealthResponse struct {
	Status    string            `json:"status"`
	Timestamp time.Time         `json:"timestamp"`
	Checks    map[string]bool   `json:"checks"`
}

// MiningStats represents mining statistics
type MiningStats struct {
	Hashrate       float64 `json:"hashrate"`
	SharesAccepted int64   `json:"shares_accepted"`
	SharesRejected int64   `json:"shares_rejected"`
	Difficulty     float64 `json:"difficulty"`
	Algorithm      string  `json:"algorithm"`
	Workers        int     `json:"workers"`
	Uptime         int64   `json:"uptime"`
}

// WorkerInfo represents worker information
type WorkerInfo struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Type           string  `json:"type"`
	Hashrate       float64 `json:"hashrate"`
	Temperature    int     `json:"temperature"`
	Power          int     `json:"power"`
	Status         string  `json:"status"`
	SharesAccepted int64   `json:"shares_accepted"`
	SharesRejected int64   `json:"shares_rejected"`
	LastSeen       time.Time `json:"last_seen"`
}

// PoolStats represents pool statistics
type PoolStats struct {
	Hashrate        float64   `json:"hashrate"`
	Miners          int       `json:"miners"`
	Workers         int       `json:"workers"`
	ShareDifficulty float64   `json:"share_difficulty"`
	BlocksFound     int64     `json:"blocks_found"`
	LastBlockTime   time.Time `json:"last_block_time"`
	RoundShares     int64     `json:"round_shares"`
	Fee             float64   `json:"fee"`
}

// PeerInfo represents P2P peer information
type PeerInfo struct {
	ID          string    `json:"id"`
	Address     string    `json:"address"`
	Version     string    `json:"version"`
	Hashrate    float64   `json:"hashrate"`
	Workers     int       `json:"workers"`
	ConnectedAt time.Time `json:"connected_at"`
	Latency     int       `json:"latency_ms"`
}

// StratumInfo represents stratum server information
type StratumInfo struct {
	Enabled      bool     `json:"enabled"`
	Port         int      `json:"port"`
	Difficulty   float64  `json:"difficulty"`
	Connections  int      `json:"connections"`
	ExtraNonce1  string   `json:"extra_nonce1"`
	ExtraNonce2Size int   `json:"extra_nonce2_size"`
}

// ProfitStatus represents profit switching status
type ProfitStatus struct {
	Enabled         bool                   `json:"enabled"`
	CurrentAlgo     string                 `json:"current_algo"`
	NextSwitch      time.Time              `json:"next_switch"`
	Threshold       float64                `json:"threshold_percent"`
	CheckInterval   int                    `json:"check_interval_minutes"`
	Algorithms      []AlgorithmProfit      `json:"algorithms"`
}

// AlgorithmProfit represents profitability data for an algorithm
type AlgorithmProfit struct {
	Name          string  `json:"name"`
	Hashrate      float64 `json:"hashrate"`
	Profitability float64 `json:"profitability"`
	ProfitPerDay  float64 `json:"profit_per_day"`
	Difficulty    float64 `json:"difficulty"`
}

// ErrorResponse represents an error response
type ErrorResponse struct {
	Error     string    `json:"error"`
	Code      string    `json:"code,omitempty"`
	Timestamp time.Time `json:"timestamp"`
}

// respondJSON sends a JSON response
func respondJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// respondError sends an error response
func respondError(w http.ResponseWriter, status int, message string) {
	respondJSON(w, status, ErrorResponse{
		Error:     message,
		Timestamp: time.Now(),
	})
}