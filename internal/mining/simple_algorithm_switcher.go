package mining

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// SimpleAlgorithmSwitcher provides efficient algorithm switching
// Following John Carmack's principle: "Optimize for the hot path"
type SimpleAlgorithmSwitcher struct {
	logger        *zap.Logger
	currentAlgo   atomic.Value // stores *AlgorithmInstance
	algorithms    map[Algorithm]*AlgorithmInstance
	mu            sync.RWMutex
	switchingLock sync.Mutex
	
	// Performance tracking
	stats map[Algorithm]*AlgoStats
}

// AlgorithmInstance represents a running algorithm instance
type AlgorithmInstance struct {
	algorithm Algorithm
	hasher    Hasher
	validator Validator
	config    *AlgoConfig
	
	// Performance metrics
	hashRate    atomic.Uint64
	shares      atomic.Uint64
	lastSwitch  time.Time
}

// AlgoConfig contains algorithm-specific configuration
type AlgoConfig struct {
	Threads    int
	WorkSize   int
	CacheSize  int
	GPUEnabled bool
}

// AlgoStats tracks algorithm performance
type AlgoStats struct {
	TotalHashes   uint64
	TotalShares   uint64
	TotalTime     time.Duration
	LastHashRate  uint64
	Profitability float64
}

// Hasher interface for algorithm implementations
type Hasher interface {
	Hash(data []byte, nonce uint64) ([]byte, error)
	GetMemoryRequirement() int
}

// Validator interface for share validation
type Validator interface {
	ValidateDifficulty(hash []byte, difficulty uint64) bool
}

// NewSimpleAlgorithmSwitcher creates a new algorithm switcher
func NewSimpleAlgorithmSwitcher(logger *zap.Logger) *SimpleAlgorithmSwitcher {
	as := &SimpleAlgorithmSwitcher{
		logger:     logger,
		algorithms: make(map[Algorithm]*AlgorithmInstance),
		stats:      make(map[Algorithm]*AlgoStats),
	}
	
	// Initialize supported algorithms
	as.initializeAlgorithms()
	
	// Set default algorithm
	if sha256d, exists := as.algorithms[AlgorithmSHA256d]; exists {
		as.currentAlgo.Store(sha256d)
	}
	
	return as
}

// GetCurrentAlgorithm returns the current algorithm
func (as *SimpleAlgorithmSwitcher) GetCurrentAlgorithm() Algorithm {
	if current := as.getCurrentInstance(); current != nil {
		return current.algorithm
	}
	return ""
}

// SwitchAlgorithm switches to a different algorithm
func (as *SimpleAlgorithmSwitcher) SwitchAlgorithm(algo Algorithm) error {
	// Prevent concurrent switches
	as.switchingLock.Lock()
	defer as.switchingLock.Unlock()
	
	as.mu.RLock()
	newAlgo, exists := as.algorithms[algo]
	as.mu.RUnlock()
	
	if !exists {
		return fmt.Errorf("algorithm %s not supported", algo)
	}
	
	current := as.getCurrentInstance()
	if current != nil && current.algorithm == algo {
		return nil // Already using this algorithm
	}
	
	// Record switch time
	newAlgo.lastSwitch = time.Now()
	
	// Atomic switch
	as.currentAlgo.Store(newAlgo)
	
	as.logger.Info("Switched algorithm",
		zap.String("from", string(current.algorithm)),
		zap.String("to", string(algo)),
	)
	
	return nil
}

// Hash performs hashing with the current algorithm
func (as *SimpleAlgorithmSwitcher) Hash(data []byte, nonce uint64) ([]byte, error) {
	current := as.getCurrentInstance()
	if current == nil {
		return nil, fmt.Errorf("no algorithm selected")
	}
	
	// Update hash rate counter
	current.hashRate.Add(1)
	
	return current.hasher.Hash(data, nonce)
}

// ValidateShare validates a share with the current algorithm
func (as *SimpleAlgorithmSwitcher) ValidateShare(hash []byte, difficulty uint64) bool {
	current := as.getCurrentInstance()
	if current == nil {
		return false
	}
	
	valid := current.validator.ValidateDifficulty(hash, difficulty)
	if valid {
		current.shares.Add(1)
	}
	
	return valid
}

// GetBestAlgorithm returns the most profitable algorithm based on current stats
func (as *SimpleAlgorithmSwitcher) GetBestAlgorithm() Algorithm {
	as.mu.RLock()
	defer as.mu.RUnlock()
	
	var bestAlgo Algorithm
	var bestProfit float64
	
	for algo, stats := range as.stats {
		if stats.Profitability > bestProfit {
			bestProfit = stats.Profitability
			bestAlgo = algo
		}
	}
	
	if bestAlgo == "" {
		return AlgorithmSHA256d // Default
	}
	
	return bestAlgo
}

// UpdateProfitability updates profitability for an algorithm
func (as *SimpleAlgorithmSwitcher) UpdateProfitability(algo Algorithm, profitability float64) {
	as.mu.Lock()
	defer as.mu.Unlock()
	
	if stats, exists := as.stats[algo]; exists {
		stats.Profitability = profitability
	}
}

// GetStats returns performance statistics
func (as *SimpleAlgorithmSwitcher) GetStats() map[Algorithm]*AlgoStats {
	as.mu.RLock()
	defer as.mu.RUnlock()
	
	// Create copy to avoid race conditions
	stats := make(map[Algorithm]*AlgoStats)
	for k, v := range as.stats {
		statsCopy := *v
		stats[k] = &statsCopy
	}
	
	return stats
}

// Private methods

func (as *SimpleAlgorithmSwitcher) getCurrentInstance() *AlgorithmInstance {
	if val := as.currentAlgo.Load(); val != nil {
		return val.(*AlgorithmInstance)
	}
	return nil
}

func (as *SimpleAlgorithmSwitcher) initializeAlgorithms() {
	// SHA256d
	as.registerAlgorithm(AlgorithmSHA256d, &AlgorithmInstance{
		algorithm: AlgorithmSHA256d,
		hasher:    &SHA256dHasher{},
		validator: &SHA256dValidator{},
		config: &AlgoConfig{
			Threads:  0, // Auto-detect
			WorkSize: 1024,
		},
	})
	
	// Scrypt
	as.registerAlgorithm(AlgorithmScrypt, &AlgorithmInstance{
		algorithm: AlgorithmScrypt,
		hasher:    &ScryptHasher{N: 1024, R: 1, P: 1},
		validator: &ScryptValidator{},
		config: &AlgoConfig{
			Threads:   0,
			WorkSize:  512,
			CacheSize: 128 * 1024, // 128KB
		},
	})
	
	// Ethash
	as.registerAlgorithm(AlgorithmEthash, &AlgorithmInstance{
		algorithm: AlgorithmEthash,
		hasher:    &EthashHasher{},
		validator: &EthashValidator{},
		config: &AlgoConfig{
			Threads:    0,
			WorkSize:   256,
			CacheSize:  16 * 1024 * 1024, // 16MB cache
			GPUEnabled: true,
		},
	})
	
	// RandomX
	as.registerAlgorithm(AlgorithmRandomX, &AlgorithmInstance{
		algorithm: AlgorithmRandomX,
		hasher:    &RandomXHasher{},
		validator: &RandomXValidator{},
		config: &AlgoConfig{
			Threads:   1, // RandomX is single-threaded per hash
			WorkSize:  1,
			CacheSize: 2 * 1024 * 1024 * 1024, // 2GB
		},
	})
	
	// KawPow
	as.registerAlgorithm(AlgorithmKawPow, &AlgorithmInstance{
		algorithm: AlgorithmKawPow,
		hasher:    &KawPowHasher{},
		validator: &KawPowValidator{},
		config: &AlgoConfig{
			Threads:    0,
			WorkSize:   256,
			CacheSize:  64 * 1024 * 1024, // 64MB
			GPUEnabled: true,
		},
	})
}

func (as *SimpleAlgorithmSwitcher) registerAlgorithm(algo Algorithm, instance *AlgorithmInstance) {
	as.mu.Lock()
	defer as.mu.Unlock()
	
	as.algorithms[algo] = instance
	as.stats[algo] = &AlgoStats{}
	
	as.logger.Info("Registered algorithm",
		zap.String("algorithm", string(algo)),
		zap.Int("threads", instance.config.Threads),
		zap.Int("cache_size", instance.config.CacheSize),
	)
}

// Simplified hasher implementations (stubs for now)

type SHA256dHasher struct{}

func (h *SHA256dHasher) Hash(data []byte, nonce uint64) ([]byte, error) {
	// Implementation would go here
	return make([]byte, 32), nil
}

func (h *SHA256dHasher) GetMemoryRequirement() int {
	return 1024 // 1KB
}

type SHA256dValidator struct{}

func (v *SHA256dValidator) ValidateDifficulty(hash []byte, difficulty uint64) bool {
	// Simple validation - count leading zeros
	zeros := 0
	for _, b := range hash {
		if b == 0 {
			zeros += 8
		} else {
			// Count leading zeros in byte
			for i := 7; i >= 0; i-- {
				if b&(1<<uint(i)) == 0 {
					zeros++
				} else {
					break
				}
			}
			break
		}
	}
	
	// Simplified: difficulty = 2^zeros
	return uint64(zeros) >= difficulty/1000000000
}

type ScryptHasher struct {
	N, R, P int
}

func (h *ScryptHasher) Hash(data []byte, nonce uint64) ([]byte, error) {
	// Scrypt implementation would go here
	return make([]byte, 32), nil
}

func (h *ScryptHasher) GetMemoryRequirement() int {
	return h.N * h.R * 128
}

type ScryptValidator struct{}

func (v *ScryptValidator) ValidateDifficulty(hash []byte, difficulty uint64) bool {
	// Similar to SHA256d validation
	return true
}

type EthashHasher struct{}

func (h *EthashHasher) Hash(data []byte, nonce uint64) ([]byte, error) {
	// Ethash implementation would go here
	return make([]byte, 32), nil
}

func (h *EthashHasher) GetMemoryRequirement() int {
	return 16 * 1024 * 1024 // 16MB cache
}

type EthashValidator struct{}

func (v *EthashValidator) ValidateDifficulty(hash []byte, difficulty uint64) bool {
	return true
}

type RandomXHasher struct{}

func (h *RandomXHasher) Hash(data []byte, nonce uint64) ([]byte, error) {
	// RandomX implementation would go here
	return make([]byte, 32), nil
}

func (h *RandomXHasher) GetMemoryRequirement() int {
	return 2 * 1024 * 1024 * 1024 // 2GB
}

type RandomXValidator struct{}

func (v *RandomXValidator) ValidateDifficulty(hash []byte, difficulty uint64) bool {
	return true
}

type KawPowHasher struct{}

func (h *KawPowHasher) Hash(data []byte, nonce uint64) ([]byte, error) {
	// KawPow implementation would go here
	return make([]byte, 32), nil
}

func (h *KawPowHasher) GetMemoryRequirement() int {
	return 64 * 1024 * 1024 // 64MB
}

type KawPowValidator struct{}

func (v *KawPowValidator) ValidateDifficulty(hash []byte, difficulty uint64) bool {
	return true
}

// AutoSwitcher monitors and automatically switches algorithms
type AutoSwitcher struct {
	switcher      *SimpleAlgorithmSwitcher
	logger        *zap.Logger
	checkInterval time.Duration
	enabled       atomic.Bool
	ctx           context.Context
	cancel        context.CancelFunc
}

// NewAutoSwitcher creates a new auto switcher
func NewAutoSwitcher(switcher *SimpleAlgorithmSwitcher, logger *zap.Logger) *AutoSwitcher {
	ctx, cancel := context.WithCancel(context.Background())
	return &AutoSwitcher{
		switcher:      switcher,
		logger:        logger,
		checkInterval: 5 * time.Minute,
		ctx:           ctx,
		cancel:        cancel,
	}
}

// Start starts the auto switcher
func (as *AutoSwitcher) Start() {
	if !as.enabled.CompareAndSwap(false, true) {
		return
	}
	
	go as.run()
}

// Stop stops the auto switcher
func (as *AutoSwitcher) Stop() {
	as.enabled.Store(false)
	as.cancel()
}

func (as *AutoSwitcher) run() {
	ticker := time.NewTicker(as.checkInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-as.ctx.Done():
			return
		case <-ticker.C:
			if !as.enabled.Load() {
				return
			}
			
			// Check if we should switch
			currentAlgo := as.switcher.GetCurrentAlgorithm()
			bestAlgo := as.switcher.GetBestAlgorithm()
			
			if currentAlgo != bestAlgo {
				as.logger.Info("Auto-switching algorithm",
					zap.String("from", string(currentAlgo)),
					zap.String("to", string(bestAlgo)),
				)
				
				if err := as.switcher.SwitchAlgorithm(bestAlgo); err != nil {
					as.logger.Error("Failed to auto-switch algorithm",
						zap.Error(err),
					)
				}
			}
		}
	}
}