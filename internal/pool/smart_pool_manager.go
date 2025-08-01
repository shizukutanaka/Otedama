// Package pool provides intelligent pool management with auto-balancing
package pool

import (
	"context"
	"fmt"
	"math"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/mining"
	"go.uber.org/zap"
)

// SmartPoolManager provides intelligent pool management with auto-balancing
type SmartPoolManager struct {
	logger       *zap.Logger
	
	// Pool management
	pools        map[string]*MiningPool
	poolsMu      sync.RWMutex
	
	// Worker distribution
	workers      map[string]*PoolWorker
	workersMu    sync.RWMutex
	
	// Load balancing
	balancer     *LoadBalancer
	rebalanceInterval time.Duration
	
	// Pool health monitoring
	healthChecker *PoolHealthChecker
	failoverMgr   *FailoverManager
	
	// Statistics
	stats        *PoolStats
	
	// Configuration
	config       SmartPoolConfig
	
	// Lifecycle
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

// SmartPoolConfig configures the smart pool manager
type SmartPoolConfig struct {
	// Pool management
	MaxPools           int
	MinPoolWorkers     int
	MaxPoolWorkers     int
	
	// Load balancing
	RebalanceInterval  time.Duration
	LoadThreshold      float64
	
	// Health monitoring
	HealthCheckInterval time.Duration
	FailoverTimeout     time.Duration
	
	// Performance
	OptimizeForLatency  bool
	OptimizeForHashrate bool
}

// MiningPool represents a mining pool
type MiningPool struct {
	ID           string
	Name         string
	URL          string
	Region       string
	
	// Performance metrics
	Latency      atomic.Int64    // microseconds
	Hashrate     atomic.Uint64
	Efficiency   atomic.Uint64   // percentage * 100
	Uptime       atomic.Uint64   // seconds
	
	// Worker management
	Workers      sync.Map        // worker_id -> *PoolWorker
	WorkerCount  atomic.Int32
	
	// Pool state
	Status       atomic.Value    // PoolStatus
	LastCheck    time.Time
	Connected    atomic.Bool
	
	// Configuration
	Priority     int
	MaxWorkers   int
	Algorithm    string
}

// PoolWorker represents a worker in a pool
type PoolWorker struct {
	ID           string
	PoolID       string
	MinerID      string
	
	// Performance
	Hashrate     atomic.Uint64
	SharesAccepted atomic.Uint64
	SharesRejected atomic.Uint64
	
	// State
	Connected    atomic.Bool
	LastShare    time.Time
	StartTime    time.Time
}

// PoolStatus represents pool status
type PoolStatus int

const (
	PoolStatusActive PoolStatus = iota
	PoolStatusDegraded
	PoolStatusUnhealthy
	PoolStatusOffline
)

// LoadBalancer distributes workers across pools
type LoadBalancer struct {
	strategy     LoadBalanceStrategy
	weights      map[string]float64
	mu           sync.RWMutex
}

// LoadBalanceStrategy defines how to balance load
type LoadBalanceStrategy int

const (
	StrategyRoundRobin LoadBalanceStrategy = iota
	StrategyWeighted
	StrategyLatency
	StrategyHashrate
	StrategyEfficiency
	StrategyHybrid
)

// PoolHealthChecker monitors pool health
type PoolHealthChecker struct {
	checks       []HealthCheck
	thresholds   HealthThresholds
}

// HealthCheck defines a health check
type HealthCheck func(*MiningPool) (healthy bool, reason string)

// HealthThresholds defines health check thresholds
type HealthThresholds struct {
	MaxLatency       time.Duration
	MinEfficiency    float64
	MaxRejectRate    float64
	MinUptime        time.Duration
}

// FailoverManager handles pool failovers
type FailoverManager struct {
	primaryPools   []string
	backupPools    []string
	failoverState  map[string]time.Time
	mu             sync.RWMutex
}

// NewSmartPoolManager creates a new smart pool manager
func NewSmartPoolManager(config SmartPoolConfig, logger *zap.Logger) *SmartPoolManager {
	ctx, cancel := context.WithCancel(context.Background())
	
	spm := &SmartPoolManager{
		logger:       logger,
		pools:        make(map[string]*MiningPool),
		workers:      make(map[string]*PoolWorker),
		config:       config,
		stats:        &PoolStats{},
		ctx:          ctx,
		cancel:       cancel,
		rebalanceInterval: config.RebalanceInterval,
	}
	
	// Initialize components
	spm.balancer = &LoadBalancer{
		strategy: StrategyHybrid,
		weights:  make(map[string]float64),
	}
	
	spm.healthChecker = &PoolHealthChecker{
		checks: []HealthCheck{
			spm.checkLatency,
			spm.checkEfficiency,
			spm.checkRejectRate,
			spm.checkUptime,
		},
		thresholds: HealthThresholds{
			MaxLatency:    100 * time.Millisecond,
			MinEfficiency: 0.95,
			MaxRejectRate: 0.02,
			MinUptime:     1 * time.Hour,
		},
	}
	
	spm.failoverMgr = &FailoverManager{
		failoverState: make(map[string]time.Time),
	}
	
	return spm
}

// Start begins pool management
func (spm *SmartPoolManager) Start() error {
	spm.logger.Info("Starting smart pool manager")
	
	// Start health monitoring
	spm.wg.Add(1)
	go spm.healthMonitorLoop()
	
	// Start load balancing
	spm.wg.Add(1)
	go spm.loadBalanceLoop()
	
	// Start statistics collection
	spm.wg.Add(1)
	go spm.statsCollectionLoop()
	
	return nil
}

// Stop gracefully stops the pool manager
func (spm *SmartPoolManager) Stop() error {
	spm.logger.Info("Stopping smart pool manager")
	spm.cancel()
	spm.wg.Wait()
	return nil
}

// AddPool adds a new mining pool
func (spm *SmartPoolManager) AddPool(pool *MiningPool) error {
	spm.poolsMu.Lock()
	defer spm.poolsMu.Unlock()
	
	if _, exists := spm.pools[pool.ID]; exists {
		return fmt.Errorf("pool %s already exists", pool.ID)
	}
	
	if len(spm.pools) >= spm.config.MaxPools {
		return fmt.Errorf("maximum number of pools reached")
	}
	
	pool.Status.Store(PoolStatusActive)
	pool.LastCheck = time.Now()
	spm.pools[pool.ID] = pool
	
	// Initialize pool weight
	spm.balancer.mu.Lock()
	spm.balancer.weights[pool.ID] = 1.0
	spm.balancer.mu.Unlock()
	
	spm.logger.Info("Added pool", 
		zap.String("pool_id", pool.ID),
		zap.String("name", pool.Name))
	
	return nil
}

// RemovePool removes a mining pool
func (spm *SmartPoolManager) RemovePool(poolID string) error {
	spm.poolsMu.Lock()
	defer spm.poolsMu.Unlock()
	
	pool, exists := spm.pools[poolID]
	if !exists {
		return fmt.Errorf("pool %s not found", poolID)
	}
	
	// Migrate workers before removing
	if err := spm.migratePoolWorkers(pool); err != nil {
		return fmt.Errorf("failed to migrate workers: %w", err)
	}
	
	delete(spm.pools, poolID)
	
	// Remove pool weight
	spm.balancer.mu.Lock()
	delete(spm.balancer.weights, poolID)
	spm.balancer.mu.Unlock()
	
	return nil
}

// AssignWorker assigns a worker to the best pool
func (spm *SmartPoolManager) AssignWorker(workerID string, minerID string) (*MiningPool, error) {
	// Select best pool based on current strategy
	pool := spm.selectBestPool()
	if pool == nil {
		return nil, fmt.Errorf("no available pools")
	}
	
	// Create worker
	worker := &PoolWorker{
		ID:        workerID,
		PoolID:    pool.ID,
		MinerID:   minerID,
		StartTime: time.Now(),
	}
	worker.Connected.Store(true)
	
	// Add to pool
	pool.Workers.Store(workerID, worker)
	pool.WorkerCount.Add(1)
	
	// Add to manager
	spm.workersMu.Lock()
	spm.workers[workerID] = worker
	spm.workersMu.Unlock()
	
	spm.logger.Info("Assigned worker to pool",
		zap.String("worker_id", workerID),
		zap.String("pool_id", pool.ID))
	
	return pool, nil
}

// selectBestPool selects the best pool based on current strategy
func (spm *SmartPoolManager) selectBestPool() *MiningPool {
	spm.poolsMu.RLock()
	defer spm.poolsMu.RUnlock()
	
	if len(spm.pools) == 0 {
		return nil
	}
	
	// Get active pools
	var activePools []*MiningPool
	for _, pool := range spm.pools {
		if pool.Status.Load().(PoolStatus) == PoolStatusActive &&
		   pool.WorkerCount.Load() < int32(pool.MaxWorkers) {
			activePools = append(activePools, pool)
		}
	}
	
	if len(activePools) == 0 {
		return nil
	}
	
	// Select based on strategy
	switch spm.balancer.strategy {
	case StrategyRoundRobin:
		return spm.selectRoundRobin(activePools)
	case StrategyLatency:
		return spm.selectByLatency(activePools)
	case StrategyHashrate:
		return spm.selectByHashrate(activePools)
	case StrategyEfficiency:
		return spm.selectByEfficiency(activePools)
	case StrategyHybrid:
		return spm.selectHybrid(activePools)
	default:
		return activePools[0]
	}
}

// selectHybrid uses multiple factors to select the best pool
func (spm *SmartPoolManager) selectHybrid(pools []*MiningPool) *MiningPool {
	type poolScore struct {
		pool  *MiningPool
		score float64
	}
	
	scores := make([]poolScore, 0, len(pools))
	
	for _, pool := range pools {
		// Calculate composite score
		latencyScore := 1.0 / (1.0 + float64(pool.Latency.Load())/1000000.0)
		efficiencyScore := float64(pool.Efficiency.Load()) / 10000.0
		loadScore := 1.0 - (float64(pool.WorkerCount.Load()) / float64(pool.MaxWorkers))
		
		// Weight the scores
		totalScore := latencyScore*0.3 + efficiencyScore*0.4 + loadScore*0.3
		
		// Apply pool weight
		spm.balancer.mu.RLock()
		weight := spm.balancer.weights[pool.ID]
		spm.balancer.mu.RUnlock()
		
		totalScore *= weight
		
		scores = append(scores, poolScore{pool, totalScore})
	}
	
	// Sort by score
	sort.Slice(scores, func(i, j int) bool {
		return scores[i].score > scores[j].score
	})
	
	if len(scores) > 0 {
		return scores[0].pool
	}
	
	return nil
}

// healthMonitorLoop monitors pool health
func (spm *SmartPoolManager) healthMonitorLoop() {
	defer spm.wg.Done()
	
	ticker := time.NewTicker(spm.config.HealthCheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-spm.ctx.Done():
			return
		case <-ticker.C:
			spm.checkPoolHealth()
		}
	}
}

// checkPoolHealth checks health of all pools
func (spm *SmartPoolManager) checkPoolHealth() {
	spm.poolsMu.RLock()
	pools := make([]*MiningPool, 0, len(spm.pools))
	for _, pool := range spm.pools {
		pools = append(pools, pool)
	}
	spm.poolsMu.RUnlock()
	
	for _, pool := range pools {
		healthy := true
		var reasons []string
		
		// Run health checks
		for _, check := range spm.healthChecker.checks {
			if ok, reason := check(pool); !ok {
				healthy = false
				reasons = append(reasons, reason)
			}
		}
		
		// Update pool status
		oldStatus := pool.Status.Load().(PoolStatus)
		newStatus := PoolStatusActive
		
		if !healthy {
			if len(reasons) >= 2 {
				newStatus = PoolStatusUnhealthy
			} else {
				newStatus = PoolStatusDegraded
			}
		}
		
		if oldStatus != newStatus {
			pool.Status.Store(newStatus)
			spm.logger.Warn("Pool status changed",
				zap.String("pool_id", pool.ID),
				zap.String("old_status", statusString(oldStatus)),
				zap.String("new_status", statusString(newStatus)),
				zap.Strings("reasons", reasons))
			
			// Trigger failover if needed
			if newStatus == PoolStatusUnhealthy {
				go spm.handlePoolFailure(pool)
			}
		}
		
		pool.LastCheck = time.Now()
	}
}

// loadBalanceLoop performs periodic load balancing
func (spm *SmartPoolManager) loadBalanceLoop() {
	defer spm.wg.Done()
	
	ticker := time.NewTicker(spm.rebalanceInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-spm.ctx.Done():
			return
		case <-ticker.C:
			if err := spm.rebalanceWorkers(); err != nil {
				spm.logger.Error("Failed to rebalance workers", zap.Error(err))
			}
		}
	}
}

// rebalanceWorkers redistributes workers for optimal performance
func (spm *SmartPoolManager) rebalanceWorkers() error {
	spm.poolsMu.RLock()
	pools := make([]*MiningPool, 0, len(spm.pools))
	for _, pool := range spm.pools {
		if pool.Status.Load().(PoolStatus) == PoolStatusActive {
			pools = append(pools, pool)
		}
	}
	spm.poolsMu.RUnlock()
	
	if len(pools) < 2 {
		return nil // Nothing to balance
	}
	
	// Calculate average load
	totalWorkers := 0
	for _, pool := range pools {
		totalWorkers += int(pool.WorkerCount.Load())
	}
	avgWorkers := totalWorkers / len(pools)
	
	// Find overloaded and underloaded pools
	var overloaded, underloaded []*MiningPool
	for _, pool := range pools {
		workerCount := int(pool.WorkerCount.Load())
		if workerCount > avgWorkers+spm.config.MinPoolWorkers {
			overloaded = append(overloaded, pool)
		} else if workerCount < avgWorkers-spm.config.MinPoolWorkers {
			underloaded = append(underloaded, pool)
		}
	}
	
	// Rebalance workers
	for _, fromPool := range overloaded {
		for _, toPool := range underloaded {
			// Move workers until balanced
			moveCount := min(
				int(fromPool.WorkerCount.Load())-avgWorkers,
				avgWorkers-int(toPool.WorkerCount.Load()),
			)
			
			if moveCount > 0 {
				if err := spm.moveWorkers(fromPool, toPool, moveCount); err != nil {
					spm.logger.Error("Failed to move workers",
						zap.String("from", fromPool.ID),
						zap.String("to", toPool.ID),
						zap.Error(err))
				}
			}
		}
	}
	
	return nil
}

// Health check functions
func (spm *SmartPoolManager) checkLatency(pool *MiningPool) (bool, string) {
	latency := time.Duration(pool.Latency.Load()) * time.Microsecond
	if latency > spm.healthChecker.thresholds.MaxLatency {
		return false, fmt.Sprintf("high latency: %v", latency)
	}
	return true, ""
}

func (spm *SmartPoolManager) checkEfficiency(pool *MiningPool) (bool, string) {
	efficiency := float64(pool.Efficiency.Load()) / 100.0
	if efficiency < spm.healthChecker.thresholds.MinEfficiency {
		return false, fmt.Sprintf("low efficiency: %.2f%%", efficiency*100)
	}
	return true, ""
}

func (spm *SmartPoolManager) checkRejectRate(pool *MiningPool) (bool, string) {
	var totalShares, rejectedShares uint64
	pool.Workers.Range(func(key, value interface{}) bool {
		worker := value.(*PoolWorker)
		totalShares += worker.SharesAccepted.Load() + worker.SharesRejected.Load()
		rejectedShares += worker.SharesRejected.Load()
		return true
	})
	
	if totalShares > 0 {
		rejectRate := float64(rejectedShares) / float64(totalShares)
		if rejectRate > spm.healthChecker.thresholds.MaxRejectRate {
			return false, fmt.Sprintf("high reject rate: %.2f%%", rejectRate*100)
		}
	}
	return true, ""
}

func (spm *SmartPoolManager) checkUptime(pool *MiningPool) (bool, string) {
	uptime := time.Duration(pool.Uptime.Load()) * time.Second
	if uptime < spm.healthChecker.thresholds.MinUptime {
		return false, fmt.Sprintf("low uptime: %v", uptime)
	}
	return true, ""
}

// Helper functions
func statusString(status PoolStatus) string {
	switch status {
	case PoolStatusActive:
		return "active"
	case PoolStatusDegraded:
		return "degraded"
	case PoolStatusUnhealthy:
		return "unhealthy"
	case PoolStatusOffline:
		return "offline"
	default:
		return "unknown"
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// Placeholder implementations for remaining selection strategies
func (spm *SmartPoolManager) selectRoundRobin(pools []*MiningPool) *MiningPool {
	// Simple round-robin selection
	return pools[0]
}

func (spm *SmartPoolManager) selectByLatency(pools []*MiningPool) *MiningPool {
	// Select pool with lowest latency
	sort.Slice(pools, func(i, j int) bool {
		return pools[i].Latency.Load() < pools[j].Latency.Load()
	})
	return pools[0]
}

func (spm *SmartPoolManager) selectByHashrate(pools []*MiningPool) *MiningPool {
	// Select pool with highest hashrate capacity
	sort.Slice(pools, func(i, j int) bool {
		return pools[i].Hashrate.Load() > pools[j].Hashrate.Load()
	})
	return pools[0]
}

func (spm *SmartPoolManager) selectByEfficiency(pools []*MiningPool) *MiningPool {
	// Select pool with highest efficiency
	sort.Slice(pools, func(i, j int) bool {
		return pools[i].Efficiency.Load() > pools[j].Efficiency.Load()
	})
	return pools[0]
}

// Placeholder implementations
func (spm *SmartPoolManager) migratePoolWorkers(pool *MiningPool) error {
	// TODO: Implement worker migration
	return nil
}

func (spm *SmartPoolManager) handlePoolFailure(pool *MiningPool) {
	// TODO: Implement pool failure handling
}

func (spm *SmartPoolManager) moveWorkers(from, to *MiningPool, count int) error {
	// TODO: Implement worker movement
	return nil
}

func (spm *SmartPoolManager) statsCollectionLoop() {
	// TODO: Implement statistics collection
	spm.wg.Done()
}