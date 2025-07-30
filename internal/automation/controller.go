package automation

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/otedama/otedama/internal/core"
	"github.com/otedama/otedama/internal/mining"
	"github.com/otedama/otedama/internal/monitoring"
	"github.com/otedama/otedama/internal/optimization"
	"go.uber.org/zap"
)

// AutomationController provides intelligent system automation
// Following John Carmack's principle: "Automation should make things better, not just different"
type AutomationController struct {
	logger   *zap.Logger
	config   *AutomationConfig
	
	// Core components
	miningEngine     *mining.UnifiedEngine
	monitoringServer *monitoring.MonitoringServer
	profiler         *optimization.PerformanceProfiler
	recovery         *core.EnhancedRecoverySystem
	
	// Automation state
	running          atomic.Bool
	automationLevel  atomic.Int32 // 0-100
	
	// Decision engine
	decisionEngine   *DecisionEngine
	
	// Automation modules
	autoScaler       *AutoScaler
	selfHealer       *SelfHealer
	algorithmOptimizer *AlgorithmOptimizer
	resourceManager  *ResourceManager
	
	// Metrics
	decisions        atomic.Uint64
	actionsExecuted  atomic.Uint64
	improvements     atomic.Uint64
	
	// Lifecycle
	ctx              context.Context
	cancel           context.CancelFunc
	wg               sync.WaitGroup
}

// AutomationConfig contains automation settings
type AutomationConfig struct {
	// Automation levels
	EnableAutoScaling       bool
	EnableSelfHealing       bool
	EnableAlgorithmSwitch   bool
	EnableResourceOptimization bool
	
	// Thresholds
	ScaleUpThreshold        float64 // CPU usage %
	ScaleDownThreshold      float64
	MemoryThreshold         float64 // Memory usage %
	ErrorRateThreshold      float64 // Error rate %
	
	// Timing
	DecisionInterval        time.Duration
	ActionCooldown          time.Duration
	MetricsWindow           time.Duration
	
	// Limits
	MaxWorkers              int
	MinWorkers              int
	MaxMemoryGB             int
	
	// Intelligence
	LearningEnabled         bool
	PredictiveScaling       bool
	AnomalyDetection        bool
}

// DecisionEngine makes intelligent decisions
type DecisionEngine struct {
	logger           *zap.Logger
	history          *DecisionHistory
	rules            []AutomationRule
	learningModel    *LearningModel
}

// AutomationRule defines a condition-action pair
type AutomationRule struct {
	Name            string
	Condition       func(*SystemState) bool
	Action          func(context.Context) error
	Priority        int
	Cooldown        time.Duration
	LastExecuted    atomic.Int64
}

// SystemState represents current system state
type SystemState struct {
	Timestamp       time.Time
	
	// Resource metrics
	CPUUsage        float64
	MemoryUsage     float64
	DiskUsage       float64
	NetworkBandwidth float64
	
	// Mining metrics
	HashRate        float64
	ShareRate       float64
	AcceptanceRate  float64
	WorkerCount     int
	
	// Health metrics
	ErrorRate       float64
	ResponseTime    time.Duration
	SystemHealth    int32
	
	// Network metrics
	PeerCount       int
	NetworkLatency  time.Duration
}

// NewAutomationController creates a new automation controller
func NewAutomationController(logger *zap.Logger, config *AutomationConfig) *AutomationController {
	if config == nil {
		config = DefaultAutomationConfig()
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	controller := &AutomationController{
		logger: logger,
		config: config,
		ctx:    ctx,
		cancel: cancel,
	}
	
	// Initialize decision engine
	controller.decisionEngine = NewDecisionEngine(logger)
	
	// Initialize automation modules
	controller.autoScaler = NewAutoScaler(logger, config)
	controller.selfHealer = NewSelfHealer(logger)
	controller.algorithmOptimizer = NewAlgorithmOptimizer(logger)
	controller.resourceManager = NewResourceManager(logger, config)
	
	// Set default automation level
	controller.automationLevel.Store(50) // Medium automation
	
	return controller
}

// SetComponents sets the components to be automated
func (ac *AutomationController) SetComponents(
	miningEngine *mining.UnifiedEngine,
	monitoringServer *monitoring.MonitoringServer,
	profiler *optimization.PerformanceProfiler,
	recovery *core.EnhancedRecoverySystem,
) {
	ac.miningEngine = miningEngine
	ac.monitoringServer = monitoringServer
	ac.profiler = profiler
	ac.recovery = recovery
	
	// Register rules based on components
	ac.registerAutomationRules()
}

// Start starts the automation controller
func (ac *AutomationController) Start() error {
	if !ac.running.CompareAndSwap(false, true) {
		return fmt.Errorf("automation controller already running")
	}
	
	ac.logger.Info("Starting automation controller",
		zap.Int32("automation_level", ac.automationLevel.Load()),
		zap.Bool("auto_scaling", ac.config.EnableAutoScaling),
		zap.Bool("self_healing", ac.config.EnableSelfHealing),
	)
	
	// Start decision loop
	ac.wg.Add(1)
	go ac.decisionLoop()
	
	// Start monitoring
	ac.wg.Add(1)
	go ac.monitoringLoop()
	
	// Start learning if enabled
	if ac.config.LearningEnabled {
		ac.wg.Add(1)
		go ac.learningLoop()
	}
	
	return nil
}

// Stop stops the automation controller
func (ac *AutomationController) Stop() error {
	if !ac.running.CompareAndSwap(true, false) {
		return fmt.Errorf("automation controller not running")
	}
	
	ac.logger.Info("Stopping automation controller")
	
	// Cancel context
	ac.cancel()
	
	// Wait for goroutines
	ac.wg.Wait()
	
	// Log final stats
	ac.logger.Info("Automation controller stopped",
		zap.Uint64("decisions_made", ac.decisions.Load()),
		zap.Uint64("actions_executed", ac.actionsExecuted.Load()),
		zap.Uint64("improvements", ac.improvements.Load()),
	)
	
	return nil
}

// SetAutomationLevel sets the automation level (0-100)
func (ac *AutomationController) SetAutomationLevel(level int32) {
	if level < 0 {
		level = 0
	} else if level > 100 {
		level = 100
	}
	
	ac.automationLevel.Store(level)
	ac.logger.Info("Automation level changed", zap.Int32("level", level))
}

// Private methods

func (ac *AutomationController) decisionLoop() {
	defer ac.wg.Done()
	
	ticker := time.NewTicker(ac.config.DecisionInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ac.makeDecisions()
			
		case <-ac.ctx.Done():
			return
		}
	}
}

func (ac *AutomationController) makeDecisions() {
	// Get current system state
	state := ac.getCurrentState()
	
	// Let decision engine analyze
	decisions := ac.decisionEngine.Analyze(state)
	
	// Execute decisions based on automation level
	automationLevel := ac.automationLevel.Load()
	
	for _, decision := range decisions {
		// Check if automation level allows this decision
		if decision.RequiredLevel > automationLevel {
			ac.logger.Debug("Decision skipped due to automation level",
				zap.String("decision", decision.Name),
				zap.Int32("required_level", decision.RequiredLevel),
			)
			continue
		}
		
		// Execute action
		if err := ac.executeDecision(decision); err != nil {
			ac.logger.Error("Failed to execute decision",
				zap.String("decision", decision.Name),
				zap.Error(err),
			)
		} else {
			ac.actionsExecuted.Add(1)
		}
	}
	
	ac.decisions.Add(uint64(len(decisions)))
}

func (ac *AutomationController) getCurrentState() *SystemState {
	state := &SystemState{
		Timestamp: time.Now(),
	}
	
	// Get resource metrics
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	
	state.CPUUsage = ac.getCPUUsage()
	state.MemoryUsage = float64(memStats.Alloc) / float64(memStats.Sys) * 100
	
	// Get mining metrics if available
	if ac.miningEngine != nil {
		stats := ac.miningEngine.GetStats()
		state.HashRate = stats.CurrentHashRate
		state.WorkerCount = stats.ActiveWorkers
		if stats.SharesSubmitted > 0 {
			state.AcceptanceRate = float64(stats.SharesAccepted) / float64(stats.SharesSubmitted)
		}
	}
	
	// Get health metrics
	if ac.recovery != nil {
		state.SystemHealth = ac.recovery.GetSystemHealth()
	}
	
	return state
}

func (ac *AutomationController) executeDecision(decision *Decision) error {
	ac.logger.Info("Executing automation decision",
		zap.String("decision", decision.Name),
		zap.String("action", decision.Action),
	)
	
	// Use recovery system for safe execution
	if ac.recovery != nil {
		return ac.recovery.Execute(ac.ctx, "automation_"+decision.Name, func() error {
			return decision.Execute(ac.ctx)
		})
	}
	
	return decision.Execute(ac.ctx)
}

func (ac *AutomationController) monitoringLoop() {
	defer ac.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ac.collectMetrics()
			
		case <-ac.ctx.Done():
			return
		}
	}
}

func (ac *AutomationController) collectMetrics() {
	// Collect performance metrics
	if ac.profiler != nil {
		metrics := ac.profiler.GetMetrics()
		
		// Check for improvements
		if metrics.HashRate > 0 {
			// Simple improvement detection
			ac.improvements.Add(1)
		}
	}
}

func (ac *AutomationController) learningLoop() {
	defer ac.wg.Done()
	
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ac.updateLearningModel()
			
		case <-ac.ctx.Done():
			return
		}
	}
}

func (ac *AutomationController) updateLearningModel() {
	// Update learning model with recent data
	ac.decisionEngine.UpdateModel()
}

func (ac *AutomationController) registerAutomationRules() {
	// Auto-scaling rules
	if ac.config.EnableAutoScaling {
		ac.decisionEngine.AddRule(&AutomationRule{
			Name: "scale_up_workers",
			Condition: func(state *SystemState) bool {
				return state.CPUUsage > ac.config.ScaleUpThreshold &&
					state.WorkerCount < ac.config.MaxWorkers
			},
			Action: func(ctx context.Context) error {
				return ac.autoScaler.ScaleUp(ctx, ac.miningEngine)
			},
			Priority: 10,
			Cooldown: ac.config.ActionCooldown,
		})
		
		ac.decisionEngine.AddRule(&AutomationRule{
			Name: "scale_down_workers",
			Condition: func(state *SystemState) bool {
				return state.CPUUsage < ac.config.ScaleDownThreshold &&
					state.WorkerCount > ac.config.MinWorkers
			},
			Action: func(ctx context.Context) error {
				return ac.autoScaler.ScaleDown(ctx, ac.miningEngine)
			},
			Priority: 5,
			Cooldown: ac.config.ActionCooldown * 2,
		})
	}
	
	// Self-healing rules
	if ac.config.EnableSelfHealing {
		ac.decisionEngine.AddRule(&AutomationRule{
			Name: "heal_high_error_rate",
			Condition: func(state *SystemState) bool {
				return state.ErrorRate > ac.config.ErrorRateThreshold
			},
			Action: func(ctx context.Context) error {
				return ac.selfHealer.HealErrorRate(ctx, ac.miningEngine)
			},
			Priority: 20,
			Cooldown: ac.config.ActionCooldown,
		})
		
		ac.decisionEngine.AddRule(&AutomationRule{
			Name: "heal_low_acceptance",
			Condition: func(state *SystemState) bool {
				return state.AcceptanceRate < 0.9 && state.HashRate > 0
			},
			Action: func(ctx context.Context) error {
				return ac.selfHealer.HealAcceptanceRate(ctx, ac.miningEngine)
			},
			Priority: 15,
			Cooldown: ac.config.ActionCooldown,
		})
	}
	
	// Algorithm optimization rules
	if ac.config.EnableAlgorithmSwitch {
		ac.decisionEngine.AddRule(&AutomationRule{
			Name: "optimize_algorithm",
			Condition: func(state *SystemState) bool {
				// Switch algorithm if hash rate is below expected
				return state.HashRate < ac.algorithmOptimizer.GetExpectedHashRate(state)
			},
			Action: func(ctx context.Context) error {
				return ac.algorithmOptimizer.OptimizeAlgorithm(ctx, ac.miningEngine, state)
			},
			Priority: 8,
			Cooldown: 10 * time.Minute,
		})
	}
	
	// Resource optimization rules
	if ac.config.EnableResourceOptimization {
		ac.decisionEngine.AddRule(&AutomationRule{
			Name: "optimize_memory",
			Condition: func(state *SystemState) bool {
				return state.MemoryUsage > ac.config.MemoryThreshold
			},
			Action: func(ctx context.Context) error {
				return ac.resourceManager.OptimizeMemory(ctx)
			},
			Priority: 12,
			Cooldown: ac.config.ActionCooldown,
		})
	}
}

func (ac *AutomationController) getCPUUsage() float64 {
	// Simplified CPU usage calculation
	// In production, would use more sophisticated methods
	return 50.0 // Placeholder
}

// Decision represents an automation decision
type Decision struct {
	Name          string
	Action        string
	RequiredLevel int32
	Execute       func(context.Context) error
}

// DecisionHistory tracks past decisions
type DecisionHistory struct {
	decisions []HistoricalDecision
	mu        sync.RWMutex
}

type HistoricalDecision struct {
	Decision  Decision
	Timestamp time.Time
	Success   bool
	Impact    float64
}

// LearningModel provides ML-based decision making
type LearningModel struct {
	weights map[string]float64
	mu      sync.RWMutex
}

// DefaultAutomationConfig returns default automation configuration
func DefaultAutomationConfig() *AutomationConfig {
	return &AutomationConfig{
		EnableAutoScaling:          true,
		EnableSelfHealing:          true,
		EnableAlgorithmSwitch:      true,
		EnableResourceOptimization: true,
		
		ScaleUpThreshold:    80.0,
		ScaleDownThreshold:  20.0,
		MemoryThreshold:     85.0,
		ErrorRateThreshold:  0.05,
		
		DecisionInterval:    10 * time.Second,
		ActionCooldown:      30 * time.Second,
		MetricsWindow:       5 * time.Minute,
		
		MaxWorkers:          runtime.NumCPU() * 2,
		MinWorkers:          1,
		MaxMemoryGB:         16,
		
		LearningEnabled:     true,
		PredictiveScaling:   true,
		AnomalyDetection:    true,
	}
}

// NewDecisionEngine creates a new decision engine
func NewDecisionEngine(logger *zap.Logger) *DecisionEngine {
	return &DecisionEngine{
		logger:        logger,
		history:       &DecisionHistory{},
		rules:         []AutomationRule{},
		learningModel: &LearningModel{weights: make(map[string]float64)},
	}
}

// Analyze analyzes system state and returns decisions
func (de *DecisionEngine) Analyze(state *SystemState) []Decision {
	decisions := []Decision{}
	
	// Evaluate all rules
	for _, rule := range de.rules {
		// Check cooldown
		lastExecuted := time.Unix(0, rule.LastExecuted.Load())
		if time.Since(lastExecuted) < rule.Cooldown {
			continue
		}
		
		// Check condition
		if rule.Condition(state) {
			decision := Decision{
				Name:          rule.Name,
				Action:        "execute_rule",
				RequiredLevel: int32(rule.Priority),
				Execute: func(ctx context.Context) error {
					err := rule.Action(ctx)
					if err == nil {
						rule.LastExecuted.Store(time.Now().UnixNano())
					}
					return err
				},
			}
			decisions = append(decisions, decision)
		}
	}
	
	// Sort by priority
	sortDecisionsByPriority(decisions)
	
	return decisions
}

// AddRule adds an automation rule
func (de *DecisionEngine) AddRule(rule *AutomationRule) {
	de.rules = append(de.rules, *rule)
}

// UpdateModel updates the learning model
func (de *DecisionEngine) UpdateModel() {
	// Simplified model update
	// In production, would use real ML algorithms
	de.learningModel.mu.Lock()
	defer de.learningModel.mu.Unlock()
	
	// Update weights based on historical performance
	for key := range de.learningModel.weights {
		de.learningModel.weights[key] *= 0.95 // Decay
	}
}

func sortDecisionsByPriority(decisions []Decision) {
	// Simple bubble sort for small lists
	for i := 0; i < len(decisions)-1; i++ {
		for j := 0; j < len(decisions)-i-1; j++ {
			if decisions[j].RequiredLevel < decisions[j+1].RequiredLevel {
				decisions[j], decisions[j+1] = decisions[j+1], decisions[j]
			}
		}
	}
}