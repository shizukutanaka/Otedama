package security

import (
    "bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"go.uber.org/zap"
	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/scrypt"
)

// WalletSecurityManager manages secure wallet key storage
type WalletSecurityManager struct {
	logger *zap.Logger
	// HSM integration
	hsmEnabled   bool
	// Use generic types to avoid hard dependency on cgo pkcs11 in default builds
	hsmModule    any
	hsmSession   any
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
	metrics struct {
		keysCreated    uint64
		keysAccessed   uint64
		hsmOperations  uint64
		encryptErrors  uint64
		accessDenied   uint64
	}

// normalizeKDFIterations returns a safe algorithm name and iteration count to use
// for password-based key derivation during backups.
// - argon2: clamp iterations to [1,10], default 3
// - scrypt: enforce N to a power-of-two and >= 1<<12 (4096), default 1<<14 (16384)
func (wsm *WalletSecurityManager) normalizeKDFIterations() (string, int) {
    algo := strings.ToLower(strings.TrimSpace(wsm.config.KDFAlgo))
    iters := wsm.config.KDFIterations
    switch algo {
    case "argon2":
        if iters <= 0 { iters = 3 }
        if iters > 10 { iters = 10 }
    case "scrypt":
        if iters <= 0 {
            iters = 1 << 14
        } else {
            // ensure power-of-two and minimum cost
            if iters < (1<<12) || (iters&(iters-1)) != 0 {
                iters = 1 << 14
            }
        }
    default:
        // Fall back to argon2 sensible defaults
        algo = "argon2"
        if iters <= 0 { iters = 3 }
        if iters > 10 { iters = 10 }
    }
    return algo, iters
}

// Operation constants for access control
const (
	OpWalletBackup  = "wallet.backup"
	OpWalletRestore = "wallet.restore"
	OpWalletDelete  = "wallet.delete"
	OpWalletRotate  = "wallet.rotate"
)

// initializeMasterKey sets up the master key and IV in memory
func (wsm *WalletSecurityManager) initializeMasterKey() error {
    wsm.masterKey = make([]byte, 32)
    if _, err := rand.Read(wsm.masterKey); err != nil {
        return fmt.Errorf("generate master key: %w", err)
    }
    // Use a 12-byte nonce size compatible with AES-GCM
    wsm.encryptionIV = make([]byte, 12)
    if _, err := rand.Read(wsm.encryptionIV); err != nil {
        return fmt.Errorf("generate encryption iv: %w", err)
    }
    return nil
}

// initializeHSM initializes HSM context if enabled (stubbed)
func (wsm *WalletSecurityManager) initializeHSM() error {
    // In this MVP, we only flag HSM as enabled; real session/login handled elsewhere
    wsm.hsmEnabled = true
    return nil
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
	KeyStoreDir      string        `json:"keystore_dir"`
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

// encryptedBackupFile represents the on-disk format of encrypted backups
type encryptedBackupFile struct {
	Algorithm  string    `json:"algorithm"`
	KDF        string    `json:"kdf"`
	Iterations int       `json:"iterations"`
	// Optional KDF parameters
	MemoryKiB   int       `json:"memory_kib,omitempty"`   // argon2 memory
	Parallelism int       `json:"parallelism,omitempty"`  // argon2 threads
	R           int       `json:"r,omitempty"`            // scrypt r
	P           int       `json:"p,omitempty"`            // scrypt p
	Salt       []byte    `json:"salt"`
	Nonce      []byte    `json:"nonce"`
	Ciphertext []byte    `json:"ciphertext"`
	CreatedAt  time.Time `json:"created_at"`
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

// HasPermission checks if a user has permission for an operation
func (wac *WalletAccessControl) HasPermission(userID, operation string) bool {
    wac.mu.RLock()
    defer wac.mu.RUnlock()
    perms := wac.permissions[userID]
    if len(perms) == 0 {
        return false
    }
    now := time.Now()
    for _, p := range perms {
        if p.Operation == operation {
            if p.ExpiresAt.IsZero() || now.Before(p.ExpiresAt) {
                return true
            }
        }
    }
    return false
}

// MFAEnabled returns whether MFA is required
func (wac *WalletAccessControl) MFAEnabled() bool {
    wac.mu.RLock()
    defer wac.mu.RUnlock()
    return wac.mfaEnabled
}

// MFAProvider returns current MFA provider
func (wac *WalletAccessControl) MFAProvider() MFAProvider {
    wac.mu.RLock()
    defer wac.mu.RUnlock()
    return wac.mfaProvider
}

// Grant adds a permission for a user
func (wac *WalletAccessControl) Grant(userID string, perm Permission) {
	wac.mu.Lock()
	defer wac.mu.Unlock()
	wac.permissions[userID] = append(wac.permissions[userID], perm)
}

// Revoke removes permissions for an operation for a user
func (wac *WalletAccessControl) Revoke(userID, operation string) {
	wac.mu.Lock()
	defer wac.mu.Unlock()
	perms := wac.permissions[userID]
	if len(perms) == 0 {
		return
	}
	filtered := perms[:0]
	for _, p := range perms {
		if p.Operation != operation {
			filtered = append(filtered, p)
		}
	}
	if len(filtered) == 0 {
		delete(wac.permissions, userID)
	} else {
		wac.permissions[userID] = filtered
	}
}

// SetMFAProvider sets the MFA provider
func (wac *WalletAccessControl) SetMFAProvider(p MFAProvider) {
	wac.mu.Lock()
	defer wac.mu.Unlock()
	wac.mfaProvider = p
}

// EnableMFA toggles MFA requirement
func (wac *WalletAccessControl) EnableMFA(enabled bool) {
	wac.mu.Lock()
	defer wac.mu.Unlock()
	wac.mfaEnabled = enabled
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
    EnrollUser(userID string, data interface{}) error
}

func NewWalletSecurityManager(logger *zap.Logger, config WalletSecurityConfig) (*WalletSecurityManager, error) {
	// Apply sane defaults
	defaults := WalletSecurityConfig{
		EncryptionAlgo:   "aes-256-gcm",
		KDFAlgo:          "argon2",
		KDFIterations:    3,
		MinPasswordLen:   8,
		MaxKeysInCache:   100,
		KeyStoreDir:      filepath.Join(".", "data", "keystore"),
		BackupLocation:   filepath.Join(".", "data", "keystore", "backup.json"),
	}

	if config.EncryptionAlgo == "" {
		config.EncryptionAlgo = defaults.EncryptionAlgo
	}
	if config.KDFAlgo == "" {
		config.KDFAlgo = defaults.KDFAlgo
	}
	if config.KDFIterations == 0 {
		config.KDFIterations = defaults.KDFIterations
	}
	if config.MinPasswordLen <= 0 {
		config.MinPasswordLen = defaults.MinPasswordLen
	}
	if config.MaxKeysInCache <= 0 {
		config.MaxKeysInCache = defaults.MaxKeysInCache
	}
	if strings.TrimSpace(config.KeyStoreDir) == "" {
		config.KeyStoreDir = defaults.KeyStoreDir
	}
	if strings.TrimSpace(config.BackupLocation) == "" {
		config.BackupLocation = defaults.BackupLocation
	}

	wsm := &WalletSecurityManager{
		logger:   logger,
		config:   config,
		keyCache: make(map[string]*EncryptedKey),
		keyStore: NewFileKeyStore(config.KeyStoreDir), // Can be replaced with database or HSM-backed store
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

// BackupWallets creates encrypted backup of all wallets
func (wsm *WalletSecurityManager) BackupWallets(ctx context.Context, backupPassword string) (string, error) {
    if !wsm.config.EnableBackup {
        return "", errors.New("backup not enabled")
    }

    // Validate password for encrypted backups
    if wsm.config.BackupEncrypted {
        if len(backupPassword) < wsm.config.MinPasswordLen {
            return "", fmt.Errorf("backup password must be at least %d characters", wsm.config.MinPasswordLen)
        }
        if wsm.config.KDFIterations <= 0 {
            return "", errors.New("invalid KDF iterations; must be > 0")
        }
        if wsm.config.KDFAlgo != "argon2" && wsm.config.KDFAlgo != "scrypt" {
            return "", fmt.Errorf("unsupported KDF algorithm: %s", wsm.config.KDFAlgo)
        }
    }

	ts := time.Now().Format("20060102_150405")
	loc := wsm.config.BackupLocation

	// Determine output directory
	outDir := ""
	if strings.TrimSpace(loc) == "" {
		outDir = filepath.Join(wsm.config.KeyStoreDir, "backups")
	} else {
		if info, err := os.Stat(loc); err == nil && info.IsDir() {
			outDir = loc
		} else if filepath.Ext(loc) == "" {
			// Treat as directory path if no extension
			outDir = loc
		} else {
			outDir = filepath.Dir(loc)
		}
	}

	if err := os.MkdirAll(outDir, 0o700); err != nil {
		return "", fmt.Errorf("ensure backup dir: %w", err)
	}

	if wsm.config.BackupEncrypted {
		// 1) Create plaintext JSON backup first
		tmpJSON := filepath.Join(outDir, fmt.Sprintf("backup_%s.json", ts))
		if err := wsm.keyStore.Backup(tmpJSON); err != nil {
			return "", fmt.Errorf("backup failed: %w", err)
		}

		// 2) Derive key from password (with normalized KDF parameters)
		salt := make([]byte, 32)
		if _, err := rand.Read(salt); err != nil {
			return "", fmt.Errorf("salt gen: %w", err)
		}
		var key []byte
		var err error
		algo, iters := wsm.normalizeKDFIterations()
		switch algo {
		case "argon2":
			key = argon2.IDKey([]byte(backupPassword), salt, uint32(iters), 64*1024, 4, 32)
		case "scrypt":
			key, err = scrypt.Key([]byte(backupPassword), salt, iters, 8, 1, 32)
			if err != nil {
				return "", fmt.Errorf("scrypt: %w", err)
			}
		default:
			return "", fmt.Errorf("unsupported KDF algorithm: %s", algo)
		}

		plaintext, err := os.ReadFile(tmpJSON)
		if err != nil {
			return "", fmt.Errorf("read tmp backup: %w", err)
		}

		block, err := aes.NewCipher(key)
		if err != nil {
			return "", fmt.Errorf("cipher: %w", err)
		}
		gcm, err := cipher.NewGCM(block)
		if err != nil {
			return "", fmt.Errorf("gcm: %w", err)
		}
		nonce := make([]byte, gcm.NonceSize())
		if _, err := rand.Read(nonce); err != nil {
			return "", fmt.Errorf("nonce gen: %w", err)
		}
		ciphertext := gcm.Seal(nil, nonce, plaintext, nil)

		enc := encryptedBackupFile{
			Algorithm:  "aes-256-gcm",
			KDF:        algo,
			Iterations: iters,
			Salt:       salt,
			Nonce:      nonce,
			Ciphertext: ciphertext,
			CreatedAt:  time.Now(),
		}
		data, err := json.MarshalIndent(enc, "", "  ")
		if err != nil {
			return "", fmt.Errorf("marshal encrypted backup: %w", err)
		}

		outFile := filepath.Join(outDir, fmt.Sprintf("backup_%s.enc", ts))
		if err := os.WriteFile(outFile, data, 0o600); err != nil {
			return "", fmt.Errorf("write encrypted backup: %w", err)
		}

		// Cleanup
		_ = os.Remove(tmpJSON)
		// wipe plaintext buffer
		for i := range plaintext { plaintext[i] = 0 }
		for i := range key {
			key[i] = 0
		}

		wsm.logger.Info("Wallet backup created",
			zap.String("location", outFile),
			zap.Bool("encrypted", true),
		)
		return outFile, nil
	}

	// Plain JSON backup
	outFile := filepath.Join(outDir, fmt.Sprintf("backup_%s.json", ts))
	if err := wsm.keyStore.Backup(outFile); err != nil {
		return "", fmt.Errorf("backup failed: %w", err)
	}
	wsm.logger.Info("Wallet backup created",
		zap.String("location", outFile),
		zap.Bool("encrypted", false),
	)
	return outFile, nil
}

// RestoreWallets restores wallets from a plaintext or encrypted backup file
func (wsm *WalletSecurityManager) RestoreWallets(ctx context.Context, backupPath, password string) error {
    if strings.TrimSpace(backupPath) == "" {
        return errors.New("backup path is empty")
    }

    data, err := os.ReadFile(backupPath)
    if err != nil {
        return fmt.Errorf("read backup: %w", err)
    }

    // If encrypted, decrypt first
    var plaintext []byte
    if filepath.Ext(backupPath) == ".enc" {
        if len(password) < wsm.config.MinPasswordLen {
            return fmt.Errorf("password must be at least %d characters to decrypt backup", wsm.config.MinPasswordLen)
        }
        var enc encryptedBackupFile
        dec := json.NewDecoder(bytes.NewReader(data))
        dec.DisallowUnknownFields()
        if err := dec.Decode(&enc); err != nil {
            return fmt.Errorf("unmarshal encrypted backup: %w", err)
        }

        // Basic format validations
        if strings.ToLower(strings.TrimSpace(enc.Algorithm)) != "aes-256-gcm" {
            return fmt.Errorf("unsupported encryption algorithm in backup: %s", enc.Algorithm)
        }
        if l := len(enc.Salt); l < 16 || l > 64 {
            return fmt.Errorf("invalid salt length: %d (expected 16..64)", l)
        }
        if len(enc.Ciphertext) == 0 {
            return errors.New("backup ciphertext is empty")
        }

        // Validate KDF parameters from backup
        switch enc.KDF {
        case "argon2":
            if enc.Iterations < 1 || enc.Iterations > 10 {
                return fmt.Errorf("unsupported argon2 iterations: %d", enc.Iterations)
            }
            // Defaults for optional fields
            if enc.MemoryKiB == 0 { enc.MemoryKiB = 64 * 1024 }
            if enc.Parallelism == 0 { enc.Parallelism = 4 }
            // Strict ranges
            if enc.MemoryKiB < 16*1024 || enc.MemoryKiB > 1024*1024 {
                return fmt.Errorf("unsupported argon2 memory_kib: %d (expected 16384..1048576)", enc.MemoryKiB)
            }
            if enc.Parallelism < 1 || enc.Parallelism > 16 {
                return fmt.Errorf("unsupported argon2 parallelism: %d (expected 1..16)", enc.Parallelism)
            }
        case "scrypt":
            if enc.Iterations < (1<<12) || (enc.Iterations&(enc.Iterations-1)) != 0 {
                return fmt.Errorf("unsupported scrypt N value: %d (must be power-of-two >= 4096)", enc.Iterations)
            }
            // Defaults for optional fields
            if enc.R == 0 { enc.R = 8 }
            if enc.P == 0 { enc.P = 1 }
            // Strict ranges
            if enc.R < 8 || enc.R > 64 {
                return fmt.Errorf("unsupported scrypt r: %d (expected 8..64)", enc.R)
            }
            if enc.P < 1 || enc.P > 8 {
                return fmt.Errorf("unsupported scrypt p: %d (expected 1..8)", enc.P)
            }
        default:
            return fmt.Errorf("unsupported KDF algorithm in backup: %s", enc.KDF)
        }

        var key []byte
        switch enc.KDF {
        case "argon2":
            key = argon2.IDKey([]byte(password), enc.Salt, uint32(enc.Iterations), uint32(enc.MemoryKiB), uint8(enc.Parallelism), 32)
        case "scrypt":
            key, err = scrypt.Key([]byte(password), enc.Salt, enc.Iterations, enc.R, enc.P, 32)
            if err != nil {
                return fmt.Errorf("scrypt: %w", err)
            }
        default:
            return fmt.Errorf("unsupported KDF algorithm in backup: %s", enc.KDF)
        }

        block, err := aes.NewCipher(key)
        if err != nil {
            return fmt.Errorf("cipher: %w", err)
        }
        gcm, err := cipher.NewGCM(block)
        if err != nil {
            return fmt.Errorf("gcm: %w", err)
        }
        if len(enc.Nonce) != gcm.NonceSize() {
            return fmt.Errorf("invalid nonce size: %d", len(enc.Nonce))
        }
        plaintext, err = gcm.Open(nil, enc.Nonce, enc.Ciphertext, nil)
        if err != nil {
            return fmt.Errorf("decrypt backup: %w", err)
        }
        // wipe key
        for i := range key { key[i] = 0 }
    } else {
        plaintext = data
    }

    // Parse plaintext backup into keys map
    var export map[string]*EncryptedKey
    dec := json.NewDecoder(bytes.NewReader(plaintext))
    dec.DisallowUnknownFields()
    if err := dec.Decode(&export); err != nil {
        return fmt.Errorf("unmarshal backup plaintext: %w", err)
    }
    if len(export) == 0 {
        return errors.New("backup contains no keys")
    }

    // Store keys into keystore; if exists, overwrite by delete+store
    for id, key := range export {
        if key == nil { continue }
        // Validate explicit ID mismatch; allow empty to be normalized
        if trimmed := strings.TrimSpace(key.ID); trimmed != "" && trimmed != id {
            return fmt.Errorf("key ID mismatch for %s: %s", id, key.ID)
        }
        // Normalize fields for compatibility
        if strings.TrimSpace(key.ID) == "" { key.ID = id }
        if strings.TrimSpace(key.Algorithm) == "" { key.Algorithm = "aes-256-gcm" }
        if key.Metadata == nil { key.Metadata = make(map[string]string) }
        if len(key.EncryptedKey) == 0 {
            return fmt.Errorf("key %s has empty encrypted payload", id)
        }
        // Validate algorithm and associated parameters
        if strings.ToLower(strings.TrimSpace(key.Algorithm)) != "aes-256-gcm" {
            return fmt.Errorf("unsupported key algorithm for %s: %s", id, key.Algorithm)
        }
        if n := len(key.Nonce); n != 0 && n != 12 {
            return fmt.Errorf("invalid nonce size for %s: %d", id, n)
        }
        if sl := len(key.Salt); sl != 0 && (sl < 16 || sl > 64) {
            return fmt.Errorf("invalid salt length for %s: %d (expected 0 or 16..64)", id, sl)
        }

        if err := wsm.keyStore.Store(key); err != nil {
            // Try overwrite
            _ = wsm.keyStore.Delete(id)
            if err2 := wsm.keyStore.Store(key); err2 != nil {
                return fmt.Errorf("store key %s: %w", id, err2)
            }
        }
    }

    wsm.logger.Info("Wallet restore completed",
        zap.String("source", backupPath),
    )
    // wipe plaintext buffer
    for i := range plaintext { plaintext[i] = 0 }
    return nil
}

// requireAuth validates permission and MFA for an operation
func (wsm *WalletSecurityManager) requireAuth(userID, operation, challenge, response string) error {
    if wsm.accessControl == nil {
        return errors.New("access control not initialized")
    }
    if !wsm.accessControl.HasPermission(userID, operation) {
        wsm.metrics.accessDenied++
        if wsm.auditLogger != nil {
            wsm.auditLogger.LogAccessDenied(userID, operation, "no_permission")
        }
        return fmt.Errorf("access denied for operation %s", operation)
    }
    if wsm.accessControl.MFAEnabled() {
        prov := wsm.accessControl.MFAProvider()
        if prov == nil {
            return errors.New("MFA required but provider not configured")
        }
        ok, err := prov.VerifyResponse(userID, challenge, response)
        if err != nil {
            if wsm.auditLogger != nil {
                wsm.auditLogger.LogAccessDenied(userID, operation, "mfa_error")
            }
            return fmt.Errorf("mfa verification error: %w", err)
        }
        if !ok {
            wsm.metrics.accessDenied++
            if wsm.auditLogger != nil {
                wsm.auditLogger.LogAccessDenied(userID, operation, "mfa_failed")
            }
            return errors.New("mfa verification failed")
        }
        if wsm.auditLogger != nil {
            wsm.auditLogger.LogMFAVerified(userID)
        }
    }
    if wsm.auditLogger != nil {
        wsm.auditLogger.LogAccessGranted(userID, operation)
    }
    return nil
}

// BackupWalletsWithAuth performs backup with permission and MFA checks
func (wsm *WalletSecurityManager) BackupWalletsWithAuth(ctx context.Context, userID, challenge, response, backupPassword string) (string, error) {
    if err := wsm.requireAuth(userID, OpWalletBackup, challenge, response); err != nil {
        return "", err
    }
    path, err := wsm.BackupWallets(ctx, backupPassword)
    if err == nil && wsm.auditLogger != nil {
        wsm.auditLogger.LogBackup(userID, path, wsm.config.BackupEncrypted)
    }
    return path, err
}

// RestoreWalletsWithAuth performs restore with permission and MFA checks
func (wsm *WalletSecurityManager) RestoreWalletsWithAuth(ctx context.Context, userID, challenge, response, backupPath, password string) error {
    if err := wsm.requireAuth(userID, OpWalletRestore, challenge, response); err != nil {
        return err
    }
    if err := wsm.RestoreWallets(ctx, backupPath, password); err != nil {
        if wsm.auditLogger != nil {
            wsm.auditLogger.LogAccessDenied(userID, OpWalletRestore, "restore_failed")
        }
        return err
    }
    if wsm.auditLogger != nil {
        wsm.auditLogger.LogRestore(userID, backupPath)
    }
    return nil
}

// ListWalletIDs returns all wallet IDs in the keystore
func (wsm *WalletSecurityManager) ListWalletIDs() ([]string, error) {
    return wsm.keyStore.List()
}

// DeleteWalletsWithAuth deletes the specified wallet IDs with permission and MFA checks
func (wsm *WalletSecurityManager) DeleteWalletsWithAuth(ctx context.Context, userID, challenge, response string, ids []string) error {
    if err := wsm.requireAuth(userID, OpWalletDelete, challenge, response); err != nil {
        return err
    }
    for _, id := range ids {
        if strings.TrimSpace(id) == "" { continue }
        if err := wsm.keyStore.Delete(id); err != nil {
            return fmt.Errorf("delete wallet %s: %w", id, err)
        }
        if wsm.auditLogger != nil {
            wsm.auditLogger.LogWalletDeletion(userID, id)
        }
    }
    return nil
}

// reencryptKeyInPlace re-wraps the key's encrypted blob with a fresh AES-256-GCM nonce
// using the in-memory master key. This does NOT decrypt to raw private key in this MVP;
// it treats the existing ciphertext as opaque and re-encrypts it to provide forward
// secrecy on compromise of older nonces.
func (wsm *WalletSecurityManager) reencryptKeyInPlace(key *EncryptedKey) error {
    if key == nil {
        return errors.New("nil key")
    }
    if wsm.masterKey == nil || len(wsm.masterKey) != 32 {
        return errors.New("master key not initialized")
    }
    blk, err := aes.NewCipher(wsm.masterKey)
    if err != nil {
        return fmt.Errorf("cipher: %w", err)
    }
    gcm, err := cipher.NewGCM(blk)
    if err != nil {
        return fmt.Errorf("gcm: %w", err)
    }
    nonce := make([]byte, gcm.NonceSize())
    if _, err := rand.Read(nonce); err != nil {
        return fmt.Errorf("nonce gen: %w", err)
    }
    // Re-wrap existing ciphertext as plaintext for the new envelope
    buf := make([]byte, len(key.EncryptedKey))
    copy(buf, key.EncryptedKey)
    ct := gcm.Seal(nil, nonce, buf, nil)
    // wipe buffer
    for i := range buf { buf[i] = 0 }
    key.EncryptedKey = ct
    key.Nonce = nonce
    key.Algorithm = "aes-256-gcm"
    return nil
}

// RotateKeysWithAuth rotates keys whose age exceeds KeyLifetime.
// This implementation updates metadata, refreshes timestamps, and re-wraps the
// encrypted blob with a fresh AES-256-GCM nonce derived from the in-memory master key.
func (wsm *WalletSecurityManager) RotateKeysWithAuth(ctx context.Context, userID, challenge, response string) ([]string, error) {
    if !wsm.config.KeyRotation || wsm.config.KeyLifetime <= 0 {
        return nil, errors.New("key rotation disabled or invalid lifetime")
    }
    if err := wsm.requireAuth(userID, OpWalletRotate, challenge, response); err != nil {
        return nil, err
    }

    ids, err := wsm.keyStore.List()
    if err != nil {
        return nil, fmt.Errorf("list keys: %w", err)
    }
    rotated := make([]string, 0)
    cutoff := time.Now().Add(-wsm.config.KeyLifetime)
    for _, id := range ids {
        key, err := wsm.keyStore.Retrieve(id)
        if err != nil { return nil, fmt.Errorf("retrieve %s: %w", id, err) }
        if key.CreatedAt.After(cutoff) {
            continue
        }
        if key.Metadata == nil { key.Metadata = make(map[string]string) }
        key.Metadata["rotated_at"] = time.Now().UTC().Format(time.RFC3339)
        key.LastAccessed = time.Now()
        // Re-encrypt (re-wrap) the encrypted key material with a fresh nonce
        if err := wsm.reencryptKeyInPlace(key); err != nil {
            return nil, fmt.Errorf("re-encrypt %s: %w", id, err)
        }
        key.CreatedAt = time.Now() // mark as refreshed
        if err := wsm.keyStore.Store(key); err != nil {
            return nil, fmt.Errorf("store rotated %s: %w", id, err)
        }
        rotated = append(rotated, id)
        if wsm.auditLogger != nil {
            wsm.auditLogger.LogWalletRotation(userID, id)
        }
    }
    return rotated, nil
}

// Access control helpers
func (wsm *WalletSecurityManager) SetMFAProvider(p MFAProvider) {
	if wsm.accessControl != nil {
		wsm.accessControl.SetMFAProvider(p)
	}
}

func (wsm *WalletSecurityManager) EnableMFA(enabled bool) {
	if wsm.accessControl != nil {
		wsm.accessControl.EnableMFA(enabled)
	}
}

func (wsm *WalletSecurityManager) GrantPermission(userID string, perm Permission) {
	if wsm.accessControl != nil {
		wsm.accessControl.Grant(userID, perm)
	}
}

func (wsm *WalletSecurityManager) RevokePermission(userID, operation string) {
    if wsm.accessControl != nil {
        wsm.accessControl.Revoke(userID, operation)
    }
}

// BeginMFAChallenge generates an MFA challenge for a user when MFA is enabled.
func (wsm *WalletSecurityManager) BeginMFAChallenge(userID string) (string, error) {
    if wsm.accessControl == nil || !wsm.accessControl.MFAEnabled() {
        return "", nil
    }
    prov := wsm.accessControl.MFAProvider()
    if prov == nil {
        return "", errors.New("MFA required but provider not configured")
    }
    ch, err := prov.GenerateChallenge(userID)
    if err == nil && wsm.auditLogger != nil {
        wsm.auditLogger.LogMFAChallenge(userID)
    }
    return ch, err
}

// Helper types

// Wallet represents a wallet
type Wallet struct {
	ID      string
	Address common.Address
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
	// Ensure directory exists
	if directory == "" {
		directory = "."
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		// Best-effort; caller will see errors on operations
	}
	return &FileKeyStore{
		directory: directory,
	}
}

func (fks *FileKeyStore) Store(key *EncryptedKey) error {
	fks.mu.Lock()
	defer fks.mu.Unlock()

	if key == nil {
		return errors.New("key is nil")
	}
	if strings.TrimSpace(key.ID) == "" {
		return errors.New("key ID is empty")
	}

	if err := os.MkdirAll(fks.directory, 0o700); err != nil {
		return fmt.Errorf("ensure keystore dir: %w", err)
	}

	data, err := json.MarshalIndent(key, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal key: %w", err)
	}

	path := filepath.Join(fks.directory, key.ID+".json")
	tmp := path + ".tmp"

	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write temp key file: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		// Clean up temp on failure
		_ = os.Remove(tmp)
		return fmt.Errorf("rename key file: %w", err)
	}

	return nil
}

func (fks *FileKeyStore) Retrieve(id string) (*EncryptedKey, error) {
	fks.mu.RLock()
	defer fks.mu.RUnlock()

	if strings.TrimSpace(id) == "" {
		return nil, errors.New("id is empty")
	}

	path := filepath.Join(fks.directory, id+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var key EncryptedKey
	if err := json.Unmarshal(data, &key); err != nil {
		return nil, fmt.Errorf("unmarshal key: %w", err)
	}
	return &key, nil
}

func (fks *FileKeyStore) Delete(id string) error {
	fks.mu.Lock()
	defer fks.mu.Unlock()

	if strings.TrimSpace(id) == "" {
		return errors.New("id is empty")
	}
	path := filepath.Join(fks.directory, id+".json")
	if err := os.Remove(path); err != nil {
		return err
	}
	return nil
}

func (fks *FileKeyStore) List() ([]string, error) {
	fks.mu.RLock()
	defer fks.mu.RUnlock()

	entries, err := os.ReadDir(fks.directory)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if filepath.Ext(name) != ".json" {
			continue
		}
		base := strings.TrimSuffix(name, filepath.Ext(name))
		if base != "" {
			ids = append(ids, base)
		}
	}
	return ids, nil
}

func (fks *FileKeyStore) Backup(location string) error {
	if strings.TrimSpace(location) == "" {
		return errors.New("backup location is empty")
	}

	// Collect all keys
	ids, err := fks.List()
	if err != nil {
		return fmt.Errorf("list keys: %w", err)
	}

	export := make(map[string]*EncryptedKey, len(ids))
	for _, id := range ids {
		key, err := fks.Retrieve(id)
		if err != nil {
			return fmt.Errorf("retrieve key %s: %w", id, err)
		}
		export[id] = key
	}

	data, err := json.MarshalIndent(export, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal backup: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(location), 0o700); err != nil {
		return fmt.Errorf("ensure backup dir: %w", err)
	}
	if err := os.WriteFile(location, data, 0o600); err != nil {
		return fmt.Errorf("write backup: %w", err)
	}
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

func (al *AuditLogger) LogWalletDeletion(userID, walletID string) {
	al.logger.Info("AUDIT: Wallet deleted",
		zap.String("user_id", userID),
		zap.String("wallet_id", walletID),
		zap.Time("timestamp", time.Now()),
	)
}

func (al *AuditLogger) LogWalletRotation(userID, walletID string) {
	al.logger.Info("AUDIT: Wallet rotated",
		zap.String("user_id", userID),
		zap.String("wallet_id", walletID),
		zap.Time("timestamp", time.Now()),
	)
}

func (al *AuditLogger) LogBackup(userID, location string, encrypted bool) {
	al.logger.Info("AUDIT: Wallet backup created",
		zap.String("user_id", userID),
		zap.String("location", location),
		zap.Bool("encrypted", encrypted),
		zap.Time("timestamp", time.Now()),
	)
}

func (al *AuditLogger) LogRestore(userID, source string) {
	al.logger.Info("AUDIT: Wallet restore completed",
		zap.String("user_id", userID),
		zap.String("source", source),
		zap.Time("timestamp", time.Now()),
	)
}

// LogAccessDenied records an access denial event with reason
func (al *AuditLogger) LogAccessDenied(userID, operation, reason string) {
	al.logger.Warn("AUDIT: Access denied",
		zap.String("user_id", userID),
		zap.String("operation", operation),
		zap.String("reason", reason),
		zap.Time("timestamp", time.Now()),
	)
}

// LogAccessGranted records a successful authorization
func (al *AuditLogger) LogAccessGranted(userID, operation string) {
	al.logger.Info("AUDIT: Access granted",
		zap.String("user_id", userID),
		zap.String("operation", operation),
		zap.Time("timestamp", time.Now()),
	)
}

// LogMFAChallenge records issuing an MFA challenge
func (al *AuditLogger) LogMFAChallenge(userID string) {
	al.logger.Info("AUDIT: MFA challenge issued",
		zap.String("user_id", userID),
		zap.Time("timestamp", time.Now()),
	)
}

// LogMFAVerified records successful MFA verification
func (al *AuditLogger) LogMFAVerified(userID string) {
	al.logger.Info("AUDIT: MFA verified",
		zap.String("user_id", userID),
		zap.Time("timestamp", time.Now()),
	)
}