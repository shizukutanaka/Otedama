package monitoring

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/shizukutanaka/Otedama/internal/config"
	"go.uber.org/zap"
)

// Server provides monitoring and metrics server
type Server struct {
	logger *zap.Logger
	config config.MonitoringConfig
	
	// HTTP server
	server   *http.Server
	router   *mux.Router
	
	// WebSocket
	upgrader websocket.Upgrader
	clients  map[*websocket.Conn]bool
	clientMu sync.RWMutex
	
	// Metrics collection
	collector *MetricsCollector
	
	// Statistics
	stats    *Statistics
	
	// State
	running  atomic.Bool
	ctx      context.Context
	cancel   context.CancelFunc
}

// MetricsCollector collects system metrics
type MetricsCollector struct {
	// Mining metrics
	hashRate         *prometheus.GaugeVec
	sharesSubmitted  *prometheus.CounterVec
	sharesAccepted   *prometheus.CounterVec
	sharesRejected   *prometheus.CounterVec
	blocksFound      *prometheus.CounterVec
	
	// Worker metrics
	activeWorkers    prometheus.Gauge
	workerHashRate   *prometheus.GaugeVec
	
	// Pool metrics
	poolDifficulty   prometheus.Gauge
	poolConnections  prometheus.Gauge
	
	// System metrics
	cpuUsage         prometheus.Gauge
	memoryUsage      prometheus.Gauge
	goroutines       prometheus.Gauge
	
	// Network metrics
	networkBytesIn   prometheus.Counter
	networkBytesOut  prometheus.Counter
	peersConnected   prometheus.Gauge
	
	// Custom metrics storage
	customMetrics    map[string]interface{}
	customMu         sync.RWMutex
}

// Statistics holds real-time statistics
type Statistics struct {
	// Mining stats
	HashRate        atomic.Uint64 `json:"hashrate"`
	SharesSubmitted atomic.Uint64 `json:"shares_submitted"`
	SharesAccepted  atomic.Uint64 `json:"shares_accepted"`
	SharesRejected  atomic.Uint64 `json:"shares_rejected"`
	BlocksFound     atomic.Uint64 `json:"blocks_found"`
	
	// Worker stats
	ActiveWorkers   atomic.Int32  `json:"active_workers"`
	TotalWorkers    atomic.Int32  `json:"total_workers"`
	
	// Pool stats
	Difficulty      atomic.Uint64 `json:"difficulty"`
	Connections     atomic.Int32  `json:"connections"`
	
	// System stats
	Uptime          time.Duration `json:"uptime"`
	StartTime       time.Time     `json:"start_time"`
	
	// Network stats
	BytesReceived   atomic.Uint64 `json:"bytes_received"`
	BytesSent       atomic.Uint64 `json:"bytes_sent"`
	PeersConnected  atomic.Int32  `json:"peers_connected"`
}

// MetricsSnapshot represents a point-in-time metrics snapshot
type MetricsSnapshot struct {
	Timestamp       time.Time              `json:"timestamp"`
	HashRate        float64                `json:"hashrate"`
	Workers         int                    `json:"workers"`
	SharesPerMinute float64                `json:"shares_per_minute"`
	Difficulty      float64                `json:"difficulty"`
	System          SystemMetrics          `json:"system"`
	Custom          map[string]interface{} `json:"custom,omitempty"`
}

// SystemMetrics contains system resource metrics
type SystemMetrics struct {
	CPUPercent      float64 `json:"cpu_percent"`
	MemoryUsed      uint64  `json:"memory_used"`
	MemoryPercent   float64 `json:"memory_percent"`
	Goroutines      int     `json:"goroutines"`
	GCPauses        uint32  `json:"gc_pauses"`
	HeapAlloc       uint64  `json:"heap_alloc"`
	HeapSys         uint64  `json:"heap_sys"`
}

// NewServer creates a new monitoring server
func NewServer(logger *zap.Logger, config config.MonitoringConfig) *Server {
	ctx, cancel := context.WithCancel(context.Background())
	
	s := &Server{
		logger:   logger,
		config:   config,
		router:   mux.NewRouter(),
		clients:  make(map[*websocket.Conn]bool),
		stats:    &Statistics{StartTime: time.Now()},
		ctx:      ctx,
		cancel:   cancel,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return true // Allow all origins in development
			},
		},
	}
	
	// Initialize metrics collector
	s.collector = s.initMetricsCollector()
	
	// Register Prometheus metrics
	s.registerPrometheusMetrics()
	
	// Setup routes
	s.setupRoutes()
	
	return s
}

// initMetricsCollector initializes the metrics collector
func (s *Server) initMetricsCollector() *MetricsCollector {
	return &MetricsCollector{
		// Mining metrics
		hashRate: prometheus.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "otedama_hashrate",
				Help: "Current hash rate",
			},
			[]string{"algorithm"},
		),
		sharesSubmitted: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "otedama_shares_submitted_total",
				Help: "Total shares submitted",
			},
			[]string{"worker"},
		),
		sharesAccepted: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "otedama_shares_accepted_total",
				Help: "Total shares accepted",
			},
			[]string{"worker"},
		),
		sharesRejected: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "otedama_shares_rejected_total",
				Help: "Total shares rejected",
			},
			[]string{"worker", "reason"},
		),
		blocksFound: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "otedama_blocks_found_total",
				Help: "Total blocks found",
			},
			[]string{"currency"},
		),
		
		// Worker metrics
		activeWorkers: prometheus.NewGauge(
			prometheus.GaugeOpts{
				Name: "otedama_active_workers",
				Help: "Number of active workers",
			},
		),
		workerHashRate: prometheus.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "otedama_worker_hashrate",
				Help: "Worker hash rate",
			},
			[]string{"worker"},
		),
		
		// Pool metrics
		poolDifficulty: prometheus.NewGauge(
			prometheus.GaugeOpts{
				Name: "otedama_pool_difficulty",
				Help: "Current pool difficulty",
			},
		),
		poolConnections: prometheus.NewGauge(
			prometheus.GaugeOpts{
				Name: "otedama_pool_connections",
				Help: "Number of pool connections",
			},
		),
		
		// System metrics
		cpuUsage: prometheus.NewGauge(
			prometheus.GaugeOpts{
				Name: "otedama_cpu_usage_percent",
				Help: "CPU usage percentage",
			},
		),
		memoryUsage: prometheus.NewGauge(
			prometheus.GaugeOpts{
				Name: "otedama_memory_usage_bytes",
				Help: "Memory usage in bytes",
			},
		),
		goroutines: prometheus.NewGauge(
			prometheus.GaugeOpts{
				Name: "otedama_goroutines",
				Help: "Number of goroutines",
			},
		),
		
		// Network metrics
		networkBytesIn: prometheus.NewCounter(
			prometheus.CounterOpts{
				Name: "otedama_network_bytes_received_total",
				Help: "Total bytes received",
			},
		),
		networkBytesOut: prometheus.NewCounter(
			prometheus.CounterOpts{
				Name: "otedama_network_bytes_sent_total",
				Help: "Total bytes sent",
			},
		),
		peersConnected: prometheus.NewGauge(
			prometheus.GaugeOpts{
				Name: "otedama_peers_connected",
				Help: "Number of connected peers",
			},
		),
		
		customMetrics: make(map[string]interface{}),
	}
}

// registerPrometheusMetrics registers metrics with Prometheus
func (s *Server) registerPrometheusMetrics() {
	prometheus.MustRegister(
		s.collector.hashRate,
		s.collector.sharesSubmitted,
		s.collector.sharesAccepted,
		s.collector.sharesRejected,
		s.collector.blocksFound,
		s.collector.activeWorkers,
		s.collector.workerHashRate,
		s.collector.poolDifficulty,
		s.collector.poolConnections,
		s.collector.cpuUsage,
		s.collector.memoryUsage,
		s.collector.goroutines,
		s.collector.networkBytesIn,
		s.collector.networkBytesOut,
		s.collector.peersConnected,
	)
}

// setupRoutes sets up HTTP routes
func (s *Server) setupRoutes() {
	// API routes
	api := s.router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/stats", s.handleStats).Methods("GET")
	api.HandleFunc("/metrics", s.handleMetrics).Methods("GET")
	api.HandleFunc("/workers", s.handleWorkers).Methods("GET")
	api.HandleFunc("/history", s.handleHistory).Methods("GET")
	api.HandleFunc("/health", s.handleHealth).Methods("GET")
	
	// WebSocket endpoint
	s.router.HandleFunc("/ws", s.handleWebSocket)
	
	// Prometheus metrics endpoint
	if s.config.Prometheus {
		s.router.Handle("/metrics", promhttp.Handler())
	}
	
	// Dashboard (if enabled)
	if s.config.EnableDashboard {
		s.router.PathPrefix("/").Handler(http.FileServer(http.Dir("./web/dashboard/")))
	}
}

// Start starts the monitoring server
func (s *Server) Start() error {
	if !s.running.CompareAndSwap(false, true) {
		return fmt.Errorf("monitoring server already running")
	}
	
	s.server = &http.Server{
		Addr:    s.config.ListenAddr,
		Handler: s.router,
	}
	
	// Start metrics collection
	go s.collectMetrics()
	
	// Start WebSocket broadcaster
	go s.broadcastMetrics()
	
	// Start HTTP server
	go func() {
		s.logger.Info("Starting monitoring server", zap.String("addr", s.config.ListenAddr))
		if err := s.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			s.logger.Error("Monitoring server error", zap.Error(err))
		}
	}()
	
	return nil
}

// Stop stops the monitoring server
func (s *Server) Stop() error {
	if !s.running.CompareAndSwap(true, false) {
		return fmt.Errorf("monitoring server not running")
	}
	
	s.cancel()
	
	// Close WebSocket connections
	s.clientMu.Lock()
	for client := range s.clients {
		client.Close()
	}
	s.clientMu.Unlock()
	
	// Shutdown HTTP server
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	
	return s.server.Shutdown(ctx)
}

// collectMetrics continuously collects system metrics
func (s *Server) collectMetrics() {
	ticker := time.NewTicker(s.config.MetricsInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.updateSystemMetrics()
		}
	}
}

// updateSystemMetrics updates system metrics
func (s *Server) updateSystemMetrics() {
	// Update system metrics
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	s.collector.memoryUsage.Set(float64(m.Alloc))
	s.collector.goroutines.Set(float64(runtime.NumGoroutine()))
	
	// Update uptime
	s.stats.Uptime = time.Since(s.stats.StartTime)
	
	// Update Prometheus metrics from stats
	s.collector.hashRate.WithLabelValues("current").Set(float64(s.stats.HashRate.Load()))
	s.collector.activeWorkers.Set(float64(s.stats.ActiveWorkers.Load()))
	s.collector.poolDifficulty.Set(float64(s.stats.Difficulty.Load()))
	s.collector.poolConnections.Set(float64(s.stats.Connections.Load()))
	s.collector.peersConnected.Set(float64(s.stats.PeersConnected.Load()))
}

// broadcastMetrics broadcasts metrics to WebSocket clients
func (s *Server) broadcastMetrics() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			snapshot := s.GetSnapshot()
			data, err := json.Marshal(snapshot)
			if err != nil {
				continue
			}
			
			s.clientMu.RLock()
			for client := range s.clients {
				client.WriteMessage(websocket.TextMessage, data)
			}
			s.clientMu.RUnlock()
		}
	}
}

// GetSnapshot returns current metrics snapshot
func (s *Server) GetSnapshot() *MetricsSnapshot {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	s.collector.customMu.RLock()
	customMetrics := make(map[string]interface{})
	for k, v := range s.collector.customMetrics {
		customMetrics[k] = v
	}
	s.collector.customMu.RUnlock()
	
	return &MetricsSnapshot{
		Timestamp:       time.Now(),
		HashRate:        float64(s.stats.HashRate.Load()),
		Workers:         int(s.stats.ActiveWorkers.Load()),
		SharesPerMinute: s.calculateSharesPerMinute(),
		Difficulty:      float64(s.stats.Difficulty.Load()),
		System: SystemMetrics{
			MemoryUsed:    m.Alloc,
			MemoryPercent: float64(m.Alloc) / float64(m.Sys) * 100,
			Goroutines:    runtime.NumGoroutine(),
			GCPauses:      m.NumGC,
			HeapAlloc:     m.HeapAlloc,
			HeapSys:       m.HeapSys,
		},
		Custom: customMetrics,
	}
}

// calculateSharesPerMinute calculates shares per minute
func (s *Server) calculateSharesPerMinute() float64 {
	uptime := time.Since(s.stats.StartTime).Minutes()
	if uptime == 0 {
		return 0
	}
	
	totalShares := s.stats.SharesSubmitted.Load()
	return float64(totalShares) / uptime
}

// HTTP handlers

// handleStats handles stats API endpoint
func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	stats := map[string]interface{}{
		"hashrate":         s.stats.HashRate.Load(),
		"shares_submitted": s.stats.SharesSubmitted.Load(),
		"shares_accepted":  s.stats.SharesAccepted.Load(),
		"shares_rejected":  s.stats.SharesRejected.Load(),
		"blocks_found":     s.stats.BlocksFound.Load(),
		"active_workers":   s.stats.ActiveWorkers.Load(),
		"difficulty":       s.stats.Difficulty.Load(),
		"uptime":           s.stats.Uptime.String(),
		"peers_connected":  s.stats.PeersConnected.Load(),
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

// handleMetrics handles metrics API endpoint
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	snapshot := s.GetSnapshot()
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(snapshot)
}

// handleWorkers handles workers API endpoint
func (s *Server) handleWorkers(w http.ResponseWriter, r *http.Request) {
	// This would fetch worker data from the database or memory
	workers := []map[string]interface{}{
		// Example worker data
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(workers)
}

// handleHistory handles history API endpoint
func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	// This would fetch historical data
	history := []map[string]interface{}{
		// Example historical data
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(history)
}

// handleHealth handles health check endpoint
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	health := map[string]interface{}{
		"status":  "healthy",
		"uptime":  s.stats.Uptime.String(),
		"version": "2.1.5",
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(health)
}

// handleWebSocket handles WebSocket connections
func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Error("WebSocket upgrade error", zap.Error(err))
		return
	}
	defer conn.Close()
	
	// Register client
	s.clientMu.Lock()
	s.clients[conn] = true
	s.clientMu.Unlock()
	
	// Unregister on disconnect
	defer func() {
		s.clientMu.Lock()
		delete(s.clients, conn)
		s.clientMu.Unlock()
	}()
	
	// Keep connection alive
	for {
		select {
		case <-s.ctx.Done():
			return
		default:
			// Read message (to detect disconnection)
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}
}

// Public methods for updating metrics

// UpdateHashRate updates the hash rate
func (s *Server) UpdateHashRate(hashRate uint64) {
	s.stats.HashRate.Store(hashRate)
	s.collector.hashRate.WithLabelValues("current").Set(float64(hashRate))
}

// UpdateWorkerCount updates the worker count
func (s *Server) UpdateWorkerCount(count int32) {
	s.stats.ActiveWorkers.Store(count)
	s.collector.activeWorkers.Set(float64(count))
}

// UpdateDifficulty updates the difficulty
func (s *Server) UpdateDifficulty(difficulty uint64) {
	s.stats.Difficulty.Store(difficulty)
	s.collector.poolDifficulty.Set(float64(difficulty))
}

// IncrementSharesSubmitted increments shares submitted
func (s *Server) IncrementSharesSubmitted(worker string) {
	s.stats.SharesSubmitted.Add(1)
	s.collector.sharesSubmitted.WithLabelValues(worker).Inc()
}

// IncrementSharesAccepted increments shares accepted
func (s *Server) IncrementSharesAccepted(worker string) {
	s.stats.SharesAccepted.Add(1)
	s.collector.sharesAccepted.WithLabelValues(worker).Inc()
}

// IncrementSharesRejected increments shares rejected
func (s *Server) IncrementSharesRejected(worker, reason string) {
	s.stats.SharesRejected.Add(1)
	s.collector.sharesRejected.WithLabelValues(worker, reason).Inc()
}

// IncrementBlocksFound increments blocks found
func (s *Server) IncrementBlocksFound(currency string) {
	s.stats.BlocksFound.Add(1)
	s.collector.blocksFound.WithLabelValues(currency).Inc()
}

// UpdateNetworkStats updates network statistics
func (s *Server) UpdateNetworkStats(bytesIn, bytesOut uint64, peers int32) {
	s.stats.BytesReceived.Store(bytesIn)
	s.stats.BytesSent.Store(bytesOut)
	s.stats.PeersConnected.Store(peers)
	
	s.collector.networkBytesIn.Add(float64(bytesIn))
	s.collector.networkBytesOut.Add(float64(bytesOut))
	s.collector.peersConnected.Set(float64(peers))
}

// SetCustomMetric sets a custom metric
func (s *Server) SetCustomMetric(key string, value interface{}) {
	s.collector.customMu.Lock()
	s.collector.customMetrics[key] = value
	s.collector.customMu.Unlock()
}

// GetCustomMetric gets a custom metric
func (s *Server) GetCustomMetric(key string) (interface{}, bool) {
	s.collector.customMu.RLock()
	defer s.collector.customMu.RUnlock()
	
	value, exists := s.collector.customMetrics[key]
	return value, exists
}