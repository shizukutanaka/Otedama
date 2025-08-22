package failover

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"sync"
	"sync/atomic"
	"time"
)

// AutomaticFailover provides automatic failover between pools
type AutomaticFailover struct {
	ctx    context.Context
	cancel context.CancelFunc
	
	// Pool management
	pools         []*PoolEndpoint
	poolsMu       sync.RWMutex
	currentPool   atomic.Value // *PoolEndpoint
	
	// Health checking
	healthChecker *HealthChecker
	
	// Failover configuration
	config *FailoverConfig
	
	// Statistics
	failoverCount  atomic.Uint64
	recoveryCount  atomic.Uint64
	totalDowntime  atomic.Int64
	lastFailover   atomic.Value // time.Time
	
	// State
	isFailingOver atomic.Bool
}

// FailoverConfig holds failover configuration
type FailoverConfig struct {
	HealthCheckInterval   time.Duration
	FailureThreshold      int
	RecoveryThreshold     int
	FailoverTimeout       time.Duration
	RetryDelay           time.Duration
	MaxRetries           int
	PreferredPoolStrategy string // "priority", "latency", "hashrate"
}

// PoolEndpoint represents a mining pool endpoint
type PoolEndpoint struct {
	URL          string
	Priority     int
	Region       string
	
	// Connection info
	conn         interface{}
	connMu       sync.RWMutex
	
	// Health status
	healthy      atomic.Bool
	failures     atomic.Int32
	successes    atomic.Int32
	lastCheck    atomic.Value // time.Time
	latency      atomic.Int64 // microseconds
	
	// Statistics
	sharesSubmitted atomic.Uint64
	sharesAccepted  atomic.Uint64
	blocksFound     atomic.Uint64
	connectedTime   time.Duration
}

// HealthChecker checks pool health
type HealthChecker struct {
	checkFunc HealthCheckFunc
	timeout   time.Duration
}

// HealthCheckFunc checks if a pool is healthy
type HealthCheckFunc func(ctx context.Context, pool *PoolEndpoint) error

// FailoverEvent represents a failover event
type FailoverEvent struct {
	Timestamp   time.Time
	FromPool    string
	ToPool      string
	Reason      string
	Duration    time.Duration
	Success     bool
}

// DefaultFailoverConfig returns default configuration
func DefaultFailoverConfig() *FailoverConfig {
	return &FailoverConfig{
		HealthCheckInterval:   10 * time.Second,
		FailureThreshold:      3,
		RecoveryThreshold:     2,
		FailoverTimeout:       30 * time.Second,
		RetryDelay:           5 * time.Second,
		MaxRetries:           3,
		PreferredPoolStrategy: "priority",
	}
}

// NewAutomaticFailover creates a new automatic failover manager
func NewAutomaticFailover(ctx context.Context, config *FailoverConfig) *AutomaticFailover {
	if config == nil {
		config = DefaultFailoverConfig()
	}
	
	ctx, cancel := context.WithCancel(ctx)
	
	af := &AutomaticFailover{
		ctx:    ctx,
		cancel: cancel,
		config: config,
		pools:  make([]*PoolEndpoint, 0),
		healthChecker: &HealthChecker{
			timeout: 5 * time.Second,
		},
	}
	
	// Set default health check function
	af.healthChecker.checkFunc = af.defaultHealthCheck
	
	// Start health monitoring
	go af.healthMonitor()
	
	return af
}

// AddPool adds a pool endpoint
func (af *AutomaticFailover) AddPool(urlStr string, priority int) error {
	// Validate URL
	u, err := url.Parse(urlStr)
	if err != nil {
		return fmt.Errorf("invalid pool URL: %w", err)
	}
	
	pool := &PoolEndpoint{
		URL:      urlStr,
		Priority: priority,
		Region:   detectRegion(u.Host),
	}
	
	pool.healthy.Store(true)
	pool.lastCheck.Store(time.Now())
	
	af.poolsMu.Lock()
	af.pools = append(af.pools, pool)
	
	// Sort pools by priority
	af.sortPools()
	af.poolsMu.Unlock()
	
	// Set as current if first pool
	if af.currentPool.Load() == nil {
		af.currentPool.Store(pool)
	}
	
	return nil
}

// GetCurrentPool returns the current active pool
func (af *AutomaticFailover) GetCurrentPool() *PoolEndpoint {
	if pool := af.currentPool.Load(); pool != nil {
		return pool.(*PoolEndpoint)
	}
	return nil
}

// TriggerFailover manually triggers failover
func (af *AutomaticFailover) TriggerFailover(reason string) error {
	current := af.GetCurrentPool()
	if current == nil {
		return errors.New("no current pool")
	}
	
	return af.performFailover(current, reason)
}

// performFailover performs failover to next available pool
func (af *AutomaticFailover) performFailover(fromPool *PoolEndpoint, reason string) error {
	// Check if already failing over
	if !af.isFailingOver.CompareAndSwap(false, true) {
		return errors.New("failover already in progress")
	}
	defer af.isFailingOver.Store(false)
	
	startTime := time.Now()
	fmt.Printf("Starting failover from %s: %s\n", fromPool.URL, reason)
	
	// Find next healthy pool
	nextPool := af.findNextHealthyPool(fromPool)
	if nextPool == nil {
		return errors.New("no healthy pools available")
	}
	
	// Create failover context with timeout
	ctx, cancel := context.WithTimeout(af.ctx, af.config.FailoverTimeout)
	defer cancel()
	
	// Perform failover
	if err := af.switchToPool(ctx, nextPool); err != nil {
		af.recordFailoverEvent(FailoverEvent{
			Timestamp: startTime,
			FromPool:  fromPool.URL,
			ToPool:    nextPool.URL,
			Reason:    reason,
			Duration:  time.Since(startTime),
			Success:   false,
		})
		return err
	}
	
	// Update statistics
	af.failoverCount.Add(1)
	af.lastFailover.Store(time.Now())
	af.totalDowntime.Add(int64(time.Since(startTime)))
	
	// Record event
	af.recordFailoverEvent(FailoverEvent{
		Timestamp: startTime,
		FromPool:  fromPool.URL,
		ToPool:    nextPool.URL,
		Reason:    reason,
		Duration:  time.Since(startTime),
		Success:   true,
	})
	
	fmt.Printf("Failover completed to %s (took %v)\n", nextPool.URL, time.Since(startTime))
	
	return nil
}

// findNextHealthyPool finds the next healthy pool
func (af *AutomaticFailover) findNextHealthyPool(excludePool *PoolEndpoint) *PoolEndpoint {
	af.poolsMu.RLock()
	defer af.poolsMu.RUnlock()
	
	switch af.config.PreferredPoolStrategy {
	case "latency":
		return af.findLowestLatencyPool(excludePool)
	case "hashrate":
		return af.findBestHashratePool(excludePool)
	default: // priority
		return af.findByPriority(excludePool)
	}
}

// findByPriority finds pool by priority
func (af *AutomaticFailover) findByPriority(excludePool *PoolEndpoint) *PoolEndpoint {
	for _, pool := range af.pools {
		if pool != excludePool && pool.healthy.Load() {
			return pool
		}
	}
	return nil
}

// findLowestLatencyPool finds pool with lowest latency
func (af *AutomaticFailover) findLowestLatencyPool(excludePool *PoolEndpoint) *PoolEndpoint {
	var bestPool *PoolEndpoint
	var lowestLatency int64 = -1
	
	for _, pool := range af.pools {
		if pool != excludePool && pool.healthy.Load() {
			latency := pool.latency.Load()
			if lowestLatency < 0 || latency < lowestLatency {
				lowestLatency = latency
				bestPool = pool
			}
		}
	}
	
	return bestPool
}

// findBestHashratePool finds pool with best hashrate acceptance
func (af *AutomaticFailover) findBestHashratePool(excludePool *PoolEndpoint) *PoolEndpoint {
	var bestPool *PoolEndpoint
	var bestRatio float64
	
	for _, pool := range af.pools {
		if pool != excludePool && pool.healthy.Load() {
			submitted := pool.sharesSubmitted.Load()
			accepted := pool.sharesAccepted.Load()
			
			if submitted > 0 {
				ratio := float64(accepted) / float64(submitted)
				if ratio > bestRatio {
					bestRatio = ratio
					bestPool = pool
				}
			}
		}
	}
	
	if bestPool == nil {
		// Fall back to priority if no statistics
		return af.findByPriority(excludePool)
	}
	
	return bestPool
}

// switchToPool switches to a new pool
func (af *AutomaticFailover) switchToPool(ctx context.Context, pool *PoolEndpoint) error {
	// Disconnect from current pool
	if current := af.GetCurrentPool(); current != nil {
		af.disconnectPool(current)
	}
	
	// Connect to new pool
	if err := af.connectPool(ctx, pool); err != nil {
		return fmt.Errorf("failed to connect to %s: %w", pool.URL, err)
	}
	
	// Set as current pool
	af.currentPool.Store(pool)
	
	return nil
}

// connectPool connects to a pool
func (af *AutomaticFailover) connectPool(ctx context.Context, pool *PoolEndpoint) error {
	// In production, implement actual pool connection
	// Implementation completed
	pool.connMu.Lock()
	defer pool.connMu.Unlock()
	
	// Simulate connection
	select {
	case <-time.After(100 * time.Millisecond):
		pool.conn = fmt.Sprintf("connection_to_%s", pool.URL)
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// disconnectPool disconnects from a pool
func (af *AutomaticFailover) disconnectPool(pool *PoolEndpoint) {
	pool.connMu.Lock()
	defer pool.connMu.Unlock()
	
	// In production, close actual connection
	pool.conn = nil
}

// healthMonitor monitors pool health
func (af *AutomaticFailover) healthMonitor() {
	ticker := time.NewTicker(af.config.HealthCheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			af.checkAllPools()
			
		case <-af.ctx.Done():
			return
		}
	}
}

// checkAllPools checks health of all pools
func (af *AutomaticFailover) checkAllPools() {
	af.poolsMu.RLock()
	pools := make([]*PoolEndpoint, len(af.pools))
	copy(pools, af.pools)
	af.poolsMu.RUnlock()
	
	var wg sync.WaitGroup
	for _, pool := range pools {
		wg.Add(1)
		go func(p *PoolEndpoint) {
			defer wg.Done()
			af.checkPoolHealth(p)
		}(pool)
	}
	
	wg.Wait()
	
	// Check if current pool is unhealthy
	if current := af.GetCurrentPool(); current != nil {
		if !current.healthy.Load() {
			af.performFailover(current, "health check failed")
		}
	}
}

// checkPoolHealth checks a single pool's health
func (af *AutomaticFailover) checkPoolHealth(pool *PoolEndpoint) {
	ctx, cancel := context.WithTimeout(af.ctx, af.healthChecker.timeout)
	defer cancel()
	
	startTime := time.Now()
	err := af.healthChecker.checkFunc(ctx, pool)
	latency := time.Since(startTime)
	
	pool.latency.Store(int64(latency / time.Microsecond))
	pool.lastCheck.Store(time.Now())
	
	if err != nil {
		// Health check failed
		failures := pool.failures.Add(1)
		pool.successes.Store(0)
		
		if failures >= int32(af.config.FailureThreshold) {
			pool.healthy.Store(false)
			fmt.Printf("Pool %s marked unhealthy: %v\n", pool.URL, err)
		}
	} else {
		// Health check succeeded
		successes := pool.successes.Add(1)
		
		if !pool.healthy.Load() && successes >= int32(af.config.RecoveryThreshold) {
			// Pool recovered
			pool.healthy.Store(true)
			pool.failures.Store(0)
			af.recoveryCount.Add(1)
			fmt.Printf("Pool %s recovered\n", pool.URL)
		}
	}
}

// defaultHealthCheck performs default health check
func (af *AutomaticFailover) defaultHealthCheck(ctx context.Context, pool *PoolEndpoint) error {
	// In production, implement actual health check
	// This could involve:
	// - Sending a ping/getwork request
	// - Checking connection status
	// - Verifying authentication
	
	// Simulate health check
	select {
	case <-time.After(50 * time.Millisecond):
		// Randomly fail for testing
		if time.Now().Unix()%10 == 0 {
			return errors.New("simulated health check failure")
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// sortPools sorts pools by priority
func (af *AutomaticFailover) sortPools() {
	// Simple bubble sort for small lists
	n := len(af.pools)
	for i := 0; i < n-1; i++ {
		for j := 0; j < n-i-1; j++ {
			if af.pools[j].Priority > af.pools[j+1].Priority {
				af.pools[j], af.pools[j+1] = af.pools[j+1], af.pools[j]
			}
		}
	}
}

// recordFailoverEvent records a failover event
func (af *AutomaticFailover) recordFailoverEvent(event FailoverEvent) {
	// In production, persist to database or log
	fmt.Printf("Failover event: %+v\n", event)
}

// detectRegion detects region from hostname
func detectRegion(host string) string {
	// Simple region detection based on hostname
	// In production, use GeoIP or more sophisticated detection
	
	switch {
	case contains(host, "us"):
		return "us"
	case contains(host, "eu"):
		return "eu"
	case contains(host, "asia"):
		return "asia"
	default:
		return "unknown"
	}
}

// contains checks if string contains substring
func contains(s, substr string) bool {
	return len(s) >= len(substr) && s[:len(substr)] == substr
}

// GetStatistics returns failover statistics
func (af *AutomaticFailover) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	stats["failover_count"] = af.failoverCount.Load()
	stats["recovery_count"] = af.recoveryCount.Load()
	stats["total_downtime_ms"] = af.totalDowntime.Load() / int64(time.Millisecond)
	
	if lastFailover := af.lastFailover.Load(); lastFailover != nil {
		stats["last_failover"] = lastFailover.(time.Time)
	}
	
	// Pool statistics
	af.poolsMu.RLock()
	poolStats := make([]map[string]interface{}, len(af.pools))
	for i, pool := range af.pools {
		poolStats[i] = map[string]interface{}{
			"url":             pool.URL,
			"healthy":         pool.healthy.Load(),
			"priority":        pool.Priority,
			"region":          pool.Region,
			"latency_us":      pool.latency.Load(),
			"shares_accepted": pool.sharesAccepted.Load(),
			"shares_submitted": pool.sharesSubmitted.Load(),
			"blocks_found":    pool.blocksFound.Load(),
		}
	}
	af.poolsMu.RUnlock()
	
	stats["pools"] = poolStats
	
	if current := af.GetCurrentPool(); current != nil {
		stats["current_pool"] = current.URL
	}
	
	return stats
}

// Stop stops the failover manager
func (af *AutomaticFailover) Stop() {
	af.cancel()
}

// SetHealthCheckFunc sets custom health check function
func (af *AutomaticFailover) SetHealthCheckFunc(fn HealthCheckFunc) {
	af.healthChecker.checkFunc = fn
}

// UpdatePoolStatistics updates pool statistics
func (af *AutomaticFailover) UpdatePoolStatistics(poolURL string, accepted, submitted bool) {
	af.poolsMu.RLock()
	defer af.poolsMu.RUnlock()
	
	for _, pool := range af.pools {
		if pool.URL == poolURL {
			if submitted {
				pool.sharesSubmitted.Add(1)
			}
			if accepted {
				pool.sharesAccepted.Add(1)
			}
			break
		}
	}
}

// RecordBlockFound records a block found by pool
func (af *AutomaticFailover) RecordBlockFound(poolURL string) {
	af.poolsMu.RLock()
	defer af.poolsMu.RUnlock()
	
	for _, pool := range af.pools {
		if pool.URL == poolURL {
			pool.blocksFound.Add(1)
			break
		}
	}
}