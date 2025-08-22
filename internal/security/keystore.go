package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
)

var (
	ErrKeyNotFound      = errors.New("key not found")
	ErrInvalidKey       = errors.New("invalid key")
	ErrKeyExpired       = errors.New("key expired")
	ErrDecryptionFailed = errors.New("decryption failed")
)

// KeyStore provides secure key management
type KeyStore struct {
	mu          sync.RWMutex
	keys        map[string]*SecureKey
	masterKey   []byte
	rotationMu  sync.Mutex
	lastRotation time.Time
}

// SecureKey represents an encrypted key with metadata
type SecureKey struct {
	ID          string
	Encrypted   []byte
	Salt        []byte
	Nonce       []byte
	CreatedAt   time.Time
	ExpiresAt   *time.Time
	Algorithm   string
	Permissions []string
}

// NewKeyStore creates a new secure key store
func NewKeyStore(masterPassword string) (*KeyStore, error) {
	salt := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, fmt.Errorf("failed to generate salt: %w", err)
	}

	// Use Argon2id for key derivation
	masterKey := argon2.IDKey([]byte(masterPassword), salt, 3, 64*1024, 4, 32)

	return &KeyStore{
		keys:         make(map[string]*SecureKey),
		masterKey:    masterKey,
		lastRotation: time.Now(),
	}, nil
}

// StoreKey securely stores a key
func (ks *KeyStore) StoreKey(id string, key []byte, ttl time.Duration) error {
	ks.mu.Lock()
	defer ks.mu.Unlock()

	// Generate salt and nonce
	salt := make([]byte, 32)
	nonce := make([]byte, 24)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return err
	}
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return err
	}

	// Encrypt key using ChaCha20-Poly1305
	aead, err := chacha20poly1305.NewX(ks.masterKey)
	if err != nil {
		return err
	}

	encrypted := aead.Seal(nil, nonce, key, []byte(id))

	sk := &SecureKey{
		ID:        id,
		Encrypted: encrypted,
		Salt:      salt,
		Nonce:     nonce,
		CreatedAt: time.Now(),
		Algorithm: "chacha20poly1305",
	}

	if ttl > 0 {
		expiresAt := time.Now().Add(ttl)
		sk.ExpiresAt = &expiresAt
	}

	ks.keys[id] = sk
	return nil
}

// GetKey retrieves and decrypts a key
func (ks *KeyStore) GetKey(id string) ([]byte, error) {
	ks.mu.RLock()
	defer ks.mu.RUnlock()

	sk, exists := ks.keys[id]
	if !exists {
		return nil, ErrKeyNotFound
	}

	// Check expiration
	if sk.ExpiresAt != nil && time.Now().After(*sk.ExpiresAt) {
		return nil, ErrKeyExpired
	}

	// Decrypt key
	aead, err := chacha20poly1305.NewX(ks.masterKey)
	if err != nil {
		return nil, err
	}

	decrypted, err := aead.Open(nil, sk.Nonce, sk.Encrypted, []byte(id))
	if err != nil {
		return nil, ErrDecryptionFailed
	}

	return decrypted, nil
}

// DeleteKey removes a key from the store
func (ks *KeyStore) DeleteKey(id string) error {
	ks.mu.Lock()
	defer ks.mu.Unlock()

	if _, exists := ks.keys[id]; !exists {
		return ErrKeyNotFound
	}

	// Securely wipe the key data
	sk := ks.keys[id]
	for i := range sk.Encrypted {
		sk.Encrypted[i] = 0
	}

	delete(ks.keys, id)
	return nil
}

// RotateKeys re-encrypts all keys with a new master key
func (ks *KeyStore) RotateKeys(newMasterPassword string) error {
	ks.rotationMu.Lock()
	defer ks.rotationMu.Unlock()

	// Generate new salt
	salt := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return err
	}

	// Derive new master key
	newMasterKey := argon2.IDKey([]byte(newMasterPassword), salt, 3, 64*1024, 4, 32)

	ks.mu.Lock()
	defer ks.mu.Unlock()

	// Re-encrypt all keys
	for id, sk := range ks.keys {
		// Decrypt with old key
		oldAead, err := chacha20poly1305.NewX(ks.masterKey)
		if err != nil {
			return err
		}

		decrypted, err := oldAead.Open(nil, sk.Nonce, sk.Encrypted, []byte(id))
		if err != nil {
			return err
		}

		// Generate new nonce
		newNonce := make([]byte, 24)
		if _, err := io.ReadFull(rand.Reader, newNonce); err != nil {
			return err
		}

		// Encrypt with new key
		newAead, err := chacha20poly1305.NewX(newMasterKey)
		if err != nil {
			return err
		}

		sk.Encrypted = newAead.Seal(nil, newNonce, decrypted, []byte(id))
		sk.Nonce = newNonce
		sk.Salt = salt

		// Securely wipe decrypted data
		for i := range decrypted {
			decrypted[i] = 0
		}
	}

	// Update master key
	for i := range ks.masterKey {
		ks.masterKey[i] = 0
	}
	ks.masterKey = newMasterKey
	ks.lastRotation = time.Now()

	return nil
}

// CleanupExpired removes expired keys
func (ks *KeyStore) CleanupExpired() int {
	ks.mu.Lock()
	defer ks.mu.Unlock()

	count := 0
	now := time.Now()

	for id, sk := range ks.keys {
		if sk.ExpiresAt != nil && now.After(*sk.ExpiresAt) {
			// Securely wipe the key data
			for i := range sk.Encrypted {
				sk.Encrypted[i] = 0
			}
			delete(ks.keys, id)
			count++
		}
	}

	return count
}

// WalletKeyManager manages wallet private keys
type WalletKeyManager struct {
	keyStore *KeyStore
	mu       sync.RWMutex
}

// NewWalletKeyManager creates a new wallet key manager
func NewWalletKeyManager(masterPassword string) (*WalletKeyManager, error) {
	ks, err := NewKeyStore(masterPassword)
	if err != nil {
		return nil, err
	}

	return &WalletKeyManager{
		keyStore: ks,
	}, nil
}

// ImportPrivateKey imports and encrypts a private key
func (wkm *WalletKeyManager) ImportPrivateKey(walletID string, privateKey []byte) error {
	// Validate key format
	if len(privateKey) != 32 && len(privateKey) != 64 {
		return ErrInvalidKey
	}

	// Store encrypted key with 1 year TTL
	return wkm.keyStore.StoreKey(walletID, privateKey, 365*24*time.Hour)
}

// GetPrivateKey retrieves a wallet's private key
func (wkm *WalletKeyManager) GetPrivateKey(walletID string) ([]byte, error) {
	return wkm.keyStore.GetKey(walletID)
}

// SignTransaction signs a transaction with the wallet's private key
func (wkm *WalletKeyManager) SignTransaction(walletID string, txHash []byte) ([]byte, error) {
	privateKey, err := wkm.GetPrivateKey(walletID)
	if err != nil {
		return nil, err
	}

	// Securely wipe private key after use
	defer func() {
		for i := range privateKey {
			privateKey[i] = 0
		}
	}()

	// Simplified signature (in production, use proper ECDSA)
	h := sha256.New()
	h.Write(privateKey)
	h.Write(txHash)
	signature := h.Sum(nil)

	return signature, nil
}

// HSMInterface provides hardware security module integration
type HSMInterface struct {
	keyStore *KeyStore
	hsm      bool
}

// NewHSMInterface creates a new HSM interface
func NewHSMInterface(useHSM bool, masterPassword string) (*HSMInterface, error) {
	ks, err := NewKeyStore(masterPassword)
	if err != nil {
		return nil, err
	}

	return &HSMInterface{
		keyStore: ks,
		hsm:      useHSM,
	}, nil
}

// GenerateKey generates a new key in HSM or software
func (hi *HSMInterface) GenerateKey(keyID string, keyType string) error {
	if hi.hsm {
		// HSM key generation would go here
		// For now, simulate with software
	}

	// Generate key in software
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return err
	}

	return hi.keyStore.StoreKey(keyID, key, 0)
}

// EncryptData encrypts data using HSM or software
func (hi *HSMInterface) EncryptData(keyID string, data []byte) ([]byte, error) {
	key, err := hi.keyStore.GetKey(keyID)
	if err != nil {
		return nil, err
	}

	// Use AES-GCM for data encryption
	block, err := aes.NewCipher(key)
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

	encrypted := gcm.Seal(nonce, nonce, data, nil)
	return encrypted, nil
}

// DecryptData decrypts data using HSM or software
func (hi *HSMInterface) DecryptData(keyID string, encrypted []byte) ([]byte, error) {
	key, err := hi.keyStore.GetKey(keyID)
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonceSize := gcm.NonceSize()
	if len(encrypted) < nonceSize {
		return nil, ErrDecryptionFailed
	}

	nonce, ciphertext := encrypted[:nonceSize], encrypted[nonceSize:]
	return gcm.Open(nil, nonce, ciphertext, nil)
}

// SecureConfig manages encrypted configuration
type SecureConfig struct {
	hsm    *HSMInterface
	mu     sync.RWMutex
	config map[string]string
}

// NewSecureConfig creates a new secure configuration manager
func NewSecureConfig(masterPassword string) (*SecureConfig, error) {
	hsm, err := NewHSMInterface(false, masterPassword)
	if err != nil {
		return nil, err
	}

	// Generate config encryption key
	if err := hsm.GenerateKey("config-key", "AES256"); err != nil {
		return nil, err
	}

	return &SecureConfig{
		hsm:    hsm,
		config: make(map[string]string),
	}, nil
}

// Set stores an encrypted configuration value
func (sc *SecureConfig) Set(key, value string) error {
	sc.mu.Lock()
	defer sc.mu.Unlock()

	encrypted, err := sc.hsm.EncryptData("config-key", []byte(value))
	if err != nil {
		return err
	}

	sc.config[key] = base64.StdEncoding.EncodeToString(encrypted)
	return nil
}

// Get retrieves and decrypts a configuration value
func (sc *SecureConfig) Get(key string) (string, error) {
	sc.mu.RLock()
	defer sc.mu.RUnlock()

	encoded, exists := sc.config[key]
	if !exists {
		return "", ErrKeyNotFound
	}

	encrypted, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}

	decrypted, err := sc.hsm.DecryptData("config-key", encrypted)
	if err != nil {
		return "", err
	}

	return string(decrypted), nil
}

// SaveToFile saves encrypted config to file
func (sc *SecureConfig) SaveToFile(filename string) error {
	sc.mu.RLock()
	defer sc.mu.RUnlock()

	file, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer file.Close()

	for key, value := range sc.config {
		fmt.Fprintf(file, "%s=%s\n", key, value)
	}

	return nil
}

// LoadFromFile loads encrypted config from file
func (sc *SecureConfig) LoadFromFile(filename string) error {
	sc.mu.Lock()
	defer sc.mu.Unlock()

	data, err := os.ReadFile(filename)
	if err != nil {
		return err
	}

	// Parse config file (simplified)
	lines := string(data)
	_ = lines // Parse implementation would go here

	return nil
}