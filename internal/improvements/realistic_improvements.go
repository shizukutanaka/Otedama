package improvements

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
	"golang.org/x/time/rate"
	"go.uber.org/zap"
)

// RealisticImprovementManager manages practical, immediately implementable improvements
type RealisticImprovementManager struct {
	logger         *zap.Logger
	config         *Config
	rateLimiter    *RateLimiter
	sessionManager *SessionManager
	validator      *InputValidator
	errorHandler   *ErrorHandler
}

// NewRealisticImprovementManager creates a manager for realistic improvements
func NewRealisticImprovementManager(logger *zap.Logger) *RealisticImprovementManager {
	return &RealisticImprovementManager{
		logger:         logger,
		config:         NewConfig(),
		rateLimiter:    NewRateLimiter(),
		sessionManager: NewSessionManager(),
		validator:      NewInputValidator(),
		errorHandler:   NewErrorHandler(logger),
	}
}

// ========================================
// 1. CONFIGURATION MANAGEMENT (現実的)
// ========================================

type Config struct {
	JWTSecret     string
	PoolPassword  string
	DatabaseURL   string
	RedisURL      string
	mu            sync.RWMutex
}

func NewConfig() *Config {
	return &Config{
		JWTSecret:    getEnvOrGenerate("JWT_SECRET", 32),
		PoolPassword: getEnvOrDefault("POOL_PASSWORD", ""),
		DatabaseURL:  getEnvOrDefault("DATABASE_URL", "postgres://localhost/otedama"),
		RedisURL:     getEnvOrDefault("REDIS_URL", "redis://localhost:6379"),
	}
}

func getEnvOrDefault(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvOrGenerate(key string, length int) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	// Generate secure random key
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		panic(fmt.Sprintf("Failed to generate %s: %v", key, err))
	}
	return base64.StdEncoding.EncodeToString(bytes)
}

// ========================================
// 2. RATE LIMITING (現実的)
// ========================================

type RateLimiter struct {
	limiters map[string]*rate.Limiter
	mu       sync.RWMutex
}

func NewRateLimiter() *RateLimiter {
	return &RateLimiter{
		limiters: make(map[string]*rate.Limiter),
	}
}

func (rl *RateLimiter) Allow(clientID string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	limiter, exists := rl.limiters[clientID]
	if !exists {
		// 10 requests per second, burst of 20
		limiter = rate.NewLimiter(10, 20)
		rl.limiters[clientID] = limiter
	}

	return limiter.Allow()
}

func (rl *RateLimiter) Cleanup() {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	
	// Clean up old limiters periodically
	rl.limiters = make(map[string]*rate.Limiter)
}

// ========================================
// 3. SESSION MANAGEMENT (現実的)
// ========================================

type Session struct {
	ID        string
	UserID    string
	CreatedAt time.Time
	ExpiresAt time.Time
	CSRFToken string
}

type RealisticSessionManager struct {
	sessions map[string]*RealisticSession
	mu       sync.RWMutex
}

func NewRealisticSessionManager() *RealisticSessionManager {
	sm := &RealisticSessionManager{
		sessions: make(map[string]*RealisticSession),
	}
	
	// Clean up expired sessions every hour
	go sm.cleanupExpiredSessions()
	
	return sm
}

func (sm *RealisticSessionManager) CreateSession(userID string) (*RealisticSession, error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	sessionID := generateSecureToken(32)
	csrfToken := generateSecureToken(32)

	session := &Session{
		ID:        sessionID,
		UserID:    userID,
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(24 * time.Hour),
		CSRFToken: csrfToken,
	}

	sm.sessions[sessionID] = session
	return session, nil
}

func (sm *RealisticSessionManager) GetSession(sessionID string) (*RealisticSession, error) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	session, exists := sm.sessions[sessionID]
	if !exists {
		return nil, errors.New("session not found")
	}

	if time.Now().After(session.ExpiresAt) {
		delete(sm.sessions, sessionID)
		return nil, errors.New("session expired")
	}

	return session, nil
}

func (sm *RealisticSessionManager) cleanupExpiredSessions() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	for range ticker.C {
		sm.mu.Lock()
		now := time.Now()
		for id, session := range sm.sessions {
			if now.After(session.ExpiresAt) {
				delete(sm.sessions, id)
			}
		}
		sm.mu.Unlock()
	}
}

func generateSecureToken(length int) string {
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return ""
	}
	return base64.URLEncoding.EncodeToString(bytes)
}

// ========================================
// 4. INPUT VALIDATION (現実的)
// ========================================

type InputValidator struct {
	logger *zap.Logger
}

func NewInputValidator() *InputValidator {
	logger, _ := zap.NewProduction()
	return &InputValidator{logger: logger}
}

func (v *InputValidator) ValidateEmail(email string) error {
	if len(email) < 3 || len(email) > 254 {
		return errors.New("invalid email length")
	}
	// Simple email validation
	if !contains(email, "@") || !contains(email, ".") {
		return errors.New("invalid email format")
	}
	return nil
}

func (v *InputValidator) ValidatePassword(password string) error {
	if len(password) < 8 {
		return errors.New("password must be at least 8 characters")
	}
	if len(password) > 128 {
		return errors.New("password too long")
	}
	
	// Check complexity
	var hasUpper, hasLower, hasDigit bool
	for _, ch := range password {
		switch {
		case ch >= 'A' && ch <= 'Z':
			hasUpper = true
		case ch >= 'a' && ch <= 'z':
			hasLower = true
		case ch >= '0' && ch <= '9':
			hasDigit = true
		}
	}
	
	if !hasUpper || !hasLower || !hasDigit {
		return errors.New("password must contain uppercase, lowercase, and digit")
	}
	
	return nil
}

func (v *InputValidator) ValidateWalletAddress(address string) error {
	// Basic validation for common crypto addresses
	if len(address) < 26 || len(address) > 90 {
		return errors.New("invalid wallet address length")
	}
	
	// Check for valid characters (alphanumeric)
	for _, ch := range address {
		if !isAlphaNumeric(ch) {
			return errors.New("invalid characters in wallet address")
		}
	}
	
	return nil
}

func (v *InputValidator) SanitizeString(input string) string {
	// Remove potentially dangerous characters
	result := ""
	for _, ch := range input {
		if isAlphaNumeric(ch) || ch == ' ' || ch == '-' || ch == '_' || ch == '.' {
			result += string(ch)
		}
	}
	return result
}

// ========================================
// 5. ERROR HANDLING (現実的)
// ========================================

type ErrorHandler struct {
	logger *zap.Logger
	errors chan ErrorEvent
}

type ErrorEvent struct {
	Error     error
	Level     string
	Context   map[string]interface{}
	Timestamp time.Time
}

func NewErrorHandler(logger *zap.Logger) *ErrorHandler {
	eh := &ErrorHandler{
		logger: logger,
		errors: make(chan ErrorEvent, 100),
	}
	
	go eh.processErrors()
	
	return eh
}

func (eh *ErrorHandler) Handle(err error, level string, context map[string]interface{}) {
	if err == nil {
		return
	}
	
	event := ErrorEvent{
		Error:     err,
		Level:     level,
		Context:   context,
		Timestamp: time.Now(),
	}
	
	select {
	case eh.errors <- event:
	default:
		// Channel full, log directly
		eh.logError(event)
	}
}

func (eh *ErrorHandler) processErrors() {
	for event := range eh.errors {
		eh.logError(event)
	}
}

func (eh *ErrorHandler) logError(event ErrorEvent) {
	fields := []zap.Field{
		zap.Error(event.Error),
		zap.String("level", event.Level),
		zap.Time("timestamp", event.Timestamp),
	}
	
	for k, v := range event.Context {
		fields = append(fields, zap.Any(k, v))
	}
	
	switch event.Level {
	case "critical":
		eh.logger.Error("Critical error", fields...)
	case "warning":
		eh.logger.Warn("Warning", fields...)
	default:
		eh.logger.Info("Info", fields...)
	}
}

// ========================================
// 6. PASSWORD HASHING (現実的)
// ========================================

type PasswordManager struct{}

func NewPasswordManager() *PasswordManager {
	return &PasswordManager{}
}

func (pm *PasswordManager) HashPassword(password string) (string, error) {
	bytes, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(bytes), nil
}

func (pm *PasswordManager) VerifyPassword(password, hash string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
}

// ========================================
// 7. HEALTH CHECK (現実的)
// ========================================

type HealthChecker struct {
	checks map[string]func() error
	mu     sync.RWMutex
}

func NewHealthChecker() *HealthChecker {
	return &HealthChecker{
		checks: make(map[string]func() error),
	}
}

func (hc *HealthChecker) RegisterCheck(name string, check func() error) {
	hc.mu.Lock()
	defer hc.mu.Unlock()
	hc.checks[name] = check
}

func (hc *HealthChecker) CheckHealth() map[string]string {
	hc.mu.RLock()
	defer hc.mu.RUnlock()
	
	results := make(map[string]string)
	
	for name, check := range hc.checks {
		if err := check(); err != nil {
			results[name] = fmt.Sprintf("unhealthy: %v", err)
		} else {
			results[name] = "healthy"
		}
	}
	
	return results
}

// ========================================
// 8. GRACEFUL SHUTDOWN (現実的)
// ========================================

type ShutdownManager struct {
	handlers []func() error
	mu       sync.Mutex
}

func NewShutdownManager() *ShutdownManager {
	return &ShutdownManager{
		handlers: make([]func() error, 0),
	}
}

func (sm *ShutdownManager) RegisterHandler(handler func() error) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.handlers = append(sm.handlers, handler)
}

func (sm *ShutdownManager) Shutdown(ctx context.Context) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	
	var wg sync.WaitGroup
	errors := make(chan error, len(sm.handlers))
	
	for _, handler := range sm.handlers {
		wg.Add(1)
		go func(h func() error) {
			defer wg.Done()
			if err := h(); err != nil {
				errors <- err
			}
		}(handler)
	}
	
	// Wait for all handlers or context timeout
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-done:
		close(errors)
		// Collect any errors
		var errs []error
		for err := range errors {
			errs = append(errs, err)
		}
		if len(errs) > 0 {
			return fmt.Errorf("shutdown errors: %v", errs)
		}
		return nil
	}
}

// ========================================
// Helper functions
// ========================================

func contains(s, substr string) bool {
	return len(s) >= len(substr) && s != "" && substr != "" && 
		(s == substr || len(s) > len(substr) && containsHelper(s, substr))
}

func containsHelper(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func isAlphaNumeric(ch rune) bool {
	return (ch >= 'a' && ch <= 'z') || 
		   (ch >= 'A' && ch <= 'Z') || 
		   (ch >= '0' && ch <= '9')
}