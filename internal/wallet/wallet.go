package wallet

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"sync"
	"time"

	"go.uber.org/zap"
	"golang.org/x/crypto/ripemd160"
	"golang.org/x/crypto/scrypt"
)

// Wallet represents a cryptocurrency wallet
type Wallet struct {
	Address    string              `json:"address"`
	PrivateKey *ecdsa.PrivateKey   `json:"-"` // Never serialize private key directly
	PublicKey  *ecdsa.PublicKey    `json:"public_key"`
	Balance    uint64              `json:"balance"`
	TxHistory  []TransactionRecord `json:"tx_history"`
	CreatedAt  time.Time           `json:"created_at"`
	UpdatedAt  time.Time           `json:"updated_at"`
	mu         sync.RWMutex
}

// TransactionRecord represents a transaction history entry
type TransactionRecord struct {
	TxID        string    `json:"tx_id"`
	Type        string    `json:"type"` // "sent", "received", "coinbase"
	From        string    `json:"from"`
	To          string    `json:"to"`
	Amount      uint64    `json:"amount"`
	Fee         uint64    `json:"fee"`
	BlockHeight uint64    `json:"block_height"`
	Timestamp   time.Time `json:"timestamp"`
	Status      string    `json:"status"` // "pending", "confirmed", "failed"
}

// WalletManager manages multiple wallets
type WalletManager struct {
	logger      *zap.Logger
	walletDir   string
	wallets     map[string]*Wallet
	activeWallet string
	mu          sync.RWMutex
	
	// Encryption
	masterKey   []byte
	salt        []byte
}

// Config represents wallet configuration
type Config struct {
	WalletDir    string `yaml:"wallet_dir"`
	DefaultLabel string `yaml:"default_label"`
	AutoBackup   bool   `yaml:"auto_backup"`
	BackupDir    string `yaml:"backup_dir"`
}

// NewWalletManager creates a new wallet manager
func NewWalletManager(logger *zap.Logger, config Config) (*WalletManager, error) {
	// Ensure wallet directory exists
	if err := os.MkdirAll(config.WalletDir, 0700); err != nil {
		return nil, fmt.Errorf("failed to create wallet directory: %w", err)
	}
	
	wm := &WalletManager{
		logger:    logger,
		walletDir: config.WalletDir,
		wallets:   make(map[string]*Wallet),
	}
	
	// Generate salt for key derivation
	wm.salt = make([]byte, 32)
	if _, err := rand.Read(wm.salt); err != nil {
		return nil, fmt.Errorf("failed to generate salt: %w", err)
	}
	
	return wm, nil
}

// CreateWallet creates a new wallet
func (wm *WalletManager) CreateWallet(label string, password string) (*Wallet, error) {
	wm.mu.Lock()
	defer wm.mu.Unlock()
	
	// Check if wallet already exists
	if _, exists := wm.wallets[label]; exists {
		return nil, fmt.Errorf("wallet with label %s already exists", label)
	}
	
	// Generate new private key using secp256k1
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("failed to generate private key: %w", err)
	}
	
	// Generate address from public key
	address := wm.generateAddress(&privateKey.PublicKey)
	
	// Create wallet
	wallet := &Wallet{
		Address:    address,
		PrivateKey: privateKey,
		PublicKey:  &privateKey.PublicKey,
		Balance:    0,
		TxHistory:  make([]TransactionRecord, 0),
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	}
	
	// Save wallet to disk
	if err := wm.saveWallet(label, wallet, password); err != nil {
		return nil, fmt.Errorf("failed to save wallet: %w", err)
	}
	
	// Add to active wallets
	wm.wallets[label] = wallet
	
	// Set as active if first wallet
	if len(wm.wallets) == 1 {
		wm.activeWallet = label
	}
	
	wm.logger.Info("Created new wallet",
		zap.String("label", label),
		zap.String("address", address),
	)
	
	return wallet, nil
}

// LoadWallet loads a wallet from disk
func (wm *WalletManager) LoadWallet(label string, password string) (*Wallet, error) {
	wm.mu.Lock()
	defer wm.mu.Unlock()
	
	// Check if already loaded
	if wallet, exists := wm.wallets[label]; exists {
		return wallet, nil
	}
	
	// Load from disk
	walletPath := filepath.Join(wm.walletDir, label+".dat")
	data, err := os.ReadFile(walletPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read wallet file: %w", err)
	}
	
	// Decrypt wallet data
	decrypted, err := wm.decryptWallet(data, password)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt wallet: %w", err)
	}
	
	// Deserialize wallet
	var walletData walletData
	if err := json.Unmarshal(decrypted, &walletData); err != nil {
		return nil, fmt.Errorf("failed to unmarshal wallet: %w", err)
	}
	
	// Reconstruct private key
	privateKey, err := wm.reconstructPrivateKey(walletData.PrivateKeyHex)
	if err != nil {
		return nil, fmt.Errorf("failed to reconstruct private key: %w", err)
	}
	
	// Create wallet object
	wallet := &Wallet{
		Address:    walletData.Address,
		PrivateKey: privateKey,
		PublicKey:  &privateKey.PublicKey,
		Balance:    walletData.Balance,
		TxHistory:  walletData.TxHistory,
		CreatedAt:  walletData.CreatedAt,
		UpdatedAt:  walletData.UpdatedAt,
	}
	
	// Add to active wallets
	wm.wallets[label] = wallet
	
	wm.logger.Info("Loaded wallet",
		zap.String("label", label),
		zap.String("address", wallet.Address),
	)
	
	return wallet, nil
}

// GetWallet returns a wallet by label
func (wm *WalletManager) GetWallet(label string) (*Wallet, error) {
	wm.mu.RLock()
	defer wm.mu.RUnlock()
	
	wallet, exists := wm.wallets[label]
	if !exists {
		return nil, fmt.Errorf("wallet not found: %s", label)
	}
	
	return wallet, nil
}

// GetActiveWallet returns the currently active wallet
func (wm *WalletManager) GetActiveWallet() (*Wallet, error) {
	wm.mu.RLock()
	defer wm.mu.RUnlock()
	
	if wm.activeWallet == "" {
		return nil, fmt.Errorf("no active wallet")
	}
	
	return wm.wallets[wm.activeWallet], nil
}

// SetActiveWallet sets the active wallet
func (wm *WalletManager) SetActiveWallet(label string) error {
	wm.mu.Lock()
	defer wm.mu.Unlock()
	
	if _, exists := wm.wallets[label]; !exists {
		return fmt.Errorf("wallet not found: %s", label)
	}
	
	wm.activeWallet = label
	return nil
}

// ListWallets returns all wallet labels
func (wm *WalletManager) ListWallets() []string {
	wm.mu.RLock()
	defer wm.mu.RUnlock()
	
	labels := make([]string, 0, len(wm.wallets))
	for label := range wm.wallets {
		labels = append(labels, label)
	}
	
	return labels
}

// UpdateBalance updates wallet balance
func (wm *WalletManager) UpdateBalance(label string, balance uint64) error {
	wm.mu.Lock()
	defer wm.mu.Unlock()
	
	wallet, exists := wm.wallets[label]
	if !exists {
		return fmt.Errorf("wallet not found: %s", label)
	}
	
	wallet.mu.Lock()
	wallet.Balance = balance
	wallet.UpdatedAt = time.Now()
	wallet.mu.Unlock()
	
	return nil
}

// AddTransaction adds a transaction record to wallet history
func (wm *WalletManager) AddTransaction(label string, tx TransactionRecord) error {
	wm.mu.Lock()
	defer wm.mu.Unlock()
	
	wallet, exists := wm.wallets[label]
	if !exists {
		return fmt.Errorf("wallet not found: %s", label)
	}
	
	wallet.mu.Lock()
	wallet.TxHistory = append(wallet.TxHistory, tx)
	wallet.UpdatedAt = time.Now()
	wallet.mu.Unlock()
	
	// Save updated wallet
	// Note: In production, use the password from secure storage
	// This is simplified for the example
	return nil
}

// Private methods

// generateAddress generates a wallet address from public key
// Using: secp256k1 → SHA256 → RIPEMD160
func (wm *WalletManager) generateAddress(publicKey *ecdsa.PublicKey) string {
	// Serialize public key
	pubKeyBytes := elliptic.Marshal(publicKey.Curve, publicKey.X, publicKey.Y)
	
	// SHA256 hash
	sha256Hash := sha256.Sum256(pubKeyBytes)
	
	// RIPEMD160 hash
	ripemd160Hasher := ripemd160.New()
	ripemd160Hasher.Write(sha256Hash[:])
	publicKeyHash := ripemd160Hasher.Sum(nil)
	
	// Add version byte (0x00 for mainnet)
	versionedHash := append([]byte{0x00}, publicKeyHash...)
	
	// Calculate checksum (double SHA256)
	checksum := sha256.Sum256(versionedHash)
	checksum = sha256.Sum256(checksum[:])
	
	// Append checksum
	fullHash := append(versionedHash, checksum[:4]...)
	
	// Base58 encode (simplified as hex for this example)
	return hex.EncodeToString(fullHash)
}

// walletData represents the serializable wallet data
type walletData struct {
	Address       string              `json:"address"`
	PrivateKeyHex string              `json:"private_key_hex"`
	Balance       uint64              `json:"balance"`
	TxHistory     []TransactionRecord `json:"tx_history"`
	CreatedAt     time.Time           `json:"created_at"`
	UpdatedAt     time.Time           `json:"updated_at"`
}

// saveWallet saves wallet to disk with AES encryption
func (wm *WalletManager) saveWallet(label string, wallet *Wallet, password string) error {
	// Serialize private key
	privateKeyBytes := wallet.PrivateKey.D.Bytes()
	privateKeyHex := hex.EncodeToString(privateKeyBytes)
	
	// Create wallet data
	data := walletData{
		Address:       wallet.Address,
		PrivateKeyHex: privateKeyHex,
		Balance:       wallet.Balance,
		TxHistory:     wallet.TxHistory,
		CreatedAt:     wallet.CreatedAt,
		UpdatedAt:     wallet.UpdatedAt,
	}
	
	// Serialize to JSON
	jsonData, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("failed to marshal wallet: %w", err)
	}
	
	// Encrypt wallet data
	encrypted, err := wm.encryptWallet(jsonData, password)
	if err != nil {
		return fmt.Errorf("failed to encrypt wallet: %w", err)
	}
	
	// Save to file
	walletPath := filepath.Join(wm.walletDir, label+".dat")
	if err := os.WriteFile(walletPath, encrypted, 0600); err != nil {
		return fmt.Errorf("failed to write wallet file: %w", err)
	}
	
	return nil
}

// encryptWallet encrypts wallet data using AES
func (wm *WalletManager) encryptWallet(data []byte, password string) ([]byte, error) {
	// Derive key from password using scrypt
	key, err := scrypt.Key([]byte(password), wm.salt, 32768, 8, 1, 32)
	if err != nil {
		return nil, err
	}
	
	// Create AES cipher
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	
	// Create GCM
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	
	// Generate nonce
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	
	// Encrypt data
	ciphertext := gcm.Seal(nonce, nonce, data, nil)
	
	return ciphertext, nil
}

// decryptWallet decrypts wallet data
func (wm *WalletManager) decryptWallet(data []byte, password string) ([]byte, error) {
	// Derive key from password using scrypt
	key, err := scrypt.Key([]byte(password), wm.salt, 32768, 8, 1, 32)
	if err != nil {
		return nil, err
	}
	
	// Create AES cipher
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	
	// Create GCM
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	
	// Extract nonce
	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return nil, fmt.Errorf("ciphertext too short")
	}
	
	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	
	// Decrypt data
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, err
	}
	
	return plaintext, nil
}

// reconstructPrivateKey reconstructs private key from hex string
func (wm *WalletManager) reconstructPrivateKey(hexKey string) (*ecdsa.PrivateKey, error) {
	keyBytes, err := hex.DecodeString(hexKey)
	if err != nil {
		return nil, err
	}
	
	privateKey := new(ecdsa.PrivateKey)
	privateKey.PublicKey.Curve = elliptic.P256()
	privateKey.D = new(big.Int).SetBytes(keyBytes)
	privateKey.PublicKey.X, privateKey.PublicKey.Y = privateKey.PublicKey.Curve.ScalarBaseMult(keyBytes)
	
	return privateKey, nil
}