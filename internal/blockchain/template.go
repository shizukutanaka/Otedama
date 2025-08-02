package blockchain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// BlockTemplate represents a mining block template
type BlockTemplate struct {
	Version           uint32                 `json:"version"`
	PreviousBlockHash string                 `json:"previousblockhash"`
	Transactions      []BlockTransaction     `json:"transactions"`
	CoinbaseValue     uint64                 `json:"coinbasevalue"`
	CoinbaseTxn       CoinbaseTransaction    `json:"coinbasetxn"`
	LongPollID        string                 `json:"longpollid"`
	Target            string                 `json:"target"`
	MinTime           uint64                 `json:"mintime"`
	Mutable           []string               `json:"mutable"`
	NonceRange        string                 `json:"noncerange"`
	SigOpLimit        int                    `json:"sigoplimit"`
	SizeLimit         int                    `json:"sizelimit"`
	WeightLimit       int                    `json:"weightlimit"`
	CurTime           uint64                 `json:"curtime"`
	Bits              string                 `json:"bits"`
	Height            uint64                 `json:"height"`
	Capabilities      []string               `json:"capabilities"`
	Rules             []string               `json:"rules"`
}

// BlockTransaction represents a transaction in the block template
type BlockTransaction struct {
	Data    string   `json:"data"`
	TxID    string   `json:"txid"`
	Hash    string   `json:"hash"`
	Depends []uint32 `json:"depends"`
	Fee     uint64   `json:"fee"`
	SigOps  int      `json:"sigops"`
	Weight  int      `json:"weight"`
}

// CoinbaseTransaction represents the coinbase transaction template
type CoinbaseTransaction struct {
	Data     string `json:"data"`
	TxID     string `json:"txid"`
	Hash     string `json:"hash"`
	Depends  []int  `json:"depends"`
	Fee      uint64 `json:"fee"`
	SigOps   int    `json:"sigops"`
	Weight   int    `json:"weight"`
	Required bool   `json:"required"`
}

// TemplateManager manages block template retrieval
type TemplateManager struct {
	logger      *zap.Logger
	nodeURL     string
	rpcUser     string
	rpcPassword string
	
	// Current template
	currentTemplate atomic.Value // *BlockTemplate
	lastUpdate      time.Time
	updateInterval  time.Duration
	
	// Long polling
	longPollClient *http.Client
	longPollCancel context.CancelFunc
	
	// Statistics
	templatesReceived atomic.Uint64
	templateErrors    atomic.Uint64
	
	// Callbacks
	onNewTemplate func(*BlockTemplate)
	
	mu sync.RWMutex
}

// TemplateConfig contains template manager configuration
type TemplateConfig struct {
	NodeURL          string        `yaml:"node_url"`
	RPCUser          string        `yaml:"rpc_user"`
	RPCPassword      string        `yaml:"rpc_password"`
	UpdateInterval   time.Duration `yaml:"update_interval"`
	LongPollTimeout  time.Duration `yaml:"longpoll_timeout"`
}

// NewTemplateManager creates a new template manager
func NewTemplateManager(logger *zap.Logger, config TemplateConfig) (*TemplateManager, error) {
	// Validate config
	if config.NodeURL == "" {
		return nil, fmt.Errorf("node URL is required")
	}
	
	// Set defaults
	if config.UpdateInterval <= 0 {
		config.UpdateInterval = 30 * time.Second
	}
	if config.LongPollTimeout <= 0 {
		config.LongPollTimeout = 5 * time.Minute
	}
	
	tm := &TemplateManager{
		logger:         logger,
		nodeURL:        config.NodeURL,
		rpcUser:        config.RPCUser,
		rpcPassword:    config.RPCPassword,
		updateInterval: config.UpdateInterval,
		longPollClient: &http.Client{
			Timeout: config.LongPollTimeout,
		},
	}
	
	return tm, nil
}

// Start starts the template manager
func (tm *TemplateManager) Start(ctx context.Context) error {
	// Get initial template
	if err := tm.updateTemplate(); err != nil {
		return fmt.Errorf("failed to get initial template: %w", err)
	}
	
	// Start update loop
	go tm.updateLoop(ctx)
	
	// Start long polling if supported
	if template := tm.GetCurrentTemplate(); template != nil && template.LongPollID != "" {
		go tm.longPollLoop(ctx)
	}
	
	tm.logger.Info("Block template manager started",
		zap.String("node_url", tm.nodeURL),
		zap.Duration("update_interval", tm.updateInterval),
	)
	
	return nil
}

// GetCurrentTemplate returns the current block template
func (tm *TemplateManager) GetCurrentTemplate() *BlockTemplate {
	template := tm.currentTemplate.Load()
	if template == nil {
		return nil
	}
	return template.(*BlockTemplate)
}

// GetTemplateAge returns the age of the current template
func (tm *TemplateManager) GetTemplateAge() time.Duration {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	
	return time.Since(tm.lastUpdate)
}

// SetOnNewTemplate sets the new template callback
func (tm *TemplateManager) SetOnNewTemplate(callback func(*BlockTemplate)) {
	tm.onNewTemplate = callback
}

// GetStatistics returns template manager statistics
func (tm *TemplateManager) GetStatistics() map[string]interface{} {
	template := tm.GetCurrentTemplate()
	
	stats := map[string]interface{}{
		"templates_received": tm.templatesReceived.Load(),
		"template_errors":    tm.templateErrors.Load(),
		"template_age_ms":    tm.GetTemplateAge().Milliseconds(),
	}
	
	if template != nil {
		stats["current_height"] = template.Height
		stats["tx_count"] = len(template.Transactions)
		stats["coinbase_value"] = template.CoinbaseValue
	}
	
	return stats
}

// Private methods

// updateLoop periodically updates the template
func (tm *TemplateManager) updateLoop(ctx context.Context) {
	ticker := time.NewTicker(tm.updateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := tm.updateTemplate(); err != nil {
				tm.logger.Error("Failed to update template",
					zap.Error(err),
				)
			}
		}
	}
}

// longPollLoop handles long polling for new templates
func (tm *TemplateManager) longPollLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
			template := tm.GetCurrentTemplate()
			if template == nil || template.LongPollID == "" {
				time.Sleep(5 * time.Second)
				continue
			}
			
			// Long poll for new template
			newTemplate, err := tm.longPollTemplate(ctx, template.LongPollID)
			if err != nil {
				tm.logger.Debug("Long poll error",
					zap.Error(err),
				)
				time.Sleep(5 * time.Second)
				continue
			}
			
			if newTemplate != nil {
				tm.processNewTemplate(newTemplate)
			}
		}
	}
}

// updateTemplate fetches a new template from the node
func (tm *TemplateManager) updateTemplate() error {
	// Create RPC request
	request := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "getblocktemplate",
		"params":  []interface{}{},
		"id":      1,
	}
	
	// Make request
	response, err := tm.makeRPCRequest(request)
	if err != nil {
		tm.templateErrors.Add(1)
		return err
	}
	
	// Parse template
	var template BlockTemplate
	if err := json.Unmarshal(response.Result, &template); err != nil {
		tm.templateErrors.Add(1)
		return fmt.Errorf("failed to parse template: %w", err)
	}
	
	tm.processNewTemplate(&template)
	return nil
}

// longPollTemplate performs long polling for a new template
func (tm *TemplateManager) longPollTemplate(ctx context.Context, longPollID string) (*BlockTemplate, error) {
	// Create RPC request with long poll ID
	request := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "getblocktemplate",
		"params": []interface{}{
			map[string]interface{}{
				"longpollid": longPollID,
			},
		},
		"id": 1,
	}
	
	// Make long poll request
	response, err := tm.makeLongPollRequest(ctx, request)
	if err != nil {
		return nil, err
	}
	
	// Parse template
	var template BlockTemplate
	if err := json.Unmarshal(response.Result, &template); err != nil {
		return nil, fmt.Errorf("failed to parse template: %w", err)
	}
	
	return &template, nil
}

// processNewTemplate processes a new block template
func (tm *TemplateManager) processNewTemplate(template *BlockTemplate) {
	// Check if template is actually new
	current := tm.GetCurrentTemplate()
	if current != nil && current.PreviousBlockHash == template.PreviousBlockHash {
		return // Same template
	}
	
	// Update template
	tm.currentTemplate.Store(template)
	tm.mu.Lock()
	tm.lastUpdate = time.Now()
	tm.mu.Unlock()
	
	tm.templatesReceived.Add(1)
	
	// Notify callback
	if tm.onNewTemplate != nil {
		tm.onNewTemplate(template)
	}
	
	tm.logger.Info("New block template received",
		zap.Uint64("height", template.Height),
		zap.String("prev_hash", template.PreviousBlockHash[:16]+"..."),
		zap.Int("tx_count", len(template.Transactions)),
		zap.Uint64("coinbase_value", template.CoinbaseValue),
	)
}

// makeRPCRequest makes an RPC request to the node
func (tm *TemplateManager) makeRPCRequest(request interface{}) (*RPCResponse, error) {
	// Serialize request
	data, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	
	// Create HTTP request
	req, err := http.NewRequest("POST", tm.nodeURL, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	
	req.Header.Set("Content-Type", "application/json")
	
	// Add authentication if configured
	if tm.rpcUser != "" && tm.rpcPassword != "" {
		req.SetBasicAuth(tm.rpcUser, tm.rpcPassword)
	}
	
	// Make request
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
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
	var rpcResp RPCResponse
	if err := json.Unmarshal(body, &rpcResp); err != nil {
		return nil, err
	}
	
	// Check for RPC error
	if rpcResp.Error != nil {
		return nil, fmt.Errorf("RPC error %d: %s", rpcResp.Error.Code, rpcResp.Error.Message)
	}
	
	return &rpcResp, nil
}

// makeLongPollRequest makes a long polling RPC request
func (tm *TemplateManager) makeLongPollRequest(ctx context.Context, request interface{}) (*RPCResponse, error) {
	// Serialize request
	data, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	
	// Create HTTP request with context
	req, err := http.NewRequestWithContext(ctx, "POST", tm.nodeURL, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	
	req.Header.Set("Content-Type", "application/json")
	
	// Add authentication if configured
	if tm.rpcUser != "" && tm.rpcPassword != "" {
		req.SetBasicAuth(tm.rpcUser, tm.rpcPassword)
	}
	
	// Make request with long poll client
	resp, err := tm.longPollClient.Do(req)
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
	var rpcResp RPCResponse
	if err := json.Unmarshal(body, &rpcResp); err != nil {
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

// TemplateProcessor processes block templates for mining
type TemplateProcessor struct {
	logger   *zap.Logger
	template *BlockTemplate
	address  string
	extraNonce uint32
	mu       sync.RWMutex
}

// NewTemplateProcessor creates a new template processor
func NewTemplateProcessor(logger *zap.Logger, address string) *TemplateProcessor {
	return &TemplateProcessor{
		logger:  logger,
		address: address,
	}
}

// ProcessTemplate processes a block template for mining
func (tp *TemplateProcessor) ProcessTemplate(template *BlockTemplate) (*MiningWork, error) {
	tp.mu.Lock()
	tp.template = template
	tp.extraNonce++
	extraNonce := tp.extraNonce
	tp.mu.Unlock()
	
	// Build coinbase transaction
	coinbaseTx, err := tp.buildCoinbaseTransaction(template, extraNonce)
	if err != nil {
		return nil, fmt.Errorf("failed to build coinbase: %w", err)
	}
	
	// Build merkle root
	merkleRoot := tp.calculateMerkleRoot(coinbaseTx, template.Transactions)
	
	// Create mining work
	work := &MiningWork{
		JobID:        fmt.Sprintf("%x", template.Height),
		PrevHash:     template.PreviousBlockHash,
		CoinbaseTx1:  coinbaseTx[:len(coinbaseTx)/2],
		CoinbaseTx2:  coinbaseTx[len(coinbaseTx)/2:],
		MerkleBranch: tp.getMerkleBranch(template.Transactions),
		Version:      template.Version,
		NBits:        template.Bits,
		NTime:        uint32(template.CurTime),
		CleanJobs:    true,
		ExtraNonce:   extraNonce,
		Target:       template.Target,
		Height:       template.Height,
	}
	
	return work, nil
}

// buildCoinbaseTransaction builds the coinbase transaction
func (tp *TemplateProcessor) buildCoinbaseTransaction(template *BlockTemplate, extraNonce uint32) ([]byte, error) {
	// This is a simplified version
	// In production, this would properly construct the coinbase transaction
	// with correct script, outputs, and witness data
	
	// For now, return template coinbase with extra nonce
	coinbaseData := make([]byte, len(template.CoinbaseTxn.Data))
	copy(coinbaseData, []byte(template.CoinbaseTxn.Data))
	
	// Add extra nonce (simplified)
	// In reality, this would be inserted at the correct position in the script
	
	return coinbaseData, nil
}

// calculateMerkleRoot calculates the merkle root
func (tp *TemplateProcessor) calculateMerkleRoot(coinbaseTx []byte, transactions []BlockTransaction) []byte {
	// Simplified merkle root calculation
	// In production, this would properly calculate the merkle tree
	
	hashes := make([][]byte, 0, len(transactions)+1)
	
	// Add coinbase transaction hash
	// hashes = append(hashes, doubleSHA256(coinbaseTx))
	
	// Add other transaction hashes
	for _, tx := range transactions {
		// hashes = append(hashes, hex.DecodeString(tx.Hash))
	}
	
	// Calculate merkle tree
	// ...
	
	// Return placeholder
	return make([]byte, 32)
}

// getMerkleBranch returns the merkle branch for the coinbase
func (tp *TemplateProcessor) getMerkleBranch(transactions []BlockTransaction) []string {
	// Simplified merkle branch calculation
	// In production, this would calculate the actual merkle branch
	
	branch := make([]string, 0)
	// Calculate merkle branch...
	
	return branch
}

// MiningWork represents work for miners
type MiningWork struct {
	JobID        string   `json:"job_id"`
	PrevHash     string   `json:"prev_hash"`
	CoinbaseTx1  []byte   `json:"coinbase_tx1"`
	CoinbaseTx2  []byte   `json:"coinbase_tx2"`
	MerkleBranch []string `json:"merkle_branch"`
	Version      uint32   `json:"version"`
	NBits        string   `json:"nbits"`
	NTime        uint32   `json:"ntime"`
	CleanJobs    bool     `json:"clean_jobs"`
	ExtraNonce   uint32   `json:"extra_nonce"`
	Target       string   `json:"target"`
	Height       uint64   `json:"height"`
}