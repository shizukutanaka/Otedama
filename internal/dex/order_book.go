package dex

import (
	"container/heap"
	"fmt"
	"math/big"
	"sync"
	"time"
)

// OrderBook manages limit orders for trading pairs
type OrderBook struct {
	buyOrders  *OrderHeap
	sellOrders *OrderHeap
	orders     map[string]*Order
	mu         sync.RWMutex
	lastMatch  time.Time
}

// NewOrderBook creates a new order book
func NewOrderBook() *OrderBook {
	buyHeap := &OrderHeap{
		orders:    make([]*Order, 0),
		orderType: OrderSideBuy,
	}
	sellHeap := &OrderHeap{
		orders:    make([]*Order, 0),
		orderType: OrderSideSell,
	}
	
	heap.Init(buyHeap)
	heap.Init(sellHeap)
	
	return &OrderBook{
		buyOrders:  buyHeap,
		sellOrders: sellHeap,
		orders:     make(map[string]*Order),
		lastMatch:  time.Now(),
	}
}

// PlaceOrder places a new order in the book
func (ob *OrderBook) PlaceOrder(order *Order) error {
	ob.mu.Lock()
	defer ob.mu.Unlock()
	
	// Validate order
	if err := ob.validateOrder(order); err != nil {
		return err
	}
	
	// Check for immediate execution (market order or crossable limit order)
	if order.Type == OrderTypeMarket {
		return ob.executeMarketOrder(order)
	}
	
	// Try to match limit order
	matched := ob.matchOrder(order)
	
	// If not fully matched, add to book
	if !matched && order.Status != OrderStatusFilled {
		ob.addToBook(order)
	}
	
	return nil
}

// CancelOrder cancels an existing order
func (ob *OrderBook) CancelOrder(orderID string, userID string) error {
	ob.mu.Lock()
	defer ob.mu.Unlock()
	
	order, exists := ob.orders[orderID]
	if !exists {
		return fmt.Errorf("order not found: %s", orderID)
	}
	
	if order.User != userID {
		return fmt.Errorf("unauthorized: order belongs to different user")
	}
	
	if order.Status != OrderStatusPending && order.Status != OrderStatusPartiallyFilled {
		return fmt.Errorf("order cannot be cancelled: status %v", order.Status)
	}
	
	// Remove from order book
	ob.removeFromBook(order)
	
	// Update status
	order.Status = OrderStatusCancelled
	now := time.Now()
	order.ExecutedAt = &now
	
	return nil
}

// ExecuteOrder executes an order against the book
func (ob *OrderBook) ExecuteOrder(params SwapParams) (*SwapResult, error) {
	ob.mu.Lock()
	defer ob.mu.Unlock()
	
	// Create market order from swap params
	order := &Order{
		ID:       generateOrderID(),
		User:     params.User,
		Type:     OrderTypeMarket,
		Side:     OrderSideBuy, // Determine based on tokens
		TokenIn:  params.TokenIn,
		TokenOut: params.TokenOut,
		Amount:   params.AmountIn,
		Status:   OrderStatusPending,
		CreatedAt: time.Now(),
		ExpiresAt: params.Deadline,
	}
	
	// Execute against order book
	if err := ob.executeMarketOrder(order); err != nil {
		return nil, err
	}
	
	// Calculate result
	result := &SwapResult{
		AmountOut: order.Amount, // Amount after execution
		Fees:      big.NewInt(0), // Calculate fees
		Timestamp: time.Now(),
	}
	
	return result, nil
}

// GetBestBid returns the best bid price
func (ob *OrderBook) GetBestBid() *big.Float {
	ob.mu.RLock()
	defer ob.mu.RUnlock()
	
	if ob.buyOrders.Len() == 0 {
		return big.NewFloat(0)
	}
	
	return ob.buyOrders.Peek().Price
}

// GetBestAsk returns the best ask price
func (ob *OrderBook) GetBestAsk() *big.Float {
	ob.mu.RLock()
	defer ob.mu.RUnlock()
	
	if ob.sellOrders.Len() == 0 {
		return big.NewFloat(0)
	}
	
	return ob.sellOrders.Peek().Price
}

// GetSpread returns the bid-ask spread
func (ob *OrderBook) GetSpread() *big.Float {
	ob.mu.RLock()
	defer ob.mu.RUnlock()
	
	bestBid := ob.GetBestBid()
	bestAsk := ob.GetBestAsk()
	
	if bestBid.Sign() == 0 || bestAsk.Sign() == 0 {
		return big.NewFloat(0)
	}
	
	spread := new(big.Float).Sub(bestAsk, bestBid)
	return spread
}

// GetDepth returns the order book depth
func (ob *OrderBook) GetDepth(levels int) *OrderBookDepth {
	ob.mu.RLock()
	defer ob.mu.RUnlock()
	
	depth := &OrderBookDepth{
		Bids:      make([]PriceLevel, 0, levels),
		Asks:      make([]PriceLevel, 0, levels),
		Timestamp: time.Now(),
	}
	
	// Aggregate bid levels
	bidLevels := ob.aggregateLevels(ob.buyOrders, levels)
	depth.Bids = bidLevels
	
	// Aggregate ask levels
	askLevels := ob.aggregateLevels(ob.sellOrders, levels)
	depth.Asks = askLevels
	
	return depth
}

// validateOrder validates an order
func (ob *OrderBook) validateOrder(order *Order) error {
	if order.Amount == nil || order.Amount.Sign() <= 0 {
		return fmt.Errorf("invalid order amount")
	}
	
	if order.Type == OrderTypeLimit && (order.Price == nil || order.Price.Sign() <= 0) {
		return fmt.Errorf("limit order requires valid price")
	}
	
	if order.ExpiresAt.Before(time.Now()) {
		return fmt.Errorf("order already expired")
	}
	
	return nil
}

// executeMarketOrder executes a market order
func (ob *OrderBook) executeMarketOrder(order *Order) error {
	var targetHeap *OrderHeap
	
	if order.Side == OrderSideBuy {
		targetHeap = ob.sellOrders
	} else {
		targetHeap = ob.buyOrders
	}
	
	remainingAmount := new(big.Int).Set(order.Amount)
	
	for targetHeap.Len() > 0 && remainingAmount.Sign() > 0 {
		bestOrder := heap.Pop(targetHeap).(*Order)
		
		// Calculate match amount
		matchAmount := minBigInt(remainingAmount, bestOrder.Amount)
		
		// Update amounts
		remainingAmount.Sub(remainingAmount, matchAmount)
		bestOrder.Amount.Sub(bestOrder.Amount, matchAmount)
		
		// Update order statuses
		if bestOrder.Amount.Sign() == 0 {
			bestOrder.Status = OrderStatusFilled
			now := time.Now()
			bestOrder.ExecutedAt = &now
			delete(ob.orders, bestOrder.ID)
		} else {
			bestOrder.Status = OrderStatusPartiallyFilled
			// Put back in heap if partially filled
			heap.Push(targetHeap, bestOrder)
		}
		
		ob.lastMatch = time.Now()
	}
	
	if remainingAmount.Sign() > 0 {
		return fmt.Errorf("insufficient liquidity: %v remaining", remainingAmount)
	}
	
	order.Status = OrderStatusFilled
	now := time.Now()
	order.ExecutedAt = &now
	
	return nil
}

// matchOrder attempts to match a limit order
func (ob *OrderBook) matchOrder(order *Order) bool {
	var targetHeap *OrderHeap
	
	if order.Side == OrderSideBuy {
		targetHeap = ob.sellOrders
	} else {
		targetHeap = ob.buyOrders
	}
	
	fullyMatched := false
	remainingAmount := new(big.Int).Set(order.Amount)
	
	for targetHeap.Len() > 0 && remainingAmount.Sign() > 0 {
		bestOrder := targetHeap.Peek()
		
		// Check if prices cross
		if !ob.pricesCross(order, bestOrder) {
			break
		}
		
		// Remove from heap
		heap.Pop(targetHeap)
		
		// Calculate match amount
		matchAmount := minBigInt(remainingAmount, bestOrder.Amount)
		
		// Update amounts
		remainingAmount.Sub(remainingAmount, matchAmount)
		bestOrder.Amount.Sub(bestOrder.Amount, matchAmount)
		
		// Update order statuses
		if bestOrder.Amount.Sign() == 0 {
			bestOrder.Status = OrderStatusFilled
			now := time.Now()
			bestOrder.ExecutedAt = &now
			delete(ob.orders, bestOrder.ID)
		} else {
			bestOrder.Status = OrderStatusPartiallyFilled
			heap.Push(targetHeap, bestOrder)
		}
		
		ob.lastMatch = time.Now()
	}
	
	if remainingAmount.Sign() == 0 {
		order.Status = OrderStatusFilled
		now := time.Now()
		order.ExecutedAt = &now
		fullyMatched = true
	} else if remainingAmount.Cmp(order.Amount) < 0 {
		order.Status = OrderStatusPartiallyFilled
		order.Amount = remainingAmount
	}
	
	return fullyMatched
}

// pricesCross checks if two orders' prices cross
func (ob *OrderBook) pricesCross(order1, order2 *Order) bool {
	if order1.Side == OrderSideBuy {
		// Buy order price >= Sell order price
		return order1.Price.Cmp(order2.Price) >= 0
	} else {
		// Sell order price <= Buy order price
		return order1.Price.Cmp(order2.Price) <= 0
	}
}

// addToBook adds an order to the order book
func (ob *OrderBook) addToBook(order *Order) {
	ob.orders[order.ID] = order
	
	if order.Side == OrderSideBuy {
		heap.Push(ob.buyOrders, order)
	} else {
		heap.Push(ob.sellOrders, order)
	}
}

// removeFromBook removes an order from the order book
func (ob *OrderBook) removeFromBook(order *Order) {
	delete(ob.orders, order.ID)
	
	// Remove from heap (expensive operation)
	if order.Side == OrderSideBuy {
		ob.removeFromHeap(ob.buyOrders, order.ID)
	} else {
		ob.removeFromHeap(ob.sellOrders, order.ID)
	}
}

// removeFromHeap removes an order from a heap
func (ob *OrderBook) removeFromHeap(h *OrderHeap, orderID string) {
	for i, o := range h.orders {
		if o.ID == orderID {
			heap.Remove(h, i)
			break
		}
	}
}

// aggregateLevels aggregates orders into price levels
func (ob *OrderBook) aggregateLevels(h *OrderHeap, maxLevels int) []PriceLevel {
	levels := make([]PriceLevel, 0, maxLevels)
	levelMap := make(map[string]*PriceLevel)
	
	for _, order := range h.orders {
		priceStr := order.Price.Text('f', 8)
		
		if level, exists := levelMap[priceStr]; exists {
			level.Volume.Add(level.Volume, order.Amount)
			level.Orders++
		} else {
			level := &PriceLevel{
				Price:  new(big.Float).Set(order.Price),
				Volume: new(big.Int).Set(order.Amount),
				Orders: 1,
			}
			levelMap[priceStr] = level
			levels = append(levels, *level)
		}
		
		if len(levels) >= maxLevels {
			break
		}
	}
	
	return levels
}

// OrderHeap implements heap.Interface for orders
type OrderHeap struct {
	orders    []*Order
	orderType OrderSide
}

func (h OrderHeap) Len() int { return len(h.orders) }

func (h OrderHeap) Less(i, j int) bool {
	if h.orderType == OrderSideBuy {
		// For buy orders, higher price has priority
		return h.orders[i].Price.Cmp(h.orders[j].Price) > 0
	} else {
		// For sell orders, lower price has priority
		return h.orders[i].Price.Cmp(h.orders[j].Price) < 0
	}
}

func (h OrderHeap) Swap(i, j int) {
	h.orders[i], h.orders[j] = h.orders[j], h.orders[i]
}

func (h *OrderHeap) Push(x interface{}) {
	h.orders = append(h.orders, x.(*Order))
}

func (h *OrderHeap) Pop() interface{} {
	old := h.orders
	n := len(old)
	order := old[n-1]
	h.orders = old[0 : n-1]
	return order
}

func (h *OrderHeap) Peek() *Order {
	if len(h.orders) == 0 {
		return nil
	}
	return h.orders[0]
}

// OrderBookDepth represents the order book depth
type OrderBookDepth struct {
	Bids      []PriceLevel
	Asks      []PriceLevel
	Timestamp time.Time
}

// PriceLevel represents a price level in the order book
type PriceLevel struct {
	Price  *big.Float
	Volume *big.Int
	Orders int
}

// Helper functions

func generateOrderID() string {
	return fmt.Sprintf("order_%d", time.Now().UnixNano())
}

func minBigInt(a, b *big.Int) *big.Int {
	if a.Cmp(b) < 0 {
		return new(big.Int).Set(a)
	}
	return new(big.Int).Set(b)
}