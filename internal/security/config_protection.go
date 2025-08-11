package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"time"
)

// Permission constants
const (
	PermissionPoolConfig     = "pool_config"
	PermissionMasterAdmin    = "master_admin"
	PermissionFeeSettings    = "fee_settings"
	PermissionSystemControl  = "system_control"
	PermissionAuditView      = "audit_view"
)

// AdminProtection represents admin protection features
type AdminProtection struct {
	enabled bool
	mu      sync.RWMutex
}

// AdminSession represents an admin session
type AdminSession struct {
	AdminID     string
	SessionID   string
	Permissions []string
}

// ValidateSession validates a session with required permission
func (ap *AdminProtection) ValidateSession(sessionID, permission string) (*AdminSession, error) {
	// Stub implementation
	return &AdminSession{
		AdminID:     "admin",
		SessionID:   sessionID,
		Permissions: []string{permission, PermissionMasterAdmin},
	}, nil
}

// UpdateProtectedConfig updates a protected configuration
func (ap *AdminProtection) UpdateProtectedConfig(sessionID, configName string, data interface{}) error {
	// Stub implementation
	return nil
}

// GetProtectedConfig retrieves a protected configuration
func (ap *AdminProtection) GetProtectedConfig(sessionID, configName string) ([]byte, error) {
	// Stub implementation - would retrieve from secure storage
	return []byte{}, nil
}

// ConfigProtectionManager 設定保護マネージャー
type ConfigProtectionManager struct {
	adminProtection *AdminProtection
	configLocks     map[string]*ConfigLock
	configHistory   map[string][]ConfigVersion
	encryptionKey   []byte
	mu              sync.RWMutex
}

// ConfigLock 設定ロック
type ConfigLock struct {
	ConfigName    string
	LockedBy      string
	LockedAt      time.Time
	ExpiresAt     time.Time
	LockReason    string
	SessionID     string
	Active        bool
}

// ConfigVersion 設定バージョン
type ConfigVersion struct {
	Version     int
	Data        []byte
	ModifiedBy  string
	ModifiedAt  time.Time
	Description string
	Checksum    []byte
}

// ProtectedPoolConfig 保護されたプール設定
type ProtectedPoolConfig struct {
	PoolName        string    `json:"pool_name"`
	PoolAddress     string    `json:"pool_address"`
	PoolPort        int       `json:"pool_port"`
	MinimumPayout   float64   `json:"minimum_payout"`
	PayoutInterval  int       `json:"payout_interval"`
	MaxConnections  int       `json:"max_connections"`
	DifficultyRange struct {
		Min float64 `json:"min"`
		Max float64 `json:"max"`
	} `json:"difficulty_range"`
	AllowedAlgorithms []string  `json:"allowed_algorithms"`
	LastModified      time.Time `json:"last_modified"`
	ModifiedBy        string    `json:"modified_by"`
}

// ProtectedFeeConfig 保護された手数料設定
type ProtectedFeeConfig struct {
	PoolFeePercent    float64   `json:"pool_fee_percent"`
	DevFeePercent     float64   `json:"dev_fee_percent"`
	WithdrawalFee     float64   `json:"withdrawal_fee"`
	MinimumFee        float64   `json:"minimum_fee"`
	FeeAddress        string    `json:"fee_address"`
	FeePaymentMethod  string    `json:"fee_payment_method"`
	TierFees          []TierFee `json:"tier_fees"`
	LastModified      time.Time `json:"last_modified"`
	ModifiedBy        string    `json:"modified_by"`
}

// TierFee 階層手数料
type TierFee struct {
	MinHashRate   float64 `json:"min_hash_rate"`
	FeePercent    float64 `json:"fee_percent"`
	Description   string  `json:"description"`
}

// ProtectedSystemConfig 保護されたシステム設定
type ProtectedSystemConfig struct {
	DatabaseConfig struct {
		Host         string `json:"host"`
		Port         int    `json:"port"`
		Database     string `json:"database"`
		Username     string `json:"username"`
		MaxConnections int  `json:"max_connections"`
	} `json:"database_config"`
	LoggingConfig struct {
		Level    string `json:"level"`
		Output   string `json:"output"`
		Rotation struct {
			MaxSize   int `json:"max_size"`
			MaxAge    int `json:"max_age"`
			MaxFiles  int `json:"max_files"`
		} `json:"rotation"`
	} `json:"logging_config"`
	SecurityConfig struct {
		RateLimiting struct {
			Enabled        bool    `json:"enabled"`
			RequestsPerMin int     `json:"requests_per_min"`
			BurstSize      int     `json:"burst_size"`
		} `json:"rate_limiting"`
		IPWhitelist   []string `json:"ip_whitelist"`
		IPBlacklist   []string `json:"ip_blacklist"`
	} `json:"security_config"`
	LastModified time.Time `json:"last_modified"`
	ModifiedBy   string    `json:"modified_by"`
}

// NewConfigProtectionManager 新しい設定保護マネージャーを作成
func NewConfigProtectionManager(adminProtection *AdminProtection) *ConfigProtectionManager {
	encryptionKey := make([]byte, 32)
	rand.Read(encryptionKey)
	
	return &ConfigProtectionManager{
		adminProtection: adminProtection,
		configLocks:     make(map[string]*ConfigLock),
		configHistory:   make(map[string][]ConfigVersion),
		encryptionKey:   encryptionKey,
	}
}

// LockConfig 設定をロック
func (cpm *ConfigProtectionManager) LockConfig(sessionID, configName, reason string) error {
	session, err := cpm.adminProtection.ValidateSession(sessionID, PermissionPoolConfig)
	if err != nil {
		return err
	}
	
	cpm.mu.Lock()
	defer cpm.mu.Unlock()
	
	// 既存のロックをチェック
	if lock, exists := cpm.configLocks[configName]; exists && lock.Active {
		if time.Now().Before(lock.ExpiresAt) {
			return fmt.Errorf("設定は既に %s によってロックされています（期限: %v）", lock.LockedBy, lock.ExpiresAt)
		}
		// 期限切れのロックを削除
		delete(cpm.configLocks, configName)
	}
	
	// 新しいロックを作成
	lock := &ConfigLock{
		ConfigName:  configName,
		LockedBy:    session.AdminID,
		LockedAt:    time.Now(),
		ExpiresAt:   time.Now().Add(30 * time.Minute), // 30分間ロック
		LockReason:  reason,
		SessionID:   sessionID,
		Active:      true,
	}
	
	cpm.configLocks[configName] = lock
	
	return nil
}

// UnlockConfig 設定のロックを解除
func (cpm *ConfigProtectionManager) UnlockConfig(sessionID, configName string) error {
	session, err := cpm.adminProtection.ValidateSession(sessionID, PermissionPoolConfig)
	if err != nil {
		return err
	}
	
	cpm.mu.Lock()
	defer cpm.mu.Unlock()
	
	lock, exists := cpm.configLocks[configName]
	if !exists || !lock.Active {
		return fmt.Errorf("設定はロックされていません")
	}
	
	// ロック所有者またはマスター管理者のみがロックを解除可能
	if lock.LockedBy != session.AdminID && !hasPermission(session.Permissions, PermissionMasterAdmin) {
		return fmt.Errorf("ロックを解除する権限がありません")
	}
	
	delete(cpm.configLocks, configName)
	
	return nil
}

// UpdatePoolConfig プール設定を更新
func (cpm *ConfigProtectionManager) UpdatePoolConfig(sessionID string, config *ProtectedPoolConfig) error {
	session, err := cpm.adminProtection.ValidateSession(sessionID, PermissionPoolConfig)
	if err != nil {
		return err
	}
	
	cpm.mu.Lock()
	defer cpm.mu.Unlock()
	
	// ロック確認
	if err := cpm.checkConfigLock("pool", sessionID); err != nil {
		return err
	}
	
	// 設定の検証
	if err := cpm.validatePoolConfig(config); err != nil {
		return fmt.Errorf("プール設定の検証に失敗しました: %v", err)
	}
	
	// バージョン管理のために現在の設定を保存
	if err := cpm.saveConfigVersion("pool", config, session.AdminID, "プール設定更新"); err != nil {
		return err
	}
	
	// 設定を暗号化して保存
	configData, err := json.Marshal(config)
	if err != nil {
		return fmt.Errorf("設定のシリアライズに失敗しました: %v", err)
	}
	
	encryptedData, err := cpm.encryptConfig(configData)
	if err != nil {
		return fmt.Errorf("設定の暗号化に失敗しました: %v", err)
	}
	
	if err := cpm.adminProtection.UpdateProtectedConfig(sessionID, "pool", encryptedData); err != nil {
		return err
	}
	
	return nil
}

// UpdateFeeConfig 手数料設定を更新
func (cpm *ConfigProtectionManager) UpdateFeeConfig(sessionID string, config *ProtectedFeeConfig) error {
	session, err := cpm.adminProtection.ValidateSession(sessionID, PermissionFeeSettings)
	if err != nil {
		return err
	}
	
	cpm.mu.Lock()
	defer cpm.mu.Unlock()
	
	// ロック確認
	if err := cpm.checkConfigLock("fee", sessionID); err != nil {
		return err
	}
	
	// 設定の検証
	if err := cpm.validateFeeConfig(config); err != nil {
		return fmt.Errorf("手数料設定の検証に失敗しました: %v", err)
	}
	
	// バージョン管理
	if err := cpm.saveConfigVersion("fee", config, session.AdminID, "手数料設定更新"); err != nil {
		return err
	}
	
	// 暗号化して保存
	configData, err := json.Marshal(config)
	if err != nil {
		return fmt.Errorf("設定のシリアライズに失敗しました: %v", err)
	}
	
	encryptedData, err := cpm.encryptConfig(configData)
	if err != nil {
		return fmt.Errorf("設定の暗号化に失敗しました: %v", err)
	}
	
	if err := cpm.adminProtection.UpdateProtectedConfig(sessionID, "fee", encryptedData); err != nil {
		return err
	}
	
	// 重要な変更の場合、追加の承認を要求
	if cpm.isSignificantFeeChange(config) {
		return cpm.requestAdditionalApproval(sessionID, "fee", "重要な手数料変更")
	}
	
	return nil
}

// UpdateSystemConfig システム設定を更新
func (cpm *ConfigProtectionManager) UpdateSystemConfig(sessionID string, config *ProtectedSystemConfig) error {
	session, err := cpm.adminProtection.ValidateSession(sessionID, PermissionSystemControl)
	if err != nil {
		return err
	}
	
	cpm.mu.Lock()
	defer cpm.mu.Unlock()
	
	// ロック確認
	if err := cpm.checkConfigLock("system", sessionID); err != nil {
		return err
	}
	
	// 設定の検証
	if err := cpm.validateSystemConfig(config); err != nil {
		return fmt.Errorf("システム設定の検証に失敗しました: %v", err)
	}
	
	// バージョン管理
	if err := cpm.saveConfigVersion("system", config, session.AdminID, "システム設定更新"); err != nil {
		return err
	}
	
	// 暗号化して保存
	configData, err := json.Marshal(config)
	if err != nil {
		return fmt.Errorf("設定のシリアライズに失敗しました: %v", err)
	}
	
	encryptedData, err := cpm.encryptConfig(configData)
	if err != nil {
		return fmt.Errorf("設定の暗号化に失敗しました: %v", err)
	}
	
	return cpm.adminProtection.UpdateProtectedConfig(sessionID, "system", encryptedData)
}

// GetPoolConfig プール設定を取得
func (cpm *ConfigProtectionManager) GetPoolConfig(sessionID string) (*ProtectedPoolConfig, error) {
	encryptedData, err := cpm.adminProtection.GetProtectedConfig(sessionID, "pool")
	if err != nil {
		return nil, err
	}
	
	decryptedData, err := cpm.decryptConfig(encryptedData)
	if err != nil {
		return nil, fmt.Errorf("設定の復号化に失敗しました: %v", err)
	}
	
	var config ProtectedPoolConfig
	if err := json.Unmarshal(decryptedData, &config); err != nil {
		return nil, fmt.Errorf("設定のデシリアライズに失敗しました: %v", err)
	}
	
	return &config, nil
}

// GetFeeConfig 手数料設定を取得
func (cpm *ConfigProtectionManager) GetFeeConfig(sessionID string) (*ProtectedFeeConfig, error) {
	encryptedData, err := cpm.adminProtection.GetProtectedConfig(sessionID, "fee")
	if err != nil {
		return nil, err
	}
	
	decryptedData, err := cpm.decryptConfig(encryptedData)
	if err != nil {
		return nil, fmt.Errorf("設定の復号化に失敗しました: %v", err)
	}
	
	var config ProtectedFeeConfig
	if err := json.Unmarshal(decryptedData, &config); err != nil {
		return nil, fmt.Errorf("設定のデシリアライズに失敗しました: %v", err)
	}
	
	return &config, nil
}

// GetSystemConfig システム設定を取得
func (cpm *ConfigProtectionManager) GetSystemConfig(sessionID string) (*ProtectedSystemConfig, error) {
	encryptedData, err := cpm.adminProtection.GetProtectedConfig(sessionID, "system")
	if err != nil {
		return nil, err
	}
	
	decryptedData, err := cpm.decryptConfig(encryptedData)
	if err != nil {
		return nil, fmt.Errorf("設定の復号化に失敗しました: %v", err)
	}
	
	var config ProtectedSystemConfig
	if err := json.Unmarshal(decryptedData, &config); err != nil {
		return nil, fmt.Errorf("設定のデシリアライズに失敗しました: %v", err)
	}
	
	return &config, nil
}

// GetConfigHistory 設定履歴を取得
func (cpm *ConfigProtectionManager) GetConfigHistory(sessionID, configName string, limit int) ([]ConfigVersion, error) {
	_, err := cpm.adminProtection.ValidateSession(sessionID, PermissionAuditView)
	if err != nil {
		return nil, err
	}
	
	cpm.mu.RLock()
	defer cpm.mu.RUnlock()
	
	history, exists := cpm.configHistory[configName]
	if !exists {
		return []ConfigVersion{}, nil
	}
	
	if limit <= 0 || limit > len(history) {
		limit = len(history)
	}
	
	// 最新のバージョンから返す
	start := len(history) - limit
	if start < 0 {
		start = 0
	}
	
	result := make([]ConfigVersion, limit)
	copy(result, history[start:])
	
	return result, nil
}

// RollbackConfig 設定をロールバック
func (cpm *ConfigProtectionManager) RollbackConfig(sessionID, configName string, version int) error {
	session, err := cpm.adminProtection.ValidateSession(sessionID, PermissionSystemControl)
	if err != nil {
		return err
	}
	
	// マスター管理者のみがロールバック可能
	if !hasPermission(session.Permissions, PermissionMasterAdmin) {
		return fmt.Errorf("設定のロールバックにはマスター管理者権限が必要です")
	}
	
	cpm.mu.Lock()
	defer cpm.mu.Unlock()
	
	history, exists := cpm.configHistory[configName]
	if !exists {
		return fmt.Errorf("設定履歴が存在しません")
	}
	
	// 指定されたバージョンを検索
	var targetVersion *ConfigVersion
	for _, v := range history {
		if v.Version == version {
			targetVersion = &v
			break
		}
	}
	
	if targetVersion == nil {
		return fmt.Errorf("指定されたバージョンが存在しません: %d", version)
	}
	
	// ロールバック実行
	return cpm.adminProtection.UpdateProtectedConfig(sessionID, configName, targetVersion.Data)
}

// 内部関数

// hasPermission checks if permissions contains the specified permission
func hasPermission(permissions []string, permission string) bool {
	for _, p := range permissions {
		if p == permission {
			return true
		}
	}
	return false
}

func (cpm *ConfigProtectionManager) checkConfigLock(configName, sessionID string) error {
	lock, exists := cpm.configLocks[configName]
	if !exists {
		return fmt.Errorf("設定がロックされていません。先にロックを取得してください")
	}
	
	if !lock.Active || time.Now().After(lock.ExpiresAt) {
		delete(cpm.configLocks, configName)
		return fmt.Errorf("ロックが期限切れです。再度ロックを取得してください")
	}
	
	if lock.SessionID != sessionID {
		return fmt.Errorf("ロックが他のセッションによって取得されています")
	}
	
	return nil
}

func (cpm *ConfigProtectionManager) validatePoolConfig(config *ProtectedPoolConfig) error {
	if config.PoolName == "" {
		return fmt.Errorf("プール名が指定されていません")
	}
	
	if config.PoolAddress == "" {
		return fmt.Errorf("プールアドレスが指定されていません")
	}
	
	if config.PoolPort <= 0 || config.PoolPort > 65535 {
		return fmt.Errorf("無効なプールポートです: %d", config.PoolPort)
	}
	
	if config.MinimumPayout <= 0 {
		return fmt.Errorf("最小支払額は0より大きい必要があります")
	}
	
	if config.PayoutInterval <= 0 {
		return fmt.Errorf("支払間隔は0より大きい必要があります")
	}
	
	if config.MaxConnections <= 0 {
		return fmt.Errorf("最大接続数は0より大きい必要があります")
	}
	
	if config.DifficultyRange.Min <= 0 || config.DifficultyRange.Max <= config.DifficultyRange.Min {
		return fmt.Errorf("無効な難易度範囲です")
	}
	
	if len(config.AllowedAlgorithms) == 0 {
		return fmt.Errorf("許可されたアルゴリズムが指定されていません")
	}
	
	return nil
}

func (cpm *ConfigProtectionManager) validateFeeConfig(config *ProtectedFeeConfig) error {
	if config.PoolFeePercent < 0 || config.PoolFeePercent > 10 {
		return fmt.Errorf("プール手数料は0-10%%の範囲で指定してください")
	}
	
	if config.DevFeePercent < 0 || config.DevFeePercent > 5 {
		return fmt.Errorf("開発者手数料は0-5%%の範囲で指定してください")
	}
	
	if config.WithdrawalFee < 0 {
		return fmt.Errorf("出金手数料は0以上である必要があります")
	}
	
	if config.FeeAddress == "" {
		return fmt.Errorf("手数料アドレスが指定されていません")
	}
	
	// 階層手数料の検証
	for _, tier := range config.TierFees {
		if tier.MinHashRate < 0 {
			return fmt.Errorf("最小ハッシュレートは0以上である必要があります")
		}
		if tier.FeePercent < 0 || tier.FeePercent > 10 {
			return fmt.Errorf("階層手数料は0-10%%の範囲で指定してください")
		}
	}
	
	return nil
}

func (cpm *ConfigProtectionManager) validateSystemConfig(config *ProtectedSystemConfig) error {
	if config.DatabaseConfig.Host == "" {
		return fmt.Errorf("データベースホストが指定されていません")
	}
	
	if config.DatabaseConfig.Port <= 0 || config.DatabaseConfig.Port > 65535 {
		return fmt.Errorf("無効なデータベースポートです")
	}
	
	if config.DatabaseConfig.Database == "" {
		return fmt.Errorf("データベース名が指定されていません")
	}
	
	if config.DatabaseConfig.MaxConnections <= 0 {
		return fmt.Errorf("最大データベース接続数は0より大きい必要があります")
	}
	
	if config.LoggingConfig.Level == "" {
		return fmt.Errorf("ログレベルが指定されていません")
	}
	
	return nil
}

func (cpm *ConfigProtectionManager) saveConfigVersion(configName string, config interface{}, modifiedBy, description string) error {
	configData, err := json.Marshal(config)
	if err != nil {
		return err
	}
	
	checksum := sha256.Sum256(configData)
	
	if _, exists := cpm.configHistory[configName]; !exists {
		cpm.configHistory[configName] = make([]ConfigVersion, 0)
	}
	
	version := len(cpm.configHistory[configName]) + 1
	
	configVersion := ConfigVersion{
		Version:     version,
		Data:        configData,
		ModifiedBy:  modifiedBy,
		ModifiedAt:  time.Now(),
		Description: description,
		Checksum:    checksum[:],
	}
	
	cpm.configHistory[configName] = append(cpm.configHistory[configName], configVersion)
	
	// 履歴サイズ制限（最新50バージョンを保持）
	if len(cpm.configHistory[configName]) > 50 {
		cpm.configHistory[configName] = cpm.configHistory[configName][1:]
	}
	
	return nil
}

func (cpm *ConfigProtectionManager) encryptConfig(data []byte) ([]byte, error) {
	block, err := aes.NewCipher(cpm.encryptionKey)
	if err != nil {
		return nil, err
	}
	
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	
	ciphertext := gcm.Seal(nonce, nonce, data, nil)
	return ciphertext, nil
}

func (cpm *ConfigProtectionManager) decryptConfig(data []byte) ([]byte, error) {
	block, err := aes.NewCipher(cpm.encryptionKey)
	if err != nil {
		return nil, err
	}
	
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	
	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return nil, fmt.Errorf("暗号化されたデータが短すぎます")
	}
	
	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, err
	}
	
	return plaintext, nil
}

func (cpm *ConfigProtectionManager) isSignificantFeeChange(config *ProtectedFeeConfig) bool {
	// 手数料が3%を超える場合は重要な変更とみなす
	return config.PoolFeePercent > 3.0 || config.DevFeePercent > 2.0
}

func (cpm *ConfigProtectionManager) requestAdditionalApproval(sessionID, configType, reason string) error {
	// 追加承認のロジック（簡略化）
	// 実際の実装では、他の管理者への通知や承認プロセスを含む
	return fmt.Errorf("重要な変更には追加の承認が必要です: %s", reason)
}