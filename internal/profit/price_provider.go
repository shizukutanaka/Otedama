package profit

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
)

// CoinGeckoPriceProvider fetches prices from CoinGecko API
type CoinGeckoPriceProvider struct {
	logger      *zap.Logger
	httpClient  *http.Client
	cache       map[string]*priceCache
	cacheMutex  sync.RWMutex
	cacheExpiry time.Duration
}

// priceCache stores cached price data
type priceCache struct {
	price     float64
	timestamp time.Time
}

// coinGeckoResponse represents API response
type coinGeckoResponse map[string]map[string]float64

// NewCoinGeckoPriceProvider creates a new CoinGecko price provider
func NewCoinGeckoPriceProvider(logger *zap.Logger) *CoinGeckoPriceProvider {
	return &CoinGeckoPriceProvider{
		logger: logger,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
		cache:       make(map[string]*priceCache),
		cacheExpiry: 5 * time.Minute,
	}
}

// GetPrice fetches price for a single symbol
func (p *CoinGeckoPriceProvider) GetPrice(symbol string) (float64, error) {
	prices, err := p.GetPrices([]string{symbol})
	if err != nil {
		return 0, err
	}

	price, exists := prices[symbol]
	if !exists {
		return 0, fmt.Errorf("price not found for %s", symbol)
	}

	return price, nil
}

// GetPrices fetches prices for multiple symbols
func (p *CoinGeckoPriceProvider) GetPrices(symbols []string) (map[string]float64, error) {
	result := make(map[string]float64)
	toFetch := []string{}

	// Check cache first
	p.cacheMutex.RLock()
	for _, symbol := range symbols {
		if cached, exists := p.cache[symbol]; exists {
			if time.Since(cached.timestamp) < p.cacheExpiry {
				result[symbol] = cached.price
			} else {
				toFetch = append(toFetch, symbol)
			}
		} else {
			toFetch = append(toFetch, symbol)
		}
	}
	p.cacheMutex.RUnlock()

	// Fetch missing prices
	if len(toFetch) > 0 {
		fetched, err := p.fetchPrices(toFetch)
		if err != nil {
			return nil, err
		}

		// Update cache and results
		p.cacheMutex.Lock()
		for symbol, price := range fetched {
			p.cache[symbol] = &priceCache{
				price:     price,
				timestamp: time.Now(),
			}
			result[symbol] = price
		}
		p.cacheMutex.Unlock()
	}

	return result, nil
}

// fetchPrices fetches prices from CoinGecko API
func (p *CoinGeckoPriceProvider) fetchPrices(symbols []string) (map[string]float64, error) {
	// Map symbols to CoinGecko IDs
	coinIDs := p.mapSymbolsToIDs(symbols)
	
	// Build API URL
	ids := strings.Join(coinIDs, ",")
	url := fmt.Sprintf("https://api.coingecko.com/api/v3/simple/price?ids=%s&vs_currencies=usd", ids)

	// Make request
	resp, err := p.httpClient.Get(url)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch prices: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API returned status %d", resp.StatusCode)
	}

	// Parse response
	var data coinGeckoResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	// Map back to symbols
	result := make(map[string]float64)
	for i, symbol := range symbols {
		if i < len(coinIDs) {
			coinID := coinIDs[i]
			if priceData, exists := data[coinID]; exists {
				if price, exists := priceData["usd"]; exists {
					result[symbol] = price
				}
			}
		}
	}

	p.logger.Debug("Fetched prices",
		zap.Int("requested", len(symbols)),
		zap.Int("received", len(result)),
	)

	return result, nil
}

// mapSymbolsToIDs maps cryptocurrency symbols to CoinGecko IDs
func (p *CoinGeckoPriceProvider) mapSymbolsToIDs(symbols []string) []string {
	mapping := map[string]string{
		"BTC": "bitcoin",
		"ETH": "ethereum",
		"LTC": "litecoin",
		"XMR": "monero",
		"RVN": "ravencoin",
		"BCH": "bitcoin-cash",
		"DASH": "dash",
		"ZEC": "zcash",
		"ETC": "ethereum-classic",
		"DOGE": "dogecoin",
	}

	ids := make([]string, 0, len(symbols))
	for _, symbol := range symbols {
		if id, exists := mapping[strings.ToUpper(symbol)]; exists {
			ids = append(ids, id)
		} else {
			p.logger.Warn("Unknown symbol", zap.String("symbol", symbol))
		}
	}

	return ids
}

// SimplePriceProvider provides hardcoded prices for testing
type SimplePriceProvider struct {
	prices map[string]float64
	mu     sync.RWMutex
}

// NewSimplePriceProvider creates a new simple price provider
func NewSimplePriceProvider() *SimplePriceProvider {
	return &SimplePriceProvider{
		prices: map[string]float64{
			"BTC": 60000.0,
			"ETH": 3500.0,
			"LTC": 150.0,
			"XMR": 250.0,
			"RVN": 0.05,
		},
	}
}

// GetPrice returns price for a symbol
func (p *SimplePriceProvider) GetPrice(symbol string) (float64, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	price, exists := p.prices[symbol]
	if !exists {
		return 0, fmt.Errorf("price not found for %s", symbol)
	}

	return price, nil
}

// GetPrices returns prices for multiple symbols
func (p *SimplePriceProvider) GetPrices(symbols []string) (map[string]float64, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	result := make(map[string]float64)
	for _, symbol := range symbols {
		if price, exists := p.prices[symbol]; exists {
			result[symbol] = price
		}
	}

	return result, nil
}

// SetPrice updates price for a symbol (for testing)
func (p *SimplePriceProvider) SetPrice(symbol string, price float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.prices[symbol] = price
}