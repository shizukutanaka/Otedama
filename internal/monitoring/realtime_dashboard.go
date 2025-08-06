package monitoring

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

// RealtimeDashboard provides real-time monitoring dashboard
type RealtimeDashboard struct {
	logger *zap.Logger
	
	// Data sources
	metricsAggregator *MetricsAggregator
	
	// WebSocket management
	upgrader    websocket.Upgrader
	clients     sync.Map // map[string]*DashboardClient
	clientCount atomic.Int32
	
	// Dashboard components
	widgets     map[string]Widget
	layouts     map[string]*Layout
	
	// Update channels
	updateChan  chan DashboardUpdate
	
	// Configuration
	config      *DashboardConfig
	
	// HTTP server
	server      *http.Server
	router      *mux.Router
	
	// Lifecycle
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
}

// DashboardConfig contains dashboard configuration
type DashboardConfig struct {
	ListenAddr       string
	UpdateInterval   time.Duration
	MaxClients       int
	EnableAuth       bool
	AllowedOrigins   []string
	DataRetention    time.Duration
}

// DashboardClient represents a connected dashboard client
type DashboardClient struct {
	ID            string
	conn          *websocket.Conn
	send          chan []byte
	subscriptions map[string]bool
	lastPing      time.Time
	mu            sync.RWMutex
}

// Widget represents a dashboard widget
type Widget interface {
	ID() string
	Type() string
	GetData() interface{}
	Update(data interface{})
}

// Layout represents a dashboard layout
type Layout struct {
	ID      string
	Name    string
	Widgets []WidgetPosition
}

// WidgetPosition defines widget position in layout
type WidgetPosition struct {
	WidgetID string
	X        int
	Y        int
	Width    int
	Height   int
}

// DashboardUpdate represents an update to dashboard
type DashboardUpdate struct {
	Type      string      `json:"type"`
	WidgetID  string      `json:"widget_id,omitempty"`
	Data      interface{} `json:"data"`
	Timestamp int64       `json:"timestamp"`
}

// NewRealtimeDashboard creates a real-time dashboard
func NewRealtimeDashboard(logger *zap.Logger, metricsAggregator *MetricsAggregator, config *DashboardConfig) *RealtimeDashboard {
	if config == nil {
		config = DefaultDashboardConfig()
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	rd := &RealtimeDashboard{
		logger:            logger,
		metricsAggregator: metricsAggregator,
		config:            config,
		ctx:               ctx,
		cancel:            cancel,
		updateChan:        make(chan DashboardUpdate, 1000),
		widgets:           make(map[string]Widget),
		layouts:           make(map[string]*Layout),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				// Check allowed origins
				origin := r.Header.Get("Origin")
				for _, allowed := range config.AllowedOrigins {
					if origin == allowed || allowed == "*" {
						return true
					}
				}
				return false
			},
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
		},
	}
	
	// Initialize widgets
	rd.initializeWidgets()
	
	// Initialize layouts
	rd.initializeLayouts()
	
	// Setup HTTP routes
	rd.setupRoutes()
	
	return rd
}

// Start starts the dashboard server
func (rd *RealtimeDashboard) Start() error {
	// Create HTTP server
	rd.server = &http.Server{
		Addr:    rd.config.ListenAddr,
		Handler: rd.router,
	}
	
	// Start update broadcaster
	rd.wg.Add(1)
	go rd.broadcastLoop()
	
	// Start metrics updater
	rd.wg.Add(1)
	go rd.metricsUpdateLoop()
	
	// Start client cleanup
	rd.wg.Add(1)
	go rd.clientCleanupLoop()
	
	// Start HTTP server
	rd.wg.Add(1)
	go func() {
		defer rd.wg.Done()
		
		rd.logger.Info("Dashboard server starting", zap.String("addr", rd.config.ListenAddr))
		
		if err := rd.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			rd.logger.Error("Dashboard server error", zap.Error(err))
		}
	}()
	
	return nil
}

// Stop stops the dashboard server
func (rd *RealtimeDashboard) Stop() {
	rd.cancel()
	
	// Shutdown HTTP server
	if rd.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		rd.server.Shutdown(ctx)
	}
	
	// Close all client connections
	rd.clients.Range(func(key, value interface{}) bool {
		client := value.(*DashboardClient)
		client.conn.Close()
		return true
	})
	
	rd.wg.Wait()
	rd.logger.Info("Dashboard stopped")
}

// Private methods

func (rd *RealtimeDashboard) initializeWidgets() {
	// Mining overview widget
	rd.widgets["mining_overview"] = &MiningOverviewWidget{
		id: "mining_overview",
	}
	
	// Hash rate chart widget
	rd.widgets["hashrate_chart"] = &HashRateChartWidget{
		id:         "hashrate_chart",
		dataPoints: make([]DataPoint, 0, 100),
	}
	
	// Hardware status widget
	rd.widgets["hardware_status"] = &HardwareStatusWidget{
		id: "hardware_status",
	}
	
	// Network status widget
	rd.widgets["network_status"] = &NetworkStatusWidget{
		id: "network_status",
	}
	
	// Performance metrics widget
	rd.widgets["performance_metrics"] = &PerformanceMetricsWidget{
		id: "performance_metrics",
	}
	
	// Alerts widget
	rd.widgets["alerts"] = &AlertsWidget{
		id:     "alerts",
		alerts: make([]Alert, 0, 50),
	}
	
	// Profitability widget
	rd.widgets["profitability"] = &ProfitabilityWidget{
		id: "profitability",
	}
}

func (rd *RealtimeDashboard) initializeLayouts() {
	// Default layout
	rd.layouts["default"] = &Layout{
		ID:   "default",
		Name: "Default Dashboard",
		Widgets: []WidgetPosition{
			{WidgetID: "mining_overview", X: 0, Y: 0, Width: 12, Height: 2},
			{WidgetID: "hashrate_chart", X: 0, Y: 2, Width: 8, Height: 4},
			{WidgetID: "hardware_status", X: 8, Y: 2, Width: 4, Height: 4},
			{WidgetID: "network_status", X: 0, Y: 6, Width: 4, Height: 3},
			{WidgetID: "performance_metrics", X: 4, Y: 6, Width: 4, Height: 3},
			{WidgetID: "alerts", X: 8, Y: 6, Width: 4, Height: 3},
			{WidgetID: "profitability", X: 0, Y: 9, Width: 12, Height: 2},
		},
	}
	
	// Compact layout
	rd.layouts["compact"] = &Layout{
		ID:   "compact",
		Name: "Compact Dashboard",
		Widgets: []WidgetPosition{
			{WidgetID: "mining_overview", X: 0, Y: 0, Width: 6, Height: 2},
			{WidgetID: "hashrate_chart", X: 6, Y: 0, Width: 6, Height: 2},
			{WidgetID: "hardware_status", X: 0, Y: 2, Width: 6, Height: 2},
			{WidgetID: "alerts", X: 6, Y: 2, Width: 6, Height: 2},
		},
	}
}

func (rd *RealtimeDashboard) setupRoutes() {
	rd.router = mux.NewRouter()
	
	// Dashboard HTML
	rd.router.HandleFunc("/", rd.handleDashboard).Methods("GET")
	
	// WebSocket endpoint
	rd.router.HandleFunc("/ws", rd.handleWebSocket)
	
	// API endpoints
	api := rd.router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/widgets", rd.handleGetWidgets).Methods("GET")
	api.HandleFunc("/layouts", rd.handleGetLayouts).Methods("GET")
	api.HandleFunc("/metrics/current", rd.handleGetCurrentMetrics).Methods("GET")
	api.HandleFunc("/metrics/history", rd.handleGetMetricsHistory).Methods("GET")
	
	// Static assets
	rd.router.PathPrefix("/static/").Handler(http.StripPrefix("/static/", http.FileServer(http.Dir("./web/static"))))
}

func (rd *RealtimeDashboard) handleDashboard(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html")
	w.Write([]byte(dashboardHTML))
}

func (rd *RealtimeDashboard) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Check client limit
	if rd.clientCount.Load() >= int32(rd.config.MaxClients) {
		http.Error(w, "Too many connections", http.StatusServiceUnavailable)
		return
	}
	
	// Upgrade connection
	conn, err := rd.upgrader.Upgrade(w, r, nil)
	if err != nil {
		rd.logger.Error("WebSocket upgrade failed", zap.Error(err))
		return
	}
	
	// Create client
	client := &DashboardClient{
		ID:            generateClientID(),
		conn:          conn,
		send:          make(chan []byte, 256),
		subscriptions: make(map[string]bool),
		lastPing:      time.Now(),
	}
	
	// Register client
	rd.clients.Store(client.ID, client)
	rd.clientCount.Add(1)
	
	// Start client handlers
	go client.writePump()
	go client.readPump(rd)
	
	rd.logger.Info("Dashboard client connected", zap.String("client_id", client.ID))
	
	// Send initial data
	rd.sendInitialData(client)
}

func (rd *RealtimeDashboard) handleGetWidgets(w http.ResponseWriter, r *http.Request) {
	widgets := make(map[string]interface{})
	
	for id, widget := range rd.widgets {
		widgets[id] = map[string]interface{}{
			"id":   widget.ID(),
			"type": widget.Type(),
			"data": widget.GetData(),
		}
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(widgets)
}

func (rd *RealtimeDashboard) handleGetLayouts(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(rd.layouts)
}

func (rd *RealtimeDashboard) handleGetCurrentMetrics(w http.ResponseWriter, r *http.Request) {
	summary := rd.metricsAggregator.GetMetricsSummary()
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(summary)
}

func (rd *RealtimeDashboard) handleGetMetricsHistory(w http.ResponseWriter, r *http.Request) {
	// Get duration parameter
	duration := r.URL.Query().Get("duration")
	if duration == "" {
		duration = "1h"
	}
	
	dur, err := time.ParseDuration(duration)
	if err != nil {
		http.Error(w, "Invalid duration", http.StatusBadRequest)
		return
	}
	
	// Get historical data
	history := rd.metricsAggregator.timeSeries.GetRecentData(dur)
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(history)
}

func (rd *RealtimeDashboard) sendInitialData(client *DashboardClient) {
	// Send current widget data
	for _, widget := range rd.widgets {
		update := DashboardUpdate{
			Type:      "widget_update",
			WidgetID:  widget.ID(),
			Data:      widget.GetData(),
			Timestamp: time.Now().Unix(),
		}
		
		if data, err := json.Marshal(update); err == nil {
			select {
			case client.send <- data:
			default:
				// Client send channel full
			}
		}
	}
}

func (rd *RealtimeDashboard) broadcastLoop() {
	defer rd.wg.Done()
	
	for {
		select {
		case <-rd.ctx.Done():
			return
		case update := <-rd.updateChan:
			rd.broadcastUpdate(update)
		}
	}
}

func (rd *RealtimeDashboard) broadcastUpdate(update DashboardUpdate) {
	data, err := json.Marshal(update)
	if err != nil {
		rd.logger.Error("Failed to marshal update", zap.Error(err))
		return
	}
	
	// Send to all connected clients
	rd.clients.Range(func(key, value interface{}) bool {
		client := value.(*DashboardClient)
		
		// Check if client is subscribed to this widget
		if update.WidgetID != "" {
			client.mu.RLock()
			subscribed := client.subscriptions[update.WidgetID]
			client.mu.RUnlock()
			
			if !subscribed {
				return true
			}
		}
		
		select {
		case client.send <- data:
		default:
			// Client send channel full, close connection
			rd.removeClient(client.ID)
		}
		
		return true
	})
}

func (rd *RealtimeDashboard) metricsUpdateLoop() {
	defer rd.wg.Done()
	
	ticker := time.NewTicker(rd.config.UpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-rd.ctx.Done():
			return
		case <-ticker.C:
			rd.updateMetrics()
		}
	}
}

func (rd *RealtimeDashboard) updateMetrics() {
	// Get current metrics
	summary := rd.metricsAggregator.GetMetricsSummary()
	
	// Update widgets
	if widget, ok := rd.widgets["mining_overview"].(*MiningOverviewWidget); ok {
		widget.UpdateData(summary.Mining)
		rd.updateChan <- DashboardUpdate{
			Type:      "widget_update",
			WidgetID:  "mining_overview",
			Data:      widget.GetData(),
			Timestamp: time.Now().Unix(),
		}
	}
	
	if widget, ok := rd.widgets["hashrate_chart"].(*HashRateChartWidget); ok {
		widget.AddDataPoint(summary.Mining.HashRate)
		rd.updateChan <- DashboardUpdate{
			Type:      "widget_update",
			WidgetID:  "hashrate_chart",
			Data:      widget.GetData(),
			Timestamp: time.Now().Unix(),
		}
	}
	
	if widget, ok := rd.widgets["hardware_status"].(*HardwareStatusWidget); ok {
		widget.UpdateData(summary.Hardware)
		rd.updateChan <- DashboardUpdate{
			Type:      "widget_update",
			WidgetID:  "hardware_status",
			Data:      widget.GetData(),
			Timestamp: time.Now().Unix(),
		}
	}
	
	if widget, ok := rd.widgets["network_status"].(*NetworkStatusWidget); ok {
		widget.UpdateData(summary.Network)
		rd.updateChan <- DashboardUpdate{
			Type:      "widget_update",
			WidgetID:  "network_status",
			Data:      widget.GetData(),
			Timestamp: time.Now().Unix(),
		}
	}
	
	if widget, ok := rd.widgets["performance_metrics"].(*PerformanceMetricsWidget); ok {
		widget.UpdateData(summary.Performance)
		rd.updateChan <- DashboardUpdate{
			Type:      "widget_update",
			WidgetID:  "performance_metrics",
			Data:      widget.GetData(),
			Timestamp: time.Now().Unix(),
		}
	}
}

func (rd *RealtimeDashboard) clientCleanupLoop() {
	defer rd.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-rd.ctx.Done():
			return
		case <-ticker.C:
			rd.cleanupClients()
		}
	}
}

func (rd *RealtimeDashboard) cleanupClients() {
	now := time.Now()
	
	rd.clients.Range(func(key, value interface{}) bool {
		client := value.(*DashboardClient)
		
		// Check for stale connections
		if now.Sub(client.lastPing) > 60*time.Second {
			rd.removeClient(client.ID)
		}
		
		return true
	})
}

func (rd *RealtimeDashboard) removeClient(clientID string) {
	if value, ok := rd.clients.LoadAndDelete(clientID); ok {
		client := value.(*DashboardClient)
		close(client.send)
		client.conn.Close()
		rd.clientCount.Add(-1)
		
		rd.logger.Info("Dashboard client disconnected", zap.String("client_id", clientID))
	}
}

// Client methods

func (c *DashboardClient) readPump(rd *RealtimeDashboard) {
	defer func() {
		rd.removeClient(c.ID)
	}()
	
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		c.lastPing = time.Now()
		return nil
	})
	
	for {
		var msg ClientMessage
		err := c.conn.ReadJSON(&msg)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				rd.logger.Error("WebSocket read error", zap.Error(err))
			}
			break
		}
		
		// Handle client message
		c.handleMessage(rd, msg)
	}
}

func (c *DashboardClient) writePump() {
	ticker := time.NewTicker(54 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	
	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			
			c.conn.WriteMessage(websocket.TextMessage, message)
			
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *DashboardClient) handleMessage(rd *RealtimeDashboard, msg ClientMessage) {
	switch msg.Type {
	case "subscribe":
		c.mu.Lock()
		for _, widgetID := range msg.Widgets {
			c.subscriptions[widgetID] = true
		}
		c.mu.Unlock()
		
	case "unsubscribe":
		c.mu.Lock()
		for _, widgetID := range msg.Widgets {
			delete(c.subscriptions, widgetID)
		}
		c.mu.Unlock()
		
	case "ping":
		c.lastPing = time.Now()
	}
}

// Widget implementations

type MiningOverviewWidget struct {
	id   string
	data MiningOverviewData
	mu   sync.RWMutex
}

type MiningOverviewData struct {
	HashRate        string  `json:"hashrate"`
	SharesAccepted  uint64  `json:"shares_accepted"`
	SharesRejected  uint64  `json:"shares_rejected"`
	Efficiency      float64 `json:"efficiency"`
	ActiveWorkers   int     `json:"active_workers"`
}

func (w *MiningOverviewWidget) ID() string { return w.id }
func (w *MiningOverviewWidget) Type() string { return "overview" }

func (w *MiningOverviewWidget) GetData() interface{} {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.data
}

func (w *MiningOverviewWidget) Update(data interface{}) {
	// Implementation
}

func (w *MiningOverviewWidget) UpdateData(summary *MiningMetricsSummary) {
	w.mu.Lock()
	defer w.mu.Unlock()
	
	w.data = MiningOverviewData{
		HashRate:       formatHashRate(summary.HashRate),
		SharesAccepted: summary.SharesAccepted,
		SharesRejected: summary.SharesRejected,
		Efficiency:     summary.Efficiency,
		ActiveWorkers:  1, // Placeholder
	}
}

type HashRateChartWidget struct {
	id         string
	dataPoints []DataPoint
	mu         sync.RWMutex
}

type DataPoint struct {
	Time  int64   `json:"time"`
	Value float64 `json:"value"`
}

func (w *HashRateChartWidget) ID() string { return w.id }
func (w *HashRateChartWidget) Type() string { return "chart" }

func (w *HashRateChartWidget) GetData() interface{} {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.dataPoints
}

func (w *HashRateChartWidget) Update(data interface{}) {
	// Implementation
}

func (w *HashRateChartWidget) AddDataPoint(hashRate float64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	
	point := DataPoint{
		Time:  time.Now().Unix(),
		Value: hashRate,
	}
	
	w.dataPoints = append(w.dataPoints, point)
	
	// Keep only last 100 points
	if len(w.dataPoints) > 100 {
		w.dataPoints = w.dataPoints[len(w.dataPoints)-100:]
	}
}

// Additional widget implementations...

type HardwareStatusWidget struct {
	id   string
	data HardwareStatusData
	mu   sync.RWMutex
}

type HardwareStatusData struct {
	CPUUsage       float64 `json:"cpu_usage"`
	CPUTemp        float64 `json:"cpu_temp"`
	GPUUsage       float64 `json:"gpu_usage"`
	GPUTemp        float64 `json:"gpu_temp"`
	GPUPower       float64 `json:"gpu_power"`
	MemoryUsed     uint64  `json:"memory_used"`
	MemoryTotal    uint64  `json:"memory_total"`
}

func (w *HardwareStatusWidget) ID() string { return w.id }
func (w *HardwareStatusWidget) Type() string { return "hardware" }

func (w *HardwareStatusWidget) GetData() interface{} {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.data
}

func (w *HardwareStatusWidget) Update(data interface{}) {}

func (w *HardwareStatusWidget) UpdateData(summary *HardwareMetricsSummary) {
	w.mu.Lock()
	defer w.mu.Unlock()
	
	w.data = HardwareStatusData{
		CPUUsage:  summary.CPUUsage,
		CPUTemp:   summary.CPUTemperature,
		GPUUsage:  summary.GPUUsage,
		GPUTemp:   summary.GPUTemperature,
		GPUPower:  summary.GPUPowerDraw,
	}
}

type NetworkStatusWidget struct {
	id   string
	data NetworkStatusData
	mu   sync.RWMutex
}

type NetworkStatusData struct {
	PeerCount    int    `json:"peer_count"`
	Connections  int    `json:"connections"`
	BytesIn      uint64 `json:"bytes_in"`
	BytesOut     uint64 `json:"bytes_out"`
	NetworkType  string `json:"network_type"`
}

func (w *NetworkStatusWidget) ID() string { return w.id }
func (w *NetworkStatusWidget) Type() string { return "network" }

func (w *NetworkStatusWidget) GetData() interface{} {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.data
}

func (w *NetworkStatusWidget) Update(data interface{}) {}

func (w *NetworkStatusWidget) UpdateData(summary *NetworkMetricsSummary) {
	w.mu.Lock()
	defer w.mu.Unlock()
	
	w.data = NetworkStatusData{
		PeerCount:   summary.PeerCount,
		Connections: summary.ActiveConnections,
		BytesIn:     summary.BytesReceived,
		BytesOut:    summary.BytesSent,
		NetworkType: "P2P",
	}
}

type PerformanceMetricsWidget struct {
	id   string
	data PerformanceData
	mu   sync.RWMutex
}

type PerformanceData struct {
	RequestRate uint64  `json:"request_rate"`
	ErrorRate   float64 `json:"error_rate"`
	AvgLatency  float64 `json:"avg_latency"`
	Uptime      string  `json:"uptime"`
}

func (w *PerformanceMetricsWidget) ID() string { return w.id }
func (w *PerformanceMetricsWidget) Type() string { return "performance" }

func (w *PerformanceMetricsWidget) GetData() interface{} {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.data
}

func (w *PerformanceMetricsWidget) Update(data interface{}) {}

func (w *PerformanceMetricsWidget) UpdateData(summary *PerformanceMetricsSummary) {
	w.mu.Lock()
	defer w.mu.Unlock()
	
	w.data = PerformanceData{
		RequestRate: summary.RequestRate,
		ErrorRate:   float64(summary.ErrorRate) / float64(summary.RequestRate),
		AvgLatency:  summary.AvgLatency,
		Uptime:      "99.9%", // Placeholder
	}
}

type AlertsWidget struct {
	id     string
	alerts []Alert
	mu     sync.RWMutex
}

type Alert struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Severity  string `json:"severity"`
	Message   string `json:"message"`
	Timestamp int64  `json:"timestamp"`
}

func (w *AlertsWidget) ID() string { return w.id }
func (w *AlertsWidget) Type() string { return "alerts" }

func (w *AlertsWidget) GetData() interface{} {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.alerts
}

func (w *AlertsWidget) Update(data interface{}) {}

func (w *AlertsWidget) AddAlert(alert Alert) {
	w.mu.Lock()
	defer w.mu.Unlock()
	
	w.alerts = append([]Alert{alert}, w.alerts...)
	
	// Keep only last 50 alerts
	if len(w.alerts) > 50 {
		w.alerts = w.alerts[:50]
	}
}

type ProfitabilityWidget struct {
	id   string
	data ProfitabilityData
	mu   sync.RWMutex
}

type ProfitabilityData struct {
	CurrentProfit float64 `json:"current_profit"`
	DailyProfit   float64 `json:"daily_profit"`
	MonthlyProfit float64 `json:"monthly_profit"`
	PowerCost     float64 `json:"power_cost"`
	NetProfit     float64 `json:"net_profit"`
}

func (w *ProfitabilityWidget) ID() string { return w.id }
func (w *ProfitabilityWidget) Type() string { return "profitability" }

func (w *ProfitabilityWidget) GetData() interface{} {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.data
}

func (w *ProfitabilityWidget) Update(data interface{}) {}

// Helper types

type ClientMessage struct {
	Type    string   `json:"type"`
	Widgets []string `json:"widgets,omitempty"`
}

// Helper functions

func DefaultDashboardConfig() *DashboardConfig {
	return &DashboardConfig{
		ListenAddr:     ":8888",
		UpdateInterval: 1 * time.Second,
		MaxClients:     100,
		EnableAuth:     false,
		AllowedOrigins: []string{"*"},
		DataRetention:  24 * time.Hour,
	}
}

func generateClientID() string {
	return fmt.Sprintf("client-%d", time.Now().UnixNano())
}

func formatHashRate(rate float64) string {
	units := []string{"H/s", "KH/s", "MH/s", "GH/s", "TH/s", "PH/s"}
	unitIndex := 0
	
	for rate >= 1000 && unitIndex < len(units)-1 {
		rate /= 1000
		unitIndex++
	}
	
	return fmt.Sprintf("%.2f %s", rate, units[unitIndex])
}

// Basic dashboard HTML template
const dashboardHTML = `
<!DOCTYPE html>
<html>
<head>
    <title>Otedama Mining Dashboard</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            margin: 0;
            padding: 20px;
            background: #1a1a1a;
            color: #fff;
        }
        .dashboard-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
        }
        .widget {
            background: #2a2a2a;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        }
        .widget-title {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 15px;
            color: #4CAF50;
        }
        .metric {
            display: flex;
            justify-content: space-between;
            margin: 10px 0;
        }
        .metric-label {
            color: #999;
        }
        .metric-value {
            font-weight: 600;
        }
        .status-indicator {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            margin-right: 5px;
        }
        .status-online { background: #4CAF50; }
        .status-warning { background: #FFC107; }
        .status-error { background: #F44336; }
    </style>
</head>
<body>
    <h1>Otedama Mining Dashboard</h1>
    <div id="connection-status">Connecting...</div>
    <div class="dashboard-grid" id="dashboard"></div>
    
    <script>
        const ws = new WebSocket('ws://' + window.location.host + '/ws');
        const dashboard = document.getElementById('dashboard');
        const connectionStatus = document.getElementById('connection-status');
        
        ws.onopen = function() {
            connectionStatus.textContent = 'Connected';
            connectionStatus.style.color = '#4CAF50';
            
            // Subscribe to all widgets
            ws.send(JSON.stringify({
                type: 'subscribe',
                widgets: ['mining_overview', 'hashrate_chart', 'hardware_status', 'network_status', 'performance_metrics', 'alerts', 'profitability']
            }));
        };
        
        ws.onmessage = function(event) {
            const update = JSON.parse(event.data);
            updateWidget(update);
        };
        
        ws.onclose = function() {
            connectionStatus.textContent = 'Disconnected';
            connectionStatus.style.color = '#F44336';
        };
        
        function updateWidget(update) {
            // Update widget based on data
            console.log('Widget update:', update);
        }
    </script>
</body>
</html>
`