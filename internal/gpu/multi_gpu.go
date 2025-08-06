package gpu

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// MultiGPUManager manages multiple GPU devices for mining
type MultiGPUManager struct {
	logger      *zap.Logger
	
	// GPU devices
	devices     []*GPUDevice
	miners      map[int]*GPUMiner
	minersMu    sync.RWMutex
	
	// Load balancing
	balancer    *LoadBalancer
	
	// Work distribution
	workQueue   chan *MiningWork
	
	// Statistics
	stats       *MultiGPUStats
	
	// Control
	running     atomic.Bool
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
}

// LoadBalancer distributes work across GPUs
type LoadBalancer struct {
	strategy    BalancingStrategy
	
	// Device metrics
	metrics     map[int]*DeviceMetrics
	metricsMu   sync.RWMutex
	
	// Load history
	history     *LoadHistory
}

// BalancingStrategy defines how work is distributed
type BalancingStrategy int

const (
	StrategyRoundRobin BalancingStrategy = iota
	StrategyPerformanceBased
	StrategyTemperatureBased
	StrategyPowerEfficiency
	StrategyAdaptive
)

// DeviceMetrics tracks GPU performance metrics
type DeviceMetrics struct {
	DeviceID         int
	HashRate         atomic.Uint64
	Temperature      atomic.Int32
	PowerDraw        atomic.Int32
	Efficiency       atomic.Uint64 // Hashes per watt
	SharesSubmitted  atomic.Uint64
	SharesAccepted   atomic.Uint64
	LastUpdate       atomic.Int64
	WorkAssigned     atomic.Uint64
	ResponseTime     atomic.Int64 // Microseconds
}

// LoadHistory tracks historical load data
type LoadHistory struct {
	windowSize   int
	history      []LoadSnapshot
	historyMu    sync.RWMutex
	currentIndex int
}

// LoadSnapshot represents load at a point in time
type LoadSnapshot struct {
	Timestamp    time.Time
	DeviceLoads  map[int]float64
	TotalHashRate uint64
}

// MultiGPUStats aggregates statistics across all GPUs
type MultiGPUStats struct {
	TotalHashRate    atomic.Uint64
	TotalPower       atomic.Uint64
	TotalShares      atomic.Uint64
	AcceptedShares   atomic.Uint64
	RejectedShares   atomic.Uint64
	DeviceStats      sync.Map // map[int]*DeviceStats
}

// DeviceStats contains per-device statistics
type DeviceStats struct {
	Uptime           time.Duration
	TotalWork        uint64
	AverageHashRate  uint64
	PeakHashRate     uint64
	MinTemperature   int32
	MaxTemperature   int32
	TotalPowerUsed   uint64 // Watt-hours
}

// NewMultiGPUManager creates a new multi-GPU manager
func NewMultiGPUManager(logger *zap.Logger, devices []*GPUDevice) (*MultiGPUManager, error) {
	if len(devices) == 0 {
		return nil, errors.New("no GPU devices provided")
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	mgr := &MultiGPUManager{
		logger:    logger,
		devices:   devices,
		miners:    make(map[int]*GPUMiner),
		workQueue: make(chan *MiningWork, len(devices)*2),
		stats:     &MultiGPUStats{},
		ctx:       ctx,
		cancel:    cancel,
	}
	
	// Initialize load balancer
	mgr.balancer = NewLoadBalancer(StrategyAdaptive, len(devices))
	
	// Initialize miners for each device
	for _, device := range devices {
		config := &GPUConfig{
			DeviceIDs:  []int{device.ID},
			Intensity:  20,
			WorkSize:   256,
			TempTarget: 75,
			TempLimit:  85,
		}
		
		miner, err := NewGPUMiner(logger, config)
		if err != nil {
			logger.Warn("Failed to create miner for device",
				zap.Int("device_id", device.ID),
				zap.Error(err),
			)
			continue
		}
		
		mgr.miners[device.ID] = miner
	}
	
	if len(mgr.miners) == 0 {
		cancel()
		return nil, errors.New("failed to initialize any GPU miners")
	}
	
	logger.Info("Initialized multi-GPU manager",
		zap.Int("total_devices", len(devices)),
		zap.Int("active_miners", len(mgr.miners)),
	)
	
	return mgr, nil
}

// Start starts mining on all GPUs
func (m *MultiGPUManager) Start() error {
	if m.running.Load() {
		return errors.New("already running")
	}
	
	m.running.Store(true)
	
	// Start all miners
	for id, miner := range m.miners {
		if err := miner.Start(); err != nil {
			m.logger.Error("Failed to start miner",
				zap.Int("device_id", id),
				zap.Error(err),
			)
		}
	}
	
	// Start work distributor
	m.wg.Add(1)
	go m.workDistributor()
	
	// Start load monitor
	m.wg.Add(1)
	go m.loadMonitor()
	
	// Start statistics aggregator
	m.wg.Add(1)
	go m.statsAggregator()
	
	m.logger.Info("Started multi-GPU mining")
	return nil
}

// Stop stops mining on all GPUs
func (m *MultiGPUManager) Stop() error {
	if !m.running.Load() {
		return errors.New("not running")
	}
	
	m.logger.Info("Stopping multi-GPU mining")
	m.running.Store(false)
	m.cancel()
	
	// Stop all miners
	for id, miner := range m.miners {
		if err := miner.Stop(); err != nil {
			m.logger.Error("Failed to stop miner",
				zap.Int("device_id", id),
				zap.Error(err),
			)
		}
	}
	
	// Wait for goroutines
	m.wg.Wait()
	
	return nil
}

// SetWork distributes new work to all GPUs
func (m *MultiGPUManager) SetWork(work *MiningWork) {
	select {
	case m.workQueue <- work:
		m.logger.Debug("Queued new work",
			zap.String("job_id", work.JobID),
		)
	default:
		m.logger.Warn("Work queue full, dropping work")
	}
}

// GetStats returns aggregated statistics
func (m *MultiGPUManager) GetStats() MultiGPUStats {
	return *m.stats
}

// GetDeviceStats returns statistics for a specific device
func (m *MultiGPUManager) GetDeviceStats(deviceID int) (*DeviceStats, error) {
	value, ok := m.stats.DeviceStats.Load(deviceID)
	if !ok {
		return nil, fmt.Errorf("device %d not found", deviceID)
	}
	return value.(*DeviceStats), nil
}

// SetBalancingStrategy changes the load balancing strategy
func (m *MultiGPUManager) SetBalancingStrategy(strategy BalancingStrategy) {
	m.balancer.strategy = strategy
	m.logger.Info("Changed balancing strategy",
		zap.String("strategy", strategy.String()),
	)
}

// workDistributor distributes work to GPUs based on load balancing
func (m *MultiGPUManager) workDistributor() {
	defer m.wg.Done()
	
	for {
		select {
		case <-m.ctx.Done():
			return
		case work := <-m.workQueue:
			m.distributeWork(work)
		}
	}
}

// distributeWork assigns work to GPUs
func (m *MultiGPUManager) distributeWork(work *MiningWork) {
	// Get device assignment from load balancer
	deviceIDs := m.balancer.AssignWork(work)
	
	m.minersMu.RLock()
	defer m.minersMu.RUnlock()
	
	for _, deviceID := range deviceIDs {
		miner, exists := m.miners[deviceID]
		if !exists {
			continue
		}
		
		// Create device-specific work
		deviceWork := m.createDeviceWork(work, deviceID)
		miner.SetWork(deviceWork)
		
		// Update metrics
		if metrics := m.balancer.getMetrics(deviceID); metrics != nil {
			metrics.WorkAssigned.Add(1)
		}
	}
}

// createDeviceWork creates work specific to a device
func (m *MultiGPUManager) createDeviceWork(baseWork *MiningWork, deviceID int) *MiningWork {
	// Clone work
	work := *baseWork
	
	// Adjust nonce range for device
	// This ensures each GPU works on different nonces
	nonceOffset := uint32(deviceID) << 24 // Device-specific offset
	work.ExtraNonce2 = append([]byte{byte(deviceID)}, work.ExtraNonce2...)
	
	return &work
}

// loadMonitor monitors GPU load and updates metrics
func (m *MultiGPUManager) loadMonitor() {
	defer m.wg.Done()
	
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.updateLoadMetrics()
		}
	}
}

// updateLoadMetrics updates load metrics for all devices
func (m *MultiGPUManager) updateLoadMetrics() {
	m.minersMu.RLock()
	miners := make(map[int]*GPUMiner)
	for id, miner := range m.miners {
		miners[id] = miner
	}
	m.minersMu.RUnlock()
	
	snapshot := LoadSnapshot{
		Timestamp:    time.Now(),
		DeviceLoads:  make(map[int]float64),
		TotalHashRate: 0,
	}
	
	for deviceID, miner := range miners {
		// Get device metrics
		devices := miner.GetDevices()
		if len(devices) == 0 {
			continue
		}
		
		device := devices[0]
		hashRate := device.HashRate.Load()
		
		// Update balancer metrics
		if metrics := m.balancer.getMetrics(deviceID); metrics != nil {
			metrics.HashRate.Store(hashRate)
			metrics.Temperature.Store(device.Temperature.Load())
			metrics.PowerDraw.Store(device.PowerDraw.Load())
			
			// Calculate efficiency
			power := device.PowerDraw.Load()
			if power > 0 {
				efficiency := hashRate / uint64(power)
				metrics.Efficiency.Store(efficiency)
			}
			
			metrics.LastUpdate.Store(time.Now().Unix())
		}
		
		// Calculate load (0-1)
		maxHashRate := m.calculateMaxHashRate(device)
		load := float64(hashRate) / float64(maxHashRate)
		snapshot.DeviceLoads[deviceID] = load
		snapshot.TotalHashRate += hashRate
	}
	
	// Update load history
	m.balancer.history.addSnapshot(snapshot)
}

// calculateMaxHashRate estimates maximum hash rate for device
func (m *MultiGPUManager) calculateMaxHashRate(device *GPUDevice) uint64 {
	// Rough estimation based on GPU model
	// In practice, this would be calibrated
	
	switch device.Vendor {
	case VendorNVIDIA:
		// Estimate based on compute units and clock
		return uint64(device.ComputeUnits) * uint64(device.MaxClock) * 1000
	case VendorAMD:
		// AMD typically has more compute units but lower per-unit performance
		return uint64(device.ComputeUnits) * uint64(device.MaxClock) * 800
	default:
		return 100_000_000 // 100 MH/s default
	}
}

// statsAggregator aggregates statistics from all devices
func (m *MultiGPUManager) statsAggregator() {
	defer m.wg.Done()
	
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.aggregateStats()
		}
	}
}

// aggregateStats aggregates statistics from all miners
func (m *MultiGPUManager) aggregateStats() {
	var totalHashRate uint64
	var totalPower uint64
	
	m.minersMu.RLock()
	for _, miner := range m.miners {
		minerStats := miner.GetStats()
		totalHashRate += miner.GetHashRate()
		
		// Get power from devices
		for _, device := range miner.GetDevices() {
			totalPower += uint64(device.PowerDraw.Load())
		}
		
		// Update share stats
		m.stats.TotalShares.Add(minerStats.ValidShares.Load())
		m.stats.AcceptedShares.Add(minerStats.ValidShares.Load())
		m.stats.RejectedShares.Add(minerStats.InvalidShares.Load())
	}
	m.minersMu.RUnlock()
	
	m.stats.TotalHashRate.Store(totalHashRate)
	m.stats.TotalPower.Store(totalPower)
	
	m.logger.Debug("Aggregated multi-GPU stats",
		zap.Uint64("total_hashrate", totalHashRate),
		zap.Uint64("total_power", totalPower),
		zap.Uint64("total_shares", m.stats.TotalShares.Load()),
	)
}

// Load Balancer implementation

// NewLoadBalancer creates a new load balancer
func NewLoadBalancer(strategy BalancingStrategy, deviceCount int) *LoadBalancer {
	lb := &LoadBalancer{
		strategy: strategy,
		metrics:  make(map[int]*DeviceMetrics),
		history: &LoadHistory{
			windowSize: 60, // 1 minute of history
			history:    make([]LoadSnapshot, 60),
		},
	}
	
	// Initialize metrics for each device
	for i := 0; i < deviceCount; i++ {
		lb.metrics[i] = &DeviceMetrics{DeviceID: i}
	}
	
	return lb
}

// AssignWork assigns work to devices based on strategy
func (lb *LoadBalancer) AssignWork(work *MiningWork) []int {
	lb.metricsMu.RLock()
	defer lb.metricsMu.RUnlock()
	
	switch lb.strategy {
	case StrategyRoundRobin:
		return lb.assignRoundRobin()
	case StrategyPerformanceBased:
		return lb.assignPerformanceBased()
	case StrategyTemperatureBased:
		return lb.assignTemperatureBased()
	case StrategyPowerEfficiency:
		return lb.assignPowerEfficiency()
	case StrategyAdaptive:
		return lb.assignAdaptive()
	default:
		return lb.assignRoundRobin()
	}
}

// assignRoundRobin assigns work in round-robin fashion
func (lb *LoadBalancer) assignRoundRobin() []int {
	devices := make([]int, 0, len(lb.metrics))
	for id := range lb.metrics {
		devices = append(devices, id)
	}
	return devices
}

// assignPerformanceBased assigns work based on hash rate
func (lb *LoadBalancer) assignPerformanceBased() []int {
	type devicePerf struct {
		id       int
		hashRate uint64
	}
	
	perfs := make([]devicePerf, 0, len(lb.metrics))
	for id, metrics := range lb.metrics {
		perfs = append(perfs, devicePerf{
			id:       id,
			hashRate: metrics.HashRate.Load(),
		})
	}
	
	// Sort by hash rate (descending)
	for i := 0; i < len(perfs)-1; i++ {
		for j := i + 1; j < len(perfs); j++ {
			if perfs[j].hashRate > perfs[i].hashRate {
				perfs[i], perfs[j] = perfs[j], perfs[i]
			}
		}
	}
	
	// Return top performers
	result := make([]int, 0)
	for i := 0; i < len(perfs) && i < 3; i++ { // Top 3
		result = append(result, perfs[i].id)
	}
	
	return result
}

// assignTemperatureBased assigns work to coolest devices
func (lb *LoadBalancer) assignTemperatureBased() []int {
	type deviceTemp struct {
		id   int
		temp int32
	}
	
	temps := make([]deviceTemp, 0, len(lb.metrics))
	for id, metrics := range lb.metrics {
		temp := metrics.Temperature.Load()
		if temp > 0 { // Only consider devices with temperature data
			temps = append(temps, deviceTemp{
				id:   id,
				temp: temp,
			})
		}
	}
	
	// Sort by temperature (ascending)
	for i := 0; i < len(temps)-1; i++ {
		for j := i + 1; j < len(temps); j++ {
			if temps[j].temp < temps[i].temp {
				temps[i], temps[j] = temps[j], temps[i]
			}
		}
	}
	
	// Return coolest devices
	result := make([]int, 0)
	for i := 0; i < len(temps) && temps[i].temp < 80; i++ {
		result = append(result, temps[i].id)
	}
	
	// Fallback to all if none are cool enough
	if len(result) == 0 {
		return lb.assignRoundRobin()
	}
	
	return result
}

// assignPowerEfficiency assigns work to most efficient devices
func (lb *LoadBalancer) assignPowerEfficiency() []int {
	type deviceEff struct {
		id         int
		efficiency uint64
	}
	
	effs := make([]deviceEff, 0, len(lb.metrics))
	for id, metrics := range lb.metrics {
		eff := metrics.Efficiency.Load()
		if eff > 0 {
			effs = append(effs, deviceEff{
				id:         id,
				efficiency: eff,
			})
		}
	}
	
	// Sort by efficiency (descending)
	for i := 0; i < len(effs)-1; i++ {
		for j := i + 1; j < len(effs); j++ {
			if effs[j].efficiency > effs[i].efficiency {
				effs[i], effs[j] = effs[j], effs[i]
			}
		}
	}
	
	// Return most efficient devices
	result := make([]int, 0)
	for i := 0; i < len(effs) && i < len(effs)/2+1; i++ {
		result = append(result, effs[i].id)
	}
	
	return result
}

// assignAdaptive uses multiple factors to assign work
func (lb *LoadBalancer) assignAdaptive() []int {
	scores := make(map[int]float64)
	
	for id, metrics := range lb.metrics {
		score := 0.0
		
		// Hash rate factor (40%)
		hashRate := float64(metrics.HashRate.Load())
		maxHashRate := 1000000000.0 // 1 GH/s normalized
		score += (hashRate / maxHashRate) * 0.4
		
		// Temperature factor (30%) - lower is better
		temp := float64(metrics.Temperature.Load())
		if temp > 0 {
			tempScore := (100.0 - temp) / 100.0
			score += tempScore * 0.3
		}
		
		// Efficiency factor (20%)
		efficiency := float64(metrics.Efficiency.Load())
		maxEfficiency := 1000000.0 // 1 MH/W normalized
		score += (efficiency / maxEfficiency) * 0.2
		
		// Response time factor (10%) - lower is better
		responseTime := float64(metrics.ResponseTime.Load())
		if responseTime > 0 {
			responseScore := 1.0 / (1.0 + responseTime/1000000.0) // Convert to seconds
			score += responseScore * 0.1
		}
		
		scores[id] = score
	}
	
	// Sort by score
	type deviceScore struct {
		id    int
		score float64
	}
	
	scoreList := make([]deviceScore, 0, len(scores))
	for id, score := range scores {
		scoreList = append(scoreList, deviceScore{id: id, score: score})
	}
	
	for i := 0; i < len(scoreList)-1; i++ {
		for j := i + 1; j < len(scoreList); j++ {
			if scoreList[j].score > scoreList[i].score {
				scoreList[i], scoreList[j] = scoreList[j], scoreList[i]
			}
		}
	}
	
	// Return devices with score > 0.5
	result := make([]int, 0)
	for _, ds := range scoreList {
		if ds.score > 0.5 {
			result = append(result, ds.id)
		}
	}
	
	// Ensure at least one device
	if len(result) == 0 && len(scoreList) > 0 {
		result = append(result, scoreList[0].id)
	}
	
	return result
}

// getMetrics returns metrics for a device
func (lb *LoadBalancer) getMetrics(deviceID int) *DeviceMetrics {
	lb.metricsMu.RLock()
	defer lb.metricsMu.RUnlock()
	return lb.metrics[deviceID]
}

// Load history methods

// addSnapshot adds a load snapshot to history
func (lh *LoadHistory) addSnapshot(snapshot LoadSnapshot) {
	lh.historyMu.Lock()
	defer lh.historyMu.Unlock()
	
	lh.history[lh.currentIndex] = snapshot
	lh.currentIndex = (lh.currentIndex + 1) % lh.windowSize
}

// getAverageLoad returns average load over the history window
func (lh *LoadHistory) getAverageLoad(deviceID int) float64 {
	lh.historyMu.RLock()
	defer lh.historyMu.RUnlock()
	
	sum := 0.0
	count := 0
	
	for _, snapshot := range lh.history {
		if load, exists := snapshot.DeviceLoads[deviceID]; exists {
			sum += load
			count++
		}
	}
	
	if count == 0 {
		return 0
	}
	
	return sum / float64(count)
}

// String methods for enums

func (s BalancingStrategy) String() string {
	switch s {
	case StrategyRoundRobin:
		return "round_robin"
	case StrategyPerformanceBased:
		return "performance_based"
	case StrategyTemperatureBased:
		return "temperature_based"
	case StrategyPowerEfficiency:
		return "power_efficiency"
	case StrategyAdaptive:
		return "adaptive"
	default:
		return "unknown"
	}
}