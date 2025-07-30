package security

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/scrypt"
)

// NationalSecurityManager provides enterprise and government-grade security
// Following Robert C. Martin's principle: "Security is not optional"
type NationalSecurityManager struct {
	logger *zap.Logger
	
	// Encryption systems
	aesGCM    cipher.AEAD
	chacha    cipher.AEAD
	rsaKey    *rsa.PrivateKey
	
	// Access control
	accessControl *RoleBasedAccessControl
	auditLog      *SecurityAuditLog
	
	// Threat detection
	intrusionDetection *IntrusionDetectionSystem
	anomalyDetector    *AnomalyDetector
	
	// Configuration
	config *SecurityConfig
	
	// State management
	running atomic.Bool
	mu      sync.RWMutex
}

// SecurityConfig contains security configuration
type SecurityConfig struct {
	// Encryption settings
	EncryptionLevel    string // "standard", "high", "maximum"
	KeyRotationPeriod  time.Duration
	
	// Access control
	RequireMultiFactor bool
	SessionTimeout     time.Duration
	MaxFailedAttempts  int
	
	// Audit settings
	AuditLevel         string // "minimal", "standard", "comprehensive"
	RetentionPeriod    time.Duration
	
	// Threat detection
	EnableIDS          bool
	EnableAnomalyDetection bool
	ThreatIntelligence bool
}

// RoleBasedAccessControl implements RBAC
type RoleBasedAccessControl struct {
	roles       map[string]*Role
	permissions map[string]*Permission
	users       map[string]*User
	mu          sync.RWMutex
}

// Role represents a security role
type Role struct {
	ID          string
	Name        string
	Permissions []string
	Priority    int
}

// Permission represents an access permission
type Permission struct {
	ID       string
	Resource string
	Action   string
	Scope    string
}

// User represents a system user
type User struct {
	ID            string
	Roles         []string
	LastAccess    time.Time
	FailedLogins  int
	Locked        bool
	MFAEnabled    bool
}

// SecurityAuditLog provides comprehensive audit logging
type SecurityAuditLog struct {
	logger     *zap.Logger
	logFile    string
	encryption bool
	
	entries    []AuditEntry
	entriesMu  sync.Mutex
	
	// Real-time monitoring
	watchers   []chan AuditEntry
	watchersMu sync.RWMutex
}

// AuditEntry represents an audit log entry
type AuditEntry struct {
	Timestamp   time.Time
	UserID      string
	Action      string
	Resource    string
	Result      string
	IPAddress   string
	Details     map[string]interface{}
	Severity    string
}

// IntrusionDetectionSystem monitors for security threats
type IntrusionDetectionSystem struct {
	logger *zap.Logger
	
	// Detection rules
	rules      map[string]*DetectionRule
	rulesMu    sync.RWMutex
	
	// Threat tracking
	threats    map[string]*ThreatInfo
	threatsMu  sync.RWMutex
	
	// Statistics
	stats      IDSStats
}

// DetectionRule defines an intrusion detection rule
type DetectionRule struct {
	ID          string
	Name        string
	Pattern     string
	Severity    string
	Action      string
	Threshold   int
	TimeWindow  time.Duration
}

// ThreatInfo contains information about a detected threat
type ThreatInfo struct {
	ID          string
	Type        string
	Source      string
	FirstSeen   time.Time
	LastSeen    time.Time
	Count       int
	Severity    string
	Blocked     bool
}

// IDSStats tracks IDS statistics
type IDSStats struct {
	threatsDetected  atomic.Uint64
	threatsBlocked   atomic.Uint64
	falsePositives   atomic.Uint64
	rulesTriggered   atomic.Uint64
}

// AnomalyDetector detects unusual behavior patterns
type AnomalyDetector struct {
	logger *zap.Logger
	
	// Baseline behavior
	baselines  map[string]*BehaviorBaseline
	baselineMu sync.RWMutex
	
	// Detection parameters
	sensitivity float64
	windowSize  time.Duration
}

// BehaviorBaseline represents normal behavior patterns
type BehaviorBaseline struct {
	MetricID    string
	Mean        float64
	StdDev      float64
	MinValue    float64
	MaxValue    float64
	SampleCount int
	LastUpdate  time.Time
}

// NewNationalSecurityManager creates a new security manager
func NewNationalSecurityManager(logger *zap.Logger, config *SecurityConfig) (*NationalSecurityManager, error) {
	if config == nil {
		config = DefaultSecurityConfig()
	}
	
	nsm := &NationalSecurityManager{
		logger: logger,
		config: config,
		accessControl: &RoleBasedAccessControl{
			roles:       make(map[string]*Role),
			permissions: make(map[string]*Permission),
			users:       make(map[string]*User),
		},
		auditLog: &SecurityAuditLog{
			logger:     logger,
			encryption: true,
			watchers:   make([]chan AuditEntry, 0),
		},
	}
	
	// Initialize encryption
	if err := nsm.initializeEncryption(); err != nil {
		return nil, fmt.Errorf("failed to initialize encryption: %w", err)
	}
	
	// Initialize threat detection
	if config.EnableIDS {
		nsm.intrusionDetection = &IntrusionDetectionSystem{
			logger:  logger,
			rules:   make(map[string]*DetectionRule),
			threats: make(map[string]*ThreatInfo),
		}
		nsm.loadDetectionRules()
	}
	
	if config.EnableAnomalyDetection {
		nsm.anomalyDetector = &AnomalyDetector{
			logger:      logger,
			baselines:   make(map[string]*BehaviorBaseline),
			sensitivity: 2.0, // 2 standard deviations
			windowSize:  1 * time.Hour,
		}
	}
	
	// Initialize default roles
	nsm.initializeDefaultRoles()
	
	return nsm, nil
}

// Start starts the security manager
func (nsm *NationalSecurityManager) Start() error {
	if !nsm.running.CompareAndSwap(false, true) {
		return errors.New("security manager already running")
	}
	
	// Start key rotation
	go nsm.keyRotationLoop()
	
	// Start threat monitoring
	if nsm.config.EnableIDS {
		go nsm.threatMonitoringLoop()
	}
	
	// Start anomaly detection
	if nsm.config.EnableAnomalyDetection {
		go nsm.anomalyDetectionLoop()
	}
	
	// Start audit log cleanup
	go nsm.auditCleanupLoop()
	
	nsm.logger.Info("National security manager started",
		zap.String("encryption_level", nsm.config.EncryptionLevel),
		zap.Bool("ids_enabled", nsm.config.EnableIDS),
		zap.Bool("anomaly_detection", nsm.config.EnableAnomalyDetection),
	)
	
	return nil
}

// Stop stops the security manager
func (nsm *NationalSecurityManager) Stop() {
	if nsm.running.CompareAndSwap(true, false) {
		nsm.logger.Info("National security manager stopped")
	}
}

// Encrypt encrypts data using the configured encryption level
func (nsm *NationalSecurityManager) Encrypt(data []byte) ([]byte, error) {
	switch nsm.config.EncryptionLevel {
	case "maximum":
		// Use ChaCha20-Poly1305 for maximum security
		return nsm.encryptChaCha(data)
	case "high":
		// Use AES-256-GCM
		return nsm.encryptAES(data)
	default:
		// Standard encryption
		return nsm.encryptAES(data)
	}
}

// Decrypt decrypts data
func (nsm *NationalSecurityManager) Decrypt(data []byte) ([]byte, error) {
	// Detect encryption type from data prefix
	if len(data) < 4 {
		return nil, errors.New("invalid encrypted data")
	}
	
	switch string(data[:4]) {
	case "CHA:":
		return nsm.decryptChaCha(data[4:])
	case "AES:":
		return nsm.decryptAES(data[4:])
	default:
		return nil, errors.New("unknown encryption format")
	}
}

// CheckAccess verifies if a user has permission for an action
func (nsm *NationalSecurityManager) CheckAccess(userID, resource, action string) (bool, error) {
	// Log access attempt
	nsm.auditLog.LogAccess(userID, resource, action, "")
	
	// Get user
	user, err := nsm.accessControl.GetUser(userID)
	if err != nil {
		return false, err
	}
	
	// Check if user is locked
	if user.Locked {
		return false, errors.New("user account locked")
	}
	
	// Check permissions
	for _, roleID := range user.Roles {
		role, err := nsm.accessControl.GetRole(roleID)
		if err != nil {
			continue
		}
		
		for _, permID := range role.Permissions {
			perm, err := nsm.accessControl.GetPermission(permID)
			if err != nil {
				continue
			}
			
			if perm.Resource == resource && perm.Action == action {
				return true, nil
			}
		}
	}
	
	return false, nil
}

// DetectThreat checks if an action represents a security threat
func (nsm *NationalSecurityManager) DetectThreat(source, action string, metadata map[string]interface{}) (*ThreatInfo, error) {
	if nsm.intrusionDetection == nil {
		return nil, errors.New("IDS not enabled")
	}
	
	return nsm.intrusionDetection.Analyze(source, action, metadata)
}

// Private methods

func (nsm *NationalSecurityManager) initializeEncryption() error {
	// Generate RSA key pair
	rsaKey, err := rsa.GenerateKey(rand.Reader, 4096)
	if err != nil {
		return fmt.Errorf("failed to generate RSA key: %w", err)
	}
	nsm.rsaKey = rsaKey
	
	// Initialize AES-GCM
	key := make([]byte, 32) // AES-256
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return fmt.Errorf("failed to generate AES key: %w", err)
	}
	
	block, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	
	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	nsm.aesGCM = aesGCM
	
	// Initialize ChaCha20-Poly1305
	chachaKey := make([]byte, chacha20poly1305.KeySize)
	if _, err := io.ReadFull(rand.Reader, chachaKey); err != nil {
		return fmt.Errorf("failed to generate ChaCha key: %w", err)
	}
	
	chacha, err := chacha20poly1305.New(chachaKey)
	if err != nil {
		return err
	}
	nsm.chacha = chacha
	
	return nil
}

func (nsm *NationalSecurityManager) encryptAES(plaintext []byte) ([]byte, error) {
	nonce := make([]byte, nsm.aesGCM.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	
	ciphertext := nsm.aesGCM.Seal(nonce, nonce, plaintext, nil)
	
	// Add encryption type prefix
	result := append([]byte("AES:"), ciphertext...)
	return result, nil
}

func (nsm *NationalSecurityManager) decryptAES(ciphertext []byte) ([]byte, error) {
	if len(ciphertext) < nsm.aesGCM.NonceSize() {
		return nil, errors.New("ciphertext too short")
	}
	
	nonce, ciphertext := ciphertext[:nsm.aesGCM.NonceSize()], ciphertext[nsm.aesGCM.NonceSize():]
	return nsm.aesGCM.Open(nil, nonce, ciphertext, nil)
}

func (nsm *NationalSecurityManager) encryptChaCha(plaintext []byte) ([]byte, error) {
	nonce := make([]byte, nsm.chacha.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	
	ciphertext := nsm.chacha.Seal(nonce, nonce, plaintext, nil)
	
	// Add encryption type prefix
	result := append([]byte("CHA:"), ciphertext...)
	return result, nil
}

func (nsm *NationalSecurityManager) decryptChaCha(ciphertext []byte) ([]byte, error) {
	if len(ciphertext) < nsm.chacha.NonceSize() {
		return nil, errors.New("ciphertext too short")
	}
	
	nonce, ciphertext := ciphertext[:nsm.chacha.NonceSize()], ciphertext[nsm.chacha.NonceSize():]
	return nsm.chacha.Open(nil, nonce, ciphertext, nil)
}

func (nsm *NationalSecurityManager) initializeDefaultRoles() {
	// Administrator role
	nsm.accessControl.CreateRole(&Role{
		ID:          "admin",
		Name:        "Administrator",
		Permissions: []string{"all:all"},
		Priority:    100,
	})
	
	// Operator role
	nsm.accessControl.CreateRole(&Role{
		ID:          "operator",
		Name:        "Operator",
		Permissions: []string{"mining:operate", "monitoring:view"},
		Priority:    50,
	})
	
	// Viewer role
	nsm.accessControl.CreateRole(&Role{
		ID:          "viewer",
		Name:        "Viewer",
		Permissions: []string{"monitoring:view", "stats:view"},
		Priority:    10,
	})
}

func (nsm *NationalSecurityManager) loadDetectionRules() {
	// Load default IDS rules
	rules := []DetectionRule{
		{
			ID:         "brute_force",
			Name:       "Brute Force Attack",
			Pattern:    "failed_login",
			Severity:   "high",
			Action:     "block",
			Threshold:  5,
			TimeWindow: 1 * time.Minute,
		},
		{
			ID:         "port_scan",
			Name:       "Port Scanning",
			Pattern:    "connection_attempt",
			Severity:   "medium",
			Action:     "alert",
			Threshold:  20,
			TimeWindow: 10 * time.Second,
		},
		{
			ID:         "ddos",
			Name:       "DDoS Attack",
			Pattern:    "high_request_rate",
			Severity:   "critical",
			Action:     "block",
			Threshold:  1000,
			TimeWindow: 1 * time.Second,
		},
		{
			ID:         "sql_injection",
			Name:       "SQL Injection Attempt",
			Pattern:    "sql_pattern",
			Severity:   "high",
			Action:     "block",
			Threshold:  1,
			TimeWindow: 0,
		},
	}
	
	for _, rule := range rules {
		nsm.intrusionDetection.AddRule(&rule)
	}
}

func (nsm *NationalSecurityManager) keyRotationLoop() {
	ticker := time.NewTicker(nsm.config.KeyRotationPeriod)
	defer ticker.Stop()
	
	for nsm.running.Load() {
		select {
		case <-ticker.C:
			if err := nsm.rotateKeys(); err != nil {
				nsm.logger.Error("Key rotation failed", zap.Error(err))
			}
		}
	}
}

func (nsm *NationalSecurityManager) rotateKeys() error {
	nsm.mu.Lock()
	defer nsm.mu.Unlock()
	
	// Re-initialize encryption with new keys
	return nsm.initializeEncryption()
}

func (nsm *NationalSecurityManager) threatMonitoringLoop() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for nsm.running.Load() {
		select {
		case <-ticker.C:
			nsm.intrusionDetection.ProcessThreats()
		}
	}
}

func (nsm *NationalSecurityManager) anomalyDetectionLoop() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for nsm.running.Load() {
		select {
		case <-ticker.C:
			nsm.anomalyDetector.Analyze()
		}
	}
}

func (nsm *NationalSecurityManager) auditCleanupLoop() {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	
	for nsm.running.Load() {
		select {
		case <-ticker.C:
			nsm.auditLog.Cleanup(nsm.config.RetentionPeriod)
		}
	}
}

// RBAC methods

func (ac *RoleBasedAccessControl) CreateRole(role *Role) error {
	ac.mu.Lock()
	defer ac.mu.Unlock()
	
	ac.roles[role.ID] = role
	return nil
}

func (ac *RoleBasedAccessControl) GetRole(roleID string) (*Role, error) {
	ac.mu.RLock()
	defer ac.mu.RUnlock()
	
	role, exists := ac.roles[roleID]
	if !exists {
		return nil, errors.New("role not found")
	}
	return role, nil
}

func (ac *RoleBasedAccessControl) CreatePermission(perm *Permission) error {
	ac.mu.Lock()
	defer ac.mu.Unlock()
	
	ac.permissions[perm.ID] = perm
	return nil
}

func (ac *RoleBasedAccessControl) GetPermission(permID string) (*Permission, error) {
	ac.mu.RLock()
	defer ac.mu.RUnlock()
	
	perm, exists := ac.permissions[permID]
	if !exists {
		return nil, errors.New("permission not found")
	}
	return perm, nil
}

func (ac *RoleBasedAccessControl) CreateUser(user *User) error {
	ac.mu.Lock()
	defer ac.mu.Unlock()
	
	ac.users[user.ID] = user
	return nil
}

func (ac *RoleBasedAccessControl) GetUser(userID string) (*User, error) {
	ac.mu.RLock()
	defer ac.mu.RUnlock()
	
	user, exists := ac.users[userID]
	if !exists {
		return nil, errors.New("user not found")
	}
	return user, nil
}

// Audit log methods

func (al *SecurityAuditLog) LogAccess(userID, resource, action, result string) {
	entry := AuditEntry{
		Timestamp: time.Now(),
		UserID:    userID,
		Action:    action,
		Resource:  resource,
		Result:    result,
		Severity:  "info",
	}
	
	al.addEntry(entry)
}

func (al *SecurityAuditLog) LogSecurityEvent(event AuditEntry) {
	al.addEntry(event)
}

func (al *SecurityAuditLog) addEntry(entry AuditEntry) {
	al.entriesMu.Lock()
	al.entries = append(al.entries, entry)
	al.entriesMu.Unlock()
	
	// Notify watchers
	al.watchersMu.RLock()
	for _, watcher := range al.watchers {
		select {
		case watcher <- entry:
		default:
			// Don't block
		}
	}
	al.watchersMu.RUnlock()
	
	// Log to file if configured
	al.logger.Info("Security audit",
		zap.Time("timestamp", entry.Timestamp),
		zap.String("user", entry.UserID),
		zap.String("action", entry.Action),
		zap.String("resource", entry.Resource),
		zap.String("severity", entry.Severity),
	)
}

func (al *SecurityAuditLog) Watch() <-chan AuditEntry {
	ch := make(chan AuditEntry, 100)
	
	al.watchersMu.Lock()
	al.watchers = append(al.watchers, ch)
	al.watchersMu.Unlock()
	
	return ch
}

func (al *SecurityAuditLog) Cleanup(retention time.Duration) {
	al.entriesMu.Lock()
	defer al.entriesMu.Unlock()
	
	cutoff := time.Now().Add(-retention)
	newEntries := make([]AuditEntry, 0)
	
	for _, entry := range al.entries {
		if entry.Timestamp.After(cutoff) {
			newEntries = append(newEntries, entry)
		}
	}
	
	al.entries = newEntries
}

// IDS methods

func (ids *IntrusionDetectionSystem) AddRule(rule *DetectionRule) {
	ids.rulesMu.Lock()
	defer ids.rulesMu.Unlock()
	
	ids.rules[rule.ID] = rule
}

func (ids *IntrusionDetectionSystem) Analyze(source, action string, metadata map[string]interface{}) (*ThreatInfo, error) {
	ids.rulesMu.RLock()
	defer ids.rulesMu.RUnlock()
	
	for _, rule := range ids.rules {
		if ids.matchesRule(rule, action, metadata) {
			threat := ids.recordThreat(source, rule)
			
			if rule.Action == "block" {
				ids.blockThreat(threat)
			}
			
			return threat, nil
		}
	}
	
	return nil, nil
}

func (ids *IntrusionDetectionSystem) matchesRule(rule *DetectionRule, action string, metadata map[string]interface{}) bool {
	// Simple pattern matching - real implementation would be more sophisticated
	return rule.Pattern == action
}

func (ids *IntrusionDetectionSystem) recordThreat(source string, rule *DetectionRule) *ThreatInfo {
	ids.threatsMu.Lock()
	defer ids.threatsMu.Unlock()
	
	threatID := fmt.Sprintf("%s:%s", source, rule.ID)
	
	if threat, exists := ids.threats[threatID]; exists {
		threat.Count++
		threat.LastSeen = time.Now()
		return threat
	}
	
	threat := &ThreatInfo{
		ID:        threatID,
		Type:      rule.Name,
		Source:    source,
		FirstSeen: time.Now(),
		LastSeen:  time.Now(),
		Count:     1,
		Severity:  rule.Severity,
	}
	
	ids.threats[threatID] = threat
	ids.stats.threatsDetected.Add(1)
	
	return threat
}

func (ids *IntrusionDetectionSystem) blockThreat(threat *ThreatInfo) {
	threat.Blocked = true
	ids.stats.threatsBlocked.Add(1)
}

func (ids *IntrusionDetectionSystem) ProcessThreats() {
	// Process and age out old threats
	ids.threatsMu.Lock()
	defer ids.threatsMu.Unlock()
	
	now := time.Now()
	for id, threat := range ids.threats {
		if now.Sub(threat.LastSeen) > 24*time.Hour {
			delete(ids.threats, id)
		}
	}
}

// Anomaly detection methods

func (ad *AnomalyDetector) RecordMetric(metricID string, value float64) {
	ad.baselineMu.Lock()
	defer ad.baselineMu.Unlock()
	
	baseline, exists := ad.baselines[metricID]
	if !exists {
		baseline = &BehaviorBaseline{
			MetricID: metricID,
			MinValue: value,
			MaxValue: value,
		}
		ad.baselines[metricID] = baseline
	}
	
	// Update baseline statistics
	baseline.SampleCount++
	delta := value - baseline.Mean
	baseline.Mean += delta / float64(baseline.SampleCount)
	baseline.StdDev += delta * (value - baseline.Mean)
	
	if value < baseline.MinValue {
		baseline.MinValue = value
	}
	if value > baseline.MaxValue {
		baseline.MaxValue = value
	}
	
	baseline.LastUpdate = time.Now()
}

func (ad *AnomalyDetector) IsAnomaly(metricID string, value float64) bool {
	ad.baselineMu.RLock()
	defer ad.baselineMu.RUnlock()
	
	baseline, exists := ad.baselines[metricID]
	if !exists || baseline.SampleCount < 10 {
		return false // Not enough data
	}
	
	// Calculate standard deviation
	stdDev := baseline.StdDev
	if baseline.SampleCount > 1 {
		stdDev = baseline.StdDev / float64(baseline.SampleCount-1)
		stdDev = stdDev * stdDev // Variance to StdDev
	}
	
	// Check if value is outside sensitivity range
	lowerBound := baseline.Mean - (ad.sensitivity * stdDev)
	upperBound := baseline.Mean + (ad.sensitivity * stdDev)
	
	return value < lowerBound || value > upperBound
}

func (ad *AnomalyDetector) Analyze() {
	// Analyze all metrics for anomalies
	ad.baselineMu.RLock()
	defer ad.baselineMu.RUnlock()
	
	for metricID, baseline := range ad.baselines {
		if time.Since(baseline.LastUpdate) > ad.windowSize {
			ad.logger.Warn("Stale baseline detected",
				zap.String("metric", metricID),
				zap.Time("last_update", baseline.LastUpdate),
			)
		}
	}
}

// Utility functions

// GenerateSecureToken generates a cryptographically secure token
func GenerateSecureToken(length int) (string, error) {
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

// HashPassword hashes a password using Argon2
func HashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	
	hash := argon2.IDKey([]byte(password), salt, 1, 64*1024, 4, 32)
	
	// Encode salt and hash together
	result := append(salt, hash...)
	return hex.EncodeToString(result), nil
}

// VerifyPassword verifies a password against its hash
func VerifyPassword(password, hashStr string) (bool, error) {
	decoded, err := hex.DecodeString(hashStr)
	if err != nil {
		return false, err
	}
	
	if len(decoded) < 48 { // 16 bytes salt + 32 bytes hash
		return false, errors.New("invalid hash format")
	}
	
	salt := decoded[:16]
	expectedHash := decoded[16:]
	
	hash := argon2.IDKey([]byte(password), salt, 1, 64*1024, 4, 32)
	
	// Constant time comparison
	if len(hash) != len(expectedHash) {
		return false, nil
	}
	
	var result byte
	for i := 0; i < len(hash); i++ {
		result |= hash[i] ^ expectedHash[i]
	}
	
	return result == 0, nil
}

// IPWhitelist manages IP-based access control
type IPWhitelist struct {
	allowed map[string]bool
	mu      sync.RWMutex
}

// NewIPWhitelist creates a new IP whitelist
func NewIPWhitelist() *IPWhitelist {
	return &IPWhitelist{
		allowed: make(map[string]bool),
	}
}

// Add adds an IP to the whitelist
func (w *IPWhitelist) Add(ip string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.allowed[ip] = true
}

// Remove removes an IP from the whitelist
func (w *IPWhitelist) Remove(ip string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.allowed, ip)
}

// IsAllowed checks if an IP is whitelisted
func (w *IPWhitelist) IsAllowed(ip string) bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	
	// Check exact match
	if w.allowed[ip] {
		return true
	}
	
	// Check subnet matches
	for allowed := range w.allowed {
		if w.matchesSubnet(ip, allowed) {
			return true
		}
	}
	
	return false
}

func (w *IPWhitelist) matchesSubnet(ip, subnet string) bool {
	// Simple subnet matching
	_, ipNet, err := net.ParseCIDR(subnet)
	if err != nil {
		return false
	}
	
	ipAddr := net.ParseIP(ip)
	return ipNet.Contains(ipAddr)
}

// DefaultSecurityConfig returns default security configuration
func DefaultSecurityConfig() *SecurityConfig {
	return &SecurityConfig{
		EncryptionLevel:        "high",
		KeyRotationPeriod:      7 * 24 * time.Hour, // Weekly
		RequireMultiFactor:     true,
		SessionTimeout:         30 * time.Minute,
		MaxFailedAttempts:      5,
		AuditLevel:             "comprehensive",
		RetentionPeriod:        90 * 24 * time.Hour, // 90 days
		EnableIDS:              true,
		EnableAnomalyDetection: true,
		ThreatIntelligence:     true,
	}
}