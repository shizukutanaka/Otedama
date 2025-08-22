package security

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
)

// NationalSecurityManager provides enterprise-grade security for national deployments
type NationalSecurityManager struct {
	logger *zap.Logger
	
	// Encryption
	aesCipher      cipher.AEAD
	chachaCipher   cipher.AEAD
	rsaPrivateKey  *rsa.PrivateKey
	rsaPublicKey   *rsa.PublicKey
	
	// Key management
	masterKey      []byte
	keyRotation    time.Duration
	lastRotation   time.Time
	keyDerivation  *KeyDerivation
	
	// Access control
	accessControl  *AccessController
	sessions       sync.Map // map[string]*Session
	
	// Threat detection
	threatDetector *ThreatDetector
	anomalyScores  sync.Map // map[string]float64
	
	// Audit
	auditLog       *AuditLogger
	
	// Metrics
	encryptOps     atomic.Uint64
	decryptOps     atomic.Uint64
	authAttempts   atomic.Uint64
	threatsBlocked atomic.Uint64
	
	mu sync.RWMutex
}

// Session represents a secure session
type Session struct {
	ID           string
	UserID       string
	Token        string
	CreatedAt    time.Time
	ExpiresAt    time.Time
	Permissions  []string
	IPAddress    string
	UserAgent    string
	LastActivity time.Time
	MFAVerified  bool
}

// KeyDerivation handles key derivation functions
type KeyDerivation struct {
	salt      []byte
	time      uint32
	memory    uint32
	threads   uint8
	keyLength uint32
}

// AccessController manages access control
type AccessController struct {
	policies     sync.Map // map[string]*Policy
	roles        sync.Map // map[string]*Role
	permissions  sync.Map // map[string]*Permission
}

// ThreatDetector detects security threats
type ThreatDetector struct {
	logger           *zap.Logger
	suspiciousIPs    sync.Map
	failedAttempts   sync.Map
	rateLimiter      sync.Map
	blacklist        sync.Map
	whitelist        sync.Map
	anomalyThreshold float64
}

// AuditLogger logs security events
type AuditLogger struct {
	logger  *zap.Logger
	buffer  []AuditEntry
	mu      sync.Mutex
	flushCh chan struct{}
}

// AuditEntry represents an audit log entry
type AuditEntry struct {
	Timestamp   time.Time
	EventType   string
	UserID      string
	IPAddress   string
	Action      string
	Resource    string
	Result      string
	Details     map[string]interface{}
}

// NewNationalSecurityManager creates a new security manager for national deployments
func NewNationalSecurityManager(logger *zap.Logger) (*NationalSecurityManager, error) {
	// Generate master key
	masterKey := make([]byte, 32)
	if _, err := rand.Read(masterKey); err != nil {
		return nil, fmt.Errorf("failed to generate master key: %w", err)
	}
	
	// Initialize AES-256-GCM
	aesBlock, err := aes.NewCipher(masterKey)
	if err != nil {
		return nil, fmt.Errorf("failed to create AES cipher: %w", err)
	}
	
	aesCipher, err := cipher.NewGCM(aesBlock)
	if err != nil {
		return nil, fmt.Errorf("failed to create GCM: %w", err)
	}
	
	// Initialize ChaCha20-Poly1305
	chachaCipher, err := chacha20poly1305.NewX(masterKey)
	if err != nil {
		return nil, fmt.Errorf("failed to create ChaCha20-Poly1305: %w", err)
	}
	
	// Generate RSA keys
	rsaPrivateKey, err := rsa.GenerateKey(rand.Reader, 4096)
	if err != nil {
		return nil, fmt.Errorf("failed to generate RSA key: %w", err)
	}
	
	return &NationalSecurityManager{
		logger:         logger,
		aesCipher:      aesCipher,
		chachaCipher:   chachaCipher,
		rsaPrivateKey:  rsaPrivateKey,
		rsaPublicKey:   &rsaPrivateKey.PublicKey,
		masterKey:      masterKey,
		keyRotation:    24 * time.Hour,
		lastRotation:   time.Now(),
		keyDerivation:  NewKeyDerivation(),
		accessControl:  NewAccessController(),
		threatDetector: NewThreatDetector(logger),
		auditLog:       NewAuditLogger(logger),
	}, nil
}

// NewKeyDerivation creates a new key derivation instance
func NewKeyDerivation() *KeyDerivation {
	salt := make([]byte, 16)
	rand.Read(salt)
	
	return &KeyDerivation{
		salt:      salt,
		time:      1,
		memory:    64 * 1024,
		threads:   4,
		keyLength: 32,
	}
}

// NewAccessController creates a new access controller
func NewAccessController() *AccessController {
	return &AccessController{}
}

// NewThreatDetector creates a new threat detector
func NewThreatDetector(logger *zap.Logger) *ThreatDetector {
	return &ThreatDetector{
		logger:           logger,
		anomalyThreshold: 0.8,
	}
}

// NewAuditLogger creates a new audit logger
func NewAuditLogger(logger *zap.Logger) *AuditLogger {
	al := &AuditLogger{
		logger:  logger,
		buffer:  make([]AuditEntry, 0, 1000),
		flushCh: make(chan struct{}, 1),
	}
	
	go al.flushLoop()
	return al
}

// Encrypt encrypts data using AES-256-GCM
func (sm *NationalSecurityManager) Encrypt(plaintext []byte) ([]byte, error) {
	sm.encryptOps.Add(1)
	
	nonce := make([]byte, sm.aesCipher.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	
	ciphertext := sm.aesCipher.Seal(nonce, nonce, plaintext, nil)
	return ciphertext, nil
}

// Decrypt decrypts data using AES-256-GCM
func (sm *NationalSecurityManager) Decrypt(ciphertext []byte) ([]byte, error) {
	sm.decryptOps.Add(1)
	
	if len(ciphertext) < sm.aesCipher.NonceSize() {
		return nil, fmt.Errorf("ciphertext too short")
	}
	
	nonce, ciphertext := ciphertext[:sm.aesCipher.NonceSize()], ciphertext[sm.aesCipher.NonceSize():]
	plaintext, err := sm.aesCipher.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, err
	}
	
	return plaintext, nil
}

// EncryptWithChaCha encrypts using ChaCha20-Poly1305
func (sm *NationalSecurityManager) EncryptWithChaCha(plaintext []byte) ([]byte, error) {
	nonce := make([]byte, sm.chachaCipher.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	
	ciphertext := sm.chachaCipher.Seal(nonce, nonce, plaintext, nil)
	return ciphertext, nil
}

// DecryptWithChaCha decrypts using ChaCha20-Poly1305
func (sm *NationalSecurityManager) DecryptWithChaCha(ciphertext []byte) ([]byte, error) {
	if len(ciphertext) < sm.chachaCipher.NonceSize() {
		return nil, fmt.Errorf("ciphertext too short")
	}
	
	nonce, ciphertext := ciphertext[:sm.chachaCipher.NonceSize()], ciphertext[sm.chachaCipher.NonceSize():]
	plaintext, err := sm.chachaCipher.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, err
	}
	
	return plaintext, nil
}

// DeriveKey derives a key using Argon2id
func (kd *KeyDerivation) DeriveKey(password []byte) []byte {
	return argon2.IDKey(password, kd.salt, kd.time, kd.memory, kd.threads, kd.keyLength)
}

// CreateSession creates a new secure session
func (sm *NationalSecurityManager) CreateSession(userID string, permissions []string) (*Session, error) {
	sm.authAttempts.Add(1)
	
	// Generate session ID
	sessionID := make([]byte, 32)
	if _, err := rand.Read(sessionID); err != nil {
		return nil, err
	}
	
	// Generate session token
	token := make([]byte, 64)
	if _, err := rand.Read(token); err != nil {
		return nil, err
	}
	
	session := &Session{
		ID:           base64.URLEncoding.EncodeToString(sessionID),
		UserID:       userID,
		Token:        base64.URLEncoding.EncodeToString(token),
		CreatedAt:    time.Now(),
		ExpiresAt:    time.Now().Add(24 * time.Hour),
		Permissions:  permissions,
		LastActivity: time.Now(),
	}
	
	// Store session
	sm.sessions.Store(session.ID, session)
	
	// Audit log
	sm.auditLog.LogEvent(AuditEntry{
		Timestamp: time.Now(),
		EventType: "SESSION_CREATE",
		UserID:    userID,
		Action:    "create_session",
		Result:    "success",
	})
	
	return session, nil
}

// ValidateSession validates a session
func (sm *NationalSecurityManager) ValidateSession(sessionID, token string) (*Session, error) {
	value, ok := sm.sessions.Load(sessionID)
	if !ok {
		return nil, fmt.Errorf("session not found")
	}
	
	session := value.(*Session)
	
	// Check expiration
	if time.Now().After(session.ExpiresAt) {
		sm.sessions.Delete(sessionID)
		return nil, fmt.Errorf("session expired")
	}
	
	// Validate token
	if session.Token != token {
		sm.threatDetector.RecordFailedAttempt(session.IPAddress)
		return nil, fmt.Errorf("invalid token")
	}
	
	// Update last activity
	session.LastActivity = time.Now()
	
	return session, nil
}

// RotateKeys rotates encryption keys
func (sm *NationalSecurityManager) RotateKeys() error {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	
	// Check if rotation is needed
	if time.Since(sm.lastRotation) < sm.keyRotation {
		return nil
	}
	
	sm.logger.Info("Rotating encryption keys")
	
	// Generate new master key
	newMasterKey := make([]byte, 32)
	if _, err := rand.Read(newMasterKey); err != nil {
		return fmt.Errorf("failed to generate new master key: %w", err)
	}
	
	// Create new ciphers
	aesBlock, err := aes.NewCipher(newMasterKey)
	if err != nil {
		return fmt.Errorf("failed to create new AES cipher: %w", err)
	}
	
	newAESCipher, err := cipher.NewGCM(aesBlock)
	if err != nil {
		return fmt.Errorf("failed to create new GCM: %w", err)
	}
	
	newChachaCipher, err := chacha20poly1305.NewX(newMasterKey)
	if err != nil {
		return fmt.Errorf("failed to create new ChaCha20-Poly1305: %w", err)
	}
	
	// Update ciphers
	sm.masterKey = newMasterKey
	sm.aesCipher = newAESCipher
	sm.chachaCipher = newChachaCipher
	sm.lastRotation = time.Now()
	
	// Audit log
	sm.auditLog.LogEvent(AuditEntry{
		Timestamp: time.Now(),
		EventType: "KEY_ROTATION",
		Action:    "rotate_keys",
		Result:    "success",
	})
	
	return nil
}

// DetectThreat analyzes activity for threats
func (td *ThreatDetector) DetectThreat(activity map[string]interface{}) bool {
	// Check IP blacklist
	if ip, ok := activity["ip"].(string); ok {
		if _, blacklisted := td.blacklist.Load(ip); blacklisted {
			return true
		}
		
		// Check whitelisted
		if _, whitelisted := td.whitelist.Load(ip); whitelisted {
			return false
		}
	}
	
	// Check failed attempts
	if ip, ok := activity["ip"].(string); ok {
		if attempts, exists := td.failedAttempts.Load(ip); exists {
			if attempts.(int) > 5 {
				td.logger.Warn("Too many failed attempts", zap.String("ip", ip))
				return true
			}
		}
	}
	
	// Check rate limiting
	if userID, ok := activity["user_id"].(string); ok {
		key := fmt.Sprintf("%s:%d", userID, time.Now().Unix()/60)
		if count, exists := td.rateLimiter.Load(key); exists {
			if count.(int) > 100 {
				td.logger.Warn("Rate limit exceeded", zap.String("user", userID))
				return true
			}
		}
	}
	
	// Calculate anomaly score
	score := td.calculateAnomalyScore(activity)
	if score > td.anomalyThreshold {
		td.logger.Warn("Anomaly detected", 
			zap.Float64("score", score),
			zap.Any("activity", activity))
		return true
	}
	
	return false
}

// RecordFailedAttempt records a failed authentication attempt
func (td *ThreatDetector) RecordFailedAttempt(ip string) {
	count := 1
	if value, exists := td.failedAttempts.Load(ip); exists {
		count = value.(int) + 1
	}
	td.failedAttempts.Store(ip, count)
	
	// Auto-blacklist after threshold
	if count > 10 {
		td.blacklist.Store(ip, time.Now())
		td.logger.Warn("IP blacklisted due to failed attempts", zap.String("ip", ip))
	}
}

// calculateAnomalyScore calculates anomaly score for activity
func (td *ThreatDetector) calculateAnomalyScore(activity map[string]interface{}) float64 {
	score := 0.0
	
	// Check unusual time
	if timestamp, ok := activity["timestamp"].(time.Time); ok {
		hour := timestamp.Hour()
		if hour < 6 || hour > 22 {
			score += 0.2
		}
	}
	
	// Check unusual location
	if ip, ok := activity["ip"].(string); ok {
		if td.isUnusualLocation(ip) {
			score += 0.3
		}
	}
	
	// Check unusual pattern
	if pattern, ok := activity["pattern"].(string); ok {
		if td.isUnusualPattern(pattern) {
			score += 0.4
		}
	}
	
	return score
}

// isUnusualLocation checks if IP is from unusual location
func (td *ThreatDetector) isUnusualLocation(ip string) bool {
	// Simplified check - in production, use GeoIP database
	return false
}

// isUnusualPattern checks for unusual patterns
func (td *ThreatDetector) isUnusualPattern(pattern string) bool {
	// Simplified check - in production, use ML models
	return false
}

// LogEvent logs an audit event
func (al *AuditLogger) LogEvent(entry AuditEntry) {
	al.mu.Lock()
	al.buffer = append(al.buffer, entry)
	
	// Flush if buffer is full
	if len(al.buffer) >= 1000 {
		al.mu.Unlock()
		select {
		case al.flushCh <- struct{}{}:
		default:
		}
		return
	}
	al.mu.Unlock()
}

// flushLoop periodically flushes audit logs
func (al *AuditLogger) flushLoop() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			al.flush()
		case <-al.flushCh:
			al.flush()
		}
	}
}

// flush writes buffered audit logs
func (al *AuditLogger) flush() {
	al.mu.Lock()
	if len(al.buffer) == 0 {
		al.mu.Unlock()
		return
	}
	
	entries := al.buffer
	al.buffer = make([]AuditEntry, 0, 1000)
	al.mu.Unlock()
	
	// Log entries
	for _, entry := range entries {
		al.logger.Info("AUDIT",
			zap.Time("timestamp", entry.Timestamp),
			zap.String("event", entry.EventType),
			zap.String("user", entry.UserID),
			zap.String("ip", entry.IPAddress),
			zap.String("action", entry.Action),
			zap.String("resource", entry.Resource),
			zap.String("result", entry.Result),
			zap.Any("details", entry.Details))
	}
}

// ExportPublicKey exports RSA public key in PEM format
func (sm *NationalSecurityManager) ExportPublicKey() (string, error) {
	pubKeyBytes, err := x509.MarshalPKIXPublicKey(sm.rsaPublicKey)
	if err != nil {
		return "", err
	}
	
	pubKeyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PUBLIC KEY",
		Bytes: pubKeyBytes,
	})
	
	return string(pubKeyPEM), nil
}

// GetSecurityMetrics returns security metrics
func (sm *NationalSecurityManager) GetSecurityMetrics() map[string]interface{} {
	return map[string]interface{}{
		"encrypt_operations":  sm.encryptOps.Load(),
		"decrypt_operations":  sm.decryptOps.Load(),
		"auth_attempts":       sm.authAttempts.Load(),
		"threats_blocked":     sm.threatsBlocked.Load(),
		"active_sessions":     sm.countActiveSessions(),
		"last_key_rotation":   sm.lastRotation,
	}
}

// countActiveSessions counts active sessions
func (sm *NationalSecurityManager) countActiveSessions() int {
	count := 0
	now := time.Now()
	
	sm.sessions.Range(func(key, value interface{}) bool {
		if session, ok := value.(*Session); ok {
			if now.Before(session.ExpiresAt) {
				count++
			}
		}
		return true
	})
	
	return count
}

// CleanupExpiredSessions removes expired sessions
func (sm *NationalSecurityManager) CleanupExpiredSessions() {
	now := time.Now()
	
	sm.sessions.Range(func(key, value interface{}) bool {
		if session, ok := value.(*Session); ok {
			if now.After(session.ExpiresAt) {
				sm.sessions.Delete(key)
			}
		}
		return true
	})
}

// Start starts security manager background tasks
func (sm *NationalSecurityManager) Start(ctx context.Context) {
	// Key rotation
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		
		for {
			select {
			case <-ticker.C:
				if err := sm.RotateKeys(); err != nil {
					sm.logger.Error("Failed to rotate keys", zap.Error(err))
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	
	// Session cleanup
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		
		for {
			select {
			case <-ticker.C:
				sm.CleanupExpiredSessions()
			case <-ctx.Done():
				return
			}
		}
	}()
}

// HashPassword hashes a password using Argon2id
func (sm *NationalSecurityManager) HashPassword(password string) (string, error) {
	hash := sm.keyDerivation.DeriveKey([]byte(password))
	return base64.RawStdEncoding.EncodeToString(hash), nil
}

// VerifyPassword verifies a password against a hash
func (sm *NationalSecurityManager) VerifyPassword(password, hash string) bool {
	expectedHash, err := base64.RawStdEncoding.DecodeString(hash)
	if err != nil {
		return false
	}
	
	passwordHash := sm.keyDerivation.DeriveKey([]byte(password))
	
	// Constant time comparison
	if len(expectedHash) != len(passwordHash) {
		return false
	}
	
	result := byte(0)
	for i := range expectedHash {
		result |= expectedHash[i] ^ passwordHash[i]
	}
	
	return result == 0
}
