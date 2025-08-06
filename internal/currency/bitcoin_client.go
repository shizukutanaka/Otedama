package currency

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"sync"
	"time"

	"go.uber.org/zap"
)

// BitcoinClient implements BlockchainClient for Bitcoin and Bitcoin-like currencies
type BitcoinClient struct {
	logger     *zap.Logger
	currency   *Currency
	httpClient *http.Client
	
	// Connection state
	connected  bool
	connMu     sync.RWMutex
	
	// RPC configuration
	rpcURL     string
	rpcUser    string
	rpcPass    string
	
	// Request ID counter
	requestID  int64
	requestMu  sync.Mutex
}

// NewBitcoinClient creates a new Bitcoin RPC client
func NewBitcoinClient(logger *zap.Logger, currency *Currency) (BlockchainClient, error) {
	// Build RPC URL
	scheme := "http"
	if currency.RPCSSL {
		scheme = "https"
	}
	
	rpcURL := fmt.Sprintf("%s://%s:%d", scheme, currency.RPCHost, currency.RPCPort)
	
	client := &BitcoinClient{
		logger:   logger,
		currency: currency,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		rpcURL:  rpcURL,
		rpcUser: currency.RPCUser,
		rpcPass: currency.RPCPassword,
	}
	
	return client, nil
}

// Connect establishes connection to the Bitcoin node
func (bc *BitcoinClient) Connect(ctx context.Context) error {
	// Test connection with getblockchaininfo
	var result map[string]interface{}
	err := bc.call(ctx, "getblockchaininfo", nil, &result)
	if err != nil {
		return fmt.Errorf("failed to connect to Bitcoin node: %w", err)
	}
	
	bc.connMu.Lock()
	bc.connected = true
	bc.connMu.Unlock()
	
	bc.logger.Info("Connected to Bitcoin node",
		zap.String("currency", bc.currency.Symbol),
		zap.String("chain", result["chain"].(string)),
		zap.Float64("blocks", result["blocks"].(float64)),
	)
	
	return nil
}

// Disconnect closes the connection
func (bc *BitcoinClient) Disconnect() error {
	bc.connMu.Lock()
	bc.connected = false
	bc.connMu.Unlock()
	return nil
}

// IsConnected returns connection status
func (bc *BitcoinClient) IsConnected() bool {
	bc.connMu.RLock()
	defer bc.connMu.RUnlock()
	return bc.connected
}

// GetCurrency returns the currency configuration
func (bc *BitcoinClient) GetCurrency() *Currency {
	return bc.currency
}

// GetBlockHeight returns the current block height
func (bc *BitcoinClient) GetBlockHeight(ctx context.Context) (int64, error) {
	var result float64
	err := bc.call(ctx, "getblockcount", nil, &result)
	if err != nil {
		return 0, err
	}
	return int64(result), nil
}

// GetBlockHash returns the block hash at the given height
func (bc *BitcoinClient) GetBlockHash(ctx context.Context, height int64) (string, error) {
	var result string
	err := bc.call(ctx, "getblockhash", []interface{}{height}, &result)
	if err != nil {
		return "", err
	}
	return result, nil
}

// GetBlock returns block information
func (bc *BitcoinClient) GetBlock(ctx context.Context, hash string) (*Block, error) {
	var result map[string]interface{}
	err := bc.call(ctx, "getblock", []interface{}{hash, 2}, &result) // verbosity=2 for full tx data
	if err != nil {
		return nil, err
	}
	
	// Parse block data
	block := &Block{
		Height:       int64(result["height"].(float64)),
		Hash:         result["hash"].(string),
		PreviousHash: result["previousblockhash"].(string),
		Timestamp:    time.Unix(int64(result["time"].(float64)), 0),
		Difficulty:   result["difficulty"].(float64),
		Size:         int64(result["size"].(float64)),
		Version:      int32(result["version"].(float64)),
	}
	
	// Extract transaction IDs
	if txs, ok := result["tx"].([]interface{}); ok {
		for _, tx := range txs {
			if txMap, ok := tx.(map[string]interface{}); ok {
				if txid, ok := txMap["txid"].(string); ok {
					block.Transactions = append(block.Transactions, txid)
				}
			}
		}
	}
	
	// Calculate block reward (simplified - actual calculation is more complex)
	blockReward := bc.calculateBlockReward(block.Height)
	block.Reward = blockReward
	
	return block, nil
}

// GetDifficulty returns the current mining difficulty
func (bc *BitcoinClient) GetDifficulty(ctx context.Context) (float64, error) {
	var result float64
	err := bc.call(ctx, "getdifficulty", nil, &result)
	if err != nil {
		return 0, err
	}
	return result, nil
}

// GetNetworkHashrate returns the estimated network hashrate
func (bc *BitcoinClient) GetNetworkHashrate(ctx context.Context) (float64, error) {
	var result float64
	err := bc.call(ctx, "getnetworkhashps", nil, &result)
	if err != nil {
		return 0, err
	}
	return result, nil
}

// GetTransaction returns transaction information
func (bc *BitcoinClient) GetTransaction(ctx context.Context, txid string) (*Transaction, error) {
	var result map[string]interface{}
	err := bc.call(ctx, "getrawtransaction", []interface{}{txid, true}, &result)
	if err != nil {
		return nil, err
	}
	
	tx := &Transaction{
		TxID:          result["txid"].(string),
		Size:          int(result["size"].(float64)),
		Confirmations: int(result["confirmations"].(float64)),
	}
	
	if blockHash, ok := result["blockhash"].(string); ok {
		tx.BlockHash = blockHash
	}
	
	if blockTime, ok := result["blocktime"].(float64); ok {
		tx.Time = time.Unix(int64(blockTime), 0)
	}
	
	// Parse inputs and outputs
	if vins, ok := result["vin"].([]interface{}); ok {
		for _, vin := range vins {
			vinMap := vin.(map[string]interface{})
			input := TxInput{}
			
			if txid, ok := vinMap["txid"].(string); ok {
				input.TxID = txid
			}
			if vout, ok := vinMap["vout"].(float64); ok {
				input.Vout = uint32(vout)
			}
			
			tx.Inputs = append(tx.Inputs, input)
		}
	}
	
	if vouts, ok := result["vout"].([]interface{}); ok {
		for _, vout := range vouts {
			voutMap := vout.(map[string]interface{})
			output := TxOutput{}
			
			if value, ok := voutMap["value"].(float64); ok {
				satoshis := int64(value * float64(bc.currency.UnitsPerCoin.Int64()))
				output.Amount = big.NewInt(satoshis)
			}
			
			if n, ok := voutMap["n"].(float64); ok {
				output.Index = uint32(n)
			}
			
			if scriptPubKey, ok := voutMap["scriptPubKey"].(map[string]interface{}); ok {
				if addresses, ok := scriptPubKey["addresses"].([]interface{}); ok && len(addresses) > 0 {
					output.Address = addresses[0].(string)
				}
			}
			
			tx.Outputs = append(tx.Outputs, output)
		}
	}
	
	return tx, nil
}

// SendRawTransaction broadcasts a raw transaction
func (bc *BitcoinClient) SendRawTransaction(ctx context.Context, rawTx string) (string, error) {
	var result string
	err := bc.call(ctx, "sendrawtransaction", []interface{}{rawTx}, &result)
	if err != nil {
		return "", err
	}
	return result, nil
}

// CreateRawTransaction creates a raw transaction
func (bc *BitcoinClient) CreateRawTransaction(ctx context.Context, inputs []TxInput, outputs []TxOutput) (string, error) {
	// Convert inputs to RPC format
	rpcInputs := make([]map[string]interface{}, len(inputs))
	for i, input := range inputs {
		rpcInputs[i] = map[string]interface{}{
			"txid": input.TxID,
			"vout": input.Vout,
		}
	}
	
	// Convert outputs to RPC format
	rpcOutputs := make(map[string]float64)
	for _, output := range outputs {
		// Convert satoshis to BTC
		btcAmount := new(big.Float).SetInt(output.Amount)
		btcAmount.Quo(btcAmount, new(big.Float).SetInt(bc.currency.UnitsPerCoin))
		amount, _ := btcAmount.Float64()
		rpcOutputs[output.Address] = amount
	}
	
	var result string
	err := bc.call(ctx, "createrawtransaction", []interface{}{rpcInputs, rpcOutputs}, &result)
	if err != nil {
		return "", err
	}
	return result, nil
}

// SignRawTransaction signs a raw transaction
func (bc *BitcoinClient) SignRawTransaction(ctx context.Context, rawTx string) (string, error) {
	var result map[string]interface{}
	err := bc.call(ctx, "signrawtransactionwithwallet", []interface{}{rawTx}, &result)
	if err != nil {
		return "", err
	}
	
	if complete, ok := result["complete"].(bool); !ok || !complete {
		return "", fmt.Errorf("transaction signing incomplete")
	}
	
	return result["hex"].(string), nil
}

// ValidateAddress checks if an address is valid
func (bc *BitcoinClient) ValidateAddress(ctx context.Context, address string) (bool, error) {
	var result map[string]interface{}
	err := bc.call(ctx, "validateaddress", []interface{}{address}, &result)
	if err != nil {
		return false, err
	}
	
	if isValid, ok := result["isvalid"].(bool); ok {
		return isValid, nil
	}
	
	return false, nil
}

// GetBalance returns the balance for an address
func (bc *BitcoinClient) GetBalance(ctx context.Context, address string) (*big.Int, error) {
	// For Bitcoin, we need to use listunspent and calculate balance
	// This is a simplified implementation
	var unspent []map[string]interface{}
	err := bc.call(ctx, "listunspent", []interface{}{1, 9999999, []string{address}}, &unspent)
	if err != nil {
		return nil, err
	}
	
	balance := big.NewInt(0)
	for _, utxo := range unspent {
		if amount, ok := utxo["amount"].(float64); ok {
			satoshis := int64(amount * float64(bc.currency.UnitsPerCoin.Int64()))
			balance.Add(balance, big.NewInt(satoshis))
		}
	}
	
	return balance, nil
}

// GetNewAddress generates a new address
func (bc *BitcoinClient) GetNewAddress(ctx context.Context, label string) (string, error) {
	var result string
	err := bc.call(ctx, "getnewaddress", []interface{}{label}, &result)
	if err != nil {
		return "", err
	}
	return result, nil
}

// GetBlockTemplate returns a block template for mining
func (bc *BitcoinClient) GetBlockTemplate(ctx context.Context) (*BlockTemplate, error) {
	params := map[string]interface{}{
		"capabilities": []string{"coinbasetxn", "workid", "coinbase/append"},
	}
	
	var result map[string]interface{}
	err := bc.call(ctx, "getblocktemplate", []interface{}{params}, &result)
	if err != nil {
		return nil, err
	}
	
	template := &BlockTemplate{
		Version:           int32(result["version"].(float64)),
		PreviousBlockHash: result["previousblockhash"].(string),
		Target:            result["target"].(string),
		Bits:              result["bits"].(string),
		Height:            int64(result["height"].(float64)),
		CurTime:           int64(result["curtime"].(float64)),
		MinTime:           int64(result["mintime"].(float64)),
	}
	
	if coinbaseValue, ok := result["coinbasevalue"].(float64); ok {
		template.CoinbaseValue = big.NewInt(int64(coinbaseValue))
	}
	
	if txs, ok := result["transactions"].([]interface{}); ok {
		for _, tx := range txs {
			if txMap, ok := tx.(map[string]interface{}); ok {
				if data, ok := txMap["data"].(string); ok {
					template.Transactions = append(template.Transactions, data)
				}
			}
		}
	}
	
	return template, nil
}

// SubmitBlock submits a mined block
func (bc *BitcoinClient) SubmitBlock(ctx context.Context, blockData string) error {
	var result interface{}
	err := bc.call(ctx, "submitblock", []interface{}{blockData}, &result)
	if err != nil {
		return err
	}
	
	// Check if result is nil (success) or error string
	if result != nil {
		if errStr, ok := result.(string); ok && errStr != "" {
			return fmt.Errorf("block submission failed: %s", errStr)
		}
	}
	
	return nil
}

// SendPayment sends payments to multiple addresses
func (bc *BitcoinClient) SendPayment(ctx context.Context, payments []Payment) (string, error) {
	// Convert payments to output format
	outputs := make(map[string]float64)
	for _, payment := range payments {
		// Convert satoshis to BTC
		btcAmount := new(big.Float).SetInt(payment.Amount)
		btcAmount.Quo(btcAmount, new(big.Float).SetInt(bc.currency.UnitsPerCoin))
		amount, _ := btcAmount.Float64()
		outputs[payment.Address] = amount
	}
	
	var result string
	err := bc.call(ctx, "sendmany", []interface{}{"", outputs}, &result)
	if err != nil {
		return "", err
	}
	
	return result, nil
}

// RPC helper methods

func (bc *BitcoinClient) call(ctx context.Context, method string, params interface{}, result interface{}) error {
	bc.requestMu.Lock()
	bc.requestID++
	requestID := bc.requestID
	bc.requestMu.Unlock()
	
	// Create request
	request := map[string]interface{}{
		"jsonrpc": "1.0",
		"id":      requestID,
		"method":  method,
		"params":  params,
	}
	
	if params == nil {
		request["params"] = []interface{}{}
	}
	
	// Marshal request
	requestBody, err := json.Marshal(request)
	if err != nil {
		return err
	}
	
	// Create HTTP request
	req, err := http.NewRequestWithContext(ctx, "POST", bc.rpcURL, bytes.NewReader(requestBody))
	if err != nil {
		return err
	}
	
	// Set headers
	req.Header.Set("Content-Type", "application/json")
	req.SetBasicAuth(bc.rpcUser, bc.rpcPass)
	
	// Send request
	resp, err := bc.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	
	// Read response
	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	
	// Parse response
	var response map[string]interface{}
	if err := json.Unmarshal(responseBody, &response); err != nil {
		return err
	}
	
	// Check for error
	if errorObj, ok := response["error"]; ok && errorObj != nil {
		errorMap := errorObj.(map[string]interface{})
		return fmt.Errorf("RPC error %v: %s", errorMap["code"], errorMap["message"])
	}
	
	// Extract result
	if result != nil && response["result"] != nil {
		resultBytes, err := json.Marshal(response["result"])
		if err != nil {
			return err
		}
		return json.Unmarshal(resultBytes, result)
	}
	
	return nil
}

// calculateBlockReward calculates the block reward for a given height
func (bc *BitcoinClient) calculateBlockReward(height int64) *big.Int {
	// Bitcoin halving schedule
	halvings := height / 210000
	if halvings >= 64 {
		return big.NewInt(0)
	}
	
	// Initial reward: 50 BTC
	reward := big.NewInt(50)
	reward.Mul(reward, bc.currency.UnitsPerCoin)
	
	// Apply halvings
	for i := int64(0); i < halvings; i++ {
		reward.Div(reward, big.NewInt(2))
	}
	
	return reward
}