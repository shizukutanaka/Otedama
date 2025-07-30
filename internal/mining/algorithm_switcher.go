package mining

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// AlgorithmSwitcher manages automatic switching between mining algorithms
type AlgorithmSwitcher struct {
	logger          *zap.Logger
	config          SwitcherConfig
	algorithms      map[string]*AlgorithmInfo
	profitability   *ProfitabilityCalculator
	benchmarker     *AlgorithmBenchmarker
	currentAlgo     atomic.Value // string
	stats           *SwitcherStats
	switchHistory   []SwitchEvent
	mu              sync.RWMutex
	switchChan      chan string
	shutdown        chan struct{}
}

// SwitcherConfig contains algorithm switcher configuration
type SwitcherConfig struct {
	// Switching parameters
	CheckInterval      time.Duration
	MinSwitchInterval  time.Duration
	ProfitThreshold    float64 // Minimum % improvement to switch
	
	// Benchmarking
	BenchmarkDuration  time.Duration
	BenchmarkOnStartup bool
	
	// Algorithm settings
	EnabledAlgorithms  []string
	PreferredAlgorithm string
	
	// Hardware limits
	MaxPowerDraw       float64
	MaxTemperature     float64
}

// AlgorithmInfo contains information about a mining algorithm
type AlgorithmInfo struct {
	Name            string
	Type            AlgorithmType
	HashRate        float64
	PowerUsage      float64
	Efficiency      float64 // Hash per watt
	Temperature     float64
	Supported       bool
	BenchmarkTime   time.Time
	Implementation  SwitcherMiningAlgorithm
	Config          map[string]interface{}
}

// AlgorithmType represents the type of algorithm
type AlgorithmType string

const (
	AlgorithmTypeSHA256     AlgorithmType = "sha256"
	AlgorithmTypeScrypt     AlgorithmType = "scrypt"
	AlgorithmTypeEthash     AlgorithmType = "ethash"
	AlgorithmTypeRandomX    AlgorithmType = "randomx"
	AlgorithmTypeKawpow     AlgorithmType = "kawpow"
	AlgorithmTypeProgPow    AlgorithmType = "progpow"
	AlgorithmTypeEquihash   AlgorithmType = "equihash"
	AlgorithmTypeCryptonight AlgorithmType = "cryptonight"
)

// SwitcherMiningAlgorithm interface for mining implementations
type SwitcherMiningAlgorithm interface {
	Mine(ctx context.Context, job *SwitcherMiningJob) (*SwitcherMiningResult, error)
	GetHashRate() float64
	GetName() string
	Configure(params map[string]interface{}) error
}

// ProfitabilityCalculator calculates mining profitability
type ProfitabilityCalculator struct {
	priceFeeds     map[string]PriceFeed
	difficultyData map[string]DifficultyInfo
	electricityCost float64
	mu             sync.RWMutex
}

// PriceFeed provides price data
type PriceFeed interface {
	GetPrice(symbol string) (float64, error)
}

// DifficultyInfo contains network difficulty information
type DifficultyInfo struct {
	Algorithm    string
	Difficulty   float64
	BlockReward  float64
	BlockTime    time.Duration
	LastUpdated  time.Time
}

// AlgorithmBenchmarker benchmarks mining algorithms
type AlgorithmBenchmarker struct {
	logger      *zap.Logger
	hardware    SwitcherHardwareInfo
	results     sync.Map // algorithm -> BenchmarkResult
	mu          sync.RWMutex
}

// BenchmarkResult contains benchmark results
type BenchmarkResult struct {
	Algorithm    string
	HashRate     float64
	PowerDraw    float64
	Temperature  float64
	Efficiency   float64
	Duration     time.Duration
	Timestamp    time.Time
	Errors       int
}

// SwitcherHardwareInfo contains hardware information for the algorithm switcher
type SwitcherHardwareInfo struct {
	Type         string // CPU, GPU, ASIC
	Model        string
	Cores        int
	Memory       uint64
	MaxPower     float64
	Capabilities []string
}

// SwitchEvent records an algorithm switch
type SwitchEvent struct {
	From           string
	To             string
	Reason         string
	Profitability  float64
	Timestamp      time.Time
}

// SwitcherStats tracks algorithm switching statistics
type SwitcherStats struct {
	TotalSwitches      atomic.Uint64
	SuccessfulSwitches atomic.Uint64
	FailedSwitches     atomic.Uint64
	BenchmarksRun      atomic.Uint64
	CurrentAlgorithm   atomic.Value // string
	LastSwitch         atomic.Value // time.Time
	TimeByAlgorithm    sync.Map     // algorithm -> duration
}

// SwitcherMiningJob represents a mining job for the algorithm switcher
type SwitcherMiningJob struct {
	ID         string
	Algorithm  string
	Target     []byte
	Data       []byte
	Nonce      uint64
	Difficulty float64
}

// SwitcherMiningResult represents mining result for the algorithm switcher
type SwitcherMiningResult struct {
	JobID    string
	Hash     []byte
	Nonce    uint64
	Found    bool
	HashRate float64
}

// NewAlgorithmSwitcher creates a new algorithm switcher
func NewAlgorithmSwitcher(config SwitcherConfig, logger *zap.Logger) (*AlgorithmSwitcher, error) {
	if config.CheckInterval == 0 {
		config.CheckInterval = 5 * time.Minute
	}
	if config.MinSwitchInterval == 0 {
		config.MinSwitchInterval = 10 * time.Minute
	}
	if config.ProfitThreshold == 0 {
		config.ProfitThreshold = 5.0 // 5% improvement required
	}
	if config.BenchmarkDuration == 0 {
		config.BenchmarkDuration = 60 * time.Second
	}

	as := &AlgorithmSwitcher{
		logger:        logger,
		config:        config,
		algorithms:    make(map[string]*AlgorithmInfo),
		profitability: NewProfitabilityCalculator(0.10), // $0.10/kWh default
		benchmarker:   NewAlgorithmBenchmarker(logger),
		stats:         &SwitcherStats{},
		switchHistory: make([]SwitchEvent, 0),
		switchChan:    make(chan string, 1),
		shutdown:      make(chan struct{}),
	}

	// Initialize algorithms
	as.initializeAlgorithms()

	// Set initial algorithm
	if config.PreferredAlgorithm != "" {
		as.currentAlgo.Store(config.PreferredAlgorithm)
	} else if len(config.EnabledAlgorithms) > 0 {
		as.currentAlgo.Store(config.EnabledAlgorithms[0])
	}

	return as, nil
}

// initializeAlgorithms initializes supported algorithms
func (as *AlgorithmSwitcher) initializeAlgorithms() {
	// SHA256 (Bitcoin)
	as.algorithms[string(AlgorithmTypeSHA256)] = &AlgorithmInfo{
		Name:           "SHA256",
		Type:           AlgorithmTypeSHA256,
		Supported:      true,
		Implementation: NewSHA256Algorithm(),
		Config:         map[string]interface{}{"intensity": 100},
	}

	// Scrypt (Litecoin)
	as.algorithms[string(AlgorithmTypeScrypt)] = &AlgorithmInfo{
		Name:           "Scrypt",
		Type:           AlgorithmTypeScrypt,
		Supported:      true,
		Implementation: NewScryptAlgorithm(),
		Config:         map[string]interface{}{"n": 1024, "r": 1, "p": 1},
	}

	// Ethash (Ethereum)
	as.algorithms[string(AlgorithmTypeEthash)] = &AlgorithmInfo{
		Name:           "Ethash",
		Type:           AlgorithmTypeEthash,
		Supported:      true,
		Implementation: NewEthashAlgorithm(),
		Config:         map[string]interface{}{"dag_size": 1073741824},
	}

	// RandomX (Monero)
	as.algorithms[string(AlgorithmTypeRandomX)] = &AlgorithmInfo{
		Name:           "RandomX",
		Type:           AlgorithmTypeRandomX,
		Supported:      true,
		Implementation: NewRandomXAlgorithm(),
		Config:         map[string]interface{}{"threads": 4},
	}

	// Filter enabled algorithms
	if len(as.config.EnabledAlgorithms) > 0 {
		enabled := make(map[string]bool)
		for _, algo := range as.config.EnabledAlgorithms {
			enabled[algo] = true
		}
		
		for name, info := range as.algorithms {
			if !enabled[name] {
				info.Supported = false
			}
		}
	}
}

// Start starts the algorithm switcher
func (as *AlgorithmSwitcher) Start(ctx context.Context) error {
	as.logger.Info("Starting algorithm switcher",
		zap.Int("enabled_algorithms", len(as.config.EnabledAlgorithms)))

	// Run initial benchmarks if configured
	if as.config.BenchmarkOnStartup {
		if err := as.benchmarkAll(ctx); err != nil {
			as.logger.Warn("Initial benchmark failed", zap.Error(err))
		}
	}

	// Start monitoring loop
	go as.monitorLoop(ctx)

	return nil
}

// Stop stops the algorithm switcher
func (as *AlgorithmSwitcher) Stop() error {
	close(as.shutdown)
	return nil
}

// GetCurrentAlgorithm returns the current mining algorithm
func (as *AlgorithmSwitcher) GetCurrentAlgorithm() string {
	if val := as.currentAlgo.Load(); val != nil {
		return val.(string)
	}
	return ""
}

// SwitchAlgorithm switches to a different algorithm
func (as *AlgorithmSwitcher) SwitchAlgorithm(algorithm string) error {
	as.mu.Lock()
	defer as.mu.Unlock()

	current := as.GetCurrentAlgorithm()
	if current == algorithm {
		return nil
	}

	// Validate algorithm
	info, exists := as.algorithms[algorithm]
	if !exists {
		return fmt.Errorf("unknown algorithm: %s", algorithm)
	}
	if !info.Supported {
		return fmt.Errorf("algorithm not supported: %s", algorithm)
	}

	// Check minimum switch interval
	if lastSwitch := as.stats.LastSwitch.Load(); lastSwitch != nil {
		if time.Since(lastSwitch.(time.Time)) < as.config.MinSwitchInterval {
			return fmt.Errorf("too soon to switch algorithms")
		}
	}

	// Perform switch
	as.logger.Info("Switching algorithm",
		zap.String("from", current),
		zap.String("to", algorithm))

	// Notify switch channel
	select {
	case as.switchChan <- algorithm:
	default:
		// Channel full, drop notification
	}

	// Update state
	as.currentAlgo.Store(algorithm)
	as.stats.LastSwitch.Store(time.Now())
	as.stats.TotalSwitches.Add(1)
	as.stats.SuccessfulSwitches.Add(1)

	// Record switch event
	as.switchHistory = append(as.switchHistory, SwitchEvent{
		From:      current,
		To:        algorithm,
		Reason:    "manual",
		Timestamp: time.Now(),
	})

	return nil
}

// monitorLoop monitors profitability and switches algorithms
func (as *AlgorithmSwitcher) monitorLoop(ctx context.Context) {
	ticker := time.NewTicker(as.config.CheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-as.shutdown:
			return
		case <-ticker.C:
			as.checkAndSwitch(ctx)
		}
	}
}

// checkAndSwitch checks profitability and switches if beneficial
func (as *AlgorithmSwitcher) checkAndSwitch(ctx context.Context) {
	current := as.GetCurrentAlgorithm()
	if current == "" {
		return
	}

	// Calculate profitability for all algorithms
	profitability := as.calculateProfitability()
	if len(profitability) == 0 {
		return
	}

	// Sort by profitability
	sort.Slice(profitability, func(i, j int) bool {
		return profitability[i].Profit > profitability[j].Profit
	})

	best := profitability[0]
	
	// Check if should switch
	if best.Algorithm != current {
		currentProfit := as.getProfitability(current, profitability)
		improvement := ((best.Profit - currentProfit) / currentProfit) * 100

		if improvement >= as.config.ProfitThreshold {
			reason := fmt.Sprintf("%.2f%% more profitable", improvement)
			
			as.logger.Info("Switching for better profitability",
				zap.String("from", current),
				zap.String("to", best.Algorithm),
				zap.Float64("improvement", improvement))

			if err := as.SwitchAlgorithm(best.Algorithm); err != nil {
				as.logger.Error("Failed to switch algorithm", zap.Error(err))
				as.stats.FailedSwitches.Add(1)
			} else {
				// Update switch reason
				as.mu.Lock()
				if len(as.switchHistory) > 0 {
					as.switchHistory[len(as.switchHistory)-1].Reason = reason
					as.switchHistory[len(as.switchHistory)-1].Profitability = improvement
				}
				as.mu.Unlock()
			}
		}
	}
}

// calculateProfitability calculates profitability for all algorithms
func (as *AlgorithmSwitcher) calculateProfitability() []AlgorithmProfitability {
	as.mu.RLock()
	defer as.mu.RUnlock()

	var results []AlgorithmProfitability

	for name, info := range as.algorithms {
		if !info.Supported || info.HashRate == 0 {
			continue
		}

		profit := as.profitability.Calculate(
			name,
			info.HashRate,
			info.PowerUsage,
		)

		results = append(results, AlgorithmProfitability{
			Algorithm: name,
			Profit:    profit,
			HashRate:  info.HashRate,
			Power:     info.PowerUsage,
		})
	}

	return results
}

// getProfitability gets profitability for a specific algorithm
func (as *AlgorithmSwitcher) getProfitability(algorithm string, profitability []AlgorithmProfitability) float64 {
	for _, p := range profitability {
		if p.Algorithm == algorithm {
			return p.Profit
		}
	}
	return 0
}

// benchmarkAll benchmarks all supported algorithms
func (as *AlgorithmSwitcher) benchmarkAll(ctx context.Context) error {
	as.logger.Info("Starting algorithm benchmarks")

	for name, info := range as.algorithms {
		if !info.Supported {
			continue
		}

		as.logger.Debug("Benchmarking algorithm", zap.String("algorithm", name))
		
		result, err := as.benchmarker.Benchmark(ctx, info.Implementation, as.config.BenchmarkDuration)
		if err != nil {
			as.logger.Error("Benchmark failed",
				zap.String("algorithm", name),
				zap.Error(err))
			continue
		}

		// Update algorithm info
		as.mu.Lock()
		info.HashRate = result.HashRate
		info.PowerUsage = result.PowerDraw
		info.Temperature = result.Temperature
		info.Efficiency = result.HashRate / result.PowerDraw
		info.BenchmarkTime = result.Timestamp
		as.mu.Unlock()

		as.stats.BenchmarksRun.Add(1)

		as.logger.Info("Benchmark completed",
			zap.String("algorithm", name),
			zap.Float64("hashrate", result.HashRate),
			zap.Float64("power", result.PowerDraw),
			zap.Float64("efficiency", info.Efficiency))
	}

	return nil
}

// GetStats returns switcher statistics
func (as *AlgorithmSwitcher) GetStats() map[string]interface{} {
	as.mu.RLock()
	defer as.mu.RUnlock()

	// Calculate time by algorithm
	timeByAlgo := make(map[string]time.Duration)
	as.stats.TimeByAlgorithm.Range(func(key, value interface{}) bool {
		timeByAlgo[key.(string)] = value.(time.Duration)
		return true
	})

	// Get algorithm details
	algorithms := make(map[string]interface{})
	for name, info := range as.algorithms {
		algorithms[name] = map[string]interface{}{
			"supported":    info.Supported,
			"hashrate":     info.HashRate,
			"power":        info.PowerUsage,
			"efficiency":   info.Efficiency,
			"temperature":  info.Temperature,
			"benchmarked":  info.BenchmarkTime,
		}
	}

	return map[string]interface{}{
		"current_algorithm":    as.GetCurrentAlgorithm(),
		"total_switches":       as.stats.TotalSwitches.Load(),
		"successful_switches":  as.stats.SuccessfulSwitches.Load(),
		"failed_switches":      as.stats.FailedSwitches.Load(),
		"benchmarks_run":       as.stats.BenchmarksRun.Load(),
		"time_by_algorithm":    timeByAlgo,
		"algorithms":           algorithms,
		"switch_history":       as.switchHistory,
	}
}

// Helper types

// AlgorithmProfitability represents algorithm profitability
type AlgorithmProfitability struct {
	Algorithm string
	Profit    float64
	HashRate  float64
	Power     float64
}

// Component implementations

// NewProfitabilityCalculator creates a new profitability calculator
func NewProfitabilityCalculator(electricityCost float64) *ProfitabilityCalculator {
	return &ProfitabilityCalculator{
		priceFeeds:      make(map[string]PriceFeed),
		difficultyData:  make(map[string]DifficultyInfo),
		electricityCost: electricityCost,
	}
}

// Calculate calculates profitability
func (pc *ProfitabilityCalculator) Calculate(algorithm string, hashRate, powerUsage float64) float64 {
	pc.mu.RLock()
	defer pc.mu.RUnlock()

	// Simplified profitability calculation
	// In production, would use real-time difficulty and price data
	
	// Example calculation (USD per day)
	revenuePerHash := 0.00000001 // Placeholder
	revenue := hashRate * revenuePerHash * 86400 // Daily revenue
	
	// Power cost (kWh per day)
	powerCost := (powerUsage / 1000) * 24 * pc.electricityCost
	
	return revenue - powerCost
}

// NewAlgorithmBenchmarker creates a new benchmarker
func NewAlgorithmBenchmarker(logger *zap.Logger) *AlgorithmBenchmarker {
	return &AlgorithmBenchmarker{
		logger: logger,
	}
}

// Benchmark benchmarks an algorithm
func (ab *AlgorithmBenchmarker) Benchmark(ctx context.Context, algo SwitcherMiningAlgorithm, duration time.Duration) (*BenchmarkResult, error) {
	startTime := time.Now()
	
	// Create benchmark job
	job := &SwitcherMiningJob{
		ID:         "benchmark",
		Algorithm:  algo.GetName(),
		Target:     make([]byte, 32),
		Data:       make([]byte, 80),
		Difficulty: 1.0,
	}
	
	// Run benchmark
	ctx, cancel := context.WithTimeout(ctx, duration)
	defer cancel()
	
	var totalHashes uint64
	var errors int
	
	for {
		select {
		case <-ctx.Done():
			// Calculate results
			elapsed := time.Since(startTime).Seconds()
			hashRate := float64(totalHashes) / elapsed
			
			result := &BenchmarkResult{
				Algorithm:  algo.GetName(),
				HashRate:   hashRate,
				PowerDraw:  100.0, // Placeholder - would read from hardware
				Temperature: 65.0, // Placeholder
				Efficiency: hashRate / 100.0,
				Duration:   duration,
				Timestamp:  startTime,
				Errors:     errors,
			}
			
			// Store result
			ab.results.Store(algo.GetName(), result)
			
			return result, nil
			
		default:
			// Mine
			result, err := algo.Mine(ctx, job)
			if err != nil {
				errors++
				continue
			}
			
			if result.HashRate > 0 {
				totalHashes += uint64(result.HashRate)
			}
		}
	}
}

// Algorithm implementations (simplified)

// SHA256Algorithm implements SHA256 mining
type SHA256Algorithm struct {
	name     string
	hashRate float64
}

func NewSHA256Algorithm() *SHA256Algorithm {
	return &SHA256Algorithm{name: "sha256"}
}

func (a *SHA256Algorithm) Mine(ctx context.Context, job *SwitcherMiningJob) (*SwitcherMiningResult, error) {
	// Simplified implementation
	return &SwitcherMiningResult{
		JobID:    job.ID,
		HashRate: 1000000, // 1 MH/s placeholder
	}, nil
}

func (a *SHA256Algorithm) GetHashRate() float64 { return a.hashRate }
func (a *SHA256Algorithm) GetName() string      { return a.name }
func (a *SHA256Algorithm) Configure(params map[string]interface{}) error { return nil }

// ScryptAlgorithm implements Scrypt mining
type ScryptAlgorithm struct {
	name     string
	hashRate float64
}

func NewScryptAlgorithm() *ScryptAlgorithm {
	return &ScryptAlgorithm{name: "scrypt"}
}

func (a *ScryptAlgorithm) Mine(ctx context.Context, job *SwitcherMiningJob) (*SwitcherMiningResult, error) {
	return &SwitcherMiningResult{
		JobID:    job.ID,
		HashRate: 500000, // 500 KH/s placeholder
	}, nil
}

func (a *ScryptAlgorithm) GetHashRate() float64 { return a.hashRate }
func (a *ScryptAlgorithm) GetName() string      { return a.name }
func (a *ScryptAlgorithm) Configure(params map[string]interface{}) error { return nil }

// EthashAlgorithm implements Ethash mining
type EthashAlgorithm struct {
	name     string
	hashRate float64
}

func NewEthashAlgorithm() *EthashAlgorithm {
	return &EthashAlgorithm{name: "ethash"}
}

func (a *EthashAlgorithm) Mine(ctx context.Context, job *SwitcherMiningJob) (*SwitcherMiningResult, error) {
	return &SwitcherMiningResult{
		JobID:    job.ID,
		HashRate: 30000000, // 30 MH/s placeholder
	}, nil
}

func (a *EthashAlgorithm) GetHashRate() float64 { return a.hashRate }
func (a *EthashAlgorithm) GetName() string      { return a.name }
func (a *EthashAlgorithm) Configure(params map[string]interface{}) error { return nil }

// RandomXAlgorithm implements RandomX mining
type RandomXAlgorithm struct {
	name     string
	hashRate float64
}

func NewRandomXAlgorithm() *RandomXAlgorithm {
	return &RandomXAlgorithm{name: "randomx"}
}

func (a *RandomXAlgorithm) Mine(ctx context.Context, job *SwitcherMiningJob) (*SwitcherMiningResult, error) {
	return &SwitcherMiningResult{
		JobID:    job.ID,
		HashRate: 5000, // 5 KH/s placeholder
	}, nil
}

func (a *RandomXAlgorithm) GetHashRate() float64 { return a.hashRate }
func (a *RandomXAlgorithm) GetName() string      { return a.name }
func (a *RandomXAlgorithm) Configure(params map[string]interface{}) error { return nil }