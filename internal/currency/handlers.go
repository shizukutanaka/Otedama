package currency

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"
)

// BitcoinHandler handles Bitcoin operations
type BitcoinHandler struct {
	config  CurrencyConfig
	client  *http.Client
	nodeURL string
}

// NewBitcoinHandler creates a new Bitcoin handler
func NewBitcoinHandler(config CurrencyConfig) (CurrencyHandler, error) {
	return &BitcoinHandler{
		config:  config,
		client:  &http.Client{Timeout: 30 * time.Second},
		nodeURL: config.NodeURL,
	}, nil
}

// GetBalance returns BTC balance for an address
func (h *BitcoinHandler) GetBalance(address string) (*big.Int, error) {
	// Make RPC call to Bitcoin node
	resp, err := h.rpcCall("getaddressinfo", []interface{}{address})
	if err != nil {
		return nil, err
	}
	
	// Parse balance (in satoshis)
	balance := big.NewInt(0)
	if balanceFloat, ok := resp["balance"].(float64); ok {
		satoshis := int64(balanceFloat * 1e8)
		balance.SetInt64(satoshis)
	}
	
	return balance, nil
}

// GetTransaction returns transaction details
func (h *BitcoinHandler) GetTransaction(txHash string) (*Transaction, error) {
	resp, err := h.rpcCall("gettransaction", []interface{}{txHash})
	if err != nil {
		return nil, err
	}
	
	tx := &Transaction{
		Hash: txHash,
	}
	
	// Parse transaction details
	if confirmations, ok := resp["confirmations"].(float64); ok {
		tx.Confirmations = int(confirmations)
	}
	
	if confirmations := tx.Confirmations; confirmations > 0 {
		tx.Status = StatusConfirmed
	} else {
		tx.Status = StatusPending
	}
	
	return tx, nil
}

// SendTransaction sends a Bitcoin transaction
func (h *BitcoinHandler) SendTransaction(tx *Transaction) (string, error) {
	// Create raw transaction
	inputs := []map[string]interface{}{}
	outputs := map[string]float64{
		tx.To: float64(tx.Amount.Int64()) / 1e8,
	}
	
	// Create transaction
	rawTx, err := h.rpcCall("createrawtransaction", []interface{}{inputs, outputs})
	if err != nil {
		return "", err
	}
	
	// Sign transaction
	signedTx, err := h.rpcCall("signrawtransactionwithwallet", []interface{}{rawTx})
	if err != nil {
		return "", err
	}
	
	// Send transaction
	txHash, err := h.rpcCall("sendrawtransaction", []interface{}{signedTx["hex"]})
	if err != nil {
		return "", err
	}
	
	return txHash.(string), nil
}

// GetBlockHeight returns current block height
func (h *BitcoinHandler) GetBlockHeight() (uint64, error) {
	resp, err := h.rpcCall("getblockcount", []interface{}{})
	if err != nil {
		return 0, err
	}
	
	if height, ok := resp.(float64); ok {
		return uint64(height), nil
	}
	
	return 0, fmt.Errorf("invalid block height response")
}

// ValidateAddress validates a Bitcoin address
func (h *BitcoinHandler) ValidateAddress(address string) bool {
	resp, err := h.rpcCall("validateaddress", []interface{}{address})
	if err != nil {
		return false
	}
	
	if result, ok := resp.(map[string]interface{}); ok {
		if isValid, ok := result["isvalid"].(bool); ok {
			return isValid
		}
	}
	
	return false
}

// SubmitBlock submits a mined block
func (h *BitcoinHandler) SubmitBlock(block []byte) error {
	blockHex := hex.EncodeToString(block)
	_, err := h.rpcCall("submitblock", []interface{}{blockHex})
	return err
}

// GetWork returns mining work
func (h *BitcoinHandler) GetWork() ([]byte, error) {
	resp, err := h.rpcCall("getblocktemplate", []interface{}{})
	if err != nil {
		return nil, err
	}
	
	// Convert to work format
	// This is simplified - actual implementation would be more complex
	workData, _ := json.Marshal(resp)
	return workData, nil
}

// rpcCall makes an RPC call to Bitcoin node
func (h *BitcoinHandler) rpcCall(method string, params []interface{}) (interface{}, error) {
	payload := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  method,
		"params":  params,
	}
	
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	
	req, err := http.NewRequest("POST", h.nodeURL, strings.NewReader(string(data)))
	if err != nil {
		return nil, err
	}
	
	req.Header.Set("Content-Type", "application/json")
	
	resp, err := h.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	
	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	
	if errMsg, exists := result["error"]; exists && errMsg != nil {
		return nil, fmt.Errorf("RPC error: %v", errMsg)
	}
	
	return result["result"], nil
}

// EthereumHandler handles Ethereum operations
type EthereumHandler struct {
	config  CurrencyConfig
	client  *http.Client
	nodeURL string
}

// NewEthereumHandler creates a new Ethereum handler
func NewEthereumHandler(config CurrencyConfig) (CurrencyHandler, error) {
	return &EthereumHandler{
		config:  config,
		client:  &http.Client{Timeout: 30 * time.Second},
		nodeURL: config.NodeURL,
	}, nil
}

// GetBalance returns ETH balance for an address
func (h *EthereumHandler) GetBalance(address string) (*big.Int, error) {
	// Make JSON-RPC call
	resp, err := h.ethCall("eth_getBalance", []interface{}{address, "latest"})
	if err != nil {
		return nil, err
	}
	
	// Parse hex balance
	balanceHex, ok := resp.(string)
	if !ok {
		return nil, fmt.Errorf("invalid balance response")
	}
	
	balance := new(big.Int)
	balance.SetString(strings.TrimPrefix(balanceHex, "0x"), 16)
	
	return balance, nil
}

// GetTransaction returns transaction details
func (h *EthereumHandler) GetTransaction(txHash string) (*Transaction, error) {
	resp, err := h.ethCall("eth_getTransactionByHash", []interface{}{txHash})
	if err != nil {
		return nil, err
	}
	
	txData, ok := resp.(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("invalid transaction response")
	}
	
	tx := &Transaction{
		Hash: txHash,
	}
	
	// Get transaction receipt for confirmations
	receipt, err := h.ethCall("eth_getTransactionReceipt", []interface{}{txHash})
	if err == nil && receipt != nil {
		if receiptData, ok := receipt.(map[string]interface{}); ok {
			if blockNumber, ok := receiptData["blockNumber"].(string); ok {
				// Get current block
				currentBlock, _ := h.GetBlockHeight()
				blockNum := new(big.Int)
				blockNum.SetString(strings.TrimPrefix(blockNumber, "0x"), 16)
				
				tx.Confirmations = int(currentBlock - blockNum.Uint64())
				tx.Status = StatusConfirmed
			}
		}
	} else {
		tx.Status = StatusPending
	}
	
	// Parse other fields
	if from, ok := txData["from"].(string); ok {
		tx.From = from
	}
	if to, ok := txData["to"].(string); ok {
		tx.To = to
	}
	if value, ok := txData["value"].(string); ok {
		tx.Amount = new(big.Int)
		tx.Amount.SetString(strings.TrimPrefix(value, "0x"), 16)
	}
	
	return tx, nil
}

// SendTransaction sends an Ethereum transaction
func (h *EthereumHandler) SendTransaction(tx *Transaction) (string, error) {
	// Build transaction object
	txData := map[string]interface{}{
		"from":  h.config.WalletAddress,
		"to":    tx.To,
		"value": fmt.Sprintf("0x%x", tx.Amount),
		"gas":   "0x5208", // 21000 gas for simple transfer
	}
	
	// Get gas price
	gasPrice, err := h.ethCall("eth_gasPrice", []interface{}{})
	if err == nil {
		txData["gasPrice"] = gasPrice
	}
	
	// Send transaction
	txHash, err := h.ethCall("eth_sendTransaction", []interface{}{txData})
	if err != nil {
		return "", err
	}
	
	return txHash.(string), nil
}

// GetBlockHeight returns current block height
func (h *EthereumHandler) GetBlockHeight() (uint64, error) {
	resp, err := h.ethCall("eth_blockNumber", []interface{}{})
	if err != nil {
		return 0, err
	}
	
	blockHex, ok := resp.(string)
	if !ok {
		return 0, fmt.Errorf("invalid block number response")
	}
	
	blockNum := new(big.Int)
	blockNum.SetString(strings.TrimPrefix(blockHex, "0x"), 16)
	
	return blockNum.Uint64(), nil
}

// ValidateAddress validates an Ethereum address
func (h *EthereumHandler) ValidateAddress(address string) bool {
	// Basic validation
	if !strings.HasPrefix(address, "0x") {
		return false
	}
	
	if len(address) != 42 {
		return false
	}
	
	// Check if valid hex
	_, err := hex.DecodeString(address[2:])
	return err == nil
}

// SubmitBlock is not applicable for Ethereum
func (h *EthereumHandler) SubmitBlock(block []byte) error {
	return fmt.Errorf("block submission not supported for Ethereum")
}

// GetWork returns mining work for Ethereum
func (h *EthereumHandler) GetWork() ([]byte, error) {
	resp, err := h.ethCall("eth_getWork", []interface{}{})
	if err != nil {
		return nil, err
	}
	
	// Convert work array to bytes
	workData, _ := json.Marshal(resp)
	return workData, nil
}

// ethCall makes an Ethereum JSON-RPC call
func (h *EthereumHandler) ethCall(method string, params []interface{}) (interface{}, error) {
	payload := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  method,
		"params":  params,
	}
	
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	
	req, err := http.NewRequest("POST", h.nodeURL, strings.NewReader(string(data)))
	if err != nil {
		return nil, err
	}
	
	req.Header.Set("Content-Type", "application/json")
	
	resp, err := h.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	
	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	
	if errMsg, exists := result["error"]; exists && errMsg != nil {
		return nil, fmt.Errorf("RPC error: %v", errMsg)
	}
	
	return result["result"], nil
}

// LitecoinHandler handles Litecoin operations
type LitecoinHandler struct {
	*BitcoinHandler
}

// NewLitecoinHandler creates a new Litecoin handler
func NewLitecoinHandler(config CurrencyConfig) (CurrencyHandler, error) {
	btcHandler, err := NewBitcoinHandler(config)
	if err != nil {
		return nil, err
	}
	
	return &LitecoinHandler{
		BitcoinHandler: btcHandler.(*BitcoinHandler),
	}, nil
}

// GenericHandler handles generic cryptocurrency operations
type GenericHandler struct {
	config CurrencyConfig
}

// NewGenericHandler creates a new generic handler
func NewGenericHandler(config CurrencyConfig) (CurrencyHandler, error) {
	return &GenericHandler{
		config: config,
	}, nil
}

// GetBalance returns balance (not implemented)
func (h *GenericHandler) GetBalance(address string) (*big.Int, error) {
	return big.NewInt(0), fmt.Errorf("not implemented for %s", h.config.Symbol)
}

// GetTransaction returns transaction (not implemented)
func (h *GenericHandler) GetTransaction(txHash string) (*Transaction, error) {
	return nil, fmt.Errorf("not implemented for %s", h.config.Symbol)
}

// SendTransaction sends transaction (not implemented)
func (h *GenericHandler) SendTransaction(tx *Transaction) (string, error) {
	return "", fmt.Errorf("not implemented for %s", h.config.Symbol)
}

// GetBlockHeight returns block height (not implemented)
func (h *GenericHandler) GetBlockHeight() (uint64, error) {
	return 0, fmt.Errorf("not implemented for %s", h.config.Symbol)
}

// ValidateAddress validates address (basic check)
func (h *GenericHandler) ValidateAddress(address string) bool {
	return len(address) > 0
}

// SubmitBlock submits block (not implemented)
func (h *GenericHandler) SubmitBlock(block []byte) error {
	return fmt.Errorf("not implemented for %s", h.config.Symbol)
}

// GetWork returns work (not implemented)
func (h *GenericHandler) GetWork() ([]byte, error) {
	return nil, fmt.Errorf("not implemented for %s", h.config.Symbol)
}