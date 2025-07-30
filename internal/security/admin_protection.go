package security

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

// AdminProtection 運営側設定の保護システム
type AdminProtection struct {
	adminKeys        map[string]*AdminKey
	adminSessions    map[string]*AdminSession
	protectedConfig  *ProtectedConfig
	auditLog         []AuditEntry
	mu               sync.RWMutex
	masterKey        []byte
	encryptionActive bool
}

// AdminKey 運営者キー情報
type AdminKey struct {
	KeyID       string
	KeyHash     []byte
	Salt        []byte
	Permissions []Permission
	CreatedAt   time.Time
	LastUsed    time.Time
	Active      bool
	Description string
}

// AdminSession 運営者セッション
type AdminSession struct {
	SessionID   string
	AdminID     string
	CreatedAt   time.Time
	ExpiresAt   time.Time
	IPAddress   string
	UserAgent   string
	Permissions []Permission
	Active      bool
}

// Permission 権限定義
type Permission string

const (
	PermissionPoolConfig     Permission = "pool_config"
	PermissionFeeSettings    Permission = "fee_settings"
	PermissionUserManagement Permission = "user_management"
	PermissionSystemControl  Permission = "system_control"
	PermissionAuditView      Permission = "audit_view"
	PermissionKeyManagement  Permission = "key_management"
	PermissionBackupRestore  Permission = "backup_restore"
	PermissionMasterAdmin    Permission = "master_admin"
)

// ProtectedConfig 保護された設定
type ProtectedConfig struct {
	PoolSettings    *EncryptedPoolSettings
	FeeSettings     *EncryptedFeeSettings
	SystemSettings  *EncryptedSystemSettings
	SecuritySettings *EncryptedSecuritySettings
	LastModified    time.Time
	ModifiedBy      string
	Version         int
	Checksum        []byte
}

// EncryptedPoolSettings 暗号化されたプール設定
type EncryptedPoolSettings struct {
	Data      []byte
	IV        []byte
	Signature []byte
}

// EncryptedFeeSettings 暗号化された手数料設定
type EncryptedFeeSettings struct {
	Data      []byte
	IV        []byte
	Signature []byte
}

// EncryptedSystemSettings 暗号化されたシステム設定
type EncryptedSystemSettings struct {
	Data      []byte
	IV        []byte
	Signature []byte
}

// EncryptedSecuritySettings 暗号化されたセキュリティ設定
type EncryptedSecuritySettings struct {
	Data      []byte
	IV        []byte
	Signature []byte
}

// AuditEntry 監査ログエントリ
type AuditEntry struct {
	Timestamp   time.Time
	AdminID     string
	Action      string
	Resource    string
	IPAddress   string
	UserAgent   string
	Success     bool
	Details     map[string]interface{}
	Signature   []byte
}

// NewAdminProtection 新しい運営保護システムを作成
func NewAdminProtection() *AdminProtection {
	masterKey := make([]byte, 32)
	rand.Read(masterKey)
	
	return &AdminProtection{
		adminKeys:        make(map[string]*AdminKey),
		adminSessions:    make(map[string]*AdminSession),
		protectedConfig:  &ProtectedConfig{},
		auditLog:         make([]AuditEntry, 0),
		masterKey:        masterKey,
		encryptionActive: true,
	}
}

// CreateMasterAdmin マスター管理者を作成
func (ap *AdminProtection) CreateMasterAdmin(password string, description string) (*AdminKey, error) {
	ap.mu.Lock()
	defer ap.mu.Unlock()
	
	// マスター管理者が既に存在するかチェック
	for _, key := range ap.adminKeys {
		if hasPermission(key.Permissions, PermissionMasterAdmin) {
			return nil, fmt.Errorf("マスター管理者は既に存在します")
		}
	}
	
	keyID := generateKeyID()
	salt := make([]byte, 32)
	rand.Read(salt)
	
	// パスワードハッシュ生成
	keyHash := hashPassword(password, salt)
	
	adminKey := &AdminKey{
		KeyID:       keyID,
		KeyHash:     keyHash,
		Salt:        salt,
		Permissions: []Permission{PermissionMasterAdmin}, // 全権限を含む
		CreatedAt:   time.Now(),
		Active:      true,
		Description: description,
	}
	
	ap.adminKeys[keyID] = adminKey
	
	// 監査ログ記録
	ap.logAuditEntry("MASTER_ADMIN_CREATED", keyID, "", "", true, map[string]interface{}{
		"description": description,
	})
	
	return adminKey, nil
}

// CreateAdminKey 運営者キーを作成
func (ap *AdminProtection) CreateAdminKey(creatorKeyID, password string, permissions []Permission, description string) (*AdminKey, error) {
	ap.mu.Lock()
	defer ap.mu.Unlock()
	
	// 作成者の権限確認
	creator, exists := ap.adminKeys[creatorKeyID]
	if !exists || !creator.Active {
		return nil, fmt.Errorf("無効な作成者キーです")
	}
	
	if !hasPermission(creator.Permissions, PermissionKeyManagement) && !hasPermission(creator.Permissions, PermissionMasterAdmin) {
		return nil, fmt.Errorf("キー作成権限がありません")
	}
	
	keyID := generateKeyID()
	salt := make([]byte, 32)
	rand.Read(salt)
	
	keyHash := hashPassword(password, salt)
	
	adminKey := &AdminKey{
		KeyID:       keyID,
		KeyHash:     keyHash,
		Salt:        salt,
		Permissions: permissions,
		CreatedAt:   time.Now(),
		Active:      true,
		Description: description,
	}
	
	ap.adminKeys[keyID] = adminKey
	
	// 監査ログ記録
	ap.logAuditEntry("ADMIN_KEY_CREATED", creatorKeyID, keyID, "", true, map[string]interface{}{
		"permissions": permissions,
		"description": description,
	})
	
	return adminKey, nil
}

// AuthenticateAdmin 運営者認証
func (ap *AdminProtection) AuthenticateAdmin(keyID, password, ipAddress, userAgent string) (*AdminSession, error) {
	ap.mu.Lock()
	defer ap.mu.Unlock()
	
	adminKey, exists := ap.adminKeys[keyID]
	if !exists || !adminKey.Active {
		ap.logAuditEntry("AUTH_FAILED", keyID, "", ipAddress, false, map[string]interface{}{
			"reason": "invalid_key",
		})
		return nil, fmt.Errorf("無効なキーIDです")
	}
	
	// パスワード確認
	if !verifyPassword(password, adminKey.KeyHash, adminKey.Salt) {
		ap.logAuditEntry("AUTH_FAILED", keyID, "", ipAddress, false, map[string]interface{}{
			"reason": "invalid_password",
		})
		return nil, fmt.Errorf("パスワードが正しくありません")
	}
	
	// セッション作成
	sessionID := generateSessionID()
	session := &AdminSession{
		SessionID:   sessionID,
		AdminID:     keyID,
		CreatedAt:   time.Now(),
		ExpiresAt:   time.Now().Add(24 * time.Hour), // 24時間有効
		IPAddress:   ipAddress,
		UserAgent:   userAgent,
		Permissions: adminKey.Permissions,
		Active:      true,
	}
	
	ap.adminSessions[sessionID] = session
	adminKey.LastUsed = time.Now()
	
	// 監査ログ記録
	ap.logAuditEntry("AUTH_SUCCESS", keyID, "", ipAddress, true, map[string]interface{}{
		"session_id": sessionID,
		"user_agent": userAgent,
	})
	
	return session, nil
}

// ValidateSession セッション検証
func (ap *AdminProtection) ValidateSession(sessionID string, requiredPermission Permission) (*AdminSession, error) {
	ap.mu.RLock()
	defer ap.mu.RUnlock()
	
	session, exists := ap.adminSessions[sessionID]
	if !exists || !session.Active {
		return nil, fmt.Errorf("無効なセッションです")
	}
	
	if time.Now().After(session.ExpiresAt) {
		return nil, fmt.Errorf("セッションが期限切れです")
	}
	
	// 権限確認
	if !hasPermission(session.Permissions, requiredPermission) && !hasPermission(session.Permissions, PermissionMasterAdmin) {
		return nil, fmt.Errorf("必要な権限がありません: %s", requiredPermission)
	}
	
	return session, nil
}

// UpdateProtectedConfig 保護された設定を更新
func (ap *AdminProtection) UpdateProtectedConfig(sessionID string, configType string, data []byte) error {
	session, err := ap.ValidateSession(sessionID, PermissionPoolConfig)
	if err != nil {
		return err
	}
	
	ap.mu.Lock()
	defer ap.mu.Unlock()
	
	// データを暗号化
	encryptedData, err := ap.encryptData(data)
	if err != nil {
		return fmt.Errorf("設定の暗号化に失敗しました: %v", err)
	}
	
	// 設定タイプに応じて保存
	switch configType {
	case "pool":
		ap.protectedConfig.PoolSettings = encryptedData.(*EncryptedPoolSettings)
	case "fee":
		if !hasPermission(session.Permissions, PermissionFeeSettings) && !hasPermission(session.Permissions, PermissionMasterAdmin) {
			return fmt.Errorf("手数料設定変更権限がありません")
		}
		ap.protectedConfig.FeeSettings = encryptedData.(*EncryptedFeeSettings)
	case "system":
		if !hasPermission(session.Permissions, PermissionSystemControl) && !hasPermission(session.Permissions, PermissionMasterAdmin) {
			return fmt.Errorf("システム設定変更権限がありません")
		}
		ap.protectedConfig.SystemSettings = encryptedData.(*EncryptedSystemSettings)
	case "security":
		if !hasPermission(session.Permissions, PermissionMasterAdmin) {
			return fmt.Errorf("セキュリティ設定変更にはマスター管理者権限が必要です")
		}
		ap.protectedConfig.SecuritySettings = encryptedData.(*EncryptedSecuritySettings)
	default:
		return fmt.Errorf("不明な設定タイプです: %s", configType)
	}
	
	// メタデータ更新
	ap.protectedConfig.LastModified = time.Now()
	ap.protectedConfig.ModifiedBy = session.AdminID
	ap.protectedConfig.Version++
	ap.protectedConfig.Checksum = ap.calculateConfigChecksum()
	
	// 監査ログ記録
	ap.logAuditEntry("CONFIG_UPDATED", session.AdminID, configType, session.IPAddress, true, map[string]interface{}{
		"config_type": configType,
		"version":     ap.protectedConfig.Version,
	})
	
	return nil
}

// GetProtectedConfig 保護された設定を取得
func (ap *AdminProtection) GetProtectedConfig(sessionID string, configType string) ([]byte, error) {
	session, err := ap.ValidateSession(sessionID, PermissionPoolConfig)
	if err != nil {
		return nil, err
	}
	
	ap.mu.RLock()
	defer ap.mu.RUnlock()
	
	var encryptedData interface{}
	
	switch configType {
	case "pool":
		encryptedData = ap.protectedConfig.PoolSettings
	case "fee":
		if !hasPermission(session.Permissions, PermissionFeeSettings) && !hasPermission(session.Permissions, PermissionMasterAdmin) {
			return nil, fmt.Errorf("手数料設定参照権限がありません")
		}
		encryptedData = ap.protectedConfig.FeeSettings
	case "system":
		if !hasPermission(session.Permissions, PermissionSystemControl) && !hasPermission(session.Permissions, PermissionMasterAdmin) {
			return nil, fmt.Errorf("システム設定参照権限がありません")
		}
		encryptedData = ap.protectedConfig.SystemSettings
	case "security":
		if !hasPermission(session.Permissions, PermissionMasterAdmin) {
			return nil, fmt.Errorf("セキュリティ設定参照にはマスター管理者権限が必要です")
		}
		encryptedData = ap.protectedConfig.SecuritySettings
	default:
		return nil, fmt.Errorf("不明な設定タイプです: %s", configType)
	}
	
	if encryptedData == nil {
		return nil, fmt.Errorf("設定が存在しません")
	}
	
	// データを復号化
	data, err := ap.decryptData(encryptedData)
	if err != nil {
		return nil, fmt.Errorf("設定の復号化に失敗しました: %v", err)
	}
	
	// 監査ログ記録
	ap.logAuditEntry("CONFIG_ACCESSED", session.AdminID, configType, session.IPAddress, true, map[string]interface{}{
		"config_type": configType,
	})
	
	return data, nil
}

// RevokeAdminKey 運営者キーを無効化
func (ap *AdminProtection) RevokeAdminKey(revokerSessionID, targetKeyID string) error {
	session, err := ap.ValidateSession(revokerSessionID, PermissionKeyManagement)
	if err != nil {
		return err
	}
	
	ap.mu.Lock()
	defer ap.mu.Unlock()
	
	targetKey, exists := ap.adminKeys[targetKeyID]
	if !exists {
		return fmt.Errorf("対象のキーが存在しません")
	}
	
	// マスター管理者キーの無効化はマスター管理者のみ可能
	if hasPermission(targetKey.Permissions, PermissionMasterAdmin) && !hasPermission(session.Permissions, PermissionMasterAdmin) {
		return fmt.Errorf("マスター管理者キーの無効化にはマスター管理者権限が必要です")
	}
	
	targetKey.Active = false
	
	// 関連セッションも無効化
	for _, adminSession := range ap.adminSessions {
		if adminSession.AdminID == targetKeyID {
			adminSession.Active = false
		}
	}
	
	// 監査ログ記録
	ap.logAuditEntry("ADMIN_KEY_REVOKED", session.AdminID, targetKeyID, session.IPAddress, true, map[string]interface{}{
		"revoked_key": targetKeyID,
	})
	
	return nil
}

// GetAuditLog 監査ログを取得
func (ap *AdminProtection) GetAuditLog(sessionID string, limit int) ([]AuditEntry, error) {
	_, err := ap.ValidateSession(sessionID, PermissionAuditView)
	if err != nil {
		return nil, err
	}
	
	ap.mu.RLock()
	defer ap.mu.RUnlock()
	
	if limit <= 0 || limit > len(ap.auditLog) {
		limit = len(ap.auditLog)
	}
	
	// 最新のエントリから返す
	start := len(ap.auditLog) - limit
	if start < 0 {
		start = 0
	}
	
	result := make([]AuditEntry, limit)
	copy(result, ap.auditLog[start:])
	
	return result, nil
}

// ChangePassword パスワード変更
func (ap *AdminProtection) ChangePassword(sessionID, oldPassword, newPassword string) error {
	session, err := ap.ValidateSession(sessionID, Permission("self"))
	if err != nil {
		return err
	}
	
	ap.mu.Lock()
	defer ap.mu.Unlock()
	
	adminKey, exists := ap.adminKeys[session.AdminID]
	if !exists || !adminKey.Active {
		return fmt.Errorf("無効な管理者キーです")
	}
	
	// 現在のパスワード確認
	if !verifyPassword(oldPassword, adminKey.KeyHash, adminKey.Salt) {
		ap.logAuditEntry("PASSWORD_CHANGE_FAILED", session.AdminID, "", session.IPAddress, false, map[string]interface{}{
			"reason": "invalid_old_password",
		})
		return fmt.Errorf("現在のパスワードが正しくありません")
	}
	
	// 新しいソルトとハッシュ生成
	newSalt := make([]byte, 32)
	rand.Read(newSalt)
	newHash := hashPassword(newPassword, newSalt)
	
	adminKey.KeyHash = newHash
	adminKey.Salt = newSalt
	
	// 監査ログ記録
	ap.logAuditEntry("PASSWORD_CHANGED", session.AdminID, "", session.IPAddress, true, map[string]interface{}{})
	
	return nil
}

// BackupProtectedData 保護されたデータのバックアップ
func (ap *AdminProtection) BackupProtectedData(sessionID string) ([]byte, error) {
	_, err := ap.ValidateSession(sessionID, PermissionBackupRestore)
	if err != nil {
		return nil, err
	}
	
	ap.mu.RLock()
	defer ap.mu.RUnlock()
	
	// バックアップデータを暗号化して返す
	backupData := struct {
		AdminKeys       map[string]*AdminKey
		ProtectedConfig *ProtectedConfig
		AuditLog        []AuditEntry
		Timestamp       time.Time
		Version         string
	}{
		AdminKeys:       ap.adminKeys,
		ProtectedConfig: ap.protectedConfig,
		AuditLog:        ap.auditLog,
		Timestamp:       time.Now(),
		Version:         "1.0",
	}
	
	// データをシリアライズして暗号化
	// 実装は簡略化
	return []byte("encrypted_backup_data"), nil
}

// 内部関数

func generateKeyID() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

func generateSessionID() string {
	bytes := make([]byte, 32)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

func hashPassword(password string, salt []byte) []byte {
	combined := append([]byte(password), salt...)
	hash := sha256.Sum256(combined)
	return hash[:]
}

func verifyPassword(password string, hash, salt []byte) bool {
	expectedHash := hashPassword(password, salt)
	return subtle.ConstantTimeCompare(hash, expectedHash) == 1
}

func hasPermission(permissions []Permission, required Permission) bool {
	for _, perm := range permissions {
		if perm == required || perm == PermissionMasterAdmin {
			return true
		}
	}
	return false
}

func (ap *AdminProtection) encryptData(data []byte) (interface{}, error) {
	if !ap.encryptionActive {
		return data, nil
	}
	
	// 簡略化された暗号化実装
	iv := make([]byte, 16)
	rand.Read(iv)
	
	// 実際の実装では AES-GCM などを使用
	encrypted := make([]byte, len(data))
	for i, b := range data {
		encrypted[i] = b ^ ap.masterKey[i%len(ap.masterKey)]
	}
	
	signature := sha256.Sum256(append(encrypted, ap.masterKey...))
	
	return &EncryptedPoolSettings{
		Data:      encrypted,
		IV:        iv,
		Signature: signature[:],
	}, nil
}

func (ap *AdminProtection) decryptData(encryptedData interface{}) ([]byte, error) {
	if !ap.encryptionActive {
		return encryptedData.([]byte), nil
	}
	
	// 型アサーション（簡略化）
	encrypted := encryptedData.(*EncryptedPoolSettings)
	
	// 署名確認
	expectedSignature := sha256.Sum256(append(encrypted.Data, ap.masterKey...))
	if subtle.ConstantTimeCompare(encrypted.Signature, expectedSignature[:]) != 1 {
		return nil, fmt.Errorf("データの整合性チェックに失敗しました")
	}
	
	// 復号化
	decrypted := make([]byte, len(encrypted.Data))
	for i, b := range encrypted.Data {
		decrypted[i] = b ^ ap.masterKey[i%len(ap.masterKey)]
	}
	
	return decrypted, nil
}

func (ap *AdminProtection) calculateConfigChecksum() []byte {
	// 全設定のチェックサム計算
	hash := sha256.New()
	hash.Write([]byte(fmt.Sprintf("%d", ap.protectedConfig.Version)))
	hash.Write([]byte(ap.protectedConfig.ModifiedBy))
	return hash.Sum(nil)
}

func (ap *AdminProtection) logAuditEntry(action, adminID, resource, ipAddress string, success bool, details map[string]interface{}) {
	entry := AuditEntry{
		Timestamp: time.Now(),
		AdminID:   adminID,
		Action:    action,
		Resource:  resource,
		IPAddress: ipAddress,
		Success:   success,
		Details:   details,
	}
	
	// 署名追加
	entryHash := sha256.Sum256([]byte(fmt.Sprintf("%v", entry)))
	entry.Signature = entryHash[:]
	
	ap.auditLog = append(ap.auditLog, entry)
	
	// ログサイズ制限
	if len(ap.auditLog) > 10000 {
		ap.auditLog = ap.auditLog[1000:] // 古いエントリを削除
	}
}