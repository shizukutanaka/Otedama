package currency

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
)

// BlockchainClient interface for interacting with different blockchains
type BlockchainClient interface {
	// Connection management
	Connect(ctx context.Context) error
	Disconnect() error
	IsConnected() bool
	GetCurrency() *Currency
	
	// Chain information
	GetBlockHeight(ctx context.Context) (int64, error)
	GetBlockHash(ctx context.Context, height int64) (string, error)
	GetBlock(ctx context.Context, hash string) (*Block, error)
	GetDifficulty(ctx context.Context) (float64, error)
	GetNetworkHashrate(ctx context.Context) (float64, error)
	
	// Transaction management
	GetTransaction(ctx context.Context, txid string) (*Transaction, error)
	SendRawTransaction(ctx context.Context, rawTx string) (string, error)
	CreateRawTransaction(ctx context.Context, inputs []TxInput, outputs []TxOutput) (string, error)
	SignRawTransaction(ctx context.Context, rawTx string) (string, error)
	
	// Address management
	ValidateAddress(ctx context.Context, address string) (bool, error)
	GetBalance(ctx context.Context, address string) (*big.Int, error)
	GetNewAddress(ctx context.Context, label string) (string, error)
	
	// Mining operations
	GetBlockTemplate(ctx context.Context) (*BlockTemplate, error)
	SubmitBlock(ctx context.Context, blockData string) error
	
	// Pool operations
	SendPayment(ctx context.Context, payments []Payment) (string, error)
}

// Block represents a blockchain block
type Block struct {
	Height        int64       `json:"height"`
	Hash          string      `json:"hash"`
	PreviousHash  string      `json:"previous_hash"`
	Timestamp     time.Time   `json:"timestamp"`
	Difficulty    float64     `json:"difficulty"`
	Nonce         uint64      `json:"nonce"`
	Transactions  []string    `json:"transactions"`
	Reward        *big.Int    `json:"reward"`
	Size          int64       `json:"size"`
	Version       int32       `json:"version"`
}

// Transaction represents a blockchain transaction
type Transaction struct {
	TxID          string      `json:"txid"`
	BlockHash     string      `json:"block_hash"`
	Confirmations int         `json:"confirmations"`
	Time          time.Time   `json:"time"`
	Size          int         `json:"size"`
	Fee           *big.Int    `json:"fee"`
	Inputs        []TxInput   `json:"inputs"`
	Outputs       []TxOutput  `json:"outputs"`
}

// TxInput represents a transaction input
type TxInput struct {
	TxID         string   `json:"txid"`
	Vout         uint32   `json:"vout"`
	ScriptSig    string   `json:"script_sig"`
	Address      string   `json:"address"`
	Amount       *big.Int `json:"amount"`
}

// TxOutput represents a transaction output
type TxOutput struct {
	Address      string   `json:"address"`
	Amount       *big.Int `json:"amount"`
	ScriptPubKey string   `json:"script_pubkey"`
	Index        uint32   `json:"index"`
}

// BlockTemplate represents a mining block template
type BlockTemplate struct {
	Version           int32    `json:"version"`
	PreviousBlockHash string   `json:"previousblockhash"`
	Transactions      []string `json:"transactions"`
	CoinbaseValue     *big.Int `json:"coinbasevalue"`
	Target            string   `json:"target"`
	Bits              string   `json:"bits"`
	Height            int64    `json:"height"`
	CurTime           int64    `json:"curtime"`
	MinTime           int64    `json:"mintime"`
	NonceRange        string   `json:"noncerange"`
	SigOpLimit        int      `json:"sigoplimit"`
	SizeLimit         int      `json:"sizelimit"`
}

// Payment represents a payment to be sent
type Payment struct {
	Address string   `json:"address"`
	Amount  *big.Int `json:"amount"`
	PayID   string   `json:"pay_id"` // For privacy coins
}

// ClientManager manages blockchain clients for multiple currencies
type ClientManager struct {
	logger          *zap.Logger
	currencyManager *CurrencyManager
	clients         map[string]BlockchainClient
	clientsMu       sync.RWMutex
	
	// Client factories
	factories       map[string]ClientFactory
}

// ClientFactory creates blockchain clients for specific implementations
type ClientFactory func(logger *zap.Logger, currency *Currency) (BlockchainClient, error)

// NewClientManager creates a new blockchain client manager
func NewClientManager(logger *zap.Logger, currencyManager *CurrencyManager) *ClientManager {
	cm := &ClientManager{
		logger:          logger,
		currencyManager: currencyManager,
		clients:         make(map[string]BlockchainClient),
		factories:       make(map[string]ClientFactory),
	}
	
	// Register default client factories
	cm.registerDefaultFactories()
	
	return cm
}

// registerDefaultFactories registers client factories for supported blockchains
func (cm *ClientManager) registerDefaultFactories() {
	// Bitcoin and Bitcoin-like currencies
	cm.RegisterFactory("bitcoin", NewBitcoinClient)
	cm.RegisterFactory("litecoin", NewBitcoinClient) // Uses same RPC interface
	cm.RegisterFactory("bitcoincash", NewBitcoinClient)
	
	// Ethereum and EVM-compatible chains
	cm.RegisterFactory("ethereum", NewEthereumClient)
	cm.RegisterFactory("ethereumclassic", NewEthereumClient)
	
	// Other currencies
	cm.RegisterFactory("monero", NewMoneroClient)
	cm.RegisterFactory("ravencoin", NewBitcoinClient) // Bitcoin fork
	cm.RegisterFactory("ergo", NewErgoClient)
}

// RegisterFactory registers a client factory for a blockchain type
func (cm *ClientManager) RegisterFactory(blockchainType string, factory ClientFactory) {
	cm.factories[strings.ToLower(blockchainType)] = factory
}

// GetClient returns a blockchain client for the specified currency
func (cm *ClientManager) GetClient(ctx context.Context, symbol string) (BlockchainClient, error) {
	cm.clientsMu.RLock()
	client, exists := cm.clients[symbol]
	cm.clientsMu.RUnlock()
	
	if exists && client.IsConnected() {
		return client, nil
	}
	
	// Create new client
	currency, err := cm.currencyManager.GetCurrency(symbol)
	if err != nil {
		return nil, err
	}
	
	// Determine blockchain type
	blockchainType := cm.getBlockchainType(currency)
	
	// Get factory
	factory, exists := cm.factories[blockchainType]
	if !exists {
		return nil, fmt.Errorf("no client factory for blockchain type: %s", blockchainType)
	}
	
	// Create client
	client, err = factory(cm.logger, currency)
	if err != nil {
		return nil, fmt.Errorf("failed to create client: %w", err)
	}
	
	// Connect client
	if err := client.Connect(ctx); err != nil {
		return nil, fmt.Errorf("failed to connect client: %w", err)
	}
	
	// Store client
	cm.clientsMu.Lock()
	cm.clients[symbol] = client
	cm.clientsMu.Unlock()
	
	cm.logger.Info("Created blockchain client",
		zap.String("currency", symbol),
		zap.String("type", blockchainType),
	)
	
	return client, nil
}

// DisconnectAll disconnects all blockchain clients
func (cm *ClientManager) DisconnectAll() {
	cm.clientsMu.Lock()
	defer cm.clientsMu.Unlock()
	
	for symbol, client := range cm.clients {
		if err := client.Disconnect(); err != nil {
			cm.logger.Error("Failed to disconnect client",
				zap.String("currency", symbol),
				zap.Error(err),
			)
		}
	}
	
	cm.clients = make(map[string]BlockchainClient)
}

// getBlockchainType determines the blockchain type from currency
func (cm *ClientManager) getBlockchainType(currency *Currency) string {
	// Map algorithm/currency to blockchain type
	switch strings.ToLower(currency.Symbol) {
	case "btc":
		return "bitcoin"
	case "ltc":
		return "litecoin"
	case "bch":
		return "bitcoincash"
	case "eth":
		return "ethereum"
	case "etc":
		return "ethereumclassic"
	case "xmr":
		return "monero"
	case "rvn":
		return "ravencoin"
	case "erg":
		return "ergo"
	default:
		// Try to infer from algorithm
		switch strings.ToLower(currency.Algorithm) {
		case "sha256", "scrypt":
			return "bitcoin" // Bitcoin-compatible RPC
		case "ethash", "etchash":
			return "ethereum"
		case "randomx":
			return "monero"
		case "autolykos2":
			return "ergo"
		default:
			return "bitcoin" // Default to Bitcoin RPC
		}
	}
}

// GetActiveClients returns all active blockchain clients
func (cm *ClientManager) GetActiveClients() map[string]BlockchainClient {
	cm.clientsMu.RLock()
	defer cm.clientsMu.RUnlock()
	
	active := make(map[string]BlockchainClient)
	for symbol, client := range cm.clients {
		if client.IsConnected() {
			active[symbol] = client
		}
	}
	
	return active
}

// HealthCheck performs health check on all clients
func (cm *ClientManager) HealthCheck(ctx context.Context) map[string]bool {
	cm.clientsMu.RLock()
	clients := make(map[string]BlockchainClient)
	for k, v := range cm.clients {
		clients[k] = v
	}
	cm.clientsMu.RUnlock()
	
	health := make(map[string]bool)
	var wg sync.WaitGroup
	var mu sync.Mutex
	
	for symbol, client := range clients {
		wg.Add(1)
		go func(s string, c BlockchainClient) {
			defer wg.Done()
			
			// Try to get block height as health check
			ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			
			_, err := c.GetBlockHeight(ctx)
			
			mu.Lock()
			health[s] = err == nil
			mu.Unlock()
		}(symbol, client)
	}
	
	wg.Wait()
	return health
}

// MultiCurrencyOperation performs an operation across multiple currencies
type MultiCurrencyOperation struct {
	Symbol    string
	Operation func(client BlockchainClient) error
	Result    interface{}
	Error     error
}

// ExecuteMultiCurrency executes operations across multiple currencies in parallel
func (cm *ClientManager) ExecuteMultiCurrency(ctx context.Context, symbols []string, operation func(client BlockchainClient) (interface{}, error)) []MultiCurrencyOperation {
	results := make([]MultiCurrencyOperation, len(symbols))
	var wg sync.WaitGroup
	
	for i, symbol := range symbols {
		wg.Add(1)
		go func(idx int, sym string) {
			defer wg.Done()
			
			results[idx].Symbol = sym
			
			client, err := cm.GetClient(ctx, sym)
			if err != nil {
				results[idx].Error = err
				return
			}
			
			result, err := operation(client)
			results[idx].Result = result
			results[idx].Error = err
		}(i, symbol)
	}
	
	wg.Wait()
	return results
}

// GetNetworkStatus returns network status for all active currencies
func (cm *ClientManager) GetNetworkStatus(ctx context.Context) map[string]interface{} {
	clients := cm.GetActiveClients()
	status := make(map[string]interface{})
	
	var wg sync.WaitGroup
	var mu sync.Mutex
	
	for symbol, client := range clients {
		wg.Add(1)
		go func(s string, c BlockchainClient) {
			defer wg.Done()
			
			info := make(map[string]interface{})
			
			// Get various network stats
			if height, err := c.GetBlockHeight(ctx); err == nil {
				info["block_height"] = height
			}
			
			if diff, err := c.GetDifficulty(ctx); err == nil {
				info["difficulty"] = diff
			}
			
			if hashrate, err := c.GetNetworkHashrate(ctx); err == nil {
				info["network_hashrate"] = hashrate
			}
			
			info["connected"] = c.IsConnected()
			info["currency"] = c.GetCurrency().Name
			
			mu.Lock()
			status[s] = info
			mu.Unlock()
		}(symbol, client)
	}
	
	wg.Wait()
	return status
}

// BatchPayment represents a batch of payments across multiple currencies
type BatchPayment struct {
	Currency string    `json:"currency"`
	Payments []Payment `json:"payments"`
	TxID     string    `json:"txid"`
	Error    error     `json:"error,omitempty"`
}

// SendBatchPayments sends payments across multiple currencies
func (cm *ClientManager) SendBatchPayments(ctx context.Context, batches []BatchPayment) []BatchPayment {
	results := make([]BatchPayment, len(batches))
	var wg sync.WaitGroup
	
	for i, batch := range batches {
		wg.Add(1)
		go func(idx int, b BatchPayment) {
			defer wg.Done()
			
			results[idx] = b
			
			client, err := cm.GetClient(ctx, b.Currency)
			if err != nil {
				results[idx].Error = err
				return
			}
			
			txid, err := client.SendPayment(ctx, b.Payments)
			results[idx].TxID = txid
			results[idx].Error = err
		}(i, batch)
	}
	
	wg.Wait()
	return results
}