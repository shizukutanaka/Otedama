package api

import (
	"context"
	"compress/gzip"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"
	"strings"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/shizukutanaka/Otedama/internal/auth"
	"github.com/shizukutanaka/Otedama/internal/api/middleware"
	"crypto/sha256"
	"github.com/shizukutanaka/Otedama/internal/mining"
	"github.com/shizukutanaka/Otedama/internal/pool"
	"github.com/shizukutanaka/Otedama/internal/security"
	"go.uber.org/zap"
	"math/big"
	"sync"
)

// Server provides HTTP API and WebSocket interfaces
// Simple, efficient implementation focused on essential functionality
type Server struct {
	logger     *zap.Logger
	config     Config
	router     *mux.Router
	server     *http.Server
	upgrader   websocket.Upgrader
	clients    map[*websocket.Conn]bool
	wsMu       map[*websocket.Conn]*sync.Mutex
	stats      map[string]interface{}
	limiter    *IPRateLimiter
	engine     mining.Engine
	validator  *InputValidator
	wsAuth     *WebSocketAuth
	totp       *auth.TOTPProvider
	poolManager *pool.PoolManager
	authMiddleware *middleware.AuthMiddleware
	securityMiddleware *middleware.SecurityMiddleware
	authHandler    *AuthHandler
}

// Config defines API server configuration
type Config struct {
	Enabled    bool     `yaml:"enabled"`
	ListenAddr string   `yaml:"listen_addr"`
	EnableTLS  bool     `yaml:"enable_tls"`
	CertFile   string   `yaml:"cert_file"`
	KeyFile    string   `yaml:"key_file"`
	RateLimit  int      `yaml:"rate_limit"`
	AllowOrigins []string `yaml:"allow_origins"`
	// Security/auth settings (optional; can be set via env or upper-level config)
	JWTSecret       string `yaml:"jwt_secret"`
	AdminUser       string `yaml:"admin_user"`
	AdminPassHash   string `yaml:"admin_pass_hash"`
	// TOTP (2FA) settings for admin
	TOTPIssuer       string `yaml:"totp_issuer"`
	TOTPPeriod       uint   `yaml:"totp_period"`
	TOTPDigits       int    `yaml:"totp_digits"`
	TOTPSkew         uint   `yaml:"totp_skew"`
	TOTPSecretLength int    `yaml:"totp_secret_length"`
}

// Response represents API response format
type Response struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
	Time    time.Time   `json:"time"`
}

// NewServer creates a new API server
func NewServer(config Config, logger *zap.Logger, engine mining.Engine, poolManager *pool.PoolManager) (*Server, error) {
	if !config.Enabled {
		return nil, fmt.Errorf("API server disabled")
	}

	// Resolve JWT secret from config/env; generate secure random fallback for dev
	jwtSecret := config.JWTSecret
	if jwtSecret == "" {
		if v := os.Getenv("OTEDAMA_JWT_SECRET"); v != "" {
			jwtSecret = v
		} else {
			// Generate 32-byte random secret and base64-encode
			b := make([]byte, 32)
			if _, err := rand.Read(b); err == nil {
				jwtSecret = base64.StdEncoding.EncodeToString(b)
				logger.Warn("JWT secret not provided; using ephemeral random secret (dev only)")
			} else {
				// Last resort fallback (not recommended)
				jwtSecret = "default-secret"
				logger.Warn("Failed to generate random JWT secret; using default (insecure)")
			}
		}
	}

	// Build TOTP config from server config with env fallbacks; provider applies sane defaults for zero-values
	issuer := config.TOTPIssuer
	if issuer == "" {
		if v := os.Getenv("OTEDAMA_TOTP_ISSUER"); v != "" {
			issuer = v
		}
	}
	var (
		period = config.TOTPPeriod
		digits = config.TOTPDigits
		skew   = config.TOTPSkew
		slen   = config.TOTPSecretLength
	)
	if period == 0 {
		if v := os.Getenv("OTEDAMA_TOTP_PERIOD"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n >= 0 {
				period = uint(n)
			}
		}
	}
	if digits == 0 {
		if v := os.Getenv("OTEDAMA_TOTP_DIGITS"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				digits = n
			}
		}
	}
	if skew == 0 {
		if v := os.Getenv("OTEDAMA_TOTP_SKEW"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n >= 0 {
				skew = uint(n)
			}
		}
	}
	if slen == 0 {
		if v := os.Getenv("OTEDAMA_TOTP_SECRET_LENGTH"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				slen = n
			}
		}
	}
	totpCfg := auth.TOTPConfig{
		Issuer:       issuer,
		Period:       period,
		Digits:       digits,
		Skew:         skew,
		SecretLength: slen,
	}
	totp := auth.NewTOTPProvider(logger, totpCfg)

	// Optional: load and persist TOTP secrets
	storePath := os.Getenv("OTEDAMA_TOTP_STORE")
	if storePath == "" {
		storePath = "./data/security/totp_store.json"
	}
	if abs, err := filepath.Abs(storePath); err == nil {
		if err := totp.LoadFromFile(abs); err != nil {
			logger.Warn("Failed to load TOTP store", zap.Error(err), zap.String("path", abs))
		}
		totp.SetStoragePath(abs)
		// Autosave every minute
		totp.StartAutoSave(1 * time.Minute)
	} else {
		logger.Warn("Invalid TOTP store path", zap.Error(err), zap.String("path", storePath))
	}

    // Create WebSocket auth system (API-local WS auth config)
    wsAuthCfg := WSAuthConfig{
        JWTSecret:     jwtSecret,
        TokenTTL:      24 * time.Hour,
        RefreshTTL:    7 * 24 * time.Hour,
        EnableRefresh: true,
    }
    wsAuth := NewWebSocketAuth(logger, wsAuthCfg)

	// Create new, modular middleware
	authMiddleware := middleware.NewAuthMiddleware(logger, []byte(jwtSecret), config.AdminUser, config.AdminPassHash)

	// Create a WebSecurityManager
	webSecurityConfig := security.WebSecurityConfig{
		EnableCSRF:          true,
		EnableXSSProtection: true,
	}
	webSecurity, err := security.NewWebSecurityManager(logger, webSecurityConfig)
	if err != nil {
		logger.Fatal("failed to create web security manager", zap.Error(err))
	}

	// Instantiate comprehensive validator and IP rate limiter
	secValidator := security.NewInputValidator(logger, security.ValidationConfig{})
	rl := NewIPRateLimiter(config.RateLimit, time.Minute, config.RateLimit*2)

	// Wire SecurityMiddleware with delegations
	securityMiddleware := middleware.NewSecurityMiddleware(
		logger,
		webSecurity,
		secValidator,
		rl,
		middleware.SecurityConfig{},
		authMiddleware.ValidateToken,
		func(sessionID string) (interface{}, error) { return wsAuth.ValidateSession(sessionID) },
	)

	// ZKP and Auth Handler Setup
	zkpManager := auth.NewZKPManager(logger)
	authHandler := NewAuthHandler(logger, zkpManager, wsAuth)

	// Register a default ZKP public key for the admin user for demonstration.
	// In a real system, this would be part of a dedicated user registration flow.
	if config.AdminUser != "" && config.AdminPassHash != "" {
		// Derive demo private key deterministically from the stored hash (demo only)
		passHash := sha256.Sum256([]byte(config.AdminPassHash))
		privateKey := new(big.Int).SetBytes(passHash[:])

		// Derive public key: y = g^v mod p
		p, _ := new(big.Int).SetString("23992346986434786549598124020385574583538633535221234567890123456789012345678901234567890123456789", 10)
		g := big.NewInt(5)
		publicKey := new(big.Int).Exp(g, privateKey, p)

		zkpManager.RegisterPublicKey(config.AdminUser, publicKey)
	}

	server := &Server{
		logger:    logger,
		config:    config,
		clients:   make(map[*websocket.Conn]bool),
		wsMu:      make(map[*websocket.Conn]*sync.Mutex),
		stats:     make(map[string]interface{}),
		limiter:   rl,
		engine:    engine,
		validator: NewInputValidator(),
		wsAuth:    wsAuth,
		totp:      totp,
		poolManager:        poolManager,
		authMiddleware:     authMiddleware,
		securityMiddleware: securityMiddleware,
		authHandler:        authHandler,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			EnableCompression: true,
			CheckOrigin: func(r *http.Request) bool {
				// Check against allowed origins
				if len(config.AllowOrigins) == 0 {
					// No origins configured, deny all
					return false
				}
				
				origin := r.Header.Get("Origin")
				if origin == "" {
					// No origin header, deny
					return false
				}
				
				// Check if origin is in allowed list
				for _, allowed := range config.AllowOrigins {
					if allowed == "*" || allowed == origin {
						return true
					}
				}
				
				return false
			},
		},
	}

	server.setupRoutes()
	return server, nil
}

// Start begins API server operations
func (s *Server) Start(ctx context.Context) error {
	s.server = &http.Server{
		Addr:              s.config.ListenAddr,
		Handler:           s.router,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		ReadHeaderTimeout: 5 * time.Second,
		MaxHeaderBytes:    1 << 20, // 1MB
	}

	s.logger.Info("Starting API server",
		zap.String("listen_addr", s.config.ListenAddr),
		zap.Bool("tls_enabled", s.config.EnableTLS),
	)

	go func() {
		var err error
		if s.config.EnableTLS {
			err = s.server.ListenAndServeTLS(s.config.CertFile, s.config.KeyFile)
		} else {
			err = s.server.ListenAndServe()
		}

		if err != nil && err != http.ErrServerClosed {
			s.logger.Error("API server error", zap.Error(err))
		}
	}()

	return nil
}

// Shutdown gracefully stops the API server
func (s *Server) Shutdown(ctx context.Context) error {
	s.logger.Info("Shutting down API server")

	// Close all WebSocket connections
	for client := range s.clients {
		client.Close()
	}

	// Persist and stop TOTP provider if configured
	if s.totp != nil {
		if err := s.totp.Close(); err != nil {
			s.logger.Warn("Failed to persist TOTP store on shutdown", zap.Error(err))
		}
	}

	if s.server != nil {
		return s.server.Shutdown(ctx)
	}

	return nil
}

// setupRoutes configures API routes
func (s *Server) setupRoutes() {
	s.router = mux.NewRouter()

	// Prometheus metrics endpoint
	s.router.Handle("/metrics", promhttp.Handler()).Methods("GET")

	// Create middleware chain for protected routes
	protected := s.chainMiddleware(
		s.corsMiddleware,
		s.loggingMiddleware,
		s.securityMiddleware.Middleware,
		s.gzipMiddleware,
		s.authMiddleware.RequireAdmin,
	)

	// Create middleware chain for public routes
	public := s.chainMiddleware(
		s.corsMiddleware,
		s.loggingMiddleware,
		s.securityMiddleware.Middleware,
		s.gzipMiddleware,
	)

	// API routes
	api := s.router.PathPrefix("/api/v1").Subrouter()

	// Register auth routes
	s.authHandler.RegisterRoutes(api)

	// Public endpoints (no auth required)
	api.Handle("/status", public(http.HandlerFunc(s.handleStatus))).Methods("GET")
	api.Handle("/stats", public(http.HandlerFunc(s.handleStats))).Methods("GET")
	api.Handle("/health", public(http.HandlerFunc(s.handleHealth))).Methods("GET")

	// Protected mining endpoints (require auth)
	mining := api.PathPrefix("/mining").Subrouter()
	mining.Handle("/stats", public(http.HandlerFunc(s.handleMiningStats))).Methods("GET")
	mining.Handle("/start", protected(http.HandlerFunc(s.handleStartMining))).Methods("POST")
	mining.Handle("/stop", protected(http.HandlerFunc(s.handleStopMining))).Methods("POST")
	mining.Handle("/workers", protected(http.HandlerFunc(s.handleMiningWorkers))).Methods("GET")
	mining.Handle("/workers/{id}/control", protected(http.HandlerFunc(s.handleWorkerControl))).Methods("POST")

	// Pool endpoints
	api.HandleFunc("/pool/stats", s.handlePoolStats).Methods("GET")
	api.HandleFunc("/pool/peers", s.handlePoolPeers).Methods("GET")
	api.HandleFunc("/pool/shares", s.handlePoolShares).Methods("GET")
	api.HandleFunc("/pool/info", s.handlePoolInfo).Methods("GET")

	// Stratum endpoints
	api.HandleFunc("/stratum/info", s.handleStratumInfo).Methods("GET")

	// Profit switching endpoints
	api.HandleFunc("/profit/status", s.handleProfitStatus).Methods("GET")
	api.HandleFunc("/profit/switch", s.handleProfitSwitch).Methods("POST")

	// Algorithm management endpoints
	s.RegisterAlgorithmRoutes(api)

	// Log management endpoints
	s.RegisterLogRoutes(api)

	// Internationalization endpoints
	s.RegisterI18nRoutes(api)

 	// WebSocket endpoint
 	api.HandleFunc("/ws", s.handleWebSocket)

 	// Admin dashboard routes (login + admin endpoints with 2FA)
 	s.setupAdminRoutes()

 	// Static dashboard (if needed)
 	s.router.PathPrefix("/").Handler(http.FileServer(http.Dir("./web/static/")))
}

// Middleware

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		
		// Check if origin is allowed
		if origin != "" && len(s.config.AllowOrigins) > 0 {
			for _, allowed := range s.config.AllowOrigins {
				if allowed == "*" {
					// SECURITY: Don't allow credentials with wildcard origin
					w.Header().Set("Access-Control-Allow-Origin", origin)
					// Explicitly disable credentials when using wildcard
					w.Header().Set("Access-Control-Allow-Credentials", "false")
					break
				} else if allowed == origin {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Access-Control-Allow-Credentials", "true")
					break
				}
			}
		}
		
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-TOTP-Code, X-OTP-Code")
		w.Header().Set("Access-Control-Max-Age", "3600")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// chainMiddleware provides a helper for chaining middleware
func (s *Server) chainMiddleware(middlewares ...func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	return func(final http.Handler) http.Handler {
		for i := len(middlewares) - 1; i >= 0; i-- {
			final = middlewares[i](final)
		}
		return final
	}
}

func (s *Server) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		duration := time.Since(start)

		s.logger.Debug("API request",
			zap.String("method", r.Method),
			zap.String("path", r.URL.Path),
			zap.Duration("duration", duration),
		)
	})
}

func (s *Server) gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip compression for WebSocket upgrades and if client doesn't accept gzip
		if strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") ||
			strings.ToLower(r.Header.Get("Upgrade")) == "websocket" ||
			!strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}

		w.Header().Add("Vary", "Accept-Encoding")

		gz := gzip.NewWriter(w)
		defer gz.Close()

		// Wrap ResponseWriter
		grw := &gzipResponseWriter{ResponseWriter: w, Writer: gz}
		w.Header().Set("Content-Encoding", "gzip")
		// Content-Length unknown after compression
		w.Header().Del("Content-Length")

		next.ServeHTTP(grw, r)
	})
}

type gzipResponseWriter struct {
	http.ResponseWriter
	*gzip.Writer
}

func (w *gzipResponseWriter) Write(b []byte) (int, error) {
	return w.Writer.Write(b)
}

func (w *gzipResponseWriter) Flush() {
	_ = w.Writer.Flush()
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Handlers

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
    response := Response{
        Success: true,
        Data: map[string]interface{}{
            "service": "Otedama Mining Pool",
            "status":  "running",
        },
        Time: time.Now(),
    }

    s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	response := Response{
		Success: true,
		Data:    s.stats,
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	response := Response{
		Success: true,
		Data: map[string]interface{}{
			"status": "healthy",
			"checks": map[string]bool{
				"api_server": true,
				"database":   true, // Placeholder
				"network":    true, // Placeholder
			},
		},
		Time: time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

// Mining handlers are implemented in handlers_mining.go

func (s *Server) handlePoolStats(w http.ResponseWriter, r *http.Request) {
	// Placeholder pool stats
	stats := map[string]interface{}{
		"peer_count":       0,
		"total_shares":     0,
		"blocks_found":     0,
		"total_hashrate":   0,
		"share_difficulty": 1000.0,
		"fee_percentage":   1.0,
	}

	response := Response{
		Success: true,
		Data:    stats,
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handlePoolPeers(w http.ResponseWriter, r *http.Request) {
	// Placeholder peers data
	peers := []map[string]interface{}{}

	response := Response{
		Success: true,
		Data:    peers,
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handlePoolShares(w http.ResponseWriter, r *http.Request) {
	// Placeholder shares data
	shares := []map[string]interface{}{}

	response := Response{
		Success: true,
		Data:    shares,
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleMiningWorkers(w http.ResponseWriter, r *http.Request) {
	// Placeholder workers data
	workers := []map[string]interface{}{
		{
			"id":          "worker-1",
			"name":        "CPU-Worker-1",
			"type":        "CPU",
			"hashrate":    125000,
			"temperature": 65,
			"power":       100,
			"status":      "active",
			"shares_accepted": 42,
			"shares_rejected": 2,
		},
	}

	response := Response{
		Success: true,
		Data:    workers,
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleWorkerControl(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	workerID := vars["id"]
	
	// Validate worker ID
	if err := s.validator.ValidateWorkerID(workerID); err != nil {
		s.sendError(w, http.StatusBadRequest, fmt.Sprintf("Invalid worker ID: %v", err))
		return
	}
	
	var req struct {
		Action string `json:"action"`
	}
	
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.sendError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	
	// Validate action
	if err := s.validator.ValidateAction(req.Action); err != nil {
		s.sendError(w, http.StatusBadRequest, fmt.Sprintf("Invalid action: %v", err))
		return
	}
	
	response := Response{
		Success: true,
		Data: map[string]interface{}{
			"worker_id": workerID,
			"action":    req.Action,
			"message":   fmt.Sprintf("Worker %s %s successful", workerID, req.Action),
		},
		Time: time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handlePoolInfo(w http.ResponseWriter, r *http.Request) {
	info := map[string]interface{}{
		"name":         "Otedama P2P Pool",
		"type":         "P2P",
		"fee":          1.0,
		"min_payout":   0.001,
		"payment_type": "PPLNS",
		"algorithms":   []string{"SHA256d", "Ethash", "KawPow", "RandomX", "Scrypt"},
	}

	response := Response{
		Success: true,
		Data:    info,
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

func (s *Server) handleStratumInfo(w http.ResponseWriter, r *http.Request) {
	info := map[string]interface{}{
		"enabled":     true,
		"port":        3333,
		"difficulty":  16384,
		"connections": 0,
		"protocols":   []string{"stratum+tcp", "stratum+ssl"},
	}

	response := Response{
		Success: true,
		Data:    info,
		Time:    time.Now(),
	}

	s.sendJSON(w, http.StatusOK, response)
}

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

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
    conn, err := s.upgrader.Upgrade(w, r, nil)
    if err != nil {
        s.logger.Error("WebSocket upgrade failed", zap.Error(err))
        return
    }
    defer conn.Close()

    // Connection settings
    const (
        writeWait  = 10 * time.Second
        pongWait   = 60 * time.Second
        pingPeriod = 50 * time.Second // < pongWait
    )

    conn.SetReadLimit(1 << 20) // 1MB
    _ = conn.SetReadDeadline(time.Now().Add(pongWait))
    conn.SetPongHandler(func(string) error {
        return conn.SetReadDeadline(time.Now().Add(pongWait))
    })

    // Track client
    s.clients[conn] = true
    s.wsMu[conn] = &sync.Mutex{}
    remote := conn.RemoteAddr().String()
    s.logger.Info("WebSocket client connected", zap.String("remote_addr", remote))

    // Ping loop
    done := make(chan struct{})
    ticker := time.NewTicker(pingPeriod)
    defer ticker.Stop()
    go func() {
        for {
            select {
            case <-ticker.C:
                // Serialize control frame write
                if mu, ok := s.wsMu[conn]; ok {
                    mu.Lock()
                    _ = conn.SetWriteDeadline(time.Now().Add(writeWait))
                    err = conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait))
                    mu.Unlock()
                } else {
                    _ = conn.SetWriteDeadline(time.Now().Add(writeWait))
                    err = conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait))
                }
                if err != nil {
                    s.logger.Debug("WebSocket ping failed", zap.Error(err))
                    _ = conn.Close()
                    close(done)
                    return
                }
            case <-done:
                return
            }
        }
    }()

    // Send initial stats
    s.sendStatsToClient(conn)

    // Handle messages
    for {
        // Simple per-connection rate limit using IP limiter
        if s.limiter != nil {
            ip := r.RemoteAddr
            if !s.limiter.Allow(ip) {
                s.logger.Debug("WS rate limited", zap.String("ip", ip))
                // small backoff instead of drop to reduce churn
                time.Sleep(100 * time.Millisecond)
            }
        }

        var msg map[string]interface{}
        if err := conn.ReadJSON(&msg); err != nil {
            s.logger.Debug("WebSocket client disconnected", zap.Error(err))
            break
        }

        s.handleWebSocketMessage(conn, msg)
    }

    // Cleanup
    close(done)
    delete(s.clients, conn)
    delete(s.wsMu, conn)
}

func (s *Server) handleWebSocketMessage(conn *websocket.Conn, msg map[string]interface{}) {
	msgType, ok := msg["type"].(string)
	if !ok {
		return
	}

	switch msgType {
	case "get_stats":
		s.sendStatsToClient(conn)
	case "ping":
		response := map[string]interface{}{
			"type": "pong",
			"time": time.Now(),
		}
		if err := s.safeWriteJSON(conn, response); err != nil {
			s.logger.Error("Failed to send WebSocket message", zap.Error(err))
		}
	}
}

func (s *Server) sendStatsToClient(conn *websocket.Conn) {
    message := map[string]interface{}{
        "type": "stats_update",
        "data": s.stats,
        "time": time.Now(),
    }

    if err := s.safeWriteJSON(conn, message); err != nil {
        s.logger.Error("Failed to send WebSocket message", zap.Error(err))
    }
}

// UpdateStats updates the cached statistics
func (s *Server) UpdateStats(stats map[string]interface{}) {
	s.stats = stats

	// Broadcast to WebSocket clients
	s.broadcastStats()
}

// broadcastStats sends stats to all connected WebSocket clients
func (s *Server) broadcastStats() {
    message := map[string]interface{}{
        "type": "stats_update",
        "data": s.stats,
        "time": time.Now(),
    }

    for client := range s.clients {
        if err := s.safeWriteJSON(client, message); err != nil {
            s.logger.Error("Failed to broadcast stats", zap.Error(err))
            client.Close()
            delete(s.clients, client)
            delete(s.wsMu, client)
        }
    }
}

// safeWriteJSON serializes writes per-connection to avoid concurrent writer races
func (s *Server) safeWriteJSON(conn *websocket.Conn, v interface{}) error {
    if mu, ok := s.wsMu[conn]; ok {
        mu.Lock()
        defer mu.Unlock()
    }
    _ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
    return conn.WriteJSON(v)
}

// sendJSON sends JSON response
func (s *Server) sendJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(data); err != nil {
		s.logger.Error("Failed to encode JSON response", zap.Error(err))
	}
}

// sendError sends error response
func (s *Server) sendError(w http.ResponseWriter, status int, message string) {
	response := Response{
		Success: false,
		Error:   message,
		Time:    time.Now(),
	}

	s.sendJSON(w, status, response)
}

// writeJSON writes JSON response (helper for algorithm routes)
func (s *Server) writeJSON(w http.ResponseWriter, status int, data interface{}) {
	s.sendJSON(w, status, data)
}

// writeError writes error response (helper for algorithm routes)
func (s *Server) writeError(w http.ResponseWriter, status int, message string) {
	s.sendError(w, status, message)
}
