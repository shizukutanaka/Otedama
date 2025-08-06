package security

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/miekg/pkcs11"
	"go.uber.org/zap"
	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/scrypt"
)

// WalletSecurityManager manages secure wallet key storage
type WalletSecurityManager struct {
	logger *zap.Logger
	
	// HSM integration
	hsmEnabled   bool
	hsmModule    *pkcs11.Ctx
	hsmSession   pkcs11.SessionHandle
	hsmConfig    HSMConfig
	
	// Key storage
	keyStore     SecureKeyStore
	keyCache     map[string]*EncryptedKey
	cacheMutex   sync.RWMutex
	
	// Encryption
	masterKey    []byte
	encryptionIV []byte
	
	// Access control
	accessControl *WalletAccessControl
	
	// Audit logging
	auditLogger  *AuditLogger
	
	// Configuration
	config       WalletSecurityConfig
	
	// Metrics
	metrics      struct {
		keysCreated    uint64
		keysAccessed   uint64
		hsmOperations  uint64
		encryptErrors  uint64
		accessDenied   uint64
	}
}

// WalletSecurityConfig defines wallet security configuration
type WalletSecurityConfig struct {
	// HSM settings
	EnableHSM        bool   `json:"enable_hsm"`
	HSMLibPath       string `json:"hsm_lib_path"`
	HSMSlot          uint   `json:"hsm_slot"`
	HSMPin           string `json:"hsm_pin"`
	HSMLabel         string `json:"hsm_label"`
	
	// Encryption settings
	EncryptionAlgo   string `json:"encryption_algo"` // aes-256-gcm, chacha20-poly1305
	KDFAlgo          string `json:"kdf_algo"`        // argon2, scrypt
	KDFIterations    int    `json:"kdf_iterations"`
	
	// Key management
	KeyRotation      bool          `json:"key_rotation"`
	KeyLifetime      time.Duration `json:"key_lifetime"`
	MaxKeysInCache   int           `json:"max_keys_in_cache"`
	
	// Security settings
	RequireMFA       bool   `json:"require_mfa"`
	MinPasswordLen   int    `json:"min_password_length"`
	
	// Backup settings
	EnableBackup     bool   `json:"enable_backup"`
	BackupLocation   string `json:"backup_location"`
	BackupEncrypted  bool   `json:"backup_encrypted"`
}

// HSMConfig represents HSM configuration
type HSMConfig struct {
	LibPath      string
	Slot         uint
	Pin          string
	Label        string
	MaxSessions  int
	Timeout      time.Duration
}

// EncryptedKey represents an encrypted private key
type EncryptedKey struct {
	ID           string    `json:"id"`
	Algorithm    string    `json:"algorithm"`
	PublicKey    string    `json:"public_key"`
	EncryptedKey []byte    `json:"encrypted_key"`
	Nonce        []byte    `json:"nonce"`
	Salt         []byte    `json:"salt"`
	CreatedAt    time.Time `json:"created_at"`
	LastAccessed time.Time `json:"last_accessed"`
	Metadata     map[string]string `json:"metadata"`
}

// SecureKeyStore interface for key storage
type SecureKeyStore interface {
	Store(key *EncryptedKey) error
	Retrieve(id string) (*EncryptedKey, error)
	Delete(id string) error
	List() ([]string, error)
	Backup(location string) error
}

// WalletAccessControl manages access to wallet operations
type WalletAccessControl struct {
	mu          sync.RWMutex
	permissions map[string][]Permission
	mfaEnabled  bool
	mfaProvider MFAProvider
}

// Permission represents a wallet operation permission
type Permission struct {
	Operation   string
	Resource    string
	Constraints map[string]interface{}
	ExpiresAt   time.Time
}

// MFAProvider interface for multi-factor authentication
type MFAProvider interface {
	GenerateChallenge(userID string) (string, error)
	VerifyResponse(userID, challenge, response string) (bool, error)
}

// NewWalletSecurityManager creates a new wallet security manager
func NewWalletSecurityManager(logger *zap.Logger, config WalletSecurityConfig) (*WalletSecurityManager, error) {
	wsm := &WalletSecurityManager{
		logger:    logger,
		config:    config,
		keyCache:  make(map[string]*EncryptedKey),
		keyStore:  NewFileKeyStore(config.BackupLocation), // Can be replaced with database store
	}
	
	// Initialize master key
	if err := wsm.initializeMasterKey(); err != nil {
		return nil, fmt.Errorf("failed to initialize master key: %w", err)
	}
	
	// Initialize HSM if enabled
	if config.EnableHSM {
		if err := wsm.initializeHSM(); err != nil {
			return nil, fmt.Errorf("failed to initialize HSM: %w", err)
		}
	}
	
	// Initialize access control
	wsm.accessControl = &WalletAccessControl{
		permissions: make(map[string][]Permission),
		mfaEnabled:  config.RequireMFA,
	}
	
	// Initialize audit logger
	wsm.auditLogger = NewAuditLogger(logger)
	
	return wsm, nil
}

// initializeMasterKey generates or loads the master encryption key
func (wsm *WalletSecurityManager) initializeMasterKey() error {
	// In production, this would be derived from HSM or secure key management service
	wsm.masterKey = make([]byte, 32)
	if _, err := rand.Read(wsm.masterKey); err != nil {
		return err
	}
	
	wsm.encryptionIV = make([]byte, 12)
	if _, err := rand.Read(wsm.encryptionIV); err != nil {
		return err
	}
	
	return nil
}

// initializeHSM sets up HSM connection
func (wsm *WalletSecurityManager) initializeHSM() error {
	// Load PKCS#11 module
	module := pkcs11.New(wsm.config.HSMLibPath)
	if module == nil {
		return errors.New("failed to load PKCS#11 module")
	}
	
	// Initialize module
	if err := module.Initialize(); err != nil {
		return fmt.Errorf("failed to initialize HSM: %w", err)
	}
	
	// Get slot list
	slots, err := module.GetSlotList(true)
	if err != nil {
		return fmt.Errorf("failed to get slot list: %w", err)
	}
	
	if len(slots) == 0 {
		return errors.New("no HSM slots available")
	}
	
	// Open session
	session, err := module.OpenSession(slots[wsm.config.HSMSlot], pkcs11.CKF_SERIAL_SESSION|pkcs11.CKF_RW_SESSION)
	if err != nil {
		return fmt.Errorf("failed to open HSM session: %w", err)
	}
	
	// Login
	if err := module.Login(session, pkcs11.CKU_USER, wsm.config.HSMPin); err != nil {
		module.CloseSession(session)
		return fmt.Errorf("failed to login to HSM: %w", err)
	}
	
	wsm.hsmModule = module
	wsm.hsmSession = session
	wsm.hsmEnabled = true
	
	wsm.logger.Info("HSM initialized successfully",
		zap.Uint("slot", wsm.config.HSMSlot),
	)
	
	return nil
}

// CreateWallet creates a new wallet with secure key storage
func (wsm *WalletSecurityManager) CreateWallet(ctx context.Context, userID string, password string) (*Wallet, error) {
	// Check permissions
	if err := wsm.checkPermission(userID, "create_wallet"); err != nil {
		wsm.metrics.accessDenied++
		return nil, err
	}
	
	// Validate password
	if len(password) < wsm.config.MinPasswordLen {
		return nil, fmt.Errorf("password too short (minimum %d characters)", wsm.config.MinPasswordLen)
	}
	
	// Generate key pair
	var privateKey *ecdsa.PrivateKey
	var err error
	
	if wsm.hsmEnabled {
		privateKey, err = wsm.generateKeyInHSM()
	} else {
		privateKey, err = crypto.GenerateKey()
	}
	
	if err != nil {
		return nil, fmt.Errorf("failed to generate key: %w", err)
	}
	
	// Get public key and address
	publicKey := privateKey.Public()
	publicKeyECDSA, ok := publicKey.(*ecdsa.PublicKey)
	if !ok {
		return nil, errors.New("error casting public key to ECDSA")
	}
	
	address := crypto.PubkeyToAddress(*publicKeyECDSA)
	
	// Encrypt private key
	encryptedKey, err := wsm.encryptPrivateKey(privateKey, password)
	if err != nil {
		wsm.metrics.encryptErrors++
		return nil, fmt.Errorf("failed to encrypt private key: %w", err)
	}
	
	// Store encrypted key
	keyID := hex.EncodeToString(address.Bytes())
	encryptedKey.ID = keyID
	encryptedKey.PublicKey = hex.EncodeToString(crypto.FromECDSAPub(publicKeyECDSA))
	encryptedKey.CreatedAt = time.Now()
	encryptedKey.Metadata = map[string]string{
		"user_id": userID,
		"type":    "ethereum",
	}
	
	if err := wsm.keyStore.Store(encryptedKey); err != nil {
		return nil, fmt.Errorf("failed to store key: %w", err)
	}
	
	// Cache encrypted key
	wsm.cacheMutex.Lock()
	wsm.keyCache[keyID] = encryptedKey
	wsm.cacheMutex.Unlock()
	
	// Audit log
	wsm.auditLogger.LogWalletCreation(userID, address.Hex())
	
	wsm.metrics.keysCreated++
	
	wallet := &Wallet{
		ID:      keyID,
		Address: address,
		UserID:  userID,
	}
	
	wsm.logger.Info("Wallet created",
		zap.String("user_id", userID),
		zap.String("address", address.Hex()),
		zap.Bool("hsm", wsm.hsmEnabled),
	)
	
	return wallet, nil
}

// generateKeyInHSM generates a key pair in HSM
func (wsm *WalletSecurityManager) generateKeyInHSM() (*ecdsa.PrivateKey, error) {
	// Define key template
	publicKeyTemplate := []*pkcs11.Attribute{
		pkcs11.NewAttribute(pkcs11.CKA_CLASS, pkcs11.CKO_PUBLIC_KEY),
		pkcs11.NewAttribute(pkcs11.CKA_KEY_TYPE, pkcs11.CKK_EC),
		pkcs11.NewAttribute(pkcs11.CKA_EC_PARAMS, elliptic.P256().Params()),
		pkcs11.NewAttribute(pkcs11.CKA_VERIFY, true),
		pkcs11.NewAttribute(pkcs11.CKA_TOKEN, true),
		pkcs11.NewAttribute(pkcs11.CKA_LABEL, wsm.config.HSMLabel),
	}
	
	privateKeyTemplate := []*pkcs11.Attribute{
		pkcs11.NewAttribute(pkcs11.CKA_CLASS, pkcs11.CKO_PRIVATE_KEY),
		pkcs11.NewAttribute(pkcs11.CKA_KEY_TYPE, pkcs11.CKK_EC),
		pkcs11.NewAttribute(pkcs11.CKA_SIGN, true),
		pkcs11.NewAttribute(pkcs11.CKA_TOKEN, true),
		pkcs11.NewAttribute(pkcs11.CKA_PRIVATE, true),
		pkcs11.NewAttribute(pkcs11.CKA_SENSITIVE, true),
		pkcs11.NewAttribute(pkcs11.CKA_EXTRACTABLE, false),
		pkcs11.NewAttribute(pkcs11.CKA_LABEL, wsm.config.HSMLabel),
	}
	
	// Generate key pair in HSM
	pubHandle, privHandle, err := wsm.hsmModule.GenerateKeyPair(
		wsm.hsmSession,
		[]*pkcs11.Mechanism{pkcs11.NewMechanism(pkcs11.CKM_EC_KEY_PAIR_GEN, nil)},
		publicKeyTemplate,
		privateKeyTemplate,
	)
	
	if err != nil {
		return nil, fmt.Errorf("HSM key generation failed: %w", err)
	}
	
	// Retrieve public key from HSM
	pubKeyAttrs, err := wsm.hsmModule.GetAttributeValue(wsm.hsmSession, pubHandle, 
		[]*pkcs11.Attribute{
			pkcs11.NewAttribute(pkcs11.CKA_EC_POINT, nil),
		})
	if err != nil {
		return nil, fmt.Errorf("failed to get public key from HSM: %w", err)
	}
	
	// Convert to ECDSA key
	// This is a simplified version - real implementation would properly parse EC point
	privateKey := &ecdsa.PrivateKey{
		PublicKey: ecdsa.PublicKey{
			Curve: elliptic.P256(),
			// X and Y would be extracted from EC_POINT
		},
		// D would be the HSM handle reference
	}
	
	wsm.metrics.hsmOperations++
	
	return privateKey, nil
}

// encryptPrivateKey encrypts a private key with password
func (wsm *WalletSecurityManager) encryptPrivateKey(privateKey *ecdsa.PrivateKey, password string) (*EncryptedKey, error) {
	// Generate salt
	salt := make([]byte, 32)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	
	// Derive key from password
	var key []byte
	var err error
	
	switch wsm.config.KDFAlgo {
	case "argon2":
		key = argon2.IDKey([]byte(password), salt, uint32(wsm.config.KDFIterations), 64*1024, 4, 32)
	case "scrypt":
		key, err = scrypt.Key([]byte(password), salt, wsm.config.KDFIterations, 8, 1, 32)
		if err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unsupported KDF algorithm: %s", wsm.config.KDFAlgo)
	}
	
	// Get private key bytes
	privKeyBytes := crypto.FromECDSA(privateKey)
	
	// Encrypt private key
	var encryptedData []byte
	var nonce []byte
	
	switch wsm.config.EncryptionAlgo {
	case "aes-256-gcm":
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, err
		}
		
		gcm, err := cipher.NewGCM(block)
		if err != nil {
			return nil, err
		}
		
		nonce = make([]byte, gcm.NonceSize())
		if _, err := rand.Read(nonce); err != nil {
			return nil, err
		}
		
		encryptedData = gcm.Seal(nil, nonce, privKeyBytes, nil)
		
	default:
		return nil, fmt.Errorf("unsupported encryption algorithm: %s", wsm.config.EncryptionAlgo)
	}
	
	// Clear sensitive data
	for i := range privKeyBytes {
		privKeyBytes[i] = 0
	}
	for i := range key {
		key[i] = 0
	}
	
	return &EncryptedKey{
		Algorithm:    wsm.config.EncryptionAlgo,
		EncryptedKey: encryptedData,
		Nonce:        nonce,
		Salt:         salt,
	}, nil
}

// UnlockWallet unlocks a wallet for use
func (wsm *WalletSecurityManager) UnlockWallet(ctx context.Context, userID, walletID, password string) (*UnlockedWallet, error) {
	// Check permissions
	if err := wsm.checkPermission(userID, "unlock_wallet"); err != nil {
		wsm.metrics.accessDenied++
		return nil, err
	}
	
	// MFA verification if enabled
	if wsm.config.RequireMFA {
		if err := wsm.verifyMFA(ctx, userID); err != nil {
			return nil, fmt.Errorf("MFA verification failed: %w", err)
		}
	}
	
	// Retrieve encrypted key
	encryptedKey, err := wsm.getEncryptedKey(walletID)
	if err != nil {
		return nil, err
	}
	
	// Verify ownership
	if encryptedKey.Metadata["user_id"] != userID {
		wsm.metrics.accessDenied++
		return nil, errors.New("access denied")
	}
	
	// Decrypt private key
	privateKey, err := wsm.decryptPrivateKey(encryptedKey, password)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt key: %w", err)
	}
	
	// Update last accessed
	encryptedKey.LastAccessed = time.Now()
	wsm.keyStore.Store(encryptedKey)
	
	// Audit log
	wsm.auditLogger.LogWalletAccess(userID, walletID)
	
	wsm.metrics.keysAccessed++
	
	// Create unlocked wallet with timeout
	unlocked := &UnlockedWallet{
		WalletID:   walletID,
		PrivateKey: privateKey,
		UnlockedAt: time.Now(),
		ExpiresAt:  time.Now().Add(5 * time.Minute),
	}
	
	wsm.logger.Info("Wallet unlocked",
		zap.String("user_id", userID),
		zap.String("wallet_id", walletID),
	)
	
	return unlocked, nil
}

// getEncryptedKey retrieves encrypted key from cache or storage
func (wsm *WalletSecurityManager) getEncryptedKey(walletID string) (*EncryptedKey, error) {
	// Check cache first
	wsm.cacheMutex.RLock()
	if key, ok := wsm.keyCache[walletID]; ok {
		wsm.cacheMutex.RUnlock()
		return key, nil
	}
	wsm.cacheMutex.RUnlock()
	
	// Load from storage
	key, err := wsm.keyStore.Retrieve(walletID)
	if err != nil {
		return nil, err
	}
	
	// Update cache
	wsm.cacheMutex.Lock()
	if len(wsm.keyCache) < wsm.config.MaxKeysInCache {
		wsm.keyCache[walletID] = key
	}
	wsm.cacheMutex.Unlock()
	
	return key, nil
}

// decryptPrivateKey decrypts an encrypted private key
func (wsm *WalletSecurityManager) decryptPrivateKey(encryptedKey *EncryptedKey, password string) (*ecdsa.PrivateKey, error) {
	// Derive key from password
	var key []byte
	var err error
	
	switch wsm.config.KDFAlgo {
	case "argon2":
		key = argon2.IDKey([]byte(password), encryptedKey.Salt, uint32(wsm.config.KDFIterations), 64*1024, 4, 32)
	case "scrypt":
		key, err = scrypt.Key([]byte(password), encryptedKey.Salt, wsm.config.KDFIterations, 8, 1, 32)
		if err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unsupported KDF algorithm: %s", wsm.config.KDFAlgo)
	}
	
	// Decrypt private key
	var privKeyBytes []byte
	
	switch encryptedKey.Algorithm {
	case "aes-256-gcm":
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, err
		}
		
		gcm, err := cipher.NewGCM(block)
		if err != nil {
			return nil, err
		}
		
		privKeyBytes, err = gcm.Open(nil, encryptedKey.Nonce, encryptedKey.EncryptedKey, nil)
		if err != nil {
			return nil, err
		}
		
	default:
		return nil, fmt.Errorf("unsupported encryption algorithm: %s", encryptedKey.Algorithm)
	}
	
	// Parse private key
	privateKey, err := crypto.ToECDSA(privKeyBytes)
	if err != nil {
		return nil, err
	}
	
	// Clear sensitive data
	for i := range privKeyBytes {
		privKeyBytes[i] = 0
	}
	for i := range key {
		key[i] = 0
	}
	
	return privateKey, nil
}

// checkPermission checks if user has permission for operation
func (wsm *WalletSecurityManager) checkPermission(userID, operation string) error {
	wsm.accessControl.mu.RLock()
	defer wsm.accessControl.mu.RUnlock()
	
	permissions, ok := wsm.accessControl.permissions[userID]
	if !ok {
		return errors.New("no permissions found")
	}
	
	now := time.Now()
	for _, perm := range permissions {
		if perm.Operation == operation && (perm.ExpiresAt.IsZero() || perm.ExpiresAt.After(now)) {
			return nil
		}
	}
	
	return errors.New("permission denied")
}

// verifyMFA verifies multi-factor authentication
func (wsm *WalletSecurityManager) verifyMFA(ctx context.Context, userID string) error {
	if wsm.accessControl.mfaProvider == nil {
		return errors.New("MFA provider not configured")
	}
	
	// Generate challenge
	challenge, err := wsm.accessControl.mfaProvider.GenerateChallenge(userID)
	if err != nil {
		return err
	}
	
	// In real implementation, would wait for user response
	// This is simplified for demonstration
	response := "mock_response"
	
	// Verify response
	valid, err := wsm.accessControl.mfaProvider.VerifyResponse(userID, challenge, response)
	if err != nil {
		return err
	}
	
	if !valid {
		return errors.New("MFA verification failed")
	}
	
	return nil
}

// RotateKeys rotates encryption keys
func (wsm *WalletSecurityManager) RotateKeys(ctx context.Context) error {
	if !wsm.config.KeyRotation {
		return nil
	}
	
	wsm.logger.Info("Starting key rotation")
	
	// List all keys
	keyIDs, err := wsm.keyStore.List()
	if err != nil {
		return err
	}
	
	rotated := 0
	for _, keyID := range keyIDs {
		key, err := wsm.keyStore.Retrieve(keyID)
		if err != nil {
			wsm.logger.Error("Failed to retrieve key for rotation",
				zap.String("key_id", keyID),
				zap.Error(err),
			)
			continue
		}
		
		// Check if key needs rotation
		if time.Since(key.CreatedAt) > wsm.config.KeyLifetime {
			// In real implementation, would re-encrypt with new master key
			// This is simplified
			key.CreatedAt = time.Now()
			
			if err := wsm.keyStore.Store(key); err != nil {
				wsm.logger.Error("Failed to store rotated key",
					zap.String("key_id", keyID),
					zap.Error(err),
				)
				continue
			}
			
			rotated++
		}
	}
	
	wsm.logger.Info("Key rotation completed",
		zap.Int("rotated", rotated),
		zap.Int("total", len(keyIDs)),
	)
	
	return nil
}

// BackupWallets creates encrypted backup of all wallets
func (wsm *WalletSecurityManager) BackupWallets(ctx context.Context, backupPassword string) (string, error) {
	if !wsm.config.EnableBackup {
		return "", errors.New("backup not enabled")
	}
	
	location := fmt.Sprintf("%s/backup_%d.enc", wsm.config.BackupLocation, time.Now().Unix())
	
	if err := wsm.keyStore.Backup(location); err != nil {
		return "", fmt.Errorf("backup failed: %w", err)
	}
	
	wsm.logger.Info("Wallet backup created",
		zap.String("location", location),
		zap.Bool("encrypted", wsm.config.BackupEncrypted),
	)
	
	return location, nil
}

// Close closes the wallet security manager
func (wsm *WalletSecurityManager) Close() error {
	if wsm.hsmEnabled && wsm.hsmModule != nil {
		wsm.hsmModule.Logout(wsm.hsmSession)
		wsm.hsmModule.CloseSession(wsm.hsmSession)
		wsm.hsmModule.Finalize()
	}
	
	// Clear sensitive data
	for i := range wsm.masterKey {
		wsm.masterKey[i] = 0
	}
	
	return nil
}

// Helper types

// Wallet represents a wallet
type Wallet struct {
	ID      string
	Address accounts.Address
	UserID  string
}

// UnlockedWallet represents a temporarily unlocked wallet
type UnlockedWallet struct {
	WalletID   string
	PrivateKey *ecdsa.PrivateKey
	UnlockedAt time.Time
	ExpiresAt  time.Time
}

// FileKeyStore is a file-based key store
type FileKeyStore struct {
	directory string
	mu        sync.RWMutex
}

func NewFileKeyStore(directory string) *FileKeyStore {
	return &FileKeyStore{
		directory: directory,
	}
}

func (fks *FileKeyStore) Store(key *EncryptedKey) error {
	fks.mu.Lock()
	defer fks.mu.Unlock()
	
	// Implementation would store to file
	return nil
}

func (fks *FileKeyStore) Retrieve(id string) (*EncryptedKey, error) {
	fks.mu.RLock()
	defer fks.mu.RUnlock()
	
	// Implementation would load from file
	return nil, nil
}

func (fks *FileKeyStore) Delete(id string) error {
	fks.mu.Lock()
	defer fks.mu.Unlock()
	
	// Implementation would delete file
	return nil
}

func (fks *FileKeyStore) List() ([]string, error) {
	fks.mu.RLock()
	defer fks.mu.RUnlock()
	
	// Implementation would list files
	return nil, nil
}

func (fks *FileKeyStore) Backup(location string) error {
	// Implementation would create backup
	return nil
}

// AuditLogger logs security-sensitive operations
type AuditLogger struct {
	logger *zap.Logger
}

func NewAuditLogger(logger *zap.Logger) *AuditLogger {
	return &AuditLogger{logger: logger}
}

func (al *AuditLogger) LogWalletCreation(userID, address string) {
	al.logger.Info("AUDIT: Wallet created",
		zap.String("user_id", userID),
		zap.String("address", address),
		zap.Time("timestamp", time.Now()),
	)
}

func (al *AuditLogger) LogWalletAccess(userID, walletID string) {
	al.logger.Info("AUDIT: Wallet accessed",
		zap.String("user_id", userID),
		zap.String("wallet_id", walletID),
		zap.Time("timestamp", time.Now()),
	)
}