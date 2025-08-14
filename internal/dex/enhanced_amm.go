package dex

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/shapeshed/unixtime"
	"go.uber.org/zap"
)

// EnhancedAMMEngine provides advanced AMM functionality for the DEX
type EnhancedAMMEngine struct {
	pools           map[string]*EnhancedLiquidityPool
	orderBooks      map[string]*OrderBook
	revenueTracker  *RevenueTracker
	priceOracle     *PriceOracle
	crossChainMgr   *CrossChainManager
	ctx             context.Context
	cancel          context.CancelFunc
	mutex           sync.RWMutex
}

// EnhancedLiquidityPool represents an advanced liquidity pool with concentrated liquidity
type EnhancedLiquidityPool struct {
	Token0          string
	Token1          string
	Reserve0        float64
	Reserve1        float64
	TotalSupply     float64
	FeeTier         float64
	PriceRange      *PriceRange
	TickSpacing     int
	CurrentTick     int
	LiquidityNet    map[int]float64
	Positions       map[string]*Position
	LastUpdated     time.Time
	Volume24h       float64
	Fees24h         float64
	APR             float64
}

// PriceRange defines the price range for concentrated liquidity
type PriceRange struct {
	LowerPrice float64
	UpperPrice float64
}

// Position represents a liquidity provider's position
type Position struct {
	Owner      string
	LowerTick  int
	UpperTick  int
	Liquidity  float64
	Token0Owed float64
	Token1Owed float64
	LastUpdate time.Time
}

// OrderBook manages limit orders alongside AMM
type OrderBook struct {
	BuyOrders  []*LimitOrder
	SellOrders []*LimitOrder
	Matches    []*Trade
	mutex      sync.RWMutex
}

// LimitOrder represents a limit order
type LimitOrder struct {
	ID        string
	Type      string // "buy" or "sell"
	Price     float64
	Amount    float64
	UserID    string
	Timestamp time.Time
	Status    string // "open", "filled", "cancelled"
}

// Trade represents a matched trade
type Trade struct {
	ID        string
	BuyOrder  *LimitOrder
	SellOrder *LimitOrder
	Price     float64
	Amount    float64
	Timestamp time.Time
}

// RevenueTracker tracks DEX revenue
type RevenueTracker struct {
	TotalFees      float64
	DailyFees      float64
	WeeklyFees     float64
	MonthlyFees    float64
	FeeBreakdown   map[string]float64
	UserRevenue    map[string]float64
	mutex          sync.RWMutex
}

// PriceOracle provides price feeds
type PriceOracle struct {
	Prices     map[string]float64
	Sources    map[string]*PriceSource
	LastUpdate time.Time
	mutex      sync.RWMutex
}

// PriceSource represents a price source
type PriceSource struct {
	Name      string
	URL       string
	Price     float64
	LastFetch time.Time
	Reliable  bool
}

// CrossChainManager handles cross-chain operations
type CrossChainManager struct {
	SupportedChains map[string]*ChainConfig
	BridgeContracts map[string]string
	LastSync        time.Time
	mutex           sync.RWMutex
}

// ChainConfig represents a blockchain configuration
type ChainConfig struct {
	Name        string
	RPCURL      string
	ChainID     int
	BridgeAddr  string
	TokenAddr   string
	Decimals    int
	LastBlock   uint64
}

// NewEnhancedAMMEngine creates a new enhanced AMM engine
func NewEnhancedAMMEngine() *EnhancedAMMEngine {
	ctx, cancel := context.WithCancel(context.Background())
	
	engine := &EnhancedAMMEngine{
		pools:          make(map[string]*EnhancedLiquidityPool),
		orderBooks:     make(map[string]*OrderBook),
		revenueTracker: NewRevenueTracker(),
		priceOracle:    NewPriceOracle(),
		crossChainMgr:  NewCrossChainManager(),
		ctx:            ctx,
		cancel:         cancel,
	}

	// Initialize default pools
	engine.initializeDefaultPools()
	
	// Start background processes
	go engine.priceUpdateLoop()
	go engine.liquidityOptimizationLoop()
	go engine.crossChainSyncLoop()
	go engine.revenueCalculationLoop()

	return engine
}

// initializeDefaultPools sets up initial liquidity pools
func (e *EnhancedAMMEngine) initializeDefaultPools() {
	// BTC/USDT pool
	btcUsdtPool := &EnhancedLiquidityPool{
		Token0:      "BTC",
		Token1:      "USDT",
		Reserve0:    10.0,    // 10 BTC
		Reserve1:    850000.0, // 850k USDT
		FeeTier:     0.003,   // 0.3%
		PriceRange: &PriceRange{
			LowerPrice: 80000.0,
			UpperPrice: 90000.0,
		},
		TickSpacing: 60,
		CurrentTick: 85000,
		LiquidityNet: make(map[int]float64),
		Positions:    make(map[string]*Position),
		LastUpdated:  time.Now(),
	}

	// ETH/USDT pool
	ethUsdtPool := &EnhancedLiquidityPool{
		Token0:      "ETH",
		Token1:      "USDT",
		Reserve0:    100.0,   // 100 ETH
		Reserve1:    350000.0, // 350k USDT
		FeeTier:     0.003,
		PriceRange: &PriceRange{
			LowerPrice: 3400.0,
			UpperPrice: 3600.0,
		},
		TickSpacing: 60,
		CurrentTick: 3500,
		LiquidityNet: make(map[int]float64),
		Positions:    make(map[string]*Position),
		LastUpdated:  time.Now(),
	}

	e.mutex.Lock()
	defer e.mutex.Unlock()
	
	e.pools["BTC-USDT"] = btcUsdtPool
	e.pools["ETH-USDT"] = ethUsdtPool
	
	// Initialize order books
	e.orderBooks["BTC-USDT"] = NewOrderBook()
	e.orderBooks["ETH-USDT"] = NewOrderBook()
}

// AddLiquidity adds liquidity to a pool
func (e *EnhancedAMMEngine) AddLiquidity(poolID string, amount0, amount1 float64, userID string) error {
	e.mutex.Lock()
	defer e.mutex.Unlock()

	pool, exists := e.pools[poolID]
	if !exists {
		return fmt.Errorf("pool %s not found", poolID)
	}

	// Calculate liquidity tokens
	liquidity := math.Sqrt(amount0 * amount1)
	
	// Update pool reserves
	pool.Reserve0 += amount0
	pool.Reserve1 += amount1
	pool.TotalSupply += liquidity
	pool.LastUpdated = time.Now()

	// Record position
	position := &Position{
		Owner:      userID,
		Liquidity:  liquidity,
		LastUpdate: time.Now(),
	}
	pool.Positions[userID] = position

	zap.L().Info("Liquidity added",
		zap.String("pool", poolID),
		zap.Float64("amount0", amount0),
		zap.Float64("amount1", amount1),
		zap.String("user", userID),
	)

	return nil
}

// Swap performs a token swap
func (e *EnhancedAMMEngine) Swap(poolID string, amountIn float64, tokenIn string, userID string) (float64, error) {
	e.mutex.Lock()
	defer e.mutex.Unlock()

	pool, exists := e.pools[poolID]
	if !exists {
		return 0, fmt.Errorf("pool %s not found", poolID)
	}

	// Calculate swap using constant product formula
	var amountOut float64
	var fee float64

	if tokenIn == pool.Token0 {
		// Swap token0 for token1
		fee = amountIn * pool.FeeTier
		amountInAfterFee := amountIn - fee
		
		// x * y = k
		k := pool.Reserve0 * pool.Reserve1
		newReserve0 := pool.Reserve0 + amountInAfterFee
		newReserve1 := k / newReserve0
		amountOut = pool.Reserve1 - newReserve1
		
		pool.Reserve0 = newReserve0
		pool.Reserve1 = newReserve1
	} else {
		// Swap token1 for token0
		fee = amountIn * pool.FeeTier
		amountInAfterFee := amountIn - fee
		
		k := pool.Reserve0 * pool.Reserve1
		newReserve1 := pool.Reserve1 + amountInAfterFee
		newReserve0 := k / newReserve1
		amountOut = pool.Reserve0 - newReserve0
		
		pool.Reserve0 = newReserve0
		pool.Reserve1 = newReserve1
	}

	// Update volume and fees
	pool.Volume24h += amountIn
	pool.Fees24h += fee
	pool.LastUpdated = time.Now()

	// Track revenue
	e.revenueTracker.AddFee(poolID, fee)

	zap.L().Info("Swap executed",
		zap.String("pool", poolID),
		zap.Float64("amount_in", amountIn),
		zap.Float64("amount_out", amountOut),
		zap.Float64("fee", fee),
		zap.String("user", userID),
	)

	return amountOut, nil
}

// PlaceLimitOrder places a limit order
func (e *EnhancedAMMEngine) PlaceLimitOrder(orderBookID string, order *LimitOrder) error {
	ob, exists := e.orderBooks[orderBookID]
	if !exists {
		return fmt.Errorf("order book %s not found", orderBookID)
	}

	ob.mutex.Lock()
	defer ob.mutex.Unlock()

	if order.Type == "buy" {
		ob.BuyOrders = append(ob.BuyOrders, order)
	} else {
		ob.SellOrders = append(ob.SellOrders, order)
	}

	// Attempt to match orders
	e.matchOrders(orderBookID)

	return nil
}

// matchOrders attempts to match buy and sell orders
func (e *EnhancedAMMEngine) matchOrders(orderBookID string) {
	ob := e.orderBooks[orderBookID]
	ob.mutex.Lock()
	defer ob.mutex.Unlock()

	// Sort orders by price (buy: highest first, sell: lowest first)
	// Simple matching algorithm - can be enhanced
	for i, buyOrder := range ob.BuyOrders {
		for j, sellOrder := range ob.SellOrders {
			if buyOrder.Price >= sellOrder.Price {
				// Execute trade
				trade := &Trade{
					ID:        fmt.Sprintf("trade-%d", unixtime.Now()),
					BuyOrder:  buyOrder,
					SellOrder: sellOrder,
					Price:     sellOrder.Price,
					Amount:    math.Min(buyOrder.Amount, sellOrder.Amount),
					Timestamp: time.Now(),
				}
				
				ob.Matches = append(ob.Matches, trade)
				
				// Update order amounts
				buyOrder.Amount -= trade.Amount
				sellOrder.Amount -= trade.Amount
				
				// Remove filled orders
				if buyOrder.Amount <= 0 {
					ob.BuyOrders = append(ob.BuyOrders[:i], ob.BuyOrders[i+1:]...)
				}
				if sellOrder.Amount <= 0 {
					ob.SellOrders = append(ob.SellOrders[:j], ob.SellOrders[j+1:]...)
				}
				
				break
			}
		}
	}
}

// GetPoolStats returns pool statistics
func (e *EnhancedAMMEngine) GetPoolStats(poolID string) map[string]interface{} {
	e.mutex.RLock()
	defer e.mutex.RUnlock()

	pool, exists := e.pools[poolID]
	if !exists {
		return nil
	}

	return map[string]interface{}{
		"token0":        pool.Token0,
		"token1":        pool.Token1,
		"reserve0":      pool.Reserve0,
		"reserve1":      pool.Reserve1,
		"total_supply":  pool.TotalSupply,
		"fee_tier":      pool.FeeTier,
		"volume_24h":    pool.Volume24h,
		"fees_24h":      pool.Fees24h,
		"apr":           pool.APR,
		"last_updated":  pool.LastUpdated,
	}
}

// priceUpdateLoop updates prices from oracle
func (e *EnhancedAMMEngine) priceUpdateLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-e.ctx.Done():
			return
		case <-ticker.C:
			e.updatePrices()
		}
	}
}

// updatePrices fetches latest prices from oracle
func (e *EnhancedAMMEngine) updatePrices() {
	e.mutex.Lock()
	defer e.mutex.Unlock()

	// Update all pool prices
	for _, pool := range e.pools {
		price0 := e.priceOracle.GetPrice(pool.Token0)
		price1 := e.priceOracle.GetPrice(pool.Token1)
		
		if price0 > 0 && price1 > 0 {
			currentPrice := price1 / price0
			pool.CurrentTick = int(currentPrice * 100)
		}
	}
}

// liquidityOptimizationLoop optimizes liquidity allocation
func (e *EnhancedAMMEngine) liquidityOptimizationLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-e.ctx.Done():
			return
		case <-ticker.C:
			e.optimizeLiquidity()
		}
	}
}

// optimizeLiquidity optimizes liquidity allocation across pools
func (e *EnhancedAMMEngine) optimizeLiquidity() {
	e.mutex.Lock()
	defer e.mutex.Unlock()

	// AI-driven liquidity optimization
	for poolID, pool := range e.pools {
		// Calculate optimal fee tier based on volume
		optimalFee := e.calculateOptimalFee(pool)
		pool.FeeTier = optimalFee
		
		// Calculate APR based on fees and liquidity
		pool.APR = e.calculateAPR(pool)
		
		zap.L().Info("Liquidity optimized",
			zap.String("pool", poolID),
			zap.Float64("new_fee", optimalFee),
			zap.Float64("apr", pool.APR),
		)
	}
}

// calculateOptimalFee calculates optimal fee tier based on volume
func (e *EnhancedAMMEngine) calculateOptimalFee(pool *EnhancedLiquidityPool) float64 {
	volume := pool.Volume24h
	liquidity := pool.Reserve0 + pool.Reserve1
	
	if liquidity == 0 {
		return 0.003 // Default fee
	}
	
	volumeRatio := volume / liquidity
	
	// Dynamic fee calculation
	if volumeRatio > 0.1 {
		return 0.005 // High volume, higher fee
	} else if volumeRatio > 0.05 {
		return 0.003 // Medium volume
	} else {
		return 0.001 // Low volume, lower fee
	}
}

// calculateAPR calculates APR based on fees and liquidity
func (e *EnhancedAMMEngine) calculateAPR(pool *EnhancedLiquidityPool) float64 {
	if pool.TotalSupply == 0 {
		return 0.0
	}
	
	yearlyFees := pool.Fees24h * 365
	return (yearlyFees / pool.TotalSupply) * 100
}

// NewOrderBook creates a new order book
func NewOrderBook() *OrderBook {
	return &OrderBook{
		BuyOrders:  make([]*LimitOrder, 0),
		SellOrders: make([]*LimitOrder, 0),
		Matches:    make([]*Trade, 0),
	}
}

// NewRevenueTracker creates a new revenue tracker
func NewRevenueTracker() *RevenueTracker {
	return &RevenueTracker{
		TotalFees:    0.0,
		DailyFees:    0.0,
		WeeklyFees:   0.0,
		MonthlyFees:  0.0,
		FeeBreakdown: make(map[string]float64),
		UserRevenue:  make(map[string]float64),
	}
}

// NewPriceOracle creates a new price oracle
func NewPriceOracle() *PriceOracle {
	return &PriceOracle{
		Prices:  make(map[string]float64),
		Sources: make(map[string]*PriceSource),
	}
}

// AddFee adds fee to revenue tracking
func (rt *RevenueTracker) AddFee(poolID string, fee float64) {
	rt.mutex.Lock()
	defer rt.mutex.Unlock()
	
	rt.TotalFees += fee
	rt.FeeBreakdown[poolID] += fee
}

// GetStats returns revenue statistics
func (rt *RevenueTracker) GetStats() map[string]interface{} {
	rt.mutex.RLock()
	defer rt.mutex.RUnlock()
	
	return map[string]interface{}{
		"total_fees":    rt.TotalFees,
		"daily_fees":    rt.DailyFees,
		"weekly_fees":   rt.WeeklyFees,
		"monthly_fees":  rt.MonthlyFees,
		"fee_breakdown": rt.FeeBreakdown,
		"user_revenue":  rt.UserRevenue,
	}
}

// GetPrice returns current price for a token
func (po *PriceOracle) GetPrice(token string) float64 {
	po.mutex.RLock()
	defer po.mutex.RUnlock()
	
	return po.Prices[token]
}

// NewCrossChainManager creates a new cross-chain manager
func NewCrossChainManager() *CrossChainManager {
	return &CrossChainManager{
		SupportedChains: make(map[string]*ChainConfig),
		BridgeContracts: make(map[string]string),
	}
}
