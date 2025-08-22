package mobile

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"github.com/otedama/otedama/internal/analytics"
	"github.com/otedama/otedama/internal/auth"
	"github.com/otedama/otedama/internal/common"
	"github.com/otedama/otedama/internal/mining"
	"github.com/otedama/otedama/internal/pool"
	"github.com/otedama/otedama/internal/profit"
	"github.com/otedama/otedama/internal/security"
	"go.uber.org/zap"
)

// MobileAPI provides API endpoints for mobile applications
type MobileAPI struct {
	logger         *zap.Logger
	config         MobileAPIConfig
	// Dependencies
	poolManager    *pool.PoolManager
	miningEngine   mining.Engine
	analytics      *analytics.AnalyticsEngine
	profitSwitcher *profit.ProfitSwitcher
	walletSecurity *security.WalletSecurityManager
	// WebSocket
	upgrader       websocket.Upgrader
	wsConnections  map[string]*WSConnection
	// Rate limiting
	rateLimiter    *MobileRateLimiter
	// Authentication
	authManager    *AuthManager
	// Notifications (in-memory store for MVP)
	notifMu        sync.RWMutex
	notifStore     map[string][]Notification // userID -> notifications
	notifSettings  map[string]NotificationSettings // userID -> settings
}

// Security: Wallet backup/restore handlers

// handleBackupWallets creates an encrypted backup and returns it as base64 content.
func (api *MobileAPI) handleBackupWallets(w http.ResponseWriter, r *http.Request) {
	if api.walletSecurity == nil {
		api.sendError(w, http.StatusNotImplemented, "Wallet security not configured")
		return
	}

	userID := api.getUserID(r)

	var req struct {
		BackupPassword string `json:"backup_password"`
		MFAChallenge   string `json:"mfa_challenge"`
		MFAResponse    string `json:"mfa_response"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		api.sendError(w, http.StatusBadRequest, "Invalid request")
		return
	}
	if strings.TrimSpace(req.BackupPassword) == "" {
		api.sendError(w, http.StatusBadRequest, "backup_password cannot be empty")
		return
	}

	path, err := api.walletSecurity.BackupWalletsWithAuth(r.Context(), userID, req.MFAChallenge, req.MFAResponse, req.BackupPassword)
	if err != nil {
		// Propagate access control or validation errors to client
		api.sendError(w, http.StatusForbidden, err.Error())
		return
	}

	data, err := os.ReadFile(path)
	if err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to read backup")
		return
	}

	api.sendSuccess(w, map[string]interface{}{
		"filename":       filepath.Base(path),
		"size":           len(data),
		"content_base64": base64.StdEncoding.EncodeToString(data),
	})
}

// handleRestoreWallets accepts a multipart upload with field name "backup" and restores wallets.
// Form fields: mfa_challenge, mfa_response, backup_password
func (api *MobileAPI) handleRestoreWallets(w http.ResponseWriter, r *http.Request) {
	if api.walletSecurity == nil {
		api.sendError(w, http.StatusNotImplemented, "Wallet security not configured")
		return
	}

	userID := api.getUserID(r)

	if err := r.ParseMultipartForm(32 << 20); err != nil { // 32 MiB
		api.sendError(w, http.StatusBadRequest, "Invalid multipart form")
		return
	}

	file, header, err := r.FormFile("backup")
	if err != nil {
		api.sendError(w, http.StatusBadRequest, "Missing backup file")
		return
	}
	defer file.Close()

	tmpDir, err := os.MkdirTemp("", "wallet-restore-*")
	if err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to prepare restore")
		return
	}
	defer os.RemoveAll(tmpDir)

	tmpPath := filepath.Join(tmpDir, header.Filename)
	out, err := os.Create(tmpPath)
	if err != nil {
		api.sendError(w, http.StatusInternalServerError, "Failed to save backup")
		return
	}
	if _, err := io.Copy(out, file); err != nil {
		out.Close()
		api.sendError(w, http.StatusInternalServerError, "Failed to write backup")
		return
	}
	out.Close()

	mfaChallenge := r.FormValue("mfa_challenge")
	mfaResponse := r.FormValue("mfa_response")
	backupPassword := r.FormValue("backup_password")
	if strings.TrimSpace(backupPassword) == "" {
		api.sendError(w, http.StatusBadRequest, "backup_password cannot be empty")
		return
	}

	if err := api.walletSecurity.RestoreWalletsWithAuth(r.Context(), userID, mfaChallenge, mfaResponse, tmpPath, backupPassword); err != nil {
		api.sendError(w, http.StatusForbidden, err.Error())
		return
	}

	api.sendSuccess(w, map[string]string{
		"message": "Wallets restored successfully",
	})
}

// MobileAPIConfig contains mobile API configuration
type MobileAPIConfig struct {
	// Server settings
	ListenAddress     string
	EnableTLS         bool
	TLSCertFile       string
	TLSKeyFile        string
	// Authentication
	JWTSecret         string
	TokenExpiry       time.Duration
	// Rate limiting
	RateLimit         int           // Requests per minute
	BurstLimit        int           // Burst capacity
	// WebSocket
	WSReadTimeout     time.Duration
	WSWriteTimeout    time.Duration
	WSMaxMessageSize  int64
}

// WSConnection represents a WebSocket connection
type WSConnection struct {
	ID         string
	UserID     string
	Conn       *websocket.Conn
	Send       chan []byte
	LastActive time.Time
}

// AuthManager handles authentication
type AuthManager struct {
	jwtSecret []byte
	expiry    time.Duration
}

// MobileRateLimiter implements rate limiting for the mobile API
type MobileRateLimiter struct {
	requests map[string]*UserRateLimit
	mu       sync.Mutex
	rpm      int // requests per minute
	burst    int // additional burst capacity
}

// UserRateLimit tracks rate limit for a user
type UserRateLimit struct {
	Tokens    int
	MaxTokens int
	LastReset time.Time
}

// MobileAPIDeps contains dependencies for mobile API
type MobileAPIDeps struct {
	PoolManager    *pool.PoolManager
	MiningEngine   mining.Engine
	Analytics      *analytics.AnalyticsEngine
	ProfitSwitcher *profit.ProfitSwitcher
	WalletSecurity *security.WalletSecurityManager
}

// NewMobileAPI creates and initializes a MobileAPI instance with dependencies and configuration
func NewMobileAPI(deps MobileAPIDeps, cfg MobileAPIConfig, logger *zap.Logger) *MobileAPI {
    // Ensure sensible defaults
    if cfg.RateLimit <= 0 {
        cfg.RateLimit = 60
    }
    if cfg.BurstLimit < 0 {
        cfg.BurstLimit = 0
    }
    if cfg.WSReadTimeout == 0 {
        cfg.WSReadTimeout = 60 * time.Second
    }
    if cfg.WSWriteTimeout == 0 {
        cfg.WSWriteTimeout = 10 * time.Second
    }
    if cfg.WSMaxMessageSize == 0 {
        cfg.WSMaxMessageSize = 1 << 20 // 1 MiB
    }

    api := &MobileAPI{
        logger:         logger,
        config:         cfg,
        poolManager:    deps.PoolManager,
        miningEngine:   deps.MiningEngine,
        analytics:      deps.Analytics,
        profitSwitcher: deps.ProfitSwitcher,
        walletSecurity: deps.WalletSecurity,
        upgrader: websocket.Upgrader{
            ReadBufferSize:  1024,
            WriteBufferSize: 1024,
            CheckOrigin: func(r *http.Request) bool {
                // Allow mobile app origins; main server CORS already enforced at HTTP layer
                return true
            },
            EnableCompression: true,
        },
        wsConnections: make(map[string]*WSConnection),
        rateLimiter: &MobileRateLimiter{
            requests: make(map[string]*UserRateLimit),
            rpm:      cfg.RateLimit,
            burst:    cfg.BurstLimit,
        },
        authManager: &AuthManager{
            jwtSecret: []byte(cfg.JWTSecret),
            expiry:    cfg.TokenExpiry,
        },
        notifStore:    make(map[string][]Notification),
        notifSettings: make(map[string]NotificationSettings),
    }

    return api
}

// SetupRoutes registers all Mobile API routes on the given router under the provided prefix
func (api *MobileAPI) SetupRoutes(router *mux.Router) {
    // Protected subrouter with JWT auth middleware
    protected := router.PathPrefix("/").Subrouter()
    protected.Use(api.authMiddleware)

    // Core feature routes already defined in internal setup
    api.setupRoutes(protected)

    // Wallet backup/restore
    protected.HandleFunc("/wallets/backup", api.handleBackupWallets).Methods("POST")
    protected.HandleFunc("/wallets/restore", api.handleRestoreWallets).Methods("POST")

    // WebSocket endpoint for real-time mobile updates
    protected.HandleFunc("/ws", api.handleWebSocket)
}

// Response structures

// APIResponse is the standard API response format
type APIResponse struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
}

// Helper response methods
func (api *MobileAPI) sendError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(APIResponse{Success: false, Error: msg})
}

func (api *MobileAPI) sendSuccess(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(APIResponse{Success: true, Data: data})
}

func (api *MobileAPI) getUserID(r *http.Request) string {
	if v := r.Context().Value("user_id"); v != nil {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// DashboardData contains dashboard information
type DashboardData struct {
	Overview      OverviewData           `json:"overview"`
	Workers       []WorkerSummary        `json:"workers"`
	Earnings      EarningsData           `json:"earnings"`
	PoolStats     PoolStatistics         `json:"pool_stats"`
	Notifications []Notification         `json:"notifications"`
}

// OverviewData contains overview metrics
type OverviewData struct {
	TotalHashrate    float64 `json:"total_hashrate"`
	ActiveWorkers    int     `json:"active_workers"`
	UnpaidBalance    float64 `json:"unpaid_balance"`
	EstimatedEarning float64 `json:"estimated_earning"` // 24h estimate
	Currency         string  `json:"currency"`
}

// WorkerSummary contains worker summary data
type WorkerSummary struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Hashrate     float64   `json:"hashrate"`
	Status       string    `json:"status"`
	LastSeen     time.Time `json:"last_seen"`
	Shares       ShareInfo `json:"shares"`
	Efficiency   float64   `json:"efficiency"`
}

// ShareInfo contains share statistics
type ShareInfo struct {
	Valid    uint64 `json:"valid"`
	Invalid  uint64 `json:"invalid"`
	Stale    uint64 `json:"stale"`
	Ratio    float64 `json:"ratio"`
}

// EarningsData contains earnings information
type EarningsData struct {
	Today        float64               `json:"today"`
	Yesterday    float64               `json:"yesterday"`
	ThisWeek     float64               `json:"this_week"`
	ThisMonth    float64               `json:"this_month"`
	History      []EarningHistoryPoint `json:"history"`
}

// EarningHistoryPoint represents a point in earning history
type EarningHistoryPoint struct {
	Date     time.Time `json:"date"`
	Amount   float64   `json:"amount"`
	Currency string    `json:"currency"`
}

// Notification represents a user-visible notification in the mobile app
type Notification struct {
	ID        string            `json:"id"`
	Type      string            `json:"type"`
	Title     string            `json:"title"`
	Body      string            `json:"body"`
	Data      map[string]string `json:"data,omitempty"`
	Read      bool              `json:"read"`
	Timestamp time.Time         `json:"timestamp"`
}

// PoolStatistics summarizes pool-level stats for dashboard
type PoolStatistics struct {
	TotalHashrate  float64 `json:"total_hashrate"`
	ActiveMiners   int     `json:"active_miners"`
	BlocksFound24h int     `json:"blocks_found_24h"`
	PoolFee        float64 `json:"pool_fee"`
	MinPayout      float64 `json:"min_payout"`
}

// ...

func (api *MobileAPI) setupRoutes(router *mux.Router) {
    // Create a protected subrouter and attach authentication middleware
    protected := router.PathPrefix("/").Subrouter()
    protected.Use(api.authMiddleware)

    // Notifications (protected)
    protected.HandleFunc("/notifications", api.handleGetNotifications).Methods("GET")
    protected.HandleFunc("/notifications/{id}/read", api.handleMarkNotificationRead).Methods("POST")
    protected.HandleFunc("/notifications/settings", api.handleGetNotificationSettings).Methods("GET")
    protected.HandleFunc("/notifications/settings", api.handleUpdateNotificationSettings).Methods("PUT")
}

func (api *MobileAPI) handleGetNotificationSettings(w http.ResponseWriter, r *http.Request) {
    userID := api.getUserID(r)
    api.notifMu.RLock()
    settings, ok := api.notifSettings[userID]
    api.notifMu.RUnlock()
    if !ok {
        // sensible defaults
        settings = NotificationSettings{
            Enabled:         true,
            WorkerOffline:   true,
            PayoutSent:      true,
            BlockFound:      true,
            ProfitSwitch:    true,
            LowHashrate:     true,
            HighRejects:     true,
        }
    }
    api.sendSuccess(w, settings)
}

func (api *MobileAPI) handleUpdateNotificationSettings(w http.ResponseWriter, r *http.Request) {
    userID := api.getUserID(r)
    
    var settings NotificationSettings
    
    if err := json.NewDecoder(r.Body).Decode(&settings); err != nil {
        api.sendError(w, http.StatusBadRequest, "Invalid request")
        return
    }
    
    if err := api.updateNotificationSettings(userID, settings); err != nil {
        api.sendError(w, http.StatusInternalServerError, "Failed to update notification settings")
        return
    }
    
    api.sendSuccess(w, map[string]string{
        "message": "Notification settings updated",
    })
}

// handleGetNotifications returns notifications for the authenticated user
func (api *MobileAPI) handleGetNotifications(w http.ResponseWriter, r *http.Request) {
    userID := api.getUserID(r)
    unreadOnly := false
    if q := strings.TrimSpace(r.URL.Query().Get("unread")); q != "" {
        if b, err := strconv.ParseBool(q); err == nil {
            unreadOnly = b
        }
    }
    list, err := api.getNotifications(userID, unreadOnly)
    if err != nil {
        api.sendError(w, http.StatusInternalServerError, "Failed to get notifications")
        return
    }
    // Sort latest first just in case
    sort.Slice(list, func(i, j int) bool { return list[i].Timestamp.After(list[j].Timestamp) })
    api.sendSuccess(w, list)
}

// handleMarkNotificationRead marks a notification as read for the authenticated user
func (api *MobileAPI) handleMarkNotificationRead(w http.ResponseWriter, r *http.Request) {
    userID := api.getUserID(r)
    vars := mux.Vars(r)
    id := strings.TrimSpace(vars["id"])
    if id == "" {
        api.sendError(w, http.StatusBadRequest, "Missing notification id")
        return
    }
    if err := api.markNotificationRead(userID, id); err != nil {
        api.sendError(w, http.StatusNotFound, err.Error())
        return
    }
    api.sendSuccess(w, map[string]string{"message": "Notification marked as read"})
}

// ...

func (api *MobileAPI) authMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        authHeader := r.Header.Get("Authorization")
        if authHeader == "" {
            api.sendError(w, http.StatusUnauthorized, "Missing authorization header")
            return
        }

        // Extract token (supports "Bearer <token>")
        token := strings.TrimSpace(authHeader)
        if len(token) >= 7 && strings.EqualFold(token[:7], "Bearer ") {
            token = strings.TrimSpace(token[7:])
        }

        // Validate token to get userID
        userID, err := api.authManager.ValidateToken(token)
        if err != nil {
            api.sendError(w, http.StatusUnauthorized, "Invalid token")
            return
        }

        // Rate limit per user (if configured)
        if api.rateLimiter != nil && !api.rateLimiter.Allow(userID) {
            api.sendError(w, http.StatusTooManyRequests, "Rate limit exceeded")
            return
        }

        // Add user ID to context and continue
        ctx := context.WithValue(r.Context(), "user_id", userID)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

func (api *MobileAPI) getDashboardData(ctx context.Context, userID string) (*DashboardData, error) {
    // Get user data from various sources
    workers, _ := api.getWorkers(userID, "", "")
    earnings, _ := api.getEarnings(userID, "today")
    poolStats, err := api.poolManager.GetPoolStats(ctx)
    if err != nil {
        return nil, err
    }
    
    // Calculate totals
    totalHashrate := 0.0
    activeWorkers := 0
    for _, w := range workers {
        totalHashrate += w.Hashrate
        if w.Status == "active" {
            activeWorkers++
        }
    }
    
    // Safely read pool stats
    toFloat64 := func(v interface{}) float64 {
        switch t := v.(type) {
        case float64:
            return t
        case float32:
            return float64(t)
        case int:
            return float64(t)
        case int64:
            return float64(t)
        case uint64:
            return float64(t)
        default:
            return 0
        }
    }
    toInt := func(v interface{}) int {
        switch t := v.(type) {
        case int:
            return t
        case int64:
            return int(t)
        case uint64:
            return int(t)
        case float64:
            return int(t)
        case float32:
            return int(t)
        default:
            return 0
        }
    }
    
    totalPoolHashrate := toFloat64(poolStats["total_hashrate"])
    activeMiners := toInt(poolStats["active_miners"])
    blocksFound24h := toInt(poolStats["blocks_found_24h"])
    
    // Cap workers slice to available length
    topN := 5
    if len(workers) < topN {
        topN = len(workers)
    }
    topWorkers := workers[:topN]
    
    // Build recent notifications (latest first, up to 10)
    recent := []Notification{}
    api.notifMu.RLock()
    if list, ok := api.notifStore[userID]; ok && len(list) > 0 {
        tmp := make([]Notification, len(list))
        copy(tmp, list)
        sort.Slice(tmp, func(i, j int) bool { return tmp[i].Timestamp.After(tmp[j].Timestamp) })
        if len(tmp) > 10 { tmp = tmp[:10] }
        recent = tmp
    }
    api.notifMu.RUnlock()

    dashboard := &DashboardData{
        Overview: OverviewData{
            TotalHashrate:    totalHashrate,
            ActiveWorkers:    activeWorkers,
            UnpaidBalance:    100.5, // Example
            EstimatedEarning: 25.3,  // Example
            Currency:         api.profitSwitcher.GetCurrentCurrency(),
        },
        Workers: topWorkers, // Top workers
        Earnings: *earnings,
        PoolStats: PoolStatistics{
            TotalHashrate:  totalPoolHashrate,
            ActiveMiners:   activeMiners,
            BlocksFound24h: blocksFound24h,
            PoolFee:        2.0,
            MinPayout:      0.01,
        },
        Notifications: recent, // Recent notifications
    }
    
    return dashboard, nil
}

func (api *MobileAPI) getWorkers(userID, status, sortBy string) ([]WorkerSummary, error) {
    // Example implementation
    return []WorkerSummary{
        {
            ID:       "worker-1",
            Name:     "RIG-01",
            Hashrate: 125.5,
            Status:   "active",
            LastSeen: time.Now(),
            Shares: ShareInfo{
                Valid:   1250,
                Invalid: 12,
                Stale:   5,
                Ratio:   99.1,
            },
            Efficiency: 98.5,
        },
    }, nil
}

func (api *MobileAPI) getEarnings(userID, period string) (*EarningsData, error) {
    // Example implementation
    return &EarningsData{
        Today:     25.3,
        Yesterday: 24.8,
        ThisWeek:  175.2,
        ThisMonth: 750.5,
        History:   []EarningHistoryPoint{},
    }, nil
}

// Stub implementations for other methods
func (api *MobileAPI) authenticateUser(username, password string) (*auth.User, error) {
    // Implementation needed
    return &auth.User{ID: "user123"}, nil
}

func (api *MobileAPI) createUser(username, email, password, wallet string) (*auth.User, error) {
    // Validate wallet within business logic for defense-in-depth
    if strings.TrimSpace(wallet) == "" {
        return nil, fmt.Errorf("wallet address cannot be empty")
    }
    curr := api.profitSwitcher.GetCurrentCurrency()
    if strings.TrimSpace(curr) == "" {
        return nil, fmt.Errorf("unable to determine payout currency for validation")
    }
    if err := common.ValidateWalletAddress(strings.TrimSpace(wallet), curr); err != nil {
        return nil, err
    }
    // Implementation needed
    return &auth.User{ID: "user456"}, nil
}

func (api *MobileAPI) getWorkerDetails(userID, workerID string) (interface{}, error) {
    // Implementation needed
    return nil, nil
}

func (api *MobileAPI) restartWorker(userID, workerID string) error {
    // Implementation needed
    return nil
}

func (api *MobileAPI) getEarningHistory(userID string, limit, offset int) (interface{}, error) {
    // Implementation needed
    return nil, nil
}

func (api *MobileAPI) getPayouts(userID string) (interface{}, error) {
    // Implementation needed
    return nil, nil
}

func (api *MobileAPI) getUserSettings(userID string) (interface{}, error) {
    // Implementation needed
    return nil, nil
}

func (api *MobileAPI) updateUserSettings(userID string, settings map[string]interface{}) error {
    // Implementation needed
    return nil
}

func (api *MobileAPI) updatePayoutSettings(userID, wallet string, minPayout float64, currency string) error {
    // Validate wallet and currency here as well
    if strings.TrimSpace(wallet) == "" {
        return fmt.Errorf("wallet address cannot be empty")
    }
    curr := strings.TrimSpace(currency)
    if curr == "" {
        curr = api.profitSwitcher.GetCurrentCurrency()
    }
    if strings.TrimSpace(curr) == "" {
        return fmt.Errorf("unable to determine payout currency for validation")
    }
    if err := common.ValidateWalletAddress(strings.TrimSpace(wallet), curr); err != nil {
        return err
    }
    // Implementation needed
    return nil
}

func (api *MobileAPI) getPerformanceStats(userID, period string) (interface{}, error) {
    // Implementation needed
    return nil, nil
}

func (api *MobileAPI) getNotifications(userID string, unreadOnly bool) ([]Notification, error) {
    api.notifMu.RLock()
    defer api.notifMu.RUnlock()
    list := api.notifStore[userID]
    if !unreadOnly {
        // Return a shallow copy to avoid races with callers
        out := make([]Notification, len(list))
        copy(out, list)
        return out, nil
    }
    // Filter unread only
    out := make([]Notification, 0, len(list))
    for _, n := range list {
        if !n.Read {
            out = append(out, n)
        }
    }
    return out, nil
}

func (api *MobileAPI) markNotificationRead(userID, notificationID string) error {
    api.notifMu.Lock()
    defer api.notifMu.Unlock()
    list := api.notifStore[userID]
    for i := range list {
        if list[i].ID == notificationID {
            list[i].Read = true
            api.notifStore[userID] = list
            return nil
        }
    }
    return fmt.Errorf("notification not found")
}

func (api *MobileAPI) updateNotificationSettings(userID string, settings NotificationSettings) error {
    // Ensure Enabled defaults to true if not explicitly set
    // If caller wants to disable, they must set Enabled=false in payload
    if settings.QuietHours != nil {
        // Basic sanitize of QuietHours values
        if settings.QuietHours.StartHour < 0 || settings.QuietHours.StartHour > 23 {
            settings.QuietHours.StartHour = 0
        }
        if settings.QuietHours.EndHour < 0 || settings.QuietHours.EndHour > 23 {
            settings.QuietHours.EndHour = 0
        }
        if settings.QuietHours.TimeZone == "" {
            settings.QuietHours.TimeZone = "UTC"
        }
    }
    api.notifMu.Lock()
    api.notifSettings[userID] = settings
    api.notifMu.Unlock()
    return nil
}

// WebSocket methods

// handleWebSocket upgrades the HTTP connection to a WebSocket and registers it
func (api *MobileAPI) handleWebSocket(w http.ResponseWriter, r *http.Request) {
    userID := api.getUserID(r)
    if strings.TrimSpace(userID) == "" {
        api.sendError(w, http.StatusUnauthorized, "unauthorized")
        return
    }

    conn, err := api.upgrader.Upgrade(w, r, nil)
    if err != nil {
        api.logger.Error("websocket upgrade failed", zap.Error(err))
        return
    }

    ws := &WSConnection{
        ID:         generateID(),
        UserID:     userID,
        Conn:       conn,
        Send:       make(chan []byte, 256),
        LastActive: time.Now(),
    }

    api.wsConnections[ws.ID] = ws

    // Start pumps
    go ws.writePump(api)
    go ws.readPump(api)
}

// generateID returns a simple unique ID string
func generateID() string {
    return fmt.Sprintf("%d", time.Now().UnixNano())
}

func (api *MobileAPI) handleWebSocketMessages() {
    // Handle incoming WebSocket messages
}

func (api *MobileAPI) broadcastToUser(userID string, event string, data interface{}) {
    message, _ := json.Marshal(map[string]interface{}{
        "event": event,
        "data":  data,
        "timestamp": time.Now(),
    })
    
    for _, conn := range api.wsConnections {
        if conn.UserID == userID {
            select {
            case conn.Send <- message:
            default:
                close(conn.Send)
                delete(api.wsConnections, conn.ID)
            }
        }
    }
}

func (api *MobileAPI) sendWSMessage(conn *WSConnection, event string, data interface{}) {
    message, _ := json.Marshal(map[string]interface{}{
        "event": event,
        "data":  data,
        "timestamp": time.Now(),
    })
    
    select {
    case conn.Send <- message:
    default:
        close(conn.Send)
        delete(api.wsConnections, conn.ID)
    }
}

// WebSocket connection methods

func (conn *WSConnection) readPump(api *MobileAPI) {
    defer func() {
        conn.Conn.Close()
        delete(api.wsConnections, conn.ID)
    }()
    
    conn.Conn.SetReadLimit(api.config.WSMaxMessageSize)
    conn.Conn.SetReadDeadline(time.Now().Add(api.config.WSReadTimeout))
    conn.Conn.SetPongHandler(func(string) error {
        conn.Conn.SetReadDeadline(time.Now().Add(api.config.WSReadTimeout))
        return nil
    })
    
    for {
        var message map[string]interface{}
        err := conn.Conn.ReadJSON(&message)
        if err != nil {
            if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
                api.logger.Error("WebSocket error", zap.Error(err))
            }
            break
        }
        
        conn.LastActive = time.Now()
        
        // Handle message
        if event, ok := message["event"].(string); ok {
            api.handleWSEvent(conn, event, message["data"])
        }
    }
}

func (conn *WSConnection) writePump(api *MobileAPI) {
    ticker := time.NewTicker(54 * time.Second)
    defer func() {
        ticker.Stop()
        conn.Conn.Close()
    }()
    
    for {
        select {
        case message, ok := <-conn.Send:
            conn.Conn.SetWriteDeadline(time.Now().Add(api.config.WSWriteTimeout))
            if !ok {
                conn.Conn.WriteMessage(websocket.CloseMessage, []byte{})
                return
            }
            
            conn.Conn.WriteMessage(websocket.TextMessage, message)
            
        case <-ticker.C:
            conn.Conn.SetWriteDeadline(time.Now().Add(api.config.WSWriteTimeout))
            if err := conn.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                return
            }
        }
    }
}

func (api *MobileAPI) handleWSEvent(conn *WSConnection, event string, data interface{}) {
    switch event {
    case "subscribe":
        // Handle subscription to real-time updates
        if channel, ok := data.(string); ok {
            api.subscribeToChannel(conn, channel)
        }
        
    case "unsubscribe":
        // Handle unsubscription
        if channel, ok := data.(string); ok {
            api.unsubscribeFromChannel(conn, channel)
        }
        
    case "ping":
        // Respond with pong
        api.sendWSMessage(conn, "pong", nil)
        
    default:
        api.logger.Warn("Unknown WebSocket event",
            zap.String("event", event),
            zap.String("user_id", conn.UserID),
        )
    }
}

func (api *MobileAPI) subscribeToChannel(conn *WSConnection, channel string) {
    // Implementation for channel subscription
}

func (api *MobileAPI) unsubscribeFromChannel(conn *WSConnection, channel string) {
    // Implementation for channel unsubscription
}

// Rate limiter methods

func (rl *MobileRateLimiter) Allow(userID string) bool {
    rl.mu.Lock()
    defer rl.mu.Unlock()

    now := time.Now()

    limit, exists := rl.requests[userID]
    if !exists {
        max := rl.rpm + rl.burst
        if max < 1 {
            max = 1
        }
        // Consume a token upon first initialization to align with rpm+burst semantics
        initTokens := max - 1
        if initTokens < 0 {
            initTokens = 0
        }
        rl.requests[userID] = &UserRateLimit{
            Tokens:    initTokens,
            MaxTokens: max,
            LastReset: now,
        }
        return true
    }

    // Reset window every minute
    if now.Sub(limit.LastReset) >= time.Minute {
        limit.MaxTokens = rl.rpm + rl.burst
        if limit.MaxTokens < 1 {
            limit.MaxTokens = 1
        }
        limit.Tokens = limit.MaxTokens
        limit.LastReset = now
    }

    if limit.Tokens > 0 {
        limit.Tokens--
        return true
    }
    return false
}

// Auth manager methods

func (am *AuthManager) GenerateToken(userID, deviceID string) (string, error) {
    // Simple token generation (use JWT in production)
    token := fmt.Sprintf("%s:%s:%d", userID, deviceID, time.Now().Unix())
    return token, nil
}

func (am *AuthManager) ValidateToken(token string) (string, error) {
	// Simple validation (use JWT in production)
	parts := strings.Split(token, ":")
	if len(parts) != 3 {
		return "", errors.New("invalid token format")
	}
	return parts[0], nil
}

func (am *AuthManager) RefreshToken(oldToken string) (string, error) {
	userID, err := am.ValidateToken(oldToken)
	if err != nil {
		return "", err
	}
	
	return am.GenerateToken(userID, "refreshed")
}