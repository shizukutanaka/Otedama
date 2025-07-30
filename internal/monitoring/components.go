package monitoring

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/otedama/otedama/internal/mining"
	"github.com/otedama/otedama/internal/p2p"
	"github.com/otedama/otedama/internal/stratum"
)

// MiningEngineMonitor monitors the mining engine
type MiningEngineMonitor struct {
	engine     *mining.UnifiedEngine
	
	// Cached stats
	lastHashRate    atomic.Uint64
	lastShareCount  atomic.Uint64
	lastBlockFound  atomic.Int64
	
	// Health state
	lastHealthCheck atomic.Int64
	isHealthy       atomic.Bool
}

// NewMiningEngineMonitor creates a new mining engine monitor
func NewMiningEngineMonitor(engine *mining.UnifiedEngine) *MiningEngineMonitor {
	monitor := &MiningEngineMonitor{
		engine: engine,
	}
	monitor.isHealthy.Store(true)
	return monitor
}

func (m *MiningEngineMonitor) Name() string {
	return "mining_engine"
}

func (m *MiningEngineMonitor) HealthCheck(ctx context.Context) error {
	// Check if engine is running
	stats := m.engine.GetStats()
	if stats == nil {
		return fmt.Errorf("engine not responding")
	}
	
	// Check hash rate
	if stats.CurrentHashRate == 0 && stats.ActiveWorkers > 0 {
		return fmt.Errorf("no hash rate despite active workers")
	}
	
	// Check for stale state
	lastCheck := m.lastHealthCheck.Load()
	now := time.Now().Unix()
	
	if lastCheck > 0 && now-lastCheck > 300 { // 5 minutes
		return fmt.Errorf("health check stale")
	}
	
	m.lastHealthCheck.Store(now)
	m.isHealthy.Store(true)
	
	// Cache stats
	m.lastHashRate.Store(uint64(stats.CurrentHashRate))
	m.lastShareCount.Store(stats.SharesSubmitted)
	
	return nil
}

func (m *MiningEngineMonitor) GetStats() interface{} {
	stats := m.engine.GetStats()
	if stats == nil {
		return nil
	}
	
	return map[string]interface{}{
		"hash_rate":        stats.CurrentHashRate,
		"active_workers":   stats.ActiveWorkers,
		"shares_submitted": stats.SharesSubmitted,
		"shares_accepted":  stats.SharesAccepted,
		"blocks_found":     stats.BlocksFound,
		"uptime":          stats.Uptime.String(),
	}
}

// P2PNetworkMonitor monitors the P2P network
type P2PNetworkMonitor struct {
	network p2p.Network
	
	// Cached stats
	lastPeerCount    atomic.Int32
	lastMessageCount atomic.Uint64
	lastBandwidth    atomic.Uint64
	
	// Health state
	minPeers         int
	isHealthy        atomic.Bool
}

// NewP2PNetworkMonitor creates a new P2P network monitor
func NewP2PNetworkMonitor(network p2p.Network, minPeers int) *P2PNetworkMonitor {
	monitor := &P2PNetworkMonitor{
		network:  network,
		minPeers: minPeers,
	}
	monitor.isHealthy.Store(true)
	return monitor
}

func (n *P2PNetworkMonitor) Name() string {
	return "p2p_network"
}

func (n *P2PNetworkMonitor) HealthCheck(ctx context.Context) error {
	stats := n.network.GetStats()
	if stats == nil {
		return fmt.Errorf("network not responding")
	}
	
	// Check peer count
	peerCount := int(stats.ConnectedPeers.Load())
	if peerCount < n.minPeers {
		return fmt.Errorf("insufficient peers: %d < %d", peerCount, n.minPeers)
	}
	
	// Check if network is active
	messages := stats.TotalMessages.Load()
	lastMessages := n.lastMessageCount.Load()
	
	if messages == lastMessages && peerCount > 0 {
		// No new messages despite having peers
		return fmt.Errorf("network appears stalled")
	}
	
	// Update cached stats
	n.lastPeerCount.Store(int32(peerCount))
	n.lastMessageCount.Store(messages)
	n.lastBandwidth.Store(stats.BytesTransferred.Load())
	n.isHealthy.Store(true)
	
	return nil
}

func (n *P2PNetworkMonitor) GetStats() interface{} {
	stats := n.network.GetStats()
	if stats == nil {
		return nil
	}
	
	return map[string]interface{}{
		"connected_peers":   stats.ConnectedPeers.Load(),
		"total_messages":    stats.TotalMessages.Load(),
		"bytes_transferred": stats.BytesTransferred.Load(),
		"blocks_received":   stats.BlocksReceived.Load(),
		"shares_received":   stats.SharesReceived.Load(),
		"network_latency":   fmt.Sprintf("%dms", stats.NetworkLatency.Load()),
		"uptime":           stats.Uptime.String(),
	}
}

// StratumServerMonitor monitors the Stratum server
type StratumServerMonitor struct {
	server *stratum.SimpleStratumServer
	
	// Health state
	isHealthy atomic.Bool
}

// NewStratumServerMonitor creates a new Stratum server monitor
func NewStratumServerMonitor(server *stratum.SimpleStratumServer) *StratumServerMonitor {
	monitor := &StratumServerMonitor{
		server: server,
	}
	monitor.isHealthy.Store(true)
	return monitor
}

func (s *StratumServerMonitor) Name() string {
	return "stratum_server"
}

func (s *StratumServerMonitor) HealthCheck(ctx context.Context) error {
	stats := s.server.GetStats()
	
	// Check if server is accepting connections
	if stats.ActiveConnections == 0 && stats.TotalConnections > 0 {
		// Had connections but lost them all
		return fmt.Errorf("no active connections")
	}
	
	// Check for high rejection rate
	if stats.SharesReceived > 0 {
		rejectionRate := float64(stats.SharesRejected) / float64(stats.SharesReceived)
		if rejectionRate > 0.5 { // 50% rejection rate
			return fmt.Errorf("high share rejection rate: %.2f%%", rejectionRate*100)
		}
	}
	
	s.isHealthy.Store(true)
	return nil
}

func (s *StratumServerMonitor) GetStats() interface{} {
	stats := s.server.GetStats()
	
	rejectionRate := float64(0)
	if stats.SharesReceived > 0 {
		rejectionRate = float64(stats.SharesRejected) / float64(stats.SharesReceived)
	}
	
	return map[string]interface{}{
		"active_connections": stats.ActiveConnections,
		"total_connections":  stats.TotalConnections,
		"shares_received":    stats.SharesReceived,
		"shares_accepted":    stats.SharesAccepted,
		"shares_rejected":    stats.SharesRejected,
		"rejection_rate":     fmt.Sprintf("%.2f%%", rejectionRate*100),
		"jobs_sent":         stats.JobsSent,
	}
}

// ConnectionPoolMonitor monitors connection pools
type ConnectionPoolMonitor struct {
	pools map[string]ConnectionPool
	
	// Health state
	isHealthy atomic.Bool
}

// ConnectionPool interface for monitoring
type ConnectionPool interface {
	Stats() PoolStats
}

// PoolStats contains pool statistics
type PoolStats struct {
	Open    int
	Idle    int
	MaxOpen int
}

// NewConnectionPoolMonitor creates a new connection pool monitor
func NewConnectionPoolMonitor() *ConnectionPoolMonitor {
	monitor := &ConnectionPoolMonitor{
		pools: make(map[string]ConnectionPool),
	}
	monitor.isHealthy.Store(true)
	return monitor
}

func (c *ConnectionPoolMonitor) Name() string {
	return "connection_pools"
}

func (c *ConnectionPoolMonitor) AddPool(name string, pool ConnectionPool) {
	c.pools[name] = pool
}

func (c *ConnectionPoolMonitor) HealthCheck(ctx context.Context) error {
	for name, pool := range c.pools {
		stats := pool.Stats()
		
		// Check if pool is exhausted
		if stats.Open >= stats.MaxOpen && stats.Idle == 0 {
			return fmt.Errorf("pool %s exhausted: %d/%d connections", name, stats.Open, stats.MaxOpen)
		}
		
		// Check for connection leak
		utilizationRate := float64(stats.Open-stats.Idle) / float64(stats.MaxOpen)
		if utilizationRate > 0.9 { // 90% utilization
			return fmt.Errorf("pool %s high utilization: %.0f%%", name, utilizationRate*100)
		}
	}
	
	c.isHealthy.Store(true)
	return nil
}

func (c *ConnectionPoolMonitor) GetStats() interface{} {
	poolStats := make(map[string]interface{})
	
	for name, pool := range c.pools {
		stats := pool.Stats()
		utilizationRate := float64(stats.Open-stats.Idle) / float64(stats.MaxOpen)
		
		poolStats[name] = map[string]interface{}{
			"open":        stats.Open,
			"idle":        stats.Idle,
			"max_open":    stats.MaxOpen,
			"in_use":      stats.Open - stats.Idle,
			"utilization": fmt.Sprintf("%.1f%%", utilizationRate*100),
		}
	}
	
	return poolStats
}

// ZKPSystemMonitor monitors the ZKP system
type ZKPSystemMonitor struct {
	// ZKP system reference would go here
	
	// Stats
	proofsGenerated atomic.Uint64
	proofsVerified  atomic.Uint64
	
	// Health state
	isHealthy atomic.Bool
}

// NewZKPSystemMonitor creates a new ZKP system monitor
func NewZKPSystemMonitor() *ZKPSystemMonitor {
	monitor := &ZKPSystemMonitor{}
	monitor.isHealthy.Store(true)
	return monitor
}

func (z *ZKPSystemMonitor) Name() string {
	return "zkp_system"
}

func (z *ZKPSystemMonitor) HealthCheck(ctx context.Context) error {
	// In a real implementation, would check ZKP system health
	// For now, just return healthy
	z.isHealthy.Store(true)
	return nil
}

func (z *ZKPSystemMonitor) GetStats() interface{} {
	return map[string]interface{}{
		"proofs_generated": z.proofsGenerated.Load(),
		"proofs_verified":  z.proofsVerified.Load(),
		"proof_types": []string{
			"age_verification",
			"hashpower_verification",
			"identity_verification",
		},
	}
}

// RecordProofGenerated increments proof generation counter
func (z *ZKPSystemMonitor) RecordProofGenerated() {
	z.proofsGenerated.Add(1)
}

// RecordProofVerified increments proof verification counter
func (z *ZKPSystemMonitor) RecordProofVerified() {
	z.proofsVerified.Add(1)
}