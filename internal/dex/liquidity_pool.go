package dex

import (
	"fmt"
	"math/big"
	"sync"
	"time"
)

// LiquidityPool represents an AMM liquidity pool
type LiquidityPool struct {
	TokenA         string
	TokenB         string
	ReserveA       *big.Int
	ReserveB       *big.Int
	TotalLiquidity *big.Int
	K              *big.Int // Constant product (x * y = k)
	
	// Fee configuration
	TradingFee  float64
	ProtocolFee float64
	
	// Statistics
	Volume24h      *big.Int
	VolumeAllTime  *big.Int
	FeesCollected  *big.Int
	LastUpdate     time.Time
	
	// Price tracking
	LastPrice      *big.Float
	PriceHistory   []PricePoint
	
	mu sync.RWMutex
}

// PricePoint represents a historical price point
type PricePoint struct {
	Price     *big.Float
	Timestamp time.Time
	Volume    *big.Int
}

// NewLiquidityPool creates a new liquidity pool
func NewLiquidityPool(tokenA, tokenB string, config *Config) *LiquidityPool {
	return &LiquidityPool{
		TokenA:         tokenA,
		TokenB:         tokenB,
		ReserveA:       big.NewInt(0),
		ReserveB:       big.NewInt(0),
		TotalLiquidity: big.NewInt(0),
		K:              big.NewInt(0),
		TradingFee:     config.TradingFee,
		ProtocolFee:    config.ProtocolFee,
		Volume24h:      big.NewInt(0),
		VolumeAllTime:  big.NewInt(0),
		FeesCollected:  big.NewInt(0),
		LastPrice:      big.NewFloat(0),
		PriceHistory:   make([]PricePoint, 0),
		LastUpdate:     time.Now(),
	}
}

// Initialize sets up the pool with initial liquidity
func (p *LiquidityPool) Initialize(initialLiquidity *big.Int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	// For initial liquidity, assume 1:1 ratio
	p.ReserveA = new(big.Int).Div(initialLiquidity, big.NewInt(2))
	p.ReserveB = new(big.Int).Div(initialLiquidity, big.NewInt(2))
	p.TotalLiquidity = initialLiquidity
	
	// Calculate constant product
	p.updateK()
	p.updatePrice()
}

// AddLiquidity adds liquidity to the pool
func (p *LiquidityPool) AddLiquidity(amountA, amountB *big.Int) (*big.Int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	if amountA.Sign() <= 0 || amountB.Sign() <= 0 {
		return nil, fmt.Errorf("amounts must be positive")
	}
	
	var lpTokens *big.Int
	
	if p.TotalLiquidity.Sign() == 0 {
		// First liquidity provider
		lpTokens = sqrt(new(big.Int).Mul(amountA, amountB))
		p.ReserveA = amountA
		p.ReserveB = amountB
		p.TotalLiquidity = lpTokens
	} else {
		// Subsequent liquidity providers
		// Ensure ratio matches current pool ratio
		expectedB := new(big.Int).Div(
			new(big.Int).Mul(amountA, p.ReserveB),
			p.ReserveA,
		)
		
		if !isWithinTolerance(amountB, expectedB, 0.01) {
			return nil, fmt.Errorf("incorrect ratio: expected %v tokenB, got %v", expectedB, amountB)
		}
		
		// Calculate LP tokens proportionally
		lpTokens = new(big.Int).Div(
			new(big.Int).Mul(amountA, p.TotalLiquidity),
			p.ReserveA,
		)
		
		// Update reserves
		p.ReserveA.Add(p.ReserveA, amountA)
		p.ReserveB.Add(p.ReserveB, amountB)
		p.TotalLiquidity.Add(p.TotalLiquidity, lpTokens)
	}
	
	p.updateK()
	p.updatePrice()
	p.LastUpdate = time.Now()
	
	return lpTokens, nil
}

// RemoveLiquidity removes liquidity from the pool
func (p *LiquidityPool) RemoveLiquidity(lpTokens *big.Int) (*big.Int, *big.Int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	if lpTokens.Sign() <= 0 {
		return nil, nil, fmt.Errorf("LP tokens must be positive")
	}
	
	if lpTokens.Cmp(p.TotalLiquidity) > 0 {
		return nil, nil, fmt.Errorf("insufficient LP tokens in pool")
	}
	
	// Calculate proportional amounts
	amountA := new(big.Int).Div(
		new(big.Int).Mul(lpTokens, p.ReserveA),
		p.TotalLiquidity,
	)
	amountB := new(big.Int).Div(
		new(big.Int).Mul(lpTokens, p.ReserveB),
		p.TotalLiquidity,
	)
	
	// Update reserves and total liquidity
	p.ReserveA.Sub(p.ReserveA, amountA)
	p.ReserveB.Sub(p.ReserveB, amountB)
	p.TotalLiquidity.Sub(p.TotalLiquidity, lpTokens)
	
	p.updateK()
	p.updatePrice()
	p.LastUpdate = time.Now()
	
	return amountA, amountB, nil
}

// Swap executes a swap in the pool
func (p *LiquidityPool) Swap(tokenIn string, amountIn *big.Int) (*big.Int, *big.Int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	if amountIn.Sign() <= 0 {
		return nil, nil, fmt.Errorf("amount must be positive")
	}
	
	var reserveIn, reserveOut *big.Int
	var isTokenA bool
	
	if tokenIn == p.TokenA {
		reserveIn = p.ReserveA
		reserveOut = p.ReserveB
		isTokenA = true
	} else if tokenIn == p.TokenB {
		reserveIn = p.ReserveB
		reserveOut = p.ReserveA
		isTokenA = false
	} else {
		return nil, nil, fmt.Errorf("invalid token")
	}
	
	// Calculate fees
	tradingFee := calculateFee(amountIn, p.TradingFee)
	protocolFee := calculateFee(amountIn, p.ProtocolFee)
	totalFee := new(big.Int).Add(tradingFee, protocolFee)
	
	// Amount after fees
	amountInAfterFee := new(big.Int).Sub(amountIn, totalFee)
	
	// Calculate output amount using constant product formula
	// (x + Δx) * (y - Δy) = k
	// Δy = y - k/(x + Δx)
	numerator := new(big.Int).Mul(amountInAfterFee, reserveOut)
	denominator := new(big.Int).Add(reserveIn, amountInAfterFee)
	amountOut := new(big.Int).Div(numerator, denominator)
	
	if amountOut.Sign() <= 0 {
		return nil, nil, fmt.Errorf("insufficient liquidity")
	}
	
	// Update reserves
	if isTokenA {
		p.ReserveA.Add(p.ReserveA, amountIn)
		p.ReserveB.Sub(p.ReserveB, amountOut)
	} else {
		p.ReserveB.Add(p.ReserveB, amountIn)
		p.ReserveA.Sub(p.ReserveA, amountOut)
	}
	
	// Update statistics
	p.Volume24h.Add(p.Volume24h, amountIn)
	p.VolumeAllTime.Add(p.VolumeAllTime, amountIn)
	p.FeesCollected.Add(p.FeesCollected, totalFee)
	
	p.updatePrice()
	p.recordPricePoint(amountIn)
	p.LastUpdate = time.Now()
	
	return amountOut, totalFee, nil
}

// GetPrice returns the current price of tokenA in terms of tokenB
func (p *LiquidityPool) GetPrice() *big.Float {
	p.mu.RLock()
	defer p.mu.RUnlock()
	
	if p.ReserveA.Sign() == 0 || p.ReserveB.Sign() == 0 {
		return big.NewFloat(0)
	}
	
	return new(big.Float).Quo(
		new(big.Float).SetInt(p.ReserveB),
		new(big.Float).SetInt(p.ReserveA),
	)
}

// CalculateShare calculates the percentage share of the pool
func (p *LiquidityPool) CalculateShare(lpTokens *big.Int) float64 {
	p.mu.RLock()
	defer p.mu.RUnlock()
	
	if p.TotalLiquidity.Sign() == 0 {
		return 0
	}
	
	share := new(big.Float).Quo(
		new(big.Float).SetInt(lpTokens),
		new(big.Float).SetInt(p.TotalLiquidity),
	)
	
	result, _ := share.Float64()
	return result * 100 // Return as percentage
}

// CalculateTVL calculates the total value locked in the pool
func (p *LiquidityPool) CalculateTVL() *big.Int {
	p.mu.RLock()
	defer p.mu.RUnlock()
	
	// For simplicity, return sum of reserves
	// In production, this would use oracle prices
	return new(big.Int).Add(p.ReserveA, p.ReserveB)
}

// GetAmountOut calculates the output amount for a given input
func (p *LiquidityPool) GetAmountOut(tokenIn string, amountIn *big.Int) (*big.Int, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	
	var reserveIn, reserveOut *big.Int
	
	if tokenIn == p.TokenA {
		reserveIn = p.ReserveA
		reserveOut = p.ReserveB
	} else if tokenIn == p.TokenB {
		reserveIn = p.ReserveB
		reserveOut = p.ReserveA
	} else {
		return nil, fmt.Errorf("invalid token")
	}
	
	// Calculate fees
	totalFee := calculateFee(amountIn, p.TradingFee+p.ProtocolFee)
	amountInAfterFee := new(big.Int).Sub(amountIn, totalFee)
	
	// Calculate output amount
	numerator := new(big.Int).Mul(amountInAfterFee, reserveOut)
	denominator := new(big.Int).Add(reserveIn, amountInAfterFee)
	
	return new(big.Int).Div(numerator, denominator), nil
}

// GetPriceImpact calculates the price impact of a trade
func (p *LiquidityPool) GetPriceImpact(tokenIn string, amountIn *big.Int) (float64, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	
	// Get current price
	currentPrice := p.GetPrice()
	
	// Calculate new price after swap
	amountOut, err := p.GetAmountOut(tokenIn, amountIn)
	if err != nil {
		return 0, err
	}
	
	var newReserveA, newReserveB *big.Int
	if tokenIn == p.TokenA {
		newReserveA = new(big.Int).Add(p.ReserveA, amountIn)
		newReserveB = new(big.Int).Sub(p.ReserveB, amountOut)
	} else {
		newReserveB = new(big.Int).Add(p.ReserveB, amountIn)
		newReserveA = new(big.Int).Sub(p.ReserveA, amountOut)
	}
	
	newPrice := new(big.Float).Quo(
		new(big.Float).SetInt(newReserveB),
		new(big.Float).SetInt(newReserveA),
	)
	
	// Calculate price impact
	impact := new(big.Float).Sub(newPrice, currentPrice)
	impact.Quo(impact, currentPrice)
	
	result, _ := impact.Float64()
	if result < 0 {
		result = -result
	}
	
	return result, nil
}

// updateK updates the constant product
func (p *LiquidityPool) updateK() {
	p.K = new(big.Int).Mul(p.ReserveA, p.ReserveB)
}

// updatePrice updates the last price
func (p *LiquidityPool) updatePrice() {
	p.LastPrice = p.GetPrice()
}

// recordPricePoint records a price point in history
func (p *LiquidityPool) recordPricePoint(volume *big.Int) {
	point := PricePoint{
		Price:     p.LastPrice,
		Timestamp: time.Now(),
		Volume:    volume,
	}
	
	p.PriceHistory = append(p.PriceHistory, point)
	
	// Keep only last 1000 points
	if len(p.PriceHistory) > 1000 {
		p.PriceHistory = p.PriceHistory[1:]
	}
}

// Helper functions

// sqrt calculates the square root of a big.Int
func sqrt(n *big.Int) *big.Int {
	if n.Sign() == 0 {
		return big.NewInt(0)
	}
	
	x := new(big.Int).Set(n)
	y := new(big.Int).Add(new(big.Int).Div(x, big.NewInt(2)), big.NewInt(1))
	
	for y.Cmp(x) < 0 {
		x.Set(y)
		y.Add(new(big.Int).Div(n, x), x)
		y.Div(y, big.NewInt(2))
	}
	
	return x
}

// calculateFee calculates the fee amount
func calculateFee(amount *big.Int, feeRate float64) *big.Int {
	fee := new(big.Float).Mul(
		new(big.Float).SetInt(amount),
		big.NewFloat(feeRate),
	)
	
	result, _ := fee.Int(nil)
	return result
}

// isWithinTolerance checks if two values are within a tolerance
func isWithinTolerance(a, b *big.Int, tolerance float64) bool {
	if a.Sign() == 0 && b.Sign() == 0 {
		return true
	}
	
	diff := new(big.Int).Sub(a, b)
	if diff.Sign() < 0 {
		diff.Neg(diff)
	}
	
	maxDiff := new(big.Float).Mul(
		new(big.Float).SetInt(b),
		big.NewFloat(tolerance),
	)
	
	maxDiffInt, _ := maxDiff.Int(nil)
	return diff.Cmp(maxDiffInt) <= 0
}