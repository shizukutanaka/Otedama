package blockchain

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"go.uber.org/zap"
)

// SmartContractManager manages smart contract interactions
type SmartContractManager struct {
	logger         *zap.Logger
	clients        map[string]*ethclient.Client
	contracts      map[string]*PoolContract
	privateKey     *ecdsa.PrivateKey
	gasMultiplier  float64
	
	mu             sync.RWMutex
	pendingTxs     map[string]*PendingTransaction
	
	ctx            context.Context
	cancel         context.CancelFunc
	wg             sync.WaitGroup
}

// PoolContract represents a deployed mining pool smart contract
type PoolContract struct {
	Address     common.Address
	ABI         abi.ABI
	Instance    *bind.BoundContract
	ChainID     *big.Int
	Currency    string
	DeployBlock uint64
}

// PendingTransaction tracks a pending blockchain transaction
type PendingTransaction struct {
	TxHash      common.Hash
	Type        string
	Currency    string
	Amount      *big.Int
	Recipients  []common.Address
	SubmittedAt time.Time
	Confirmed   bool
	BlockNumber uint64
}

// SmartContractConfig contains smart contract configuration
type SmartContractConfig struct {
	// Private key for signing transactions
	PrivateKey string
	
	// RPC endpoints by currency/chain
	RPCEndpoints map[string]string
	
	// Contract addresses by currency
	ContractAddresses map[string]string
	
	// Gas price multiplier for faster confirmation
	GasMultiplier float64
	
	// Confirmation requirements
	RequiredConfirmations int
	ConfirmationTimeout   time.Duration
}

// Pool contract ABI (simplified)
const poolContractABI = `[
	{
		"inputs": [],
		"name": "initialize",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{"internalType": "address[]", "name": "workers", "type": "address[]"},
			{"internalType": "uint256[]", "name": "amounts", "type": "uint256[]"}
		],
		"name": "distributePayout",
		"outputs": [{"internalType": "bytes32", "name": "", "type": "bytes32"}],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{"internalType": "address", "name": "worker", "type": "address"},
			{"internalType": "uint256", "name": "shares", "type": "uint256"}
		],
		"name": "recordShares",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{"internalType": "uint256", "name": "height", "type": "uint256"},
			{"internalType": "uint256", "name": "reward", "type": "uint256"}
		],
		"name": "recordBlock",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [{"internalType": "address", "name": "worker", "type": "address"}],
		"name": "getWorkerBalance",
		"outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "getTotalShares",
		"outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "getPoolBalance",
		"outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"anonymous": false,
		"inputs": [
			{"indexed": true, "name": "payoutId", "type": "bytes32"},
			{"indexed": false, "name": "totalAmount", "type": "uint256"},
			{"indexed": false, "name": "workerCount", "type": "uint256"}
		],
		"name": "PayoutDistributed",
		"type": "event"
	},
	{
		"anonymous": false,
		"inputs": [
			{"indexed": true, "name": "worker", "type": "address"},
			{"indexed": false, "name": "shares", "type": "uint256"}
		],
		"name": "SharesRecorded",
		"type": "event"
	}
]`

// NewSmartContractManager creates a new smart contract manager
func NewSmartContractManager(logger *zap.Logger, config SmartContractConfig) (*SmartContractManager, error) {
	// Parse private key
	privateKey, err := crypto.HexToECDSA(strings.TrimPrefix(config.PrivateKey, "0x"))
	if err != nil {
		return nil, fmt.Errorf("invalid private key: %w", err)
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	scm := &SmartContractManager{
		logger:        logger,
		clients:       make(map[string]*ethclient.Client),
		contracts:     make(map[string]*PoolContract),
		privateKey:    privateKey,
		gasMultiplier: config.GasMultiplier,
		pendingTxs:    make(map[string]*PendingTransaction),
		ctx:           ctx,
		cancel:        cancel,
	}
	
	// Initialize clients and contracts
	for currency, endpoint := range config.RPCEndpoints {
		if err := scm.initializeClient(currency, endpoint, config.ContractAddresses[currency]); err != nil {
			logger.Error("Failed to initialize client",
				zap.String("currency", currency),
				zap.Error(err))
			continue
		}
	}
	
	// Start transaction monitor
	scm.wg.Add(1)
	go scm.transactionMonitor()
	
	return scm, nil
}

// Stop stops the smart contract manager
func (scm *SmartContractManager) Stop() error {
	scm.cancel()
	scm.wg.Wait()
	
	// Close all clients
	scm.mu.Lock()
	defer scm.mu.Unlock()
	
	for _, client := range scm.clients {
		client.Close()
	}
	
	return nil
}

// initializeClient initializes a blockchain client and contract
func (scm *SmartContractManager) initializeClient(currency, endpoint, contractAddr string) error {
	// Connect to blockchain
	client, err := ethclient.Dial(endpoint)
	if err != nil {
		return fmt.Errorf("failed to connect to %s: %w", currency, err)
	}
	
	// Get chain ID
	chainID, err := client.ChainID(context.Background())
	if err != nil {
		return fmt.Errorf("failed to get chain ID: %w", err)
	}
	
	// Parse contract ABI
	contractABI, err := abi.JSON(strings.NewReader(poolContractABI))
	if err != nil {
		return fmt.Errorf("failed to parse ABI: %w", err)
	}
	
	// Create contract instance
	address := common.HexToAddress(contractAddr)
	instance := bind.NewBoundContract(address, contractABI, client, client, client)
	
	// Get deploy block (for event filtering)
	deployBlock := uint64(0) // Would query from contract or config
	
	scm.mu.Lock()
	scm.clients[currency] = client
	scm.contracts[currency] = &PoolContract{
		Address:     address,
		ABI:         contractABI,
		Instance:    instance,
		ChainID:     chainID,
		Currency:    currency,
		DeployBlock: deployBlock,
	}
	scm.mu.Unlock()
	
	scm.logger.Info("Initialized smart contract client",
		zap.String("currency", currency),
		zap.String("contract", contractAddr),
		zap.String("chain_id", chainID.String()))
	
	return nil
}

// DistributePayouts distributes payouts through smart contract
func (scm *SmartContractManager) DistributePayouts(
	currency string,
	payouts map[string]*big.Int,
) (string, error) {
	scm.mu.RLock()
	contract, exists := scm.contracts[currency]
	client := scm.clients[currency]
	scm.mu.RUnlock()
	
	if !exists {
		return "", fmt.Errorf("no contract for currency %s", currency)
	}
	
	// Prepare payout data
	workers := make([]common.Address, 0, len(payouts))
	amounts := make([]*big.Int, 0, len(payouts))
	totalAmount := big.NewInt(0)
	
	for address, amount := range payouts {
		workers = append(workers, common.HexToAddress(address))
		amounts = append(amounts, amount)
		totalAmount.Add(totalAmount, amount)
	}
	
	// Create transaction options
	auth, err := scm.createTransactor(contract.ChainID)
	if err != nil {
		return "", fmt.Errorf("failed to create transactor: %w", err)
	}
	
	// Estimate gas
	gasLimit, err := scm.estimateGas(client, contract, "distributePayout", workers, amounts)
	if err != nil {
		return "", fmt.Errorf("failed to estimate gas: %w", err)
	}
	auth.GasLimit = gasLimit
	
	// Get gas price with multiplier
	gasPrice, err := client.SuggestGasPrice(context.Background())
	if err != nil {
		return "", fmt.Errorf("failed to get gas price: %w", err)
	}
	
	// Apply multiplier for faster confirmation
	gasPrice = new(big.Int).Mul(gasPrice, big.NewInt(int64(scm.gasMultiplier*100)))
	gasPrice.Div(gasPrice, big.NewInt(100))
	auth.GasPrice = gasPrice
	
	// Execute transaction
	tx, err := contract.Instance.Transact(auth, "distributePayout", workers, amounts)
	if err != nil {
		return "", fmt.Errorf("failed to execute payout distribution: %w", err)
	}
	
	// Track pending transaction
	scm.trackPendingTransaction(&PendingTransaction{
		TxHash:      tx.Hash(),
		Type:        "payout",
		Currency:    currency,
		Amount:      totalAmount,
		Recipients:  workers,
		SubmittedAt: time.Now(),
	})
	
	scm.logger.Info("Payout distribution submitted",
		zap.String("currency", currency),
		zap.String("tx_hash", tx.Hash().Hex()),
		zap.String("total_amount", totalAmount.String()),
		zap.Int("worker_count", len(workers)))
	
	return tx.Hash().Hex(), nil
}

// RecordShares records worker shares on the blockchain
func (scm *SmartContractManager) RecordShares(
	currency string,
	workerAddress string,
	shares *big.Int,
) error {
	scm.mu.RLock()
	contract, exists := scm.contracts[currency]
	client := scm.clients[currency]
	scm.mu.RUnlock()
	
	if !exists {
		return fmt.Errorf("no contract for currency %s", currency)
	}
	
	// Create transaction options
	auth, err := scm.createTransactor(contract.ChainID)
	if err != nil {
		return fmt.Errorf("failed to create transactor: %w", err)
	}
	
	// Estimate gas
	worker := common.HexToAddress(workerAddress)
	gasLimit, err := scm.estimateGas(client, contract, "recordShares", worker, shares)
	if err != nil {
		return fmt.Errorf("failed to estimate gas: %w", err)
	}
	auth.GasLimit = gasLimit
	
	// Execute transaction
	tx, err := contract.Instance.Transact(auth, "recordShares", worker, shares)
	if err != nil {
		return fmt.Errorf("failed to record shares: %w", err)
	}
	
	scm.logger.Debug("Shares recorded on blockchain",
		zap.String("currency", currency),
		zap.String("worker", workerAddress),
		zap.String("shares", shares.String()),
		zap.String("tx_hash", tx.Hash().Hex()))
	
	return nil
}

// RecordBlock records a found block on the blockchain
func (scm *SmartContractManager) RecordBlock(
	currency string,
	height *big.Int,
	reward *big.Int,
) error {
	scm.mu.RLock()
	contract, exists := scm.contracts[currency]
	client := scm.clients[currency]
	scm.mu.RUnlock()
	
	if !exists {
		return fmt.Errorf("no contract for currency %s", currency)
	}
	
	// Create transaction options
	auth, err := scm.createTransactor(contract.ChainID)
	if err != nil {
		return fmt.Errorf("failed to create transactor: %w", err)
	}
	
	// Estimate gas
	gasLimit, err := scm.estimateGas(client, contract, "recordBlock", height, reward)
	if err != nil {
		return fmt.Errorf("failed to estimate gas: %w", err)
	}
	auth.GasLimit = gasLimit
	
	// Execute transaction
	tx, err := contract.Instance.Transact(auth, "recordBlock", height, reward)
	if err != nil {
		return fmt.Errorf("failed to record block: %w", err)
	}
	
	scm.logger.Info("Block recorded on blockchain",
		zap.String("currency", currency),
		zap.String("height", height.String()),
		zap.String("reward", reward.String()),
		zap.String("tx_hash", tx.Hash().Hex()))
	
	return nil
}

// GetWorkerBalance queries worker balance from smart contract
func (scm *SmartContractManager) GetWorkerBalance(
	currency string,
	workerAddress string,
) (*big.Int, error) {
	scm.mu.RLock()
	contract, exists := scm.contracts[currency]
	scm.mu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("no contract for currency %s", currency)
	}
	
	// Create call options
	opts := &bind.CallOpts{
		Context: context.Background(),
	}
	
	// Query balance
	var balance *big.Int
	worker := common.HexToAddress(workerAddress)
	
	results := []interface{}{&balance}
	err := contract.Instance.Call(opts, &results, "getWorkerBalance", worker)
	if err != nil {
		return nil, fmt.Errorf("failed to get worker balance: %w", err)
	}
	
	return balance, nil
}

// WatchPayoutEvents watches for payout events from smart contract
func (scm *SmartContractManager) WatchPayoutEvents(
	currency string,
	callback func(payoutID [32]byte, amount *big.Int, workerCount *big.Int),
) error {
	scm.mu.RLock()
	contract, exists := scm.contracts[currency]
	client := scm.clients[currency]
	scm.mu.RUnlock()
	
	if !exists {
		return fmt.Errorf("no contract for currency %s", currency)
	}
	
	// Create event filter
	query := ethereum.FilterQuery{
		Addresses: []common.Address{contract.Address},
		FromBlock: big.NewInt(int64(contract.DeployBlock)),
	}
	
	logs := make(chan types.Log)
	sub, err := client.SubscribeFilterLogs(context.Background(), query, logs)
	if err != nil {
		return fmt.Errorf("failed to subscribe to events: %w", err)
	}
	
	// Process events
	go func() {
		defer sub.Unsubscribe()
		
		for {
			select {
			case err := <-sub.Err():
				scm.logger.Error("Event subscription error",
					zap.String("currency", currency),
					zap.Error(err))
				return
				
			case vLog := <-logs:
				// Parse event
				event := struct {
					PayoutId    [32]byte
					TotalAmount *big.Int
					WorkerCount *big.Int
				}{}
				
				err := contract.ABI.UnpackIntoInterface(&event, "PayoutDistributed", vLog.Data)
				if err != nil {
					scm.logger.Error("Failed to unpack event",
						zap.Error(err))
					continue
				}
				
				// Call callback
				callback(event.PayoutId, event.TotalAmount, event.WorkerCount)
			}
		}
	}()
	
	return nil
}

// Helper methods

func (scm *SmartContractManager) createTransactor(chainID *big.Int) (*bind.TransactOpts, error) {
	auth, err := bind.NewKeyedTransactorWithChainID(scm.privateKey, chainID)
	if err != nil {
		return nil, err
	}
	
	auth.Context = context.Background()
	return auth, nil
}

func (scm *SmartContractManager) estimateGas(
	client *ethclient.Client,
	contract *PoolContract,
	method string,
	args ...interface{},
) (uint64, error) {
	// Pack method call
	data, err := contract.ABI.Pack(method, args...)
	if err != nil {
		return 0, fmt.Errorf("failed to pack method: %w", err)
	}
	
	// Get from address
	fromAddress := crypto.PubkeyToAddress(scm.privateKey.PublicKey)
	
	// Estimate gas
	msg := ethereum.CallMsg{
		From: fromAddress,
		To:   &contract.Address,
		Data: data,
	}
	
	gasLimit, err := client.EstimateGas(context.Background(), msg)
	if err != nil {
		return 0, fmt.Errorf("failed to estimate gas: %w", err)
	}
	
	// Add 10% buffer
	return gasLimit * 110 / 100, nil
}

func (scm *SmartContractManager) trackPendingTransaction(tx *PendingTransaction) {
	scm.mu.Lock()
	scm.pendingTxs[tx.TxHash.Hex()] = tx
	scm.mu.Unlock()
}

func (scm *SmartContractManager) transactionMonitor() {
	defer scm.wg.Done()
	
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-scm.ctx.Done():
			return
			
		case <-ticker.C:
			scm.checkPendingTransactions()
		}
	}
}

func (scm *SmartContractManager) checkPendingTransactions() {
	scm.mu.RLock()
	pendingTxs := make([]*PendingTransaction, 0, len(scm.pendingTxs))
	for _, tx := range scm.pendingTxs {
		if !tx.Confirmed {
			pendingTxs = append(pendingTxs, tx)
		}
	}
	scm.mu.RUnlock()
	
	for _, tx := range pendingTxs {
		scm.checkTransactionStatus(tx)
	}
}

func (scm *SmartContractManager) checkTransactionStatus(tx *PendingTransaction) {
	scm.mu.RLock()
	client, exists := scm.clients[tx.Currency]
	scm.mu.RUnlock()
	
	if !exists {
		return
	}
	
	receipt, err := client.TransactionReceipt(context.Background(), tx.TxHash)
	if err != nil {
		// Transaction still pending
		return
	}
	
	// Update transaction status
	scm.mu.Lock()
	if pendingTx, exists := scm.pendingTxs[tx.TxHash.Hex()]; exists {
		pendingTx.Confirmed = true
		pendingTx.BlockNumber = receipt.BlockNumber.Uint64()
		
		if receipt.Status == 1 {
			scm.logger.Info("Transaction confirmed",
				zap.String("tx_hash", tx.TxHash.Hex()),
				zap.String("type", tx.Type),
				zap.Uint64("block", receipt.BlockNumber.Uint64()))
		} else {
			scm.logger.Error("Transaction failed",
				zap.String("tx_hash", tx.TxHash.Hex()),
				zap.String("type", tx.Type))
		}
	}
	scm.mu.Unlock()
}