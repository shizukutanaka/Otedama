package testing

import (
	"context"
	"fmt"
	"math/rand"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// ChaosEngineer implements chaos engineering for stability testing
// Following John Carmack's principle: "If you're not testing, you're guessing"
type ChaosEngineer struct {
	logger *zap.Logger
	config *ChaosConfig
	
	// Chaos experiments
	experiments     map[string]*Experiment
	experimentsMu   sync.RWMutex
	
	// Failure injection
	faultInjector   *FaultInjector
	
	// System monitors
	systemMonitor   *SystemMonitor
	recoveryMonitor *RecoveryMonitor
	
	// Experiment runner
	runner          *ExperimentRunner
	
	// Results collector
	resultsCollector *ResultsCollector
	
	// Safety mechanisms
	safetyController *SafetyController
	killSwitch       atomic.Bool
	
	// Metrics
	metrics         *ChaosMetrics
	
	// Lifecycle
	ctx             context.Context
	cancel          context.CancelFunc
	wg              sync.WaitGroup
}

// ChaosConfig contains chaos engineering configuration
type ChaosConfig struct {
	// Experiment settings
	ExperimentInterval    time.Duration
	MaxConcurrentExprs    int
	ExperimentTimeout     time.Duration
	
	// Failure injection
	FailureProbability    float64
	MaxFailureDuration    time.Duration
	GradualFailure        bool
	
	// Target components
	TargetComponents      []string
	ExcludedComponents    []string
	
	// Safety settings
	SafeMode              bool
	MaxImpactPercentage   float64
	AutoRecovery          bool
	RecoveryTimeout       time.Duration
	
	// Monitoring
	MonitoringInterval    time.Duration
	HealthCheckEndpoint   string
	MetricsEndpoint       string
	
	// Reporting
	ReportingEnabled      bool
	ReportingWebhook      string
}

// Experiment represents a chaos experiment
type Experiment struct {
	ID              string
	Name            string
	Description     string
	Type            ExperimentType
	Target          TargetSpec
	FailureSpec     FailureSpec
	Schedule        ScheduleSpec
	Validation      ValidationSpec
	Status          ExperimentStatus
	CreatedAt       time.Time
	LastRun         time.Time
	RunCount        atomic.Uint32
	SuccessCount    atomic.Uint32
	FailureCount    atomic.Uint32
}

// ExperimentType defines types of chaos experiments
type ExperimentType string

const (
	ExperimentNetworkDelay     ExperimentType = "network_delay"
	ExperimentNetworkPartition ExperimentType = "network_partition"
	ExperimentCPUStress        ExperimentType = "cpu_stress"
	ExperimentMemoryStress     ExperimentType = "memory_stress"
	ExperimentDiskStress       ExperimentType = "disk_stress"
	ExperimentProcessKill      ExperimentType = "process_kill"
	ExperimentTimeSkew         ExperimentType = "time_skew"
	ExperimentDNSFailure       ExperimentType = "dns_failure"
)

// TargetSpec specifies experiment targets
type TargetSpec struct {
	Components      []string
	Instances       []string
	Percentage      float64
	SelectionMode   SelectionMode
}

// SelectionMode defines how targets are selected
type SelectionMode string

const (
	SelectionRandom    SelectionMode = "random"
	SelectionRoundRobin SelectionMode = "round_robin"
	SelectionAll       SelectionMode = "all"
)

// FailureSpec defines failure characteristics
type FailureSpec struct {
	Intensity       float64
	Duration        time.Duration
	Delay           time.Duration
	Pattern         FailurePattern
	Parameters      map[string]interface{}
}

// FailurePattern defines failure patterns
type FailurePattern string

const (
	PatternConstant     FailurePattern = "constant"
	PatternGradual      FailurePattern = "gradual"
	PatternSpike        FailurePattern = "spike"
	PatternRandom       FailurePattern = "random"
	PatternPeriodic     FailurePattern = "periodic"
)

// ExperimentStatus represents experiment status
type ExperimentStatus string

const (
	StatusScheduled ExperimentStatus = "scheduled"
	StatusRunning   ExperimentStatus = "running"
	StatusCompleted ExperimentStatus = "completed"
	StatusFailed    ExperimentStatus = "failed"
	StatusAborted   ExperimentStatus = "aborted"
)

// ChaosMetrics tracks chaos engineering metrics
type ChaosMetrics struct {
	TotalExperiments      atomic.Uint64
	SuccessfulExperiments atomic.Uint64
	FailedExperiments     atomic.Uint64
	AbortedExperiments    atomic.Uint64
	InjectedFailures      atomic.Uint64
	SystemRecoveries      atomic.Uint64
	MTTR                  atomic.Uint64 // Mean Time To Recovery in seconds
	Availability          atomic.Uint64 // Percentage * 100
}

// NewChaosEngineer creates a new chaos engineer
func NewChaosEngineer(logger *zap.Logger, config *ChaosConfig) (*ChaosEngineer, error) {
	if config == nil {
		config = DefaultChaosConfig()
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	ce := &ChaosEngineer{
		logger:           logger,
		config:           config,
		experiments:      make(map[string]*Experiment),
		faultInjector:    NewFaultInjector(logger, config),
		systemMonitor:    NewSystemMonitor(logger, config),
		recoveryMonitor:  NewRecoveryMonitor(logger),
		runner:           NewExperimentRunner(logger, config),
		resultsCollector: NewResultsCollector(logger),
		safetyController: NewSafetyController(logger, config),
		metrics:          &ChaosMetrics{},
		ctx:              ctx,
		cancel:           cancel,
	}
	
	return ce, nil
}

// Start starts the chaos engineer
func (ce *ChaosEngineer) Start() error {
	ce.logger.Info("Starting chaos engineer",
		zap.Bool("safe_mode", ce.config.SafeMode),
		zap.Float64("failure_probability", ce.config.FailureProbability),
		zap.Duration("experiment_interval", ce.config.ExperimentInterval),
	)
	
	// Start system monitoring
	if err := ce.systemMonitor.Start(); err != nil {
		return fmt.Errorf("failed to start system monitor: %w", err)
	}
	
	// Start safety controller
	if err := ce.safetyController.Start(); err != nil {
		return fmt.Errorf("failed to start safety controller: %w", err)
	}
	
	// Start background workers
	ce.wg.Add(1)
	go ce.experimentLoop()
	
	ce.wg.Add(1)
	go ce.monitoringLoop()
	
	ce.wg.Add(1)
	go ce.recoveryLoop()
	
	return nil
}

// Stop stops the chaos engineer
func (ce *ChaosEngineer) Stop() error {
	ce.logger.Info("Stopping chaos engineer")
	
	// Activate kill switch
	ce.killSwitch.Store(true)
	
	// Stop all running experiments
	ce.stopAllExperiments()
	
	ce.cancel()
	ce.wg.Wait()
	
	// Stop monitors
	ce.systemMonitor.Stop()
	ce.safetyController.Stop()
	
	return nil
}

// CreateExperiment creates a new chaos experiment
func (ce *ChaosEngineer) CreateExperiment(spec ExperimentSpec) (*Experiment, error) {
	// Validate experiment
	if err := ce.validateExperiment(spec); err != nil {
		return nil, fmt.Errorf("invalid experiment: %w", err)
	}
	
	experiment := &Experiment{
		ID:          generateExperimentID(),
		Name:        spec.Name,
		Description: spec.Description,
		Type:        spec.Type,
		Target:      spec.Target,
		FailureSpec: spec.Failure,
		Schedule:    spec.Schedule,
		Validation:  spec.Validation,
		Status:      StatusScheduled,
		CreatedAt:   time.Now(),
	}
	
	ce.experimentsMu.Lock()
	ce.experiments[experiment.ID] = experiment
	ce.experimentsMu.Unlock()
	
	ce.logger.Info("Created chaos experiment",
		zap.String("id", experiment.ID),
		zap.String("name", experiment.Name),
		zap.String("type", string(experiment.Type)),
	)
	
	return experiment, nil
}

// RunExperiment runs a specific experiment
func (ce *ChaosEngineer) RunExperiment(experimentID string) (*ExperimentResult, error) {
	ce.experimentsMu.RLock()
	experiment, exists := ce.experiments[experimentID]
	ce.experimentsMu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("experiment not found: %s", experimentID)
	}
	
	// Check kill switch
	if ce.killSwitch.Load() {
		return nil, fmt.Errorf("kill switch activated")
	}
	
	// Check safety
	if !ce.safetyController.IsSafe() {
		return nil, fmt.Errorf("system not in safe state")
	}
	
	return ce.executeExperiment(experiment)
}

// GetExperimentResults returns results for an experiment
func (ce *ChaosEngineer) GetExperimentResults(experimentID string) ([]*ExperimentResult, error) {
	return ce.resultsCollector.GetResults(experimentID)
}

// GetMetrics returns chaos engineering metrics
func (ce *ChaosEngineer) GetMetrics() ChaosStats {
	total := ce.metrics.TotalExperiments.Load()
	successful := ce.metrics.SuccessfulExperiments.Load()
	
	successRate := float64(0)
	if total > 0 {
		successRate = float64(successful) / float64(total)
	}
	
	return ChaosStats{
		TotalExperiments:      total,
		SuccessRate:           successRate,
		InjectedFailures:      ce.metrics.InjectedFailures.Load(),
		SystemRecoveries:      ce.metrics.SystemRecoveries.Load(),
		MTTR:                  time.Duration(ce.metrics.MTTR.Load()) * time.Second,
		Availability:          float64(ce.metrics.Availability.Load()) / 100.0,
		ActiveExperiments:     ce.countActiveExperiments(),
		SystemHealth:          ce.systemMonitor.GetHealth(),
	}
}

// ActivateKillSwitch stops all chaos experiments immediately
func (ce *ChaosEngineer) ActivateKillSwitch() {
	ce.logger.Warn("Activating chaos kill switch")
	ce.killSwitch.Store(true)
	ce.stopAllExperiments()
}

// Private methods

func (ce *ChaosEngineer) experimentLoop() {
	defer ce.wg.Done()
	
	ticker := time.NewTicker(ce.config.ExperimentInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ce.runScheduledExperiments()
			
		case <-ce.ctx.Done():
			return
		}
	}
}

func (ce *ChaosEngineer) monitoringLoop() {
	defer ce.wg.Done()
	
	ticker := time.NewTicker(ce.config.MonitoringInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ce.updateSystemMetrics()
			
		case <-ce.ctx.Done():
			return
		}
	}
}

func (ce *ChaosEngineer) recoveryLoop() {
	defer ce.wg.Done()
	
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ce.checkRecoveries()
			
		case <-ce.ctx.Done():
			return
		}
	}
}

func (ce *ChaosEngineer) runScheduledExperiments() {
	ce.experimentsMu.RLock()
	experiments := make([]*Experiment, 0)
	for _, exp := range ce.experiments {
		if ce.shouldRunExperiment(exp) {
			experiments = append(experiments, exp)
		}
	}
	ce.experimentsMu.RUnlock()
	
	// Run experiments concurrently up to limit
	sem := make(chan struct{}, ce.config.MaxConcurrentExprs)
	var wg sync.WaitGroup
	
	for _, exp := range experiments {
		wg.Add(1)
		go func(experiment *Experiment) {
			defer wg.Done()
			
			sem <- struct{}{}
			defer func() { <-sem }()
			
			_, err := ce.executeExperiment(experiment)
			if err != nil {
				ce.logger.Error("Experiment failed",
					zap.String("id", experiment.ID),
					zap.Error(err),
				)
			}
		}(exp)
	}
	
	wg.Wait()
}

func (ce *ChaosEngineer) executeExperiment(experiment *Experiment) (*ExperimentResult, error) {
	ce.logger.Info("Executing chaos experiment",
		zap.String("id", experiment.ID),
		zap.String("type", string(experiment.Type)),
	)
	
	// Update status
	experiment.Status = StatusRunning
	experiment.LastRun = time.Now()
	experiment.RunCount.Add(1)
	ce.metrics.TotalExperiments.Add(1)
	
	// Create experiment context
	ctx, cancel := context.WithTimeout(ce.ctx, ce.config.ExperimentTimeout)
	defer cancel()
	
	// Record initial state
	initialState := ce.systemMonitor.CaptureState()
	
	// Execute experiment
	start := time.Now()
	err := ce.runner.RunExperiment(ctx, experiment)
	duration := time.Since(start)
	
	// Record final state
	finalState := ce.systemMonitor.CaptureState()
	
	// Create result
	result := &ExperimentResult{
		ExperimentID:   experiment.ID,
		StartTime:      start,
		EndTime:        time.Now(),
		Duration:       duration,
		InitialState:   initialState,
		FinalState:     finalState,
	}
	
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		experiment.Status = StatusFailed
		experiment.FailureCount.Add(1)
		ce.metrics.FailedExperiments.Add(1)
	} else {
		result.Success = true
		experiment.Status = StatusCompleted
		experiment.SuccessCount.Add(1)
		ce.metrics.SuccessfulExperiments.Add(1)
		
		// Validate experiment results
		result.ValidationResult = ce.validateResults(experiment, initialState, finalState)
	}
	
	// Store result
	ce.resultsCollector.StoreResult(result)
	
	// Check if recovery is needed
	if ce.config.AutoRecovery && !ce.systemMonitor.IsHealthy() {
		ce.triggerRecovery(experiment)
	}
	
	return result, nil
}

func (ce *ChaosEngineer) validateExperiment(spec ExperimentSpec) error {
	// Validate experiment type
	validTypes := map[ExperimentType]bool{
		ExperimentNetworkDelay:     true,
		ExperimentNetworkPartition: true,
		ExperimentCPUStress:        true,
		ExperimentMemoryStress:     true,
		ExperimentDiskStress:       true,
		ExperimentProcessKill:      true,
		ExperimentTimeSkew:         true,
		ExperimentDNSFailure:       true,
	}
	
	if !validTypes[spec.Type] {
		return fmt.Errorf("invalid experiment type: %s", spec.Type)
	}
	
	// Validate target
	if len(spec.Target.Components) == 0 && len(spec.Target.Instances) == 0 {
		return fmt.Errorf("no targets specified")
	}
	
	// Validate failure spec
	if spec.Failure.Duration > ce.config.MaxFailureDuration {
		return fmt.Errorf("failure duration exceeds maximum: %v > %v",
			spec.Failure.Duration, ce.config.MaxFailureDuration)
	}
	
	// Check safety limits
	if spec.Target.Percentage > ce.config.MaxImpactPercentage {
		return fmt.Errorf("target percentage exceeds safety limit: %.2f%% > %.2f%%",
			spec.Target.Percentage, ce.config.MaxImpactPercentage)
	}
	
	return nil
}

func (ce *ChaosEngineer) shouldRunExperiment(experiment *Experiment) bool {
	// Check if scheduled
	if experiment.Status != StatusScheduled {
		return false
	}
	
	// Check schedule
	now := time.Now()
	if experiment.Schedule.StartTime.After(now) {
		return false
	}
	
	if !experiment.Schedule.EndTime.IsZero() && experiment.Schedule.EndTime.Before(now) {
		return false
	}
	
	// Check frequency
	if !experiment.LastRun.IsZero() {
		timeSinceLastRun := now.Sub(experiment.LastRun)
		if timeSinceLastRun < experiment.Schedule.Frequency {
			return false
		}
	}
	
	return true
}

func (ce *ChaosEngineer) validateResults(experiment *Experiment, initial, final *SystemState) *ValidationResult {
	validation := &ValidationResult{
		Passed: true,
	}
	
	// Check availability
	availability := ce.calculateAvailability(initial, final)
	if availability < experiment.Validation.MinAvailability {
		validation.Passed = false
		validation.Failures = append(validation.Failures,
			fmt.Sprintf("Availability below threshold: %.2f%% < %.2f%%",
				availability*100, experiment.Validation.MinAvailability*100))
	}
	
	// Check recovery time
	recoveryTime := ce.measureRecoveryTime(experiment)
	if recoveryTime > experiment.Validation.MaxRecoveryTime {
		validation.Passed = false
		validation.Failures = append(validation.Failures,
			fmt.Sprintf("Recovery time exceeded: %v > %v",
				recoveryTime, experiment.Validation.MaxRecoveryTime))
	}
	
	// Check error rate
	errorRate := ce.calculateErrorRate(final)
	if errorRate > experiment.Validation.MaxErrorRate {
		validation.Passed = false
		validation.Failures = append(validation.Failures,
			fmt.Sprintf("Error rate exceeded: %.2f%% > %.2f%%",
				errorRate*100, experiment.Validation.MaxErrorRate*100))
	}
	
	validation.Metrics = map[string]float64{
		"availability":  availability,
		"recovery_time": recoveryTime.Seconds(),
		"error_rate":    errorRate,
	}
	
	return validation
}

func (ce *ChaosEngineer) triggerRecovery(experiment *Experiment) {
	ce.logger.Info("Triggering recovery",
		zap.String("experiment_id", experiment.ID),
	)
	
	recoveryStart := time.Now()
	
	// Stop the experiment
	ce.runner.StopExperiment(experiment)
	
	// Wait for system to recover
	ctx, cancel := context.WithTimeout(ce.ctx, ce.config.RecoveryTimeout)
	defer cancel()
	
	recovered := ce.recoveryMonitor.WaitForRecovery(ctx)
	
	if recovered {
		recoveryTime := time.Since(recoveryStart)
		ce.metrics.SystemRecoveries.Add(1)
		
		// Update MTTR
		currentMTTR := ce.metrics.MTTR.Load()
		newMTTR := (currentMTTR*9 + uint64(recoveryTime.Seconds())) / 10
		ce.metrics.MTTR.Store(newMTTR)
		
		ce.logger.Info("System recovered",
			zap.Duration("recovery_time", recoveryTime),
		)
	} else {
		ce.logger.Error("System recovery failed",
			zap.String("experiment_id", experiment.ID),
		)
	}
}

func (ce *ChaosEngineer) stopAllExperiments() {
	ce.experimentsMu.RLock()
	running := make([]*Experiment, 0)
	for _, exp := range ce.experiments {
		if exp.Status == StatusRunning {
			running = append(running, exp)
		}
	}
	ce.experimentsMu.RUnlock()
	
	for _, exp := range running {
		ce.runner.StopExperiment(exp)
		exp.Status = StatusAborted
		ce.metrics.AbortedExperiments.Add(1)
	}
}

func (ce *ChaosEngineer) updateSystemMetrics() {
	health := ce.systemMonitor.GetHealth()
	availability := uint64(health.Availability * 100)
	ce.metrics.Availability.Store(availability)
}

func (ce *ChaosEngineer) checkRecoveries() {
	// Check if any failed experiments need recovery
	ce.experimentsMu.RLock()
	defer ce.experimentsMu.RUnlock()
	
	for _, exp := range ce.experiments {
		if exp.Status == StatusFailed && !ce.systemMonitor.IsHealthy() {
			ce.triggerRecovery(exp)
		}
	}
}

func (ce *ChaosEngineer) countActiveExperiments() int {
	ce.experimentsMu.RLock()
	defer ce.experimentsMu.RUnlock()
	
	count := 0
	for _, exp := range ce.experiments {
		if exp.Status == StatusRunning {
			count++
		}
	}
	return count
}

func (ce *ChaosEngineer) calculateAvailability(initial, final *SystemState) float64 {
	// Simplified availability calculation
	if initial.HealthyInstances == 0 {
		return 0
	}
	return float64(final.HealthyInstances) / float64(initial.HealthyInstances)
}

func (ce *ChaosEngineer) measureRecoveryTime(experiment *Experiment) time.Duration {
	// Get recovery events for this experiment
	events := ce.recoveryMonitor.GetRecoveryEvents(experiment.ID)
	if len(events) == 0 {
		return 0
	}
	
	// Calculate average recovery time
	total := time.Duration(0)
	for _, event := range events {
		total += event.Duration
	}
	
	return total / time.Duration(len(events))
}

func (ce *ChaosEngineer) calculateErrorRate(state *SystemState) float64 {
	if state.TotalRequests == 0 {
		return 0
	}
	return float64(state.FailedRequests) / float64(state.TotalRequests)
}

// Helper components

// FaultInjector injects failures into the system
type FaultInjector struct {
	logger    *zap.Logger
	config    *ChaosConfig
	injectors map[ExperimentType]Injector
}

type Injector interface {
	Inject(target string, spec FailureSpec) error
	Remove(target string) error
}

func NewFaultInjector(logger *zap.Logger, config *ChaosConfig) *FaultInjector {
	fi := &FaultInjector{
		logger:    logger,
		config:    config,
		injectors: make(map[ExperimentType]Injector),
	}
	
	// Register injectors
	fi.injectors[ExperimentNetworkDelay] = NewNetworkDelayInjector()
	fi.injectors[ExperimentCPUStress] = NewCPUStressInjector()
	fi.injectors[ExperimentMemoryStress] = NewMemoryStressInjector()
	fi.injectors[ExperimentProcessKill] = NewProcessKillInjector()
	
	return fi
}

func (fi *FaultInjector) InjectFailure(experiment *Experiment) error {
	injector, exists := fi.injectors[experiment.Type]
	if !exists {
		return fmt.Errorf("no injector for experiment type: %s", experiment.Type)
	}
	
	// Select targets
	targets := fi.selectTargets(experiment.Target)
	
	// Inject failure into each target
	for _, target := range targets {
		if err := injector.Inject(target, experiment.FailureSpec); err != nil {
			return fmt.Errorf("failed to inject failure into %s: %w", target, err)
		}
	}
	
	return nil
}

func (fi *FaultInjector) RemoveFailure(experiment *Experiment) error {
	injector, exists := fi.injectors[experiment.Type]
	if !exists {
		return nil
	}
	
	targets := fi.selectTargets(experiment.Target)
	for _, target := range targets {
		injector.Remove(target)
	}
	
	return nil
}

func (fi *FaultInjector) selectTargets(spec TargetSpec) []string {
	targets := make([]string, 0)
	
	// Add specific instances
	targets = append(targets, spec.Instances...)
	
	// Add components based on selection mode
	switch spec.SelectionMode {
	case SelectionAll:
		targets = append(targets, spec.Components...)
	case SelectionRandom:
		if len(spec.Components) > 0 {
			count := int(float64(len(spec.Components)) * spec.Percentage / 100.0)
			if count == 0 {
				count = 1
			}
			selected := fi.randomSelect(spec.Components, count)
			targets = append(targets, selected...)
		}
	}
	
	return targets
}

func (fi *FaultInjector) randomSelect(items []string, count int) []string {
	if count >= len(items) {
		return items
	}
	
	selected := make([]string, 0, count)
	indices := rand.Perm(len(items))
	
	for i := 0; i < count; i++ {
		selected = append(selected, items[indices[i]])
	}
	
	return selected
}

// Network delay injector
type NetworkDelayInjector struct{}

func NewNetworkDelayInjector() *NetworkDelayInjector {
	return &NetworkDelayInjector{}
}

func (ndi *NetworkDelayInjector) Inject(target string, spec FailureSpec) error {
	// In production, would use tc (traffic control) or similar
	// This is a simplified implementation
	delay := spec.Parameters["delay"].(time.Duration)
	jitter := spec.Parameters["jitter"].(time.Duration)
	
	// Simulate network delay injection
	fmt.Printf("Injecting network delay: target=%s, delay=%v, jitter=%v\n",
		target, delay, jitter)
	
	return nil
}

func (ndi *NetworkDelayInjector) Remove(target string) error {
	fmt.Printf("Removing network delay: target=%s\n", target)
	return nil
}

// CPU stress injector
type CPUStressInjector struct{}

func NewCPUStressInjector() *CPUStressInjector {
	return &CPUStressInjector{}
}

func (csi *CPUStressInjector) Inject(target string, spec FailureSpec) error {
	// Simulate CPU stress
	cores := int(spec.Intensity * float64(runtime.NumCPU()))
	fmt.Printf("Injecting CPU stress: target=%s, cores=%d\n", target, cores)
	return nil
}

func (csi *CPUStressInjector) Remove(target string) error {
	fmt.Printf("Removing CPU stress: target=%s\n", target)
	return nil
}

// Memory stress injector
type MemoryStressInjector struct{}

func NewMemoryStressInjector() *MemoryStressInjector {
	return &MemoryStressInjector{}
}

func (msi *MemoryStressInjector) Inject(target string, spec FailureSpec) error {
	// Simulate memory stress
	memoryMB := int(spec.Intensity * 1024)
	fmt.Printf("Injecting memory stress: target=%s, memory=%dMB\n", target, memoryMB)
	return nil
}

func (msi *MemoryStressInjector) Remove(target string) error {
	fmt.Printf("Removing memory stress: target=%s\n", target)
	return nil
}

// Process kill injector
type ProcessKillInjector struct{}

func NewProcessKillInjector() *ProcessKillInjector {
	return &ProcessKillInjector{}
}

func (pki *ProcessKillInjector) Inject(target string, spec FailureSpec) error {
	// Simulate process kill
	fmt.Printf("Killing process: target=%s\n", target)
	return nil
}

func (pki *ProcessKillInjector) Remove(target string) error {
	// Process kill doesn't need removal
	return nil
}

// SystemMonitor monitors system health
type SystemMonitor struct {
	logger        *zap.Logger
	config        *ChaosConfig
	currentHealth atomic.Value // *SystemHealth
	history       []*SystemState
	historyMu     sync.RWMutex
}

func NewSystemMonitor(logger *zap.Logger, config *ChaosConfig) *SystemMonitor {
	sm := &SystemMonitor{
		logger:  logger,
		config:  config,
		history: make([]*SystemState, 0, 1000),
	}
	
	sm.currentHealth.Store(&SystemHealth{
		Healthy:      true,
		Availability: 1.0,
	})
	
	return sm
}

func (sm *SystemMonitor) Start() error {
	// Start monitoring
	return nil
}

func (sm *SystemMonitor) Stop() {
	// Stop monitoring
}

func (sm *SystemMonitor) CaptureState() *SystemState {
	// Capture current system state
	state := &SystemState{
		Timestamp:        time.Now(),
		HealthyInstances: 10, // Simulated
		TotalInstances:   10,
		CPUUsage:         0.5,
		MemoryUsage:      0.6,
		NetworkLatency:   10 * time.Millisecond,
		TotalRequests:    1000,
		FailedRequests:   5,
	}
	
	sm.historyMu.Lock()
	sm.history = append(sm.history, state)
	if len(sm.history) > 1000 {
		sm.history = sm.history[500:]
	}
	sm.historyMu.Unlock()
	
	return state
}

func (sm *SystemMonitor) GetHealth() *SystemHealth {
	return sm.currentHealth.Load().(*SystemHealth)
}

func (sm *SystemMonitor) IsHealthy() bool {
	health := sm.GetHealth()
	return health.Healthy && health.Availability > 0.9
}

// RecoveryMonitor monitors system recovery
type RecoveryMonitor struct {
	logger         *zap.Logger
	recoveryEvents map[string][]*RecoveryEvent
	eventsMu       sync.RWMutex
}

func NewRecoveryMonitor(logger *zap.Logger) *RecoveryMonitor {
	return &RecoveryMonitor{
		logger:         logger,
		recoveryEvents: make(map[string][]*RecoveryEvent),
	}
}

func (rm *RecoveryMonitor) WaitForRecovery(ctx context.Context) bool {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			// Check if system is healthy
			// In production, would check actual system health
			if rand.Float64() > 0.2 { // 80% chance of recovery
				return true
			}
			
		case <-ctx.Done():
			return false
		}
	}
}

func (rm *RecoveryMonitor) GetRecoveryEvents(experimentID string) []*RecoveryEvent {
	rm.eventsMu.RLock()
	defer rm.eventsMu.RUnlock()
	
	return rm.recoveryEvents[experimentID]
}

func (rm *RecoveryMonitor) RecordRecoveryEvent(event *RecoveryEvent) {
	rm.eventsMu.Lock()
	defer rm.eventsMu.Unlock()
	
	rm.recoveryEvents[event.ExperimentID] = append(
		rm.recoveryEvents[event.ExperimentID], event)
}

// ExperimentRunner runs chaos experiments
type ExperimentRunner struct {
	logger         *zap.Logger
	config         *ChaosConfig
	faultInjector  *FaultInjector
	runningExprs   map[string]context.CancelFunc
	runningMu      sync.RWMutex
}

func NewExperimentRunner(logger *zap.Logger, config *ChaosConfig) *ExperimentRunner {
	return &ExperimentRunner{
		logger:        logger,
		config:        config,
		faultInjector: NewFaultInjector(logger, config),
		runningExprs:  make(map[string]context.CancelFunc),
	}
}

func (er *ExperimentRunner) RunExperiment(ctx context.Context, experiment *Experiment) error {
	// Create cancellable context
	expCtx, cancel := context.WithCancel(ctx)
	
	er.runningMu.Lock()
	er.runningExprs[experiment.ID] = cancel
	er.runningMu.Unlock()
	
	defer func() {
		er.runningMu.Lock()
		delete(er.runningExprs, experiment.ID)
		er.runningMu.Unlock()
	}()
	
	// Apply delay if specified
	if experiment.FailureSpec.Delay > 0 {
		select {
		case <-time.After(experiment.FailureSpec.Delay):
		case <-expCtx.Done():
			return expCtx.Err()
		}
	}
	
	// Inject failure
	if err := er.faultInjector.InjectFailure(experiment); err != nil {
		return err
	}
	
	// Wait for duration
	select {
	case <-time.After(experiment.FailureSpec.Duration):
	case <-expCtx.Done():
	}
	
	// Remove failure
	return er.faultInjector.RemoveFailure(experiment)
}

func (er *ExperimentRunner) StopExperiment(experiment *Experiment) {
	er.runningMu.RLock()
	cancel, exists := er.runningExprs[experiment.ID]
	er.runningMu.RUnlock()
	
	if exists {
		cancel()
	}
	
	// Remove any injected failures
	er.faultInjector.RemoveFailure(experiment)
}

// ResultsCollector collects experiment results
type ResultsCollector struct {
	logger    *zap.Logger
	results   map[string][]*ExperimentResult
	resultsMu sync.RWMutex
}

func NewResultsCollector(logger *zap.Logger) *ResultsCollector {
	return &ResultsCollector{
		logger:  logger,
		results: make(map[string][]*ExperimentResult),
	}
}

func (rc *ResultsCollector) StoreResult(result *ExperimentResult) {
	rc.resultsMu.Lock()
	defer rc.resultsMu.Unlock()
	
	rc.results[result.ExperimentID] = append(
		rc.results[result.ExperimentID], result)
	
	// Keep only recent results
	if len(rc.results[result.ExperimentID]) > 100 {
		rc.results[result.ExperimentID] = rc.results[result.ExperimentID][50:]
	}
}

func (rc *ResultsCollector) GetResults(experimentID string) ([]*ExperimentResult, error) {
	rc.resultsMu.RLock()
	defer rc.resultsMu.RUnlock()
	
	results, exists := rc.results[experimentID]
	if !exists {
		return nil, fmt.Errorf("no results for experiment: %s", experimentID)
	}
	
	return results, nil
}

// SafetyController ensures experiments don't cause critical failures
type SafetyController struct {
	logger          *zap.Logger
	config          *ChaosConfig
	safetyChecks    []SafetyCheck
	safetyViolations atomic.Uint32
}

type SafetyCheck interface {
	IsSafe() bool
	GetName() string
}

func NewSafetyController(logger *zap.Logger, config *ChaosConfig) *SafetyController {
	sc := &SafetyController{
		logger:       logger,
		config:       config,
		safetyChecks: make([]SafetyCheck, 0),
	}
	
	// Add default safety checks
	sc.safetyChecks = append(sc.safetyChecks,
		NewHealthCheck(),
		NewResourceCheck(),
		NewAvailabilityCheck(),
	)
	
	return sc
}

func (sc *SafetyController) Start() error {
	return nil
}

func (sc *SafetyController) Stop() {
	// Stop safety checks
}

func (sc *SafetyController) IsSafe() bool {
	if !sc.config.SafeMode {
		return true
	}
	
	for _, check := range sc.safetyChecks {
		if !check.IsSafe() {
			sc.safetyViolations.Add(1)
			sc.logger.Warn("Safety check failed",
				zap.String("check", check.GetName()),
			)
			return false
		}
	}
	
	return true
}

// Basic safety checks

type HealthCheck struct{}

func NewHealthCheck() *HealthCheck {
	return &HealthCheck{}
}

func (hc *HealthCheck) IsSafe() bool {
	// Check system health
	return true // Simplified
}

func (hc *HealthCheck) GetName() string {
	return "health_check"
}

type ResourceCheck struct{}

func NewResourceCheck() *ResourceCheck {
	return &ResourceCheck{}
}

func (rc *ResourceCheck) IsSafe() bool {
	// Check resource usage
	return true // Simplified
}

func (rc *ResourceCheck) GetName() string {
	return "resource_check"
}

type AvailabilityCheck struct{}

func NewAvailabilityCheck() *AvailabilityCheck {
	return &AvailabilityCheck{}
}

func (ac *AvailabilityCheck) IsSafe() bool {
	// Check service availability
	return true // Simplified
}

func (ac *AvailabilityCheck) GetName() string {
	return "availability_check"
}

// Helper structures

type ExperimentSpec struct {
	Name        string
	Description string
	Type        ExperimentType
	Target      TargetSpec
	Failure     FailureSpec
	Schedule    ScheduleSpec
	Validation  ValidationSpec
}

type ScheduleSpec struct {
	StartTime time.Time
	EndTime   time.Time
	Frequency time.Duration
	RunCount  int
}

type ValidationSpec struct {
	MinAvailability float64
	MaxRecoveryTime time.Duration
	MaxErrorRate    float64
	CustomChecks    []string
}

type ExperimentResult struct {
	ExperimentID     string
	StartTime        time.Time
	EndTime          time.Time
	Duration         time.Duration
	Success          bool
	Error            string
	InitialState     *SystemState
	FinalState       *SystemState
	ValidationResult *ValidationResult
	Metrics          map[string]float64
}

type SystemState struct {
	Timestamp        time.Time
	HealthyInstances int
	TotalInstances   int
	CPUUsage         float64
	MemoryUsage      float64
	NetworkLatency   time.Duration
	TotalRequests    int64
	FailedRequests   int64
}

type SystemHealth struct {
	Healthy       bool
	Availability  float64
	ErrorRate     float64
	Latency       time.Duration
	LastChecked   time.Time
}

type ValidationResult struct {
	Passed   bool
	Failures []string
	Metrics  map[string]float64
}

type RecoveryEvent struct {
	ExperimentID string
	StartTime    time.Time
	EndTime      time.Time
	Duration     time.Duration
	Successful   bool
}

type ChaosStats struct {
	TotalExperiments  uint64
	SuccessRate       float64
	InjectedFailures  uint64
	SystemRecoveries  uint64
	MTTR              time.Duration
	Availability      float64
	ActiveExperiments int
	SystemHealth      *SystemHealth
}

// Utility functions

func generateExperimentID() string {
	return fmt.Sprintf("exp_%d_%d", time.Now().Unix(), rand.Intn(10000))
}

// DefaultChaosConfig returns default chaos configuration
func DefaultChaosConfig() *ChaosConfig {
	return &ChaosConfig{
		ExperimentInterval:  5 * time.Minute,
		MaxConcurrentExprs:  3,
		ExperimentTimeout:   30 * time.Minute,
		FailureProbability:  0.1,
		MaxFailureDuration:  10 * time.Minute,
		GradualFailure:      true,
		TargetComponents:    []string{"api", "worker", "database"},
		ExcludedComponents:  []string{"critical-service"},
		SafeMode:            true,
		MaxImpactPercentage: 30.0,
		AutoRecovery:        true,
		RecoveryTimeout:     5 * time.Minute,
		MonitoringInterval:  30 * time.Second,
		HealthCheckEndpoint: "http://localhost:8080/health",
		MetricsEndpoint:     "http://localhost:9090/metrics",
		ReportingEnabled:    true,
	}
}