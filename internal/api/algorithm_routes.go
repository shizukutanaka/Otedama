package api

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/mux"
	"github.com/shizukutanaka/Otedama/internal/mining"
	"go.uber.org/zap"
)

// RegisterAlgorithmRoutes registers algorithm-related API routes
func (s *Server) RegisterAlgorithmRoutes(router *mux.Router) {
	algo := router.PathPrefix("/algorithms").Subrouter()
	
	// Get supported algorithms
	algo.HandleFunc("/", s.handleGetAlgorithms).Methods("GET")
	
	// Get current algorithm
	algo.HandleFunc("/current", s.handleGetCurrentAlgorithm).Methods("GET")
	
	// Switch algorithm
	algo.HandleFunc("/switch", s.handleSwitchAlgorithm).Methods("POST")
	
	// Get profitability data
	algo.HandleFunc("/profitability", s.handleGetProfitability).Methods("GET")
	
	// Compare algorithms
	algo.HandleFunc("/compare", s.handleCompareAlgorithms).Methods("GET")
	
	// Update power cost
	algo.HandleFunc("/power-cost", s.handleUpdatePowerCost).Methods("PUT")
	
	// Enable/disable profit switching
	algo.HandleFunc("/profit-switching", s.handleProfitSwitching).Methods("PUT")
}

// handleGetAlgorithms returns supported algorithms
func (s *Server) handleGetAlgorithms(w http.ResponseWriter, r *http.Request) {
	algorithms := []map[string]interface{}{
		{
			"id":          "sha256d",
			"name":        "SHA256D",
			"description": "Double SHA256 (Bitcoin)",
			"hardware":    []string{"CPU", "GPU", "ASIC"},
		},
		{
			"id":          "scrypt",
			"name":        "Scrypt",
			"description": "Scrypt algorithm (Litecoin)",
			"hardware":    []string{"CPU", "GPU", "ASIC"},
		},
		{
			"id":          "ethash",
			"name":        "Ethash",
			"description": "Ethereum Classic algorithm",
			"hardware":    []string{"GPU"},
		},
		{
			"id":          "randomx",
			"name":        "RandomX",
			"description": "CPU-optimized algorithm (Monero)",
			"hardware":    []string{"CPU"},
		},
		{
			"id":          "kawpow",
			"name":        "KawPow",
			"description": "GPU-optimized algorithm (Ravencoin)",
			"hardware":    []string{"GPU"},
		},
		{
			"id":          "blake2b256",
			"name":        "Blake2b-256",
			"description": "Blake2b algorithm (Siacoin)",
			"hardware":    []string{"CPU", "GPU", "ASIC"},
		},
	}
	
	s.writeJSON(w, http.StatusOK, map[string]interface{}{
		"algorithms": algorithms,
	})
}

// handleGetCurrentAlgorithm returns the current mining algorithm
func (s *Server) handleGetCurrentAlgorithm(w http.ResponseWriter, r *http.Request) {
	if s.engine == nil {
		s.writeError(w, http.StatusServiceUnavailable, "Mining engine not available")
		return
	}
	
	algo := s.engine.GetAlgorithm()
	
	response := map[string]interface{}{
		"algorithm": string(algo),
	}
	
	s.writeJSON(w, http.StatusOK, response)
}

// SwitchAlgorithmRequest represents algorithm switch request
type SwitchAlgorithmRequest struct {
	Algorithm string `json:"algorithm"`
}

// handleSwitchAlgorithm handles algorithm switching
func (s *Server) handleSwitchAlgorithm(w http.ResponseWriter, r *http.Request) {
	if s.engine == nil {
		s.writeError(w, http.StatusServiceUnavailable, "Mining engine not available")
		return
	}
	
	var req SwitchAlgorithmRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	if err := s.engine.SetAlgorithm(mining.AlgorithmType(req.Algorithm)); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	
	s.logger.Info("Algorithm switched",
		zap.String("algorithm", req.Algorithm))
	
	s.writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":   true,
		"algorithm": req.Algorithm,
	})
}

// handleGetProfitability returns profitability data
func (s *Server) handleGetProfitability(w http.ResponseWriter, r *http.Request) {
	if s.engine == nil {
		s.writeError(w, http.StatusServiceUnavailable, "Mining engine not available")
		return
	}
	// Not implemented with current engine API
	s.writeError(w, http.StatusNotImplemented, "Profitability data endpoint is not implemented")
}

// handleCompareAlgorithms compares algorithm profitability
func (s *Server) handleCompareAlgorithms(w http.ResponseWriter, r *http.Request) {
	if s.engine == nil {
		s.writeError(w, http.StatusServiceUnavailable, "Mining engine not available")
		return
	}
	// Not implemented with current engine API
	s.writeError(w, http.StatusNotImplemented, "Algorithm comparison endpoint is not implemented")
}

// UpdatePowerCostRequest represents power cost update request
type UpdatePowerCostRequest struct {
	CostPerKWh float64 `json:"cost_per_kwh"`
}

// handleUpdatePowerCost updates electricity cost
func (s *Server) handleUpdatePowerCost(w http.ResponseWriter, r *http.Request) {
	if s.engine == nil {
		s.writeError(w, http.StatusServiceUnavailable, "Mining engine not available")
		return
	}
	
	var req UpdatePowerCostRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	if req.CostPerKWh < 0 || req.CostPerKWh > 1 {
		s.writeError(w, http.StatusBadRequest, "Invalid power cost (must be between 0 and 1)")
		return
	}
	// Not implemented with current engine API
	s.writeError(w, http.StatusNotImplemented, "Power cost configuration is not implemented")
}

// ProfitSwitchingRequest represents profit switching configuration
type ProfitSwitchingRequest struct {
	Enabled   bool    `json:"enabled"`
	Threshold float64 `json:"threshold"`
}

// handleProfitSwitching configures profit-based switching
func (s *Server) handleProfitSwitching(w http.ResponseWriter, r *http.Request) {
	if s.engine == nil {
		s.writeError(w, http.StatusServiceUnavailable, "Mining engine not available")
		return
	}
	
	var req ProfitSwitchingRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	if req.Threshold < 0 || req.Threshold > 100 {
		s.writeError(w, http.StatusBadRequest, "Invalid threshold (must be between 0 and 100)")
		return
	}
	// Not implemented with current engine API
	s.writeError(w, http.StatusNotImplemented, "Profit switching is not implemented")
}