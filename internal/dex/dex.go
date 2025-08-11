package dex

import (
	"context"
	"fmt"
	"math/big"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/common"
	"github.com/shizukutanaka/Otedama/internal/database"
)

// DEX represents the decentralized exchange
type DEX struct {
	pairs        map[string]*LiquidityPool
	orderBook    *OrderBook
	ammEngine    *AMMEngine
	priceOracle  *PriceOracle
	router       *SwapRouter
	db           *database.Database
	config       *Config
	mu           sync.RWMutex
	metrics      *DEXMetrics
	eventEmitter *EventEmitter
}

// Config holds DEX configuration
type Config struct {
	MinLiquidity       *big.Int
	MaxSlippage        float64
	TradingFee         float64
	ProtocolFee        float64
	MaxPriceImpact     float64
	OracleUpdatePeriod time.Duration
	EnableOrderBook    bool
	EnableAMM          bool
}

// NewDEX creates a new DEX instance
func NewDEX(config *Config, db *database.Database) (*DEX, error) {
	if config == nil {
		return nil, fmt.Errorf("config is required")
	}

	dex := &DEX{
		pairs:        make(map[string]*LiquidityPool),
		config:       config,
		db:           db,
		metrics:      NewDEXMetrics(),
		eventEmitter: NewEventEmitter(),
	}

	// Initialize components
	if config.EnableOrderBook {
		dex.orderBook = NewOrderBook()
	}

	if config.EnableAMM {
		dex.ammEngine = NewAMMEngine(config)
	}

	dex.priceOracle = NewPriceOracle(config.OracleUpdatePeriod)
	dex.router = NewSwapRouter(dex)

	return dex, nil
}

// Start initializes and starts the DEX
func (d *DEX) Start(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Start price oracle
	if err := d.priceOracle.Start(ctx); err != nil {
		return fmt.Errorf("failed to start price oracle: %w", err)
	}

	// Load existing pairs from database
	if err := d.loadPairs(ctx); err != nil {
		return fmt.Errorf("failed to load pairs: %w", err)
	}

	// Start event processing
	go d.processEvents(ctx)

	// Start metrics collection
	go d.collectMetrics(ctx)

	return nil
}

// CreatePair creates a new trading pair
func (d *DEX) CreatePair(ctx context.Context, tokenA, tokenB string, initialLiquidity *big.Int) (*LiquidityPool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	pairID := generatePairID(tokenA, tokenB)
	
	// Check if pair already exists
	if _, exists := d.pairs[pairID]; exists {
		return nil, fmt.Errorf("pair %s already exists", pairID)
	}

	// Validate initial liquidity
	if initialLiquidity.Cmp(d.config.MinLiquidity) < 0 {
		return nil, fmt.Errorf("initial liquidity below minimum: %v < %v", 
			initialLiquidity, d.config.MinLiquidity)
	}

	// Create new liquidity pool
	pool := NewLiquidityPool(tokenA, tokenB, d.config)
	pool.Initialize(initialLiquidity)

	// Store in database
	if err := d.db.StorePair(ctx, pairID, pool); err != nil {
		return nil, fmt.Errorf("failed to store pair: %w", err)
	}

	d.pairs[pairID] = pool

	// Emit event
	d.eventEmitter.Emit(EventPairCreated{
		PairID:    pairID,
		TokenA:    tokenA,
		TokenB:    tokenB,
		Liquidity: initialLiquidity,
		Timestamp: time.Now(),
	})

	d.metrics.PairsCreated.Inc()

	return pool, nil
}

// Swap executes a token swap
func (d *DEX) Swap(ctx context.Context, params SwapParams) (*SwapResult, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	// Validate parameters
	if err := params.Validate(); err != nil {
		return nil, fmt.Errorf("invalid swap params: %w", err)
	}

	// Find best route
	route, err := d.router.FindBestRoute(params)
	if err != nil {
		return nil, fmt.Errorf("no route found: %w", err)
	}

	// Check slippage
	if route.PriceImpact > d.config.MaxPriceImpact {
		return nil, fmt.Errorf("price impact too high: %.2f%% > %.2f%%", 
			route.PriceImpact*100, d.config.MaxPriceImpact*100)
	}

	// Execute swap
	result, err := d.executeSwap(ctx, route, params)
	if err != nil {
		return nil, fmt.Errorf("swap execution failed: %w", err)
	}

	// Update metrics
	d.metrics.SwapsExecuted.Inc()
	d.metrics.VolumeTraded.Add(float64(params.AmountIn.Int64()))

	// Emit event
	d.eventEmitter.Emit(EventSwapExecuted{
		User:      params.User,
		TokenIn:   params.TokenIn,
		TokenOut:  params.TokenOut,
		AmountIn:  params.AmountIn,
		AmountOut: result.AmountOut,
		Timestamp: time.Now(),
	})

	return result, nil
}

// AddLiquidity adds liquidity to a pool
func (d *DEX) AddLiquidity(ctx context.Context, params LiquidityParams) (*LiquidityResult, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	pairID := generatePairID(params.TokenA, params.TokenB)
	pool, exists := d.pairs[pairID]
	if !exists {
		return nil, fmt.Errorf("pair %s does not exist", pairID)
	}

	// Calculate liquidity tokens
	lpTokens, err := pool.AddLiquidity(params.AmountA, params.AmountB)
	if err != nil {
		return nil, fmt.Errorf("failed to add liquidity: %w", err)
	}

	// Store in database
	if err := d.db.StoreLiquidity(ctx, params.User, pairID, lpTokens); err != nil {
		return nil, fmt.Errorf("failed to store liquidity: %w", err)
	}

	result := &LiquidityResult{
		LPTokens:  lpTokens,
		ShareOfPool: pool.CalculateShare(lpTokens),
		Timestamp: time.Now(),
	}

	// Update metrics
	d.metrics.LiquidityAdded.Add(float64(params.AmountA.Int64() + params.AmountB.Int64()))

	// Emit event
	d.eventEmitter.Emit(EventLiquidityAdded{
		User:     params.User,
		PairID:   pairID,
		AmountA:  params.AmountA,
		AmountB:  params.AmountB,
		LPTokens: lpTokens,
		Timestamp: time.Now(),
	})

	return result, nil
}

// RemoveLiquidity removes liquidity from a pool
func (d *DEX) RemoveLiquidity(ctx context.Context, params RemoveLiquidityParams) (*RemoveLiquidityResult, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	pairID := generatePairID(params.TokenA, params.TokenB)
	pool, exists := d.pairs[pairID]
	if !exists {
		return nil, fmt.Errorf("pair %s does not exist", pairID)
	}

	// Calculate amounts to return
	amountA, amountB, err := pool.RemoveLiquidity(params.LPTokens)
	if err != nil {
		return nil, fmt.Errorf("failed to remove liquidity: %w", err)
	}

	// Update database
	if err := d.db.RemoveLiquidity(ctx, params.User, pairID, params.LPTokens); err != nil {
		return nil, fmt.Errorf("failed to update liquidity: %w", err)
	}

	result := &RemoveLiquidityResult{
		AmountA:   amountA,
		AmountB:   amountB,
		Timestamp: time.Now(),
	}

	// Update metrics
	d.metrics.LiquidityRemoved.Add(float64(amountA.Int64() + amountB.Int64()))

	// Emit event
	d.eventEmitter.Emit(EventLiquidityRemoved{
		User:     params.User,
		PairID:   pairID,
		LPTokens: params.LPTokens,
		AmountA:  amountA,
		AmountB:  amountB,
		Timestamp: time.Now(),
	})

	return result, nil
}

// GetPrice returns the current price for a pair
func (d *DEX) GetPrice(tokenA, tokenB string) (*big.Float, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	pairID := generatePairID(tokenA, tokenB)
	pool, exists := d.pairs[pairID]
	if !exists {
		return nil, fmt.Errorf("pair %s does not exist", pairID)
	}

	return pool.GetPrice(), nil
}

// GetPairInfo returns information about a trading pair
func (d *DEX) GetPairInfo(tokenA, tokenB string) (*PairInfo, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	pairID := generatePairID(tokenA, tokenB)
	pool, exists := d.pairs[pairID]
	if !exists {
		return nil, fmt.Errorf("pair %s does not exist", pairID)
	}

	return &PairInfo{
		PairID:        pairID,
		TokenA:        tokenA,
		TokenB:        tokenB,
		ReserveA:      pool.ReserveA,
		ReserveB:      pool.ReserveB,
		TotalLiquidity: pool.TotalLiquidity,
		Price:         pool.GetPrice(),
		Volume24h:     pool.Volume24h,
		TVL:           pool.CalculateTVL(),
	}, nil
}

// executeSwap performs the actual swap execution
func (d *DEX) executeSwap(ctx context.Context, route *SwapRoute, params SwapParams) (*SwapResult, error) {
	var amountOut *big.Int
	var fees *big.Int

	if d.config.EnableAMM {
		// Execute through AMM
		result, err := d.ammEngine.ExecuteSwap(route, params)
		if err != nil {
			return nil, err
		}
		amountOut = result.AmountOut
		fees = result.Fees
	} else if d.config.EnableOrderBook {
		// Execute through order book
		result, err := d.orderBook.ExecuteOrder(params)
		if err != nil {
			return nil, err
		}
		amountOut = result.AmountOut
		fees = result.Fees
	} else {
		return nil, fmt.Errorf("no execution engine enabled")
	}

	// Store transaction
	if err := d.db.StoreSwap(ctx, params, amountOut, fees); err != nil {
		return nil, fmt.Errorf("failed to store swap: %w", err)
	}

	return &SwapResult{
		AmountOut:    amountOut,
		Fees:         fees,
		PriceImpact:  route.PriceImpact,
		ExecutedPrice: new(big.Float).Quo(
			new(big.Float).SetInt(amountOut),
			new(big.Float).SetInt(params.AmountIn),
		),
		Timestamp: time.Now(),
	}, nil
}

// loadPairs loads existing pairs from database
func (d *DEX) loadPairs(ctx context.Context) error {
	pairs, err := d.db.GetAllPairs(ctx)
	if err != nil {
		return err
	}

	for _, pair := range pairs {
		pool := NewLiquidityPool(pair.TokenA, pair.TokenB, d.config)
		pool.ReserveA = pair.ReserveA
		pool.ReserveB = pair.ReserveB
		pool.TotalLiquidity = pair.TotalLiquidity
		
		pairID := generatePairID(pair.TokenA, pair.TokenB)
		d.pairs[pairID] = pool
	}

	return nil
}

// processEvents handles event processing
func (d *DEX) processEvents(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case event := <-d.eventEmitter.Events():
			// Process events (logging, notifications, etc.)
			d.handleEvent(event)
		}
	}
}

// collectMetrics collects and updates metrics
func (d *DEX) collectMetrics(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.updateMetrics()
		}
	}
}

// updateMetrics updates DEX metrics
func (d *DEX) updateMetrics() {
	d.mu.RLock()
	defer d.mu.RUnlock()

	totalTVL := big.NewInt(0)
	for _, pool := range d.pairs {
		tvl := pool.CalculateTVL()
		totalTVL.Add(totalTVL, tvl)
	}

	d.metrics.TotalValueLocked.Set(float64(totalTVL.Int64()))
	d.metrics.ActivePairs.Set(float64(len(d.pairs)))
}

// handleEvent processes individual events
func (d *DEX) handleEvent(event interface{}) {
	// Log events, send notifications, update state, etc.
	switch e := event.(type) {
	case EventSwapExecuted:
		// Handle swap event
		_ = e
	case EventLiquidityAdded:
		// Handle liquidity add event
		_ = e
	case EventLiquidityRemoved:
		// Handle liquidity remove event
		_ = e
	}
}

// Stop gracefully stops the DEX
func (d *DEX) Stop() error {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Stop price oracle
	if err := d.priceOracle.Stop(); err != nil {
		return fmt.Errorf("failed to stop price oracle: %w", err)
	}

	// Save state to database
	for pairID, pool := range d.pairs {
		if err := d.db.UpdatePair(context.Background(), pairID, pool); err != nil {
			return fmt.Errorf("failed to save pair %s: %w", pairID, err)
		}
	}

	return nil
}

// generatePairID creates a unique pair identifier
func generatePairID(tokenA, tokenB string) string {
	if tokenA < tokenB {
		return fmt.Sprintf("%s-%s", tokenA, tokenB)
	}
	return fmt.Sprintf("%s-%s", tokenB, tokenA)
}