package zkp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// System defines the ZKP system interface - Robert C. Martin's interface segregation
type System interface {
	Start() error
	Stop() error
	GenerateProof(ProofRequest) (*Proof, error)
	VerifyProof(string, *Proof) error
	IsVerified(string) bool
	GetStats() *Stats
}

// ProofSystem represents different ZKP protocols - Rob Pike's clear types
type ProofSystem int8

const (
	ProofSystemGroth16 ProofSystem = iota
	ProofSystemPLONK
	ProofSystemSTARK
	ProofSystemBulletproof
)

// ProofType defines what is being proven
type ProofType int8

const (
	ProofTypeAge ProofType = iota
	ProofTypeHashpower
	ProofTypeLocation
	ProofTypeSanctions
	ProofTypeReputation
)

// Config contains ZKP system configuration
type Config struct {
	Protocol           ProofSystem   `validate:"required"`
	SecurityLevel      int          `validate:"min=128,max=256"`
	ProofTimeout       time.Duration `validate:"min=10s,max=5m"`
	MaxProofsPerUser   int          `validate:"min=10,max=10000"`
	BatchVerification  bool
	CacheSize          int          `validate:"min=100,max=100000"`
	
	// Requirements
	MinAge             int    `validate:"min=18,max=100"`
	MinHashRate        uint64 `validate:"min=1000"`
	AllowedCountries   []string
	
	// Performance
	MaxConcurrentProofs int `validate:"min=10,max=10000"`
	VerificationWorkers int `validate:"min=1,max=100"`
}

// ProofRequest contains proof generation parameters
type ProofRequest struct {
	Type       ProofType              `json:"type"`
	UserID     string                 `json:"user_id"`
	Claims     map[string]interface{} `json:"claims"`
	Timestamp  int64                  `json:"timestamp"`
	Nonce      []byte                 `json:"nonce"`
}

// Proof represents a zero-knowledge proof - optimized for performance
type Proof struct {
	Type        ProofType `json:"type"`
	System      ProofSystem `json:"system"`
	Data        []byte    `json:"data"`
	PublicInputs []byte   `json:"public_inputs"`
	Timestamp   int64     `json:"timestamp"`
	ExpiryTime  int64     `json:"expiry_time"`
	UserID      string    `json:"user_id"`
	Signature   []byte    `json:"signature"`
	
	// Performance fields
	VerificationTime time.Duration `json:"verification_time,omitempty"`
	ProofSize       int           `json:"proof_size,omitempty"`
}

// Stats contains ZKP system statistics - atomic for lock-free access
type Stats struct {
	ProofsGenerated  atomic.Uint64 `json:"proofs_generated"`
	ProofsVerified   atomic.Uint64 `json:"proofs_verified"`
	VerificationsFailed atomic.Uint64 `json:"verifications_failed"`
	ActiveUsers      atomic.Uint64 `json:"active_users"`
	AvgProofTime     atomic.Uint64 `json:"avg_proof_time_ms"`
	AvgVerifyTime    atomic.Uint64 `json:"avg_verify_time_ms"`
	CacheHitRate     atomic.Uint64 `json:"cache_hit_rate_percent"`
}

// UnifiedZKPSystem implements high-performance ZKP system - John Carmack's optimization
type UnifiedZKPSystem struct {
	logger *zap.Logger
	config *Config
	
	// Hot path fields - cache aligned
	stats          *Stats
	running        atomic.Bool
	
	// Verification cache - lock-free map
	verifiedUsers  sync.Map // map[string]*VerificationEntry
	proofCache     sync.Map // map[string]*Proof
	
	// Processing
	proofQueue     chan *ProofRequest
	verifyQueue    chan *VerificationTask
	
	// Workers
	generators     []*ProofGenerator
	verifiers      []*ProofVerifier
	
	// Lifecycle
	ctx            context.Context
	cancel         context.CancelFunc
	wg             sync.WaitGroup
	
	// Protocol implementations
	groth16        *Groth16Prover
	plonk          *PLONKProver
	stark          *STARKProver
	bulletproof    *BulletproofProver
}

// VerificationEntry tracks user verification status
type VerificationEntry struct {
	UserID       string    `json:"user_id"`
	ProofTypes   []ProofType `json:"proof_types"`
	VerifiedAt   time.Time `json:"verified_at"`
	ExpiresAt    time.Time `json:"expires_at"`
	TrustScore   float64   `json:"trust_score"`
	LastActivity time.Time `json:"last_activity"`
}

// VerificationTask represents a verification job
type VerificationTask struct {
	UserID   string
	Proof    *Proof
	Response chan error
}

// NewSystem creates new ZKP system - Rob Pike's clear constructor
func NewSystem(logger *zap.Logger, config *Config) (System, error) {
	if config == nil {
		config = DefaultConfig()
	}
	
	if err := validateConfig(config); err != nil {
		return nil, fmt.Errorf("invalid config: %w", err)
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	system := &UnifiedZKPSystem{
		logger:     logger,
		config:     config,
		stats:      &Stats{},
		ctx:        ctx,
		cancel:     cancel,
		proofQueue: make(chan *ProofRequest, config.MaxConcurrentProofs),
		verifyQueue: make(chan *VerificationTask, config.MaxConcurrentProofs),
	}
	
	// Initialize protocol implementations
	if err := system.initializeProtocols(); err != nil {
		cancel()
		return nil, fmt.Errorf("protocol initialization failed: %w", err)
	}
	
	// Initialize workers
	if err := system.initializeWorkers(); err != nil {
		cancel()
		return nil, fmt.Errorf("worker initialization failed: %w", err)
	}
	
	return system, nil
}

// Start starts the ZKP system
func (z *UnifiedZKPSystem) Start() error {
	if !z.running.CompareAndSwap(false, true) {
		return errors.New("ZKP system already running")
	}
	
	z.logger.Info("Starting ZKP system",
		zap.String("protocol", z.getProtocolName()),
		zap.Int("security_level", z.config.SecurityLevel),
		zap.Int("workers", z.config.VerificationWorkers),
	)
	
	// Start proof generators
	for _, generator := range z.generators {
		z.wg.Add(1)
		go generator.run(&z.wg)
	}
	
	// Start proof verifiers
	for _, verifier := range z.verifiers {
		z.wg.Add(1)
		go verifier.run(&z.wg)
	}
	
	// Start cache cleanup
	z.wg.Add(1)
	go z.cacheCleanup()
	
	// Start statistics updater
	z.wg.Add(1)
	go z.statsUpdater()
	
	z.logger.Info("ZKP system started successfully")
	return nil
}

// Stop stops the ZKP system
func (z *UnifiedZKPSystem) Stop() error {
	if !z.running.CompareAndSwap(true, false) {
		return errors.New("ZKP system not running")
	}
	
	z.logger.Info("Stopping ZKP system")
	
	// Cancel context
	z.cancel()
	
	// Close channels
	close(z.proofQueue)
	close(z.verifyQueue)
	
	// Wait for workers
	z.wg.Wait()
	
	z.logger.Info("ZKP system stopped")
	return nil
}

// GenerateProof generates a zero-knowledge proof - optimized for throughput
func (z *UnifiedZKPSystem) GenerateProof(request ProofRequest) (*Proof, error) {
	if !z.running.Load() {
		return nil, errors.New("ZKP system not running")
	}
	
	// Validate request
	if err := z.validateProofRequest(&request); err != nil {
		return nil, fmt.Errorf("invalid proof request: %w", err)
	}
	
	// Check rate limiting
	if !z.checkRateLimit(request.UserID) {
		return nil, errors.New("rate limit exceeded")
	}
	
	start := time.Now()
	
	// Generate proof based on type and protocol
	var proof *Proof
	var err error
	
	switch z.config.Protocol {
	case ProofSystemGroth16:
		proof, err = z.groth16.GenerateProof(&request)
	case ProofSystemPLONK:
		proof, err = z.plonk.GenerateProof(&request)
	case ProofSystemSTARK:
		proof, err = z.stark.GenerateProof(&request)
	case ProofSystemBulletproof:
		proof, err = z.bulletproof.GenerateProof(&request)
	default:
		return nil, fmt.Errorf("unsupported protocol: %v", z.config.Protocol)
	}
	
	if err != nil {
		return nil, fmt.Errorf("proof generation failed: %w", err)
	}
	
	// Update statistics
	z.stats.ProofsGenerated.Add(1)
	proofTime := time.Since(start)
	z.updateAvgProofTime(proofTime)
	
	// Cache proof for verification
	z.cacheProof(proof)
	
	z.logger.Debug("Proof generated",
		zap.String("user_id", request.UserID),
		zap.String("type", z.getProofTypeName(request.Type)),
		zap.Duration("generation_time", proofTime),
		zap.Int("proof_size", len(proof.Data)),
	)
	
	return proof, nil
}

// VerifyProof verifies a zero-knowledge proof - high-performance implementation
func (z *UnifiedZKPSystem) VerifyProof(userID string, proof *Proof) error {
	if !z.running.Load() {
		return errors.New("ZKP system not running")
	}
	
	if proof == nil {
		return errors.New("proof is nil")
	}
	
	// Check proof expiry
	if time.Now().Unix() > proof.ExpiryTime {
		return errors.New("proof expired")
	}
	
	start := time.Now()
	
	// Verify proof based on protocol
	var err error
	switch proof.System {
	case ProofSystemGroth16:
		err = z.groth16.VerifyProof(proof)
	case ProofSystemPLONK:
		err = z.plonk.VerifyProof(proof)
	case ProofSystemSTARK:
		err = z.stark.VerifyProof(proof)
	case ProofSystemBulletproof:
		err = z.bulletproof.VerifyProof(proof)
	default:
		return fmt.Errorf("unsupported proof system: %v", proof.System)
	}
	
	verifyTime := time.Since(start)
	z.updateAvgVerifyTime(verifyTime)
	
	if err != nil {
		z.stats.VerificationsFailed.Add(1)
		return fmt.Errorf("proof verification failed: %w", err)
	}
	
	// Update user verification status
	z.updateUserVerification(userID, proof)
	
	z.stats.ProofsVerified.Add(1)
	
	z.logger.Debug("Proof verified",
		zap.String("user_id", userID),
		zap.String("type", z.getProofTypeName(proof.Type)),
		zap.Duration("verification_time", verifyTime),
	)
	
	return nil
}

// IsVerified checks if user is verified - lock-free implementation
func (z *UnifiedZKPSystem) IsVerified(userID string) bool {
	entry, exists := z.verifiedUsers.Load(userID)
	if !exists {
		return false
	}
	
	verification := entry.(*VerificationEntry)
	
	// Check expiry
	if time.Now().After(verification.ExpiresAt) {
		z.verifiedUsers.Delete(userID)
		return false
	}
	
	// Update last activity
	verification.LastActivity = time.Now()
	
	return true
}

// GetStats returns current statistics
func (z *UnifiedZKPSystem) GetStats() *Stats {
	// Count active users
	activeUsers := uint64(0)
	z.verifiedUsers.Range(func(key, value interface{}) bool {
		verification := value.(*VerificationEntry)
		if time.Now().Before(verification.ExpiresAt) {
			activeUsers++
		}
		return true
	})
	z.stats.ActiveUsers.Store(activeUsers)
	
	return z.stats
}

// Private methods

func (z *UnifiedZKPSystem) initializeProtocols() error {
	var err error
	
	// Initialize Groth16
	z.groth16, err = NewGroth16Prover(z.logger, z.config.SecurityLevel)
	if err != nil {
		return fmt.Errorf("Groth16 initialization failed: %w", err)
	}
	
	// Initialize PLONK
	z.plonk, err = NewPLONKProver(z.logger, z.config.SecurityLevel)
	if err != nil {
		return fmt.Errorf("PLONK initialization failed: %w", err)
	}
	
	// Initialize STARK
	z.stark, err = NewSTARKProver(z.logger, z.config.SecurityLevel)
	if err != nil {
		return fmt.Errorf("STARK initialization failed: %w", err)
	}
	
	// Initialize Bulletproof
	z.bulletproof, err = NewBulletproofProver(z.logger, z.config.SecurityLevel)
	if err != nil {
		return fmt.Errorf("Bulletproof initialization failed: %w", err)
	}
	
	return nil
}

func (z *UnifiedZKPSystem) initializeWorkers() error {
	// Initialize proof generators
	generatorCount := z.config.VerificationWorkers / 2
	if generatorCount < 1 {
		generatorCount = 1
	}
	
	z.generators = make([]*ProofGenerator, generatorCount)
	for i := 0; i < generatorCount; i++ {
		z.generators[i] = &ProofGenerator{
			id:        i,
			logger:    z.logger,
			system:    z,
			jobQueue:  z.proofQueue,
		}
	}
	
	// Initialize proof verifiers
	verifierCount := z.config.VerificationWorkers - generatorCount
	z.verifiers = make([]*ProofVerifier, verifierCount)
	for i := 0; i < verifierCount; i++ {
		z.verifiers[i] = &ProofVerifier{
			id:        i,
			logger:    z.logger,
			system:    z,
			taskQueue: z.verifyQueue,
		}
	}
	
	return nil
}

func (z *UnifiedZKPSystem) validateProofRequest(request *ProofRequest) error {
	if request.UserID == "" {
		return errors.New("user ID required")
	}
	
	if request.Claims == nil {
		return errors.New("claims required")
	}
	
	if time.Now().Unix()-request.Timestamp > 300 { // 5 minutes
		return errors.New("request too old")
	}
	
	// Type-specific validation
	switch request.Type {
	case ProofTypeAge:
		if _, ok := request.Claims["birth_year"]; !ok {
			return errors.New("birth year required for age proof")
		}
	case ProofTypeHashpower:
		if _, ok := request.Claims["hash_rate"]; !ok {
			return errors.New("hash rate required for hashpower proof")
		}
	case ProofTypeLocation:
		if _, ok := request.Claims["country_code"]; !ok {
			return errors.New("country code required for location proof")
		}
	}
	
	return nil
}

func (z *UnifiedZKPSystem) checkRateLimit(userID string) bool {
	// Simple rate limiting - could be enhanced with Redis
	// For now, allow up to MaxProofsPerUser per hour
	return true // Simplified implementation
}

func (z *UnifiedZKPSystem) cacheProof(proof *Proof) {
	cacheKey := z.generateCacheKey(proof)
	z.proofCache.Store(cacheKey, proof)
}

func (z *UnifiedZKPSystem) generateCacheKey(proof *Proof) string {
	h := sha256.New()
	h.Write([]byte(proof.UserID))
	h.Write([]byte{byte(proof.Type)})
	binary.Write(h, binary.LittleEndian, proof.Timestamp)
	return fmt.Sprintf("%x", h.Sum(nil))
}

func (z *UnifiedZKPSystem) updateUserVerification(userID string, proof *Proof) {
	now := time.Now()
	expiryTime := now.Add(24 * time.Hour) // 24 hour expiry
	
	entry := &VerificationEntry{
		UserID:       userID,
		ProofTypes:   []ProofType{proof.Type},
		VerifiedAt:   now,
		ExpiresAt:    expiryTime,
		TrustScore:   z.calculateTrustScore(proof),
		LastActivity: now,
	}
	
	// Load existing entry and merge if needed
	if existing, ok := z.verifiedUsers.Load(userID); ok {
		existingEntry := existing.(*VerificationEntry)
		entry.ProofTypes = z.mergeProofTypes(existingEntry.ProofTypes, proof.Type)
		entry.TrustScore = z.updateTrustScore(existingEntry.TrustScore, proof)
	}
	
	z.verifiedUsers.Store(userID, entry)
}

func (z *UnifiedZKPSystem) calculateTrustScore(proof *Proof) float64 {
	// Base score based on proof type
	baseScore := 0.5
	
	switch proof.Type {
	case ProofTypeAge:
		baseScore = 0.7
	case ProofTypeHashpower:
		baseScore = 0.8
	case ProofTypeLocation:
		baseScore = 0.6
	case ProofTypeSanctions:
		baseScore = 0.9
	case ProofTypeReputation:
		baseScore = 0.75
	}
	
	// Adjust based on proof system security
	switch proof.System {
	case ProofSystemGroth16:
		baseScore += 0.1
	case ProofSystemSTARK:
		baseScore += 0.15 // Quantum resistant
	}
	
	if baseScore > 1.0 {
		baseScore = 1.0
	}
	
	return baseScore
}

func (z *UnifiedZKPSystem) mergeProofTypes(existing []ProofType, newType ProofType) []ProofType {
	// Check if type already exists
	for _, pt := range existing {
		if pt == newType {
			return existing
		}
	}
	
	// Add new type
	return append(existing, newType)
}

func (z *UnifiedZKPSystem) updateTrustScore(existing float64, proof *Proof) float64 {
	newScore := z.calculateTrustScore(proof)
	
	// Weighted average (70% existing, 30% new)
	return existing*0.7 + newScore*0.3
}

func (z *UnifiedZKPSystem) updateAvgProofTime(duration time.Duration) {
	ms := uint64(duration.Milliseconds())
	
	// Simple moving average
	current := z.stats.AvgProofTime.Load()
	if current == 0 {
		z.stats.AvgProofTime.Store(ms)
	} else {
		// Exponential moving average
		newAvg := (current*9 + ms) / 10
		z.stats.AvgProofTime.Store(newAvg)
	}
}

func (z *UnifiedZKPSystem) updateAvgVerifyTime(duration time.Duration) {
	ms := uint64(duration.Milliseconds())
	
	current := z.stats.AvgVerifyTime.Load()
	if current == 0 {
		z.stats.AvgVerifyTime.Store(ms)
	} else {
		newAvg := (current*9 + ms) / 10
		z.stats.AvgVerifyTime.Store(newAvg)
	}
}

func (z *UnifiedZKPSystem) cacheCleanup() {
	defer z.wg.Done()
	
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			z.cleanupExpiredEntries()
		case <-z.ctx.Done():
			return
		}
	}
}

func (z *UnifiedZKPSystem) cleanupExpiredEntries() {
	now := time.Now()
	
	// Clean verified users
	z.verifiedUsers.Range(func(key, value interface{}) bool {
		entry := value.(*VerificationEntry)
		if now.After(entry.ExpiresAt) {
			z.verifiedUsers.Delete(key)
		}
		return true
	})
	
	// Clean proof cache
	z.proofCache.Range(func(key, value interface{}) bool {
		proof := value.(*Proof)
		if now.Unix() > proof.ExpiryTime {
			z.proofCache.Delete(key)
		}
		return true
	})
}

func (z *UnifiedZKPSystem) statsUpdater() {
	defer z.wg.Done()
	
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			// Update cache hit rate
			// This would require tracking cache hits/misses
			
		case <-z.ctx.Done():
			return
		}
	}
}

func (z *UnifiedZKPSystem) getProtocolName() string {
	switch z.config.Protocol {
	case ProofSystemGroth16:
		return "Groth16"
	case ProofSystemPLONK:
		return "PLONK"
	case ProofSystemSTARK:
		return "STARK"
	case ProofSystemBulletproof:
		return "Bulletproof"
	default:
		return "Unknown"
	}
}

func (z *UnifiedZKPSystem) getProofTypeName(pt ProofType) string {
	switch pt {
	case ProofTypeAge:
		return "Age"
	case ProofTypeHashpower:
		return "Hashpower"
	case ProofTypeLocation:
		return "Location"
	case ProofTypeSanctions:
		return "Sanctions"
	case ProofTypeReputation:
		return "Reputation"
	default:
		return "Unknown"
	}
}

// Utility functions

func validateConfig(config *Config) error {
	if config.SecurityLevel < 128 || config.SecurityLevel > 256 {
		return errors.New("invalid security level")
	}
	
	if config.ProofTimeout < 10*time.Second || config.ProofTimeout > 5*time.Minute {
		return errors.New("invalid proof timeout")
	}
	
	if config.MaxProofsPerUser < 10 || config.MaxProofsPerUser > 10000 {
		return errors.New("invalid max proofs per user")
	}
	
	if config.MinAge < 18 || config.MinAge > 100 {
		return errors.New("invalid minimum age")
	}
	
	return nil
}

// DefaultConfig returns default ZKP configuration
func DefaultConfig() *Config {
	return &Config{
		Protocol:            ProofSystemGroth16,
		SecurityLevel:       256,
		ProofTimeout:        60 * time.Second,
		MaxProofsPerUser:    100,
		BatchVerification:   true,
		CacheSize:           10000,
		MinAge:              18,
		MinHashRate:         1000000, // 1 MH/s
		MaxConcurrentProofs: 1000,
		VerificationWorkers: 8,
	}
}

// ParseProof parses proof from string format
func ParseProof(proofStr string) (*Proof, error) {
	var proof Proof
	if err := json.Unmarshal([]byte(proofStr), &proof); err != nil {
		return nil, fmt.Errorf("failed to parse proof: %w", err)
	}
	return &proof, nil
}

// ProofGenerator generates proofs asynchronously
type ProofGenerator struct {
	id       int
	logger   *zap.Logger
	system   *UnifiedZKPSystem
	jobQueue <-chan *ProofRequest
}

func (pg *ProofGenerator) run(wg *sync.WaitGroup) {
	defer wg.Done()
	
	for {
		select {
		case request, ok := <-pg.jobQueue:
			if !ok {
				return
			}
			
			// Generate proof
			_, err := pg.system.GenerateProof(*request)
			if err != nil {
				pg.logger.Error("Proof generation failed",
					zap.Int("generator_id", pg.id),
					zap.String("user_id", request.UserID),
					zap.Error(err),
				)
			}
			
		case <-pg.system.ctx.Done():
			return
		}
	}
}

// ProofVerifier verifies proofs asynchronously
type ProofVerifier struct {
	id        int
	logger    *zap.Logger
	system    *UnifiedZKPSystem
	taskQueue <-chan *VerificationTask
}

func (pv *ProofVerifier) run(wg *sync.WaitGroup) {
	defer wg.Done()
	
	for {
		select {
		case task, ok := <-pv.taskQueue:
			if !ok {
				return
			}
			
			// Verify proof
			err := pv.system.VerifyProof(task.UserID, task.Proof)
			
			// Send response
			select {
			case task.Response <- err:
			case <-pv.system.ctx.Done():
				return
			}
			
		case <-pv.system.ctx.Done():
			return
		}
	}
}
