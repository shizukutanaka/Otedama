package security

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
	"golang.org/x/time/rate"
)

// DDoSProtection implements comprehensive DDoS protection with advanced features
// Following security best practices from OWASP and enterprise-grade implementations
type DDoSProtection struct {
	logger             *zap.Logger
	config             DDoSConfig
	
	// Rate limiting
	ipLimiters         sync.Map // IP -> *IPLimiter
	globalLimiter      *rate.Limiter
	
	// Connection tracking
	connectionTracker  *ConnectionTracker
	
	// Detection systems
	patternDetector    *PatternDetector
	anomalyDetector    *NetworkAnomalyDetector
	
	// Protection systems
	challengeManager   *ChallengeManager
	mitigationEngine   *MitigationEngine
	
	// Intelligence
	threatIntelligence *ThreatIntelligence
	geoBlocker         *GeoBlocker
	
	// Lists
	whitelist          *IPList
	blacklist          *IPList
	
	// Metrics
	stats              *DDoSStats
	
	// State
	running            atomic.Bool
	ctx                context.Context
	cancel             context.CancelFunc
	mu                 sync.RWMutex
}

// DDoSConfig contains comprehensive DDoS protection configuration
type DDoSConfig struct {
	// Basic rate limiting
	RequestsPerSecond      int           `yaml:"requests_per_second"`
	BurstSize             int           `yaml:"burst_size"`
	ConnectionLimit       int           `yaml:"connection_limit"`
	IPConnectionLimit     int           `yaml:"ip_connection_limit"`
	
	// Advanced rate limiting
	RequestSizeLimit      int64         `yaml:"request_size_limit"`
	HeaderSizeLimit       int           `yaml:"header_size_limit"`
	RequestTimeout        time.Duration `yaml:"request_timeout"`
	
	// Thresholds
	SuspiciousThreshold   int           `yaml:"suspicious_threshold"`
	BlockingThreshold     int           `yaml:"blocking_threshold"`
	AnomalyThreshold      float64       `yaml:"anomaly_threshold"`
	
	// Durations
	BlockDuration         time.Duration `yaml:"block_duration"`
	ChallengeExpiry       time.Duration `yaml:"challenge_expiry"`
	CleanupInterval       time.Duration `yaml:"cleanup_interval"`
	
	// Protection features
	EnableChallenge       bool          `yaml:"enable_challenge"`
	EnablePatternDetection bool         `yaml:"enable_pattern_detection"`
	EnableMLDetection     bool          `yaml:"enable_ml_detection"`
	EnableGeoBlocking     bool          `yaml:"enable_geo_blocking"`
	
	// Specific attack protection
	EnableSYNFloodProtection      bool `yaml:"enable_syn_flood_protection"`
	EnableSlowlorisProtection     bool `yaml:"enable_slowloris_protection"`
	EnableAmplificationProtection bool `yaml:"enable_amplification_protection"`
	EnableHTTPFloodProtection     bool `yaml:"enable_http_flood_protection"`
	
	// Challenge configuration
	ChallengeType         string        `yaml:"challenge_type"` // "proof_of_work", "captcha", "javascript"
	ChallengeDifficulty   int           `yaml:"challenge_difficulty"`
	MaxChallengeRetries   int           `yaml:"max_challenge_retries"`
	
	// Lists
	WhitelistedIPs        []string      `yaml:"whitelisted_ips"`
	WhitelistedCountries  []string      `yaml:"whitelisted_countries"`
	BlacklistedIPs        []string      `yaml:"blacklisted_ips"`
	BlacklistedCountries  []string      `yaml:"blacklisted_countries"`
	BlockedUserAgents     []string      `yaml:"blocked_user_agents"`
	BlockedASNs           []int         `yaml:"blocked_asns"`
}

// IPLimiter tracks rate limiting and statistics for an IP
type IPLimiter struct {
	IP               string
	limiter          *rate.Limiter
	connections      atomic.Int32
	suspiciousCount  atomic.Int32
	totalRequests    atomic.Uint64
	failedChallenges atomic.Int32
	lastActivity     atomic.Int64
	challengePassed  atomic.Bool
	blocked          atomic.Bool
	blockExpiry      atomic.Int64
	reputation       atomic.Int32
	mu               sync.Mutex
}

// ConnectionTracker tracks active connections
type ConnectionTracker struct {
	connections sync.Map // connID -> *TrackedConnection
	ipCounts    sync.Map // IP -> count
	totalActive atomic.Int64
	mu          sync.RWMutex
}

// TrackedConnection represents a tracked connection
type TrackedConnection struct {
	ID            string
	IP            string
	Port          int
	Protocol      string
	StartTime     time.Time
	LastActivity  time.Time
	RequestCount  atomic.Uint64
	BytesReceived atomic.Uint64
	BytesSent     atomic.Uint64
	Flags         atomic.Uint32
	Score         atomic.Int32
	Suspicious    atomic.Bool
	Challenged    atomic.Bool
}

// PatternDetector detects suspicious patterns
type PatternDetector struct {
	patterns      map[string]*Pattern
	ipHistory     sync.Map // IP -> *IPHistory
	anomalyScores sync.Map // IP -> float64
	mu            sync.RWMutex
}

// Pattern represents a suspicious behavior pattern
type Pattern struct {
	ID          string
	Name        string
	Description string
	Detector    func(*IPHistory) bool
	Score       float64
	Action      string // "monitor", "challenge", "block"
}

// IPHistory tracks request history for pattern detection
type IPHistory struct {
	IP              string
	Requests        []RequestInfo
	ConnectionTimes []time.Time
	UserAgents      map[string]int
	Endpoints       map[string]int
	mu              sync.RWMutex
}

// RequestInfo stores information about a request
type RequestInfo struct {
	Timestamp time.Time
	Method    string
	Path      string
	Size      int64
	UserAgent string
	Headers   map[string]string
}

// DDoSStats tracks DDoS protection statistics
type DDoSStats struct {
	TotalRequests       atomic.Uint64
	BlockedRequests     atomic.Uint64
	ChallengedRequests  atomic.Uint64
	PassedChallenges    atomic.Uint64
	FailedChallenges    atomic.Uint64
	ActiveConnections   atomic.Int64
	BlockedIPs          atomic.Int64
	DetectedAttacks     atomic.Uint64
	FalsePositives      atomic.Uint64
}

// NewDDoSProtection creates a new DDoS protection system
func NewDDoSProtection(config DDoSConfig, logger *zap.Logger) *DDoSProtection {
	// Set conservative defaults for production
	if config.RequestsPerSecond <= 0 {
		config.RequestsPerSecond = 10 // More conservative for mining operations
	}
	if config.BurstSize <= 0 {
		config.BurstSize = config.RequestsPerSecond * 2
	}
	if config.ConnectionLimit <= 0 {
		config.ConnectionLimit = 1000 // Reduced from 10000
	}
	if config.IPConnectionLimit <= 0 {
		config.IPConnectionLimit = 100
	}
	if config.BlockDuration <= 0 {
		config.BlockDuration = 1 * time.Hour
	}
	if config.CleanupInterval <= 0 {
		config.CleanupInterval = 5 * time.Minute
	}
	
	ddos := &DDoSProtection{
		logger:             logger,
		config:             config,
		globalLimiter:      rate.NewLimiter(rate.Limit(config.RequestsPerSecond), config.BurstSize),
		connectionTracker:  NewConnectionTracker(),
		patternDetector:    NewPatternDetector(),
		challengeManager:   NewChallengeManager(config),
		whitelist:          NewIPList("whitelist"),
		blacklist:          NewIPList("blacklist"),
		stats:              &DDoSStats{},
	}
	
	// Initialize whitelists and blacklists
	for _, ip := range config.WhitelistedIPs {
		ddos.whitelist.Add(ip)
	}
	for _, ip := range config.BlacklistedIPs {
		ddos.blacklist.Add(ip)
	}
	
	// Initialize advanced features if enabled
	if config.EnableMLDetection {
		ddos.anomalyDetector = NewNetworkAnomalyDetector()
	}
	
	if config.EnableGeoBlocking {
		ddos.geoBlocker = NewGeoBlocker(config.WhitelistedCountries, config.BlacklistedCountries)
	}
	
	ddos.threatIntelligence = NewThreatIntelligence()
	ddos.mitigationEngine = NewMitigationEngine(logger)
	
	// Initialize patterns
	ddos.initializePatterns()
	
	return ddos
}

// Start starts the DDoS protection system
func (d *DDoSProtection) Start(ctx context.Context) error {
	if d.running.Load() {
		return fmt.Errorf("DDoS protection already running")
	}
	
	d.ctx, d.cancel = context.WithCancel(ctx)
	d.running.Store(true)
	
	// Start background workers
	go d.cleanupWorker()
	go d.statsWorker()
	go d.threatIntelligenceWorker()
	
	if d.config.EnablePatternDetection {
		go d.patternAnalysisWorker()
	}
	
	if d.config.EnableMLDetection && d.anomalyDetector != nil {
		go d.anomalyDetector.Start(d.ctx)
	}
	
	d.logger.Info("DDoS protection started",
		zap.Int("rps_limit", d.config.RequestsPerSecond),
		zap.Bool("challenge_enabled", d.config.EnableChallenge),
		zap.Bool("ml_detection", d.config.EnableMLDetection),
		zap.Bool("geo_blocking", d.config.EnableGeoBlocking),
	)
	
	return nil
}

// Stop stops the DDoS protection system
func (d *DDoSProtection) Stop() error {
	if !d.running.Load() {
		return fmt.Errorf("DDoS protection not running")
	}
	
	d.running.Store(false)
	if d.cancel != nil {
		d.cancel()
	}
	
	d.logger.Info("DDoS protection stopped")
	return nil
}

// CheckRequest checks if a request should be allowed
func (d *DDoSProtection) CheckRequest(ip string, req RequestInfo) (allowed bool, challengeRequired bool, reason string) {
	d.stats.TotalRequests.Add(1)
	
	// Check whitelist first
	if d.whitelist.Contains(ip) {
		return true, false, "whitelisted"
	}
	
	// Check blacklist
	if d.blacklist.Contains(ip) {
		d.stats.BlockedRequests.Add(1)
		return false, false, "blacklisted"
	}
	
	// Get or create IP limiter
	limiter := d.getOrCreateIPLimiter(ip)
	
	// Check if IP is blocked
	if limiter.blocked.Load() {
		blockExpiry := time.Unix(limiter.blockExpiry.Load(), 0)
		if time.Now().Before(blockExpiry) {
			d.stats.BlockedRequests.Add(1)
			return false, false, "temporarily blocked"
		}
		// Unblock if expired
		limiter.blocked.Store(false)
	}
	
	// Check global rate limit
	if !d.globalLimiter.Allow() {
		d.stats.BlockedRequests.Add(1)
		return false, false, "global rate limit exceeded"
	}
	
	// Check IP rate limit
	if !limiter.limiter.Allow() {
		limiter.suspiciousCount.Add(1)
		
		if int(limiter.suspiciousCount.Load()) >= d.config.BlockingThreshold {
			d.blockIP(ip, d.config.BlockDuration)
			d.stats.BlockedRequests.Add(1)
			return false, false, "rate limit exceeded - blocked"
		}
		
		if d.config.EnableChallenge && int(limiter.suspiciousCount.Load()) >= d.config.SuspiciousThreshold {
			if !limiter.challengePassed.Load() {
				d.stats.ChallengedRequests.Add(1)
				return false, true, "rate limit exceeded - challenge required"
			}
		}
		
		d.stats.BlockedRequests.Add(1)
		return false, false, "rate limit exceeded"
	}
	
	// Check connection limit
	if count, ok := d.connectionTracker.ipCounts.Load(ip); ok {
		if count.(int) > d.config.IPConnectionLimit {
			d.stats.BlockedRequests.Add(1)
			return false, false, "connection limit exceeded"
		}
	}
	
	// Geo-blocking check
	if d.config.EnableGeoBlocking && d.geoBlocker != nil {
		if blocked, country := d.geoBlocker.IsBlocked(ip); blocked {
			d.stats.BlockedRequests.Add(1)
			return false, false, fmt.Sprintf("geo-blocked: %s", country)
		}
	}
	
	// Pattern detection
	if d.config.EnablePatternDetection {
		d.recordRequest(ip, req)
		
		if suspicious, pattern := d.detectSuspiciousPattern(ip); suspicious {
			limiter.suspiciousCount.Add(1)
			
			if pattern.Action == "block" {
				d.blockIP(ip, d.config.BlockDuration)
				d.stats.BlockedRequests.Add(1)
				return false, false, fmt.Sprintf("suspicious pattern detected: %s", pattern.Name)
			}
			
			if pattern.Action == "challenge" && d.config.EnableChallenge {
				if !limiter.challengePassed.Load() {
					d.stats.ChallengedRequests.Add(1)
					return false, true, fmt.Sprintf("suspicious pattern: %s", pattern.Name)
				}
			}
		}
	}
	
	// ML-based anomaly detection
	if d.config.EnableMLDetection && d.anomalyDetector != nil {
		score := d.anomalyDetector.GetAnomalyScore(ip, req)
		if score > d.config.AnomalyThreshold {
			limiter.suspiciousCount.Add(1)
			
			if score > d.config.AnomalyThreshold*2 {
				d.blockIP(ip, d.config.BlockDuration)
				d.stats.BlockedRequests.Add(1)
				return false, false, fmt.Sprintf("anomaly detected: score %.2f", score)
			}
			
			if d.config.EnableChallenge && !limiter.challengePassed.Load() {
				d.stats.ChallengedRequests.Add(1)
				return false, true, fmt.Sprintf("anomaly detected: score %.2f", score)
			}
		}
	}
	
	// Update stats
	limiter.totalRequests.Add(1)
	limiter.lastActivity.Store(time.Now().Unix())
	
	return true, false, "allowed"
}

// TrackConnection tracks a new connection
func (d *DDoSProtection) TrackConnection(connID, ip string, port int, protocol string) error {
	// Check connection limits
	if d.connectionTracker.totalActive.Load() >= int64(d.config.ConnectionLimit) {
		return fmt.Errorf("global connection limit reached")
	}
	
	// Check IP connection limit
	if count := d.connectionTracker.GetIPConnectionCount(ip); count >= d.config.IPConnectionLimit {
		return fmt.Errorf("IP connection limit reached")
	}
	
	conn := &TrackedConnection{
		ID:           connID,
		IP:           ip,
		Port:         port,
		Protocol:     protocol,
		StartTime:    time.Now(),
		LastActivity: time.Now(),
	}
	
	d.connectionTracker.AddConnection(connID, conn)
	return nil
}

// UntrackConnection removes a connection from tracking
func (d *DDoSProtection) UntrackConnection(connID string) {
	d.connectionTracker.RemoveConnection(connID)
}

// VerifyChallenge verifies a challenge response
func (d *DDoSProtection) VerifyChallenge(ip string, challenge, response string) bool {
	if !d.config.EnableChallenge {
		return true
	}
	
	limiter := d.getOrCreateIPLimiter(ip)
	
	valid := d.challengeManager.Verify(challenge, response, ip)
	
	if valid {
		limiter.challengePassed.Store(true)
		limiter.suspiciousCount.Store(0)
		d.stats.PassedChallenges.Add(1)
		
		// Improve reputation
		limiter.reputation.Add(10)
	} else {
		limiter.failedChallenges.Add(1)
		d.stats.FailedChallenges.Add(1)
		
		// Decrease reputation
		limiter.reputation.Add(-5)
		
		// Block if too many failed attempts
		if limiter.failedChallenges.Load() >= int32(d.config.MaxChallengeRetries) {
			d.blockIP(ip, d.config.BlockDuration*2)
		}
	}
	
	return valid
}

// GenerateChallenge generates a new challenge
func (d *DDoSProtection) GenerateChallenge(ip string) (challenge string, err error) {
	if !d.config.EnableChallenge {
		return "", fmt.Errorf("challenges not enabled")
	}
	
	return d.challengeManager.Generate(ip)
}

// GetStats returns current statistics
func (d *DDoSProtection) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"total_requests":       d.stats.TotalRequests.Load(),
		"blocked_requests":     d.stats.BlockedRequests.Load(),
		"challenged_requests":  d.stats.ChallengedRequests.Load(),
		"passed_challenges":    d.stats.PassedChallenges.Load(),
		"failed_challenges":    d.stats.FailedChallenges.Load(),
		"active_connections":   d.connectionTracker.totalActive.Load(),
		"blocked_ips":          d.stats.BlockedIPs.Load(),
		"detected_attacks":     d.stats.DetectedAttacks.Load(),
		"false_positives":      d.stats.FalsePositives.Load(),
		"blacklist_size":       d.blacklist.Size(),
		"whitelist_size":       d.whitelist.Size(),
	}
}

// Private methods

func (d *DDoSProtection) getOrCreateIPLimiter(ip string) *IPLimiter {
	if val, ok := d.ipLimiters.Load(ip); ok {
		return val.(*IPLimiter)
	}
	
	limiter := &IPLimiter{
		IP:      ip,
		limiter: rate.NewLimiter(rate.Limit(d.config.RequestsPerSecond/10), d.config.BurstSize/10),
	}
	
	actual, _ := d.ipLimiters.LoadOrStore(ip, limiter)
	return actual.(*IPLimiter)
}

func (d *DDoSProtection) blockIP(ip string, duration time.Duration) {
	limiter := d.getOrCreateIPLimiter(ip)
	limiter.blocked.Store(true)
	limiter.blockExpiry.Store(time.Now().Add(duration).Unix())
	
	d.blacklist.AddTemporary(ip, duration)
	d.stats.BlockedIPs.Add(1)
	
	d.logger.Warn("IP blocked",
		zap.String("ip", ip),
		zap.Duration("duration", duration),
		zap.Int32("reputation", limiter.reputation.Load()),
	)
}

func (d *DDoSProtection) recordRequest(ip string, req RequestInfo) {
	historyVal, _ := d.patternDetector.ipHistory.LoadOrStore(ip, &IPHistory{
		IP:         ip,
		Requests:   make([]RequestInfo, 0, 100),
		UserAgents: make(map[string]int),
		Endpoints:  make(map[string]int),
	})
	
	history := historyVal.(*IPHistory)
	history.mu.Lock()
	defer history.mu.Unlock()
	
	// Keep last 100 requests
	if len(history.Requests) >= 100 {
		history.Requests = history.Requests[1:]
	}
	history.Requests = append(history.Requests, req)
	
	// Update stats
	history.UserAgents[req.UserAgent]++
	history.Endpoints[req.Path]++
}

func (d *DDoSProtection) detectSuspiciousPattern(ip string) (bool, *Pattern) {
	historyVal, ok := d.patternDetector.ipHistory.Load(ip)
	if !ok {
		return false, nil
	}
	
	history := historyVal.(*IPHistory)
	
	d.patternDetector.mu.RLock()
	defer d.patternDetector.mu.RUnlock()
	
	for _, pattern := range d.patternDetector.patterns {
		if pattern.Detector(history) {
			return true, pattern
		}
	}
	
	return false, nil
}

func (d *DDoSProtection) initializePatterns() {
	d.patternDetector.patterns = map[string]*Pattern{
		"rapid_fire": {
			ID:          "rapid_fire",
			Name:        "Rapid Fire Requests",
			Description: "Too many requests in short time",
			Score:       0.8,
			Action:      "challenge",
			Detector: func(h *IPHistory) bool {
				h.mu.RLock()
				defer h.mu.RUnlock()
				
				if len(h.Requests) < 10 {
					return false
				}
				
				// Check if 10 requests in 1 second
				recent := h.Requests[len(h.Requests)-10:]
				duration := recent[9].Timestamp.Sub(recent[0].Timestamp)
				return duration < 1*time.Second
			},
		},
		"scanner": {
			ID:          "scanner",
			Name:        "Security Scanner",
			Description: "Scanning for vulnerabilities",
			Score:       0.9,
			Action:      "block",
			Detector: func(h *IPHistory) bool {
				h.mu.RLock()
				defer h.mu.RUnlock()
				
				scanPaths := []string{
					"/admin", "/wp-admin", "/phpmyadmin",
					"/.git", "/.env", "/config",
					"/api/v1/../", "/etc/passwd",
				}
				
				scanCount := 0
				for path := range h.Endpoints {
					for _, scanPath := range scanPaths {
						if strings.Contains(path, scanPath) {
							scanCount++
						}
					}
				}
				
				return scanCount >= 3
			},
		},
		"bot_behavior": {
			ID:          "bot_behavior",
			Name:        "Bot Behavior",
			Description: "Automated bot patterns",
			Score:       0.7,
			Action:      "challenge",
			Detector: func(h *IPHistory) bool {
				h.mu.RLock()
				defer h.mu.RUnlock()
				
				// Multiple user agents from same IP
				if len(h.UserAgents) > 5 {
					return true
				}
				
				// Suspicious user agents
				for ua := range h.UserAgents {
					ua = strings.ToLower(ua)
					if strings.Contains(ua, "bot") || 
					   strings.Contains(ua, "crawler") ||
					   strings.Contains(ua, "spider") ||
					   ua == "" {
						return true
					}
				}
				
				return false
			},
		},
	}
}

func (d *DDoSProtection) cleanupWorker() {
	ticker := time.NewTicker(d.config.CleanupInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			d.cleanup()
		case <-d.ctx.Done():
			return
		}
	}
}

func (d *DDoSProtection) cleanup() {
	now := time.Now().Unix()
	
	// Cleanup IP limiters
	d.ipLimiters.Range(func(key, value interface{}) bool {
		limiter := value.(*IPLimiter)
		lastActivity := limiter.lastActivity.Load()
		
		// Remove if inactive for 1 hour
		if now-lastActivity > 3600 {
			d.ipLimiters.Delete(key)
		}
		
		return true
	})
	
	// Cleanup expired blacklist entries
	d.blacklist.CleanupExpired()
	
	// Cleanup old pattern history
	d.patternDetector.ipHistory.Range(func(key, value interface{}) bool {
		history := value.(*IPHistory)
		history.mu.Lock()
		
		// Keep only recent requests
		if len(history.Requests) > 0 {
			cutoff := time.Now().Add(-1 * time.Hour)
			i := 0
			for i < len(history.Requests) && history.Requests[i].Timestamp.Before(cutoff) {
				i++
			}
			history.Requests = history.Requests[i:]
		}
		
		history.mu.Unlock()
		
		// Remove if no recent activity
		if len(history.Requests) == 0 {
			d.patternDetector.ipHistory.Delete(key)
		}
		
		return true
	})
}

func (d *DDoSProtection) statsWorker() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			stats := d.GetStats()
			d.logger.Info("DDoS protection stats",
				zap.Any("stats", stats),
			)
		case <-d.ctx.Done():
			return
		}
	}
}

func (d *DDoSProtection) threatIntelligenceWorker() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			if d.threatIntelligence != nil {
				d.threatIntelligence.UpdateFeeds()
			}
		case <-d.ctx.Done():
			return
		}
	}
}

func (d *DDoSProtection) patternAnalysisWorker() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			// Analyze patterns and update detection rules
			d.analyzePatterns()
		case <-d.ctx.Done():
			return
		}
	}
}

func (d *DDoSProtection) analyzePatterns() {
	// Analyze recent attack patterns and adjust thresholds
	// This is where ML models could be integrated
}

// Supporting types

// ConnectionTracker implementation
func NewConnectionTracker() *ConnectionTracker {
	return &ConnectionTracker{}
}

func (ct *ConnectionTracker) AddConnection(connID string, conn *TrackedConnection) {
	ct.connections.Store(connID, conn)
	ct.totalActive.Add(1)
	
	// Update IP count
	if val, ok := ct.ipCounts.Load(conn.IP); ok {
		ct.ipCounts.Store(conn.IP, val.(int)+1)
	} else {
		ct.ipCounts.Store(conn.IP, 1)
	}
}

func (ct *ConnectionTracker) RemoveConnection(connID string) {
	if val, ok := ct.connections.LoadAndDelete(connID); ok {
		conn := val.(*TrackedConnection)
		ct.totalActive.Add(-1)
		
		// Update IP count
		if val, ok := ct.ipCounts.Load(conn.IP); ok {
			newCount := val.(int) - 1
			if newCount <= 0 {
				ct.ipCounts.Delete(conn.IP)
			} else {
				ct.ipCounts.Store(conn.IP, newCount)
			}
		}
	}
}

func (ct *ConnectionTracker) GetIPConnectionCount(ip string) int {
	if val, ok := ct.ipCounts.Load(ip); ok {
		return val.(int)
	}
	return 0
}

// PatternDetector implementation
func NewPatternDetector() *PatternDetector {
	return &PatternDetector{
		patterns: make(map[string]*Pattern),
	}
}

// ChallengeManager implementation
type ChallengeManager struct {
	config     DDoSConfig
	challenges sync.Map // challenge -> *Challenge
	mu         sync.RWMutex
}

type Challenge struct {
	ID       string
	IP       string
	Type     string
	Data     string
	Solution string
	Created  time.Time
	Attempts int
}

func NewChallengeManager(config DDoSConfig) *ChallengeManager {
	return &ChallengeManager{
		config: config,
	}
}

func (cm *ChallengeManager) Generate(ip string) (string, error) {
	challenge := &Challenge{
		ID:      generateID(),
		IP:      ip,
		Type:    cm.config.ChallengeType,
		Created: time.Now(),
	}
	
	switch cm.config.ChallengeType {
	case "proof_of_work":
		// Generate proof of work challenge
		challenge.Data = generateRandomString(16)
		challenge.Solution = cm.calculatePoWSolution(challenge.Data, cm.config.ChallengeDifficulty)
		
	case "javascript":
		// Generate JavaScript challenge
		challenge.Data = cm.generateJSChallenge()
		challenge.Solution = cm.calculateJSSolution(challenge.Data)
		
	default:
		return "", fmt.Errorf("unknown challenge type: %s", cm.config.ChallengeType)
	}
	
	cm.challenges.Store(challenge.ID, challenge)
	
	// Cleanup old challenges
	go cm.cleanupOldChallenges()
	
	return challenge.ID, nil
}

func (cm *ChallengeManager) Verify(challengeID, response, ip string) bool {
	val, ok := cm.challenges.Load(challengeID)
	if !ok {
		return false
	}
	
	challenge := val.(*Challenge)
	
	// Check expiry
	if time.Since(challenge.Created) > cm.config.ChallengeExpiry {
		cm.challenges.Delete(challengeID)
		return false
	}
	
	// Check IP match
	if challenge.IP != ip {
		return false
	}
	
	// Check attempts
	challenge.Attempts++
	if challenge.Attempts > cm.config.MaxChallengeRetries {
		cm.challenges.Delete(challengeID)
		return false
	}
	
	// Verify solution
	valid := false
	switch challenge.Type {
	case "proof_of_work":
		valid = cm.verifyPoWSolution(challenge.Data, response, cm.config.ChallengeDifficulty)
	case "javascript":
		valid = response == challenge.Solution
	}
	
	if valid {
		cm.challenges.Delete(challengeID)
	}
	
	return valid
}

func (cm *ChallengeManager) calculatePoWSolution(data string, difficulty int) string {
	nonce := 0
	prefix := strings.Repeat("0", difficulty)
	
	for {
		candidate := fmt.Sprintf("%s:%d", data, nonce)
		hash := sha256.Sum256([]byte(candidate))
		hashStr := hex.EncodeToString(hash[:])
		
		if strings.HasPrefix(hashStr, prefix) {
			return fmt.Sprintf("%d", nonce)
		}
		
		nonce++
	}
}

func (cm *ChallengeManager) verifyPoWSolution(data, solution string, difficulty int) bool {
	candidate := fmt.Sprintf("%s:%s", data, solution)
	hash := sha256.Sum256([]byte(candidate))
	hashStr := hex.EncodeToString(hash[:])
	
	prefix := strings.Repeat("0", difficulty)
	return strings.HasPrefix(hashStr, prefix)
}

func (cm *ChallengeManager) generateJSChallenge() string {
	// Generate a simple math challenge
	a := randInt(100, 999)
	b := randInt(100, 999)
	return fmt.Sprintf("%d + %d", a, b)
}

func (cm *ChallengeManager) calculateJSSolution(challenge string) string {
	// Parse and solve the math challenge
	var a, b int
	fmt.Sscanf(challenge, "%d + %d", &a, &b)
	return fmt.Sprintf("%d", a+b)
}

func (cm *ChallengeManager) cleanupOldChallenges() {
	cm.challenges.Range(func(key, value interface{}) bool {
		challenge := value.(*Challenge)
		if time.Since(challenge.Created) > cm.config.ChallengeExpiry {
			cm.challenges.Delete(key)
		}
		return true
	})
}

// IPList implementation
type IPList struct {
	name       string
	permanent  sync.Map // IP -> bool
	temporary  sync.Map // IP -> expiry time
	mu         sync.RWMutex
}

func NewIPList(name string) *IPList {
	return &IPList{
		name: name,
	}
}

func (l *IPList) Add(ip string) {
	l.permanent.Store(ip, true)
}

func (l *IPList) AddTemporary(ip string, duration time.Duration) {
	l.temporary.Store(ip, time.Now().Add(duration))
}

func (l *IPList) Remove(ip string) {
	l.permanent.Delete(ip)
	l.temporary.Delete(ip)
}

func (l *IPList) Contains(ip string) bool {
	// Check permanent list
	if _, ok := l.permanent.Load(ip); ok {
		return true
	}
	
	// Check temporary list
	if val, ok := l.temporary.Load(ip); ok {
		expiry := val.(time.Time)
		if time.Now().Before(expiry) {
			return true
		}
		// Remove expired entry
		l.temporary.Delete(ip)
	}
	
	return false
}

func (l *IPList) Size() int {
	count := 0
	l.permanent.Range(func(_, _ interface{}) bool {
		count++
		return true
	})
	l.temporary.Range(func(_, _ interface{}) bool {
		count++
		return true
	})
	return count
}

func (l *IPList) CleanupExpired() {
	now := time.Now()
	l.temporary.Range(func(key, value interface{}) bool {
		expiry := value.(time.Time)
		if now.After(expiry) {
			l.temporary.Delete(key)
		}
		return true
	})
}

// Stub implementations for advanced features

type NetworkAnomalyDetector struct{}
func NewNetworkAnomalyDetector() *NetworkAnomalyDetector { return &NetworkAnomalyDetector{} }
func (n *NetworkAnomalyDetector) Start(ctx context.Context) {}
func (n *NetworkAnomalyDetector) GetAnomalyScore(ip string, req RequestInfo) float64 { return 0.0 }

type ThreatIntelligence struct{}
func NewThreatIntelligence() *ThreatIntelligence { return &ThreatIntelligence{} }
func (t *ThreatIntelligence) UpdateFeeds() {}

type GeoBlocker struct {
	whitelistedCountries []string
	blacklistedCountries []string
}
func NewGeoBlocker(whitelist, blacklist []string) *GeoBlocker {
	return &GeoBlocker{
		whitelistedCountries: whitelist,
		blacklistedCountries: blacklist,
	}
}
func (g *GeoBlocker) IsBlocked(ip string) (bool, string) { return false, "" }

type MitigationEngine struct{ logger *zap.Logger }
func NewMitigationEngine(logger *zap.Logger) *MitigationEngine { 
	return &MitigationEngine{logger: logger} 
}

// Utility functions

func generateID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func generateRandomString(length int) string {
	b := make([]byte, length)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func randInt(min, max int) int {
	return min + int(rand.Int63n(int64(max-min+1)))
}