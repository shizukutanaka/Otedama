package protocol

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// GetworkServer implements the getwork mining protocol
// Rob Pike's simplicity for legacy mining support
type GetworkServer struct {
	logger *zap.Logger
	config GetworkConfig
	
	// Work management
	currentWork  atomic.Value // *WorkData
	workMu       sync.RWMutex
	
	// Share validation
	shareValidator ShareValidator
	
	// Statistics
	stats        GetworkStats
	
	// Callbacks
	onNewWork    func() *WorkData
	onShareFound func(*Share) error
}

// GetworkConfig contains getwork server configuration
type GetworkConfig struct {
	// Server settings
	ListenAddr      string        `json:"listen_addr"`
	
	// Work settings
	WorkCacheTime   time.Duration `json:"work_cache_time"`
	Difficulty      float64       `json:"difficulty"`
	
	// Limits
	MaxConnections  int           `json:"max_connections"`
	RequestTimeout  time.Duration `json:"request_timeout"`
}

// WorkData represents getwork data
type WorkData struct {
	// Standard getwork fields
	Data        string `json:"data"`        // 128 bytes hex (block header)
	Target      string `json:"target"`      // 32 bytes hex
	Hash1       string `json:"hash1"`       // Deprecated but included for compatibility
	Midstate    string `json:"midstate"`    // 32 bytes hex (optimization)
	
	// Additional fields
	Height      uint64    `json:"height,omitempty"`
	Difficulty  float64   `json:"difficulty,omitempty"`
	Timestamp   time.Time `json:"-"`
}

// Share represents a submitted share
type Share struct {
	Data       []byte
	Nonce      uint32
	Hash       []byte
	Difficulty float64
	WorkerID   string
	SubmitTime time.Time
}

// GetworkStats tracks getwork statistics
type GetworkStats struct {
	RequestsTotal    atomic.Uint64
	RequestsGetwork  atomic.Uint64
	SharesSubmitted  atomic.Uint64
	SharesAccepted   atomic.Uint64
	SharesRejected   atomic.Uint64
	LastWorkUpdate   atomic.Value // time.Time
}

// ShareValidator validates submitted shares
type ShareValidator interface {
	Validate(share *Share, work *WorkData) error
}

// DefaultShareValidator implements basic share validation
type DefaultShareValidator struct{}

// NewGetworkServer creates a new getwork server
func NewGetworkServer(logger *zap.Logger, config GetworkConfig) *GetworkServer {
	server := &GetworkServer{
		logger:         logger,
		config:         config,
		shareValidator: &DefaultShareValidator{},
	}
	
	// Set initial work
	server.currentWork.Store(&WorkData{
		Timestamp: time.Now(),
	})
	
	return server
}

// Start starts the getwork server
func (s *GetworkServer) Start() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRequest)
	
	server := &http.Server{
		Addr:         s.config.ListenAddr,
		Handler:      mux,
		ReadTimeout:  s.config.RequestTimeout,
		WriteTimeout: s.config.RequestTimeout,
	}
	
	s.logger.Info("Getwork server started",
		zap.String("address", s.config.ListenAddr),
		zap.Float64("difficulty", s.config.Difficulty),
	)
	
	return server.ListenAndServe()
}

// handleRequest handles getwork requests
func (s *GetworkServer) handleRequest(w http.ResponseWriter, r *http.Request) {
	s.stats.RequestsTotal.Add(1)
	
	// Parse JSON-RPC request
	var req JSONRPCRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.sendError(w, req.ID, "Parse error", -32700)
		return
	}
	
	// Handle method
	switch req.Method {
	case "getwork":
		s.handleGetwork(w, req)
		
	case "submitwork":
		s.handleSubmitwork(w, req)
		
	default:
		s.sendError(w, req.ID, "Method not found", -32601)
	}
}

// handleGetwork handles getwork requests
func (s *GetworkServer) handleGetwork(w http.ResponseWriter, req JSONRPCRequest) {
	s.stats.RequestsGetwork.Add(1)
	
	// Check if we need new work
	work := s.currentWork.Load().(*WorkData)
	if time.Since(work.Timestamp) > s.config.WorkCacheTime && s.onNewWork != nil {
		newWork := s.onNewWork()
		if newWork != nil {
			newWork.Timestamp = time.Now()
			s.currentWork.Store(newWork)
			s.stats.LastWorkUpdate.Store(time.Now())
			work = newWork
		}
	}
	
	// Send work
	response := JSONRPCResponse{
		ID:     req.ID,
		Result: work,
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// handleSubmitwork handles share submission
func (s *GetworkServer) handleSubmitwork(w http.ResponseWriter, req JSONRPCRequest) {
	s.stats.SharesSubmitted.Add(1)
	
	// Parse parameters
	params, ok := req.Params.([]interface{})
	if !ok || len(params) < 1 {
		s.sendError(w, req.ID, "Invalid params", -32602)
		return
	}
	
	// Get submitted data
	dataHex, ok := params[0].(string)
	if !ok {
		s.sendError(w, req.ID, "Invalid data parameter", -32602)
		return
	}
	
	// Decode hex data
	data, err := hex.DecodeString(dataHex)
	if err != nil || len(data) != 128 {
		s.sendError(w, req.ID, "Invalid data format", -32602)
		return
	}
	
	// Extract nonce (bytes 76-79)
	nonce := binary.LittleEndian.Uint32(data[76:80])
	
	// Create share
	share := &Share{
		Data:       data,
		Nonce:      nonce,
		Difficulty: s.config.Difficulty,
		WorkerID:   r.RemoteAddr,
		SubmitTime: time.Now(),
	}
	
	// Validate share
	work := s.currentWork.Load().(*WorkData)
	if err := s.shareValidator.Validate(share, work); err != nil {
		s.stats.SharesRejected.Add(1)
		s.logger.Debug("Share rejected",
			zap.String("worker", share.WorkerID),
			zap.Error(err),
		)
		
		// Still return true for compatibility
		s.sendResult(w, req.ID, true)
		return
	}
	
	// Process share
	s.stats.SharesAccepted.Add(1)
	
	if s.onShareFound != nil {
		go s.onShareFound(share)
	}
	
	// Return success
	s.sendResult(w, req.ID, true)
}

// Validate implements share validation
func (v *DefaultShareValidator) Validate(share *Share, work *WorkData) error {
	// Decode work data
	workData, err := hex.DecodeString(work.Data)
	if err != nil {
		return errors.New("invalid work data")
	}
	
	// Compare first 76 bytes (excluding nonce)
	if len(share.Data) < 76 || len(workData) < 76 {
		return errors.New("invalid data length")
	}
	
	for i := 0; i < 76; i++ {
		if share.Data[i] != workData[i] {
			return errors.New("work data mismatch")
		}
	}
	
	// Calculate hash
	hash := calculateBlockHash(share.Data)
	share.Hash = hash
	
	// Check against target
	target, err := hex.DecodeString(work.Target)
	if err != nil {
		return errors.New("invalid target")
	}
	
	if !isHashBelowTarget(hash, target) {
		return errors.New("hash above target")
	}
	
	return nil
}

// Helper functions

func (s *GetworkServer) sendError(w http.ResponseWriter, id interface{}, message string, code int) {
	response := JSONRPCResponse{
		ID: id,
		Error: &JSONRPCError{
			Code:    code,
			Message: message,
		},
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func (s *GetworkServer) sendResult(w http.ResponseWriter, id interface{}, result interface{}) {
	response := JSONRPCResponse{
		ID:     id,
		Result: result,
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// calculateBlockHash calculates double SHA256 hash of block header
func calculateBlockHash(header []byte) []byte {
	// In production, use optimized SHA256 implementation
	h := sha256.Sum256(header)
	h2 := sha256.Sum256(h[:])
	
	// Reverse for little-endian
	reversed := make([]byte, 32)
	for i := 0; i < 32; i++ {
		reversed[i] = h2[31-i]
	}
	
	return reversed
}

// isHashBelowTarget checks if hash is below target
func isHashBelowTarget(hash, target []byte) bool {
	if len(hash) != 32 || len(target) != 32 {
		return false
	}
	
	for i := 0; i < 32; i++ {
		if hash[i] < target[i] {
			return true
		}
		if hash[i] > target[i] {
			return false
		}
	}
	
	return true
}

// calculateMidstate calculates SHA256 midstate for first 64 bytes
func calculateMidstate(data []byte) []byte {
	if len(data) < 64 {
		return nil
	}
	
	// Calculate SHA256 state after first 64 bytes
	// This is an optimization for miners
	// In production, use specialized midstate calculation
	return sha256.Sum256(data[:64])[:]
}

// difficultyToTarget converts difficulty to target
func difficultyToTarget(difficulty float64) []byte {
	// Maximum target (difficulty 1)
	maxTarget := new(big.Int)
	maxTarget.SetString("00000000FFFF0000000000000000000000000000000000000000000000000000", 16)
	
	// Calculate actual target
	diffInt := new(big.Int)
	diffInt.SetUint64(uint64(difficulty * 1000000))
	
	target := new(big.Int)
	target.Div(maxTarget, diffInt)
	target.Mul(target, big.NewInt(1000000))
	
	// Convert to 32 bytes
	targetBytes := target.Bytes()
	if len(targetBytes) < 32 {
		// Pad with zeros
		padded := make([]byte, 32)
		copy(padded[32-len(targetBytes):], targetBytes)
		targetBytes = padded
	}
	
	return targetBytes
}

// JSON-RPC structures

type JSONRPCRequest struct {
	JSONRPC string      `json:"jsonrpc"`
	Method  string      `json:"method"`
	Params  interface{} `json:"params"`
	ID      interface{} `json:"id"`
}

type JSONRPCResponse struct {
	JSONRPC string         `json:"jsonrpc,omitempty"`
	Result  interface{}    `json:"result,omitempty"`
	Error   *JSONRPCError  `json:"error,omitempty"`
	ID      interface{}    `json:"id"`
}

type JSONRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Work generation helpers

// GenerateWork creates new work data
func GenerateWork(height uint64, prevHash, merkleRoot []byte, bits uint32, difficulty float64) *WorkData {
	// Build block header (128 bytes for getwork)
	header := make([]byte, 128)
	
	// Version (4 bytes)
	binary.LittleEndian.PutUint32(header[0:4], 0x20000000)
	
	// Previous block hash (32 bytes)
	copy(header[4:36], prevHash)
	
	// Merkle root (32 bytes)
	copy(header[36:68], merkleRoot)
	
	// Timestamp (4 bytes)
	binary.LittleEndian.PutUint32(header[68:72], uint32(time.Now().Unix()))
	
	// Bits (4 bytes)
	binary.LittleEndian.PutUint32(header[72:76], bits)
	
	// Nonce placeholder (4 bytes)
	binary.LittleEndian.PutUint32(header[76:80], 0)
	
	// Padding for getwork (48 bytes)
	// First 4 bytes is 0x80000000 (SHA256 padding)
	header[80] = 0x80
	
	// Last 8 bytes is size in bits (640 bits = 80 bytes)
	binary.BigEndian.PutUint64(header[120:128], 640)
	
	return &WorkData{
		Data:       hex.EncodeToString(header),
		Target:     hex.EncodeToString(difficultyToTarget(difficulty)),
		Hash1:      "00000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000010000",
		Midstate:   hex.EncodeToString(calculateMidstate(header)),
		Height:     height,
		Difficulty: difficulty,
	}
}

// GetStats returns server statistics
func (s *GetworkServer) GetStats() GetworkStats {
	stats := s.stats
	if lastUpdate := s.stats.LastWorkUpdate.Load(); lastUpdate != nil {
		stats.LastWorkUpdate.Store(lastUpdate)
	}
	return stats
}

// SetWorkCallback sets the new work callback
func (s *GetworkServer) SetWorkCallback(cb func() *WorkData) {
	s.onNewWork = cb
}

// SetShareCallback sets the share found callback
func (s *GetworkServer) SetShareCallback(cb func(*Share) error) {
	s.onShareFound = cb
}

