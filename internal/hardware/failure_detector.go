package hardware

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// FailureDetector detects and recovers from hardware failures
// Following Robert C. Martin's single responsibility principle
type FailureDetector struct {
	logger *zap.Logger
	
	// Monitors for different hardware types
	cpuMonitor  *CPUMonitor
	gpuMonitor  *GPUMonitor
	asicMonitor *ASICMonitor
	
	// Failure tracking
	failures sync.Map // map[string]*FailureRecord
	
	// Recovery strategies
	recoveryStrategies map[FailureType]RecoveryStrategy
	
	// Statistics
	stats struct {
		detectedFailures   atomic.Uint64
		recoveredFailures  atomic.Uint64
		permanentFailures  atomic.Uint64
		currentFailures    atomic.Int32
	}
	
	// Configuration
	config FailureConfig
}

// FailureConfig defines failure detection configuration
type FailureConfig struct {
	CheckInterval        time.Duration `yaml:"check_interval"`
	FailureThreshold     int           `yaml:"failure_threshold"`
	RecoveryTimeout      time.Duration `yaml:"recovery_timeout"`
	MaxRecoveryAttempts  int           `yaml:"max_recovery_attempts"`
	EnableAutoRecovery   bool          `yaml:"enable_auto_recovery"`
	EnableFailover       bool          `yaml:"enable_failover"`
}

// FailureType represents types of hardware failures
type FailureType int

const (
	FailureTypeNone FailureType = iota
	FailureTypeCPUOverheat
	FailureTypeGPUCrash
	FailureTypeGPUMemoryError
	FailureTypeASICTimeout
	FailureTypeHashrateDrop
	FailureTypePowerLimit
	FailureTypeDriverError
)

// FailureRecord tracks a hardware failure
type FailureRecord struct {
	Type            FailureType
	DeviceID        string
	FirstDetected   time.Time
	LastDetected    time.Time
	FailureCount    int
	RecoveryAttempts int
	Recovered       bool
	Error           error
}

// RecoveryStrategy defines how to recover from a failure
type RecoveryStrategy interface {
	Recover(ctx context.Context, failure *FailureRecord) error
	CanRecover(failure *FailureRecord) bool
}

// NewFailureDetector creates a new failure detector
func NewFailureDetector(logger *zap.Logger, config FailureConfig) *FailureDetector {
	fd := &FailureDetector{
		logger:             logger,
		config:             config,
		cpuMonitor:        NewCPUMonitor(logger),
		gpuMonitor:        NewGPUMonitor(logger),
		asicMonitor:       NewASICMonitor(logger),
		recoveryStrategies: make(map[FailureType]RecoveryStrategy),
	}
	
	// Register recovery strategies
	fd.registerRecoveryStrategies()
	
	return fd
}

// Start begins failure detection
func (fd *FailureDetector) Start(ctx context.Context) error {
	fd.logger.Info("Starting hardware failure detector",
		zap.Duration("check_interval", fd.config.CheckInterval),
		zap.Bool("auto_recovery", fd.config.EnableAutoRecovery),
	)
	
	// Start monitoring loops
	go fd.detectionLoop(ctx)
	go fd.recoveryLoop(ctx)
	
	return nil
}

// ReportFailure manually reports a hardware failure
func (fd *FailureDetector) ReportFailure(deviceID string, failureType FailureType, err error) {
	record := &FailureRecord{
		Type:          failureType,
		DeviceID:      deviceID,
		FirstDetected: time.Now(),
		LastDetected:  time.Now(),
		FailureCount:  1,
		Error:         err,
	}
	
	// Store or update failure record
	key := fd.failureKey(deviceID, failureType)
	if existing, loaded := fd.failures.LoadOrStore(key, record); loaded {
		existingRecord := existing.(*FailureRecord)
		existingRecord.LastDetected = time.Now()
		existingRecord.FailureCount++
		existingRecord.Error = err
	}
	
	fd.stats.detectedFailures.Add(1)
	fd.stats.currentFailures.Add(1)
	
	fd.logger.Warn("Hardware failure detected",
		zap.String("device_id", deviceID),
		zap.String("failure_type", fd.failureTypeName(failureType)),
		zap.Error(err),
	)
}

// GetFailureStatus returns current failure status
func (fd *FailureDetector) GetFailureStatus() FailureStatus {
	var activeFailures []FailureInfo
	
	fd.failures.Range(func(key, value interface{}) bool {
		record := value.(*FailureRecord)
		if !record.Recovered {
			activeFailures = append(activeFailures, FailureInfo{
				DeviceID:     record.DeviceID,
				FailureType:  fd.failureTypeName(record.Type),
				FirstSeen:    record.FirstDetected,
				FailureCount: record.FailureCount,
				Recoverable:  fd.isRecoverable(record),
			})
		}
		return true
	})
	
	return FailureStatus{
		ActiveFailures:    activeFailures,
		TotalDetected:     fd.stats.detectedFailures.Load(),
		TotalRecovered:    fd.stats.recoveredFailures.Load(),
		PermanentFailures: fd.stats.permanentFailures.Load(),
	}
}

// Private methods

func (fd *FailureDetector) detectionLoop(ctx context.Context) {
	ticker := time.NewTicker(fd.config.CheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			fd.checkAllHardware()
		}
	}
}

func (fd *FailureDetector) checkAllHardware() {
	// Check CPU
	if failures := fd.cpuMonitor.CheckHealth(); len(failures) > 0 {
		for _, f := range failures {
			fd.ReportFailure(f.DeviceID, f.Type, f.Error)
		}
	}
	
	// Check GPU
	if failures := fd.gpuMonitor.CheckHealth(); len(failures) > 0 {
		for _, f := range failures {
			fd.ReportFailure(f.DeviceID, f.Type, f.Error)
		}
	}
	
	// Check ASIC
	if failures := fd.asicMonitor.CheckHealth(); len(failures) > 0 {
		for _, f := range failures {
			fd.ReportFailure(f.DeviceID, f.Type, f.Error)
		}
	}
}

func (fd *FailureDetector) recoveryLoop(ctx context.Context) {
	if !fd.config.EnableAutoRecovery {
		return
	}
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			fd.attemptRecoveries(ctx)
		}
	}
}

func (fd *FailureDetector) attemptRecoveries(ctx context.Context) {
	fd.failures.Range(func(key, value interface{}) bool {
		record := value.(*FailureRecord)
		
		// Skip if already recovered or too many attempts
		if record.Recovered || record.RecoveryAttempts >= fd.config.MaxRecoveryAttempts {
			return true
		}
		
		// Get recovery strategy
		strategy, ok := fd.recoveryStrategies[record.Type]
		if !ok || !strategy.CanRecover(record) {
			return true
		}
		
		// Attempt recovery
		record.RecoveryAttempts++
		
		recoveryCtx, cancel := context.WithTimeout(ctx, fd.config.RecoveryTimeout)
		err := strategy.Recover(recoveryCtx, record)
		cancel()
		
		if err == nil {
			record.Recovered = true
			fd.stats.recoveredFailures.Add(1)
			fd.stats.currentFailures.Add(-1)
			
			fd.logger.Info("Hardware failure recovered",
				zap.String("device_id", record.DeviceID),
				zap.String("failure_type", fd.failureTypeName(record.Type)),
				zap.Int("attempts", record.RecoveryAttempts),
			)
		} else {
			fd.logger.Error("Recovery attempt failed",
				zap.String("device_id", record.DeviceID),
				zap.String("failure_type", fd.failureTypeName(record.Type)),
				zap.Int("attempt", record.RecoveryAttempts),
				zap.Error(err),
			)
			
			if record.RecoveryAttempts >= fd.config.MaxRecoveryAttempts {
				fd.stats.permanentFailures.Add(1)
			}
		}
		
		return true
	})
}

func (fd *FailureDetector) registerRecoveryStrategies() {
	// CPU overheat recovery
	fd.recoveryStrategies[FailureTypeCPUOverheat] = &CPUThrottleRecovery{
		logger: fd.logger,
	}
	
	// GPU crash recovery
	fd.recoveryStrategies[FailureTypeGPUCrash] = &GPUResetRecovery{
		logger: fd.logger,
	}
	
	// Hashrate drop recovery
	fd.recoveryStrategies[FailureTypeHashrateDrop] = &WorkerRestartRecovery{
		logger: fd.logger,
	}
}

func (fd *FailureDetector) failureKey(deviceID string, failureType FailureType) string {
	return deviceID + ":" + fd.failureTypeName(failureType)
}

func (fd *FailureDetector) failureTypeName(t FailureType) string {
	names := map[FailureType]string{
		FailureTypeCPUOverheat:    "cpu_overheat",
		FailureTypeGPUCrash:       "gpu_crash",
		FailureTypeGPUMemoryError: "gpu_memory_error",
		FailureTypeASICTimeout:    "asic_timeout",
		FailureTypeHashrateDrop:   "hashrate_drop",
		FailureTypePowerLimit:     "power_limit",
		FailureTypeDriverError:    "driver_error",
	}
	return names[t]
}

func (fd *FailureDetector) isRecoverable(record *FailureRecord) bool {
	strategy, ok := fd.recoveryStrategies[record.Type]
	return ok && strategy.CanRecover(record)
}

// Recovery strategy implementations

// CPUThrottleRecovery recovers from CPU overheating by throttling
type CPUThrottleRecovery struct {
	logger *zap.Logger
}

func (r *CPUThrottleRecovery) Recover(ctx context.Context, failure *FailureRecord) error {
	// Reduce CPU thread count
	// This would integrate with the mining engine
	r.logger.Info("Throttling CPU to recover from overheating",
		zap.String("device_id", failure.DeviceID),
	)
	
	// Wait for temperature to drop
	time.Sleep(30 * time.Second)
	
	return nil
}

func (r *CPUThrottleRecovery) CanRecover(failure *FailureRecord) bool {
	return failure.RecoveryAttempts < 3
}

// GPUResetRecovery recovers from GPU crashes by resetting
type GPUResetRecovery struct {
	logger *zap.Logger
}

func (r *GPUResetRecovery) Recover(ctx context.Context, failure *FailureRecord) error {
	r.logger.Info("Resetting GPU to recover from crash",
		zap.String("device_id", failure.DeviceID),
	)
	
	// GPU reset logic would go here
	// This would integrate with GPU drivers
	
	return nil
}

func (r *GPUResetRecovery) CanRecover(failure *FailureRecord) bool {
	return failure.RecoveryAttempts < 2
}

// WorkerRestartRecovery recovers by restarting mining workers
type WorkerRestartRecovery struct {
	logger *zap.Logger
}

func (r *WorkerRestartRecovery) Recover(ctx context.Context, failure *FailureRecord) error {
	r.logger.Info("Restarting worker to recover from failure",
		zap.String("device_id", failure.DeviceID),
	)
	
	// Worker restart logic would go here
	// This would integrate with the mining engine
	
	return nil
}

func (r *WorkerRestartRecovery) CanRecover(failure *FailureRecord) bool {
	return true
}

// Data structures

// FailureStatus contains current failure information
type FailureStatus struct {
	ActiveFailures    []FailureInfo
	TotalDetected     uint64
	TotalRecovered    uint64
	PermanentFailures uint64
}

// FailureInfo contains information about a failure
type FailureInfo struct {
	DeviceID     string
	FailureType  string
	FirstSeen    time.Time
	FailureCount int
	Recoverable  bool
}

// Hardware monitors (stubs for now)

type CPUMonitor struct {
	logger *zap.Logger
}

func NewCPUMonitor(logger *zap.Logger) *CPUMonitor {
	return &CPUMonitor{logger: logger}
}

func (m *CPUMonitor) CheckHealth() []FailureRecord {
	// CPU health check implementation
	return nil
}

type GPUMonitor struct {
	logger *zap.Logger
}

func NewGPUMonitor(logger *zap.Logger) *GPUMonitor {
	return &GPUMonitor{logger: logger}
}

func (m *GPUMonitor) CheckHealth() []FailureRecord {
	// GPU health check implementation
	return nil
}

type ASICMonitor struct {
	logger *zap.Logger
}

func NewASICMonitor(logger *zap.Logger) *ASICMonitor {
	return &ASICMonitor{logger: logger}
}

func (m *ASICMonitor) CheckHealth() []FailureRecord {
	// ASIC health check implementation
	return nil
}