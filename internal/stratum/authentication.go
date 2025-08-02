package stratum

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/zkp"
	"go.uber.org/zap"
)

// AuthenticationMode represents different authentication modes
type AuthenticationMode string

const (
	AuthModeNone     AuthenticationMode = "none"
	AuthModeStatic   AuthenticationMode = "static"
	AuthModeDynamic  AuthenticationMode = "dynamic"
	AuthModeDatabase AuthenticationMode = "database"
	AuthModeWallet   AuthenticationMode = "wallet"
	AuthModeZKP      AuthenticationMode = "zkp"
)

// StratumRateLimiter implements rate limiting for Stratum connections
type StratumRateLimiter struct {
	maxRate    int
	clients    sync.Map // map[string]*ClientRateLimit
	logger     *zap.Logger
}

// ClientRateLimit tracks rate limiting per client
type ClientRateLimit struct {
	messageCount atomic.Uint64
	lastReset    atomic.Int64
	blocked      atomic.Bool
}

// ReputationManager manages worker reputation scores
type ReputationManager struct {
	scores map[string]float64
	mu     sync.RWMutex
}

// ComplianceChecker checks if operations comply with regulations
type ComplianceChecker struct {
	rules []ComplianceRule
}

// ComplianceRule represents a compliance rule
type ComplianceRule interface {
	Check(workerID string, operation string) (bool, string)
}

// verifyZKPProof verifies Zero Knowledge Proof
func (s *StratumServer) verifyZKPProof(workerName string, proofData map[string]interface{}) (bool, error) {
	proof, ok := proofData["proof"].(string)
	if !ok {
		return false, fmt.Errorf("missing proof")
	}
	
	challenge, ok := proofData["challenge"].(string)
	if !ok {
		return false, fmt.Errorf("missing challenge")
	}
	
	// Verify using the unified ZKP system
	zkpSystem, err := zkp.NewUnifiedZKPKYC(s.logger, nil)
	if err != nil {
		return false, fmt.Errorf("failed to create ZKP system: %w", err)
	}
	
	verificationData := map[string]interface{}{
		"proof": proof,
		"challenge": challenge,
		"worker": workerName,
	}
	
	return zkpSystem.VerifyIdentity(workerName, verificationData)
}

// authenticateWorker performs authentication based on configured mode
func (s *StratumServer) authenticateWorker(workerName, password string, authMode AuthenticationMode) (bool, error) {
	switch authMode {
	case AuthModeNone:
		return true, nil
		
	case AuthModeStatic:
		return s.authenticateStatic(workerName, password)
		
	case AuthModeDynamic:
		return s.authenticateDynamic(workerName, password)
		
	case AuthModeDatabase:
		return s.authenticateDatabase(workerName, password)
		
	case AuthModeWallet:
		return s.authenticateWallet(workerName, password)
		
	case AuthModeZKP:
		return false, fmt.Errorf("use ZKP auth method")
		
	default:
		return false, fmt.Errorf("unknown authentication mode: %s", authMode)
	}
}

// authenticateStatic performs static username/password authentication
func (s *StratumServer) authenticateStatic(workerName, password string) (bool, error) {
	if s.config.Username == "" {
		return true, nil
	}
	
	expectedHash := sha256.Sum256([]byte(s.config.Password))
	providedHash := sha256.Sum256([]byte(password))
	
	if subtle.ConstantTimeCompare(expectedHash[:], providedHash[:]) == 1 {
		return true, nil
	}
	
	return false, fmt.Errorf("invalid credentials")
}

// authenticateDynamic performs dynamic token-based authentication
func (s *StratumServer) authenticateDynamic(workerName, token string) (bool, error) {
	now := time.Now().Unix()
	window := int64(300) // 5 minute window
	
	for i := int64(-1); i <= 1; i++ {
		timestamp := now + (i * window)
		expectedToken := s.generateDynamicToken(workerName, timestamp)
		
		if subtle.ConstantTimeCompare([]byte(expectedToken), []byte(token)) == 1 {
			return true, nil
		}
	}
	
	return false, fmt.Errorf("invalid or expired token")
}

// generateDynamicToken generates a time-based token
func (s *StratumServer) generateDynamicToken(workerName string, timestamp int64) string {
	data := fmt.Sprintf("%s:%d:%s", workerName, timestamp, s.config.Secret)
	hash := sha256.Sum256([]byte(data))
	return hex.EncodeToString(hash[:])
}

// authenticateDatabase performs database-backed authentication
func (s *StratumServer) authenticateDatabase(workerName, password string) (bool, error) {
	// Simple in-memory database simulation for now
	// In production, this would use a real database
	s.authMu.RLock()
	defer s.authMu.RUnlock()
	
	if storedPass, exists := s.authDatabase[workerName]; exists {
		expectedHash := sha256.Sum256([]byte(storedPass))
		providedHash := sha256.Sum256([]byte(password))
		
		if subtle.ConstantTimeCompare(expectedHash[:], providedHash[:]) == 1 {
			return true, nil
		}
	}
	
	return false, fmt.Errorf("invalid credentials")
}

// authenticateWallet performs wallet signature-based authentication
func (s *StratumServer) authenticateWallet(workerName, signature string) (bool, error) {
	// Verify wallet signature
	// The signature should be the worker's wallet address signed with their private key
	// For now, we'll implement a simple verification
	
	// Extract wallet address from worker name (format: wallet.worker)
	if len(workerName) < 20 {
		return false, fmt.Errorf("invalid wallet format")
	}
	
	// In production, this would verify the signature against the wallet's public key
	// For now, we'll do a simple check
	challenge := fmt.Sprintf("otedama-auth:%s:%d", workerName, time.Now().Unix()/300)
	expectedSig := sha256.Sum256([]byte(challenge + s.config.Secret))
	
	providedSig, err := hex.DecodeString(signature)
	if err != nil {
		return false, fmt.Errorf("invalid signature format")
	}
	
	if subtle.ConstantTimeCompare(expectedSig[:], providedSig) == 1 {
		return true, nil
	}
	
	return false, fmt.Errorf("invalid wallet signature")
}

// Rate limiter implementation

// Allow checks if a client can send another message
func (rl *StratumRateLimiter) Allow(clientID string) bool {
	limit, _ := rl.clients.LoadOrStore(clientID, &ClientRateLimit{})
	clientLimit := limit.(*ClientRateLimit)
	
	now := time.Now().Unix()
	lastReset := clientLimit.lastReset.Load()
	
	// Reset counter every minute
	if now-lastReset > 60 {
		clientLimit.messageCount.Store(0)
		clientLimit.lastReset.Store(now)
		clientLimit.blocked.Store(false)
	}
	
	// Check rate limit
	count := clientLimit.messageCount.Add(1)
	if count > uint64(rl.maxRate) {
		clientLimit.blocked.Store(true)
		return false
	}
	
	return true
}

// NewReputationManager creates a new reputation manager
func NewReputationManager() *ReputationManager {
	return &ReputationManager{
		scores: make(map[string]float64),
	}
}

// UpdateScore updates a worker's reputation score
func (rm *ReputationManager) UpdateScore(workerID string, delta float64) {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	
	current := rm.scores[workerID]
	newScore := current + delta
	
	// Clamp between 0 and 100
	if newScore < 0 {
		newScore = 0
	} else if newScore > 100 {
		newScore = 100
	}
	
	rm.scores[workerID] = newScore
}

// GetScore returns a worker's reputation score
func (rm *ReputationManager) GetScore(workerID string) float64 {
	rm.mu.RLock()
	defer rm.mu.RUnlock()
	
	score, exists := rm.scores[workerID]
	if !exists {
		return 50.0 // Default neutral score
	}
	
	return score
}

// NewComplianceChecker creates a new compliance checker
func NewComplianceChecker() *ComplianceChecker {
	return &ComplianceChecker{
		rules: []ComplianceRule{},
	}
}

// CheckCompliance verifies if an operation is compliant
func (cc *ComplianceChecker) CheckCompliance(workerID string, operation string) (bool, []string) {
	var violations []string
	
	for _, rule := range cc.rules {
		compliant, reason := rule.Check(workerID, operation)
		if !compliant {
			violations = append(violations, reason)
		}
	}
	
	return len(violations) == 0, violations
}
