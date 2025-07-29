package security

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
	"golang.org/x/time/rate"
)

// DDoSProtection implements comprehensive DDoS protection
type DDoSProtection struct {
	logger             *zap.Logger
	config             DDoSConfig
	ipLimiters         sync.Map // IP -> *IPLimiter
	connectionTracker  *ConnectionTracker
	patternDetector    *PatternDetector
	challengeManager   *ChallengeManager
	blacklist          *Blacklist
	stats              *DDoSStats
	mu                 sync.RWMutex
}

// DDoSConfig contains DDoS protection configuration
type DDoSConfig struct {
	// Rate limiting
	RequestsPerSecond    int
	BurstSize           int
	ConnectionLimit     int
	ConnectionRateLimit int

	// Thresholds
	SuspiciousThreshold int
	BanThreshold        int
	BanDuration         time.Duration

	// Challenge configuration
	EnableChallenge     bool
	ChallengeExpiry     time.Duration
	MaxChallengeRetries int

	// Pattern detection
	EnablePatternDetection bool
	PatternWindow         time.Duration
	AnomalyThreshold      float64
}

// IPLimiter tracks rate limiting for an IP
type IPLimiter struct {
	limiter          *rate.Limiter
	connections      atomic.Int32
	suspiciousCount  atomic.Int32
	lastActivity     atomic.Int64
	challengePassed  atomic.Bool
	mu               sync.Mutex
}

// ConnectionTracker tracks active connections
type ConnectionTracker struct {
	connections sync.Map // connID -> *TrackedConnection
	ipCounts    sync.Map // IP -> count
	mu          sync.RWMutex
}

// TrackedConnection represents a tracked connection
type TrackedConnection struct {
	ID            string
	IP            string
	StartTime     time.Time
	LastActivity  time.Time
	RequestCount  atomic.Uint64
	BytesReceived atomic.Uint64
	BytesSent     atomic.Uint64
	Suspicious    atomic.Bool
}

// PatternDetector detects suspicious patterns
type PatternDetector struct {
	patterns      sync.Map // patternID -> *Pattern
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
}

// IPHistory tracks IP behavior history
type IPHistory struct {
	IP               string
	RequestTimes     []time.Time
	RequestSizes     []int
	RequestPaths     []string
	UserAgents       []string
	ResponseCodes    []int
	mu               sync.RWMutex
}

// ChallengeManager manages proof-of-work challenges
type ChallengeManager struct {
	challenges sync.Map // IP -> *Challenge
	difficulty int
	mu         sync.RWMutex
}

// Challenge represents a proof-of-work challenge
type Challenge struct {
	ID         string
	Target     string
	Difficulty int
	IssuedAt   time.Time
	ExpiresAt  time.Time
	Attempts   int
}

// Blacklist manages IP blacklisting
type Blacklist struct {
	entries sync.Map // IP -> *BlacklistEntry
	mu      sync.RWMutex
}

// BlacklistEntry represents a blacklisted IP
type BlacklistEntry struct {
	IP        string
	Reason    string
	AddedAt   time.Time
	ExpiresAt time.Time
	Permanent bool
}

// DDoSStats tracks DDoS protection statistics
type DDoSStats struct {
	TotalRequests       atomic.Uint64
	BlockedRequests     atomic.Uint64
	SuspiciousRequests  atomic.Uint64
	ChallengesSent      atomic.Uint64
	ChallengesPassed    atomic.Uint64
	BlacklistedIPs      atomic.Uint64
	ActiveConnections   atomic.Int32
	AnomaliesDetected   atomic.Uint64
}

// NewDDoSProtection creates a new DDoS protection system
func NewDDoSProtection(config DDoSConfig, logger *zap.Logger) *DDoSProtection {
	if config.RequestsPerSecond == 0 {
		config.RequestsPerSecond = 100
	}
	if config.BurstSize == 0 {
		config.BurstSize = 200
	}
	if config.ConnectionLimit == 0 {
		config.ConnectionLimit = 1000
	}
	if config.BanDuration == 0 {
		config.BanDuration = 24 * time.Hour
	}
	if config.ChallengeExpiry == 0 {
		config.ChallengeExpiry = 5 * time.Minute
	}
	if config.PatternWindow == 0 {
		config.PatternWindow = 10 * time.Minute
	}

	ddos := &DDoSProtection{
		logger:            logger,
		config:            config,
		connectionTracker: NewConnectionTracker(),
		patternDetector:   NewPatternDetector(),
		challengeManager:  NewChallengeManager(4), // Default difficulty 4
		blacklist:         NewBlacklist(),
		stats:             &DDoSStats{},
	}

	// Start cleanup routines
	go ddos.cleanupRoutine()
	go ddos.patternAnalysisRoutine()

	return ddos
}

// CheckRequest checks if a request should be allowed
func (ddos *DDoSProtection) CheckRequest(ip string, requestSize int) (bool, error) {
	ddos.stats.TotalRequests.Add(1)

	// Check blacklist first
	if ddos.blacklist.IsBlacklisted(ip) {
		ddos.stats.BlockedRequests.Add(1)
		return false, fmt.Errorf("IP is blacklisted")
	}

	// Get or create IP limiter
	limiter := ddos.getOrCreateLimiter(ip)

	// Check rate limit
	if !limiter.limiter.Allow() {
		ddos.handleRateLimitExceeded(ip, limiter)
		ddos.stats.BlockedRequests.Add(1)
		return false, fmt.Errorf("rate limit exceeded")
	}

	// Check connection limit
	if int(limiter.connections.Load()) >= ddos.config.ConnectionLimit {
		ddos.stats.BlockedRequests.Add(1)
		return false, fmt.Errorf("connection limit exceeded")
	}

	// Pattern detection
	if ddos.config.EnablePatternDetection {
		ddos.patternDetector.RecordRequest(ip, requestSize, "")
		
		if ddos.patternDetector.IsSuspicious(ip) {
			ddos.stats.SuspiciousRequests.Add(1)
			limiter.suspiciousCount.Add(1)
			
			// Check if challenge is required
			if ddos.config.EnableChallenge && !limiter.challengePassed.Load() {
				return false, fmt.Errorf("challenge required")
			}
		}
	}

	// Update last activity
	limiter.lastActivity.Store(time.Now().Unix())

	return true, nil
}

// HandleConnection handles a new connection
func (ddos *DDoSProtection) HandleConnection(conn net.Conn) (*TrackedConnection, error) {
	ip, _, err := net.SplitHostPort(conn.RemoteAddr().String())
	if err != nil {
		return nil, err
	}

	// Check if IP is blacklisted
	if ddos.blacklist.IsBlacklisted(ip) {
		conn.Close()
		return nil, fmt.Errorf("IP is blacklisted")
	}

	// Get IP limiter
	limiter := ddos.getOrCreateLimiter(ip)

	// Check connection limit
	currentConns := limiter.connections.Add(1)
	if int(currentConns) > ddos.config.ConnectionLimit {
		limiter.connections.Add(-1)
		conn.Close()
		return nil, fmt.Errorf("connection limit exceeded")
	}

	// Create tracked connection
	tracked := &TrackedConnection{
		ID:           generateConnectionID(),
		IP:           ip,
		StartTime:    time.Now(),
		LastActivity: time.Now(),
	}

	// Track connection
	ddos.connectionTracker.AddConnection(tracked)
	ddos.stats.ActiveConnections.Add(1)

	return tracked, nil
}

// HandleDisconnection handles connection closure
func (ddos *DDoSProtection) HandleDisconnection(tracked *TrackedConnection) {
	if tracked == nil {
		return
	}

	// Update connection count
	limiter := ddos.getOrCreateLimiter(tracked.IP)
	limiter.connections.Add(-1)

	// Remove from tracker
	ddos.connectionTracker.RemoveConnection(tracked.ID)
	ddos.stats.ActiveConnections.Add(-1)

	// Check if connection was suspicious
	if tracked.Suspicious.Load() {
		ddos.handleSuspiciousConnection(tracked)
	}
}

// GetChallenge generates a proof-of-work challenge for an IP
func (ddos *DDoSProtection) GetChallenge(ip string) (*Challenge, error) {
	if !ddos.config.EnableChallenge {
		return nil, fmt.Errorf("challenges are disabled")
	}

	challenge := ddos.challengeManager.GenerateChallenge(ip)
	ddos.stats.ChallengesSent.Add(1)

	return challenge, nil
}

// VerifyChallenge verifies a challenge solution
func (ddos *DDoSProtection) VerifyChallenge(ip string, challengeID string, solution string) bool {
	verified := ddos.challengeManager.VerifyChallenge(ip, challengeID, solution)
	
	if verified {
		ddos.stats.ChallengesPassed.Add(1)
		limiter := ddos.getOrCreateLimiter(ip)
		limiter.challengePassed.Store(true)
		
		// Reset suspicious count on successful challenge
		limiter.suspiciousCount.Store(0)
	}

	return verified
}

// getOrCreateLimiter gets or creates an IP limiter
func (ddos *DDoSProtection) getOrCreateLimiter(ip string) *IPLimiter {
	if val, ok := ddos.ipLimiters.Load(ip); ok {
		return val.(*IPLimiter)
	}

	limiter := &IPLimiter{
		limiter: rate.NewLimiter(
			rate.Limit(ddos.config.RequestsPerSecond),
			ddos.config.BurstSize,
		),
	}
	limiter.lastActivity.Store(time.Now().Unix())

	actual, _ := ddos.ipLimiters.LoadOrStore(ip, limiter)
	return actual.(*IPLimiter)
}

// handleRateLimitExceeded handles rate limit violations
func (ddos *DDoSProtection) handleRateLimitExceeded(ip string, limiter *IPLimiter) {
	suspiciousCount := limiter.suspiciousCount.Add(1)

	ddos.logger.Warn("Rate limit exceeded",
		zap.String("ip", ip),
		zap.Int32("suspicious_count", suspiciousCount))

	// Check if should be banned
	if int(suspiciousCount) >= ddos.config.BanThreshold {
		ddos.blacklist.Add(ip, "Exceeded rate limit threshold", ddos.config.BanDuration)
		ddos.stats.BlacklistedIPs.Add(1)
		
		ddos.logger.Info("IP blacklisted",
			zap.String("ip", ip),
			zap.String("reason", "rate limit violations"))
	}
}

// handleSuspiciousConnection handles suspicious connections
func (ddos *DDoSProtection) handleSuspiciousConnection(conn *TrackedConnection) {
	limiter := ddos.getOrCreateLimiter(conn.IP)
	suspiciousCount := limiter.suspiciousCount.Add(1)

	if int(suspiciousCount) >= ddos.config.BanThreshold {
		ddos.blacklist.Add(conn.IP, "Suspicious connection behavior", ddos.config.BanDuration)
		ddos.stats.BlacklistedIPs.Add(1)
	}
}

// cleanupRoutine periodically cleans up old data
func (ddos *DDoSProtection) cleanupRoutine() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		now := time.Now().Unix()
		
		// Clean up inactive IP limiters
		ddos.ipLimiters.Range(func(key, value interface{}) bool {
			limiter := value.(*IPLimiter)
			lastActivity := limiter.lastActivity.Load()
			
			// Remove if inactive for 30 minutes and no active connections
			if now-lastActivity > 1800 && limiter.connections.Load() == 0 {
				ddos.ipLimiters.Delete(key)
			}
			return true
		})

		// Clean up expired blacklist entries
		ddos.blacklist.CleanupExpired()

		// Clean up old pattern data
		ddos.patternDetector.Cleanup()
	}
}

// patternAnalysisRoutine analyzes patterns for anomalies
func (ddos *DDoSProtection) patternAnalysisRoutine() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		ddos.patternDetector.AnalyzePatterns()
	}
}

// GetStats returns DDoS protection statistics
func (ddos *DDoSProtection) GetStats() map[string]interface{} {
	// Count active IPs
	activeIPs := 0
	ddos.ipLimiters.Range(func(_, _ interface{}) bool {
		activeIPs++
		return true
	})

	return map[string]interface{}{
		"total_requests":      ddos.stats.TotalRequests.Load(),
		"blocked_requests":    ddos.stats.BlockedRequests.Load(),
		"suspicious_requests": ddos.stats.SuspiciousRequests.Load(),
		"challenges_sent":     ddos.stats.ChallengesSent.Load(),
		"challenges_passed":   ddos.stats.ChallengesPassed.Load(),
		"blacklisted_ips":     ddos.stats.BlacklistedIPs.Load(),
		"active_connections":  ddos.stats.ActiveConnections.Load(),
		"anomalies_detected":  ddos.stats.AnomaliesDetected.Load(),
		"active_ips":          activeIPs,
		"blacklist_size":      ddos.blacklist.Size(),
	}
}

// Helper implementations

// NewConnectionTracker creates a new connection tracker
func NewConnectionTracker() *ConnectionTracker {
	return &ConnectionTracker{}
}

// AddConnection adds a connection to tracking
func (ct *ConnectionTracker) AddConnection(conn *TrackedConnection) {
	ct.connections.Store(conn.ID, conn)
	
	// Update IP count
	if val, ok := ct.ipCounts.Load(conn.IP); ok {
		ct.ipCounts.Store(conn.IP, val.(int)+1)
	} else {
		ct.ipCounts.Store(conn.IP, 1)
	}
}

// RemoveConnection removes a connection from tracking
func (ct *ConnectionTracker) RemoveConnection(connID string) {
	if val, ok := ct.connections.Load(connID); ok {
		conn := val.(*TrackedConnection)
		ct.connections.Delete(connID)
		
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

// NewPatternDetector creates a new pattern detector
func NewPatternDetector() *PatternDetector {
	pd := &PatternDetector{}
	
	// Register default patterns
	pd.RegisterPattern(&Pattern{
		ID:          "rapid_requests",
		Name:        "Rapid Request Pattern",
		Description: "Unusually rapid request rate",
		Detector: func(history *IPHistory) bool {
			history.mu.RLock()
			defer history.mu.RUnlock()
			
			if len(history.RequestTimes) < 10 {
				return false
			}
			
			// Check if 10 requests in 1 second
			recent := history.RequestTimes[len(history.RequestTimes)-10:]
			return recent[9].Sub(recent[0]) < time.Second
		},
		Score: 5.0,
	})

	pd.RegisterPattern(&Pattern{
		ID:          "large_requests",
		Name:        "Large Request Pattern",
		Description: "Unusually large request sizes",
		Detector: func(history *IPHistory) bool {
			history.mu.RLock()
			defer history.mu.RUnlock()
			
			if len(history.RequestSizes) < 5 {
				return false
			}
			
			// Check if recent requests are unusually large
			totalSize := 0
			for i := len(history.RequestSizes) - 5; i < len(history.RequestSizes); i++ {
				totalSize += history.RequestSizes[i]
			}
			
			return totalSize > 10*1024*1024 // 10MB in 5 requests
		},
		Score: 3.0,
	})

	return pd
}

// RegisterPattern registers a new pattern
func (pd *PatternDetector) RegisterPattern(pattern *Pattern) {
	pd.patterns.Store(pattern.ID, pattern)
}

// RecordRequest records a request for pattern analysis
func (pd *PatternDetector) RecordRequest(ip string, size int, path string) {
	historyVal, _ := pd.ipHistory.LoadOrStore(ip, &IPHistory{IP: ip})
	history := historyVal.(*IPHistory)
	
	history.mu.Lock()
	defer history.mu.Unlock()
	
	now := time.Now()
	history.RequestTimes = append(history.RequestTimes, now)
	history.RequestSizes = append(history.RequestSizes, size)
	history.RequestPaths = append(history.RequestPaths, path)
	
	// Keep only recent history (last 1000 requests)
	if len(history.RequestTimes) > 1000 {
		history.RequestTimes = history.RequestTimes[100:]
		history.RequestSizes = history.RequestSizes[100:]
		history.RequestPaths = history.RequestPaths[100:]
	}
}

// IsSuspicious checks if an IP is showing suspicious patterns
func (pd *PatternDetector) IsSuspicious(ip string) bool {
	if val, ok := pd.anomalyScores.Load(ip); ok {
		return val.(float64) > 10.0 // Threshold
	}
	return false
}

// AnalyzePatterns analyzes all IP histories for patterns
func (pd *PatternDetector) AnalyzePatterns() {
	pd.ipHistory.Range(func(key, value interface{}) bool {
		ip := key.(string)
		history := value.(*IPHistory)
		
		totalScore := 0.0
		pd.patterns.Range(func(_, patternVal interface{}) bool {
			pattern := patternVal.(*Pattern)
			if pattern.Detector(history) {
				totalScore += pattern.Score
			}
			return true
		})
		
		if totalScore > 0 {
			pd.anomalyScores.Store(ip, totalScore)
		} else {
			pd.anomalyScores.Delete(ip)
		}
		
		return true
	})
}

// Cleanup removes old pattern data
func (pd *PatternDetector) Cleanup() {
	cutoff := time.Now().Add(-30 * time.Minute)
	
	pd.ipHistory.Range(func(key, value interface{}) bool {
		history := value.(*IPHistory)
		history.mu.RLock()
		
		if len(history.RequestTimes) > 0 {
			lastRequest := history.RequestTimes[len(history.RequestTimes)-1]
			if lastRequest.Before(cutoff) {
				history.mu.RUnlock()
				pd.ipHistory.Delete(key)
				pd.anomalyScores.Delete(key)
				return true
			}
		}
		
		history.mu.RUnlock()
		return true
	})
}

// NewChallengeManager creates a new challenge manager
func NewChallengeManager(difficulty int) *ChallengeManager {
	return &ChallengeManager{
		difficulty: difficulty,
	}
}

// GenerateChallenge generates a new challenge
func (cm *ChallengeManager) GenerateChallenge(ip string) *Challenge {
	challenge := &Challenge{
		ID:         generateChallengeID(),
		Target:     generateTarget(cm.difficulty),
		Difficulty: cm.difficulty,
		IssuedAt:   time.Now(),
		ExpiresAt:  time.Now().Add(5 * time.Minute),
		Attempts:   0,
	}
	
	cm.challenges.Store(ip, challenge)
	return challenge
}

// VerifyChallenge verifies a challenge solution
func (cm *ChallengeManager) VerifyChallenge(ip, challengeID, solution string) bool {
	val, ok := cm.challenges.Load(ip)
	if !ok {
		return false
	}
	
	challenge := val.(*Challenge)
	if challenge.ID != challengeID {
		return false
	}
	
	if time.Now().After(challenge.ExpiresAt) {
		cm.challenges.Delete(ip)
		return false
	}
	
	challenge.Attempts++
	
	// Verify the solution
	hash := sha256.Sum256([]byte(challengeID + solution))
	hashStr := hex.EncodeToString(hash[:])
	
	if hashStr < challenge.Target {
		cm.challenges.Delete(ip)
		return true
	}
	
	return false
}

// NewBlacklist creates a new blacklist
func NewBlacklist() *Blacklist {
	return &Blacklist{}
}

// Add adds an IP to the blacklist
func (bl *Blacklist) Add(ip, reason string, duration time.Duration) {
	entry := &BlacklistEntry{
		IP:        ip,
		Reason:    reason,
		AddedAt:   time.Now(),
		ExpiresAt: time.Now().Add(duration),
		Permanent: duration == 0,
	}
	
	bl.entries.Store(ip, entry)
}

// IsBlacklisted checks if an IP is blacklisted
func (bl *Blacklist) IsBlacklisted(ip string) bool {
	val, ok := bl.entries.Load(ip)
	if !ok {
		return false
	}
	
	entry := val.(*BlacklistEntry)
	if !entry.Permanent && time.Now().After(entry.ExpiresAt) {
		bl.entries.Delete(ip)
		return false
	}
	
	return true
}

// CleanupExpired removes expired entries
func (bl *Blacklist) CleanupExpired() {
	now := time.Now()
	bl.entries.Range(func(key, value interface{}) bool {
		entry := value.(*BlacklistEntry)
		if !entry.Permanent && now.After(entry.ExpiresAt) {
			bl.entries.Delete(key)
		}
		return true
	})
}

// Size returns the number of blacklisted IPs
func (bl *Blacklist) Size() int {
	count := 0
	bl.entries.Range(func(_, _ interface{}) bool {
		count++
		return true
	})
	return count
}

// Helper functions

func generateConnectionID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("conn_%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func generateChallengeID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("challenge_%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func generateTarget(difficulty int) string {
	// Generate target with leading zeros based on difficulty
	target := ""
	for i := 0; i < difficulty; i++ {
		target += "0"
	}
	for i := difficulty; i < 64; i++ {
		target += "f"
	}
	return target
}

