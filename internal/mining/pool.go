package mining

import (
	"context"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
)

// Pool represents a P2P mining pool with multi-device support
type Pool struct {
	mu          sync.RWMutex
	config      *PoolConfig
	logger      *zap.Logger
	
	// Core components
	engine      *MiningEngine
	workers     map[string]*Worker
	shares      *ShareQueue
	blocks      *BlockManager
	
	// Hardware support
	cpuManager  *CPUManager
	gpuManager  *GPUManager
	asicManager *ASICManager
	
	// P2P networking
	p2pNode     *P2PNode
	peers       map[string]*Peer
	
	// Statistics
	stats       *PoolStats
	metrics     *MetricsCollector
	
	// Resource management
	resources   *ResourceManager
	
	// Context for graceful shutdown
	ctx         context.Context
	cancel      context.CancelFunc
}

// PoolConfig contains configuration for the mining pool
type PoolConfig struct {
	Name            string
	Algorithm       AlgorithmType
	Port            int
	MaxConnections  int
	MaxWorkers      int
	TargetDifficulty float64
	PayoutThreshold  float64
	PoolFee         float64
	
	// Hardware settings
	EnableCPU       bool
	EnableGPU       bool
	EnableASIC      bool
	CPUThreads      int
	GPUDevices      []int
	ASICDevices     []string
	
	// Network settings
	P2PPort         int
	BootstrapNodes  []string
	MaxPeers        int
	
	// Security settings
	EnableTLS       bool
	CertFile        string
	KeyFile         string
}

// NewPool creates a new mining pool instance
func NewPool(config *PoolConfig) *Pool {
	ctx, cancel := context.WithCancel(context.Background())
	
	pool := &Pool{
		config:   config,
		workers:  make(map[string]*Worker),
		peers:    make(map[string]*Peer),
		ctx:      ctx,
		cancel:   cancel,
	}
	
	// Initialize components
	pool.initComponents()
	
	return pool
}

// initComponents initializes all pool components
func (p *Pool) initComponents() {
	// Initialize core components
	p.engine = NewMiningEngine(nil) // Use default config
	p.shares = NewShareQueue()
	p.blocks = NewBlockManager()
	
	// Initialize hardware managers
	p.cpuManager = NewCPUManager()
	p.gpuManager = NewGPUManager()
	p.asicManager = NewASICManager()
	
	// Initialize P2P networking
	p.p2pNode = NewP2PNode()
	
	// Initialize statistics
	p.stats = &PoolStats{}
	p.metrics = NewMetricsCollector()
	
	// Initialize resource management
	p.resources = NewResourceManager()
}

// Start starts the mining pool
func (p *Pool) Start() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	p.logger.Info("Starting mining pool", zap.String("name", p.config.Name))
	
	// Start hardware managers
	if err := p.startHardwareManagers(); err != nil {
		return fmt.Errorf("failed to start hardware managers: %w", err)
	}
	
	// Start P2P networking
	if err := p.startP2PNetworking(); err != nil {
		return fmt.Errorf("failed to start P2P networking: %w", err)
	}
	
	// Start mining engine
	if err := p.engine.Start(); err != nil {
		return fmt.Errorf("failed to start mining engine: %w", err)
	}
	
	// Start statistics collection
	if err := p.startStatistics(); err != nil {
		return fmt.Errorf("failed to start statistics: %w", err)
	}
	
	p.logger.Info("Mining pool started successfully")
	return nil
}

// Stop stops the mining pool
func (p *Pool) Stop() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	p.logger.Info("Stopping mining pool")
	
	// Stop in reverse order
	p.stopStatistics()
	p.engine.Stop()
	p.stopP2PNetworking()
	p.stopHardwareManagers()
	
	p.cancel() // Cancel context for graceful shutdown
	
	p.logger.Info("Mining pool stopped")
	return nil
}

// startHardwareManagers starts all hardware managers
func (p *Pool) startHardwareManagers() error {
	var errs []error
	
	// Start CPU manager
	if p.config.EnableCPU {
		if err := p.cpuManager.Start(); err != nil {
			errs = append(errs, fmt.Errorf("CPU manager: %w", err))
		}
	}
	
	// Start GPU manager
	if p.config.EnableGPU {
		if err := p.gpuManager.Start(); err != nil {
			errs = append(errs, fmt.Errorf("GPU manager: %w", err))
		}
	}
	
	// Start ASIC manager
	if p.config.EnableASIC {
		if err := p.asicManager.Start(); err != nil {
			errs = append(errs, fmt.Errorf("ASIC manager: %w", err))
		}
	}
	
	if len(errs) > 0 {
		return fmt.Errorf("hardware manager errors: %v", errs)
	}
	
	return nil
}

// stopHardwareManagers stops all hardware managers
func (p *Pool) stopHardwareManagers() {
	p.cpuManager.Stop()
	p.gpuManager.Stop()
	p.asicManager.Stop()
}

// startP2PNetworking starts P2P networking
func (p *Pool) startP2PNetworking() error {
	return p.p2pNode.Start()
}

// stopP2PNetworking stops P2P networking
func (p *Pool) stopP2PNetworking() {
	p.p2pNode.Stop()
}

// startStatistics starts statistics collection
func (p *Pool) startStatistics() error {
	return p.metrics.Start()
}

// stopStatistics stops statistics collection
func (p *Pool) stopStatistics() {
	p.metrics.Stop()
}

// AddWorker adds a worker to the pool
func (p *Pool) AddWorker(worker *Worker) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	if worker == nil {
		return fmt.Errorf("worker cannot be nil")
	}
	
	if _, exists := p.workers[worker.ID]; exists {
		return fmt.Errorf("worker already exists: %s", worker.ID)
	}
	
	p.workers[worker.ID] = worker
	p.logger.Info("Worker added", zap.String("worker_id", worker.ID))
	
	return nil
}

// RemoveWorker removes a worker from the pool
func (p *Pool) RemoveWorker(workerID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	if _, exists := p.workers[workerID]; !exists {
		return fmt.Errorf("worker not found: %s", workerID)
	}
	
	delete(p.workers, workerID)
	p.logger.Info("Worker removed", zap.String("worker_id", workerID))
	
	return nil
}

// GetWorker returns a worker by ID
func (p *Pool) GetWorker(workerID string) (*Worker, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	
	worker, exists := p.workers[workerID]
	if !exists {
		return nil, fmt.Errorf("worker not found: %s", workerID)
	}
	
	return worker, nil
}

// GetWorkers returns all workers
func (p *Pool) GetWorkers() []*Worker {
	p.mu.RLock()
	defer p.mu.RUnlock()
	
	workers := make([]*Worker, 0, len(p.workers))
	for _, worker := range p.workers {
		workers = append(workers, worker)
	}
	
	return workers
}

// GetWorkerCount returns the number of workers
func (p *Pool) GetWorkerCount() int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	
	return len(p.workers)
}

// SubmitShare submits a share for validation
func (p *Pool) SubmitShare(share *Share) error {
	return p.shares.Submit(share)
}

// GetStats returns pool statistics
func (p *Pool) GetStats() *PoolStats {
	return p.stats
}

// GetMetrics returns pool metrics
func (p *Pool) GetMetrics() *Metrics {
	return p.metrics.GetMetrics()
}

// ConnectPeer connects to a peer
func (p *Pool) ConnectPeer(peerAddress string) error {
	return p.p2pNode.ConnectPeer(peerAddress)
}

// DisconnectPeer disconnects from a peer
func (p *Pool) DisconnectPeer(peerID string) error {
	return p.p2pNode.DisconnectPeer(peerID)
}

// GetPeers returns connected peers
func (p *Pool) GetPeers() []string {
	return p.p2pNode.GetPeers()
}

// GetPeerCount returns the number of connected peers
func (p *Pool) GetPeerCount() int {
	return p.p2pNode.GetPeerCount()
}

// GetHashRate returns the total hash rate
func (p *Pool) GetHashRate() float64 {
	return p.stats.GetHashRate()
}

// GetDifficulty returns the current difficulty
func (p *Pool) GetDifficulty() float64 {
	return p.stats.GetDifficulty()
}

// GetBlockHeight returns the current block height
func (p *Pool) GetBlockHeight() uint64 {
	return p.stats.GetBlockHeight()
}

// GetBalance returns the pool balance
func (p *Pool) GetBalance() float64 {
	return p.stats.GetBalance()
}

// GetPayouts returns pending payouts
func (p *Pool) GetPayouts() []Payout {
	return p.stats.GetPayouts()
}

// HealthCheck performs a health check
func (p *Pool) HealthCheck() error {
	// Check hardware
	if err := p.cpuManager.HealthCheck(); err != nil {
		return fmt.Errorf("CPU manager: %w", err)
	}
	
	// Check networking
	if err := p.p2pNode.HealthCheck(); err != nil {
		return fmt.Errorf("P2P node: %w", err)
	}
	
	// Check engine
	if err := p.engine.HealthCheck(); err != nil {
		return fmt.Errorf("mining engine: %w", err)
	}
	
	return nil
}

// Optimize optimizes pool performance
func (p *Pool) Optimize() error {
	// Optimize hardware
	if err := p.cpuManager.Optimize(); err != nil {
		return fmt.Errorf("CPU optimization: %w", err)
	}
	
	// Optimize networking
	if err := p.p2pNode.Optimize(); err != nil {
		return fmt.Errorf("P2P optimization: %w", err)
	}
	
	// Optimize engine
	if err := p.engine.OptimizePerformance(); err != nil {
		return fmt.Errorf("engine optimization: %w", err)
	}
	
	return nil
}

// Shutdown gracefully shuts down the pool
func (p *Pool) Shutdown() error {
	p.logger.Info("Shutting down mining pool")
	
	// Stop all operations
	p.Stop()
	
	// Cleanup resources
	p.cleanup()
	
	p.logger.Info("Mining pool shutdown complete")
	return nil
}

// cleanup performs final cleanup
func (p *Pool) cleanup() {
	// Clear workers
	p.workers = make(map[string]*Worker)
	
	// Clear peers
	p.peers = make(map[string]*Peer)
	
	// Reset statistics
	p.stats = &PoolStats{}
}

// DefaultPoolConfig returns default pool configuration
func DefaultPoolConfig() *PoolConfig {
	return &PoolConfig{
		Name:             "Otedama Pool",
		Algorithm:        SHA256D,
		Port:             3333,
		MaxConnections:   1000,
		MaxWorkers:       10000,
		TargetDifficulty: 1000.0,
		PayoutThreshold:  0.001,
		PoolFee:          0.01,
		
		EnableCPU:        true,
		EnableGPU:        true,
		EnableASIC:       true,
		CPUThreads:       runtime.NumCPU(),
		GPUDevices:       []int{0},
		ASICDevices:      []string{"asic0"},
		
		P2PPort:          3334,
		BootstrapNodes:   []string{"node1.otedama.com:3334", "node2.otedama.com:3334"},
		MaxPeers:         50,
		
		EnableTLS:        false,
		CertFile:         "",
		KeyFile:          "",
	}
}
