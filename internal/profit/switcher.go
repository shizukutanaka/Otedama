package profit

import (
	"context"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
)

// Algorithm represents a mineable algorithm
type Algorithm struct {
	Name       string
	Difficulty float64
	BlockTime  time.Duration
	Reward     float64
}

// AlgorithmStats tracks statistics for an algorithm
type AlgorithmStats struct {
	Algorithm
	Hashrate      float64
	Profitability float64
	ProfitPerDay  float64
	LastChecked   time.Time
}

// Switcher handles automatic algorithm switching based on profitability
type Switcher struct {
	logger         *zap.Logger
	config         Config
	currentAlgo    string
	algorithms     map[string]*AlgorithmStats
	mu             sync.RWMutex
	switchChan     chan string
	stopChan       chan struct{}
	priceProvider  PriceProvider
	hashProvider   HashrateProvider
}

// Config defines profit switching configuration
type Config struct {
	Enabled          bool          `yaml:"enabled"`
	CheckInterval    time.Duration `yaml:"check_interval"`
	SwitchThreshold  float64       `yaml:"switch_threshold"`
	MinRunTime       time.Duration `yaml:"min_run_time"`
	Algorithms       []string      `yaml:"algorithms"`
	PriceAPI         string        `yaml:"price_api"`
	ElectricityCost  float64       `yaml:"electricity_cost"`
}

// PriceProvider interface for fetching cryptocurrency prices
type PriceProvider interface {
	GetPrice(symbol string) (float64, error)
	GetPrices(symbols []string) (map[string]float64, error)
}

// HashrateProvider interface for getting algorithm hashrates
type HashrateProvider interface {
	GetHashrate(algorithm string) (float64, error)
	GetPowerUsage(algorithm string) (float64, error)
}

// NewSwitcher creates a new profit switcher
func NewSwitcher(logger *zap.Logger, config Config, priceProvider PriceProvider, hashProvider HashrateProvider) *Switcher {
	s := &Switcher{
		logger:        logger,
		config:        config,
		algorithms:    make(map[string]*AlgorithmStats),
		switchChan:    make(chan string, 1),
		stopChan:      make(chan struct{}),
		priceProvider: priceProvider,
		hashProvider:  hashProvider,
	}

	// Initialize supported algorithms
	s.initAlgorithms()

	return s
}

// Start begins profit monitoring
func (s *Switcher) Start(ctx context.Context) error {
	if !s.config.Enabled {
		s.logger.Info("Profit switching disabled")
		return nil
	}

	s.logger.Info("Starting profit switcher",
		zap.Duration("check_interval", s.config.CheckInterval),
		zap.Float64("threshold", s.config.SwitchThreshold),
	)

	// Start monitoring loop
	go s.monitorLoop(ctx)

	return nil
}

// Stop halts profit monitoring
func (s *Switcher) Stop() error {
	close(s.stopChan)
	return nil
}

// GetCurrentAlgorithm returns the current mining algorithm
func (s *Switcher) GetCurrentAlgorithm() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.currentAlgo
}

// GetStatus returns profit switching status
func (s *Switcher) GetStatus() map[string]interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()

	algorithms := make([]map[string]interface{}, 0)
	for _, algo := range s.algorithms {
		algorithms = append(algorithms, map[string]interface{}{
			"name":           algo.Name,
			"hashrate":       algo.Hashrate,
			"profitability":  algo.Profitability,
			"profit_per_day": algo.ProfitPerDay,
			"last_checked":   algo.LastChecked,
		})
	}

	return map[string]interface{}{
		"enabled":           s.config.Enabled,
		"current_algorithm": s.currentAlgo,
		"next_check":        time.Now().Add(s.config.CheckInterval),
		"threshold_percent": s.config.SwitchThreshold,
		"algorithms":        algorithms,
	}
}

// ForceSwitch forces a switch to a specific algorithm
func (s *Switcher) ForceSwitch(algorithm string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.algorithms[algorithm]; !exists {
		return fmt.Errorf("algorithm %s not supported", algorithm)
	}

	s.logger.Info("Force switching algorithm",
		zap.String("from", s.currentAlgo),
		zap.String("to", algorithm),
	)

	s.currentAlgo = algorithm
	s.switchChan <- algorithm

	return nil
}

// initAlgorithms initializes supported algorithms
func (s *Switcher) initAlgorithms() {
	// Define algorithm parameters
	algos := map[string]Algorithm{
		"SHA256d": {
			Name:       "SHA256d",
			Difficulty: 40000000000000,
			BlockTime:  10 * time.Minute,
			Reward:     6.25,
		},
		"Ethash": {
			Name:       "Ethash",
			Difficulty: 15000000000000000,
			BlockTime:  13 * time.Second,
			Reward:     2.0,
		},
		"KawPow": {
			Name:       "KawPow",
			Difficulty: 250000000000,
			BlockTime:  1 * time.Minute,
			Reward:     5000,
		},
		"RandomX": {
			Name:       "RandomX",
			Difficulty: 300000000000,
			BlockTime:  2 * time.Minute,
			Reward:     0.6,
		},
		"Scrypt": {
			Name:       "Scrypt",
			Difficulty: 30000000,
			BlockTime:  2.5 * time.Minute,
			Reward:     12.5,
		},
	}

	// Initialize only configured algorithms
	for _, algoName := range s.config.Algorithms {
		if algo, exists := algos[algoName]; exists {
			s.algorithms[algoName] = &AlgorithmStats{
				Algorithm: algo,
			}
		}
	}

	// Set initial algorithm
	if len(s.algorithms) > 0 {
		for name := range s.algorithms {
			s.currentAlgo = name
			break
		}
	}
}

// monitorLoop continuously monitors profitability
func (s *Switcher) monitorLoop(ctx context.Context) {
	ticker := time.NewTicker(s.config.CheckInterval)
	defer ticker.Stop()

	lastSwitch := time.Now()

	for {
		select {
		case <-ctx.Done():
			return
		case <-s.stopChan:
			return
		case <-ticker.C:
			// Check if minimum run time has passed
			if time.Since(lastSwitch) < s.config.MinRunTime {
				continue
			}

			// Calculate profitability for all algorithms
			s.calculateProfitability()

			// Determine best algorithm
			bestAlgo := s.findBestAlgorithm()

			// Check if we should switch
			if s.shouldSwitch(bestAlgo) {
				s.mu.Lock()
				s.currentAlgo = bestAlgo
				s.mu.Unlock()

				s.logger.Info("Switching to more profitable algorithm",
					zap.String("algorithm", bestAlgo),
					zap.Float64("improvement", s.algorithms[bestAlgo].Profitability),
				)

				s.switchChan <- bestAlgo
				lastSwitch = time.Now()
			}
		}
	}
}

// calculateProfitability calculates profitability for all algorithms
func (s *Switcher) calculateProfitability() {
	// Get current prices
	symbols := s.getCurrencySymbols()
	prices, err := s.priceProvider.GetPrices(symbols)
	if err != nil {
		s.logger.Error("Failed to fetch prices", zap.Error(err))
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for name, algo := range s.algorithms {
		// Get hashrate for this algorithm
		hashrate, err := s.hashProvider.GetHashrate(name)
		if err != nil {
			s.logger.Warn("Failed to get hashrate",
				zap.String("algorithm", name),
				zap.Error(err),
			)
			continue
		}

		// Get power usage
		power, err := s.hashProvider.GetPowerUsage(name)
		if err != nil {
			s.logger.Warn("Failed to get power usage",
				zap.String("algorithm", name),
				zap.Error(err),
			)
			continue
		}

		// Calculate expected earnings per day
		blocksPerDay := float64(24*time.Hour) / float64(algo.BlockTime)
		networkHashrate := algo.Difficulty * 2 / float64(algo.BlockTime.Seconds())
		poolShare := hashrate / networkHashrate
		expectedBlocks := blocksPerDay * poolShare
		coinReward := expectedBlocks * algo.Reward

		// Get coin price
		symbol := s.getSymbolForAlgorithm(name)
		price := prices[symbol]

		// Calculate revenue and costs
		revenue := coinReward * price
		electricityCost := power * 24 * s.config.ElectricityCost / 1000 // kWh

		// Calculate profit
		profit := revenue - electricityCost

		// Update stats
		algo.Hashrate = hashrate
		algo.ProfitPerDay = profit
		algo.Profitability = profit / revenue * 100 // Profit margin percentage
		algo.LastChecked = time.Now()

		s.logger.Debug("Calculated profitability",
			zap.String("algorithm", name),
			zap.Float64("hashrate", hashrate),
			zap.Float64("revenue", revenue),
			zap.Float64("cost", electricityCost),
			zap.Float64("profit", profit),
		)
	}
}

// findBestAlgorithm finds the most profitable algorithm
func (s *Switcher) findBestAlgorithm() string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	bestAlgo := s.currentAlgo
	bestProfit := 0.0

	if current, exists := s.algorithms[s.currentAlgo]; exists {
		bestProfit = current.ProfitPerDay
	}

	for name, algo := range s.algorithms {
		if algo.ProfitPerDay > bestProfit {
			bestAlgo = name
			bestProfit = algo.ProfitPerDay
		}
	}

	return bestAlgo
}

// shouldSwitch determines if we should switch algorithms
func (s *Switcher) shouldSwitch(newAlgo string) bool {
	if newAlgo == s.currentAlgo {
		return false
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	current, exists := s.algorithms[s.currentAlgo]
	if !exists {
		return true
	}

	new, exists := s.algorithms[newAlgo]
	if !exists {
		return false
	}

	// Calculate improvement percentage
	improvement := (new.ProfitPerDay - current.ProfitPerDay) / current.ProfitPerDay * 100

	// Switch if improvement exceeds threshold
	return improvement >= s.config.SwitchThreshold
}

// getCurrencySymbols returns currency symbols for price lookup
func (s *Switcher) getCurrencySymbols() []string {
	return []string{"BTC", "ETH", "RVN", "XMR", "LTC"}
}

// getSymbolForAlgorithm maps algorithm to currency symbol
func (s *Switcher) getSymbolForAlgorithm(algorithm string) string {
	mapping := map[string]string{
		"SHA256d": "BTC",
		"Ethash":  "ETH",
		"KawPow":  "RVN",
		"RandomX": "XMR",
		"Scrypt":  "LTC",
	}

	if symbol, exists := mapping[algorithm]; exists {
		return symbol
	}

	return "BTC" // Default
}

// GetSwitchChannel returns the channel for algorithm switches
func (s *Switcher) GetSwitchChannel() <-chan string {
	return s.switchChan
}