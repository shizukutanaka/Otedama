package storage

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// OfflineSyncManager オフライン同期マネージャー
type OfflineSyncManager struct {
	localStorage     *SecureLocalStorage
	syncQueue        []SyncOperation
	conflictResolver *ConflictResolver
	syncHistory      []SyncRecord
	isOnline         bool
	syncInterval     time.Duration
	maxRetries       int
	mu               sync.RWMutex
	stopChan         chan bool
}

// SyncOperation 同期操作
type SyncOperation struct {
	ID          string                 `json:"id"`
	Type        string                 `json:"type"` // "create", "update", "delete"
	Resource    string                 `json:"resource"`
	Data        []byte                 `json:"data"`
	Timestamp   time.Time              `json:"timestamp"`
	MinerID     string                 `json:"miner_id"`
	Checksum    []byte                 `json:"checksum"`
	Retries     int                    `json:"retries"`
	Priority    int                    `json:"priority"`
	Metadata    map[string]interface{} `json:"metadata"`
}

// ConflictResolver 競合解決器
type ConflictResolver struct {
	resolutionRules map[string]ConflictRule
	mu              sync.RWMutex
}

// ConflictRule 競合解決ルール
type ConflictRule struct {
	Strategy    string // "local_wins", "remote_wins", "merge", "user_decide"
	MergeFunc   func(local, remote interface{}) interface{}
	Weight      int
	LastUsed    time.Time
}

// SyncRecord 同期記録
type SyncRecord struct {
	Timestamp    time.Time              `json:"timestamp"`
	Operation    string                 `json:"operation"`
	Resource     string                 `json:"resource"`
	Success      bool                   `json:"success"`
	Error        string                 `json:"error,omitempty"`
	ConflictType string                 `json:"conflict_type,omitempty"`
	Resolution   string                 `json:"resolution,omitempty"`
	Duration     time.Duration          `json:"duration"`
	Metadata     map[string]interface{} `json:"metadata"`
}

// NetworkStatus ネットワーク状態
type NetworkStatus struct {
	IsOnline      bool      `json:"is_online"`
	LastOnline    time.Time `json:"last_online"`
	LastOffline   time.Time `json:"last_offline"`
	ConnectionType string   `json:"connection_type"`
	Latency       time.Duration `json:"latency"`
	Bandwidth     int64     `json:"bandwidth"`
}

// OfflineData オフラインデータ
type OfflineData struct {
	MinerID         string            `json:"miner_id"`
	LastSyncTime    time.Time         `json:"last_sync_time"`
	PendingOperations []SyncOperation `json:"pending_operations"`
	LocalChanges    []LocalChange     `json:"local_changes"`
	ConflictQueue   []Conflict        `json:"conflict_queue"`
	NetworkStatus   NetworkStatus     `json:"network_status"`
	RetryQueue      []RetryOperation  `json:"retry_queue"`
}

// LocalChange ローカル変更
type LocalChange struct {
	ID        string                 `json:"id"`
	Type      string                 `json:"type"`
	Resource  string                 `json:"resource"`
	Before    []byte                 `json:"before,omitempty"`
	After     []byte                 `json:"after"`
	Timestamp time.Time              `json:"timestamp"`
	Applied   bool                   `json:"applied"`
	Metadata  map[string]interface{} `json:"metadata"`
}

// Conflict 競合
type Conflict struct {
	ID           string                 `json:"id"`
	Resource     string                 `json:"resource"`
	LocalData    []byte                 `json:"local_data"`
	RemoteData   []byte                 `json:"remote_data"`
	LocalTime    time.Time              `json:"local_time"`
	RemoteTime   time.Time              `json:"remote_time"`
	ConflictType string                 `json:"conflict_type"`
	Status       string                 `json:"status"` // "pending", "resolved", "ignored"
	Resolution   string                 `json:"resolution,omitempty"`
	Metadata     map[string]interface{} `json:"metadata"`
}

// RetryOperation 再試行操作
type RetryOperation struct {
	Operation    SyncOperation `json:"operation"`
	NextRetry    time.Time     `json:"next_retry"`
	RetryCount   int           `json:"retry_count"`
	MaxRetries   int           `json:"max_retries"`
	BackoffDelay time.Duration `json:"backoff_delay"`
}

// NewOfflineSyncManager 新しいオフライン同期マネージャーを作成
func NewOfflineSyncManager(localStorage *SecureLocalStorage) *OfflineSyncManager {
	return &OfflineSyncManager{
		localStorage:     localStorage,
		syncQueue:        make([]SyncOperation, 0),
		conflictResolver: NewConflictResolver(),
		syncHistory:      make([]SyncRecord, 0),
		isOnline:         false,
		syncInterval:     5 * time.Minute,
		maxRetries:       3,
		stopChan:         make(chan bool),
	}
}

// NewConflictResolver 新しい競合解決器を作成
func NewConflictResolver() *ConflictResolver {
	cr := &ConflictResolver{
		resolutionRules: make(map[string]ConflictRule),
	}
	
	// デフォルトルールを設定
	cr.setDefaultRules()
	
	return cr
}

// StartSync 同期を開始
func (osm *OfflineSyncManager) StartSync() {
	go osm.syncLoop()
	go osm.networkMonitor()
	go osm.retryHandler()
}

// StopSync 同期を停止
func (osm *OfflineSyncManager) StopSync() {
	close(osm.stopChan)
}

// QueueOperation 操作をキューに追加
func (osm *OfflineSyncManager) QueueOperation(operation SyncOperation) error {
	osm.mu.Lock()
	defer osm.mu.Unlock()
	
	// 操作IDを生成
	if operation.ID == "" {
		operation.ID = generateOperationID()
	}
	
	operation.Timestamp = time.Now()
	operation.Checksum = osm.calculateOperationChecksum(operation)
	
	// キューに追加
	osm.syncQueue = append(osm.syncQueue, operation)
	
	// オフラインデータとして保存
	if err := osm.saveOfflineData(operation.MinerID); err != nil {
		return fmt.Errorf("オフラインデータの保存に失敗しました: %v", err)
	}
	
	// オンラインなら即座に同期を試行
	if osm.isOnline {
		go osm.processSyncQueue()
	}
	
	return nil
}

// ProcessOfflineChanges オフライン変更を処理
func (osm *OfflineSyncManager) ProcessOfflineChanges(minerID string) error {
	osm.mu.Lock()
	defer osm.mu.Unlock()
	
	// オフラインデータを読み込み
	offlineData, err := osm.loadOfflineData(minerID)
	if err != nil {
		return fmt.Errorf("オフラインデータの読み込みに失敗しました: %v", err)
	}
	
	// ペンディング操作をキューに追加
	for _, op := range offlineData.PendingOperations {
		osm.syncQueue = append(osm.syncQueue, op)
	}
	
	// ローカル変更を適用
	for _, change := range offlineData.LocalChanges {
		if !change.Applied {
			if err := osm.applyLocalChange(change); err != nil {
				osm.recordSyncError(change.Resource, "local_change_apply", err)
				continue
			}
			change.Applied = true
		}
	}
	
	// 競合を解決
	for _, conflict := range offlineData.ConflictQueue {
		if conflict.Status == "pending" {
			if err := osm.resolveConflict(conflict); err != nil {
				osm.recordSyncError(conflict.Resource, "conflict_resolution", err)
				continue
			}
		}
	}
	
	return nil
}

// DetectConflicts 競合を検出
func (osm *OfflineSyncManager) DetectConflicts(local, remote interface{}, resource string) (*Conflict, error) {
	localData, err := json.Marshal(local)
	if err != nil {
		return nil, err
	}
	
	remoteData, err := json.Marshal(remote)
	if err != nil {
		return nil, err
	}
	
	// データが異なる場合、競合と判定
	localHash := sha256.Sum256(localData)
	remoteHash := sha256.Sum256(remoteData)
	
	if string(localHash[:]) != string(remoteHash[:]) {
		conflict := &Conflict{
			ID:           generateConflictID(),
			Resource:     resource,
			LocalData:    localData,
			RemoteData:   remoteData,
			LocalTime:    time.Now(),
			RemoteTime:   time.Now(), // 実際にはリモートタイムスタンプを使用
			ConflictType: osm.determineConflictType(localData, remoteData),
			Status:       "pending",
			Metadata:     make(map[string]interface{}),
		}
		
		return conflict, nil
	}
	
	return nil, nil
}

// ResolveConflict 競合を解決
func (osm *OfflineSyncManager) ResolveConflict(conflict Conflict, strategy string) error {
	osm.mu.Lock()
	defer osm.mu.Unlock()
	
	rule, exists := osm.conflictResolver.resolutionRules[conflict.ConflictType]
	if !exists {
		rule = osm.conflictResolver.resolutionRules["default"]
	}
	
	var resolvedData interface{}
	var err error
	
	switch strategy {
	case "local_wins":
		resolvedData, err = osm.resolveWithLocalData(conflict)
	case "remote_wins":
		resolvedData, err = osm.resolveWithRemoteData(conflict)
	case "merge":
		resolvedData, err = osm.mergeConflictData(conflict, rule)
	case "user_decide":
		return osm.requestUserDecision(conflict)
	default:
		return fmt.Errorf("不明な解決戦略です: %s", strategy)
	}
	
	if err != nil {
		return fmt.Errorf("競合解決に失敗しました: %v", err)
	}
	
	// 解決されたデータを保存
	if err := osm.saveResolvedData(conflict.Resource, resolvedData); err != nil {
		return fmt.Errorf("解決データの保存に失敗しました: %v", err)
	}
	
	// 競合を解決済みとしてマーク
	conflict.Status = "resolved"
	conflict.Resolution = strategy
	
	// 同期記録を更新
	osm.recordSyncSuccess(conflict.Resource, "conflict_resolution", map[string]interface{}{
		"conflict_id": conflict.ID,
		"strategy":    strategy,
	})
	
	return nil
}

// BackupOfflineData オフラインデータをバックアップ
func (osm *OfflineSyncManager) BackupOfflineData(minerID string) error {
	osm.mu.RLock()
	defer osm.mu.RUnlock()
	
	// オフラインデータを収集
	offlineData := &OfflineData{
		MinerID:           minerID,
		LastSyncTime:      time.Now(),
		PendingOperations: osm.syncQueue,
		LocalChanges:      osm.getLocalChanges(minerID),
		ConflictQueue:     osm.getConflicts(minerID),
		NetworkStatus:     osm.getNetworkStatus(),
		RetryQueue:        osm.getRetryQueue(minerID),
	}
	
	// バックアップディレクトリを作成
	backupDir := filepath.Join(osm.localStorage.dataDir, "offline_backups", minerID)
	if err := os.MkdirAll(backupDir, 0700); err != nil {
		return fmt.Errorf("バックアップディレクトリの作成に失敗しました: %v", err)
	}
	
	// バックアップファイル名を生成
	timestamp := time.Now().Format("20060102_150405")
	filename := fmt.Sprintf("offline_data_%s.encrypted", timestamp)
	backupPath := filepath.Join(backupDir, filename)
	
	// シリアライズ
	data, err := json.Marshal(offlineData)
	if err != nil {
		return fmt.Errorf("オフラインデータのシリアライズに失敗しました: %v", err)
	}
	
	// 暗号化して保存
	encryptedData, err := osm.localStorage.encrypt(data)
	if err != nil {
		return fmt.Errorf("オフラインデータの暗号化に失敗しました: %v", err)
	}
	
	if err := os.WriteFile(backupPath, encryptedData, 0600); err != nil {
		return fmt.Errorf("オフラインバックアップの保存に失敗しました: %v", err)
	}
	
	return nil
}

// RestoreOfflineData オフラインデータを復元
func (osm *OfflineSyncManager) RestoreOfflineData(minerID, backupPath string) error {
	osm.mu.Lock()
	defer osm.mu.Unlock()
	
	// バックアップファイルを読み込み
	encryptedData, err := os.ReadFile(backupPath)
	if err != nil {
		return fmt.Errorf("オフラインバックアップの読み込みに失敗しました: %v", err)
	}
	
	// 復号化
	data, err := osm.localStorage.decrypt(encryptedData)
	if err != nil {
		return fmt.Errorf("オフラインデータの復号化に失敗しました: %v", err)
	}
	
	var offlineData OfflineData
	if err := json.Unmarshal(data, &offlineData); err != nil {
		return fmt.Errorf("オフラインデータのデシリアライズに失敗しました: %v", err)
	}
	
	// データを復元
	osm.syncQueue = append(osm.syncQueue, offlineData.PendingOperations...)
	
	// ローカル変更を適用
	for _, change := range offlineData.LocalChanges {
		if err := osm.applyLocalChange(change); err != nil {
			continue // エラーを無視して続行
		}
	}
	
	// 競合キューを復元
	for _, conflict := range offlineData.ConflictQueue {
		if conflict.Status == "pending" {
			osm.resolveConflict(conflict)
		}
	}
	
	return nil
}

// GetSyncStatus 同期状態を取得
func (osm *OfflineSyncManager) GetSyncStatus(minerID string) *SyncStatus {
	osm.mu.RLock()
	defer osm.mu.RUnlock()
	
	pendingOps := 0
	for _, op := range osm.syncQueue {
		if op.MinerID == minerID {
			pendingOps++
		}
	}
	
	conflicts := len(osm.getConflicts(minerID))
	localChanges := len(osm.getLocalChanges(minerID))
	
	return &SyncStatus{
		IsOnline:           osm.isOnline,
		LastSyncTime:       osm.getLastSyncTime(minerID),
		PendingOperations:  pendingOps,
		PendingConflicts:   conflicts,
		LocalChanges:       localChanges,
		NetworkStatus:      osm.getNetworkStatus(),
		SyncInProgress:     osm.isSyncInProgress(),
		LastError:          osm.getLastSyncError(minerID),
	}
}

// SyncStatus 同期状態
type SyncStatus struct {
	IsOnline          bool          `json:"is_online"`
	LastSyncTime      time.Time     `json:"last_sync_time"`
	PendingOperations int           `json:"pending_operations"`
	PendingConflicts  int           `json:"pending_conflicts"`
	LocalChanges      int           `json:"local_changes"`
	NetworkStatus     NetworkStatus `json:"network_status"`
	SyncInProgress    bool          `json:"sync_in_progress"`
	LastError         string        `json:"last_error,omitempty"`
}

// 内部関数

func (osm *OfflineSyncManager) syncLoop() {
	ticker := time.NewTicker(osm.syncInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			if osm.isOnline {
				osm.processSyncQueue()
			}
		case <-osm.stopChan:
			return
		}
	}
}

func (osm *OfflineSyncManager) networkMonitor() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			online := osm.checkNetworkConnection()
			if online != osm.isOnline {
				osm.isOnline = online
				if online {
					// オンラインになったら同期を開始
					go osm.processSyncQueue()
				}
			}
		case <-osm.stopChan:
			return
		}
	}
}

func (osm *OfflineSyncManager) retryHandler() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			osm.processRetryQueue()
		case <-osm.stopChan:
			return
		}
	}
}

func (osm *OfflineSyncManager) processSyncQueue() {
	osm.mu.Lock()
	defer osm.mu.Unlock()
	
	if !osm.isOnline {
		return
	}
	
	for i, op := range osm.syncQueue {
		if err := osm.executeSyncOperation(op); err != nil {
			osm.handleSyncError(op, err)
			continue
		}
		
		// 成功した操作をキューから削除
		osm.syncQueue = append(osm.syncQueue[:i], osm.syncQueue[i+1:]...)
		i-- // インデックスを調整
		
		osm.recordSyncSuccess(op.Resource, op.Type, map[string]interface{}{
			"operation_id": op.ID,
		})
	}
}

func (osm *OfflineSyncManager) executeSyncOperation(op SyncOperation) error {
	// 実際の同期操作を実行
	// ここでは簡略化された実装
	
	switch op.Type {
	case "create":
		return osm.executeCreate(op)
	case "update":
		return osm.executeUpdate(op)
	case "delete":
		return osm.executeDelete(op)
	default:
		return fmt.Errorf("不明な操作タイプです: %s", op.Type)
	}
}

func (osm *OfflineSyncManager) executeCreate(op SyncOperation) error {
	// 作成操作の実行
	return nil
}

func (osm *OfflineSyncManager) executeUpdate(op SyncOperation) error {
	// 更新操作の実行
	return nil
}

func (osm *OfflineSyncManager) executeDelete(op SyncOperation) error {
	// 削除操作の実行
	return nil
}

func (osm *OfflineSyncManager) handleSyncError(op SyncOperation, err error) {
	op.Retries++
	
	if op.Retries >= osm.maxRetries {
		// 最大再試行回数に達した場合、エラーログに記録
		osm.recordSyncError(op.Resource, op.Type, err)
		return
	}
	
	// 再試行キューに追加
	retryOp := RetryOperation{
		Operation:    op,
		NextRetry:    time.Now().Add(time.Duration(op.Retries) * time.Minute),
		RetryCount:   op.Retries,
		MaxRetries:   osm.maxRetries,
		BackoffDelay: time.Duration(op.Retries) * time.Minute,
	}
	
	osm.addToRetryQueue(retryOp)
}

func (osm *OfflineSyncManager) processRetryQueue() {
	// 再試行キューの処理
	// 実装は簡略化
}

func (osm *OfflineSyncManager) checkNetworkConnection() bool {
	// ネットワーク接続をチェック
	// 実装は簡略化
	return true
}

func (osm *OfflineSyncManager) calculateOperationChecksum(op SyncOperation) []byte {
	data := fmt.Sprintf("%s:%s:%s:%v", op.Type, op.Resource, op.MinerID, op.Timestamp.Unix())
	hash := sha256.Sum256([]byte(data))
	return hash[:]
}

func (osm *OfflineSyncManager) saveOfflineData(minerID string) error {
	// オフラインデータを保存
	return nil
}

func (osm *OfflineSyncManager) loadOfflineData(minerID string) (*OfflineData, error) {
	// オフラインデータを読み込み
	return &OfflineData{}, nil
}

func (osm *OfflineSyncManager) applyLocalChange(change LocalChange) error {
	// ローカル変更を適用
	return nil
}

func (osm *OfflineSyncManager) resolveConflict(conflict Conflict) error {
	// 競合を解決
	return nil
}

func (osm *OfflineSyncManager) determineConflictType(local, remote []byte) string {
	// 競合タイプを判定
	return "data_conflict"
}

func (osm *OfflineSyncManager) resolveWithLocalData(conflict Conflict) (interface{}, error) {
	// ローカルデータで解決
	var data interface{}
	if err := json.Unmarshal(conflict.LocalData, &data); err != nil {
		return nil, err
	}
	return data, nil
}

func (osm *OfflineSyncManager) resolveWithRemoteData(conflict Conflict) (interface{}, error) {
	// リモートデータで解決
	var data interface{}
	if err := json.Unmarshal(conflict.RemoteData, &data); err != nil {
		return nil, err
	}
	return data, nil
}

func (osm *OfflineSyncManager) mergeConflictData(conflict Conflict, rule ConflictRule) (interface{}, error) {
	// データをマージ
	var local, remote interface{}
	json.Unmarshal(conflict.LocalData, &local)
	json.Unmarshal(conflict.RemoteData, &remote)
	
	if rule.MergeFunc != nil {
		return rule.MergeFunc(local, remote), nil
	}
	
	// デフォルトマージ（ローカル優先）
	return local, nil
}

func (osm *OfflineSyncManager) requestUserDecision(conflict Conflict) error {
	// ユーザーの決定を要求
	return fmt.Errorf("ユーザーの決定が必要です")
}

func (osm *OfflineSyncManager) saveResolvedData(resource string, data interface{}) error {
	// 解決されたデータを保存
	return nil
}

func (osm *OfflineSyncManager) recordSyncSuccess(resource, operation string, metadata map[string]interface{}) {
	record := SyncRecord{
		Timestamp: time.Now(),
		Operation: operation,
		Resource:  resource,
		Success:   true,
		Metadata:  metadata,
	}
	
	osm.syncHistory = append(osm.syncHistory, record)
}

func (osm *OfflineSyncManager) recordSyncError(resource, operation string, err error) {
	record := SyncRecord{
		Timestamp: time.Now(),
		Operation: operation,
		Resource:  resource,
		Success:   false,
		Error:     err.Error(),
	}
	
	osm.syncHistory = append(osm.syncHistory, record)
}

func (osm *OfflineSyncManager) getLocalChanges(minerID string) []LocalChange {
	// ローカル変更を取得
	return make([]LocalChange, 0)
}

func (osm *OfflineSyncManager) getConflicts(minerID string) []Conflict {
	// 競合を取得
	return make([]Conflict, 0)
}

func (osm *OfflineSyncManager) getNetworkStatus() NetworkStatus {
	return NetworkStatus{
		IsOnline:      osm.isOnline,
		LastOnline:    time.Now(),
		ConnectionType: "wifi",
		Latency:       50 * time.Millisecond,
		Bandwidth:     100000000, // 100 Mbps
	}
}

func (osm *OfflineSyncManager) getRetryQueue(minerID string) []RetryOperation {
	// 再試行キューを取得
	return make([]RetryOperation, 0)
}

func (osm *OfflineSyncManager) getLastSyncTime(minerID string) time.Time {
	// 最後の同期時刻を取得
	return time.Now().Add(-time.Hour)
}

func (osm *OfflineSyncManager) isSyncInProgress() bool {
	// 同期中かどうかを確認
	return false
}

func (osm *OfflineSyncManager) getLastSyncError(minerID string) string {
	// 最後の同期エラーを取得
	for i := len(osm.syncHistory) - 1; i >= 0; i-- {
		record := osm.syncHistory[i]
		if !record.Success && record.Resource == minerID {
			return record.Error
		}
	}
	return ""
}

func (osm *OfflineSyncManager) addToRetryQueue(retryOp RetryOperation) {
	// 再試行キューに追加
}

func (cr *ConflictResolver) setDefaultRules() {
	cr.resolutionRules["data_conflict"] = ConflictRule{
		Strategy: "merge",
		Weight:   1,
		MergeFunc: func(local, remote interface{}) interface{} {
			// デフォルトマージ関数
			return local
		},
	}
	
	cr.resolutionRules["timestamp_conflict"] = ConflictRule{
		Strategy: "remote_wins",
		Weight:   2,
	}
	
	cr.resolutionRules["default"] = ConflictRule{
		Strategy: "local_wins",
		Weight:   0,
	}
}

func generateOperationID() string {
	return fmt.Sprintf("op_%d", time.Now().UnixNano())
}

func generateConflictID() string {
	return fmt.Sprintf("conflict_%d", time.Now().UnixNano())
}