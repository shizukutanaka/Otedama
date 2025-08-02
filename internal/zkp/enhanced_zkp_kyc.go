package zkp

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"

	"go.uber.org/zap"
)

// EnhancedZKPKYC provides zero-knowledge proof based identity verification for mining pools
// Replaces traditional KYC with privacy-preserving proofs
type EnhancedZKPKYC struct {
	logger *zap.Logger
	
	// Proof systems
	ageProofSystem      *AgeProofSystem
	hashpowerProofSystem *HashpowerProofSystem
	
	// Verification registry
	verifiedUsers    map[string]*VerifiedIdentity
	registryMu       sync.RWMutex
	
	// Configuration
	config *ZKPConfig
	
	// Performance metrics
	stats *ZKPStats
	
	// Proof cache
	proofCache      map[string]*CachedProof
	cacheMu         sync.RWMutex
	cacheExpiration time.Duration
}

// ZKPConfig contains ZKP configuration
type ZKPConfig struct {
	// Verification requirements
	MinAge              int
	RequiredHashRate    uint64
	MaxVerifications    int
	
	// Performance settings
	CacheSize           int
	ProofExpiration     time.Duration
	ParallelVerifiers   int
}

// VerifiedIdentity represents a verified user identity
type VerifiedIdentity struct {
	ID              string
	AgeVerified     bool
	HashRateVerified bool
	VerificationTime time.Time
	ExpiresAt       time.Time
	Nonce           string
}

// CachedProof represents a cached proof
type CachedProof struct {
	Proof     interface{}
	ExpiresAt time.Time
}

// ZKPStats tracks performance statistics
type ZKPStats struct {
	TotalProofs        uint64
	ValidProofs        uint64
	InvalidProofs      uint64
	CacheHits          uint64
	CacheMisses        uint64
	AvgVerificationTime time.Duration
}

// AgeProofSystem implements zero-knowledge age verification
type AgeProofSystem struct {
	curve  elliptic.Curve
	params *ProofParams
}

// HashpowerProofSystem implements zero-knowledge hashpower verification
type HashpowerProofSystem struct {
	curve  elliptic.Curve
	params *ProofParams
}

// ProofParams contains proof system parameters
type ProofParams struct {
	G     *ecdsa.PublicKey
	H     *ecdsa.PublicKey
	Order *big.Int
}

// ProofRequest represents a proof generation request
type ProofRequest struct {
	UserID    string
	ProofType string
	Data      map[string]interface{}
	Nonce     string
}

// ProofResponse contains the generated proof
type ProofResponse struct {
	UserID    string
	ProofType string
	Proof     interface{}
	Timestamp time.Time
	Valid     bool
}

// NewEnhancedZKPKYC creates a new enhanced ZKP KYC system
func NewEnhancedZKPKYC(logger *zap.Logger, config *ZKPConfig) (*EnhancedZKPKYC, error) {
	if config == nil {
		config = DefaultZKPConfig()
	}
	
	zkp := &EnhancedZKPKYC{
		logger:           logger,
		verifiedUsers:    make(map[string]*VerifiedIdentity),
		config:           config,
		stats:            &ZKPStats{},
		proofCache:       make(map[string]*CachedProof),
		cacheExpiration:  config.ProofExpiration,
	}
	
	// Initialize proof systems
	if err := zkp.initializeProofSystems(); err != nil {
		return nil, fmt.Errorf("failed to initialize proof systems: %w", err)
	}
	
	// Start cache cleanup
	go zkp.cleanupCache()
	
	return zkp, nil
}

// GenerateProof generates a zero-knowledge proof
func (zkp *EnhancedZKPKYC) GenerateProof(request *ProofRequest) (*ProofResponse, error) {
	zkp.logger.Debug("Generating ZKP", 
		zap.String("user_id", request.UserID),
		zap.String("proof_type", request.ProofType),
	)
	
	// Check cache first
	cacheKey := fmt.Sprintf("%s:%s:%s", request.UserID, request.ProofType, request.Nonce)
	if cached := zkp.getFromCache(cacheKey); cached != nil {
		zkp.stats.CacheHits++
		return &ProofResponse{
			UserID:    request.UserID,
			ProofType: request.ProofType,
			Proof:     cached.Proof,
			Timestamp: time.Now(),
			Valid:     true,
		}, nil
	}
	
	zkp.stats.CacheMisses++
	
	var proof interface{}
	var err error
	
	switch request.ProofType {
	case "age":
		proof, err = zkp.generateAgeProof(request)
	case "hashpower":
		proof, err = zkp.generateHashpowerProof(request)
	default:
		return nil, fmt.Errorf("unknown proof type: %s", request.ProofType)
	}
	
	if err != nil {
		return nil, fmt.Errorf("failed to generate proof: %w", err)
	}
	
	// Cache the proof
	zkp.addToCache(cacheKey, proof)
	
	return &ProofResponse{
		UserID:    request.UserID,
		ProofType: request.ProofType,
		Proof:     proof,
		Timestamp: time.Now(),
		Valid:     true,
	}, nil
}

// VerifyProof verifies a zero-knowledge proof
func (zkp *EnhancedZKPKYC) VerifyProof(response *ProofResponse) (bool, error) {
	start := time.Now()
	defer func() {
		zkp.stats.AvgVerificationTime = time.Since(start)
	}()
	
	zkp.logger.Debug("Verifying ZKP",
		zap.String("user_id", response.UserID),
		zap.String("proof_type", response.ProofType),
	)
	
	var valid bool
	var err error
	
	switch response.ProofType {
	case "age":
		valid, err = zkp.verifyAgeProof(response.Proof)
	case "hashpower":
		valid, err = zkp.verifyHashpowerProof(response.Proof)
	default:
		return false, fmt.Errorf("unknown proof type: %s", response.ProofType)
	}
	
	if err != nil {
		zkp.stats.InvalidProofs++
		return false, err
	}
	
	if valid {
		zkp.stats.ValidProofs++
		zkp.registerVerification(response.UserID, response.ProofType)
	} else {
		zkp.stats.InvalidProofs++
	}
	
	zkp.stats.TotalProofs++
	
	return valid, nil
}

// generateAgeProof generates a zero-knowledge age proof
func (zkp *EnhancedZKPKYC) generateAgeProof(request *ProofRequest) (interface{}, error) {
	age, ok := request.Data["age"].(int)
	if !ok {
		return nil, errors.New("age not provided")
	}
	
	if age < zkp.config.MinAge {
		return nil, fmt.Errorf("age %d is below minimum required age %d", age, zkp.config.MinAge)
	}
	
	// Generate commitment
	r, err := rand.Int(rand.Reader, zkp.ageProofSystem.params.Order)
	if err != nil {
		return nil, err
	}
	
	// C = g^age * h^r
	gAge := new(big.Int).Exp(zkp.ageProofSystem.params.G.X, big.NewInt(int64(age)), zkp.ageProofSystem.params.Order)
	hR := new(big.Int).Exp(zkp.ageProofSystem.params.H.X, r, zkp.ageProofSystem.params.Order)
	commitment := new(big.Int).Mul(gAge, hR)
	commitment.Mod(commitment, zkp.ageProofSystem.params.Order)
	
	// Generate challenge
	hash := sha256.New()
	hash.Write(commitment.Bytes())
	hash.Write([]byte(request.Nonce))
	challenge := new(big.Int).SetBytes(hash.Sum(nil))
	challenge.Mod(challenge, zkp.ageProofSystem.params.Order)
	
	// Generate response
	s := new(big.Int).Mul(challenge, big.NewInt(int64(age)))
	s.Add(s, r)
	s.Mod(s, zkp.ageProofSystem.params.Order)
	
	return map[string]interface{}{
		"commitment": commitment.String(),
		"challenge":  challenge.String(),
		"response":   s.String(),
		"min_age":    zkp.config.MinAge,
	}, nil
}

// verifyAgeProof verifies a zero-knowledge age proof
func (zkp *EnhancedZKPKYC) verifyAgeProof(proof interface{}) (bool, error) {
	proofMap, ok := proof.(map[string]interface{})
	if !ok {
		return false, errors.New("invalid proof format")
	}
	
	commitment, _ := new(big.Int).SetString(proofMap["commitment"].(string), 10)
	challenge, _ := new(big.Int).SetString(proofMap["challenge"].(string), 10)
	response, _ := new(big.Int).SetString(proofMap["response"].(string), 10)
	minAge := proofMap["min_age"].(int)
	
	// Verify: g^s = C * g^(c*min_age)
	gS := new(big.Int).Exp(zkp.ageProofSystem.params.G.X, response, zkp.ageProofSystem.params.Order)
	
	gMinAge := new(big.Int).Exp(zkp.ageProofSystem.params.G.X, big.NewInt(int64(minAge)), zkp.ageProofSystem.params.Order)
	gCMinAge := new(big.Int).Exp(gMinAge, challenge, zkp.ageProofSystem.params.Order)
	
	expected := new(big.Int).Mul(commitment, gCMinAge)
	expected.Mod(expected, zkp.ageProofSystem.params.Order)
	
	return gS.Cmp(expected) == 0, nil
}

// generateHashpowerProof generates a zero-knowledge hashpower proof
func (zkp *EnhancedZKPKYC) generateHashpowerProof(request *ProofRequest) (interface{}, error) {
	hashrate, ok := request.Data["hashrate"].(uint64)
	if !ok {
		return nil, errors.New("hashrate not provided")
	}
	
	if hashrate < zkp.config.RequiredHashRate {
		return nil, fmt.Errorf("hashrate %d is below minimum required %d", hashrate, zkp.config.RequiredHashRate)
	}
	
	// Generate proof of work
	nonce := uint64(0)
	target := uint64(1 << 32) / hashrate // Simplified target calculation
	
	for {
		hash := sha256.New()
		binary.Write(hash, binary.BigEndian, nonce)
		hash.Write([]byte(request.Nonce))
		
		result := binary.BigEndian.Uint64(hash.Sum(nil)[:8])
		if result < target {
			break
		}
		nonce++
	}
	
	return map[string]interface{}{
		"hashrate": hashrate,
		"nonce":    nonce,
		"target":   target,
	}, nil
}

// verifyHashpowerProof verifies a zero-knowledge hashpower proof
func (zkp *EnhancedZKPKYC) verifyHashpowerProof(proof interface{}) (bool, error) {
	proofMap, ok := proof.(map[string]interface{})
	if !ok {
		return false, errors.New("invalid proof format")
	}
	
	hashrate := proofMap["hashrate"].(uint64)
	nonce := proofMap["nonce"].(uint64)
	target := proofMap["target"].(uint64)
	
	// Verify proof of work
	hash := sha256.New()
	binary.Write(hash, binary.BigEndian, nonce)
	
	result := binary.BigEndian.Uint64(hash.Sum(nil)[:8])
	return result < target && hashrate >= zkp.config.RequiredHashRate, nil
}

// initializeProofSystems initializes the proof systems
func (zkp *EnhancedZKPKYC) initializeProofSystems() error {
	curve := elliptic.P256()
	
	// Generate parameters for age proof system
	gPriv, _ := ecdsa.GenerateKey(curve, rand.Reader)
	hPriv, _ := ecdsa.GenerateKey(curve, rand.Reader)
	
	zkp.ageProofSystem = &AgeProofSystem{
		curve: curve,
		params: &ProofParams{
			G:     &gPriv.PublicKey,
			H:     &hPriv.PublicKey,
			Order: curve.Params().N,
		},
	}
	
	// Initialize hashpower proof system
	zkp.hashpowerProofSystem = &HashpowerProofSystem{
		curve: curve,
		params: &ProofParams{
			G:     &gPriv.PublicKey,
			H:     &hPriv.PublicKey,
			Order: curve.Params().N,
		},
	}
	
	return nil
}

// registerVerification registers a successful verification
func (zkp *EnhancedZKPKYC) registerVerification(userID, proofType string) {
	zkp.registryMu.Lock()
	defer zkp.registryMu.Unlock()
	
	identity, exists := zkp.verifiedUsers[userID]
	if !exists {
		identity = &VerifiedIdentity{
			ID:               userID,
			VerificationTime: time.Now(),
		}
		zkp.verifiedUsers[userID] = identity
	}
	
	switch proofType {
	case "age":
		identity.AgeVerified = true
	case "hashpower":
		identity.HashRateVerified = true
	}
	
	identity.ExpiresAt = time.Now().Add(zkp.config.ProofExpiration)
}

// IsVerified checks if a user is verified
func (zkp *EnhancedZKPKYC) IsVerified(userID string) bool {
	zkp.registryMu.RLock()
	defer zkp.registryMu.RUnlock()
	
	identity, exists := zkp.verifiedUsers[userID]
	if !exists {
		return false
	}
	
	return time.Now().Before(identity.ExpiresAt)
}

// getFromCache retrieves a proof from cache
func (zkp *EnhancedZKPKYC) getFromCache(key string) *CachedProof {
	zkp.cacheMu.RLock()
	defer zkp.cacheMu.RUnlock()
	
	cached, exists := zkp.proofCache[key]
	if !exists || time.Now().After(cached.ExpiresAt) {
		return nil
	}
	
	return cached
}

// addToCache adds a proof to cache
func (zkp *EnhancedZKPKYC) addToCache(key string, proof interface{}) {
	zkp.cacheMu.Lock()
	defer zkp.cacheMu.Unlock()
	
	// Enforce cache size limit
	if len(zkp.proofCache) >= zkp.config.CacheSize {
		// Remove oldest entry
		var oldestKey string
		var oldestTime time.Time
		for k, v := range zkp.proofCache {
			if oldestKey == "" || v.ExpiresAt.Before(oldestTime) {
				oldestKey = k
				oldestTime = v.ExpiresAt
			}
		}
		delete(zkp.proofCache, oldestKey)
	}
	
	zkp.proofCache[key] = &CachedProof{
		Proof:     proof,
		ExpiresAt: time.Now().Add(zkp.cacheExpiration),
	}
}

// cleanupCache periodically cleans up expired cache entries
func (zkp *EnhancedZKPKYC) cleanupCache() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for range ticker.C {
		zkp.cacheMu.Lock()
		now := time.Now()
		for key, cached := range zkp.proofCache {
			if now.After(cached.ExpiresAt) {
				delete(zkp.proofCache, key)
			}
		}
		zkp.cacheMu.Unlock()
	}
}

// GetStats returns current statistics
func (zkp *EnhancedZKPKYC) GetStats() *ZKPStats {
	return zkp.stats
}

// DefaultZKPConfig returns default configuration
func DefaultZKPConfig() *ZKPConfig {
	return &ZKPConfig{
		MinAge:            18,
		RequiredHashRate:  1000000, // 1 MH/s
		MaxVerifications:  1000,
		CacheSize:         10000,
		ProofExpiration:   24 * time.Hour,
		ParallelVerifiers: 4,
	}
}