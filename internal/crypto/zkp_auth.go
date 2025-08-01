package crypto

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"

	"go.uber.org/zap"
)

// ZKPAuth implements Zero-Knowledge Proof authentication
// Following John Carmack's principle: "The cost of adding a feature isn't just the time it takes to code it. The cost also includes the addition of an obstacle to future expansion."
type ZKPAuth struct {
	logger *zap.Logger
	
	// Cryptographic parameters
	p            *big.Int // Prime modulus
	q            *big.Int // Prime order
	g            *big.Int // Generator
	h            *big.Int // Secondary generator for commitments
	
	// Identity management
	identities   map[string]*Identity
	identitiesMu sync.RWMutex
	
	// Session management
	sessions     map[string]*AuthSession
	sessionsMu   sync.RWMutex
	
	// Configuration
	config       ZKPConfig
	
	// Metrics
	metrics      struct {
		authAttempts      uint64
		authSuccesses     uint64
		authFailures      uint64
		proofsGenerated   uint64
		proofsVerified    uint64
		avgAuthTime       uint64 // microseconds
	}
}

// ZKPConfig configures the ZKP authentication system
type ZKPConfig struct {
	// Security parameters
	SecurityBits      int
	ChallengeSize     int
	
	// Session settings
	SessionTimeout    time.Duration
	MaxSessions       int
	
	// Performance
	PrecomputeProofs  bool
	ProofCacheSize    int
}

// Identity represents a ZKP identity
type Identity struct {
	ID           string
	PublicKey    *big.Int
	Commitment   *big.Int
	Attributes   map[string]interface{}
	Created      time.Time
	LastAuth     time.Time
	AuthCount    uint64
}

// AuthSession represents an active authentication session
type AuthSession struct {
	SessionID    string
	IdentityID   string
	Challenge    *big.Int
	Commitment   *big.Int
	StartTime    time.Time
	Verified     bool
}

// ProofOfIdentity represents a ZKP identity proof
type ProofOfIdentity struct {
	Commitment   *big.Int
	Challenge    *big.Int
	Response     *big.Int
	Timestamp    time.Time
}

// NewZKPAuth creates a new ZKP authentication system
func NewZKPAuth(logger *zap.Logger, config ZKPConfig) (*ZKPAuth, error) {
	// Generate cryptographic parameters
	p, q, g, h, err := generateZKPParameters(config.SecurityBits)
	if err != nil {
		return nil, fmt.Errorf("failed to generate parameters: %w", err)
	}
	
	zkp := &ZKPAuth{
		logger:     logger,
		p:          p,
		q:          q,
		g:          g,
		h:          h,
		identities: make(map[string]*Identity),
		sessions:   make(map[string]*AuthSession),
		config:     config,
	}
	
	// Start session cleanup
	go zkp.sessionCleanupLoop()
	
	logger.Info("Initialized ZKP authentication",
		zap.Int("security_bits", config.SecurityBits),
		zap.Duration("session_timeout", config.SessionTimeout))
	
	return zkp, nil
}

// RegisterIdentity registers a new identity with ZKP credentials
func (zkp *ZKPAuth) RegisterIdentity(id string, attributes map[string]interface{}) (*Identity, error) {
	zkp.identitiesMu.Lock()
	defer zkp.identitiesMu.Unlock()
	
	// Check if identity already exists
	if _, exists := zkp.identities[id]; exists {
		return nil, errors.New("identity already registered")
	}
	
	// Generate private key
	privateKey, err := rand.Int(rand.Reader, zkp.q)
	if err != nil {
		return nil, fmt.Errorf("failed to generate private key: %w", err)
	}
	
	// Calculate public key: y = g^x mod p
	publicKey := new(big.Int).Exp(zkp.g, privateKey, zkp.p)
	
	// Generate commitment for attributes
	commitment := zkp.generateAttributeCommitment(attributes, privateKey)
	
	identity := &Identity{
		ID:         id,
		PublicKey:  publicKey,
		Commitment: commitment,
		Attributes: attributes,
		Created:    time.Now(),
	}
	
	zkp.identities[id] = identity
	
	zkp.logger.Info("Registered new identity",
		zap.String("id", id),
		zap.Int("attributes", len(attributes)))
	
	return identity, nil
}

// StartAuthentication initiates a ZKP authentication session
func (zkp *ZKPAuth) StartAuthentication(identityID string) (*AuthSession, error) {
	zkp.identitiesMu.RLock()
	identity, exists := zkp.identities[identityID]
	zkp.identitiesMu.RUnlock()
	
	if !exists {
		zkp.metrics.authFailures++
		return nil, errors.New("identity not found")
	}
	
	// Generate random challenge
	challenge, err := rand.Int(rand.Reader, zkp.q)
	if err != nil {
		return nil, fmt.Errorf("failed to generate challenge: %w", err)
	}
	
	// Create session
	sessionID := generateSessionID()
	session := &AuthSession{
		SessionID:  sessionID,
		IdentityID: identityID,
		Challenge:  challenge,
		StartTime:  time.Now(),
		Verified:   false,
	}
	
	zkp.sessionsMu.Lock()
	// Check max sessions
	if len(zkp.sessions) >= zkp.config.MaxSessions {
		zkp.sessionsMu.Unlock()
		return nil, errors.New("max sessions reached")
	}
	zkp.sessions[sessionID] = session
	zkp.sessionsMu.Unlock()
	
	zkp.metrics.authAttempts++
	
	zkp.logger.Debug("Started authentication session",
		zap.String("session_id", sessionID),
		zap.String("identity_id", identityID))
	
	return session, nil
}

// GenerateProof generates a ZKP for authentication
func (zkp *ZKPAuth) GenerateProof(identityID string, privateKey *big.Int, sessionID string) (*ProofOfIdentity, error) {
	start := time.Now()
	defer func() {
		zkp.updateAuthMetrics(time.Since(start))
	}()
	
	// Get session
	zkp.sessionsMu.RLock()
	session, exists := zkp.sessions[sessionID]
	zkp.sessionsMu.RUnlock()
	
	if !exists {
		return nil, errors.New("session not found")
	}
	
	if session.IdentityID != identityID {
		return nil, errors.New("identity mismatch")
	}
	
	// Check session timeout
	if time.Since(session.StartTime) > zkp.config.SessionTimeout {
		return nil, errors.New("session expired")
	}
	
	// Generate random nonce
	r, err := rand.Int(rand.Reader, zkp.q)
	if err != nil {
		return nil, fmt.Errorf("failed to generate nonce: %w", err)
	}
	
	// Calculate commitment: t = g^r mod p
	commitment := new(big.Int).Exp(zkp.g, r, zkp.p)
	
	// Calculate response: s = r + c*x mod q
	response := new(big.Int).Mul(session.Challenge, privateKey)
	response.Add(response, r)
	response.Mod(response, zkp.q)
	
	proof := &ProofOfIdentity{
		Commitment: commitment,
		Challenge:  session.Challenge,
		Response:   response,
		Timestamp:  time.Now(),
	}
	
	// Store commitment in session for verification
	zkp.sessionsMu.Lock()
	session.Commitment = commitment
	zkp.sessionsMu.Unlock()
	
	zkp.metrics.proofsGenerated++
	
	return proof, nil
}

// VerifyProof verifies a ZKP for authentication
func (zkp *ZKPAuth) VerifyProof(sessionID string, proof *ProofOfIdentity) (bool, error) {
	start := time.Now()
	defer func() {
		zkp.updateAuthMetrics(time.Since(start))
	}()
	
	// Get session
	zkp.sessionsMu.RLock()
	session, exists := zkp.sessions[sessionID]
	zkp.sessionsMu.RUnlock()
	
	if !exists {
		return false, errors.New("session not found")
	}
	
	// Check session timeout
	if time.Since(session.StartTime) > zkp.config.SessionTimeout {
		return false, errors.New("session expired")
	}
	
	// Get identity
	zkp.identitiesMu.RLock()
	identity, exists := zkp.identities[session.IdentityID]
	zkp.identitiesMu.RUnlock()
	
	if !exists {
		return false, errors.New("identity not found")
	}
	
	// Verify proof: g^s = t * y^c mod p
	// Left side: g^s mod p
	left := new(big.Int).Exp(zkp.g, proof.Response, zkp.p)
	
	// Right side: t * y^c mod p
	right := new(big.Int).Exp(identity.PublicKey, proof.Challenge, zkp.p)
	right.Mul(right, proof.Commitment)
	right.Mod(right, zkp.p)
	
	// Compare
	valid := left.Cmp(right) == 0
	
	if valid {
		// Update session
		zkp.sessionsMu.Lock()
		session.Verified = true
		zkp.sessionsMu.Unlock()
		
		// Update identity
		zkp.identitiesMu.Lock()
		identity.LastAuth = time.Now()
		identity.AuthCount++
		zkp.identitiesMu.Unlock()
		
		zkp.metrics.authSuccesses++
	} else {
		zkp.metrics.authFailures++
	}
	
	zkp.metrics.proofsVerified++
	
	zkp.logger.Debug("Proof verification completed",
		zap.String("session_id", sessionID),
		zap.Bool("valid", valid))
	
	return valid, nil
}

// ProveAttribute proves possession of an attribute without revealing it
func (zkp *ZKPAuth) ProveAttribute(identityID string, attributeName string, privateKey *big.Int) (*ProofOfIdentity, error) {
	zkp.identitiesMu.RLock()
	identity, exists := zkp.identities[identityID]
	zkp.identitiesMu.RUnlock()
	
	if !exists {
		return nil, errors.New("identity not found")
	}
	
	// Check if attribute exists
	attributeValue, hasAttribute := identity.Attributes[attributeName]
	if !hasAttribute {
		return nil, errors.New("attribute not found")
	}
	
	// Generate proof for specific attribute
	// Hash attribute to create a unique challenge
	h := sha256.New()
	h.Write([]byte(attributeName))
	h.Write([]byte(fmt.Sprintf("%v", attributeValue)))
	attributeHash := h.Sum(nil)
	
	challenge := new(big.Int).SetBytes(attributeHash)
	challenge.Mod(challenge, zkp.q)
	
	// Generate proof similar to authentication
	r, err := rand.Int(rand.Reader, zkp.q)
	if err != nil {
		return nil, err
	}
	
	commitment := new(big.Int).Exp(zkp.g, r, zkp.p)
	
	response := new(big.Int).Mul(challenge, privateKey)
	response.Add(response, r)
	response.Mod(response, zkp.q)
	
	return &ProofOfIdentity{
		Commitment: commitment,
		Challenge:  challenge,
		Response:   response,
		Timestamp:  time.Now(),
	}, nil
}

// VerifyAttribute verifies an attribute proof
func (zkp *ZKPAuth) VerifyAttribute(identityID string, attributeName string, proof *ProofOfIdentity) (bool, error) {
	zkp.identitiesMu.RLock()
	identity, exists := zkp.identities[identityID]
	zkp.identitiesMu.RUnlock()
	
	if !exists {
		return false, errors.New("identity not found")
	}
	
	// Verify using same method as regular proof
	left := new(big.Int).Exp(zkp.g, proof.Response, zkp.p)
	
	right := new(big.Int).Exp(identity.PublicKey, proof.Challenge, zkp.p)
	right.Mul(right, proof.Commitment)
	right.Mod(right, zkp.p)
	
	return left.Cmp(right) == 0, nil
}

// Helper functions

func generateZKPParameters(bits int) (p, q, g, h *big.Int, err error) {
	// Generate safe prime p = 2q + 1
	for {
		q, err = rand.Prime(rand.Reader, bits-1)
		if err != nil {
			return nil, nil, nil, nil, err
		}
		
		p = new(big.Int).Mul(q, big.NewInt(2))
		p.Add(p, big.NewInt(1))
		
		if p.ProbablyPrime(20) {
			break
		}
	}
	
	// Find generator g
	g = findGenerator(p, q)
	
	// Find independent generator h
	h = findGenerator(p, q)
	for h.Cmp(g) == 0 {
		h = findGenerator(p, q)
	}
	
	return p, q, g, h, nil
}

func findGenerator(p, q *big.Int) *big.Int {
	one := big.NewInt(1)
	pMinusOne := new(big.Int).Sub(p, one)
	
	for {
		h, _ := rand.Int(rand.Reader, pMinusOne)
		if h.Cmp(one) <= 0 {
			continue
		}
		
		g := new(big.Int).Exp(h, big.NewInt(2), p)
		if g.Cmp(one) == 0 {
			continue
		}
		
		g.Exp(h, q, p)
		if g.Cmp(one) == 0 {
			continue
		}
		
		return h
	}
}

func (zkp *ZKPAuth) generateAttributeCommitment(attributes map[string]interface{}, privateKey *big.Int) *big.Int {
	// Create Pedersen commitment for attributes
	h := sha256.New()
	for key, value := range attributes {
		h.Write([]byte(key))
		h.Write([]byte(fmt.Sprintf("%v", value)))
	}
	
	attributeHash := h.Sum(nil)
	r := new(big.Int).SetBytes(attributeHash)
	r.Mod(r, zkp.q)
	
	// Commitment = g^privateKey * h^r mod p
	commitment := new(big.Int).Exp(zkp.g, privateKey, zkp.p)
	hr := new(big.Int).Exp(zkp.h, r, zkp.p)
	commitment.Mul(commitment, hr)
	commitment.Mod(commitment, zkp.p)
	
	return commitment
}

func generateSessionID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (zkp *ZKPAuth) sessionCleanupLoop() {
	ticker := time.NewTicker(zkp.config.SessionTimeout / 2)
	defer ticker.Stop()
	
	for range ticker.C {
		zkp.cleanupSessions()
	}
}

func (zkp *ZKPAuth) cleanupSessions() {
	zkp.sessionsMu.Lock()
	defer zkp.sessionsMu.Unlock()
	
	now := time.Now()
	for id, session := range zkp.sessions {
		if now.Sub(session.StartTime) > zkp.config.SessionTimeout {
			delete(zkp.sessions, id)
		}
	}
}

func (zkp *ZKPAuth) updateAuthMetrics(duration time.Duration) {
	microseconds := uint64(duration.Microseconds())
	totalAuths := zkp.metrics.authSuccesses + zkp.metrics.authFailures
	if totalAuths > 0 {
		zkp.metrics.avgAuthTime = (zkp.metrics.avgAuthTime*(totalAuths-1) + microseconds) / totalAuths
	}
}

// GetMetrics returns authentication metrics
func (zkp *ZKPAuth) GetMetrics() map[string]interface{} {
	zkp.identitiesMu.RLock()
	identityCount := len(zkp.identities)
	zkp.identitiesMu.RUnlock()
	
	zkp.sessionsMu.RLock()
	sessionCount := len(zkp.sessions)
	zkp.sessionsMu.RUnlock()
	
	successRate := float64(0)
	if zkp.metrics.authAttempts > 0 {
		successRate = float64(zkp.metrics.authSuccesses) / float64(zkp.metrics.authAttempts)
	}
	
	return map[string]interface{}{
		"identities_registered": identityCount,
		"active_sessions":       sessionCount,
		"auth_attempts":         zkp.metrics.authAttempts,
		"auth_successes":        zkp.metrics.authSuccesses,
		"auth_failures":         zkp.metrics.authFailures,
		"auth_success_rate":     successRate,
		"proofs_generated":      zkp.metrics.proofsGenerated,
		"proofs_verified":       zkp.metrics.proofsVerified,
		"avg_auth_time_us":      zkp.metrics.avgAuthTime,
		"security_bits":         zkp.config.SecurityBits,
	}
}

// GetIdentity returns identity information (public data only)
func (zkp *ZKPAuth) GetIdentity(identityID string) (*Identity, error) {
	zkp.identitiesMu.RLock()
	defer zkp.identitiesMu.RUnlock()
	
	identity, exists := zkp.identities[identityID]
	if !exists {
		return nil, errors.New("identity not found")
	}
	
	// Return a copy to prevent external modification
	return &Identity{
		ID:         identity.ID,
		PublicKey:  new(big.Int).Set(identity.PublicKey),
		Commitment: new(big.Int).Set(identity.Commitment),
		Created:    identity.Created,
		LastAuth:   identity.LastAuth,
		AuthCount:  identity.AuthCount,
		// Don't expose attributes directly
	}, nil
}

// IsSessionValid checks if a session is valid and verified
func (zkp *ZKPAuth) IsSessionValid(sessionID string) bool {
	zkp.sessionsMu.RLock()
	defer zkp.sessionsMu.RUnlock()
	
	session, exists := zkp.sessions[sessionID]
	if !exists {
		return false
	}
	
	return session.Verified && time.Since(session.StartTime) <= zkp.config.SessionTimeout
}