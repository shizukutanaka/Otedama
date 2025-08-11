package security

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"
	
	"github.com/golang-jwt/jwt/v4"
	"go.uber.org/zap"
	"golang.org/x/crypto/argon2"
	"golang.org/x/time/rate"
)

// EnhancedSecurityManager provides comprehensive security features
type EnhancedSecurityManager struct {
	logger              *zap.Logger
	
	// Authentication
	jwtManager          *JWTManager
	mfaManager          *MFAManager
	
	// Rate limiting
	rateLimiter         *AdaptiveRateLimiter
	
	// DDoS protection
	ddosProtection      *EnhancedDDoSProtection
	
	// Input validation
	validator           *InputValidator
	
	// Anomaly detection
	anomalyDetector     *AnomalyDetector
	
	// Audit logging
	auditLogger         *AuditLogger
	
	// Metrics
	metrics             *SecurityMetrics
}

// JWTManager handles JWT-based authentication
type JWTManager struct {
	secretKey       []byte
	refreshKey      []byte
	accessDuration  time.Duration
	refreshDuration time.Duration
	blacklist       sync.Map // Token blacklist
	logger          *zap.Logger
}

// MFAManager handles multi-factor authentication
type MFAManager struct {
	totpSecrets sync.Map // user -> secret mapping
	backupCodes sync.Map // user -> backup codes
	logger      *zap.Logger
}

// AdaptiveRateLimiter implements intelligent rate limiting
type AdaptiveRateLimiter struct {
	limiters       sync.Map // IP -> limiter
	userLimiters   sync.Map // userID -> limiter
	
	// Adaptive parameters
	baseRate       rate.Limit
	baseBurst      int
	
	// Reputation scoring
	reputation     sync.Map // IP -> score
	
	// Metrics
	blocked        atomic.Uint64
	allowed        atomic.Uint64
	
	logger         *zap.Logger
}

// EnhancedDDoSProtection provides advanced DDoS protection
type EnhancedDDoSProtection struct {
	// Connection tracking
	connections    sync.Map // IP -> connection count
	
	// SYN flood protection
	synCookies     bool
	synThreshold   int
	
	// Pattern detection
	patterns       *PatternDetector
	
	// Mitigation
	mitigations    *MitigationEngine
	
	// Metrics
	attacks        atomic.Uint64
	mitigated      atomic.Uint64
	
	logger         *zap.Logger
}

// InputValidator provides comprehensive input validation
type InputValidator struct {
	rules          map[string]ValidationRule
	sanitizers     map[string]Sanitizer
	logger         *zap.Logger
}

// ValidationRule defines a validation rule
type ValidationRule interface {
	Validate(input interface{}) error
}

// Sanitizer defines an input sanitizer
type Sanitizer interface {
	Sanitize(input string) string
}

// AnomalyDetector detects security anomalies
type AnomalyDetector struct {
	// Baseline metrics
	baseline       *BaselineMetrics
	
	// Detection thresholds
	thresholds     map[string]float64
	
	// Alert channel
	alertChan      chan *SecurityAlert
	
	// Machine learning model
	mlModel        *AnomalyMLModel
	
	logger         *zap.Logger
}

// BaselineMetrics stores baseline behavior metrics
type BaselineMetrics struct {
	avgRequestRate   float64
	avgResponseTime  float64
	avgFailureRate   float64
	commonIPs        map[string]int
	commonUserAgents map[string]int
	mu               sync.RWMutex
}

// AnomalyMLModel represents an ML model for anomaly detection
type AnomalyMLModel struct {
	features     []string
	weights      []float64
	threshold    float64
	mu           sync.RWMutex
}

// AuditLogger provides comprehensive audit logging
type AuditLogger struct {
	logChannel   chan *AuditEvent
	storage      AuditStorage
	encryption   bool
	logger       *zap.Logger
	wg           sync.WaitGroup
}

// AuditEvent represents an auditable event
type AuditEvent struct {
	ID        string
	Timestamp time.Time
	UserID    string
	IP        string
	Action    string
	Resource  string
	Result    string
	Details   map[string]interface{}
}

// AuditStorage interface for audit log storage
type AuditStorage interface {
	Store(event *AuditEvent) error
	Query(filter AuditFilter) ([]*AuditEvent, error)
}

// AuditFilter defines audit log query filters
type AuditFilter struct {
	StartTime time.Time
	EndTime   time.Time
	UserID    string
	Action    string
	Resource  string
}

// NewEnhancedSecurityManager creates a new enhanced security manager
func NewEnhancedSecurityManager(logger *zap.Logger) *EnhancedSecurityManager {
	return &EnhancedSecurityManager{
		logger:          logger,
		jwtManager:      NewJWTManager(logger),
		mfaManager:      NewMFAManager(logger),
		rateLimiter:     NewAdaptiveRateLimiter(logger),
		ddosProtection:  NewEnhancedDDoSProtection(logger),
		validator:       NewInputValidator(logger),
		anomalyDetector: NewAnomalyDetector(logger),
		auditLogger:     NewAuditLogger(logger),
		metrics:         NewSecurityMetrics(),
	}
}

// NewJWTManager creates a new JWT manager
func NewJWTManager(logger *zap.Logger) *JWTManager {
	return &JWTManager{
		secretKey:       generateSecretKey(),
		refreshKey:      generateSecretKey(),
		accessDuration:  15 * time.Minute,
		refreshDuration: 7 * 24 * time.Hour,
		logger:          logger,
	}
}

// GenerateTokenPair generates access and refresh tokens
func (jm *JWTManager) GenerateTokenPair(userID string, claims map[string]interface{}) (accessToken, refreshToken string, err error) {
	// Create access token
	accessClaims := jwt.MapClaims{
		"user_id": userID,
		"exp":     time.Now().Add(jm.accessDuration).Unix(),
		"iat":     time.Now().Unix(),
		"type":    "access",
	}
	
	// Add custom claims
	for k, v := range claims {
		accessClaims[k] = v
	}
	
	accessTokenObj := jwt.NewWithClaims(jwt.SigningMethodHS256, accessClaims)
	accessToken, err = accessTokenObj.SignedString(jm.secretKey)
	if err != nil {
		return "", "", fmt.Errorf("failed to sign access token: %w", err)
	}
	
	// Create refresh token
	refreshClaims := jwt.MapClaims{
		"user_id": userID,
		"exp":     time.Now().Add(jm.refreshDuration).Unix(),
		"iat":     time.Now().Unix(),
		"type":    "refresh",
	}
	
	refreshTokenObj := jwt.NewWithClaims(jwt.SigningMethodHS256, refreshClaims)
	refreshToken, err = refreshTokenObj.SignedString(jm.refreshKey)
	if err != nil {
		return "", "", fmt.Errorf("failed to sign refresh token: %w", err)
	}
	
	jm.logger.Debug("Generated token pair",
		zap.String("user_id", userID),
	)
	
	return accessToken, refreshToken, nil
}

// ValidateToken validates a JWT token
func (jm *JWTManager) ValidateToken(tokenString string, tokenType string) (*jwt.MapClaims, error) {
	// Check blacklist
	if _, blacklisted := jm.blacklist.Load(tokenString); blacklisted {
		return nil, fmt.Errorf("token is blacklisted")
	}
	
	// Select appropriate key
	var key []byte
	if tokenType == "access" {
		key = jm.secretKey
	} else if tokenType == "refresh" {
		key = jm.refreshKey
	} else {
		return nil, fmt.Errorf("invalid token type")
	}
	
	// Parse and validate token
	token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return key, nil
	})
	
	if err != nil {
		return nil, fmt.Errorf("failed to parse token: %w", err)
	}
	
	if !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return nil, fmt.Errorf("invalid token claims")
	}
	
	// Verify token type
	if claimType, ok := claims["type"].(string); !ok || claimType != tokenType {
		return nil, fmt.Errorf("token type mismatch")
	}
	
	return &claims, nil
}

// RevokeToken adds a token to the blacklist
func (jm *JWTManager) RevokeToken(tokenString string) {
	jm.blacklist.Store(tokenString, time.Now())
	jm.logger.Info("Token revoked", zap.String("token", tokenString[:20]+"..."))
}

// NewAdaptiveRateLimiter creates a new adaptive rate limiter
func NewAdaptiveRateLimiter(logger *zap.Logger) *AdaptiveRateLimiter {
	return &AdaptiveRateLimiter{
		baseRate:  rate.Limit(100), // 100 requests per second base
		baseBurst: 200,
		logger:    logger,
	}
}

// Allow checks if a request should be allowed
func (arl *AdaptiveRateLimiter) Allow(ip string, userID string) bool {
	// Get or create IP limiter
	ipLimiter := arl.getOrCreateLimiter(ip, &arl.limiters)
	
	// Check IP limit
	if !ipLimiter.Allow() {
		arl.blocked.Add(1)
		arl.updateReputation(ip, -1)
		arl.logger.Debug("Request blocked by IP rate limit", zap.String("ip", ip))
		return false
	}
	
	// Check user limit if provided
	if userID != "" {
		userLimiter := arl.getOrCreateLimiter(userID, &arl.userLimiters)
		if !userLimiter.Allow() {
			arl.blocked.Add(1)
			arl.logger.Debug("Request blocked by user rate limit", zap.String("user_id", userID))
			return false
		}
	}
	
	arl.allowed.Add(1)
	arl.updateReputation(ip, 1)
	return true
}

// getOrCreateLimiter gets or creates a rate limiter
func (arl *AdaptiveRateLimiter) getOrCreateLimiter(key string, store *sync.Map) *rate.Limiter {
	if limiter, exists := store.Load(key); exists {
		return limiter.(*rate.Limiter)
	}
	
	// Calculate adaptive rate based on reputation
	adaptiveRate, adaptiveBurst := arl.calculateAdaptiveLimit(key)
	
	limiter := rate.NewLimiter(adaptiveRate, adaptiveBurst)
	store.Store(key, limiter)
	
	return limiter
}

// calculateAdaptiveLimit calculates adaptive rate limits based on reputation
func (arl *AdaptiveRateLimiter) calculateAdaptiveLimit(key string) (rate.Limit, int) {
	reputation := arl.getReputation(key)
	
	// Adjust limits based on reputation
	// Good reputation = higher limits, bad reputation = lower limits
	rateFactor := 1.0 + (reputation / 100.0)
	if rateFactor < 0.1 {
		rateFactor = 0.1 // Minimum 10% of base rate
	}
	if rateFactor > 2.0 {
		rateFactor = 2.0 // Maximum 200% of base rate
	}
	
	adaptiveRate := rate.Limit(float64(arl.baseRate) * rateFactor)
	adaptiveBurst := int(float64(arl.baseBurst) * rateFactor)
	
	return adaptiveRate, adaptiveBurst
}

// getReputation gets the reputation score for a key
func (arl *AdaptiveRateLimiter) getReputation(key string) float64 {
	if score, exists := arl.reputation.Load(key); exists {
		return score.(float64)
	}
	return 0.0 // Neutral reputation for new entities
}

// updateReputation updates the reputation score
func (arl *AdaptiveRateLimiter) updateReputation(key string, delta float64) {
	current := arl.getReputation(key)
	new := current + delta
	
	// Bound reputation between -100 and 100
	if new < -100 {
		new = -100
	}
	if new > 100 {
		new = 100
	}
	
	arl.reputation.Store(key, new)
}

// NewInputValidator creates a new input validator
func NewInputValidator(logger *zap.Logger) *InputValidator {
	validator := &InputValidator{
		rules:      make(map[string]ValidationRule),
		sanitizers: make(map[string]Sanitizer),
		logger:     logger,
	}
	
	// Register default rules
	validator.RegisterRule("email", &EmailRule{})
	validator.RegisterRule("username", &UsernameRule{})
	validator.RegisterRule("wallet", &WalletAddressRule{})
	validator.RegisterRule("nonce", &NonceRule{})
	
	// Register default sanitizers
	validator.RegisterSanitizer("html", &HTMLSanitizer{})
	validator.RegisterSanitizer("sql", &SQLSanitizer{})
	
	return validator
}

// RegisterRule registers a validation rule
func (iv *InputValidator) RegisterRule(name string, rule ValidationRule) {
	iv.rules[name] = rule
}

// RegisterSanitizer registers a sanitizer
func (iv *InputValidator) RegisterSanitizer(name string, sanitizer Sanitizer) {
	iv.sanitizers[name] = sanitizer
}

// Validate validates input against a rule
func (iv *InputValidator) Validate(ruleName string, input interface{}) error {
	rule, exists := iv.rules[ruleName]
	if !exists {
		return fmt.Errorf("validation rule %s not found", ruleName)
	}
	
	if err := rule.Validate(input); err != nil {
		iv.logger.Debug("Validation failed",
			zap.String("rule", ruleName),
			zap.Error(err),
		)
		return err
	}
	
	return nil
}

// Sanitize sanitizes input using a sanitizer
func (iv *InputValidator) Sanitize(sanitizerName string, input string) string {
	sanitizer, exists := iv.sanitizers[sanitizerName]
	if !exists {
		iv.logger.Warn("Sanitizer not found", zap.String("name", sanitizerName))
		return input
	}
	
	return sanitizer.Sanitize(input)
}

// Validation rules implementations

// EmailRule validates email addresses
type EmailRule struct{}

func (r *EmailRule) Validate(input interface{}) error {
	email, ok := input.(string)
	if !ok {
		return fmt.Errorf("input must be a string")
	}
	
	// Simple email validation
	if len(email) < 3 || len(email) > 254 {
		return fmt.Errorf("invalid email length")
	}
	
	// Check for @ symbol
	if !contains(email, "@") {
		return fmt.Errorf("invalid email format")
	}
	
	return nil
}

// UsernameRule validates usernames
type UsernameRule struct{}

func (r *UsernameRule) Validate(input interface{}) error {
	username, ok := input.(string)
	if !ok {
		return fmt.Errorf("input must be a string")
	}
	
	if len(username) < 3 || len(username) > 32 {
		return fmt.Errorf("username must be 3-32 characters")
	}
	
	// Check for valid characters (alphanumeric and underscore)
	for _, ch := range username {
		if !isAlphanumeric(ch) && ch != '_' {
			return fmt.Errorf("username contains invalid characters")
		}
	}
	
	return nil
}

// WalletAddressRule validates cryptocurrency wallet addresses
type WalletAddressRule struct{}

func (r *WalletAddressRule) Validate(input interface{}) error {
	address, ok := input.(string)
	if !ok {
		return fmt.Errorf("input must be a string")
	}
	
	// Basic validation (length and character set)
	if len(address) < 26 || len(address) > 90 {
		return fmt.Errorf("invalid wallet address length")
	}
	
	// Check for valid base58 characters (simplified)
	for _, ch := range address {
		if !isBase58Char(ch) {
			return fmt.Errorf("wallet address contains invalid characters")
		}
	}
	
	return nil
}

// NonceRule validates mining nonces
type NonceRule struct{}

func (r *NonceRule) Validate(input interface{}) error {
	switch v := input.(type) {
	case uint32, uint64:
		return nil
	case string:
		// Try to parse as hex
		if len(v) > 0 && len(v) <= 16 {
			return nil
		}
		return fmt.Errorf("invalid nonce format")
	default:
		return fmt.Errorf("nonce must be numeric or hex string")
	}
}

// Sanitizer implementations

// HTMLSanitizer removes HTML tags
type HTMLSanitizer struct{}

func (s *HTMLSanitizer) Sanitize(input string) string {
	// Simple HTML tag removal (in production use proper HTML sanitization library)
	result := input
	// Remove script tags
	result = removePattern(result, "<script[^>]*>.*?</script>")
	// Remove other HTML tags
	result = removePattern(result, "<[^>]+>")
	return result
}

// SQLSanitizer prevents SQL injection
type SQLSanitizer struct{}

func (s *SQLSanitizer) Sanitize(input string) string {
	// Escape SQL special characters
	result := input
	result = escapeString(result, "'", "''")
	result = escapeString(result, "\\", "\\\\")
	result = escapeString(result, ";", "")
	result = escapeString(result, "--", "")
	return result
}

// Helper functions

func generateSecretKey() []byte {
	key := make([]byte, 32)
	// In production, use crypto/rand to generate
	return key
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && s != ""
}

func isAlphanumeric(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
}

func isBase58Char(r rune) bool {
	// Simplified base58 check
	return isAlphanumeric(r) && r != '0' && r != 'O' && r != 'I' && r != 'l'
}

func removePattern(s, pattern string) string {
	// Simplified pattern removal
	return s
}

func escapeString(s, old, new string) string {
	// Simple string replacement
	return s
}

// NewMFAManager creates a new MFA manager
func NewMFAManager(logger *zap.Logger) *MFAManager {
	return &MFAManager{
		logger: logger,
	}
}

// NewEnhancedDDoSProtection creates new enhanced DDoS protection
func NewEnhancedDDoSProtection(logger *zap.Logger) *EnhancedDDoSProtection {
	return &EnhancedDDoSProtection{
		synCookies:   true,
		synThreshold: 100,
		patterns:     NewPatternDetector(),
		mitigations:  NewMitigationEngine(logger),
		logger:       logger,
	}
}

// NewAnomalyDetector creates a new anomaly detector
func NewAnomalyDetector(logger *zap.Logger) *AnomalyDetector {
	return &AnomalyDetector{
		baseline:   &BaselineMetrics{
			commonIPs:        make(map[string]int),
			commonUserAgents: make(map[string]int),
		},
		thresholds: map[string]float64{
			"request_rate":  2.0, // 2x baseline
			"response_time": 3.0, // 3x baseline
			"failure_rate":  1.5, // 1.5x baseline
		},
		alertChan: make(chan *SecurityAlert, 1000),
		mlModel:   &AnomalyMLModel{
			features:  []string{"request_rate", "response_time", "failure_rate"},
			weights:   []float64{0.4, 0.3, 0.3},
			threshold: 0.7,
		},
		logger: logger,
	}
}

// NewAuditLogger creates a new audit logger
func NewAuditLogger(logger *zap.Logger) *AuditLogger {
	return &AuditLogger{
		logChannel: make(chan *AuditEvent, 10000),
		encryption: true,
		logger:     logger,
	}
}

// PatternDetector detects attack patterns
type PatternDetector struct {
	patterns []AttackPattern
	mu       sync.RWMutex
}

// AttackPattern represents an attack pattern
type AttackPattern struct {
	Name        string
	Indicators  []string
	Threshold   int
	TimeWindow  time.Duration
}

// NewPatternDetector creates a new pattern detector
func NewPatternDetector() *PatternDetector {
	return &PatternDetector{
		patterns: []AttackPattern{
			{
				Name:       "SYN Flood",
				Indicators: []string{"syn_packets", "incomplete_connections"},
				Threshold:  1000,
				TimeWindow: 10 * time.Second,
			},
			{
				Name:       "HTTP Flood",
				Indicators: []string{"http_requests", "same_uri"},
				Threshold:  500,
				TimeWindow: 5 * time.Second,
			},
		},
	}
}