package dex

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// TokenPair represents a trading pair for DEX functionality
type TokenPair struct {
	ID          string
	TokenA      Token
	TokenB      Token
	ReserveA    *big.Int
	ReserveB    *big.Int
	LPTokens    *big.Int
	Fee         uint64 // Fee in basis points (e.g., 30 = 0.3%)
	CreatedAt   time.Time
	UpdatedAt   time.Time
	
	// Trading statistics
	Volume24h   *big.Int
	PriceChange *big.Float
	
	// Synchronization
	mu          sync.RWMutex
}

// Token represents a token in the DEX
type Token struct {
	Address  string
	Symbol   string
	Decimals uint8
	Name     string
}

// DEX represents the decentralized exchange
type DEX struct {
	logger     *zap.Logger
	
	// Token pairs
	pairs      map[string]*TokenPair
	pairsMu    sync.RWMutex
	
	// Trading statistics
	totalPairs     atomic.Uint64
	totalVolume    atomic.Uint64
	totalTrades    atomic.Uint64
	
	// Configuration
	defaultFee     uint64
	minLiquidity   *big.Int
}

// NewDEX creates a new DEX instance
func NewDEX(logger *zap.Logger) *DEX {
	return &DEX{
		logger:       logger,
		pairs:        make(map[string]*TokenPair),
		defaultFee:   30, // 0.3% default fee
		minLiquidity: big.NewInt(1000), // Minimum liquidity requirement
	}
}

// CreateTokenPair creates a new trading pair
func (d *DEX) CreateTokenPair(tokenA, tokenB Token, initialPriceA, initialPriceB *big.Int) (*TokenPair, error) {
	d.pairsMu.Lock()
	defer d.pairsMu.Unlock()
	
	// Generate pair ID from token addresses
	pairID := d.generatePairID(tokenA.Address, tokenB.Address)
	
	// Check if pair already exists
	if _, exists := d.pairs[pairID]; exists {
		return nil, fmt.Errorf("token pair already exists: %s", pairID)
	}
	
	// Create initial liquidity pool
	pair := &TokenPair{
		ID:         pairID,
		TokenA:     tokenA,
		TokenB:     tokenB,
		ReserveA:   new(big.Int).Set(initialPriceA),
		ReserveB:   new(big.Int).Set(initialPriceB),
		LPTokens:   big.NewInt(0),
		Fee:        d.defaultFee,
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
		Volume24h:  big.NewInt(0),
		PriceChange: big.NewFloat(0),
	}
	
	// Calculate initial LP tokens (geometric mean)
	initialLP := new(big.Int).Sqrt(new(big.Int).Mul(initialPriceA, initialPriceB))
	pair.LPTokens = initialLP
	
	d.pairs[pairID] = pair
	d.totalPairs.Add(1)
	
	d.logger.Info("Created token pair",
		zap.String("pair_id", pairID),
		zap.String("token_a", tokenA.Symbol),
		zap.String("token_b", tokenB.Symbol),
		zap.String("initial_lp", initialLP.String()),
	)
	
	return pair, nil
}

// AddLiquidity adds liquidity to a token pair
func (d *DEX) AddLiquidity(pairID string, amountA, amountB *big.Int) (*big.Int, error) {
	d.pairsMu.RLock()
	pair, exists := d.pairs[pairID]
	d.pairsMu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("token pair not found: %s", pairID)
	}
	
	pair.mu.Lock()
	defer pair.mu.Unlock()
	
	// Calculate LP tokens to mint based on current reserves
	var lpTokens *big.Int
	
	if pair.LPTokens.Cmp(big.NewInt(0)) == 0 {
		// First liquidity provision
		lpTokens = new(big.Int).Sqrt(new(big.Int).Mul(amountA, amountB))
	} else {
		// Calculate proportional LP tokens
		shareA := new(big.Int).Mul(amountA, pair.LPTokens)
		shareA.Div(shareA, pair.ReserveA)
		
		shareB := new(big.Int).Mul(amountB, pair.LPTokens)
		shareB.Div(shareB, pair.ReserveB)
		
		// Use minimum to maintain price ratio
		if shareA.Cmp(shareB) < 0 {
			lpTokens = shareA
		} else {
			lpTokens = shareB
		}
	}
	
	// Update reserves
	pair.ReserveA.Add(pair.ReserveA, amountA)
	pair.ReserveB.Add(pair.ReserveB, amountB)
	pair.LPTokens.Add(pair.LPTokens, lpTokens)
	pair.UpdatedAt = time.Now()
	
	d.logger.Info("Liquidity added",
		zap.String("pair_id", pairID),
		zap.String("amount_a", amountA.String()),
		zap.String("amount_b", amountB.String()),
		zap.String("lp_tokens", lpTokens.String()),
	)
	
	return lpTokens, nil
}

// Swap performs a token swap using AMM (Automated Market Maker) model
func (d *DEX) Swap(pairID string, tokenIn string, amountIn *big.Int, minAmountOut *big.Int) (*big.Int, error) {
	d.pairsMu.RLock()
	pair, exists := d.pairs[pairID]
	d.pairsMu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("token pair not found: %s", pairID)
	}
	
	pair.mu.Lock()
	defer pair.mu.Unlock()
	
	var amountOut *big.Int
	var reserveIn, reserveOut *big.Int
	
	// Determine which token is being swapped
	if tokenIn == pair.TokenA.Address {
		reserveIn = pair.ReserveA
		reserveOut = pair.ReserveB
	} else if tokenIn == pair.TokenB.Address {
		reserveIn = pair.ReserveB
		reserveOut = pair.ReserveA
	} else {
		return nil, fmt.Errorf("invalid token address: %s", tokenIn)
	}
	
	// Calculate output amount using constant product formula (x * y = k)
	// amountOut = (amountIn * reserveOut) / (reserveIn + amountIn)
	// Apply fee (subtract fee from input amount)
	
	feeAmount := new(big.Int).Mul(amountIn, big.NewInt(int64(pair.Fee)))
	feeAmount.Div(feeAmount, big.NewInt(10000))
	
	amountInAfterFee := new(big.Int).Sub(amountIn, feeAmount)
	
	numerator := new(big.Int).Mul(amountInAfterFee, reserveOut)
	denominator := new(big.Int).Add(reserveIn, amountInAfterFee)
	amountOut = numerator.Div(numerator, denominator)
	
	// Check slippage protection
	if amountOut.Cmp(minAmountOut) < 0 {
		return nil, fmt.Errorf("insufficient output amount: got %s, expected at least %s", 
			amountOut.String(), minAmountOut.String())
	}
	
	// Update reserves
	if tokenIn == pair.TokenA.Address {
		pair.ReserveA.Add(pair.ReserveA, amountIn)
		pair.ReserveB.Sub(pair.ReserveB, amountOut)
	} else {
		pair.ReserveB.Add(pair.ReserveB, amountIn)
		pair.ReserveA.Sub(pair.ReserveA, amountOut)
	}
	
	// Update statistics
	pair.Volume24h.Add(pair.Volume24h, amountIn)
	pair.UpdatedAt = time.Now()
	d.totalTrades.Add(1)
	
	d.logger.Info("Token swap executed",
		zap.String("pair_id", pairID),
		zap.String("token_in", tokenIn),
		zap.String("amount_in", amountIn.String()),
		zap.String("amount_out", amountOut.String()),
		zap.String("fee", feeAmount.String()),
	)
	
	return amountOut, nil
}

// GetPair returns a token pair by ID
func (d *DEX) GetPair(pairID string) (*TokenPair, error) {
	d.pairsMu.RLock()
	defer d.pairsMu.RUnlock()
	
	pair, exists := d.pairs[pairID]
	if !exists {
		return nil, fmt.Errorf("token pair not found: %s", pairID)
	}
	
	return pair, nil
}

// GetPrice returns the current price of tokenA in terms of tokenB
func (d *DEX) GetPrice(pairID string) (*big.Float, error) {
	pair, err := d.GetPair(pairID)
	if err != nil {
		return nil, err
	}
	
	pair.mu.RLock()
	defer pair.mu.RUnlock()
	
	// Price = ReserveB / ReserveA
	if pair.ReserveA.Cmp(big.NewInt(0)) == 0 {
		return big.NewFloat(0), nil
	}
	
	reserveA := new(big.Float).SetInt(pair.ReserveA)
	reserveB := new(big.Float).SetInt(pair.ReserveB)
	
	return new(big.Float).Quo(reserveB, reserveA), nil
}

// generatePairID creates a deterministic pair ID from token addresses
func (d *DEX) generatePairID(tokenA, tokenB string) string {
	// Sort addresses to ensure consistent pair ID regardless of order
	var addr1, addr2 string
	if tokenA < tokenB {
		addr1, addr2 = tokenA, tokenB
	} else {
		addr1, addr2 = tokenB, tokenA
	}
	
	hash := sha256.Sum256([]byte(addr1 + addr2))
	return hex.EncodeToString(hash[:])[:16] // Use first 16 chars for readability
}

// GetStats returns DEX statistics
func (d *DEX) GetStats() map[string]interface{} {
	d.pairsMu.RLock()
	defer d.pairsMu.RUnlock()
	
	totalLiquidity := big.NewInt(0)
	activePairs := 0
	
	for _, pair := range d.pairs {
		pair.mu.RLock()
		if pair.ReserveA.Cmp(big.NewInt(0)) > 0 && pair.ReserveB.Cmp(big.NewInt(0)) > 0 {
			activePairs++
			// Simplified liquidity calculation (sum of reserves)
			totalLiquidity.Add(totalLiquidity, pair.ReserveA)
			totalLiquidity.Add(totalLiquidity, pair.ReserveB)
		}
		pair.mu.RUnlock()
	}
	
	return map[string]interface{}{
		"total_pairs":     d.totalPairs.Load(),
		"active_pairs":    activePairs,
		"total_trades":    d.totalTrades.Load(),
		"total_liquidity": totalLiquidity.String(),
	}
}