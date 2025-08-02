package mining

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// ProfitCalculator calculates mining profitability for different algorithms
type ProfitCalculator struct {
	mu              sync.RWMutex
	client          *http.Client
	cache           map[string]*CachedData
	cacheDuration   time.Duration
	exchangeRates   map[string]float64
	powerCostPerKWh float64
}

// CachedData represents cached market data
type CachedData struct {
	Value     interface{}
	Timestamp time.Time
}

// CoinData represents cryptocurrency market data
type CoinData struct {
	Symbol      string
	Price       float64
	Difficulty  float64
	BlockReward float64
	BlockTime   float64
	NetworkHash float64
}

// MiningHardware represents mining hardware specifications
type MiningHardware struct {
	Name        string
	Hashrate    map[AlgorithmType]float64 // H/s
	PowerDraw   float64                    // Watts
	Efficiency  map[AlgorithmType]float64 // J/TH
}

// NewProfitCalculator creates a new profit calculator
func NewProfitCalculator(powerCost float64) *ProfitCalculator {
	return &ProfitCalculator{
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
		cache:           make(map[string]*CachedData),
		cacheDuration:   5 * time.Minute,
		exchangeRates:   make(map[string]float64),
		powerCostPerKWh: powerCost,
	}
}

// CalculateProfitability calculates profitability for a specific algorithm and hardware
func (pc *ProfitCalculator) CalculateProfitability(
	algo AlgorithmType,
	hardware *MiningHardware,
	coinData *CoinData,
) float64 {
	// Get hashrate for this algorithm
	hashrate, exists := hardware.Hashrate[algo]
	if !exists {
		return 0
	}

	// Calculate daily revenue
	dailyRevenue := pc.calculateDailyRevenue(hashrate, coinData)

	// Calculate daily power cost
	dailyPowerCost := (hardware.PowerDraw / 1000) * 24 * pc.powerCostPerKWh

	// Calculate daily profit
	dailyProfit := dailyRevenue - dailyPowerCost

	return dailyProfit
}

// calculateDailyRevenue calculates daily mining revenue
func (pc *ProfitCalculator) calculateDailyRevenue(hashrate float64, coinData *CoinData) float64 {
	// Calculate expected blocks per day
	blocksPerDay := (hashrate / coinData.NetworkHash) * (86400 / coinData.BlockTime)

	// Calculate daily coin reward
	dailyCoins := blocksPerDay * coinData.BlockReward

	// Calculate daily revenue in USD
	dailyRevenue := dailyCoins * coinData.Price

	return dailyRevenue
}

// GetBestAlgorithm returns the most profitable algorithm for given hardware
func (pc *ProfitCalculator) GetBestAlgorithm(hardware *MiningHardware) (AlgorithmType, float64) {
	bestAlgo := SHA256D
	bestProfit := -999999.0

	// Define coin mappings for each algorithm
	algoCoins := map[AlgorithmType]string{
		SHA256D:    "BTC",
		Blake2b256: "SC",
		SHA3_256:   "KECCAK",
		Ethash:     "ETC",
		RandomX:    "XMR",
		KawPow:     "RVN",
		Equihash:   "ZEC",
	}

	for algo, coin := range algoCoins {
		// Get coin data (in production, this would fetch from APIs)
		coinData := pc.getMockCoinData(coin)
		if coinData == nil {
			continue
		}

		profit := pc.CalculateProfitability(algo, hardware, coinData)
		if profit > bestProfit {
			bestProfit = profit
			bestAlgo = algo
		}
	}

	return bestAlgo, bestProfit
}

// getMockCoinData returns mock coin data (in production, this would fetch from APIs)
func (pc *ProfitCalculator) getMockCoinData(symbol string) *CoinData {
	// Mock data for demonstration
	mockData := map[string]*CoinData{
		"BTC": {
			Symbol:      "BTC",
			Price:       45000,
			Difficulty:  30000000000000,
			BlockReward: 6.25,
			BlockTime:   600,
			NetworkHash: 300000000000000000000, // 300 EH/s
		},
		"SC": {
			Symbol:      "SC",
			Price:       0.005,
			Difficulty:  1000000000,
			BlockReward: 30000,
			BlockTime:   600,
			NetworkHash: 5000000000000, // 5 TH/s
		},
		"XMR": {
			Symbol:      "XMR",
			Price:       150,
			Difficulty:  350000000000,
			BlockReward: 0.6,
			BlockTime:   120,
			NetworkHash: 3000000000, // 3 GH/s
		},
		"RVN": {
			Symbol:      "RVN",
			Price:       0.02,
			Difficulty:  100000,
			BlockReward: 5000,
			BlockTime:   60,
			NetworkHash: 10000000000000, // 10 TH/s
		},
	}

	return mockData[symbol]
}

// CompareAlgorithms compares profitability across algorithms
func (pc *ProfitCalculator) CompareAlgorithms(hardware *MiningHardware) []AlgorithmComparison {
	var comparisons []AlgorithmComparison

	algoCoins := map[AlgorithmType]string{
		SHA256D:    "BTC",
		Blake2b256: "SC",
		SHA3_256:   "KECCAK",
		Ethash:     "ETC",
		RandomX:    "XMR",
		KawPow:     "RVN",
		Equihash:   "ZEC",
	}

	for algo, coin := range algoCoins {
		coinData := pc.getMockCoinData(coin)
		if coinData == nil {
			continue
		}

		hashrate, exists := hardware.Hashrate[algo]
		if !exists {
			continue
		}

		profit := pc.CalculateProfitability(algo, hardware, coinData)
		revenue := pc.calculateDailyRevenue(hashrate, coinData)
		powerCost := (hardware.PowerDraw / 1000) * 24 * pc.powerCostPerKWh

		comparisons = append(comparisons, AlgorithmComparison{
			Algorithm:   algo,
			Coin:        coin,
			Hashrate:    hashrate,
			DailyRevenue: revenue,
			DailyPowerCost: powerCost,
			DailyProfit: profit,
			ROI:         profit / (revenue + powerCost) * 100,
		})
	}

	return comparisons
}

// AlgorithmComparison represents profitability comparison data
type AlgorithmComparison struct {
	Algorithm      AlgorithmType
	Coin           string
	Hashrate       float64
	DailyRevenue   float64
	DailyPowerCost float64
	DailyProfit    float64
	ROI            float64
}

// UpdatePowerCost updates the electricity cost
func (pc *ProfitCalculator) UpdatePowerCost(costPerKWh float64) {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	pc.powerCostPerKWh = costPerKWh
}

// GetPowerCost returns the current power cost
func (pc *ProfitCalculator) GetPowerCost() float64 {
	pc.mu.RLock()
	defer pc.mu.RUnlock()
	return pc.powerCostPerKWh
}

// AutoSwitchRecommendation provides algorithm switching recommendations
type AutoSwitchRecommendation struct {
	CurrentAlgorithm AlgorithmType
	RecommendedAlgorithm AlgorithmType
	CurrentProfit float64
	ExpectedProfit float64
	ProfitIncrease float64
	SwitchRecommended bool
	Reason string
}

// GetSwitchRecommendation analyzes if switching algorithms is profitable
func (pc *ProfitCalculator) GetSwitchRecommendation(
	currentAlgo AlgorithmType,
	hardware *MiningHardware,
	switchThreshold float64,
) *AutoSwitchRecommendation {
	// Get current profitability
	currentCoinData := pc.getMockCoinData(pc.getDefaultCoin(currentAlgo))
	currentProfit := pc.CalculateProfitability(currentAlgo, hardware, currentCoinData)

	// Find best algorithm
	bestAlgo, bestProfit := pc.GetBestAlgorithm(hardware)

	// Calculate profit increase
	profitIncrease := (bestProfit - currentProfit) / currentProfit * 100

	recommendation := &AutoSwitchRecommendation{
		CurrentAlgorithm: currentAlgo,
		RecommendedAlgorithm: bestAlgo,
		CurrentProfit: currentProfit,
		ExpectedProfit: bestProfit,
		ProfitIncrease: profitIncrease,
	}

	// Determine if switch is recommended
	if bestAlgo != currentAlgo && profitIncrease > switchThreshold {
		recommendation.SwitchRecommended = true
		recommendation.Reason = fmt.Sprintf(
			"Switching to %s would increase daily profit by %.2f%%",
			bestAlgo, profitIncrease,
		)
	} else if bestAlgo == currentAlgo {
		recommendation.Reason = "Current algorithm is already the most profitable"
	} else {
		recommendation.Reason = fmt.Sprintf(
			"Profit increase of %.2f%% is below threshold of %.2f%%",
			profitIncrease, switchThreshold,
		)
	}

	return recommendation
}

// getDefaultCoin returns the default coin for an algorithm
func (pc *ProfitCalculator) getDefaultCoin(algo AlgorithmType) string {
	coinMap := map[AlgorithmType]string{
		SHA256D:    "BTC",
		Blake2b256: "SC",
		SHA3_256:   "KECCAK",
		Ethash:     "ETC",
		RandomX:    "XMR",
		KawPow:     "RVN",
		Equihash:   "ZEC",
	}
	
	coin, exists := coinMap[algo]
	if !exists {
		return "BTC"
	}
	return coin
}