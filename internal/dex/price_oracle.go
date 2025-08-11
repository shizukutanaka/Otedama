package dex

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"sync"
	"time"
)

// PriceOracle provides price feeds for tokens
type PriceOracle struct {
	prices       map[string]*PriceInfo
	sources      []PriceSource
	updatePeriod time.Duration
	mu           sync.RWMutex
	ctx          context.Context
	cancel       context.CancelFunc
	lastUpdate   time.Time
}

// PriceInfo contains price information for a token
type PriceInfo struct {
	Symbol    string
	Price     *big.Float
	Volume24h *big.Float
	Change24h float64
	LastUpdate time.Time
	Source    string
}

// PriceSource represents a price data source
type PriceSource interface {
	GetPrices(ctx context.Context, symbols []string) (map[string]*PriceInfo, error)
	Name() string
}

// NewPriceOracle creates a new price oracle
func NewPriceOracle(updatePeriod time.Duration) *PriceOracle {
	return &PriceOracle{
		prices:       make(map[string]*PriceInfo),
		sources:      make([]PriceSource, 0),
		updatePeriod: updatePeriod,
		lastUpdate:   time.Now(),
	}
}

// Start starts the price oracle
func (o *PriceOracle) Start(ctx context.Context) error {
	o.mu.Lock()
	o.ctx, o.cancel = context.WithCancel(ctx)
	o.mu.Unlock()
	
	// Initialize price sources
	o.initializeSources()
	
	// Initial price fetch
	if err := o.updatePrices(); err != nil {
		return fmt.Errorf("failed to fetch initial prices: %w", err)
	}
	
	// Start update loop
	go o.updateLoop()
	
	return nil
}

// Stop stops the price oracle
func (o *PriceOracle) Stop() error {
	o.mu.Lock()
	defer o.mu.Unlock()
	
	if o.cancel != nil {
		o.cancel()
	}
	
	return nil
}

// GetPrice returns the current price for a token
func (o *PriceOracle) GetPrice(symbol string) (*big.Float, error) {
	o.mu.RLock()
	defer o.mu.RUnlock()
	
	info, exists := o.prices[symbol]
	if !exists {
		return nil, fmt.Errorf("price not available for %s", symbol)
	}
	
	// Check if price is stale
	if time.Since(info.LastUpdate) > o.updatePeriod*2 {
		return nil, fmt.Errorf("price for %s is stale", symbol)
	}
	
	return new(big.Float).Set(info.Price), nil
}

// GetPrices returns all current prices
func (o *PriceOracle) GetPrices() (map[string]*big.Float, error) {
	o.mu.RLock()
	defer o.mu.RUnlock()
	
	prices := make(map[string]*big.Float)
	for symbol, info := range o.prices {
		prices[symbol] = new(big.Float).Set(info.Price)
	}
	
	return prices, nil
}

// GetPriceInfo returns detailed price information
func (o *PriceOracle) GetPriceInfo(symbol string) (*PriceInfo, error) {
	o.mu.RLock()
	defer o.mu.RUnlock()
	
	info, exists := o.prices[symbol]
	if !exists {
		return nil, fmt.Errorf("price info not available for %s", symbol)
	}
	
	// Return a copy
	return &PriceInfo{
		Symbol:     info.Symbol,
		Price:      new(big.Float).Set(info.Price),
		Volume24h:  new(big.Float).Set(info.Volume24h),
		Change24h:  info.Change24h,
		LastUpdate: info.LastUpdate,
		Source:     info.Source,
	}, nil
}

// CalculateTWAP calculates time-weighted average price
func (o *PriceOracle) CalculateTWAP(symbol string, duration time.Duration) (*big.Float, error) {
	// Simplified TWAP calculation
	// In production, this would use historical price data
	current, err := o.GetPrice(symbol)
	if err != nil {
		return nil, err
	}
	
	// For now, return current price
	return current, nil
}

// AddSource adds a new price source
func (o *PriceOracle) AddSource(source PriceSource) {
	o.mu.Lock()
	defer o.mu.Unlock()
	
	o.sources = append(o.sources, source)
}

// initializeSources initializes default price sources
func (o *PriceOracle) initializeSources() {
	// Add default sources
	o.AddSource(NewInternalPriceSource())
	o.AddSource(NewChainlinkPriceSource())
	// Additional sources can be added here
}

// updateLoop continuously updates prices
func (o *PriceOracle) updateLoop() {
	ticker := time.NewTicker(o.updatePeriod)
	defer ticker.Stop()
	
	for {
		select {
		case <-o.ctx.Done():
			return
		case <-ticker.C:
			if err := o.updatePrices(); err != nil {
				// Log error but continue
				fmt.Printf("Failed to update prices: %v\n", err)
			}
		}
	}
}

// updatePrices fetches prices from all sources
func (o *PriceOracle) updatePrices() error {
	o.mu.Lock()
	defer o.mu.Unlock()
	
	// Get list of symbols to fetch
	symbols := o.getSymbolList()
	
	// Fetch from all sources
	allPrices := make(map[string][]*PriceInfo)
	
	for _, source := range o.sources {
		prices, err := source.GetPrices(o.ctx, symbols)
		if err != nil {
			// Log error but continue with other sources
			continue
		}
		
		for symbol, price := range prices {
			allPrices[symbol] = append(allPrices[symbol], price)
		}
	}
	
	// Aggregate prices (use median or weighted average)
	for symbol, priceList := range allPrices {
		if len(priceList) == 0 {
			continue
		}
		
		// Use first valid price for simplicity
		// In production, use median or weighted average
		o.prices[symbol] = priceList[0]
	}
	
	o.lastUpdate = time.Now()
	return nil
}

// getSymbolList returns list of symbols to fetch prices for
func (o *PriceOracle) getSymbolList() []string {
	// In production, this would be configurable
	return []string{
		"BTC", "ETH", "USDT", "USDC", "BNB",
		"ADA", "DOT", "LINK", "UNI", "MATIC",
	}
}

// InternalPriceSource uses internal DEX prices
type InternalPriceSource struct {
	name string
}

// NewInternalPriceSource creates an internal price source
func NewInternalPriceSource() *InternalPriceSource {
	return &InternalPriceSource{
		name: "internal",
	}
}

// GetPrices returns prices from internal DEX
func (s *InternalPriceSource) GetPrices(ctx context.Context, symbols []string) (map[string]*PriceInfo, error) {
	prices := make(map[string]*PriceInfo)
	
	// In production, fetch from internal DEX pools
	// For now, return mock prices
	for _, symbol := range symbols {
		prices[symbol] = &PriceInfo{
			Symbol:     symbol,
			Price:      s.getMockPrice(symbol),
			Volume24h:  big.NewFloat(1000000),
			Change24h:  0.05,
			LastUpdate: time.Now(),
			Source:     s.name,
		}
	}
	
	return prices, nil
}

// Name returns the source name
func (s *InternalPriceSource) Name() string {
	return s.name
}

// getMockPrice returns a mock price for testing
func (s *InternalPriceSource) getMockPrice(symbol string) *big.Float {
	mockPrices := map[string]float64{
		"BTC":  45000,
		"ETH":  3000,
		"USDT": 1,
		"USDC": 1,
		"BNB":   300,
		"ADA":   0.5,
		"DOT":   8,
		"LINK": 15,
		"UNI":   10,
		"MATIC": 1.5,
	}
	
	if price, exists := mockPrices[symbol]; exists {
		return big.NewFloat(price)
	}
	return big.NewFloat(1)
}

// ChainlinkPriceSource uses Chainlink oracles
type ChainlinkPriceSource struct {
	name    string
	baseURL string
	client  *http.Client
}

// NewChainlinkPriceSource creates a Chainlink price source
func NewChainlinkPriceSource() *ChainlinkPriceSource {
	return &ChainlinkPriceSource{
		name:    "chainlink",
		baseURL: "https://api.chain.link/v1/prices", // Example URL
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// GetPrices fetches prices from Chainlink
func (s *ChainlinkPriceSource) GetPrices(ctx context.Context, symbols []string) (map[string]*PriceInfo, error) {
	// In production, implement actual Chainlink API integration
	// For now, return mock data
	return s.getMockChainlinkPrices(symbols), nil
}

// Name returns the source name
func (s *ChainlinkPriceSource) Name() string {
	return s.name
}

// getMockChainlinkPrices returns mock Chainlink prices
func (s *ChainlinkPriceSource) getMockChainlinkPrices(symbols []string) map[string]*PriceInfo {
	prices := make(map[string]*PriceInfo)
	
	for _, symbol := range symbols {
		prices[symbol] = &PriceInfo{
			Symbol:     symbol,
			Price:      s.getChainlinkMockPrice(symbol),
			Volume24h:  big.NewFloat(2000000),
			Change24h:  0.03,
			LastUpdate: time.Now(),
			Source:     s.name,
		}
	}
	
	return prices
}

// getChainlinkMockPrice returns a mock Chainlink price
func (s *ChainlinkPriceSource) getChainlinkMockPrice(symbol string) *big.Float {
	// Slightly different prices to simulate multiple sources
	mockPrices := map[string]float64{
		"BTC":  45100,
		"ETH":  3010,
		"USDT": 1.001,
		"USDC": 0.999,
		"BNB":   301,
		"ADA":   0.51,
		"DOT":   8.1,
		"LINK": 15.2,
		"UNI":   10.1,
		"MATIC": 1.51,
	}
	
	if price, exists := mockPrices[symbol]; exists {
		return big.NewFloat(price)
	}
	return big.NewFloat(1)
}

// PriceAggregator aggregates prices from multiple sources
type PriceAggregator struct {
	sources []PriceSource
	weights map[string]float64
}

// NewPriceAggregator creates a price aggregator
func NewPriceAggregator() *PriceAggregator {
	return &PriceAggregator{
		sources: make([]PriceSource, 0),
		weights: make(map[string]float64),
	}
}

// AggregatePrice calculates weighted average price
func (a *PriceAggregator) AggregatePrice(prices []*PriceInfo) *big.Float {
	if len(prices) == 0 {
		return big.NewFloat(0)
	}
	
	if len(prices) == 1 {
		return prices[0].Price
	}
	
	// Calculate weighted average
	totalWeight := 0.0
	weightedSum := big.NewFloat(0)
	
	for _, price := range prices {
		weight := a.getWeight(price.Source)
		totalWeight += weight
		
		weighted := new(big.Float).Mul(price.Price, big.NewFloat(weight))
		weightedSum.Add(weightedSum, weighted)
	}
	
	if totalWeight == 0 {
		return big.NewFloat(0)
	}
	
	return new(big.Float).Quo(weightedSum, big.NewFloat(totalWeight))
}

// getWeight returns the weight for a source
func (a *PriceAggregator) getWeight(source string) float64 {
	if weight, exists := a.weights[source]; exists {
		return weight
	}
	return 1.0 // Default weight
}