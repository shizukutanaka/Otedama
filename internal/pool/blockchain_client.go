package pool

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// BitcoinClient implements BlockchainClient for Bitcoin
type BitcoinClient struct {
	rpcURL      string
	rpcUser     string
	rpcPassword string
	httpClient  *http.Client
	chainID     string
}

// NewBitcoinClient creates a new Bitcoin blockchain client
func NewBitcoinClient(rpcURL, rpcUser, rpcPassword string) *BitcoinClient {
	return &BitcoinClient{
		rpcURL:      rpcURL,
		rpcUser:     rpcUser,
		rpcPassword: rpcPassword,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		chainID: "bitcoin",
	}
}

// SubmitBlock submits a block to the Bitcoin network
func (bc *BitcoinClient) SubmitBlock(blockData []byte) (string, error) {
	// Convert block data to hex string
	blockHex := hex.EncodeToString(blockData)
	
	// Submit via RPC
	resp, err := bc.rpcCall("submitblock", []interface{}{blockHex})
	if err != nil {
		return "", err
	}
	
	// Check if submission was successful
	if resp != nil {
		// Non-nil response indicates an error
		return "", fmt.Errorf("block rejected: %v", resp)
	}
	
	// Calculate block hash from block data
	blockHash := bc.calculateBlockHash(blockData)
	
	return blockHash, nil
}

// GetBlockInfo retrieves information about a block
func (bc *BitcoinClient) GetBlockInfo(blockHash string) (*BlockInfo, error) {
	// Get block data
	resp, err := bc.rpcCall("getblock", []interface{}{blockHash, 1})
	if err != nil {
		return nil, err
	}
	
	blockData, ok := resp.(map[string]interface{})
	if !ok {
		return nil, errors.New("invalid block data response")
	}
	
	// Parse block info
	info := &BlockInfo{
		Hash:   blockHash,
		Miner:  bc.extractMinerAddress(blockData),
	}
	
	// Extract fields
	if height, ok := blockData["height"].(float64); ok {
		info.Height = int64(height)
	}
	
	if confirmations, ok := blockData["confirmations"].(float64); ok {
		info.Confirmations = int(confirmations)
	}
	
	if timestamp, ok := blockData["time"].(float64); ok {
		info.Timestamp = time.Unix(int64(timestamp), 0)
	}
	
	if previousHash, ok := blockData["previousblockhash"].(string); ok {
		info.PreviousHash = previousHash
	}
	
	// Get block reward (coinbase value)
	if tx, ok := blockData["tx"].([]interface{}); ok && len(tx) > 0 {
		if coinbaseTx, ok := tx[0].(string); ok {
			info.Reward = bc.getCoinbaseValue(coinbaseTx)
		}
	}
	
	return info, nil
}

// GetBlockHeight returns the current blockchain height
func (bc *BitcoinClient) GetBlockHeight() (int64, error) {
	resp, err := bc.rpcCall("getblockcount", []interface{}{})
	if err != nil {
		return 0, err
	}
	
	height, ok := resp.(float64)
	if !ok {
		return 0, errors.New("invalid block height response")
	}
	
	return int64(height), nil
}

// GetBlockByHeight retrieves a block by its height
func (bc *BitcoinClient) GetBlockByHeight(height int64) (*BlockInfo, error) {
	// Get block hash at height
	resp, err := bc.rpcCall("getblockhash", []interface{}{height})
	if err != nil {
		return nil, err
	}
	
	blockHash, ok := resp.(string)
	if !ok {
		return nil, errors.New("invalid block hash response")
	}
	
	// Get block info
	return bc.GetBlockInfo(blockHash)
}

// Private methods

func (bc *BitcoinClient) rpcCall(method string, params []interface{}) (interface{}, error) {
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
	req, err := http.NewRequest("POST", bc.rpcURL, bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	
	req.SetBasicAuth(bc.rpcUser, bc.rpcPassword)
	req.Header.Set("Content-Type", "application/json")
	
	resp, err := bc.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	// Read response
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	
	// Parse response
	var result map[string]interface{}
	err = json.Unmarshal(body, &result)
	if err != nil {
		return nil, err
	}
	
	// Check for error
	if errObj, exists := result["error"]; exists && errObj != nil {
		return nil, fmt.Errorf("RPC error: %v", errObj)
	}
	
	return result["result"], nil
}

func (bc *BitcoinClient) calculateBlockHash(blockData []byte) string {
	// This is simplified - actual implementation would need to:
	// 1. Extract block header (first 80 bytes)
	// 2. Apply double SHA256
	// 3. Reverse byte order
	
	// For now, return a placeholder
	return hex.EncodeToString(blockData[:32])
}

func (bc *BitcoinClient) extractMinerAddress(blockData map[string]interface{}) string {
	// Extract miner address from coinbase transaction
	// This is simplified - actual implementation would parse coinbase outputs
	return "pool-address"
}

func (bc *BitcoinClient) getCoinbaseValue(txID string) float64 {
	// Get transaction details
	resp, err := bc.rpcCall("getrawtransaction", []interface{}{txID, 1})
	if err != nil {
		return 0
	}
	
	txData, ok := resp.(map[string]interface{})
	if !ok {
		return 0
	}
	
	// Sum outputs (simplified)
	totalValue := float64(0)
	if vout, ok := txData["vout"].([]interface{}); ok {
		for _, output := range vout {
			if out, ok := output.(map[string]interface{}); ok {
				if value, ok := out["value"].(float64); ok {
					totalValue += value
				}
			}
		}
	}
	
	return totalValue
}

// EthereumClient implements BlockchainClient for Ethereum
type EthereumClient struct {
	rpcURL     string
	httpClient *http.Client
	chainID    string
}

// NewEthereumClient creates a new Ethereum blockchain client
func NewEthereumClient(rpcURL string) *EthereumClient {
	return &EthereumClient{
		rpcURL: rpcURL,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		chainID: "ethereum",
	}
}

// SubmitBlock submits a block to the Ethereum network
func (ec *EthereumClient) SubmitBlock(blockData []byte) (string, error) {
	// Convert to RLP encoded block
	blockHex := "0x" + hex.EncodeToString(blockData)
	
	// Submit via eth_submitWork
	resp, err := ec.rpcCall("eth_submitWork", []interface{}{blockHex})
	if err != nil {
		return "", err
	}
	
	success, ok := resp.(bool)
	if !ok || !success {
		return "", errors.New("block submission failed")
	}
	
	// Calculate block hash
	blockHash := ec.calculateBlockHash(blockData)
	
	return blockHash, nil
}

// GetBlockInfo retrieves information about a block
func (ec *EthereumClient) GetBlockInfo(blockHash string) (*BlockInfo, error) {
	// Ensure hash has 0x prefix
	if blockHash[:2] != "0x" {
		blockHash = "0x" + blockHash
	}
	
	resp, err := ec.rpcCall("eth_getBlockByHash", []interface{}{blockHash, true})
	if err != nil {
		return nil, err
	}
	
	blockData, ok := resp.(map[string]interface{})
	if !ok {
		return nil, errors.New("invalid block data response")
	}
	
	info := &BlockInfo{
		Hash: blockHash,
	}
	
	// Extract fields
	if number, ok := blockData["number"].(string); ok {
		info.Height = ec.hexToInt64(number)
	}
	
	if timestamp, ok := blockData["timestamp"].(string); ok {
		info.Timestamp = time.Unix(ec.hexToInt64(timestamp), 0)
	}
	
	if parentHash, ok := blockData["parentHash"].(string); ok {
		info.PreviousHash = parentHash
	}
	
	if miner, ok := blockData["miner"].(string); ok {
		info.Miner = miner
	}
	
	// Calculate confirmations
	currentHeight, _ := ec.GetBlockHeight()
	info.Confirmations = int(currentHeight - info.Height + 1)
	
	// Calculate block reward (simplified - actual would include uncle rewards)
	info.Reward = 2.0 // Base reward, varies by fork
	
	return info, nil
}

// GetBlockHeight returns the current blockchain height
func (ec *EthereumClient) GetBlockHeight() (int64, error) {
	resp, err := ec.rpcCall("eth_blockNumber", []interface{}{})
	if err != nil {
		return 0, err
	}
	
	heightHex, ok := resp.(string)
	if !ok {
		return 0, errors.New("invalid block height response")
	}
	
	return ec.hexToInt64(heightHex), nil
}

// GetBlockByHeight retrieves a block by its height
func (ec *EthereumClient) GetBlockByHeight(height int64) (*BlockInfo, error) {
	heightHex := fmt.Sprintf("0x%x", height)
	
	resp, err := ec.rpcCall("eth_getBlockByNumber", []interface{}{heightHex, true})
	if err != nil {
		return nil, err
	}
	
	blockData, ok := resp.(map[string]interface{})
	if !ok {
		return nil, errors.New("invalid block data response")
	}
	
	hash, _ := blockData["hash"].(string)
	
	return ec.GetBlockInfo(hash)
}

// Private methods

func (ec *EthereumClient) rpcCall(method string, params []interface{}) (interface{}, error) {
	// Build JSON-RPC request
	reqData := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
		"id":      1,
	}
	
	reqBody, err := json.Marshal(reqData)
	if err != nil {
		return nil, err
	}
	
	// Make HTTP request
	resp, err := http.Post(ec.rpcURL, "application/json", bytes.NewReader(reqBody))
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
	
	// Check for error
	if errObj, exists := result["error"]; exists && errObj != nil {
		return nil, fmt.Errorf("RPC error: %v", errObj)
	}
	
	return result["result"], nil
}

func (ec *EthereumClient) calculateBlockHash(blockData []byte) string {
	// Simplified - actual would use Keccak256 on RLP encoded header
	return "0x" + hex.EncodeToString(blockData[:32])
}

func (ec *EthereumClient) hexToInt64(hexStr string) int64 {
	// Remove 0x prefix
	if len(hexStr) > 2 && hexStr[:2] == "0x" {
		hexStr = hexStr[2:]
	}
	
	// Parse hex string
	var result int64
	fmt.Sscanf(hexStr, "%x", &result)
	
	return result
}