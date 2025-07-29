package p2p

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// PoolConfig はP2Pプールの設定
type PoolConfig struct {
	ListenAddr      string
	BootstrapNodes  []string
	ShareDifficulty float64
	BlockTime       time.Duration
	PayoutThreshold float64
	FeePercentage   float64
}

// Pool はP2Pマイニングプール
type Pool struct {
	config      PoolConfig
	logger      *zap.Logger
	peers       sync.Map
	shares      *ShareManager
	blockchain  *Blockchain
	network     *NetworkManager
	consensus   *ConsensusEngine
	dht         *DHT
	mu          sync.RWMutex
	running     atomic.Bool
	nodeID      string
	totalShares atomic.Uint64
	blockHeight atomic.Uint64
}

// Peer はP2Pネットワークのピア
type Peer struct {
	ID           string
	Address      string
	Conn         net.Conn
	LastSeen     time.Time
	LastPong     time.Time
	ShareCount   uint64
	TrustScore   float64
	mu           sync.RWMutex
}

// Message types
const (
	MessageTypeHandshake   = 1
	MessageTypeShare       = 2
	MessageTypeBlock       = 3
	MessageTypePeerList    = 4
	MessageTypeJobRequest  = 5
	MessageTypePing        = 6
	MessageTypePong        = 7
)

// Message constraints
const (
	MaxMessageSize = 1024 * 1024 // 1MB
	MaxMessageAge  = 300         // 5 minutes
)

// Message はP2Pメッセージ
type Message struct {
	Type      uint8  `json:"type"`
	Timestamp int64  `json:"timestamp"`
	Payload   []byte `json:"payload"`
	Checksum  uint32 `json:"checksum"`
}

// PeerInfo はピア情報
type PeerInfo struct {
	ID      string `json:"id"`
	Address string `json:"address"`
}

// JobRequest はジョブリクエスト
type JobRequest struct {
	Algorithm  string  `json:"algorithm"`
	Difficulty float64 `json:"difficulty"`
}

// Job はマイニングジョブ
type Job struct {
	ID         string  `json:"id"`
	Algorithm  string  `json:"algorithm"`
	Target     string  `json:"target"`
	Difficulty float64 `json:"difficulty"`
	Data       []byte  `json:"data"`
}

// Share はマイニングシェア
type Share struct {
	ID         string
	MinerID    string
	JobID      string
	Nonce      uint64
	Hash       []byte
	Difficulty float64
	Timestamp  time.Time
	Valid      bool
}

// Block はブロック
type Block struct {
	Height      uint64
	Hash        []byte
	PrevHash    []byte
	Timestamp   time.Time
	Shares      []*Share
	Coinbase    []byte
	MerkleRoot  []byte
}

// ShareManager はシェア管理
type ShareManager struct {
	shares      sync.Map
	shareWindow time.Duration
	mu          sync.RWMutex
}

// Blockchain はブロックチェーン
type Blockchain struct {
	blocks      []*Block
	currentTip  *Block
	mu          sync.RWMutex
}

// NetworkManager はネットワーク管理
type NetworkManager struct {
	listener   net.Listener
	peers      sync.Map
	maxPeers   int
	mu         sync.RWMutex
}

// ConsensusEngine はコンセンサスエンジン
type ConsensusEngine struct {
	pool          *Pool
	minShareRatio float64
	mu            sync.RWMutex
}

// NewPool は新しいP2Pプールを作成
func NewPool(cfg PoolConfig, logger *zap.Logger) (*Pool, error) {
	// ノードID生成
	nodeIDBytes := make([]byte, 16)
	if _, err := rand.Read(nodeIDBytes); err != nil {
		return nil, fmt.Errorf("failed to generate node ID: %w", err)
	}
	nodeID := hex.EncodeToString(nodeIDBytes)

	// Generate DHT node ID from address
	dhtNodeIDBytes := sha256.Sum256([]byte(cfg.ListenAddr + nodeID))
	dhtNodeID := NodeID(dhtNodeIDBytes)

	// DHT設定
	dhtConfig := DHTConfig{
		NodeID:          dhtNodeID,
		BootstrapNodes:  cfg.BootstrapNodes,
		BucketSize:      20,
		Alpha:           3,
		RefreshInterval: 1 * time.Hour,
		StoreInterval:   1 * time.Hour,
		ExpireTime:      24 * time.Hour,
	}

	dht, err := NewDHT(dhtConfig, logger)
	if err != nil {
		return nil, fmt.Errorf("failed to create DHT: %w", err)
	}

	pool := &Pool{
		config:     cfg,
		logger:     logger,
		nodeID:     nodeID,
		dht:        dht,
		shares:     NewShareManager(24 * time.Hour),
		blockchain: NewBlockchain(),
		consensus:  NewConsensusEngine(0.51), // 51%以上の同意が必要
	}

	// ネットワークマネージャー初期化
	netMgr := &NetworkManager{
		maxPeers: 100,
	}
	pool.network = netMgr
	pool.consensus.pool = pool

	return pool, nil
}

// Start はP2Pプールを開始
func (p *Pool) Start(ctx context.Context) error {
	if p.running.Load() {
		return fmt.Errorf("pool already running")
	}

	// ネットワークリスナー開始
	listener, err := net.Listen("tcp", p.config.ListenAddr)
	if err != nil {
		return fmt.Errorf("failed to start listener: %w", err)
	}
	p.network.listener = listener

	p.running.Store(true)
	p.logger.Info("Starting P2P pool",
		zap.String("node_id", p.nodeID),
		zap.String("listen_addr", p.config.ListenAddr),
	)

	// ピア接続受付
	go p.acceptPeers(ctx)

	// シェア検証
	go p.validateShares(ctx)

	// ブロック生成
	go p.generateBlocks(ctx)

	// ピア同期
	go p.syncPeers(ctx)

	// DHT開始
	if err := p.dht.Start(p.config.ListenAddr); err != nil {
		return fmt.Errorf("failed to start DHT: %w", err)
	}

	// DHTピア検出開始
	go p.discoverPeersViaDHT(ctx)

	// プール情報の公開
	go p.publishPoolInfoToDHT(ctx)

	return nil
}

// Stop はP2Pプールを停止
func (p *Pool) Stop() error {
	if !p.running.Load() {
		return nil
	}

	p.running.Store(false)
	p.logger.Info("Stopping P2P pool")

	// リスナーを閉じる
	if p.network.listener != nil {
		p.network.listener.Close()
	}

	// すべてのピア接続を閉じる
	p.peers.Range(func(key, value interface{}) bool {
		if peer, ok := value.(*Peer); ok {
			peer.Conn.Close()
		}
		return true
	})

	// DHT停止
	if p.dht != nil {
		if err := p.dht.Stop(); err != nil {
			p.logger.Error("Failed to stop DHT", zap.Error(err))
		}
	}

	return nil
}

// acceptPeers はピア接続を受け付ける
func (p *Pool) acceptPeers(ctx context.Context) {
	for p.running.Load() {
		conn, err := p.network.listener.Accept()
		if err != nil {
			if p.running.Load() {
				p.logger.Error("Failed to accept connection", zap.Error(err))
			}
			continue
		}

		// ピア数チェック
		peerCount := 0
		p.peers.Range(func(_, _ interface{}) bool {
			peerCount++
			return true
		})

		if peerCount >= p.network.maxPeers {
			conn.Close()
			continue
		}

		// 新しいピアを処理
		go p.handlePeer(ctx, conn)
	}
}

// handlePeer はピアを処理
func (p *Pool) handlePeer(ctx context.Context, conn net.Conn) {
	defer conn.Close()

	// ピアID生成
	peerIDBytes := make([]byte, 16)
	rand.Read(peerIDBytes)
	peerID := hex.EncodeToString(peerIDBytes)

	peer := &Peer{
		ID:       peerID,
		Address:  conn.RemoteAddr().String(),
		Conn:     conn,
		LastSeen: time.Now(),
	}

	p.peers.Store(peerID, peer)
	defer p.peers.Delete(peerID)

	p.logger.Info("New peer connected",
		zap.String("peer_id", peerID),
		zap.String("address", peer.Address),
	)

	// ピアメッセージ処理ループ
	for {
		select {
		case <-ctx.Done():
			return
		default:
			// メッセージを読み取り
			msg, err := p.readMessage(conn)
			if err != nil {
				p.logger.Warn("Failed to read message", 
					zap.String("peer", peerID), 
					zap.Error(err))
				return
			}
			
			// メッセージを処理
			if err := p.handleMessage(peer, msg); err != nil {
				p.logger.Error("Failed to handle message", 
					zap.String("peer", peerID), 
					zap.Error(err))
			}
			
			peer.LastSeen = time.Now()
		}
	}
}

// readMessage はメッセージを読み取り
func (p *Pool) readMessage(conn net.Conn) (*Message, error) {
	// メッセージヘッダー読み取り (type + timestamp + payload_size + checksum)
	header := make([]byte, 17) // 1 + 8 + 4 + 4
	if _, err := io.ReadFull(conn, header); err != nil {
		return nil, err
	}
	
	msgType := header[0]
	timestamp := int64(binary.BigEndian.Uint64(header[1:9]))
	payloadSize := binary.BigEndian.Uint32(header[9:13])
	checksum := binary.BigEndian.Uint32(header[13:17])
	
	// ペイロードサイズ制限
	if payloadSize > MaxMessageSize {
		return nil, fmt.Errorf("message too large: %d bytes", payloadSize)
	}
	
	// ペイロード読み取り
	payload := make([]byte, payloadSize)
	if payloadSize > 0 {
		if _, err := io.ReadFull(conn, payload); err != nil {
			return nil, err
		}
	}
	
	return &Message{
		Type:      msgType,
		Timestamp: timestamp,
		Payload:   payload,
		Checksum:  checksum,
	}, nil
}

// handleMessage はメッセージを処理
func (p *Pool) handleMessage(peer *Peer, msg *Message) error {
	// メッセージ検証
	if err := p.validateMessage(msg); err != nil {
		p.logger.Warn("Invalid message received", 
			zap.String("peer", peer.ID),
			zap.Error(err))
		return err
	}
	
	switch msg.Type {
	case MessageTypeHandshake:
		return p.handleHandshake(peer, msg)
	case MessageTypeShare:
		return p.handleShare(peer, msg)
	case MessageTypeBlock:
		return p.handleBlock(peer, msg)
	case MessageTypePeerList:
		return p.handlePeerList(peer, msg)
	case MessageTypeJobRequest:
		return p.handleJobRequest(peer, msg)
	case MessageTypePing:
		return p.handlePing(peer, msg)
	case MessageTypePong:
		return p.handlePong(peer, msg)
	default:
		return fmt.Errorf("unknown message type: %d", msg.Type)
	}
}

// validateMessage はメッセージを検証
func (p *Pool) validateMessage(msg *Message) error {
	if msg == nil {
		return fmt.Errorf("message is nil")
	}
	
	// メッセージサイズ制限
	if len(msg.Payload) > MaxMessageSize {
		return fmt.Errorf("message too large: %d bytes", len(msg.Payload))
	}
	
	// チェックサム検証
	if msg.Checksum != 0 {
		calculated := p.calculateChecksum(msg.Payload)
		if calculated != msg.Checksum {
			return fmt.Errorf("checksum mismatch: expected %d, got %d", calculated, msg.Checksum)
		}
	}
	
	// タイムスタンプ検証（メッセージが古すぎないか）
	now := time.Now().Unix()
	if msg.Timestamp > 0 && (now - msg.Timestamp) > MaxMessageAge {
		return fmt.Errorf("message too old: %d seconds", now - msg.Timestamp)
	}
	
	return nil
}

// calculateChecksum はチェックサムを計算
func (p *Pool) calculateChecksum(data []byte) uint32 {
	return crc32.ChecksumIEEE(data)
}

// handleHandshake はハンドシェイクを処理
func (p *Pool) handleHandshake(peer *Peer, msg *Message) error {
	p.logger.Debug("Received handshake", zap.String("peer", peer.ID))
	// TODO: ハンドシェイク処理
	return nil
}

// handleShare はシェアを処理
func (p *Pool) handleShare(peer *Peer, msg *Message) error {
	p.logger.Debug("Received share", zap.String("peer", peer.ID))
	peer.ShareCount++
	p.totalShares.Add(1)
	return nil
}

// handleBlock はブロックを処理
func (p *Pool) handleBlock(peer *Peer, msg *Message) error {
	p.logger.Info("Received block", zap.String("peer", peer.ID))
	p.blockHeight.Add(1)
	return nil
}

// handlePeerList はピアリストメッセージを処理
func (p *Pool) handlePeerList(peer *Peer, msg *Message) error {
	var peerList []PeerInfo
	if err := json.Unmarshal(msg.Payload, &peerList); err != nil {
		return fmt.Errorf("failed to unmarshal peer list: %w", err)
	}
	
	p.logger.Debug("Received peer list", 
		zap.String("from", peer.ID),
		zap.Int("count", len(peerList)))
	
	// 新しいピアに接続を試行
	for _, peerInfo := range peerList {
		if peerInfo.ID != p.nodeID && !p.isConnected(peerInfo.ID) {
			go p.connectToPeer(peerInfo.Address, peerInfo.ID)
		}
	}
	
	return nil
}

// handleJobRequest はジョブリクエストを処理
func (p *Pool) handleJobRequest(peer *Peer, msg *Message) error {
	var request JobRequest
	if err := json.Unmarshal(msg.Payload, &request); err != nil {
		return fmt.Errorf("failed to unmarshal job request: %w", err)
	}
	
	p.logger.Debug("Received job request", 
		zap.String("from", peer.ID),
		zap.String("algorithm", request.Algorithm))
	
	// ジョブを生成して送信
	job := p.generateJob(request.Algorithm, request.Difficulty)
	return p.sendJob(peer, job)
}

// handlePing はPingメッセージを処理
func (p *Pool) handlePing(peer *Peer, msg *Message) error {
	// Pongを送信
	pongMsg := &Message{
		Type:      MessageTypePong,
		Timestamp: time.Now().Unix(),
		Payload:   msg.Payload, // Pingのペイロードをそのまま返す
	}
	pongMsg.Checksum = p.calculateChecksum(pongMsg.Payload)
	
	return p.sendMessage(peer, pongMsg)
}

// handlePong はPongメッセージを処理
func (p *Pool) handlePong(peer *Peer, msg *Message) error {
	peer.mu.Lock()
	peer.LastPong = time.Now()
	peer.mu.Unlock()
	
	p.logger.Debug("Received pong", zap.String("peer", peer.ID))
	return nil
}

// sendMessage はメッセージを送信
func (p *Pool) sendMessage(peer *Peer, msg *Message) error {
	// ヘッダー作成
	header := make([]byte, 17)
	header[0] = msg.Type
	binary.BigEndian.PutUint64(header[1:9], uint64(msg.Timestamp))
	binary.BigEndian.PutUint32(header[9:13], uint32(len(msg.Payload)))
	binary.BigEndian.PutUint32(header[13:17], msg.Checksum)
	
	// ヘッダー送信
	if _, err := peer.Conn.Write(header); err != nil {
		return err
	}
	
	// ペイロード送信
	if len(msg.Payload) > 0 {
		if _, err := peer.Conn.Write(msg.Payload); err != nil {
			return err
		}
	}
	
	return nil
}

// isConnected はピアが接続済みかチェック
func (p *Pool) isConnected(peerID string) bool {
	_, exists := p.peers.Load(peerID)
	return exists
}

// connectToPeer はピアに接続
func (p *Pool) connectToPeer(address, peerID string) error {
	// TODO: ピア接続実装
	p.logger.Debug("Connecting to peer", 
		zap.String("address", address),
		zap.String("peer_id", peerID))
	return nil
}

// generateJob はジョブを生成
func (p *Pool) generateJob(algorithm string, difficulty float64) *Job {
	return &Job{
		ID:         hex.EncodeToString(make([]byte, 16)),
		Algorithm:  algorithm,
		Difficulty: difficulty,
		Data:       make([]byte, 32), // ダミーデータ
	}
}

// sendJob はジョブを送信
func (p *Pool) sendJob(peer *Peer, job *Job) error {
	payload, err := json.Marshal(job)
	if err != nil {
		return err
	}
	
	msg := &Message{
		Type:      MessageTypeJobRequest,
		Timestamp: time.Now().Unix(),
		Payload:   payload,
	}
	msg.Checksum = p.calculateChecksum(msg.Payload)
	
	return p.sendMessage(peer, msg)
}

// SubmitShare はシェアを提出
func (p *Pool) SubmitShare(minerID string, share *Share) error {
	if !p.running.Load() {
		return fmt.Errorf("pool not running")
	}

	// シェア検証
	if !p.validateShare(share) {
		return fmt.Errorf("invalid share")
	}

	// シェア保存
	p.shares.AddShare(share)
	p.totalShares.Add(1)

	// ピアにブロードキャスト
	p.broadcastShare(share)

	return nil
}

// validateShare はシェアを検証
func (p *Pool) validateShare(share *Share) bool {
	// TODO: 実際のシェア検証ロジック
	// - 難易度チェック
	// - ハッシュ検証
	// - タイムスタンプチェック
	return share.Difficulty >= p.config.ShareDifficulty
}

// validateShares はシェアを継続的に検証
func (p *Pool) validateShares(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// 古いシェアをクリーンアップ
			p.shares.CleanupOldShares()
		}
	}
}

// generateBlocks はブロックを生成
func (p *Pool) generateBlocks(ctx context.Context) {
	ticker := time.NewTicker(p.config.BlockTime)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := p.createNewBlock(); err != nil {
				p.logger.Error("Failed to create block", zap.Error(err))
			}
		}
	}
}

// createNewBlock は新しいブロックを作成
func (p *Pool) createNewBlock() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	// 現在のシェアを収集
	shares := p.shares.GetRecentShares(p.config.BlockTime)
	if len(shares) == 0 {
		return fmt.Errorf("no shares available")
	}

	// ブロック作成
	block := &Block{
		Height:    p.blockHeight.Load() + 1,
		Timestamp: time.Now(),
		Shares:    shares,
		PrevHash:  p.blockchain.currentTip.Hash,
	}

	// ブロックハッシュ計算
	block.Hash = p.calculateBlockHash(block)

	// ブロックチェーンに追加
	if err := p.blockchain.AddBlock(block); err != nil {
		return fmt.Errorf("failed to add block: %w", err)
	}

	p.blockHeight.Store(block.Height)

	// ペイアウト計算
	go p.calculatePayouts(block)

	// ピアにブロードキャスト
	p.broadcastBlock(block)

	p.logger.Info("Created new block",
		zap.Uint64("height", block.Height),
		zap.Int("shares", len(shares)),
	)

	return nil
}

// calculateBlockHash はブロックハッシュを計算
func (p *Pool) calculateBlockHash(block *Block) []byte {
	// TODO: 実際のハッシュ計算
	return []byte("mock_hash")
}

// calculatePayouts はペイアウトを計算
func (p *Pool) calculatePayouts(block *Block) {
	// TODO: ペイアウト計算ロジック
	// - シェア貢献度に基づいて報酬を分配
	// - プール手数料を差し引く
	// - ペイアウトキューに追加
}

// broadcastShare はシェアをブロードキャスト
func (p *Pool) broadcastShare(share *Share) {
	p.peers.Range(func(key, value interface{}) bool {
		if peer, ok := value.(*Peer); ok {
			// TODO: シェアをピアに送信
			_ = peer
		}
		return true
	})
}

// broadcastBlock はブロックをブロードキャスト
func (p *Pool) broadcastBlock(block *Block) {
	p.peers.Range(func(key, value interface{}) bool {
		if peer, ok := value.(*Peer); ok {
			// TODO: ブロックをピアに送信
			_ = peer
		}
		return true
	})
}

// syncPeers はピアと同期
func (p *Pool) syncPeers(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// 非アクティブなピアを削除
			p.peers.Range(func(key, value interface{}) bool {
				if peer, ok := value.(*Peer); ok {
					if time.Since(peer.LastSeen) > 5*time.Minute {
						peer.Conn.Close()
						p.peers.Delete(key)
						p.logger.Info("Removed inactive peer",
							zap.String("peer_id", peer.ID),
						)
					}
				}
				return true
			})
		}
	}
}

// GetTotalShares は総シェア数を取得
func (p *Pool) GetTotalShares() uint64 {
	return p.totalShares.Load()
}

// GetBlockHeight は現在のブロック高を取得
func (p *Pool) GetBlockHeight() uint64 {
	return p.blockHeight.Load()
}

// GetPeerCount はピア数を取得
func (p *Pool) GetPeerCount() int {
	count := 0
	p.peers.Range(func(_, _ interface{}) bool {
		count++
		return true
	})
	return count
}

// ShareManager implementation

// NewShareManager は新しいシェアマネージャーを作成
func NewShareManager(window time.Duration) *ShareManager {
	return &ShareManager{
		shareWindow: window,
	}
}

// AddShare はシェアを追加
func (sm *ShareManager) AddShare(share *Share) {
	sm.shares.Store(share.ID, share)
}

// GetRecentShares は最近のシェアを取得
func (sm *ShareManager) GetRecentShares(duration time.Duration) []*Share {
	cutoff := time.Now().Add(-duration)
	var shares []*Share

	sm.shares.Range(func(key, value interface{}) bool {
		if share, ok := value.(*Share); ok {
			if share.Timestamp.After(cutoff) {
				shares = append(shares, share)
			}
		}
		return true
	})

	return shares
}

// CleanupOldShares は古いシェアをクリーンアップ
func (sm *ShareManager) CleanupOldShares() {
	cutoff := time.Now().Add(-sm.shareWindow)

	sm.shares.Range(func(key, value interface{}) bool {
		if share, ok := value.(*Share); ok {
			if share.Timestamp.Before(cutoff) {
				sm.shares.Delete(key)
			}
		}
		return true
	})
}

// Blockchain implementation

// NewBlockchain は新しいブロックチェーンを作成
func NewBlockchain() *Blockchain {
	genesis := &Block{
		Height:    0,
		Hash:      []byte("genesis"),
		Timestamp: time.Now(),
	}

	return &Blockchain{
		blocks:     []*Block{genesis},
		currentTip: genesis,
	}
}

// AddBlock はブロックを追加
func (bc *Blockchain) AddBlock(block *Block) error {
	bc.mu.Lock()
	defer bc.mu.Unlock()

	// 検証
	if block.Height != bc.currentTip.Height+1 {
		return fmt.Errorf("invalid block height")
	}

	bc.blocks = append(bc.blocks, block)
	bc.currentTip = block

	return nil
}

// ConsensusEngine implementation

// NewConsensusEngine は新しいコンセンサスエンジンを作成
func NewConsensusEngine(minShareRatio float64) *ConsensusEngine {
	return &ConsensusEngine{
		minShareRatio: minShareRatio,
	}
}

// discoverPeersViaDHT discovers peers using DHT
func (p *Pool) discoverPeersViaDHT(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Find nodes near our ID
			nodes, err := p.dht.FindNode(p.dht.localNode.ID)
			if err != nil {
				p.logger.Debug("DHT peer discovery failed", zap.Error(err))
				continue
			}

			// Connect to discovered nodes
			for _, node := range nodes {
				if node.Address != "" && node.Address != p.config.ListenAddr {
					if !p.isConnected(node.ID.String()) {
						go p.connectToPeer(node.Address, node.ID.String())
					}
				}
			}

			// Also try to find pool-specific peers
			p.findPoolPeersInDHT()
		}
	}
}

// publishPoolInfoToDHT publishes pool information to DHT
func (p *Pool) publishPoolInfoToDHT(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Create pool info
			poolInfo := map[string]interface{}{
				"node_id":          p.nodeID,
				"address":          p.config.ListenAddr,
				"share_difficulty": p.config.ShareDifficulty,
				"block_time":       p.config.BlockTime.Seconds(),
				"payout_threshold": p.config.PayoutThreshold,
				"fee_percentage":   p.config.FeePercentage,
				"total_shares":     p.totalShares.Load(),
				"total_blocks":     p.blockHeight.Load(),
				"peer_count":       p.GetPeerCount(),
				"timestamp":        time.Now().Unix(),
			}

			// Serialize pool info
			data, err := json.Marshal(poolInfo)
			if err != nil {
				p.logger.Error("Failed to marshal pool info", zap.Error(err))
				continue
			}

			// Store in DHT with multiple keys for discoverability
			keys := []string{
				fmt.Sprintf("pool:%s", p.config.ListenAddr),
				fmt.Sprintf("pool:node:%s", p.nodeID),
				"pool:list", // General key for finding all pools
			}

			for _, key := range keys {
				if err := p.dht.Store(key, data); err != nil {
					p.logger.Debug("Failed to store pool info in DHT",
						zap.String("key", key),
						zap.Error(err))
				}
			}
		}
	}
}

// findPoolPeersInDHT finds other pools in the DHT
func (p *Pool) findPoolPeersInDHT() {
	// Try to get the general pool list
	data, err := p.dht.Get("pool:list")
	if err != nil {
		// Try alternative discovery methods
		p.discoverPoolsByPattern()
		return
	}

	var poolInfo map[string]interface{}
	if err := json.Unmarshal(data, &poolInfo); err == nil {
		if address, ok := poolInfo["address"].(string); ok {
			if address != p.config.ListenAddr {
				if nodeID, ok := poolInfo["node_id"].(string); ok {
					if !p.isConnected(nodeID) {
						go p.connectToPeer(address, nodeID)
					}
				}
			}
		}
	}
}

// discoverPoolsByPattern discovers pools by pattern matching
func (p *Pool) discoverPoolsByPattern() {
	// This is a simplified implementation
	// In practice, you'd implement a more sophisticated discovery mechanism
	
	// Get stats from DHT to understand the network
	stats := p.dht.GetStats()
	p.logger.Debug("DHT network stats",
		zap.Any("stats", stats))
}

// GetPoolStats returns pool statistics including DHT info
func (p *Pool) GetPoolStats() map[string]interface{} {
	stats := map[string]interface{}{
		"node_id":      p.nodeID,
		"total_shares": p.totalShares.Load(),
		"block_height": p.blockHeight.Load(),
		"peer_count":   p.GetPeerCount(),
		"running":      p.running.Load(),
	}

	// Add DHT stats
	if p.dht != nil {
		stats["dht"] = p.dht.GetStats()
	}

	return stats
}