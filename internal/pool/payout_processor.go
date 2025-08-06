package pool

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/otedama/otedama/internal/database"
	"go.uber.org/zap"
)

// PayoutProcessor handles the actual payout transactions
type PayoutProcessor struct {
	logger        *zap.Logger
	payoutRepo    *database.PayoutRepository
	calculator    *PayoutCalculator
	
	// Wallet interface
	wallets       map[string]WalletInterface
	walletsMu     sync.RWMutex
	
	// Processing state
	processing    bool
	processingMu  sync.Mutex
	
	// Configuration
	config        ProcessorConfig
	
	// HTTP client for wallet APIs
	httpClient    *http.Client
}

// ProcessorConfig contains payout processor configuration
type ProcessorConfig struct {
	// Processing intervals
	ProcessInterval      time.Duration
	RetryInterval        time.Duration
	MaxRetries           int
	
	// Batch settings
	BatchSize            int
	MaxBatchAmount       float64
	
	// Security
	RequireConfirmation  bool
	ConfirmationBlocks   int
	
	// Timeout settings
	WalletTimeout        time.Duration
}

// WalletInterface defines wallet operations
type WalletInterface interface {
	GetBalance() (float64, error)
	SendPayment(address string, amount float64) (string, error)
	GetTransaction(txID string) (*TransactionInfo, error)
	ValidateAddress(address string) bool
}

// TransactionInfo contains transaction details
type TransactionInfo struct {
	TxID          string
	Status        string
	Confirmations int
	Fee           float64
	Timestamp     time.Time
}

// NewPayoutProcessor creates a new payout processor
func NewPayoutProcessor(
	logger *zap.Logger,
	payoutRepo *database.PayoutRepository,
	calculator *PayoutCalculator,
	config ProcessorConfig,
) *PayoutProcessor {
	// Set defaults
	if config.ProcessInterval <= 0 {
		config.ProcessInterval = 10 * time.Minute
	}
	if config.RetryInterval <= 0 {
		config.RetryInterval = 5 * time.Minute
	}
	if config.MaxRetries <= 0 {
		config.MaxRetries = 3
	}
	if config.BatchSize <= 0 {
		config.BatchSize = 100
	}
	if config.WalletTimeout <= 0 {
		config.WalletTimeout = 30 * time.Second
	}
	
	pp := &PayoutProcessor{
		logger:      logger,
		payoutRepo:  payoutRepo,
		calculator:  calculator,
		config:      config,
		wallets:     make(map[string]WalletInterface),
		httpClient: &http.Client{
			Timeout: config.WalletTimeout,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{
					MinVersion: tls.VersionTLS12,
				},
			},
		},
	}
	
	// Start processing routine
	go pp.processingRoutine()
	
	return pp
}

// RegisterWallet registers a wallet interface for a currency
func (pp *PayoutProcessor) RegisterWallet(currency string, wallet WalletInterface) {
	pp.walletsMu.Lock()
	defer pp.walletsMu.Unlock()
	
	pp.wallets[currency] = wallet
	pp.logger.Info("Registered wallet", zap.String("currency", currency))
}

// ProcessPendingPayouts processes all pending payouts
func (pp *PayoutProcessor) ProcessPendingPayouts(ctx context.Context) error {
	pp.processingMu.Lock()
	if pp.processing {
		pp.processingMu.Unlock()
		return errors.New("already processing payouts")
	}
	pp.processing = true
	pp.processingMu.Unlock()
	
	defer func() {
		pp.processingMu.Lock()
		pp.processing = false
		pp.processingMu.Unlock()
	}()
	
	// Get pending payouts
	pendingPayouts, err := pp.payoutRepo.ListPending(ctx)
	if err != nil {
		return err
	}
	
	if len(pendingPayouts) == 0 {
		return nil
	}
	
	pp.logger.Info("Processing pending payouts", zap.Int("count", len(pendingPayouts)))
	
	// Group by currency
	payoutsByCurrency := pp.groupPayoutsByCurrency(pendingPayouts)
	
	// Process each currency
	for currency, payouts := range payoutsByCurrency {
		err := pp.processCurrencyPayouts(ctx, currency, payouts)
		if err != nil {
			pp.logger.Error("Failed to process currency payouts",
				zap.String("currency", currency),
				zap.Error(err),
			)
		}
	}
	
	return nil
}

// processCurrencyPayouts processes payouts for a specific currency
func (pp *PayoutProcessor) processCurrencyPayouts(ctx context.Context, currency string, payouts []*database.Payout) error {
	pp.walletsMu.RLock()
	wallet, exists := pp.wallets[currency]
	pp.walletsMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("no wallet registered for currency: %s", currency)
	}
	
	// Check wallet balance
	balance, err := wallet.GetBalance()
	if err != nil {
		return fmt.Errorf("failed to get wallet balance: %w", err)
	}
	
	// Process in batches
	for i := 0; i < len(payouts); i += pp.config.BatchSize {
		end := i + pp.config.BatchSize
		if end > len(payouts) {
			end = len(payouts)
		}
		
		batch := payouts[i:end]
		batchAmount := pp.calculateBatchAmount(batch)
		
		// Check if we have enough balance
		if batchAmount > balance {
			pp.logger.Warn("Insufficient balance for batch",
				zap.String("currency", currency),
				zap.Float64("required", batchAmount),
				zap.Float64("balance", balance),
			)
			break
		}
		
		// Process batch
		err := pp.processBatch(ctx, wallet, batch)
		if err != nil {
			pp.logger.Error("Failed to process batch",
				zap.String("currency", currency),
				zap.Error(err),
			)
			// Continue with next batch
		}
		
		// Update balance
		balance -= batchAmount
		
		// Small delay between batches
		time.Sleep(1 * time.Second)
	}
	
	return nil
}

// processBatch processes a batch of payouts
func (pp *PayoutProcessor) processBatch(ctx context.Context, wallet WalletInterface, payouts []*database.Payout) error {
	successCount := 0
	failureCount := 0
	
	for _, payout := range payouts {
		// Validate address
		if !wallet.ValidateAddress(payout.Address) {
			errorMsg := "invalid address"
			err := pp.payoutRepo.UpdateStatus(ctx, payout.ID, "failed", nil, &errorMsg)
			if err != nil {
				pp.logger.Error("Failed to update payout status", zap.Error(err))
			}
			failureCount++
			continue
		}
		
		// Send payment
		txID, err := wallet.SendPayment(payout.Address, payout.Amount)
		if err != nil {
			errorMsg := err.Error()
			err := pp.payoutRepo.UpdateStatus(ctx, payout.ID, "failed", nil, &errorMsg)
			if err != nil {
				pp.logger.Error("Failed to update payout status", zap.Error(err))
			}
			failureCount++
			continue
		}
		
		// Update payout status
		err = pp.payoutRepo.UpdateStatus(ctx, payout.ID, "completed", &txID, nil)
		if err != nil {
			pp.logger.Error("Failed to update payout status", zap.Error(err))
		}
		
		successCount++
		
		pp.logger.Info("Payout sent",
			zap.Int64("payout_id", payout.ID),
			zap.String("address", payout.Address),
			zap.Float64("amount", payout.Amount),
			zap.String("tx_id", txID),
		)
	}
	
	pp.logger.Info("Batch processed",
		zap.Int("success", successCount),
		zap.Int("failure", failureCount),
	)
	
	return nil
}

// VerifyTransactions verifies completed transactions
func (pp *PayoutProcessor) VerifyTransactions(ctx context.Context) error {
	// Get recent completed payouts
	from := time.Now().Add(-24 * time.Hour)
	
	// This would query completed payouts and verify their transaction status
	// For now, this is a placeholder
	pp.logger.Info("Verifying transactions", zap.Time("from", from))
	
	return nil
}

// GetProcessingStats returns processing statistics
func (pp *PayoutProcessor) GetProcessingStats(ctx context.Context) (map[string]interface{}, error) {
	// Get payout statistics
	stats, err := pp.payoutRepo.GetPayoutStats(ctx, 24*time.Hour)
	if err != nil {
		return nil, err
	}
	
	pp.processingMu.Lock()
	isProcessing := pp.processing
	pp.processingMu.Unlock()
	
	pp.walletsMu.RLock()
	registeredCurrencies := make([]string, 0, len(pp.wallets))
	for currency := range pp.wallets {
		registeredCurrencies = append(registeredCurrencies, currency)
	}
	pp.walletsMu.RUnlock()
	
	stats["is_processing"] = isProcessing
	stats["registered_currencies"] = registeredCurrencies
	stats["process_interval"] = pp.config.ProcessInterval
	stats["batch_size"] = pp.config.BatchSize
	
	return stats, nil
}

// Private methods

func (pp *PayoutProcessor) processingRoutine() {
	ticker := time.NewTicker(pp.config.ProcessInterval)
	defer ticker.Stop()
	
	for range ticker.C {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		err := pp.ProcessPendingPayouts(ctx)
		if err != nil {
			pp.logger.Error("Failed to process pending payouts", zap.Error(err))
		}
		cancel()
	}
}

func (pp *PayoutProcessor) groupPayoutsByCurrency(payouts []*database.Payout) map[string][]*database.Payout {
	grouped := make(map[string][]*database.Payout)
	
	for _, payout := range payouts {
		grouped[payout.Currency] = append(grouped[payout.Currency], payout)
	}
	
	return grouped
}

func (pp *PayoutProcessor) calculateBatchAmount(payouts []*database.Payout) float64 {
	total := float64(0)
	for _, payout := range payouts {
		total += payout.Amount
	}
	return total
}

// Bitcoin wallet implementation example

type BitcoinWallet struct {
	rpcURL      string
	rpcUser     string
	rpcPassword string
	httpClient  *http.Client
}

func NewBitcoinWallet(rpcURL, rpcUser, rpcPassword string) *BitcoinWallet {
	return &BitcoinWallet{
		rpcURL:      rpcURL,
		rpcUser:     rpcUser,
		rpcPassword: rpcPassword,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (bw *BitcoinWallet) GetBalance() (float64, error) {
	// Make RPC call to get wallet balance
	resp, err := bw.rpcCall("getbalance", []interface{}{})
	if err != nil {
		return 0, err
	}
	
	balance, ok := resp.(float64)
	if !ok {
		return 0, errors.New("invalid balance response")
	}
	
	return balance, nil
}

func (bw *BitcoinWallet) SendPayment(address string, amount float64) (string, error) {
	// Make RPC call to send payment
	resp, err := bw.rpcCall("sendtoaddress", []interface{}{address, amount})
	if err != nil {
		return "", err
	}
	
	txID, ok := resp.(string)
	if !ok {
		return "", errors.New("invalid transaction response")
	}
	
	return txID, nil
}

func (bw *BitcoinWallet) GetTransaction(txID string) (*TransactionInfo, error) {
	// Make RPC call to get transaction info
	resp, err := bw.rpcCall("gettransaction", []interface{}{txID})
	if err != nil {
		return nil, err
	}
	
	// Parse response (simplified)
	txInfo := &TransactionInfo{
		TxID:   txID,
		Status: "confirmed",
	}
	
	return txInfo, nil
}

func (bw *BitcoinWallet) ValidateAddress(address string) bool {
	// Make RPC call to validate address
	resp, err := bw.rpcCall("validateaddress", []interface{}{address})
	if err != nil {
		return false
	}
	
	result, ok := resp.(map[string]interface{})
	if !ok {
		return false
	}
	
	isValid, _ := result["isvalid"].(bool)
	return isValid
}

func (bw *BitcoinWallet) rpcCall(method string, params []interface{}) (interface{}, error) {
	// Build RPC request
	reqData := map[string]interface{}{
		"jsonrpc": "1.0",
		"id":      "otedama",
		"method":  method,
		"params":  params,
	}
	
	reqBody, err := json.Marshal(reqData)
	if err != nil {
		return nil, err
	}
	
	// Make HTTP request
	req, err := http.NewRequest("POST", bw.rpcURL, bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	
	req.SetBasicAuth(bw.rpcUser, bw.rpcPassword)
	req.Header.Set("Content-Type", "application/json")
	
	resp, err := bw.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	// Parse response
	var result map[string]interface{}
	err = json.NewDecoder(resp.Body).Decode(&result)
	if err != nil {
		return nil, err
	}
	
	if errObj, exists := result["error"]; exists && errObj != nil {
		return nil, fmt.Errorf("RPC error: %v", errObj)
	}
	
	return result["result"], nil
}