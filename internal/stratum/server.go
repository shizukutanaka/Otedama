package stratum

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	// "github.com/shizukutanaka/Otedama/internal/zkp" // Not used
	"go.uber.org/zap"
)

// Server defines the Stratum server interface following interface segregation principle.
// It provides the core functionality needed for Stratum protocol communication.
type Server interface {
	// Lifecycle management
	Start() error
	Stop() error
	
	// Configuration
	SetCallbacks(*Callbacks) error
	
	// Monitoring
	GetStats() *StratumStats
}

// Config contains comprehensive Stratum server configuration.
// All fields are validated to ensure proper server operation.
type Config struct {
	// Network settings
	Port       int    `validate:"min=1024,max=65535"` // Server listening port
	Host       string `validate:"required"`           // Server listening host
	MaxClients int    `validate:"min=1,max=100000"`   // Maximum concurrent clients
	
	// Protocol settings
	StratumVersion string        `validate:"required"`
	EnableTLS      bool
	CertFile       string
	KeyFile        string
	
	// Mining settings
	Difficulty     float64       `validate:"min=0.001"`
	VarDiff        bool
	MinDifficulty  float64       `validate:"min=0.001"`
	MaxDifficulty  float64       `validate:"min=1"`
	TargetTime     time.Duration `validate:"min=1s,max=60s"`
	
	// Performance settings
	ReadTimeout    time.Duration `validate:"min=5s,max=300s"`
	WriteTimeout   time.Duration `validate:"min=1s,max=60s"`
	BufferSize     int           `validate:"min=1024,max=65536"`
	
	// Security settings
	RateLimit      int           `validate:"min=1,max=10000"`
	MaxMessageSize int           `validate:"min=1024,max=1048576"`
	
	// Authentication settings
	AuthMode       AuthenticationMode
	Username       string
	Password       string
	Secret         string // For dynamic token generation
}

// Callbacks contains callback functions for Stratum protocol events.
// These allow the server to integrate with pool management logic.
type Callbacks struct {
	OnShare  func(*Share) error         // Called when a share is submitted
	OnGetJob func() *Job                // Called when a client requests work
	OnAuth   func(string, string) error // Called for client authentication
}

// StratumServer implements a high-performance Stratum mining protocol server.
// It focuses on:
// - Lock-free operations for hot paths
// - Efficient client management
// - Robust error handling
type StratumServer struct {
	logger *zap.Logger
	config *Config
	
	// Core state (optimized for concurrent access)
	stats   *StratumStats      // Server statistics
	running atomic.Bool // Running state flag
	
	// Callbacks
	callbacks  *Callbacks
	
	// Client management - lock-free where possible
	clients    sync.Map // map[string]*Client
	clientCount atomic.Int32
	
	// Job management
	currentJob atomic.Value // stores *Job
	jobCounter atomic.Uint64
	
	// Network
	listener   net.Listener
	
	// Rate limiting
	rateLimiter *StratumRateLimiter
	
	// Advanced difficulty adjustment
	difficultyAdjuster *DifficultyAdjuster
	
	// Reputation manager
	reputationManager *ReputationManager
	
	// Compliance checker
	complianceChecker *ComplianceChecker
	
	// Authentication
	authDatabase map[string]string // Simple in-memory auth database
	authMu       sync.RWMutex
	
	// Lifecycle
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

// StratumStats contains comprehensive Stratum server statistics.
// All fields use atomic types for lock-free concurrent access.
type StratumStats struct {
	// Connection statistics
	TotalConnections  atomic.Uint64 `json:"total_connections"`  // Total connections received
	ActiveConnections atomic.Int32  `json:"active_connections"` // Currently active connections
	AuthorizedClients atomic.Int32  `json:"authorized_clients"` // Currently authorized clients
	
	// Share statistics
	TotalShares        atomic.Uint64 `json:"total_shares"`
	AcceptedShares     atomic.Uint64 `json:"accepted_shares"`
	RejectedShares     atomic.Uint64 `json:"rejected_shares"`
	BlocksFound        atomic.Uint64 `json:"blocks_found"`
	
	// Job statistics
	JobsCreated        atomic.Uint64 `json:"jobs_created"`
	JobsDistributed    atomic.Uint64 `json:"jobs_distributed"`
	
	// Performance
	AvgResponseTime    atomic.Uint64 `json:"avg_response_time_ms"`
	NetworkHashRate    atomic.Uint64 `json:"network_hash_rate"`
	
	// Uptime
	StartTime          time.Time     `json:"start_time"`
}

// NewServer creates new Stratum server - Rob Pike's clear constructor
func NewServer(logger *zap.Logger, config *Config) (Server, error) {
	if config == nil {
		config = DefaultConfig()
	}
	
	if err := validateConfig(config); err != nil {
		return nil, fmt.Errorf("invalid config: %w", err)
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	server := &StratumServer{
		logger:    logger,
		config:    config,
		stats:     &StratumStats{StartTime: time.Now()},
		ctx:       ctx,
		cancel:    cancel,
	}
	
	// Initialize rate limiter
	server.rateLimiter = &StratumRateLimiter{
		maxRate: config.RateLimit,
		logger:  logger.With(zap.String("component", "rate_limiter")),
	}
	
	// Initialize advanced difficulty adjuster if VarDiff is enabled
	if config.VarDiff {
		diffConfig := DefaultDifficultyConfig()
		diffConfig.InitialDiff = config.Difficulty
		diffConfig.MinDiff = config.MinDifficulty
		diffConfig.MaxDiff = config.MaxDifficulty
		diffConfig.TargetTime = config.TargetTime.Seconds()
		server.difficultyAdjuster = NewDifficultyAdjuster(diffConfig)
	}
	
	// Initialize reputation manager
	server.reputationManager = NewReputationManager()
	
	// Initialize compliance checker
	server.complianceChecker = NewComplianceChecker()
	
	// Initialize authentication database
	server.authDatabase = make(map[string]string)
	
	// Initialize default job
	server.currentJob.Store(&Job{
		ID:        "default",
		CleanJobs: false,
		CreatedAt: time.Now(),
	})
	
	return server, nil
}

// Start starts the Stratum server
func (s *StratumServer) Start() error {
	if !s.running.CompareAndSwap(false, true) {
		return errors.New("server already running")
	}
	
	s.logger.Info("Starting Stratum server",
		zap.String("address", fmt.Sprintf("%s:%d", s.config.Host, s.config.Port)),
		zap.Int("max_clients", s.config.MaxClients),
		zap.Bool("var_diff", s.config.VarDiff),
	)
	
	// Start listener
	if err := s.startListener(); err != nil {
		s.running.Store(false)
		return fmt.Errorf("failed to start listener: %w", err)
	}
	
	// Start job broadcaster
	s.wg.Add(1)
	go s.jobBroadcaster()
	
	// Start statistics updater
	s.wg.Add(1)
	go s.statsUpdater()
	
	// Start client cleaner
	s.wg.Add(1)
	go s.clientCleaner()
	
	// Start difficulty adjuster if enabled
	if s.config.VarDiff {
		s.wg.Add(1)
		go s.difficultyAdjusterLoop()
	}
	
	s.logger.Info("Stratum server started successfully")
	return nil
}

// Stop stops the Stratum server
func (s *StratumServer) Stop() error {
	if !s.running.CompareAndSwap(true, false) {
		return errors.New("server not running")
	}
	
	s.logger.Info("Stopping Stratum server")
	
	// Cancel context
	s.cancel()
	
	// Close listener
	if s.listener != nil {
		s.listener.Close()
	}
	
	// Close all client connections
	s.closeAllClients()
	
	// Wait for goroutines
	s.wg.Wait()
	
	s.logger.Info("Stratum server stopped")
	return nil
}

// SetCallbacks sets callback functions
func (s *StratumServer) SetCallbacks(callbacks *Callbacks) error {
	if callbacks == nil {
		return errors.New("callbacks cannot be nil")
	}
	
	s.callbacks = callbacks
	s.logger.Debug("Stratum callbacks set")
	return nil
}

// GetStats returns server statistics
func (s *StratumServer) GetStats() *StratumStats {
	stats := &StratumStats{
		StartTime: s.stats.StartTime,
	}
	
	// Copy atomic values
	stats.TotalConnections.Store(s.stats.TotalConnections.Load())
	stats.ActiveConnections.Store(s.clientCount.Load())
	stats.TotalShares.Store(s.stats.TotalShares.Load())
	stats.AcceptedShares.Store(s.stats.AcceptedShares.Load())
	stats.RejectedShares.Store(s.stats.RejectedShares.Load())
	stats.BlocksFound.Store(s.stats.BlocksFound.Load())
	stats.JobsCreated.Store(s.stats.JobsCreated.Load())
	stats.JobsDistributed.Store(s.stats.JobsDistributed.Load())
	stats.AvgResponseTime.Store(s.stats.AvgResponseTime.Load())
	stats.NetworkHashRate.Store(s.stats.NetworkHashRate.Load())
	
	// Count authorized clients
	var authorizedCount int32
	s.clients.Range(func(key, value interface{}) bool {
		client := value.(*Client)
		if client.Authorized.Load() {
			authorizedCount++
		}
		return true
	})
	stats.AuthorizedClients.Store(authorizedCount)
	
	return stats
}

// Private methods

func (s *StratumServer) startListener() error {
	addr := fmt.Sprintf("%s:%d", s.config.Host, s.config.Port)
	
	var listener net.Listener
	var err error
	
	if s.config.EnableTLS {
		// TLS listener would be implemented here
		return errors.New("TLS not implemented yet")
	} else {
		listener, err = net.Listen("tcp", addr)
		if err != nil {
			return fmt.Errorf("failed to listen on %s: %w", addr, err)
		}
	}
	
	s.listener = listener
	
	// Accept connections
	go s.acceptConnections()
	
	return nil
}

func (s *StratumServer) acceptConnections() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.ctx.Done():
				return
			default:
				s.logger.Error("Accept failed", zap.Error(err))
				continue
			}
		}
		
		// Check client limit
		if s.clientCount.Load() >= int32(s.config.MaxClients) {
			s.logger.Debug("Client limit reached, rejecting connection")
			conn.Close()
			continue
		}
		
		// Handle new client
		go s.handleClient(conn)
	}
}

func (s *StratumServer) jobBroadcaster() {
	defer s.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			s.broadcastNewJob()
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *StratumServer) broadcastNewJob() {
	// Get new job from callback
	var job *Job
	if s.callbacks != nil && s.callbacks.OnGetJob != nil {
		job = s.callbacks.OnGetJob()
	}
	
	if job == nil {
		return
	}
	
	// Update current job
	s.currentJob.Store(job)
	s.stats.JobsCreated.Add(1)
	
	// Broadcast to all authorized clients
	s.clients.Range(func(key, value interface{}) bool {
		client := value.(*Client)
		if client.Authorized.Load() && client.Connected.Load() {
			s.sendJob(client, job, true)
		}
		return true
	})
	
	s.logger.Debug("Broadcasted new job", zap.String("job_id", job.ID))
}

func (s *StratumServer) statsUpdater() {
	defer s.wg.Done()
	
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			s.updateNetworkHashRate()
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *StratumServer) updateNetworkHashRate() {
	var totalHashRate uint64
	
	s.clients.Range(func(key, value interface{}) bool {
		client := value.(*Client)
		if client.Authorized.Load() {
			hashRate := client.CurrentHashRate.Load()
			totalHashRate += hashRate
		}
		return true
	})
	
	s.stats.NetworkHashRate.Store(totalHashRate)
}

func (s *StratumServer) clientCleaner() {
	defer s.wg.Done()
	
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			s.cleanupStaleClients()
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *StratumServer) cleanupStaleClients() {
	now := time.Now().Unix()
	staleThreshold := int64(300) // 5 minutes
	
	s.clients.Range(func(key, value interface{}) bool {
		client := value.(*Client)
		
		if now-client.LastActivity.Load() > staleThreshold {
			s.logger.Debug("Removing stale client", zap.String("client_id", client.ID))
			client.conn.Close()
		}
		
		return true
	})
}

func (s *StratumServer) difficultyAdjusterLoop() {
	defer s.wg.Done()
	
	ticker := time.NewTicker(s.config.TargetTime)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			s.adjustDifficulties()
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *StratumServer) closeAllClients() {
	s.clients.Range(func(key, value interface{}) bool {
		client := value.(*Client)
		client.conn.Close()
		return true
	})
}

func (s *StratumServer) updateAvgResponseTime(duration time.Duration) {
	ms := uint64(duration.Milliseconds())
	
	current := s.stats.AvgResponseTime.Load()
	if current == 0 {
		s.stats.AvgResponseTime.Store(ms)
	} else {
		// Exponential moving average
		newAvg := (current*9 + ms) / 10
		s.stats.AvgResponseTime.Store(newAvg)
	}
}

// Utility functions

func validateConfig(config *Config) error {
	if config.Port < 1024 || config.Port > 65535 {
		return errors.New("invalid port")
	}
	
	if config.MaxClients < 1 || config.MaxClients > 100000 {
		return errors.New("invalid max clients")
	}
	
	if config.Difficulty < 0.001 {
		return errors.New("invalid difficulty")
	}
	
	return nil
}

// DefaultConfig returns default Stratum configuration
func DefaultConfig() *Config {
	return &Config{
		Port:           3333,
		Host:           "0.0.0.0",
		MaxClients:     10000,
		StratumVersion: "EthereumStratum/1.0.0",
		EnableTLS:      false,
		Difficulty:     1.0,
		VarDiff:        true,
		MinDifficulty:  0.001,
		MaxDifficulty:  1000000.0,
		TargetTime:     15 * time.Second,
		ReadTimeout:    300 * time.Second,
		WriteTimeout:   30 * time.Second,
		BufferSize:     4096,
		RateLimit:      100,
		MaxMessageSize: 64 * 1024,
		AuthMode:       AuthModeNone,
	}
}

func generateClientID() string {
	return fmt.Sprintf("client_%d", time.Now().UnixNano())
}

func calculateShareRate(client *Client) float64 {
	// Simplified share rate calculation
	shares := client.SharesSubmitted.Load()
	duration := time.Since(client.ConnectedAt).Seconds()
	
	if duration < 60 {
		return 0.1 // Default for new clients
	}
	
	return float64(shares) / duration
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}
