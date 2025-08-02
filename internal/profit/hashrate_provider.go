package profit

import (
	"fmt"
	"sync"
)

// MiningHashrateProvider provides hashrate and power usage data
type MiningHashrateProvider struct {
	mu        sync.RWMutex
	hashrates map[string]float64
	power     map[string]float64
}

// NewMiningHashrateProvider creates a new hashrate provider
func NewMiningHashrateProvider() *MiningHashrateProvider {
	return &MiningHashrateProvider{
		hashrates: make(map[string]float64),
		power:     make(map[string]float64),
	}
}

// GetHashrate returns the current hashrate for an algorithm
func (p *MiningHashrateProvider) GetHashrate(algorithm string) (float64, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	hashrate, exists := p.hashrates[algorithm]
	if !exists {
		return 0, fmt.Errorf("hashrate not available for %s", algorithm)
	}

	return hashrate, nil
}

// GetPowerUsage returns the power usage in watts for an algorithm
func (p *MiningHashrateProvider) GetPowerUsage(algorithm string) (float64, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	power, exists := p.power[algorithm]
	if !exists {
		return 0, fmt.Errorf("power usage not available for %s", algorithm)
	}

	return power, nil
}

// UpdateHashrate updates the hashrate for an algorithm
func (p *MiningHashrateProvider) UpdateHashrate(algorithm string, hashrate float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.hashrates[algorithm] = hashrate
}

// UpdatePowerUsage updates the power usage for an algorithm
func (p *MiningHashrateProvider) UpdatePowerUsage(algorithm string, watts float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.power[algorithm] = watts
}

// BenchmarkProvider provides estimated hashrates based on hardware
type BenchmarkProvider struct {
	hardware     string
	hashrates    map[string]float64
	powerUsage   map[string]float64
}

// NewBenchmarkProvider creates a benchmark-based hashrate provider
func NewBenchmarkProvider(hardwareType string) *BenchmarkProvider {
	provider := &BenchmarkProvider{
		hardware:   hardwareType,
		hashrates:  make(map[string]float64),
		powerUsage: make(map[string]float64),
	}

	// Initialize with benchmark data
	provider.initBenchmarks()

	return provider
}

// GetHashrate returns estimated hashrate for an algorithm
func (p *BenchmarkProvider) GetHashrate(algorithm string) (float64, error) {
	hashrate, exists := p.hashrates[algorithm]
	if !exists {
		return 0, fmt.Errorf("no benchmark data for %s", algorithm)
	}

	return hashrate, nil
}

// GetPowerUsage returns estimated power usage for an algorithm
func (p *BenchmarkProvider) GetPowerUsage(algorithm string) (float64, error) {
	power, exists := p.powerUsage[algorithm]
	if !exists {
		return 0, fmt.Errorf("no power data for %s", algorithm)
	}

	return power, nil
}

// initBenchmarks initializes benchmark data based on hardware type
func (p *BenchmarkProvider) initBenchmarks() {
	switch p.hardware {
	case "RTX3090":
		p.hashrates = map[string]float64{
			"SHA256d": 2.5e9,    // 2.5 GH/s
			"Ethash":  120e6,    // 120 MH/s
			"KawPow":  45e6,     // 45 MH/s
			"RandomX": 2500,     // 2.5 KH/s
			"Scrypt":  1.2e6,    // 1.2 MH/s
		}
		p.powerUsage = map[string]float64{
			"SHA256d": 350,
			"Ethash":  300,
			"KawPow":  320,
			"RandomX": 280,
			"Scrypt":  330,
		}

	case "RTX3080":
		p.hashrates = map[string]float64{
			"SHA256d": 2.0e9,    // 2.0 GH/s
			"Ethash":  95e6,     // 95 MH/s
			"KawPow":  38e6,     // 38 MH/s
			"RandomX": 2000,     // 2 KH/s
			"Scrypt":  950e3,    // 950 KH/s
		}
		p.powerUsage = map[string]float64{
			"SHA256d": 300,
			"Ethash":  250,
			"KawPow":  280,
			"RandomX": 240,
			"Scrypt":  290,
		}

	case "RX6800XT":
		p.hashrates = map[string]float64{
			"SHA256d": 1.8e9,    // 1.8 GH/s
			"Ethash":  62e6,     // 62 MH/s
			"KawPow":  30e6,     // 30 MH/s
			"RandomX": 1800,     // 1.8 KH/s
			"Scrypt":  850e3,    // 850 KH/s
		}
		p.powerUsage = map[string]float64{
			"SHA256d": 280,
			"Ethash":  220,
			"KawPow":  250,
			"RandomX": 200,
			"Scrypt":  260,
		}

	case "CPU-Ryzen9":
		p.hashrates = map[string]float64{
			"SHA256d": 50e6,     // 50 MH/s
			"Ethash":  0,        // Not suitable
			"KawPow":  0,        // Not suitable
			"RandomX": 15000,    // 15 KH/s (CPU optimized)
			"Scrypt":  100e3,    // 100 KH/s
		}
		p.powerUsage = map[string]float64{
			"SHA256d": 150,
			"Ethash":  0,
			"KawPow":  0,
			"RandomX": 120,
			"Scrypt":  140,
		}

	case "ASIC-S19Pro":
		p.hashrates = map[string]float64{
			"SHA256d": 110e12,   // 110 TH/s
			"Ethash":  0,        // Not compatible
			"KawPow":  0,        // Not compatible
			"RandomX": 0,        // Not compatible
			"Scrypt":  0,        // Not compatible
		}
		p.powerUsage = map[string]float64{
			"SHA256d": 3250,
			"Ethash":  0,
			"KawPow":  0,
			"RandomX": 0,
			"Scrypt":  0,
		}

	default:
		// Default/generic GPU estimates
		p.hashrates = map[string]float64{
			"SHA256d": 1.0e9,    // 1 GH/s
			"Ethash":  30e6,     // 30 MH/s
			"KawPow":  15e6,     // 15 MH/s
			"RandomX": 1000,     // 1 KH/s
			"Scrypt":  500e3,    // 500 KH/s
		}
		p.powerUsage = map[string]float64{
			"SHA256d": 200,
			"Ethash":  150,
			"KawPow":  180,
			"RandomX": 140,
			"Scrypt":  190,
		}
	}
}