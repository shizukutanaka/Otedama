package worker

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/database"
	"go.uber.org/zap"
)

// WorkerManager manages mining workers
// Following Robert C. Martin's clean architecture with John Carmack's performance focus
type WorkerManager struct {
	logger *zap.Logger
	config WorkerConfig
	workerRepo *database.WorkerRepository // Add worker repository for database persistence
	
	// Worker registry
	workers      sync.Map // map[string]*Worker
	workerGroups sync.Map // map[string]*WorkerGroup
	
	// Performance tracking
	performance  *PerformanceTracker
	
	// Worker commands
	commandQueue chan WorkerCommand
	
	// Statistics
	stats        *WorkerStats
	
	// Lifecycle
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

// WorkerConfig contains worker management configuration
type WorkerConfig struct {
	// Limits
	MaxWorkersPerUser    int
	MaxWorkersPerGroup   int
	
	// Performance
	MinHashrate          float64
	MaxIdleTime          time.Duration
	
	// Monitoring
	MonitorInterval      time.Duration
	StatsRetention       time.Duration
	
	// Commands
	CommandTimeout       time.Duration
	CommandRetries       int
	
	// Features
	AutoRestart          bool
	AutoScaling          bool
	LoadBalancing        bool
}

// Worker represents a mining worker
type Worker struct {
	ID               string
	UserID           string
	GroupID          string
	Name             string
	
	// Connection info
	IPAddress        string
	Port             int
	Protocol         string
	ConnectedAt      time.Time
	LastSeen         time.Time
	
	// Hardware info
	HardwareType     HardwareType
	HardwareInfo     HardwareInfo
	
	// Mining info
	Algorithm        string
	Currency         string
	Pool             string
	Wallet           string
	Metadata         map[string]interface{} `json:"metadata,omitempty"`
	
	// Performance
	Hashrate         atomic.Value // float64
	SharesAccepted   atomic.Uint64
	SharesRejected   atomic.Uint64
	SharesStale      atomic.Uint64
	Difficulty       atomic.Value // float64
	
	// Status
	Status           atomic.Value // WorkerStatus
	StatusMessage    atomic.Value // string
	Version          string
	
	// Configuration
	Config           WorkerConfiguration
	
	// Metrics
	metrics          *WorkerMetrics
	metricsLock      sync.RWMutex
}

// WorkerGroup represents a group of workers
type WorkerGroup struct {
	ID               string
	UserID           string
	Name             string
	Description      string
	
	// Workers
	Workers          sync.Map // map[string]*Worker
	WorkerCount      atomic.Int32
	
	// Configuration
	Config           GroupConfiguration
	
	// Performance
	TotalHashrate    atomic.Value // float64
	AverageHashrate  atomic.Value // float64
	
	// Status
	Status           GroupStatus
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// HardwareType defines worker hardware types
type HardwareType string

const (
	HardwareCPU     HardwareType = "cpu"
	HardwareGPU     HardwareType = "gpu"
	HardwareASIC    HardwareType = "asic"
	HardwareFPGA    HardwareType = "fpga"
	HardwareUnknown HardwareType = "unknown"
)

// HardwareInfo contains hardware information
type HardwareInfo struct {
	Manufacturer     string            `json:"manufacturer"`
	Model            string            `json:"model"`
	Cores            int               `json:"cores,omitempty"`
	Memory           int64             `json:"memory,omitempty"`
	Temperature      float64           `json:"temperature,omitempty"`
	FanSpeed         int               `json:"fan_speed,omitempty"`
	PowerUsage       float64           `json:"power_usage,omitempty"`
	DriverVersion    string            `json:"driver_version,omitempty"`
	FirmwareVersion  string            `json:"firmware_version,omitempty"`
	SerialNumber     string            `json:"serial_number,omitempty"`
	PCIBus           string            `json:"pci_bus,omitempty"`
	ExtraInfo        map[string]string `json:"extra_info,omitempty"`
}

// WorkerStatus represents worker status
type WorkerStatus string

const (
	StatusOnline      WorkerStatus = "online"
	StatusOffline     WorkerStatus = "offline"
	StatusMining      WorkerStatus = "mining"
	StatusIdle        WorkerStatus = "idle"
	StatusError       WorkerStatus = "error"
	StatusMaintenance WorkerStatus = "maintenance"
)

// GroupStatus represents group status
type GroupStatus string

const (
	GroupActive   GroupStatus = "active"
	GroupInactive GroupStatus = "inactive"
	GroupPaused   GroupStatus = "paused"
)

// WorkerConfiguration contains worker-specific configuration
type WorkerConfiguration struct {
	// Mining settings
	Intensity        int               `json:"intensity"`
	Threads          int               `json:"threads"`
	Affinity         string            `json:"affinity"`
	
	// Performance limits
	MaxHashrate      float64           `json:"max_hashrate"`
	MaxPower         float64           `json:"max_power"`
	MaxTemperature   float64           `json:"max_temperature"`
	
	// Behavior
	AutoRestart      bool              `json:"auto_restart"`
	RestartDelay     time.Duration     `json:"restart_delay"`
	
	// Custom parameters
	ExtraParams      map[string]string `json:"extra_params"`
}

// GroupConfiguration contains group-specific configuration
type GroupConfiguration struct {
	// Load balancing
	LoadBalancing    bool              `json:"load_balancing"`
	BalancingMethod  string            `json:"balancing_method"`
	
	// Failover
	FailoverEnabled  bool              `json:"failover_enabled"`
	FailoverDelay    time.Duration     `json:"failover_delay"`
	
	// Scaling
	AutoScaling      bool              `json:"auto_scaling"`
	MinWorkers       int               `json:"min_workers"`
	MaxWorkers       int               `json:"max_workers"`
	
	// Priority
	Priority         int               `json:"priority"`
}

// WorkerCommand represents a command to execute on workers
type WorkerCommand struct {
	ID               string
	Type             CommandType
	Target           CommandTarget
	TargetID         string
	Parameters       map[string]interface{}
	Timeout          time.Duration
	ResponseChan     chan CommandResponse
}

// CommandType defines command types
type CommandType string

const (
	CmdStart         CommandType = "start"
	CmdStop          CommandType = "stop"
	CmdRestart       CommandType = "restart"
	CmdConfigure     CommandType = "configure"
	CmdUpdate        CommandType = "update"
	CmdGetStatus     CommandType = "get_status"
	CmdGetStats      CommandType = "get_stats"
	CmdReboot        CommandType = "reboot"
)

// CommandTarget defines command targets
type CommandTarget string

const (
	TargetWorker     CommandTarget = "worker"
	TargetGroup      CommandTarget = "group"
	TargetAll        CommandTarget = "all"
)

// CommandResponse represents a command response
type CommandResponse struct {
	CommandID        string
	Success          bool
	Error            error
	Data             map[string]interface{}
}

// WorkerMetrics contains detailed worker metrics
type WorkerMetrics struct {
	// Performance history
	HashrateHistory  []MetricPoint
	ShareHistory     []ShareMetric
	
	// Resource usage
	CPUUsage         []MetricPoint
	MemoryUsage      []MetricPoint
	Temperature      []MetricPoint
	PowerUsage       []MetricPoint
	
	// Network
	Latency          []MetricPoint
	Bandwidth        BandwidthMetric
	
	// Errors
	ErrorCount       map[string]int
	LastError        time.Time
}

// MetricPoint represents a metric data point
type MetricPoint struct {
	Timestamp        time.Time
	Value            float64
}

// ShareMetric represents share submission metrics
type ShareMetric struct {
	Timestamp        time.Time
	Accepted         int
	Rejected         int
	Stale            int
}

// BandwidthMetric represents bandwidth usage
type BandwidthMetric struct {
	BytesIn          uint64
	BytesOut         uint64
	LastReset        time.Time
}

// WorkerStats tracks worker management statistics
type WorkerStats struct {
	TotalWorkers     atomic.Int64
	ActiveWorkers    atomic.Int64
	TotalGroups      atomic.Int64
	CommandsExecuted atomic.Uint64
	CommandsFailed   atomic.Uint64
	TotalHashrate    atomic.Value // float64
	UptimeSeconds    atomic.Int64
}

// PerformanceTracker tracks worker performance
type PerformanceTracker struct {
	logger           *zap.Logger
	metrics          sync.Map // map[string]*WorkerMetrics
	aggregator       *MetricsAggregator
}

// NewWorkerManager creates a new worker manager
func NewWorkerManager(logger *zap.Logger, config WorkerConfig, workerRepo *database.WorkerRepository) *WorkerManager {
	ctx, cancel := context.WithCancel(context.Background())
	
	wm := &WorkerManager{
		logger:       logger,
		config:       config,
		workerRepo:   workerRepo,
		performance:  NewPerformanceTracker(logger),
		commandQueue: make(chan WorkerCommand, 1000),
		stats:        &WorkerStats{},
		ctx:          ctx,
		cancel:       cancel,
	}
	
	return wm
}

// Start starts the worker manager
func (wm *WorkerManager) Start() error {
	wm.logger.Info("Starting worker manager")
	
	// Start command processor
	wm.wg.Add(1)
	go wm.commandProcessor()
	
	// Start monitoring
	wm.wg.Add(1)
	go wm.monitoringLoop()
	
	// Start cleanup
	wm.wg.Add(1)
	go wm.cleanupLoop()
	
	// Start performance tracking
	wm.wg.Add(1)
	go wm.performanceLoop()
	
	return nil
}

// Stop stops the worker manager
func (wm *WorkerManager) Stop() error {
	wm.logger.Info("Stopping worker manager")
	
	wm.cancel()
	close(wm.commandQueue)
	wm.wg.Wait()
	
	return nil
}

// RegisterWorker registers a new worker
func (wm *WorkerManager) RegisterWorker(worker *Worker) error {
	if worker.ID == "" || worker.UserID == "" {
		return errors.New("invalid worker data")
	}
	
	// Check limits
	userWorkerCount := wm.countUserWorkers(worker.UserID)
	if userWorkerCount >= wm.config.MaxWorkersPerUser {
		return fmt.Errorf("user worker limit exceeded: %d/%d", userWorkerCount, wm.config.MaxWorkersPerUser)
	}
	
	// Initialize worker
	worker.Status.Store(StatusOnline)
	worker.Hashrate.Store(0.0)
	worker.Difficulty.Store(1.0)
	worker.metrics = &WorkerMetrics{
		HashrateHistory: make([]MetricPoint, 0),
		ShareHistory:    make([]ShareMetric, 0),
		ErrorCount:      make(map[string]int),
	}
	
	// Store worker
	wm.workers.Store(worker.ID, worker)
	wm.stats.TotalWorkers.Add(1)
	wm.stats.ActiveWorkers.Add(1)
	
	// Add to group if specified
	if worker.GroupID != "" {
		if err := wm.addWorkerToGroup(worker); err != nil {
			wm.logger.Warn("Failed to add worker to group",
				zap.String("worker_id", worker.ID),
				zap.String("group_id", worker.GroupID),
				zap.Error(err),
			)
		}
	}
	
	// Persist worker to database
	if wm.workerRepo != nil {
		dbWorker := &database.Worker{
			WorkerID:     worker.ID,
			Username:     worker.UserID,
			Status:       string(worker.Status.Load().(WorkerStatus)),
			Metadata:     worker.Metadata,
		}
		
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		
		if err := wm.workerRepo.Create(ctx, dbWorker); err != nil {
			wm.logger.Error("Failed to persist worker to database",
				zap.String("worker_id", worker.ID),
				zap.Error(err),
			)
			// Don't return error here as we still want to register the worker in memory
		}
	}
	
	wm.logger.Info("Worker registered",
		zap.String("worker_id", worker.ID),
		zap.String("user_id", worker.UserID),
		zap.String("name", worker.Name),
		zap.String("hardware", string(worker.HardwareType)),
	)
	
	return nil
}

// UnregisterWorker unregisters a worker
func (wm *WorkerManager) UnregisterWorker(workerID string) error {
	workerInterface, ok := wm.workers.Load(workerID)
	if !ok {
		return fmt.Errorf("worker not found: %s", workerID)
	}
	
	worker := workerInterface.(*Worker)
	
	// Remove from group
	if worker.GroupID != "" {
		wm.removeWorkerFromGroup(worker)
	}
	
	// Remove worker
	wm.workers.Delete(workerID)
	wm.stats.TotalWorkers.Add(-1)
	
	if worker.Status.Load().(WorkerStatus) != StatusOffline {
		wm.stats.ActiveWorkers.Add(-1)
	}
	
	wm.logger.Info("Worker unregistered",
		zap.String("worker_id", workerID),
	)
	
	return nil
}

// GetWorker retrieves a worker by ID
func (wm *WorkerManager) GetWorker(workerID string) (*Worker, error) {
	workerInterface, ok := wm.workers.Load(workerID)
	if !ok {
		return nil, fmt.Errorf("worker not found: %s", workerID)
	}
	
	return workerInterface.(*Worker), nil
}

// GetUserWorkers retrieves all workers for a user
func (wm *WorkerManager) GetUserWorkers(userID string) ([]*Worker, error) {
	workers := make([]*Worker, 0)
	
	wm.workers.Range(func(key, value interface{}) bool {
		worker := value.(*Worker)
		if worker.UserID == userID {
			workers = append(workers, worker)
		}
		return true
	})
	
	return workers, nil
}

// UpdateWorkerStatus updates worker status and metrics
func (wm *WorkerManager) UpdateWorkerStatus(workerID string, status WorkerStatus, hashrate float64, shares ShareMetric) error {
	worker, err := wm.GetWorker(workerID)
	if err != nil {
		return err
	}
	
	// Update status
	oldStatus := worker.Status.Load().(WorkerStatus)
	worker.Status.Store(status)
	worker.LastSeen = time.Now()
	
	// Update active worker count
	if oldStatus != StatusOffline && status == StatusOffline {
		wm.stats.ActiveWorkers.Add(-1)
	} else if oldStatus == StatusOffline && status != StatusOffline {
		wm.stats.ActiveWorkers.Add(1)
	}
	
	// Update hashrate
	worker.Hashrate.Store(hashrate)
	
	// Update shares
	worker.SharesAccepted.Add(uint64(shares.Accepted))
	worker.SharesRejected.Add(uint64(shares.Rejected))
	worker.SharesStale.Add(uint64(shares.Stale))
	
	// Record metrics
	worker.metricsLock.Lock()
	worker.metrics.HashrateHistory = append(worker.metrics.HashrateHistory, MetricPoint{
		Timestamp: time.Now(),
		Value:     hashrate,
	})
	worker.metrics.ShareHistory = append(worker.metrics.ShareHistory, shares)
	
	// Trim old metrics
	if len(worker.metrics.HashrateHistory) > 1440 { // 24 hours at 1 min intervals
		worker.metrics.HashrateHistory = worker.metrics.HashrateHistory[1:]
	}
	if len(worker.metrics.ShareHistory) > 1440 {
		worker.metrics.ShareHistory = worker.metrics.ShareHistory[1:]
	}
	worker.metricsLock.Unlock()
	
	// Update group hashrate if applicable
	if worker.GroupID != "" {
		wm.updateGroupHashrate(worker.GroupID)
	}
	
	return nil
}

// UpdateWorkerWallet updates a worker's wallet address in metadata
func (wm *WorkerManager) UpdateWorkerWallet(workerID string, wallet string) error {
	// Get worker
	workerValue, exists := wm.workers.Load(workerID)
	if !exists {
		return errors.New("worker not found")
	}
	
	worker := workerValue.(*Worker)
	
	// Update metadata with new wallet address
	if worker.Metadata == nil {
		worker.Metadata = make(map[string]interface{})
	}
	worker.Metadata["wallet"] = wallet
	
	// Update database if repository exists
	if wm.workerRepo != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		
		// Get existing worker from database to preserve other fields
		dbWorker, err := wm.workerRepo.Get(ctx, workerID)
		if err != nil {
			return fmt.Errorf("failed to get worker from database: %v", err)
		}
		
		// Update metadata
		dbWorker.Metadata["wallet"] = wallet
		
		// Save updated worker
		if err := wm.workerRepo.Update(ctx, dbWorker); err != nil {
			return fmt.Errorf("failed to update worker in database: %v", err)
		}
	}
	
	return nil
}

// ExecuteCommand executes a command on workers
func (wm *WorkerManager) ExecuteCommand(cmd WorkerCommand) error {
	// Validate command
	if cmd.Type == "" || cmd.Target == "" {
		return errors.New("invalid command")
	}
	
	// Set defaults
	if cmd.Timeout == 0 {
		cmd.Timeout = wm.config.CommandTimeout
	}
	
	if cmd.ResponseChan == nil {
		cmd.ResponseChan = make(chan CommandResponse, 1)
	}
	
	// Generate command ID
	cmd.ID = generateCommandID()
	
	// Queue command
	select {
	case wm.commandQueue <- cmd:
		wm.logger.Debug("Command queued",
			zap.String("command_id", cmd.ID),
			zap.String("type", string(cmd.Type)),
			zap.String("target", string(cmd.Target)),
		)
		return nil
		
	case <-wm.ctx.Done():
		return errors.New("worker manager stopped")
		
	default:
		return errors.New("command queue full")
	}
}

// CreateGroup creates a new worker group
func (wm *WorkerManager) CreateGroup(group *WorkerGroup) error {
	if group.ID == "" || group.UserID == "" {
		return errors.New("invalid group data")
	}
	
	// Initialize group
	group.Status = GroupActive
	group.CreatedAt = time.Now()
	group.UpdatedAt = time.Now()
	group.TotalHashrate.Store(0.0)
	group.AverageHashrate.Store(0.0)
	
	// Store group
	wm.workerGroups.Store(group.ID, group)
	wm.stats.TotalGroups.Add(1)
	
	wm.logger.Info("Worker group created",
		zap.String("group_id", group.ID),
		zap.String("user_id", group.UserID),
		zap.String("name", group.Name),
	)
	
	return nil
}

// DeleteGroup deletes a worker group
func (wm *WorkerManager) DeleteGroup(groupID string) error {
	groupInterface, ok := wm.workerGroups.Load(groupID)
	if !ok {
		return fmt.Errorf("group not found: %s", groupID)
	}
	
	group := groupInterface.(*WorkerGroup)
	
	// Remove all workers from group
	group.Workers.Range(func(key, value interface{}) bool {
		worker := value.(*Worker)
		worker.GroupID = ""
		return true
	})
	
	// Delete group
	wm.workerGroups.Delete(groupID)
	wm.stats.TotalGroups.Add(-1)
	
	wm.logger.Info("Worker group deleted",
		zap.String("group_id", groupID),
	)
	
	return nil
}

// GetGroup retrieves a group by ID
func (wm *WorkerManager) GetGroup(groupID string) (*WorkerGroup, error) {
	groupInterface, ok := wm.workerGroups.Load(groupID)
	if !ok {
		return nil, fmt.Errorf("group not found: %s", groupID)
	}
	
	return groupInterface.(*WorkerGroup), nil
}

// GetStats returns worker management statistics
func (wm *WorkerManager) GetStats() map[string]interface{} {
	totalHashrate := 0.0
	wm.workers.Range(func(key, value interface{}) bool {
		worker := value.(*Worker)
		if hr := worker.Hashrate.Load(); hr != nil {
			totalHashrate += hr.(float64)
		}
		return true
	})
	
	return map[string]interface{}{
		"total_workers":     wm.stats.TotalWorkers.Load(),
		"active_workers":    wm.stats.ActiveWorkers.Load(),
		"total_groups":      wm.stats.TotalGroups.Load(),
		"commands_executed": wm.stats.CommandsExecuted.Load(),
		"commands_failed":   wm.stats.CommandsFailed.Load(),
		"total_hashrate":    totalHashrate,
		"uptime_seconds":    wm.stats.UptimeSeconds.Load(),
	}
}

// Internal methods

func (wm *WorkerManager) countUserWorkers(userID string) int {
	count := 0
	wm.workers.Range(func(key, value interface{}) bool {
		worker := value.(*Worker)
		if worker.UserID == userID {
			count++
		}
		return true
	})
	return count
}

func (wm *WorkerManager) addWorkerToGroup(worker *Worker) error {
	group, err := wm.GetGroup(worker.GroupID)
	if err != nil {
		return err
	}
	
	// Check group limit
	if group.WorkerCount.Load() >= int32(wm.config.MaxWorkersPerGroup) {
		return fmt.Errorf("group worker limit exceeded")
	}
	
	// Add worker to group
	group.Workers.Store(worker.ID, worker)
	group.WorkerCount.Add(1)
	group.UpdatedAt = time.Now()
	
	// Update group hashrate
	wm.updateGroupHashrate(worker.GroupID)
	
	return nil
}

func (wm *WorkerManager) removeWorkerFromGroup(worker *Worker) {
	if group, err := wm.GetGroup(worker.GroupID); err == nil {
		group.Workers.Delete(worker.ID)
		group.WorkerCount.Add(-1)
		group.UpdatedAt = time.Now()
		
		// Update group hashrate
		wm.updateGroupHashrate(worker.GroupID)
	}
}

func (wm *WorkerManager) updateGroupHashrate(groupID string) {
	group, err := wm.GetGroup(groupID)
	if err != nil {
		return
	}
	
	totalHashrate := 0.0
	count := 0
	
	group.Workers.Range(func(key, value interface{}) bool {
		worker := value.(*Worker)
		if hr := worker.Hashrate.Load(); hr != nil {
			totalHashrate += hr.(float64)
			count++
		}
		return true
	})
	
	group.TotalHashrate.Store(totalHashrate)
	if count > 0 {
		group.AverageHashrate.Store(totalHashrate / float64(count))
	} else {
		group.AverageHashrate.Store(0.0)
	}
}

// Goroutine loops

func (wm *WorkerManager) commandProcessor() {
	defer wm.wg.Done()
	
	for cmd := range wm.commandQueue {
		select {
		case <-wm.ctx.Done():
			return
		default:
			wm.processCommand(cmd)
		}
	}
}

func (wm *WorkerManager) processCommand(cmd WorkerCommand) {
	wm.logger.Debug("Processing command",
		zap.String("command_id", cmd.ID),
		zap.String("type", string(cmd.Type)),
		zap.String("target", string(cmd.Target)),
	)
	
	var response CommandResponse
	response.CommandID = cmd.ID
	
	switch cmd.Target {
	case TargetWorker:
		response = wm.executeWorkerCommand(cmd)
		
	case TargetGroup:
		response = wm.executeGroupCommand(cmd)
		
	case TargetAll:
		response = wm.executeAllCommand(cmd)
		
	default:
		response.Success = false
		response.Error = fmt.Errorf("unknown target: %s", cmd.Target)
	}
	
	// Update stats
	if response.Success {
		wm.stats.CommandsExecuted.Add(1)
	} else {
		wm.stats.CommandsFailed.Add(1)
	}
	
	// Send response
	select {
	case cmd.ResponseChan <- response:
	case <-time.After(time.Second):
		wm.logger.Warn("Command response timeout",
			zap.String("command_id", cmd.ID),
		)
	}
}

func (wm *WorkerManager) executeWorkerCommand(cmd WorkerCommand) CommandResponse {
	response := CommandResponse{CommandID: cmd.ID}
	
	worker, err := wm.GetWorker(cmd.TargetID)
	if err != nil {
		response.Error = err
		return response
	}
	
	switch cmd.Type {
	case CmdStart:
		// Start worker mining
		worker.Status.Store(StatusMining)
		response.Success = true
		
	case CmdStop:
		// Stop worker mining
		worker.Status.Store(StatusIdle)
		response.Success = true
		
	case CmdRestart:
		// Restart worker
		worker.Status.Store(StatusOffline)
		time.Sleep(time.Second)
		worker.Status.Store(StatusOnline)
		response.Success = true
		
	case CmdGetStatus:
		// Get worker status
		response.Success = true
		response.Data = map[string]interface{}{
			"status":   worker.Status.Load(),
			"hashrate": worker.Hashrate.Load(),
			"shares_accepted": worker.SharesAccepted.Load(),
			"shares_rejected": worker.SharesRejected.Load(),
			"last_seen": worker.LastSeen,
		}
		
	default:
		response.Error = fmt.Errorf("unknown command type: %s", cmd.Type)
	}
	
	return response
}

func (wm *WorkerManager) executeGroupCommand(cmd WorkerCommand) CommandResponse {
	response := CommandResponse{CommandID: cmd.ID}
	
	group, err := wm.GetGroup(cmd.TargetID)
	if err != nil {
		response.Error = err
		return response
	}
	
	// Execute command on all workers in group
	var successCount, failCount int
	
	group.Workers.Range(func(key, value interface{}) bool {
		worker := value.(*Worker)
		workerCmd := cmd
		workerCmd.Target = TargetWorker
		workerCmd.TargetID = worker.ID
		
		workerResp := wm.executeWorkerCommand(workerCmd)
		if workerResp.Success {
			successCount++
		} else {
			failCount++
		}
		
		return true
	})
	
	response.Success = failCount == 0
	response.Data = map[string]interface{}{
		"success_count": successCount,
		"fail_count":    failCount,
	}
	
	return response
}

func (wm *WorkerManager) executeAllCommand(cmd WorkerCommand) CommandResponse {
	response := CommandResponse{CommandID: cmd.ID}
	
	// Execute command on all workers
	var successCount, failCount int
	
	wm.workers.Range(func(key, value interface{}) bool {
		worker := value.(*Worker)
		workerCmd := cmd
		workerCmd.Target = TargetWorker
		workerCmd.TargetID = worker.ID
		
		workerResp := wm.executeWorkerCommand(workerCmd)
		if workerResp.Success {
			successCount++
		} else {
			failCount++
		}
		
		return true
	})
	
	response.Success = failCount == 0
	response.Data = map[string]interface{}{
		"success_count": successCount,
		"fail_count":    failCount,
	}
	
	return response
}

func (wm *WorkerManager) monitoringLoop() {
	defer wm.wg.Done()
	
	ticker := time.NewTicker(wm.config.MonitorInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-wm.ctx.Done():
			return
			
		case <-ticker.C:
			wm.monitorWorkers()
		}
	}
}

func (wm *WorkerManager) monitorWorkers() {
	now := time.Now()
	
	wm.workers.Range(func(key, value interface{}) bool {
		worker := value.(*Worker)
		
		// Check if worker is idle
		if now.Sub(worker.LastSeen) > wm.config.MaxIdleTime {
			oldStatus := worker.Status.Load().(WorkerStatus)
			if oldStatus != StatusOffline {
				worker.Status.Store(StatusOffline)
				worker.StatusMessage.Store("Worker idle timeout")
				wm.stats.ActiveWorkers.Add(-1)
				
				wm.logger.Warn("Worker went offline due to idle timeout",
					zap.String("worker_id", worker.ID),
					zap.Duration("idle_time", now.Sub(worker.LastSeen)),
				)
				
				// Auto-restart if enabled
				if worker.Config.AutoRestart && wm.config.AutoRestart {
					go wm.attemptWorkerRestart(worker)
				}
			}
		}
		
		// Check minimum hashrate
		if hr := worker.Hashrate.Load(); hr != nil {
			hashrate := hr.(float64)
			if hashrate < wm.config.MinHashrate && worker.Status.Load().(WorkerStatus) == StatusMining {
				wm.logger.Warn("Worker below minimum hashrate",
					zap.String("worker_id", worker.ID),
					zap.Float64("hashrate", hashrate),
					zap.Float64("min_hashrate", wm.config.MinHashrate),
				)
			}
		}
		
		return true
	})
}

func (wm *WorkerManager) attemptWorkerRestart(worker *Worker) {
	time.Sleep(worker.Config.RestartDelay)
	
	wm.logger.Info("Attempting to restart worker",
		zap.String("worker_id", worker.ID),
	)
	
	cmd := WorkerCommand{
		Type:     CmdRestart,
		Target:   TargetWorker,
		TargetID: worker.ID,
	}
	
	wm.ExecuteCommand(cmd)
}

func (wm *WorkerManager) cleanupLoop() {
	defer wm.wg.Done()
	
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	
	startTime := time.Now()
	
	for {
		select {
		case <-wm.ctx.Done():
			return
			
		case <-ticker.C:
			wm.cleanupOldMetrics()
			wm.stats.UptimeSeconds.Store(int64(time.Since(startTime).Seconds()))
		}
	}
}

func (wm *WorkerManager) cleanupOldMetrics() {
	cutoffTime := time.Now().Add(-wm.config.StatsRetention)
	
	wm.workers.Range(func(key, value interface{}) bool {
		worker := value.(*Worker)
		
		worker.metricsLock.Lock()
		// Clean hashrate history
		for i := 0; i < len(worker.metrics.HashrateHistory); i++ {
			if worker.metrics.HashrateHistory[i].Timestamp.Before(cutoffTime) {
				worker.metrics.HashrateHistory = worker.metrics.HashrateHistory[i+1:]
				break
			}
		}
		
		// Clean share history
		for i := 0; i < len(worker.metrics.ShareHistory); i++ {
			if worker.metrics.ShareHistory[i].Timestamp.Before(cutoffTime) {
				worker.metrics.ShareHistory = worker.metrics.ShareHistory[i+1:]
				break
			}
		}
		worker.metricsLock.Unlock()
		
		return true
	})
}

func (wm *WorkerManager) performanceLoop() {
	defer wm.wg.Done()
	
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-wm.ctx.Done():
			return
			
		case <-ticker.C:
			wm.calculatePerformanceMetrics()
		}
	}
}

func (wm *WorkerManager) calculatePerformanceMetrics() {
	// Calculate total hashrate
	totalHashrate := 0.0
	
	wm.workers.Range(func(key, value interface{}) bool {
		worker := value.(*Worker)
		if hr := worker.Hashrate.Load(); hr != nil {
			totalHashrate += hr.(float64)
		}
		return true
	})
	
	wm.stats.TotalHashrate.Store(totalHashrate)
}

// Helper components

// PerformanceTracker

func NewPerformanceTracker(logger *zap.Logger) *PerformanceTracker {
	return &PerformanceTracker{
		logger:     logger,
		aggregator: NewMetricsAggregator(),
	}
}

// MetricsAggregator

type MetricsAggregator struct {
	// Aggregation logic
}

func NewMetricsAggregator() *MetricsAggregator {
	return &MetricsAggregator{}
}

// Helper functions

func generateCommandID() string {
	return fmt.Sprintf("cmd_%d", time.Now().UnixNano())
}