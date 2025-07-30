package automation

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/otedama/otedama/internal/mining"
	"github.com/otedama/otedama/internal/mining/algorithms"
	"go.uber.org/zap"
)

// AlgorithmOptimizer automatically selects optimal mining algorithms
// Following John Carmack's principle: "The best optimization is algorithmic"
type AlgorithmOptimizer struct {
	logger *zap.Logger
	
	// Algorithm performance tracking
	algorithmStats map[string]*AlgorithmStats
	statsMu        sync.RWMutex
	
	// Benchmarking
	benchmarkCache map[string]*BenchmarkResult
	cacheMu        sync.RWMutex
	
	// Optimization state
	currentAlgorithm string
	lastSwitch       time.Time
	switchCooldown   time.Duration
}

// AlgorithmStats tracks algorithm performance
type AlgorithmStats struct {
	Algorithm       string
	TotalTime       time.Duration
	HashesComputed  uint64
	SharesFound     uint64
	BlocksFound     uint64
	AvgHashRate     float64
	MaxHashRate     float64
	PowerEfficiency float64
	LastUsed        time.Time
	SuccessRate     float64
}

// BenchmarkResult stores algorithm benchmark results
type BenchmarkResult struct {
	Algorithm   string
	HashRate    float64
	PowerUsage  float64
	Efficiency  float64
	Timestamp   time.Time
	Hardware    string
}

// NewAlgorithmOptimizer creates a new algorithm optimizer
func NewAlgorithmOptimizer(logger *zap.Logger) *AlgorithmOptimizer {
	return &AlgorithmOptimizer{
		logger:         logger,
		algorithmStats: make(map[string]*AlgorithmStats),
		benchmarkCache: make(map[string]*BenchmarkResult),
		switchCooldown: 5 * time.Minute,
	}
}

// OptimizeAlgorithm selects and switches to optimal algorithm
func (ao *AlgorithmOptimizer) OptimizeAlgorithm(ctx context.Context, engine *mining.UnifiedEngine, state *SystemState) error {
	// Check cooldown
	if time.Since(ao.lastSwitch) < ao.switchCooldown {
		return fmt.Errorf("algorithm switch on cooldown")
	}
	
	// Get available algorithms
	algorithms := ao.getAvailableAlgorithms()
	if len(algorithms) == 0 {
		return fmt.Errorf("no algorithms available")
	}
	
	// Select optimal algorithm
	optimal := ao.selectOptimalAlgorithm(ctx, algorithms, state)
	if optimal == ao.currentAlgorithm {
		return nil // Already using optimal
	}
	
	ao.logger.Info("Switching to optimal algorithm",
		zap.String("from", ao.currentAlgorithm),
		zap.String("to", optimal),
	)
	
	// Switch algorithm
	if err := engine.SwitchAlgorithm(optimal); err != nil {
		return fmt.Errorf("failed to switch algorithm: %w", err)
	}
	
	ao.currentAlgorithm = optimal
	ao.lastSwitch = time.Now()
	
	// Update stats
	ao.updateAlgorithmStats(optimal, state)
	
	return nil
}

// GetExpectedHashRate returns expected hash rate for current conditions
func (ao *AlgorithmOptimizer) GetExpectedHashRate(state *SystemState) float64 {
	if ao.currentAlgorithm == "" {
		return 0
	}
	
	ao.statsMu.RLock()
	stats, exists := ao.algorithmStats[ao.currentAlgorithm]
	ao.statsMu.RUnlock()
	
	if !exists {
		return ao.estimateHashRate(ao.currentAlgorithm, state)
	}
	
	// Adjust for current conditions
	expectedRate := stats.AvgHashRate
	
	// Adjust for CPU usage
	if state.CPUUsage > 80 {
		expectedRate *= 0.8 // 20% reduction under high load
	}
	
	// Adjust for worker count
	if state.WorkerCount > 0 {
		expectedRate *= float64(state.WorkerCount)
	}
	
	return expectedRate
}

// BenchmarkAlgorithms benchmarks all available algorithms
func (ao *AlgorithmOptimizer) BenchmarkAlgorithms(ctx context.Context, duration time.Duration) (map[string]*BenchmarkResult, error) {
	algorithms := ao.getAvailableAlgorithms()
	results := make(map[string]*BenchmarkResult)
	
	for _, algo := range algorithms {
		select {
		case <-ctx.Done():
			return results, ctx.Err()
		default:
		}
		
		result, err := ao.benchmarkAlgorithm(ctx, algo, duration)
		if err != nil {
			ao.logger.Warn("Algorithm benchmark failed",
				zap.String("algorithm", algo),
				zap.Error(err),
			)
			continue
		}
		
		results[algo] = result
		
		// Cache result
		ao.cacheMu.Lock()
		ao.benchmarkCache[algo] = result
		ao.cacheMu.Unlock()
	}
	
	return results, nil
}

// GetAlgorithmStats returns performance statistics
func (ao *AlgorithmOptimizer) GetAlgorithmStats() map[string]*AlgorithmStats {
	ao.statsMu.RLock()
	defer ao.statsMu.RUnlock()
	
	// Deep copy to avoid race conditions
	stats := make(map[string]*AlgorithmStats)
	for k, v := range ao.algorithmStats {
		statsCopy := *v
		stats[k] = &statsCopy
	}
	
	return stats
}

// GetRecommendation returns algorithm recommendation
func (ao *AlgorithmOptimizer) GetRecommendation(state *SystemState) AlgorithmRecommendation {
	algorithms := ao.getAvailableAlgorithms()
	rankings := ao.rankAlgorithms(algorithms, state)
	
	rec := AlgorithmRecommendation{
		Current:   ao.currentAlgorithm,
		Timestamp: time.Now(),
	}
	
	if len(rankings) > 0 {
		rec.Recommended = rankings[0].Algorithm
		rec.Reason = fmt.Sprintf("Highest score: %.2f", rankings[0].Score)
		rec.Rankings = rankings
	}
	
	return rec
}

// Private methods

func (ao *AlgorithmOptimizer) getAvailableAlgorithms() []string {
	// In production, would query the algorithm registry
	return []string{
		"sha256d",
		"scrypt",
		"ethash",
		"randomx",
		"kawpow",
	}
}

func (ao *AlgorithmOptimizer) selectOptimalAlgorithm(ctx context.Context, algorithms []string, state *SystemState) string {
	rankings := ao.rankAlgorithms(algorithms, state)
	
	if len(rankings) > 0 {
		return rankings[0].Algorithm
	}
	
	// Default to first available
	return algorithms[0]
}

func (ao *AlgorithmOptimizer) rankAlgorithms(algorithms []string, state *SystemState) []AlgorithmRanking {
	rankings := []AlgorithmRanking{}
	
	for _, algo := range algorithms {
		score := ao.scoreAlgorithm(algo, state)
		rankings = append(rankings, AlgorithmRanking{
			Algorithm: algo,
			Score:     score,
		})
	}
	
	// Sort by score (highest first)
	sort.Slice(rankings, func(i, j int) bool {
		return rankings[i].Score > rankings[j].Score
	})
	
	return rankings
}

func (ao *AlgorithmOptimizer) scoreAlgorithm(algorithm string, state *SystemState) float64 {
	score := 0.0
	
	// Check cached benchmark
	ao.cacheMu.RLock()
	benchmark, hasBenchmark := ao.benchmarkCache[algorithm]
	ao.cacheMu.RUnlock()
	
	if hasBenchmark {
		// Base score on hash rate
		score += benchmark.HashRate / 1e9 // Normalize to GH/s
		
		// Bonus for efficiency
		score += benchmark.Efficiency * 10
		
		// Penalty for old benchmark
		age := time.Since(benchmark.Timestamp)
		if age > 24*time.Hour {
			score *= 0.8 // 20% penalty for old data
		}
	}
	
	// Check historical stats
	ao.statsMu.RLock()
	stats, hasStats := ao.algorithmStats[algorithm]
	ao.statsMu.RUnlock()
	
	if hasStats {
		// Success rate bonus
		score += stats.SuccessRate * 50
		
		// Recent usage bonus
		if time.Since(stats.LastUsed) < time.Hour {
			score *= 1.1 // 10% bonus
		}
	}
	
	// Hardware compatibility scoring
	score *= ao.getHardwareCompatibilityScore(algorithm, state)
	
	// Market conditions (simplified)
	score *= ao.getMarketScore(algorithm)
	
	return score
}

func (ao *AlgorithmOptimizer) getHardwareCompatibilityScore(algorithm string, state *SystemState) float64 {
	// Simplified hardware scoring
	switch algorithm {
	case "sha256d":
		// Good for ASICs and CPUs
		return 1.0
	case "ethash":
		// GPU optimized
		if state.WorkerCount > 4 {
			return 1.2
		}
		return 0.8
	case "randomx":
		// CPU optimized
		return 1.1
	case "kawpow":
		// GPU optimized
		return 0.9
	default:
		return 1.0
	}
}

func (ao *AlgorithmOptimizer) getMarketScore(algorithm string) float64 {
	// In production, would check actual market conditions
	// For now, return static scores
	switch algorithm {
	case "sha256d":
		return 1.2 // Bitcoin
	case "ethash":
		return 1.1 // Ethereum Classic
	case "randomx":
		return 0.9 // Monero
	default:
		return 1.0
	}
}

func (ao *AlgorithmOptimizer) benchmarkAlgorithm(ctx context.Context, algorithm string, duration time.Duration) (*BenchmarkResult, error) {
	ao.logger.Debug("Benchmarking algorithm",
		zap.String("algorithm", algorithm),
		zap.Duration("duration", duration),
	)
	
	// In production, would actually run the algorithm
	// For now, return simulated results
	result := &BenchmarkResult{
		Algorithm:  algorithm,
		Timestamp:  time.Now(),
		Hardware:   "simulated",
	}
	
	switch algorithm {
	case "sha256d":
		result.HashRate = 14e12 // 14 TH/s
		result.PowerUsage = 1500 // 1500W
	case "ethash":
		result.HashRate = 100e6 // 100 MH/s
		result.PowerUsage = 250 // 250W
	case "randomx":
		result.HashRate = 10e3 // 10 KH/s
		result.PowerUsage = 100 // 100W
	default:
		result.HashRate = 1e9 // 1 GH/s
		result.PowerUsage = 200 // 200W
	}
	
	result.Efficiency = result.HashRate / result.PowerUsage
	
	return result, nil
}

func (ao *AlgorithmOptimizer) updateAlgorithmStats(algorithm string, state *SystemState) {
	ao.statsMu.Lock()
	defer ao.statsMu.Unlock()
	
	stats, exists := ao.algorithmStats[algorithm]
	if !exists {
		stats = &AlgorithmStats{
			Algorithm: algorithm,
		}
		ao.algorithmStats[algorithm] = stats
	}
	
	stats.LastUsed = time.Now()
	stats.AvgHashRate = state.HashRate
	
	if state.HashRate > stats.MaxHashRate {
		stats.MaxHashRate = state.HashRate
	}
}

func (ao *AlgorithmOptimizer) estimateHashRate(algorithm string, state *SystemState) float64 {
	// Basic estimation based on algorithm and workers
	baseRate := map[string]float64{
		"sha256d": 1e9,  // 1 GH/s per worker
		"scrypt":  1e6,  // 1 MH/s per worker
		"ethash":  30e6, // 30 MH/s per worker
		"randomx": 5e3,  // 5 KH/s per worker
		"kawpow":  20e6, // 20 MH/s per worker
	}
	
	rate, exists := baseRate[algorithm]
	if !exists {
		rate = 1e6 // Default 1 MH/s
	}
	
	return rate * float64(state.WorkerCount)
}

// AlgorithmRecommendation contains algorithm recommendation
type AlgorithmRecommendation struct {
	Current     string
	Recommended string
	Reason      string
	Rankings    []AlgorithmRanking
	Timestamp   time.Time
}

// AlgorithmRanking represents algorithm ranking
type AlgorithmRanking struct {
	Algorithm string
	Score     float64
}