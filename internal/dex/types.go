package dex

import (
	"math/big"
	"time"
)

// SwapParams represents parameters for a swap
type SwapParams struct {
	User         string
	TokenIn      string
	TokenOut     string
	AmountIn     *big.Int
	MinAmountOut *big.Int
	Deadline     time.Time
	Slippage     float64
}

// Validate validates swap parameters
func (p *SwapParams) Validate() error {
	if p.User == "" {
		return ErrInvalidUser
	}
	if p.TokenIn == "" || p.TokenOut == "" {
		return ErrInvalidToken
	}
	if p.TokenIn == p.TokenOut {
		return ErrSameToken
	}
	if p.AmountIn == nil || p.AmountIn.Sign() <= 0 {
		return ErrInvalidAmount
	}
	if p.Deadline.Before(time.Now()) {
		return ErrExpiredDeadline
	}
	if p.Slippage < 0 || p.Slippage > 1 {
		return ErrInvalidSlippage
	}
	return nil
}

// SwapResult represents the result of a swap
type SwapResult struct {
	AmountOut     *big.Int
	Fees          *big.Int
	PriceImpact   float64
	ExecutedPrice *big.Float
	Route         []string
	Timestamp     time.Time
}

// LiquidityParams represents parameters for adding liquidity
type LiquidityParams struct {
	User     string
	TokenA   string
	TokenB   string
	AmountA  *big.Int
	AmountB  *big.Int
	Deadline time.Time
}

// LiquidityResult represents the result of adding liquidity
type LiquidityResult struct {
	LPTokens    *big.Int
	ShareOfPool float64
	TokenAAdded *big.Int
	TokenBAdded *big.Int
	Timestamp   time.Time
}

// RemoveLiquidityParams represents parameters for removing liquidity
type RemoveLiquidityParams struct {
	User     string
	TokenA   string
	TokenB   string
	LPTokens *big.Int
	MinA     *big.Int
	MinB     *big.Int
	Deadline time.Time
}

// RemoveLiquidityResult represents the result of removing liquidity
type RemoveLiquidityResult struct {
	AmountA   *big.Int
	AmountB   *big.Int
	Timestamp time.Time
}

// PairInfo represents information about a trading pair
type PairInfo struct {
	PairID         string
	TokenA         string
	TokenB         string
	ReserveA       *big.Int
	ReserveB       *big.Int
	TotalLiquidity *big.Int
	Price          *big.Float
	Volume24h      *big.Int
	TVL            *big.Int
	APY            float64
}

// OrderType represents the type of order
type OrderType int

const (
	OrderTypeMarket OrderType = iota
	OrderTypeLimit
	OrderTypeStopLoss
	OrderTypeTakeProfit
)

// Order represents a trading order
type Order struct {
	ID          string
	User        string
	Type        OrderType
	Side        OrderSide
	TokenIn     string
	TokenOut    string
	Amount      *big.Int
	Price       *big.Float
	StopPrice   *big.Float
	Status      OrderStatus
	CreatedAt   time.Time
	ExecutedAt  *time.Time
	ExpiresAt   time.Time
}

// OrderSide represents buy or sell
type OrderSide int

const (
	OrderSideBuy OrderSide = iota
	OrderSideSell
)

// OrderStatus represents the status of an order
type OrderStatus int

const (
	OrderStatusPending OrderStatus = iota
	OrderStatusPartiallyFilled
	OrderStatusFilled
	OrderStatusCancelled
	OrderStatusExpired
	OrderStatusFailed
)

// SwapRoute represents a swap route through multiple pools
type SwapRoute struct {
	Path         []string
	Pools        []string
	EstimatedOut *big.Int
	PriceImpact  float64
	Fees         *big.Int
}

// DEXMetrics represents DEX performance metrics
type DEXMetrics struct {
	TotalValueLocked   Gauge
	VolumeTraded       Counter
	SwapsExecuted      Counter
	LiquidityAdded     Counter
	LiquidityRemoved   Counter
	PairsCreated       Counter
	ActivePairs        Gauge
	UniqueUsers        Gauge
	AverageSlippage    Gauge
	AveragePriceImpact Gauge
}

// NewDEXMetrics creates new DEX metrics
func NewDEXMetrics() *DEXMetrics {
	return &DEXMetrics{
		TotalValueLocked:   NewGauge("dex_tvl"),
		VolumeTraded:       NewCounter("dex_volume"),
		SwapsExecuted:      NewCounter("dex_swaps"),
		LiquidityAdded:     NewCounter("dex_liquidity_added"),
		LiquidityRemoved:   NewCounter("dex_liquidity_removed"),
		PairsCreated:       NewCounter("dex_pairs_created"),
		ActivePairs:        NewGauge("dex_active_pairs"),
		UniqueUsers:        NewGauge("dex_unique_users"),
		AverageSlippage:    NewGauge("dex_avg_slippage"),
		AveragePriceImpact: NewGauge("dex_avg_price_impact"),
	}
}

// Events

// EventSwapExecuted is emitted when a swap is executed
type EventSwapExecuted struct {
	User      string
	TokenIn   string
	TokenOut  string
	AmountIn  *big.Int
	AmountOut *big.Int
	Fees      *big.Int
	Timestamp time.Time
}

// EventLiquidityAdded is emitted when liquidity is added
type EventLiquidityAdded struct {
	User     string
	PairID   string
	AmountA  *big.Int
	AmountB  *big.Int
	LPTokens *big.Int
	Timestamp time.Time
}

// EventLiquidityRemoved is emitted when liquidity is removed
type EventLiquidityRemoved struct {
	User     string
	PairID   string
	LPTokens *big.Int
	AmountA  *big.Int
	AmountB  *big.Int
	Timestamp time.Time
}

// EventPairCreated is emitted when a new pair is created
type EventPairCreated struct {
	PairID    string
	TokenA    string
	TokenB    string
	Creator   string
	Liquidity *big.Int
	Timestamp time.Time
}

// EventOrderPlaced is emitted when an order is placed
type EventOrderPlaced struct {
	OrderID   string
	User      string
	Type      OrderType
	Side      OrderSide
	Amount    *big.Int
	Price     *big.Float
	Timestamp time.Time
}

// EventOrderExecuted is emitted when an order is executed
type EventOrderExecuted struct {
	OrderID      string
	User         string
	AmountFilled *big.Int
	Price        *big.Float
	Timestamp    time.Time
}

// EventOrderCancelled is emitted when an order is cancelled
type EventOrderCancelled struct {
	OrderID   string
	User      string
	Reason    string
	Timestamp time.Time
}