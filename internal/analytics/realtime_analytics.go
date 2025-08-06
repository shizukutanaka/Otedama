package analytics

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

// RealtimeAnalytics provides real-time analytics streaming
type RealtimeAnalytics struct {
	logger     *zap.Logger
	engine     *AnalyticsEngine
	
	// WebSocket connections
	clients    map[*Client]bool
	clientsMu  sync.RWMutex
	
	// Channels
	broadcast  chan *AnalyticsUpdate
	register   chan *Client
	unregister chan *Client
	
	// Metrics buffer
	metricsBuffer *MetricsBuffer
	
	// Configuration
	updateInterval time.Duration
	bufferSize     int
	
	// Context
	ctx    context.Context
	cancel context.CancelFunc
}

// Client represents a WebSocket client
type Client struct {
	ID         string
	conn       *websocket.Conn
	send       chan []byte
	filters    ClientFilters
	analytics  *RealtimeAnalytics
}

// ClientFilters defines what data the client wants to receive
type ClientFilters struct {
	Currencies []string
	Metrics    []string
	Workers    []string
	UpdateRate time.Duration
}

// AnalyticsUpdate contains real-time analytics data
type AnalyticsUpdate struct {
	Type      string                 `json:"type"`
	Timestamp time.Time              `json:"timestamp"`
	Currency  string                 `json:"currency,omitempty"`
	Data      map[string]interface{} `json:"data"`
}

// MetricsBuffer stores recent metrics for aggregation
type MetricsBuffer struct {
	mu      sync.RWMutex
	entries []MetricEntry
	maxSize int
}

// MetricEntry represents a single metric entry
type MetricEntry struct {
	Type      string
	Currency  string
	WorkerID  string
	Value     float64
	Timestamp time.Time
	Metadata  map[string]interface{}
}

// NewRealtimeAnalytics creates a new real-time analytics service
func NewRealtimeAnalytics(logger *zap.Logger, engine *AnalyticsEngine, updateInterval time.Duration) *RealtimeAnalytics {
	ctx, cancel := context.WithCancel(context.Background())
	
	ra := &RealtimeAnalytics{
		logger:         logger,
		engine:         engine,
		clients:        make(map[*Client]bool),
		broadcast:      make(chan *AnalyticsUpdate, 256),
		register:       make(chan *Client),
		unregister:     make(chan *Client),
		updateInterval: updateInterval,
		bufferSize:     10000,
		ctx:            ctx,
		cancel:         cancel,
		metricsBuffer: &MetricsBuffer{
			entries: make([]MetricEntry, 0, 10000),
			maxSize: 10000,
		},
	}
	
	// Start the hub
	go ra.run()
	
	// Start update workers
	go ra.metricsUpdateWorker()
	go ra.aggregationWorker()
	
	return ra
}

// Stop stops the real-time analytics service
func (ra *RealtimeAnalytics) Stop() {
	ra.cancel()
	close(ra.broadcast)
}

// ServeWS handles WebSocket connections
func (ra *RealtimeAnalytics) ServeWS(conn *websocket.Conn, clientID string, filters ClientFilters) {
	client := &Client{
		ID:        clientID,
		conn:      conn,
		send:      make(chan []byte, 256),
		filters:   filters,
		analytics: ra,
	}
	
	ra.register <- client
	
	// Start client workers
	go client.writePump()
	go client.readPump()
}

// run is the main hub loop
func (ra *RealtimeAnalytics) run() {
	ticker := time.NewTicker(ra.updateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ra.ctx.Done():
			return
			
		case client := <-ra.register:
			ra.clientsMu.Lock()
			ra.clients[client] = true
			ra.clientsMu.Unlock()
			
			ra.logger.Info("Client connected",
				zap.String("client_id", client.ID),
				zap.Int("total_clients", len(ra.clients)),
			)
			
			// Send initial data
			ra.sendInitialData(client)
			
		case client := <-ra.unregister:
			ra.clientsMu.Lock()
			if _, ok := ra.clients[client]; ok {
				delete(ra.clients, client)
				close(client.send)
				ra.clientsMu.Unlock()
				
				ra.logger.Info("Client disconnected",
					zap.String("client_id", client.ID),
					zap.Int("remaining_clients", len(ra.clients)),
				)
			} else {
				ra.clientsMu.Unlock()
			}
			
		case update := <-ra.broadcast:
			ra.broadcastUpdate(update)
			
		case <-ticker.C:
			ra.broadcastPeriodicUpdates()
		}
	}
}

// broadcastUpdate sends update to relevant clients
func (ra *RealtimeAnalytics) broadcastUpdate(update *AnalyticsUpdate) {
	data, err := json.Marshal(update)
	if err != nil {
		ra.logger.Error("Failed to marshal update", zap.Error(err))
		return
	}
	
	ra.clientsMu.RLock()
	defer ra.clientsMu.RUnlock()
	
	for client := range ra.clients {
		// Check if client wants this update
		if ra.shouldSendToClient(client, update) {
			select {
			case client.send <- data:
			default:
				// Client's send channel is full, close it
				close(client.send)
				delete(ra.clients, client)
			}
		}
	}
}

// shouldSendToClient checks if update matches client filters
func (ra *RealtimeAnalytics) shouldSendToClient(client *Client, update *AnalyticsUpdate) bool {
	// Check currency filter
	if len(client.filters.Currencies) > 0 && update.Currency != "" {
		found := false
		for _, curr := range client.filters.Currencies {
			if curr == update.Currency {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	
	// Check metric filter
	if len(client.filters.Metrics) > 0 {
		found := false
		for _, metric := range client.filters.Metrics {
			if metric == update.Type {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	
	return true
}

// sendInitialData sends initial state to new client
func (ra *RealtimeAnalytics) sendInitialData(client *Client) {
	// Send current pool statistics
	for _, currency := range client.filters.Currencies {
		stats, err := ra.engine.GetPoolStatistics(currency)
		if err != nil {
			continue
		}
		
		update := &AnalyticsUpdate{
			Type:      "pool_stats",
			Timestamp: time.Now(),
			Currency:  currency,
			Data: map[string]interface{}{
				"hashrate":       stats.Hashrate,
				"workers":        stats.ActiveWorkers,
				"efficiency":     stats.PoolEfficiency,
				"shares_per_min": stats.SharesPerMinute,
			},
		}
		
		data, _ := json.Marshal(update)
		client.send <- data
	}
}

// broadcastPeriodicUpdates sends periodic updates to all clients
func (ra *RealtimeAnalytics) broadcastPeriodicUpdates() {
	// Get current metrics from buffer
	metrics := ra.metricsBuffer.GetRecent(100)
	
	// Aggregate by currency
	currencyMetrics := make(map[string]*AggregatedMetrics)
	
	for _, metric := range metrics {
		if _, exists := currencyMetrics[metric.Currency]; !exists {
			currencyMetrics[metric.Currency] = &AggregatedMetrics{
				Currency: metric.Currency,
			}
		}
		
		agg := currencyMetrics[metric.Currency]
		
		switch metric.Type {
		case "hashrate":
			agg.Hashrate += metric.Value
			agg.HashrateCount++
		case "share":
			if metric.Metadata["valid"].(bool) {
				agg.ValidShares++
			} else {
				agg.InvalidShares++
			}
		case "block":
			agg.BlocksFound++
		}
	}
	
	// Send aggregated updates
	for currency, agg := range currencyMetrics {
		update := &AnalyticsUpdate{
			Type:      "metrics_update",
			Timestamp: time.Now(),
			Currency:  currency,
			Data:      agg.ToMap(),
		}
		
		ra.broadcast <- update
	}
}

// metricsUpdateWorker collects real-time metrics
func (ra *RealtimeAnalytics) metricsUpdateWorker() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ra.ctx.Done():
			return
		case <-ticker.C:
			ra.collectCurrentMetrics()
		}
	}
}

// collectCurrentMetrics gathers current metrics
func (ra *RealtimeAnalytics) collectCurrentMetrics() {
	currencies := []string{"BTC", "ETH", "LTC"} // Get from currency manager
	
	for _, currency := range currencies {
		// Get current pool stats
		stats, err := ra.engine.GetPoolStatistics(currency)
		if err != nil {
			continue
		}
		
		// Add to metrics buffer
		ra.metricsBuffer.Add(MetricEntry{
			Type:      "hashrate",
			Currency:  currency,
			Value:     stats.Hashrate,
			Timestamp: time.Now(),
			Metadata: map[string]interface{}{
				"workers": stats.ActiveWorkers,
			},
		})
		
		// Send immediate update for significant changes
		if ra.isSignificantChange(currency, "hashrate", stats.Hashrate) {
			update := &AnalyticsUpdate{
				Type:      "hashrate_change",
				Timestamp: time.Now(),
				Currency:  currency,
				Data: map[string]interface{}{
					"hashrate":     stats.Hashrate,
					"hashrate_unit": stats.HashrateUnit,
					"change_percent": ra.calculateChangePercent(currency, "hashrate", stats.Hashrate),
				},
			}
			
			ra.broadcast <- update
		}
	}
}

// aggregationWorker performs periodic aggregations
func (ra *RealtimeAnalytics) aggregationWorker() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ra.ctx.Done():
			return
		case <-ticker.C:
			ra.performAggregations()
		}
	}
}

// performAggregations calculates aggregated metrics
func (ra *RealtimeAnalytics) performAggregations() {
	// Get metrics from the last minute
	recentMetrics := ra.metricsBuffer.GetSince(time.Now().Add(-1 * time.Minute))
	
	// Calculate 1-minute aggregations
	aggregations := make(map[string]*TimeSeriesAggregation)
	
	for _, metric := range recentMetrics {
		key := fmt.Sprintf("%s:%s", metric.Currency, metric.Type)
		if _, exists := aggregations[key]; !exists {
			aggregations[key] = &TimeSeriesAggregation{
				Currency: metric.Currency,
				Type:     metric.Type,
				Period:   "1m",
			}
		}
		
		aggregations[key].AddValue(metric.Value)
	}
	
	// Broadcast aggregated data
	for _, agg := range aggregations {
		update := &AnalyticsUpdate{
			Type:      "aggregation",
			Timestamp: time.Now(),
			Currency:  agg.Currency,
			Data: map[string]interface{}{
				"metric":   agg.Type,
				"period":   agg.Period,
				"avg":      agg.Average(),
				"min":      agg.Min,
				"max":      agg.Max,
				"count":    agg.Count,
			},
		}
		
		ra.broadcast <- update
	}
}

// RecordMetric records a real-time metric
func (ra *RealtimeAnalytics) RecordMetric(metric MetricEntry) {
	// Add to buffer
	ra.metricsBuffer.Add(metric)
	
	// Check if immediate broadcast is needed
	switch metric.Type {
	case "block_found":
		update := &AnalyticsUpdate{
			Type:      "block_found",
			Timestamp: metric.Timestamp,
			Currency:  metric.Currency,
			Data: map[string]interface{}{
				"worker_id": metric.WorkerID,
				"height":    metric.Metadata["height"],
				"reward":    metric.Metadata["reward"],
			},
		}
		ra.broadcast <- update
		
	case "large_payout":
		update := &AnalyticsUpdate{
			Type:      "payout",
			Timestamp: metric.Timestamp,
			Currency:  metric.Currency,
			Data: map[string]interface{}{
				"amount":   metric.Value,
				"tx_id":    metric.Metadata["tx_id"],
				"workers":  metric.Metadata["worker_count"],
			},
		}
		ra.broadcast <- update
	}
}

// Client methods

func (c *Client) readPump() {
	defer func() {
		c.analytics.unregister <- c
		c.conn.Close()
	}()
	
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	
	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			break
		}
		
		// Handle client messages (filter updates, etc.)
		var msg ClientMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			continue
		}
		
		c.handleMessage(msg)
	}
}

func (c *Client) writePump() {
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

func (c *Client) handleMessage(msg ClientMessage) {
	switch msg.Type {
	case "update_filters":
		if filters, ok := msg.Data["filters"].(ClientFilters); ok {
			c.filters = filters
		}
		
	case "subscribe":
		if currency, ok := msg.Data["currency"].(string); ok {
			c.filters.Currencies = append(c.filters.Currencies, currency)
		}
		
	case "unsubscribe":
		if currency, ok := msg.Data["currency"].(string); ok {
			newCurrencies := []string{}
			for _, curr := range c.filters.Currencies {
				if curr != currency {
					newCurrencies = append(newCurrencies, curr)
				}
			}
			c.filters.Currencies = newCurrencies
		}
	}
}

// ClientMessage represents a message from client
type ClientMessage struct {
	Type string                 `json:"type"`
	Data map[string]interface{} `json:"data"`
}

// MetricsBuffer methods

func (mb *MetricsBuffer) Add(entry MetricEntry) {
	mb.mu.Lock()
	defer mb.mu.Unlock()
	
	mb.entries = append(mb.entries, entry)
	
	// Trim if exceeds max size
	if len(mb.entries) > mb.maxSize {
		mb.entries = mb.entries[len(mb.entries)-mb.maxSize:]
	}
}

func (mb *MetricsBuffer) GetRecent(count int) []MetricEntry {
	mb.mu.RLock()
	defer mb.mu.RUnlock()
	
	if count > len(mb.entries) {
		count = len(mb.entries)
	}
	
	result := make([]MetricEntry, count)
	copy(result, mb.entries[len(mb.entries)-count:])
	
	return result
}

func (mb *MetricsBuffer) GetSince(since time.Time) []MetricEntry {
	mb.mu.RLock()
	defer mb.mu.RUnlock()
	
	var result []MetricEntry
	
	for i := len(mb.entries) - 1; i >= 0; i-- {
		if mb.entries[i].Timestamp.Before(since) {
			break
		}
		result = append(result, mb.entries[i])
	}
	
	return result
}

// Helper types

type AggregatedMetrics struct {
	Currency      string
	Hashrate      float64
	HashrateCount int
	ValidShares   int
	InvalidShares int
	BlocksFound   int
}

func (am *AggregatedMetrics) ToMap() map[string]interface{} {
	avgHashrate := float64(0)
	if am.HashrateCount > 0 {
		avgHashrate = am.Hashrate / float64(am.HashrateCount)
	}
	
	return map[string]interface{}{
		"avg_hashrate":   avgHashrate,
		"valid_shares":   am.ValidShares,
		"invalid_shares": am.InvalidShares,
		"blocks_found":   am.BlocksFound,
	}
}

type TimeSeriesAggregation struct {
	Currency string
	Type     string
	Period   string
	Values   []float64
	Min      float64
	Max      float64
	Sum      float64
	Count    int
}

func (tsa *TimeSeriesAggregation) AddValue(value float64) {
	tsa.Values = append(tsa.Values, value)
	tsa.Sum += value
	tsa.Count++
	
	if tsa.Count == 1 || value < tsa.Min {
		tsa.Min = value
	}
	if tsa.Count == 1 || value > tsa.Max {
		tsa.Max = value
	}
}

func (tsa *TimeSeriesAggregation) Average() float64 {
	if tsa.Count == 0 {
		return 0
	}
	return tsa.Sum / float64(tsa.Count)
}

// Helper methods

func (ra *RealtimeAnalytics) isSignificantChange(currency, metric string, newValue float64) bool {
	// Check if change is significant enough to broadcast immediately
	// This is a simplified implementation
	return false // Placeholder
}

func (ra *RealtimeAnalytics) calculateChangePercent(currency, metric string, newValue float64) float64 {
	// Calculate percentage change from previous value
	// This is a simplified implementation
	return 0.0 // Placeholder
}