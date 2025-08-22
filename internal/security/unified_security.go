package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/time/rate"
)

// UnifiedSecurityManager provides comprehensive security features
type UnifiedSecurityManager struct {
	mu              sync.RWMutex
	level           SecurityLevel
	rsaKeyPair      *rsa.PrivateKey
	aesKey          []byte
	chachaKey       []byte
	rateLimiters    map[string]*rate.Limiter
	blockedIPs      map[string]time.Time
	sessionManager  *SessionManager
	auditLogger     *AuditLogger
	encryptionPool  *sync.Pool
	tlsConfig       *tls.Config
	
	// DDoS protection
	ddosProtection  *SimpleDDoSProtector
	
	// Statistics
	totalRequests   uint64
	blockedRequests uint64
	validSessions   uint64
}

// SecurityLevel defines security strictness
type SecurityLevel int

const (
	LevelStandard SecurityLevel = iota
	LevelEnhanced
	LevelMaximum
)

// SecurityConfig holds security configuration
type SecurityConfig struct {
	Level               SecurityLevel
	EnableTLS           bool
	EnableRateLimit     bool
	EnableDDoSProtection bool
	EnableAuditLogging  bool
	
	// Rate limiting
	RequestsPerSecond   int
	BurstSize          int
	
	// Session management
	SessionTimeout     time.Duration
	MaxSessions        int
	
	// Encryption
	EncryptionAlgorithm string // "aes-256-gcm", "chacha20-poly1305"
	KeyRotationInterval time.Duration
}

// Session represents an authenticated session
type Session struct {
	ID           string
	UserID       string
	CreatedAt    time.Time
	LastAccess   time.Time
	IPAddress    string
	UserAgent    string
	Permissions  []string
	ExpiresAt    time.Time
}

// SessionManager manages user sessions
type SessionManager struct {
	sessions map[string]*Session
	mu       sync.RWMutex
	maxSessions int
	timeout     time.Duration
}

// AuditLogger logs security events
type AuditLogger struct {
	events []AuditEvent
	mu     sync.RWMutex
	maxEvents int
}

// AuditEvent represents a security audit event
type AuditEvent struct {
	Timestamp   time.Time
	EventType   string
	UserID      string
	IPAddress   string
	Action      string
	Success     bool
	Details     map[string]interface{}
}

// SimpleDDoSProtector provides basic DDoS protection
type SimpleDDoSProtector struct {
	ipLimiters    map[string]*rate.Limiter
	mu            sync.RWMutex
	globalLimiter *rate.Limiter
	bannedIPs     map[string]time.Time
}

// DefaultSecurityConfig returns default security configuration
func DefaultSecurityConfig() *SecurityConfig {
	return &SecurityConfig{
		Level:               LevelEnhanced,
		EnableTLS:           true,
		EnableRateLimit:     true,
		EnableDDoSProtection: true,
		EnableAuditLogging:  true,
		RequestsPerSecond:   100,
		BurstSize:          200,
		SessionTimeout:     24 * time.Hour,
		MaxSessions:        1000,
		EncryptionAlgorithm: "chacha20-poly1305",
		KeyRotationInterval: 24 * time.Hour,
	}
}

// NewUnifiedSecurityManager creates a new security manager
func NewUnifiedSecurityManager(config *SecurityConfig) (*UnifiedSecurityManager, error) {
	if config == nil {
		config = DefaultSecurityConfig()
	}
	
	sm := &UnifiedSecurityManager{
		level:          config.Level,
		rateLimiters:   make(map[string]*rate.Limiter),
		blockedIPs:     make(map[string]time.Time),
		sessionManager: NewSessionManager(config.MaxSessions, config.SessionTimeout),
		auditLogger:    NewAuditLogger(10000),
	}
	
	// Initialize encryption
	if err := sm.initializeEncryption(config.EncryptionAlgorithm); err != nil {
		return nil, fmt.Errorf("failed to initialize encryption: %w", err)
	}
	
	// Initialize DDoS protection
	if config.EnableDDoSProtection {
		sm.ddosProtection = NewSimpleDDoSProtector(config.RequestsPerSecond, config.BurstSize)
	}
	
	// Initialize TLS
	if config.EnableTLS {
		if err := sm.initializeTLS(); err != nil {
			return nil, fmt.Errorf("failed to initialize TLS: %w", err)
		}
	}
	
	return sm, nil
}

// initializeEncryption sets up encryption keys and ciphers
func (sm *UnifiedSecurityManager) initializeEncryption(algorithm string) error {
	// Generate RSA key pair
	keyPair, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return err
	}
	sm.rsaKeyPair = keyPair
	
	// Generate symmetric keys
	sm.aesKey = make([]byte, 32) // AES-256
	if _, err := io.ReadFull(rand.Reader, sm.aesKey); err != nil {
		return err
	}
	
	sm.chachaKey = make([]byte, 32) // ChaCha20-Poly1305
	if _, err := io.ReadFull(rand.Reader, sm.chachaKey); err != nil {
		return err
	}
	
	// Initialize encryption pool for performance
	sm.encryptionPool = &sync.Pool{
		New: func() interface{} {
			return make([]byte, 0, 4096)
		},
	}
	
	return nil
}

// initializeTLS sets up TLS configuration
func (sm *UnifiedSecurityManager) initializeTLS() error {
	cert, err := sm.generateSelfSignedCert()
	if err != nil {
		return err
	}
	
	sm.tlsConfig = &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
		CipherSuites: []uint16{
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
			tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
		},
	}
	
	return nil
}

// CheckRequest validates an incoming request
func (sm *UnifiedSecurityManager) CheckRequest(ip string, userAgent string) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	
	sm.totalRequests++
	
	// Check if IP is blocked
	if expiry, blocked := sm.blockedIPs[ip]; blocked {
		if time.Now().Before(expiry) {
			sm.blockedRequests++
			return errors.New("IP is blocked")
		}
		delete(sm.blockedIPs, ip)
	}
	
	// Check DDoS protection
	if sm.ddosProtection != nil {
		if err := sm.ddosProtection.CheckRequest(ip); err != nil {
			sm.blockedRequests++
			return err
		}
	}
	
	// Rate limiting per IP
	limiter, exists := sm.rateLimiters[ip]
	if !exists {
		limiter = rate.NewLimiter(10, 20) // 10 requests/sec, burst of 20
		sm.rateLimiters[ip] = limiter
	}
	
	if !limiter.Allow() {
		sm.blockedRequests++
		return errors.New("rate limit exceeded")
	}
	
	// Log the request
	sm.auditLogger.LogEvent(AuditEvent{
		Timestamp: time.Now(),
		EventType: "request",
		IPAddress: ip,
		Action:    "request_checked",
		Success:   true,
		Details:   map[string]interface{}{"user_agent": userAgent},
	})
	
	return nil
}

// EncryptData encrypts data using the configured algorithm
func (sm *UnifiedSecurityManager) EncryptData(data []byte) ([]byte, error) {
	switch sm.level {
	case LevelMaximum:
		return sm.encryptChaCha20(data)
	default:
		return sm.encryptAES(data)
	}
}

// DecryptData decrypts data using the configured algorithm
func (sm *UnifiedSecurityManager) DecryptData(data []byte) ([]byte, error) {
	switch sm.level {
	case LevelMaximum:
		return sm.decryptChaCha20(data)
	default:
		return sm.decryptAES(data)
	}
}

// encryptAES encrypts data using AES-256-GCM
func (sm *UnifiedSecurityManager) encryptAES(data []byte) ([]byte, error) {
	block, err := aes.NewCipher(sm.aesKey)
	if err != nil {
		return nil, err
	}
	
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	
	ciphertext := gcm.Seal(nonce, nonce, data, nil)
	return ciphertext, nil
}

// decryptAES decrypts data using AES-256-GCM
func (sm *UnifiedSecurityManager) decryptAES(data []byte) ([]byte, error) {
	block, err := aes.NewCipher(sm.aesKey)
	if err != nil {
		return nil, err
	}
	
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	
	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return nil, errors.New("ciphertext too short")
	}
	
	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, err
	}
	
	return plaintext, nil
}

// encryptChaCha20 encrypts data using ChaCha20-Poly1305
func (sm *UnifiedSecurityManager) encryptChaCha20(data []byte) ([]byte, error) {
	aead, err := chacha20poly1305.New(sm.chachaKey)
	if err != nil {
		return nil, err
	}
	
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	
	ciphertext := aead.Seal(nonce, nonce, data, nil)
	return ciphertext, nil
}

// decryptChaCha20 decrypts data using ChaCha20-Poly1305
func (sm *UnifiedSecurityManager) decryptChaCha20(data []byte) ([]byte, error) {
	aead, err := chacha20poly1305.New(sm.chachaKey)
	if err != nil {
		return nil, err
	}
	
	nonceSize := aead.NonceSize()
	if len(data) < nonceSize {
		return nil, errors.New("ciphertext too short")
	}
	
	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	plaintext, err := aead.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, err
	}
	
	return plaintext, nil
}

// HashPassword securely hashes a password using Argon2
func (sm *UnifiedSecurityManager) HashPassword(password string) (string, error) {
	salt := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return "", err
	}
	
	hash := argon2.IDKey([]byte(password), salt, 1, 64*1024, 4, 32)
	
	encoded := base64.RawStdEncoding.EncodeToString(salt) + "$" + 
		       base64.RawStdEncoding.EncodeToString(hash)
	
	return encoded, nil
}

// VerifyPassword verifies a password against its hash
func (sm *UnifiedSecurityManager) VerifyPassword(password, hash string) bool {
	parts := []byte(hash)
	
	// Find separator
	sepIndex := -1
	for i, b := range parts {
		if b == '$' {
			sepIndex = i
			break
		}
	}
	
	if sepIndex == -1 {
		return false
	}
	
	salt, err := base64.RawStdEncoding.DecodeString(string(parts[:sepIndex]))
	if err != nil {
		return false
	}
	
	expectedHash, err := base64.RawStdEncoding.DecodeString(string(parts[sepIndex+1:]))
	if err != nil {
		return false
	}
	
	actualHash := argon2.IDKey([]byte(password), salt, 1, 64*1024, 4, 32)
	
	return compareHashes(expectedHash, actualHash)
}

// compareHashes performs constant-time comparison
func compareHashes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	
	result := byte(0)
	for i := 0; i < len(a); i++ {
		result |= a[i] ^ b[i]
	}
	
	return result == 0
}

// CreateSession creates a new user session
func (sm *UnifiedSecurityManager) CreateSession(userID, ipAddress, userAgent string, permissions []string) (*Session, error) {
	session := &Session{
		ID:          generateSessionID(),
		UserID:      userID,
		CreatedAt:   time.Now(),
		LastAccess:  time.Now(),
		IPAddress:   ipAddress,
		UserAgent:   userAgent,
		Permissions: permissions,
		ExpiresAt:   time.Now().Add(sm.sessionManager.timeout),
	}
	
	if err := sm.sessionManager.AddSession(session); err != nil {
		return nil, err
	}
	
	sm.validSessions++
	
	sm.auditLogger.LogEvent(AuditEvent{
		Timestamp: time.Now(),
		EventType: "authentication",
		UserID:    userID,
		IPAddress: ipAddress,
		Action:    "session_created",
		Success:   true,
		Details:   map[string]interface{}{"session_id": session.ID},
	})
	
	return session, nil
}

// ValidateSession validates a session token
func (sm *UnifiedSecurityManager) ValidateSession(sessionID string) (*Session, error) {
	return sm.sessionManager.GetSession(sessionID)
}

// RevokeSession revokes a user session
func (sm *UnifiedSecurityManager) RevokeSession(sessionID string) error {
	session, err := sm.sessionManager.GetSession(sessionID)
	if err != nil {
		return err
	}
	
	sm.auditLogger.LogEvent(AuditEvent{
		Timestamp: time.Now(),
		EventType: "authentication",
		UserID:    session.UserID,
		IPAddress: session.IPAddress,
		Action:    "session_revoked",
		Success:   true,
		Details:   map[string]interface{}{"session_id": sessionID},
	})
	
	return sm.sessionManager.RemoveSession(sessionID)
}

// GetTLSConfig returns the TLS configuration
func (sm *UnifiedSecurityManager) GetTLSConfig() *tls.Config {
	return sm.tlsConfig
}

// GetStats returns security statistics
func (sm *UnifiedSecurityManager) GetStats() map[string]interface{} {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	
	stats := map[string]interface{}{
		"total_requests":   sm.totalRequests,
		"blocked_requests": sm.blockedRequests,
		"valid_sessions":   sm.validSessions,
		"blocked_ips":      len(sm.blockedIPs),
		"rate_limiters":    len(sm.rateLimiters),
		"security_level":   sm.level.String(),
	}
	
	if sm.sessionManager != nil {
		stats["active_sessions"] = sm.sessionManager.GetActiveSessionCount()
	}
	
	if sm.ddosProtection != nil {
		stats["ddos_stats"] = sm.ddosProtection.GetStats()
	}
	
	return stats
}

// generateSessionID generates a cryptographically secure session ID
func generateSessionID() string {
	bytes := make([]byte, 32)
	io.ReadFull(rand.Reader, bytes)
	return base64.URLEncoding.EncodeToString(bytes)
}

// generateSelfSignedCert generates a self-signed certificate
func (sm *UnifiedSecurityManager) generateSelfSignedCert() (tls.Certificate, error) {
	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			Organization:  []string{"Otedama"},
			Country:       []string{"JP"},
			Province:      []string{""},
			Locality:      []string{""},
			StreetAddress: []string{""},
			PostalCode:    []string{""},
		},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
		DNSNames:     []string{"localhost"},
	}
	
	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &sm.rsaKeyPair.PublicKey, sm.rsaKeyPair)
	if err != nil {
		return tls.Certificate{}, err
	}
	
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(sm.rsaKeyPair)})
	
	return tls.X509KeyPair(certPEM, keyPEM)
}

// String returns string representation of SecurityLevel
func (sl SecurityLevel) String() string {
	switch sl {
	case LevelStandard:
		return "standard"
	case LevelEnhanced:
		return "enhanced"
	case LevelMaximum:
		return "maximum"
	default:
		return "unknown"
	}
}

// SessionManager implementation

// NewSessionManager creates a new session manager
func NewSessionManager(maxSessions int, timeout time.Duration) *SessionManager {
	return &SessionManager{
		sessions:    make(map[string]*Session),
		maxSessions: maxSessions,
		timeout:     timeout,
	}
}

// AddSession adds a new session
func (sm *SessionManager) AddSession(session *Session) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	
	if len(sm.sessions) >= sm.maxSessions {
		return errors.New("maximum sessions reached")
	}
	
	sm.sessions[session.ID] = session
	return nil
}

// GetSession retrieves a session
func (sm *SessionManager) GetSession(sessionID string) (*Session, error) {
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
	
	// Update last access time
	session.LastAccess = time.Now()
	
	return session, nil
}

// RemoveSession removes a session
func (sm *SessionManager) RemoveSession(sessionID string) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	
	if _, exists := sm.sessions[sessionID]; !exists {
		return errors.New("session not found")
	}
	
	delete(sm.sessions, sessionID)
	return nil
}

// GetActiveSessionCount returns the number of active sessions
func (sm *SessionManager) GetActiveSessionCount() int {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	
	return len(sm.sessions)
}

// CleanupExpiredSessions removes expired sessions
func (sm *SessionManager) CleanupExpiredSessions() {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	
	now := time.Now()
	for id, session := range sm.sessions {
		if now.After(session.ExpiresAt) {
			delete(sm.sessions, id)
		}
	}
}

// AuditLogger implementation

// NewAuditLogger creates a new audit logger
func NewAuditLogger(maxEvents int) *AuditLogger {
	return &AuditLogger{
		events:    make([]AuditEvent, 0, maxEvents),
		maxEvents: maxEvents,
	}
}

// LogEvent logs an audit event
func (al *AuditLogger) LogEvent(event AuditEvent) {
	al.mu.Lock()
	defer al.mu.Unlock()
	
	if len(al.events) >= al.maxEvents {
		// Remove oldest event
		al.events = al.events[1:]
	}
	
	al.events = append(al.events, event)
}

// GetEvents returns recent audit events
func (al *AuditLogger) GetEvents(limit int) []AuditEvent {
	al.mu.RLock()
	defer al.mu.RUnlock()
	
	if limit <= 0 || limit > len(al.events) {
		limit = len(al.events)
	}
	
	start := len(al.events) - limit
	return al.events[start:]
}

// SimpleDDoSProtector implementation

// NewSimpleDDoSProtector creates a simple DDoS protector
func NewSimpleDDoSProtector(requestsPerSecond, burstSize int) *SimpleDDoSProtector {
	return &SimpleDDoSProtector{
		ipLimiters:    make(map[string]*rate.Limiter),
		globalLimiter: rate.NewLimiter(rate.Limit(requestsPerSecond), burstSize),
		bannedIPs:     make(map[string]time.Time),
	}
}

// CheckRequest checks if a request should be allowed
func (ddos *SimpleDDoSProtector) CheckRequest(ip string) error {
	ddos.mu.RLock()
	expiry, banned := ddos.bannedIPs[ip]
	ddos.mu.RUnlock()
	
	if banned && time.Now().Before(expiry) {
		return errors.New("IP is banned")
	}
	
	if !ddos.globalLimiter.Allow() {
		return errors.New("global rate limit exceeded")
	}
	
	ddos.mu.Lock()
	limiter, exists := ddos.ipLimiters[ip]
	if !exists {
		limiter = rate.NewLimiter(rate.Limit(10), 20)
		ddos.ipLimiters[ip] = limiter
	}
	ddos.mu.Unlock()
	
	if !limiter.Allow() {
		// Ban IP for 5 minutes after rate limit exceeded
		ddos.mu.Lock()
		ddos.bannedIPs[ip] = time.Now().Add(5 * time.Minute)
		ddos.mu.Unlock()
		return errors.New("IP rate limit exceeded")
	}
	
	return nil
}

// GetStats returns DDoS protection statistics
func (ddos *SimpleDDoSProtector) GetStats() map[string]interface{} {
	ddos.mu.RLock()
	defer ddos.mu.RUnlock()
	
	return map[string]interface{}{
		"ip_limiters": len(ddos.ipLimiters),
		"banned_ips":  len(ddos.bannedIPs),
	}
}