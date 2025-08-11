package dex

import (
	"fmt"
	"math/big"
	"sync"
	"time"
)

// AMMEngine handles Automated Market Maker operations
type AMMEngine struct {
	config       *Config
	pools        map[string]*LiquidityPool
	priceOracle  *PriceOracle
	mu           sync.RWMutex
	lastUpdate   time.Time
}

// NewAMMEngine creates a new AMM engine
func NewAMMEngine(config *Config) *AMMEngine {
	return &AMMEngine{
		config:      config,
		pools:       make(map[string]*LiquidityPool),
		priceOracle: NewPriceOracle(config.OracleUpdatePeriod),
		lastUpdate:  time.Now(),
	}
}

// ExecuteSwap executes a swap through the AMM
func (e *AMMEngine) ExecuteSwap(route *SwapRoute, params SwapParams) (*SwapResult, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	
	if len(route.Path) < 2 {
		return nil, fmt.Errorf("invalid route: need at least 2 tokens")
	}
	
	amountIn := params.AmountIn
	totalFees := big.NewInt(0)
	
	// Execute swaps through the route
	for i := 0; i < len(route.Path)-1; i++ {
		tokenIn := route.Path[i]
		tokenOut := route.Path[i+1]
		
		// Find pool for this pair
		pool := e.findPool(tokenIn, tokenOut)
		if pool == nil {
			return nil, fmt.Errorf("no pool found for %s-%s", tokenIn, tokenOut)
		}
		
		// Execute swap in pool
		amountOut, fees, err := pool.Swap(tokenIn, amountIn)
		if err != nil {
			return nil, fmt.Errorf("swap failed at %s-%s: %w", tokenIn, tokenOut, err)
		}
		
		// Update for next iteration
		amountIn = amountOut
		totalFees.Add(totalFees, fees)
	}
	
	// Check minimum output
	if params.MinAmountOut != nil && amountIn.Cmp(params.MinAmountOut) < 0 {
		return nil, fmt.Errorf("insufficient output: %v < %v", amountIn, params.MinAmountOut)
	}
	
	// Calculate executed price
	executedPrice := new(big.Float).Quo(
		new(big.Float).SetInt(amountIn),
		new(big.Float).SetInt(params.AmountIn),
	)
	
	return &SwapResult{
		AmountOut:     amountIn,
		Fees:          totalFees,
		PriceImpact:   route.PriceImpact,
		ExecutedPrice: executedPrice,
		Route:         route.Path,
		Timestamp:     time.Now(),
	}, nil
}

// AddPool adds a liquidity pool to the AMM
func (e *AMMEngine) AddPool(pool *LiquidityPool) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	
	pairID := generatePairID(pool.TokenA, pool.TokenB)
	if _, exists := e.pools[pairID]; exists {
		return fmt.Errorf("pool already exists: %s", pairID)
	}
	
	e.pools[pairID] = pool
	e.lastUpdate = time.Now()
	
	return nil
}

// GetPool retrieves a liquidity pool
func (e *AMMEngine) GetPool(tokenA, tokenB string) *LiquidityPool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	
	return e.findPool(tokenA, tokenB)
}

// CalculateOptimalRoute calculates the optimal swap route
func (e *AMMEngine) CalculateOptimalRoute(tokenIn, tokenOut string, amountIn *big.Int) (*SwapRoute, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	
	// Direct swap
	directPool := e.findPool(tokenIn, tokenOut)
	if directPool != nil {
		directOutput, err := directPool.GetAmountOut(tokenIn, amountIn)
		if err == nil {
			priceImpact, _ := directPool.GetPriceImpact(tokenIn, amountIn)
			
			return &SwapRoute{
				Path:         []string{tokenIn, tokenOut},
				Pools:        []string{generatePairID(tokenIn, tokenOut)},
				EstimatedOut: directOutput,
				PriceImpact:  priceImpact,
				Fees:         calculateFee(amountIn, directPool.TradingFee+directPool.ProtocolFee),
			}, nil
		}
	}
	
	// Multi-hop routing (simplified - only 1 intermediate hop)
	bestRoute := &SwapRoute{
		EstimatedOut: big.NewInt(0),
	}
	
	// Find all pools that contain tokenIn or tokenOut
	for pairID, pool := range e.pools {
		// Skip direct pool
		if (pool.TokenA == tokenIn && pool.TokenB == tokenOut) ||
		   (pool.TokenB == tokenIn && pool.TokenA == tokenOut) {
			continue
		}
		
		var intermediateToken string
		
		// Check if this pool can be used as first hop
		if pool.TokenA == tokenIn {
			intermediateToken = pool.TokenB
		} else if pool.TokenB == tokenIn {
			intermediateToken = pool.TokenA
		} else {
			continue
		}
		
		// Find second hop
		secondPool := e.findPool(intermediateToken, tokenOut)
		if secondPool == nil {
			continue
		}
		
		// Calculate output through this route
		firstOutput, err := pool.GetAmountOut(tokenIn, amountIn)
		if err != nil {
			continue
		}
		
		secondOutput, err := secondPool.GetAmountOut(intermediateToken, firstOutput)
		if err != nil {
			continue
		}
		
		// Calculate total price impact
		impact1, _ := pool.GetPriceImpact(tokenIn, amountIn)
		impact2, _ := secondPool.GetPriceImpact(intermediateToken, firstOutput)
		totalImpact := impact1 + impact2
		
		// Check if this route is better
		if secondOutput.Cmp(bestRoute.EstimatedOut) > 0 {
			fees1 := calculateFee(amountIn, pool.TradingFee+pool.ProtocolFee)
			fees2 := calculateFee(firstOutput, secondPool.TradingFee+secondPool.ProtocolFee)
			
			bestRoute = &SwapRoute{
				Path:         []string{tokenIn, intermediateToken, tokenOut},
				Pools:        []string{pairID, generatePairID(intermediateToken, tokenOut)},
				EstimatedOut: secondOutput,
				PriceImpact:  totalImpact,
				Fees:         new(big.Int).Add(fees1, fees2),
			}
		}
	}
	
	if bestRoute.EstimatedOut.Sign() == 0 {
		return nil, fmt.Errorf("no route found from %s to %s", tokenIn, tokenOut)
	}
	
	return bestRoute, nil
}

// UpdatePrices updates prices from oracle
func (e *AMMEngine) UpdatePrices() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	
	// Update prices from oracle
	prices, err := e.priceOracle.GetPrices()
	if err != nil {
		return fmt.Errorf("failed to get oracle prices: %w", err)
	}
	
	// Apply prices to pools if needed
	// This is simplified - in production, you might want to
	// adjust pools based on oracle prices to prevent arbitrage
	_ = prices
	
	e.lastUpdate = time.Now()
	return nil
}

// GetTVL calculates total value locked across all pools
func (e *AMMEngine) GetTVL() *big.Int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	
	totalTVL := big.NewInt(0)
	for _, pool := range e.pools {
		tvl := pool.CalculateTVL()
		totalTVL.Add(totalTVL, tvl)
	}
	
	return totalTVL
}

// GetPoolStats returns statistics for all pools
func (e *AMMEngine) GetPoolStats() map[string]*PoolStats {
	e.mu.RLock()
	defer e.mu.RUnlock()
	
	stats := make(map[string]*PoolStats)
	
	for pairID, pool := range e.pools {
		stats[pairID] = &PoolStats{
			PairID:         pairID,
			TokenA:         pool.TokenA,
			TokenB:         pool.TokenB,
			ReserveA:       new(big.Int).Set(pool.ReserveA),
			ReserveB:       new(big.Int).Set(pool.ReserveB),
			TotalLiquidity: new(big.Int).Set(pool.TotalLiquidity),
			Volume24h:      new(big.Int).Set(pool.Volume24h),
			FeesCollected:  new(big.Int).Set(pool.FeesCollected),
			Price:          pool.GetPrice(),
			TVL:            pool.CalculateTVL(),
		}
	}
	
	return stats
}

// findPool finds a pool for the given token pair
func (e *AMMEngine) findPool(tokenA, tokenB string) *LiquidityPool {
	// Try both orderings
	pairID1 := fmt.Sprintf("%s-%s", tokenA, tokenB)
	if pool, exists := e.pools[pairID1]; exists {
		return pool
	}
	
	pairID2 := fmt.Sprintf("%s-%s", tokenB, tokenA)
	if pool, exists := e.pools[pairID2]; exists {
		return pool
	}
	
	return nil
}

// PoolStats represents statistics for a liquidity pool
type PoolStats struct {
	PairID         string
	TokenA         string
	TokenB         string
	ReserveA       *big.Int
	ReserveB       *big.Int
	TotalLiquidity *big.Int
	Volume24h      *big.Int
	FeesCollected  *big.Int
	Price          *big.Float
	TVL            *big.Int
	APY            float64
}