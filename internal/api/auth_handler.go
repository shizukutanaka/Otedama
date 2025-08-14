package api

import (
	"encoding/json"
	"math/big"
	"net/http"

	"github.com/gorilla/mux"
	"github.com/shizukutanaka/Otedama/internal/auth"
	"go.uber.org/zap"
)

// AuthHandler handles all authentication-related API endpoints.	ype AuthHandler struct {
	logger     *zap.Logger
	zkpManager *auth.ZKPManager
	auth       *WebSocketAuth // To generate JWT tokens
}

// NewAuthHandler creates a new AuthHandler.
func NewAuthHandler(logger *zap.Logger, zkpManager *auth.ZKPManager, auth *WebSocketAuth) *AuthHandler {
	return &AuthHandler{
		logger:     logger,
		zkpManager: zkpManager,
		auth:       auth,
	}
}

// RegisterRoutes registers the authentication routes with the main router.
func (h *AuthHandler) RegisterRoutes(router *mux.Router) {
	router.HandleFunc("/auth/zkp-challenge", h.zkpChallengeHandler).Methods("POST")
	router.HandleFunc("/auth/zkp-login", h.zkpLoginHandler).Methods("POST")
}

// --- DTOs for Auth Handlers ---

type zkpChallengeRequest struct {
	Username string `json:"username"`
}

type zkpLoginRequest struct {
	Username   string `json:"username"`
	Commitment string `json:"commitment"`
	Proof      string `json:"proof"`
}

// --- Handler Implementations ---

func (h *AuthHandler) zkpChallengeHandler(w http.ResponseWriter, r *http.Request) {
	var req zkpChallengeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request payload")
		return
	}

	challenge, err := h.zkpManager.GenerateChallenge(req.Username)
	if err != nil {
		h.logger.Warn("Failed to generate ZKP challenge", zap.String("username", req.Username), zap.Error(err))
		respondWithError(w, http.StatusNotFound, err.Error())
		return
	}

	respondWithJSON(w, http.StatusOK, map[string]string{"challenge": challenge})
}

func (h *AuthHandler) zkpLoginHandler(w http.ResponseWriter, r *http.Request) {
	var req zkpLoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request payload")
		return
	}

	commitment, ok := new(big.Int).SetString(req.Commitment, 10)
	if !ok {
		respondWithError(w, http.StatusBadRequest, "Invalid commitment format")
		return
	}

	proof, ok := new(big.Int).SetString(req.Proof, 10)
	if !ok {
		respondWithError(w, http.StatusBadRequest, "Invalid proof format")
		return
	}

	valid, err := h.zkpManager.VerifyProof(req.Username, commitment, proof)
	if err != nil {
		h.logger.Warn("Error verifying ZKP proof", zap.String("username", req.Username), zap.Error(err))
		respondWithError(w, http.StatusUnauthorized, err.Error())
		return
	}

	if !valid {
		h.logger.Warn("Invalid ZKP proof received", zap.String("username", req.Username))
		respondWithError(w, http.StatusUnauthorized, "ZKP proof verification failed")
		return
	}

	// If proof is valid, generate a JWT token
	permissions, err := h.auth.rbac.GetPermissions(req.Username)
	if err != nil {
		h.logger.Error("Failed to get user permissions after ZKP login", zap.String("username", req.Username), zap.Error(err))
		respondWithError(w, http.StatusInternalServerError, "Could not retrieve user permissions")
		return
	}

	token, err := h.auth.GenerateToken(req.Username, permissions)
	if err != nil {
		h.logger.Error("Failed to generate token after ZKP login", zap.String("username", req.Username), zap.Error(err))
		respondWithError(w, http.StatusInternalServerError, "Could not generate authentication token")
		return
	}

	respondWithJSON(w, http.StatusOK, map[string]string{"token": token})
}
