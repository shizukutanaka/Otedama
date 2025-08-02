package payout

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// PayoutManager handles automatic payout processing
type PayoutManager struct {
	logger      *zap.Logger
	nodeURL     string
	rpcUser     string
	rpcPassword string
	
	// Wallet for payouts
	payoutAddress  string
	privateKeyWIF  string // Wallet Import Format private key
	
	// Payout configuration
	minPayout      uint64
	payoutFee      uint64
	batchSize      int
	confirmations  int
	
	// Pending payouts
	pendingPayouts map[string]*PendingPayout
	processedTxs   map[string]*ProcessedTransaction
	
	// Statistics
	totalPaid      atomic.Uint64
	payoutCount    atomic.Uint64
	failedPayouts  atomic.Uint64
	
	// Processing state
	processing     atomic.Bool
	lastPayout     time.Time
	
	mu sync.RWMutex
	
	// Callbacks
	onPayoutComplete func(txID string, payouts map[string]uint64)
	onPayoutFailed   func(error, payouts map[string]uint64)
}

// PendingPayout represents a pending payout to a miner
type PendingPayout struct {
	Address       string    `json:"address"`
	Amount        uint64    `json:"amount"`
	LastUpdated   time.Time `json:"last_updated"`
	FailedAttempts int      `json:"failed_attempts"`
}

// ProcessedTransaction represents a processed payout transaction
type ProcessedTransaction struct {
	TxID          string            `json:"tx_id"`
	Timestamp     time.Time         `json:"timestamp"`
	Payouts       map[string]uint64 `json:"payouts"`
	TotalAmount   uint64            `json:"total_amount"`
	Fee           uint64            `json:"fee"`
	Confirmations int               `json:"confirmations"`
	Status        string            `json:"status"` // "pending", "confirmed", "failed"
}

// PayoutConfig contains payout manager configuration
type PayoutConfig struct {
	NodeURL        string        `yaml:"node_url"`
	RPCUser        string        `yaml:"rpc_user"`
	RPCPassword    string        `yaml:"rpc_password"`
	PayoutAddress  string        `yaml:"payout_address"`
	PrivateKeyWIF  string        `yaml:"private_key_wif"`
	MinPayout      uint64        `yaml:"min_payout"`
	PayoutFee      uint64        `yaml:"payout_fee"`
	BatchSize      int           `yaml:"batch_size"`
	Confirmations  int           `yaml:"confirmations"`
	PayoutInterval time.Duration `yaml:"payout_interval"`
}

// NewPayoutManager creates a new payout manager
func NewPayoutManager(logger *zap.Logger, config PayoutConfig) (*PayoutManager, error) {
	// Validate config
	if config.NodeURL == "" {
		return nil, fmt.Errorf("node URL is required")
	}
	if config.PayoutAddress == "" {
		return nil, fmt.Errorf("payout address is required")
	}
	
	// Set defaults
	if config.MinPayout == 0 {
		config.MinPayout = 100000000 // 1 coin in satoshis
	}
	if config.PayoutFee == 0 {
		config.PayoutFee = 10000 // 0.0001 coin
	}
	if config.BatchSize <= 0 {
		config.BatchSize = 100
	}
	if config.Confirmations <= 0 {
		config.Confirmations = 6
	}
	
	pm := &PayoutManager{
		logger:         logger,
		nodeURL:        config.NodeURL,
		rpcUser:        config.RPCUser,
		rpcPassword:    config.RPCPassword,
		payoutAddress:  config.PayoutAddress,
		privateKeyWIF:  config.PrivateKeyWIF,
		minPayout:      config.MinPayout,
		payoutFee:      config.PayoutFee,
		batchSize:      config.BatchSize,
		confirmations:  config.Confirmations,
		pendingPayouts: make(map[string]*PendingPayout),
		processedTxs:   make(map[string]*ProcessedTransaction),
	}
	
	return pm, nil
}

// Start starts the payout manager
func (pm *PayoutManager) Start(ctx context.Context, interval time.Duration) {
	// Start payout processing loop
	go pm.payoutLoop(ctx, interval)
	
	// Start confirmation checking loop
	go pm.confirmationLoop(ctx)
	
	pm.logger.Info("Payout manager started",
		zap.Duration("interval", interval),
		zap.Uint64("min_payout", pm.minPayout),
	)
}

// AddPayout adds a payout to the pending queue
func (pm *PayoutManager) AddPayout(address string, amount uint64) error {
	if address == "" {
		return fmt.Errorf("invalid address")
	}
	if amount == 0 {
		return fmt.Errorf("invalid amount")
	}
	
	pm.mu.Lock()
	defer pm.mu.Unlock()
	
	if existing, exists := pm.pendingPayouts[address]; exists {
		// Add to existing payout
		existing.Amount += amount
		existing.LastUpdated = time.Now()
	} else {
		// Create new payout
		pm.pendingPayouts[address] = &PendingPayout{
			Address:     address,
			Amount:      amount,
			LastUpdated: time.Now(),
		}
	}
	
	pm.logger.Debug("Payout added",
		zap.String("address", address),
		zap.Uint64("amount", amount),
	)
	
	return nil
}

// GetPendingPayouts returns all pending payouts
func (pm *PayoutManager) GetPendingPayouts() map[string]*PendingPayout {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	
	result := make(map[string]*PendingPayout)
	for addr, payout := range pm.pendingPayouts {
		result[addr] = &PendingPayout{
			Address:        payout.Address,
			Amount:         payout.Amount,
			LastUpdated:    payout.LastUpdated,
			FailedAttempts: payout.FailedAttempts,
		}
	}
	
	return result
}

// GetProcessedTransactions returns recent processed transactions
func (pm *PayoutManager) GetProcessedTransactions(limit int) []*ProcessedTransaction {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	
	txs := make([]*ProcessedTransaction, 0, len(pm.processedTxs))
	for _, tx := range pm.processedTxs {
		txs = append(txs, tx)
	}
	
	// Sort by timestamp
	sort.Slice(txs, func(i, j int) bool {
		return txs[i].Timestamp.After(txs[j].Timestamp)
	})
	
	// Limit results
	if limit > 0 && len(txs) > limit {
		txs = txs[:limit]
	}
	
	return txs
}

// GetStatistics returns payout manager statistics
func (pm *PayoutManager) GetStatistics() map[string]interface{} {
	pm.mu.RLock()
	pendingCount := len(pm.pendingPayouts)
	pendingTotal := uint64(0)
	for _, payout := range pm.pendingPayouts {
		pendingTotal += payout.Amount
	}
	processedCount := len(pm.processedTxs)
	pm.mu.RUnlock()
	
	return map[string]interface{}{
		"total_paid":       pm.totalPaid.Load(),
		"payout_count":     pm.payoutCount.Load(),
		"failed_payouts":   pm.failedPayouts.Load(),
		"pending_count":    pendingCount,
		"pending_total":    pendingTotal,
		"processed_count":  processedCount,
		"last_payout":      pm.lastPayout,
		"min_payout":       pm.minPayout,
		"payout_fee":       pm.payoutFee,
	}
}

// SetOnPayoutComplete sets the payout complete callback
func (pm *PayoutManager) SetOnPayoutComplete(callback func(txID string, payouts map[string]uint64)) {
	pm.onPayoutComplete = callback
}

// SetOnPayoutFailed sets the payout failed callback
func (pm *PayoutManager) SetOnPayoutFailed(callback func(error, payouts map[string]uint64)) {
	pm.onPayoutFailed = callback
}

// Private methods

// payoutLoop processes payouts periodically
func (pm *PayoutManager) payoutLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pm.processPendingPayouts()
		}
	}
}

// confirmationLoop checks transaction confirmations
func (pm *PayoutManager) confirmationLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pm.checkConfirmations()
		}
	}
}

// processPendingPayouts processes pending payouts
func (pm *PayoutManager) processPendingPayouts() {
	if !pm.processing.CompareAndSwap(false, true) {
		return // Already processing
	}
	defer pm.processing.Store(false)
	
	// Get payouts ready for processing
	payouts := pm.getPayoutsToProcess()
	if len(payouts) == 0 {
		return
	}
	
	pm.logger.Info("Processing payouts",
		zap.Int("count", len(payouts)),
	)
	
	// Create batches
	batches := pm.createPayoutBatches(payouts)
	
	// Process each batch
	for _, batch := range batches {
		if err := pm.processBatch(batch); err != nil {
			pm.logger.Error("Failed to process payout batch",
				zap.Error(err),
				zap.Int("batch_size", len(batch)),
			)
			
			// Mark failed payouts
			pm.markPayoutsFailed(batch)
			
			// Notify callback
			if pm.onPayoutFailed != nil {
				pm.onPayoutFailed(err, batch)
			}
		}
	}
	
	pm.lastPayout = time.Now()
}

// getPayoutsToProcess returns payouts ready for processing
func (pm *PayoutManager) getPayoutsToProcess() map[string]uint64 {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	
	payouts := make(map[string]uint64)
	
	for address, payout := range pm.pendingPayouts {
		// Skip if amount is below minimum
		if payout.Amount < pm.minPayout {
			continue
		}
		
		// Skip if too many failed attempts
		if payout.FailedAttempts >= 3 {
			continue
		}
		
		payouts[address] = payout.Amount
	}
	
	return payouts
}

// createPayoutBatches creates batches of payouts
func (pm *PayoutManager) createPayoutBatches(payouts map[string]uint64) []map[string]uint64 {
	// Convert to slice for batching
	addresses := make([]string, 0, len(payouts))
	for addr := range payouts {
		addresses = append(addresses, addr)
	}
	
	// Sort for deterministic batching
	sort.Strings(addresses)
	
	// Create batches
	batches := make([]map[string]uint64, 0)
	currentBatch := make(map[string]uint64)
	
	for _, addr := range addresses {
		currentBatch[addr] = payouts[addr]
		
		if len(currentBatch) >= pm.batchSize {
			batches = append(batches, currentBatch)
			currentBatch = make(map[string]uint64)
		}
	}
	
	// Add remaining
	if len(currentBatch) > 0 {
		batches = append(batches, currentBatch)
	}
	
	return batches
}

// processBatch processes a batch of payouts
func (pm *PayoutManager) processBatch(batch map[string]uint64) error {
	// Calculate total amount
	totalAmount := uint64(0)
	for _, amount := range batch {
		totalAmount += amount
	}
	
	// Create transaction
	txID, err := pm.createPayoutTransaction(batch)
	if err != nil {
		return fmt.Errorf("failed to create transaction: %w", err)
	}
	
	// Record processed transaction
	pm.mu.Lock()
	pm.processedTxs[txID] = &ProcessedTransaction{
		TxID:        txID,
		Timestamp:   time.Now(),
		Payouts:     batch,
		TotalAmount: totalAmount,
		Fee:         pm.payoutFee,
		Status:      "pending",
	}
	
	// Remove from pending
	for address := range batch {
		delete(pm.pendingPayouts, address)
	}
	pm.mu.Unlock()
	
	// Update statistics
	pm.totalPaid.Add(totalAmount)
	pm.payoutCount.Add(uint64(len(batch)))
	
	// Notify callback
	if pm.onPayoutComplete != nil {
		pm.onPayoutComplete(txID, batch)
	}
	
	pm.logger.Info("Payout transaction created",
		zap.String("tx_id", txID),
		zap.Int("recipients", len(batch)),
		zap.Uint64("total_amount", totalAmount),
	)
	
	return nil
}

// createPayoutTransaction creates a payout transaction
func (pm *PayoutManager) createPayoutTransaction(payouts map[string]uint64) (string, error) {
	// Build outputs
	outputs := make(map[string]float64)
	for address, amount := range payouts {
		outputs[address] = float64(amount) / 100000000 // Convert to coin units
	}
	
	// Create raw transaction using RPC
	request := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "createrawtransaction",
		"params":  []interface{}{[]interface{}{}, outputs},
		"id":      1,
	}
	
	response, err := pm.makeRPCRequest(request)
	if err != nil {
		return "", fmt.Errorf("failed to create raw transaction: %w", err)
	}
	
	var rawTx string
	if err := json.Unmarshal(response.Result, &rawTx); err != nil {
		return "", fmt.Errorf("failed to parse raw transaction: %w", err)
	}
	
	// Sign transaction (simplified - in production would use proper signing)
	signRequest := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "signrawtransactionwithkey",
		"params":  []interface{}{rawTx, []string{pm.privateKeyWIF}},
		"id":      1,
	}
	
	signResponse, err := pm.makeRPCRequest(signRequest)
	if err != nil {
		return "", fmt.Errorf("failed to sign transaction: %w", err)
	}
	
	var signResult struct {
		Hex      string `json:"hex"`
		Complete bool   `json:"complete"`
	}
	if err := json.Unmarshal(signResponse.Result, &signResult); err != nil {
		return "", fmt.Errorf("failed to parse signed transaction: %w", err)
	}
	
	if !signResult.Complete {
		return "", fmt.Errorf("transaction signing incomplete")
	}
	
	// Broadcast transaction
	broadcastRequest := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "sendrawtransaction",
		"params":  []interface{}{signResult.Hex},
		"id":      1,
	}
	
	broadcastResponse, err := pm.makeRPCRequest(broadcastRequest)
	if err != nil {
		return "", fmt.Errorf("failed to broadcast transaction: %w", err)
	}
	
	var txID string
	if err := json.Unmarshal(broadcastResponse.Result, &txID); err != nil {
		return "", fmt.Errorf("failed to parse transaction ID: %w", err)
	}
	
	return txID, nil
}

// markPayoutsFailed marks payouts as failed
func (pm *PayoutManager) markPayoutsFailed(batch map[string]uint64) {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	
	for address := range batch {
		if payout, exists := pm.pendingPayouts[address]; exists {
			payout.FailedAttempts++
		}
	}
	
	pm.failedPayouts.Add(uint64(len(batch)))
}

// checkConfirmations checks transaction confirmations
func (pm *PayoutManager) checkConfirmations() {
	pm.mu.Lock()
	txsToCheck := make([]*ProcessedTransaction, 0)
	for _, tx := range pm.processedTxs {
		if tx.Status == "pending" {
			txsToCheck = append(txsToCheck, tx)
		}
	}
	pm.mu.Unlock()
	
	for _, tx := range txsToCheck {
		confirmations, err := pm.getTransactionConfirmations(tx.TxID)
		if err != nil {
			pm.logger.Debug("Failed to get confirmations",
				zap.String("tx_id", tx.TxID),
				zap.Error(err),
			)
			continue
		}
		
		pm.mu.Lock()
		if processedTx, exists := pm.processedTxs[tx.TxID]; exists {
			processedTx.Confirmations = confirmations
			if confirmations >= pm.confirmations {
				processedTx.Status = "confirmed"
			}
		}
		pm.mu.Unlock()
	}
}

// getTransactionConfirmations gets the number of confirmations for a transaction
func (pm *PayoutManager) getTransactionConfirmations(txID string) (int, error) {
	request := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "gettransaction",
		"params":  []interface{}{txID},
		"id":      1,
	}
	
	response, err := pm.makeRPCRequest(request)
	if err != nil {
		return 0, err
	}
	
	var txInfo struct {
		Confirmations int `json:"confirmations"`
	}
	if err := json.Unmarshal(response.Result, &txInfo); err != nil {
		return 0, err
	}
	
	return txInfo.Confirmations, nil
}

// makeRPCRequest makes an RPC request to the node
func (pm *PayoutManager) makeRPCRequest(request interface{}) (*RPCResponse, error) {
	// Serialize request
	data, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	
	// Create HTTP request
	req, err := http.NewRequest("POST", pm.nodeURL, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	
	req.Header.Set("Content-Type", "application/json")
	
	// Add authentication if configured
	if pm.rpcUser != "" && pm.rpcPassword != "" {
		req.SetBasicAuth(pm.rpcUser, pm.rpcPassword)
	}
	
	// Make request
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	// Parse response
	var rpcResp RPCResponse
	if err := json.NewDecoder(resp.Body).Decode(&rpcResp); err != nil {
		return nil, err
	}
	
	// Check for RPC error
	if rpcResp.Error != nil {
		return nil, fmt.Errorf("RPC error %d: %s", rpcResp.Error.Code, rpcResp.Error.Message)
	}
	
	return &rpcResp, nil
}

// RPCResponse represents a JSON-RPC response
type RPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	Result  json.RawMessage `json:"result"`
	Error   *RPCError       `json:"error"`
	ID      interface{}     `json:"id"`
}

// RPCError represents a JSON-RPC error
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}