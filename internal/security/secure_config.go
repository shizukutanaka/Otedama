package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"strings"

	"golang.org/x/crypto/pbkdf2"
)

// SecureConfig provides encrypted configuration management
type SecureConfig struct {
	salt []byte
}

// NewSecureConfig creates a new secure configuration manager
func NewSecureConfig() *SecureConfig {
	salt := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		// Use a static salt as fallback (not ideal, but better than panic)
		salt = []byte("otedama-default-salt-change-this")
	}
	
	return &SecureConfig{
		salt: salt,
	}
}

// EncryptValue encrypts a configuration value
func (sc *SecureConfig) EncryptValue(value string, masterKey string) (string, error) {
	// Derive key from master key using PBKDF2
	key := pbkdf2.Key([]byte(masterKey), sc.salt, 100000, 32, sha256.New)
	
	// Create cipher
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("failed to create cipher: %w", err)
	}
	
	// Create GCM mode
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("failed to create GCM: %w", err)
	}
	
	// Create nonce
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("failed to generate nonce: %w", err)
	}
	
	// Encrypt
	ciphertext := gcm.Seal(nonce, nonce, []byte(value), nil)
	
	// Encode to base64
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

// DecryptValue decrypts a configuration value
func (sc *SecureConfig) DecryptValue(encrypted string, masterKey string) (string, error) {
	// Decode from base64
	ciphertext, err := base64.StdEncoding.DecodeString(encrypted)
	if err != nil {
		return "", fmt.Errorf("failed to decode: %w", err)
	}
	
	// Derive key from master key
	key := pbkdf2.Key([]byte(masterKey), sc.salt, 100000, 32, sha256.New)
	
	// Create cipher
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("failed to create cipher: %w", err)
	}
	
	// Create GCM mode
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("failed to create GCM: %w", err)
	}
	
	// Extract nonce
	nonceSize := gcm.NonceSize()
	if len(ciphertext) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}
	
	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	
	// Decrypt
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("failed to decrypt: %w", err)
	}
	
	return string(plaintext), nil
}

// IsEncrypted checks if a value is encrypted
func (sc *SecureConfig) IsEncrypted(value string) bool {
	// Check if it's a valid base64 string with reasonable length
	if len(value) < 32 {
		return false
	}
	
	_, err := base64.StdEncoding.DecodeString(value)
	return err == nil && !strings.Contains(value, " ") && !strings.Contains(value, "\n")
}

// GenerateSecureToken generates a cryptographically secure token
func GenerateSecureToken(length int) (string, error) {
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("failed to generate token: %w", err)
	}
	
	return base64.URLEncoding.EncodeToString(bytes), nil
}

// HashPassword securely hashes a password
func HashPassword(password string, salt []byte) string {
	// Use PBKDF2 with SHA256
	hash := pbkdf2.Key([]byte(password), salt, 100000, 32, sha256.New)
	return base64.StdEncoding.EncodeToString(hash)
}

// GenerateSalt generates a random salt
func GenerateSalt() ([]byte, error) {
	salt := make([]byte, 32)
	if _, err := rand.Read(salt); err != nil {
		return nil, fmt.Errorf("failed to generate salt: %w", err)
	}
	return salt, nil
}