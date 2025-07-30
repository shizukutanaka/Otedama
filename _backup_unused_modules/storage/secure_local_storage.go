package storage

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// SecureLocalStorage 暗号化されたローカルストレージ
type SecureLocalStorage struct {
	dataDir       string
	encryptionKey []byte
	userKey       []byte
	isLocked      bool
	autoSave      bool
	backupEnabled bool
	mu            sync.RWMutex
}

// MinerProfile マイナープロファイル
type MinerProfile struct {
	MinerID          string                 `json:"miner_id"`
	WalletAddress    string                 `json:"wallet_address"`
	MinerName        string                 `json:"miner_name"`
	DeviceInfo       *DeviceInfo            `json:"device_info"`
	MiningSettings   *MiningSettings        `json:"mining_settings"`
	SecuritySettings *SecuritySettings      `json:"security_settings"`
	CreatedAt        time.Time              `json:"created_at"`
	LastModified     time.Time              `json:"last_modified"`
	BackupKey        []byte                 `json:"backup_key"`
	Checksum         []byte                 `json:"checksum"`
}

// DeviceInfo デバイス情報
type DeviceInfo struct {
	DeviceID       string            `json:"device_id"`
	Hostname       string            `json:"hostname"`
	OS             string            `json:"os"`
	Architecture   string            `json:"architecture"`
	CPUInfo        map[string]string `json:"cpu_info"`
	GPUInfo        []GPUInfo         `json:"gpu_info"`
	Memory         uint64            `json:"memory"`
	StorageInfo    []StorageInfo     `json:"storage_info"`
	NetworkMAC     []string          `json:"network_mac"`
	LastUpdate     time.Time         `json:"last_update"`
}

// GPUInfo GPU情報
type GPUInfo struct {
	Name        string `json:"name"`
	Memory      uint64 `json:"memory"`
	Driver      string `json:"driver"`
	DeviceID    string `json:"device_id"`
	ComputeUnits int   `json:"compute_units"`
}

// StorageInfo ストレージ情報
type StorageInfo struct {
	Path      string `json:"path"`
	Type      string `json:"type"`
	Total     uint64 `json:"total"`
	Available uint64 `json:"available"`
}

// MiningSettings マイニング設定
type MiningSettings struct {
	PreferredAlgorithms []string          `json:"preferred_algorithms"`
	PoolSettings        []PoolSetting     `json:"pool_settings"`
	PowerSettings       *PowerSettings    `json:"power_settings"`
	PerformanceSettings *PerfSettings     `json:"performance_settings"`
	AutoSwitching       bool              `json:"auto_switching"`
	FailoverEnabled     bool              `json:"failover_enabled"`
	LastUpdate          time.Time         `json:"last_update"`
}

// PoolSetting プール設定
type PoolSetting struct {
	PoolName    string  `json:"pool_name"`
	PoolURL     string  `json:"pool_url"`
	Username    string  `json:"username"`
	Password    string  `json:"password"`
	Priority    int     `json:"priority"`
	Algorithm   string  `json:"algorithm"`
	Enabled     bool    `json:"enabled"`
	Backup      bool    `json:"backup"`
}

// PowerSettings 電力設定
type PowerSettings struct {
	MaxPowerLimit   int     `json:"max_power_limit"`
	PowerEfficiency string  `json:"power_efficiency"`
	ThermalLimit    int     `json:"thermal_limit"`
	FanSpeed        string  `json:"fan_speed"`
	Undervolting    bool    `json:"undervolting"`
	PowerCost       float64 `json:"power_cost"`
}

// PerfSettings パフォーマンス設定
type PerfSettings struct {
	CPUThreads      int               `json:"cpu_threads"`
	GPUIntensity    map[string]int    `json:"gpu_intensity"`
	MemorySettings  map[string]int    `json:"memory_settings"`
	OverclockValues map[string]string `json:"overclock_values"`
	SafetyLimits    map[string]int    `json:"safety_limits"`
}

// SecuritySettings セキュリティ設定
type SecuritySettings struct {
	LocalAuthEnabled    bool              `json:"local_auth_enabled"`
	BiometricEnabled    bool              `json:"biometric_enabled"`
	EncryptionLevel     string            `json:"encryption_level"`
	AutoLockTimeout     time.Duration     `json:"auto_lock_timeout"`
	AccessLog           bool              `json:"access_log"`
	RemoteAccessEnabled bool              `json:"remote_access_enabled"`
	AllowedIPs          []string          `json:"allowed_ips"`
	SecurityQuestions   []SecurityQ       `json:"security_questions"`
}

// SecurityQ セキュリティ質問
type SecurityQ struct {
	Question string `json:"question"`
	Answer   []byte `json:"answer"` // ハッシュ化
}

// MiningHistory マイニング履歴
type MiningHistory struct {
	SessionID       string                 `json:"session_id"`
	MinerID         string                 `json:"miner_id"`
	StartTime       time.Time              `json:"start_time"`
	EndTime         *time.Time             `json:"end_time,omitempty"`
	Algorithm       string                 `json:"algorithm"`
	PoolName        string                 `json:"pool_name"`
	HashRate        float64                `json:"hash_rate"`
	SharesAccepted  uint64                 `json:"shares_accepted"`
	SharesRejected  uint64                 `json:"shares_rejected"`
	Earnings        float64                `json:"earnings"`
	PowerConsumption float64               `json:"power_consumption"`
	Temperature     map[string]float64     `json:"temperature"`
	ErrorCount      int                    `json:"error_count"`
	Metadata        map[string]interface{} `json:"metadata"`
	Signature       []byte                 `json:"signature"`
}

// BackupData バックアップデータ
type BackupData struct {
	Version       string                   `json:"version"`
	Timestamp     time.Time                `json:"timestamp"`
	MinerProfile  *MinerProfile            `json:"miner_profile"`
	MiningHistory []MiningHistory          `json:"mining_history"`
	Settings      map[string]interface{}   `json:"settings"`
	Checksum      []byte                   `json:"checksum"`
	Signature     []byte                   `json:"signature"`
}

// NewSecureLocalStorage 新しい暗号化ローカルストレージを作成
func NewSecureLocalStorage(dataDir string, userPassword string) (*SecureLocalStorage, error) {
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, fmt.Errorf("データディレクトリの作成に失敗しました: %v", err)
	}
	
	// ユーザーパスワードから暗号化キーを生成
	userKey := deriveKey(userPassword, []byte("otedama-miner-salt"))
	
	// マスター暗号化キーを生成または読み込み
	encryptionKey, err := loadOrCreateMasterKey(dataDir, userKey)
	if err != nil {
		return nil, fmt.Errorf("暗号化キーの初期化に失敗しました: %v", err)
	}
	
	storage := &SecureLocalStorage{
		dataDir:       dataDir,
		encryptionKey: encryptionKey,
		userKey:       userKey,
		isLocked:      false,
		autoSave:      true,
		backupEnabled: true,
	}
	
	return storage, nil
}

// CreateMinerProfile マイナープロファイルを作成
func (sls *SecureLocalStorage) CreateMinerProfile(minerID, walletAddress, minerName string, deviceInfo *DeviceInfo) (*MinerProfile, error) {
	sls.mu.Lock()
	defer sls.mu.Unlock()
	
	if sls.isLocked {
		return nil, fmt.Errorf("ストレージがロックされています")
	}
	
	// デバイス固有の情報を収集
	if deviceInfo == nil {
		deviceInfo = collectDeviceInfo()
	}
	
	// バックアップキーを生成
	backupKey := make([]byte, 32)
	rand.Read(backupKey)
	
	profile := &MinerProfile{
		MinerID:       minerID,
		WalletAddress: walletAddress,
		MinerName:     minerName,
		DeviceInfo:    deviceInfo,
		MiningSettings: &MiningSettings{
			PreferredAlgorithms: []string{"sha256", "scrypt"},
			PoolSettings:        make([]PoolSetting, 0),
			PowerSettings: &PowerSettings{
				MaxPowerLimit:   300,
				PowerEfficiency: "balanced",
				ThermalLimit:    85,
				FanSpeed:        "auto",
			},
			PerformanceSettings: &PerfSettings{
				CPUThreads:      4,
				GPUIntensity:    make(map[string]int),
				MemorySettings:  make(map[string]int),
				OverclockValues: make(map[string]string),
				SafetyLimits:    make(map[string]int),
			},
			AutoSwitching:   true,
			FailoverEnabled: true,
			LastUpdate:      time.Now(),
		},
		SecuritySettings: &SecuritySettings{
			LocalAuthEnabled:    true,
			EncryptionLevel:     "AES-256",
			AutoLockTimeout:     30 * time.Minute,
			AccessLog:           true,
			RemoteAccessEnabled: false,
			AllowedIPs:          []string{"127.0.0.1"},
			SecurityQuestions:   make([]SecurityQ, 0),
		},
		CreatedAt:    time.Now(),
		LastModified: time.Now(),
		BackupKey:    backupKey,
	}
	
	// チェックサムを計算
	profile.Checksum = sls.calculateChecksum(profile)
	
	// 暗号化して保存
	if err := sls.saveMinerProfile(profile); err != nil {
		return nil, err
	}
	
	// 自動バックアップ
	if sls.backupEnabled {
		go sls.createBackup(profile.MinerID)
	}
	
	return profile, nil
}

// LoadMinerProfile マイナープロファイルを読み込み
func (sls *SecureLocalStorage) LoadMinerProfile(minerID string) (*MinerProfile, error) {
	sls.mu.RLock()
	defer sls.mu.RUnlock()
	
	if sls.isLocked {
		return nil, fmt.Errorf("ストレージがロックされています")
	}
	
	filepath := filepath.Join(sls.dataDir, "miners", minerID+".encrypted")
	
	// 暗号化されたデータを読み込み
	encryptedData, err := os.ReadFile(filepath)
	if err != nil {
		return nil, fmt.Errorf("プロファイルファイルの読み込みに失敗しました: %v", err)
	}
	
	// 復号化
	data, err := sls.decrypt(encryptedData)
	if err != nil {
		return nil, fmt.Errorf("プロファイルの復号化に失敗しました: %v", err)
	}
	
	var profile MinerProfile
	if err := json.Unmarshal(data, &profile); err != nil {
		return nil, fmt.Errorf("プロファイルのデシリアライズに失敗しました: %v", err)
	}
	
	// チェックサム検証
	expectedChecksum := sls.calculateChecksum(&profile)
	if subtle.ConstantTimeCompare(profile.Checksum, expectedChecksum) != 1 {
		return nil, fmt.Errorf("プロファイルの整合性チェックに失敗しました")
	}
	
	return &profile, nil
}

// UpdateMinerProfile マイナープロファイルを更新
func (sls *SecureLocalStorage) UpdateMinerProfile(profile *MinerProfile) error {
	sls.mu.Lock()
	defer sls.mu.Unlock()
	
	if sls.isLocked {
		return fmt.Errorf("ストレージがロックされています")
	}
	
	profile.LastModified = time.Now()
	profile.Checksum = sls.calculateChecksum(profile)
	
	if err := sls.saveMinerProfile(profile); err != nil {
		return err
	}
	
	// 自動バックアップ
	if sls.backupEnabled && sls.autoSave {
		go sls.createBackup(profile.MinerID)
	}
	
	return nil
}

// SaveMiningHistory マイニング履歴を保存
func (sls *SecureLocalStorage) SaveMiningHistory(history *MiningHistory) error {
	sls.mu.Lock()
	defer sls.mu.Unlock()
	
	if sls.isLocked {
		return fmt.Errorf("ストレージがロックされています")
	}
	
	// デジタル署名を追加
	history.Signature = sls.signData(history)
	
	// 日付別にディレクトリを作成
	dateDir := history.StartTime.Format("2006-01")
	historyDir := filepath.Join(sls.dataDir, "history", history.MinerID, dateDir)
	if err := os.MkdirAll(historyDir, 0700); err != nil {
		return fmt.Errorf("履歴ディレクトリの作成に失敗しました: %v", err)
	}
	
	// ファイル名を生成
	filename := fmt.Sprintf("%s_%s.encrypted", history.SessionID, history.StartTime.Format("20060102_150405"))
	filepath := filepath.Join(historyDir, filename)
	
	// シリアライズ
	data, err := json.Marshal(history)
	if err != nil {
		return fmt.Errorf("履歴のシリアライズに失敗しました: %v", err)
	}
	
	// 暗号化して保存
	encryptedData, err := sls.encrypt(data)
	if err != nil {
		return fmt.Errorf("履歴の暗号化に失敗しました: %v", err)
	}
	
	if err := os.WriteFile(filepath, encryptedData, 0600); err != nil {
		return fmt.Errorf("履歴ファイルの保存に失敗しました: %v", err)
	}
	
	return nil
}

// LoadMiningHistory マイニング履歴を読み込み
func (sls *SecureLocalStorage) LoadMiningHistory(minerID string, startDate, endDate time.Time) ([]MiningHistory, error) {
	sls.mu.RLock()
	defer sls.mu.RUnlock()
	
	if sls.isLocked {
		return nil, fmt.Errorf("ストレージがロックされています")
	}
	
	historyDir := filepath.Join(sls.dataDir, "history", minerID)
	
	var histories []MiningHistory
	
	// 日付範囲でディレクトリを検索
	err := filepath.Walk(historyDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // エラーを無視して続行
		}
		
		if !info.IsDir() && filepath.Ext(path) == ".encrypted" {
			// ファイルを読み込み
			encryptedData, err := os.ReadFile(path)
			if err != nil {
				return nil // エラーを無視して続行
			}
			
			// 復号化
			data, err := sls.decrypt(encryptedData)
			if err != nil {
				return nil // エラーを無視して続行
			}
			
			var history MiningHistory
			if err := json.Unmarshal(data, &history); err != nil {
				return nil // エラーを無視して続行
			}
			
			// 日付範囲チェック
			if history.StartTime.After(startDate) && history.StartTime.Before(endDate) {
				// 署名検証
				if sls.verifySignature(&history) {
					histories = append(histories, history)
				}
			}
		}
		
		return nil
	})
	
	if err != nil {
		return nil, fmt.Errorf("履歴の読み込み中にエラーが発生しました: %v", err)
	}
	
	return histories, nil
}

// CreateBackup バックアップを作成
func (sls *SecureLocalStorage) CreateBackup(minerID string) error {
	sls.mu.RLock()
	defer sls.mu.RUnlock()
	
	// プロファイルを読み込み
	profile, err := sls.LoadMinerProfile(minerID)
	if err != nil {
		return fmt.Errorf("プロファイルの読み込みに失敗しました: %v", err)
	}
	
	// 履歴を読み込み（過去3ヶ月）
	endDate := time.Now()
	startDate := endDate.AddDate(0, -3, 0)
	histories, err := sls.LoadMiningHistory(minerID, startDate, endDate)
	if err != nil {
		return fmt.Errorf("履歴の読み込みに失敗しました: %v", err)
	}
	
	// バックアップデータを作成
	backup := &BackupData{
		Version:       "1.0",
		Timestamp:     time.Now(),
		MinerProfile:  profile,
		MiningHistory: histories,
		Settings:      make(map[string]interface{}),
	}
	
	// チェックサムを計算
	backup.Checksum = sls.calculateBackupChecksum(backup)
	backup.Signature = sls.signBackup(backup)
	
	// バックアップディレクトリを作成
	backupDir := filepath.Join(sls.dataDir, "backups", minerID)
	if err := os.MkdirAll(backupDir, 0700); err != nil {
		return fmt.Errorf("バックアップディレクトリの作成に失敗しました: %v", err)
	}
	
	// バックアップファイル名を生成
	filename := fmt.Sprintf("backup_%s.encrypted", backup.Timestamp.Format("20060102_150405"))
	backupPath := filepath.Join(backupDir, filename)
	
	// シリアライズ
	data, err := json.Marshal(backup)
	if err != nil {
		return fmt.Errorf("バックアップのシリアライズに失敗しました: %v", err)
	}
	
	// 暗号化して保存
	encryptedData, err := sls.encrypt(data)
	if err != nil {
		return fmt.Errorf("バックアップの暗号化に失敗しました: %v", err)
	}
	
	if err := os.WriteFile(backupPath, encryptedData, 0600); err != nil {
		return fmt.Errorf("バックアップファイルの保存に失敗しました: %v", err)
	}
	
	// 古いバックアップを削除（最新10個を保持）
	sls.cleanupOldBackups(backupDir, 10)
	
	return nil
}

// RestoreFromBackup バックアップから復元
func (sls *SecureLocalStorage) RestoreFromBackup(minerID, backupPath string) error {
	sls.mu.Lock()
	defer sls.mu.Unlock()
	
	// バックアップファイルを読み込み
	encryptedData, err := os.ReadFile(backupPath)
	if err != nil {
		return fmt.Errorf("バックアップファイルの読み込みに失敗しました: %v", err)
	}
	
	// 復号化
	data, err := sls.decrypt(encryptedData)
	if err != nil {
		return fmt.Errorf("バックアップの復号化に失敗しました: %v", err)
	}
	
	var backup BackupData
	if err := json.Unmarshal(data, &backup); err != nil {
		return fmt.Errorf("バックアップのデシリアライズに失敗しました: %v", err)
	}
	
	// 署名検証
	if !sls.verifyBackupSignature(&backup) {
		return fmt.Errorf("バックアップの署名検証に失敗しました")
	}
	
	// チェックサム検証
	expectedChecksum := sls.calculateBackupChecksum(&backup)
	if subtle.ConstantTimeCompare(backup.Checksum, expectedChecksum) != 1 {
		return fmt.Errorf("バックアップの整合性チェックに失敗しました")
	}
	
	// プロファイルを復元
	if backup.MinerProfile != nil {
		if err := sls.saveMinerProfile(backup.MinerProfile); err != nil {
			return fmt.Errorf("プロファイルの復元に失敗しました: %v", err)
		}
	}
	
	// 履歴を復元
	for _, history := range backup.MiningHistory {
		if err := sls.SaveMiningHistory(&history); err != nil {
			// エラーを記録するが続行
			continue
		}
	}
	
	return nil
}

// Lock ストレージをロック
func (sls *SecureLocalStorage) Lock() {
	sls.mu.Lock()
	defer sls.mu.Unlock()
	
	sls.isLocked = true
	
	// メモリ内の暗号化キーをクリア
	for i := range sls.encryptionKey {
		sls.encryptionKey[i] = 0
	}
	for i := range sls.userKey {
		sls.userKey[i] = 0
	}
}

// Unlock ストレージをアンロック
func (sls *SecureLocalStorage) Unlock(userPassword string) error {
	sls.mu.Lock()
	defer sls.mu.Unlock()
	
	// ユーザーキーを再生成
	userKey := deriveKey(userPassword, []byte("otedama-miner-salt"))
	
	// マスターキーを読み込み
	encryptionKey, err := loadOrCreateMasterKey(sls.dataDir, userKey)
	if err != nil {
		return fmt.Errorf("暗号化キーの読み込みに失敗しました: %v", err)
	}
	
	sls.encryptionKey = encryptionKey
	sls.userKey = userKey
	sls.isLocked = false
	
	return nil
}

// 内部関数

func (sls *SecureLocalStorage) saveMinerProfile(profile *MinerProfile) error {
	minerDir := filepath.Join(sls.dataDir, "miners")
	if err := os.MkdirAll(minerDir, 0700); err != nil {
		return fmt.Errorf("マイナーディレクトリの作成に失敗しました: %v", err)
	}
	
	filepath := filepath.Join(minerDir, profile.MinerID+".encrypted")
	
	// シリアライズ
	data, err := json.Marshal(profile)
	if err != nil {
		return fmt.Errorf("プロファイルのシリアライズに失敗しました: %v", err)
	}
	
	// 暗号化
	encryptedData, err := sls.encrypt(data)
	if err != nil {
		return fmt.Errorf("プロファイルの暗号化に失敗しました: %v", err)
	}
	
	// 保存
	if err := os.WriteFile(filepath, encryptedData, 0600); err != nil {
		return fmt.Errorf("プロファイルファイルの保存に失敗しました: %v", err)
	}
	
	return nil
}

func (sls *SecureLocalStorage) encrypt(data []byte) ([]byte, error) {
	block, err := aes.NewCipher(sls.encryptionKey)
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

func (sls *SecureLocalStorage) decrypt(data []byte) ([]byte, error) {
	block, err := aes.NewCipher(sls.encryptionKey)
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

func (sls *SecureLocalStorage) calculateChecksum(profile *MinerProfile) []byte {
	// プロファイルの重要フィールドからチェックサムを計算
	data := fmt.Sprintf("%s:%s:%s:%v", 
		profile.MinerID, 
		profile.WalletAddress, 
		profile.MinerName,
		profile.LastModified.Unix())
	
	hash := sha256.Sum256([]byte(data))
	return hash[:]
}

func (sls *SecureLocalStorage) signData(data interface{}) []byte {
	// 簡略化されたデジタル署名
	jsonData, _ := json.Marshal(data)
	combined := append(jsonData, sls.encryptionKey...)
	hash := sha256.Sum256(combined)
	return hash[:]
}

func (sls *SecureLocalStorage) verifySignature(history *MiningHistory) bool {
	// 署名を検証
	originalSig := history.Signature
	history.Signature = nil
	
	expectedSig := sls.signData(history)
	history.Signature = originalSig
	
	return subtle.ConstantTimeCompare(originalSig, expectedSig) == 1
}

func (sls *SecureLocalStorage) calculateBackupChecksum(backup *BackupData) []byte {
	data := fmt.Sprintf("%s:%v:%d:%d", 
		backup.Version,
		backup.Timestamp.Unix(),
		len(backup.MiningHistory),
		len(backup.Settings))
	
	hash := sha256.Sum256([]byte(data))
	return hash[:]
}

func (sls *SecureLocalStorage) signBackup(backup *BackupData) []byte {
	jsonData, _ := json.Marshal(backup)
	combined := append(jsonData, sls.encryptionKey...)
	hash := sha256.Sum256(combined)
	return hash[:]
}

func (sls *SecureLocalStorage) verifyBackupSignature(backup *BackupData) bool {
	originalSig := backup.Signature
	backup.Signature = nil
	
	expectedSig := sls.signBackup(backup)
	backup.Signature = originalSig
	
	return subtle.ConstantTimeCompare(originalSig, expectedSig) == 1
}

func (sls *SecureLocalStorage) createBackup(minerID string) {
	sls.CreateBackup(minerID)
}

func (sls *SecureLocalStorage) cleanupOldBackups(backupDir string, keepCount int) {
	// 古いバックアップファイルを削除する実装
	// 実装は簡略化
}

func deriveKey(password string, salt []byte) []byte {
	combined := append([]byte(password), salt...)
	hash := sha256.Sum256(combined)
	return hash[:]
}

func loadOrCreateMasterKey(dataDir string, userKey []byte) ([]byte, error) {
	keyFile := filepath.Join(dataDir, ".masterkey")
	
	if _, err := os.Stat(keyFile); os.IsNotExist(err) {
		// 新しいマスターキーを生成
		masterKey := make([]byte, 32)
		rand.Read(masterKey)
		
		// ユーザーキーで暗号化して保存
		block, err := aes.NewCipher(userKey)
		if err != nil {
			return nil, err
		}
		
		gcm, err := cipher.NewGCM(block)
		if err != nil {
			return nil, err
		}
		
		nonce := make([]byte, gcm.NonceSize())
		rand.Read(nonce)
		
		encryptedKey := gcm.Seal(nonce, nonce, masterKey, nil)
		
		if err := os.WriteFile(keyFile, encryptedKey, 0600); err != nil {
			return nil, err
		}
		
		return masterKey, nil
	}
	
	// 既存のマスターキーを読み込み
	encryptedKey, err := os.ReadFile(keyFile)
	if err != nil {
		return nil, err
	}
	
	block, err := aes.NewCipher(userKey)
	if err != nil {
		return nil, err
	}
	
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	
	nonceSize := gcm.NonceSize()
	if len(encryptedKey) < nonceSize {
		return nil, fmt.Errorf("暗号化されたキーが短すぎます")
	}
	
	nonce, ciphertext := encryptedKey[:nonceSize], encryptedKey[nonceSize:]
	masterKey, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("マスターキーの復号化に失敗しました")
	}
	
	return masterKey, nil
}

func collectDeviceInfo() *DeviceInfo {
	// 実際のデバイス情報を収集する実装
	// 簡略化された実装
	return &DeviceInfo{
		DeviceID:     generateDeviceID(),
		Hostname:     "localhost",
		OS:           "windows",
		Architecture: "amd64",
		CPUInfo:      make(map[string]string),
		GPUInfo:      make([]GPUInfo, 0),
		Memory:       8 * 1024 * 1024 * 1024, // 8GB
		StorageInfo:  make([]StorageInfo, 0),
		NetworkMAC:   make([]string, 0),
		LastUpdate:   time.Now(),
	}
}

func generateDeviceID() string {
	// デバイス固有IDを生成
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return fmt.Sprintf("%x", bytes)
}