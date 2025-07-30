package mining

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"go.uber.org/zap"
)

// PoolFailoverManager manages automatic failover between mining pools
type PoolFailoverManager struct {
	logger         *zap.Logger
	pools          []config.PoolConfig
	currentPool    int
	healthChecker  *PoolHealthChecker
	mu             sync.RWMutex
	ctx            context.Context
	cancel         context.CancelFunc
	failoverDelay  time.Duration
	lastFailover   time.Time
}

// PoolHealthChecker monitors pool health
type PoolHealthChecker struct {
	logger       *zap.Logger
	pools        map[string]*PoolHealth
	mu           sync.RWMutex
	checkInterval time.Duration
}

// PoolHealth represents the health status of a mining pool
type PoolHealth struct {
	URL                string
	Healthy            bool
	LastCheck          time.Time
	ConsecutiveFails   int
	ResponseTime       time.Duration
	ShareAcceptRate    float64
	ConnectedWorkers   int
	LastAcceptedShare  time.Time
}

// FailoverEvent represents a pool failover event
type FailoverEvent struct {
	FromPool   string
	ToPool     string
	Reason     string
	Timestamp  time.Time
	Success    bool
}

// NewPoolFailoverManager creates a new pool failover manager
func NewPoolFailoverManager(logger *zap.Logger, pools []config.PoolConfig) *PoolFailoverManager {
	ctx, cancel := context.WithCancel(context.Background())
	return &PoolFailoverManager{
		logger:        logger,
		pools:         pools,
		currentPool:   0,
		healthChecker: NewPoolHealthChecker(logger),
		ctx:           ctx,
		cancel:        cancel,
		failoverDelay: 30 * time.Second,
	}
}

// NewPoolHealthChecker creates a new pool health checker
func NewPoolHealthChecker(logger *zap.Logger) *PoolHealthChecker {
	return &PoolHealthChecker{
		logger:        logger,
		pools:         make(map[string]*PoolHealth),
		checkInterval: 10 * time.Second,
	}
}

// Start begins monitoring pools and managing failover
func (pfm *PoolFailoverManager) Start() error {
	pfm.logger.Info("Starting pool failover manager", 
		zap.Int("pool_count", len(pfm.pools)))

	// Initialize health status for all pools
	for _, pool := range pfm.pools {
		pfm.healthChecker.InitPool(pool.URL)
	}

	// Start health monitoring
	go pfm.monitorPools()

	// Start failover handler
	go pfm.handleFailovers()

	return nil
}

// Stop stops the failover manager
func (pfm *PoolFailoverManager) Stop() error {
	pfm.logger.Info("Stopping pool failover manager")
	pfm.cancel()
	return nil
}

// GetCurrentPool returns the currently active pool
func (pfm *PoolFailoverManager) GetCurrentPool() config.PoolConfig {
	pfm.mu.RLock()
	defer pfm.mu.RUnlock()
	
	if pfm.currentPool < len(pfm.pools) {
		return pfm.pools[pfm.currentPool]
	}
	return config.PoolConfig{}
}

// TriggerFailover manually triggers a failover to the next pool
func (pfm *PoolFailoverManager) TriggerFailover(reason string) error {
	pfm.mu.Lock()
	defer pfm.mu.Unlock()

	if len(pfm.pools) <= 1 {
		return fmt.Errorf("no alternative pools available for failover")
	}

	oldPool := pfm.pools[pfm.currentPool]
	pfm.currentPool = (pfm.currentPool + 1) % len(pfm.pools)
	newPool := pfm.pools[pfm.currentPool]

	event := FailoverEvent{
		FromPool:  oldPool.URL,
		ToPool:    newPool.URL,
		Reason:    reason,
		Timestamp: time.Now(),
		Success:   true,
	}

	pfm.logger.Info("Pool failover triggered",
		zap.String("from", event.FromPool),
		zap.String("to", event.ToPool),
		zap.String("reason", event.Reason))

	pfm.lastFailover = time.Now()
	return nil
}

// monitorPools continuously monitors pool health
func (pfm *PoolFailoverManager) monitorPools() {
	ticker := time.NewTicker(pfm.healthChecker.checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-pfm.ctx.Done():
			return
		case <-ticker.C:
			pfm.checkAllPools()
		}
	}
}

// checkAllPools checks the health of all configured pools
func (pfm *PoolFailoverManager) checkAllPools() {
	for i, pool := range pfm.pools {
		health := pfm.healthChecker.CheckPool(pool)
		
		// Log unhealthy pools
		if !health.Healthy {
			pfm.logger.Warn("Pool health check failed",
				zap.String("url", pool.URL),
				zap.Int("consecutive_fails", health.ConsecutiveFails))
		}

		// Update current pool health
		if i == pfm.currentPool && !health.Healthy {
			// Current pool is unhealthy, consider failover
			if health.ConsecutiveFails >= 3 {
				pfm.TriggerFailover("Pool health check failed")
			}
		}
	}
}

// handleFailovers manages automatic failover logic
func (pfm *PoolFailoverManager) handleFailovers() {
	for {
		select {
		case <-pfm.ctx.Done():
			return
		default:
			// Check if current pool needs failover
			currentHealth := pfm.healthChecker.GetPoolHealth(pfm.GetCurrentPool().URL)
			if currentHealth != nil && !currentHealth.Healthy {
				// Apply failover delay to prevent rapid switching
				if time.Since(pfm.lastFailover) > pfm.failoverDelay {
					// Find next healthy pool
					nextPool := pfm.findNextHealthyPool()
					if nextPool >= 0 {
						pfm.mu.Lock()
						pfm.currentPool = nextPool
						pfm.lastFailover = time.Now()
						pfm.mu.Unlock()
						
						pfm.logger.Info("Automatic failover completed",
							zap.Int("new_pool_index", nextPool),
							zap.String("new_pool_url", pfm.pools[nextPool].URL))
					}
				}
			}
			
			time.Sleep(5 * time.Second)
		}
	}
}

// findNextHealthyPool finds the next healthy pool in the list
func (pfm *PoolFailoverManager) findNextHealthyPool() int {
	pfm.mu.RLock()
	defer pfm.mu.RUnlock()

	// Start from next pool after current
	start := (pfm.currentPool + 1) % len(pfm.pools)
	
	for i := 0; i < len(pfm.pools); i++ {
		idx := (start + i) % len(pfm.pools)
		health := pfm.healthChecker.GetPoolHealth(pfm.pools[idx].URL)
		if health != nil && health.Healthy {
			return idx
		}
	}
	
	return -1 // No healthy pools found
}

// PoolHealthChecker methods

// InitPool initializes health tracking for a pool
func (phc *PoolHealthChecker) InitPool(url string) {
	phc.mu.Lock()
	defer phc.mu.Unlock()
	
	phc.pools[url] = &PoolHealth{
		URL:     url,
		Healthy: true, // Assume healthy initially
	}
}

// CheckPool performs a health check on a pool
func (phc *PoolHealthChecker) CheckPool(pool config.PoolConfig) *PoolHealth {
	phc.mu.Lock()
	defer phc.mu.Unlock()

	health, exists := phc.pools[pool.URL]
	if !exists {
		health = &PoolHealth{URL: pool.URL}
		phc.pools[pool.URL] = health
	}

	// Perform actual health check
	start := time.Now()
	healthy := phc.performHealthCheck(pool)
	health.ResponseTime = time.Since(start)
	health.LastCheck = time.Now()

	if healthy {
		health.Healthy = true
		health.ConsecutiveFails = 0
	} else {
		health.Healthy = false
		health.ConsecutiveFails++
	}

	return health
}

// performHealthCheck performs the actual health check
func (phc *PoolHealthChecker) performHealthCheck(pool config.PoolConfig) bool {
	// This is a simplified health check
	// In a real implementation, you would:
	// 1. Attempt to connect to the pool
	// 2. Send a test request
	// 3. Verify the response
	// 4. Check response time
	
	// For now, we'll simulate a health check
	// In production, this would use the Stratum client to test connectivity
	
	return true // Placeholder
}

// GetPoolHealth returns the current health status of a pool
func (phc *PoolHealthChecker) GetPoolHealth(url string) *PoolHealth {
	phc.mu.RLock()
	defer phc.mu.RUnlock()
	
	health, exists := phc.pools[url]
	if !exists {
		return nil
	}
	
	// Return a copy to prevent concurrent modification
	healthCopy := *health
	return &healthCopy
}

// GetAllPoolHealth returns health status for all pools
func (phc *PoolHealthChecker) GetAllPoolHealth() map[string]*PoolHealth {
	phc.mu.RLock()
	defer phc.mu.RUnlock()
	
	result := make(map[string]*PoolHealth)
	for url, health := range phc.pools {
		healthCopy := *health
		result[url] = &healthCopy
	}
	
	return result
}

// UpdatePoolMetrics updates pool metrics based on mining activity
func (phc *PoolHealthChecker) UpdatePoolMetrics(url string, accepted bool, responseTime time.Duration) {
	phc.mu.Lock()
	defer phc.mu.Unlock()
	
	health, exists := phc.pools[url]
	if !exists {
		return
	}
	
	// Update response time (moving average)
	health.ResponseTime = (health.ResponseTime + responseTime) / 2
	
	// Update share accept rate
	// This is simplified - in production, you'd track more shares
	if accepted {
		health.ShareAcceptRate = (health.ShareAcceptRate*0.95) + 0.05
		health.LastAcceptedShare = time.Now()
	} else {
		health.ShareAcceptRate = health.ShareAcceptRate * 0.95
	}
	
	// Mark as unhealthy if no accepted shares for too long
	if time.Since(health.LastAcceptedShare) > 5*time.Minute {
		health.Healthy = false
		phc.logger.Warn("Pool marked unhealthy due to no accepted shares",
			zap.String("url", url),
			zap.Duration("since_last_share", time.Since(health.LastAcceptedShare)))
	}
}