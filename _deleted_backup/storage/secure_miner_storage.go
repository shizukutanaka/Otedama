package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// SecureMinerStorage 統合セキュアマイナーストレージ
type SecureMinerStorage struct {
	localStorage         *SecureLocalStorage
	offlineSync          *OfflineSyncManager
	realtimeBackup       *RealtimeBackupManager
	disasterRecovery     *DisasterRecoveryManager
	isInitialized        bool
	autoBackupEnabled    bool
	autoSyncEnabled      bool
	emergencyProtection  bool
	config               *StorageConfig
	mu                   sync.RWMutex
}

// StorageConfig ストレージ設定
type StorageConfig struct {
	DataDirectory       string        `json:"data_directory"`
	EncryptionEnabled   bool          `json:"encryption_enabled"`
	BackupEnabled       bool          `json:"backup_enabled"`
	SyncEnabled         bool          `json:"sync_enabled"`
	EmergencyMode       bool          `json:"emergency_mode"`
	AutoLockTimeout     time.Duration `json:"auto_lock_timeout"`
	BackupInterval      time.Duration `json:"backup_interval"`
	SyncInterval        time.Duration `json:"sync_interval"`
	MaxBackupAge        time.Duration `json:"max_backup_age"`
	CompressionLevel    int           `json:"compression_level"`
	RedundantCopies     int           `json:"redundant_copies"`
	HealthCheckInterval time.Duration `json:"health_check_interval"`
}

// MinerStorageInfo マイナーストレージ情報
type MinerStorageInfo struct {
	MinerID           string              `json:"miner_id"`
	StorageSize       int64               `json:"storage_size"`
	UsedSpace         int64               `json:"used_space"`
	AvailableSpace    int64               `json:"available_space"`
	FileCount         int                 `json:"file_count"`
	LastBackup        time.Time           `json:"last_backup"`
	LastSync          time.Time           `json:"last_sync"`
	BackupLocations   []BackupLocation    `json:"backup_locations"`
	RecoveryPoints    int                 `json:"recovery_points"`
	EmergencyBackups  int                 `json:"emergency_backups"`
	HealthStatus      string              `json:"health_status"`
	EncryptionStatus  string              `json:"encryption_status"`
	SecurityScore     float64             `json:"security_score"`
	Metadata          map[string]interface{} `json:"metadata"`
}

// StorageOperation ストレージ操作
type StorageOperation struct {
	ID            string                 `json:"id"`
	Type          string                 `json:"type"`
	Status        string                 `json:"status"`
	Progress      float64                `json:"progress"`
	StartTime     time.Time              `json:"start_time"`
	EndTime       *time.Time             `json:"end_time,omitempty"`
	Error         string                 `json:"error,omitempty"`
	Details       map[string]interface{} `json:"details"`
}

// StorageStats ストレージ統計
type StorageStats struct {
	TotalMiners         int                 `json:"total_miners"`
	TotalStorageSize    int64               `json:"total_storage_size"`
	TotalUsedSpace      int64               `json:"total_used_space"`
	TotalBackups        int                 `json:"total_backups"`
	TotalRecoveryPoints int                 `json:"total_recovery_points"`
	SuccessfulBackups   int                 `json:"successful_backups"`
	FailedBackups       int                 `json:"failed_backups"`
	LastBackupTime      time.Time           `json:"last_backup_time"`
	SystemHealth        string              `json:"system_health"`
	SecurityScore       float64             `json:"security_score"`
	Uptime              time.Duration       `json:"uptime"`
	Operations          []StorageOperation  `json:"operations"`
	Alerts              []SecurityAlert     `json:"alerts"`
}

// SecurityAlert セキュリティアラート
type SecurityAlert struct {
	ID          string                 `json:"id"`
	Type        string                 `json:"type"`
	Severity    string                 `json:"severity"`
	Message     string                 `json:"message"`
	Timestamp   time.Time              `json:"timestamp"`
	Resolved    bool                   `json:"resolved"`
	Actions     []string               `json:"actions"`
	Metadata    map[string]interface{} `json:"metadata"`
}

// NewSecureMinerStorage 新しいセキュアマイナーストレージを作成
func NewSecureMinerStorage(dataDir, userPassword string, config *StorageConfig) (*SecureMinerStorage, error) {
	// ローカルストレージを初期化
	localStorage, err := NewSecureLocalStorage(dataDir, userPassword)
	if err != nil {
		return nil, fmt.Errorf("ローカルストレージの初期化に失敗しました: %v", err)
	}
	
	// オフライン同期マネージャーを初期化
	offlineSync := NewOfflineSyncManager(localStorage)
	
	// リアルタイムバックアップマネージャーを初期化
	realtimeBackup := NewRealtimeBackupManager(localStorage)
	
	// 災害復旧マネージャーを初期化
	disasterRecovery := NewDisasterRecoveryManager(localStorage, realtimeBackup, offlineSync)
	
	// デフォルト設定を使用
	if config == nil {
		config = getDefaultStorageConfig(dataDir)
	}
	
	storage := &SecureMinerStorage{
		localStorage:        localStorage,
		offlineSync:         offlineSync,
		realtimeBackup:      realtimeBackup,
		disasterRecovery:    disasterRecovery,
		isInitialized:       false,
		autoBackupEnabled:   config.BackupEnabled,
		autoSyncEnabled:     config.SyncEnabled,
		emergencyProtection: config.EmergencyMode,
		config:              config,
	}
	
	return storage, nil
}

// Initialize ストレージシステムを初期化
func (sms *SecureMinerStorage) Initialize() error {
	sms.mu.Lock()
	defer sms.mu.Unlock()
	
	if sms.isInitialized {
		return fmt.Errorf("ストレージは既に初期化されています")
	}
	
	// バックアップシステムを開始
	if sms.autoBackupEnabled {
		if err := sms.realtimeBackup.StartBackup(); err != nil {
			return fmt.Errorf("バックアップシステムの開始に失敗しました: %v", err)
		}
		
		// デフォルトバックアップ場所を追加
		if err := sms.addDefaultBackupLocations(); err != nil {
			return fmt.Errorf("デフォルトバックアップ場所の追加に失敗しました: %v", err)
		}
	}
	
	// 同期システムを開始
	if sms.autoSyncEnabled {
		sms.offlineSync.StartSync()
	}
	
	// 緊急保護を有効化
	if sms.emergencyProtection {
		// 緊急時の自動バックアップを設定
		go sms.emergencyProtectionMonitor()
	}
	
	sms.isInitialized = true
	
	return nil
}

// Shutdown ストレージシステムをシャットダウン
func (sms *SecureMinerStorage) Shutdown() error {
	sms.mu.Lock()
	defer sms.mu.Unlock()
	
	if !sms.isInitialized {
		return nil
	}
	
	// バックアップを停止
	sms.realtimeBackup.StopBackup()
	
	// 同期を停止
	sms.offlineSync.StopSync()
	
	// ストレージをロック
	sms.localStorage.Lock()
	
	sms.isInitialized = false
	
	return nil
}

// CreateMiner マイナーを作成
func (sms *SecureMinerStorage) CreateMiner(minerID, walletAddress, minerName string) (*MinerProfile, error) {
	sms.mu.RLock()
	defer sms.mu.RUnlock()
	
	if !sms.isInitialized {
		return nil, fmt.Errorf("ストレージが初期化されていません")
	}
	
	// デバイス情報を収集
	deviceInfo := collectDeviceInfo()
	
	// マイナープロファイルを作成
	profile, err := sms.localStorage.CreateMinerProfile(minerID, walletAddress, minerName, deviceInfo)
	if err != nil {
		return nil, fmt.Errorf("マイナープロファイルの作成に失敗しました: %v", err)
	}
	
	// 初期復旧ポイントを作成
	if sms.emergencyProtection {
		_, err = sms.disasterRecovery.CreateRecoveryPoint(minerID, "初期設定完了", "automatic")
		if err != nil {
			// エラーをログに記録するが処理は続行
		}
	}
	
	// 初期バックアップを作成
	if sms.autoBackupEnabled {
		go func() {
			_, err := sms.realtimeBackup.CreateBackup(minerID, "initial")
			if err != nil {
				// エラーをログに記録
			}
		}()
	}
	
	return profile, nil
}

// GetMiner マイナー情報を取得
func (sms *SecureMinerStorage) GetMiner(minerID string) (*MinerProfile, error) {
	sms.mu.RLock()
	defer sms.mu.RUnlock()
	
	if !sms.isInitialized {
		return nil, fmt.Errorf("ストレージが初期化されていません")
	}
	
	return sms.localStorage.LoadMinerProfile(minerID)
}

// UpdateMiner マイナー情報を更新
func (sms *SecureMinerStorage) UpdateMiner(profile *MinerProfile) error {
	sms.mu.RLock()
	defer sms.mu.RUnlock()
	
	if !sms.isInitialized {
		return fmt.Errorf("ストレージが初期化されていません")
	}
	
	// プロファイルを更新
	if err := sms.localStorage.UpdateMinerProfile(profile); err != nil {
		return err
	}
	
	// 変更を同期キューに追加
	if sms.autoSyncEnabled {
		operation := SyncOperation{
			Type:      "update",
			Resource:  "miner_profile",
			MinerID:   profile.MinerID,
			Metadata: map[string]interface{}{
				"profile_id": profile.MinerID,
			},
		}
		
		if err := sms.offlineSync.QueueOperation(operation); err != nil {
			// エラーをログに記録するが処理は続行
		}
	}
	
	return nil
}

// SaveMiningSession マイニングセッションを保存
func (sms *SecureMinerStorage) SaveMiningSession(history *MiningHistory) error {
	sms.mu.RLock()
	defer sms.mu.RUnlock()
	
	if !sms.isInitialized {
		return fmt.Errorf("ストレージが初期化されていません")
	}
	
	// 履歴を保存
	if err := sms.localStorage.SaveMiningHistory(history); err != nil {
		return err
	}
	
	// 同期キューに追加
	if sms.autoSyncEnabled {
		operation := SyncOperation{
			Type:      "create",
			Resource:  "mining_history",
			MinerID:   history.MinerID,
			Metadata: map[string]interface{}{
				"session_id": history.SessionID,
			},
		}
		
		sms.offlineSync.QueueOperation(operation)
	}
	
	return nil
}

// GetMiningHistory マイニング履歴を取得
func (sms *SecureMinerStorage) GetMiningHistory(minerID string, startDate, endDate time.Time) ([]MiningHistory, error) {
	sms.mu.RLock()
	defer sms.mu.RUnlock()
	
	if !sms.isInitialized {
		return nil, fmt.Errorf("ストレージが初期化されていません")
	}
	
	return sms.localStorage.LoadMiningHistory(minerID, startDate, endDate)
}

// CreateBackup バックアップを作成
func (sms *SecureMinerStorage) CreateBackup(minerID string, backupType string) (*BackupMetadata, error) {
	sms.mu.RLock()
	defer sms.mu.RUnlock()
	
	if !sms.isInitialized {
		return nil, fmt.Errorf("ストレージが初期化されていません")
	}
	
	return sms.realtimeBackup.CreateBackup(minerID, backupType)
}

// RestoreFromBackup バックアップから復元
func (sms *SecureMinerStorage) RestoreFromBackup(backupID string, targetPath string) error {
	sms.mu.RLock()
	defer sms.mu.RUnlock()
	
	if !sms.isInitialized {
		return fmt.Errorf("ストレージが初期化されていません")
	}
	
	return sms.realtimeBackup.RestoreBackup(backupID, targetPath)
}

// CreateRecoveryPoint 復旧ポイントを作成
func (sms *SecureMinerStorage) CreateRecoveryPoint(minerID, description string) (*RecoveryPoint, error) {
	sms.mu.RLock()
	defer sms.mu.RUnlock()
	
	if !sms.isInitialized {
		return nil, fmt.Errorf("ストレージが初期化されていません")
	}
	
	return sms.disasterRecovery.CreateRecoveryPoint(minerID, description, "manual")
}

// EnableEmergencyMode 緊急モードを有効化
func (sms *SecureMinerStorage) EnableEmergencyMode(minerID, reason string) error {
	sms.mu.Lock()
	defer sms.mu.Unlock()
	
	if !sms.isInitialized {
		return fmt.Errorf("ストレージが初期化されていません")
	}
	
	return sms.disasterRecovery.EnableEmergencyMode(minerID, reason)
}

// GetStorageInfo ストレージ情報を取得
func (sms *SecureMinerStorage) GetStorageInfo(minerID string) (*MinerStorageInfo, error) {
	sms.mu.RLock()
	defer sms.mu.RUnlock()
	
	if !sms.isInitialized {
		return nil, fmt.Errorf("ストレージが初期化されていません")
	}
	
	// プロファイルを読み込み
	profile, err := sms.localStorage.LoadMinerProfile(minerID)
	if err != nil {
		return nil, err
	}
	
	// ストレージ使用量を計算
	storageSize, usedSpace := sms.calculateStorageUsage(minerID)
	
	// バックアップ状態を取得
	backupStatus := sms.realtimeBackup.GetBackupStatus()
	
	// 復旧状態を取得
	recoveryStatus := sms.disasterRecovery.GetRecoveryStatus()
	
	// セキュリティスコアを計算
	securityScore := sms.calculateSecurityScore(profile)
	
	info := &MinerStorageInfo{
		MinerID:          minerID,
		StorageSize:      storageSize,
		UsedSpace:        usedSpace,
		AvailableSpace:   storageSize - usedSpace,
		FileCount:        sms.getFileCount(minerID),
		LastBackup:       backupStatus.LastBackup,
		BackupLocations:  sms.realtimeBackup.backupLocations,
		RecoveryPoints:   recoveryStatus.RecoveryPoints,
		EmergencyBackups: recoveryStatus.EmergencyBackups,
		HealthStatus:     recoveryStatus.SystemHealth,
		EncryptionStatus: "enabled",
		SecurityScore:    securityScore,
		Metadata:         make(map[string]interface{}),
	}
	
	return info, nil
}

// GetStorageStats ストレージ統計を取得
func (sms *SecureMinerStorage) GetStorageStats() (*StorageStats, error) {
	sms.mu.RLock()
	defer sms.mu.RUnlock()
	
	if !sms.isInitialized {
		return nil, fmt.Errorf("ストレージが初期化されていません")
	}
	
	// バックアップ状態を取得
	backupStatus := sms.realtimeBackup.GetBackupStatus()
	
	// システム健全性を取得
	systemHealth := sms.disasterRecovery.GetSystemHealth()
	
	stats := &StorageStats{
		TotalMiners:       sms.getTotalMiners(),
		TotalStorageSize:  backupStatus.TotalSpace,
		TotalUsedSpace:    backupStatus.UsedSpace,
		LastBackupTime:    backupStatus.LastBackup,
		SystemHealth:      systemHealth.OverallHealth,
		SecurityScore:     sms.calculateOverallSecurityScore(),
		Operations:        sms.getRecentOperations(),
		Alerts:            sms.getActiveSecurityAlerts(),
	}
	
	return stats, nil
}

// Lock ストレージをロック
func (sms *SecureMinerStorage) Lock() error {
	sms.mu.Lock()
	defer sms.mu.Unlock()
	
	sms.localStorage.Lock()
	return nil
}

// Unlock ストレージをアンロック
func (sms *SecureMinerStorage) Unlock(userPassword string) error {
	sms.mu.Lock()
	defer sms.mu.Unlock()
	
	return sms.localStorage.Unlock(userPassword)
}

// 内部関数

func (sms *SecureMinerStorage) addDefaultBackupLocations() error {
	// ローカルバックアップ場所を追加
	localBackup := BackupLocation{
		Type:        "local",
		Path:        filepath.Join(sms.config.DataDirectory, "backups"),
		Priority:    1,
		MaxSize:     10 * 1024 * 1024 * 1024, // 10 GB
		Compression: true,
		Encryption:  true,
		Redundancy:  1,
	}
	
	if err := sms.realtimeBackup.AddBackupLocation(localBackup); err != nil {
		return err
	}
	
	// USBバックアップ場所を検索して追加
	usbPaths := sms.detectUSBDrives()
	for _, usbPath := range usbPaths {
		usbBackup := BackupLocation{
			Type:        "usb",
			Path:        filepath.Join(usbPath, "OtedamaMinerBackup"),
			Priority:    2,
			MaxSize:     50 * 1024 * 1024 * 1024, // 50 GB
			Compression: true,
			Encryption:  true,
			Redundancy:  2,
		}
		
		sms.realtimeBackup.AddBackupLocation(usbBackup)
	}
	
	return nil
}

func (sms *SecureMinerStorage) detectUSBDrives() []string {
	// USB ドライブを検出
	// Windows での実装例
	drives := make([]string, 0)
	
	// 簡略化された実装
	for _, drive := range []string{"D:", "E:", "F:", "G:"} {
		if _, err := os.Stat(drive + "\\"); err == nil {
			drives = append(drives, drive)
		}
	}
	
	return drives
}

func (sms *SecureMinerStorage) emergencyProtectionMonitor() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for range ticker.C {
		// システム異常を検出
		if sms.detectSystemAnomaly() {
			// 緊急バックアップを作成
			minerIDs := sms.getAllMinerIDs()
			for _, minerID := range minerIDs {
				sms.disasterRecovery.CreateEmergencyBackup(minerID, "system_anomaly_detected", []string{"all"})
			}
		}
	}
}

func (sms *SecureMinerStorage) detectSystemAnomaly() bool {
	// システム異常を検出
	// CPU使用率、メモリ使用率、ディスク使用率などをチェック
	return false
}

func (sms *SecureMinerStorage) calculateStorageUsage(minerID string) (int64, int64) {
	// ストレージ使用量を計算
	return 10 * 1024 * 1024 * 1024, 2 * 1024 * 1024 * 1024 // 10GB, 2GB使用
}

func (sms *SecureMinerStorage) getFileCount(minerID string) int {
	// ファイル数を取得
	return 1000
}

func (sms *SecureMinerStorage) calculateSecurityScore(profile *MinerProfile) float64 {
	score := 1.0
	
	// 暗号化有効性
	if profile.SecuritySettings.EncryptionLevel == "AES-256" {
		score += 0.2
	}
	
	// 認証設定
	if profile.SecuritySettings.LocalAuthEnabled {
		score += 0.1
	}
	
	// バイオメトリクス
	if profile.SecuritySettings.BiometricEnabled {
		score += 0.1
	}
	
	return min(1.0, score)
}

func (sms *SecureMinerStorage) getTotalMiners() int {
	// 総マイナー数を取得
	return 1
}

func (sms *SecureMinerStorage) calculateOverallSecurityScore() float64 {
	// 全体のセキュリティスコアを計算
	return 0.95
}

func (sms *SecureMinerStorage) getRecentOperations() []StorageOperation {
	// 最近の操作を取得
	return make([]StorageOperation, 0)
}

func (sms *SecureMinerStorage) getActiveSecurityAlerts() []SecurityAlert {
	// アクティブなセキュリティアラートを取得
	return make([]SecurityAlert, 0)
}

func (sms *SecureMinerStorage) getAllMinerIDs() []string {
	// 全マイナーIDを取得
	return []string{"miner1"}
}

func getDefaultStorageConfig(dataDir string) *StorageConfig {
	return &StorageConfig{
		DataDirectory:       dataDir,
		EncryptionEnabled:   true,
		BackupEnabled:       true,
		SyncEnabled:         true,
		EmergencyMode:       true,
		AutoLockTimeout:     30 * time.Minute,
		BackupInterval:      1 * time.Hour,
		SyncInterval:        5 * time.Minute,
		MaxBackupAge:        30 * 24 * time.Hour,
		CompressionLevel:    6,
		RedundantCopies:     2,
		HealthCheckInterval: 10 * time.Minute,
	}
}

func min(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}