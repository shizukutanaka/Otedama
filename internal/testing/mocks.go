package testing

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"go.uber.org/zap"
)

// Mock implementations for testing

// MockMiningEngine provides a mock mining engine for testing
type MockMiningEngine struct {
	logger  *zap.Logger
	workers map[string]*MockWorker
	started bool
}

// MockWorker represents a mock mining worker
type MockWorker struct {
	id       string
	hashrate float64
}

// MockP2PNetwork provides a mock P2P network for testing
type MockP2PNetwork struct {
	logger    *zap.Logger
	peers     map[string]*MockPeer
	started   bool
	listenAddr string
}

// MockPeer represents a mock P2P peer
type MockPeer struct {
	id      string
	address string
}

// MockShareValidator provides a mock share validator for testing
type MockShareValidator struct {
	validShares   uint64
	invalidShares uint64
}

// MockShare represents a mock mining share
type MockShare struct {
	WorkerID   string
	JobID      string
	Nonce      string
	Hash       string
	Timestamp  time.Time
	Difficulty float64
	Currency   string
	Algorithm  string
}

// MockValidationResult represents a mock validation result
type MockValidationResult struct {
	Valid      bool
	Reason     string
	ShareDiff  float64
	BlockFound bool
}

// MockPayoutCalculator provides mock payout calculations
type MockPayoutCalculator struct{}

// MockPayout represents a mock payout
type MockPayout struct {
	WorkerID string
	Amount   float64
}

// MockStratumServer provides a mock Stratum server
type MockStratumServer struct {
	authenticatedUsers map[string]bool
}

// MockAuthentication represents mock authentication data
type MockAuthentication struct {
	Username string
	Password string
}

// MockAuthResult represents mock authentication result
type MockAuthResult struct {
	Success bool
	UserID  string
}

// MockDifficultyAdjuster provides mock difficulty adjustment
type MockDifficultyAdjuster struct {
	workerDifficulties map[string]float64
}

// MockSecurityManager provides mock security functionality
type MockSecurityManager struct {
	rateLimits map[string]int
	tokens     map[string]string
}

// MockDDoSProtection provides mock DDoS protection
type MockDDoSProtection struct {
	blockedIPs map[string]bool
}

// MockRateLimiter provides mock rate limiting
type MockRateLimiter struct {
	limits map[string]int
}

// Mining engine mock implementations

func NewMockMiningEngine(logger *zap.Logger) *MockMiningEngine {
	return &MockMiningEngine{
		logger:  logger,
		workers: make(map[string]*MockWorker),
	}
}

func (e *MockMiningEngine) Start() error {
	if e.started {
		return errors.New("engine already started")
	}
	e.started = true
	e.logger.Info("Mock mining engine started")
	return nil
}

func (e *MockMiningEngine) Stop() error {
	if !e.started {
		return errors.New("engine not started")
	}
	e.started = false
	e.logger.Info("Mock mining engine stopped")
	return nil
}

func (e *MockMiningEngine) CreateWorker(id string) (*MockWorker, error) {
	if !e.started {
		return nil, errors.New("engine not started")
	}
	
	worker := &MockWorker{
		id:       id,
		hashrate: 1000000, // 1 MH/s
	}
	
	e.workers[id] = worker
	return worker, nil
}

func (w *MockWorker) ID() string {
	return w.id
}

func (w *MockWorker) Hashrate() float64 {
	return w.hashrate
}

// P2P network mock implementations

func NewMockP2PNetwork(listenAddr string, logger *zap.Logger) *MockP2PNetwork {
	return &MockP2PNetwork{
		logger:     logger,
		peers:      make(map[string]*MockPeer),
		listenAddr: listenAddr,
	}
}

func (n *MockP2PNetwork) Start() error {
	if n.started {
		return errors.New("network already started")
	}
	n.started = true
	n.logger.Info("Mock P2P network started", zap.String("listen_addr", n.listenAddr))
	return nil
}

func (n *MockP2PNetwork) Stop() error {
	if !n.started {
		return errors.New("network not started")
	}
	n.started = false
	n.logger.Info("Mock P2P network stopped")
	return nil
}

func (n *MockP2PNetwork) GetPeers() map[string]*MockPeer {
	return n.peers
}

func (n *MockP2PNetwork) AddPeer(id, address string) {
	n.peers[id] = &MockPeer{
		id:      id,
		address: address,
	}
}

// Share validator mock implementations

func NewMockShareValidator() *MockShareValidator {
	return &MockShareValidator{}
}

func (v *MockShareValidator) ValidateShare(ctx context.Context, share *MockShare) (*MockValidationResult, error) {
	// Simple validation logic for testing
	result := &MockValidationResult{
		Valid:     true,
		ShareDiff: share.Difficulty,
	}
	
	// Check if hash is valid (simplified)
	if len(share.Hash) != 64 {
		result.Valid = false
		result.Reason = "invalid hash length"
		v.invalidShares++
		return result, nil
	}
	
	// Check if difficulty meets minimum
	if share.Difficulty < 1.0 {
		result.Valid = false
		result.Reason = "difficulty too low"
		v.invalidShares++
		return result, nil
	}
	
	// Check for block found (simplified)
	if share.Difficulty >= 1000000 {
		result.BlockFound = true
	}
	
	v.validShares++
	return result, nil
}

func (v *MockShareValidator) GetStats() (uint64, uint64) {
	return v.validShares, v.invalidShares
}

// Payout calculator mock implementations

func NewMockPayoutCalculator() *MockPayoutCalculator {
	return &MockPayoutCalculator{}
}

func (c *MockPayoutCalculator) CalculatePPLNS(shares []*MockShare, blockReward float64, n int) ([]*MockPayout, error) {
	if len(shares) == 0 {
		return nil, errors.New("no shares provided")
	}
	
	// Simple PPLNS calculation for testing
	totalDifficulty := float64(0)
	for _, share := range shares {
		totalDifficulty += share.Difficulty
	}
	
	payouts := make([]*MockPayout, 0, len(shares))
	for _, share := range shares {
		payout := &MockPayout{
			WorkerID: share.WorkerID,
			Amount:   (share.Difficulty / totalDifficulty) * blockReward,
		}
		payouts = append(payouts, payout)
	}
	
	return payouts, nil
}

// Stratum server mock implementations

func NewMockStratumServer() *MockStratumServer {
	return &MockStratumServer{
		authenticatedUsers: make(map[string]bool),
	}
}

func (s *MockStratumServer) Authenticate(auth *MockAuthentication) *MockAuthResult {
	// Simple authentication for testing
	if auth.Username == "testuser" && auth.Password == "testpass" {
		s.authenticatedUsers[auth.Username] = true
		return &MockAuthResult{
			Success: true,
			UserID:  auth.Username,
		}
	}
	
	return &MockAuthResult{
		Success: false,
	}
}

// Difficulty adjuster mock implementations

func NewMockDifficultyAdjuster() *MockDifficultyAdjuster {
	return &MockDifficultyAdjuster{
		workerDifficulties: make(map[string]float64),
	}
}

func (a *MockDifficultyAdjuster) RecordShare(workerID string, timestamp time.Time) {
	// Simple difficulty adjustment logic
	currentDiff := a.workerDifficulties[workerID]
	if currentDiff == 0 {
		currentDiff = 1.0
	}
	
	// Increase difficulty slightly
	a.workerDifficulties[workerID] = currentDiff * 1.1
}

func (a *MockDifficultyAdjuster) GetDifficulty(workerID string) float64 {
	diff := a.workerDifficulties[workerID]
	if diff == 0 {
		return 1.0
	}
	return diff
}

// Security manager mock implementations

func NewMockSecurityManager() *MockSecurityManager {
	return &MockSecurityManager{
		rateLimits: make(map[string]int),
		tokens:     make(map[string]string),
	}
}

func (s *MockSecurityManager) GenerateToken(userID string, roles []string) (string, error) {
	token := fmt.Sprintf("mock-token-%s-%d", userID, time.Now().Unix())
	s.tokens[userID] = token
	return token, nil
}

func (s *MockSecurityManager) ValidateToken(token string) (string, error) {
	for userID, userToken := range s.tokens {
		if userToken == token {
			return userID, nil
		}
	}
	return "", errors.New("invalid token")
}

// DDoS protection mock implementations

func NewMockDDoSProtection() *MockDDoSProtection {
	return &MockDDoSProtection{
		blockedIPs: make(map[string]bool),
	}
}

func (d *MockDDoSProtection) CheckRateLimit(ip string) bool {
	// Simple rate limiting for testing
	return !d.blockedIPs[ip]
}

func (d *MockDDoSProtection) BlockIP(ip string) {
	d.blockedIPs[ip] = true
}

// Rate limiter mock implementations

func NewMockRateLimiter() *MockRateLimiter {
	return &MockRateLimiter{
		limits: make(map[string]int),
	}
}

func (r *MockRateLimiter) Allow(key string) bool {
	current := r.limits[key]
	if current >= 5 { // Simple limit of 5 requests
		return false
	}
	r.limits[key] = current + 1
	return true
}

// Helper functions for testing

// SHA256Hash provides SHA256 hashing for testing
func SHA256Hash(data []byte) []byte {
	hash := sha256.Sum256(data)
	return hash[:]
}

// SHA256DoubleHash provides double SHA256 hashing for testing
func SHA256DoubleHash(data []byte) []byte {
	first := sha256.Sum256(data)
	second := sha256.Sum256(first[:])
	return second[:]
}

// CalculateDifficulty calculates difficulty from target for testing
func CalculateDifficulty(target string) (float64, error) {
	if len(target) != 64 {
		return 0, errors.New("invalid target length")
	}
	
	// Simplified difficulty calculation
	// In reality, this would involve big integer math
	leadingZeros := 0
	for i := 0; i < len(target) && target[i] == '0'; i++ {
		leadingZeros++
	}
	
	// Simple approximation based on leading zeros
	difficulty := float64(1)
	for i := 0; i < leadingZeros; i++ {
		difficulty *= 16
	}
	
	return difficulty, nil
}