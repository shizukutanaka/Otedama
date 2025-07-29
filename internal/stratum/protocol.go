package stratum

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/otedama/otedama/internal/config"
	"github.com/otedama/otedama/internal/mining"
)

// Message Stratumプロトコルメッセージ
type Message struct {
	ID     interface{}            `json:"id"`
	Method string                 `json:"method,omitempty"`
	Params []interface{}          `json:"params,omitempty"`
	Result interface{}            `json:"result,omitempty"`
	Error  *Error                 `json:"error,omitempty"`
}

// Error Stratumエラー
type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Client Stratumクライアント
type Client struct {
	conn         net.Conn
	reader       *bufio.Reader
	writer       *bufio.Writer
	mu           sync.Mutex
	workerName   string
	extraNonce1  string
	difficulty   float64
	authorized   bool
	submittedShares atomic.Uint64
	acceptedShares  atomic.Uint64
	rejectedShares  atomic.Uint64
	lastActivity time.Time
}

// Server Stratumサーバー
type Server struct {
	listener     net.Listener
	clients      sync.Map
	jobManager   *JobManager
	diffAdjuster *DifficultyAdjuster
	mu           sync.RWMutex
	running      atomic.Bool
	config       Config
	clientCount  atomic.Int32
	jobsSent     atomic.Uint64
}

// Config Stratum設定
type Config struct {
	ListenAddr       string
	MaxClients       int
	Difficulty       float64
	ShareDifficulty  float64
	Algorithm        string
	VarDiff          bool
	MinDiff          float64
	MaxDiff          float64
	TargetTime       int // 秒
	
	// Authentication (using config.StratumConfig for full auth support)
	StratumConfig    config.StratumConfig
}

// Job マイニングジョブ
type Job struct {
	ID             string
	PrevHash       string
	CoinbaseValue  uint64
	CoinbaseHash   string
	MerkleBranches []string
	Version        string
	NBits          string
	NTime          string
	Difficulty     uint32
	CleanJobs      bool
}

// JobManager ジョブ管理
type JobManager struct {
	currentJob   *Job
	mu           sync.RWMutex
	jobCounter   atomic.Uint64
	extraNonce1  atomic.Uint32
}

// NewServer 新しいStratumサーバーを作成
func NewServer(config Config) *Server {
	// 難易度調整設定
	diffConfig := DefaultDifficultyConfig()
	diffConfig.MinDiff = config.MinDiff
	diffConfig.MaxDiff = config.MaxDiff
	diffConfig.TargetTime = float64(config.TargetTime)
	diffConfig.EnableVarDiff = config.VarDiff
	
	return &Server{
		config:       config,
		jobManager:   NewJobManager(),
		diffAdjuster: NewDifficultyAdjuster(diffConfig),
	}
}

// NewJobManager 新しいジョブマネージャーを作成
func NewJobManager() *JobManager {
	return &JobManager{}
}

// Start サーバーを開始
func (s *Server) Start(ctx context.Context) error {
	listener, err := net.Listen("tcp", s.config.ListenAddr)
	if err != nil {
		return fmt.Errorf("failed to listen: %w", err)
	}
	
	s.listener = listener
	s.running.Store(true)
	
	go s.acceptLoop(ctx)
	go s.broadcastJobs(ctx)
	
	return nil
}

// Stop サーバーを停止
func (s *Server) Stop() error {
	s.running.Store(false)
	if s.listener != nil {
		return s.listener.Close()
	}
	return nil
}

// acceptLoop 接続受付ループ
func (s *Server) acceptLoop(ctx context.Context) {
	for s.running.Load() {
		conn, err := s.listener.Accept()
		if err != nil {
			if s.running.Load() {
				continue
			}
			return
		}
		
		if s.clientCount.Load() >= int32(s.config.MaxClients) {
			conn.Close()
			continue
		}
		
		client := &Client{
			conn:       conn,
			reader:     bufio.NewReader(conn),
			writer:     bufio.NewWriter(conn),
			difficulty: s.config.Difficulty,
			lastActivity: time.Now(),
		}
		
		s.clientCount.Add(1)
		go s.handleClient(ctx, client)
	}
}

// handleClient クライアント処理
func (s *Server) handleClient(ctx context.Context, client *Client) {
	defer func() {
		client.conn.Close()
		s.clients.Delete(client.workerName)
		s.clientCount.Add(-1)
	}()
	
	// タイムアウト設定
	client.conn.SetReadDeadline(time.Now().Add(5 * time.Minute))
	
	for {
		select {
		case <-ctx.Done():
			return
		default:
			line, err := client.reader.ReadString('\n')
			if err != nil {
				return
			}
			
			var msg Message
			if err := json.Unmarshal([]byte(line), &msg); err != nil {
				continue
			}
			
			client.lastActivity = time.Now()
			client.conn.SetReadDeadline(time.Now().Add(5 * time.Minute))
			
			s.handleMessage(client, &msg)
		}
	}
}

// handleMessage メッセージ処理
func (s *Server) handleMessage(client *Client, msg *Message) {
	switch msg.Method {
	case "mining.subscribe":
		s.handleSubscribe(client, msg)
	case "mining.authorize":
		s.handleAuthorize(client, msg)
	case "mining.submit":
		s.handleSubmit(client, msg)
	case "mining.get_transactions":
		s.handleGetTransactions(client, msg)
	default:
		s.sendError(client, msg.ID, -3, "Method not found")
	}
}

// handleSubscribe サブスクライブ処理
func (s *Server) handleSubscribe(client *Client, msg *Message) {
	// Extra nonce1を生成
	extraNonce1 := fmt.Sprintf("%08x", s.jobManager.extraNonce1.Add(1))
	client.extraNonce1 = extraNonce1
	
	result := []interface{}{
		[][]string{
			{"mining.set_difficulty", "1"},
			{"mining.notify", "1"},
		},
		extraNonce1,
		4, // Extra nonce2 size
	}
	
	s.sendResult(client, msg.ID, result)
	
	// 初期難易度を送信
	s.sendDifficulty(client, client.difficulty)
	
	// 現在のジョブを送信
	if job := s.jobManager.GetCurrentJob(); job != nil {
		s.sendJob(client, job)
	}
}

// handleAuthorize 認証処理
func (s *Server) handleAuthorize(client *Client, msg *Message) {
	if len(msg.Params) < 2 {
		s.sendError(client, msg.ID, -1, "Invalid parameters")
		return
	}
	
	workerName, ok := msg.Params[0].(string)
	if !ok {
		s.sendError(client, msg.ID, -1, "Invalid worker name")
		return
	}
	
	password, ok := msg.Params[1].(string)
	if !ok {
		s.sendError(client, msg.ID, -1, "Invalid password")
		return
	}
	
	// Password validation
	if !s.validatePassword(workerName, password) {
		s.sendError(client, msg.ID, -1, "Authentication failed")
		return
	}
	
	client.workerName = workerName
	client.authorized = true
	s.clients.Store(workerName, client)
	
	s.sendResult(client, msg.ID, true)
}

// handleSubmit シェア提出処理
func (s *Server) handleSubmit(client *Client, msg *Message) {
	if !client.authorized {
		s.sendError(client, msg.ID, -1, "Unauthorized")
		return
	}
	
	if len(msg.Params) < 5 {
		s.sendError(client, msg.ID, -1, "Invalid parameters")
		return
	}
	
	client.submittedShares.Add(1)
	
	// シェア検証
	// TODO: 実際の検証ロジックを実装
	valid := s.validateShare(client, msg.Params)
	
	if valid {
		client.acceptedShares.Add(1)
		s.sendResult(client, msg.ID, true)
		
		// 可変難易度調整
		if s.config.VarDiff {
			s.adjustDifficulty(client)
		}
	} else {
		client.rejectedShares.Add(1)
		s.sendError(client, msg.ID, 23, "Low difficulty share")
	}
}

// handleGetTransactions トランザクション取得処理
func (s *Server) handleGetTransactions(client *Client, msg *Message) {
	// トランザクションリストを返す
	s.sendResult(client, msg.ID, []string{})
}

// sendResult 結果送信
func (s *Server) sendResult(client *Client, id interface{}, result interface{}) {
	msg := Message{
		ID:     id,
		Result: result,
	}
	s.sendMessage(client, &msg)
}

// sendError エラー送信
func (s *Server) sendError(client *Client, id interface{}, code int, message string) {
	msg := Message{
		ID: id,
		Error: &Error{
			Code:    code,
			Message: message,
		},
	}
	s.sendMessage(client, &msg)
}

// sendMessage メッセージ送信
func (s *Server) sendMessage(client *Client, msg *Message) {
	client.mu.Lock()
	defer client.mu.Unlock()
	
	data, _ := json.Marshal(msg)
	client.writer.Write(data)
	client.writer.WriteByte('\n')
	client.writer.Flush()
}

// sendDifficulty 難易度送信
func (s *Server) sendDifficulty(client *Client, difficulty float64) {
	msg := Message{
		Method: "mining.set_difficulty",
		Params: []interface{}{difficulty},
	}
	s.sendMessage(client, &msg)
}

// sendJob ジョブ送信
func (s *Server) sendJob(client *Client, job *Job) {
	msg := Message{
		Method: "mining.notify",
		Params: []interface{}{
			job.ID,
			job.PrevHash,
			job.CoinbaseHash,
			job.MerkleBranches,
			job.Version,
			job.NBits,
			job.NTime,
			job.CleanJobs,
		},
	}
	s.sendMessage(client, &msg)
	s.jobsSent.Add(1)
}

// broadcastJobs ジョブブロードキャスト
func (s *Server) broadcastJobs(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			job := s.jobManager.CreateNewJob()
			s.clients.Range(func(key, value interface{}) bool {
				if client, ok := value.(*Client); ok && client.authorized {
					s.sendJob(client, job)
				}
				return true
			})
		}
	}
}

// validateShare シェア検証
func (s *Server) validateShare(client *Client, params []interface{}) bool {
	if len(params) < 5 {
		return false
	}
	
	// Stratum submit parameters: [username, job_id, extranonce2, ntime, nonce]
	jobID, ok := params[1].(string)
	if !ok {
		return false
	}
	
	extranonce2Hex, ok := params[2].(string)
	if !ok {
		return false
	}
	
	ntimeHex, ok := params[3].(string)
	if !ok {
		return false
	}
	
	nonceHex, ok := params[4].(string)
	if !ok {
		return false
	}
	
	// Get job from manager
	job := s.jobManager.GetJob(jobID)
	if job == nil {
		return false
	}
	
	// Parse hex values
	extranonce2, err := hex.DecodeString(extranonce2Hex)
	if err != nil {
		return false
	}
	
	ntime, err := hex.DecodeString(ntimeHex)
	if err != nil || len(ntime) != 4 {
		return false
	}
	
	nonceBytes, err := hex.DecodeString(nonceHex)
	if err != nil || len(nonceBytes) != 4 {
		return false
	}
	
	nonce := binary.LittleEndian.Uint32(nonceBytes)
	
	// Build header for hashing
	header := make([]byte, 80)
	copy(header, job.Header)
	
	// Set ntime and nonce in header
	copy(header[68:72], ntime)    // ntime at offset 68
	copy(header[76:80], nonceBytes) // nonce at offset 76
	
	// Add extranonce2 to coinbase transaction (simplified)
	coinbaseData := append(job.Coinbase1, extranonce2...)
	coinbaseData = append(coinbaseData, job.Coinbase2...)
	
	// Create hash function based on algorithm
	var hashFunc mining.HashFunction
	switch s.config.Algorithm {
	case "sha256":
		hashFunc = &mining.SHA256Hash{}
	case "scrypt":
		hashFunc = &mining.ScryptHash{}
	case "ethash":
		hashFunc = &mining.EthashHash{}
	default:
		hashFunc = &mining.SHA256Hash{}
	}
	
	// Calculate hash
	hash := hashFunc.Hash(header, uint64(nonce))
	
	// Convert hash to big.Int for difficulty comparison
	hashInt := new(big.Int).SetBytes(reverseBytes(hash))
	
	// Calculate target from difficulty
	// Target = max_target / difficulty
	maxTarget := new(big.Int)
	maxTarget.SetString("00000000FFFF0000000000000000000000000000000000000000000000000000", 16)
	
	target := new(big.Int).Div(maxTarget, big.NewInt(int64(client.difficulty)))
	
	// Validate against client difficulty
	if hashInt.Cmp(target) > 0 {
		return false
	}
	
	// Check if it meets pool difficulty (usually higher)
	poolTarget := new(big.Int).Div(maxTarget, big.NewInt(int64(s.config.ShareDifficulty)))
	isValidBlock := hashInt.Cmp(poolTarget) <= 0
	
	if isValidBlock {
		// Potential block found - forward to pool
		s.handleBlockFound(client, job, hash, nonce)
	}
	
	return true
}

// reverseBytes reverses byte slice (Bitcoin uses little-endian)
func reverseBytes(data []byte) []byte {
	result := make([]byte, len(data))
	for i, b := range data {
		result[len(data)-1-i] = b
	}
	return result
}

// handleBlockFound handles potential block discovery
func (s *Server) handleBlockFound(client *Client, job *mining.MiningJob, hash []byte, nonce uint32) {
	// Log block discovery
	fmt.Printf("Potential block found by %s: %x\n", client.workerName, hash)
	
	// In a real implementation, this would:
	// 1. Validate the block against network rules
	// 2. Submit to the blockchain network
	// 3. Update pool statistics
	// 4. Calculate rewards
}

// adjustDifficulty 難易度調整
func (s *Server) adjustDifficulty(client *Client) {
	// ワーカー統計を構築
	workerStats := &WorkerStats{
		LastShareTime:   client.lastActivity,
		ShareCount:      client.submittedShares.Load(),
		CurrentDiff:     client.difficulty,
		ShareTimes:      s.getRecentShareTimes(client),
	}
	
	// 高度な難易度調整アルゴリズムを使用
	newDiff := s.diffAdjuster.AdjustDifficulty(workerStats)
	
	// 難易度が変更された場合のみ送信
	if math.Abs(newDiff-client.difficulty) > 0.01 {
		client.difficulty = newDiff
		s.sendDifficulty(client, client.difficulty)
	}
}

// getRecentShareTimes は最近のシェア時間を取得（簡易実装）
func (s *Server) getRecentShareTimes(client *Client) []time.Duration {
	// TODO: 実際のシェア時間履歴を実装
	// ここでは簡易的に固定値を返す
	return []time.Duration{
		10 * time.Second,
		12 * time.Second,
		8 * time.Second,
		11 * time.Second,
		9 * time.Second,
	}
}

// GetCurrentJob 現在のジョブを取得
func (jm *JobManager) GetCurrentJob() *Job {
	jm.mu.RLock()
	defer jm.mu.RUnlock()
	return jm.currentJob
}

// GetJob IDでジョブを取得
func (jm *JobManager) GetJob(jobID string) *mining.MiningJob {
	jm.mu.RLock()
	defer jm.mu.RUnlock()
	
	// 簡易実装 - 実際はジョブマップを維持する
	if jm.currentJob != nil && jm.currentJob.ID == jobID {
		// StratumのJobをMiningJobに変換
		return &mining.MiningJob{
			ID:         jm.currentJob.ID,
			Header:     make([]byte, 80), // ヘッダーを構築
			Target:     make([]byte, 32), // ターゲットを設定
			Coinbase1:  []byte(jm.currentJob.CoinbaseHash[:32]),
			Coinbase2:  []byte(jm.currentJob.CoinbaseHash[32:]),
			Difficulty: jm.currentJob.Difficulty,
			StartNonce: 0,
			EndNonce:   0xffffffff,
		}
	}
	return nil
}

// CreateNewJob 新しいジョブを作成
func (jm *JobManager) CreateNewJob() *Job {
	jm.mu.Lock()
	defer jm.mu.Unlock()
	
	jobID := fmt.Sprintf("%x", jm.jobCounter.Add(1))
	
	job := &Job{
		ID:             jobID,
		PrevHash:       fmt.Sprintf("%064x", time.Now().Unix()),
		CoinbaseValue:  625000000,
		CoinbaseHash:   fmt.Sprintf("%064x", time.Now().UnixNano()),
		MerkleBranches: []string{},
		Version:        "20000000",
		NBits:          "1d00ffff",
		NTime:          fmt.Sprintf("%x", time.Now().Unix()),
		Difficulty:     0x1d00ffff,
		CleanJobs:      true,
	}
	
	jm.currentJob = job
	return job
}

// validatePassword パスワード検証
func (s *Server) validatePassword(workerName, password string) bool {
	// Authentication disabled
	if !s.config.StratumConfig.RequireAuth {
		return true
	}
	
	switch s.config.StratumConfig.AuthMode {
	case "static":
		// Single static password for all workers
		return s.secureCompare(password, s.config.StratumConfig.StaticPassword)
		
	case "dynamic":
		// Individual passwords for each worker
		if expectedPassword, exists := s.config.StratumConfig.Workers[workerName]; exists {
			return s.secureCompare(password, expectedPassword)
		}
		return false
		
	case "database":
		// Database-based authentication (placeholder for future implementation)
		return s.validatePasswordDatabase(workerName, password)
		
	default:
		// Default to wallet address validation (common in mining)
		return s.validateWalletAddress(workerName, password)
	}
}

// secureCompare performs constant-time string comparison to prevent timing attacks
func (s *Server) secureCompare(provided, expected string) bool {
	if len(provided) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

// validatePasswordDatabase database-based password validation
func (s *Server) validatePasswordDatabase(workerName, password string) bool {
	// Placeholder for database integration
	// In production, this would query a database or external auth service
	return false
}

// validateWalletAddress validates mining credentials as wallet address
func (s *Server) validateWalletAddress(workerName, password string) bool {
	// Common mining pool pattern: worker name contains wallet address
	// Password can be "x" or worker-specific identifier
	
	// Basic wallet address format validation
	if strings.Contains(workerName, ".") {
		// Format: wallet_address.worker_name
		parts := strings.Split(workerName, ".")
		if len(parts) >= 2 {
			wallet := parts[0]
			return s.isValidWalletAddress(wallet)
		}
	}
	
	// Direct wallet address as worker name
	return s.isValidWalletAddress(workerName)
}

// isValidWalletAddress performs basic wallet address validation
func (s *Server) isValidWalletAddress(address string) bool {
	// Basic validation - in production, implement full address validation
	// for supported cryptocurrencies
	
	if len(address) < 26 || len(address) > 62 {
		return false
	}
	
	// Bitcoin-style address validation
	if strings.HasPrefix(address, "1") || strings.HasPrefix(address, "3") || strings.HasPrefix(address, "bc1") {
		return true
	}
	
	// Ethereum-style address validation
	if strings.HasPrefix(address, "0x") && len(address) == 42 {
		return true
	}
	
	// Other common formats
	return len(address) >= 26 && len(address) <= 62
}

// hashPassword creates secure password hash for storage
func (s *Server) hashPassword(password string) string {
	hash := sha256.Sum256([]byte(password))
	return hex.EncodeToString(hash[:])
}

// GetClientCount クライアント数を取得
func (s *Server) GetClientCount() int32 {
	return s.clientCount.Load()
}

// GetJobsSent 送信ジョブ数を取得
func (s *Server) GetJobsSent() uint64 {
	return s.jobsSent.Load()
}