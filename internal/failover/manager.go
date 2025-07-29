package failover

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// NodeState represents the state of a node
type NodeState int

const (
	NodeStateHealthy NodeState = iota
	NodeStateDegraded
	NodeStateUnhealthy
	NodeStateFailed
)

func (s NodeState) String() string {
	switch s {
	case NodeStateHealthy:
		return "healthy"
	case NodeStateDegraded:
		return "degraded"
	case NodeStateUnhealthy:
		return "unhealthy"
	case NodeStateFailed:
		return "failed"
	default:
		return "unknown"
	}
}

// Node represents a node in the failover system
type Node struct {
	ID              string
	Endpoint        string
	State           atomic.Value // NodeState
	Priority        int
	Weight          int
	HealthCheck     HealthChecker
	LastHealthCheck time.Time
	FailureCount    atomic.Int32
	RequestCount    atomic.Uint64
	ResponseTime    atomic.Value // time.Duration
	Active          atomic.Bool
	mu              sync.RWMutex
}

// HealthChecker interface for health checking
type HealthChecker interface {
	Check(ctx context.Context, endpoint string) error
}

// Config failover configuration
type Config struct {
	CheckInterval    time.Duration `mapstructure:"check_interval"`
	FailureThreshold int           `mapstructure:"failure_threshold"`
	RecoveryTime     time.Duration `mapstructure:"recovery_time"`
	RequestTimeout   time.Duration `mapstructure:"request_timeout"`
	MaxRetries       int           `mapstructure:"max_retries"`
	LoadBalancing    string        `mapstructure:"load_balancing"` // "round_robin", "weighted", "least_connections"
}

// Manager manages failover and load balancing
type Manager struct {
	nodes         []*Node
	config        Config
	logger        *zap.Logger
	mu            sync.RWMutex
	running       atomic.Bool
	currentIndex  atomic.Int32
	requestCounts map[string]*atomic.Uint64
}

// NewManager creates a new failover manager
func NewManager(config Config, logger *zap.Logger) *Manager {
	return &Manager{
		config:        config,
		logger:        logger,
		requestCounts: make(map[string]*atomic.Uint64),
	}
}

// AddNode adds a node to the failover manager
func (m *Manager) AddNode(id, endpoint string, priority, weight int, healthChecker HealthChecker) {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	node := &Node{
		ID:          id,
		Endpoint:    endpoint,
		Priority:    priority,
		Weight:      weight,
		HealthCheck: healthChecker,
	}
	
	node.State.Store(NodeStateHealthy)
	node.ResponseTime.Store(time.Duration(0))
	node.Active.Store(true)
	
	m.nodes = append(m.nodes, node)
	m.requestCounts[id] = &atomic.Uint64{}
	
	m.logger.Info("Node added to failover manager",
		zap.String("node_id", id),
		zap.String("endpoint", endpoint),
		zap.Int("priority", priority),
		zap.Int("weight", weight),
	)
}

// Start starts the failover manager
func (m *Manager) Start(ctx context.Context) error {
	if !m.running.CompareAndSwap(false, true) {
		return fmt.Errorf("failover manager already running")
	}
	
	m.logger.Info("Starting failover manager")
	
	// Start health checking goroutine
	go m.healthCheckLoop(ctx)
	
	return nil
}

// Stop stops the failover manager
func (m *Manager) Stop() error {
	if !m.running.CompareAndSwap(true, false) {
		return fmt.Errorf("failover manager not running")
	}
	
	m.logger.Info("Stopping failover manager")
	return nil
}

// GetHealthyNode returns a healthy node based on load balancing strategy
func (m *Manager) GetHealthyNode() (*Node, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	healthyNodes := m.getHealthyNodes()
	if len(healthyNodes) == 0 {
		return nil, fmt.Errorf("no healthy nodes available")
	}
	
	switch m.config.LoadBalancing {
	case "weighted":
		return m.selectWeightedNode(healthyNodes), nil
	case "least_connections":
		return m.selectLeastConnectionsNode(healthyNodes), nil
	default: // "round_robin"
		return m.selectRoundRobinNode(healthyNodes), nil
	}
}

// GetAllNodes returns all nodes
func (m *Manager) GetAllNodes() []*Node {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	nodes := make([]*Node, len(m.nodes))
	copy(nodes, m.nodes)
	return nodes
}

// GetNodeByID returns a node by ID
func (m *Manager) GetNodeByID(id string) *Node {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	for _, node := range m.nodes {
		if node.ID == id {
			return node
		}
	}
	return nil
}

// RecordRequest records a request for a node
func (m *Manager) RecordRequest(nodeID string, duration time.Duration, success bool) {
	node := m.GetNodeByID(nodeID)
	if node == nil {
		return
	}
	
	node.RequestCount.Add(1)
	node.ResponseTime.Store(duration)
	
	if counter, exists := m.requestCounts[nodeID]; exists {
		counter.Add(1)
	}
	
	if !success {
		m.recordFailure(node)
	} else {
		m.recordSuccess(node)
	}
}

// getHealthyNodes returns all healthy nodes
func (m *Manager) getHealthyNodes() []*Node {
	var healthy []*Node
	for _, node := range m.nodes {
		if node.Active.Load() && node.State.Load().(NodeState) == NodeStateHealthy {
			healthy = append(healthy, node)
		}
	}
	return healthy
}

// selectRoundRobinNode selects a node using round-robin
func (m *Manager) selectRoundRobinNode(nodes []*Node) *Node {
	if len(nodes) == 0 {
		return nil
	}
	
	index := m.currentIndex.Add(1) % int32(len(nodes))
	return nodes[index]
}

// selectWeightedNode selects a node using weighted distribution
func (m *Manager) selectWeightedNode(nodes []*Node) *Node {
	if len(nodes) == 0 {
		return nil
	}
	
	totalWeight := 0
	for _, node := range nodes {
		totalWeight += node.Weight
	}
	
	if totalWeight == 0 {
		return m.selectRoundRobinNode(nodes)
	}
	
	// Simple weighted selection
	target := int(time.Now().UnixNano()) % totalWeight
	current := 0
	
	for _, node := range nodes {
		current += node.Weight
		if current > target {
			return node
		}
	}
	
	return nodes[0]
}

// selectLeastConnectionsNode selects the node with least connections
func (m *Manager) selectLeastConnectionsNode(nodes []*Node) *Node {
	if len(nodes) == 0 {
		return nil
	}
	
	var selected *Node
	minConnections := uint64(^uint64(0)) // Max uint64
	
	for _, node := range nodes {
		connections := node.RequestCount.Load()
		if connections < minConnections {
			minConnections = connections
			selected = node
		}
	}
	
	return selected
}

// healthCheckLoop performs periodic health checks
func (m *Manager) healthCheckLoop(ctx context.Context) {
	ticker := time.NewTicker(m.config.CheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.performHealthChecks(ctx)
		}
	}
}

// performHealthChecks checks health of all nodes
func (m *Manager) performHealthChecks(ctx context.Context) {
	m.mu.RLock()
	nodes := make([]*Node, len(m.nodes))
	copy(nodes, m.nodes)
	m.mu.RUnlock()
	
	var wg sync.WaitGroup
	for _, node := range nodes {
		wg.Add(1)
		go func(n *Node) {
			defer wg.Done()
			m.checkNodeHealth(ctx, n)
		}(node)
	}
	wg.Wait()
}

// checkNodeHealth checks the health of a single node
func (m *Manager) checkNodeHealth(ctx context.Context, node *Node) {
	node.mu.Lock()
	defer node.mu.Unlock()
	
	checkCtx, cancel := context.WithTimeout(ctx, m.config.RequestTimeout)
	defer cancel()
	
	start := time.Now()
	err := node.HealthCheck.Check(checkCtx, node.Endpoint)
	duration := time.Since(start)
	
	node.LastHealthCheck = time.Now()
	node.ResponseTime.Store(duration)
	
	if err != nil {
		m.recordFailure(node)
		m.logger.Warn("Node health check failed",
			zap.String("node_id", node.ID),
			zap.String("endpoint", node.Endpoint),
			zap.Error(err),
			zap.Duration("response_time", duration),
		)
	} else {
		m.recordSuccess(node)
		m.logger.Debug("Node health check passed",
			zap.String("node_id", node.ID),
			zap.String("endpoint", node.Endpoint),
			zap.Duration("response_time", duration),
		)
	}
}

// recordFailure records a failure for a node
func (m *Manager) recordFailure(node *Node) {
	failures := node.FailureCount.Add(1)
	currentState := node.State.Load().(NodeState)
	
	var newState NodeState
	switch {
	case failures >= int32(m.config.FailureThreshold):
		newState = NodeStateFailed
		node.Active.Store(false)
	case failures >= int32(m.config.FailureThreshold/2):
		newState = NodeStateUnhealthy
	case failures > 0:
		newState = NodeStateDegraded
	default:
		newState = NodeStateHealthy
	}
	
	if newState != currentState {
		node.State.Store(newState)
		m.logger.Warn("Node state changed",
			zap.String("node_id", node.ID),
			zap.String("old_state", currentState.String()),
			zap.String("new_state", newState.String()),
			zap.Int32("failure_count", failures),
		)
	}
}

// recordSuccess records a success for a node
func (m *Manager) recordSuccess(node *Node) {
	failures := node.FailureCount.Load()
	if failures > 0 {
		// Gradually reduce failure count on success
		node.FailureCount.CompareAndSwap(failures, failures-1)
	}
	
	currentState := node.State.Load().(NodeState)
	if currentState != NodeStateHealthy && failures <= 1 {
		node.State.Store(NodeStateHealthy)
		node.Active.Store(true)
		
		m.logger.Info("Node recovered",
			zap.String("node_id", node.ID),
			zap.String("endpoint", node.Endpoint),
		)
	}
}

// GetStats returns statistics about the failover manager
func (m *Manager) GetStats() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	stats := map[string]interface{}{
		"total_nodes":   len(m.nodes),
		"healthy_nodes": len(m.getHealthyNodes()),
		"load_balancing": m.config.LoadBalancing,
	}
	
	nodeStats := make([]map[string]interface{}, len(m.nodes))
	for i, node := range m.nodes {
		responseTime := time.Duration(0)
		if rt := node.ResponseTime.Load(); rt != nil {
			responseTime = rt.(time.Duration)
		}
		
		nodeStats[i] = map[string]interface{}{
			"id":               node.ID,
			"endpoint":         node.Endpoint,
			"state":            node.State.Load().(NodeState).String(),
			"active":           node.Active.Load(),
			"failure_count":    node.FailureCount.Load(),
			"request_count":    node.RequestCount.Load(),
			"response_time_ms": responseTime.Milliseconds(),
			"priority":         node.Priority,
			"weight":           node.Weight,
		}
	}
	
	stats["nodes"] = nodeStats
	return stats
}