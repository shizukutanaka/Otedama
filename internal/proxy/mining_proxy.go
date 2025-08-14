//go:build ignore
// Legacy/ignored: excluded from production builds.
// See internal/legacy/README.md for details.
package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/mining"
	"github.com/shizukutanaka/Otedama/internal/p2p"
	"github.com/shizukutanaka/Otedama/internal/stratum"
	"go.uber.org/zap"
)

// MiningProxy acts as a middleman between miners and pools
// Rob Pike's simplicity with high-performance proxy implementation
type MiningProxy struct {
	logger *zap.Logger
	config ProxyConfig
	
	// Upstream pools
	upstreams      []*UpstreamPool
	currentPool    atomic.Int32
	poolMu         sync.RWMutex
	
	// Downstream miners
	miners         map[string]*ConnectedMiner
	minersMu       sync.RWMutex
	
	// Work management
	currentWork    atomic.Value // *WorkTemplate
	workID         atomic.Uint64
	
	// Share management
	shareValidator *ShareValidator
	shareBuffer    *ShareBuffer
	
	// Statistics
	stats          ProxyStats
	
	// Network
	listener       net.Listener
	
	// Lifecycle
	ctx            context.Context
	cancel         context.CancelFunc
	wg             sync.WaitGroup
}

// ProxyConfig contains proxy configuration
type ProxyConfig struct {
	// Server settings
	ListenAddr        string        `json:"listen_addr"`
	Protocol          string        `json:"protocol"` // stratum, getwork, stratum2
	
	// Upstream settings
	Upstreams         []UpstreamConfig `json:"upstreams"`
	FailoverStrategy  string        `json:"failover_strategy"`
	HealthCheckInterval time.Duration `json:"health_check_interval"`
	
	// Work settings
	WorkCacheTime     time.Duration `json:"work_cache_time"`
	ExtraNonceSize    int           `json:"extranonce_size"`
	
	// Share settings
	ShareTimeout      time.Duration `json:"share_timeout"`
	RejectInvalidShares bool        `json:"reject_invalid_shares"`
	
	// Security
	RequireAuth       bool          `json:"require_auth"`
	AllowedWorkers    []string      `json:"allowed_workers"`
	
	// Performance
	MaxConnections    int           `json:"max_connections"`
	ConnectionTimeout time.Duration `json:"connection_timeout"`
}

// UpstreamConfig represents upstream pool configuration
type UpstreamConfig struct {
	Name          string `json:"name"`
	URL           string `json:"url"`
	User          string `json:"user"`
	Password      string `json:"password"`
	Priority      int    `json:"priority"`
}

// UpstreamPool represents a connection to an upstream pool
type UpstreamPool struct {
	config        UpstreamConfig
	client        *stratum.Client
	connected     atomic.Bool
	lastHealthy   atomic.Value // time.Time
	shares        atomic.Uint64
	accepted      atomic.Uint64
	rejected      atomic.Uint64
}

// ConnectedMiner represents a downstream miner connection
type ConnectedMiner struct {
	id            string
	conn          net.Conn
	authorized    bool
	
	// Worker info
	workerName    string
	extraNonce1   []byte
	
	// Statistics
	connected     time.Time
	lastSeen      atomic.Value // time.Time
	shares        atomic.Uint64
	accepted      atomic.Uint64
	rejected      atomic.Uint64
	hashRate      atomic.Uint64
	
	// Channels
	send          chan interface{}
	disconnect    chan struct{}
}

// WorkTemplate represents work to be distributed
type WorkTemplate struct {
	JobID         string
	PrevHash      []byte
	CoinbasePart1 []byte
	CoinbasePart2 []byte
	MerkleBranch  [][]byte
	Version       uint32
	Bits          uint32
	Time          uint32
	CleanJobs     bool
	
	// Proxy additions
	SourcePool    string
	ReceivedAt    time.Time
}

// ProxyStats tracks proxy statistics
type ProxyStats struct {
	// Connections
	TotalConnections  atomic.Uint64
	ActiveMiners      atomic.Int32
	
	// Shares
	TotalShares       atomic.Uint64
	AcceptedShares    atomic.Uint64
	RejectedShares    atomic.Uint64
	StaleShares       atomic.Uint64
	
	// Work
	WorkTemplates     atomic.Uint64
	WorkDistributed   atomic.Uint64
	
	// Network
	BytesReceived     atomic.Uint64
	BytesSent         atomic.Uint64
	
	// Uptime
	StartTime         time.Time
}

// NewMiningProxy creates a new mining proxy
func NewMiningProxy(logger *zap.Logger, config ProxyConfig) *MiningProxy {
	ctx, cancel := context.WithCancel(context.Background())
	
	proxy := &MiningProxy{
		logger:         logger,
		config:         config,
		upstreams:      make([]*UpstreamPool, 0, len(config.Upstreams)),
		miners:         make(map[string]*ConnectedMiner),
		shareValidator: NewShareValidator(logger),
		shareBuffer:    NewShareBuffer(1000),
		ctx:            ctx,
		cancel:         cancel,
		stats: ProxyStats{
			StartTime: time.Now(),
		},
	}
	
	// Initialize upstream pools
	for _, upConfig := range config.Upstreams {
		upstream := &UpstreamPool{
			config: upConfig,
		}
		upstream.lastHealthy.Store(time.Now())
		proxy.upstreams = append(proxy.upstreams, upstream)
	}
	
	return proxy
}

// Start starts the mining proxy
func (mp *MiningProxy) Start() error {
	// Connect to upstream pools
	mp.wg.Add(1)
	go mp.upstreamManager()
	
	// Start share processor
	mp.wg.Add(1)
	go mp.shareProcessor()
	
	// Start listening for miners
	listener, err := net.Listen("tcp", mp.config.ListenAddr)
	if err != nil {
		return fmt.Errorf("failed to listen: %w", err)
	}
	mp.listener = listener
	
	mp.wg.Add(1)
	go mp.acceptConnections()
	
	mp.logger.Info("Mining proxy started",
		zap.String("address", mp.config.ListenAddr),
		zap.String("protocol", mp.config.Protocol),
		zap.Int("upstreams", len(mp.upstreams)),
	)
	
	return nil
}

// Stop stops the mining proxy
func (mp *MiningProxy) Stop() error {
	mp.cancel()
	
	if mp.listener != nil {
		mp.listener.Close()
	}
	
	// Disconnect all miners
	mp.minersMu.Lock()
	for _, miner := range mp.miners {
		close(miner.disconnect)
		miner.conn.Close()
	}
	mp.minersMu.Unlock()
	
	// Disconnect from pools
	mp.poolMu.Lock()
	for _, pool := range mp.upstreams {
		if pool.client != nil {
			pool.client.Close()
		}
	}
	mp.poolMu.Unlock()
	
	mp.wg.Wait()
	
	mp.logger.Info("Mining proxy stopped")
	return nil
}

// acceptConnections accepts incoming miner connections
func (mp *MiningProxy) acceptConnections() {
	defer mp.wg.Done()
	
	for {
		conn, err := mp.listener.Accept()
		if err != nil {
			select {
			case <-mp.ctx.Done():
				return
			default:
				mp.logger.Error("Accept error", zap.Error(err))
				continue
			}
		}
		
		// Check connection limit
		if mp.config.MaxConnections > 0 && 
		   int(mp.stats.ActiveMiners.Load()) >= mp.config.MaxConnections {
			conn.Close()
			continue
		}
		
		// Handle new miner
		mp.wg.Add(1)
		go mp.handleMiner(conn)
	}
}

// handleMiner handles a miner connection
func (mp *MiningProxy) handleMiner(conn net.Conn) {
	defer mp.wg.Done()
	defer conn.Close()
	
	// Create miner instance
	miner := &ConnectedMiner{
		id:          generateMinerID(),
		conn:        conn,
		connected:   time.Now(),
		send:        make(chan interface{}, 100),
		disconnect:  make(chan struct{}),
	}
	
	miner.lastSeen.Store(time.Now())
	
	// Set connection timeout
	if mp.config.ConnectionTimeout > 0 {
		conn.SetDeadline(time.Now().Add(mp.config.ConnectionTimeout))
	}
	
	// Register miner
	mp.minersMu.Lock()
	mp.miners[miner.id] = miner
	mp.minersMu.Unlock()
	
	mp.stats.TotalConnections.Add(1)
	mp.stats.ActiveMiners.Add(1)
	
	mp.logger.Info("Miner connected",
		zap.String("miner_id", miner.id),
		zap.String("remote_addr", conn.RemoteAddr().String()),
	)
	
	// Start send pump
	mp.wg.Add(1)
	go mp.minerSendPump(miner)
	
	// Handle based on protocol
	switch mp.config.Protocol {
	case "stratum":
		mp.handleStratumMiner(miner)
	case "stratum2":
		mp.handleStratum2Miner(miner)
	case "getwork":
		mp.handleGetworkMiner(miner)
	default:
		mp.logger.Error("Unknown protocol", zap.String("protocol", mp.config.Protocol))
	}
	
	// Cleanup
	mp.minersMu.Lock()
	delete(mp.miners, miner.id)
	mp.minersMu.Unlock()
	
	mp.stats.ActiveMiners.Add(-1)
	
	mp.logger.Info("Miner disconnected",
		zap.String("miner_id", miner.id),
		zap.Uint64("shares", miner.shares.Load()),
		zap.Uint64("accepted", miner.accepted.Load()),
	)
}

// handleStratumMiner handles Stratum protocol
func (mp *MiningProxy) handleStratumMiner(miner *ConnectedMiner) {
	decoder := json.NewDecoder(miner.conn)
	
	for {
		select {
		case <-miner.disconnect:
			return
		case <-mp.ctx.Done():
			return
		default:
		}
		
		// Read message
		var msg stratum.Message
		if err := decoder.Decode(&msg); err != nil {
			if err != io.EOF {
				mp.logger.Debug("Decode error", 
					zap.String("miner_id", miner.id),
					zap.Error(err),
				)
			}
			return
		}
		
		miner.lastSeen.Store(time.Now())
		
		// Handle message
		switch msg.Method {
		case "mining.subscribe":
			mp.handleSubscribe(miner, msg)
			
		case "mining.authorize":
			mp.handleAuthorize(miner, msg)
			
		case "mining.submit":
			mp.handleSubmit(miner, msg)
			
		case "mining.extranonce.subscribe":
			mp.handleExtranonceSubscribe(miner, msg)
			
		default:
			mp.logger.Warn("Unknown method",
				zap.String("method", msg.Method),
				zap.String("miner_id", miner.id),
			)
		}
	}
}

// handleSubscribe handles mining.subscribe
func (mp *MiningProxy) handleSubscribe(miner *ConnectedMiner, msg stratum.Message) {
	// Generate extranonce1
	miner.extraNonce1 = generateExtraNonce1(mp.config.ExtraNonceSize)
	
	// Send response
	response := stratum.Message{
		ID: msg.ID,
		Result: []interface{}{
			[][]interface{}{
				{"mining.set_difficulty", "proxy_diff_1"},
				{"mining.notify", "proxy_notify_1"},
			},
			hex.EncodeToString(miner.extraNonce1),
			mp.config.ExtraNonceSize,
		},
	}
	
	select {
	case miner.send <- response:
	case <-time.After(time.Second):
		mp.logger.Warn("Send timeout", zap.String("miner_id", miner.id))
	}
	
	// Send initial difficulty
	mp.sendDifficulty(miner, 1.0)
	
	// Send current work
	if work := mp.currentWork.Load(); work != nil {
		mp.sendWork(miner, work.(*WorkTemplate))
	}
}

// handleAuthorize handles mining.authorize
func (mp *MiningProxy) handleAuthorize(miner *ConnectedMiner, msg stratum.Message) {
	params, ok := msg.Params.([]interface{})
	if !ok || len(params) < 1 {
		mp.sendError(miner, msg.ID, "Invalid params")
		return
	}
	
	workerName, ok := params[0].(string)
	if !ok {
		mp.sendError(miner, msg.ID, "Invalid worker name")
		return
	}
	
	// Check authorization
	authorized := true
	if mp.config.RequireAuth && len(mp.config.AllowedWorkers) > 0 {
		authorized = false
		for _, allowed := range mp.config.AllowedWorkers {
			if workerName == allowed {
				authorized = true
				break
			}
		}
	}
	
	miner.authorized = authorized
	miner.workerName = workerName
	
	// Send response
	response := stratum.Message{
		ID:     msg.ID,
		Result: authorized,
	}
	
	select {
	case miner.send <- response:
	case <-time.After(time.Second):
	}
	
	mp.logger.Info("Miner authorized",
		zap.String("miner_id", miner.id),
		zap.String("worker", workerName),
		zap.Bool("authorized", authorized),
	)
}

// handleSubmit handles mining.submit
func (mp *MiningProxy) handleSubmit(miner *ConnectedMiner, msg stratum.Message) {
	if !miner.authorized {
		mp.sendError(miner, msg.ID, "Unauthorized")
		return
	}
	
	params, ok := msg.Params.([]interface{})
	if !ok || len(params) < 5 {
		mp.sendError(miner, msg.ID, "Invalid params")
		return
	}
	
	// Parse share
	share := &Share{
		MinerID:    miner.id,
		WorkerName: miner.workerName,
		JobID:      params[1].(string),
		ExtraNonce2: params[2].(string),
		Time:       params[3].(string),
		Nonce:      params[4].(string),
		SubmitTime: time.Now(),
	}
	
	miner.shares.Add(1)
	mp.stats.TotalShares.Add(1)
	
	// Add to share buffer for processing
	mp.shareBuffer.Add(share)
	
	// Send immediate response (optimistic)
	response := stratum.Message{
		ID:     msg.ID,
		Result: true,
	}
	
	select {
	case miner.send <- response:
	case <-time.After(time.Second):
	}
}

// upstreamManager manages upstream pool connections
func (mp *MiningProxy) upstreamManager() {
	defer mp.wg.Done()
	
	// Initial connection
	mp.connectToPools()
	
	ticker := time.NewTicker(mp.config.HealthCheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			mp.checkPoolHealth()
			
		case <-mp.ctx.Done():
			return
		}
	}
}

// connectToPools connects to upstream pools
func (mp *MiningProxy) connectToPools() {
	for i, pool := range mp.upstreams {
		if pool.connected.Load() {
			continue
		}
		
		client, err := stratum.NewClient(pool.config.URL, mp.logger)
		if err != nil {
			mp.logger.Error("Failed to connect to pool",
				zap.String("pool", pool.config.Name),
				zap.Error(err),
			)
			continue
		}
		
		// Subscribe and authorize
		if err := client.Subscribe(); err != nil {
			mp.logger.Error("Failed to subscribe",
				zap.String("pool", pool.config.Name),
				zap.Error(err),
			)
			client.Close()
			continue
		}
		
		if err := client.Authorize(pool.config.User, pool.config.Password); err != nil {
			mp.logger.Error("Failed to authorize",
				zap.String("pool", pool.config.Name),
				zap.Error(err),
			)
			client.Close()
			continue
		}
		
		pool.client = client
		pool.connected.Store(true)
		pool.lastHealthy.Store(time.Now())
		
		// Set as current if first connected
		if mp.currentPool.Load() == 0 {
			mp.currentPool.Store(int32(i))
		}
		
		// Start work receiver
		mp.wg.Add(1)
		go mp.receivePoolWork(i, pool)
		
		mp.logger.Info("Connected to pool",
			zap.String("pool", pool.config.Name),
			zap.String("url", pool.config.URL),
		)
	}
}

// receivePoolWork receives work from upstream pool
func (mp *MiningProxy) receivePoolWork(poolIndex int, pool *UpstreamPool) {
	defer mp.wg.Done()
	
	for {
		select {
		case <-mp.ctx.Done():
			return
		default:
		}
		
		work, err := pool.client.ReceiveWork()
		if err != nil {
			mp.logger.Error("Failed to receive work",
				zap.String("pool", pool.config.Name),
				zap.Error(err),
			)
			pool.connected.Store(false)
			return
		}
		
		// Convert to work template
		template := &WorkTemplate{
			JobID:         work.JobID,
			PrevHash:      work.PrevHash,
			CoinbasePart1: work.CoinbasePart1,
			CoinbasePart2: work.CoinbasePart2,
			MerkleBranch:  work.MerkleBranch,
			Version:       work.Version,
			Bits:          work.Bits,
			Time:          work.Time,
			CleanJobs:     work.CleanJobs,
			SourcePool:    pool.config.Name,
			ReceivedAt:    time.Now(),
		}
		
		// Update current work
		mp.currentWork.Store(template)
		mp.stats.WorkTemplates.Add(1)
		
		// Distribute to miners
		mp.distributeWork(template)
	}
}

// distributeWork distributes work to all connected miners
func (mp *MiningProxy) distributeWork(work *WorkTemplate) {
	mp.minersMu.RLock()
	defer mp.minersMu.RUnlock()
	
	count := 0
	for _, miner := range mp.miners {
		if miner.authorized {
			mp.sendWork(miner, work)
			count++
		}
	}
	
	mp.stats.WorkDistributed.Add(uint64(count))
	
	mp.logger.Debug("Work distributed",
		zap.String("job_id", work.JobID),
		zap.String("source_pool", work.SourcePool),
		zap.Int("miners", count),
	)
}

// Helper methods

func (mp *MiningProxy) minerSendPump(miner *ConnectedMiner) {
	defer mp.wg.Done()
	
	encoder := json.NewEncoder(miner.conn)
	
	for {
		select {
		case msg := <-miner.send:
			if err := encoder.Encode(msg); err != nil {
				mp.logger.Debug("Send error",
					zap.String("miner_id", miner.id),
					zap.Error(err),
				)
				return
			}
			mp.stats.BytesSent.Add(100) // Approximate
			
		case <-miner.disconnect:
			return
			
		case <-mp.ctx.Done():
			return
		}
	}
}

func (mp *MiningProxy) sendWork(miner *ConnectedMiner, work *WorkTemplate) {
	notify := stratum.Message{
		Method: "mining.notify",
		Params: []interface{}{
			work.JobID,
			hex.EncodeToString(work.PrevHash),
			hex.EncodeToString(work.CoinbasePart1),
			hex.EncodeToString(work.CoinbasePart2),
			work.MerkleBranch,
			fmt.Sprintf("%08x", work.Version),
			fmt.Sprintf("%08x", work.Bits),
			fmt.Sprintf("%08x", work.Time),
			work.CleanJobs,
		},
	}
	
	select {
	case miner.send <- notify:
	default:
		mp.logger.Warn("Send buffer full", zap.String("miner_id", miner.id))
	}
}

func (mp *MiningProxy) sendDifficulty(miner *ConnectedMiner, difficulty float64) {
	msg := stratum.Message{
		Method: "mining.set_difficulty",
		Params: []interface{}{difficulty},
	}
	
	select {
	case miner.send <- msg:
	default:
	}
}

func (mp *MiningProxy) sendError(miner *ConnectedMiner, id interface{}, message string) {
	response := stratum.Message{
		ID:    id,
		Error: []interface{}{-1, message, nil},
	}
	
	select {
	case miner.send <- response:
	default:
	}
}

// GetStats returns proxy statistics
func (mp *MiningProxy) GetStats() ProxyStats {
	return mp.stats
}

// Placeholder implementations

type ShareValidator struct {
	logger *zap.Logger
}

func NewShareValidator(logger *zap.Logger) *ShareValidator {
	return &ShareValidator{logger: logger}
}

type ShareBuffer struct {
	shares chan *Share
}

func NewShareBuffer(size int) *ShareBuffer {
	return &ShareBuffer{
		shares: make(chan *Share, size),
	}
}

func (sb *ShareBuffer) Add(share *Share) {
	select {
	case sb.shares <- share:
	default:
		// Buffer full, drop oldest
		<-sb.shares
		sb.shares <- share
	}
}

type Share struct {
	MinerID     string
	WorkerName  string
	JobID       string
	ExtraNonce2 string
	Time        string
	Nonce       string
	SubmitTime  time.Time
}

func (mp *MiningProxy) shareProcessor() {
	defer mp.wg.Done()
	
	for {
		select {
		case share := <-mp.shareBuffer.shares:
			// Process share
			mp.processShare(share)
			
		case <-mp.ctx.Done():
			return
		}
	}
}

func (mp *MiningProxy) processShare(share *Share) {
	// Validate share
	// This would validate against current work
	valid := true // Placeholder
	
	if valid {
		mp.stats.AcceptedShares.Add(1)
		
		// Update miner stats
		mp.minersMu.RLock()
		if miner, ok := mp.miners[share.MinerID]; ok {
			miner.accepted.Add(1)
		}
		mp.minersMu.RUnlock()
		
		// Submit to upstream pool
		mp.submitShareUpstream(share)
	} else {
		mp.stats.RejectedShares.Add(1)
		
		// Update miner stats
		mp.minersMu.RLock()
		if miner, ok := mp.miners[share.MinerID]; ok {
			miner.rejected.Add(1)
		}
		mp.minersMu.RUnlock()
	}
}

func (mp *MiningProxy) submitShareUpstream(share *Share) {
	// Get current pool
	poolIndex := mp.currentPool.Load()
	if poolIndex < 0 || int(poolIndex) >= len(mp.upstreams) {
		return
	}
	
	pool := mp.upstreams[poolIndex]
	if !pool.connected.Load() || pool.client == nil {
		return
	}
	
	// Submit share
	// This would submit to upstream pool
	pool.shares.Add(1)
	pool.accepted.Add(1) // Placeholder
}

func (mp *MiningProxy) checkPoolHealth() {
	// Check each pool's health
	for i, pool := range mp.upstreams {
		if !pool.connected.Load() {
			// Try to reconnect
			mp.connectToPools()
			continue
		}
		
		// Check last healthy time
		lastHealthy := pool.lastHealthy.Load().(time.Time)
		if time.Since(lastHealthy) > mp.config.HealthCheckInterval*3 {
			mp.logger.Warn("Pool unhealthy",
				zap.String("pool", pool.config.Name),
				zap.Duration("since", time.Since(lastHealthy)),
			)
			
			// Failover if this is current pool
			if int32(i) == mp.currentPool.Load() {
				mp.failover()
			}
		}
	}
}

func (mp *MiningProxy) failover() {
	current := mp.currentPool.Load()
	
	// Find next healthy pool
	for i := 0; i < len(mp.upstreams); i++ {
		next := (int(current) + i + 1) % len(mp.upstreams)
		pool := mp.upstreams[next]
		
		if pool.connected.Load() {
			mp.currentPool.Store(int32(next))
			mp.logger.Info("Failed over to pool",
				zap.String("pool", pool.config.Name),
			)
			return
		}
	}
	
	mp.logger.Error("No healthy pools available")
}

// Helper functions

func generateMinerID() string {
	return fmt.Sprintf("miner-%d", time.Now().UnixNano())
}

func generateExtraNonce1(size int) []byte {
	nonce := make([]byte, size)
	for i := range nonce {
		nonce[i] = byte(time.Now().UnixNano() & 0xff)
	}
	return nonce
}

// Stub imports
import (
	"encoding/hex"
	"io"
)

// Stratum2 and Getwork handlers would be implemented similarly
func (mp *MiningProxy) handleStratum2Miner(miner *ConnectedMiner) {
	// Stratum v2 implementation
}

func (mp *MiningProxy) handleGetworkMiner(miner *ConnectedMiner) {
	// Getwork implementation
}

func (mp *MiningProxy) handleExtranonceSubscribe(miner *ConnectedMiner, msg stratum.Message) {
	// Extranonce subscription
}