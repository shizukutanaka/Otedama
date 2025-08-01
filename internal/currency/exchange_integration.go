package currency

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
)

// ExchangeIntegration provides cryptocurrency exchange integration
// Following Robert C. Martin's principle: "The only way to make the deadline—the only way to go fast—is to keep the code as clean as possible at all times."
type ExchangeIntegration struct {
	logger *zap.Logger
	
	// Exchange connections
	exchanges      map[string]Exchange
	exchangesMu    sync.RWMutex
	
	// Balance tracking
	balances       map[string]map[string]*Balance // exchange -> currency -> balance
	balancesMu     sync.RWMutex
	
	// Order management
	orders         map[string]*Order
	ordersMu       sync.RWMutex
	
	// Trade history
	trades         []*Trade
	tradesMu       sync.RWMutex
	
	// Configuration
	config         ExchangeConfig
	
	// Metrics
	metrics        struct {
		ordersPlaced      uint64
		ordersFilled      uint64
		ordersCancelled   uint64
		tradesExecuted    uint64
		totalVolume       float64
		totalFees         float64
		exchangeErrors    uint64
	}
}

// ExchangeConfig configures exchange integration
type ExchangeConfig struct {
	// API credentials (encrypted)
	Credentials    map[string]ExchangeCredentials
	
	// Trading settings
	DefaultFeeRate float64
	MaxOrderSize   float64
	MinOrderSize   float64
	
	// Safety settings
	EnableTrading  bool
	DryRun         bool
	
	// Auto-conversion
	AutoConvert    bool
	TargetCurrency string
	ConvertThreshold float64
}

// ExchangeCredentials stores API credentials
type ExchangeCredentials struct {
	APIKey        string
	APISecret     string
	Passphrase    string // Some exchanges require this
	TestMode      bool
}

// Exchange interface for different exchanges
type Exchange interface {
	Name() string
	Connect(credentials ExchangeCredentials) error
	Disconnect() error
	
	// Market data
	GetTicker(symbol string) (*Ticker, error)
	GetOrderBook(symbol string, depth int) (*OrderBook, error)
	GetTrades(symbol string, limit int) ([]*Trade, error)
	
	// Account
	GetBalances() (map[string]*Balance, error)
	GetDepositAddress(currency string) (string, error)
	
	// Trading
	PlaceOrder(order *OrderRequest) (*Order, error)
	CancelOrder(orderID string) error
	GetOrder(orderID string) (*Order, error)
	GetOpenOrders(symbol string) ([]*Order, error)
	GetOrderHistory(symbol string, limit int) ([]*Order, error)
	
	// Transfers
	Withdraw(currency string, amount float64, address string) (*Withdrawal, error)
	GetWithdrawalHistory(currency string, limit int) ([]*Withdrawal, error)
}

// Balance represents account balance
type Balance struct {
	Currency  string
	Available float64
	Locked    float64
	Total     float64
}

// Ticker represents market ticker data
type Ticker struct {
	Symbol    string
	Last      float64
	Bid       float64
	Ask       float64
	Volume24h float64
	High24h   float64
	Low24h    float64
	Timestamp time.Time
}

// OrderBook represents order book data
type OrderBook struct {
	Symbol    string
	Bids      []PriceLevel
	Asks      []PriceLevel
	Timestamp time.Time
}

// PriceLevel represents a price level in order book
type PriceLevel struct {
	Price  float64
	Amount float64
}

// OrderRequest represents a new order request
type OrderRequest struct {
	Symbol    string
	Side      string // "buy" or "sell"
	Type      string // "market", "limit", "stop"
	Price     float64
	Amount    float64
	StopPrice float64
	TimeInForce string // "GTC", "IOC", "FOK"
}

// Order represents an exchange order
type Order struct {
	ID            string
	Symbol        string
	Side          string
	Type          string
	Status        string // "new", "partially_filled", "filled", "cancelled"
	Price         float64
	Amount        float64
	Filled        float64
	Remaining     float64
	Fee           float64
	FeeCurrency   string
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// Trade represents a completed trade
type Trade struct {
	ID          string
	OrderID     string
	Symbol      string
	Side        string
	Price       float64
	Amount      float64
	Fee         float64
	FeeCurrency string
	Timestamp   time.Time
}

// Withdrawal represents a withdrawal transaction
type Withdrawal struct {
	ID        string
	Currency  string
	Amount    float64
	Fee       float64
	Address   string
	TxID      string
	Status    string
	Timestamp time.Time
}

// NewExchangeIntegration creates a new exchange integration
func NewExchangeIntegration(logger *zap.Logger, config ExchangeConfig) (*ExchangeIntegration, error) {
	ei := &ExchangeIntegration{
		logger:    logger,
		exchanges: make(map[string]Exchange),
		balances:  make(map[string]map[string]*Balance),
		orders:    make(map[string]*Order),
		trades:    make([]*Trade, 0),
		config:    config,
	}
	
	// Initialize exchanges
	for exchangeName, creds := range config.Credentials {
		exchange, err := ei.createExchange(exchangeName)
		if err != nil {
			logger.Warn("Failed to create exchange",
				zap.String("exchange", exchangeName),
				zap.Error(err))
			continue
		}
		
		if err := exchange.Connect(creds); err != nil {
			logger.Warn("Failed to connect to exchange",
				zap.String("exchange", exchangeName),
				zap.Error(err))
			continue
		}
		
		ei.exchanges[exchangeName] = exchange
	}
	
	if len(ei.exchanges) == 0 {
		return nil, errors.New("no exchanges connected")
	}
	
	// Load initial balances
	ei.refreshBalances()
	
	logger.Info("Initialized exchange integration",
		zap.Int("exchanges", len(ei.exchanges)),
		zap.Bool("trading_enabled", config.EnableTrading),
		zap.Bool("dry_run", config.DryRun))
	
	return ei, nil
}

// GetBalance returns balance for a currency on an exchange
func (ei *ExchangeIntegration) GetBalance(exchange, currency string) (*Balance, error) {
	ei.balancesMu.RLock()
	defer ei.balancesMu.RUnlock()
	
	if exchangeBalances, exists := ei.balances[exchange]; exists {
		if balance, exists := exchangeBalances[currency]; exists {
			return balance, nil
		}
	}
	
	return nil, errors.New("balance not found")
}

// GetTotalBalance returns total balance across all exchanges
func (ei *ExchangeIntegration) GetTotalBalance(currency string) float64 {
	ei.balancesMu.RLock()
	defer ei.balancesMu.RUnlock()
	
	total := 0.0
	for _, exchangeBalances := range ei.balances {
		if balance, exists := exchangeBalances[currency]; exists {
			total += balance.Available
		}
	}
	
	return total
}

// ConvertCurrency converts currency on an exchange
func (ei *ExchangeIntegration) ConvertCurrency(exchange, fromCurrency, toCurrency string, amount float64) (*Order, error) {
	if !ei.config.EnableTrading {
		return nil, errors.New("trading not enabled")
	}
	
	ei.exchangesMu.RLock()
	exch, exists := ei.exchanges[exchange]
	ei.exchangesMu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("exchange %s not found", exchange)
	}
	
	// Determine trading pair and side
	symbol, side := ei.determineTradingPair(fromCurrency, toCurrency)
	
	// Get current market price
	ticker, err := exch.GetTicker(symbol)
	if err != nil {
		return nil, fmt.Errorf("failed to get ticker: %w", err)
	}
	
	// Calculate order details
	var orderAmount float64
	var orderPrice float64
	
	if side == "sell" {
		orderAmount = amount
		orderPrice = ticker.Bid * 0.999 // Slightly below bid for better fill
	} else {
		orderAmount = amount / ticker.Ask
		orderPrice = ticker.Ask * 1.001 // Slightly above ask for better fill
	}
	
	// Create order request
	orderReq := &OrderRequest{
		Symbol:      symbol,
		Side:        side,
		Type:        "limit",
		Price:       orderPrice,
		Amount:      orderAmount,
		TimeInForce: "GTC",
	}
	
	// Place order
	if ei.config.DryRun {
		// Simulate order
		return &Order{
			ID:        fmt.Sprintf("dry-%d", time.Now().UnixNano()),
			Symbol:    symbol,
			Side:      side,
			Type:      "limit",
			Status:    "filled",
			Price:     orderPrice,
			Amount:    orderAmount,
			Filled:    orderAmount,
			Remaining: 0,
			Fee:       orderAmount * orderPrice * ei.config.DefaultFeeRate,
			CreatedAt: time.Now(),
		}, nil
	}
	
	order, err := exch.PlaceOrder(orderReq)
	if err != nil {
		ei.metrics.exchangeErrors++
		return nil, fmt.Errorf("failed to place order: %w", err)
	}
	
	// Track order
	ei.ordersMu.Lock()
	ei.orders[order.ID] = order
	ei.ordersMu.Unlock()
	
	ei.metrics.ordersPlaced++
	
	ei.logger.Info("Placed conversion order",
		zap.String("exchange", exchange),
		zap.String("from", fromCurrency),
		zap.String("to", toCurrency),
		zap.Float64("amount", amount),
		zap.String("order_id", order.ID))
	
	return order, nil
}

// AutoConvert automatically converts mined currencies to target currency
func (ei *ExchangeIntegration) AutoConvert() error {
	if !ei.config.AutoConvert || !ei.config.EnableTrading {
		return nil
	}
	
	ei.logger.Debug("Running auto-conversion check")
	
	// Refresh balances
	ei.refreshBalances()
	
	// Check each exchange
	for exchangeName, exchange := range ei.exchanges {
		ei.balancesMu.RLock()
		balances := ei.balances[exchangeName]
		ei.balancesMu.RUnlock()
		
		for currency, balance := range balances {
			// Skip target currency
			if currency == ei.config.TargetCurrency {
				continue
			}
			
			// Check if balance exceeds threshold
			if balance.Available < ei.config.ConvertThreshold {
				continue
			}
			
			// Convert to target currency
			order, err := ei.ConvertCurrency(exchangeName, currency, ei.config.TargetCurrency, balance.Available)
			if err != nil {
				ei.logger.Error("Auto-conversion failed",
					zap.String("exchange", exchangeName),
					zap.String("currency", currency),
					zap.Float64("amount", balance.Available),
					zap.Error(err))
				continue
			}
			
			ei.logger.Info("Auto-conversion executed",
				zap.String("exchange", exchangeName),
				zap.String("from", currency),
				zap.String("to", ei.config.TargetCurrency),
				zap.Float64("amount", balance.Available),
				zap.String("order_id", order.ID))
		}
	}
	
	return nil
}

// WithdrawToWallet withdraws funds to external wallet
func (ei *ExchangeIntegration) WithdrawToWallet(exchange, currency string, amount float64, address string) (*Withdrawal, error) {
	if !ei.config.EnableTrading {
		return nil, errors.New("trading not enabled")
	}
	
	ei.exchangesMu.RLock()
	exch, exists := ei.exchanges[exchange]
	ei.exchangesMu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("exchange %s not found", exchange)
	}
	
	// Check balance
	balance, err := ei.GetBalance(exchange, currency)
	if err != nil {
		return nil, err
	}
	
	if balance.Available < amount {
		return nil, fmt.Errorf("insufficient balance: %f < %f", balance.Available, amount)
	}
	
	// Execute withdrawal
	if ei.config.DryRun {
		return &Withdrawal{
			ID:        fmt.Sprintf("dry-wd-%d", time.Now().UnixNano()),
			Currency:  currency,
			Amount:    amount,
			Address:   address,
			Status:    "completed",
			Timestamp: time.Now(),
		}, nil
	}
	
	withdrawal, err := exch.Withdraw(currency, amount, address)
	if err != nil {
		ei.metrics.exchangeErrors++
		return nil, fmt.Errorf("withdrawal failed: %w", err)
	}
	
	ei.logger.Info("Withdrawal initiated",
		zap.String("exchange", exchange),
		zap.String("currency", currency),
		zap.Float64("amount", amount),
		zap.String("address", address),
		zap.String("withdrawal_id", withdrawal.ID))
	
	return withdrawal, nil
}

// Implementation methods

func (ei *ExchangeIntegration) createExchange(name string) (Exchange, error) {
	switch strings.ToLower(name) {
	case "binance":
		return NewBinanceExchange(ei.logger), nil
	case "coinbase":
		return NewCoinbaseExchange(ei.logger), nil
	case "kraken":
		return NewKrakenExchange(ei.logger), nil
	default:
		return nil, fmt.Errorf("unsupported exchange: %s", name)
	}
}

func (ei *ExchangeIntegration) refreshBalances() {
	for exchangeName, exchange := range ei.exchanges {
		balances, err := exchange.GetBalances()
		if err != nil {
			ei.logger.Error("Failed to get balances",
				zap.String("exchange", exchangeName),
				zap.Error(err))
			continue
		}
		
		ei.balancesMu.Lock()
		ei.balances[exchangeName] = balances
		ei.balancesMu.Unlock()
	}
}

func (ei *ExchangeIntegration) determineTradingPair(from, to string) (string, string) {
	// Common base pairs
	basePairs := []string{"USDT", "BTC", "ETH", "BNB"}
	
	// Direct pair
	for _, base := range basePairs {
		if to == base {
			return from + to, "sell"
		}
		if from == base {
			return to + from, "buy"
		}
	}
	
	// Default to USDT pair
	if from != "USDT" {
		return from + "USDT", "sell"
	}
	
	return to + "USDT", "buy"
}

// GetMetrics returns exchange integration metrics
func (ei *ExchangeIntegration) GetMetrics() map[string]interface{} {
	ei.exchangesMu.RLock()
	exchangeCount := len(ei.exchanges)
	ei.exchangesMu.RUnlock()
	
	ei.ordersMu.RLock()
	activeOrders := 0
	for _, order := range ei.orders {
		if order.Status == "new" || order.Status == "partially_filled" {
			activeOrders++
		}
	}
	ei.ordersMu.RUnlock()
	
	return map[string]interface{}{
		"exchanges_connected": exchangeCount,
		"orders_placed":       ei.metrics.ordersPlaced,
		"orders_filled":       ei.metrics.ordersFilled,
		"orders_cancelled":    ei.metrics.ordersCancelled,
		"orders_active":       activeOrders,
		"trades_executed":     ei.metrics.tradesExecuted,
		"total_volume":        ei.metrics.totalVolume,
		"total_fees":          ei.metrics.totalFees,
		"exchange_errors":     ei.metrics.exchangeErrors,
		"trading_enabled":     ei.config.EnableTrading,
		"auto_convert":        ei.config.AutoConvert,
	}
}

// Exchange implementations (simplified)

// BinanceExchange implements Binance exchange
type BinanceExchange struct {
	logger      *zap.Logger
	apiKey      string
	apiSecret   string
	client      *http.Client
	baseURL     string
}

func NewBinanceExchange(logger *zap.Logger) *BinanceExchange {
	return &BinanceExchange{
		logger:  logger,
		client:  &http.Client{Timeout: 10 * time.Second},
		baseURL: "https://api.binance.com",
	}
}

func (be *BinanceExchange) Name() string {
	return "Binance"
}

func (be *BinanceExchange) Connect(credentials ExchangeCredentials) error {
	be.apiKey = credentials.APIKey
	be.apiSecret = credentials.APISecret
	
	if credentials.TestMode {
		be.baseURL = "https://testnet.binance.vision"
	}
	
	// Test connection
	_, err := be.GetBalances()
	return err
}

func (be *BinanceExchange) Disconnect() error {
	return nil
}

func (be *BinanceExchange) GetTicker(symbol string) (*Ticker, error) {
	resp, err := be.client.Get(be.baseURL + "/api/v3/ticker/24hr?symbol=" + symbol)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	var data struct {
		Symbol    string `json:"symbol"`
		LastPrice string `json:"lastPrice"`
		BidPrice  string `json:"bidPrice"`
		AskPrice  string `json:"askPrice"`
		Volume    string `json:"volume"`
		HighPrice string `json:"highPrice"`
		LowPrice  string `json:"lowPrice"`
	}
	
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, err
	}
	
	ticker := &Ticker{
		Symbol:    data.Symbol,
		Timestamp: time.Now(),
	}
	
	ticker.Last, _ = strconv.ParseFloat(data.LastPrice, 64)
	ticker.Bid, _ = strconv.ParseFloat(data.BidPrice, 64)
	ticker.Ask, _ = strconv.ParseFloat(data.AskPrice, 64)
	ticker.Volume24h, _ = strconv.ParseFloat(data.Volume, 64)
	ticker.High24h, _ = strconv.ParseFloat(data.HighPrice, 64)
	ticker.Low24h, _ = strconv.ParseFloat(data.LowPrice, 64)
	
	return ticker, nil
}

func (be *BinanceExchange) GetOrderBook(symbol string, depth int) (*OrderBook, error) {
	url := fmt.Sprintf("%s/api/v3/depth?symbol=%s&limit=%d", be.baseURL, symbol, depth)
	
	resp, err := be.client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	var data struct {
		Bids [][]json.Number `json:"bids"`
		Asks [][]json.Number `json:"asks"`
	}
	
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, err
	}
	
	orderBook := &OrderBook{
		Symbol:    symbol,
		Timestamp: time.Now(),
	}
	
	// Parse bids
	for _, bid := range data.Bids {
		if len(bid) >= 2 {
			price, _ := bid[0].Float64()
			amount, _ := bid[1].Float64()
			orderBook.Bids = append(orderBook.Bids, PriceLevel{
				Price:  price,
				Amount: amount,
			})
		}
	}
	
	// Parse asks
	for _, ask := range data.Asks {
		if len(ask) >= 2 {
			price, _ := ask[0].Float64()
			amount, _ := ask[1].Float64()
			orderBook.Asks = append(orderBook.Asks, PriceLevel{
				Price:  price,
				Amount: amount,
			})
		}
	}
	
	return orderBook, nil
}

func (be *BinanceExchange) GetTrades(symbol string, limit int) ([]*Trade, error) {
	// Implementation would fetch recent trades
	return []*Trade{}, nil
}

func (be *BinanceExchange) GetBalances() (map[string]*Balance, error) {
	// Create signed request
	timestamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
	query := "timestamp=" + timestamp
	signature := be.sign(query)
	
	req, err := http.NewRequest("GET", be.baseURL+"/api/v3/account?"+query+"&signature="+signature, nil)
	if err != nil {
		return nil, err
	}
	
	req.Header.Set("X-MBX-APIKEY", be.apiKey)
	
	resp, err := be.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error: %d", resp.StatusCode)
	}
	
	var data struct {
		Balances []struct {
			Asset  string `json:"asset"`
			Free   string `json:"free"`
			Locked string `json:"locked"`
		} `json:"balances"`
	}
	
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, err
	}
	
	balances := make(map[string]*Balance)
	
	for _, b := range data.Balances {
		free, _ := strconv.ParseFloat(b.Free, 64)
		locked, _ := strconv.ParseFloat(b.Locked, 64)
		
		if free > 0 || locked > 0 {
			balances[b.Asset] = &Balance{
				Currency:  b.Asset,
				Available: free,
				Locked:    locked,
				Total:     free + locked,
			}
		}
	}
	
	return balances, nil
}

func (be *BinanceExchange) GetDepositAddress(currency string) (string, error) {
	// Implementation would get deposit address
	return "", errors.New("not implemented")
}

func (be *BinanceExchange) PlaceOrder(order *OrderRequest) (*Order, error) {
	// Implementation would place order via API
	return &Order{
		ID:        fmt.Sprintf("binance-%d", time.Now().UnixNano()),
		Symbol:    order.Symbol,
		Side:      order.Side,
		Type:      order.Type,
		Status:    "new",
		Price:     order.Price,
		Amount:    order.Amount,
		Remaining: order.Amount,
		CreatedAt: time.Now(),
	}, nil
}

func (be *BinanceExchange) CancelOrder(orderID string) error {
	// Implementation would cancel order
	return nil
}

func (be *BinanceExchange) GetOrder(orderID string) (*Order, error) {
	// Implementation would get order status
	return nil, errors.New("not implemented")
}

func (be *BinanceExchange) GetOpenOrders(symbol string) ([]*Order, error) {
	// Implementation would get open orders
	return []*Order{}, nil
}

func (be *BinanceExchange) GetOrderHistory(symbol string, limit int) ([]*Order, error) {
	// Implementation would get order history
	return []*Order{}, nil
}

func (be *BinanceExchange) Withdraw(currency string, amount float64, address string) (*Withdrawal, error) {
	// Implementation would initiate withdrawal
	return &Withdrawal{
		ID:        fmt.Sprintf("wd-%d", time.Now().UnixNano()),
		Currency:  currency,
		Amount:    amount,
		Address:   address,
		Status:    "pending",
		Timestamp: time.Now(),
	}, nil
}

func (be *BinanceExchange) GetWithdrawalHistory(currency string, limit int) ([]*Withdrawal, error) {
	// Implementation would get withdrawal history
	return []*Withdrawal{}, nil
}

func (be *BinanceExchange) sign(payload string) string {
	h := hmac.New(sha256.New, []byte(be.apiSecret))
	h.Write([]byte(payload))
	return hex.EncodeToString(h.Sum(nil))
}

// CoinbaseExchange implements Coinbase exchange
type CoinbaseExchange struct {
	logger *zap.Logger
	client *http.Client
}

func NewCoinbaseExchange(logger *zap.Logger) *CoinbaseExchange {
	return &CoinbaseExchange{
		logger: logger,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

func (ce *CoinbaseExchange) Name() string {
	return "Coinbase"
}

// Implement Exchange interface methods...
// (Similar structure to BinanceExchange)

// KrakenExchange implements Kraken exchange
type KrakenExchange struct {
	logger *zap.Logger
	client *http.Client
}

func NewKrakenExchange(logger *zap.Logger) *KrakenExchange {
	return &KrakenExchange{
		logger: logger,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

func (ke *KrakenExchange) Name() string {
	return "Kraken"
}

// Implement Exchange interface methods...
// (Similar structure to BinanceExchange)