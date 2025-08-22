package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
)

// KeyVault provides a secure, persistent storage for sensitive keys.
// It uses AES-GCM to encrypt keys in memory and persists them to a file.
type KeyVault struct {
	masterKey []byte
	filePath  string
	store     map[string][]byte
	mu        sync.RWMutex
}

// NewKeyVault creates a new KeyVault, loading it from the specified file if it exists.
// The master key is derived from the OTEDAMA_MASTER_KEY environment variable.
func NewKeyVault(filePath string) (*KeyVault, error) {
	masterKeyHex := os.Getenv("OTEDAMA_MASTER_KEY")
	if len(masterKeyHex) != 64 {
		return nil, errors.New("OTEDAMA_MASTER_KEY must be a 32-byte key (64 hex characters)")
	}
	masterKey, err := hex.DecodeString(masterKeyHex)
	if err != nil {
		return nil, fmt.Errorf("failed to decode master key: %w", err)
	}

	kv := &KeyVault{
		masterKey: masterKey,
		filePath:  filePath,
		store:     make(map[string][]byte),
	}

	if err := kv.load(); err != nil {
		return nil, err
	}

	return kv, nil
}

// Set stores a key in the vault, encrypting it and persisting the vault to disk.
func (kv *KeyVault) Set(name string, value []byte) error {
	kv.mu.Lock()
	defer kv.mu.Unlock()

	c, err := aes.NewCipher(kv.masterKey)
	if err != nil {
		return err
	}

	gcm, err := cipher.NewGCM(c)
	if err != nil {
		return err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return err
	}

	encryptedValue := gcm.Seal(nonce, nonce, value, nil)
	kv.store[name] = encryptedValue

	return kv.save()
}

// Get retrieves a key from the vault, decrypting it on access.
func (kv *KeyVault) Get(name string) ([]byte, error) {
	kv.mu.RLock()
	defer kv.mu.RUnlock()

	encryptedValue, ok := kv.store[name]
	if !ok {
		return nil, fmt.Errorf("key '%s' not found in vault", name)
	}

	c, err := aes.NewCipher(kv.masterKey)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(c)
	if err != nil {
		return nil, err
	}

	nonceSize := gcm.NonceSize()
	if len(encryptedValue) < nonceSize {
		return nil, errors.New("ciphertext too short")
	}

	nonce, ciphertext := encryptedValue[:nonceSize], encryptedValue[nonceSize:]
	decryptedValue, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt key '%s': %w", name, err)
	}

	return decryptedValue, nil
}

// Delete removes a key from the vault and persists the change.
func (kv *KeyVault) Delete(name string) error {
	kv.mu.Lock()
	defer kv.mu.Unlock()

	if _, ok := kv.store[name]; !ok {
		return fmt.Errorf("key '%s' not found in vault", name)
	}

	delete(kv.store, name)
	return kv.save()
}

// save persists the encrypted key store to the file.
func (kv *KeyVault) save() error {
	data, err := json.Marshal(kv.store)
	if err != nil {
		return fmt.Errorf("failed to marshal key vault: %w", err)
	}

	return os.WriteFile(kv.filePath, data, 0600)
}

// load loads the encrypted key store from the file.
func (kv *KeyVault) load() error {
	data, err := os.ReadFile(kv.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // File doesn't exist yet, which is fine.
		}
		return fmt.Errorf("failed to read key vault file: %w", err)
	}

	if len(data) == 0 {
		return nil // File is empty, nothing to load.
	}

	err = json.Unmarshal(data, &kv.store)
	if err != nil {
		return fmt.Errorf("failed to unmarshal key vault: %w", err)
	}

	return nil
}
