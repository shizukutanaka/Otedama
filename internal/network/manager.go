package network

import (
	"context"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"go.uber.org/zap"
)

// Manager はネットワークマネージャー
type Manager struct {
	config       config.NetworkConfig
	logger       *zap.Logger
	listener     net.Listener
	connections  sync.Map
	peerCount    atomic.Int32
	bandwidthIn  atomic.Uint64
	bandwidthOut atomic.Uint64
	mu           sync.RWMutex
	running      atomic.Bool
}

// Connection はネットワーク接続
type Connection struct {
	ID         string
	Conn       net.Conn
	PeerAddr   string
	Connected  time.Time
	BytesIn    atomic.Uint64
	BytesOut   atomic.Uint64
	LastActive time.Time
}

// BandwidthStats は帯域幅統計
type BandwidthStats struct {
	BytesIn     uint64
	BytesOut    uint64
	RateIn      float64
	RateOut     float64
	Connections int
}

// NewManager は新しいネットワークマネージャーを作成
func NewManager(cfg config.NetworkConfig, logger *zap.Logger) (*Manager, error) {
	return &Manager{
		config: cfg,
		logger: logger,
	}, nil
}

// Start はネットワークマネージャーを開始
func (m *Manager) Start(ctx context.Context) error {
	if m.running.Load() {
		return fmt.Errorf("network manager already running")
	}

	if m.config.EnableP2P {
		listener, err := net.Listen("tcp", m.config.ListenAddr)
		if err != nil {
			return fmt.Errorf("failed to start listener: %w", err)
		}
		m.listener = listener

		// 接続受付開始
		go m.acceptConnections(ctx)

		// ブートストラップピアに接続
		go m.connectToBootstrapPeers(ctx)
	}

	// 統計収集開始
	go m.collectStats(ctx)

	// 接続管理開始
	go m.manageConnections(ctx)

	m.running.Store(true)
	m.logger.Info("Network manager started",
		zap.String("listen_addr", m.config.ListenAddr),
		zap.Bool("p2p_enabled", m.config.EnableP2P),
	)

	return nil
}

// Stop はネットワークマネージャーを停止
func (m *Manager) Stop() error {
	if !m.running.Load() {
		return nil
	}

	m.running.Store(false)
	m.logger.Info("Stopping network manager")

	// リスナーを閉じる
	if m.listener != nil {
		m.listener.Close()
	}

	// すべての接続を閉じる
	m.connections.Range(func(key, value interface{}) bool {
		if conn, ok := value.(*Connection); ok {
			conn.Conn.Close()
		}
		return true
	})

	return nil
}

// acceptConnections は接続を受け付ける
func (m *Manager) acceptConnections(ctx context.Context) {
	for m.running.Load() {
		conn, err := m.listener.Accept()
		if err != nil {
			if m.running.Load() {
				m.logger.Error("Failed to accept connection", zap.Error(err))
			}
			continue
		}

		// ピア数制限チェック
		if m.peerCount.Load() >= int32(m.config.MaxPeers) {
			conn.Close()
			continue
		}

		// 新しい接続を処理
		go m.handleConnection(ctx, conn, true)
	}
}

// connectToBootstrapPeers はブートストラップピアに接続
func (m *Manager) connectToBootstrapPeers(ctx context.Context) {
	for _, peer := range m.config.BootstrapPeers {
		if m.peerCount.Load() >= int32(m.config.MaxPeers) {
			break
		}

		go func(peerAddr string) {
			dialer := net.Dialer{
				Timeout: m.config.DialTimeout,
			}

			conn, err := dialer.DialContext(ctx, "tcp", peerAddr)
			if err != nil {
				m.logger.Warn("Failed to connect to bootstrap peer",
					zap.String("peer", peerAddr),
					zap.Error(err),
				)
				return
			}

			m.handleConnection(ctx, conn, false)
		}(peer)
	}
}

// handleConnection は接続を処理
func (m *Manager) handleConnection(ctx context.Context, conn net.Conn, incoming bool) {
	connID := fmt.Sprintf("%s-%d", conn.RemoteAddr().String(), time.Now().UnixNano())
	
	connection := &Connection{
		ID:         connID,
		Conn:       conn,
		PeerAddr:   conn.RemoteAddr().String(),
		Connected:  time.Now(),
		LastActive: time.Now(),
	}

	m.connections.Store(connID, connection)
	m.peerCount.Add(1)

	defer func() {
		conn.Close()
		m.connections.Delete(connID)
		m.peerCount.Add(-1)
	}()

	direction := "outgoing"
	if incoming {
		direction = "incoming"
	}

	m.logger.Info("New connection",
		zap.String("peer", connection.PeerAddr),
		zap.String("direction", direction),
	)

	// 接続処理ループ
	for {
		select {
		case <-ctx.Done():
			return
		default:
			// タイムアウト設定
			conn.SetReadDeadline(time.Now().Add(5 * time.Minute))

			// データ読み取り（簡易実装）
			buffer := make([]byte, 4096)
			n, err := conn.Read(buffer)
			if err != nil {
				return
			}

			connection.BytesIn.Add(uint64(n))
			m.bandwidthIn.Add(uint64(n))
			connection.LastActive = time.Now()

			// エコーバック（テスト用）
			if n > 0 {
				written, _ := conn.Write(buffer[:n])
				connection.BytesOut.Add(uint64(written))
				m.bandwidthOut.Add(uint64(written))
			}
		}
	}
}

// collectStats は統計情報を収集
func (m *Manager) collectStats(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	var lastBytesIn, lastBytesOut uint64
	lastTime := time.Now()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			currentBytesIn := m.bandwidthIn.Load()
			currentBytesOut := m.bandwidthOut.Load()
			currentTime := time.Now()

			duration := currentTime.Sub(lastTime).Seconds()
			if duration > 0 {
				rateIn := float64(currentBytesIn-lastBytesIn) / duration
				rateOut := float64(currentBytesOut-lastBytesOut) / duration

				m.logger.Debug("Network stats",
					zap.Float64("rate_in_bps", rateIn),
					zap.Float64("rate_out_bps", rateOut),
					zap.Int32("connections", m.peerCount.Load()),
				)
			}

			lastBytesIn = currentBytesIn
			lastBytesOut = currentBytesOut
			lastTime = currentTime
		}
	}
}

// manageConnections は接続を管理
func (m *Manager) manageConnections(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// 非アクティブな接続を削除
			m.connections.Range(func(key, value interface{}) bool {
				if conn, ok := value.(*Connection); ok {
					if time.Since(conn.LastActive) > 5*time.Minute {
						conn.Conn.Close()
						m.connections.Delete(key)
						m.peerCount.Add(-1)
						m.logger.Info("Closed inactive connection",
							zap.String("peer", conn.PeerAddr),
						)
					}
				}
				return true
			})

			// ピア数が少ない場合は新しい接続を試みる
			if m.peerCount.Load() < int32(m.config.MaxPeers/2) {
				go m.connectToBootstrapPeers(ctx)
			}
		}
	}
}

// GetPeerCount はピア数を取得
func (m *Manager) GetPeerCount() int {
	return int(m.peerCount.Load())
}

// GetBandwidthStats は帯域幅統計を取得
func (m *Manager) GetBandwidthStats() *BandwidthStats {
	return &BandwidthStats{
		BytesIn:     m.bandwidthIn.Load(),
		BytesOut:    m.bandwidthOut.Load(),
		Connections: int(m.peerCount.Load()),
	}
}

// Broadcast はすべてのピアにメッセージをブロードキャスト
func (m *Manager) Broadcast(data []byte) error {
	var errors []error

	m.connections.Range(func(key, value interface{}) bool {
		if conn, ok := value.(*Connection); ok {
			if _, err := conn.Conn.Write(data); err != nil {
				errors = append(errors, err)
			} else {
				conn.BytesOut.Add(uint64(len(data)))
				m.bandwidthOut.Add(uint64(len(data)))
			}
		}
		return true
	})

	if len(errors) > 0 {
		return fmt.Errorf("broadcast failed: %d errors", len(errors))
	}

	return nil
}