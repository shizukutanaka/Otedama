package security

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

// AccessController アクセス制御システム
type AccessController struct {
	ipWhitelist      map[string]*IPRule
	ipBlacklist      map[string]*IPRule
	rateLimiter      *RateLimiter
	sessionValidator *SessionValidator
	intrusionDetector *IntrusionDetector
	mu               sync.RWMutex
}

// IPRule IP制御ルール
type IPRule struct {
	IP          net.IP
	Subnet      *net.IPNet
	Description string
	CreatedAt   time.Time
	CreatedBy   string
	ExpiresAt   *time.Time
	Active      bool
	RuleType    string // "whitelist" or "blacklist"
}

// RateLimiter レート制限器
type RateLimiter struct {
	limits          map[string]*RateLimit
	buckets         map[string]*TokenBucket
	mu              sync.RWMutex
	cleanupTicker   *time.Ticker
	cleanupStop     chan bool
}

// RateLimit レート制限設定
type RateLimit struct {
	RequestsPerMinute int
	BurstSize         int
	WindowSize        time.Duration
	Enabled           bool
}

// TokenBucket トークンバケット
type TokenBucket struct {
	Tokens       int
	MaxTokens    int
	RefillRate   int
	LastRefill   time.Time
	RequestCount int
	FirstRequest time.Time
}

// SessionValidator セッション検証器
type SessionValidator struct {
	activeSessions   map[string]*ActiveSession
	sessionTimeout   time.Duration
	maxSessions      int
	mu               sync.RWMutex
}

// ActiveSession アクティブセッション
type ActiveSession struct {
	SessionID     string
	AdminID       string
	IPAddress     string
	UserAgent     string
	CreatedAt     time.Time
	LastActivity  time.Time
	ExpiresAt     time.Time
	RequestCount  int
	IsValid       bool
}

// IntrusionDetector 侵入検知システム
type IntrusionDetector struct {
	suspiciousIPs    map[string]*SuspiciousActivity
	detectionRules   []DetectionRule
	alertThresholds  map[string]int
	mu               sync.RWMutex
}

// SuspiciousActivity 不審な活動
type SuspiciousActivity struct {
	IP                net.IP
	FailedLogins      int
	SuspiciousRequests int
	LastActivity      time.Time
	FirstDetected     time.Time
	RiskLevel         string
	Blocked           bool
}

// DetectionRule 検知ルール
type DetectionRule struct {
	Name        string
	Pattern     string
	Threshold   int
	WindowSize  time.Duration
	Action      string
	Enabled     bool
}

// NewAccessController 新しいアクセス制御システムを作成
func NewAccessController() *AccessController {
	ac := &AccessController{
		ipWhitelist:      make(map[string]*IPRule),
		ipBlacklist:      make(map[string]*IPRule),
		rateLimiter:      NewRateLimiter(),
		sessionValidator: NewSessionValidator(),
		intrusionDetector: NewIntrusionDetector(),
	}
	
	// デフォルトの安全なIP範囲を追加
	ac.addDefaultSafeRanges()
	
	return ac
}

// NewRateLimiter 新しいレート制限器を作成
func NewRateLimiter() *RateLimiter {
	rl := &RateLimiter{
		limits:        make(map[string]*RateLimit),
		buckets:       make(map[string]*TokenBucket),
		cleanupStop:   make(chan bool),
	}
	
	// デフォルト制限を設定
	rl.limits["default"] = &RateLimit{
		RequestsPerMinute: 60,
		BurstSize:         10,
		WindowSize:        time.Minute,
		Enabled:           true,
	}
	
	rl.limits["admin"] = &RateLimit{
		RequestsPerMinute: 120,
		BurstSize:         20,
		WindowSize:        time.Minute,
		Enabled:           true,
	}
	
	// クリーンアップゴルーチンを開始
	rl.startCleanup()
	
	return rl
}

// NewSessionValidator 新しいセッション検証器を作成
func NewSessionValidator() *SessionValidator {
	return &SessionValidator{
		activeSessions: make(map[string]*ActiveSession),
		sessionTimeout: 30 * time.Minute,
		maxSessions:    100,
	}
}

// NewIntrusionDetector 新しい侵入検知システムを作成
func NewIntrusionDetector() *IntrusionDetector {
	id := &IntrusionDetector{
		suspiciousIPs:   make(map[string]*SuspiciousActivity),
		detectionRules:  make([]DetectionRule, 0),
		alertThresholds: make(map[string]int),
	}
	
	// デフォルト検知ルールを追加
	id.addDefaultDetectionRules()
	
	return id
}

// CheckAccess アクセス許可をチェック
func (ac *AccessController) CheckAccess(ip, userAgent, sessionID string) error {
	ac.mu.RLock()
	defer ac.mu.RUnlock()
	
	clientIP := net.ParseIP(ip)
	if clientIP == nil {
		return fmt.Errorf("無効なIPアドレスです: %s", ip)
	}
	
	// ブラックリストチェック
	if ac.isBlacklisted(clientIP) {
		ac.intrusionDetector.recordSuspiciousActivity(clientIP, "blacklisted_access")
		return fmt.Errorf("アクセスが拒否されました: IPがブラックリストに登録されています")
	}
	
	// ホワイトリストチェック（ホワイトリストが設定されている場合）
	if len(ac.ipWhitelist) > 0 && !ac.isWhitelisted(clientIP) {
		ac.intrusionDetector.recordSuspiciousActivity(clientIP, "non_whitelisted_access")
		return fmt.Errorf("アクセスが拒否されました: IPがホワイトリストに登録されていません")
	}
	
	// レート制限チェック
	if !ac.rateLimiter.checkLimit(ip, "default") {
		ac.intrusionDetector.recordSuspiciousActivity(clientIP, "rate_limit_exceeded")
		return fmt.Errorf("レート制限に達しました")
	}
	
	// セッション検証（セッションIDが提供されている場合）
	if sessionID != "" {
		if err := ac.sessionValidator.validateSession(sessionID, ip, userAgent); err != nil {
			ac.intrusionDetector.recordSuspiciousActivity(clientIP, "invalid_session")
			return fmt.Errorf("セッション検証に失敗しました: %v", err)
		}
	}
	
	// 侵入検知チェック
	if ac.intrusionDetector.isBlocked(clientIP) {
		return fmt.Errorf("アクセスが拒否されました: 不審な活動により一時的にブロックされています")
	}
	
	return nil
}

// AddIPToWhitelist IPをホワイトリストに追加
func (ac *AccessController) AddIPToWhitelist(sessionID, ipStr, description string) error {
	// セッション検証
	session, err := ac.sessionValidator.getSession(sessionID)
	if err != nil {
		return err
	}
	
	ac.mu.Lock()
	defer ac.mu.Unlock()
	
	ip := net.ParseIP(ipStr)
	if ip == nil {
		// CIDR記法の場合
		_, subnet, err := net.ParseCIDR(ipStr)
		if err != nil {
			return fmt.Errorf("無効なIPアドレスまたはサブネットです: %s", ipStr)
		}
		
		rule := &IPRule{
			Subnet:      subnet,
			Description: description,
			CreatedAt:   time.Now(),
			CreatedBy:   session.AdminID,
			Active:      true,
			RuleType:    "whitelist",
		}
		
		ac.ipWhitelist[ipStr] = rule
	} else {
		rule := &IPRule{
			IP:          ip,
			Description: description,
			CreatedAt:   time.Now(),
			CreatedBy:   session.AdminID,
			Active:      true,
			RuleType:    "whitelist",
		}
		
		ac.ipWhitelist[ipStr] = rule
	}
	
	return nil
}

// AddIPToBlacklist IPをブラックリストに追加
func (ac *AccessController) AddIPToBlacklist(sessionID, ipStr, description string) error {
	session, err := ac.sessionValidator.getSession(sessionID)
	if err != nil {
		return err
	}
	
	ac.mu.Lock()
	defer ac.mu.Unlock()
	
	ip := net.ParseIP(ipStr)
	if ip == nil {
		_, subnet, err := net.ParseCIDR(ipStr)
		if err != nil {
			return fmt.Errorf("無効なIPアドレスまたはサブネットです: %s", ipStr)
		}
		
		rule := &IPRule{
			Subnet:      subnet,
			Description: description,
			CreatedAt:   time.Now(),
			CreatedBy:   session.AdminID,
			Active:      true,
			RuleType:    "blacklist",
		}
		
		ac.ipBlacklist[ipStr] = rule
	} else {
		rule := &IPRule{
			IP:          ip,
			Description: description,
			CreatedAt:   time.Now(),
			CreatedBy:   session.AdminID,
			Active:      true,
			RuleType:    "blacklist",
		}
		
		ac.ipBlacklist[ipStr] = rule
	}
	
	return nil
}

// RemoveIPFromWhitelist IPをホワイトリストから削除
func (ac *AccessController) RemoveIPFromWhitelist(sessionID, ipStr string) error {
	_, err := ac.sessionValidator.getSession(sessionID)
	if err != nil {
		return err
	}
	
	ac.mu.Lock()
	defer ac.mu.Unlock()
	
	delete(ac.ipWhitelist, ipStr)
	return nil
}

// RemoveIPFromBlacklist IPをブラックリストから削除
func (ac *AccessController) RemoveIPFromBlacklist(sessionID, ipStr string) error {
	_, err := ac.sessionValidator.getSession(sessionID)
	if err != nil {
		return err
	}
	
	ac.mu.Lock()
	defer ac.mu.Unlock()
	
	delete(ac.ipBlacklist, ipStr)
	return nil
}

// SetRateLimit レート制限を設定
func (ac *AccessController) SetRateLimit(sessionID, limitType string, requestsPerMinute, burstSize int) error {
	_, err := ac.sessionValidator.getSession(sessionID)
	if err != nil {
		return err
	}
	
	ac.rateLimiter.mu.Lock()
	defer ac.rateLimiter.mu.Unlock()
	
	ac.rateLimiter.limits[limitType] = &RateLimit{
		RequestsPerMinute: requestsPerMinute,
		BurstSize:         burstSize,
		WindowSize:        time.Minute,
		Enabled:           true,
	}
	
	return nil
}

// GetAccessStats アクセス統計を取得
func (ac *AccessController) GetAccessStats(sessionID string) (*AccessStats, error) {
	_, err := ac.sessionValidator.getSession(sessionID)
	if err != nil {
		return nil, err
	}
	
	ac.mu.RLock()
	defer ac.mu.RUnlock()
	
	stats := &AccessStats{
		WhitelistCount:    len(ac.ipWhitelist),
		BlacklistCount:    len(ac.ipBlacklist),
		ActiveSessions:    len(ac.sessionValidator.activeSessions),
		SuspiciousIPs:     len(ac.intrusionDetector.suspiciousIPs),
		Timestamp:         time.Now(),
	}
	
	// レート制限統計
	stats.RateLimitStats = make(map[string]RateLimitStat)
	for limitType, limit := range ac.rateLimiter.limits {
		bucketCount := 0
		for _, bucket := range ac.rateLimiter.buckets {
			if strings.HasPrefix(limitType, "admin") && bucket.RequestCount > limit.RequestsPerMinute/2 {
				bucketCount++
			}
		}
		
		stats.RateLimitStats[limitType] = RateLimitStat{
			RequestsPerMinute: limit.RequestsPerMinute,
			BurstSize:         limit.BurstSize,
			ActiveBuckets:     bucketCount,
			Enabled:           limit.Enabled,
		}
	}
	
	return stats, nil
}

// AccessStats アクセス統計
type AccessStats struct {
	WhitelistCount   int                       `json:"whitelist_count"`
	BlacklistCount   int                       `json:"blacklist_count"`
	ActiveSessions   int                       `json:"active_sessions"`
	SuspiciousIPs    int                       `json:"suspicious_ips"`
	RateLimitStats   map[string]RateLimitStat  `json:"rate_limit_stats"`
	Timestamp        time.Time                 `json:"timestamp"`
}

// RateLimitStat レート制限統計
type RateLimitStat struct {
	RequestsPerMinute int  `json:"requests_per_minute"`
	BurstSize         int  `json:"burst_size"`
	ActiveBuckets     int  `json:"active_buckets"`
	Enabled           bool `json:"enabled"`
}

// 内部関数

func (ac *AccessController) isWhitelisted(ip net.IP) bool {
	for _, rule := range ac.ipWhitelist {
		if !rule.Active {
			continue
		}
		
		if rule.ExpiresAt != nil && time.Now().After(*rule.ExpiresAt) {
			continue
		}
		
		if rule.IP != nil && rule.IP.Equal(ip) {
			return true
		}
		
		if rule.Subnet != nil && rule.Subnet.Contains(ip) {
			return true
		}
	}
	return false
}

func (ac *AccessController) isBlacklisted(ip net.IP) bool {
	for _, rule := range ac.ipBlacklist {
		if !rule.Active {
			continue
		}
		
		if rule.ExpiresAt != nil && time.Now().After(*rule.ExpiresAt) {
			continue
		}
		
		if rule.IP != nil && rule.IP.Equal(ip) {
			return true
		}
		
		if rule.Subnet != nil && rule.Subnet.Contains(ip) {
			return true
		}
	}
	return false
}

func (ac *AccessController) addDefaultSafeRanges() {
	// ローカルネットワーク範囲を安全なホワイトリストに追加
	safeRanges := []string{
		"127.0.0.0/8",   // localhost
		"10.0.0.0/8",    // Private network
		"172.16.0.0/12", // Private network
		"192.168.0.0/16", // Private network
	}
	
	for _, rangeStr := range safeRanges {
		_, subnet, err := net.ParseCIDR(rangeStr)
		if err != nil {
			continue
		}
		
		rule := &IPRule{
			Subnet:      subnet,
			Description: "デフォルト安全範囲",
			CreatedAt:   time.Now(),
			CreatedBy:   "system",
			Active:      true,
			RuleType:    "whitelist",
		}
		
		ac.ipWhitelist[rangeStr] = rule
	}
}

// レート制限器の内部関数

func (rl *RateLimiter) checkLimit(ip, limitType string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	
	limit, exists := rl.limits[limitType]
	if !exists || !limit.Enabled {
		return true
	}
	
	bucketKey := fmt.Sprintf("%s:%s", ip, limitType)
	bucket, exists := rl.buckets[bucketKey]
	if !exists {
		bucket = &TokenBucket{
			Tokens:       limit.BurstSize,
			MaxTokens:    limit.BurstSize,
			RefillRate:   limit.RequestsPerMinute,
			LastRefill:   time.Now(),
			RequestCount: 0,
			FirstRequest: time.Now(),
		}
		rl.buckets[bucketKey] = bucket
	}
	
	// トークンを補充
	rl.refillTokens(bucket, limit)
	
	// リクエストを処理
	if bucket.Tokens > 0 {
		bucket.Tokens--
		bucket.RequestCount++
		return true
	}
	
	return false
}

func (rl *RateLimiter) refillTokens(bucket *TokenBucket, limit *RateLimit) {
	now := time.Now()
	elapsed := now.Sub(bucket.LastRefill)
	
	if elapsed >= time.Minute {
		tokensToAdd := int(elapsed.Minutes()) * limit.RequestsPerMinute
		bucket.Tokens = min(bucket.MaxTokens, bucket.Tokens+tokensToAdd)
		bucket.LastRefill = now
	}
}

func (rl *RateLimiter) startCleanup() {
	rl.cleanupTicker = time.NewTicker(10 * time.Minute)
	
	go func() {
		for {
			select {
			case <-rl.cleanupTicker.C:
				rl.cleanup()
			case <-rl.cleanupStop:
				rl.cleanupTicker.Stop()
				return
			}
		}
	}()
}

func (rl *RateLimiter) cleanup() {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	
	cutoff := time.Now().Add(-1 * time.Hour)
	
	for key, bucket := range rl.buckets {
		if bucket.LastRefill.Before(cutoff) {
			delete(rl.buckets, key)
		}
	}
}

// セッション検証器の内部関数

func (sv *SessionValidator) validateSession(sessionID, ip, userAgent string) error {
	sv.mu.Lock()
	defer sv.mu.Unlock()
	
	session, exists := sv.activeSessions[sessionID]
	if !exists {
		return fmt.Errorf("セッションが存在しません")
	}
	
	if !session.IsValid {
		return fmt.Errorf("無効なセッションです")
	}
	
	if time.Now().After(session.ExpiresAt) {
		delete(sv.activeSessions, sessionID)
		return fmt.Errorf("セッションが期限切れです")
	}
	
	// IP検証
	if session.IPAddress != ip {
		return fmt.Errorf("IPアドレスが一致しません")
	}
	
	// User-Agent検証（簡略化）
	if session.UserAgent != userAgent {
		return fmt.Errorf("User-Agentが一致しません")
	}
	
	// セッション情報を更新
	session.LastActivity = time.Now()
	session.RequestCount++
	
	return nil
}

func (sv *SessionValidator) getSession(sessionID string) (*ActiveSession, error) {
	sv.mu.RLock()
	defer sv.mu.RUnlock()
	
	session, exists := sv.activeSessions[sessionID]
	if !exists {
		return nil, fmt.Errorf("セッションが存在しません")
	}
	
	return session, nil
}

// 侵入検知システムの内部関数

func (id *IntrusionDetector) addDefaultDetectionRules() {
	id.detectionRules = []DetectionRule{
		{
			Name:       "Failed Login Attempts",
			Pattern:    "failed_login",
			Threshold:  5,
			WindowSize: 5 * time.Minute,
			Action:     "block",
			Enabled:    true,
		},
		{
			Name:       "Rate Limit Violations",
			Pattern:    "rate_limit_exceeded",
			Threshold:  3,
			WindowSize: 10 * time.Minute,
			Action:     "block",
			Enabled:    true,
		},
		{
			Name:       "Suspicious Requests",
			Pattern:    "suspicious_request",
			Threshold:  10,
			WindowSize: 15 * time.Minute,
			Action:     "alert",
			Enabled:    true,
		},
	}
	
	id.alertThresholds = map[string]int{
		"failed_login":         5,
		"rate_limit_exceeded":  3,
		"suspicious_request":   10,
		"invalid_session":      3,
		"blacklisted_access":   1,
	}
}

func (id *IntrusionDetector) recordSuspiciousActivity(ip net.IP, activityType string) {
	id.mu.Lock()
	defer id.mu.Unlock()
	
	ipStr := ip.String()
	activity, exists := id.suspiciousIPs[ipStr]
	if !exists {
		activity = &SuspiciousActivity{
			IP:            ip,
			FirstDetected: time.Now(),
			RiskLevel:     "low",
		}
		id.suspiciousIPs[ipStr] = activity
	}
	
	activity.LastActivity = time.Now()
	
	switch activityType {
	case "failed_login":
		activity.FailedLogins++
	case "rate_limit_exceeded", "suspicious_request", "invalid_session":
		activity.SuspiciousRequests++
	}
	
	// リスクレベル更新
	id.updateRiskLevel(activity)
	
	// ブロック判定
	if id.shouldBlock(activity) {
		activity.Blocked = true
	}
}

func (id *IntrusionDetector) updateRiskLevel(activity *SuspiciousActivity) {
	totalScore := activity.FailedLogins*3 + activity.SuspiciousRequests*2
	
	if totalScore >= 20 {
		activity.RiskLevel = "critical"
	} else if totalScore >= 10 {
		activity.RiskLevel = "high"
	} else if totalScore >= 5 {
		activity.RiskLevel = "medium"
	} else {
		activity.RiskLevel = "low"
	}
}

func (id *IntrusionDetector) shouldBlock(activity *SuspiciousActivity) bool {
	return activity.FailedLogins >= 5 || activity.SuspiciousRequests >= 10 || activity.RiskLevel == "critical"
}

func (id *IntrusionDetector) isBlocked(ip net.IP) bool {
	id.mu.RLock()
	defer id.mu.RUnlock()
	
	ipStr := ip.String()
	activity, exists := id.suspiciousIPs[ipStr]
	if !exists {
		return false
	}
	
	return activity.Blocked
}

// ユーティリティ関数

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func generateSecureToken() string {
	bytes := make([]byte, 32)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

func hashString(input string) string {
	hash := sha256.Sum256([]byte(input))
	return hex.EncodeToString(hash[:])
}