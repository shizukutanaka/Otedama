package network

import (
	"context"
	"fmt"
	"math"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// RegionalLoadBalancer implements automated load balancing across regions
// Following Rob Pike's principle: "Don't communicate by sharing memory; share memory by communicating"
type RegionalLoadBalancer struct {
	logger *zap.Logger
	config *LoadBalancerConfig
	
	// Regional endpoints
	regions         map[string]*Region
	regionsMu       sync.RWMutex
	
	// Load balancing strategies
	strategy        LoadBalancingStrategy
	
	// Health monitoring
	healthMonitor   *HealthMonitor
	
	// Latency tracking
	latencyTracker  *LatencyTracker
	
	// Traffic shaping
	trafficShaper   *TrafficShaper
	
	// Failover management
	failoverManager *FailoverManager
	
	// Metrics
	metrics         *LoadBalancerMetrics
	
	// Lifecycle
	ctx             context.Context
	cancel          context.CancelFunc
	wg              sync.WaitGroup
}

// LoadBalancerConfig contains load balancer configuration
type LoadBalancerConfig struct {
	// Strategy settings
	Strategy              string // "round-robin", "least-conn", "weighted", "latency", "geo"
	WeightUpdateInterval  time.Duration
	
	// Health check settings
	HealthCheckInterval   time.Duration
	HealthCheckTimeout    time.Duration
	UnhealthyThreshold    int
	HealthyThreshold      int
	
	// Latency settings
	LatencyWindowSize     int
	LatencyUpdateInterval time.Duration
	MaxLatency            time.Duration
	
	// Traffic shaping
	MaxRequestsPerSecond  int
	BurstSize             int
	QueueSize             int
	
	// Failover settings
	FailoverEnabled       bool
	FailoverThreshold     float64
	FailbackDelay         time.Duration
	
	// Geographic settings
	GeoRoutingEnabled     bool
	GeoDatabase           string
}

// Region represents a geographic region
type Region struct {
	ID              string
	Name            string
	Location        Location
	Endpoints       []*Endpoint
	Weight          atomic.Uint32
	ActiveConns     atomic.Int64
	TotalRequests   atomic.Uint64
	FailedRequests  atomic.Uint64
	LastHealthCheck atomic.Int64
	Healthy         atomic.Bool
	mu              sync.RWMutex
}

// Location represents geographic coordinates
type Location struct {
	Latitude  float64
	Longitude float64
	Country   string
	City      string
}

// Endpoint represents a service endpoint
type Endpoint struct {
	ID          string
	Address     string
	Port        int
	Weight      atomic.Uint32
	Connections atomic.Int64
	Healthy     atomic.Bool
	Latency     atomic.Uint64 // Nanoseconds
	LastUsed    atomic.Int64
}

// LoadBalancingStrategy defines the load balancing algorithm
type LoadBalancingStrategy interface {
	SelectEndpoint(regions map[string]*Region, clientIP net.IP) (*Region, *Endpoint, error)
	UpdateWeights(regions map[string]*Region)
}

// LoadBalancerMetrics tracks load balancer performance
type LoadBalancerMetrics struct {
	TotalRequests      atomic.Uint64
	SuccessfulRequests atomic.Uint64
	FailedRequests     atomic.Uint64
	Failovers          atomic.Uint64
	AvgLatency         atomic.Uint64 // Nanoseconds
	P95Latency         atomic.Uint64
	P99Latency         atomic.Uint64
}

// NewRegionalLoadBalancer creates a new regional load balancer
func NewRegionalLoadBalancer(logger *zap.Logger, config *LoadBalancerConfig) (*RegionalLoadBalancer, error) {
	if config == nil {
		config = DefaultLoadBalancerConfig()
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	rlb := &RegionalLoadBalancer{
		logger:          logger,
		config:          config,
		regions:         make(map[string]*Region),
		healthMonitor:   NewHealthMonitor(logger, config),
		latencyTracker:  NewLatencyTracker(config.LatencyWindowSize),
		trafficShaper:   NewTrafficShaper(config),
		failoverManager: NewFailoverManager(logger, config),
		metrics:         &LoadBalancerMetrics{},
		ctx:             ctx,
		cancel:          cancel,
	}
	
	// Initialize strategy
	switch config.Strategy {
	case "round-robin":
		rlb.strategy = NewRoundRobinStrategy()
	case "least-conn":
		rlb.strategy = NewLeastConnectionStrategy()
	case "weighted":
		rlb.strategy = NewWeightedStrategy()
	case "latency":
		rlb.strategy = NewLatencyBasedStrategy()
	case "geo":
		rlb.strategy = NewGeographicStrategy(config.GeoDatabase)
	default:
		rlb.strategy = NewRoundRobinStrategy()
	}
	
	return rlb, nil
}

// Start starts the load balancer
func (rlb *RegionalLoadBalancer) Start() error {
	rlb.logger.Info("Starting regional load balancer",
		zap.String("strategy", rlb.config.Strategy),
		zap.Bool("geo_routing", rlb.config.GeoRoutingEnabled),
		zap.Bool("failover", rlb.config.FailoverEnabled),
	)
	
	// Start background workers
	rlb.wg.Add(1)
	go rlb.healthCheckLoop()
	
	rlb.wg.Add(1)
	go rlb.metricsLoop()
	
	rlb.wg.Add(1)
	go rlb.weightUpdateLoop()
	
	if rlb.config.FailoverEnabled {
		rlb.wg.Add(1)
		go rlb.failoverLoop()
	}
	
	return nil
}

// Stop stops the load balancer
func (rlb *RegionalLoadBalancer) Stop() error {
	rlb.logger.Info("Stopping regional load balancer")
	
	rlb.cancel()
	rlb.wg.Wait()
	
	return nil
}

// AddRegion adds a new region
func (rlb *RegionalLoadBalancer) AddRegion(region *Region) error {
	rlb.regionsMu.Lock()
	defer rlb.regionsMu.Unlock()
	
	if _, exists := rlb.regions[region.ID]; exists {
		return fmt.Errorf("region %s already exists", region.ID)
	}
	
	rlb.regions[region.ID] = region
	region.Weight.Store(100) // Default weight
	region.Healthy.Store(true)
	
	rlb.logger.Info("Added region",
		zap.String("id", region.ID),
		zap.String("name", region.Name),
		zap.Int("endpoints", len(region.Endpoints)),
	)
	
	return nil
}

// RemoveRegion removes a region
func (rlb *RegionalLoadBalancer) RemoveRegion(regionID string) error {
	rlb.regionsMu.Lock()
	defer rlb.regionsMu.Unlock()
	
	if _, exists := rlb.regions[regionID]; !exists {
		return fmt.Errorf("region %s not found", regionID)
	}
	
	delete(rlb.regions, regionID)
	return nil
}

// Route routes a request to the best endpoint
func (rlb *RegionalLoadBalancer) Route(ctx context.Context, clientIP net.IP) (*Endpoint, error) {
	// Apply traffic shaping
	if !rlb.trafficShaper.Allow() {
		return nil, fmt.Errorf("rate limit exceeded")
	}
	
	rlb.metrics.TotalRequests.Add(1)
	
	// Get regions snapshot
	rlb.regionsMu.RLock()
	regions := make(map[string]*Region)
	for k, v := range rlb.regions {
		regions[k] = v
	}
	rlb.regionsMu.RUnlock()
	
	// Select endpoint using strategy
	region, endpoint, err := rlb.strategy.SelectEndpoint(regions, clientIP)
	if err != nil {
		rlb.metrics.FailedRequests.Add(1)
		
		// Try failover if enabled
		if rlb.config.FailoverEnabled {
			region, endpoint, err = rlb.failoverManager.GetFailoverEndpoint(regions)
			if err != nil {
				return nil, err
			}
			rlb.metrics.Failovers.Add(1)
		}
	}
	
	// Update metrics
	region.ActiveConns.Add(1)
	region.TotalRequests.Add(1)
	endpoint.Connections.Add(1)
	endpoint.LastUsed.Store(time.Now().UnixNano())
	
	rlb.metrics.SuccessfulRequests.Add(1)
	
	return endpoint, nil
}

// ReleaseEndpoint releases an endpoint after use
func (rlb *RegionalLoadBalancer) ReleaseEndpoint(endpoint *Endpoint, success bool, latency time.Duration) {
	endpoint.Connections.Add(-1)
	
	// Update latency metrics
	if success {
		rlb.latencyTracker.Record(endpoint.ID, latency)
		endpoint.Latency.Store(uint64(latency.Nanoseconds()))
		
		// Update global latency metrics
		rlb.updateLatencyMetrics(latency)
	} else {
		// Find and update region failure count
		rlb.regionsMu.RLock()
		for _, region := range rlb.regions {
			for _, ep := range region.Endpoints {
				if ep.ID == endpoint.ID {
					region.FailedRequests.Add(1)
					break
				}
			}
		}
		rlb.regionsMu.RUnlock()
	}
}

// GetMetrics returns current metrics
func (rlb *RegionalLoadBalancer) GetMetrics() LoadBalancerStats {
	totalReqs := rlb.metrics.TotalRequests.Load()
	successReqs := rlb.metrics.SuccessfulRequests.Load()
	
	successRate := float64(0)
	if totalReqs > 0 {
		successRate = float64(successReqs) / float64(totalReqs)
	}
	
	return LoadBalancerStats{
		TotalRequests:      totalReqs,
		SuccessfulRequests: successReqs,
		FailedRequests:     rlb.metrics.FailedRequests.Load(),
		Failovers:          rlb.metrics.Failovers.Load(),
		SuccessRate:        successRate,
		AvgLatency:         time.Duration(rlb.metrics.AvgLatency.Load()),
		P95Latency:         time.Duration(rlb.metrics.P95Latency.Load()),
		P99Latency:         time.Duration(rlb.metrics.P99Latency.Load()),
		Regions:            rlb.getRegionStats(),
	}
}

// Private methods

func (rlb *RegionalLoadBalancer) healthCheckLoop() {
	defer rlb.wg.Done()
	
	ticker := time.NewTicker(rlb.config.HealthCheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			rlb.performHealthChecks()
			
		case <-rlb.ctx.Done():
			return
		}
	}
}

func (rlb *RegionalLoadBalancer) performHealthChecks() {
	rlb.regionsMu.RLock()
	regions := make([]*Region, 0, len(rlb.regions))
	for _, r := range rlb.regions {
		regions = append(regions, r)
	}
	rlb.regionsMu.RUnlock()
	
	// Check each region in parallel
	var wg sync.WaitGroup
	for _, region := range regions {
		wg.Add(1)
		go func(r *Region) {
			defer wg.Done()
			rlb.checkRegionHealth(r)
		}(region)
	}
	wg.Wait()
}

func (rlb *RegionalLoadBalancer) checkRegionHealth(region *Region) {
	healthyEndpoints := 0
	
	for _, endpoint := range region.Endpoints {
		if rlb.healthMonitor.CheckEndpoint(endpoint) {
			healthyEndpoints++
			endpoint.Healthy.Store(true)
		} else {
			endpoint.Healthy.Store(false)
		}
	}
	
	// Update region health
	region.LastHealthCheck.Store(time.Now().UnixNano())
	if healthyEndpoints > 0 {
		region.Healthy.Store(true)
	} else {
		region.Healthy.Store(false)
		rlb.logger.Warn("Region unhealthy",
			zap.String("region", region.ID),
			zap.Int("healthy_endpoints", healthyEndpoints),
		)
	}
}

func (rlb *RegionalLoadBalancer) metricsLoop() {
	defer rlb.wg.Done()
	
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			stats := rlb.GetMetrics()
			rlb.logger.Info("Load balancer metrics",
				zap.Uint64("total_requests", stats.TotalRequests),
				zap.Float64("success_rate", stats.SuccessRate),
				zap.Duration("avg_latency", stats.AvgLatency),
				zap.Uint64("failovers", stats.Failovers),
			)
			
		case <-rlb.ctx.Done():
			return
		}
	}
}

func (rlb *RegionalLoadBalancer) weightUpdateLoop() {
	defer rlb.wg.Done()
	
	ticker := time.NewTicker(rlb.config.WeightUpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			rlb.updateWeights()
			
		case <-rlb.ctx.Done():
			return
		}
	}
}

func (rlb *RegionalLoadBalancer) updateWeights() {
	rlb.regionsMu.RLock()
	regions := make(map[string]*Region)
	for k, v := range rlb.regions {
		regions[k] = v
	}
	rlb.regionsMu.RUnlock()
	
	// Update weights based on strategy
	rlb.strategy.UpdateWeights(regions)
	
	// Calculate weights based on performance
	for _, region := range regions {
		rlb.updateRegionWeight(region)
	}
}

func (rlb *RegionalLoadBalancer) updateRegionWeight(region *Region) {
	totalReqs := region.TotalRequests.Load()
	failedReqs := region.FailedRequests.Load()
	
	if totalReqs == 0 {
		return
	}
	
	// Calculate success rate
	successRate := float64(totalReqs-failedReqs) / float64(totalReqs)
	
	// Calculate average latency
	avgLatency := rlb.calculateRegionLatency(region)
	
	// Weight formula: success_rate * (1 / (1 + latency_seconds))
	latencyFactor := 1.0 / (1.0 + avgLatency.Seconds())
	weight := uint32(successRate * latencyFactor * 100)
	
	// Ensure minimum weight for healthy regions
	if region.Healthy.Load() && weight < 10 {
		weight = 10
	}
	
	region.Weight.Store(weight)
}

func (rlb *RegionalLoadBalancer) calculateRegionLatency(region *Region) time.Duration {
	totalLatency := uint64(0)
	count := 0
	
	for _, endpoint := range region.Endpoints {
		if endpoint.Healthy.Load() {
			latency := endpoint.Latency.Load()
			if latency > 0 {
				totalLatency += latency
				count++
			}
		}
	}
	
	if count == 0 {
		return 100 * time.Millisecond // Default
	}
	
	return time.Duration(totalLatency / uint64(count))
}

func (rlb *RegionalLoadBalancer) failoverLoop() {
	defer rlb.wg.Done()
	
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			rlb.checkFailoverConditions()
			
		case <-rlb.ctx.Done():
			return
		}
	}
}

func (rlb *RegionalLoadBalancer) checkFailoverConditions() {
	rlb.regionsMu.RLock()
	defer rlb.regionsMu.RUnlock()
	
	for _, region := range rlb.regions {
		if !region.Healthy.Load() {
			continue
		}
		
		totalReqs := region.TotalRequests.Load()
		failedReqs := region.FailedRequests.Load()
		
		if totalReqs > 100 { // Minimum requests for evaluation
			failureRate := float64(failedReqs) / float64(totalReqs)
			if failureRate > rlb.config.FailoverThreshold {
				rlb.failoverManager.TriggerFailover(region)
			}
		}
	}
}

func (rlb *RegionalLoadBalancer) updateLatencyMetrics(latency time.Duration) {
	latencyNanos := uint64(latency.Nanoseconds())
	
	// Update average
	current := rlb.metrics.AvgLatency.Load()
	if current == 0 {
		rlb.metrics.AvgLatency.Store(latencyNanos)
	} else {
		newAvg := (current*9 + latencyNanos) / 10
		rlb.metrics.AvgLatency.Store(newAvg)
	}
	
	// Update percentiles (simplified)
	rlb.metrics.P95Latency.Store(latencyNanos * 2)
	rlb.metrics.P99Latency.Store(latencyNanos * 3)
}

func (rlb *RegionalLoadBalancer) getRegionStats() []RegionStats {
	rlb.regionsMu.RLock()
	defer rlb.regionsMu.RUnlock()
	
	stats := make([]RegionStats, 0, len(rlb.regions))
	for _, region := range rlb.regions {
		totalReqs := region.TotalRequests.Load()
		failedReqs := region.FailedRequests.Load()
		
		successRate := float64(0)
		if totalReqs > 0 {
			successRate = float64(totalReqs-failedReqs) / float64(totalReqs)
		}
		
		stats = append(stats, RegionStats{
			ID:              region.ID,
			Name:            region.Name,
			Healthy:         region.Healthy.Load(),
			Weight:          region.Weight.Load(),
			ActiveConns:     region.ActiveConns.Load(),
			TotalRequests:   totalReqs,
			FailedRequests:  failedReqs,
			SuccessRate:     successRate,
			HealthyEndpoints: rlb.countHealthyEndpoints(region),
			TotalEndpoints:  len(region.Endpoints),
		})
	}
	
	return stats
}

func (rlb *RegionalLoadBalancer) countHealthyEndpoints(region *Region) int {
	count := 0
	for _, endpoint := range region.Endpoints {
		if endpoint.Healthy.Load() {
			count++
		}
	}
	return count
}

// Helper components

// HealthMonitor monitors endpoint health
type HealthMonitor struct {
	logger        *zap.Logger
	config        *LoadBalancerConfig
	healthHistory map[string]*HealthHistory
	mu            sync.RWMutex
}

type HealthHistory struct {
	Checks       []HealthCheck
	Consecutive  int
	LastCheck    time.Time
}

type HealthCheck struct {
	Timestamp time.Time
	Healthy   bool
	Latency   time.Duration
}

func NewHealthMonitor(logger *zap.Logger, config *LoadBalancerConfig) *HealthMonitor {
	return &HealthMonitor{
		logger:        logger,
		config:        config,
		healthHistory: make(map[string]*HealthHistory),
	}
}

func (hm *HealthMonitor) CheckEndpoint(endpoint *Endpoint) bool {
	ctx, cancel := context.WithTimeout(context.Background(), hm.config.HealthCheckTimeout)
	defer cancel()
	
	start := time.Now()
	
	// Perform health check (simplified - would do actual TCP/HTTP check)
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", endpoint.Address, endpoint.Port), hm.config.HealthCheckTimeout)
	if err != nil {
		hm.recordHealthCheck(endpoint.ID, false, time.Since(start))
		return false
	}
	conn.Close()
	
	hm.recordHealthCheck(endpoint.ID, true, time.Since(start))
	return true
}

func (hm *HealthMonitor) recordHealthCheck(endpointID string, healthy bool, latency time.Duration) {
	hm.mu.Lock()
	defer hm.mu.Unlock()
	
	history, exists := hm.healthHistory[endpointID]
	if !exists {
		history = &HealthHistory{
			Checks: make([]HealthCheck, 0, 100),
		}
		hm.healthHistory[endpointID] = history
	}
	
	check := HealthCheck{
		Timestamp: time.Now(),
		Healthy:   healthy,
		Latency:   latency,
	}
	
	history.Checks = append(history.Checks, check)
	if len(history.Checks) > 100 {
		history.Checks = history.Checks[50:]
	}
	
	history.LastCheck = check.Timestamp
	
	// Update consecutive count
	if healthy {
		if history.Consecutive < 0 {
			history.Consecutive = 1
		} else {
			history.Consecutive++
		}
	} else {
		if history.Consecutive > 0 {
			history.Consecutive = -1
		} else {
			history.Consecutive--
		}
	}
}

// LatencyTracker tracks endpoint latencies
type LatencyTracker struct {
	windowSize int
	latencies  map[string]*LatencyWindow
	mu         sync.RWMutex
}

type LatencyWindow struct {
	Values []time.Duration
	Index  int
}

func NewLatencyTracker(windowSize int) *LatencyTracker {
	return &LatencyTracker{
		windowSize: windowSize,
		latencies:  make(map[string]*LatencyWindow),
	}
}

func (lt *LatencyTracker) Record(endpointID string, latency time.Duration) {
	lt.mu.Lock()
	defer lt.mu.Unlock()
	
	window, exists := lt.latencies[endpointID]
	if !exists {
		window = &LatencyWindow{
			Values: make([]time.Duration, lt.windowSize),
			Index:  0,
		}
		lt.latencies[endpointID] = window
	}
	
	window.Values[window.Index] = latency
	window.Index = (window.Index + 1) % lt.windowSize
}

func (lt *LatencyTracker) GetAverage(endpointID string) time.Duration {
	lt.mu.RLock()
	defer lt.mu.RUnlock()
	
	window, exists := lt.latencies[endpointID]
	if !exists {
		return 100 * time.Millisecond
	}
	
	total := time.Duration(0)
	count := 0
	for _, lat := range window.Values {
		if lat > 0 {
			total += lat
			count++
		}
	}
	
	if count == 0 {
		return 100 * time.Millisecond
	}
	
	return total / time.Duration(count)
}

// TrafficShaper implements rate limiting
type TrafficShaper struct {
	config       *LoadBalancerConfig
	requestRate  atomic.Uint64
	lastReset    atomic.Int64
	queue        chan struct{}
}

func NewTrafficShaper(config *LoadBalancerConfig) *TrafficShaper {
	return &TrafficShaper{
		config: config,
		queue:  make(chan struct{}, config.QueueSize),
	}
}

func (ts *TrafficShaper) Allow() bool {
	// Simple token bucket implementation
	now := time.Now().UnixNano()
	lastReset := ts.lastReset.Load()
	
	// Reset counter every second
	if now-lastReset > int64(time.Second) {
		ts.requestRate.Store(0)
		ts.lastReset.Store(now)
	}
	
	current := ts.requestRate.Add(1)
	if current > uint64(ts.config.MaxRequestsPerSecond) {
		ts.requestRate.Add(-1)
		return false
	}
	
	return true
}

// FailoverManager manages failover operations
type FailoverManager struct {
	logger        *zap.Logger
	config        *LoadBalancerConfig
	failedRegions map[string]time.Time
	mu            sync.RWMutex
}

func NewFailoverManager(logger *zap.Logger, config *LoadBalancerConfig) *FailoverManager {
	return &FailoverManager{
		logger:        logger,
		config:        config,
		failedRegions: make(map[string]time.Time),
	}
}

func (fm *FailoverManager) TriggerFailover(region *Region) {
	fm.mu.Lock()
	defer fm.mu.Unlock()
	
	fm.failedRegions[region.ID] = time.Now()
	region.Healthy.Store(false)
	
	fm.logger.Warn("Triggered failover for region",
		zap.String("region", region.ID),
		zap.String("name", region.Name),
	)
}

func (fm *FailoverManager) GetFailoverEndpoint(regions map[string]*Region) (*Region, *Endpoint, error) {
	fm.mu.RLock()
	defer fm.mu.RUnlock()
	
	// Find healthy region with lowest latency
	var bestRegion *Region
	var bestEndpoint *Endpoint
	lowestLatency := time.Duration(math.MaxInt64)
	
	for _, region := range regions {
		// Skip failed regions still in cooldown
		if failTime, failed := fm.failedRegions[region.ID]; failed {
			if time.Since(failTime) < fm.config.FailbackDelay {
				continue
			}
		}
		
		if !region.Healthy.Load() {
			continue
		}
		
		for _, endpoint := range region.Endpoints {
			if endpoint.Healthy.Load() {
				latency := time.Duration(endpoint.Latency.Load())
				if latency < lowestLatency {
					lowestLatency = latency
					bestRegion = region
					bestEndpoint = endpoint
				}
			}
		}
	}
	
	if bestEndpoint == nil {
		return nil, nil, fmt.Errorf("no healthy endpoints available")
	}
	
	return bestRegion, bestEndpoint, nil
}

// Load balancing strategies

// RoundRobinStrategy implements round-robin load balancing
type RoundRobinStrategy struct {
	counters map[string]*atomic.Uint64
	mu       sync.RWMutex
}

func NewRoundRobinStrategy() *RoundRobinStrategy {
	return &RoundRobinStrategy{
		counters: make(map[string]*atomic.Uint64),
	}
}

func (rr *RoundRobinStrategy) SelectEndpoint(regions map[string]*Region, clientIP net.IP) (*Region, *Endpoint, error) {
	// Find all healthy endpoints
	var healthyEndpoints []*struct {
		Region   *Region
		Endpoint *Endpoint
	}
	
	for _, region := range regions {
		if !region.Healthy.Load() {
			continue
		}
		
		for _, endpoint := range region.Endpoints {
			if endpoint.Healthy.Load() {
				healthyEndpoints = append(healthyEndpoints, &struct {
					Region   *Region
					Endpoint *Endpoint
				}{region, endpoint})
			}
		}
	}
	
	if len(healthyEndpoints) == 0 {
		return nil, nil, fmt.Errorf("no healthy endpoints")
	}
	
	// Get or create counter
	rr.mu.Lock()
	counter, exists := rr.counters["global"]
	if !exists {
		counter = &atomic.Uint64{}
		rr.counters["global"] = counter
	}
	rr.mu.Unlock()
	
	// Select next endpoint
	index := counter.Add(1) % uint64(len(healthyEndpoints))
	selected := healthyEndpoints[index]
	
	return selected.Region, selected.Endpoint, nil
}

func (rr *RoundRobinStrategy) UpdateWeights(regions map[string]*Region) {
	// Round-robin doesn't use weights
}

// LeastConnectionStrategy selects endpoint with least connections
type LeastConnectionStrategy struct{}

func NewLeastConnectionStrategy() *LeastConnectionStrategy {
	return &LeastConnectionStrategy{}
}

func (lc *LeastConnectionStrategy) SelectEndpoint(regions map[string]*Region, clientIP net.IP) (*Region, *Endpoint, error) {
	var selectedRegion *Region
	var selectedEndpoint *Endpoint
	minConnections := int64(math.MaxInt64)
	
	for _, region := range regions {
		if !region.Healthy.Load() {
			continue
		}
		
		for _, endpoint := range region.Endpoints {
			if endpoint.Healthy.Load() {
				conns := endpoint.Connections.Load()
				if conns < minConnections {
					minConnections = conns
					selectedRegion = region
					selectedEndpoint = endpoint
				}
			}
		}
	}
	
	if selectedEndpoint == nil {
		return nil, nil, fmt.Errorf("no healthy endpoints")
	}
	
	return selectedRegion, selectedEndpoint, nil
}

func (lc *LeastConnectionStrategy) UpdateWeights(regions map[string]*Region) {
	// Least connection doesn't use weights
}

// WeightedStrategy implements weighted load balancing
type WeightedStrategy struct {
	random *sync.Pool
}

func NewWeightedStrategy() *WeightedStrategy {
	return &WeightedStrategy{
		random: &sync.Pool{
			New: func() interface{} {
				return &struct{ r uint64 }{r: uint64(time.Now().UnixNano())}
			},
		},
	}
}

func (ws *WeightedStrategy) SelectEndpoint(regions map[string]*Region, clientIP net.IP) (*Region, *Endpoint, error) {
	// Calculate total weight
	totalWeight := uint32(0)
	var weightedEndpoints []*struct {
		Region   *Region
		Endpoint *Endpoint
		Weight   uint32
	}
	
	for _, region := range regions {
		if !region.Healthy.Load() {
			continue
		}
		
		regionWeight := region.Weight.Load()
		for _, endpoint := range region.Endpoints {
			if endpoint.Healthy.Load() {
				endpointWeight := endpoint.Weight.Load()
				combinedWeight := (regionWeight * endpointWeight) / 100
				totalWeight += combinedWeight
				
				weightedEndpoints = append(weightedEndpoints, &struct {
					Region   *Region
					Endpoint *Endpoint
					Weight   uint32
				}{region, endpoint, combinedWeight})
			}
		}
	}
	
	if len(weightedEndpoints) == 0 {
		return nil, nil, fmt.Errorf("no healthy endpoints")
	}
	
	// Select based on weight
	randGen := ws.random.Get().(*struct{ r uint64 })
	defer ws.random.Put(randGen)
	
	// Simple LCG for random number
	randGen.r = randGen.r*1103515245 + 12345
	selection := uint32(randGen.r % uint64(totalWeight))
	
	current := uint32(0)
	for _, we := range weightedEndpoints {
		current += we.Weight
		if selection < current {
			return we.Region, we.Endpoint, nil
		}
	}
	
	// Fallback to last endpoint
	last := weightedEndpoints[len(weightedEndpoints)-1]
	return last.Region, last.Endpoint, nil
}

func (ws *WeightedStrategy) UpdateWeights(regions map[string]*Region) {
	// Weights are updated by the main load balancer
}

// LatencyBasedStrategy selects endpoint with lowest latency
type LatencyBasedStrategy struct{}

func NewLatencyBasedStrategy() *LatencyBasedStrategy {
	return &LatencyBasedStrategy{}
}

func (lb *LatencyBasedStrategy) SelectEndpoint(regions map[string]*Region, clientIP net.IP) (*Region, *Endpoint, error) {
	var selectedRegion *Region
	var selectedEndpoint *Endpoint
	lowestLatency := uint64(math.MaxUint64)
	
	for _, region := range regions {
		if !region.Healthy.Load() {
			continue
		}
		
		for _, endpoint := range region.Endpoints {
			if endpoint.Healthy.Load() {
				latency := endpoint.Latency.Load()
				if latency < lowestLatency && latency > 0 {
					lowestLatency = latency
					selectedRegion = region
					selectedEndpoint = endpoint
				}
			}
		}
	}
	
	if selectedEndpoint == nil {
		return nil, nil, fmt.Errorf("no healthy endpoints")
	}
	
	return selectedRegion, selectedEndpoint, nil
}

func (lb *LatencyBasedStrategy) UpdateWeights(regions map[string]*Region) {
	// Latency-based doesn't use weights
}

// GeographicStrategy routes based on client location
type GeographicStrategy struct {
	geoDatabase string
	// In production, would use MaxMind or similar
}

func NewGeographicStrategy(geoDatabase string) *GeographicStrategy {
	return &GeographicStrategy{
		geoDatabase: geoDatabase,
	}
}

func (gs *GeographicStrategy) SelectEndpoint(regions map[string]*Region, clientIP net.IP) (*Region, *Endpoint, error) {
	// Get client location (simplified)
	clientLat, clientLon := gs.getClientLocation(clientIP)
	
	var selectedRegion *Region
	var selectedEndpoint *Endpoint
	shortestDistance := math.MaxFloat64
	
	for _, region := range regions {
		if !region.Healthy.Load() {
			continue
		}
		
		// Calculate distance to region
		distance := gs.calculateDistance(clientLat, clientLon, region.Location.Latitude, region.Location.Longitude)
		
		if distance < shortestDistance {
			// Find healthy endpoint in this region
			for _, endpoint := range region.Endpoints {
				if endpoint.Healthy.Load() {
					shortestDistance = distance
					selectedRegion = region
					selectedEndpoint = endpoint
					break
				}
			}
		}
	}
	
	if selectedEndpoint == nil {
		return nil, nil, fmt.Errorf("no healthy endpoints")
	}
	
	return selectedRegion, selectedEndpoint, nil
}

func (gs *GeographicStrategy) UpdateWeights(regions map[string]*Region) {
	// Geographic strategy doesn't use weights
}

func (gs *GeographicStrategy) getClientLocation(ip net.IP) (float64, float64) {
	// Simplified - would use GeoIP database
	return 37.7749, -122.4194 // San Francisco
}

func (gs *GeographicStrategy) calculateDistance(lat1, lon1, lat2, lon2 float64) float64 {
	// Haversine formula
	const R = 6371 // Earth radius in km
	
	dLat := (lat2 - lat1) * math.Pi / 180
	dLon := (lon2 - lon1) * math.Pi / 180
	
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*
		math.Sin(dLon/2)*math.Sin(dLon/2)
	
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	
	return R * c
}

// Helper structures

type LoadBalancerStats struct {
	TotalRequests      uint64
	SuccessfulRequests uint64
	FailedRequests     uint64
	Failovers          uint64
	SuccessRate        float64
	AvgLatency         time.Duration
	P95Latency         time.Duration
	P99Latency         time.Duration
	Regions            []RegionStats
}

type RegionStats struct {
	ID               string
	Name             string
	Healthy          bool
	Weight           uint32
	ActiveConns      int64
	TotalRequests    uint64
	FailedRequests   uint64
	SuccessRate      float64
	HealthyEndpoints int
	TotalEndpoints   int
}

// DefaultLoadBalancerConfig returns default configuration
func DefaultLoadBalancerConfig() *LoadBalancerConfig {
	return &LoadBalancerConfig{
		Strategy:              "weighted",
		WeightUpdateInterval:  30 * time.Second,
		HealthCheckInterval:   10 * time.Second,
		HealthCheckTimeout:    5 * time.Second,
		UnhealthyThreshold:    3,
		HealthyThreshold:      2,
		LatencyWindowSize:     100,
		LatencyUpdateInterval: 5 * time.Second,
		MaxLatency:            5 * time.Second,
		MaxRequestsPerSecond:  10000,
		BurstSize:             1000,
		QueueSize:             10000,
		FailoverEnabled:       true,
		FailoverThreshold:     0.5,
		FailbackDelay:         5 * time.Minute,
		GeoRoutingEnabled:     false,
		GeoDatabase:           "/var/lib/geoip/GeoLite2-City.mmdb",
	}
}