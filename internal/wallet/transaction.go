package wallet

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// Transaction represents a blockchain transaction
type Transaction struct {
	From      string    `json:"from"`
	To        string    `json:"to"`
	Amount    uint64    `json:"amount"`
	Fee       uint64    `json:"fee"`
	Nonce     uint64    `json:"nonce"`
	Timestamp time.Time `json:"timestamp"`
	Signature []byte    `json:"signature"`
	TxID      string    `json:"tx_id"`
}

// TransactionPool manages pending transactions
type TransactionPool struct {
	logger       *zap.Logger
	transactions map[string]*Transaction
	nonces       map[string]uint64 // Track nonces per address
	mu           sync.RWMutex
}

// TransactionManager handles transaction creation and signing
type TransactionManager struct {
	logger      *zap.Logger
	walletMgr   *WalletManager
	txPool      *TransactionPool
	nonceCounter atomic.Uint64
}

// NewTransactionManager creates a new transaction manager
func NewTransactionManager(logger *zap.Logger, walletMgr *WalletManager) *TransactionManager {
	return &TransactionManager{
		logger:    logger,
		walletMgr: walletMgr,
		txPool: &TransactionPool{
			logger:       logger,
			transactions: make(map[string]*Transaction),
			nonces:       make(map[string]uint64),
		},
	}
}

// CreateTransaction creates a new transaction
func (tm *TransactionManager) CreateTransaction(from, to string, amount, fee uint64) (*Transaction, error) {
	// Get wallet
	wallet, err := tm.findWalletByAddress(from)
	if err != nil {
		return nil, fmt.Errorf("wallet not found for address %s: %w", from, err)
	}
	
	// Check balance
	if wallet.Balance < amount+fee {
		return nil, fmt.Errorf("insufficient balance: have %d, need %d", wallet.Balance, amount+fee)
	}
	
	// Get next nonce
	nonce := tm.getNextNonce(from)
	
	// Create transaction
	tx := &Transaction{
		From:      from,
		To:        to,
		Amount:    amount,
		Fee:       fee,
		Nonce:     nonce,
		Timestamp: time.Now(),
	}
	
	// Sign transaction
	if err := tm.signTransaction(tx, wallet.PrivateKey); err != nil {
		return nil, fmt.Errorf("failed to sign transaction: %w", err)
	}
	
	// Generate transaction ID
	tx.TxID = tm.generateTxID(tx)
	
	// Add to pool
	if err := tm.txPool.AddTransaction(tx); err != nil {
		return nil, fmt.Errorf("failed to add transaction to pool: %w", err)
	}
	
	tm.logger.Info("Created transaction",
		zap.String("tx_id", tx.TxID),
		zap.String("from", from),
		zap.String("to", to),
		zap.Uint64("amount", amount),
		zap.Uint64("fee", fee),
	)
	
	return tx, nil
}

// CreateCoinbaseTransaction creates a coinbase (mining reward) transaction
func (tm *TransactionManager) CreateCoinbaseTransaction(to string, amount uint64) (*Transaction, error) {
	tx := &Transaction{
		From:      "coinbase",
		To:        to,
		Amount:    amount,
		Fee:       0,
		Nonce:     0,
		Timestamp: time.Now(),
	}
	
	// Coinbase transactions don't need signatures
	tx.TxID = tm.generateTxID(tx)
	
	// Add to pool
	if err := tm.txPool.AddTransaction(tx); err != nil {
		return nil, fmt.Errorf("failed to add coinbase transaction to pool: %w", err)
	}
	
	tm.logger.Info("Created coinbase transaction",
		zap.String("tx_id", tx.TxID),
		zap.String("to", to),
		zap.Uint64("amount", amount),
	)
	
	return tx, nil
}

// VerifyTransaction verifies a transaction signature
func (tm *TransactionManager) VerifyTransaction(tx *Transaction) error {
	// Coinbase transactions don't have signatures
	if tx.From == "coinbase" {
		return nil
	}
	
	// Get public key from address
	// In a real implementation, this would involve decoding the address
	// For now, we'll skip the actual verification
	
	// Verify signature
	hash := tm.hashTransaction(tx)
	
	// TODO: Implement actual signature verification
	// This would involve:
	// 1. Extracting public key from the 'from' address
	// 2. Verifying the signature using ecdsa.Verify
	
	if len(tx.Signature) == 0 {
		return fmt.Errorf("transaction has no signature")
	}
	
	return nil
}

// signTransaction signs a transaction with the private key
func (tm *TransactionManager) signTransaction(tx *Transaction, privateKey *ecdsa.PrivateKey) error {
	// Calculate transaction hash
	hash := tm.hashTransaction(tx)
	
	// Sign the hash
	r, s, err := ecdsa.Sign(rand.Reader, privateKey, hash)
	if err != nil {
		return fmt.Errorf("failed to sign transaction: %w", err)
	}
	
	// Encode signature
	signature := append(r.Bytes(), s.Bytes()...)
	tx.Signature = signature
	
	return nil
}

// hashTransaction creates a hash of the transaction for signing
func (tm *TransactionManager) hashTransaction(tx *Transaction) []byte {
	// Create a copy without signature for hashing
	txCopy := Transaction{
		From:      tx.From,
		To:        tx.To,
		Amount:    tx.Amount,
		Fee:       tx.Fee,
		Nonce:     tx.Nonce,
		Timestamp: tx.Timestamp,
	}
	
	// Serialize transaction
	data, _ := json.Marshal(txCopy)
	
	// Calculate SHA256 hash
	hash := sha256.Sum256(data)
	return hash[:]
}

// generateTxID generates a unique transaction ID
func (tm *TransactionManager) generateTxID(tx *Transaction) string {
	// Include signature in ID generation
	data := struct {
		From      string
		To        string
		Amount    uint64
		Fee       uint64
		Nonce     uint64
		Timestamp time.Time
		Signature []byte
	}{
		From:      tx.From,
		To:        tx.To,
		Amount:    tx.Amount,
		Fee:       tx.Fee,
		Nonce:     tx.Nonce,
		Timestamp: tx.Timestamp,
		Signature: tx.Signature,
	}
	
	serialized, _ := json.Marshal(data)
	hash := sha256.Sum256(serialized)
	return hex.EncodeToString(hash[:])
}

// getNextNonce returns the next nonce for an address
func (tm *TransactionManager) getNextNonce(address string) uint64 {
	tm.txPool.mu.Lock()
	defer tm.txPool.mu.Unlock()
	
	nonce, exists := tm.txPool.nonces[address]
	if !exists {
		nonce = 0
	}
	
	tm.txPool.nonces[address] = nonce + 1
	return nonce
}

// findWalletByAddress finds a wallet by its address
func (tm *TransactionManager) findWalletByAddress(address string) (*Wallet, error) {
	wallets := tm.walletMgr.ListWallets()
	
	for _, label := range wallets {
		wallet, err := tm.walletMgr.GetWallet(label)
		if err != nil {
			continue
		}
		
		if wallet.Address == address {
			return wallet, nil
		}
	}
	
	return nil, fmt.Errorf("wallet not found for address: %s", address)
}

// TransactionPool methods

// AddTransaction adds a transaction to the pool
func (tp *TransactionPool) AddTransaction(tx *Transaction) error {
	tp.mu.Lock()
	defer tp.mu.Unlock()
	
	// Check if transaction already exists
	if _, exists := tp.transactions[tx.TxID]; exists {
		return fmt.Errorf("transaction already in pool: %s", tx.TxID)
	}
	
	// Add to pool
	tp.transactions[tx.TxID] = tx
	
	return nil
}

// GetTransaction retrieves a transaction from the pool
func (tp *TransactionPool) GetTransaction(txID string) (*Transaction, error) {
	tp.mu.RLock()
	defer tp.mu.RUnlock()
	
	tx, exists := tp.transactions[txID]
	if !exists {
		return nil, fmt.Errorf("transaction not found: %s", txID)
	}
	
	return tx, nil
}

// GetPendingTransactions returns all pending transactions
func (tp *TransactionPool) GetPendingTransactions() []*Transaction {
	tp.mu.RLock()
	defer tp.mu.RUnlock()
	
	transactions := make([]*Transaction, 0, len(tp.transactions))
	for _, tx := range tp.transactions {
		transactions = append(transactions, tx)
	}
	
	return transactions
}

// RemoveTransaction removes a transaction from the pool
func (tp *TransactionPool) RemoveTransaction(txID string) error {
	tp.mu.Lock()
	defer tp.mu.Unlock()
	
	if _, exists := tp.transactions[txID]; !exists {
		return fmt.Errorf("transaction not found: %s", txID)
	}
	
	delete(tp.transactions, txID)
	return nil
}

// ClearTransactions clears all transactions from the pool
func (tp *TransactionPool) ClearTransactions() {
	tp.mu.Lock()
	defer tp.mu.Unlock()
	
	tp.transactions = make(map[string]*Transaction)
}

// ValidateNonce validates that a transaction has the correct nonce
func (tp *TransactionPool) ValidateNonce(tx *Transaction) error {
	tp.mu.RLock()
	defer tp.mu.RUnlock()
	
	expectedNonce, exists := tp.nonces[tx.From]
	if !exists {
		expectedNonce = 0
	}
	
	if tx.Nonce < expectedNonce {
		return fmt.Errorf("nonce too low: got %d, expected at least %d", tx.Nonce, expectedNonce)
	}
	
	return nil
}

// TransactionBatch represents a batch of transactions for processing
type TransactionBatch struct {
	Transactions []*Transaction `json:"transactions"`
	BatchID      string         `json:"batch_id"`
	CreatedAt    time.Time      `json:"created_at"`
}

// CreateTransactionBatch creates a batch of transactions for mining
func (tm *TransactionManager) CreateTransactionBatch(maxTxs int) *TransactionBatch {
	pendingTxs := tm.txPool.GetPendingTransactions()
	
	// Limit batch size
	if len(pendingTxs) > maxTxs {
		pendingTxs = pendingTxs[:maxTxs]
	}
	
	// Generate batch ID
	batchData := struct {
		Count     int
		Timestamp time.Time
		Random    int64
	}{
		Count:     len(pendingTxs),
		Timestamp: time.Now(),
		Random:    time.Now().UnixNano(),
	}
	
	batchBytes, _ := json.Marshal(batchData)
	batchHash := sha256.Sum256(batchBytes)
	
	return &TransactionBatch{
		Transactions: pendingTxs,
		BatchID:      hex.EncodeToString(batchHash[:]),
		CreatedAt:    time.Now(),
	}
}

// SerializeTransaction serializes a transaction for network transmission
func SerializeTransaction(tx *Transaction) ([]byte, error) {
	return json.Marshal(tx)
}

// DeserializeTransaction deserializes a transaction from network data
func DeserializeTransaction(data []byte) (*Transaction, error) {
	var tx Transaction
	if err := json.Unmarshal(data, &tx); err != nil {
		return nil, err
	}
	return &tx, nil
}