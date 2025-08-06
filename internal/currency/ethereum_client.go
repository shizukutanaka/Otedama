package currency

import (
	"context"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
)

// EthereumClient implements BlockchainClient for Ethereum and EVM-compatible chains
type EthereumClient struct {
	logger     *zap.Logger
	currency   *Currency
	
	// Connection state
	connected  bool
	connMu     sync.RWMutex
	
	// RPC configuration
	rpcURL     string
	chainID    *big.Int
	
	// Request ID counter
	requestID  int64
	requestMu  sync.Mutex
}

// NewEthereumClient creates a new Ethereum RPC client
func NewEthereumClient(logger *zap.Logger, currency *Currency) (BlockchainClient, error) {
	// Build RPC URL
	scheme := "http"
	if currency.RPCSSL {
		scheme = "https"
	}
	
	rpcURL := fmt.Sprintf("%s://%s:%d", scheme, currency.RPCHost, currency.RPCPort)
	
	client := &EthereumClient{
		logger:   logger,
		currency: currency,
		rpcURL:   rpcURL,
		chainID:  big.NewInt(currency.ChainID),
	}
	
	return client, nil
}

// Connect establishes connection to the Ethereum node
func (ec *EthereumClient) Connect(ctx context.Context) error {
	// Test connection with eth_chainId
	var chainID string
	err := ec.call(ctx, "eth_chainId", nil, &chainID)
	if err != nil {
		return fmt.Errorf("failed to connect to Ethereum node: %w", err)
	}
	
	// Verify chain ID matches
	receivedChainID, ok := new(big.Int).SetString(strings.TrimPrefix(chainID, "0x"), 16)
	if !ok {
		return fmt.Errorf("invalid chain ID format: %s", chainID)
	}
	
	if ec.chainID.Cmp(receivedChainID) != 0 {
		return fmt.Errorf("chain ID mismatch: expected %s, got %s", ec.chainID.String(), receivedChainID.String())
	}
	
	ec.connMu.Lock()
	ec.connected = true
	ec.connMu.Unlock()
	
	// Get additional info
	var clientVersion string
	ec.call(ctx, "web3_clientVersion", nil, &clientVersion)
	
	ec.logger.Info("Connected to Ethereum node",
		zap.String("currency", ec.currency.Symbol),
		zap.String("chain_id", chainID),
		zap.String("client", clientVersion),
	)
	
	return nil
}

// Disconnect closes the connection
func (ec *EthereumClient) Disconnect() error {
	ec.connMu.Lock()
	ec.connected = false
	ec.connMu.Unlock()
	return nil
}

// IsConnected returns connection status
func (ec *EthereumClient) IsConnected() bool {
	ec.connMu.RLock()
	defer ec.connMu.RUnlock()
	return ec.connected
}

// GetCurrency returns the currency configuration
func (ec *EthereumClient) GetCurrency() *Currency {
	return ec.currency
}

// GetBlockHeight returns the current block height
func (ec *EthereumClient) GetBlockHeight(ctx context.Context) (int64, error) {
	var result string
	err := ec.call(ctx, "eth_blockNumber", nil, &result)
	if err != nil {
		return 0, err
	}
	
	height, ok := new(big.Int).SetString(strings.TrimPrefix(result, "0x"), 16)
	if !ok {
		return 0, fmt.Errorf("invalid block number format: %s", result)
	}
	
	return height.Int64(), nil
}

// GetBlockHash returns the block hash at the given height
func (ec *EthereumClient) GetBlockHash(ctx context.Context, height int64) (string, error) {
	// Convert height to hex
	heightHex := fmt.Sprintf("0x%x", height)
	
	var block map[string]interface{}
	err := ec.call(ctx, "eth_getBlockByNumber", []interface{}{heightHex, false}, &block)
	if err != nil {
		return "", err
	}
	
	if block == nil {
		return "", fmt.Errorf("block not found at height %d", height)
	}
	
	hash, ok := block["hash"].(string)
	if !ok {
		return "", fmt.Errorf("invalid block hash format")
	}
	
	return hash, nil
}

// GetBlock returns block information
func (ec *EthereumClient) GetBlock(ctx context.Context, hash string) (*Block, error) {
	var result map[string]interface{}
	err := ec.call(ctx, "eth_getBlockByHash", []interface{}{hash, true}, &result)
	if err != nil {
		return nil, err
	}
	
	if result == nil {
		return nil, fmt.Errorf("block not found: %s", hash)
	}
	
	// Parse block data
	block := &Block{
		Hash: hash,
	}
	
	// Parse height
	if numberHex, ok := result["number"].(string); ok {
		if number, ok := new(big.Int).SetString(strings.TrimPrefix(numberHex, "0x"), 16); ok {
			block.Height = number.Int64()
		}
	}
	
	// Parse parent hash
	if parentHash, ok := result["parentHash"].(string); ok {
		block.PreviousHash = parentHash
	}
	
	// Parse timestamp
	if timestampHex, ok := result["timestamp"].(string); ok {
		if timestamp, ok := new(big.Int).SetString(strings.TrimPrefix(timestampHex, "0x"), 16); ok {
			block.Timestamp = time.Unix(timestamp.Int64(), 0)
		}
	}
	
	// Parse difficulty
	if difficultyHex, ok := result["difficulty"].(string); ok {
		if difficulty, ok := new(big.Int).SetString(strings.TrimPrefix(difficultyHex, "0x"), 16); ok {
			block.Difficulty = float64(difficulty.Int64())
		}
	}
	
	// Parse nonce
	if nonceHex, ok := result["nonce"].(string); ok {
		if nonce, ok := new(big.Int).SetString(strings.TrimPrefix(nonceHex, "0x"), 16); ok {
			block.Nonce = nonce.Uint64()
		}
	}
	
	// Parse size
	if sizeHex, ok := result["size"].(string); ok {
		if size, ok := new(big.Int).SetString(strings.TrimPrefix(sizeHex, "0x"), 16); ok {
			block.Size = size.Int64()
		}
	}
	
	// Parse transactions
	if txs, ok := result["transactions"].([]interface{}); ok {
		for _, tx := range txs {
			if txMap, ok := tx.(map[string]interface{}); ok {
				if txHash, ok := txMap["hash"].(string); ok {
					block.Transactions = append(block.Transactions, txHash)
				}
			} else if txHash, ok := tx.(string); ok {
				block.Transactions = append(block.Transactions, txHash)
			}
		}
	}
	
	// Calculate block reward (2 ETH base + fees for ETH)
	baseReward := new(big.Int).Mul(big.NewInt(2), ec.currency.UnitsPerCoin)
	block.Reward = baseReward
	
	return block, nil
}

// GetDifficulty returns the current mining difficulty
func (ec *EthereumClient) GetDifficulty(ctx context.Context) (float64, error) {
	// Get latest block
	var block map[string]interface{}
	err := ec.call(ctx, "eth_getBlockByNumber", []interface{}{"latest", false}, &block)
	if err != nil {
		return 0, err
	}
	
	if difficultyHex, ok := block["difficulty"].(string); ok {
		if difficulty, ok := new(big.Int).SetString(strings.TrimPrefix(difficultyHex, "0x"), 16); ok {
			return float64(difficulty.Int64()), nil
		}
	}
	
	return 0, fmt.Errorf("unable to get difficulty")
}

// GetNetworkHashrate returns the estimated network hashrate
func (ec *EthereumClient) GetNetworkHashrate(ctx context.Context) (float64, error) {
	var result string
	err := ec.call(ctx, "eth_hashrate", nil, &result)
	if err != nil {
		// If eth_hashrate is not available, estimate from difficulty
		difficulty, err := ec.GetDifficulty(ctx)
		if err != nil {
			return 0, err
		}
		// Estimate: hashrate = difficulty / block_time
		return difficulty / ec.currency.BlockTime.Seconds(), nil
	}
	
	hashrate, ok := new(big.Int).SetString(strings.TrimPrefix(result, "0x"), 16)
	if !ok {
		return 0, fmt.Errorf("invalid hashrate format")
	}
	
	return float64(hashrate.Int64()), nil
}

// GetTransaction returns transaction information
func (ec *EthereumClient) GetTransaction(ctx context.Context, txid string) (*Transaction, error) {
	var result map[string]interface{}
	err := ec.call(ctx, "eth_getTransactionByHash", []interface{}{txid}, &result)
	if err != nil {
		return nil, err
	}
	
	if result == nil {
		return nil, fmt.Errorf("transaction not found: %s", txid)
	}
	
	tx := &Transaction{
		TxID: txid,
	}
	
	// Get transaction receipt for additional info
	var receipt map[string]interface{}
	ec.call(ctx, "eth_getTransactionReceipt", []interface{}{txid}, &receipt)
	
	if receipt != nil {
		// Parse confirmations
		if blockNumberHex, ok := receipt["blockNumber"].(string); ok {
			if blockNumber, ok := new(big.Int).SetString(strings.TrimPrefix(blockNumberHex, "0x"), 16); ok {
				currentHeight, _ := ec.GetBlockHeight(ctx)
				tx.Confirmations = int(currentHeight - blockNumber.Int64() + 1)
			}
		}
		
		// Parse block hash
		if blockHash, ok := receipt["blockHash"].(string); ok {
			tx.BlockHash = blockHash
		}
		
		// Parse gas used as fee
		if gasUsedHex, ok := receipt["gasUsed"].(string); ok {
			if gasUsed, ok := new(big.Int).SetString(strings.TrimPrefix(gasUsedHex, "0x"), 16); ok {
				// Get gas price from transaction
				if gasPriceHex, ok := result["gasPrice"].(string); ok {
					if gasPrice, ok := new(big.Int).SetString(strings.TrimPrefix(gasPriceHex, "0x"), 16); ok {
						fee := new(big.Int).Mul(gasUsed, gasPrice)
						tx.Fee = fee
					}
				}
			}
		}
	}
	
	// Parse input (from address)
	if from, ok := result["from"].(string); ok {
		tx.Inputs = append(tx.Inputs, TxInput{
			Address: from,
		})
	}
	
	// Parse output (to address and value)
	if to, ok := result["to"].(string); ok {
		output := TxOutput{
			Address: to,
		}
		
		if valueHex, ok := result["value"].(string); ok {
			if value, ok := new(big.Int).SetString(strings.TrimPrefix(valueHex, "0x"), 16); ok {
				output.Amount = value
			}
		}
		
		tx.Outputs = append(tx.Outputs, output)
	}
	
	return tx, nil
}

// SendRawTransaction broadcasts a raw transaction
func (ec *EthereumClient) SendRawTransaction(ctx context.Context, rawTx string) (string, error) {
	var result string
	err := ec.call(ctx, "eth_sendRawTransaction", []interface{}{rawTx}, &result)
	if err != nil {
		return "", err
	}
	return result, nil
}

// CreateRawTransaction creates a raw transaction (not directly supported in Ethereum)
func (ec *EthereumClient) CreateRawTransaction(ctx context.Context, inputs []TxInput, outputs []TxOutput) (string, error) {
	// For Ethereum, transaction creation is more complex and requires proper signing
	// This would typically be done using a library like go-ethereum
	return "", fmt.Errorf("raw transaction creation not implemented for Ethereum")
}

// SignRawTransaction signs a raw transaction (not directly supported in Ethereum)
func (ec *EthereumClient) SignRawTransaction(ctx context.Context, rawTx string) (string, error) {
	// Ethereum signing requires access to private keys
	return "", fmt.Errorf("transaction signing not implemented for Ethereum")
}

// ValidateAddress checks if an address is valid
func (ec *EthereumClient) ValidateAddress(ctx context.Context, address string) (bool, error) {
	// Basic validation for Ethereum addresses
	if !strings.HasPrefix(address, "0x") {
		return false, nil
	}
	
	if len(address) != 42 {
		return false, nil
	}
	
	// Check if it's a valid hex string
	_, err := hex.DecodeString(address[2:])
	return err == nil, nil
}

// GetBalance returns the balance for an address
func (ec *EthereumClient) GetBalance(ctx context.Context, address string) (*big.Int, error) {
	var result string
	err := ec.call(ctx, "eth_getBalance", []interface{}{address, "latest"}, &result)
	if err != nil {
		return nil, err
	}
	
	balance, ok := new(big.Int).SetString(strings.TrimPrefix(result, "0x"), 16)
	if !ok {
		return nil, fmt.Errorf("invalid balance format")
	}
	
	return balance, nil
}

// GetNewAddress generates a new address (requires wallet functionality)
func (ec *EthereumClient) GetNewAddress(ctx context.Context, label string) (string, error) {
	// Ethereum nodes typically don't generate addresses
	// This would require wallet functionality
	return "", fmt.Errorf("address generation not supported")
}

// GetBlockTemplate returns a block template for mining
func (ec *EthereumClient) GetBlockTemplate(ctx context.Context) (*BlockTemplate, error) {
	// Get work for mining
	var work []string
	err := ec.call(ctx, "eth_getWork", nil, &work)
	if err != nil {
		return nil, err
	}
	
	if len(work) < 4 {
		return nil, fmt.Errorf("invalid work response")
	}
	
	// Parse current block header
	currentBlockHeader := work[0]
	seedHash := work[1]
	target := work[2]
	blockNumber := work[3]
	
	// Convert block number
	height, _ := new(big.Int).SetString(strings.TrimPrefix(blockNumber, "0x"), 16)
	
	template := &BlockTemplate{
		PreviousBlockHash: currentBlockHeader,
		Target:            target,
		Height:            height.Int64(),
		CurTime:           time.Now().Unix(),
	}
	
	// Store seed hash in extra data
	template.NonceRange = seedHash
	
	return template, nil
}

// SubmitBlock submits a mined block
func (ec *EthereumClient) SubmitBlock(ctx context.Context, blockData string) error {
	// For Ethereum, we submit work solution
	// blockData should contain: nonce, header_hash, mix_digest
	parts := strings.Split(blockData, ":")
	if len(parts) != 3 {
		return fmt.Errorf("invalid block data format")
	}
	
	var result bool
	err := ec.call(ctx, "eth_submitWork", []interface{}{parts[0], parts[1], parts[2]}, &result)
	if err != nil {
		return err
	}
	
	if !result {
		return fmt.Errorf("work submission rejected")
	}
	
	return nil
}

// SendPayment sends payments to multiple addresses
func (ec *EthereumClient) SendPayment(ctx context.Context, payments []Payment) (string, error) {
	// Ethereum doesn't support batch payments in a single transaction natively
	// This would require a smart contract or multiple transactions
	return "", fmt.Errorf("batch payments not implemented for Ethereum")
}

// call makes an RPC call to the Ethereum node
func (ec *EthereumClient) call(ctx context.Context, method string, params interface{}, result interface{}) error {
	// Similar to Bitcoin client, but with JSON-RPC 2.0
	// Implementation would be similar to BitcoinClient.call
	// but with appropriate modifications for Ethereum RPC
	
	// For brevity, returning not implemented
	// In production, this would make actual HTTP JSON-RPC calls
	return fmt.Errorf("Ethereum RPC call not fully implemented")
}