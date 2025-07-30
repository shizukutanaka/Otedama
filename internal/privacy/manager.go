package privacy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"go.uber.org/zap"
	"golang.org/x/net/proxy"
)

// Manager はプライバシー管理システム
type Manager struct {
	config          *config.PrivacyConfig
	logger          *zap.Logger
	torProxy        proxy.Dialer
	i2pProxy        proxy.Dialer
	anonymousPool   *AnonymousPool
	addressObfuscator *AddressObfuscator
	mu              sync.RWMutex
	isActive        bool
}

// AnonymousPool は匿名マイニングプール
type AnonymousPool struct {
	anonymousMiners map[string]*AnonymousMiner
	pseudonymMap    map[string]string // 実際のアドレス -> 仮名のマッピング
	mu              sync.RWMutex
}

// AnonymousMiner は匿名マイナー情報
type AnonymousMiner struct {
	Pseudonym       string
	RealAddress     string
	ShareCount      uint64
	LastActivity    time.Time
	TotalEarnings   uint64
	PayoutAddress   string // 暗号化されたペイアウトアドレス
}

// AddressObfuscator はIPアドレス難読化器
type AddressObfuscator struct {
	saltRotationInterval time.Duration
	currentSalt          []byte
	previousSalt         []byte
	saltRotatedAt        time.Time
	mu                   sync.RWMutex
}

// NewManager は新しいプライバシーマネージャーを作成
func NewManager(cfg *config.PrivacyConfig, logger *zap.Logger) (*Manager, error) {
	manager := &Manager{
		config:          cfg,
		logger:          logger,
		anonymousPool:   NewAnonymousPool(),
		addressObfuscator: NewAddressObfuscator(),
	}

	// Torプロキシの初期化
	if cfg.EnableTor {
		if err := manager.initializeTorProxy(); err != nil {
			logger.Warn("Failed to initialize Tor proxy", zap.Error(err))
		} else {
			logger.Info("Tor proxy initialized successfully")
		}
	}

	// I2Pプロキシの初期化
	if cfg.EnableI2P {
		if err := manager.initializeI2PProxy(); err != nil {
			logger.Warn("Failed to initialize I2P proxy", zap.Error(err))
		} else {
			logger.Info("I2P proxy initialized successfully")
		}
	}

	manager.isActive = true
	return manager, nil
}

// initializeTorProxy はTorプロキシを初期化
func (m *Manager) initializeTorProxy() error {
	// デフォルトのTor SOCKSプロキシポート
	torProxyAddr := "127.0.0.1:9050"
	
	// SOCKSプロキシに接続
	dialer, err := proxy.SOCKS5("tcp", torProxyAddr, nil, proxy.Direct)
	if err != nil {
		return fmt.Errorf("failed to create Tor SOCKS5 proxy: %w", err)
	}

	// 接続テスト
	testConn, err := dialer.Dial("tcp", "check.torproject.org:443")
	if err != nil {
		return fmt.Errorf("failed to connect through Tor: %w", err)
	}
	testConn.Close()

	m.torProxy = dialer
	return nil
}

// initializeI2PProxy はI2Pプロキシを初期化
func (m *Manager) initializeI2PProxy() error {
	// デフォルトのI2P HTTPプロキシポート
	i2pProxyAddr := "127.0.0.1:4444"
	
	// I2PはHTTPプロキシを使用
	proxyURL, err := url.Parse(fmt.Sprintf("http://%s", i2pProxyAddr))
	if err != nil {
		return fmt.Errorf("failed to parse I2P proxy URL: %w", err)
	}

	// HTTPクライアントの作成
	transport := &http.Transport{
		Proxy: http.ProxyURL(proxyURL),
	}

	// 接続テスト
	client := &http.Client{
		Transport: transport,
		Timeout:   30 * time.Second,
	}

	resp, err := client.Get("http://i2p-projekt.i2p")
	if err != nil {
		return fmt.Errorf("failed to connect through I2P: %w", err)
	}
	resp.Body.Close()

	// I2PプロキシをSOCKS互換ダイアラーでラップ
	m.i2pProxy = &i2pDialer{transport: transport}
	return nil
}

// GetAnonymousConnection は匿名接続を取得
func (m *Manager) GetAnonymousConnection(address string) (net.Conn, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if !m.isActive {
		return nil, fmt.Errorf("privacy manager is not active")
	}

	// Tor経由の接続を優先
	if m.config.EnableTor && m.torProxy != nil {
		conn, err := m.torProxy.Dial("tcp", address)
		if err == nil {
			m.logger.Debug("Connected through Tor", zap.String("address", address))
			return conn, nil
		}
		m.logger.Warn("Tor connection failed, falling back", zap.Error(err))
	}

	// I2P経由の接続
	if m.config.EnableI2P && m.i2pProxy != nil {
		conn, err := m.i2pProxy.Dial("tcp", address)
		if err == nil {
			m.logger.Debug("Connected through I2P", zap.String("address", address))
			return conn, nil
		}
		m.logger.Warn("I2P connection failed", zap.Error(err))
	}

	// プライバシー設定が有効だが接続できない場合はエラー
	if m.config.EnableTor || m.config.EnableI2P {
		return nil, fmt.Errorf("anonymous connection required but unavailable")
	}

	// 通常の接続
	return net.Dial("tcp", address)
}

// ObfuscateIPAddress はIPアドレスを難読化
func (m *Manager) ObfuscateIPAddress(ipAddr string) string {
	if !m.config.HideIPAddresses {
		return ipAddr
	}

	return m.addressObfuscator.Obfuscate(ipAddr)
}

// RegisterAnonymousMiner は匿名マイナーを登録
func (m *Manager) RegisterAnonymousMiner(realAddress string, payoutAddress string) (*AnonymousMiner, error) {
	if !m.config.AnonymousMining {
		return nil, fmt.Errorf("anonymous mining is not enabled")
	}

	m.anonymousPool.mu.Lock()
	defer m.anonymousPool.mu.Unlock()

	// 既存の登録をチェック
	if pseudonym, exists := m.anonymousPool.pseudonymMap[realAddress]; exists {
		return m.anonymousPool.anonymousMiners[pseudonym], nil
	}

	// 新しい仮名を生成
	pseudonym := m.generatePseudonym()
	
	// ペイアウトアドレスを暗号化（簡略化）
	encryptedPayout := m.encryptPayoutAddress(payoutAddress)

	miner := &AnonymousMiner{
		Pseudonym:     pseudonym,
		RealAddress:   realAddress,
		ShareCount:    0,
		LastActivity:  time.Now(),
		TotalEarnings: 0,
		PayoutAddress: encryptedPayout,
	}

	m.anonymousPool.anonymousMiners[pseudonym] = miner
	m.anonymousPool.pseudonymMap[realAddress] = pseudonym

	m.logger.Info("Anonymous miner registered",
		zap.String("pseudonym", pseudonym),
		zap.String("obfuscated_address", m.ObfuscateIPAddress(realAddress)))

	return miner, nil
}

// GetAnonymousMinerByAddress は実アドレスから匿名マイナーを取得
func (m *Manager) GetAnonymousMinerByAddress(realAddress string) (*AnonymousMiner, error) {
	m.anonymousPool.mu.RLock()
	defer m.anonymousPool.mu.RUnlock()

	pseudonym, exists := m.anonymousPool.pseudonymMap[realAddress]
	if !exists {
		return nil, fmt.Errorf("miner not found")
	}

	return m.anonymousPool.anonymousMiners[pseudonym], nil
}

// UpdateMinerActivity はマイナーの活動を更新
func (m *Manager) UpdateMinerActivity(realAddress string, shares uint64, earnings uint64) error {
	miner, err := m.GetAnonymousMinerByAddress(realAddress)
	if err != nil {
		return err
	}

	m.anonymousPool.mu.Lock()
	defer m.anonymousPool.mu.Unlock()

	miner.ShareCount += shares
	miner.TotalEarnings += earnings
	miner.LastActivity = time.Now()

	return nil
}

// GetAnonymousStats は匿名統計を取得
func (m *Manager) GetAnonymousStats() map[string]interface{} {
	m.anonymousPool.mu.RLock()
	defer m.anonymousPool.mu.RUnlock()

	activeMiners := 0
	totalShares := uint64(0)
	totalEarnings := uint64(0)

	for _, miner := range m.anonymousPool.anonymousMiners {
		if time.Since(miner.LastActivity) < 24*time.Hour {
			activeMiners++
		}
		totalShares += miner.ShareCount
		totalEarnings += miner.TotalEarnings
	}

	return map[string]interface{}{
		"total_anonymous_miners": len(m.anonymousPool.anonymousMiners),
		"active_miners_24h":      activeMiners,
		"total_shares":          totalShares,
		"total_earnings":        totalEarnings,
		"tor_enabled":           m.config.EnableTor && m.torProxy != nil,
		"i2p_enabled":           m.config.EnableI2P && m.i2pProxy != nil,
		"ip_hiding_enabled":     m.config.HideIPAddresses,
	}
}

// SanitizeLogEntry はログエントリから機密情報を削除
func (m *Manager) SanitizeLogEntry(entry map[string]interface{}) map[string]interface{} {
	sanitized := make(map[string]interface{})
	
	for key, value := range entry {
		switch key {
		case "ip_address", "real_address", "wallet_address":
			if m.config.HideIPAddresses {
				sanitized[key] = m.ObfuscateIPAddress(fmt.Sprintf("%v", value))
			} else {
				sanitized[key] = value
			}
		case "miner_id":
			if m.config.AnonymousMining {
				// マイナーIDを仮名に変換
				if realAddr, ok := value.(string); ok {
					if pseudonym, exists := m.anonymousPool.pseudonymMap[realAddr]; exists {
						sanitized[key] = pseudonym
					} else {
						sanitized[key] = "anonymous"
					}
				}
			} else {
				sanitized[key] = value
			}
		default:
			sanitized[key] = value
		}
	}
	
	return sanitized
}

// Shutdown はプライバシーマネージャーをシャットダウン
func (m *Manager) Shutdown() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.isActive = false
	
	// リソースのクリーンアップ
	m.anonymousPool = nil
	m.torProxy = nil
	m.i2pProxy = nil
	
	m.logger.Info("Privacy manager shutdown complete")
	return nil
}

// Helper functions

// NewAnonymousPool は新しい匿名プールを作成
func NewAnonymousPool() *AnonymousPool {
	return &AnonymousPool{
		anonymousMiners: make(map[string]*AnonymousMiner),
		pseudonymMap:    make(map[string]string),
	}
}

// NewAddressObfuscator は新しいアドレス難読化器を作成
func NewAddressObfuscator() *AddressObfuscator {
	salt := make([]byte, 32)
	rand.Read(salt)
	
	return &AddressObfuscator{
		saltRotationInterval: 1 * time.Hour,
		currentSalt:         salt,
		saltRotatedAt:       time.Now(),
	}
}

// Obfuscate はアドレスを難読化
func (ao *AddressObfuscator) Obfuscate(address string) string {
	ao.mu.RLock()
	defer ao.mu.RUnlock()

	// ソルトローテーションチェック
	if time.Since(ao.saltRotatedAt) > ao.saltRotationInterval {
		ao.mu.RUnlock()
		ao.rotateSalt()
		ao.mu.RLock()
	}

	// アドレスとソルトを組み合わせてハッシュ化
	combined := append([]byte(address), ao.currentSalt...)
	hash := make([]byte, 16)
	for i := range hash {
		if i < len(combined) {
			hash[i] = combined[i]
		}
	}

	// 先頭6文字のみ表示
	return fmt.Sprintf("anon_%s...", hex.EncodeToString(hash)[:6])
}

// rotateSalt はソルトをローテーション
func (ao *AddressObfuscator) rotateSalt() {
	ao.mu.Lock()
	defer ao.mu.Unlock()

	ao.previousSalt = ao.currentSalt
	ao.currentSalt = make([]byte, 32)
	rand.Read(ao.currentSalt)
	ao.saltRotatedAt = time.Now()
}

// generatePseudonym は仮名を生成
func (m *Manager) generatePseudonym() string {
	// ランダムな形容詞と名詞の組み合わせ
	adjectives := []string{"Swift", "Silent", "Crypto", "Shadow", "Stealth", "Phantom", "Ghost", "Hidden"}
	nouns := []string{"Miner", "Worker", "Node", "Hash", "Block", "Chain", "Proof", "Validator"}
	
	adjIdx := randInt(len(adjectives))
	nounIdx := randInt(len(nouns))
	suffix := randInt(9999)
	
	return fmt.Sprintf("%s%s%04d", adjectives[adjIdx], nouns[nounIdx], suffix)
}

// encryptPayoutAddress はペイアウトアドレスを暗号化（簡略化）
func (m *Manager) encryptPayoutAddress(address string) string {
	// 実際の実装では適切な暗号化を使用
	encoded := hex.EncodeToString([]byte(address))
	return "encrypted_" + encoded
}

// randInt は指定された範囲の乱数を生成
func randInt(max int) int {
	b := make([]byte, 1)
	rand.Read(b)
	return int(b[0]) % max
}

// i2pDialer はI2P用のダイアラー実装
type i2pDialer struct {
	transport *http.Transport
}

func (d *i2pDialer) Dial(network, addr string) (net.Conn, error) {
	// I2PはHTTPプロキシなので、実際のTCP接続は難しい
	// ここでは簡略化した実装
	return nil, fmt.Errorf("I2P TCP connections not implemented")
}

// ProxyType はプロキシタイプ
type ProxyType string

const (
	ProxyTypeTor    ProxyType = "tor"
	ProxyTypeI2P    ProxyType = "i2p"
	ProxyTypeDirect ProxyType = "direct"
)

// GetConnectionType は現在の接続タイプを取得
func (m *Manager) GetConnectionType() ProxyType {
	if m.config.EnableTor && m.torProxy != nil {
		return ProxyTypeTor
	}
	if m.config.EnableI2P && m.i2pProxy != nil {
		return ProxyTypeI2P
	}
	return ProxyTypeDirect
}

// IsAnonymousConnection は匿名接続が有効かチェック
func (m *Manager) IsAnonymousConnection() bool {
	return m.GetConnectionType() != ProxyTypeDirect
}