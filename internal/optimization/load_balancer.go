package optimization

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// LoadBalancer distributes work across multiple backends
type LoadBalancer struct {
	logger    *zap.Logger
	algorithm Algorithm
	backends  []*Backend
	health    *HealthChecker
	metrics   *LoadBalancerMetrics
	mu        sync.RWMutex
}

// Backend represents a backend server
type Backend struct {
	ID          string
	Address     string
	Weight      int
	MaxConns    int
	Active      atomic.Bool
	Connections atomic.Int32
	LastUsed    atomic.Int64
	TotalReqs   atomic.Uint64
	FailedReqs  atomic.Uint64
	AvgLatency  atomic.Int64 // microseconds
	Score       atomic.Value  // float64
}

// Algorithm defines load balancing algorithm
type Algorithm interface {
	SelectBackend(backends []*Backend) (*Backend, error)
	Name() string
}

// LoadBalancerConfig contains load balancer configuration
type LoadBalancerConfig struct {
	Algorithm           string
	HealthCheckInterval time.Duration
	HealthCheckTimeout  time.Duration
	MaxRetries          int
	FailureThreshold    int
	RecoveryThreshold   int
}

// LoadBalancerMetrics tracks load balancer performance
type LoadBalancerMetrics struct {
	TotalRequests      atomic.Uint64
	SuccessfulRequests atomic.Uint64
	FailedRequests     atomic.Uint64
	RetryCount         atomic.Uint64
	BackendSwitches    atomic.Uint64
	AvgResponseTime    atomic.Int64 // microseconds
}

// NewLoadBalancer creates a new load balancer
func NewLoadBalancer(logger *zap.Logger, config LoadBalancerConfig) *LoadBalancer {
	lb := &LoadBalancer{
		logger:  logger,
		metrics: &LoadBalancerMetrics{},
	}

	// Select algorithm
	switch config.Algorithm {
	case "round-robin":
		lb.algorithm = NewRoundRobinAlgorithm()
	case "least-connections":
		lb.algorithm = NewLeastConnectionsAlgorithm()
	case "weighted-round-robin":
		lb.algorithm = NewWeightedRoundRobinAlgorithm()
	case "ip-hash":
		lb.algorithm = NewIPHashAlgorithm()
	case "adaptive":
		lb.algorithm = NewAdaptiveAlgorithm()
	default:
		lb.algorithm = NewRoundRobinAlgorithm()
	}

	// Initialize health checker
	lb.health = NewHealthChecker(logger, config)

	return lb
}

// AddBackend adds a new backend
func (lb *LoadBalancer) AddBackend(backend *Backend) {
	lb.mu.Lock()
	defer lb.mu.Unlock()

	backend.Active.Store(true)
	backend.Score.Store(1.0)
	lb.backends = append(lb.backends, backend)

	lb.logger.Info("Added backend",
		zap.String("id", backend.ID),
		zap.String("address", backend.Address),
	)
}

// RemoveBackend removes a backend
func (lb *LoadBalancer) RemoveBackend(id string) error {
	lb.mu.Lock()
	defer lb.mu.Unlock()

	for i, backend := range lb.backends {
		if backend.ID == id {
			lb.backends = append(lb.backends[:i], lb.backends[i+1:]...)
			return nil
		}
	}

	return fmt.Errorf("backend %s not found", id)
}

// SelectBackend selects a backend for the request
func (lb *LoadBalancer) SelectBackend(ctx context.Context) (*Backend, error) {
	lb.metrics.TotalRequests.Add(1)

	lb.mu.RLock()
	activeBackends := lb.getActiveBackends()
	lb.mu.RUnlock()

	if len(activeBackends) == 0 {
		lb.metrics.FailedRequests.Add(1)
		return nil, errors.New("no active backends available")
	}

	// Try to select backend with retries
	var lastErr error
	for i := 0; i < 3; i++ { // Max 3 attempts
		backend, err := lb.algorithm.SelectBackend(activeBackends)
		if err != nil {
			lastErr = err
			lb.metrics.RetryCount.Add(1)
			continue
		}

		// Check if backend can accept more connections
		if backend.MaxConns > 0 && int(backend.Connections.Load()) >= backend.MaxConns {
			lastErr = errors.New("backend at max connections")
			lb.metrics.RetryCount.Add(1)
			continue
		}

		backend.Connections.Add(1)
		backend.LastUsed.Store(time.Now().Unix())
		backend.TotalReqs.Add(1)
		lb.metrics.SuccessfulRequests.Add(1)

		return backend, nil
	}

	lb.metrics.FailedRequests.Add(1)
	return nil, lastErr
}

// ReleaseBackend releases a backend connection
func (lb *LoadBalancer) ReleaseBackend(backend *Backend, success bool, latency time.Duration) {
	backend.Connections.Add(-1)

	if !success {
		backend.FailedReqs.Add(1)
	}

	// Update average latency (exponential moving average)
	currentAvg := backend.AvgLatency.Load()
	newLatency := latency.Microseconds()
	alpha := 0.2 // Smoothing factor
	
	newAvg := int64(alpha*float64(newLatency) + (1-alpha)*float64(currentAvg))
	backend.AvgLatency.Store(newAvg)

	// Update backend score for adaptive algorithm
	lb.updateBackendScore(backend)
}

// Start starts the load balancer
func (lb *LoadBalancer) Start(ctx context.Context) {
	// Start health checker
	go lb.health.Start(ctx, lb.backends)

	// Start metrics reporter
	go lb.reportMetrics(ctx)
}

// getActiveBackends returns list of active backends
func (lb *LoadBalancer) getActiveBackends() []*Backend {
	var active []*Backend
	for _, backend := range lb.backends {
		if backend.Active.Load() {
			active = append(active, backend)
		}
	}
	return active
}

// updateBackendScore updates backend score for adaptive algorithm
func (lb *LoadBalancer) updateBackendScore(backend *Backend) {
	totalReqs := backend.TotalReqs.Load()
	if totalReqs == 0 {
		return
	}

	failedReqs := backend.FailedReqs.Load()
	successRate := 1.0 - float64(failedReqs)/float64(totalReqs)
	
	avgLatency := backend.AvgLatency.Load()
	latencyScore := 1.0 / (1.0 + float64(avgLatency)/1000000.0) // Convert to seconds

	connUtil := float64(backend.Connections.Load()) / float64(backend.MaxConns)
	utilizationScore := 1.0 - connUtil

	// Combined score with weights
	score := successRate*0.5 + latencyScore*0.3 + utilizationScore*0.2
	backend.Score.Store(score)
}

// reportMetrics periodically reports metrics
func (lb *LoadBalancer) reportMetrics(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			lb.logger.Info("Load balancer metrics",
				zap.Uint64("total_requests", lb.metrics.TotalRequests.Load()),
				zap.Uint64("successful_requests", lb.metrics.SuccessfulRequests.Load()),
				zap.Uint64("failed_requests", lb.metrics.FailedRequests.Load()),
				zap.Uint64("retry_count", lb.metrics.RetryCount.Load()),
				zap.Int64("avg_response_time_us", lb.metrics.AvgResponseTime.Load()),
			)
		}
	}
}

// Load Balancing Algorithms

// RoundRobinAlgorithm implements round-robin selection
type RoundRobinAlgorithm struct {
	current atomic.Uint64
}

func NewRoundRobinAlgorithm() *RoundRobinAlgorithm {
	return &RoundRobinAlgorithm{}
}

func (rr *RoundRobinAlgorithm) SelectBackend(backends []*Backend) (*Backend, error) {
	if len(backends) == 0 {
		return nil, errors.New("no backends available")
	}

	index := rr.current.Add(1) % uint64(len(backends))
	return backends[index], nil
}

func (rr *RoundRobinAlgorithm) Name() string {
	return "round-robin"
}

// LeastConnectionsAlgorithm selects backend with least connections
type LeastConnectionsAlgorithm struct{}

func NewLeastConnectionsAlgorithm() *LeastConnectionsAlgorithm {
	return &LeastConnectionsAlgorithm{}
}

func (lc *LeastConnectionsAlgorithm) SelectBackend(backends []*Backend) (*Backend, error) {
	if len(backends) == 0 {
		return nil, errors.New("no backends available")
	}

	var selected *Backend
	minConns := int32(math.MaxInt32)

	for _, backend := range backends {
		conns := backend.Connections.Load()
		if conns < minConns {
			minConns = conns
			selected = backend
		}
	}

	return selected, nil
}

func (lc *LeastConnectionsAlgorithm) Name() string {
	return "least-connections"
}

// WeightedRoundRobinAlgorithm implements weighted round-robin
type WeightedRoundRobinAlgorithm struct {
	weights  []int
	current  atomic.Int32
	gcd      int
	maxWeight int
	mu       sync.Mutex
}

func NewWeightedRoundRobinAlgorithm() *WeightedRoundRobinAlgorithm {
	return &WeightedRoundRobinAlgorithm{}
}

func (wrr *WeightedRoundRobinAlgorithm) SelectBackend(backends []*Backend) (*Backend, error) {
	wrr.mu.Lock()
	defer wrr.mu.Unlock()

	if len(backends) == 0 {
		return nil, errors.New("no backends available")
	}

	// Update weights if backends changed
	if len(wrr.weights) != len(backends) {
		wrr.updateWeights(backends)
	}

	// Weighted round-robin selection
	for {
		wrr.current.Add(1)
		index := wrr.current.Load() % int32(len(backends))
		
		if wrr.weights[index] >= wrr.maxWeight {
			return backends[index], nil
		}
	}
}

func (wrr *WeightedRoundRobinAlgorithm) updateWeights(backends []*Backend) {
	wrr.weights = make([]int, len(backends))
	wrr.maxWeight = 0

	for i, backend := range backends {
		wrr.weights[i] = backend.Weight
		if backend.Weight > wrr.maxWeight {
			wrr.maxWeight = backend.Weight
		}
	}
}

func (wrr *WeightedRoundRobinAlgorithm) Name() string {
	return "weighted-round-robin"
}

// IPHashAlgorithm uses client IP for consistent backend selection
type IPHashAlgorithm struct{}

func NewIPHashAlgorithm() *IPHashAlgorithm {
	return &IPHashAlgorithm{}
}

func (ih *IPHashAlgorithm) SelectBackend(backends []*Backend) (*Backend, error) {
	if len(backends) == 0 {
		return nil, errors.New("no backends available")
	}

	// In real implementation, would use client IP
	// For now, use random selection as placeholder
	index := rand.Intn(len(backends))
	return backends[index], nil
}

func (ih *IPHashAlgorithm) Name() string {
	return "ip-hash"
}

// AdaptiveAlgorithm selects based on backend performance
type AdaptiveAlgorithm struct{}

func NewAdaptiveAlgorithm() *AdaptiveAlgorithm {
	return &AdaptiveAlgorithm{}
}

func (aa *AdaptiveAlgorithm) SelectBackend(backends []*Backend) (*Backend, error) {
	if len(backends) == 0 {
		return nil, errors.New("no backends available")
	}

	// Select backend with highest score
	var selected *Backend
	maxScore := 0.0

	for _, backend := range backends {
		score, _ := backend.Score.Load().(float64)
		if score > maxScore {
			maxScore = score
			selected = backend
		}
	}

	if selected == nil {
		// Fallback to first backend
		selected = backends[0]
	}

	return selected, nil
}

func (aa *AdaptiveAlgorithm) Name() string {
	return "adaptive"
}

// HealthChecker monitors backend health
type HealthChecker struct {
	logger            *zap.Logger
	interval          time.Duration
	timeout           time.Duration
	failureThreshold  int
	recoveryThreshold int
	failures          map[string]int
	mu                sync.Mutex
}

func NewHealthChecker(logger *zap.Logger, config LoadBalancerConfig) *HealthChecker {
	return &HealthChecker{
		logger:            logger,
		interval:          config.HealthCheckInterval,
		timeout:           config.HealthCheckTimeout,
		failureThreshold:  config.FailureThreshold,
		recoveryThreshold: config.RecoveryThreshold,
		failures:          make(map[string]int),
	}
}

func (hc *HealthChecker) Start(ctx context.Context, backends []*Backend) {
	ticker := time.NewTicker(hc.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			hc.checkAll(backends)
		}
	}
}

func (hc *HealthChecker) checkAll(backends []*Backend) {
	var wg sync.WaitGroup

	for _, backend := range backends {
		wg.Add(1)
		go func(b *Backend) {
			defer wg.Done()
			hc.checkBackend(b)
		}(backend)
	}

	wg.Wait()
}

func (hc *HealthChecker) checkBackend(backend *Backend) {
	// Simulate health check
	// In real implementation, would make actual health check request
	healthy := rand.Float32() > 0.1 // 90% healthy

	hc.mu.Lock()
	defer hc.mu.Unlock()

	if healthy {
		if !backend.Active.Load() {
			// Check if recovered
			hc.failures[backend.ID]--
			if hc.failures[backend.ID] <= -hc.recoveryThreshold {
				backend.Active.Store(true)
				hc.failures[backend.ID] = 0
				hc.logger.Info("Backend recovered",
					zap.String("id", backend.ID),
				)
			}
		} else {
			hc.failures[backend.ID] = 0
		}
	} else {
		hc.failures[backend.ID]++
		if hc.failures[backend.ID] >= hc.failureThreshold {
			backend.Active.Store(false)
			hc.logger.Warn("Backend marked unhealthy",
				zap.String("id", backend.ID),
				zap.Int("failures", hc.failures[backend.ID]),
			)
		}
	}
}