package mining

import (
	"encoding/json"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// RevenueTracker tracks real-time mining revenue with high precision
type RevenueTracker struct {
	logger *zap.Logger
	
	// Real-time tracking
	currentRevenue  atomic.Value // *RevenueSnapshot
	revenueHistory  []RevenueSnapshot
	historyMu       sync.RWMutex
	
	// Configuration
	config          RevenueConfig
	
	// Coin prices
	priceCache      map[string]float64
	priceMu         sync.RWMutex
	
	// Share tracking
	shareTracker    *ShareRevenueTracker
	
	// Statistics
	stats           *RevenueStats
	
	// Update channel
	updateChan      chan RevenueUpdate
	stopChan        chan struct{}
	wg              sync.WaitGroup
}

// RevenueConfig configures revenue tracking
type RevenueConfig struct {
	UpdateInterval   time.Duration
	HistorySize      int
	PowerCostPerKWh  float64
	ExchangeRates    map[string]float64 // Coin to USD rates
	TaxRate          float64            // Tax percentage
	PoolFees         map[string]float64 // Pool fees by coin
}

// RevenueSnapshot represents revenue at a point in time
type RevenueSnapshot struct {
	Timestamp        time.Time
	
	// Revenue breakdown
	GrossRevenue     float64            // Total revenue before costs
	PowerCost        float64            // Electricity cost
	PoolFees         float64            // Pool fees
	NetRevenue       float64            // Revenue after costs
	
	// By coin
	CoinRevenue      map[string]float64
	CoinShares       map[string]uint64
	
	// Performance metrics
	EffectiveHashrate float64
	PowerUsage       float64            // kW
	Efficiency       float64            // Revenue per kW
	
	// Projections
	HourlyProjection float64
	DailyProjection  float64
	MonthlyProjection float64
}

// RevenueUpdate represents a revenue update event
type RevenueUpdate struct {
	Type      string
	Coin      string
	Amount    float64
	Shares    uint64
	Timestamp time.Time
}

// ShareRevenueTracker tracks revenue per share
type ShareRevenueTracker struct {
	shares    map[string]*ShareRevenue
	mu        sync.RWMutex
}

// ShareRevenue tracks revenue for a specific share
type ShareRevenue struct {
	ShareID    string
	Coin       string
	Difficulty float64
	Value      float64
	Timestamp  time.Time
	Status     string // pending, confirmed, paid
}

// RevenueStats contains aggregated revenue statistics
type RevenueStats struct {
	TotalRevenue     atomic.Value // float64
	TotalPowerCost   atomic.Value // float64
	TotalPoolFees    atomic.Value // float64
	TotalShares      atomic.Uint64
	
	// By period
	HourlyRevenue    *RollingAverage
	DailyRevenue     *RollingAverage
	WeeklyRevenue    *RollingAverage
	
	// Efficiency metrics
	RevenuePerShare  *RollingAverage
	PowerEfficiency  *RollingAverage
}

// RollingAverage implements a rolling average calculator
type RollingAverage struct {
	values   []float64
	sum      float64
	index    int
	size     int
	filled   bool
	mu       sync.Mutex
}

// NewRevenueTracker creates a new revenue tracker
func NewRevenueTracker(logger *zap.Logger, config RevenueConfig) *RevenueTracker {
	rt := &RevenueTracker{
		logger:       logger,
		config:       config,
		priceCache:   make(map[string]float64),
		updateChan:   make(chan RevenueUpdate, 1000),
		stopChan:     make(chan struct{}),
		shareTracker: &ShareRevenueTracker{
			shares: make(map[string]*ShareRevenue),
		},
		stats: &RevenueStats{
			HourlyRevenue:   NewRollingAverage(60),    // 60 minutes
			DailyRevenue:    NewRollingAverage(24),    // 24 hours
			WeeklyRevenue:   NewRollingAverage(7),     // 7 days
			RevenuePerShare: NewRollingAverage(1000),  // Last 1000 shares
			PowerEfficiency: NewRollingAverage(100),   // Last 100 measurements
		},
		revenueHistory: make([]RevenueSnapshot, 0, config.HistorySize),
	}
	
	// Initialize with zero snapshot
	rt.currentRevenue.Store(&RevenueSnapshot{
		Timestamp:    time.Now(),
		CoinRevenue:  make(map[string]float64),
		CoinShares:   make(map[string]uint64),
	})
	
	// Initialize stats
	rt.stats.TotalRevenue.Store(0.0)
	rt.stats.TotalPowerCost.Store(0.0)
	rt.stats.TotalPoolFees.Store(0.0)
	
	return rt
}

// Start begins revenue tracking
func (rt *RevenueTracker) Start() {
	rt.wg.Add(2)
	go rt.updateLoop()
	go rt.processUpdates()
	
	rt.logger.Info("Revenue tracker started",
		zap.Duration("update_interval", rt.config.UpdateInterval),
		zap.Float64("power_cost", rt.config.PowerCostPerKWh),
	)
}

// Stop stops revenue tracking
func (rt *RevenueTracker) Stop() {
	close(rt.stopChan)
	rt.wg.Wait()
	rt.logger.Info("Revenue tracker stopped")
}

// RecordShare records revenue for a share
func (rt *RevenueTracker) RecordShare(coin string, difficulty float64, accepted bool) {
	if !accepted {
		return
	}
	
	update := RevenueUpdate{
		Type:      "share",
		Coin:      coin,
		Amount:    rt.calculateShareValue(coin, difficulty),
		Shares:    1,
		Timestamp: time.Now(),
	}
	
	select {
	case rt.updateChan <- update:
	default:
		rt.logger.Warn("Revenue update channel full")
	}
}

// RecordBlock records revenue for a found block
func (rt *RevenueTracker) RecordBlock(coin string, reward float64) {
	update := RevenueUpdate{
		Type:      "block",
		Coin:      coin,
		Amount:    reward,
		Shares:    0,
		Timestamp: time.Now(),
	}
	
	select {
	case rt.updateChan <- update:
	default:
		rt.logger.Warn("Revenue update channel full")
	}
}

// UpdatePrice updates the price for a coin
func (rt *RevenueTracker) UpdatePrice(coin string, price float64) {
	rt.priceMu.Lock()
	rt.priceCache[coin] = price
	rt.priceMu.Unlock()
}

// GetCurrentRevenue returns the current revenue snapshot
func (rt *RevenueTracker) GetCurrentRevenue() *RevenueSnapshot {
	if snapshot := rt.currentRevenue.Load(); snapshot != nil {
		return snapshot.(*RevenueSnapshot)
	}
	return nil
}

// GetRevenueHistory returns revenue history
func (rt *RevenueTracker) GetRevenueHistory(duration time.Duration) []RevenueSnapshot {
	rt.historyMu.RLock()
	defer rt.historyMu.RUnlock()
	
	cutoff := time.Now().Add(-duration)
	var history []RevenueSnapshot
	
	for i := len(rt.revenueHistory) - 1; i >= 0; i-- {
		if rt.revenueHistory[i].Timestamp.Before(cutoff) {
			break
		}
		history = append(history, rt.revenueHistory[i])
	}
	
	// Reverse to chronological order
	for i, j := 0, len(history)-1; i < j; i, j = i+1, j-1 {
		history[i], history[j] = history[j], history[i]
	}
	
	return history
}

// GetRevenueReport generates a detailed revenue report
func (rt *RevenueTracker) GetRevenueReport(period time.Duration) *RevenueReport {
	history := rt.GetRevenueHistory(period)
	current := rt.GetCurrentRevenue()
	
	report := &RevenueReport{
		Period:    period,
		Generated: time.Now(),
		Current:   current,
	}
	
	if len(history) == 0 {
		return report
	}
	
	// Calculate totals
	for _, snapshot := range history {
		report.TotalGrossRevenue += snapshot.GrossRevenue
		report.TotalPowerCost += snapshot.PowerCost
		report.TotalPoolFees += snapshot.PoolFees
		report.TotalNetRevenue += snapshot.NetRevenue
		
		for coin, revenue := range snapshot.CoinRevenue {
			if report.RevenueByC oin == nil {
				report.RevenueByCoin = make(map[string]float64)
			}
			report.RevenueByCoin[coin] += revenue
		}
		
		for coin, shares := range snapshot.CoinShares {
			if report.SharesByCoin == nil {
				report.SharesByCoin = make(map[string]uint64)
			}
			report.SharesByCoin[coin] += shares
		}
	}
	
	// Calculate averages
	count := float64(len(history))
	report.AverageHourlyRevenue = report.TotalNetRevenue / (period.Hours() + 0.001)
	report.AverageDailyRevenue = report.AverageHourlyRevenue * 24
	report.AverageEfficiency = report.TotalNetRevenue / (report.TotalPowerCost + 0.001)
	
	// Calculate ROI
	if report.TotalPowerCost > 0 {
		report.ROI = (report.TotalNetRevenue - report.TotalPowerCost) / report.TotalPowerCost * 100
	}
	
	// Best performing coin
	var bestCoin string
	var bestRevenue float64
	for coin, revenue := range report.RevenueByCoin {
		if revenue > bestRevenue {
			bestCoin = coin
			bestRevenue = revenue
		}
	}
	report.BestPerformingCoin = bestCoin
	
	// Tax estimation
	report.EstimatedTax = report.TotalNetRevenue * (rt.config.TaxRate / 100)
	report.PostTaxRevenue = report.TotalNetRevenue - report.EstimatedTax
	
	return report
}

// RevenueReport represents a comprehensive revenue report
type RevenueReport struct {
	Period              time.Duration
	Generated           time.Time
	
	// Current snapshot
	Current             *RevenueSnapshot
	
	// Totals
	TotalGrossRevenue   float64
	TotalPowerCost      float64
	TotalPoolFees       float64
	TotalNetRevenue     float64
	
	// By coin
	RevenueByCoin       map[string]float64
	SharesByCoin        map[string]uint64
	
	// Averages
	AverageHourlyRevenue float64
	AverageDailyRevenue  float64
	AverageEfficiency    float64
	
	// Performance
	BestPerformingCoin  string
	ROI                 float64 // Return on investment %
	
	// Tax
	EstimatedTax        float64
	PostTaxRevenue      float64
}

// updateLoop periodically updates revenue calculations
func (rt *RevenueTracker) updateLoop() {
	defer rt.wg.Done()
	
	ticker := time.NewTicker(rt.config.UpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-rt.stopChan:
			return
		case <-ticker.C:
			rt.updateSnapshot()
		}
	}
}

// processUpdates processes revenue update events
func (rt *RevenueTracker) processUpdates() {
	defer rt.wg.Done()
	
	for {
		select {
		case <-rt.stopChan:
			return
		case update := <-rt.updateChan:
			rt.processUpdate(update)
		}
	}
}

// processUpdate processes a single revenue update
func (rt *RevenueTracker) processUpdate(update RevenueUpdate) {
	current := rt.GetCurrentRevenue()
	if current == nil {
		return
	}
	
	// Update coin revenue
	if current.CoinRevenue == nil {
		current.CoinRevenue = make(map[string]float64)
	}
	if current.CoinShares == nil {
		current.CoinShares = make(map[string]uint64)
	}
	
	current.CoinRevenue[update.Coin] += update.Amount
	current.CoinShares[update.Coin] += update.Shares
	
	// Update totals
	current.GrossRevenue += update.Amount
	
	// Update stats
	rt.stats.TotalRevenue.Store(rt.stats.TotalRevenue.Load().(float64) + update.Amount)
	rt.stats.TotalShares.Add(update.Shares)
	
	if update.Shares > 0 {
		rt.stats.RevenuePerShare.Add(update.Amount / float64(update.Shares))
	}
}

// updateSnapshot creates a new revenue snapshot
func (rt *RevenueTracker) updateSnapshot() {
	current := rt.GetCurrentRevenue()
	if current == nil {
		return
	}
	
	// Calculate costs
	powerUsage := rt.calculatePowerUsage()
	current.PowerUsage = powerUsage
	current.PowerCost = powerUsage * rt.config.PowerCostPerKWh * (rt.config.UpdateInterval.Hours())
	
	// Calculate pool fees
	current.PoolFees = 0
	for coin, revenue := range current.CoinRevenue {
		if fee, ok := rt.config.PoolFees[coin]; ok {
			current.PoolFees += revenue * (fee / 100)
		}
	}
	
	// Calculate net revenue
	current.NetRevenue = current.GrossRevenue - current.PowerCost - current.PoolFees
	
	// Calculate efficiency
	if powerUsage > 0 {
		current.Efficiency = current.NetRevenue / powerUsage
		rt.stats.PowerEfficiency.Add(current.Efficiency)
	}
	
	// Calculate projections
	elapsed := time.Since(current.Timestamp).Hours()
	if elapsed > 0 {
		current.HourlyProjection = current.NetRevenue / elapsed
		current.DailyProjection = current.HourlyProjection * 24
		current.MonthlyProjection = current.DailyProjection * 30
	}
	
	// Update stats
	rt.stats.TotalPowerCost.Store(rt.stats.TotalPowerCost.Load().(float64) + current.PowerCost)
	rt.stats.TotalPoolFees.Store(rt.stats.TotalPoolFees.Load().(float64) + current.PoolFees)
	rt.stats.HourlyRevenue.Add(current.HourlyProjection)
	rt.stats.DailyRevenue.Add(current.DailyProjection)
	
	// Save to history
	rt.addToHistory(*current)
	
	// Create new snapshot
	newSnapshot := &RevenueSnapshot{
		Timestamp:   time.Now(),
		CoinRevenue: make(map[string]float64),
		CoinShares:  make(map[string]uint64),
	}
	rt.currentRevenue.Store(newSnapshot)
}

// addToHistory adds a snapshot to history
func (rt *RevenueTracker) addToHistory(snapshot RevenueSnapshot) {
	rt.historyMu.Lock()
	defer rt.historyMu.Unlock()
	
	rt.revenueHistory = append(rt.revenueHistory, snapshot)
	
	// Trim history if needed
	if len(rt.revenueHistory) > rt.config.HistorySize {
		rt.revenueHistory = rt.revenueHistory[len(rt.revenueHistory)-rt.config.HistorySize:]
	}
}

// calculateShareValue calculates the value of a share
func (rt *RevenueTracker) calculateShareValue(coin string, difficulty float64) float64 {
	rt.priceMu.RLock()
	price, ok := rt.priceCache[coin]
	rt.priceMu.RUnlock()
	
	if !ok || price <= 0 {
		return 0
	}
	
	// Simplified calculation - in production would be more complex
	baseValue := 0.00001 // Base value per share
	difficultyMultiplier := math.Log10(difficulty + 1)
	
	return baseValue * price * difficultyMultiplier
}

// calculatePowerUsage calculates current power usage in kW
func (rt *RevenueTracker) calculatePowerUsage() float64 {
	// In production, this would get actual power usage from hardware
	// For now, return estimate based on hashrate
	return 1.0 // 1 kW default
}

// ExportJSON exports revenue data as JSON
func (rt *RevenueTracker) ExportJSON(period time.Duration) ([]byte, error) {
	report := rt.GetRevenueReport(period)
	return json.MarshalIndent(report, "", "  ")
}

// ExportCSV exports revenue data as CSV
func (rt *RevenueTracker) ExportCSV(period time.Duration) string {
	history := rt.GetRevenueHistory(period)
	
	csv := "Timestamp,Gross Revenue,Power Cost,Pool Fees,Net Revenue,Efficiency,Daily Projection\n"
	
	for _, snapshot := range history {
		csv += fmt.Sprintf("%s,%.4f,%.4f,%.4f,%.4f,%.4f,%.2f\n",
			snapshot.Timestamp.Format(time.RFC3339),
			snapshot.GrossRevenue,
			snapshot.PowerCost,
			snapshot.PoolFees,
			snapshot.NetRevenue,
			snapshot.Efficiency,
			snapshot.DailyProjection,
		)
	}
	
	return csv
}

// NewRollingAverage creates a new rolling average calculator
func NewRollingAverage(size int) *RollingAverage {
	return &RollingAverage{
		values: make([]float64, size),
		size:   size,
	}
}

// Add adds a value to the rolling average
func (ra *RollingAverage) Add(value float64) {
	ra.mu.Lock()
	defer ra.mu.Unlock()
	
	// Remove old value from sum
	if ra.filled {
		ra.sum -= ra.values[ra.index]
	}
	
	// Add new value
	ra.values[ra.index] = value
	ra.sum += value
	
	// Update index
	ra.index = (ra.index + 1) % ra.size
	if ra.index == 0 {
		ra.filled = true
	}
}

// Average returns the current average
func (ra *RollingAverage) Average() float64 {
	ra.mu.Lock()
	defer ra.mu.Unlock()
	
	count := ra.size
	if !ra.filled {
		count = ra.index
	}
	
	if count == 0 {
		return 0
	}
	
	return ra.sum / float64(count)
}

// GetStats returns revenue statistics
func (rt *RevenueTracker) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"total_revenue":      rt.stats.TotalRevenue.Load(),
		"total_power_cost":   rt.stats.TotalPowerCost.Load(),
		"total_pool_fees":    rt.stats.TotalPoolFees.Load(),
		"total_shares":       rt.stats.TotalShares.Load(),
		"hourly_revenue_avg": rt.stats.HourlyRevenue.Average(),
		"daily_revenue_avg":  rt.stats.DailyRevenue.Average(),
		"revenue_per_share":  rt.stats.RevenuePerShare.Average(),
		"power_efficiency":   rt.stats.PowerEfficiency.Average(),
	}
}