package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"github.com/otedama/otedama/internal/config"
	"github.com/otedama/otedama/internal/logging"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"
)

// Server はAPIサーバー
type Server struct {
	config     config.APIConfig
	logger     *zap.Logger
	logManager *logging.Manager
	router     *mux.Router
	server     *http.Server
	upgrader   websocket.Upgrader
	wsClients  sync.Map
	stats      map[string]interface{}
	statsMu    sync.RWMutex
	
	// Rate limiting
	rateLimiter sync.Map // IP -> *ClientLimiter
}

// WSClient はWebSocketクライアント
type WSClient struct {
	conn   *websocket.Conn
	send   chan []byte
	server *Server
}

// Response はAPIレスポンス
type Response struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
}

// StatsResponse は統計レスポンス
type StatsResponse struct {
	Uptime      float64                `json:"uptime"`
	Mode        string                 `json:"mode"`
	Stats       map[string]interface{} `json:"stats"`
	Timestamp   int64                  `json:"timestamp"`
}

// ClientLimiter represents rate limiting for a single client
type ClientLimiter struct {
	tokens    int
	lastReset time.Time
	mutex     sync.Mutex
}

// NewServer は新しいAPIサーバーを作成
func NewServer(cfg config.APIConfig, logger *zap.Logger, logManager *logging.Manager) (*Server, error) {
	s := &Server{
		config:     cfg,
		logger:     logger,
		logManager: logManager,
		router:     mux.NewRouter(),
		stats:      make(map[string]interface{}),
	}
	
	// Initialize upgrader after server struct is created
	s.upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return s.checkOrigin(r)
		},
	}

	// ルート設定
	s.setupRoutes()

	// HTTPサーバー作成
	s.server = &http.Server{
		Addr:         cfg.ListenAddr,
		Handler:      s.router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
	
	// Start rate limiter cleanup goroutine
	go s.cleanupRateLimiter()

	return s, nil
}

// setupRoutes はルートを設定
func (s *Server) setupRoutes() {
	// Access logging middleware (first)
	s.router.Use(s.accessLoggingMiddleware)
	// CORS middleware
	s.router.Use(s.corsMiddleware)
	// Rate limiting middleware
	s.router.Use(s.rateLimitMiddleware)
	// ヘルスチェック
	s.router.HandleFunc("/health", s.handleHealth).Methods("GET")

	// API v1
	v1 := s.router.PathPrefix("/api/v1").Subrouter()
	
	// 統計情報
	v1.HandleFunc("/stats", s.handleStats).Methods("GET")
	v1.HandleFunc("/status", s.handleStatus).Methods("GET")
	
	// マイニング
	v1.HandleFunc("/mining/start", s.handleMiningStart).Methods("POST")
	v1.HandleFunc("/mining/stop", s.handleMiningStop).Methods("POST")
	v1.HandleFunc("/mining/status", s.handleMiningStatus).Methods("GET")
	
	// プール
	v1.HandleFunc("/pool/stats", s.handlePoolStats).Methods("GET")
	v1.HandleFunc("/pool/miners", s.handlePoolMiners).Methods("GET")
	
	// Stratum
	v1.HandleFunc("/stratum/stats", s.handleStratumStats).Methods("GET")
	
	// WebSocket
	s.router.HandleFunc("/ws", s.handleWebSocket)
	
	// Prometheusメトリクス
	s.router.Handle("/metrics", promhttp.Handler())
	
	// 静的ファイル
	s.router.PathPrefix("/").Handler(http.FileServer(http.Dir("./web")))
	
	// ミドルウェア
	s.router.Use(s.loggingMiddleware)
	s.router.Use(s.corsMiddleware)
	if s.config.RateLimit > 0 {
		s.router.Use(s.rateLimitMiddleware)
	}
}

// Start はAPIサーバーを開始
func (s *Server) Start(ctx context.Context) error {
	if !s.config.Enabled {
		s.logger.Info("API server disabled")
		return nil
	}

	// WebSocket ブロードキャスト開始
	go s.broadcastStats(ctx)

	// サーバー開始
	go func() {
		s.logger.Info("Starting API server",
			zap.String("listen_addr", s.config.ListenAddr),
			zap.Bool("tls_enabled", s.config.EnableTLS),
		)

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

// Shutdown はAPIサーバーをシャットダウン
func (s *Server) Shutdown(ctx context.Context) error {
	s.logger.Info("Shutting down API server")

	// WebSocketクライアントを閉じる
	s.wsClients.Range(func(key, value interface{}) bool {
		if client, ok := value.(*WSClient); ok {
			close(client.send)
		}
		return true
	})

	return s.server.Shutdown(ctx)
}

// UpdateStats は統計情報を更新
func (s *Server) UpdateStats(stats map[string]interface{}) {
	s.statsMu.Lock()
	s.stats = stats
	s.statsMu.Unlock()
}

// Handlers

// handleHealth はヘルスチェックを処理
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	s.sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data:    map[string]string{"status": "healthy"},
	})
}

// handleStats は統計情報を処理
func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	s.statsMu.RLock()
	stats := make(map[string]interface{})
	for k, v := range s.stats {
		stats[k] = v
	}
	s.statsMu.RUnlock()

	s.sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data: StatsResponse{
			Uptime:    time.Since(time.Now()).Seconds(), // TODO: 実際の開始時刻を使用
			Mode:      stats["mode"].(string),
			Stats:     stats,
			Timestamp: time.Now().Unix(),
		},
	})
}

// handleStatus はステータスを処理
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	s.statsMu.RLock()
	mode, _ := s.stats["mode"].(string)
	s.statsMu.RUnlock()

	s.sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data: map[string]interface{}{
			"running": true,
			"mode":    mode,
			"version": "1.0.0",
		},
	})
}

// handleMiningStart はマイニング開始を処理
func (s *Server) handleMiningStart(w http.ResponseWriter, r *http.Request) {
	// TODO: 実際のマイニング開始処理
	s.sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data:    map[string]string{"message": "Mining started"},
	})
}

// handleMiningStop はマイニング停止を処理
func (s *Server) handleMiningStop(w http.ResponseWriter, r *http.Request) {
	// TODO: 実際のマイニング停止処理
	s.sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data:    map[string]string{"message": "Mining stopped"},
	})
}

// handleMiningStatus はマイニングステータスを処理
func (s *Server) handleMiningStatus(w http.ResponseWriter, r *http.Request) {
	s.statsMu.RLock()
	hashRate, _ := s.stats["cpu_hashrate"].(uint64)
	s.statsMu.RUnlock()

	s.sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data: map[string]interface{}{
			"mining":   true,
			"hashrate": hashRate,
		},
	})
}

// handlePoolStats はプール統計を処理
func (s *Server) handlePoolStats(w http.ResponseWriter, r *http.Request) {
	s.statsMu.RLock()
	shares, _ := s.stats["pool_shares"].(uint64)
	blocks, _ := s.stats["pool_blocks"].(uint64)
	peers, _ := s.stats["pool_peers"].(int)
	s.statsMu.RUnlock()

	s.sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data: map[string]interface{}{
			"shares": shares,
			"blocks": blocks,
			"peers":  peers,
		},
	})
}

// handlePoolMiners はプールマイナーを処理
func (s *Server) handlePoolMiners(w http.ResponseWriter, r *http.Request) {
	// TODO: 実際のマイナーリスト取得
	s.sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data:    []interface{}{},
	})
}

// handleStratumStats はStratum統計を処理
func (s *Server) handleStratumStats(w http.ResponseWriter, r *http.Request) {
	s.statsMu.RLock()
	clients, _ := s.stats["stratum_clients"].(int32)
	jobs, _ := s.stats["stratum_jobs"].(uint64)
	s.statsMu.RUnlock()

	s.sendJSON(w, http.StatusOK, Response{
		Success: true,
		Data: map[string]interface{}{
			"clients": clients,
			"jobs":    jobs,
		},
	})
}

// handleWebSocket はWebSocket接続を処理
func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Error("WebSocket upgrade failed", zap.Error(err))
		return
	}

	client := &WSClient{
		conn:   conn,
		send:   make(chan []byte, 256),
		server: s,
	}

	clientID := fmt.Sprintf("%s-%d", conn.RemoteAddr().String(), time.Now().UnixNano())
	s.wsClients.Store(clientID, client)

	go client.writePump()
	go client.readPump(clientID)
}

// WebSocket client methods

func (c *WSClient) readPump(clientID string) {
	defer func() {
		c.server.wsClients.Delete(clientID)
		c.conn.Close()
	}()

	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, _, err := c.conn.ReadMessage()
		if err != nil {
			break
		}
	}
}

func (c *WSClient) writePump() {
	ticker := time.NewTicker(54 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			c.conn.WriteMessage(websocket.TextMessage, message)

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// broadcastStats は統計情報をブロードキャスト
func (s *Server) broadcastStats(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.statsMu.RLock()
			data, _ := json.Marshal(s.stats)
			s.statsMu.RUnlock()

			s.wsClients.Range(func(key, value interface{}) bool {
				if client, ok := value.(*WSClient); ok {
					select {
					case client.send <- data:
					default:
						// クライアントのキューがフルの場合はスキップ
					}
				}
				return true
			})
		}
	}
}

// Middleware

// loggingMiddleware はリクエストをログに記録
func (s *Server) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		
		next.ServeHTTP(w, r)
		
		s.logger.Debug("HTTP request",
			zap.String("method", r.Method),
			zap.String("path", r.URL.Path),
			zap.String("remote", r.RemoteAddr),
			zap.Duration("duration", time.Since(start)),
		)
	})
}

// corsMiddleware handles CORS requests
func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		
		// Check if origin is allowed
		if s.isOriginAllowed(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		
		// Set CORS headers
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Access-Control-Max-Age", "3600")
		
		// Handle preflight requests
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		
		next.ServeHTTP(w, r)
	})
}

// rateLimitMiddleware はレート制限を実装
func (s *Server) rateLimitMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.config.RateLimit <= 0 {
			// Rate limiting disabled
			next.ServeHTTP(w, r)
			return
		}
		
		clientIP := s.getClientIP(r)
		if s.isRateLimited(clientIP) {
			s.sendJSON(w, http.StatusTooManyRequests, Response{
				Success: false,
				Error:   "Rate limit exceeded. Please try again later.",
			})
			return
		}
		
		next.ServeHTTP(w, r)
	})
}

// getClientIP extracts the real client IP from request
func (s *Server) getClientIP(r *http.Request) string {
	// Check X-Forwarded-For header first (for proxied requests)
	xff := r.Header.Get("X-Forwarded-For")
	if xff != "" {
		// X-Forwarded-For can contain multiple IPs, use the first one
		ips := strings.Split(xff, ",")
		if len(ips) > 0 {
			return strings.TrimSpace(ips[0])
		}
	}
	
	// Check X-Real-IP header (for nginx proxy)
	xri := r.Header.Get("X-Real-IP")
	if xri != "" {
		return xri
	}
	
	// Fall back to RemoteAddr
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}

// isRateLimited checks if a client IP is rate limited
func (s *Server) isRateLimited(clientIP string) bool {
	now := time.Now()
	
	// Get or create limiter for this client
	limiterInterface, _ := s.rateLimiter.LoadOrStore(clientIP, &ClientLimiter{
		tokens:    s.config.RateLimit,
		lastReset: now,
	})
	
	limiter := limiterInterface.(*ClientLimiter)
	limiter.mutex.Lock()
	defer limiter.mutex.Unlock()
	
	// Reset tokens every minute
	if now.Sub(limiter.lastReset) >= time.Minute {
		limiter.tokens = s.config.RateLimit
		limiter.lastReset = now
	}
	
	// Check if tokens available
	if limiter.tokens <= 0 {
		return true // Rate limited
	}
	
	// Consume a token
	limiter.tokens--
	return false
}

// accessLoggingMiddleware logs all API access
func (s *Server) accessLoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		
		// Custom response writer to capture status code
		rw := &responseWriter{ResponseWriter: w, statusCode: 200}
		
		// Process request
		next.ServeHTTP(rw, r)
		
		// Log the request
		duration := time.Since(start)
		clientIP := s.getClientIP(r)
		userAgent := r.Header.Get("User-Agent")
		
		if s.logManager != nil {
			s.logManager.LogAPIAccess(
				clientIP,
				r.Method,
				r.URL.Path,
				userAgent,
				rw.statusCode,
				duration,
			)
		}
	})
}

// responseWriter wraps http.ResponseWriter to capture status code
type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

// cleanupRateLimiter periodically removes old rate limit entries to prevent memory leaks
func (s *Server) cleanupRateLimiter() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			now := time.Now()
			s.rateLimiter.Range(func(key, value interface{}) bool {
				limiter := value.(*ClientLimiter)
				limiter.mutex.Lock()
				
				// Remove entries that haven't been used in the last 10 minutes
				if now.Sub(limiter.lastReset) > 10*time.Minute {
					limiter.mutex.Unlock()
					s.rateLimiter.Delete(key)
				} else {
					limiter.mutex.Unlock()
				}
				return true
			})
		}
	}
}

// checkOrigin checks if the WebSocket origin is allowed
func (s *Server) checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		// Allow same-origin requests (no Origin header)
		return true
	}
	return s.isOriginAllowed(origin)
}

// isOriginAllowed checks if an origin is in the allowed list
func (s *Server) isOriginAllowed(origin string) bool {
	if len(s.config.AllowOrigins) == 0 {
		// If no specific origins configured, allow all
		return true
	}
	
	for _, allowedOrigin := range s.config.AllowOrigins {
		if allowedOrigin == "*" || allowedOrigin == origin {
			return true
		}
	}
	
	return false
}

// Utility methods

// sendJSON はJSONレスポンスを送信
func (s *Server) sendJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}