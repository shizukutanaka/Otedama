package monitoring

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/otedama/otedama/internal/p2p"
	"go.uber.org/zap"
)

// P2PHealthChecker monitors P2P network health
type P2PHealthChecker struct {
	logger  *zap.Logger
	network *p2p.Network
	
	// Health metrics
	metrics struct {
		peerCount         atomic.Int32
		activeConnections atomic.Int32
		messageRate       atomic.Uint64
		errorRate         atomic.Uint64
		avgLatency        atomic.Uint64 // microseconds
		networkPartition  atomic.Bool
	}
	
	// Health thresholds
	thresholds struct {
		minPeers          int
		maxLatency        time.Duration
		maxErrorRate      float64
		minMessageRate    uint64
	}
	
	// Health status
	status struct {
		mu            sync.RWMutex
		healthy       bool
		lastCheck     time.Time
		issues        []HealthIssue
		peerStatuses  map[string]*PeerHealthStatus
	}
	
	// Check configuration
	checkInterval   time.Duration
	checkTimeout    time.Duration
	ctx             context.Context
	cancel          context.CancelFunc
}

// HealthIssue represents a network health problem
type HealthIssue struct {
	Type        string
	Severity    Severity
	Description string
	Timestamp   time.Time
	PeerID      string // optional, if issue is peer-specific
}

// PeerHealthStatus tracks individual peer health
type PeerHealthStatus struct {
	PeerID          string
	Connected       bool
	LastSeen        time.Time
	Latency         time.Duration
	MessagesSent    uint64
	MessagesRecv    uint64
	ErrorCount      uint64
	Score           float64 // 0.0 to 1.0
}

// Severity levels for health issues
type Severity int

const (
	SeverityInfo Severity = iota
	SeverityWarning
	SeverityCritical
)

// NewP2PHealthChecker creates a new P2P health checker
func NewP2PHealthChecker(logger *zap.Logger, network *p2p.Network) *P2PHealthChecker {
	ctx, cancel := context.WithCancel(context.Background())
	
	checker := &P2PHealthChecker{
		logger:        logger,
		network:       network,
		checkInterval: 30 * time.Second,
		checkTimeout:  10 * time.Second,
		ctx:          ctx,
		cancel:       cancel,
	}
	
	// Set default thresholds
	checker.thresholds.minPeers = 3
	checker.thresholds.maxLatency = 5 * time.Second
	checker.thresholds.maxErrorRate = 0.05 // 5%
	checker.thresholds.minMessageRate = 10 // messages per minute
	
	// Initialize status
	checker.status.healthy = true
	checker.status.peerStatuses = make(map[string]*PeerHealthStatus)
	
	return checker
}

// Start begins health monitoring
func (hc *P2PHealthChecker) Start() error {
	hc.logger.Info("Starting P2P health checker")
	
	// Start health check loop
	go hc.healthCheckLoop()
	
	// Start metrics collection
	go hc.metricsCollectionLoop()
	
	// Start peer monitoring
	go hc.peerMonitoringLoop()
	
	return nil
}

// Stop stops health monitoring
func (hc *P2PHealthChecker) Stop() error {
	hc.logger.Info("Stopping P2P health checker")
	hc.cancel()
	return nil
}

// healthCheckLoop performs periodic health checks
func (hc *P2PHealthChecker) healthCheckLoop() {
	ticker := time.NewTicker(hc.checkInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			hc.performHealthCheck()
			
		case <-hc.ctx.Done():
			return
		}
	}
}

// performHealthCheck executes all health checks
func (hc *P2PHealthChecker) performHealthCheck() {
	ctx, cancel := context.WithTimeout(hc.ctx, hc.checkTimeout)
	defer cancel()
	
	hc.status.mu.Lock()
	defer hc.status.mu.Unlock()
	
	// Clear previous issues
	hc.status.issues = nil
	hc.status.lastCheck = time.Now()
	
	// Check peer count
	hc.checkPeerCount()
	
	// Check network connectivity
	hc.checkNetworkConnectivity(ctx)
	
	// Check message flow
	hc.checkMessageFlow()
	
	// Check error rates
	hc.checkErrorRates()
	
	// Check for network partition
	hc.checkNetworkPartition(ctx)
	
	// Update overall health status
	hc.updateHealthStatus()
}

// checkPeerCount verifies we have enough peers
func (hc *P2PHealthChecker) checkPeerCount() {
	peerCount := int(hc.metrics.peerCount.Load())
	
	if peerCount < hc.thresholds.minPeers {
		hc.status.issues = append(hc.status.issues, HealthIssue{
			Type:        "insufficient_peers",
			Severity:    SeverityCritical,
			Description: fmt.Sprintf("Only %d peers connected (minimum: %d)", peerCount, hc.thresholds.minPeers),
			Timestamp:   time.Now(),
		})
	}
}

// checkNetworkConnectivity tests connectivity to peers
func (hc *P2PHealthChecker) checkNetworkConnectivity(ctx context.Context) {
	peers := hc.network.GetPeers(100)
	
	var wg sync.WaitGroup
	for _, peer := range peers {
		wg.Add(1)
		go func(p *p2p.Peer) {
			defer wg.Done()
			
			// Ping peer
			start := time.Now()
			err := hc.pingPeer(ctx, p)
			latency := time.Since(start)
			
			// Update peer status
			status := hc.status.peerStatuses[p.ID]
			if status == nil {
				status = &PeerHealthStatus{PeerID: p.ID}
				hc.status.peerStatuses[p.ID] = status
			}
			
			status.LastSeen = time.Now()
			status.Latency = latency
			
			if err != nil {
				status.Connected = false
				status.ErrorCount++
				
				hc.status.issues = append(hc.status.issues, HealthIssue{
					Type:        "peer_unreachable",
					Severity:    SeverityWarning,
					Description: fmt.Sprintf("Failed to ping peer %s: %v", p.ID, err),
					Timestamp:   time.Now(),
					PeerID:      p.ID,
				})
			} else {
				status.Connected = true
				
				if latency > hc.thresholds.maxLatency {
					hc.status.issues = append(hc.status.issues, HealthIssue{
						Type:        "high_latency",
						Severity:    SeverityWarning,
						Description: fmt.Sprintf("High latency to peer %s: %v", p.ID, latency),
						Timestamp:   time.Now(),
						PeerID:      p.ID,
					})
				}
			}
		}(peer)
	}
	
	// Wait with timeout
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	
	select {
	case <-done:
		// All pings completed
	case <-ctx.Done():
		// Timeout
		hc.status.issues = append(hc.status.issues, HealthIssue{
			Type:        "connectivity_check_timeout",
			Severity:    SeverityWarning,
			Description: "Network connectivity check timed out",
			Timestamp:   time.Now(),
		})
	}
}

// checkMessageFlow verifies messages are flowing
func (hc *P2PHealthChecker) checkMessageFlow() {
	messageRate := hc.metrics.messageRate.Load()
	
	if messageRate < hc.thresholds.minMessageRate {
		hc.status.issues = append(hc.status.issues, HealthIssue{
			Type:        "low_message_rate",
			Severity:    SeverityWarning,
			Description: fmt.Sprintf("Low message rate: %d/min (minimum: %d/min)", messageRate, hc.thresholds.minMessageRate),
			Timestamp:   time.Now(),
		})
	}
}

// checkErrorRates monitors error rates
func (hc *P2PHealthChecker) checkErrorRates() {
	errorRate := hc.metrics.errorRate.Load()
	messageRate := hc.metrics.messageRate.Load()
	
	if messageRate > 0 {
		errorPercent := float64(errorRate) / float64(messageRate)
		
		if errorPercent > hc.thresholds.maxErrorRate {
			hc.status.issues = append(hc.status.issues, HealthIssue{
				Type:        "high_error_rate",
				Severity:    SeverityCritical,
				Description: fmt.Sprintf("High error rate: %.2f%% (maximum: %.2f%%)", errorPercent*100, hc.thresholds.maxErrorRate*100),
				Timestamp:   time.Now(),
			})
		}
	}
}

// checkNetworkPartition detects network splits
func (hc *P2PHealthChecker) checkNetworkPartition(ctx context.Context) {
	// Get peer groups
	groups := hc.detectPeerGroups()
	
	if len(groups) > 1 {
		hc.metrics.networkPartition.Store(true)
		
		hc.status.issues = append(hc.status.issues, HealthIssue{
			Type:        "network_partition",
			Severity:    SeverityCritical,
			Description: fmt.Sprintf("Network partition detected: %d separate groups", len(groups)),
			Timestamp:   time.Now(),
		})
	} else {
		hc.metrics.networkPartition.Store(false)
	}
}

// detectPeerGroups identifies connected peer groups
func (hc *P2PHealthChecker) detectPeerGroups() [][]string {
	// Simple connected components algorithm
	peers := hc.network.GetPeers(1000)
	visited := make(map[string]bool)
	var groups [][]string
	
	for _, peer := range peers {
		if !visited[peer.ID] {
			group := hc.dfsGroup(peer.ID, visited)
			if len(group) > 0 {
				groups = append(groups, group)
			}
		}
	}
	
	return groups
}

// dfsGroup performs depth-first search to find connected peers
func (hc *P2PHealthChecker) dfsGroup(peerID string, visited map[string]bool) []string {
	if visited[peerID] {
		return nil
	}
	
	visited[peerID] = true
	group := []string{peerID}
	
	// Get connected peers
	connectedPeers := hc.network.GetConnectedPeers(peerID)
	
	for _, connected := range connectedPeers {
		subgroup := hc.dfsGroup(connected, visited)
		group = append(group, subgroup...)
	}
	
	return group
}

// updateHealthStatus updates overall health status
func (hc *P2PHealthChecker) updateHealthStatus() {
	// Determine if network is healthy based on issues
	healthy := true
	
	for _, issue := range hc.status.issues {
		if issue.Severity == SeverityCritical {
			healthy = false
			break
		}
	}
	
	hc.status.healthy = healthy
	
	// Log status change
	if !healthy {
		hc.logger.Error("P2P network unhealthy",
			zap.Int("issue_count", len(hc.status.issues)),
			zap.Any("critical_issues", hc.getCriticalIssues()),
		)
	}
}

// getCriticalIssues returns only critical issues
func (hc *P2PHealthChecker) getCriticalIssues() []HealthIssue {
	var critical []HealthIssue
	
	for _, issue := range hc.status.issues {
		if issue.Severity == SeverityCritical {
			critical = append(critical, issue)
		}
	}
	
	return critical
}

// pingPeer sends a ping to a peer
func (hc *P2PHealthChecker) pingPeer(ctx context.Context, peer *p2p.Peer) error {
	// Send ping message
	msg := &p2p.Message{
		Type: p2p.MessageTypePing,
		From: hc.network.NodeID(),
		To:   peer.ID,
		Data: []byte("ping"),
	}
	
	// Wait for pong response
	responseChan := make(chan error, 1)
	
	go func() {
		err := hc.network.SendMessage(msg)
		if err != nil {
			responseChan <- err
			return
		}
		
		// Wait for pong (simplified - in real implementation would use correlation ID)
		select {
		case <-time.After(5 * time.Second):
			responseChan <- fmt.Errorf("ping timeout")
		case <-ctx.Done():
			responseChan <- ctx.Err()
		}
	}()
	
	select {
	case err := <-responseChan:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// metricsCollectionLoop collects network metrics
func (hc *P2PHealthChecker) metricsCollectionLoop() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			hc.collectMetrics()
			
		case <-hc.ctx.Done():
			return
		}
	}
}

// collectMetrics gathers current network metrics
func (hc *P2PHealthChecker) collectMetrics() {
	stats := hc.network.GetStats()
	
	hc.metrics.peerCount.Store(int32(stats.PeerCount))
	hc.metrics.activeConnections.Store(int32(stats.ActiveConnections))
	hc.metrics.messageRate.Store(stats.MessagesPerMinute)
	hc.metrics.errorRate.Store(stats.ErrorsPerMinute)
	
	// Calculate average latency
	if len(stats.PeerLatencies) > 0 {
		var total time.Duration
		for _, latency := range stats.PeerLatencies {
			total += latency
		}
		avg := total / time.Duration(len(stats.PeerLatencies))
		hc.metrics.avgLatency.Store(uint64(avg.Microseconds()))
	}
}

// peerMonitoringLoop monitors individual peer health
func (hc *P2PHealthChecker) peerMonitoringLoop() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			hc.updatePeerScores()
			hc.cleanupOldPeers()
			
		case <-hc.ctx.Done():
			return
		}
	}
}

// updatePeerScores calculates health scores for each peer
func (hc *P2PHealthChecker) updatePeerScores() {
	hc.status.mu.Lock()
	defer hc.status.mu.Unlock()
	
	for _, status := range hc.status.peerStatuses {
		score := 1.0
		
		// Penalize for disconnection
		if !status.Connected {
			score *= 0.1
		}
		
		// Penalize for high latency
		if status.Latency > hc.thresholds.maxLatency {
			score *= 0.5
		} else if status.Latency > hc.thresholds.maxLatency/2 {
			score *= 0.8
		}
		
		// Penalize for errors
		if status.ErrorCount > 0 {
			errorRate := float64(status.ErrorCount) / float64(status.MessagesSent+status.MessagesRecv+1)
			score *= (1.0 - errorRate)
		}
		
		// Penalize for inactivity
		if time.Since(status.LastSeen) > 5*time.Minute {
			score *= 0.5
		}
		
		status.Score = score
	}
}

// cleanupOldPeers removes stale peer entries
func (hc *P2PHealthChecker) cleanupOldPeers() {
	hc.status.mu.Lock()
	defer hc.status.mu.Unlock()
	
	cutoff := time.Now().Add(-24 * time.Hour)
	
	for peerID, status := range hc.status.peerStatuses {
		if status.LastSeen.Before(cutoff) {
			delete(hc.status.peerStatuses, peerID)
		}
	}
}

// GetHealthStatus returns current health status
func (hc *P2PHealthChecker) GetHealthStatus() (bool, []HealthIssue) {
	hc.status.mu.RLock()
	defer hc.status.mu.RUnlock()
	
	issues := make([]HealthIssue, len(hc.status.issues))
	copy(issues, hc.status.issues)
	
	return hc.status.healthy, issues
}

// GetPeerHealth returns health status for a specific peer
func (hc *P2PHealthChecker) GetPeerHealth(peerID string) (*PeerHealthStatus, bool) {
	hc.status.mu.RLock()
	defer hc.status.mu.RUnlock()
	
	status, exists := hc.status.peerStatuses[peerID]
	if !exists {
		return nil, false
	}
	
	// Return a copy
	statusCopy := *status
	return &statusCopy, true
}

// GetNetworkMetrics returns current network metrics
func (hc *P2PHealthChecker) GetNetworkMetrics() map[string]interface{} {
	return map[string]interface{}{
		"peer_count":          hc.metrics.peerCount.Load(),
		"active_connections":  hc.metrics.activeConnections.Load(),
		"message_rate":        hc.metrics.messageRate.Load(),
		"error_rate":         hc.metrics.errorRate.Load(),
		"avg_latency_us":     hc.metrics.avgLatency.Load(),
		"network_partition":  hc.metrics.networkPartition.Load(),
		"last_check":         hc.status.lastCheck,
		"healthy":            hc.status.healthy,
	}
}