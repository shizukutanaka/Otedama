package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

func (s *Server) handleProfitStatus(w http.ResponseWriter, r *http.Request) {
	status := map[string]interface{}{
		"enabled":          true,
		"current_algo":     "SHA256d",
		"next_switch":      time.Now().Add(15 * time.Minute),
		"profit_threshold": 5.0,
		"algorithms": []map[string]interface{}{
			{
				"name":           "SHA256d",
				"profitability":  1.0,
				"hashrate":       1250000,
				"profit_per_day": 0.00012,
			},
			{
				"name":           "Ethash",
				"profitability":  0.95,
				"hashrate":       30000000,
				"profit_per_day": 0.00011,
			},
		},
	}

	response := Response{
		Success: true,
		Data:    status,
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleProfitSwitch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Algorithm string `json:"algorithm"`
		Force     bool   `json:"force"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.sendError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate algorithm
	if err := s.validator.ValidateAlgorithm(req.Algorithm); err != nil {
		s.sendError(w, http.StatusBadRequest, fmt.Sprintf("Invalid algorithm: %v", err))
		return
	}

	response := Response{
		Success: true,
		Data: map[string]interface{}{
			"algorithm": req.Algorithm,
			"forced":    req.Force,
			"message":   fmt.Sprintf("Switching to %s algorithm", req.Algorithm),
		},
		Time: time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}
