package pool

import (
	"fmt"
	"math"
	"net"
	"sort"
	"time"

	"go.uber.org/zap"
)

// LatencyBasedStrategy implements failover based on network latency
type LatencyBasedStrategy struct {
	name             string
	priority         int
	latencyThreshold time.Duration
	logger           *zap.Logger
}

func (lbs *LatencyBasedStrategy) Name() string {
	return lbs.name
}

func (lbs *LatencyBasedStrategy) GetPriority() int {
	return lbs.priority
}

func (lbs *LatencyBasedStrategy) ShouldFailover(pool *PoolConnection, metrics *PoolPerformanceMetrics) bool {
	if metrics == nil {
		return false
	}
	
	// Check if average latency exceeds threshold
	if metrics.AverageLatency > lbs.latencyThreshold {
		lbs.logger.Warn("High latency detected",
			zap.String("pool_id", pool.ID),
			zap.Duration("latency", metrics.AverageLatency),
			zap.Duration("threshold", lbs.latencyThreshold))
		return true
	}
	
	// Check for latency spikes (variance)
	if metrics.LatencyVariance > lbs.latencyThreshold/2 {
		lbs.logger.Warn("High latency variance detected",
			zap.String("pool_id", pool.ID),
			zap.Duration("variance", metrics.LatencyVariance))
		return true
	}
	
	return false
}

func (lbs *LatencyBasedStrategy) SelectBackupPool(failed *PoolConnection, available []*PoolConnection) *PoolConnection {
	if len(available) == 0 {
		return nil
	}
	
	// Sort by latency (lowest first)
	sort.Slice(available, func(i, j int) bool {
		statsI := available[i].Statistics
		statsJ := available[j].Statistics
		
		if statsI == nil && statsJ == nil {
			return available[i].Priority < available[j].Priority
		}
		if statsI == nil {
			return false
		}
		if statsJ == nil {
			return true
		}
		
		return statsI.AverageLatency < statsJ.AverageLatency
	})
	
	return available[0]
}

// ErrorRateStrategy implements failover based on error rates
type ErrorRateStrategy struct {
	name               string
	priority           int
	errorRateThreshold float64
	logger             *zap.Logger
}

func (ers *ErrorRateStrategy) Name() string {
	return ers.name
}

func (ers *ErrorRateStrategy) GetPriority() int {
	return ers.priority
}

func (ers *ErrorRateStrategy) ShouldFailover(pool *PoolConnection, metrics *PoolPerformanceMetrics) bool {
	if metrics == nil {
		return false
	}
	
	// Check error rate
	if metrics.ErrorRate > ers.errorRateThreshold {
		ers.logger.Warn("High error rate detected",
			zap.String("pool_id", pool.ID),
			zap.Float64("error_rate", metrics.ErrorRate),
			zap.Float64("threshold", ers.errorRateThreshold))
		return true
	}
	
	// Check stale rate
	if metrics.StaleRate > ers.errorRateThreshold*2 {
		ers.logger.Warn("High stale rate detected",
			zap.String("pool_id", pool.ID),
			zap.Float64("stale_rate", metrics.StaleRate))
		return true
	}
	
	// Check acceptance rate
	if metrics.AcceptanceRate < (1.0 - ers.errorRateThreshold) {
		ers.logger.Warn("Low acceptance rate detected",
			zap.String("pool_id", pool.ID),
			zap.Float64("acceptance_rate", metrics.AcceptanceRate))
		return true
	}
	
	return false
}

func (ers *ErrorRateStrategy) SelectBackupPool(failed *PoolConnection, available []*PoolConnection) *PoolConnection {
	if len(available) == 0 {
		return nil
	}
	
	// Sort by error rate (lowest first) and acceptance rate (highest first)
	sort.Slice(available, func(i, j int) bool {
		statsI := available[i].Statistics
		statsJ := available[j].Statistics
		
		if statsI == nil && statsJ == nil {
			return available[i].Priority < available[j].Priority
		}
		if statsI == nil {
			return false
		}
		if statsJ == nil {
			return true
		}
		
		// Calculate composite score (lower is better)
		scoreI := statsI.SharesRejected + statsI.SharesStale
		scoreJ := statsJ.SharesRejected + statsJ.SharesStale
		
		if scoreI == scoreJ {
			return statsI.AcceptanceRate > statsJ.AcceptanceRate
		}
		
		return scoreI < scoreJ
	})
	
	return available[0]
}

// PredictiveStrategy implements ML-based predictive failover
type PredictiveStrategy struct {
	name               string
	priority           int
	performanceTracker *PoolPerformanceTracker
	logger             *zap.Logger
}

func (ps *PredictiveStrategy) Name() string {
	return ps.name
}

func (ps *PredictiveStrategy) GetPriority() int {
	return ps.priority
}

func (ps *PredictiveStrategy) ShouldFailover(pool *PoolConnection, metrics *PoolPerformanceMetrics) bool {
	if metrics == nil {
		return false
	}
	
	// Check trend direction
	if metrics.TrendDirection == TrendDirectionDegrading {
		ps.logger.Info("Degrading performance trend detected",
			zap.String("pool_id", pool.ID),
			zap.Float64("predicted_performance", metrics.PredictedPerformance))
		
		// Failover if predicted performance drops below 70%
		if metrics.PredictedPerformance < 0.7 {
			return true
		}
	}
	
	// Check stability
	if metrics.Stability < 0.5 {
		ps.logger.Warn("Low stability detected",
			zap.String("pool_id", pool.ID),
			zap.Float64("stability", metrics.Stability))
		return true
	}
	
	// Check reliability trend
	if metrics.Reliability < 0.8 && metrics.TrendDirection == TrendDirectionDegrading {
		ps.logger.Warn("Declining reliability detected",
			zap.String("pool_id", pool.ID),
			zap.Float64("reliability", metrics.Reliability))
		return true
	}
	
	return false
}

func (ps *PredictiveStrategy) SelectBackupPool(failed *PoolConnection, available []*PoolConnection) *PoolConnection {
	if len(available) == 0 {
		return nil
	}
	
	// Score pools based on predicted performance
	type poolScore struct {
		pool  *PoolConnection
		score float64
	}
	
	scores := make([]poolScore, 0, len(available))
	
	for _, pool := range available {
		metrics := ps.performanceTracker.GetMetrics(pool.ID)
		score := 0.0
		
		if metrics != nil {
			// Composite score based on multiple factors
			score = metrics.PredictedPerformance*0.3 +
				metrics.Reliability*0.25 +
				metrics.Stability*0.25 +
				(1.0-metrics.ErrorRate)*0.2
		} else {
			// Fallback to priority-based scoring
			score = 1.0 / float64(pool.Priority+1)
		}
		
		scores = append(scores, poolScore{pool: pool, score: score})
	}
	
	// Sort by score (highest first)
	sort.Slice(scores, func(i, j int) bool {
		return scores[i].score > scores[j].score
	})
	
	return scores[0].pool
}

// CircuitBreakerStrategy implements circuit breaker pattern
type CircuitBreakerStrategy struct {
	name            string
	priority        int
	circuitBreakers map[string]*CircuitBreaker
	logger          *zap.Logger
}

func (cbs *CircuitBreakerStrategy) Name() string {
	return cbs.name
}

func (cbs *CircuitBreakerStrategy) GetPriority() int {
	return cbs.priority
}

func (cbs *CircuitBreakerStrategy) ShouldFailover(pool *PoolConnection, metrics *PoolPerformanceMetrics) bool {
	breaker, exists := cbs.circuitBreakers[pool.ID]
	if !exists {
		return false
	}
	
	// Failover if circuit breaker is open
	if breaker.GetState() == CircuitStateOpen {
		cbs.logger.Warn("Circuit breaker open",
			zap.String("pool_id", pool.ID),
			zap.Int("failure_count", breaker.GetFailureCount()))
		return true
	}
	
	return false
}

func (cbs *CircuitBreakerStrategy) SelectBackupPool(failed *PoolConnection, available []*PoolConnection) *PoolConnection {
	if len(available) == 0 {
		return nil
	}
	
	// Filter out pools with open circuit breakers
	healthyPools := make([]*PoolConnection, 0)
	
	for _, pool := range available {
		if breaker, exists := cbs.circuitBreakers[pool.ID]; exists {
			if breaker.CanExecute() {
				healthyPools = append(healthyPools, pool)
			}
		} else {
			healthyPools = append(healthyPools, pool)
		}
	}
	
	if len(healthyPools) == 0 {
		// If all circuits are open, return highest priority pool anyway
		sort.Slice(available, func(i, j int) bool {
			return available[i].Priority < available[j].Priority
		})
		return available[0]
	}
	
	// Sort by priority
	sort.Slice(healthyPools, func(i, j int) bool {
		return healthyPools[i].Priority < healthyPools[j].Priority
	})
	
	return healthyPools[0]
}

// CircuitBreaker implementation
func NewCircuitBreaker(name string, maxFailures int, timeout time.Duration, onStateChange func(from, to CircuitState)) *CircuitBreaker {
	return &CircuitBreaker{
		name:          name,
		maxFailures:   maxFailures,
		timeout:       timeout,
		state:         CircuitStateClosed,
		onStateChange: onStateChange,
	}
}

func (cb *CircuitBreaker) CanExecute() bool {
	cb.mu.RLock()
	defer cb.mu.RUnlock()
	
	switch cb.state {
	case CircuitStateClosed:
		return true
	case CircuitStateOpen:
		return time.Since(cb.lastFailureTime) >= cb.timeout
	case CircuitStateHalfOpen:
		return true
	default:
		return false
	}
}

func (cb *CircuitBreaker) RecordSuccess() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	
	oldState := cb.state
	cb.failureCount = 0
	
	if cb.state == CircuitStateHalfOpen {
		cb.state = CircuitStateClosed
		if cb.onStateChange != nil {
			cb.onStateChange(oldState, cb.state)
		}
	}
}

func (cb *CircuitBreaker) RecordFailure() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	
	cb.failureCount++
	cb.lastFailureTime = time.Now()
	
	oldState := cb.state
	
	if cb.failureCount >= cb.maxFailures && cb.state == CircuitStateClosed {
		cb.state = CircuitStateOpen
		if cb.onStateChange != nil {
			cb.onStateChange(oldState, cb.state)
		}
	}
}

func (cb *CircuitBreaker) ShouldAttemptReset() bool {
	cb.mu.RLock()
	defer cb.mu.RUnlock()
	
	return cb.state == CircuitStateOpen && time.Since(cb.lastFailureTime) >= cb.timeout
}

func (cb *CircuitBreaker) AttemptReset() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	
	if cb.state == CircuitStateOpen {
		oldState := cb.state
		cb.state = CircuitStateHalfOpen
		if cb.onStateChange != nil {
			cb.onStateChange(oldState, cb.state)
		}
	}
}

func (cb *CircuitBreaker) GetState() CircuitState {
	cb.mu.RLock()
	defer cb.mu.RUnlock()
	return cb.state
}

func (cb *CircuitBreaker) GetFailureCount() int {
	cb.mu.RLock()
	defer cb.mu.RUnlock()
	return cb.failureCount
}

// PoolHealthMonitor methods
func (phm *PoolHealthMonitor) RegisterPool(pool *PoolConnection) {
	phm.mu.Lock()
	defer phm.mu.Unlock()
	
	phm.pools[pool.ID] = pool
	phm.healthCheckers[pool.ID] = &HealthChecker{
		PoolID:        pool.ID,
		CheckInterval: 30 * time.Second,
		Timeout:       5 * time.Second,
		CheckHistory:  make([]HealthCheckResult, 0),
		Issues:        make([]HealthIssue, 0),
	}
}

func (phm *PoolHealthMonitor) CheckPoolHealth(pool *PoolConnection) {
	checker := phm.healthCheckers[pool.ID]
	if checker == nil {
		return
	}
	
	startTime := time.Now()
	result := HealthCheckResult{
		Timestamp: startTime,
		Checks:    make(map[string]bool),
	}
	
	// Perform connectivity check
	result.Checks["connectivity"] = phm.checkConnectivity(pool)
	
	// Perform latency check
	latency, latencyOK := phm.checkLatency(pool)
	result.Checks["latency"] = latencyOK
	result.Latency = latency
	
	// Perform protocol check
	result.Checks["protocol"] = phm.checkProtocol(pool)
	
	// Perform authentication check
	result.Checks["authentication"] = phm.checkAuthentication(pool)
	
	// Calculate overall success
	successCount := 0
	for _, success := range result.Checks {
		if success {
			successCount++
		}
	}
	
	result.Success = successCount == len(result.Checks)
	result.Score = float64(successCount) / float64(len(result.Checks))
	
	// Update checker
	phm.mu.Lock()
	checker.CheckHistory = append(checker.CheckHistory, result)
	checker.LastCheck = startTime
	checker.HealthScore = result.Score
	
	// Limit history size
	maxHistory := 100
	if len(checker.CheckHistory) > maxHistory {
		checker.CheckHistory = checker.CheckHistory[len(checker.CheckHistory)-maxHistory:]
	}
	
	// Update pool health score
	pool.HealthScore = phm.calculateHealthScore(checker.CheckHistory)
	pool.LastHealthCheck = startTime
	
	// Update pool status
	phm.updatePoolStatus(pool, result)
	
	// Detect and record issues
	phm.detectHealthIssues(pool, checker, result)
	
	phm.mu.Unlock()
	
	phm.logger.Debug("Pool health check completed",
		zap.String("pool_id", pool.ID),
		zap.Bool("success", result.Success),
		zap.Float64("score", result.Score),
		zap.Duration("latency", result.Latency))
}

func (phm *PoolHealthMonitor) checkConnectivity(pool *PoolConnection) bool {
	// Simplified connectivity check
	// In practice, this would attempt a TCP connection
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", pool.Host, pool.Port), 5*time.Second)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func (phm *PoolHealthMonitor) checkLatency(pool *PoolConnection) (time.Duration, bool) {
	start := time.Now()
	
	// Simplified latency check
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", pool.Host, pool.Port), 5*time.Second)
	latency := time.Since(start)
	
	if err != nil {
		return latency, false
	}
	conn.Close()
	
	// Consider latency check successful if under 1 second
	return latency, latency < time.Second
}

func (phm *PoolHealthMonitor) checkProtocol(pool *PoolConnection) bool {
	// Simplified protocol check
	// In practice, this would verify Stratum protocol compatibility
	return true
}

func (phm *PoolHealthMonitor) checkAuthentication(pool *PoolConnection) bool {
	// Simplified authentication check
	// In practice, this would attempt Stratum authentication
	return pool.Credentials != nil && pool.Credentials.Username != ""
}

func (phm *PoolHealthMonitor) calculateHealthScore(history []HealthCheckResult) float64 {
	if len(history) == 0 {
		return 0
	}
	
	// Calculate weighted average with recent checks having more weight
	totalScore := 0.0
	totalWeight := 0.0
	
	for i, check := range history {
		weight := float64(i+1) // More recent checks have higher weight
		totalScore += check.Score * weight
		totalWeight += weight
	}
	
	return totalScore / totalWeight
}

func (phm *PoolHealthMonitor) updatePoolStatus(pool *PoolConnection, result HealthCheckResult) {
	if result.Success {
		if pool.Status == PoolStatusUnhealthy || pool.Status == PoolStatusFailed {
			pool.Status = PoolStatusHealthy
		}
		pool.ConsecutiveFailures = 0
	} else {
		pool.ConsecutiveFailures++
		
		if pool.ConsecutiveFailures >= 3 {
			pool.Status = PoolStatusFailed
		} else if pool.ConsecutiveFailures >= 2 {
			pool.Status = PoolStatusUnhealthy
		} else {
			pool.Status = PoolStatusDegraded
		}
	}
}

func (phm *PoolHealthMonitor) detectHealthIssues(pool *PoolConnection, checker *HealthChecker, result HealthCheckResult) {
	// Detect connectivity issues
	if !result.Checks["connectivity"] {
		phm.recordHealthIssue(checker, HealthIssue{
			Type:        IssueTypeConnectivity,
			Severity:    IssueSeverityCritical,
			Description: "Pool connectivity failed",
		})
	}
	
	// Detect latency issues
	if result.Latency > 500*time.Millisecond {
		severity := IssueSeverityMedium
		if result.Latency > time.Second {
			severity = IssueSeverityHigh
		}
		
		phm.recordHealthIssue(checker, HealthIssue{
			Type:        IssueTypeLatency,
			Severity:    severity,
			Description: fmt.Sprintf("High latency: %v", result.Latency),
		})
	}
	
	// Detect authentication issues
	if !result.Checks["authentication"] {
		phm.recordHealthIssue(checker, HealthIssue{
			Type:        IssueTypeAuthentication,
			Severity:    IssueSeverityHigh,
			Description: "Authentication failed",
		})
	}
	
	// Detect performance issues
	if result.Score < 0.7 {
		phm.recordHealthIssue(checker, HealthIssue{
			Type:        IssueTypePerformance,
			Severity:    IssueSeverityMedium,
			Description: fmt.Sprintf("Low health score: %.2f", result.Score),
		})
	}
}

func (phm *PoolHealthMonitor) recordHealthIssue(checker *HealthChecker, issue HealthIssue) {
	now := time.Now()
	
	// Check if this issue already exists
	for i, existingIssue := range checker.Issues {
		if existingIssue.Type == issue.Type {
			// Update existing issue
			checker.Issues[i].LastSeen = now
			checker.Issues[i].Occurrences++
			return
		}
	}
	
	// Add new issue
	issue.FirstDetected = now
	issue.LastSeen = now
	issue.Occurrences = 1
	
	checker.Issues = append(checker.Issues, issue)
	
	// Limit issues history
	maxIssues := 50
	if len(checker.Issues) > maxIssues {
		checker.Issues = checker.Issues[len(checker.Issues)-maxIssues:]
	}
}

// PoolLoadBalancer methods
func (plb *PoolLoadBalancer) AddPool(pool *PoolConnection) {
	plb.mu.Lock()
	defer plb.mu.Unlock()
	
	plb.pools = append(plb.pools, pool)
	plb.weights[pool.ID] = pool.Weight
	plb.connections[pool.ID] = 0
}

func (plb *PoolLoadBalancer) UpdatePoolWeight(poolID string, weight float64) {
	plb.mu.Lock()
	defer plb.mu.Unlock()
	
	plb.weights[poolID] = weight
	
	// Update pool object
	for _, pool := range plb.pools {
		if pool.ID == poolID {
			pool.Weight = weight
			break
		}
	}
}

func (plb *PoolLoadBalancer) SelectPool() *PoolConnection {
	plb.mu.Lock()
	defer plb.mu.Unlock()
	
	if len(plb.pools) == 0 {
		return nil
	}
	
	switch plb.mode {
	case LoadBalanceModeRoundRobin:
		return plb.selectRoundRobin()
	case LoadBalanceModeWeighted:
		return plb.selectWeighted()
	case LoadBalanceModeLeastConnections:
		return plb.selectLeastConnections()
	case LoadBalanceModeLeastLatency:
		return plb.selectLeastLatency()
	default:
		return plb.selectRoundRobin()
	}
}

func (plb *PoolLoadBalancer) selectRoundRobin() *PoolConnection {
	if len(plb.pools) == 0 {
		return nil
	}
	
	pool := plb.pools[plb.roundRobinIndex%len(plb.pools)]
	plb.roundRobinIndex++
	return pool
}

func (plb *PoolLoadBalancer) selectWeighted() *PoolConnection {
	if len(plb.pools) == 0 {
		return nil
	}
	
	// Calculate total weight
	totalWeight := 0.0
	for _, pool := range plb.pools {
		totalWeight += plb.weights[pool.ID]
	}
	
	if totalWeight == 0 {
		return plb.selectRoundRobin()
	}
	
	// Generate random value
	random := float64(time.Now().UnixNano()%1000) / 1000.0 * totalWeight
	
	// Select pool based on weight
	currentWeight := 0.0
	for _, pool := range plb.pools {
		currentWeight += plb.weights[pool.ID]
		if random <= currentWeight {
			return pool
		}
	}
	
	return plb.pools[0]
}

func (plb *PoolLoadBalancer) selectLeastConnections() *PoolConnection {
	if len(plb.pools) == 0 {
		return nil
	}
	
	minConnections := math.MaxInt32
	var selectedPool *PoolConnection
	
	for _, pool := range plb.pools {
		connections := plb.connections[pool.ID]
		if connections < minConnections {
			minConnections = connections
			selectedPool = pool
		}
	}
	
	return selectedPool
}

func (plb *PoolLoadBalancer) selectLeastLatency() *PoolConnection {
	if len(plb.pools) == 0 {
		return nil
	}
	
	var bestPool *PoolConnection
	var bestLatency time.Duration = time.Duration(math.MaxInt64)
	
	for _, pool := range plb.pools {
		if pool.Statistics != nil && pool.Statistics.AverageLatency < bestLatency {
			bestLatency = pool.Statistics.AverageLatency
			bestPool = pool
		}
	}
	
	if bestPool == nil {
		return plb.selectRoundRobin()
	}
	
	return bestPool
}

func (plb *PoolLoadBalancer) RebalanceConnections() {
	plb.mu.Lock()
	defer plb.mu.Unlock()
	
	// Simple rebalancing logic
	totalConnections := 0
	for _, count := range plb.connections {
		totalConnections += count
	}
	
	if totalConnections == 0 {
		return
	}
	
	expectedConnectionsPerPool := totalConnections / len(plb.pools)
	
	for poolID, currentConnections := range plb.connections {
		if currentConnections > expectedConnectionsPerPool+1 {
			plb.logger.Debug("Pool has excess connections",
				zap.String("pool_id", poolID),
				zap.Int("current", currentConnections),
				zap.Int("expected", expectedConnectionsPerPool))
		}
	}
}

// PoolPerformanceTracker methods
func (ppt *PoolPerformanceTracker) RegisterPool(pool *PoolConnection) {
	ppt.mu.Lock()
	defer ppt.mu.Unlock()
	
	ppt.metrics[pool.ID] = &PoolPerformanceMetrics{
		PoolID:           pool.ID,
		TrendDirection:   TrendDirectionUnknown,
		MetricsHistory:   make([]MetricsSnapshot, 0),
		LastUpdated:      time.Now(),
	}
	
	ppt.collectors[pool.ID] = &MetricsCollector{
		PoolID:           pool.ID,
		CollectionWindow: 5 * time.Minute,
		SampleSize:       50,
		LastCollection:   time.Now(),
	}
}

func (ppt *PoolPerformanceTracker) RecordConnectionTime(poolID string, duration time.Duration) {
	ppt.mu.Lock()
	defer ppt.mu.Unlock()
	
	if metrics, exists := ppt.metrics[poolID]; exists {
		metrics.ConnectionTime = duration
		metrics.LastUpdated = time.Now()
	}
}

func (ppt *PoolPerformanceTracker) UpdateMetrics(poolID string, connection *ActiveConnection) {
	ppt.mu.Lock()
	defer ppt.mu.Unlock()
	
	metrics, exists := ppt.metrics[poolID]
	if !exists {
		return
	}
	
	// Update connection health
	metrics.mu.Lock()
	
	// Calculate latency from recent activity
	if !connection.LastActivity.IsZero() {
		currentLatency := time.Since(connection.LastActivity)
		if metrics.AverageLatency == 0 {
			metrics.AverageLatency = currentLatency
		} else {
			metrics.AverageLatency = (metrics.AverageLatency + currentLatency) / 2
		}
	}
	
	// Calculate stability based on connection health
	metrics.Stability = connection.ConnectionHealth
	
	// Calculate reliability based on uptime
	uptime := time.Since(connection.ConnectedAt)
	metrics.Reliability = math.Min(1.0, uptime.Hours()/24.0) // Max reliability after 24 hours
	
	// Calculate performance score
	metrics.PerformanceScore = ppt.calculatePerformanceScore(metrics)
	
	// Update trend direction
	metrics.TrendDirection = ppt.calculateTrendDirection(metrics)
	
	// Predict future performance
	metrics.PredictedPerformance = ppt.predictPerformance(metrics)
	
	metrics.LastUpdated = time.Now()
	
	// Add to history
	snapshot := MetricsSnapshot{
		Timestamp:        time.Now(),
		Latency:          metrics.AverageLatency,
		ErrorRate:        metrics.ErrorRate,
		AcceptanceRate:   metrics.AcceptanceRate,
		PerformanceScore: metrics.PerformanceScore,
	}
	
	metrics.MetricsHistory = append(metrics.MetricsHistory, snapshot)
	
	// Limit history size
	maxHistory := 288 // 24 hours at 5-minute intervals
	if len(metrics.MetricsHistory) > maxHistory {
		metrics.MetricsHistory = metrics.MetricsHistory[len(metrics.MetricsHistory)-maxHistory:]
	}
	
	metrics.mu.Unlock()
}

func (ppt *PoolPerformanceTracker) calculatePerformanceScore(metrics *PoolPerformanceMetrics) float64 {
	// Composite score based on multiple factors
	latencyScore := 1.0
	if metrics.AverageLatency > 0 {
		latencyScore = math.Max(0, 1.0-float64(metrics.AverageLatency.Milliseconds())/1000.0)
	}
	
	errorScore := math.Max(0, 1.0-metrics.ErrorRate)
	acceptanceScore := metrics.AcceptanceRate
	stabilityScore := metrics.Stability
	reliabilityScore := metrics.Reliability
	
	// Weighted combination
	score := latencyScore*0.2 + errorScore*0.25 + acceptanceScore*0.25 + stabilityScore*0.15 + reliabilityScore*0.15
	
	return math.Max(0, math.Min(1, score))
}

func (ppt *PoolPerformanceTracker) calculateTrendDirection(metrics *PoolPerformanceMetrics) TrendDirection {
	if len(metrics.MetricsHistory) < 5 {
		return TrendDirectionUnknown
	}
	
	// Calculate trend over recent history
	recent := metrics.MetricsHistory[len(metrics.MetricsHistory)-5:]
	
	// Simple linear regression on performance scores
	n := float64(len(recent))
	sumX := n * (n - 1) / 2
	sumY := 0.0
	sumXY := 0.0
	sumX2 := n * (n - 1) * (2*n - 1) / 6
	
	for i, snapshot := range recent {
		x := float64(i)
		y := snapshot.PerformanceScore
		sumY += y
		sumXY += x * y
	}
	
	// Calculate slope
	denominator := n*sumX2 - sumX*sumX
	if denominator == 0 {
		return TrendDirectionStable
	}
	
	slope := (n*sumXY - sumX*sumY) / denominator
	
	if slope > 0.01 {
		return TrendDirectionImproving
	} else if slope < -0.01 {
		return TrendDirectionDegrading
	} else {
		return TrendDirectionStable
	}
}

func (ppt *PoolPerformanceTracker) predictPerformance(metrics *PoolPerformanceMetrics) float64 {
	if len(metrics.MetricsHistory) < 3 {
		return metrics.PerformanceScore
	}
	
	// Simple prediction based on recent trend
	recent := metrics.MetricsHistory[len(metrics.MetricsHistory)-3:]
	
	// Calculate average and trend
	avgScore := 0.0
	for _, snapshot := range recent {
		avgScore += snapshot.PerformanceScore
	}
	avgScore /= float64(len(recent))
	
	// Apply trend factor
	trendFactor := 1.0
	switch metrics.TrendDirection {
	case TrendDirectionImproving:
		trendFactor = 1.05 // 5% improvement
	case TrendDirectionDegrading:
		trendFactor = 0.95 // 5% degradation
	case TrendDirectionStable:
		trendFactor = 1.0
	}
	
	prediction := avgScore * trendFactor
	return math.Max(0, math.Min(1, prediction))
}

func (ppt *PoolPerformanceTracker) GetMetrics(poolID string) *PoolPerformanceMetrics {
	ppt.mu.RLock()
	defer ppt.mu.RUnlock()
	
	metrics, exists := ppt.metrics[poolID]
	if !exists {
		return nil
	}
	
	// Return copy to avoid race conditions
	metricsCopy := *metrics
	metricsCopy.MetricsHistory = append([]MetricsSnapshot(nil), metrics.MetricsHistory...)
	
	return &metricsCopy
}

// Additional methods for advanced pool selection
func (ppt *PoolPerformanceTracker) GetAverageLatency(poolID string) time.Duration {
	ppt.mu.RLock()
	defer ppt.mu.RUnlock()
	
	metrics, exists := ppt.metrics[poolID]
	if !exists {
		return time.Duration(0)
	}
	
	return metrics.AverageLatency
}

func (ppt *PoolPerformanceTracker) GetRewardRate(poolID string) float64 {
	ppt.mu.RLock()
	defer ppt.mu.RUnlock()
	
	metrics, exists := ppt.metrics[poolID]
	if !exists {
		return 0.0
	}
	
	// Calculate reward rate from recent history
	if len(metrics.MetricsHistory) == 0 {
		return 0.0
	}
	
	recent := metrics.MetricsHistory
	if len(recent) > 10 {
		recent = recent[len(recent)-10:] // Last 10 samples
	}
	
	totalReward := 0.0
	for _, snapshot := range recent {
		totalReward += snapshot.RewardRate
	}
	
	return totalReward / float64(len(recent))
}

// Load balancer methods
func (plb *PoolLoadBalancer) weightedRandom() float64 {
	// Simple pseudo-random number generator for weighted selection
	return plb.randomSeed()
}

func (plb *PoolLoadBalancer) randomSeed() float64 {
	// Simple linear congruential generator
	plb.seed = (plb.seed*1103515245 + 12345) & 0x7fffffff
	return float64(plb.seed) / float64(0x7fffffff)
}

func (plb *PoolLoadBalancer) GetActiveConnections(poolID string) int {
	plb.mu.RLock()
	defer plb.mu.RUnlock()
	
	count, exists := plb.activeConnections[poolID]
	if !exists {
		return 0
	}
	
	return count
}

